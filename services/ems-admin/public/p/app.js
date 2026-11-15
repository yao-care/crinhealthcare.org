// 平台入口：登入、改密碼、外框（頂列＋選單）、載入各頁面模組。
import { state, api, get, post, h, $, btn, action, toast, route, render, mountShell, go, currentPath, form, can, isGlobalAdmin, fmtTime, link } from './core.js';
import * as workbench from './pages/workbench.js';
import * as assets from './pages/assets.js';
import * as sources from './pages/sources.js';
import * as collect from './pages/collect.js';
import * as quality from './pages/quality.js';
import * as datasets from './pages/datasets.js';
import * as reports from './pages/reports.js';
import * as dash from './pages/dash.js';
import * as admin from './pages/admin.js';
import * as ghg from './pages/ghg.js';

// PRD §15 選單；need＝需要的動作（任一院所有即顯示）
const NAV = [
  ['首頁', [['#/', '🏠 我的工作台', 'view.internal'], ['#/feedback', '🌱 我的盤點成果與引用']]],
  ['油水電氣盤點管理', [['#/assets', '📋 標的台帳', 'view.internal'], ['#/collect', '📱 現場盤點', 'obs.write'], ['#/sources', '🔎 資料來源與追查', 'view.internal'],
    ['#/imports', '📥 匯入／辨識／介接', 'import.write'], ['#/observations', '📈 數據檢視與版本', 'view.internal'], ['#/evidence', '🗂 佐證文件庫', 'view.internal']]],
  ['數據品質中心', [['#/quality/runs', '✅ 檢核規則與結果', 'view.internal'], ['#/quality/cases', '⚖️ 差異案件', 'view.internal'],
    ['#/quality/review', '🖊 待審核採用值', 'decision.review'], ['#/datasets', '🔒 資料集與定版', 'view.internal']]],
  ['報告與成果', [['#/reports', '📑 報告案件', 'view.internal'], ['#/indicators', '🧮 排放量與營運指標', 'view.internal'], ['#/ghg', '🌍 溫室氣體盤查設定', 'view.internal']]],
  ['統整資訊看板', [['#/dash/public', '📊 全院公開進度'], ['#/dash/management', '🏢 院區與單位進度', 'view.management'], ['#/dash/report', '🗒 報告準備', 'view.internal'], ['#/dash/energy', '⚡ 油水電氣趨勢', 'view.internal']]],
  ['系統管理', [['#/admin/orgs', '🏥 組織院區與邊界', 'org.write'], ['#/admin/users', '👥 帳號與權限', 'user.manage'], ['#/admin/dictionary', '📚 資料字典', 'view.internal'],
    ['#/admin/factors', '🧪 係數與計算規則', 'view.internal'], ['#/admin/templates', '🧾 報告模板', 'view.internal'], ['#/admin/config', '⚙️ 門檻與設定', 'view.internal'],
    ['#/admin/integrations', '🔌 介接', 'integration.write'], ['#/admin/migration', '🗃 歷史資料移轉', 'import.write'], ['#/admin/audit', '🧾 稽核日誌', 'audit.read'], ['#/admin/backups', '💾 備份與還原', 'backup.run']]],
];

const app = $('#app');

function loginView() {
  const f = form([{ key: 'username', label: '帳號', required: true, wide: true }, { key: 'password', label: '密碼', type: 'password', required: true, wide: true },
    { key: 'totp', label: '兩步驟驗證碼（有啟用才需要）', inputmode: 'numeric', wide: true }]);
  f.inputs.username.autocomplete = 'username'; f.inputs.password.autocomplete = 'current-password';
  const err = h('p', { class: 'err' });
  const submit = async () => {
    const v = f.read(); if (!v) return;
    err.textContent = '';
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) { err.textContent = { bad_credentials: '帳號或密碼錯誤', locked: '嘗試太多次，請稍後再試', totp_required: '請輸入兩步驟驗證碼', bad_totp: '驗證碼錯誤', disabled: '帳號已停用' }[d.error] || d.error || '登入失敗'; return; }
    if (!d.platform) { err.textContent = '此帳號尚未對應平台，請聯絡系統管理員'; return; }
    await boot();
  };
  f.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  app.replaceChildren(h('div', { class: 'pf-login pf-card' }, h('h1', '油水電氣資料治理平台'),
    h('p', { class: 'muted' }, '請以個人帳號登入（院所共用帳號也可登入，登入後請替同仁建立個人帳號）。'), f.el, err,
    h('div', { class: 'pf-actions' }, btn('登入', submit, 'primary')), h('p', { class: 'muted pf-small' }, link('/', '前往舊版：電力健檢填報、能源盤點、看板維護'))));
}

