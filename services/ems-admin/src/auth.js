// 認證：scrypt 密碼雜湊 + HMAC 簽章 session token（cookie）。全用 Node 內建 crypto，無外部依賴。
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from './config.js';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 小時

// ── 密碼雜湊（scrypt）──
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const a = Buffer.from(hash, 'hex');
  let b;
  try { b = scryptSync(password, salt, a.length); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── session token：base64url(payload).hmac ──
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const p = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', config.jwtSecret).update(p).digest('base64url');
  return `${p}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  const expect = createHmac('sha256', config.jwtSecret).update(p).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!body.exp || body.exp < Date.now()) return null;
  return body;
}

// ── cookie ──
const COOKIE = 'ems_admin_session';

export function setSessionCookie(res, token) {
  const bits = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ];
  if (config.cookieSecure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function clearSessionCookie(res) {
  const bits = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (config.cookieSecure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function readSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  if (!m) return null;
  return verifyToken(m.slice(COOKIE.length + 1));
}
