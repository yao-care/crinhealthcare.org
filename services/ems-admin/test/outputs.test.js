// 對外系統資料輸出：以玉里分院情境驗收（台電 2 個電號 1,100 kW／800 kW、分盤 22 座）。
// 對應 docs/ems-platform-v2.md 項 38–53。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-outputs-'));
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
const P = await import('../src/platform/profile.js');
const EM = await import('../src/platform/measures.js');
const { MOENV_SHEETS } = await import('../src/platform/seed/moenv-import.js');
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
for (const f of q.all("SELECT id FROM factors WHERE status = 'pending'")) CFG.publish(sa2, 'factor', f.id);
const item = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code).id;
const asset = (code, type, name, o = {}) => A.createAsset(col, { orgId: org, itemId: item(code), assetType: type, name, ...o }).id;
const ev = (await E.storeEvidence(col, { orgId: org, filename: 'bills-2025.pdf', data: Buffer.from('%PDF-1.4 bills 2025') })).id;
const obs = (assetId, metricCode, ps, pe, v, o = {}) => O.addObservation(col, { assetId, metricCode, periodStart: ps, periodEnd: pe, rawValue: v, ...o }, { evidenceIds: [ev] });
const mon = (y, m) => [`${y}-${String(m).padStart(2, '0')}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`];
const MONTHLY_A = [310000, 290000, 320000, 350000, 420000, 470000, 510000, 520000, 460000, 390000, 330000, 300000];
const MONTHLY_B = [180000, 170000, 185000, 200000, 240000, 270000, 290000, 300000, 260000, 220000, 190000, 175000];

function approveAll(dsId) {
  V.runValidation(rep, { orgId: org, year: q.get('SELECT year FROM datasets WHERE id = ?', dsId).year });
  const r = D.proposeBulk(rep, { datasetId: dsId, reason: '單一來源、檢核通過' });
  if (process.env.DBG) console.log('bulk', r.proposed, r.skipped.slice(0, 5), q.all('SELECT quality_status, COUNT(*) n FROM observations GROUP BY 1'));
  for (const d of q.all("SELECT id FROM decisions WHERE dataset_id = ? AND status IN ('proposed','first_approved')", dsId)) {
    D.reviewDecision(rv1, d.id, { approve: true });
    if (q.get('SELECT status FROM decisions WHERE id = ?', d.id).status === 'first_approved') D.reviewDecision(rv2, d.id, { approve: true });
  }
  D.submitDataset(rep, dsId); D.approveDataset(rv1, dsId); D.lockDataset(rv1, dsId);
}

let acctA; let acctB; const panels = []; let ds; let ds24;

test('[38] 電號屬性與電費單細項指標', () => {
  acctA = asset('ELE-GRID', 'power_account', '主電號', { externalKey: '18-31-1100-11-0', attrs: { tariffType: '65 需量綜合(高壓)非營業用', contractKw: 1100, supplyFloorAreaM2: 32000, supplyAcAreaM2: 21000, supplyParkingAreaM2: 1500, supplyStaff: 420 } });
  acctB = asset('ELE-GRID', 'power_account', '第二電號', { externalKey: '18-31-0800-22-0', attrs: { tariffType: '65 需量綜合(高壓)非營業用', contractKw: 800, supplyFloorAreaM2: 18000, supplyAcAreaM2: 12000, supplyStaff: 260 } });
  const metrics = JSON.parse(q.get("SELECT metrics FROM inventory_items WHERE code = 'ELE-GRID'").metrics);
  for (const m of ['elec_peak_kwh', 'elec_semipeak_kwh', 'elec_satsemipeak_kwh', 'elec_offpeak_kwh', 'elec_wheeled_kwh', 'elec_power_factor_pct', 'elec_contract_offpeak_kw']) assert.ok(metrics.includes(m), m);
  for (const [acct, arr] of [[acctA, MONTHLY_A], [acctB, MONTHLY_B]]) {
    arr.forEach((kwh, i) => {
      const [ps, pe] = mon(2025, i + 1);
      obs(acct, 'elec_purchased_kwh', ps, pe, kwh, { sourceRecordKey: `bill:${acct}:${ps}` });
      obs(acct, 'elec_peak_kwh', ps, pe, Math.round(kwh * 0.3)); obs(acct, 'elec_semipeak_kwh', ps, pe, Math.round(kwh * 0.25));
      obs(acct, 'elec_satsemipeak_kwh', ps, pe, Math.round(kwh * 0.05)); obs(acct, 'elec_offpeak_kwh', ps, pe, kwh - Math.round(kwh * 0.3) - Math.round(kwh * 0.25) - Math.round(kwh * 0.05));
      obs(acct, 'elec_peak_demand_kw', ps, pe, acct === acctA ? 980 : 690); obs(acct, 'elec_power_factor_pct', ps, pe, 98.5); obs(acct, 'elec_cost_twd', ps, pe, Math.round(kwh * 4.1));
    });
  }
});

