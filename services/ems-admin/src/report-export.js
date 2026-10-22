// 匯出（工作清單 24）：每張表單獨匯出（xlsx／CSV）、整包 zip、申報對照頁、節能計畫匯出檔。
//
// 單一來源：所有表的內容都來自 report-xlsx.js 的 buildAnnex3／buildDiagnosis／buildPlan（同一份工作表），
// 這裡只負責「挑哪幾張、換什麼格式」。所以整本 xlsx、單表 xlsx、CSV、申報對照頁的數字一定一樣。
//
// tableId 是穩定的英數代號（網址用），對照表 TABLES 依新版附表三章節順序（前言、一～十一、附錄二），
// 申報對照頁也照這個順序排。
import { buildWorkbook, zip, readWorkbook } from './xlsx.js';
import { buildAnnex3, buildDiagnosis, buildPlan, toXlsx, FILL } from './report-xlsx.js';
import { materialize, measuresView, plansView, reportYearOf, todayIso } from './report-model.js';
import { energyLabel, A2, PLAN_FIELDS } from './report-schema.js';
import { MEASURE_CODES } from './inventory-schema.js';
import { carryoverView } from './report-annual.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;

// ── 表的對照 ──
// sheet：工作表名稱（prefix:true 表示開頭相符的都算，表五之二每電號一張）；fill：表層級的填寫處
const T = (id, kind, chapter, sheet, label, fill, extra = {}) => ({ id, kind, chapter, sheet, label, fill, ...extra });
export const TABLES = [
  T('a3-00', 'annex3', '前言', '說明', '說明與年度沿用狀態', null),
  T('a3-01', 'annex3', '一、二', '一二 填表人員', '一、填表人員／二、其他技師或能管人員', FILL.site('staff').fill),
  T('a3-03', 'annex3', '三', '表三 基本資料', '表三 能源用戶基本資料', FILL.site('basic').fill),
  T('a3-03m', 'annex3', '三', '表三 電號資料', '表三 電號資料（含合併申報）', FILL.site('meters').fill),
  T('a3-04-1', 'annex3', '四', '表四之一 查核組織', '表四之一 能源查核組織', FILL.site('org').fill),
  T('a3-04-2', 'annex3', '四', '表四之二 能源政策', '表四之二 能源政策', FILL.site('policy').fill),
  T('a3-05-1', 'annex3', '五', '表五之一 熱能', '表五之一 熱能使用量', FILL.annual('fuels').fill),
  T('a3-05-2', 'annex3', '五', '表五之二', '表五之二 電能使用量（每電號一張）', FILL.points().fill, { prefix: true }),
  T('a3-05-3', 'annex3', '五', '表五之三 效率因子', '表五之三 單位能源使用效率因子', FILL.annual('acRun').fill),
  T('a3-05-4', 'annex3', '五', '表五之四 電能EUI', '表五之四 電能績效自我評比', FILL.annual('eui').fill),
  T('a3-05-5', 'annex3', '五', '表五之五 熱能EUI', '表五之五 熱能績效自我評比', FILL.annual('fuels').fill),
  T('a3-06', 'annex3', '六', '表六 能源流程', '六、能源流程分析', FILL.annual('heatUses').fill),
  T('a3-07', 'annex3', '七', '表七 建築資料', '七、建築資料', FILL.site('buildings').fill),
  T('a3-08', 'annex3', '八', '表八 電能系統', '八、電能系統', FILL.site('transformers').fill),
  T('a3-09-1-1', 'annex3', '九', '表九之一（一）冰水機群組', '表九之一（一）冰水機群組列表', FILL.eq('ac').fill),
  T('a3-09-1-2', 'annex3', '九', '表九之一（二）群組效率', '表九之一（二）冰水機群組系統效率', FILL.points().fill),
  T('a3-09-1-3', 'annex3', '九', '表九之一（三）空調設備', '表九之一（三）空調設備', FILL.eq('ac').fill),
  T('a3-09-2', 'annex3', '九', '表九之二 照明', '表九之二 照明設備', FILL.eq('lighting').fill),
  T('a3-09-3', 'annex3', '九', '表九之三 其他系統', '表九之三 其他系統', FILL.eq('other').fill),
  T('a3-09-4', 'annex3', '九', '表九之四 系統耗電量', '表九之四 系統耗電量彙整', FILL.annual('systems').fill),
  T('a3-09-5', 'annex3', '九', '表九之五 重大設備', '表九之五 重大使用能源設備', FILL.eq('other').fill),
  T('a3-09-6', 'annex3', '九', '表九之六 鍋爐操作', '表九之六 鍋爐操作概況', FILL.eq('other').fill),
  T('a3-09-7', 'annex3', '九', '表九之七 鍋爐自我檢測', '表九之七 蒸汽鍋爐自我檢測', FILL.annual('boilerTests').fill),
  T('a3-09-8', 'annex3', '九', '表九之八 PUE', '表九之八 資料中心 PUE', FILL.annual('pue').fill),
  T('a3-10-1', 'annex3', '十', '表十之一 成效分析', '表十之一 已執行節約能源改善方案具體成效分析', FILL.plans().fill),
  T('a3-10-2', 'annex3', '十', '表十之二 執行成效', '表十之二 執行成效', FILL.plans().fill),
  T('a3-10-3', 'annex3', '十', '表十之三 需量反應與再生', '表十之三 需量反應與再生能源之節電量換算', FILL.annual('dr').fill),
  T('a3-10-4', 'annex3', '十', '表十之四 年度用電量計算', '表十之四 年度用電量計算', FILL.annual('deductN').fill),
  T('a3-11-1', 'annex3', '十一', '表十一之一 規劃執行計畫', '表十一之一 規劃節約能源措施執行計畫表', FILL.plans().fill),
  T('a3-11-2', 'annex3', '十一', '表十一之二 節能量預估', '表十一之二 規劃節約能源措施暨節能量預估情形', FILL.plans().fill),
  T('a3-11-3', 'annex3', '十一', '表十一之三 需量反應與再生', '表十一之三 規劃需量反應與再生能源自發自用', FILL.annual('drPlan').fill),
  T('a3-11-4', 'annex3', '十一', '表十一之四 年度用電量估算', '表十一之四 年度用電量估算', FILL.annual('forecast').fill),
  T('a3-app2', 'annex3', '附錄二', '附錄二 合併申報申請表', '附錄二 合併申報申請表', FILL.annual('app2').fill),
  T('a1-00', 'diagnosis', '附件一', '報告主檔', '附件一 報告主檔', FILL.diagnosis().fill),
  T('a1-01', 'diagnosis', '附件一', '一、診斷摘要', '附件一 一、診斷摘要', FILL.measures().fill),
  T('a1-02', 'diagnosis', '附件一', '二、設備汰換', '附件一 二、設備汰換節能改善措施', FILL.measures().fill),
  T('a1-03', 'diagnosis', '附件一', '三、操作面', '附件一 三、操作面節能改善措施', FILL.measures().fill),
  T('a1-04', 'diagnosis', '附件一', '四、診斷團隊聲明', '附件一 四、診斷團隊聲明', FILL.diagnosis().fill),
  T('a2-01', 'plan', '附件二', '節能計畫', '附件二 節能計畫', FILL.plans().fill),
  T('a2-02', 'plan', '附件二', '版本紀錄', '附件二 版本紀錄（R8）', FILL.plans().fill),
  T('a2-export', 'planExport', '附件二', '節能計畫匯出', '節能計畫匯出檔（欄位齊全，供能源署匯入對照）', FILL.plans().fill),
];
export const tableById = (id) => TABLES.find((t) => t.id === id) || null;
const matches = (t, name) => (t.prefix ? name.startsWith(t.sheet) : name === t.sheet);

