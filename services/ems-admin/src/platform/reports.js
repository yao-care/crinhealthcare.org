// M10 報告應用與產製（PRD §8.1、§8.3、§12）＋M12 成果引用鏈
// 流程：建立案件 → 選版本／邊界 → 就緒度 → 補件／裁決 → 產製（計算並凍結結果）→ 送審 → 核准 → 封存（雜湊）→ 匯出 → 回饋提供者。
// 封存後結果不可改（DB trigger）；同版輸入＋同版係數＋同版規則可重現同一結果（reproduce 驗證）。
import { q, insert, update, newId, nowIso, audit, tx, parseJson, sha256 } from './db.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, conflict, j } from './util.js';
import { computeAll, STATE_LABEL } from './calc.js';
import { notify, notifyRole } from './collab.js';

// 依發布日期選模板版本（GRI 2027-01-01 換版）
export function templateFor(code, publishDate) {
  const d = publishDate || nowIso().slice(0, 10);
  return q.get(`SELECT * FROM report_templates WHERE code = ? AND status = 'published' AND (applies_from IS NULL OR applies_from <= ?) AND (applies_to IS NULL OR applies_to >= ?)
                ORDER BY version DESC LIMIT 1`, code, d, d);
}
export function listTemplates() {
  return q.all(`SELECT t.*, (SELECT COUNT(*) FROM report_mappings m WHERE m.template_id = t.id) AS field_count FROM report_templates t ORDER BY code, version DESC`)
    .map((t) => parseJson(t, ['sections', 'applicability', 'export_formats']));
}
export function templateDetail(id) {
  const t = q.get('SELECT * FROM report_templates WHERE id = ?', id); if (!t) throw notFound('模板');
  return { ...parseJson(t, ['sections', 'applicability', 'export_formats']), mappings: q.all('SELECT * FROM report_mappings WHERE template_id = ? ORDER BY sort', id) };
}
// 模板草稿的欄位映射編輯
export function saveMapping(ctx, templateId, m) {
  const t = q.get('SELECT * FROM report_templates WHERE id = ?', templateId); if (!t) throw notFound('模板');
  assertCan(ctx, 'config.write', null);
  if (t.status !== 'draft') throw conflict('只能修改草稿版模板的欄位');
  if (!m.fieldId || !m.label || !m.section || !m.sourceKind) throw bad('欄位代碼、名稱、章節、來源類型都要填');
  const row = { section: m.section, label: m.label, data_type: m.dataType || 'number', source_kind: m.sourceKind, source_ref: m.sourceRef || null, unit: m.unit || null,
    required: m.required === false ? 0 : 1, sort: m.sort ?? 999, note: m.note || null };
  const ex = q.get('SELECT id FROM report_mappings WHERE template_id = ? AND field_id = ?', templateId, m.fieldId);
  if (ex) update('report_mappings', ex.id, row); else insert('report_mappings', { id: newId('map'), template_id: templateId, field_id: m.fieldId, ...row });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'template.mapping', targetType: 'template', targetId: templateId, after: m });
}
export function deleteMapping(ctx, templateId, fieldId) {
  const t = q.get('SELECT * FROM report_templates WHERE id = ?', templateId); if (!t) throw notFound('模板');
  assertCan(ctx, 'config.write', null);
  if (t.status !== 'draft') throw conflict('只能修改草稿版模板的欄位');
  q.run('DELETE FROM report_mappings WHERE template_id = ? AND field_id = ?', templateId, fieldId);
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'template.mapping_delete', targetType: 'template', targetId: templateId, after: { fieldId } });
}

