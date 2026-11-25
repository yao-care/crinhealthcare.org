// 環境部盤查表單（院方 Excel）匯入＋盤點樹「依盤查表單頁籤」檢視＋彙總標的不互相算缺
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-ghgsheets-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
mkdirSync(join(tmp, 'repo', 'src', 'content', 'hospitals'), { recursive: true });
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', '803.json'), JSON.stringify({ name: '國軍臺中總醫院' }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const O = await import('../src/platform/observations.js');
const D = await import('../src/platform/datasets.js');
const V = await import('../src/platform/validation.js');
const CFG = await import('../src/platform/config-store.js');
const calc = await import('../src/platform/calc.js');
const T = await import('../src/platform/inv-tree.js');
const GS = await import('../src/platform/ghg-sheets.js');
const E = await import('../src/platform/evidence.js');
const { buildWorkbook } = await import('../src/xlsx.js');

db.openDb(); runSeeds();
const q = db.q;
const org = authz.orgByHid('803').id;
const a1 = users.bootstrapSysadmin({ username: 'admin1', displayName: '管理員甲', password: 'Admin12345x' });
const a2 = users.bootstrapSysadmin({ username: 'admin2', displayName: '管理員乙', password: 'Admin12345y' });
const ctxOf = (id) => { q.run('UPDATE users SET must_change = 0 WHERE id = ?', id); return authz.contextFor({ uid: id }); };
const sa1 = ctxOf(a1); const sa2 = ctxOf(a2);
const mk = (u, roles) => ctxOf(users.createUser(sa1, { username: u, displayName: u, password: 'Passw0rd123', grants: roles.map((role) => ({ role, scopeType: 'org', scopeId: org })) }).id);
const col = mk('col', ['collector']); const rep = mk('rep', ['reporter']); const rv1 = mk('rv1', ['reviewer']); const rv2 = mk('rv2', ['reviewer']);
for (const f of q.all("SELECT id FROM factors WHERE status = 'pending' ORDER BY code, version")) CFG.publish(sa2, 'factor', f.id);
const legacy = users.ensureLegacyUser({ username: 'hosp-803', hid: '803', name: '國軍臺中總醫院', passwordHash: '!test' });
const hosp = authz.contextFor({ uid: legacy.uid });
const item = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code).id;

