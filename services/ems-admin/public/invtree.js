'use strict';
// 盤點樹：院所頁的左欄樹＋中欄節點內容＋右欄報告欄位。資料走平台 /api/v1（主機本地 SQLite）。
//
// 左欄：盤點 › 油／水／電／氣（一次只展開一類）。電分「台電」（電號＝受電總盤 → 分盤 → 電表／設備）與「分區」（建物 → 樓層、周邊）。
//       名稱＝看內容；〔管理〕＝進項目管理（新增、改名、停用、來源、供電範圍都在管理裡做，看內容的畫面不放編輯鈕）。
// 中欄：節點內容。電表類畫「數值來源 → 本表 → 下游」關聯圖，同一顆表的智慧電表、手抄表、帳單並排比對逐月差異，分盤合計對總盤。
// 右欄：點中欄任一張卡或來源，顯示它會進到哪些報告的哪一格。
//
// 由 app.js 掛進導覽：section id 以 tree: 或 mng: 開頭。
(function () {
  const UI = window.EMSUI;
  if (!UI) return;
  const { el, toast, confirmModal } = UI;

  let ORG = null, TREE = null, META = null, READY = false;
  let OPEN = lsGet('open') || 'electricity';
  const COLLAPSED = new Set(JSON.parse(lsGet('collapsed') || '[]'));
  let YEAR = new Date().getFullYear();
  let METRIC = null;              // 中欄選的指標（換節點時清掉）
  let FOCUS = null;               // 右欄焦點 { assetId, metric, label } 或 { zone: true, label }
  let CUR = null;                 // 目前節點資料
  let drawSeq = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => drawLinks()) : null;

  function lsGet(k) { try { return localStorage.getItem('ems.invtree.' + k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem('ems.invtree.' + k, v); } catch {} }

  async function call(path, opts = {}) {
    const o = { ...opts };
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { 'content-type': 'application/json', ...(o.headers || {}) }; delete o.json; }
    const { status, body } = await UI.api(path, o);
    if (!body?.ok) { const e = new Error(body?.message || body?.error || `HTTP ${status}`); e.status = status; throw e; }
    return body.data;
  }
  const post = (p, json, method = 'POST') => call(p, { method, json });

  // ── 格式 ──
  const fmt = (v, d = 0) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: d }));
  const ym = (s) => (s ? `${Number(s.slice(0, 4)) - 1911} 年 ${Number(s.slice(5, 7))} 月` : '');
  const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  const KIND_ICON = { bill: '🧾', ems: '📡', manual: '✍', api: '🔌', file: '📄', document: '📄', system: '🖥', contract: '📑', record: '🗒' };
  const KIND_LABEL = { bill: '帳單', ems: '智慧電表／EMS', manual: '手抄表', api: '介接', file: '檔案', document: '文件', system: '系統', contract: '契約', record: '紀錄' };
  const EXPECTED_SOURCES = { generator: ['bill', 'record'], fuel_tank: ['bill', 'manual'], power_account: ['bill', 'ems', 'manual'], panel: ['ems', 'manual'], power_meter: ['ems', 'manual'], water_account: ['bill', 'manual'], water_meter: ['manual'], gas_account: ['bill', 'manual'], gas_meter: ['manual'] };

  // ── 載入 ──
  async function load() {
    READY = false;
    try {
      const me = await UI.api('/api/me');
      const hid = me.body?.hid;
      if (!hid) return false;
      const orgs = await call('/api/v1/orgs');
      ORG = orgs.find((o) => o.legacy_hid === hid) || null;
      if (!ORG) return false;
      [TREE, META] = await Promise.all([call(`/api/v1/orgs/${ORG.id}/inv-tree`), META ? Promise.resolve(META) : call('/api/v1/meta')]);
      READY = true;
    } catch { READY = false; }
    return READY;
  }
  async function reloadTree() { TREE = await call(`/api/v1/orgs/${ORG.id}/inv-tree`); window.EMSInvTreeHost?.navChanged?.(); }

  // ── 樹的查找 ──
  function walk(fn) {
    const rec = (n, dom, path) => { fn(n, dom, path); for (const c of n.children || []) rec(c, dom, [...path, n]); };
    for (const d of TREE?.domains || []) for (const c of d.children || []) rec(c, d, []);
  }
  function findNode(kind, id) { let hit = null; walk((n, d, path) => { if (!hit && n.kind === kind && n.id === id) hit = { n, d, path }; }); return hit; }
  const domainOf = (key) => TREE?.domains.find((d) => d.key === key);
  function assetsIn(domKey) { const out = []; walk((n, d, path) => { if (n.kind === 'asset' && d.key === domKey) out.push({ ...n, depth: path.filter((p) => p.kind === 'asset').length }); }); return out; }
  const buildings = () => domainOf('electricity')?.children.find((c) => c.kind === 'zones')?.children || [];

  // ════════════════ 左欄 ════════════════
  function sectionId(n) {
    if (n.kind === 'asset') return `tree:asset:${n.id}`;
    if (n.kind === 'group') return `tree:group:${n.id}`;
    if (n.kind === 'tpc') return 'tree:tpc';
    if (n.kind === 'zones') return 'tree:zones';
    if (n.kind === 'building') return `tree:building:${n.id}`;
    if (n.kind === 'floor') return `tree:floor:${n.id}`;
    return 'tree:inv';
  }
  function manageId(n) {
    if (n.kind === 'tpc') return 'mng:tpc';
    if (n.kind === 'zones') return 'mng:zones';
    if (n.kind === 'asset') return `mng:asset:${n.id}`;
    return null;
  }
  function mbtn(id, activeId, title) {
    const b = el('button', { type: 'button', class: 'tv-mng' + (id === activeId ? ' active' : ''), text: '管理', title });
    b.addEventListener('click', (e) => { e.stopPropagation(); UI.goSection(id); });
    return b;
  }
  function nodeRow(n, depth, activeId, domKey) {
    const id = sectionId(n);
    const kids = n.children || [];
    const key = `${domKey}:${n.kind}:${n.id}`;
    const closed = COLLAPSED.has(key);
    const row = el('div', { class: 'tv-row' + (id === activeId ? ' active' : '') });
    row.style.setProperty('--d', String(depth));
    const caret = el('button', { type: 'button', class: 'tv-caret', text: kids.length ? (closed ? '▸' : '▾') : '', 'aria-label': closed ? '展開' : '收合' });
    if (kids.length) caret.addEventListener('click', () => { closed ? COLLAPSED.delete(key) : COLLAPSED.add(key); lsSet('collapsed', JSON.stringify([...COLLAPSED])); window.EMSInvTreeHost?.navChanged?.(); });
    else caret.disabled = true;
    const name = el('button', { type: 'button', class: 'tv-name', 'data-sec': id }, [
      el('span', { text: n.name }),
      n.kind === 'asset' && n.sources ? el('i', { class: 'tv-n', text: String(n.sources), title: `${n.sources} 個數值來源` }) : null,
    ]);
    name.addEventListener('click', () => UI.goSection(id));
    row.append(caret, name);
    const m = n.manage ? manageId(n) : null;
    if (m) row.append(mbtn(m, activeId, `管理「${n.name}」`));
    const out = [row];
    if (!closed) for (const c of kids) out.push(...nodeRow(c, depth + 1, activeId, domKey));
    return out;
  }
  // 目前節點屬於哪一類：從別處跳進來（例：管理油、點樓層）時左欄自動展開那一類
  function domainForSection(id) {
    const [, sub, ...rest] = String(id || '').split(':'); const arg = rest.join(':');
    if (sub === 'dom') return arg;
    if (['tpc', 'zones', 'building', 'floor'].includes(sub)) return 'electricity';
    if (sub === 'asset' || sub === 'group') return findNode(sub, arg)?.d.key || null;
    return null;
  }
  function navNode(activeId) {
    const box = el('div', { class: 'tv-nav' });
    const dk = READY ? domainForSection(activeId) : null;
    if (dk && dk !== OPEN) { OPEN = dk; lsSet('open', dk); }
    const head = el('div', { class: 'tv-top' + (activeId === 'tree:inv' ? ' active' : '') }, [
      (() => { const b = el('button', { type: 'button', class: 'tv-topname', text: '📦 盤點' }); b.addEventListener('click', () => UI.goSection('tree:inv')); return b; })(),
      mbtn('mng:inv', activeId, '盤點總覽與新增標的'),
    ]);
    box.append(head);
    if (!READY) { box.append(el('p', { class: 'tv-empty', text: '盤點資料載入失敗，請重新整理。' })); return box; }
    for (const d of TREE.domains) {
      const open = OPEN === d.key;
      const dh = el('div', { class: 'tv-dom' + (open ? ' open' : '') + (activeId === `tree:dom:${d.key}` ? ' active' : '') });
      const t = el('button', { type: 'button', class: 'tv-domname', 'aria-expanded': String(open) }, [
        el('span', { class: 'tv-dcaret', text: open ? '▾' : '▸' }), el('span', { text: `${d.icon} ${d.label}` }), d.count ? el('i', { class: 'tv-n', text: String(d.count) }) : null,
      ]);
      t.setAttribute('aria-expanded', String(open));
      t.addEventListener('click', () => { OPEN = d.key; lsSet('open', d.key); UI.goSection(`tree:dom:${d.key}`); });
      dh.append(t, mbtn(`mng:dom:${d.key}`, activeId, `管理${d.label}的盤點項目`));
      box.append(dh);
      if (!open) continue;
      if (!d.children.length) box.append(el('p', { class: 'tv-empty', text: '還沒有項目，按〔管理〕新增。' }));
      for (const c of d.children) box.append(...nodeRow(c, 1, activeId, d.key));
    }
    return box;
  }

  // ════════════════ 中欄＋右欄 ════════════════
  function layout(root) {
    root.textContent = '';
    const main = el('div', { class: 'tv-main' });
    const side = el('aside', { class: 'tv-side', 'aria-label': '對應報告欄位' });
    root.append(el('div', { class: 'tv' }, [main, side]));
    return { main, side };
  }
  function h2(text, chips = []) {
    return el('div', { class: 'i-head' }, [el('h2', { text }), ...chips.filter(Boolean).map((c) => el('span', { class: 'tv-chip', text: c }))]);
  }
  function wrapErr(root, fn) {
    return fn().catch((e) => { root.textContent = ''; root.append(el('p', { class: 'err', text: `載入失敗：${e.message}` })); });
  }

  function render(id, root) {
    if (!READY) { root.textContent = ''; root.append(el('p', { class: 'err', text: '盤點資料載入失敗，請重新整理。' })); return; }
    const [kind, sub, ...rest] = id.split(':');
    const arg = rest.join(':');
    // 換節點時指標與右欄焦點歸零
    if (render.last !== id) { METRIC = null; FOCUS = null; render.last = id; }
    if (kind === 'mng') return wrapErr(root, () => renderManage(sub, arg, root));
    if (sub === 'inv') return renderOverview(root);
    if (sub === 'dom') return renderDomain(arg, root);
    if (sub === 'tpc') return renderTpc(root);
    if (sub === 'zones') return renderZones(root);
    if (sub === 'group') return renderGroup(arg, root);
    if (sub === 'asset') return wrapErr(root, () => renderAsset(arg, root));
    if (sub === 'building' || sub === 'floor') return wrapErr(root, () => renderZone(sub, arg, root));
    root.append(el('p', { class: 'note', text: '此節點沒有內容。' }));
  }
  function labelFor(id) {
    const [kind, sub, ...rest] = id.split(':'); const arg = rest.join(':');
    const pre = kind === 'mng' ? '管理 › ' : '';
    if (sub === 'inv') return `${pre}盤點`;
    if (sub === 'dom') return `${pre}盤點 › ${domainOf(arg)?.label || arg}`;
    if (sub === 'tpc') return `${pre}盤點 › 電 › 台電`;
    if (sub === 'zones') return `${pre}盤點 › 電 › 分區`;
    const kindMap = { asset: 'asset', group: 'group', building: 'building', floor: 'floor' };
    const f = kindMap[sub] ? findNode(sub, arg) : null;
    if (f) return `${pre}盤點 › ${f.d.label} › ${[...f.path.map((p) => p.name), f.n.name].join(' › ')}`;
    return `${pre}盤點`;
  }

  // ── 右欄 ──
  async function renderSide(side) {
    side.textContent = '';
    side.append(el('h3', { class: 'tv-sideh', text: '對應報告欄位' }));
    if (!FOCUS) { side.append(el('p', { class: 'muted', text: '點中間的卡片或來源，這裡會列出它會填進哪些報告的哪一格。' })); return; }
    side.append(el('p', { class: 'tv-focus', text: FOCUS.label }));
    const box = el('div', { class: 'tv-fields', text: '載入中…' });
    side.append(box);
    const seq = ++drawSeq;
    let fields = FOCUS.fields;
    try {
      if (!fields) fields = await call(FOCUS.zone ? '/api/v1/inv-fields' : `/api/v1/inv-fields?assetId=${encodeURIComponent(FOCUS.assetId)}${FOCUS.metric ? `&metric=${encodeURIComponent(FOCUS.metric)}` : ''}`);
    } catch (e) { box.textContent = `載入失敗：${e.message}`; return; }
    if (seq !== drawSeq) return;
    box.textContent = '';
    if (FOCUS.note) box.append(el('p', { class: 'tv-note', text: FOCUS.note }));
    if (!fields.length) {
      box.append(el('p', { class: 'muted', text: FOCUS.empty || '目前沒有報告欄位直接引用這一項。' }));
      return;
    }
    const groups = new Map();
    for (const f of fields) { if (!groups.has(f.template)) groups.set(f.template, []); groups.get(f.template).push(f); }
    for (const [tpl, list] of groups) {
      const d = el('details', { class: 'tv-tpl', open: groups.size <= 4 });
      d.append(el('summary', {}, [el('span', { text: tpl }), el('i', { class: 'tv-n', text: String(list.length) })]));
      const ul = el('ul');
      for (const f of list) ul.append(el('li', {}, [el('span', { class: 'tv-sec', text: f.section }), el('b', { text: f.field }), el('span', { class: 'tv-how', text: f.how })]));
      d.append(ul);
      box.append(d);
    }
  }
  function focus(f, side) {
    FOCUS = f;
    document.querySelectorAll('.tv-card.sel, .tv-th.sel').forEach((n) => n.classList.remove('sel'));
    if (f.el) f.el.classList.add('sel');
    renderSide(side);
  }

  // ── 關聯圖：三欄卡片＋SVG 連線（連線在版面排好後依實際位置畫，視窗改變時重畫）──
  let LINKS = null;   // { box, svg, edges: [[fromEl, toEl, dashed]] }
  function drawLinks() {
    if (!LINKS || !LINKS.box.isConnected) return;
    const { box, svg, edges } = LINKS;
    const r0 = box.getBoundingClientRect();
    svg.setAttribute('width', String(r0.width)); svg.setAttribute('height', String(r0.height));
    svg.textContent = '';
    const NS = 'http://www.w3.org/2000/svg';
    for (const [a, b, dashed] of edges) {
      if (!a?.isConnected || !b?.isConnected) continue;
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
      let x1, y1, x2, y2;
      if (Math.abs(ra.left - rb.left) < 8) { // 同一欄：上 → 下
        x1 = ra.left + ra.width / 2 - r0.left; y1 = ra.bottom - r0.top; x2 = rb.left + rb.width / 2 - r0.left; y2 = rb.top - r0.top;
      } else {
        x1 = ra.right - r0.left; y1 = ra.top + ra.height / 2 - r0.top; x2 = rb.left - r0.left; y2 = rb.top + rb.height / 2 - r0.top;
      }
      const p = document.createElementNS(NS, 'path');
      const vertical = Math.abs(ra.left - rb.left) < 8;
      const d = vertical ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1 + (x2 - x1) / 2},${y1} ${x1 + (x2 - x1) / 2},${y2} ${x2},${y2}`;
      p.setAttribute('d', d); p.setAttribute('class', 'tv-edge' + (dashed ? ' dashed' : ''));
      svg.append(p);
      const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', String(x2)); c.setAttribute('cy', String(y2)); c.setAttribute('r', '4'); c.setAttribute('class', 'tv-dot');
      svg.append(c);
    }
  }
  function graph(cols) {
    const box = el('div', { class: 'tv-graph' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tv-svg'); svg.setAttribute('aria-hidden', 'true');
    box.append(svg);
    for (const c of cols) box.append(el('div', { class: 'tv-col' }, [el('div', { class: 'tv-colh', text: c.title }), ...c.cards]));
    LINKS = { box, svg, edges: [] };
    ro?.disconnect(); ro?.observe(box);
    requestAnimationFrame(() => requestAnimationFrame(drawLinks));
    return box;
  }
  function card({ title, sub, value, note, cls = '', onClick, tag }) {
    const c = el(onClick ? 'button' : 'div', { class: `tv-card ${cls}`, ...(onClick ? { type: 'button' } : {}) }, [
      tag ? el('span', { class: 'tv-ctag', text: tag }) : null,
      el('span', { class: 'tv-ct', text: title }),
      sub ? el('span', { class: 'tv-cs', text: sub }) : null,
      value ? el('span', { class: 'tv-cv', text: value }) : null,
      note ? el('span', { class: 'tv-cn', text: note }) : null,
    ]);
    if (onClick) c.addEventListener('click', onClick);
    return c;
  }

  // ── 標的節點 ──
  async function renderAsset(id, root) {
    const { main, side } = layout(root);
    main.append(el('p', { class: 'muted', text: '載入中…' }));
    const d = await call(`/api/v1/inv-node?kind=asset&id=${encodeURIComponent(id)}&year=${YEAR}${METRIC ? `&metric=${METRIC}` : ''}`);
    CUR = d;
    main.textContent = '';
    const a = d.asset;
    main.append(h2(a.name, [a.typeLabel, a.itemName, a.externalKey ? `識別碼 ${a.externalKey}` : null, a.multiplier && a.multiplier !== 1 ? `倍率 ×${a.multiplier}` : null]));

    // 年度與指標
    const unitOf = (code) => d.metrics.find((m) => m.code === code)?.std_unit || '';
    const tools = el('div', { class: 'tv-tools' });
    const ysel = el('select', { 'aria-label': '年度' });
    for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 4; y--) ysel.append(el('option', { value: String(y), text: `${y - 1911} 年（${y}）`, selected: y === YEAR }));
    ysel.addEventListener('change', () => { YEAR = Number(ysel.value); renderAsset(id, root); });
    tools.append(el('label', { class: 'tv-lab' }, [el('span', { text: '年度' }), ysel]));
    if (d.metrics.length > 1) {
      const msel = el('select', { 'aria-label': '指標' });
      for (const m of d.metrics) msel.append(el('option', { value: m.code, text: `${m.name}（${m.std_unit}）`, selected: m.code === d.mainMetric }));
      msel.addEventListener('change', () => { METRIC = msel.value; FOCUS = null; renderAsset(id, root); });
      tools.append(el('label', { class: 'tv-lab' }, [el('span', { text: '比對指標' }), msel]));
    }
    main.append(tools);

    // 關聯圖
    const ref = d.sources.find((s) => s.sourceType === 'bill' && s.latest) || d.sources.find((s) => s.latest);
    const diffTo = (s) => {
      if (!ref || s === ref || !s.latest || !ref.latest || s.latest.periodStart !== ref.latest.periodStart || !ref.latest.value) return null;
      return (s.latest.value - ref.latest.value) / ref.latest.value * 100;
    };
    const srcCards = d.sources.map((s) => {
      const df = diffTo(s);
      const c = card({ tag: `${KIND_ICON[s.sourceType] || '•'} ${s.kindLabel}`, title: s.name, sub: s.frequency ? `${s.frequency}${s.acquisition === 'api' ? '・自動介接' : ''}` : '',
        value: s.latest ? `${ym(s.latest.periodStart)}　${fmt(s.latest.value)} ${s.latest.unit}` : '尚無資料',
        note: df === null ? (s === ref && d.sources.length > 1 ? '比對基準' : '') : `與${ref.kindLabel}差 ${pct(df)}`,
        cls: 'src' + (df !== null && Math.abs(df) > 2 ? ' warn' : ''),
        onClick: () => focus({ assetId: a.id, metric: s.latest?.metric || d.mainMetric, label: `${a.name} › ${s.name}${s.latest ? `（${METRIC_NAME(s.latest.metric)}）` : ''}`, el: c,
          empty: s.latest?.metric && s.latest.metric !== d.mainMetric ? '這個來源的數值不直接進報告，用來和同一顆表的其他來源比對、驗證報告採用的數字。' : undefined }, side) });
      return c;
    });
    const have = new Set(d.sources.map((s) => s.sourceType));
    for (const k of EXPECTED_SOURCES[a.assetType] || []) if (!have.has(k)) srcCards.push(card({ tag: `${KIND_ICON[k]} ${KIND_LABEL[k]}`, title: '尚未設定', note: '在〔管理〕新增', cls: 'src empty' }));
    if (!srcCards.length) srcCards.push(card({ title: '沒有數值來源', note: '在〔管理〕新增帳單、智慧電表或手抄表', cls: 'src empty' }));

    const center = [];
    let parentCard = null;
    if (d.path.length) {
      const p = d.path[d.path.length - 1];
      parentCard = card({ tag: '上游', title: p.name, sub: p.typeLabel, cls: 'up', onClick: () => UI.goSection(`tree:asset:${p.id}`) });
      center.push(parentCard);
    } else if (a.itemCode === 'ELE-GRID') {
      parentCard = card({ tag: '上游', title: '台電', sub: '外購電力', cls: 'up', onClick: () => UI.goSection('tree:tpc') });
      center.push(parentCard);
    }
    const lastBill = ref?.latest;
    const me = card({ tag: a.typeLabel, title: a.name, sub: d.located ? `位置：${d.located.building}${d.located.floor ? ` ${d.located.floor}` : ''}` : a.location ? `位置：${a.location}` : '',
      value: lastBill ? `${ym(lastBill.periodStart)}　${fmt(lastBill.value)} ${lastBill.unit}` : '', cls: 'me',
      onClick: () => focus({ assetId: a.id, metric: null, label: `${a.name}（全部指標）`, el: me, fields: d.fields }, side) });
    center.push(me);
    if (d.serves.length) {
      const z = el('div', { class: 'tv-zones' }, [el('span', { class: 'tv-cs', text: '供電／供應範圍' })]);
      for (const s of d.serves) {
        const b = el('button', { type: 'button', class: 'tv-zchip', text: `${s.building}${s.floor ? ` ${s.floor}` : '（整棟）'}` });
        b.addEventListener('click', () => UI.goSection(s.floor ? `tree:floor:${s.buildingId}|${s.floor}` : `tree:building:${s.buildingId}`));
        z.append(b);
      }
      center.push(z);
    }

    const down = d.children.map((c) => card({ tag: c.typeLabel, title: c.name, value: c.latest ? `${ym(c.latest.periodStart)}　${fmt(c.latest.value)} ${c.latest.unit}` : '尚無資料', cls: 'down', onClick: () => UI.goSection(`tree:asset:${c.id}`) }));
    const net = d.links.map((l) => card({ tag: RELATION[l.relation]?.[l.dir] || l.relation, title: l.otherName, cls: 'down net', onClick: () => UI.goSection(`tree:asset:${l.otherId}`) }));
    let sumCard = null;
    if (d.balance?.length) {
      const last = d.balance[d.balance.length - 1];
      const refMonth = ref ? d.compare?.months.find((m) => m.month === last.month) : null;
      const refVal = refMonth?.values.find((v) => v.source === ref.name)?.value;
      const df = refVal ? (last.children - refVal) / refVal * 100 : null;
      sumCard = card({ tag: '合計', title: `下游合計（${last.reporting}/${last.total} 有資料）`, value: `${ym(last.month + '-01')}　${fmt(last.children)} ${unitOf(d.mainMetric)}`,
        note: df === null ? '' : `占本表 ${(100 + df).toFixed(1)}%（差 ${pct(df)}，含線損與未裝表負載）`, cls: 'down sum' });
    }
    const cols = [{ title: '數值來源', cards: srcCards }, { title: '本項', cards: center }];
    if (down.length || net.length) cols.push({ title: '下游', cards: [...down, ...net, sumCard].filter(Boolean) });
    main.append(graph(cols));
    for (const c of srcCards) if (!c.classList.contains('empty')) LINKS.edges.push([c, me]);
    if (parentCard) LINKS.edges.push([parentCard, me]);
    for (const c of down) LINKS.edges.push([me, c]);
    for (const c of net) LINKS.edges.push([me, c, true]);

    // 逐月比對
    if (d.compare?.months.length) {
      main.append(el('h3', { class: 'i-h3', text: `${YEAR - 1911} 年逐月比對（${d.compare.metric}，${d.compare.unit}）` }));
      const srcNames = [...new Set(d.compare.months.flatMap((m) => m.values.map((v) => v.source)))];
      const t = el('table', { class: 'tv-table' });
      const hr = el('tr', {}, [el('th', { text: '月份' })]);
      for (const n of srcNames) {
        const s = d.sources.find((x) => x.name === n || n.startsWith(x.name));
        const th = el('th', { class: 'tv-th', text: n, title: '點這欄看它對應的報告欄位' });
        if (s) { th.tabIndex = 0; th.addEventListener('click', () => focus({ assetId: a.id, metric: s.latest?.metric || d.mainMetric, label: `${a.name} › ${s.name}`, el: th }, side)); }
        hr.append(th);
      }
      if (d.balance) hr.append(el('th', { text: '下游合計' }));
      hr.append(el('th', { text: '來源間最大差' }));
      t.append(el('thead', {}, hr));
      const tb = el('tbody');
      for (const m of d.compare.months) {
        const tr = el('tr', {}, [el('td', { text: `${Number(m.month.slice(5))} 月` })]);
        for (const n of srcNames) { const v = m.values.find((x) => x.source === n); tr.append(el('td', { class: 'num', text: v ? fmt(v.value) : '—', title: v?.how || '' })); }
        if (d.balance) { const b = d.balance.find((x) => x.month === m.month); tr.append(el('td', { class: 'num', text: b ? fmt(b.children) : '—' })); }
        tr.append(el('td', { class: 'num' + (m.relDiffPct > 2 ? ' warn' : ''), text: m.values.length > 1 ? `${m.relDiffPct.toFixed(1)}%` : '—' }));
        tb.append(tr);
      }
      t.append(tb);
      main.append(el('div', { class: 'tv-scroll' }, t));
      main.append(el('p', { class: 'note', text: '差異超過 2% 標黃。帳單期間跨月時已依日數分攤到自然月，分攤值只作比對參考。' }));
    } else if (d.mainMetric) {
      main.append(el('p', { class: 'note', text: `${YEAR - 1911} 年還沒有「${METRIC_NAME(d.mainMetric)}」的資料。` }));
    }
    if (d.located || a.attrs?.note) {
      main.append(el('h3', { class: 'i-h3', text: '備註' }));
      if (a.attrs?.note) main.append(el('p', { text: a.attrs.note }));
    }
    FOCUS = FOCUS || { assetId: a.id, metric: null, label: `${a.name}（全部指標）`, fields: d.fields };
    if (!FOCUS.el) FOCUS.el = me;
    me.classList.add('sel');
    renderSide(side);
  }
  const RELATION = { feeds: { out: '供電給', in: '受電自' }, supplies: { out: '供應給', in: '供應來源' }, submeter_of: { out: '子表', in: '母表' }, part_of: { out: '包含', in: '屬於' } };
  const METRIC_NAME = (code) => META?.metrics?.find((m) => m.code === code)?.name || code;

  // ── 分區節點（建物／樓層）──
  async function renderZone(sub, id, root) {
    const { main, side } = layout(root);
    const d = await call(`/api/v1/inv-node?kind=${sub}&orgId=${ORG.id}&id=${encodeURIComponent(id)}`);
    const b = d.building;
    main.append(h2(d.floor ? `${b.name} ${d.floor}` : b.name, [d.floor ? (b.outdoor ? '周邊區域' : '樓層') : (b.outdoor ? '周邊' : '建物'), !d.floor && b.floorAreaM2 ? `${fmt(b.floorAreaM2)} m²` : null]));
    if (!d.floor && b.floorList.length) {
      const fl = el('div', { class: 'tv-floors' });
      for (const f of b.floorList) {
        const n = d.servedBy.filter((s) => s.floor === f || !s.floor).length;
        const btn = el('button', { type: 'button', class: 'tv-zchip', text: n ? `${f}・${n} 盤` : f });
        btn.addEventListener('click', () => UI.goSection(`tree:floor:${b.id}|${f}`));
        fl.append(btn);
      }
      main.append(el('h3', { class: 'i-h3', text: b.outdoor ? '區域' : '樓層' }), fl);
    }
    const sup = d.servedBy.map((s) => card({ tag: s.typeLabel, title: s.name, sub: `${s.upstream ? `← ${s.upstream}　` : ''}${s.floor ? `供 ${s.floor}` : '供整棟'}`, cls: 'src', onClick: () => UI.goSection(`tree:asset:${s.id}`) }));
    if (!sup.length) sup.push(card({ title: '還沒有標記供電來源', note: '到〔台電 › 管理〕替盤設定供電範圍', cls: 'src empty' }));
    const me = card({ tag: d.floor ? '樓層' : (b.outdoor ? '周邊' : '建物'), title: d.floor ? `${b.name} ${d.floor}` : b.name, cls: 'me',
      onClick: () => focus(zoneFocus(d, me), side) });
    const here = d.located.map((x) => card({ tag: x.typeLabel, title: x.name, sub: x.floor || '', cls: 'down', onClick: () => UI.goSection(`tree:asset:${x.id}`) }));
    const cols = [{ title: '供電來源', cards: sup }, { title: '本區', cards: [me] }];
    if (here.length) cols.push({ title: '設在這裡的設備', cards: here });
    main.append(graph(cols));
    for (const c of sup) if (!c.classList.contains('empty')) LINKS.edges.push([c, me]);
    for (const c of here) LINKS.edges.push([me, c, true]);
    FOCUS = FOCUS || zoneFocus(d, me);
    me.classList.add('sel');
    renderSide(side);
  }
  function zoneFocus(d, me) {
    if (!d.floor) return { zone: true, label: `${d.building.name}（建物資料）`, el: me, fields: d.fields,
      empty: d.building.outdoor ? '周邊區域不列入建築資料表；它的用電經由供電的盤計入。' : undefined,
      note: d.building.outdoor ? '周邊區域不列入建築資料表。' : null };
    return { zone: true, label: `${d.building.name} ${d.floor}`, el: me, fields: [], empty: '樓層本身不是報告欄位；它的用電經由左邊的供電來源（盤、電表）計入，點那些卡片看它們進到哪些報告。' };
  }

  // ── 總覽類節點 ──
  function listTable(rows, cols) {
    const t = el('table', { class: 'tv-table' });
    t.append(el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c.h })))));
    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr', {});
      cols.forEach((c, i) => {
        const v = c.v(r);
        if (i === 0 && r.sec) { const b = el('button', { type: 'button', class: 'link', text: v }); b.addEventListener('click', () => UI.goSection(r.sec)); tr.append(el('td', {}, b)); }
        else tr.append(el('td', { class: c.num ? 'num' : '', text: v ?? '' }));
      });
      tb.append(tr);
    }
    t.append(tb);
    return el('div', { class: 'tv-scroll' }, t);
  }
  function flatAssets(nodes, depth = 0, out = []) {
    for (const n of nodes) { if (n.kind === 'asset') out.push({ ...n, depth }); flatAssets(n.children || [], n.kind === 'asset' ? depth + 1 : depth, out); }
    return out;
  }
  const assetCols = [
    { h: '名稱', v: (r) => `${'　'.repeat(r.depth || 0)}${r.name}` },
    { h: '類型', v: (r) => r.typeLabel },
    { h: '數值來源', v: (r) => String(r.sources || 0), num: true },
  ];
  function renderOverview(root) {
    const { main, side } = layout(root);
    main.append(h2('盤點', [ORG?.name]));
    main.append(el('p', { class: 'note', text: '左邊依油、水、電、氣展開。點名稱看內容；點〔管理〕新增或修改。' }));
    main.append(listTable(TREE.domains.map((d) => ({ name: `${d.icon} ${d.label}`, count: d.count, sec: `tree:dom:${d.key}` })), [{ h: '類別', v: (r) => r.name }, { h: '項目數', v: (r) => String(r.count), num: true }]));
    renderSide(side);
  }
  function renderDomain(key, root) {
    const { main, side } = layout(root);
    const d = domainOf(key);
    main.append(h2(`${d.icon} ${d.label}`, [`${d.count} 項`]));
    if (key === 'electricity') {
      const tpc = d.children.find((c) => c.kind === 'tpc'); const z = d.children.find((c) => c.kind === 'zones');
      main.append(el('h3', { class: 'i-h3', text: '台電（受電總盤與下游）' }));
      main.append(tpc.children.length ? listTable(flatAssets(tpc.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols) : el('p', { class: 'note', text: '還沒有受電總盤。' }));
      main.append(el('h3', { class: 'i-h3', text: '分區' }));
      main.append(z.children.length ? listTable(z.children.map((b) => ({ name: b.name, floors: b.children.map((f) => f.name).join('、'), sec: `tree:building:${b.id}` })), [{ h: '建物／區域', v: (r) => r.name }, { h: '樓層／區域', v: (r) => r.floors }]) : el('p', { class: 'note', text: '還沒有建物。' }));
      const other = d.children.find((c) => c.id === 'ele-other');
      if (other) { main.append(el('h3', { class: 'i-h3', text: other.name })); main.append(listTable(flatAssets(other.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols)); }
    } else {
      const rows = flatAssets(d.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` }));
      main.append(rows.length ? listTable(rows, assetCols) : el('p', { class: 'note', text: '還沒有項目，按左邊的〔管理〕新增。' }));
    }
    renderSide(side);
  }
  function renderTpc(root) {
    const { main, side } = layout(root);
    const t = domainOf('electricity').children.find((c) => c.kind === 'tpc');
    main.append(h2('台電', [`${t.children.length} 個受電總盤`]));
    main.append(t.children.length ? listTable(flatAssets(t.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols) : el('p', { class: 'note', text: '還沒有受電總盤，按〔管理〕新增。' }));
    renderSide(side);
  }
  function renderZones(root) {
    const { main, side } = layout(root);
    main.append(h2('分區'));
    const bs = buildings();
    main.append(bs.length ? listTable(bs.map((b) => ({ name: b.name, floors: b.children.map((f) => f.name).join('、'), sec: `tree:building:${b.id}` })), [{ h: '建物／區域', v: (r) => r.name }, { h: '樓層／區域', v: (r) => r.floors }]) : el('p', { class: 'note', text: '還沒有建物，按〔管理〕新增。' }));
    FOCUS = { zone: true, label: '建物資料' };
    renderSide(side);
  }
  function renderGroup(id, root) {
    const { main, side } = layout(root);
    const f = findNode('group', id);
    if (!f) { main.append(el('p', { class: 'note', text: '找不到這個分類。' })); return; }
    main.append(h2(f.n.name));
    main.append(listTable(flatAssets(f.n.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols));
    renderSide(side);
  }

  // ════════════════ 管理 ════════════════
  const itemsOf = (dom) => (META?.items || []).filter((i) => i.domain === dom);
  const itemForType = (dom, type) => itemsOf(dom).find((i) => (i.asset_types || []).includes(type)) || null;
  const typeName = (t) => META?.assetTypes?.[t] || t;
  function field(label, input, hint) { return el('label', { class: 'tv-f' }, [el('span', { text: label }), input, hint ? el('small', { class: 'muted', text: hint }) : null]); }
  function inp(value = '', props = {}) { return el('input', { value: value ?? '', ...props }); }
  function sel(options, value) { const s = el('select'); for (const [v, t] of options) s.append(el('option', { value: v, text: t, selected: v === value })); return s; }
  function btn(text, fn, cls = '') { const b = el('button', { type: 'button', class: cls, text }); b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; } }); return b; }
  async function askReason(title) {
    const r = inp('', { placeholder: '例：現場盤點更正名稱' });
    const ok = await confirmModal({ title, node: el('div', {}, [field('修改原因（會記在異動歷程）', r)]), okText: '確定' });
    if (!ok) return null;
    return r.value.trim() || '盤點樹管理';
  }
  async function askRename(cur) {
    const n = inp(cur); const r = inp('', { placeholder: '例：現場盤點更正名稱' });
    const ok = await confirmModal({ title: `改名：${cur}`, node: el('div', {}, [field('新名稱', n), field('修改原因（會記在異動歷程）', r)]), okText: '改名' });
    const v = n.value.trim();
    if (!ok || !v || v === cur) return null;
    return { n: v, reason: r.value.trim() || '盤點樹管理' };
  }
  function bldFloorOptions() {
    const out = [['', '（不指定）']];
    for (const b of buildings()) { out.push([`${b.id}|`, `${b.name}（整棟）`]); for (const f of b.children) out.push([`${b.id}|${f.name}`, `${b.name} ${f.name}`]); }
    return out;
  }
  async function refreshAfter(id) { await reloadTree(); UI.goSection(id); }

  async function renderManage(sub, arg, root) {
    root.textContent = '';
    const main = el('div', { class: 'tv-main tv-manage' });
    root.append(main);
    if (sub === 'inv') return manageInv(main);
    if (sub === 'dom') return manageDomain(arg, main);
    if (sub === 'tpc') return manageTpc(main);
    if (sub === 'zones') return manageZones(main);
    if (sub === 'asset') return manageAsset(arg, main);
  }
  function manageInv(main) {
    main.append(h2('管理 › 盤點', [ORG?.name]));
    main.append(listTable(TREE.domains.map((d) => ({ name: `${d.icon} ${d.label}`, count: d.count, sec: `mng:dom:${d.key}` })), [{ h: '類別（點進去管理）', v: (r) => r.name }, { h: '項目數', v: (r) => String(r.count), num: true }]));
    main.append(el('p', { class: 'note' }, [el('span', { text: '完整標的台帳、批次匯入、適用性判定在 ' }), el('a', { href: '/p/#assets', text: '油水電氣平台' }), el('span', { text: '。' })]));
  }

  // 新增標的表單（通用）
  function addAssetForm({ dom, parentId = null, types = null, title = '新增項目', onDone }) {
    const items = itemsOf(dom).filter((i) => (i.asset_types || []).length);
    const typeOpts = () => {
      const all = types || [...new Set(items.flatMap((i) => i.asset_types))];
      return all.map((t) => [t, typeName(t)]);
    };
    const tSel = sel(typeOpts(), types?.[0]);
    const name = inp('', { placeholder: { electricity: '例：A1 分盤、2F 照明盤', oil: '例：柴油發電機 G7、公務車 ABC-1234', water: '例：自來水總表、B1 分表', gas: '例：廚房天然氣表、2F 分離式冷氣' }[dom] || '名稱' });
    const key = inp('', { placeholder: '電號、表號或設備編號（選填）' });
    const loc = sel(bldFloorOptions(), '');
    const form = el('div', { class: 'tv-form' }, [
      el('h3', { class: 'i-h3', text: title }),
      el('div', { class: 'tv-grid' }, [field('類型', tSel), field('名稱', name), field('識別碼', key), field('所在位置', loc)]),
      btn('新增', async () => {
        if (!name.value.trim()) throw new Error('請填名稱');
        const item = itemForType(dom, tSel.value);
        const [bid, fl] = loc.value.split('|');
        await post('/api/v1/assets', { orgId: ORG.id, siteId: TREE.site?.id, domain: dom, itemId: item?.id, assetType: tSel.value, name: name.value.trim(), externalKey: key.value.trim() || undefined,
          parentAssetId: parentId || undefined, buildingId: bid || undefined, floor: fl || undefined, status: 'active' });
        toast(`已新增「${name.value.trim()}」`, 'ok');
        await onDone();
      }, 'primary'),
    ]);
    return form;
  }
  function manageDomain(key, main) {
    const d = domainOf(key);
    main.append(h2(`管理 › ${d.icon} ${d.label}`));
    if (key === 'electricity') main.append(el('p', { class: 'note', text: '受電總盤（電號）在〔台電 › 管理〕新增；分盤、電表在各總盤的〔管理〕新增；建物樓層在〔分區 › 管理〕。這裡新增的是不接在總盤底下的項目（例：太陽能、儲能櫃）。' }));
    main.append(addAssetForm({ dom: key, onDone: () => refreshAfter(`mng:dom:${key}`) }));
    main.append(el('h3', { class: 'i-h3', text: '現有項目' }));
    const rows = assetsIn(key);
    if (!rows.length) { main.append(el('p', { class: 'note', text: '還沒有項目。' })); return; }
    main.append(assetEditList(rows, `mng:dom:${key}`));
  }
  function assetEditList(rows, back) {
    const box = el('div', { class: 'tv-elist' });
    for (const r of rows) {
      const line = el('div', { class: 'tv-eline' });
      line.style.setProperty('--d', String(r.depth || 0));
      line.append(el('span', { class: 'tv-ename', text: r.name }), el('span', { class: 'muted', text: r.typeLabel }));
      line.append(btn('來源與範圍', async () => UI.goSection(`mng:asset:${r.id}`)));
      line.append(btn('改名', async () => {
        const v = await askRename(r.name); if (!v) return;
        const { n, reason } = v;
        await post(`/api/v1/assets/${r.id}`, { name: n, reason }, 'PATCH'); toast('已改名', 'ok'); await refreshAfter(back);
      }));
      line.append(btn('停用', async () => {
        const reason = await askReason(`停用「${r.name}」？（歷史資料保留）`); if (!reason) return;
        await post(`/api/v1/assets/${r.id}/disable`, { reason }); toast('已停用', 'ok'); await refreshAfter(back);
      }, 'danger'));
      box.append(line);
    }
    return box;
  }
  function manageTpc(main) {
    main.append(h2('管理 › 台電'));
    main.append(el('p', { class: 'note', text: '每個台電電號一個受電總盤。帳單、智慧電表、手抄表都掛在總盤上互相比對；分盤在總盤的〔管理〕新增。' }));
    const name = inp('', { placeholder: '例：急重症總站（大坑變電所 22.8kV）' });
    const no = inp('', { placeholder: '例：01-2345-67-890-1' });
    const kw = inp('', { type: 'number', placeholder: '經常契約容量 kW' });
    main.append(el('div', { class: 'tv-form' }, [
      el('h3', { class: 'i-h3', text: '新增受電總盤（電號）' }),
      el('div', { class: 'tv-grid' }, [field('名稱', name), field('台電電號', no), field('經常契約容量（kW）', kw)]),
      btn('新增', async () => {
        if (!name.value.trim()) throw new Error('請填名稱');
        const item = itemsOf('electricity').find((i) => i.code === 'ELE-GRID');
        await post('/api/v1/assets', { orgId: ORG.id, siteId: TREE.site?.id, domain: 'electricity', itemId: item.id, assetType: 'power_account', name: name.value.trim(),
          externalKey: no.value.trim() || undefined, externalKeySensitive: !!no.value.trim(), attrs: kw.value ? { contractKw: Number(kw.value) } : {}, status: 'active' });
        toast('已新增受電總盤', 'ok'); await refreshAfter('mng:tpc');
      }, 'primary'),
    ]));
    const t = domainOf('electricity').children.find((c) => c.kind === 'tpc');
    main.append(el('h3', { class: 'i-h3', text: '受電總盤' }));
    if (!t.children.length) { main.append(el('p', { class: 'note', text: '還沒有。' })); return; }
    const box = el('div', { class: 'tv-elist' });
    for (const n of t.children) {
      const line = el('div', { class: 'tv-eline' }, [el('span', { class: 'tv-ename', text: n.name }), el('span', { class: 'muted', text: `${n.sources} 個來源` })]);
      line.append(btn('管理這個總盤', async () => UI.goSection(`mng:asset:${n.id}`)));
      box.append(line);
    }
    main.append(box);
  }

  async function manageAsset(id, main) {
    const d = await call(`/api/v1/inv-node?kind=asset&id=${encodeURIComponent(id)}&year=${YEAR}`);
    const a = d.asset;
    const back = `mng:asset:${id}`;
    main.append(h2(`管理 › ${a.name}`, [a.typeLabel]));

    // 基本資料
    const name = inp(a.name); const key = inp(a.externalKey || '', { placeholder: '電號' }); const mult = inp(a.multiplier ?? 1, { type: 'number', step: 'any' });
    const loc = sel(bldFloorOptions(), d.located ? `${d.located.buildingId}|${d.located.floor || ''}` : '');
    main.append(el('div', { class: 'tv-form' }, [
      el('h3', { class: 'i-h3', text: '基本資料' }),
      el('div', { class: 'tv-grid' }, [field('名稱', name), field(a.assetType === 'power_account' ? '台電電號' : '識別碼', key), field('表計倍率', mult), field('所在位置', loc)]),
      btn('儲存', async () => {
        const [bid, fl] = loc.value.split('|');
        const reason = await askReason(`修改「${a.name}」`); if (!reason) return;
        await post(`/api/v1/assets/${id}`, { name: name.value.trim(), externalKey: key.value.trim() || null, meterMultiplier: Number(mult.value) || 1, buildingId: bid || null, floor: fl || null, reason }, 'PATCH');
        toast('已儲存', 'ok'); await refreshAfter(back);
      }, 'primary'),
    ]));

    main.append(sourcesEditor(a, d.sources, back));
    main.append(zonesEditor(a, d.serves, back));

    // 下游（整棵子樹）
    main.append(el('h3', { class: 'i-h3', text: a.domain === 'electricity' ? '下游分盤、電表與設備' : '下層項目' }));
    const hit = findNode('asset', id);
    const rows = hit ? flatAssets(hit.n.children) : [];
    const box = el('div', { class: 'tv-elist' });
    const subTypes = a.domain === 'electricity' ? ['panel', 'power_meter', 'equipment', 'chiller', 'ahu', 'pump', 'cooling_tower', 'lighting', 'elevator', 'data_room', 'ess', 'pv_system', 'transformer', 'capacitor'] : null;
    const addUnder = (pid, pname) => el('div', {}, [addAssetForm({ dom: a.domain, parentId: pid, types: subTypes,
      title: `新增在「${pname}」底下`, onDone: () => refreshAfter(back) })]);
    for (const r of rows) {
      const line = el('div', { class: 'tv-eline' });
      line.style.setProperty('--d', String(r.depth));
      line.append(el('span', { class: 'tv-ename', text: r.name }), el('span', { class: 'muted', text: r.typeLabel }));
      line.append(btn('＋下層', async () => { const f = addUnder(r.id, r.name); line.after(f); }));
      line.append(btn('來源與供電範圍', async () => UI.goSection(`mng:asset:${r.id}`)));
      line.append(btn('改名', async () => {
        const v = await askRename(r.name); if (!v) return;
        const { n, reason } = v;
        await post(`/api/v1/assets/${r.id}`, { name: n, reason }, 'PATCH'); toast('已改名', 'ok'); await refreshAfter(back);
      }));
      line.append(btn('停用', async () => {
        const reason = await askReason(`停用「${r.name}」？（歷史資料保留）`); if (!reason) return;
        await post(`/api/v1/assets/${r.id}/disable`, { reason }); toast('已停用', 'ok'); await refreshAfter(back);
      }, 'danger'));
      box.append(line);
    }
    if (!rows.length) box.append(el('p', { class: 'note', text: '還沒有下游。' }));
    main.append(box);
    main.append(addUnder(id, a.name));
  }
  function sourcesEditor(a, sources, back) {
    const box = el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: a.domain === 'electricity' ? '數值來源（同一顆表的帳單、智慧電表、手抄表）' : '數值來源（帳單、自動讀值、手抄、紀錄）' })]);
    const list = el('div', { class: 'tv-elist' });
    for (const s of sources) {
      const line = el('div', { class: 'tv-eline' }, [el('span', { class: 'tv-ename', text: `${KIND_ICON[s.sourceType] || ''} ${s.name}` }), el('span', { class: 'muted', text: `${s.kindLabel}${s.frequency ? `・${s.frequency}` : ''}` })]);
      line.append(btn('停用', async () => {
        if (!(await confirmModal({ title: `停用來源「${s.name}」？`, body: '已收的數值保留，之後不再列入比對。', okText: '停用', danger: true }))) return;
        await post('/api/v1/data-sources', { id: s.id, assetId: a.id, name: s.name, sourceType: s.sourceType, acquisition: s.acquisition, frequency: s.frequency, note: s.note, active: false });
        toast('已停用', 'ok'); await refreshAfter(back);
      }, 'danger'));
      list.append(line);
    }
    if (!sources.length) list.append(el('p', { class: 'note', text: '還沒有來源。' }));
    box.append(list);
    const kind = sel(a.domain === 'electricity' ? [['bill', '🧾 帳單（台電電費單）'], ['ems', '📡 智慧電表／EMS'], ['manual', '✍ 手抄表'], ['document', '📄 其他文件']]
      : [['bill', '🧾 帳單／發票'], ['ems', '📡 自動讀值'], ['manual', '✍ 手抄'], ['record', '🗒 紀錄（運轉、加油、充填）'], ['document', '📄 其他文件']], 'bill');
    const name = inp('', { placeholder: '例：台電電費單、總盤智慧電表、每月手抄' });
    const freq = inp('每月');
    kind.addEventListener('change', () => { if (!name.value) name.placeholder = { bill: '台電電費單', ems: '智慧電表', manual: '每月手抄表', document: '文件' }[kind.value]; });
    box.append(el('div', { class: 'tv-grid' }, [field('種類', kind), field('名稱', name), field('頻率', freq)]));
    box.append(btn('新增來源', async () => {
      const n = name.value.trim() || name.placeholder;
      await post('/api/v1/data-sources', { assetId: a.id, name: n, sourceType: kind.value, acquisition: kind.value === 'ems' ? 'api' : 'manual', frequency: freq.value.trim() || null, priority: kind.value === 'bill' ? 10 : kind.value === 'ems' ? 30 : 50 });
      toast('已新增來源', 'ok'); await refreshAfter(back);
    }, 'primary'));
    return box;
  }
  function zonesEditor(a, serves, back) {
    const box = el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: a.domain === 'electricity' ? '供電範圍（這個盤供應哪些建物、樓層）' : '供應範圍（供應哪些建物、樓層）' })]);
    const bs = buildings();
    if (!bs.length) { box.append(el('p', { class: 'note', text: '還沒有建物，先到〔分區 › 管理〕新增。' })); return box; }
    const on = new Map(serves.map((s) => [`${s.buildingId}|${s.floor || ''}`, s.id]));
    for (const b of bs) {
      const row = el('div', { class: 'tv-zrow' }, [el('b', { text: b.name })]);
      const opts = [['', '整棟'], ...b.children.map((f) => [f.name, f.name])];
      for (const [f, label] of opts) {
        const k = `${b.id}|${f}`;
        const cb = el('input', { type: 'checkbox', checked: on.has(k) });
        cb.addEventListener('change', async () => {
          cb.disabled = true;
          try {
            if (cb.checked) { const r = await post('/api/v1/asset-zones', { assetId: a.id, buildingId: b.id, floor: f || null }); on.set(k, r.id); }
            else { await call(`/api/v1/asset-zones/${on.get(k)}`, { method: 'DELETE' }); on.delete(k); }
          } catch (e) { cb.checked = !cb.checked; toast(e.message, 'err'); } finally { cb.disabled = false; }
        });
        row.append(el('label', { class: 'tv-zc' }, [cb, el('span', { text: label })]));
      }
      box.append(row);
    }
    box.append(el('p', { class: 'note', text: '勾選即存。一個樓層可以由好幾個盤供電，一個盤也可以供好幾層。' }));
    return box;
  }
  function manageZones(main) {
    main.append(h2('管理 › 分區'));
    const siteId = TREE.site?.id;
    const save = async (b, patch) => { await post('/api/v1/buildings', { siteId, id: b?.id, name: b?.name, floors: b?.floors, ...patch }); await refreshAfter('mng:zones'); };
    const list = el('div', { class: 'tv-elist' });
    for (const b of buildings()) {
      const name = inp(b.name); const floors = inp(b.children.map((f) => f.name).join('、'));
      const line = el('div', { class: 'tv-eline tv-bline' }, [field(b.outdoor ? '周邊名稱' : '建物名稱', name), field(b.outdoor ? '區域（頓號分隔）' : '樓層（例：B1–9F，或頓號分隔）', floors)]);
      line.append(btn('儲存', async () => { await save(b, { name: name.value.trim(), floors: floors.value.trim(), attrs: b.outdoor ? { zoneKind: 'outdoor' } : undefined }); toast('已儲存', 'ok'); }, 'primary'));
      line.append(btn('移除', async () => {
        if (!(await confirmModal({ title: `移除「${b.name}」？`, body: '標記為不再使用（資料保留），已設定的供電範圍跟著失效。', okText: '移除', danger: true }))) return;
        await save(b, { name: b.name, validTo: new Date().toISOString().slice(0, 10) }); toast('已移除', 'ok');
      }, 'danger'));
      list.append(line);
    }
    if (!buildings().length) list.append(el('p', { class: 'note', text: '還沒有建物。' }));
    main.append(list);
    const nn = inp('', { placeholder: '例：急重症大樓' }); const nf = inp('', { placeholder: '例：B1–9F' });
    main.append(el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: '新增建物' }), el('div', { class: 'tv-grid' }, [field('建物名稱', nn), field('樓層', nf, '寫「B1–9F」會展開成 9F…1F、B1')]),
      btn('新增建物', async () => { if (!nn.value.trim()) throw new Error('請填建物名稱'); await save(null, { name: nn.value.trim(), floors: nf.value.trim() }); toast('已新增', 'ok'); }, 'primary')]));
    if (!buildings().some((b) => b.outdoor)) {
      const oa = inp('停車場、路燈');
      main.append(el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: '新增周邊區域' }), el('div', { class: 'tv-grid' }, [field('區域（頓號分隔）', oa)]),
        btn('新增周邊', async () => { await save(null, { name: '周邊', floors: oa.value.trim(), attrs: { zoneKind: 'outdoor' } }); toast('已新增', 'ok'); }, 'primary')]));
    }
  }

  window.EMSInvTree = {
    load, navNode, render, labelFor,
    get ready() { return READY; },
    defaultSection: () => `tree:dom:${OPEN}`,
    isSection: (id) => /^(tree|mng):/.test(String(id || '')),
  };
})();
