// 標的台帳（PRD §7.2）、標的詳細、數據檢視與版本
import { state, get, post, patch, del, h, route, page, card, table, link, chip, domainChip, workChip, ownerChip, applicChip, valueStateChip, qualityChip, sevChip,
  fmtNum, fmtPeriod, fmtTime, fmtDate, action, btn, go, form, formModal, modal, confirmBox, toast, can, setQuery, searchBox, select, needOrg, render, note, dl, tabs,
  metricName, metricOf, itemOf, assetTypeName, itemOptions, metricOptions, userOptions, download } from '../core.js';

export function register() {
  route('/assets', list, { title: '標的台帳' });
  route('/assets/new', create, { title: '新增標的' });
  route('/assets/:id', detail, { title: '標的詳細' });
  route('/observations', observations, { title: '數據檢視與版本' });
  route('/observations/:id', observationDetail, { title: '觀測值詳細' });
}

const DOMAIN4 = ['oil', 'water', 'electricity', 'gas', 'activity'];

async function list(_, qy) {
  const orgId = needOrg();
  const f = { domain: qy.domain, workStatus: qy.workStatus, applicability: qy.applicability, ownerStatus: qy.ownerStatus, q: qy.q, includeDisabled: qy.all ? '1' : '' };
  const rows = await get('assets', { orgId, ...f });
  const bar = h('div', { class: 'pf-bar' },
    select([['', '全部面向'], ...DOMAIN4.map((d) => [d, state.meta.domains[d].name])], f.domain, (v) => setQuery({ domain: v }), { 'aria-label': '面向' }),
    select([['', '全部進度'], ...Object.entries(state.meta.workStatus)], f.workStatus, (v) => setQuery({ workStatus: v }), { 'aria-label': '進度' }),
    select([['', '全部適用性'], ...Object.entries(state.meta.applicability)], f.applicability, (v) => setQuery({ applicability: v }), { 'aria-label': '適用性' }),
    select([['', '全部保管者狀態'], ['unknown', '保管者未知'], ['candidate', '候選窗口'], ['confirmed', '已確認']], f.ownerStatus, (v) => setQuery({ ownerStatus: v }), { 'aria-label': '保管者' }),
    searchBox(f.q || '', (v) => setQuery({ q: v }), '搜尋名稱、識別碼、位置'),
    h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: !!qy.all, onchange: (e) => setQuery({ all: e.target.checked ? '1' : '' }) }), ' 含已封存'));
  return page('標的台帳', {
    intro: '一物一碼：電號、水號、油槽、表計、設備各建一筆。未知負責人也可以先建檔。',
    actions: [can('asset.write') ? btn('＋新增標的', () => go('#/assets/new'), 'primary') : null,
      can('import.write') ? btn('批次匯入標的', () => go('#/imports?kind=assets')) : null],
  }, bar, table([
    { label: '面向', render: (a) => domainChip(a.domain) },
    { label: '項目', render: (a) => a.item_name || '—' },
    { label: '名稱', render: (a) => link(`#/assets/${a.id}`, a.name) },
    { label: '類型', render: (a) => assetTypeName(a.asset_type) },
    { label: '識別碼', render: (a) => a.external_key || '—' },
    { label: '位置', render: (a) => [a.building_name, a.location, a.floor].filter(Boolean).join(' ') || '—' },
    { label: '適用性', render: (a) => applicChip(a.applicability) },
    { label: '進度', render: (a) => workChip(a.work_status) },
    { label: '保管者', render: (a) => a.owner_name || ownerChip(a.owner_status) },
    { label: '成果', render: (a) => (a.usage_count ? chip(`支援 ${a.usage_count} 項`, 'ok') : '—') },
    { label: '狀態', render: (a) => (a.status === 'active' ? '' : chip({ draft: '草稿', disabled: '停用', archived: '封存' }[a.status] || a.status)) },
  ], rows, { empty: '沒有符合條件的標的', onRow: (a) => go(`#/assets/${a.id}`) }));
}

