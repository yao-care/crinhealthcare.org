// M05 來源與證據庫（PRD §17 第 3 點）：內容雜湊命名、寫入後不可覆寫、機敏分級、下載留稽核。
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { q, insert, update, newId, nowIso, audit, sha256 } from './db.js';
import { config } from '../config.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, HttpError } from './util.js';

// 白名單型態（副檔名＋magic bytes 雙重檢查）
const TYPES = {
  pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] }, jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  webp: { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] }, heic: { mime: 'image/heic' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4b, 0x03, 0x04] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', magic: [0x50, 0x4b, 0x03, 0x04] },
  csv: { mime: 'text/csv', text: true }, txt: { mime: 'text/plain', text: true }, json: { mime: 'application/json', text: true },
};
export const MAX_BYTES = Number(process.env.EVIDENCE_MAX_BYTES || 25 * 1024 * 1024);

function ext(name) { return String(name || '').toLowerCase().split('.').pop(); }

export function checkFile(filename, data) {
  const e = ext(filename); const t = TYPES[e];
  if (!t) throw bad(`不接受 .${e} 檔（可上傳 PDF、圖片、Excel、ODS、CSV、Word）`);
  if (data.length > MAX_BYTES) throw new HttpError(413, `檔案超過 ${Math.round(MAX_BYTES / 1048576)} MB`);
  if (!data.length) throw bad('檔案是空的');
  if (t.magic && !t.magic.every((b, i) => data[i] === b)) throw bad('檔案內容與副檔名不符');
  if (t.text && data.subarray(0, 4096).includes(0)) throw bad('文字檔含二進位內容');
  // 病毒檢查：主機有 clamdscan 時由 scanHook 執行（見 docs 維運手冊）；這裡擋最常見的可執行檔
  const head = data.subarray(0, 2).toString('latin1');
  if (head === 'MZ' || data.subarray(0, 4).toString('latin1') === '\x7fELF') throw bad('不接受可執行檔');
  return t.mime;
}

const dirFor = (orgId) => join(config.uploadsDir, 'platform', orgId.replace(/[^a-zA-Z0-9_-]/g, ''), 'evidence');

export async function storeEvidence(ctx, { orgId, filename, data, confidentiality = 'internal', kind, sourceId, assetId, note }, { skipCheck = false } = {}) {
  if (!skipCheck) assertCan(ctx, 'obs.write', orgId);
  const mime = checkFile(filename, data);
  if (!['public', 'internal', 'restricted', 'secret'].includes(confidentiality)) throw bad('機敏等級不正確');
  const hash = sha256(data);
  const dup = q.get('SELECT * FROM evidence_files WHERE org_id = ? AND sha256 = ?', orgId, hash);
  if (dup) return { id: dup.id, duplicate: true, sha256: hash };
  const dir = dirFor(orgId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, hash);
  try { await access(key); } catch { await writeFile(key, data, { flag: 'wx', mode: 0o400 }); }
  const id = newId('ev');
  insert('evidence_files', { id, org_id: orgId, sha256: hash, mime, size: data.length, filename: String(filename).slice(0, 200), storage_key: key,
    confidentiality, kind: kind || null, source_id: sourceId || null, asset_id: assetId || null, note: note || null, uploaded_by: ctx?.userId || 'system', uploaded_at: nowIso() });
  audit({ actor: ctx?.userId || 'system', actorName: ctx?.name, orgId, action: 'evidence.upload', targetType: 'evidence', targetId: id, after: { filename, sha256: hash, confidentiality } });
  return { id, sha256: hash };
}

// 機敏等級對權限：public/internal → view.evidence；restricted → 再加 view.sensitive；secret → 只有稽核與核准者
function canOpen(ctx, ev) {
  if (!can(ctx, 'view.evidence', ev.org_id)) return false;
  if (ev.confidentiality === 'restricted') return can(ctx, 'view.sensitive', ev.org_id);
  if (ev.confidentiality === 'secret') return can(ctx, 'audit.read', ev.org_id) || can(ctx, 'report.approve', ev.org_id);
  return true;
}

