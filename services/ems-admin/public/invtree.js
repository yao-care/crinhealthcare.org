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
  // 左欄排法：inv＝盤點分類（油水電氣）；sheet＝依院方原本的環境部盤查表單頁籤
  let MODE = lsGet('mode') === 'sheet' ? 'sheet' : 'inv';
  let OPEN_TAB = lsGet('tab') || 'mobile';
  let SHEET_YEAR = null;          // 頁籤檢視的年度（null＝有資料的最新一年）
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
    if (sub === 'sheet') return null;
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
    const modeBar = el('div', { class: 'tv-mode', role: 'group', 'aria-label': '左欄排法' });
    for (const [m, t] of [['inv', '油水電氣分類'], ['sheet', '盤查表單頁籤']]) {
      const b = el('button', { type: 'button', text: t, 'aria-pressed': String(MODE === m) });
      b.addEventListener('click', () => { if (MODE === m) return; MODE = m; lsSet('mode', m); UI.goSection(m === 'sheet' ? `tree:sheet:${OPEN_TAB}` : `tree:dom:${OPEN}`); });
      modeBar.append(b);
    }
    box.append(modeBar);
    const flat = (id, text) => {
      const r = el('div', { class: 'tv-dom' + (activeId === id ? ' active' : '') });
      const b = el('button', { type: 'button', class: 'tv-domname' }, [el('span', { class: 'tv-dcaret', text: '' }), el('span', { text })]);
      b.addEventListener('click', () => UI.goSection(id));
      r.append(b); return r;
    };
    box.append(flat('tree:profile', '🏥 院所基本資料'));
    if (MODE === 'sheet') { sheetNav(box, activeId); box.append(flat('tree:reports', '📑 申報與報告')); return box; }
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
    box.append(flat('tree:reports', '📑 申報與報告'));
    return box;
  }

  // 盤查表單頁籤排法：頁籤 › 標的；標的點下去仍是原本的項目頁
  function sheetNav(box, activeId) {
    const S = TREE.sheets || { tabs: [], rest: { count: 0, children: [] } };
    const [, sub, ...rest] = String(activeId || '').split(':'); const arg = rest.join(':');
    if (sub === 'sheet' && arg !== '_rest' && arg !== OPEN_TAB) { OPEN_TAB = arg; lsSet('tab', arg); }
    if (sub === 'asset') { const t = S.tabs.find((x) => x.children.some((c) => c.id === arg)); if (t && t.key !== OPEN_TAB) { OPEN_TAB = t.key; lsSet('tab', t.key); } }
    const groups = [...S.tabs, { key: '_rest', name: '其他盤點項目（盤查表單沒有這一頁）', count: S.rest.count, children: S.rest.children }];
    for (const t of groups) {
      if (t.key === '_rest' && !t.count) continue;
      const open = OPEN_TAB === t.key;
      const id = `tree:sheet:${t.key}`;
      const dh = el('div', { class: 'tv-dom' + (open ? ' open' : '') + (activeId === id ? ' active' : '') });
      const b = el('button', { type: 'button', class: 'tv-domname', 'aria-expanded': String(open), title: t.title || '' }, [
        el('span', { class: 'tv-dcaret', text: open ? '▾' : '▸' }), el('span', { text: t.name }), t.count ? el('i', { class: 'tv-n', text: String(t.count) }) : null,
      ]);
      b.addEventListener('click', () => { OPEN_TAB = t.key; lsSet('tab', t.key); UI.goSection(id); });
      dh.append(b);
      box.append(dh);
      if (!open) continue;
      if (!t.children.length) box.append(el('p', { class: 'tv-empty', text: '這一頁還沒有盤點項目。' }));
      for (const c of t.children) {
        const sid = `tree:asset:${c.id}`;
        const row = el('div', { class: 'tv-row' + (sid === activeId ? ' active' : '') });
        row.style.setProperty('--d', '1');
        const nb = el('button', { type: 'button', class: 'tv-name', 'data-sec': sid }, [el('span', { text: c.name })]);
        nb.addEventListener('click', () => UI.goSection(sid));
        row.append(el('span', { class: 'tv-caret' }), nb);
        box.append(row);
      }
    }
  }

  const UNIT_ZH = { kWh: '度', L: '公升', kg: '公斤', person_h: '人時', bed_day: '人日', visit: '人次', m3: '立方公尺', Nm3: '立方公尺', TWD: '元', GJ: 'GJ' };
  const unitZh = (u) => UNIT_ZH[u] || u || '';
  const STATE_ZH = { estimated: '推估', missing: '缺漏', zero: '零', unknown: '未知', not_applicable: '不適用' };

  async function renderSheet(key, root) {
    const { main, side } = layout(root);
    if (key === '_rest') {
      const rest = TREE.sheets?.rest?.children || [];
      main.append(h2('其他盤點項目', [`${rest.length} 項`]));
      main.append(el('p', { class: 'note', text: '院方的盤查表單沒有對應頁籤的項目（例：院內分盤、分表、儲能）。切回「油水電氣分類」可依台電、分區查看。' }));
      main.append(listTable(rest.map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols));
      renderSide(side);
      return;
    }
    main.append(el('p', { class: 'muted', text: '載入中…' }));
    const d = await call(`/api/v1/orgs/${ORG.id}/ghg-sheet?tab=${encodeURIComponent(key)}${SHEET_YEAR ? `&year=${SHEET_YEAR}` : ''}`);
    main.textContent = '';
    const ysel = el('select', { 'aria-label': '年度' });
    const years = [...new Set([...(d.years || []), d.year])].sort((a, b) => b - a);
    for (const y of years) ysel.append(el('option', { value: String(y), text: `${y - 1911} 年（${y}）`, selected: y === d.year }));
    ysel.addEventListener('change', () => { SHEET_YEAR = Number(ysel.value); renderSheet(key, root); });
    main.append(el('div', { class: 'i-head' }, [el('h2', { text: d.name }), el('span', { class: 'tv-chip', text: d.title }), ysel]));
    main.append(el('p', { class: 'note', text: d.workbook
      ? `依院方的溫室氣體盤查表單「${d.name}」頁籤排列。上面是系統裡 ${d.year - 1911} 年的合計；下面每一列對應原檔的一列，點標的名稱看該項目。`
      : `依溫室氣體盤查表單「${d.name}」頁籤排列。${d.year - 1911} 年沒有匯入原檔，下面列的是系統裡的紀錄。` }));

    // 系統合計
    main.append(el('h3', { class: 'i-h3', text: `${d.year - 1911} 年合計（系統）` }));
    if (d.summary.length) {
      main.append(listTable(d.summary.map((g) => ({ ...g })), [
        { h: '項目', v: (r) => r.group }, { h: '指標', v: (r) => r.metric },
        { h: '年總量', v: (r) => fmt(r.value, 4), num: true }, { h: '單位', v: (r) => unitZh(r.unit) },
        { h: '筆數', v: (r) => String(r.n), num: true }, { h: '說明', v: (r) => (r.estimated ? '含推估值' : '') },
      ]));
    } else main.append(el('p', { class: 'note', text: '這一年還沒有資料。' }));
    if (d.sheetTotal && Object.keys(d.sheetTotal).length) {
      main.append(el('p', { class: 'muted', text: `原檔左上角年總量：${Object.entries(d.sheetTotal).map(([k, v]) => `${k} ${fmt(v, 4)}`).join('、')}` }));
    }

    // 原檔各列
    for (const part of d.parts) {
      const ed = d.editable;
      const addBtn = ed && part.canAdd ? el('button', { type: 'button', class: 'tv-add', text: '＋ 新增一列' }) : null;
      main.append(el('div', { class: 'i-head tv-parthead' }, [el('h3', { class: 'i-h3', text: `${part.title || '原檔各列'}（${part.rows.length} 列）` }), addBtn]));
      if (ed) main.append(el('p', { class: 'note', text: `按「修改」直接改這一列，存檔後系統依同樣規則重算；改過的值會保留原值、記為更正。${part.canAdd ? '' : '每個電號固定 12 個月，只能修改。'}` }));
      const t = el('table', { class: 'tv-table' });
      const ncol = part.columns.length + 3 + (ed ? 1 : 0);
      t.append(el('thead', {}, el('tr', {}, [ed ? el('th', { text: '' }) : null, el('th', { text: '列' }), el('th', { text: '盤點項目' }), ...part.columns.map((c) => el('th', { text: c.label })), el('th', { text: '系統值' })].filter(Boolean))));
      const tb = el('tbody');
      const reload = async (res) => {
        if (res?.assetsCreated?.length) await reloadTree();
        const sc = root.closest('.pane') || document.scrollingElement; const y = sc.scrollTop;
        await renderSheet(key, root); sc.scrollTop = y;
      };
      if (addBtn) addBtn.addEventListener('click', () => { if (tb.querySelector('.tv-edit[data-new]')) return; const f = sheetEditor(d, part, null, ncol, reload); f.dataset.new = '1'; tb.prepend(f); fitEditor(f); f.querySelector('input,select')?.focus(); });
      for (const r of part.rows) {
        const tr = el('tr', { class: r.assetId ? 'tv-click' : '' });
        if (ed) {
          const b = el('button', { type: 'button', class: 'tv-editbtn', text: '修改', 'aria-label': `修改第 ${r.row} 列` });
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = tr.nextElementSibling?.classList.contains('tv-edit') ? tr.nextElementSibling : null;
            if (open) { open.remove(); return; }
            const f = sheetEditor(d, part, r, ncol, reload); tr.after(f); fitEditor(f); f.querySelector('input,select')?.focus();
          });
          tr.append(el('td', {}, b));
        }
        tr.append(el('td', { class: 'num dim', text: String(r.row) }));
        const td = el('td');
        if (r.assetId) { const b = el('button', { type: 'button', class: 'link', text: r.assetName }); b.addEventListener('click', (e) => { e.stopPropagation(); UI.goSection(`tree:asset:${r.assetId}`); }); td.append(b); }
        else td.append(el('span', { class: 'muted', text: r.note || '不計入' }));
        tr.append(td);
        for (const c of part.columns) { const v = r.cells[c.key]; tr.append(el('td', { class: c.type === 'num' ? 'num' : '', text: v === undefined ? '' : c.type === 'num' && typeof v === 'number' ? fmt(v, 4) : rawCell(v) })); }
        const val = r.value ? `${fmt(r.value.value, 4)} ${unitZh(r.value.unit)}${STATE_ZH[r.value.state] ? `（${STATE_ZH[r.value.state]}）` : ''}${r.value.version > 1 ? '（已更正）' : ''}` : (r.assetId && r.note ? r.note : '');
        tr.append(el('td', { class: r.value ? 'num' : 'dim', text: val + (r.edited ? `（${r.edited} 院所頁修改）` : '') }));
        if (r.assetId) tr.addEventListener('click', () => focus({ assetId: r.assetId, metric: r.value?.metric, label: `${r.assetName}${r.value ? ` › ${r.value.metricName}` : ''}`, el: tr }, side));
        tb.append(tr);
      }
      t.append(tb);
      main.append(el('div', { class: 'tv-scroll' }, t));
    }
    // 沒有原檔的年度：系統紀錄
    if (!d.parts.length && d.list.length) {
      main.append(el('h3', { class: 'i-h3', text: `系統紀錄（${d.list.length} 筆）` }));
      const t = el('table', { class: 'tv-table' });
      t.append(el('thead', {}, el('tr', {}, ['盤點項目', '期間', '指標', '數值', '單位', '來源', '備註'].map((h) => el('th', { text: h })))));
      const tb = el('tbody');
      for (const r of d.list) {
        const tr = el('tr', { class: 'tv-click' });
        const b = el('button', { type: 'button', class: 'link', text: r.assetName }); b.addEventListener('click', (e) => { e.stopPropagation(); UI.goSection(`tree:asset:${r.assetId}`); });
        const end = r.end > r.start && r.end.endsWith('-01') ? new Date(Date.parse(`${r.end}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : r.end; // 迄日是下月 1 日＝不含
        tr.append(el('td', {}, b), el('td', { text: r.start === end ? r.start : `${r.start}～${end}` }), el('td', { text: r.metricName }),
          el('td', { class: 'num', text: fmt(r.value, 4) }), el('td', { text: `${unitZh(r.unit)}${STATE_ZH[r.state] ? `（${STATE_ZH[r.state]}）` : ''}` }), el('td', { text: r.source || '' }), el('td', { text: r.note || '' }));
        tr.addEventListener('click', () => focus({ assetId: r.assetId, metric: r.metric, label: `${r.assetName} › ${r.metricName}`, el: tr }, side));
        tb.append(tr);
      }
      t.append(tb);
      main.append(el('div', { class: 'tv-scroll' }, t));
    }
    renderSide(side);
  }

  // 表格很寬（冷媒頁 20 欄）時，表單固定在看得到的寬度，不跟著表格往右延伸
  function fitEditor(tr) {
    const sc = tr.closest('.tv-scroll'); const box = tr.querySelector('.tv-form');
    if (sc && box) box.style.width = `${Math.max(sc.clientWidth - 2, 240)}px`;
  }
  // 盤查表單的一列：表格下方展開成表單（每欄一格，必填欄標＊，公式欄改了輸入欄會照原檔公式重算）
  function sheetEditor(d, part, r, ncol, done) {
    const tr = el('tr', { class: 'tv-edit' });
    const box = el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: r ? `修改第 ${r.row} 列` : `新增一列（${part.title || d.name}）` })]);
    const grid = el('div', { class: 'tv-grid tv-sheet-grid' });
    const inputs = {};
    for (const c of part.columns) {
      const v = r?.raw?.[c.key] ?? '';
      if (c.readonly) { grid.append(field(c.label, el('input', { value: v, disabled: true }))); continue; }
      const props = c.type === 'date' ? { type: 'date' } : c.type === 'num' ? { type: 'text', inputMode: 'decimal' } : { type: 'text' };
      const n = inp(c.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? '' : v, props);
      if (c.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { n.type = 'text'; n.value = v; } // 原檔寫「年用量」這類文字就照原樣
      if (c.options) { const id = `dl-${d.key}-${part.part || 'p'}-${c.key}`; if (!document.getElementById(id)) document.body.append(el('datalist', { id }, c.options.map((o) => el('option', { value: o })))); n.setAttribute('list', id); }
      inputs[c.key] = n;
      grid.append(field(`${c.label}${c.required ? '＊' : ''}`, n, c.formula ? '原檔公式欄：改了相關欄位會自動重算' : null));
    }
    box.append(grid);
    const why = inp('', { placeholder: r ? '例：發票金額打錯' : '例：補登 12 月加油單' });
    box.append(el('div', { class: 'tv-grid' }, [field('修改原因（會記在異動歷程，可不填）', why)]));
    const payload = () => ({ year: d.year, tab: d.key, part: part.part || '', row: r?.row || null, reason: why.value.trim() || undefined,
      cells: Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value.trim()])) });
    const actions = [btn(r ? '儲存這一列' : '新增這一列', async () => {
      const res = await post(`/api/v1/orgs/${ORG.id}/ghg-sheet/rows`, payload());
      if (res.unchanged) { toast('沒有變更'); return; }
      const o = res.observations || {};
      const parts = [o.created && `新增 ${o.created} 筆`, o.new_version && `更正 ${o.new_version} 筆`, o.zeroed && `歸零 ${o.zeroed} 筆`, res.assetsCreated?.length && `新項目：${res.assetsCreated.join('、')}`].filter(Boolean);
      toast(res.counted ? `已儲存第 ${res.row} 列${parts.length ? `（${parts.join('，')}）` : ''}` : `已儲存第 ${res.row} 列，但${res.note || '這一列沒有計入'}`, res.counted ? 'ok' : '');
      await done(res);
    }, 'primary'), btn('取消', async () => tr.remove())];
    if (r && part.canAdd) actions.push(btn('刪除這一列', async () => {
      if (!(await confirmModal({ title: `刪除第 ${r.row} 列？`, body: '這一列的紀錄會歸零（原值保留在異動歷程，可以查到）。', okText: '刪除', danger: true }))) return;
      const res = await post(`/api/v1/orgs/${ORG.id}/ghg-sheet/rows/delete`, { year: d.year, tab: d.key, part: part.part || '', row: r.row, reason: why.value.trim() || undefined });
      toast(`已刪除第 ${res.row} 列`, 'ok'); await done(res);
    }, 'danger'));
    box.append(el('div', { class: 'tv-actions' }, actions));
    tr.append(el('td', { colSpan: ncol }, box));
    return tr;
  }

  // 原檔儲存格：Excel 浮點誤差（4.0999999999999996）收成 4.1
  function rawCell(v) {
    if (typeof v === 'number') return String(+v.toPrecision(12));
    const s = String(v);
    return /^-?\d+\.\d{8,}$/.test(s) ? String(+Number(s).toPrecision(12)) : s;
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
    if (sub === 'profile') return wrapErr(root, () => renderProfile(root));
    if (sub === 'reports') return wrapErr(root, () => renderReports(root));
    if (sub === 'dom') return renderDomain(arg, root);
    if (sub === 'sheet') return wrapErr(root, () => renderSheet(arg, root));
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
    if (sub === 'profile') return '盤點 › 院所基本資料';
    if (sub === 'reports') return '盤點 › 申報與報告';
    if (sub === 'dom') return `${pre}盤點 › ${domainOf(arg)?.label || arg}`;
    if (sub === 'sheet') return `盤點 › 盤查表單 › ${arg === '_rest' ? '其他盤點項目' : TREE?.sheets?.tabs.find((t) => t.key === arg)?.name || arg}`;
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
      if (!fields) fields = await call(FOCUS.profileKey ? `/api/v1/inv-fields?profileKey=${encodeURIComponent(FOCUS.profileKey)}` : FOCUS.zone ? '/api/v1/inv-fields' : `/api/v1/inv-fields?assetId=${encodeURIComponent(FOCUS.assetId)}${FOCUS.metric ? `&metric=${encodeURIComponent(FOCUS.metric)}` : ''}`);
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
    document.querySelectorAll('.tv-card.sel, .tv-th.sel, .tv-table tr.sel').forEach((n) => n.classList.remove('sel'));
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
        value: s.latest ? `${ym(s.latest.periodStart)}　${s.latest.label ? `${s.latest.label} ` : ''}${fmt(s.latest.value)} ${s.latest.unit}` : '尚無資料',
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
    // 版面：上面是要填的數值，下面是補充說明（關聯圖、逐月比對、規格、QR、異動歷程）
    const head = main.querySelector('.i-head');
    const fill = [a.assetType === 'power_account' ? usageBox(a, () => renderAsset(id, root)) : null, entryForm(d, () => renderAsset(id, root), side), recentList(d)].filter(Boolean);
    head.after(...fill, el('h3', { class: 'tv-more', text: '補充說明' }));
    main.append(specList(a));
    main.append(qrBox(a));
    main.append(historyList(d));
    FOCUS = FOCUS || { assetId: a.id, metric: null, label: `${a.name}（全部指標）`, fields: d.fields };
    if (!FOCUS.el) FOCUS.el = me;
    me.classList.add('sel');
    renderSide(side);
  }
  const RELATION = { feeds: { out: '供電給', in: '受電自' }, supplies: { out: '供應給', in: '供應來源' }, submeter_of: { out: '子表', in: '母表' }, part_of: { out: '包含', in: '屬於' } };
  const METRIC_NAME = (code) => META?.metrics?.find((m) => m.code === code)?.name || code;

  // ── 登錄數據（原「點位與進度」：每月抄表、帳單、紀錄都在這裡登，或掃 QR 到手機現場盤點頁）──
  // 登錄數據：選月份與來源，這個項目要填的數值一次列出來（主要用量排第一）；已登過的值直接帶出，改了會建立更正版本（原值保留）
  function entryForm(d, done, side) {
    const a = d.asset;
    const box = el('div', { class: 'tv-form tv-entry' }, [el('h3', { class: 'i-h3', text: '填報數值' })]);
    const kind = (code) => META?.metrics?.find((m) => m.code === code)?.value_kind;
    const ms = d.metrics.filter((m) => kind(m.code) !== 'cumulative');
    // 照帳單順序：主要用量、費用、各時段度數、需量、功因、其他，契約容量（很少變）最後
    const rank = (c) => (c === d.mainMetric ? 0 : /_cost_/.test(c) ? 1 : /contract/.test(c) ? 9 : /(peak|offpeak|semipeak)_kwh$/.test(c) ? 2 : /demand/.test(c) ? 3 : /power_factor/.test(c) ? 4 : 5);
    ms.sort((x, y) => rank(x.code) - rank(y.code));
    if (!ms.length) { box.append(el('p', { class: 'note', text: '這類項目沒有要定期填報的數值；規格在〔管理〕維護。' })); return box; }
    const now = new Date(); now.setMonth(now.getMonth() - 1);
    const month = inp(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, { type: 'month' });
    const src = sel([['', '（不指定來源）'], ...d.sources.map((x) => [x.id, `${x.name}（${x.kindLabel}）`])], d.sources.find((x) => x.sourceType === 'bill')?.id || d.sources[0]?.id || '');
    box.append(el('div', { class: 'tv-grid tv-entry-head' }, [field('月份', month), field('來源', src)]));
    const grid = el('div', { class: 'tv-grid tv-entry-grid' });
    const rows = ms.map((m) => {
      const n = inp('', { type: 'text', inputMode: 'decimal', placeholder: '未填' });
      const had = el('small', { class: 'muted' });
      grid.append(el('label', { class: 'tv-f' + (m.code === d.mainMetric ? ' main' : '') }, [el('span', { text: `${m.name}（${m.std_unit}）` }), n, had]));
      // 點進輸入格：右欄換成這個數值會填進的報告欄位
      n.addEventListener('focus', () => { if (side) focus({ assetId: a.id, metric: m.code, label: `${a.name} › ${m.name}` }, side); });
      return { m, n, had, prev: null };
    });
    box.append(grid);
    const period = () => {
      const [y, mo] = month.value.split('-').map(Number); if (!y || !mo) return null;
      return [`${y}-${String(mo).padStart(2, '0')}-01`, mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`];
    };
    const load = async () => {
      const pr = period(); if (!pr) return;
      const list = await call(`/api/v1/observations?assetId=${a.id}&from=${pr[0]}&to=${pr[1]}`).catch(() => []);
      for (const r of rows) {
        const hits = list.filter((o) => o.metric_code === r.m.code && o.period_start === pr[0] && o.period_end === pr[1]);
        const o = hits.find((x) => x.source_id === src.value) || (src.value ? null : hits[0]) || null;
        r.prev = o;
        r.n.value = o && o.raw_value !== null && o.raw_value !== undefined ? String(o.raw_value) : '';
        r.had.textContent = o ? `已填（${o.source_name || ''}${o.submitted_at ? `，${o.submitted_at.slice(0, 10)}` : ''}）` : '';
      }
    };
    month.addEventListener('change', load); src.addEventListener('change', load);
    load();
    box.append(el('div', { class: 'tv-actions' }, [btn('儲存這個月', async () => {
      const pr = period(); if (!pr) throw new Error('請選月份');
      let n = 0;
      for (const r of rows) {
        const v = r.n.value.trim();
        if (!v) continue;
        if (r.prev && String(r.prev.raw_value) === v) continue;
        if (r.prev) await post(`/api/v1/observations/${r.prev.id}/correct`, { rawValue: v, reason: '院所頁更正' });
        else await post('/api/v1/observations', { assetId: a.id, sourceId: src.value || undefined, metricCode: r.m.code, periodStart: pr[0], periodEnd: pr[1], rawValue: v });
        n++;
      }
      toast(n ? `已儲存 ${n} 個數值` : '沒有變更', n ? 'ok' : ''); if (n) done();
    }, 'primary'), el('span', { class: 'muted', text: '沒有數值就留空。表頭累積讀數、跨月帳單、換表請用手機「現場盤點」。' })]));
    return box;
  }
  // 電號用電速覽：前日、上月、前年。前日要台電智慧電表（AMI）每日資料，在這裡匯入下載檔
  const SRC_LABEL = { ami: '智慧電表', bill: '電費單', 'ami+bill': '智慧電表＋電費單', 'bill+ami': '智慧電表＋電費單' };
  function usageBox(a, done) {
    const box = el('div', { class: 'tv-usage' }, [el('p', { class: 'muted', text: '用電速覽載入中…' })]);
    const tile = (label, v, when, note) => el('div', { class: 'tv-ut' }, [
      el('span', { class: 'tv-ul', text: label }),
      el('b', { class: 'tv-uv', text: v ? `${fmt(v.kwh)} 度` : '—' }),
      el('span', { class: 'tv-cs', text: v ? when(v) : note }),
    ]);
    call(`/api/v1/assets/${encodeURIComponent(a.id)}/usage`).then((u) => {
      box.textContent = '';
      const part = (v) => (v?.partialDays ? `，只有 ${v.partialDays}/${v.needDays} 天` : '');
      box.append(el('div', { class: 'tv-uts' }, [
        tile('前日用電', u?.day, (v) => `${v.date.slice(5).replace('-', '/')}${v.stale ? '（最近一天）' : ''}・${SRC_LABEL[v.source] || v.source}`, '匯入台電智慧電表資料後顯示'),
        tile('上月用電', u?.month, (v) => `${ym(v.month + '-01')}・${SRC_LABEL[v.source] || v.source}${part(v)}`, '登錄電費單或智慧電表資料後顯示'),
        tile('去年用電', u?.year, (v) => `${v.year - 1911} 年全年・${SRC_LABEL[v.source] || v.source}${part(v)}`, '登錄全年電費單後顯示'),
      ]));
      const inp = el('input', { type: 'file', accept: '.csv,.xlsx,.txt', hidden: true, 'aria-label': '台電智慧電表用電檔' });
      inp.addEventListener('change', async () => {
        const f = inp.files?.[0]; if (!f) return;
        const fd = new FormData(); fd.append('file', f, f.name);
        try {
          const r = await call(`/api/v1/assets/${encodeURIComponent(a.id)}/ami`, { method: 'POST', body: fd });
          toast(`匯入 ${r.created + r.updated} 天${r.from ? `（${r.from}～${r.to}）` : ''}${r.duplicate ? `，${r.duplicate} 天已有` : ''}${r.partial.length ? `，${r.partial.length} 天資料不完整未匯入` : ''}`, 'ok');
          done();
        } catch (e) { toast(`匯入失敗：${e.message}`, 'err'); }
      });
      const btn = el('button', { type: 'button', text: '匯入台電智慧電表資料' });
      btn.addEventListener('click', () => inp.click());
      box.append(el('div', { class: 'tv-uact' }, [btn, inp, el('span', { class: 'muted', text: '台電高壓用戶服務入口網站下載的用電檔（CSV 或 XLSX，每 15 分鐘或每日都可以）。' })]));
    }).catch((e) => { box.textContent = `用電速覽載入失敗：${e.message}`; });
    return box;
  }
  function recentList(d) {
    const box = el('div', {});
    if (!d.recent.length) return box;
    box.append(el('h3', { class: 'i-h3', text: '最近登錄' }));
    box.append(listTable(d.recent.map((r) => ({ ...r })), [
      { h: '期間', v: (r) => `${r.period_start.slice(0, 7)}${r.period_end && r.period_end.slice(0, 7) !== r.period_start.slice(0, 7) && !(r.period_end.endsWith('-01')) ? ` ～ ${r.period_end}` : ''}` },
      { h: '指標', v: (r) => r.metric_name || r.metric_code },
      { h: '數值', v: (r) => (r.value_state === 'missing' ? '缺漏' : `${fmt(r.raw_value ?? r.value_std, 3)} ${r.raw_unit || r.std_unit || ''}`), num: true },
      { h: '來源', v: (r) => r.source_name || '' },
      { h: '登錄', v: (r) => `${(r.submitted_at || '').slice(0, 10)} ${r.who || ''}` },
    ]));
    return box;
  }
  // 規格（原「初始建檔」的電號、變壓器、發電機、設備主檔欄位）：顯示；修改在〔管理〕
  function specList(a) {
    const box = el('div', {});
    const defs = META?.assetAttrs?.[a.assetType] || [];
    const rows = defs.map(([k, label]) => [label, a.attrs?.[k]]).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false);
    box.append(el('h3', { class: 'i-h3', text: '規格' }));
    if (!defs.length && !a.attrs?.note) { box.append(el('p', { class: 'note', text: '這類項目沒有規格欄位。' })); return box; }
    if (!rows.length && !a.attrs?.note) { box.append(el('p', { class: 'note', text: `還沒填規格（${defs.length} 個欄位），在〔管理〕填。` })); return box; }
    const dl = el('dl', { class: 'tv-dl' });
    for (const [l, v] of rows) dl.append(el('dt', { text: l }), el('dd', { text: v === true ? '是' : String(v) }));
    if (a.attrs?.note) dl.append(el('dt', { text: '備註' }), el('dd', { text: a.attrs.note }));
    box.append(dl);
    return box;
  }
  function qrBox(a) {
    return el('div', { class: 'tv-qr' }, [
      el('img', { src: `/api/v1/assets/${a.id}/qr.png`, alt: `${a.name} 現場盤點 QR Code`, width: 120, height: 120, loading: 'lazy' }),
      el('div', {}, [el('b', { text: '現場盤點 QR' }), el('p', { class: 'muted', text: '印出來貼在表或設備上，手機掃描直接登錄這一項（可拍照、斷網暫存）。' }),
        el('a', { href: `/p/#/collect/${a.id}`, target: '_blank', rel: 'noopener', text: '開啟現場盤點頁 ↗' }), el('span', { text: '　' }),
        el('a', { href: `/api/v1/assets/${a.id}/qr.png`, download: `${a.name}-QR.png`, text: '下載 QR 圖檔' })]),
    ]);
  }
  // 異動歷程（原「異動登錄」：新增、修改、停用都會自動留紀錄，含原因與經手人）
  const CHANGE = { create: '新增', update: '修改', disable: '停用', clone: '複製', move: '搬移' };
  function historyList(d) {
    const box = el('div', {});
    box.append(el('h3', { class: 'i-h3', text: '異動歷程' }));
    if (!d.history.length) { box.append(el('p', { class: 'note', text: '沒有紀錄。' })); return box; }
    const ht = listTable(d.history, [
      { h: '時間', v: (h) => (h.at || '').slice(0, 16).replace('T', ' ') },
      { h: '異動', v: (h) => CHANGE[h.change_type] || h.change_type },
      { h: '內容', v: (h) => (h.changes || []).map((c) => `${c.label}：${short(c.from)} → ${short(c.to)}`).join('；') },
      { h: '原因', v: (h) => h.reason || '' },
      { h: '經手', v: (h) => h.actor_name || (h.actor === 'seed' ? '看板資料轉入' : h.actor || '') },
    ]);
    ht.querySelector('table').classList.add('wrap');
    box.append(ht);
    return box;
  }
  const short = (v) => { if (v === null || v === undefined || v === '') return '（空）'; const t = typeof v === 'object' ? JSON.stringify(v) : String(v); return t.length > 40 ? `${t.slice(0, 40)}…` : t; };

  // ── 院所基本資料（原「初始建檔 › 基本資料（附表三）」與「水足跡範疇與基線」；各申報共用）──
  async function renderProfile(root) {
    const { main, side } = layout(root);
    const r = await call(`/api/v1/org-profile?orgId=${ORG.id}`);
    const data = { ...r.data };
    main.append(h2('院所基本資料', [ORG.name]));
    const inputs = {};
    // 先放要填的欄位（各申報的機關資料、能源查核、環境部、節能填報），說明性的長文（盤查報告說明、水足跡範疇）放下面
    const NOTE_GROUPS = ['ghg', 'water'];
    const groupBox = (gk, gl, open) => {
      const fs = Object.values(r.fields).filter((f) => (f.group || 'ghg') === gk);
      const uniq = []; const seen = new Set(); for (const f of fs) if (!seen.has(f.key)) { seen.add(f.key); uniq.push(f); }
      const isLong = (f) => f.short === false || !f.group;
      const ordered = [...uniq.filter((f) => !isLong(f)), ...uniq.filter(isLong)];
      const d = el('details', { class: 'tv-pgroup', open });
      d.append(el('summary', { text: `${gl}（已填 ${uniq.filter((f) => data[f.key]).length}／${uniq.length}）` }));
      const grid = el('div', { class: 'tv-grid' });
      for (const f of ordered) {
        const long = isLong(f);
        const n = f.options ? el('select') : long ? el('textarea', { rows: 3 }) : inp(data[f.key] ?? '', { placeholder: f.default ? `預設：${f.default}` : '' });
        if (f.options) { for (const [v, l] of f.options) { const o = el('option', { text: l }); o.value = v; n.append(o); } n.value = data[f.key] ?? ''; }
        if (long) n.value = data[f.key] ?? '';
        inputs[f.key] = n;
        n.addEventListener('focus', () => { FOCUS = { label: `院所基本資料 › ${f.label}`, profileKey: f.key }; renderSide(side); });
        const lab = field(f.label, n, f.hint || null);
        if (long) lab.classList.add('wide');
        // 公開資料先補的值：淡黃底，滑過顯示來源；院方儲存後就算確認過
        const pub = data._pub?.[f.key];
        if (pub) { lab.classList.add('tv-pubf'); n.title = `公開資料：${pub.url}`; }
        grid.append(lab);
      }
      d.append(grid);
      return d;
    };
    const groups = Object.entries(r.groups);
    groups.filter(([gk]) => !NOTE_GROUPS.includes(gk)).forEach(([gk, gl], i) => main.append(groupBox(gk, gl, i < 2)));
    main.append(el('div', { class: 'tv-actions' }, [btn('儲存基本資料', async () => {
      const out = { ...data }; for (const [k, n] of Object.entries(inputs)) out[k] = n.value;
      await call('/api/v1/org-profile', { method: 'PUT', json: { orgId: ORG.id, data: out } });
      toast('已儲存', 'ok'); renderProfile(root);
    }, 'primary')]));
    main.append(el('h3', { class: 'tv-more', text: '補充說明' }));
    groups.filter(([gk]) => NOTE_GROUPS.includes(gk)).forEach(([gk, gl]) => main.append(groupBox(gk, gl, false)));
    main.append(el('p', { class: 'note', text: '各申報共用的基本資料只填一次。病床數、樓地板面積、員工人數與工時、門急診住院人次等數字在「📋 營運數據」逐年填報。點欄位，右邊會列出它填進哪些報告。' }));
    main.append(el('div', { class: 'tv-actions' }, [btn('儲存基本資料', async () => {
      const out = { ...data }; for (const [k, n] of Object.entries(inputs)) out[k] = n.value;
      await call('/api/v1/org-profile', { method: 'PUT', json: { orgId: ORG.id, data: out } });
      toast('已儲存', 'ok'); renderProfile(root);
    }, 'primary')]));
    FOCUS = null; renderSide(side);
  }

  // ── 申報與報告（原「申報與報告」）：模板清單與本院報告案件；產出、送審、匯出在平台 ──
  async function renderReports(root) {
    const { main, side } = layout(root);
    const [tpls, cases] = await Promise.all([call('/api/v1/report-templates'), call(`/api/v1/report-cases?orgId=${ORG.id}`).catch(() => [])]);
    const latest = new Map(); for (const t of tpls) { const cur = latest.get(t.code); if (!cur || t.version > cur.version) latest.set(t.code, t); }
    main.append(h2('申報與報告'));
    main.append(el('p', { class: 'note', text: '盤點的數字會自動帶進這些報告。點一份報告，右邊列出它的各表與欄位；產出、送審、匯出 Excel／Word／PDF 在油水電氣平台。' }));
    const rows = [...latest.values()].map((t) => ({ ...t, n: cases.filter((c) => c.template_code === t.code).length }));
    const tbl = listTable(rows, [{ h: '報告', v: (t) => t.name }, { h: '依據', v: (t) => t.standard || '' }, { h: '本院案件', v: (t) => String(t.n), num: true }]);
    tbl.querySelector('table').classList.add('wrap');
    tbl.querySelectorAll('tbody tr').forEach((tr, i) => {
      tr.classList.add('tv-click'); tr.tabIndex = 0;
      const pick = () => { tbl.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel'); showTemplate(rows[i], side); };
      tr.addEventListener('click', pick); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    });
    main.append(tbl);
    main.append(el('p', {}, [el('a', { href: '/p/#/reports', target: '_blank', rel: 'noopener', text: '到平台建立報告案件、產出與匯出 ↗' }), el('span', { text: '　' }),
      el('a', { href: '/p/#/measures', target: '_blank', rel: 'noopener', text: '節約能源措施與計畫 ↗' })]));
    if (cases.length) {
      main.append(el('h3', { class: 'i-h3', text: '本院報告案件' }));
      main.append(listTable(cases, [{ h: '報告', v: (c) => c.template_name || '' }, { h: '年度', v: (c) => String(c.year || '') }, { h: '狀態', v: (c) => c.last_run_status || c.status || '' }]));
    }
    side.textContent = '';
    side.append(el('h3', { class: 'tv-sideh', text: '報告欄位' }), el('p', { class: 'muted', text: '點左邊任一份報告，這裡列出它的各表與欄位。' }));
  }
  async function showTemplate(t, side) {
    side.textContent = '';
    side.append(el('h3', { class: 'tv-sideh', text: '報告欄位' }), el('p', { class: 'tv-focus', text: t.name }));
    const box = el('div', { class: 'tv-fields', text: '載入中…' }); side.append(box);
    let full = t;
    if (!t.mappings) { try { full = await call(`/api/v1/report-templates/${t.id}`); } catch { full = t; } }
    box.textContent = '';
    const secs = j(full.sections); const maps = full.mappings || [];
    if (!maps.length) { for (const sct of secs) box.append(el('p', { text: sct.title })); return; }
    for (const sct of secs) {
      const list = maps.filter((m) => m.section === sct.id); if (!list.length) continue;
      const d = el('details', { class: 'tv-tpl', open: true });
      d.append(el('summary', {}, [el('span', { text: sct.title }), el('i', { class: 'tv-n', text: String(list.length) })]));
      const ul = el('ul'); for (const m of list) ul.append(el('li', {}, [el('b', { text: m.label })]));
      d.append(ul); box.append(d);
    }
  }
  const j = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };

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
        if (i === 0 && r.sec) {
          const b = el('button', { type: 'button', class: 'link', text: v }); b.addEventListener('click', () => UI.goSection(r.sec));
          const td = el('td', {}, b); if (r.depth) td.style.paddingInlineStart = `${0.75 + r.depth * 1.25}rem`; tr.append(td);
        }
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
    { h: '名稱', v: (r) => r.name },
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
      if (other) {
        main.append(el('h3', { class: 'i-h3', text: other.name }));
        for (const g of other.children) {
          main.append(el('h4', { class: 'i-h4', text: `${g.name}（${flatAssets(g.children).length}）` }));
          main.append(listTable(flatAssets(g.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols));
        }
      }
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
    const subs = f.n.children.filter((c) => c.kind === 'group');
    const direct = f.n.children.filter((c) => c.kind !== 'group');
    if (direct.length) main.append(listTable(flatAssets(direct).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols));
    for (const g of subs) {
      main.append(el('h4', { class: 'i-h4', text: `${g.name}（${flatAssets(g.children).length}）` }));
      main.append(listTable(flatAssets(g.children).map((r) => ({ ...r, sec: `tree:asset:${r.id}` })), assetCols));
    }
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
      line.append(btn('規格、來源與範圍', async () => UI.goSection(`mng:asset:${r.id}`)));
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
    const name = inp('', { placeholder: '例：受電點 22.8kV' });
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

    main.append(attrsEditor(a, back));
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
      line.append(btn('規格、來源與範圍', async () => UI.goSection(`mng:asset:${r.id}`)));
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
  // 規格（原「初始建檔」電號、變壓器、緊急發電機、設備主檔、水源、排放口等欄位；欄位定義在平台資料字典）
  function attrsEditor(a, back) {
    const defs = META?.assetAttrs?.[a.assetType] || [];
    const box = el('div', { class: 'tv-form' }, [el('h3', { class: 'i-h3', text: '規格' })]);
    const cur = a.attrs || {};
    const inputs = {};
    const mk = ([k, label, type, options, def]) => {
      let n;
      const v = cur[k] ?? '';
      if (type === 'select') { n = sel([['', '（未填）'], ...(options || []).map((o) => (Array.isArray(o) ? o : [o, o]))], String(v)); }
      else if (type === 'checkbox') { n = el('input', { type: 'checkbox', checked: !!(cur[k] ?? def) }); }
      else n = inp(v, { type: type === 'number' ? 'number' : 'text', step: 'any' });
      inputs[k] = [n, type];
      const f = field(label, n);
      if (type === 'checkbox') f.classList.add('tv-check');
      return f;
    };
    const main = defs.filter((x) => !x[5]); const adv = defs.filter((x) => x[5]);
    if (main.length) box.append(el('div', { class: 'tv-grid' }, main.map(mk)));
    if (adv.length) { const dd = el('details', { open: adv.some(([k]) => cur[k] !== undefined && cur[k] !== '') }); dd.append(el('summary', { text: `更多欄位（${adv.length}）：申報用細項` }), el('div', { class: 'tv-grid' }, adv.map(mk))); box.append(dd); }
    const note = el('textarea', { rows: 2 }); note.value = cur.note || '';
    box.append(field('備註', note));
    box.append(btn('儲存規格', async () => {
      const next = { ...cur };
      for (const [k, [n, type]] of Object.entries(inputs)) {
        const v = type === 'checkbox' ? n.checked : n.value.trim();
        if (v === '' || v === false) delete next[k]; else next[k] = type === 'number' ? Number(v) : v;
      }
      if (note.value.trim()) next.note = note.value.trim(); else delete next.note;
      const reason = await askReason(`修改「${a.name}」規格`); if (!reason) return;
      await post(`/api/v1/assets/${a.id}`, { attrs: next, reason }, 'PATCH'); toast('已儲存規格', 'ok'); await refreshAfter(back);
    }, 'primary'));
    return box;
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
      // 表七建築資料（原「初始建檔 › 建築資料」）
      const ba = b.attrs || {}; const t7 = {};
      const T7 = [['use', '用途（例：醫療大樓）'], ['builtYear', '建造年份（民國年）', 'number'], ['floorsBelow', '地下樓層數', 'number'], ['floorsAbove', '地上樓層數', 'number'],
        ['roof', '屋頂構造'], ['entrance', '建築入口大門方位']];
      const area = inp(b.floorAreaM2 ?? '', { type: 'number', step: 'any' });
      const t7box = el('details', { class: 'tv-t7' }, [el('summary', { text: '表七 建築資料（能源查核申報）' }), el('div', { class: 'tv-grid' }, [
        field('樓地板面積（m²）', area), ...T7.map(([k, l, t]) => { t7[k] = inp(ba[k] ?? '', { type: t || 'text' }); return field(l, t7[k]); })])]);
      if (!b.outdoor) line.append(t7box);
      line.append(btn('儲存', async () => {
        const attrs = b.outdoor ? { zoneKind: 'outdoor' } : Object.fromEntries(Object.entries(t7).map(([k, n]) => [k, n.type === 'number' && n.value !== '' ? Number(n.value) : n.value.trim()]));
        await save(b, { name: name.value.trim(), floors: floors.value.trim(), floorAreaM2: !b.outdoor && area.value !== '' ? Number(area.value) : undefined, attrs }); toast('已儲存', 'ok');
      }, 'primary'));
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
    defaultSection: () => (MODE === 'sheet' ? `tree:sheet:${OPEN_TAB}` : `tree:dom:${OPEN}`),
    isSection: (id) => /^(tree|mng):/.test(String(id || '')),
  };
})();
