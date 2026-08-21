'use strict';
// EMS 維護表單前端。
//
// 設計要點（與舊版的差別）：
// 1. 表單依「伺服器推導的 schema 規格」長，不是依「載入到的 JSON 長什麼樣」長。
//    → JSON 缺的欄位也看得到、空陣列也能加第一筆、新增項目帶合法預設值（enum 不會是 ''）。
// 2. 分區導覽：一次只渲染一個分區，不再是一頁 8 萬像素、1000 多個輸入框。
// 3. 送出前先看變更摘要；有未送出修改時離開會擋；草稿存 localStorage 防 session 逾時。

// ─────────────────────────────── 小工具 ───────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('data-') || k === 'role') n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of Array.isArray(kids) ? kids : [kids]) if (c) n.append(c);
  return n;
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

async function api(path, opts = {}) {
  const headers = { 'X-Requested-With': 'ems-admin', ...(opts.headers || {}) };
  // FormData 的 Content-Type 必須讓瀏覽器自己帶（要含 boundary），不能手動指定
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// audit.js（電力健檢填報）是另一支 classic script，共用這裡的 UI 小工具。
// 兩邊資料模型不同、儲存位置不同、送出門檻也不同，只共用外觀與對話框。
window.EMSUI = {
  el, api, sleep,
  toast: (...a) => toast(...a),
  toastHide: () => toastHide(),
  confirmModal: (...a) => confirmModal(...a),
  closeModal: (...a) => closeModal(...a),
  gotoAuditCell: (p) => gotoAuditCell(p),
};

// ─────────────────────────────── 狀態 ───────────────────────────────
let SPEC = null;      // 由 /api/schema 取得的欄位樹
let DATA = null;      // 編輯中的資料
let ORIG = null;      // 載入當下的快照，用來算「改了什麼」
let ME = null;
let SECTIONS = [];
let activeId = null;
let busy = false;
const collapsed = new Map();   // 陣列項目卡片的展開/收合狀態（key = data path）

// 顯示範圍：'common' 只顯示第 1 層（日常會改的讀值/狀態），'all' 全部。
// 院方的抱怨是「我只想改幾個數字，為什麼要看到色票和座標」，所以預設 common。
let MODE = 'common';
try { MODE = localStorage.getItem('ems-admin-mode') === 'all' ? 'all' : 'common'; } catch {}
const showsTier = (t) => MODE === 'all' || t === 1;

// ─────────────────── spec 尋址（把資料路徑對應到規格節點） ───────────────────
function specAt(segs) {
  let node = SPEC;
  for (const s of segs) {
    if (!node) return null;
    if (node.type === 'array') { node = node.item; continue; }   // 數字索引 → 陣列項目規格
    if (node.type === 'object') { node = (node.fields || []).find((f) => f.key === s); continue; }
    return null;
  }
  return node;
}
function dataAt(segs) {
  let v = DATA;
  for (const s of segs) { if (v == null) return undefined; v = v[s]; }
  return v;
}
const pathKey = (segs) => segs.join('.');

// ─────────────────────────────── 分區定義 ───────────────────────────────
const TASKS = {
  contact: '📇 聯絡人與帳號',
  audit: '🔌 電力健檢填報',
  board: '🖥 看板維護',
  progress: '📄 進度與交付',
};
const sectionById = (id) => SECTIONS.find((s) => s.id === id) || null;
const currentTask = () => sectionById(activeId)?.task || 'board';

function buildSections() {
  const S = [];

  // ── 電力健檢填報（公文附件一／三）──
  // 這些區塊的資料存在主機本地、不進公開 repo，由 audit.js 負責渲染與送出。
  for (const b of window.EMSAudit?.spec()?.blocks || []) {
    S.push({ id: `a-${b.id}`, task: b.task === 'contact' ? 'contact' : 'audit', group: '',
      label: `${b.icon} ${b.label}`, audit: b.id });
  }

  // ── 看板維護 ──
  // 2026-08-21 改版：原本這一整組是整個畫面的骨幹，現在降成與上面兩支任務平行的一支。
  // 「常用／全部欄位」與「看板對照圖」也只在這支任務裡出現（見 applyTaskChrome）。
  S.push({ task: 'board',
    id: 'basic', group: '📋 院所', label: '基本資料', base: [],
    keys: ['name', 'boardTitle', 'location', 'updated', 'version', 'layout', 'show', 'hideMeta', 'liveData', 'peakShave', 'peakShaveHide', 'scenarios'],
  });

  // 配置圖／供電規劃資料量大（804 戰時展開後單頁 12,000 px），有設的話拆成獨立分區；
  // 沒設的話留在情境分區裡，才有地方按「啟用此區塊」。
  const CORE = ['perf', 'endur', 'supply', 'supplySum', 'detailLabel', 'detail', 'store', 'use'];
  (DATA.resources || []).forEach((r, i) => {
    const g = `${r.icon || '📦'} ${r.name || r.id || `資源 ${i + 1}`}`;
    S.push({ task: 'board', id: `r${i}m`, group: g, label: '區塊設定', base: ['resources', i], keys: ['id', 'icon', 'name'], resourceIndex: i });
    for (const [sc, zh] of [['peace', '平時'], ['war', '戰時/救災']]) {
      const big = ['plan', 'power'].filter((k) => r[sc]?.[k] != null);
      const small = ['plan', 'power'].filter((k) => r[sc]?.[k] == null);
      S.push({ task: 'board', id: `r${i}${sc[0]}`, group: g, label: zh, base: ['resources', i, sc], keys: [...CORE, ...small] });
      if (big.length) S.push({ task: 'board', id: `r${i}${sc[0]}x`, group: g, label: `${zh}·配置與供電`, base: ['resources', i, sc], keys: big });
    }
    S.push({ task: 'board', id: `r${i}d`, group: g, label: `設備清單（${(r.devices || []).length}）`, base: ['resources', i], keys: ['devices'] });
  });

  S.push({ task: 'board', id: 'envp', group: '🌡 環境參數', label: '平時樓層', base: ['env'], keys: ['peace'] });
  S.push({ task: 'board', id: 'envw', group: '🌡 環境參數', label: '戰時樓層', base: ['env'], keys: ['war'] });
  S.push({ task: 'board', id: 'envt', group: '🌡 環境參數', label: '門檻與關鍵樓層', base: ['env'], keys: ['thresholds', 'criticalFloors'] });
  S.push({ task: 'board', id: 'envc', group: '🌡 環境參數', label: '碳盤查表', base: ['env'], keys: ['carbon'] });

  S.push({ task: 'board', id: 'rep', group: '📊 報表與 ESG', label: '匯出報表', base: [], keys: ['report'] });
  S.push({ task: 'board', id: 'esg', group: '📊 報表與 ESG', label: 'ESG 面板', base: [], keys: ['esgPanels'] });

  // 附件二：流程與權責 ＋ 填報送出紀錄 ＋ 報告交付。放最後，因為它是「看進度」不是「填東西」。
  if (window.EMSAudit?.spec()) S.push({ task: 'progress', id: 'a-progress', group: '', label: '📄 流程與權責', progress: true });
  return S;
}

// 一條資料路徑屬於哪個分區（變更摘要的圓點、422 錯誤定位都靠它）
function sectionIdFor(segs) {
  const [a, b, c, d] = segs;
  if (a === 'resources' && typeof b === 'number') {
    if (c === 'peace' || c === 'war') {
      const big = (d === 'plan' || d === 'power') && SECTIONS.some((s) => s.id === `r${b}${c[0]}x`);
      return `r${b}${c[0]}${big ? 'x' : ''}`;
    }
    if (c === 'devices') return `r${b}d`;
    return `r${b}m`;
  }
  if (a === 'env') {
    if (b === 'peace') return 'envp';
    if (b === 'war') return 'envw';
    if (b === 'carbon') return 'envc';
    return 'envt';
  }
  if (a === 'report') return 'rep';
  if (a === 'esgPanels') return 'esg';
  return 'basic';
}

// ─────────────────────────────── 變更比對 ───────────────────────────────
// 陣列用 LCS 對齊再比對。不對齊的話，刪掉第 1 項會讓後面每一項的索引都位移，
// 一次刪除就被算成幾十筆修改（實測刪 1 筆供給端 → 顯示「未送出 31 項修改」）。
function alignArrays(A, B) {
  const a = A.map((v) => JSON.stringify(v));
  const b = B.map((v) => JSON.stringify(v));
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'same', i, j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', i }); i++; }
    else { ops.push({ t: 'add', j }); j++; }
  }
  while (i < n) ops.push({ t: 'del', i: i++ });
  while (j < m) ops.push({ t: 'add', j: j++ });
  return ops;
}