test('[40] 22 座分盤掛在兩個電號下；4 座沒有電表以額定功率推估', () => {
  const systems = ['空調', '空調', '照明', '醫療設備', '給水污水', '電梯', '冷凍冷藏', '事務設備', '送排風', '照明', '空調'];
  for (let i = 0; i < 22; i++) {
    const parent = i < 12 ? acctA : acctB;
    const metered = !(i === 5 || i === 10 || i === 17 || i === 21);
    const id = asset('ELE-SUB', 'panel', `分盤 ${String(i + 1).padStart(2, '0')}`, { parentAssetId: parent, attrs: metered ? { metered: true, system: systems[i % systems.length] } : { metered: false, system: systems[i % systems.length], ratedKw: 40, hoursPerYear: 3000, loadPct: 60 } });
    panels.push(id);
    if (metered) for (let m = 1; m <= 12; m++) obs(id, 'elec_metered_kwh', ...mon(2025, m), Math.round((parent === acctA ? MONTHLY_A : MONTHLY_B)[m - 1] / (parent === acctA ? 12 : 10) * 0.85));
  }
  assert.equal(q.get("SELECT COUNT(*) n FROM assets WHERE org_id = ? AND asset_type = 'panel'", org).n, 22);
});

test('[41–45] 變壓器、設備、建物、基本資料、營運活動與廢棄物', () => {
  const site = q.get('SELECT id FROM sites WHERE org_id = ?', org).id;
  const b1 = A.saveBuilding(sa1, { siteId: site, name: '醫療大樓', floorAreaM2: 30000, attrs: { builtYear: 85, floorsBelow: 1, floorsAbove: 8, roof: 'RC 平頂', entrance: '東', bogus: 'x' } }).id;
  assert.deepEqual(JSON.parse(q.get('SELECT attrs FROM buildings WHERE id = ?', b1).attrs), { builtYear: 85, floorsBelow: 1, floorsAbove: 8, roof: 'RC 平頂', entrance: '東' });
  A.saveBuilding(sa1, { siteId: site, name: '行政大樓', floorAreaM2: 20000, attrs: { builtYear: 70, floorsAbove: 4 } });
  asset('ELE-SYS', 'transformer', 'TR-1', { buildingId: b1, attrs: { kva: 1500, xfmrType: '油式', brand: '士林', year: 95, primaryKv: 11.4, secondaryV: 380, pfController: true, capacitorKvar: 300 } });
  asset('ELE-SYS', 'transformer', 'TR-2', { attrs: { kva: 1000, xfmrType: '乾式' } });
  const gen = asset('OIL-GEN', 'generator', '緊急發電機', { attrs: { fuel: 'diesel', kva: 750, voltageV: 380 } });
  obs(gen, 'oil_consumption_l', '2025-01-01', '2026-01-01', 1800);
  asset('ELE-EQUIP', 'chiller', '冰水主機 1', { buildingId: b1, attrs: { system: '空調', equipName: '中央空調主機', capacity: 400, capacityUnit: 'RT', ratedKw: 260, qty: 1, hoursPerYear: 3500, year: 105, inverter: true, efficiency: '0.65 kW/RT' } });
  asset('ELE-EQUIP', 'lighting', 'LED 燈具', { attrs: { equipName: 'LED 燈', lightingSpec: '18W×2', qty: 1200, ratedKw: 0.036, hoursPerYear: 4380, area: '病房走道' } });
  const ac = asset('GAS-REF', 'split_ac', '分離式冷氣（行政）', { attrs: { refrigerant: 'R-410A', qty: 35 } });
  obs(ac, 'ref_recharge_kg', '2025-01-01', '2026-01-01', 6.5);
  const r22 = asset('GAS-REF', 'window_ac', '舊窗型冷氣', { attrs: { refrigerant: 'R-22', qty: 4 } });
  obs(r22, 'ref_recharge_kg', '2025-01-01', '2026-01-01', 1.2);
  const car = asset('OIL-VEH', 'vehicle', '公務車', { externalKey: 'ABC-1234', attrs: { fuel: 'gasoline', vehicleClass: '小客車' } });
  for (let m = 1; m <= 12; m++) obs(car, 'oil_consumption_l', ...mon(2025, m), 120);
  const water = asset('WAT-TAP', 'water_account', '自來水', { externalKey: '9-31-123456-7' });
  for (let m = 1; m <= 12; m++) obs(water, 'water_withdrawal_m3', ...mon(2025, m), 8000 + m * 10);
  const act = (code) => q.get('SELECT a.id FROM assets a JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code = ?', org, code).id;
  obs(act('ACT-CAP'), 'beds', '2025-12-31', '2025-12-31', 1100); obs(act('ACT-CAP'), 'floor_area_m2', '2025-12-31', '2025-12-31', 50000);
  obs(act('ACT-STAFF'), 'medical_staff_count', '2025-12-31', '2025-12-31', 680);
  obs(act('ACT-WASTE'), 'waste_general_kg', '2025-01-01', '2026-01-01', 210000); obs(act('ACT-WASTE'), 'waste_hazardous_kg', '2025-01-01', '2026-01-01', 38000);
  P.saveProfile(rep, org, { taxId: '12345678', representative: '王院長、院長', contactPerson: '林工程師、03-8883141、eng@example.org', county: '花蓮縣', district: '玉里鎮', zip: '981',
    address: '花蓮縣玉里鎮新興街 91 號', moenvControlNo: 'U1234567', authority: 'CA0005 衛生福利部', energyManager: '陳能管員、能管字第 001 號', energyOrg: '管理：院長；推行：副院長；執行：工務室', energyPolicy: '已對外發布節能政策', bogus: 1 });
  assert.equal(P.getProfile(org).moenvControlNo, 'U1234567');
  assert.equal(P.getProfile(org).bogus, undefined);
});

