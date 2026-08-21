// 電力健檢填報：欄位定義的唯一真實來源。
//
// 依據＝「軍醫院電力健檢作業文件」公文的三份附件：
//   附件一 聯絡人資料回覆表        → contact 區塊（個資，永不同步到看板）
//   附件二 作業流程與權責（9 階段） → STAGES（不是輸入欄位，是進度顯示）
//   附件三 系統填報資料清單        → basic / bills / emissions / majorLoads / chillers / events 六個區塊
//                                    ＋ SELF_CHECK（送出前自我檢核 6 條）
//
// 這份表推導出：前端表單/表格、驗證、xlsx 匯入匯出對照、看板同步彙總。
// 新增欄位只要動這裡；`pnpm test` 會擋下沒有中文標籤或與 V2 範本對不上的情況。
//
// type：
//   'text' 字串原樣（電號、統編這種前導零不能被數字化）
//   'number' 數值
//   'percent' 使用者填 60（代表 60%）
//   'month' YYYY-MM      'date' YYYY-MM-DD
//   'select' 有選項但允許自由填（業主 2026-08-12 指示：不做 enum 硬限制）
//
// 每一格的複驗狀態存在 meta 裡，不在這份表：'todo' 待複驗 / 'low' 信心低 / 'ok' 已複驗 / 'manual' 人工填寫。

// ── 附件二：作業流程九階段 ──
export const STAGES = [
  { id: 'notice', label: '啟動通知', owner: 'org', done: '院內承辦人確認' },
  { id: 'contact', label: '聯絡人回復', owner: 'hospital', done: '聯絡資料完整可用', block: 'contact' },
  { id: 'account', label: '帳號開通', owner: 'org', done: '帳號可登入且密碼已更新' },
  { id: 'prepare', label: '資料準備', owner: 'hospital', done: '資料期間與單位一致' },
  { id: 'fill', label: '系統填報', owner: 'hospital', done: '系統狀態顯示已送出' },
  { id: 'review', label: '檢核補正', owner: 'both', done: '缺漏與疑義完成閉環' },
  { id: 'analyze', label: '分析診斷', owner: 'org', done: '形成初步診斷結論' },
  { id: 'report', label: '報告交付', owner: 'org', done: '報告完成交付' },
  { id: 'followup', label: '後續追蹤', owner: 'both', done: '建立節電行動清單' },
];

// ── 附件三：送出前自我檢核 ──
export const SELF_CHECK = [
  '已涵蓋通知指定之完整資料期間，無漏月。',
  '電費單之用電度數、需量、契約容量及費用已核對。',
  '排放源清單的期間、單位及邊界與本案需求一致。',
  '異常用電月份或重大營運事件已加註說明。',
  '佐證檔案可辨識，檔名包含院區、資料類型及年月。',
  '已由院內權責單位確認後送出。',
];

// ── 附件一：聯絡人資料回覆表 ──
const CONTACT_FIELDS = [
  { key: 'hospitalName', label: '醫院全銜', type: 'text', required: true },
  { key: 'primaryName', label: '主要聯絡人姓名', type: 'text', required: true },
  { key: 'primaryUnit', label: '單位／職稱', type: 'text', required: true },
  { key: 'primaryPhone', label: '聯絡電話／分機', type: 'text', required: true },
  { key: 'primaryEmail', label: '電子郵件', type: 'text', required: true },
  { key: 'backupName', label: '備援聯絡人姓名', type: 'text', hint: '選填' },
  { key: 'backupPhone', label: '備援電話／分機', type: 'text', hint: '選填' },
  { key: 'backupEmail', label: '備援電子郵件', type: 'text', hint: '選填' },
  {
    key: 'reportingUnit', label: '預計資料填報承辦單位', type: 'select', required: true,
    options: ['總務', '工務', '主計', '永續／環安', '其他'],
  },
  { key: 'reportingUnitOther', label: '承辦單位（其他，請說明）', type: 'text' },
  { key: 'note', label: '備註', type: 'text' },
];

