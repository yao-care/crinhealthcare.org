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

test('assessRecord：issues 帶 itemId（同名 label 的多台設備分得開）', () => {
  const P = { code: '803-E07', domain: 'power', name: '機房', items: [
    { id: 'ac1', label: '設備狀態', type: 'status', equipmentId: 'e1', required: true },
    { id: 'ac2', label: '設備狀態', type: 'status', equipmentId: 'e2', required: true },
  ] };
  const a = S.assessRecord(P, [], { ac1: '正常', zz: 1 });
  assert.deepEqual(a.issues, [{ itemId: null, message: '不認得的項目：zz' }, { itemId: 'ac2', message: '「設備狀態」必填' }]);
  assert.deepEqual(a.errors, a.issues.map((i) => i.message));
});

test('assessRecord：狀態「異常」而備註空白 → 該項目一筆 issue；沒傳 note 不檢查', () => {
  const P = { code: '803-E07', domain: 'power', name: '機房', items: [
    { id: 'ac1', label: '設備狀態', type: 'status' }, { id: 'ac2', label: '設備狀態', type: 'status' },
  ] };
  const a = S.assessRecord(P, [], { ac1: '正常', ac2: '異常' }, { note: '  ' });
  assert.deepEqual(a.issues, [{ itemId: 'ac2', message: '設備回報異常時請在備註寫明狀況' }]);
  assert.equal(S.assessRecord(P, [], { ac2: '異常' }, { note: '壓縮機異音' }).issues.length, 0);
  assert.equal(S.assessRecord(P, [], { ac2: '異常' }).issues.length, 0);
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
  // report-routes.js 還沒寫就回 501；寫好之後就由它處理（不再是 501）
  const rep = (await call('GET', '/api/inv/report/annex3')).status;
  if (existsSync(new URL('../src/report-routes.js', import.meta.url))) assert.notEqual(rep, 501);
  else assert.equal(rep, 501, 'report-routes.js 還沒寫就回 501');
});

test('API 貼紙頁：validation details 帶 itemId、異常備註必填、電號與 billColumns、填寫人', async () => {
  const H = { hid: '805' };
  let r = await call('PUT', '/api/inv/site/meters', { value: [{ meterNo: '07-1234-56', contractKw: 1200 }] }, H);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const meterId = r.body.value[0].id;
  r = await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '分離式冷氣', fields: { name: '機房冷氣 A' } } }, H);
  const eA = r.body.equipment.id;
  r = await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '分離式冷氣', fields: { name: '機房冷氣 B' } } }, H);
  const eB = r.body.equipment.id;

  r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '台電總表', items: [
    { id: 'kwh', label: '累計度數', type: 'reading', unit: 'kWh', meterId },
    { id: 'bill', label: '電費單', type: 'bill', meterId },
  ] } }, H);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e01 = r.body.point.code;
  r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '機房', items: [
    { id: 'acA', label: '設備狀態', type: 'status', equipmentId: eA, required: true },
    { id: 'acB', label: '設備狀態', type: 'status', equipmentId: eB, required: true },
  ] } }, H);
  const e02 = r.body.point.code;

  // GET：帶 meterId 的項目有 meterNo；有電費單型才附 billColumns
  r = await call('GET', `/api/inv/point/${e01}`, undefined, H);
  assert.deepEqual(r.body.point.items.map((i) => i.meterNo), ['07-1234-56', '07-1234-56']);
  assert.ok(r.body.billColumns.some((c) => c.key === 'feeTotal'));
  r = await call('GET', `/api/inv/point/${e02}`, undefined, H);
  assert.ok(!('meterNo' in r.body.point.items[0]));
  assert.equal(r.body.billColumns, undefined);

  // 422 validation：details 為 [{itemId, message}]，同名 label 的第二台標得到
  r = await call('POST', `/api/inv/point/${e02}/record`, { values: { acA: '正常' } }, H);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'validation');
  assert.deepEqual(r.body.details, [{ itemId: 'acB', message: '「設備狀態」必填' }]);
  r = await call('POST', `/api/inv/point/${e02}/record`, { values: { acA: '正常', acB: '正常', nope: 1 } }, H);
  assert.deepEqual(r.body.details, [{ itemId: null, message: '不認得的項目：nope' }]);

  // 異常而備註空白 → 422，itemId 指向那一台
  r = await call('POST', `/api/inv/point/${e02}/record`, { values: { acA: '正常', acB: '異常' }, note: ' ' }, H);
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.details, [{ itemId: 'acB', message: '設備回報異常時請在備註寫明狀況' }]);

  // 填寫人：過長 422；有填 → who＝姓名（院名）、另存 reporter
  r = await call('POST', `/api/inv/point/${e02}/record`, { values: { acA: '正常', acB: '正常' }, reporter: '王'.repeat(21) }, H);
  assert.equal(r.status, 422);
  assert.equal(r.body.details[0].itemId, null);
  r = await call('POST', `/api/inv/point/${e02}/record`, { values: { acA: '正常', acB: '異常' }, note: 'B 台漏水', reporter: ' 王小明 ' }, H);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.record.who, '王小明（測試院所805）');
  assert.equal(r.body.record.reporter, '王小明');
  assert.equal(r.body.record.anomalies[0].itemId, 'acB');
  r = await call('GET', `/api/inv/point/${e02}`, undefined, H);
  assert.equal(r.body.lastRecord.reporter, '王小明');
  r = await call('GET', '/api/inv/progress', undefined, H);
  assert.equal(r.body.points.find((p) => p.code === e02).lastBy, '王小明（測試院所805）');
  assert.equal(r.body.openAnomalies[0].reportedBy, '王小明（測試院所805）');

  // 沒填填寫人 → who 只有院名、reporter null
  r = await call('POST', `/api/inv/point/${e01}/record`, { values: { kwh: 10 } }, H);
  assert.equal(r.body.record.who, '測試院所805');
  assert.equal(r.body.record.reporter, null);
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