// ── 小型盤查表單：儲存格座標 → 工作表 ──
function sheet(name, cells) {
  const rows = [];
  for (const [ref, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref); const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1; const r = Number(m[2]) - 1;
    rows[r] = rows[r] || []; rows[r][col] = v;
  }
  for (let i = 0; i < rows.length; i++) rows[i] = rows[i] || [];
  return { name, rows };
}
const D0 = 44927; // 2023-01-01
function workbook({ diesel2 = 30 } = {}) {
  const mv = {
    A2: '公務車/工程車', B2: '柴油', D2: 60 + diesel2, A3: '公務車/工程車', B3: '95汽油', D3: 22, A4: '公務車/工程車', B4: '92汽油', D4: 18, A5: '公務車/工程車', B5: '尿素', D5: 10,
    F2: '範例', G2: '公務車', I2: 'APC-9999', J2: '年用量', K2: '95汽油', M2: 632,
    F5: '油料', G5: '公務車', I5: '軍D-1', J5: D0 + 2, K5: '92汽油', L5: 354, M5: 12,
    G6: '公務車', I6: '軍D-1', J6: D0 + 4, K6: '92汽油', L6: 180, M6: 6, // F 欄空白也要讀
    F7: '油料', G7: '公務車', I7: '軍C-2', J7: '2023/126', K7: '95汽油', L7: 700, M7: 22,
    F8: '油料', G8: '公務車', I8: '軍C-2', J8: '2023/8/8/', K8: '柴油', L8: 900, M8: diesel2,
    F9: '油料', G9: '救護車', I9: 'BRJ-1', J9: D0 + 40, K9: '柴油', L9: 2000, M9: 60,
    F10: '尿素', G10: '救護車', I10: 'BRJ-1', J10: D0 + 50, K10: '尿素', L10: 1131, M10: 10, N10: '維修明細',
  };
  const rf = {
    A4: 'R-134A', C4: 2.7, A5: 'R-32', C5: 1.16,
    E4: 'A01', F4: '門市部', G4: '會議室A201冷氣機', H4: '冷氣機', L4: 'R-410A', M4: 2.3, N4: 1, AA4: 0,
    F6: '行政組', G6: '宿舍', H6: '冷氣機', K6: 'MA28', L6: 'R-32', M6: 0.58, N6: 2, T6: 0.58, U6: 2, V6: '設備銘牌', Z6: '新購', AA6: 1.16,
    F7: '行政組', G7: '北機房', H7: '60RT氣冷式冰水主機', K7: 'TCW-60', L7: 'R-134A', M7: 60, N7: 3, S7: 2.7, V7: '主機保養紀錄', Z7: '維修', AA7: 2.7,
    F8: '行政組', G8: '宿舍', H8: '冷氣機', K8: 'MA40', L8: 'R-32', M8: 0.76, N8: 1, AA8: 0,
  };
  const ot = {
    A3: 'CO2', C3: 4.14,
    E3: 'A01', F3: '放射腫瘤科', G3: '1F', H3: 'CO2', I3: '5', J3: 2, L3: 5, P3: '採購單', R3: 4.14,
    E4: 'A02', F4: '醫療大樓', G4: '2F', H4: 'ABC', J4: 10, R4: 0,
    AC3: '行政大樓', AD3: '1F', AE3: 'GCB', AF3: 'SF1', AG3: 116, AH3: 0.001, AI3: 0.116, AJ3: '年度保養維護單',
  };
  const sp = {
    B2: 2023, D2: 1000 + 48 * 24,
    B5: '本院', C5: '輪班人員', O5: 800, B6: '外包', O6: 200, B7: '住院人日', O7: 48 * 24, B8: '空白', O8: 0,
  };
  const el = { A1: 2023, A2: '電號-1', E2: 1100 - 100 };
  const block = (r, label, vals) => {
    el[`A${r}`] = /^\d+$/.test(label) ? '電號-1' : '電號-2'; el[`B${r}`] = label; el[`A${r + 1}`] = '收據月份';
    vals.forEach((v, i) => { const k = r + 2 + i; el[`A${k}`] = `112/0${i + 1}月`; el[`B${k}`] = D0 + i * 31; el[`C${k}`] = D0 + i * 31 + 30; el[`L${k}`] = v; });
    el[`A${r + 2 + vals.length}`] = '合計';
  };
  block(13, '07600000001', [500, 600]);
  block(30, '外包廠商電度數', [40, 60]);
  const fx = { A5: '(緊急)發電機', B5: '柴油', D5: 300, F2: '範例', G2: '新北中和廠', J2: '(緊急)發電機', M2: '柴油', N2: '年用量', O2: 3330,
    G4: '本院', H4: '醫療大樓', J4: '(緊急)發電機', L4: 4, M4: '柴油', N4: D0 + 110, O4: 200, P4: '發票', Q4: '工程官室',
    G5: '本院', H5: '醫療大樓', J5: '(緊急)發電機', L5: 4, M5: '柴油', N5: D0 + 300, O5: 100, P5: '發票' };
  return buildWorkbook([sheet('類別1(固定)', fx), sheet('類別1(移動)', mv), sheet('類別1(冷煤)', rf), sheet('類別1(其它)', ot), sheet('類別1(化糞池調查表)', sp), sheet('類別2(用電量)', el)]).buffer;
}

