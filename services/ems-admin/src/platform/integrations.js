// 自動介接（PRD §10.1、§16.3）：可替換的 adapter；斷線告警、失敗重試、游標增量同步、去重。
// 不假設台電、水公司或政府平台有 API；沒有 API 就走檔案匯入。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, insert, update, newId, nowIso, audit, tx } from './db.js';
import { config } from '../config.js';
import { assertCan, orgById } from './authz.js';
import { bad, notFound, conflict, j, isDate, nextMonth } from './util.js';
import { addObservation } from './observations.js';
import { notifyRole } from './collab.js';
import { parseTable, mapRows } from './imports.js';

const MAX_FAILS = 5;

// ── 共用：找或建標的與來源（介接建立的都標 legacy_ref，方便追溯）──
function ensureAsset(orgId, { itemCode, assetType, name, externalKey, sensitive = false, legacyRef, domain, attrs }) {
  if (legacyRef) { const a = q.get('SELECT * FROM assets WHERE org_id = ? AND legacy_ref = ?', orgId, legacyRef); if (a) return a; }
  if (externalKey) { const a = q.get("SELECT * FROM assets WHERE org_id = ? AND asset_type = ? AND external_key = ? AND status <> 'archived'", orgId, assetType, externalKey); if (a) return a; }
  const item = q.get('SELECT * FROM inventory_items WHERE code = ?', itemCode);
  const site = q.get('SELECT id FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', orgId);
  const t = nowIso();
  const row = { id: newId('ast'), org_id: orgId, site_id: site?.id || null, item_id: item?.id || null, domain: domain || item?.domain, asset_type: assetType, name,
    external_key: externalKey || null, external_key_sensitive: sensitive ? 1 : 0, attrs: attrs || {}, applicability: 'applicable', work_status: 'collecting',
    owner_status: 'unknown', legacy_ref: legacyRef || null, created_by: 'integration', created_at: t, updated_at: t };
  insert('assets', row);
  insert('asset_history', { id: newId('ah'), asset_id: row.id, change_type: 'create', after: row, reason: '介接自動建立', actor: 'integration', effective_at: t.slice(0, 10), at: t });
  return row;
}
function ensureSource(orgId, assetId, { name, sourceType, acquisition, integrationId, priority = 50 }) {
  let s = q.get('SELECT * FROM data_sources WHERE asset_id = ? AND integration_id IS ? AND name = ?', assetId, integrationId || null, name);
  if (s) return s;
  s = { id: newId('src'), org_id: orgId, asset_id: assetId, name, source_type: sourceType, acquisition, priority, owner_status: 'unknown', integration_id: integrationId || null,
    created_by: 'integration', created_at: nowIso(), updated_at: nowIso() };
  insert('data_sources', s);
  return s;
}

