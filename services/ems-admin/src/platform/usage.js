// 電號用電速覽：前日、上月、前年三個數字，加上台電高壓智慧電表（AMI）檔案匯入。
//
// 資料來源優先序：
//   前日：elec_metered_kwh 的每日值（AMI 每 15 分鐘資料匯入時已彙成一天一筆）
//   上月：該月每天都有 AMI 值就加總；不齊就用計費期間大半落在該月的電費單（elec_purchased_kwh）
//   前年：電費單（或盤查的全年值）依天數比例分攤到該年；沒有帳單才用 AMI 加總
// 之後新電號（attrs.inServiceFrom）還沒啟用的年月不算進全院合計。
import { q, nowIso, newId, insert } from './db.js';
import { assertCan } from './authz.js';
import { bad, notFound, addDays, parseDate, days, isDate } from './util.js';
import { addObservation } from './observations.js';
import { parseTable } from './imports.js';

const LIVE = "quality_status NOT IN ('superseded','invalid') AND value_state IN ('measured','estimated','zero') AND value_std IS NOT NULL";
const overlapDays = (a0, a1, b0, b1) => Math.max(0, days(a0 < b0 ? b0 : a0, a1 < b1 ? a1 : b1));

// 同一期間有多個來源（例：帳單與盤查全年值）時只取一筆：優先序高（數字小）者
function dedupe(rows) {
  const by = new Map();
  for (const r of rows) { const k = `${r.period_start}|${r.period_end}`; const p = by.get(k); if (!p || r.priority < p.priority) by.set(k, r); }
  return [...by.values()];
}
function obs(assetId, metric, from, to) {
  return dedupe(q.all(`SELECT o.period_start, o.period_end, o.value_std, COALESCE(s.priority, 50) AS priority FROM observations o LEFT JOIN data_sources s ON s.id = o.source_id
    WHERE o.asset_id = ? AND o.metric_code = ? AND o.period_start < ? AND o.period_end > ? AND ${LIVE}`, assetId, metric, to, from));
}
// AMI 每日值：Map 日期 → kWh（只收剛好一天的區間）
function dailyMap(assetId, from, to) {
  const m = new Map();
  for (const r of obs(assetId, 'elec_metered_kwh', from, to)) if (days(r.period_start, r.period_end) === 1) m.set(r.period_start, r.value_std);
  return m;
}
// 帳單依天數比例分攤到 [from, to)
function billShare(assetId, from, to) {
  let v = 0; let covered = 0;
  for (const r of obs(assetId, 'elec_purchased_kwh', from, to)) {
    const span = days(r.period_start, r.period_end); const ov = overlapDays(r.period_start, r.period_end, from, to);
    if (span > 0 && ov > 0) { v += r.value_std * ov / span; covered += ov; }
  }
  return covered ? { kwh: v, coveredDays: covered } : null;
}
// 上月：用電月份歸屬（帳單計費期間大半落在該月者算該月，與盤查「帳單月份為實際用電月份次月」同一原則）
function monthBill(assetId, from, to) {
  const rows = obs(assetId, 'elec_purchased_kwh', addDays(from, -20), addDays(to, 20)).filter((r) => days(r.period_start, r.period_end) <= 40);
  const hit = rows.map((r) => ({ r, ov: overlapDays(r.period_start, r.period_end, from, to) })).filter((x) => x.ov * 2 > days(x.r.period_start, x.r.period_end)).sort((a, b) => b.ov - a.ov)[0];
  return hit ? { kwh: hit.r.value_std, periodStart: hit.r.period_start, periodEnd: addDays(hit.r.period_end, -1) } : null;
}

function inService(asset, ym) {
  let attrs = {}; try { attrs = typeof asset.attrs === 'string' ? JSON.parse(asset.attrs || '{}') : asset.attrs || {}; } catch { /* 壞的 attrs 視為無 */ }
  const from = String(attrs.inServiceFrom || '').slice(0, 7);
  return !from || from <= ym;
}

