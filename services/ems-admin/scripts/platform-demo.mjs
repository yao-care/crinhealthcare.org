#!/usr/bin/env node
// 示範資料（教育訓練、驗收展示用）：在「指定的」隔離資料庫建立一家院所一整年的油水電氣資料，
// 走完 建檔 → 來源 → 觀測 → 檢核 → 裁決 → 定版 → 報告。
// ⚠️ 只能用在隔離實例：必須明確設定 PLATFORM_DB，且不可是正式路徑（/opt/ems-admin）。
//   PLATFORM_DB=/tmp/x/platform.sqlite AUDIT_UPLOADS_DIR=/tmp/x/uploads REPO_DIR=... node scripts/platform-demo.mjs 803
process.env.PLATFORM_SCHEDULER = '0';
if (!process.env.PLATFORM_DB || process.env.PLATFORM_DB.startsWith('/opt/ems-admin')) {
  console.error('拒絕執行：請把 PLATFORM_DB 設成隔離實例的路徑（不可是正式資料）'); process.exit(1);
}
const hid = process.argv[2] || '803';
const year = Number(process.argv[3]) || new Date().getFullYear() - 1;
const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const S = await import('../src/platform/sources.js');
const E = await import('../src/platform/evidence.js');
const O = await import('../src/platform/observations.js');
const V = await import('../src/platform/validation.js');
const D = await import('../src/platform/datasets.js');
const R = await import('../src/platform/reports.js');
const CFG = await import('../src/platform/config-store.js');
db.openDb(); runSeeds();
const q = db.q;
const org = authz.orgByHid(hid); if (!org) { console.error(`找不到院所 ${hid}`); process.exit(1); }
const PW = process.env.DEMO_PW || 'Demo12345a';
const ensure = (username, name, roles, scope = 'org') => {
  let u = q.get('SELECT id FROM users WHERE username = ?', username);
  if (!u) {
    if (scope === 'global') { const id = users.bootstrapSysadmin({ username, displayName: name, password: PW }); u = { id }; }
    else {
      const sa = authz.contextFor({ uid: q.get("SELECT u.id FROM users u JOIN grants g ON g.user_id = u.id WHERE g.role = 'sysadmin' AND g.scope_type = 'global' LIMIT 1").id });
      u = users.createUser(sa, { username, displayName: name, password: PW, grants: roles.map((role) => ({ role, scopeType: 'org', scopeId: org.id })) });
    }
  }
  q.run('UPDATE users SET must_change = 0 WHERE id = ?', u.id);
  return authz.contextFor({ uid: u.id });
};
const sa1 = ensure('demo-admin', '示範系統管理員', [], 'global');
const sa2 = ensure('demo-admin2', '示範系統管理員二', [], 'global');
const col = ensure('demo-collector', '王盤點', ['collector', 'custodian']);
const rep = ensure('demo-reporter', '李報告', ['reporter']);
const rv1 = ensure('demo-reviewer', '陳審核', ['reviewer']);
const rv2 = ensure('demo-reviewer2', '林覆核', ['reviewer']);
const apv = ensure('demo-approver', '張核准', ['approver']);
ensure('demo-manager', '趙主管', ['manager']); ensure('demo-staff', '周同仁', ['staff']); ensure('demo-auditor', '吳稽核', ['auditor']);
for (const f of q.all("SELECT id FROM factors WHERE status = 'pending'")) CFG.publish(sa2, 'factor', f.id, { impactAck: true });

const item = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code).id;
const mkA = (code, type, name, extra = {}) => q.get("SELECT id FROM assets WHERE org_id = ? AND name = ?", org.id, name)?.id
  || A.createAsset(col, { orgId: org.id, itemId: item(code), assetType: type, name, ...extra }).id;
