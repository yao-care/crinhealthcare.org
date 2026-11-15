// 平台前端共用核心（原生 ES module，無 build）。頁面模組只透過這裡的函式操作 DOM 與 API。
// 安全：一律用 textContent 產生文字，不用 innerHTML 插入任何資料。

// 盤查與申報都是做「前一年」的資料，預設年度取去年
export const state = { me: null, meta: null, orgId: null, year: new Date().getFullYear() - 1, dirCache: new Map() };

// ── API ──
export async function api(path, { method = 'GET', body, form, query } = {}) {
  let url = path.startsWith('/') ? path : `/api/v1/${path}`;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...qs].length) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const init = { method, credentials: 'same-origin', headers: {} };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, init);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) { location.hash = '#/login'; throw Object.assign(new Error('請重新登入'), { status: 401 }); }
  if (res.status === 403 && data?.error === 'must_change_password') { location.hash = '#/password'; throw Object.assign(new Error(data.message), { status: 403 }); }
  if (!res.ok || data?.ok === false) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data?.data;
}
export const get = (p, query) => api(p, { query });
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
export async function upload(path, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null) fd.append(k, v);
  if (file) fd.append('file', file, file.name);
  return api(path, { method: 'POST', form: fd });
}

// ── DOM ──
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };
export const link = (href, text, cls) => h('a', { href, class: cls }, text);
export const btn = (text, onClick, cls = '', attrs = {}) => h('button', { type: 'button', class: cls, onclick: onClick, ...attrs }, text);

// 非同步按鈕：執行中停用、失敗 toast
export function action(text, fn, cls = '', attrs = {}) {
  const b = btn(text, async () => {
    b.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
  }, cls, attrs);
  return b;
}

// ── 提示 ──
let toastTimer;
export function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'err' ? 7000 : 3500);
}

// 對話框：回 Promise；content 是 Node；okText=null 表示只有關閉鈕
export function modal(title, content, { okText = '確定', cancelText = '取消', onOk } = {}) {
  return new Promise((resolve) => {
    const m = $('#modal'); $('#modalTitle').textContent = title;
    const body = $('#modalBody'); body.replaceChildren(content);
    const ok = $('#modalOk'); const cancel = $('#modalCancel');
    ok.textContent = okText || ''; ok.classList.toggle('hidden', !okText); cancel.textContent = cancelText;
    m.classList.remove('hidden');
    const close = (v) => { m.classList.add('hidden'); ok.onclick = null; cancel.onclick = null; resolve(v); };
    ok.onclick = async () => {
      if (!onOk) return close(true);
      ok.disabled = true;
      try { const r = await onOk(); if (r !== false) close(r ?? true); } catch (e) { toast(e.message, 'err'); } finally { ok.disabled = false; }
    };
    cancel.onclick = () => close(null);
    setTimeout(() => body.querySelector('input,select,textarea')?.focus(), 30);
  });
}
export const confirmBox = (title, text, okText = '確定') => modal(title, h('p', text), { okText });

// 表單對話框：fields 同 form()；onSubmit(values) 拋錯則保持開啟
export function formModal(title, fields, values = {}, onSubmit, okText = '儲存') {
  const f = form(fields, values);
  return modal(title, f.el, { okText, onOk: async () => { const v = f.read(); if (!v) return false; return (await onSubmit(v)) ?? true; } });
}

