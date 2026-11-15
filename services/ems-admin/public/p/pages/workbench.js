// 我的工作台（PRD §7.1）＋成果回饋中心（PRD §7.4、M12）
import { state, get, post, patch, h, route, page, card, table, link, chip, domainChip, workChip, ownerChip, applicChip, fmtPeriod, fmtTime, fmtDate,
  action, formModal, userOptions, toast, can, setQuery, searchBox, select, needOrg, render, note, btn, go } from '../core.js';

export function register() {
  route('/', workbench, { title: '我的工作台' });
  route('/feedback', feedback, { title: '我的盤點成果與引用' });
}

async function workbench(_, qy) {
  // 一般同仁沒有盤點資料權限：首頁改為全院公開進度
  if (!can('view.internal')) { history.replaceState(null, '', '#/dash/public'); render(); return h('div'); }
  const orgId = state.orgId;
  const [counts, tasks, searches, cases] = await Promise.all([
    get('workbench', { orgId }), get('tasks', { mine: '1' }), get('source-search-tasks', { mine: '1' }), get('discrepancy-cases', { mine: '1' }),
  ]);
  const tile = (n, label, href, kind = '') => h('a', { class: `pf-tile ${kind}`, href }, h('b', String(n ?? 0)), h('span', label));
  const tiles = h('div', { class: 'pf-tiles' },
    tile(counts.myTodo, '我的待辦', '#/?tab=todo'), tile(counts.doneThisPeriod, '本期已核准／定版標的', '#/assets?workStatus=approved'),
    tile(counts.findingSource, '待找來源', '#/assets?workStatus=finding_source', counts.findingSource ? 'warn' : ''),
    tile(counts.awaitingEvidence, '待補件', '#/quality/cases?status=awaiting_evidence', counts.awaitingEvidence ? 'warn' : ''),
    tile(counts.discrepancies, '差異案件', '#/quality/cases', counts.discrepancies ? 'alert' : ''),
    can('decision.review') ? tile(counts.pendingReview, '待審核採用值', '#/quality/review', counts.pendingReview ? 'warn' : '') : null,
    tile(counts.usedResults, '已被採用成果', '#/feedback'));

  // 主要表格：盤點標的（PRD §7.1 欄位）
  const filters = { domain: qy.domain || '', workStatus: qy.workStatus || '', q: qy.q || '' };
  const assets = orgId ? await get('assets', { orgId, ...filters, limit: 300 }) : [];
  const year = state.year;
  const assetTable = table([
    { label: '面向', render: (a) => domainChip(a.domain) },
    { label: '院區', render: (a) => a.site_name || '—' },
    { label: '盤點項目', render: (a) => a.item_name || '—' },
    { label: '標的名稱', render: (a) => link(`#/assets/${a.id}`, a.name) },
    { label: '期間', render: () => `${year} 年` },
    { label: '來源', render: (a) => (a.source_count ? chip(`${a.source_count} 個來源`, 'ok') : chip('未建來源', 'warn')) },
    { label: '驗證狀態', render: (a) => (a.open_cases ? chip(`差異 ${a.open_cases}`, 'alert') : a.obs_count ? chip(`${a.obs_count} 筆觀測`, 'info') : chip('無觀測', 'todo')) },
    { label: '資料保管者', render: (a) => (a.owner_name ? a.owner_name : ownerChip(a.owner_status)) },
    { label: '最後更新', render: (a) => fmtDate(a.last_obs_at || a.updated_at) },
    { label: '下一步', render: (a) => nextStep(a) },
    { label: '截止日', render: (a) => a.due_date || '—' },
  ], assets, { empty: orgId ? '這個院所還沒有盤點標的。可以從「標的台帳」新增，或在系統管理套用盤點模板。' : '請在上方選擇院所' });

  const domainOpts = [['', '全部面向'], ...['oil', 'water', 'electricity', 'gas', 'activity'].map((d) => [d, state.meta.domains[d].name])];
  const wsOpts = [['', '全部進度'], ...Object.entries(state.meta.workStatus)];
  const bar = h('div', { class: 'pf-bar' },
    select(domainOpts, filters.domain, (v) => setQuery({ domain: v }), { 'aria-label': '面向' }),
    select(wsOpts, filters.workStatus, (v) => setQuery({ workStatus: v }), { 'aria-label': '進度' }),
    searchBox(filters.q, (v) => setQuery({ q: v }), '搜尋設備、電號、水號、資料名稱'),
    h('div', { class: 'grow' }),
    can('asset.write') ? btn('＋新增標的', () => go('#/assets/new'), 'primary') : null,
    can('import.write') ? btn('📥 匯入', () => go('#/imports')) : null,
    can('obs.write') ? btn('📱 人工盤點', () => go('#/collect')) : null,
    can('task.write') && assets.length ? action('批次派工', () => batchAssign(assets)) : null);

  const todo = [
    ...tasks.map((t) => ({ kind: '待辦', title: t.title, due: t.due_date, href: t.target_type === 'case' ? `#/quality/cases/${t.target_id}` : '#/', id: t.id, task: true })),
    ...searches.map((s) => ({ kind: '來源追查', title: `${s.keyword}${s.asset_name ? `（${s.asset_name}）` : ''}`, due: s.due_date, href: `#/sources/search/${s.id}` })),
    ...cases.map((c) => ({ kind: '差異案件', title: c.summary, due: c.due_date, href: `#/quality/cases/${c.id}`, overdue: c.overdueDays })),
  ];
  const todoTable = table([
    { label: '類型', render: (t) => chip(t.kind, t.kind === '差異案件' ? 'alert' : 'info') },
    { label: '內容', render: (t) => link(t.href, t.title) },
    { label: '截止', render: (t) => (t.overdue ? chip(`逾期 ${t.overdue} 天`, 'alert') : t.due || '—') },
    { label: '', render: (t) => (t.task ? action('完成', async () => { await patch(`tasks/${t.id}`, { status: 'done' }); toast('已完成'); render(); }) : '') },
  ], todo, { empty: '目前沒有指派給你的工作' });

  return page('我的盤點工作台', { intro: `${state.me.orgs.find((o) => o.id === orgId)?.name || ''}｜${year} 年度` },
    tiles, card('我的待辦', todoTable), card('盤點標的', bar, assetTable,
      h('p', { class: 'muted pf-small' }, '「保管者未知」的標的照樣可以建檔與作業；到「資料來源與追查」用關鍵字找線索。')));
}

