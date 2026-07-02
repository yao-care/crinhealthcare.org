// 儲能櫃 Modbus 點位表（規格書 Modbus_Protocol_Specification v1.0 的唯一落地處）。
// 所有位址為 0-based offset；FC03=Holding、FC04=Input；單塊 ≤ 125 registers（Modbus 協定上限）。

// 電池組定址（§7）：base = (PackParInd - 1) * 800 + (PackSerInd + 1) * 200
export function packBase(parInd, serInd) {
  return (parInd - 1) * 800 + (serInd + 1) * 200;
}

// 讀取計劃：key → decode.js 的 raw 區塊名
export function buildReadPlan({ packParInd = 1, packSerInd = 0 } = {}) {
  return [
    { key: 'hold0', fc: 3, addr: 0, len: 30 },      // EMS 基礎控制區（§2）
    { key: 'hold150', fc: 3, addr: 150, len: 10 },  // 策略保護參數區（§4.4）
    { key: 'pack', fc: 4, addr: packBase(packParInd, packSerInd), len: 105 }, // 電池組（§7）
    { key: 'pcs', fc: 4, addr: 5000, len: 41 },     // PCS #1（§5）
    { key: 'mGrid', fc: 4, addr: 6000, len: 29 },   // GridMeter 市電電錶（§6）
    { key: 'mLoad', fc: 4, addr: 6100, len: 29 },   // LoadMeter 負載電錶
    { key: 'mEss', fc: 4, addr: 6200, len: 29 },    // EssMeter 儲能電錶
  ];
}

// 欄位表：block=讀取計劃 key、offset=塊內相對位移、type=u16/i16/u32le、scale=除數還原
// （u32le＝低位字組先，§13.8；i16＝二補數，§13.9）
export const FIELDS = {
  // — EMS 基礎控制區（hold0，§2.1）—
  batteryOperation:  { block: 'hold0', offset: 0,  type: 'u16', scale: 1 },    // §9.1 0=關機 1=運行 2=重置/待命
  batteryMode:       { block: 'hold0', offset: 2,  type: 'u16', scale: 1 },    // §9.2 0=待機 1=自動 2=充電 3=放電
  availChargeKw:     { block: 'hold0', offset: 10, type: 'u16', scale: 10 },   // TotalAvailChargePower ×10 kW
  availDischargeKw:  { block: 'hold0', offset: 11, type: 'u16', scale: 10 },   // TotalAvailDischargePower ×10 kW
  cabinetTempC:      { block: 'hold0', offset: 12, type: 'u16', scale: 10 },   // InCabinetTemp ×10 ℃
  cabinetRhPct:      { block: 'hold0', offset: 13, type: 'u16', scale: 10 },   // InCabinetHumidity ×10 %
  gridSwitch:        { block: 'hold0', offset: 25, type: 'u16', scale: 1 },    // StsGridSideSwitch 0=斷開 1=閉合
  alarmWord:         { block: 'hold0', offset: 27, type: 'u16', scale: 1 },    // StsAlarmWord 0=正常
  offGridState:      { block: 'hold0', offset: 28, type: 'u16', scale: 1 },    // StsOffGridRunState 0=併網 非0=離網
  // — 保護參數（hold150，§4.4）—
  socMinPct:         { block: 'hold150', offset: 1, type: 'u16', scale: 10 },  // Protect_SocMin(offset151) ×10 %
  // — 電池組（pack，§7）—
  socPct:            { block: 'pack', offset: 1,   type: 'u16', scale: 1 },    // SOC %
  batteryVoltageV:   { block: 'pack', offset: 2,   type: 'u16', scale: 10 },   // BtryPckV ×10 V
  batteryCurrentA:   { block: 'pack', offset: 3,   type: 'i16', scale: 10 },   // BtryPckI ×10 A（充正放負）
  sohPct:            { block: 'pack', offset: 12,  type: 'u16', scale: 10 },   // SOH ×10 %
  batteryMaxTempC:   { block: 'pack', offset: 21,  type: 'i16', scale: 10 },   // MxTmp ×10 ℃
  chargerKw:         { block: 'pack', offset: 60,  type: 'u16', scale: 10000 },// ChrgrP ×10 W → kW
  dischargeCapAh:    { block: 'pack', offset: 100, type: 'u32le', scale: 10 }, // BatDschgCap ×10 Ah
  chargeCapAh:       { block: 'pack', offset: 102, type: 'u32le', scale: 10 }, // BatChrgCap ×10 Ah
  cycleCount:        { block: 'pack', offset: 104, type: 'u16', scale: 1 },    // BatCyclCnt
  // — PCS #1（pcs，§5）—
  pcsFaultFlags:     { block: 'pcs', offset: 4,  type: 'u16', scale: 1 },      // FaultFlags 彙總
  pcsActivePowerKw:  { block: 'pcs', offset: 6,  type: 'i16', scale: 10 },     // ×10 kW（放正充負）
  pcsPf:             { block: 'pcs', offset: 9,  type: 'u16', scale: 1000 },   // ×1000
  loadVoltageV:      { block: 'pcs', offset: 10, type: 'u16', scale: 10 },     // LoadVoltageA ×10 V
  loadFreqHz:        { block: 'pcs', offset: 16, type: 'u16', scale: 100 },    // ×100 Hz
  batteryPowerKw:    { block: 'pcs', offset: 19, type: 'i16', scale: 10 },     // ×10 kW（充正放負）
  igbtTempC:         { block: 'pcs', offset: 21, type: 'i16', scale: 10 },     // ×10 ℃
  totalChargeKwh:    { block: 'pcs', offset: 23, type: 'u32le', scale: 10 },   // ×10 kWh
  totalDischargeKwh: { block: 'pcs', offset: 25, type: 'u32le', scale: 10 },
  dailyChargeKwh:    { block: 'pcs', offset: 27, type: 'u32le', scale: 10 },
  dailyDischargeKwh: { block: 'pcs', offset: 29, type: 'u32le', scale: 10 },
  efficiencyPct:     { block: 'pcs', offset: 40, type: 'u16', scale: 10 },     // ×10 %
  // — 電錶（§6.1，相對 baseOffset）—
  gridPowerKw:   { block: 'mGrid', offset: 15, type: 'i16', scale: 10 },       // ActivePowerTotal ×10 kW
  gridVoltageV:  { block: 'mGrid', offset: 5,  type: 'u16', scale: 10 },       // VoltageAverage ×10 V
  gridCurrentA:  { block: 'mGrid', offset: 13, type: 'i16', scale: 10 },       // CurrentAverage ×10 A
  gridFreqHz:    { block: 'mGrid', offset: 28, type: 'u16', scale: 100 },      // Frequency ×100 Hz
  loadPowerKw:   { block: 'mLoad', offset: 15, type: 'i16', scale: 10 },
  loadMeterV:    { block: 'mLoad', offset: 5,  type: 'u16', scale: 10 },
  loadCurrentA:  { block: 'mLoad', offset: 13, type: 'i16', scale: 10 },
  loadMeterHz:   { block: 'mLoad', offset: 28, type: 'u16', scale: 100 },
  essPowerKw:    { block: 'mEss', offset: 15, type: 'i16', scale: 10 },
  essVoltageV:   { block: 'mEss', offset: 5,  type: 'u16', scale: 10 },
  essCurrentA:   { block: 'mEss', offset: 13, type: 'i16', scale: 10 },
  essFreqHz:     { block: 'mEss', offset: 28, type: 'u16', scale: 100 },
};
