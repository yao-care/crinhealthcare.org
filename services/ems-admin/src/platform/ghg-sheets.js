// 環境部溫室氣體盤查表單（院方原本填的 Excel，頁籤：類別1(固定)、類別1(移動)、類別1(製程)、類別1(冷煤)、類別1(其它)、
// 類別1(化糞池調查表)、類別2(用電量)…）兩件事：
//
// 1. 匯入（importWorkbook）：每一列對到盤點標的與原始觀測——車輛一車一標的、每張加油單一筆觀測；冷媒設備一台（一列）一標的；
//    電費單一個月一筆。已有的標的（發電機油槽、CO₂ 鋼瓶、滅火器、化糞池、營運數據、電號）沿用，不重建。
//    觀測的來源紀錄鍵＝年度＋頁籤＋列號，同一份（或改過的）表重匯不會重複：值相同略過，值不同成為新版本。
//    原檔每一列另存 ghg_sheet_rows（只記原檔長相與對到哪些觀測），盤點樹「依盤查表單頁籤」照原檔欄位排出。
// 2. 頁籤檢視（tabsTree、tabView）：左欄依頁籤列標的、中欄照原檔欄位列出該年的資料；沒有原檔的年度改列系統裡的觀測。
//
// 表單範本內建的範例列（編號「範例」、冷煤頁「門市部」兩列）不匯入；隱藏頁籤（類別3～5、外購蒸氣、自來水、厭氧水處理）
// 在範本裡是範例資料，院方沒填就不匯入。
import { q, insert, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, can } from './authz.js';
import { bad, notFound, j, round, addDays } from './util.js';
import { readWorkbook, parseRef } from '../xlsx.js';
import { createAsset, updateAsset, setApplicability } from './assets.js';
import { addObservation } from './observations.js';
import { storeEvidence } from './evidence.js';
import { ASSET_TYPES } from './seed/dictionary.js';

// ── 頁籤 ──
// items：哪些盤點項目屬於這一頁；optional：院方範本裡是隱藏頁，有標的才列
export const TABS = [
  { key: 'stationary', name: '類別1(固定)', title: '固定燃燒（發電機、鍋爐、爐具）', items: ['OIL-GEN', 'OIL-BOILER', 'GAS-NG', 'GAS-LPG'] },
  { key: 'mobile', name: '類別1(移動)', title: '移動燃燒（公務車、救護車、機具；含車用尿素）', items: ['OIL-VEH', 'OIL-FORK'] },
  { key: 'process', name: '類別1(製程)', title: '製程排放（CO₂ 鋼瓶、混合氣體、笑氣、WD-40）', items: ['GAS-MED', 'OIL-LUBE'] },
  { key: 'refrigerant', name: '類別1(冷煤)', title: '冷媒逸散（冷氣、冰水主機、冰箱、公務車空調）', items: ['GAS-REF'] },
  { key: 'other', name: '類別1(其它)', title: '滅火器與 GCB 氣體斷路器', items: ['GAS-FIRE', 'GAS-GCB'] },
  { key: 'septic', name: '類別1(化糞池調查表)', title: '化糞池（在院人時）', items: ['WAT-SEPTIC', 'ACT-STAFF', 'ACT-PATIENT'] },
  { key: 'electricity', name: '類別2(用電量)', title: '外購電力（各電號每月電費單）', items: ['ELE-GRID'] },
  { key: 'steam', name: '類別2(外購蒸氣)', title: '外購蒸汽', items: ['ELE-HEAT'], optional: true },
  { key: 'water', name: '類別4(自來水)', title: '自來水與其他水源', items: ['WAT-TAP', 'WAT-GROUND'], optional: true },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.key, t]));
const SHEET_TAB = Object.fromEntries(TABS.map((t) => [t.name, t.key]));

export function tabOf(a) {
  const attrs = typeof a.attrs === 'string' ? j(a.attrs, {}) : a.attrs || {};
  if (attrs.ghgTab && TAB[attrs.ghgTab]) return attrs.ghgTab;
  if (a.item_code === 'GAS-MED' && /尿素/.test(a.name || '')) return 'mobile';
  return TABS.find((t) => t.items.includes(a.item_code))?.key || null;
}

// 每頁在畫面上的「系統合計」用哪些指標（年總量）
const TAB_METRICS = {
  stationary: ['oil_consumption_l', 'oil_purchase_l', 'ng_consumption_m3', 'lpg_consumption_kg'],
  mobile: ['oil_consumption_l', 'co2_use_kg'],
  process: ['co2_use_kg', 'n2o_use_kg', 'lubricant_use_kg'],
  refrigerant: ['ref_recharge_kg'],
  other: ['fire_ext_refill_kg', 'insul_gas_recharge_kg'],
  septic: ['staff_hours', 'outpatient_visits', 'inpatient_days'],
  electricity: ['elec_purchased_kwh', 'elec_metered_kwh'],
  steam: ['imported_energy_gj'],
  water: ['water_withdrawal_m3', 'water_metered_m3'],
};

// 原檔欄位（頁籤檢視照這個順序列；date＝Excel 日期序號轉日期）
const COLS = {
  stationary: { '': [['G', '據點名稱'], ['H', '設備所在棟別'], ['I', '設備所在樓層'], ['J', '型式'], ['K', '型號'], ['L', '台數'], ['M', '燃料'], ['N', '日期／用量', 'date'], ['O', '燃料量（公升、m³）', 'num'], ['P', '資料來源'], ['Q', '資料存放處'], ['R', '備註']] },
  mobile: { '': [['G', '車種'], ['H', '型號'], ['I', '車號'], ['J', '日期／用量', 'date'], ['K', '油品'], ['L', '金額', 'num'], ['M', '公升', 'num'], ['N', '資料來源'], ['O', '資料存放處'], ['P', '備註']] },
  process: { '': [['F', '日期／用量', 'date'], ['G', '設備'], ['H', '品名'], ['I', '規格'], ['N', '使用量', 'num'], ['O', '數量', 'num'], ['P', '單位'], ['Q', '密度', 'num'], ['R', '純度', 'num'], ['S', '是否鋼瓶'], ['T', '殘餘量', 'num'], ['U', '活動數據（kg）', 'num'], ['V', '資料來源'], ['W', '資料存放處'], ['X', '備註']] },
  refrigerant: { '': [['E', '編號'], ['F', '部門'], ['G', '設備位置'], ['H', '設備名稱'], ['I', '逸散類型'], ['J', '品牌'], ['K', '型號'], ['L', '冷媒'], ['M', '原始冷媒量（kg）', 'num'], ['N', '數量（台）', 'num'], ['O', '停用（台）', 'num'], ['S', '補充冷媒量（kg）', 'num'], ['T', '新購冷媒量（kg）', 'num'], ['U', '新購（台）', 'num'], ['V', '佐證資料'], ['W', '資料存放處'], ['X', '冷氣能力（kW）'], ['Y', '額定消耗電功率（kW）'], ['Z', '備註'], ['AA', '活動數據（kg）', 'num']] },
  other: {
    fire: [['E', '編號'], ['F', '設備位置'], ['G', '所在樓層'], ['H', '滅火器型式'], ['I', '型式（P）'], ['J', '數量（支）', 'num'], ['K', '停用', 'num'], ['L', '原始填充量', 'num'], ['M', '補充填充量（kg/瓶）', 'num'], ['N', '發票號碼'], ['O', '補充／購入日期', 'date'], ['P', '資料來源'], ['Q', '資料存放處'], ['R', '方法一活動數據（kg）', 'num'], ['S', '方法二活動數據（kg）', 'num']],
    gcb: [['AC', '設備所在棟別'], ['AD', '設備所在樓層'], ['AE', '斷路器種類'], ['AF', '型式'], ['AG', 'SF₆ 氣體量重（kg）', 'num'], ['AH', '年洩漏率', 'num'], ['AI', '活動數據（kg）', 'num'], ['AJ', '資料來源'], ['AK', '資料存放處'], ['AL', '備註']],
  },
  septic: { '': [['B', '據點名稱'], ['C', '備註'], ['D', '是否為自用'], ['E', '整年上班天數', 'num'], ['F', '是否輪班'], ['G', '早班人數', 'num'], ['H', '午班人數', 'num'], ['I', '小夜人數', 'num'], ['J', '晚班人數', 'num'], ['K', '早班時數', 'num'], ['L', '午班時數', 'num'], ['M', '小夜時數', 'num'], ['N', '晚班時數', 'num'], ['O', '總人時（hr）', 'num'], ['P', '總溫室氣體（公噸CO₂e/年）', 'num']] },
  electricity: { meter: [['_acct', '電號'], ['A', '收據月份'], ['B', '用電期間起', 'date'], ['C', '用電期間迄', 'date'], ['D', '天數', 'num'], ['E', '尖峰度數', 'num'], ['F', '半尖峰度數', 'num'], ['G', '週六半尖峰度數', 'num'], ['H', '離峰度數', 'num'], ['I', '合計用電量', 'num'], ['L', '當月實際用電量（度）', 'num']] },
};
const PART_TITLE = { fire: '滅火器填充數量清冊', gcb: '斷路器填充數量清冊', meter: '每月電費單' };

