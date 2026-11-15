// 帳號：每院一組（username → hospitalId），scrypt 雜湊存 accounts.json。
// accounts.json 由 `pnpm hash` 產生/追加，不 commit（見 .gitignore）。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { config } from './config.js';
import { verifyPassword, ttlFor } from './auth.js';
import { platformLogin, ensureLegacyUser } from './platform/users.js';

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

// remember：使用者勾了「這支手機記住 30 天」→ 回 ttlMs 給 server.js 簽長效 token
export function login(username, password, { remember = false, totp } = {}) {
  // 平台個人帳號優先；不是平台帳號才走舊 accounts.json
  const p = platformLogin(username, password, { totp });
  if (p) return p.ok ? { ...p, ttlMs: ttlFor(remember) } : p;
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
  // 舊院所帳號對應成平台使用者（院所管理者＋業務角色，限該院），session 帶 uid 才能用平台
  let bridged = null;
  try { bridged = ensureLegacyUser({ username: acc.username, hid: acc.hospitalId, name: acc.displayName }); } catch (e) { console.error('[ems-admin] legacy bridge', e.message); }
  return { ok: true, ttlMs: ttlFor(remember), session: { sub: acc.username, hid: acc.hospitalId, name: acc.displayName || acc.hospitalId, ...(bridged ? { uid: bridged.uid } : {}) } };
}
