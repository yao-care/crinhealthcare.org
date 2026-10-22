// 能源盤點（貼紙點位＋三類填報）的回歸測試。
//
// 蓋住「壞掉會很難發現」的那幾件事：
//   - 欄位規格每一格都有中文標籤與依據（前端照它長表單，漏了就是空白標題）
//   - 讀數倒退要擋、用量差太多要提示（抄錯一位數，整年的 EUI 就歪了）
//   - 別家院所的點位代碼 → 403（貼紙貼在走廊，任何人都拍得到）
//   - 設備異常要進未結清單、能結案；設備修改要自動留異動紀錄
//   - 「記住 30 天」只在勾選時生效
//
// 資料一律寫到暫存目錄：config.js 會讀 .env（production 設定），環境變數先設好才 import。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'ems-inv-test-'));
process.env.AUDIT_DATA_DIR = join(TMP, 'data');
process.env.AUDIT_UPLOADS_DIR = join(TMP, 'uploads');
process.env.ACCOUNTS_FILE = join(TMP, 'accounts.json');
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123';
process.env.PUBLIC_BASE_URL = 'https://ems-admin.example.test';

const S = await import('../src/inventory-schema.js');
const store = await import('../src/inventory-store.js');
const { handleInventory } = await import('../src/inventory-routes.js');
const auth = await import('../src/auth.js');
const { login } = await import('../src/accounts.js');
const { config, originAllowed } = await import('../src/config.js');

// ── 測試用伺服器：跟 server.js 一樣的分派方式，只是 session 從 header 帶（省掉登入流程）──
let server, base;
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
  return true;
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad_json')); } });
});
const originOk = (req) => originAllowed(req.headers.origin);