// ════════════════════════════════════════════════════════════════
// 節能計畫匯出檔（項目 6）
// 能源署節能計畫「匯出 → 填 → 匯入」的檔案格式要登入才看得到（spec §9-9），目前沒有範本。
// 先產一份欄位齊全的檔；拿到能源署的匯出檔後只改 PLAN_EXPORT_MAP（表頭文字、順序、哪幾欄可匯回），程式不用動。
//   field：planExportRows() 的鍵；header：檔案表頭；importable：匯回時要讀的欄（其餘只是給人看）
// ════════════════════════════════════════════════════════════════
export const PLAN_EXPORT_MAP = {
  version: 'draft-2026-10-22',
  note: '暫定格式：能源署匯出檔樣本取得前，以附件二欄位＋措施代碼（附錄一）＋預計完工年度排列。',
  sheet: '節能計畫匯出',
  key: 'measureId',
  columns: [
    { field: 'no', header: '編號' },
    { field: 'name', header: '節能改善措施' },
    { field: 'measureType', header: '措施類別' },
    { field: 'annualSaving', header: '年節能量預估' },
    { field: 'unit', header: '年節能量單位' },
    { field: 'energyType', header: '能源種類' },
    { field: 'savingCost', header: '節省能源費用（元/年）' },
    { field: 'investment', header: '投資金額（元）' },
    { field: 'paybackYears', header: '回收年限（年）' },
    { field: 'completionYear', header: '預計完工年度', importable: true },
    { field: 'note', header: '備註', importable: true },
    { field: 'officialCode', header: '節約能源措施代碼', importable: true },
    { field: 'officialCodeLabel', header: '措施代碼說明' },
    { field: 'mandatory', header: '強制納入（R7）' },
    { field: 'status', header: '計畫狀態', importable: true },
    { field: 'actualDoneDate', header: '實際完工日期' },
    { field: 'equipmentName', header: '設備名稱' },
    { field: 'madeYear', header: '製造年份（民國）' },
    { field: 'version', header: '版本號' },
    { field: 'versionAt', header: '最後變更日期' },
    { field: 'versionReason', header: '最後變更原因' },
    { field: 'measureId', header: '來源措施 ID' },
    { field: 'planId', header: '計畫 ID' },
  ],
};