// ── 附件三：基本資料（＝範本的「表Z｜基本資料」，原註明不在範圍，本次公文要求納入）──
const BASIC_FIELDS = [
  { key: 'campusName', label: '院區名稱', type: 'text', required: true },
  { key: 'address', label: '地址', type: 'text', required: true },
  { key: 'buildingScope', label: '建物／院區範圍', type: 'text', required: true, hint: '例：主院區 A/B 棟＋門診大樓' },
  { key: 'beds', label: '核定床數', type: 'number', unit: '床', required: true },
  { key: 'floorArea', label: '樓地板面積', type: 'number', unit: 'm²', required: true },
  { key: 'operationType', label: '主要營運型態', type: 'text', required: true, hint: '例：急性一般醫院（含急重症）' },
  { key: 'changeNote', label: '異動註記', type: 'text', hint: '現況如有異動請於此註記' },
];

// ── 附件三：電費單（一列一個計費期間；對應範本「表P｜用電統計」）──
// 表P 把電號/電價種類放表頭、月份放列；這裡改成每列自帶，因為一家院所可能有多個電號，
// 匯入時會把表頭值複製到每一列（見 audit-import.js）。
const BILL_COLUMNS = [
  { key: 'period', label: '計費期間', type: 'month', required: true, sticky: true, width: 'm' },
  { key: 'meterNo', label: '電號', type: 'text', required: true, group: '基本', width: 'l' },
  { key: 'tariffType', label: '用電種類', type: 'text', required: true, group: '基本', width: 'm' },
  { key: 'timeType', label: '時間種類', type: 'text', group: '基本', width: 'm' },

  { key: 'contractCapacity', label: '經常契約容量', unit: 'kW', type: 'number', required: true, group: '契約與需量', total: 'max' },
  { key: 'demandPeak', label: '需量·尖峰', unit: 'kW', type: 'number', group: '契約與需量' },
  { key: 'demandHalfPeak', label: '需量·半尖峰', unit: 'kW', type: 'number', group: '契約與需量' },
  { key: 'demandSatHalfPeak', label: '需量·週六半尖峰', unit: 'kW', type: 'number', group: '契約與需量' },
  { key: 'demandOffPeak', label: '需量·離峰', unit: 'kW', type: 'number', group: '契約與需量' },
  {
    key: 'maxDemand', label: '最高需量', unit: 'kW', type: 'number', group: '契約與需量', total: 'max',
    computed: { op: 'max', of: ['demandPeak', 'demandHalfPeak', 'demandSatHalfPeak', 'demandOffPeak'] },
  },
  { key: 'powerFactor', label: '功率因數', unit: '%', type: 'percent', required: true, group: '契約與需量' },

  { key: 'usePeak', label: '計費度數·尖峰', unit: 'kWh', type: 'number', group: '計費度數', total: 'sum' },
  { key: 'useHalfPeak', label: '計費度數·半尖峰', unit: 'kWh', type: 'number', group: '計費度數', total: 'sum' },
  { key: 'useSatHalfPeak', label: '計費度數·週六半尖峰', unit: 'kWh', type: 'number', group: '計費度數', total: 'sum' },
  { key: 'useOffPeak', label: '計費度數·離峰', unit: 'kWh', type: 'number', group: '計費度數', total: 'sum' },
  {
    key: 'useTotal', label: '合計度數', unit: 'kWh', type: 'number', group: '計費度數', total: 'sum',
    computed: { op: 'sum', of: ['usePeak', 'useHalfPeak', 'useSatHalfPeak', 'useOffPeak'] },
  },

  { key: 'wheelPeak', label: '轉供·尖峰', unit: 'kWh', type: 'number', group: '轉供度數', total: 'sum' },
  { key: 'wheelHalfPeak', label: '轉供·半尖峰', unit: 'kWh', type: 'number', group: '轉供度數', total: 'sum' },
  { key: 'wheelSatHalfPeak', label: '轉供·週六半尖峰', unit: 'kWh', type: 'number', group: '轉供度數', total: 'sum' },
  { key: 'wheelOffPeak', label: '轉供·離峰', unit: 'kWh', type: 'number', group: '轉供度數', total: 'sum' },

  { key: 'feeBasic', label: '基本費', unit: '元', type: 'number', required: true, group: '費用', total: 'sum' },
  { key: 'feeFlow', label: '流動費', unit: '元', type: 'number', required: true, group: '費用', total: 'sum' },
  { key: 'feeOver', label: '超約附加費', unit: '元', type: 'number', group: '費用', total: 'sum' },
  { key: 'feePowerFactor', label: '功因調整費', unit: '元', type: 'number', group: '費用', total: 'sum' },
  { key: 'feeOther', label: '其他費用', unit: '元', type: 'number', group: '費用', total: 'sum' },
  { key: 'feeTotal', label: '應繳總額', unit: '元', type: 'number', required: true, group: '費用', total: 'sum' },

  { key: 'note', label: '異常說明', type: 'text', group: '備註', width: 'xl', hint: '該月用電突升突降的原因' },
];

