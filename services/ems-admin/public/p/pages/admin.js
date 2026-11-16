// 系統管理（PRD §13.3、§14、§15、§17、§18、§19）：組織院區、帳號權限、資料字典、係數與規則、報告模板、
// 門檻設定、介接、歷史資料移轉、稽核日誌、備份還原。
// 版本化設定一律走「草稿 → 送審 → 另一位管理員核准發布 → 可回復」，畫面上不提供直接覆寫。
import { state, get, post, patch, del, upload, h, route, page, card, table, link, btn, action, toast, modal, confirmBox, formModal, form,
  chip, domainChip, fmtNum, fmtDate, fmtTime, fmtPeriod, inclEndToExcl, can, isGlobalAdmin, orgName, userOptions, tabs, dl, note, select,
  setQuery, render, needOrg, itemOf } from '../core.js';

export function register() {
  route('/admin/orgs', orgsPage, { title: '組織院區與邊界' });
  route('/admin/users', usersPage, { title: '帳號與權限' });
  route('/admin/dictionary', dictionaryPage, { title: '資料字典' });
  route('/admin/factors', factorsPage, { title: '係數與計算規則' });
  route('/admin/templates', templatesPage, { title: '報告模板' });
  route('/admin/config', configPage, { title: '門檻與設定' });
  route('/admin/integrations', integrationsPage, { title: '介接' });
  route('/admin/migration', migrationPage, { title: '歷史資料移轉' });
  route('/admin/audit', auditPage, { title: '稽核日誌' });
  route('/admin/backups', backupsPage, { title: '備份與還原' });
}

// ── 共用 ──
const D4 = ['oil', 'water', 'electricity', 'gas'];
// 跨院所的系統層動作（係數、設定、備份、稽核）：任一院所有該動作即可（後端以 orgId=null 判斷）
const canAny = (a) => !!state.me?.orgs?.some((o) => o.actions.includes(a));
const myId = () => state.me?.user?.id;
const whoName = (id) => (!id ? '—' : id === myId() ? '我' : id === 'seed' ? '系統預設' : id === 'system' || id === 'cli' ? '系統' : id);
const nn = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v])); // 空白欄位要能清除
const lines = (s) => (s ? String(s).split(/\n/).map((x) => x.trim()).filter(Boolean) : []);
const csv = (s) => (s ? String(s).split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean) : []);
const pretty = (v) => h('pre', { class: 'pf-trace' }, typeof v === 'string' ? tryPretty(v) : JSON.stringify(v ?? null, null, 2));
function tryPretty(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }
function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
const ORG_KIND = { group: '醫療體系／集團', hospital: '醫院', branch: '分院／院區', unit: '單位' };
const BOUNDARY_KIND = { ghg_operational: '溫室氣體·營運控制法', ghg_equity: '溫室氣體·股權比例法', energy: '能源', water: '用水', metering: '計量', custom: '自訂' };
const VS = { draft: ['草稿', 'todo'], pending: ['待核准', 'warn'], published: ['已發布', 'ok'], retired: ['已停用', ''] };
const verChip = (s) => chip(...(VS[s] || [s, '']));
const KIND_LABEL = { factors: '係數', rules: '計算規則', templates: '報告模板', 'configuration-versions': '設定' };
const reasonField = { key: 'reason', label: '修改原因（會留在版本紀錄與稽核日誌）', type: 'textarea', required: true, wide: true };

// ── 版本化設定的共用流程 ──
// opts.fields：編輯欄位（form 定義，key＝資料表欄位名）；opts.toPatch(values) → patch
function draftFromLatest(kind, key, latest, opts) {
  return formModal(`修改${KIND_LABEL[kind]}「${key}」（建立新草稿）`, [...opts.fields, reasonField], opts.values ? opts.values(latest) : latest, async (v) => {
    const { reason, ...rest } = v;
    await post(`admin/${kind}/draft`, { key, patch: opts.toPatch(rest), reason });
    toast('已建立草稿；送審後需另一位管理員核准才會生效'); render();
  }, '建立草稿');
}
function editDraft(kind, row, opts) {
  return formModal(`修改草稿（第 ${row.version} 版）`, opts.fields, opts.values ? opts.values(row) : row, async (v) => {
    await patch(`admin/${kind}/${row.id}`, opts.toPatch(v)); toast('草稿已更新'); render();
  });
}
async function publishFlow(kind, row) {
  const imp = await get(`admin/${kind}/${row.id}/impact`);
  const ok = await modal(`核准發布第 ${row.version} 版`, h('div',
    h('p', '發布後，之後的計算與檢核會改用這一版。已封存的報告保留當時的版本，不會被改變。'),
    dl([['影響中的未封存報告', fmtNum(imp.affectedOpenReports, 0)], ['使用到的已封存報告', fmtNum(imp.lockedReports, 0)], imp.note ? ['說明', imp.note] : null]),
    row.reason ? note(`修改原因：${row.reason}`) : null), { okText: '核准發布' });
  if (!ok) return;
  try {
    await post(`admin/${kind}/${row.id}/publish`, {});
  } catch (e) {
    if (e.status !== 409 || !e.data?.impact) throw e;
    const i = e.data.impact;
    const ok2 = await modal('請確認影響', h('div', note(e.message, 'warn'),
      dl([['影響中的未封存報告', fmtNum(i.affectedOpenReports, 0)], ['使用到的已封存報告', fmtNum(i.lockedReports, 0)], i.note ? ['說明', i.note] : null])), { okText: '我已了解，發布' });
    if (!ok2) return;
    await post(`admin/${kind}/${row.id}/publish`, { impactAck: true });
  }
  toast('已發布'); render();
}
function versionActions(kind, row, opts) {
  const out = [];
  const w = canAny('config.write'); const a = canAny('config.approve');
  if (row.status === 'draft' && w) {
    if (opts.fields) out.push(action('編輯草稿', () => editDraft(kind, row, opts)));
    out.push(action('送審', async () => { await post(`admin/${kind}/${row.id}/submit`); toast('已送審，請另一位管理員核准'); render(); }, 'primary'));
  }
  if (row.status === 'pending' && a) {
    if (row.created_by === myId()) out.push(h('span', { class: 'pf-small muted' }, '需另一位管理員核准'));
    else out.push(action('影響預覽與發布', () => publishFlow(kind, row), 'primary'));
    out.push(action('退回', () => formModal('退回成草稿', [{ key: 'note', label: '退回說明', type: 'textarea', required: true, wide: true }], {}, async (v) => {
      await post(`admin/${kind}/${row.id}/reject`, v); toast('已退回'); render();
    }, '退回')));
  }
  if (['published', 'retired'].includes(row.status) && w) {
    out.push(action('以此版回復', () => formModal(`以第 ${row.version} 版內容建立新草稿`, [{ key: 'reason', label: '回復原因', type: 'textarea', wide: true, placeholder: `回復至第 ${row.version} 版` }], {}, async (v) => {
      await post(`admin/${kind}/${row.id}/rollback`, v); toast('已建立回復草稿，送審核准後生效'); render();
    }, '建立草稿')));
  }
  if (row.status === 'published' && a) {
    out.push(action('停用', () => formModal(`停用第 ${row.version} 版`, [{ key: 'reason', label: '停用原因', type: 'textarea', required: true, wide: true }], {}, async (v) => {
      await post(`admin/${kind}/${row.id}/retire`, v); toast('已停用'); render();
    }, '停用'), 'danger-btn'));
  }
  return h('div', { class: 'pf-actions' }, out);
}
function versionTable(kind, rows, opts, extraCols = []) {
  return table([
    { label: '版本', render: (r) => `v${r.version}` },
    { label: '狀態', render: (r) => verChip(r.status) },
    ...extraCols,
    { label: '原因', key: 'reason' },
    { label: '建立', render: (r) => `${whoName(r.created_by)}・${fmtTime(r.created_at)}` },
    { label: '核准', render: (r) => (r.approved_by ? `${whoName(r.approved_by)}・${fmtTime(r.approved_at)}` : '—') },
    { label: '動作', render: (r) => versionActions(kind, r, opts) },
  ], rows);
}
const currentOf = (rows) => rows.find((r) => r.status === 'published') || null;
const hasOpenDraft = (rows) => rows.some((r) => ['draft', 'pending'].includes(r.status));

// ════════════════ 組織院區與邊界 ════════════════
async function orgsPage() {
  const orgs = await get('orgs');
  const byParent = groupBy(orgs, (o) => o.parent_id || '');
  const ids = new Set(orgs.map((o) => o.id));
  const tree = [];
  const walk = (pid, depth) => { for (const o of byParent.get(pid) || []) { tree.push({ ...o, depth }); walk(o.id, depth + 1); } };
  walk('', 0);
  for (const o of orgs) if (o.parent_id && !ids.has(o.parent_id) && !tree.some((t) => t.id === o.id)) { tree.push({ ...o, depth: 0 }); walk(o.id, 1); }
  const parentOpts = orgs.map((o) => [o.id, `${o.code} ${o.name}`]);
  const orgFields = (isNew) => [
    { key: 'code', label: '代碼', required: true, readonly: !isNew, hint: isNew ? '英數字，建立後不可改' : '代碼不可改' },
    { key: 'name', label: '名稱', required: true },
    { key: 'kind', label: '類型', type: 'select', required: true, readonly: !isNew, options: Object.entries(ORG_KIND) },
    { key: 'parentId', label: '上層組織', type: 'select', options: parentOpts, placeholder: '（無上層）' },
    { key: 'validFrom', label: '生效日', type: 'date' }, { key: 'validTo', label: '失效日（含）', type: 'date', hint: '院所裁撤或合併時填寫；歷史資料保留' },
  ];
  const saveOrg = async (body) => { await post('orgs', body); state.me = await get('me'); toast('已儲存'); render(); };
  const newOrg = (parentId) => formModal('新增組織', orgFields(true), { kind: parentId ? 'branch' : 'hospital', parentId }, (v) => saveOrg(v));
  const editOrg = (o) => formModal(`修改組織：${o.name}`, orgFields(false), { code: o.code, name: o.name, kind: o.kind, parentId: o.parent_id, validFrom: o.valid_from, validTo: o.valid_to },
    (v) => saveOrg({ id: o.id, name: v.name, parentId: v.parentId ?? null, validFrom: v.validFrom, validTo: v.validTo ?? null }));

  const treeCard = card('組織樹', table([
    { label: '名稱', render: (o) => h('span', '　'.repeat(o.depth) + (o.depth ? '└ ' : ''), o.id === state.orgId ? h('b', o.name) : o.name) },
    { label: '代碼', key: 'code', cls: 'pf-mono' },
    { label: '類型', render: (o) => ORG_KIND[o.kind] || o.kind },
    { label: '有效期間', render: (o) => `${o.valid_from && o.valid_from !== '1900-01-01' ? o.valid_from : '—'} ～ ${o.valid_to || '迄今'}` },
    { label: '舊系統代碼', render: (o) => o.legacy_hid || '—' },
    { label: '動作', render: (o) => h('div', { class: 'pf-actions' },
      can('org.write', o.id) ? action('修改', () => editOrg(o)) : null,
      can('org.write', o.id) && o.kind !== 'unit' ? action('＋下層', () => newOrg(o.id)) : null) },
  ], tree, { rowClass: (o) => (o.id === state.orgId ? 'sel' : '') }));

  const orgId = state.orgId;
  const cur = orgs.find((o) => o.id === orgId);
  let detail = null;
  if (orgId && cur && can('view.internal')) {
    const [sites, boundaries, plans] = await Promise.all([get(`orgs/${orgId}/sites`), get(`orgs/${orgId}/boundaries`), get(`orgs/${orgId}/plans`)]);
    detail = [h('h2', `目前院所：${cur.name}`), siteCard(orgId, sites), boundaryCard(orgId, sites, boundaries), await planCard(orgId, boundaries, plans)];
  } else detail = note('在上方選擇院所後，可以維護該院所的院區、建物、邊界與盤點計畫。');

  return page('組織院區與邊界', { intro: '組織、院區、建物與營運邊界都有有效期間；改組時設定失效日，不刪除歷史。',
    actions: [canAny('org.write') ? action('＋新增組織', () => newOrg(state.orgId && orgs.find((o) => o.id === state.orgId)?.kind === 'group' ? state.orgId : undefined), 'primary') : null] },
  treeCard, detail);
}

