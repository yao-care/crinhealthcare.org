// 能源診斷問卷（表A 冰水主機／表E 能源設備盤查／表P 用電統計）的欄位 ↔ 儲存格對照。
//
// 這份表是唯一真實來源：匯入(xlsx→JSON)、匯出(JSON→xlsx)、zod schema、表單標籤全部由它推導，
// 所以欄位定義「就是照活頁簿長的」，不會有兩份各自漂移。
//
// 座標怎麼來的（都由 V2 範本量出，不是抄的）：
//   表A：每台設備佔 3 欄（D-F, G-I, J-L, M-O, P-R, S-U）＝ 6 台；欄位在列 2–17。
//   表E：欄位在欄 C–N，紀錄在列 5–54（50 筆）；M/N 是公式。
//   表P：表頭在列 3/5，月份在列 8–19（1–12月）；H/M/R/T 是公式。
//
// type 說明：
//   'text'    → 字串原樣進出（電號、統編這種前導零不能被數字化）
//   'number'  → 寫回 xlsx 必須是數值格，否則 =SUM()/=MAX() 會把它當 0
//   'percent' → 使用者填 60（代表 60%），xlsx 那格是 0% 格式所以存 0.6；讀回再 ×100 還原
//
// 業主 2026-08-12 指示：原本 7 個下拉（表A 4／表P 3）改為自由填寫，不做 enum 限制。

export const SHEET_A = '表A 冰水主機';
export const SHEET_E = '表E｜能源設備盤查';
export const SHEET_P = '表P｜用電統計';

// ── 表A：冰水主機 ──（每台一欄區塊）
export const CHILLER_FIRST_COL = 4;   // D
export const CHILLER_COL_SPAN = 3;    // 每台佔 D-F 三欄，值寫最左欄
export const CHILLER_MAX = 6;

export const CHILLER_FIELDS = [
  { key: 'systemName', row: 2, type: 'text', required: true, label: '系統名稱' },
  { key: 'deviceNo', row: 3, type: 'text', required: true, label: '設備編號' },
  { key: 'capacityRt', row: 4, type: 'text', required: true, label: '設備容量(RT)', hint: '選最接近且不高於實際數的值，例如 390 填 380' },
  { key: 'age', row: 5, type: 'text', required: true, label: '機齡' },
  { key: 'originType', row: 6, type: 'text', required: true, label: '產地/型式/定變頻' },
  { key: 'maintenance', row: 7, type: 'text', required: true, label: '保養等級', hint: '良好（例行確實）／一般（間歇保養）／欠佳（少保養無水處理）' },
  { key: 'chilledOutSpring', row: 8, type: 'number', label: '冰水出水溫度 春季(3-5月)' },
  { key: 'chilledOutSummer', row: 9, type: 'number', label: '冰水出水溫度 夏季(6-8月)' },
  { key: 'chilledOutAutumn', row: 10, type: 'number', label: '冰水出水溫度 秋季(9-11月)' },
  { key: 'chilledOutWinter', row: 11, type: 'number', label: '冰水出水溫度 冬季(12-2月)' },
  { key: 'coolingInSpring', row: 12, type: 'number', label: '冷卻水回水溫度 春季(3-5月)' },
  { key: 'coolingInSummer', row: 13, type: 'number', label: '冷卻水回水溫度 夏季(6-8月)' },
  { key: 'coolingInAutumn', row: 14, type: 'number', label: '冷卻水回水溫度 秋季(9-11月)' },
  { key: 'coolingInWinter', row: 15, type: 'number', label: '冷卻水回水溫度 冬季(12-2月)' },
  { key: 'roomTemp', row: 16, type: 'number', required: true, label: '室內或特定控溫空間的溫度' },
  { key: 'roomHumidity', row: 17, type: 'percent', required: true, label: '室內或特定控溫空間的濕度' },
];

// ── 表E：能源設備盤查 ──（一列一筆設備）
export const INVENTORY_FIRST_ROW = 5;
export const INVENTORY_MAX = 50;      // 列 5–54