test('日期：Excel 序號、正常日期、原檔打錯的 2023/126 與 2023/8/8/', () => {
  assert.equal(GS.readDate('44929').date, '2023-01-03');
  assert.deepEqual(GS.readDate('2023/126'), { date: '2023-01-26', fixed: '2023/126' });
  assert.deepEqual(GS.readDate('2023/8/8/'), { date: '2023-08-08', fixed: '2023/8/8/' });
  assert.equal(GS.readDate('2023-3-5').date, '2023-03-05');
  assert.equal(GS.readDate('年用量').date, null);
});

test('解析：範例列不匯入、逐列加總與原檔年總量一致、同車號兩種油分開、外包用電從電號扣除', () => {
  const p = GS.planWorkbook(workbook());
  assert.equal(p.year, 2023);
  const check = GS.compareTotals(p);
  assert.ok(check.length >= 6);
  for (const c of check) assert.ok(c.ok, `${c.label}：${c.mine} ↔ ${c.theirs}`);
  assert.ok(p.skipped.some((s) => s.sheet === '類別1(冷煤)' && s.row === 4), '冷煤範本範例列');
  assert.ok(!p.rows.some((r) => r.tab === 'mobile' && r.row === 2), '移動頁範例列');
  assert.ok(p.rows.some((r) => r.tab === 'mobile' && r.row === 6), 'F 欄空白的資料列也要讀');
  const names = new Set(p.rows.filter((r) => r.tab === 'mobile' && r.target).map((r) => r.target.create.name));
  assert.ok(names.has('公務車 軍C-2') && names.has('公務車 軍C-2（柴油）'), [...names].join('、'));
  const elec = p.rows.filter((r) => r.tab === 'electricity' && r.obs[0]?.metric === 'elec_purchased_kwh').map((r) => r.obs[0].value);
  assert.deepEqual(elec, [460, 540]);
  const urea = p.rows.find((r) => r.tab === 'mobile' && r.row === 10).obs[0];
  assert.equal(urea.metric, 'co2_use_kg');
  assert.equal(urea.value, Math.round(10 * 1.09 * 0.175 * 44.01 / 60.06 * 1e4) / 1e4);
  const sep = p.rows.filter((r) => r.tab === 'septic').flatMap((r) => r.obs);
  assert.deepEqual(sep.map((o) => [o.metric, o.value]), [['staff_hours', 1000], ['inpatient_days', 48]]);
});