function assetFields(a = {}, { sites = [], parents = [], users = [] } = {}) {
  const item = itemOf(a.item_id || a.itemId);
  const types = item?.asset_types?.length ? item.asset_types : Object.keys(state.meta.assetTypes);
  const buildings = sites.flatMap((s) => s.buildings.map((b) => [b.id, `${s.name}／${b.name}`]));
  return [
    { key: 'itemId', label: '盤點項目', type: 'select', options: itemOptions(['oil', 'water', 'electricity', 'gas', 'activity']), required: true, wide: true, readonly: !!a.id },
    { key: 'assetType', label: '標的類型', type: 'select', options: types.map((t) => [t, assetTypeName(t)]), required: true },
    { key: 'name', label: '標的名稱', required: true },
    { key: 'externalKey', label: '識別碼（電號、水號、車牌、資產編號）', hint: '同院區同類型不可重複' },
    { key: 'externalKeySensitive', label: '識別碼屬敏感資訊（電號、帳號）', type: 'checkbox' },
    { key: 'siteId', label: '院區', type: 'select', options: sites.map((s) => [s.id, s.name]) },
    { key: 'buildingId', label: '建物', type: 'select', options: buildings },
    { key: 'location', label: '位置說明' }, { key: 'floor', label: '樓層' },
    { key: 'meterMultiplier', label: '表計倍率', type: 'number', default: 1 },
    { key: 'parentAssetId', label: '上層標的（總表、共用油槽）', type: 'select', options: parents },
    { key: 'shared', label: '共用（例：多台發電機共用油槽）', type: 'checkbox' }, { key: 'leased', label: '租賃設備', type: 'checkbox' },
    { key: 'ownerUserId', label: '實際保管者（可空）', type: 'select', options: users, hint: '不知道就留空，之後用來源追查找' },
    { key: 'dueDate', label: '截止日', type: 'date' }, { key: 'nextStep', label: '下一步說明' },
    { key: 'attrs', label: '專屬欄位（JSON；例：{"fuel":"diesel"}、{"refrigerant":"R-410A"}、{"rolloverAt":99999}）', type: 'json', wide: true },
  ];
}

async function create(_, qy) {
  const orgId = needOrg();
  const [sites, parents, users] = await Promise.all([get(`orgs/${orgId}/sites`), get('assets', { orgId }), userOptions(orgId)]);
  const f = form(assetFields({}, { sites, parents: parents.map((p) => [p.id, `${p.name}（${assetTypeName(p.asset_type)}）`]), users }), { itemId: qy.itemId, siteId: sites[0]?.id, meterMultiplier: 1, attrs: {} });
  // 選了項目就更新類型選單與提示
  const hint = h('div');
  const refresh = () => {
    const it = itemOf(f.inputs.itemId.value);
    const sel = f.inputs.assetType; const cur = sel.value;
    sel.replaceChildren(...(it?.asset_types?.length ? it.asset_types : Object.keys(state.meta.assetTypes)).map((t) => h('option', { value: t }, assetTypeName(t))));
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    hint.replaceChildren(it ? itemCard(it) : '');
  };
  f.inputs.itemId.addEventListener('change', refresh); refresh();
  return page('新增標的', { crumbs: [['#/assets', '標的台帳'], '新增'] },
    card('基本資訊', f.el, hint, h('div', { class: 'pf-actions' }, action('儲存', async () => {
      const v = f.read(); if (!v) return;
      const it = itemOf(v.itemId);
      const r = await post('assets', { ...v, orgId, domain: it?.domain });
      toast('已建立'); go(`#/assets/${r.id}`);
    }, 'primary'), btn('取消', () => history.back(), 'ghost'))));
}

function itemCard(it) {
  return h('div', { class: 'pf-note' },
    h('b', `${it.code} ${it.name}`),
    it.required_data?.length ? h('div', '需要的資料：', it.required_data.join('、')) : null,
    it.source_hints?.length ? h('div', '常見來源：', it.source_hints.join('、')) : null,
    it.special_rules?.length ? h('div', '特殊規則：', it.special_rules.join('；')) : null,
    it.ghg_ref ? h('div', `盤查參照：範疇 ${it.ghg_ref.scope}、${it.ghg_ref.iso}（是否納入依報告邊界判定）`) : null);
}

