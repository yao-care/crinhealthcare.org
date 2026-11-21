// 盤查計算方式：全平台預設＋各院自選（GWP 版本、冷媒計算方式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-calcset-'));
process.env.PLATFORM_DB = join(tmp, 'platform.sqlite');
process.env.AUDIT_DATA_DIR = join(tmp, 'data');
process.env.AUDIT_UPLOADS_DIR = join(tmp, 'uploads');
process.env.REPO_DIR = join(tmp, 'repo');
process.env.ACCOUNTS_FILE = join(tmp, 'accounts.json');
process.env.PLATFORM_SCHEDULER = '0';
process.env.JWT_SECRET = 'test-secret-0123456789';
const hdir = join(tmp, 'repo', 'src', 'content', 'hospitals');
mkdirSync(hdir, { recursive: true });
for (const [id, name] of [['818', '三軍總醫院北投分院'], ['803', '國軍臺中總醫院']]) writeFileSync(join(hdir, `${id}.json`), JSON.stringify({ name, resources: [] }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const users = await import('../src/platform/users.js');
const authz = await import('../src/platform/authz.js');
const P = await import('../src/platform/profile.js');
const CS = await import('../src/platform/config-store.js');
db.openDb(); runSeeds();
const org = authz.orgByHid('818').id;
const other = authz.orgByHid('803').id;
const u = users.ensureLegacyUser({ username: 'hosp-818', hid: '818', name: '北投', passwordHash: '!test' });
const ctx = authz.contextFor({ uid: u.uid });

test('各院可自選 GWP 與冷媒計算方式，空白依平台預設，不影響他院', () => {
  const base = CS.calcSettingsFor(other).gwpSet;
  assert.equal(CS.calcSettingsFor(org).gwpSet, base);
  P.saveProfile(ctx, org, { gwpSet: 'AR6', refrigerantMethod: 'screening' });
  assert.equal(CS.calcSettingsFor(org).gwpSet, 'AR6');
  assert.equal(CS.calcSettingsFor(org).refrigerantMethod, 'screening');
  assert.equal(CS.calcSettingsFor(other).gwpSet, base);
  P.saveProfile(ctx, org, { gwpSet: '' });
  assert.equal(CS.calcSettingsFor(org).gwpSet, base);
  assert.throws(() => P.saveProfile(ctx, org, { gwpSet: 'AR9' }), /只能選列出的選項/);
});
