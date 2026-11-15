// 資料集與定版（PRD §6.4、§10.4）＋排放量與營運指標試算（PRD §13）
import { state, get, post, h, route, page, card, table, link, chip, domainChip, valueStateChip, qualityChip, fmtNum, fmtPeriod, fmtTime, fmtDate,
  action, btn, modal, formModal, form, toast, can, setQuery, select, needOrg, render, note, dl, go, tabs, metricName, itemOf, inclEndToExcl } from '../core.js';

export function register() {
  route('/datasets', listPage, { title: '資料集與定版' });
  route('/datasets/:id', detailPage, { title: '資料集' });
  route('/indicators', indicatorsPage, { title: '排放量與營運指標' });
}

const DS_STATUS = { draft: ['草稿', 'todo'], in_review: ['待核准', 'info'], approved: ['已核准', 'ok'], locked: ['已定版', 'ok'], superseded: ['已被新版取代', ''] };
const dsChip = (s) => chip(...(DS_STATUS[s] || [s, '']));
const isLocked = (d) => ['locked', 'superseded'].includes(d.status);
const DECISION_TYPE = { select_source: '採用某一來源', derived: '衍生值（計算／估算）', not_applicable: '明示不適用', missing: '明示缺漏', reject: '退回補件' };
const DECISION_STATUS = { proposed: ['待審核', 'todo'], first_approved: ['已一審，待覆核', 'info'], approved: ['已核准', 'ok'], rejected: ['已駁回', 'alert'], returned: ['已退回', 'alert'], withdrawn: ['已撤回', ''] };
const decisionStatusChip = (s) => chip(...(DECISION_STATUS[s] || [s, '']));
const valueText = (v, unit) => (v === null || v === undefined ? '—' : `${fmtNum(v, 4)}${unit ? ` ${unit}` : ''}`);
// 數值欄：null 一律顯示狀態，不當 0
const valueCell = (v, unit, st, masked) => (masked ? chip('需敏感欄位權限') : v === null || v === undefined ? valueStateChip(st || 'missing') : valueText(v, unit));
const myId = () => state.me?.user?.id;
const CRUMB = ['#/datasets', '資料集與定版'];

// ── 清單 ──
async function listPage() {
  const orgId = needOrg();
  const list = await get('datasets', { orgId });
  const create = can('dataset.write') ? action('＋建立資料集', () => formModal('建立資料集', [
    { key: 'year', label: '年度', type: 'number', required: true },
    { key: 'name', label: '名稱', placeholder: `${state.year} 年度共用資料集`, wide: true },
    { key: 'purpose', label: '用途說明', type: 'textarea', wide: true, placeholder: '例：盤查登錄、ESG 報告書、醫院評鑑共用' },
  ], { year: state.year }, async (v) => { const r = await post('datasets', { orgId, ...v }); toast(`已建立 v${r.version}`); go(`#/datasets/${r.id}`); }, '建立'), 'primary') : null;
  return page('資料集與定版', { crumbs: [CRUMB], actions: [create], intro: '資料集收錄經審核的採用值，定版後產生雜湊、不可修改；所有報告都引用定版資料集，要修正就開新版本。' },
    card(null, table([
      { label: '名稱', render: (d) => link(`#/datasets/${d.id}`, d.name) },
      { label: '年度', render: (d) => (d.year === state.year ? chip(String(d.year), 'info') : String(d.year)) },
      { label: '版本', render: (d) => `v${d.version}` },
      { label: '狀態', render: (d) => dsChip(d.status) },
      { label: '採用值', num: true, render: (d) => fmtNum(d.fact_count) },
      { label: '待審核裁決', num: true, render: (d) => (d.pending_decisions ? chip(String(d.pending_decisions), 'warn') : '0') },
      { label: '更新', render: (d) => fmtTime(d.updated_at) },
      { label: '雜湊', render: (d) => (d.hash ? h('span', { class: 'pf-mono', title: d.hash }, d.hash.slice(0, 12)) : '—') },
    ], list, { empty: '這個院所還沒有資料集', onRow: (d) => go(`#/datasets/${d.id}`) })));
}

