// M09 排放與營運計算（PRD §13）：只吃資料集裡的採用值＋已發布係數＋已發布規則。
// 每個結果都能「展開計算」：活動數據、係數（代碼／版本／來源）、公式、捨入。
// 缺漏不當 0：沒有資料 → missing；部分標的沒資料 → partial；係數未發布 → blocked。
import { q } from './db.js';
import { factorAt, ruleCurrent, ruleVersion, getConfig } from './config-store.js';
import { j, round, convert } from './util.js';
import { MONTREAL, REFRIGERANT_ALIASES } from './seed/factors.js';

const STATE_RANK = { measured: 0, zero: 0, estimated: 1, partial: 2, missing: 3, not_applicable: 4, blocked: 5 };
const worse = (a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a);

const DEFAULT_FUEL = { 'OIL-GEN': 'diesel', 'OIL-FORK': 'diesel', 'OIL-VEH': 'gasoline', 'OIL-BOILER': 'fuel_oil', 'GAS-NG': 'ng', 'GAS-LPG': 'lpg' };
const FUEL_ACTIVITY = { diesel: 'oil_consumption_l', gasoline: 'oil_consumption_l', fuel_oil: 'oil_consumption_l', ng: 'ng_consumption_m3', lpg: 'lpg_consumption_kg' };
const FUEL_UNIT = { diesel: 'L', gasoline: 'L', fuel_oil: 'L', ng: 'Nm3', lpg: 'kg' };

