// 資料來源探索與知識庫（PRD §6.2、§11）＋佐證文件庫（M05）
import { state, get, post, patch, upload, h, route, page, card, table, link, chip, domainChip, ownerChip, fmtTime, fmtDate, action, btn, go, form, formModal, toast, can,
  setQuery, searchBox, select, needOrg, render, note, dl, tabs, userOptions, assetTypeName } from '../core.js';

export function register() {
  route('/sources', sources, { title: '資料來源與追查' });
  route('/sources/search/:id', searchDetail, { title: '來源追查' });
  route('/evidence', evidence, { title: '佐證文件庫' });
}

const ST = { open: ['待處理', 'todo'], asking: ['詢問中', 'info'], referred: ['已轉介', 'info'], escalated: ['已移交統籌', 'warn'], found: ['已找到', 'ok'], closed: ['已結案', ''] };
const stChip = (s) => chip(...(ST[s] || [s, '']));
const OUTCOME = { pending: '待回覆', answered: '已回覆', referred: '轉介他人', no_answer: '沒有回應', not_holder: '不是保管者', found: '找到了' };

async function sources(_, qy) {
  const orgId = needOrg();
  const tab = qy.tab || (qy.q || qy.assetId ? 'find' : 'tasks');
  const T = (k, l) => [`#/sources?tab=${k}${qy.assetId ? `&assetId=${qy.assetId}` : ''}`, l];
  let body;
  if (tab === 'find') body = await findTab(orgId, qy);
  else if (tab === 'list') body = await listTab(orgId);
  else if (tab === 'knowledge') body = await knowledgeTab(orgId);
  else if (tab === 'contacts') body = await contactsTab(orgId);
  else body = await tasksTab(orgId, qy);
  return page('資料來源與追查', { intro: '不知道負責單位也能開始：輸入要找的資料，系統列出可能的帳單、設備、合約、系統與去年的經驗；系統建議一律只是「候選」。' },
    tabs([T('tasks', '追查任務'), T('find', '找線索'), T('list', '資料來源'), T('knowledge', '來源知識庫'), T('contacts', '聯絡窗口')], `#/sources?tab=${tab}${qy.assetId ? `&assetId=${qy.assetId}` : ''}`), body);
}

async function tasksTab(orgId, qy) {
  const rows = await get('source-search-tasks', { orgId, all: qy.all ? '1' : '', mine: qy.mine ? '1' : '' });
  return card(null, h('div', { class: 'pf-bar' },
    h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: !!qy.mine, onchange: (e) => setQuery({ mine: e.target.checked ? '1' : '' }) }), ' 只看我的'),
    h('label', { class: 'pf-small' }, h('input', { type: 'checkbox', checked: !!qy.all, onchange: (e) => setQuery({ all: e.target.checked ? '1' : '' }) }), ' 含已結案'),
    h('div', { class: 'grow' }), can('search.write') ? action('＋建立追查', () => newTask(orgId, {})) : null),
  table([{ label: '要找的資料', render: (t) => link(`#/sources/search/${t.id}`, t.keyword) }, { label: '標的', render: (t) => (t.asset_id ? link(`#/assets/${t.asset_id}`, t.asset_name) : '—') },
    { label: '狀態', render: (t) => stChip(t.status) }, { label: '承辦', key: 'assignee_name' }, { label: '統籌', key: 'coordinator_name' }, { label: '詢問次數', key: 'inquiry_count', num: true },
    { label: '截止', key: 'due_date' }, { label: '建立', render: (t) => fmtDate(t.created_at) }], rows, { empty: '沒有追查任務', onRow: (t) => go(`#/sources/search/${t.id}`) }));
}