// ── adapters：回 { stats, cursor } ──
const ADAPTERS = {
  // 舊健檢填報的電費單（已通過逐格複驗閘門、已送出的才會在檔案裡）
  async legacy_audit(intg, job) {
    const org = orgById(intg.org_id); if (!org?.legacy_hid) throw new Error('此組織沒有對應的舊院所代碼');
    const { readAudit } = await import('../audit-store.js');
    const audit = await readAudit(org.legacy_hid);
    const rows = audit.blocks?.bills?.rows || [];
    const stats = { rows: rows.length, created: 0, duplicate: 0, skipped: 0 };
    for (const r of rows) {
      const v = r.values || {}; const meta = r.meta || {};
      if (Object.values(meta).some((m) => ['todo', 'low'].includes(m?.state))) { stats.skipped++; continue; }
      if (!/^\d{4}-\d{2}$/.test(v.period || '') || !v.meterNo) { stats.skipped++; continue; }
      const asset = ensureAsset(intg.org_id, { itemCode: 'ELE-GRID', assetType: 'power_account', name: `台電電號 ${String(v.meterNo).slice(-4)}`, externalKey: String(v.meterNo), sensitive: true });
      const src = ensureSource(intg.org_id, asset.id, { name: '健檢填報·電費單', sourceType: 'bill', acquisition: 'import', integrationId: intg.id, priority: 80 });
      const ps = `${v.period}-01`; const pe = nextMonth(ps);
      const put = (metricCode, raw, unit) => {
        if (raw === undefined || raw === null || raw === '') return;
        const res = addObservation(null, { assetId: asset.id, metricCode, periodStart: ps, periodEnd: metricCode === 'elec_contract_kw' ? ps : pe, rawValue: raw, rawUnit: unit,
          sourceId: src.id, sourceRecordKey: `audit:${v.meterNo}:${v.period}:${metricCode}`, note: '來自電力健檢填報（已逐格複驗）' }, { method: 'legacy', syncJobId: job.id, skipCheck: true });
        stats[res.status === 'duplicate' ? 'duplicate' : 'created']++;
      };
      put('elec_purchased_kwh', v.useTotal, 'kWh'); put('elec_cost_twd', v.feeTotal, 'TWD'); put('elec_peak_demand_kw', v.maxDemand, 'kW'); put('elec_contract_kw', v.contractCapacity, 'kW');
    }
    return { stats, cursor: nowIso() };
  },

  // 舊貼紙點位抄表（定期更新）：讀數型項目 → 累積讀值觀測
  async legacy_inventory(intg, job) {
    const org = orgById(intg.org_id); if (!org?.legacy_hid) throw new Error('此組織沒有對應的舊院所代碼');
    const { readInventory } = await import('../inventory-store.js');
    const inv = await readInventory(org.legacy_hid);
    const since = intg.cursor || '';
    const stats = { records: 0, created: 0, duplicate: 0, skipped: 0 };
    let maxAt = since;
    const points = new Map((inv.points || []).map((p) => [p.code, p]));
    for (const rec of inv.records || []) {
      if (rec.at <= since) continue;
      stats.records++; if (rec.at > maxAt) maxAt = rec.at;
      const p = points.get(rec.pointCode); if (!p) { stats.skipped++; continue; }
      for (const it of p.items || []) {
        if (it.type !== 'reading') continue;
        const raw = rec.values?.[it.id]; if (raw === undefined || raw === null || raw === '') continue;
        const water = p.domain === 'water';
        const asset = ensureAsset(intg.org_id, { itemCode: water ? 'WAT-SUB' : 'ELE-SUB', assetType: water ? 'water_meter' : 'power_meter', name: `${p.name}·${it.label}`,
          legacyRef: `inv:${p.code}:${it.id}`, attrs: { pointCode: p.code, itemId: it.id, location: p.location } });
        const src = ensureSource(intg.org_id, asset.id, { name: '貼紙點位抄表', sourceType: 'manual', acquisition: 'manual', integrationId: intg.id, priority: 40 });
        const d = String(rec.at).slice(0, 10);
        const res = addObservation(null, { assetId: asset.id, metricCode: water ? 'water_meter_reading_m3' : 'elec_meter_reading_kwh', periodStart: d, periodEnd: d, rawValue: raw,
          rawUnit: water ? 'm3' : 'kWh', readingKind: 'cumulative', meterEvent: (rec.confirmDecrease || []).includes?.(it.id) ? 'replace' : 'none',
          sourceId: src.id, sourceRecordKey: `inv:${rec.id}:${it.id}`, note: `${rec.who || ''}${rec.note ? '；' + rec.note : ''}` }, { method: 'legacy', syncJobId: job.id, skipCheck: true });
        stats[res.status === 'duplicate' ? 'duplicate' : 'created']++;
      }
    }
    return { stats, cursor: maxAt };
  },

  // 儲能櫃 ems-bridge：只收 source=live；模擬資料不進正式觀測（allowSim 僅測試用，且標估計）
  async ems_bridge(intg, job) {
    const c = j(intg.config, {});
    const url = c.url || 'http://127.0.0.1:8460/api/ess';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    if (!body.ok) throw new Error(`ems-bridge 回報異常（${res.status}）`);
    if (body.source !== 'live' && !c.allowSim) return { stats: { skipped: 1, reason: '目前是模擬資料，不寫入觀測' }, cursor: intg.cursor };
    const asset = ensureAsset(intg.org_id, { itemCode: 'ELE-ESS', assetType: 'ess', name: c.assetName || '儲能櫃', legacyRef: `ess:${url}` });
    const src = ensureSource(intg.org_id, asset.id, { name: 'ems-bridge（Modbus）', sourceType: 'ems', acquisition: 'api', integrationId: intg.id, priority: 70 });
    const d = String(body.ts).slice(0, 10); const stats = { created: 0, duplicate: 0 };
    const est = body.source !== 'live';
    for (const [metric, val] of [['ess_charge_total_kwh', body.data?.pcs?.totalChargeKwh], ['ess_discharge_total_kwh', body.data?.pcs?.totalDischargeKwh], ['ess_soc_pct', body.data?.battery?.socPct]]) {
      if (val === undefined) continue;
      const r = addObservation(null, { assetId: asset.id, metricCode: metric, periodStart: d, periodEnd: d, rawValue: val, rawUnit: metric === 'ess_soc_pct' ? 'pct' : 'kWh',
        valueState: est ? 'estimated' : 'measured', sourceId: src.id, sourceRecordKey: `ess:${d}:${metric}`, note: est ? '模擬資料（測試）' : null, qualityGrade: est ? 'D' : 'A' },
        { method: 'api', syncJobId: job.id, skipCheck: true });
      stats[r.status === 'duplicate' ? 'duplicate' : 'created']++;
    }
    return { stats, cursor: body.ts };
  },

  // 通用 HTTP JSON 拉取：回 { observations: [PRD §16.3 格式], next_cursor }
  async http_json(intg, job) {
    const c = j(intg.config, {});
    if (!c.url) throw new Error('未設定 url');
    const u = new URL(c.url); if (intg.cursor) u.searchParams.set(c.cursorParam || 'since', intg.cursor);
    const headers = { Accept: 'application/json' };
    if (c.authHeader && process.env[c.authHeaderEnv || '']) headers[c.authHeader] = process.env[c.authHeaderEnv];
    const res = await fetch(u, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const stats = ingestBatch(intg, job, body.observations || []);
    return { stats, cursor: body.next_cursor || body.cursor || intg.cursor };
  },

  // 檔案投遞目錄（院方 SFTP 落地處）：讀新的 CSV／XLSX，用匯入範本欄位
  async file_drop(intg, job) {
    const c = j(intg.config, {});
    if (!c.dir) throw new Error('未設定目錄');
    const done = new Set(j(intg.cursor, []) || []);
    const stats = { files: 0, created: 0, duplicate: 0, errors: 0 };
    for (const name of (await readdir(c.dir)).filter((n) => /\.(csv|xlsx)$/i.test(n)).sort()) {
      const buf = await readFile(join(c.dir, name));
      const sig = `${name}:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`;
      if (done.has(sig)) continue;
      const table = parseTable(name, buf);
      const { rows, errors } = mapRows(intg.org_id, table, c.mapping || null);
      stats.errors += errors.length;
      const s = ingestBatch(intg, job, rows.map((r) => ({ ...r, source_record_key: r.source_record_key || `${sig}:${r._row}` })));
      stats.created += s.created; stats.duplicate += s.duplicate; stats.files++;
      done.add(sig);
    }
    return { stats, cursor: JSON.stringify([...done].slice(-2000)) };
  },

  // 外部系統主動推送（POST /api/v1/integrations/:id/push）；排程不跑
  async push() { return { stats: { note: '推送型介接不需排程' }, cursor: null }; },
};

export const CONNECTORS = {
  legacy_audit: '舊系統·電力健檢填報電費單', legacy_inventory: '舊系統·貼紙點位抄表', ems_bridge: '儲能櫃 ems-bridge', http_json: 'HTTP JSON 拉取', file_drop: '檔案投遞目錄（SFTP 落地）', push: '外部推送（API）',
};

// PRD §16.3 交換格式 → 觀測；asset_id 可填平台標的 id 或外部識別碼
function ingestBatch(intg, job, items) {
  const stats = { created: 0, duplicate: 0, new_version: 0, errors: 0, errorList: [] };
  for (const [i, it] of items.entries()) {
    try {
      const a = q.get("SELECT * FROM assets WHERE org_id = ? AND (id = ? OR external_key = ? OR legacy_ref = ?) AND status <> 'archived'", intg.org_id, it.asset_id, it.asset_id, it.asset_id);
      if (!a) throw new Error(`找不到標的 ${it.asset_id}`);
      if (!it.source_record_key) throw new Error('缺 source_record_key（冪等鍵）');
      const start = String(it.period_start || '').slice(0, 10); const end = String(it.period_end || '').slice(0, 10);
      if (!isDate(start) || !isDate(end)) throw new Error('期間格式錯誤');
      const src = it.source_id ? q.get('SELECT * FROM data_sources WHERE id = ? AND org_id = ?', it.source_id, intg.org_id)
        : ensureSource(intg.org_id, a.id, { name: intg.name, sourceType: 'api', acquisition: 'api', integrationId: intg.id, priority: 60 });
      if (!src) throw new Error('source_id 不存在');
      const r = addObservation(null, { assetId: a.id, metricCode: it.metric_code, periodStart: start, periodEnd: end, rawValue: it.raw_value, rawUnit: it.raw_unit,
        valueState: it.value_state, sourceId: src.id, sourceRecordKey: String(it.source_record_key), note: it.note, boundaryNote: it.boundary_note }, { method: 'api', syncJobId: job.id, skipCheck: true });
      stats[r.status]++;
    } catch (e) { stats.errors++; if (stats.errorList.length < 50) stats.errorList.push({ index: i, msg: e.message }); }
  }
  return stats;
}

// ── 管理 ──
export function listIntegrations(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT * FROM integrations WHERE org_id = ? ORDER BY created_at', orgId).map((i) => ({ ...i, config: redact(j(i.config, {})), label: CONNECTORS[i.connector],
    lastJobs: q.all('SELECT * FROM sync_jobs WHERE integration_id = ? ORDER BY started_at DESC LIMIT 5', i.id).map((s) => ({ ...s, stats: j(s.stats) })) }));
}
const redact = (c) => ({ ...c, tokenHash: c.tokenHash ? '（已設定）' : undefined });

