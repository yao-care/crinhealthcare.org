// 申報與報告（工作清單 12、13、15）：診斷措施、節能計畫、診斷團隊的欄位規格與驗證。
//
// 資料落在 inventory/<hid>.json 的三個區塊（架構約定「申報與報告」一節）：
//   measures[]  附件一 3.2 設備汰換（type:'replace'）／3.3 操作面（type:'operation'）
//   plans[]     附件二 節能計畫；每筆 measureId 指回措施（措施 ID 貫穿到計畫），versions[] 是 R8 版本紀錄
//   diagnosis{} 附件一 報告主檔（3.0）＋四、診斷團隊聲明（3.4）——放 measures 旁的獨立區塊，不放 site：
//               site 是「初始建檔、建完唯讀」的院所基本資料，診斷團隊每一期（10 年）會換，生命週期不同。
//
// 依據一律寫在這裡（工作清單第 21 項：單一來源），畫面與 xlsx 抬頭都從這裡讀。
import { SOURCES, isMeasureCode, MEASURE_CODES } from './inventory-schema.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;
const { LAW_ANNEX3, LAW_DIAG } = SOURCES;

// ── 依據 ──
export const A1 = (ref, note) => ({ doc: '附件一 節能診斷報告格式', ref, law: LAW_DIAG, ...(note ? { note } : {}) });
export const A2 = (ref, note) => ({ doc: '附件二 節能計畫格式', ref, law: LAW_DIAG, ...(note ? { note } : {}) });
export const T3 = (ref, spec, note) => ({ doc: '附表三 能源查核制度申報表（非生產性質行業）', ref, law: LAW_ANNEX3, date: '115-01-23', ...(spec ? { spec } : {}), ...(note ? { note } : {}) });

// 原文（xlsx 表註、畫面「展開原文」用）
export const ORIGINAL_TEXT = {
  a1Summary: '能源用戶（○○）提報節能診斷報告，共包含○項具體節能改善措施，計發掘節能潛力○○○公噸油當量，其中包括節電潛力○○○萬度。',
  a1Notes: [
    '1. 重大製程涉及生產機密者，得由用戶自行辦理診斷。',
    '2. 螢光燈具超過 2 年、LED 燈具超過 8 年，公用設備超過 10 年及製程設備超過 20 年，應列於上表。',
  ],
  a1Team: '本節能診斷報告由能源用戶（○○）洽請○○○、○○○等診斷團隊辦理。診斷團隊之資格（詳本規定第3點第2項）證明文件及診斷報告，由能源用戶留存至少5年（自提報日期起算），供中央主管機關查驗。',
  a2Notes: [
    '1. 節能診斷報告所載回收年限小於 10 年之節能改善措施，均應將執行規劃填列於上表。',
    '2. 上表所列節能改善措施如未載明預計完工年度，應於備註欄位說明未導入規劃之原因。',
  ],
};

// ── 選項 ──
export const ENERGY_TYPES = Object.entries(C.ENERGY_UNITS).map(([code, e]) => ({ code, label: e.label, unit: e.unit }));
const ENERGY_CODES = ENERGY_TYPES.map((e) => e.code);
// §7.1 措施類型（系統內部分類，附件一／二用；申報表十／十一改用 §7.7 官方代碼 officialCode）
export const DEVICE_CLASSES = { C01: '照明', C02: '動力', C03: '電熱', C04: '空調', C05: '冷凍冷藏', C06: '其他' };
export const ACTIONS = { A01: '能源效率提升', A02: '維護保養', A03: '更換高效率設備或零組件', A04: '操作調整' };
// R6 設備類別（附件一註 2）
export const REPLACE_CATEGORIES = ['螢光燈具', 'LED 燈具', '公用設備', '製程設備', '其他'];
export const PLAN_STATUS = ['規劃中', '執行中', '已完工', '取消'];
export const TEAM_TYPES = ['法人', '學校或機構', '執業技師'];
export const TEAM_CODES = {
  'Q-L1': '法人：≥1 名技師＋≥2 名具經驗與資格全職員工（≥1 名能管證書）',
  'Q-L2': '法人：≥5 名具經驗與資格全職員工（≥3 名能管證書）',
  'Q-L3': '法人：受主管機關委託提供節能減碳輔導服務',
  'Q-S1': '學校或機構：受主管機關委託提供節能減碳輔導服務',
  'Q-E1': '執業技師：機械／冷凍空調／電機／化工，提報日 ≤ 執照到期日',
};