// 全是原始型別的陣列（每日序列等）整包當成一項修改，不逐格報 30 筆
const allPrimitive = (arr) => arr.every((v) => v === null || typeof v !== 'object');

// 回傳 [{ segs, from, to, kind }]，kind: change | add | remove
function diffTree(a, b, segs, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = Array.isArray(a) ? a : [];
    const B = Array.isArray(b) ? b : [];
    if (allPrimitive(A) && allPrimitive(B)) {
      if (JSON.stringify(A) !== JSON.stringify(B)) out.push({ segs, from: A, to: B, kind: 'change' });
      return out;
    }
    // 連續的 del/add 視為「同一項被修改」，才看得到欄位級的前後值
    const ops = alignArrays(A, B);
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.t === 'same') continue;
      if (op.t === 'del' && ops[k + 1]?.t === 'add') { diffTree(A[op.i], B[ops[k + 1].j], [...segs, ops[k + 1].j], out); k++; continue; }
      if (op.t === 'del') out.push({ segs: [...segs, op.i], from: A[op.i], to: undefined, kind: 'remove' });
      else out.push({ segs: [...segs, op.j], from: undefined, to: B[op.j], kind: 'add' });
    }
    return out;
  }
  if (isObj(a) || isObj(b)) {
    const A = isObj(a) ? a : {};
    const B = isObj(b) ? b : {};
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      // 「原本沒有這個鍵」↔「現在是空陣列」對看板毫無差別（zod 本來就會補 []），不列為修改
      const empty = (v) => Array.isArray(v) && v.length === 0;
      if (!(k in A)) { if (!empty(B[k])) out.push({ segs: [...segs, k], from: undefined, to: B[k], kind: 'add' }); }
      else if (!(k in B)) { if (!empty(A[k])) out.push({ segs: [...segs, k], from: A[k], to: undefined, kind: 'remove' }); }
      else diffTree(A[k], B[k], [...segs, k], out);
    }
    return out;
  }
  if (a !== b) out.push({ segs, from: a, to: b, kind: 'change' });
  return out;
}
const changes = () => (ORIG && DATA ? diffTree(ORIG, DATA, [], []) : []);

// 路徑 → 中文麵包屑（用 spec 的 label，陣列索引補上該項的標題）
function breadcrumb(segs) {
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (typeof s === 'number') {
      const item = dataAt(segs.slice(0, i + 1));
      parts.push(itemTitle(item, s));
    } else {
      const sp = specAt(segs.slice(0, i + 1));
      parts.push(sp?.label || s);
    }
  }
  return parts.join(' › ');
}

const short = (v) => {
  if (v === undefined) return '（無）';
  if (v === null) return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) {
    if (!v.length) return '（空，0 筆）';
    if (allPrimitive(v)) { const s = v.join(', '); return `${s.length > 44 ? s.slice(0, 44) + '…' : s}（${v.length} 筆）`; }
    return `${v.length} 筆`;
  }
  if (isObj(v)) return isObj(v) && (v.name || v.label || v.title) ? `「${v.name || v.label || v.title}」` : '（整個區塊）';
  const s = String(v);
  return s === '' ? '（空白）' : s.length > 40 ? s.slice(0, 40) + '…' : s;
};

function itemTitle(v, i) {
  if (isObj(v)) return v.name || v.label || v.title || v.item || v.floor || v.headline || v.k || `第 ${i + 1} 項`;
  return `第 ${i + 1} 項`;
}

// ─────────────────────────────── 表單渲染 ───────────────────────────────
// 每個輸入框都掛 data-path（格式與後端 zod 錯誤路徑一致：resources.0.peace.supply.3.esg），
// 422 才有辦法反查回畫面上的欄位。

function markChanged() {
  // 分區清單會隨資料變（設備數、資源名稱、剛啟用的配置圖/供電規劃），每次改動都重算
  SECTIONS = buildSections();
  renderNav();
  updateDirtyBadge();
  saveDraft();
}

// 從「未複驗清單」跳到那一格。健檢的格子用 data-acell 定位（看板那套用 data-path）。
function gotoAuditCell(p) {
  goSection(`a-${p.block}`);
  requestAnimationFrame(() => {
    const sel = `[data-acell="${CSS.escape(`${p.block}/${p.row === null ? '' : p.row}/${p.key}`)}"]`;
    const alt = `[data-acell="${CSS.escape(`${p.block}//${p.key}`)}"]`;
    const node = document.querySelector(sel) || document.querySelector(alt);
    if (!node) return;
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  });
}

function fieldRow(spec, segs, control, opts = {}) {
  const row = el('div', { class: 'field' + (opts.wide ? ' wide' : ''), 'data-path': pathKey(segs) }, [
    el('label', { class: 'flabel' }, [
      el('span', { text: spec.label || segs[segs.length - 1] }),
      opts.unset ? el('em', { class: 'unset-tag', text: '未設定' }) : null,
    ]),
    el('div', { class: 'fctl' }, [
      control,
      spec.hint ? el('div', { class: 'note', text: spec.hint }) : null,
      // 「這個欄位對應看板上哪一塊」——院方看不出對應關係是原本的抱怨之一
      spec.where ? el('div', { class: 'note where', text: `🖥 看板位置：${spec.where}` }) : null,
      opts.extra || null,
    ]),
  ]);
  return row;
}

// 取值：JSON 沒有這個鍵時不寫進資料，只在畫面上顯示 schema 預設值並標「未設定」
function currentValue(obj, key, spec) {
  const present = obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
  if (present) return { value: obj[key], unset: false };
  const fallback = spec.hasDefault ? clone(spec.default) : (spec.type === 'enum' ? spec.values[0] : spec.type === 'number' ? '' : spec.type === 'boolean' ? false : '');
  return { value: fallback, unset: true };
}

function renderNode(obj, key, spec, segs) {
  switch (spec.type) {
    case 'object': return renderObject(obj, key, spec, segs);
    case 'array': return renderArrayNode(obj, key, spec, segs);
    case 'enum': return renderEnum(obj, key, spec, segs);
    case 'boolean': return renderBool(obj, key, spec, segs);
    case 'number': return renderNumber(obj, key, spec, segs);
    default: return renderString(obj, key, spec, segs);
  }
}