async function detail({ id }, qy) {
  const d = await get(`assets/${id}`, { year: state.year });
  const a = d.asset;
  const tab = qy.tab || 'overview';
  const orgId = a.org_id;
  const T = (k, l) => [`#/assets/${id}?tab=${k}`, l];
  const usageN = d.usage.length;
  const header = h('div', { class: 'pf-card' },
    h('div', { class: 'pf-bar' }, domainChip(a.domain), applicChip(a.applicability), workChip(a.work_status), a.owner_user_id ? chip('已確認保管者', 'ok') : ownerChip(a.owner_status),
      a.status !== 'active' ? chip({ draft: '草稿', disabled: '已停用', archived: '已封存' }[a.status]) : null, h('div', { class: 'grow' }),
      h('a', { class: 'pf-chip ok', href: `#/assets/${id}?tab=usage` }, `這項盤點已支援 ${usageN} 項成果`)),
    dl([['盤點項目', d.item ? `${d.item.code} ${d.item.name}` : '—'], ['類型', assetTypeName(a.asset_type)], ['識別碼', a.external_key || '—'],
      ['位置', [a.location, a.floor].filter(Boolean).join(' ') || '—'], ['表計倍率', a.meter_multiplier], ['共用／租賃', [a.shared ? '共用' : '', a.leased ? '租賃' : ''].filter(Boolean).join('、') || '否'],
      ['資料完整度', `${d.completeness.covered}/${d.completeness.required} 項必要指標有 ${state.year} 年資料`], ['專屬欄位', Object.keys(a.attrs || {}).length ? JSON.stringify(a.attrs) : '—']]),
    h('div', { class: 'pf-actions' },
      can('obs.write', orgId) ? btn('📱 登錄數據', () => go(`#/collect/${id}`), 'primary') : null,
      can('asset.write', orgId) ? action('編輯', () => editAsset(a)) : null,
      can('asset.applicability', orgId) ? action('判定適用性', () => judge(a)) : null,
      can('asset.applicability.approve', orgId) && a.applicability === 'not_applicable' && !a.applicability_approved_by ? action('核准不適用', async () => {
        await post(`assets/${id}/applicability/approve`, { approve: true }); toast('已核准'); render(); }) : null,
      can('search.write', orgId) ? btn('🔎 尋找來源', () => go(`#/sources?assetId=${id}&q=${encodeURIComponent(d.item?.name || a.name)}`)) : null,
      can('asset.write', orgId) ? action('複製為新標的', async () => { const r = await post(`assets/${id}/clone`, {}); toast('已複製'); go(`#/assets/${r.id}`); }) : null,
      can('asset.write', orgId) && a.status === 'active' ? action('停用', () => disable(a), 'danger-btn') : null,
      btn('QR Code', () => modal('標的 QR Code', h('div', h('img', { src: `/api/v1/assets/${id}/qr.png`, alt: `${a.name} 的 QR Code，掃描後開啟現場盤點`, style: 'width:20rem;max-width:100%' }),
        h('p', { class: 'muted' }, '貼在設備或表計旁；掃描後直接開這個標的的現場盤點頁。')), { okText: null, cancelText: '關閉' }))),
    a.applicability === 'not_applicable' ? note(`判定不適用：${a.applicability_reason || ''}${a.applicability_approved_by ? '（已核准）' : '（待另一位審核者核准）'}`, a.applicability_approved_by ? '' : 'warn') : null,
    d.item?.special_rules?.length ? note(`特殊規則：${d.item.special_rules.join('；')}`) : null);

  let body;
  if (tab === 'overview') body = await overviewTab(d);
  else if (tab === 'data') body = await dataTab(a, d);
  else if (tab === 'sources') body = sourcesTab(a, d);
  else if (tab === 'links') body = linksTab(a, d);
  else if (tab === 'usage') body = usageTab(d);
  else body = historyTab(d);

  return page(a.name, { crumbs: [['#/assets', '標的台帳'], a.name] }, header,
    tabs([T('overview', '概況'), T('data', '觀測值'), T('sources', `來源與保管者（${d.sources.length}）`), T('links', `上下層（${d.links.length}）`), T('usage', `成果用途（${usageN}）`), T('history', '異動歷程')], `#/assets/${id}?tab=${tab}`), body);
}