async function newTask(orgId, init) {
  const [users, assets] = await Promise.all([userOptions(orgId), get('assets', { orgId })]);
  await formModal('建立來源追查', [
    { key: 'keyword', label: '要找的資料（例：柴油、冷媒補充、水費）', required: true, wide: true },
    { key: 'assetId', label: '相關標的', type: 'select', options: assets.map((a) => [a.id, `${a.name}（${assetTypeName(a.asset_type)}）`]) },
    { key: 'description', label: '說明', type: 'textarea', wide: true },
    { key: 'assignee', label: '承辦（預設自己）', type: 'select', options: users }, { key: 'coordinator', label: '統籌人', type: 'select', options: users },
    { key: 'dueDate', label: '截止日', type: 'date' },
  ], init, async (v) => { const r = await post('source-search-tasks', { ...v, orgId }); toast('已建立'); go(`#/sources/search/${r.id}`); }, '建立');
}

function suggestionView(s, { onPickSource } = {}) {
  return h('div', { class: 'pf-cols' },
    card('可能的盤點項目與常見證據（候選）', s.items.length ? s.items.map((i) => h('div', { class: 'pf-note' }, domainChip(i.domain), ' ', h('b', `${i.code} ${i.name}`),
      i.source_hints?.length ? h('div', '常見來源：', i.source_hints.join('、')) : null, i.required_data?.length ? h('div', { class: 'pf-small' }, '需要：', i.required_data.join('、')) : null)) : h('p', { class: 'muted' }, '字典沒有對應項目')),
    card('建議追查路徑', s.path.length ? h('ol', s.path.map((p) => h('li', p.step, ' ', chip('候選', 'info')))) : h('p', { class: 'muted' }, '—')),
    card('本院已有的相關標的', table([{ label: '標的', render: (a) => link(`#/assets/${a.id}`, a.name) }, { label: '面向', render: (a) => domainChip(a.domain) }, { label: '位置', key: 'location' }, { label: '保管者', render: (a) => ownerChip(a.owner_status) }], s.assets, { empty: '沒有' })),
    card('本院已有的資料來源', table([{ label: '來源', key: 'name' }, { label: '類型', key: 'source_type' }, { label: '位置', key: 'location' }, { label: '保管者', render: (x) => ownerChip(x.owner_status) },
      onPickSource ? { label: '', render: (x) => action('就是這個', () => onPickSource(x)) } : null].filter(Boolean), s.sources, { empty: '沒有' })),
    card('相關窗口', table([{ label: '窗口', key: 'name' }, { label: '單位', key: 'unit' }, { label: '關係', key: 'relation' }], s.contacts, { empty: '沒有' })),
    card('來源知識庫（去年怎麼找到的）', table([{ label: '證據', key: 'evidence_kind' }, { label: '在哪裡', key: 'where_found' }, { label: '怎麼找到', key: 'how_found' }, { label: '年度', key: 'year' },
      { label: '可信度', render: (k) => chip(k.confidence === 'verified' ? '已確認' : '候選', k.confidence === 'verified' ? 'ok' : 'info') }, { label: '', render: (k) => (k.own ? '' : chip('他院經驗')) }], s.knowledge, { empty: '還沒有經驗紀錄' })),
    card('相關佐證檔', table([{ label: '檔案', key: 'filename' }, { label: '類型', key: 'kind' }, { label: '上傳', render: (e) => fmtDate(e.uploaded_at) }], s.evidence, { empty: '沒有' })));
}

async function findTab(orgId, qy) {
  const kw = qy.q || '';
  const s = kw ? await get('source-suggest', { orgId, q: kw }) : null;
  return h('div', card(null, h('div', { class: 'pf-bar' }, searchBox(kw, (v) => setQuery({ q: v, tab: 'find' }), '輸入要找的資料，例如：柴油、冷媒、水費、電號'),
    can('search.write') && kw ? action('以此建立追查', () => newTask(orgId, { keyword: kw, assetId: qy.assetId })) : null)),
  s ? suggestionView(s) : note('輸入關鍵字開始找線索。'));
}

