// 溫室氣體盤查設定（ISO 14064-1:2018 第 9.3.1 條）：顯著性評估與類別 3–6 量化、基準年、報告段落預覽
import { state, get, post, patch, api, h, route, page, card, table, link, chip, fmtNum, fmtTime, action, formModal, form, toast, can, needOrg, render, note, dl, tabs, select, confirmBox } from '../core.js';
import { blockView } from './reports.js';

export function register() {
  route('/ghg', ghg, { title: '溫室氣體盤查設定' });
}

const CAT = ['', '一', '二', '三', '四', '五', '六'];
const sigChip = (r) => (r.significant === null ? chip('未評估', 'todo') : r.significant ? chip('顯著', 'warn') : chip('不顯著', ''));

async function ghg(_, qy) {
  const orgId = needOrg();
  const tab = qy.tab || 'profile';
  const T = (k, l) => [`#/ghg?tab=${k}`, l];
  let body;
  if (tab === 'base') body = await baseTab(orgId);
  else if (tab === 'profile') body = await profileTab(orgId);
  else if (tab === 'preview') body = await previewTab(orgId, qy);
  else body = await sigTab(orgId);
  return page('溫室氣體盤查設定', { intro: `ISO 14064-1:2018 報告需要的顯著性評估、基準年與排放源資料。${state.year} 年度。` },
    tabs([T('profile', '院所基本資料'), T('significance', '間接排放顯著性評估'), T('base', '基準年'), T('preview', '報告段落預覽')], `#/ghg?tab=${tab}`), body);
}

async function sigTab(orgId) {
  const [d, est] = await Promise.all([get('ghg/significance', { orgId, year: state.year }), get('ghg/significance/estimate', { orgId, year: state.year }).catch(() => ({ estimates: {} }))]);
  const E = est.estimates || {};
  const w = can('report.write', orgId);
  const edit = (r) => formModal(`顯著性評估：${r.name}`, [
    { key: 'significant', label: '判定', type: 'select', required: true, options: [['1', '顯著（需量化或說明未量化原因）'], ['0', '不顯著']] },
    { key: 'reason', label: '判定理由（例：預估占總量 0.3%，低於 1% 門檻）', type: 'textarea', required: true, wide: true },
    { key: 'criteria', label: '採用準則（留空＝系統預設準則）', wide: true },
    { key: 'quantified', label: '已量化', type: 'checkbox' },
    { key: 'valueTco2e', label: '排放量（tCO₂e）', type: 'number' },
    { key: 'method', label: '量化方法與係數來源（已量化必填）', type: 'textarea', wide: true },
    { key: 'dataSource', label: '活動數據來源（問卷、派車單、磅單…）' },
    { key: 'uncertaintyPct', label: '不確定性（±%）', type: 'number' },
  ], { significant: r.significant === null ? '' : String(r.significant), reason: r.reason, criteria: r.criteria, quantified: !!r.quantified, valueTco2e: r.value_tco2e, method: r.method, dataSource: r.data_source, uncertaintyPct: r.uncertainty_pct },
  async (v) => { await patch(`ghg/significance/${r.id}`, { ...v, significant: v.significant === '1' }); toast('已儲存'); render(); });
  const pending = d.rows.filter((r) => r.significant === null).length;
  const useEst = async (r, e) => { await patch(`ghg/significance/${r.id}`, { significant: e.suggestSignificant, reason: `系統估算 ${fmtNum(e.tCO2e, 2)} tCO₂e，占類別一＋二 ${fmtNum(e.sharePct, 2)}%，${e.suggestSignificant ? '達' : '未達'}顯著門檻 ${est.thresholdPct}%`,
    quantified: e.suggestSignificant, valueTco2e: e.suggestSignificant ? e.tCO2e : undefined, method: e.suggestSignificant ? e.method : undefined }); toast('已採用估算'); render(); };
  const estCell = (r) => { const e = E[r.item_code]; if (!e) return '—';
    if (e.tCO2e === undefined) return h('span', { class: 'muted pf-small' }, e.note);
    return h('div', h('div', `${fmtNum(e.tCO2e, 2)} tCO₂e（${e.sharePct === null ? '—' : `${fmtNum(e.sharePct, 2)}%`}）`, ' ', e.suggestSignificant ? chip('建議顯著', 'warn') : chip('建議不顯著')),
      w && r.significant === null ? action('採用估算', () => useEst(r, e)) : null); };
  return h('div',
    w && pending ? h('div', { class: 'pf-actions' }, action(`其餘 ${pending} 項一鍵判定「不顯著」`, async () => {
      if (!(await confirmBox('一鍵判定不顯著', `尚未評估的 ${pending} 項全部判定為不顯著，理由統一為「預估占比低於門檻，且無法規或利害關係人揭露要求」。之後仍可逐項改。`, '確定'))) return;
      const r = await post('ghg/significance/rest-insignificant', { orgId, year: state.year }); toast(`已判定 ${r.updated} 項`); render(); }, 'primary'),
      h('span', { class: 'muted pf-small' }, '建議先處理有估算值或你知道會顯著的項目（例：員工通勤、醫療廢棄物），其餘一鍵帶過。')) : null,
    note(`準則：${d.criteria?.criteria || '（未設定）'}（門檻 ${d.criteria?.thresholdPct ?? '—'}%，可在「門檻與設定 › ghg.significance」調整）`),
    pending ? note(`尚有 ${pending} 項未評估；未評估完成前，盤查報告的「報告邊界」與「類別三～六」會標為缺漏。`, 'warn') : null,
    [1, 3, 4, 5, 6].map((c) => {
      const rows = d.rows.filter((r) => r.category === c); if (!rows.length) return null;
      return card(d.categories[c], table([
        { label: '項目', key: 'name' }, { label: '判定', render: sigChip }, { label: '理由', key: 'reason' },
        { label: '系統估算', render: estCell },
        { label: '已量化', render: (r) => (r.quantified ? chip('是', 'ok') : '否') }, { label: 'tCO₂e', num: true, render: (r) => fmtNum(r.value_tco2e, 4) },
        { label: '方法', key: 'method' }, { label: '更新', render: (r) => (r.updated_by_name ? `${r.updated_by_name} ${fmtTime(r.updated_at)}` : '—') },
        { label: '', render: (r) => (w ? action('評估', () => edit(r)) : '') },
      ], rows));
    }));
}

