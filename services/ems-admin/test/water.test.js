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
  assert.deepEqual(b.sheets.map((s) => s.name), ['目的與範疇', '取水', '主要用水單元', '排放與回收', '水平衡', '間接用水', '水質', '績效指標與基線', '衝擊評估', '資料品質', '節水改善回報', '待補欄位']);
  for (const s of b.sheets.slice(0, -1)) assert.match(String(s.rows[1][0].v), /^依據：(ISO|放流水標準)/, `${s.name} 第 2 列要寫依據`);
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

// ════════════════════════ 第 26 項：水足跡延伸 ════════════════════════
const { billMonths, monthlyKwh } = await import('../src/report-model.js');
const { unzip } = await import('../src/xlsx.js');
const { buildWaterVerification } = await import('../src/report-water-verify.js');
const bill = (period, use) => ({ values: { period, meterNo: '01-0000-00-001', usePeak: use, useHalfPeak: 0, useOffPeak: 0 }, meta: {} });
function seed26() {
  const inv = seed();
  inv.site.meters = [{ id: 'met-1', meterNo: '01-0000-00-001', contractKw: 1000 }];
  inv.points.push({ code: '901-E01', domain: 'power', name: '台電總表', active: true, items: [{ id: 'bill', label: '電費單', type: 'bill', meterId: 'met-1' }] });
  for (let m = 1; m <= 12; m++) inv.records.push({ id: `rb-${m}`, pointCode: '901-E01', period: mm(2025, m), at: `${mm(2025, m)}-20T02:00:00.000Z`, who: '測試水院', values: { bill: bill(mm(2025, m), 100000) }, usage: {}, photos: [], anomalies: [] });
  // 同月重送：取最後送出的那筆
  inv.records.push({ id: 'rb-1b', pointCode: '901-E01', period: mm(2025, 1), at: `${mm(2025, 1)}-28T02:00:00.000Z`, who: '測試水院', values: { bill: bill(mm(2025, 1), 120000) }, usage: {}, photos: [], anomalies: [] });
  inv.annual = { 114: { waterMonthly: Array.from({ length: 12 }, (_, i) => ({ id: `wm-${i}`, month: i + 1, bedDays: 13000 + i * 100, outpatientVisits: 20000, erVisits: 3000 })) } };
  return inv;
}

test('第 26-3 項：每月營運活動（住院人日、門急診人次）優先於年值，績效指標用同月取水 ÷ 同月分母', () => {
  const inv = seed26();
  const act = C.waterActivityOf(inv, 2025);
  assert.equal(act.from.bedDays, 'monthly');
  assert.equal(act.monthsFilled, 12);
  const bedSum = Array.from({ length: 12 }, (_, i) => 13000 + i * 100).reduce((a, b) => a + b, 0);
  assert.equal(act.bedDays, bedSum, '月合計取代年值 160000');
  const W = C.waterInventory(inv, { year: 2025 });
  const bed = W.performance.find((p) => p.id === 'bedDay');
  assert.equal(bed.value, C.round(25200 * 1000 / bedSum, 3));
  assert.equal(bed.months.length, 12);
  assert.equal(bed.months[0].value, C.round(2100 * 1000 / 13000, 3), '1 月：自來水 2,000＋雨水 100 m³');
  // 只填 5 個月 → 只拿這 5 個月相除，不高估；完整度提示
  inv.annual[114].waterMonthly = inv.annual[114].waterMonthly.slice(0, 5);
  inv.site.waterActivity = inv.site.waterActivity.filter((a) => a.year !== 2025);
  const W2 = C.waterInventory(inv, { year: 2025 });
  const b2 = W2.performance.find((p) => p.id === 'bedDay');
  assert.equal(b2.monthsUsed, 5);
  assert.equal(b2.value, C.round(2100 * 5 * 1000 / [0, 1, 2, 3, 4].reduce((a, i) => a + 13000 + i * 100, 0), 3));
  assert.equal(W2.completeness.checks.find((c) => c.key === 'activity').ok, false);
});