async function listTab(orgId) {
  const rows = await get('data-sources', { orgId });
  return card(null, table([{ label: '來源', key: 'name' }, { label: '標的', render: (s) => (s.asset_id ? link(`#/assets/${s.asset_id}?tab=sources`, s.asset_name) : '—') },
    { label: '類型', key: 'source_type' }, { label: '取得', key: 'acquisition' }, { label: '優先序', key: 'priority', num: true }, { label: '位置', key: 'location' },
    { label: '保管者', render: (s) => (s.contacts.length ? s.contacts.map((c) => chip(`${c.name}·${{ candidate: '候選', custodian: '保管者', deputy: '代理', provider: '提供' }[c.relation]}`, c.relation === 'custodian' ? 'ok' : 'info')) : ownerChip(s.owner_status)) }],
  rows, { empty: '沒有資料來源' }));
}

async function knowledgeTab(orgId) {
  const rows = await get('knowledge', { orgId });
  return card(null, h('div', { class: 'pf-bar' }, h('div', { class: 'grow' }), can('search.write') ? action('＋新增經驗', () => formModal('新增來源經驗', [
    { key: 'keyword', label: '關鍵字' }, { key: 'evidenceKind', label: '證據種類（帳單、維修單、油槽量測…）', required: true }, { key: 'whereFound', label: '在哪裡找到' },
    { key: 'howFound', label: '怎麼找到（誰轉介、哪個系統）', type: 'textarea', wide: true }, { key: 'year', label: '年度', type: 'number', default: state.year }], {}, async (v) => {
    await post('knowledge', { ...v, orgId }); toast('已新增'); render(); })) : null),
  table([{ label: '項目', key: 'item_name' }, { label: '關鍵字', key: 'keyword' }, { label: '證據', key: 'evidence_kind' }, { label: '在哪裡', key: 'where_found' }, { label: '怎麼找到', key: 'how_found' },
    { label: '來源', key: 'source_name' }, { label: '年度', key: 'year' }, { label: '可信度', render: (k) => chip(k.confidence === 'verified' ? '已確認' : '候選', k.confidence === 'verified' ? 'ok' : 'info') }], rows, { empty: '還沒有經驗紀錄；追查結案時會自動寫入' }));
}

async function contactsTab(orgId) {
  const rows = await get('contacts', { orgId });
  const edit = (c = {}) => formModal(c.id ? '編輯窗口' : '新增窗口', [{ key: 'name', label: '姓名或單位窗口', required: true }, { key: 'unit', label: '單位' }, { key: 'title', label: '職稱' },
    { key: 'phone', label: '電話' }, { key: 'email', label: 'Email' }, { key: 'note', label: '備註', type: 'textarea', wide: true }], c, async (v) => { await post('contacts', { ...v, id: c.id, orgId }); toast('已儲存'); render(); });
  return card(null, note('聯絡資訊屬個資：沒有「檢視敏感欄位」權限的人只看得到姓名與單位。'), h('div', { class: 'pf-bar' }, h('div', { class: 'grow' }), can('source.write') ? action('＋新增窗口', () => edit()) : null),
    table([{ label: '姓名', key: 'name' }, { label: '單位', key: 'unit' }, { label: '職稱', key: 'title' }, { label: '電話', key: 'phone' }, { label: 'Email', key: 'email' },
      { label: '', render: (c) => (can('source.write') ? action('編輯', () => edit(c)) : '') }], rows, { empty: '沒有窗口' }));
}

