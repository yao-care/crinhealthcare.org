// 年度報表資料（工作清單 24）：附表三裡「每年都要重填、系統原本沒有來源」的欄位，以及跨年度沿用確認。
//
// 資料落在 inventory/<hid>.json 的三個頂層區塊（架構約定「匯出與年度沿用」一節）：
//   annual{ [N]: { [blockId]: 物件|陣列 } }     資料年 N（民國）的年度輸入：燃料帳單、EUI 差異原因、需量反應…
//   snapshots{ [N]: { at, site:{ [blockId]: 值 }, equipment:[…] } }
//                                              院方確認「N 年沿用」當下的初始建檔與設備主檔快照（N-1 年面積等跨年比較從這裡讀）
//   confirmations{ [N]: { [unitId]: { at, who, reporter, hash, diffCount, copied? } } }
//                                              逐區塊確認紀錄；確認後內容又變動 → hash 對不上，狀態回到「需重新確認」
//
// 為什麼 site 不改成每年一份：site 是活的主檔（改了要填原因、寫異動），申報只需要「那一年確認過的樣子」。
// 每年多存一份快照比讓院方每年重建 9 個區塊省事，也不會出現兩份主檔互相打架。
//
// 同一事實只存一次：年度表裡的電號、建築、鍋爐、填表人一律存 site／設備主檔的 id（ref），不重打一次。
import { createHash } from 'node:crypto';
import { SITE_BLOCKS, siteBlockById, SOURCES } from './inventory-schema.js';
import { W46 } from './water-schema.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;
const T3 = (ref, note) => ({ doc: '附表三 能源查核制度申報表（非生產性質行業）', ref, law: SOURCES.LAW_ANNEX3, date: '115-01-23', ...(note ? { note } : {}) });

// ── 欄位 ──
const FUELS = [['E02', '燃料油', '公秉'], ['E03', '液化石油氣', '公斤'], ['E04', '天然氣', '立方公尺'], ['E05', '汽油', '公升'], ['E06', '柴油', '公秉']];
export const FUEL_CODES = FUELS.map(([c]) => c);
const MONTH = { key: 'month', label: '月份', type: 'monthNo', required: true };
export const HEAT_USES = ['房間用', '三溫暖', '溫水游泳池', '洗衣房', '廚房餐廳', '消毒設備', '車輛', '發電機', '其他'];
export const SYSTEMS = ['空調', '照明', '冷凍冷藏', '事務', '送排風', '給水污水', '電梯', '鍋爐', '熱泵', '壓縮空氣', '其他'];
// 需量反應方案代號（§7.8）
export const DR_SCHEMES = {
  a: '計畫性·月選 8 日型', b: '計畫性·日選時段型', c: '即時性·保證反應型', d: '即時性·彈性反應型',
  e: '需量競價·經濟型', f: '需量競價·可靠型', g: '需量競價·聯合型', h: '智慧型·校園空調型',
  i: '日前輔助·即時備轉容量', j: '日前輔助·補充備轉容量', k: '日前輔助·調頻備轉容量', l: '儲冷式空調系統離峰用電',
  m: '再生能源義務用戶儲能·義務時數型', n: '再生能源義務用戶儲能·累進回饋型', o: '其他（自填）',
};
const RENEWABLE_TYPES = ['太陽能', '地熱能', '風力', '其他'];
const TEMP_REASONS = ['維修換裝試車調校', '燃料置換調整中', '爐體破損', '熱交換設備破管', '燃控設備或元件損壞', '其他'];
const O2_REASONS = ['維修換裝試車調校', '燃料置換調整中', '爐體破損', '連續非常態低載運轉', '風門連桿元件鬆脫毀損', '其他'];
const APP2_REASONS = ['同址多電號', '相鄰不同地址且用電無法分割', '同戶名電動車充換電設施（依區域原則）'];
const APP2_EVIDENCE = ['電費單', '單線圖', '現場照片', '衛星圖', '平面圖'];