export function saveIntegration(ctx, body) {
  assertCan(ctx, 'integration.write', body.orgId);
  if (!CONNECTORS[body.connector]) throw bad('不認得的介接類型');
  const t = nowIso();
  const cfg = { ...(body.config || {}) }; delete cfg.tokenHash;
  if (body.connector === 'file_drop' && cfg.dir && !cfg.dir.startsWith('/')) throw bad('目錄須為絕對路徑');
  if (body.id) {
    const i = q.get('SELECT * FROM integrations WHERE id = ? AND org_id = ?', body.id, body.orgId); if (!i) throw notFound('介接');
    const old = j(i.config, {});
    update('integrations', i.id, { name: body.name || i.name, config: { ...cfg, tokenHash: old.tokenHash }, interval_min: body.intervalMin || i.interval_min,
      enabled: body.enabled === false ? 0 : 1, updated_at: t, ...(body.enabled !== false && i.status === 'dead' ? { status: 'idle', fail_count: 0 } : {}) });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'integration.update', targetType: 'integration', targetId: i.id });
    return { id: i.id };
  }
  const id = newId('int');
  insert('integrations', { id, org_id: body.orgId, connector: body.connector, name: body.name || CONNECTORS[body.connector], config: cfg, interval_min: body.intervalMin || 1440,
    enabled: body.enabled === false ? 0 : 1, status: 'idle', next_run_at: t, created_by: ctx.userId, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'integration.create', targetType: 'integration', targetId: id, after: { connector: body.connector } });
  return { id };
}