// 把一個物件的欄位依分層畫進容器：
//  - 常用模式：只畫 minTier===1 的，其餘完全不出現
//  - 全部模式：第 1、2 層照畫，第 3 層（代碼/座標/色票）收進可展開的「進階設定」
function renderFields(box, obj, spec, segs) {
  const visible = spec.fields.filter((f) => showsTier(f.minTier));
  const plain = visible.filter((f) => f.minTier !== 3);
  const machine = visible.filter((f) => f.minTier === 3);

  for (const f of plain) box.append(renderNode(obj, f.key, f, [...segs, f.key]));

  if (machine.length) {
    const det = el('details', { class: 'machine' });
    det.append(el('summary', { text: `⚙ 進階設定（${machine.length}）· 代碼與座標，不確定就別動` }));
    for (const f of machine) det.append(renderNode(obj, f.key, f, [...segs, f.key]));
    box.append(det);
  }

  if (MODE === 'common') {
    const hidden = spec.fields.length - visible.length;
    if (hidden > 0) box.append(el('p', { class: 'note hiddenhint', text: `另有 ${hidden} 個設定欄位未顯示，需要時請切到「全部欄位」。` }));
  }
}

function renderObject(obj, key, spec, segs) {
  const present = obj && obj[key] != null;
  const box = el('fieldset', { class: 'grp', 'data-path': pathKey(segs) }, [el('legend', { text: spec.label })]);

  if (!present) {
    // A3：optional 區塊在 JSON 裡整段不存在時，過去表單完全看不到 → 現在給「啟用」入口
    box.classList.add('inactive');
    const btn = el('button', { type: 'button', class: 'enable', text: '＋ 啟用此區塊' });
    btn.addEventListener('click', () => { obj[key] = clone(spec.blank ?? {}); rerenderPane(); markChanged(); });
    box.append(el('div', { class: 'placeholder' }, [el('p', { class: 'note', text: spec.hint || '目前尚未設定此區塊，啟用後才會顯示在看板。' }), btn]));
    return box;
  }

  const inner = obj[key];
  renderFields(box, inner, spec, segs);

  if (spec.optional) {
    const off = el('button', { type: 'button', class: 'link danger', text: '停用此區塊' });
    off.addEventListener('click', async () => {
      if (!(await confirmModal({ title: `停用「${spec.label}」？`, body: '此區塊的內容會一併移除，看板將不再顯示。送出前都還可以按「捨棄修改」還原。', okText: '停用', danger: true }))) return;
      delete obj[key]; rerenderPane(); markChanged();
    });
    box.append(el('div', { class: 'grp-tools' }, [off]));
  }
  return box;
}

function renderEnum(obj, key, spec, segs) {
  const { value, unset } = currentValue(obj, key, spec);
  const sel = el('select');
  const values = spec.values.includes(value) || value === '' ? spec.values : [...spec.values, value];
  for (const v of values) {
    const known = spec.values.includes(v);
    sel.append(el('option', { value: v, text: (spec.valueLabels?.[v]) || (known ? v : `${v}（不在允許清單，送出會被擋）`), selected: v === value }));
  }
  if (!spec.values.includes(value)) sel.classList.add('warn-value');
  sel.addEventListener('change', () => { obj[key] = sel.value; sel.classList.remove('warn-value'); markChanged(); clearInvalid(segs); });
  return fieldRow(spec, segs, sel, { unset });
}

function renderBool(obj, key, spec, segs) {
  const { value, unset } = currentValue(obj, key, spec);
  const cb = el('input', { type: 'checkbox', checked: !!value, id: 'cb-' + pathKey(segs) });
  const sw = el('label', { class: 'switch', htmlFor: cb.id }, [cb, el('span', { class: 'track' }), el('span', { class: 'txt', text: value ? '是' : '否' })]);
  cb.addEventListener('change', () => { obj[key] = cb.checked; sw.querySelector('.txt').textContent = cb.checked ? '是' : '否'; markChanged(); });
  return fieldRow(spec, segs, sw, { unset });
}

function renderNumber(obj, key, spec, segs) {
  const { value, unset } = currentValue(obj, key, spec);
  const inp = el('input', { type: 'number', step: 'any', value: value === '' || value == null ? '' : String(value) });
  inp.addEventListener('change', () => {
    if (inp.value === '') { if (spec.optional) delete obj[key]; else obj[key] = 0; }
    else obj[key] = Number(inp.value);
    markChanged(); clearInvalid(segs);
  });
  return fieldRow(spec, segs, inp, { unset, extra: spec.optional ? el('div', { class: 'note', text: '留空＝不設定' }) : null });
}

function renderString(obj, key, spec, segs) {
  const { value, unset } = currentValue(obj, key, spec);
  const long = typeof value === 'string' && (value.length > 60 || value.includes('\n'));
  const inp = long ? el('textarea', { rows: 3, value: value ?? '' }) : el('input', { type: 'text', value: value ?? '' });
  let extra = null;
  if (spec.suggest?.length) {
    const id = 'dl-' + pathKey(segs).replace(/\W/g, '_');
    inp.setAttribute('list', id);
    extra = el('datalist', { id }, spec.suggest.map((s) => el('option', { value: s })));
  }
  inp.addEventListener('change', () => { obj[key] = inp.value; markChanged(); clearInvalid(segs); });
  return fieldRow(spec, segs, inp, { unset, extra, wide: long });
}

// ── 陣列 ──
function renderArrayNode(obj, key, spec, segs) {
  const it = spec.item;
  if (it.type === 'object') return renderObjectArray(obj, key, spec, segs);
  if (it.type === 'enum') return renderEnumArray(obj, key, spec, segs);
  return renderPrimitiveArray(obj, key, spec, segs);
}

