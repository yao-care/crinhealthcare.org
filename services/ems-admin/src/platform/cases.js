// 差異案件生命週期（PRD §10.5）：自動發現／人工提報 → 分級 → 指派 → 調查 → 補件或提出採用方案 → 審核 → 結案 → 追蹤
import { q, insert, update, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, conflict, addDays, j } from './util.js';
import { getConfig } from './config-store.js';
import { notify, notifyRole, systemTask } from './collab.js';

const STATUS = ['open', 'assigned', 'investigating', 'awaiting_evidence', 'proposed', 'in_review', 'closed', 'reopened'];
export const CASE_STATUS_LABEL = { open: '待分派', assigned: '已指派', investigating: '調查中', awaiting_evidence: '待補件', proposed: '已提出採用方案', in_review: '審核中', closed: '已結案', reopened: '重新開啟' };

// 系統或人開案；fingerprint 相同且未結案 → 不重複開
export function openCase({ orgId, kind, ruleCode, severity = 'medium', assetId, metricCode, periodStart, periodEnd, observationIds = [], summary, absDiff, relDiff, details, fingerprint, actor = 'system', owner }) {
  if (fingerprint) {
    const dup = q.get("SELECT id FROM discrepancy_cases WHERE fingerprint = ? AND status <> 'closed'", fingerprint);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const sla = getConfig('case.sla') || {};
  const t = nowIso(); const id = newId('case');
  insert('discrepancy_cases', { id, org_id: orgId, kind, rule_code: ruleCode || null, severity, asset_id: assetId || null, metric_code: metricCode || null,
    period_start: periodStart || null, period_end: periodEnd || null, observation_ids: observationIds, summary, abs_diff: absDiff ?? null, rel_diff: relDiff ?? null,
    details: details || null, status: owner ? 'assigned' : 'open', owner: owner || null, due_date: addDays(t.slice(0, 10), sla[severity] || 14), fingerprint: fingerprint || null,
    opened_by: actor, opened_at: t, updated_at: t });
  insert('case_events', { id: newId('ce'), case_id: id, action: 'open', note: summary, actor, at: t });
  audit({ actor, orgId, action: 'case.open', targetType: 'case', targetId: id, after: { kind, severity, summary } });
  if (owner) notify(owner, 'case.assigned', `差異案件：${summary}`, '', `#/quality/cases/${id}`);
  else notifyRole(orgId, 'case.assign', 'case.new', `新差異案件待分派：${summary}`, '', `#/quality/cases/${id}`);
  return { id };
}

export function reportCase(ctx, body) {
  assertCan(ctx, 'case.write', body.orgId);
  if (!body.summary) throw bad('請描述差異');
  return openCase({ ...body, actor: ctx.userId, kind: body.kind || 'manual', fingerprint: null });
}

export function listCases(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return [];
  const where = [`c.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.status) { where.push('c.status = ?'); p.push(f.status); } else if (!f.all) where.push("c.status <> 'closed'");
  if (f.severity) { where.push('c.severity = ?'); p.push(f.severity); }
  if (f.assetId) { where.push('c.asset_id = ?'); p.push(f.assetId); }
  if (f.mine) { where.push('c.owner = ?'); p.push(ctx.userId); }
  const today = nowIso().slice(0, 10);
  return q.all(`SELECT c.*, a.name AS asset_name, a.domain, u.display_name AS owner_name FROM discrepancy_cases c LEFT JOIN assets a ON a.id = c.asset_id
    LEFT JOIN users u ON u.id = c.owner WHERE ${where.join(' AND ')}
    ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, c.due_date LIMIT 500`, ...p)
    .map((c) => ({ ...parseJson(c, ['observation_ids', 'details']), overdueDays: c.status !== 'closed' && c.due_date && c.due_date < today ? Math.round((Date.parse(today) - Date.parse(c.due_date)) / 86400000) : 0 }));
}

export function getCase(ctx, id) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  assertCan(ctx, 'view.internal', c.org_id);
  const ids = j(c.observation_ids, []);
  const observations = ids.length ? q.all(`SELECT o.*, s.name AS source_name, s.source_type, m.name AS metric_name FROM observations o JOIN data_sources s ON s.id = o.source_id
    JOIN metrics m ON m.code = o.metric_code WHERE o.id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const events = q.all('SELECT e.*, u.display_name AS actor_name FROM case_events e LEFT JOIN users u ON u.id = e.actor WHERE case_id = ? ORDER BY at', id).map((e) => parseJson(e, ['data']));
  const decisions = q.all('SELECT d.*, u.display_name AS proposed_by_name FROM decisions d LEFT JOIN users u ON u.id = d.proposed_by WHERE case_id = ? ORDER BY proposed_at DESC', id);
  // 衝擊：哪些報告已引用此標的此期間的採用值
  const impact = c.asset_id ? q.all(`SELECT DISTINCT rc.id, rc.name, rr.status FROM approved_facts af JOIN usage_links ul ON ul.fact_id = af.id
    JOIN report_runs rr ON rr.id = ul.report_run_id JOIN report_cases rc ON rc.id = rr.case_id WHERE af.asset_id = ? AND af.is_current = 1
    AND (? IS NULL OR af.metric_code = ?) AND (? IS NULL OR (af.period_end > ? AND af.period_start < COALESCE(?, '9999-12-31')))`,
    c.asset_id, c.metric_code, c.metric_code, c.period_start, c.period_start, c.period_end) : [];
  return { ...parseJson(c, ['observation_ids', 'details']), observations, events, decisions, impact, statusLabel: CASE_STATUS_LABEL[c.status] };
}

function event(c, ctx, action, note, data) {
  insert('case_events', { id: newId('ce'), case_id: c.id, action, note: note || null, data: data || null, actor: ctx.userId, at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: c.org_id, action: `case.${action}`, targetType: 'case', targetId: c.id, after: { note, ...data } });
}

export function assignCase(ctx, id, { owner, dueDate, severity }) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  assertCan(ctx, 'case.assign', c.org_id);
  if (c.status === 'closed') throw conflict('案件已結案');
  const patch = { owner, status: 'assigned', updated_at: nowIso() };
  if (dueDate) patch.due_date = dueDate;
  if (severity) patch.severity = severity;
  tx(() => { update('discrepancy_cases', id, patch); event(c, ctx, 'assign', null, { owner, dueDate, severity }); });
  notify(owner, 'case.assigned', `差異案件指派給你：${c.summary}`, '', `#/quality/cases/${id}`);
}

// 調查進度：調查中、要求補件（建立補件任務給來源保管者）
export function caseProgress(ctx, id, { status, note, requestFrom, requestDue }) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  assertCan(ctx, 'case.write', c.org_id);
  if (!['investigating', 'awaiting_evidence'].includes(status)) throw bad('狀態只能是調查中或待補件');
  if (c.status === 'closed') throw conflict('案件已結案');
  tx(() => {
    update('discrepancy_cases', id, { status, updated_at: nowIso() });
    event(c, ctx, status === 'awaiting_evidence' ? 'request_evidence' : 'investigate', note, { requestFrom });
    if (status === 'awaiting_evidence' && requestFrom) {
      systemTask(c.org_id, { kind: 'evidence_request', targetType: 'case', targetId: id, title: `補件：${c.summary}`, assignee: requestFrom, dueDate: requestDue,
        data: { note }, link: `#/quality/cases/${id}` });
    }
  });
}

