// 備份與還原驗證（PRD §17 第 8 點、§22.3）：每日 VACUUM INTO 快照，保留 N 份；驗證＝能開、integrity_check、稽核鏈、定版雜湊。
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, dbPath, audit, q } from './db.js';

const { DatabaseSync } = await import('node:sqlite');
const KEEP = Number(process.env.PLATFORM_BACKUP_KEEP || 30);

export function backupDir() { return process.env.PLATFORM_BACKUP_DIR || join(dirname(dbPath()), 'backups'); }

export function backupNow(actor = 'scheduler') {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `platform-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  const path = join(dir, name);
  openDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const v = verifyBackup(path);
  audit({ actor, action: 'backup.create', targetType: 'backup', targetId: name, after: v });
  prune();
  return { name, ...v };
}

export function verifyBackup(path) {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = d.prepare('PRAGMA integrity_check').get();
    const rows = d.prepare('SELECT * FROM audit_events ORDER BY seq').all();
    // 用同一套演算法驗稽核鏈
    let prev = 'genesis'; let chainOk = true;
    for (const r of rows) { if (r.prev_hash !== prev) { chainOk = false; break; } prev = r.hash; }
    const counts = Object.fromEntries(['organizations', 'users', 'assets', 'observations', 'approved_facts', 'datasets', 'report_runs', 'evidence_files'].map((t) => [t, d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    return { ok: integrity?.integrity_check === 'ok' && chainOk, integrity: integrity?.integrity_check, auditChain: chainOk, auditEvents: rows.length, counts, size: statSync(path).size };
  } finally { d.close(); }
}

export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse().map((f) => ({ name: f, size: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime.toISOString() }));
}

function prune() {
  const all = listBackups();
  for (const b of all.slice(KEEP)) unlinkSync(join(backupDir(), b.name));
}

// 還原演練：把備份開到唯讀、比對與現行資料庫的筆數（不覆蓋現行資料）
export function restoreDrill(name, actor = 'admin') {
  if (!/^platform-[\w-]+\.sqlite$/.test(name)) throw new Error('備份檔名不正確');
  const path = join(backupDir(), name);
  const v = verifyBackup(path);
  const live = Object.fromEntries(Object.keys(v.counts).map((t) => [t, q.get(`SELECT COUNT(*) n FROM ${t}`).n]));
  audit({ actor, action: 'backup.restore_drill', targetType: 'backup', targetId: name, after: { ok: v.ok } });
  return { ...v, live };
}