function siteCard(orgId, sites) {
  const w = can('org.write', orgId);
  const siteFields = [{ key: 'name', label: '院區名稱', required: true }, { key: 'address', label: '地址', wide: true }, { key: 'note', label: '備註', type: 'textarea', wide: true },
    { key: 'validFrom', label: '生效日', type: 'date' }, { key: 'validTo', label: '失效日（含）', type: 'date' }];
  const bldFields = [{ key: 'name', label: '建物名稱', required: true }, { key: 'floors', label: '樓層', placeholder: '例：B2–12F' }, { key: 'floorAreaM2', label: '樓地板面積（m²）', type: 'number' },
    { key: 'note', label: '備註', type: 'textarea', wide: true }, { key: 'validFrom', label: '生效日', type: 'date' }, { key: 'validTo', label: '失效日（含）', type: 'date' },
    { type: 'heading', label: '建築資料（能源查核申報表七，可不填）' }, { key: 'builtYear', label: '建造年份（民國年）', type: 'number' }, { key: 'floorsBelow', label: '地下樓層數', type: 'number' },
    { key: 'floorsAbove', label: '地上樓層數', type: 'number' }, { key: 'roof', label: '屋頂構造' }, { key: 'entrance', label: '建築入口大門方位' }, { key: 'use', label: '用途（例：醫療大樓）' }];
  const BA = ['builtYear', 'floorsBelow', 'floorsAbove', 'roof', 'entrance', 'use'];
  const battrs = (b) => (typeof b?.attrs === 'string' ? JSON.parse(b.attrs || '{}') : b?.attrs || {});
  const saveSite = (s) => formModal(s ? `修改院區：${s.name}` : '新增院區', siteFields, s ? { name: s.name, address: s.address, note: s.note, validFrom: s.valid_from, validTo: s.valid_to } : {}, async (v) => {
    await post('sites', nn({ ...v, orgId, id: s?.id })); toast('已儲存'); render();
  });
  const saveBld = (site, b) => formModal(b ? `修改建物：${b.name}` : `新增建物（${site.name}）`, bldFields, b ? { name: b.name, floors: b.floors, floorAreaM2: b.floor_area_m2, note: b.note, validFrom: b.valid_from, validTo: b.valid_to, ...battrs(b) } : {}, async (v) => {
    const attrs = Object.fromEntries(BA.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
    const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !BA.includes(k)));
    await post('buildings', nn({ ...rest, attrs, siteId: site.id, id: b?.id })); toast('已儲存'); render();
  });
  return card('院區與建物',
    w ? h('div', { class: 'pf-actions' }, action('＋新增院區', () => saveSite())) : null,
    sites.length ? sites.map((s) => h('div',
      h('h3', s.name, s.valid_to ? chip(`至 ${s.valid_to}`, 'warn') : null),
      s.address ? h('p', { class: 'muted pf-small' }, s.address) : null,
      table([
        { label: '建物', key: 'name' }, { label: '樓層', key: 'floors' }, { label: '樓地板面積（m²）', key: 'floor_area_m2', num: true },
        { label: '建造年份', render: (b) => battrs(b).builtYear ? `民國 ${battrs(b).builtYear} 年` : '—' },
        { label: '有效期間', render: (b) => `${b.valid_from && b.valid_from !== '1900-01-01' ? b.valid_from : '—'} ～ ${b.valid_to || '迄今'}` },
        { label: '備註', key: 'note' },
        { label: '動作', render: (b) => (w ? action('修改', () => saveBld(s, b)) : '—') },
      ], s.buildings || [], { empty: '尚未建立建物' }),
      w ? h('div', { class: 'pf-actions' }, action('修改院區', () => saveSite(s)), action('＋新增建物', () => saveBld(s))) : null))
      : h('div', { class: 'pf-empty' }, '尚未建立院區'));
}

function boundaryCard(orgId, sites, boundaries) {
  const w = can('org.write', orgId);
  const fields = [
    { key: 'name', label: '邊界名稱', required: true }, { key: 'kind', label: '類型', type: 'select', required: true, options: Object.entries(BOUNDARY_KIND) },
    { type: 'heading', label: '涵蓋院區' }, ...sites.map((s) => ({ key: `site_${s.id}`, label: s.name, type: 'checkbox' })),
    { key: 'definition', label: '邊界說明（納入與排除的設施、租賃與共用的處理）', type: 'textarea', wide: true },
    { key: 'validFrom', label: '生效日', type: 'date' }, { key: 'validTo', label: '失效日（含）', type: 'date' },
  ];
  const defText = (d) => (d === null || d === undefined ? '' : typeof d === 'string' ? d : JSON.stringify(d, null, 2));
  const save = (b) => formModal(b ? `修改邊界：${b.name}` : '新增邊界', fields,
    b ? { name: b.name, kind: b.kind, definition: defText(b.definition), validFrom: b.valid_from, validTo: b.valid_to, ...Object.fromEntries((b.site_ids || []).map((id) => [`site_${id}`, true])) } : { kind: 'ghg_operational' },
    async (v) => {
      const siteIds = sites.filter((s) => v[`site_${s.id}`]).map((s) => s.id);
      await post('boundaries', nn({ id: b?.id, orgId, name: v.name, kind: v.kind, siteIds, definition: v.definition, validFrom: v.validFrom, validTo: v.validTo }));
      toast('已儲存'); render();
    });
  const siteName = (id) => sites.find((s) => s.id === id)?.name || id;
  return card('盤查與計量邊界',
    w ? h('div', { class: 'pf-actions' }, action('＋新增邊界', () => save())) : null,
    table([
      { label: '名稱', key: 'name' }, { label: '類型', render: (b) => BOUNDARY_KIND[b.kind] || b.kind },
      { label: '涵蓋院區', render: (b) => ((b.site_ids || []).length ? b.site_ids.map(siteName).join('、') : '—') },
      { label: '說明', render: (b) => defText(b.definition) || '—' },
      { label: '有效期間', render: (b) => `${b.valid_from && b.valid_from !== '1900-01-01' ? b.valid_from : '—'} ～ ${b.valid_to || '迄今'}` },
      { label: '動作', render: (b) => (w ? action('修改', () => save(b)) : '—') },
    ], boundaries, { empty: '尚未設定邊界' }));
}

async function planCard(orgId, boundaries, plans) {
  const w = can('asset.write', orgId);
  const users = w ? await userOptions(orgId) : [];
  const fields = [
    { key: 'year', label: '年度（西元）', type: 'number', required: true }, { key: 'name', label: '計畫名稱', placeholder: '預設：YYYY 年度油水電氣盤點' },
    { key: 'periodStart', label: '盤點期間起', type: 'date', required: true }, { key: 'periodEnd', label: '盤點期間迄（含）', type: 'date', required: true },
    { key: 'boundaryId', label: '適用邊界', type: 'select', options: boundaries.map((b) => [b.id, b.name]) },
    { key: 'coordinator', label: '統籌人', type: 'select', options: users },
    { type: 'heading', label: '盤點面向' }, ...D4.map((d) => ({ key: `d_${d}`, label: `${state.meta.domains[d].icon} ${state.meta.domains[d].name}`, type: 'checkbox' })),
    { key: 'reviewRule', label: '審核規則說明', type: 'textarea', wide: true },
    { key: 'status', label: '狀態', type: 'select', required: true, options: [['active', '進行中'], ['closed', '已結束']] },
  ];
  const exclToIncl = (e) => { if (!e) return ''; const d = new Date(`${e}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const save = (p) => {
    const y = state.year;
    const vals = p ? { year: p.year, name: p.name, periodStart: p.period_start, periodEnd: exclToIncl(p.period_end), boundaryId: p.boundary_id, coordinator: p.coordinator, reviewRule: p.review_rule, status: p.status,
      ...Object.fromEntries(D4.map((d) => [`d_${d}`, (p.domains || []).includes(d)])) }
      : { year: y, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31`, status: 'active', ...Object.fromEntries(D4.map((d) => [`d_${d}`, true])) };
    return formModal(p ? `修改盤點計畫：${p.name}` : '新增盤點計畫', fields, vals, async (v) => {
      const domains = D4.filter((d) => v[`d_${d}`]);
      if (!domains.length) throw new Error('至少勾選一個面向');
      await post('plans', { id: p?.id, orgId, year: v.year, name: v.name, periodStart: v.periodStart, periodEnd: inclEndToExcl(v.periodEnd), boundaryId: v.boundaryId, coordinator: v.coordinator, domains, reviewRule: v.reviewRule, status: v.status });
      toast('已儲存'); render();
    });
  };
  const apply = () => formModal('套用油水電氣盤點模板', [
    ...D4.map((d) => ({ key: `d_${d}`, label: `${state.meta.domains[d].icon} ${state.meta.domains[d].name}（${state.meta.items.filter((i) => i.domain === d).length} 個盤點項目）`, type: 'checkbox' })),
  ], Object.fromEntries(D4.map((d) => [`d_${d}`, true])), async (v) => {
    const domains = D4.filter((d) => v[`d_${d}`]);
    if (!domains.length) throw new Error('至少勾選一個面向');
    const r = await post(`orgs/${orgId}/apply-template`, { domains });
    toast(r.created ? `已建立 ${r.created} 個待建檔標的` : '每個盤點項目都已有標的，沒有新增'); render();
  }, '套用');
  return card('盤點計畫',
    h('p', { class: 'muted pf-small' }, '套用模板會依資料字典替還沒有標的的盤點項目建立「待建檔」草稿標的；已有標的的項目不重複建立。'),
    w ? h('div', { class: 'pf-actions' }, action('＋新增盤點計畫', () => save()), action('套用油水電氣盤點模板', apply, 'primary')) : note('新增計畫與套用模板需要「建立與維護標的」權限。'),
    table([
      { label: '年度', key: 'year' }, { label: '名稱', key: 'name' }, { label: '期間', render: (p) => fmtPeriod(p.period_start, p.period_end) },
      { label: '面向', render: (p) => h('span', (p.domains || []).map((d) => domainChip(d))) },
      { label: '邊界', render: (p) => boundaries.find((b) => b.id === p.boundary_id)?.name || '—' },
      { label: '狀態', render: (p) => chip(p.status === 'active' ? '進行中' : p.status === 'closed' ? '已結束' : p.status, p.status === 'active' ? 'info' : '') },
      { label: '動作', render: (p) => (w ? action('修改', () => save(p)) : '—') },
    ], plans, { empty: '尚未建立盤點計畫' }));
}