// ── 欄位規格 ──
// 共同的「預期成效」欄（3.2、3.3 同一組；單位由 energyType 決定）
const EFFECT_FIELDS = [
  { key: 'annualUse', label: '年耗能量預估', type: 'number', unitFrom: 'energyType', group: '年耗能量預估' },
  { key: 'assessment', label: '使用效率評估與改善作法說明', type: 'text', max: 2000 },
  { key: 'savingPct', label: '節能率', type: 'number', unit: '%', group: '預期成效' },
  { key: 'annualSaving', label: '年節能量預估', type: 'number', unitFrom: 'energyType', group: '預期成效', hint: '診斷摘要的節能潛力由這欄換算油當量' },
  { key: 'savingCost', label: '節省能源費用', type: 'number', unit: '元/年', group: '預期成效' },
  { key: 'investment', label: '投資金額', type: 'number', unit: '元', group: '預期成效' },
];
const COMMON_TAIL = [
  { key: 'energyType', label: '能源種類', type: 'select', options: ENERGY_CODES, optionLabels: Object.fromEntries(ENERGY_TYPES.map((e) => [e.code, `${e.label}（${e.unit}）`])), default: 'E01', system: true },
  { key: 'officialCode', label: '節約能源措施代碼', type: 'text', system: true, hint: '附表三附錄一，例 AA06；申報表十／十一用', source: { ...MEASURE_CODES.source } },
  { key: 'note', label: '補充說明', type: 'text', max: 2000, system: true, hint: '強制列入的設備不可刪，可在這裡補說明' },
];

export const MEASURE_TYPES = {
  replace: {
    id: 'replace', label: '設備汰換節能改善措施', section: '二', source: A1('二、設備汰換節能改善措施（表）', '18 欄；註 2 機齡門檻（R6）'),
    fields: [
      { key: 'name', label: '設備名稱', type: 'text', fromEquipment: true },
      { key: 'brand', label: '廠牌', type: 'text', fromEquipment: true },
      { key: 'model', label: '型式', type: 'text', fromEquipment: true },
      { key: 'madeYear', label: '製造年份', type: 'year', fromEquipment: true, hint: '民國或西元皆可' },
      { key: 'capacity', label: '設備容量', type: 'number', fromEquipment: true, group: '設備容量' },
      { key: 'capacityUnit', label: '容量單位', type: 'text', fromEquipment: true, group: '設備容量' },
      { key: 'qty', label: '數量', type: 'number', fromEquipment: true },
      { key: 'hoursPerYear', label: '運轉時數', type: 'number', unit: '小時', fromEquipment: true },
      ...EFFECT_FIELDS,
      { key: 'replaceCategory', label: '設備類別（R6）', type: 'select', options: REPLACE_CATEGORIES, system: true, hint: '留白依設備主檔推定：日光燈／省電燈泡＝螢光燈具、LED＝LED 燈具、空調與其他系統＝公用設備', source: A1('註 2') },
      { key: 'secret', label: '涉及生產機密', type: 'boolean', system: true, source: A1('註 1') },
      ...COMMON_TAIL,
    ],
  },
  operation: {
    id: 'operation', label: '操作面節能改善措施', section: '三', source: A1('三、操作面節能改善措施（表）', '12 欄'),
    fields: [
      { key: 'deviceClass', label: '措施類型·設備類別', type: 'select', options: Object.keys(DEVICE_CLASSES), optionLabels: DEVICE_CLASSES, group: '措施類型' },
      { key: 'action', label: '措施類型·改善作為', type: 'select', options: Object.keys(ACTIONS), optionLabels: ACTIONS, group: '措施類型' },
      { key: 'name', label: '措施名稱', type: 'text', required: true },
      ...EFFECT_FIELDS,
      ...COMMON_TAIL,
    ],
  },
};