// ── 儲存格工具 ──
const s = (v) => String(v ?? '').trim();
const num = (v) => { const t = s(v).replace(/,/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const r4 = (v) => round(v, 4);
const n6 = (v) => { const x = num(v); return x === null ? s(v) : String(round(x, 6)); };
function serialToDate(n) { return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10); }
// 回 { date, fixed }：Excel 序號、2023/1/26、2023-01-26；原檔打錯的「2023/126」「2023/8/8/」盡量讀，fixed 記原文字
export function readDate(v) {
  const t = s(v);
  if (!t) return { date: null };
  if (/^\d{5}(\.\d+)?$/.test(t)) return { date: serialToDate(Number(t)) };
  const pad = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(t);
  if (m) return { date: pad(+m[1], +m[2], +m[3]) };
  m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[/-]+$/.exec(t);
  if (m) return { date: pad(+m[1], +m[2], +m[3]), fixed: t };
  m = /^(\d{4})[/-](\d)(\d{2})$/.exec(t); // 2023/126 → 1 月 26 日
  if (m) return { date: pad(+m[1], +m[2], +m[3]), fixed: t };
  return { date: null };
}
function sheetCells(wb, name) {
  const sh = wb.sheets.get(name) || [...wb.sheets.entries()].find(([k]) => k.trim() === name)?.[1];
  if (!sh) return null;
  const rows = new Map();
  for (const [ref, v] of sh.cells) { const { row } = parseRef(ref); const col = ref.replace(/\d+$/, ''); if (!rows.has(row)) rows.set(row, {}); rows.get(row)[col] = v; }
  return rows;
}
const pickCols = (row, cols) => Object.fromEntries(cols.map(([c]) => [c, row[c]]).filter(([, v]) => s(v) !== ''));

// ── 對照 ──
const FUEL = { 柴油: 'diesel', 超級柴油: 'diesel', '95汽油': 'gasoline', '92汽油': 'gasoline', '98汽油': 'gasoline', 汽油: 'gasoline', 液化石油氣: 'lpg', 液化天然氣: 'ng', 天然氣: 'ng', 燃料油: 'fuel_oil' };
const FUEL_ZH = { diesel: '柴油', gasoline: '車用汽油', lpg: '液化石油氣', ng: '天然氣', fuel_oil: '燃料油' };
const normRef = (g) => { const t = s(g).toUpperCase().replace(/\s/g, ''); const m = /^R-?(\d+[A-Z]?)$/.exec(t); if (!m) return s(g); const k = m[1]; return `R-${/^\d+A$/.test(k) && k !== '134A' ? k : k.replace(/A$/, 'a')}`; };
const REF_TYPE = (name) => (/冰水|熱泵|主機/.test(name) ? 'chiller' : /冰箱|冷凍|冷藏|製冰/.test(name) ? 'refrigerator' : /飲水/.test(name) ? 'water_dispenser' : /除濕|乾燥/.test(name) ? 'dryer' : /車/.test(name) ? 'vehicle_ac' : 'split_ac');
// 範本內建的冷煤範例列（院方沒刪）
const REF_EXAMPLES = new Set(['會議室A201冷氣機', '大辦公室立式冷氣機(右)']);
// 車用尿素：比照 2025 年報告書參數（濃度 17.5%、比重 1.09），CO₂＝公升 × 比重 × 濃度 × 44.01/60.06
export const UREA = { density: 1.09, conc: 0.175 };
const ureaCo2 = (l) => r4(l * UREA.density * UREA.conc * 44.01 / 60.06);

// ── 解析：原檔 → 計畫（不寫入）──
// 回 { year, rows: [{ tab, sheet, part, row, cells, target, obs: [...] , note }], skipped: [...], totals }
// target：{ match: {...} 找既有標的的條件, create: {...} 找不到時建的標的 }
// sheets：Map<頁籤名, Map<列號, 儲存格>>，給院所頁編修後重算用（不讀 Excel）
export function planWorkbook(buf, { year, sheets } = {}) {
  const wb = sheets ? null : readWorkbook(buf);
  const sheetOf = (name) => (sheets ? sheets.get(name) || null : sheetCells(wb, name));
  const out = []; const skipped = []; const totals = {};
  const Y = year || (wb && detectYear(wb));
  if (!Y) throw bad('看不出這份盤查表單是哪一年（用電量頁 A1 或冷煤頁標題），請指定年度');
  const yr = [`${Y}-01-01`, `${Y + 1}-01-01`];
  const ann = (metric, value, extra = {}) => ({ metric, start: yr[0], end: yr[1], value, ...extra });
  const push = (tab, sheet, part, row, cells, target, obs, note) => out.push({ tab, sheet, part, row, cells, target, obs, note });

  // 類別1(固定)
  const fx = sheetOf('類別1(固定)');
  if (fx) {
    totals.stationary = sumBlock(fx, 2, 20, ['A', 'B'], 'D');
    const tank = new Map();
    for (const [r, c] of fx) {
      if (r < 4 || s(c.F) === '範例' || !s(c.J) || num(c.O) === null) continue;
      const fuel = FUEL[s(c.M)]; if (!fuel) { skipped.push({ sheet: '類別1(固定)', row: r, why: `不認得的燃料「${s(c.M)}」` }); continue; }
      const gen = /發電機/.test(s(c.J));
      const target = gen && fuel === 'diesel'
        ? { match: { itemCode: 'OIL-GEN', assetType: 'fuel_tank', fuel }, create: { itemCode: 'OIL-GEN', assetType: 'fuel_tank', name: '緊急發電機柴油（全院合計）', attrs: { fuel } } }
        : { match: { legacyRef: `ghgwb:stationary:${s(c.J)}:${fuel}` }, create: { itemCode: gen ? 'OIL-GEN' : fuel === 'lpg' ? 'GAS-LPG' : fuel === 'ng' ? 'GAS-NG' : 'OIL-BOILER', assetType: gen ? 'fuel_tank' : fuel === 'lpg' ? 'lpg_cylinder' : fuel === 'ng' ? 'gas_account' : 'boiler', name: `${s(c.J)} ${s(c.M)}`, attrs: { fuel }, legacyRef: `ghgwb:stationary:${s(c.J)}:${fuel}` } };
      const d = readDate(c.N);
      const metric = fuel === 'ng' ? 'ng_consumption_m3' : fuel === 'lpg' ? 'lpg_purchase_kg' : 'oil_purchase_l';
      const unit = fuel === 'ng' ? 'Nm3' : fuel === 'lpg' ? 'kg' : 'L';
      const o = d.date ? { metric, start: d.date, end: addDays(d.date, 1), value: num(c.O), unit } : ann(metric, num(c.O), { unit });
      o.note = [s(c.H), s(c.L) && `${s(c.L)} 台`, s(c.P) && `${s(c.P)}（${s(c.Q)}）`, d.fixed && `原檔日期「${d.fixed}」`].filter(Boolean).join('；');
      o.source = { name: s(c.P) || '盤查表單', location: s(c.Q) };
      const key = target.create.name;
      if (!tank.has(key)) tank.set(key, { target, sum: 0, fuel, rows: [] });
      tank.get(key).sum += num(c.O); tank.get(key).rows.push(r);
      push('stationary', '類別1(固定)', '', r, pickCols(c, COLS.stationary['']), target, [o]);
    }
    // 盤查表單以全年購油量為消耗量：另記一筆全年消耗（計算用）
    for (const t of tank.values()) {
      if (!['diesel', 'gasoline', 'fuel_oil'].includes(t.fuel)) continue;
      push('stationary', '類別1(固定)', 'sum', t.rows[0], {}, t.target, [ann('oil_consumption_l', r4(t.sum), { unit: 'L', note: `盤查表單以全年購油量計（第 ${t.rows.join('、')} 列合計）`, source: { name: '盤查表單（全年購油量）' } })], 'summary');
    }
  }

  // 類別1(移動)
  const mv = sheetOf('類別1(移動)');
  if (mv) {
    totals.mobile = sumBlock(mv, 2, 6, ['A', 'B'], 'D');
    const data = [...mv].filter(([r, c]) => r >= 5 && s(c.F) !== '範例' && s(c.I) && s(c.K) && num(c.M) !== null);
    // 一車一標的；同一車號有兩種油（汽油車加了柴油）時分成兩個標的（油種決定排放係數）
    const kindOf = new Map(); const fuels = new Map();
    for (const [, c] of data) {
      const plate = s(c.I); if (s(c.K) === '尿素') continue;
      const k = kindOf.get(plate) || new Map(); k.set(s(c.G), (k.get(s(c.G)) || 0) + 1); kindOf.set(plate, k);
      const f = fuels.get(plate) || new Map(); const fu = FUEL[s(c.K)]; f.set(fu, (f.get(fu) || 0) + 1); fuels.set(plate, f);
    }
    const major = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const [r, c] of data) {
      const plate = s(c.I); const L = num(c.M); const d = readDate(c.J);
      const period = d.date ? { start: d.date, end: addDays(d.date, 1) } : { start: yr[0], end: yr[1] };
      const src = { name: s(c.N) || '加油單據', location: s(c.O) };
      if (s(c.K) === '尿素') {
        const target = { match: { itemCode: 'GAS-MED', nameLike: '尿素' }, create: { itemCode: 'GAS-MED', assetType: 'gas_supply', name: '車用尿素水解', attrs: { note: `車用尿素濃度 ${UREA.conc * 100}%、比重 ${UREA.density}，以質量平衡法換算水解 CO₂` } } };
        push('mobile', '類別1(移動)', '', r, pickCols(c, COLS.mobile['']), target, [{ metric: 'co2_use_kg', ...period, value: ureaCo2(L), unit: 'kg', source: src,
          note: `${plate} 車用尿素 ${L} 公升 × 比重 ${UREA.density} × 濃度 ${UREA.conc * 100}% × 44.01/60.06（比照 2025 年報告書參數）` }]);
        continue;
      }
      const fuel = FUEL[s(c.K)]; if (!fuel) { skipped.push({ sheet: '類別1(移動)', row: r, why: `不認得的油品「${s(c.K)}」` }); continue; }
      const main = major(fuels.get(plate)); const kind = major(kindOf.get(plate));
      const second = fuel !== main;
      const grades = [...new Set(data.filter(([, x]) => s(x.I) === plate && FUEL[s(x.K)] === fuel).map(([, x]) => s(x.K)))];
      const name = `${kind} ${plate}${second ? `（${FUEL_ZH[fuel]}）` : ''}`;
      const lref = `ghgwb:vehicle:${plate}:${fuel}`;
      const target = { match: { legacyRef: lref, ...(second ? {} : { assetType: 'vehicle', externalKey: plate }) },
        create: { itemCode: 'OIL-VEH', assetType: 'vehicle', name, externalKey: second ? null : plate, legacyRef: lref,
          attrs: { fuel, fuelGrade: grades.join('／'), plate, vehicleKind: kind, ...(s(c.H) ? { model: s(c.H) } : {}), ...(second ? { note: `同車號另有${FUEL_ZH[main]}紀錄，油種不同分開計算` } : {}) } } };
      const note = [s(c.K), d.fixed && `原檔日期「${d.fixed}」`, s(c.P)].filter(Boolean).join('；');
      const obs = [{ metric: 'oil_consumption_l', ...period, value: L, unit: 'L', source: src, note }];
      if (num(c.L) !== null) obs.push({ metric: 'oil_cost_twd', ...period, value: num(c.L), unit: 'TWD', source: src, note: s(c.K) });
      push('mobile', '類別1(移動)', '', r, pickCols(c, COLS.mobile['']), target, obs);
    }
  }

  // 類別1(製程)
  const pr = sheetOf('類別1(製程)');
  if (pr) {
    totals.process = sumBlock(pr, 3, 12, ['A'], 'C');
    for (const [r, c] of pr) {
      if (r < 3 || s(c.E) === '範例' || !s(c.H) || !s(c.F)) continue;
      const item = s(c.H); const kg = num(c.U);
      const metric = /CO2|二氧化碳|混和氣體|混合氣體/i.test(item) ? 'co2_use_kg' : /笑氣|N2O/i.test(item) ? 'n2o_use_kg' : /WD-?40|潤滑|噴霧/i.test(item) ? 'lubricant_use_kg' : null;
      if (!metric) { push('process', '類別1(製程)', '', r, pickCols(c, COLS.process['']), null, [], `${item} 不屬京都議定書溫室氣體，不計`); continue; }
      if (!kg) { push('process', '類別1(製程)', '', r, pickCols(c, COLS.process['']), null, [], '活動數據為 0'); continue; }
      const target = metric === 'lubricant_use_kg'
        ? { match: { itemCode: 'OIL-LUBE' }, create: { itemCode: 'OIL-LUBE', assetType: 'product', name: '潤滑油及噴霧產品' } }
        : { match: { itemCode: 'GAS-MED', assetType: 'gas_cylinder' }, create: { itemCode: 'GAS-MED', assetType: 'gas_cylinder', name: metric === 'n2o_use_kg' ? '笑氣（N₂O）鋼瓶' : 'CO₂ 與混合氣體鋼瓶' } };
      if (metric === 'n2o_use_kg') target.match = { itemCode: 'GAS-MED', assetType: 'gas_cylinder', nameLike: '笑氣' };
      const d = readDate(c.F);
      const period = d.date ? { start: d.date, end: addDays(d.date, 1) } : { start: yr[0], end: yr[1] };
      const note = [`${item} ${s(c.I)} × ${s(c.O)} ${s(c.S) === '是' ? '瓶' : ''}`.trim(), s(c.Q) && `密度 ${n6(c.Q)}`, s(c.R) && `純度 ${n6(c.R)}`, s(c.T) && `鋼瓶殘餘 ${round(num(c.T) * 100, 4)}%`, s(c.G)].filter(Boolean).join('；');
      push('process', '類別1(製程)', '', r, pickCols(c, COLS.process['']), target, [{ metric, ...period, value: r4(kg), unit: 'kg', source: { name: s(c.V) || '盤查表單', location: s(c.W) }, note }]);
    }
  }

  // 類別1(冷煤)
  const rf = sheetOf('類別1(冷煤)');
  if (rf) {
    totals.refrigerant = sumBlock(rf, 4, 13, ['A'], 'C');
    // 同位置同名設備（例：宿舍兩種型號冷氣）名稱加型號區分
    const seen = new Map();
    for (const [r, c] of rf) if (r >= 4 && s(c.H)) { const k = `${s(c.H)}（${s(c.G)}）`; seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [r, c] of rf) {
      if (r < 4 || !s(c.H) || !s(c.L) || s(c.E) === '範例') continue;
      if (REF_EXAMPLES.has(s(c.G))) { skipped.push({ sheet: '類別1(冷煤)', row: r, why: '表單範本的範例列' }); continue; }
      const gas = normRef(c.L); const qty = num(c.N) || 1; const charge = num(c.M); const act = num(c.AA) || 0;
      const name = seen.get(`${s(c.H)}（${s(c.G)}）`) > 1 && s(c.K) ? `${s(c.H)}（${s(c.G)} ${s(c.K)}）` : `${s(c.H)}（${s(c.G)}）`;
      const lref = `ghgwb:ref:${s(c.G)}|${s(c.H)}|${s(c.K)}`;
      const attrs = { refrigerant: gas, qty, ...(s(c.J) ? { brand: s(c.J) } : {}), ...(s(c.K) ? { model: s(c.K) } : {}), ...(s(c.F) ? { dept: s(c.F) } : {}),
        ...(charge !== null ? { chargeKgEach: charge } : {}), ...(num(c.Y) !== null ? { ratedKw: num(c.Y) } : {}), ...(s(c.X) ? { coolingCapacity: `${s(c.X)} kW` } : {}), ...(s(c.I) ? { leakType: s(c.I) } : {}) };
      const target = { match: { legacyRef: lref }, create: { itemCode: 'GAS-REF', assetType: REF_TYPE(s(c.H)), name, location: s(c.G), legacyRef: lref, attrs } };
      const src = { name: s(c.V) || '設備銘牌', location: s(c.W) };
      const obs = [];
      if (charge !== null) obs.push({ metric: 'ref_charge_kg', start: `${Y}-12-31`, end: `${Y}-12-31`, value: r4(charge * qty), unit: 'kg', source: src, note: `${charge} kg × ${qty} 台` });
      if (act > 0) {
        const why = num(c.T) ? `新購 ${n6(c.U) || qty} 台 × ${n6(c.T)} kg` : num(c.S) ? `補充 ${n6(c.S)} kg` : '';
        obs.push({ metric: 'ref_recharge_kg', start: yr[0], end: yr[1], value: r4(act), unit: 'kg', source: src, note: [why, s(c.Z)].filter(Boolean).join('；') });
      }
      push('refrigerant', '類別1(冷煤)', '', r, pickCols(c, COLS.refrigerant['']), target, obs);
    }
  }

  // 類別1(其它)：左邊滅火器、右邊 GCB 斷路器
  const ot = sheetOf('類別1(其它)');
  if (ot) {
    totals.other = sumBlock(ot, 3, 9, ['A'], 'C');
    for (const [r, c] of ot) {
      if (r >= 3 && s(c.F) && s(c.H) && s(c.E) !== '範例') {
        const agent = s(c.H).toUpperCase().replace('FM-200', 'FM200');
        const kg = num(c.R) || num(c.S) || 0;
        const ghg = ['CO2', 'FM200'].includes(agent);
        const target = !ghg ? null : agent === 'CO2'
          ? { match: { itemCode: 'GAS-FIRE', agent: 'CO2' }, create: { itemCode: 'GAS-FIRE', assetType: 'fire_extinguisher', name: 'CO₂ 滅火器', attrs: { agent: 'CO2' } } }
          : { match: { itemCode: 'GAS-FIRE', agent: 'FM-200' }, create: { itemCode: 'GAS-FIRE', assetType: 'fire_extinguisher', name: 'FM-200 滅火器', attrs: { agent: 'FM-200' } } };
        const o = kg > 0 && target ? [{ metric: 'fire_ext_refill_kg', start: yr[0], end: yr[1], value: r4(kg), unit: 'kg', source: { name: s(c.P) || '採購單', location: s(c.Q) },
          note: `${s(c.F)} ${s(c.G)}，${s(c.I) && `${s(c.I)} 型 `}${s(c.J)} 支${s(c.N) ? `，發票 ${s(c.N)}` : ''}` }] : [];
        push('other', '類別1(其它)', 'fire', r, pickCols(c, COLS.other.fire), target, o, !ghg ? `${s(c.H)} 不會排放溫室氣體` : kg ? null : '活動數據為 0');
      }
      if (r >= 3 && s(c.AE) && s(c.AC)) {
        if (s(c.AE).toUpperCase() !== 'GCB') { push('other', '類別1(其它)', 'gcb', r, pickCols(c, COLS.other.gcb), null, [], `${s(c.AE)} 不含 SF₆`); continue; }
        const sf6 = num(c.AG); const rate = num(c.AH); const act = num(c.AI);
        const lref = `ghgwb:gcb:${s(c.AC)}|${s(c.AD)}|${s(c.AF)}`;
        const target = { match: { legacyRef: lref }, create: { itemCode: 'GAS-GCB', assetType: 'gcb', name: `GCB 氣體斷路器（${s(c.AC)} ${s(c.AD)}）`.replace(' ）', '）'), location: s(c.AC), floor: s(c.AD) || null, legacyRef: lref,
          attrs: { gas: 'SF6', ...(s(c.AF) ? { model: s(c.AF) } : {}), ...(rate !== null ? { leakRatePct: r4(rate * 100) } : {}) } } };
        const src = { name: s(c.AJ) || '保養維護單', location: s(c.AK) };
        const obs = [];
        if (sf6 !== null) obs.push({ metric: 'insul_gas_charge_kg', start: `${Y}-12-31`, end: `${Y}-12-31`, value: sf6, unit: 'kg', source: src, note: '銘牌 SF₆ 氣體量' });
        if (act) obs.push({ metric: 'insul_gas_recharge_kg', start: yr[0], end: yr[1], value: r4(act), unit: 'kg', state: 'estimated', source: src,
          note: `盤查表單推估：SF₆ ${sf6} kg × 年洩漏率 ${rate !== null ? r4(rate * 100) : '?'}%（無實際補充紀錄）` });
        push('other', '類別1(其它)', 'gcb', r, pickCols(c, COLS.other.gcb), target, obs);
      }
    }
  }

  // 類別1(化糞池調查表)：住院人日另記（計算時 × 24），其他在院人時（員工、外包、志工、門急診、宿舍）合計為工時
  const sp = sheetOf('類別1(化糞池調查表)');
  if (sp) {
    const rows = [...sp].filter(([r, c]) => r >= 5 && (sheets || r < 28) && s(c.B) && num(c.O) !== null && num(c.O) > 0);
    const inpat = rows.filter(([, c]) => /住院/.test(s(c.B)));
    const others = rows.filter(([, c]) => !/住院/.test(s(c.B)));
    const hours = others.reduce((t, [, c]) => t + num(c.O), 0);
    const inH = inpat.reduce((t, [, c]) => t + num(c.O), 0);
    totals.septic = { 總人時: num(sp.get(2)?.D) };
    const staff = { match: { itemCode: 'ACT-STAFF' }, create: { itemCode: 'ACT-STAFF', assetType: 'org_activity', name: '員工人數與工時' } };
    const pat = { match: { itemCode: 'ACT-PATIENT' }, create: { itemCode: 'ACT-PATIENT', assetType: 'org_activity', name: '就診與住院人次' } };
    const src = { name: '盤查表單化糞池調查表' };
    const hoursObs = ann('staff_hours', r4(hours), { unit: 'person_h', source: src, note: `化糞池調查表：${others.map(([, c]) => s(c.B) + (s(c.C) ? `（${s(c.C)}）` : '')).join('、')} 在院人時合計（住院另計）` });
    const inObs = inH ? ann('inpatient_days', r4(inH / 24), { unit: 'bed_day', source: src, note: `化糞池調查表住院人時 ${inH} ÷ 24` }) : null;
    let first = true;
    for (const [r, c] of rows) {
      const isIn = /住院/.test(s(c.B));
      const o = isIn ? (inObs && inpat[0][0] === r ? [inObs] : []) : first ? [hoursObs] : [];
      if (!isIn) first = false;
      push('septic', '類別1(化糞池調查表)', '', r, pickCols(c, COLS.septic['']), isIn ? pat : staff, o, o.length ? null : isIn ? null : '併入同頁第一列的工時合計');
    }
  }

  // 類別2(用電量)：電號-1…10 各一段，每段 12 個月；段名不是電號（例：外包廠商電度數）＝盤查要扣除的院內租用單位用電
  const el = sheetOf('類別2(用電量)');
  if (el) {
    const blocks = [];
    for (const [r, c] of el) {
      if (!/^電號-\d+$/.test(s(c.A)) || !/收據月份/.test(s(el.get(r + 1)?.A))) continue;
      const months = [];
      for (let k = r + 2; k < r + 16; k++) { const m = el.get(k); if (!m || /合計/.test(s(m.A))) break; if (/月/.test(s(m.A))) months.push([k, m]); }
      const total = months.reduce((t, [, m]) => t + (num(m.L) || 0), 0);
      if (!total) continue;
      blocks.push({ r, label: s(c.B), months, total, deduct: !/^\d{6,}$/.test(s(c.B)) });
    }
    totals.electricity = Object.fromEntries(Object.entries({ 年度合計: num(el.get(2)?.E), 環境部方案: num(el.get(4)?.I) }).filter(([, v]) => v !== null));
    const accts = blocks.filter((b) => !b.deduct); const deducts = blocks.filter((b) => b.deduct);
    if (accts.length > 1 && deducts.length) skipped.push({ sheet: '類別2(用電量)', row: deducts[0].r, why: '多個電號時無法判斷外包廠商用電從哪個電號扣，未扣除' });
    const dedMonth = new Map();
    if (accts.length === 1) for (const b of deducts) for (const [, m] of b.months) { const st = readDate(m.B).date; dedMonth.set(st, (dedMonth.get(st) || 0) + (num(m.L) || 0)); }
    for (const b of accts) {
      const target = { match: { itemCode: 'ELE-GRID', externalKey: b.label }, create: { itemCode: 'ELE-GRID', assetType: 'power_account', name: `電號 ${b.label}`, externalKey: b.label } };
      for (const [k, m] of b.months) {
        const st = readDate(m.B).date; const en = readDate(m.C).date; if (!st || !en) { skipped.push({ sheet: '類別2(用電量)', row: k, why: '用電期間讀不到' }); continue; }
        const gross = num(m.L) || 0; const ded = dedMonth.get(st) || 0;
        push('electricity', '類別2(用電量)', 'meter', k, { _acct: b.label, ...pickCols(m, COLS.electricity.meter) }, target, [{ metric: 'elec_purchased_kwh', start: st, end: addDays(en, 1), value: r4(gross - ded), unit: 'kWh',
          source: { name: '台電電費單（盤查表單）', type: 'bill' }, note: ded ? `電費單 ${gross.toLocaleString('en-US')} 度－院內外包廠商 ${ded.toLocaleString('en-US')} 度（盤查扣除）` : '電費單度數' }]);
      }
    }
    if (accts.length === 1) for (const b of deducts) {
      const target = { match: { legacyRef: `ghgwb:deduct:${b.label}` }, create: { itemCode: 'ELE-SUB', assetType: 'power_meter', name: `${b.label.replace(/電度數$/, '')}用電（盤查扣除）`, legacyRef: `ghgwb:deduct:${b.label}`, parentKey: accts[0].label,
        attrs: { ghgTab: 'electricity', ghgDeduct: true, note: '院內外包廠商用電；盤查時從電號用電量扣除' } } };
      for (const [k, m] of b.months) {
        const st = readDate(m.B).date; const en = readDate(m.C).date; if (!st || !en || !num(m.L)) continue;
        push('electricity', '類別2(用電量)', 'meter', k, { _acct: b.label, ...pickCols(m, COLS.electricity.meter) }, target, [{ metric: 'elec_metered_kwh', start: st, end: addDays(en, 1), value: num(m.L), unit: 'kWh', source: { name: '外包廠商抄表（盤查表單）' }, note: '盤查扣除' }]);
      }
    }
  }
  return { year: Y, rows: out, skipped, totals };
}

