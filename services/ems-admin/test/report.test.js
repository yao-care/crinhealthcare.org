// 申報與報告（措施、節能計畫、xlsx 產出、期限提醒）的回歸測試。
//
// 蓋住「壞掉會很難發現」的幾件事：
//   - R6 超齡設備自動出現在設備汰換表、不可刪（能源署系統帶出的清單每筆都要評估、不可刪）
//   - R7 回收 < 10 年自動帶入節能計畫、不可刪；完工年度空白備註必填；完工年度限提報年度～+4
//   - R8 計畫變更留版本紀錄（變更前後、日期、原因）
//   - 三份 xlsx 都產得出來、讀得回去；表五之二的 1–12 月彙整數字對得上電費單
//
// 資料一律寫到暫存目錄：config.js 會讀 .env（production 設定），環境變數先設好才 import。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const TMP = mkdtempSync(join(tmpdir(), 'ems-report-test-'));
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
const { readWorkbook } = await import('../src/xlsx.js');
const model = await import('../src/report-model.js');

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
async function call(method, path, body, { hid = '803', origin } = {}) {
  const headers = { cookie: cookieFor(hid) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

// ── 種子資料：提報日 116-03-01（提報年度 116）；資料年 N＝115 ──
const bill = (period, o) => ({ values: { period, meterNo: '01-2345-67-890', tariffType: '高壓三段式', contractCapacity: 1500, powerFactor: 98, ...o }, meta: {} });
function seed() {
  const inv = S.blankInventory();
  inv.site.basic = { userName: '測試總醫院', userCategory: '醫院', beds: 500, floorArea: 12000, parkingArea: 2000 };
  inv.site.meters = [{ id: 'met-1', seq: 1, meterNo: '01-2345-67-890', contractKw: 1500, accountName: '測試總醫院' }];
  inv.site.buildings = [{ id: 'bld-1', name: '醫療大樓' }];
  inv.site.policy = { iso50001: true, isoValidUntil: '2027-06-30' };
  inv.equipment = [
    // LED 2010 年製，提報年度 116（2027）機齡 17 > 8 → R6 必列
    { id: 'eq-led', building: 'bld-1', category: 'lighting', kind: 'LED', status: 'active', fields: { name: 'B1 停車場 LED', wattPerFixture: 20, qty: 100, madeYear: 2010, hoursPerYear: 8760 } },
    // 冰水主機 2020 年製，機齡 7 ≤ 10 → 不必列
    { id: 'eq-ch', building: 'bld-1', category: 'ac', kind: '中央空調主機', status: 'active', fields: { name: 'CH-1', powerKw: 400, qty: 2, capacity: 600, capacityUnit: 'RT', madeYear: 2020, chillerGroup: 'G1', hoursPerYear: 4000 } },
    // 已汰換的舊設備不列
    { id: 'eq-old', category: 'ac', kind: '冰水泵', status: 'replaced', fields: { name: '舊泵', powerKw: 10, qty: 1, madeYear: 1990 } },
  ];
  inv.points = [
    { code: '803-E01', domain: 'power', name: '台電總表', location: 'B1', active: true, items: [{ id: 'bill', label: '電費單', type: 'bill', meterId: 'met-1' }] },
    { code: '803-E02', domain: 'power', name: '冰水主機盤', location: 'RF', active: true, items: [
      { id: 'kwh', label: '冰水系統累計度數', type: 'reading', chillerGroup: 'G1', chillerRole: 'kwh' },
      { id: 'rth', label: '月冷凍噸時', type: 'number', chillerGroup: 'G1', chillerRole: 'rth' },
    ] },
  ];
  inv.records = [
    { id: 'r1', pointCode: '803-E01', period: '2026-02', at: '2026-02-05T01:00:00Z', who: 't', values: { bill: bill('2026-01', { usePeak: 100000, useHalfPeak: 50000, useSatHalfPeak: 10000, useOffPeak: 40000, demandPeak: 1200, feeTotal: 800000 }) }, usage: {} },
    // 2 月有兩筆：後送的那筆才算（更正重送），不加總
    { id: 'r2', pointCode: '803-E01', period: '2026-03', at: '2026-03-05T01:00:00Z', who: 't', values: { bill: bill('2026-02', { usePeak: 1, useOffPeak: 1, feeTotal: 1 }) }, usage: {} },
    { id: 'r3', pointCode: '803-E01', period: '2026-03', at: '2026-03-06T01:00:00Z', who: 't', values: { bill: bill('2026-02', { usePeak: 90000, useHalfPeak: 40000, useOffPeak: 30000, demandPeak: 1300, feeTotal: 700000 }) }, usage: {} },
    { id: 'r4', pointCode: '803-E02', period: '2026-01', at: '2026-01-31T01:00:00Z', who: 't', values: { kwh: 5000, rth: 100000 }, usage: { kwh: 65000 } },
  ];
  inv.diagnosis = { reportDate: '2027-03-01', period: '第一期', teams: [{ id: 'team-1', name: '某某技師事務所', type: '執業技師', code: 'Q-E1', licenceDiscipline: '電機', licenceExpiresAt: '2027-12-31', members: [] }] };
  return inv;
}

before(async () => { await store.saveInventory('803', seed(), { what: '測試種子' }); });

test('R6：超齡設備自動出現在設備汰換表、帶入設備主檔欄位、不可刪（可補說明）', async () => {
  const r = await call('GET', '/api/inv/report/measures');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reportYear, 116);
  const auto = r.body.measures.replace.find((m) => m.equipmentId === 'eq-led');
  assert.ok(auto, 'LED 機齡 17 年 > 8 年應自動列入');
  assert.equal(auto.id, 'm-eq-eq-led', '決定性 id：讀取時就有，不必先寫檔');
  assert.equal(auto.mandatory, true);
  assert.equal(auto.values.name, 'B1 停車場 LED');
  assert.equal(auto.r6.age, 17);
  assert.equal(auto.r6.source.ref, '註 2');
  assert.ok(!r.body.measures.replace.some((m) => m.equipmentId === 'eq-ch'), '機齡未超過不必列');
  assert.ok(!r.body.measures.replace.some((m) => m.equipmentId === 'eq-old'), '已汰換設備不列');

  const del = await call('DELETE', `/api/inv/report/measures/${auto.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.body.rule, 'R6');
  assert.match(del.body.message, /不可刪除/);

  const put = await call('PUT', `/api/inv/report/measures/${auto.id}`, { measure: { fields: { note: '113 年已編列預算', annualSaving: 8000, savingCost: 32000, investment: 120000, assessment: '換高效率 LED 並加裝感應' } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.measure.values.note, '113 年已編列預算');
  assert.equal(put.body.measure.payback.value, 3.75);
  const inv = await store.readInventory('803');
  assert.ok(inv.measures.some((m) => m.id === auto.id && m.origin === 'r6'), '編輯後落地成同一個 id');
  // 回收 3.75 年 < 10 → 同一措施 ID 自動帶進節能計畫
  assert.ok(inv.plans.some((p) => p.measureId === auto.id && p.id === `p-${auto.id}`));

  // 跨院 403、DELETE 也要擋 Origin
  assert.equal((await call('DELETE', `/api/inv/report/measures/${auto.id}`, undefined, { origin: 'https://evil.example' })).status, 403);
});

test('R7：回收 < 10 年自動帶入計畫且不可刪；完工年度空白備註必填；完工年度限提報年度～+4', async () => {
  const add = await call('POST', '/api/inv/report/measures', { measure: { type: 'operation', fields: { name: '冰水出水溫度提高 1℃', deviceClass: 'C04', action: 'A04', annualSaving: 100000, savingCost: 300000, investment: 50000, officialCode: 'AA24' } } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const mid = add.body.measure.id;
  assert.equal(add.body.measure.planMandatory.value, true);

  const pl = await call('GET', '/api/inv/report/plans');
  const p = pl.body.plans.find((x) => x.measureId === mid);
  assert.ok(p, '回收 0.17 年應自動帶入');
  assert.equal(p.mandatory, true);
  assert.deepEqual(p.range, [116, 120]);
  assert.equal(p.check.ok, false, '完工年度與備註都空白 → 檢核不通過');
  assert.equal(p.fields.officialCode, 'AA24', '措施代碼沿用措施');

  assert.equal((await call('DELETE', `/api/inv/report/plans/${p.id}`)).status, 409);
  const bad = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { status: '規劃中' } } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.rule, 'R7');
  const out = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 121 } } });
  assert.equal(out.status, 422, '121 超過 116+4');
  assert.equal((await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 115 } } })).status, 422, '早於提報年度');
  const noteOnly = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { note: '待 117 年預算' } } });
  assert.equal(noteOnly.status, 200, '完工年度空白但有備註 → 可以');
  const ok = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 2028 } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.plan.fields.completionYear, 117, '西元自動轉民國');

  // 刪掉措施的 R7 計畫不可刪，但回收 ≥ 10 年的措施可自願納入、可移除
  const slow = await call('POST', '/api/inv/report/measures', { measure: { type: 'operation', fields: { name: '外牆隔熱', savingCost: 1000, investment: 100000 } } });
  assert.equal(slow.body.measure.planId, null, '回收 100 年不強制');
  const vol = await call('POST', '/api/inv/report/plans', { measureId: slow.body.measure.id });
  assert.equal(vol.status, 200);
  assert.equal(vol.body.plan.mandatory, false);
  assert.equal((await call('DELETE', `/api/inv/report/plans/${vol.body.plan.id}`)).status, 200);
});

test('R8：計畫變更留版本紀錄（變更前後、日期、原因），改已填的值要原因', async () => {
  const pl = await call('GET', '/api/inv/report/plans');
  const p = pl.body.plans.find((x) => x.fields.completionYear === 117);
  const noReason = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 118 } } });
  assert.equal(noReason.status, 422);
  assert.equal(noReason.body.error, 'reason_required');
  const r = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 118, status: '執行中' } }, reason: '主機交期延後' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const vers = r.body.plan.versions;
  assert.equal(vers.length, 3);
  const last = vers.at(-1);
  assert.equal(last.v, 3);
  assert.deepEqual(last.before, { completionYear: 117, status: null });
  assert.deepEqual(last.after, { completionYear: 118, status: '執行中' });
  assert.equal(last.reason, '主機交期延後');
  assert.match(last.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(vers[0].reason, '初次填寫');
  const ch = await call('GET', '/api/inv/changes');
  assert.ok(ch.body.items.some((c) => c.kind === 'plan.change' && c.reason === '主機交期延後'), '同步寫進異動登錄');
  // 沒變動不留版本
  const same = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 118 } } });
  assert.equal(same.body.unchanged, true);
});

const cellsOf = (buf, name) => {
  const wb = readWorkbook(buf);
  const sh = wb.sheets.get(name);
  assert.ok(sh, `缺工作表 ${name}；有：${[...wb.sheets.keys()].join('、')}`);
  return sh.cells;
};
const rowOf = (cells, text) => { for (const [ref, v] of cells) if (ref.startsWith('A') && /^A\d+$/.test(ref) && v === text) return Number(ref.slice(1)); return null; };

test('表五之二：電費單點位紀錄彙整 1–12 月（同月取最後一筆、合計正確）', async () => {
  const inv = await store.readInventory('803');
  const sheets = model.billMonths(inv);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].months.get('2026-02').useTotal, 160000, '2 月取後送那筆');
  assert.equal(sheets[0].months.get('2026-01').useTotal, 200000);

  const r = await call('GET', '/api/inv/report/annex3?year=115');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const c = cellsOf(r.body, '表五之二 電號01-2345-67-890');
  const r1 = rowOf(c, '115 年 1 月');
  assert.ok(r1, '有 1 月列');
  assert.equal(c.get(`B${r1}`), '1500', '經常契約容量');
  assert.equal(c.get(`G${r1}`), '1200', '最高需量·尖峰');
  assert.equal(c.get(`K${r1}`), '100000');
  assert.equal(c.get(`O${r1}`), '200000', '合計度數＝四時段加總');
  assert.equal(c.get(`R${r1}`), '800000');
  assert.equal(c.get(`O${r1 + 1}`), '160000');
  assert.equal(c.get(`O${r1 + 2}`) ?? '', '', '3 月沒有電費單 → 留空');
  const tot = rowOf(c, '合計');
  assert.equal(tot, r1 + 12);
  assert.equal(c.get(`O${tot}`), '360000');
  assert.equal(c.get(`R${tot}`), '1500000');
  assert.match(c.get('A2'), /附表三.*表五之二.*經能字第 11558000090 號.*115-01-23/);
});

test('附表三：各表分工作表、抬頭標依據、推得出的帶入、推不出的列在待補欄位', async () => {
  const r = await call('GET', '/api/inv/report/annex3?year=115');
  const wb = readWorkbook(r.body);
  const names = [...wb.sheets.keys()];
  for (const n of ['表三 基本資料', '表三 電號資料', '表五之四 電能EUI', '表五之五 熱能EUI', '表七 建築資料', '表八 電能系統', '表九之一（二）群組效率', '表九之二 照明', '表十之四 年度用電量計算', '表十一之四 年度用電量估算', '待補欄位']) assert.ok(names.includes(n), `缺 ${n}`);
  assert.ok(!names.some((n) => n.includes('表十之六')), '表十之六已刪除');
  assert.equal(names.at(-1), '待補欄位');
  for (const [n, sh] of wb.sheets) assert.match(sh.cells.get('A2') || '', /^依據：/, `${n} 抬頭沒有依據`);

  const basic = wb.sheets.get('表三 基本資料').cells;
  const bedRow = [...basic].find(([ref, v]) => ref.startsWith('B') && v === '營業規模')[0].slice(1);
  assert.equal(basic.get(`C${bedRow}`), '500');
  const costRow = [...basic].find(([ref, v]) => ref.startsWith('B') && v === '總能源費用')[0].slice(1);
  assert.equal(basic.get(`C${costRow}`), '150', '總能源費用（萬元）由電費單推算');

  const eui = wb.sheets.get('表五之四 電能EUI').cells;
  const jan = rowOf(eui, '1 月');
  assert.equal(eui.get(`D${jan}`), '200000');
  assert.equal(eui.get(`E${jan}`), '20', '200000 度 ÷ 室內 10000 ㎡');
  assert.match(wb.sheets.get('表五之五 熱能EUI').cells.get('A2'), /公斤油當量/);

  const chill = wb.sheets.get('表九之一（二）群組效率').cells;
  const g1 = [...chill].find(([ref, v]) => ref.startsWith('C') && v === '1 月')[0].slice(1);
  assert.equal(chill.get(`D${g1}`), '65000', '累計讀數取用量');
  assert.equal(chill.get(`E${g1}`), '100000');
  assert.equal(chill.get(`F${g1}`), '0.65');

  const t104 = wb.sheets.get('表十之四 年度用電量計算').cells;
  assert.equal([...t104.values()].filter((v) => /^\d\. /.test(v)).length, 8, '8 個可扣除項');
  const t114 = wb.sheets.get('表十一之四 年度用電量估算').cells;
  assert.equal([...t114.values()].filter((v) => /^\d\. /.test(v)).length, 6, '6 個可扣除項');
  assert.ok([...t114.values()].some((v) => v.includes('其他估算方式')));

  const miss = wb.sheets.get('待補欄位').cells;
  assert.ok([...miss.values()].some((v) => v.includes('3、4、5、6、7、8、9、10、11、12 月電費單')));
  const j = await call('GET', '/api/inv/report/missing?kind=annex3&year=115');
  assert.ok(j.body.missing.length > 5);
  assert.ok(j.body.missing.every((m) => m.sheet && m.field));
  assert.ok(j.body.missing.some((m) => m.field === '全年 EUI 差異' && /缺/.test(m.why)), '缺月份時不硬算 EUI 差異');
});

test('附件一 診斷報告、附件二 節能計畫：產得出、讀得回、關鍵格正確', async () => {
  const d = await call('GET', '/api/inv/report/diagnosis');
  assert.equal(d.status, 200);
  const wb = readWorkbook(d.body);
  assert.deepEqual([...wb.sheets.keys()], ['報告主檔', '一、診斷摘要', '二、設備汰換', '三、操作面', '四、診斷團隊聲明', '待補欄位']);
  const head = wb.sheets.get('報告主檔').cells;
  assert.equal(head.get('C6'), '測試總醫院');
  assert.equal(head.get('C7'), '116-03-01');
  assert.equal(head.get('C9'), '121-03-01', '保存期限＝提報日＋5 年');
  const sum = wb.sheets.get('一、診斷摘要').cells;
  // 措施：LED 8000 度、冰水 100000 度、外牆隔熱未填 → 3 項；108000 度 × 0.000086 = 9.288 TOE
  assert.match(sum.get('A5'), /共包含 3 項具體節能改善措施，計發掘節能潛力 9\.288 公噸油當量，其中包括節電潛力 10\.8 萬度/);
  assert.ok([...sum.values()].some((v) => v.includes('NG1')), '天然氣註明先用 NG1');
  assert.match(sum.get('A2'), /附件一.*經能字第 11558001660 號/);
  const rep = wb.sheets.get('二、設備汰換').cells;
  assert.ok([...rep.values()].includes('B1 停車場 LED'));
  assert.ok([...rep.values()].includes('是（不可刪）'));
  assert.ok([...rep.values()].some((v) => v.startsWith('2. 螢光燈具超過 2 年')), '表註原文');
  const team = wb.sheets.get('四、診斷團隊聲明').cells;
  assert.match(team.get('A5'), /洽請某某技師事務所等診斷團隊辦理/);

  const p = await call('GET', '/api/inv/report/plan');
  assert.equal(p.status, 200);
  const pw = readWorkbook(p.body);
  assert.deepEqual([...pw.sheets.keys()], ['節能計畫', '版本紀錄', '待補欄位']);
  const plan = pw.sheets.get('節能計畫').cells;
  assert.ok([...plan.values()].includes('冰水出水溫度提高 1℃'));
  assert.ok([...plan.values()].includes('118'));
  assert.ok([...plan.values()].some((v) => v.startsWith('1. 節能診斷報告所載回收年限小於 10 年')), '附件二表註原文');
  assert.ok([...plan.values()].some((v) => v.startsWith('2. 上表所列節能改善措施如未載明預計完工年度')));
  const ver = pw.sheets.get('版本紀錄').cells;
  assert.ok([...ver.values()].includes('主機交期延後'));
});

test('期限提醒：帶入 ISO 證書與技師執照效期，依日期排序並附依據', async () => {
  const r = await call('GET', '/api/inv/report/deadlines');
  assert.equal(r.status, 200);
  const keys = r.body.items.map((x) => x.key);
  assert.ok(keys.includes('annex3') && keys.includes('saving-rate'));
  assert.ok(keys.includes('iso50001'), 'ISO 證書效期 2027-06-30');
  const lic = r.body.items.find((x) => x.key === 'licence');
  assert.ok(lic && lic.label.includes('某某技師事務所'));
  assert.ok(r.body.items.find((x) => x.key === 'retention'), '報告保存期限');
  assert.ok(r.body.items.every((x) => x.source?.doc));
  const days = r.body.items.map((x) => x.daysLeft);
  assert.deepEqual(days, [...days].sort((a, b) => a - b));
});

test('點位項目新增的冰水機群組屬性：向後相容、要成對、只限數值型', () => {
  const base = { code: '803-E09', domain: 'power', name: 'x', items: [] };
  assert.equal(S.validatePoint({ ...base, items: [{ id: 'a', label: 'a', type: 'reading' }] }).ok, true, '舊點位不受影響');
  assert.equal(S.validatePoint({ ...base, items: [{ id: 'a', label: 'a', type: 'reading', chillerGroup: 'G1', chillerRole: 'kwh' }] }).ok, true);
  assert.equal(S.validatePoint({ ...base, items: [{ id: 'a', label: 'a', type: 'reading', chillerGroup: 'G1' }] }).ok, false);
  assert.equal(S.validatePoint({ ...base, items: [{ id: 'a', label: 'a', type: 'text', chillerGroup: 'G1', chillerRole: 'rth' }] }).ok, false);
  assert.equal(S.validatePoint({ ...base, items: [{ id: 'a', label: 'a', type: 'number', chillerGroup: 'G1', chillerRole: 'xx' }] }).ok, false);
});

test('診斷團隊：存檔後 R3 檢核與提報日', async () => {
  const r = await call('PUT', '/api/inv/report/diagnosis-data', { diagnosis: { reportDate: '116-03-01', period: '第一期', teams: [{ name: '甲公司', type: '法人', code: 'Q-L3', commissioned: true, members: [{ name: '王小明', years: 8, fullTime: true }] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.diagnosis.reportDate, '2027-03-01', '民國日期轉 ISO');
  assert.ok(r.body.diagnosis.teams[0].id && r.body.diagnosis.teams[0].members[0].id);
  const g = await call('GET', '/api/inv/report/diagnosis-data');
  assert.equal(g.body.checks[0].ok, true);
  assert.equal(g.body.retentionUntil, '2032-03-01');
  assert.equal((await call('PUT', '/api/inv/report/diagnosis-data', { diagnosis: { teams: [{ code: 'Q-L1' }] } })).status, 422, '團隊名稱必填');
});

test('操作人姓名：報表 API 的版本紀錄與異動帶「姓名（院名）」；DELETE 用 ?reporter=；過長 422', async () => {
  const pl = await call('GET', '/api/inv/report/plans');
  const p = pl.body.plans.find((x) => x.fields.completionYear === 118) || pl.body.plans[0];
  const r = await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 119 } }, reason: '預算延後', reporter: '陳工程師' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.version.who, '陳工程師（測試院所803）');
  assert.equal(r.body.version.reporter, '陳工程師');
  assert.equal(r.body.change.who, '陳工程師（測試院所803）');
  assert.equal((await call('PUT', `/api/inv/report/plans/${p.id}`, { plan: { fields: { completionYear: 118 } }, reason: 'x', reporter: '名'.repeat(21) })).status, 422);
  const add = await call('POST', '/api/inv/report/measures', { measure: { type: 'operation', fields: { name: '暫存措施', annualSaving: 1, savingCost: 1, investment: 100 } }, reporter: '陳工程師' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const del = await call('DELETE', `/api/inv/report/measures/${add.body.measure.id}?reporter=${encodeURIComponent('陳工程師')}`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.change.who, '陳工程師（測試院所803）');
});

test('R6：省電燈泡依螢光燈具 2 年門檻自動列入（與管理端同一支類別函式）', () => {
  const inv = S.blankInventory();
  inv.equipment = [
    { id: 'eq-cfl', category: 'lighting', kind: '省電燈泡', status: 'active', fields: { name: '走廊省電燈泡', wattPerFixture: 23, qty: 50, madeYear: 2020 } },
    { id: 'eq-hal', category: 'lighting', kind: '鹵素燈', status: 'active', fields: { name: '大廳鹵素燈', wattPerFixture: 50, qty: 10, madeYear: 1990 } },
  ];
  model.materialize(inv, 116);
  assert.ok(inv.measures.some((m) => m.equipmentId === 'eq-cfl'), '省電燈泡 7 年 > 2 年');
  assert.ok(!inv.measures.some((m) => m.equipmentId === 'eq-hal'), '鹵素燈不套門檻');
  const v = model.measureView(inv.measures[0], inv, 116);
  assert.equal(v.replaceCategory, '螢光燈具');
});