export function officialCodeLabel(code) {
  const m = /^([A-Z])([A-Z])(\d{2})$/.exec(String(code || ''));
  if (!m) return '';
  const sys = MEASURE_CODES.systems.find((s) => s.code === m[1]);
  const dev = sys?.devices.find((d) => d.code === m[2]);
  const meth = MEASURE_CODES.methods.find((x) => x.code === m[3]);
  return sys && dev && meth ? `${sys.label}·${dev.label}·${meth.label}` : '';
}

const rocDateOf = (v) => { const d = C.parseDate(v); return d ? C.toRocDate(d) : ''; };
export function planExportRows(invIn, opts = {}) {
  const inv = JSON.parse(JSON.stringify(invIn));
  const ry = reportYearOf(inv, opts.today || todayIso());
  materialize(inv, ry);
  const mv = measuresView(inv, ry);
  const all = [...mv.replace, ...mv.operation];
  return plansView(inv, ry, mv).map((p) => {
    const m = all.find((x) => x.id === p.measureId);
    const last = p.versions.at(-1);
    const madeYear = m?.values?.madeYear;
    return {
      no: p.no, name: p.name, measureType: p.measure?.typeLabel || '', annualSaving: p.annualSaving ?? '', unit: p.unit,
      energyType: p.energyType ? `${p.energyType} ${energyLabel(p.energyType)}` : '', savingCost: p.savingCost ?? '', investment: p.investment ?? '',
      paybackYears: p.paybackYears ?? (p.payback?.notApplicable ? '無法回收／不適用' : ''),
      completionYear: p.fields.completionYear ?? '', note: p.fields.note || '', officialCode: p.fields.officialCode || '', officialCodeLabel: officialCodeLabel(p.fields.officialCode),
      mandatory: p.mandatory ? '是' : '否', status: p.fields.status || '', actualDoneDate: rocDateOf(p.fields.actualDoneDate),
      equipmentName: m?.equipment?.name || '', madeYear: madeYear ? (Number(madeYear) > 1911 ? Number(madeYear) - 1911 : madeYear) : '',
      version: last?.v ?? 0, versionAt: last ? rocDateOf(last.at.slice(0, 10)) : '', versionReason: last?.reason || '',
      measureId: p.measureId, planId: p.id,
    };
  });
}