// ── 詳細 ──
async function detailPage({ id }, qy) {
  const d = await get(`datasets/${id}`);
  const org = d.org_id; const locked = isLocked(d);
  const tab = qy.tab || 'facts';
  const actions = [];
  if (d.status === 'draft' && can('dataset.write', org)) actions.push(action('送審', async () => { await post(`datasets/${id}/submit`); toast('已送審'); render(); }, 'primary'));
  if (d.status === 'in_review' && can('dataset.approve', org)) {
    actions.push(action('核准', async () => { await post(`datasets/${id}/approve`, { approve: true }); toast('已核准'); render(); }, 'primary'));
    actions.push(action('退回', () => formModal('退回資料集', [{ key: 'note', label: '退回理由', type: 'textarea', required: true, wide: true }], {},
      async (v) => { await post(`datasets/${id}/approve`, { approve: false, note: v.note }); toast('已退回草稿'); render(); }, '退回'), 'danger-btn'));
  }
  if (d.status === 'approved' && can('dataset.lock', org)) actions.push(action('定版', async () => {
    const ok = await modal('資料定版', h('div', h('p', '定版後資料集與採用值都不能再修改，會計算雜湊以供日後驗證。'), h('p', '要修正只能開新版本；已引用此版本的報告不受影響。')), { okText: '確認定版' });
    if (!ok) return;
    const r = await post(`datasets/${id}/lock`); toast(`已定版，雜湊 ${r.hash.slice(0, 12)}…`); render();
  }, 'primary'));
  if (d.status === 'locked' && can('dataset.write', org)) actions.push(action('開新版本', () => formModal('開新版本', [{ key: 'reason', label: '原因', type: 'textarea', required: true, wide: true, hint: '例：10 月帳單更正，需修正外購電力' }], {},
    async (v) => { const r = await post(`datasets/${id}/new-version`, v); toast(`已建立 v${r.version}`); go(`#/datasets/${r.id}`); }, '建立新版本')));
  if (locked) actions.push(action('驗證雜湊', async () => {
    const r = await get(`datasets/${id}/verify`);
    await modal('定版雜湊驗證', r.locked ? h('div', note(r.ok ? '✅ 一致：資料集內容與定版時相同' : '❌ 不一致：資料集內容與定版時不同，請立即通知系統管理員', r.ok ? '' : 'alert'),
      dl([['定版時', h('span', { class: 'pf-mono' }, r.stored)], ['目前計算', h('span', { class: 'pf-mono' }, r.computed)]])) : h('p', '此資料集尚未定版'), { okText: null, cancelText: '關閉' });
  }));
  actions.push(btn('看指標試算', () => go(`#/indicators?ds=${id}`), 'ghost'));

  const base = `#/datasets/${id}`;
  const tabItems = [[`${base}?tab=facts`, `採用值（${d.facts.length}）`], [`${base}?tab=decisions`, `裁決（${d.decisions.length}）`], ...(locked ? [] : [[`${base}?tab=adjudicate`, '逐筆裁決']])];
  let body;
  if (tab === 'decisions') body = decisionsTable(d);
  else if (tab === 'adjudicate' && !locked) body = await adjudicatePanel(d, qy);
  else body = factsTable(d);
  const pending = d.decisions.filter((x) => ['proposed', 'first_approved'].includes(x.status)).length;
  return page(`${d.name} v${d.version}`, { crumbs: [CRUMB, `${d.year}・v${d.version}`], actions },
    locked ? note(d.status === 'superseded' ? '已定版，不可修改（此版本已被新版本取代，保留供已引用的報告追溯）。' : '已定版，不可修改。要修正請「開新版本」。', 'warn') : null,
    card(null, dl([['狀態', dsChip(d.status)], ['年度', String(d.year)], ['版本', `v${d.version}`], ['用途', d.purpose || '—'],
      ['待審核裁決', pending ? chip(`${pending} 筆`, 'warn') : '0'], ['核准', d.approved_at ? fmtTime(d.approved_at) : '—'], ['定版', d.locked_at ? fmtTime(d.locked_at) : '—'],
      ['雜湊', d.hash ? h('span', { class: 'pf-mono' }, d.hash) : '—'], d.parent_dataset_id ? ['前一版本', link(`#/datasets/${d.parent_dataset_id}`, '開啟')] : null])),
    tabs(tabItems, `${base}?tab=${tab === 'adjudicate' && locked ? 'facts' : tab}`),
    body);
}

