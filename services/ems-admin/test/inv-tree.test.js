// 盤點樹：左欄樹（台電／分區）、網狀供電範圍、多來源比對、右欄報告欄位對照、看板資料轉入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = mkdtempSync(join(tmpdir(), 'ems-invtree-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
const hdir = join(tmp, 'repo', 'src', 'content', 'hospitals');
mkdirSync(hdir, { recursive: true });
writeFileSync(join(hdir, '803.json'), JSON.stringify({
  name: '國軍臺中總醫院',
  resources: [{ id: 'power', name: '電力', devices: [
    { name: '大坑變電所 22.8KV', system: '受電', loc: '總院 → 急重症總站', reading: '急重症責任分界點' },
    { name: '太平變電所 11.4KV', system: '受電', loc: '總院 → 既有總站' },
    { name: '柴油發電機 G5 1500KW', system: '備援電力', loc: '急重症大樓', reading: '機房 1,800 L' },
    { name: '冰水主機 CH-3', system: '空調' },
  ] }],
  env: { peace: { buildings: [{ name: '急重症大樓', floors: [{ floor: '9F' }, { floor: '1F' }, { floor: 'B1' }] }, { name: '醫療大樓', floors: [{ floor: '5F' }, { floor: 'B1' }] }] } },
}));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const S = await import('../src/platform/sources.js');
const O = await import('../src/platform/observations.js');
const T = await import('../src/platform/inv-tree.js');

db.openDb(); runSeeds();
const q = db.q;
const org = authz.orgByHid('803').id;
const a1 = users.bootstrapSysadmin({ username: 'admin1', displayName: '管理員甲', password: 'Admin12345x' });
q.run('UPDATE users SET must_change = 0 WHERE id = ?', a1);
const sysadmin = authz.contextFor({ uid: a1 });
// 院所帳號（舊 accounts.json 登入者）＝該院院所管理者＋全部業務角色
const legacy = users.ensureLegacyUser({ username: 'hosp-803', hid: '803', name: '國軍臺中總醫院', passwordHash: '!test' });
const sa = authz.contextFor({ uid: legacy.uid });

test('樓層文字展開：B1–9F 由上往下；頓號清單照原順序', () => {
  assert.deepEqual(T.parseFloors('B2–3F'), ['3F', '2F', '1F', 'B1', 'B2']);
  assert.deepEqual(T.parseFloors('B1-9F').slice(0, 2), ['9F', '8F']);
  assert.deepEqual(T.parseFloors('停車場、路燈'), ['停車場', '路燈']);
  assert.deepEqual(T.parseFloors('1F-4F'), ['4F', '3F', '2F', '1F']);
  assert.deepEqual(T.parseFloors(''), []);
});