async function baseTab(orgId) {
  const [list, datasets] = await Promise.all([get('ghg/base-years', { orgId }), get('datasets', { orgId })]);
  const locked = datasets.filter((d) => ['locked', 'superseded'].includes(d.status));
  const w = can('report.write', orgId);
  const sug = !list.length ? await get('ghg/base-years/suggest', { orgId }).catch(() => null) : null;
  const form = (kind) => formModal(kind === 'set' ? '設定基準年' : '基準年重新計算', [
    { key: 'datasetId', label: '基準年資料集（須已定版）', type: 'select', required: true, options: locked.map((d) => [d.id, `${d.year} 年・${d.name} v${d.version}`]) },
    { key: 'reason', label: kind === 'set' ? '選定理由（例：首次完整盤查年度）' : '重新計算原因（組織結構變更、方法變更、發現重大錯誤）', type: 'textarea', required: true, wide: true },
    { key: 'policy', label: '重新計算政策', type: 'textarea', wide: true, default: '組織邊界、量化方法或排放係數變更，累積影響達基準年排放量門檻時重新計算基準年' },
    { key: 'recalcThresholdPct', label: '重新計算門檻（%）', type: 'number', default: 5 },
  ], {}, async (v) => {
    const d = locked.find((x) => x.id === v.datasetId);
    await post('ghg/base-years', { ...v, orgId, baseYear: d.year, kind }); toast('已儲存'); render();
  }, '儲存');
  return h('div',
    !locked.length ? note('還沒有已定版的資料集；基準年須以定版資料集為準。', 'warn') : null,
    sug && w ? card('建議', h('p', `以最早定版的 ${sug.year} 年資料集（${sug.name} v${sug.version}）作為基準年。`), h('div', { class: 'pf-actions' }, action(`一鍵設定 ${sug.year} 年為基準年`, async () => {
      await post('ghg/base-years', { orgId, baseYear: sug.year, datasetId: sug.id, kind: 'set', reason: '首次完整盤查年度', policy: '組織邊界、量化方法或排放係數變更，累積影響達基準年排放量 5% 時重新計算基準年', recalcThresholdPct: 5 });
      toast('已設定'); render(); }, 'primary'))) : null,
    card('基準年紀錄', h('div', { class: 'pf-actions' }, w && locked.length ? action(list.length ? '重新計算基準年' : '設定基準年', () => form(list.length ? 'recalculated' : 'set'), 'primary') : null),
      table([
        { label: '類型', render: (b) => chip(b.kind === 'set' ? '設定' : '重新計算', b.kind === 'set' ? 'ok' : 'warn') }, { label: '基準年', key: 'base_year' },
        { label: '資料集', render: (b) => link(`#/datasets/${b.dataset_id}`, `${b.dataset_name || ''} v${b.dataset_version || ''}`) },
        { label: '類別一 tCO₂e', num: true, render: (b) => fmtNum(b.emissions?.values?.['ghg.s1.total']?.value, 4) },
        { label: '類別二 tCO₂e', num: true, render: (b) => fmtNum(b.emissions?.values?.['ghg.s2.total']?.value, 4) },
        { label: '合計 tCO₂e', num: true, render: (b) => fmtNum(b.emissions?.values?.['ghg.total']?.value, 4) },
        { label: '原因', key: 'reason' }, { label: '政策', key: 'policy' }, { label: '門檻 %', key: 'recalc_threshold_pct', num: true },
        { label: '建立', render: (b) => `${b.created_by_name || ''} ${fmtTime(b.created_at)}` },
      ], list, { empty: '尚未設定基準年' })),
    note('基準年排放量在設定當下以資料集快照保存；之後資料集或係數變動不會改變已記錄的基準年數值，要更新請用「重新計算」並寫明原因。'));
}

