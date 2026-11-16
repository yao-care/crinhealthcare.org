// 組織型溫室氣體盤查表單（盤查表單 3.0.0 版邏輯）：係數 6.0.4 版＝v1（111 年度以前）、113 年 2 月 5 日公告＝v2（112 年度起）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-ghgform-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
mkdirSync(join(tmp, 'repo', 'src', 'content', 'hospitals'), { recursive: true });
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', 'yuli.json'), JSON.stringify({ name: '臺北榮民總醫院玉里分院' }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const O = await import('../src/platform/observations.js');
const D = await import('../src/platform/datasets.js');
const R = await import('../src/platform/reports.js');
const V = await import('../src/platform/validation.js');
const E = await import('../src/platform/evidence.js');
const X = await import('../src/platform/export.js');
const CFG = await import('../src/platform/config-store.js');
const calc = await import('../src/platform/calc.js');
const { readWorkbook } = await import('../src/xlsx.js');

db.openDb(); runSeeds();
const q = db.q;
const org = authz.orgByHid('yuli').id;
const a1 = users.bootstrapSysadmin({ username: 'admin1', displayName: '管理員甲', password: 'Admin12345x' });
const a2 = users.bootstrapSysadmin({ username: 'admin2', displayName: '管理員乙', password: 'Admin12345y' });
const ctxOf = (id) => { q.run('UPDATE users SET must_change = 0 WHERE id = ?', id); return authz.contextFor({ uid: id }); };
const sa1 = ctxOf(a1); const sa2 = ctxOf(a2);
const mk = (u, roles) => ctxOf(users.createUser(sa1, { username: u, displayName: u, password: 'Passw0rd123', grants: roles.map((role) => ({ role, scopeType: 'org', scopeId: org })) }).id);
const col = mk('col', ['collector']); const rep = mk('rep', ['reporter']); const rv1 = mk('rv1', ['reviewer']); const rv2 = mk('rv2', ['reviewer']);
for (const f of q.all("SELECT id FROM factors WHERE status = 'pending' ORDER BY code, version")) CFG.publish(sa2, 'factor', f.id);
const item = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code).id;
const asset = (code, type, name, o = {}) => A.createAsset(col, { orgId: org, itemId: item(code), assetType: type, name, ...o }).id;
const ev = (await E.storeEvidence(col, { orgId: org, filename: 'bills.pdf', data: Buffer.from('%PDF-1.4 bills') })).id;
const obs = (assetId, metricCode, ps, pe, v) => O.addObservation(col, { assetId, metricCode, periodStart: ps, periodEnd: pe, rawValue: v }, { evidenceIds: [ev] });
const actAsset = (code) => q.get('SELECT a.id FROM assets a JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code = ?', org, code).id;
function approveAll(dsId) {
  V.runValidation(rep, { orgId: org, year: q.get('SELECT year FROM datasets WHERE id = ?', dsId).year });
  D.proposeBulk(rep, { datasetId: dsId, reason: '單一來源、檢核通過' });
  for (const d of q.all("SELECT id FROM decisions WHERE dataset_id = ? AND status IN ('proposed','first_approved')", dsId)) {
    D.reviewDecision(rv1, d.id, { approve: true });
    if (q.get('SELECT status FROM decisions WHERE id = ?', d.id).status === 'first_approved') D.reviewDecision(rv2, d.id, { approve: true });
  }
  D.submitDataset(rep, dsId); D.approveDataset(rv1, dsId); D.lockDataset(rv1, dsId);
}
const fv = (code, version) => q.get('SELECT * FROM factors WHERE code = ? AND version = ?', code, version);

