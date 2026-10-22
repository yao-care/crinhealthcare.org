// 能源盤點（貼紙點位＋三類填報）的 API 路由。server.js 只負責分派到這裡。
//
// 每一條都先做兩件事，順序不能省：
//   1. 路徑裡的點位代碼切出 hid，跟 session.hid 比對 → 不符 403。
//      貼紙貼在走廊上，任何人都拍得到別家醫院的代碼；不能因為猜到代碼就讀寫別家資料。
//   2. 改變狀態的請求做 originOk（SameSite=Strict 之外的 CSRF 第二層）。
//
// 送出點位紀錄的三道門：
//   422 格式不對／必填沒填／讀數倒退（倒退可帶 confirmDecrease 確認是換表或歸零）
//   409 電費單還有沒逐格確認的格子（沿用健檢填報的複驗閘門，伺服器這份判準才算數）
//   200 照存，用量差超過 warnPct 只回 warnings 不擋（用量本來就會變，擋了只會逼人亂填）
import QRCode from 'qrcode';
import { config } from './config.js';
import {
  inventorySpec, parseCode, makeCode, validatePoint, validateSiteBlock, validateEquipment, assessRecord,
  itemOptions, siteBlockById, CHANGE_KINDS, ANOMALY_VALUE, RE_PHOTO_ID, SOURCES, lastValue,
  REPORTER_MAX, parseReporter, whoLabel, linkedItemsOf, equipmentLinkIssues, siteRefIssues,
} from './inventory-schema.js';
import '../public/inventory-compute.js';   // 副作用：掛上 globalThis.EMSInventoryCompute（與貼紙頁共用同一份用量計算）
import {
  readInventory, mutateInventory, newId, storePhoto, findPhoto, readPhoto, photoMime, inventoryHistory,
} from './inventory-store.js';
import { readRawBody, parseMultipart } from './upload-io.js';
import { handlePointsImport } from './points-import.js';
import { extractFile, extractionEnabled } from './extract.js';

const RE_MONTH = /^\d{4}-\d{2}$/;

// 用量判定走 public/inventory-compute.js（瀏覽器與伺服器同一份）。
// assessRecord 只負責格式、必填、狀態、電費單複驗；把這個點位自己的歷史拿掉餵它，
// 它就不會自己算用量。上次值仍逐項目找「最近一筆有數值」的紀錄（有些紀錄只填部分項目）。
// 回傳 { usage, warnings, decreases }，decreases 的形狀即 422 reading_decreased 的 details。
export function readingAssessment(point, records, values, confirmDecrease = []) {
  const C = globalThis.EMSInventoryCompute;
  const items = point.items.filter((it) => it.type === 'reading' && typeof values[it.id] === 'number');
  const prevs = {};
  const prev = { values: {}, usage: {} };
  for (const it of items) {
    const pv = lastValue(records, point.code, it.id);
    if (!pv) continue;
    prevs[it.id] = pv;
    prev.values[it.id] = pv.value;
    if (typeof pv.usage === 'number') prev.usage[it.id] = pv.usage;
  }
  const u = C.recordUsage(items, values, prev);
  const usage = {}, warnings = [], decreases = [];
  for (const it of items) {
    const r = u.results[it.id];
    const pv = prevs[it.id];
    if (r.rollback) {
      if (confirmDecrease.includes(it.id)) { usage[it.id] = null; warnings.push(`「${it.label}」讀數比上次小，已依確認視為換表或歸零，本次不計用量`); continue; }
      decreases.push({
        itemId: it.id, label: it.label, prev: pv.value, prevAt: pv.at, value: values[it.id],
        message: `「${it.label}」本次讀數 ${values[it.id]} 小於上次 ${pv.value}（${pv.period}）。請確認是否抄錯；若是換表或歸零，請勾選確認後再送出。`,
      });
      continue;
    }
    usage[it.id] = typeof r.value === 'number' ? r.value : null;   // 首次抄表 → null
    if (r.level === 'warn') warnings.push(r.msg);
  }
  return { usage, warnings, decreases };
}