// ── 附件三：排放源清單 ──
const EMISSION_COLUMNS = [
  { key: 'name', label: '排放源名稱', type: 'text', required: true, sticky: true, width: 'l' },
  { key: 'category', label: '類別', type: 'select', required: true, width: 'm', options: ['範疇一 直接排放', '範疇二 外購電力', '範疇三 其他間接', '類別3', '類別4', '類別5', '類別6'] },
  { key: 'device', label: '設備／活動', type: 'text', required: true, width: 'l' },
  { key: 'energyType', label: '能源種類', type: 'select', required: true, width: 'm', options: ['電力', '柴油', '汽油', '天然氣', '液化石油氣', '冷媒', '蒸汽', '其他'] },
  { key: 'amount', label: '使用量', type: 'number', required: true, total: 'sum' },
  { key: 'unit', label: '單位', type: 'text', required: true, width: 's', hint: '照原始紀錄，例如 度、公升、kg' },
  { key: 'period', label: '期間', type: 'text', required: true, width: 'm', hint: '與電費單同期' },
  { key: 'emission', label: '排放量', unit: 'tCO₂e', type: 'number', required: true, total: 'sum' },
  { key: 'evidence', label: '佐證', type: 'text', width: 'l' },
];

// ── 附件三：重大設備／負載（＝範本「表E｜能源設備盤查」，欄位與座標一致）──
const LOAD_COLUMNS = [
  { key: 'system', label: '系統類別', type: 'select', required: true, sticky: true, width: 'm', options: ['空調', '照明', '動力', '醫療設備', '資料中心', '鍋爐·蒸汽', '空壓', '給排水', '其他'] },
  { key: 'name', label: '設備名稱', type: 'text', required: true, width: 'l' },
  { key: 'deviceNo', label: '設備編號', type: 'text', required: true, width: 'm' },
  { key: 'madeYear', label: '製造年份', type: 'text', required: true, width: 's', hint: '西元年' },
  { key: 'capacity', label: '設備容量', type: 'number', required: true, hint: '照銘牌數字，例如冷卻能力 200RT 就填 200' },
  { key: 'capacityUnit', label: '規格單位', type: 'text', required: true, width: 's', hint: '照銘牌單位，例如 RT' },
  { key: 'ratedKw', label: '額定功率', unit: 'kW', type: 'number', required: true },
  { key: 'qty', label: '設備數量', type: 'number', required: true, total: 'sum' },
  { key: 'loadPct', label: '負載率', unit: '%', type: 'percent', required: true, hint: '耗電固定填 100；會變動填實際平均；無法判斷填 60' },
  { key: 'hoursPerYear', label: '年運轉時數', unit: 'hr', type: 'number', required: true },
  {
    key: 'annualKwh', label: '推估年用電量', unit: 'kWh', type: 'number', total: 'sum',
    computed: { op: 'product', of: ['ratedKw', 'qty', 'loadPct%', 'hoursPerYear'] },
  },
];