test('[46] 節約能源措施與歷年節電率', () => {
  assert.throws(() => EM.saveMeasure(rep, { orgId: org, year: 2025, kind: 'done', name: '', energyType: 'electricity' }), /名稱/);
  assert.throws(() => EM.saveMeasure(rep, { orgId: org, year: 2025, kind: 'done', name: 'x', energyType: 'electricity', code: 'A6' }), /代碼/);
  assert.throws(() => EM.saveMeasure(col, { orgId: org, year: 2025, kind: 'done', name: 'x', energyType: 'electricity' }), /權限|forbidden/i);
  EM.saveMeasure(rep, { orgId: org, assetId: acctA, year: 2025, kind: 'done', source: 'current', code: 'LG06', name: '病房走道換裝 LED', energyType: 'electricity', saving: 52000, benefitTwd: 213000, investmentTwd: 880000, peakReductionKw: 18, calcNote: '(36W-18W)×2×1200 具×4380h×認列 12/12', periodFrom: '2025-01', periodTo: '2025-12', calcFromMonth: 1, calcToMonth: 12 });
  EM.saveMeasure(rep, { orgId: org, assetId: acctA, year: 2026, kind: 'plan', code: 'AA06', name: '冰水主機汰換', energyType: 'electricity', saving: 120000, investmentTwd: 9000000 });
  EM.saveSavingYear(rep, { orgId: org, assetId: acctA, year: 2024, savingKwh: 30000, usageKwh: 4500000 });
  assert.throws(() => EM.saveSavingYear(rep, { orgId: org, assetId: acctA, year: 2024, deductKwh: 10 }), /說明/);
  const t = EM.savingRateTable(org, acctA, 2025);
  assert.equal(t.rows[0].year, 2024);
});

test('[53] 定版 2024、2025 資料集', () => {
  // 2024 只有主電號（前一年 EUI 比較用）
  MONTHLY_A.forEach((kwh, i) => obs(acctA, 'elec_purchased_kwh', ...mon(2024, i + 1), Math.round(kwh * 1.05)));
  ds24 = D.createDataset(rep, { orgId: org, year: 2024 }).id; approveAll(ds24);
  ds = D.createDataset(rep, { orgId: org, year: 2025 }).id; approveAll(ds);
  assert.equal(q.get('SELECT status FROM datasets WHERE id = ?', ds).status, 'locked');
  const t = EM.savingRateTable(org, acctA, 2025);
  const r25 = t.rows.find((r) => r.year === 2025);
  assert.equal(r25.saving, 52000);
  assert.equal(r25.usage, MONTHLY_A.reduce((s, x) => s + x, 0));
  // 114 年起新制：只累計 114 年起；前期超額＝max(0, 30000 − 4,500,000×1%÷99%)＝0
  const sumA = MONTHLY_A.reduce((s, x) => s + x, 0);
  assert.equal(t.excess, 0);
  assert.ok(Math.abs(r25.rate - 52000 / (52000 + sumA) * 100) < 1e-9);
  assert.ok(Math.abs(r25.annualRate - 52000 / (52000 + sumA) * 100) < 1e-9);
  assert.equal(t.rows.find((r) => r.year === 2024).period, '104～113 年規定');
  assert.ok(Math.abs(t.rows.find((r) => r.year === 2024).rate - 30000 / 4530000 * 100) < 1e-9);
});