// ── 報告案件 ──
export function createCase(ctx, body) {
  assertCan(ctx, 'report.write', body.orgId);
  const tpl = body.templateId ? q.get('SELECT * FROM report_templates WHERE id = ?', body.templateId) : templateFor(body.templateCode, body.publishDate);
  if (!tpl || tpl.status !== 'published') throw bad('找不到適用的已發布模板（請確認報告發布日期與模板版次）');
  if (!body.year) throw bad('請填報告年度');
  const t = nowIso(); const id = newId('rc');
  insert('report_cases', { id, org_id: body.orgId, template_id: tpl.id, name: body.name || `${body.year} ${tpl.name}`, year: body.year, boundary_id: body.boundaryId || null,
    dataset_id: body.datasetId || null, due_date: body.dueDate || null, reviewer: body.reviewer || null, approver: body.approver || null,
    confidentiality: body.confidentiality || 'internal', publish_date: body.publishDate || null, status: 'preparing', created_by: ctx.userId, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'report.case_create', targetType: 'report_case', targetId: id, after: { template: `${tpl.code} v${tpl.version}`, year: body.year } });
  if (body.datasetId) markMapped(id);
  return { id, template: { code: tpl.code, version: tpl.version, name: tpl.name, standardVersion: tpl.standard_version } };
}

export function updateCase(ctx, id, body) {
  const c = q.get('SELECT * FROM report_cases WHERE id = ?', id); if (!c) throw notFound('報告案件');
  assertCan(ctx, 'report.write', c.org_id);
  if (['locked', 'exported', 'submitted_manual'].includes(c.status)) throw conflict('報告已封存');
  const patch = { updated_at: nowIso() };
  for (const [k, col] of [['name', 'name'], ['datasetId', 'dataset_id'], ['dueDate', 'due_date'], ['reviewer', 'reviewer'], ['approver', 'approver'], ['confidentiality', 'confidentiality'], ['boundaryId', 'boundary_id']]) {
    if (body[k] !== undefined) patch[col] = body[k];
  }
  if (body.manualValues) patch.manual_values = { ...j(c.manual_values, {}), ...body.manualValues };
  if (patch.dataset_id) { const d = q.get('SELECT org_id FROM datasets WHERE id = ?', patch.dataset_id); if (!d || d.org_id !== c.org_id) throw bad('資料集不屬於此院所'); }
  update('report_cases', id, patch);
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: c.org_id, action: 'report.case_update', targetType: 'report_case', targetId: id, after: patch });
  if (patch.dataset_id) markMapped(id);
}

export function getCase(ctx, id) {
  const c = q.get(`SELECT c.*, t.code AS template_code, t.name AS template_name, t.version AS template_version, t.standard_version, d.name AS dataset_name, d.status AS dataset_status, d.version AS dataset_version
    FROM report_cases c JOIN report_templates t ON t.id = c.template_id LEFT JOIN datasets d ON d.id = c.dataset_id WHERE c.id = ?`, id);
  if (!c) throw notFound('報告案件');
  assertCan(ctx, 'view.internal', c.org_id);
  return parseJson(c, ['manual_values']);
}