// ════════ 2026-10-22 最後一輪：原因必填、汰換改指向、建築 id、操作人姓名 ════════
test('API：已有資料的區塊與設備修改沒有原因 → 422 reason_required；初次建檔、沒變動不需要', async () => {
  const H = { hid: '806' };
  let r = await call('PUT', '/api/inv/site/buildings', { value: [{ name: '醫療大樓' }] }, H);
  assert.equal(r.status, 200, '初次建檔不要原因');
  const bid = r.body.value[0].id;
  r = await call('PUT', '/api/inv/site/buildings', { value: [{ id: bid, name: '醫療大樓' }] }, H);
  assert.equal(r.status, 200, '沒變動不要原因');
  assert.equal(r.body.change, null);
  r = await call('PUT', '/api/inv/site/buildings', { value: [{ id: bid, name: '醫療大樓 A 棟' }] }, H);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'reason_required');
  r = await call('PUT', '/api/inv/site/buildings', { value: [{ id: bid, name: '醫療大樓 A 棟' }], reason: '建物更名' }, H);
  assert.equal(r.status, 200);
  assert.equal(r.body.change.reason, '建物更名');

  r = await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '冰水泵', fields: { name: 'P-1', powerKw: 15, madeYear: 2018, qty: 1 } } }, H);
  const id = r.body.equipment.id;
  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { fields: { name: 'P-1', powerKw: 18, madeYear: 2018, qty: 1 } } }, H);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'reason_required');
  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { fields: { name: 'P-1', powerKw: 15, madeYear: 2018, qty: 1 } } }, H);
  assert.equal(r.status, 200);
  assert.equal(r.body.unchanged, true, '沒變動不要原因');
  r = await call('PUT', `/api/inv/equipment/${id}`, { equipment: { status: 'removed' } }, H);
  assert.equal(r.body.error, 'reason_required', '移除也要原因');
  const inv = await store.readInventory('806');
  assert.equal(inv.equipment.find((e) => e.id === id).fields.powerKw, 15, '被擋下的不寫檔');
});

