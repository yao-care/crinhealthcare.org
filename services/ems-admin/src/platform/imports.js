// 檔案匯入（PRD §10.1、§19）：上傳 → 欄位映射 → 預覽與錯誤清單 → 提交 → 可整批撤銷 → 移轉簽收。
// 原始檔一律進證據庫（雜湊）；每列保留來源座標（工作表、列號）。
import { q, insert, update, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, orgsFor } from './authz.js';
import { bad, notFound, conflict, isDate, inclusiveEndToExclusive, toNumber, j } from './util.js';
import { readWorkbook, parseRef, buildWorkbook } from '../xlsx.js';
import { storeEvidence } from './evidence.js';
import { addObservation } from './observations.js';
import { createAsset } from './assets.js';
import { WORKBOOK_MAP } from './seed/dictionary.js';

// ── 解析 ──
function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; continue; }
    if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// 回 { sheets: [{ name, rows: [[...]] , rowNos: [...] }] }
export function parseTable(filename, buf) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') { const rows = csvRows(buf.toString('utf8')); return { sheets: [{ name: 'CSV', rows, rowNos: rows.map((_, i) => i + 1) }] }; }
  if (ext === 'xlsx') {
    const wb = readWorkbook(buf);
    const sheets = [];
    for (const [name, sh] of wb.sheets) {
      const grid = new Map();
      for (const [ref, v] of sh.cells) { const { col, row } = parseRef(ref); if (!grid.has(row)) grid.set(row, []); grid.get(row)[col - 1] = v; }
      const rowNos = [...grid.keys()].sort((a, b) => a - b);
      sheets.push({ name, rows: rowNos.map((r) => Array.from(grid.get(r), (x) => x ?? '')), rowNos });
    }
    return { sheets };
  }
  throw bad('匯入只接受 CSV 或 XLSX（ODS 請先另存為 XLSX）');
}

// 標準觀測匯入欄位
export const OBS_COLUMNS = [
  { key: 'asset', label: '標的（代碼或識別碼）', required: true }, { key: 'metric', label: '指標代碼', required: true },
  { key: 'start', label: '起日', required: true }, { key: 'end', label: '迄日（含）', required: true },
  { key: 'value', label: '數值' }, { key: 'unit', label: '單位' }, { key: 'state', label: '值狀態（實測／零／估計／缺漏／不適用／未知）' },
  { key: 'key', label: '來源紀錄鍵（重送時用來去重）' }, { key: 'meterEvent', label: '表計事件（換表／歸零／回轉）' }, { key: 'note', label: '備註' },
];
const STATE_ZH = { 實測: 'measured', 零: 'zero', 實際為零: 'zero', 估計: 'estimated', 缺漏: 'missing', 不適用: 'not_applicable', 未知: 'unknown' };
const EVENT_ZH = { 換表: 'replace', 歸零: 'reset', 回轉: 'rollover', '': 'none' };

function excelDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) { const [y, m, d] = s.split(/[-/]/).map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  const roc = /^(\d{2,3})[./年](\d{1,2})[./月](\d{1,2})日?$/.exec(s);
  if (roc) return `${Number(roc[1]) + 1911}-${roc[2].padStart(2, '0')}-${roc[3].padStart(2, '0')}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) { const t = Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000; return new Date(t).toISOString().slice(0, 10); }
  return s;
}

// 依表頭自動對應欄位（表頭文字含欄位名稱即可）
function autoMapping(header) {
  const map = {};
  header.forEach((h, i) => {
    const t = String(h || '').trim();
    const col = OBS_COLUMNS.find((c) => t && (t === c.key || t.startsWith(c.label.split('（')[0])));
    if (col && map[col.key] === undefined) map[col.key] = i;
  });
  return map;
}

export function mapRows(orgId, table, mapping) {
  const sh = table.sheets[0];
  if (!sh || sh.rows.length < 2) return { rows: [], errors: [{ row: 0, msg: '檔案沒有資料列' }], mapping: {} };
  const map = mapping || autoMapping(sh.rows[0]);
  const missing = OBS_COLUMNS.filter((c) => c.required && map[c.key] === undefined);
  if (missing.length) return { rows: [], errors: [{ row: 1, msg: `表頭缺少欄位：${missing.map((c) => c.label).join('、')}` }], mapping: map };
  const rows = []; const errors = [];
  sh.rows.slice(1).forEach((r, i) => {
    const rowNo = sh.rowNos[i + 1];
    const g = (k) => (map[k] === undefined ? '' : String(r[map[k]] ?? '').trim());
    const assetRef = g('asset');
    const a = q.get("SELECT id, name FROM assets WHERE org_id = ? AND (id = ? OR external_key = ? OR legacy_ref = ?) AND status <> 'archived'", orgId, assetRef, assetRef, assetRef);
    const start = excelDate(g('start')); const endIncl = excelDate(g('end'));
    const m = q.get('SELECT code, value_kind FROM metrics WHERE code = ? OR name = ?', g('metric'), g('metric'));
    const errs = [];
    if (!a) errs.push(`找不到標的「${assetRef}」`);
    if (!m) errs.push(`找不到指標「${g('metric')}」`);
    if (!isDate(start) || !isDate(endIncl)) errs.push('日期格式錯誤（YYYY-MM-DD 或民國 114/3/1）');
    const state = STATE_ZH[g('state')] || g('state') || 'measured';
    if (['measured', 'estimated'].includes(state) && toNumber(g('value')) === undefined) errs.push('數值空白（不知道請填值狀態「未知」或「缺漏」，不要填 0）');
    if (errs.length) { errors.push({ row: rowNo, msg: errs.join('；') }); return; }
    const end = ['stock', 'cumulative'].includes(m.value_kind) ? endIncl : inclusiveEndToExclusive(endIncl);
    rows.push({ _row: rowNo, _sheet: sh.name, asset_id: a.id, asset_name: a.name, metric_code: m.code, period_start: start, period_end: end, raw_value: g('value') || null,
      raw_unit: g('unit') || null, value_state: state, source_record_key: g('key') || null, meter_event: EVENT_ZH[g('meterEvent')] ?? g('meterEvent') ?? 'none', note: g('note') || null });
  });
  return { rows, errors, mapping: map };
}

// ── 匯入工作 ──
export async function uploadImport(ctx, { orgId, filename, data, kind = 'observations', sourceId }) {
  assertCan(ctx, 'import.write', orgId);
  if (!['observations', 'ghg_workbook', 'assets'].includes(kind)) throw bad('不認得的匯入類型');
  const ev = await storeEvidence(ctx, { orgId, filename, data, kind: kind === 'ghg_workbook' ? '歷史碳盤查工作簿' : '匯入原始檔', confidentiality: 'internal', sourceId }, { skipCheck: true });
  const table = parseTable(filename, data);
  const id = newId('imp');
  let preview; let errors; let mapping = null;
  if (kind === 'observations') { const r = mapRows(orgId, table, null); preview = r.rows; errors = r.errors; mapping = r.mapping; }
  else if (kind === 'assets') { const r = mapAssetRows(orgId, table); preview = r.rows; errors = r.errors; }
  else { const r = mapGhgWorkbook(table, filename); preview = r.rows; errors = r.errors; }
  insert('import_jobs', { id, org_id: orgId, kind, filename, evidence_id: ev.id, mapping, preview: { rows: preview, sourceId: sourceId || null }, errors,
    status: 'previewed', stats: { rows: preview.length, errors: errors.length }, created_by: ctx.userId, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'import.upload', targetType: 'import_job', targetId: id, after: { kind, filename, rows: preview.length, errors: errors.length } });
  return { id, rows: preview.length, errors, preview: preview.slice(0, 200), mapping, duplicateFile: !!ev.duplicate };
}

// 改欄位對應後重新預覽
export async function remapImport(ctx, id, mapping) {
  const jb = q.get('SELECT * FROM import_jobs WHERE id = ?', id); if (!jb) throw notFound('匯入工作');
  assertCan(ctx, 'import.write', jb.org_id);
  if (jb.status !== 'previewed' || jb.kind !== 'observations') throw conflict('只有預覽中的觀測匯入可以改對應');
  const ev = q.get('SELECT * FROM evidence_files WHERE id = ?', jb.evidence_id);
  const { readFile } = await import('node:fs/promises');
  const r = mapRows(jb.org_id, parseTable(jb.filename, await readFile(ev.storage_key)), mapping);
  update('import_jobs', id, { mapping: r.mapping, preview: { rows: r.rows, sourceId: j(jb.preview, {}).sourceId }, errors: r.errors, stats: { rows: r.rows.length, errors: r.errors.length } });
  return { id, rows: r.rows.length, errors: r.errors, preview: r.rows.slice(0, 200), mapping: r.mapping };
}

export function getImport(ctx, id) {
  const jb = q.get('SELECT * FROM import_jobs WHERE id = ?', id); if (!jb) throw notFound('匯入工作');
  assertCan(ctx, 'view.internal', jb.org_id);
  const p = parseJson(jb, ['mapping', 'preview', 'errors', 'stats']);
  return { ...p, preview: { ...p.preview, rows: (p.preview?.rows || []).slice(0, 500) } };
}
export function listImports(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT id, kind, filename, status, stats, created_at, committed_at, reverted_at, signed_off_at FROM import_jobs WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', orgId).map((r) => parseJson(r, ['stats']));
}

export function commitImport(ctx, id, { allowErrors = false } = {}) {
  const jb = q.get('SELECT * FROM import_jobs WHERE id = ?', id); if (!jb) throw notFound('匯入工作');
  assertCan(ctx, 'import.write', jb.org_id);
  if (jb.status !== 'previewed') throw conflict('此匯入已提交或撤銷');
  const errors = j(jb.errors, []);
  if (errors.length && !allowErrors) throw conflict(`有 ${errors.length} 列錯誤；請修正後重新上傳，或確認只匯入正確的列`, { errors });
  const pv = j(jb.preview, {}); const rows = pv.rows || [];
  const stats = { created: 0, duplicate: 0, new_version: 0, failed: 0 };
  tx(() => {
    if (jb.kind === 'observations') {
      for (const r of rows) {
        try {
          const res = addObservation(ctx, { assetId: r.asset_id, metricCode: r.metric_code, periodStart: r.period_start, periodEnd: r.period_end, rawValue: r.raw_value, rawUnit: r.raw_unit,
            valueState: r.value_state, meterEvent: r.meter_event, note: r.note, sourceId: pv.sourceId || undefined,
            sourceRecordKey: r.source_record_key || `import:${jb.evidence_id}:${r._sheet}:${r._row}` }, { method: 'import', importJobId: id, evidenceIds: [jb.evidence_id] });
          stats[res.status]++;
        } catch (e) { stats.failed++; errors.push({ row: r._row, msg: e.message }); }
      }
    } else if (jb.kind === 'assets') {
      for (const r of rows) {
        try { createAsset(ctx, { ...r, orgId: jb.org_id, reason: `匯入 ${jb.filename} 第 ${r._row} 列`, legacyRef: undefined }); stats.created++; }
        catch (e) { stats.failed++; errors.push({ row: r._row, msg: e.message }); }
      }
    } else {
      for (const r of rows) {
        if (q.get('SELECT 1 FROM reference_activities WHERE workbook = ? AND sheet = ? AND row_no = ?', r.workbook, r.sheet, r.row_no)) { stats.duplicate++; continue; }
        insert('reference_activities', { id: newId('ref'), ...r, import_job_id: id, created_at: nowIso() }); stats.created++;
      }
    }
    update('import_jobs', id, { status: 'committed', committed_at: nowIso(), committed_by: ctx.userId, stats: { ...j(jb.stats, {}), ...stats }, errors });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: jb.org_id, action: 'import.commit', targetType: 'import_job', targetId: id, after: stats });
  });
  return stats;
}

// 整批撤銷：此匯入建立的觀測標 superseded（不刪，保留稽核），已被採用的不能撤
export function revertImport(ctx, id, { reason }) {
  const jb = q.get('SELECT * FROM import_jobs WHERE id = ?', id); if (!jb) throw notFound('匯入工作');
  assertCan(ctx, 'import.write', jb.org_id);
  if (jb.status !== 'committed') throw conflict('只有已提交的匯入可以撤銷');
  if (!reason) throw bad('撤銷需填原因');
  const obs = q.all('SELECT id FROM observations WHERE import_job_id = ?', id).map((r) => r.id);
  const used = obs.filter((oid) => q.get('SELECT 1 FROM approved_facts WHERE observation_ids LIKE ? AND is_current = 1', `%${oid}%`));
  if (used.length) throw conflict(`有 ${used.length} 筆已成為採用值，不能整批撤銷；請改以裁決處理`);
  tx(() => {
    for (const oid of obs) q.run("UPDATE observations SET quality_status = 'superseded', note = COALESCE(note,'') || ? WHERE id = ?", `（匯入撤銷：${reason}）`, oid);
    if (jb.kind === 'ghg_workbook') q.run('DELETE FROM reference_activities WHERE import_job_id = ?', id);
    update('import_jobs', id, { status: 'reverted', reverted_at: nowIso(), reverted_by: ctx.userId });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: jb.org_id, action: 'import.revert', targetType: 'import_job', targetId: id, after: { reason, observations: obs.length } });
  });
  return { reverted: obs.length };
}

// 移轉結果簽收（PRD §19.2 第 6 點）
export function signOffImport(ctx, id) {
  const jb = q.get('SELECT * FROM import_jobs WHERE id = ?', id); if (!jb) throw notFound('匯入工作');
  assertCan(ctx, 'dataset.approve', jb.org_id);
  if (jb.status !== 'committed') throw conflict('只有已提交的匯入可以簽收');
  if (jb.committed_by === ctx.userId) throw conflict('簽收者不可以是提交者');
  update('import_jobs', id, { signed_off_by: ctx.userId, signed_off_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: jb.org_id, action: 'import.sign_off', targetType: 'import_job', targetId: id });
}

// ── 標的批次匯入 ──
export const ASSET_COLUMNS = ['盤點項目代碼', '標的類型', '標的名稱', '識別碼（電號／水號／車牌等）', '識別碼是否敏感（是／否）', '建物位置', '樓層', '表計倍率', '是否共用（是／否）', '是否租賃（是／否）', '燃料或冷媒（diesel／R-410A…）'];
function mapAssetRows(orgId, table) {
  const sh = table.sheets[0]; const rows = []; const errors = [];
  (sh?.rows || []).slice(1).forEach((r, i) => {
    const rowNo = sh.rowNos[i + 1];
    const item = q.get('SELECT * FROM inventory_items WHERE code = ? OR name = ?', String(r[0] || '').trim(), String(r[0] || '').trim());
    if (!item) { errors.push({ row: rowNo, msg: `找不到盤點項目「${r[0] || ''}」` }); return; }
    if (!r[2]) { errors.push({ row: rowNo, msg: '缺標的名稱' }); return; }
    const types = j(item.asset_types, []);
    const t = String(r[1] || '').trim() || types[0];
    const yes = (v) => /^(是|y|yes|true|1)$/i.test(String(v || '').trim());
    const fuel = String(r[10] || '').trim();
    rows.push({ _row: rowNo, itemId: item.id, domain: item.domain, assetType: t, name: String(r[2]).trim(), externalKey: String(r[3] || '').trim() || null,
      externalKeySensitive: yes(r[4]), location: r[5] || null, floor: r[6] || null, meterMultiplier: toNumber(r[7]) || 1, shared: yes(r[8]), leased: yes(r[9]),
      attrs: fuel ? (/^R-|HFC|HCFC|CO2/i.test(fuel) ? { refrigerant: fuel } : { fuel }) : {} });
  });
  return { rows, errors };
}
export function assetTemplate() {
  return buildWorkbook([{ name: '標的', rows: [ASSET_COLUMNS.map((v) => ({ v, s: 'head' })), ['ELE-GRID', 'power_account', '主電號', '01234567890', '是', '行政大樓', 'B1', '1', '否', '否', ''],
    ['OIL-GEN', 'generator', '1 號緊急發電機', 'GEN-01', '否', '機房', 'B2', '1', '否', '否', 'diesel']], cols: [14, 16, 20, 24, 12, 14, 8, 10, 10, 10, 18] }]).buffer;
}
export function observationTemplate() {
  return buildWorkbook([{ name: '觀測值', rows: [OBS_COLUMNS.map((c) => ({ v: c.label, s: 'head' })),
    ['01234567890', 'elec_purchased_kwh', '2026-09-28', '2026-10-27', '103200', 'kWh', '實測', 'TPC-202610', '', '台電帳單'],
    ['GEN-TANK-01', 'oil_stock_l', '2026-10-31', '2026-10-31', '1800', 'L', '實測', '', '', '月底量測']], cols: [20, 24, 12, 12, 12, 8, 14, 18, 14, 20] }]).buffer;
}

// ── M14：歷史碳盤查工作簿 → 盤查參照（保留原始座標，不直接當已驗證來源）──
function mapGhgWorkbook(table, filename) {
  const rows = []; const errors = [];
  for (const sh of table.sheets) {
    let scope = ''; let category = '';
    sh.rows.forEach((r, i) => {
      const rowNo = sh.rowNos[i];
      const cells = { A: r[0] || '', B: r[1] || '', C: r[2] || '', D: r[3] || '', E: r[4] || '' };
      if (/^範疇[一二三]$/.test(String(cells.A).trim())) scope = String(cells.A).trim();
      if (/^類別[一二三四五六]$/.test(String(cells.B).trim())) category = String(cells.B).trim();
      const act = String(cells.C).trim();
      if (!act || act === '活動來源' || /^註/.test(String(cells.A))) return;
      const hit = WORKBOOK_MAP.find(([kw]) => act.replace(/\s/g, '').includes(kw.replace(/\s/g, '')));
      const codes = hit ? hit[1] : [];
      const domains = [...new Set(codes.map((c) => q.get('SELECT domain FROM inventory_items WHERE code = ?', c)?.domain).filter(Boolean))];
      if (!hit) errors.push({ row: rowNo, msg: `無對應盤點項目：「${act}」（保留為參照，請人工指定）`, severity: 'warning' });
      rows.push({ workbook: filename, sheet: sh.name, row_no: rowNo, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [`${k}${rowNo}`, v])),
        scope, category, activity: act, required_data: String(cells.D).trim() || null, note: String(cells.E).trim() || null, item_codes: codes,
        domain_hint: domains.length === 1 ? domains[0] : domains.join(',') || 'reference' });
    });
  }
  return { rows, errors };
}

export function listReferenceActivities(ctx) {
  const global = ctx.grants.some((g) => g.scope_type === 'global');
  const orgs = new Set(orgsFor(ctx, 'view.internal'));
  return q.all('SELECT r.*, j.org_id FROM reference_activities r LEFT JOIN import_jobs j ON j.id = r.import_job_id ORDER BY workbook, sheet, row_no')
    .filter((r) => global || !r.org_id || orgs.has(r.org_id)).map((r) => parseJson(r, ['cells', 'item_codes']));
}
// 參照項目人工指定盤點項目（適用性仍由使用者確認，不由機器直接認定）
export function setReferenceMapping(ctx, id, itemCodes) {
  assertCan(ctx, 'config.write', null);
  const r = q.get('SELECT * FROM reference_activities WHERE id = ?', id); if (!r) throw notFound('參照項目');
  for (const c of itemCodes) if (!q.get('SELECT 1 FROM inventory_items WHERE code = ?', c)) throw bad(`盤點項目 ${c} 不存在`);
  update('reference_activities', id, { item_codes: itemCodes });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'reference.map', targetType: 'reference', targetId: id, before: { item_codes: r.item_codes }, after: { itemCodes } });
}