test('第 26-4 項：節水目標達成度（總取水量與各指標；依直線進度判斷落後）', () => {
  const inv = seed();
  inv.site.waterScope.targetYear = 2027;
  const W = C.waterFootprint(inv, { year: 2025 });
  const total = W.targets.rows.find((t) => t.id === 'total');
  assert.equal(total.baseline, 26400);
  assert.equal(total.reductionPct, C.round((26400 - 25200) / 26400 * 100, 1));   // 4.5%
  assert.equal(total.progressPct, Math.round(4.5 / 5 * 100));
  assert.equal(total.met, false);
  assert.equal(W.targets.expectedPct, 1.7, '2024→2027 降 5%，2025 年應降 1/3');
  assert.equal(total.level, 'ok', '超前進度');
  assert.equal(W.targets.rows.find((t) => t.id === 'bedDay').met, true);
  // 只看指定的指標
  inv.site.waterScope.targetIndicator = '每床日';
  assert.deepEqual(C.waterFootprint(inv, { year: 2025 }).targets.rows.map((t) => t.id), ['bedDay']);
  delete inv.site.waterScope.targetPct;
  assert.equal(C.waterFootprint(inv, { year: 2025 }).targets.rows[0].level, 'na');
});

test('第 26-2 項：間接用水＝電費單用電量 × 發電用水係數；與附表三同一套取帳單規則；邊界切換決定是否計入', () => {
  const inv = seed26();
  const e = C.waterElectricityKwh(inv, { year: 2025 });
  assert.equal(e.method, 'bill');
  assert.equal(e.total, 120000 + 11 * 100000, '1 月重送取最後一筆');
  const kwh = monthlyKwh(billMonths(inv));
  assert.equal(e.total, Object.entries(kwh).filter(([k]) => k.startsWith('2025-')).reduce((a, [, v]) => a + v, 0), '與附表三表五之二同一份帳單');
  let I = C.waterIndirect(inv, { year: 2025 });
  assert.equal(I.included, false);
  assert.equal(I.electricity.consumption, C.round(e.total * C.WATER_ELEC.consumption / 1000, 3));
  assert.ok(I.electricity.source.url.includes('taipower'));
  inv.site.waterScope.boundary = '院區直接用水＋間接用水（另行估算）';
  I = C.waterIndirect(inv, { year: 2025 });
  assert.equal(I.included, true);
  assert.equal(I.consumption, I.electricity.consumption);
  // 自訂係數
  inv.site.waterScope.elecWaterFactor = 1.5;
  assert.equal(C.waterIndirect(inv, { year: 2025 }).electricity.consumption, C.round(e.total * 1.5 / 1000, 3));
  // 其他上游只列不量化
  inv.site.waterUpstream = [{ id: 'up1', category: '外購蒸汽', name: '蒸汽', annualQty: 100, unit: '公噸' }];
  assert.equal(C.waterIndirect(inv, { year: 2025 }).upstream[0].quantified, false);
  // schema：其他上游區塊與自訂係數欄位
  assert.ok(S.validateSiteBlock('waterUpstream', [{ category: '藥品耗材', name: '藥品' }], () => 'u1').ok);
  assert.ok(S.validateSiteBlock('waterScope', { elecWaterFactor: 0.5, awareRegion: C.WATER_AWARE.regions[0].id }, () => 'x').ok);
});

