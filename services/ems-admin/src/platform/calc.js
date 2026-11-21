// M09 排放與營運計算（PRD §13）：只吃資料集裡的採用值＋已發布係數＋已發布規則。
// 每個結果都能「展開計算」：活動數據、係數（代碼／版本／來源）、公式、捨入。
// 缺漏不當 0：沒有資料 → missing；部分標的沒資料 → partial；係數未發布 → blocked。
import { q } from './db.js';
import { factorAt, ruleCurrent, ruleVersion, getConfig, calcSettingsFor } from './config-store.js';
import { j, round, convert } from './util.js';
import { MONTREAL, REFRIGERANT_ALIASES } from './seed/factors.js';

const STATE_RANK = { measured: 0, zero: 0, estimated: 1, partial: 2, missing: 3, not_applicable: 4, blocked: 5 };
const worse = (a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a);

export const DEFAULT_FUEL = { 'OIL-GEN': 'diesel', 'OIL-FORK': 'diesel', 'OIL-VEH': 'gasoline', 'OIL-BOILER': 'fuel_oil', 'GAS-NG': 'ng', 'GAS-LPG': 'lpg' };
export const FUEL_ACTIVITY = { diesel: 'oil_consumption_l', gasoline: 'oil_consumption_l', fuel_oil: 'oil_consumption_l', ng: 'ng_consumption_m3', lpg: 'lpg_consumption_kg' };
export const FUEL_UNIT = { diesel: 'L', gasoline: 'L', fuel_oil: 'L', ng: 'Nm3', lpg: 'kg' };

export function makeContext(datasetId, { pinnedRules = {}, pinnedFactors = {} } = {}) {
  const ds = q.get('SELECT * FROM datasets WHERE id = ?', datasetId);
  if (!ds) throw new Error('dataset not found');
  const facts = q.all(`SELECT af.*, a.name AS asset_name, a.domain, a.attrs, a.applicability, a.asset_type, a.status AS asset_status, i.code AS item_code
    FROM approved_facts af JOIN assets a ON a.id = af.asset_id LEFT JOIN inventory_items i ON i.id = a.item_id WHERE af.dataset_id = ? AND af.is_current = 1`, datasetId)
    .map((f) => ({ ...f, attrs: j(f.attrs, {}) }));
  const assets = q.all(`SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.status <> 'archived'`, ds.org_id)
    .map((a) => ({ ...a, attrs: j(a.attrs, {}) }));
  // 已定版的資料集用定版當下的標的屬性快照
  const snap = new Map(q.all('SELECT * FROM dataset_asset_snapshots WHERE dataset_id = ?', datasetId).map((r) => [r.asset_id, r]));
  if (snap.size) {
    const fix = (a) => { const s = snap.get(a.asset_id || a.id); return s ? { ...a, attrs: j(s.attrs, {}), applicability: s.applicability, asset_type: s.asset_type, item_code: s.item_code ?? a.item_code } : a; };
    for (let i = 0; i < facts.length; i++) facts[i] = fix(facts[i]);
    for (let i = 0; i < assets.length; i++) assets[i] = fix(assets[i]);
  }
  const settings = calcSettingsFor(ds.org_id);
  return { ds, facts, assets, settings, septic: getConfig('calc.septic') || {}, pinnedRules, pinnedFactors, usedFactors: {}, usedRules: {}, cache: new Map(), date: `${ds.year}-07-01` };
}

function factor(cx, code, date = cx.date) {
  const pinned = cx.pinnedFactors[code];
  const f = pinned ? q.get('SELECT * FROM factors WHERE code = ? AND version = ?', code, pinned) : factorAt(code, date);
  if (f) cx.usedFactors[code] = f.version;
  return f;
}
const fRef = (f) => ({ code: f.code, version: f.version, value: f.value, unit: f.unit, source: f.source, validFrom: f.valid_from, validTo: f.valid_to });

function rule(cx, code) {
  const r = cx.pinnedRules[code] ? ruleVersion(code, cx.pinnedRules[code]) : ruleCurrent(code);
  if (r) cx.usedRules[code] = r.version;
  return r;
}

function factsFor(cx, { items, metrics, fuel }) {
  return cx.facts.filter((f) => (!items || items.includes(f.item_code)) && (!metrics || metrics.includes(f.metric_code))
    && (!fuel || (f.attrs.fuel || DEFAULT_FUEL[f.item_code]) === fuel));
}
function assetsFor(cx, items) { return cx.assets.filter((a) => items.includes(a.item_code)); }
const inp = (f, extra = {}) => ({ factId: f.id, assetId: f.asset_id, asset: f.asset_name, metric: f.metric_code, period: [f.period_start, f.period_end], value: f.value, unit: f.unit, state: f.value_state, ...extra });

function precisionFor(cx, unit) { const p = cx.settings.precision || {}; return p[unit] ?? (unit === 'tCO2e' ? 4 : 3); }

function result(cx, unit, value, state, trace) {
  const v = value === null || value === undefined || ['missing', 'not_applicable', 'blocked'].includes(state) ? null : round(value, precisionFor(cx, unit));
  return { value: v, unit, value_state: state, trace: { ...trace, rounding: `${precisionFor(cx, unit)} 位小數` } };
}

// 沒有任何事實時判斷是「不適用」還是「缺漏」
function emptyState(cx, items) {
  const as = assetsFor(cx, items);
  if (!as.length) return 'not_applicable';
  if (as.every((a) => a.applicability === 'not_applicable')) return 'not_applicable';
  return 'missing';
}

// ── 組織型盤查表單（盤查表單 3.0.0）逐排放源計算 ──
// GWP 版本依盤查年度：111 年度以前用 6.0.4 版（AR4），112 年度起用 113 年公告（AR5）；設定 AR6 時改用 AR6（ISO 揭露比較）
export function gwpSetFor(cx) {
  const s = cx.settings.gwpSet;
  if (s === 'AR6' || s === 'AR4') return s;
  return cx.ds.year >= 2023 ? 'AR5' : 'AR4';
}
export const editionFor = (year) => (year >= 2023 ? '環境部 113 年 2 月 5 日公告「溫室氣體排放係數」' : '溫室氣體排放係數管理表 6.0.4 版');
// 與 Excel ROUND 相同：先取 15 位有效數字（Excel 的精度），以十進位字串捨入，正負數皆「四捨五入、遠離零」
export function xround(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v;
  const [m, e] = Math.abs(v).toExponential(14).split('e');
  const r = Number(`${Math.round(Number(`${m}e${Number(e) + d}`))}e-${d}`);
  return v < 0 ? -r : r;
}
const FORM_UNIT = { L: '公秉', Nm3: '千立方公尺', m3: '千立方公尺', kg: '公噸' };
export const MATERIAL_NAME = { diesel: '柴油', gasoline: '車用汽油', fuel_oil: '燃料油', lpg: '液化石油氣', ng: '天然氣', electricity: '外購電力', steam: '外購蒸汽', septic: '水肥（化糞池）', SF6: '六氟化硫', N2O: '氧化亞氮', CO2: '二氧化碳' };
const UKIND = { 'ghg.s1.stationary': 'combustion', 'ghg.s1.mobile': 'combustion', 'ghg.s1.refrigerant': 'refrigerant', 'ghg.s1.insulating': 'insulating',
  'ghg.s1.process': 'process', 'ghg.s1.septic': 'septic', 'ghg.s2.electricity': 'electricity', 'ghg.s2.imported_heat': 'imported_heat' };
