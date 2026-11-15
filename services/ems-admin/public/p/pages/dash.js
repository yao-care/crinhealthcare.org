// 統整資訊看板（PRD §9）：公開／管理／報告／設備能源四層。
// 數字一律由後端算好；公開層後端已去除費用、識別碼、聯絡人，這裡也不另外拼湊明細。
import { state, get, h, route, page, card, table, link, chip, domainChip, sevChip, kpiRow, bars, note, select, setQuery, fmtNum, fmtDate, fmtTime, progress, orgName } from '../core.js';

const D4 = ['oil', 'water', 'electricity', 'gas'];
const KPIS = [
  ['applicabilityRate', '適用性確認率'], ['sourceLocationRate', '來源定位率'], ['acquisitionRate', '資料取得率'],
  ['validationRate', '驗證通過率'], ['reviewRate', '審核完成率'], ['lockRate', '定版率'],
];
const REPORT_STATUS = { draft: ['草稿', 'todo'], preparing: ['準備中', 'info'], in_review: ['審查中', 'info'], approved: ['已核准', 'ok'], locked: ['已封存', 'ok'], exported: ['已匯出', 'ok'], submitted_manual: ['已人工送件', 'ok'] };
const TREND_DOMAINS = ['electricity', 'water', 'oil', 'gas'];

export function register() {
  route('/dash/public', publicDash, { title: '全院公開進度' });
  route('/dash/management', managementDash, { title: '院區與單位進度' });
  route('/dash/report', reportDash, { title: '報告準備' });
  route('/dash/energy', energyDash, { title: '油水電氣趨勢' });
}

// ── 共用 ──
// 範圍：預設＝上方選的院所（含所屬分院）；scope=all＝我可見的全部院所
function scopeOf(qy) { return qy.scope === 'all' ? null : state.orgId; }
function scopeBar(qy) {
  return h('div', { class: 'pf-bar' },
    h('span', { class: 'muted' }, '範圍'),
    select([['', `${state.orgId ? orgName(state.orgId) : '目前院所'}（含所屬分院）`], ['all', '我可見的全部院所']], qy.scope === 'all' ? 'all' : '', (v) => setQuery({ scope: v }), { 'aria-label': '看板範圍', style: 'width:auto' }),
    h('span', { class: 'muted' }, `年度 ${state.year}（民國 ${state.year - 1911}）；年度請在上方切換`));
}
const fetchBoard = (level, qy) => get('dashboards/progress', { level, orgId: scopeOf(qy) || undefined, year: state.year });

function kpiBlock(x, defs) {
  return h('div', KPIS.map(([k, label]) => kpiRow(label, x?.[k] ?? null, defs?.[k])));
}
function defsNote(defs) {
  if (!defs) return null;
  return h('details', h('summary', '指標定義（每一項分開計算，不合併成單一「完成率」）'),
    h('ul', Object.entries(defs).map(([, v]) => h('li', { class: 'pf-small' }, v))));
}
const tile = (n, label, kind = '', href) => h(href ? 'a' : 'div', { class: `pf-tile ${kind}`, href }, h('b', n === null || n === undefined ? '—' : fmtNum(n, 1)), h('span', label));
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const rateCols = KPIS.map(([k, label]) => ({ label, num: true, render: (r) => pct(r[k]) }));

function domainCards(byDomain, defs, withCounts) {
  return h('div', { class: 'pf-grid' }, D4.map((d) => {
    const x = byDomain?.[d] || {};
    return h('section', { class: 'pf-card' }, h('h2', domainChip(d)),
      h('p', { class: 'muted pf-small' }, `標的 ${fmtNum(x.assets ?? 0, 0)}，適用 ${fmtNum(x.applicable ?? 0, 0)}${withCounts ? `；資料需求 ${fmtNum(x.requirements ?? 0, 0)}，已取得 ${fmtNum(x.acquired ?? 0, 0)}` : ''}`),
      kpiBlock(x, defs));
  }));
}

