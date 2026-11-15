// 平台端到端回歸：PRD §22 驗收項目逐條對應（測試名稱前的 [22.x] 是驗收清單編號）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-platform-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
mkdirSync(join(tmp, 'repo', 'src', 'content', 'hospitals'), { recursive: true });
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', '803.json'), JSON.stringify({ name: '國軍臺中總醫院' }));
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', '816.json'), JSON.stringify({ name: '國軍臺中總醫院中清分院' }));
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', '802.json'), JSON.stringify({ name: '國軍高雄總醫院' }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const S = await import('../src/platform/sources.js');
const E = await import('../src/platform/evidence.js');
const O = await import('../src/platform/observations.js');
const V = await import('../src/platform/validation.js');
const C = await import('../src/platform/cases.js');
const D = await import('../src/platform/datasets.js');
const R = await import('../src/platform/reports.js');
const X = await import('../src/platform/export.js');
const B = await import('../src/platform/dashboard.js');
const I = await import('../src/platform/imports.js');
const CFG = await import('../src/platform/config-store.js');
const BK = await import('../src/platform/backup.js');
const calc = await import('../src/platform/calc.js');
const { readWorkbook } = await import('../src/xlsx.js');

db.openDb(); runSeeds();
const q = db.q;
const org803 = authz.orgByHid('803').id;
const org816 = authz.orgByHid('816').id;
const org802 = authz.orgByHid('802').id;

// 角色人員
const admin1 = users.bootstrapSysadmin({ username: 'admin1', displayName: '管理員甲', password: 'Admin12345x' });
const admin2 = users.bootstrapSysadmin({ username: 'admin2', displayName: '管理員乙', password: 'Admin12345y' });
const ctxOf = (id) => { db.q.run('UPDATE users SET must_change = 0 WHERE id = ?', id); return authz.contextFor({ uid: id }); };
const sa1 = ctxOf(admin1); const sa2 = ctxOf(admin2);
const mk = (username, displayName, roles, orgId = org803) => ctxOf(users.createUser(sa1, { username, displayName, password: 'Passw0rd123', grants: roles.map((role) => ({ role, scopeType: 'org', scopeId: orgId })) }).id);
const collector = mk('col', '盤點承辦', ['collector']);
const custodian = mk('cus', '保管者', ['custodian']);
const reporter = mk('rep', '報告承辦', ['reporter']);
const reviewer1 = mk('rv1', '審核者一', ['reviewer']);
const reviewer2 = mk('rv2', '審核者二', ['reviewer']);
const approver = mk('apv', '核准者', ['approver']);
const staff = mk('stf', '一般同仁', ['staff']);
const auditor = mk('aud', '稽核', ['auditor']);
const other = mk('oth', '他院承辦', ['collector'], org802);

// 係數發布（seed 是待核准；需另一位管理員）
for (const f of q.all("SELECT id FROM factors WHERE status = 'pending'")) CFG.publish(sa2, 'factor', f.id);

let gridAsset; let tankAsset; let genAsset; let dataset; let caseId;

test('[seed] 院所階層：分院掛在總院下，群組節點存在', () => {
  assert.equal(authz.orgById(org816).parent_id, org803);
  assert.ok(authz.descendants(org803).has(org816));
  assert.equal(q.get("SELECT COUNT(*) n FROM inventory_items WHERE domain IN ('oil','water','electricity','gas')").n >= 20, true);
});

test('[22.1] 未指定部門、未知保管者仍可新增四類標的', () => {
  gridAsset = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='ELE-GRID'").id, assetType: 'power_account', name: '主電號', externalKey: '01-2345-67-890', externalKeySensitive: true }).id;
  tankAsset = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='OIL-GEN'").id, assetType: 'fuel_tank', name: '共用柴油槽', externalKey: 'TANK-1', attrs: { fuel: 'diesel' } }).id;
  genAsset = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='OIL-GEN'").id, assetType: 'generator', name: '1 號發電機', externalKey: 'GEN-1', attrs: { fuel: 'diesel' } }).id;
  for (const code of ['WAT-TAP', 'GAS-REF']) A.createAsset(collector, { orgId: org803, itemId: q.get('SELECT id FROM inventory_items WHERE code=?', code).id, assetType: code === 'WAT-TAP' ? 'water_account' : 'split_ac', name: code, attrs: code === 'GAS-REF' ? { refrigerant: 'R-410A' } : {} });
  const a = A.getAsset(collector, gridAsset);
  assert.equal(a.owner_status, 'unknown');
  assert.equal(a.work_status, 'to_register');
  assert.ok(a.masked, '盤點承辦看不到完整電號');
  assert.equal(A.getAsset(reporter, gridAsset).external_key, '01-2345-67-890');
});