async function searchDetail({ id }) {
  const t = await get(`source-search-tasks/${id}`);
  const open = !['found', 'closed'].includes(t.status);
  const w = can('search.write', t.org_id) && open;
  const contacts = w ? await get('contacts', { orgId: t.org_id }) : [];
  const users = w ? await userOptions(t.org_id) : [];
  const ask = () => formModal('記錄一次詢問', [
    { key: 'contactId', label: '詢問對象（既有窗口）', type: 'select', options: contacts.map((c) => [c.id, `${c.name}${c.unit ? `（${c.unit}）` : ''}`]) },
    { key: 'contactName', label: '或直接填對象（單位、姓名）' }, { key: 'channel', label: '方式（電話、公文、Email、當面）' },
    { key: 'question', label: '詢問內容', type: 'textarea', required: true, wide: true }], {}, async (v) => { await post(`source-search-tasks/${id}/inquiries`, v); toast('已記錄'); render(); });
  const answer = (iq) => formModal('記錄回覆', [
    { key: 'outcome', label: '結果', type: 'select', required: true, options: Object.entries(OUTCOME).filter(([k]) => k !== 'pending') },
    { key: 'answer', label: '回覆內容', type: 'textarea', wide: true }, { key: 'referredToName', label: '轉介給（單位、姓名）' }], {}, async (v) => { await post(`inquiries/${iq.id}/answer`, v); toast('已記錄'); render(); });
  const resolve = (pre = {}) => formModal('找到來源', [
    { key: 'sourceName', label: '資料來源名稱', required: !pre.sourceId, default: pre.name }, { key: 'sourceType', label: '類型', type: 'select', required: true, options: [['bill', '帳單'], ['ems', 'EMS'], ['api', 'API'], ['file', '檔案'], ['manual', '人工抄表'], ['document', '文件'], ['system', '院內系統'], ['contract', '契約'], ['record', '紀錄表']] },
    { key: 'location', label: '文件或系統所在位置' }, { key: 'contactName', label: '保管者（姓名或單位窗口）' }, { key: 'contactUnit', label: '保管者單位' },
    { key: 'confirmed', label: '已向本人確認是保管者（未確認就記為候選窗口）', type: 'checkbox' }, { key: 'validFrom', label: '保管生效日', type: 'date' },
    { key: 'howFound', label: '怎麼找到的（寫入知識庫，明年可以直接用）', type: 'textarea', wide: true }], { sourceType: pre.source_type || 'record' }, async (v) => {
    await post(`source-search-tasks/${id}/resolve`, { sourceId: pre.sourceId, source: pre.sourceId ? undefined : { name: v.sourceName, sourceType: v.sourceType, location: v.location },
      contact: v.contactName ? { name: v.contactName, unit: v.contactUnit } : undefined, confirmed: v.confirmed, validFrom: v.validFrom, howFound: v.howFound, whereFound: v.location, evidenceKind: v.sourceType });
    toast('已結案並寫入知識庫'); render();
  }, '結案');
  return page(`追查：${t.keyword}`, { crumbs: [['#/sources', '資料來源與追查'], t.keyword] },
    card(null, dl([['狀態', stChip(t.status)], ['標的', t.asset_id ? link(`#/assets/${t.asset_id}`, '開啟標的') : '—'], ['說明', t.description], ['截止', t.due_date], ['建立', fmtTime(t.created_at)]]),
      w ? h('div', { class: 'pf-actions' }, action('記錄詢問', ask, 'primary'), action('找到了', () => resolve()),
        action('移交統籌人', () => formModal('移交統籌人協調', [{ key: 'coordinator', label: '統籌人', type: 'select', options: users, required: true }, { key: 'note', label: '說明', type: 'textarea', wide: true }], {},
          async (v) => { await post(`source-search-tasks/${id}/escalate`, v); toast('已移交'); render(); }, '移交')),
        action('結案（找不到／不需要）', () => formModal('結案', [{ key: 'note', label: '原因', required: true, wide: true }], {}, async (v) => { await post(`source-search-tasks/${id}/close`, v); render(); }, '結案'), 'ghost')) : null),
    card('詢問與轉介紀錄', t.inquiries.length ? h('ul', { class: 'pf-timeline' }, t.inquiries.map((iq) => h('li', h('time', `${fmtTime(iq.asked_at)}｜${iq.actor_name || ''}${iq.channel ? `｜${iq.channel}` : ''}`),
      h('div', `問 ${iq.contact_name || '窗口'}：${iq.question}`), iq.answered_at ? h('div', chip(OUTCOME[iq.outcome], iq.outcome === 'found' ? 'ok' : 'info'), ' ', iq.answer || '', iq.referred_to_name ? `（轉介：${iq.referred_to_name}）` : '') :
        w ? action('記錄回覆', () => answer(iq)) : chip('待回覆', 'todo')))) : h('p', { class: 'muted' }, '還沒有詢問紀錄')),
    h('h2', '線索'), suggestionView(t.suggestions, w ? { onPickSource: (s) => resolve({ sourceId: s.id, name: s.name, source_type: s.source_type }) } : {}));
}

