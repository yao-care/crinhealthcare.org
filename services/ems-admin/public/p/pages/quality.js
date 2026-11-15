// 數據品質中心（PRD §8.2、§10）：檢核執行與結果、差異案件、待審核採用值、多來源並排比對。
import { state, get, post, h, route, page, card, table, link, chip, domainChip, valueStateChip, qualityChip, sevChip, fmtNum, fmtPeriod, fmtTime, fmtDate,
  action, btn, modal, formModal, form, userOptions, toast, can, setQuery, select, needOrg, render, note, dl, go, metricName, metricOptions, itemOf, inclEndToExcl } from '../core.js';

export function register() {
  route('/quality/runs', runsPage, { title: '檢核規則與結果' });
  route('/quality/runs/:id', runPage, { title: '檢核結果' });
  route('/quality/cases', casesPage, { title: '差異案件' });
  route('/quality/cases/:id', casePage, { title: '差異案件詳細' });
  route('/quality/review', reviewPage, { title: '待審核採用值' });
  route('/quality/compare/:assetId', comparePage, { title: '資料來源與差異審查' });
}

const CRUMB = ['#/quality/runs', '數據品質中心'];
const caseStatusLabel = (s) => state.meta?.caseStatus?.[s] || s;
const CASE_KIND = { open: 'todo', assigned: 'info', investigating: 'info', awaiting_evidence: 'warn', proposed: 'info', in_review: 'info', closed: 'ok', reopened: 'alert' };
const caseStatusChip = (s) => chip(caseStatusLabel(s), CASE_KIND[s] || '');
const DECISION_TYPE = { select_source: '採用某一來源', derived: '衍生值（計算／估算）', not_applicable: '明示不適用', missing: '明示缺漏', reject: '退回補件' };
const DECISION_STATUS = { proposed: ['待審核', 'todo'], first_approved: ['已一審，待覆核', 'info'], approved: ['已核准', 'ok'], rejected: ['已駁回', 'alert'], returned: ['已退回', 'alert'], withdrawn: ['已撤回', ''] };
const decisionStatusChip = (s) => chip(...(DECISION_STATUS[s] || [s, '']));
const RUN_STATUS = { draft: '草稿', in_review: '審查中', returned: '已退回', approved: '已核准', locked: '已封存', superseded: '已被新版取代' };
const SEVERITIES = [['critical', '緊急'], ['high', '高'], ['medium', '中'], ['low', '低']];
const myId = () => state.me?.user?.id;
// 半開區間迄日 → 表單上的含迄日（瞬時讀值 end = start 時維持原值）
function exclToIncl(start, end) {
  // 後端跨來源案件只存月份起日（period_end 為 null）：視為整個自然月
  if (!end && start && /-01$/.test(start)) { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
  if (!end) return '';
  if (start && end <= start) return end;
  const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
}
const jsonText = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } } return JSON.stringify(v, null, 2); };
const valueText = (v, unit) => (v === null || v === undefined ? '—' : `${fmtNum(v, 4)}${unit ? ` ${unit}` : ''}`);

// ── 檢核執行 ──
async function runsPage() {
  const orgId = needOrg();
  const runs = await get('validations/runs', { orgId });
  const run = can('validation.run') ? action(`▶ 執行 ${state.year} 年度檢核`, async () => {
    const r = await post('validations/runs', { orgId, year: state.year });
    toast(`檢核完成：${r.summary.observations} 筆觀測、${r.summary.results} 項結果`);
    go(`#/quality/runs/${r.runId}`);
  }, 'primary') : null;
  const sevList = (s) => { const b = s?.bySeverity || {}; const ks = Object.keys(b); return ks.length ? h('span', ks.map((k) => [sevChip(k), ` ${b[k]} `])) : chip('無異常', 'ok'); };
  const ruleList = (s) => { const b = s?.byRule || {}; const ks = Object.keys(b); return ks.length ? ks.map((k) => `${k}×${b[k]}`).join('、') : '—'; };
  const scopeText = (sc) => [sc?.assetId ? `單一標的` : '全院', sc?.from && sc?.to ? fmtPeriod(sc.from, sc.to) : null].filter(Boolean).join('・');
  return page('檢核規則與結果', { crumbs: [CRUMB, '檢核規則與結果'], actions: [run], intro: '檢核會依已發布的規則版本檢查觀測值（缺期、重複、跨來源差異、油槽平衡、異常跳動等），結果會更新觀測值的品質狀態並自動開立差異案件。' },
    can('validation.run') ? null : note('你沒有「執行檢核」權限，只能檢視過去的結果。'),
    card('執行紀錄', table([
      { label: '執行時間', render: (r) => link(`#/quality/runs/${r.id}`, fmtTime(r.started_at)) },
      { label: '範圍', render: (r) => scopeText(r.scope) },
      { label: '規則版本', render: (r) => `v${r.ruleset_version}` },
      { label: '狀態', render: (r) => chip(r.status === 'done' ? '完成' : r.status === 'running' ? '執行中' : r.status, r.status === 'done' ? 'ok' : 'info') },
      { label: '觀測數', num: true, render: (r) => fmtNum(r.summary?.observations) },
      { label: '結果數', num: true, render: (r) => fmtNum(r.summary?.results) },
      { label: '嚴重度', render: (r) => sevList(r.summary) },
      { label: '規則', render: (r) => ruleList(r.summary) },
    ], runs, { empty: '這個院所還沒有執行過檢核', onRow: (r) => go(`#/quality/runs/${r.id}`) })));
}