test('第 26-1 項：缺水足跡（AWARE）＝消耗量 × CF；逐月或年平均；間接用水納入邊界時加總', () => {
  const inv = seed26();
  const A = C.WATER_AWARE;
  assert.ok(A.version && A.url && A.regions.length, 'AWARE 版本與來源要寫在常數');
  for (const r of A.regions) {
    assert.ok(r.annual.nonAgri >= 0.1 && r.annual.nonAgri <= 100, `${r.id} CF 須在 0.1～100`);
    if (r.monthly?.nonAgri) assert.equal(r.monthly.nonAgri.length, 12);
  }
  const W = C.waterFootprint(inv, { year: 2025 });
  const S1 = W.scarcity;
  assert.equal(S1.unit, 'm³ world-eq');
  const region = A.regions[0];
  if (region.monthly?.nonAgri) {
    assert.equal(S1.method, 'monthly');
    // 每月取水 2,100、排放 1,500 → 消耗 600
    assert.equal(S1.direct.value, C.round(region.monthly.nonAgri.reduce((a, cf) => a + C.round(600 * cf, 3), 0), 3));
  } else assert.equal(S1.direct.value, C.round(7200 * region.annual.nonAgri, 3));
  assert.equal(S1.total, S1.direct.value, '邊界只含直接用水：間接不計入');
  assert.ok(S1.source.ref.includes('5.4'));
  inv.site.waterScope.boundary = '院區直接用水＋間接用水（另行估算）';
  const S2 = C.waterFootprint(inv, { year: 2025 }).scarcity;
  assert.equal(S2.total, C.round(S2.direct.value + S2.indirect.value, 3));
  // 沒有排放量 → 消耗量用估算 → 年平均 CF
  inv.points = inv.points.filter((p) => p.code !== '901-W04');
  const S3 = C.waterFootprint(inv, { year: 2025 }).scarcity;
  assert.equal(S3.method, 'annual');
  assert.equal(S3.level, 'warn');
  // 選用途別「不分用途」
  inv.site.waterScope.awareUse = '不分用途（unspecified）';
  assert.equal(C.waterFootprint(inv, { year: 2025 }).scarcity.cfAnnual, region.annual.unknown);
});