// ── 表單 ──
// field：{ key, label, type: text|number|date|month|select|textarea|checkbox|password|file|json, options:[[value,label]], required, hint, wide, placeholder, readonly }
export function form(fields, values = {}) {
  const el = h('div', { class: 'pf-form' });
  const inputs = {};
  for (const f of fields) {
    if (f.type === 'heading') { el.append(h('h3', { class: 'wide', style: null }, f.label)); continue; }
    let input;
    const v = values[f.key] ?? f.default ?? '';
    if (f.type === 'select') {
      input = h('select', { name: f.key, disabled: f.readonly }, f.required ? null : h('option', { value: '' }, f.placeholder || '（未選）'),
        (f.options || []).map(([ov, ol]) => h('option', { value: ov }, ol)));
      input.value = v ?? '';
    } else if (f.type === 'textarea' || f.type === 'json') {
      input = h('textarea', { name: f.key, placeholder: f.placeholder, readonly: f.readonly });
      input.value = f.type === 'json' && typeof v !== 'string' ? JSON.stringify(v ?? {}, null, 2) : v;
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', name: f.key, checked: !!v, disabled: f.readonly });
    } else {
      input = h('input', { type: f.type || 'text', name: f.key, placeholder: f.placeholder, readonly: f.readonly, step: f.type === 'number' ? 'any' : undefined, accept: f.accept, inputmode: f.inputmode });
      if (f.type !== 'file') input.value = v ?? '';
    }
    inputs[f.key] = input;
    const label = h('label', { class: [f.wide ? 'wide' : '', f.required ? 'req' : '', f.type === 'checkbox' ? 'check' : ''].join(' ') },
      f.type === 'checkbox' ? [input, h('span', f.label)] : [h('span', f.label), input], f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    el.append(label);
  }
  const read = () => {
    const out = {};
    for (const f of fields) {
      if (f.type === 'heading') continue;
      const i = inputs[f.key];
      let v = f.type === 'checkbox' ? i.checked : f.type === 'file' ? i.files[0] : i.value.trim();
      if (f.type === 'number' && v !== '') v = Number(v);
      if (f.type === 'json') { try { v = v ? JSON.parse(v) : null; } catch { toast(`${f.label} 不是有效的 JSON`, 'err'); i.focus(); return null; } }
      if (f.required && (v === '' || v === undefined || v === null)) { toast(`請填「${f.label}」`, 'err'); i.focus(); return null; }
      out[f.key] = v === '' ? undefined : v;
    }
    return out;
  };
  return { el, read, inputs };
}

// ── 表格 ──
// columns：{ label, key, num, render(row) → Node|string, cls }
export function table(columns, rows, { empty = '沒有資料', onRow, rowClass } = {}) {
  if (!rows?.length) return h('div', { class: 'pf-table-wrap' }, h('div', { class: 'pf-empty' }, empty));
  return h('div', { class: 'pf-table-wrap' }, h('table', { class: 'pf-table' },
    h('thead', h('tr', columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', rows.map((r) => {
      const tr = h('tr', { class: rowClass?.(r) || '' }, columns.map((c) => {
        const v = c.render ? c.render(r) : r[c.key];
        return h('td', { class: [c.num ? 'num' : '', c.cls || ''].join(' ') }, v instanceof Node ? v : v === null || v === undefined || v === '' ? '—' : c.num && typeof v === 'number' ? fmtNum(v) : String(v));
      }));
      if (onRow) { tr.style.cursor = 'pointer'; tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input,select')) onRow(r); }); }
      return tr;
    }))));
}

// ── 格式 ──
export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v); if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('zh-TW', { maximumFractionDigits: d });
}
export const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
export const fmtTime = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');
// 半開區間 → 畫面上的含迄日
export function fmtPeriod(start, end) {
  if (!start) return '—';
  if (!end || end === start) return start;
  const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  const e = d.toISOString().slice(0, 10);
  if (start.endsWith('-01') && e.slice(0, 7) === start.slice(0, 7) && new Date(`${end}T00:00:00Z`).getUTCDate() === 1) return start.slice(0, 7);
  return `${start}～${e}`;
}
export const inclEndToExcl = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
export const chip = (text, kind = '') => h('span', { class: `pf-chip ${kind}` }, text);
export function domainChip(d) { const m = state.meta?.domains?.[d]; return chip(m ? `${m.icon} ${m.name}` : d, d); }
const WS_KIND = { to_register: 'todo', finding_source: 'warn', source_found: 'info', collecting: 'info', to_validate: 'info', discrepancy: 'alert', to_review: 'info', approved: 'ok', locked: 'ok', returned: 'alert', paused: '' };
export const workChip = (s) => chip(state.meta?.workStatus?.[s] || s, WS_KIND[s]);
const VS_KIND = { measured: 'ok', zero: 'ok', estimated: 'warn', partial: 'warn', missing: 'alert', not_applicable: '', unknown: 'todo', pending_period_end: 'info', blocked: 'alert' };
export const valueStateChip = (s) => chip(state.meta?.valueStates?.[s] || { measured: '實測', zero: '實際為零', unknown: '未知', pending_period_end: '尚未到期末' }[s] || s, VS_KIND[s]);
const Q_LABEL = { pending_validation: ['待檢核', 'todo'], valid: ['通過', 'ok'], warning: ['有警示', 'warn'], invalid: ['未通過', 'alert'], superseded: ['已取代', ''] };
export const qualityChip = (s) => chip(...(Q_LABEL[s] || [s, '']));
export const sevChip = (s) => chip({ low: '低', medium: '中', high: '高', critical: '緊急', info: '提示', warning: '警示', error: '錯誤', blocker: '阻擋' }[s] || s, { high: 'alert', critical: 'alert', error: 'alert', blocker: 'alert', medium: 'warn', warning: 'warn', low: '', info: 'info' }[s]);
export const ownerChip = (s) => chip({ unknown: '保管者未知', candidate: '候選窗口', confirmed: '已確認保管者' }[s] || s, { unknown: 'warn', candidate: 'info', confirmed: 'ok' }[s]);
export const applicChip = (s) => chip(state.meta?.applicability?.[s] || s, { applicable: 'ok', not_applicable: '', pending: 'warn', undetermined: 'todo' }[s]);
export const metricName = (code) => state.meta?.metrics?.find((m) => m.code === code)?.name || code;
export const metricOf = (code) => state.meta?.metrics?.find((m) => m.code === code);
export const itemOf = (id) => state.meta?.items?.find((i) => i.id === id || i.code === id);
export const assetTypeName = (t) => state.meta?.assetTypes?.[t] || t;
export const orgName = (id) => state.me?.orgs?.find((o) => o.id === id)?.name || id;

