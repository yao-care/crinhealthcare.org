// 水足跡盤查（工作清單 23）：schema、點位範本、計算、xlsx 報表的回歸測試。
//
// 蓋住「壞掉會很難發現」的幾件事：
//   - 水的初始建檔區塊與點位範本都帶 ISO 條號 source；範本套上去本身就通過點位驗證
//   - 點位項目的水屬性只能用在水類點位、連結必須存在；舊點位（沒有水屬性）照常通過
//   - 取水依水源別、排放、回收、消耗（質量平衡／估算）、用水單元占比、每床日用水、基線比較、完整度
//   - 公升換算成 m³；沒標流向時推定取水並標 inferred
//   - /api/inv/report/water 產得出 xlsx、讀得回去；missing?kind=water 回同一份待補清單
//
// 資料一律寫到暫存目錄：config.js 會讀 .env（production 設定），環境變數先設好才 import。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const TMP = mkdtempSync(join(tmpdir(), 'ems-water-test-'));
process.env.AUDIT_DATA_DIR = join(TMP, 'data');
process.env.AUDIT_UPLOADS_DIR = join(TMP, 'uploads');
process.env.ACCOUNTS_FILE = join(TMP, 'accounts.json');
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123';
process.env.PUBLIC_BASE_URL = 'https://ems-admin.example.test';

const S = await import('../src/inventory-schema.js');
const WS = await import('../src/water-schema.js');
const store = await import('../src/inventory-store.js');
const { handleInventory } = await import('../src/inventory-routes.js');
const { buildWater, waterYear } = await import('../src/report-water.js');
const auth = await import('../src/auth.js');
const { originAllowed } = await import('../src/config.js');
const { readWorkbook } = await import('../src/xlsx.js');
await import('../public/inventory-compute.js');
const C = globalThis.EMSInventoryCompute;

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
    try {
      const h = await handleInventory({ req, res, sess, pathname, json, readBody, originOk });
      if (!h) json(res, 404, { ok: false });
    } catch (e) { json(res, 500, { ok: false, error: String(e.stack || e) }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); rmSync(TMP, { recursive: true, force: true }); });

