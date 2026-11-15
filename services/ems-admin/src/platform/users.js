// 帳號：一人一帳號＋角色授權。舊 accounts.json 的院所帳號仍可登入，登入時自動對應成平台使用者
// （院所管理者＋全部業務角色，限該院），讓院方用它替同仁開個人帳號。
import { createHmac, randomBytes } from 'node:crypto';
import { q, insert, update, newId, nowIso, audit, tx } from './db.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { ROLES, orgByHid, orgById, descendants, can, Forbidden } from './authz.js';

export const LEGACY_ROLES = ['org_admin', 'collector', 'custodian', 'reporter', 'reviewer', 'approver', 'manager'];
const MAX_FAILS = 8;
const LOCK_MS = 5 * 60 * 1000;

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return '密碼至少 10 個字元';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '密碼需同時包含英文字母與數字';
  return null;
}

// ── TOTP（RFC 6238，30 秒、6 碼、SHA-1；與一般驗證器 App 相容）──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = randomBytes(20); let bits = ''; let out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpAt(secret, t = Date.now()) {
  const counter = Math.floor(t / 30000);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
export function totpOk(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  return [-1, 0, 1].some((w) => totpAt(secret, t + w * 30000) === c);
}

// ── 登入 ──
// 回 { ok, session, mustChange } 或 { ok:false, code }
export function platformLogin(username, password, { totp } = {}) {
  const u = q.get('SELECT * FROM users WHERE username = ? AND legacy = 0', username);
  if (!u) return null; // 不是平台帳號 → 交給舊 accounts.json
  const now = Date.now();
  if (u.locked_until && Date.parse(u.locked_until) > now) return { ok: false, code: 'locked', retryMs: Date.parse(u.locked_until) - now };
  if (u.status !== 'active') return { ok: false, code: 'disabled' };
  if (!verifyPassword(password, u.password)) {
    const n = u.failed_count + 1;
    update('users', u.id, { failed_count: n, locked_until: n >= MAX_FAILS ? new Date(now + LOCK_MS).toISOString() : null });
    audit({ actor: u.id, actorName: u.display_name, action: 'auth.login_failed', targetType: 'user', targetId: u.id });
    return { ok: false, code: 'bad_credentials' };
  }
  if (u.totp_enabled) {
    if (!totp) return { ok: false, code: 'totp_required' };
    if (!totpOk(u.totp_secret, totp)) return { ok: false, code: 'bad_totp' };
  }
  update('users', u.id, { failed_count: 0, locked_until: null, last_login_at: nowIso() });
  audit({ actor: u.id, actorName: u.display_name, action: 'auth.login', targetType: 'user', targetId: u.id });
  return { ok: true, mustChange: !!u.must_change, session: { sub: u.username, uid: u.id, name: u.display_name, hid: legacyHidFor(u.id) } };
}

// 舊入口（健檢、盤點、看板維護）以院所為單位、沒有角色。個人帳號只有在「恰好一家院所」
// 擁有院所管理者或盤點承辦角色時，才帶 hid 進去，否則舊入口不開放。
export function legacyHidFor(userId) {
  const rows = q.all(`SELECT DISTINCT g.scope_id FROM grants g WHERE g.user_id = ? AND g.revoked_at IS NULL
                      AND g.scope_type = 'org' AND g.role IN ('org_admin','collector')`, userId);
  const hids = [...new Set(rows.map((r) => orgById(r.scope_id)?.legacy_hid).filter(Boolean))];
  return hids.length === 1 ? hids[0] : null;
}

// 舊院所帳號登入成功後呼叫：確保有對應的平台使用者與授權
export function ensureLegacyUser({ username, hid, name, passwordHash }) {
  const org = orgByHid(hid);
  if (!org) return null;
  return tx(() => {
    let u = q.get('SELECT * FROM users WHERE username = ?', username);
    if (u && !u.legacy) return null; // 名稱被個人帳號佔用：不混用
    if (!u) {
      u = insert('users', { id: newId('u'), username, password: passwordHash || '!legacy', display_name: name || hid, unit: '院所帳號',
        status: 'active', must_change: 0, legacy: 1, created_by: 'system', created_at: nowIso(), updated_at: nowIso() });
      for (const role of LEGACY_ROLES) {
        insert('grants', { id: newId('g'), user_id: u.id, role, scope_type: 'org', scope_id: org.id, granted_by: 'system', created_at: nowIso() });
      }
      audit({ actor: 'system', action: 'user.legacy_bridge', orgId: org.id, targetType: 'user', targetId: u.id, after: { username, roles: LEGACY_ROLES } });
    }
    update('users', u.id, { last_login_at: nowIso() });
    return { sub: username, uid: u.id, hid, name: u.display_name };
  });
}