export function buildPlanExport(inv, opts = {}, map = PLAN_EXPORT_MAP) {
  const rows = planExportRows(inv, opts);
  // 這份要能直接當匯入檔：第 1 列就是表頭，不放抬頭與依據（依據寫在第二張「說明」）
  const sheet = {
    name: map.sheet,
    rows: [map.columns.map((c) => ({ v: c.header, s: 'head' })), ...rows.map((r) => map.columns.map((c) => ({ v: r[c.field] ?? '', s: 'cell' })))],
    cols: map.columns.map((c) => Math.max(10, Math.min(30, c.header.length * 2))),
  };
  const src = A2('節能計畫表', '能源署節能計畫匯出／匯入格式未取得；本檔欄位對照在 src/report-export.js 的 PLAN_EXPORT_MAP');
  const about = {
    name: '說明',
    rows: [
      [{ v: '節能計畫匯出檔·說明', s: 'title' }],
      [{ v: `依據：${src.doc} ${src.ref}｜${src.law}｜${src.note}`, s: 'note' }],
      [{ v: `對照版本：${map.version}。${map.note}`, s: 'note' }],
      [],
      [{ v: '欄位', s: 'head' }, { v: '可匯回', s: 'head' }, { v: '內容', s: 'head' }],
      ...map.columns.map((c) => [{ v: c.header, s: 'cell' }, { v: c.importable ? '是' : '', s: 'cell' }, { v: PLAN_EXPORT_FIELD_NOTE[c.field] || '', s: 'cell' }]),
    ],
    cols: [24, 8, 70],
  };
  return { sheets: [sheet, about], rows, filename: `節能計畫匯出_${reportYearOf(inv, opts.today || todayIso())}年.xlsx` };
}
const PLAN_EXPORT_FIELD_NOTE = {
  completionYear: '民國年；限提報年度～提報年度+4（R7）',
  note: '未填預計完工年度時必填（附件二註 2）',
  officialCode: '附表三附錄一代碼，例 AA06（§7.7）',
  status: PLAN_FIELDS.find((f) => f.key === 'status').options.join('／'),
  measureId: '本系統措施 ID（措施 ID 貫穿診斷→計畫→表十一→表十）；匯回時用它對回計畫',
};

// 匯出檔讀回（日後拿到能源署匯出檔，改 map 就能讀）：回 [{ measureId, …importable 欄位 }]
export function readPlanExport(buf, map = PLAN_EXPORT_MAP) {
  const wb = readWorkbook(buf);
  const sh = wb.sheets.get(map.sheet) || [...wb.sheets.values()][0];
  if (!sh) return { rows: [], errors: ['讀不到工作表'] };
  const cells = sh.cells;
  const colOf = new Map();
  let headRow = null;
  for (const [ref, v] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const c = map.columns.find((x) => x.header === String(v).trim());
    if (m && c && (headRow === null || Number(m[2]) === headRow)) { headRow = Number(m[2]); colOf.set(c.field, m[1]); }
  }
  const keyCol = map.columns.find((c) => c.field === map.key);
  if (!headRow || !colOf.has(map.key)) return { rows: [], errors: [`找不到表頭「${keyCol?.header || map.key}」`] };
  const rows = [];
  for (let r = headRow + 1; r < headRow + 2000; r++) {
    const key = cells.get(`${colOf.get(map.key)}${r}`);
    if (key === undefined || key === '') { if (![...colOf.values()].some((c) => cells.get(`${c}${r}`))) break; continue; }
    const row = { [map.key]: String(key) };
    for (const c of map.columns) if (c.importable && colOf.has(c.field)) row[c.field] = cells.get(`${colOf.get(c.field)}${r}`) ?? '';
    rows.push(row);
  }
  return { rows, errors: [] };
}

// ════════════════════════════════════════════════════════════════
// 單表與整包
// ════════════════════════════════════════════════════════════════
const BUILD = { annex3: buildAnnex3, diagnosis: buildDiagnosis, plan: buildPlan };
function buildAll(inv, opts) {
  const cache = {};
  return (kind) => (cache[kind] ||= BUILD[kind](inv, opts));
}

// CSV：UTF-8 BOM（Excel 直接開不亂碼）、CRLF、雙引號跳脫；一列一行，跟 xlsx 同一份工作表
const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function sheetToCsvLines(sheet) { return sheet.rows.map((r) => r.map((c) => csvCell(c?.v)).join(',')); }
export const toCsv = (sheets) => Buffer.from('﻿' + sheets.map((s) => sheetToCsvLines(s).join('\r\n')).join('\r\n\r\n') + '\r\n', 'utf8');

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');