export const INVENTORY_FIELDS = [
  { key: 'system', col: 3, type: 'text', required: true, label: '系統類別' },
  { key: 'name', col: 4, type: 'text', required: true, label: '設備名稱' },
  { key: 'deviceNo', col: 5, type: 'text', required: true, label: '設備編號' },
  { key: 'madeYear', col: 6, type: 'text', required: true, label: '製造年份（西元年）' },
  { key: 'capacity', col: 7, type: 'number', required: true, label: '設備容量', hint: '照銘牌數字，例如冷卻能力 200RT 就填 200' },
  { key: 'capacityUnit', col: 8, type: 'text', required: true, label: '規格單位', hint: '照銘牌單位，例如 RT' },
  { key: 'ratedKw', col: 9, type: 'number', required: true, label: '額定功率(kW)' },
  { key: 'qty', col: 10, type: 'number', required: true, label: '設備數量' },
  { key: 'loadPct', col: 11, type: 'percent', required: true, label: '負載率(%)', hint: '耗電固定填 100；會變動填實際平均；無法判斷填 60' },
  { key: 'hoursPerYear', col: 12, type: 'number', required: true, label: '年運轉時數(hr)' },
  // M（推估年用電量 =I*J*K*L）與 N（年用電佔比）是公式，不收也不寫
];

// ── 表P：用電統計 ──
export const POWER_HEADER = [
  { key: 'meterNo', cell: 'C3', type: 'text', required: true, label: '電號' },
  { key: 'tariff', cell: 'K3', type: 'text', required: true, label: '電價種類' },
  { key: 'timeType', cell: 'O3', type: 'text', required: true, label: '時間種類' },
  { key: 'hasEms', cell: 'R3', type: 'text', required: true, label: '是否導入能源管理系統' },
  { key: 'suggestedCapacity', cell: 'K5', type: 'number', required: true, label: '建議調整後契約容量(kW)' },
  { key: 'estimatedSaving', cell: 'O5', type: 'number', required: true, label: '預估可節省電費(元/年)' },
  // G3 戶名 = '表Z｜基本資料'!D3（公式，表Z 不在本次範圍）；C5:G5 用電佔比與平均電單價亦為公式
];

export const MONTH_FIRST_ROW = 8;     // 1月
export const MONTH_COUNT = 12;

export const MONTH_FIELDS = [
  { key: 'contractCapacity', col: 3, type: 'number', label: '經常契約容量(kW)' },
  { key: 'demandPeak', col: 4, type: 'number', label: '需量 尖峰(kW)' },
  { key: 'demandHalfPeak', col: 5, type: 'number', label: '需量 半尖峰(kW)' },
  { key: 'demandSatHalfPeak', col: 6, type: 'number', label: '需量 週六半尖峰(kW)' },
  { key: 'demandOffPeak', col: 7, type: 'number', label: '需量 離峰(kW)' },
  // H 最高需量 =MAX(D:G) 公式
  { key: 'usePeak', col: 9, type: 'number', label: '計費度數 尖峰(kWh)' },
  { key: 'useHalfPeak', col: 10, type: 'number', label: '計費度數 半尖峰(kWh)' },
  { key: 'useSatHalfPeak', col: 11, type: 'number', label: '計費度數 週六半尖峰(kWh)' },
  { key: 'useOffPeak', col: 12, type: 'number', label: '計費度數 離峰(kWh)' },
  // M 合計 =SUM(I:L) 公式
  { key: 'wheelPeak', col: 14, type: 'number', label: '轉供度數 尖峰(kWh)' },
  { key: 'wheelHalfPeak', col: 15, type: 'number', label: '轉供度數 半尖峰(kWh)' },
  { key: 'wheelSatHalfPeak', col: 16, type: 'number', label: '轉供度數 週六半尖峰(kWh)' },
  { key: 'wheelOffPeak', col: 17, type: 'number', label: '轉供度數 離峰(kWh)' },
  // R 用電度數合計、T 建議調整後契約容量 為公式
  { key: 'totalFee', col: 19, type: 'number', label: '總電費（含稅-元）' },
];

// 值的轉換：xlsx ↔ 表單/JSON
export function fromCell(raw, type) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (type === 'text') return String(raw);
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  // 0% 格式的格存的是小數；使用者看到的是百分比數字
  return type === 'percent' ? Math.round(n * 1000) / 10 : n;
}

export function toCell(value, type) {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'text') return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return type === 'percent' ? n / 100 : n;
}