export const PLAN_FIELDS = [
  { key: 'completionYear', label: '預計完工年度', type: 'rocYear', hint: '民國年；限提報年度～提報年度+4（R7）', source: A2('預計完工年度欄', '提報年度起 5 年內') },
  { key: 'note', label: '備註', type: 'text', max: 2000, hint: '未填預計完工年度時必填（附件二註 2）', source: A2('註 2') },
  { key: 'status', label: '計畫狀態', type: 'select', options: PLAN_STATUS, default: '規劃中', system: true },
  { key: 'actualDoneDate', label: '實際完工日期', type: 'date', system: true },
  { key: 'officialCode', label: '節約能源措施代碼', type: 'text', system: true, hint: '留白沿用措施的代碼；申報表十／十一用' },
];

export const DIAGNOSIS_FIELDS = [
  { key: 'reportDate', label: '提報日期', type: 'date', code: 'DR-00-02', required: true, hint: 'R6 機齡與 R7 完工年度都以這個日期的年度計算；留白用今年' },
  { key: 'period', label: '期別', type: 'text', code: 'DR-00-03', default: '第一期', required: true },
];
export const TEAM_FIELDS = [
  { key: 'name', label: '診斷團隊名稱', type: 'text', required: true },
  { key: 'type', label: '類型', type: 'select', options: TEAM_TYPES },
  { key: 'code', label: '資格代碼', type: 'select', options: Object.keys(TEAM_CODES), optionLabels: TEAM_CODES },
  { key: 'commissioned', label: '受主管機關委託提供節能減碳輔導服務', type: 'boolean', hint: 'Q-L3／Q-S1' },
  { key: 'docs', label: '資格證明文件', type: 'text', max: 2000, hint: '文件名稱或存放位置；留存至少 5 年' },
  { key: 'licenceDiscipline', label: '技師執照科別', type: 'select', options: ['機械', '冷凍空調', '電機', '化工', '其他'], hint: 'Q-E1' },
  { key: 'licenceNo', label: '技師執照字號', type: 'text' },
  { key: 'licenceExpiresAt', label: '執照有效期限', type: 'date', hint: '到期前會出現在期限提醒' },
];
export const MEMBER_FIELDS = [
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'certType', label: '證照別', type: 'text' },
  { key: 'certNo', label: '證號', type: 'text' },
  { key: 'years', label: '年資', type: 'number', unit: '年' },
  { key: 'fullTime', label: '全職', type: 'boolean' },
  { key: 'engineerDiscipline', label: '技師科別', type: 'text', hint: '機械／冷凍空調／電機／化工' },
  { key: 'energyCert', label: '能管訓練合格證書', type: 'boolean' },
  { key: 'seniorElectric', label: '高級電氣技術人員', type: 'boolean' },
];

export const reportSpec = {
  measureTypes: MEASURE_TYPES,
  planFields: PLAN_FIELDS,
  diagnosisFields: DIAGNOSIS_FIELDS,
  teamFields: TEAM_FIELDS,
  memberFields: MEMBER_FIELDS,
  energyTypes: ENERGY_TYPES,
  deviceClasses: DEVICE_CLASSES,
  actions: ACTIONS,
  teamCodes: TEAM_CODES,
  originalText: ORIGINAL_TEXT,
  sources: {
    measures: A1('二、三', '措施 ID 貫穿到節能計畫'),
    plans: A2('節能計畫表', 'R7 回收 < 10 年必列；R8 保留版本紀錄（變更前後、日期、原因）'),
    diagnosis: A1('報告主檔、四、診斷團隊聲明', '資格證明文件及報告留存至少 5 年'),
    deadlines: { doc: '申報期限', ref: '每年 1 月底（附表三）、3/31（節電率）、117-03-31（第一期診斷＋計畫）', law: `${LAW_ANNEX3}；${LAW_DIAG}`, spec: '§1.3' },
    r5: C.SOURCES.r5, r6: C.SOURCES.r6, r7: C.SOURCES.r7, r8: A2('（R8）', '計畫執行與變更併同附表三申報；保留版本紀錄'),
  },
};