// 推送型介接的權杖：只顯示一次，資料庫只存雜湊
export function rotatePushToken(ctx, id) {
  const i = q.get('SELECT * FROM integrations WHERE id = ?', id); if (!i) throw notFound('介接');
  assertCan(ctx, 'integration.write', i.org_id);
  const token = `emsp_${randomBytes(24).toString('base64url')}`;
  update('integrations', id, { config: { ...j(i.config, {}), tokenHash: createHash('sha256').update(token).digest('hex') }, updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: i.org_id, action: 'integration.token_rotate', targetType: 'integration', targetId: id });
  return { token };
}

export function pushObservations(integrationId, bearer, items) {
  const i = q.get('SELECT * FROM integrations WHERE id = ?', integrationId);
  if (!i || i.connector !== 'push' || !i.enabled) throw notFound('介接');
  const h = j(i.config, {}).tokenHash;
  const got = createHash('sha256').update(String(bearer || '')).digest('hex');
  if (!h || h.length !== got.length || !timingSafeEqual(Buffer.from(h), Buffer.from(got))) throw Object.assign(new Error('權杖不正確'), { status: 401 });
  if (!Array.isArray(items) || items.length > 5000) throw bad('observations 須為陣列且不超過 5000 筆');
  const job = { id: newId('sync') };
  insert('sync_jobs', { id: job.id, integration_id: i.id, status: 'running', started_at: nowIso() });
  const stats = tx(() => ingestBatch(i, job, items));
  update('sync_jobs', job.id, { status: stats.errors && !stats.created ? 'failed' : 'ok', stats, finished_at: nowIso() });
  update('integrations', i.id, { last_sync_at: nowIso(), last_ok_at: nowIso(), status: 'idle' });
  audit({ actor: `integration:${i.id}`, orgId: i.org_id, action: 'integration.push', targetType: 'integration', targetId: i.id, after: { created: stats.created, errors: stats.errors } });
  return stats;
}