export function listCases(ctx, orgId) {
  const orgIds = orgId ? [orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return [];
  return q.all(`SELECT c.*, t.code AS template_code, t.name AS template_name, t.version AS template_version, t.standard_version, d.name AS dataset_name, d.status AS dataset_status, d.version AS dataset_version,
      (SELECT status FROM report_runs r WHERE r.case_id = c.id ORDER BY run_no DESC LIMIT 1) AS last_run_status, o.name AS org_name
    FROM report_cases c JOIN report_templates t ON t.id = c.template_id LEFT JOIN datasets d ON d.id = c.dataset_id JOIN organizations o ON o.id = c.org_id
    WHERE c.org_id IN (${orgIds.map(() => '?').join(',')}) ORDER BY c.year DESC, c.created_at DESC`, ...orgIds);
}

function mappingsFor(templateId) { return q.all('SELECT * FROM report_mappings WHERE template_id = ? ORDER BY sort', templateId); }

// 就緒度：每個欄位能否引用（PRD §9.2 報告就緒率的分母依版本化模板）
export function readiness(ctx, caseId) {
  const c = q.get('SELECT * FROM report_cases WHERE id = ?', caseId); if (!c) throw notFound('報告案件');
  assertCan(ctx, 'view.internal', c.org_id);
  const maps = mappingsFor(c.template_id);
  if (!c.dataset_id) return { ready: 0, total: maps.filter((m) => m.required).length, fields: maps.map((m) => ({ ...m, state: 'missing', note: '尚未指定資料集' })), datasetMissing: true, blockers: ['尚未指定資料集'] };
  const codes = maps.filter((m) => m.source_kind === 'indicator').map((m) => m.source_ref);
  const { results } = computeAll(c.dataset_id, codes);
  const manual = j(c.manual_values, {});
  const fields = maps.map((m) => {
    if (m.source_kind === 'indicator') { const r = results[m.source_ref]; return { ...m, value: r?.value ?? null, unit: r?.unit, state: r?.value_state || 'blocked', stateLabel: STATE_LABEL[r?.value_state], notes: r?.trace?.notes || [] }; }
    if (m.source_kind === 'manual') return { ...m, value: manual[m.field_id] ?? null, state: manual[m.field_id] ? 'measured' : (m.required ? 'missing' : 'not_applicable') };
    return { ...m, state: 'measured', note: '產製時自動彙整' };
  });
  const ok = (f) => ['measured', 'estimated', 'zero', 'not_applicable'].includes(f.state);
  const required = fields.filter((f) => f.required);
  const ds = q.get('SELECT status, version FROM datasets WHERE id = ?', c.dataset_id);
  return { ready: required.filter(ok).length, total: required.length, fields, dataset: ds,
    blockers: [...(ds.status !== 'locked' ? ['資料集尚未定版：可預覽，但不能送審'] : []), ...required.filter((f) => !ok(f)).map((f) => `${f.label}：${STATE_LABEL[f.state] || f.state}`)] };
}

// 產製：計算並把結果、版本凍結進 report_runs
export function generateRun(ctx, caseId) {
  const c = q.get('SELECT * FROM report_cases WHERE id = ?', caseId); if (!c) throw notFound('報告案件');
  assertCan(ctx, 'report.write', c.org_id);
  if (!c.dataset_id) throw conflict('請先指定資料集');
  if (['locked', 'exported', 'submitted_manual'].includes(c.status)) throw conflict('報告已封存，請建立新案件');
  const ds = q.get('SELECT * FROM datasets WHERE id = ?', c.dataset_id);
  const tpl = q.get('SELECT * FROM report_templates WHERE id = ?', c.template_id);
  const maps = mappingsFor(c.template_id);
  const codes = maps.filter((m) => m.source_kind === 'indicator').map((m) => m.source_ref);
  const calc = computeAll(c.dataset_id, codes);
  const manual = j(c.manual_values, {});
  const fields = {};
  for (const m of maps) {
    if (m.source_kind === 'indicator') { const r = calc.results[m.source_ref]; fields[m.field_id] = { value: r.value, unit: r.unit, state: r.value_state, indicator: m.source_ref }; }
    else if (m.source_kind === 'manual') fields[m.field_id] = { value: manual[m.field_id] ?? null, state: manual[m.field_id] ? 'measured' : 'missing' };
    else if (m.source_kind === 'evidence_list') fields[m.field_id] = { list: evidenceList(c.dataset_id) };
    else if (m.source_kind === 'quality') fields[m.field_id] = { quality: qualitySummary(c.dataset_id) };
  }
  const results = { fields, indicators: calc.results };
  const runNo = (q.get('SELECT MAX(run_no) n FROM report_runs WHERE case_id = ?', caseId)?.n || 0) + 1;
  const id = newId('run');
  const hash = sha256(JSON.stringify({ fields, dataset: ds.hash || ds.id, factors: calc.factorVersions, rules: calc.ruleVersions, template: tpl.version }));
  tx(() => {
    q.run("UPDATE report_runs SET status = 'superseded' WHERE case_id = ? AND status IN ('draft','returned')", caseId);
    insert('report_runs', { id, case_id: caseId, run_no: runNo, dataset_id: ds.id, dataset_hash: ds.hash || null, template_version: tpl.version,
      factor_versions: calc.factorVersions, rule_versions: calc.ruleVersions, results, readiness: null, hash, status: 'draft', created_by: ctx.userId, created_at: nowIso() });
    // 引用鏈：實際用到的採用值 → cited
    const factIds = new Set();
    for (const r of Object.values(calc.results)) for (const i of r.trace?.inputs || []) if (i.factId && !i.excluded) factIds.add(i.factId);
    // 佐證清單與品質摘要引用整個資料集
    if (maps.some((m) => ['evidence_list', 'quality'].includes(m.source_kind))) for (const f of q.all('SELECT id FROM approved_facts WHERE dataset_id = ? AND is_current = 1', ds.id)) factIds.add(f.id);
    for (const fid of factIds) {
      const f = q.get('SELECT asset_id FROM approved_facts WHERE id = ?', fid);
      const field = Object.entries(fields).find(([, v]) => v.indicator && (calc.results[v.indicator]?.trace?.inputs || []).some((i) => i.factId === fid));
      insert('usage_links', { id: newId('ul'), org_id: c.org_id, fact_id: fid, asset_id: f.asset_id, report_run_id: id, report_case_id: caseId,
        field_id: field?.[0] || null, indicator_code: field?.[1]?.indicator || null, usage_name: c.name, usage_type: 'report', status: 'cited', used_at: nowIso(), created_by: ctx.userId, created_at: nowIso() });
    }
    update('report_cases', caseId, { status: 'preparing', updated_at: nowIso() });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: c.org_id, action: 'report.generate', targetType: 'report_run', targetId: id, after: { runNo, hash, factors: calc.factorVersions } });
  });
  return { id, runNo, hash };
}

