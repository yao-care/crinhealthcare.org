// 電力健檢填報的回歸測試。
//
// 蓋住的是「壞掉會很難發現」的那幾件事：
//   - 計算欄位兩邊（伺服器/瀏覽器）算出來的值必須一致（共用 public/audit-compute.js）
//   - 複驗閘門：解析出來的值不能被當成已確認
//   - 看板同步只換自己那幾個面板，不准動到院方手寫的內容
//   - xlsx 匯入要接得回 V2 範本的座標（表A/表E/表P）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../public/audit-compute.js';
import { BLOCKS, fieldsOf, coerce, validateAudit, pendingCells, blockStats, blankAudit, SELF_CHECK, STAGES } from '../src/audit-schema.js';
import { buildPanels, mergePanels, PANEL_PREFIX } from '../src/board-sync.js';
import { parseMultipart, suggestName, classify } from '../src/upload-io.js';
import { extractFile } from '../src/extract.js';
import { exportAudit } from '../src/audit-io.js';

const CALC = globalThis.EMSAuditCompute;
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'energy-audit-v2.xlsx');

// ── 欄位表本身 ──
test('每個欄位都有中文標籤與型別（漏了前端會出現空白標題）', () => {
  const types = new Set(['text', 'number', 'percent', 'month', 'date', 'select']);
  for (const b of BLOCKS) {
    assert.ok(b.label && b.icon && b.attachment, `區塊 ${b.id} 缺少 label/icon/attachment`);
    for (const f of fieldsOf(b)) {
      assert.ok(f.label && /[一-鿿]/.test(f.label), `${b.id}.${f.key} 沒有中文標籤`);
      assert.ok(types.has(f.type), `${b.id}.${f.key} 型別不合法：${f.type}`);
      assert.ok(!(f.computed && f.required), `${b.id}.${f.key} 是計算欄位就不該標必填`);
    }
    const keys = fieldsOf(b).map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, `${b.id} 有重複的欄位鍵`);
  }
});

test('公文的三份附件都被涵蓋到，九階段與六條檢核完整', () => {
  assert.ok(BLOCKS.some((b) => b.attachment === '附件一'), '缺附件一（聯絡人）');
  assert.equal(BLOCKS.filter((b) => b.attachment === '附件三').length, 6, '附件三應有 6 個填報區塊');
  assert.equal(STAGES.length, 9, '附件二是九階段');
  assert.equal(SELF_CHECK.length, 6, '附件三的自我檢核是六條');
  // 聯絡人是個資，必須標記為不同步
  assert.equal(BLOCKS.find((b) => b.id === 'contact').private, true);
});

// ── 值的正規化 ──
test('coerce 收得住解析器常見的髒值', () => {
  assert.equal(coerce('1,234.5 kWh', 'number'), 1234.5);
  assert.equal(coerce('NT$3,872,510', 'number'), 3872510);
  // 電費單上是民國年。模型被要求換算，但原樣回來也很常見，coerce 再兜一層
  assert.equal(coerce('114年3月', 'month'), '2025-03');
  assert.equal(coerce('2026-03', 'month'), '2026-03');
  assert.equal(coerce('2026/3/5', 'date'), '2026-03-05');
  assert.equal(coerce('114/3/5', 'date'), '2025-03-05');
  assert.equal(coerce('', 'text'), undefined);
  assert.equal(coerce('  台電  ', 'text'), '台電');
  assert.equal(coerce('abc', 'number'), undefined);
});

// ── 計算欄位 ──
test('計算欄位：合計度數、最高需量、推估年用電量', () => {
  const cols = BLOCKS.find((b) => b.id === 'bills').columns;
  const got = CALC.computeRow(cols, {
    usePeak: 100, useHalfPeak: 50, useSatHalfPeak: 5, useOffPeak: 25,
    demandPeak: 400, demandHalfPeak: 380, demandOffPeak: 200,
  });
  assert.equal(got.useTotal, 180);
  assert.equal(got.maxDemand, 400);

  const loads = BLOCKS.find((b) => b.id === 'majorLoads').columns;
  // 負載率是百分比：100kW × 2 台 × 60% × 5000hr = 600,000 kWh
  assert.equal(CALC.computeRow(loads, { ratedKw: 100, qty: 2, loadPct: 60, hoursPerYear: 5000 }).annualKwh, 600000);
  // product 缺一項就算不出來——不能把缺的當 1 算，那會生出一個看起來合理的假數字
  assert.equal(CALC.computeRow(loads, { ratedKw: 100, qty: 2, loadPct: 60 }).annualKwh, undefined);
});