test('第 26-5 項：水質預設項目組（放流水標準 醫院）＋依許可覆寫；超標列出；貼紙送出時提示', async () => {
  const inv = seed();
  inv.site.waterDischarges = [{ id: 'wd-1', destination: '自設污水處理設施後放流', name: '放流口' }];
  inv.points = inv.points.filter((p) => p.code !== '901-W05');
  inv.points.push({ code: '901-W05', domain: 'water', name: '水質', active: true, items: WS.WATER_POINT_TEMPLATES.find((t) => t.id === 'quality').items.map((it) => (it.waterFlow ? { ...it, waterDischargeId: 'wd-1' } : it)) });
  inv.records = inv.records.filter((r) => r.pointCode !== '901-W05');
  inv.records.push({ id: 'rq1', pointCode: '901-W05', period: '2025-03', at: '2025-03-10T02:00:00Z', who: '王（測試水院）', values: { ph: 7, cod: 120, temp: 36, nh3n: 80 }, usage: {} });
  inv.records.push({ id: 'rq2', pointCode: '901-W05', period: '2025-07', at: '2025-07-10T02:00:00Z', who: '王（測試水院）', values: { ph: 9.5, cod: 60, temp: 36 }, usage: {} });
  const rules = C.waterQualityRules(inv);
  assert.deepEqual(rules.map((r) => r.param), C.WATER_EFFLUENT.items.map((x) => x.param));
  assert.equal(rules.find((r) => r.param === 'COD').max, 100);
  assert.equal(rules[0].frequency, '每半年');
  const Q = C.waterQualityAssess(inv, { year: 2025 });
  const ex = Q.exceedances.map((x) => `${x.period}:${x.param}`).sort();
  // 3 月 COD 120 > 100、水溫 36 > 35（10～4 月）；7 月 pH 9.5 超出 6～9；氨氮 2025 年尚未生效、7 月水溫 36 ≤ 38 不算
  assert.deepEqual(ex, ['2025-03:COD', '2025-03:水溫', '2025-07:pH']);
  assert.equal(Q.level, 'error');
  assert.equal(Q.rules.find((r) => r.param === 'BOD').shortfall, 2, '每半年應測 2 次，BOD 一次都沒測');
  assert.match(C.waterQualityLimitText(rules.find((r) => r.param === '氨氮')), /116-01 起 ≤ 75/);
  assert.equal(C.waterQualityCheck(rules.find((r) => r.param === '氨氮'), 80, '2027-02').exceeded, true);
  // 依許可覆寫：這個排放口只測 COD（上限 80）、每季
  inv.site.waterQualityPlan = [{ id: 'qp1', dischargeId: 'wd-1', param: 'COD', limitMax: 80, frequency: '每季', basis: '許可證 府環水許字第 1 號' }];
  const R2 = C.waterQualityRules(inv);
  assert.equal(R2.length, 1);
  assert.equal(R2[0].perYear, 4);
  assert.equal(C.waterQualityAssess(inv, { year: 2025 }).exceedances.length, 1);
  // 納管排放口不套預設組
  inv.site.waterQualityPlan = [];
  inv.site.waterDischarges[0].destination = '公共污水下水道';
  assert.equal(C.waterQualityRules(inv).length, 0);
  // 報表：水質表有限值欄、超標列
  inv.site.waterDischarges[0].destination = '自設污水處理設施後放流';
  const b = buildWater(inv, { year: 114, today: '2026-10-22' });
  const sq = b.sheets.find((s) => s.name === '水質');
  const cells = sq.rows.flat().map((c) => c.v);
  assert.ok(cells.includes('≤ 100 mg/L') && cells.includes('6～9'));
  assert.ok(b.missing.some((m) => m.sheet === '水質' && /應測 2 次/.test(m.why)));

  // API：貼紙送出超標 → warnings（不擋）
  const H = '902';
  await store.saveInventory(H, (() => { const x = S.blankInventory(); x.site.waterDischarges = [{ id: 'wd-1', destination: '自設污水處理設施後放流', name: '放流口' }]; x.points = [{ code: '902-W01', domain: 'water', name: '水質', active: true, items: [{ id: 'cod', label: 'COD', type: 'number', unit: 'mg/L', waterFlow: 'quality', waterParam: 'COD', waterDischargeId: 'wd-1' }] }]; return x; })(), { what: '測試' });
  const r = await call('POST', '/api/inv/point/902-W01/record', { period: '2025-05', values: { cod: 150 } }, { hid: H });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.warnings.some((w) => /COD.*超出限值 ≤ 100/.test(w)), JSON.stringify(r.body.warnings));
  const ok = await call('POST', '/api/inv/point/902-W01/record', { period: '2025-06', values: { cod: 50 } }, { hid: H });
  assert.ok(!ok.body.warnings.some((w) => /超出限值/.test(w)));
});

test('第 26-3 項 API：每月營運活動走年度報表資料（PUT annual/waterMonthly），水足跡報表用實填值', async () => {
  const H = '903';
  await store.saveInventory(H, seed(), { what: '測試' });
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, bedDays: 14000, outpatientVisits: 21000 }));
  const r = await call('PUT', '/api/inv/report/annual/waterMonthly?year=114', { value: months, reporter: '李護理長' }, { hid: H });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const j = await call('GET', '/api/inv/report/water?year=114&format=json', undefined, { hid: H });
  assert.equal(j.body.summary.performance.find((p) => p.id === 'bedDay').value, C.round(25200 * 1000 / (14000 * 12), 3));
  const an = await call('GET', '/api/inv/report/annual?year=114', undefined, { hid: H });
  assert.ok(an.body.spec.blocks.some((b) => b.id === 'waterMonthly' && b.kind === 'months'));
  assert.equal(an.body.meta.waterMonthly.reporter, '李護理長');
});

