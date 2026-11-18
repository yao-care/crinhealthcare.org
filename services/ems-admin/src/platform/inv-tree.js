// 盤點樹（院所頁左欄）＋節點內容（中欄）＋報告欄位對照（右欄）。
//
// 左欄：油、水、電、氣四大類。電分「台電」與「分區」兩條線：
//   台電＝外購電力電號（受電總盤）→ 分盤 → 電表／設備，沿 assets.parent_asset_id 往下（與報表找上層電號同一條路）
//   分區＝建物 → 樓層（buildings.floors），「周邊」是 zoneKind=outdoor 的建物，樓層欄放停車場、路燈等區域
// 兩條線是網狀關係：盤或設備的實體位置記在 assets.building_id／floor，供電範圍記在 asset_zones（一盤可供多層、一層可由多盤供電）；
// 盤與盤之間的備援或共用另走 asset_links。
//
// 右欄：某個標的（或它的某個指標）會進到哪些報告欄位。由已發布的計算規則與報告模板欄位對照反推，不另寫一份對照表；
// 只有「整張表」型欄位（text）需要下面 BLOCK_INPUTS 註明它讀哪些盤點項目。
import { q, insert, update, newId, nowIso, audit, parseJson } from './db.js';
import { assertCan } from './authz.js';
import { bad, notFound, j } from './util.js';
import { DOMAINS, ASSET_TYPES, ASSET_ATTRS } from './seed/dictionary.js';
import { DEFAULT_FUEL } from './calc.js';
import { comparison } from './observations.js';
import { PROFILE_FIELDS } from './profile.js';

const today = () => new Date().toISOString().slice(0, 10);
// 結束關係時 valid_to 記當天（assets.unlinkAssets 同規則），當天起就不算
const activeLink = (l) => !l.valid_to || l.valid_to > today();
export const SOURCE_KIND = { ems: '智慧電表／EMS', manual: '手抄表', bill: '帳單', api: '介接', file: '檔案', document: '文件', system: '系統', contract: '契約', record: '紀錄' };

// ── 樓層文字 ⇄ 清單 ──
// 「B1–9F」「B2-12F」展開成 9F…1F、B1…B2（由上往下）；其餘用頓號、逗號分隔照原順序
export function parseFloors(text) {
  if (!text) return [];
  const out = [];
  for (const tok of String(text).split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = tok.match(/^B(\d+)\s*F?\s*[–—~～-]\s*(\d+)\s*F$/i);
    if (m) {
      for (let f = Number(m[2]); f >= 1; f--) out.push(`${f}F`);
      for (let b = 1; b <= Number(m[1]); b++) out.push(`B${b}`);
      continue;
    }
    const m2 = tok.match(/^(\d+)\s*F?\s*[–—~～-]\s*(\d+)\s*F$/i);
    if (m2) { const a = Number(m2[1]); const b = Number(m2[2]); for (let f = Math.max(a, b); f >= Math.min(a, b); f--) out.push(`${f}F`); continue; }
    out.push(tok);
  }
  return [...new Set(out)];
}

function orgAssets(orgId) {
  return q.all(`SELECT a.*, i.code AS item_code, i.name AS item_name FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id
    WHERE a.org_id = ? AND a.status <> 'archived' ORDER BY COALESCE(json_extract(a.attrs, '$.sort'), 9999), a.name`, orgId)
    .map((r) => parseJson(r, ['attrs', 'data_spec']));
}
function orgBuildings(orgId) {
  return q.all('SELECT b.* FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.org_id = ? AND (b.valid_to IS NULL OR b.valid_to > ?) ORDER BY b.created_at', orgId, today())
    .map((b) => ({ ...parseJson(b, ['attrs']), floorList: parseFloors(b.floors) }));
}
const typeLabel = (a) => ASSET_TYPES[a.asset_type] || a.asset_type;

