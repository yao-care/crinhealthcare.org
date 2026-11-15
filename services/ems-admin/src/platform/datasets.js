// M07 裁決與簽核＋M08 資料集與採用值（PRD §6.4、§8.2、§10.4）
// 報告承辦提出採用值 → 審核者核准（高影響須第二位覆核者）→ 採用值寫入資料集 → 資料集核准 → 定版（雜湊）。
// 定版後的資料集與採用值不可改（DB trigger 擋）；要修正就開新版本資料集。
import { q, insert, update, newId, nowIso, audit, tx, parseJson, sha256 } from './db.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, conflict, j, round, yearRange, allocateMonthly, isCalendarMonth } from './util.js';
import { getConfig } from './config-store.js';
import { caseStatusFromDecision } from './cases.js';
import { setWorkStatus } from './assets.js';
import { notify, notifyRole } from './collab.js';

// ── 資料集 ──
export function createDataset(ctx, { orgId, year, boundaryId, name, purpose }) {
  assertCan(ctx, 'dataset.write', orgId);
  if (!year) throw bad('請填年度');
  const t = nowIso(); const id = newId('ds');
  const version = (q.get('SELECT MAX(version) v FROM datasets WHERE org_id = ? AND year = ? AND IFNULL(boundary_id, \'\') = IFNULL(?, \'\')', orgId, year, boundaryId || null)?.v || 0) + 1;
  insert('datasets', { id, org_id: orgId, boundary_id: boundaryId || null, year, name: name || `${year} 年度共用資料集`, purpose: purpose || null, version,
    status: 'draft', created_by: ctx.userId, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'dataset.create', targetType: 'dataset', targetId: id, after: { year, version } });
  return { id, version };
}

export function listDatasets(ctx, orgId) {
  const orgIds = orgId ? [orgId] : orgsFor(ctx, 'view.internal');
  if (orgId) assertCan(ctx, 'view.internal', orgId);
  if (!orgIds.length) return [];
  return q.all(`SELECT d.*, (SELECT COUNT(*) FROM approved_facts af WHERE af.dataset_id = d.id AND af.is_current = 1) AS fact_count,
      (SELECT COUNT(*) FROM decisions x WHERE x.dataset_id = d.id AND x.status IN ('proposed','first_approved')) AS pending_decisions,
      o.name AS org_name FROM datasets d JOIN organizations o ON o.id = d.org_id WHERE d.org_id IN (${orgIds.map(() => '?').join(',')}) ORDER BY d.year DESC, d.version DESC`, ...orgIds);
}

export function getDataset(ctx, id) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); if (!d) throw notFound('資料集');
  assertCan(ctx, 'view.internal', d.org_id);
  const facts = q.all(`SELECT af.*, a.name AS asset_name, a.domain, m.name AS metric_name, u.display_name AS approved_by_name FROM approved_facts af
    JOIN assets a ON a.id = af.asset_id JOIN metrics m ON m.code = af.metric_code LEFT JOIN users u ON u.id = af.approved_by
    WHERE af.dataset_id = ? AND af.is_current = 1 ORDER BY a.domain, a.name, af.metric_code, af.period_start`, id).map((f) => parseJson(f, ['observation_ids']));
  const decisions = q.all(`SELECT x.*, a.name AS asset_name, m.name AS metric_name, u.display_name AS proposed_by_name FROM decisions x JOIN assets a ON a.id = x.asset_id
    JOIN metrics m ON m.code = x.metric_code LEFT JOIN users u ON u.id = x.proposed_by WHERE x.dataset_id = ? ORDER BY x.proposed_at DESC`, id)
    .map((x) => parseJson(x, ['method', 'input_observation_ids', 'evidence_ids']));
  const sensitive = can(ctx, 'view.sensitive', d.org_id);
  const costCodes = new Set(q.all("SELECT code FROM metrics WHERE semantics = 'cost'").map((m) => m.code));
  return { ...d, facts: facts.map((f) => (!sensitive && costCodes.has(f.metric_code) ? { ...f, value: null, masked: true } : f)), decisions };
}

function datasetOpen(d) {
  if (!d) throw notFound('資料集');
  if (['locked', 'superseded'].includes(d.status)) throw conflict('資料集已定版，請建立新版本後再修改');
}