export function getRun(ctx, runId) {
  const r = q.get('SELECT r.*, c.org_id, c.name AS case_name, c.year, c.template_id, c.confidentiality FROM report_runs r JOIN report_cases c ON c.id = r.case_id WHERE r.id = ?', runId);
  if (!r) throw notFound('報告版本');
  assertCan(ctx, 'view.internal', r.org_id);
  const tpl = templateDetail(r.template_id);
  const out = { ...parseJson(r, ['factor_versions', 'rule_versions', 'results']), template: tpl };
  // 財務欄位遮罩
  if (!can(ctx, 'view.sensitive', r.org_id)) {
    for (const [k, f] of Object.entries(out.results.fields || {})) if (/cost/.test(f.indicator || '') || /cost/.test(k)) out.results.fields[k] = { ...f, value: null, masked: true };
  }
  out.artifacts = q.all('SELECT id, format, sha256, size, created_at FROM report_artifacts WHERE run_id = ? ORDER BY created_at DESC', runId);
  return out;
}
export function listRuns(ctx, caseId) {
  const c = q.get('SELECT org_id FROM report_cases WHERE id = ?', caseId); if (!c) throw notFound('報告案件');
  assertCan(ctx, 'view.internal', c.org_id);
  return q.all('SELECT r.id, r.run_no, r.status, r.hash, r.dataset_id, r.template_version, r.created_at, r.approved_at, r.locked_at, u.display_name AS created_by_name FROM report_runs r LEFT JOIN users u ON u.id = r.created_by WHERE case_id = ? ORDER BY run_no DESC', caseId);
}