// ── 左欄：整棵樹 ──
export function tree(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  const assets = orgAssets(orgId);
  const srcCount = new Map(q.all("SELECT asset_id, COUNT(*) n FROM data_sources WHERE org_id = ? AND active = 1 AND asset_id IS NOT NULL GROUP BY asset_id", orgId).map((r) => [r.asset_id, r.n]));
  const byParent = new Map();
  for (const a of assets) { const k = a.parent_asset_id || ''; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(a); }
  const ids = new Set(assets.map((a) => a.id));
  const node = (a, seen = new Set()) => {
    seen.add(a.id);
    return { kind: 'asset', id: a.id, name: a.name, assetType: a.asset_type, typeLabel: typeLabel(a), itemCode: a.item_code || null, domain: a.domain,
      sources: srcCount.get(a.id) || 0, status: a.status,
      children: (byParent.get(a.id) || []).filter((c) => !seen.has(c.id)).map((c) => node(c, seen)) };
  };
  const roots = (dom) => assets.filter((a) => a.domain === dom && (!a.parent_asset_id || !ids.has(a.parent_asset_id)));
  const byItem = (list) => {
    const groups = new Map();
    for (const a of list) { const k = a.item_code || '_'; if (!groups.has(k)) groups.set(k, { kind: 'group', id: `item:${k}`, name: a.item_name || '未分類', itemCode: a.item_code, children: [] }); groups.get(k).children.push(node(a)); }
    return [...groups.values()];
  };
  const blds = orgBuildings(orgId);
  const zoneNodes = blds.map((b) => ({ kind: 'building', id: b.id, name: b.name, outdoor: b.attrs?.zoneKind === 'outdoor', attrs: b.attrs || {}, floorAreaM2: b.floor_area_m2,
    children: b.floorList.map((f) => ({ kind: 'floor', id: `${b.id}|${f}`, name: f, children: [] })) }));
  // 周邊放最後
  zoneNodes.sort((x, y) => Number(x.outdoor) - Number(y.outdoor));
  // 油水電氣＋營運數據（員工工時、門急診住院、病床與樓地板面積、廢棄物：報告的分母與化糞池人時）
  const domains = ['oil', 'water', 'electricity', 'gas', 'activity'].map((key) => [key, DOMAINS[key]]).map(([key, d]) => {
    const r = roots(key);
    if (key === 'activity') return { key, label: '營運數據', icon: '📋', children: r.map((a) => node(a)), count: assets.filter((a) => a.domain === key).length };
    if (key !== 'electricity') return { key, label: d.name, icon: d.icon, children: byItem(r), count: assets.filter((a) => a.domain === key).length };
    const grid = r.filter((a) => a.item_code === 'ELE-GRID');
    const other = r.filter((a) => a.item_code !== 'ELE-GRID');
    const children = [
      { kind: 'tpc', id: 'tpc', name: '台電', manage: true, children: grid.map((a) => ({ ...node(a), manage: true })) },
      { kind: 'zones', id: 'zones', name: '分區', manage: true, children: zoneNodes },
    ];
    // 沒接上台電的分表依所在建物分組（各建物常有同名盤號，例：L1、EP3），沒填建物的放最後
    if (other.length) {
      const bname = new Map(blds.map((b) => [b.id, b.name]));
      const groups = new Map();
      for (const a of other) {
        const k = bname.has(a.building_id) ? a.building_id : '_';
        if (!groups.has(k)) groups.set(k, { kind: 'group', id: `ele-other:${k}`, name: bname.get(k) || '未填建物', children: [] });
        groups.get(k).children.push(node(a));
      }
      const order = (g) => (g.id === 'ele-other:_' ? 1 : 0);
      children.push({ kind: 'group', id: 'ele-other', name: '其他（未接到台電總盤）', children: [...groups.values()].sort((x, y) => order(x) - order(y)) });
    }
    return { key, label: d.name, icon: d.icon, children, count: assets.filter((a) => a.domain === key).length };
  });
  const site = q.get('SELECT id, name FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', orgId);
  return { orgId, site, domains };
}