const cookieFor = (hid) => `ems_admin_session=${auth.signToken({ sub: `hosp-${hid}`, hid, name: `測試院所${hid}` })}`;
async function call(method, path, body, { hid = '901' } = {}) {
  const headers = { cookie: cookieFor(hid) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

// ── 種子資料：2025 年（民國 114）、基線 2024 年（113）──
const mm = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function seed() {
  const inv = S.blankInventory();
  inv.site.basic = { userName: '測試水院', beds: 500, floorArea: 20000 };
  inv.site.buildings = [{ id: 'bld-1', name: '醫療大樓' }];
  inv.site.waterScope = { goal: '掌握取水用水排水', boundary: '院區直接用水（取水→院內用水→排放）', reportingUnits: ['每床日', '每平方公尺樓地板'], baselineYear: 2024, targetPct: 5 };
  inv.site.waterActivity = [
    { id: 'a24', year: 2024, bedDays: 150000 },
    { id: 'a25', year: 2025, bedDays: 160000, staffFte: 1200 },
  ];
  inv.site.waterSources = [
    { id: 'ws-tap', sourceType: '自來水', name: '自來水 主水號', accountNo: 'A-1' },
    { id: 'ws-rain', sourceType: '雨水回收', name: '雨水回收槽' },
  ];
  inv.site.waterUnits = [
    { id: 'wu-ct', kind: '冷卻水塔', name: 'RF 冷卻水塔', building: 'bld-1', useForm: '蒸發', consumptionPct: 80, significant: true },
    { id: 'wu-ld', kind: '洗衣房', name: '洗衣房', significant: true, estimatedShare: 10, consumptionPct: 10 },
  ];
  inv.site.waterDischarges = [{ id: 'wd-1', destination: '公共污水下水道', name: '污水納管口', qualityParams: ['pH', 'COD'] }];
  inv.points = [
    { code: '901-W01', domain: 'water', name: '自來水總表', location: '', active: true, items: [{ id: 'intake', label: '總表讀數', type: 'reading', unit: 'm³', waterFlow: 'intake', waterSourceId: 'ws-tap' }, { id: 'status', label: '水表狀態', type: 'status' }] },
    { code: '901-W02', domain: 'water', name: '雨水回收', location: '', active: true, items: [{ id: 'intake', label: '雨水讀數', type: 'reading', unit: 'L', waterFlow: 'intake', waterSourceId: 'ws-rain' }] },
    { code: '901-W03', domain: 'water', name: '冷卻水塔補水', location: '', active: true, items: [{ id: 'makeup', label: '補水', type: 'reading', unit: '度', waterFlow: 'use', waterUnitId: 'wu-ct' }] },
    { code: '901-W04', domain: 'water', name: '污水排放', location: '', active: true, items: [{ id: 'discharge', label: '放流量', type: 'reading', unit: 'm³', waterFlow: 'discharge', waterDischargeId: 'wd-1' }] },
    { code: '901-W05', domain: 'water', name: '水質', location: '', active: true, items: [{ id: 'ph', label: 'pH', type: 'number', waterFlow: 'quality', waterParam: 'pH', waterDischargeId: 'wd-1' }] },
    { code: '901-W06', domain: 'water', name: '節水改善', location: '', active: true, items: [{ id: 'action', label: '改善內容', type: 'text' }, { id: 'saving', label: '預估年節水量', type: 'number', unit: 'm³/年', waterFlow: 'saving', waterUnitId: 'wu-ct' }] },
  ];
  const recs = [];
  const rec = (code, period, values, usage) => recs.push({ id: `r-${code}-${period}`, pointCode: code, period, at: `${period}-15T02:00:00.000Z`, who: '測試水院', values, usage: usage || {}, note: '', photos: [], anomalies: [] });
  for (let m = 1; m <= 12; m++) {
    rec('901-W01', mm(2025, m), { intake: 10000 + m * 2000 }, { intake: 2000 });      // 每月 2,000 → 24,000
    rec('901-W02', mm(2025, m), { intake: 1e6 + m * 100000 }, { intake: 100000 });    // 每月 100,000 L ＝ 100 m³ → 1,200
    rec('901-W03', mm(2025, m), { makeup: 500 * m }, { makeup: 500 });                // 每月 500 → 6,000
    rec('901-W04', mm(2025, m), { discharge: 1500 * m }, { discharge: 1500 });        // 每月 1,500 → 18,000
    rec('901-W01', mm(2024, m), { intake: m * 2200 }, { intake: 2200 });              // 基線 26,400
  }
  rec('901-W05', mm(2025, 3), { ph: 7.2 });
  rec('901-W05', mm(2025, 9), { ph: 6.8 });
  rec('901-W06', mm(2025, 6), { action: '冷卻水塔加裝導電度控制排放', saving: 800 });
  inv.records = recs;
  return inv;
}

// ════════════════════════ schema ════════════════════════
test('schema：水的初始建檔區塊都帶 ISO 條號 source，報告單位與計算庫指標一致', () => {
  const ids = ['waterScope', 'waterActivity', 'waterSources', 'waterUnits', 'waterDischarges'];
  for (const id of ids) {
    const b = S.siteBlockById(id);
    assert.ok(b, `缺區塊 ${id}`);
    assert.match(b.source.doc, /^ISO (14046|46001)/, `${id} source 要標 ISO`);
    assert.ok(b.source.ref, `${id} 缺條號`);
    assert.equal(b.navGroup, WS.WATER_NAV_GROUP);
  }
  assert.ok(S.inventorySpec.water.pointTemplates.length >= 8);
  assert.deepEqual(WS.REPORTING_UNITS.map((u) => u.label), C.WATER_INDICATORS.map((x) => x.label), '報告單位標籤要與計算庫一致');
  // 單位換算
  assert.equal(C.waterUnitFactor('度'), 1);
  assert.equal(C.waterUnitFactor('L'), 0.001);
  assert.equal(C.waterUnitFactor('kg/cm²'), undefined);
  // 民國／西元資料年
  assert.equal(waterYear('114'), 2025);
  assert.equal(waterYear('2025'), 2025);
  assert.equal(waterYear('ab'), null);
});

test('schema：每個用水點位範本套上去本身就通過點位驗證、都帶 source', () => {
  for (const t of WS.WATER_POINT_TEMPLATES) {
    assert.ok(t.source?.doc, `範本 ${t.id} 缺 source`);
    const v = S.validatePoint({ code: '901-W09', domain: 'water', name: t.name, items: t.items }, S.blankInventory());
    assert.ok(v.ok, `範本 ${t.id}：${(v.errors || []).join('；')}`);
  }
});

test('schema：水屬性只限水類點位、連結必須存在；舊點位不受影響', () => {
  const inv = seed();
  const power = S.validatePoint({ code: '901-E01', domain: 'power', name: '電表', items: [{ id: 'r', label: '讀數', type: 'reading', waterFlow: 'intake' }] }, inv);
  assert.equal(power.ok, false);
  assert.ok(power.errors.some((e) => e.includes('只能用在水類點位')));
  const badLink = S.validatePoint({ code: '901-W09', domain: 'water', name: 'x', items: [{ id: 'r', label: '讀數', type: 'reading', waterFlow: 'intake', waterSourceId: 'nope' }] }, inv);
  assert.ok(badLink.errors.some((e) => e.includes('水源不存在')));
  const wrongType = S.validatePoint({ code: '901-W09', domain: 'water', name: 'x', items: [{ id: 's', label: '狀態', type: 'status', waterFlow: 'intake' }] }, inv);
  assert.equal(wrongType.ok, false);
  const wrongFlow = S.validatePoint({ code: '901-W09', domain: 'water', name: 'x', items: [{ id: 'r', label: '讀數', type: 'reading', waterFlow: 'discharge', waterSourceId: 'ws-tap' }] }, inv);
  assert.ok(wrongFlow.errors.some((e) => e.includes('只有「取水」')));
  const bogus = S.validatePoint({ code: '901-W09', domain: 'water', name: 'x', items: [{ id: 'r', label: '讀數', type: 'reading', waterFlow: 'evaporate' }] }, inv);
  assert.equal(bogus.ok, false);
  // 舊的水類點位（水表讀數＋狀態，沒有水屬性）照常通過
  const old = S.validatePoint({ code: '901-W09', domain: 'water', name: '舊水表', items: [{ id: 'reading1', label: '水表讀數', type: 'reading', unit: '度' }, { id: 'status1', label: '設備狀態', type: 'status' }] }, inv);
  assert.ok(old.ok, (old.errors || []).join('；'));
  // site 區塊驗證：用水單元的建築用 ref 對回 id
  const u = S.validateSiteBlock('waterUnits', [{ kind: '洗衣房', name: '洗衣房', building: '醫療大樓' }], () => 'wu-x', inv);
  assert.ok(u.ok);
  assert.equal(u.value[0].building, 'bld-1');
  assert.equal(S.validateSiteBlock('waterSources', [{ sourceType: '海水淡化', name: 'x' }], () => 'x').ok, false);
});

// ════════════════════════ 計算 ════════════════════════
test('計算：取水依水源別、公升換算、排放、消耗（質量平衡）、用水單元占比與未分表量', () => {
  const F = C.waterFlows(seed(), { year: 2025 });
  assert.equal(F.intake.total, 25200);                 // 24,000 自來水 ＋ 1,200 雨水
  const tap = F.intake.bySource.find((b) => b.id === 'ws-tap');
  const rain = F.intake.bySource.find((b) => b.id === 'ws-rain');
  assert.equal(tap.total, 24000);
  assert.equal(rain.total, 1200);                      // 100,000 L/月 → 100 m³
  assert.equal(rain.months[0], 100);
  assert.equal(F.intake.replace, 1200);                // 雨水＝替代水源（46001 replace）
  assert.equal(F.intake.inferred, false);
  assert.equal(F.discharge.total, 18000);
  assert.equal(F.consumption.method, 'balance');
  assert.equal(F.consumption.value, 7200);
  assert.ok(F.consumption.source.ref.includes('3.2.1'));
  const ct = F.units.find((u) => u.id === 'wu-ct');
  assert.equal(ct.use, 6000);
  assert.equal(ct.metered, true);
  assert.equal(ct.share, C.round(6000 / 25200 * 100, 1));
  assert.equal(ct.consumption, 4800);
  const ld = F.units.find((u) => u.id === 'wu-ld');
  assert.equal(ld.estimated, true);                    // 沒分表 → 估計占比 10%
  assert.equal(ld.use, 2520);
  assert.equal(F.unmetered, 19200);                    // 25,200 − 6,000（只扣有分表的）
  const ph = F.quality.find((q) => q.param === 'pH');
  assert.deepEqual([ph.n, ph.min, ph.max, ph.avg, ph.last], [2, 6.8, 7.2, 7, 6.8]);
  assert.equal(F.savings.length, 1);
  assert.equal(F.savingTotal, 800);
  assert.equal(F.savings[0].unitName, 'RF 冷卻水塔');
});

test('計算：沒有排放量時用消耗比例估算；整院沒標流向時推定取水', () => {
  const inv = seed();
  inv.points = inv.points.filter((p) => p.code !== '901-W04');
  const F = C.waterFlows(inv, { year: 2025 });
  assert.equal(F.consumption.method, 'units');
  assert.equal(F.consumption.value, C.round(6000 * 0.8 + 2520 * 0.1, 3));
  // 舊資料：水表讀數沒有 waterFlow
  const old = seed();
  old.points = [{ code: '901-W01', domain: 'water', name: '水表', active: true, items: [{ id: 'intake', label: '水表讀數', type: 'reading', unit: '度' }] }];
  const G = C.waterFlows(old, { year: 2025 });
  assert.equal(G.intake.inferred, true);
  assert.equal(G.intake.total, 24000);
  assert.equal(G.untagged.length, 1);
});

test('計算：每床日用水、與基線比較、資料完整度，每個結果都帶 source', () => {
  const W = C.waterInventory(seed(), { year: 2025 });
  assert.deepEqual(W.performance.map((p) => p.id), ['bedDay', 'area']);   // 只算範疇勾的報告單位
  const bed = W.performance.find((p) => p.id === 'bedDay');
  assert.equal(bed.value, C.round(25200 * 1000 / 160000, 3));             // 157.5 L/床日
  assert.ok(bed.source.doc.startsWith('ISO 46001'));
  const area = W.performance.find((p) => p.id === 'area');
  assert.equal(area.value, C.round(25200 / 20000, 3));                    // 樓地板取表三第 18 欄
  assert.equal(W.baseline.year, 2024);
  const cmp = W.baseline.compare.find((c) => c.id === 'bedDay');
  assert.equal(cmp.baseline, C.round(26400 * 1000 / 150000, 3));          // 176 L/床日
  assert.equal(cmp.diffPct, C.round((157.5 - 176) / 176 * 100, 1));       // −10.5%
  assert.equal(cmp.met, true);                                            // 目標降低 5%
  assert.ok(cmp.source.ref.includes('6.2.7'));
  assert.ok(W.completeness.pct > 0 && W.completeness.pct <= 100);
  const q = W.completeness.checks.find((c) => c.key === 'quality');
  assert.equal(q.ok, false);                                              // COD 沒抽測
  assert.ok(q.msg.includes('COD'));
  for (const c of W.completeness.checks) assert.ok(c.source?.doc);
  // 缺分母 → na，不當成錯
  const none = C.waterPerformance({ intake: 100, activity: null, ids: ['bedDay'] });
  assert.equal(none[0].level, 'na');
});

// ════════════════════════ 報表與 API ════════════════════════
test('報表：buildWater 依 ISO 14046 結構產出工作表與待補清單', () => {
  const b = buildWater(seed(), { year: 114, today: '2026-10-22' });
  assert.deepEqual(b.sheets.map((s) => s.name), ['目的與範疇', '取水', '主要用水單元', '排放與回收', '水平衡', '水質', '績效指標與基線', '資料品質', '節水改善回報', '待補欄位']);
  for (const s of b.sheets.slice(0, -1)) assert.match(String(s.rows[1][0].v), /^依據：ISO/, `${s.name} 第 2 列要寫依據`);
  assert.ok(b.missing.some((m) => m.sheet === '水質' && m.field.includes('COD')));
  assert.equal(b.summary.intake, 25200);
  assert.match(b.filename, /^水足跡盤查清冊_114年_/);
});

test('API：套用範本新增水類點位、送紀錄、下載水足跡盤查 xlsx 與待補清單', async () => {
  // 初始建檔：水源
  let r = await call('PUT', '/api/inv/site/waterSources', { value: [{ id: 'ws-tap', sourceType: '自來水', name: '自來水 主水號' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', '/api/inv/site/waterScope', { value: { goal: '測試', boundary: '院區直接用水（取水→院內用水→排放）', reportingUnits: ['每床日'], baselineYear: '113' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const spec = await call('GET', '/api/inv/spec');
  const tpl = spec.body.spec.water.pointTemplates.find((t) => t.id === 'main-meter');
  const items = tpl.items.map((it) => (it.waterFlow === 'intake' ? { ...it, waterSourceId: 'ws-tap' } : it));
  r = await call('POST', '/api/inv/points', { point: { domain: 'water', name: tpl.name, items } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = r.body.point.code;
  assert.equal(code, '901-W01');
  // 貼紙頁依據改成 ISO
  const pf = await call('GET', `/api/inv/point/${code}`);
  assert.match(pf.body.source.text, /ISO 14046/);
  // 兩期紀錄 → 第二期有用量
  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2025-01', values: { intake: 1000, status: '正常' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', `/api/inv/point/${code}/record`, { period: '2025-02', values: { intake: 3500, status: '正常' } });
  assert.equal(r.body.usage.intake, 2500);
  // 水屬性用在電類點位 → 422
  r = await call('POST', '/api/inv/points', { point: { domain: 'power', name: '電表', items: [{ id: 'r', label: '讀數', type: 'reading', waterFlow: 'intake' }] } });
  assert.equal(r.status, 422);

  const x = await call('GET', '/api/inv/report/water?year=114');
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  const wb = readWorkbook(x.body);
  const intake = wb.sheets.get('取水');
  assert.ok(intake, `缺取水工作表；有：${[...wb.sheets.keys()].join('、')}`);
  assert.equal(intake.cells.get('A1'), '水足跡盤查清冊·取水（依水源別）');
  assert.ok([...intake.cells.values()].some((v) => Number(v) === 2500), `2 月用量 2,500 m³ 要出現在取水表：${JSON.stringify([...intake.cells])}`);
  const j = await call('GET', '/api/inv/report/water?year=2025&format=json');
  assert.equal(j.body.summary.intake, 2500);
  const miss = await call('GET', '/api/inv/report/missing?kind=water&year=114');
  assert.equal(miss.status, 200);
  assert.ok(miss.body.missing.some((m) => m.field.includes('營運活動資料')));
  assert.equal((await call('GET', '/api/inv/report/water?year=abc')).status, 400);
});