async function runPage({ id }, qy) {
  const r = await get(`validations/runs/${id}`);
  if (!r) throw Object.assign(new Error('找不到這次檢核'), { status: 404 });
  const sev = qy.severity || '';
  const rows = r.results.filter((x) => !sev || x.severity === sev);
  const b = r.summary?.bySeverity || {};
  return page(`檢核結果 ${fmtTime(r.started_at)}`, { crumbs: [CRUMB, ['#/quality/runs', '檢核規則與結果'], '檢核結果'] },
    card('摘要', dl([['規則版本', `v${r.ruleset_version}`], ['觀測數', fmtNum(r.summary?.observations)], ['結果數', fmtNum(r.summary?.results)],
      ['依嚴重度', Object.keys(b).length ? h('span', Object.entries(b).map(([k, n]) => [sevChip(k), ` ${n} `])) : chip('無異常', 'ok')],
      ['依規則', Object.entries(r.summary?.byRule || {}).map(([k, n]) => `${k}×${n}`).join('、') || '—'], ['完成時間', fmtTime(r.finished_at)]])),
    card('結果明細',
      h('div', { class: 'pf-bar' }, select([['', '全部嚴重度'], ['blocker', '阻擋'], ['error', '錯誤'], ['warning', '警示'], ['info', '提示']], sev, (v) => setQuery({ severity: v }), { 'aria-label': '嚴重度' })),
      table([
        { label: '嚴重度', render: (x) => sevChip(x.severity) },
        { label: '規則', render: (x) => h('span', { class: 'pf-mono' }, x.rule_code) },
        { label: '標的', render: (x) => (x.asset_id ? link(`#/assets/${x.asset_id}`, x.asset_name || x.asset_id) : '—') },
        { label: '說明', key: 'message' },
        { label: '比對', render: (x) => (x.asset_id ? link(`#/quality/compare/${x.asset_id}`, '並排比對') : '—') },
        { label: '差異案件', render: (x) => (x.case_id ? link(`#/quality/cases/${x.case_id}`, '開啟案件') : '—') },
      ], rows, { empty: sev ? '此嚴重度沒有結果' : '本次檢核沒有發現問題' })));
}