test('第 26-6 項：查證資料包 zip（清冊、計算過程與係數、原始紀錄含填寫人、照片清單、異動紀錄、資料品質）', async () => {
  const H = '904';
  const inv = seed26();
  inv.records.find((r) => r.id === 'r-901-W01-2025-03').reporter = '陳技師';
  inv.records.find((r) => r.id === 'r-901-W01-2025-03').photos = [{ id: 'ph_abc', mime: 'image/jpeg', size: 1234 }];
  inv.points = inv.points.map((p) => ({ ...p, code: p.code.replace('901', H) }));
  inv.records = inv.records.map((r) => ({ ...r, pointCode: r.pointCode.replace('901', H) }));
  await store.saveInventory(H, inv, { what: '測試' });
  // 一筆水的異動
  const put = await call('PUT', '/api/inv/site/waterScope', { value: { ...inv.site.waterScope, targetPct: 8 }, reason: '院務會議調高目標', reporter: '陳技師' }, { hid: H });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const z = await call('GET', '/api/inv/report/water-verification?year=114', undefined, { hid: H });
  assert.equal(z.status, 200);
  assert.match(z.headers.get('content-type'), /zip/);
  const files = unzip(z.body);
  const names = [...files.keys()];
  for (const f of ['00_說明.txt', '02_計算過程與係數來源.csv', '03_原始紀錄_水類點位.csv', '03b_原始紀錄_用電.csv', '03c_每月營運活動.csv', '04_照片清單.csv', '05_異動紀錄.csv', '06_資料品質評估.csv', '07_範疇與建檔資料.json']) {
    assert.ok(names.some((n) => n.endsWith(`/${f}`)), `缺 ${f}；有：${names.join('、')}`);
  }
  assert.ok(names.some((n) => /\/01_水足跡盤查清冊_114年_.*\.xlsx$/.test(n)));
  const txt = (suffix) => files.get(names.find((n) => n.endsWith(suffix))).toString('utf8');
  assert.match(txt('03_原始紀錄_水類點位.csv'), /陳技師/);
  assert.match(txt('04_照片清單.csv'), /ph_abc/);
  assert.match(txt('05_異動紀錄.csv'), /院務會議調高目標/);
  const calc = txt('02_計算過程與係數來源.csv');
  assert.ok(calc.includes(C.WATER_AWARE.version) && calc.includes('taipower') && calc.includes('放流水標準'), '係數與版本');
  assert.match(txt('03b_原始紀錄_用電.csv'), /01-0000-00-001/);
  assert.match(txt('06_資料品質評估.csv'), /完整度/);
  const xl = readWorkbook(files.get(names.find((n) => n.endsWith('.xlsx'))));
  assert.ok(xl.sheets.get('衝擊評估'));
  assert.equal((await call('GET', '/api/inv/report/water-verification?year=x1', undefined, { hid: H })).status, 400);
  // 純函式：同一份計算
  const b = buildWaterVerification(inv, { year: 114, today: '2026-10-22' });
  assert.equal(b.counts.photos, 1);
});

test('第 26 項：spec 帶 AWARE、發電用水、放流水預設組；範本水質抽測＝醫院預設項目', async () => {
  const spec = (await call('GET', '/api/inv/spec')).body.spec.water;
  assert.ok(spec.aware.version && spec.aware.regions.length);
  assert.equal(spec.electricity.consumption, C.WATER_ELEC.consumption);
  assert.equal(spec.effluent.items.length, 8);
  const q = spec.pointTemplates.find((t) => t.id === 'quality');
  assert.deepEqual(q.items.filter((i) => i.waterFlow === 'quality').map((i) => i.waterParam), C.WATER_EFFLUENT.items.map((x) => x.param));
  assert.ok(S.siteBlockById('waterQualityPlan').source.doc === '放流水標準');
  assert.ok(S.validateSiteBlock('waterQualityPlan', [{ dischargeId: 'wd-1', param: 'COD', limitMax: 80, frequency: '每季' }], () => 'q1', seed()).ok);
});