test('係數兩個版本：6.0.4 版＝v1、113 年 2 月 5 日公告＝v2', () => {
  assert.equal(fv('ghg.heat.diesel', 1).value, 8400); assert.equal(fv('ghg.heat.diesel', 2).value, 8636);
  assert.equal(fv('ghg.heat.gasoline', 2).value, 7586); assert.equal(fv('ghg.heat.ng', 2).value, 8728);
  assert.ok(!fv('ghg.heat.fuel_oil', 2), '113 年公告未列燃料油熱值，沿用 v1');
  assert.equal(fv('ef.diesel.stationary.CO2', 1).unit, 'kgCO2/TJ'); assert.equal(fv('ef.diesel.stationary.CO2', 2).valid_from, '2023-01-01');
  assert.equal(fv('ef.diesel.stationary.CO2', 1).uncertainty_low, -2); assert.equal(fv('ef.diesel.stationary.CO2', 1).uncertainty_high, 0.9);
  assert.equal(fv('ef.gasoline.mobile.CH4', 2).value, 25, '車用汽油移動源採氧化觸媒');
  assert.equal(fv('gwp.AR4.CH4', 1).value, 25); assert.equal(fv('gwp.AR4.N2O', 1).value, 298); assert.equal(fv('gwp.AR4.R-410A', 1).value, 2088);
  assert.equal(fv('gwp.AR5.CH4', 1).value, 28); assert.equal(fv('gwp.AR5.N2O', 1).value, 265); assert.equal(fv('gwp.AR5.R-410A', 1).value, 1923.5);
  assert.equal(fv('ef.electricity.2019', 1).value, 0.509); assert.equal(fv('ef.electricity.2022', 1).value, 0.495);
  // 發布 v2 時 v1 有效迄日設為 v2 起日，盤查年度取對應版本
  assert.equal(CFG.factorAt('ghg.heat.diesel', '2022-07-01').version, 1);
  assert.equal(CFG.factorAt('ghg.heat.diesel', '2024-07-01').version, 2);
  assert.equal(CFG.factorAt('ghg.heat.fuel_oil', '2024-07-01').version, 1);
});

let gen; let gen24; let ac; let acct; let septic; let ds22; let ds24;
test('建立排放源與 111、113 年度資料集', () => {
  gen = asset('OIL-GEN', 'generator', '緊急發電機（111 年）', { attrs: { fuel: 'diesel' } });
  obs(gen, 'oil_consumption_l', '2022-01-01', '2023-01-01', 2715734);
  gen24 = asset('OIL-GEN', 'generator', '緊急發電機', { attrs: { fuel: 'diesel' } });
  obs(gen24, 'oil_consumption_l', '2024-01-01', '2025-01-01', 10000);
  ac = asset('GAS-REF', 'split_ac', '分離式冷氣', { attrs: { refrigerant: 'R-410A', qty: 10 } });
  obs(ac, 'ref_recharge_kg', '2022-01-01', '2023-01-01', 6.5); obs(ac, 'ref_recharge_kg', '2024-01-01', '2025-01-01', 6.5);
  acct = asset('ELE-GRID', 'power_account', '主電號', { externalKey: '18-31-1100-11-0' });
  for (let m = 1; m <= 12; m++) obs(acct, 'elec_purchased_kwh', `2024-${String(m).padStart(2, '0')}-01`, m === 12 ? '2025-01-01' : `2024-${String(m + 1).padStart(2, '0')}-01`, 100000);
  septic = asset('WAT-SEPTIC', 'septic_tank', '化糞池');
  A.setApplicability(col, septic, { applicability: 'applicable' });
  obs(actAsset('ACT-STAFF'), 'staff_hours', '2024-01-01', '2025-01-01', 1000000);
  obs(actAsset('ACT-PATIENT'), 'outpatient_visits', '2024-01-01', '2025-01-01', 100000);
  obs(actAsset('ACT-PATIENT'), 'inpatient_days', '2024-01-01', '2025-01-01', 30000);
  ds22 = D.createDataset(rep, { orgId: org, year: 2022 }).id; approveAll(ds22);
  ds24 = D.createDataset(rep, { orgId: org, year: 2024 }).id; approveAll(ds24);
});