const drFields = (plan) => [
  MONTH,
  { key: 'meterId', label: '台電電號', type: 'ref', ref: 'meters', hint: '從初始建檔「電號」選，不重打電號' },
  { key: 'name', label: '措施名稱', type: 'text' },
  { key: 'scheme', label: '方案細項', type: 'select', options: Object.keys(DR_SCHEMES), optionLabels: DR_SCHEMES },
  { key: 'kw', label: plan ? '預估抑低量' : '實際抑低量', type: 'number', unit: '瓩', hint: plan ? '' : '須有台電佐證' },
  { key: 'hours', label: '抑低時數', type: 'number', unit: '小時' },
];
const reFields = (plan) => [
  { key: 'type', label: '再生能源種類', type: 'select', options: RENEWABLE_TYPES },
  { key: 'meterId', label: '設置登記電號（併聯電號）', type: 'ref', ref: 'meters' },
  { key: 'area', label: '設置區域', type: 'text' },
  { key: 'installedAt', label: plan ? '預計設置時間' : '設置時間（驗收竣工日）', type: 'date' },
  { key: 'kw', label: '裝置容量', type: 'number', unit: '瓩' },
  { key: 'genKwh', label: plan ? '預估年發電量' : '年發電量', type: 'number', unit: '度' },
  { key: 'soldKwh', label: plan ? '預估回售台電電量' : '回售台電電量', type: 'number', unit: '度' },
  { key: 'selfKwh', label: plan ? '預估自發自用認列節電量' : '自發自用認列節電量', type: 'number', unit: '度', hint: '留白＝年發電量－回售（回售部分不可認列；每項限認列一年）' },
];

