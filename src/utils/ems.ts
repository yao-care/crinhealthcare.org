/**
 * EMS 看板共用的「資料 → 呈現」規則（集中於此，輸入資料即固定呈現；元件/看詳情頁共用）。
 * 顏色一律回傳 OKLCH token 變數，不寫死 hex。
 */

export type Severity = 'ok' | 'warn' | 'crit';

/** 環境分級可選的 per-hospital 覆寫（不給則用下方標準預設） */
export interface EnvBands {
  temp?: { ok: [number, number]; crit: [number, number] };
  rh?: { ok: [number, number]; crit: [number, number] };
  co2?: { okMax: number; critMax: number };
}

/**
 * ① 供給端異常 → 紅底。
 * 供電值是異質字串（度/年、kW、中斷…）無法統一門檻，故以資料上的 warn 旗標為準（輸入資料時設定）。
 */
export function isSupplyAbnormal(s: { warn?: boolean }): boolean {
  return s?.warn === true;
}

/**
 * ② 使用端每日 bar chart：依高度將「前三高」標不同色（金/銀/銅 名次），其餘用基準色。
 * 註：警示紅已是「異常」語意，前三高不用紅，避免撞色。回傳與輸入等長的 fill 陣列(token)。
 */
// 混色一律 in oklab：--color-paper 是 oklch(1 0 0)（白，但色相寫成 0＝紅），
// 在 oklch 極座標混色會把色相往紅拉 —— 這條「淡藍綠」基準色原本會渲染成淡紫。
const BAR_BASE = 'color-mix(in oklab, var(--color-primary) 26%, var(--color-paper))'; // 基準：淡藍綠
const BAR_TOP3 = [
  'var(--color-energy)', // 第1高：金
  'color-mix(in oklab, var(--color-text-secondary) 48%, var(--color-paper))', // 第2高：銀
  'color-mix(in oklab, var(--color-energy) 72%, var(--color-alert) 28%)', // 第3高：銅（金偏橘棕，非異常紅）
];
export function barFills(daily: number[]): string[] {
  const n = daily?.length ?? 0;
  if (!n) return [];
  const rank = new Array(n).fill(-1);
  const order = daily.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  for (let r = 0; r < Math.min(3, n); r++) rank[order[r].i] = r;
  return daily.map((_, i) => (rank[i] >= 0 ? BAR_TOP3[rank[i]] : BAR_BASE));
}

/**
 * ③ 環境參數異常 → 標準分級底色（ok 無 / warn 琥珀 / crit 紅）。
 * 標準帶（醫院室內環境）：
 *  - 溫度 ok 20–28°C：衛福部《醫療機構設置標準》(手術室/加護病房/產房/嬰兒室 20–28°C)，28°C 亦為節能室溫上限。
 *  - 濕度 ok 40–60%：ASHRAE 舒適/防霉(過乾<30 靜電・呼吸道；過濕>70 黴菌)。OR/ICU 依設置標準可放寬至 50–80。
 *  - CO₂ ok ≤800ppm(良好通風)；>1000ppm 超出《室內空氣品質標準》法規上限(8h 均值，醫療機構為強制管理場所)。
 * 規則：ok 帶內=ok；ok 與 crit 帶之間=warn；crit 帶外=crit。CO₂ 只看上限。
 */
// 一般樓層
const STD_BANDS: Required<EnvBands> = {
  temp: { ok: [20, 28], crit: [18, 30] },
  rh: { ok: [40, 60], crit: [30, 70] },
  co2: { okMax: 800, critMax: 1000 },
};
// 關鍵區域（ICU/手術室/產房/嬰兒室）：濕度依《醫療機構設置標準》放寬為 50–80%；溫度/CO₂ 同。
const CRITICAL_BANDS: Required<EnvBands> = {
  temp: { ok: [20, 28], crit: [18, 30] },
  rh: { ok: [50, 80], crit: [40, 90] },
  co2: { okMax: 800, critMax: 1000 },
};
export function envSeverity(
  metric: 'temp' | 'rh' | 'co2',
  valStr: string,
  opts?: { critical?: boolean; override?: EnvBands },
): Severity {
  const v = parseFloat(valStr);
  if (isNaN(v)) return 'ok';
  const base = opts?.critical ? CRITICAL_BANDS : STD_BANDS;

  if (metric === 'co2') {
    const b = opts?.override?.co2 ?? base.co2;
    if (v > b.critMax) return 'crit';
    if (v > b.okMax) return 'warn';
    return 'ok';
  }

  const b = opts?.override?.[metric] ?? base[metric];
  if (v < b.crit[0] || v > b.crit[1]) return 'crit';
  if (v < b.ok[0] || v > b.ok[1]) return 'warn';
  return 'ok';
}

// ── 戰時供電（行動儲電櫃）彙總 ────────────────────────────────────────────
// 唯一計算源：JSON 只存「儲電櫃規格」與「各設備台數×每台瓦數」，
// 總負載／各區用電／負載率／裕度／續航一律由這裡算，看板與配置圖共用同一份結果
// （分開各算會出現「配置圖 69 小時、五區塊撐 —」這種自打嘴巴）。
export interface WarPowerPart { zone?: string; n?: string; qty: number; w: number; flat?: boolean }
export interface WarPowerLoad { name: string; parts: WarPowerPart[] }
export interface WarPowerCabinet { name: string; kwh: number; kw: number; out?: string; loc?: string; state?: string }
export interface WarPowerMobile { name: string; qty?: number; zone?: string; use?: string; spec?: string; state?: string }
export interface WarPower { title?: string; note?: string; usablePct?: number; cabinets: WarPowerCabinet[]; mobile?: WarPowerMobile[]; loads: WarPowerLoad[] }

export interface WarPowerSummary {
  totalKw: number;      // 目前總負載
  capKw: number;        // 儲電櫃額定輸出合計
  capKwh: number;       // 儲電櫃額定容量合計
  usableKwh: number;    // 扣 SOC 下限後的可用電量
  marginKw: number;     // 設備裕度（還能再接多少）
  loadPct: number;      // 負載率
  hours: number;        // 依現況負載可用多久
  byZone: Map<string, number>;  // 各區用電（W）
}

export function warPowerSummary(p?: WarPower | null): WarPowerSummary | null {
  if (!p?.loads?.length || !p?.cabinets?.length) return null;
  const byZone = new Map<string, number>();
  let totalW = 0;
  for (const l of p.loads) {
    for (const part of l.parts) {
      const w = part.qty * part.w;
      totalW += w;
      if (part.zone) byZone.set(part.zone, (byZone.get(part.zone) ?? 0) + w);
    }
  }
  const capKw = p.cabinets.reduce((s, c) => s + c.kw, 0);
  const capKwh = p.cabinets.reduce((s, c) => s + c.kwh, 0);
  const usableKwh = (capKwh * (p.usablePct ?? 100)) / 100;
  const totalKw = totalW / 1000;
  return {
    totalKw, capKw, capKwh, usableKwh,
    marginKw: capKw - totalKw,
    loadPct: capKw ? (totalKw / capKw) * 100 : 0,
    hours: totalKw ? usableKwh / totalKw : 0,
    byZone,
  };
}

// 續航顯示：≥48h 以「X 天 Y 小時」讀，較短就直接給小時（戰情室要一眼看懂還能撐多久）
export function endurText(hours: number): string {
  if (!hours || !isFinite(hours)) return '—';
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} 小時`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h ? `${d} 天 ${h} 小時` : `${d} 天`;
}