export function makeContext(datasetId, { pinnedRules = {}, pinnedFactors = {} } = {}) {
  const ds = q.get('SELECT * FROM datasets WHERE id = ?', datasetId);
  if (!ds) throw new Error('dataset not found');
  const facts = q.all(`SELECT af.*, a.name AS asset_name, a.domain, a.attrs, a.applicability, a.asset_type, a.status AS asset_status, i.code AS item_code
    FROM approved_facts af JOIN assets a ON a.id = af.asset_id LEFT JOIN inventory_items i ON i.id = a.item_id WHERE af.dataset_id = ? AND af.is_current = 1`, datasetId)
    .map((f) => ({ ...f, attrs: j(f.attrs, {}) }));
  const assets = q.all(`SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.status <> 'archived'`, ds.org_id)
    .map((a) => ({ ...a, attrs: j(a.attrs, {}) }));
  const settings = getConfig('calc.settings') || { gwpSet: 'AR5', precision: {} };
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

const KINDS = {
  sum(cx, def) {
    const facts = factsFor(cx, def);
    if (!facts.length) return result(cx, def.unit, null, def.items ? emptyState(cx, def.items) : 'missing', { formula: '查無採用值', inputs: [] });
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
    const gwpSet = cx.settings.gwpSet || 'AR5';
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; let totalKg = 0; let any = false;
    for (const f of cx.facts.filter((x) => def.items.includes(x.item_code))) {
      const fuel = f.attrs.fuel || DEFAULT_FUEL[f.item_code];
      if (FUEL_ACTIVITY[fuel] !== f.metric_code) continue;
      if (['missing', 'unknown', 'pending_period_end'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      if (f.value_state === 'not_applicable') continue;
      const c = convert(f.value, f.unit, FUEL_UNIT[fuel]); const activity = c.ok ? c.value : f.value;
      let kg = 0; const gases = {};
      for (const gas of ['CO2', 'CH4', 'N2O']) {
        const ef = factor(cx, `ef.${fuel}.${def.mode}.${gas}`, f.period_start) || (def.mode === 'mobile' ? factor(cx, `ef.${fuel}.stationary.${gas}`, f.period_start) : null);
        const gwp = factor(cx, `gwp.${gwpSet}.${gas}`);
        if (!ef || !gwp) { state = 'blocked'; notes.push(`缺已發布係數：${!ef ? `ef.${fuel}.${def.mode}.${gas}` : `gwp.${gwpSet}.${gas}`}`); continue; }
        if (!factors.some((x) => x.code === ef.code)) factors.push(fRef(ef));
        if (!factors.some((x) => x.code === gwp.code)) factors.push(fRef(gwp));
        gases[gas] = activity * ef.value * gwp.value; kg += gases[gas];
      }
      totalKg += kg; any = true;
      if (f.value_state === 'estimated') state = worse(state, 'estimated');
      inputs.push(inp(f, { fuel, kgCO2e: round(kg, 3), byGas: Object.fromEntries(Object.entries(gases).map(([g, v]) => [g, round(v, 3)])) }));
    }
    const as = assetsFor(cx, def.items).filter((a) => a.applicability !== 'not_applicable');
    const covered = new Set(inputs.map((i) => i.assetId));
    const lacking = as.filter((a) => a.applicability === 'applicable' && !covered.has(a.id) && FUEL_ACTIVITY[a.attrs.fuel || DEFAULT_FUEL[a.item_code]] && !['fuel_tank'].includes(a.asset_type));
    if (lacking.length) { state = worse(state, any ? 'partial' : 'missing'); notes.push(`缺活動數據：${lacking.map((a) => a.name).join('、')}`); }
    if (!any && !lacking.length) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : emptyState(cx, def.items), { formula: '查無燃料消耗採用值', inputs, factors, notes });
    return result(cx, def.unit, totalKg / 1000, state, { formula: `Σ 燃料消耗量 × 排放係數(CO₂、CH₄、N₂O) × GWP(${gwpSet}) ÷ 1000`, inputs, factors, notes, gwpSet });
  },

  electricity_emission(cx, def) {
    const facts = factsFor(cx, { items: def.items, metrics: [def.metric] });
    if (!facts.length) return result(cx, def.unit, null, emptyState(cx, def.items), { formula: '查無外購電力採用值', inputs: [] });
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; let kg = 0; let any = false;
    for (const f of facts) {
      if (['missing', 'unknown'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
      if (f.value_state === 'not_applicable') continue;
      const y = Number(f.period_start.slice(0, 4));
      let ef = cx.pinnedFactors[`ef.electricity.${y}`] ? factor(cx, `ef.electricity.${y}`) : factor(cx, `ef.electricity.${y}`, `${y}-06-30`);
      if (!ef) {
        // 當年度係數尚未公告：明示採用最近一年已發布值並標為估計
        const latest = q.get("SELECT * FROM factors WHERE code LIKE 'ef.electricity.%' AND status = 'published' AND valid_from <= ? ORDER BY valid_from DESC, version DESC LIMIT 1", `${y}-12-31`);
        if (!latest) { state = 'blocked'; notes.push(`${y} 年電力排放係數未發布`); continue; }
        ef = latest; cx.usedFactors[latest.code] = latest.version; state = worse(state, 'estimated');
        if (!notes.includes(`${y} 年電力排放係數尚未公告，暫用 ${latest.name}`)) notes.push(`${y} 年電力排放係數尚未公告，暫用 ${latest.name}`);
      }
      if (!factors.some((x) => x.code === ef.code)) factors.push(fRef(ef));
      const c = convert(f.value, f.unit, 'kWh');
      const v = (c.ok ? c.value : f.value) * ef.value; kg += v; any = true;
      if (f.value_state === 'estimated') state = worse(state, 'estimated');
      inputs.push(inp(f, { factor: ef.code, kgCO2e: round(v, 3) }));
    }
    if (!any) return result(cx, def.unit, null, state === 'blocked' ? 'blocked' : 'missing', { formula: '外購電力 × 電力排放係數', inputs, factors, notes });
    return result(cx, def.unit, kg / 1000, state, { formula: 'Σ 外購電力(kWh) × 當年度電力排放係數(kgCO₂e/kWh) ÷ 1000', inputs, factors, notes,
      note: '市場基礎法（再生能源憑證）另依憑證條件處理，本指標為地點基礎' });
  },

  refrigerant(cx, def) {
    const gwpSet = cx.settings.gwpSet || 'AR5';
    const method = cx.settings.refrigerantMethod || 'recharge';
    const inputs = []; const factors = []; const notes = []; let state = 'measured'; let kg = 0; let any = false;
    const as = assetsFor(cx, def.items).filter((a) => a.applicability !== 'not_applicable' && a.status !== 'archived');
    for (const a of as) {
      let gas = a.attrs.refrigerant || a.attrs.agent;
      if (!gas) { if (a.item_code === 'GAS-FIRE' && /乾粉|ABC|BC|KBC/i.test(a.attrs.type || '')) continue; notes.push(`${a.name} 未填冷媒／藥劑種類`); state = worse(state, 'partial'); continue; }
      gas = REFRIGERANT_ALIASES[gas] || gas;
      if (MONTREAL.includes(gas)) { notes.push(`${a.name}：${gas} 屬蒙特婁議定書管制物質，不計入`); continue; }
      const rechargeAll = cx.facts.filter((f) => f.asset_id === a.id && ['ref_recharge_kg', 'fire_ext_refill_kg'].includes(f.metric_code));
      const recharge = rechargeAll.filter((f) => !['missing', 'unknown'].includes(f.value_state));
      for (const f of rechargeAll) if (!recharge.includes(f)) inputs.push(inp(f, { excluded: true }));
      const gwp = gas === 'CO2' ? { code: 'gwp.CO2', version: 0, value: 1, unit: 'kgCO2e/kg', source: '定義' } : factor(cx, `gwp.${gwpSet}.${gas}`);
      if (!gwp) { state = 'blocked'; notes.push(`缺 ${gas} 的已發布 GWP（${gwpSet}）`); continue; }
      if (gwp.code !== 'gwp.CO2' && !factors.some((x) => x.code === gwp.code)) factors.push(fRef(gwp));
      if (recharge.length) {
        for (const f of recharge) {
          if (['missing', 'unknown'].includes(f.value_state)) { state = worse(state, 'partial'); inputs.push(inp(f, { excluded: true })); continue; }
          const v = (f.value || 0) * gwp.value; kg += v; any = true;
          if (f.value_state === 'estimated') state = worse(state, 'estimated');
          inputs.push(inp(f, { gas, kgCO2e: round(v, 3) }));
        }
      } else if (method === 'screening' && a.attrs.leakRatePct) {
        const plate = cx.facts.find((f) => f.asset_id === a.id && ['ref_charge_kg', 'fire_ext_charge_kg'].includes(f.metric_code));
        if (!plate) { notes.push(`${a.name}：無補充紀錄也無充填量`); state = worse(state, 'partial'); continue; }
        const v = plate.value * (a.attrs.leakRatePct / 100) * gwp.value; kg += v; any = true; state = worse(state, 'estimated');
        inputs.push(inp(plate, { gas, method: `充填量 × 年逸散率 ${a.attrs.leakRatePct}%（核准的推估方法）`, kgCO2e: round(v, 3) }));
      } else {
        notes.push(`${a.name}：逸散量所需活動資料不足（有設備資訊但無補充／回收紀錄；銘牌充填量不等於逸散量）`);
        state = worse(state, any ? 'partial' : 'missing');
      }
    }
    if (!any) return result(cx, def.unit, null, as.length ? (state === 'blocked' ? 'blocked' : 'missing') : 'not_applicable', { formula: 'Σ 補充量 × GWP', inputs, factors, notes });
    return result(cx, def.unit, kg / 1000, state, { formula: `Σ 冷媒補充量(kg) × GWP(${gwpSet}) ÷ 1000`, inputs, factors, notes, gwpSet, method });
  },

  insulating(cx, def) {
    const gwpSet = cx.settings.gwpSet || 'AR5';
    const facts = factsFor(cx, { items: def.items, metrics: ['insul_gas_recharge_kg'] });
    if (!facts.length) return result(cx, def.unit, null, emptyState(cx, def.items), { formula: '查無絕緣氣體補充採用值', inputs: [] });
    const inputs = []; const factors = []; let kg = 0; let state = 'measured';
    for (const f of facts) {
      const gas = f.attrs.gas || 'SF6';
      const gwp = factor(cx, `gwp.${gwpSet}.${gas}`);
      if (!gwp) return result(cx, def.unit, null, 'blocked', { formula: '', inputs, notes: [`缺 ${gas} GWP`] });
      if (!factors.some((x) => x.code === gwp.code)) factors.push(fRef(gwp));
      const v = (f.value || 0) * gwp.value; kg += v; if (f.value_state === 'estimated') state = 'estimated';
      inputs.push(inp(f, { gas, kgCO2e: round(v, 3) }));
    }
    return result(cx, def.unit, kg / 1000, state, { formula: `Σ 補充量 × GWP(${gwpSet}) ÷ 1000`, inputs, factors });
  },

  process_gas(cx, def) {
    const gwpSet = cx.settings.gwpSet || 'AR5';
    const facts = factsFor(cx, { items: def.items, metrics: ['n2o_use_kg', 'co2_use_kg'] });
    if (!facts.length) {
      const purchases = factsFor(cx, { items: def.items, metrics: ['n2o_purchase_kg', 'co2_purchase_kg'] });
      return result(cx, def.unit, null, purchases.length ? 'missing' : emptyState(cx, def.items), { formula: '查無使用量', inputs: [],
        notes: purchases.length ? ['只有採購量；不得假定全部採購量都是排放量，請提供使用量或核准的推估方法'] : [] });
    }
    const inputs = []; const factors = []; let kg = 0; let state = 'measured';
    for (const f of facts) {
      const gas = f.metric_code === 'n2o_use_kg' ? 'N2O' : 'CO2';
      const gwp = factor(cx, `gwp.${gwpSet}.${gas}`);
      if (!gwp) return result(cx, def.unit, null, 'blocked', { formula: '', inputs, notes: [`缺 ${gas} GWP`] });
      if (!factors.some((x) => x.code === gwp.code)) factors.push(fRef(gwp));
      const v = (f.value || 0) * gwp.value; kg += v; if (f.value_state === 'estimated') state = 'estimated';
      inputs.push(inp(f, { gas, kgCO2e: round(v, 3) }));
    }
    return result(cx, def.unit, kg / 1000, state, { formula: `Σ 使用量 × GWP(${gwpSet}) ÷ 1000（氧氣非溫室氣體，不計）`, inputs, factors });
  },

  septic(cx, def) {
    const as = assetsFor(cx, def.items);
    if (!as.length || as.every((a) => a.applicability === 'not_applicable')) return result(cx, def.unit, null, 'not_applicable', { formula: '', inputs: [], notes: ['無化糞池或已接管公共污水下水道'] });
    if (as.some((a) => a.applicability !== 'applicable')) return result(cx, def.unit, null, 'missing', { formula: '', inputs: [], notes: ['化糞池適用性尚未判定（是否接管）'] });
    const hours = compute(cx, 'act.staff_hours'); const visits = compute(cx, 'act.outpatient'); const inpatient = compute(cx, 'act.inpatient_days');
    if (hours.value === null) return result(cx, def.unit, null, 'missing', { formula: '', inputs: [], notes: ['缺員工工時'] });
    const bod = factor(cx, 'septic.bod_g_per_person_day'); const bo = factor(cx, 'septic.bo'); const mcf = factor(cx, 'septic.mcf'); const gwp = factor(cx, `gwp.${cx.settings.gwpSet || 'AR5'}.CH4`);
    if (!bod || !bo || !mcf || !gwp) return result(cx, def.unit, null, 'blocked', { formula: '', inputs: [], notes: ['化糞池係數或 CH₄ GWP 未發布'] });
    const visitH = cx.septic.visitHours ?? 2;
    const personDays = hours.value / 24 + (visits.value || 0) * visitH / 24 + (inpatient.value || 0);
    const ch4 = personDays * (bod.value / 1000) * bo.value * mcf.value;
    return result(cx, def.unit, ch4 * gwp.value / 1000, 'estimated', {
      formula: `人日 =（員工工時÷24）＋（門急診人次×${visitH}÷24）＋住院人日；CH₄ = 人日 × BOD × Bo × MCF；× GWP ÷ 1000`,
      inputs: [{ indicator: 'act.staff_hours', value: hours.value }, { indicator: 'act.outpatient', value: visits.value }, { indicator: 'act.inpatient_days', value: inpatient.value }],
      factors: [bod, bo, mcf, gwp].map(fRef), notes: [cx.septic.note || ''].filter(Boolean), personDays: round(personDays, 2) });
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