// 陣列在 JSON 裡不存在時才建立，避免替院方憑空多寫欄位
function ensureArray(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

function renderEnumArray(obj, key, spec, segs) {
  const { value, unset } = currentValue(obj, key, spec);
  const cur = new Set(Array.isArray(value) ? value : []);
  const box = el('div', { class: 'checks' });
  for (const v of spec.item.values) {
    const cb = el('input', { type: 'checkbox', checked: cur.has(v) });
    cb.addEventListener('change', () => {
      const arr = ensureArray(obj, key);
      if (cb.checked) { if (!arr.includes(v)) arr.push(v); }
      else { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }
      markChanged();
    });
    box.append(el('label', { class: 'chk' }, [cb, el('span', { text: spec.item.valueLabels?.[v] || v })]));
  }
  return fieldRow(spec, segs, box, { unset, wide: true });
}

function renderPrimitiveArray(obj, key, spec, segs) {
  const isNum = spec.item.type === 'number';
  const { value, unset } = currentValue(obj, key, spec);
  const arr = Array.isArray(value) ? value : [];
  const ta = el('textarea', { class: 'series', rows: Math.min(8, Math.max(2, arr.length)), value: isNum ? arr.join(', ') : arr.join('\n') });
  const note = el('div', { class: 'note', text: isNum ? `數字，用逗號或空白分隔（目前 ${arr.length} 筆）` : `每行一項（目前 ${arr.length} 筆）` });
  ta.addEventListener('input', () => {
    const parts = (isNum ? ta.value.split(/[\s,]+/) : ta.value.split('\n')).map((s) => s.trim()).filter((s) => s !== '');
    if (isNum) {
      const bad = parts.filter((s) => !Number.isFinite(Number(s)));
      if (bad.length) { ta.classList.add('invalid'); note.textContent = `有 ${bad.length} 個不是數字：${bad.slice(0, 3).join('、')}（尚未套用）`; return; }
    }
    ta.classList.remove('invalid');
    note.textContent = isNum ? `數字，用逗號或空白分隔（目前 ${parts.length} 筆）` : `每行一項（目前 ${parts.length} 筆）`;
    const target = ensureArray(obj, key);
    target.length = 0;
    for (const s of parts) target.push(isNum ? Number(s) : s);
    markChanged();
  });
  return fieldRow(spec, segs, ta, { unset, wide: true });
}

function renderObjectArray(obj, key, spec, segs) {
  // 一律即時從資料取陣列：JSON 原本沒有這個鍵時，新增會建出新陣列，
  // 若在這裡先綁一份區域變數，之後畫面永遠畫的是那個被丟掉的空陣列。
  const A = () => (Array.isArray(obj[key]) ? obj[key] : []);
  const box = el('fieldset', { class: 'grp arr', 'data-path': pathKey(segs) });
  const legend = el('legend', { text: `${spec.label}（${A().length}）` });
  box.append(legend);

  const list = el('div', { class: 'arr-list' });
  const filterWrap = el('div', { class: 'arr-filter hidden' }, [el('input', { type: 'search', placeholder: `在 ${A().length} 筆中篩選…` })]);
  let filter = '';

  const refreshLegend = () => { legend.textContent = `${spec.label}（${A().length}）`; };

  const draw = () => {
    const arr = A();
    list.textContent = '';
    const many = arr.length > 4;
    filterWrap.classList.toggle('hidden', arr.length <= 8);
    let shown = 0;
    arr.forEach((item, i) => {
      const iSegs = [...segs, i];
      const title = itemTitle(item, i);
      if (filter && !JSON.stringify(item).toLowerCase().includes(filter)) return;
      shown++;
      const ck = pathKey(iSegs);
      if (!collapsed.has(ck)) collapsed.set(ck, many);
      const isCollapsed = collapsed.get(ck);

      const caret = el('button', { type: 'button', class: 'caret', text: isCollapsed ? '▸' : '▾' });
      const titleEl = el('span', { class: 'arr-title', text: title });
      // 常用模式不給增刪與排序：新項目的必填欄位（名稱等）在這個模式下看不到，
      // 讓人建出半套的項目只會更難用。
      const structural = MODE === 'all';
      const up = el('button', { type: 'button', class: 'icon', title: '上移', text: '↑', disabled: i === 0 });
      const down = el('button', { type: 'button', class: 'icon', title: '下移', text: '↓', disabled: i === arr.length - 1 });
      const del = el('button', { type: 'button', class: 'icon danger', title: '刪除', text: '刪除' });
      const head = el('div', { class: 'arr-head' }, [
        caret, titleEl,
        el('span', { class: 'arr-sub muted', text: itemSummary(item) }),
        el('span', { class: 'grow' }),
        structural ? up : null, structural ? down : null, structural ? del : null,
      ]);
      const body = el('div', { class: 'arr-body' + (isCollapsed ? ' hidden' : '') });
      if (!isCollapsed) renderFields(body, item, spec.item, iSegs);

      caret.addEventListener('click', () => { collapsed.set(ck, !collapsed.get(ck)); draw(); });
      titleEl.addEventListener('click', () => { collapsed.set(ck, !collapsed.get(ck)); draw(); });
      up.addEventListener('click', () => { arr.splice(i - 1, 0, arr.splice(i, 1)[0]); draw(); markChanged(); });
      down.addEventListener('click', () => { arr.splice(i + 1, 0, arr.splice(i, 1)[0]); draw(); markChanged(); });
      del.addEventListener('click', async () => {
        // A4：刪除要確認，而且刪錯可以復原（不必靠「捨棄修改」把其他修改一起丟掉）
        if (!(await confirmModal({ title: `刪除「${title}」？`, body: `這一整項會從「${spec.label}」移除。`, okText: '刪除', danger: true }))) return;
        const removed = arr.splice(i, 1)[0];
        refreshLegend(); draw(); markChanged();
        toastAction(`已刪除「${title}」`, '復原', () => { arr.splice(i, 0, removed); refreshLegend(); draw(); markChanged(); toastHide(); });
      });

      list.append(el('div', { class: 'arr-item' + (isCollapsed ? ' collapsed' : ''), 'data-path': ck }, [head, body]));
    });
    if (arr.length === 0) list.append(el('p', { class: 'note empty', text: '目前沒有任何項目。按下方「新增一項」建立第一筆。' }));
    else if (shown === 0) list.append(el('p', { class: 'note empty', text: '沒有符合篩選條件的項目。' }));
  };

  filterWrap.firstChild.addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); draw(); });

  const add = el('button', { type: 'button', class: 'add', text: `＋ 新增一項${spec.label ? `（${spec.label}）` : ''}` });
  add.addEventListener('click', () => {
    // A1/A2：新項目由 schema 的 itemBlank 產生（enum 會拿到合法值），不再複製第一筆或塞空字串
    const target = ensureArray(obj, key);
    target.push(clone(spec.itemBlank));
    collapsed.set(pathKey([...segs, target.length - 1]), false);
    refreshLegend(); draw(); markChanged();
    requestAnimationFrame(() => list.lastElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  });

  draw();
  box.append(filterWrap, list, el('div', { class: 'arr-tools' },
    MODE === 'all' ? [add] : [el('span', { class: 'note', text: '要新增或刪除項目，請切到右上角的「全部欄位」。' })]));
  return box;
}

// 卡片收合時顯示的一行摘要，讓 38 台設備不用逐一展開也認得出來
function itemSummary(item) {
  if (!isObj(item)) return '';
  const bits = [];
  for (const k of ['value', 'reading', 'status', 'loc', 'days', 'cap', 'pct', 'temp', 'v']) {
    if (item[k] !== undefined && item[k] !== '' && typeof item[k] !== 'object') bits.push(String(item[k]));
    if (bits.length >= 2) break;
  }
  return bits.join(' · ');
}

// ─────────────────────────────── 分區 / 導覽 ───────────────────────────────
function sectionChangeCounts() {
  const m = new Map();
  for (const c of changes()) {
    const id = sectionIdFor(c.segs);
    m.set(id, (m.get(id) || 0) + 1);
  }
  return m;
}

// 這個分區在常用模式下有沒有東西可看（整段都是代碼/座標的分區就不列出來）
function sectionHasCommon(s) {
  const baseSpec = s.base.length ? specAt(s.base) : SPEC;
  if (!baseSpec || baseSpec.type !== 'object') return true;
  const keys = s.keys || baseSpec.fields.map((f) => f.key);
  return keys.some((k) => baseSpec.fields.find((f) => f.key === k)?.minTier === 1);
}

