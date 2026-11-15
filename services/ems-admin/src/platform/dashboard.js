// M11 統整資訊看板（PRD §9）：四層（公開／管理／報告／設備能源），KPI 分開算，避免虛假的「完成率」。
// 公開層只給彙總數字：不含費用、識別碼、聯絡人、原始文件；API 也不接受會還原明細的篩選。
import { q } from './db.js';
import { assertCan, can, orgsFor, descendants, orgById } from './authz.js';
import { yearRange, allocateMonthly, isCalendarMonth, round, j } from './util.js';
import { readiness } from './reports.js';
import { DOMAINS } from './seed/dictionary.js';

const D4 = ['oil', 'water', 'electricity', 'gas'];
const rate = (n, d) => (d ? round(n / d * 100, 1) : null);

// 每個適用標的的「資料需求」：data_spec 指定的指標；沒指定就用盤點項目的第一個指標
function requirements(orgIds) {
  if (!orgIds.length) return [];
  const assets = q.all(`SELECT a.id, a.org_id, a.site_id, a.domain, a.applicability, a.applicability_approved_by, a.data_spec, a.owner_status, i.metrics
    FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id IN (${orgIds.map(() => '?').join(',')}) AND a.status IN ('active','draft') AND a.domain IN ('oil','water','electricity','gas')`, ...orgIds);
  return assets.map((a) => {
    const spec = j(a.data_spec, []);
    const metrics = spec.length ? spec.filter((s) => s.required !== false).map((s) => s.metric || s) : j(a.metrics, []).slice(0, 1);
    return { ...a, req: metrics };
  });
}

export function kpis(orgIds, year) {
  const [from, to] = yearRange(year);
  const assets = requirements(orgIds);
  const byDomain = Object.fromEntries(D4.map((d) => [d, emptyK()]));
  const total = emptyK();
  for (const a of assets) {
    const k = [byDomain[a.domain], total];
    const determined = a.applicability === 'applicable' || (a.applicability === 'not_applicable' && a.applicability_approved_by);
    k.forEach((x) => { x.assets++; if (determined) x.determined++; });
    if (a.applicability !== 'applicable') continue;
    const hasSource = q.get('SELECT 1 FROM data_sources WHERE asset_id = ? AND active = 1', a.id);
    k.forEach((x) => { x.applicable++; if (hasSource) x.located++; });
    for (const m of a.req) {
      k.forEach((x) => x.requirements++);
      const obs = q.all(`SELECT id, quality_status FROM observations WHERE asset_id = ? AND metric_code = ? AND quality_status <> 'superseded' AND period_end > ? AND period_start < ?`, a.id, m, from, to);
      if (!obs.length) continue;
      k.forEach((x) => x.acquired++);
      const openCase = q.get("SELECT 1 FROM discrepancy_cases WHERE asset_id = ? AND (metric_code = ? OR metric_code IS NULL) AND status <> 'closed'", a.id, m);
      const valid = !openCase && obs.every((o) => ['valid', 'warning'].includes(o.quality_status));
      if (valid) k.forEach((x) => x.validated++);
      const fact = q.get(`SELECT d.status FROM approved_facts af JOIN datasets d ON d.id = af.dataset_id WHERE af.asset_id = ? AND af.metric_code = ? AND af.is_current = 1 AND d.year = ?
                          ORDER BY CASE d.status WHEN 'locked' THEN 0 ELSE 1 END LIMIT 1`, a.id, m, year);
      if (fact) k.forEach((x) => { x.approved++; if (['locked', 'superseded'].includes(fact.status)) x.locked++; });
    }
  }
  const out = (x) => ({
    ...x,
    applicabilityRate: rate(x.determined, x.assets), sourceLocationRate: rate(x.located, x.applicable), acquisitionRate: rate(x.acquired, x.requirements),
    validationRate: rate(x.validated, x.acquired), reviewRate: rate(x.approved, x.acquired), lockRate: rate(x.locked, x.acquired),
  });
  const cases = orgIds.length ? q.all(`SELECT severity, due_date FROM discrepancy_cases WHERE org_id IN (${orgIds.map(() => '?').join(',')}) AND status <> 'closed'`, ...orgIds) : [];
  const today = new Date().toISOString().slice(0, 10);
  const usage = orgIds.length ? q.get(`SELECT COUNT(DISTINCT report_case_id) n, COUNT(*) links FROM usage_links WHERE org_id IN (${orgIds.map(() => '?').join(',')}) AND status IN ('cited','published')`, ...orgIds) : { n: 0, links: 0 };
  const candidates = orgIds.length ? q.get(`SELECT COUNT(*) n FROM usage_links WHERE org_id IN (${orgIds.map(() => '?').join(',')}) AND status IN ('candidate','evaluated','mapped')`, ...orgIds).n : 0;
  return {
    year, total: out(total), byDomain: Object.fromEntries(Object.entries(byDomain).map(([d, x]) => [d, { ...out(x), name: DOMAINS[d].name }])),
    discrepancies: { open: cases.length, bySeverity: cases.reduce((o, c) => { o[c.severity] = (o[c.severity] || 0) + 1; return o; }, {}), overdue: cases.filter((c) => c.due_date && c.due_date < today).length },
    usage: { reports: usage.n, citations: usage.links, candidateOnly: candidates },
    definitions: KPI_DEFINITIONS,
  };
}
function emptyK() { return { assets: 0, determined: 0, applicable: 0, located: 0, requirements: 0, acquired: 0, validated: 0, approved: 0, locked: 0 }; }