// ════════════════ 帳號與權限 ════════════════
// 後端以 orgId 篩選失敗時（伺服器錯誤），改取全部可管理帳號、在前端依院所範圍（含所屬分院）過濾
async function loadUsers(orgId) {
  if (!orgId) return get('users');
  try { return await get('users', { orgId }); } catch (e) {
    if (e.status !== 500) throw e;
    const scope = new Set([orgId]);
    for (let grew = true; grew;) { grew = false; for (const o of state.me.orgs) if (o.parentId && scope.has(o.parentId) && !scope.has(o.id)) { scope.add(o.id); grew = true; } }
    return (await get('users')).filter((u) => (u.grants || []).some((g) => g.scope_type === 'org' && scope.has(g.scope_id)));
  }
}
async function usersPage(_, qy) {
  const all = qy.scope === 'all' && isGlobalAdmin();
  const users = await loadUsers(all ? null : state.orgId);
  const roles = state.meta.roles;
  const g = isGlobalAdmin();
  const roleEntries = Object.entries(roles).filter(([k]) => g || k !== 'sysadmin');
  const manageOrgs = state.me.orgs.filter((o) => o.actions.includes('user.manage'));
  const userById = new Map(users.map((u) => [u.id, u]));
  const grantText = (gr) => `${roles[gr.role]?.name || gr.role}・${gr.scope_type === 'global' ? '全部院所' : orgName(gr.scope_id)}${gr.delegate_of ? `（代理 ${userById.get(gr.delegate_of)?.display_name || gr.delegate_of}）` : ''}${gr.valid_to ? `，至 ${gr.valid_to}` : ''}`;

  const createUser = () => {
    const orgId = needOrg();
    const fields = [
      { key: 'username', label: '帳號', required: true, hint: '英數字與 . _ -，3–40 字' }, { key: 'displayName', label: '姓名', required: true },
      { key: 'email', label: 'Email' }, { key: 'phone', label: '電話' }, { key: 'unit', label: '單位' },
      { key: 'password', label: '初始密碼', type: 'password', required: true, hint: '至少 10 字，含英文與數字；首次登入須變更' },
      { type: 'heading', label: `角色（範圍：${orgName(orgId)}，含所屬分院）` },
      ...roleEntries.map(([k, r]) => ({ key: `r_${k}`, label: `${r.name}：${r.desc}`, type: 'checkbox', wide: true })),
      ...(g ? [{ type: 'heading', label: '全域角色（全部院所）' }, { key: 'g_sysadmin', label: '全域系統管理員', type: 'checkbox', wide: true }, { key: 'g_auditor', label: '全域稽核／查驗人員', type: 'checkbox', wide: true }] : []),
    ];
    return formModal('建立個人帳號', fields, {}, async (v) => {
      const grants = roleEntries.filter(([k]) => v[`r_${k}`]).map(([k]) => ({ role: k, scopeType: 'org', scopeId: orgId }));
      if (v.g_sysadmin) grants.push({ role: 'sysadmin', scopeType: 'global' });
      if (v.g_auditor) grants.push({ role: 'auditor', scopeType: 'global' });
      if (!grants.length) throw new Error('至少勾選一個角色');
      await post('users', { username: v.username, displayName: v.displayName, email: v.email, phone: v.phone, unit: v.unit, password: v.password, grants });
      toast('帳號已建立；請把初始密碼私下交給本人'); render();
    }, '建立');
  };
  const editUser = (u) => formModal(`修改帳號：${u.username}`, [
    { key: 'displayName', label: '姓名', required: true }, { key: 'email', label: 'Email' }, { key: 'phone', label: '電話' }, { key: 'unit', label: '單位' },
    { key: 'status', label: '狀態', type: 'select', required: true, options: [['active', '啟用'], ['disabled', '停用']] },
  ], { displayName: u.display_name, email: u.email, phone: u.phone, unit: u.unit, status: u.status }, async (v) => {
    await patch(`users/${u.id}`, { displayName: v.displayName, email: v.email ?? '', phone: v.phone ?? '', unit: v.unit ?? '', status: v.status }); toast('已儲存'); render();
  });
  const resetPw = (u) => formModal(`重設密碼：${u.username}`, [{ key: 'password', label: '新密碼', type: 'password', required: true, wide: true, hint: '至少 10 字，含英文與數字；對方下次登入須變更' }], {}, async (v) => {
    await post(`users/${u.id}/password`, v); toast('密碼已重設'); render();
  }, '重設');
  const addGrant = (u) => formModal(`新增授權：${u.display_name}`, [
    { key: 'role', label: '角色', type: 'select', required: true, options: roleEntries.map(([k, r]) => [k, r.name]) },
    { key: 'scope', label: '範圍', type: 'select', required: true, options: [...(g ? [['__global', '全部院所（全域）']] : []), ...manageOrgs.map((o) => [o.id, o.name])] },
    { key: 'validFrom', label: '生效日', type: 'date' }, { key: 'validTo', label: '到期日（含）', type: 'date', hint: '代理、短期支援請設定到期日' },
    { key: 'delegateOf', label: '代理誰（選填）', type: 'select', options: users.filter((x) => x.id !== u.id && !x.legacy).map((x) => [x.id, `${x.display_name}（${x.username}）`]), placeholder: '（不是代理）' },
  ], { scope: state.orgId }, async (v) => {
    const global = v.scope === '__global';
    await post(`users/${u.id}/grants`, { role: v.role, scopeType: global ? 'global' : 'org', scopeId: global ? null : v.scope, validFrom: v.validFrom, validTo: v.validTo, delegateOf: v.delegateOf });
    toast('已新增授權'); render();
  }, '新增');
  const revoke = async (gr) => { if (!(await confirmBox('撤銷授權', `確定撤銷「${grantText(gr)}」？撤銷後立即生效，紀錄保留。`, '撤銷'))) return; await del(`grants/${gr.id}`); toast('已撤銷'); render(); };
  const totpOff = async (u) => { if (!(await confirmBox('關閉兩步驟驗證', `確定關閉 ${u.display_name} 的兩步驟驗證？請先確認本人身分（例如手機遺失）。`, '關閉'))) return; await post(`users/${u.id}/totp/disable`); toast('已關閉'); render(); };

  const sel = qy.u ? users.find((u) => u.id === qy.u) : null;
  const detail = sel ? card(`帳號：${sel.display_name}（${sel.username}）`,
    dl([['單位', sel.unit], ['Email', sel.email], ['電話', sel.phone], ['狀態', sel.status === 'active' ? chip('啟用', 'ok') : chip('停用', 'alert')],
      ['兩步驟驗證', sel.totp_enabled ? chip('已啟用', 'ok') : chip('未啟用', '')], ['須變更密碼', sel.must_change ? '是' : '否'],
      ['建立時間', fmtTime(sel.created_at)], ['最後登入', fmtTime(sel.last_login_at)], sel.legacy ? ['類型', chip('舊系統院所共用帳號', 'warn')] : null]),
    h('h3', '授權'),
    table([
      { label: '角色', render: (gr) => roles[gr.role]?.name || gr.role },
      { label: '範圍', render: (gr) => (gr.scope_type === 'global' ? '全部院所' : orgName(gr.scope_id)) },
      { label: '有效期間', render: (gr) => `${gr.valid_from && gr.valid_from !== '1900-01-01' ? gr.valid_from : '—'} ～ ${gr.valid_to || '不限'}` },
      { label: '代理', render: (gr) => (gr.delegate_of ? userById.get(gr.delegate_of)?.display_name || gr.delegate_of : '—') },
      { label: '動作', render: (gr) => action('撤銷', () => revoke(gr), 'danger-btn') },
    ], sel.grants || [], { empty: '沒有有效授權' }),
    h('div', { class: 'pf-actions' },
      action('修改資料／停用', () => editUser(sel)), sel.legacy ? null : action('重設密碼', () => resetPw(sel)), action('＋新增授權', () => addGrant(sel)),
      sel.totp_enabled ? action('關閉兩步驟驗證', () => totpOff(sel)) : null, btn('關閉', () => setQuery({ u: '' }), 'ghost'))) : null;

  return page('帳號與權限', { intro: '一人一帳號；權限＝角色 × 院所範圍（含所屬分院）。院所共用帳號只用來替同仁建立個人帳號。',
    actions: [action('＋建立帳號', createUser, 'primary')] },
  g ? h('div', { class: 'pf-bar' }, select([['', `${orgName(state.orgId)}（含所屬分院）`], ['all', '全部帳號']], all ? 'all' : '', (v) => setQuery({ scope: v, u: '' }), { 'aria-label': '帳號範圍', style: 'width:auto' })) : null,
  detail,
  card(`帳號（${users.length}）`, table([
    { label: '帳號', render: (u) => h('span', link(`#/admin/users?${new URLSearchParams({ ...(all ? { scope: 'all' } : {}), u: u.id })}`, u.username), u.legacy ? [' ', chip('舊帳號', 'warn')] : null) },
    { label: '姓名', key: 'display_name' }, { label: '單位', key: 'unit' },
    { label: '狀態', render: (u) => (u.status === 'active' ? chip('啟用', 'ok') : chip('停用', 'alert')) },
    { label: '角色與範圍', render: (u) => h('div', (u.grants || []).map((gr) => h('div', { class: 'pf-small' }, grantText(gr)))) },
    { label: '最後登入', render: (u) => fmtTime(u.last_login_at) },
    { label: '兩步驟', render: (u) => (u.totp_enabled ? chip('已啟用', 'ok') : '—') },
  ], users, { empty: '這個範圍還沒有帳號', rowClass: (u) => (u.id === qy.u ? 'sel' : '') })),
  card('角色說明', table([
    { label: '代碼', key: 'k', cls: 'pf-mono' }, { label: '角色', key: 'name' }, { label: '職責', key: 'desc' },
  ], Object.entries(roles).map(([k, r]) => ({ k, ...r }))),
  h('p', { class: 'muted pf-small' }, '系統管理員負責設定與權限，但不能代替業務判定資料正確性（不能核准採用值或資料集）；稽核只能讀。')));
}