function renderNav() {
  const counts = sectionChangeCounts();
  const stats = window.EMSAudit?.stats?.() || {};
  const list = $('navList');
  list.textContent = '';
  let lastGroup = null, lastTask = null;
  // 「常用欄位」的過濾只對看板維護有意義：健檢填報沒有色票與座標那種欄位
  const shown = SECTIONS.filter((s) => s.task !== 'board' || MODE === 'all' || sectionHasCommon(s) || counts.get(s.id));
  for (const s of shown) {
    if (s.task !== lastTask) {
      list.append(el('div', { class: 'navtask' + (s.task === 'board' ? ' demoted' : ''), text: TASKS[s.task] || '' }));
      lastTask = s.task; lastGroup = null;
    }
    if (s.group && s.group !== lastGroup) { list.append(el('div', { class: 'navgroup', text: s.group })); lastGroup = s.group; }
    const n = counts.get(s.id) || 0;
    const st = s.audit ? stats[s.audit] : null;
    const btn = el('button', { type: 'button', class: 'navitem' + (s.id === activeId ? ' active' : ''), 'data-sec': s.id }, [
      el('span', { text: s.label }),
      auditBadge(st),
      n ? el('i', { class: 'dot', title: `${n} 項未送出的修改` }) : null,
    ]);
    btn.addEventListener('click', () => goSection(s.id));
    list.append(btn);
  }
  if (MODE === 'all') {
    const addRes = el('button', { type: 'button', class: 'navadd', text: '＋ 新增資源區塊' });
    addRes.addEventListener('click', () => {
      const spec = specAt(['resources']);
      DATA.resources = DATA.resources || [];
      DATA.resources.push(clone(spec.itemBlank));
      SECTIONS = buildSections();
      goSection(`r${DATA.resources.length - 1}m`);
      markChanged();
    });
    list.append(addRes);
  }
}

// 健檢區塊的導覽徽章：待複驗最優先（那是擋住送出的東西），其次是必填缺漏、筆數
function auditBadge(st) {
  if (!st) return null;
  const p = (st.todo || 0) + (st.low || 0);
  if (p) return el('i', { class: 'navn todo', text: `待複驗 ${p}` });
  if (st.missing) return el('i', { class: 'navn todo', text: `缺 ${st.missing}` });
  if (st.rows) return el('i', { class: 'navn ok', text: `${st.rows} 筆` });
  return null;
}

// 頂列的「常用／全部欄位」與「看板對照圖」只在看板維護時有意義，其他任務淡出停用
function applyTaskChrome() {
  const board = currentTask() === 'board';
  $('editor').classList.toggle('task-board', board);
  for (const id of ['modeCommon', 'modeAll', 'mapBtn']) {
    const n = $(id);
    n.disabled = !board;
    n.title = board ? '' : '只有「看板維護」用得到';
  }
  const save = $('saveBtn');
  save.textContent = board ? '送出並上線' : '送出填報';
  save.title = board ? '送出後直接更新正式看板' : '送出填報，其中的彙總數字會自動同步到看板';
}

function rerenderPane() {
  const s = SECTIONS.find((x) => x.id === activeId) || SECTIONS[0];
  const root = $('formRoot');
  root.textContent = '';
  $('crumb').textContent = [TASKS[s.task], s.group, s.label].filter(Boolean).join(' › ');
  applyTaskChrome();

  // 電力健檢填報：欄位樹、表格、上傳與複驗全部由 audit.js 負責
  if (s.audit) { window.EMSAudit.renderSection(s.audit, root); return; }
  if (s.progress) { window.EMSAudit.renderProgress(root); return; }

  // 分區基底可能落在尚未存在的 optional 區塊上（例：整個 env 不存在）
  const parentSegs = s.base.slice(0, -1);
  const lastKey = s.base[s.base.length - 1];
  if (s.base.length && dataAt(s.base) == null) {
    const parent = s.base.length === 1 ? DATA : dataAt(parentSegs);
    const sp = specAt(s.base);
    if (parent && sp) { root.append(renderObject(parent, lastKey, sp, s.base)); return; }
  }

  const baseObj = s.base.length ? dataAt(s.base) : DATA;
  const baseSpec = s.base.length ? specAt(s.base) : SPEC;
  if (!baseObj || !baseSpec) { root.append(el('p', { class: 'note', text: '此分區無內容。' })); return; }

  const keys = s.keys || baseSpec.fields.map((f) => f.key);
  renderFields(root, baseObj, { ...baseSpec, fields: keys.map((k) => baseSpec.fields.find((f) => f.key === k)).filter(Boolean) }, s.base);

  if (s.resourceIndex !== undefined && MODE === 'all') {
    const del = el('button', { type: 'button', class: 'link danger', text: '刪除整個資源區塊' });
    del.addEventListener('click', async () => {
      const r = DATA.resources[s.resourceIndex];
      if (!(await confirmModal({ title: `刪除資源區塊「${r.name || r.id}」？`, body: '平時、戰時、設備清單都會一併移除。', okText: '刪除', danger: true }))) return;
      DATA.resources.splice(s.resourceIndex, 1);
      SECTIONS = buildSections();
      goSection('basic'); markChanged();
    });
    root.append(el('div', { class: 'grp-tools' }, [del]));
  }
}

function goSection(id, opts = {}) {
  activeId = id;
  renderNav();
  rerenderPane();
  closeNav();
  if (!opts.keepScroll) document.querySelector('.pane').scrollTo({ top: 0 });
}

// ─────────────────────────────── 搜尋 ───────────────────────────────
function buildIndex() {
  const out = [];
  const walk = (obj, spec, segs) => {
    if (!spec) return;
    if (spec.type === 'object') {
      if (!isObj(obj)) return;
      for (const f of spec.fields) walk(obj[f.key], f, [...segs, f.key]);
      return;
    }
    if (spec.type === 'array') {
      if (!Array.isArray(obj)) return;
      if (spec.item.type === 'object') { obj.forEach((v, i) => walk(v, spec.item, [...segs, i])); return; }
      out.push({ segs, label: spec.label, value: obj.join(', ') });
      return;
    }
    out.push({ segs, label: spec.label, value: obj });
  };
  walk(DATA, SPEC, []);
  return out;
}

let INDEX = [];
function runSearch(q) {
  const box = $('searchResults');
  const list = $('navList');
  q = q.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); list.classList.remove('hidden'); return; }
  list.classList.add('hidden'); box.classList.remove('hidden'); box.textContent = '';
  INDEX = buildIndex();   // 搜尋時才重建，才不會每敲一個字都掃整份資料

  const hits = INDEX.filter((e) => {
    const v = e.value == null ? '' : String(e.value).toLowerCase();
    return (e.label || '').toLowerCase().includes(q) || v.includes(q) || pathKey(e.segs).toLowerCase().includes(q);
  }).slice(0, 60);

  if (!hits.length) { box.append(el('p', { class: 'note', text: '找不到符合的欄位。' })); return; }
  box.append(el('p', { class: 'note', text: `${hits.length} 個結果` }));
  for (const h of hits) {
    const b = el('button', { type: 'button', class: 'hit' }, [
      el('span', { class: 'hit-label', text: h.label }),
      el('span', { class: 'hit-path', text: breadcrumb(h.segs.slice(0, -1)) }),
      el('span', { class: 'hit-val', text: short(h.value) }),
    ]);
    b.addEventListener('click', () => jumpTo(h.segs));
    box.append(b);
  }
}