// kind：form＝單一物件；table＝多筆（每筆自帶 id）；months＝固定 1–12 月 12 列
// stable：通常不變，新年度可「沿用 N-1 年」（carryClear 列的欄位每年重填，沿用時清空）
// table：對應的附表三表號（匯出、申報對照頁用）
export const ANNUAL_BLOCKS = [
  { id: 'fuels', table: '表五之一', label: '表五之一 熱能使用量（依帳單月份）', kind: 'months', source: T3('表五之一', '沒有使用的燃料留空或填 0'),
    fields: [MONTH, ...FUELS.flatMap(([c, l, u]) => [{ key: `${c}qty`, label: l, type: 'number', unit: u }, { key: `${c}cost`, label: `${l}總價`, type: 'number', unit: '元含稅' }])] },
  { id: 'fuelMeta', table: '表五之一', label: '表五之一 供應商與客戶編號', kind: 'form', stable: true, source: T3('表五之一'),
    fields: FUELS.flatMap(([c, l]) => [{ key: `${c}supplier`, label: `${l}供應商名稱`, type: 'text' }, { key: `${c}customerNo`, label: `${l}客戶編號`, type: 'text' }]) },
  { id: 'acRun', table: '表五之三', label: '表五之三 空調夏季最大運轉噸數', kind: 'form', source: T3('表五之三', '裝置噸數與耗電占比由設備主檔與電費單推算，這裡只填量測值'),
    fields: [
      { key: 'summerMaxRtCentral', label: '空調夏季最大運轉噸數·中央空調系統', type: 'number', unit: 'USRT' },
      { key: 'summerMaxRtPackaged', label: '空調夏季最大運轉噸數·其他型式（窗箱分離式）', type: 'number', unit: 'USRT' },
    ] },
  { id: 'eui', table: '表五之四', label: '表五之四／表五之五 EUI 差異原因與 N-1 年面積', kind: 'form', source: T3('表五之四、表五之五', '差異 > 10% 須說明原因；N-1 年面積預設取 N-1 年快照'),
    fields: [
      { key: 'prevFloorArea', label: 'N-1 年總樓地板面積', type: 'number', unit: 'm²', hint: '留白：取 N-1 年確認時的快照，沒有快照才用目前建檔值' },
      { key: 'prevParkingArea', label: 'N-1 年總室內停車場面積', type: 'number', unit: 'm²' },
      ...['第 1 季', '第 2 季', '第 3 季', '第 4 季', '全年'].map((l, i) => ({ key: `elecReason${i + 1}`, label: `電能 EUI ${l}差異原因`, type: 'text', group: '表五之四' })),
      ...['第 1 季', '第 2 季', '第 3 季', '第 4 季', '全年'].map((l, i) => ({ key: `heatReason${i + 1}`, label: `熱能 EUI ${l}差異原因`, type: 'text', group: '表五之五' })),
    ] },
  { id: 'heatUses', table: '表六', label: '表六 熱能平衡·用途', kind: 'form', source: T3('六、能源流程分析', '燃料別熱值由表五之一換算；用途分配由院方填'),
    fields: HEAT_USES.map((u, i) => ({ key: `use${i + 1}`, label: u, type: 'number', unit: '百萬卡/年' })) },
  { id: 'chillerRemarks', table: '表九之一（二）', label: '表九之一（二）冰水機群組月效率·備註', kind: 'table', source: T3('表九之一（二）', '□整月未開主機／□其他'),
    fields: [
      { key: 'group', label: '冰水機群組名稱', type: 'text', required: true, hint: '與設備主檔的冰水機群組名稱一致' },
      MONTH,
      { key: 'remark', label: '備註', type: 'select', options: ['整月未開主機', '其他'] },
      { key: 'remarkOther', label: '備註（其他）', type: 'text' },
    ] },
  { id: 'systems', table: '表九之四', label: '表九之四 各系統年平均運轉容量', kind: 'form', source: T3('表九之四', '設備利用率＝年平均運轉容量 ÷ 總容量（總容量由設備主檔加總）'),
    fields: SYSTEMS.map((s, i) => ({ key: `avgKw${i + 1}`, label: `${s}年平均運轉容量`, type: 'number', unit: 'kW' })) },
  { id: 'boilerTests', table: '表九之七', label: '表九之七 蒸汽鍋爐自我檢測（月平均）', kind: 'table', source: T3('表九之七', '僅蒸汽鍋爐且非貫流式；排氣溫度每日量測、含氧量每週量測，取月平均'),
    fields: [
      { key: 'equipmentId', label: '鍋爐', type: 'ref', ref: 'boilers', required: true, hint: '從設備主檔的鍋爐選' },
      MONTH,
      { key: 'exhaustTempC', label: '最末排氣溫度', type: 'number', unit: '℃' },
      { key: 'tempReason', label: '排氣溫度超標原因', type: 'select', options: TEMP_REASONS },
      { key: 'o2Pct', label: '排氣含氧量', type: 'number', unit: '%' },
      { key: 'o2Reason', label: '含氧量超標原因', type: 'select', options: O2_REASONS },
    ] },
  { id: 'pue', table: '表九之八', label: '表九之八 資料中心 PUE', kind: 'table', stable: true, carryClear: ['infraKwh', 'itKwh'], source: T3('表九之八', '僅電信／電腦機房類用戶必填；醫院免填'),
    fields: [
      { key: 'building', label: '建築名稱', type: 'ref', ref: 'buildings' },
      { key: 'floor', label: '樓層', type: 'text' },
      { key: 'upsType', label: 'UPS 類型', type: 'select', options: ['UPS', 'SMR'] },
      { key: 'kva', label: '容量', type: 'number', unit: 'kVA' },
      { key: 'qty', label: '數量', type: 'number' },
      { key: 'avgEffPct', label: '平均效率', type: 'number', unit: '%' },
      { key: 'infraKwh', label: '基礎設施年用電 (a)', type: 'number', unit: '度' },
      { key: 'itKwh', label: '資訊設備年用電 (b)', type: 'number', unit: '度' },
      { key: 'tempSetC', label: '環境溫度設定', type: 'number', unit: '℃' },
      { key: 'measurePoint', label: '資訊設備電力量測位置', type: 'select', options: ['UPS(SMR) 輸入', 'UPS(SMR) 輸出', 'PDU 輸出', '其他'] },
      { key: 'monitor', label: '裝設 PUE 監測儀表', type: 'boolean' },
    ] },
  { id: 'dr', table: '表十之三', label: '表十之三（一）需量反應負載管理措施', kind: 'table', source: T3('表十之三（一）', '認列節電量＝實際抑低量 × 抑低時數（系統計算）'), fields: drFields(false) },
  { id: 'renewables', table: '表十之三', label: '表十之三（二）再生能源自發自用', kind: 'table', stable: true, carryClear: ['genKwh', 'soldKwh', 'selfKwh'], source: T3('表十之三（二）', '設置資料沿用；發電量、回售每年重填'), fields: reFields(false) },
  { id: 'deductN', table: '表十之四', label: '表十之四 可扣除用電量', kind: 'form', source: T3('表十之四', '可複選，各填度數並附用印佐證'),
    fields: [
      ...C.DEDUCTIONS_N.map((d) => ({ key: d.key, label: `${d.no}. ${d.label}`, type: 'number', unit: '度' })),
      { key: 'eusApproval', label: '第 8 項 核准日期及文號', type: 'text' },
      { key: 'evidence', label: '佐證文件', type: 'text' },
    ] },
  { id: 'drPlan', table: '表十一之三', label: '表十一之三（一）規劃需量反應', kind: 'table', source: T3('表十一之三（一）'), fields: drFields(true) },
  { id: 'renewablesPlan', table: '表十一之三', label: '表十一之三（二）規劃再生能源自發自用', kind: 'table', source: T3('表十一之三（二）'), fields: reFields(true) },
  { id: 'forecast', table: '表十一之四', label: '表十一之四 年度用電量估算', kind: 'form', source: T3('表十一之四', '□沿用 N 年全年實際用電量 或 □其他估算方式（須附說明）'),
    fields: [
      { key: 'method', label: '估算方式', type: 'select', options: ['actual', 'other'], optionLabels: { actual: '沿用 N 年全年實際用電量', other: '其他估算方式' }, default: 'actual' },
      ...C.DEDUCTIONS_N1.map((d) => ({ key: d.key, label: `${d.no}. ${d.label}`, type: 'number', unit: '度' })),
      { key: 'estimateKwh', label: '其他估算方式·估算用電量', type: 'number', unit: '度' },
      { key: 'note', label: '其他估算方式·估算說明', type: 'text', max: 2000 },
    ] },
  { id: 'app2', table: '附錄二', label: '附錄二 合併申報申請表', kind: 'form', stable: true, source: T3('附錄二 合併申報申請表', '主申報與合併申報的電號、戶名、地址取自初始建檔「電號」；合併申報電號在電號資料勾「合併申報」'),
    fields: [
      { key: 'applyDate', label: '申請日期', type: 'date' },
      { key: 'applicantStaffId', label: '填表人', type: 'ref', ref: 'staff', hint: '從能管人員選；留白取身分為「填表人員」的第一位' },
      { key: 'phone', label: '聯絡電話', type: 'text', hint: '留白取填表人的電話' },
      { key: 'mainMeterId', label: '主申報電號', type: 'ref', ref: 'meters', hint: '留白取第一個未勾「合併申報」的電號' },
      { key: 'applyUnit', label: '申請單位', type: 'text', hint: '留白取用戶名稱' },
      { key: 'applyReason', label: '申請理由', type: 'select', options: APP2_REASONS },
      { key: 'applyReasonText', label: '申請理由說明', type: 'text', max: 2000 },
      { key: 'evidence', label: '佐證資料', type: 'multiselect', options: APP2_EVIDENCE },
    ] },
  // 水足跡（工作清單 26-3）：住院人日與門急診人次由院方按月填報；用水績效指標改用這份實填值（每月 × 取水同月相除）。
  // water：true＝不屬於附表三（不進 annex3 欄位盤點）。不是 stable：每年重填。
  { id: 'waterMonthly', table: '水足跡', water: true, label: '水足跡·每月營運活動（住院人日、門急診人次）', kind: 'months', source: W46('3.4 營運活動指標；6.2.5、6.2.6', '§2.2', '院方每月填報；用水績效指標的分母（每床日、每人次）'),
    fields: [MONTH,
      { key: 'bedDays', label: '住院人日', type: 'number', unit: '床日' },
      { key: 'outpatientVisits', label: '門診人次', type: 'number', unit: '人次' },
      { key: 'erVisits', label: '急診人次', type: 'number', unit: '人次' },
      { key: 'admissions', label: '住院人次', type: 'number', unit: '人次' }] },
];
export const annualBlockById = (id) => ANNUAL_BLOCKS.find((b) => b.id === id) || null;

