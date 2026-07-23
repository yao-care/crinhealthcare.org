'use strict';
// EMS 維護表單前端：登入 → 載入自家 hospital JSON → 遞迴長出結構化表單 → 送出 POST。
// 直接綁定到載入的 data 物件（輸入即改記憶體中的物件），送出時整包回傳。

// ── 欄位中文標籤 ──
const LABELS = {
  name: '名稱', value: '數值/狀態', sub: '副標', color: '色票', kind: '型別',
  pctOfTotal: '佔總量', lastYear: '去年同期', current: '現況電表', unit: '單位',
  daily: '每日序列', lastYearDaily: '去年每日序列', critical: '維生(關鍵)', items: '設備清單',
  img: '圖片路徑', imgs: '輪播圖', caption: '圖說', perf: '效能摘要', text: '摘要文字',
  act: '即時序列', fc: '預測序列', base: '基準線', warn: '警戒/異常',
  endur: '續航', days: '可撐天數', pct: '百分比', live: '即時標記(ess)',
  supply: '供給端', online: '供電中', esg: 'ESG 類別', react: '反應時間', autonomous: '自主',
  supplySum: '供給合計', detailLabel: '明細標題', detail: '明細',
  store: '儲存端', cap: '容量', state: '狀態', metrics: '儀表格點', flags: '狀態標籤',
  k: '標籤', v: '數值', label: '標籤', tone: '色調',
  use: '使用端', headline: '標題', blocks: '分項卡', map: '配置圖', legend: '圖例', boxes: '方塊', star: '固定電源★',
  resources: '資源區塊', id: '代碼', icon: '圖示', peace: '平時', war: '戰時',
  devices: '設備清單', loc: '位置', system: '系統', status: '狀態', reading: '即時值', refDaily: '參考序列',
  manager: '管理人', contact: '聯絡', vendor: '維護廠商',
  env: '環境參數', buildings: '大樓', floors: '樓層', floor: '樓層', temp: '溫度', rh: '濕度', co2: 'CO₂',
  thresholds: '異常門檻', min: '下限', max: '上限', criticalFloors: '關鍵樓層',
  carbon: '碳盤查', title: '標題', cols: '欄位', rows: '列', cells: '儲存格',
  report: '匯出報表', benchmark: '標竿獎', item: '項目',
  esgPanels: 'ESG 面板', compare: '比較', delta: '變化', good: '良好', pending: '待補',
  scenarios: '情境', hideMeta: '隱藏版本/更新', show: '顯示區塊', peakShave: '削峰填谷',
  peakShaveHide: '隱藏 chip', liveData: '即時資料', layout: '版面', location: '地點',
  updated: '更新日(西元)', version: '版本',
};
const label = (k) => LABELS[k] || k;

// ── DOM helpers ──
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n[k] = v; });
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c && n.append(c));
  return n;
};
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'X-Requested-With': 'ems-admin' }, ...opts });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// ── 遞迴渲染 ──
// itemLabel：陣列項目盡量用該項的 name/label/floor/k 當標題
function itemTitle(v, i) {
  if (v && typeof v === 'object') return v.name || v.label || v.floor || v.title || v.item || v.k || `#${i + 1}`;
  return `#${i + 1}`;
}

function primitiveInput(obj, key) {
  const val = obj[key];
  if (typeof val === 'boolean') {
    const cb = el('input', { type: 'checkbox', checked: val });
    cb.addEventListener('change', () => { obj[key] = cb.checked; });
    return { node: cb, boolField: true };
  }
  if (typeof val === 'number') {
    const inp = el('input', { type: 'number', value: String(val), step: 'any' });
    inp.addEventListener('change', () => { obj[key] = inp.value === '' ? val : Number(inp.value); });
    return { node: inp };
  }
  // 字串：長字串用 textarea
  const long = typeof val === 'string' && (val.length > 40 || val.includes('\n'));
  const inp = long ? el('textarea', { value: val }) : el('input', { type: 'text', value: val ?? '' });
  inp.addEventListener('change', () => { obj[key] = inp.value; });
  return { node: inp };
}

// 原始型別陣列（數字/字串）→ 用多行/逗號文字框
function primitiveArrayField(arr) {
  const isNum = arr.some((x) => typeof x === 'number');
  const ta = el('textarea', { value: isNum ? arr.join(', ') : arr.join('\n') });
  ta.addEventListener('change', () => {
    const parts = isNum ? ta.value.split(/[\s,]+/) : ta.value.split('\n');
    const next = parts.map((s) => s.trim()).filter((s) => s !== '');
    arr.length = 0;
    next.forEach((s) => arr.push(isNum ? Number(s) : s));
  });
  const note = el('div', { class: 'note', text: isNum ? '數字，用逗號分隔' : '每行一項' });
  return el('div', { class: 'primitive-list' }, [ta, note]);
}

function blankLike(sample) {
  // 依樣本結構造一個空白項（字串→''、數字→0、布林→false、陣列→[]、物件→遞迴）
  if (Array.isArray(sample)) return [];
  if (sample && typeof sample === 'object') { const o = {}; for (const k in sample) o[k] = blankLike(sample[k]); return o; }
  if (typeof sample === 'number') return 0;
  if (typeof sample === 'boolean') return false;
  return '';
}

