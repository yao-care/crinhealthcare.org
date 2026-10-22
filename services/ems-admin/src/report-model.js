// 申報與報告的資料推導（純函式，不碰檔案）：R6／R7 自動帶入、措施與計畫的畫面樣子、
// 電費單月彙整（表五之二）、冰水機群組月效率（表九之一（二））。
//
// R6／R7 自動帶入的列用「決定性 id」：
//   R6 設備汰換  m-eq-<設備 id>     R7 節能計畫  p-<措施 id>
// 所以讀取時可以直接補進畫面（不必為了 GET 寫檔），使用者一編輯就落地成同一個 id，
// 措施 ID 從診斷報告一路貫穿到節能計畫、表十一、表十都不會換號。
import { MEASURE_TYPES, energyUnit } from './report-schema.js';
import { categoryById } from './inventory-schema.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;
const num = (v) => C.num(v);

// 台灣日曆日的今天（ISO）
export const todayIso = (now = Date.now()) => new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 提報年度（民國）：診斷報告提報日期的年度；沒填用今年
export function reportYearOf(inv, today = todayIso()) {
  const d = C.parseDate(inv.diagnosis?.reportDate) || C.parseDate(today);
  return d.getUTCFullYear() - 1911;
}

export function diagnosisOf(inv) {
  const d = inv.diagnosis && typeof inv.diagnosis === 'object' && !Array.isArray(inv.diagnosis) ? inv.diagnosis : {};
  return { period: '第一期', ...d, teams: Array.isArray(d.teams) ? d.teams : [] };
}

const buildingName = (inv, id) => (inv.site.buildings || []).find((b) => b.id === id)?.name || '';

// ── 設備 → 措施欄位預設值 ──
// R6 類別（設備主檔 → 螢光燈具／LED 燈具／公用設備／其他）一律走 inventory-compute.js 的 equipmentReplaceCategory
const equipmentReplaceCategory = (eq) => C.equipmentReplaceCategory(eq);

export function equipmentDefaults(eq) {
  if (!eq) return {};
  const f = eq.fields || {};
  const lighting = eq.category === 'lighting';
  return {
    name: f.name, brand: f.brand, model: lighting ? f.tubeType : f.model, madeYear: f.madeYear,
    capacity: lighting ? f.wattPerFixture : f.capacity, capacityUnit: lighting ? 'W/具' : f.capacityUnit,
    qty: f.qty, hoursPerYear: f.hoursPerYear,
  };
}

// 設備的 R6 判定
export function r6For(eq, reportYear, override) {
  return C.replacementRequired({ category: override || equipmentReplaceCategory(eq), mfgYear: eq?.fields?.madeYear, reportYear });
}

// ── 補上 R6／R7 自動帶入的列（直接改 inv；GET 時傳複本）──
export function materialize(inv, reportYear) {
  inv.measures ||= []; inv.plans ||= [];
  const now = new Date().toISOString();
  for (const eq of inv.equipment) {
    if (eq.status && eq.status !== 'active') continue;
    if (inv.measures.some((m) => m.equipmentId === eq.id)) continue;
    if (r6For(eq, reportYear).value !== true) continue;
    inv.measures.push({ id: `m-eq-${eq.id}`, type: 'replace', equipmentId: eq.id, origin: 'r6', fields: {}, createdAt: now, updatedAt: now });
  }
  for (const m of inv.measures) {
    if (inv.plans.some((p) => p.measureId === m.id)) continue;
    if (C.planMandatory(paybackOf(m, inv).value).value !== true) continue;
    inv.plans.push({ id: `p-${m.id}`, measureId: m.id, origin: 'r7', fields: {}, versions: [], createdAt: now, updatedAt: now });
  }
  return inv;
}

// 措施的實際欄位值：措施自己填的優先，設備汰換沒填的格子沿用設備主檔
export function measureValues(m, inv) {
  const eq = m.equipmentId ? inv.equipment.find((e) => e.id === m.equipmentId) : null;
  const base = m.type === 'replace' ? equipmentDefaults(eq) : {};
  const out = { energyType: 'E01', ...Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined && v !== '')) };
  for (const [k, v] of Object.entries(m.fields || {})) if (v !== undefined && v !== '') out[k] = v;
  return out;
}
export const paybackOf = (m, inv) => { const v = measureValues(m, inv); return C.paybackYears(v.investment, v.savingCost); };