// 送審：資料集須已定版、必要欄位全部可引用（缺漏不可用 0 帶過）
export function submitRun(ctx, runId) {
  const r = q.get('SELECT r.*, c.org_id, c.reviewer, c.name FROM report_runs r JOIN report_cases c ON c.id = r.case_id WHERE r.id = ?', runId); if (!r) throw notFound('報告版本');
  assertCan(ctx, 'report.write', r.org_id);
  if (!['draft', 'returned'].includes(r.status)) throw conflict('此版本不是草稿');
  const ds = q.get('SELECT status FROM datasets WHERE id = ?', r.dataset_id);
  if (ds.status !== 'locked') throw conflict('資料集尚未定版，不能送審（未核准觀測值不得進入正式報告）');
  const results = j(r.results, {});
  const maps = mappingsFor(q.get('SELECT template_id FROM report_cases WHERE id = ?', r.case_id).template_id);
  const missing = maps.filter((m) => m.required && results.fields?.[m.field_id] && ['missing', 'blocked', 'partial'].includes(results.fields[m.field_id].state));
  if (missing.length) throw conflict(`必要欄位缺漏：${missing.map((m) => m.label).join('、')}。請補件、裁決或明示不適用`, { fields: missing.map((m) => m.field_id) });
  update('report_runs', runId, { status: 'in_review', submitted_at: nowIso() });
  update('report_cases', r.case_id, { status: 'in_review', updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: r.org_id, action: 'report.submit', targetType: 'report_run', targetId: runId });
  if (r.reviewer) notify(r.reviewer, 'report.review', `報告待審：${r.name}`, '', `#/reports/run/${runId}`);
  else notifyRole(r.org_id, 'report.review', 'report.review', `報告待審：${r.name}`, '', `#/reports/run/${runId}`, ctx.userId);
}

export function reviewRun(ctx, runId, { approve, note }) {
  const r = q.get('SELECT r.*, c.org_id, c.approver, c.name FROM report_runs r JOIN report_cases c ON c.id = r.case_id WHERE r.id = ?', runId); if (!r) throw notFound('報告版本');
  assertCan(ctx, 'report.review', r.org_id);
  if (r.status !== 'in_review') throw conflict('此版本不是待審狀態');
  if (r.created_by === ctx.userId) throw conflict('審查者不可以是產製者');
  if (!approve && !note) throw bad('退回需填理由');
  update('report_runs', runId, approve ? { reviewed_by: ctx.userId, reviewed_at: nowIso(), review_note: note || null } : { status: 'returned', reviewed_by: ctx.userId, reviewed_at: nowIso(), review_note: note });
  if (!approve) update('report_cases', r.case_id, { status: 'preparing', updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: r.org_id, action: approve ? 'report.review_pass' : 'report.return', targetType: 'report_run', targetId: runId, after: { note } });
  if (approve) { if (r.approver) notify(r.approver, 'report.approve', `報告待核准：${r.name}`, '', `#/reports/run/${runId}`); else notifyRole(r.org_id, 'report.approve', 'report.approve', `報告待核准：${r.name}`, '', `#/reports/run/${runId}`, ctx.userId); }
  else notify(r.created_by, 'report.returned', `報告退回：${r.name}`, note, `#/reports/run/${runId}`);
}

// 核准＋封存：核准者 ≠ 產製者 ≠ 審查者
export function approveRun(ctx, runId, { note } = {}) {
  const r = q.get('SELECT r.*, c.org_id, c.name FROM report_runs r JOIN report_cases c ON c.id = r.case_id WHERE r.id = ?', runId); if (!r) throw notFound('報告版本');
  assertCan(ctx, 'report.approve', r.org_id);
  if (r.status !== 'in_review' || !r.reviewed_by) throw conflict('報告須先通過審查');
  if ([r.created_by, r.reviewed_by].includes(ctx.userId)) throw conflict('核准者不可以是產製者或審查者');
  // 資料集雜湊必須仍一致
  const ds = q.get('SELECT hash, status FROM datasets WHERE id = ?', r.dataset_id);
  if (r.dataset_hash && ds.hash !== r.dataset_hash) throw conflict('資料集內容與產製時不同，請重新產製');
  const t = nowIso();
  tx(() => {
    update('report_runs', runId, { status: 'approved', approved_by: ctx.userId, approved_at: t, review_note: [r.review_note, note].filter(Boolean).join('；') || null });
    update('report_runs', runId, { status: 'locked', locked_at: t });
    update('report_cases', r.case_id, { status: 'locked', updated_at: t });
    q.run("UPDATE usage_links SET status = 'published' WHERE report_run_id = ?", runId);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: r.org_id, action: 'report.approve_lock', targetType: 'report_run', targetId: runId, after: { hash: r.hash } });
  });
  // 回饋第一線：通知被引用資料的提交者
  const submitters = q.all(`SELECT DISTINCT o.submitted_by FROM usage_links ul JOIN approved_facts af ON af.id = ul.fact_id JOIN observations o ON o.id IN (SELECT value FROM json_each(af.observation_ids))
    WHERE ul.report_run_id = ?`, runId).map((x) => x.submitted_by).filter((u) => u && u !== 'system');
  for (const u of submitters) notify(u, 'usage.published', `你提供的資料已被「${r.name}」採用`, '', '#/feedback');
  return { hash: r.hash };
}