// ── 右欄：報告欄位對照 ──
const FUEL_METRICS = ['oil_consumption_l', 'oil_purchase_l', 'oil_stock_l', 'oil_issue_l', 'oil_other_use_l', 'ng_consumption_m3', 'lpg_consumption_kg', 'lpg_purchase_kg', 'lpg_stock_kg'];
// 整張表型欄位讀哪些盤點項目（items：盤點項目；types：標的類型；metrics：只限這些指標；zone：建物／分區）
const BLOCK_INPUTS = {
  eu_basic: { items: ['ELE-GRID', 'ACT-STAFF', 'ACT-CAP'] },
  eu_heat: { items: ['OIL-GEN', 'OIL-BOILER', 'OIL-VEH', 'OIL-FORK', 'GAS-NG', 'GAS-LPG'], metrics: FUEL_METRICS },
  eu_elec: { items: ['ELE-GRID'] },
  eu_eui: { items: ['ELE-GRID', 'ACT-CAP'], metrics: ['elec_purchased_kwh', 'floor_area_m2'] },
  eu_flow: { items: ['ELE-GRID', 'ELE-SUB', 'ELE-EQUIP', 'ELE-PV', 'OIL-GEN', 'OIL-VEH', 'OIL-FORK'], metrics: ['elec_purchased_kwh', 'elec_metered_kwh', 'equip_estimated_kwh', 'elec_generated_kwh', 'elec_self_used_kwh', 'elec_exported_kwh', 'oil_consumption_l'] },
  eu_buildings: { zone: true },
  eu_elec_system: { types: ['transformer', 'capacitor', 'generator'] },
  eu_equipment: { items: ['ELE-EQUIP', 'GAS-REF'], types: ['boiler'] },
  gov_basic: { items: ['ACT-STAFF', 'ACT-CAP'] },
  gov_meters: { items: ['ELE-GRID'], metrics: ['elec_purchased_kwh'] },
  gov_monthly: { items: ['ELE-GRID', 'WAT-TAP', 'WAT-GROUND', 'OIL-GEN', 'OIL-VEH', 'OIL-BOILER', 'OIL-FORK'], metrics: ['elec_purchased_kwh', 'water_withdrawal_m3', 'oil_consumption_l'] },
  gov_compare: { items: ['ELE-GRID', 'WAT-TAP', 'WAT-GROUND', 'ACT-CAP'] },
  oew_monthly: { items: ['ELE-GRID', 'WAT-TAP', 'WAT-GROUND', 'OIL-GEN', 'OIL-VEH', 'OIL-BOILER', 'GAS-NG', 'GAS-LPG'] },
  gov_pv: { items: ['ELE-PV'] },
  gov_oil: { items: ['OIL-GEN', 'OIL-VEH', 'OIL-BOILER', 'OIL-FORK'], metrics: ['oil_consumption_l', 'oil_purchase_l'] },
  gov_lighting: { types: ['lighting'] },
  gov_ac: { items: ['ELE-EQUIP', 'GAS-REF'] },
  gov_public: { items: ['ELE-EQUIP', 'GAS-REF'] },
  gov_dataroom: { types: ['data_room'] },
  gov_ems: { types: ['ems', 'chiller'] },
  gov_hv: { types: ['transformer', 'power_account'], metrics: ['elec_contract_kw', 'elec_peak_demand_kw', 'elec_power_factor_pct'] },
  gov_vehicles: { types: ['vehicle'] },
  ghg_t2: { zone: true },
  ghg_t9: { items: ['ELE-GRID', 'ELE-PV', 'ELE-HEAT'], metrics: ['elec_purchased_kwh', 'elec_wheeled_kwh', 'elec_generated_kwh', 'elec_self_used_kwh', 'elec_exported_kwh', 'imported_energy_gj'] },
  // 盤查各表：讀的就是排放量計算用到的（項目 × 指標），直接用計算規則判斷
  ...Object.fromEntries(['ghg_t3', 'ghg_t4', 'ghg_t5', 'ghg_t6', 'ghg_t7', 'ghg_t8', 'source_inventory', 'uncertainty_table', 'data_quality', 'moenv_import', 'moenv_check', 'factors', 'methods']
    .map((k) => [k, { rules: ['ghg.total', 'ghg.biogenic_co2'] }])),
};

