// 申報表與報告產出（工作清單 13）：附表三年度申報、附件一節能診斷報告、附件二節能計畫 → xlsx。
//
// 原則：系統推得出的格子全部帶入；推不出的留空，並在「待補欄位」工作表逐項列出（院方只補這些）。
// 每張工作表第 1 列是表名、第 2 列是依據（文件、表號、文號、日期），第 3 列是院所與資料年。
// 產出是「對照官方格式的轉填稿」——能源署申報系統沒有公開匯入格式（spec §9-9），先以人工轉填為目標。
//
// 純函式：buildAnnex3／buildDiagnosis／buildPlan(inv, opts) → { sheets, missing, filename }；
// 轉成 xlsx 用 toXlsx()（src/xlsx.js 的 buildWorkbook，零相依）。
import { buildWorkbook } from './xlsx.js';
import { siteBlockById, categoryById, refLabel, siteRefIssues } from './inventory-schema.js';
import { MEASURE_TYPES, ORIGINAL_TEXT, DEVICE_CLASSES, ACTIONS, TEAM_CODES, ENERGY_TYPES, A1, A2, T3, energyLabel } from './report-schema.js';
import {
  materialize, measuresView, plansView, reportYearOf, diagnosisOf, billMonths, monthsOfRoc, monthlyKwh,
  chillerGroups, chillerMonth, todayIso,
} from './report-model.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;
const num = (v) => C.num(v);
const r2 = (v, d = 2) => (v === undefined ? undefined : C.round(v, d));
const rocYear = (ad) => (num(ad) === undefined ? '' : (num(ad) > 1911 ? num(ad) - 1911 : num(ad)));
const rocDate = (v) => { const d = C.parseDate(v); return d ? C.toRocDate(d) : (v ?? ''); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const ENERGY_COLS = ['E01', 'E02', 'E03', 'E04', 'E05', 'E06'];
const energyHead = (code) => { const e = ENERGY_TYPES.find((x) => x.code === code); return `${e.label}（${e.unit}）`; };

function srcLine(s) {
  if (!s) return '';
  return `依據：${s.doc}${s.ref ? ` ${s.ref}` : ''}${s.law ? `｜${s.law}` : ''}${s.date ? `（${s.date}）` : ''}${s.note ? `｜${s.note}` : ''}`;
}

// ── 工作表組裝小工具 ──
class Sheet {
  constructor(ctx, name, title, source) {
    this.ctx = ctx; this.name = name; this.rows = []; this.cols = []; this.source = source;
    this.rows.push([{ v: title, s: 'title' }]);
    this.rows.push([{ v: srcLine(source), s: 'note' }]);
    this.rows.push([{ v: `${ctx.hospital}｜${ctx.yearLabel}｜產出 ${ctx.todayRoc}`, s: 'note' }]);
    this.rows.push([]);
    ctx.sheets.push(this);
  }
  head(cells) { this.rows.push(cells.map((v) => ({ v, s: 'head' }))); return this; }
  row(cells) { this.rows.push(cells.map((v) => ({ v: v === undefined ? '' : v, s: 'cell' }))); return this; }
  text(t) { this.rows.push([{ v: t, s: 'note' }]); return this; }
  gap() { this.rows.push([]); return this; }
  widths(...w) { this.cols = w; return this; }
  need(field, why) { this.ctx.need(this.name, field, why); return this; }
  // 下一列的列號（1-based）：測試與待補清單用
  get nextRow() { return this.rows.length + 1; }
}

function newCtx(inv, opts, yearLabel) {
  const today = opts.today || todayIso();
  const missing = [];
  return {
    inv, today, todayRoc: rocDate(today), sheets: [], missing,
    hospital: inv.site.basic?.userName || opts.hospitalName || '（未填用戶名稱）',
    yearLabel,
    need(sheet, field, why) { missing.push({ sheet, field, why: why || '' }); },
  };
}

function missingSheet(ctx, title) {
  const s = new Sheet(ctx, '待補欄位', `${title}·待補欄位`, { doc: '系統產出說明', ref: '下列欄位系統無法由現有資料推得，請院方補填', note: '其餘欄位已由初始建檔、設備主檔、點位紀錄、措施與計畫帶入' });
  s.widths(26, 46, 60).head(['工作表', '欄位', '說明']);
  if (!ctx.missing.length) s.row(['—', '無', '所有欄位都已帶入']);
  for (const m of ctx.missing) s.row([m.sheet, m.field, m.why]);
  // 待補欄位放最後，但它在 ctx.sheets 裡已經是最後一個
  return s;
}

export function toXlsx(built) {
  return buildWorkbook(built.sheets.map((s) => ({ name: s.name, rows: s.rows, cols: s.cols }))).buffer;
}

// ── 欄位值顯示 ──
function fmtVal(f, v) {
  if (blank(v)) return '';
  if (f.type === 'boolean') return v ? '是' : '否';
  if (f.type === 'multiselect') return [].concat(v).join('、');
  if (f.type === 'year') return rocYear(v);
  if (f.type === 'date') return rocDate(v);
  if (f.type === 'select' && f.optionLabels?.[v]) return `${v} ${f.optionLabels[v]}`;
  return v;
}
const labelOf = (f) => `${f.code ? `${f.code} ` : ''}${f.label}${f.unit ? `（${f.unit}）` : ''}`;

// form 區塊 → 欄號／欄位／值／單位／說明
function formRows(s, block, values, { groups, derived = {}, skip = new Set(), needBlank = true } = {}) {
  s.head(['欄號', '欄位', '值', '單位', '說明']).widths(8, 34, 30, 12, 46);
  for (const f of block.fields) {
    if (groups && !groups.some((g) => String(f.group || '').startsWith(g))) continue;
    if (skip.has(f.key)) { s.row([f.code || '', f.label, '', f.unit || '', '免填']); continue; }
    let v = values?.[f.key];
    let note = f.hint || '';
    if (blank(v) && derived[f.key] !== undefined) { v = derived[f.key].value; note = derived[f.key].note; }
    if (blank(v) && f.default !== undefined) { v = f.default; note = `預設值${note ? `；${note}` : ''}`; }
    s.row([f.code || '', f.label, fmtVal(f, v), f.unit || '', note]);
    if (blank(v) && needBlank) s.need(`${f.code ? `${f.code} ` : ''}${f.label}`, f.required ? '必填，尚未填寫' : '尚未填寫');
  }
}

// table 區塊 → 一列一筆
function tableRows(s, block, rows, { lead = [], fields, map } = {}) {
  const fs = fields || block.fields;
  s.head([...lead.map((l) => l.label), ...fs.map(labelOf)]);
  s.widths(...lead.map(() => 14), ...fs.map(() => 16));
  rows.forEach((r, i) => s.row([...lead.map((l) => l.get(r, i)), ...fs.map((f) => fmtVal(f, map ? map(r, f) : r[f.key]))]));
  if (!rows.length) s.row(['（無資料）']);
}

// ════════════════════════════════════════════════════════════════
// 附表三 年度申報（資料年 N，民國）
// ════════════════════════════════════════════════════════════════
export function buildAnnex3(invIn, opts = {}) {
  const inv = clone(invIn);
  const N = Number(opts.year) || (Number((opts.today || todayIso()).slice(0, 4)) - 1912);
  const ctx = newCtx(inv, opts, `資料年 N＝${N}（${N + 1} 年 1 月申報）`);
  const site = inv.site;
  const basic = site.basic || {};
  const isHospital = String(basic.userCategory || '醫院').includes('醫院');
  const ry = reportYearOf(inv, ctx.today);
  materialize(inv, ry);
  const mv = measuresView(inv, ry);
  const pv = plansView(inv, ry, mv);
  const meterSheets = billMonths(inv);
  const monthsN = monthsOfRoc(N), monthsP = monthsOfRoc(N - 1);
  const kwhByMonth = monthlyKwh(meterSheets);
  const yearKwh = (months) => { const xs = months.map((m) => kwhByMonth[m]).filter((v) => v !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined; };
  const kwhN = yearKwh(monthsN);
  const feeN = (() => { let t, any = false; for (const s of meterSheets) for (const m of monthsN) { const f = s.months.get(m)?.feeTotal; if (f !== undefined) { t = (t || 0) + f; any = true; } } return any ? t : undefined; })();
  const area = C.indoorArea(basic.floorArea, basic.parkingArea);
  const active = inv.equipment.filter((e) => !e.status || e.status === 'active');
  const bName = (id) => (site.buildings || []).find((b) => b.id === id)?.name || '';
  const eqKw = (e) => (e.category === 'lighting' ? (num(e.fields?.wattPerFixture) ?? 0) / 1000 : (num(e.fields?.powerKw) ?? 0)) * (num(e.fields?.qty) ?? 1);
  const eqKwh = (e) => (num(e.fields?.hoursPerYear) === undefined ? undefined : eqKw(e) * num(e.fields.hoursPerYear));

  // 說明
  const cover = new Sheet(ctx, '說明', '能源查核制度申報表（非生產性質行業）附表三·年度申報轉填稿', T3('前言', '§5.0', '各表以 N 表資料年；本檔供人工轉填能源署申報系統（無公開匯入格式）'));
  cover.widths(110);
  cover.text(`院所：${ctx.hospital}　資料年 N＝民國 ${N} 年（${N + 1} 年 1 月底前申報）`);
  cover.text('帶入來源：初始建檔（表三、四、七、八）、設備主檔（表九）、電費單點位紀錄（表五之二、五之四）、節能措施與計畫（表十、十一）。');
  cover.text('系統推不出的欄位留空，逐項列在最後的「待補欄位」工作表。');
  cover.text('依能源管理法第 8、9、12 條辦理；須由已設置登記之技師或能管人員填寫簽章。');

  // 一、二 填表人員
  const staffB = siteBlockById('staff');
  const staff = site.staff || [];
  const s1 = new Sheet(ctx, '一二 填表人員', '一、填表人員／二、其他技師或能管人員', T3('一、填表人員；二、其他技師或能管人員', '§5.1–5.2'));
  tableRows(s1, staffB, staff);
  if (!staff.some((x) => x.role === '填表人員')) s1.need('一、填表人員', '尚未登錄填表人員');
  const sc = C.staffCountCheck({ contractKw: (site.meters || []).reduce((a, m) => a + (num(m.contractKw) ?? 0), 0), staff });
  s1.gap().text(`R9 檢核：${sc.msg}`);

  // 表三 基本資料
  const basicB = siteBlockById('basic');
  const s3 = new Sheet(ctx, '表三 基本資料', '三、能源用戶基本資料', T3('表三 01–25', '§5.3', '第 25 欄中小企業為新版新增；公務機關、國防組織填「否」'));
  const derived = { fillDate: { value: ctx.today, note: '產出日' } };
  if (feeN !== undefined) derived.energyCost = { value: r2(feeN / 10000, 2), note: `由 ${N} 年電費單應繳總額加總推算（僅電費；有燃料費請加計）` };
  formRows(s3, basicB, basic, { groups: ['表三'], derived, skip: new Set(isHospital ? ['occupancy'] : []) });
  s3.gap().text('簽名用印：能源用戶印信、能源管理人員、填表人、能源用戶負責人（國防組織用印信）——請於紙本／上傳檔用印。');
  const scale = C.businessScaleCheck({ userClass: basic.userCategory || '醫院', beds: basic.beds });
  if (scale.level === 'error') s3.text(`R9 檢核：${scale.msg}`);

  // 表三 電號資料
  const meterB = siteBlockById('meters');
  const sm = new Sheet(ctx, '表三 電號資料', '三、電號資料（含合併申報）', T3('表三 電號資料（含合併申報）', '§5.3', '合併申報須先依附錄二申請並經同意'));
  tableRows(sm, meterB, site.meters || [], { fields: meterB.fields.filter((f) => ['seq', 'meterNo', 'contractKw', 'contractHalfPeakKw', 'contractSatHalfPeakKw', 'contractOffPeakKw', 'contractStandbyKw', 'combined', 'combinedApproval'].includes(f.key)) });
  if (!(site.meters || []).length) sm.need('電號資料', '尚未建立電號');
  const r1 = C.energyUserCheck({ meters: site.meters || [], combine: true });
  sm.gap().text(`R1 檢核：${r1.msg}`);

  // 表四之一、之二
  const s41 = new Sheet(ctx, '表四之一 查核組織', '表四之一 能源查核組織', T3('表四之一', '§5.4', '管理／推行／執行三階層須齊全；管理不得兼推行或執行'));
  tableRows(s41, siteBlockById('org'), site.org || []);
  for (const lv of ['管理', '推行', '執行']) if (!(site.org || []).some((o) => o.level === lv)) s41.need(`${lv}階層成員`, '三階層須齊全');
  const policy = site.policy || {};
  const s42 = new Sheet(ctx, '表四之二 能源政策', '表四之二 能源政策', T3('表四之二', '§5.4', '已通過 ISO/CNS 50001 → 第 2–5 題免填'));
  formRows(s42, siteBlockById('policy'), policy, { skip: new Set(policy.iso50001 ? ['q2PolicyStatement', 'q3Review', 'q4Procurement', 'q5Channel'] : ['isoBody', 'isoValidUntil']) });

  // 表五之一 熱能
  const s51 = new Sheet(ctx, '表五之一 熱能', '表五之一 熱能使用量（依帳單月份）', T3('表五之一', '§5.5'));
  const fuelHead = ['燃料油（公秉）', '總價（元含稅）', '液化石油氣（公斤）', '總價', '天然氣（立方公尺）', '總價', '汽油（公升）', '總價', '柴油（公秉）', '總價'];
  s51.head(['月份', ...fuelHead]).widths(12, ...fuelHead.map(() => 14));
  monthsN.forEach((m, i) => s51.row([`${N} 年 ${i + 1} 月`, ...fuelHead.map(() => '')]));
  s51.row(['總計']).row(['平均']).row(['供應商名稱']).row(['客戶編號']);
  s51.need('1–12 月各燃料使用量、總價、供應商、客戶編號', '系統沒有燃料帳單點位；沒有使用的燃料填 0');

  // 表五之二 電能（每電號一張）
  const contractOf = (meter, row) => [
    row?.contractCapacity ?? num(meter?.contractKw), num(meter?.contractHalfPeakKw), num(meter?.contractSatHalfPeakKw), num(meter?.contractOffPeakKw), num(meter?.contractStandbyKw),
  ];
  const s52Head = ['月份', '經常契約容量', '半尖峰/非夏月契約容量', '週六半尖峰契約容量', '離峰契約容量', '備用契約容量',
    '最高需量·尖峰', '最高需量·半尖峰/非夏月半尖峰', '最高需量·週六半尖峰', '最高需量·離峰',
    '用電度數·尖峰', '用電度數·半尖峰/非夏月半尖峰', '用電度數·週六半尖峰', '用電度數·離峰', '用電度數·合計',
    '轉供度數', '功因（%）', '總電費（元含稅）'];
  const s52Sheets = [];
  meterSheets.forEach((ms, idx) => {
    const meter = ms.meter;
    const name = `表五之二 電號${ms.meterNo || idx + 1}`;
    const s = new Sheet(ctx, name, `表五之二 電能使用量（電號 ${ms.meterNo || '未指定'}）`, T3('表五之二', '§5.5', '每電號一張；申報月份＝帳單載明月份；契約容量 5 欄為新版'));
    s.widths(14, ...s52Head.slice(1).map(() => 13));
    s.row(['編號', meter?.seq ?? idx + 1]).row(['電號', ms.meterNo]).row(['契約用電別', meter?.tariffType || ms.tariffType || ''])
      .row(['戶名', meter?.accountName || '']).row(['用電地址', meter?.address || '']).row(['行業別', meter?.industry || '']);
    for (const [k, l] of [['tariffType', '契約用電別'], ['accountName', '戶名'], ['address', '用電地址'], ['industry', '行業別']]) if (blank(meter?.[k]) && !(k === 'tariffType' && ms.tariffType)) s.need(l, '電號資料未填');
    s.gap().head(s52Head);
    const firstDataRow = s.nextRow;
    const lacking = [];
    const cols = [];
    monthsN.forEach((m, i) => {
      const r = ms.months.get(m);
      if (!r) lacking.push(i + 1);
      const vals = [
        ...contractOf(meter, r),
        r?.demandPeak, r?.demandHalfPeak, r?.demandSatHalfPeak, r?.demandOffPeak,
        r?.usePeak, r?.useHalfPeak, r?.useSatHalfPeak, r?.useOffPeak, r?.useTotal,
        r?.wheelTotal, r?.powerFactor !== undefined ? C.powerFactorCheck(r.powerFactor).value : undefined, r?.feeTotal,
      ];
      cols.push(vals);
      s.row([`${N} 年 ${i + 1} 月`, ...vals.map((v) => (v === undefined ? '' : v))]);
    });
    const colVals = (j) => cols.map((c) => c[j]).filter((v) => v !== undefined);
    // 合計：度數、轉供、電費加總；平均：所有數值欄
    const SUMS = new Set([9, 10, 11, 12, 13, 14, 16]);
    s.row(['合計', ...s52Head.slice(1).map((_, j) => (SUMS.has(j) && colVals(j).length ? r2(colVals(j).reduce((a, b) => a + b, 0)) : ''))]);
    s.row(['平均', ...s52Head.slice(1).map((_, j) => (colVals(j).length ? r2(colVals(j).reduce((a, b) => a + b, 0) / colVals(j).length) : ''))]);
    if (lacking.length) s.need(`${lacking.join('、')} 月電費單`, '未登錄電費單紀錄（貼紙點位電費單項目）');
    if (blank(meter?.contractHalfPeakKw) && blank(meter?.contractOffPeakKw)) s.need('半尖峰/非夏月、週六半尖峰、離峰、備用契約容量', '電號資料未填（沒有可留空）');
    s52Sheets.push({ sheet: s, firstDataRow, meterNo: ms.meterNo });
  });
  if (!meterSheets.length) new Sheet(ctx, '表五之二 電能', '表五之二 電能使用量', T3('表五之二', '§5.5')).text('尚未建立電號與電費單').need('電號與 1–12 月電費單', '無資料');

  // 表五之三
  const maxPeak = (() => { const xs = []; for (const s of meterSheets) for (const m of monthsN) { const v = s.months.get(m)?.demandPeak; if (v !== undefined) xs.push(v); } return xs.length ? Math.max(...xs) : undefined; })();
  const lightKw = active.filter((e) => e.category === 'lighting').reduce((a, e) => a + eqKw(e), 0);
  const acKw = active.filter((e) => e.category === 'ac').reduce((a, e) => a + eqKw(e), 0);
  const rtOf = (list) => { const xs = list.filter((e) => /RT|冷凍噸/i.test(String(e.fields?.capacityUnit || ''))).map((e) => (num(e.fields?.capacity) ?? 0) * (num(e.fields?.qty) ?? 1)); return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined; };
  const central = active.filter((e) => e.category === 'ac' && e.kind === '中央空調主機');
  const packaged = active.filter((e) => e.category === 'ac' && ['箱型冷氣', '窗型冷氣', '分離式冷氣'].includes(e.kind));
  const s53 = new Sheet(ctx, '表五之三 效率因子', '表五之三 單位能源使用效率因子', T3('表五之三', '§5.5'));
  s53.head(['項目', '值', '單位', '計算方式']).widths(40, 16, 10, 60);
  const pct = (a, b) => (a && b ? r2(a / b * 100, 2) : '');
  s53.row(['照明耗電功率占最高尖峰需量', pct(lightKw, maxPeak), '%', `照明設備主檔 Σ(燈具電功率×數量) ${r2(lightKw, 1)} kW ÷ ${N} 年最高尖峰需量 ${maxPeak ?? '—'} kW`]);
  s53.row(['空調耗電功率占最高尖峰需量', pct(acKw, maxPeak), '%', `空調設備主檔 Σ(設備電功率×數量) ${r2(acKw, 1)} kW ÷ 最高尖峰需量`]);
  s53.row(['空調總裝置噸數·中央空調系統', rtOf(central) ?? '', 'USRT', '中央空調主機 容量（單位 RT）× 數量']);
  s53.row(['空調總裝置噸數·其他型式（窗箱分離式）', rtOf(packaged) ?? '', 'USRT', '箱型／窗型／分離式 容量（單位 RT）× 數量']);
  s53.row(['空調夏季最大運轉噸數·中央空調系統', '', 'USRT', '']).row(['空調夏季最大運轉噸數·其他型式', '', 'USRT', '']);
  if (maxPeak === undefined) s53.need('照明／空調耗電功率占比', `缺 ${N} 年電費單最高尖峰需量`);
  if (rtOf(central) === undefined && central.length) s53.need('空調總裝置噸數·中央空調系統', '中央空調主機容量單位不是 RT');
  if (rtOf(packaged) === undefined && packaged.length) s53.need('空調總裝置噸數·其他型式', '窗箱分離式容量單位不是 RT（1 USRT＝3,024 kcal/hr）');
  s53.need('空調夏季最大運轉噸數（兩類）', '需現場量測或 BEMS 紀錄');

  // 表五之四 電能 EUI
  const s54 = new Sheet(ctx, '表五之四 電能EUI', '表五之四 電能績效自我評比', T3('表五之四', '§5.5', '室內面積＝總樓地板－室內停車場；差異＝(N 年 EUI − N-1 年 EUI) ÷ N-1 年 EUI，> 10% 須說明'));
  s54.widths(14, 18, 18, 18, 18, 14, 10, 40);
  s54.row(['N-1 年室內樓地板面積（㎡）', area.value ?? '']).row(['N 年室內樓地板面積（㎡）', area.value ?? '']);
  if (area.ok !== true) s54.need('室內樓地板面積', area.msg);
  s54.text('註：N-1 年面積沿用目前初始建檔的總樓地板與室內停車場面積；如前一年不同請修正。');
  s54.head(['月份', `N-1（${N - 1}）年用電度數`, `N-1 年 EUI（度/㎡）`, `N（${N}）年用電度數`, 'N 年 EUI（度/㎡）']);
  const eui = (k) => (k !== undefined && area.ok === true ? r2(k / area.value, 4) : '');
  monthsN.forEach((m, i) => s54.row([`${i + 1} 月`, kwhByMonth[monthsP[i]] ?? '', eui(kwhByMonth[monthsP[i]]), kwhByMonth[m] ?? '', eui(kwhByMonth[m])]));
  const kwhP = yearKwh(monthsP);
  s54.row(['全年', kwhP ?? '', eui(kwhP), kwhN ?? '', eui(kwhN)]);
  s54.gap().head(['期間', 'N-1 年 EUI', 'N 年 EUI', '差異（%）', '增加／減少', '', '', '原因（> 10% 須填）']);
  const quarters = [[0, 3], [3, 6], [6, 9], [9, 12], [0, 12]];
  quarters.forEach(([a, b], qi) => {
    const label = qi === 4 ? '全年' : `第 ${qi + 1} 季`;
    // 兩年該期間的月份都齊了才比較：只有部分月份的話，差異會被缺月拉歪（例如 N 年只到 9 月）
    const lackP = monthsP.slice(a, b).filter((m) => kwhByMonth[m] === undefined).length;
    const lackN = monthsN.slice(a, b).filter((m) => kwhByMonth[m] === undefined).length;
    const p = yearKwh(monthsP.slice(a, b)), c = yearKwh(monthsN.slice(a, b));
    const ep = eui(p), ec = eui(c);
    if (lackP || lackN) {
      s54.row([label, lackP ? '' : ep, lackN ? '' : ec, '', '', '', '', '']);
      s54.need(`${label} EUI 差異`, `${lackP ? `N-1 年缺 ${lackP} 個月` : ''}${lackP && lackN ? '、' : ''}${lackN ? `N 年缺 ${lackN} 個月` : ''}電費單，補齊後才能比較`);
      return;
    }
    const d = C.euiDiffCheck(ep === '' ? undefined : ep, ec === '' ? undefined : ec, '');
    s54.row([label, ep, ec, d.value ?? '', d.value === undefined ? '' : d.value >= 0 ? '增加' : '減少', '', '', '']);
    if (d.reasonRequired) s54.need(`${label} EUI 差異原因`, `差異 ${d.value}%，超過 ±10% 須說明（R9）`);
    else if (d.ok === null) s54.need(`${label} EUI 差異`, '缺 N-1 年或 N 年電費單度數');
  });

  // 表五之五 熱能 EUI
  const s55 = new Sheet(ctx, '表五之五 熱能EUI', '表五之五 熱能績效自我評比', T3('表五之五', '§5.5', '〔新版〕EUI 單位改為公斤油當量/㎡（1 公斤油當量＝10,000 千卡）'));
  s55.widths(14, 22, 22, 22, 22);
  s55.row(['室內樓地板面積（㎡）', area.value ?? '']);
  s55.head(['月份', 'N-1 年熱能（公斤油當量）', 'N-1 年 EUI（公斤油當量/㎡）', 'N 年熱能（公斤油當量）', 'N 年 EUI（公斤油當量/㎡）']);
  monthsN.forEach((_, i) => s55.row([`${i + 1} 月`, '', '', '', '']));
  s55.text('換算：表五之一各燃料量 × §6.1 熱值（燃料油 9,320 千卡/公升、LPG 約 10,832 千卡/公斤、天然氣 NG1 8,107 千卡/立方公尺、汽油 7,520 千卡/公升、柴油 8,629 千卡/公升）÷ 10,000。');
  s55.need('N-1／N 年 1–12 月熱能使用量', '依表五之一燃料量換算；系統沒有燃料帳單紀錄');

  // 六、能源流程
  const ELEC_USES = ['空調', '照明', '冷凍冷藏', '事務', '送排風', '給水污水', '電梯', '其他'];
  const useOf = (e) => (e.category === 'ac' ? '空調' : e.category === 'lighting' ? '照明' : ({ 冷凍冷藏: '冷凍冷藏', 事務設備: '事務', 送排風: '送排風', 給水污水: '給水污水', 電梯: '電梯' })[e.kind] || '其他');
  const s6 = new Sheet(ctx, '表六 能源流程', '六、能源流程分析（電能平衡、熱能平衡）', T3('六、能源流程分析', '§5.6'));
  s6.widths(36, 18, 12, 50);
  s6.head(['電能平衡', '度/年', '%', '說明']);
  s6.row(['台電電費單總用電度數（含轉供）', kwhN ?? '', '', `${N} 年各電號電費單合計度數`]);
  s6.row(['再生能源自用總度數', '', '', '']).row(['再生能源回售台電總度數', '', '', '']).row(['再生能源總發電量', '', '', '']);
  s6.need('再生能源自用／回售／總發電量', '系統沒有再生能源紀錄；沒有設置填 0');
  const est = Object.fromEntries(ELEC_USES.map((u) => [u, 0]));
  let estAny = false;
  for (const e of active.filter((x) => x.fields?.energyType === undefined || x.fields?.energyType === '電力' || x.category === 'lighting')) {
    const k = eqKwh(e); if (k === undefined) continue; est[useOf(e)] += k; estAny = true;
  }
  const estTotal = Object.values(est).reduce((a, b) => a + b, 0);
  for (const u of ELEC_USES) s6.row([`設備分類·${u}`, estAny ? r2(est[u], 0) : '', estAny && estTotal ? r2(est[u] / estTotal * 100, 1) : '', '設備主檔 Σ(電功率×數量×運轉時數) 估算，請依實測校正']);
  if (!estAny) s6.need('電能平衡·依設備分類度數', '設備主檔未填運轉時數');
  s6.gap().head(['熱能平衡·燃料別', '百萬卡/年', '%', '說明']);
  const boilers = active.filter((e) => e.category === 'other' && e.kind === '鍋爐');
  const FUEL = { 燃料油: 'E02', 液化石油氣: 'E03', 天然氣: 'E04', 柴油: 'E06' };
  const heat = {};
  for (const b of boilers) { const code = FUEL[b.fields?.boilerEnergyType]; const u = num(b.fields?.boilerAnnualUse); if (code && u !== undefined) heat[code] = (heat[code] || 0) + u * C.ENERGY_UNITS[code].kcal / 1000; }
  const heatTotal = Object.values(heat).reduce((a, b) => a + b, 0);
  for (const code of ['E02', 'E03', 'E04', 'E05', 'E06']) s6.row([energyLabel(code), heat[code] !== undefined ? r2(heat[code], 2) : '', heat[code] !== undefined && heatTotal ? r2(heat[code] / heatTotal * 100, 1) : '', heat[code] !== undefined ? '鍋爐年度使用量 × §6.1 熱值 ÷ 10⁶（天然氣用 NG1）' : '']);
  s6.need('熱能平衡·各用途（房間用、洗衣房、廚房餐廳、消毒設備…）百萬卡/年', '需依燃料用途分配；系統無資料');

  // 表七
  const s7 = new Sheet(ctx, '表七 建築資料', '七、建築資料', T3('表七', '§5.7', '建築名稱須與表九一致'));
  tableRows(s7, siteBlockById('buildings'), site.buildings || []);
  if (!(site.buildings || []).length) s7.need('建築資料', '尚未建立');

  // 表八
  const s8 = new Sheet(ctx, '表八 電能系統', '八、電能系統', T3('表八', '§5.8', '功因合理 > 95%；負載率合理 50–75%'));
  const xB = siteBlockById('transformers');
  tableRows(s8, xB, site.transformers || [], {
    map: (r, f) => {
      // 建築物名稱存 buildings[].id；舊資料對不上的原文字照印，並列入待補
      if (f.type === 'ref') return refLabel(site, f.ref, r[f.key]);
      if (f.key === 'opLoadRate' && blank(r.opLoadRate) && num(r.opSecondaryV) && num(r.opMaxA) && num(r.kva)) {
        return r2(1.732 * num(r.opSecondaryV) * num(r.opMaxA) / 1000 / num(r.kva) * 100, 1);   // [(1.732×V×A×PF/1000)÷kVA]÷PF
      }
      return r[f.key];
    },
  });
  (site.transformers || []).forEach((t) => {
    const lr = num(t.opLoadRate) ?? (num(t.opSecondaryV) && num(t.opMaxA) && num(t.kva) ? 1.732 * num(t.opSecondaryV) * num(t.opMaxA) / 1000 / num(t.kva) * 100 : undefined);
    if (lr === undefined) s8.need(`變壓器 ${t.code || ''} 尖峰抄表運轉值`, '溫度、實際電壓、最大負載電流、功因');
    else { const c = C.transformerLoadCheck({ loadPct: lr }); if (c.level === 'warn') s8.text(`R9 提示：變壓器 ${t.code}：${c.msg}`); }
  });
  if (!(site.transformers || []).length) s8.need('變壓器規格', '尚未建立');
  for (const x of siteRefIssues(inv).filter((i) => i.block === 'transformers')) s8.need(`變壓器 ${(site.transformers || []).find((t) => t.id === x.rowId)?.code || ''} 建築物名稱`, `「${x.value}」對不到表七建築資料，請在初始建檔改選`);
  s8.gap();
  formRows(s8, basicB, basic, { groups: ['表八'] });
  s8.gap();
  tableRows(s8, siteBlockById('generators'), site.generators || []);

  // 表九之一（一）（二）
  const groups = chillerGroups(inv);
  const s911 = new Sheet(ctx, '表九之一（一）冰水機群組', '表九之一（一）冰水機群組列表', T3('表九之一（一）', '§5.9'));
  s911.head(['項次', '建築名稱', '冰水機群組名稱', '群組主機總容量（RT，系統計算）']).widths(8, 24, 24, 24);
  groups.forEach((g, i) => s911.row([i + 1, g.building, g.name, g.totalRt ?? '']));
  if (!groups.length) s911.row(['（設備主檔未標冰水機群組）']);
  const s912 = new Sheet(ctx, '表九之一（二）群組效率', '表九之一（二）冰水機群組系統效率', T3('表九之一（二）', '§5.9', '單一群組冰水主機含備用機總容量 ≥ 1,000 RT 必填；逐時量測紀錄保存 ≥ 5 年'));
  s912.widths(20, 20, 12, 16, 16, 14, 24);
  s912.text('資料來源：點位項目標示 chillerGroup（群組）＋chillerRole（kwh 月耗電量／rth 系統負荷），當月紀錄加總（累計讀數取用量）。');
  s912.head(['建築名稱', '冰水機群組名稱', '月份', '月耗電量（kWh）', '系統負荷（RTh）', '效率（kW/RT）', '備註（□整月未開主機／□其他）']);
  for (const g of groups) {
    const months = monthsN.map((m) => chillerMonth(inv, g.name, m));
    const chk = C.chillerTableCheck({ totalRt: g.totalRt, months });
    if (chk.value === false) { s912.row([g.building, g.name, '—', '', '', '', chk.msg]); continue; }
    months.forEach((x, i) => s912.row([g.building, g.name, `${i + 1} 月`, x.kwh ?? '', x.rth ?? '', x.eff.value ?? '', '']));
    if (chk.ok === false) s912.need(`${g.name} 月耗電量／系統負荷`, chk.msg + '；整月未開主機請在備註勾選');
    else if (chk.ok === null) s912.need(`${g.name} 群組總容量`, '中央空調主機容量未填或單位不是 RT，無法判定是否必填');
  }
  if (!groups.length) s912.row(['（無冰水機群組）']);

  // 表九之一（三）／九之二／九之三
  const eqSheet = (name, title, catId, ref) => {
    const cat = categoryById(catId);
    const list = active.filter((e) => e.category === catId);
    const fields = cat.fields.filter((f) => f.group !== '鍋爐操作概況');
    const s = new Sheet(ctx, name, title, T3(ref, '§5.9', cat.source?.note));
    tableRows(s, null, list, { lead: [{ label: '建築物名稱', get: (e) => bName(e.building) }, { label: '設備種類', get: (e) => e.kind }], fields, map: (e, f) => (f.kinds && !f.kinds.includes(e.kind) ? '' : e.fields?.[f.key]) });
    const lackBuilding = list.filter((e) => !e.building).length;
    if (lackBuilding) s.need('建築物名稱', `${lackBuilding} 台設備未指定建築`);
    return s;
  };
  eqSheet('表九之一（三）空調設備', '表九之一（三）空調設備', 'ac', '表九之一（三）');
  eqSheet('表九之二 照明', '表九之二 照明設備', 'lighting', '表九之二');
  eqSheet('表九之三 其他系統', '表九之三 其他系統', 'other', '表九之三');

  // 表九之四
  const SYSTEMS = ['空調', '照明', '冷凍冷藏', '事務', '送排風', '給水污水', '電梯', '鍋爐', '熱泵', '壓縮空氣', '其他'];
  const sysOf = (e) => (e.category === 'ac' ? '空調' : e.category === 'lighting' ? '照明' : ({ 冷凍冷藏: '冷凍冷藏', 事務設備: '事務', 送排風: '送排風', 給水污水: '給水污水', 電梯: '電梯', 鍋爐: '鍋爐', 熱泵: '熱泵', 壓縮空氣: '壓縮空氣' })[e.kind] || '其他');
  const s94 = new Sheet(ctx, '表九之四 系統耗電量', '表九之四 系統耗電量彙整', T3('表九之四', '§5.9', '設備利用率＝年平均運轉容量 ÷ 總容量；全年運轉時數 %＝實際時數 ÷ 8,760'));
  s94.head(['系統', '總容量（kW）', '年平均運轉容量（kW）', '設備利用率（%）', '全年實際運轉時數（h，容量加權）', '全年運轉時數（%）', '估算年耗電量（度）']).widths(14, 14, 18, 14, 22, 14, 18);
  for (const sys of SYSTEMS) {
    const list = active.filter((e) => sysOf(e) === sys);
    const cap = list.reduce((a, e) => a + eqKw(e), 0);
    const withH = list.filter((e) => num(e.fields?.hoursPerYear) !== undefined);
    const hCap = withH.reduce((a, e) => a + eqKw(e), 0);
    const h = hCap ? withH.reduce((a, e) => a + eqKw(e) * num(e.fields.hoursPerYear), 0) / hCap : undefined;
    const kwh = withH.reduce((a, e) => a + eqKwh(e), 0);
    s94.row([sys, list.length ? r2(cap, 2) : '', '', '', h !== undefined ? r2(h, 0) : '', h !== undefined ? C.runHoursRate(Math.min(h, 8760)).value : '', withH.length ? r2(kwh, 0) : '']);
  }
  s94.need('各系統年平均運轉容量、設備利用率', '需現場量測或 BEMS 紀錄');

  // 表九之五 重大使用能源設備
  const s95 = new Sheet(ctx, '表九之五 重大設備', '表九之五 重大使用能源設備', T3('表九之五', '§5.9', '陸用燃煤／燃油／燃氣蒸汽鍋爐（不含貫流式）'));
  s95.head(['系統名稱', '設備名稱', '操作管理現況（依標準程序／依使用者經驗）', '實施設備維護現況（定期／不定期）']).widths(16, 24, 36, 32);
  const majors = boilers.filter((b) => C.boilerCheck({ kind: b.fields?.subKind, type: b.fields?.model, fuel: b.fields?.boilerEnergyType }).value.majorEquipment);
  majors.forEach((b) => { s95.row(['鍋爐', b.fields?.name || '', '', '']); s95.need(`${b.fields?.name || '鍋爐'} 操作管理與維護現況`, '系統無此資料'); });
  if (!majors.length) s95.row(['（無符合條件之設備）']);

  // 表九之六 鍋爐
  const s96 = new Sheet(ctx, '表九之六 鍋爐操作', '表九之六 鍋爐操作概況', T3('表九之六', '§5.9', '〔新版〕「燃料種類」改「能源種類」並新增電力'));
  s96.head(['鍋爐項次', '構造檢查號碼', '種類', '型式', '能源種類', '年度使用量', '單位', '鍋爐容量', '容量單位', '操作狀態']).widths(10, 16, 10, 10, 12, 14, 10, 12, 14, 22);
  const unitByFuel = { 燃料油: '公秉', 液化石油氣: '公斤', 天然氣: '立方公尺', 柴油: '公秉', 電力: '度' };
  boilers.forEach((b, i) => {
    const f = b.fields || {};
    s96.row([i + 1, f.inspectionNo || '', f.subKind || '', f.model || '', f.boilerEnergyType || '', f.boilerAnnualUse ?? '', unitByFuel[f.boilerEnergyType] || '', f.capacity ?? '', f.capacityUnit || '', f.boilerOpStatus || '']);
    for (const [k, l] of [['inspectionNo', '構造檢查號碼'], ['boilerEnergyType', '能源種類'], ['boilerAnnualUse', '年度使用量'], ['boilerOpStatus', '操作狀態']]) if (blank(f[k])) s96.need(`${f.name || `鍋爐 ${i + 1}`} ${l}`, '設備主檔未填');
  });
  if (!boilers.length) s96.row(['（無鍋爐）']);

  // 表九之七
  const s97 = new Sheet(ctx, '表九之七 鍋爐自我檢測', '表九之七 蒸汽鍋爐自我檢測', T3('表九之七', '§5.9', '僅蒸汽鍋爐且非貫流式'));
  const selfTest = boilers.filter((b) => C.boilerCheck({ kind: b.fields?.subKind, type: b.fields?.model, fuel: b.fields?.boilerEnergyType }).value.selfTestRequired);
  if (!selfTest.length) s97.text('免填：無非貫流式蒸汽鍋爐。');
  for (const b of selfTest) {
    s97.text(`鍋爐：${b.fields?.name || ''}`).head(['月份', '最末排氣溫度（℃，月平均）', '超標原因', '排氣含氧量（%，月平均）', '超標原因']);
    monthsN.forEach((_, i) => s97.row([`${i + 1} 月`, '', '', '', '']));
    s97.need(`${b.fields?.name || '蒸汽鍋爐'} 1–12 月排氣溫度與含氧量`, '每日／每週量測取月平均');
  }

  // 表九之八
  const s98 = new Sheet(ctx, '表九之八 PUE', '表九之八 資料中心 PUE', T3('表九之八', '§5.9', '僅電信／電腦機房類用戶'));
  const pr = C.pueTableRequired(basic.userCategory || '醫院');
  s98.text(pr.value ? '須填：' + pr.msg : `免填：${pr.msg}`);
  if (pr.value) s98.need('表九之八 PUE 全表', pr.msg);

  // 表十（N 年執行成效）
  const inN = (p) => p.fields.status !== '取消' && ((C.parseDate(p.fields.actualDoneDate)?.getUTCFullYear() - 1911) === N || (p.fields.status === '已完工' || p.fields.status === '執行中') && num(p.fields.completionYear) === N);
  const plansN = pv.filter(inN);
  const s101 = new Sheet(ctx, '表十之一 成效分析', `表十之一 已執行節約能源改善方案具體成效分析（N＝${N}）`, T3('表十之一', '§5.10', 'N 年度新適用之能源用戶得免填表十；能源管理措施須保存文件或執行紀錄'));
  s101.head(['項次', '措施來源', '措施代碼', '能源種類', '已執行措施', '執行計畫說明（實施區域、施行對象、具體作法）', '改善前狀況', '改善後狀況', '執行計畫期間', '數值來源與單位說明', '節能量計算', '本項措施總節能量', '節約金額（元）', '實際投資金額（元）', '系統措施 ID'])
    .widths(6, 14, 10, 12, 24, 36, 18, 18, 16, 20, 20, 14, 14, 14, 18);
  plansN.forEach((p, i) => {
    const m = mv.replace.concat(mv.operation).find((x) => x.id === p.measureId);
    s101.row([i + 1, `${N} 年度計畫`, p.fields.officialCode || '', energyLabel(p.energyType), p.name, m?.values?.assessment || '', '', '', '', '', '', p.annualSaving ?? '', p.savingCost ?? '', p.investment ?? '', p.measureId]);
    if (!p.fields.officialCode) s101.need(`項次 ${i + 1} 措施代碼`, '附錄一代碼（§7.7）');
    s101.need(`項次 ${i + 1} 改善前／後狀況、執行期間、節能量計算`, '總節能量、金額先以診斷預估值帶入，請以實際成效修正');
  });
  if (!plansN.length) s101.row(['（節能計畫中沒有 N 年完工或執行中的措施）']);
  const s102 = new Sheet(ctx, '表十之二 執行成效', `表十之二 執行成效（N＝${N}）`, T3('表十之二', '§5.10'));
  s102.head(['項次', '措施來源', '措施代碼', '已執行措施', '執行計畫期間', '節能效益金額（千元）', '投資金額（千元）', '效益計算起月', '效益計算迄月', '抑低尖峰需量（瓩）', ...ENERGY_COLS.map(energyHead)])
    .widths(6, 14, 10, 24, 16, 14, 14, 12, 12, 14, 12, 12, 14, 14, 12, 12);
  const tot = Object.fromEntries(ENERGY_COLS.map((c) => [c, 0]));
  plansN.forEach((p, i) => {
    s102.row([i + 1, `${N} 年度計畫`, p.fields.officialCode || '', p.name, '', num(p.savingCost) !== undefined ? r2(p.savingCost / 1000, 3) : '', num(p.investment) !== undefined ? r2(p.investment / 1000, 3) : '', '', '', '', ...ENERGY_COLS.map((c) => (c === (p.energyType || 'E01') ? (p.annualSaving ?? '') : ''))]);
    if (num(p.annualSaving) !== undefined) tot[p.energyType || 'E01'] += num(p.annualSaving);
  });
  if (plansN.length) { s102.row(['合計', '', '', '', '', '', '', '', '', '', ...ENERGY_COLS.map((c) => tot[c] || '')]); s102.need('執行計畫期間、效益計算起迄月、抑低尖峰需量', '系統未記錄'); }
  else s102.row(['（無）']);

  const s103 = new Sheet(ctx, '表十之三 需量反應與再生', '表十之三 需量反應與再生能源之節電量換算', T3('表十之三（一）（二）', '§5.10', '〔新版〕舊版「節約熱能措施」表已刪除；實際抑低量須有台電佐證'));
  s103.text('（一）需量反應負載管理相關措施及電力交易平台方案').head(['月份', '台電電號', '措施名稱', '方案細項（a–o）', '實際抑低量（瓩）', '抑低時數', '認列節電量（度）']).widths(10, 16, 20, 14, 14, 10, 14);
  monthsN.forEach((_, i) => s103.row([`${i + 1} 月`, '', '', '', '', '', '']));
  s103.gap().text('（二）再生能源自發自用').head(['序號', '再生能源種類', '設置登記電號', '設置區域', '設置時間', '裝置容量（瓩）', '年發電量（度）', '回售台電電量（度）', '自發自用認列節電量（度）']);
  s103.row(['', '', '', '', '', '', '', '', '']);
  s103.need('表十之三（一）（二）', '有參與需量反應或設置再生能源才填；系統無此紀錄');

  const s104 = new Sheet(ctx, '表十之四 年度用電量計算', `表十之四 年度用電量計算（N＝${N}）`, T3('表十之四', '§5.10', '〔新版〕改為「年度用電量計算」，表內不再計算節電率；可扣除用電量可複選，各填度數並附用印佐證'));
  s104.head(['項目', '度數', '說明']).widths(60, 18, 50);
  const cN = C.annualConsumptionN({ billKwh: kwhN });
  s104.row(['列管電號 1–12 月電費單度數', kwhN ?? '', '各電號電費單合計度數（表五之二）']);
  s104.row(['表十之三（二）自發自用認列節電量', '', '']);
  s104.row(['N 年全年實際用電量', cN.actual ?? '', '＝電費單度數＋自發自用認列節電量（自發自用未填以 0 計）']);
  s104.text('可扣除用電量（可複選）：');
  for (const d of C.DEDUCTIONS_N) s104.row([`${d.no}. ${d.label}`, '', '']);
  s104.row(['年度用電量', cN.value ?? '', '＝全年實際用電量－可扣除用電量（可扣除未填以 0 計）']);
  if (kwhN === undefined) s104.need('列管電號 1–12 月電費單度數', `缺 ${N} 年電費單`);
  s104.need('可扣除用電量（8 項，如有）', '各填度數並附用印佐證；沒有可留空');

  // 表十一（N+1 年計畫）
  const N1 = N + 1;
  const plansN1 = pv.filter((p) => p.fields.status !== '取消' && p.fields.status !== '已完工' && num(p.fields.completionYear) === N1);
  const s111 = new Sheet(ctx, '表十一之一 規劃執行計畫', `表十一之一 規劃節約能源措施執行計畫表（N+1＝${N1}）`, T3('表十一之一', '§5.11', '結構同表十之一；與附件二節能計畫最接近，資料由節能計畫帶入'));
  s111.head(['項次', '措施來源', '措施代碼', '能源種類', '預計執行措施', '執行計畫說明', '改善前狀況', '預計改善後狀況', '預計執行計畫期間', '執行計畫所需人力', '經費（元）', '節能量估算', '節約金額估算（元）', '系統措施 ID'])
    .widths(6, 14, 10, 12, 24, 36, 18, 18, 16, 16, 14, 14, 14, 18);
  plansN1.forEach((p, i) => {
    const m = mv.replace.concat(mv.operation).find((x) => x.id === p.measureId);
    s111.row([i + 1, `${N1} 年度計畫`, p.fields.officialCode || '', energyLabel(p.energyType), p.name, m?.values?.assessment || '', '', '', '', '', p.investment ?? '', p.annualSaving ?? '', p.savingCost ?? '', p.measureId]);
    if (!p.fields.officialCode) s111.need(`項次 ${i + 1} 措施代碼`, '附錄一代碼（§7.7）');
  });
  if (plansN1.length) s111.need('改善前後狀況、預計執行期間、所需人力', '系統未記錄');
  else s111.row([`（節能計畫中沒有預計 ${N1} 年完工的措施）`]);
  const s112 = new Sheet(ctx, '表十一之二 節能量預估', `表十一之二 規劃節約能源措施暨節能量預估情形（N+1＝${N1}）`, T3('表十一之二', '§5.11'));
  s112.head(['項次', '措施來源', '措施代碼', '預計執行措施', '預計執行計畫期間', '節能效益金額（千元）', '投資金額（千元）', '效益計算起月', '效益計算迄月', '抑低尖峰需量（瓩）', ...ENERGY_COLS.map(energyHead)])
    .widths(6, 14, 10, 24, 16, 14, 14, 12, 12, 14, 12, 12, 14, 14, 12, 12);
  plansN1.forEach((p, i) => s112.row([i + 1, `${N1} 年度計畫`, p.fields.officialCode || '', p.name, '', num(p.savingCost) !== undefined ? r2(p.savingCost / 1000, 3) : '', num(p.investment) !== undefined ? r2(p.investment / 1000, 3) : '', '', '', '', ...ENERGY_COLS.map((c) => (c === (p.energyType || 'E01') ? (p.annualSaving ?? '') : ''))]));
  if (!plansN1.length) s112.row(['（無）']);
  const s113 = new Sheet(ctx, '表十一之三 需量反應與再生', `表十一之三 規劃需量反應與再生能源自發自用之節電量換算（N+1＝${N1}）`, T3('表十一之三', '§5.11', '結構同表十之三；DR 為「預估抑低量」'));
  s113.text('（一）需量反應').head(['月份', '台電電號', '措施名稱', '方案細項（a–o）', '預估抑低量（瓩）', '抑低時數', '認列節電量（度）']);
  s113.gap().text('（二）再生能源自發自用').head(['序號', '再生能源種類', '設置登記電號', '設置區域', '預計設置時間', '裝置容量（瓩）', '預估年發電量（度）', '預估回售（度）', '預估自發自用認列（度）']);
  s113.need('表十一之三', '有規劃需量反應或再生能源才填');
  const s114 = new Sheet(ctx, '表十一之四 年度用電量估算', `表十一之四 年度用電量估算（N+1＝${N1}）`, T3('表十一之四', '§5.11', '□沿用 N 年全年實際用電量（6 項可扣除）或 □其他估算方式（須附估算說明）'));
  s114.head(['項目', '度數', '說明']).widths(60, 18, 50);
  const f1 = C.forecastConsumption({ actualKwh: cN.actual });
  s114.row(['☑ 沿用 N 年全年實際用電量', cN.actual ?? '', '預設勾選；如改用其他估算方式請改勾下方並附說明']);
  s114.text('可扣除用電量（可複選）：');
  for (const d of C.DEDUCTIONS_N1) s114.row([`${d.no}. ${d.label}`, '', '']);
  s114.row(['N+1 年年度用電量估算', f1.value ?? '', '＝沿用值－可扣除用電量']);
  s114.row(['□ 其他估算方式', '', '須附估算說明']);
  s114.need('表十一之四 可扣除用電量（6 項，如有）或其他估算方式說明', '院方判斷');

  missingSheet(ctx, '附表三');
  return { sheets: ctx.sheets, missing: ctx.missing, filename: `附表三_能源查核申報_${N}年資料.xlsx`, year: N, s52: s52Sheets.map((x) => ({ name: x.sheet.name, firstDataRow: x.firstDataRow, meterNo: x.meterNo })) };
}

// ════════════════════════════════════════════════════════════════
// 附件一 節能診斷報告
// ════════════════════════════════════════════════════════════════
export function buildDiagnosis(invIn, opts = {}) {
  const inv = clone(invIn);
  const ry = reportYearOf(inv, opts.today || todayIso());
  const ctx = newCtx(inv, opts, `提報年度 ${ry}`);
  materialize(inv, ry);
  const mv = measuresView(inv, ry);
  const diag = diagnosisOf(inv);
  const all = [...mv.replace, ...mv.operation];
  const ng = opts.ng || 'NG1';
  const sum = C.diagnosisSummary(all.map((m) => ({ id: m.id, energyType: m.values.energyType, annualSaving: m.values.annualSaving })), { ng });

  const s0 = new Sheet(ctx, '報告主檔', '節能診斷報告·報告主檔', A1('報告主檔（DR-00-01～04）', '資格證明文件及報告由能源用戶留存至少 5 年（自提報日期起算）'));
  s0.head(['代碼', '欄位', '值', '說明']).widths(12, 22, 30, 40);
  const keep = diag.reportDate ? C.toRocDate(C.addYears(diag.reportDate, 5)) : '';
  s0.row(['DR-00-01', '能源用戶名稱', ctx.hospital, '初始建檔·基本資料 07 用戶名稱']);
  s0.row(['DR-00-02', '提報日期', diag.reportDate ? rocDate(diag.reportDate) : '', '']);
  s0.row(['DR-00-03', '期別', diag.period || '', '']);
  s0.row(['DR-00-04', '保存期限', keep, '自動＝提報日＋5 年']);
  if (!diag.reportDate) s0.need('DR-00-02 提報日期', '必填；R6 機齡與 R7 完工年度以此年度計算（目前暫用今年）');
  if (!inv.site.basic?.userName) s0.need('DR-00-01 能源用戶名稱', '初始建檔基本資料未填');

  const s1 = new Sheet(ctx, '一、診斷摘要', '一、診斷摘要', A1('一、診斷摘要', '節能潛力依 §6.1 能源署熱值表換算公噸油當量'));
  s1.widths(14, 40, 20, 50);
  s1.text(`能源用戶（${ctx.hospital}）提報節能診斷報告，共包含 ${sum.value.count} 項具體節能改善措施，計發掘節能潛力 ${sum.value.toe} 公噸油當量，其中包括節電潛力 ${sum.value.tenThousandKwh} 萬度。`);
  s1.gap().head(['代碼', '欄位', '值', '說明']);
  s1.row(['DR-01-02', '措施項數', sum.value.count, `設備汰換 ${mv.replace.length} 項＋操作面 ${mv.operation.length} 項`]);
  s1.row(['DR-01-03', '節能潛力（公噸油當量）', sum.value.toe, '各措施年節能量 × 公噸油當量係數加總']);
  s1.row(['DR-01-04', '節電潛力（萬度）', sum.value.tenThousandKwh, '電力措施年節能量 ÷ 10,000']);
  s1.gap().text('換算係數（能源署「能源產品單位熱值表」113 年起適用、114 年修正；1 公噸油當量＝10⁷ 千卡）：');
  s1.head(['代碼', '能源', '公噸油當量／單位', '註']);
  for (const [code, e] of Object.entries(C.ENERGY_UNITS)) s1.row([code, `${e.label}（${e.unit}）`, code === 'E04' ? e.ng[ng] : e.toe, code === 'E04' ? `本報告天然氣以 ${ng} 熱值換算；院方瓦斯屬 NG1 或 NG2 待確認` : (e.note || '')]);
  s1.text('註：熱值表註明「僅供能源統計使用」；診斷規定未指定節能潛力換算係數，本報告先採此表（spec §9-5c 待確認）。');
  s1.gap().text(`原文：${ORIGINAL_TEXT.a1Summary}`);
  if (sum.value.missing.length) s1.need('年節能量預估', `${sum.value.missing.length} 項措施未填，未計入節能潛力`);

  // 二、設備汰換
  const R = MEASURE_TYPES.replace;
  const s2 = new Sheet(ctx, '二、設備汰換', '二、設備汰換節能改善措施', R.source);
  const h2 = ['編號', '設備名稱', '廠牌', '型式', '製造年份', '設備容量', '容量單位', '數量', '運轉時數（小時）', '年耗能量', '單位', '使用效率評估與改善作法說明', '節能率（%）', '年節能量預估', '單位', '節省能源費用（元/年）', '投資金額（元）', '回收年限（年）'];
  const x2 = ['設備類別（R6）', '機齡', '強制列入', '涉及生產機密', '補充說明', '措施 ID', '設備主檔 ID'];
  s2.head([...h2, ...x2]).widths(6, 20, 12, 12, 10, 10, 10, 8, 12, 12, 8, 36, 10, 12, 8, 14, 14, 10, 14, 8, 10, 10, 30, 18, 18);
  mv.replace.forEach((m) => {
    const v = m.values;
    s2.row([m.no, v.name || '', v.brand || '', v.model || '', rocYear(v.madeYear), v.capacity ?? '', v.capacityUnit || '', v.qty ?? '', v.hoursPerYear ?? '',
      v.annualUse ?? '', m.unit, v.assessment || '', v.savingPct ?? '', v.annualSaving ?? '', m.unit, v.savingCost ?? '', v.investment ?? '',
      m.payback.value ?? (m.payback.notApplicable ? '無法回收／不適用' : ''),
      m.replaceCategory || '', m.r6?.age ?? '', m.mandatory ? '是（不可刪）' : '否', v.secret ? '是' : '否', v.note || '', m.id, m.equipmentId || '']);
    const lack = [['assessment', '使用效率評估與改善作法說明'], ['annualSaving', '年節能量預估'], ['savingCost', '節省能源費用'], ['investment', '投資金額']].filter(([k]) => blank(v[k])).map(([, l]) => l);
    if (lack.length) s2.need(`編號 ${m.no} ${v.name || ''}`, `待補：${lack.join('、')}`);
  });
  if (!mv.replace.length) s2.row(['（無）']);
  s2.gap().text('註：');
  ORIGINAL_TEXT.a1Notes.forEach((t) => s2.text(t));

  // 三、操作面
  const s3 = new Sheet(ctx, '三、操作面', '三、操作面節能改善措施', MEASURE_TYPES.operation.source);
  s3.head(['編號', '措施類型', '措施名稱', '年耗能量', '單位', '使用效率評估與改善作法說明', '節能率（%）', '年節能量預估', '單位', '節省能源費用（元/年）', '投資金額（元）', '回收年限（年）', '補充說明', '措施 ID'])
    .widths(6, 22, 24, 12, 8, 36, 10, 12, 8, 14, 14, 10, 30, 18);
  mv.operation.forEach((m) => {
    const v = m.values;
    const type = [v.deviceClass && `${v.deviceClass} ${DEVICE_CLASSES[v.deviceClass]}`, v.action && `${v.action} ${ACTIONS[v.action]}`].filter(Boolean).join('／');
    s3.row([m.no, type, v.name || '', v.annualUse ?? '', m.unit, v.assessment || '', v.savingPct ?? '', v.annualSaving ?? '', m.unit, v.savingCost ?? '', v.investment ?? '', m.payback.value ?? (m.payback.notApplicable ? '無法回收／不適用' : ''), v.note || '', m.id]);
    const lack = [['deviceClass', '措施類型'], ['assessment', '使用效率評估與改善作法說明'], ['annualSaving', '年節能量預估'], ['savingCost', '節省能源費用'], ['investment', '投資金額']].filter(([k]) => blank(v[k])).map(([, l]) => l);
    if (lack.length) s3.need(`編號 ${m.no} ${v.name || ''}`, `待補：${lack.join('、')}`);
  });
  if (!mv.operation.length) s3.row(['（無）']);

  // 四、診斷團隊聲明
  const s4 = new Sheet(ctx, '四、診斷團隊聲明', '四、診斷團隊聲明', A1('四、診斷團隊聲明', '診斷團隊資格詳本規定第 3 點第 2 項（R3）'));
  s4.widths(22, 18, 14, 40, 16, 16, 16, 40);
  const names = diag.teams.map((t) => t.name).filter(Boolean);
  s4.text(`本節能診斷報告由能源用戶（${ctx.hospital}）洽請${names.length ? names.join('、') : '○○○'}等診斷團隊辦理。診斷團隊之資格（詳本規定第3點第2項）證明文件及診斷報告，由能源用戶留存至少5年（自提報日期起算），供中央主管機關查驗。`);
  s4.text(`文件保存到期日：${keep || '（待填提報日期）'}`);
  s4.gap().head(['診斷團隊名稱', '類型', '資格代碼', '資格說明', '技師執照科別', '執照字號', '執照有效期限', 'R3 檢核']);
  diag.teams.forEach((t) => {
    const chk = C.diagnosisTeamCheck({ code: t.code, members: t.members, commissioned: t.commissioned, licence: { discipline: t.licenceDiscipline, expiresAt: t.licenceExpiresAt } }, { reportDate: diag.reportDate });
    s4.row([t.name, t.type || '', t.code || '', TEAM_CODES[t.code] || '', t.licenceDiscipline || '', t.licenceNo || '', rocDate(t.licenceExpiresAt), chk.msg]);
    if (!t.docs) s4.need(`${t.name} 資格證明文件`, '留存至少 5 年');
    if (chk.ok === false) s4.need(`${t.name} 資格`, chk.msg);
  });
  if (!diag.teams.length) { s4.row(['（尚未登錄）']); s4.need('診斷團隊', '尚未登錄診斷團隊'); }
  s4.gap().head(['團隊', '姓名', '證照別', '證號', '年資（年）', '全職', '能管證書／高級電氣', '技師科別']);
  for (const t of diag.teams) for (const m of t.members || []) s4.row([t.name, m.name, m.certType || '', m.certNo || '', m.years ?? '', m.fullTime ? '是' : '否', [m.energyCert && '能管證書', m.seniorElectric && '高級電氣'].filter(Boolean).join('、'), m.engineerDiscipline || '']);
  s4.gap().text(`原文：${ORIGINAL_TEXT.a1Team}`);

  missingSheet(ctx, '節能診斷報告');
  return { sheets: ctx.sheets, missing: ctx.missing, filename: `附件一_節能診斷報告_${ry}年.xlsx`, summary: sum };
}

// ════════════════════════════════════════════════════════════════
// 附件二 節能計畫
// ════════════════════════════════════════════════════════════════
export function buildPlan(invIn, opts = {}) {
  const inv = clone(invIn);
  const ry = reportYearOf(inv, opts.today || todayIso());
  const ctx = newCtx(inv, opts, `提報年度 ${ry}（預計完工年度限 ${ry}～${ry + C.PLAN_SPAN_YEARS}）`);
  materialize(inv, ry);
  const mv = measuresView(inv, ry);
  const pv = plansView(inv, ry, mv);

  const s = new Sheet(ctx, '節能計畫', '節能計畫', A2('節能計畫表', 'R7 回收年限 < 10 年之措施必列；R8 執行與變更併同附表三申報'));
  s.head(['編號', '節能改善措施', '年節能量預估', '單位', '投資金額（元）', '回收年限（年）', '預計完工年度', '備註', '來源措施 ID', '措施類別', '強制納入', '計畫狀態', '實際完工日期', '節約能源措施代碼', 'R7 檢核'])
    .widths(6, 30, 12, 8, 14, 10, 12, 30, 18, 14, 10, 10, 12, 12, 40);
  pv.forEach((p) => {
    s.row([p.no, p.name, p.annualSaving ?? '', p.unit, p.investment ?? '', p.paybackYears ?? (p.payback?.notApplicable ? '無法回收／不適用' : ''), p.fields.completionYear ?? '', p.fields.note || '',
      p.measureId, p.measure?.typeLabel || '', p.mandatory ? '是（不可刪）' : '否', p.fields.status || '', rocDate(p.fields.actualDoneDate), p.fields.officialCode || '', p.check.msg]);
    if (p.check.ok === false) s.need(`編號 ${p.no} ${p.name}`, p.check.msg);
  });
  if (!pv.length) s.row(['（無）']);
  s.gap().text('註：');
  ORIGINAL_TEXT.a2Notes.forEach((t) => s.text(t));

  const sv = new Sheet(ctx, '版本紀錄', '節能計畫·版本紀錄（R8）', { ...A2('（R8 計畫執行與變更）', '保留計畫版本紀錄：變更前後、日期、原因'), doc: 'docs/energy-audit-spec.md §2 R8' });
  sv.head(['計畫編號', '節能改善措施', '版本', '變更日期', '變更人', '欄位', '變更前', '變更後', '原因']).widths(8, 26, 6, 14, 12, 14, 20, 20, 36);
  const fieldLabel = { completionYear: '預計完工年度', note: '備註', status: '計畫狀態', actualDoneDate: '實際完工日期', officialCode: '措施代碼' };
  let any = false;
  for (const p of pv) for (const v of p.versions) {
    const keys = [...new Set([...Object.keys(v.before || {}), ...Object.keys(v.after || {})])].filter((k) => JSON.stringify(v.before?.[k]) !== JSON.stringify(v.after?.[k]));
    for (const k of keys.length ? keys : ['—']) { any = true; sv.row([p.no, p.name, v.v, rocDate(v.at?.slice(0, 10)), v.who || '', fieldLabel[k] || k, v.before?.[k] ?? '', v.after?.[k] ?? '', v.reason || '']); }
  }
  if (!any) sv.row(['（尚無變更）']);

  missingSheet(ctx, '節能計畫');
  return { sheets: ctx.sheets, missing: ctx.missing, filename: `附件二_節能計畫_${ry}年.xlsx` };
}