// ── 裁決 ──
function policy() { return getConfig('decision.policy') || {}; }

function isHighImpact({ decisionType, valueState, value, unit, relDiff }) {
  const p = policy().highImpact || {};
  if (decisionType === 'derived' && p.derived) return true;
  if (valueState === 'estimated' && p.estimated) return true;
  if (decisionType === 'not_applicable' && p.notApplicable) return true;
  if (relDiff !== null && relDiff !== undefined && p.relDiffPct !== undefined && relDiff > p.relDiffPct) return true;
  if (value !== null && value !== undefined && p.absValueOver?.[unit] !== undefined && Math.abs(value) > p.absValueOver[unit]) return true;
  return false;
}

// 提出採用值。decisionType：
//   select_source：指定某筆觀測（含其分攤或差分後的值）為採用值
//   derived：經授權的計算／估算（衍生值，必附方法），不覆寫原始觀測
//   not_applicable／missing：明示不適用或缺漏（不可用 0 代替）
//   reject：退回補件（不產生採用值）
export function proposeDecision(ctx, body) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', body.datasetId); datasetOpen(d);
  assertCan(ctx, 'decision.propose', d.org_id);
  const asset = q.get('SELECT * FROM assets WHERE id = ?', body.assetId); if (!asset || asset.org_id !== d.org_id) throw bad('標的不屬於此資料集的院所');
  const m = q.get('SELECT * FROM metrics WHERE code = ?', body.metricCode); if (!m) throw bad('指標不存在');
  if (!body.reason?.trim()) throw bad('裁決必須填寫理由');
  if (!body.periodStart || !body.periodEnd) throw bad('請指定期間');
  const type = body.decisionType;
  if (!['select_source', 'derived', 'not_applicable', 'missing', 'reject'].includes(type)) throw bad('裁決類型不正確');
  let value = null; let unit = m.std_unit; let valueState = 'measured'; let inputs = j(body.inputObservationIds, []) || [];
  let method = body.method || null;
  if (type === 'select_source') {
    const o = q.get('SELECT * FROM observations WHERE id = ?', body.selectedObservationId);
    if (!o || o.asset_id !== asset.id) throw bad('選取的觀測值不屬於此標的');
    if (o.quality_status === 'invalid') throw conflict('此觀測值未通過檢核，請先修正或改用其他來源');
    if (o.quality_status === 'pending_validation') throw conflict('此觀測值尚未檢核，請先執行檢核');
    if (o.quality_status === 'superseded') throw conflict('此觀測值已被新版本取代');
    if (policy().requireEvidenceForSelect && o.method !== 'api' && !q.get('SELECT 1 FROM observation_evidence WHERE observation_id = ?', o.id) && !body.evidenceIds?.length) {
      throw conflict('採用值須有佐證：此觀測值沒有附佐證，請補件或在裁決附上佐證', { code: 'evidence_required' });
    }
    inputs = [o.id];
    valueState = o.value_state;
    if (o.period_start === body.periodStart && o.period_end === body.periodEnd) value = o.value_std;
    else {
      // 取分攤或差分後的值
      const tv = q.get('SELECT * FROM transformed_values WHERE observation_id = ? AND period_start = ? AND period_end = ?', o.id, body.periodStart, body.periodEnd);
      if (!tv) throw bad('選取的觀測值期間與裁決期間不同，且沒有對應的分攤值');
      value = tv.value; method = method || { transform: tv.rule_code, version: tv.rule_version };
    }
  } else if (type === 'derived') {
    if (!body.method) throw bad('衍生值必須說明計算或估算方法');
    if (body.value === undefined || body.value === null || body.value === '') throw bad('請填衍生值');
    value = Number(body.value); if (!Number.isFinite(value)) throw bad('衍生值不是數字');
    valueState = body.valueState === 'measured' ? 'measured' : 'estimated';
  } else if (type === 'not_applicable') { valueState = 'not_applicable'; }
  else if (type === 'missing') { valueState = 'missing'; }
  const relDiff = body.caseId ? q.get('SELECT rel_diff FROM discrepancy_cases WHERE id = ?', body.caseId)?.rel_diff : null;
  const impact = body.impact === 'high' || isHighImpact({ decisionType: type, valueState, value, unit, relDiff }) ? 'high' : 'normal';
  const id = newId('dec');
  tx(() => {
    insert('decisions', { id, org_id: d.org_id, case_id: body.caseId || null, dataset_id: d.id, asset_id: asset.id, metric_code: m.code,
      period_start: body.periodStart, period_end: body.periodEnd, basis: body.basis || 'default', decision_type: type,
      selected_observation_id: type === 'select_source' ? inputs[0] : null, input_observation_ids: inputs, value, unit, value_state: valueState, method,
      reason: body.reason.trim(), evidence_ids: body.evidenceIds || [], impact, status: type === 'reject' ? 'returned' : 'proposed', proposed_by: ctx.userId, proposed_at: nowIso() });
    if (body.caseId) caseStatusFromDecision(body.caseId, type === 'reject' ? 'awaiting_evidence' : 'proposed', ctx, body.reason);
    if (type === 'reject') setWorkStatus(ctx, asset.id, 'returned', body.reason, { system: true });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: d.org_id, action: 'decision.propose', targetType: 'decision', targetId: id, after: { type, value, unit, impact, reason: body.reason } });
  });
  if (type !== 'reject') notifyRole(d.org_id, 'decision.review', 'decision.pending', `採用值待審核：${asset.name}`, body.reason, `#/quality/review`, ctx.userId);
  return { id, impact };
}