// ── 公開進度 ──
async function publicDash(_, qy) {
  const b = await fetchBoard('public', qy);
  const t = b.total || {};
  return page('全院公開進度', { intro: '院內同仁都看得到的盤點進度與成果摘要；不含費用、電號、聯絡人與原始文件。' },
    scopeBar(qy),
    h('div', { class: 'pf-tiles' },
      tile(t.assets, '盤點標的'), tile(t.applicable, '適用標的'),
      tile(b.discrepancies?.open, '未結差異案件', b.discrepancies?.open ? 'warn' : ''),
      tile(b.discrepancies?.overdue, '逾期差異案件', b.discrepancies?.overdue ? 'alert' : ''),
      tile(b.usage?.reports, '已引用成果的報告')),
    card('整體進度', kpiBlock(t, b.definitions), defsNote(b.definitions)),
    h('h2', '油、水、電、氣'),
    domainCards(b.byDomain, b.definitions, false),
    card('各院所進度', table([
      { label: '院所', key: 'org' },
      { label: '標的', key: 'assets', num: true }, { label: '適用', key: 'applicable', num: true },
      ...rateCols,
    ], b.sites || [], { empty: '目前範圍內沒有院所資料' })));
}

// ── 管理看板 ──
async function managementDash(_, qy) {
  const b = await fetchBoard('management', qy);
  const t = b.total || {};
  const bl = b.blockers || {};
  const sev = b.discrepancies?.bySeverity || {};
  return page('院區與單位進度', { intro: '依授權顯示各院所 KPI、待處理阻塞、差異處理績效與費用彙總。' },
    scopeBar(qy),
    h('div', { class: 'pf-tiles' },
      tile(t.assets, '盤點標的'), tile(t.applicable, '適用標的'), tile(t.requirements, '資料需求'), tile(t.acquired, '已取得資料需求'),
      tile(b.discrepancies?.open, '未結差異案件', b.discrepancies?.open ? 'warn' : '', '#/quality/cases'),
      tile(b.discrepancies?.overdue, '逾期差異案件', b.discrepancies?.overdue ? 'alert' : ''),
      tile(b.usage?.reports, '已引用成果的報告'), tile(b.usage?.candidateOnly, '候選用途（尚未實際引用）')),
    card('整體進度', kpiBlock(t, b.definitions), defsNote(b.definitions)),
    h('h2', '油、水、電、氣'),
    domainCards(b.byDomain, b.definitions, true),
    card('各院所進度', table([
      { label: '院所', key: 'org' },
      { label: '標的', key: 'assets', num: true }, { label: '適用', key: 'applicable', num: true },
      { label: '需求', key: 'requirements', num: true }, { label: '已取得', key: 'acquired', num: true },
      ...rateCols,
    ], b.sites || [], { empty: '目前範圍內沒有院所資料' })),
    h('h2', '優先處理'),
    h('div', { class: 'pf-cols' },
      card(`保管者未知的適用標的（${(bl.unknownOwner || []).length}）`, table([
        { label: '面向', render: (a) => domainChip(a.domain) },
        { label: '標的', render: (a) => link(`#/assets/${a.id}`, a.name) },
        { label: '院所', key: 'org_name' },
      ], bl.unknownOwner || [], { empty: '沒有保管者未知的標的' })),
      card(`逾期待辦（${(bl.overdueTasks || []).length}）`, table([
        { label: '待辦', key: 'title' }, { label: '負責人', key: 'assignee' }, { label: '截止日', render: (r) => fmtDate(r.due_date) },
      ], bl.overdueTasks || [], { empty: '沒有逾期待辦' }))),
    card(`高風險差異案件（${(bl.highCases || []).length}）`, table([
      { label: '嚴重度', render: (c) => sevChip(c.severity) },
      { label: '摘要', render: (c) => link(`#/quality/cases/${c.id}`, c.summary || '（未填摘要）') },
      { label: '標的', key: 'asset_name' }, { label: '截止日', render: (c) => fmtDate(c.due_date) },
    ], bl.highCases || [], { empty: '沒有未結的高／緊急差異案件' })),
    card('差異處理績效',
      h('div', { class: 'pf-tiles' },
        tile(b.casePerformance?.closed, `${state.year} 年已結案`), tile(b.casePerformance?.avgCloseDays, '平均結案天數'),
        ...['critical', 'high', 'medium', 'low'].map((s) => tile(sev[s] || 0, `未結·${{ critical: '緊急', high: '高', medium: '中', low: '低' }[s]}`, s === 'critical' || s === 'high' ? (sev[s] ? 'alert' : '') : ''))),
    ),
    b.costs === null || b.costs === undefined ? note('費用彙總需要「檢視敏感欄位」權限（範圍內每一家院所都要有），目前不顯示。')
      : card('費用彙總（已核准／定版採用值）', table([
        { label: '指標', key: 'name' }, { label: '代碼', key: 'code', cls: 'pf-mono' }, { label: '合計（元）', num: true, render: (r) => fmtNum(r.total, 0) },
      ], b.costs, { empty: '本年度還沒有已核准的費用採用值' })));
}

