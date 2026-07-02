import { test } from 'node:test';
import assert from 'node:assert/strict';
import { u16, i16, u32le, decode } from '../src/decode.js';
import { buildReadPlan, packBase, FIELDS } from '../src/registers.js';
import { createSimulator } from '../src/simulator.js';

test('i16 二補數（§13.9）', () => {
  assert.equal(i16(0xffff), -1);
  assert.equal(i16(0x8000), -32768);
  assert.equal(i16(300), 300);        // 規格書例：300 = 30.0 kW 放電
  assert.equal(i16(0x10000 - 123), -123); // −12.3 kW 充電
});

test('u32le 低位字組先（§13.8）', () => {
  assert.equal(u32le(0x5678, 0x1234), 0x12345678);
  assert.equal(u32le(0xffff, 0xffff), 0xffffffff);
  assert.equal(u16(0x1ffff), 0xffff);
});

test('電池組定址公式（§7）', () => {
  assert.equal(packBase(1, 0), 200);   // Par=1, Ser=0
  assert.equal(packBase(2, 3), 1600);  // (2-1)*800+(3+1)*200
});

test('整包解碼：規格書範例值', () => {
  const plan = buildReadPlan({ packParInd: 1, packSerInd: 0 });
  const raw = {};
  for (const seg of plan) raw[seg.key] = new Array(seg.len).fill(0);
  raw.hold0[10] = 250;    // TotalAvailChargePower 例：250 = 25.0 kW
  raw.hold0[11] = 500;    // TotalAvailDischargePower 例：500 = 50.0 kW
  raw.hold0[12] = 250;    // InCabinetTemp 例：250 = 25.0 ℃
  raw.hold0[13] = 600;    // InCabinetHumidity 例：600 = 60.0 %
  raw.hold150[1] = 100;   // Protect_SocMin 例：100 = 10.0 %
  raw.pack[1] = 86;       // SOC 86 %
  raw.pack[2] = 3600;     // BtryPckV 例：3600 = 360.0 V
  raw.pack[3] = 0x10000 - 205; // BtryPckI −20.5 A（放電）
  raw.pack[12] = 980;     // SOH 例：980 = 98.0 %
  raw.pack[100] = 2800; raw.pack[101] = 0; // BatDschgCap 280.0 Ah
  raw.pcs[9] = 980;       // PF 例：980 = 0.980
  raw.pcs[16] = 6000;     // LoadFrequency 60.00 Hz
  raw.pcs[40] = 950;      // Efficiency 例：950 = 95.0 %
  raw.mLoad[15] = 102;    // LoadMeter 10.2 kW

  const d = decode(raw);
  assert.equal(d.system.availChargeKw, 25);
  assert.equal(d.system.availDischargeKw, 50);
  assert.equal(d.system.cabinetTempC, 25);
  assert.equal(d.system.cabinetRhPct, 60);
  assert.equal(d.system.socMinPct, 10);
  assert.equal(d.battery.socPct, 86);
  assert.equal(d.battery.voltageV, 360);
  assert.equal(d.battery.currentA, -20.5);
  assert.equal(d.battery.sohPct, 98);
  assert.equal(d.battery.dischargeCapAh, 280);
  assert.equal(d.pcs.pf, 0.98);
  assert.equal(d.pcs.loadFreqHz, 60);
  assert.equal(d.pcs.efficiencyPct, 95);
  assert.equal(d.meters.load.powerKw, 10.2);
});

test('模擬器輸出經解碼在合理範圍', async () => {
  const plan = buildReadPlan({ packParInd: 1, packSerInd: 0 });
  const sim = createSimulator({ readPlan: plan });
  for (let i = 0; i < 5; i++) {
    const d = decode(await sim.readAll());
    assert.ok(d.battery.socPct >= 20 && d.battery.socPct <= 97, `SOC ${d.battery.socPct}`);
    assert.ok(d.battery.voltageV > 300 && d.battery.voltageV < 420);
    assert.ok(d.system.gridSwitch === 1);
    assert.ok(d.pcs.loadFreqHz > 55 && d.pcs.loadFreqHz < 65);
    assert.ok(d.meters.load.powerKw > 100 && d.meters.load.powerKw < 220);
    assert.ok(d.pcs.activePowerKw < 0, 'PCS 充電中應為負值');
  }
});

test('讀取計劃單塊不超過 Modbus 125 registers 上限', () => {
  for (const seg of buildReadPlan({})) {
    assert.ok(seg.len <= 125, `${seg.key} len=${seg.len}`);
  }
});

test('FIELDS 所有欄位落在讀取計劃範圍內', () => {
  const plan = Object.fromEntries(buildReadPlan({}).map((s) => [s.key, s]));
  for (const [name, spec] of Object.entries(FIELDS)) {
    const seg = plan[spec.block];
    assert.ok(seg, `${name}: 無 ${spec.block} 塊`);
    const end = spec.offset + (spec.type === 'u32le' ? 1 : 0);
    assert.ok(end < seg.len, `${name}: offset ${end} 超出 ${spec.block} len ${seg.len}`);
  }
});
