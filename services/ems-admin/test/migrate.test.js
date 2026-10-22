// 舊資料轉移（健檢填報 → 能源盤點）的回歸測試。
//
// 蓋住：轉出來的結構能被新版原樣存回去（site 區塊、點位、設備都過驗證）、
// 電費單複驗狀態沒被洗成已確認、冪等、原 audit 檔一個 byte 都沒動、dry-run 不寫檔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'ems-migrate-test-'));
process.env.AUDIT_DATA_DIR = join(TMP, 'data');
process.env.AUDIT_UPLOADS_DIR = join(TMP, 'uploads');
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123';

const M = await import('../src/inventory-migrate.js');
const S = await import('../src/inventory-schema.js');
const store = await import('../src/inventory-store.js');

const bill = (meterNo, period, extra = {}, meta = {}) => ({
  values: { period, meterNo, tariffType: '高壓', timeType: '三段式', contractCapacity: 3000, demandPeak: 2800, powerFactor: 98,
    usePeak: 300000, useHalfPeak: 400000, useOffPeak: 300000, useTotal: 1000000, feeBasic: 500000, feeFlow: 3000000, feePowerFactor: -24530, feeTotal: 3475470, ...extra },
  meta,
});

function sampleAudit() {
  return {
    version: 1, updated: '2026-08-20T08:00:00.000Z', selfCheck: null,
    blocks: {
      contact: { values: { hospitalName: '國軍測試總醫院', primaryName: '王小明', primaryUnit: '工務室／技士', primaryPhone: '02-12345678#123', primaryEmail: 'a@b.tw', backupName: '李大華', reportingUnit: '工務' }, meta: {} },
      basic: { values: { campusName: '主院區', address: '台北市內湖區成功路二段 325 號', beds: 620, floorArea: 120000, buildingScope: 'A/B 棟＋門診大樓', operationType: '急性一般醫院' }, meta: { beds: { state: 'ok' } } },
      bills: { rows: [
        bill('01-23-4567-89-0', '2026-01', {}, { period: { state: 'ok' }, useTotal: { state: 'ok' } }),
        bill('01-23-4567-89-0', '2026-02', {}, { period: { state: 'todo', source: { fileId: 'f1', page: 1 } }, usePeak: { state: 'low' } }),
        bill('01-23-4567-89-0', '2026-03'),
        bill('09-87-6543-21-0', '2026-03', { contractCapacity: 500, tariffType: '低壓', timeType: '' }),
        bill('09-87-6543-21-0', ''),
      ] },
      emissions: { rows: [{ values: { name: '外購電力', category: '範疇二 外購電力', amount: 12000000 }, meta: {} }] },
      majorLoads: { rows: [
        { values: { system: '空調', name: '1 號冰水主機', deviceNo: 'CH-01', madeYear: '2012', capacity: 500, capacityUnit: 'RT', ratedKw: 320, qty: 1, loadPct: 70, hoursPerYear: 6000, annualKwh: 1344000 }, meta: {} },
        { values: { system: '照明', name: 'B1 停車場 LED', deviceNo: 'L-01', madeYear: '2020', capacity: 20, capacityUnit: 'W', ratedKw: 0.02, qty: 400, loadPct: 100, hoursPerYear: 8760 }, meta: {} },
        { values: { system: '醫療設備', name: 'MRI', deviceNo: 'MRI-1', madeYear: '約2010', ratedKw: 80, qty: 1, loadPct: 60, hoursPerYear: 4000 }, meta: {} },
        { values: { system: '雜項', name: '洗衣機', deviceNo: 'W-1', ratedKw: 15, qty: 2 }, meta: {} },
      ] },
      chillers: { rows: [
        { values: { systemName: '主院區', deviceNo: 'CH-01', capacityRt: '500', age: '14', originType: '日本/離心式/變頻', maintenance: '良好（例行確實）', roomTemp: 26, roomHumidity: 55 }, meta: {} },
        { values: { systemName: '門診大樓', deviceNo: 'CH-02', capacityRt: '200', age: '8', originType: '美國/螺旋式/定頻', maintenance: '一般（間歇保養）', roomTemp: 25, roomHumidity: 60 }, meta: {} },
      ] },
      events: { rows: [{ values: { date: '2026-02-10', type: '施工', title: '門診大樓整修' }, meta: {} }] },
    },
    files: [{ id: 'f1', block: 'bills', storedName: 'f1.pdf' }],
  };
}