// 批次提出：期間內每個（標的、指標、自然月）只有單一有效來源、沒有未結案件 → 自動帶出 select_source 草案
export function proposeBulk(ctx, { datasetId, assetIds, metricCodes, reason }) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', datasetId); datasetOpen(d);
  assertCan(ctx, 'decision.propose', d.org_id);
  const [from, to] = yearRange(d.year);
  const where = ["o.org_id = ?", "o.quality_status IN ('valid','warning')", 'o.period_start >= ?', 'o.period_end <= ?']; const p = [d.org_id, from, to];
  if (assetIds?.length) { where.push(`o.asset_id IN (${assetIds.map(() => '?').join(',')})`); p.push(...assetIds); }
  if (metricCodes?.length) { where.push(`o.metric_code IN (${metricCodes.map(() => '?').join(',')})`); p.push(...metricCodes); }
  const obs = q.all(`SELECT o.* FROM observations o WHERE ${where.join(' AND ')}`, ...p);
  const groups = new Map();
  for (const o of obs) { const k = `${o.asset_id}|${o.metric_code}|${o.period_start}|${o.period_end}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
  const out = { proposed: 0, skipped: [] };
  for (const [k, list] of groups) {
    const [assetId, metricCode, ps, pe] = k.split('|');
    if (q.get(`SELECT 1 FROM approved_facts WHERE dataset_id = ? AND asset_id = ? AND metric_code = ? AND period_start = ? AND period_end = ? AND is_current = 1`, d.id, assetId, metricCode, ps, pe)) continue;
    if (q.get(`SELECT 1 FROM decisions WHERE dataset_id = ? AND asset_id = ? AND metric_code = ? AND period_start = ? AND period_end = ? AND status IN ('proposed','first_approved')`, d.id, assetId, metricCode, ps, pe)) continue;
    if (list.length > 1) { out.skipped.push({ key: k, why: '同期間有多個來源，請逐筆比對後裁決' }); continue; }
    if (q.get("SELECT 1 FROM discrepancy_cases WHERE asset_id = ? AND metric_code = ? AND status <> 'closed'", assetId, metricCode)) { out.skipped.push({ key: k, why: '有未結差異案件' }); continue; }
    try {
      proposeDecision(ctx, { datasetId: d.id, assetId, metricCode, periodStart: ps, periodEnd: pe, decisionType: 'select_source', selectedObservationId: list[0].id,
        reason: reason || '單一來源、檢核通過、無差異案件' });
      out.proposed++;
    } catch (e) { out.skipped.push({ key: k, why: e.message }); }
  }
  return out;
}

export function listPendingDecisions(ctx, { orgId } = {}) {
  const orgIds = orgId ? [orgId] : orgsFor(ctx, 'decision.review');
  if (!orgIds.length) return [];
  return q.all(`SELECT x.*, a.name AS asset_name, a.domain, m.name AS metric_name, d.name AS dataset_name, u.display_name AS proposed_by_name, r.display_name AS reviewer1_name
    FROM decisions x JOIN assets a ON a.id = x.asset_id JOIN metrics m ON m.code = x.metric_code JOIN datasets d ON d.id = x.dataset_id
    LEFT JOIN users u ON u.id = x.proposed_by LEFT JOIN users r ON r.id = x.reviewer1
    WHERE x.org_id IN (${orgIds.map(() => '?').join(',')}) AND x.status IN ('proposed','first_approved') ORDER BY x.impact DESC, x.proposed_at`, ...orgIds)
    .map((x) => ({ ...parseJson(x, ['input_observation_ids', 'evidence_ids', 'method']), canReview: x.proposed_by !== ctx.userId && x.reviewer1 !== ctx.userId }));
}

// 核准：一般 → 一位審核者；高影響 → 兩位不同的審核者，且都不是提出者
export function reviewDecision(ctx, id, { approve, note }) {
  const x = q.get('SELECT * FROM decisions WHERE id = ?', id); if (!x) throw notFound('裁決');
  const d = q.get('SELECT * FROM datasets WHERE id = ?', x.dataset_id); datasetOpen(d);
  assertCan(ctx, 'decision.review', x.org_id);
  if (!['proposed', 'first_approved'].includes(x.status)) throw conflict('此裁決不是待審核狀態');
  if (x.proposed_by === ctx.userId && policy().reviewerMustDifferFromProposer !== false) throw conflict('審核者不可以是提出者');
  if (x.reviewer1 === ctx.userId) throw conflict('高影響裁決需要另一位審核者覆核');
  if (!approve) {
    if (!note) throw bad('退回需填理由');
    tx(() => {
      update('decisions', id, { status: 'returned', review_note: note, reviewer1: x.reviewer1 || ctx.userId, reviewed1_at: x.reviewed1_at || nowIso() });
      if (x.case_id) caseStatusFromDecision(x.case_id, 'investigating', ctx, `裁決退回：${note}`);
      setWorkStatus(ctx, x.asset_id, 'returned', note, { system: true });
      audit({ actor: ctx.userId, actorName: ctx.name, orgId: x.org_id, action: 'decision.return', targetType: 'decision', targetId: id, after: { note } });
    });
    notify(x.proposed_by, 'decision.returned', '採用值被退回', note, '#/quality/review');
    return { status: 'returned' };
  }
  if (x.impact === 'high' && x.status === 'proposed') {
    tx(() => {
      update('decisions', id, { status: 'first_approved', reviewer1: ctx.userId, reviewed1_at: nowIso(), review_note: note || null });
      if (x.case_id) caseStatusFromDecision(x.case_id, 'in_review', ctx, '第一位審核者已核准，待覆核');
      audit({ actor: ctx.userId, actorName: ctx.name, orgId: x.org_id, action: 'decision.first_approve', targetType: 'decision', targetId: id, after: { note } });
    });
    notifyRole(x.org_id, 'decision.review', 'decision.second_review', '高影響採用值待第二位覆核', '', '#/quality/review', ctx.userId);
    return { status: 'first_approved' };
  }
  const t = nowIso();
  tx(() => {
    const patch = x.impact === 'high' ? { status: 'approved', reviewer2: ctx.userId, reviewed2_at: t } : { status: 'approved', reviewer1: ctx.userId, reviewed1_at: t };
    if (note) patch.review_note = [x.review_note, note].filter(Boolean).join('；');
    update('decisions', id, patch);
    if (x.decision_type !== 'reject') writeFact(x, ctx.userId, t);
    if (x.case_id) caseStatusFromDecision(x.case_id, 'closed', ctx, `採用值核准（${x.decision_type}）：${x.reason}`);
    // 標的此資料集所需期間都有採用值 → 已核准
    setWorkStatus(ctx, x.asset_id, 'approved', `採用值核准 ${id}`, { system: true });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: x.org_id, action: 'decision.approve', targetType: 'decision', targetId: id, after: patch });
  });
  notify(x.proposed_by, 'decision.approved', '採用值已核准', '', `#/datasets/${x.dataset_id}`);
  return { status: 'approved' };
}

