// 對外系統資料輸出：報告模板的自動表格段落（source_kind = 'text'）。
// 每個段落回 { state, text, tables: [{ title, sheet, columns, rows, xlsxHead?, maskCols? }] }，
// 匯出 XLSX 時每張表各一個工作表（sheet＝官方表單名稱）；xlsxHead 是逐格照抄的官方表頭。
// 只讀資料集的採用值（approved_facts）與標的台帳；缺漏一律寫明，不以 0 代替。
//
// 依據：
//  - 環境部「事業溫室氣體排放量資訊平台」盤查系統用匯入表單 V5（seed/moenv-import.js）
//  - 經濟部「能源查核制度申報表」附表三（非生產性質行業）
//  - 經濟部能源署「政府機關及學校節約能源填報網站」：各年度用量＝各帳單月份登載用量總和
//  - 國健署「醫院節能減碳網路填報系統」：全年總消耗量
import { q } from './db.js';
import { orgById } from './authz.js';
import { j, round, convert } from './util.js';
import { makeContext, compute, DEFAULT_FUEL, FUEL_ACTIVITY, FUEL_UNIT, gasClass } from './calc.js';
import { factorAt, getConfig } from './config-store.js';
import { getProfile, PROFILE_FIELDS } from './profile.js';
import { ASSET_TYPES } from './seed/dictionary.js';
import { MOENV_SHEETS, MOENV_EQUIP, MOENV_EQUIP_OTHER, MOENV_FUEL, MOENV_REFRIGERANT } from './seed/moenv-import.js';
import { MONTREAL, REFRIGERANT_ALIASES } from './seed/factors.js';
import { savingRateTable, listMeasures } from './measures.js';

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const BAD = ['missing', 'unknown', 'not_applicable', 'pending_period_end'];
const r2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : round(v, d));
const roc = (y) => y - 1911;
const sum = (a) => { const xs = a.filter((x) => x !== null && x !== undefined); return xs.length ? xs.reduce((s, x) => s + x, 0) : null; };
const avg = (a) => { const xs = a.filter((x) => x !== null && x !== undefined); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; };
const cell = (v) => (v === null || v === undefined ? '' : v);

// 帳單月份：計費期間迄日（含）所在月份；點狀資料（存量、讀值）取量測日
function billMonth(f) {
  const end = new Date(`${f.period_end}T00:00:00Z`);
  if (f.period_end > f.period_start) end.setUTCDate(end.getUTCDate() - 1);
  return { y: end.getUTCFullYear(), m: end.getUTCMonth() + 1 };
}
function val(f, unit) { if (BAD.includes(f.value_state) || f.value === null || f.value === undefined) return null; const c = convert(f.value, f.unit, unit); return c.ok ? c.value : f.value; }

// 某些採用值 → 12 個月（帳單月份）。同月多筆加總；agg='max' 取最大；agg='last' 取最後一筆
function monthly(facts, year, unit, agg = 'sum') {
  const out = MONTHS.map(() => null); const notes = [];
  for (const f of facts) {
    const { y, m } = billMonth(f); if (y !== year) continue;
    if (BAD.includes(f.value_state)) { if (f.value_state !== 'not_applicable') notes.push(`${m} 月${f.asset_name ? ` ${f.asset_name}` : ''}缺漏`); continue; }
    const v = val(f, unit); if (v === null) continue;
    const i = m - 1;
    out[i] = out[i] === null ? v : agg === 'max' ? Math.max(out[i], v) : agg === 'last' ? v : out[i] + v;
  }
  return { values: out, notes };
}

function prevDataset(orgId, year) {
  return q.get(`SELECT * FROM datasets WHERE org_id = ? AND year = ? ORDER BY CASE status WHEN 'locked' THEN 0 WHEN 'superseded' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, version DESC LIMIT 1`, orgId, year);
}

function profileValue(profile, key) {
  if (profile[key]) return profile[key];
  const f = Object.values(PROFILE_FIELDS).find((x) => x.key === key);
  return f?.default || '';
}

function loader(datasetId, orgId) {
  const cx = datasetId ? makeContext(datasetId) : { facts: [], assets: q.all("SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.status <> 'archived'", orgId).map((a) => ({ ...a, attrs: j(a.attrs, {}) })), ds: null };
  const assets = cx.assets.filter((a) => a.status !== 'archived');
  const byId = new Map(assets.map((a) => [a.id, a]));
  const facts = cx.facts.map((f) => ({ ...f, asset: byId.get(f.asset_id) }));
  return { cx, assets, byId, facts };
}

// 列管電號：外購電力項目下、適用的電號
const accountsOf = (L) => L.assets.filter((a) => a.item_code === 'ELE-GRID' && a.applicability !== 'not_applicable');
const accountLabel = (a) => a.external_key || a.name;
const metricFacts = (L, assetId, metric) => L.facts.filter((f) => f.asset_id === assetId && f.metric_code === metric);
// 標的的上層電號（沿 parent_asset_id 往上找）
function accountOf(L, a) {
  let cur = a; const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); if (cur.item_code === 'ELE-GRID') return cur; cur = cur.parent_asset_id ? L.byId.get(cur.parent_asset_id) : null; }
  return null;
}
function latestFact(facts, unit) {
  const ok = facts.filter((f) => !BAD.includes(f.value_state)).sort((a, b) => (a.period_end < b.period_end ? 1 : -1));
  return ok.length ? val(ok[0], unit) : null;
}
// 組織層級指標（院所營運活動標的），只有一個列管電號時才可直接當該電號的供電範圍值
function orgMetric(L, metric, unit) { return latestFact(L.facts.filter((f) => f.metric_code === metric), unit); }

const T = (title, sheet, columns, rows, o = {}) => ({ title, sheet, columns, rows, ...o });

// ── 系統別（能源查核表六、表九）──
export const SYSTEMS = ['空調', '照明', '冷凍冷藏', '事務設備', '送排風', '給水污水', '電梯', '鍋爐', '熱泵', '壓縮空氣', '醫療設備', '資訊機房', '其他'];
const TYPE_SYSTEM = { chiller: '空調', cooling_tower: '空調', pump: '空調', ahu: '空調', split_ac: '空調', window_ac: '空調', fan: '送排風', lighting: '照明', elevator: '電梯',
  heat_pump: '熱泵', air_compressor: '壓縮空氣', refrigeration: '冷凍冷藏', refrigerator: '冷凍冷藏', office_equipment: '事務設備', water_dispenser: '事務設備', data_room: '資訊機房', boiler: '鍋爐' };
const systemOf = (a) => a.attrs.system || TYPE_SYSTEM[a.asset_type] || '其他';
// 設備年用電：表計＞推估採用值＞額定功率 × 年運轉時數 × 負載率（屬性推估）
function equipKwh(L, a, year) {
  const metered = sum(L.facts.filter((f) => f.asset_id === a.id && f.metric_code === 'elec_metered_kwh' && billMonth(f).y === year).map((f) => val(f, 'kWh')));
  if (metered !== null) return { kwh: metered, how: '表計' };
  const est = sum(L.facts.filter((f) => f.asset_id === a.id && f.metric_code === 'equip_estimated_kwh' && billMonth(f).y === year).map((f) => val(f, 'kWh')));
  if (est !== null) return { kwh: est, how: '推估（採用值）' };
  const kw = Number(a.attrs.ratedKw); const hrs = Number(a.attrs.hoursPerYear); const qty = Number(a.attrs.qty) || 1; const lf = a.attrs.loadPct ? Number(a.attrs.loadPct) / 100 : 1;
  if (kw > 0 && hrs > 0) return { kwh: kw * hrs * qty * lf, how: `推估（${kw} kW × ${hrs} h${qty > 1 ? ` × ${qty} 台` : ''}${lf !== 1 ? ` × 負載率 ${a.attrs.loadPct}%` : ''}）` };
  return { kwh: null, how: '缺用電資料' };
}