const stLabel = (axis, v) => {
  if (!v) return '—';
  const base = String(v).replace('(approved)', '');
  const t = (axis === 'applicability' ? state.meta.applicability : state.meta.workStatus)[base] || base;
  return v.includes('(approved)') ? `${t}（已核准）` : t;
};

async function overviewTab(d) {
  const a = d.asset;
  return h('div', { class: 'pf-cols' },
    card('差異案件', table([{ label: '嚴重度', render: (c) => sevChip(c.severity) }, { label: '摘要', render: (c) => link(`#/quality/cases/${c.id}`, c.summary) },
      { label: '狀態', render: (c) => state.meta.caseStatus[c.status] }], d.cases, { empty: '沒有差異案件' })),
    card('來源追查', table([{ label: '關鍵字', render: (t) => link(`#/sources/search/${t.id}`, t.keyword) }, { label: '狀態', key: 'status' }, { label: '承辦', key: 'assignee_name' }], d.searchTasks, { empty: '沒有追查任務' })),
    card('資料需求', d.item ? h('div', h('p', '指標：', (d.item.metrics || []).map((m) => chip(metricName(m))).reduce((acc, x) => [...acc, x, ' '], [])),
      d.item.required_data?.length ? h('p', '需要的資料：', d.item.required_data.join('、')) : null,
      d.item.source_hints?.length ? h('p', '常見來源：', d.item.source_hints.join('、')) : null,
      h('p', h('a', { href: `#/quality/compare/${a.id}?metric=${(d.item.metrics || [])[0] || ''}` }, '多來源比對 →'))) : h('p', { class: 'muted' }, '未連結盤點項目')),
    card('進度事件', h('ul', { class: 'pf-timeline' }, d.work.slice(0, 12).map((w) => h('li', h('time', fmtTime(w.at)), `${w.axis === 'applicability' ? '適用性' : '進度'}：${stLabel(w.axis, w.from_status)} → ${stLabel(w.axis, w.to_status)}`, w.note ? h('div', { class: 'muted pf-small' }, w.note) : null)))));
}

async function dataTab(a) {
  const obs = await get('observations', { assetId: a.id, includeSuperseded: '0' });
  return card('觀測值', h('div', { class: 'pf-bar' }, link(`#/observations?assetId=${a.id}`, '完整檢視（含已取代版本）'), h('div', { class: 'grow' }),
    can('obs.write', a.org_id) ? btn('登錄數據', () => go(`#/collect/${a.id}`), 'primary') : null), obsTable(obs));
}

export function obsTable(obs) {
  return table([
    { label: '指標', render: (o) => link(`#/observations/${o.id}`, o.metric_name || metricName(o.metric_code)) },
    { label: '期間', render: (o) => fmtPeriod(o.period_start, o.period_end) },
    { label: '原始值', render: (o) => (o.masked ? chip('需權限') : o.raw_value === null ? valueStateChip(o.value_state) : `${o.raw_value} ${o.raw_unit}`) },
    { label: '標準值', num: true, render: (o) => (o.value_std === null ? '—' : `${fmtNum(o.value_std, 4)} ${o.std_unit}`) },
    { label: '值狀態', render: (o) => valueStateChip(o.value_state) },
    { label: '來源', render: (o) => o.source_name },
    { label: '取得方式', render: (o) => ({ api: '自動介接', import: '檔案匯入', manual: '人工', ocr: '辨識＋確認', legacy: '舊系統' }[o.method] || o.method) },
    { label: '佐證', render: (o) => (o.evidence_count ? chip(`${o.evidence_count} 份`, 'ok') : chip('無', 'warn')) },
    { label: '品質', render: (o) => qualityChip(o.quality_status) },
    { label: '版本', render: (o) => `v${o.version}` },
    { label: '提交', render: (o) => `${o.submitted_by_name || '系統'} ${fmtDate(o.submitted_at)}` },
  ], obs, { empty: '尚無觀測值' });
}