export function withdrawDecision(ctx, id) {
  const x = q.get('SELECT * FROM decisions WHERE id = ?', id); if (!x) throw notFound('裁決');
  if (x.proposed_by !== ctx.userId) throw conflict('只有提出者可以撤回');
  if (!['proposed', 'first_approved'].includes(x.status)) throw conflict('此裁決已處理');
  update('decisions', id, { status: 'withdrawn' });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: x.org_id, action: 'decision.withdraw', targetType: 'decision', targetId: id });
}

function writeFact(x, approver, t) {
  const prev = q.get(`SELECT * FROM approved_facts WHERE dataset_id = ? AND asset_id = ? AND metric_code = ? AND period_start = ? AND period_end = ? AND basis = ? AND is_current = 1`,
    x.dataset_id, x.asset_id, x.metric_code, x.period_start, x.period_end, x.basis);
  if (prev) update('approved_facts', prev.id, { is_current: 0, superseded_at: t });
  insert('approved_facts', { id: newId('fact'), dataset_id: x.dataset_id, org_id: x.org_id, asset_id: x.asset_id, metric_code: x.metric_code,
    period_start: x.period_start, period_end: x.period_end, basis: x.basis, value: x.value, unit: x.unit, value_state: x.value_state,
    decision_id: x.id, observation_ids: j(x.input_observation_ids, []), version: prev ? prev.version + 1 : 1, is_current: 1, approved_by: approver, approved_at: t });
}