// 執行一次（排程或手動）；失敗指數退避，連續 5 次 → dead＋通知
export async function runIntegration(id, { manualCtx } = {}) {
  const i = q.get('SELECT * FROM integrations WHERE id = ?', id); if (!i) throw notFound('介接');
  if (manualCtx) assertCan(manualCtx, 'integration.write', i.org_id);
  if (i.status === 'running') throw conflict('同步進行中');
  const job = { id: newId('sync') };
  insert('sync_jobs', { id: job.id, integration_id: i.id, attempt: i.fail_count + 1, status: 'running', cursor_before: i.cursor, started_at: nowIso() });
  update('integrations', i.id, { status: 'running', last_sync_at: nowIso() });
  try {
    const { stats, cursor } = await ADAPTERS[i.connector](i, job);
    const next = new Date(Date.now() + i.interval_min * 60000).toISOString();
    update('sync_jobs', job.id, { status: 'ok', cursor_after: cursor ?? null, stats, finished_at: nowIso() });
    update('integrations', i.id, { status: 'idle', cursor: cursor ?? i.cursor, last_ok_at: nowIso(), last_error: null, fail_count: 0, next_run_at: next });
    audit({ actor: manualCtx?.userId || 'scheduler', orgId: i.org_id, action: 'integration.sync', targetType: 'integration', targetId: i.id, after: stats });
    return { ok: true, stats };
  } catch (e) {
    const fails = i.fail_count + 1;
    const dead = fails >= MAX_FAILS;
    const backoff = Math.min(2 ** fails * 5, 24 * 60);
    update('sync_jobs', job.id, { status: dead ? 'dead' : 'failed', error: String(e.message || e).slice(0, 500), finished_at: nowIso() });
    update('integrations', i.id, { status: dead ? 'dead' : 'error', last_error: String(e.message || e).slice(0, 500), fail_count: fails,
      next_run_at: new Date(Date.now() + backoff * 60000).toISOString() });
    if (dead || fails === 1) notifyRole(i.org_id, 'integration.write', 'integration.failed', `介接${dead ? '已停止（連續失敗）' : '失敗'}：${i.name}`, String(e.message || e), '#/admin/integrations');
    return { ok: false, error: String(e.message || e), dead };
  }
}

export async function runDue(now = new Date()) {
  const due = q.all("SELECT id FROM integrations WHERE enabled = 1 AND connector <> 'push' AND status IN ('idle','error') AND (next_run_at IS NULL OR next_run_at <= ?)", now.toISOString());
  const out = [];
  for (const d of due) out.push(await runIntegration(d.id).catch((e) => ({ ok: false, error: e.message })));
  return out;
}

export { ADAPTERS as _adapters, ensureAsset as _ensureAsset };
export const _cfg = config;