test('匯入：沿用既有標的、建逐車與逐台標的；重匯不重複，改過的值成為新版本', async () => {
  // 2025 年以報告書總數建過的標的（應沿用，不重建）
  const tank = A.createAsset(col, { orgId: org, itemId: item('OIL-GEN'), assetType: 'fuel_tank', name: '緊急發電機柴油（全院合計）', attrs: { fuel: 'diesel' } }).id;
  const grid = A.createAsset(col, { orgId: org, itemId: item('ELE-GRID'), assetType: 'power_account', name: '受電點 11.4kV', externalKey: '07600000001' }).id;
  const r1 = await GS.importWorkbook(hosp, { orgId: org, filename: 'tc2023.xlsx', data: workbook(), apply: true });
  assert.ok(r1.check.every((c) => c.ok));
  assert.ok(!r1.assetsCreated.includes('緊急發電機柴油（全院合計）'));
  assert.ok(r1.assetsCreated.includes('公務車 軍D-1') && r1.assetsCreated.includes('外包廠商用電（盤查扣除）'));
  assert.equal(q.get("SELECT COUNT(*) n FROM observations WHERE asset_id = ? AND metric_code = 'oil_purchase_l'", tank).n, 2);
  assert.equal(q.get("SELECT SUM(value_std) s FROM observations WHERE asset_id = ? AND metric_code = 'elec_purchased_kwh'", grid).s, 1000);
  const ded = q.get("SELECT parent_asset_id, attrs FROM assets WHERE name = '外包廠商用電（盤查扣除）'");
  assert.equal(ded.parent_asset_id, grid);
  const v = q.get("SELECT applicability, external_key, attrs FROM assets WHERE name = '公務車 軍D-1'");
  assert.equal(v.applicability, 'applicable'); assert.equal(v.external_key, '軍D-1'); assert.equal(JSON.parse(v.attrs).fuel, 'gasoline');
  const gcb = q.get("SELECT a.attrs FROM assets a WHERE a.name LIKE 'GCB%'");
  assert.equal(JSON.parse(gcb.attrs).gas, 'SF6');
  assert.equal(q.get("SELECT value_state FROM observations WHERE metric_code = 'insul_gas_recharge_kg'").value_state, 'estimated');
  // 佐證：原檔進證據庫並連到每筆觀測
  assert.equal(q.get('SELECT COUNT(*) n FROM observations o LEFT JOIN observation_evidence e ON e.observation_id = o.id WHERE o.method = ? AND e.evidence_id IS NULL', 'import').n, 0);

  const r2 = await GS.importWorkbook(hosp, { orgId: org, filename: 'tc2023.xlsx', data: workbook(), apply: true });
  assert.equal(r2.observations.created, 0); assert.equal(r2.assetsCreated.length, 0);
  assert.equal(r2.observations.duplicate, r1.observations.created);
  // 院方改了一格（軍C-2 柴油 30 → 35）：只產生新版本
  const r3 = await GS.importWorkbook(hosp, { orgId: org, filename: 'tc2023-v2.xlsx', data: workbook({ diesel2: 35 }), apply: true });
  assert.equal(r3.observations.new_version, 1); assert.equal(r3.observations.created, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM ghg_sheet_rows WHERE org_id = ? AND year = 2023 AND sheet = ?', org, '類別1(移動)').n, 7);
});

test('頁籤檢視：左欄依頁籤列標的，中欄照原檔欄位列出並帶系統值；沒有原檔的年度列系統紀錄', () => {
  const tr = T.tree(hosp, org);
  const mob = tr.sheets.tabs.find((t) => t.key === 'mobile');
  assert.ok(mob.children.some((c) => c.name === '公務車 軍D-1'));
  assert.ok(mob.children.some((c) => /尿素/.test(c.name)), '車用尿素放在移動頁');
  assert.ok(tr.sheets.tabs.find((t) => t.key === 'electricity').children.some((c) => c.name === '外包廠商用電（盤查扣除）'));
  assert.ok(!tr.sheets.tabs.some((t) => t.key === 'steam'), '沒有標的的隱藏頁籤不列');

  const v = GS.tabView(hosp, org, 'mobile', 2023);
  assert.equal(v.year, 2023);
  const rows = v.parts[0].rows;
  const r7 = rows.find((r) => r.row === 7);
  assert.equal(r7.cells.I, '軍C-2'); assert.equal(r7.cells.J, '2023/126');
  assert.equal(r7.value.value, 22);
  const r8 = rows.find((r) => r.row === 8);
  assert.equal(r8.value.value, 35); assert.equal(r8.value.version, 2, '重匯改值後顯示新版本');
  const g = v.summary.find((s) => s.group === '公務車・95汽油');
  assert.equal(g.value, 22);

  const e = GS.tabView(hosp, org, 'electricity', 2023);
  assert.deepEqual(e.sheetTotal, { 年度合計: 1000 });
  assert.equal(e.summary.find((s) => s.metric === '外購電力用電量').value, 1000);

  // 2024 年只有系統紀錄（沒有原檔）
  const veh = q.get("SELECT id FROM assets WHERE name = '公務車 軍D-1'").id;
  O.addObservation(col, { assetId: veh, metricCode: 'oil_consumption_l', periodStart: '2024-01-01', periodEnd: '2024-02-01', rawValue: 40 });
  const v24 = GS.tabView(hosp, org, 'mobile', 2024);
  assert.equal(v24.parts.length, 0); assert.equal(v24.list.length, 1); assert.equal(v24.list[0].value, 40);
  assert.deepEqual(v24.years.slice(0, 2), [2024, 2023]);
});

function approveAll(dsId) {
  V.runValidation(rep, { orgId: org, year: q.get('SELECT year FROM datasets WHERE id = ?', dsId).year });
  D.proposeBulk(rep, { datasetId: dsId, reason: '單一來源、檢核通過' });
  for (const d of q.all("SELECT id FROM decisions WHERE dataset_id = ? AND status IN ('proposed','first_approved')", dsId)) {
    D.reviewDecision(rv1, d.id, { approve: true });
    if (q.get('SELECT status FROM decisions WHERE id = ?', d.id).status === 'first_approved') D.reviewDecision(rv2, d.id, { approve: true });
  }
}

test('彙總標的（14 輛合計）與逐車標的：各年度不互相算「缺活動數據」', async () => {
  // 2025 年只有報告書總數（彙總標的），沒有逐車資料
  const agg = A.createAsset(col, { orgId: org, itemId: item('OIL-VEH'), assetType: 'vehicle', name: '公務車 車用汽油（14 輛合計）', attrs: { fuel: 'gasoline' } }).id;
  A.setApplicability(col, agg, { applicability: 'applicable' });
  const aggRef = A.createAsset(col, { orgId: org, itemId: item('GAS-REF'), assetType: 'split_ac', name: '冷氣（合計）', attrs: { refrigerant: 'R-410A' } }).id;
  A.setApplicability(col, aggRef, { applicability: 'applicable' });
  const aggD = A.createAsset(col, { orgId: org, itemId: item('OIL-VEH'), assetType: 'vehicle', name: '公務車 柴油（14 輛合計）', attrs: { fuel: 'diesel' } }).id;
  A.setApplicability(col, aggD, { applicability: 'applicable' });
  for (const id of [agg, aggD, aggRef]) GS.markAggregate(col, id, '2025 年以報告書總數建立的合計標的');
  const ev = (await E.storeEvidence(col, { orgId: org, filename: 'report2025.pdf', data: Buffer.from('%PDF-1.4 report') })).id;
  O.addObservation(col, { assetId: agg, metricCode: 'oil_consumption_l', periodStart: '2025-01-01', periodEnd: '2026-01-01', rawValue: 5734 }, { evidenceIds: [ev] });
  O.addObservation(col, { assetId: aggD, metricCode: 'oil_consumption_l', periodStart: '2025-01-01', periodEnd: '2026-01-01', rawValue: 5601 }, { evidenceIds: [ev] });
  O.addObservation(col, { assetId: aggRef, metricCode: 'ref_recharge_kg', periodStart: '2025-01-01', periodEnd: '2026-01-01', rawValue: 18.5 }, { evidenceIds: [ev] });
  const ds25 = D.createDataset(rep, { orgId: org, year: 2025 }).id; approveAll(ds25);
  const r25 = calc.computeAll(ds25, ['ghg.s1.mobile', 'ghg.s1.refrigerant']).results;
  const notes25 = JSON.stringify([r25['ghg.s1.mobile'].trace.notes, r25['ghg.s1.refrigerant'].trace.notes]);
  assert.doesNotMatch(notes25, /軍D-1|軍C-2|宿舍/, notes25);
  assert.equal(r25['ghg.s1.mobile'].value_state, 'measured');

  // 2023 年有逐車資料；彙總標的沒資料也不算缺
  const ds23 = D.createDataset(rep, { orgId: org, year: 2023 }).id; approveAll(ds23);
  const r23 = calc.computeAll(ds23, ['ghg.s1.mobile', 'ghg.s1.refrigerant']).results;
  const notes23 = JSON.stringify([r23['ghg.s1.mobile'].trace.notes, r23['ghg.s1.refrigerant'].trace.notes]);
  assert.doesNotMatch(notes23, /合計/, notes23);
  assert.ok(r23['ghg.s1.mobile'].value > 0);
});