const grid = mkA('ELE-GRID', 'power_account', '主電號（高壓）', { externalKey: '07-1234-56-789', externalKeySensitive: true, location: '行政大樓 B1 變電站' });
const tap = mkA('WAT-TAP', 'water_account', '自來水總表', { externalKey: 'W-0420-118', location: '大門口' });
const tank = mkA('OIL-GEN', 'fuel_tank', '緊急發電機共用柴油槽', { externalKey: 'TANK-B2', attrs: { fuel: 'diesel' }, location: 'B2 機房', shared: true });
const gen1 = mkA('OIL-GEN', 'generator', '1 號緊急發電機', { externalKey: 'GEN-01', attrs: { fuel: 'diesel' }, location: 'B2 機房' });
const gen2 = mkA('OIL-GEN', 'generator', '2 號緊急發電機', { externalKey: 'GEN-02', attrs: { fuel: 'diesel' }, location: 'B2 機房' });
const car = mkA('OIL-VEH', 'vehicle', '公務車 ABC-1234', { externalKey: 'ABC-1234', attrs: { fuel: 'gasoline' } });
const ng = mkA('GAS-NG', 'gas_account', '廚房天然氣', { externalKey: 'G-55821', attrs: { fuel: 'ng' } });
const chiller = mkA('GAS-REF', 'chiller', '1 號冰水主機', { externalKey: 'CH-01', attrs: { refrigerant: 'R-134a' }, location: '中央空調機房' });
const ac = mkA('GAS-REF', 'split_ac', '護理站分離式冷氣', { attrs: { refrigerant: 'R-410A' } });
mkA('GAS-REF', 'split_ac', '舊型窗型冷氣（R-22）', { attrs: { refrigerant: 'R-22' } });
const ems = mkA('ELE-SUB', 'power_meter', 'A 棟 EMS 主表', { location: 'A 棟' });
for (const [p, c, r] of [[tank, gen1, 'feeds'], [tank, gen2, 'feeds'], [grid, ems, 'submeter_of']]) if (!q.get('SELECT 1 FROM asset_links WHERE parent_id = ? AND child_id = ?', p, c)) A.linkAssets(col, { parentId: p, childId: c, relation: r });
for (const id of [grid, tap, tank, gen1, gen2, car, ng, chiller, ac, ems]) A.setApplicability(col, id, { applicability: 'applicable' });

const src = (assetId, name, type, acq, pr) => q.get('SELECT id FROM data_sources WHERE asset_id = ? AND name = ?', assetId, name)?.id || S.saveSource(col, { orgId: org.id, assetId, name, sourceType: type, acquisition: acq, priority: pr }).id;
const bill = src(grid, '台電電費帳單', 'bill', 'import', 90); const emsSrc = src(ems, 'EMS 智慧電表', 'ems', 'api', 60);
const water = src(tap, '自來水帳單', 'bill', 'import', 90); const tankSrc = src(tank, '工務室油槽量測紀錄', 'record', 'manual', 70);
const carSrc = src(car, '油卡加油紀錄', 'record', 'import', 80); const ngSrc = src(ng, '欣中天然氣帳單', 'bill', 'import', 90);
const refSrc = src(chiller, '冰水主機維修保養紀錄', 'record', 'manual', 70);
const ev = await E.storeEvidence(col, { orgId: org.id, filename: `示範佐證-${year}.pdf`, data: Buffer.from(`%PDF-1.4 demo evidence ${hid} ${year}`) });
const put = (assetId, metric, ps, pe, v, sourceId, key, extra = {}) => O.addObservation(col, { assetId, metricCode: metric, periodStart: ps, periodEnd: pe, rawValue: v, sourceId, sourceRecordKey: key, ...extra }, { evidenceIds: [ev.id] });
const mm = (m) => String(m).padStart(2, '0');
const next = (y, m) => (m === 12 ? `${y + 1}-01-01` : `${y}-${mm(m + 1)}-01`);
const kwh = [312000, 286000, 301000, 318000, 352000, 401000, 438000, 446000, 409000, 362000, 318000, 309000];
for (let m = 1; m <= 12; m++) {
  const ps = `${year}-${mm(m)}-01`; const pe = next(year, m);
  put(grid, 'elec_purchased_kwh', ps, pe, kwh[m - 1], bill, `TPC-${year}${mm(m)}`);
  put(grid, 'elec_cost_twd', ps, pe, Math.round(kwh[m - 1] * 3.9), bill, `TPC-${year}${mm(m)}-fee`);
  put(grid, 'elec_peak_demand_kw', ps, pe, Math.round(kwh[m - 1] / 420), bill, `TPC-${year}${mm(m)}-kw`);
  put(ems, 'elec_metered_kwh', ps, pe, Math.round(kwh[m - 1] * (m === 7 ? 0.82 : 0.97)), emsSrc, `EMS-${year}${mm(m)}`, { boundaryNote: 'A 棟主表' });
  put(tap, 'water_withdrawal_m3', ps, pe, 9800 + m * 120, water, `W-${year}${mm(m)}`);
  put(car, 'oil_consumption_l', ps, pe, 160 + (m % 3) * 20, carSrc, `CAR-${year}${mm(m)}`);
  put(ng, 'ng_consumption_m3', ps, pe, 2100 - m * 30, ngSrc, `NG-${year}${mm(m)}`);
}
put(tank, 'oil_stock_l', `${year}-01-01`, `${year}-01-01`, 3800, tankSrc, `STOCK-${year}0101`);
put(tank, 'oil_purchase_l', `${year}-06-10`, `${year}-06-11`, 2000, tankSrc, `PUR-${year}0610`);
put(tank, 'oil_stock_l', `${year}-12-31`, `${year}-12-31`, 4300, tankSrc, `STOCK-${year}1231`);
put(gen1, 'gen_test_runtime_h', `${year}-01-01`, `${year + 1}-01-01`, 24, null, `GEN1-TEST-${year}`);
put(gen1, 'gen_outage_runtime_h', `${year}-01-01`, `${year + 1}-01-01`, 3.5, null, `GEN1-OUT-${year}`);
put(chiller, 'ref_charge_kg', `${year}-01-01`, `${year}-01-01`, 380, refSrc, `CH-PLATE`);
put(chiller, 'ref_recharge_kg', `${year}-08-01`, `${year}-08-02`, 12, refSrc, `CH-RECHG-${year}`);
const act = (code) => q.get('SELECT a.id FROM assets a JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code = ?', org.id, code).id;
put(act('ACT-CAP'), 'beds', `${year}-12-31`, `${year}-12-31`, 620, null, `BEDS-${year}`);
put(act('ACT-CAP'), 'floor_area_m2', `${year}-12-31`, `${year}-12-31`, 86000, null, `AREA-${year}`);
put(act('ACT-STAFF'), 'staff_count', `${year}-12-31`, `${year}-12-31`, 1450, null, `STAFF-${year}`);