// ── 佐證文件庫 ──
const CONF = { public: ['公開', ''], internal: ['內部', 'info'], restricted: ['限閱', 'warn'], secret: ['機密', 'alert'] };
async function evidence(_, qy) {
  const orgId = needOrg();
  const rows = await get('evidence', { orgId, q: qy.q, assetId: qy.assetId });
  const up = form([{ key: 'file', label: '檔案（PDF、圖片、Excel、CSV、Word；上限 25 MB）', type: 'file', required: true, wide: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.ods,.csv,.docx,.txt' },
    { key: 'confidentiality', label: '機敏等級', type: 'select', required: true, options: Object.entries(CONF).map(([k, [l]]) => [k, l]) }, { key: 'kind', label: '種類（電費單、維修單、銘牌照片…）' }, { key: 'note', label: '說明' }],
  { confidentiality: 'internal' });
  return page('佐證文件庫', { intro: '原始檔以內容雜湊保存，寫入後不可覆寫；每次下載都會留紀錄。' },
    can('obs.write') ? card('上傳佐證', up.el, h('div', { class: 'pf-actions' }, action('上傳', async () => {
      const v = up.read(); if (!v) return;
      const r = await upload('evidence', { orgId, confidentiality: v.confidentiality, kind: v.kind, note: v.note }, v.file);
      toast(r.duplicate ? '同一份檔案已存在（以雜湊比對），未重複保存' : '已上傳'); render();
    }, 'primary'))) : null,
    card(null, h('div', { class: 'pf-bar' }, searchBox(qy.q || '', (v) => setQuery({ q: v }), '搜尋檔名、種類、說明')),
      table([{ label: '檔案', render: (e) => (e.canOpen ? h('a', { href: `/api/v1/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, e.filename) : h('span', e.filename, ' ', chip('無權開啟'))) },
        { label: '種類', key: 'kind' }, { label: '機敏', render: (e) => chip(...(CONF[e.confidentiality] || [e.confidentiality])) }, { label: '標的', render: (e) => (e.asset_id ? link(`#/assets/${e.asset_id}`, e.asset_name) : '—') },
        { label: '病毒掃描', render: (e) => chip(...({ clean: ['通過', 'ok'], not_scanned: ['未掃描', 'todo'], error: ['掃描失敗', 'warn'] }[e.scan_status] || [e.scan_status || '未掃描', 'todo'])) },
        { label: '被引用', render: (e) => `${e.obs_count} 筆觀測` }, { label: '大小', render: (e) => `${Math.round(e.size / 1024)} KB` }, { label: '雜湊', render: (e) => h('span', { class: 'pf-mono', title: e.sha256 }, e.sha256.slice(0, 12)) },
        { label: '上傳', render: (e) => `${e.uploaded_by_name || ''} ${fmtDate(e.uploaded_at)}` },
        { label: '', render: (e) => (can('obs.write', e.org_id) ? action('等級', () => formModal('調整機敏等級', [{ key: 'confidentiality', label: '機敏等級', type: 'select', required: true, options: Object.entries(CONF).map(([k, [l]]) => [k, l]) },
          { key: 'note', label: '說明' }], e, async (v) => { await patch(`evidence/${e.id}`, v); toast('已更新'); render(); })) : '') }], rows, { empty: '沒有佐證' })));
}