export const KPI_DEFINITIONS = {
  applicabilityRate: '標的適用性確認率＝已判定適用或不適用（不適用須經核准）的標的 ÷ 標的總數',
  sourceLocationRate: '來源定位率＝已確認資料取得路徑的適用標的 ÷ 適用標的數（不需已知道部門）',
  acquisitionRate: '資料取得率＝已取得資料的資料需求 ÷ 應取得資料需求（數字存在不代表合格）',
  validationRate: '驗證通過率＝驗證通過且無未結差異的資料需求 ÷ 已取得資料需求',
  reviewRate: '審核完成率＝已有核准採用值的資料需求 ÷ 已取得資料需求（已核准與已定版分開）',
  lockRate: '定版率＝採用值已在定版資料集的資料需求 ÷ 已取得資料需求',
  reportReadiness: '報告就緒率＝某報告所需且已達可引用狀態的欄位數 ÷ 該報告適用欄位數（分母依版本化模板）',
  discrepancies: '差異待辦量＝尚未結案的差異案件數（分嚴重程度及逾期）',
  usage: '成果實際引用數＝已定版資料被報告引用的次數（候選用途另計，不算實際引用）',
};

function scopeOrgs(ctx, action, orgId) {
  if (orgId) { assertCan(ctx, action, orgId); return [...descendants(orgId)].filter((id) => orgsFor(ctx, action).includes(id)); }
  const ids = orgsFor(ctx, action);
  if (!ids.length) assertCan(ctx, action, null);
  return ids;
}

// 公開進度看板
export function publicBoard(ctx, { orgId, year }) {
  const orgIds = scopeOrgs(ctx, 'view.public', orgId);
  const y = Number(year) || new Date().getFullYear();
  const k = kpis(orgIds, y);
  const sites = orgIds.map((id) => ({ org: orgById(id)?.name, kind: orgById(id)?.kind, ...pickRates(kpis([id], y).total) })).filter((s) => s.kind !== 'group');
  return { level: 'public', year: y, total: pickRates(k.total), byDomain: Object.fromEntries(Object.entries(k.byDomain).map(([d, x]) => [d, { name: x.name, ...pickRates(x) }])),
    sites, discrepancies: { open: k.discrepancies.open, overdue: k.discrepancies.overdue }, usage: { reports: k.usage.reports }, definitions: k.definitions };
}
function pickRates(x) {
  return { applicabilityRate: x.applicabilityRate, sourceLocationRate: x.sourceLocationRate, acquisitionRate: x.acquisitionRate, validationRate: x.validationRate, reviewRate: x.reviewRate, lockRate: x.lockRate,
    assets: x.assets, applicable: x.applicable };
}