V.runValidation(rep, { orgId: org.id, year });
let ds = q.get("SELECT id FROM datasets WHERE org_id = ? AND year = ? AND status = 'draft'", org.id, year)?.id;
if (!ds) ds = D.createDataset(rep, { orgId: org.id, year, name: `${year} 年度共用資料集（示範）` }).id;
const bulk = D.proposeBulk(rep, { datasetId: ds, reason: '單一來源、檢核通過' });
// 柴油消耗：存量平衡推估（衍生值）
D.proposeDecision(rep, { datasetId: ds, assetId: gen1, metricCode: 'oil_consumption_l', periodStart: `${year}-01-01`, periodEnd: `${year + 1}-01-01`, decisionType: 'derived', value: 1500,
  method: { kind: 'stock_balance', formula: '3800 + 2000 − 4300 = 1500（兩台共用油槽，全部計入 1 號機帳上，2 號機不重複計）' }, reason: '無獨立油表，依核准的存量平衡推估' });
for (const x of D.listPendingDecisions(rv1, { orgId: org.id })) {
  const r = D.reviewDecision(rv1, x.id, { approve: true });
  if (r.status === 'first_approved') D.reviewDecision(rv2, x.id, { approve: true });
}
D.submitDataset(rep, ds); D.approveDataset(rv1, ds); D.lockDataset(rv1, ds);
const c = R.createCase(rep, { orgId: org.id, templateCode: 'GHG-INV', year, datasetId: ds, name: `${year} 年度溫室氣體盤查（示範）` });
const run = R.generateRun(rep, c.id);
R.createCase(rep, { orgId: org.id, templateCode: 'ISO50001', year, datasetId: ds });
console.log(JSON.stringify({ org: org.name, year, users: `帳號 demo-collector／demo-reporter／demo-reviewer／demo-reviewer2／demo-approver／demo-manager／demo-staff／demo-auditor／demo-admin，密碼 ${PW}`, bulk, dataset: ds, reportCase: c.id, run: run.id }, null, 2));