// 一筆措施給畫面／報表的樣子
export function measureView(m, inv, reportYear, no) {
  const eq = m.equipmentId ? inv.equipment.find((e) => e.id === m.equipmentId) : null;
  const values = measureValues(m, inv);
  const payback = C.paybackYears(values.investment, values.savingCost);
  let r6 = null, mandatory = false;
  if (m.type === 'replace') {
    // R6 以設備主檔的製造年份判定（措施上的製造年份只是帶出來給報表看）；沒連設備就用措施自己的
    r6 = eq ? r6For(eq, reportYear, m.fields?.replaceCategory)
      : C.replacementRequired({ category: values.replaceCategory, mfgYear: values.madeYear, reportYear });
    mandatory = Boolean(eq && (!eq.status || eq.status === 'active') && r6.value === true);
  }
  const plan = (inv.plans || []).find((p) => p.measureId === m.id) || null;
  return {
    id: m.id, type: m.type, typeLabel: MEASURE_TYPES[m.type]?.label, no, origin: m.origin || 'manual',
    equipmentId: m.equipmentId || null,
    equipment: eq ? { id: eq.id, name: eq.fields?.name || '', category: eq.category, categoryLabel: categoryById(eq.category)?.label, kind: eq.kind, status: eq.status, madeYear: eq.fields?.madeYear, building: buildingName(inv, eq.building) } : null,
    fields: m.fields || {}, values, unit: energyUnit(values.energyType),
    replaceCategory: m.type === 'replace' ? (m.fields?.replaceCategory || equipmentReplaceCategory(eq) || values.replaceCategory || '') : undefined,
    payback, r6, mandatory,
    deletable: !mandatory,
    deleteBlockedBy: mandatory ? r6 : null,
    planId: plan?.id || null,
    planMandatory: C.planMandatory(payback.value),
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

export function measuresView(inv, reportYear) {
  const out = { replace: [], operation: [] };
  for (const m of inv.measures || []) {
    const list = out[m.type];
    if (!list) continue;
    list.push(measureView(m, inv, reportYear, list.length + 1));
  }
  return out;
}

export function planView(p, inv, reportYear, no, mviews) {
  const mv = mviews ? [...mviews.replace, ...mviews.operation].find((x) => x.id === p.measureId) : null;
  const m = mv ? null : (inv.measures || []).find((x) => x.id === p.measureId);
  const view = mv || (m ? measureView(m, inv, reportYear) : null);
  const payback = view?.payback?.value;
  const check = C.planRowCheck({ paybackYears: payback, completionYear: p.fields?.completionYear, note: p.fields?.note, reportYear });
  const mandatory = Boolean(view) && C.planMandatory(payback).value === true;
  const values = view?.values || {};
  return {
    id: p.id, no, measureId: p.measureId, origin: p.origin || 'manual',
    measure: view ? { id: view.id, type: view.type, typeLabel: view.typeLabel, no: view.no, name: values.name || '' } : null,
    name: values.name || '（措施已刪除）',
    annualSaving: values.annualSaving, unit: view?.unit || '', energyType: values.energyType,
    investment: values.investment, savingCost: values.savingCost, paybackYears: payback, payback: view?.payback || null,
    fields: { status: '規劃中', ...(p.fields || {}), officialCode: p.fields?.officialCode || values.officialCode || '' },
    check, mandatory, deletable: !mandatory,
    range: [reportYear, reportYear + C.PLAN_SPAN_YEARS],
    versions: p.versions || [],
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

export function plansView(inv, reportYear, mviews = measuresView(inv, reportYear)) {
  return (inv.plans || []).map((p, i) => planView(p, inv, reportYear, i + 1, mviews));
}

// ── 電費單月彙整（表五之二）──
// 從 bill 型項目的紀錄取值；月份以帳單載明的計費期間為準（附表三：申報月份＝帳單載明月份），沒有才用紀錄期別。
// 同一電號同一月份有多筆（重送、更正）→ 取最後送出的那筆，不加總。
const BILL_NUM = ['contractCapacity', 'demandPeak', 'demandHalfPeak', 'demandSatHalfPeak', 'demandOffPeak', 'powerFactor',
  'usePeak', 'useHalfPeak', 'useSatHalfPeak', 'useOffPeak', 'wheelPeak', 'wheelHalfPeak', 'wheelSatHalfPeak', 'wheelOffPeak', 'feeTotal'];
const sum = (arr) => { const xs = arr.map(num).filter((v) => v !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined; };
const max = (arr) => { const xs = arr.map(num).filter((v) => v !== undefined); return xs.length ? Math.max(...xs) : undefined; };

export function billMonths(inv) {
  const meters = inv.site.meters || [];
  const byKey = new Map();   // `${meterKey}|${YYYY-MM}` → { at, bill, recordId }
  for (const r of inv.records || []) {
    const point = inv.points.find((p) => p.code === r.pointCode);
    for (const it of point?.items || []) {
      if (it.type !== 'bill') continue;
      const b = r.values?.[it.id]?.values;
      if (!b) continue;
      const month = /^\d{4}-\d{2}$/.test(String(b.period || '')) ? b.period : r.period;
      const meter = (it.meterId && meters.find((m) => m.id === it.meterId)) || meters.find((m) => m.meterNo && String(m.meterNo) === String(b.meterNo || '')) || null;
      const meterKey = meter?.id || `no:${b.meterNo || '未指定電號'}`;
      const key = `${meterKey}|${month}`;
      const prev = byKey.get(key);
      if (!prev || String(r.at) > String(prev.at)) byKey.set(key, { at: r.at, bill: b, recordId: r.id, meterKey, meter, meterNo: meter?.meterNo || b.meterNo || '', month, pointCode: r.pointCode });
    }
  }
  const out = new Map();   // meterKey → { meter, meterNo, months: Map(YYYY-MM → row) }
  for (const x of byKey.values()) {
    if (!out.has(x.meterKey)) out.set(x.meterKey, { meterKey: x.meterKey, meter: x.meter, meterNo: x.meterNo, tariffType: x.bill.tariffType, months: new Map() });
    const b = x.bill;
    const row = Object.fromEntries(BILL_NUM.map((k) => [k, num(b[k])]));
    row.maxDemand = max([b.demandPeak, b.demandHalfPeak, b.demandSatHalfPeak, b.demandOffPeak]);
    row.useTotal = sum([b.usePeak, b.useHalfPeak, b.useSatHalfPeak, b.useOffPeak]);
    row.wheelTotal = sum([b.wheelPeak, b.wheelHalfPeak, b.wheelSatHalfPeak, b.wheelOffPeak]);
    row.recordId = x.recordId;
    out.get(x.meterKey).months.set(x.month, row);
  }
  // 有建電號但沒有任何電費單的，也要一張（空白）表
  for (const m of meters) if (!out.has(m.id)) out.set(m.id, { meterKey: m.id, meter: m, meterNo: m.meterNo || '', months: new Map() });
  return [...out.values()];
}

// 資料年 N（民國）的 12 個月
export const monthsOfRoc = (n) => Array.from({ length: 12 }, (_, i) => `${n + 1911}-${String(i + 1).padStart(2, '0')}`);

// 全院每月合計度數：{ 'YYYY-MM': kWh }
export function monthlyKwh(meterSheets) {
  const out = {};
  for (const s of meterSheets) for (const [mo, r] of s.months) if (r.useTotal !== undefined) out[mo] = (out[mo] || 0) + r.useTotal;
  return out;
}

// ── 冰水機群組 ──
// 群組名稱來自設備主檔（chillerGroup 欄）與點位項目（chillerGroup 屬性）的聯集
export function chillerGroups(inv) {
  const groups = new Map();
  const add = (name, eq) => {
    const n = String(name || '').trim();
    if (!n) return;
    if (!groups.has(n)) groups.set(n, { name: n, building: '', equipment: [], items: [] });
    const g = groups.get(n);
    if (eq) { g.equipment.push(eq); if (!g.building && eq.building) g.building = buildingName(inv, eq.building); }
  };
  for (const eq of inv.equipment) if (!eq.status || eq.status === 'active') add(eq.fields?.chillerGroup, eq);
  for (const p of inv.points) for (const it of p.items) if (it.chillerGroup) { add(it.chillerGroup); groups.get(it.chillerGroup).items.push({ point: p.code, item: it }); }
  for (const g of groups.values()) {
    // 群組總容量：中央空調主機（含備用機）容量 × 數量，單位要是 RT 才算
    const caps = g.equipment.filter((e) => e.kind === '中央空調主機' && /RT|冷凍噸/i.test(String(e.fields?.capacityUnit || '')))
      .map((e) => (num(e.fields?.capacity) ?? 0) * (num(e.fields?.qty) ?? 1));
    g.totalRt = caps.length ? caps.reduce((a, b) => a + b, 0) : undefined;
  }
  return [...groups.values()];
}

// 某群組某月的 kWh／RTh：該月所有紀錄的值加總（reading 型取用量、number 型取數值）
export function chillerMonth(inv, groupName, month) {
  const acc = { kwh: [], rth: [] };
  for (const p of inv.points) {
    const items = p.items.filter((it) => it.chillerGroup === groupName && it.chillerRole);
    if (!items.length) continue;
    for (const r of inv.records) {
      if (r.pointCode !== p.code || r.period !== month) continue;
      for (const it of items) {
        const v = it.type === 'reading' ? r.usage?.[it.id] : r.values?.[it.id];
        if (typeof v === 'number') acc[it.chillerRole].push(v);
      }
    }
  }
  const kwh = sum(acc.kwh), rth = sum(acc.rth);
  return { kwh, rth, eff: C.chillerEfficiency(kwh, rth) };
}