// ── 資料集送審、核准、定版、新版本 ──
export function submitDataset(ctx, id) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); datasetOpen(d);
  assertCan(ctx, 'dataset.write', d.org_id);
  const pending = q.get("SELECT COUNT(*) n FROM decisions WHERE dataset_id = ? AND status IN ('proposed','first_approved')", id).n;
  if (pending) throw conflict(`尚有 ${pending} 筆採用值待審核`);
  update('datasets', id, { status: 'in_review', updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: d.org_id, action: 'dataset.submit', targetType: 'dataset', targetId: id });
  notifyRole(d.org_id, 'dataset.approve', 'dataset.review', `資料集待核准：${d.name}`, '', `#/datasets/${id}`, ctx.userId);
}

export function approveDataset(ctx, id, { approve = true, note } = {}) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); datasetOpen(d);
  assertCan(ctx, 'dataset.approve', d.org_id);
  if (d.status !== 'in_review') throw conflict('資料集不是待核准狀態');
  if (d.created_by === ctx.userId) throw conflict('核准者不可以是建立者');
  update('datasets', id, approve ? { status: 'approved', approved_by: ctx.userId, approved_at: nowIso(), updated_at: nowIso() } : { status: 'draft', updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: d.org_id, action: approve ? 'dataset.approve' : 'dataset.return', targetType: 'dataset', targetId: id, after: { note } });
  notify(d.created_by, approve ? 'dataset.approved' : 'dataset.returned', approve ? `資料集已核准：${d.name}` : `資料集退回：${d.name}`, note || '', `#/datasets/${id}`);
}

export function datasetHash(id) {
  const facts = q.all(`SELECT asset_id, metric_code, period_start, period_end, basis, value, unit, value_state, decision_id, observation_ids FROM approved_facts
    WHERE dataset_id = ? AND is_current = 1 ORDER BY asset_id, metric_code, period_start, period_end, basis`, id);
  return sha256(JSON.stringify(facts));
}

export function lockDataset(ctx, id) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); datasetOpen(d);
  assertCan(ctx, 'dataset.lock', d.org_id);
  if (d.status !== 'approved') throw conflict('資料集須先核准才能定版');
  const hash = datasetHash(id); const t = nowIso();
  tx(() => {
    update('datasets', id, { status: 'locked', hash, locked_by: ctx.userId, locked_at: t, updated_at: t });
    snapshotAssets(id, d.org_id);
    for (const f of q.all('SELECT DISTINCT asset_id FROM approved_facts WHERE dataset_id = ? AND is_current = 1', id)) setWorkStatus(ctx, f.asset_id, 'locked', `資料集定版 ${d.name}`, { system: true });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: d.org_id, action: 'dataset.lock', targetType: 'dataset', targetId: id, after: { hash } });
  });
  return { hash };
}