// ── 帳號管理 ──
const PUBLIC_COLS = 'id, username, display_name, email, phone, unit, status, must_change, totp_enabled, legacy, created_at, last_login_at';

export function listUsers(ctx, orgId) {
  const scope = orgId ? [...descendants(orgId)] : null;
  const users = q.all(`SELECT ${PUBLIC_COLS} FROM users ORDER BY created_at`);
  const grants = q.all('SELECT * FROM grants WHERE revoked_at IS NULL');
  return users.map((u) => ({ ...u, grants: grants.filter((g) => g.user_id === u.id) }))
    .filter((u) => {
      if (can(ctx, 'user.manage', null) && ctx.grants.some((g) => g.role === 'sysadmin' && g.scope_type === 'global') && !scope) return true;
      return u.grants.some((g) => g.scope_type === 'org' && (scope ? scope.has(g.scope_id) : can(ctx, 'user.manage', g.scope_id)));
    });
}

function assertGrantable(ctx, role, scopeType, scopeId) {
  if (!ROLES[role]) throw Object.assign(new Error('unknown_role'), { status: 422 });
  const isGlobalAdmin = ctx.grants.some((g) => g.role === 'sysadmin' && g.scope_type === 'global');
  if (scopeType === 'global' && !isGlobalAdmin) throw new Forbidden('user.manage');
  if (role === 'sysadmin' && !isGlobalAdmin) throw new Forbidden('user.manage');
  if (scopeType === 'org' && !can(ctx, 'user.manage', scopeId)) throw new Forbidden('user.manage');
}

export function createUser(ctx, { username, displayName, email, phone, unit, password, grants = [] }) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username || '')) throw Object.assign(new Error('帳號只能用英數字與 . _ -，3–40 字'), { status: 422 });
  if (!displayName) throw Object.assign(new Error('請填姓名'), { status: 422 });
  const p = passwordProblem(password); if (p) throw Object.assign(new Error(p), { status: 422 });
  if (!grants.length) throw Object.assign(new Error('至少指定一個角色'), { status: 422 });
  for (const g of grants) assertGrantable(ctx, g.role, g.scopeType || 'org', g.scopeId);
  if (q.get('SELECT 1 FROM users WHERE username = ?', username)) throw Object.assign(new Error('帳號已存在'), { status: 409 });
  return tx(() => {
    const u = insert('users', { id: newId('u'), username, password: hashPassword(password), display_name: displayName,
      email: email || null, phone: phone || null, unit: unit || null, status: 'active', must_change: 1,
      created_by: ctx.userId, created_at: nowIso(), updated_at: nowIso() });
    for (const g of grants) addGrant(ctx, u.id, g, { skipCheck: true });
    audit({ actor: ctx.userId, actorName: ctx.name, action: 'user.create', targetType: 'user', targetId: u.id,
      after: { username, displayName, grants } });
    return { id: u.id };
  });
}

export function addGrant(ctx, userId, { role, scopeType = 'org', scopeId = null, validFrom, validTo, delegateOf }, { skipCheck = false } = {}) {
  if (!skipCheck) assertGrantable(ctx, role, scopeType, scopeId);
  const g = insert('grants', { id: newId('g'), user_id: userId, role, scope_type: scopeType, scope_id: scopeType === 'global' ? null : scopeId,
    valid_from: validFrom || '1900-01-01', valid_to: validTo || null, delegate_of: delegateOf || null, granted_by: ctx.userId, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: scopeId, action: 'grant.add', targetType: 'user', targetId: userId, after: g });
  return g;
}

export function revokeGrant(ctx, grantId) {
  const g = q.get('SELECT * FROM grants WHERE id = ?', grantId);
  if (!g) throw Object.assign(new Error('not_found'), { status: 404 });
  assertGrantable(ctx, g.role, g.scope_type, g.scope_id);
  update('grants', grantId, { revoked_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: g.scope_id, action: 'grant.revoke', targetType: 'user', targetId: g.user_id, before: g });
}