function nextStep(a) {
  if (a.applicability === 'undetermined') return link(`#/assets/${a.id}`, '判定適用性');
  if (a.applicability === 'not_applicable') return applicChip('not_applicable');
  if (!a.source_count) return link(`#/sources?assetId=${a.id}`, '尋找線索');
  if (!a.obs_count) return link(`#/collect/${a.id}`, '登錄數據');
  if (a.open_cases) return link(`#/quality/cases?assetId=${a.id}`, '處理差異');
  if (['to_review', 'collecting', 'to_validate'].includes(a.work_status)) return link('#/quality/runs', '執行檢核');
  if (a.work_status === 'returned') return link(`#/assets/${a.id}`, '補件');
  return workChip(a.work_status);
}

async function batchAssign(assets) {
  const orgId = needOrg();
  const opts = await userOptions(orgId);
  await formModal('批次派工', [
    { key: 'assignee', label: '指派給', type: 'select', options: opts, required: true },
    { key: 'domain', label: '只派這個面向', type: 'select', options: ['oil', 'water', 'electricity', 'gas'].map((d) => [d, state.meta.domains[d].name]) },
    { key: 'workStatus', label: '只派這個進度', type: 'select', options: Object.entries(state.meta.workStatus) },
    { key: 'title', label: '工作內容', required: true, default: '補齊本期資料', wide: true },
    { key: 'dueDate', label: '截止日', type: 'date' },
  ], {}, async (v) => {
    const pick = assets.filter((a) => (!v.domain || a.domain === v.domain) && (!v.workStatus || a.work_status === v.workStatus));
    if (!pick.length) throw new Error('沒有符合條件的標的');
    await post('tasks/batch', { items: pick.map((a) => ({ orgId, kind: 'asset_work', targetType: 'asset', targetId: a.id, title: `${v.title}：${a.name}`, assignee: v.assignee, dueDate: v.dueDate, link: `#/assets/${a.id}` })) });
    toast(`已派工 ${pick.length} 項`);
  }, '派工');
}

async function feedback(_, qy) {
  const mine = qy.scope !== 'org';
  const rows = await get('usage-links', mine ? { mine: '1' } : { orgId: state.orgId });
  const STATUS = state.meta.usageStatus;
  return page('盤點成果與引用', { intro: '你提供或維護的資料，實際被哪些報告與管理工作採用。候選用途不算在這裡，只列實際引用。' },
    h('nav', { class: 'pf-tabs' }, h('a', { href: '#/feedback', class: mine ? 'on' : '' }, '我提供的資料'), h('a', { href: '#/feedback?scope=org', class: mine ? '' : 'on' }, '本院全部')),
    h('div', { class: 'pf-tiles' }, h('div', { class: 'pf-tile' }, h('b', String(rows.length)), h('span', '項成果')),
      h('div', { class: 'pf-tile' }, h('b', String(rows.reduce((s, r) => s + r.facts, 0))), h('span', '筆採用值被引用'))),
    table([
      { label: '成果', render: (r) => (r.report_case_id ? link(`#/reports/${r.report_case_id}`, r.usage_name) : r.usage_name) },
      { label: '模板', render: (r) => r.template_name || '—' },
      { label: '年度', key: 'year' },
      { label: '狀態', render: (r) => chip(STATUS[r.status] || r.status, r.status === 'published' ? 'ok' : 'info') },
      { label: '引用指標', render: (r) => r.indicators.join('、') || '（佐證清單／品質摘要）' },
      { label: '涉及標的', render: (r) => r.assets.slice(0, 5).join('、') + (r.assets.length > 5 ? ` 等 ${r.assets.length} 項` : '') },
      { label: '引用時間', render: (r) => fmtTime(r.used_at) },
    ], rows, { empty: '目前還沒有成果引用你的資料。資料經審核、定版後被報告引用，就會出現在這裡。' }));
}