let ruleCache = null;
function rules() {
  if (ruleCache && ruleCache.at > Date.now() - 60_000) return ruleCache.map;
  const map = new Map();
  for (const r of q.all("SELECT code, name, definition FROM calculation_rules WHERE status = 'published' ORDER BY version")) map.set(r.code, { name: r.name, def: j(r.definition, {}) });
  ruleCache = { at: Date.now(), map };
  return map;
}
// 一條指標最終讀哪些（盤點項目 × 指標）：回傳條件清單 { items|null, metrics|null, fuel? }
function consumes(code, seen = new Set()) {
  if (seen.has(code)) return []; seen.add(code);
  const r = rules().get(code); if (!r) return [];
  const d = r.def;
  switch (d.kind) {
    case 'sum': return [{ items: d.items || null, metrics: d.metrics || null, fuel: d.fuel || null }];
    case 'combustion': case 'biogenic': return [{ items: d.items, metrics: FUEL_METRICS }];
    case 'electricity_emission': case 'simple_emission': return [{ items: d.items, metrics: [d.metric] }];
    case 'refrigerant': case 'insulating': case 'process_gas': return [{ items: d.items, metrics: null }];
    case 'septic': return [{ items: d.items, metrics: null }, { items: ['ACT-STAFF'], metrics: ['staff_hours'] }, { items: ['ACT-PATIENT'], metrics: null }];
    case 'energy_total': return [{ items: null, metrics: ['elec_purchased_kwh', 'imported_energy_gj', ...FUEL_METRICS] }];
    case 'water_consumption': return [{ items: ['WAT-TAP', 'WAT-GROUND', 'WAT-DIS'], metrics: ['water_withdrawal_m3', 'water_discharge_m3'] }];
    case 'ratio': return [...consumes(d.num, seen), ...consumes(d.den, seen)];
    case 'add': case 'gas_split': case 'uncertainty': return (d.of || []).flatMap((c) => consumes(c, seen));
    default: return [];
  }
}
const hit = (cond, { itemCode, metrics, fuel }) => {
  if (cond.items && !cond.items.includes(itemCode)) return false;
  if (cond.fuel && cond.fuel !== fuel) return false;
  if (cond.metrics && !cond.metrics.some((m) => metrics.includes(m))) return false;
  return true;
};

// 一個標的（可指定某個指標）或建物會出現在哪些報告欄位
export function fieldsFor({ asset = null, metric = null, zone = false } = {}) {
  const item = asset?.item_id ? parseJson(q.get('SELECT code, metrics FROM inventory_items WHERE id = ?', asset.item_id), ['metrics']) : null;
  const itemCode = item?.code || null;
  const metrics = metric ? [metric] : (item?.metrics || []);
  const fuel = asset ? (j(asset.attrs, {})?.fuel || DEFAULT_FUEL[itemCode] || null) : null;
  const who = { itemCode, metrics, fuel };
  // 指定的指標不在這個盤點項目的資料需求裡（例：電號上的智慧電表表計電量）：只拿來和同一顆表的其他來源比對，不進報告
  if (asset && metric && item?.metrics?.length && !item.metrics.includes(metric)) return [];
  // 每個模板只看最新已發布版本
  const tpls = q.all("SELECT * FROM report_templates WHERE status = 'published' ORDER BY code, version DESC");
  const latest = new Map(); for (const t of tpls) if (!latest.has(t.code)) latest.set(t.code, t);
  const out = [];
  for (const t of latest.values()) {
    const sections = new Map(j(t.sections, []).map((s) => [s.id, s.title]));
    for (const m of q.all('SELECT * FROM report_mappings WHERE template_id = ? ORDER BY sort', t.id)) {
      let how = null;
      if (m.source_kind === 'indicator' && m.source_ref && !zone && asset) {
        if (consumes(m.source_ref).some((c) => hit(c, who))) how = `計入「${rules().get(m.source_ref)?.name || m.source_ref}」`;
      } else if (m.source_kind === 'metric_sum' && m.source_ref && asset) {
        if (metrics.includes(m.source_ref)) how = '直接加總';
      } else if (m.source_kind === 'text' && BLOCK_INPUTS[m.source_ref]) {
        const b = BLOCK_INPUTS[m.source_ref];
        if (zone && b.zone) how = '列為一筆建物資料';
        else if (asset && b.rules) { if (b.rules.some((r) => consumes(r).some((c) => hit(c, who)))) how = '列入此表'; }
        else if (asset && ((b.items && b.items.includes(itemCode)) || (b.types && b.types.includes(asset.asset_type)))
          && (!b.metrics || !metric || b.metrics.includes(metric)) && (!b.metrics || metric || !metrics.length || b.metrics.some((x) => metrics.includes(x)))) how = '列入此表';
      }
      if (how) out.push({ templateCode: t.code, template: t.name, section: sections.get(m.section) || m.section, field: m.label, how });
    }
  }
  return out;
}