function assertManages(ctx, userId) {
  const gs = q.all('SELECT * FROM grants WHERE user_id = ? AND revoked_at IS NULL', userId);
  const isGlobalAdmin = ctx.grants.some((g) => g.role === 'sysadmin' && g.scope_type === 'global');
  if (isGlobalAdmin) return;
  if (!gs.length || !gs.every((g) => g.scope_type === 'org' && can(ctx, 'user.manage', g.scope_id))) throw new Forbidden('user.manage');
}

export function updateUser(ctx, userId, patch) {
  assertManages(ctx, userId);
  const before = q.get(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, userId);
  const allowed = {};
  for (const [k, col] of [['displayName', 'display_name'], ['email', 'email'], ['phone', 'phone'], ['unit', 'unit'], ['status', 'status']]) {
    if (patch[k] !== undefined) allowed[col] = patch[k];
  }
  if (allowed.status && !['active', 'disabled'].includes(allowed.status)) throw Object.assign(new Error('bad_status'), { status: 422 });
  allowed.updated_at = nowIso();
  update('users', userId, allowed);
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'user.update', targetType: 'user', targetId: userId, before, after: allowed });
}

export function resetPassword(ctx, userId, newPassword) {
  assertManages(ctx, userId);
  const p = passwordProblem(newPassword); if (p) throw Object.assign(new Error(p), { status: 422 });
  update('users', userId, { password: hashPassword(newPassword), must_change: 1, failed_count: 0, locked_until: null, updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'user.reset_password', targetType: 'user', targetId: userId });
}

export function changeOwnPassword(ctx, oldPw, newPw) {
  const u = q.get('SELECT * FROM users WHERE id = ?', ctx.userId);
  if (!u || u.legacy) throw Object.assign(new Error('院所共用帳號的密碼請由維護窗口變更'), { status: 422 });
  if (!verifyPassword(oldPw, u.password)) throw Object.assign(new Error('目前密碼不正確'), { status: 422 });
  const p = passwordProblem(newPw); if (p) throw Object.assign(new Error(p), { status: 422 });
  if (oldPw === newPw) throw Object.assign(new Error('新密碼不可與舊密碼相同'), { status: 422 });
  update('users', u.id, { password: hashPassword(newPw), must_change: 0, password_changed_at: nowIso(), updated_at: nowIso() });
  audit({ actor: u.id, actorName: u.display_name, action: 'user.change_password', targetType: 'user', targetId: u.id });
}

export function startTotp(ctx) {
  const secret = newTotpSecret();
  update('users', ctx.userId, { totp_secret: secret, totp_enabled: 0 });
  return { secret, uri: `otpauth://totp/EMS:${encodeURIComponent(ctx.username)}?secret=${secret}&issuer=EMS` };
}
export function confirmTotp(ctx, code) {
  const u = q.get('SELECT totp_secret FROM users WHERE id = ?', ctx.userId);
  if (!u?.totp_secret || !totpOk(u.totp_secret, code)) throw Object.assign(new Error('驗證碼不正確'), { status: 422 });
  update('users', ctx.userId, { totp_enabled: 1 });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'user.totp_enable', targetType: 'user', targetId: ctx.userId });
}
export function disableTotp(ctx, userId) {
  if (userId !== ctx.userId) assertManages(ctx, userId);
  update('users', userId, { totp_enabled: 0, totp_secret: null });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'user.totp_disable', targetType: 'user', targetId: userId });
}

// 維護者 CLI 用：建立全域系統管理員（不經 ctx）
export function bootstrapSysadmin({ username, displayName, password }) {
  const p = passwordProblem(password); if (p) throw new Error(p);
  return tx(() => {
    let u = q.get('SELECT * FROM users WHERE username = ?', username);
    if (!u) u = insert('users', { id: newId('u'), username, password: hashPassword(password), display_name: displayName || username,
      status: 'active', must_change: 1, created_by: 'cli', created_at: nowIso(), updated_at: nowIso() });
    else update('users', u.id, { password: hashPassword(password), must_change: 1 });
    if (!q.get("SELECT 1 FROM grants WHERE user_id = ? AND role = 'sysadmin' AND scope_type = 'global' AND revoked_at IS NULL", u.id)) {
      insert('grants', { id: newId('g'), user_id: u.id, role: 'sysadmin', scope_type: 'global', granted_by: 'cli', created_at: nowIso() });
    }
    audit({ actor: 'cli', action: 'user.bootstrap_sysadmin', targetType: 'user', targetId: u.id, after: { username } });
    return u.id;
  });
}