const run = async (code) => {
  const c = R.createCase(rep, { orgId: org, templateCode: code, year: 2025, datasetId: ds });
  const rd = R.readiness(rep, c.id);
  if (process.env.DBG) for (const f of rd.fields) console.log(code, f.field_id, f.state, f.block ? `${f.block.text}｜${(f.block.tables || []).map((t) => `${t.title}:${t.rows.length}`).join('，')}` : f.value);
  const runId = R.generateRun(rep, c.id).id;
  const out = await X.exportRun(rep, runId, 'xlsx');
  return { c, rd, runId, wb: readWorkbook(out.data), run: R.getRun(rep, runId) };
};
const cellsOf = (wb, name) => { const sh = wb.sheets.get(name); assert.ok(sh, `缺工作表 ${name}；有：${[...wb.sheets.keys()].join('、')}`); return sh.cells; };
const blockOf = (rd, key) => rd.fields.find((f) => f.field_id === key)?.block;

test('[47] 環境部匯入表單 V5：工作表名稱與表頭逐格相同、排放源與電號正確', async () => {
  const { rd, wb } = await run('GHG-REGISTRY');
  const b = blockOf(rd, 'moenv_import');
  for (const name of Object.keys(MOENV_SHEETS)) {
    const cells = cellsOf(wb, name);
    MOENV_SHEETS[name].forEach((row, r) => row.forEach((v, ci) => { if (v) assert.equal(cells.get(`${String.fromCharCode(65 + (ci % 26)).padStart(ci >= 26 ? 2 : 1, String.fromCharCode(64 + Math.floor(ci / 26)))}${r + 1}`)?.toString(), v, `${name} 第 ${r + 1} 列第 ${ci + 1} 欄`); }));
  }
  const t21 = b.tables.find((t) => t.sheet === '表2-1邊界設定-電號資料');
  assert.deepEqual(t21.rows.map((r) => r[2]).sort(), ['18-31-0800-22-0', '18-31-1100-11-0']);
  const t3 = b.tables.find((t) => t.sheet === '表3-排放源定性及定量');
  assert.equal(t3.rows[0].length, MOENV_SHEETS['表3-排放源定性及定量'][2].length);
  const elec = t3.rows.find((r) => r[13] === '外購電力');
  const total = (MONTHLY_A.reduce((s, x) => s + x, 0) + MONTHLY_B.reduce((s, x) => s + x, 0)) / 1000;
  assert.equal(elec[26], total); assert.equal(elec[27], '千度'); assert.equal(elec[1], 'GP01'); assert.equal(elec[9], 'GG3500');
  const gen = t3.rows.find((r) => r[2] === '0298');
  assert.equal(gen[9], '170006'); assert.equal(gen[26], 1800); assert.equal(gen[27], '公升'); assert.equal(gen[13], '固定燃燒'); assert.equal(gen[1], 'GS01');
  const car = t3.rows.find((r) => r[2] === 'B101'); assert.equal(car[26], 1440); assert.equal(car[13], '移動燃燒'); assert.equal(car[1], 'GV01');
  const ac = t3.rows.find((r) => r[2] === '4091'); assert.equal(ac[9], 'GG1814'); assert.equal(ac[26], 6.5); assert.equal(ac[38], '質量平衡法'); assert.equal(ac[7], 35); assert.equal(ac[21], 'V');
  assert.ok(!t3.rows.some((r) => /R-22|HCFC/.test(r[10])), 'R-22 不列入');
  // 資料行緊接在表頭之後（第 4 列起）
  const c3 = cellsOf(wb, '表3-排放源定性及定量');
  assert.equal(c3.get('A4'), 'D00001');
});