test('看板資料轉入：建物樓層、周邊、台電受電總盤、發電機；重跑不重複', () => {
  const run = () => execFileSync(process.execPath, ['scripts/inv-from-board.mjs', '803', '--outdoor', '停車場,路燈'], { cwd: join(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' });
  const out = run();
  assert.match(out, /急重症總站（大坑變電所 22\.8kV）/);
  assert.match(out, /柴油發電機 G5/);
  assert.match(run(), /沒有要新增的/);
  const tr = T.tree(sa, org);
  const ele = tr.domains.find((d) => d.key === 'electricity');
  const tpc = ele.children.find((c) => c.kind === 'tpc');
  const zones = ele.children.find((c) => c.kind === 'zones');
  assert.deepEqual(tpc.children.map((c) => c.name), ['急重症總站（大坑變電所 22.8kV）', '既有總站（太平變電所 11.4kV）']);
  assert.deepEqual(zones.children.map((b) => b.name), ['急重症大樓', '醫療大樓', '周邊'], '周邊排最後');
  assert.deepEqual(zones.children[0].children.map((f) => f.name), ['9F', '1F', 'B1']);
  assert.deepEqual(zones.children[2].children.map((f) => f.name), ['停車場', '路燈']);
  const oil = tr.domains.find((d) => d.key === 'oil');
  const g5 = oil.children[0].children[0];
  assert.equal(g5.name, '柴油發電機 G5');
  const g5row = q.get('SELECT a.*, b.name AS bname FROM assets a LEFT JOIN buildings b ON b.id = a.building_id WHERE a.id = ?', g5.id);
  assert.equal(g5row.bname, '急重症大樓', '發電機掛到所在建物');
});

let main, panel, bill, ems, manual, bld;
test('台電樹走上層關係；分盤可供多層、一層可由多盤供電（網狀）', () => {
  const tr = T.tree(sa, org);
  const ele = tr.domains.find((d) => d.key === 'electricity');
  main = ele.children[0].children[0].id;
  bld = ele.children.find((c) => c.kind === 'zones').children[0].id;
  const sub = q.get("SELECT id FROM inventory_items WHERE code = 'ELE-SUB'").id;
  panel = A.createAsset(sa, { orgId: org, itemId: sub, assetType: 'panel', name: 'A1 分盤', parentAssetId: main, buildingId: bld, floor: 'B1' }).id;
  const p2 = A.createAsset(sa, { orgId: org, itemId: sub, assetType: 'panel', name: 'A2 分盤', parentAssetId: main }).id;
  T.addZoneLink(sa, { assetId: panel, buildingId: bld, floor: '1F' });
  T.addZoneLink(sa, { assetId: panel, buildingId: bld, floor: '9F' });
  T.addZoneLink(sa, { assetId: p2, buildingId: bld, floor: '1F' });
  assert.equal(T.addZoneLink(sa, { assetId: p2, buildingId: bld, floor: '1F' }).existed, true, '重複勾不重建');
  const t2 = T.tree(sa, org).domains.find((d) => d.key === 'electricity').children[0].children[0];
  assert.deepEqual(t2.children.map((c) => c.name).sort(), ['A1 分盤', 'A2 分盤']);
  const f1 = T.zoneNode(sa, org, `${bld}|1F`);
  assert.deepEqual(f1.servedBy.map((s) => s.name).sort(), ['A1 分盤', 'A2 分盤'], '1F 由兩個盤供電');
  assert.equal(f1.servedBy[0].upstream, '急重症總站（大坑變電所 22.8kV）');
  const fb1 = T.zoneNode(sa, org, `${bld}|B1`);
  assert.deepEqual(fb1.located.map((x) => x.name), ['A1 分盤'], 'B1 是 A1 的實體位置');
  const zid = f1.servedBy.find((s) => s.name === 'A2 分盤').zoneLinkId;
  T.endZoneLink(sa, zid);
  assert.deepEqual(T.zoneNode(sa, org, `${bld}|1F`).servedBy.map((s) => s.name), ['A1 分盤'], '結束後當天起不算');
  const n = T.assetNode(sa, panel, { year: 2026 });
  assert.deepEqual(n.serves.map((s) => s.floor).sort(), ['1F', '9F']);
  assert.equal(n.path[0].id, main);
});

test('同一顆表三種來源逐月比對；下游合計對總盤', () => {
  bill = S.saveSource(sa, { assetId: main, name: '台電電費單', sourceType: 'bill' }).id;
  ems = S.saveSource(sa, { assetId: main, name: '總盤智慧電表', sourceType: 'ems', acquisition: 'api' }).id;
  manual = S.saveSource(sa, { assetId: main, name: '總盤手抄表', sourceType: 'manual' }).id;
  const pe = S.saveSource(sa, { assetId: panel, name: 'A1 智慧電表', sourceType: 'ems' }).id;
  const add = (assetId, sourceId, metricCode, v) => O.addObservation(sa, { assetId, sourceId, metricCode, periodStart: '2026-03-01', periodEnd: '2026-04-01', rawValue: v });
  add(main, bill, 'elec_purchased_kwh', 100000);
  add(main, ems, 'elec_metered_kwh', 98500);
  add(main, manual, 'elec_metered_kwh', 100200);
  add(panel, pe, 'elec_metered_kwh', 60000);
  const n = T.assetNode(sa, main, { year: 2026 });
  assert.equal(n.mainMetric, 'elec_purchased_kwh');
  assert.deepEqual(n.sources.map((s) => [s.name, s.latest?.value]), [['台電電費單', 100000], ['總盤智慧電表', 98500], ['總盤手抄表', 100200]], '同語意指標都算最新值');
  const m = n.compare.months.find((x) => x.month === '2026-03');
  assert.equal(m.values.length, 3);
  assert.equal(m.relDiffPct, 1.7);
  assert.deepEqual(n.balance, [{ month: '2026-03', children: 60000, reporting: 1, total: 2 }]);
  assert.equal(n.children.find((c) => c.name === 'A1 分盤').latest.value, 60000);
});

test('右欄報告欄位：帳單電量進盤查與申報；智慧電表表計電量只做比對；建物進表七、周邊不列', async () => {
  const a = q.get('SELECT * FROM assets WHERE id = ?', main);
  const billF = T.fieldsFor({ asset: a, metric: 'elec_purchased_kwh' });
  const has = (list, tpl, field) => list.some((f) => f.templateCode === tpl && f.field.includes(field));
  assert.ok(has(billF, 'GHG-FORM', '範疇二'), '盤查表單 範疇二');
  assert.ok(has(billF, 'GHG-FORM', '活動數據'), '盤查表單 表四');
  assert.ok(has(billF, 'ENERGY-USER', '電能使用量統計'), '能源查核 表五之二');
  assert.ok(!has(billF, 'GHG-FORM', '範疇一'), '外購電力不進範疇一');
  assert.deepEqual(T.fieldsFor({ asset: a, metric: 'elec_metered_kwh' }), [], '表計電量不是電號的資料需求，只做比對');
  const costF = T.fieldsFor({ asset: a, metric: 'elec_cost_twd' });
  assert.ok(has(costF, 'HOSP-OPS', '電費'));
  assert.ok(!has(costF, 'GHG-FORM', '範疇二'), '電費不進排放量');
  const gen = q.get("SELECT * FROM assets WHERE name = '柴油發電機 G5'");
  const genF = T.fieldsFor({ asset: gen, metric: 'oil_consumption_l' });
  assert.ok(has(genF, 'GHG-FORM', '範疇一'));
  assert.ok(has(genF, 'ENERGY-USER', '柴油') || has(genF, 'ENERGY-USER', '熱能'));
  const zf = T.fieldsFor({ zone: true });
  assert.ok(has(zf, 'ENERGY-USER', '建築資料'));
  // 表七不列周邊
  const { buildOutputBlocks } = await import('../src/platform/outputs.js');
  const t7 = buildOutputBlocks(['eu_buildings'], { caseRow: { org_id: org, year: 2026 }, datasetId: null, results: {} }).eu_buildings;
  assert.deepEqual(t7.tables[0].rows.map((r) => r[1]).sort(), ['急重症大樓', '醫療大樓']);
});

test('權限：別院帳號看不到這棵樹', () => {
  const other = A.saveOrg(sysadmin, { kind: 'hospital', code: 'T999', name: '測試別院' }).id;
  const uid = users.createUser(sysadmin, { username: 'u802', displayName: '別院', password: 'Passw0rd!23', grants: [{ role: 'collector', scopeType: 'org', scopeId: other }] }).id;
  q.run('UPDATE users SET must_change = 0 WHERE id = ?', uid);
  const ctx = authz.contextFor({ uid });
  assert.throws(() => T.tree(ctx, org));
  assert.throws(() => T.assetNode(ctx, main, {}));
});