function jumpTo(segs) {
  const sid = sectionIdFor(segs);
  // 目標欄位可能在收合的卡片裡，先把沿途的陣列項目全部展開
  for (let i = 1; i <= segs.length; i++) if (typeof segs[i - 1] === 'number') collapsed.set(pathKey(segs.slice(0, i)), false);
  goSection(sid);
  requestAnimationFrame(() => {
    let node = document.querySelector(`[data-path="${CSS.escape(pathKey(segs))}"]`);
    // 常用模式可能把目標欄位藏起來了（搜尋/錯誤/對照圖都可能指向設定類欄位）→ 自動切到全部欄位
    if (!node && MODE === 'common') {
      setMode('all');
      toast('已切換到「全部欄位」才能顯示這個欄位', 'ok');
      node = document.querySelector(`[data-path="${CSS.escape(pathKey(segs))}"]`);
    }
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  });
}

// ─────────────────────────────── 未送出提示 / 草稿 ───────────────────────────────
// 兩支任務各自有未送出的修改，送出按鈕也各送各的，所以徽章顯示「目前這支任務」的數量，
// 另一支若也有未送出的東西，用 title 提示，避免院方以為按一次就全部送出了。
function updateDirtyBadge() {
  const board = changes().length;
  const audit = window.EMSAudit?.dirtyCount?.() || 0;
  const here = currentTask() === 'board' ? board : audit;
  const other = currentTask() === 'board' ? audit : board;
  const b = $('dirtyBadge');
  b.classList.toggle('hidden', here === 0);
  b.querySelector('b').textContent = String(here);
  b.title = other ? `另有「${currentTask() === 'board' ? TASKS.audit : TASKS.board}」的 ${other} 項修改尚未送出（要切過去才能送）` : '';
  $('reloadBtn').textContent = (board + audit) ? '捨棄修改' : '重新載入';
}

const draftKey = () => `ems-admin-draft:${ME?.hid}`;
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (!changes().length) localStorage.removeItem(draftKey());
      else localStorage.setItem(draftKey(), JSON.stringify({ ts: Date.now(), base: ORIG, data: DATA }));
    } catch {}
  }, 800);
}
function dropDraft() { try { localStorage.removeItem(draftKey()); } catch {} }

// ─────────────────────────── 看板對照圖 ───────────────────────────
// 「我不知道哪個欄位對應看板上哪一塊」→ 直接給一張真實看板截圖，上面疊可點擊的熱區，
// 點下去跳到表單裡對應的區段。素材由 scripts/make-board-map.mjs 產生（全 15 家同一版面）。
let BOARDMAP = null;

async function openBoardMap() {
  if (!BOARDMAP) {
    try { BOARDMAP = await (await fetch('/board-map.json')).json(); }
    catch { toast('對照圖載入失敗', 'err'); return; }
  }
  let scenario = 'peace';

  const wrap = el('div', { class: 'bmwrap' });
  const tabs = el('div', { class: 'bmtabs' }, [
    el('span', { class: 'note', text: '點圖上任一區塊，直接跳到表單對應的欄位。要改哪個情境：' }),
  ]);
  const bPeace = el('button', { type: 'button', class: 'on', text: '平時' });
  const bWar = el('button', { type: 'button', text: '戰時/救災' });
  bPeace.addEventListener('click', () => { scenario = 'peace'; bPeace.classList.add('on'); bWar.classList.remove('on'); });
  bWar.addEventListener('click', () => { scenario = 'war'; bWar.classList.add('on'); bPeace.classList.remove('on'); });
  tabs.append(bPeace, bWar);

  const stage = el('div', { class: 'bmstage' });
  const img = el('img', { src: '/board-map.png', alt: '看板版面對照圖' });
  stage.append(img);

  for (const r of BOARDMAP.regions) {
    const hot = el('button', { type: 'button', class: 'bmhot', title: r.label });
    hot.style.left = `${(r.x / BOARDMAP.width) * 100}%`;
    hot.style.top = `${(r.y / BOARDMAP.height) * 100}%`;
    hot.style.width = `${(r.w / BOARDMAP.width) * 100}%`;
    hot.style.height = `${(r.h / BOARDMAP.height) * 100}%`;
    hot.append(el('span', { text: r.label.split('：').pop() }));
    hot.addEventListener('click', () => { closeModal(false); jumpToBoardPart(r, scenario); });
    stage.append(hot);
  }

  wrap.append(tabs, stage, el('p', {
    class: 'note',
    text: `對照圖取自 ${BOARDMAP.capturedFrom}（全院所同一套版面）。實際內容依貴院資料而定，位置一致。`,
  }));
  confirmModal({ title: '看板對照圖：哪個欄位長在哪裡', node: wrap, okText: '關閉', cancelText: '', wide: true });
}

function jumpToBoardPart(region, scenario) {
  if (region.part === 'env') { goSection(scenario === 'war' ? 'envw' : 'envp'); return; }
  const i = (DATA.resources || []).findIndex((r) => r.id === region.resourceId);
  if (i < 0) { toast(`貴院看板沒有「${region.label.split('：')[0]}」這個區塊`, 'warn'); return; }
  const inner = { head: 'perf', supply: 'supply', store: 'store', use: 'use' }[region.part];
  jumpTo(['resources', i, scenario, inner]);
}

// ─────────────────────── 常駐送出狀態（不是只有 toast） ───────────────────────
// 原本送出結果只存在飄浮的 toast 裡：關掉分頁、重新登入、或 toast 消失後，
// 院方就無從確認「我上次到底送出成功了沒」。這條狀態列每次載入都會重新查。
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

async function refreshStatusBar(pending) {
  const bar = $('statusBar');
  const { body } = await api('/api/history');
  const items = body?.items || [];
  bar.textContent = '';
  if (!items.length) {
    bar.className = 'statusbar';
    bar.append(el('span', { text: '這個看板還沒有透過本系統送出過修改。' }));
    return;
  }
  const last = items[0];
  bar.className = 'statusbar';
  const line = el('div', { class: 'sb-line' }, [
    el('b', { text: '上次送出：' }),
    el('span', { text: `${fmtTime(last.at)}（${last.shortSha}）` }),
  ]);

  const boardUrl = `https://crinhealthcare.org/${ME?.hid}/`;
  const link = () => el('a', { href: boardUrl, target: '_blank', rel: 'noopener', text: '開啟看板 ↗' });

  if (pending) {
    bar.classList.add('busy');
    line.append(el('span', { class: 'sb-state', text: '· 部署中…' }));
  } else {
    const { body: st } = await api('/api/deploy?commit=' + encodeURIComponent(last.sha));
    const phase = st?.phase;
    // 十幾分鐘前的送出還顯示「部署進行中」會讓人以為卡住了。部署本身只要 1–2 分鐘，
    // 超過 20 分鐘還查不到結論，就是查不到，不要硬報一個進行中。
    const stale = Date.now() - last.at > 20 * 60 * 1000;
    if (phase === 'done') {
      bar.classList.add('ok');
      line.append(el('span', { class: 'sb-state', text: '· ✅ 已上線' }), link());
    } else if (phase === 'failed') {
      bar.classList.add('err');
      line.append(el('span', { class: 'sb-state', text: '· ⚠️ 部署失敗，看板未更新，請聯絡維護人員' }));
    } else if (!stale && (phase === 'pending' || phase === 'deploying' || phase === 'propagating')) {
      bar.classList.add('busy');
      line.append(el('span', { class: 'sb-state', text: '· 部署進行中' }), link());
    } else {
      line.append(el('span', { class: 'sb-state', text: '· 資料已送出' }),
        el('span', { class: 'muted', text: '（查不到這次的部署紀錄，請直接看看板確認）' }), link());
    }
  }

  const more = el('button', { type: 'button', class: 'link', text: `更早的紀錄（${items.length - 1}）` });
  more.addEventListener('click', () => confirmModal({
    title: '送出紀錄',
    okText: '關閉', cancelText: '',
    node: el('div', { class: 'histlist' }, items.map((it) => el('div', { class: 'histrow' }, [
      el('span', { class: 'hist-t', text: fmtTime(it.at) }),
      el('span', { class: 'hist-s', text: it.shortSha }),
      el('span', { class: 'hist-m', text: it.subject }),
    ]))),
  }));
  if (items.length > 1) line.append(more);
  bar.append(line);
  bar.classList.remove('hidden');
}