test('[48] 能源查核附表三：每個電號一張表五之二，合計與帳單一致；表六分盤 22 座', async () => {
  const { rd, wb } = await run('ENERGY-USER');
  assert.equal(q.get("SELECT version FROM report_templates t JOIN report_cases c ON c.template_id = t.id WHERE c.org_id = ? ORDER BY c.created_at DESC LIMIT 1", org).version, 2);
  const basic = blockOf(rd, 'eu_basic').tables[0];
  assert.deepEqual(basic.columns.slice(1), ['18-31-1100-11-0', '18-31-0800-22-0']);
  assert.equal(basic.rows.find((r) => r[0].startsWith('19'))[1], 32000);
  assert.equal(basic.rows.find((r) => r[0].startsWith('16'))[1], 1100);
  const elec = blockOf(rd, 'eu_elec');
  assert.equal(elec.tables.length, 2);
  const tA = elec.tables[0];
  assert.equal(tA.rows.find((r) => r[0] === '合計')[10], MONTHLY_A.reduce((s, x) => s + x, 0));
  assert.equal(tA.rows[0][1], 1100); // 經常契約容量（電號屬性帶入）
  assert.equal(tA.rows[6][2], 980); // 7 月尖峰最高需量
  assert.ok(!/不符/.test(elec.text), elec.text);
  assert.ok(cellsOf(wb, '表五之二電能_18-31-1100-11-0'));
  const flow = blockOf(rd, 'eu_flow');
  const pA = flow.tables.find((t) => /分盤明細（電號 18-31-1100/.test(t.title)); const pB = flow.tables.find((t) => /分盤明細（電號 18-31-0800/.test(t.title));
  assert.equal(pA.rows.length + pB.rows.length, 22);
  const unm = [...pA.rows, ...pB.rows].filter((r) => r[2] === '無');
  assert.equal(unm.length, 4);
  assert.equal(unm[0][3], 40 * 3000 * 0.6);
  const balA = flow.tables.find((t) => /表六 電能用量平衡（電號 18-31-1100/.test(t.title));
  assert.ok(balA.rows.some((r) => /未分配/.test(r[0])));
  const eui = blockOf(rd, 'eu_eui').tables[0];
  const year = eui.rows.find((r) => r[0] === '全年度');
  assert.equal(year[2], 30500); // 32000 − 1500
  assert.ok(Math.abs(year[4] - MONTHLY_A.reduce((s, x) => s + x, 0) / 30500) < 0.001);
  assert.match(year[5], /減少/); // 2024 比 2025 多 5%
  const sys = blockOf(rd, 'eu_elec_system').tables[0];
  assert.equal(sys.rows.length, 2); assert.equal(sys.rows[0][5], 1500);
  assert.equal(blockOf(rd, 'eu_elec_system').tables[2].rows[0][2], 750);
  const eq = blockOf(rd, 'eu_equipment');
  assert.equal(eq.tables[0].rows.find((r) => r[3] === '冰水主機 1')[7], 400);
  assert.equal(eq.tables[1].rows[0][4], '18W×2');
  assert.equal(blockOf(rd, 'eu_buildings').tables[0].rows.length, 2);
  assert.equal(blockOf(rd, 'eu_measures').tables[0].rows[0][3], 'LG06');
  assert.equal(blockOf(rd, 'eu_plan').tables[0].rows[0][4], '冰水主機汰換');
  const rate = blockOf(rd, 'eu_rate'); assert.equal(rate.tables.length, 2);
  assert.ok(rd.fields.find((f) => f.field_id === 'energyOrg').value);
});

test('[49] 政府機關節能填報：逐月各電號、各水號、用油與年度合計', async () => {
  const { rd } = await run('GOV-SAVING');
  const t = blockOf(rd, 'gov_monthly').tables[0];
  const yearRow = t.rows.find((r) => r[0] === '全年');
  assert.equal(yearRow[1], MONTHLY_A.reduce((s, x) => s + x, 0));
  assert.equal(yearRow[3], MONTHLY_A.reduce((s, x) => s + x, 0) + MONTHLY_B.reduce((s, x) => s + x, 0));
  assert.equal(yearRow[t.columns.indexOf('汽油（公升）')], 1440);
  assert.equal(rd.fields.find((f) => f.field_id === 'area').value, 50000);
});

test('[50] 國健署醫院節能減碳填報：能源、用水、廢棄物、床數', async () => {
  const { rd } = await run('HOSP-HPA');
  const v = (id) => rd.fields.find((f) => f.field_id === id);
  assert.equal(v('waste_haz').value, 38000); assert.equal(v('waste_gen').value, 210000); assert.equal(v('beds').value, 1100);
  assert.equal(v('ng').state, 'not_applicable');
  assert.equal(v('elec').value, MONTHLY_A.reduce((s, x) => s + x, 0) + MONTHLY_B.reduce((s, x) => s + x, 0));
});

