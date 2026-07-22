// 帳號：每院一組（username → hospitalId），scrypt 雜湊存 accounts.json。
// accounts.json 由 `pnpm hash` 產生/追加，不 commit（見 .gitignore）。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { config } from './config.js';
import { verifyPassword } from './auth.js';

let cache = null;
let cacheMtime = 0;

function load() {
  if (!existsSync(config.accountsFile)) return { accounts: [] };
  const j = JSON.parse(readFileSync(config.accountsFile, 'utf8'));
  if (!Array.isArray(j.accounts)) throw new Error('accounts.json 格式錯誤：需 { "accounts": [...] }');
  return j;
}

function accounts() {
  // 檔案 mtime 有變動就重載（改帳密不用重啟服務）
  const mtime = existsSync(config.accountsFile) ? statSync(config.accountsFile).mtimeMs : 0;
  if (!cache || mtime !== cacheMtime) { cache = load(); cacheMtime = mtime; }
  return cache.accounts;
}

export function reloadAccounts() { cache = null; return accounts().length; }

// ── 登入節流：同一 username 連續失敗 → 遞增鎖定（in-memory）──
const fails = new Map(); // username -> { n, until }
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;

export function login(username, password) {
  const now = Date.now();
  const f = fails.get(username);
  if (f && f.until > now) return { ok: false, code: 'locked', retryMs: f.until - now };

  const acc = accounts().find((a) => a.username === username);
  const good = acc && verifyPassword(password, acc.password);
  if (!good) {
    const n = (f?.n || 0) + 1;
    fails.set(username, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
    return { ok: false, code: 'bad_credentials' };
  }
  fails.delete(username);
  return { ok: true, session: { sub: acc.username, hid: acc.hospitalId, name: acc.displayName || acc.hospitalId } };
}