// ── 驗證 ──
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
function normOne(f, raw) {
  if (raw === undefined || raw === null || raw === '') return { value: undefined };
  switch (f.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { error: '必須是數字' };
      if (n < 0) return { error: '不可為負數' };
      return { value: n };
    }
    case 'year': case 'rocYear': {
      const s = String(raw).trim();
      if (!/^\d{2,4}$/.test(s)) return { error: '年份格式錯誤（填 2015 或民國 104）' };
      const n = Number(s);
      // year 存西元（同設備主檔）；rocYear 存民國（附件二欄位本身是民國年）
      const ad = n <= 1911 ? n + 1911 : n;
      if (ad < 1900 || ad > 2100) return { error: '年份不合理' };
      return { value: f.type === 'year' ? ad : ad - 1911 };
    }
    case 'date': {
      const d = C.parseDate(raw);
      return d ? { value: C.toIso(d) } : { error: '日期格式錯誤（YYYY-MM-DD 或民國 115-03-31）' };
    }
    case 'boolean': return typeof raw === 'boolean' ? { value: raw } : { error: '必須是是／否' };
    case 'select': return f.options.includes(String(raw)) ? { value: String(raw) } : { error: `不在選項內（${f.options.join('／')}）` };
    default: {
      const v = String(raw).trim();
      if (v.length > (f.max || 500)) return { error: `超過 ${f.max || 500} 字` };
      return { value: v || undefined };
    }
  }
}

// 回傳 { errors, values }。未知欄位擋下；必填只在 requireKeys 時檢查（措施名稱這種沒填就沒意義的）
export function normalizeFields(fields, input, where = '') {
  const errors = [], values = {};
  if (input === undefined) return { errors, values };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: [`${where}資料格式錯誤`], values };
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(input)) {
    const f = known.get(k);
    if (!f) { errors.push(`${where}不認得的欄位：${k}`); continue; }
    const r = normOne(f, input[k]);
    if (r.error) errors.push(`${where}「${f.label}」${r.error}`);
    else if (r.value !== undefined) values[k] = r.value;
  }
  if (values.officialCode && !isMeasureCode(values.officialCode)) errors.push(`${where}節約能源措施代碼「${values.officialCode}」不在附錄一代碼表內（例：AA06）`);
  return { errors, values };
}

export function validateMeasureInput(type, fields) {
  const t = MEASURE_TYPES[type];
  if (!t) return { errors: ['措施類型須為 replace（設備汰換）或 operation（操作面）'], values: {} };
  const r = normalizeFields(t.fields, fields || {});
  if (type === 'operation' && !r.values.name) r.errors.push('「措施名稱」必填');
  return r;
}

export function validateDiagnosis(input) {
  const errors = [];
  const top = normalizeFields(DIAGNOSIS_FIELDS, Object.fromEntries(Object.entries(input || {}).filter(([k]) => k !== 'teams')));
  errors.push(...top.errors);
  const teams = [];
  if (input?.teams !== undefined && !Array.isArray(input.teams)) errors.push('診斷團隊必須是陣列');
  (Array.isArray(input?.teams) ? input.teams : []).forEach((t, i) => {
    const { members, id, ...rest } = t || {};
    const r = normalizeFields(TEAM_FIELDS, rest, `第 ${i + 1} 個團隊·`);
    errors.push(...r.errors);
    if (!r.values.name) errors.push(`第 ${i + 1} 個團隊·「診斷團隊名稱」必填`);
    const ms = [];
    (Array.isArray(members) ? members : []).forEach((m, j) => {
      const { id: mid, ...mrest } = m || {};
      const mr = normalizeFields(MEMBER_FIELDS, mrest, `第 ${i + 1} 個團隊第 ${j + 1} 位·`);
      errors.push(...mr.errors);
      ms.push({ id: typeof mid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(mid) ? mid : undefined, ...mr.values });
    });
    teams.push({ id: typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : undefined, ...r.values, members: ms });
  });
  return { errors, value: { ...top.values, teams } };
}

export const energyUnit = (code) => C.ENERGY_UNITS[code]?.unit || '';
export const energyLabel = (code) => C.ENERGY_UNITS[code]?.label || '';