function renderArray(obj, key, depth) {
  const arr = obj[key];
  const wrap = el('fieldset', { class: `depth-${Math.min(depth, 2)}` }, [el('legend', { text: `${label(key)}（${arr.length}）` })]);

  const objectItems = arr.length > 0 && arr[0] && typeof arr[0] === 'object' && !Array.isArray(arr[0]);
  if (!objectItems) {
    if (arr.length === 0) { wrap.append(el('div', { class: 'note', text: '（目前為空；如需新增請告知維護窗口）' })); return wrap; }
    wrap.append(primitiveArrayField(arr));
    return wrap;
  }

  const listBox = el('div');
  const drawItems = () => {
    listBox.textContent = '';
    arr.forEach((item, i) => {
      const head = el('div', { class: 'arr-head' }, [
        el('span', { class: 'tag', text: itemTitle(item, i) }),
        el('button', { class: 'del', type: 'button', text: '刪除' }),
      ]);
      head.querySelector('.del').addEventListener('click', () => { arr.splice(i, 1); wrap.querySelector('legend').textContent = `${label(key)}（${arr.length}）`; drawItems(); });
      const body = renderObjectFields(item, depth + 1);
      listBox.append(el('div', { class: 'arr-item' }, [head, body]));
    });
  };
  drawItems();
  wrap.append(listBox);

  const addBtn = el('button', { type: 'button', text: '＋ 新增一項' });
  addBtn.addEventListener('click', () => { arr.push(blankLike(arr[0])); wrap.querySelector('legend').textContent = `${label(key)}（${arr.length}）`; drawItems(); });
  wrap.append(el('div', { class: 'arr-tools' }, [addBtn]));
  return wrap;
}

// 渲染一個物件的所有欄位（不含外框 fieldset），供陣列項目重用
function renderObjectFields(obj, depth) {
  const frag = document.createDocumentFragment();
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) { frag.append(renderArray(obj, key, depth)); continue; }
    if (val && typeof val === 'object') {
      const fs = el('fieldset', { class: `depth-${Math.min(depth, 2)}` }, [el('legend', { text: label(key) })]);
      fs.append(renderObjectFields(val, depth + 1));
      frag.append(fs);
      continue;
    }
    const { node, boolField } = primitiveInput(obj, key);
    frag.append(el('div', { class: `field${boolField ? ' bool' : ''}` }, [el('label', { text: label(key) }), node]));
  }
  return frag;
}

function renderForm(data) {
  const root = $('formRoot');
  root.textContent = '';
  root.append(renderObjectFields(data, 0));
}

// ── 固定 toast（送出/部署狀態，不管捲到哪都看得到）──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toast(msg, kind) { const t = $('toast'); t.className = 'toast show ' + (kind || ''); t.textContent = msg; }
function toastLink(msg, url) {
  const t = $('toast'); t.className = 'toast show ok'; t.textContent = msg + ' ';
  t.append(el('a', { href: url, target: '_blank', rel: 'noopener', text: '開啟看板 ↗' }));
}
function toastHide() { $('toast').className = 'toast'; }

// ── 流程 ──
let DATA = null;
let busy = false;   // 送出+部署進行中：鎖住按鈕、忽略重複點擊

function showLogin(msg) { $('boot').classList.add('hidden'); $('editor').classList.add('hidden'); $('login').classList.remove('hidden'); if (msg) $('loginErr').textContent = msg; }
function showEditor(me) {
  $('boot').classList.add('hidden'); $('login').classList.add('hidden'); $('editor').classList.remove('hidden');
  $('hName').textContent = me.name || ''; $('hId').textContent = `（${me.hid}）`;
}

async function loadHospital(opts = {}) {
  const { status, body } = await api('/api/hospital');
  if (status === 401) return showLogin('登入逾時，請重新登入');
  if (!body?.ok) { toast('載入失敗：' + (body?.error || status), 'err'); return false; }
  DATA = body.data; renderForm(DATA);
  if (opts.notify) toast('已載入最新內容 ✓', 'ok');
  return true;
}

function endSave() { busy = false; $('saveBtn').disabled = false; $('reloadBtn').disabled = false; }

async function save() {
  if (busy) return;                       // 部署進行中，忽略重複點擊
  busy = true; $('saveBtn').disabled = true; $('reloadBtn').disabled = true;
  toast('送出中…', 'busy');
  let res;
  try {
    res = await api('/api/hospital', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' }, body: JSON.stringify({ data: DATA }) });
  } catch { toast('送出失敗（網路問題），請再試一次', 'err'); return endSave(); }
  const { status, body } = res;
  if (status === 401) { endSave(); return showLogin('登入逾時，請重新登入'); }
  if (status === 422) { toast('驗證未過，未送出：\n' + (body.details || []).join('\n'), 'err'); return endSave(); }
  if (!body?.ok) { toast('送出失敗：' + (body?.message || body?.error || status), 'err'); return endSave(); }
  if (body.unchanged) { toast('內容與線上相同，未變更', 'ok'); return endSave(); }
  await waitDeploy(body.commit, body.sha);
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
    const label = st?.phase === 'propagating' ? '部署完成，等待生效' : st?.phase === 'pending' ? '排入部署佇列' : '部署中';
    toast(`${label}… 已 ${secs} 秒（約需 1–2 分鐘），請勿關閉視窗`, 'busy');
  }
  toast('部署較久尚未確認，資料已送出，請 1–2 分鐘後直接查看看板頁。', 'warn');
}

async function boot() {
  const { status, body } = await api('/api/me');
  if (status === 200 && body?.ok) { showEditor(body); await loadHospital(); }
  else showLogin();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  const f = e.target;
  const { status, body } = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
  if (status === 200 && body?.ok) { showEditor(body); await loadHospital(); }
  else if (status === 401 && body?.error === 'locked') $('loginErr').textContent = '嘗試次數過多，請稍後再試';
  else $('loginErr').textContent = '帳號或密碼錯誤';
});
$('reloadBtn').addEventListener('click', () => { if (!busy) { toastHide(); loadHospital({ notify: true }); } });
$('saveBtn').addEventListener('click', save);
$('logoutBtn').addEventListener('click', async () => { if (busy) return; await api('/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'ems-admin' } }); location.reload(); });

boot();