// ── 驗證 ──
function normOne(f, raw) {
  if (raw === undefined || raw === null || raw === '') return { value: undefined };
  switch (f.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { error: '必須是數字' };
      if (n < 0) return { error: '不可為負數' };
      return { value: n };
    }
    case 'monthNo': {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 1 && n <= 12 ? { value: n } : { error: '月份須為 1–12' };
    }
    case 'date': {
      const d = C.parseDate(raw);
      return d ? { value: C.toIso(d) } : { error: '日期格式錯誤（YYYY-MM-DD 或民國 115-03-31）' };
    }
    case 'boolean': return typeof raw === 'boolean' ? { value: raw } : { error: '必須是是／否' };
    case 'select': return f.options.includes(String(raw)) ? { value: String(raw) } : { error: `不在選項內（${f.options.join('／')}）` };
    case 'multiselect': {
      if (!Array.isArray(raw)) return { error: '必須是陣列' };
      const bad = raw.filter((x) => !f.options.includes(x));
      return bad.length ? { error: `不在選項內：${bad.join('、')}` } : { value: [...new Set(raw)] };
    }
    case 'ref': {
      const v = String(raw).trim();
      return v.length > 80 ? { error: '超過 80 字' } : { value: v || undefined };
    }
    default: {
      const v = String(raw).trim();
      if (v.length > (f.max || 500)) return { error: `超過 ${f.max || 500} 字` };
      return { value: v || undefined };
    }
  }
}
function checkRow(fields, row, where) {
  const errors = [], out = {};
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { errors: [`${where}資料格式錯誤`], values: out };
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(row)) {
    if (k === 'id') continue;
    const f = known.get(k);
    if (!f) { errors.push(`${where}不認得的欄位：${k}`); continue; }
    const r = normOne(f, row[k]);
    if (r.error) errors.push(`${where}「${f.label}」${r.error}`);
    else if (r.value !== undefined) out[k] = r.value;
  }
  return { errors, values: out };
}