// 期別一律用台灣時間：月底晚上 11 點抄的表不該被算到下個月
export function currentPeriod(now = Date.now()) {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 7);
}
export function nextPeriod(p) {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export const pointUrl = (code) => `${config.publicBaseUrl}/s/${encodeURIComponent(code)}`;

// 在 mutateInventory 裡丟這個 → 不寫檔，直接回對應的狀態碼
class HttpErr extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

const who = (sess) => sess.name || sess.sub;
// 帳號一院一組，who 只看得到院名；請求帶 reporter（操作人／填寫人姓名）→ who＝「姓名（院名）」，另存 reporter。
// 貼紙頁送紀錄、管理端各種修改都走這一個（規則在 inventory-schema.js 的 parseReporter）。
export { REPORTER_MAX };
export const actorOf = (sess, reporter) => ({ who: whoLabel(who(sess), reporter), reporter: reporter || null });
const isEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);

// 貼紙頁頁尾那一行依據（工作清單第 21 項：貼紙頁只放一行）
function pointSource(point) {
  const types = new Set(point.items.map((i) => i.type));
  // 水類點位：ISO 14046 5.3 水足跡盤查、ISO 46001 9.1 監測量測（docs/water-footprint-spec.md；非附表三申報欄位）
  const text = point.domain === 'water'
    ? '依據：ISO 14046 5.3 水足跡盤查、ISO 46001 9.1 監測與量測（院內紀錄，非附表三申報欄位）'
    : `依據：能源查核制度申報表 附表三${types.has('reading') || types.has('bill') ? ' 表五之二' : ''}${types.has('status') ? '、表九之五' : ''}（${SOURCES.LAW_ANNEX3}）`;
  return { doc: point.domain === 'water' ? 'ISO 14046:2014／ISO 46001:2019' : '附表三', ...(point.domain === 'water' ? { ref: '5.3／9.1' } : {}), law: point.domain === 'water' ? undefined : SOURCES.LAW_ANNEX3, text };
}

// 點位對外的樣子：補上解析後的狀態選項、設備名稱與電號（貼紙頁只顯示設備名稱，型號容量不出現）
function pointView(inv, point) {
  const eqName = (id) => inv.equipment.find((e) => e.id === id)?.fields?.name || null;
  const meterNo = (id) => (inv.site.meters || []).find((m) => m.id === id)?.meterNo || null;
  const items = point.items.map((it) => {
    const last = latestFor(inv.records, point.code, it.id);
    return {
      ...it,
      ...(it.type === 'status' ? { options: itemOptions(it) } : {}),
      equipmentName: it.equipmentId ? eqName(it.equipmentId) : undefined,
      ...(it.meterId ? { meterNo: meterNo(it.meterId) } : {}),
      last: last && { value: it.type === 'bill' ? undefined : last.values[it.id], usage: last.usage?.[it.id] ?? null, at: last.at, period: last.period },
    };
  });
  return { code: point.code, domain: point.domain, name: point.name, location: point.location, active: point.active, items, url: pointUrl(point.code) };
}