function factsTable(d) {
  return card(null, table([
    { label: '面向', render: (f) => (f.domain ? domainChip(f.domain) : '—') },
    { label: '標的', render: (f) => link(`#/assets/${f.asset_id}`, f.asset_name) },
    { label: '指標', render: (f) => f.metric_name || metricName(f.metric_code) },
    { label: '期間', render: (f) => fmtPeriod(f.period_start, f.period_end) },
    { label: '採用值', num: true, render: (f) => valueCell(f.value, null, f.value_state, f.masked) },
    { label: '單位', key: 'unit' },
    { label: '值狀態', render: (f) => valueStateChip(f.value_state) },
    { label: '版次', render: (f) => `v${f.version}` },
    { label: '核准', render: (f) => h('span', f.approved_by_name || '—', h('div', { class: 'pf-small muted' }, fmtDate(f.approved_at))) },
  ], d.facts, { empty: '還沒有核准的採用值。可在「逐筆裁決」提出，或用「批次帶出」。' }));
}

function decisionsTable(d) {
  const locked = isLocked(d);
  return card(null, table([
    { label: '標的', render: (x) => link(`#/assets/${x.asset_id}`, x.asset_name) },
    { label: '指標', render: (x) => x.metric_name || metricName(x.metric_code) },
    { label: '期間', render: (x) => fmtPeriod(x.period_start, x.period_end) },
    { label: '類型', render: (x) => DECISION_TYPE[x.decision_type] || x.decision_type },
    { label: '值', num: true, render: (x) => valueCell(x.value, x.unit, x.value_state) },
    { label: '值狀態', render: (x) => valueStateChip(x.value_state) },
    { label: '影響', render: (x) => (x.impact === 'high' ? chip('高影響', 'alert') : chip('一般')) },
    { label: '狀態', render: (x) => decisionStatusChip(x.status) },
    { label: '提出', render: (x) => h('span', x.proposed_by_name || '—', h('div', { class: 'pf-small muted' }, fmtTime(x.proposed_at))) },
    { label: '理由', key: 'reason' },
    { label: '審核意見', key: 'review_note' },
    { label: '', render: (x) => (!locked && x.proposed_by === myId() && ['proposed', 'first_approved'].includes(x.status)
      ? action('撤回', async () => { await post(`decisions/${x.id}/withdraw`); toast('已撤回'); render(); }, 'ghost') : x.case_id ? link(`#/quality/cases/${x.case_id}`, '案件') : '') },
  ], d.decisions, { empty: '沒有裁決紀錄' }));
}

