// 點位清單批次匯入（工作清單第 25 項）：範本、預覽不寫入、apply 寫入、更新不改代碼、對應錯誤、CLI dry-run。
// 資料一律寫到暫存目錄：config.js 會讀 .env（production 設定），環境變數先設好才 import。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'ems-pimport-test-'));
process.env.AUDIT_DATA_DIR = join(TMP, 'data');
process.env.AUDIT_UPLOADS_DIR = join(TMP, 'uploads');
process.env.ACCOUNTS_FILE = join(TMP, 'accounts.json');
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123';
process.env.PUBLIC_BASE_URL = 'https://ems-admin.example.test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = await import('../src/inventory-store.js');
const PI = await import('../src/points-import.js');
const { handleInventory } = await import('../src/inventory-routes.js');
const auth = await import('../src/auth.js');
const { originAllowed } = await import('../src/config.js');
const { buildWorkbook, readWorkbook } = await import('../src/xlsx.js');

let server, base;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
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
    if (!sess) return json(res, 401, { ok: false });
    try { if (!(await handleInventory({ req, res, sess, pathname, json, readBody, originOk }))) json(res, 404, { ok: false }); }
    catch (e) { json(res, 500, { ok: false, error: String(e.stack || e) }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(TMP, { recursive: true, force: true }); });

const cookie = (hid = '803') => `ems_admin_session=${auth.signToken({ sub: `hosp-${hid}`, hid, name: `測試院所${hid}` })}`;
async function call(method, path, body) {
  const headers = { cookie: cookie() };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
const HEAD = PI.IMPORT_COLUMNS.map((c) => c.label);
const xlsxOf = (rows) => buildWorkbook([{ name: '點位清單', rows: [HEAD, ...rows] }]).buffer;
function upload(rows, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([xlsxOf(rows)]), '業主點位清單.xlsx');
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return call('POST', '/api/inv/points/import', fd);
}
const commits = () => execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: process.env.AUDIT_DATA_DIR }).toString().trim();

//            代碼  類別  名稱             位置        項目id   類型       標籤             單位   選項               warn  設備     電號
const NEW_ROWS = [
  ['', '電', 'B1 冰水主機房', '醫療大樓 B1', 'kwh', '累計讀數', '子電表累計度數', 'kWh', '', '30', '', 'M-001'],
  ['', '', '', '', '', '設備狀態', '1 號冰水機狀態', '', '正常、異常、停機', '', 'CH-01', ''],
  ['', '水', '自來水總表', '大門', 'm3', 'reading', '水表讀數', 'm³', '', '', '', ''],
  ['範例', '電', '這列是範例', '', 'x', '文字', '略過', '', '', '', '', ''],
];

