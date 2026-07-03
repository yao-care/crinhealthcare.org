// 模擬器：與 modbusClient 同介面（readAll → raw 字組）。
// 產「原始暫存器字組」而非解碼值：sim 模式會走完整 decode 路徑，等於持續驗證解碼器。
import { FIELDS } from './registers.js';

const encI16 = (n) => n < 0 ? (n + 0x10000) & 0xffff : n & 0xffff;

// 工程值起點：平時併網充電情境（合理值，僅供展示/測試）
const initial = {
  batteryOperation: 1, batteryMode: 2, gridSwitch: 1, offGridState: 0, alarmWord: 0,
  availChargeKw: 25.0, availDischargeKw: 50.0, cabinetTempC: 25.0, cabinetRhPct: 60.0, socMinPct: 10.0,
  socPct: 86, batteryVoltageV: 360.0, batteryCurrentA: 34.7, sohPct: 98.0, batteryMaxTempC: 26.5,
  chargerKw: 3.2, dischargeCapAh: 280.0, chargeCapAh: 45.0, cycleCount: 37,
  pcsFaultFlags: 0, pcsActivePowerKw: -12.3, pcsPf: 0.98, loadVoltageV: 380.5, loadFreqHz: 60.0,
  batteryPowerKw: 12.5, igbtTempC: 41.2, totalChargeKwh: 1234.5, totalDischargeKwh: 1102.3,
  dailyChargeKwh: 42.0, dailyDischargeKwh: 18.6, efficiencyPct: 95.0,
  gridPowerKw: 152.3, gridVoltageV: 380.2, gridCurrentA: 231.4, gridFreqHz: 60.0,
  loadPowerKw: 160.1, loadMeterV: 380.0, loadCurrentA: 243.2, loadMeterHz: 60.0,
  essPowerKw: -12.3, essVoltageV: 380.5, essCurrentA: 18.7, essFreqHz: 60.0,
};

// 會隨機游走的欄位（幅度＝每拍最大變化量）
const drift = {
  socPct: 0.4, batteryCurrentA: 1.5, batteryMaxTempC: 0.2, chargerKw: 0.15,
  pcsActivePowerKw: 0.6, batteryPowerKw: 0.6, igbtTempC: 0.4,
  gridPowerKw: 3, loadPowerKw: 3, essPowerKw: 0.6,
  gridCurrentA: 4, loadCurrentA: 4, essCurrentA: 0.8,
  dailyChargeKwh: 0.05, cabinetTempC: 0.1, loadVoltageV: 0.8, gridVoltageV: 0.8, loadMeterV: 0.8, essVoltageV: 0.8,
};

// 游走界限：長時間運行不可飄出合理範圍（k → [min, max]）
const bounds = {
  socPct: [20, 97], batteryCurrentA: [20, 50], batteryMaxTempC: [22, 35], chargerKw: [2, 5],
  pcsActivePowerKw: [-20, -5], batteryPowerKw: [5, 20], igbtTempC: [30, 55],
  gridPowerKw: [120, 210], loadPowerKw: [120, 210], essPowerKw: [-20, -5],
  gridCurrentA: [180, 320], loadCurrentA: [180, 320], essCurrentA: [8, 35],
  dailyChargeKwh: [0, 200], cabinetTempC: [20, 32],
  loadVoltageV: [370, 390], gridVoltageV: [370, 390], loadMeterV: [370, 390], essVoltageV: [370, 390],
};

export function createSimulator({ readPlan }) {
  const state = { ...initial };

  function tick() {
    for (const [k, amp] of Object.entries(drift)) {
      state[k] += (Math.random() * 2 - 1) * amp;
      const b = bounds[k];
      if (b) state[k] = Math.min(b[1], Math.max(b[0], state[k]));
    }
  }

  return {
    async readAll() {
      tick();
      const raw = {};
      for (const seg of readPlan) raw[seg.key] = new Array(seg.len).fill(0);
      for (const [name, spec] of Object.entries(FIELDS)) {
        const block = raw[spec.block];
        if (!block) continue;
        const scaled = Math.round(state[name] * spec.scale);
        if (spec.type === 'u32le') {
          block[spec.offset] = scaled & 0xffff;          // Lo word 先
          block[spec.offset + 1] = (scaled >>> 16) & 0xffff;
        } else if (spec.type === 'i16') {
          block[spec.offset] = encI16(scaled);
        } else {
          block[spec.offset] = scaled & 0xffff;
        }
      }
      return raw;
    },
    close() {},
  };
}