// ref 選項：site 表格的列、或設備主檔的鍋爐
export function refOptions(inv) {
  const site = inv.site || {};
  const lbl = (r) => String(r.name || r.code || r.meterNo || r.id);
  return {
    meters: (site.meters || []).map((m) => ({ id: m.id, label: `${m.meterNo || m.id}${m.accountName ? `（${m.accountName}）` : ''}` })),
    buildings: (site.buildings || []).map((b) => ({ id: b.id, label: lbl(b) })),
    staff: (site.staff || []).map((s) => ({ id: s.id, label: `${s.name || s.id}${s.role ? `（${s.role}）` : ''}` })),
    boilers: (inv.equipment || []).filter((e) => e.kind === '鍋爐' && (!e.status || e.status === 'active')).map((e) => ({ id: e.id, label: e.fields?.name || e.id })),
  };
}

// 回傳 { ok, errors, warnings, value }
export function validateAnnualBlock(blockId, value, newId, inv) {
  const b = annualBlockById(blockId);
  if (!b) return { ok: false, errors: [`沒有這個年度區塊：${blockId}`], warnings: [] };
  const errors = [], warnings = [];
  const refs = inv ? refOptions(inv) : null;
  const refCheck = (vals, where) => {
    if (!refs) return;
    for (const f of b.fields) if (f.type === 'ref' && vals[f.key] !== undefined && !refs[f.ref].some((o) => o.id === vals[f.key])) warnings.push(`${where}「${f.label}」對不到現有資料：${vals[f.key]}`);
  };
  if (b.kind === 'form') {
    const r = checkRow(b.fields, value, `${b.label}·`);
    refCheck(r.values, `${b.label}·`);
    return { ok: !r.errors.length, errors: r.errors, warnings, value: r.values };
  }
  if (!Array.isArray(value)) return { ok: false, errors: [`${b.label}必須是陣列`], warnings };
  const rows = [], ids = new Set(), months = new Set();
  value.forEach((row, i) => {
    const where = `${b.label} 第 ${i + 1} 筆·`;
    const r = checkRow(b.fields, row, where);
    errors.push(...r.errors);
    refCheck(r.values, where);
    let id = typeof row?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.id) ? row.id : newId(`an-${blockId}`);
    if (ids.has(id)) id = newId(`an-${blockId}`);
    ids.add(id);
    if (b.kind === 'months') {
      if (r.values.month === undefined) errors.push(`${where}缺月份`);
      else if (months.has(r.values.month)) errors.push(`${where}${r.values.month} 月重複`);
      months.add(r.values.month);
    }
    for (const f of b.fields) if (f.required && r.values[f.key] === undefined && b.kind === 'table') errors.push(`${where}「${f.label}」必填`);
    rows.push({ id, ...r.values });
  });
  if (b.kind === 'months') rows.sort((x, y) => x.month - y.month);
  return { ok: !errors.length, errors, warnings, value: rows };
}

// 年度輸入的唯讀存取（沒有就回空）
export function annualOf(inv, N) {
  const y = inv.annual?.[N] || {};
  const out = {};
  for (const b of ANNUAL_BLOCKS) {
    const v = y[b.id];
    out[b.id] = b.kind === 'form' ? (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) : (Array.isArray(v) ? v : []);
  }
  return out;
}
export const monthRow = (rows, m) => rows.find((r) => r.month === m) || null;

