// 匯出（工作清單 24）的回歸測試：單表匯出、整包 zip、申報對照頁、年度報表資料、跨年度沿用、節能計畫匯出檔、欄位對照。
//
// 蓋住「壞掉會很難發現」的幾件事：
//   - 單表／CSV／申報對照頁跟整本 xlsx 同一份工作表（數字不會兩套）
//   - 年度輸入（燃料、再生能源、可扣除用電量…）真的流進對應的表，推得出的欄位（熱能 EUI、自發自用、效益期間）有算
//   - 年度沿用：確認後記人、存快照；確認後又改 → 回到需重新確認；N-1 年面積取快照
//   - docs/annex3-field-map.md 與 src/annex3-fields.js 一致、每一欄都有來源
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const TMP = mkdtempSync(join(tmpdir(), 'ems-export-test-'));
process.env.AUDIT_DATA_DIR = join(TMP, 'data');
process.env.AUDIT_UPLOADS_DIR = join(TMP, 'uploads');
process.env.ACCOUNTS_FILE = join(TMP, 'accounts.json');
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123';
process.env.PUBLIC_BASE_URL = 'https://ems-admin.example.test';

const S = await import('../src/inventory-schema.js');
const store = await import('../src/inventory-store.js');
const { handleInventory } = await import('../src/inventory-routes.js');
const auth = await import('../src/auth.js');
const { originAllowed } = await import('../src/config.js');
const { readWorkbook, unzip } = await import('../src/xlsx.js');
const X = await import('../src/report-xlsx.js');
const EX = await import('../src/report-export.js');
const AN = await import('../src/report-annual.js');
const FM = await import('../src/annex3-fields.js');

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
  await store.saveInventory('803', seed(), { what: '測試種子' });
});
after(() => { server?.close(); rmSync(TMP, { recursive: true, force: true }); });