const auditPath = (hid) => join(process.env.AUDIT_DATA_DIR, `${hid}.json`);
const invPath = (hid) => join(process.env.AUDIT_DATA_DIR, 'inventory', `${hid}.json`);
function writeAudit(hid, audit) {
  mkdirSync(process.env.AUDIT_DATA_DIR, { recursive: true });
  writeFileSync(auditPath(hid), JSON.stringify(audit, null, 2) + '\n', 'utf8');
  return readFileSync(auditPath(hid));
}

test('dry-run：只出報告，不寫 inventory、不動資料目錄', async () => {
  const before = writeAudit('901', sampleAudit());
  const rep = await M.migrateHospital('901', { dryRun: true });
  assert.equal(rep.dryRun, true);
  assert.equal(rep.created.records, 4);
  assert.equal(existsSync(invPath('901')), false, 'dry-run 不可產生 inventory 檔');
  assert.equal(existsSync(join(process.env.AUDIT_DATA_DIR, '.git')), false, 'dry-run 不可 git init');
  assert.deepEqual(readFileSync(auditPath('901')), before);
  assert.match(M.formatReport(rep), /試跑/);
});

test('轉移結果：電號、台電總表點位、電費單紀錄、設備、基本資料、能管人員', async () => {
  const before = writeAudit('803', sampleAudit());
  const rep = await M.migrateHospital('803');
  assert.equal(rep.changed, true);
  assert.ok(rep.commit, '要 commit 進資料倉庫');
  assert.deepEqual(rep.created, { basicFields: 4, meters: 2, points: 2, records: 4, equipment: 5, staff: 1 });
  assert.equal(rep.merged, 1, 'CH-01 在重大設備與冰水主機各一筆，只建一台');

  const inv = await store.readInventory('803');
  // 基本資料
  assert.equal(inv.site.basic.userName, '主院區');
  assert.equal(inv.site.basic.siteAddress, '台北市內湖區成功路二段 325 號');
  assert.equal(inv.site.basic.beds, 620);
  assert.equal(inv.site.basic.floorArea, 120000);
  assert.ok(rep.unmapped.some((u) => u.block === 'basic' && u.field === 'buildingScope'));
  assert.equal(inv.migration.audit.unmapped['basic.operationType'], '急性一般醫院');

  // 電號：每個電號一筆，契約容量取最新一期
  assert.deepEqual(inv.site.meters.map((m) => [m.meterNo, m.contractKw, m.tariffType]), [['01-23-4567-89-0', 3000, '高壓 三段式'], ['09-87-6543-21-0', 500, '低壓']]);
  // 點位：每個電號一個 bill 型台電總表，連到電號
  assert.deepEqual(inv.points.map((p) => p.code), ['803-E01', '803-E02']);
  assert.equal(inv.points[0].items[0].type, 'bill');
  assert.equal(inv.points[0].items[0].meterId, inv.site.meters[0].id);
  assert.match(inv.points[0].name, /台電總表/);

  // 電費單紀錄：period＝帳單月份、who＝舊資料轉入、複驗狀態原樣保留
  const recs = inv.records.filter((r) => r.pointCode === '803-E01');
  assert.deepEqual(recs.map((r) => r.period), ['2026-01', '2026-02', '2026-03']);
  assert.ok(inv.records.every((r) => r.who === M.MIGRATION_WHO));
  const feb = recs[1].values.bill;
  assert.equal(feb.values.feePowerFactor, -24530, '功因調整費負數要照帶');
  assert.equal(feb.meta.period.state, 'todo', '未複驗的格子不能被洗成已確認');
  assert.equal(feb.meta.usePeak.state, 'low');
  assert.equal(recs[0].values.bill.meta.period.state, 'ok');
  assert.equal(rep.pendingCells, 2);
  assert.ok(rep.unmapped.some((u) => u.block === 'bills' && u.field === 'period'), '沒期別的那張要列在報告');

  // 設備
  const byNo = (no) => inv.equipment.find((e) => e.fields.deviceNo === no);
  const ch1 = byNo('CH-01');
  assert.equal(ch1.category, 'ac');
  assert.equal(ch1.kind, '中央空調主機');
  assert.equal(ch1.fields.powerKw, 320);
  assert.equal(ch1.fields.madeYear, 2012);
  assert.equal(ch1.fields.model, '日本/離心式/變頻');
  assert.equal(ch1.fields.inverter, true);
  assert.equal(ch1.legacy.values.loadPct, 70, '表九沒有的欄位留在 legacy');
  assert.equal(ch1.legacy.chiller.values.maintenance, '良好（例行確實）');
  const ch2 = byNo('CH-02');
  assert.deepEqual([ch2.category, ch2.kind, ch2.fields.capacity, ch2.fields.capacityUnit, ch2.fields.inverter], ['ac', '中央空調主機', 200, 'RT', false]);
  const led = inv.equipment.find((e) => e.category === 'lighting');
  assert.deepEqual([led.kind, led.fields.wattPerFixture, led.fields.qty], ['LED', 20, 400]);
  const mri = byNo('MRI-1');
  assert.deepEqual([mri.category, mri.kind], ['other', '其他']);
  assert.equal(mri.fields.madeYear, undefined, '「約2010」不是年份，不轉');
  assert.equal(mri.legacy.values.madeYear, '約2010');
  const washer = byNo('W-1');
  assert.deepEqual([washer.category, washer.kind, washer.legacy.values.system], ['other', '其他', '雜項']);
  assert.ok(rep.unmapped.some((u) => u.block === 'majorLoads' && u.field === 'system' && u.value === '雜項'));

  // 能管人員：主要聯絡人一筆，備援留在舊檔
  assert.equal(inv.site.staff.length, 1);
  assert.deepEqual([inv.site.staff[0].role, inv.site.staff[0].name, inv.site.staff[0].unitTitle], ['填表人員', '王小明', '工務室／技士']);
  assert.ok(rep.notMigrated.contact.includes('備援聯絡人姓名'));
  assert.deepEqual([rep.notMigrated.emissions, rep.notMigrated.events, rep.notMigrated.files], [1, 1, 1]);

  // 轉出來的東西要能被新版原樣存回去（管理端 PUT 走這些驗證）
  for (const b of ['basic', 'meters', 'staff']) {
    const v = S.validateSiteBlock(b, inv.site[b], (x) => x);
    assert.equal(v.ok, true, `${b}：${v.errors.join('；')}`);
  }
  for (const p of inv.points) assert.equal(S.validatePoint(p, inv).ok, true);
  for (const e of inv.equipment) assert.equal(S.validateEquipment(e, inv).ok, true, JSON.stringify(S.validateEquipment(e, inv).errors));

  // 原 audit 檔一個 byte 都沒動
  assert.deepEqual(readFileSync(auditPath('803')), before);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'inventory/803.json'], { cwd: process.env.AUDIT_DATA_DIR }).toString(), '');
});