export function addCaseNote(ctx, id, note) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  assertCan(ctx, 'case.write', c.org_id);
  if (!note) throw bad('請填說明');
  event(c, ctx, 'note', note);
}

// 由裁決流程呼叫：提出方案 → proposed；審核中 → in_review；核准 → closed
export function caseStatusFromDecision(caseId, status, ctx, note) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', caseId); if (!c) return;
  const patch = { status, updated_at: nowIso() };
  if (status === 'closed') { patch.closed_at = nowIso(); patch.resolution = note || '已裁決'; }
  update('discrepancy_cases', caseId, patch);
  insert('case_events', { id: newId('ce'), case_id: caseId, action: `decision_${status}`, note: note || null, actor: ctx?.userId || 'system', at: nowIso() });
}

// 不需要調整的情況（例：差異經確認為季節性）：需理由，由有審核權者結案
export function closeCase(ctx, id, { resolution }) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  if (!can(ctx, 'decision.review', c.org_id)) assertCan(ctx, 'decision.review', c.org_id);
  if (!resolution) throw bad('結案需填寫決議與理由');
  if (c.opened_by === ctx.userId && c.owner === ctx.userId) throw conflict('提報人兼處理人不可自行結案，請由另一位審核者結案');
  tx(() => { update('discrepancy_cases', id, { status: 'closed', resolution, closed_at: nowIso(), updated_at: nowIso() }); event(c, ctx, 'close', resolution); });
}

export function reopenCase(ctx, id, { reason }) {
  const c = q.get('SELECT * FROM discrepancy_cases WHERE id = ?', id); if (!c) throw notFound('差異案件');
  assertCan(ctx, 'case.assign', c.org_id);
  if (c.status !== 'closed') throw conflict('只有已結案可以重開');
  if (!reason) throw bad('重開需填原因');
  // 重開會讓 fingerprint 唯一索引衝突：同 fingerprint 已有未結案的就不重開
  if (c.fingerprint && q.get("SELECT 1 FROM discrepancy_cases WHERE fingerprint = ? AND status <> 'closed' AND id <> ?", c.fingerprint, id)) throw conflict('已有相同的未結案件');
  tx(() => { update('discrepancy_cases', id, { status: 'reopened', closed_at: null, updated_at: nowIso() }); event(c, ctx, 'reopen', reason); });
}

export { STATUS as CASE_STATUSES };