test('API：汰換帶 replacedBy → 點位項目改指新設備、新設備承接 pointCode、同一筆 change；移除回傳仍連著的項目；GET 檢出不一致', async () => {
  const H = { hid: '807' };
  const eq = async (name) => (await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '中央空調主機', fields: { name, powerKw: 300, madeYear: 2008, qty: 1 } } }, H)).body.equipment.id;
  const oldId = await eq('CH-1 舊機');
  let r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '冰水機房', items: [
    { id: 'st', label: 'CH-1 狀態', type: 'status', equipmentId: oldId },
    { id: 'kwh', label: '度數', type: 'reading' },
  ] } }, H);
  const code = r.body.point.code;
  r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '屋頂', items: [{ id: 'st2', label: 'CH-1 遠端狀態', type: 'status', equipmentId: oldId }] } }, H);
  const code2 = r.body.point.code;
  assert.equal((await call('PUT', `/api/inv/equipment/${oldId}`, { equipment: { pointCode: code }, reason: '指定點位' }, H)).status, 200);
  const newId = await eq('CH-1 變頻機');

  // GET：新設備沒有 pointCode、沒有項目連它 → 沒問題；舊設備 pointCode＝code、項目在 code 和 code2 → 一致
  let all = (await call('GET', '/api/inv', undefined, H)).body;
  assert.deepEqual(all.linkIssues, []);

  assert.equal((await call('PUT', `/api/inv/equipment/${oldId}`, { equipment: { replacedBy: newId }, reason: 'x' }, H)).status, 422, '沒改成 replaced 不能帶 replacedBy');
  assert.equal((await call('PUT', `/api/inv/equipment/${oldId}`, { equipment: { status: 'replaced', replacedBy: 'eq-nope' }, reason: 'x' }, H)).status, 422);
  assert.equal((await call('PUT', `/api/inv/equipment/${oldId}`, { equipment: { status: 'replaced', replacedBy: oldId }, reason: 'x' }, H)).status, 422);

  r = await call('PUT', `/api/inv/equipment/${oldId}`, { equipment: { status: 'replaced', replacedBy: newId }, reason: '壓縮機故障汰換' }, H);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.change.kind, 'equipment.replace');
  assert.equal(r.body.change.after.replacedBy, newId);
  assert.deepEqual(r.body.change.links.items.map((x) => x.pointCode).sort(), [code, code2].sort());
  assert.deepEqual(r.body.change.links.newPointCode, { from: null, to: code });
  assert.deepEqual(r.body.linkedItems, [], '都改指了，沒有殘留');
  const inv = await store.readInventory('807');
  for (const p of inv.points) for (const it of p.items) assert.notEqual(it.equipmentId, oldId);
  assert.equal(inv.points.find((p) => p.code === code).items[0].equipmentId, newId);
  assert.equal(inv.equipment.find((e) => e.id === newId).pointCode, code, '新設備承接舊的所屬點位');
  assert.equal(inv.changes.filter((c) => c.target === `equipment.${oldId}` && c.kind === 'equipment.replace').length, 1, '只寫一筆 change');
  all = (await call('GET', '/api/inv', undefined, H)).body;
  assert.deepEqual(all.linkIssues, []);

  // 移除新設備：回傳仍連到它的點位項目；GET 檢出「項目連到已移除設備」
  r = await call('PUT', `/api/inv/equipment/${newId}`, { equipment: { status: 'removed' }, reason: '拆除' }, H);
  assert.equal(r.status, 200);
  assert.equal(r.body.change.kind, 'equipment.remove');
  assert.deepEqual(r.body.linkedItems.map((x) => `${x.pointCode}/${x.itemId}`).sort(), [`${code}/st`, `${code2}/st2`].sort());
  all = (await call('GET', '/api/inv', undefined, H)).body;
  assert.equal(all.linkIssues.filter((x) => x.type === 'item_inactive_equipment').length, 2);

  // 設備 pointCode 與點位項目對不上（以點位項目為準）
  const c3 = await eq('CH-2');
  await call('PUT', `/api/inv/points/${code}`, { point: { items: [{ id: 'st', label: 'CH-2 狀態', type: 'status', equipmentId: c3 }, { id: 'kwh', label: '度數', type: 'reading' }] } }, H);
  all = (await call('GET', '/api/inv', undefined, H)).body;
  const mis = all.linkIssues.find((x) => x.type === 'equipment_point_mismatch' && x.equipmentId === c3);
  assert.ok(mis, JSON.stringify(all.linkIssues));
  assert.equal(mis.expected, code);
  const c4 = await eq('CH-3');
  await call('PUT', `/api/inv/equipment/${c4}`, { equipment: { pointCode: code2 }, reason: '指定點位' }, H);
  all = (await call('GET', '/api/inv', undefined, H)).body;
  assert.ok(all.linkIssues.some((x) => x.type === 'equipment_point_unlinked' && x.equipmentId === c4 && x.expected === null));
});