const cookieFor = (hid) => `ems_admin_session=${auth.signToken({ sub: `hosp-${hid}`, hid, name: `測試院所${hid}` })}`;
async function call(method, path, body, { hid = '803' } = {}) {
  const headers = { cookie: cookieFor(hid) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
const rowOf = (cells, label, col = 'A') => [...cells].find(([ref, v]) => ref.startsWith(col) && /^[A-Z]\d+$/.test(ref) && v === label)?.[0].slice(1);

// ── 種子：資料年 N＝115（2026），電費單 1、2 月；N-1＝114 有燃料帳單 ──
const bill = (period, o) => ({ values: { period, meterNo: '01-2345-67-890', tariffType: '高壓三段式', contractCapacity: 1500, powerFactor: 98, ...o }, meta: {} });
function seed() {
  const inv = S.blankInventory();
  inv.site.basic = { userName: '測試總醫院', userNo: 'U-001', userCategory: '醫院', industry: '8610 醫院', siteAddress: '臺北市內湖區成功路二段 325 號', beds: 500, floorArea: 12000, parkingArea: 2000 };
  inv.site.meters = [
    { id: 'met-1', meterNo: '01-2345-67-890', contractKw: 1500, accountName: '測試總醫院' },
    { id: 'met-2', meterNo: '01-2345-67-891', contractKw: 300, accountName: '測試總醫院', combined: true, address: '臺北市內湖區成功路二段 327 號' },
  ];
  inv.site.buildings = [{ id: 'bld-1', name: '醫療大樓' }];
  inv.site.staff = [{ id: 'st-1', role: '填表人員', name: '王小明', phone: '02-1234-5678' }];
  inv.site.policy = { iso50001: false, isoValidUntil: '2027-06-30' };
  inv.site.exemption = { isoValidUntil: '2027-12-31' };
  inv.equipment = [
    { id: 'eq-led', building: 'bld-1', category: 'lighting', kind: 'LED', status: 'active', fields: { name: 'B1 停車場 LED', wattPerFixture: 20, qty: 100, madeYear: 2010, hoursPerYear: 8760 } },
    { id: 'eq-boiler', building: 'bld-1', category: 'other', kind: '鍋爐', status: 'active', fields: { name: '蒸汽鍋爐 B-1', subKind: '蒸汽', model: '煙管式', powerKw: 15, qty: 1, madeYear: 2018, boilerEnergyType: '天然氣', opManagement: '依標準程序', maintenance: '定期' } },
  ];
  inv.points = [{ code: '803-E01', domain: 'power', name: '台電總表', location: 'B1', active: true, items: [{ id: 'bill', label: '電費單', type: 'bill', meterId: 'met-1' }] }];
  inv.records = [
    { id: 'r1', pointCode: '803-E01', period: '2026-02', at: '2026-02-05T01:00:00Z', who: 't', values: { bill: bill('2026-01', { usePeak: 100000, useHalfPeak: 50000, useSatHalfPeak: 10000, useOffPeak: 40000, demandPeak: 1200, feeTotal: 800000 }) }, usage: {} },
    { id: 'r2', pointCode: '803-E01', period: '2026-03', at: '2026-03-05T01:00:00Z', who: 't', values: { bill: bill('2026-02', { usePeak: 90000, useHalfPeak: 40000, useOffPeak: 30000, demandPeak: 1300, feeTotal: 700000 }) }, usage: {} },
  ];
  // 措施＋計畫：2025-06 完工（N-1）→ 表十＝跨年度成效；2026-05 完工（N）→ N 年度計畫
  inv.measures = [
    { id: 'm-a', type: 'operation', origin: 'manual', fields: { name: '冰水出水溫度提高 1℃', deviceClass: 'C04', action: 'A04', energyType: 'E01', annualSaving: 100000, savingCost: 300000, investment: 50000, officialCode: 'AA24' } },
    { id: 'm-b', type: 'operation', origin: 'manual', fields: { name: '停車場照明時間控制', deviceClass: 'C01', action: 'A04', energyType: 'E01', annualSaving: 20000, savingCost: 60000, investment: 30000 } },
  ];
  inv.plans = [
    { id: 'p-m-a', measureId: 'm-a', origin: 'manual', fields: { status: '已完工', completionYear: 114, actualDoneDate: '2025-06-15' }, versions: [] },
    { id: 'p-m-b', measureId: 'm-b', origin: 'manual', fields: { status: '已完工', completionYear: 115, actualDoneDate: '2026-05-20', execStart: '2026-03', execEnd: '2026-05', beforeState: '全日點亮', afterState: '夜間關一半', actualSaving: 25000 }, versions: [] },
  ];
  inv.diagnosis = { reportDate: '2026-03-01', period: '第一期', teams: [] };
  // N-1（114）年度輸入：燃料（天然氣）
  inv.annual = { 114: { fuels: Array.from({ length: 12 }, (_, i) => ({ id: `f114-${i}`, month: i + 1, E04qty: 1000, E04cost: 15000 })), app2: { applyDate: '2025-01-10', applyReason: '同址多電號', evidence: ['電費單'] } } };
  return inv;
}

test('表對照：附表三、附件一、附件二每張工作表都有 tableId，順序依附表三章節', () => {
  const inv = seed();
  const opts = { year: 115, today: '2026-10-22' };
  for (const [kind, build] of [['annex3', X.buildAnnex3], ['diagnosis', X.buildDiagnosis], ['plan', X.buildPlan]]) {
    const names = build(inv, opts).sheets.map((s) => s.name).filter((n) => n !== '待補欄位');
    const ts = EX.TABLES.filter((t) => t.kind === kind);
    for (const n of names) assert.ok(ts.some((t) => (t.prefix ? n.startsWith(t.sheet) : n === t.sheet)), `${kind}「${n}」沒有 tableId`);
    for (const t of ts) assert.ok(names.some((n) => (t.prefix ? n.startsWith(t.sheet) : n === t.sheet)), `${t.id} 對不到工作表`);
  }
  const ids = EX.TABLES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'tableId 不重複');
  assert.ok(ids.indexOf('a3-03') < ids.indexOf('a3-05-2') && ids.indexOf('a3-11-4') < ids.indexOf('a3-app2'), '章節順序：表三 → 表五 → 表十一 → 附錄二');
});

test('單表匯出：xlsx 只含該表＋該表待補、CSV 有 BOM 與正確值；表五之二每電號一張；錯誤代號 404、格式 400', async () => {
  const list = await call('GET', '/api/inv/report/table?year=115');
  assert.equal(list.status, 200);
  assert.equal(list.body.tables.length, EX.TABLES.length);
  assert.ok(list.body.tables.find((t) => t.id === 'a3-05-2').sheets === 2, '兩個電號兩張表');

  const x = await call('GET', '/api/inv/report/table/a3-03?year=115&format=xlsx');
  assert.equal(x.status, 200);
  assert.match(decodeURIComponent(x.headers.get('content-disposition')), /a3-03_表三 能源用戶基本資料_115年資料\.xlsx|a3-03_表三_能源用戶基本資料_115年資料\.xlsx/);
  const wb = readWorkbook(x.body);
  assert.deepEqual([...wb.sheets.keys()], ['表三 基本資料', '待補欄位']);
  const basic = wb.sheets.get('表三 基本資料').cells;
  assert.equal(basic.get(`C${rowOf(basic, '營業規模', 'B')}`), '500');
  const miss = [...wb.sheets.get('待補欄位').cells.values()];
  assert.ok(miss.includes('表三 基本資料') && !miss.includes('表七 建築資料'), '只列這張表的待補');

  const c = await call('GET', '/api/inv/report/table/a3-05-2?year=115&format=csv');
  assert.equal(c.status, 200);
  assert.match(c.headers.get('content-type'), /text\/csv/);
  const text = c.body.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM');
  assert.ok(text.includes('01-2345-67-890') && text.includes('01-2345-67-891'), '兩個電號都在');
  assert.ok(text.includes('200000'), '1 月度數');
  assert.ok(text.includes('臺北市內湖區成功路二段 325 號'), '電號沒填用電地址 → 沿用表三能源使用地址');

  assert.equal((await call('GET', '/api/inv/report/table/nope?year=115')).status, 404);
  assert.equal((await call('GET', '/api/inv/report/table/a3-03?year=115&format=pdf')).status, 400);
  assert.equal((await call('GET', '/api/inv/report/table/a3-03?year=abc')).status, 400);
});

test('整包 zip：每張表一個 CSV＋三本完整 xlsx＋節能計畫匯出檔', async () => {
  const z = await call('GET', '/api/inv/report/bundle?year=115');
  assert.equal(z.status, 200);
  assert.match(z.headers.get('content-type'), /zip/);
  const files = unzip(z.body);
  const names = [...files.keys()];
  assert.ok(names.includes('附表三_115年資料/附表三_能源查核申報_115年資料.xlsx'));
  assert.ok(names.some((n) => n.startsWith('附件一_節能診斷報告/') && n.endsWith('.xlsx')));
  assert.ok(names.some((n) => /^附件二_節能計畫\/節能計畫匯出_\d+年\.xlsx$/.test(n)));
  const csvs = names.filter((n) => n.endsWith('.csv') && !n.endsWith('待補欄位.csv') && !n.includes('節能計畫匯出'));
  assert.equal(csvs.length, EX.TABLES.filter((t) => !EX.RAW_EXPORTS[t.kind]).length, '每張表一個 CSV');
  assert.ok(names.includes('附件一_節能診斷報告/設備清單_全部_115年.xlsx') && names.includes('附件一_節能診斷報告/設備清單_應辦理節能診斷_115年.xlsx'), '設備清單兩種');
  // 整本與單表數字一樣
  const full = readWorkbook(files.get('附表三_115年資料/附表三_能源查核申報_115年資料.xlsx'));
  const one = readWorkbook((await call('GET', '/api/inv/report/table/a3-05-4?year=115')).body);
  assert.deepEqual([...one.sheets.get('表五之四 電能EUI').cells], [...full.sheets.get('表五之四 電能EUI').cells]);
});

test('申報對照頁：依章節順序列欄位與值，空值標待補並帶填寫處', async () => {
  const r = await call('GET', '/api/inv/report/filing?year=115');
  assert.equal(r.status, 200);
  const ids = r.body.tables.map((t) => t.id);
  assert.deepEqual(ids, EX.TABLES.filter((t) => !EX.RAW_EXPORTS[t.kind] && t.id !== 'a3-00').map((t) => t.id));
  const t3 = r.body.tables.find((t) => t.id === 'a3-03');
  const items = t3.sheets[0].blocks.find((b) => b.type === 'fields').items;
  const beds = items.find((x) => x.label === '營業規模');
  assert.equal(beds.value, '500');
  assert.equal(beds.status, 'ok');
  const hq = items.find((x) => x.label === '總公司名稱');
  assert.equal(hq.status, 'missing');
  assert.deepEqual(hq.fill, { section: 'i-site-basic', block: 'basic', field: 'hqName' });
  assert.equal(items.find((x) => x.label === '出租率').status, 'na', '醫院免填出租率');
  const fuel = r.body.tables.find((t) => t.id === 'a3-05-1');
  const rows = fuel.sheets[0].blocks.find((b) => b.type === 'rows');
  assert.equal(rows.rows[0].fill.tab, 'annual');
  assert.equal(rows.rows[0].fill.block, 'fuels');
  assert.ok(r.body.missingTotal > 0);
  assert.equal(r.body.carryover.complete, false);
});

test('年度報表資料：存燃料帳單 → 表五之一、表三總能源費用、表五之五熱能 EUI、表六熱能平衡都帶入；驗證錯誤 422', async () => {
  const bad = await call('PUT', '/api/inv/report/annual/fuels?year=115', { value: [{ month: 1, E04qty: 1 }, { month: 1, E04qty: 2 }] });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.details.some((d) => /1 月重複/.test(d)));
  assert.equal((await call('PUT', '/api/inv/report/annual/nope?year=115', { value: {} })).status, 404);
  const fuels = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, E04qty: 1100, E04cost: 16000 }));
  const ok = await call('PUT', '/api/inv/report/annual/fuels?year=115', { value: fuels, reporter: '王小明' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.value.length, 12);
  const g = await call('GET', '/api/inv/report/annual?year=115');
  assert.equal(g.body.data.fuels[0].E04qty, 1100);
  assert.equal(g.body.prev.fuels[0].E04qty, 1000, 'N-1 年一起回');
  assert.equal(g.body.meta.fuels.reporter, '王小明');
  assert.ok(g.body.refs.meters.some((m) => m.id === 'met-1'));

  const wb = readWorkbook((await call('GET', '/api/inv/report/annex3?year=115')).body);
  const s51 = wb.sheets.get('表五之一 熱能').cells;
  const jan = rowOf(s51, '115 年 1 月');
  assert.equal(s51.get(`F${jan}`), '1100', '天然氣欄');
  assert.equal(s51.get(`F${rowOf(s51, '總計')}`), '13200');
  const basic = wb.sheets.get('表三 基本資料').cells;
  // 電費 150 萬＋燃料 12×16000＝19.2 萬 → 169.2 萬元
  assert.equal(basic.get(`C${rowOf(basic, '總能源費用', 'B')}`), '169.2');
  const s55 = wb.sheets.get('表五之五 熱能EUI').cells;
  const m1 = rowOf(s55, '1 月');
  // 1100 m³ × 8107 kcal ÷ 10000 ＝ 891.77 kgOE；÷ 10000 ㎡
  assert.equal(s55.get(`D${m1}`), '891.77');
  assert.equal(s55.get(`B${m1}`), '810.7', 'N-1 年 1000 m³');
  const full = rowOf(s55, '全年');
  assert.ok(s55.get(`D${Number(full) + 0}`), '全年合計有值');
  const s6 = wb.sheets.get('表六 能源流程').cells;
  assert.equal(s6.get(`B${rowOf(s6, '天然氣')}`), String(Math.round(13200 * 8107 / 1e6 * 100) / 100), '熱能平衡燃料別取表五之一');
});