export function snapshotAssets(datasetId, orgId) {
  q.run('DELETE FROM dataset_asset_snapshots WHERE dataset_id = ?', datasetId);
  for (const a of q.all('SELECT a.*, i.code AS item_code FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ?', orgId)) {
    insert('dataset_asset_snapshots', { dataset_id: datasetId, asset_id: a.id, attrs: a.attrs || '{}', applicability: a.applicability, asset_type: a.asset_type, item_code: a.item_code || null, name: a.name });
  }
}

export function verifyDataset(id) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); if (!d) throw notFound('資料集');
  if (d.status !== 'locked' && d.status !== 'superseded') return { locked: false };
  const now = datasetHash(id);
  return { locked: true, ok: now === d.hash, stored: d.hash, computed: now };
}

// 新版本：複製目前採用值（新紀錄），原版本標 superseded 但保留，已引用原版本的報告不受影響
export function newDatasetVersion(ctx, id, { reason }) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', id); if (!d) throw notFound('資料集');
  assertCan(ctx, 'dataset.write', d.org_id);
  if (d.status !== 'locked') throw conflict('只有已定版的資料集需要開新版本；草稿可直接修改');
  if (!reason) throw bad('請填開新版本的原因');
  const t = nowIso(); const nid = newId('ds');
  return tx(() => {
    insert('datasets', { id: nid, org_id: d.org_id, boundary_id: d.boundary_id, year: d.year, name: d.name, purpose: d.purpose, version: d.version + 1,
      parent_dataset_id: d.id, status: 'draft', created_by: ctx.userId, created_at: t, updated_at: t });
    for (const f of q.all('SELECT * FROM approved_facts WHERE dataset_id = ? AND is_current = 1', d.id)) {
      insert('approved_facts', { ...f, id: newId('fact'), dataset_id: nid, approved_at: f.approved_at });
    }
    update('datasets', d.id, { status: 'superseded', updated_at: t });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: d.org_id, action: 'dataset.new_version', targetType: 'dataset', targetId: nid, after: { from: d.id, reason } });
    return { id: nid, version: d.version + 1 };
  });
}

// 資料集內，某標的某指標的候選數值（裁決頁用）
export function candidates(ctx, datasetId, assetId, metricCode) {
  const d = q.get('SELECT * FROM datasets WHERE id = ?', datasetId); if (!d) throw notFound('資料集');
  assertCan(ctx, 'view.internal', d.org_id);
  const [from, to] = yearRange(d.year);
  const obs = q.all(`SELECT o.*, s.name AS source_name, s.source_type, s.priority FROM observations o JOIN data_sources s ON s.id = o.source_id
    WHERE o.asset_id = ? AND o.metric_code = ? AND o.quality_status <> 'superseded' AND o.period_end > ? AND o.period_start < ? ORDER BY o.period_start`, assetId, metricCode, from, to);
  const tv = obs.length ? q.all(`SELECT * FROM transformed_values WHERE observation_id IN (${obs.map(() => '?').join(',')})`, ...obs.map((o) => o.id)) : [];
  const facts = q.all('SELECT * FROM approved_facts WHERE dataset_id = ? AND asset_id = ? AND metric_code = ? AND is_current = 1', datasetId, assetId, metricCode);
  // 建議期間：自然月（帳單期間不是自然月時同時提供原期間）
  const periods = new Map();
  for (const o of obs) {
    periods.set(`${o.period_start}|${o.period_end}`, { periodStart: o.period_start, periodEnd: o.period_end, calendar: isCalendarMonth(o.period_start, o.period_end) });
    if (!isCalendarMonth(o.period_start, o.period_end)) for (const pt of allocateMonthly(o.period_start, o.period_end, 1)) periods.set(`${pt.period_start}|${pt.period_end}`, { periodStart: pt.period_start, periodEnd: pt.period_end, calendar: true, derived: true });
  }
  return { observations: obs, transforms: tv.map((t) => parseJson(t, ['method'])), facts, periods: [...periods.values()].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1)) };
}

export { round as _round };