// 管理看板：加上阻塞清單、未知保管者、逾期、處理績效、費用彙總（需 view.sensitive）
export function managementBoard(ctx, { orgId, year }) {
  const orgIds = scopeOrgs(ctx, 'view.management', orgId);
  const y = Number(year) || new Date().getFullYear();
  const k = kpis(orgIds, y);
  const ph = orgIds.map(() => '?').join(',') || "''";
  const today = new Date().toISOString().slice(0, 10);
  const unknownOwner = orgIds.length ? q.all(`SELECT a.id, a.name, a.domain, o.name AS org_name FROM assets a JOIN organizations o ON o.id = a.org_id WHERE a.org_id IN (${ph}) AND a.applicability = 'applicable' AND a.owner_status = 'unknown' AND a.status = 'active' LIMIT 50`, ...orgIds) : [];
  const overdueTasks = orgIds.length ? q.all(`SELECT t.title, t.due_date, u.display_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee WHERE t.org_id IN (${ph}) AND t.status IN ('open','in_progress') AND t.due_date < ? ORDER BY t.due_date LIMIT 50`, ...orgIds, today) : [];
  const highCases = orgIds.length ? q.all(`SELECT c.id, c.summary, c.severity, c.due_date, a.name AS asset_name FROM discrepancy_cases c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.org_id IN (${ph}) AND c.status <> 'closed' AND c.severity IN ('high','critical') ORDER BY c.due_date LIMIT 50`, ...orgIds) : [];
  const closeDays = orgIds.length ? q.get(`SELECT AVG(julianday(closed_at) - julianday(opened_at)) d, COUNT(*) n FROM discrepancy_cases WHERE org_id IN (${ph}) AND status = 'closed' AND opened_at >= ?`, ...orgIds, `${y}-01-01`) : { d: null, n: 0 };
  let costs = null;
  if (orgIds.every((id) => can(ctx, 'view.sensitive', id))) {
    const [from, to] = yearRange(y);
    costs = orgIds.length ? q.all(`SELECT m.code, m.name, SUM(af.value) total FROM approved_facts af JOIN metrics m ON m.code = af.metric_code JOIN datasets d ON d.id = af.dataset_id
      WHERE af.org_id IN (${ph}) AND af.is_current = 1 AND m.semantics = 'cost' AND d.year = ? AND d.status IN ('approved','locked') AND af.period_start >= ? AND af.period_end <= ? GROUP BY m.code`, ...orgIds, y, from, to) : [];
  }
  const sites = orgIds.map((id) => ({ orgId: id, org: orgById(id)?.name, kind: orgById(id)?.kind, ...kpis([id], y).total })).filter((s) => s.kind !== 'group');
  return { level: 'management', year: y, ...k, sites, blockers: { unknownOwner, overdueTasks, highCases }, casePerformance: { closed: closeDays.n, avgCloseDays: closeDays.d ? round(closeDays.d, 1) : null }, costs };
}

// 報告看板
export function reportBoard(ctx, { orgId, year }) {
  const orgIds = scopeOrgs(ctx, 'view.internal', orgId);
  if (!orgIds.length) return { level: 'report', cases: [] };
  const cases = q.all(`SELECT c.id, c.name, c.year, c.status, c.due_date, c.org_id, t.name AS template_name, t.standard_version FROM report_cases c JOIN report_templates t ON t.id = c.template_id
    WHERE c.org_id IN (${orgIds.map(() => '?').join(',')}) ${year ? 'AND c.year = ?' : ''} ORDER BY c.due_date`, ...orgIds, ...(year ? [Number(year)] : []));
  return { level: 'report', cases: cases.map((c) => { const r = readiness(ctx, c.id); return { ...c, ready: r.ready, total: r.total, readinessRate: rate(r.ready, r.total), blockers: r.blockers?.slice(0, 5) || [] }; }) };
}