test('年度報表資料：再生能源 → 表六、表十之三（二）自發自用、表十之四；需量反應認列節電量；附錄二帶電號與填表人', async () => {
  await call('PUT', '/api/inv/report/annual/renewables?year=115', { value: [{ type: '太陽能', meterId: 'met-1', area: '屋頂', installedAt: '2024-05-01', kw: 99, genKwh: 120000, soldKwh: 20000 }] });
  await call('PUT', '/api/inv/report/annual/dr?year=115', { value: [{ month: 7, meterId: 'met-1', name: '夏月需量競價', scheme: 'e', kw: 200, hours: 4 }] });
  await call('PUT', '/api/inv/report/annual/deductN?year=115', { value: { safety: 5000 } });
  const wb = readWorkbook((await call('GET', '/api/inv/report/annex3?year=115')).body);
  const s6 = wb.sheets.get('表六 能源流程').cells;
  assert.equal(s6.get(`B${rowOf(s6, '再生能源自用總度數')}`), '100000', '年發電量－回售');
  const s103 = [...wb.sheets.get('表十之三 需量反應與再生').cells.values()];
  assert.ok(s103.includes('800'), '200 瓩 × 4 小時');
  assert.ok(s103.includes('01-2345-67-890'), '電號由 id 換成電號');
  const s104 = wb.sheets.get('表十之四 年度用電量計算').cells;
  assert.equal(s104.get(`B${rowOf(s104, 'N 年全年實際用電量')}`), '460000', '360000 度＋自發自用 100000');
  assert.equal(s104.get(`B${rowOf(s104, '年度用電量')}`), '455000', '扣除安全考量區域 5000');
  // 附錄二：N 年還沒填 → 免填欄位顯示待補；主申報＝met-1、合併申報＝met-2（自己的用電地址）
  const sa = [...wb.sheets.get('附錄二 合併申報申請表').cells.values()];
  assert.ok(sa.includes('主申報') && sa.includes('合併申報'));
  assert.ok(sa.includes('臺北市內湖區成功路二段 327 號'));
  assert.ok(sa.includes('王小明') && sa.includes('02-1234-5678'), '填表人與電話取能管人員');
});

