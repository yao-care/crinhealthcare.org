// 報告承辦工作台（PRD §8、§8.3、§12）：報告案件、就緒度三欄工作台、產製版本、送審／核准封存、匯出、人工送件紀錄。
import { state, get, post, patch, h, route, page, card, table, link, chip, valueStateChip, fmtNum, fmtPeriod, fmtTime, fmtDate,
  action, btn, modal, formModal, form, userOptions, toast, can, needOrg, render, note, dl, go, metricName, download } from '../core.js';

export function register() {
  route('/reports', listPage, { title: '報告案件' });
  route('/reports/run/:id', runPage, { title: '報告版本' });
  route('/reports/:id', casePage, { title: '報告案件' });
}

const CRUMB = ['#/reports', '報告案件'];
const CASE_STATUS = { draft: ['草稿', 'todo'], preparing: ['準備中', 'info'], in_review: ['審查中', 'info'], approved: ['已核准', 'ok'], locked: ['已封存', 'ok'], exported: ['已封存並匯出', 'ok'], submitted_manual: ['已記錄人工送件', 'ok'] };
const RUN_STATUS = { draft: ['草稿', 'todo'], in_review: ['審查中', 'info'], returned: ['已退回', 'alert'], approved: ['已核准', 'ok'], locked: ['已封存', 'ok'], superseded: ['已被新版取代', ''] };
const DS_STATUS = { draft: '草稿', in_review: '待核准', approved: '已核准', locked: '已定版', superseded: '已被新版取代' };
const CONF = [['public', '公開'], ['internal', '內部'], ['restricted', '限閱'], ['secret', '機密']];
const caseChip = (s) => chip(...(CASE_STATUS[s] || [s, '']));
const runChip = (s) => chip(...(RUN_STATUS[s] || [s, '']));
const caseSealed = (c) => ['locked', 'exported', 'submitted_manual'].includes(c.status);
const valueText = (v, unit) => (v === null || v === undefined ? '—' : `${typeof v === 'number' ? fmtNum(v, 4) : v}${unit ? ` ${unit}` : ''}`);
const today = () => new Date().toISOString().slice(0, 10);
const dsLabel = (d) => `${d.year} ${d.name} v${d.version}（${DS_STATUS[d.status] || d.status}）`;

// ── 清單 ──
async function listPage() {
  const orgId = needOrg();
  const list = await get('report-cases', { orgId });
  const create = can('report.write') ? action('＋建立報告案件', () => createModal(orgId), 'primary') : null;
  return page('報告案件', { crumbs: [CRUMB], actions: [create], intro: '每份報告依版本化模板取值，所有數字都來自定版資料集的採用值；封存後可重現同一結果。本系統只產出官方格式檔，送件仍須人工完成。' },
    card(null, table([
      { label: '報告', render: (c) => link(`#/reports/${c.id}`, c.name) },
      { label: '模板', render: (c) => h('span', c.template_name, h('div', { class: 'pf-small muted' }, `${c.standard_version || ''} 模板 v${c.template_version}`)) },
      { label: '年度', key: 'year' },
      { label: '資料集', render: (c) => (c.dataset_id ? link(`#/datasets/${c.dataset_id}`, `v${c.dataset_version}・${DS_STATUS[c.dataset_status] || c.dataset_status}`) : chip('未指定', 'warn')) },
      { label: '狀態', render: (c) => caseChip(c.status) },
      { label: '最新版本', render: (c) => (c.last_run_status ? runChip(c.last_run_status) : '—') },
      { label: '期限', render: (c) => (c.due_date && c.due_date < today() && !caseSealed(c) ? chip(`${c.due_date}（已逾期）`, 'alert') : fmtDate(c.due_date)) },
    ], list, { empty: '這個院所還沒有報告案件', onRow: (c) => go(`#/reports/${c.id}`) })));
}