// ─────────────────────────────── toast / modal ───────────────────────────────
function toast(msg, kind) { const t = $('toast'); t.className = 'toast show ' + (kind || ''); t.textContent = msg; }
function toastHide() { $('toast').className = 'toast'; }
function toastLink(msg, url) {
  const t = $('toast'); t.className = 'toast show ok'; t.textContent = msg + ' ';
  t.append(el('a', { href: url, target: '_blank', rel: 'noopener', text: '開啟看板 ↗' }));
}
function toastAction(msg, actionText, fn) {
  const t = $('toast'); t.className = 'toast show'; t.textContent = msg + ' ';
  const b = el('button', { type: 'button', class: 'toast-act', text: actionText });
  b.addEventListener('click', fn);
  t.append(b);
  setTimeout(() => { if (t.contains(b)) toastHide(); }, 8000);
}

let modalResolve = null;
function confirmModal({ title, body, okText = '確定', cancelText = '取消', danger = false, node = null, wide = false }) {
  $('modalTitle').textContent = title;
  const mb = $('modalBody'); mb.textContent = '';
  if (node) mb.append(node); else mb.append(el('p', { text: body || '' }));
  const ok = $('modalOk');
  ok.textContent = okText;
  ok.className = danger ? 'danger-btn' : 'primary';
  const cancel = $('modalCancel');
  cancel.textContent = cancelText;
  cancel.classList.toggle('hidden', !cancelText);   // 純告知的對話框不需要「取消」
  $('modal').querySelector('.modal-box').classList.toggle('wide', wide);
  $('modal').classList.remove('hidden');
  ok.focus();
  return new Promise((r) => { modalResolve = r; });
}
function closeModal(v) { $('modal').classList.add('hidden'); modalResolve?.(v); modalResolve = null; }
$('modalOk').addEventListener('click', () => closeModal(true));
$('modalCancel').addEventListener('click', () => closeModal(false));
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(false); });

// ─────────────────────────────── 驗證錯誤定位 ───────────────────────────────
function clearInvalid(segs) {
  const n = document.querySelector(`[data-path="${CSS.escape(pathKey(segs))}"]`);
  n?.classList.remove('invalid-field');
}
function showValidationErrors(details) {
  document.querySelectorAll('.invalid-field').forEach((n) => n.classList.remove('invalid-field'));
  const parsed = (details || []).map((d) => {
    const i = d.indexOf(':');
    const raw = i > 0 ? d.slice(0, i) : d;
    const msg = i > 0 ? d.slice(i + 1).trim() : d;
    const segs = raw.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    return { segs, msg, raw };
  });

  const body = el('div');
  body.append(el('p', { text: `有 ${parsed.length} 個欄位不符合格式，資料尚未送出。點擊項目可直接跳到該欄位：` }));
  for (const p of parsed) {
    const b = el('button', { type: 'button', class: 'errhit' }, [
      el('span', { class: 'hit-label', text: breadcrumb(p.segs) || p.raw }),
      el('span', { class: 'hit-val', text: p.msg }),
    ]);
    b.addEventListener('click', () => { closeModal(false); jumpTo(p.segs); document.querySelector(`[data-path="${CSS.escape(pathKey(p.segs))}"]`)?.classList.add('invalid-field'); });
    body.append(b);
  }
  confirmModal({ title: '格式檢查未通過', node: body, okText: '知道了', cancelText: '關閉' });
}

// ─────────────────────────────── 載入 / 送出 ───────────────────────────────
function showLogin(msg) {
  $('boot').classList.add('hidden'); $('editor').classList.add('hidden'); $('login').classList.remove('hidden');
  if (msg) $('loginErr').textContent = msg;
}
function showEditor(me) {
  ME = me;
  $('boot').classList.add('hidden'); $('login').classList.add('hidden'); $('editor').classList.remove('hidden');
  $('hName').textContent = me.name || ''; $('hId').textContent = `（${me.hid}）`;
  $('modeCommon').classList.toggle('on', MODE === 'common');
  $('modeAll').classList.toggle('on', MODE === 'all');
}

async function loadSpec() {
  if (SPEC) return true;
  const { status, body } = await api('/api/schema');
  if (status === 401) { showLogin('登入逾時，請重新登入'); return false; }
  if (!body?.ok) { toast('表單規格載入失敗，請重新整理', 'err'); return false; }
  SPEC = body.spec;
  return true;
}

// 健檢填報：規格＋資料。載入失敗不擋住看板維護（那是兩套獨立的東西），
// 只是導覽上不會出現健檢那兩支任務。
async function loadAudit() {
  try {
    const ok = await window.EMSAudit.load();
    if (!ok) { toast('健檢填報載入失敗，看板維護仍可使用', 'warn'); return false; }
    window.EMSAudit.onChange(() => { markChanged(); rerenderPane(); });
    window.EMSAudit.renderStages($('stagesBar'));
    return true;
  } catch { return false; }
}

async function loadHospital(opts = {}) {
  if (!(await loadSpec())) return false;
  await loadAudit();
  const { status, body } = await api('/api/hospital');
  if (status === 401) { showLogin('登入逾時，請重新登入'); return false; }
  if (!body?.ok) { toast('載入失敗：' + (body?.error || status), 'err'); return false; }

  DATA = body.data;
  ORIG = clone(body.data);
  collapsed.clear();
  if (!opts.skipDraft) await maybeRestoreDraft();   // 草稿會換掉 DATA，所以要先於分區計算

  SECTIONS = buildSections();
  if (!SECTIONS.some((s) => s.id === activeId)) activeId = SECTIONS[0]?.id || 'basic';

  // 搜尋索引改在使用搜尋時才建（見 runSearch）
  renderNav(); rerenderPane(); updateDirtyBadge();
  refreshStatusBar();   // 不 await：查 GitHub Actions 會慢，不該卡住表單顯示
  if (opts.notify) toast('已載入最新內容 ✓', 'ok');
  return true;
}

// session 逾時（8 小時）或不小心關掉分頁時，修改不該蒸發
async function maybeRestoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
  if (!d?.data) return;
  if (JSON.stringify(d.data) === JSON.stringify(DATA)) { dropDraft(); return; }
  const n = diffTree(ORIG, d.data, [], []).length;
  const when = new Date(d.ts).toLocaleString('zh-TW', { hour12: false });
  const ok = await confirmModal({
    title: '發現未送出的草稿',
    body: `這台電腦在 ${when} 留有 ${n} 項尚未送出的修改。要接續編輯嗎？（選「捨棄草稿」會改用線上目前的內容）`,
    okText: '接續編輯', cancelText: '捨棄草稿',
  });
  if (ok) { DATA = d.data; } else { dropDraft(); }
}