test('111 年度：6.0.4 版係數＋AR4，與盤查表單範例（柴油 2,715.7340 公秉）逐位相同', () => {
  const r = calc.computeAll(ds22, ['ghg.s1.stationary', 'ghg.s1.refrigerant']).results;
  const s = r['ghg.s1.stationary'].trace.sources.find((x) => x.assetId === gen);
  assert.equal(s.ad, 2715.734); assert.equal(s.adUnit, '公秉');
  const [co2, ch4, n2o] = s.gases;
  assert.equal(co2.ef, 2.606031792); assert.equal(co2.t, 7077.2891); assert.equal(co2.tco2e, 7077.2891);
  assert.equal(ch4.ef, 0.0001055074); assert.equal(ch4.t, 0.2865); assert.equal(ch4.gwp, 25); assert.equal(ch4.tco2e, 7.1625);
  assert.equal(n2o.t, 0.0573); assert.equal(n2o.gwp, 298); assert.equal(n2o.tco2e, 17.0754);
  assert.equal(s.tco2e, 7101.527);
  assert.equal(r['ghg.s1.stationary'].trace.gwpSet, 'AR4');
  // 冷媒：6.5 kg → 0.0065 公噸 × R-410A AR4 2088
  const rf = r['ghg.s1.refrigerant'].trace.sources[0];
  assert.equal(rf.ad, 0.0065); assert.equal(rf.gases[0].gwp, 2088); assert.equal(rf.tco2e, 13.572);
  assert.equal(rf.gases[0].efClass, '1自廠發展係數/質量平衡所得係數');
});

test('113 年度：113 年公告係數（熱值 8,636）＋AR5；電力、冷媒、化糞池照表單捨入', () => {
  const r = calc.computeAll(ds24, ['ghg.total', 'ghg.uncertainty_pct', 'ghg.biogenic_co2', 'ghg.s1.gas.ch4']).results;
  const s = r['ghg.s1.stationary'].trace.sources.find((x) => x.assetId === gen24);
  assert.equal(s.ad, 10); assert.equal(s.gases[0].ef, 2.6792488757);
  assert.deepEqual(s.gases.map((g) => g.t), [26.7925, 0.0011, 0.0002]);
  assert.deepEqual(s.gases.map((g) => g.gwp), [1, 28, 265]);
  assert.equal(s.tco2e, 26.8763);
  const e = r['ghg.s2.electricity'].trace.sources[0];
  assert.equal(e.ad, 1200); assert.equal(e.adUnit, '千度'); assert.equal(e.tco2e, 568.8);
  const rf = r['ghg.s1.refrigerant'].trace.sources[0];
  assert.equal(rf.gases[0].gwp, 1923.5); assert.equal(rf.tco2e, 12.5028);
  // 化糞池：人時＝1,000,000 ＋ 100,000×2 ＋ 30,000×24；× 1.40625×10⁻⁷ 公噸CH₄/人時 × 28
  const sp = r['ghg.s1.septic'];
  assert.equal(sp.trace.personHours, 1920000); assert.equal(sp.trace.sources[0].gases[0].t, 0.27); assert.equal(sp.value, 7.56);
  const sum = [r['ghg.s1.stationary'], r['ghg.s1.refrigerant'], r['ghg.s1.septic'], r['ghg.s2.electricity']].reduce((t, x) => t + x.value, 0);
  assert.ok(Math.abs(r['ghg.total'].value - sum) < 1e-9);
  assert.equal(r['ghg.s1.gas.ch4'].value, 0.0308 + 7.56);
  // 不確定性：上下限分開，涵蓋比例
  const u = r['ghg.uncertainty_pct'].trace;
  assert.ok(u.lowerPct > 0 && u.upperPct > 0 && u.upperPct !== u.lowerPct);
  assert.ok(u.coveragePct > 0 && u.coveragePct <= 100);
});