function sourcesTab(a, d) {
  return card('資料來源與保管者', h('div', { class: 'pf-bar' }, h('div', { class: 'grow' }),
    can('source.write', a.org_id) ? action('＋新增來源', () => sourceForm(a)) : null),
  table([
    { label: '來源', key: 'name' }, { label: '類型', key: 'source_type' }, { label: '取得方式', key: 'acquisition' }, { label: '優先序', key: 'priority', num: true },
    { label: '位置', key: 'location' }, { label: '頻率', key: 'frequency' },
    { label: '保管者', render: (s) => (s.contacts.length ? s.contacts.map((c) => chip(`${c.name}${c.unit ? `（${c.unit}）` : ''}·${{ candidate: '候選', custodian: '保管者', deputy: '代理', provider: '提供者' }[c.relation]}`, c.relation === 'custodian' ? 'ok' : 'info')) : ownerChip(s.owner_status)) },
    { label: '', render: (s) => (can('source.write', a.org_id) ? action('指定窗口', () => contactLink(a, s)) : '') },
  ], d.sources, { empty: '還沒有資料來源。不知道去哪裡找，請用「尋找來源」。' }));
}

async function sourceForm(a, s = {}) {
  await formModal('資料來源', [
    { key: 'name', label: '來源名稱（例：台電帳單、EMS、工務室抄表紀錄）', required: true, wide: true },
    { key: 'sourceType', label: '類型', type: 'select', required: true, options: [['bill', '帳單'], ['ems', 'EMS／智慧表'], ['api', 'API'], ['file', '檔案'], ['manual', '人工抄表'], ['document', '文件'], ['system', '院內系統'], ['contract', '契約'], ['record', '紀錄表']] },
    { key: 'acquisition', label: '取得方式', type: 'select', required: true, options: [['manual', '人工'], ['import', '檔案匯入'], ['api', '自動介接'], ['ocr', '辨識＋確認']] },
    { key: 'priority', label: '比對優先序（0–100，越高越作為比對基準）', type: 'number', default: 50 },
    { key: 'location', label: '文件或系統所在位置' }, { key: 'frequency', label: '更新頻率（月、季、年）' }, { key: 'note', label: '備註', type: 'textarea', wide: true },
  ], s, async (v) => { await post('data-sources', { ...v, id: s.id, orgId: a.org_id, assetId: a.id, itemId: a.item_id }); toast('已儲存'); render(); });
}

async function contactLink(a, s) {
  const contacts = await get('contacts', { orgId: a.org_id });
  await formModal(`指定「${s.name}」的窗口`, [
    { key: 'contactId', label: '既有窗口', type: 'select', options: contacts.map((c) => [c.id, `${c.name}${c.unit ? `（${c.unit}）` : ''}`]) },
    { key: 'newName', label: '或新增窗口姓名／單位窗口' }, { key: 'newUnit', label: '單位' }, { key: 'newPhone', label: '電話' }, { key: 'newEmail', label: 'Email' },
    { key: 'relation', label: '關係', type: 'select', required: true, options: [['candidate', '候選窗口（未確認）'], ['custodian', '確認的保管者'], ['deputy', '代理人'], ['provider', '提供者']] },
    { key: 'validFrom', label: '生效日', type: 'date' },
  ], { relation: 'candidate' }, async (v) => {
    let contactId = v.contactId;
    if (!contactId) { if (!v.newName) throw new Error('請選既有窗口或填新窗口'); contactId = (await post('contacts', { orgId: a.org_id, name: v.newName, unit: v.newUnit, phone: v.newPhone, email: v.newEmail })).id; }
    await post('source-contacts', { sourceId: s.id, contactId, relation: v.relation, validFrom: v.validFrom }); toast('已指定'); render();
  });
}