test('[51–52] 油電水通用表；沒有機敏權限者看不到費用欄', async () => {
  const { rd, runId } = await run('OEW-CONTROL');
  const t = blockOf(rd, 'oew_monthly').tables[0];
  assert.equal(t.rows.find((r) => r[0] === '全年')[2], Math.round(MONTHLY_A.reduce((s, x) => s + x * 4.1, 0) + MONTHLY_B.reduce((s, x) => s + x * 4.1, 0)));
  const masked = R.getRun(col, runId).results.fields.oew_monthly.block.tables[0];
  assert.equal(masked.rows[0][2], '（需權限）');
  assert.equal(masked.rows[0][1], MONTHLY_A[0] + MONTHLY_B[0]);
  const rdMasked = R.readiness(col, R.listCases ? q.get('SELECT case_id FROM report_runs WHERE id = ?', runId).case_id : null);
  assert.equal(rdMasked.fields.find((f) => f.field_id === 'oew_monthly').block.tables[0].rows[0][2], '（需權限）');
});

test('[52] 匯出四種格式都含多表內容', async () => {
  const c = R.createCase(rep, { orgId: org, templateCode: 'ENERGY-USER', year: 2025, datasetId: ds });
  const runId = R.generateRun(rep, c.id).id;
  for (const f of ['csv', 'docx', 'html']) {
    const out = await X.exportRun(rep, runId, f);
    const text = f === 'docx' ? out.data.toString('latin1') : out.data.toString('utf8');
    if (f !== 'docx') assert.ok(text.includes('18-31-0800-22-0') && text.includes('表五之二'), f);
  }
});

// ── 覆核修正的回歸測試 ──
test('[覆核] 表三費用列、措施效益與投資金額對沒有機敏權限者遮罩', async () => {
  const c = R.createCase(rep, { orgId: org, templateCode: 'ENERGY-USER', year: 2025, datasetId: ds });
  const runId = R.generateRun(rep, c.id).id;
  const f = R.getRun(col, runId).results.fields;
  const basic = f.eu_basic.block.tables[0];
  const cost = basic.rows.find((r) => r[0].startsWith('22 '));
  assert.deepEqual(cost.slice(1), ['（需權限）', '（需權限）']);
  assert.equal(f.eu_basic.masked, true);
  assert.notEqual(R.getRun(rep, runId).results.fields.eu_basic.block.tables[0].rows.find((r) => r[0].startsWith('22 '))[1], '（需權限）');
  const m = f.eu_measures.block.tables[0].rows[0];
  assert.equal(m[8], '（需權限）'); assert.equal(m[9], '（需權限）');
  assert.equal(R.readiness(col, c.id).fields.find((x) => x.field_id === 'eu_basic').block.tables[0].rows.find((r) => r[0].startsWith('22 '))[1], '（需權限）');
  const list = EM.readMeasures(col, { orgId: org, year: 2025, kind: 'done' });
  assert.equal(list[0].benefit_twd, null); assert.equal(list[0].investment_twd, null);
  assert.equal(EM.readMeasures(rep, { orgId: org, year: 2025, kind: 'done' })[0].benefit_twd, 213000);
});

test('[覆核] 熱能平衡單位為百萬卡；油種不在清單時不拖垮整份匯入表單', async () => {
  const c = R.createCase(rep, { orgId: org, templateCode: 'ENERGY-USER', year: 2025, datasetId: ds });
  const heat = R.readiness(rep, c.id).fields.find((x) => x.field_id === 'eu_flow').block.tables.find((t) => t.title === '表六 熱能用量平衡');
  const gas = heat.rows.find((r) => r[0] === '汽油');
  const hv = q.get("SELECT value FROM factors WHERE code = 'heat.gasoline' AND status = 'published' ORDER BY version DESC").value;
  assert.ok(Math.abs(gas[2] - 1440 * hv / 1000) < 0.01, `${gas[2]} vs ${1440 * hv / 1000}`);
  // 定版後才新增一台油種打錯的發電機（不在資料集裡也會出現在台帳）
  asset('OIL-GEN', 'generator', '油種打錯的發電機', { attrs: { fuel: 'kerosene' } });
  const c2 = R.createCase(rep, { orgId: org, templateCode: 'GHG-REGISTRY', year: 2025, datasetId: ds });
  const b = R.readiness(rep, c2.id).fields.find((x) => x.field_id === 'moenv_import').block;
  assert.notEqual(b.state, 'blocked');
  assert.match(b.text, /kerosene/);
  assert.equal(b.tables.length, 8);
});