// ── 差異案件 ──
async function casesPage(_, qy) {
  const orgId = needOrg();
  const f = { status: qy.status || '', severity: qy.severity || '', mine: qy.mine === '1' ? '1' : '', all: qy.all === '1' ? '1' : '' };
  const cases = await get('discrepancy-cases', { orgId, ...f });
  const statusOpts = [['', '未結案（全部）'], ...Object.entries(state.meta?.caseStatus || {})];
  const bar = h('div', { class: 'pf-bar' },
    select(statusOpts, f.status, (v) => setQuery({ status: v }), { 'aria-label': '狀態' }),
    select([['', '全部嚴重度'], ...SEVERITIES], f.severity, (v) => setQuery({ severity: v }), { 'aria-label': '嚴重度' }),
    h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: f.mine === '1', onchange: (e) => setQuery({ mine: e.target.checked ? '1' : '' }) }), ' 只看指派給我的'),
    f.status ? null : h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: f.all === '1', onchange: (e) => setQuery({ all: e.target.checked ? '1' : '' }) }), ' 含已結案'));
  const report = can('case.write') ? action('＋人工提報差異', () => reportCaseModal(orgId), 'primary') : null;
  return page('差異案件', { crumbs: [CRUMB, '差異案件'], actions: [report], intro: '系統檢核發現或人工提報的資料差異。差異不會自動覆寫原始值，須提出採用方案並經審核。' },
    card(null, bar, table([
      { label: '嚴重度', render: (c) => sevChip(c.severity) },
      { label: '摘要', render: (c) => link(`#/quality/cases/${c.id}`, c.summary) },
      { label: '面向', render: (c) => (c.domain ? domainChip(c.domain) : '—') },
      { label: '標的', render: (c) => (c.asset_id ? link(`#/assets/${c.asset_id}`, c.asset_name || c.asset_id) : '—') },
      { label: '指標', render: (c) => (c.metric_code ? metricName(c.metric_code) : '—') },
      { label: '期間', render: (c) => fmtPeriod(c.period_start, c.period_end) },
      { label: '差異', num: true, render: (c) => (c.rel_diff !== null && c.rel_diff !== undefined ? `${fmtNum(c.rel_diff)}%` : c.abs_diff !== null && c.abs_diff !== undefined ? fmtNum(c.abs_diff) : '—') },
      { label: '狀態', render: (c) => caseStatusChip(c.status) },
      { label: '處理人', render: (c) => c.owner_name || chip('未指派', 'todo') },
      { label: '期限', render: (c) => (c.overdueDays ? chip(`${fmtDate(c.due_date)}・逾期 ${c.overdueDays} 天`, 'alert') : fmtDate(c.due_date)) },
    ], cases, { empty: '沒有符合條件的差異案件', onRow: (c) => go(`#/quality/cases/${c.id}`) })));
}

async function reportCaseModal(orgId) {
  const assets = await get('assets', { orgId, limit: 1000 });
  const fields = [
    { key: 'summary', label: '差異描述', type: 'textarea', required: true, wide: true, placeholder: '例：11 月台電帳單用電量與 EMS 主表相差約 15%' },
    { key: 'assetId', label: '標的', type: 'select', options: assets.map((a) => [a.id, a.name]) },
    { key: 'metricCode', label: '指標', type: 'select', options: metricOptions() },
    { key: 'periodStart', label: '期間起日', type: 'date' },
    { key: 'periodEndIncl', label: '期間迄日（含當日）', type: 'date' },
    { key: 'severity', label: '嚴重度', type: 'select', required: true, options: SEVERITIES, default: 'medium' },
  ];
  await formModal('人工提報差異', fields, {}, async (v) => {
    const r = await post('discrepancy-cases', { orgId, summary: v.summary, assetId: v.assetId, metricCode: v.metricCode, severity: v.severity,
      periodStart: v.periodStart, periodEnd: v.periodEndIncl ? inclEndToExcl(v.periodEndIncl) : undefined });
    toast(r.duplicate ? '已有相同的未結案件' : '已提報'); go(`#/quality/cases/${r.id}`);
  }, '提報');
}

const EVENT_LABEL = { open: '開案', assign: '指派', investigate: '調查中', request_evidence: '要求補件', note: '補充說明', close: '結案', reopen: '重新開啟',
  decision_proposed: '提出採用方案', decision_in_review: '審核中', decision_closed: '採用值核准結案', decision_investigating: '採用方案退回', decision_awaiting_evidence: '退回補件' };