// ── 附件三：冰水主機細項（＝範本「表A 冰水主機」，每台一列；範本是每台一欄，匯入時轉置）──
const CHILLER_COLUMNS = [
  { key: 'systemName', label: '系統名稱', type: 'text', required: true, sticky: true, width: 'm' },
  { key: 'deviceNo', label: '設備編號', type: 'text', required: true, width: 'm' },
  { key: 'capacityRt', label: '設備容量', unit: 'RT', type: 'text', required: true, hint: '選最接近且不高於實際數的值，例如 390 填 380' },
  { key: 'age', label: '機齡', type: 'text', required: true, width: 's' },
  { key: 'originType', label: '產地/型式/定變頻', type: 'text', required: true, width: 'l' },
  { key: 'maintenance', label: '保養等級', type: 'select', required: true, width: 'm', options: ['良好（例行確實）', '一般（間歇保養）', '欠佳（少保養無水處理）'] },
  { key: 'chilledOutSpring', label: '冰水出水溫度·春(3-5月)', unit: '℃', type: 'number' },
  { key: 'chilledOutSummer', label: '冰水出水溫度·夏(6-8月)', unit: '℃', type: 'number' },
  { key: 'chilledOutAutumn', label: '冰水出水溫度·秋(9-11月)', unit: '℃', type: 'number' },
  { key: 'chilledOutWinter', label: '冰水出水溫度·冬(12-2月)', unit: '℃', type: 'number' },
  { key: 'coolingInSpring', label: '冷卻水回水溫度·春(3-5月)', unit: '℃', type: 'number' },
  { key: 'coolingInSummer', label: '冷卻水回水溫度·夏(6-8月)', unit: '℃', type: 'number' },
  { key: 'coolingInAutumn', label: '冷卻水回水溫度·秋(9-11月)', unit: '℃', type: 'number' },
  { key: 'coolingInWinter', label: '冷卻水回水溫度·冬(12-2月)', unit: '℃', type: 'number' },
  { key: 'roomTemp', label: '控溫空間溫度', unit: '℃', type: 'number', required: true },
  { key: 'roomHumidity', label: '控溫空間濕度', unit: '%', type: 'percent', required: true },
];

// ── 附件三：營運與異常事件 ──
const EVENT_COLUMNS = [
  { key: 'date', label: '發生日期', type: 'date', required: true, sticky: true, width: 'm' },
  { key: 'type', label: '事件類型', type: 'select', required: true, width: 'm', options: ['門急診／住院量能變動', '擴建', '施工', '設備汰換', '停電', '疫情', '特殊任務', '其他'] },
  { key: 'title', label: '事件名稱', type: 'text', required: true, width: 'l' },
  { key: 'affectedPeriod', label: '影響期間', type: 'text', required: true, width: 'm', hint: '與分析期間對應，例如 2026-03 ~ 2026-05' },
  { key: 'description', label: '說明', type: 'text', required: true, width: 'xl', hint: '足以解釋用電突升突降的說明' },
];

// ── 區塊總表 ──
export const BLOCKS = [
  {
    id: 'contact', task: 'contact', label: '承辦聯絡人資料', attachment: '附件一', kind: 'form',
    icon: '📇', fields: CONTACT_FIELDS, private: true,
    intro: '姓名、電話、電子郵件僅供本案帳號建立、通知、補正聯繫及報告交付使用。這一區存在主機上，不會進入公開的原始碼倉庫，也不會出現在看板。',
    accepts: [],
  },
  {
    id: 'basic', task: 'audit', label: '基本資料', attachment: '附件三', kind: 'form',
    icon: '🏥', fields: BASIC_FIELDS,
    intro: '範圍須與溫室氣體盤查及電費資料一致。',
    accepts: ['pdf', 'image'],
  },
  {
    id: 'bills', task: 'audit', label: '電費單', attachment: '附件三', kind: 'table',
    icon: '🧾', columns: BILL_COLUMNS, rowLabel: '計費期間', keyColumn: 'period',
    intro: '原則填報最近完整 12 個月；如專案另有指定期間，以通知內容為準。逐月核對，金額與度數單位一致，異常月份請於「異常說明」加註。',
    accepts: ['pdf', 'image', 'xlsx'],
  },
  {
    id: 'emissions', task: 'audit', label: '排放源清單', attachment: '附件三', kind: 'table',
    icon: '🌫', columns: EMISSION_COLUMNS, rowLabel: '排放源',
    intro: '與電費單同期。避免重複計算，確認範疇、單位及期間。',
    accepts: ['pdf', 'image', 'xlsx'],
  },
  {
    id: 'majorLoads', task: 'audit', label: '重大設備與負載', attachment: '附件三', kind: 'table',
    icon: '⚙️', columns: LOAD_COLUMNS, rowLabel: '設備', max: 50,
    intro: '優先提供高耗能或長時運轉設備：空調主機、冰水泵、鍋爐、空壓、醫療設備、照明、資料中心等。',
    accepts: ['pdf', 'image', 'xlsx'],
  },
  {
    id: 'chillers', task: 'audit', label: '冰水主機（細項）', attachment: '附件三', kind: 'table',
    icon: '❄️', columns: CHILLER_COLUMNS, rowLabel: '主機', max: 6,
    intro: '選填。已在「重大設備與負載」列出的冰水主機，若要做效率診斷再補這一區的溫度與保養資料。',
    accepts: ['pdf', 'image', 'xlsx'],
  },
  {
    id: 'events', task: 'audit', label: '營運與異常事件', attachment: '附件三', kind: 'table',
    icon: '📌', columns: EVENT_COLUMNS, rowLabel: '事件',
    intro: '說明足以解釋用電突升突降之事件，與分析期間對應。',
    accepts: ['pdf', 'image'],
  },
];