// ════════════════ 資料字典 ════════════════
async function dictionaryPage(_, qy) {
  const tab = ['metrics', 'units'].includes(qy.tab) ? qy.tab : 'items';
  const w = canAny('config.write');
  const reloadMeta = async () => { state.meta = await get('meta'); render(); };
  const t = tabs([['#/admin/dictionary', '盤點項目'], ['#/admin/dictionary?tab=metrics', '指標'], ['#/admin/dictionary?tab=units', '單位']],
    tab === 'items' ? '#/admin/dictionary' : `#/admin/dictionary?tab=${tab}`);
  let body;
  if (tab === 'items') body = itemsTab(qy, w, reloadMeta);
  else if (tab === 'metrics') body = metricsTab(w, reloadMeta);
  else body = unitsTab(w, reloadMeta);
  return page('資料字典', { intro: '盤點項目、指標、單位是全平台共用的代碼表；修改盤點項目會升版，指標與單位只能新增（避免影響歷史計算）。' }, t, body);
}

function itemFields(isNew) {
  const domains = Object.entries(state.meta.domains).map(([k, d]) => [k, `${d.icon} ${d.name}`]);
  return [
    { key: 'code', label: '代碼', required: true, readonly: !isNew, hint: isNew ? '例：OIL-VEH；建立後不可改' : '代碼不可改' },
    { key: 'domain', label: '面向', type: 'select', required: true, options: domains },
    { key: 'subtype', label: '子類代碼', required: true, placeholder: '例：vehicle_fuel' }, { key: 'name', label: '名稱', required: true },
    { key: 'description', label: '說明', type: 'textarea', wide: true },
    { key: 'assetTypes', label: '標的類型（以逗號分隔）', wide: true, hint: `可用：${Object.keys(state.meta.assetTypes || {}).join(', ')}` },
    { key: 'metrics', label: '指標代碼（以逗號分隔）', wide: true, hint: '第一個指標作為預設資料需求' },
    { key: 'requiredData', label: '必要資料（一行一項）', type: 'textarea', wide: true },
    { key: 'sourceHints', label: '來源線索（一行一項）', type: 'textarea', wide: true },
    { key: 'expectedFrequency', label: '計量頻率', type: 'select', options: [['monthly', '每月'], ['bimonthly', '每兩月'], ['quarterly', '每季'], ['yearly', '每年'], ['event', '發生時'], ['continuous', '連續']] },
    { key: 'collectionGuidance', label: '蒐集說明', type: 'textarea', wide: true },
    { key: 'applicabilityRules', label: '適用性判斷', type: 'textarea', wide: true },
    { key: 'specialRules', label: '特殊規則（一行一項）', type: 'textarea', wide: true },
    { key: 'usageCandidates', label: '候選用途（一行一項）', type: 'textarea', wide: true },
    { key: 'active', label: '啟用', type: 'checkbox' },
  ];
}
function itemsTab(qy, w, reloadMeta) {
  const items = state.meta.items || [];
  const saveItem = (it) => formModal(it ? `修改盤點項目：${it.code}（將升為第 ${(it.version || 1) + 1} 版）` : '新增盤點項目', itemFields(!it),
    it ? { code: it.code, domain: it.domain, subtype: it.subtype, name: it.name, description: it.description, assetTypes: (it.asset_types || []).join(', '), metrics: (it.metrics || []).join(', '),
      requiredData: (it.required_data || []).join('\n'), sourceHints: (it.source_hints || []).join('\n'), expectedFrequency: it.expected_frequency, collectionGuidance: it.collection_guidance,
      applicabilityRules: it.applicability_rules, specialRules: (it.special_rules || []).join('\n'), usageCandidates: (it.usage_candidates || []).join('\n'), active: true } : { active: true, domain: 'oil' },
    async (v) => {
      const codes = new Set((state.meta.metrics || []).map((m) => m.code));
      const ms = csv(v.metrics); const badM = ms.filter((m) => !codes.has(m));
      if (badM.length) throw new Error(`找不到指標：${badM.join('、')}`);
      await post('inventory-items', { code: v.code, domain: v.domain, subtype: v.subtype, name: v.name, description: v.description ?? null, assetTypes: csv(v.assetTypes), metrics: ms,
        requiredData: lines(v.requiredData), sourceHints: lines(v.sourceHints), expectedFrequency: v.expectedFrequency ?? null, collectionGuidance: v.collectionGuidance ?? null,
        applicabilityRules: v.applicabilityRules ?? null, specialRules: lines(v.specialRules), usageCandidates: lines(v.usageCandidates), active: v.active });
      toast('已儲存'); await reloadMeta();
    });
  const sel = qy.item ? items.find((i) => i.code === qy.item) : null;
  const list = (arr) => (arr?.length ? h('ul', arr.map((x) => h('li', typeof x === 'string' ? x : JSON.stringify(x)))) : '—');
  const detail = sel ? card(`${state.meta.domains[sel.domain]?.icon || ''} ${sel.code} ${sel.name}`,
    dl([['面向', domainChip(sel.domain)], ['子類', sel.subtype], ['版本', `v${sel.version || 1}`], ['說明', sel.description],
      ['標的類型', (sel.asset_types || []).map((t) => state.meta.assetTypes?.[t] || t).join('、') || '—'],
      ['指標', (sel.metrics || []).map((m) => state.meta.metrics.find((x) => x.code === m)?.name || m).join('、') || '—'],
      ['必要資料', list(sel.required_data)], ['來源線索', list(sel.source_hints)], ['計量頻率', sel.expected_frequency],
      ['蒐集說明', sel.collection_guidance], ['適用性判斷', sel.applicability_rules], ['特殊規則', list(sel.special_rules)],
      ['候選用途', list(sel.usage_candidates)], ['溫室氣體盤查對應', sel.ghg_ref ? pretty(sel.ghg_ref) : '—'], ['待確認事項', list(sel.open_questions)], ['來源', sel.origin]]),
    h('div', { class: 'pf-actions' }, w ? action('修改', () => saveItem(sel)) : null, btn('關閉', () => setQuery({ item: '' }), 'ghost'))) : null;
  const groups = Object.keys(state.meta.domains).map((d) => [d, items.filter((i) => i.domain === d)]).filter(([, arr]) => arr.length);
  return [w ? h('div', { class: 'pf-actions' }, action('＋新增盤點項目', () => saveItem(), 'primary')) : null, detail,
    groups.map(([d, arr]) => card(`${state.meta.domains[d].icon} ${state.meta.domains[d].name}（${arr.length}）`, table([
      { label: '代碼', render: (i) => link(`#/admin/dictionary?item=${encodeURIComponent(i.code)}`, i.code) },
      { label: '名稱', key: 'name' }, { label: '子類', key: 'subtype', cls: 'pf-mono' },
      { label: '指標數', num: true, render: (i) => (i.metrics || []).length },
      { label: '必要資料', render: (i) => (i.required_data || []).slice(0, 4).join('、') + ((i.required_data || []).length > 4 ? '…' : '') },
      { label: '版本', render: (i) => `v${i.version || 1}` },
    ], arr, { rowClass: (i) => (i.code === qy.item ? 'sel' : '') })))];
}
function metricsTab(w, reloadMeta) {
  const ms = state.meta.metrics || [];
  const sems = [...new Set(ms.map((m) => m.semantics))].sort();
  const create = () => formModal('新增指標', [
    { key: 'code', label: '代碼', required: true, hint: '例：elec_metered_kwh；建立後不可改' }, { key: 'name', label: '名稱', required: true },
    { key: 'domain', label: '面向', type: 'select', required: true, options: Object.entries(state.meta.domains).map(([k, d]) => [k, `${d.icon} ${d.name}`]) },
    { key: 'semantics', label: '語意', required: true, hint: `購買、領用、消耗、庫存、費用要分開。現有：${sems.join(', ')}` },
    { key: 'valueKind', label: '值型態', type: 'select', required: true, options: [['interval', '區間量'], ['cumulative', '累積讀值'], ['transaction', '交易量'], ['stock', '存量／時點值']] },
    { key: 'stdUnit', label: '標準單位', type: 'select', required: true, options: (state.meta.units || []).map((u) => [u.code, `${u.name}（${u.code}）`]) },
    { key: 'description', label: '說明', type: 'textarea', wide: true },
  ], {}, async (v) => { await post('metrics', v); toast('已新增指標'); await reloadMeta(); }, '新增');
  return [w ? h('div', { class: 'pf-actions' }, action('＋新增指標', create, 'primary')) : null,
    card(`指標（${ms.length}）`, table([
      { label: '面向', render: (m) => domainChip(m.domain) }, { label: '代碼', key: 'code', cls: 'pf-mono' }, { label: '名稱', key: 'name' },
      { label: '語意', key: 'semantics' }, { label: '值型態', render: (m) => ({ interval: '區間量', cumulative: '累積讀值', transaction: '交易量', stock: '存量' }[m.value_kind] || m.value_kind) },
      { label: '標準單位', key: 'std_unit' }, { label: '說明', key: 'description' },
    ], ms))];
}
function unitsTab(w, reloadMeta) {
  const us = state.meta.units || [];
  const create = () => formModal('新增單位', [
    { key: 'code', label: '代碼', required: true }, { key: 'name', label: '名稱', required: true },
    { key: 'dimension', label: '維度', required: true, hint: `同維度才能互相換算。現有：${[...new Set(us.map((u) => u.dimension))].join(', ')}` },
    { key: 'baseUnit', label: '基準單位', required: true }, { key: 'toBase', label: '換算到基準單位的倍率', type: 'number', required: true, hint: '建立後不可改' },
  ], {}, async (v) => { await post('units', v); toast('已新增單位'); await reloadMeta(); }, '新增');
  return [w ? h('div', { class: 'pf-actions' }, action('＋新增單位', create, 'primary')) : null,
    card(`單位（${us.length}）`, table([
      { label: '代碼', key: 'code', cls: 'pf-mono' }, { label: '名稱', key: 'name' }, { label: '維度', key: 'dimension' },
      { label: '基準單位', key: 'base_unit' }, { label: '倍率', num: true, render: (u) => fmtNum(u.to_base, 6) },
    ], us))];
}