// ════════════════ 環境部 盤查登錄匯入表單 V5 ════════════════
const GAS_COLS = ['CO2', 'CH4', 'N2O', 'HFCs', 'PFCs', 'SF6', 'NF3'];
const METHOD_FREQ = { api: '連續量測', bill: '定期(間歇)量測/財務單據(非推估值)', manual: '定期(間歇)量測/財務單據(非推估值)', import: '定期(間歇)量測/財務單據(非推估值)', ocr: '定期(間歇)量測/財務單據(非推估值)' };
function splitContact(s) {
  const parts = String(s || '').split(/[、,，;；\s]+/).filter(Boolean);
  const email = parts.find((p) => /@/.test(p)) || '';
  const phones = parts.filter((p) => /\d{2,}[-\d#]*\d/.test(p) && !/@/.test(p));
  const name = parts.find((p) => !/@/.test(p) && !/\d/.test(p)) || '';
  return { name, phone: phones[0] || '', fax: phones[1] || '', email };
}
const codeName = (s) => { const m = /^\s*([A-Z]{0,4}\d{2,}[A-Z\d]*)\s*[　\s：:、,，-]*\s*(.*)$/.exec(String(s || '')); return m ? [m[1], m[2]] : ['', String(s || '')]; };

function moenvImport(L, ctx) {
  const { org, profile, year, results } = ctx;
  const notes = [];
  const need = (label, v) => { if (!v) notes.push(`缺「${label}」`); return v || ''; };
  const site = profileValue(profile, 'moenvSiteNo');
  const head = (name) => MOENV_SHEETS[name];
  // 畫面顯示用欄名：群組表頭往右延伸（合併儲存格）＋子表頭
  const lastCols = (name) => {
    const hd = head(name); if (hd.length < 3) return hd[hd.length - 1];
    const [, grp, sub] = hd; let g = '';
    return Array.from({ length: Math.max(grp.length, sub.length) }, (_, i) => {
      if (grp[i]) g = grp[i];
      const sv = sub[i] || '';
      if (!sv) return grp[i] || g;
      return g && g !== sv ? `${g}／${sv}` : sv;
    });
  };
  const contact = splitContact(profile.contactPerson);
  const verified = String(profileValue(profile, 'verified'));
  const [regInd, regCond] = String(profile.registrationIndustry || '').split(/[、,，\s]+/);
  const [verCode, verName] = codeName(profile.verifier);
  const t1 = [[roc(year), need('環境部管制編號', profile.moenvControlNo), org.name, need('統一編號', profile.taxId), need('代表人', (profile.representative || '').split(/[、,，\s]/)[0]),
    need('聯絡人姓名', contact.name), need('聯絡人電話', contact.phone), need('聯絡人電子信箱', contact.email), contact.fax, profileValue(profile, 'registration'), cell(regInd), cell(regCond),
    (/^(是|已)/.test(verified) || (/查證|確信/.test(verified) && !/未/.test(verified))) ? '是' : '否', verCode, verName || '', '']];
  const [authCode, authName] = codeName(profile.authority);
  const t11 = [[need('目的事業主管機關代碼', authCode), authName, cell(profile.medicalCode)]];
  const [indCode, indName] = codeName(profileValue(profile, 'industryCode'));
  const t12 = [[indCode, indName]];
  const t2 = [[site, org.name, '', profile.taxId || '', need('縣市', profile.county), need('鄉鎮市區', profile.district), need('郵遞區號', profile.zip), need('地址', profile.address), '']];
  const accts = accountsOf(L);
  const t21 = accts.length ? accts.map((a) => (a.external_key ? [site, '是', a.external_key, '', '', a.attrs.sharedMeter ? '是' : '否'] : [site, '否', '', '(4)其他', '電號未建檔', ''])) : [];
  if (!accts.length) notes.push('沒有台電電號標的');
  else if (accts.some((a) => !a.external_key)) notes.push('有電號標的沒有填電號');
  const t22 = [[site, `${roc(year)}/1/1`, `${roc(year)}/12/31`]];
  const t23 = String(profile.excludedEntities || '').split(/\n+/).map((l) => l.split(/[｜|]/).map((x) => x.trim())).filter((x) => x[0]).map((x) => [site, x[0], x[1] || '', x[2] || '']);

  // 表3：每個排放源一列
  const rows = []; const check = []; const seq = { GS: 0, GV: 0, GF: 0, GM: 0, GP: 0 };
  const no = (p, a) => a?.attrs?.moenvEquipNo || `${p}${String(++seq[p]).padStart(p === 'GF' ? 4 : 2, '0')}`;
  const kgByAsset = new Map();
  for (const r of Object.values(results || {})) for (const i of r.trace?.inputs || []) if (i.assetId && i.kgCO2e && !i.excluded && i.factId) kgByAsset.set(i.assetId, (kgByAsset.get(i.assetId) || 0) + i.kgCO2e);
  const srcOf = (a) => q.all('SELECT name FROM data_sources WHERE asset_id = ? AND active = 1', a.id).map((s) => s.name).join('、');
  const freqOf = (facts) => {
    const obs = facts.flatMap((f) => j(f.observation_ids, [])).map((id) => q.get('SELECT method FROM observations WHERE id = ?', id)).filter(Boolean);
    if (facts.some((f) => f.value_state === 'estimated')) return '自行評估';
    return obs.some((o) => o.method === 'api') ? '連續量測' : METHOD_FREQ[obs[0]?.method] || '定期(間歇)量測/財務單據(非推估值)';
  };
  const equip = (a, fuel) => {
    if (a.attrs.moenvEquipCode) { const [c, n] = codeName(a.attrs.moenvEquipCode); return [c, n || a.name]; }
    const k = a.asset_type === 'boiler' ? (fuel === 'ng' || fuel === 'lpg' ? 'boiler_ng' : fuel === 'fuel_oil' ? 'boiler_fuel_oil' : 'boiler') : a.asset_type;
    const vc = a.asset_type === 'vehicle' && a.attrs.vehicleClass ? { 小客車: ['B101', '小客車'], 小貨車: ['B103', '小貨車'], 大客車: ['B100', '大客車'], 大貨車: ['B102', '大貨車'], 機車: ['B110', '普通重型機車'] }[a.attrs.vehicleClass] : null;
    const e = vc || MOENV_EQUIP[k]; return e ? [e[0], e[1]] : [MOENV_EQUIP_OTHER[0], a.name];
  };
  const marks = (gases) => GAS_COLS.map((g) => (gases.includes(g) ? 'V' : ''));
  const gasCells = (list) => { const out = []; for (let i = 0; i < 3; i++) { const g = list[i]; out.push(...(g ? [g.gas, cell(g.ef), g.unit || '', g.source || '', g.kind || '', ''] : ['', '', '', '', '', ''])); } return out; };
  const row = (a, o) => {
    const facts = o.facts || [];
    const r = [site, o.no, o.equip[0], o.equip[1], a?.attrs?.dept || '', [a?.location, a?.floor].filter(Boolean).join(' '), a?.leased ? '租賃設備' : '自有設備', o.qty ?? (Number(a?.attrs?.qty) || 1),
      o.used === false ? '無' : '有', o.fuel[0], o.fuel[1], o.biogenic ? '是' : '否', o.direct ? '直接' : '間接', o.type, o.cat || '', o.catOther || '', '', o.power || '',
      ...marks(o.gases), o.note || '', o.activity === null || o.activity === undefined ? '' : r2(o.activity, 4), o.unit, 100, o.source || (a ? srcOf(a) : '') || '', a?.attrs?.dept || '',
      facts.length ? freqOf(facts) : '', '', o.heat || '', '', '', '', '', o.method || '採用中央主管機關公告之溫室氣體排放係數', ...gasCells(o.factors || [])];
    rows.push(r);
    check.push([o.no, o.equip[1], a?.name || o.label || '', o.type, o.activity === null || o.activity === undefined ? '缺漏' : r2(o.activity, 4), o.unit, o.tco2e === undefined ? (a && kgByAsset.has(a.id) ? r2(kgByAsset.get(a.id) / 1000, 4) : '—') : o.tco2e, o.note || '']);
    if (o.activity === null || o.activity === undefined) if (o.used !== false) notes.push(`${a?.name || o.label}：缺活動數據`);
  };
  const ghgAssets = L.assets.filter((a) => a.applicability !== 'not_applicable' && /^(OIL-(GEN|BOILER|VEH|FORK)|GAS-|WAT-SEPTIC|ELE-HEAT)/.test(a.item_code || ''));
  // 燃燒
  for (const a of ghgAssets.filter((x) => ['OIL-GEN', 'OIL-BOILER', 'OIL-VEH', 'OIL-FORK', 'GAS-NG', 'GAS-LPG'].includes(x.item_code))) {
    if (a.asset_type === 'fuel_tank' || a.asset_type === 'fuel_card' || a.asset_type === 'supply_contract') continue;
    const fuel = a.attrs.fuel || DEFAULT_FUEL[a.item_code];
    const facts = L.facts.filter((f) => f.asset_id === a.id && f.metric_code === FUEL_ACTIVITY[fuel]);
    const act = sum(facts.map((f) => val(f, FUEL_UNIT[fuel])));
    const mobile = ['OIL-VEH', 'OIL-FORK'].includes(a.item_code);
    const heat = fuel === 'ng' ? (a.attrs.ngType ? `預設-公告熱值(天然氣${a.attrs.ngType})` : '') : '預設-公告熱值';
    if (fuel === 'ng' && !a.attrs.ngType) notes.push(`${a.name}：請在標的專屬欄位選天然氣 NG1 或 NG2（燃料熱值來源）`);
    row(a, { no: no(mobile ? 'GV' : 'GS', a), equip: equip(a, fuel), fuel: MOENV_FUEL[fuel], biogenic: Number(a.attrs.biogenicShare) > 0, direct: true, type: mobile ? '移動燃燒' : '固定燃燒',
      gases: ['CO2', 'CH4', 'N2O'], activity: act, unit: { L: '公升', Nm3: '立方公尺', kg: '公斤' }[FUEL_UNIT[fuel]], facts, heat, used: act === null && !facts.length ? undefined : act !== 0,
      factors: ['CO2', 'CH4', 'N2O'].map((g) => ({ gas: g })) });
  }
  // 冷媒、滅火器
  const method = (getCalc() || {}).refrigerantMethod || 'recharge';
  for (const a of ghgAssets.filter((x) => ['GAS-REF', 'GAS-FIRE'].includes(x.item_code))) {
    let gas = a.attrs.refrigerant || a.attrs.agent;
    if (!gas || /乾粉/.test(gas) || a.attrs.type === '乾粉') continue;
    gas = REFRIGERANT_ALIASES[gas] || gas;
    const code = MOENV_REFRIGERANT[a.attrs.refrigerant] || MOENV_REFRIGERANT[gas] || ['', gas];
    if (MONTREAL.includes(a.attrs.refrigerant) || MONTREAL.includes(gas)) continue; // HCFC 非氣候法定義之溫室氣體（代碼檔以 0 計），列在報告書排除說明
    const cls = gasClass(gas) || 'HFCs';
    const fire = a.item_code === 'GAS-FIRE';
    const rech = L.facts.filter((f) => f.asset_id === a.id && ['ref_recharge_kg', 'fire_ext_refill_kg'].includes(f.metric_code));
    const plate = L.facts.filter((f) => f.asset_id === a.id && ['ref_charge_kg', 'fire_ext_charge_kg'].includes(f.metric_code));
    const base = { no: no('GF', a), equip: equip(a), fuel: code, direct: true, type: '逸散', gases: [cls], cat: fire ? '七、其他' : '三、冷凍及空調', catOther: fire ? '消防設施' : '' };
    if (rech.length) {
      row(a, { ...base, activity: sum(rech.map((f) => val(f, 'kg'))), unit: fire ? '公斤' : '公斤/年', facts: rech, method: '質量平衡法', source: srcOf(a) || '維修補充紀錄',
        factors: [{ gas: cls, ef: 1, unit: '公斤/公斤', source: '質量平衡所得係數', kind: '量測/質能平衡所得係數' }] });
    } else if (method === 'screening' && a.attrs.leakRatePct && plate.length) {
      row(a, { ...base, activity: latestFact(plate, 'kg'), unit: '公斤/年', facts: plate, source: '設備銘牌', factors: [{ gas: cls, ef: Number(a.attrs.leakRatePct), unit: '%/年', kind: '國家排放係數' }] });
    } else {
      row(a, { ...base, activity: null, unit: fire ? '公斤' : '公斤/年', facts: [], note: '缺補充（回收）紀錄；銘牌充填量不等於逸散量' });
    }
  }
  // GCB 絕緣氣體
  for (const a of ghgAssets.filter((x) => x.item_code === 'GAS-GCB' && (x.attrs.switchType || 'GCB') === 'GCB')) {
    const f = L.facts.filter((x) => x.asset_id === a.id && x.metric_code === 'insul_gas_recharge_kg');
    row(a, { no: no('GF', a), equip: equip(a), fuel: MOENV_FUEL.SF6, direct: true, type: '逸散', gases: ['SF6'], cat: '七、其他', catOther: '氣體絕緣開關', activity: f.length ? sum(f.map((x) => val(x, 'kg'))) : 0,
      unit: '公斤', facts: f, method: '質量平衡法', note: f.length ? '' : '本年度無補充紀錄（活動數據 0）', factors: [{ gas: 'SF6', ef: 1, unit: '公斤/公斤', source: '質量平衡所得係數', kind: '量測/質能平衡所得係數' }] });
  }
  // 醫療／工業氣體
  for (const a of ghgAssets.filter((x) => x.item_code === 'GAS-MED')) {
    for (const [metric, gas, catOther] of [['n2o_use_kg', 'N2O', '麻醉氣體'], ['co2_use_kg', 'CO2', '氣體鋼瓶']]) {
      const f = L.facts.filter((x) => x.asset_id === a.id && x.metric_code === metric); if (!f.length) continue;
      row(a, { no: no('GF', a), equip: equip(a), fuel: MOENV_FUEL[gas], direct: true, type: '逸散', gases: [gas], cat: '七、其他', catOther, activity: sum(f.map((x) => val(x, 'kg'))), unit: '公斤', facts: f,
        method: '質量平衡法', factors: [{ gas, ef: 1, unit: '公斤/公斤', source: '質量平衡所得係數', kind: '量測/質能平衡所得係數' }] });
    }
  }
  // 化糞池
  const sep = results?.['ghg.s1.septic'];
  for (const a of ghgAssets.filter((x) => x.item_code === 'WAT-SEPTIC' && x.applicability === 'applicable')) {
    const bod = factorAt('septic.bod_g_per_person_day', `${year}-07-01`); const bo = factorAt('septic.bo', `${year}-07-01`); const mcf = factorAt('septic.mcf', `${year}-07-01`);
    const pd = sep?.trace?.personDays;
    row(a, { no: no('GF', a), equip: equip(a), fuel: MOENV_FUEL.septic, direct: true, type: '逸散', gases: ['CH4'], cat: '一、生活廢水及廢棄污泥(BOD)',
      activity: pd && bod ? pd * bod.value / 1e6 : null, unit: '公噸(BOD)', source: '人事工時與醫務統計（人日 × BOD 產生量）', tco2e: sep?.value ?? '—',
      note: pd ? `人日 ${r2(pd, 2)} × BOD ${bod?.value ?? '?'} g/人日` : '缺員工工時或係數未發布',
      factors: [{ gas: 'CH4', ef: bo && mcf ? r2(bo.value * mcf.value, 4) : '', unit: '公噸/公噸(BOD)', kind: '國家排放係數' }] });
  }
  // 外購電力：一個分據點一列（所有電號合計）
  if (accts.length) {
    const f = L.facts.filter((x) => accts.some((a) => a.id === x.asset_id) && x.metric_code === 'elec_purchased_kwh');
    const kwh = sum(f.map((x) => val(x, 'kWh')));
    const ef = (results?.['ghg.s2.electricity']?.trace?.factors || [])[0];
    row(accts[0], { no: 'GP01', equip: MOENV_EQUIP.power_account, fuel: MOENV_FUEL.electricity, direct: false, type: '外購電力', cat: '併網', power: '公用售電業(台電)', gases: ['CO2'], qty: 1,
      activity: kwh === null ? null : kwh / 1000, unit: '千度', facts: f, source: '台電電費單', label: '外購電力（全部電號）', tco2e: results?.['ghg.s2.electricity']?.value ?? '—',
      note: `電號：${accts.map(accountLabel).join('、')}`, factors: [{ gas: 'CO2', ef: ef?.value ?? '', unit: '公斤CO2/度', kind: '國家排放係數' }] });
  }
  // 外購蒸汽／熱能（外購電力用 GP01）
  if (accts.length) seq.GP = 1;
  for (const a of ghgAssets.filter((x) => x.item_code === 'ELE-HEAT' && x.applicability === 'applicable')) {
    const f = L.facts.filter((x) => x.asset_id === a.id && x.metric_code === 'imported_energy_gj');
    row(a, { no: no('GP', a), equip: equip(a), fuel: MOENV_FUEL.steam, direct: false, type: '外購蒸汽', power: a.attrs.supplier || '', gases: ['CO2'], activity: sum(f.map((x) => val(x, 'GJ'))), unit: 'GJ', facts: f,
      note: '活動數據單位請依匯入說明換算（系統可接受：公噸、千度…）', method: '其他' });
  }
  const tables = [
    T('表1 事業基本資料', '表1事業基本資料', lastCols('表1事業基本資料'), t1, { xlsxHead: head('表1事業基本資料') }),
    T('表1-1 目的事業主管機關', '表1-1事業基本資料-目的事業主管機關', lastCols('表1-1事業基本資料-目的事業主管機關'), t11, { xlsxHead: head('表1-1事業基本資料-目的事業主管機關') }),
    T('表1-2 行業別', '表1-2事業基本資料-行業別', lastCols('表1-2事業基本資料-行業別'), t12, { xlsxHead: head('表1-2事業基本資料-行業別') }),
    T('表2 邊界設定', '表2邊界設定', lastCols('表2邊界設定'), t2, { xlsxHead: head('表2邊界設定') }),
    T('表2-1 電號資料', '表2-1邊界設定-電號資料', lastCols('表2-1邊界設定-電號資料'), t21, { xlsxHead: head('表2-1邊界設定-電號資料') }),
    T('表2-2 營運期間', '表2-2邊界設定-營運期間', lastCols('表2-2邊界設定-營運期間'), t22, { xlsxHead: head('表2-2邊界設定-營運期間') }),
    T('表2-3 未納入計算之排放源', '表2-3邊界設定-未納入計算之排放源', lastCols('表2-3邊界設定-未納入計算之排放源'), t23, { xlsxHead: head('表2-3邊界設定-未納入計算之排放源') }),
    T('表3 排放源定性及定量', '表3-排放源定性及定量', lastCols('表3-排放源定性及定量'), rows,
      { xlsxHead: head('表3-排放源定性及定量') }),
  ];
  const uniq = [...new Set(notes)];
  return { blocks: { moenv_import: { state: uniq.length ? 'partial' : 'measured', text: `${uniq.length ? `待補：${uniq.join('；')}。` : ''}依環境部匯入表單 V5 欄位順序產生；固定／移動燃燒與外購電力採公告係數者，係數欄由系統自動帶入。設備與原燃物料代碼依代碼檔 V2，標的可在專屬欄位 moenvEquipCode 覆寫。`, tables },
    moenv_check: { state: 'measured', text: '供匯入後與平台計算結果核對；差異請檢查活動數據單位與係數。', tables: [T('排放源排放量核對', '核對', ['設備編號', '設備名稱', '本平台標的', '排放型式', '活動數據', '單位', '本平台計算 tCO₂e', '說明'], check)] } } };
}
let calcSettings = null;
function getCalc() { return calcSettings; }

// ════════════════ 能源署 非生產性質行業能源查核申報（附表三）════════════════
function supplyValue(L, a, accts, attrKey, metric, unit) {
  if (a.attrs[attrKey] !== undefined && a.attrs[attrKey] !== '') return { v: Number(a.attrs[attrKey]), from: '電號供電範圍' };
  if (accts.length === 1 && metric) { const v = orgMetric(L, metric, unit); if (v !== null) return { v, from: '全院' }; }
  return { v: null, from: '' };
}
function euBasic(L, ctx) {
  const { org, profile, results } = ctx;
  const accts = accountsOf(L); const notes = [];
  if (!accts.length) return { state: 'missing', text: '沒有台電電號標的（外購電力項目）。', tables: [] };
  const beds = results?.['act.beds']?.value ?? orgMetric(L, 'beds', 'bed');
  const colsFor = accts.map((a) => {
    const area = supplyValue(L, a, accts, 'supplyFloorAreaM2', 'floor_area_m2', 'm2'); const ac = supplyValue(L, a, accts, 'supplyAcAreaM2', 'aircon_area_m2', 'm2');
    const park = supplyValue(L, a, accts, 'supplyParkingAreaM2', 'parking_area_m2', 'm2'); const staff = supplyValue(L, a, accts, 'supplyStaff', 'medical_staff_count', 'person');
    const elecCost = sum(metricFacts(L, a.id, 'elec_cost_twd').map((f) => val(f, 'TWD')));
    const fuelCost = accts.length === 1 ? sum(L.facts.filter((f) => ['oil_cost_twd', 'ng_cost_twd', 'lpg_cost_twd'].includes(f.metric_code)).map((f) => val(f, 'TWD'))) : null;
    const energyCost = sum([elecCost, fuelCost]);
    const totalExp = Number(String(profile.totalExpense || '').replace(/[^\d.]/g, '')) || null;
    for (const [k, v] of [['樓地板面積', area.v], ['空調使用面積', ac.v], ['員工人數', staff.v]]) if (v === null) notes.push(`${accountLabel(a)} 缺${k}${accts.length > 1 ? '（多電號須填各電號供電範圍）' : ''}`);
    if (!a.external_key) notes.push(`${a.name} 未填電號`);
    return [a.attrs.energyUserNo || '', profile.hqName || org.name, profile.taxId || '', profile.representative || '', org.name, profile.managerName || '', a.external_key || '（未填）', a.attrs.tariffType || '',
      a.attrs.supplyAddress || profile.address || '', profileValue(profile, 'industryCode'), profileValue(profile, 'userCategory'), cell(beds), cell(r2(staff.v, 0)), profileValue(profile, 'annualWorkHours'),
      cell(r2(area.v)), cell(r2(ac.v)), cell(r2(park.v)), energyCost === null ? '' : r2(energyCost / 10000, 2), energyCost !== null && totalExp ? r2(energyCost / 10000 / totalExp * 100, 2) : '',
      a.attrs.mergedReport || '', [area.from, staff.from].includes('全院') ? '面積、人數取自全院（單一電號）' : ''];
  });
  const labels = ['06 能源用戶編號', '01 總公司名稱', '02／10 統一編號', '03 代表人', '07 能源用戶名稱', '08 能源用戶負責人', '11 電號', '契約用電別', '12 能源使用地址', '14 行業編號及分類', '15 用戶分類',
    '16 營業規模（病床數）', '17 員工人數（執業醫事人員）', '18 全年工作時數（小時）', '19 總樓地板面積（m²）', '20 總空調使用面積（m²）', '21 總室內停車場面積（m²）', '22 總能源費用（萬元／年）',
    '24 總能源費用占總支出費用之比例（%）', '合併申報電號', '說明'];
  for (const [k, v] of [['能源管理人員', profile.energyManager], ['代表人', profile.representative], ['統一編號', profile.taxId]]) if (!v) notes.push(`院所基本資料缺${k}`);
  const rows = labels.map((l, i) => [l, ...colsFor.map((c) => c[i])]);
  rows.push(['能源管理人員（設置登記）', ...accts.map(() => profile.energyManager || '')]);
  const uniq = [...new Set(notes)];
  return { state: uniq.length ? 'partial' : 'measured', text: uniq.length ? `待補：${uniq.join('；')}。` : '', tables: [T('表三 能源用戶基本資料', '表三基本資料', ['項目', ...accts.map(accountLabel)], rows, { maskCols: [] })] };
}

const HEAT_FUELS = [['fuel_oil', '燃料油', 'kL', '公秉'], ['lpg', '液化石油氣', 'kg', '公斤'], ['ng', '天然氣', 'Nm3', '立方公尺'], ['gasoline', '汽油', 'L', '公升'], ['diesel', '柴油', 'kL', '公秉']];
const COST_METRIC = { fuel_oil: 'oil_cost_twd', gasoline: 'oil_cost_twd', diesel: 'oil_cost_twd', ng: 'ng_cost_twd', lpg: 'lpg_cost_twd' };
function fuelFacts(L, fuel, metric) {
  return L.facts.filter((f) => f.metric_code === metric && f.item_code && (f.attrs.fuel || DEFAULT_FUEL[f.item_code]) === fuel && (FUEL_ACTIVITY[fuel] !== metric || ['OIL-GEN', 'OIL-BOILER', 'OIL-VEH', 'OIL-FORK', 'GAS-NG', 'GAS-LPG'].includes(f.item_code)));
}
function euHeat(L, ctx) {
  const { year } = ctx; const notes = [];
  const cols = HEAT_FUELS.map(([fuel, , unit]) => ({ use: monthly(fuelFacts(L, fuel, FUEL_ACTIVITY[fuel]), year, unit), cost: monthly(fuelFacts(L, fuel, COST_METRIC[fuel]), year, 'TWD') }));
  for (const c of cols) notes.push(...c.use.notes);
  const rows = MONTHS.map((m, i) => [`${m}月`, ...cols.flatMap((c) => [cell(r2(c.use.values[i], 3)), cell(r2(c.cost.values[i], 0))])]);
  rows.push(['總計', ...cols.flatMap((c) => [cell(r2(sum(c.use.values), 3)), cell(r2(sum(c.cost.values), 0))])]);
  rows.push(['平均', ...cols.flatMap((c) => [cell(r2(avg(c.use.values), 3)), cell(r2(avg(c.cost.values), 0))])]);
  const sup = HEAT_FUELS.map(([fuel]) => [...new Set(L.facts.filter((f) => f.metric_code === FUEL_ACTIVITY[fuel] && (f.attrs.fuel || DEFAULT_FUEL[f.item_code]) === fuel).map((f) => f.attrs.supplier).filter(Boolean))].join('、'));
  rows.push(['供應商名稱', ...sup.flatMap((s) => [s, ''])]);
  const cust = HEAT_FUELS.map(([fuel]) => [...new Set(L.facts.filter((f) => f.metric_code === FUEL_ACTIVITY[fuel] && (f.attrs.fuel || DEFAULT_FUEL[f.item_code]) === fuel).map((f) => L.byId.get(f.asset_id)?.external_key).filter(Boolean))].join('、'));
  rows.push(['客戶編號', ...cust.flatMap((s) => [s, ''])]);
  return { state: notes.length ? 'partial' : 'measured', text: `申報月份以帳單（收據）載明月份計，系統取計費期間迄日所在月份。車輛用油只需申報行駛於列管電號供電區域內之用油量；多個列管電號分別申報時，請依各電號供電範圍分配。${notes.length ? `缺漏：${[...new Set(notes)].join('、')}。` : ''}`,
    tables: [T('表五之一 熱能使用量統計表', '表五之一熱能', ['申報月份', ...HEAT_FUELS.flatMap(([, n, , u]) => [`${n}使用量（${u}）`, `${n}總價（含稅，元）`])], rows, { maskCols: HEAT_FUELS.map((_, i) => 2 + i * 2) })] };
}

const ELEC_COLS = [['elec_contract_kw', 'kW', 'last', '經常契約容量（瓩）'], ['elec_peak_demand_kw', 'kW', 'max', '最高需量 尖峰'], ['elec_demand_semipeak_kw', 'kW', 'max', '最高需量 半尖峰'],
  ['elec_demand_satsemipeak_kw', 'kW', 'max', '最高需量 週六半尖峰'], ['elec_demand_offpeak_kw', 'kW', 'max', '最高需量 離峰'], ['elec_peak_kwh', 'kWh', 'sum', '度數 尖峰'], ['elec_semipeak_kwh', 'kWh', 'sum', '度數 半尖峰'],
  ['elec_satsemipeak_kwh', 'kWh', 'sum', '度數 週六半尖峰'], ['elec_offpeak_kwh', 'kWh', 'sum', '度數 離峰'], ['elec_purchased_kwh', 'kWh', 'sum', '度數 合計'], ['elec_wheeled_kwh', 'kWh', 'sum', '轉供度數'],
  ['elec_power_factor_pct', 'pct', 'last', '功因（%）'], ['elec_cost_twd', 'TWD', 'sum', '總電費（含稅，元）']];
export function meterMonthly(L, a, year) {
  const cols = ELEC_COLS.map(([metric, unit, agg]) => monthly(metricFacts(L, a.id, metric), year, unit, agg));
  if (cols[0].values.every((v) => v === null) && a.attrs.contractKw) cols[0] = { values: MONTHS.map(() => Number(a.attrs.contractKw)), notes: [] };
  return cols;
}
function euElec(L, ctx) {
  const { year } = ctx; const accts = accountsOf(L); const notes = []; const tables = [];
  if (!accts.length) return { state: 'missing', text: '沒有台電電號標的。', tables };
  for (const a of accts) {
    const cols = meterMonthly(L, a, year);
    const kwh = cols[9].values;
    if (kwh.filter((v) => v !== null).length < 12) notes.push(`${accountLabel(a)} 用電度數只有 ${kwh.filter((v) => v !== null).length} 個月`);
    for (const c of cols) notes.push(...c.notes.map((n) => `${accountLabel(a)} ${n}`));
    MONTHS.forEach((m, i) => { const tou = sum([5, 6, 7, 8].map((k) => cols[k].values[i])); if (tou !== null && kwh[i] !== null && Math.abs(tou - kwh[i]) > Math.max(1, kwh[i] * 0.001)) notes.push(`${accountLabel(a)} ${m} 月各時段度數合計 ${r2(tou, 0)} 與總度數 ${r2(kwh[i], 0)} 不符`); });
    const rows = MONTHS.map((m, i) => [`${m}月`, ...cols.map((c, k) => cell(r2(c.values[i], ELEC_COLS[k][1] === 'pct' ? 1 : 0)))]);
    rows.push(['合計', ...cols.map((c, k) => (['sum'].includes(ELEC_COLS[k][2]) ? cell(r2(sum(c.values), 0)) : ''))]);
    rows.push(['平均', ...cols.map((c, k) => cell(r2(avg(c.values), ELEC_COLS[k][1] === 'pct' ? 1 : 0)))]);
    const info = [['編號', String(tables.length + 1)], ['電號', a.external_key || '（未填）'], ['契約用電別', a.attrs.tariffType || ''], ['戶名', a.attrs.accountName || ''], ['用電地址', a.attrs.supplyAddress || ''], ['行業別', a.attrs.industry || '']];
    if (!a.attrs.tariffType) notes.push(`${accountLabel(a)} 未填契約用電別（例：65 需量綜合(高壓)非營業用）`);
    tables.push(T(`表五之二 電能使用量統計表（電號 ${accountLabel(a)}）`, `表五之二電能_${accountLabel(a)}`.slice(0, 31), ['申報月份', ...ELEC_COLS.map((c) => c[3])], rows,
      { info, maskCols: [13] }));
  }
  const uniq = [...new Set(notes)];
  return { state: uniq.length ? 'partial' : 'measured', text: `每個列管電號一張；申報月份為電費帳單載明之月份。${uniq.length ? `待補：${uniq.join('；')}。` : ''}`, tables };
}

function euEui(L, ctx) {
  const { year, orgId } = ctx; const accts = accountsOf(L); const tables = []; const notes = [];
  const prev = prevDataset(orgId, year - 1); const P = prev ? loader(prev.id, orgId) : null;
  for (const a of accts) {
    const area = supplyValue(L, a, accts, 'supplyFloorAreaM2', 'floor_area_m2', 'm2').v; const park = supplyValue(L, a, accts, 'supplyParkingAreaM2', 'parking_area_m2', 'm2').v || 0;
    const indoor = area === null ? null : area - park;
    let pIndoor = indoor;
    if (P && accts.length === 1 && !a.attrs.supplyFloorAreaM2) { const pa = orgMetric(P, 'floor_area_m2', 'm2'); if (pa !== null) pIndoor = pa - (orgMetric(P, 'parking_area_m2', 'm2') || 0); }
    const cur = monthly(metricFacts(L, a.id, 'elec_purchased_kwh'), year, 'kWh').values;
    const pre = P ? monthly(P.facts.filter((f) => f.asset_id === a.id && f.metric_code === 'elec_purchased_kwh'), year - 1, 'kWh').values : MONTHS.map(() => null);
    const eui = (k, ar) => (k === null || !ar ? null : k / ar);
    const rows = MONTHS.map((m, i) => [`${m}月`, cell(r2(pIndoor)), cell(r2(indoor)), cell(r2(eui(pre[i], pIndoor), 3)), cell(r2(eui(cur[i], indoor), 3)), '', '']);
    const need = [];
    for (let qtr = 0; qtr < 4; qtr++) {
      const ps = sum(pre.slice(qtr * 3, qtr * 3 + 3)); const cs = sum(cur.slice(qtr * 3, qtr * 3 + 3));
      const pe = eui(ps, pIndoor); const ce = eui(cs, indoor);
      const d = pe && ce !== null ? (ce - pe) / pe * 100 : null;
      rows[qtr * 3 + 1][5] = d === null ? '' : `${d >= 0 ? '增加' : '減少'} ${r2(Math.abs(d), 2)}%`;
      if (d !== null && Math.abs(d) > 10) { need.push(`第 ${qtr + 1} 季`); rows[qtr * 3 + 1][6] = '（差異超過 10%，請填原因）'; }
    }
    const pe = eui(sum(pre), pIndoor); const ce = eui(sum(cur), indoor); const d = pe && ce !== null ? (ce - pe) / pe * 100 : null;
    rows.push(['全年度', cell(r2(pIndoor)), cell(r2(indoor)), cell(r2(pe, 3)), cell(r2(ce, 3)), d === null ? '' : `${d >= 0 ? '增加' : '減少'} ${r2(Math.abs(d), 2)}%`, d !== null && Math.abs(d) > 10 ? '（差異超過 10%，請填原因）' : '']);
    if (indoor === null) notes.push(`${accountLabel(a)} 缺樓地板面積`);
    if (!P) notes.push(`沒有 ${year - 1} 年資料集，前一年欄位空白`);
    if (need.length) notes.push(`${accountLabel(a)} ${need.join('、')} 差異超過 10%，須填原因`);
    tables.push(T(`表五之四 電能績效自我評比表（電號 ${accountLabel(a)}）`, `表五之四EUI_${accountLabel(a)}`.slice(0, 31),
      ['月份', `${roc(year - 1)} 年室內樓地板面積（m²）`, `${roc(year)} 年室內樓地板面積（m²）`, `${roc(year - 1)} 年 EUI（度/m²）`, `${roc(year)} 年 EUI（度/m²）`, '每季差異分析', '原因'], rows));
  }
  const uniq = [...new Set(notes)];
  return { state: !accts.length ? 'missing' : uniq.some((n) => /缺樓地板/.test(n)) ? 'partial' : 'measured', text: `室內樓地板面積＝總樓地板面積－室內停車場面積；差異分析＝（本年 EUI－前年 EUI）÷ 前年 EUI。${uniq.length ? uniq.join('；') + '。' : ''}`, tables };
}

function euFlow(L, ctx) {
  const { year } = ctx; const accts = accountsOf(L); const tables = []; const notes = [];
  const loads = L.assets.filter((a) => ['ELE-SUB', 'ELE-EQUIP'].includes(a.item_code) && a.applicability !== 'not_applicable');
  for (const acct of accts) {
    const total = sum(metricFacts(L, acct.id, 'elec_purchased_kwh').filter((f) => billMonth(f).y === year).map((f) => val(f, 'kWh')));
    // 分盤優先（掛在此電號下的最底層分盤／設備）；同一系統分盤與設備都有時只取分盤，避免重複
    const mine = loads.filter((a) => accountOf(L, a)?.id === acct.id || (accts.length === 1 && !accountOf(L, a)));
    const panels = mine.filter((a) => a.item_code === 'ELE-SUB' && !mine.some((c) => c.parent_asset_id === a.id && c.item_code === 'ELE-SUB'));
    const use = panels.length ? panels : mine.filter((a) => a.item_code === 'ELE-EQUIP');
    const by = new Map(); const unknown = [];
    for (const a of use) { const e = equipKwh(L, a, year); if (e.kwh === null) { unknown.push(a.name); continue; } const s = systemOf(a); by.set(s, (by.get(s) || 0) + e.kwh); }
    const allocated = sum([...by.values()]) || 0;
    const pvSelf = accts.length === 1 ? sum(L.facts.filter((f) => f.metric_code === 'elec_self_used_kwh' && billMonth(f).y === year).map((f) => val(f, 'kWh'))) : null;
    const pvExport = accts.length === 1 ? sum(L.facts.filter((f) => f.metric_code === 'elec_exported_kwh' && billMonth(f).y === year).map((f) => val(f, 'kWh'))) : null;
    const pvGen = accts.length === 1 ? sum(L.facts.filter((f) => f.metric_code === 'elec_generated_kwh' && billMonth(f).y === year).map((f) => val(f, 'kWh'))) : null;
    const grand = sum([total, pvSelf]);
    const rows = SYSTEMS.filter((s) => by.has(s)).map((s) => [s, r2(by.get(s), 0), grand ? r2(by.get(s) / grand * 100, 2) : '']);
    if (grand !== null) rows.push(['未分配（含線損、未計量）', r2(grand - allocated, 0), grand ? r2((grand - allocated) / grand * 100, 2) : '']);
    rows.push(['台電電費單總用電度數（含轉供）', cell(r2(total, 0)), ''], ['再生能源自用總度數', cell(r2(pvSelf, 0)), ''], ['再生能源回售台電總度數', cell(r2(pvExport, 0)), ''], ['再生能源總發電量', cell(r2(pvGen, 0)), ''], ['總用電度數', cell(r2(grand, 0)), '100']);
    if (!use.length) notes.push(`${accountLabel(acct)} 沒有分盤或設備資料，無法分析電力使用分布`);
    if (unknown.length) notes.push(`${accountLabel(acct)} ${unknown.length} 項沒有用電資料（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? '…' : ''}）`);
    if (grand && allocated > grand * 1.05) notes.push(`${accountLabel(acct)} 分盤／設備合計 ${r2(allocated, 0)} 度大於總用電 ${r2(grand, 0)} 度，請檢查是否重複`);
    tables.push(T(`表六 電能用量平衡（電號 ${accountLabel(acct)}）`, `表六電能平衡_${accountLabel(acct)}`.slice(0, 31), ['系統', '度/年', '占比（%）'], rows));
    // 分盤對帳明細
    if (panels.length) tables.push(T(`分盤明細（電號 ${accountLabel(acct)}，${panels.length} 座）`, `分盤明細_${accountLabel(acct)}`.slice(0, 31), ['分盤', '主要負載系統', '有無電表', '度/年', '來源', '位置'],
      panels.map((p) => { const e = equipKwh(L, p, year); return [p.name, systemOf(p), p.attrs.metered === false || p.attrs.metered === 'false' ? '無' : '有', cell(r2(e.kwh, 0)), e.how, [p.location, p.floor].filter(Boolean).join(' ')]; })));
  }
  // 熱能使用分布
  const heat = new Map(); const hn = [];
  for (const [fuel, name] of HEAT_FUELS) {
    const facts = fuelFacts(L, fuel, FUEL_ACTIVITY[fuel]).filter((f) => billMonth(f).y === year);
    const hv = factorAt(`heat.${fuel}`, `${year}-07-01`);
    for (const f of facts) {
      const v = val(f, FUEL_UNIT[fuel]); if (v === null) continue;
      if (!hv) { hn.push(`熱值 heat.${fuel} 未發布`); continue; }
      const use = f.attrs.heatUse || { 'OIL-GEN': '發電機', 'OIL-VEH': '車輛', 'OIL-FORK': '車輛' }[f.item_code] || '其他設備';
      const k = `${name}｜${use}`; heat.set(k, (heat.get(k) || 0) + v * hv.value / 1e6);
    }
  }
  const htot = sum([...heat.values()]);
  tables.push(T('表六 熱能用量平衡', '表六熱能平衡', ['熱能種類', '用途', '熱值（百萬卡/年）', '占比（%）'], [...heat.entries()].map(([k, v]) => [...k.split('｜'), r2(v, 3), htot ? r2(v / htot * 100, 2) : ''])));
  const uniq = [...new Set([...notes, ...hn])];
  return { state: !accts.length ? 'missing' : notes.some((n) => /沒有分盤/.test(n)) ? 'missing' : uniq.length ? 'partial' : 'measured',
    text: `電力使用分布以掛在電號下的分盤（沒有分盤時用設備）年用電加總；沒有電表的分盤以額定功率 × 年運轉時數推估。${uniq.length ? `待補：${uniq.join('；')}。` : ''}`, tables };
}

function euBuildings(L, ctx) {
  const rows = q.all('SELECT b.*, s.name AS site_name FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.org_id = ? AND b.valid_to IS NULL ORDER BY s.name, b.name', ctx.orgId)
    .map((b, i) => { const a = j(b.attrs, {}); return [i + 1, b.name, a.use || profileValue(ctx.profile, 'userCategory'), a.builtYear || '', a.floorsBelow ?? '', a.floorsAbove ?? '', cell(b.floor_area_m2), a.roof || '', a.entrance || '']; });
  const miss = rows.filter((r) => !r[3] || r[6] === '').map((r) => r[1]);
  return { state: !rows.length ? 'missing' : miss.length ? 'partial' : 'measured', text: !rows.length ? '尚未建立建物（組織院區與邊界 › 建物）。' : miss.length ? `建物缺建造年份或樓地板面積：${miss.join('、')}。` : '',
    tables: [T('表七 建築資料', '表七建築資料', ['建築編號', '建築名稱', '用戶分類', '建造年份（民國年）', '地下樓層', '地上樓層', '建築總樓地板面積（m²）', '屋頂構造', '建築入口大門方位'], rows)] };
}

function euElecSystem(L, ctx) {
  const bname = (a) => (a.building_id ? q.get('SELECT name FROM buildings WHERE id = ?', a.building_id)?.name : '') || a.location || '';
  const xf = L.assets.filter((a) => a.asset_type === 'transformer');
  const caps = L.assets.filter((a) => a.asset_type === 'capacitor');
  const gens = L.assets.filter((a) => a.asset_type === 'generator' && a.applicability !== 'not_applicable');
  const t1 = xf.map((a, i) => [i + 1, bname(a), a.name, a.attrs.brand || '', a.attrs.year || '', cell(a.attrs.kva), a.attrs.xfmrType || '', cell(a.attrs.primaryKv), cell(a.attrs.secondaryV), a.attrs.loadDesc || '',
    a.attrs.pfController === true || a.attrs.pfController === 'true' ? '有' : a.attrs.pfController === false ? '無' : '', cell(a.attrs.capacitorKvar)]);
  const t2 = caps.map((a, i) => [i + 1, bname(a), a.name, cell(a.attrs.kvar)]);
  const t3 = gens.map((a, i) => [i + 1, a.name, cell(a.attrs.kva), cell(a.attrs.voltageV), cell(a.attrs.ratedKw)]);
  const notes = [];
  if (!xf.length) notes.push('沒有變壓器標的');
  for (const a of xf) if (!a.attrs.kva || !a.attrs.xfmrType) notes.push(`${a.name} 缺容量或型式`);
  for (const a of gens) if (!a.attrs.kva) notes.push(`${a.name} 缺容量（kVA）`);
  return { state: !xf.length ? 'missing' : notes.length ? 'partial' : 'measured', text: `變壓器運轉值（溫度、實際電壓、最大負載電流、負載率）與總盤抄表值請以尖峰負載抄表數據另填。${notes.length ? `待補：${notes.join('；')}。` : ''}`,
    tables: [T('表八 變壓器設備規格', '表八變壓器', ['編號', '建築物名稱', '變壓器編號', '廠牌', '製造年份', '容量（kVA）', '型式', '一次側電壓（kV）', '二次側電壓（V）', '迴路名稱／負載概述', '功因自動調整器', '裝置電容器量（kVAr）'], t1),
      T('進相電容器', '表八電容器', ['編號', '建築物名稱', '名稱', '容量（kVAr）'], t2), T('緊急發電機', '表八緊急發電機', ['編號', '名稱', '容量（kVA）', '電壓（V）', '額定功率（kW）'], t3)] };
}

function euEquipment(L, ctx) {
  const { year } = ctx;
  const bname = (a) => (a.building_id ? q.get('SELECT name FROM buildings WHERE id = ?', a.building_id)?.name : '') || a.location || '';
  const eq = L.assets.filter((a) => a.applicability !== 'not_applicable' && (a.item_code === 'ELE-EQUIP' || (a.item_code === 'GAS-REF' && ['split_ac', 'window_ac', 'chiller'].includes(a.asset_type)) || a.asset_type === 'boiler'));
  const row = (a) => { const e = equipKwh(L, a, year); return [bname(a), systemOf(a), a.attrs.equipName || ASSET_TYPES[a.asset_type] || a.name, a.name, a.attrs.brand || '', a.attrs.model || '', a.attrs.inverter === true || a.attrs.inverter === 'true' ? '有' : a.attrs.inverter === false ? '無' : '',
    cell(a.attrs.capacity), a.attrs.capacityUnit || '', cell(a.attrs.ratedKw), a.attrs.efficiency || '', a.attrs.year || '', cell(a.attrs.qty || 1), cell(a.attrs.hoursPerYear), a.attrs.energyType || (a.asset_type === 'boiler' ? (a.attrs.fuel || '燃料') : '電力'), cell(r2(e.kwh, 0))]; };
  const cols = ['建築物名稱', '系統', '設備名稱', '本平台標的', '廠牌', '型號', '變頻控制', '設備容量', '容量單位', '額定電功率（kW）', '能源效率', '製造年份（民國）', '數量（台）', '年運轉時數（小時）', '使用能源種類', '推估年用電（度）'];
  const ac = eq.filter((a) => systemOf(a) === '空調'); const lt = eq.filter((a) => systemOf(a) === '照明'); const ot = eq.filter((a) => !['空調', '照明'].includes(systemOf(a)));
  const lcols = ['建築物名稱', '照明設備裝設區域', '燈具種類', '本平台標的', '容量規格（例 20W×4）', '數量', '年運轉時數（小時）', '推估年用電（度）'];
  const lrows = lt.map((a) => { const e = equipKwh(L, a, year); return [bname(a), a.attrs.area || a.location || '', a.attrs.equipName || '', a.name, a.attrs.lightingSpec || '', cell(a.attrs.qty || 1), cell(a.attrs.hoursPerYear), cell(r2(e.kwh, 0))]; });
  // 表九之四 系統耗電量彙整
  const by = new Map(); for (const a of eq) { const e = equipKwh(L, a, year); if (e.kwh !== null) by.set(systemOf(a), (by.get(systemOf(a)) || 0) + e.kwh); }
  const tot = sum([...by.values()]);
  const miss = eq.filter((a) => !a.attrs.capacity && !a.attrs.ratedKw).map((a) => a.name);
  return { state: !eq.length ? 'missing' : miss.length ? 'partial' : 'measured',
    text: `${!eq.length ? '尚未建立使用能源設備（高耗能設備項目）。' : ''}${miss.length ? `缺容量或額定功率：${miss.slice(0, 8).join('、')}${miss.length > 8 ? `…等 ${miss.length} 項` : ''}。` : ''}冰水機群組主機總容量達 1,000 冷凍噸者另須填表九之一（二）逐月系統效率。`,
    tables: [T('表九之一 空調系統設備', '表九之一空調', cols, ac.map(row)), T('表九之二 照明系統', '表九之二照明', lcols, lrows), T('表九之三 其他系統', '表九之三其他', cols, ot.map(row)),
      T('表九之四 系統耗電量彙整統計', '表九之四彙整', ['系統', '耗電量（度/年）', '占比（%）'], SYSTEMS.filter((s) => by.has(s)).map((s) => [s, r2(by.get(s), 0), tot ? r2(by.get(s) / tot * 100, 2) : '']))] };
}

const ENERGY_LABEL = { electricity: '電力（度）', fuel_oil: '燃料油（公秉）', lpg: '液化石油氣（公斤）', ng: '天然氣（立方公尺）', gasoline: '汽油（公升）', diesel: '柴油（公秉）' };
const mcols = ['項次', '電號', '節約能源措施來源', '措施代碼', '已執行之節約能源措施', '執行計畫期間', '效益計算起月', '效益計算迄月', '節能效益金額（千元）', '投資金額（千元）', '抑低尖峰需量（瓩）', ...Object.values(ENERGY_LABEL).map((l) => `節約能源量 ${l}`)];
function measureRows(L, list) {
  return list.map((m, i) => [i + 1, m.asset_id ? accountLabel(L.byId.get(m.asset_id) || { name: '' }) : '全院', m.source === 'cross_year' ? '跨年度成效' : '當年度計畫', m.code || '', m.name,
    `${m.period_from || ''}～${m.period_to || ''}`, cell(m.calc_from_month), cell(m.calc_to_month), m.benefit_twd === null ? '' : r2(m.benefit_twd / 1000, 1), m.investment_twd === null ? '' : r2(m.investment_twd / 1000, 1), cell(m.peak_reduction_kw),
    ...Object.keys(ENERGY_LABEL).map((k) => (m.energy_type === k ? cell(m.saving) : ''))]);
}
function euMeasures(L, ctx) {
  const list = listMeasures(ctx.orgId, ctx.year, 'done');
  const rows = measureRows(L, list);
  const tot = Object.keys(ENERGY_LABEL).map((k) => sum(list.filter((m) => m.energy_type === k).map((m) => m.saving)));
  if (rows.length) rows.push(['合計', '', '', '', '', '', '', '', r2(sum(list.map((m) => m.benefit_twd)) / 1000, 1) ?? '', r2(sum(list.map((m) => m.investment_twd)) / 1000, 1) ?? '', cell(sum(list.map((m) => m.peak_reduction_kw))), ...tot.map(cell)]);
  const noCalc = list.filter((m) => !m.calc_note).map((m) => m.name);
  return { state: 'measured', text: list.length ? `${noCalc.length ? `下列措施未填節能量計算說明（表十之一）：${noCalc.join('、')}。` : ''}各措施節能量計算說明見「節約能源措施」頁。` : '本年度沒有登錄已執行之節約能源措施（當年度新適用之能源用戶得免填表十）。',
    tables: [T('表十之二 節約能源措施執行成效分析表', '表十之二措施成效', mcols, rows),
      T('表十之一 節能量計算說明', '表十之一計算說明', ['項次', '措施', '施行對象', '實施區域', '具體作法', '數值來源與計算說明'], list.map((m, i) => [i + 1, m.name, m.target || '', m.area || '', m.method || '', m.calc_note || '']))] };
}
function euRate(L, ctx) {
  const accts = accountsOf(L); const tables = []; let state = 'measured'; const notes = [];
  for (const a of accts.length ? accts : [null]) {
    const t = savingRateTable(ctx.orgId, a?.id || null, ctx.year);
    if (!t.rows.length) { state = 'missing'; notes.push(`${a ? accountLabel(a) : '全院'} 沒有歷年節電量與用電量`); }
    tables.push(T(`表十之六 歷年平均年節電率總表${a ? `（電號 ${accountLabel(a)}）` : ''}`, `表十之六節電率_${a ? accountLabel(a) : '全院'}`.slice(0, 31), ['年度', '年度節電量 S（度）', '年度用電量 C（度）', '扣除用電量（度）', '平均年節電率 R（%）', '來源'],
      t.rows.map((r) => [`${roc(r.year)} 年`, cell(r2(r.saving, 0)), cell(r2(r.usage, 0)), cell(r2(r.deduct, 0)), cell(r2(r.rate, 2)), r.from])));
    if (t.rows.length && t.rows[t.rows.length - 1].rate !== null && t.rows[t.rows.length - 1].rate < 1) notes.push(`${a ? accountLabel(a) : '全院'} 平均年節電率 ${r2(t.rows[t.rows.length - 1].rate, 2)}% 未達 1%，須填表十之五說明及改善計畫`);
  }
  return { state, text: `R＝累計節電量 ÷（累計節電量＋累計用電量－扣除用電量）× 100%（附表三表十之六）。年度節電量來自「節約能源措施」已執行措施之電力節約量，或在該頁直接填歷年值。${notes.length ? notes.join('；') + '。' : ''}`, tables };
}
function euPlan(L, ctx) {
  const list = listMeasures(ctx.orgId, ctx.year + 1, 'plan');
  return { state: list.length ? 'measured' : 'missing', text: list.length ? '' : `尚未登錄 ${roc(ctx.year + 1)} 年節約能源措施執行計畫（節約能源措施 › 新增計畫）。`,
    tables: [T(`表十一之二 ${roc(ctx.year + 1)} 年節約能源措施暨節能量預估`, '表十一之二計畫', mcols.map((c) => c.replace('已執行之', '預計執行之').replace('節約能源量', '預估節約能源量')), measureRows(L, list))] };
}

// ════════════════ 政府機關及學校節約能源填報 ════════════════
function govMonthly(L, ctx) {
  const { year } = ctx; const notes = [];
  const accts = accountsOf(L);
  const waters = L.assets.filter((a) => ['WAT-TAP', 'WAT-GROUND'].includes(a.item_code) && a.applicability !== 'not_applicable' && ['water_account', 'well', 'water_meter'].includes(a.asset_type) && !a.parent_asset_id);
  const ecols = accts.map((a) => ({ label: `用電 ${accountLabel(a)}（度）`, m: monthly(metricFacts(L, a.id, 'elec_purchased_kwh'), year, 'kWh') }));
  const wcols = waters.map((a) => ({ label: `用水 ${a.external_key || a.name}（度）`, m: monthly(metricFacts(L, a.id, 'water_withdrawal_m3'), year, 'm3') }));
  const gas = monthly(fuelFacts(L, 'gasoline', 'oil_consumption_l'), year, 'L'); const die = monthly(fuelFacts(L, 'diesel', 'oil_consumption_l'), year, 'L');
  const all = [...ecols, { label: '用電合計（度）', m: { values: MONTHS.map((_, i) => sum(ecols.map((c) => c.m.values[i]))), notes: [] } }, ...wcols,
    { label: '用水合計（度）', m: { values: MONTHS.map((_, i) => sum(wcols.map((c) => c.m.values[i]))), notes: [] } }, { label: '汽油（公升）', m: gas }, { label: '柴油（公升）', m: die }];
  for (const c of [...ecols, ...wcols]) { const n = c.m.values.filter((v) => v !== null).length; if (n < 12) notes.push(`${c.label.replace(/（.*/, '')} 只有 ${n} 個月`); notes.push(...c.m.notes); }
  const rows = MONTHS.map((m, i) => [`${m}月`, ...all.map((c) => cell(r2(c.m.values[i], 1)))]);
  rows.push(['全年', ...all.map((c) => cell(r2(sum(c.m.values), 1)))]);
  if (!accts.length) notes.push('沒有台電電號標的');
  if (!waters.length) notes.push('沒有水號標的');
  const uniq = [...new Set(notes)];
  return { state: !accts.length ? 'missing' : uniq.length ? 'partial' : 'measured', text: `依帳單月份（計費期間迄日所在月份）加總。${uniq.length ? `待補：${uniq.join('；')}。` : ''}`,
    tables: [T('逐月用電、用水、用油', '逐月用量', ['帳單月份', ...all.map((c) => c.label)], rows)] };
}
function govCompare(L, ctx) {
  const { year, orgId, results } = ctx;
  const prev = prevDataset(orgId, year - 1);
  const codes = ['energy.elec_kwh', 'water.withdrawal_m3', 'energy.gasoline_l', 'energy.diesel_l', 'act.floor_area_m2', 'energy.eui_kwh_m2'];
  const labels = ['用電量（度）', '用水量（度）', '汽油（公升）', '柴油（公升）', '樓地板面積（m²）', 'EUI（度/m²）'];
  let pr = {};
  if (prev) { const cx = makeContext(prev.id); for (const c of codes) pr[c] = compute(cx, c); }
  const rows = codes.map((c, i) => { const a = pr[c]?.value ?? null; const b = results?.[c]?.value ?? null; return [labels[i], cell(r2(a, 3)), cell(r2(b, 3)), a && b !== null ? r2((b - a) / a * 100, 2) : '']; });
  return { state: 'measured', text: prev ? `前一年度資料集：${prev.name} 第 ${prev.version} 版（${prev.status === 'locked' ? '已定版' : '未定版'}）。` : `沒有 ${year - 1} 年資料集，無法比較。`,
    tables: [T('與前一年度比較', '年度比較', ['項目', `${roc(year - 1)} 年`, `${roc(year)} 年`, '增減（%）'], rows)] };
}

// ════════════════ 油電水節能管制（通用逐月表）════════════════
function oewMonthly(L, ctx) {
  const { year } = ctx; const accts = accountsOf(L);
  const m = (metric, unit, items) => monthly(L.facts.filter((f) => f.metric_code === metric && (!items || items.includes(f.item_code))), year, unit);
  const cols = [['用電度數', m('elec_purchased_kwh', 'kWh', ['ELE-GRID'])], ['電費（元）', m('elec_cost_twd', 'TWD', ['ELE-GRID'])], ['用水度數', m('water_withdrawal_m3', 'm3', ['WAT-TAP', 'WAT-GROUND'])],
    ['水費（元）', m('water_cost_twd', 'TWD')], ['汽油（公升）', monthly(fuelFacts(L, 'gasoline', 'oil_consumption_l'), year, 'L')], ['柴油（公升）', monthly(fuelFacts(L, 'diesel', 'oil_consumption_l'), year, 'L')],
    ['油料費（元）', m('oil_cost_twd', 'TWD')], ['天然氣（立方公尺）', m('ng_consumption_m3', 'Nm3', ['GAS-NG'])], ['液化石油氣（公斤）', m('lpg_consumption_kg', 'kg', ['GAS-LPG'])]];
  const rows = MONTHS.map((mm, i) => [`${mm}月`, ...cols.map(([, c]) => cell(r2(c.values[i], 1)))]);
  rows.push(['全年', ...cols.map(([, c]) => cell(r2(sum(c.values), 1)))]);
  return { state: accts.length ? 'measured' : 'missing', text: '通用格式：系統欄位規格待業主提供畫面後核對。依帳單月份加總。', tables: [T('逐月油電水用量與費用', '逐月油電水', ['帳單月份', ...cols.map(([l]) => l)], rows, { maskCols: [2, 4, 7] })] };
}

const BUILDERS = {
  eu_basic: euBasic, eu_heat: euHeat, eu_elec: euElec, eu_eui: euEui, eu_flow: euFlow, eu_buildings: euBuildings, eu_elec_system: euElecSystem, eu_equipment: euEquipment,
  eu_measures: euMeasures, eu_rate: euRate, eu_plan: euPlan, gov_monthly: govMonthly, gov_compare: govCompare, oew_monthly: oewMonthly,
};
export const OUTPUT_BLOCK_KEYS = [...Object.keys(BUILDERS), 'moenv_import', 'moenv_check'];

export function buildOutputBlocks(keys, { caseRow, datasetId, results }) {
  const want = keys.filter((k) => OUTPUT_BLOCK_KEYS.includes(k));
  if (!want.length) return {};
  const orgId = caseRow.org_id;
  const ctx = { org: orgById(orgId), orgId, year: caseRow.year, profile: getProfile(orgId), results };
  calcSettings = getConfig('calc.settings') || {};
  const L = loader(datasetId, orgId);
  const out = {};
  for (const k of want) {
    try {
      if (k === 'moenv_import' || k === 'moenv_check') { if (!out.moenv_import) Object.assign(out, moenvImport(L, ctx).blocks); continue; }
      out[k] = BUILDERS[k](L, ctx);
    } catch (e) { out[k] = { state: 'blocked', text: `無法產生：${e.message}` }; }
  }
  for (const k of Object.keys(out)) if (!want.includes(k)) delete out[k];
  return out;
}