// ── 報告準備 ──
async function reportDash(_, qy) {
  const b = await fetchBoard('report', qy);
  const cases = b.cases || [];
  return page('報告準備', { intro: '每個報告案件的就緒率＝所需且已可引用的欄位 ÷ 依版本化模板決定的適用欄位。' },
    scopeBar(qy),
    cases.length ? h('div', { class: 'pf-grid' }, cases.map((c) => {
      const [sl, sk] = REPORT_STATUS[c.status] || [c.status, ''];
      return h('section', { class: 'pf-card' },
        h('h2', link(`#/reports/${c.id}`, c.name)),
        h('p', { class: 'muted pf-small' }, `${c.template_name}${c.standard_version ? `（${c.standard_version}）` : ''}・${c.year} 年・${orgName(c.org_id)}`),
        h('div', { class: 'pf-bar' }, chip(sl, sk), c.due_date ? chip(`截止 ${fmtDate(c.due_date)}`, c.due_date < new Date().toISOString().slice(0, 10) && !['approved', 'locked', 'exported', 'submitted_manual'].includes(c.status) ? 'alert' : '') : null),
        h('div', { class: 'pf-kpi', title: '報告就緒率' }, h('span', '就緒率'), progress(c.readinessRate), h('b', pct(c.readinessRate))),
        h('p', { class: 'pf-small muted' }, `已就緒 ${c.ready ?? 0}／${c.total ?? 0} 個必要欄位`),
        c.blockers?.length ? h('div', h('h3', '待解決'), h('ul', c.blockers.map((x) => h('li', { class: 'pf-small' }, x))))
          : c.total && c.ready === c.total ? note('必要欄位都已就緒') : c.total ? note('尚未指定資料集或欄位未就緒，請進報告案件查看', 'warn') : null);
    })) : card(null, h('div', { class: 'pf-empty' }, `${state.year} 年目前範圍內沒有報告案件`)));
}

// ── 設備與能源趨勢 ──
async function energyDash(_, qy) {
  const b = await fetchBoard('energy', qy);
  const months = Array.from({ length: 12 }, (_, i) => `${state.year}-${String(i + 1).padStart(2, '0')}`);
  const trendCards = TREND_DOMAINS.map((d) => {
    const metrics = Object.entries(b.trends?.[d] || {});
    return h('section', { class: 'pf-card' }, h('h2', domainChip(d)),
      metrics.map(([code, m]) => {
        const map = new Map((m.months || []).map((x) => [x.month, x.value]));
        const total = (m.months || []).reduce((s, x) => s + (x.value || 0), 0);
        const name = state.meta?.metrics?.find((x) => x.code === code)?.name || code;
        return h('div',
          h('h3', name),
          h('div', { class: 'pf-bar' }, chip(m.layerLabel || m.layer, m.layer === 'approved' ? 'ok' : 'warn'),
            h('span', { class: 'pf-small muted' }, (m.months || []).length ? `合計 ${fmtNum(total)} ${m.unit || ''}` : '本年度沒有資料')),
          (m.months || []).length ? bars(months.map((mo) => ({ label: mo.slice(5), value: map.get(mo) ?? null })), { unit: m.unit || '' }) : null);
      }));
  });
  return page('油水電氣趨勢', { intro: '每月趨勢優先使用核准的採用值；尚未核准時改用通過檢核的觀測值（同標的同期間只取優先序最高的來源），並在圖上標示。' },
    scopeBar(qy),
    note('「已檢核觀測值」尚未經過審核，只供趨勢參考，不可直接引用於報告。'),
    h('div', { class: 'pf-cols' }, trendCards),
    card(`用量異常（最近一次檢核，${(b.anomalies || []).length} 筆）`, table([
      { label: '嚴重度', render: (a) => sevChip(a.severity) },
      { label: '標的', key: 'asset_name' },
      { label: '規則', render: (a) => ({ history_anomaly: '歷史波動', meter_balance: '總分表平衡', oil_balance: '油料存量平衡', cumulative_backward: '累積讀值倒退' }[a.rule_code] || a.rule_code) },
      { label: '說明', key: 'message' },
      { label: '檢核時間', render: (a) => fmtTime(a.started_at) },
    ], b.anomalies || [], { empty: '最近一次檢核沒有用量異常' })));
}