// ── 權限 ──
export function can(action, orgId = state.orgId) {
  const o = state.me?.orgs?.find((x) => x.id === orgId);
  if (o) return o.actions.includes(action);
  return state.me?.orgs?.some((x) => x.actions.includes(action));
}
export const isGlobalAdmin = () => !!state.me?.isGlobalAdmin;

// 同院所人員清單（指派用）
export async function directory(orgId = state.orgId) {
  if (!state.dirCache.has(orgId)) state.dirCache.set(orgId, await get('users/directory', { orgId }).catch(() => []));
  return state.dirCache.get(orgId);
}
export async function userOptions(orgId) { return (await directory(orgId)).map((u) => [u.id, `${u.display_name}${u.unit ? `（${u.unit}）` : ''}`]); }
export const metricOptions = (domain) => (state.meta?.metrics || []).filter((m) => !domain || m.domain === domain).map((m) => [m.code, `${m.name}（${m.std_unit}）`]);
export const itemOptions = (domains) => (state.meta?.items || []).filter((i) => !domains || domains.includes(i.domain)).map((i) => [i.id, `${state.meta.domains[i.domain]?.icon || ''} ${i.code} ${i.name}`]);

// ── 路由 ──
const routes = [];
export function route(pattern, render, { title, auth = true } = {}) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ pattern, re, keys, render, title, auth });
}
export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
export function currentPath() { return (location.hash || '#/').slice(1).split('?')[0] || '/'; }
export function currentQuery() { return Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || '')); }