// 院所基本資料某一欄會進哪些報告：手動欄位（field_id＝基本資料欄位代碼）＋讀基本資料的整張表
const PROFILE_BLOCKS = { basic: ['eu_basic', 'gov_basic', 'ghg_t1', 'moenv_import'], energy: ['eu_basic'], moenv: ['ghg_t1', 'ghg_t2', 'moenv_import'], gov: ['gov_basic'] };
export function profileFieldsFor(profileKey) {
  const ids = Object.entries(PROFILE_FIELDS).filter(([, f]) => f.key === profileKey).map(([id]) => id);
  const group = Object.values(PROFILE_FIELDS).find((f) => f.key === profileKey)?.group;
  const blocks = PROFILE_BLOCKS[group] || [];
  const tpls = q.all("SELECT * FROM report_templates WHERE status = 'published' ORDER BY code, version DESC");
  const latest = new Map(); for (const t of tpls) if (!latest.has(t.code)) latest.set(t.code, t);
  const out = [];
  for (const t of latest.values()) {
    const sections = new Map(j(t.sections, []).map((x) => [x.id, x.title]));
    for (const m of q.all('SELECT * FROM report_mappings WHERE template_id = ? ORDER BY sort', t.id)) {
      let how = null;
      if (m.source_kind === 'manual' && ids.includes(m.field_id)) how = '直接帶入';
      else if (m.source_kind === 'text' && blocks.includes(m.source_ref)) how = '列入此表';
      if (how) out.push({ templateCode: t.code, template: t.name, section: sections.get(m.section) || m.section, field: m.label, how });
    }
  }
  return out;
}

// ── 中欄：節點內容 ──
function latestBySource(assetId, metricCodes) {
  if (!metricCodes.length) return new Map();
  const rows = q.all(`SELECT o.source_id, o.metric_code, o.period_start, o.period_end, o.value_std, o.std_unit, o.raw_value, o.raw_unit FROM observations o
    WHERE o.asset_id = ? AND o.quality_status NOT IN ('superseded','invalid') AND o.metric_code IN (${metricCodes.map(() => '?').join(',')})
    ORDER BY o.period_end DESC`, assetId, ...metricCodes);
  const m = new Map();
  for (const r of rows) if (!m.has(r.source_id)) m.set(r.source_id, r);
  return m;
}
const metricRows = (codes) => (codes.length ? q.all(`SELECT code, name, std_unit FROM metrics WHERE code IN (${codes.map(() => '?').join(',')})`, ...codes) : []);

// 異動歷程的人看得懂版本：欄位代碼換成中文、建物與上層換成名稱、規格逐欄列出
const COL_LABEL = { name: '名稱', external_key: '識別碼', meter_multiplier: '表計倍率', building_id: '所在建物', floor: '樓層', status: '狀態', parent_asset_id: '上層',
  location: '位置', valid_to: '停用日', item_id: '盤點項目', asset_type: '類型', applicability: '適用性', owner_user_id: '保管者' };