// ── 逐筆裁決 ──
async function adjudicatePanel(d, qy) {
  const org = d.org_id;
  const assets = await get('assets', { orgId: org, limit: 1000 });
  const assetId = qy.asset || '';
  const asset = assets.find((a) => a.id === assetId);
  const metricCodes = asset ? [...new Set((itemOf(asset.item_id)?.metrics || []).map((m) => (typeof m === 'string' ? m : m.code || m.metric)).filter(Boolean))] : [];
  const mOpts = (metricCodes.length ? metricCodes : asset ? (state.meta?.metrics || []).filter((m) => m.domain === asset.domain).map((m) => m.code) : []).map((m) => [m, metricName(m)]);
  const metric = qy.metric && mOpts.some(([m]) => m === qy.metric) ? qy.metric : mOpts[0]?.[0] || '';
  const canPropose = can('decision.propose', org);
  const bar = h('div', { class: 'pf-bar' },
    select([['', '選擇標的…'], ...assets.map((a) => [a.id, `${state.meta?.domains?.[a.domain]?.icon || ''} ${a.name}`])], assetId, (v) => setQuery({ asset: v, metric: '' }), { 'aria-label': '標的' }),
    asset ? select(mOpts, metric, (v) => setQuery({ metric: v }), { 'aria-label': '指標' }) : null,
    h('div', { class: 'grow' }),
    canPropose ? action('批次帶出', () => bulkModal(d, assets, asset, metric)) : null,
    asset ? link(`#/quality/compare/${asset.id}${metric ? `?metric=${encodeURIComponent(metric)}` : ''}`, '並排比對來源') : null);
  const intro = h('p', { class: 'muted' }, '選擇標的與指標後，列出此資料集年度內的候選觀測與建議期間（自然月；帳單期間不是自然月時同時列原期間）。逐期提出採用值，經審核後寫入資料集。');
  if (!canPropose) intro.append(h('span', { class: 'err' }, ' 你沒有「提出採用值」權限，只能檢視。'));
  if (!asset || !metric) return card('逐筆裁決', bar, intro);
  const cand = await get(`datasets/${d.id}/candidates`, { assetId: asset.id, metric });
  const pendingFor = (p) => d.decisions.find((x) => x.asset_id === asset.id && x.metric_code === metric && x.period_start === p.periodStart && x.period_end === p.periodEnd && ['proposed', 'first_approved'].includes(x.status));
  const factFor = (p) => cand.facts.find((f) => f.period_start === p.periodStart && f.period_end === p.periodEnd);
  // 某期間可選的觀測：期間相同，或有分攤到此期間的值
  const choicesFor = (p) => {
    const out = [];
    for (const o of cand.observations) {
      if (o.period_start === p.periodStart && o.period_end === p.periodEnd) out.push({ o, value: o.value_std, how: '原始期間' });
      else { const t = cand.transforms.find((x) => x.observation_id === o.id && x.period_start === p.periodStart && x.period_end === p.periodEnd); if (t) out.push({ o, value: t.value, how: t.rule_code === 'alloc.daily_prorata' ? '依日數分攤' : t.rule_code }); }
    }
    return out;
  };
  const obsTable = table([
    { label: '來源', render: (o) => h('span', o.source_name, o.priority !== null && o.priority !== undefined ? h('span', { class: 'muted pf-small' }, `（優先序 ${o.priority}）`) : null) },
    { label: '期間', render: (o) => fmtPeriod(o.period_start, o.period_end) },
    { label: '原始值', num: true, render: (o) => (o.raw_value === null || o.raw_value === undefined ? '—' : `${o.raw_value} ${o.raw_unit || ''}`) },
    { label: '標準值', num: true, render: (o) => valueCell(o.value_std, o.std_unit, o.value_state) },
    { label: '值狀態', render: (o) => valueStateChip(o.value_state) },
    { label: '品質', render: (o) => qualityChip(o.quality_status) },
    { label: '方式', key: 'method' },
    { label: '邊界', key: 'boundary_note' },
  ], cand.observations, { empty: '此資料集年度內沒有觀測值；可明示「缺漏」或「不適用」' });
  const periods = cand.periods.length ? cand.periods : [{ periodStart: `${d.year}-01-01`, periodEnd: `${d.year + 1}-01-01`, calendar: false, whole: true }];
  const perTable = table([
    { label: '期間', render: (p) => h('span', fmtPeriod(p.periodStart, p.periodEnd), p.whole ? h('div', { class: 'pf-small muted' }, '全年度') : !p.calendar ? h('div', chip('原帳單期間', 'warn')) : p.derived ? h('div', { class: 'pf-small muted' }, '分攤月份') : null) },
    { label: '可選來源', render: (p) => { const c = choicesFor(p); return c.length ? h('div', c.map((x) => h('div', { class: 'pf-small' }, `${x.o.source_name}：${valueText(x.value, x.o.std_unit)}（${x.how}）`))) : h('span', { class: 'muted' }, '無'); } },
    { label: '目前採用值', render: (p) => { const f = factFor(p); return f ? h('span', valueCell(f.value, f.unit, f.value_state), ' ', valueStateChip(f.value_state)) : '—'; } },
    { label: '', render: (p) => {
      const pend = pendingFor(p);
      if (pend) return h('span', decisionStatusChip(pend.status), ' ', h('span', { class: 'pf-small muted' }, DECISION_TYPE[pend.decision_type]));
      return canPropose ? action(factFor(p) ? '改提採用值' : '提出採用值', () => proposeModal(d, asset, metric, p, choicesFor(p), cand.observations), 'primary') : '';
    } },
  ], periods);
  return frag2(card('逐筆裁決', bar, intro), card(`候選觀測：${asset.name}・${metricName(metric)}`, obsTable), card('依期間裁決', perTable,
    h('div', { class: 'pf-actions' }, canPropose ? action('自訂期間提出', () => proposeModal(d, asset, metric, null, [], cand.observations)) : null)));
}
const frag2 = (...kids) => h('div', kids);