test('節能計畫：表十／十一新欄位、措施來源跨年度、效益計算期間推算；month 欄位驗證', async () => {
  const bad = await call('PUT', '/api/inv/report/plans/p-m-b', { plan: { fields: { execEnd: '2026-13' } }, reason: 'x' });
  assert.equal(bad.status, 422);
  // 114 年完工的舊計畫（完工年度早於提報年度 115）：已完工的計畫不受 R7 完工年度範圍限制（第 27 項）
  const old = await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { beforeState: '出水 7℃', afterState: '出水 8℃' } } });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  const fix = await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { completionYear: 113 } }, reason: '更正實際完工年度' });
  assert.equal(fix.status, 200, '已完工：更正完工年度為更早的年度也可以存（R8 仍要原因）');
  assert.equal((await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { completionYear: 114 } } })).status, 422, 'R8：改已填的值仍要原因');
  assert.equal((await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { completionYear: 114 } }, reason: '改回' })).status, 200);
  // 未完工的計畫照 R7：預計完工年度須在提報年度～+4 年
  const notDone = await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { status: '執行中', completionYear: 113 } }, reason: '測試' });
  assert.equal(notDone.status, 422);
  assert.equal(notDone.body.rule, 'R7');
  assert.equal((await call('PUT', '/api/inv/report/plans/p-m-a', { plan: { fields: { status: '執行中' } }, reason: '測試' })).status, 422, '未完工＋114 年（早於提報年度 115）→ R7 擋');
  const ok = await call('PUT', '/api/inv/report/plans/p-m-b', { plan: { fields: { valueSource: '電表 803-E05', formula: '2', peakReductionKw: 12 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const wb = readWorkbook((await call('GET', '/api/inv/report/annex3?year=115')).body);
  const s101 = wb.sheets.get('表十之一 成效分析').cells;
  const vals = [...s101.values()];
  assert.ok(vals.includes('跨年度成效'), '114 年完工的措施');
  assert.ok(vals.includes('115 年度計畫'));
  assert.ok(vals.includes('全日點亮') && vals.includes('夜間關一半') && vals.includes('115-03～115-05'));
  assert.ok(vals.includes('25000'), '實際總節能量優先於預估');
  const s102 = wb.sheets.get('表十之二 執行成效').cells;
  const r1 = rowOf(s102, '1');
  assert.equal(s102.get(`H${r1}`), '115-01', '2025-06 完工 → 2025-07 起 12 個月，截在 115 年：115-01～115-06');
  assert.equal(s102.get(`I${r1}`), '115-06');
  const r2 = rowOf(s102, '2');
  assert.equal(s102.get(`H${r2}`), '115-06');
  assert.equal(s102.get(`I${r2}`), '115-12');
  assert.equal(s102.get(`J${r2}`), '12');
});

test('節能計畫匯出檔：欄位依對照表、可讀回（改對照表就能換格式）', async () => {
  const r = await call('GET', '/api/inv/report/plan-export');
  assert.equal(r.status, 200);
  const wb = readWorkbook(r.body);
  const sh = wb.sheets.get(EX.PLAN_EXPORT_MAP.sheet).cells;
  EX.PLAN_EXPORT_MAP.columns.forEach((c, i) => assert.equal(sh.get(`${String.fromCharCode(65 + i)}1`), c.header));
  assert.ok([...sh.values()].includes('AA24') && [...sh.values()].includes('空調·中央空調主機·溫度合理調整與控制'), '措施代碼與說明');
  const back = EX.readPlanExport(r.body);
  assert.deepEqual(back.errors, []);
  assert.equal(back.rows.length, 2);
  assert.equal(back.rows.find((x) => x.measureId === 'm-a').completionYear, '114');
  // 換一份對照表（模擬拿到能源署格式：表頭不同、欄位順序不同）
  const alt = { ...EX.PLAN_EXPORT_MAP, sheet: 'Sheet1', columns: [{ field: 'measureId', header: '措施編號' }, { field: 'completionYear', header: '完工年度', importable: true }, { field: 'name', header: '措施名稱' }] };
  const b2 = EX.buildPlanExport(seed(), { today: '2026-10-22' }, alt);
  const { buildWorkbook } = await import('../src/xlsx.js');
  const back2 = EX.readPlanExport(buildWorkbook(b2.sheets).buffer, alt);
  assert.deepEqual(back2.rows.map((x) => x.completionYear).sort(), ['114', '115']);
  const csv = await call('GET', '/api/inv/report/plan-export?format=csv');
  assert.ok(csv.body.toString('utf8').startsWith('﻿編號,設備/措施名稱,年節能量預估,單位,投資金額(元),回收年限(年),預計完工年度,備註,'));
});

test('節能計畫匯出檔對齊能源署範例：前 7 欄順序與表頭、設備/措施名稱、空值「-」；能源署原檔（無措施 ID）以編號讀回', async () => {
  const official = EX.PLAN_EXPORT_MAP.columns.filter((c) => c.official).map((c) => c.header);
  assert.deepEqual(official, ['編號', '設備/措施名稱', '年節能量預估', '單位', '投資金額(元)', '回收年限(年)', '預計完工年度', '備註']);
  assert.ok(EX.PLAN_EXPORT_MAP.columns.slice(0, official.length).every((c) => c.official), '範例欄排在最前面');
  assert.equal(EX.officialPlanName('辦公區照明燈具', 'replace', { kind: '燈具' }), '燈具/辦公區照明燈具汰舊換新');
  assert.equal(EX.officialPlanName('螺旋式冰水機汰舊換新成能效1級冰水機', 'replace', { kind: '冰水機' }), '冰水機/螺旋式冰水機汰舊換新成能效1級冰水機');
  assert.equal(EX.officialPlanName('依季節調整冰水出水溫度', 'operation', null), '依季節調整冰水出水溫度');
  const inv = seed();
  inv.measures[1].fields.investment = 0;
  inv.plans[1].fields.completionYear = '';
  inv.plans[1].fields.note = '配合預算調整，規劃於 122 年執行';
  const b = EX.buildPlanExport(inv, { today: '2026-10-22' });
  const rowB = b.sheets[0].rows.find((r) => r[1].v === '停車場照明時間控制');
  const at = (h) => rowB[EX.PLAN_EXPORT_MAP.columns.findIndex((c) => c.header === h)].v;
  assert.equal(at('投資金額(元)'), '-');
  assert.equal(at('回收年限(年)'), 0, '無投資 → 0（同範例）');
  assert.equal(at('預計完工年度'), '-');
  // 模擬能源署原檔：只有範例 7 欄（年節能量兩層表頭攤平）、沒有措施 ID → 用編號對回，「-」讀成空
  const { buildWorkbook } = await import('../src/xlsx.js');
  const offRows = b.sheets[0].rows.map((r) => r.slice(0, official.length));
  const back = EX.readPlanExport(buildWorkbook([{ name: '節能計畫', rows: offRows }]).buffer);
  assert.deepEqual(back.errors, []);
  assert.equal(back.keyField, 'no');
  const r2 = back.rows.find((x) => x.no === '2');
  assert.equal(r2.completionYear, '');
  assert.equal(r2.note, '配合預算調整，規劃於 122 年執行');
});

test('節能診斷設備清單：欄位依能源署範例、全部／僅應辦理診斷兩種、製造年份西元、可單表與整包下載', async () => {
  const official = EX.EQUIP_LIST_MAP.columns.filter((c) => c.official).map((c) => c.header);
  assert.deepEqual(official, ['編號', '設備名稱', '廠牌', '型式', '製造年份', '容量', '容量單位', '數量', '運轉時數(小時)', '年耗能量', '年耗能量單位']);
  const all = EX.equipListRows(seed(), { today: '2026-10-22' }).rows;
  assert.deepEqual(all.map((r) => r.equipmentId), ['eq-led', 'eq-boiler']);
  const led = all[0];
  assert.equal(led.madeYear, 2010);
  assert.equal(led.capacity, 20);
  assert.equal(led.capacityUnit, 'W/具');
  assert.equal(led.qty, 100);
  assert.equal(led.due, '是', 'LED 機齡 16 年 > 8 年');
  assert.equal(all[1].due, '否', '鍋爐 2018 年製，公用設備未超過 10 年');
  const inv = seed();
  inv.equipment[1].fields.madeYear = 100;   // 民國年也轉西元
  inv.equipment.push({ id: 'eq-gone', building: 'bld-1', category: 'ac', kind: '中央空調主機', status: 'replaced', fields: { name: '舊冰水機', madeYear: 1990 } });
  const due = EX.equipListRows(inv, { today: '2026-10-22', due: true }).rows;
  assert.deepEqual(due.map((r) => r.equipmentId), ['eq-led', 'eq-boiler'], '已汰換的不列；鍋爐 2011 年製 → 超過 10 年');
  assert.equal(due[1].madeYear, 2011);
  const x = await call('GET', '/api/inv/report/table/a1-equip-due?format=xlsx');
  assert.equal(x.status, 200);
  const sh = readWorkbook(x.body).sheets.get('設備清單').cells;
  EX.EQUIP_LIST_MAP.columns.forEach((c, i) => assert.equal(sh.get(`${String.fromCharCode(65 + i)}1`), c.header));
  assert.equal(sh.get('B2'), 'B1 停車場 LED');
  assert.equal(sh.get('B3'), undefined, '只有一筆應辦理');
  const list = await call('GET', '/api/inv/report/table');
  assert.equal(list.body.tables.find((t) => t.id === 'a1-equip').kind, 'equipList');
});

test('年度沿用：逐區塊確認記人與快照；確認後又改 → 需重新確認；年度區塊一鍵沿用 N-1；N-1 年面積取快照', async () => {
  const v0 = await call('GET', '/api/inv/report/carryover?year=115');
  assert.equal(v0.status, 200);
  assert.equal(v0.body.complete, false);
  assert.ok(v0.body.units.some((u) => u.id === 'site.basic') && v0.body.units.some((u) => u.id === 'equipment') && v0.body.units.some((u) => u.id === 'annual.app2'));
  const app2 = v0.body.units.find((u) => u.id === 'annual.app2');
  assert.equal(app2.canCopy, true, 'N 年空、N-1 年有 → 可沿用');

  // 看過之後被別人改了 → 409
  const basic0 = v0.body.units.find((u) => u.id === 'site.basic');
  assert.equal((await call('POST', '/api/inv/report/carryover/site.basic?year=115', { expectHash: 'deadbeef' })).status, 409);
  const c1 = await call('POST', '/api/inv/report/carryover/site.basic?year=115', { expectHash: basic0.hash, reporter: '王小明' });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.unit.status, 'confirmed');
  assert.equal(c1.body.unit.confirmation.reporter, '王小明');
  assert.match(c1.body.unit.confirmation.who, /王小明（測試院所803）/);

  const cp = await call('POST', '/api/inv/report/carryover/annual.app2?year=115', { copy: true });
  assert.equal(cp.status, 200);
  assert.equal(cp.body.copied, true);
  assert.equal((await call('POST', '/api/inv/report/carryover/annual.app2?year=115', { copy: true })).status, 422, '已有資料不能再整份覆蓋');
  assert.equal((await call('POST', '/api/inv/report/carryover/site.meters?year=115', { copy: true })).status, 422);
  assert.equal((await call('POST', '/api/inv/report/carryover/nope?year=115', {})).status, 404);
  const an = await call('GET', '/api/inv/report/annual?year=115');
  assert.equal(an.body.data.app2.applyReason, '同址多電號');

  // 確認後修改 basic → stale
  const put = await call('PUT', '/api/inv/site/basic', { value: { ...seed().site.basic, floorArea: 13000 }, reason: '新大樓啟用' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const v1 = await call('GET', '/api/inv/report/carryover?year=115');
  assert.equal(v1.body.units.find((u) => u.id === 'site.basic').status, 'stale');

  // 116 年：N-1（115）年快照的總樓地板是 12000（確認當下），不是目前的 13000
  const v2 = await call('GET', '/api/inv/report/carryover?year=116');
  const b116 = v2.body.units.find((u) => u.id === 'site.basic');
  assert.equal(b116.hasPrev, true);
  assert.ok(b116.diff.changed.some((d) => d.key === 'floorArea' && d.before === '12000' && d.after === '13000'), '差異列出前後值');
  const wb = readWorkbook((await call('GET', '/api/inv/report/annex3?year=116')).body);
  const s54 = wb.sheets.get('表五之四 電能EUI').cells;
  assert.equal(s54.get(`B${rowOf(s54, 'N-1 年室內樓地板面積（㎡）')}`), '10000', '12000－2000（115 年快照）');
  assert.equal(s54.get(`B${rowOf(s54, 'N 年室內樓地板面積（㎡）')}`), '11000');

  // 全部確認完 → complete
  for (const u of (await call('GET', '/api/inv/report/carryover?year=115')).body.units) {
    if (u.status === 'confirmed') continue;
    const r = await call('POST', `/api/inv/report/carryover/${u.id}?year=115`, { expectHash: u.hash });
    assert.equal(r.status, 200, `${u.id} ${JSON.stringify(r.body)}`);
  }
  const done = await call('GET', '/api/inv/report/carryover?year=115');
  assert.equal(done.body.complete, true);
  const inv = await store.readInventory('803');
  assert.ok(inv.snapshots[115].equipment.length === 2 && inv.snapshots[115].site.meters.length === 2, '快照存設備與電號');
});

test('跨表共用：ISO 證書效期單一來源、建築用戶分類沿用表三、鍋爐重大設備欄跟著設備主檔', () => {
  const inv = seed();
  const b = X.buildAnnex3(inv, { year: 115, today: '2026-10-22' });
  assert.ok(b.missing.some((m) => m.field === 'ISO 50001 證書效期' && /兩處不同/.test(m.why)), '兩處填的效期不同 → 待補');
  const s7 = b.sheets.find((s) => s.name === '表七 建築資料');
  assert.ok(s7.rows.some((r) => r.some((c) => c.v === '醫院')), '建築用戶分類沿用表三');
  const s95 = b.sheets.find((s) => s.name === '表九之五 重大設備');
  assert.ok(s95.rows.some((r) => r.some((c) => c.v === '依標準程序')));
  const s93 = b.sheets.find((s) => s.name === '表九之三 其他系統');
  assert.ok(!s93.rows.some((r) => r.some((c) => c.v === '操作管理現況')), '表九之五的欄不進表九之三清冊');
  // 匯出不改原資料
  assert.deepEqual(inv, seed());
});

test('欄位對照：每欄有來源與狀態、ref 指到真的欄位、docs/annex3-field-map.md 與程式一致', () => {
  const tableIds = new Set(EX.TABLES.map((t) => t.id));
  for (const e of FM.FIELD_MAP) {
    assert.ok(tableIds.has(e.tableId), `未知 tableId ${e.tableId}`);
    assert.ok(e.field && e.source, `${e.tableId} 缺欄名或來源`);
    assert.ok(FM.STATUS[e.status], `${e.tableId}「${e.field}」狀態不明`);
    if (e.ref) assert.ok(FM.refExists(e.ref), `${e.tableId}「${e.field}」ref ${e.ref} 不存在`);
    if (e.status === 'input') assert.ok(e.ref, `新增輸入欄位要指出填寫處：${e.field}`);
  }
  // 水足跡（kind water）不屬於附表三，不在欄位盤點內
  for (const t of EX.TABLES.filter((x) => x.id !== 'a3-00' && !EX.RAW_EXPORTS[x.kind] && x.kind !== 'water')) assert.ok(FM.FIELD_MAP.some((e) => e.tableId === t.id), `${t.id} 沒有盤點`);
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/annex3-field-map.md'), 'utf8');
  assert.equal(doc, FM.fieldMapMarkdown() + '\n', '請跑 node scripts/field-map.mjs 重產');
  // 年度區塊的每個欄位都有人用（盤點裡出現或是內部欄）
  for (const b of AN.ANNUAL_BLOCKS.filter((x) => !x.water)) for (const f of b.fields) {
    if (f.key === 'month' || f.key === 'group' || f.key === 'equipmentId' || f.key === 'evidence' && b.id === 'deductN' || f.key === 'selfKwh' && b.id === 'renewables' || f.key === 'applicantStaffId' || f.key === 'mainMeterId' || f.key === 'phone' || f.key === 'applyUnit' || f.key === 'prevParkingArea') continue;
    assert.ok(FM.FIELD_MAP.some((e) => e.ref === `annual.${b.id}.${f.key}`) || FM.FIELD_MAP.some((e) => e.ref?.startsWith(`annual.${b.id}.`) && e.status !== 'input'), `年度欄 ${b.id}.${f.key} 沒有在盤點出現`);
  }
});

// ════════════════════════ 第 27 項 ════════════════════════
test('第 27 項：水足跡盤查清冊納入單表匯出、整包 zip、申報對照頁（另立「水足跡」章節）', async () => {
  const W = await import('../src/report-water.js');
  // 每張水足跡工作表都有 tableId（新增或改名工作表要同步 TABLES）
  const names = W.buildWater(seed(), { year: 115, today: '2026-10-22' }).sheets.map((s) => s.name).filter((n) => n !== '待補欄位');
  const wt = EX.TABLES.filter((t) => t.kind === 'water');
  assert.deepEqual(wt.map((t) => t.sheet), names, '水足跡 tableId 依清冊工作表順序');
  assert.ok(wt.every((t) => t.chapter === '水足跡'));
  assert.ok(EX.TABLES.indexOf(wt[0]) > EX.TABLES.findIndex((t) => t.id === 'a2-export'), '排在附件二之後');

  const list = await call('GET', '/api/inv/report/table?year=115');
  assert.ok(list.body.tables.some((t) => t.id === 'w-09' && t.kind === 'water' && t.sheets === 1));
  const one = await call('GET', '/api/inv/report/table/w-09?year=115&format=xlsx');
  assert.equal(one.status, 200);
  assert.match(decodeURIComponent(one.headers.get('content-disposition')), /w-09_水足跡·衝擊評估（缺水足跡）_115年資料\.xlsx/);
  const wb = readWorkbook(one.body);
  assert.deepEqual([...wb.sheets.keys()], ['衝擊評估', '待補欄位']);
  const csv = (await call('GET', '/api/inv/report/table/w-02?year=115&format=csv')).body.toString('utf8');
  assert.ok(csv.startsWith('﻿水足跡盤查清冊·取水'));

  const files = unzip((await call('GET', '/api/inv/report/bundle?year=115')).body);
  const zn = [...files.keys()];
  assert.ok(zn.some((n) => /^水足跡盤查_115年資料\/水足跡盤查清冊_115年_.*\.xlsx$/.test(n)), zn.join('\n'));
  assert.equal(zn.filter((n) => n.startsWith('水足跡盤查_115年資料/w-')).length, wt.length, '每張水足跡表一個 CSV');
  assert.ok(zn.includes('水足跡盤查_115年資料/待補欄位.csv'));

  const f = await call('GET', '/api/inv/report/filing?year=115');
  const ch = f.body.tables.filter((t) => t.chapter === '水足跡');
  assert.equal(ch.length, wt.length);
  assert.equal(f.body.tables.at(-1).chapter, '水足跡', '水足跡章節在最後');
  const scope = ch.find((t) => t.id === 'w-01');
  assert.deepEqual(scope.fill, { section: 'i-site-waterScope', block: 'waterScope' });
  assert.ok(scope.missingCount > 0, '範疇沒填 → 待補');
  assert.deepEqual(ch.find((t) => t.id === 'w-08').fill, { tab: 'annual', block: 'waterMonthly' }, '績效指標去填＝每月營運活動');
});

test('第 27 項：年度沿用維持全部區塊逐一確認——水足跡的初始建檔區塊也是沿用單位，確認與 stale 照常', async () => {
  const S2 = await import('../src/inventory-schema.js');
  const v = await call('GET', '/api/inv/report/carryover?year=117');
  const ids = v.body.units.map((u) => u.id);
  for (const b of S2.SITE_BLOCKS) assert.ok(ids.includes(`site.${b.id}`), `site.${b.id} 不在沿用清單`);
  for (const id of ['site.waterScope', 'site.waterActivity', 'site.waterSources', 'site.waterUnits', 'site.waterDischarges', 'site.waterQualityPlan', 'site.waterUpstream']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('annual.waterMonthly'), '每月營運活動每年重填，不是沿用單位');
  const u = v.body.units.find((x) => x.id === 'site.waterScope');
  const c = await call('POST', '/api/inv/report/carryover/site.waterScope?year=117', { expectHash: u.hash });
  assert.equal(c.status, 200);
  assert.equal(c.body.unit.status, 'confirmed');
  await call('PUT', '/api/inv/site/waterScope', { value: { goal: '新目的' } });
  const v2 = await call('GET', '/api/inv/report/carryover?year=117');
  assert.equal(v2.body.units.find((x) => x.id === 'site.waterScope').status, 'stale');
  assert.equal(v2.body.complete, false);
});
