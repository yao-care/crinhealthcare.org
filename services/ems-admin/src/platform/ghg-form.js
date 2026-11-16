// 組織型溫室氣體盤查表單（環保署「溫室氣體盤查表單 3.0.0 版」表一～表九）
// 排放源列、排放量、數據品質、不確定性都取自計算引擎的逐排放源結果（calc.js makeSource），報告書與表單同一套數字。
// 係數：111 年度以前「溫室氣體排放係數管理表 6.0.4 版」（GWP AR4），112 年度起「環境部 113 年 2 月 5 日公告溫室氣體排放係數」（GWP AR5）。
import { q } from './db.js';
import { round } from './util.js';
import { allSources, editionFor, scoreRange, AD_TRUST_LABEL } from './calc.js';
import { MOENV_FUEL, MOENV_REFRIGERANT } from './seed/moenv-import.js';
import { getConfig } from './config-store.js';

const T = (title, sheet, columns, rows, o = {}) => ({ title, sheet, columns, rows, ...o });
const cell = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : v);
const r = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '' : round(v, d));
const pct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '' : `${round(v * 100, d)}%`);
const roc = (y) => y - 1911;
const GAS7 = ['CO2', 'CH4', 'N2O', 'HFCs', 'PFCs', 'SF6', 'NF3'];

// 表單 3.0.0 附表六（設備分類）：本平台標的類型 → 代碼；標的專屬欄位 moenvEquipCode 可覆寫
const EQUIP = {
  generator: ['0201', '柴油引擎'], boiler_fuel_oil: ['0010', '燃油鍋爐'], boiler_ng: ['0020', '燃氣鍋爐'], boiler: ['0099', '其他鍋爐'],
  vehicle: ['9799', '運輸作業車輛'], forklift: ['9799', '運輸作業車輛'], machinery: ['9799', '運輸作業車輛'],
  split_ac: ['4091', '住宅及商業建築冷氣機'], window_ac: ['4091', '住宅及商業建築冷氣機'], chiller: ['4092', '冰水機'], refrigerator: ['4096', '獨立商用冷凍、冷藏裝備'],
  dryer: ['1192', '冷凍式乾燥器'], fire_extinguisher: ['9798', '消防設施'], septic_tank: ['9795', '化糞池'],
};
const EQUIP_OTHER = ['9999', '其他未歸類設施'];
const SCOPE_LABEL = { 1: '範疇1', 2: '範疇2', 3: '範疇3' };

function profileOf(ctx) { return ctx.profile || {}; }
function assetOf(id) { return id ? q.get('SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.id = ?', id) : null; }
const attrsOf = (a) => { try { return JSON.parse(a?.attrs || '{}'); } catch { return {}; } };
const codeName = (s) => { const m = /^\s*([A-Z]{0,4}\d{2,}[A-Z\d]*)\s*[　\s：:、,，-]*\s*(.*)$/.exec(String(s || '')); return m ? [m[1], m[2]] : ['', String(s || '')]; };

function materialCode(s) {
  if (MOENV_FUEL[s.material]) return MOENV_FUEL[s.material];
  if (MOENV_REFRIGERANT[s.material]) { const [c, n] = MOENV_REFRIGERANT[s.material]; return [c, n]; }
  return ['', s.materialName || s.material];
}

// 依排放源排出 GXX 編號、設備代碼
function numbered(results) {
  const src = allSources(results);
  const seqP = new Map(); const seqE = new Map(); let pN = 0; let eN = 0;
  return src.map((s) => {
    const a = assetOf(s.assetId); const at = attrsOf(a);
    const proc = at.moenvProcessCode ? codeName(at.moenvProcessCode) : ['000999', '其他未分類製程'];
    if (!seqP.has(proc[0])) seqP.set(proc[0], `G${String(++pN).padStart(2, '0')}`);
    if (!seqE.has(s.assetId)) seqE.set(s.assetId, at.moenvEquipNo || `GM${String(++eN).padStart(2, '0')}`);
    let equip;
    if (at.moenvEquipCode) { const [c, n] = codeName(at.moenvEquipCode); equip = [c, n || a?.name || '']; }
    else {
      const k = a?.asset_type === 'boiler' ? (['ng', 'lpg'].includes(s.material) ? 'boiler_ng' : s.material === 'fuel_oil' ? 'boiler_fuel_oil' : 'boiler') : a?.asset_type;
      equip = EQUIP[k] || (s.itemCode === 'WAT-SEPTIC' ? EQUIP.septic_tank : EQUIP_OTHER);
    }
    return { ...s, procNo: seqP.get(proc[0]), proc, equipNo: seqE.get(s.assetId), equip, equipName: a?.name || s.asset, dept: at.dept || '', mat: materialCode(s), sourceDoc: q.all('SELECT name FROM data_sources WHERE asset_id = ? AND active = 1', s.assetId).map((x) => x.name).join('、') };
  });
}
const totalOf = (rows) => rows.reduce((t, s) => t + s.tco2e, 0);
const isDefault = (g) => !!g.efCode && /6\.0\.4|113 年 2 月 5 日|能源署|能源局/.test(g.efSource || '');

