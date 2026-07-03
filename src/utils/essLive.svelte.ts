// 儲能櫃即時資料層：橋接 API 輪詢（Svelte 5 runes）＋ formatter ＋ scenario 覆蓋。
// 三態：loading（維持 JSON 的 — 佔位）／live（真實 Modbus 讀值，綠）／demo（展示資料，琥珀）。
// 誠實原則：只有 API source==='live' 才算即時；source==='sim' 與連線失敗一律展示資料。
import { ESS_DEMO, type EssData } from './essDemo';

export type EssStatus = 'loading' | 'live' | 'demo';

const API_BASE: string = (import.meta.env.PUBLIC_ESS_API as string | undefined) ?? 'https://ems-api.crinhealthcare.org';
const POLL_MS = 5000;
const FETCH_TIMEOUT_MS = 3000;

export interface EssPoller { readonly status: EssStatus; readonly data: EssData | null; readonly ts: string; start(): () => void; }

export function createEssPoller(): EssPoller {
  let status = $state<EssStatus>('loading');
  let data = $state<EssData | null>(null);
  let ts = $state('');

  async function tick() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${API_BASE}/api/ess`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(String(res.status));
      const snap = await res.json();
      if (!snap.ok || !snap.data) throw new Error('no data');
      data = snap.data;
      ts = snap.ts ?? '';
      status = snap.source === 'live' ? 'live' : 'demo'; // sim 也視為展示
    } catch {
      data = ESS_DEMO;
      ts = '';
      status = 'demo';
    }
  }

  return {
    get status() { return status; },
    get data() { return data; },
    get ts() { return ts; },
    start() {
      tick();
      const id = setInterval(tick, POLL_MS);
      return () => clearInterval(id);
    },
  };
}

// ── formatter（live/demo 共用；輸出對應 803.json 佔位格式，每行控制在 tank 寬度內）──

const OPERATION: Record<number, string> = { 0: '關機', 1: '運行', 2: '待命' };   // §9.1
const MODE: Record<number, string> = { 0: '待機', 1: '自動', 2: '充電', 3: '放電' }; // §9.2
const hexOrNone = (w: number) => (w ? '0x' + w.toString(16).toUpperCase() : '無');
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const n0 = (v: number) => Math.round(v).toString();

type Tone = 'ok' | 'warn' | 'alert' | 'off';
type Flag = { label: string; tone: Tone };

// 狀態 pills：運轉/併網（或離網）/警報/故障——狀態靠圖示＋文字，數值格一律墨色（dataviz：text wears text tokens）
function flagsPeace(d: EssData): Flag[] {
  return [
    { label: `運轉 ${OPERATION[d.system.operation] ?? d.system.operation}`, tone: d.system.operation === 1 ? 'ok' : 'off' },
    { label: d.system.gridSwitch === 1 ? '併網' : '解聯', tone: d.system.gridSwitch === 1 ? 'ok' : 'warn' },
    { label: `模式 ${MODE[d.system.mode] ?? d.system.mode}`, tone: 'off' },
    { label: `警報 ${hexOrNone(d.system.alarmWord)}`, tone: d.system.alarmWord ? 'alert' : 'ok' },
  ];
}
function flagsWar(d: EssData): Flag[] {
  return [
    { label: d.system.offGridState === 0 ? '併網' : '離網運行', tone: d.system.offGridState === 0 ? 'warn' : 'ok' },
    { label: `故障 ${hexOrNone(d.pcs.faultFlags)}`, tone: d.pcs.faultFlags ? 'alert' : 'ok' },
    { label: `警報 ${hexOrNone(d.system.alarmWord)}`, tone: d.system.alarmWord ? 'alert' : 'ok' },
  ];
}

export function formatStorePeace(d: EssData) {
  return {
    cap: '',
    pct: Math.round(d.battery.socPct),
    state: '',
    flags: flagsPeace(d),
    metrics: [
      { k: '可放電', v: `${n0(d.battery.dischargeCapAh)} Ah` },
      { k: 'SOH', v: `${n1(d.battery.sohPct)}%` },
      { k: '充電', v: `${n1(Math.max(d.pcs.batteryPowerKw, 0))} kW` },
      { k: '今日充電', v: `${n0(d.pcs.dailyChargeKwh)} kWh` },
      { k: '可用充電', v: `${n0(d.system.availChargeKw)} kW` },
      { k: '可用放電', v: `${n0(d.system.availDischargeKw)} kW` },
      { k: '電池電壓', v: `${n0(d.battery.voltageV)} V` },
      { k: '電池電流', v: `${n1(d.battery.currentA)} A` },
      { k: '電池溫度', v: `${n1(d.battery.maxTempC)} ℃` },
      { k: '循環次數', v: `${n0(d.battery.cycleCount)} 次` },
      { k: '櫃內溫度', v: `${n1(d.system.cabinetTempC)} ℃` },
      { k: '櫃內濕度', v: `${n0(d.system.cabinetRhPct)}%` },
    ],
  };
}

export function formatStoreWar(d: EssData) {
  const endur = computeEndurance(d);
  const p = d.pcs.activePowerKw; // 放正充負（§5）
  return {
    cap: '',
    pct: Math.round(d.battery.socPct),
    days: endur.days || '— 小時',
    state: '',
    flags: flagsWar(d),
    metrics: [
      { k: '可放電', v: `${n0(d.battery.dischargeCapAh)} Ah` },
      { k: 'SOC 下限', v: `${n0(d.system.socMinPct)}%` },
      { k: p >= 0 ? '放電功率' : '充電功率', v: `${n1(Math.abs(p))} kW` },
      { k: '可用放電', v: `${n0(d.system.availDischargeKw)} kW` },
      { k: '輸出電壓', v: `${n0(d.pcs.loadVoltageV)} V` },
      { k: '輸出頻率', v: `${n0(d.pcs.loadFreqHz)} Hz` },
      { k: '功率因數', v: d.pcs.pf.toFixed(2) },
      { k: '轉換效率', v: `${n0(d.pcs.efficiencyPct)}%` },
      { k: '今日放電', v: `${n0(d.pcs.dailyDischargeKwh)} kWh` },
      { k: 'IGBT 溫度', v: `${n1(d.pcs.igbtTempC)} ℃` },
      { k: '電池電流', v: `${n1(d.battery.currentA)} A` },
      { k: '電池溫度', v: `${n1(d.battery.maxTempC)} ℃` },
    ],
  };
}

// 續航＝可放電容量 Ah × 電池電壓 V ÷ 負載 kW；餘裕%＝SOC 對可用區間（100−SOC下限）
export function computeEndurance(d: EssData) {
  const loadKw = Math.abs(d.meters.load.powerKw);
  if (!loadKw || !d.battery.dischargeCapAh || !d.battery.voltageV) return { days: '', pct: '' };
  const hours = (d.battery.dischargeCapAh * d.battery.voltageV) / 1000 / loadKw;
  const pct = Math.max(0, Math.round(((d.battery.socPct - d.system.socMinPct) / (100 - d.system.socMinPct)) * 100));
  return { days: `${n1(hours)} 小時`, pct: `${pct}%` };
}

export function formatSupplyValue(d: EssData, war: boolean) {
  if (war) return `負載 ${n1(Math.abs(d.meters.load.powerKw))} kW`;
  // batteryPowerKw 充正放負（§5）
  return d.pcs.batteryPowerKw > 0.1 ? `充電 ${n1(d.pcs.batteryPowerKw)} kW` : '待命';
}

export function formatDeviceReading(d: EssData) {
  const g = d.meters.grid, l = d.meters.load;
  const grid = d.system.offGridState === 0 ? '併網' : '離網';
  return `負載 ${n1(l.powerKw)}kW·${n0(l.voltageV)}V·${n1(l.currentA)}A ｜ 市電 ${n1(g.powerKw)}kW·${n0(g.voltageV)}V·${n1(g.currentA)}A·${n0(g.freqHz)}Hz·${grid} ｜ 電池 SOC ${n0(d.battery.socPct)}%·SOH ${n1(d.battery.sohPct)}%·可放電 ${n0(d.battery.dischargeCapAh)}Ah·溫 ${n1(d.battery.maxTempC)}℃`;
}

// ── scenario / devices 覆蓋：凡 live==='ess' 的項以 formatter 結果取代；data 為 null（loading）原樣返回 ──

export function applyEssToScenario<T extends Record<string, any>>(scenario: T, data: EssData | null, war: boolean): T {
  if (!data) return scenario;
  const storeFmt = war ? formatStoreWar(data) : formatStorePeace(data);
  const out: any = { ...scenario };
  if (Array.isArray(scenario.supply)) {
    out.supply = scenario.supply.map((s: any) => (s.live === 'ess' ? { ...s, value: formatSupplyValue(data, war) } : s));
  }
  if (Array.isArray(scenario.store)) {
    out.store = scenario.store.map((st: any) => (st.live === 'ess' ? { ...st, ...storeFmt } : st));
  }
  if (war && scenario.endur?.live === 'ess') {
    const e = computeEndurance(data);
    if (e.days) out.endur = { ...scenario.endur, ...e };
  }
  return out;
}

export function applyEssToDevices<T extends Record<string, any>>(devices: T[], data: EssData | null): T[] {
  if (!data) return devices;
  return devices.map((v) => (v.live === 'ess' ? { ...v, reading: formatDeviceReading(data) } : v));
}