function detectYear(wb) {
  const el = sheetCells(wb, '類別2(用電量)'); const y1 = num(el?.get(1)?.A); if (y1 > 2000 && y1 < 2100) return y1;
  const rf = sheetCells(wb, '類別1(冷煤)'); const m = /(20\d{2})年/.exec(s(rf?.get(1)?.E)); if (m) return Number(m[1]);
  return null;
}
// 頁面左上角「設備／燃料／年總量」區塊（非 0 才列）
function sumBlock(rows, from, to, labels, kv) {
  const o = {};
  for (let r = from; r <= to; r++) { const c = rows.get(r); if (!c) continue; const v = num(c[kv]); if (!v) continue; o[labels.map((k) => s(c[k])).filter(Boolean).join(' ') || `第 ${r} 列`] = v; }
  return o;
}

// ── 寫入 ──
const itemId = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code)?.id;
// 計畫裡的 target → 標的（找不到就建）。編修重算時，原檔建的標的（legacyRef 相同）規格有改（冷媒種類、台數、油種）就一併更新
function makeResolver(ctx, orgId, Y, created, { syncAttrs = false } = {}) {
  const site = q.get('SELECT id FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', orgId);
  const cache = new Map();
  return (t) => {
    const k = JSON.stringify(t.match);
    if (cache.has(k)) return cache.get(k);
    let a = findAsset(orgId, t.match);
    if (!a) {
      const c = t.create;
      const parent = c.parentKey ? findAsset(orgId, { itemCode: 'ELE-GRID', externalKey: c.parentKey }) : null;
      const { id } = createAsset(ctx, { orgId, siteId: site?.id, itemId: itemId(c.itemCode), assetType: c.assetType, name: c.name, externalKey: c.externalKey || undefined,
        location: c.location || undefined, floor: c.floor || undefined, parentAssetId: parent?.id, attrs: c.attrs || {}, legacyRef: undefined, reason: `${Y} 年盤查表單` }, { skipCheck: true });
      if (c.legacyRef) q.run('UPDATE assets SET legacy_ref = ? WHERE id = ?', c.legacyRef, id);
      setApplicability(ctx, id, { applicability: 'applicable', reason: `${Y} 年盤查表單列為排放源` });
      a = { ...q.get('SELECT * FROM assets WHERE id = ?', id) };
      created.push(c.name);
    } else if (syncAttrs && t.create?.legacyRef && a.legacy_ref === t.create.legacyRef && t.create.attrs) {
      const cur = typeof a.attrs === 'string' ? j(a.attrs, {}) : a.attrs || {};
      const next = { ...cur, ...t.create.attrs };
      if (JSON.stringify(next) !== JSON.stringify(cur)) {
        q.run('UPDATE assets SET attrs = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), a.id);
        audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'asset.update', targetType: 'asset', targetId: a.id, before: { attrs: cur }, after: { attrs: next, reason: `${Y} 年盤查表單編修` } });
        a = { ...a, attrs: next };
      }
    }
    cache.set(k, a);
    return a;
  };
}
function findAsset(orgId, m) {
  const rows = q.all(`SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.status <> 'archived' ORDER BY a.created_at`, orgId)
    .map((a) => ({ ...a, attrs: j(a.attrs, {}) }));
  if (m.legacyRef) { const hit = rows.find((a) => a.legacy_ref === m.legacyRef); if (hit) return hit; }
  return rows.find((a) => (!m.itemCode || a.item_code === m.itemCode) && (!m.assetType || a.asset_type === m.assetType)
    && (!m.externalKey || a.external_key === m.externalKey) && (!m.fuel || (a.attrs.fuel || 'diesel') === m.fuel)
    && (!m.agent || (a.attrs.agent || '').toUpperCase().replace('-', '') === m.agent.toUpperCase().replace('-', '')) && (!m.nameLike || a.name.includes(m.nameLike))
    && (m.itemCode || m.assetType || m.externalKey) && !(m.legacyRef && !m.externalKey && !m.itemCode)) || null;
}
function sourceFor(ctx, asset, src) {
  const name = String(src.name || '盤查表單').slice(0, 60);
  let r = q.get('SELECT * FROM data_sources WHERE asset_id = ? AND name = ? AND active = 1', asset.id, name);
  if (r) return r;
  r = { id: newId('src'), org_id: asset.org_id, asset_id: asset.id, item_id: asset.item_id, name, source_type: src.type || 'record', acquisition: 'import',
    location: src.location || null, priority: src.type === 'bill' ? 10 : 40, owner_status: 'unknown', note: '由溫室氣體盤查表單匯入', created_by: ctx.userId, created_at: nowIso(), updated_at: nowIso() };
  insert('data_sources', r);
  return r;
}