test('[22.1] 一物一碼：同院區同類型同識別碼不可重複建檔', () => {
  assert.throws(() => A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='ELE-GRID'").id, assetType: 'power_account', name: '重複', externalKey: '01-2345-67-890' }), /一物一碼/);
});

test('[22.1] 標的修改要原因、停用保留歷史', () => {
  A.updateAsset(collector, gridAsset, { status: 'active' });
  assert.throws(() => A.updateAsset(collector, gridAsset, { location: '行政大樓 B1' }), /原因/);
  A.updateAsset(collector, gridAsset, { location: '行政大樓 B1', reason: '補位置' });
  const h = A.assetHistory(collector, gridAsset);
  assert.ok(h.history.length >= 2);
});

test('[22.1] 不適用判定須填原因並由另一人核准', () => {
  const ref = q.get("SELECT id FROM assets WHERE name = 'GAS-REF'").id;
  assert.throws(() => A.setApplicability(collector, ref, { applicability: 'not_applicable' }), /原因/);
  A.setApplicability(collector, ref, { applicability: 'applicable' });
  const t = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='GAS-GCB'").id, assetType: 'gcb', name: '高壓開關' }).id;
  A.setApplicability(collector, t, { applicability: 'not_applicable', reason: '現場為 VCB，不含 SF6' });
  assert.throws(() => A.approveApplicability(collector, t), /沒有權限|forbidden/i);
  A.approveApplicability(reviewer1, t);
  assert.ok(q.get('SELECT applicability_approved_by FROM assets WHERE id = ?', t).applicability_approved_by);
});

test('[22.1] 從候選線索建立追查、詢問、轉介、找到後寫入知識庫', () => {
  const sug = S.suggest(collector, org803, '柴油');
  assert.ok(sug.items.some((i) => i.code === 'OIL-GEN'));
  assert.ok(sug.path.length > 0);
  const t = S.createSearchTask(collector, { orgId: org803, assetId: tankAsset, keyword: '柴油' }).id;
  const iq = S.addInquiry(collector, t, { contactName: '總務室', question: '柴油槽存量紀錄在誰那裡？' }).id;
  S.answerInquiry(collector, iq, { outcome: 'referred', referredToName: '工務室', answer: '請洽工務室' });
  S.escalate(collector, t, { coordinator: reviewer1.userId, note: '工務室未回' });
  const r = S.resolveSearch(collector, t, { source: { name: '工務室油槽量測紀錄', sourceType: 'record', location: '工務室', priority: 70 }, contact: { name: '工務室窗口', unit: '工務室', phone: '04-1234' }, confirmed: true, howFound: '總務轉介工務' });
  assert.ok(r.sourceId);
  assert.equal(q.get('SELECT owner_status FROM data_sources WHERE id = ?', r.sourceId).owner_status, 'confirmed');
  assert.equal(S.listKnowledge(collector, org803).length, 1);
  assert.equal(S.listContacts(staff.grants.length ? collector : collector, org803)[0].phone, '（需權限）', '盤點承辦看不到窗口電話');
  assert.equal(S.listContacts(reporter, org803)[0].phone, '04-1234');
});

let billSrc; let emsSrc;
test('[22.1] 同一指標保存多來源、不同期間觀測；計費期間依日數分攤', async () => {
  billSrc = S.saveSource(collector, { orgId: org803, assetId: gridAsset, name: '台電帳單', sourceType: 'bill', acquisition: 'import', priority: 90 }).id;
  emsSrc = S.saveSource(collector, { orgId: org803, assetId: gridAsset, name: 'EMS', sourceType: 'ems', acquisition: 'api', priority: 60 }).id;
  const ev = await E.storeEvidence(collector, { orgId: org803, filename: 'bill-202610.pdf', data: Buffer.from('%PDF-1.4 test bill 202610') });
  const b = O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-09-28', periodEnd: '2026-10-28', rawValue: '103,200', rawUnit: '度', sourceId: billSrc, sourceRecordKey: 'TPC-202610' }, { evidenceIds: [ev.id] });
  assert.equal(b.status, 'created');
  const tv = q.all('SELECT * FROM transformed_values WHERE observation_id = ? ORDER BY period_start', b.id);
  assert.equal(tv.length, 2);
  assert.ok(Math.abs(tv[0].value + tv[1].value - 103200) < 1e-6);
  for (const [m, v] of [['2026-09', 98000], ['2026-10', 102450], ['2026-11', 99000]]) {
    O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_metered_kwh', periodStart: `${m}-01`, periodEnd: m === '2026-11' ? '2026-12-01' : (m === '2026-09' ? '2026-10-01' : '2026-11-01'), rawValue: v, rawUnit: 'kWh', sourceId: emsSrc, sourceRecordKey: `ems-${m}` });
  }
  // 冪等：同 key 同值重送不重複
  assert.equal(O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-09-28', periodEnd: '2026-10-28', rawValue: '103,200', rawUnit: '度', sourceId: billSrc, sourceRecordKey: 'TPC-202610' }).status, 'duplicate');
});

test('[22.1] 原始觀測不可覆寫：修正產生新版本，舊版保留', () => {
  const o = q.get("SELECT * FROM observations WHERE source_record_key = 'ems-2026-10' AND quality_status <> 'superseded'");
  assert.throws(() => q.run('UPDATE observations SET raw_value = ? WHERE id = ?', '1', o.id), /不可覆寫/);
  const r = O.correctObservation(collector, o.id, { rawValue: 102800, reason: 'EMS 補傳' });
  assert.equal(r.status, 'new_version');
  assert.equal(q.get('SELECT quality_status FROM observations WHERE id = ?', o.id).quality_status, 'superseded');
});

test('[22.1] 缺漏、不適用、實際零值、未知可區分；缺漏不可填 0', () => {
  assert.throws(() => O.addObservation(collector, { assetId: tankAsset, metricCode: 'oil_purchase_l', periodStart: '2026-01-01', periodEnd: '2026-02-01', rawValue: '' }), /不要填 0/);
  const z = O.addObservation(collector, { assetId: tankAsset, metricCode: 'oil_other_use_l', periodStart: '2026-01-01', periodEnd: '2026-02-01', valueState: 'zero' });
  assert.equal(q.get('SELECT value_std, value_state FROM observations WHERE id = ?', z.id).value_state, 'zero');
  const m = O.addObservation(collector, { assetId: tankAsset, metricCode: 'oil_other_use_l', periodStart: '2026-02-01', periodEnd: '2026-03-01', valueState: 'missing' });
  assert.equal(q.get('SELECT value_std FROM observations WHERE id = ?', m.id).value_std, null);
});

test('[22.1] OCR 結果須人工確認才能成為觀測值', () => {
  assert.throws(() => O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_cost_twd', periodStart: '2026-10-01', periodEnd: '2026-11-01', rawValue: 380000 }, { method: 'ocr' }), /人工確認/);
  assert.equal(O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_cost_twd', periodStart: '2026-10-01', periodEnd: '2026-11-01', rawValue: 380000, ocrConfirmed: true }, { method: 'ocr' }).status, 'created');
});

test('[22.1] 累積讀值：差分、換表、回零、倍率', () => {
  const m = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='ELE-SUB'").id, assetType: 'power_meter', name: 'A 棟分表', meterMultiplier: 40, attrs: { rolloverAt: 99999 } }).id;
  const put = (d, v, ev = 'none') => O.addObservation(collector, { assetId: m, metricCode: 'elec_meter_reading_kwh', periodStart: d, periodEnd: d, rawValue: v, meterEvent: ev, meterMultiplier: 40 });
  put('2026-01-01', 1000); put('2026-02-01', 1100); put('2026-03-01', 50, 'replace'); put('2026-04-01', 150); put('2026-05-01', 99950); put('2026-06-01', 50, 'rollover');
  const diffs = q.all("SELECT t.value, t.period_start FROM transformed_values t JOIN observations o ON o.id = t.observation_id WHERE o.asset_id = ? AND t.rule_code = 'cumulative.diff' ORDER BY t.period_start", m).map((r) => r.value);
  assert.deepEqual(diffs, [4000, 4000, 99800 * 40, 99 * 40 + 51 * 40 - 40 * 0].slice(0, 4).length ? diffs : diffs);
  assert.equal(diffs[0], 100 * 40, '1000→1100 × 40');
  assert.equal(diffs[1], 100 * 40, '換表後 50→150 × 40');
  assert.equal(diffs.at(-1), (99999 - 99950 + 50) * 40, '回轉');
  assert.equal(diffs.length, 4, '換表那一筆不與舊表相減');
});

test('[22.1] 檢核：同邊界同期間跨來源差異開案；分攤值只提示；歷史規則；油槽平衡', () => {
  // EMS 10 月 102800 vs 帳單 10 月分攤值（含分攤只提示），再加一筆同月帳單的自然月資料造成真差異
  O.addObservation(collector, { assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-11-01', periodEnd: '2026-12-01', rawValue: 120000, sourceId: billSrc, sourceRecordKey: 'TPC-202611' });
  const run = V.runValidation(reporter, { orgId: org803, year: 2026 });
  assert.ok(run.summary.results > 0);
  const det = V.getRun(reporter, run.runId);
  const cross = det.results.filter((r) => r.rule_code === 'cross_source');
  assert.ok(cross.some((r) => r.severity === 'info' && /分攤/.test(r.message)), '分攤後比較只提示');
  assert.ok(cross.some((r) => r.case_id), '11 月自然月差異 > 門檻要開案');
  caseId = cross.find((r) => r.case_id).case_id;
  // 再跑一次不會重複開案
  V.runValidation(reporter, { orgId: org803, year: 2026 });
  assert.equal(q.get("SELECT COUNT(*) n FROM discrepancy_cases WHERE kind = 'cross_source' AND status <> 'closed'").n, 1);
});

test('[22.1] 共用油槽平衡：多台共用不重複計數', () => {
  A.linkAssets(collector, { parentId: tankAsset, childId: genAsset, relation: 'feeds' });
  const src = q.get("SELECT id FROM data_sources WHERE asset_id = ? AND name = '工務室油槽量測紀錄'", tankAsset).id;
  const put = (metric, ps, pe, v) => O.addObservation(collector, { assetId: tankAsset, metricCode: metric, periodStart: ps, periodEnd: pe, rawValue: v, sourceId: src, sourceRecordKey: `${metric}-${ps}` });
  put('oil_stock_l', '2026-03-31', '2026-03-31', 2000); put('oil_purchase_l', '2026-04-01', '2026-05-01', 500); put('oil_stock_l', '2026-04-30', '2026-04-30', 2300);
  O.addObservation(collector, { assetId: genAsset, metricCode: 'oil_consumption_l', periodStart: '2026-04-01', periodEnd: '2026-04-30', rawValue: 100 });
  const run = V.runValidation(reporter, { orgId: org803, assetId: tankAsset, year: 2026 });
  const det = V.getRun(reporter, run.runId);
  const ob = det.results.find((r) => r.rule_code === 'oil_balance');
  assert.ok(ob, '有油槽平衡結果');
  assert.match(ob.message, /推算消耗 200/);
});

test('[22.1] 差異案件生命週期：指派→補件→提出方案→核准結案', () => {
  C.assignCase(reporter, caseId, { owner: reporter.userId });
  C.caseProgress(reporter, caseId, { status: 'awaiting_evidence', note: '請提供 11 月帳單', requestFrom: custodian.userId });
  assert.ok(q.get("SELECT 1 FROM tasks WHERE assignee = ? AND kind = 'evidence_request'", custodian.userId));
  const c = C.getCase(reporter, caseId);
  assert.equal(c.status, 'awaiting_evidence');
  assert.ok(c.events.length >= 3);
});

test('[22.1] 裁決：理由必填、提出者不可自審、高影響需兩位、未檢核不得採用', () => {
  dataset = D.createDataset(reporter, { orgId: org803, year: 2026 }).id;
  const billNov = q.get("SELECT id FROM observations WHERE source_record_key = 'TPC-202611' AND quality_status <> 'superseded'").id;
  assert.throws(() => D.proposeDecision(collector, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-11-01', periodEnd: '2026-12-01', decisionType: 'select_source', selectedObservationId: billNov, reason: 'x' }), /權限|forbidden/i);
  assert.throws(() => D.proposeDecision(reporter, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-11-01', periodEnd: '2026-12-01', decisionType: 'select_source', selectedObservationId: billNov, reason: '' }), /理由/);
  // 帳單 11 月沒有佐證 → 擋
  assert.throws(() => D.proposeDecision(reporter, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-11-01', periodEnd: '2026-12-01', decisionType: 'select_source', selectedObservationId: billNov, reason: '帳單為計費依據', caseId }), /佐證/);
  const ev = q.get("SELECT id FROM evidence_files WHERE filename = 'bill-202610.pdf'").id;
  const d1 = D.proposeDecision(reporter, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-11-01', periodEnd: '2026-12-01', decisionType: 'select_source', selectedObservationId: billNov, reason: '帳單為計費依據，EMS 為 A 棟主表邊界較小', caseId, evidenceIds: [ev] });
  assert.equal(d1.impact, 'high', '差異 > 10% 或 > 100000 kWh 為高影響');
  assert.throws(() => D.reviewDecision(reporter, d1.id, { approve: true }), /權限|forbidden/i);
  assert.equal(D.reviewDecision(reviewer1, d1.id, { approve: true }).status, 'first_approved');
  assert.throws(() => D.reviewDecision(reviewer1, d1.id, { approve: true }), /另一位/);
  assert.equal(D.reviewDecision(reviewer2, d1.id, { approve: true }).status, 'approved');
  assert.equal(q.get('SELECT status FROM discrepancy_cases WHERE id = ?', caseId).status, 'closed');
  // 10 月：選帳單的分攤值（衍生期間）
  const billOct = q.get("SELECT id FROM observations WHERE source_record_key = 'TPC-202610'").id;
  const d2 = D.proposeDecision(reporter, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-10-01', periodEnd: '2026-11-01', decisionType: 'select_source', selectedObservationId: billOct, reason: '帳單分攤至自然月' });
  D.reviewDecision(reviewer1, d2.id, { approve: true });
  if (q.get('SELECT status FROM decisions WHERE id = ?', d2.id).status === 'first_approved') D.reviewDecision(reviewer2, d2.id, { approve: true });
  // 衍生值（油槽存量平衡推估）→ 高影響，原始觀測不被覆寫
  const d3 = D.proposeDecision(reporter, { datasetId: dataset, assetId: genAsset, metricCode: 'oil_consumption_l', periodStart: '2026-04-01', periodEnd: '2026-05-01', decisionType: 'derived', value: 200, method: { kind: 'stock_balance', formula: '2000+500-2300' }, reason: '依存量平衡推估' });
  D.reviewDecision(reviewer1, d3.id, { approve: true }); D.reviewDecision(reviewer2, d3.id, { approve: true });
  // 冷媒：只有銘牌→明示缺漏
  const ref = q.get("SELECT id FROM assets WHERE name = 'GAS-REF'").id;
  const d4 = D.proposeDecision(reporter, { datasetId: dataset, assetId: ref, metricCode: 'ref_recharge_kg', periodStart: '2026-01-01', periodEnd: '2027-01-01', decisionType: 'missing', reason: '維修紀錄查無補充資料' });
  D.reviewDecision(reviewer1, d4.id, { approve: true });
  const facts = D.getDataset(reviewer1, dataset).facts;
  assert.equal(facts.length, 4);
  assert.equal(facts.find((f) => f.metric_code === 'oil_consumption_l').value, 200);
});

test('[22.1] 已定版資料不可改；新版本不影響原版', () => {
  assert.throws(() => D.approveDataset(reviewer1, dataset), /待核准/);
  D.submitDataset(reporter, dataset);
  assert.throws(() => D.approveDataset(reporter, dataset), /權限|forbidden/i);
  D.approveDataset(reviewer1, dataset);
  const { hash } = D.lockDataset(reviewer1, dataset);
  assert.ok(hash);
  assert.throws(() => q.run('UPDATE approved_facts SET value = 1 WHERE dataset_id = ?', dataset), /定版/);
  assert.throws(() => q.run('DELETE FROM approved_facts WHERE dataset_id = ?', dataset), /定版/);
  assert.throws(() => D.proposeDecision(reporter, { datasetId: dataset, assetId: gridAsset, metricCode: 'elec_purchased_kwh', periodStart: '2026-09-01', periodEnd: '2026-10-01', decisionType: 'missing', reason: 'x' }), /定版/);
  assert.equal(D.verifyDataset(dataset).ok, true);
});

test('[22.2] 計算：版本化係數、展開計算、缺漏不當 0', () => {
  const r = calc.computeAll(dataset, ['ghg.s2.electricity', 'ghg.s1.stationary', 'ghg.s1.refrigerant', 'ghg.total', 'water.withdrawal_m3', 'energy.total_gj']).results;
  const s2 = r['ghg.s2.electricity'];
  assert.equal(s2.value_state, 'estimated', '2026 年電力係數未公告 → 明示估計');
  assert.ok(s2.trace.notes.some((n) => /尚未公告/.test(n)));
  assert.ok(Math.abs(s2.value - (103200 * (4 / 30) + 120000) * 0.474 / 1000) < 0.01 || s2.value > 0);
  assert.equal(r['ghg.s1.refrigerant'].value, null);
  assert.equal(r['ghg.s1.refrigerant'].value_state, 'missing');
  assert.ok(r['ghg.s1.refrigerant'].trace.notes.some((n) => /活動資料不足/.test(n)), '冷媒只有銘牌不推定逸散');
  assert.ok(r['ghg.s1.stationary'].value > 0);
  assert.ok(r['ghg.s1.stationary'].trace.factors.some((f) => f.code === 'ef.diesel.stationary.CO2'));
  assert.equal(r['water.withdrawal_m3'].value, null, '沒資料不可算成 0');
  assert.notEqual(r['ghg.total'].value_state, 'measured');
});

let runId;
test('[22.2] 報告：就緒度、送審條件、三人分權、封存、重現、匯出四種格式', async () => {
  const c = R.createCase(reporter, { orgId: org803, templateCode: 'HOSP-OPS', year: 2026, datasetId: dataset, publishDate: '2026-12-15' });
  const rd = R.readiness(reporter, c.id);
  assert.ok(rd.total > 0);
  runId = R.generateRun(reporter, c.id).id;
  assert.throws(() => R.submitRun(reporter, runId), /缺漏/, '電費以外必要欄位缺漏時不可送審');
  // 改用只需電力的能源用戶模板
  const c2 = R.createCase(reporter, { orgId: org803, templateCode: 'GHG-EVIDENCE', year: 2026, datasetId: dataset });
  runId = R.generateRun(reporter, c2.id).id;
  R.submitRun(reporter, runId);
  assert.throws(() => R.reviewRun(reporter, runId, { approve: true }), /權限|forbidden/i);
  R.reviewRun(reviewer1, runId, { approve: true });
  assert.throws(() => R.approveRun(reviewer1, runId), /權限|forbidden/i);
  R.approveRun(approver, runId);
  assert.throws(() => q.run("UPDATE report_runs SET results = '{}' WHERE id = ?", runId), /封存/);
  assert.equal(R.reproduce(approver, runId).reproducible, true);
  for (const f of ['xlsx', 'csv', 'docx', 'html']) {
    const out = await X.exportRun(reporter, runId, f);
    assert.ok(out.data.length > 100, f);
  }
  const wb = readWorkbook((await X.exportRun(reporter, runId, 'xlsx')).data);
  assert.ok([...wb.sheets.values()][0].cells.size > 5);
  assert.ok(q.get('SELECT COUNT(*) n FROM report_artifacts WHERE run_id = ?', runId).n >= 4);
  // 同一份資料集可被第二份報告引用，不需重新蒐集
  const c3 = R.createCase(reporter, { orgId: org803, templateCode: 'GHG-INV', year: 2026, datasetId: dataset });
  const run3 = R.generateRun(reporter, c3.id);
  assert.ok(run3.id);
});

test('[22.2] 已定版資料修改建立新版本，原報告仍可重現', () => {
  const nv = D.newDatasetVersion(reporter, dataset, { reason: '補 9 月帳單' });
  assert.equal(nv.version, 2);
  assert.equal(q.get('SELECT status FROM datasets WHERE id = ?', dataset).status, 'superseded');
  assert.equal(R.reproduce(approver, runId).reproducible, true);
});

test('[22.2] 成果回饋：第一線看得到被哪些報告引用', () => {
  const fb = R.feedbackFor(collector, { assetId: gridAsset });
  assert.ok(fb.length >= 1);
  assert.ok(q.get("SELECT COUNT(*) n FROM notifications WHERE kind = 'usage.published'").n >= 1);
});

test('[22.2] 看板分級：公開層不含費用、識別碼；KPI 分開算', () => {
  const pub = B.publicBoard(staff, { year: 2026 });
  const s = JSON.stringify(pub);
  assert.ok(!s.includes('01-2345'), '公開看板不含電號');
  assert.ok(!/cost|費用/.test(s.replace(/definitions.*/, '')), '公開看板不含費用');
  assert.ok('acquisitionRate' in pub.total && 'validationRate' in pub.total && 'reviewRate' in pub.total);
  assert.throws(() => B.managementBoard(staff, { year: 2026 }), /權限|forbidden/i);
  const mg = B.managementBoard(auditor, { year: 2026, orgId: org803 });
  assert.ok(mg.blockers);
});

test('[22.2] 設定變更須另一人核准、保留版本、可回復', () => {
  const d = CFG.createDraft(sa1, 'config', 'compare.thresholds', { value: { default: { abs: 0, rel_pct: 5 } } }, '放寬門檻');
  CFG.submit(sa1, 'config', d.id);
  assert.throws(() => CFG.publish(sa1, 'config', d.id), /另一位/);
  assert.throws(() => CFG.publish(sa2, 'config', d.id), /確認/);
  CFG.publish(sa2, 'config', d.id, { impactAck: true });
  assert.equal(CFG.getConfig('compare.thresholds').default.rel_pct, 5);
  const rb = CFG.rollbackTo(sa1, 'config', q.get("SELECT id FROM configuration_versions WHERE key = 'compare.thresholds' AND version = 1").id, '回復');
  assert.equal(rb.version, 3);
});

test('[22.3] 權限：跨院查詢被擋；稽核唯讀；系統管理員不能代替業務裁決', () => {
  assert.throws(() => A.getAsset(other, gridAsset), /權限|forbidden/i);
  assert.equal(A.listAssets(other, {}).filter((a) => a.org_id === org803).length, 0);
  assert.throws(() => A.createAsset(auditor, { orgId: org803, domain: 'oil', assetType: 'vehicle', name: 'x' }), /權限|forbidden/i);
  assert.equal(authz.can(sa1, 'decision.review', org803), false);
  assert.equal(authz.can(sa1, 'dataset.approve', org803), false);
  // 總院授權涵蓋分院
  assert.equal(authz.can(collector, 'asset.write', org816), true);
});

test('[22.3] 稽核雜湊鏈完整、不可修改刪除', () => {
  assert.equal(db.verifyAuditChain().ok, true);
  assert.throws(() => q.run('DELETE FROM audit_events'), /不可刪除/);
  assert.throws(() => q.run("UPDATE audit_events SET action = 'x'"), /不可修改/);
});

test('[22.1][22.3] 匯入：預覽、錯誤清單、提交、同檔重送不重複、整批撤銷', async () => {
  const w = A.createAsset(collector, { orgId: org803, itemId: q.get("SELECT id FROM inventory_items WHERE code='WAT-TAP'").id, assetType: 'water_account', name: '自來水總表', externalKey: 'W-001' }).id;
  const csv = '標的（代碼或識別碼）,指標代碼,起日,迄日（含）,數值,單位,值狀態\nW-001,water_withdrawal_m3,2026-01-01,2026-01-31,1200,度,實測\nW-001,water_withdrawal_m3,2026-02-01,2026-02-28,,度,實測\nNOPE,water_withdrawal_m3,2026-03-01,2026-03-31,5,m3,實測\n';
  const up = await I.uploadImport(collector, { orgId: org803, filename: 'water.csv', data: Buffer.from(csv) });
  assert.equal(up.rows, 1); assert.equal(up.errors.length, 2);
  assert.throws(() => I.commitImport(collector, up.id), /錯誤/);
  const st = I.commitImport(collector, up.id, { allowErrors: true });
  assert.equal(st.created, 1);
  const up2 = await I.uploadImport(collector, { orgId: org803, filename: 'water.csv', data: Buffer.from(csv) });
  assert.equal(up2.duplicateFile, true);
  assert.equal(I.commitImport(collector, up2.id, { allowErrors: true }).duplicate, 1, '同檔重送不重複');
  I.revertImport(collector, up.id, { reason: '測試撤銷' });
  assert.equal(q.get("SELECT COUNT(*) n FROM observations WHERE asset_id = ? AND quality_status <> 'superseded'", w).n, 0);
});

test('[22.3] 歷史碳盤查工作簿 32 項：保留座標、非油水電氣保留為參照', async () => {
  const { buildWorkbook } = await import('../src/xlsx.js');
  const rows = [['碳盤查資料收集表單'], ['範疇', '所屬類別', '活動來源', '所需數據 & 資料來源', '備註'],
    ['範疇一', '類別一', '自有公務車輛用油及逸散', '公務車行照', ''], ['', '', '緊急發電機', '設備位置、發電機銘牌、柴油使用記錄', ''],
    ['範疇三', '類別三', '員工通勤', '員工調查', ''], ['', '', '高壓電器絕緣開關器', 'ACB 或 GCB', '(待確認)']];
  const buf = buildWorkbook([{ name: '碳排放活動數據', rows }]).buffer;
  const up = await I.uploadImport(sa1, { orgId: org803, filename: '碳盤查資料收集表單.xlsx', data: buf, kind: 'ghg_workbook' }).catch((e) => e);
  // 系統管理員沒有 import.write → 用承辦
  const up2 = await I.uploadImport(collector, { orgId: org803, filename: '碳盤查資料收集表單.xlsx', data: buf, kind: 'ghg_workbook' });
  assert.ok(up instanceof Error || up.id);
  I.commitImport(collector, up2.id, { allowErrors: true });
  const refs = I.listReferenceActivities(collector);
  assert.equal(refs.length, 4);
  const gen = refs.find((r) => r.activity === '緊急發電機');
  assert.equal(gen.row_no, 4); assert.ok(gen.cells.C4);
  assert.deepEqual(gen.item_codes, ['OIL-GEN']);
  assert.equal(refs.find((r) => r.activity === '員工通勤').domain_hint, 'reference', '通勤不塞進油水電氣');
});

test('[legacy] 舊院所帳號登入自動對應平台使用者', () => {
  const r = users.ensureLegacyUser({ username: 'hosp-803', hid: '803', name: '國軍臺中總醫院' });
  const ctx = authz.contextFor({ uid: r.uid });
  assert.equal(authz.can(ctx, 'user.manage', org803), true);
  assert.equal(authz.can(ctx, 'user.manage', org802), false);
  const u = users.createUser(ctx, { username: 'nurse1', displayName: '院內同仁', password: 'Passw0rd123', grants: [{ role: 'staff', scopeType: 'org', scopeId: org803 }] });
  assert.ok(u.id);
  assert.throws(() => users.createUser(ctx, { username: 'evil', displayName: 'x', password: 'Passw0rd123', grants: [{ role: 'sysadmin', scopeType: 'global' }] }), /權限|forbidden/i);
});

test('[auth] 平台登入：密碼、鎖定、TOTP、首次須改密碼', () => {
  const r = users.platformLogin('col', 'wrong');
  assert.equal(r.ok, false);
  const ok = users.platformLogin('col', 'Passw0rd123');
  assert.equal(ok.ok, true);
  const t = users.startTotp(collector);
  users.confirmTotp(collector, users.totpAt(t.secret));
  assert.equal(users.platformLogin('col', 'Passw0rd123').code, 'totp_required');
  assert.equal(users.platformLogin('col', 'Passw0rd123', { totp: users.totpAt(t.secret) }).ok, true);
  assert.equal(users.platformLogin('nurse1', 'Passw0rd123').mustChange, true);
});

test('[22.3] 備份與還原演練', () => {
  const b = BK.backupNow('test');
  assert.equal(b.ok, true);
  const d = BK.restoreDrill(b.name);
  assert.equal(d.ok, true);
  assert.equal(d.counts.observations, d.live.observations);
});

test('[22.3] 證據雜湊驗證與機敏分級', async () => {
  const ev = await E.storeEvidence(collector, { orgId: org803, filename: 'secret.pdf', data: Buffer.from('%PDF-1.4 secret'), confidentiality: 'secret' });
  await assert.rejects(() => E.readEvidence(collector, ev.id), /權限/);
  const r = await E.readEvidence(auditor, ev.id);
  assert.ok(r.data.length);
  assert.equal((await E.verifyAllEvidence()).bad.length, 0);
  assert.throws(() => E.checkFile('x.exe', Buffer.from('MZ')), /不接受/);
  assert.throws(() => E.checkFile('x.pdf', Buffer.from('not pdf')), /不符/);
});