// ════════════════════════════════════════════════════════════════
// 跨年度沿用
// 「單位」＝一個 site 區塊、設備主檔整份、或一個 stable 的年度區塊。新年度 N 開始時逐單位比對 N-1 年：
//   site／設備主檔：N-1 年快照 vs 目前主檔（主檔本來就延續，確認＝「這些資料 N 年仍正確」）
//   年度區塊（stable）：N-1 年的值 vs N 年的值；N 年還空著時可一鍵沿用（carryClear 的欄位清空）
// ════════════════════════════════════════════════════════════════
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const stableHash = (v) => createHash('sha1').update(JSON.stringify(sortKeys(v ?? null))).digest('hex').slice(0, 16);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

// 設備主檔比對用的樣子：連結副本（pointCode）與時間戳不算「資料變了」
const eqComparable = (list) => (list || []).map((e) => ({ id: e.id, category: e.category, kind: e.kind, building: e.building || null, status: e.status || 'active', replacedBy: e.replacedBy || null, fields: e.fields || {} }));

export function carryUnits() {
  return [
    ...SITE_BLOCKS.map((b) => ({ id: `site.${b.id}`, kind: 'site', block: b.id, label: `初始建檔 › ${b.label}`, section: `i-site-${b.id}`, source: b.source, rowFields: b.kind === 'table' ? b.fields : null, formFields: b.kind === 'form' ? b.fields : null })),
    { id: 'equipment', kind: 'equipment', label: '設備主檔（表九）', section: 'i-site', source: T3('表九之一～九之三', '設備只建一次檔；年度申報沿用') },
    ...ANNUAL_BLOCKS.filter((b) => b.stable).map((b) => ({ id: `annual.${b.id}`, kind: 'annual', block: b.id, label: `報表資料 › ${b.label}`, source: b.source, rowFields: b.kind === 'form' ? null : b.fields, formFields: b.kind === 'form' ? b.fields : null, carryClear: b.carryClear || [] })),
  ];
}
export const carryUnitById = (id) => carryUnits().find((u) => u.id === id) || null;

function unitValues(inv, u, N) {
  if (u.kind === 'site') return { prev: inv.snapshots?.[N - 1]?.site?.[u.block], cur: inv.site?.[u.block], hasPrev: Boolean(inv.snapshots?.[N - 1]) };
  if (u.kind === 'equipment') {
    const p = inv.snapshots?.[N - 1]?.equipment;
    return { prev: p ? eqComparable(p) : undefined, cur: eqComparable(inv.equipment), hasPrev: Boolean(p) };
  }
  return { prev: inv.annual?.[N - 1]?.[u.block], cur: inv.annual?.[N]?.[u.block], hasPrev: inv.annual?.[N - 1]?.[u.block] !== undefined };
}

const fmt = (v) => (v === undefined || v === null || v === '' ? '' : Array.isArray(v) ? v.join('、') : typeof v === 'boolean' ? (v ? '是' : '否') : typeof v === 'object' ? JSON.stringify(v) : String(v));
function fieldDiff(fields, a = {}, b = {}) {
  const keys = fields ? fields.map((f) => f.key) : [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  const label = (k) => fields?.find((f) => f.key === k)?.label || k;
  return keys.filter((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)).map((k) => ({ key: k, label: label(k), before: fmt(a?.[k]), after: fmt(b?.[k]) }));
}
const rowTitle = (r) => String(r?.name || r?.meterNo || r?.code || r?.fields?.name || r?.kind || r?.id || '');

// prev／cur 的差異：form → 欄位清單；table → 新增／移除／修改的列
export function diffUnit(u, prev, cur) {
  if (u.formFields) {
    const changed = fieldDiff(u.formFields, prev || {}, cur || {});
    return { changed, added: [], removed: [], rows: [], count: changed.length };
  }
  const P = Array.isArray(prev) ? prev : [], Q = Array.isArray(cur) ? cur : [];
  const pid = new Map(P.map((r) => [r.id, r])), qid = new Map(Q.map((r) => [r.id, r]));
  const added = Q.filter((r) => !pid.has(r.id)).map((r) => ({ id: r.id, title: rowTitle(r) }));
  const removed = P.filter((r) => !qid.has(r.id)).map((r) => ({ id: r.id, title: rowTitle(r) }));
  const rows = [];
  for (const r of Q) {
    const p = pid.get(r.id);
    if (!p) continue;
    const fields = u.kind === 'equipment'
      ? [...fieldDiff(null, { building: p.building, status: p.status, kind: p.kind }, { building: r.building, status: r.status, kind: r.kind }), ...fieldDiff(null, p.fields, r.fields)]
      : fieldDiff(u.rowFields, p, r);
    if (fields.length) rows.push({ id: r.id, title: rowTitle(r), fields });
  }
  return { changed: [], added, removed, rows, count: added.length + removed.length + rows.length };
}

// 沿用時的值：carryClear 的欄位清空、列 id 保留（N 年的列與 N-1 年同一筆）
export function carriedValue(u, prev) {
  const v = clone(prev);
  if (!u.carryClear?.length || !Array.isArray(v)) return v;
  return v.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !u.carryClear.includes(k))));
}