// ════════════════ 係數與計算規則 ════════════════
const FACTOR_CAT = { emission: '排放係數', gwp: '全球暖化潛勢（GWP）', heat: '熱值', conversion: '換算係數', water: '水', other: '其他' };
const FACTOR_FIELDS = [
  { key: 'name', label: '名稱', required: true }, { key: 'category', label: '類別', type: 'select', required: true, options: Object.entries(FACTOR_CAT) },
  { key: 'gas', label: '氣體', placeholder: 'CO2、CH4、N2O…' }, { key: 'value', label: '數值', type: 'number', required: true }, { key: 'unit', label: '單位', required: true },
  { key: 'applies_to', label: '適用對象' }, { key: 'gwp_set', label: 'GWP 版本', placeholder: 'AR5' },
  { key: 'valid_from', label: '有效起日', type: 'date', required: true }, { key: 'valid_to', label: '有效迄日', type: 'date' },
  { key: 'source', label: '來源', required: true, wide: true }, { key: 'source_url', label: '來源網址', wide: true }, { key: 'note', label: '備註（推算式等）', type: 'textarea', wide: true },
];
const factorOpts = { fields: FACTOR_FIELDS, toPatch: (v) => nn(v) };
const RULE_FIELDS = [
  { key: 'name', label: '名稱', required: true }, { key: 'valid_from', label: '有效起日', type: 'date' }, { key: 'valid_to', label: '有效迄日', type: 'date' },
  { key: 'description', label: '說明', type: 'textarea', wide: true }, { key: 'definition', label: '定義（JSON）', type: 'json', required: true, wide: true },
];
const ruleOpts = { fields: RULE_FIELDS, toPatch: (v) => nn(v), values: (r) => ({ ...r, definition: typeof r.definition === 'string' ? tryPretty(r.definition) : r.definition }) };

async function factorsPage(_, qy) {
  const tab = qy.tab === 'rules' ? 'rules' : 'factors';
  const rows = await get(`admin/${tab}`);
  const groups = groupBy(rows, (r) => r.code);
  const isF = tab === 'factors';
  const opts = isF ? factorOpts : ruleOpts;
  const w = canAny('config.write');
  const t = tabs([['#/admin/factors', '係數'], ['#/admin/factors?tab=rules', '計算規則']], isF ? '#/admin/factors' : '#/admin/factors?tab=rules');
  const selHref = (code) => `#/admin/factors?${new URLSearchParams({ ...(isF ? {} : { tab: 'rules' }), sel: code })}`;

  const newOne = () => formModal(isF ? '新增係數' : '新增計算規則', [{ key: 'code', label: '代碼', required: true, hint: '建立後不可改' }, ...opts.fields, reasonField],
    isF ? { category: 'emission', valid_from: `${state.year}-01-01` } : { definition: {} }, async (v) => {
      const { code, reason, ...rest } = v;
      if (groups.has(code)) throw new Error('代碼已存在，請從列表選擇後修改');
      await post(`admin/${tab}/draft`, { key: code, patch: opts.toPatch(rest), reason }); toast('已建立草稿'); render();
    }, '建立草稿');

  const seedPending = isF ? rows.filter((r) => r.status === 'pending' && r.created_by === 'seed') : [];
  const bulk = async () => {
    if (!(await confirmBox('核准全部系統預設係數', `共有 ${seedPending.length} 筆系統預設係數待核准。請先逐筆核對來源（能源署熱值表、IPCC、環境部公告等）再發布。確定全部發布？`, '全部發布'))) return;
    const fails = [];
    for (const f of seedPending) {
      try { await post(`admin/factors/${f.id}/publish`, {}); } catch (e) { fails.push(`${f.code}：${e.message}`); }
    }
    render();
    if (fails.length) await modal('部分係數未發布', h('div', h('p', `成功 ${seedPending.length - fails.length} 筆，失敗 ${fails.length} 筆：`), h('ul', fails.map((x) => h('li', { class: 'pf-small' }, x)))), { okText: null, cancelText: '關閉' });
    else toast(`已發布 ${seedPending.length} 筆系統預設係數`);
  };

  const list = [...groups.entries()].map(([code, vs]) => ({ code, vs, latest: vs[0], cur: currentOf(vs) }));
  const sel = qy.sel ? list.find((g) => g.code === qy.sel) : null;
  let detail = null;
  if (sel) {
    const L = sel.cur || sel.latest;
    detail = card(`${sel.code}　${L.name}`,
      isF ? dl([['類別', FACTOR_CAT[L.category] || L.category], ['氣體', L.gas], ['目前生效', sel.cur ? `${fmtNum(sel.cur.value, 8)} ${sel.cur.unit}（v${sel.cur.version}）` : chip('尚無已發布版本', 'warn')],
        ['有效期間', `${L.valid_from || '—'} ～ ${L.valid_to || '迄今'}`], ['適用對象', L.applies_to], ['GWP 版本', L.gwp_set],
        ['來源', L.source], ['來源網址', L.source_url ? h('a', { href: L.source_url, target: '_blank', rel: 'noopener noreferrer' }, L.source_url) : '—'], ['備註', L.note]])
        : h('div', dl([['說明', L.description], ['目前生效', sel.cur ? `v${sel.cur.version}` : chip('尚無已發布版本', 'warn')], ['有效期間', `${L.valid_from || '—'} ～ ${L.valid_to || '迄今'}`]]), h('h3', '定義'), pretty(L.definition)),
      h('div', { class: 'pf-actions' },
        w && !hasOpenDraft(sel.vs) ? action('修改（建立新草稿）', () => draftFromLatest(tab, sel.code, sel.latest, opts), 'primary') : null,
        hasOpenDraft(sel.vs) ? h('span', { class: 'pf-small muted' }, '已有草稿或待核准版本，請先處理') : null,
        btn('關閉', () => setQuery({ sel: '' }), 'ghost')),
      h('h3', '版本紀錄'),
      versionTable(tab, sel.vs, opts, isF ? [{ label: '數值', num: true, render: (r) => `${fmtNum(r.value, 8)} ${r.unit}` }, { label: '有效期間', render: (r) => `${r.valid_from || '—'} ～ ${r.valid_to || '迄今'}` }, { label: '來源', key: 'source' }]
        : [{ label: '有效期間', render: (r) => `${r.valid_from || '—'} ～ ${r.valid_to || '迄今'}` }]));
  }

  const listTable = isF ? table([
    { label: '代碼', render: (g) => link(selHref(g.code), g.code) }, { label: '名稱', render: (g) => g.latest.name },
    { label: '類別', render: (g) => FACTOR_CAT[g.latest.category] || g.latest.category }, { label: '氣體', render: (g) => g.latest.gas },
    { label: '目前生效值', num: true, render: (g) => (g.cur ? `${fmtNum(g.cur.value, 8)} ${g.cur.unit}` : '—') },
    { label: '最新版本', render: (g) => h('span', `v${g.latest.version} `, verChip(g.latest.status)) },
    { label: '來源', render: (g) => g.latest.source },
  ], list, { rowClass: (g) => (g.code === qy.sel ? 'sel' : '') }) : table([
    { label: '代碼', render: (g) => link(selHref(g.code), g.code) }, { label: '名稱', render: (g) => g.latest.name },
    { label: '目前生效', render: (g) => (g.cur ? `v${g.cur.version}` : '—') },
    { label: '最新版本', render: (g) => h('span', `v${g.latest.version} `, verChip(g.latest.status)) },
    { label: '說明', render: (g) => g.latest.description },
  ], list, { rowClass: (g) => (g.code === qy.sel ? 'sel' : '') });

  return page('係數與計算規則', { intro: '計算引擎只使用已發布的版本；每一版都記錄來源、有效期間、修改人、核准人與原因。已封存的報告保留當時的版本。' },
    t,
    h('div', { class: 'pf-actions' }, w ? action(isF ? '＋新增係數' : '＋新增計算規則', newOne) : null,
      seedPending.length && canAny('config.approve') ? action(`核准全部待核准的系統預設係數（${seedPending.length}）`, bulk, 'primary') : null),
    seedPending.length ? note(`有 ${seedPending.length} 筆系統預設係數尚待核准；未發布前，用到它們的排放量會顯示「係數未發布」。`, 'warn') : null,
    detail, card(`${isF ? '係數' : '計算規則'}（${list.length}）`, listTable));
}

// ════════════════ 報告模板 ════════════════
const TEMPLATE_FIELDS = [
  { key: 'name', label: '名稱', required: true }, { key: 'standard', label: '依據標準', required: true }, { key: 'standard_version', label: '標準版次' },
  { key: 'applies_from', label: '適用發布日起', type: 'date' }, { key: 'applies_to', label: '適用發布日迄', type: 'date' }, { key: 'filename_pattern', label: '檔名規則' },
  { key: 'sections', label: '章節（JSON：[{id,title}]）', type: 'json', wide: true }, { key: 'export_formats', label: '匯出格式（JSON）', type: 'json', wide: true },
];
const parseMaybe = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const templateOpts = { fields: TEMPLATE_FIELDS, toPatch: (v) => nn(v), values: (r) => ({ ...r, sections: parseMaybe(r.sections) ?? [], export_formats: parseMaybe(r.export_formats) ?? [] }) };
const SOURCE_KIND = { indicator: '計算指標', metric_sum: '指標加總', text: '文字段落', manual: '人工填寫', evidence_list: '佐證清單', quality: '資料品質摘要' };