// 單表：回 { table, sheets, missing, filename }
export function buildTable(inv, tableId, opts = {}) {
  const t = tableById(tableId);
  if (!t) return null;
  if (t.kind === 'planExport') {
    const b = buildPlanExport(inv, opts);
    return { table: t, sheets: b.sheets, missing: [], filename: b.filename.replace(/\.xlsx$/, ''), raw: true };
  }
  const built = buildAll(inv, opts)(t.kind);
  const sheets = built.sheets.filter((s) => matches(t, s.name));
  const missing = built.missing.filter((m) => sheets.some((s) => s.name === m.sheet));
  const yearTag = t.kind === 'annex3' ? `${built.year}年資料` : '';
  return { table: t, sheets, missing, filename: safeName(`${t.id}_${t.label}${yearTag ? `_${yearTag}` : ''}`) };
}

// 單表 xlsx：該表的工作表＋只列這張表的待補欄位
export function tableXlsx(bt) {
  const sheets = bt.sheets.map((s) => ({ name: s.name, rows: s.rows, cols: s.cols }));
  if (!bt.raw) {
    const rows = [[{ v: `${bt.table.label}·待補欄位`, s: 'title' }], [{ v: '依據：系統產出說明｜下列欄位系統無法由現有資料推得，請院方補填', s: 'note' }], [],
      [{ v: '工作表', s: 'head' }, { v: '欄位', s: 'head' }, { v: '說明', s: 'head' }],
      ...(bt.missing.length ? bt.missing.map((m) => [m.sheet, m.field, m.why].map((v) => ({ v, s: 'cell' }))) : [[{ v: '—', s: 'cell' }, { v: '無', s: 'cell' }, { v: '這張表的欄位都已帶入', s: 'cell' }]])];
    sheets.push({ name: '待補欄位', rows, cols: [26, 46, 60] });
  }
  return buildWorkbook(sheets).buffer;
}

// 整包 zip：附表三每張表一個 CSV＋附件一、二每張表一個 CSV＋三本完整 xlsx＋節能計畫匯出檔
export function buildBundle(inv, opts = {}) {
  const get = buildAll(inv, opts);
  const a3 = get('annex3');
  const N = a3.year;
  const files = [];
  const dir = { annex3: `附表三_${N}年資料`, diagnosis: '附件一_節能診斷報告', plan: '附件二_節能計畫' };
  for (const t of TABLES) {
    if (t.kind === 'planExport') continue;
    const b = get(t.kind);
    const sheets = b.sheets.filter((s) => matches(t, s.name));
    if (!sheets.length) continue;
    files.push([`${dir[t.kind]}/${safeName(`${t.id}_${t.label}`)}.csv`, toCsv(sheets)]);
  }
  for (const k of ['annex3', 'diagnosis', 'plan']) {
    files.push([`${dir[k]}/${get(k).filename}`, toXlsx(get(k))]);
    files.push([`${dir[k]}/待補欄位.csv`, toCsv(get(k).sheets.filter((s) => s.name === '待補欄位'))]);
  }
  const pe = buildPlanExport(inv, opts);
  files.push([`附件二_節能計畫/${pe.filename}`, buildWorkbook(pe.sheets).buffer]);
  files.push([`附件二_節能計畫/${pe.filename.replace(/\.xlsx$/, '.csv')}`, toCsv([pe.sheets[0]])]);
  return { buffer: zip(new Map(files)), filename: `申報資料_${N}年資料.zip`, files: files.map(([n]) => n), year: N };
}

// ════════════════════════════════════════════════════════════════
// 申報對照頁：照能源署線上申報畫面的章節與欄位順序列出每欄的值
// 把工作表的列解析成「欄位：值」：
//   formRows 產的表（表頭 欄號／欄位／值／單位／說明）→ 每列一個欄位
//   一般表格（表頭＋資料列）→ 每列一筆，每格是「表頭：值」
//   沒有表頭的兩格列（例：表五之二表頭的「電號｜01-…」）→ 一個欄位
// 空值＝待補（說明是「免填」的除外），帶 fill（去哪裡填）
// ════════════════════════════════════════════════════════════════
const FORM_HEAD = ['欄號', '欄位', '值', '單位', '說明'];
const isBlank = (v) => v === undefined || v === null || v === '';
const vOf = (c) => (c && typeof c === 'object' ? c.v : c);

