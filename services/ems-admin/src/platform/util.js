// 共用小工具：錯誤、單位換算、期間（半開區間 [start, end)）、數值正規化。
import { q } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
export const bad = (msg, extra) => new HttpError(422, msg, extra);
export const notFound = (what = '資料') => new HttpError(404, `找不到${what}`);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

// ── 數值 ──
// 字串數字正規化：去千分位與單位字。清乾淨後沒有數字就回 undefined（不可變成 0，見 README 的 coerce 坑）
export function toNumber(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const s = String(v).replace(/[,\s，]/g, '').replace(/[^\d.eE+-]/g, '');
  if (!/\d/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
export const round = (v, d = 6) => (v === null || v === undefined ? v : Math.round(v * 10 ** d) / 10 ** d);

// ── 單位 ──
let unitCache = null;
export function units() {
  if (!unitCache) unitCache = new Map(q.all('SELECT * FROM units').map((u) => [u.code, u]));
  return unitCache;
}
export function invalidateUnits() { unitCache = null; }
// 單位別名（院方 Excel 常見寫法）
const ALIAS = { '度': 'kWh', 'kwh': 'kWh', 'KWH': 'kWh', '公升': 'L', 'l': 'L', '公秉': 'kL', 'kl': 'kL', '立方公尺': 'm3', 'm³': 'm3', 'M3': 'm3',
  '公斤': 'kg', 'KG': 'kg', '公噸': 't', '元': 'TWD', 'NT$': 'TWD', '小時': 'h', '公里': 'km', '%': 'pct', '人': 'person', '人次': 'visit', '床': 'bed',
  '平方公尺': 'm2', 'm²': 'm2', '坪': 'ping', 'Nm³': 'Nm3', '瓶': 'cylinder', '次': 'count', '個': 'count' };
// stdUnit：同一個字在不同面向意思不同（「度」在電是 kWh、在水是 m³）
export function normUnit(u, stdUnit) {
  if (!u) return u;
  const s = String(u).trim();
  if (s === '度' && stdUnit && ['m3', 'Nm3'].includes(stdUnit)) return stdUnit;
  return units().has(s) ? s : ALIAS[s] || ALIAS[s.toLowerCase()] || s;
}
// 回 { ok, value, factor } 或 { ok:false, msg }
export function convert(value, from, to) {
  const f = units().get(normUnit(from)); const t = units().get(normUnit(to));
  if (!f || !t) return { ok: false, msg: `不認得的單位「${!f ? from : to}」` };
  // 同維度，或水/氣的立方公尺互通（帳單「度」）
  const dimOk = f.dimension === t.dimension || (['volume_w', 'volume_g'].includes(f.dimension) && ['volume_w', 'volume_g'].includes(t.dimension));
  if (!dimOk) return { ok: false, msg: `${f.name} 無法換算成 ${t.name}` };
  const factor = f.to_base / t.to_base;
  return { ok: true, value: value === undefined ? undefined : value * factor, factor };
}

// ── 期間：一律半開 [start, end)，日期字串 YYYY-MM-DD ──
const DAY = 86400000;
export const parseDate = (s) => Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`);
export const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
export function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(parseDate(s)); }
export const days = (start, end) => Math.round((parseDate(end) - parseDate(start)) / DAY);
export const addDays = (s, n) => fmtDate(parseDate(s) + n * DAY);
// 畫面上的「迄日」是含當日；存成半開要 +1 天
export const inclusiveEndToExclusive = (s) => addDays(s, 1);
export const exclusiveEndToInclusive = (s) => addDays(s, -1);
export function monthStart(s) { return `${String(s).slice(0, 7)}-01`; }
export function nextMonth(s) {
  const [y, m] = String(s).slice(0, 7).split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
export const isCalendarMonth = (start, end) => start.endsWith('-01') && nextMonth(start) === end;
export function yearRange(y) { return [`${y}-01-01`, `${y + 1}-01-01`]; }
export function overlaps(a0, a1, b0, b1) { return a0 < b1 && b0 < a1; }

// 依日數比例把區間值分攤到自然月（規則 alloc.daily_prorata v1）
export function allocateMonthly(start, end, value) {
  const total = days(start, end);
  if (total <= 0) return [];
  const out = [];
  let cur = start;
  while (cur < end) {
    const mEnd = nextMonth(cur) < end ? nextMonth(cur) : end;
    const d = days(cur, mEnd);
    out.push({ period_start: monthStart(cur), period_end: nextMonth(cur), part_start: cur, part_end: mEnd, days: d, share: d / total,
      value: value === undefined || value === null ? value : value * (d / total) });
    cur = mEnd;
  }
  return out;
}

export function j(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

export const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// 遮罩：電號、水號等外部識別碼只露末 3 碼
export function mask(s) {
  if (!s) return s;
  const str = String(s);
  return str.length <= 3 ? '•••' : '•'.repeat(Math.min(6, str.length - 3)) + str.slice(-3);
}