test('報告：組織型溫室氣體盤查表單表一～表九，數字與計算引擎一致，XLSX 每表一工作表', async () => {
  const c = R.createCase(rep, { orgId: org, templateCode: 'GHG-FORM', year: 2024, datasetId: ds24 });
  const rd = R.readiness(rep, c.id);
  const blk = (k) => rd.fields.find((f) => f.field_id === k)?.block;
  for (const k of ['ghg_t1', 'ghg_t2', 'ghg_t3', 'ghg_t4', 'ghg_t5', 'ghg_t6', 'ghg_t7', 'ghg_t8', 'ghg_t9']) assert.ok(blk(k)?.tables?.length, k);
  const t5 = blk('ghg_t5').tables[0];
  const genRow = t5.rows.find((x) => x[3] === '緊急發電機');
  assert.equal(genRow[9], 10); assert.equal(genRow[10], '公秉'); assert.equal(genRow[11], 'CO2'); assert.equal(genRow[12], '預設'); assert.equal(genRow[13], 2.6792488757);
  assert.equal(genRow[t5.columns.indexOf('單一排放源排放當量小計（CO2e公噸/年）')], 26.8763);
  const t8 = blk('ghg_t8').tables.find((t) => t.sheet === '表八-4範疇別');
  const r = calc.computeAll(ds24, ['ghg.total']).results;
  assert.equal(t8.rows[0][8], Math.round(r['ghg.total'].value * 1000) / 1000);
  const t6 = blk('ghg_t6');
  assert.match(t6.text, /清冊總平均分數/);
  const t3 = blk('ghg_t3').tables[0];
  assert.ok(t3.rows.some((x) => x[4] === '0201' && x[7] === '170006'), '發電機 0201 柴油引擎、原燃物料 170006 柴油');
  const runId = R.generateRun(rep, c.id).id;
  const out = await X.exportRun(rep, runId, 'xlsx');
  const wb = readWorkbook(out.data);
  for (const name of ['表一', '表二', '表三', '表四', '表五', '表六', '表七', '表八-4範疇別', '表九']) assert.ok(wb.sheets.has(name), `缺工作表 ${name}`);
});

test('ISO 報告書：方法、GWP 段落依盤查年度說明係數版本', () => {
  const c = R.createCase(rep, { orgId: org, templateCode: 'GHG-INV', year: 2022, datasetId: ds22 });
  const rd = R.readiness(rep, c.id);
  const gwp = rd.fields.find((f) => f.field_id === 'gwp')?.block;
  if (gwp) assert.match(gwp.text, /第四次.*6\.0\.4/);
});

test('覆核修正：LPG 以公斤記錄、2019 年以前、無法計算時不列部分排放源、展開計算每筆 kgCO₂e', () => {
  const lpg = asset('GAS-LPG', 'lpg_cylinder', '廚房 LPG', { attrs: { fuel: 'lpg' } });
  obs(lpg, 'lpg_consumption_kg', '2018-01-01', '2019-01-01', 1000); obs(lpg, 'lpg_consumption_kg', '2021-01-01', '2022-01-01', 1000);
  const g18 = asset('OIL-GEN', 'generator', '發電機（107 年）', { attrs: { fuel: 'diesel' } });
  obs(g18, 'oil_consumption_l', '2018-01-01', '2019-01-01', 1000);
  const ds18 = D.createDataset(rep, { orgId: org, year: 2018 }).id; approveAll(ds18);
  const ds21 = D.createDataset(rep, { orgId: org, year: 2021 }).id; approveAll(ds21);
  for (const d of [ds18, ds21]) {
    const r = calc.computeAll(d, ['ghg.s1.stationary']).results['ghg.s1.stationary'];
    assert.notEqual(r.value_state, 'blocked', JSON.stringify(r.trace.notes));
    const s = r.trace.sources.find((x) => x.assetId === lpg);
    assert.equal(s.adUnit, '公噸'); assert.equal(s.ad, 1); assert.ok(r.trace.notes.some((n) => /能源署熱值/.test(n)));
  }
  const r18 = calc.computeAll(ds18, ['ghg.s1.stationary']).results['ghg.s1.stationary'];
  assert.equal(r18.trace.sources.find((x) => x.assetId === g18).gases[0].ef, 2.606031792, '2018 用 6.0.4 版');
  const inp = r18.trace.inputs.find((i) => i.assetId === g18);
  assert.ok(inp.kgCO2e > 0);
  const { allSources } = calc;
  assert.equal(allSources({ 'ghg.s1.stationary': { value: null, value_state: 'blocked', trace: { sources: [{ tco2e: 1, gases: [] }] } } }).length, 0);
});