async function previewTab(orgId, qy) {
  const [datasets, boundaries] = await Promise.all([get('datasets', { orgId }), get(`orgs/${orgId}/boundaries`).catch(() => [])]);
  const ds = datasets.filter((d) => d.year === state.year);
  const dsId = qy.ds || ds.find((d) => d.status === 'locked')?.id || ds[0]?.id || '';
  const bnd = qy.bnd || boundaries.find((b) => ['ghg_operational', 'ghg_equity'].includes(b.kind))?.id || '';
  const go = (patchQ) => { const p = new URLSearchParams({ tab: 'preview', ds: dsId, bnd, ...patchQ }); location.hash = `#/ghg?${p}`; };
  const blocks = await get('ghg/preview', { orgId, year: state.year, datasetId: dsId, boundaryId: bnd });
  const T = { org_boundary: '組織邊界', report_boundary: '報告邊界', indirect_table: '間接排放顯著性評估', exclusions: '排除說明', base_year: '基準年',
    source_inventory: '排放源鑑別表', data_quality: '數據品質評分', uncertainty_table: '不確定性評估' };
  return h('div',
    h('div', { class: 'pf-bar' }, '資料集', select([['', '（未選）'], ...ds.map((d) => [d.id, `${d.name} v${d.version}（${d.status}）`])], dsId, (v) => go({ ds: v })),
      '盤查邊界', select([['', '（未選）'], ...boundaries.map((b) => [b.id, `${b.name}（${b.kind}）`])], bnd, (v) => go({ bnd: v }))),
    note('這些段落會自動放進「組織溫室氣體盤查報告書」；狀態不是「實測」的段落會在送審時被擋下。'),
    Object.entries(T).map(([k, t]) => card(t, blocks[k] ? h('div', chip(blocks[k].state === 'measured' ? '完整' : '待補', blocks[k].state === 'measured' ? 'ok' : 'warn'), blockView(blocks[k])) : '—')));
}

async function profileTab(orgId) {
  const d = await get('org-profile', { orgId });
  const w = can('report.write', orgId);
  const groups = d.groups || { ghg: '盤查報告說明' };
  const fields = [];
  for (const [g, title] of Object.entries(groups)) {
    const list = Object.values(d.fields).filter((f) => (f.group || 'ghg') === g);
    if (!list.length) continue;
    fields.push({ type: 'heading', label: title });
    for (const f of list) fields.push({ key: f.key, label: f.label, type: f.options ? 'select' : f.short ? 'text' : 'textarea', options: f.options, required: !!f.options, wide: !f.short, hint: [f.hint, f.default ? `沒填時使用：${f.default}` : ''].filter(Boolean).join('；'), readonly: !w });
  }
  const f = form(fields, d.data);
  return card('院所基本資料', note('盤查報告、能源查核申報、環境部盤查登錄每年都要寫的資料，填一次之後自動帶入；個別報告仍可另外改寫。'), f.el,
    w ? h('div', { class: 'pf-actions' }, action('儲存', async () => { const v = f.read(); if (!v) return; await api('org-profile', { method: 'PUT', body: { orgId, data: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || ''])) } }); toast('已儲存'); }, 'primary')) : null);
}