async function proposeModal(d, asset, metric, p, choices, allObs) {
  const opts = (choices.length ? choices : allObs.map((o) => ({ o, value: o.value_std, how: '原始期間' })))
    .map((x) => [x.o.id, `${x.o.source_name}｜${fmtPeriod(x.o.period_start, x.o.period_end)}｜${valueText(x.value, x.o.std_unit)}（${x.how}）｜${({ valid: '通過', warning: '有警示', invalid: '未通過', pending_validation: '待檢核' })[x.o.quality_status] || x.o.quality_status}`]);
  const unit = allObs[0]?.std_unit || state.meta?.metrics?.find((m) => m.code === metric)?.std_unit || '';
  const endIncl = p ? (p.periodEnd <= p.periodStart ? p.periodEnd : (() => { const x = new Date(`${p.periodEnd}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); })()) : '';
  const f = form([
    { key: 'decisionType', label: '採用方式', type: 'select', required: true, options: [['select_source', DECISION_TYPE.select_source], ['derived', DECISION_TYPE.derived], ['missing', DECISION_TYPE.missing], ['not_applicable', DECISION_TYPE.not_applicable]] },
    { key: 'selectedObservationId', label: '採用哪一筆觀測', type: 'select', options: opts, wide: true },
    { key: 'value', label: `衍生值（${unit}）`, type: 'number' },
    { key: 'valueState', label: '衍生值性質', type: 'select', options: [['estimated', '估計'], ['measured', '實測換算']], default: 'estimated' },
    { key: 'method', label: '計算或估算方法', type: 'textarea', wide: true, placeholder: '文字或 JSON' },
    { key: 'periodStart', label: '期間起日', type: 'date', required: true },
    { key: 'periodEndIncl', label: '期間迄日（含當日）', type: 'date', required: true },
    { key: 'reason', label: '理由', type: 'textarea', required: true, wide: true },
  ], { decisionType: opts.length ? 'select_source' : 'missing', periodStart: p?.periodStart || '', periodEndIncl: endIncl });
  const show = () => {
    const t = f.inputs.decisionType.value;
    for (const [k, on] of Object.entries({ selectedObservationId: t === 'select_source', value: t === 'derived', valueState: t === 'derived', method: t === 'derived' })) f.inputs[k].closest('label').classList.toggle('pf-hidden', !on);
  };
  f.inputs.decisionType.addEventListener('change', show); show();
  await modal(`提出採用值：${asset.name}・${metricName(metric)}`, h('div', note('「缺漏」與「不適用」會明示在報告中，不會以 0 代替。'), f.el), { okText: '送出審核', onOk: async () => {
    const v = f.read(); if (!v) return false;
    if (v.decisionType === 'select_source' && !v.selectedObservationId) throw new Error('請選擇要採用的觀測');
    if (v.decisionType === 'derived' && (v.value === undefined || !v.method)) throw new Error('衍生值需填數值與方法');
    if (v.periodEndIncl < v.periodStart) throw new Error('迄日不可早於起日');
    let method = v.method; if (method) { try { method = JSON.parse(method); } catch { /* 純文字 */ } }
    const periodEnd = p && v.periodStart === p.periodStart && v.periodEndIncl === endIncl ? p.periodEnd : inclEndToExcl(v.periodEndIncl);
    const r = await post('decisions', { datasetId: d.id, assetId: asset.id, metricCode: metric, decisionType: v.decisionType, periodStart: v.periodStart, periodEnd,
      selectedObservationId: v.decisionType === 'select_source' ? v.selectedObservationId : undefined,
      value: v.decisionType === 'derived' ? v.value : undefined, valueState: v.decisionType === 'derived' ? v.valueState : undefined,
      method: v.decisionType === 'derived' ? method : undefined, reason: v.reason });
    toast(r.impact === 'high' ? '已送出（高影響，需兩位審核者）' : '已送出審核'); render();
  } });
}

async function bulkModal(d, assets, asset, metric) {
  const f = form([
    { key: 'scope', label: '範圍', type: 'select', required: true, options: [['all', '資料集年度內全部標的與指標'], ...(asset ? [['asset', `只限目前標的：${asset.name}`]] : []), ...(asset && metric ? [['metric', `只限目前標的與指標：${metricName(metric)}`]] : [])] },
    { key: 'reason', label: '理由', wide: true, placeholder: '單一來源、檢核通過、無差異案件' },
  ], { scope: asset && metric ? 'metric' : 'all' });
  await modal('批次帶出採用值草案', h('div', note('只會對「同一期間只有一個來源、檢核通過、沒有未結差異案件」的資料提出 select_source 草案，仍須審核。其他情況會列在略過清單，請逐筆裁決。'), f.el), { okText: '帶出', onOk: async () => {
    const v = f.read(); if (!v) return false;
    const r = await post('decisions/bulk', { datasetId: d.id, reason: v.reason, assetIds: v.scope !== 'all' ? [asset.id] : undefined, metricCodes: v.scope === 'metric' ? [metric] : undefined });
    const name = new Map(assets.map((a) => [a.id, a.name]));
    setTimeout(() => modal('批次帶出結果', h('div', note(`已提出 ${r.proposed} 筆草案，略過 ${r.skipped.length} 筆。`, r.skipped.length ? 'warn' : ''),
      table([
        { label: '標的', render: (s) => name.get(s.key.split('|')[0]) || s.key.split('|')[0] },
        { label: '指標', render: (s) => metricName(s.key.split('|')[1]) },
        { label: '期間', render: (s) => fmtPeriod(s.key.split('|')[2], s.key.split('|')[3]) },
        { label: '略過原因', key: 'why' },
      ], r.skipped, { empty: '沒有略過的項目' })), { okText: null, cancelText: '關閉' }).then(() => render()), 50);
  } });
}

// ── 指標試算（PRD §13）──
const GROUPS = [['ghg.', '溫室氣體排放'], ['energy.', '能源'], ['water.', '水資源'], ['gen.', '緊急發電機與油料'], ['act.', '營運活動量']];

async function indicatorsPage(_, qy) {
  const orgId = needOrg();
  const list = await get('datasets', { orgId });
  const ofYear = list.filter((d) => d.year === state.year);
  const pick = list.find((d) => d.id === qy.ds) || ofYear.find((d) => d.status !== 'superseded') || ofYear[0] || list[0];
  const dsSel = list.length ? select(list.map((d) => [d.id, `${d.year} ${d.name} v${d.version}（${DS_STATUS[d.status]?.[0] || d.status}）`]), pick?.id, (v) => setQuery({ ds: v }), { 'aria-label': '資料集' }) : null;
  if (!pick) return page('排放量與營運指標', { crumbs: [['#/reports', '報告與成果'], '排放量與營運指標'] }, card(null, note('這個院所還沒有資料集。請先到「資料集與定版」建立並提出採用值。', 'warn')));
  const r = await get(`datasets/${pick.id}/indicators`);
  const entries = Object.entries(r.results).sort(([a], [b]) => (a < b ? -1 : 1));
  const sections = GROUPS.map(([prefix, title]) => {
    const rows = entries.filter(([c]) => c.startsWith(prefix));
    return rows.length ? card(`${title}（${rows.length}）`, indicatorTable(rows)) : null;
  });
  const other = entries.filter(([c]) => !GROUPS.some(([p]) => c.startsWith(p)));
  return page('排放量與營運指標', { crumbs: [['#/reports', '報告與成果'], '排放量與營運指標'], actions: [dsSel, btn('資料集', () => go(`#/datasets/${pick.id}`), 'ghost')],
    intro: '依資料集的採用值與已發布的係數、計算規則試算。點「看計算過程」可展開公式、輸入、係數與版本。缺漏與不適用會明示，不會當作 0。' },
    pick.status !== 'locked' ? note('此資料集尚未定版：以下為試算結果，正式報告須引用定版資料集。', 'warn') : null,
    sections, other.length ? card(`其他（${other.length}）`, indicatorTable(other)) : null,
    card('使用的版本', dl([['資料集', `v${r.dataset.version}（${DS_STATUS[r.dataset.status]?.[0] || r.dataset.status}）`], ['資料集雜湊', r.dataset.hash ? h('span', { class: 'pf-mono' }, r.dataset.hash) : '—'],
      ['係數版本', Object.entries(r.factorVersions || {}).map(([k, v]) => `${k} v${v}`).join('、') || '—'],
      ['規則版本', Object.entries(r.ruleVersions || {}).map(([k, v]) => `${k} v${v}`).join('、') || '—']])));
}

function indicatorTable(rows) {
  const t = table([
    { label: '指標', render: ([code, x]) => h('span', x.rule?.name || code, h('div', { class: 'pf-small muted pf-mono' }, code)) },
    { label: '數值', num: true, render: ([, x]) => (x.masked ? chip('需敏感欄位權限') : x.value === null || x.value === undefined ? '—' : fmtNum(x.value, 4)) },
    { label: '單位', render: ([, x]) => x.unit || '—' },
    { label: '狀態', render: ([, x]) => valueStateChip(x.value_state) },
    { label: '', render: ([code, x]) => (x.masked ? '' : btn('看計算過程', (e) => toggleTrace(e.target, code, x), 'pf-link')) },
  ], rows.map(([c, x]) => [c, x]));
  return t;
}

function toggleTrace(button, code, x) {
  const tr = button.closest('tr');
  const next = tr.nextElementSibling;
  if (next?.dataset.trace === code) { next.remove(); button.textContent = '看計算過程'; return; }
  const td = h('td', { colspan: String(tr.children.length) }, traceView(x));
  tr.after(h('tr', { dataset: { trace: code } }, td));
  button.textContent = '收合';
}

// 計算軌跡：公式、輸入、係數、註記、捨入；其他欄位以原始 JSON 呈現
function traceView(x) {
  const t = x.trace || {};
  const { formula, inputs, factors, notes, rounding, ...rest } = t;
  const inputRows = inputs || [];
  return h('div',
    dl([['公式', formula || '—'], ['規則', x.rule ? `${x.rule.code} v${x.rule.version}` : '—'], ['捨入', rounding || '—']]),
    (notes || []).map((n) => note(n, 'warn')),
    inputRows.length ? [h('h3', '輸入'), table([
      { label: '項目', render: (i) => (i.indicator ? h('span', { class: 'pf-mono' }, i.indicator) : i.assetId ? link(`#/assets/${i.assetId}`, i.asset || i.assetId) : '—') },
      { label: '指標', render: (i) => (i.metric ? metricName(i.metric) : '—') },
      { label: '期間', render: (i) => (Array.isArray(i.period) ? fmtPeriod(i.period[0], i.period[1]) : '—') },
      { label: '值', num: true, render: (i) => (i.value === null || i.value === undefined ? '—' : valueText(i.value, i.unit)) },
      { label: '狀態', render: (i) => (i.state ? valueStateChip(i.state) : '—') },
      { label: '說明', render: (i) => [i.excluded ? '未計入' : null, i.fuel ? `燃料 ${i.fuel}` : null, i.kgCO2e !== undefined ? `${fmtNum(i.kgCO2e, 3)} kgCO₂e` : null,
        i.converted ? `換算 ×${i.converted.factor} → ${i.converted.to}` : null, i.factor ? `係數 ${i.factor}` : null].filter(Boolean).join('・') || '—' },
    ], inputRows)] : null,
    factors?.length ? [h('h3', '係數'), table([
      { label: '代碼', render: (f) => h('span', { class: 'pf-mono' }, `${f.code} v${f.version}`) },
      { label: '值', num: true, render: (f) => fmtNum(f.value, 6) },
      { label: '單位', key: 'unit' },
      { label: '來源', key: 'source' },
      { label: '適用期間', render: (f) => [f.validFrom, f.validTo].filter(Boolean).join('～') || '—' },
    ], factors)] : null,
    Object.keys(rest).length ? h('div', { class: 'pf-trace' }, JSON.stringify(rest, null, 2)) : null);
}
