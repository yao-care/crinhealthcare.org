// 匯出與年度資料的 API（工作清單 24）。report-routes.js 的 handleReport 解析完操作人後分派過來：
//   handleExport({ req, res, sess, head, id, q, body, A, json, readInventory, today }) → truthy＝已處理，null＝不是這裡的路徑
//
//   GET  /api/inv/report/table?year=N                         表清單（tableId、章節、待補數）
//   GET  /api/inv/report/table/:tableId?year=N&format=xlsx|csv|json
//   GET  /api/inv/report/bundle?year=N                        整包 zip（每張表 CSV＋三本 xlsx＋節能計畫匯出檔）
//   GET  /api/inv/report/filing?year=N                        申報對照頁（依附表三章節順序的欄位：值、待補與填寫處）
//   GET  /api/inv/report/plan-export?format=xlsx|csv          節能計畫匯出檔（＝table/a2-export）
//   GET  /api/inv/report/annual?year=N                        年度報表資料（N 與 N-1）＋欄位規格＋可選的電號／建築／人員／鍋爐
//   PUT  /api/inv/report/annual/:block?year=N  { value }      存一個年度區塊
//   GET  /api/inv/report/carryover?year=N                     年度沿用：逐區塊與 N-1 年的差異、確認狀態
//   POST /api/inv/report/carryover/:unit?year=N { copy?, expectHash? }   確認（copy＝年度區塊沿用 N-1 年值）
import { mutateInventory, newId } from './inventory-store.js';
import { buildTable, tableXlsx, toCsv, buildBundle, filingView, tableList } from './report-export.js';
import { annualSpec, annualOf, validateAnnualBlock, annualBlockById, refOptions, carryoverView, confirmUnit, carryUnitById } from './report-annual.js';
import { todayIso } from './report-model.js';

// mutator 裡丟這個＝不寫檔，直接回錯誤
class Refuse extends Error { constructor(status, body) { super(body.error); this.status = status; this.body = body; } }
async function mutate(res, json, hid, fn, meta) {
  try { return await mutateInventory(hid, fn, meta); }
  catch (e) { if (e instanceof Refuse) { json(res, e.status, { ok: false, ...e.body }); return null; } throw e; }
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function send(res, buf, type, filename) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, no-store',
  });
  res.end(buf);
  return true;
}

// 資料年 N（民國）：沒給＝去年（1 月申報前一年資料）
export const defaultYear = (today = todayIso()) => Number(today.slice(0, 4)) - 1912;
function yearOf(q, today) {
  const y = q.get('year');
  if (y === null || y === '') return { N: defaultYear(today) };
  if (!/^\d{2,3}$/.test(y)) return { error: true };
  return { N: Number(y) };
}

export async function handleExport({ res, sess, method, head, id, q, body, A, json, readInventory, today = todayIso() }) {
  const GET = method === 'GET';
  const ROUTES = new Set(['table', 'bundle', 'filing', 'plan-export', 'annual', 'carryover']);
  if (!ROUTES.has(head)) return null;
  const y = yearOf(q, today);
  if (y.error) return json(res, 400, { ok: false, error: 'bad_year', message: '資料年請填民國年，例：114' });
  const N = y.N;
  const hid = sess.hid;
  const opts = { year: N, today, hospitalName: sess.name };

  if (GET && head === 'table' && !id) {
    const inv = await readInventory(hid);
    return json(res, 200, { ok: true, year: N, tables: tableList(inv, opts) });
  }
  if (GET && (head === 'table' || head === 'plan-export')) {
    const inv = await readInventory(hid);
    const bt = buildTable(inv, head === 'plan-export' ? 'a2-export' : id, opts);
    if (!bt) return json(res, 404, { ok: false, error: 'unknown_table' });
    const fmt = q.get('format') || 'xlsx';
    if (fmt === 'json') return json(res, 200, { ok: true, table: bt.table, sheets: bt.sheets.map((s) => ({ name: s.name, rows: s.rows.map((r) => r.map((c) => c?.v ?? '')) })), missing: bt.missing });
    if (fmt === 'csv') return send(res, toCsv(bt.raw ? [bt.sheets[0]] : bt.sheets), 'text/csv; charset=utf-8', `${bt.filename}.csv`);
    if (fmt === 'xlsx') return send(res, tableXlsx(bt), XLSX, `${bt.filename}.xlsx`);
    return json(res, 400, { ok: false, error: 'bad_format', message: 'format 須為 xlsx、csv 或 json' });
  }
  if (GET && head === 'bundle' && !id) {
    const inv = await readInventory(hid);
    const b = buildBundle(inv, opts);
    return send(res, b.buffer, 'application/zip', b.filename);
  }
  if (GET && head === 'filing' && !id) {
    const inv = await readInventory(hid);
    return json(res, 200, { ok: true, ...filingView(inv, opts) });
  }

  // ── 年度報表資料 ──
  if (head === 'annual') {
    if (GET && !id) {
      const inv = await readInventory(hid);
      return json(res, 200, { ok: true, year: N, spec: annualSpec, data: annualOf(inv, N), prev: annualOf(inv, N - 1), meta: inv.annual?.[N]?._meta || {}, refs: refOptions(inv) });
    }
    if (method === 'PUT' && id) {
      if (!annualBlockById(id)) return json(res, 404, { ok: false, error: 'unknown_block' });
      const r = await mutate(res, json, hid, (inv) => {
        const v = validateAnnualBlock(id, body.value, newId, inv);
        if (!v.ok) throw new Refuse(422, { error: 'validation', details: v.errors, warnings: v.warnings });
        inv.annual ||= {};
        inv.annual[N] ||= {};
        inv.annual[N][id] = v.value;
        inv.annual[N]._meta ||= {};
        inv.annual[N]._meta[id] = { at: new Date().toISOString(), who: A.who, reporter: A.reporter };
        return { value: v.value, warnings: v.warnings };
      }, { who: A.who, what: `年度報表資料 ${N} ${id}` });
      if (!r) return true;
      return json(res, 200, { ok: true, year: N, block: id, ...r.result, commit: r.commit });
    }
  }

  // ── 年度沿用 ──
  if (head === 'carryover') {
    if (GET && !id) {
      const inv = await readInventory(hid);
      return json(res, 200, { ok: true, ...carryoverView(inv, N) });
    }
    if (method === 'POST' && id) {
      if (!carryUnitById(id)) return json(res, 404, { ok: false, error: 'unknown_unit' });
      const r = await mutate(res, json, hid, (inv) => {
        const x = confirmUnit(inv, N, id, A, { copy: body.copy === true, expectHash: typeof body.expectHash === 'string' ? body.expectHash : undefined });
        if (x.error === 'changed') throw new Refuse(409, { error: 'changed', message: '這個區塊在你看過之後又被修改，請重新整理看差異再確認', hash: x.hash });
        if (x.error) throw new Refuse(422, { error: x.error, message: { nothing_to_copy: 'N-1 年這個區塊沒有資料可沿用', not_empty: 'N 年已有資料，不能整份覆蓋；請直接確認或到報表資料輸入修改', copy_not_supported: '初始建檔與設備主檔本來就延續，直接確認即可' }[x.error] || x.error });
        return x;
      }, { who: A.who, what: `${N} 年沿用確認 ${id}${body.copy ? '（沿用 N-1 年）' : ''}` });
      if (!r) return true;
      return json(res, 200, { ok: true, year: N, ...r.result, commit: r.commit });
    }
  }
  return null;
}