const obsKey = (Y, r, o) => `ghgwb:${Y}:${r.sheet}!${r.row}${r.part && r.part !== 'meter' ? `:${r.part}` : ''}:${o.metric}`;

// 匯入：回 { year, assetsCreated, observations: {created, duplicate, new_version}, rows, skipped, totals, check }
export async function importWorkbook(ctx, { orgId, filename, data, year, apply = false }) {
  assertCan(ctx, 'import.write', orgId);
  const plan = planWorkbook(data, { year });
  const Y = plan.year;
  const check = compareTotals(plan);
  const summary = { year: Y, rows: plan.rows.length, skipped: plan.skipped, totals: plan.totals, check, assetsCreated: [], observations: { created: 0, duplicate: 0, new_version: 0 } };
  if (!apply) {
    const want = new Map();
    for (const r of plan.rows) if (r.target && !findAsset(orgId, r.target.match)) want.set(r.target.create.name, r.target.create.itemCode);
    summary.assetsCreated = [...want.keys()];
    summary.observations.created = plan.rows.reduce((t, r) => t + (r.target ? r.obs.length : 0), 0);
    return summary;
  }
  const ev = await storeEvidence(ctx, { orgId, filename, data, kind: '溫室氣體盤查表單', confidentiality: 'internal', note: `${Y} 年度盤查表單` }, { skipCheck: true });
  tx(() => {
    const resolve = makeResolver(ctx, orgId, Y, summary.assetsCreated);
    const tabsDone = new Set();
    for (const r of plan.rows) {
      if (!tabsDone.has(r.sheet)) { q.run('DELETE FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ?', orgId, Y, r.sheet); tabsDone.add(r.sheet); }
      const a = r.target ? resolve(r.target) : null;
      const ids = [];
      if (a) for (const o of r.obs) {
        const src = sourceFor(ctx, a, o.source || {});
        const key = obsKey(Y, r, o);
        const res = addObservation(ctx, { assetId: a.id, metricCode: o.metric, periodStart: o.start, periodEnd: o.end, rawValue: o.value, rawUnit: o.unit, valueState: o.state || 'measured',
          sourceId: src.id, sourceRecordKey: key, note: o.note || null }, { method: 'import', skipCheck: true, evidenceIds: [ev.id] });
        summary.observations[res.status]++;
        ids.push(res.id);
      }
      if (r.part === 'sum') continue; // 合計列只是計算用的觀測，畫面上原檔沒有這一列
      insert('ghg_sheet_rows', { id: newId('gsr'), org_id: orgId, year: Y, evidence_id: ev.id, workbook: filename, sheet: r.sheet, tab: r.tab, part: r.part || '', row_no: r.row,
        cells: r.cells, asset_id: a?.id || null, observation_ids: ids, note: r.note || null, created_by: ctx.userId, created_at: nowIso() });
    }
    // 頁面左上角合計也存一列（part=total），畫面拿來和系統合計對照
    for (const [tab, t] of Object.entries(plan.totals)) {
      const sheet = TAB[tab]?.name; if (!sheet) continue;
      q.run("DELETE FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part = 'total'", orgId, Y, sheet);
      insert('ghg_sheet_rows', { id: newId('gsr'), org_id: orgId, year: Y, evidence_id: ev.id, workbook: filename, sheet, tab, part: 'total', row_no: 0, cells: t, observation_ids: [], created_by: ctx.userId, created_at: nowIso() });
    }
    audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'import.ghg_sheets', targetType: 'evidence', targetId: ev.id, after: { year: Y, filename, rows: plan.rows.length, assets: summary.assetsCreated.length, obs: summary.observations } });
  });
  summary.evidenceId = ev.id;
  return summary;
}