test('冪等：重跑不重複建；舊檔新增一期只補那一期；院方改過的不被蓋回', async () => {
  const before = readFileSync(auditPath('803'));
  const inv0 = await store.readInventory('803');
  const rep = await M.migrateHospital('803');
  assert.equal(rep.changed, false);
  assert.equal(rep.commit, null);
  assert.deepEqual(Object.values(rep.created), [0, 0, 0, 0, 0, 0]);
  const inv1 = await store.readInventory('803');
  assert.equal(inv1.updated, inv0.updated, '沒有新資料就不寫檔');

  // 院方在新版改了床數、刪掉 MRI；舊檔多一期電費單
  await store.mutateInventory('803', (inv) => {
    inv.site.basic.beds = 650;
    inv.equipment = inv.equipment.filter((e) => e.fields.deviceNo !== 'MRI-1');
  });
  const a = JSON.parse(before.toString());
  a.blocks.bills.rows.push(bill('01-23-4567-89-0', '2026-04'));
  const before2 = writeAudit('803', a);
  const rep2 = await M.migrateHospital('803');
  assert.deepEqual(rep2.created, { basicFields: 0, meters: 0, points: 0, records: 1, equipment: 0, staff: 0 });
  const inv2 = await store.readInventory('803');
  assert.equal(inv2.site.basic.beds, 650, '轉過的欄位重跑不蓋回');
  assert.equal(inv2.equipment.some((e) => e.fields.deviceNo === 'MRI-1'), false, '院方刪掉的設備不重建');
  assert.equal(inv2.records.filter((r) => r.pointCode === '803-E01').length, 4);
  assert.equal(inv2.points.length, 2);
  assert.deepEqual(readFileSync(auditPath('803')), before2);
});

test('--all：列出資料目錄裡每一家的健檢檔', async () => {
  const hids = await M.listAuditHids();
  assert.deepEqual(hids, ['803', '901']);
  const reps = await M.migrateAll({ dryRun: true });
  assert.equal(reps.length, 2);
  assert.equal(reps.find((r) => r.hid === '803').changed, false);
  assert.equal(reps.find((r) => r.hid === '901').created.records, 4);
  assert.equal(existsSync(invPath('901')), false);
});