function linksTab(a, d) {
  return card('上下層關係', note('總表→分表、共用油槽→多台設備。同一統計口徑下不可把上下層直接相加。'),
    h('div', { class: 'pf-bar' }, h('div', { class: 'grow' }), can('asset.write', a.org_id) ? action('＋建立關係', () => linkForm(a)) : null),
    table([{ label: '上層', render: (l) => link(`#/assets/${l.parent_id}`, l.parent_name) }, { label: '關係', render: (l) => ({ submeter_of: '分表', feeds: '供應（油槽→設備）', supplies: '供應', part_of: '組成' }[l.relation]) },
      { label: '下層', render: (l) => link(`#/assets/${l.child_id}`, l.child_name) }, { label: '期間', render: (l) => `${l.valid_from === '1900-01-01' ? '' : l.valid_from}～${l.valid_to || ''}` },
      { label: '', render: (l) => (can('asset.write', a.org_id) && !l.valid_to ? action('結束', async () => { await del(`asset-links/${l.id}`); render(); }) : '') }], d.links, { empty: '沒有上下層關係' }));
}
async function linkForm(a) {
  const all = await get('assets', { orgId: a.org_id });
  const opts = all.filter((x) => x.id !== a.id).map((x) => [x.id, `${x.name}（${assetTypeName(x.asset_type)}）`]);
  await formModal('建立上下層關係', [
    { key: 'direction', label: '這個標的是', type: 'select', required: true, options: [['parent', '上層（例：總表、共用油槽）'], ['child', '下層（例：分表、發電機）']] },
    { key: 'other', label: '另一個標的', type: 'select', options: opts, required: true },
    { key: 'relation', label: '關係', type: 'select', required: true, options: [['submeter_of', '分表'], ['feeds', '油槽供應設備'], ['supplies', '供應'], ['part_of', '組成']] },
    { key: 'validFrom', label: '生效日', type: 'date' },
  ], { direction: 'parent' }, async (v) => {
    const [parentId, childId] = v.direction === 'parent' ? [a.id, v.other] : [v.other, a.id];
    await post('asset-links', { parentId, childId, relation: v.relation, validFrom: v.validFrom }); toast('已建立'); render();
  });
}

function usageTab(d) {
  return h('div', card('實際引用', table([
    { label: '成果', render: (u) => (u.report_case_id ? link(`#/reports/${u.report_case_id}`, u.usage_name) : u.usage_name) }, { label: '年度', key: 'year' },
    { label: '指標', render: (u) => u.indicators.join('、') || '—' }, { label: '狀態', render: (u) => chip(state.meta.usageStatus[u.status], u.status === 'published' ? 'ok' : 'info') },
    { label: '時間', render: (u) => fmtTime(u.used_at) }], d.usage, { empty: '尚未被成果實際引用' })),
  card('候選用途（尚未實際引用）', h('p', d.usageCandidates.map((u) => chip(u.name)).reduce((acc, x) => [...acc, x, ' '], [])), h('p', { class: 'muted pf-small' }, '候選用途只是可能的應用，不代表已經被使用。')));
}

function historyTab(d) {
  return card('異動歷程', h('ul', { class: 'pf-timeline' }, d.history.map((x) => h('li', h('time', `${fmtTime(x.at)}｜${x.actor_name || x.actor}`),
    `${{ create: '建立', update: '修改', disable: '停用' }[x.change_type] || x.change_type}${x.reason ? `：${x.reason}` : ''}`,
    x.change_type !== 'create' && x.after ? h('div', { class: 'pf-mono' }, Object.entries(x.after).map(([k, v]) => `${k}: ${JSON.stringify(x.before?.[k] ?? null)} → ${JSON.stringify(v)}`).join('\n')) : null))));
}