function passwordView() {
  const f = form([{ key: 'oldPassword', label: '目前密碼', type: 'password', required: true, wide: true },
    { key: 'newPassword', label: '新密碼（至少 10 字，含英文與數字）', type: 'password', required: true, wide: true }, { key: 'again', label: '再輸入一次', type: 'password', required: true, wide: true }]);
  app.replaceChildren(h('div', { class: 'pf-login pf-card' }, h('h1', '請先變更密碼'), h('p', { class: 'muted' }, '首次登入或密碼被重設後，需要設定自己的密碼。'), f.el,
    h('div', { class: 'pf-actions' }, action('變更密碼', async () => {
      const v = f.read(); if (!v) return;
      if (v.newPassword !== v.again) throw new Error('兩次輸入的新密碼不同');
      await post('me/password', v); toast('密碼已變更'); await boot();
    }, 'primary'), btn('登出', logout))));
}

async function logout() { await fetch('/api/logout', { method: 'POST' }); state.me = null; loginView(); }

function shell() {
  const orgs = state.me.orgs.filter((o) => o.kind !== 'group' || o.actions.length > 1);
  if (!state.orgId || !orgs.some((o) => o.id === state.orgId)) {
    const saved = (() => { try { return localStorage.getItem('pf.org'); } catch { return null; } })();
    state.orgId = orgs.find((o) => o.id === saved)?.id || orgs.find((o) => o.kind !== 'group')?.id || orgs[0]?.id || null;
  }
  const orgSel = h('select', { 'aria-label': '院所', onchange: (e) => { state.orgId = e.target.value; state.dirCache.clear(); try { localStorage.setItem('pf.org', state.orgId); } catch { /* 無痕模式 */ } buildNav(); render(); } },
    orgs.map((o) => h('option', { value: o.id }, `${o.kind === 'group' ? '▣ ' : o.kind === 'branch' ? '　└ ' : ''}${o.name}`)));
  orgSel.value = state.orgId || '';
  const yearSel = h('select', { 'aria-label': '年度', onchange: (e) => { state.year = Number(e.target.value); render(); } },
    Array.from({ length: 6 }, (_, i) => new Date().getFullYear() + 1 - i).map((y) => h('option', { value: y }, `${y}（民國 ${y - 1911}）`)));
  yearSel.value = state.year;
  const bell = h('button', { type: 'button', class: 'ghost pf-bell', 'aria-label': '通知', onclick: openNotifications }, '🔔', h('i', { class: 'pf-hidden', id: 'bellN' }));
  const nav = h('nav', { class: 'pf-nav', id: 'pfNav', 'aria-label': '主選單' });
  const main = h('main', { class: 'pf-main', id: 'pfMain' });
  app.replaceChildren(h('div', { class: 'pf-app' },
    h('header', { class: 'pf-top' }, btn('☰', () => nav.classList.toggle('open'), 'ghost pf-navtoggle', { 'aria-label': '開關選單' }), h('span', { class: 'pf-brand' }, '油水電氣資料治理平台'),
      orgSel, yearSel, h('div', { class: 'grow' }), bell, h('span', { class: 'muted pf-small' }, state.me.user.display_name),
      btn('帳號', () => go('#/me'), 'ghost'), btn('登出', logout, 'ghost')),
    nav, main));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) nav.classList.remove('open'); });
  mountShell(main, nav);
  buildNav();
  refreshBell();
}

function buildNav() {
  const nav = $('#pfNav');
  nav.replaceChildren(...NAV.map(([title, items]) => {
    const vis = items.filter(([, , need]) => !need || can(need) || (need === 'view.internal' && isGlobalAdmin()));
    if (!vis.length) return null;
    return h('div', h('h3', title), vis.map(([href, label]) => h('a', { href }, label)));
  }).filter(Boolean), state.me.legacyHid ? h('div', h('h3', '舊版入口'), h('a', { href: '/' }, '🔋 健檢填報、能源盤點、看板維護')) : null);
}

async function refreshBell() {
  try {
    const n = await get('notifications', { unread: '1' });
    const el = $('#bellN'); if (!el) return;
    el.textContent = n.length > 99 ? '99+' : String(n.length); el.classList.toggle('pf-hidden', !n.length);
  } catch { /* 忽略 */ }
}
setInterval(() => { if (state.me) refreshBell(); }, 60000);