function oneAccount(asset, today) {
  const y1 = addDays(today, -1);
  // 前日：昨天有值就是昨天；沒有就往回找最近一天（AMI 隔日才上傳），標出日期
  const recent = dailyMap(asset.id, addDays(today, -15), today);
  const lastDay = [...recent.keys()].sort().pop() || null;
  const day = recent.has(y1) ? { date: y1, kwh: recent.get(y1), source: 'ami' } : lastDay ? { date: lastDay, kwh: recent.get(lastDay), source: 'ami', stale: true } : null;
  // 上月
  const m0 = `${today.slice(0, 7)}-01`; const pm0 = (() => { const [y, m] = m0.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; })();
  const md = dailyMap(asset.id, pm0, m0); const need = days(pm0, m0);
  let month = null;
  if (md.size === need) month = { month: pm0.slice(0, 7), kwh: [...md.values()].reduce((s, v) => s + v, 0), source: 'ami' };
  else { const b = monthBill(asset.id, pm0, m0); if (b) month = { month: pm0.slice(0, 7), kwh: b.kwh, source: 'bill', billPeriod: [b.periodStart, b.periodEnd] }; else if (md.size) month = { month: pm0.slice(0, 7), kwh: [...md.values()].reduce((s, v) => s + v, 0), source: 'ami', partialDays: md.size, needDays: need }; }
  // 前年
  const py = Number(today.slice(0, 4)) - 1; const ys = `${py}-01-01`; const ye = `${py + 1}-01-01`;
  const yb = billShare(asset.id, ys, ye); const yd = dailyMap(asset.id, ys, ye); const ydays = days(ys, ye);
  let year = null;
  if (yb && yb.coveredDays >= yd.size) year = { year: py, kwh: yb.kwh, source: 'bill', ...(yb.coveredDays < ydays ? { partialDays: yb.coveredDays, needDays: ydays } : {}) };
  else if (yd.size) year = { year: py, kwh: [...yd.values()].reduce((s, v) => s + v, 0), source: 'ami', ...(yd.size < ydays ? { partialDays: yd.size, needDays: ydays } : {}) };
  return { day, month, year };
}

// 全院合計：取各電號最新的同一個日期／月份／年份相加。那個時點還沒啟用的電號不算；有啟用卻沒資料的電號，標在 accounts／of
const TAG = { day: (x) => x.date, month: (x) => x.month, year: (x) => String(x.year) };
const YM = { day: (t) => t.slice(0, 7), month: (t) => t, year: (t) => `${t}-12` };
function combine(parts, k) {
  const have = parts.filter((p) => p[k] && inService(p.a, YM[k](TAG[k](p[k]))));
  if (!have.length) return null;
  const target = have.map((p) => TAG[k](p[k])).sort().pop();
  const same = have.filter((p) => TAG[k](p[k]) === target).map((p) => p[k]);
  const of = parts.filter((p) => inService(p.a, YM[k](target))).length;
  const out = { ...same[0], kwh: same.reduce((s, v) => s + v.kwh, 0), source: [...new Set(same.map((v) => v.source))].join('+'), accounts: same.length, of };
  if (same.length > 1) delete out.billPeriod;
  return out;
}

export function usageSummary({ orgId, assetId, today = new Date().toISOString().slice(0, 10) }) {
  const accts = assetId
    ? [q.get("SELECT * FROM assets WHERE id = ? AND asset_type = 'power_account'", assetId)].filter(Boolean)
    : q.all("SELECT * FROM assets WHERE org_id = ? AND asset_type = 'power_account' AND status <> 'archived'", orgId);
  if (assetId && !accts.length) return null;
  const parts = accts.map((a) => ({ a, ...oneAccount(a, today) }));
  return { today, day: combine(parts, 'day'), month: combine(parts, 'month'), year: combine(parts, 'year') };
}

export function usageForAsset(ctx, id, today) {
  const a = q.get('SELECT org_id, asset_type FROM assets WHERE id = ?', id);
  if (!a) throw notFound('標的');
  assertCan(ctx, 'view.internal', a.org_id);
  return a.asset_type === 'power_account' ? usageSummary({ assetId: id, today }) : null;
}