async function casePage({ id }) {
  const c = await get(`discrepancy-cases/${id}`);
  const org = c.org_id; const closed = c.status === 'closed';
  const users = await userOptions(org).catch(() => []);
  const userName = (uid) => users.find(([u]) => u === uid)?.[1] || uid;
  const actions = [];
  if (!closed && can('case.assign', org)) actions.push(action('指派', () => formModal('指派差異案件', [
    { key: 'owner', label: '處理人', type: 'select', required: true, options: users },
    { key: 'dueDate', label: '期限', type: 'date' },
    { key: 'severity', label: '嚴重度', type: 'select', options: SEVERITIES },
  ], { owner: c.owner, dueDate: c.due_date, severity: c.severity }, async (v) => { await post(`discrepancy-cases/${id}/assign`, v); toast('已指派'); render(); }, '指派')));
  if (!closed && can('case.write', org)) {
    actions.push(action('更新進度', () => formModal('更新調查進度', [
      { key: 'status', label: '狀態', type: 'select', required: true, options: [['investigating', '調查中'], ['awaiting_evidence', '待補件（向保管者要求補件）']] },
      { key: 'note', label: '說明', type: 'textarea', wide: true },
      { key: 'requestFrom', label: '向誰要求補件', type: 'select', options: users, hint: '選「待補件」時會建立補件待辦給此人' },
      { key: 'requestDue', label: '補件期限', type: 'date' },
    ], { status: 'investigating' }, async (v) => {
      if (v.status === 'awaiting_evidence' && !v.requestFrom) throw new Error('要求補件請選擇補件對象');
      await post(`discrepancy-cases/${id}/progress`, v); toast('已更新'); render();
    })));
    actions.push(action('補充說明', () => formModal('補充說明', [{ key: 'note', label: '說明', type: 'textarea', required: true, wide: true }], {},
      async (v) => { await post(`discrepancy-cases/${id}/note`, v); toast('已記錄'); render(); }, '記錄')));
  }
  if (!closed && can('decision.propose', org)) actions.push(action('提出採用方案', () => proposeModal(c), 'primary'));
  if (!closed && can('decision.review', org)) actions.push(action('不需調整，結案', () => formModal('結案', [
    { key: 'resolution', label: '決議與理由', type: 'textarea', required: true, wide: true, hint: '例：差異經確認為計量邊界不同，不需調整採用值' },
  ], {}, async (v) => { await post(`discrepancy-cases/${id}/close`, v); toast('已結案'); render(); }, '結案')));
  if (closed && can('case.assign', org)) actions.push(action('重新開啟', () => formModal('重新開啟案件', [{ key: 'reason', label: '重開原因', type: 'textarea', required: true, wide: true }], {},
    async (v) => { await post(`discrepancy-cases/${id}/reopen`, v); toast('已重新開啟'); render(); }, '重新開啟')));

  const obsTable = table([
    { label: '來源', render: (o) => h('span', o.source_name, o.source_type ? h('span', { class: 'muted pf-small' }, `（${o.source_type}）`) : null) },
    { label: '指標', render: (o) => o.metric_name || metricName(o.metric_code) },
    { label: '期間', render: (o) => fmtPeriod(o.period_start, o.period_end) },
    { label: '原始值', num: true, render: (o) => (o.raw_value === null || o.raw_value === undefined ? '—' : `${o.raw_value} ${o.raw_unit || ''}`) },
    { label: '標準值', num: true, render: (o) => valueText(o.value_std, o.std_unit) },
    { label: '值狀態', render: (o) => valueStateChip(o.value_state) },
    { label: '品質', render: (o) => qualityChip(o.quality_status) },
    { label: '方式', key: 'method' },
    { label: '邊界說明', key: 'boundary_note' },
  ], c.observations, { empty: '此案件未關聯觀測值' });

  const timeline = c.events.length ? h('ul', { class: 'pf-timeline' }, c.events.map((e) => h('li',
    h('time', `${fmtTime(e.at)}・${e.actor_name || (e.actor === 'system' ? '系統' : e.actor || '—')}`),
    h('b', EVENT_LABEL[e.action] || e.action),
    e.data?.owner ? ` → ${userName(e.data.owner)}` : null, e.data?.requestFrom ? `（補件對象：${userName(e.data.requestFrom)}）` : null,
    e.note ? h('div', e.note) : null))) : h('p', { class: 'muted' }, '沒有事件');

  const decisions = table([
    { label: '提出時間', render: (x) => fmtTime(x.proposed_at) },
    { label: '提出者', key: 'proposed_by_name' },
    { label: '類型', render: (x) => DECISION_TYPE[x.decision_type] || x.decision_type },
    { label: '期間', render: (x) => fmtPeriod(x.period_start, x.period_end) },
    { label: '值', num: true, render: (x) => (x.value === null || x.value === undefined ? valueStateChip(x.value_state) : valueText(x.value, x.unit)) },
    { label: '影響', render: (x) => (x.impact === 'high' ? chip('高影響', 'alert') : chip('一般')) },
    { label: '狀態', render: (x) => decisionStatusChip(x.status) },
    { label: '理由', key: 'reason' },
    { label: '審核意見', key: 'review_note' },
  ], c.decisions, { empty: '尚未提出採用方案' });

  const impact = c.impact.length ? h('ul', c.impact.map((r) => h('li', link(`#/reports/${r.id}`, r.name), ' ', chip(RUN_STATUS[r.status] || r.status, r.status === 'locked' ? 'alert' : 'info')))) :
    h('p', { class: 'muted' }, '目前沒有報告引用此標的的採用值。');

  return page(c.summary, { crumbs: [CRUMB, ['#/quality/cases', '差異案件'], '案件詳細'], actions },
    closed ? note(`已結案：${c.resolution || '—'}`, '') : null,
    c.impact.some((r) => r.status === 'locked') ? note('已封存的報告引用了此標的的採用值；若結果需要變更，須開新版本資料集並重新產製報告。', 'warn') : null,
    card('案件摘要', dl([
      ['狀態', caseStatusChip(c.status)], ['嚴重度', sevChip(c.severity)], ['類型', ({ manual: '人工提報', cross_source: '跨來源差異', balance: '油槽平衡' })[c.kind] || c.kind],
      ['規則', c.rule_code ? h('span', { class: 'pf-mono' }, c.rule_code) : '—'],
      ['標的', c.asset_id ? h('span', link(`#/assets/${c.asset_id}`, '標的詳細'), '　', link(`#/quality/compare/${c.asset_id}${c.metric_code ? `?metric=${encodeURIComponent(c.metric_code)}` : ''}`, '並排比對來源')) : '—'],
      ['指標', c.metric_code ? metricName(c.metric_code) : '—'], ['期間', c.period_end ? fmtPeriod(c.period_start, c.period_end) : (c.period_start ? fmtPeriod(c.period_start, inclEndToExcl(exclToIncl(c.period_start, null) || c.period_start)) : '—')],
      ['絕對差', c.abs_diff === null || c.abs_diff === undefined ? '—' : fmtNum(c.abs_diff)], ['相對差', c.rel_diff === null || c.rel_diff === undefined ? '—' : `${fmtNum(c.rel_diff)}%`],
      ['處理人', c.owner ? userName(c.owner) : chip('未指派', 'todo')], ['期限', fmtDate(c.due_date)], ['開案', `${fmtTime(c.opened_at)}・${c.opened_by === 'system' ? '系統' : userName(c.opened_by)}`],
    ])),
    card('相關數值（各來源觀測）', obsTable),
    h('div', { class: 'pf-cols' }, card('處理歷程', timeline), card('影響範圍（已引用的報告）', impact)),
    card('採用方案', decisions));
}

