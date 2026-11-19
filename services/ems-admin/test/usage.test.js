// 電號用電速覽（前日／上月／前年）與台電智慧電表（AMI）檔案解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-usage-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
const hdir = join(tmp, 'repo', 'src', 'content', 'hospitals');
mkdirSync(hdir, { recursive: true });
writeFileSync(join(hdir, '803.json'), JSON.stringify({ name: '國軍臺中總醫院', resources: [] }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const A = await import('../src/platform/assets.js');
const O = await import('../src/platform/observations.js');
const U = await import('../src/platform/usage.js');
const { parseTable } = await import('../src/platform/imports.js');

db.openDb(); runSeeds();
const q = db.q;
const org = authz.orgByHid('803').id;
const legacy = users.ensureLegacyUser({ username: 'hosp-803', hid: '803', name: '國軍臺中總醫院', passwordHash: '!test' });
const ctx = authz.contextFor({ uid: legacy.uid });
let site = q.get('SELECT id FROM sites WHERE org_id = ?', org)?.id;
if (!site) { site = 'site_t'; db.insert('sites', { id: site, org_id: org, name: '院區', created_at: db.nowIso(), updated_at: db.nowIso() }); }
const item = q.get("SELECT id FROM inventory_items WHERE code = 'ELE-GRID'").id;
const mkAcct = (name, attrs = {}) => A.createAsset(ctx, { orgId: org, siteId: site, itemId: item, assetType: 'power_account', name, attrs, reason: '測試' }).id;
const csv = (s) => parseTable('a.csv', Buffer.from(s));

test('AMI 解析：每 15 分鐘需量（kW）→ 每日度數；24:00／00:00 算前一天', () => {
  const rows = ['日期,時間,尖峰需量(kW)'];
  for (let i = 1; i <= 96; i++) { const m = i * 15; rows.push(`2026/11/17,${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},400`); }
  const p = U.parseAmi(csv(rows.join('\n')));
  assert.equal(p.intervalMin, 15);
  assert.equal(p.days.get('2026-11-17').kwh, 400 * 24);
  assert.equal(p.days.get('2026-11-17').n, 96);
  assert.equal(p.days.has('2026-11-18'), false);
});

test('AMI 解析：日期時間一欄＋度數；民國日期；橫式 96 欄；日資料', () => {
  const rows = ['用電資料', '日期時間,用電度數(kWh),無效電力(kvarh)'];
  for (let i = 0; i < 96; i++) { const m = i * 15; rows.push(`115/11/17 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},100,9`); }
  const p = U.parseAmi(csv(rows.join('\n')));
  // 00:00 屬 11/16，其餘 95 筆屬 11/17
  assert.equal(p.days.get('2026-11-17').n, 95);
  assert.equal(p.days.get('2026-11-16').kwh, 100);

  const times = Array.from({ length: 96 }, (_, i) => { const m = (i + 1) * 15; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; });
  const wide = U.parseAmi(csv(`日期,${times.join(',')}\n2026-11-17,${times.map(() => '50').join(',')}`));
  assert.equal(wide.layout, 'wide');
  assert.equal(wide.days.get('2026-11-17').kwh, 4800);

  const daily = U.parseAmi(csv('日期,用電量(kWh)\n2026/11/16,"17,500"\n2026/11/17,18000'));
  assert.equal(daily.layout, 'daily');
  assert.equal(daily.days.get('2026-11-16').kwh, 17500);
});

test('速覽：前日用 AMI、上月不齊時用電費單、前年用全年值；未啟用電號不併入全院', () => {
  const a = mkAcct('受電點 11.4kV');
  mkAcct('受電點 22.8kV', { inServiceFrom: '2026-01' });
  // 智慧電表每日檔
  const lines = ['日期,用電量(kWh)'];
  for (let d = 1; d <= 18; d++) lines.push(`2026-11-${String(d).padStart(2, '0')},${17000 + d}`);
  const r = U.importAmi(ctx, { assetId: a, filename: 'ami.csv', data: Buffer.from(lines.join('\n')) });
  assert.equal(r.created, 18);
  assert.equal(U.importAmi(ctx, { assetId: a, filename: 'ami.csv', data: Buffer.from(lines.join('\n')) }).duplicate, 18);
  // 10 月電費單（計費期間 10/08–11/06，大半落在 10 月）與 2025 全年
  O.addObservation(ctx, { assetId: a, metricCode: 'elec_purchased_kwh', periodStart: '2026-10-08', periodEnd: '2026-11-07', rawValue: 520000, rawUnit: 'kWh', sourceRecordKey: 'bill-2610' }, { method: 'import' });
  O.addObservation(ctx, { assetId: a, metricCode: 'elec_purchased_kwh', periodStart: '2025-01-01', periodEnd: '2026-01-01', rawValue: 6302755.68, rawUnit: 'kWh', sourceRecordKey: 'y2025' }, { method: 'import' });

  const s = U.usageSummary({ assetId: a, today: '2026-11-19' });
  assert.deepEqual([s.day.date, s.day.kwh, s.day.source], ['2026-11-18', 17018, 'ami']);
  assert.deepEqual([s.month.month, s.month.kwh, s.month.source], ['2026-10', 520000, 'bill']);
  assert.equal(Math.round(s.year.kwh), 6302756);

  // AMI 還沒上傳昨天：顯示最近一天並標 stale
  const s2 = U.usageSummary({ assetId: a, today: '2026-11-21' });
  assert.equal(s2.day.date, '2026-11-18'); assert.equal(s2.day.stale, true);

  // 全院：22.8kV 2026-01 起才啟用，2025 年不算它；2026 年的前日算它但它沒資料 → of=2
  const p = U.publicUsage('803', '2026-11-19');
  assert.equal(Math.round(p.year.kwh), 6302756);
  assert.equal(p.day.kwh, 17018);
  assert.equal(U.usageSummary({ orgId: org, today: '2026-11-19' }).day.of, 2);
  assert.equal(U.usageSummary({ orgId: org, today: '2026-11-19' }).year.of, 1);
  assert.equal(p.day.source, undefined);   // 公開版只給數字與日期
});

test('AMI 匯入：不完整的一天不入帳', () => {
  const a = mkAcct('測試電號');
  const rows = ['日期,時間,用電度數(kWh)'];
  for (let i = 1; i <= 96; i++) { const m = i * 15; rows.push(`2026-11-17,${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},25`); }
  for (let i = 1; i <= 40; i++) { const m = i * 15; rows.push(`2026-11-18,${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')},25`); }
  const r = U.importAmi(ctx, { assetId: a, filename: 'x.csv', data: Buffer.from(rows.join('\n')) });
  assert.equal(r.created, 1);
  assert.deepEqual(r.partial, ['2026-11-18（40/96）']);
  assert.equal(U.usageSummary({ assetId: a, today: '2026-11-19' }).day.date, '2026-11-17');
});