test('[覆核] 多電號時全院措施不重複計入；沒有用電量的年度不累計節電量', () => {
  EM.saveMeasure(rep, { orgId: org, year: 2025, kind: 'done', name: '全院空調溫度調整', energyType: 'electricity', saving: 100000 });
  const a = EM.savingRateTable(org, acctA, 2025).rows.find((r) => r.year === 2025);
  assert.equal(a.saving, 52000);
  assert.equal(EM.savingRateTable(org, acctB, 2025).rows.find((r) => r.year === 2025).saving ?? null, null);
  EM.saveSavingYear(rep, { orgId: org, assetId: acctB, year: 2023, savingKwh: 50000 });
  const rows = EM.savingRateTable(org, acctB, 2025).rows;
  assert.equal(rows.find((r) => r.year === 2023).incomplete, true);
  assert.equal(rows.find((r) => r.year === 2025).rate, 0);
  assert.throws(() => EM.saveMeasure(rep, { orgId: org, year: 2010, kind: 'done', name: 'x', energyType: 'electricity' }), /104/);
});

test('[覆核] 定版後封存電號，歷年匯出仍列出該電號', async () => {
  A.disableAsset(col, acctB, '電號註銷');
  if (q.get('SELECT status FROM assets WHERE id = ?', acctB).status !== 'archived') q.run("UPDATE assets SET status = 'archived' WHERE id = ?", acctB);
  const c = R.createCase(rep, { orgId: org, templateCode: 'GHG-REGISTRY', year: 2025, datasetId: ds });
  const b = R.readiness(rep, c.id).fields.find((x) => x.field_id === 'moenv_import').block;
  assert.equal(b.tables.find((t) => t.sheet === '表2-1邊界設定-電號資料').rows.length, 2);
  const elec = b.tables.find((t) => t.sheet === '表3-排放源定性及定量').rows.find((r) => r[13] === '外購電力');
  assert.equal(elec[26], (MONTHLY_A.reduce((s, x) => s + x, 0) + MONTHLY_B.reduce((s, x) => s + x, 0)) / 1000);
  q.run("UPDATE assets SET status = 'active' WHERE id = ?", acctB);
});

test('[覆核] 管理者刪掉的種子指標，重啟後不會被加回來', async () => {
  const { seedDictionary } = await import('../src/platform/seed.js');
  const it = q.get("SELECT id, metrics FROM inventory_items WHERE code = 'ELE-GRID'");
  const without = JSON.parse(it.metrics).filter((m) => m !== 'elec_wheeled_kwh');
  q.run('UPDATE inventory_items SET metrics = ? WHERE id = ?', JSON.stringify(without), it.id);
  seedDictionary();
  assert.ok(!JSON.parse(q.get('SELECT metrics FROM inventory_items WHERE id = ?', it.id).metrics).includes('elec_wheeled_kwh'));
  // 從沒套用過的新指標仍會補上
  q.run("DELETE FROM seed_marks WHERE key = 'item:ELE-GRID:metrics:elec_wheeled_kwh'");
  seedDictionary();
  assert.ok(JSON.parse(q.get('SELECT metrics FROM inventory_items WHERE id = ?', it.id).metrics).includes('elec_wheeled_kwh'));
});

test('[114 年新制] 前期超額節電量（需量反應分開）、國軍部隊用戶免規範', async () => {
  // 主電號 2023 年：非需量反應 60,000、需量反應 10,000、用電 4,000,000 → A＝40,404.04；C(10,000)＜A → 超額＝60,000＋10,000＋30,000(2024)－A
  EM.saveSavingYear(rep, { orgId: org, assetId: acctA, year: 2023, savingKwh: 60000, drSavingKwh: 10000, usageKwh: 4000000 });
  const t = EM.savingRateTable(org, acctA, 2025);
  const reqA = (4000000 + 4500000) * 0.01 / 0.99;
  assert.ok(Math.abs(t.excess - (60000 + 30000 + 10000 - reqA)) < 1e-6, String(t.excess));
  const sumA = MONTHLY_A.reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(t.rows.find((r) => r.year === 2025).rate - (52000 + t.excess) / (52000 + sumA) * 100) < 1e-9);
  // 需量反應措施
  EM.saveMeasure(rep, { orgId: org, assetId: acctA, year: 2025, kind: 'done', name: '需量反應', energyType: 'electricity', saving: 8000, demandResponse: true });
  const r25 = EM.savingRateTable(org, acctA, 2025).rows.find((r) => r.year === 2025);
  assert.equal(r25.saving, 52000); assert.equal(r25.dr, 8000);
  // 國軍部隊用戶
  A.updateAsset(col, acctB, { attrs: { ...JSON.parse(q.get('SELECT attrs FROM assets WHERE id = ?', acctB).attrs), militaryUnit: true }, reason: '國防部造冊' });
  const c = R.createCase(rep, { orgId: org, templateCode: 'ENERGY-USER', year: 2025, datasetId: ds });
  const b = R.readiness(rep, c.id).fields.find((f) => f.field_id === 'eu_rate').block;
  assert.equal(b.tables.length, 1);
  assert.match(b.text, /18-31-0800-22-0 列入國防部國軍部隊用戶清冊/);
  assert.match(b.tables[0].info[0][1], /度/);
});