// 設備與能源看板：各面向月趨勢（優先採用值，沒有就用通過檢核的觀測，並標示來源層級）
const TREND_METRICS = { electricity: ['elec_purchased_kwh'], water: ['water_withdrawal_m3'], oil: ['oil_consumption_l'], gas: ['ng_consumption_m3', 'lpg_consumption_kg'] };
export function energyBoard(ctx, { orgId, year }) {
  const orgIds = scopeOrgs(ctx, 'view.internal', orgId);
  const y = Number(year) || new Date().getFullYear();
  const [from, to] = yearRange(y);
  const out = {};
  for (const [domain, metrics] of Object.entries(TREND_METRICS)) {
    out[domain] = {};
    for (const m of metrics) {
      const months = new Map(); let layer = 'approved';
      let rows = orgIds.length ? q.all(`SELECT af.period_start, af.period_end, af.value FROM approved_facts af JOIN datasets d ON d.id = af.dataset_id WHERE af.org_id IN (${orgIds.map(() => '?').join(',')})
        AND af.metric_code = ? AND af.is_current = 1 AND d.year = ? AND af.value IS NOT NULL`, ...orgIds, m, y) : [];
      if (!rows.length && orgIds.length) {
        layer = 'observed';
        // 同標的同期間有多個來源時只取優先序最高的一個，避免重複加總
        const all = q.all(`SELECT o.asset_id, o.period_start, o.period_end, o.value_std AS value, s.priority FROM observations o JOIN data_sources s ON s.id = o.source_id
          WHERE o.org_id IN (${orgIds.map(() => '?').join(',')}) AND o.metric_code = ? AND o.quality_status IN ('valid','warning') AND o.period_end > ? AND o.period_start < ? AND o.value_std IS NOT NULL`, ...orgIds, m, from, to);
        const best = new Map();
        for (const r of all) { const k = `${r.asset_id}|${r.period_start}|${r.period_end}`; if (!best.has(k) || best.get(k).priority < r.priority) best.set(k, r); }
        rows = [...best.values()];
      }
      for (const r of rows) {
        const parts = isCalendarMonth(r.period_start, r.period_end) ? [{ period_start: r.period_start, value: r.value }] : allocateMonthly(r.period_start, r.period_end, r.value);
        for (const p of parts) if (p.period_start >= from && p.period_start < to) months.set(p.period_start.slice(0, 7), (months.get(p.period_start.slice(0, 7)) || 0) + p.value);
      }
      const unit = q.get('SELECT std_unit FROM metrics WHERE code = ?', m)?.std_unit;
      out[domain][m] = { unit, layer, layerLabel: layer === 'approved' ? '採用值' : '已檢核觀測值（尚未核准）', months: [...months.entries()].sort().map(([month, v]) => ({ month, value: round(v, 2) })) };
    }
  }
  const anomalies = orgIds.length ? q.all(`SELECT vr.message, vr.rule_code, vr.severity, a.name AS asset_name, v.started_at FROM validation_results vr JOIN validation_runs v ON v.id = vr.run_id
    LEFT JOIN assets a ON a.id = vr.asset_id WHERE v.org_id IN (${orgIds.map(() => '?').join(',')}) AND vr.rule_code IN ('history_anomaly','meter_balance','oil_balance','cumulative_backward')
    AND v.started_at = (SELECT MAX(started_at) FROM validation_runs WHERE org_id = v.org_id) LIMIT 50`, ...orgIds) : [];
  return { level: 'energy', year: y, trends: out, anomalies };
}

// 個人工作台頂部數字（PRD §7.1）
export function workbenchCounts(ctx, orgId) {
  const orgIds = orgId ? [orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return {};
  const ph = orgIds.map(() => '?').join(',');
  const mine = q.get("SELECT COUNT(*) n FROM tasks WHERE assignee = ? AND status IN ('open','in_progress')", ctx.userId).n
    + q.get("SELECT COUNT(*) n FROM source_search_tasks WHERE assignee = ? AND status NOT IN ('found','closed')", ctx.userId).n
    + q.get("SELECT COUNT(*) n FROM discrepancy_cases WHERE owner = ? AND status <> 'closed'", ctx.userId).n;
  const c = (sql) => q.get(sql.replace('$ORGS', ph), ...orgIds).n;
  return {
    myTodo: mine,
    doneThisPeriod: c(`SELECT COUNT(*) n FROM assets WHERE org_id IN ($ORGS) AND work_status IN ('approved','locked')`),
    findingSource: c(`SELECT COUNT(*) n FROM assets WHERE org_id IN ($ORGS) AND work_status IN ('to_register','finding_source') AND applicability <> 'not_applicable' AND status <> 'archived'`),
    awaitingEvidence: c(`SELECT COUNT(*) n FROM discrepancy_cases WHERE org_id IN ($ORGS) AND status = 'awaiting_evidence'`) + c(`SELECT COUNT(*) n FROM assets WHERE org_id IN ($ORGS) AND work_status = 'returned'`),
    discrepancies: c(`SELECT COUNT(*) n FROM discrepancy_cases WHERE org_id IN ($ORGS) AND status <> 'closed'`),
    usedResults: c(`SELECT COUNT(DISTINCT report_case_id) n FROM usage_links WHERE org_id IN ($ORGS) AND status IN ('cited','published')`),
    pendingReview: c(`SELECT COUNT(*) n FROM decisions WHERE org_id IN ($ORGS) AND status IN ('proposed','first_approved')`),
  };
}