async function openNotifications() {
  const list = await get('notifications');
  const drawer = h('aside', { class: 'pf-drawer', role: 'dialog', 'aria-label': '通知' },
    h('div', { class: 'pf-bar' }, h('h2', '通知'), h('div', { class: 'grow' }), action('全部標為已讀', async () => { await post('notifications/read', { ids: 'all' }); drawer.remove(); refreshBell(); }), btn('關閉', () => drawer.remove(), 'ghost')),
    list.length ? h('ul', { class: 'pf-timeline' }, list.map((n) => h('li', h('time', fmtTime(n.created_at)), h('a', { href: n.link || '#/', onclick: () => { post('notifications/read', { ids: [n.id] }); drawer.remove(); setTimeout(refreshBell, 300); } }, n.read_at ? n.title : `● ${n.title}`), n.body ? h('div', { class: 'muted pf-small' }, n.body) : null)))
      : h('p', { class: 'muted' }, '沒有通知'));
  document.body.append(drawer);
}

async function boot() {
  try {
    state.me = await get('me');
  } catch (e) { if (e.status === 401 || e.status === 403) { if (location.hash === '#/password') return passwordView(); return loginView(); } throw e; }
  if (state.me.user.must_change && !state.me.user.legacy) return passwordView();
  state.meta = await get('meta');
  if (['/login', '/password'].includes(currentPath())) history.replaceState(null, '', '#/');
  shell();
  render();
}

for (const m of [workbench, assets, sources, collect, quality, datasets, reports, dash, admin, ghg]) m.register?.();

// 自己的帳號
route('/me', async () => {
  const me = state.me;
  const totp = h('div');
  const drawTotp = () => totp.replaceChildren(me.user.totp_enabled ? h('p', '✅ 已啟用兩步驟驗證', ' ', action('關閉', async () => { await post('me/totp/disable'); me.user.totp_enabled = 0; drawTotp(); })) :
    action('啟用兩步驟驗證', async () => {
      const r = await post('me/totp/start');
      const f = form([{ key: 'code', label: '驗證器 App 顯示的 6 位數', required: true, inputmode: 'numeric' }]);
      const { modal } = await import('./core.js');
      await modal('啟用兩步驟驗證', h('div', h('p', '在驗證器 App（Google Authenticator、Microsoft Authenticator 等）手動新增，金鑰：'), h('p', { class: 'pf-mono' }, r.secret), h('p', { class: 'pf-mono pf-small' }, r.uri), f.el),
        { okText: '確認', onOk: async () => { const v = f.read(); if (!v) return false; await post('me/totp/confirm', v); me.user.totp_enabled = 1; toast('已啟用'); drawTotp(); } });
    }));
  drawTotp();
  const pw = form([{ key: 'oldPassword', label: '目前密碼', type: 'password', required: true }, { key: 'newPassword', label: '新密碼', type: 'password', required: true, hint: '至少 10 字，含英文與數字' }]);
  const { page, card, dl, table, orgName, chip } = await import('./core.js');
  return page('我的帳號', {}, card('基本資料', dl([['帳號', me.user.username], ['姓名', me.user.display_name], ['單位', me.user.unit], ['Email', me.user.email]])),
    card('角色與範圍', table([{ label: '角色', render: (g) => state.meta.roles[g.role]?.name || g.role }, { label: '範圍', render: (g) => (g.scope_type === 'global' ? '全部院所' : orgName(g.scope_id)) }], me.grants)),
    me.user.legacy ? card('密碼', h('p', { class: 'muted' }, '院所共用帳號的密碼請由維護窗口變更。請在「帳號與權限」替同仁建立個人帳號。')) :
      card('變更密碼', pw.el, h('div', { class: 'pf-actions' }, action('變更', async () => { const v = pw.read(); if (!v) return; await post('me/password', v); toast('密碼已變更'); }, 'primary'))),
    me.user.legacy ? null : card('兩步驟驗證', totp), chip('角色說明：見系統管理 › 帳號與權限'));
}, { title: '我的帳號' });

route('/login', async () => { loginView(); return h('div'); }, { auth: false });
route('/password', async () => { passwordView(); return h('div'); }, { auth: false });

window.addEventListener('hashchange', () => {
  if (!state.me) { if (currentPath() === '/password') return passwordView(); return boot().catch(() => loginView()); }
  render();
});
boot().catch((e) => { app.replaceChildren(h('div', { class: 'pf-login pf-card' }, h('h1', '無法載入'), h('p', { class: 'err' }, e.message))); });