test('直欄合計把計算欄位也算進去', () => {
  const cols = BLOCKS.find((b) => b.id === 'bills').columns;
  const rows = [
    { values: { usePeak: 100, useOffPeak: 100, feeTotal: 1000, demandPeak: 300 } },
    { values: { usePeak: 200, useOffPeak: 200, feeTotal: 2000, demandPeak: 500 } },
  ];
  const t = CALC.computeTotals(cols, rows);
  assert.equal(t.useTotal, 600);
  assert.equal(t.feeTotal, 3000);
  assert.equal(t.maxDemand, 500);       // 最高需量取 max 不是 sum
});

// ── 複驗閘門 ──
test('解析出來的值一定是待複驗，複驗完才算數', () => {
  const a = blankAudit();
  a.blocks.bills.rows = [{
    values: { period: '2026-03', usePeak: 1 },
    meta: { period: { state: 'todo' }, usePeak: { state: 'low' } },
  }];
  a.blocks.basic.values = { beds: 620 };
  a.blocks.basic.meta = { beds: { state: 'todo' } };
  assert.equal(pendingCells(a).length, 3);

  a.blocks.bills.rows[0].meta.period.state = 'ok';
  a.blocks.bills.rows[0].meta.usePeak.state = 'manual';
  a.blocks.basic.meta.beds.state = 'ok';
  assert.equal(pendingCells(a).length, 0);
});

test('blockStats 算得出待複驗、必填缺漏與筆數', () => {
  const a = blankAudit();
  a.blocks.bills.rows = [{ values: { period: '2026-03' }, meta: { period: { state: 'todo' } } }];
  const st = blockStats(a);
  assert.equal(st.bills.rows, 1);
  assert.equal(st.bills.todo, 1);
  assert.ok(st.bills.missing > 0, '電費單有一堆必填還沒填，missing 應該大於 0');
});

// ── 驗證 ──
test('必填漏填只警告不擋；型別與重複月份才是錯誤', () => {
  const a = blankAudit();
  a.blocks.bills.rows = [
    { values: { period: '2026-03', meterNo: 'A1' }, meta: {} },
    { values: { period: '2026-03', meterNo: 'A1' }, meta: {} },
  ];
  const v = validateAudit(a);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('重複的計費期間')), v.errors.join('\n'));
  assert.ok(v.warnings.length > 0, '沒填的必填欄位應該出現在 warnings 而不是 errors');

  a.blocks.bills.rows[1].values.period = '2026-04';
  assert.equal(validateAudit(a).ok, true);

  a.blocks.bills.rows[0].values.feeTotal = -5;
  assert.ok(validateAudit(a).errors.some((e) => e.includes('不可為負數')));

  a.blocks.bills.rows[0].values.feeTotal = 5;
  a.blocks.bills.rows[0].values.period = '2026/03';
  assert.ok(validateAudit(a).errors.some((e) => e.includes('YYYY-MM')));
});

test('聯絡人的電子郵件格式會被擋下', () => {
  const a = blankAudit();
  a.blocks.contact.values = { primaryEmail: '不是信箱' };
  assert.ok(validateAudit(a).errors.some((e) => e.includes('電子郵件')));
  a.blocks.contact.values.primaryEmail = 'a@b.tw';
  assert.equal(validateAudit(a).errors.filter((e) => e.includes('電子郵件')).length, 0);
});

// ── 看板同步 ──
function sampleAudit() {
  const a = blankAudit();
  a.blocks.bills.rows = [
    { values: { period: '2026-03', usePeak: 100, useOffPeak: 100, feeTotal: 1000, demandPeak: 300, contractCapacity: 500 }, meta: {} },
    { values: { period: '2026-04', usePeak: 200, useOffPeak: 200, feeTotal: 2000, demandPeak: 400, contractCapacity: 500 }, meta: {} },
  ];
  a.blocks.emissions.rows = [{ values: { emission: 12.5 }, meta: {} }];
  return a;
}

