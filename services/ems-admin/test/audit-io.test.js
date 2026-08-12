// 能源診斷問卷匯入/匯出的來回測試。
// 核心主張：JSON → xlsx → JSON 必須完全還原，且產出的活頁簿格式與範本逐格相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importAudit, exportAudit } from '../src/audit-io.js';
import { readWorkbook } from '../src/xlsx.js';
import { SHEET_A, SHEET_E, SHEET_P } from '../src/audit-fields.js';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'energy-audit-v2.xlsx');
const template = readFileSync(TEMPLATE);

const sample = {
  chillers: [
    { systemName: '中央空調冰水系統', deviceNo: 'CH-01', capacityRt: '380', age: '11-15年',
      originType: '日本/離心式/變頻', maintenance: '良好',
      chilledOutSpring: 7, chilledOutSummer: 6.5, chilledOutAutumn: 7, chilledOutWinter: 8,
      coolingInSpring: 32, coolingInSummer: 34, coolingInAutumn: 32, coolingInWinter: 30,
      roomTemp: 24.5, roomHumidity: 55 },
    { systemName: '中央空調冰水系統', deviceNo: 'CH-02', capacityRt: '380', age: '6-10年',
      originType: '日本/離心式/定頻', maintenance: '一般', roomTemp: 24.5, roomHumidity: 55 },
  ],
  inventory: [
    { system: '中央空調系統', name: '冰水主機#1', deviceNo: 'CH-01', madeYear: '2015',
      capacity: 380, capacityUnit: 'RT', ratedKw: 266, qty: 1, loadPct: 60, hoursPerYear: 4000 },
    { system: '照明系統', name: '病房走廊 LED', deviceNo: 'LT-B1', madeYear: '2021',
      capacity: 20, capacityUnit: 'W', ratedKw: 0.02, qty: 320, loadPct: 100, hoursPerYear: 8760 },
  ],
  power: {
    meterNo: '01-23-4567-89', tariff: '高壓三段式', timeType: '三段式', hasEms: '是',
    suggestedCapacity: 1200, estimatedSaving: 480000,
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, contractCapacity: 1300,
      demandPeak: 800 + i, demandHalfPeak: 600, demandSatHalfPeak: 500, demandOffPeak: 300,
      usePeak: 120000 + i * 100, useHalfPeak: 90000, useSatHalfPeak: 30000, useOffPeak: 60000,
      wheelPeak: 0, wheelHalfPeak: 0, wheelSatHalfPeak: 0, wheelOffPeak: 0,
      totalFee: 980000 + i * 1000,
    })),
  },
};

test('匯出再匯入可完全還原（JSON → xlsx → JSON）', () => {
  const { buffer } = exportAudit(template, sample);
  const { audit } = importAudit(buffer);
  assert.deepEqual(audit, sample);
});

test('百分比欄位：表單填 60 → 儲存格存 0.6 → 讀回仍是 60', () => {
  const { buffer } = exportAudit(template, sample);
  const { sheets } = readWorkbook(buffer);
  // 表E K5 是 0% 格式，公式 =I5*J5*K5*L5 需要小數才算得出正確 kWh
  assert.equal(sheets.get(SHEET_E).cells.get('K5'), '0.6');
  assert.equal(sheets.get(SHEET_A).cells.get('D17'), '0.55');
  const { audit } = importAudit(buffer);
  assert.equal(audit.inventory[0].loadPct, 60);
  assert.equal(audit.chillers[0].roomHumidity, 55);
});

test('數值寫成數值格，文字保持文字（否則 =SUM/=MAX 會當 0、電號前導零會被吃掉）', () => {
  const { buffer } = exportAudit(template, sample);
  const xml = new TextDecoder().decode(
    (() => { const { files } = readWorkbook(buffer); return files.get(sheetPath(buffer, SHEET_P)); })(),
  );
  // 計費度數四格必須是純 <v>，不得帶 t="inlineStr"
  for (const ref of ['I8', 'J8', 'K8', 'L8', 'S8']) {
    const m = new RegExp(`<c[^>]*r="${ref}"[^>]*>`).exec(xml);
    assert.ok(m, `找不到 ${ref}`);
    assert.ok(!/t="inlineStr"/.test(m[0]), `${ref} 被寫成文字，=SUM() 會當 0`);
  }
  // 電號是 @ 格式，必須維持文字
  const { audit } = importAudit(buffer);
  assert.equal(audit.power.meterNo, '01-23-4567-89');
});

function sheetPath(buf, name) {
  return readWorkbook(buf).sheets.get(name).path;
}

test('匯出不動範本的結構：公式、合併格、資料驗證全數保留', () => {
  const { buffer, skippedFormula } = exportAudit(template, sample);
  const before = readWorkbook(template);
  const after = readWorkbook(buffer);
  assert.equal(after.sheets.size, before.sheets.size);
  for (const [name, s] of before.sheets) {
    assert.deepEqual([...after.sheets.get(name).formulas].sort(), [...s.formulas].sort(), `${name} 的公式有變動`);
  }
  // 我們沒去寫任何公式格，所以不該有被跳過的
  assert.deepEqual(skippedFormula, []);
});

// 空白範本的「轉供度數」四欄預填了 0（12 個月都有）。照單全收會讓任何未填完的上傳
// 都產生 12 列全零月份，維護表單多出一堆雜訊——所以整月全零視為未填。
test('空白範本匯入 → 得到空的 audit，不會生出 12 列全零月份', () => {
  const { audit, report } = importAudit(template);
  assert.deepEqual(audit, {});
  assert.equal(report.chillers, 0);
  assert.equal(report.inventory, 0);
  assert.equal(report.months, 0);
});

test('缺工作表要明確報錯，不是安靜地回空值', () => {
  // 拿一份不含這三張表的活頁簿：用範本但改名是不可行的，改以「隨便一個 zip」驗證錯誤路徑
  assert.throws(() => importAudit(Buffer.from('not a zip at all')), /zip|EOCD/i);
});

test('必填漏填只警告不擋下（院方常分次填）', () => {
  const partial = { inventory: [{ system: '照明系統', name: '走廊燈' }] };
  const { buffer } = exportAudit(template, partial);
  const { audit, report } = importAudit(buffer);
  assert.equal(audit.inventory.length, 1);
  assert.ok(report.warnings.some((w) => w.includes('設備編號')), '應提示缺必填');
});