// 提出採用方案（裁決）：需要資料集；可選草稿資料集或新建一個
async function proposeModal(c) {
  const org = c.org_id;
  const year = c.period_start ? Number(c.period_start.slice(0, 4)) : state.year;
  const [datasets, evidence] = await Promise.all([get('datasets', { orgId: org }), c.asset_id ? get('evidence', { orgId: org, assetId: c.asset_id }).catch(() => []) : []]);
  const drafts = datasets.filter((d) => d.status === 'draft');
  const dsOpts = [...drafts.map((d) => [d.id, `${d.year} ${d.name} v${d.version}`]), ...(can('dataset.write', org) ? [['__new', `＋建立 ${year} 年度新資料集`]] : [])];
  if (!dsOpts.length) throw new Error('沒有草稿資料集，且你沒有建立資料集的權限，請洽報告承辦');
  if (!c.asset_id || !c.metric_code) throw new Error('此案件未指定標的或指標，無法提出採用值；請改由資料集頁逐筆裁決');
  const obsOpts = c.observations.map((o) => [o.id, `${o.source_name}｜${fmtPeriod(o.period_start, o.period_end)}｜${valueText(o.value_std, o.std_unit)}｜${({ valid: '通過', warning: '有警示', invalid: '未通過', pending_validation: '待檢核' })[o.quality_status] || o.quality_status}`]);
  const preDs = drafts.find((d) => d.year === year)?.id || dsOpts[0][0];
  const f = form([
    { key: 'datasetId', label: '資料集', type: 'select', required: true, options: dsOpts, wide: true },
    { key: 'decisionType', label: '採用方式', type: 'select', required: true, options: Object.entries(DECISION_TYPE) },
    { key: 'selectedObservationId', label: '採用哪一筆觀測', type: 'select', options: obsOpts, wide: true, hint: '期間與觀測不同時，會改用該筆觀測分攤到此期間的值' },
    { key: 'value', label: '衍生值', type: 'number', hint: `單位依指標標準單位（${c.observations[0]?.std_unit || ''}）` },
    { key: 'valueState', label: '衍生值性質', type: 'select', options: [['estimated', '估計'], ['measured', '實測換算']], default: 'estimated' },
    { key: 'method', label: '計算或估算方法', type: 'textarea', wide: true, placeholder: '可填文字，或 JSON，例：{"kind":"stock_balance","formula":"2000+500-2300"}' },
    { key: 'periodStart', label: '期間起日', type: 'date', required: true },
    { key: 'periodEndIncl', label: '期間迄日（含當日）', type: 'date', required: true, hint: '送出時轉成半開區間（迄日次日）' },
    { key: 'reason', label: '理由', type: 'textarea', required: true, wide: true, placeholder: '例：帳單為計費依據，EMS 為 A 棟主表，邊界較小' },
  ], { datasetId: preDs, decisionType: 'select_source', periodStart: c.period_start || '', periodEndIncl: exclToIncl(c.period_start, c.period_end) });
  const show = () => {
    const t = f.inputs.decisionType.value;
    const vis = { selectedObservationId: t === 'select_source', value: t === 'derived', valueState: t === 'derived', method: t === 'derived' };
    for (const [k, on] of Object.entries(vis)) f.inputs[k].closest('label').classList.toggle('pf-hidden', !on);
  };
  f.inputs.decisionType.addEventListener('change', show); show();
  const evBox = evidence.length ? h('fieldset', { class: 'pf-field wide' }, h('legend', '附上佐證（選填）'),
    evidence.map((e) => h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', value: e.id }), ` ${e.filename}${e.kind ? `（${e.kind}）` : ''}・${fmtDate(e.uploaded_at)}`))) : null;
  const body = h('div', note('採用方案不會覆寫原始觀測值；核准後才寫入資料集。高影響（衍生值、估計、差異大）需兩位審核者。'), f.el, evBox);
  await modal('提出採用方案', body, { okText: '送出審核', onOk: async () => {
    const v = f.read(); if (!v) return false;
    if (v.decisionType === 'select_source' && !v.selectedObservationId) throw new Error('請選擇要採用的觀測');
    if (v.decisionType === 'derived' && (v.value === undefined || !v.method)) throw new Error('衍生值需填數值與方法');
    if (v.periodEndIncl < v.periodStart) throw new Error('迄日不可早於起日');
    let datasetId = v.datasetId;
    if (datasetId === '__new') datasetId = (await post('datasets', { orgId: org, year })).id;
    let method = v.method;
    if (method) { try { method = JSON.parse(method); } catch { /* 純文字方法 */ } }
    const periodEnd = v.periodEndIncl === v.periodStart && c.period_end === c.period_start ? v.periodStart : inclEndToExcl(v.periodEndIncl);
    const evidenceIds = evBox ? [...evBox.querySelectorAll('input:checked')].map((i) => i.value) : [];
    const r = await post(`discrepancy-cases/${c.id}/decisions`, { datasetId, assetId: c.asset_id, metricCode: c.metric_code, decisionType: v.decisionType,
      selectedObservationId: v.decisionType === 'select_source' ? v.selectedObservationId : undefined,
      value: v.decisionType === 'derived' ? v.value : undefined, valueState: v.decisionType === 'derived' ? v.valueState : undefined,
      method: v.decisionType === 'derived' ? method : undefined, reason: v.reason, evidenceIds, periodStart: v.periodStart, periodEnd });
    toast(r.impact === 'high' ? '已送出（高影響，需兩位審核者）' : '已送出審核');
    render();
  } });
}

// ── 待審核採用值 ──
async function reviewPage() {
  const orgId = state.orgId || undefined;
  const list = await get('decisions/pending', { orgId });
  const me = myId();
  const why = (x) => (x.proposed_by === me ? '你是提出者，不能審核自己提出的採用值' : x.reviewer1 === me ? '你已完成第一位核准，需由另一位審核者覆核' : '');
  const rows = table([
    { label: '標的', render: (x) => h('span', x.domain ? [domainChip(x.domain), ' '] : null, link(`#/assets/${x.asset_id}`, x.asset_name)) },
    { label: '指標', render: (x) => x.metric_name || metricName(x.metric_code) },
    { label: '期間', render: (x) => fmtPeriod(x.period_start, x.period_end) },
    { label: '類型', render: (x) => DECISION_TYPE[x.decision_type] || x.decision_type },
    { label: '採用值', num: true, render: (x) => (x.value === null || x.value === undefined ? '—' : valueText(x.value, x.unit)) },
    { label: '值狀態', render: (x) => valueStateChip(x.value_state) },
    { label: '影響', render: (x) => (x.impact === 'high' ? h('span', chip('高影響・雙人覆核', 'alert'), x.status === 'first_approved' ? h('div', { class: 'pf-small muted' }, `一審：${x.reviewer1_name || '—'}`) : null) : chip('一般')) },
    { label: '提出者', render: (x) => h('span', x.proposed_by_name || '—', h('div', { class: 'pf-small muted' }, fmtTime(x.proposed_at))) },
    { label: '理由', key: 'reason' },
    { label: '方法', render: (x) => (jsonText(x.method) ? h('div', { class: 'pf-trace' }, jsonText(x.method)) : '—') },
    { label: '資料集／案件', render: (x) => h('span', link(`#/datasets/${x.dataset_id}`, x.dataset_name || '資料集'), x.case_id ? [' ', link(`#/quality/cases/${x.case_id}`, '案件')] : null) },
    { label: '審核', render: (x) => {
      const ok = can('decision.review', x.org_id) && x.canReview;
      const reason = !can('decision.review', x.org_id) ? '你沒有此院所的審核權限' : why(x);
      return h('div', { class: 'pf-actions' },
        action(x.impact === 'high' && x.status === 'proposed' ? '核准（第一位）' : '核准', async () => {
          const r = await post(`decisions/${x.id}/review`, { approve: true }); toast(r.status === 'first_approved' ? '已核准，待第二位覆核' : '已核准，寫入資料集'); render();
        }, 'primary', { disabled: !ok, title: reason || null }),
        action('退回', () => formModal('退回採用值', [{ key: 'note', label: '退回理由', type: 'textarea', required: true, wide: true }], {},
          async (v) => { await post(`decisions/${x.id}/review`, { approve: false, note: v.note }); toast('已退回'); render(); }, '退回'), 'danger-btn', { disabled: !ok, title: reason || null }),
        reason ? h('div', { class: 'pf-small muted' }, reason) : null);
    } },
  ], list, { empty: '目前沒有待審核的採用值' });
  return page('待審核採用值', { crumbs: [CRUMB, '待審核採用值'], intro: '一般採用值由一位審核者核准；高影響（衍生值、估計值、跨來源差異大、數值很大）需兩位不同審核者，且都不可以是提出者。' },
    can('decision.review') ? null : note('你沒有「審核採用值」權限，只能檢視。', 'warn'), card(null, rows));
}

// ── 多來源並排比對（PRD §8.2）──
async function comparePage({ assetId }, qy) {
  const detail = await get(`assets/${assetId}`, { year: state.year });
  const a = detail.asset;
  const metricCodes = [...new Set([...(detail.item?.metrics || []), ...(itemOf(a.item_id)?.metrics || [])].map((m) => (typeof m === 'string' ? m : m.code || m.metric)).filter(Boolean))];
  const metric = qy.metric || metricCodes[0];
  const metricOpts = (metricCodes.length ? metricCodes : (state.meta?.metrics || []).filter((m) => m.domain === a.domain).map((m) => m.code)).map((m) => [m, metricName(m)]);
  if (metric && !metricOpts.some(([m]) => m === metric)) metricOpts.unshift([metric, metricName(metric)]);
  const bar = h('div', { class: 'pf-bar' }, h('span', '指標'), select(metricOpts, metric, (v) => setQuery({ metric: v }), { 'aria-label': '指標' }),
    h('span', { class: 'muted pf-small' }, `期間：${state.year} 年（上方年度選單）`));
  if (!metric) return page(`來源比對：${a.name}`, { crumbs: [CRUMB, ['#/assets/' + a.id, a.name], '來源比對'] }, card(null, note('此標的沒有可比對的指標')));
  const [cmp, evidence] = await Promise.all([
    get(`assets/${assetId}/comparison`, { metric, from: `${state.year}-01-01`, to: `${state.year + 1}-01-01` }),
    get('evidence', { orgId: a.org_id, assetId }).catch(() => []),
  ]);
  const left = card('各來源原始值',
    table([
      { label: '來源', render: (r) => h('span', r.source, r.priority !== null && r.priority !== undefined ? h('span', { class: 'muted pf-small' }, `（優先序 ${r.priority}）`) : null) },
      { label: '指標', key: 'metric' },
      { label: '期間', render: (r) => h('span', fmtPeriod(r.periodStart, r.periodEnd), r.calendarMonth ? null : h('div', chip('非自然月', 'warn'))) },
      { label: '原始值', num: true, render: (r) => (r.raw === null || r.raw === undefined ? '—' : `${r.raw} ${r.rawUnit || ''}`) },
      { label: '標準值', num: true, render: (r) => (r.std === null || r.std === undefined ? valueStateChip(r.valueState) : valueText(r.std, r.stdUnit)) },
      { label: '計量邊界', render: (r) => r.boundaryNote || '—' },
      { label: '佐證', num: true, render: (r) => (r.evidence ? chip(`${r.evidence} 件`, 'ok') : chip('無', 'warn')) },
      { label: '品質', render: (r) => qualityChip(r.quality) },
    ], cmp.rows, { empty: '此期間沒有觀測值' }),
    h('h3', '自然月對齊比較'),
    alignedTable(cmp.aligned, cmp.metric?.std_unit));
  const right = card('佐證文件',
    evidence.length ? table([
      { label: '檔名', render: (e) => (e.canOpen ? h('a', { href: `/api/v1/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, e.filename) : h('span', e.filename, h('div', { class: 'pf-small muted' }, '無權開啟（機敏等級）'))) },
      { label: '類別', key: 'kind' },
      { label: '關聯觀測', num: true, render: (e) => fmtNum(e.obs_count) },
      { label: '上傳', render: (e) => h('span', fmtDate(e.uploaded_at), h('div', { class: 'pf-small muted' }, e.uploaded_by_name || '')) },
    ], evidence) : h('p', { class: 'muted' }, '此標的沒有佐證文件'));
  const openCases = (detail.cases || []).filter((c) => c.status !== 'closed' && (!c.metric_code || cmp.peers?.includes(c.metric_code)));
  return page(`來源比對：${a.name}`, { crumbs: [CRUMB, [`#/assets/${a.id}`, a.name], '來源比對'], actions: [btn('標的詳細', () => go(`#/assets/${a.id}`), 'ghost')] },
    card(null, bar, (cmp.notes || []).map((t) => note(t)),
      cmp.peers?.length > 1 ? h('p', { class: 'muted pf-small' }, `同語意一起比對的指標：${cmp.peers.map(metricName).join('、')}`) : null,
      openCases.length ? h('p', '未結差異案件：', openCases.map((c) => [link(`#/quality/cases/${c.id}`, c.summary), ' '])) : null),
    h('div', { class: 'pf-cols' }, left, right));
}

function alignedTable(aligned, unit) {
  if (!aligned?.length) return h('p', { class: 'muted' }, '沒有可對齊到自然月的值');
  const sources = [...new Set(aligned.flatMap((m) => m.values.map((v) => v.source)))];
  return table([
    { label: '月份', key: 'month', render: (m) => m.month.slice(0, 7) },
    ...sources.map((s) => ({ label: s, num: true, render: (m) => {
      const v = m.values.filter((x) => x.source === s);
      if (!v.length) return '—';
      return h('span', { title: v.map((x) => x.how).join('、') }, v.map((x) => fmtNum(x.value, 3)).join(' ＋ '), v.some((x) => x.how !== '原始期間即自然月') ? h('div', { class: 'pf-small muted' }, v[0].how) : null);
    } })),
    { label: `絕對差${unit ? `（${unit}）` : ''}`, num: true, render: (m) => (m.sources > 1 ? fmtNum(m.absDiff, 3) : '—') },
    { label: '相對差', num: true, render: (m) => (m.sources > 1 ? chip(`${fmtNum(m.relDiffPct)}%`, m.relDiffPct > 10 ? 'alert' : m.relDiffPct > 3 ? 'warn' : 'ok') : '—') },
  ], aligned);
}