async function templatesPage(_, qy) {
  const rows = await get('admin/templates');
  const groups = groupBy(rows, (r) => r.code);
  const w = canAny('config.write');
  const newOne = () => formModal('新增報告模板', [{ key: 'code', label: '代碼', required: true, hint: '建立後不可改' }, ...TEMPLATE_FIELDS, reasonField], { sections: [], export_formats: ['xlsx', 'csv', 'pdf', 'docx'] }, async (v) => {
    const { code, reason, ...rest } = v;
    if (groups.has(code)) throw new Error('代碼已存在，請從列表選擇後修改');
    await post('admin/templates/draft', { key: code, patch: nn(rest), reason }); toast('已建立草稿'); render();
  }, '建立草稿');

  let detail = null;
  if (qy.id) {
    const t = await get(`admin/templates/${qy.id}`);
    const vs = groups.get(t.code) || [];
    const editable = t.status === 'draft' && w;
    const sections = Array.isArray(t.sections) ? t.sections : [];
    const secName = (id) => sections.find((s) => s.id === id)?.title || id;
    const mapFields = (isNew) => [
      { key: 'fieldId', label: '欄位代碼', required: true, readonly: !isNew }, { key: 'label', label: '欄位名稱', required: true },
      { key: 'section', label: '章節', type: sections.length ? 'select' : 'text', required: true, options: sections.map((s) => [s.id, s.title]) },
      { key: 'sourceKind', label: '來源類型', type: 'select', required: true, options: Object.entries(SOURCE_KIND) },
      { key: 'sourceRef', label: '來源參照', hint: '計算指標填規則代碼（例：ghg.s1.total）；指標加總填指標代碼' },
      { key: 'dataType', label: '資料型態', placeholder: 'number', hint: 'number、text…' }, { key: 'unit', label: '單位' },
      { key: 'sort', label: '排序', type: 'number' }, { key: 'required', label: '必要欄位（計入就緒率分母）', type: 'checkbox' },
      { key: 'note', label: '備註', type: 'textarea', wide: true },
    ];
    const saveMap = (m) => formModal(m ? `修改欄位：${m.label}` : '新增欄位', mapFields(!m),
      m ? { fieldId: m.field_id, label: m.label, section: m.section, sourceKind: m.source_kind, sourceRef: m.source_ref, dataType: m.data_type, unit: m.unit, sort: m.sort, required: !!m.required, note: m.note }
        : { required: true, dataType: 'number', sourceKind: 'indicator', sort: (t.mappings || []).length },
      async (v) => { await post(`admin/templates/${t.id}/mappings`, v); toast('已儲存'); render(); });
    const delMap = async (m) => { if (!(await confirmBox('刪除欄位', `確定刪除「${m.label}」？只影響這個草稿版本。`, '刪除'))) return; await del(`admin/templates/${t.id}/mappings/${encodeURIComponent(m.field_id)}`); toast('已刪除'); render(); };
    detail = card(`${t.code}　${t.name}（v${t.version}）`,
      dl([['狀態', verChip(t.status)], ['依據標準', t.standard], ['標準版次', t.standard_version], ['適用發布日', `${t.applies_from || '不限'} ～ ${t.applies_to || '不限'}`],
        ['匯出格式', Array.isArray(t.export_formats) ? t.export_formats.join('、') : t.export_formats], ['檔名規則', t.filename_pattern],
        ['章節', sections.map((s) => s.title).join('、') || '—'], t.applicability ? ['適用條件', pretty(t.applicability)] : null, ['修改原因', t.reason]]),
      versionActions('templates', t, templateOpts),
      h('div', { class: 'pf-actions' },
        w && !hasOpenDraft(vs) ? action('修改（建立新草稿）', () => draftFromLatest('templates', t.code, vs[0], templateOpts), 'primary') : null,
        btn('關閉', () => setQuery({ id: '' }), 'ghost')),
      h('h3', `欄位映射（${(t.mappings || []).length}）`),
      editable ? h('div', { class: 'pf-actions' }, action('＋新增欄位', () => saveMap())) : note(t.status === 'draft' ? '需要「修改系統設定」權限才能編輯欄位。' : '只有草稿版本可以編輯欄位；要修改請先建立新草稿（會複製目前欄位）。'),
      table([
        { label: '章節', render: (m) => secName(m.section) }, { label: '欄位代碼', key: 'field_id', cls: 'pf-mono' }, { label: '名稱', key: 'label' },
        { label: '來源', render: (m) => SOURCE_KIND[m.source_kind] || m.source_kind }, { label: '參照', key: 'source_ref', cls: 'pf-mono' },
        { label: '型態', key: 'data_type' }, { label: '單位', key: 'unit' }, { label: '必要', render: (m) => (m.required ? '是' : '否') },
        { label: '動作', render: (m) => (editable ? h('div', { class: 'pf-actions' }, action('修改', () => saveMap(m)), action('刪除', () => delMap(m), 'danger-btn')) : '—') },
      ], t.mappings || [], { empty: '沒有欄位' }),
      h('h3', '同代碼的所有版本'),
      versionTable('templates', vs, templateOpts, [{ label: '查看', render: (r) => (r.id === t.id ? '（目前）' : link(`#/admin/templates?id=${r.id}`, '查看')) },
        { label: '適用發布日', render: (r) => `${r.applies_from || '不限'} ～ ${r.applies_to || '不限'}` }]));
  }

  const list = [...groups.entries()].flatMap(([, vs]) => vs);
  return page('報告模板', { intro: '模板依「報告發布日」選用版次（例如 GRI 新舊版切換）；欄位映射決定報告就緒率的分母。' },
    w ? h('div', { class: 'pf-actions' }, action('＋新增報告模板', newOne)) : null,
    detail,
    card(`模板版本（${list.length}）`, table([
      { label: '代碼', render: (r) => link(`#/admin/templates?id=${r.id}`, r.code) }, { label: '版本', render: (r) => `v${r.version}` }, { label: '名稱', key: 'name' },
      { label: '依據標準', key: 'standard' }, { label: '標準版次', key: 'standard_version' },
      { label: '適用發布日', render: (r) => `${r.applies_from || '不限'} ～ ${r.applies_to || '不限'}` },
      { label: '欄位數', key: 'field_count', num: true }, { label: '狀態', render: (r) => verChip(r.status) },
    ], list, { rowClass: (r) => (r.id === qy.id ? 'sel' : '') })));
}

// ════════════════ 門檻與設定 ════════════════
const CONFIG_DESC = {
  'compare.thresholds': '多來源比對的差異門檻：絕對差與相對差（%），可依指標語意（用量、費用、取水、消耗）分別設定；相對差的分母取優先序最高的來源。',
  'validation.rules': '各檢核規則是否啟用、嚴重程度與參數（歷史波動 %、油料平衡容許差、總分表損失上限、需佐證的登錄方式等）。',
  'decision.policy': '採用值裁決：哪些情況屬高影響需兩位審核（推算、估計、不適用、差異比例、數值門檻），選用來源是否須附佐證，審核者是否須與提出者不同。',
  'case.sla': '差異案件依嚴重程度的處理期限（天）。',
  'task.reminders': '待辦到期前幾天提醒、逾期後每隔幾天再提醒。',
  'calc.settings': '計算設定：GWP 版本、各單位的顯示精度、冷媒計算方式。',
  'calc.septic': '化糞池甲烷計算用的人日折算參數（門診停留時數、每日工時）。',
  'dashboard.visibility': '公開看板可顯示的區塊，以及數量少於多少時隱藏（避免從彙總反推個別資料）。',
  'notify.channels': '通知管道：系統內通知、Email。',
  'export.retentionDays': '匯出檔與報告版本的保存天數。',
  'security.session': '登入會話：閒置逾時（分鐘）、記住登入天數。',
};
async function configPage() {
  const rows = await get('admin/configuration-versions');
  const groups = groupBy(rows, (r) => r.key);
  const w = canAny('config.write');
  const opts = { fields: [{ key: 'value', label: '設定值（JSON）', type: 'json', required: true, wide: true }], toPatch: (v) => ({ value: v.value }), values: (r) => ({ value: r.value }) };
  return page('門檻與設定', { intro: '設定變更須建立草稿、預覽影響、由另一位管理員核准後才生效；已定版資料與已封存報告不會被回溯改變。' },
    [...groups.entries()].map(([key, vs]) => {
      const cur = currentOf(vs);
      return card(key,
        h('p', { class: 'muted' }, CONFIG_DESC[key] || '（無說明）'),
        cur ? h('div', h('p', { class: 'pf-small' }, `目前生效：第 ${cur.version} 版（${fmtTime(cur.effective_at || cur.approved_at)} 起，核准：${whoName(cur.approved_by)}）`), pretty(cur.value))
          : note('尚無已發布版本，系統使用內建預設值', 'warn'),
        h('div', { class: 'pf-actions' },
          w && !hasOpenDraft(vs) ? action('修改（建立新草稿）', () => draftFromLatest('configuration-versions', key, vs[0], opts), 'primary') : null,
          hasOpenDraft(vs) ? h('span', { class: 'pf-small muted' }, '已有草稿或待核准版本') : null),
        h('details', { open: hasOpenDraft(vs) || undefined }, h('summary', `版本紀錄（${vs.length}）`),
          versionTable('configuration-versions', vs, opts),
          vs.filter((r) => ['draft', 'pending'].includes(r.status)).map((r) => h('div', h('p', { class: 'pf-small' }, `第 ${r.version} 版（${VS[r.status][0]}）內容：`), pretty(r.value)))));
    }));
}