// ── 表一 公私場所資料 ──
function t1(L, ctx) {
  const p = profileOf(ctx); const { org, year } = ctx;
  const contact = splitContact(p.contactPerson); const rep = String(p.representative || '').split(/[、,，\s]/)[0];
  const ind = codeName(p.industryCode || '8610 醫院');
  const reg = /自願/.test(p.registration || '') ? '自願性登錄' : /環評/.test(p.registration || '') ? '環評承諾' : p.registration ? '依法登錄' : '依法登錄';
  const verified = /未|否|沒有/.test(p.verified || '未') ? '否' : '是';
  const missing = [['管制編號', p.moenvControlNo], ['統一編號', p.taxId], ['負責人', rep], ['聯絡人', contact.name], ['地址', p.address]].filter(([, v]) => !v).map(([k]) => k);
  const row = [roc(year), cell(p.moenvControlNo), org.name, cell(p.taxId), cell(p.factoryRegNo), cell(p.county), cell(p.district), cell(p.zip), '', '', cell(p.address), cell(p.employees),
    rep, cell(p.orgEmail), contact.name, contact.phone, contact.email, contact.fax, cell(p.contactMobile), ind[0], ind[1], '', '', reg, p.inventoryStandard || 'ISO / CNS 14064-1',
    verified, verified === '是' ? cell(p.verifier) : '', p.significancePct || '3.0%', p.materialityPct || '5.0%', p.exclusionPct || '0.5%'];
  return { state: missing.length ? 'partial' : 'measured', text: `${missing.length ? `院所基本資料待補：${missing.join('、')}。` : ''}盤查表單版次 V1；係數依${editionFor(year)}。`,
    tables: [T('表一 公私場所資料', '表一', ['盤查年度（民國）', '管制編號', '公私場所名稱', '統一編號', '工廠登記證編號', '縣市別', '鄉鎮別', '郵遞區號', '里別*', '鄰別*', '地址', '員工人數*', '負責人姓名',
      '公私場所電子信箱', '聯絡人姓名', '聯絡人電話', '聯絡人電子信箱', '聯絡人傳真*', '聯絡人手機', '行業代碼1', '行業名稱1', '行業代碼2*', '行業名稱2*', '登錄原因', '盤查依據規範',
      '是否經第三者查證', '查驗機構名稱', '顯著性門檻', '實質性門檻', '排除門檻'], [row])] };
}
function splitContact(s) {
  const parts = String(s || '').split(/[、,，;；\s]+/).filter(Boolean);
  const email = parts.find((x) => /@/.test(x)) || '';
  const phones = parts.filter((x) => /\d{2,}[-\d#]*\d/.test(x) && !/@/.test(x));
  return { name: parts.find((x) => !/@/.test(x) && !/\d/.test(x)) || '', phone: phones[0] || '', fax: phones[1] || '', email };
}

// ── 表二 組織邊界調查 ──
function t2(L, ctx) {
  const p = profileOf(ctx);
  const b = q.get("SELECT kind FROM boundaries WHERE org_id = ? AND kind LIKE 'ghg_%' AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from DESC LIMIT 1", ctx.orgId, `${ctx.year}-12-31`);
  const method = p.consolidation || { ghg_operational: '營運控制法', ghg_equity: '股權比例法' }[b?.kind] || '營運控制法';
  const rows = [['(一)', '場址外涵蓋區域*', cell(p.offsiteAreas)], ['(二)', '場址內扣除區域*', cell(p.excludedAreas || p.excludedEntities)], ['(三)', '設定方法', method]];
  return { state: 'measured', text: '', tables: [T('表二 組織邊界調查', '表二', ['項次', '項目', '內容'], rows)] };
}

// ── 表三 排放源鑑別 ──
function t3(L, ctx) {
  const rows = numbered(ctx.results).map((s) => {
    const marks = GAS7.map((g) => (s.gases.some((x) => x.cls === g) ? 'V' : ''));
    return [s.procNo, s.proc[0], s.proc[1], s.equipNo, s.equip[0], s.equipName, s.scope === 2 ? '' : '1.原燃物料', s.mat[0], s.mat[1], s.biogenic ? '是' : '否', SCOPE_LABEL[s.scope],
      s.type, s.category || '', ...marks, '否', s.method !== '排放係數法' ? s.method : ''];
  });
  return { state: rows.length ? 'measured' : 'missing', text: rows.length ? '' : '沒有已計算的排放源。',
    tables: [T('表三 排放源鑑別', '表三', ['製程編號', '製程代碼', '製程名稱', '設備編號', '設備代碼', '設備名稱', '原燃物料或產品類別', '原燃物料或產品代碼', '原燃物料或產品名稱',
      '是否屬生質能源', '範疇別', '排放型式', '製程/逸散/外購電力類別', 'CO2', 'CH4', 'N2O', 'HFCs', 'PFCs', 'SF6', 'NF3', '是否屬汽電共生設備', '備註*'], rows)] };
}

// ── 表四 活動數據 ──
function t4(L, ctx) {
  const rows = numbered(ctx.results).map((s) => [s.procNo, s.proc[0], s.proc[1], s.equipNo, s.equip[0], s.equipName, s.mat[0], s.mat[1], s.biogenic ? '是' : '否', SCOPE_LABEL[s.scope], s.type,
    s.category || '', s.scope === 2 ? s.supplier : '', r(s.ad, 4), s.alloc === null ? '' : pct(s.alloc, 5), s.adUnit, '', s.sourceDoc || (s.itemCode === 'WAT-SEPTIC' ? '人事工時與醫務統計' : ''),
    s.dept, s.adKind, s.heat ? s.heat.value : '', s.heat ? s.heat.unit.replace(/^kcal\//, 'Kcal/') : '', '', '', s.biogenic ? `生質比例 ${round(s.biogenicShare * 100, 2)}%` : '']);
  return { state: rows.length ? 'measured' : 'missing', text: '活動數據依表單取至小數點後 4 位；液體燃料以公秉、氣體燃料以千立方公尺、外購電力以千度計。',
    tables: [T('表四 活動數據', '表四', ['製程編號', '製程代碼', '製程名稱', '設備編號', '設備代碼', '設備名稱', '原燃物料或產品代碼', '原燃物料或產品名稱', '是否為生質能源', '範疇別', '排放型式',
      '製程/逸散/外購電力類別', '電力/蒸汽供應商名稱', '活動數據', '活動數據分配比率%*', '活動數據單位', '其他單位名稱', '數據來源表單名稱', '保存單位', '活動數據種類', '燃料熱值數值*',
      '燃料熱值單位*', '含水量(%)*', '含碳量(%)*', '備註*'], rows)] };
}

// ── 表五 定量盤查 ──
function t5(L, ctx) {
  const src = numbered(ctx.results); const total = totalOf(src);
  const gasCols = (g) => (!g ? Array(11).fill('') : [g.cls === 'HFCs' || g.cls === 'PFCs' ? g.cls : g.gas, isDefault(g) ? '預設' : '自訂', isDefault(g) ? g.ef : '', isDefault(g) ? g.efSource : '',
    isDefault(g) ? '' : g.ef, isDefault(g) ? '' : g.efSource, g.efUnit, g.efClass, r(g.t, 4), g.gwp, r(g.tco2e + g.biogenicTco2e, 4)]);
  const rows = src.map((s) => [s.procNo, s.proc[1], s.equipNo, s.equipName, s.mat[0], s.mat[1], s.biogenic ? '是' : '否', SCOPE_LABEL[s.scope], s.type, r(s.ad, 4), s.adUnit,
    ...gasCols(s.gases[0]), ...gasCols(s.gases[1]), ...gasCols(s.gases[2]), r(s.tco2e, 4), s.biogenicTco2e ? r(s.biogenicTco2e, 4) : '', total ? pct(s.tco2e / total) : '']);
  const g = (n) => [`溫室氣體#${n}`, '係數類型', '預設排放係數', '預設係數來源', '自訂排放係數', '自訂係數來源', '係數單位', '係數種類', '排放量（公噸/年）', 'GWP', '排放當量（公噸CO2e/年）'].map((x, i) => (i ? `#${n} ${x}` : x));
  return { state: src.length ? 'measured' : 'missing', text: `排放量＝ROUND(活動數據,4) × ROUND(排放係數,10)，取至小數點後 4 位；排放當量＝排放量 × GWP，取至小數點後 4 位。係數依${editionFor(ctx.year)}；GWP ${ctx.gwpSet}。`,
    tables: [T('表五 定量盤查', '表五', ['製程編號', '製程名稱', '設備編號', '設備名稱', '原燃物料代碼', '原燃物料名稱', '是否屬生質能源', '範疇別', '排放型式', '活動數據', '單位', ...g(1), ...g(2), ...g(3),
      '單一排放源排放當量小計（CO2e公噸/年）', '單一排放源生質燃料之CO2排放當量小計（CO2e公噸/年）', '單一排放源占排放總量比(%)'], rows)] };
}

// ── 表六 數據品質管理 ──
export function dataQualitySummary(results) {
  const src = allSources(results); const total = totalOf(src);
  const rows = src.map((s) => { const share = total ? round(s.tco2e / total, 4) : 0; return { s, share, weighted: round(share * s.dqProduct, 2) }; });
  const avg = round(rows.reduce((t, x) => t + x.weighted, 0), 2);
  const count = [1, 2, 3].map((k) => rows.filter((x) => scoreRange(x.s.dqProduct) === k).length);
  return { rows, avg, count, grade: !rows.length ? '—' : avg < 10 ? '第一級' : avg < 19 ? '第二級' : avg <= 27 ? '第三級' : '—' };
}
function t6(L, ctx) {
  const src = numbered(ctx.results); const dq = dataQualitySummary(ctx.results);
  const byKey = new Map(dq.rows.map((x) => [x.s.key, x]));
  const rows = src.map((s) => { const x = byKey.get(s.key); return [s.procNo, s.proc[0], s.equipNo, s.equip[0], s.mat[0], s.mat[1], s.adKindLevel, AD_TRUST_LABEL[s.adTrust], s.adTrust,
    s.dqOverridden ? '人工指定（標的專屬欄位 dq）' : '', s.dept, SCOPE_LABEL[s.scope], s.type, s.gases[0]?.efClass || '', s.efLevel, s.dqProduct, pct(x?.share ?? 0), String(scoreRange(s.dqProduct)), r(x?.weighted, 2)]; });
  const sum = [['等級', '第一級', '第二級', '第三級'], ['評分範圍', 'X<10分', '10分≦X<19分', '19≦X≦27分'], ['個數', ...dq.count], ['清冊等級總平均分數', r(dq.avg, 2), '清冊級別', dq.grade]];
  return { state: src.length ? 'measured' : 'missing', text: `單一排放源數據誤差等級＝活動數據種類等級 × 活動數據可信等級 × 係數種類等級；清冊總平均分數 ${r(dq.avg, 2)}（${dq.grade}）。等級可在標的專屬欄位 dq 人工指定。`,
    tables: [T('表六 數據品質管理', '表六', ['製程編號', '製程代碼', '設備編號', '設備代碼', '原燃物料代碼', '原燃物料名稱', '活動數據種類等級', '活動數據可信種類（儀器校正誤差等級）', '活動數據可信等級',
      '數據可信度資訊說明*', '負責單位或保存單位', '範疇別', '排放型式', '係數種類', '係數種類等級', '單一排放源數據誤差等級', '單一排放源占排放總量比(%)', '評分區間範圍', '排放量占比加權平均'], rows),
    T('彙整表五 全廠溫室氣體數據等級評分結果', '表六彙整', ['項目', '', '', ''], sum)] };
}

// ── 表七 不確定性量化評估 ──
function t7(L, ctx) {
  const src = numbered(ctx.results); const u = ctx.results?.['ghg.uncertainty_pct'];
  const urows = new Map((u?.trace?.inputs || []).map((x) => [x.sourceKey, x]));
  const cfg = getConfig('ghg.uncertainty') || {};
  const rows = src.map((s) => {
    const x = urows.get(s.key); const gs = [0, 1, 2].map((i) => s.gases[i]);
    const gcols = gs.flatMap((g) => {
      if (!g) return Array(8).fill('');
      const ug = x?.gases?.find((y) => y.gas === g.gas);
      return [g.cls === 'HFCs' || g.cls === 'PFCs' ? g.cls : g.gas, r(g.tco2e, 4), ug?.assessed ? `${ug.factorLowPct}%` : '', ug?.assessed ? `+${ug.factorHighPct}%` : '',
        g.uLow !== null && g.uLow !== undefined ? 'IPCC 2006 建議值（95% 信賴區間）' : ug?.assessed ? '院方設定（ghg.uncertainty）' : '', '', ug?.assessed ? `-${ug.lowPct}%` : '', ug?.assessed ? `+${ug.highPct}%` : ''];
    });
    return [s.procNo, s.equipNo, s.mat[0], s.mat[1], `-${r(s.adUncertaintyPct, 3)}%`, `+${r(s.adUncertaintyPct, 3)}%`, s.sourceDoc || s.adKind, s.dept, ...gcols, x ? `-${x.lowPct}%` : '', x ? `+${x.highPct}%` : ''];
  });
  const g = (n) => ['溫室氣體', '排放當量（噸CO2e/年）', '係數95%信賴區間之下限', '係數95%信賴區間之上限', '係數不確定性資料來源', '排放係數保存單位', '單一溫室氣體不確定性下限', '單一溫室氣體不確定性上限'].map((y) => `#${n} ${y}`);
  const t = u?.trace || {};
  const sum = [['進行不確定性評估之排放量絕對值加總', r(t.assessedTco2e, 3)], ['排放總量絕對值加總', r(t.totalAbsTco2e, 3)], ['進行不確定性評估之排放量占總排放量之比例', t.coveragePct === null || t.coveragePct === undefined ? '' : `${t.coveragePct}%`],
    ['本清冊之總不確定性 95%信賴區間下限', t.lowerPct === undefined ? '' : `-${t.lowerPct}%`], ['本清冊之總不確定性 95%信賴區間上限', t.upperPct === undefined ? '' : `+${t.upperPct}%`]];
  return { state: u?.value === null || u?.value === undefined ? 'missing' : 'measured',
    text: `活動數據不確定性依資料來源推定（連續量測、帳單、人工、推估各有預設值，觀測值有填不確定性時以觀測值為準；標的可用 adUncertaintyPct 指定）；係數不確定性採 IPCC 2006 95% 信賴區間，未提供者用院方設定值（${cfg.confidence || '95%'}）。`,
    tables: [T('表七 不確定性量化評估', '表七', ['製程編號', '設備編號', '原燃物料代碼', '原燃物料名稱', '活動數據95%信賴區間之下限', '活動數據95%信賴區間之上限', '數據來源', '活動數據保存單位',
      ...g(1), ...g(2), ...g(3), '單一排放源不確定性下限', '單一排放源不確定性上限'], rows), T('彙整表六 溫室氣體不確定性量化評估結果', '表七彙整', ['項目', '數值'], sum)] };
}

// ── 表八 溫室氣體排放量彙總 ──
function t8(L, ctx) {
  const src = allSources(ctx.results);
  const byGas = Object.fromEntries(GAS7.map((g) => [g, 0])); const s1Gas = Object.fromEntries(GAS7.map((g) => [g, 0]));
  const type = { '固定 (E)': 0, '製程 (P)': 0, '移動 (T)': 0, '逸散 (F)': 0 }; let s1 = 0; let s2 = 0; let bio = 0;
  for (const s of src) {
    for (const g of s.gases) { byGas[g.cls] = (byGas[g.cls] || 0) + g.tco2e; if (s.scope === 1) { s1Gas[g.cls] = (s1Gas[g.cls] || 0) + g.tco2e; type[s.type] = (type[s.type] || 0) + g.tco2e; } }
    if (s.scope === 1) s1 += s.tco2e; else s2 += s.tco2e; bio += s.biogenicTco2e || 0;
  }
  const total = round(Object.values(byGas).reduce((a, b) => a + b, 0), 3);
  const s1t = Object.values(s1Gas).reduce((a, b) => a + b, 0);
  const share = (v, d) => (d ? pct(v / d) : '');
  // 彙整表一 全廠電力（院內發電：太陽光電等）
  const gen = (q.all(`SELECT af.value, af.unit, a.asset_type FROM approved_facts af JOIN assets a ON a.id = af.asset_id WHERE af.dataset_id = ? AND af.is_current = 1 AND af.metric_code = 'elec_generated_kwh'`, ctx.datasetId || '') || []);
  const pvKwh = gen.reduce((t, f) => t + (f.unit === 'MWh' ? f.value * 1000 : f.value || 0), 0);
  const elec = [[r(pvKwh / 1000, 3), 0, 0, 0, 0, 0, r(pvKwh / 1000, 3), pvKwh ? '太陽光電' : '', 0, 0, '', '']];
  const t2 = [['排放當量（公噸CO2e/年）', ...GAS7.map((g) => r(byGas[g], 4)), r(total, 3), r(bio, 4)], ['氣體別占比（%）', ...GAS7.map((g) => share(byGas[g], total)), total ? '100.00%' : '', '-']];
  const t3 = [['排放當量（公噸CO2e/年）', ...GAS7.map((g) => r(s1Gas[g], 4)), r(s1t, 4)], ['氣體別占比（%）', ...GAS7.map((g) => share(s1Gas[g], s1t)), s1t ? '100.00%' : '']];
  const t4 = [['排放當量（公噸CO2e/年）', r(s1, 4), r(type['固定 (E)'], 4), r(type['製程 (P)'], 4), r(type['移動 (T)'], 4), r(type['逸散 (F)'], 4), r(s2, 4), '', r(s1 + s2, 3)],
    ['占比（%）', share(s1, total), share(type['固定 (E)'], total), share(type['製程 (P)'], total), share(type['移動 (T)'], total), share(type['逸散 (F)'], total), share(s2, total), '-', total ? '100.00%' : '']];
  return { state: src.length ? 'measured' : 'missing',
    text: '依溫室氣體排放量盤查登錄管理辦法，排放總量以公噸CO2e表示並四捨五入至小數點後第三位；生質燃料之 CO₂ 另列，不計入總量。範疇三（類別三～六）見盤查報告書，未列入本表單。',
    tables: [
      T('彙整表一 全廠電力', '表八-1電力', ['全廠電力（仟度）', '全廠火力電力（仟度）', '風力（仟度）', '水力（仟度）', '地熱（仟度）', '潮汐（仟度）', '其他再生能源（仟度）', '其他再生能源備註', '核能發電量（仟度）', '其他發電量（仟度）', '其他發電量備註', '全廠蒸汽產生量（公噸）'], elec),
      T('彙整表二 全廠七大溫室氣體排放量統計表', '表八-2七大氣體', ['項目', ...GAS7, '七種溫室氣體年總排放當量', '生質排放當量'], t2),
      T('彙整表三 範疇一七大溫室氣體排放量統計表', '表八-3範疇一', ['項目', ...GAS7, '範疇一七種溫室氣體年總排放當量'], t3),
      T('彙整表四 全廠溫室氣體範疇別及範疇一排放型式排放量統計表', '表八-4範疇別', ['項目', '範疇1', '範疇1 固定排放', '範疇1 製程排放', '範疇1 移動排放', '範疇1 逸散排放', '範疇2 能源間接排放', '範疇3 其他間接排放', '總排放當量'], t4),
    ] };
}

// ── 表九 全廠電力、蒸汽供需情況（離網電力供應者或蒸汽生產者才需填寫）──
function t9(L, ctx) {
  const rows = q.all(`SELECT af.metric_code, SUM(af.value) v FROM approved_facts af WHERE af.dataset_id = ? AND af.is_current = 1 AND af.metric_code IN ('elec_generated_kwh','elec_self_used_kwh','elec_exported_kwh') GROUP BY af.metric_code`, ctx.datasetId || '');
  const m = Object.fromEntries(rows.map((x) => [x.metric_code, x.v]));
  const has = m.elec_generated_kwh || m.elec_exported_kwh;
  const prod = has ? [['電力（太陽光電）', r((m.elec_generated_kwh || 0) / 1000, 3), '千度', r((m.elec_self_used_kwh ?? ((m.elec_generated_kwh || 0) - (m.elec_exported_kwh || 0))) / 1000, 3), '千度', r((m.elec_exported_kwh || 0) / 1000, 3), '千度']] : [];
  return { state: 'measured', text: has ? '院內發電之產量、自用量、外售量（併網電力供應者毋需填寫外售對象）。' : '本院非離網電力供應者或蒸汽生產者，免填。',
    tables: [T('表九 能源生產一覽表', '表九', ['生產能源類別', '產量', '單位', '自用量', '單位', '外售量', '單位'], prod)] };
}

export const GHG_FORM_BUILDERS = { ghg_t1: t1, ghg_t2: t2, ghg_t3: t3, ghg_t4: t4, ghg_t5: t5, ghg_t6: t6, ghg_t7: t7, ghg_t8: t8, ghg_t9: t9 };