async function editAsset(a) {
  const [sites, parents, users] = await Promise.all([get(`orgs/${a.org_id}/sites`), get('assets', { orgId: a.org_id }), userOptions(a.org_id)]);
  const fields = [...assetFields(a, { sites, parents: parents.filter((p) => p.id !== a.id).map((p) => [p.id, p.name]), users }),
    { key: 'reason', label: '修改原因（已建檔的標的必填）', wide: true, required: a.status !== 'draft' },
    { key: 'status', label: '狀態', type: 'select', options: [['draft', '草稿'], ['active', '使用中'], ['disabled', '停用']] }];
  await formModal('編輯標的', fields, { itemId: a.item_id, assetType: a.asset_type, name: a.name, externalKey: a.masked ? '' : a.external_key, externalKeySensitive: !!a.external_key_sensitive,
    siteId: a.site_id, buildingId: a.building_id, location: a.location, floor: a.floor, meterMultiplier: a.meter_multiplier, parentAssetId: a.parent_asset_id, shared: !!a.shared, leased: !!a.leased,
    ownerUserId: a.owner_user_id, dueDate: a.due_date, nextStep: a.next_step, attrs: a.attrs, status: a.status }, async (v) => {
    const body = { ...v }; delete body.itemId; if (a.masked && !body.externalKey) delete body.externalKey;
    await patch(`assets/${a.id}`, body); toast('已儲存'); render();
  });
}

async function judge(a) {
  await formModal('判定適用性', [
    { key: 'applicability', label: '判定', type: 'select', required: true, options: Object.entries(state.meta.applicability) },
    { key: 'reason', label: '原因（不適用必填，將由另一位審核者核准）', type: 'textarea', wide: true },
  ], { applicability: a.applicability }, async (v) => { const r = await post(`assets/${a.id}/applicability`, v); toast(r.needsApproval ? '已送出，待審核者核准' : '已更新'); render(); });
}

async function disable(a) {
  await formModal(`停用「${a.name}」`, [{ key: 'reason', label: '停用原因（汰換、拆除、合併電號…）', required: true, wide: true }], {}, async (v) => {
    await post(`assets/${a.id}/disable`, v); toast('已停用，歷史資料保留'); render(); }, '停用');
}

// ── 數據檢視 ──
async function observations(_, qy) {
  const orgId = needOrg();
  const rows = await get('observations', { orgId, assetId: qy.assetId, metricCode: qy.metric, domain: qy.domain, status: qy.status, method: qy.method, includeSuperseded: qy.all ? '1' : '',
    from: `${state.year}-01-01`, to: `${state.year + 1}-01-01`, limit: 1000 });
  const bar = h('div', { class: 'pf-bar' },
    select([['', '全部面向'], ...DOMAIN4.map((d) => [d, state.meta.domains[d].name])], qy.domain, (v) => setQuery({ domain: v })),
    select([['', '全部指標'], ...metricOptions(qy.domain)], qy.metric, (v) => setQuery({ metric: v })),
    select([['', '全部品質'], ['pending_validation', '待檢核'], ['valid', '通過'], ['warning', '有警示'], ['invalid', '未通過'], ['superseded', '已取代']], qy.status, (v) => setQuery({ status: v })),
    select([['', '全部取得方式'], ['manual', '人工'], ['import', '匯入'], ['api', '介接'], ['ocr', '辨識'], ['legacy', '舊系統']], qy.method, (v) => setQuery({ method: v })),
    h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: !!qy.all, onchange: (e) => setQuery({ all: e.target.checked ? '1' : '' }) }), ' 含已取代版本'));
  return page('數據檢視與版本', { intro: `原始觀測值不可覆寫；修正會產生新版本，舊版保留。${state.year} 年度。` }, bar, obsTableWithAsset(rows));
}
function obsTableWithAsset(rows) {
  const t = obsTable(rows);
  // 在第一欄前加上標的名稱
  const head = t.querySelector('thead tr'); if (!head) return t;
  head.prepend(h('th', '標的'));
  [...t.querySelectorAll('tbody tr')].forEach((tr, i) => tr.prepend(h('td', link(`#/assets/${rows[i].asset_id}`, rows[i].asset_name))));
  return t;
}

