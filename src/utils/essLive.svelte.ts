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

export function formatStorePeace(d: EssData) {
  return {
    cap: `SOC ${n0(d.battery.socPct)}% · 可放電 ${n0(d.battery.dischargeCapAh)} Ah`,
    pct: Math.round(d.battery.socPct),
    state: `${OPERATION[d.system.operation] ?? d.system.operation}·${d.system.gridSwitch === 1 ? '併網' : '解聯'}`,
    metrics: [
      `模式 ${MODE[d.system.mode] ?? d.system.mode} · 警報 ${hexOrNone(d.system.alarmWord)}`,
      `SOH ${n1(d.battery.sohPct)}% · 循環 ${n0(d.battery.cycleCount)} 次`,
      `電池 ${n0(d.battery.voltageV)}V·${n1(d.battery.currentA)}A·${n1(d.battery.maxTempC)}℃`,
      `充電 ${n1(Math.max(d.pcs.batteryPowerKw, 0))}kW · 今日充 ${n0(d.pcs.dailyChargeKwh)}kWh`,
      `可用充/放 ${n0(d.system.availChargeKw)} / ${n0(d.system.availDischargeKw)} kW`,
      `櫃內 ${n1(d.system.cabinetTempC)}℃ · 濕度 ${n0(d.system.cabinetRhPct)}%`,
    ],
  };
}

export function formatStoreWar(d: EssData) {
  const endur = computeEndurance(d);
  return {
    cap: `SOC ${n0(d.battery.socPct)}% · 可放電 ${n0(d.battery.dischargeCapAh)} Ah`,
    pct: Math.round(d.battery.socPct),
    days: endur.days ? `續航 ${endur.days}` : '續航 — 小時',
    state: d.system.offGridState === 0 ? '併網' : '離網',
    metrics: [
      `故障 ${hexOrNone(d.pcs.faultFlags)} · 警報 ${hexOrNone(d.system.alarmWord)}`,
      // PCS 有功功率放正充負（§5）：依符號標示放電/充電
      d.pcs.activePowerKw >= 0
        ? `放電 ${n1(d.pcs.activePowerKw)}kW · 可用 ${n0(d.system.availDischargeKw)}kW`
        : `充電 ${n1(-d.pcs.activePowerKw)}kW · 可用 ${n0(d.system.availDischargeKw)}kW`,
      `電池 ${n0(d.battery.voltageV)}V·${n1(d.battery.currentA)}A·${n1(d.battery.maxTempC)}℃`,
      `輸出 ${n0(d.pcs.loadVoltageV)}V·${n0(d.pcs.loadFreqHz)}Hz·PF ${d.pcs.pf.toFixed(2)}`,
      `今日放 ${n0(d.pcs.dailyDischargeKwh)}kWh · 效率 ${n0(d.pcs.efficiencyPct)}%`,
      `SOC下限 ${n0(d.system.socMinPct)}% · IGBT ${n1(d.pcs.igbtTempC)}℃`,
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