// 重現：用封存時的資料集與係數／規則版本重算，比對雜湊
export function reproduce(ctx, runId) {
  const r = q.get('SELECT r.*, c.org_id, c.template_id, c.manual_values FROM report_runs r JOIN report_cases c ON c.id = r.case_id WHERE r.id = ?', runId); if (!r) throw notFound('報告版本');
  assertCan(ctx, 'view.internal', r.org_id);
  const stored = j(r.results, {});
  const codes = Object.values(stored.fields || {}).filter((f) => f.indicator).map((f) => f.indicator);
  const calc = computeAll(r.dataset_id, codes, { pinnedRules: j(r.rule_versions, {}), pinnedFactors: j(r.factor_versions, {}) });
  const diffs = [];
  for (const [fid, f] of Object.entries(stored.fields || {})) {
    if (!f.indicator) continue;
    const now = calc.results[f.indicator];
    if (now.value !== f.value || now.value_state !== f.state) diffs.push({ field: fid, stored: f.value, now: now.value, storedState: f.state, nowState: now.value_state });
  }
  const ds = q.get('SELECT hash FROM datasets WHERE id = ?', r.dataset_id);
  return { reproducible: !diffs.length && (!r.dataset_hash || ds.hash === r.dataset_hash), diffs, datasetHashOk: !r.dataset_hash || ds.hash === r.dataset_hash };
}

// 標示「已依官方格式匯出、人工送件」：不宣稱自動申報完成
export function markManualSubmission(ctx, caseId, { note, submittedAt }) {
  const c = q.get('SELECT * FROM report_cases WHERE id = ?', caseId); if (!c) throw notFound('報告案件');
  assertCan(ctx, 'report.approve', c.org_id);
  if (!['locked', 'exported'].includes(c.status)) throw conflict('報告須先封存');
  if (!note) throw bad('請記錄送件方式與日期');
  update('report_cases', caseId, { status: 'submitted_manual', updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: c.org_id, action: 'report.manual_submitted', targetType: 'report_case', targetId: caseId, after: { note, submittedAt } });
}

// ── 品質摘要與佐證清單 ──
export function qualitySummary(datasetId) {
  const facts = q.all('SELECT af.*, a.domain FROM approved_facts af JOIN assets a ON a.id = af.asset_id WHERE dataset_id = ? AND is_current = 1', datasetId);
  const by = (fn) => facts.reduce((o, f) => { const k = fn(f); o[k] = (o[k] || 0) + 1; return o; }, {});
  const decisions = q.all('SELECT decision_type, impact FROM decisions WHERE dataset_id = ? AND status = \'approved\'', datasetId);
  return { facts: facts.length, byState: by((f) => f.value_state), byDomain: by((f) => f.domain),
    decisions: decisions.reduce((o, d) => { o[d.decision_type] = (o[d.decision_type] || 0) + 1; return o; }, {}),
    highImpact: decisions.filter((d) => d.impact === 'high').length,
    openCases: q.get("SELECT COUNT(*) n FROM discrepancy_cases c WHERE c.org_id = (SELECT org_id FROM datasets WHERE id = ?) AND c.status <> 'closed'", datasetId).n };
}
export function evidenceList(datasetId) {
  return q.all(`SELECT DISTINCT e.id, e.filename, e.sha256, e.kind, a.name AS asset_name, af.metric_code, af.period_start, af.period_end
    FROM approved_facts af JOIN json_each(af.observation_ids) je JOIN observation_evidence oe ON oe.observation_id = je.value
    JOIN evidence_files e ON e.id = oe.evidence_id JOIN assets a ON a.id = af.asset_id WHERE af.dataset_id = ? AND af.is_current = 1 ORDER BY a.name, af.period_start`, datasetId);
}

