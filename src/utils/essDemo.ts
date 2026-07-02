// 儲能櫃「展示資料」：橋接 API 連不上時的 fallback。與 API data 同形狀，
// 值採規格書範例值＋合理情境（併網充電）。畫面一律以琥珀「● 展示資料」標示，非即時值。
export interface EssMeter { powerKw: number; voltageV: number; currentA: number; freqHz: number; }
export interface EssData {
  system: {
    operation: number; mode: number; gridSwitch: number; offGridState: number; alarmWord: number;
    availChargeKw: number; availDischargeKw: number; cabinetTempC: number; cabinetRhPct: number; socMinPct: number;
  };
  battery: {
    socPct: number; voltageV: number; currentA: number; sohPct: number; maxTempC: number;
    dischargeCapAh: number; chargeCapAh: number; cycleCount: number; chargerKw: number;
  };
  pcs: {
    activePowerKw: number; batteryPowerKw: number; pf: number; loadVoltageV: number; loadFreqHz: number;
    igbtTempC: number; dailyChargeKwh: number; dailyDischargeKwh: number;
    totalChargeKwh: number; totalDischargeKwh: number; efficiencyPct: number; faultFlags: number;
  };
  meters: { grid: EssMeter; load: EssMeter; ess: EssMeter };
}

export const ESS_DEMO: EssData = {
  system: {
    operation: 1, mode: 2, gridSwitch: 1, offGridState: 0, alarmWord: 0,
    availChargeKw: 25.0, availDischargeKw: 50.0, cabinetTempC: 25.0, cabinetRhPct: 60.0, socMinPct: 10.0,
  },
  battery: {
    socPct: 86, voltageV: 360.0, currentA: 34.7, sohPct: 98.0, maxTempC: 26.5,
    dischargeCapAh: 280.0, chargeCapAh: 45.0, cycleCount: 37, chargerKw: 3.2,
  },
  pcs: {
    activePowerKw: -12.3, batteryPowerKw: 12.5, pf: 0.98, loadVoltageV: 380.5, loadFreqHz: 60.0,
    igbtTempC: 41.2, dailyChargeKwh: 42.0, dailyDischargeKwh: 18.6,
    totalChargeKwh: 1234.5, totalDischargeKwh: 1102.3, efficiencyPct: 95.0, faultFlags: 0,
  },
  meters: {
    grid: { powerKw: 152.3, voltageV: 380.2, currentA: 231.4, freqHz: 60.0 },
    load: { powerKw: 160.1, voltageV: 380.0, currentA: 243.2, freqHz: 60.0 },
    ess: { powerKw: -12.3, voltageV: 380.5, currentA: 18.7, freqHz: 60.0 },
  },
};