const STATUS_LABEL = { active: '使用中', disabled: '停用', draft: '草稿', archived: '封存' };
function describeChanges(type, before, after) {
  const show = (col, v) => {
    if (v === null || v === undefined || v === '') return '（空）';
    if (col === 'building_id') return q.get('SELECT name FROM buildings WHERE id = ?', v)?.name || v;
    if (col === 'parent_asset_id') return q.get('SELECT name FROM assets WHERE id = ?', v)?.name || v;
    if (col === 'status') return STATUS_LABEL[v] || v;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const out = [];
  for (const col of Object.keys(after)) {
    if (col === 'updated_at') continue;
    if (col === 'attrs') {
      const b = j(before.attrs, {}) || {}; const aa = j(after.attrs, {}) || {};
      const labels = new Map((ASSET_ATTRS[type] || []).map(([k, l]) => [k, l]));
      for (const k of new Set([...Object.keys(b), ...Object.keys(aa)])) {
        if (JSON.stringify(b[k]) === JSON.stringify(aa[k])) continue;
        out.push({ label: k === 'note' ? '備註' : labels.get(k) || k, from: show(k, b[k]), to: show(k, aa[k]) });
      }
      continue;
    }
    out.push({ label: COL_LABEL[col] || col, from: show(col, before[col]), to: show(col, after[col]) });
  }
  return out;
}

export function assetNode(ctx, id, { year, metric } = {}) {
  const a0 = q.get('SELECT a.*, i.code AS item_code, i.name AS item_name, i.metrics AS item_metrics FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.id = ?', id);
  if (!a0) throw notFound('標的');
  assertCan(ctx, 'view.internal', a0.org_id);
  const a = parseJson(a0, ['attrs', 'data_spec', 'item_metrics']);
  const y = Number(year) || new Date().getFullYear();
  // 上游（沿 parent_asset_id）
  const path = []; let cur = a; const seen = new Set([a.id]);
  while (cur.parent_asset_id && !seen.has(cur.parent_asset_id)) {
    const p = q.get('SELECT id, name, asset_type, parent_asset_id FROM assets WHERE id = ?', cur.parent_asset_id); if (!p) break;
    seen.add(p.id); path.unshift({ id: p.id, name: p.name, typeLabel: typeLabel(p) }); cur = p;
  }
  const metricCodes = (a.item_metrics || []);
  // 預設比對用量（不是存量或費用）
  const USAGE_FIRST = ['elec_purchased_kwh', 'elec_metered_kwh', 'oil_consumption_l', 'water_withdrawal_m3', 'water_metered_m3', 'ng_consumption_m3', 'lpg_consumption_kg', 'elec_generated_kwh'];
  const mainMetric = metric && metricCodes.includes(metric) ? metric : USAGE_FIRST.find((m) => metricCodes.includes(m)) || metricCodes[0] || null;
  const children = q.all("SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.parent_asset_id = ? AND a.status <> 'archived' ORDER BY a.name", a.id)
    .map((c) => ({ id: c.id, name: c.name, typeLabel: typeLabel(c), assetType: c.asset_type }));
  const links = q.all(`SELECT l.*, p.name AS parent_name, c.name AS child_name FROM asset_links l JOIN assets p ON p.id = l.parent_id JOIN assets c ON c.id = l.child_id
    WHERE l.parent_id = ? OR l.child_id = ?`, a.id, a.id).filter(activeLink)
    .map((l) => ({ id: l.id, relation: l.relation, dir: l.parent_id === a.id ? 'out' : 'in', otherId: l.parent_id === a.id ? l.child_id : l.parent_id, otherName: l.parent_id === a.id ? l.child_name : l.parent_name }));
  const bname = (bid) => (bid ? q.get('SELECT name FROM buildings WHERE id = ?', bid)?.name : null);
  const located = a.building_id ? { buildingId: a.building_id, building: bname(a.building_id), floor: a.floor || null } : null;
  const serves = q.all('SELECT z.*, b.name AS building FROM asset_zones z JOIN buildings b ON b.id = z.building_id WHERE z.asset_id = ?', a.id).filter(activeLink)
    .map((z) => ({ id: z.id, buildingId: z.building_id, building: z.building, floor: z.floor }));
  const srcs = q.all('SELECT * FROM data_sources WHERE asset_id = ? AND active = 1 ORDER BY priority, created_at', a.id);
  // 同語意指標一起看（帳單的外購電量、智慧電表與手抄表的表計電量都是 kWh 用量）
  const peers = mainMetric ? q.all('SELECT code FROM metrics WHERE semantics = (SELECT semantics FROM metrics WHERE code = ?) AND std_unit = (SELECT std_unit FROM metrics WHERE code = ?) AND domain = (SELECT domain FROM metrics WHERE code = ?)', mainMetric, mainMetric, mainMetric).map((r) => r.code) : [];
  const latest = latestBySource(a.id, peers.length ? peers : mainMetric ? [mainMetric] : []);
  const childLatest = (cid) => {
    if (!peers.length) return null;
    const r = q.get(`SELECT period_start, period_end, value_std, std_unit FROM observations WHERE asset_id = ? AND quality_status NOT IN ('superseded','invalid')
      AND metric_code IN (${peers.map(() => '?').join(',')}) ORDER BY period_end DESC LIMIT 1`, cid, ...peers);
    return r ? { periodStart: r.period_start, periodEnd: r.period_end, value: r.value_std, unit: r.std_unit } : null;
  };
  for (const c of children) c.latest = childLatest(c.id);
  const sources = srcs.map((s) => {
    const l = latest.get(s.id);
    return { id: s.id, name: s.name, sourceType: s.source_type, kindLabel: SOURCE_KIND[s.source_type] || s.source_type, acquisition: s.acquisition, frequency: s.frequency, note: s.note,
      latest: l ? { periodStart: l.period_start, periodEnd: l.period_end, value: l.value_std, unit: l.std_unit, metric: l.metric_code } : null };
  });
  // 多源逐月比對（同語意指標一起比）
  let compare = null;
  if (mainMetric) {
    try {
      const c = comparison(ctx, a.id, { metricCode: mainMetric, from: `${y}-01-01`, to: `${y + 1}-01-01` });
      compare = { metric: c.metric?.name, unit: c.metric?.std_unit, months: c.aligned.map((m) => ({ month: m.month.slice(0, 7), values: m.values, relDiffPct: m.relDiffPct })) };
    } catch { compare = null; }
  }
  // 下游加總對本表（同一指標）
  let balance = null;
  if (mainMetric && children.length) {
    const sumMonth = (assetIds) => {
      if (!assetIds.length) return new Map();
      const rows = q.all(`SELECT asset_id, substr(period_start,1,7) m, SUM(value_std) v FROM observations WHERE asset_id IN (${assetIds.map(() => '?').join(',')})
        AND quality_status NOT IN ('superseded','invalid') AND metric_code IN (SELECT code FROM metrics WHERE semantics = (SELECT semantics FROM metrics WHERE code = ?) AND std_unit = (SELECT std_unit FROM metrics WHERE code = ?))
        AND period_start >= ? AND period_start < ? GROUP BY asset_id, m`, ...assetIds, mainMetric, mainMetric, `${y}-01-01`, `${y + 1}-01-01`);
      return rows;
    };
    const kids = sumMonth(children.map((c) => c.id));
    if (kids.length) {
      const months = new Map();
      for (const r of kids) months.set(r.m, (months.get(r.m) || 0) + r.v);
      balance = [...months.entries()].sort().map(([m, v]) => ({ month: m, children: v, reporting: kids.filter((k) => k.m === m).length, total: children.length }));
    }
  }
  // 異動歷程（原「異動登錄」）與最近登錄的數據（原「點位與進度」）
  const history = q.all('SELECT h.change_type, h.before, h.after, h.reason, h.at, h.actor, u.display_name AS actor_name FROM asset_history h LEFT JOIN users u ON u.id = h.actor WHERE h.asset_id = ? ORDER BY h.at DESC LIMIT 30', a.id)
    .map((h) => parseJson(h, ['before', 'after'])).map((h) => ({ ...h, changes: h.change_type === 'create' ? [] : describeChanges(a.asset_type, h.before || {}, h.after || {}) }));
  const recent = q.all(`SELECT o.id, o.metric_code, m.name AS metric_name, o.period_start, o.period_end, o.raw_value, o.raw_unit, o.value_std, o.std_unit, o.value_state, o.method, o.submitted_at, s.name AS source_name, u.display_name AS who
    FROM observations o LEFT JOIN metrics m ON m.code = o.metric_code LEFT JOIN data_sources s ON s.id = o.source_id LEFT JOIN users u ON u.id = o.submitted_by
    WHERE o.asset_id = ? AND o.quality_status <> 'superseded' ORDER BY o.period_end DESC, o.submitted_at DESC LIMIT 24`, a.id);
  return {
    history, recent,
    kind: 'asset', asset: { id: a.id, name: a.name, domain: a.domain, assetType: a.asset_type, typeLabel: typeLabel(a), itemCode: a.item_code, itemName: a.item_name,
      externalKey: a.external_key_sensitive ? null : a.external_key, multiplier: a.meter_multiplier, location: a.location || null, attrs: a.attrs, status: a.status, workStatus: a.work_status, parentId: a.parent_asset_id },
    path, children, links, located, serves, sources, metrics: metricRows(metricCodes), mainMetric, year: y, compare, balance,
    fields: fieldsFor({ asset: a0, metric: metric || null }),
  };
}

// 沿 parent_asset_id 找最上層（台電電號）名稱，樓層頁顯示「A1 分盤 ← 受電點 22.8kV」
function rootName(a) {
  let cur = a; const seen = new Set(); let top = null;
  while (cur?.parent_asset_id && !seen.has(cur.parent_asset_id)) { seen.add(cur.parent_asset_id); cur = q.get('SELECT id, name, parent_asset_id FROM assets WHERE id = ?', cur.parent_asset_id); if (cur) top = cur; }
  return top?.name || null;
}
export function zoneNode(ctx, orgId, id) {
  assertCan(ctx, 'view.internal', orgId);
  const [bid, floor] = String(id).split('|');
  const b = q.get('SELECT b.* FROM buildings b JOIN sites s ON s.id = b.site_id WHERE b.id = ? AND s.org_id = ?', bid, orgId);
  if (!b) throw notFound('建物');
  const bl = { ...parseJson(b, ['attrs']), floorList: parseFloors(b.floors) };
  const at = (rows) => rows.map((a) => ({ id: a.id, name: a.name, typeLabel: typeLabel(a), domain: a.domain, floor: a.floor }));
  const located = at(q.all(`SELECT * FROM assets WHERE building_id = ? AND status <> 'archived' ${floor ? 'AND floor = ?' : ''} ORDER BY domain, name`, bid, ...(floor ? [floor] : [])));
  const servedBy = q.all(`SELECT z.id AS zone_id, z.floor AS zfloor, z.valid_to AS zvalid_to, a.* FROM asset_zones z JOIN assets a ON a.id = z.asset_id WHERE z.building_id = ? AND a.status <> 'archived'
    ${floor ? 'AND (z.floor = ? OR z.floor IS NULL)' : ''} ORDER BY a.name`, bid, ...(floor ? [floor] : [])).filter((r) => activeLink({ valid_to: r.zvalid_to }))
    .map((r) => ({ zoneLinkId: r.zone_id, id: r.id, name: r.name, typeLabel: typeLabel(r), domain: r.domain, floor: r.zfloor, upstream: rootName(r) }));
  return { kind: floor ? 'floor' : 'building', building: { id: b.id, name: b.name, floors: b.floors, floorList: bl.floorList, floorAreaM2: b.floor_area_m2, outdoor: bl.attrs?.zoneKind === 'outdoor', attrs: bl.attrs },
    floor: floor || null, located, servedBy, fields: floor ? [] : fieldsFor({ zone: true }) };
}

// ── 管理：供電／供水範圍（網狀關係）──
export function addZoneLink(ctx, { assetId, buildingId, floor }) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', assetId); if (!a) throw notFound('標的');
  assertCan(ctx, 'asset.write', a.org_id);
  const b = q.get('SELECT b.id FROM buildings b JOIN sites s ON s.id = b.site_id WHERE b.id = ? AND s.org_id = ?', buildingId, a.org_id);
  if (!b) throw bad('建物不屬於這個院所');
  const f = floor || null;
  if (q.get('SELECT 1 FROM asset_zones WHERE asset_id = ? AND building_id = ? AND IFNULL(floor,\'\') = IFNULL(?,\'\') AND (valid_to IS NULL OR valid_to > ?)', assetId, buildingId, f, today())) return { ok: true, existed: true };
  const id = newId('zon');
  insert('asset_zones', { id, asset_id: assetId, building_id: buildingId, floor: f, relation: 'serves', valid_from: today(), valid_to: null, created_by: ctx.userId, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: a.org_id, action: 'asset.zone_link', targetType: 'asset', targetId: assetId, after: { buildingId, floor: f } });
  return { id };
}
export function endZoneLink(ctx, id) {
  const z = q.get('SELECT z.*, a.org_id FROM asset_zones z JOIN assets a ON a.id = z.asset_id WHERE z.id = ?', id); if (!z) throw notFound('供應範圍');
  assertCan(ctx, 'asset.write', z.org_id);
  update('asset_zones', id, { valid_to: today() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: z.org_id, action: 'asset.zone_unlink', targetType: 'asset', targetId: z.asset_id, before: z });
  return { ok: true };
}
