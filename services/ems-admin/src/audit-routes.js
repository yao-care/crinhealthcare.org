// 電力健檢填報的 API 路由。抽成獨立檔，server.js 只負責分派，才不會又長成一支大檔。
//
// 送出的兩道門，順序不能對調：
//   1. 還有 todo/low 的格子 → 409 擋下（解析結果沒複驗完不准送）
//   2. 六條自我檢核沒勾滿 → 409 擋下（附件三要求，也對上附件二階段 5 的完成條件）
// 通過之後才寫檔，寫檔成功再同步看板；看板同步失敗不影響填報已存的事實。
import { auditSpec, validateAudit, pendingCells, blockStats, SELF_CHECK, blockById } from './audit-schema.js';
import { readAudit, saveAudit, auditHistory, removeUpload, readUpload } from './audit-store.js';
import { readRawBody, parseMultipart, storeUpload, classify } from './upload-io.js';
import { extractFile, extractionEnabled } from './extract.js';
import { syncToBoard } from './board-sync.js';
import { config } from './config.js';

// 附件二九階段：哪一階段完成，由實際資料推導，不讓人手動勾（手動勾的進度一定會漂）
function stageState(audit, history) {
  const st = blockStats(audit);
  // 「已送出」的判準是自我檢核簽章，不是 git 有沒有 commit——
  // 上傳一個檔案也會產生 commit，用 history.length 會把「系統填報」提早點亮。
  const submitted = Boolean(audit.selfCheck?.at);
  const done = {
    notice: true,
    account: true,                                    // 人已經登入了
    contact: st.contact.rows > 0 && st.contact.missing === 0,
    prepare: (audit.files || []).length > 0 || st.bills.rows > 0,
    fill: submitted,
    review: submitted && pendingCells(audit).length === 0
      && Object.values(st).every((s) => s.missing === 0),
    analyze: false, report: false, followup: false,   // 專案執行單位的階段，本系統看不到
  };
  const order = ['notice', 'contact', 'account', 'prepare', 'fill', 'review', 'analyze', 'report', 'followup'];
  const current = order.find((k) => !done[k]) || 'followup';
  return { done, current };
}

// history 目前只用來顯示，不參與階段判定（見上面的註解）
const summarize = (audit, history) => ({
  stats: blockStats(audit),
  pending: pendingCells(audit),
  stages: stageState(audit, history),
});