export async function readEvidence(ctx, id, { ip } = {}) {
  const ev = q.get('SELECT * FROM evidence_files WHERE id = ?', id); if (!ev) throw notFound('佐證');
  if (!canOpen(ctx, ev)) throw new HttpError(403, '你沒有開啟此佐證的權限', { action: 'view.evidence' });
  const data = await readFile(ev.storage_key);
  if (sha256(data) !== ev.sha256) throw new HttpError(500, '檔案雜湊不符，可能遭竄改，請通知系統管理員');
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: ev.org_id, action: 'evidence.download', targetType: 'evidence', targetId: id, ip });
  return { ev, data };
}

export function listEvidence(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return [];
  const where = [`e.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.assetId) { where.push('(e.asset_id = ? OR e.id IN (SELECT oe.evidence_id FROM observation_evidence oe JOIN observations o ON o.id = oe.observation_id WHERE o.asset_id = ?))'); p.push(f.assetId, f.assetId); }
  if (f.sourceId) { where.push('e.source_id = ?'); p.push(f.sourceId); }
  if (f.q) { where.push('(e.filename LIKE ? OR e.note LIKE ? OR e.kind LIKE ?)'); const s = `%${f.q}%`; p.push(s, s, s); }
  return q.all(`SELECT e.id, e.org_id, e.sha256, e.mime, e.size, e.filename, e.confidentiality, e.kind, e.source_id, e.asset_id, e.note, e.uploaded_at,
      u.display_name AS uploaded_by_name, a.name AS asset_name,
      (SELECT COUNT(*) FROM observation_evidence oe WHERE oe.evidence_id = e.id) AS obs_count
    FROM evidence_files e LEFT JOIN users u ON u.id = e.uploaded_by LEFT JOIN assets a ON a.id = e.asset_id
    WHERE ${where.join(' AND ')} ORDER BY e.uploaded_at DESC LIMIT 500`, ...p)
    .map((e) => ({ ...e, canOpen: canOpen(ctx, e) }));
}

export function updateEvidenceMeta(ctx, id, { confidentiality, note, kind, assetId, sourceId }) {
  const ev = q.get('SELECT * FROM evidence_files WHERE id = ?', id); if (!ev) throw notFound('佐證');
  assertCan(ctx, 'obs.write', ev.org_id);
  const patch = {};
  if (confidentiality) { if (!['public', 'internal', 'restricted', 'secret'].includes(confidentiality)) throw bad('機敏等級不正確'); patch.confidentiality = confidentiality; }
  if (note !== undefined) patch.note = note; if (kind !== undefined) patch.kind = kind;
  if (assetId !== undefined) patch.asset_id = assetId || null; if (sourceId !== undefined) patch.source_id = sourceId || null;
  update('evidence_files', id, patch);
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: ev.org_id, action: 'evidence.meta', targetType: 'evidence', targetId: id, before: ev, after: patch });
}

export function linkEvidence(observationId, evidenceId, page) {
  if (!q.get('SELECT 1 FROM observation_evidence WHERE observation_id = ? AND evidence_id = ?', observationId, evidenceId)) {
    insert('observation_evidence', { observation_id: observationId, evidence_id: evidenceId, page: page || null });
  }
}

// 驗證全部檔案雜湊（維運：定期跑）
export async function verifyAllEvidence() {
  const bad = [];
  for (const ev of q.all('SELECT id, storage_key, sha256 FROM evidence_files')) {
    try { if (sha256(await readFile(ev.storage_key)) !== ev.sha256) bad.push({ id: ev.id, problem: 'hash_mismatch' }); }
    catch { bad.push({ id: ev.id, problem: 'missing' }); }
  }
  return { checked: q.get('SELECT COUNT(*) n FROM evidence_files').n, bad };
}