const unitDen = (u) => String(u || '').split('/')[1] || null;
function latestPublished(cx, code) {
  const f = q.get("SELECT * FROM factors WHERE code = ? AND status = 'published' ORDER BY valid_from DESC, version DESC LIMIT 1", code);
  if (f) cx.usedFactors[code] = f.version;
  return f;
}
const pushRef = (list, f) => { if (f && f.code !== 'gwp.CO2' && !list.some((x) => x.code === f.code)) list.push(fRef(f)); };
function sumConverted(facts, unit) {
  let s = 0;
  for (const f of facts) { const c = convert(f.value, f.unit, unit); if (!c.ok) { if (f.unit !== unit) return null; s += f.value; continue; } s += c.value; }
  return s;
}
// 表六：活動數據種類等級（連續量測 1；定期(間歇)量測 2；財務會計推估、自行評估 3）
export const AD_KIND_LEVEL = { 連續量測: 1, '定期(間歇)量測': 2, 財務會計推估: 3, 自行評估: 3 };
const AD_KIND_BY_DQ = { 1: '連續量測', 2: '定期(間歇)量測', 3: '自行評估' };
// 表六：係數種類等級（1、2→1；3、4→2；5、6→3）
export const efLevel = (cls) => { const n = Number(String(cls || '5').slice(0, 1)); return n <= 2 ? 1 : n <= 4 ? 2 : 3; };
export const scoreRange = (p) => (p < 10 ? 1 : p < 19 ? 2 : 3);
export const AD_TRUST_LABEL = { 1: '(1)有進行外部校正或有多組數據茲佐證者', 2: '(2)有進行內部校正或經過會計簽證等証明者', 3: '(3)未進行儀器校正或未進行紀錄彙整者' };

function adQuality(cx, assetAttrs, facts, forcedKind) {
  const dq = assetAttrs.dq || {};
  const obs = facts.flatMap((f) => j(f.observation_ids, [])).map((id) => q.get('SELECT o.method, s.source_type FROM observations o LEFT JOIN data_sources s ON s.id = o.source_id WHERE o.id = ?', id)).filter(Boolean);
  const estimated = facts.some((f) => f.value_state === 'estimated');
  const derived = facts.some((f) => f.decision_id && q.get("SELECT 1 FROM decisions WHERE id = ? AND decision_type = 'derived'", f.decision_id));
  const kind = AD_KIND_BY_DQ[dq.activityType] || forcedKind || (estimated ? '自行評估' : derived ? '財務會計推估' : obs.some((o) => o.method === 'api') ? '連續量測' : '定期(間歇)量測');
  const trust = Number(dq.activityTrust) || (estimated || forcedKind === '自行評估' ? 3 : obs.some((o) => o.source_type === 'bill') ? 1 : assetAttrs.calibrated ? 2 : 3);
  // 活動數據不確定性：各期獨立合成 √Σ(u·v)² ÷ Σv；標的可用 adUncertaintyPct 人工指定
  let u = Number(assetAttrs.adUncertaintyPct);
  if (!Number.isFinite(u) || u <= 0) {
    const cfg = getConfig('ghg.uncertainty') || {};
    if (!facts.length) u = cfg.activityEstimated ?? 20;
    else { let s2 = 0; let sv = 0; for (const f of facts) { const v = Math.abs(f.value || 0); s2 += (activityUncertainty(f.id, cfg) * v) ** 2; sv += v; } u = sv ? Math.sqrt(s2) / sv : (cfg.activityEstimated ?? 20); }
  }
  return { adKind: kind, adKindLevel: AD_KIND_LEVEL[kind] || 3, adTrust: trust, adTrustLabel: AD_TRUST_LABEL[trust], adUncertaintyPct: u, dqOverridden: !!(dq.activityType || dq.activityTrust || dq.factorType) };
}

// 一個排放源（表三～表五的一列）。捨入照表五：活動數據 4 位、係數 10 位、分配比率 6 位、各氣體排放量 4 位、排放當量 4 位
function makeSource(cx, o) {
  const assetAttrs = cx.assets.find((a) => a.id === o.assetId)?.attrs || o.facts?.[0]?.attrs || {};
  const ad = xround(o.ad, 4);
  const alloc = o.alloc === undefined || o.alloc === null || o.alloc === '' || !Number.isFinite(Number(o.alloc)) ? null : xround(Number(o.alloc) / 100, 6);
  const share = o.biogenicShare || 0;
  let bio = 0;
  const gases = o.gases.map((g) => {
    const ef = xround(g.ef, 10);
    const t = xround(ad * ef * (alloc === null ? 1 : alloc), 4);
    const gross = xround(t * g.gwp.value, 4);
    const b = g.gas === 'CO2' && share > 0 ? xround(gross * share, 4) : 0; bio += b;
    const f0 = g.ef0;
    return { gas: g.gas, cls: g.cls || gasClass(g.gas) || g.gas, ef, efUnit: g.efUnit || `公噸/${o.adUnit}`, efCode: f0?.code || null, efVersion: f0?.version ?? null,
      efSource: g.efSource || f0?.source || '', efClass: g.efClass || f0?.factor_class || '5國家排放係數',
      uLow: f0 ? f0.uncertainty_low ?? null : g.uLow ?? null, uHigh: f0 ? f0.uncertainty_high ?? null : g.uHigh ?? null,
      t, gwp: g.gwp.value, gwpCode: g.gwp.code, gwpVersion: g.gwp.version, grossTco2e: gross, biogenicTco2e: b, tco2e: xround(gross - b, 4) };
  });
  const tco2e = xround(gases.reduce((s, g) => s + g.tco2e, 0), 4);
  const dq = adQuality(cx, assetAttrs, o.facts || [], o.adKind);
  // 表六：單一排放源的係數等級取各氣體中最差者（同一排放源係數來源應相同）
  const efLv = Number(assetAttrs.dq?.factorType) || Math.max(...gases.map((g) => efLevel(g.efClass)));
  const product = dq.adKindLevel * dq.adTrust * efLv;
  return {
    key: `${o.assetId}|${o.material}|${o.type}|${o.facts?.[0]?.period_start?.slice(0, 4) || cx.ds.year}`, assetId: o.assetId, asset: o.asset, itemCode: o.itemCode,
    scope: o.scope, type: o.type, category: o.category || '', material: o.material, materialName: MATERIAL_NAME[o.material] || o.material,
    biogenic: share > 0, biogenicShare: share, ad, adUnit: o.adUnit, alloc, heat: o.heat || null, supplier: o.supplier || '', method: o.method || '排放係數法',
    factIds: (o.facts || []).map((f) => f.id), gases, tco2e, biogenicTco2e: xround(bio, 4),
    ...dq, efLevel: efLv, dqProduct: product, dqRange: scoreRange(product),
  };
}