export function carryoverView(inv, N) {
  const conf = inv.confirmations?.[N] || {};
  const units = carryUnits().map((u) => {
    const { prev, cur, hasPrev } = unitValues(inv, u, N);
    const d = hasPrev ? diffUnit(u, prev, cur) : null;
    const hash = stableHash(cur);
    const c = conf[u.id] || null;
    const status = !c ? 'pending' : c.hash === hash ? 'confirmed' : 'stale';
    const canCopy = u.kind === 'annual' && blank(cur) && !blank(prev);
    return {
      id: u.id, kind: u.kind, block: u.block || null, label: u.label, section: u.section || null, source: u.source,
      hasPrev, empty: blank(cur), prevEmpty: blank(prev), diff: d, same: d ? d.count === 0 : null, canCopy,
      confirmation: c, status, hash,
    };
  });
  const confirmed = units.filter((x) => x.status === 'confirmed').length;
  return { year: N, prevYear: N - 1, hasPrevSnapshot: Boolean(inv.snapshots?.[N - 1]), units, confirmed, total: units.length, complete: confirmed === units.length };
}

// 確認一個單位（直接改 inv）。copy＝年度區塊沿用 N-1 年值。回傳該單位的新狀態。
export function confirmUnit(inv, N, unitId, actor, { copy = false, expectHash } = {}) {
  const u = carryUnitById(unitId);
  if (!u) return { error: 'unknown_unit' };
  inv.confirmations ||= {}; inv.snapshots ||= {}; inv.annual ||= {};
  let copied = false;
  if (copy) {
    if (u.kind !== 'annual') return { error: 'copy_not_supported' };
    const prev = inv.annual?.[N - 1]?.[u.block];
    if (blank(prev)) return { error: 'nothing_to_copy' };
    if (!blank(inv.annual?.[N]?.[u.block])) return { error: 'not_empty' };
    inv.annual[N] ||= {};
    inv.annual[N][u.block] = carriedValue(u, prev);
    copied = true;
  }
  const { prev, cur, hasPrev } = unitValues(inv, u, N);
  const hash = stableHash(cur);
  // 畫面上看的差異跟送出當下不一樣（別人剛改過）→ 不讓它默默確認
  if (expectHash && !copied && expectHash !== hash) return { error: 'changed', hash };
  const d = hasPrev ? diffUnit(u, prev, cur) : null;
  inv.confirmations[N] ||= {};
  inv.confirmations[N][unitId] = { at: new Date().toISOString(), who: actor.who, reporter: actor.reporter ?? null, hash, diffCount: d ? d.count : null, ...(copied ? { copied: true } : {}) };
  if (u.kind !== 'annual') {
    inv.snapshots[N] ||= { site: {} };
    inv.snapshots[N].site ||= {};
    inv.snapshots[N].at = new Date().toISOString();
    if (u.kind === 'site') inv.snapshots[N].site[u.block] = clone(inv.site?.[u.block]);
    else inv.snapshots[N].equipment = clone(inv.equipment);
  }
  return { ok: true, copied, unit: carryoverView(inv, N).units.find((x) => x.id === unitId) };
}

// N-1 年某 site 區塊（快照優先，沒有快照回 null）
export const snapshotSite = (inv, N, block) => inv.snapshots?.[N]?.site?.[block] ?? null;

export const annualSpec = {
  blocks: ANNUAL_BLOCKS,
  drSchemes: DR_SCHEMES,
  heatUses: HEAT_USES,
  systems: SYSTEMS,
};

export { siteBlockById };