let mainEl = null; let navEl = null; let renderSeq = 0;
export function mountShell(main, nav) { mainEl = main; navEl = nav; }
export async function render() {
  const path = currentPath();
  const r = routes.find((x) => x.re.test(path));
  const seq = ++renderSeq;
  if (!r) { mainEl?.replaceChildren(h('div', { class: 'pf-card' }, h('h1', '找不到頁面'), link('#/', '回工作台'))); return; }
  const m = r.re.exec(path); const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  if (navEl) for (const a of navEl.querySelectorAll('a')) a.classList.toggle('on', path === a.getAttribute('href').slice(1) || (a.getAttribute('href') !== '#/' && path.startsWith(a.getAttribute('href').slice(1) + '/')));
  if (!mainEl) return;
  mainEl.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
  try {
    const node = await r.render(params, currentQuery());
    if (seq !== renderSeq) return;
    mainEl.replaceChildren(node);
    document.title = `${r.title || '平台'}｜油水電氣資料治理平台`;
    mainEl.querySelector('h1')?.focus?.();
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return;
    mainEl.replaceChildren(h('div', { class: 'pf-card' }, h('h1', '無法載入'), h('p', { class: 'err' }, e.message),
      e.status === 403 ? h('p', { class: 'muted' }, '若需要此權限，請洽本院的院所管理者或系統管理員。') : null));
  }
}

// 頁面骨架：標題＋麵包屑＋動作列
export function page(title, { crumbs = [], actions = [], intro } = {}, ...body) {
  return frag(
    crumbs.length ? h('div', { class: 'pf-crumb' }, crumbs.map((c, i) => [i ? ' › ' : '', Array.isArray(c) ? link(c[0], c[1]) : c])) : null,
    h('div', { class: 'pf-bar' }, h('h1', { tabindex: '-1', style: null }, title), h('div', { class: 'grow' }), actions),
    intro ? h('p', { class: 'muted' }, intro) : null,
    body,
  );
}
export const card = (title, ...kids) => h('section', { class: 'pf-card' }, title ? h('h2', title) : null, kids);
export function tabs(items, active) {
  return h('nav', { class: 'pf-tabs' }, items.map(([href, label]) => h('a', { href, class: href === active ? 'on' : '' }, label)));
}
export const dl = (pairs) => h('dl', { class: 'pf-dl' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', k), h('dd', v instanceof Node ? v : v ?? '—')]));
export function progress(pct) { return h('div', { class: 'pf-progress', title: pct === null ? '無資料' : `${pct}%` }, h('i', { style: `width:${Math.max(0, Math.min(100, pct || 0))}%` })); }
export function kpiRow(label, pct, hint) { return h('div', { class: 'pf-kpi', title: hint || '' }, h('span', label), progress(pct), h('b', pct === null || pct === undefined ? '—' : `${pct}%`)); }
export function bars(points, { unit = '', max } = {}) {
  const m = max ?? Math.max(1, ...points.map((p) => p.value || 0));
  return h('div', { class: 'pf-bars', role: 'img', 'aria-label': points.map((p) => `${p.label} ${fmtNum(p.value)}${unit}`).join('，') },
    points.map((p) => h('div', { title: `${p.label}：${fmtNum(p.value)} ${unit}` }, h('i', { style: `height:${Math.round((p.value || 0) / m * 100)}%` }), h('span', p.label))));
}
export const note = (text, kind = '') => h('div', { class: `pf-note ${kind}` }, text);
export function select(options, value, onChange, attrs = {}) {
  const s = h('select', attrs, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value ?? ''; s.addEventListener('change', () => onChange(s.value));
  return s;
}
export function searchBox(value, onSearch, placeholder = '搜尋…') {
  const i = h('input', { type: 'search', placeholder, value });
  let t; i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onSearch(i.value.trim()), 300); });
  return i;
}
// 查詢字串更新（不重新整理頁面以外的狀態）
export function setQuery(patchQ) {
  const qy = { ...currentQuery(), ...patchQ };
  for (const k of Object.keys(qy)) if (qy[k] === '' || qy[k] === undefined || qy[k] === null) delete qy[k];
  const s = new URLSearchParams(qy).toString();
  go(`#${currentPath()}${s ? `?${s}` : ''}`);
}
export function download(path, query) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const a = h('a', { href: `${path.startsWith('/') ? path : `/api/v1/${path}`}${qs}`, target: '_blank', rel: 'noopener' }); document.body.append(a); a.click(); a.remove();
}
export const needOrg = () => { if (!state.orgId) throw Object.assign(new Error('請先在上方選擇院所'), { status: 400 }); return state.orgId; };