async function observationDetail({ id }) {
  const o = await get(`observations/${id}`);
  const canFix = can('obs.write', o.org_id) && o.quality_status !== 'superseded';
  return page(`${metricName(o.metric_code)}｜${fmtPeriod(o.period_start, o.period_end)}`, { crumbs: [['#/observations', '數據檢視'], ['#/assets/' + o.asset_id, '標的'], '觀測值'] },
    card('原始觀測', dl([['原始值', o.raw_value === null ? '—' : `${o.raw_value} ${o.raw_unit}`], ['標準值', o.value_std === null ? '—' : `${fmtNum(o.value_std, 6)} ${o.std_unit}`],
      ['值狀態', valueStateChip(o.value_state)], ['讀值型態', o.reading_kind], ['表計事件', o.meter_event], ['倍率', o.meter_multiplier], ['來源紀錄鍵', h('span', { class: 'pf-mono' }, o.source_record_key)],
      ['取得方式', o.method], ['品質', qualityChip(o.quality_status)], ['計量邊界說明', o.boundary_note], ['備註', o.note], ['提交', fmtTime(o.submitted_at)]]),
    canFix ? h('div', { class: 'pf-actions' }, action('修正（建立新版本）', () => formModal('修正觀測值', [
      { key: 'rawValue', label: '新數值' }, { key: 'rawUnit', label: '單位', default: o.raw_unit },
      { key: 'valueState', label: '值狀態', type: 'select', options: Object.entries({ measured: '實測', zero: '實際為零', estimated: '估計', missing: '缺漏', not_applicable: '不適用', unknown: '未知' }) },
      { key: 'reason', label: '修正原因', required: true, wide: true }], { rawValue: o.raw_value, rawUnit: o.raw_unit, valueState: o.value_state }, async (v) => {
      const r = await post(`observations/${id}/correct`, v); toast(r.status === 'duplicate' ? '內容相同，未建立新版本' : '已建立新版本'); go(`#/observations/${r.id}`); }))) : null),
    h('div', { class: 'pf-cols' },
      card('版本', table([{ label: '版本', render: (v) => link(`#/observations/${v.id}`, `v${v.version}`) }, { label: '值', render: (v) => `${v.raw_value ?? '—'} ${v.raw_unit}` },
        { label: '品質', render: (v) => qualityChip(v.quality_status) }, { label: '時間', render: (v) => fmtTime(v.submitted_at) }, { label: '說明', key: 'note' }], o.versions)),
      card('分攤與差分（衍生值，不覆寫原始值）', table([{ label: '規則', key: 'rule_code' }, { label: '期間', render: (t) => fmtPeriod(t.period_start, t.period_end) }, { label: '值', num: true, render: (t) => fmtNum(t.value, 4) },
        { label: '方法', render: (t) => h('span', { class: 'pf-mono' }, JSON.stringify(t.method)) }], o.transforms, { empty: '原始期間即為自然月，無需分攤' })),
      card('佐證', table([{ label: '檔案', render: (e) => h('a', { href: `/api/v1/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, e.filename) }, { label: '機敏', key: 'confidentiality' }, { label: '頁', key: 'page' }], o.evidence, { empty: '沒有附佐證' })),
      card('檢核結果', table([{ label: '規則', key: 'rule_code' }, { label: '嚴重度', render: (r) => sevChip(r.severity) }, { label: '訊息', key: 'message' }, { label: '時間', render: (r) => fmtTime(r.started_at) }], o.validations, { empty: '尚未檢核' })),
      card('已成為採用值', table([{ label: '資料集', render: (f) => link(`#/datasets/${f.dataset_id}`, f.dataset_name) }, { label: '狀態', key: 'dataset_status' }, { label: '值', render: (f) => `${fmtNum(f.value)} ${f.unit}` }], o.facts, { empty: '尚未被採用' }))));
}