async function createModal(orgId) {
  const [datasets, users] = await Promise.all([get('datasets', { orgId }), userOptions(orgId)]);
  const tplOptions = (tpls) => {
    const by = new Map();
    for (const t of tpls) if (!by.has(t.code) || by.get(t.code).version < t.version) by.set(t.code, t);
    return [...by.values()].map((t) => [t.code, `${t.name}（${t.standard_version || t.standard}・v${t.version}）`]);
  };
  const first = await get('report-templates', { publishDate: today() });
  const f = form([
    { key: 'publishDate', label: '預定發布日期', type: 'date', required: true, hint: '依發布日期選模板版次（例：GRI 2027-01-01 起換新版）' },
    { key: 'templateCode', label: '報告模板', type: 'select', required: true, options: tplOptions(first), wide: true },
    { key: 'year', label: '報告年度', type: 'number', required: true },
    { key: 'name', label: '名稱（選填）', placeholder: '預設：年度＋模板名稱' },
    { key: 'datasetId', label: '資料集', type: 'select', options: datasets.filter((d) => d.status !== 'superseded').map((d) => [d.id, dsLabel(d)]), wide: true, hint: '可稍後再指定；送審前資料集須已定版' },
    { key: 'dueDate', label: '期限', type: 'date' },
    { key: 'confidentiality', label: '機敏等級', type: 'select', required: true, options: CONF },
    { key: 'reviewer', label: '審查者', type: 'select', options: users },
    { key: 'approver', label: '核准者', type: 'select', options: users },
  ], { publishDate: today(), year: state.year - 1, confidentiality: 'internal', datasetId: datasets.find((d) => d.year === state.year - 1 && d.status === 'locked')?.id || '' });
  const hint = h('p', { class: 'muted pf-small' });
  const reload = async () => {
    const tpls = await get('report-templates', { publishDate: f.inputs.publishDate.value || today() });
    const sel = f.inputs.templateCode; const keep = sel.value;
    sel.replaceChildren(...tplOptions(tpls).map(([v, l]) => h('option', { value: v }, l)));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    hint.textContent = tpls.length ? '' : '此發布日期沒有適用的已發布模板';
  };
  f.inputs.publishDate.addEventListener('change', () => reload().catch((e) => toast(e.message, 'err')));
  await modal('建立報告案件', h('div', f.el, hint), { okText: '建立', onOk: async () => {
    const v = f.read(); if (!v) return false;
    const r = await post('report-cases', { orgId, ...v });
    toast(`已建立：${r.template.name}（${r.template.standardVersion || ''} v${r.template.version}）`); go(`#/reports/${r.id}`);
  } });
}