export async function handleAudit({ req, res, sess, pathname, json, readBody, originOk }) {
  const hid = sess.hid;

  // 欄位規格：前端據此長出所有表單與表格
  if (req.method === 'GET' && pathname === '/api/audit/spec') {
    return json(res, 200, { ok: true, spec: auditSpec, extraction: extractionEnabled(), maxBytes: config.uploadMaxBytes });
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    const audit = await readAudit(hid);
    const history = await auditHistory(hid);
    return json(res, 200, { ok: true, hid, audit, history, ...summarize(audit, history) });
  }

  if (req.method === 'GET' && pathname === '/api/audit/history') {
    return json(res, 200, { ok: true, items: await auditHistory(hid) });
  }

  // 佐證檔案下載／檢視。附件三要求檔名可辨識，所以用中文的 displayName 回去。
  if (req.method === 'GET' && pathname === '/api/audit/file') {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const audit = await readAudit(hid);
    const f = (audit.files || []).find((x) => x.id === id);
    if (!f) return json(res, 404, { ok: false, error: 'file_not_found' });
    try {
      const buf = await readUpload(hid, f.storedName);
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Content-Length': buf.length,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.displayName)}`,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    } catch { return json(res, 404, { ok: false, error: 'file_missing_on_disk' }); }
  }

  // ── 上傳佐證檔案 → 立刻解析 ──
  // 檔案本身立刻入帳（它是既成事實），解析出來的值只回給前端當「提案」，
  // 要院方逐格複驗後隨著送出才會寫進資料。
  if (req.method === 'POST' && pathname === '/api/audit/upload') {
    if (!originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return json(res, 400, { ok: false, error: 'expect_multipart' });

    let parts;
    try { parts = parseMultipart(await readRawBody(req, config.uploadMaxBytes + 64 * 1024), ct); }
    catch (e) { return json(res, String(e.message) === 'payload_too_large' ? 413 : 400, { ok: false, error: String(e.message || e) }); }

    const field = (n) => parts.find((p) => p.name === n && !p.filename)?.data?.toString('utf8') || '';
    const filePart = parts.find((p) => p.filename && p.data?.length);
    const blockId = field('block');
    const block = blockById(blockId);
    if (!block) return json(res, 400, { ok: false, error: 'unknown_block' });
    if (!filePart) return json(res, 400, { ok: false, error: 'no_file' });
    if (!classify(filePart.contentType, filePart.filename)) {
      return json(res, 415, { ok: false, error: 'unsupported_type', message: '只接受 PDF、JPG/PNG/WebP 影像、xlsx 或 csv' });
    }

    let file;
    try {
      file = await storeUpload(hid, blockId, {
        filename: filePart.filename, contentType: filePart.contentType, data: filePart.data, period: field('period'),
      });
    } catch (e) {
      const code = e.code === 'too_large' ? 413 : 415;
      return json(res, code, { ok: false, error: e.code || 'store_failed' });
    }

    // 解析（可能失敗：沒設 key、模型拒絕、範本工作表對不上）。
    // 失敗不回滾檔案——檔案已經上傳成功，院方可以改用人工填寫。
    let result = null, parseError = null;
    try {
      result = await extractFile(blockId, file, filePart.data);
      file.parse = { state: 'done', at: new Date().toISOString(), ...result.stats, notes: result.notes };
    } catch (e) {
      parseError = { code: e.code || 'extract_failed', message: String(e.message || e) };
      file.parse = { state: 'failed', at: new Date().toISOString(), ...parseError };
    }

    const audit = await readAudit(hid);
    audit.files = [...(audit.files || []), file];
    await saveAudit(hid, audit, { who: `${sess.name || sess.sub}·上傳 ${file.displayName}` });

    return json(res, 200, {
      ok: true, file,
      rows: result?.rows || [], notes: result?.notes || '', stats: result?.stats || null,
      parseError,
    });
  }

  // 刪除佐證檔案（連同磁碟上的檔案）。已經填進表格的值不會跟著消失——
  // 那些值院方可能已經複驗過了，跟著刪只會讓人白做一次。
  if (req.method === 'POST' && pathname === '/api/audit/file/delete') {
    if (!originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
    const { id } = await readBody(req);
    const audit = await readAudit(hid);
    const f = (audit.files || []).find((x) => x.id === id);
    if (!f) return json(res, 404, { ok: false, error: 'file_not_found' });
    await removeUpload(hid, f.storedName).catch(() => {});
    audit.files = (audit.files || []).filter((x) => x.id !== id);
    await saveAudit(hid, audit, { who: `${sess.name || sess.sub}·刪除 ${f.displayName}` });
    return json(res, 200, { ok: true });
  }

  // ── 送出填報 ──
  if (req.method === 'POST' && pathname === '/api/audit') {
    if (!originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
    const body = await readBody(req, 8 * 1024 * 1024);
    const incoming = body?.audit;
    if (!incoming || typeof incoming !== 'object') return json(res, 400, { ok: false, error: 'missing_audit' });

    // 佐證檔案清單以伺服器上的為準：前端不該有權改它（它對應磁碟上真實存在的檔案）
    const current = await readAudit(hid);
    const audit = { ...incoming, files: current.files || [], version: 1 };

    const v = validateAudit(audit);
    if (!v.ok) return json(res, 422, { ok: false, error: 'validation', details: v.errors, warnings: v.warnings });

    const pending = pendingCells(audit);
    if (pending.length) {
      return json(res, 409, {
        ok: false, error: 'unverified',
        pending: pending.slice(0, 200), total: pending.length,
        message: `還有 ${pending.length} 個格子沒有複驗，解析出來的值不能直接送出。`,
      });
    }

    const checked = Array.isArray(body?.selfCheck) ? body.selfCheck : [];
    const missingCheck = SELF_CHECK.map((_, i) => i).filter((i) => !checked.includes(i));
    if (missingCheck.length) {
      return json(res, 409, {
        ok: false, error: 'self_check',
        missing: missingCheck, items: SELF_CHECK,
        message: `送出前自我檢核還有 ${missingCheck.length} 項未確認。`,
      });
    }
    audit.selfCheck = { at: new Date().toISOString(), by: sess.name || sess.sub, items: SELF_CHECK };

    let saved;
    try { saved = await saveAudit(hid, audit, { who: sess.name || sess.sub }); }
    catch (e) { return json(res, 500, { ok: false, error: 'save_failed', message: String(e.message || e) }); }

    // 送出即同步看板（業主指示）。同步是衍生動作，失敗只回報，不推翻已存好的填報。
    const sync = await syncToBoard(hid, audit, { who: sess.name || sess.sub });

    const history = await auditHistory(hid);
    return json(res, 200, { ok: true, ...saved, sync, warnings: v.warnings, ...summarize(audit, history) });
  }

  return null;   // 不是健檢路由 → 交回 server.js 繼續比對
}