function sourceResult(cx, def, sources, state, trace) {
  const total = sources.reduce((s, x) => s + x.tco2e, 0);
  // 展開計算用：排放源排放量依各期活動數據比例分攤到每筆採用值（僅供檢視；正式數字以排放源為準）
  for (const src of sources) {
    const ins = (trace.inputs || []).filter((i) => i.factId && !i.excluded && src.factIds.includes(i.factId));
    const tot = ins.reduce((t, i) => t + Math.abs(i.value || 0), 0);
    for (const i of ins) i.kgCO2e = tot ? round(src.tco2e * 1000 * Math.abs(i.value || 0) / tot, 3) : 0;
  }
  return result(cx, def.unit, total, state, { ...trace, sources, edition: editionFor(cx.ds.year), gwpSet: gwpSetFor(cx) });
}

function massBalance(cx, def, facts, gwpSet, gasOf, formula) {
  const inputs = []; const factors = []; const notes = []; let state = 'measured'; const groups = new Map();
  for (const f of facts) {
    if (['missing', 'unknown'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
    if (f.value_state === 'not_applicable') continue;
    const gas = gasOf(f); const k = `${f.asset_id}|${gas}`;
    if (!groups.has(k)) groups.set(k, { gas, facts: [] }); groups.get(k).facts.push(f);
  }
  const sources = [];
  for (const { gas, facts: fs } of groups.values()) {
    const gwp = factor(cx, `gwp.${gwpSet}.${gas}`);
    if (!gwp) return result(cx, def.unit, null, 'blocked', { formula: '', inputs, notes: [`缺 ${gas} GWP（${gwpSet}）`] });
    pushRef(factors, gwp);
    const kg = sumConverted(fs, 'kg');
    sources.push(makeSource(cx, { assetId: fs[0].asset_id, asset: fs[0].asset_name, itemCode: fs[0].item_code, scope: 1, type: '逸散 (F)', category: '其他', material: gas, ad: kg / 1000, adUnit: '公噸', facts: fs,
      method: '質量平衡法', gases: [{ gas, ef: 1, efClass: '1自廠發展係數/質量平衡所得係數', efSource: '質量平衡（使用量／補充量即排放量）', efUnit: '公噸/公噸', gwp }] }));
    for (const f of fs) { inputs.push(inp(f, { gas })); if (f.value_state === 'estimated') state = worse(state, 'estimated'); }
  }
  if (!sources.length) return result(cx, def.unit, null, state === 'measured' ? 'missing' : state, { formula, inputs, factors, notes });
  return sourceResult(cx, def, sources, state, { formula, inputs, factors, notes });
}

// 所有排放源（表三～表八共用）
export function allSources(results) {
  const out = [];
  for (const code of Object.keys(UKIND)) {
    const r = results?.[code];
    if (!r || r.value === null || r.value === undefined) continue; // 無法計算（blocked）或缺漏的指標不列部分排放源，避免表單與總量對不上
    for (const s of r.trace?.sources || []) out.push({ ...s, indicator: code });
  }
  return out;
}

const KINDS = {
  sum(cx, def) {
    const facts = factsFor(cx, def);
    if (!facts.length) {
      // 依油種彙總（柴油、汽油、燃料油）：院內沒有使用該油種的標的 → 不適用，不是缺漏
      if (def.fuel && !def.items) {
        const users = cx.assets.filter((a) => a.applicability !== 'not_applicable' && FUEL_ACTIVITY[a.attrs.fuel || DEFAULT_FUEL[a.item_code]] && (a.attrs.fuel || DEFAULT_FUEL[a.item_code]) === def.fuel);
        return result(cx, def.unit, null, users.length ? 'missing' : 'not_applicable', { formula: '查無採用值', inputs: [], notes: users.length ? [] : ['院內沒有使用此油種的標的'] });
      }
      return result(cx, def.unit, null, def.items ? emptyState(cx, def.items) : 'missing', { formula: '查無採用值', inputs: [] });
    }
    let state = 'measured'; let total = 0; const inputs = [];
    let use = facts;
    if (def.agg === 'latest_per_asset') {
      const by = new Map();
      for (const f of facts) { const k = `${f.asset_id}|${f.metric_code}`; if (!by.has(k) || by.get(k).period_end < f.period_end) by.set(k, f); }
      use = [...by.values()];
    }
    const vals = [];
    for (const f of use) {
      if (['missing', 'not_applicable', 'unknown', 'pending_period_end'].includes(f.value_state)) { state = worse(state, f.value_state === 'not_applicable' ? 'measured' : 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      const c = convert(f.value, f.unit, def.unit);
      const v = c.ok ? c.value : f.value;
      vals.push(v); inputs.push(inp(f, { converted: c.ok && c.factor !== 1 ? { factor: c.factor, to: def.unit } : undefined }));
      if (f.value_state === 'estimated') state = worse(state, 'estimated');
    }
    if (!vals.length) return result(cx, def.unit, null, state === 'measured' ? 'missing' : state, { formula: '採用值皆為缺漏／不適用', inputs });
    total = def.agg === 'max' ? Math.max(...vals) : vals.reduce((s, v) => s + v, 0);
    return result(cx, def.unit, total, state, { formula: def.agg === 'max' ? '最大值' : def.agg === 'latest_per_asset' ? '各標的最新一期加總' : 'Σ 採用值', inputs });
  },

  combustion(cx, def) {
    const gwpSet = gwpSetFor(cx); const sources = []; const inputs = []; const factors = []; const notes = []; let state = 'measured';
    const groups = new Map();
    for (const f of cx.facts.filter((x) => def.items.includes(x.item_code))) {
      const fuel = f.attrs.fuel || DEFAULT_FUEL[f.item_code];
      if (FUEL_ACTIVITY[fuel] !== f.metric_code) continue;
      if (['missing', 'unknown', 'pending_period_end'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      if (f.value_state === 'not_applicable') continue;
      const k = `${f.asset_id}|${fuel}`;
      if (!groups.has(k)) groups.set(k, { fuel, facts: [] });
      groups.get(k).facts.push(f);
    }
    for (const { fuel, facts } of groups.values()) {
      const a0 = facts[0];
      // 熱值：盤查用（ghg.heat）優先；單位對不上活動數據時改用能源署熱值（heat）並註明
      let heat = factor(cx, `ghg.heat.${fuel}`); let small = heat ? unitDen(heat.unit) : null;
      let adSmall = small ? sumConverted(facts, small) : null;
      if (heat && adSmall === null) {
        const alt = factor(cx, `heat.${fuel}`) || latestPublished(cx, `heat.${fuel}`); const altSmall = alt ? unitDen(alt.unit) : null; const v = altSmall ? sumConverted(facts, altSmall) : null;
        if (v !== null) { notes.push(`${a0.asset_name}：盤查用熱值單位（${heat.unit}）與活動數據單位不同，改用能源署熱值 ${alt.value} ${alt.unit}`); heat = alt; small = altSmall; adSmall = v; state = worse(state, 'estimated'); }
      }
      if (!heat) { state = 'blocked'; notes.push(`缺已發布熱值 ghg.heat.${fuel}`); continue; }
      if (adSmall === null) { state = 'blocked'; notes.push(`${a0.asset_name}：活動數據單位無法換算為 ${small}`); continue; }
      pushRef(factors, heat);
      const gases = [];
      for (const gas of ['CO2', 'CH4', 'N2O']) {
        const ef = factor(cx, `ef.${fuel}.${def.mode}.${gas}`) || (def.mode === 'mobile' ? factor(cx, `ef.${fuel}.stationary.${gas}`) : null);
        const gwp = factor(cx, `gwp.${gwpSet}.${gas}`);
        if (!ef || !gwp) { state = 'blocked'; notes.push(`缺已發布係數：${!ef ? `ef.${fuel}.${def.mode}.${gas}` : `gwp.${gwpSet}.${gas}`}`); continue; }
        pushRef(factors, ef); pushRef(factors, gwp);
        // kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值 ＝ 公斤/單位 ＝ 公噸/千單位（表單活動數據單位：公秉、千立方公尺、公噸）
        const perUnit = /\/TJ$/i.test(ef.unit) ? ef.value * 4186.8e-12 * heat.value : ef.value;
        gases.push({ gas, ef: perUnit, ef0: ef, gwp });
      }
      if (!gases.length) continue;
      const share = Math.min(1, Math.max(0, Number(a0.attrs.biogenicShare) || 0));
      const s = makeSource(cx, {
        assetId: a0.asset_id, asset: a0.asset_name, itemCode: a0.item_code, scope: 1, type: def.mode === 'mobile' ? '移動 (T)' : '固定 (E)', material: fuel,
        ad: adSmall / 1000, adUnit: FORM_UNIT[small] || small, biogenicShare: share, alloc: a0.attrs.allocationPct, facts, gases,
        heat: { value: heat.value, unit: heat.unit, code: heat.code, version: heat.version }, factorCodes: [heat.code],
      });
      sources.push(s);
      for (const f of facts) { inputs.push(inp(f, { fuel, sourceKey: s.key })); if (f.value_state === 'estimated') state = worse(state, 'estimated'); }
    }
    const covered = new Set([...sources.map((s) => s.assetId), ...[...groups.values()].map((g) => g.facts[0].asset_id)]);
    const as = assetsFor(cx, def.items).filter((a) => a.applicability !== 'not_applicable');
    // 共用油槽：同槽任一設備（或油槽本身）已有消耗採用值，其他設備不算缺（不可把同一槽重複算給每台）
    const sharedCovered = (a) => q.all("SELECT parent_id FROM asset_links WHERE child_id = ? AND relation IN ('feeds','supplies') AND valid_to IS NULL", a.id)
      .some((l) => covered.has(l.parent_id) || q.all("SELECT child_id FROM asset_links WHERE parent_id = ? AND relation IN ('feeds','supplies') AND valid_to IS NULL", l.parent_id).some((s) => covered.has(s.child_id)));
    const lacking = as.filter((a) => a.applicability === 'applicable' && !covered.has(a.id) && FUEL_ACTIVITY[a.attrs.fuel || DEFAULT_FUEL[a.item_code]] && !['fuel_tank'].includes(a.asset_type) && !sharedCovered(a));
    if (lacking.length) { state = worse(state, sources.length ? 'partial' : 'missing'); notes.push(`缺活動數據：${lacking.map((a) => a.name).join('、')}`); }
    if (!sources.length && !lacking.length) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : emptyState(cx, def.items), { formula: '查無燃料消耗採用值', inputs, factors, notes });
    if (!sources.length) return result(cx, def.unit, null, state, { formula: '', inputs, factors, notes });
    return sourceResult(cx, def, sources, state, { formula: `每個排放源：ROUND(活動數據,4) × ROUND(排放係數,10) → 各氣體排放量取 4 位 × GWP(${gwpSet}) 取 4 位；排放係數＝kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值`, inputs, factors, notes });
  },

  electricity_emission(cx, def) {
    const facts = factsFor(cx, { items: def.items, metrics: [def.metric] });
    if (!facts.length) return result(cx, def.unit, null, emptyState(cx, def.items), { formula: '查無外購電力採用值', inputs: [] });
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; const sources = [];
    const groups = new Map();
    for (const f of facts) {
      if (['missing', 'unknown'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      if (f.value_state === 'not_applicable') continue;
      const y = Number(f.period_start.slice(0, 4));
      const k = `${f.asset_id}|${y}`; if (!groups.has(k)) groups.set(k, { y, facts: [] }); groups.get(k).facts.push(f);
    }
    for (const { y, facts: fs } of groups.values()) {
      let ef = cx.pinnedFactors[`ef.electricity.${y}`] ? factor(cx, `ef.electricity.${y}`) : factor(cx, `ef.electricity.${y}`, `${y}-06-30`);
      if (!ef) {
        // 當年度係數尚未公告：明示採用最近一年已發布值並標為估計
        const latest = q.get("SELECT * FROM factors WHERE code LIKE 'ef.electricity.%' AND status = 'published' AND valid_from <= ? ORDER BY valid_from DESC, version DESC LIMIT 1", `${y}-12-31`);
        if (!latest) { state = 'blocked'; if (!notes.includes(`${y} 年電力排放係數未發布`)) notes.push(`${y} 年電力排放係數未發布`); continue; }
        ef = latest; cx.usedFactors[latest.code] = latest.version; state = worse(state, 'estimated');
        if (!notes.includes(`${y} 年電力排放係數尚未公告，暫用 ${latest.name}`)) notes.push(`${y} 年電力排放係數尚未公告，暫用 ${latest.name}`);
      }
      pushRef(factors, ef);
      const kwh = sumConverted(fs, 'kWh');
      if (kwh === null) { state = 'blocked'; notes.push(`${fs[0].asset_name}：用電量單位無法換算為度`); continue; }
      const s = makeSource(cx, { assetId: fs[0].asset_id, asset: fs[0].asset_name, itemCode: fs[0].item_code, scope: 2, type: '外購電力', category: '併網', material: 'electricity',
        ad: kwh / 1000, adUnit: '千度', alloc: fs[0].attrs.allocationPct, facts: fs, supplier: fs[0].attrs.supplier || '台灣電力公司',
        gases: [{ gas: 'CO2', ef: ef.value, ef0: ef, gwp: { value: 1, code: 'gwp.CO2', version: 0 } }] });
      sources.push(s);
      for (const f of fs) { inputs.push(inp(f, { factor: ef.code, sourceKey: s.key })); if (f.value_state === 'estimated') state = worse(state, 'estimated'); }
    }
    if (!sources.length) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : 'missing', { formula: '外購電力 × 電力排放係數', inputs, factors, notes });
    return sourceResult(cx, def, sources, state, { formula: '每個電號：ROUND(用電量(千度),4) × 當年度電力排放係數(公噸CO₂e/千度) 取 4 位', inputs, factors, notes,
      note: '市場基礎法（再生能源憑證）另依憑證條件處理，本指標為地點基礎' });
  },

  refrigerant(cx, def) {
    const gwpSet = gwpSetFor(cx);
    const method = cx.settings.refrigerantMethod || 'recharge';
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; const sources = [];
    const as = assetsFor(cx, def.items).filter((a) => a.applicability !== 'not_applicable' && a.status !== 'archived');
    for (const a of as) {
      let gas = a.attrs.refrigerant || a.attrs.agent;
      if (!gas) { if (a.item_code === 'GAS-FIRE' && /乾粉|ABC|BC|KBC/i.test(a.attrs.type || '')) continue; notes.push(`${a.name} 未填冷媒／藥劑種類`); state = worse(state, 'partial'); continue; }
      gas = REFRIGERANT_ALIASES[gas] || gas;
      if (MONTREAL.includes(gas)) { notes.push(`${a.name}：${gas} 屬蒙特婁議定書管制物質，不計入`); continue; }
      const rechargeAll = cx.facts.filter((f) => f.asset_id === a.id && ['ref_recharge_kg', 'fire_ext_refill_kg'].includes(f.metric_code));
      const recharge = rechargeAll.filter((f) => !['missing', 'unknown', 'not_applicable'].includes(f.value_state));
      for (const f of rechargeAll) if (!recharge.includes(f)) { inputs.push(inp(f, { excluded: true })); if (f.value_state !== 'not_applicable') state = worse(state, 'partial'); }
      const gwp = gas === 'CO2' ? { code: 'gwp.CO2', version: 0, value: 1, unit: 'kgCO2e/kg', source: '定義' } : factor(cx, `gwp.${gwpSet}.${gas}`);
      if (!gwp) { state = 'blocked'; notes.push(`缺 ${gas} 的已發布 GWP（${gwpSet}）`); continue; }
      if (gwp.code !== 'gwp.CO2') pushRef(factors, gwp);
      const cls = gasClass(gas) || 'HFCs';
      if (recharge.length) {
        const kg = sumConverted(recharge, 'kg');
        sources.push(makeSource(cx, { assetId: a.id, asset: a.name, itemCode: a.item_code, scope: 1, type: '逸散 (F)', category: a.item_code === 'GAS-FIRE' ? '其他' : '溶劑、噴霧劑及冷媒排放源',
          material: gas, ad: kg / 1000, adUnit: '公噸', facts: recharge, method: '質量平衡法（補充量）',
          gases: [{ gas, cls, ef: 1, efClass: '1自廠發展係數/質量平衡所得係數', efSource: '質量平衡（補充量即逸散量）', efUnit: '公噸/公噸', gwp }] }));
        for (const f of recharge) { inputs.push(inp(f, { gas })); if (f.value_state === 'estimated') state = worse(state, 'estimated'); }
      } else if (method === 'screening' && a.attrs.leakRatePct) {
        const plate = cx.facts.find((f) => f.asset_id === a.id && ['ref_charge_kg', 'fire_ext_charge_kg'].includes(f.metric_code));
        if (!plate) { notes.push(`${a.name}：無補充紀錄也無充填量`); state = worse(state, 'partial'); continue; }
        const kg = sumConverted([plate], 'kg');
        sources.push(makeSource(cx, { assetId: a.id, asset: a.name, itemCode: a.item_code, scope: 1, type: '逸散 (F)', category: '溶劑、噴霧劑及冷媒排放源', material: gas, ad: kg / 1000, adUnit: '公噸', facts: [plate],
          method: `充填量 × 年逸散率 ${a.attrs.leakRatePct}%（核准的推估方法）`, gases: [{ gas, cls, ef: a.attrs.leakRatePct / 100, efClass: '6國際排放係數', efSource: 'IPCC 2006 Vol.3 Ch.7 Table 7.9（設備逸散率）', efUnit: '公噸/公噸', gwp }] }));
        inputs.push(inp(plate, { gas })); state = worse(state, 'estimated');
      } else {
        notes.push(`${a.name}：逸散量所需活動資料不足（有設備資訊但無補充／回收紀錄；銘牌充填量不等於逸散量）`);
        state = worse(state, sources.length ? 'partial' : 'missing');
      }
    }
    if (!sources.length) return result(cx, def.unit, null, as.length ? (state === 'blocked' ? 'blocked' : state === 'measured' ? 'not_applicable' : 'missing') : 'not_applicable', { formula: 'Σ 補充量 × GWP', inputs, factors, notes });
    return sourceResult(cx, def, sources, state, { formula: `每個排放源：ROUND(補充量(公噸),4) × 1（質量平衡）取 4 位 × GWP(${gwpSet}) 取 4 位`, inputs, factors, notes, gwpSet, method });
  },

  insulating(cx, def) {
    const gwpSet = gwpSetFor(cx);
    const facts = factsFor(cx, { items: def.items, metrics: ['insul_gas_recharge_kg'] });
    if (!facts.length) return result(cx, def.unit, null, emptyState(cx, def.items), { formula: '查無絕緣氣體補充採用值', inputs: [] });
    return massBalance(cx, def, facts, gwpSet, (f) => f.attrs.gas || 'SF6', '每個排放源：ROUND(補充量(公噸),4) 取 4 位 × GWP 取 4 位');
  },

  process_gas(cx, def) {
    const gwpSet = gwpSetFor(cx);
    const facts = factsFor(cx, { items: def.items, metrics: ['n2o_use_kg', 'co2_use_kg'] });
    if (!facts.length) {
      const purchases = factsFor(cx, { items: def.items, metrics: ['n2o_purchase_kg', 'co2_purchase_kg'] });
      return result(cx, def.unit, null, purchases.length ? 'missing' : emptyState(cx, def.items), { formula: '查無使用量', inputs: [],
        notes: purchases.length ? ['只有採購量；不得假定全部採購量都是排放量，請提供使用量或核准的推估方法'] : [] });
    }
    return massBalance(cx, def, facts, gwpSet, (f) => (f.metric_code === 'n2o_use_kg' ? 'N2O' : 'CO2'), '每個排放源：ROUND(使用量(公噸),4) 取 4 位 × GWP 取 4 位（氧氣非溫室氣體，不計）');
  },

  septic(cx, def) {
    const as = assetsFor(cx, def.items);
    if (!as.length || as.every((a) => a.applicability === 'not_applicable')) return result(cx, def.unit, null, 'not_applicable', { formula: '', inputs: [], notes: ['無化糞池或已接管公共污水下水道'] });
    if (as.some((a) => a.applicability !== 'applicable')) return result(cx, def.unit, null, 'missing', { formula: '', inputs: [], notes: ['化糞池適用性尚未判定（是否接管）'] });
    const hours = compute(cx, 'act.staff_hours'); const visits = compute(cx, 'act.outpatient'); const inpatient = compute(cx, 'act.inpatient_days');
    if (hours.value === null) return result(cx, def.unit, null, 'missing', { formula: '', inputs: [], notes: ['缺員工工時'] });
    const gwpSet = gwpSetFor(cx);
    const ef = factor(cx, 'septic.ef_person_hour'); const gwp = factor(cx, `gwp.${gwpSet}.CH4`);
    if (!ef || !gwp) return result(cx, def.unit, null, 'blocked', { formula: '', inputs: [], notes: [`化糞池係數（septic.ef_person_hour）或 CH₄ GWP（${gwpSet}）未發布`] });
    const visitH = cx.septic.visitHours ?? 2;
    const personHours = hours.value + (visits.value || 0) * visitH + (inpatient.value || 0) * 24;
    const a = as.find((x) => x.applicability === 'applicable');
    const s = makeSource(cx, { assetId: a.id, asset: a.name, itemCode: a.item_code, scope: 1, type: '逸散 (F)', category: '廢水排放源', material: 'septic', ad: personHours, adUnit: '人時',
      facts: [], adKind: '自行評估', gases: [{ gas: 'CH4', ef: ef.value, ef0: ef, efUnit: '公噸/人時', gwp }] });
    const r = sourceResult(cx, def, [s], 'estimated', {
      formula: `人時 ＝ 員工工時 ＋ 門急診人次 × ${visitH} ＋ 住院人日 × 24；ROUND(人時,4) × 化糞池係數(公噸CH₄/人時) 取 4 位 × GWP(${gwpSet}) 取 4 位`,
      inputs: [{ indicator: 'act.staff_hours', value: hours.value }, { indicator: 'act.outpatient', value: visits.value }, { indicator: 'act.inpatient_days', value: inpatient.value }],
      factors: [ef, gwp].map(fRef), notes: [cx.septic.note || ''].filter(Boolean) });
    r.trace.personHours = round(personHours, 2); r.trace.personDays = round(personHours / 24, 2);
    return r;
  },

  add(cx, def) {
    const parts = def.of.map((c) => ({ code: c, r: compute(cx, c) }));
    let state = 'measured'; let total = 0; let any = false; const notes = [];
    for (const p of parts) {
      if (p.r.value_state === 'not_applicable') continue;
      if (p.r.value === null) { state = worse(state, p.r.value_state === 'blocked' ? 'blocked' : 'partial'); notes.push(`${p.code}：${p.r.value_state}`); continue; }
      total += p.r.value; any = true; state = worse(state, p.r.value_state);
    }
    if (!any) return result(cx, def.unit, null, state === 'measured' ? 'not_applicable' : state === 'partial' ? 'missing' : state, { formula: def.of.join(' ＋ '), inputs: parts.map((p) => ({ indicator: p.code, value: p.r.value, state: p.r.value_state })), notes });
    return result(cx, def.unit, total, state, { formula: def.of.join(' ＋ '), inputs: parts.map((p) => ({ indicator: p.code, value: p.r.value, state: p.r.value_state })), notes });
  },

  ratio(cx, def) {
    const n = compute(cx, def.num); const d = compute(cx, def.den);
    const inputs = [{ indicator: def.num, value: n.value, state: n.value_state }, { indicator: def.den, value: d.value, state: d.value_state }];
    if (n.value === null || d.value === null) return result(cx, def.unit, null, n.value === null ? (n.value_state === 'not_applicable' ? 'not_applicable' : 'missing') : 'missing', { formula: `${def.num} ÷ ${def.den}`, inputs, notes: d.value === null ? ['分母缺漏（分母須有獨立來源與期間）'] : [] });
    if (!d.value) return result(cx, def.unit, null, 'missing', { formula: `${def.num} ÷ ${def.den}`, inputs, notes: ['分母為 0'] });
    return result(cx, def.unit, n.value / d.value * (def.scale || 1), worse(n.value_state, d.value_state), { formula: `${def.num} ÷ ${def.den}${def.scale && def.scale !== 1 ? ` × ${def.scale}` : ''}`, inputs });
  },

  energy_total(cx, def) {
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; let kcal = 0; let any = false;
    const elec = compute(cx, 'energy.elec_kwh');
    if (elec.value !== null) { kcal += elec.value * 860; any = true; state = worse(state, elec.value_state); inputs.push({ indicator: 'energy.elec_kwh', value: elec.value, unit: 'kWh', kcalPerUnit: 860 }); }
    else if (elec.value_state !== 'not_applicable') { state = worse(state, 'partial'); notes.push('外購電力缺漏'); }
    for (const [code, fuel] of [['energy.diesel_l', 'diesel'], ['energy.gasoline_l', 'gasoline'], ['energy.fuel_oil_l', 'fuel_oil'], ['energy.ng_m3', 'ng'], ['energy.lpg_kg', 'lpg']]) {
      const r = compute(cx, code);
      if (r.value === null) { if (!['not_applicable', 'missing'].includes(r.value_state)) state = worse(state, 'partial'); continue; }
      const h = factor(cx, `heat.${fuel}`);
      if (!h) { state = 'blocked'; notes.push(`熱值 heat.${fuel} 未發布`); continue; }
      if (!factors.some((x) => x.code === h.code)) factors.push(fRef(h));
      kcal += r.value * h.value; any = true; state = worse(state, r.value_state);
      inputs.push({ indicator: code, value: r.value, unit: FUEL_UNIT[fuel], kcalPerUnit: h.value });
    }
    if (!any) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : 'missing', { formula: '', inputs, factors, notes });
    const value = def.unit === 'toe' ? kcal / 1e7 : kcal * 4.1868e-6;
    return result(cx, def.unit, value, state, { formula: def.unit === 'toe' ? 'Σ 能源量 × 熱值(kcal) ÷ 10⁷' : 'Σ 能源量 × 熱值(kcal) × 4.1868×10⁻⁶ GJ/kcal；電力 860 kcal/kWh', inputs, factors, notes });
  },

  // 單一係數：活動量 × 係數（係數代碼 prefix.年 或 prefix）；外購蒸汽／熱能依供應商係數
  simple_emission(cx, def) {
    const facts = factsFor(cx, { items: def.items, metrics: [def.metric] });
    if (!facts.length) return result(cx, def.unit, null, emptyState(cx, def.items), { formula: '查無採用值', inputs: [] });
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; const sources = [];
    const groups = new Map();
    for (const f of facts) {
      if (['missing', 'unknown'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      if (f.value_state === 'not_applicable') continue;
      const y = f.period_start.slice(0, 4); const k = `${f.asset_id}|${y}`;
      if (!groups.has(k)) groups.set(k, { y, facts: [] }); groups.get(k).facts.push(f);
    }
    for (const { y, facts: fs } of groups.values()) {
      const ef = factor(cx, `${def.factorPrefix}.${y}`, `${y}-06-30`) || factor(cx, def.factorPrefix, `${y}-06-30`);
      if (!ef) { state = 'blocked'; notes.push(`缺已發布係數 ${def.factorPrefix}.${y}（請向供應商取得並在後台新增）`); continue; }
      pushRef(factors, ef);
      const small = unitDen(ef.unit) || fs[0].unit; const v = sumConverted(fs, small);
      if (v === null) { state = 'blocked'; notes.push(`${fs[0].asset_name}：活動數據單位無法換算為 ${small}`); continue; }
      sources.push(makeSource(cx, { assetId: fs[0].asset_id, asset: fs[0].asset_name, itemCode: fs[0].item_code, scope: 2, type: '外購蒸汽', material: 'steam', ad: v, adUnit: small, facts: fs,
        supplier: fs[0].attrs.supplier || '', gases: [{ gas: 'CO2', ef: ef.value / 1000, ef0: ef, efClass: ef.factor_class || '3製造廠提供係數', efUnit: `公噸CO₂e/${small}`, gwp: { value: 1, code: 'gwp.CO2', version: 0 } }] }));
      for (const f of fs) { inputs.push(inp(f, { factor: ef.code })); if (f.value_state === 'estimated') state = worse(state, 'estimated'); }
    }
    if (!sources.length) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : 'missing', { formula: '活動量 × 係數', inputs, factors, notes });
    return sourceResult(cx, def, sources, state, { formula: 'ROUND(活動量,4) × 供應商排放係數 取 4 位', inputs, factors, notes });
  },

  // 依氣體分列（ISO 14064-1 9.3.1 f；盤查表單表八彙整表三）
  gas_split(cx, def) {
    let t = 0; let any = false; let state = 'measured'; const inputs = [];
    for (const code of def.of) {
      const r = compute(cx, code);
      if (r.value === null) { if (!['not_applicable'].includes(r.value_state)) state = worse(state, r.value_state === 'blocked' ? 'blocked' : 'partial'); continue; }
      state = worse(state, r.value_state);
      let part = 0; let hit = false;
      for (const s of r.trace?.sources || []) for (const g of s.gases) if (g.cls === def.gas) { part += g.tco2e; hit = true; }
      if (hit) { t += part; any = true; inputs.push({ indicator: code, tCO2e: round(part, 4) }); }
    }
    if (!any) return result(cx, def.unit, state === 'measured' ? 0 : null, state === 'measured' ? 'zero' : state === 'partial' ? 'partial' : state, { formula: `類別一各排放源中 ${def.gas} 的排放當量加總`, inputs, notes: state === 'measured' ? [`本期沒有 ${def.gas} 排放`] : [] });
    return result(cx, def.unit, t, state, { formula: `類別一各排放源中 ${def.gas} 的排放當量加總`, inputs });
  },

  biogenic(cx, def) {
    let t = 0; const inputs = [];
    for (const code of ['ghg.s1.stationary', 'ghg.s1.mobile']) {
      for (const s of compute(cx, code).trace?.sources || []) if (s.biogenicTco2e) { t += s.biogenicTco2e; inputs.push({ indicator: code, asset: s.asset, tCO2e: s.biogenicTco2e, biogenicShare: s.biogenicShare }); }
    }
    if (!inputs.length) return result(cx, def.unit, 0, 'zero', { formula: 'Σ 燃料 CO₂ × 生質比例', inputs: [], notes: ['本期燃料未設定生質成分（標的專屬欄位 biogenicShare），生質 CO₂ 為 0'] });
    return result(cx, def.unit, t, 'measured', { formula: 'Σ 燃料 CO₂ × 生質比例（另計，不納入總量；盤查表單表五 AT 欄）', inputs });
  },

  // 類別 3–6：顯著性評估表中「顯著且已量化」的項目
  significance(cx, def) {
    const rows = q.all('SELECT * FROM ghg_significance WHERE org_id = ? AND year = ? AND category = ?', cx.ds.org_id, cx.ds.year, def.category);
    const inputs = rows.map((r) => ({ item: r.item_code, name: r.name, significant: r.significant, quantified: !!r.quantified, value: r.value_tco2e, method: r.method, uncertaintyPct: r.uncertainty_pct }));
    if (!rows.length || rows.some((r) => r.significant === null)) return result(cx, def.unit, null, 'missing', { formula: '顯著且已量化項目加總', inputs, notes: [`類別${def.category}尚未完成顯著性評估`] });
    const sig = rows.filter((r) => r.significant);
    if (!sig.length) return result(cx, def.unit, null, 'not_applicable', { formula: '顯著且已量化項目加總', inputs, notes: ['經評估本類別無顯著項目'] });
    const q2 = sig.filter((r) => r.quantified && r.value_tco2e !== null);
    const notes = sig.filter((r) => !r.quantified || r.value_tco2e === null).map((r) => `${r.name} 判定顯著但尚未量化`);
    if (!q2.length) return result(cx, def.unit, null, 'missing', { formula: '顯著且已量化項目加總', inputs, notes });
    return result(cx, def.unit, q2.reduce((s, r) => s + r.value_tco2e, 0), notes.length ? 'partial' : 'estimated', { formula: '顯著且已量化項目加總', inputs, notes });
  },

  // 不確定性（盤查表單表七）：每種氣體 U＝√(活動數據² ＋ 係數²)，上下限分開；排放源 U＝√Σ(E×U)² ÷ ΣE；
  // 清冊總不確定性＝√Σ(E×U)² ÷ Σ（有評估的）E；另列「進行不確定性評估之排放量占比」
  uncertainty(cx, def) {
    const cfg = getConfig('ghg.uncertainty') || {};
    const rows = []; let sumE = 0; let sumL2 = 0; let sumH2 = 0; let totalAbs = 0; let state = 'estimated';
    for (const code of def.of) {
      const r = compute(cx, code);
      if (r.value === null) { if (!['not_applicable', 'zero'].includes(r.value_state)) state = 'partial'; continue; }
      const kind = UKIND[code];
      for (const s of r.trace?.sources || []) {
        let e = 0; let l2 = 0; let h2 = 0;
        const byGas = [];
        for (const g of s.gases) {
          const E = g.tco2e; totalAbs += Math.abs(E); if (!E) continue;
          const fb = cfg.factorByKind?.[kind];
          const lo = g.uLow ?? (fb === undefined ? null : -fb); const hi = g.uHigh ?? (fb === undefined ? null : fb);
          if (lo === null || hi === null) { byGas.push({ gas: g.gas, tCO2e: E, assessed: false }); continue; }
          const L = Math.sqrt(s.adUncertaintyPct ** 2 + lo ** 2); const H = Math.sqrt(s.adUncertaintyPct ** 2 + hi ** 2);
          e += E; l2 += (E * L) ** 2; h2 += (E * H) ** 2;
          byGas.push({ gas: g.gas, tCO2e: E, factorLowPct: lo, factorHighPct: hi, lowPct: round(L, 3), highPct: round(H, 3), assessed: true });
        }
        if (!e) continue;
        sumE += e; sumL2 += l2; sumH2 += h2;
        rows.push({ indicator: code, sourceKey: s.key, asset: s.asset, material: s.materialName, tCO2e: round(e, 4), activityPct: round(s.adUncertaintyPct, 3),
          lowPct: round(Math.sqrt(l2) / e, 3), highPct: round(Math.sqrt(h2) / e, 3), gases: byGas });
      }
    }
    if (!sumE) return result(cx, def.unit, null, 'missing', { formula: '', inputs: rows, notes: ['沒有可評估的排放量'] });
    const lowerPct = Math.sqrt(sumL2) / sumE; const upperPct = Math.sqrt(sumH2) / sumE;
    const out = result(cx, def.unit, Math.max(lowerPct, upperPct), state, {
      formula: '各氣體 U＝√(活動數據不確定性² ＋ 係數不確定性²)（上下限分開）；排放源 U＝√Σ(E×U)² ÷ ΣE；清冊 U＝√Σ(E×U)² ÷ Σ 有評估之 E（盤查表單表七）',
      inputs: rows, notes: [cfg.note || '', `信賴區間 ${cfg.confidence || '95%'}`].filter(Boolean) });
    Object.assign(out.trace, { lowerPct: round(lowerPct, 3), upperPct: round(upperPct, 3), assessedTco2e: round(sumE, 4), totalAbsTco2e: round(totalAbs, 4), coveragePct: totalAbs ? round(sumE / totalAbs * 100, 2) : null });
    return out;
  },

  water_consumption(cx, def) {
    const direct = factsFor(cx, { metrics: ['water_consumption_m3'] });
    if (direct.length) return KINDS.sum(cx, { metrics: ['water_consumption_m3'], unit: def.unit });
    const w = compute(cx, 'water.withdrawal_m3'); const d = compute(cx, 'water.discharge_m3');
    if (w.value === null) return result(cx, def.unit, null, 'missing', { formula: '取水 － 排水', inputs: [], notes: ['缺取水量'] });
    if (d.value === null) return result(cx, def.unit, null, 'missing', { formula: '取水 － 排水', inputs: [{ indicator: 'water.withdrawal_m3', value: w.value }], notes: ['缺排水量：不可把取水量直接當成耗水量'] });
    return result(cx, def.unit, w.value - d.value, worse(worse(w.value_state, d.value_state), 'estimated'), { formula: '取水量 － 排水量（未扣其他去向，口徑：簡化水平衡）',
      inputs: [{ indicator: 'water.withdrawal_m3', value: w.value }, { indicator: 'water.discharge_m3', value: d.value }] });
  },
};

// 某排放源結果拆成各氣體 kgCO2e
const MONTREAL_LIKE = /^(HCFC|CFC)/;
export function gasClass(g) {
  const s = String(g || '').toUpperCase();
  if (s === 'CO2' || s === 'R-744') return 'CO2';
  if (s === 'CH4') return 'CH4';
  if (s === 'N2O') return 'N2O';
  if (s === 'SF6') return 'SF6';
  if (s === 'NF3') return 'NF3';
  if (/^(PFC|CF4|C2F6|C3F8|R-14|R-116|R-218)/.test(s)) return 'PFCs';
  if (MONTREAL_LIKE.test(s)) return null;
  return 'HFCs'; // HFC 單一成分與 R-4xx／R-5xx 混合冷媒
}
function activityUncertainty(factId, cfg) {
  const f = q.get('SELECT * FROM approved_facts WHERE id = ?', factId);
  if (!f) return cfg.activityEstimated ?? 20;
  if (f.value_state === 'estimated') return cfg.activityEstimated ?? 20;
  const d = f.decision_id ? q.get('SELECT decision_type FROM decisions WHERE id = ?', f.decision_id) : null;
  if (d?.decision_type === 'derived') return cfg.activityDerived ?? 10;
  const ids = j(f.observation_ids, []);
  let best = null;
  for (const id of ids) {
    const o = q.get('SELECT method, uncertainty FROM observations WHERE id = ?', id); if (!o) continue;
    const n = Number(String(o.uncertainty || '').replace(/[^\d.]/g, ''));
    const v = Number.isFinite(n) && n > 0 ? n : (cfg.activityByMethod?.[o.method] ?? 5);
    best = best === null ? v : Math.max(best, v);
  }
  return best ?? 5;
}

export function compute(cx, code) {
  if (cx.cache.has(code)) return cx.cache.get(code);
  cx.cache.set(code, { value: null, unit: '', value_state: 'blocked', trace: { notes: ['循環引用'] } });
  const r = rule(cx, code);
  let out;
  if (!r) out = { value: null, unit: '', value_state: 'blocked', trace: { notes: [`計算規則 ${code} 不存在或未發布`] } };
  else {
    const def = j(r.definition, {});
    const fn = KINDS[def.kind];
    out = fn ? fn(cx, def) : { value: null, unit: def.unit, value_state: 'blocked', trace: { notes: [`未知的計算類型 ${def.kind}`] } };
    out.rule = { code, version: r.version, name: r.name };
  }
  cx.cache.set(code, out);
  return out;
}

export function computeAll(datasetId, codes, opts) {
  const cx = makeContext(datasetId, opts);
  const results = {};
  for (const c of codes) results[c] = compute(cx, c);
  // 依賴的子指標也一起回（展開計算用）
  for (const [c, r] of cx.cache) if (!results[c]) results[c] = r;
  return { results, factorVersions: cx.usedFactors, ruleVersions: cx.usedRules, dataset: { id: cx.ds.id, version: cx.ds.version, status: cx.ds.status, hash: cx.ds.hash } };
}

export const ALL_RULE_CODES = () => q.all("SELECT DISTINCT code FROM calculation_rules WHERE status = 'published'").map((r) => r.code);
export const STATE_LABEL = { measured: '實測', zero: '實際為零', estimated: '估計', partial: '部分缺漏', missing: '缺漏', not_applicable: '不適用', blocked: '無法計算（係數或規則未發布）' };