// ════════════════ 介接 ════════════════
const INT_STATUS = { idle: ['待命', 'ok'], running: ['同步中', 'info'], error: ['失敗（將重試）', 'warn'], dead: ['已停止（連續失敗）', 'alert'] };
const JOB_STATUS = { running: ['執行中', 'info'], ok: ['成功', 'ok'], failed: ['失敗', 'warn'], dead: ['停止', 'alert'] };
function connectorFields(connector) {
  if (connector === 'ems_bridge') return [{ key: 'url', label: 'ems-bridge 網址', placeholder: 'http://127.0.0.1:8460/api/ess', wide: true }, { key: 'assetName', label: '儲能櫃標的名稱', placeholder: '儲能櫃' },
    { key: 'allowSim', label: '允許寫入模擬資料（僅測試用；會標為估計值）', type: 'checkbox', wide: true }];
  if (connector === 'http_json') return [{ key: 'url', label: '拉取網址', required: true, wide: true, hint: '回應格式：{ observations: [PRD §16.3], next_cursor }' },
    { key: 'cursorParam', label: '游標參數名', placeholder: 'since' }, { key: 'authHeader', label: '驗證標頭名稱', placeholder: 'Authorization' },
    { key: 'authHeaderEnv', label: '驗證值的環境變數名稱', hint: '金鑰不存在平台資料庫，由主機環境變數提供' }];
  if (connector === 'file_drop') return [{ key: 'dir', label: '投遞目錄（主機絕對路徑）', required: true, wide: true, hint: '讀取新的 CSV／XLSX，欄位同觀測匯入範本' }];
  return [];
}
const CFG_KEYS = { ems_bridge: ['url', 'assetName', 'allowSim'], http_json: ['url', 'cursorParam', 'authHeader', 'authHeaderEnv'], file_drop: ['dir'] };
const pushUrl = (id) => `${location.origin}/api/v1/integrations/${id}/push`;
function pushExample() {
  return JSON.stringify({ observations: [{
    asset_id: 'ASSET-ELEC-A-01', metric_code: 'elec_metered_kwh', period_start: '2026-10-01T00:00:00+08:00', period_end: '2026-11-01T00:00:00+08:00',
    period_semantics: 'half_open', raw_value: '102450.000', raw_unit: 'kWh', source_id: 'SRC-EMS-01', source_record_key: 'ems-202610-a01', note: '',
  }] }, null, 2);
}
function pushHelp(id) {
  return h('div',
    dl([['推送網址', h('span', { class: 'pf-mono' }, pushUrl(id))], ['方法', 'POST，Content-Type: application/json'], ['驗證', 'Authorization: Bearer <推送權杖>']]),
    h('p', { class: 'pf-small muted' }, 'asset_id 可填平台標的編號或外部識別碼（電號、水號）；source_record_key 是冪等鍵，同一鍵重送不會重複寫入；source_id 可省略（自動建立此介接的來源）。一次最多 5000 筆。'),
    h('pre', { class: 'pf-trace' }, pushExample()));
}
async function integrationsPage() {
  const orgId = needOrg();
  const list = await get('integrations', { orgId });
  const w = can('integration.write');
  const connectors = state.meta.connectors || {};
  const save = async (it, connector) => {
    const fields = [{ key: 'name', label: '名稱', required: true }, { key: 'intervalMin', label: '同步間隔（分鐘）', type: 'number', hint: '預設 1440＝每天一次' },
      { key: 'enabled', label: '啟用', type: 'checkbox' }, ...connectorFields(connector)];
    const vals = it ? { name: it.name, intervalMin: it.interval_min, enabled: !!it.enabled, ...Object.fromEntries((CFG_KEYS[connector] || []).map((k) => [k, it.config?.[k]])) }
      : { name: connectors[connector], intervalMin: 1440, enabled: true };
    return formModal(it ? `修改介接：${it.name}` : `新增介接：${connectors[connector]}`, fields, vals, async (v) => {
      const config = Object.fromEntries((CFG_KEYS[connector] || []).filter((k) => v[k] !== undefined && v[k] !== '').map((k) => [k, v[k]]));
      if (it?.config?.mapping) config.mapping = it.config.mapping;
      const r = await post('integrations', { id: it?.id, orgId, connector, name: v.name, intervalMin: v.intervalMin, enabled: v.enabled, config });
      toast('已儲存'); render();
      return r;
    });
  };
  const create = async () => {
    let picked = null;
    const ok = await formModal('新增介接：選擇類型', [{ key: 'connector', label: '介接類型', type: 'select', required: true, options: Object.entries(connectors), wide: true }], {}, (v) => { picked = v.connector; }, '下一步');
    if (ok && picked) await save(null, picked);
  };
  const run = async (it) => {
    const r = await post(`integrations/${it.id}/run`);
    render();
    await modal(r.ok ? '同步完成' : '同步失敗', h('div', r.ok ? null : note(`${r.error}${r.dead ? '（已連續失敗，介接停止；修正設定後重新啟用）' : ''}`, 'alert'), r.stats ? pretty(r.stats) : null), { okText: null, cancelText: '關閉' });
  };
  const rotate = async (it) => {
    if (!(await confirmBox('換發推送權杖', '換發後舊權杖立即失效，外部系統要改用新權杖。確定換發？', '換發'))) return;
    const r = await post(`integrations/${it.id}/token`);
    await modal('新的推送權杖（只顯示這一次）', h('div',
      note('請立刻複製並交給外部系統的管理者，平台只存雜湊、之後無法再顯示。不要貼在信件或聊天群組。', 'warn'),
      h('p', { class: 'pf-mono' }, r.token), pushHelp(it.id)), { okText: null, cancelText: '我已複製，關閉' });
  };
  return page('介接', { intro: '可替換的介接：排程同步、失敗自動重試（連續 5 次停止並通知）、游標增量、以冪等鍵去重。沒有 API 的來源請改用檔案匯入。',
    actions: [w ? action('＋新增介接', create, 'primary') : null] },
  list.length ? list.map((it) => {
    const [sl, sk] = INT_STATUS[it.status] || [it.status, ''];
    return card(it.name,
      h('div', { class: 'pf-bar' }, chip(it.label || connectors[it.connector] || it.connector, 'info'), chip(sl, sk), it.enabled ? null : chip('未啟用', '')),
      dl([['最後成功', fmtTime(it.last_ok_at)], ['最後同步', fmtTime(it.last_sync_at)], ['連續失敗', fmtNum(it.fail_count, 0)],
        ['下次執行', it.connector === 'push' ? '（推送型，不排程）' : fmtTime(it.next_run_at)], ['同步間隔', `${fmtNum(it.interval_min, 0)} 分鐘`],
        it.last_error ? ['最後錯誤', h('span', { class: 'err' }, it.last_error)] : null,
        Object.keys(it.config || {}).filter((k) => it.config[k] !== undefined && k !== 'mapping').length ? ['設定', pretty(Object.fromEntries(Object.entries(it.config).filter(([k, v]) => v !== undefined && k !== 'mapping')))] : null]),
      it.connector === 'push' ? h('details', h('summary', '推送網址與格式（PRD §16.3）'), pushHelp(it.id)) : null,
      h('h3', '最近同步'),
      table([
        { label: '開始', render: (j) => fmtTime(j.started_at) }, { label: '結束', render: (j) => fmtTime(j.finished_at) },
        { label: '狀態', render: (j) => chip(...(JOB_STATUS[j.status] || [j.status, ''])) }, { label: '第幾次', key: 'attempt', num: true },
        { label: '結果', render: (j) => (j.stats ? Object.entries(j.stats).filter(([k]) => k !== 'errorList').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('，') : '—') },
        { label: '錯誤', render: (j) => j.error || '—' },
      ], it.lastJobs || [], { empty: '還沒有同步紀錄' }),
      w ? h('div', { class: 'pf-actions' }, action('修改', () => save(it, it.connector)),
        it.connector !== 'push' ? action('立即同步', () => run(it), 'primary') : null,
        it.connector === 'push' ? action('換發推送權杖', () => rotate(it)) : null) : null);
  }) : card(null, h('div', { class: 'pf-empty' }, '這個院所還沒有介接')));
}

// ════════════════ 歷史資料移轉（§19）════════════════
const IMPORT_STATUS = { uploaded: ['已上傳', 'todo'], previewed: ['預覽中', 'info'], committed: ['已提交', 'ok'], reverted: ['已撤銷', ''], failed: ['失敗', 'alert'] };
const IMPORT_KIND = { ghg_workbook: '歷史碳盤查工作簿', observations: '觀測值', assets: '標的' };
async function migrationPage(_, qy) {
  const orgId = needOrg();
  const [jobs, refs, ints] = await Promise.all([
    get('import-jobs', { orgId }), get('reference-activities'), can('integration.write') ? get('integrations', { orgId }).catch(() => []) : Promise.resolve([]),
  ]);
  const wImport = can('import.write');

  // 1. 上傳工作簿
  const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', 'aria-label': '碳盤查工作簿' });
  const uploadCard = wImport ? card('1. 上傳歷史碳盤查工作簿',
    h('p', { class: 'muted pf-small' }, '保留原檔名、工作表與儲存格座標。「活動來源」會比對到盤點項目；對不到的保留為參照，之後人工指定。原表的範疇／類別不會被機器直接認定為適用。'),
    h('div', { class: 'pf-bar' }, fileInput, action('上傳並預覽', async () => {
      const f = fileInput.files[0]; if (!f) throw new Error('請選擇檔案');
      const r = await upload('import-jobs', { orgId, kind: 'ghg_workbook' }, f);
      toast(`已解析 ${r.rows} 列${r.errors?.length ? `，${r.errors.length} 列無對應項目` : ''}${r.duplicateFile ? '（這個檔案之前上傳過）' : ''}`);
      setQuery({ job: r.id });
    }, 'primary'))) : note('上傳需要「檔案匯入」權限。');

  // 2. 預覽與提交
  let previewCard = null;
  if (qy.job) {
    const jb = await get(`import-jobs/${qy.job}`);
    const rows = jb.preview?.rows || [];
    const errors = jb.errors || [];
    const allow = h('input', { type: 'checkbox', checked: true, id: 'pfAllowErr' });
    const [sl, sk] = IMPORT_STATUS[jb.status] || [jb.status, ''];
    previewCard = card(`2. 預覽：${jb.filename}`,
      h('div', { class: 'pf-bar' }, chip(IMPORT_KIND[jb.kind] || jb.kind, 'info'), chip(sl, sk), h('span', { class: 'pf-small muted' }, `${rows.length} 列${errors.length ? `，${errors.length} 則提示` : ''}`)),
      errors.length ? h('details', { open: true }, h('summary', `錯誤與提示（${errors.length}）`),
        table([{ label: '列', key: 'row', num: true }, { label: '嚴重度', render: (e) => (e.severity === 'warning' ? chip('提示', 'warn') : chip('錯誤', 'alert')) }, { label: '說明', key: 'msg' }], errors)) : null,
      jb.kind === 'ghg_workbook' ? table([
        { label: '工作表', key: 'sheet' }, { label: '列', key: 'row_no', num: true }, { label: '範疇', key: 'scope' }, { label: '類別', key: 'category' },
        { label: '活動來源', key: 'activity' }, { label: '所需數據', key: 'required_data' },
        { label: '對應盤點項目', render: (r) => ((r.item_codes || []).length ? h('span', r.item_codes.map((c) => chip(c, itemOf(c)?.domain || ''))) : chip('無對應', 'warn')) },
      ], rows.slice(0, 300)) : h('p', { class: 'muted' }, '此匯入不是碳盤查工作簿，請到「匯入／辨識／介接」處理。'),
      jb.status === 'previewed' && wImport ? h('div', { class: 'pf-actions' },
        h('label', { class: 'pf-small', for: 'pfAllowErr' }, allow, ' 有提示的列也一併匯入（無對應的保留為參照，之後人工指定）'),
        action('提交匯入', async () => {
          const r = await post(`import-jobs/${jb.id}/commit`, { allowErrors: allow.checked });
          toast(`已匯入 ${r.created} 列${r.duplicate ? `，${r.duplicate} 列已存在` : ''}`); render();
        }, 'primary'), btn('關閉預覽', () => setQuery({ job: '' }), 'ghost')) : h('div', { class: 'pf-actions' }, btn('關閉預覽', () => setQuery({ job: '' }), 'ghost')));
  }

  // 3. 匯入紀錄與簽收
  const signOff = async (jb) => { if (!(await confirmBox('移轉結果簽收', `確認「${jb.filename}」的移轉結果正確並簽收？簽收者不可是提交者。`, '簽收'))) return; await post(`import-jobs/${jb.id}/sign-off`); toast('已簽收'); render(); };
  const revert = (jb) => formModal(`整批撤銷：${jb.filename}`, [{ key: 'reason', label: '撤銷原因', type: 'textarea', required: true, wide: true }], {}, async (v) => {
    const r = await post(`import-jobs/${jb.id}/revert`, v); toast(`已撤銷${r.reverted ? `（${r.reverted} 筆觀測標為已取代）` : ''}`); render();
  }, '撤銷');
  const jobsCard = card('3. 匯入紀錄與簽收', table([
    { label: '檔名', render: (jb) => link(`#/admin/migration?job=${jb.id}`, jb.filename) }, { label: '類型', render: (jb) => IMPORT_KIND[jb.kind] || jb.kind },
    { label: '狀態', render: (jb) => chip(...(IMPORT_STATUS[jb.status] || [jb.status, ''])) },
    { label: '結果', render: (jb) => (jb.stats ? Object.entries(jb.stats).map(([k, v]) => `${{ rows: '列', errors: '提示', created: '新增', duplicate: '重複', failed: '失敗', new_version: '新版本' }[k] || k} ${v}`).join('，') : '—') },
    { label: '上傳', render: (jb) => fmtTime(jb.created_at) }, { label: '提交', render: (jb) => fmtTime(jb.committed_at) },
    { label: '簽收', render: (jb) => (jb.signed_off_at ? chip(`已簽收 ${fmtDate(jb.signed_off_at)}`, 'ok') : '—') },
    { label: '動作', render: (jb) => h('div', { class: 'pf-actions' },
      jb.status === 'committed' && !jb.signed_off_at && can('dataset.approve') ? action('簽收', () => signOff(jb), 'primary') : null,
      jb.status === 'committed' && wImport ? action('整批撤銷', () => revert(jb), 'danger-btn') : null) },
  ], jobs, { empty: '還沒有匯入紀錄' }));

  // 4. 參照項目
  const wMap = canAny('config.write');
  const mapRef = (r) => {
    const items = (state.meta.items || []);
    const fields = Object.keys(state.meta.domains).flatMap((d) => {
      const arr = items.filter((i) => i.domain === d);
      return arr.length ? [{ type: 'heading', label: `${state.meta.domains[d].icon} ${state.meta.domains[d].name}` }, ...arr.map((i) => ({ key: `i_${i.code}`, label: `${i.code} ${i.name}`, type: 'checkbox' }))] : [];
    });
    return formModal(`指定盤點項目：${r.activity}`, fields, Object.fromEntries((r.item_codes || []).map((c) => [`i_${c}`, true])), async (v) => {
      const itemCodes = items.filter((i) => v[`i_${i.code}`]).map((i) => i.code);
      await post(`reference-activities/${r.id}/mapping`, { itemCodes }); toast('已更新對應；適用性仍需各院確認'); render();
    });
  };
  const refFilter = qy.ref || '';
  const refRows = refFilter === 'unmapped' ? refs.filter((r) => !(r.item_codes || []).length) : refs;
  const refCard = card(`4. 歷史盤查參照項目（${refs.length}）`,
    h('div', { class: 'pf-bar' }, select([['', '全部'], ['unmapped', '只看無對應']], refFilter, (v) => setQuery({ ref: v }), { 'aria-label': '篩選參照項目', style: 'width:auto' })),
    table([
      { label: '工作簿', key: 'workbook' }, { label: '工作表', key: 'sheet' }, { label: '列', key: 'row_no', num: true },
      { label: '範疇', key: 'scope' }, { label: '類別', key: 'category' }, { label: '活動來源', key: 'activity' }, { label: '所需數據', key: 'required_data' }, { label: '備註', key: 'note' },
      { label: '盤點項目', render: (r) => ((r.item_codes || []).length ? h('span', r.item_codes.map((c) => chip(c, itemOf(c)?.domain || ''))) : chip('無對應', 'warn')) },
      { label: '面向提示', render: (r) => (r.domain_hint ? String(r.domain_hint).split(',').map((d) => state.meta.domains[d]?.name || d).join('、') : '—') },
      { label: '原始儲存格', render: (r) => h('span', { class: 'pf-mono' }, Object.entries(r.cells || {}).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `${k}=${v}`).join('；')) },
      { label: '動作', render: (r) => (wMap ? action('指定盤點項目', () => mapRef(r)) : '—') },
    ], refRows, { empty: '還沒有匯入歷史盤查參照' }));

  // 5. 舊系統介接
  const hasInt = (c) => ints.some((i) => i.connector === c);
  const mkLegacy = async (connector) => {
    await post('integrations', { orgId, connector, name: state.meta.connectors?.[connector], intervalMin: 1440, enabled: true, config: {} });
    toast('已建立介接；可到「介接」頁立即同步'); render();
  };
  const legacyCard = can('integration.write') ? card('5. 接上舊系統資料',
    h('p', { class: 'muted pf-small' }, '把舊入口的電費單（已逐格複驗的健檢填報）與貼紙點位抄表持續帶入平台，成為原始觀測值（不直接當採用值）。需要院所有舊系統代碼。'),
    h('div', { class: 'pf-actions' },
      hasInt('legacy_audit') ? chip('已建立：電力健檢填報電費單', 'ok') : action('建立「舊系統·電力健檢填報電費單」介接', () => mkLegacy('legacy_audit')),
      hasInt('legacy_inventory') ? chip('已建立：貼紙點位抄表', 'ok') : action('建立「舊系統·貼紙點位抄表」介接', () => mkLegacy('legacy_inventory')),
      link('#/admin/integrations', '前往介接管理'))) : null;

  return page('歷史資料移轉', { intro: '依 PRD §19：原表的範疇／類別、活動來源、所需數據保留為參照，拆成盤點項目與待確認事項；不填零、不製造負責人。' },
    uploadCard, previewCard, jobsCard, refCard, legacyCard);
}