test('準備：電號與設備主檔', async () => {
  let r = await call('PUT', '/api/inv/site/meters', { value: [{ meterNo: 'M-001', contractKw: 500 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', '/api/inv/equipment', { equipment: { category: 'ac', kind: '中央空調主機', fields: { name: '1 號冰水機', deviceNo: 'CH-01' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('範本：三張工作表、欄位照順序、範例列再上傳會略過', async () => {
  const r = await call('GET', '/api/inv/points/template.xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const wb = readWorkbook(r.body);
  assert.deepEqual([...wb.sheets.keys()], ['點位清單', '說明', '設備與電號']);
  const sh = wb.sheets.get('點位清單');
  assert.deepEqual(['A1', 'B1', 'C1', 'L1'].map((x) => sh.cells.get(x)), ['點位代碼', '類別', '名稱', '連結電號']);
  assert.equal(sh.cells.get('A2'), PI.EXAMPLE_MARK);
  assert.ok([...wb.sheets.get('設備與電號').cells.values()].includes('CH-01'), '設備對照表要列出設備編號');
  const fd = new FormData();
  fd.append('file', new Blob([r.body]), 'template.xlsx');
  const p = await call('POST', '/api/inv/points/import', fd);
  assert.equal(p.status, 200);
  assert.equal(p.body.preview.counts.skipped, 4);
  assert.equal(p.body.preview.ok, false, '只有範例列 → 沒有可匯入的列');
});

test('預覽不寫入：新增 2 個、範例列略過、設備編號與電號對到 id', async () => {
  const n0 = commits();
  const r = await upload(NEW_ROWS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const P = r.body.preview;
  assert.equal(r.body.applied, false);
  assert.ok(P.ok, JSON.stringify(P.errors));
  assert.deepEqual({ add: P.counts.add, update: P.counts.update, skipped: P.counts.skipped }, { add: 2, update: 0, skipped: 1 });
  const [e, w] = P.points;
  assert.equal(e.code, '803-E01'); assert.ok(e.autoCode);
  assert.equal(w.code, '803-W01');
  assert.equal(e.items.length, 2, '代碼名稱都空白的列接續上一個點位');
  const inv = await store.readInventory('803');
  assert.equal(e.items[0].meterId, inv.site.meters[0].id);
  assert.equal(e.items[1].equipmentId, inv.equipment[0].id);
  assert.equal(e.items[1].id, 'status1', '項目 id 空白自動配號');
  assert.equal(inv.points.length, 0, '預覽不寫入');
  assert.equal(commits(), n0);
});

test('apply 寫入：整批一次 commit、一筆 point.import 異動帶 reporter 與原因', async () => {
  const n0 = Number(commits());
  const r = await upload(NEW_ROWS, { apply: 'true', reporter: '王小明', reason: '業主提供清單' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, true);
  assert.equal(Number(commits()), n0 + 1);
  const inv = await store.readInventory('803');
  assert.deepEqual(inv.points.map((p) => p.code), ['803-E01', '803-W01']);
  const c = inv.changes.filter((x) => x.kind === 'point.import');
  assert.equal(c.length, 1);
  assert.equal(c[0].reporter, '王小明');
  assert.equal(c[0].who, '王小明（測試院所803）');
  assert.equal(c[0].reason, '業主提供清單');
  assert.deepEqual(c[0].links.added, ['803-E01', '803-W01']);
  // 連到的設備還沒有所屬點位 → 跟著點位項目補上
  assert.equal(inv.equipment[0].pointCode, '803-E01');
  assert.deepEqual(c[0].links.equipmentPointCode, [{ equipmentId: inv.equipment[0].id, pointCode: '803-E01' }]);
  // 再匯一次同一份：沒有代碼 → 另建新點位，並警告有同名點位
  const again = await upload(NEW_ROWS);
  assert.equal(again.body.preview.counts.add, 2);
  assert.ok(again.body.preview.warnings.some((x) => /同名點位/.test(x)));
});

test('更新：依代碼改名稱／位置／項目，代碼與類別不可改，項目 id 依標籤沿用', async () => {
  const before = (await store.readInventory('803')).points.find((p) => p.code === '803-E01');
  // 類別不符 → 錯誤
  const bad = await upload([['803-E01', '水', 'B1 冰水機房', '', '', '累計讀數', '子電表累計度數', '', '', '', '', '']]);
  assert.equal(bad.body.preview.counts.error, 1);
  assert.match(bad.body.preview.errors[0].message, /不可改/);
  // 只改名稱與位置、項目欄全空 → 保留原項目
  const r = await upload([['803-E01', '', 'B1 冰水機房（新）', '醫療大樓 B1-2', '', '', '', '', '', '', '', '']], { apply: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.preview.counts.update, 1);
  let p = (await store.readInventory('803')).points.find((x) => x.code === '803-E01');
  assert.equal(p.name, 'B1 冰水機房（新）');
  assert.deepEqual(p.items, before.items);
  // 項目 id 空白：同標籤同類型沿用原 id；新的另配
  const r2 = await upload([
    ['803-E01', '電', '', '', '', '累計讀數', '子電表累計度數', 'kWh', '', '50', '', 'M-001'],
    ['803-E01', '電', '', '', '', '一般數值', '出水溫度', '°C', '', '', '', ''],
  ], { apply: 1 });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  p = (await store.readInventory('803')).points.find((x) => x.code === '803-E01');
  assert.equal(p.code, '803-E01');
  assert.equal(p.domain, 'power');
  assert.deepEqual(p.items.map((i) => i.id), ['kwh', 'number1']);
  assert.equal(p.items[0].warnPct, 50);
  assert.ok(r2.body.preview.points[0].changes.some((x) => /移除項目：1 號冰水機狀態/.test(x)));
  // 一模一樣再匯 → 不變、不寫
  const n0 = commits();
  const r3 = await upload([
    ['803-E01', '電', '', '', 'kwh', '累計讀數', '子電表累計度數', 'kWh', '', '50', '', 'M-001'],
    ['803-E01', '電', '', '', 'number1', '一般數值', '出水溫度', '°C', '', '', '', ''],
  ], { apply: 1 });
  assert.equal(r3.body.preview.counts.unchanged, 1);
  assert.equal(r3.body.applied, false);
  assert.equal(commits(), n0);
});

test('更新時沿用範本管不到的項目屬性（冰水機群組等）', async () => {
  const cur = (await store.readInventory('803')).points.find((x) => x.code === '803-E01');
  const items = cur.items.map((i) => (i.id === 'kwh' ? { ...i, chillerGroup: 'G1', chillerRole: 'kwh' } : i));
  assert.equal((await call('PUT', '/api/inv/points/803-E01', { point: { items } })).status, 200);
  const r = await upload([['803-E01', '電', '', '', 'kwh', '累計讀數', '子電表累計度數（改名）', 'kWh', '', '50', '', 'M-001']], { apply: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const it = (await store.readInventory('803')).points.find((x) => x.code === '803-E01').items[0];
  assert.equal(it.label, '子電表累計度數（改名）');
  assert.deepEqual([it.chillerGroup, it.chillerRole], ['G1', 'kwh']);
});

test('對應錯誤：設備編號、電號對不上列為錯誤，apply 回 422 且整批不寫', async () => {
  const rows = [
    ['', '電', '新點位 A', '', '', '累計讀數', '度數', 'kWh', '', '', '', ''],
    ['', '電', '新點位 B', '', '', '設備狀態', '冷卻水塔', '', '', '', 'CT-99', ''],
    ['', '電', '新點位 C', '', '', '電費單', '電費單', '', '', '', '', '999-999'],
    ['', '電', '新點位 D', '', '', '亂填', '某項', '', '', '', '', ''],
    ['999-E01', '電', '別家', '', '', '文字', '備註', '', '', '', '', ''],
  ];
  const n0 = commits();
  const pts0 = (await store.readInventory('803')).points.length;
  const r = await upload(rows);
  const P = r.body.preview;
  assert.equal(P.ok, false);
  assert.equal(P.counts.add, 1);
  assert.equal(P.counts.error, 4);
  const msg = (row) => P.errors.filter((e) => e.row === row).map((e) => e.message).join('；');
  assert.match(msg(3), /CT-99.*找不到/);
  assert.match(msg(4), /999-999.*找不到/);
  assert.match(msg(5), /看不懂/);
  assert.match(msg(6), /不屬於本院所/);
  const a = await upload(rows, { apply: true });
  assert.equal(a.status, 422);
  assert.equal(a.body.error, 'import_errors');
  assert.equal(commits(), n0);
  assert.equal((await store.readInventory('803')).points.length, pts0);
});

test('JSON 也能匯入（鍵用中文欄名或英文 key）', async () => {
  const r = await call('POST', '/api/inv/points/import', { rows: [{ 類別: '水', 名稱: '頂樓水塔', type: 'status', label: '水塔液位' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.preview.counts.add, 1);
  assert.equal(r.body.preview.points[0].domain, 'water');
});

test('CLI：預設只預覽不寫檔，--apply 才寫入並記 reporter', async () => {
  const csv = join(TMP, '業主清單.csv');
  writeFileSync(csv, '﻿' + [HEAD.join(','), ',電,"CLI 點位, 一",地下室,,累計讀數,度數,kWh,,,,'].join('\r\n'));
  const env = { ...process.env };
  const n0 = commits();
  const dry = spawnSync(process.execPath, ['scripts/import-points.mjs', '803', csv], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /預覽，不寫檔/);
  assert.match(dry.stdout, /＋新增 803-E02（自動配號） 電 CLI 點位, 一/);
  assert.equal(commits(), n0, 'dry-run 不寫檔');
  const ap = spawnSync(process.execPath, ['scripts/import-points.mjs', '803', csv, '--apply', '--reporter', '維護者甲'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(ap.status, 0, ap.stderr + ap.stdout);
  assert.match(ap.stdout, /已寫入/);
  const inv = await store.readInventory('803');
  assert.ok(inv.points.some((p) => p.code === '803-E02' && p.name === 'CLI 點位, 一'));
  const c = inv.changes.filter((x) => x.kind === 'point.import').at(-1);
  assert.equal(c.who, '維護者甲（維護者）');
  assert.equal(c.links.source, '業主清單.csv');
  // 有錯誤 → exit 1
  writeFileSync(csv, [HEAD.join(','), ',火,X,,,文字,a,,,,,'].join('\n'));
  const bad = spawnSync(process.execPath, ['scripts/import-points.mjs', '803', csv, '--apply'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /整批未寫入/);
});