// 報告案件指定資料集後：資料集中與模板指標相關的採用值標「已對應欄位」
function markMapped(caseId) {
  const c = q.get('SELECT * FROM report_cases WHERE id = ?', caseId);
  if (!c?.dataset_id) return;
  for (const f of q.all('SELECT id, asset_id FROM approved_facts WHERE dataset_id = ? AND is_current = 1', c.dataset_id)) {
    if (q.get('SELECT 1 FROM usage_links WHERE fact_id = ? AND report_case_id = ?', f.id, caseId)) continue;
    insert('usage_links', { id: newId('ul'), org_id: c.org_id, fact_id: f.id, asset_id: f.asset_id, report_case_id: caseId, usage_name: c.name, usage_type: 'report', status: 'mapped', created_by: 'system', created_at: nowIso() });
  }
}

// ── M12 成果回饋 ──
export function feedbackFor(ctx, { assetId, mine, orgId } = {}) {
  const where = ["ul.status IN ('cited','published')"]; const p = [];
  if (assetId) { const a = q.get('SELECT org_id FROM assets WHERE id = ?', assetId); if (!a) throw notFound('標的'); assertCan(ctx, 'view.internal', a.org_id); where.push('ul.asset_id = ?'); p.push(assetId); }
  else if (orgId) { assertCan(ctx, 'view.public', orgId); where.push('ul.org_id = ?'); p.push(orgId); }
  else { const ids = orgsFor(ctx, 'view.public'); if (!ids.length) return []; where.push(`ul.org_id IN (${ids.map(() => '?').join(',')})`); p.push(...ids); }
  if (mine) where.push(`ul.fact_id IN (SELECT af.id FROM approved_facts af JOIN json_each(af.observation_ids) je JOIN observations o ON o.id = je.value WHERE o.submitted_by = ?)`), p.push(ctx.userId);
  const rows = q.all(`SELECT ul.report_case_id, ul.usage_name, ul.usage_type, MAX(ul.status) AS status, MAX(ul.used_at) AS used_at, COUNT(DISTINCT ul.fact_id) AS facts,
      GROUP_CONCAT(DISTINCT ul.indicator_code) AS indicators, GROUP_CONCAT(DISTINCT a.name) AS assets, rc.year, t.name AS template_name, t.standard
    FROM usage_links ul LEFT JOIN assets a ON a.id = ul.asset_id LEFT JOIN report_cases rc ON rc.id = ul.report_case_id LEFT JOIN report_templates t ON t.id = rc.template_id
    WHERE ${where.join(' AND ')} GROUP BY ul.report_case_id, ul.usage_name ORDER BY used_at DESC`, ...p);
  return rows.map((r) => ({ ...r, indicators: (r.indicators || '').split(',').filter(Boolean), assets: (r.assets || '').split(',').filter(Boolean) }));
}
// 候選用途（還沒實際引用）：來自盤點項目字典，明確標「候選」
export function usageCandidates(assetId) {
  const a = q.get('SELECT i.usage_candidates FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.id = ?', assetId);
  return j(a?.usage_candidates, []).map((u) => ({ name: u, status: 'candidate' }));
}