test('看板同步只產生彙總，個資與原始列不在其中', () => {
  const a = sampleAudit();
  a.blocks.contact.values = { primaryName: '王小明', primaryPhone: '02-12345678', primaryEmail: 'a@b.tw' };
  const panels = buildPanels(a);
  const dump = JSON.stringify(panels);
  for (const secret of ['王小明', '02-12345678', 'a@b.tw']) {
    assert.ok(!dump.includes(secret), `個資「${secret}」不該出現在看板面板裡`);
  }
  assert.ok(dump.includes('600'), '總用電量 600 度應該在彙總裡');
  assert.ok(panels.every((p) => p.id.startsWith(PANEL_PREFIX)));
  assert.equal(panels.find((p) => p.id.endsWith('-monthly')).cols.length, 2);
});

test('同步只換自己的面板，院方手寫的面板一律不動', () => {
  const hospital = {
    name: '測試院所',
    esgPanels: [
      { id: 'hand-written', icon: '📝', title: '院方自己維護的面板', cols: [], rows: [] },
      { id: `${PANEL_PREFIX}-summary`, icon: '🔌', title: '舊的彙總', cols: [], rows: [] },
    ],
    env: { carbon: { title: '碳盤查 2025', cols: [], rows: [{ label: '整體用電', cells: ['約 1,266 萬度'] }] } },
  };
  const next = mergePanels(hospital, buildPanels(sampleAudit()));
  const ids = next.esgPanels.map((p) => p.id);
  assert.ok(ids.includes('hand-written'), '院方手寫面板被弄丟了');
  assert.equal(ids.filter((i) => i === `${PANEL_PREFIX}-summary`).length, 1, '舊的彙總面板應該被換掉而不是變兩個');
  assert.deepEqual(next.env, hospital.env, 'env.carbon 是人寫的內容，同步不該碰');
  assert.notEqual(next, hospital, 'mergePanels 應該回新物件，不要就地改');
});

test('沒有可同步的數字時，面板整個移除而不是留一個空殼', () => {
  const next = mergePanels({ name: 'x', esgPanels: [{ id: `${PANEL_PREFIX}-summary`, icon: '🔌', title: '舊', cols: [], rows: [] }] }, buildPanels(blankAudit()));
  assert.equal(next.esgPanels, undefined);
});

// ── 上傳 ──
test('multipart 解析得出檔案與文字欄位', () => {
  const b = '----X';
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="block"\r\n\r\nbills\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x0d, 0x1a]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const parts = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(parts.find((p) => p.name === 'block').data.toString(), 'bills');
  const f = parts.find((p) => p.filename);
  assert.equal(f.filename, 'a.pdf');
  assert.equal(f.contentType, 'application/pdf');
  assert.deepEqual([...f.data], [0x25, 0x50, 0x44, 0x46, 0x00, 0x0d, 0x1a], '二進位內容不可被改動');
});

test('檔名照附件三要求正規化成 院所_資料類型_年月', () => {
  assert.equal(suggestName('807', 'bills', '2026-03', '.pdf'), '807_電費單_202603.pdf');
  assert.match(suggestName('807', 'emissions', '', '.xlsx'), /^807_排放源清單_\d{6}\.xlsx$/);
});

test('型別白名單：xlsx 用副檔名也認得，未知型別擋下', () => {
  assert.equal(classify('application/pdf', 'x.pdf').kind, 'pdf');
  assert.equal(classify('application/octet-stream', '用電統計.xlsx').kind, 'xlsx');
  assert.equal(classify('application/x-msdownload', 'evil.exe'), null);
});