function latestFor(records, code, itemId) {
  let best = null;
  for (const r of records) {
    if (r.pointCode !== code || r.values?.[itemId] === undefined) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best;
}

function openAnomalies(inv) {
  const out = [];
  for (const r of inv.records) {
    for (const a of r.anomalies || []) {
      if (a.closedAt) continue;
      const p = inv.points.find((x) => x.code === r.pointCode);
      out.push({ ...a, recordId: r.id, pointCode: r.pointCode, pointName: p?.name || r.pointCode, period: r.period, reportedBy: r.who });
    }
  }
  return out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

function progress(inv, period) {
  const points = inv.points.filter((p) => p.active !== false).map((p) => {
    const recs = inv.records.filter((r) => r.pointCode === p.code && r.period === period);
    const last = recs.reduce((m, r) => (!m || r.at > m.at ? r : m), null);
    return { code: p.code, name: p.name, location: p.location, domain: p.domain, recorded: recs.length > 0, records: recs.length, lastAt: last?.at || null, lastBy: last?.who || null };
  });
  return { period, points, total: points.length, done: points.filter((p) => p.recorded).length, openAnomalies: openAnomalies(inv) };
}

// actor＝actorOf(sess, reporter)：{ who, reporter }
function pushChange(inv, actor, { kind, target, before, after, reason, links }) {
  const c = { id: newId('c'), at: new Date().toISOString(), who: actor.who, reporter: actor.reporter, kind, target, before: before ?? null, after: after ?? null, reason: reason || '', ...(links ? { links } : {}) };
  inv.changes.push(c);
  return c;
}

const REASON_REQUIRED = (what) => ({ error: 'reason_required', message: `${what}須填原因（會記進異動登錄）`, details: ['原因必填'] });

// 設備主檔：可比較的樣子（不含時間戳，免得每次修改都多一筆「updatedAt 變了」）
const eqSnapshot = (e) => e && { building: e.building ?? null, category: e.category, kind: e.kind, pointCode: e.pointCode ?? null, status: e.status, replacedBy: e.replacedBy ?? null, fields: e.fields };

export async function handleInventory({ req, res, sess, pathname, json, readBody, originOk }) {
  if (!pathname.startsWith('/api/inv')) return null;
  const hid = sess.hid;
  const m = (re) => re.exec(pathname);
  const GET = req.method === 'GET';
  const POST = req.method === 'POST';
  const PUT = req.method === 'PUT';
  const write = POST || PUT;
  // body 一定是物件：送 null 或陣列進來不該讓後面的 body.x 炸成 500
  const readJson = async (limit) => { const b = await readBody(req, limit); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; };
  if (write && !originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
  // 操作人姓名：格式錯回 null（呼叫端回 422）
  const actorFrom = (body) => { const r = parseReporter(body?.reporter); return r.ok ? actorOf(sess, r.reporter) : null; };
  const badReporter = () => json(res, 422, { ok: false, error: 'validation', details: [`填寫人姓名最長 ${REPORTER_MAX} 字`], message: `填寫人姓名最長 ${REPORTER_MAX} 字` });

  // ── 點位批次匯入（src/points-import.js）：放在代碼比對之前，template.xlsx／import 不是點位代碼 ──
  if (pathname === '/api/inv/points/template.xlsx' || pathname === '/api/inv/points/import') {
    return handlePointsImport({ req, res, sess, pathname, json, readBody, originOk });
  }

  // 路徑帶點位代碼的，一律先比對 hid
  const codeM = /^\/api\/inv\/(?:point|points)\/([^/]+)/.exec(pathname);
  if (codeM) {
    const code = decodeURIComponent(codeM[1]);
    const c = parseCode(code);
    if (!c) return json(res, 400, { ok: false, error: 'bad_code', message: `點位代碼格式錯誤：${code}` });
    if (c.hid !== hid) return json(res, 403, { ok: false, error: 'forbidden_hospital', message: '這張貼紙不屬於您登入的院所，請改用該院帳號登入。' });
  }

  const run = async (fn, meta) => {
    try {
      const r = await mutateInventory(hid, fn, meta);
      return r;
    } catch (e) {
      if (e instanceof HttpErr) { json(res, e.status, { ok: false, ...e.body }); return null; }
      throw e;
    }
  };

  // ── 報表（由 report-routes.js 負責；那支還沒寫就回 501）──
  // 介面：export async function handleReport({ req, res, sess, kind, json, readBody, originOk, readInventory })
  if (pathname.startsWith('/api/inv/report/')) {
    const kind = decodeURIComponent(pathname.slice('/api/inv/report/'.length));
    let mod;
    try { mod = await import('./report-routes.js'); }
    catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('report-routes')) return json(res, 501, { ok: false, error: 'not_implemented', message: '報表產出尚未上線' });
      throw e;
    }
    const handled = await mod.handleReport({ req, res, sess, kind, json, readBody, originOk, readInventory });
    return handled || json(res, 404, { ok: false, error: 'unknown_report' });
  }

  // ── 規格 ──
  if (GET && pathname === '/api/inv/spec') {
    return json(res, 200, { ok: true, spec: inventorySpec, extraction: extractionEnabled(), maxBytes: config.uploadMaxBytes, baseUrl: config.publicBaseUrl });
  }

  // ── 整份資料（管理端）──
  if (GET && pathname === '/api/inv') {
    const inv = await readInventory(hid);
    const history = await inventoryHistory(hid).catch(() => []);
    return json(res, 200, {
      ok: true, hid, hospitalName: inv.site.basic.userName || sess.name, inventory: inv, history, period: currentPeriod(), baseUrl: config.publicBaseUrl,
      // 設備 pointCode 與點位項目 equipmentId 對不上的清單（以點位項目為準）；site ref 對不上的待修清單
      linkIssues: equipmentLinkIssues(inv), siteRefIssues: siteRefIssues(inv),
    });
  }

  // ── 貼紙頁：點位表單 ──
  let mm;
  if (GET && (mm = m(/^\/api\/inv\/point\/([^/]+)$/))) {
    const code = decodeURIComponent(mm[1]);
    const inv = await readInventory(hid);
    const point = inv.points.find((p) => p.code === code);
    if (!point) return json(res, 404, { ok: false, error: 'point_not_found', message: '查無這個點位，請聯絡能管人員確認貼紙。' });
    if (point.active === false) return json(res, 410, { ok: false, error: 'point_inactive', message: '這個點位已停用，不需要再填寫。' });
    const period = currentPeriod();
    const recs = inv.records.filter((r) => r.pointCode === code);
    const last = recs.reduce((a, r) => (!a || r.at > a.at ? r : a), null);
    return json(res, 200, {
      ok: true, hid, hospitalName: inv.site.basic.userName || sess.name,
      point: pointView(inv, point),
      lastRecord: last ? { id: last.id, at: last.at, period: last.period, who: last.who, reporter: last.reporter || null } : null,
      period, nextPeriod: nextPeriod(period),
      recordedThisPeriod: recs.some((r) => r.period === period),
      source: pointSource(point),
      // 電費單逐格確認表單照這份長；貼紙頁不必再打 /api/inv/spec
      ...(point.items.some((i) => i.type === 'bill') ? { billColumns: inventorySpec.billColumns } : {}),
    });
  }

  // ── 貼紙頁：送出紀錄 ──
  if (POST && (mm = m(/^\/api\/inv\/point\/([^/]+)\/record$/))) {
    const code = decodeURIComponent(mm[1]);
    const body = await readJson(1024 * 1024);
    const period = body.period === undefined ? currentPeriod() : String(body.period);
    if (!RE_MONTH.test(period)) return json(res, 400, { ok: false, error: 'bad_period', message: '期別格式須為 YYYY-MM' });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    const confirmDecrease = Array.isArray(body.confirmDecrease) ? body.confirmDecrease.map(String) : [];
    const extraPhotos = Array.isArray(body.photos) ? body.photos : [];
    if (!extraPhotos.every((x) => typeof x === 'string' && RE_PHOTO_ID.test(x))) return json(res, 400, { ok: false, error: 'bad_photo_id' });
    const rp = parseReporter(body.reporter);
    if (!rp.ok) return json(res, 422, { ok: false, error: 'validation', details: [{ itemId: null, message: rp.message }], message: rp.message });
    const reporter = rp.reporter;
    const by = actorOf(sess, reporter).who;

    const r = await run(async (inv) => {
      const point = inv.points.find((p) => p.code === code);
      if (!point) throw new HttpErr(404, { error: 'point_not_found', message: '查無這個點位' });
      if (point.active === false) throw new HttpErr(410, { error: 'point_inactive', message: '這個點位已停用' });
      const a = assessRecord(point, inv.records.filter((x) => x.pointCode !== code), body.values, { note });
      const ru = readingAssessment(point, inv.records, a.values, confirmDecrease);
      a.decreases = ru.decreases;
      a.usage = { ...a.usage, ...ru.usage };
      a.warnings = [...ru.warnings, ...a.warnings];
      if (a.issues.length) throw new HttpErr(422, { error: 'validation', details: a.issues, message: a.errors.join('；') });
      if (a.decreases.length) throw new HttpErr(422, { error: 'reading_decreased', details: a.decreases, message: a.decreases.map((d) => d.message).join('\n') });
      if (a.pending.length) {
        throw new HttpErr(409, { error: 'unverified', pending: a.pending, total: a.pending.length, message: `電費單還有 ${a.pending.length} 個格子沒有確認，解析出來的值不能直接送出。` });
      }
      // 照片要真的在磁碟上：只收這個院所資料夾裡的檔
      const photoIds = [...new Set([...extraPhotos, ...point.items.filter((i) => i.type === 'photo').flatMap((i) => a.values[i.id] || [])])];
      const photos = [];
      for (const id of photoIds) {
        const p = await findPhoto(hid, id);
        if (!p) throw new HttpErr(422, { error: 'photo_missing', message: `找不到照片 ${id}，請重新上傳` });
        photos.push({ id: p.id, mime: p.mime, size: p.size });
      }
      const at = new Date().toISOString();
      const eqName = (id) => inv.equipment.find((e) => e.id === id)?.fields?.name || null;
      const anomalies = a.anomalyItems.map((it) => ({
        id: newId('an'), itemId: it.id, label: it.label, value: ANOMALY_VALUE,
        equipmentId: it.equipmentId || null, equipmentName: it.equipmentId ? eqName(it.equipmentId) : null,
        note, openedAt: at, closedAt: null, closedBy: null, closeNote: null,
      }));
      const record = { id: newId('r'), pointCode: code, period, at, who: by, reporter: reporter || null, values: a.values, usage: a.usage, note, photos, anomalies };
      inv.records.push(record);
      return { record, usage: a.usage, warnings: a.warnings };
    }, { who: by, what: `點位 ${code} 紀錄 ${period}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, period, nextPeriod: nextPeriod(period), commit: r.commit });
  }

  // ── 貼紙頁：上傳照片（bill 型項目會順便解析電費單，結果只是提案）──
  if (POST && (mm = m(/^\/api\/inv\/point\/([^/]+)\/photo$/))) {
    const code = decodeURIComponent(mm[1]);
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return json(res, 400, { ok: false, error: 'expect_multipart' });
    let parts;
    try { parts = parseMultipart(await readRawBody(req, config.uploadMaxBytes + 64 * 1024), ct); }
    catch (e) { return json(res, String(e.message) === 'payload_too_large' ? 413 : 400, { ok: false, error: String(e.message || e) }); }
    const field = (n) => parts.find((p) => p.name === n && !p.filename)?.data?.toString('utf8') || '';
    const filePart = parts.find((p) => p.filename && p.data?.length);
    if (!filePart) return json(res, 400, { ok: false, error: 'no_file' });
    const mime = photoMime(filePart.contentType, filePart.filename);
    if (!mime) return json(res, 415, { ok: false, error: 'unsupported_type', message: '只接受 JPG／PNG／WebP 照片或 PDF' });
    if (filePart.data.length > config.uploadMaxBytes) return json(res, 413, { ok: false, error: 'too_large' });

    const inv = await readInventory(hid);
    const point = inv.points.find((p) => p.code === code);
    if (!point) return json(res, 404, { ok: false, error: 'point_not_found' });
    const itemId = field('itemId');
    const item = itemId ? point.items.find((i) => i.id === itemId) : null;
    if (itemId && !item) return json(res, 400, { ok: false, error: 'unknown_item' });

    const photo = await storePhoto(hid, code, { mime, data: filePart.data });
    if (item?.type !== 'bill') return json(res, 200, { ok: true, photo });

    // 解析失敗不回滾照片：照片已經上傳成功，院方可以改成手動填
    let result = null, parseError = null;
    try {
      result = await extractFile('bills', {
        id: photo.id, kind: mime === 'application/pdf' ? 'pdf' : 'image', mime, displayName: `${code}_電費單_${currentPeriod().replace('-', '')}`,
      }, filePart.data);
    } catch (e) { parseError = { code: e.code || 'extract_failed', message: String(e.message || e) }; }
    return json(res, 200, { ok: true, photo, rows: result?.rows || [], notes: result?.notes || '', stats: result?.stats || null, parseError });
  }

  if (GET && (mm = m(/^\/api\/inv\/photo\/([^/]+)$/))) {
    const p = await readPhoto(hid, decodeURIComponent(mm[1]));
    if (!p) return json(res, 404, { ok: false, error: 'photo_not_found' });
    res.writeHead(200, { 'Content-Type': p.mime, 'Content-Length': p.data.length, 'Cache-Control': 'private, no-store' });
    res.end(p.data);
    return true;
  }

  // ── 初始建檔：更新某區塊 ──
  if (PUT && (mm = m(/^\/api\/inv\/site\/([^/]+)$/))) {
    const blockId = mm[1];
    const block = siteBlockById(blockId);
    if (!block) return json(res, 404, { ok: false, error: 'unknown_block' });
    const body = await readJson(2 * 1024 * 1024);
    const A = actorFrom(body);
    if (!A) return badReporter();
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    let warnings = [];
    const r = await run((inv) => {
      // 驗證放鎖裡：ref 欄位（變壓器的建築）要對當下的建築資料
      const v = validateSiteBlock(blockId, body.value, (b) => newId(b.slice(0, 3)), inv);
      if (!v.ok) throw new HttpErr(422, { error: 'validation', details: v.errors, warnings: v.warnings });
      warnings = v.warnings;
      const before = inv.site[blockId];
      // 第一次建檔不記異動、不要原因；已經有資料之後的修改才是「異動」（人員異動、資料更正），原因必填
      const changed = !isEmpty(before) && JSON.stringify(before) !== JSON.stringify(v.value);
      if (changed && !reason) throw new HttpErr(422, REASON_REQUIRED(`修改已建檔的「${block.label}」`));
      inv.site[blockId] = v.value;
      const change = changed ? pushChange(inv, A, { kind: blockId === 'staff' ? 'staff' : 'site', target: `site.${blockId}`, before, after: v.value, reason }) : null;
      return { value: v.value, change };
    }, { who: A.who, what: `初始建檔·${block.label}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, warnings, commit: r.commit });
  }

  // ── 設備主檔 ──
  if (POST && pathname === '/api/inv/equipment') {
    const body = await readJson();
    const input = body.equipment || {};
    const A = actorFrom(body);
    if (!A) return badReporter();
    const r = await run((inv) => {
      const eq = { building: input.building || null, category: input.category, kind: input.kind, pointCode: input.pointCode || null, status: input.status || 'active', fields: input.fields || {} };
      const v = validateEquipment(eq, inv);
      if (!v.ok) throw new HttpErr(422, { error: 'validation', details: v.errors, warnings: v.warnings });
      const now = new Date().toISOString();
      const rec = { id: newId('eq'), ...eq, fields: v.fields, createdAt: now, updatedAt: now };
      inv.equipment.push(rec);
      // 初始建檔一次建上百台，不逐筆記異動；異動登錄頁新增設備時會帶 reason，才記一筆「設備新增」
      const change = body.reason ? pushChange(inv, A, { kind: 'equipment.add', target: `equipment.${rec.id}`, before: null, after: eqSnapshot(rec), reason: String(body.reason) }) : null;
      return { equipment: rec, change, warnings: v.warnings };
    }, { who: A.who, what: '設備新增' });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  if (PUT && (mm = m(/^\/api\/inv\/equipment\/([^/]+)$/))) {
    const id = decodeURIComponent(mm[1]);
    const body = await readJson();
    const input = body.equipment || {};
    const A = actorFrom(body);
    if (!A) return badReporter();
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    // 汰換時指定取代它的新設備：body.equipment.replacedBy 或 body.replacedBy 皆可
    const rawBy = input.replacedBy !== undefined ? input.replacedBy : body.replacedBy;
    const r = await run((inv) => {
      const cur = inv.equipment.find((e) => e.id === id);
      if (!cur) throw new HttpErr(404, { error: 'equipment_not_found' });
      const next = { ...cur };
      for (const k of ['building', 'category', 'kind', 'pointCode', 'status', 'fields']) if (input[k] !== undefined) next[k] = input[k];
      const v = validateEquipment(next, inv);
      if (!v.ok) throw new HttpErr(422, { error: 'validation', details: v.errors, warnings: v.warnings });
      next.fields = v.fields;
      let nu = null;
      if (rawBy !== undefined && rawBy !== null && rawBy !== '') {
        const by = String(rawBy);
        if (next.status !== 'replaced') throw new HttpErr(422, { error: 'validation', details: ['只有改成「已汰換」（status: replaced）時才能指定取代的新設備（replacedBy）'] });
        if (by === id) throw new HttpErr(422, { error: 'validation', details: ['取代的新設備不能是自己'] });
        nu = inv.equipment.find((e) => e.id === by);
        if (!nu) throw new HttpErr(422, { error: 'validation', details: [`取代的新設備不存在：${by}`] });
        if (nu.status && nu.status !== 'active') throw new HttpErr(422, { error: 'validation', details: ['取代的新設備必須是使用中'] });
        next.replacedBy = by;
      }
      const before = eqSnapshot(cur), after = eqSnapshot(next);
      if (JSON.stringify(before) === JSON.stringify(after)) return { equipment: cur, change: null, unchanged: true, warnings: v.warnings };
      if (!reason) throw new HttpErr(422, REASON_REQUIRED('修改設備主檔'));
      next.updatedAt = new Date().toISOString();
      Object.assign(cur, next);

      // 汰換＋指定新設備：點位項目改指新設備、新設備承接所屬點位，全部寫進同一筆異動
      let links = null;
      if (nu && before.replacedBy !== next.replacedBy) {
        const items = [];
        for (const p of inv.points) {
          for (const it of p.items) if (it.equipmentId === id) { it.equipmentId = nu.id; items.push({ pointCode: p.code, itemId: it.id, label: it.label }); }
        }
        // 以點位項目為準：舊設備沒有所屬點位時，取第一個改指過來的點位
        const inherit = cur.pointCode || items[0]?.pointCode || null;
        const fromPc = nu.pointCode ?? null;
        if (inherit && inherit !== fromPc) { nu.pointCode = inherit; nu.updatedAt = next.updatedAt; }
        links = { replacedBy: nu.id, items, newPointCode: { from: fromPc, to: nu.pointCode ?? null } };
      }
      // 異動種類：狀態變了就是汰換／移除；否則看呼叫端指定（規格更正），預設「設備資料修改」
      let kind = 'equipment.update';
      if (before.status !== after.status && after.status === 'replaced') kind = 'equipment.replace';
      else if (before.status !== after.status && after.status === 'removed') kind = 'equipment.remove';
      else if (links) kind = 'equipment.replace';
      else if (body.changeKind && String(body.changeKind).startsWith('equipment.') && CHANGE_KINDS[body.changeKind]) kind = body.changeKind;
      const change = pushChange(inv, A, { kind, target: `equipment.${id}`, before, after, reason, links });
      // 移除（或汰換沒指定新設備）後仍連到它的點位項目：回給管理端提示去點位移除
      const linkedItems = cur.status !== 'active' ? linkedItemsOf(inv, id) : [];
      return { equipment: cur, change, warnings: v.warnings, linkedItems, ...(links ? { relinked: links } : {}) };
    }, { who: A.who, what: `設備修改 ${id}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  // ── 點位 ──
  if (POST && pathname === '/api/inv/points') {
    const body = await readJson();
    const input = body.point || {};
    const A = actorFrom(body);
    if (!A) return badReporter();
    const r = await run((inv) => {
      const domain = input.domain;
      if (domain !== 'power' && domain !== 'water') throw new HttpErr(422, { error: 'validation', details: ['類別須為 power（電）或 water（水）'] });
      let code = input.code;
      if (code) {
        const c = parseCode(code);
        if (!c) throw new HttpErr(422, { error: 'validation', details: [`點位代碼格式錯誤：${code}`] });
        if (c.hid !== hid) throw new HttpErr(403, { error: 'forbidden_hospital' });
      } else {
        // 自動編號：同類別最大號＋1。停用的點位也算在內——代碼一旦印成貼紙就不能再發給別的點位
        const used = inv.points.map((p) => parseCode(p.code)).filter((c) => c && c.domain === domain).map((c) => c.num);
        const n = (used.length ? Math.max(...used) : 0) + 1;
        if (n > 99) throw new HttpErr(422, { error: 'code_exhausted', message: '這個類別的點位代碼已用完（最多 99 個）' });
        code = makeCode(hid, domain, n);
      }
      if (inv.points.some((p) => p.code === code)) throw new HttpErr(409, { error: 'duplicate_code', message: `點位代碼 ${code} 已存在` });
      const v = validatePoint({ ...input, code, domain }, inv);
      if (!v.ok) throw new HttpErr(422, { error: 'validation', details: v.errors });
      inv.points.push(v.point);
      return { point: { ...v.point, url: pointUrl(code) } };
    }, { who: A.who, what: '點位新增' });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  if (GET && (mm = m(/^\/api\/inv\/points\/([^/]+)\/qr\.png$/))) {
    const code = decodeURIComponent(mm[1]);
    const inv = await readInventory(hid);
    if (!inv.points.some((p) => p.code === code)) return json(res, 404, { ok: false, error: 'point_not_found' });
    const width = Math.min(Math.max(Number(new URL(req.url, 'http://x').searchParams.get('size')) || 512, 128), 2048);
    // 錯誤修正 M：貼紙會髒會刮，但 Q/H 會讓碼變密、遠距離不好掃；M 是兩者的折衷
    const png = await QRCode.toBuffer(pointUrl(code), { type: 'png', errorCorrectionLevel: 'M', margin: 2, width });
    const dl = new URL(req.url, 'http://x').searchParams.get('download');
    res.writeHead(200, {
      'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=300',
      ...(dl ? { 'Content-Disposition': `attachment; filename="${code}.png"` } : {}),
    });
    res.end(png);
    return true;
  }

  if (PUT && (mm = m(/^\/api\/inv\/points\/([^/]+)$/))) {
    const code = decodeURIComponent(mm[1]);
    const body = await readJson();
    const input = body.point || {};
    const A = actorFrom(body);
    if (!A) return badReporter();
    const r = await run((inv) => {
      const idx = inv.points.findIndex((p) => p.code === code);
      if (idx < 0) throw new HttpErr(404, { error: 'point_not_found' });
      const cur = inv.points[idx];
      // 代碼與類別不可改：網址已經印在貼紙上了。改名、搬家只改 name／location
      if (input.code !== undefined && input.code !== code) throw new HttpErr(422, { error: 'code_immutable', message: '點位代碼不能修改（貼紙網址會失效）' });
      if (input.domain !== undefined && input.domain !== cur.domain) throw new HttpErr(422, { error: 'domain_immutable', message: '點位類別不能修改' });
      const next = { ...cur };
      for (const k of ['name', 'location', 'items', 'active']) if (input[k] !== undefined) next[k] = input[k];
      const v = validatePoint(next, inv);
      if (!v.ok) throw new HttpErr(422, { error: 'validation', details: v.errors });
      if (JSON.stringify(cur) === JSON.stringify(v.point)) return { point: { ...cur, url: pointUrl(code) }, unchanged: true };
      inv.points[idx] = v.point;
      const change = pushChange(inv, A, { kind: 'point', target: `point.${code}`, before: cur, after: v.point, reason: String(body.reason || '') });
      return { point: { ...v.point, url: pointUrl(code) }, change };
    }, { who: A.who, what: `點位修改 ${code}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  // ── 本期進度 ──
  if (GET && pathname === '/api/inv/progress') {
    const period = new URL(req.url, 'http://x').searchParams.get('period') || currentPeriod();
    if (!RE_MONTH.test(period)) return json(res, 400, { ok: false, error: 'bad_period' });
    const inv = await readInventory(hid);
    return json(res, 200, { ok: true, ...progress(inv, period), nextPeriod: nextPeriod(period) });
  }

  // ── 未結異常：結案 ──
  if (POST && (mm = m(/^\/api\/inv\/anomalies\/([^/]+)\/close$/))) {
    const id = decodeURIComponent(mm[1]);
    const body = await readJson();
    const A = actorFrom(body);
    if (!A) return badReporter();
    const r = await run((inv) => {
      for (const rec of inv.records) {
        const a = (rec.anomalies || []).find((x) => x.id === id);
        if (!a) continue;
        if (a.closedAt) throw new HttpErr(409, { error: 'already_closed', message: '這筆異常已經結案' });
        a.closedAt = new Date().toISOString();
        a.closedBy = A.who;
        a.closedReporter = A.reporter;
        a.closeNote = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
        return { anomaly: { ...a, recordId: rec.id, pointCode: rec.pointCode } };
      }
      throw new HttpErr(404, { error: 'anomaly_not_found' });
    }, { who: A.who, what: `異常結案 ${id}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  // ── 異動登錄 ──
  if (GET && pathname === '/api/inv/changes') {
    const inv = await readInventory(hid);
    return json(res, 200, { ok: true, items: [...inv.changes].sort((a, b) => (a.at < b.at ? 1 : -1)), kinds: CHANGE_KINDS });
  }

  if (POST && pathname === '/api/inv/changes') {
    const body = await readJson(2 * 1024 * 1024);
    const c = body.change || {};
    const A = actorFrom(body);
    if (!A) return badReporter();
    const errors = [];
    if (!CHANGE_KINDS[c.kind]) errors.push(`異動種類須為 ${Object.keys(CHANGE_KINDS).join('／')}`);
    if (typeof c.reason !== 'string' || !c.reason.trim()) errors.push('異動原因必填');
    if (c.target !== undefined && (typeof c.target !== 'string' || c.target.length > 120)) errors.push('異動對象格式錯誤');
    if (errors.length) return json(res, 422, { ok: false, error: 'validation', details: errors });
    const r = await run((inv) => ({ change: pushChange(inv, A, { kind: c.kind, target: c.target || '', before: c.before, after: c.after, reason: c.reason.trim() }) }),
      { who: A.who, what: `異動登錄·${CHANGE_KINDS[c.kind]}` });
    if (!r) return true;
    return json(res, 200, { ok: true, ...r.result, commit: r.commit });
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}