// ── 案件三欄工作台（PRD §8.3）──
async function casePage({ id }, qy) {
  // 後端沒有單筆案件端點：由清單取
  const all = await get('report-cases');
  const c = all.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error('找不到報告案件或沒有檢視權限'), { status: 404 });
  const org = c.org_id; const sealed = caseSealed(c);
  const [rd, runs, tpl] = await Promise.all([get(`report-cases/${id}/readiness`), get(`report-cases/${id}/runs`), get(`admin/templates/${c.template_id}`).catch(() => null)]);
  const sectionTitle = new Map((tpl?.sections || []).map((s) => [s.id, s.title]));
  const order = (tpl?.sections || []).map((s) => s.id);
  const bySection = new Map();
  for (const f of rd.fields) { if (!bySection.has(f.section)) bySection.set(f.section, []); bySection.get(f.section).push(f); }
  const sections = [...bySection.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  const editable = !sealed && can('report.write', org);
  let selected = rd.fields.find((f) => f.field_id === qy.field) || null;

  const fieldState = (f) => (f.source_kind === 'evidence_list' || f.source_kind === 'quality' ? chip('產製時彙整', 'info') : valueStateChip(f.state));
  const right = h('div');
  const leftItems = new Map();
  const select = (f) => {
    selected = f;
    for (const [fid, el] of leftItems) el.classList.toggle('on', fid === f.field_id);
    drawRight().catch((e) => right.replaceChildren(card('欄位詳細', h('p', { class: 'err' }, e.message))));
  };
  const left = card('章節與欄位', sections.map((s) => [h('h3', sectionTitle.get(s) || s),
    h('ul', { class: 'pf-timeline' }, bySection.get(s).map((f) => {
      const b = btn(f.label, () => select(f), 'pf-link');
      leftItems.set(f.field_id, b);
      return h('li', b, f.required ? h('span', { class: 'err', title: '必要欄位' }, ' ＊') : null, ' ', fieldState(f));
    }))]),
  h('p', { class: 'muted pf-small' }, '＊ 為必要欄位；缺漏須補件、裁決或明示不適用，不可用 0 帶過。'));

  const middle = card('欄位數值', sections.map((s) => [h('h3', sectionTitle.get(s) || s), table([
    { label: '欄位', render: (f) => btn(f.label, () => select(f), 'pf-link') },
    { label: '數值', num: true, render: (f) => middleValue(f) },
    { label: '狀態', render: (f) => fieldState(f) },
    { label: '說明', render: (f) => (f.notes?.length ? h('div', f.notes.map((n) => h('div', { class: 'pf-small' }, n))) : f.note || '—') },
  ], bySection.get(s))]));

  function middleValue(f) {
    if (f.source_kind === 'manual') {
      if (!editable) return f.value ? h('span', f.value) : valueStateChip(f.state);
      const ta = h('textarea', { 'aria-label': f.label, rows: '3' }); ta.value = f.value || '';
      return h('div', { class: 'pf-field' }, ta, action('儲存文字', async () => {
        await patch(`report-cases/${id}`, { manualValues: { [f.field_id]: ta.value.trim() } }); toast('已儲存'); render();
      }));
    }
    if (f.source_kind !== 'indicator') return '—';
    return f.value === null || f.value === undefined ? '—' : valueText(f.value, f.unit);
  }

  async function drawRight() {
    if (!selected) { right.replaceChildren(card('欄位詳細', h('p', { class: 'muted' }, '點選左側或中間的欄位，查看計算過程與佐證。'))); return; }
    const f = selected;
    const head = dl([['欄位代碼', h('span', { class: 'pf-mono' }, f.field_id)], ['來源類型', { indicator: '指標試算', manual: '人工文字', evidence_list: '佐證清單', quality: '資料品質摘要' }[f.source_kind] || f.source_kind],
      ['對應', f.source_ref ? h('span', { class: 'pf-mono' }, f.source_ref) : '—'], ['必要', f.required ? '是' : '否'], f.note ? ['備註', f.note] : null]);
    if (f.source_kind !== 'indicator' || !c.dataset_id) {
      right.replaceChildren(card(`欄位：${f.label}`, head, f.source_kind === 'indicator' ? note('尚未指定資料集，無法試算', 'warn') : f.source_kind === 'manual' ? note('人工撰寫的文字段落，於中間欄編輯。') : note('產製報告時由資料集自動彙整。')));
      return;
    }
    right.replaceChildren(card(`欄位：${f.label}`, head, h('p', { class: 'muted' }, '載入計算過程…')));
    const r = await get(`datasets/${c.dataset_id}/indicators`, { codes: f.source_ref });
    if (selected !== f) return;
    const x = r.results[f.source_ref];
    const assetIds = [...new Set((x?.trace?.inputs || []).filter((i) => i.assetId && !i.excluded).map((i) => i.assetId))].slice(0, 8);
    const ev = (await Promise.all(assetIds.map((a) => get('evidence', { orgId: org, assetId: a }).catch(() => [])))).flat();
    const evUniq = [...new Map(ev.map((e) => [e.id, e])).values()];
    if (selected !== f) return;
    right.replaceChildren(card(`欄位：${f.label}`, head,
      x ? h('div', h('p', h('b', x.masked ? '需敏感欄位權限' : x.value === null || x.value === undefined ? '—' : valueText(x.value, x.unit)), ' ', valueStateChip(x.value_state)), x.masked ? null : traceView(x)) : note('查無此指標', 'warn'),
      h('h3', `佐證（${evUniq.length}）`),
      evUniq.length ? h('ul', evUniq.map((e) => h('li', e.canOpen ? h('a', { href: `/api/v1/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, e.filename) : h('span', e.filename, h('span', { class: 'muted pf-small' }, '（無權開啟）')),
        e.asset_name ? h('span', { class: 'muted pf-small' }, `・${e.asset_name}`) : null))) : h('p', { class: 'muted' }, '計算所用的標的沒有佐證文件')));
  }
  await drawRight().catch((e) => right.replaceChildren(card('欄位詳細', h('p', { class: 'err' }, e.message))));
  if (selected) leftItems.get(selected.field_id)?.classList.add('on');

  const actions = [];
  if (editable) {
    actions.push(action('修改案件', () => editModal(c)));
    actions.push(action('產製報告版本', async () => { const r = await post(`report-cases/${id}/runs`); toast(`已產製第 ${r.runNo} 版`); go(`#/reports/run/${r.id}`); }, 'primary'));
  }
  if (['locked', 'exported'].includes(c.status) && can('report.approve', org)) actions.push(action('記錄已人工送件', () => formModal('記錄已人工送件', [
    { key: 'submittedAt', label: '送件日期', type: 'date', required: true },
    { key: 'note', label: '送件方式與說明', type: 'textarea', required: true, wide: true, placeholder: '例：2027-03-20 由承辦人登入環境部平台上傳封存版 xlsx，收件編號 …' },
  ], { submittedAt: today() }, async (v) => { await post(`report-cases/${id}/manual-submission`, v); toast('已記錄人工送件'); render(); }, '記錄')));

  const pct = rd.total ? Math.round(rd.ready / rd.total * 100) : null;
  return page(c.name, { crumbs: [CRUMB, c.name], actions },
    sealed ? note(c.status === 'submitted_manual' ? '已記錄人工送件（此為承辦人自行送件的紀錄，本系統不會自動申報）。' : '報告已封存，內容不可修改。', '') : null,
    ['locked', 'exported'].includes(c.status) ? note('本系統只產出官方格式檔案，不會代為申報或上傳。完成送件後請以「記錄已人工送件」留下紀錄。', 'warn') : null,
    card(null, dl([['狀態', caseChip(c.status)], ['模板', `${c.template_name}（${c.standard_version || ''} v${c.template_version}）`], ['年度', String(c.year)],
      ['資料集', c.dataset_id ? link(`#/datasets/${c.dataset_id}`, `v${c.dataset_version}・${DS_STATUS[c.dataset_status] || c.dataset_status}`) : chip('未指定', 'warn')],
      ['就緒度', rd.total ? `${rd.ready} / ${rd.total}（${pct}%）` : '—'], ['期限', fmtDate(c.due_date)], ['機敏等級', CONF.find(([k]) => k === c.confidentiality)?.[1] || c.confidentiality],
      ['發布日期', fmtDate(c.publish_date)]])),
    rd.datasetMissing ? note('尚未指定資料集：請按「修改案件」選擇資料集。', 'warn') : null,
    (rd.blockers || []).length ? h('div', rd.blockers.map((b) => note(b, 'warn'))) : null,
    h('div', { class: 'pf-three' }, left, middle, right),
    card('報告版本', table([
      { label: '版次', render: (r) => link(`#/reports/run/${r.id}`, `第 ${r.run_no} 版`) },
      { label: '狀態', render: (r) => runChip(r.status) },
      { label: '產製', render: (r) => h('span', fmtTime(r.created_at), h('div', { class: 'pf-small muted' }, r.created_by_name || '')) },
      { label: '封存', render: (r) => fmtTime(r.locked_at) },
      { label: '模板版次', render: (r) => `v${r.template_version}` },
      { label: '雜湊', render: (r) => (r.hash ? h('span', { class: 'pf-mono', title: r.hash }, r.hash.slice(0, 12)) : '—') },
    ], runs, { empty: '尚未產製版本', onRow: (r) => go(`#/reports/run/${r.id}`) })));
}

async function editModal(c) {
  const [datasets, users] = await Promise.all([get('datasets', { orgId: c.org_id }), userOptions(c.org_id)]);
  await formModal('修改報告案件', [
    { key: 'name', label: '名稱', required: true, wide: true },
    { key: 'datasetId', label: '資料集', type: 'select', options: datasets.filter((d) => d.status !== 'superseded' || d.id === c.dataset_id).map((d) => [d.id, dsLabel(d)]), wide: true, hint: '換資料集後需重新產製版本' },
    { key: 'dueDate', label: '期限', type: 'date' },
    { key: 'confidentiality', label: '機敏等級', type: 'select', required: true, options: CONF },
    { key: 'reviewer', label: '審查者', type: 'select', options: users },
    { key: 'approver', label: '核准者', type: 'select', options: users },
  ], { name: c.name, datasetId: c.dataset_id, dueDate: c.due_date, confidentiality: c.confidentiality, reviewer: c.reviewer, approver: c.approver },
  async (v) => { await patch(`report-cases/${c.id}`, v); toast('已更新'); render(); });
}

// ── 報告版本 ──
async function runPage({ id }) {
  const r = await get(`report-runs/${id}`);
  const org = r.org_id;
  const tpl = r.template || {};
  const maps = tpl.mappings || [];
  const fields = r.results?.fields || {};
  const sectionTitle = new Map((tpl.sections || []).map((s) => [s.id, s.title]));
  const order = (tpl.sections || []).map((s) => s.id);
  const sections = [...new Set(maps.map((m) => m.section))].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  const readOnly = ['locked', 'superseded'].includes(r.status);

  const actions = [];
  if (['draft', 'returned'].includes(r.status) && can('report.write', org)) actions.push(action('送審', async () => { await post(`report-runs/${id}/submit`); toast('已送審'); render(); }, 'primary'));
  if (r.status === 'in_review' && !r.reviewed_by && can('report.review', org)) {
    actions.push(action('審查通過', () => formModal('審查通過', [{ key: 'note', label: '審查意見（選填）', type: 'textarea', wide: true }], {},
      async (v) => { await post(`report-runs/${id}/review`, { approve: true, note: v.note }); toast('已通過審查，待核准'); render(); }, '通過'), 'primary'));
    actions.push(action('退回', () => formModal('退回報告', [{ key: 'note', label: '退回理由', type: 'textarea', required: true, wide: true }], {},
      async (v) => { await post(`report-runs/${id}/review`, { approve: false, note: v.note }); toast('已退回'); render(); }, '退回'), 'danger-btn'));
  }
  if (r.status === 'in_review' && r.reviewed_by && can('report.approve', org)) actions.push(action('核准並封存', () => formModal('核准並封存', [{ key: 'note', label: '核准意見（選填）', type: 'textarea', wide: true }], {},
    async (v) => { const x = await post(`report-runs/${id}/approve`, v); toast(`已封存，雜湊 ${String(x.hash).slice(0, 12)}…`); render(); }, '核准並封存'), 'primary'));
  actions.push(action('重現驗證', async () => {
    const x = await get(`report-runs/${id}/reproduce`);
    await modal('重現驗證', h('div', note(x.reproducible ? '✅ 可重現：以封存的資料集、係數與規則版本重算，結果與此版本相同。' : '❌ 無法重現：重算結果與此版本不同。', x.reproducible ? '' : 'alert'),
      dl([['資料集雜湊', x.datasetHashOk ? '一致' : '不一致']]),
      x.diffs.length ? table([
        { label: '欄位', render: (d) => maps.find((m) => m.field_id === d.field)?.label || d.field },
        { label: '版本值', num: true, render: (d) => (d.stored === null || d.stored === undefined ? valueStateChip(d.storedState) : fmtNum(d.stored, 4)) },
        { label: '重算值', num: true, render: (d) => (d.now === null || d.now === undefined ? valueStateChip(d.nowState) : fmtNum(d.now, 4)) },
        { label: '狀態', render: (d) => h('span', valueStateChip(d.storedState), ' → ', valueStateChip(d.nowState)) },
      ], x.diffs) : null), { okText: null, cancelText: '關閉' });
  }));

  const exportBar = can('export.download', org) ? card('匯出', h('div', { class: 'pf-actions' }, ['xlsx', 'csv', 'docx', 'pdf', 'html'].map((fmt) => btn(fmt.toUpperCase(), () => download(`report-runs/${id}/export`, { format: fmt })))),
    h('p', { class: 'muted pf-small' }, r.status === 'locked' ? '封存版匯出檔會留存雜湊；匯出不代表已送件，送件請人工完成後回案件頁記錄。' : '此版本尚未封存，匯出檔僅供內部檢閱，不可作為正式送件。'))
    : note('你沒有「下載匯出檔」權限。');

  const fieldRows = (sec) => maps.filter((m) => m.section === sec).map((m) => ({ m, f: fields[m.field_id] || {} }));
  const fieldValue = ({ m, f }) => {
    if (f.masked) return chip('需敏感欄位權限');
    if (f.list) return `${f.list.length} 件佐證`;
    if (f.quality) return `${fmtNum(f.quality.facts)} 筆採用值・未結案件 ${fmtNum(f.quality.openCases)}`;
    if (f.value === null || f.value === undefined) return valueStateChip(f.state || 'missing');
    return valueText(f.value, f.unit || m.unit);
  };
  const extra = Object.values(fields).find((f) => f.list) || null;
  const quality = Object.values(fields).find((f) => f.quality)?.quality || null;

  return page(`${r.case_name}・第 ${r.run_no} 版`, { crumbs: [CRUMB, [`#/reports/${r.case_id}`, r.case_name], `第 ${r.run_no} 版`], actions },
    readOnly ? note(r.status === 'locked' ? '已封存：內容唯讀，不可修改。' : '此版本已被較新的版本取代，僅供追溯。', r.status === 'locked' ? '' : 'warn') : null,
    r.status === 'returned' && r.review_note ? note(`退回理由：${r.review_note}`, 'alert') : null,
    card(null, dl([['狀態', runChip(r.status)], ['報告雜湊', r.hash ? h('span', { class: 'pf-mono' }, r.hash) : '—'],
      ['資料集', link(`#/datasets/${r.dataset_id}`, '開啟')], ['資料集雜湊', r.dataset_hash ? h('span', { class: 'pf-mono' }, r.dataset_hash) : chip('產製時資料集未定版', 'warn')],
      ['模板版次', `${tpl.name || ''} v${r.template_version}`],
      ['係數版本', Object.entries(r.factor_versions || {}).map(([k, v]) => `${k} v${v}`).join('、') || '—'],
      ['規則版本', Object.entries(r.rule_versions || {}).map(([k, v]) => `${k} v${v}`).join('、') || '—'],
      ['產製', fmtTime(r.created_at)], ['送審', fmtTime(r.submitted_at)], ['審查', r.reviewed_at ? fmtTime(r.reviewed_at) : '—'], ['核准', fmtTime(r.approved_at)], ['封存', fmtTime(r.locked_at)],
      r.review_note ? ['審核意見', r.review_note] : null])),
    sections.map((s) => card(sectionTitle.get(s) || s, table([
      { label: '欄位', render: ({ m }) => h('span', m.label, m.required ? h('span', { class: 'err', title: '必要欄位' }, ' ＊') : null) },
      { label: '數值', num: true, render: fieldValue },
      { label: '狀態', render: ({ f }) => (f.state ? valueStateChip(f.state) : f.list || f.quality ? chip('彙整', 'info') : '—') },
      { label: '指標', render: ({ f }) => (f.indicator ? h('span', { class: 'pf-mono' }, f.indicator) : '—') },
    ], fieldRows(s)))),
    quality ? card('資料品質摘要', dl([['採用值筆數', fmtNum(quality.facts)], ['依值狀態', Object.entries(quality.byState || {}).map(([k, n]) => `${state.meta?.valueStates?.[k] || k} ${n}`).join('、') || '—'],
      ['依裁決類型', Object.entries(quality.decisions || {}).map(([k, n]) => `${k} ${n}`).join('、') || '—'], ['高影響裁決', fmtNum(quality.highImpact)], ['未結差異案件', fmtNum(quality.openCases)]])) : null,
    extra ? card(`佐證清單（${extra.list.length}）`, table([
      { label: '檔名', key: 'filename' }, { label: '標的', key: 'asset_name' }, { label: '指標', render: (e) => metricName(e.metric_code) },
      { label: '期間', render: (e) => fmtPeriod(e.period_start, e.period_end) }, { label: 'SHA-256', render: (e) => h('span', { class: 'pf-mono', title: e.sha256 }, String(e.sha256 || '').slice(0, 12)) },
    ], extra.list, { empty: '沒有佐證' })) : null,
    exportBar,
    (r.artifacts || []).length ? card('已留存的匯出檔', table([
      { label: '格式', render: (a) => a.format.toUpperCase() }, { label: '大小', num: true, render: (a) => `${fmtNum(a.size / 1024, 1)} KB` },
      { label: 'SHA-256', render: (a) => h('span', { class: 'pf-mono' }, a.sha256) }, { label: '時間', render: (a) => fmtTime(a.created_at) },
    ], r.artifacts)) : null);
}

// 計算軌跡（與指標頁相同呈現；為保持模組獨立在此各自實作）
function traceView(x) {
  const t = x.trace || {};
  const { formula, inputs, factors, notes, rounding, ...rest } = t;
  return h('div',
    dl([['公式', formula || '—'], ['規則', x.rule ? `${x.rule.code} v${x.rule.version}` : '—'], ['捨入', rounding || '—']]),
    (notes || []).map((n) => note(n, 'warn')),
    inputs?.length ? [h('h3', '輸入'), table([
      { label: '項目', render: (i) => (i.indicator ? h('span', { class: 'pf-mono' }, i.indicator) : i.assetId ? link(`#/assets/${i.assetId}`, i.asset || i.assetId) : '—') },
      { label: '期間', render: (i) => (Array.isArray(i.period) ? fmtPeriod(i.period[0], i.period[1]) : '—') },
      { label: '值', num: true, render: (i) => (i.value === null || i.value === undefined ? '—' : valueText(i.value, i.unit)) },
      { label: '說明', render: (i) => [i.metric ? metricName(i.metric) : null, i.excluded ? '未計入' : null, i.state && i.value !== null && i.value !== undefined ? state.meta?.valueStates?.[i.state] : null,
        i.kgCO2e !== undefined ? `${fmtNum(i.kgCO2e, 3)} kgCO₂e` : null].filter(Boolean).join('・') || '—' },
    ], inputs)] : null,
    factors?.length ? [h('h3', '係數'), table([
      { label: '代碼', render: (f) => h('span', { class: 'pf-mono' }, `${f.code} v${f.version}`) },
      { label: '值', num: true, render: (f) => `${fmtNum(f.value, 6)} ${f.unit || ''}` },
      { label: '來源', key: 'source' },
    ], factors)] : null,
    Object.keys(rest).length ? h('div', { class: 'pf-trace' }, JSON.stringify(rest, null, 2)) : null);
}