test('變壓器建築物名稱：存 buildings[].id；舊資料文字讀取時對回 id，對不上保留原文字並列待修', async () => {
  const H = { hid: '808' };
  const f = S.siteBlockById('transformers').fields.find((x) => x.key === 'building');
  assert.equal(f.type, 'ref');
  assert.equal(f.ref, 'buildings');
  // 舊資料：直接寫檔（模擬改版前存的文字）
  const legacy = S.blankInventory();
  legacy.site.buildings = [{ id: 'bld-a', name: '醫療大樓' }, { id: 'bld-b', name: '行政大樓', code: 'B' }];
  legacy.site.transformers = [{ id: 'tr-1', code: 'TR-1', kva: 1000, building: '醫療大樓' }, { id: 'tr-2', code: 'TR-2', kva: 500, building: '舊門診棟' }, { id: 'tr-3', code: 'TR-3', kva: 500, building: 'B' }];
  await store.saveInventory('808', legacy, { what: '舊資料' });
  const all = (await call('GET', '/api/inv', undefined, H)).body;
  const tr = all.inventory.site.transformers;
  assert.equal(tr[0].building, 'bld-a', '名稱對回 id');
  assert.equal(tr[2].building, 'bld-b', '編號也對得回');
  assert.equal(tr[1].building, '舊門診棟', '對不上保留原文字');
  assert.equal(all.siteRefIssues.length, 1);
  assert.equal(all.siteRefIssues[0].rowId, 'tr-2');
  assert.match(all.siteRefIssues[0].message, /待修/);

  // 存檔：給名稱也換成 id；對不上只警告不擋
  const r = await call('PUT', '/api/inv/site/transformers', { value: [{ ...tr[0] }, { ...tr[1], building: '行政大樓' }, { ...tr[2] }, { code: 'TR-4', kva: 300, building: '不存在棟' }], reason: '補建築' }, H);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.value[1].building, 'bld-b');
  assert.equal(r.body.value[3].building, '不存在棟');
  assert.ok(r.body.warnings.some((w) => /不存在棟.*待修/.test(w)));
  // 報表印名稱
  assert.equal(S.refLabel({ buildings: legacy.site.buildings }, 'buildings', 'bld-a'), '醫療大樓');
});

test('操作人姓名 reporter：who 存「姓名（院名）」並另存 reporter；過長 422；沒填只有院名', async () => {
  const H = { hid: '809' };
  let r = await call('PUT', '/api/inv/site/buildings', { value: [{ name: 'A 棟' }] }, H);
  const bid = r.body.value[0].id;
  r = await call('PUT', '/api/inv/site/buildings', { value: [{ id: bid, name: 'A 棟（新）' }], reason: '更名', reporter: ' 王小明 ' }, H);
  assert.equal(r.status, 200);
  assert.equal(r.body.change.who, '王小明（測試院所809）');
  assert.equal(r.body.change.reporter, '王小明');
  r = await call('POST', '/api/inv/changes', { change: { kind: 'other', reason: '測試' } }, H);
  assert.equal(r.body.change.who, '測試院所809');
  assert.equal(r.body.change.reporter, null);
  r = await call('POST', '/api/inv/changes', { change: { kind: 'other', reason: '測試' }, reporter: '一'.repeat(21) }, H);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'validation');
  r = await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '冰水泵', fields: { name: 'P-9', powerKw: 5, madeYear: 2020, qty: 1 } }, reason: '新購', reporter: '李技士' }, H);
  assert.equal(r.body.change.who, '李技士（測試院所809）');
  const eid = r.body.equipment.id;
  r = await call('PUT', `/api/inv/equipment/${eid}`, { equipment: { status: 'removed' }, reason: '拆', reporter: '李技士' }, H);
  assert.equal(r.body.change.reporter, '李技士');
  // 點位、異常結案也帶得到
  r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: 'X', items: [{ id: 'st', label: '狀態', type: 'status' }] }, reporter: '李技士' }, H);
  const code = r.body.point.code;
  r = await call('PUT', `/api/inv/points/${code}`, { point: { name: 'X2' }, reporter: '李技士' }, H);
  assert.equal(r.body.change.who, '李技士（測試院所809）');
  r = await call('POST', `/api/inv/point/${code}/record`, { values: { st: '異常' }, note: '異音', reporter: '張護理師' }, H);
  const an = r.body.record.anomalies[0];
  r = await call('POST', `/api/inv/anomalies/${an.id}/close`, { note: '修好', reporter: '李技士' }, H);
  assert.equal(r.body.anomaly.closedBy, '李技士（測試院所809）');
  assert.equal(r.body.anomaly.closedReporter, '李技士');
  assert.equal(S.inventorySpec.reporter.storageKey, 'ems.sticker.reporter', '與貼紙頁同一個 localStorage key');
});