export function parseSheet(sheet, tableFill) {
  const blocks = [];
  let head = null, form = false, cur = null;
  const flush = () => { if (cur) blocks.push(cur); cur = null; };
  sheet.rows.slice(4).forEach((r) => {
    if (!r.length) { flush(); head = null; return; }
    const style = r[0]?.s;
    const cells = r.map(vOf);
    const fill = r.meta?.fill || tableFill || null;
    if (style === 'note') { flush(); blocks.push({ type: 'text', text: String(cells[0] ?? '') }); return; }
    if (style === 'head') { flush(); head = cells.map((x) => String(x ?? '')); form = head.join('|') === FORM_HEAD.join('|'); cur = form ? { type: 'fields', items: [] } : { type: 'rows', columns: head, rows: [] }; return; }
    if (form) {
      if (!cur) cur = { type: 'fields', items: [] };
      const [code, label, value, unit, note] = cells;
      const na = note === '免填';
      cur.items.push({ code: code || '', label: String(label ?? ''), value: isBlank(value) ? '' : String(value), unit: unit || '', note: note || '', status: na ? 'na' : isBlank(value) ? 'missing' : 'ok', fill });
      return;
    }
    if (head) {
      if (!cur) cur = form ? { type: 'fields', items: [] } : { type: 'rows', columns: head, rows: [] };
      // 只有第一格有字的列（例：「（無資料）」「合計」以外的說明）
      if (cells.slice(1).every(isBlank) && /^（.*）$/.test(String(cells[0] ?? ''))) { cur.rows.push({ empty: true, text: String(cells[0]), fill }); return; }
      cur.rows.push({ cells: head.map((h, i) => ({ label: h, value: isBlank(cells[i]) ? '' : String(cells[i]), status: isBlank(cells[i]) ? 'missing' : 'ok', ...(r.meta?.cells?.[i] ? { fill: r.meta.cells[i] } : {}) })), fill });
      return;
    }
    // 沒有表頭：兩格（以上）列＝欄位：值
    if (!cur || cur.type !== 'fields') { flush(); cur = { type: 'fields', items: [] }; }
    const [label, value, note] = cells;
    cur.items.push({ code: '', label: String(label ?? ''), value: isBlank(value) ? '' : String(value), unit: '', note: note || '', status: isBlank(value) ? 'missing' : 'ok', fill });
  });
  flush();
  return blocks;
}

export function filingView(inv, opts = {}) {
  const get = buildAll(inv, opts);
  const a3 = get('annex3');
  const N = a3.year;
  const tables = [];
  for (const t of TABLES) {
    if (t.kind === 'planExport' || t.id === 'a3-00') continue;
    const b = get(t.kind);
    const sheets = b.sheets.filter((s) => matches(t, s.name));
    const missing = b.missing.filter((m) => sheets.some((s) => s.name === m.sheet));
    tables.push({
      id: t.id, kind: t.kind, chapter: t.chapter, label: t.label, fill: t.fill,
      sheets: sheets.map((s) => ({ name: s.name, title: vOf(s.rows[0]?.[0]) || s.name, source: s.source || null, blocks: parseSheet(s, t.fill) })),
      missing, missingCount: missing.length,
    });
  }
  const carry = carryoverView(inv, N);
  return {
    year: N, hospital: inv.site?.basic?.userName || opts.hospitalName || '',
    tables, missingTotal: tables.reduce((n, t) => n + t.missingCount, 0),
    carryover: { complete: carry.complete, confirmed: carry.confirmed, total: carry.total },
  };
}

// 表清單（單表匯出分頁用）
export function tableList(inv, opts = {}) {
  const get = buildAll(inv, opts);
  return TABLES.map((t) => {
    if (t.kind === 'planExport') return { id: t.id, kind: t.kind, chapter: t.chapter, label: t.label, sheets: 1, missing: 0 };
    const b = get(t.kind);
    const sheets = b.sheets.filter((s) => matches(t, s.name));
    return { id: t.id, kind: t.kind, chapter: t.chapter, label: t.label, sheets: sheets.length, missing: b.missing.filter((m) => sheets.some((s) => s.name === m.sheet)).length };
  });
}
