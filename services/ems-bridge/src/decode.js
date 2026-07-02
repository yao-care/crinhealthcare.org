// 純解碼函式（零 I/O，可單測）：raw 暫存器字組 → 語意化 EssData。
import { FIELDS } from './registers.js';

export const u16 = (w) => w & 0xffff;
export const i16 = (w) => ((w & 0xffff) << 16) >> 16; // 二補數（§13.9）
export const u32le = (lo, hi) => ((hi & 0xffff) * 0x10000 + (lo & 0xffff)) >>> 0; // Lo word 先（§13.8）

function fieldValue(raw, spec) {
  const block = raw[spec.block];
  if (!block) return null;
  let n;
  if (spec.type === 'u32le') n = u32le(block[spec.offset], block[spec.offset + 1]);
  else if (spec.type === 'i16') n = i16(block[spec.offset]);
  else n = u16(block[spec.offset]);
  return spec.scale === 1 ? n : n / spec.scale;
}

/**
 * @param {Record<string, number[]>} raw 讀取計劃各塊的字組陣列
 * @returns {object} EssData（工程單位）
 */
export function decode(raw) {
  const f = {};
  for (const [name, spec] of Object.entries(FIELDS)) f[name] = fieldValue(raw, spec);
  return {
    system: {
      operation: f.batteryOperation,       // §9.1
      mode: f.batteryMode,                 // §9.2
      gridSwitch: f.gridSwitch,            // 0=斷開 1=閉合
      offGridState: f.offGridState,        // 0=併網 非0=離網
      alarmWord: f.alarmWord,
      availChargeKw: f.availChargeKw,
      availDischargeKw: f.availDischargeKw,
      cabinetTempC: f.cabinetTempC,
      cabinetRhPct: f.cabinetRhPct,
      socMinPct: f.socMinPct,
    },
    battery: {
      socPct: f.socPct,
      voltageV: f.batteryVoltageV,
      currentA: f.batteryCurrentA,         // 充正放負
      sohPct: f.sohPct,
      maxTempC: f.batteryMaxTempC,
      dischargeCapAh: f.dischargeCapAh,
      chargeCapAh: f.chargeCapAh,
      cycleCount: f.cycleCount,
      chargerKw: f.chargerKw,
    },
    pcs: {
      activePowerKw: f.pcsActivePowerKw,   // 放正充負
      batteryPowerKw: f.batteryPowerKw,    // 充正放負
      pf: f.pcsPf,
      loadVoltageV: f.loadVoltageV,
      loadFreqHz: f.loadFreqHz,
      igbtTempC: f.igbtTempC,
      dailyChargeKwh: f.dailyChargeKwh,
      dailyDischargeKwh: f.dailyDischargeKwh,
      totalChargeKwh: f.totalChargeKwh,
      totalDischargeKwh: f.totalDischargeKwh,
      efficiencyPct: f.efficiencyPct,
      faultFlags: f.pcsFaultFlags,
    },
    meters: {
      grid: { powerKw: f.gridPowerKw, voltageV: f.gridVoltageV, currentA: f.gridCurrentA, freqHz: f.gridFreqHz },
      load: { powerKw: f.loadPowerKw, voltageV: f.loadMeterV, currentA: f.loadCurrentA, freqHz: f.loadMeterHz },
      ess: { powerKw: f.essPowerKw, voltageV: f.essVoltageV, currentA: f.essCurrentA, freqHz: f.essFreqHz },
    },
  };
}