export const blockById = (id) => BLOCKS.find((b) => b.id === id) || null;
export const fieldsOf = (block) => (block.kind === 'table' ? block.columns : block.fields);

// 前端用的規格（純資料，直接 JSON 化）
export const auditSpec = {
  blocks: BLOCKS,
  stages: STAGES,
  selfCheck: SELF_CHECK,
  states: {
    todo: { label: '待複驗', hint: '解析出來的值，還沒有人確認' },
    low: { label: '信心低', hint: '解析不確定，一定要逐格核對' },
    ok: { label: '已複驗', hint: '已由院方確認' },
    manual: { label: '人工填寫', hint: '沒有來源檔，直接輸入' },
  },
};

// ── 空白骨架 ──
export function blankAudit() {
  const out = { version: 1, updated: null, selfCheck: [], blocks: {} };
  for (const b of BLOCKS) out.blocks[b.id] = b.kind === 'table' ? { rows: [] } : { values: {}, meta: {} };
  return out;
}

// ── 值的正規化：把使用者/解析器給的原始值變成該型別該有的樣子 ──
const pad = (n) => String(n).padStart(2, '0');

// 電費單上寫的是民國年。模型被要求換算成西元，但「114年3月」原樣回來也很常見，
// 這裡再兜一層：3 位數以下一律當民國年（+1911）。西元不可能只有 3 位數，不會誤判。
function toAD(y) {
  const n = Number(y);
  return String(String(y).length <= 3 && n > 0 && n < 300 ? n + 1911 : n);
}