// ── xlsx 匯入 → 區塊 ──
test('V2 範本匯入接得回表E（重大設備）與表A（冰水主機）', async () => {
  const template = readFileSync(TEMPLATE);
  const { buffer } = exportAudit(template, {
    inventory: [{ system: '空調', name: '冰水主機A', deviceNo: 'CH-01', madeYear: '2015', capacity: 200, capacityUnit: 'RT', ratedKw: 140, qty: 1, loadPct: 60, hoursPerYear: 5000 }],
    chillers: [{ systemName: '主院區', deviceNo: 'CH-01', capacityRt: '200', age: '10', originType: '日本/離心式/變頻', maintenance: '良好（例行確實）', roomTemp: 26, roomHumidity: 55 }],
  });
  const file = { id: 'f1', displayName: 't.xlsx', kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

  const loads = await extractFile('majorLoads', file, buffer);
  assert.equal(loads.rows.length, 1);
  assert.equal(loads.rows[0].values.name, '冰水主機A');
  assert.equal(loads.rows[0].values.loadPct, 60);
  assert.equal(loads.rows[0].meta.name.state, 'todo', 'xlsx 匯入的值一樣要複驗');

  const ch = await extractFile('chillers', file, buffer);
  assert.equal(ch.rows[0].values.systemName, '主院區');
  assert.equal(ch.rows[0].values.roomHumidity, 55);
});

test('V2 範本的用電統計沒有年份，匯入時要標成信心低', async () => {
  const template = readFileSync(TEMPLATE);
  const { buffer } = exportAudit(template, {
    power: { meterNo: '01-23-4567-89-0', tariff: '高壓', timeType: '三段式',
      months: [{ month: 3, contractCapacity: 500, usePeak: 100, useOffPeak: 100, totalFee: 1000 }] },
  });
  const file = { id: 'f2', displayName: 'p.xlsx', kind: 'xlsx' };
  const r = await extractFile('bills', file, buffer);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].values.meterNo, '01-23-4567-89-0', '表頭的電號要複製到每一列');
  assert.equal(r.rows[0].meta.period.state, 'low', '年份是推算的，必須標信心低');
  assert.ok(r.notes.includes('年份'), '要提醒院方年份是推算的');
});

test('沒有對應工作表的區塊，匯入 xlsx 要給看得懂的錯誤', async () => {
  const template = readFileSync(TEMPLATE);
  await assert.rejects(
    () => extractFile('events', { id: 'f3', displayName: 'x.xlsx', kind: 'xlsx' }, template),
    /沒有對應的 Excel 範本工作表/,
  );
});

test('空白填報的 selfCheck 是 null，不是空陣列', () => {
  // 為什麼要釘住：階段判定用 `audit.selfCheck?.at` 判斷「已送出」，
  // 而 [].at 是 Array.prototype.at（函式，truthy）——用空陣列會讓「系統填報」
  // 在院方還沒送出任何東西時就亮燈。實測踩過。
  assert.equal(blankAudit().selfCheck, null);
  assert.equal(typeof [].at, 'function');
  assert.equal(typeof blankAudit().selfCheck?.at, 'undefined');
});

test('費用可為減項的欄位不擋負數（台電的功因調整費真的會是負的）', () => {
  const a = blankAudit();
  a.blocks.bills.rows = [{ values: { period: '2025-03', feePowerFactor: -24530, feeOther: -100 }, meta: {} }];
  assert.equal(validateAudit(a).errors.filter((e) => e.includes('不可為負數')).length, 0);
  // 沒開放的費用欄仍然要擋
  a.blocks.bills.rows[0].values.feeBasic = -1;
  assert.ok(validateAudit(a).errors.some((e) => e.includes('基本費') && e.includes('不可為負數')));
});

test('API 錯誤翻成院方看得懂的中文，不把英文原文丟到畫面上', async () => {
  // friendly() 沒有 export（它是 extractWithModel 的內部細節），這裡從行為驗：
  // 沒設 key 時走的是另一條分支，訊息一樣必須是中文且說得出下一步。
  const { extractFile } = await import('../src/extract.js');
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    const err = await extractFile('bills', { id: 'x', displayName: 'a.pdf', kind: 'pdf', mime: 'application/pdf' }, Buffer.from('x'))
      .then(() => null, (e) => e);
    if (err) {
      assert.ok(/[一-鿿]/.test(err.message), `訊息要是中文，實際：${err.message}`);
      assert.ok(!/Schemas|union types|invalid_request_error/i.test(err.message), '不可以把英文 API 原文丟給院方');
    }
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});