function changeListNode(list) {
  const box = el('div', { class: 'difflist' });
  box.append(el('p', { text: `這次要送出 ${list.length} 項修改，送出後會直接更新正式看板：` }));
  for (const c of list.slice(0, 200)) {
    // 新增/刪除整項時，路徑用「父層 › 該項標題」，索引本身對院方沒有意義
    const isItem = c.kind !== 'change';
    const where = isItem ? `${breadcrumb(c.segs.slice(0, -1))} › ${itemTitle(c.to ?? c.from, c.segs[c.segs.length - 1])}` : breadcrumb(c.segs);
    box.append(el('div', { class: 'diffrow' }, [
      el('div', { class: 'diffpath' }, [
        c.kind === 'add' ? el('span', { class: 'kind add', text: '新增' }) : c.kind === 'remove' ? el('span', { class: 'kind rm', text: '刪除' }) : null,
        el('span', { text: where }),
      ]),
      c.kind === 'change'
        ? el('div', { class: 'diffval' }, [el('s', { text: short(c.from) }), el('span', { class: 'arrow', text: '→' }), el('b', { text: short(c.to) })])
        : el('div', { class: 'diffval' }, [el('b', { text: short(c.to ?? c.from) })]),
    ]));
  }
  if (list.length > 200) box.append(el('p', { class: 'note', text: `…另有 ${list.length - 200} 項未列出` }));
  return box;
}

function endSave() { busy = false; $('saveBtn').disabled = false; $('reloadBtn').disabled = false; }

async function save() {
  if (busy) return;
  // 送出的是「目前這支任務」：健檢填報走 /api/audit（存主機、自動同步看板彙總），
  // 看板維護走 /api/hospital（直接 push 公開 repo）。兩者門檻不同，不可合併。
  if (currentTask() !== 'board') return window.EMSAudit.submit();
  const list = changes();
  if (!list.length) { toast('目前沒有任何修改，不需要送出', 'ok'); return; }
  if (!(await confirmModal({ title: '確認送出', node: changeListNode(list), okText: '送出並上線' }))) return;

  busy = true; $('saveBtn').disabled = true; $('reloadBtn').disabled = true;
  toast('送出中…', 'busy');
  let res;
  try {
    res = await api('/api/hospital', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' }, body: JSON.stringify({ data: DATA }) });
  } catch { toast('送出失敗（網路問題），請再試一次', 'err'); return endSave(); }

  const { status, body } = res;
  if (status === 401) { endSave(); return showLogin('登入逾時，請重新登入'); }
  if (status === 422) { toastHide(); endSave(); return showValidationErrors(body?.details); }
  if (!body?.ok) { toast('送出失敗：' + (body?.message || body?.error || status), 'err'); return endSave(); }
  if (body.unchanged) { toast('內容與線上相同，未變更', 'ok'); ORIG = clone(DATA); dropDraft(); renderNav(); updateDirtyBadge(); return endSave(); }

  ORIG = clone(DATA); dropDraft(); renderNav(); updateDirtyBadge();
  refreshStatusBar(true);
  await waitDeploy(body.commit, body.sha);
  refreshStatusBar();
  endSave();
}

async function waitDeploy(commit, sha) {
  const t0 = Date.now(), MAX = 6 * 60 * 1000;
  toast(`已送出（${commit}）。部署中… 請勿關閉視窗`, 'busy');
  while (Date.now() - t0 < MAX) {
    await sleep(9000);
    let st; try { const r = await api('/api/deploy?commit=' + encodeURIComponent(sha)); st = r.body; } catch { continue; }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (st?.phase === 'failed') { toast(`⚠️ 部署失敗（${commit}）：資料已存，但看板未更新，請聯絡維護人員`, 'err'); return; }
    if (st?.phase === 'done') { toastLink('✅ 已完成！看板已更新上線。', st.url); return; }
    const lb = st?.phase === 'propagating' ? '部署完成，等待生效' : st?.phase === 'pending' ? '排入部署佇列' : '部署中';
    toast(`${lb}… 已 ${secs} 秒（約需 1–2 分鐘），請勿關閉視窗`, 'busy');
  }
  toast('部署較久尚未確認，資料已送出，請 1–2 分鐘後直接查看看板頁。', 'warn');
}

// ─────────────────────────────── 導覽抽屜（窄螢幕） ───────────────────────────────
function openNav() { $('nav').classList.add('open'); $('navScrim').classList.remove('hidden'); }
function closeNav() { $('nav').classList.remove('open'); $('navScrim').classList.add('hidden'); }
$('navToggle').addEventListener('click', () => ($('nav').classList.contains('open') ? closeNav() : openNav()));
$('navScrim').addEventListener('click', closeNav);

// ─────────────────────────────── 綁定 ───────────────────────────────
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const f = e.target;
  const { status, body } = await api('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' },
    body: JSON.stringify({ username: f.username.value, password: f.password.value }),
  });
  if (status === 200 && body?.ok) { showEditor(body); await loadHospital(); }
  else if (status === 401 && body?.error === 'locked') $('loginErr').textContent = '嘗試次數過多，請稍後再試';
  else $('loginErr').textContent = '帳號或密碼錯誤';
});

$('reloadBtn').addEventListener('click', async () => {
  if (busy) return;
  const n = changes().length + (window.EMSAudit?.dirtyCount?.() || 0);
  if (n && !(await confirmModal({ title: `捨棄 ${n} 項未送出的修改？`, body: '畫面會重新載入線上目前的內容，這些修改將無法復原。', okText: '捨棄並重新載入', danger: true }))) return;
  dropDraft(); toastHide();
  window.EMSAudit?.discard?.();
  await loadHospital({ notify: true, skipDraft: true });
});

$('saveBtn').addEventListener('click', save);

$('logoutBtn').addEventListener('click', async () => {
  if (busy) return;
  const n = changes().length + (window.EMSAudit?.dirtyCount?.() || 0);
  if (n && !(await confirmModal({ title: `還有 ${n} 項修改未送出`, body: '登出後這些修改會留在本機草稿，下次登入可接續，但不會出現在看板上。', okText: '仍要登出', danger: true }))) return;
  await api('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'ems-admin' } });
  location.reload();
});

function setMode(m) {
  if (MODE === m) return;
  MODE = m;
  try { localStorage.setItem('ems-admin-mode', m); } catch {}
  $('modeCommon').classList.toggle('on', m === 'common');
  $('modeAll').classList.toggle('on', m === 'all');
  // 切模式後目前分區可能被隱藏了，退回第一個看得到的
  renderNav();
  if (!document.querySelector(`[data-sec="${CSS.escape(activeId)}"]`)) {
    const first = document.querySelector('.navitem');
    if (first) { activeId = first.dataset.sec; renderNav(); }
  }
  rerenderPane();
}
$('modeCommon').addEventListener('click', () => setMode('common'));
$('modeAll').addEventListener('click', () => setMode('all'));
$('mapBtn').addEventListener('click', openBoardMap);

$('searchBox').addEventListener('input', (e) => runSearch(e.target.value));
$('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; runSearch(''); } });

window.addEventListener('beforeunload', (e) => {
  if (!busy && !changes().length && !(window.EMSAudit?.dirtyCount?.() || 0)) return;
  e.preventDefault(); e.returnValue = '';
});

async function boot() {
  const { status, body } = await api('/api/me');
  if (status === 200 && body?.ok) { showEditor(body); await loadHospital(); }
  else showLogin();
}
boot();