before(async () => {
  server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const sess = auth.readSession(req);
    if (!sess) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const h = await handleInventory({ req, res, sess, pathname, json, readBody, originOk });
      if (!h) json(res, 404, { ok: false });
    } catch (e) { json(res, 500, { ok: false, error: String(e.message || e) }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(TMP, { recursive: true, force: true }); });

const cookieFor = (hid) => `ems_admin_session=${auth.signToken({ sub: `hosp-${hid}`, hid, name: `測試院所${hid}` })}`;
async function call(method, path, body, { hid = '803', origin } = {}) {
  const headers = { cookie: cookieFor(hid) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

// ════════ 規格 ════════
test('規格：每個區塊、設備類別、項目類型都有中文標籤與依據 source', () => {
  const zh = /[一-鿿]/;
  for (const b of S.SITE_BLOCKS) {
    assert.ok(zh.test(b.label), `區塊 ${b.id} 缺中文標籤`);
    assert.ok(b.source?.doc, `區塊 ${b.id} 缺 source`);
    for (const f of b.fields) {
      assert.ok(zh.test(f.label), `${b.id}.${f.key} 缺中文標籤`);
      assert.ok(S.FIELD_TYPES.includes(f.type), `${b.id}.${f.key} 型別不合法：${f.type}`);
      if (f.type === 'select' || f.type === 'multiselect') assert.ok(f.options?.length, `${b.id}.${f.key} 缺選項`);
    }
    const keys = b.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${b.id} 欄位鍵重複`);
  }
  assert.deepEqual(S.SITE_BLOCKS.map((b) => b.id), ['basic', 'meters', 'buildings', 'transformers', 'generators', 'staff', 'org', 'policy', 'exemption']);
  assert.deepEqual(S.EQUIPMENT_CATEGORIES.map((c) => c.id), ['ac', 'lighting', 'other']);
  for (const c of S.EQUIPMENT_CATEGORIES) {
    assert.ok(c.kinds.length && c.source?.ref, `${c.id} 缺 kinds 或 source`);
    for (const f of c.fields) {
      assert.ok(zh.test(f.label), `${c.id}.${f.key} 缺中文標籤`);
      for (const k of f.kinds || []) assert.ok(c.kinds.includes(k), `${c.id}.${f.key} 的 kinds 有不存在的種類 ${k}`);
    }
    for (const g of c.groups) assert.ok(g.source, `${c.id} 欄位群「${g.name}」缺 source`);
  }
  assert.equal(S.EQUIPMENT_CATEGORIES.find((c) => c.id === 'ac').kinds.length, 13, '表九之一（三）空調是 13 類');
  assert.deepEqual(S.ITEM_TYPES.map((t) => t.id), ['reading', 'status', 'bill', 'number', 'text', 'photo']);
  for (const t of S.ITEM_TYPES) assert.ok(t.source?.doc, `項目類型 ${t.id} 缺 source`);
});

test('規格：國軍醫院不提供 EX01 排除條件（業主 2026-10-22 確認）', () => {
  const f = S.siteBlockById('exemption').fields.find((x) => x.key === 'exemptCode');
  assert.ok(!f.options.includes('EX01'));
  assert.equal(S.validateSiteBlock('exemption', { exempt: true, exemptCode: 'EX01' }, () => 'x').ok, false);
});

test('blankInventory 骨架齊全', () => {
  const b = S.blankInventory();
  assert.equal(b.version, 1);
  for (const k of ['equipment', 'points', 'records', 'changes', 'measures', 'plans']) assert.deepEqual(b[k], []);
  assert.deepEqual(b.site.basic, {});
  assert.deepEqual(b.site.meters, []);
});

test('點位代碼：以最後一個 - 切出 hid', () => {
  assert.deepEqual(S.parseCode('803-E07'), { hid: '803', letter: 'E', num: 7, domain: 'power' });
  assert.equal(S.parseCode('tri-gen-W12').hid, 'tri-gen');
  assert.equal(S.parseCode('803-X07'), null);
  assert.equal(S.parseCode('803-E7'), null);
  assert.equal(S.makeCode('803', 'water', 3), '803-W03');
});

test('validatePoint：類型、選項、警示只能放在對的類型上', () => {
  const ok = S.validatePoint({ code: '803-E01', domain: 'power', name: '總表', items: [{ id: 'kwh', label: '累計度數', type: 'reading', warnPct: 30 }] });
  assert.ok(ok.ok, ok.errors?.join());
  assert.equal(ok.point.active, true);
  assert.equal(S.validatePoint({ code: '803-W01', domain: 'power', name: 'x', items: [{ id: 'a', label: 'a', type: 'text' }] }).ok, false, '代碼字母與類別不符');
  assert.equal(S.validatePoint({ code: '803-E01', domain: 'power', name: 'x', items: [{ id: 'a', label: 'a', type: 'text', warnPct: 5 }] }).ok, false);
  assert.equal(S.validatePoint({ code: '803-E01', domain: 'power', name: 'x', items: [{ id: 'a', label: 'a', type: 'nope' }] }).ok, false);
  assert.equal(S.validatePoint({ code: '803-E01', domain: 'power', name: 'x', items: [{ id: 'a', label: 'a', type: 'text' }, { id: 'a', label: 'b', type: 'text' }] }).ok, false);
});

test('validateEquipment：kind 專屬欄位、民國年換算、不認得的欄位', () => {
  const inv = S.blankInventory();
  const a = S.validateEquipment({ category: 'ac', kind: '分離式冷氣', fields: { name: '護理站冷氣', energyLabel: true, madeYear: '104', powerKw: '3.5', qty: 2 } }, inv);
  assert.ok(a.ok, a.errors.join());
  assert.equal(a.fields.madeYear, 2015);
  assert.equal(a.fields.powerKw, 3.5);
  const b = S.validateEquipment({ category: 'ac', kind: '冰水泵', fields: { name: 'P1', energyLabel: true } }, inv);
  assert.equal(b.ok, false, '節能標章只問箱窗分離式');
  assert.equal(S.validateEquipment({ category: 'ac', kind: '冰水泵', fields: { bogus: 1 } }, inv).ok, false);
  assert.equal(S.validateEquipment({ category: 'lighting', kind: '冰水泵', fields: {} }, inv).ok, false);
  assert.equal(S.validateEquipment({ category: 'other', kind: '鍋爐', fields: { model: '亂填' } }, inv).ok, false, '鍋爐型式有固定選項');
});

// ════════ 用量計算（純函式）════════
const PT = { code: '803-E01', domain: 'power', name: '總表', items: [
  { id: 'kwh', label: '累計度數', type: 'reading', unit: 'kWh', warnPct: 30, required: true },
  { id: 'st', label: '設備狀態', type: 'status' },
] };
const rec = (at, kwh, usage) => ({ pointCode: '803-E01', at, period: at.slice(0, 7), values: { kwh }, usage: { kwh: usage } });

test('assessRecord：用量＝本次－上次；第一次抄表用量 null', () => {
  assert.equal(S.assessRecord(PT, [], { kwh: 1000 }).usage.kwh, null);
  const a = S.assessRecord(PT, [rec('2026-08-01T00:00:00Z', 900, null), rec('2026-09-01T00:00:00Z', 1000, 100)], { kwh: 1110 });
  assert.equal(a.usage.kwh, 110);
  assert.deepEqual(a.warnings, []);
  assert.equal(S.readingUsage(0.3, 0.1), 0.2, '浮點誤差要收掉');
});

test('assessRecord：讀數倒退擋下，確認換表後放行', () => {
  const prev = [rec('2026-09-01T00:00:00Z', 1000, 100)];
  const a = S.assessRecord(PT, prev, { kwh: 990 });
  assert.equal(a.decreases.length, 1);
  assert.match(a.decreases[0].message, /小於上次/);
  const b = S.assessRecord(PT, prev, { kwh: 5 }, { confirmDecrease: ['kwh'] });
  assert.equal(b.decreases.length, 0);
  assert.equal(b.usage.kwh, null);
});

test('assessRecord：用量差超過 warnPct 只警告不擋', () => {
  const a = S.assessRecord(PT, [rec('2026-09-01T00:00:00Z', 1000, 100)], { kwh: 1200 });
  assert.equal(a.usage.kwh, 200);
  assert.equal(a.errors.length + a.decreases.length, 0);
  assert.equal(a.warnings.length, 1);
});

test('assessRecord：必填、狀態選項、異常', () => {
  assert.ok(S.assessRecord(PT, [], { st: '正常' }).errors.some((e) => /必填/.test(e)));
  assert.ok(S.assessRecord(PT, [], { kwh: 1, st: '壞了' }).errors.length);
  assert.equal(S.assessRecord(PT, [], { kwh: 1, st: '異常' }).anomalyItems[0].id, 'st');
});

test('assessRecord：電費單未逐格確認 → pending（複驗閘門）', () => {
  const P = { code: '803-E02', domain: 'power', name: '電費', items: [{ id: 'bill', label: '電費單', type: 'bill' }] };
  const v = { values: { period: '2026-09', meterNo: '01-2345-67', feeTotal: 123456 }, meta: { feeTotal: { state: 'todo' }, period: { state: 'ok' } } };
  assert.equal(S.assessRecord(P, [], { bill: v }).pending.length, 1);
  v.meta.feeTotal.state = 'ok';
  const ok = S.assessRecord(P, [], { bill: v });
  assert.equal(ok.pending.length, 0);
  assert.equal(ok.values.bill.values.feeTotal, 123456);
});

// ════════ 儲存 ════════
test('store：沒有檔案回骨架；寫入落在 dataDir/inventory 並 commit、沒有 remote', async () => {
  const empty = await store.readInventory('901');
  assert.deepEqual(empty.points, []);
  const r = await store.mutateInventory('901', (inv) => { inv.site.basic = { userName: '測試' }; return 'x'; }, { who: '測試', what: '寫入' });
  assert.equal(r.result, 'x');
  assert.ok(r.commit);
  assert.ok(existsSync(join(config.dataDir, 'inventory', '901.json')));
  assert.equal((await store.readInventory('901')).site.basic.userName, '測試');
  assert.equal(execFileSync('git', ['remote'], { cwd: config.dataDir }).toString().trim(), '');
  assert.ok(!config.dataDir.startsWith('/opt/'), '測試不可碰 production 目錄');
});

test('store：mutator 丟例外就不寫檔；同時寫入不互相覆蓋', async () => {
  await assert.rejects(store.mutateInventory('902', (inv) => { inv.points.push({}); throw new Error('nope'); }));
  assert.equal((await store.readInventory('902')).points.length, 0);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.mutateInventory('902', (inv) => { inv.changes.push({ id: String(i) }); })));
  assert.equal((await store.readInventory('902')).changes.length, 8);
});

// ════════ API ════════
test('API：建點位 → 讀表單 → 送讀數 → 用量、倒退 422、警示', async () => {
  let r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: 'B1 總表', location: 'B1 電氣室', items: [
    { id: 'kwh', label: '累計度數', type: 'reading', unit: 'kWh', warnPct: 30, required: true },
    { id: 'st', label: '設備狀態', type: 'status' },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = r.body.point.code;
  assert.equal(code, '803-E01');
  assert.equal(r.body.point.url, 'https://ems-admin.example.test/s/803-E01');

  r = await call('GET', `/api/inv/point/${code}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.point.items[1].options, S.DEFAULT_STATUS_OPTIONS);
  assert.equal(r.body.recordedThisPeriod, false);
  assert.ok(r.body.source?.text);

  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2026-08', values: { kwh: 1000, st: '正常' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.usage.kwh, null);
  assert.equal(r.body.nextPeriod, '2026-09');
  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2026-09', values: { kwh: 1100 } });
  assert.equal(r.body.usage.kwh, 100);

  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2026-10', values: { kwh: 1050 } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'reading_decreased');
  assert.equal(r.body.details[0].prev, 1100);

  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2026-10', values: { kwh: 1300 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.usage.kwh, 200);
  assert.equal(r.body.warnings.length, 1, '用量 200 vs 上次 100，差 100% > 30%');

  r = await call('GET', `/api/inv/point/${code}`);
  assert.equal(r.body.point.items[0].last.value, 1300);
});

test('API：hid 不符一律 403；改變狀態要 originOk', async () => {
  for (const [m, p, b] of [
    ['GET', '/api/inv/point/804-E01'],
    ['POST', '/api/inv/point/804-E01/record', { values: {} }],
    ['GET', '/api/inv/points/804-E01/qr.png'],
    ['PUT', '/api/inv/points/804-E01', { point: { name: 'x' } }],
  ]) {
    const r = await call(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  // 自己指定別家的代碼來建點位也不行
  assert.equal((await call('POST', '/api/inv/points', { point: { code: '804-E05', domain: 'power', name: 'x', items: [{ id: 'a', label: 'a', type: 'text' }] } })).status, 403);
  assert.equal((await call('POST', '/api/inv/changes', { change: { kind: 'other', reason: 'x' } }, { origin: 'https://evil.example' })).status, 403);
});

test('API：設備回報異常 → 進未結清單 → 結案', async () => {
  let r = await call('POST', '/api/inv/point/803-E01/record', { period: '2026-10', values: { kwh: 1400, st: '異常' }, note: '異音' });
  assert.equal(r.status, 200);
  const an = r.body.record.anomalies[0];
  assert.equal(an.label, '設備狀態');
  r = await call('GET', '/api/inv/progress?period=2026-10');
  assert.equal(r.body.done, 1);
  assert.equal(r.body.openAnomalies.length, 1);
  assert.equal(r.body.openAnomalies[0].id, an.id);
  assert.equal(r.body.openAnomalies[0].note, '異音');

  r = await call('POST', `/api/inv/anomalies/${an.id}/close`, { note: '已更換軸承' });
  assert.equal(r.status, 200);
  assert.equal(r.body.anomaly.closeNote, '已更換軸承');
  assert.equal((await call('POST', `/api/inv/anomalies/${an.id}/close`, {})).status, 409);
  r = await call('GET', '/api/inv/progress?period=2026-10');
  assert.equal(r.body.openAnomalies.length, 0);
  assert.equal((await call('GET', '/api/inv/progress?period=2026-11')).body.done, 0);
});

test('API：設備新增不記異動；修改自動寫一筆 changes（before/after）', async () => {
  let r = await call('PUT', '/api/inv/site/buildings', { value: [{ name: '醫療大樓', builtYear: 85 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bid = r.body.value[0].id;
  assert.equal(r.body.value[0].builtYear, 1996);
  assert.equal(r.body.change, null, '第一次建檔不算異動');

  r = await call('POST', '/api/inv/equipment', { equipment: { building: bid, category: 'ac', kind: '中央空調主機', fields: { name: '1 號冰水主機', powerKw: 300, madeYear: 2010, qty: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.equipment.id;
  assert.equal(r.body.change, null);

  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { fields: { name: '1 號冰水主機', powerKw: 280, madeYear: 2010, qty: 1 } }, changeKind: 'equipment.correct', reason: '銘牌重抄' });
  assert.equal(r.status, 200);
  assert.equal(r.body.change.kind, 'equipment.correct');
  assert.equal(r.body.change.before.fields.powerKw, 300);
  assert.equal(r.body.change.after.fields.powerKw, 280);

  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { status: 'replaced' }, reason: '汰換為變頻機' });
  assert.equal(r.body.change.kind, 'equipment.replace');

  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { status: 'replaced' } });
  assert.equal(r.body.unchanged, true, '沒改東西不該多一筆異動');

  r = await call('GET', '/api/inv/changes');
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.items[0].kind, 'equipment.replace', '新的在前');

  assert.equal((await call('POST', '/api/inv/equipment', { equipment: { building: 'nope', category: 'ac', kind: '中央空調主機', fields: {} } })).status, 422);
});

test('API：手動異動登錄原因必填；點位代碼不能改；QR 是 PNG', async () => {
  assert.equal((await call('POST', '/api/inv/changes', { change: { kind: 'staff', reason: '' } })).status, 422);
  assert.equal((await call('POST', '/api/inv/changes', { change: { kind: 'measure.done', target: 'measure.M01', reason: 'LED 換裝完工' } })).status, 200);

  assert.equal((await call('PUT', '/api/inv/points/803-E01', { point: { code: '803-E09' } })).status, 422);
  const r = await call('PUT', '/api/inv/points/803-E01', { point: { location: 'B2 電氣室' }, reason: '搬家' });
  assert.equal(r.status, 200);
  assert.equal(r.body.point.url, 'https://ems-admin.example.test/s/803-E01', '搬家網址不變');

  const q = await call('GET', '/api/inv/points/803-E01/qr.png');
  assert.equal(q.status, 200);
  assert.equal(q.headers.get('content-type'), 'image/png');
  assert.deepEqual([...q.body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('API：停用的點位不能再填；spec 與整份資料讀得到', async () => {
  await call('PUT', '/api/inv/points/803-E01', { point: { active: false } });
  assert.equal((await call('GET', '/api/inv/point/803-E01')).status, 410);
  assert.equal((await call('POST', '/api/inv/point/803-E01/record', { values: { kwh: 2000 } })).status, 410);
  // 停用的代碼不會被重發
  const r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '新表', items: [{ id: 'kwh', label: '度數', type: 'reading' }] } });
  assert.equal(r.body.point.code, '803-E02');

  const s = await call('GET', '/api/inv/spec');
  assert.equal(s.body.spec.site.length, 9);
  assert.ok(s.body.spec.site[0].source.law);
  const all = await call('GET', '/api/inv');
  assert.equal(all.body.inventory.points.length, 2);
  assert.equal((await call('GET', '/api/inv/report/annex3')).status, 501, 'report-routes.js 還沒寫就回 501');
});

// ════════ 登入：記住 30 天 ════════
test('登入 remember：勾選才給 30 天 token 與 cookie，預設 8 小時', () => {
  writeFileSync(process.env.ACCOUNTS_FILE, JSON.stringify({ accounts: [{ username: 'hosp-803', hospitalId: '803', password: auth.hashPassword('pw-803') }] }));
  const day = 24 * 3600 * 1000;
  const a = login('hosp-803', 'pw-803');
  const b = login('hosp-803', 'pw-803', { remember: true });
  assert.equal(a.ttlMs, 8 * 3600 * 1000);
  assert.equal(b.ttlMs, 30 * day);

  const exp = (t) => auth.verifyToken(t).exp - Date.now();
  assert.ok(exp(auth.signToken(b.session, { ttlMs: b.ttlMs })) > 29 * day);
  assert.ok(exp(auth.signToken(a.session, { ttlMs: a.ttlMs })) < day);

  const fakeRes = () => { const h = {}; return { h, setHeader: (k, v) => { h[k] = v; } }; };
  const r1 = fakeRes(); auth.setSessionCookie(r1, 'x', { ttlMs: b.ttlMs });
  assert.match(r1.h['Set-Cookie'], new RegExp(`Max-Age=${30 * 24 * 3600}(;|$)`));
  const r2 = fakeRes(); auth.setSessionCookie(r2, 'x');
  assert.match(r2.h['Set-Cookie'], /Max-Age=28800(;|$)/);
});

test('新版附表三：表三第 25 欄、電號 5 種契約容量、措施代碼表', () => {
  const basic = S.siteBlockById('basic').fields;
  assert.equal(basic.find((f) => f.code === '25').key, 'isSme');
  assert.ok(!basic.some((f) => f.key === 'mainMeterNo'), '電號已移出表三基本資料');
  const m = S.siteBlockById('meters').fields.map((f) => f.key);
  for (const k of ['contractKw', 'contractHalfPeakKw', 'contractSatHalfPeakKw', 'contractOffPeakKw', 'contractStandbyKw']) assert.ok(m.includes(k), k);
  assert.ok(S.isMeasureCode('AA06') && S.isMeasureCode('LG31') && S.isMeasureCode('OA08'));
  assert.ok(!S.isMeasureCode('AZ06') && !S.isMeasureCode('AA98'));
  assert.ok(S.validateEquipment({ category: 'other', kind: '鍋爐', fields: { name: 'B1', subKind: '蒸汽', boilerEnergyType: '電力' } }, S.blankInventory()).ok);
});
