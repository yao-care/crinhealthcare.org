'use strict';
// 能源盤點管理端：點位與進度（定期更新）／初始建檔／異動登錄。
//
// 與看板維護（app.js）、舊版健檢填報（audit.js）分開：資料走 /api/inv（主機本地），
// 每個區塊各自存檔，不經過頂列那顆「送出」。共用的只有 window.EMSUI 的外觀與對話框。
//
// 規則：
// 1. 表單一律由 GET /api/inv/spec 長出來（site 區塊、設備類別、項目類型）。新增欄位只改 inventory-schema.js。
// 2. 依據（source）從 spec 與 inventory-compute.js 讀，畫面不另寫一份（工作清單第 21 項）。
// 3. 已有資料的區塊預設唯讀；按「修改」才可編輯，而且要填原因（後端會寫一筆異動）。
// 4. 點位代碼與類別不能改：網址已經印在貼紙上。改名、搬家只改名稱與位置。
// 5. 帳號一院一組：頂部「操作人」姓名存在這台電腦（與貼紙頁同一個 localStorage key），
//    每次寫入自動帶 reporter，異動與修改紀錄才看得到是誰改的。

(function () {
  const UI = window.EMSUI;
  const { el, api, toast, confirmModal } = UI;
  const C = window.EMSInventoryCompute || null;

  const TASKS = {
    'inv-points': '📍 點位與進度',
    'inv-site': '🏗 初始建檔',
    'inv-changes': '🗂 異動登錄',
    'inv-report': '📑 申報與報告',
  };

  // ── 狀態 ──
  let SPEC = null, INV = null, BASE = '', PERIOD = '', HID = '', HNAME = '';
  let LINKS = [], REFS = [];   // GET /api/inv 的 linkIssues（設備↔點位不一致）、siteRefIssues（建築對不上）；舊後端沒有就是空的
  let PROGRESS = null, CHANGES = null, KINDS = {};
  let notify = () => {};
  let CURSEC = null, ROOT = null, drawToken = 0;
  // 各畫面的編輯中狀態（切走再切回來還在；存檔或取消才清掉）
  const ui = { sel: null, prog: null, point: null, site: {}, eq: null, eqAll: false, chKind: '', ch: null, closing: null, closeNote: '' };

  // ── 小工具 ──
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const todayIso = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const rocYear = () => Number(todayIso().slice(0, 4)) - 1911;
  const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('zh-TW', { maximumFractionDigits: 3 }) : String(n ?? ''));
  const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const periodLabel = (p) => { const [y, m] = String(p || '').split('-'); return y && m ? `${Number(y) - 1911} 年 ${Number(m)} 月` : ''; };
  const enc = encodeURIComponent;
  const urlOf = (code) => `${BASE}/s/${enc(code)}`;
  const catOf = (id) => SPEC.equipment.categories.find((c) => c.id === id) || null;
  const blockOf = (id) => SPEC.site.find((b) => b.id === id) || null;
  const itemType = (id) => SPEC.itemTypes.find((t) => t.id === id) || null;
  const eqById = (id) => INV.equipment.find((e) => e.id === id) || null;
  const eqName = (e) => e?.fields?.name || e?.kind || e?.id || '';
  const bName = (id) => (INV.site.buildings || []).find((b) => b.id === id)?.name || (id ? `（${id}）` : '');
  const statusLabel = (s) => SPEC.equipment.status[s] || s || '';

  const btn = (text, onClick, cls = '') => {
    const b = el('button', { type: 'button', class: cls, text });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  const pill = (text, kind = '') => el('span', { class: `i-pill ${kind}`, text });
  const note = (text, cls = '') => el('p', { class: `note ${cls}`, text });
  // append 但略過 null／false（Node.append(null) 會印出字串 "null"）
  const put = (n, ...kids) => { for (const c of kids) if (c) n.append(c); return n; };
  const errBox = () => el('div', { class: 'i-err', role: 'alert' });

  // ── 操作人姓名：與貼紙頁（sticker.js）共用同一個 key；localStorage 被擋就只記在這次頁面 ──
  const REPORTER_KEY = 'ems.sticker.reporter';
  const REPORTER_MAX = 20;
  let REPORTER = '';
  try { REPORTER = localStorage.getItem(REPORTER_KEY) || ''; } catch { /* 無痕或被擋：每次重填 */ }
  function setReporter(v) {
    REPORTER = String(v || '').slice(0, REPORTER_MAX);
    try { if (REPORTER.trim()) localStorage.setItem(REPORTER_KEY, REPORTER.trim()); else localStorage.removeItem(REPORTER_KEY); } catch { /* 存不了就算了 */ }
  }
  const reporter = () => REPORTER.trim();
  function operatorBar() {
    const inp = el('input', { type: 'text', value: REPORTER, maxLength: REPORTER_MAX, placeholder: '例：王小明', autocomplete: 'name' });
    inp.addEventListener('input', () => setReporter(inp.value));
    return el('div', { class: 'i-tools i-operator' }, [
      el('label', { class: 'i-inline' }, [el('span', { text: '操作人' }), inp]),
      el('span', { class: 'note', text: `帳號是全院共用，填上姓名，異動與修改紀錄會記成「姓名（院名）」。只記在這台電腦，貼紙頁也會帶入（最多 ${REPORTER_MAX} 字）。` }),
    ]);
  }

  async function send(method, path, body) {
    const b = { ...(body || {}) };
    if (reporter() && b.reporter === undefined) b.reporter = reporter();
    try {
      return await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    } catch { return { status: 0, body: { message: '網路連線失敗，請再試一次' } }; }
  }
  function errText(r) {
    if (r.status === 401) return '登入逾時，請重新整理頁面後再登入（尚未存檔的內容請先另外記下）';
    const b = r.body || {};
    if (Array.isArray(b.details) && b.details.length) return b.details.map((d) => (typeof d === 'string' ? d : d.message || JSON.stringify(d))).join('\n');
    return b.message || b.error || `發生錯誤（${r.status}）`;
  }

  let touchTimer = null;
  const touch = () => { clearTimeout(touchTimer); touchTimer = setTimeout(() => notify(), 300); };
  const scrollTop = () => document.querySelector('.pane')?.scrollTo({ top: 0 });

  async function reloadInv() {
    const r = await api('/api/inv');
    if (r.status !== 200 || !r.body?.ok) return false;
    INV = r.body.inventory; PERIOD = r.body.period; HID = r.body.hid;
    LINKS = Array.isArray(r.body.linkIssues) ? r.body.linkIssues : [];
    REFS = Array.isArray(r.body.siteRefIssues) ? r.body.siteRefIssues : [];
    HNAME = r.body.hospitalName || ''; BASE = r.body.baseUrl || BASE;
    return true;
  }
  // 每次寫入成功就整份重讀：異動、進度、導覽徽章都可能跟著變，局部修補容易漏
  async function refreshAll() {
    await reloadInv();
    PROGRESS = null; CHANGES = null;
    notify();
  }

  // ════════════════════════ 依據（source） ════════════════════════
  // 形狀 { doc, ref?, law?, spec?, note? }。按一下展開文號、規格章節、註記。
  function srcChip(s, label = '依據') {
    if (!s || (!s.doc && !s.ref && !s.law)) return null;
    const head = [s.doc, s.ref].filter(Boolean).join(' ') || s.law;
    const b = el('button', { type: 'button', class: 'i-srcbtn', text: `${label}：${head}` });
    b.setAttribute('aria-expanded', 'false');
    const rows = [
      ['文件', s.doc], ['條次／表號', s.ref], ['文號', s.law],
      ['規格對照', s.spec && `${s.specDoc || 'docs/energy-audit-spec.md'} ${s.spec}`], ['註記', s.note],
    ].filter(([, v]) => v);
    const box = el('span', { class: 'i-srcbox hidden' }, rows.map(([k, v]) => el('span', { class: 'i-srcrow' }, [el('b', { text: k }), el('span', { text: String(v) })])));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !box.classList.toggle('hidden');
      b.setAttribute('aria-expanded', String(open));
    });
    return el('span', { class: 'i-src' }, [b, box]);
  }

  // ════════════════════════ 欄位（site 區塊與設備主檔共用） ════════════════════════
  const fieldOptions = (f, kind) => (f.optionsByKind ? f.optionsByKind[kind] || null : f.options || null);
  const applies = (f, kind) => !f.kinds || !kind || f.kinds.includes(kind);
  const blankVal = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

  function control(f, value, set, kind) {
    const t = f.type;
    if (t === 'boolean') {
      const s = el('select');
      for (const [v, l] of [['', '（未填）'], ['1', '是'], ['0', '否']]) {
        s.append(el('option', { value: v, text: l, selected: (value === true && v === '1') || (value === false && v === '0') || (value == null && v === '') }));
      }
      s.addEventListener('change', () => set(s.value === '' ? undefined : s.value === '1'));
      return s;
    }
    if (t === 'multiselect') {
      const cur = new Set(Array.isArray(value) ? value : []);
      const box = el('div', { class: 'checks' });
      for (const o of f.options || []) {
        const cb = el('input', { type: 'checkbox', checked: cur.has(o) });
        cb.addEventListener('change', () => {
          if (cb.checked) cur.add(o); else cur.delete(o);
          set(cur.size ? f.options.filter((x) => cur.has(x)) : undefined);
        });
        box.append(el('label', { class: 'chk' }, [cb, el('span', { text: o })]));
      }
      return box;
    }
    if (t === 'ref') {
      // 連到另一個 site 表格（目前只有建築資料）：存 id，畫面顯示名稱
      const rows = INV.site[f.ref] || [];
      const s = el('select');
      s.append(el('option', { value: '', text: '（未選）' }));
      if (!blankVal(value) && !rows.some((x) => x.id === value)) s.append(el('option', { value: String(value), text: `${value}（對不到${blockOf(f.ref)?.label || ''}，待修）`, selected: true }));
      for (const x of rows) s.append(el('option', { value: x.id, text: x.name || x.code || x.id, selected: x.id === value }));
      s.addEventListener('change', () => set(s.value === '' ? undefined : s.value));
      return s;
    }
    const opts = fieldOptions(f, kind);
    if (t === 'select' || opts) {
      const s = el('select');
      s.append(el('option', { value: '', text: '（未選）' }));
      const list = opts || [];
      if (!blankVal(value) && !list.includes(String(value))) s.append(el('option', { value: String(value), text: `${value}（不在選項內，存檔會被擋）`, selected: true }));
      for (const o of list) s.append(el('option', { value: o, text: f.optionLabels?.[o] ? `${o} ${f.optionLabels[o]}` : o, selected: String(value ?? '') === o }));
      s.addEventListener('change', () => set(s.value === '' ? undefined : s.value));
      return s;
    }
    const inp = el('input', { type: t === 'date' ? 'date' : t === 'month' ? 'month' : 'text', value: value == null ? '' : String(value) });
    if (t === 'number' || t === 'percent') inp.inputMode = 'decimal';
    if (t === 'year') { inp.inputMode = 'numeric'; inp.placeholder = '西元或民國，例 2015 或 104'; }
    inp.addEventListener('input', () => {
      const raw = inp.value.trim();
      if (raw === '') return set(undefined);
      if (t === 'number' || t === 'percent') {
        const n = Number(raw.replace(/,/g, ''));
        return set(Number.isFinite(n) ? n : raw);   // 不是數字就原樣送，讓後端回中文錯誤
      }
      return set(raw);
    });
    return inp;
  }

  // 唯讀顯示；空值回 null
  function show(f, v) {
    if (blankVal(v)) return null;
    if (f.type === 'boolean') return v ? '是' : '否';
    if (f.type === 'ref') {
      const x = (INV.site[f.ref] || []).find((r) => r.id === v);
      return x ? (x.name || x.code || x.id) : `${v}（待修：對不到${blockOf(f.ref)?.label || ''}）`;
    }
    if (Array.isArray(v)) return v.join('、');
    if (f.type === 'year') { const n = Number(v); return n > 1911 ? `${n}（民國 ${n - 1911}）` : `民國 ${n}`; }
    if (f.optionLabels?.[v]) return `${v} ${f.optionLabels[v]}`;
    if (typeof v === 'number') return `${fmtNum(v)}${f.unit ? ` ${f.unit}` : ''}`;
    return String(v);
  }

  function fieldRow(f, { value, edit, set, kind }) {
    const label = el('div', { class: 'i-flabel' }, [
      f.code ? el('span', { class: 'i-code', text: f.code }) : null,
      el('span', { text: f.label }),
      f.required ? el('em', { class: 'a-req', text: '必填' }) : null,
    ]);
    let body;
    if (edit) {
      const c = control(f, value, set, kind);
      body = f.unit && f.type !== 'boolean' ? el('div', { class: 'i-unitwrap' }, [c, el('span', { class: 'i-unit', text: f.unit })]) : c;
    } else {
      const s = show(f, value);
      body = el('div', { class: 'i-val' + (s == null ? ' empty' : ''), text: s ?? '—' });
    }
    return el('div', { class: 'i-field' }, [label, el('div', { class: 'i-fctl' }, [
      body,
      edit && f.hint ? el('div', { class: 'note', text: f.hint }) : null,
      edit && f.type === 'ref' && !(INV.site[f.ref] || []).length ? el('div', { class: 'note i-warntext', text: `尚未建立${blockOf(f.ref)?.label || ''}：請先到「初始建檔 › ${blockOf(f.ref)?.label || ''}」新增` }) : null,
      f.source ? srcChip(f.source) : null,
    ])]);
  }

  function grouped(fields, groups) {
    const list = groups?.length ? groups : [...new Set(fields.map((f) => f.group || ''))].map((name) => ({ name, source: null }));
    const out = list.map((g) => ({ ...g, fields: fields.filter((f) => (f.group || '') === g.name) })).filter((g) => g.fields.length);
    // groups[] 沒列到的欄位群也要畫出來，不能因為 spec 漏寫群組就讓欄位消失
    const seen = new Set(list.map((g) => g.name));
    for (const name of new Set(fields.map((f) => f.group || ''))) if (!seen.has(name)) out.push({ name, source: null, fields: fields.filter((f) => (f.group || '') === name) });
    return out;
  }

  function fieldsBox(fields, groups, obj, { edit, kind, onSet }) {
    const box = el('div', { class: 'i-groups' });
    const gs = grouped(fields.filter((f) => applies(f, kind)), groups);
    for (const g of gs) {
      const fs = el('fieldset', { class: 'i-grp' });
      if (g.name || g.source || gs.length > 1) fs.append(el('legend', {}, [el('span', { text: g.name || '一般資料' }), srcChip(g.source)]));
      for (const f of g.fields) {
        fs.append(fieldRow(f, {
          value: obj[f.key], edit, kind,
          set: (v) => { if (v === undefined) delete obj[f.key]; else obj[f.key] = v; onSet?.(f, v); touch(); },
        }));
      }
      box.append(fs);
    }
    return box;
  }

  function compactDl(fields, row, kind) {
    const dl = el('dl', { class: 'i-dl' });
    for (const f of fields) {
      if (!applies(f, kind)) continue;
      const s = show(f, row[f.key]);
      if (s == null) continue;
      dl.append(el('div', {}, [el('dt', { text: f.label }), el('dd', { text: s })]));
    }
    if (!dl.childElementCount) dl.append(el('div', {}, [el('dd', { class: 'muted', text: '（尚未填任何欄位）' })]));
    return dl;
  }

  const defaults = (fields) => { const o = {}; for (const f of fields) if (f.default !== undefined) o[f.key] = f.default; return o; };
  const titleKey = (b) => (b.fields.find((f) => f.required && f.type === 'text') || b.fields.find((f) => f.type === 'text'))?.key;
  function rowTitle(b, row, i) {
    const k = titleKey(b);
    const v = row && k ? row[k] : '';
    return v ? String(v) : `${b?.rowLabel || '第'} ${i === undefined ? '' : i + 1}`.trim();
  }
  function missingRequired(b, v) {
    const req = b.fields.filter((f) => f.required);
    if (b.kind === 'form') return req.filter((f) => blankVal(v?.[f.key])).map((f) => f.label);
    const out = [];
    (v || []).forEach((row, i) => req.forEach((f) => { if (blankVal(row[f.key])) out.push(`${rowTitle(b, row, i)}·${f.label}`); }));
    return out;
  }

  // ════════════════════════ 規則即時檢核（inventory-compute.js） ════════════════════════
  const totalKw = (meters) => (meters || []).reduce((s, m) => s + (typeof m.contractKw === 'number' ? m.contractKw : 0), 0);
  // R1：一律以單一電號的契約容量判定（任一電號 > 800 瓩即為能源用戶），不合併計算（業主 2026-10-22）。
  // 「合併申報」與「同一登記主體契約容量合計」只是附表三表三與附錄二的輸出資料，不進 R1。
  function r1Args(meters) {
    return { meters: meters || [] };
  }
  function r1r2Args(meters, ex, userClass) {
    const exclusions = ex?.exempt && ex.exemptCode ? [{
      code: ex.exemptCode, reason: ex.reason, evidence: ex.evidence ? [ex.evidence] : [],
      approvedAt: ex.approvalDate, certValidUntil: ex.isoValidUntil,
    }] : [];
    return { ...r1Args(meters, ex), exclusions, today: todayIso(), userClass };
  }

  function rulesFor(id, v) {
    if (!C) return [];
    const basic = id === 'basic' ? v || {} : INV.site.basic || {};
    const userClass = basic.userCategory || '醫院';
    const out = [];
    const add = (label, r) => { if (r) out.push({ label, r }); };
    switch (id) {
      case 'basic':
        add('R9 營業規模', C.businessScaleCheck({ userClass, beds: v?.beds }));
        add('R9 出租率', C.occupancyRateCheck({ userClass, rate: v?.occupancy }));
        add('R9 總盤功因', C.powerFactorCheck(v?.panelPf));
        break;
      case 'meters':
        add('R1 能源用戶判定', C.energyUserCheck(r1Args(v, INV.site.exemption)));
        break;
      case 'exemption':
        add('R1＋R2 能源用戶判定', C.energyUserStatus(r1r2Args(INV.site.meters, v, userClass)));
        break;
      case 'transformers':
        (v || []).forEach((t, i) => {
          const n = t.code || `第 ${i + 1} 台`;
          add(`R9 ${n} 功因`, C.powerFactorCheck(t.opPf));
          add(`R9 ${n} 負載率`, C.transformerLoadCheck({ loadPct: t.opLoadRate, maxLoadKw: t.opMaxKw, capacityKva: t.kva }));
        });
        break;
      case 'staff':
        add('R9 能管人員人數', C.staffCountCheck({ contractKw: totalKw(INV.site.meters), staff: v || [] }));
        break;
      case 'policy':
        add('R9 ISO 50001', C.isoQuestions({ passed: !!v?.iso50001, certValidUntil: v?.isoValidUntil, today: todayIso() }));
        break;
      default: break;
    }
    return out;
  }

  const LV_ICON = { ok: '✓', warn: '⚠', error: '✕', na: '·' };
  function ruleRow(label, r) {
    return el('div', { class: `i-rule lv-${r.level}` }, [
      el('span', { class: 'i-ruleicon', text: LV_ICON[r.level] || '·' }),
      el('div', { class: 'i-rulebody' }, [el('b', { text: label }), el('span', { text: r.msg }), srcChip(r.source)]),
    ]);
  }
  function paintRules(box, list) {
    box.textContent = '';
    box.classList.toggle('hidden', !list.length);
    if (!list.length) return;
    box.append(el('div', { class: 'i-rulestitle', text: '即時檢核（依目前畫面上的值計算）' }));
    for (const { label, r } of list) box.append(ruleRow(label, r));
  }

  // R6：表九設備 → 汰換類別一律用 inventory-compute.js 的 equipmentReplaceCategory（與報表、伺服器同一支）
  const r6 = (e) => (C?.equipmentReplaceCategory ? C.replacementRequired({ category: C.equipmentReplaceCategory(e), mfgYear: e.fields?.madeYear, reportYear: rocYear() }) : null);

  // ════════════════════════ 初始建檔：總覽 ════════════════════════
  function energyUserCard() {
    if (!C) return null;
    const basic = INV.site.basic || {};
    const r = C.energyUserStatus(r1r2Args(INV.site.meters, INV.site.exemption, basic.userCategory || '醫院'));
    const head = r.value === true ? '屬能源用戶：須辦理能源查核申報、節能診斷與節能計畫'
      : r.value === false && r.level !== 'na' ? '非能源用戶' : '尚無法判定';
    return el('div', { class: `i-verdict lv-${r.level} ${r.value === true ? 'is-user' : ''}` }, [
      el('div', { class: 'i-verdict-h', text: `R1／R2 判定：${head}` }),
      el('div', { text: r.msg }),
      el('div', { class: 'i-verdict-src' }, [srcChip(r.source), srcChip(r.r1?.source, 'R1'), srcChip(blockOf('exemption')?.source, '排除條件')]),
      el('div', { class: 'i-tools' }, [btn('電號與契約容量', () => UI.goSection('i-site-meters'), 'i-mini'), btn('排除條件', () => UI.goSection('i-site-exemption'), 'i-mini')]),
    ]);
  }

  function drawOverview(root) {
    root.append(el('div', { class: 'i-head' }, [el('h2', { text: '初始建檔' })]));
    root.append(note('附表三的基本資料、電號、建築、變壓器、人員、查核組織與政策，以及表九設備主檔。設備型號、容量、年份在這裡建一次，貼紙頁不出現。各區塊建完預設唯讀，要更正請按「修改」並填原因，系統會記一筆異動。'));
    const card = energyUserCard();
    if (card) root.append(card);

    const tw = el('div', { class: 'i-tablewrap' });
    const t = el('table', { class: 'i-table' });
    t.append(el('thead', {}, el('tr', {}, ['區塊', '依據', '狀態', ''].map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    for (const b of SPEC.site) {
      const v = INV.site[b.id];
      const miss = missingRequired(b, v);
      const st = isEmpty(v) ? pill('尚未建檔', 'due') : pill(b.kind === 'table' ? `已建 ${v.length} 筆` : '已建檔', 'ok');
      tb.append(el('tr', {}, [
        el('td', {}, el('b', { text: b.label })),
        el('td', {}, srcChip(b.source)),
        el('td', {}, [st, !isEmpty(v) && miss.length ? el('span', { class: 'i-warntext', text: ` 必填缺 ${miss.length}` }) : null]),
        el('td', {}, btn('前往', () => UI.goSection(`i-site-${b.id}`), 'i-mini')),
      ]));
    }
    for (const c of SPEC.equipment.categories) {
      const act = INV.equipment.filter((e) => e.category === c.id && e.status === 'active');
      const n6 = act.filter((e) => r6(e)?.value === true).length;
      tb.append(el('tr', {}, [
        el('td', {}, el('b', { text: `設備主檔·${c.label}` })),
        el('td', {}, srcChip(c.source)),
        el('td', {}, [act.length ? pill(`使用中 ${act.length} 筆`, 'ok') : pill('尚未建檔', 'due'), n6 ? el('span', { class: 'i-warntext', text: ` 汰換表 ${n6}` }) : null]),
        el('td', {}, btn('前往', () => UI.goSection(`i-eq-${c.id}`), 'i-mini')),
      ]));
    }
    t.append(tb); tw.append(t);
    root.append(el('h3', { class: 'i-h3', text: '各區塊建檔狀況' }), tw);

    // 所有區塊的 R9 提示彙整：只列需要處理的
    const hints = [];
    for (const b of SPEC.site) if (!isEmpty(INV.site[b.id])) for (const x of rulesFor(b.id, INV.site[b.id])) if (x.r.level === 'warn' || x.r.level === 'error') hints.push({ ...x, block: b });
    const n6 = INV.equipment.filter((e) => e.status === 'active' && r6(e)?.value === true);
    if (hints.length || n6.length || REFS.length) {
      const box = el('div', { class: 'i-rules' }, [el('div', { class: 'i-rulestitle', text: '需要留意的檢核結果' })]);
      for (const x of REFS) box.append(ruleRow(`待修·${blockOf(x.block)?.label || x.block}`, { level: 'warn', msg: x.message }));
      for (const h of hints) box.append(ruleRow(`${h.block.label}·${h.label}`, h.r));
      if (n6.length) {
        box.append(ruleRow('R6 設備汰換', { level: 'warn', msg: `${n6.length} 台設備機齡超過門檻，將列入節能診斷報告設備汰換表：${n6.map(eqName).join('、')}`, source: C?.SOURCES?.r6 }));
      }
      root.append(box);
    }
  }

  // ════════════════════════ 初始建檔：site 區塊 ════════════════════════
  function drawSite(root, blockId) {
    const b = blockOf(blockId);
    if (!b) { root.append(note('沒有這個區塊。')); return; }
    const saved = INV.site[b.id];
    const has = !isEmpty(saved);
    let st = ui.site[b.id];
    if (!st && !has) {
      // 第一次建檔：直接進編輯，不必填原因
      const draft = b.kind === 'table' ? [] : defaults(b.fields);
      st = ui.site[b.id] = { draft, base: clone(draft), reason: '' };
    }
    const edit = !!st;
    const value = edit ? st.draft : saved;

    root.append(el('div', { class: 'i-head' }, [
      el('h2', { text: b.label }), srcChip(b.source), el('span', { class: 'grow' }),
      has ? pill('已建檔', 'ok') : pill('尚未建檔', 'due'),
      !edit ? btn('修改', () => { ui.site[b.id] = { draft: clone(saved), base: clone(saved), reason: '' }; draw(); }, 'primary') : null,
    ]));
    if (b.id === 'exemption') {
      for (const x of SPEC.exemptionCodes || []) if (x.applicable === false) root.append(el('p', { class: 'i-private', text: `${x.code} ${x.label}：${x.note || '不適用'}，所以不在可選的排除條件裡。` }));
    }
    if (b.private) root.append(el('p', { class: 'i-private', text: '🔒 含個資（姓名、電話、電子郵件），只存在主機本地，不會同步到公開看板。' }));
    const refs = REFS.filter((x) => x.block === b.id);
    if (refs.length) root.append(el('div', { class: 'i-rules' }, [el('div', { class: 'i-rulestitle', text: `待修（${refs.length}）：舊資料的文字對不到建築資料，請按「修改」改選` }), ...refs.map((x) => ruleRow('待修', { level: 'warn', msg: x.message }))]));
    if (!edit) {
      const miss = missingRequired(b, saved);
      root.append(note(`已建檔，預設唯讀。要更正請按「修改」，修改原因會記進異動登錄。${miss.length ? `尚有 ${miss.length} 個必填欄位未填：${miss.slice(0, 6).join('、')}${miss.length > 6 ? '…' : ''}` : ''}`));
    } else if (!has) {
      root.append(note('初始建檔：第一次填寫不需要原因；存檔後轉為唯讀。必填欄位可以分次補齊。'));
    } else {
      root.append(note('修改中：存檔時須填寫原因，系統會記一筆異動（前後差異自動保留）。'));
    }

    const rb = el('div', { class: 'i-rules' });
    const refresh = () => paintRules(rb, rulesFor(b.id, value));

    if (b.kind === 'form') root.append(fieldsBox(b.fields, b.groups, value, { edit, onSet: refresh }));
    else root.append(tableBox(b, value, edit, refresh));
    root.append(rb);
    refresh();

    if (!edit) return;
    const err = errBox();
    const reason = has ? el('textarea', { rows: 2, placeholder: '例：115 年擴床 50 床；現場重新清點；人員異動', value: st.reason }) : null;
    reason?.addEventListener('input', () => { st.reason = reason.value; });
    const save = btn('存檔', async () => {
      if (has && !st.reason.trim()) { err.textContent = '請填寫修改原因（會記進異動登錄）'; reason.focus(); return; }
      save.disabled = true; err.textContent = '';
      const r = await send('PUT', `/api/inv/site/${enc(b.id)}`, { value: st.draft, ...(has ? { reason: st.reason.trim() } : {}) });
      save.disabled = false;
      if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
      delete ui.site[b.id];
      await refreshAll();
      const w = r.body.warnings || [];
      toast(w.length ? `已存檔。尚有 ${w.length} 個必填欄位未填，之後可以再補` : r.body.change ? '已存檔，並記一筆異動' : '已存檔', w.length ? 'warn' : 'ok');
      draw();
    }, 'primary');
    const cancel = has ? btn('取消修改', () => { delete ui.site[b.id]; draw(); touch(); }) : null;
    root.append(el('div', { class: 'i-savebar' }, [
      reason ? el('label', { class: 'i-reason' }, [el('span', { text: '修改原因（必填，會記進異動登錄）' }), reason]) : null,
      err,
      el('div', { class: 'i-tools' }, [save, cancel]),
    ]));
  }

  function tableBox(b, rows, edit, refresh) {
    const wrap = el('div', { class: 'i-rows' });
    if (!rows.length) wrap.append(note(edit ? `還沒有${b.rowLabel}資料，按下方「＋ 新增${b.rowLabel}」。` : '尚無資料。', 'empty'));
    rows.forEach((row, i) => {
      const title = `${b.rowLabel} ${i + 1}${titleKey(b) && row[titleKey(b)] ? `：${row[titleKey(b)]}` : ''}`;
      const del = edit ? btn('刪除這筆', async () => {
        if (!(await confirmModal({ title: `刪除「${title}」？`, body: '按「存檔」後才會生效；按「取消修改」可以還原。', okText: '刪除', danger: true }))) return;
        rows.splice(i, 1); draw(); touch();
      }, 'i-mini danger') : null;
      wrap.append(el('div', { class: 'i-rowcard' }, [
        el('div', { class: 'i-rowhead' }, [el('b', { text: title }), el('span', { class: 'grow' }), del]),
        edit ? fieldsBox(b.fields, b.groups, row, { edit: true, onSet: refresh }) : compactDl(b.fields, row),
      ]));
    });
    if (edit) {
      const full = b.max && rows.length >= b.max;
      const add = btn(`＋ 新增${b.rowLabel}`, () => { rows.push(defaults(b.fields)); draw(); touch(); }, 'add');
      add.disabled = !!full;
      wrap.append(el('div', { class: 'i-tools' }, [add, full ? el('span', { class: 'note', text: `最多 ${b.max} 筆` }) : null]));
    }
    return wrap;
  }

  // ════════════════════════ 設備主檔 ════════════════════════
  function newEqState(category, where, extra = {}) {
    const cat = catOf(category);
    const st = {
      mode: 'new', id: null, category, where, reason: '', correct: false, needReason: false,
      draft: { kind: cat.kinds[0], building: null, pointCode: null, fields: defaults(cat.fields) },
      ...extra,
    };
    st.base = clone(st.draft);
    return st;
  }
  function editEqState(e, where, extra = {}) {
    const draft = { kind: e.kind, building: e.building ?? null, pointCode: e.pointCode ?? null, fields: clone(e.fields || {}) };
    return { mode: 'edit', id: e.id, category: e.category, where, reason: '', correct: false, needReason: true, draft, base: clone(draft), ...extra };
  }

  function drawEquipment(root, catId) {
    const cat = catOf(catId);
    if (ui.eq && ui.eq.category === catId) {
      root.append(eqEditor(ui.eq, {
        onCancel: () => { ui.eq = null; draw(); touch(); },
        onSaved: (eq) => { ui.eq = eq ? { mode: 'view', id: eq.id, category: catId } : null; draw(); },
      }));
      return;
    }
    root.append(el('div', { class: 'i-head' }, [el('h2', { text: `設備主檔：${cat.label}` }), srcChip(cat.source)]));
    root.append(note('型號、容量、年份在這裡建一次；貼紙頁只顯示設備名稱。設備可指定所屬點位，點位的狀態項目也可以連到這裡的設備。'));

    const all = INV.equipment.filter((e) => e.category === catId);
    const act = all.filter((e) => e.status === 'active');
    const n6 = act.filter((e) => r6(e)?.value === true);
    if (n6.length) {
      root.append(el('div', { class: 'i-rules' }, [ruleRow('R6 機齡', {
        level: 'warn', msg: `${n6.length} 台機齡超過門檻，將列入節能診斷報告設備汰換表（列入後不可刪，可補說明）`, source: C?.SOURCES?.r6,
      })]));
    }
    const off = all.length - act.length;
    root.append(el('div', { class: 'i-tools' }, [
      btn(`＋ 新增${cat.label}`, () => { ui.eq = newEqState(catId, 'site'); draw(); scrollTop(); }, 'primary'),
      off ? btn(ui.eqAll ? `只看使用中` : `顯示已汰換／移除（${off}）`, () => { ui.eqAll = !ui.eqAll; draw(); }) : null,
    ]));

    const list = ui.eqAll ? all : act;
    if (!list.length) { root.append(note(`還沒有${cat.label}資料。按「＋ 新增${cat.label}」開始建檔。`, 'empty')); return; }
    const tw = el('div', { class: 'i-tablewrap' });
    const t = el('table', { class: 'i-table i-eqtable' });
    t.append(el('thead', {}, el('tr', {}, ['設備名稱', '種類', '所屬建築', '所屬點位', '製造年份', '機齡（R6）', '狀態', ''].map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    for (const e of list) {
      const r = r6(e);
      const y = e.fields?.madeYear;
      const open = () => { ui.eq = { mode: 'view', id: e.id, category: catId }; draw(); scrollTop(); };
      const tr = el('tr', { class: e.status !== 'active' ? 'off' : '' }, [
        el('td', {}, el('b', { text: eqName(e) })),
        el('td', { text: e.kind }),
        el('td', { text: bName(e.building) || '—' }),
        el('td', { class: 'i-mono', text: e.pointCode || '—' }),
        el('td', { text: y ? `${y}（民國 ${Number(y) - 1911}）` : '—' }),
        el('td', {}, r?.value === true
          ? el('span', { class: 'i-r6' }, [pill(`${r.age} 年`, 'warn'), el('span', { class: 'i-warntext', text: '將列入節能診斷報告設備汰換表' })])
          : el('span', { class: 'muted', text: r && r.age !== undefined ? `${r.age} 年` : '—' })),
        el('td', {}, pill(statusLabel(e.status), e.status === 'active' ? 'ok' : 'off')),
        el('td', {}, btn('查看', open, 'i-mini')),
      ]);
      tb.append(tr);
    }
    t.append(tb); tw.append(t); root.append(tw);
  }

  function eqMetaControls(d, cat, edit, onKind) {
    const fs = el('fieldset', { class: 'i-grp' }, [el('legend', {}, [el('span', { text: '分類與位置' })])]);
    const row = (label, ctl, hint) => el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: label })]), el('div', { class: 'i-fctl' }, [ctl, hint ? el('div', { class: 'note', text: hint }) : null])]);
    const val = (t) => el('div', { class: 'i-val' + (t ? '' : ' empty'), text: t || '—' });
    if (!edit) {
      fs.append(row('種類', val(d.kind)), row('所屬建築', val(bName(d.building))), row('所屬點位', val(d.pointCode ? `${d.pointCode} ${INV.points.find((p) => p.code === d.pointCode)?.name || ''}` : '')));
      return fs;
    }
    const kind = el('select', {}, cat.kinds.map((k) => el('option', { value: k, text: k, selected: k === d.kind })));
    kind.addEventListener('change', () => onKind(kind.value));
    const bs = INV.site.buildings || [];
    const bld = el('select', {}, [el('option', { value: '', text: '（未指定）' }), ...bs.map((b) => el('option', { value: b.id, text: b.name || b.code || b.id, selected: b.id === d.building }))]);
    bld.addEventListener('change', () => { d.building = bld.value || null; touch(); });
    const pts = INV.points.filter((p) => p.active !== false || p.code === d.pointCode);
    const pt = el('select', {}, [el('option', { value: '', text: '（不指定）' }), ...pts.map((p) => el('option', { value: p.code, text: `${p.code} ${p.name}`, selected: p.code === d.pointCode }))]);
    pt.addEventListener('change', () => { d.pointCode = pt.value || null; touch(); });
    fs.append(
      row('種類', kind, '換種類時，不適用的欄位會清掉（例：節能標章只問箱窗分離式）'),
      row('所屬建築', bld, bs.length ? '對應附表三表七的建築名稱' : '尚未建立建築資料：請先到「初始建檔 › 建築資料」新增'),
      row('所屬點位', pt, '這台設備貼在哪一張貼紙的點位上（可不指定）'),
    );
    return fs;
  }

  // st.mode：view（唯讀）／edit（修改，原因必填）／new（新增；st.needReason 時原因必填＝異動登錄的「設備新增」）
  function eqEditor(st, { onCancel, onSaved }) {
    const cat = catOf(st.category);
    const cur = st.id ? eqById(st.id) : null;
    if (st.mode !== 'new' && !cur) return el('div', {}, [note('找不到這台設備（可能已被刪除）。'), btn('回清單', onCancel)]);
    const view = st.mode === 'view';
    // 編輯時 d 就是 st.draft 本身（下面的控制項直接改它）；唯讀時是設備現況的快照
    const d = view ? { kind: cur.kind, building: cur.building, pointCode: cur.pointCode, fields: cur.fields || {} } : st.draft;
    const box = el('div', { class: 'i-panel' });
    const title = st.mode === 'new' ? `新增${cat.label}` : eqName(cur);
    box.append(el('div', { class: 'i-head' }, [
      st.where !== 'change' ? btn('← 回清單', onCancel, 'link') : null,
      el('h2', { text: title }), srcChip(cat.source), el('span', { class: 'grow' }),
      cur ? pill(statusLabel(cur.status), cur.status === 'active' ? 'ok' : 'off') : null,
      view && cur.status === 'active' ? btn('修改', () => { ui.eq = editEqState(cur, st.where); draw(); }, 'primary') : null,
    ]));
    if (view) {
      box.append(note(cur.status === 'active'
        ? '唯讀。要更正規格請按「修改」並填原因；設備汰換或移除請到「異動登錄」新增異動。'
        : `此設備${statusLabel(cur.status)}，不再列入使用中清單，只保留紀錄。`));
    } else if (st.mode === 'edit') {
      box.append(note('修改中：存檔時須填寫原因，系統會記一筆異動（前後差異自動保留）。'));
    }

    const rb = el('div', { class: 'i-rules' });
    const refresh = () => {
      const list = [];
      const r = r6({ ...d, category: st.category });
      if (r) list.push({ label: 'R6 機齡', r: r.value === true ? { ...r, msg: `${r.msg}：將列入節能診斷報告設備汰換表` } : r });
      if (C && d.kind === '鍋爐') list.push({ label: 'R9 鍋爐', r: C.boilerCheck({ kind: d.fields.subKind, type: d.fields.model, fuel: d.fields.boilerEnergyType }) });
      paintRules(rb, list);
    };

    box.append(eqMetaControls(d, cat, !view, (k) => {
      st.draft.kind = k;
      // 不適用新種類的欄位清掉，否則後端會回「不適用於某種類」
      for (const f of cat.fields) {
        if (f.kinds && !f.kinds.includes(k)) delete st.draft.fields[f.key];
        if (f.optionsByKind && st.draft.fields[f.key] !== undefined && !(f.optionsByKind[k] || []).includes(st.draft.fields[f.key])) {
          if (f.optionsByKind[k]) delete st.draft.fields[f.key];
        }
      }
      draw(); touch();
    }));
    box.append(rb);
    box.append(fieldsBox(cat.fields, cat.groups, d.fields, { edit: !view, kind: d.kind, onSet: refresh }));
    refresh();
    if (view) return box;

    const needReason = st.mode === 'edit' || st.needReason;
    const err = errBox();
    const reason = el('textarea', { rows: 2, value: st.reason, placeholder: st.mode === 'edit' ? '例：銘牌重新確認，製造年份更正' : '例：新購 CH-3 冰水主機' });
    reason.addEventListener('input', () => { st.reason = reason.value; });
    const correct = st.mode === 'edit' && !st.lockKind ? el('input', { type: 'checkbox', checked: st.correct }) : null;
    correct?.addEventListener('change', () => { st.correct = correct.checked; });
    const save = btn('存檔', async () => {
      if (needReason && !st.reason.trim()) { err.textContent = '請填寫原因（會記進異動登錄）'; reason.focus(); return; }
      save.disabled = true; err.textContent = '';
      const dd = st.draft;
      const payload = { kind: dd.kind, building: dd.building || null, pointCode: dd.pointCode || null, fields: dd.fields };
      const r = st.mode === 'new'
        ? await send('POST', '/api/inv/equipment', { equipment: { category: st.category, ...payload }, ...(needReason ? { reason: st.reason.trim() } : {}) })
        : await send('PUT', `/api/inv/equipment/${enc(st.id)}`, { equipment: payload, reason: st.reason.trim(), ...(st.correct ? { changeKind: 'equipment.correct' } : {}) });
      save.disabled = false;
      if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
      const w = r.body.warnings || [];
      if (r.body.unchanged) toast('內容沒有變動，未存檔', 'ok');
      else toast(w.length ? `已存檔。尚有 ${w.length} 個必填欄位未填` : r.body.change ? '已存檔，並記一筆異動' : '已存檔', w.length ? 'warn' : 'ok');
      await refreshAll();
      onSaved(r.body.equipment);
    }, 'primary');
    box.append(el('div', { class: 'i-savebar' }, [
      needReason || st.mode === 'new'
        ? el('label', { class: 'i-reason' }, [el('span', { text: needReason ? '原因（必填，會記進異動登錄）' : '備註原因（選填；初始建檔不記異動，填了才記一筆「設備新增」）' }), reason])
        : null,
      correct ? el('label', { class: 'chk' }, [correct, el('span', { text: '這是規格更正（原本資料填錯），異動種類記為「規格更正」' })]) : null,
      err,
      el('div', { class: 'i-tools' }, [save, btn(st.mode === 'new' ? '取消' : '取消修改', onCancel)]),
    ]));
    return box;
  }

  // ════════════════════════ 點位與進度（定期更新） ════════════════════════
  function itemSummary(p) {
    const by = (t) => p.items.filter((i) => i.type === t);
    const parts = [];
    if (by('bill').length) parts.push('電費單');
    const rd = by('reading');
    if (rd.length) parts.push(rd.length === 1 ? (p.domain === 'water' ? '水表讀數' : '電表讀數') : `${rd.length} 個讀數`);
    const st = by('status');
    if (st.length) parts.push(`${st.length} 台設備狀態`);
    if (by('number').length) parts.push(`${by('number').length} 個數值`);
    if (by('text').length) parts.push('文字');
    if (by('photo').length) parts.push('照片');
    return parts.join('＋') || '（尚未設定項目）';
  }
  function nextCode(domain) {
    const L = SPEC.domains[domain]?.letter || 'E';
    const nums = INV.points.map((p) => /-([EW])(\d{2})$/.exec(p.code)).filter((m) => m && m[1] === L).map((m) => Number(m[2]));
    return `${HID}-${L}${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('已複製網址', 'ok'); return; } catch {}
    const ta = el('textarea', { value: text });
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('已複製網址', 'ok'); } catch { toast('瀏覽器不允許自動複製，請手動選取網址', 'warn'); }
    ta.remove();
  }
  const qrSrc = (code, size = 512, dl = false) => `/api/inv/points/${enc(code)}/qr.png?size=${size}${dl ? '&download=1' : ''}`;

  async function drawPoints(root, tk) {
    if (ui.point) { root.append(pointEditor(ui.point)); return; }
    if (ui.imp) { root.append(importPanel(ui.imp)); return; }
    const period = ui.prog || PERIOD;
    if (!PROGRESS || PROGRESS.period !== period) {
      root.append(note('載入本期進度…'));
      const r = await api(`/api/inv/progress?period=${enc(period)}`);
      if (tk !== drawToken) return;
      root.textContent = '';
      PROGRESS = r.status === 200 && r.body?.ok ? r.body : { period, points: [], total: 0, done: 0, openAnomalies: [], error: errText(r) };
    }
    const P = PROGRESS;

    root.append(el('div', { class: 'i-head' }, [el('h2', { text: '點位與進度' }), el('span', { class: 'i-tag', text: '定期更新' })]));
    root.append(note('每個點位一張貼紙、一個固定網址。掃貼紙只記這一次會變的東西；設備規格在「初始建檔」建一次。'));

    const per = el('input', { type: 'month', value: period, class: 'i-month' });
    per.addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test(per.value)) { ui.prog = per.value; draw(); } });
    root.append(el('div', { class: 'i-tools' }, [
      el('label', { class: 'i-inline' }, [el('span', { text: '期別' }), per]),
      el('span', { class: 'grow' }),
      btn('＋ 新增點位', () => openPointEditor(null), 'primary'),
      btn('列印全部 QR', printAllQr),
      btn('批次匯入點位', openImport),
    ]));
    if (P.error) root.append(el('div', { class: 'i-err', text: `本期進度載入失敗：${P.error}` }));

    const act = INV.points.filter((p) => p.active !== false);
    const nE = act.filter((p) => p.domain === 'power').length;
    const open = P.openAnomalies || [];
    root.append(el('div', { class: 'i-kpis' }, [
      el('div', { class: 'i-kpi' }, [el('div', { class: 'v', text: String(act.length) }), el('div', { class: 'l', text: `點位（電 ${nE} · 水 ${act.length - nE}）` })]),
      el('div', { class: 'i-kpi' + (P.total && P.done < P.total ? ' due' : '') }, [el('div', { class: 'v', text: `${P.done}／${P.total}` }), el('div', { class: 'l', text: `${periodLabel(period)} 已記錄` })]),
      el('div', { class: 'i-kpi' + (open.length ? ' bad' : '') }, [el('div', { class: 'v', text: String(open.length) }), el('div', { class: 'l', text: '設備異常未結' })]),
    ]));

    if (open.length) root.append(anomalyList(open));
    if (LINKS.length) root.append(linkIssueList(LINKS));

    // 點位清單＋QR
    const pts = [...INV.points].sort((a, b) => ((a.active === false) - (b.active === false)) || a.code.localeCompare(b.code));
    if (!pts.length) {
      root.append(note('還沒有點位。按「＋ 新增點位」建立第一個（例：台電總表、冰水主機區子電表、自來水總表）。', 'empty'));
      return;
    }
    if (!ui.sel || !pts.some((p) => p.code === ui.sel)) ui.sel = (pts.find((p) => p.active !== false) || pts[0]).code;
    const progOf = (code) => (P.points || []).find((x) => x.code === code);
    const side = el('aside', { class: 'i-qrside' });
    side.setAttribute('aria-live', 'polite');
    const list = el('div', { class: 'i-plist', role: 'list' });
    list.append(el('div', { class: 'i-prow i-phead', role: 'presentation' }, [
      el('span', { class: 'i-pname', text: '點位（下一行是貼紙網址，每張不同）' }), el('span', { class: 'i-pitems', text: '每次要記的' }),
      el('span', { class: 'i-pstat', text: periodLabel(period).replace(/^\d+ 年 /, '') }), el('span', { class: 'i-pact' }),
    ]));
    const rows = [];
    for (const p of pts) {
      const g = progOf(p.code);
      const inactive = p.active === false;
      const stat = inactive ? pill('已停用', 'off') : g?.recorded ? pill('已記錄', 'ok') : pill('未記錄', 'due');
      const row = el('div', { class: 'i-prow' + (p.code === ui.sel ? ' sel' : '') + (inactive ? ' off' : ''), role: 'listitem', tabIndex: 0, 'data-code': p.code }, [
        el('div', { class: 'i-purl' }, [el('span', { class: 'i-mono', text: urlOf(p.code) }), btn('複製', (e) => { e.stopPropagation(); copyText(urlOf(p.code)); }, 'i-mini')]),
        el('div', { class: 'i-pname' }, [el('b', { text: p.name }), el('span', { class: 'muted', text: [p.code, p.location].filter(Boolean).join(' · ') })]),
        el('div', { class: 'i-pitems', text: itemSummary(p) }),
        el('div', { class: 'i-pstat' }, [stat, g?.recorded ? el('span', { class: 'note', text: `${g.lastBy || ''} ${fmtAt(g.lastAt)}`.trim() }) : null]),
        el('div', { class: 'i-pact' }, [btn('修改', (e) => { e.stopPropagation(); openPointEditor(p.code); }, 'i-mini')]),
      ]);
      const pick = () => {
        ui.sel = p.code;
        rows.forEach((r) => r.classList.toggle('sel', r === row));
        paintQr(side, p);
        if (window.innerWidth < 1200) side.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      rows.push(row); list.append(row);
    }
    paintQr(side, pts.find((p) => p.code === ui.sel));
    root.append(el('div', { class: 'i-pgrid' }, [list, side]));
    root.append(note('點選任一列看那張貼紙的 QR。點位改名或搬家只改名稱與位置，網址不變，貼紙不用重印。'));
  }

  function paintQr(box, p) {
    box.textContent = '';
    if (!p) { box.append(note('點選左側任一列看那張貼紙的 QR。')); return; }
    const url = urlOf(p.code);
    put(box,
      el('div', { class: 'i-qrbox' }, el('img', { src: qrSrc(p.code), alt: `${p.code} 貼紙 QR code`, width: 240, height: 240 })),
      el('div', { class: 'i-qrname' }, [el('b', { text: p.name }), el('span', { class: 'muted', text: p.location || '' })]),
      el('div', { class: 'i-mono i-qrurl', text: url }),
      el('div', { class: 'i-qracts' }, [
        el('a', { class: 'i-btnlink primary', href: qrSrc(p.code, 1024, true), download: `${p.code}.png`, text: '下載這張 QR（PNG）' }),
        btn('複製網址', () => copyText(url)),
        el('a', { class: 'i-btnlink', href: `/s/${enc(p.code)}`, target: '_blank', rel: 'noopener', text: '開啟貼紙頁 ↗' }),
      ]),
      note('QR 與 NFC 寫同一個網址。'),
      p.active === false ? el('p', { class: 'i-err', text: '此點位已停用：掃描後會顯示「已停用，不需要再填寫」。代碼不會再發給別的點位。' }) : null,
    );
  }

  // 設備↔點位不一致（以點位項目的 equipmentId 為準）
  function linkIssueList(list) {
    const box = el('section', { class: 'i-anoms' }, [
      el('h3', { class: 'i-h3', text: `設備與點位對不上（${list.length}）` }),
      note('連結以「點位項目連的設備」為準；設備主檔的「所屬點位」跟著它。設備汰換時若指定了新設備，系統會自動改指。'),
    ]);
    for (const x of list) {
      const card = el('div', { class: 'i-anom' }, [el('div', { class: 'i-anomhead' }, [pill('待修', 'warn'), el('span', { text: x.message })])]);
      const tools = el('div', { class: 'i-tools' });
      if (x.type === 'equipment_point_mismatch' || x.type === 'equipment_point_unlinked') {
        const fix = btn(x.expected ? `把設備的所屬點位改成 ${x.expected}` : '清掉設備的所屬點位', async () => {
          fix.disabled = true;
          const r = await send('PUT', `/api/inv/equipment/${enc(x.equipmentId)}`, { equipment: { pointCode: x.expected || null }, reason: '依點位項目同步設備所屬點位' });
          fix.disabled = false;
          if (r.status !== 200 || !r.body?.ok) { toast(errText(r), 'err'); return; }
          toast('已修正，並記一筆異動', 'ok');
          await refreshAll(); draw();
        }, 'i-mini primary');
        tools.append(fix);
      }
      if (x.pointCode && INV.points.some((p) => p.code === x.pointCode) && x.type.startsWith('item_')) tools.append(btn(`修改點位 ${x.pointCode}`, () => openPointEditor(x.pointCode), 'i-mini'));
      if (tools.childElementCount) card.append(tools);
      box.append(card);
    }
    return box;
  }

  function anomalyList(open) {
    const box = el('section', { class: 'i-anoms' }, [el('h3', { class: 'i-h3', text: `未結異常（${open.length}）` })]);
    for (const a of open) {
      const closing = ui.closing === a.id;
      const card = el('div', { class: 'i-anom' }, [
        el('div', { class: 'i-anomhead' }, [
          pill('異常', 'err'), el('b', { text: a.equipmentName ? `${a.equipmentName}·${a.label}` : a.label }),
          el('span', { class: 'muted', text: `${a.pointCode} ${a.pointName || ''}` }),
        ]),
        el('div', { class: 'note', text: `${periodLabel(a.period)} · ${a.reportedBy || '（未知）'} 回報於 ${fmtAt(a.openedAt)}` }),
        a.note ? el('div', { class: 'i-anomnote', text: `現場備註：${a.note}` }) : null,
      ]);
      if (!closing) {
        card.append(el('div', { class: 'i-tools' }, [btn('結案', () => { ui.closing = a.id; ui.closeNote = ''; draw(); }, 'primary')]));
      } else {
        const ta = el('textarea', { rows: 2, placeholder: '處理說明，例：廠商 10/25 更換軸承，試車正常', value: ui.closeNote });
        ta.addEventListener('input', () => { ui.closeNote = ta.value; });
        const err = errBox();
        const ok = btn('確認結案', async () => {
          ok.disabled = true;
          const r = await send('POST', `/api/inv/anomalies/${enc(a.id)}/close`, { note: ui.closeNote.trim() });
          ok.disabled = false;
          if (r.status === 409) { toast('這筆異常已經有人結案了', 'warn'); ui.closing = null; await refreshAll(); draw(); return; }
          if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
          ui.closing = null;
          toast('已結案', 'ok');
          await refreshAll(); draw();
        }, 'primary');
        card.append(el('label', { class: 'i-reason' }, [el('span', { text: '處理說明（建議填寫）' }), ta]), err,
          el('div', { class: 'i-tools' }, [ok, btn('取消', () => { ui.closing = null; draw(); })]));
      }
      box.append(card);
    }
    return box;
  }

  // ── 批次匯入點位（POST /api/inv/points/import；舊後端沒有這支時提示尚未上線）──
  const IMP_LABEL = { add: ['新增', 'add'], update: ['更新', 'upd'], unchanged: ['不變', 'off'], error: ['錯誤', 'err'] };
  function openImport() { ui.imp = { file: null, res: null, busy: false, err: '', reason: '' }; draw(); scrollTop(); }
  const importMissing = (r) => r.status === 404 || r.status === 501 || (r.status === 400 && r.body?.error === 'bad_code');
  async function downloadTemplate(blank) {
    let res;
    try { res = await fetch(`/api/inv/points/template.xlsx${blank ? '?blank=1' : ''}`, { credentials: 'same-origin' }); } catch { toast('網路連線失敗，請再試一次', 'err'); return; }
    if (!res.ok || !(res.headers.get('content-type') || '').includes('spreadsheet')) {
      toast(res.status === 401 ? '登入逾時，請重新整理頁面後再登入' : '伺服器尚未支援下載範本（新版上線後即可使用）', 'warn');
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: `點位匯入範本-${HID}${blank ? '-空白' : ''}.xlsx` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function sendImport(st, apply) {
    const fd = new FormData();
    fd.append('file', st.file, st.file.name);
    if (apply) fd.append('apply', 'true');
    if (reporter()) fd.append('reporter', reporter());
    if (st.reason.trim()) fd.append('reason', st.reason.trim());
    try { return await api('/api/inv/points/import', { method: 'POST', body: fd }); } catch { return { status: 0, body: { message: '網路連線失敗，請再試一次' } }; }
  }
  function importItems(items) {
    return (items || []).map((i) => `${i.label}（${itemType(i.type)?.label || i.type}${i.unit ? `·${i.unit}` : ''}）`).join('、');
  }
  function importTable(P) {
    const t = el('table', { class: 'i-table i-imptable' });
    t.append(el('thead', {}, el('tr', {}, ['', '點位', '類別', '項目', '說明', '列'].map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    for (const p of P.points) {
      const [lab, cls] = IMP_LABEL[p.action] || [p.action, ''];
      const notes = [...p.errors.map((e) => `第 ${e.row} 列：${e.message}`), ...p.changes, ...p.warnings.map((w) => `⚠ ${w}`)];
      tb.append(el('tr', { class: `i-imp-${cls}` }, [
        el('td', {}, pill(lab, cls)),
        el('td', {}, [el('b', { text: p.name || '（未填名稱）' }), el('div', { class: 'muted i-mono', text: p.code ? `${p.code}${p.autoCode ? '（自動配號）' : ''}` : '（未配號）' }), p.location ? el('div', { class: 'muted', text: p.location }) : null]),
        el('td', { text: SPEC.domains[p.domain]?.label || '' }),
        el('td', { text: importItems(p.items) }),
        el('td', {}, notes.length ? el('ul', { class: 'i-impnotes' }, notes.map((n) => el('li', { text: n }))) : null),
        el('td', { class: 'muted', text: p.rows.join('、') }),
      ]));
    }
    for (const e of P.errors.filter((x) => !P.points.some((p) => p.errors.some((y) => y.row === x.row && y.message === x.message)))) {
      tb.append(el('tr', { class: 'i-imp-err' }, [el('td', {}, pill('錯誤', 'err')), el('td', { colSpan: 4, text: e.message }), el('td', { class: 'muted', text: e.row ? String(e.row) : '' })]));
    }
    t.append(tb);
    return el('div', { class: 'i-tablewrap' }, t);
  }
  function importPanel(st) {
    const box = el('section', { class: 'i-import' });
    box.append(el('div', { class: 'i-head' }, [el('h2', { text: '批次匯入點位' }), el('span', { class: 'i-tag', text: '點位與進度' })]));
    box.append(note('一列一個項目：下載範本 → 在 Excel 填好 → 上傳看預覽（綠＝新增、藍＝更新、紅＝錯誤）→ 確認套用。點位代碼空白＝新增並自動配號；填既有代碼＝更新名稱、位置、項目（代碼與類別不能改）。有任何錯誤整批不寫入。'));
    box.append(el('div', { class: 'i-tools' }, [
      btn('下載範本（含本院現有點位）', () => downloadTemplate(false), 'primary'),
      btn('下載空白範本', () => downloadTemplate(true)),
      el('span', { class: 'grow' }),
      btn('返回點位清單', () => { ui.imp = null; draw(); }),
    ]));
    const inp = el('input', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      st.file = f; st.res = null; st.err = ''; st.busy = true; draw();
      const r = await sendImport(st, false);
      st.busy = false;
      if (importMissing(r)) st.err = '伺服器尚未支援批次匯入（新版上線後即可使用）；目前請用「＋ 新增點位」逐一建立。';
      else if (r.status !== 200 || !r.body?.preview) st.err = errText(r);
      else st.res = r.body.preview;
      draw();
    });
    box.append(el('label', { class: 'i-reason' }, [el('span', { text: st.file ? `已選檔案：${st.file.name}（重新選檔會重新預覽）` : '選擇填好的檔案（xlsx 或 csv）' }), inp]));
    if (st.busy) box.append(note('讀取與檢查中…'));
    if (st.err) box.append(el('div', { class: 'i-err', role: 'alert', text: st.err }));
    const P = st.res;
    if (!P) return box;
    const c = P.counts;
    box.append(el('div', { class: 'i-kpis' }, [
      el('div', { class: 'i-kpi' }, [el('div', { class: 'v', text: String(c.add) }), el('div', { class: 'l', text: '新增' })]),
      el('div', { class: 'i-kpi' }, [el('div', { class: 'v', text: String(c.update) }), el('div', { class: 'l', text: '更新' })]),
      el('div', { class: 'i-kpi' }, [el('div', { class: 'v', text: String(c.unchanged) }), el('div', { class: 'l', text: '不變' })]),
      el('div', { class: 'i-kpi' + (P.errors.length ? ' bad' : '') }, [el('div', { class: 'v', text: String(P.errors.length) }), el('div', { class: 'l', text: '錯誤' })]),
    ]));
    if (c.skipped) box.append(note(`略過範例列 ${c.skipped} 列。`));
    box.append(importTable(P));
    const can = P.ok && (c.add + c.update) > 0;
    if (!P.ok) box.append(el('div', { class: 'i-err', role: 'alert', text: `有 ${P.errors.length} 個錯誤：請在檔案裡修正後重新選檔。整批不會寫入。` }));
    else if (!can) box.append(note('檔案內容與目前的點位相同，沒有要新增或更新的。'));
    const reason = el('input', { type: 'text', value: st.reason, maxLength: 200, placeholder: '例：依業主 10/22 提供的點位清單建立' });
    reason.addEventListener('input', () => { st.reason = reason.value; });
    const err = errBox();
    const ok = btn(`確認套用（新增 ${c.add}、更新 ${c.update}）`, async () => {
      ok.disabled = true;
      const r = await sendImport(st, true);
      ok.disabled = false;
      if (r.status === 422 && r.body?.preview) { st.res = r.body.preview; toast('資料在預覽後有變動，請看最新的錯誤清單', 'warn'); draw(); return; }
      if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
      toast(r.body.applied ? `已匯入：新增 ${r.body.preview.counts.add}、更新 ${r.body.preview.counts.update}，並記一筆異動` : '沒有要寫入的變更', 'ok');
      ui.imp = null;
      await refreshAll(); draw();
    }, 'primary');
    ok.disabled = !can;
    box.append(el('label', { class: 'i-reason' }, [el('span', { text: '匯入原因（記進異動登錄，可留白）' }), reason]), err,
      el('div', { class: 'i-tools' }, [ok, btn('取消', () => { ui.imp = null; draw(); })]));
    return box;
  }

  // ── 點位編輯 ──
  function openPointEditor(code) {
    const p = code ? INV.points.find((x) => x.code === code) : null;
    const draft = p
      ? { domain: p.domain, name: p.name, location: p.location || '', items: clone(p.items), active: p.active !== false }
      : { domain: 'power', name: '', location: '', items: [], active: true };
    ui.point = { code: code || null, draft, base: clone(draft), reason: '', locked: new Set(p ? p.items.map((i) => i.id) : []) };
    draw(); scrollTop();
  }

  function newItemId(items, type) {
    const used = new Set(items.map((i) => i.id));
    let n = 1;
    while (used.has(`${type}${n}`)) n++;
    return `${type}${n}`;
  }

  // 只送 schema 認得的鍵（項目 schema 是 strict），空值不送
  function cleanItem(it) {
    const T = itemType(it.type) || {};
    const o = { id: it.id, label: String(it.label || '').trim(), type: it.type };
    if (T.usesUnit && String(it.unit || '').trim()) o.unit = String(it.unit).trim();
    if (T.usesOptions && Array.isArray(it.options) && it.options.length) o.options = it.options;
    if (T.usesWarnPct && typeof it.warnPct === 'number' && it.warnPct > 0) o.warnPct = it.warnPct;
    if (it.equipmentId) o.equipmentId = it.equipmentId;
    if (it.meterId) o.meterId = it.meterId;
    if (it.required) o.required = true;
    // 表九之一（二）冰水機群組：畫面沒有編輯欄，但存檔時不能把既有設定丟掉
    if (it.chillerGroup) o.chillerGroup = it.chillerGroup;
    if (it.chillerRole) o.chillerRole = it.chillerRole;
    // 水足跡盤查（工作清單 23）：流向與連結
    for (const k of WATER_KEYS) if (it[k]) o[k] = it[k];
    return o;
  }

  // ── 水足跡盤查：點位項目的水屬性與用水點位範本（spec.water；舊後端沒有就整段不出現）──
  const WATER_KEYS = ['waterFlow', 'waterSourceId', 'waterUnitId', 'waterDischargeId', 'waterParam'];
  const WATER_LINKS = { intake: ['waterSourceId'], use: ['waterUnitId'], saving: ['waterUnitId'], discharge: ['waterDischargeId'], quality: ['waterDischargeId', 'waterParam'] };
  function waterControls(it, cell) {
    const WS = SPEC.water;
    if (!WS || (it.type !== 'reading' && it.type !== 'number')) return [];
    const out = [];
    const flows = Object.entries(WS.flows).filter(([k]) => it.type === 'number' || !['quality', 'saving'].includes(k));
    const fs = el('select', {}, [el('option', { value: '', text: '（不列入水足跡計算）' }), ...flows.map(([k, f]) => el('option', { value: k, text: f.label, selected: k === it.waterFlow }))]);
    fs.addEventListener('change', () => {
      if (fs.value) it.waterFlow = fs.value; else delete it.waterFlow;
      const keep = WATER_LINKS[it.waterFlow] || [];
      for (const k of WATER_KEYS) if (k !== 'waterFlow' && !keep.includes(k)) delete it[k];
      draw(); touch();
    });
    const F = WS.flows[it.waterFlow];
    out.push(cell('水的流向', fs, F ? F.hint : '標了流向才會算進取水、排放、用水單元'));
    const pick = (key, block, label, empty, hintNone) => {
      const rows = INV.site[block] || [];
      const s = el('select', {}, [el('option', { value: '', text: empty }), ...rows.map((r) => el('option', { value: r.id, text: r.name || r.id, selected: r.id === it[key] }))]);
      if (it[key] && !rows.some((r) => r.id === it[key])) s.append(el('option', { value: it[key], text: `${it[key]}（已刪除，待修）`, selected: true }));
      s.addEventListener('change', () => { if (s.value) it[key] = s.value; else delete it[key]; touch(); });
      out.push(cell(label, s, rows.length ? null : hintNone));
    };
    if (it.waterFlow === 'intake') pick('waterSourceId', 'waterSources', '水源', '（未指定水源）', '尚未建立水源：初始建檔 › 水源');
    if (it.waterFlow === 'use' || it.waterFlow === 'saving') pick('waterUnitId', 'waterUnits', '用水單元', '（未指定用水單元）', '尚未建立用水單元：初始建檔 › 主要用水單元');
    if (it.waterFlow === 'discharge' || it.waterFlow === 'quality') pick('waterDischargeId', 'waterDischarges', '排放口', '（未指定排放口）', '尚未建立排放口：初始建檔 › 排放與回收');
    if (it.waterFlow === 'quality') {
      const opts = [...new Set([...(WS.qualityParams || []), ...(it.waterParam ? [it.waterParam] : [])])];
      const q = el('select', {}, [el('option', { value: '', text: '（用項目名稱）' }), ...opts.map((x) => el('option', { value: x, text: x, selected: x === it.waterParam }))]);
      q.addEventListener('change', () => { if (q.value) it.waterParam = q.value; else delete it.waterParam; touch(); });
      out.push(cell('水質項目', q));
    }
    return out;
  }

  // 套用範本：沒有項目就整組帶入；已有項目就接在後面（代號重複的自動改號）
  function applyWaterTemplate(d, t) {
    const used = new Set(d.items.map((x) => x.id));
    const items = clone(t.items).map((it) => {
      let id = it.id, n = 2;
      while (used.has(id)) id = `${it.id}${n++}`;
      used.add(id);
      return { ...it, id };
    });
    d.domain = 'water';
    if (!String(d.name || '').trim()) d.name = t.name;
    d.items.push(...items);
    return items.length;
  }
  function waterTemplateBox(d, isNew) {
    const T = SPEC.water?.pointTemplates;
    if (!T?.length || (!isNew && d.domain !== 'water')) return null;
    const box = el('fieldset', { class: 'i-grp' }, [el('legend', {}, [el('span', { text: '套用用水點位範本' }), srcChip(SPEC.water.source)])]);
    const sel = el('select', {}, T.map((t) => el('option', { value: t.id, text: `${t.label}（${t.purpose}）` })));
    const hint = el('div', { class: 'note' });
    const show = () => { const t = T.find((x) => x.id === sel.value); hint.textContent = t ? `${t.hint}｜項目：${t.items.map((x) => x.label).join('、')}` : ''; };
    sel.addEventListener('change', show); show();
    const go = btn(d.items.length ? '加入範本項目' : '套用範本', () => {
      const t = T.find((x) => x.id === sel.value);
      if (!t) return;
      const n = applyWaterTemplate(d, t);
      toast(`已帶入「${t.label}」${n} 個項目；水源、用水單元、排放口請在項目裡選`, 'ok');
      draw(); touch();
    }, 'primary');
    box.append(
      note(isNew ? '水表總表、冷卻水塔補水、雨水回收、污水排放、水質抽測、節水改善回報等常用點位，一鍵帶入項目與流向（類別自動改成「水」）。' : '把範本的項目加到這個點位後面。'),
      el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: '範本' })]), el('div', { class: 'i-fctl' }, [sel, hint])]),
      el('div', { class: 'i-tools' }, [go]),
    );
    return box;
  }

  function itemCard(it, i, items, locked, domain) {
    const T = itemType(it.type) || { id: it.type, label: it.type };
    const card = el('div', { class: 'i-item' });
    const up = btn('↑', () => { items.splice(i - 1, 0, items.splice(i, 1)[0]); draw(); touch(); }, 'i-mini');
    up.disabled = i === 0; up.title = '上移';
    const down = btn('↓', () => { items.splice(i + 1, 0, items.splice(i, 1)[0]); draw(); touch(); }, 'i-mini');
    down.disabled = i === items.length - 1; down.title = '下移';
    const del = btn('刪除', async () => {
      if (locked && !(await confirmModal({ title: `刪除項目「${it.label || it.id}」？`, body: '已記錄的歷史值會保留，但貼紙頁不再出現這一項。按「存檔」後才生效。', okText: '刪除', danger: true }))) return;
      items.splice(i, 1); draw(); touch();
    }, 'i-mini danger');
    card.append(el('div', { class: 'i-itemhead' }, [
      el('b', { text: `項目 ${i + 1}` }), el('span', { class: 'i-mono muted', text: `代號 ${it.id}` }),
      el('span', { class: 'grow' }), up, down, del,
    ]));

    const grid = el('div', { class: 'i-itemgrid' });
    const cell = (label, ctl, hint) => el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: label }), ctl, hint ? el('span', { class: 'note', text: hint }) : null]);

    if (locked) {
      grid.append(el('div', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '類型' }), el('div', { class: 'i-val', text: `🔒 ${T.label}` }),
        el('span', { class: 'note', text: '已存在的項目不改類型（舊紀錄的用量會對不上）；要換類型請新增一項、刪掉舊的。' })]));
    } else {
      const ts = el('select', {}, SPEC.itemTypes.map((t) => el('option', { value: t.id, text: t.label, selected: t.id === it.type })));
      ts.addEventListener('change', () => {
        it.type = ts.value;
        const NT = itemType(it.type);
        if (!NT.usesOptions) delete it.options;
        if (!NT.usesWarnPct) delete it.warnPct;
        if (!NT.usesUnit) delete it.unit;
        if (it.type === 'bill') delete it.equipmentId;
        if (it.type !== 'reading' && it.type !== 'bill') delete it.meterId;
        if ((it.type !== 'reading' && it.type !== 'number') || (it.type === 'reading' && ['quality', 'saving'].includes(it.waterFlow))) for (const k of WATER_KEYS) delete it[k];
        draw(); touch();
      });
      grid.append(cell('類型', ts));
    }
    const lab = el('input', { type: 'text', value: it.label || '', placeholder: '例：子電表 SM-07 讀數' });
    lab.addEventListener('input', () => { it.label = lab.value; touch(); });
    grid.append(cell('項目名稱（貼紙頁顯示）', lab));

    if (T.usesUnit) {
      const u = el('input', { type: 'text', value: it.unit || '', placeholder: '例：度、℃、kg/cm²' });
      u.addEventListener('input', () => { it.unit = u.value; touch(); });
      grid.append(cell('單位', u));
    }
    if (T.usesWarnPct) {
      const w = el('input', { type: 'text', inputMode: 'decimal', value: it.warnPct ?? '', placeholder: '例：30' });
      w.addEventListener('input', () => { const n = Number(w.value); if (w.value.trim() === '') delete it.warnPct; else if (Number.isFinite(n)) it.warnPct = n; touch(); });
      grid.append(cell('用量警示（%）', w, '本次用量與上次差超過這個比例時提示（不擋送出）'));
    }
    if (T.usesOptions) {
      const o = el('input', { type: 'text', value: (it.options || []).join('、'), placeholder: SPEC.statusDefaults.join('、') });
      const warn = el('span', { class: 'note i-warntext' });
      const check = () => { warn.textContent = it.options?.length && !it.options.includes(SPEC.anomalyValue) ? `選項裡沒有「${SPEC.anomalyValue}」，回報異常時不會列入未結異常。` : ''; };
      o.addEventListener('input', () => {
        const arr = o.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
        if (arr.length) it.options = [...new Set(arr)]; else delete it.options;
        check(); touch();
      });
      check();
      grid.append(el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '狀態選項' }), o,
        el('span', { class: 'note', text: `用「、」分隔，至少 2 個；留白＝預設 ${SPEC.statusDefaults.join('／')}。選到「${SPEC.anomalyValue}」會列入未結異常。` }), warn]));
    }
    if (it.type !== 'bill') {
      const act = INV.equipment.filter((e) => e.status === 'active' || e.id === it.equipmentId);
      const s = el('select', {}, [el('option', { value: '', text: '（不連結設備）' })]);
      for (const c of SPEC.equipment.categories) {
        const es = act.filter((e) => e.category === c.id);
        if (es.length) s.append(el('optgroup', { label: c.label }, es.map((e) => el('option', { value: e.id, text: `${eqName(e)}（${e.kind}）`, selected: e.id === it.equipmentId }))));
      }
      s.addEventListener('change', () => { if (s.value) it.equipmentId = s.value; else delete it.equipmentId; touch(); });
      grid.append(cell('連結設備', s, it.type === 'status' ? '貼紙頁只顯示設備名稱' : null));
    }
    if (domain === 'water') for (const c of waterControls(it, cell)) grid.append(c);
    if ((it.type === 'reading' || it.type === 'bill') && (domain !== 'water' || it.meterId)) {
      const ms = INV.site.meters || [];
      const s = el('select', {}, [el('option', { value: '', text: '（不連結電號）' }), ...ms.map((m) => el('option', { value: m.id, text: m.meterNo || m.id, selected: m.id === it.meterId }))]);
      s.addEventListener('change', () => { if (s.value) it.meterId = s.value; else delete it.meterId; touch(); });
      grid.append(cell('連結電號', s, ms.length ? null : '尚未建立電號：初始建檔 › 電號'));
    }
    const req = el('input', { type: 'checkbox', checked: !!it.required });
    req.addEventListener('change', () => { if (req.checked) it.required = true; else delete it.required; touch(); });
    grid.append(el('label', { class: 'chk' }, [req, el('span', { text: '必填' })]));
    card.append(grid);
    card.append(el('div', { class: 'i-itemsrc' }, [T.hint ? el('span', { class: 'note', text: T.hint }) : null, srcChip(T.source)]));
    return card;
  }

  function pointEditor(st) {
    const d = st.draft;
    const isNew = !st.code;
    const cur = isNew ? null : INV.points.find((p) => p.code === st.code);
    const close = () => { ui.point = null; draw(); touch(); };
    const box = el('div', { class: 'i-panel' });
    box.append(el('div', { class: 'i-head' }, [btn('← 回點位清單', close, 'link'), el('h2', { text: isNew ? '新增點位' : `修改點位 ${st.code}` })]));

    const idf = el('fieldset', { class: 'i-grp' }, [el('legend', {}, [el('span', { text: '點位代碼與類別' })])]);
    if (isNew) {
      const ds = el('select', {}, Object.entries(SPEC.domains).map(([k, v]) => el('option', { value: k, text: `${v.label}（代碼 ${v.letter}）`, selected: k === d.domain })));
      ds.addEventListener('change', () => { d.domain = ds.value; if (d.domain !== 'water') for (const it of d.items) for (const k of WATER_KEYS) delete it[k]; draw(); });
      idf.append(
        el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: '類別' })]), el('div', { class: 'i-fctl' }, [ds])]),
        el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: '點位代碼' })]), el('div', { class: 'i-fctl' }, [
          el('div', { class: 'i-val i-mono', text: `存檔後配發：${nextCode(d.domain)}` }),
          el('div', { class: 'i-mono muted', text: urlOf(nextCode(d.domain)) }),
        ])]),
        el('p', { class: 'i-lockline', text: '代碼與類別存檔後就不能改：網址會印在貼紙上。停用的號碼也不會再發給別的點位。' }),
      );
    } else {
      idf.append(
        el('div', { class: 'i-locked' }, [
          el('span', { class: 'i-lock', text: '🔒' }), el('b', { class: 'i-mono', text: st.code }),
          pill(SPEC.domains[d.domain]?.label || d.domain, 'off'), el('span', { class: 'i-mono muted', text: urlOf(st.code) }),
        ]),
        el('p', { class: 'i-lockline', text: '點位代碼與類別不能修改：網址已經印在貼紙上。點位改名或搬家，只改下面的名稱與位置，網址不變，貼紙不用重印。' }),
      );
    }
    box.append(idf);
    const wt = waterTemplateBox(d, isNew);
    if (wt) box.append(wt);

    const bf = el('fieldset', { class: 'i-grp' }, [el('legend', {}, [el('span', { text: '名稱與位置' })])]);
    const nm = el('input', { type: 'text', value: d.name, placeholder: '例：B1 中央機房 冰水主機區' });
    nm.addEventListener('input', () => { d.name = nm.value; touch(); });
    const loc = el('input', { type: 'text', value: d.location, placeholder: '例：醫療大樓 B1 中央機房' });
    loc.addEventListener('input', () => { d.location = loc.value; touch(); });
    bf.append(
      el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: '點位名稱' }), el('em', { class: 'a-req', text: '必填' })]), el('div', { class: 'i-fctl' }, [nm])]),
      el('div', { class: 'i-field' }, [el('div', { class: 'i-flabel' }, [el('span', { text: '位置' })]), el('div', { class: 'i-fctl' }, [loc, el('div', { class: 'note', text: '搬家只改這裡，網址不變' })])]),
    );
    box.append(bf);

    const itf = el('fieldset', { class: 'i-grp' }, [el('legend', {}, [el('span', { text: `每次要記的項目（${d.items.length}）` })])]);
    itf.append(note('貼紙頁的表單依這裡的項目類型自動長出來；設備只顯示名稱，型號容量不出現。'));
    d.items.forEach((it, i) => itf.append(itemCard(it, i, d.items, st.locked.has(it.id), d.domain)));
    if (!d.items.length) itf.append(note('至少要有一個項目。', 'empty'));
    itf.append(el('div', { class: 'i-tools i-addtypes' }, [
      el('span', { class: 'note', text: '新增項目：' }),
      ...SPEC.itemTypes.map((t) => btn(`＋ ${t.label}`, () => {
        d.items.push({ id: newItemId(d.items, t.id), label: t.id === 'status' ? '設備狀態' : t.id === 'bill' ? '台電電費單' : '', type: t.id });
        draw(); touch();
      }, 'add')),
    ]));
    box.append(itf);

    const err = errBox();
    const reason = isNew ? null : el('input', { type: 'text', value: st.reason, placeholder: '例：機房搬到 B2；新增冰水泵狀態' });
    reason?.addEventListener('input', () => { st.reason = reason.value; });
    const save = btn('存檔', async () => {
      if (!d.name.trim()) { err.textContent = '點位名稱必填'; nm.focus(); return; }
      if (!d.items.length) { err.textContent = '點位至少要有一個項目'; return; }
      const items = d.items.map(cleanItem);
      save.disabled = true; err.textContent = '';
      const r = isNew
        ? await send('POST', '/api/inv/points', { point: { domain: d.domain, name: d.name.trim(), location: d.location.trim(), items } })
        : await send('PUT', `/api/inv/points/${enc(st.code)}`, { point: { name: d.name.trim(), location: d.location.trim(), items }, reason: st.reason.trim() });
      save.disabled = false;
      if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
      const code = r.body.point?.code || st.code;
      ui.point = null; ui.sel = code;
      toast(r.body.unchanged ? '內容沒有變動' : isNew ? `已新增點位 ${code}，貼紙網址：${urlOf(code)}` : '已存檔', 'ok');
      await refreshAll(); draw(); scrollTop();
    }, 'primary');
    box.append(el('div', { class: 'i-savebar' }, [
      reason ? el('label', { class: 'i-reason' }, [el('span', { text: '修改說明（選填，會記進異動登錄）' }), reason]) : null,
      err,
      el('div', { class: 'i-tools' }, [save, btn('取消', close)]),
    ]));

    if (cur) {
      const on = cur.active !== false;
      const tog = btn(on ? '停用此點位' : '重新啟用此點位', async () => {
        const ok = await confirmModal({
          title: on ? `停用點位 ${cur.code}？` : `重新啟用點位 ${cur.code}？`,
          body: on ? '停用後掃描貼紙會顯示「已停用，不需要再填寫」，也不再列入本期進度。紀錄保留，代碼不會再發給別的點位，之後可以重新啟用。' : '重新啟用後貼紙恢復可填寫，並列入本期進度。',
          okText: on ? '停用' : '重新啟用', danger: on,
        });
        if (!ok) return;
        const r = await send('PUT', `/api/inv/points/${enc(cur.code)}`, { point: { active: !on }, reason: on ? '停用點位' : '重新啟用點位' });
        if (r.status !== 200 || !r.body?.ok) { toast(errText(r), 'err'); return; }
        ui.point = null;
        toast(on ? '已停用' : '已重新啟用', 'ok');
        await refreshAll(); draw();
      }, on ? 'danger-btn' : '');
      box.append(el('div', { class: 'i-danger' }, [el('b', { text: on ? '停用點位' : '此點位已停用' }), note(on ? '點位拆除或不再需要記錄時使用。停用不刪資料。' : '重新啟用後同一張貼紙可以繼續使用。'), tog]));
    }
    return box;
  }

  // ── 列印全部 QR：一頁排好所有點位 QR＋名稱＋網址（不需要後端打包） ──
  async function printAllQr() {
    const pts = INV.points.filter((p) => p.active !== false).sort((a, b) => a.code.localeCompare(b.code));
    if (!pts.length) { toast('沒有使用中的點位可以列印', 'warn'); return; }
    let host = document.getElementById('invPrint');
    if (!host) { host = el('div', { id: 'invPrint', class: 'i-print' }); document.body.append(host); }
    host.textContent = '';
    host.append(el('div', { class: 'i-printhead' }, [
      el('b', { text: `${HNAME || HID} 點位貼紙 QR（共 ${pts.length} 張）` }),
      el('span', { text: `列印日期 ${todayIso()}；QR 與 NFC 寫同一個網址` }),
    ]));
    const grid = el('div', { class: 'i-printgrid' });
    const imgs = [];
    for (const p of pts) {
      const img = el('img', { src: qrSrc(p.code, 600), alt: p.code, width: 200, height: 200 });
      imgs.push(img);
      grid.append(el('div', { class: 'i-printcard' }, [img,
        el('div', { class: 'i-printname', text: p.name }),
        p.location ? el('div', { class: 'i-printloc', text: p.location }) : null,
        el('div', { class: 'i-printcode', text: p.code }),
        el('div', { class: 'i-printurl', text: urlOf(p.code) }),
      ]));
    }
    host.append(grid);
    toast('準備列印版面…', 'busy');
    await Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
    UI.toastHide();
    document.body.classList.add('i-printing');
    const done = () => { document.body.classList.remove('i-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ════════════════════════ 異動登錄 ════════════════════════
  const kindLabel = (k) => KINDS[k] || SPEC.changeKinds[k] || k;
  const kindTone = (k) => (k.startsWith('equipment.') ? (k === 'equipment.remove' || k === 'equipment.replace' ? 'warn' : 'eq') : k === 'staff' ? 'staff' : k === 'point' || k === 'point.import' ? 'pt' : '');
  function splitTarget(t) { const s = String(t || ''); const i = s.indexOf('.'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, '']; }
  function targetLabel(t) {
    const [a, b] = splitTarget(t);
    if (a === 'equipment' && b) { const e = eqById(b); return e ? `${eqName(e)}（${catOf(e.category)?.label || ''}·${e.kind}）` : `設備 ${b}`; }
    if (a === 'point' && b) { const p = INV.points.find((x) => x.code === b); return `點位 ${b}${p ? ` ${p.name}` : ''}`; }
    if (a === 'site' && b) return `初始建檔·${blockOf(b)?.label || b}`;
    if (a === 'points' && !b) return '點位清單（批次匯入）';
    return String(t || '（未指定對象）');
  }
  const plain = (v) => (v == null || v === '' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  function metaFmt(k, v) {
    if (blankVal(v)) return '';
    if (k === 'status') return statusLabel(v);
    if (k === 'building') return bName(v);
    if (k === 'replacedBy') return eqName(eqById(v)) || v;
    if (k === 'pointCode') { const p = INV.points.find((x) => x.code === v); return p ? `${v} ${p.name}` : v; }
    return String(v);
  }
  function objDiff(A, B, F, push, prefix = '') {
    A = A || {}; B = B || {};
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
      if (k === 'id' || same(A[k], B[k])) continue;
      const f = F.get(k) || { label: k };
      push(`${prefix}${f.label}`, show(f, A[k]) ?? '', show(f, B[k]) ?? '');
    }
  }
  function changeDiff(c) {
    const rows = [];
    const push = (label, from, to) => rows.push({ label, from, to });
    const b = c.before, a = c.after;
    const isObj = (v) => v && typeof v === 'object';
    if (!isObj(b) && !isObj(a)) { if (!blankVal(b) || !blankVal(a)) push('內容', plain(b), plain(a)); return rows; }
    const [tt, tid] = splitTarget(c.target);
    if (c.kind === 'point.import') {
      const bef = new Map((b?.updated || []).map((p) => [p.code, p]));
      for (const p of a?.added || []) push('新增點位', '', `${p.code} ${p.name}（${p.items.length} 個項目）`);
      for (const p of a?.updated || []) { const o = bef.get(p.code); push(`更新點位 ${p.code}`, o ? `${o.name}（${o.items.length} 個項目）` : '', `${p.name}（${p.items.length} 個項目）`); }
      for (const x of c.links?.equipmentPointCode || []) push('設備所屬點位補上', '', `${eqName(eqById(x.equipmentId)) || x.equipmentId} → ${x.pointCode}`);
      if (c.links?.source) push('來源檔案', '', c.links.source);
      return rows;
    }
    if (tt === 'equipment') {
      const cat = catOf((a || b).category);
      for (const [k, l] of [['status', '狀態'], ['kind', '種類'], ['building', '所屬建築'], ['pointCode', '所屬點位'], ['replacedBy', '取代的新設備']]) if (!same(b?.[k] ?? null, a?.[k] ?? null)) push(l, metaFmt(k, b?.[k]), metaFmt(k, a?.[k]));
      const L = c.links;
      if (L?.items?.length) push('點位項目改連新設備', '', L.items.map((x) => `${x.pointCode}「${x.label}」`).join('、'));
      if (L?.newPointCode && !same(L.newPointCode.from, L.newPointCode.to)) push('新設備所屬點位', metaFmt('pointCode', L.newPointCode.from), metaFmt('pointCode', L.newPointCode.to));
      objDiff(b?.fields, a?.fields, new Map((cat?.fields || []).map((f) => [f.key, f])), push);
      return rows;
    }
    if (tt === 'site') {
      const blk = blockOf(tid);
      const F = new Map((blk?.fields || []).map((f) => [f.key, f]));
      if (Array.isArray(a) || Array.isArray(b)) {
        const A = Array.isArray(b) ? b : [], B = Array.isArray(a) ? a : [];
        const ids = [...new Set([...A.map((r) => r.id), ...B.map((r) => r.id)])];
        for (const id of ids) {
          const r0 = A.find((r) => r.id === id), r1 = B.find((r) => r.id === id);
          const name = rowTitle(blk || { fields: [] }, r1 || r0);
          if (!r0) push(`新增${blk?.rowLabel || ''}`, '', name);
          else if (!r1) push(`移除${blk?.rowLabel || ''}`, name, '');
          else objDiff(r0, r1, F, push, `${name}·`);
        }
        return rows;
      }
      objDiff(b, a, F, push);
      return rows;
    }
    if (tt === 'point') {
      for (const [k, l] of [['name', '點位名稱'], ['location', '位置']]) if (!same(b?.[k], a?.[k])) push(l, plain(b?.[k]), plain(a?.[k]));
      if (!same(b?.active, a?.active)) push('使用狀態', b?.active === false ? '已停用' : '使用中', a?.active === false ? '已停用' : '使用中');
      const I0 = b?.items || [], I1 = a?.items || [];
      for (const id of new Set([...I0.map((i) => i.id), ...I1.map((i) => i.id)])) {
        const x = I0.find((i) => i.id === id), y = I1.find((i) => i.id === id);
        if (!x) push('新增項目', '', `${y.label}（${itemType(y.type)?.label || y.type}）`);
        else if (!y) push('移除項目', `${x.label}（${itemType(x.type)?.label || x.type}）`, '');
        else if (!same(x, y)) {
          const parts = [];
          if (x.label !== y.label) parts.push(`名稱「${x.label}」→「${y.label}」`);
          if (x.equipmentId !== y.equipmentId) parts.push(`連結設備 ${eqName(eqById(x.equipmentId)) || '無'} → ${eqName(eqById(y.equipmentId)) || '無'}`);
          if (!same(x.options, y.options) || x.unit !== y.unit || x.warnPct !== y.warnPct || x.meterId !== y.meterId || !!x.required !== !!y.required) parts.push('設定調整');
          push(`項目「${y.label}」`, '', parts.join('；') || '設定調整');
        }
      }
      return rows;
    }
    objDiff(isObj(b) ? b : { 內容: b }, isObj(a) ? a : { 內容: a }, new Map(), push);
    return rows;
  }

  function diffNode(rows) {
    return el('div', { class: 'difflist i-diff' }, rows.map((r) => el('div', { class: 'diffrow' }, [
      el('div', { class: 'diffpath', text: r.label }),
      el('div', { class: 'diffval' }, [el('s', { text: r.from || '（無）' }), el('span', { class: 'arrow', text: '→' }), el('b', { text: r.to || '（無）' })]),
    ])));
  }

  async function drawChanges(root, tk) {
    if (!CHANGES) {
      root.append(note('載入異動紀錄…'));
      const r = await api('/api/inv/changes');
      if (tk !== drawToken) return;
      root.textContent = '';
      if (r.status !== 200 || !r.body?.ok) { root.append(el('div', { class: 'i-err', text: `異動紀錄載入失敗：${errText(r)}` })); return; }
      CHANGES = r.body.items || []; KINDS = r.body.kinds || KINDS;
    }
    root.append(el('div', { class: 'i-head' }, [el('h2', { text: '異動登錄' })]));
    root.append(note('設備新增／汰換／移除／規格更正、人員異動、措施完工、計畫變更。每筆記時間、人、前後差異與原因；初始建檔區塊按「修改」存檔時也會自動記一筆。'));

    if (ui.ch) root.append(changeForm(ui.ch));
    else root.append(el('div', { class: 'i-tools' }, [btn('＋ 新增異動', () => { ui.ch = { kind: '' }; draw(); }, 'primary')]));

    const counts = {};
    for (const c of CHANGES) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const chips = el('div', { class: 'i-chips', role: 'group' });
    chips.setAttribute('aria-label', '依類型篩選');
    const chip = (k, label, n) => {
      const b = btn(`${label}（${n}）`, () => { ui.chKind = k; draw(); }, 'i-chip' + (ui.chKind === k ? ' on' : ''));
      b.setAttribute('aria-pressed', String(ui.chKind === k));
      return b;
    };
    chips.append(chip('', '全部', CHANGES.length));
    for (const k of Object.keys(KINDS)) if (counts[k]) chips.append(chip(k, kindLabel(k), counts[k]));
    root.append(chips);

    const list = ui.chKind ? CHANGES.filter((c) => c.kind === ui.chKind) : CHANGES;
    if (!list.length) { root.append(note('目前沒有異動紀錄。', 'empty')); return; }
    const tl = el('ol', { class: 'i-timeline' });
    let lastDay = '';
    for (const c of list) {
      const day = fmtAt(c.at).slice(0, 10);
      if (day !== lastDay) { tl.append(el('li', { class: 'i-day', text: day })); lastDay = day; }
      const rows = changeDiff(c);
      const li = el('li', { class: 'i-chg' }, [
        el('div', { class: 'i-chghead' }, [
          pill(kindLabel(c.kind), `k ${kindTone(c.kind)}`), el('b', { text: targetLabel(c.target) }), el('span', { class: 'grow' }),
          el('span', { class: 'muted i-chgwho', text: `${fmtAt(c.at).slice(11)} · ${c.who || ''}` }),
        ]),
        el('div', { class: 'i-chgreason' + (c.reason ? '' : ' muted'), text: c.reason ? `原因：${c.reason}` : '（未填原因：初始建檔期間的資料調整）' }),
      ]);
      if (rows.length && rows.length <= 4) li.append(diffNode(rows));
      else if (rows.length) li.append(el('details', { class: 'i-diffmore' }, [el('summary', { text: `前後差異（${rows.length} 項）` }), diffNode(rows)]));
      tl.append(li);
    }
    root.append(tl);
  }

  const FORM_KINDS = ['equipment.add', 'equipment.replace', 'equipment.remove', 'equipment.correct', 'staff', 'measure.done', 'plan.change', 'other'];
  const KIND_HINT = {
    'equipment.add': '新購或新裝的設備。存檔後設備出現在設備主檔，並記一筆「設備新增」。',
    'equipment.replace': '舊設備汰換掉：設備主檔標成「已汰換」（保留紀錄）。可以接著建立取代它的新設備。',
    'equipment.remove': '設備拆除不再使用：設備主檔標成「已移除」（保留紀錄）。',
    'equipment.correct': '原本資料填錯（型號、年份、容量…）：直接在設備資料上改，記為「規格更正」。',
    staff: '能管人員到職、離職、職務異動。要同時更新名冊，請到「初始建檔 › 能管人員」修改（修改時也會自動記一筆）。',
    'measure.done': '節能措施完工（附件一／附件二的措施）。',
    'plan.change': '節能計畫內容或時程變更。',
    other: '其他需要留下紀錄的異動。',
  };

  function eqSelect(st, filter) {
    const s = el('select', {}, [el('option', { value: '', text: '（請選擇設備）' })]);
    for (const c of SPEC.equipment.categories) {
      const es = INV.equipment.filter((e) => e.category === c.id && filter(e));
      if (es.length) s.append(el('optgroup', { label: c.label }, es.map((e) => el('option', { value: e.id, text: `${eqName(e)}（${e.kind}${e.building ? `·${bName(e.building)}` : ''}）`, selected: e.id === st.eqId }))));
    }
    return s;
  }

  // 舊後端不回 linkedItems：自己從點位算
  function linkedFrom(body, eqId) {
    if (Array.isArray(body?.linkedItems)) return body.linkedItems;
    const out = [];
    for (const p of INV.points) for (const it of p.items) if (it.equipmentId === eqId) out.push({ pointCode: p.code, pointName: p.name, itemId: it.id, label: it.label });
    return out;
  }
  async function promptLinked(linked, doneText) {
    if (!linked.length) { toast(doneText, 'ok'); return; }
    const node = el('div', {}, [
      el('p', { text: `${doneText}。以下點位項目還連著它，貼紙頁會繼續顯示這台設備，請到點位移除或改連：` }),
      el('ul', {}, linked.map((x) => el('li', { text: `${x.pointCode} ${x.pointName || ''}「${x.label}」` }))),
    ]);
    const go = await confirmModal({
      title: '仍有點位項目連到這台設備',
      node,
      okText: `修改點位 ${linked[0].pointCode}`, cancelText: '稍後再說',
    });
    if (go) { UI.goSection('i-points'); openPointEditor(linked[0].pointCode); }
  }
  // 把舊設備標成已汰換；newId 有值就帶 replacedBy（後端改指點位項目、新設備承接所屬點位）
  async function finishReplace(st, newId) {
    const r = await send('PUT', `/api/inv/equipment/${enc(st.eqId)}`, { equipment: { status: 'replaced', ...(newId ? { replacedBy: newId } : {}) }, reason: String(st.reason || '').trim() });
    if (r.status !== 200 || !r.body?.ok) {
      toast(`舊設備沒有標成已汰換：${errText(r)}`, 'err');
      ui.ch = { kind: 'equipment.replace', eqId: st.eqId, reason: st.reason, follow: false, replacedBy: newId };
      await refreshAll(); draw();
      return;
    }
    const linked = linkedFrom(r.body, st.eqId);
    const moved = r.body.relinked?.items?.length || 0;
    await refreshAll();
    ui.ch = null; draw();
    await promptLinked(linked, `已登錄設備汰換${moved ? `，${moved} 個點位項目已改連新設備` : ''}`);
  }

  function changeForm(st) {
    const box = el('div', { class: 'i-panel' });
    const close = () => { ui.ch = null; draw(); touch(); };
    box.append(el('div', { class: 'i-head' }, [el('h3', { class: 'i-h3', text: '新增異動' }), el('span', { class: 'grow' }), btn('取消', close)]));
    const ks = el('select', {}, [el('option', { value: '', text: '（請選擇異動種類）' }), ...FORM_KINDS.map((k) => el('option', { value: k, text: kindLabel(k), selected: k === st.kind }))]);
    ks.addEventListener('change', () => { ui.ch = { kind: ks.value }; draw(); });
    box.append(el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '異動種類' }), ks]));
    if (!st.kind) return box;
    box.append(note(KIND_HINT[st.kind] || ''));

    const done = () => { ui.ch = null; draw(); };

    if (st.kind === 'equipment.add') {
      const cs = el('select', {}, [el('option', { value: '', text: '（請選擇設備類別）' }), ...SPEC.equipment.categories.map((c) => el('option', { value: c.id, text: c.label, selected: c.id === st.category }))]);
      cs.addEventListener('change', () => { st.category = cs.value; st.eq = cs.value ? newEqState(cs.value, 'change', { needReason: true }) : null; draw(); });
      box.append(el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '設備類別' }), cs]));
      if (st.eq) box.append(eqEditor(st.eq, { onCancel: close, onSaved: done }));
      return box;
    }

    if (st.kind === 'equipment.correct') {
      const s = eqSelect(st, (e) => e.status === 'active');
      s.addEventListener('change', () => {
        st.eqId = s.value;
        const e = eqById(s.value);
        st.eq = e ? editEqState(e, 'change', { correct: true, lockKind: true }) : null;
        draw();
      });
      box.append(el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '要更正的設備' }), s]));
      if (st.eq) box.append(eqEditor(st.eq, { onCancel: close, onSaved: done }));
      return box;
    }

    const err = errBox();
    // 汰換第二步：先建好取代它的新設備，存檔成功再把舊設備標成已汰換並帶 replacedBy（後端自動改指點位項目）
    if (st.kind === 'equipment.replace' && st.step === 'new' && st.eq) {
      const old = eqById(st.eqId);
      box.append(note(`第 2 步：建立取代「${eqName(old)}」的新設備。存檔後舊設備標成「已汰換」，連到它的點位項目自動改連新設備。`));
      box.append(eqEditor(st.eq, {
        onCancel: () => { ui.ch = { kind: 'equipment.replace', eqId: st.eqId, reason: st.reason, follow: true }; draw(); },
        onSaved: async (eq) => {
          if (!eq) { ui.ch = null; draw(); return; }
          await finishReplace(st, eq.id);
        },
      }));
      return box;
    }
    if (st.kind === 'equipment.replace' || st.kind === 'equipment.remove') {
      const s = eqSelect(st, (e) => e.status === 'active');
      s.addEventListener('change', () => { st.eqId = s.value; });
      const reason = el('textarea', { rows: 2, value: st.reason || '', placeholder: st.kind === 'equipment.replace' ? '例：CH-1 壓縮機故障，維修不符效益，汰換為變頻機' : '例：B2 舊鍋爐拆除' });
      reason.addEventListener('input', () => { st.reason = reason.value; });
      const follow = st.kind === 'equipment.replace' && !st.replacedBy ? el('input', { type: 'checkbox', checked: st.follow !== false }) : null;
      follow?.addEventListener('change', () => { st.follow = follow.checked; ok.textContent = follow.checked ? '下一步：建立新設備' : '登錄汰換'; });
      const goNew = () => st.kind === 'equipment.replace' && !st.replacedBy && st.follow !== false;
      const ok = btn(goNew() ? '下一步：建立新設備' : st.kind === 'equipment.replace' ? '登錄汰換' : '登錄移除', async () => {
        if (!st.eqId) { err.textContent = '請選擇設備'; return; }
        if (!String(st.reason || '').trim()) { err.textContent = '原因必填'; reason.focus(); return; }
        err.textContent = '';
        const old = eqById(st.eqId);
        if (goNew() && old) {
          const fields = clone(old.fields || {});
          delete fields.madeYear;
          ui.ch = { kind: 'equipment.replace', step: 'new', eqId: st.eqId, reason: st.reason.trim(), eq: newEqState(old.category, 'change', {
            needReason: true, reason: `汰換「${eqName(old)}」：${st.reason.trim()}`,
            draft: { kind: old.kind, building: old.building ?? null, pointCode: old.pointCode ?? null, fields },
          }) };
          draw();
          return;
        }
        ok.disabled = true;
        if (st.kind === 'equipment.replace') { await finishReplace(st, st.replacedBy || null); ok.disabled = false; return; }
        const r = await send('PUT', `/api/inv/equipment/${enc(st.eqId)}`, { equipment: { status: 'removed' }, reason: st.reason.trim() });
        ok.disabled = false;
        if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
        const linked = linkedFrom(r.body, st.eqId);
        await refreshAll();
        ui.ch = null; draw();
        await promptLinked(linked, '已登錄設備移除');
      }, 'primary');
      put(box,
        st.replacedBy ? el('p', { class: 'i-err', text: '新設備已建立，但舊設備還沒標成已汰換。請按「登錄汰換」再試一次（會帶上新設備，自動改指點位項目）。' }) : null,
        el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '設備（只列使用中）' }), s]),
        el('label', { class: 'i-reason' }, [el('span', { text: '原因（必填）' }), reason]),
        follow ? el('label', { class: 'chk' }, [follow, el('span', { text: '接著建立取代它的新設備（帶入原設備資料，製造年份要重填）；連到舊設備的點位項目會自動改連新設備' })]) : null,
        err, el('div', { class: 'i-tools' }, [ok, btn('取消', close)]),
      );
      return box;
    }

    // 人員異動、措施完工、計畫變更、其他：直接寫一筆 changes
    const sugg = st.kind === 'staff' ? (INV.site.staff || []).map((s) => s.name).filter(Boolean)
      : st.kind === 'measure.done' ? (INV.measures || []).map((m) => m.name || m.title || m.id).filter(Boolean)
        : st.kind === 'plan.change' ? (INV.plans || []).map((m) => m.name || m.title || m.id).filter(Boolean) : [];
    const dl = el('datalist', { id: 'i-chg-sugg' }, sugg.map((v) => el('option', { value: String(v) })));
    const tgt = el('input', { type: 'text', value: st.target || '', placeholder: st.kind === 'staff' ? '例：能管人員 王大明' : st.kind === 'measure.done' ? '例：行政大樓 LED 汰換' : '例：115 年節能計畫 第 3 項' });
    tgt.setAttribute('list', 'i-chg-sugg');
    tgt.addEventListener('input', () => { st.target = tgt.value; });
    const bf = el('input', { type: 'text', value: st.before || '', placeholder: st.kind === 'staff' ? '例：工務室 技士' : '例：施工中' });
    bf.addEventListener('input', () => { st.before = bf.value; });
    const af = el('input', { type: 'text', value: st.after || '', placeholder: st.kind === 'staff' ? '例：工務室 技正' : '例：2026-09-30 完工' });
    af.addEventListener('input', () => { st.after = af.value; });
    const reason = el('textarea', { rows: 2, value: st.reason || '', placeholder: '例：職務異動；驗收完成' });
    reason.addEventListener('input', () => { st.reason = reason.value; });
    const ok = btn('登錄異動', async () => {
      if (!String(st.reason || '').trim()) { err.textContent = '原因必填'; reason.focus(); return; }
      ok.disabled = true; err.textContent = '';
      const t = (v) => (String(v || '').trim() ? String(v).trim() : undefined);
      const r = await send('POST', '/api/inv/changes', { change: { kind: st.kind, target: t(st.target), before: t(st.before), after: t(st.after), reason: st.reason.trim() } });
      ok.disabled = false;
      if (r.status !== 200 || !r.body?.ok) { err.textContent = errText(r); return; }
      toast('已登錄異動', 'ok');
      ui.ch = null; await refreshAll(); draw();
    }, 'primary');
    put(box,
      el('div', { class: 'i-chgform' }, [
        el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '異動對象' }), tgt, dl]),
        el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '異動前' }), bf]),
        el('label', { class: 'i-cell' }, [el('span', { class: 'i-cellh', text: '異動後' }), af]),
      ]),
      el('label', { class: 'i-reason' }, [el('span', { text: '原因（必填）' }), reason]),
      st.kind === 'staff' ? el('div', { class: 'i-tools' }, [btn('前往 初始建檔 › 能管人員', () => UI.goSection('i-site-staff'), 'i-mini')]) : null,
      err, el('div', { class: 'i-tools' }, [ok, btn('取消', close)]),
    );
    return box;
  }

  // ════════════════════════ 申報與報告（由 inventory-report.js 掛載） ════════════════════════
  function drawReport(root) {
    const R = window.EMSInventoryReportUI;
    if (R && typeof R.mount === 'function') {
      // 操作人欄在 draw() 已放在頂部；報表畫面掛在下面的容器（它 render 時會清空自己的容器）
      try {
        R.mount(root, {
          el, api, toast, confirmModal, sourceChip: srcChip, compute: C, reporter,
          spec: SPEC, inventory: () => INV, hid: HID, hospitalName: HNAME, baseUrl: BASE, period: PERIOD,
          reload: async () => { await refreshAll(); return INV; },
          goSection: (id) => UI.goSection(id),
        });
      } catch (e) {
        root.textContent = '';
        root.append(el('div', { class: 'i-err', text: `申報與報告畫面載入失敗：${e.message || e}` }));
      }
      return;
    }
    root.append(el('div', { class: 'i-head' }, [el('h2', { text: '申報與報告' })]));
    root.append(el('div', { class: 'i-panel i-building' }, [
      el('b', { text: '建置中' }),
      note('附表三年度申報、節能診斷報告（附件一）、節能計畫（附件二）的產出畫面正在建置。資料先在「初始建檔」「點位與進度」「異動登錄」累積，完成後可直接產出。'),
    ]));
  }

  // ════════════════════════ 繪製入口 ════════════════════════
  function draw() {
    const sec = CURSEC, outer = ROOT;
    if (!sec || !outer || !INV) return;
    const tk = ++drawToken;
    // 頂部固定放「操作人」；各畫面畫在下面的容器（非同步載入時只清自己的容器，不會把操作人欄清掉）
    outer.textContent = '';
    const root = el('div');
    outer.append(operatorBar(), root);
    switch (sec.inv) {
      case 'points': drawPoints(root, tk); break;
      case 'overview': drawOverview(root); break;
      case 'site': drawSite(root, sec.block); break;
      case 'equipment': drawEquipment(root, sec.cat); break;
      case 'changes': drawChanges(root, tk); break;
      case 'report': drawReport(root); break;
      default: root.append(note('此分區無內容。'));
    }
  }

  // ════════════════════════ 對外 ════════════════════════
  window.EMSInventory = {
    tasks: TASKS,
    // /api/inv/spec 拿不到（舊版後端、權限問題）就回 false，app.js 會維持原本的導覽
    async load() {
      try {
        const s = await api('/api/inv/spec');
        if (s.status !== 200 || !s.body?.ok || !s.body.spec?.site) { SPEC = null; return false; }
        SPEC = s.body.spec; BASE = s.body.baseUrl || '';
        KINDS = SPEC.changeKinds || {};
        const ok = await reloadInv();
        if (!ok) SPEC = null;
        PROGRESS = null; CHANGES = null;
        return ok;
      } catch { SPEC = null; return false; }
    },
    available: () => !!(SPEC && INV),
    onChange(fn) { notify = fn || (() => {}); },
    sections() {
      if (!SPEC || !INV) return [];
      const S = [];
      const act = INV.points.filter((p) => p.active !== false);
      const done = new Set(INV.records.filter((r) => r.period === PERIOD).map((r) => r.pointCode));
      const anoms = INV.records.reduce((n, r) => n + (r.anomalies || []).filter((a) => !a.closedAt).length, 0);
      S.push({ id: 'i-points', task: 'inv-points', label: TASKS['inv-points'], solo: true, inv: 'points',
        badge: anoms ? { text: `異常 ${anoms}`, kind: 'todo' } : act.length ? { text: `${act.filter((p) => done.has(p.code)).length}/${act.length}`, kind: 'ok' } : null });
      S.push({ id: 'i-site', task: 'inv-site', group: '', label: '建檔總覽', inv: 'overview' });
      for (const b of SPEC.site) {
        const v = INV.site[b.id];
        S.push({ id: `i-site-${b.id}`, task: 'inv-site', group: b.navGroup || '基本資料（附表三）', label: b.label, inv: 'site', block: b.id,
          badge: isEmpty(v) ? null : { text: b.kind === 'table' ? `${v.length} 筆` : '已建', kind: 'ok' } });
      }
      for (const c of SPEC.equipment.categories) {
        const n = INV.equipment.filter((e) => e.category === c.id && e.status === 'active').length;
        S.push({ id: `i-eq-${c.id}`, task: 'inv-site', group: '設備主檔（表九）', label: c.label, inv: 'equipment', cat: c.id, badge: n ? { text: `${n} 筆`, kind: 'ok' } : null });
      }
      S.push({ id: 'i-changes', task: 'inv-changes', label: TASKS['inv-changes'], solo: true, inv: 'changes' });
      S.push({ id: 'i-report', task: 'inv-report', label: TASKS['inv-report'], solo: true, inv: 'report' });
      return S;
    },
    render(sec, root) {
      // 換到別的分區時，上一個分區的「查看設備」狀態不留（編輯中的草稿仍保留，dirtyCount 會提示）
      if (CURSEC && CURSEC.id !== sec.id && ui.eq?.mode === 'view') ui.eq = null;
      CURSEC = sec; ROOT = root;
      draw();
    },
    dirtyCount() {
      let n = 0;
      for (const st of Object.values(ui.site)) if (!same(st.draft, st.base)) n++;
      if (ui.eq && ui.eq.mode !== 'view' && !same(ui.eq.draft, ui.eq.base)) n++;
      if (ui.point && !same(ui.point.draft, ui.point.base)) n++;
      if (ui.ch?.eq && ui.ch.eq.mode !== 'view' && !same(ui.ch.eq.draft, ui.ch.eq.base)) n++;
      return n;
    },
    discard() { ui.site = {}; ui.eq = null; ui.point = null; ui.ch = null; ui.closing = null; },
    sourceChip: srcChip,
  };
})();