// 匯入前自我檢查：逐列加總要等於原檔左上角的年總量（不等＝有列沒讀到或範例列沒排除）
export function compareTotals(plan) {
  const sum = (tab, metric, pred = () => true) => r4(plan.rows.filter((r) => r.tab === tab && r.part !== 'sum').flatMap((r) => r.obs).filter((o) => o.metric === metric && pred(o)).reduce((t, o) => t + o.value, 0));
  const out = [];
  const add = (label, mine, theirs) => { if (theirs === undefined || theirs === null) return; out.push({ label, mine, theirs, ok: Math.abs(mine - theirs) < 0.01 }); };
  const t = plan.totals;
  if (t.stationary) add('固定：發電機柴油（公升）', sum('stationary', 'oil_purchase_l'), Object.entries(t.stationary).filter(([k]) => /柴油/.test(k)).reduce((x, [, v]) => x + v, 0));
  if (t.mobile) {
    const fuelOf = (tag) => (o) => (o.note || '').startsWith(tag);
    add('移動：柴油（公升）', sum('mobile', 'oil_consumption_l', fuelOf('柴油')), t.mobile['公務車/工程車 柴油']);
    add('移動：95 汽油（公升）', sum('mobile', 'oil_consumption_l', fuelOf('95汽油')), t.mobile['公務車/工程車 95汽油']);
    add('移動：92 汽油（公升）', sum('mobile', 'oil_consumption_l', fuelOf('92汽油')), t.mobile['公務車/工程車 92汽油']);
  }
  if (t.refrigerant) for (const [k, v] of Object.entries(t.refrigerant)) {
    const gas = normRef(k);
    add(`冷媒 ${gas}（kg）`, r4(plan.rows.filter((r) => r.tab === 'refrigerant' && r.target?.create.attrs.refrigerant === gas).flatMap((r) => r.obs).filter((o) => o.metric === 'ref_recharge_kg').reduce((x, o) => x + o.value, 0)), v);
  }
  if (t.process) add('製程：CO₂ 鋼瓶與混合氣體（kg）', sum('process', 'co2_use_kg'), Object.values(t.process).reduce((x, v) => x + v, 0));
  if (t.other?.CO2) add('滅火器 CO₂（kg）', sum('other', 'fire_ext_refill_kg'), t.other.CO2);
  if (t.septic?.總人時) {
    const h = sum('septic', 'staff_hours'); const d = sum('septic', 'inpatient_days');
    add('化糞池總人時', r4(h + d * 24), t.septic.總人時);
  }
  if (t.electricity?.年度合計) add('用電量（扣除後，度）', sum('electricity', 'elec_purchased_kwh'), t.electricity.年度合計);
  return out;
}

