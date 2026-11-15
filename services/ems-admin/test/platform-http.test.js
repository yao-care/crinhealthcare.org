// 平台 HTTP 層：登入、session、首次改密碼、CSRF、上傳、權限 403、推送權杖、OpenAPI、舊入口範圍
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ems-http-'));
Object.assign(process.env, {
  PLATFORM_DB: join(tmp, 'p.sqlite'), AUDIT_DATA_DIR: join(tmp, 'data'), AUDIT_UPLOADS_DIR: join(tmp, 'up'), REPO_DIR: join(tmp, 'repo'),
  ACCOUNTS_FILE: join(tmp, 'accounts.json'), PLATFORM_SCHEDULER: '0', JWT_SECRET: 'http-test-secret-123456', COOKIE_SECURE: '0', HTTP_PORT: String(18000 + Math.floor(Math.random() * 2000)),
});
mkdirSync(join(tmp, 'repo', 'src', 'content', 'hospitals'), { recursive: true });
writeFileSync(join(tmp, 'repo', 'src', 'content', 'hospitals', '803.json'), JSON.stringify({ name: '國軍臺中總醫院' }));
const { hashPassword } = await import('../src/auth.js');
writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [{ username: 'hosp-803', hospitalId: '803', displayName: '國軍臺中總醫院', password: hashPassword('Legacy12345') }] }));

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
db.openDb(); runSeeds();
const { createServer } = await import('node:http');
let base; let server;

before(async () => {
  const mod = await import('../src/server.js');
  await new Promise((r) => { mod.start(); setTimeout(r, 200); });
  const { config } = await import('../src/config.js');
  base = `http://127.0.0.1:${config.httpPort}`;
});
after(async () => { const mod = await import('../src/server.js'); await mod.stop(); });

void createServer;
const jar = new Map();
async function call(user, method, path, body, headers = {}) {
  const h = { ...headers }; if (jar.get(user)) h.cookie = jar.get(user);
  let b = body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, { method, headers: h, body: b });
  const sc = res.headers.get('set-cookie'); if (sc) jar.set(user, sc.split(';')[0]);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('舊院所帳號登入 → 平台可用、舊入口有院所範圍', async () => {
  const r = await call('legacy', 'POST', '/api/login', { username: 'hosp-803', password: 'Legacy12345' });
  assert.equal(r.json.ok, true); assert.equal(r.json.platform, true); assert.equal(r.json.hid, '803');
  const me = await call('legacy', 'GET', '/api/v1/me');
  assert.ok(me.json.data.orgs.length >= 1);
  assert.ok(me.json.data.orgs.find((o) => o.code === '803').actions.includes('user.manage'));
});

test('院所管理者建立個人帳號 → 首次登入只能改密碼', async () => {
  const me = await call('legacy', 'GET', '/api/v1/me');
  const org = me.json.data.orgs.find((o) => o.code === '803').id;
  const c = await call('legacy', 'POST', '/api/v1/users', { username: 'staff1', displayName: '同仁一', password: 'Passw0rd123', grants: [{ role: 'collector', scopeType: 'org', scopeId: org }] });
  assert.equal(c.status, 200, c.text);
  const l = await call('staff1', 'POST', '/api/login', { username: 'staff1', password: 'Passw0rd123' });
  assert.equal(l.json.mustChange, true);
  const blocked = await call('staff1', 'GET', '/api/v1/assets');
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'must_change_password');
  const pw = await call('staff1', 'POST', '/api/v1/me/password', { oldPassword: 'Passw0rd123', newPassword: 'NewPassw0rd9' });
  assert.equal(pw.status, 200, pw.text);
  assert.equal((await call('staff1', 'GET', '/api/v1/assets')).status, 200);
  // 個人帳號（盤點承辦、單一院所）也可進舊入口
  assert.equal(l.json.hid, '803');
});

test('未登入 401、沒權限 403（中文訊息）、跨來源 POST 403', async () => {
  assert.equal((await call('nobody', 'GET', '/api/v1/assets')).status, 401);
  const r = await call('staff1', 'GET', '/api/v1/users');
  assert.equal(r.status, 403); assert.match(r.json.message, /權限/);
  const x = await call('staff1', 'POST', '/api/v1/tasks', { title: 'x' }, { origin: 'https://evil.example' });
  assert.equal(x.status, 403); assert.equal(x.json.error, 'bad_origin');
});

test('上傳佐證（multipart）＋下載留稽核＋檔案型態檢查', async () => {
  const me = await call('staff1', 'GET', '/api/v1/me');
  const org = me.json.data.orgs.find((o) => o.code === '803').id;
  const fd = new FormData(); fd.append('orgId', org); fd.append('file', new Blob([Buffer.from('%PDF-1.4 hello')], { type: 'application/pdf' }), '帳單.pdf');
  const up = await call('staff1', 'POST', '/api/v1/evidence', fd);
  assert.equal(up.status, 200, up.text);
  const dl = await call('staff1', 'GET', `/api/v1/evidence/${up.json.data.id}/file`);
  assert.equal(dl.status, 200); assert.match(dl.text, /PDF/);
  assert.ok(dl.headers.get('content-security-policy'));
  const fd2 = new FormData(); fd2.append('orgId', org); fd2.append('file', new Blob([Buffer.from('MZ....')]), 'x.exe');
  assert.equal((await call('staff1', 'POST', '/api/v1/evidence', fd2)).status, 422);
});

test('OpenAPI 文件可取得', async () => {
  const r = await call('nobody', 'GET', '/api/v1/openapi.json');
  assert.equal(r.status, 200);
  assert.ok(Object.keys(r.json.paths).length > 100);
});

test('推送介接：權杖錯誤 401、正確才寫入、重送冪等', async () => {
  const me = await call('legacy', 'GET', '/api/v1/me');
  const org = me.json.data.orgs.find((o) => o.code === '803').id;
  const a = await call('legacy', 'POST', '/api/v1/assets', { orgId: org, itemId: db.q.get("SELECT id FROM inventory_items WHERE code='ELE-GRID'").id, domain: 'electricity', assetType: 'power_account', name: '推送測試電號', externalKey: 'PUSH-1' });
  assert.equal(a.status, 200, a.text);
  const i = await call('legacy', 'POST', '/api/v1/integrations', { orgId: org, connector: 'push', name: 'EMS 推送' });
  const tok = await call('legacy', 'POST', `/api/v1/integrations/${i.json.data.id}/token`);
  const body = { observations: [{ asset_id: 'PUSH-1', metric_code: 'elec_metered_kwh', period_start: '2026-10-01T00:00:00+08:00', period_end: '2026-11-01T00:00:00+08:00', raw_value: '102450', raw_unit: 'kWh', source_record_key: 'ems-202610-a01' }] };
  assert.equal((await call('ext', 'POST', `/api/v1/integrations/${i.json.data.id}/push`, body, { authorization: 'Bearer wrong' })).status, 401);
  const ok = await call('ext', 'POST', `/api/v1/integrations/${i.json.data.id}/push`, body, { authorization: `Bearer ${tok.json.data.token}` });
  assert.equal(ok.json.data.created, 1, ok.text);
  const again = await call('ext', 'POST', `/api/v1/integrations/${i.json.data.id}/push`, body, { authorization: `Bearer ${tok.json.data.token}` });
  assert.equal(again.json.data.duplicate, 1);
});

test('平台前端頁面可載入', async () => {
  const r = await call('nobody', 'GET', '/p/');
  assert.equal(r.status, 200); assert.match(r.text, /油水電氣資料治理平台/);
  assert.equal((await call('nobody', 'GET', '/p/core.js')).status, 200);
});