test('[GOV v3] 節約能源填報網站各填報頁：電表、油號、照明、空調、公用設備、高壓用電、車輛', async () => {
  const id = (name) => q.get('SELECT id FROM assets WHERE org_id = ? AND name = ?', org, name).id;
  const setAttrs = (aid, patch, extra = {}) => A.updateAsset(col, aid, { attrs: { ...JSON.parse(q.get('SELECT attrs FROM assets WHERE id = ?', aid).attrs), ...patch }, reason: '補節能填報欄位', ...extra });
  setAttrs(acctA, { govSharePct: 100, govDeductKwh: 20000, buildingName: '醫療大樓', supplyVoltageV: 11400 });
  setAttrs(id('公務車'), { fuelCustomerNo: 'AA9341002', displacementCc: 1968, carType: '小型汽車(油車)', licenseType: '小客車', year: 2019 });
  setAttrs(id('LED 燈具'), { lampName: 'LED', lampForm: 'T8/T5(LED燈管)', lampType: '雙支(山形、格柵等)', lampSize: '4尺', installYm: '2021-01', investTwd: 121500 });
  setAttrs(id('分離式冷氣（行政）'), { coolingKw: 7.1, energyLabel: '1', installYear: 2024, setTempC: 26 });
  setAttrs(id('TR-1'), {}, { parentAssetId: acctA });
  P.saveProfile(rep, org, { ...P.getProfile(org), govAgencyCode: 'A12345678', govStaffRegular: '680' });
  const { rd } = await run('GOV-SAVING');
  assert.equal(q.get("SELECT version FROM report_templates t JOIN report_cases c ON c.template_id = t.id ORDER BY c.created_at DESC LIMIT 1").version, 3);
  const b = (k) => blockOf(rd, k);
  const m = b('gov_meters').tables[0];
  const rowA = m.rows.find((r) => r[1] === '18-31-1100-11-0');
  const sumA = MONTHLY_A.reduce((s, x) => s + x, 0);
  assert.equal(rowA[5], sumA); assert.equal(rowA[9], sumA - 20000); assert.equal(rowA[2], '醫療大樓'); assert.equal(rowA[10], 32000);
  const oil = b('gov_oil').tables[0];
  assert.equal(oil.rows.find((r) => r[2] === 'AA9341002')[5], 1440);
  assert.match(b('gov_oil').text, /緊急發電機 未填購油客戶編號/);
  const lt = b('gov_lighting').tables[0].rows[0];
  assert.deepEqual(lt.slice(1, 5), ['LED', 'T8/T5(LED燈管)', '雙支(山形、格柵等)', '4尺']); assert.equal(lt[7], 1200);
  const ac = b('gov_ac').tables[0];
  const split = ac.rows.find((r) => r[1] === '分離式冷氣機');
  assert.equal(split[5], 7.1); assert.equal(split[4], '1 級'); assert.equal(split[8], 35);
  assert.ok(ac.rows.some((r) => r[1] === '中央空調主機'));
  const hv = b('gov_hv');
  const site = hv.tables[0].rows.find((r) => r[0] === '18-31-1100-11-0');
  assert.equal(site[3], 11400); assert.equal(site[7], 1100); assert.equal(site[8], 980); assert.equal(site[10], 1500); assert.equal(site[12], '有');
  assert.equal(hv.tables[1].rows.find((r) => r[2] === 'TR-1')[5], 2006);
  const car = b('gov_vehicles').tables[0].rows[0];
  assert.deepEqual([car[5], car[6], car[8], car[9]], ['ABC-1234', 'AA9341002', 1968, '汽油']);
  assert.equal(b('gov_basic').tables[0].rows.find((r) => r[0] === '機關代碼')[1], 'A12345678');
  assert.equal(b('gov_ems').tables.length, 2);
});