// ── 計算用：2025 年以報告書總數建的「合計」標的標成彙總標的（見 calc.js：彙總標的與逐車／逐台標的不互相算缺）──
export function markAggregate(ctx, assetId, reason) {
  const a = q.get('SELECT attrs FROM assets WHERE id = ?', assetId);
  const attrs = j(a.attrs, {});
  if (attrs.aggregate) return false;
  updateAsset(ctx, assetId, { attrs: { ...attrs, aggregate: true }, reason });
  return true;
}

// ════════════════ 院所頁編修（依盤查表單頁籤）════════════════
// 院方在頁籤表格上直接改一列、新增一列或刪一列：儲存格存回 ghg_sheet_rows，整頁依原匯入規則重算——
// 值有變的觀測成為新版本（原值保留），不再成立的觀測（刪列、改了日期或改到別的車／設備）補一個「0」的新版本。

// 每頁必填欄（缺了這一列不會計入，存檔時就擋）
const REQUIRED = {
  stationary: { '': ['J', 'M', 'O'] }, mobile: { '': ['I', 'K', 'M'] }, process: { '': ['F', 'H'] }, refrigerant: { '': ['H', 'L'] },
  other: { fire: ['F', 'H'], gcb: ['AC', 'AE'] }, septic: { '': ['B', 'O'] }, electricity: { meter: ['B', 'C', 'L'] },
};
// 原檔的公式欄：輸入欄有改、公式欄沒動時照原檔公式重算（院方自己改了公式欄就用院方的值）
const FORMULAS = {
  process: { '': { U: { from: ['N', 'O', 'P', 'Q', 'R', 'S', 'T'], f: (c) => (num(c.N) ?? 0) * (num(c.R) ?? 0) * (num(c.O) ?? 0) * (s(c.S) === '是' ? 1 - (num(c.T) ?? 0) : 1) * (String(c.P ?? '') === 'L' ? num(c.Q) ?? 0 : 1) } } },
  refrigerant: { '': { AA: { from: ['M', 'S', 'T', 'U'], f: (c) => (num(c.M) ? (num(c.S) ?? 0) + (num(c.T) ?? 0) * (num(c.U) ?? 0) : 0) } } },
  other: { gcb: { AI: { from: ['AG', 'AH'], f: (c) => (num(c.AG) ?? 0) * (num(c.AH) ?? 0) } } },
  septic: { '': { O: { from: ['E', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'], f: (c) => (num(c.E) === null ? null : ((num(c.G) ?? 0) * (num(c.K) ?? 0) + (num(c.H) ?? 0) * (num(c.L) ?? 0) + (num(c.I) ?? 0) * (num(c.M) ?? 0) + (num(c.J) ?? 0) * (num(c.N) ?? 0)) * num(c.E)) } } },
  electricity: { meter: { D: { from: ['B', 'C'], f: (c) => { const b = readDate(c.B).date; const e = readDate(c.C).date; return b && e ? Math.round((Date.parse(e) - Date.parse(b)) / 86400000) + 1 : null; } } } },
};
// 下拉建議（仍可自填）
const OPTIONS = {
  stationary: { M: ['柴油', '燃料油', '液化石油氣', '天然氣'] },
  mobile: { K: ['柴油', '超級柴油', '92汽油', '95汽油', '98汽油', '尿素'], G: ['公務車', '救護車', '工程車', 'X光體檢車'] },
  process: { S: ['是', '否'], P: ['L', 'kg'] },
  refrigerant: { L: ['R-134a', 'R-410A', 'R-32', 'R-22', 'R-404A', 'R-407C', 'R-600a'], I: ['住宅及商業建築冷氣機', '冰水機', '家用冷凍、冷藏裝備', '商用冷凍、冷藏裝備', '移動式空氣清淨機'] },
  other: { H: ['CO2', 'FM200', '乾粉', '泡沫'], AE: ['GCB', 'VCB', 'ACB'] },
  septic: { D: ['整棟自有', '部分租用'], F: ['是', '否'] },
};
const partCols = (tab, part) => (COLS[tab] || {})[part] || null;

// 從 ghg_sheet_rows 還原一頁的儲存格（用電量頁補回電號段落的表頭列，讓解析器照原檔規則讀）
function sheetFromDb(orgId, Y, sheet) {
  const rows = q.all("SELECT part, row_no, cells FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part <> 'total' AND deleted_at IS NULL ORDER BY row_no", orgId, Y, sheet)
    .map((r) => ({ ...r, cells: j(r.cells, {}) }));
  const m = new Map();
  if (sheet === TAB.electricity.name) {
    const groups = new Map();
    for (const r of rows) { const k = r.cells._acct || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let n = 1;
    for (const [acct, rs] of groups) {
      const first = Math.min(...rs.map((r) => r.row_no));
      m.set(first - 2, { A: `電號-${n++}`, B: acct }); m.set(first - 1, { A: '收據月份' });
      for (const r of rs) { const { _acct, ...c } = r.cells; m.set(r.row_no, c); }
    }
    return m;
  }
  for (const r of rows) m.set(r.row_no, { ...(m.get(r.row_no) || {}), ...r.cells });
  return m;
}

// 整頁重算：回 { observations: {created, duplicate, new_version, zeroed}, assetsCreated }
function reapplySheet(ctx, orgId, Y, sheet, why) {
  const plan = planWorkbook(null, { year: Y, sheets: new Map([[sheet, sheetFromDb(orgId, Y, sheet)]]) });
  const out = { observations: { created: 0, duplicate: 0, new_version: 0, zeroed: 0 }, assetsCreated: [] };
  const prefix = `ghgwb:${Y}:${sheet}!`;
  const live = q.all("SELECT * FROM observations WHERE org_id = ? AND substr(source_record_key, 1, ?) = ? AND quality_status <> 'superseded'", orgId, prefix.length, prefix);
  const byKey = new Map(); for (const o of live) { if (!byKey.has(o.source_record_key)) byKey.set(o.source_record_key, []); byKey.get(o.source_record_key).push(o); }
  const zero = (o, note) => {
    if (o.value_state === 'zero' || o.raw_value === 0) return;
    addObservation(ctx, { assetId: o.asset_id, metricCode: o.metric_code, periodStart: o.period_start, periodEnd: o.period_end, rawValue: 0, rawUnit: o.raw_unit, valueState: 'zero',
      sourceId: o.source_id, sourceRecordKey: o.source_record_key, note }, { method: o.method, skipCheck: true });
    out.observations.zeroed++;
  };
  const resolve = makeResolver(ctx, orgId, Y, out.assetsCreated, { syncAttrs: true });
  const rowInfo = new Map(); const seen = new Set();
  for (const r of plan.rows) {
    const a = r.target ? resolve(r.target) : null;
    const ids = [];
    if (a) for (const o of r.obs) {
      const src = sourceFor(ctx, a, o.source || {});
      const key = obsKey(Y, r, o); seen.add(key);
      for (const old of byKey.get(key) || []) {
        if (old.asset_id === a.id && old.period_start === o.start && old.period_end === o.end && old.source_id === src.id) continue;
        zero(old, `${why}：這一列改到 ${a.name}／${o.start}，原紀錄歸零`);
      }
      const res = addObservation(ctx, { assetId: a.id, metricCode: o.metric, periodStart: o.start, periodEnd: o.end, rawValue: o.value, rawUnit: o.unit, valueState: o.state || 'measured',
        sourceId: src.id, sourceRecordKey: key, note: [why, o.note].filter(Boolean).join('；') }, { method: 'import', skipCheck: true });
      out.observations[res.status]++;
      ids.push(res.id);
    }
    if (r.part !== 'sum') rowInfo.set(`${r.part || ''}|${r.row}`, { asset: a?.id || null, ids, note: r.note || null });
  }
  for (const [key, list] of byKey) if (!seen.has(key)) for (const o of list) zero(o, `${why}：原檔這一列已刪除或不再計入，紀錄歸零`);
  const skippedWhy = new Map(plan.skipped.map((k) => [k.row, k.why]));
  for (const r of q.all("SELECT id, part, row_no FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part <> 'total' AND deleted_at IS NULL", orgId, Y, sheet)) {
    const info = rowInfo.get(`${r.part}|${r.row_no}`);
    q.run('UPDATE ghg_sheet_rows SET asset_id = ?, observation_ids = ?, note = ? WHERE id = ?', info?.asset || null, JSON.stringify(info?.ids || []),
      info ? info.note : skippedWhy.get(r.row_no) || '這一列缺必要欄位，沒有計入', r.id);
  }
  return out;
}

function cleanCells(tab, part, input) {
  const cols = partCols(tab, part); if (!cols) throw bad('這個頁籤沒有這一段');
  const out = {};
  for (const [c, , t] of cols) {
    if (c === '_acct') continue;
    let v = input?.[c]; if (v === undefined || v === null) continue;
    v = String(v).trim(); if (v === '') continue;
    if (t === 'num') { const n = num(v); if (n === null) throw bad(`「${cols.find((x) => x[0] === c)[1]}」要填數字`); v = String(n); }
    if (t === 'date' && !readDate(v).date) throw bad(`「${cols.find((x) => x[0] === c)[1]}」日期看不懂，請填 2023-01-31`);
    out[c] = v.slice(0, 200);
  }
  return out;
}
// 畫面送回的值和原儲存格「意思一樣」（193.879611 vs 193.87961100000001、2023-04-20 vs Excel 序號 45037）就保留原儲存格，不算有改
function keepSame(cols, before, after) {
  for (const [c, , t] of cols) {
    if (before[c] === undefined || after[c] === undefined) continue;
    const a = s(before[c]); const b = s(after[c]);
    if (a === b) continue;
    if (t === 'num' && num(a) !== null && num(b) !== null && Math.abs(num(a) - num(b)) <= 1e-9 * Math.max(1, Math.abs(num(a)))) after[c] = before[c];
    else if (t === 'date' && readDate(a).date && readDate(a).date === readDate(b).date) after[c] = before[c];
    else if (t !== 'num' && t !== 'date' && num(a) !== null && num(b) !== null && Math.abs(num(a) - num(b)) <= 1e-9 * Math.max(1, Math.abs(num(a)))) after[c] = before[c];
  }
  return after;
}
function applyFormulas(tab, part, before, after) {
  const fs = (FORMULAS[tab] || {})[part] || {};
  for (const [col, { from, f }] of Object.entries(fs)) {
    const inputsChanged = from.some((k) => s(before[k]) !== s(after[k]));
    const userSet = s(before[col]) !== s(after[col]);
    if ((inputsChanged || !s(after[col])) && !userSet) { const v = f(after); if (v !== null && Number.isFinite(v)) after[col] = String(round(v, 6)); }
  }
  return after;
}

// 存一列：row 空白＝新增（用電量頁每個電號固定 12 個月，只能改不能加）
export function saveSheetRow(ctx, orgId, { year, tab, part = '', row, cells, reason } = {}) {
  assertCan(ctx, 'obs.write', orgId);
  const t = TAB[tab]; if (!t) throw bad('不認得的頁籤');
  const Y = Number(year); if (!Y) throw bad('缺年度');
  const p = part || ''; const cols = partCols(tab, p); if (!cols) throw bad('這個頁籤沒有這一段');
  const old = row ? q.get("SELECT * FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part = ? AND row_no = ? AND deleted_at IS NULL", orgId, Y, t.name, p, Number(row)) : null;
  if (row && !old) throw notFound('這一列');
  if (!old && tab === 'electricity') throw bad('用電量頁每個電號固定 12 個月，請直接修改該月份');
  const before = old ? j(old.cells, {}) : {};
  const next = applyFormulas(tab, p, before, keepSame(cols, before, { ...cleanCells(tab, p, cells), ...(before._acct ? { _acct: before._acct } : {}) }));
  if (old && JSON.stringify(next) === JSON.stringify(before)) return { row: old.row_no, unchanged: true, counted: j(old.observation_ids, []).length > 0, note: old.note, observations: { created: 0, duplicate: 0, new_version: 0, zeroed: 0 }, assetsCreated: [] };
  const miss = ((REQUIRED[tab] || {})[p] || []).filter((c) => !s(next[c]));
  if (miss.length) throw bad(`請填：${miss.map((c) => cols.find((x) => x[0] === c)?.[1] || c).join('、')}`);
  const why = String(reason || '').trim() || (old ? `院所頁修改第 ${old.row_no} 列` : '院所頁新增一列');
  let rowNo = old?.row_no;
  const res = tx(() => {
    if (old) q.run('UPDATE ghg_sheet_rows SET cells = ?, updated_by = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), ctx.userId, nowIso(), old.id);
    else {
      rowNo = (q.get('SELECT MAX(row_no) AS m FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ?', orgId, Y, t.name)?.m || 4) + 1;
      const wbName = q.get("SELECT workbook FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? LIMIT 1", orgId, Y, t.name)?.workbook || '院所頁填報';
      insert('ghg_sheet_rows', { id: newId('gsr'), org_id: orgId, year: Y, evidence_id: null, workbook: wbName, sheet: t.name, tab, part: p, row_no: rowNo,
        cells: next, observation_ids: [], created_by: ctx.userId, created_at: nowIso(), updated_by: ctx.userId, updated_at: nowIso() });
    }
    const r = reapplySheet(ctx, orgId, Y, t.name, why);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: old ? 'ghg_sheet.row_update' : 'ghg_sheet.row_create', targetType: 'ghg_sheet_row', targetId: `${Y}:${t.name}!${rowNo}${p ? ':' + p : ''}`,
      before: old ? before : null, after: { cells: next, reason: why, observations: r.observations } });
    return r;
  });
  const saved = q.get('SELECT note, observation_ids FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part = ? AND row_no = ?', orgId, Y, t.name, p, rowNo);
  return { row: rowNo, counted: j(saved?.observation_ids, []).length > 0, note: saved?.note || null, ...res };
}

export function deleteSheetRow(ctx, orgId, { year, tab, part = '', row, reason } = {}) {
  assertCan(ctx, 'obs.write', orgId);
  const t = TAB[tab]; if (!t) throw bad('不認得的頁籤');
  const Y = Number(year); const p = part || '';
  if (tab === 'electricity') throw bad('用電量頁的月份不能刪，沒有用電請把度數改成 0');
  const old = q.get("SELECT * FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND sheet = ? AND part = ? AND row_no = ? AND deleted_at IS NULL", orgId, Y, t.name, p, Number(row));
  if (!old) throw notFound('這一列');
  const why = String(reason || '').trim() || `院所頁刪除第 ${old.row_no} 列`;
  return tx(() => {
    q.run('UPDATE ghg_sheet_rows SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?', nowIso(), ctx.userId, nowIso(), old.id);
    const r = reapplySheet(ctx, orgId, Y, t.name, why);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'ghg_sheet.row_delete', targetType: 'ghg_sheet_row', targetId: `${Y}:${t.name}!${old.row_no}${p ? ':' + p : ''}`,
      before: j(old.cells, {}), after: { reason: why, observations: r.observations } });
    return { row: old.row_no, ...r };
  });
}

// ════════════════ 頁籤檢視 ════════════════
// 左欄：依頁籤列標的（沒有頁籤的放最後「其他盤點項目」）
export function tabsTree(assets) {
  const by = new Map(TABS.map((t) => [t.key, []])); const rest = [];
  for (const a of assets) { const k = tabOf(a); if (k) by.get(k).push(a); else rest.push(a); }
  const node = (a) => ({ kind: 'asset', id: a.id, name: a.name, typeLabel: ASSET_TYPES[a.asset_type] || a.asset_type });
  const tabs = TABS.filter((t) => !t.optional || by.get(t.key).length).map((t) => ({ key: t.key, name: t.name, title: t.title, count: by.get(t.key).length, children: by.get(t.key).map(node) }));
  return { tabs, rest: { count: rest.length, children: rest.map(node) } };
}

const yearOf = (d) => Number(String(d).slice(0, 4));
function obsYear(o) {
  // 期間迄日為隔日（不含）；年度看起日。年底快照（起迄同日）看起日
  return yearOf(o.period_start);
}

export function tabView(ctx, orgId, key, year) {
  assertCan(ctx, 'view.internal', orgId);
  const tab = TAB[key]; if (!tab) throw bad('不認得的頁籤');
  const assets = q.all(`SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.status <> 'archived' ORDER BY a.name`, orgId)
    .map((a) => ({ ...a, attrs: j(a.attrs, {}) })).filter((a) => tabOf(a) === key);
  const ids = assets.map((a) => a.id);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const obsAll = ids.length ? q.all(`SELECT o.*, s.name AS source_name, s.location AS source_location FROM observations o JOIN data_sources s ON s.id = o.source_id
    WHERE o.asset_id IN (${ids.map(() => '?').join(',')}) AND o.quality_status <> 'superseded' ORDER BY o.period_start`, ...ids) : [];
  const sheetYears = q.all('SELECT DISTINCT year FROM ghg_sheet_rows WHERE org_id = ? AND tab = ?', orgId, key).map((r) => r.year);
  const years = [...new Set([...obsAll.filter((o) => TAB_METRICS[key].includes(o.metric_code)).map(obsYear), ...sheetYears])].sort((a, b) => b - a);
  const Y = Number(year) || years[0] || new Date().getFullYear();
  const obs = obsAll.filter((o) => obsYear(o) === Y);
  const metrics = new Map(q.all('SELECT code, name, std_unit FROM metrics').map((m) => [m.code, m]));

  // 系統合計：依（類型／油種或冷媒）× 指標
  const label = (a) => {
    if (/尿素/.test(a.name)) return '車用尿素';
    const fuel = a.attrs.fuelGrade && !/／/.test(a.attrs.fuelGrade) ? a.attrs.fuelGrade : a.attrs.fuel ? FUEL_ZH[a.attrs.fuel] || a.attrs.fuel : null;
    const gas = a.attrs.refrigerant || a.attrs.agent || (a.item_code === 'GAS-GCB' ? 'SF₆' : null);
    return [ASSET_TYPES[a.asset_type] || a.asset_type, fuel || gas].filter(Boolean).join('・');
  };
  const sums = new Map();
  for (const o of obs) {
    if (!TAB_METRICS[key].includes(o.metric_code) || o.value_std === null) continue;
    const a = byId.get(o.asset_id);
    const k = `${a.attrs.ghgDeduct ? '（扣除）' : label(a)}|${o.metric_code}`;
    if (!sums.has(k)) sums.set(k, { group: a.attrs.ghgDeduct ? `${a.name}` : label(a), metric: metrics.get(o.metric_code)?.name || o.metric_code, unit: o.std_unit, value: 0, n: 0, assets: new Set(), estimated: false });
    const g = sums.get(k); g.value += o.value_std; g.n++; g.assets.add(o.asset_id); if (o.value_state === 'estimated') g.estimated = true;
  }
  const summary = [...sums.values()].map((g) => ({ ...g, value: r4(g.value), assets: g.assets.size }));

  // 原檔列
  const raw = q.all('SELECT * FROM ghg_sheet_rows WHERE org_id = ? AND year = ? AND tab = ? AND deleted_at IS NULL ORDER BY part, row_no', orgId, Y, key).map((r) => parseJson(r, ['cells', 'observation_ids']));
  const totalRow = raw.find((r) => r.part === 'total');
  const obsById = new Map(obsAll.map((o) => [o.id, o]));
  const current = (id) => {
    if (obsById.has(id)) return obsById.get(id);
    const o = q.get('SELECT asset_id, metric_code, period_start, period_end, source_id, source_record_key FROM observations WHERE id = ?', id);
    if (!o) return null;
    return q.get("SELECT * FROM observations WHERE asset_id = ? AND metric_code = ? AND period_start = ? AND period_end = ? AND source_id = ? AND source_record_key = ? AND quality_status <> 'superseded' ORDER BY version DESC LIMIT 1",
      o.asset_id, o.metric_code, o.period_start, o.period_end, o.source_id, o.source_record_key);
  };
  const parts = [];
  const sheetRows = raw.filter((r) => r.part !== 'total');
  if (sheetRows.length) {
    const byPart = new Map();
    for (const r of sheetRows) { if (!byPart.has(r.part)) byPart.set(r.part, []); byPart.get(r.part).push(r); }
    for (const [part, rows] of byPart) {
      const cols = (COLS[key] || {})[part] || (COLS[key] || {})[''] || [];
      const req = new Set(((REQUIRED[key] || {})[part]) || []); const fx = ((FORMULAS[key] || {})[part]) || {};
      parts.push({ part, title: PART_TITLE[part] || null, canAdd: key !== 'electricity',
        columns: cols.map(([c, h, t]) => ({ key: c, label: h, type: t || null, required: req.has(c), formula: !!fx[c], options: OPTIONS[key]?.[c] || null, readonly: c === '_acct' })),
        rows: rows.map((r) => {
          const os = r.observation_ids.map(current).filter(Boolean);
          const main = os.find((o) => TAB_METRICS[key].includes(o.metric_code)) || null;
          const a = r.asset_id ? byId.get(r.asset_id) : null;
          return { row: r.row_no, cells: fmtCells(r.cells, cols), raw: editCells(r.cells, cols), edited: r.updated_at ? r.updated_at.slice(0, 10) : null, assetId: r.asset_id, assetName: a?.name || null, note: r.note,
            value: main ? { metric: main.metric_code, metricName: metrics.get(main.metric_code)?.name, value: main.value_std, unit: main.std_unit, state: main.value_state, version: main.version } : null };
        }) });
    }
  }
  // 沒有原檔的年度：列系統裡的觀測
  const list = sheetRows.length ? [] : obs.filter((o) => TAB_METRICS[key].includes(o.metric_code)).map((o) => {
    const a = byId.get(o.asset_id);
    return { assetId: a.id, assetName: a.name, metric: o.metric_code, metricName: metrics.get(o.metric_code)?.name || o.metric_code, start: o.period_start, end: o.period_end,
      value: o.value_std, unit: o.std_unit, state: o.value_state, source: o.source_name, note: o.note };
  });
  return { key, name: tab.name, title: tab.title, year: Y, years, summary, sheetTotal: totalRow?.cells || null, editable: can(ctx, 'obs.write', orgId),
    workbook: raw[0]?.workbook || null, parts, list, assets: assets.map((a) => ({ id: a.id, name: a.name })) };
}

// 編輯表單用：數字去掉 Excel 浮點尾巴、日期轉 2023-01-31
function editCells(cells, cols) {
  const o = {};
  for (const [c, , t] of cols) {
    const v = cells[c]; if (v === undefined || v === '') continue;
    if (t === 'date') o[c] = readDate(v).date || String(v);
    else if (num(v) !== null && /\.\d{8,}$/.test(String(v))) o[c] = String(+num(v).toPrecision(12));
    else o[c] = String(v);
  }
  return o;
}
function fmtCells(cells, cols) {
  const o = {};
  for (const [c, , t] of cols) {
    const v = cells[c]; if (v === undefined || v === '') continue;
    if (t === 'date') { const d = readDate(v); o[c] = d.date && /^\d{5}/.test(String(v)) ? d.date : String(v); }
    else if (t === 'num') { const n = num(v); o[c] = n === null ? String(v) : round(n, 4); }
    else o[c] = String(v);
  }
  return o;
}

export { SHEET_TAB };