// ════════════════ 稽核日誌 ════════════════
async function auditPage(_, qy) {
  const f = form([
    { key: 'targetType', label: '對象類型', placeholder: 'asset、user、factor…' }, { key: 'targetId', label: '對象編號' },
    { key: 'actor', label: '操作者（使用者編號）' }, { key: 'action', label: '動作', placeholder: 'user.create' },
    { key: 'from', label: '起日', type: 'date' }, { key: 'to', label: '迄日（含）', type: 'date' },
    { key: 'scope', label: '院所範圍', type: 'select', options: [['org', `只看目前院所（${orgName(state.orgId)}）`]], placeholder: '我可查的全部範圍' },
    { key: 'detail', label: '顯示修改前後內容', type: 'checkbox' },
  ], { ...qy, detail: qy.detail === '1' });
  const search = () => { const v = f.read(); if (!v) return; setQuery({ targetType: v.targetType, targetId: v.targetId, actor: v.actor, action: v.action, from: v.from, to: v.to, scope: v.scope, detail: v.detail ? '1' : '' }); };
  f.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const query = { targetType: qy.targetType, targetId: qy.targetId, actor: qy.actor, action: qy.action, from: qy.from, to: qy.to ? inclEndToExcl(qy.to) : undefined,
    orgId: qy.scope === 'org' ? state.orgId : undefined, detail: qy.detail === '1' ? '1' : undefined, limit: 500 };
  const rows = await get('audit-events', query);
  const verify = async () => {
    const r = await get('audit-events/verify');
    await modal('稽核雜湊鏈驗證', r.ok ? note(`驗證通過：${fmtNum(r.count, 0)} 筆事件的雜湊鏈完整，沒有被修改或刪除。`) : note(`雜湊鏈在第 ${r.brokenAt} 筆中斷（共 ${fmtNum(r.count, 0)} 筆）。請立即通報資安窗口並保留現場。`, 'alert'), { okText: null, cancelText: '關閉' });
  };
  return page('稽核日誌', { intro: '所有新增、修改、核准、退回、下載與設定變動都會留下事件；事件以雜湊串鏈，不能修改或刪除。',
    actions: [action('驗證雜湊鏈', verify)] },
  card('查詢條件', f.el, h('div', { class: 'pf-actions' }, action('查詢', search, 'primary'), btn('清除', () => setQuery({ targetType: '', targetId: '', actor: '', action: '', from: '', to: '', scope: '', detail: '' }), 'ghost'))),
  card(`事件（${rows.length}${rows.length >= 500 ? '，只顯示最新 500 筆' : ''}）`, table([
    { label: '#', key: 'seq', num: true }, { label: '時間', render: (r) => fmtTime(r.at) },
    { label: '操作者', render: (r) => r.actor_name || whoName(r.actor) }, { label: '院所', render: (r) => (r.org_id ? orgName(r.org_id) : '—') },
    { label: '動作', key: 'action', cls: 'pf-mono' }, { label: '對象', render: (r) => (r.target_type ? `${r.target_type}／${r.target_id || ''}` : '—') },
    { label: '來源 IP', key: 'ip' },
    ...(qy.detail === '1' ? [{ label: '內容', render: (r) => (r.before || r.after ? h('details', h('summary', '修改前後'), r.before ? [h('div', { class: 'pf-small' }, '修改前'), pretty(r.before)] : null, r.after ? [h('div', { class: 'pf-small' }, '修改後'), pretty(r.after)] : null) : '—') }] : []),
    { label: '雜湊', render: (r) => h('span', { class: 'pf-mono', title: r.hash }, String(r.hash || '').slice(0, 12)) },
  ], rows, { empty: '沒有符合條件的事件' })));
}

// ════════════════ 備份與還原 ════════════════
const fmtSize = (n) => (n >= 1048576 ? `${fmtNum(n / 1048576, 1)} MB` : `${fmtNum(n / 1024, 1)} KB`);
const TABLE_LABEL = { organizations: '組織', users: '帳號', assets: '標的', observations: '觀測值', approved_facts: '採用值', datasets: '資料集', report_runs: '報告版本', evidence_files: '佐證檔' };
function verifyView(v, live) {
  return h('div',
    v.ok ? note('驗證通過：可開啟、完整性檢查正常、稽核雜湊鏈連續。') : note('驗證未通過，請檢查備份目錄與磁碟。', 'alert'),
    dl([['完整性檢查', v.integrity], ['稽核雜湊鏈', v.auditChain ? '連續' : '中斷'], ['稽核事件數', fmtNum(v.auditEvents, 0)], ['檔案大小', v.size ? fmtSize(v.size) : '—']]),
    table([
      { label: '資料表', render: (r) => TABLE_LABEL[r.t] || r.t }, { label: '備份筆數', key: 'n', num: true },
      ...(live ? [{ label: '現行筆數', key: 'live', num: true }, { label: '差異', num: true, render: (r) => (r.live - r.n ? chip(fmtNum(r.live - r.n, 0), 'info') : '0') }] : []),
    ], Object.entries(v.counts || {}).map(([t, n]) => ({ t, n, live: live?.[t] }))),
    live ? h('p', { class: 'pf-small muted' }, '演練以唯讀方式開啟備份，不覆蓋現行資料。現行筆數較多屬正常（備份之後的新資料）。') : null);
}
async function backupsPage() {
  const list = await get('admin/backups');
  const now = async () => { const r = await post('admin/backups'); render(); await modal(`已備份：${r.name}`, verifyView(r), { okText: null, cancelText: '關閉' }); };
  const drill = async (b) => { const r = await post(`admin/backups/${encodeURIComponent(b.name)}/drill`); await modal(`還原演練：${b.name}`, verifyView(r, r.live), { okText: null, cancelText: '關閉' }); };
  const ev = async () => {
    const r = await get('admin/evidence-verify');
    await modal('佐證檔雜湊驗證', h('div',
      r.bad?.length ? note(`檢查 ${fmtNum(r.checked, 0)} 個檔案，有 ${r.bad.length} 個異常。`, 'alert') : note(`檢查 ${fmtNum(r.checked, 0)} 個檔案，雜湊全部相符。`),
      r.bad?.length ? table([{ label: '佐證編號', key: 'id', cls: 'pf-mono' }, { label: '問題', render: (x) => (x.problem === 'missing' ? '檔案遺失' : x.problem === 'hash_mismatch' ? '內容與雜湊不符' : x.problem) }], r.bad) : null), { okText: null, cancelText: '關閉' });
  };
  return page('備份與還原', { intro: '每日自動快照並驗證（能開啟、完整性檢查、稽核鏈、筆數），保留最近數份。還原演練只做唯讀比對，正式還原請依維運 SOP 由主機管理者執行。',
    actions: [action('立即備份並驗證', now, 'primary'), action('驗證全部佐證檔雜湊', ev)] },
  card(`備份（${list.length}）`, table([
    { label: '檔名', key: 'name', cls: 'pf-mono' }, { label: '時間', render: (b) => fmtTime(b.at) }, { label: '大小', num: true, render: (b) => fmtSize(b.size) },
    { label: '動作', render: (b) => action('還原演練', () => drill(b)) },
  ], list, { empty: '還沒有備份' })));
}
