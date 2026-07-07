// 削峰填谷 / 需量控制 模擬資料層（比照 essDemo：假資料先行、之後可無縫換橋接 API 真值）。
// 誠實原則：PV 為 803「規劃中」、行動儲電櫃為小型設備 → 本表為「展示資料（what-if）」，畫面以 ● 標示。
// 電價/時段/24h profile/省錢公式全部集中於此，日後改真值只動這一檔。

// ── 台電 高壓三段式時間電價（夏月 5/16–10/15，平日）──
// 時段：離峰 00–09｜半尖峰 09–16、22–24｜尖峰 16–22
// 費率（元/度）為「以台電 114/10 電價表為基準」之示意值，上線前依實際契約種類核對。
export type Band = 'off' | 'mid' | 'peak';
export const TARIFF: Record<Band, { label: string; price: number; tone: string }> = {
  off: { label: '離峰', price: 2.54, tone: 'accent' },   // 00–09
  mid: { label: '半尖峰', price: 5.8, tone: 'energy' },  // 09–16, 22–24
  peak: { label: '尖峰', price: 9.39, tone: 'alert' },   // 16–22
};
export function bandOfHour(h: number): Band {
  if (h >= 16 && h < 22) return 'peak';
  if (h >= 9 && h < 16) return 'mid';
  if (h >= 22) return 'mid';
  return 'off'; // 00–09
}

export interface HourPoint {
  h: number;          // 0..23
  band: Band;
  price: number;      // 元/度
  load: number;       // 醫院負載 kW
  pv: number;         // 太陽能發電 kW
  charge: number;     // 儲電櫃充電 kW（離峰，向電池）
  discharge: number;  // 儲電櫃放電 kW（尖峰，出電池）
  grid: number;       // 向台電購電 kW = load − pv − discharge + charge（夾 ≥0）
  soc: number;        // 電池 SOC %
}
export interface PeakShaveData {
  hours: HourPoint[];
  nowHour: number;    // 目前時刻（小時，含小數）
  kpi: {
    pvKwh: number;        // 今日綠電
    gridKwh: number;      // 今日台電購電
    chargeKwh: number;    // 離峰充電（00–09）
    dischargeKwh: number; // 尖峰放電（16–22）
    saveNtd: number;      // 今日省下電費
    peakCutKw: number;    // 尖峰時段最大削減功率
  };
  source: 'sim';
}

// ── 基準 24h 曲線（kW）：可調參數集中於此 ──
// 醫院負載：日間/傍晚雙峰；PV：規劃屋頂陣列鐘形；儲電櫃：離峰充、尖峰放（能量約 100 kWh/日）
const LOAD = [520, 500, 485, 480, 480, 500, 560, 640, 720, 780, 820, 840, 835, 820, 800, 790, 810, 860, 880, 850, 780, 700, 620, 560];
const PV   = [0, 0, 0, 0, 0, 0, 10, 45, 95, 140, 170, 185, 185, 170, 140, 95, 45, 10, 0, 0, 0, 0, 0, 0];
const CHG  = [13, 13, 13, 13, 12, 12, 12, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 00–08 充 ≈100 kWh
const DIS  = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 45, 30, 15, 7, 3, 0, 0, 0];       // 16–20 放 ≈100 kWh
const BATT_KWH = 104; // 行動儲電櫃可用容量（示意）
const SOC_MIN = 18;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 隨機游走用微幅擾動（界限夾制，沿用儲電櫃長時間飄移的教訓）：以 phase 產生確定性小波動
function jitter(base: number, h: number, phase: number, amp: number) {
  const w = Math.sin((h * 0.7 + phase) * 1.3) * 0.6 + Math.sin((h * 1.9 + phase) * 0.7) * 0.4;
  return base * (1 + w * amp);
}

export function buildPeakShave(nowHour: number, phase = 0): PeakShaveData {
  // SOC 逐時累積（充 +、放 −），起點 SOC_MIN
  let energy = (SOC_MIN / 100) * BATT_KWH;
  const hours: HourPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const band = bandOfHour(h);
    const price = TARIFF[band].price;
    const load = Math.round(clamp(jitter(LOAD[h], h, phase, 0.03), 400, 1000));
    const pv = Math.round(clamp(jitter(PV[h], h, phase, 0.06), 0, 260));
    const charge = CHG[h];
    const discharge = DIS[h];
    energy = clamp(energy + charge - discharge, (SOC_MIN / 100) * BATT_KWH, BATT_KWH);
    const soc = Math.round((energy / BATT_KWH) * 100);
    const grid = Math.round(clamp(load - pv - discharge + charge, 0, 2000));
    hours.push({ h, band, price, load, pv, charge, discharge, grid, soc });
  }

  // KPI（今日累計；逐時 kW≈kWh，因步距 1h）
  const sum = (f: (p: HourPoint) => number) => hours.reduce((a, p) => a + f(p), 0);
  const pvKwh = sum((p) => p.pv);
  const gridKwh = sum((p) => p.grid);
  const chargeKwh = sum((p) => p.charge);
  const dischargeKwh = sum((p) => p.discharge);
  // 省錢＝尖峰放電折抵(當時電價) − 離峰充電成本 + PV 自用折抵(當時電價) − 循環損耗(約 8%)
  const arbitrage = sum((p) => p.discharge * p.price) - sum((p) => p.charge * p.price);
  const pvSave = sum((p) => p.pv * p.price);
  const saveNtd = Math.round((arbitrage + pvSave) * 0.92);
  const peakCutKw = Math.max(...hours.filter((p) => p.band === 'peak').map((p) => p.pv + p.discharge), 0);

  return {
    hours,
    nowHour,
    kpi: { pvKwh, gridKwh, chargeKwh, dischargeKwh, saveNtd, peakCutKw: Math.round(peakCutKw) },
    source: 'sim',
  };
}

// 展示用固定快照（SSR / loading 佔位；nowHour 用中午，hydration 後由 client 時鐘接手）
export const PEAK_SHAVE_DEMO: PeakShaveData = buildPeakShave(13, 0);