// 看板公開用：只回三個彙總數字（不含電號、帳單期間以外的細節）
export function publicUsage(hid, today) {
  const o = q.get('SELECT id FROM organizations WHERE code = ?', String(hid));
  if (!o) throw notFound('院所');
  const s = usageSummary({ orgId: o.id, today });
  const pick = (x, keys) => (x ? Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : null);
  return { today: s.today, day: pick(s.day, ['date', 'kwh', 'stale']), month: pick(s.month, ['month', 'kwh', 'source', 'partialDays', 'needDays']),
    year: pick(s.year, ['year', 'kwh', 'partialDays', 'needDays']) };
}

// ── 台電高壓智慧電表（AMI）檔案 ──
// 台電高壓用戶服務入口網站下載的用電資料。欄位格式沒有公開規格，這裡容錯解析：
//   直式：一列一個時間點（日期＋時間或日期時間一欄）＋度數（kWh）或需量（kW）欄
//   橫式：一列一天，欄位是 00:15、00:30…24:00
//   日資料：一列一天＋度數欄
// 時間點以「區間結束」計（00:00／24:00 屬前一天）。kW 需量值 × 區間長度換成 kWh。
const pad = (n) => String(n).padStart(2, '0');
function parseDay(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{2,3})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(t); if (m) return `${Number(m[1]) + 1911}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{4})(\d{2})(\d{2})(?!\d)/.exec(t); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(t)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86400000).toISOString().slice(0, 10);
  return null;
}
function parseTime(s) {
  const t = String(s ?? '').trim();
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(t); if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^0?\.\d+$/.test(t)) return Math.round(Number(t) * 1440);   // Excel 時間小數
  return null;
}
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : n; };

export function parseAmi(table) {
  for (const sh of table.sheets) {
    const rows = sh.rows;
    const hi = rows.slice(0, 15).findIndex((r) => r.some((c) => /日期|時間|date|time/i.test(String(c))));
    if (hi < 0) continue;
    const head = rows[hi].map((c) => String(c ?? '').trim());
    const body = rows.slice(hi + 1);
    const sheetText = rows.slice(0, hi + 1).flat().join(' ');
    // 橫式：表頭有一串 HH:MM
    const timeCols = head.map((h, i) => ({ i, t: /^\d{1,2}:\d{2}$/.test(h) ? parseTime(h) : null })).filter((x) => x.t !== null);
    const dateCol = head.findIndex((h) => /日期|date/i.test(h));
    if (timeCols.length >= 24 && dateCol >= 0) {
      const step = (24 * 60) / timeCols.length; const kw = /kW(?!h)|需量/i.test(sheetText) && !/kWh|度/i.test(sheetText);
      const out = new Map();
      for (const r of body) {
        const d = parseDay(r[dateCol]); if (!d) continue;
        const vals = timeCols.map((c) => num(r[c.i])).filter((v) => v !== null);
        if (!vals.length) continue;
        out.set(d, { kwh: vals.reduce((s, v) => s + v, 0) * (kw ? step / 60 : 1), n: vals.length, need: timeCols.length });
      }
      if (out.size) return { days: out, layout: 'wide', unit: kw ? 'kW' : 'kWh', intervalMin: step };
    }
    // 直式
    const timeCol = head.findIndex((h, i) => i !== dateCol && /時間|time/i.test(h));
    const dtCol = dateCol >= 0 ? dateCol : timeCol;
    const isVal = (h) => !/kvar|無效|功因|pf|累計|電壓|電流|日期|時間|date|time/i.test(h);
    const kwhCols = head.map((h, i) => i).filter((i) => /kWh|度數|用電量|電量/i.test(head[i]) && isVal(head[i]));
    const totalKwh = kwhCols.filter((i) => /總|合計|total/i.test(head[i]));
    const kwCols = head.map((h, i) => i).filter((i) => /kW(?!h)|需量/i.test(head[i]) && isVal(head[i]));
    const useCols = totalKwh.length ? totalKwh.slice(0, 1) : kwhCols.length ? kwhCols : kwCols.slice(0, 1);
    const kw = !kwhCols.length && kwCols.length > 0;
    if (dtCol < 0 || !useCols.length) continue;
    const pts = [];
    for (const r of body) {
      const d = parseDay(r[dtCol]); if (!d) continue;
      const tm = timeCol >= 0 && timeCol !== dtCol ? parseTime(r[timeCol]) : parseTime(r[dtCol]);
      const vs = useCols.map((i) => num(r[i])).filter((v) => v !== null);
      if (!vs.length) continue;
      pts.push({ d, tm, v: vs.reduce((s, v) => s + v, 0) });
    }
    if (!pts.length) continue;
    const timed = pts.filter((p) => p.tm !== null);
    if (timed.length < pts.length / 2) {   // 日資料
      const out = new Map(); for (const p of pts) out.set(p.d, { kwh: p.v, n: 1, need: 1 });
      return { days: out, layout: 'daily', unit: 'kWh', intervalMin: 1440 };
    }
    // 區間長度：最常見的相鄰差
    const abs = timed.map((p) => parseDate(p.d) / 60000 + p.tm).sort((a, b) => a - b);
    const diffs = new Map(); for (let i = 1; i < abs.length; i++) { const df = abs[i] - abs[i - 1]; if (df > 0 && df <= 60) diffs.set(df, (diffs.get(df) || 0) + 1); }
    const step = [...diffs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 15;
    const out = new Map();
    for (const p of timed) {
      const end = parseDate(p.d) + p.tm * 60000;            // 區間結束時刻
      const day = new Date(end - 60000).toISOString().slice(0, 10);   // 00:00／24:00 屬前一天
      const e = out.get(day) || { kwh: 0, n: 0, need: 1440 / step }; e.kwh += kw ? p.v * step / 60 : p.v; e.n += 1; out.set(day, e);
    }
    return { days: out, layout: 'interval', unit: kw ? 'kW' : 'kWh', intervalMin: step };
  }
  throw bad('看不出這個檔案的格式：要有「日期」（或日期時間）欄，以及度數（kWh）或需量（kW）欄');
}

export function importAmi(ctx, { assetId, filename, data }) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!a) throw notFound('標的');
  assertCan(ctx, 'obs.write', a.org_id);
  if (a.asset_type !== 'power_account') throw bad('智慧電表資料要匯入到台電電號');
  const p = parseAmi(parseTable(filename, data));
  let src = q.get("SELECT * FROM data_sources WHERE asset_id = ? AND source_type = 'ems' AND name = ? AND active = 1", a.id, '台電智慧電表（AMI）');
  if (!src) {
    src = { id: newId('src'), org_id: a.org_id, asset_id: a.id, item_id: a.item_id, name: '台電智慧電表（AMI）', source_type: 'ems', acquisition: 'import', frequency: '每日',
      priority: 40, owner_status: 'unknown', note: '台電高壓用戶服務入口網站下載的用電資料', created_by: ctx?.userId || 'system', created_at: nowIso(), updated_at: nowIso() };
    insert('data_sources', src);
  }
  const stats = { created: 0, updated: 0, duplicate: 0, partial: [], from: null, to: null, layout: p.layout, unit: p.unit, intervalMin: p.intervalMin };
  for (const [d, e] of [...p.days.entries()].sort()) {
    if (!isDate(d)) continue;
    if (e.n < e.need) { stats.partial.push(`${d}（${e.n}/${e.need}）`); continue; }   // 不完整的一天不入帳，下次檔案補齊再匯
    const r = addObservation(ctx, { assetId: a.id, metricCode: 'elec_metered_kwh', periodStart: d, periodEnd: addDays(d, 1), rawValue: Math.round(e.kwh * 1000) / 1000, rawUnit: 'kWh',
      sourceId: src.id, sourceRecordKey: `ami:${d}`, note: p.intervalMin < 1440 ? `${p.intervalMin} 分鐘資料 ${e.n} 筆加總` : null }, { method: 'import' });
    stats[r.status === 'created' ? 'created' : r.status === 'new_version' ? 'updated' : 'duplicate']++;
    stats.from = stats.from || d; stats.to = d;
  }
  return stats;
}