export function coerce(value, type) {
  if (value === undefined || value === null || value === '') return undefined;
  if (type === 'number' || type === 'percent') {
    // 解析器常回「1,234.5 kWh」「NT$3,872,510」這種帶符號的字串。
    // ⚠️ 清乾淨後一定要確認還有數字才轉：Number('') 是 0，
    // 不擋的話「未提供」「無」這種字會被靜靜寫成 0 度、0 元，比留白危險得多。
    const cleaned = String(value).replace(/[^\d.eE+-]/g, '');
    if (!/\d/.test(cleaned)) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  const s = String(value).trim();
  if (type === 'month') {
    const m = s.match(/(\d{2,4})\D+(\d{1,2})/);
    return m ? `${toAD(m[1])}-${pad(m[2])}` : s;
  }
  if (type === 'date') {
    const m = s.match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? `${toAD(m[1])}-${pad(m[2])}-${pad(m[3])}` : s;
  }
  return s;
}

// ── 驗證 ──
// 刻意「必填漏填只警告不擋」：院方常常分次填完，硬擋只會逼人填假資料
// （與 audit-io.js 匯入時的判準一致）。真正擋住送出的是「還有未複驗的格子」。
const RE_MONTH = /^\d{4}-\d{2}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkValue(field, v, where, errors, warnings) {
  if (v === undefined || v === '') {
    if (field.required) warnings.push(`${where}「${field.label}」尚未填寫`);
    return;
  }
  if (field.type === 'number' || field.type === 'percent') {
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${where}「${field.label}」必須是數字`); return; }
    if (v < 0) errors.push(`${where}「${field.label}」不可為負數`);
    if (field.type === 'percent' && v > 100) warnings.push(`${where}「${field.label}」超過 100%，請確認`);
    return;
  }
  if (field.type === 'month' && !RE_MONTH.test(String(v))) errors.push(`${where}「${field.label}」格式須為 YYYY-MM`);
  if (field.type === 'date' && !RE_DATE.test(String(v))) errors.push(`${where}「${field.label}」格式須為 YYYY-MM-DD`);
  if (/Email$/i.test(field.key) && !RE_EMAIL.test(String(v))) errors.push(`${where}「${field.label}」不是有效的電子郵件`);
}

export function validateAudit(audit) {
  const errors = [];
  const warnings = [];
  if (!audit || typeof audit !== 'object') return { ok: false, errors: ['資料格式錯誤'], warnings };

  for (const b of BLOCKS) {
    const blk = audit.blocks?.[b.id];
    if (!blk) continue;
    if (b.kind === 'form') {
      for (const f of b.fields) checkValue(f, blk.values?.[f.key], `${b.label}·`, errors, warnings);
    } else {
      const rows = blk.rows || [];
      if (b.max && rows.length > b.max) errors.push(`${b.label}最多 ${b.max} 筆，目前 ${rows.length} 筆`);
      rows.forEach((r, i) => {
        const keyCol = b.keyColumn ? r.values?.[b.keyColumn] : null;
        const where = `${b.label} 第 ${i + 1} 筆${keyCol ? `（${keyCol}）` : ''}·`;
        for (const c of b.columns) { if (!c.computed) checkValue(c, r.values?.[c.key], where, errors, warnings); }
      });
      // 電費單同一個電號不該有重複月份——重複會讓看板的月趨勢畫出兩個點
      if (b.id === 'bills') {
        const seen = new Set();
        for (const r of rows) {
          const k = `${r.values?.meterNo || ''}|${r.values?.period || ''}`;
          if (r.values?.period && seen.has(k)) errors.push(`電費單有重複的計費期間：${r.values.period}（電號 ${r.values.meterNo || '未填'}）`);
          seen.add(k);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ── 複驗狀態 ──
// 送出的硬門檻：任何一格是 todo / low 都不准送出（解析結果不會直接生效）。
export function pendingCells(audit) {
  const out = [];
  for (const b of BLOCKS) {
    const blk = audit?.blocks?.[b.id];
    if (!blk) continue;
    const cols = fieldsOf(b);
    const push = (state, key, rowIdx, rowKey) => {
      if (state !== 'todo' && state !== 'low') return;
      const col = cols.find((c) => c.key === key);
      out.push({ block: b.id, blockLabel: b.label, row: rowIdx, rowKey, key, label: col?.label || key, state });
    };
    if (b.kind === 'form') {
      for (const [k, m] of Object.entries(blk.meta || {})) push(m?.state, k, null, null);
    } else {
      (blk.rows || []).forEach((r, i) => {
        for (const [k, m] of Object.entries(r.meta || {})) push(m?.state, k, i, b.keyColumn ? r.values?.[b.keyColumn] : null);
      });
    }
  }
  return out;
}

// 各區塊的填寫概況，給導覽的徽章與進度用
export function blockStats(audit) {
  const out = {};
  for (const b of BLOCKS) {
    const blk = audit?.blocks?.[b.id];
    const cols = fieldsOf(b);
    const required = cols.filter((c) => c.required && !c.computed);
    let rows = 0, filled = 0, missing = 0, todo = 0, low = 0;
    const tally = (values, meta) => {
      for (const c of required) { if (values?.[c.key] === undefined || values?.[c.key] === '') missing++; }
      for (const m of Object.values(meta || {})) {
        if (m?.state === 'todo') todo++;
        else if (m?.state === 'low') low++;
      }
      for (const c of cols) if (values?.[c.key] !== undefined && values?.[c.key] !== '') filled++;
    };
    if (b.kind === 'form') { rows = blk?.values && Object.keys(blk.values).length ? 1 : 0; tally(blk?.values, blk?.meta); }
    else { rows = (blk?.rows || []).length; for (const r of blk?.rows || []) tally(r.values, r.meta); }
    out[b.id] = { rows, filled, missing, todo, low };
  }
  return out;
}
