// 貼紙點位頁（/s/<代碼>）：手機掃貼紙 → 這一次的紀錄表。
//
// 只記「這一次會變的東西」：讀數、設備狀態、電費單、照片、備註。
// 設備型號、容量、年份在管理端建一次，這裡只顯示設備名稱（業主確認的雛形）。
// 表單完全依 point.items 長出來；新增點位或改項目不需要改這支。
//
// 後端判準才算數（src/inventory-routes.js）：
//   422 validation／reading_decreased、409 unverified（電費單沒逐格確認）、422 photo_missing。
// 這裡的前端檢查只是讓人少跑一趟，伺服器回什麼就照實顯示。
(function () {
  'use strict';

  const CALC = globalThis.EMSInventoryCompute || null;
  const ANOMALY = '異常';
  const ANOMALY_NOTE = '設備回報異常時請在備註寫明狀況';
  const REPORTER_KEY = 'ems.sticker.reporter';
  const REPORTER_MAX = 20;
  // 填寫人姓名記在這支手機：localStorage 可能被擋（無痕、清除網站資料），讀寫失敗就當沒記
  const loadReporter = () => { try { return localStorage.getItem(REPORTER_KEY) || ''; } catch { return ''; } };
  const saveReporter = (v) => { try { if (v) localStorage.setItem(REPORTER_KEY, v); else localStorage.removeItem(REPORTER_KEY); } catch { /* 存不了就下次再填 */ } };
  const DOMAIN = { power: { label: '電力資源盤點', cls: '' }, water: { label: '水足跡盤查', cls: 'water' } };

  const code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  const $root = document.getElementById('sRoot');
  const $org = document.getElementById('sOrg');
  const $domain = document.getElementById('sDomain');
  const $foot = document.getElementById('sFoot');

  // ── 小工具 ──
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && typeof v !== 'string') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids || [])) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  const fmtNum = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const [i, f] = String(Math.round(v * 1000) / 1000).split('.');
    return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
  };
  // 台灣時間 MM/DD HH:mm（伺服器存 ISO UTC）
  const twParts = (iso) => {
    const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return { y: d.getUTCFullYear(), mo: p(d.getUTCMonth() + 1), d: p(d.getUTCDate()), h: p(d.getUTCHours()), mi: p(d.getUTCMinutes()) };
  };
  const fmtAt = (iso) => { const t = twParts(iso); return t ? `${t.mo}/${t.d} ${t.h}:${t.mi}` : ''; };
  const fmtDay = (iso) => { const t = twParts(iso); return t ? `${t.mo}/${t.d}` : ''; };
  const fmtPeriod = (p) => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m ? `${m[1]} 年 ${Number(m[2])} 月` : (p || ''); };
  // 數字欄：清掉千分位與空白再轉；清完沒有數字就回 NaN（絕不能讓空字串變成 0）
  const parseNum = (raw) => {
    const s = String(raw ?? '').replace(/[,\s，]/g, '');
    if (s === '') return undefined;
    if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.?$/.test(s)) return NaN;
    return Number(s);
  };

  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
      delete init.json;
    }
    let r;
    try { r = await fetch(path, init); }
    catch { return { status: 0, body: { error: 'network', message: '連不上伺服器，請確認網路後再試一次。' } }; }
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  }

  // ── 狀態 ──
  const S = {
    data: null,          // GET /api/inv/point/:code 的回應
    me: null,
    billCols: null,      // 電費單欄位（GET /api/inv/point/:code 的 billColumns）
    values: {},          // itemId → 輸入中的原始值（reading/number/text：字串；status：選項）
    bills: {},           // itemId → { values, meta }
    photos: {},          // itemId → [photo]（photo 型）
    extra: {},           // itemId → [photo]：讀數旁「拍表面」、電費單原檔。跟著紀錄存（body.photos），不屬於某個項目的值
    note: '',
    reporter: loadReporter(),   // 填寫人姓名（帳號一院一組，紀錄只看得到院名）
    confirm: new Set(),  // 已勾「確認換表或歸零」的 reading itemId
    decreased: {},       // itemId → 伺服器回的 reading_decreased 明細
    errs: {},            // itemId → [訊息]
    pending: {},         // itemId → Set(欄位 key)：伺服器 409 回來的未確認格子
    busy: false,
  };
  const refs = {};       // itemId → { cell, update() }

  function resetForm() {
    Object.assign(S, { values: {}, bills: {}, photos: {}, extra: {}, note: '', confirm: new Set(), decreased: {}, errs: {}, pending: {} });
  }

  function setHeader() {
    const d = S.data;
    $org.textContent = d ? d.hospitalName : '點位紀錄';
    const dom = d && DOMAIN[d.point.domain];
    $domain.classList.toggle('hidden', !dom);
    if (dom) { $domain.textContent = dom.label; $domain.className = 's-domain ' + dom.cls; }
    document.title = d ? `${d.point.name}｜點位紀錄` : '點位紀錄';
  }
  function setFoot() {
    $foot.replaceChildren();
    if (S.data?.source?.text) $foot.append(el('p', { class: 's-src', text: S.data.source.text }));
  }

  // ── 載入 ──
  async function load(keep) {
    if (!code) return showError('bad_code', '網址裡沒有點位代碼。請重新掃描貼紙。');
    const { status, body } = await api('/api/inv/point/' + encodeURIComponent(code));
    if (status === 401) return showLogin();
    if (status !== 200) return showError(body.error || status, body.message, status);
    S.data = body;
    if (!keep) resetForm();
    if (!S.me) api('/api/me').then(({ status: st, body: b }) => { if (st === 200) { S.me = b; renderAccount(); } });
    S.billCols = (body.billColumns || []).filter((c) => !c.computed);
    setHeader(); setFoot();
    renderForm();
  }

  // ── 登入 ──
  function showLogin(msg) {
    S.data = null; setHeader(); setFoot();
    const err = el('p', { class: 's-err', role: 'alert', text: msg || '' });
    const user = el('input', { id: 'sUser', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
    const pass = el('input', { id: 'sPass', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const remember = el('input', { id: 'sRemember', type: 'checkbox', checked: true });
    const btn = el('button', { type: 'submit', class: 's-btn', text: '登入' });
    const form = el('form', { class: 's-login', novalidate: true }, [
      el('h1', { class: 's-title', text: '請先登入' }),
      el('p', { class: 's-muted', text: code ? `登入後會回到這張貼紙（${code}）。` : '登入後會回到這張貼紙。' }),
      el('div', { class: 's-field' }, [el('label', { for: 'sUser', text: '帳號' }), user]),
      el('div', { class: 's-field' }, [el('label', { for: 'sPass', text: '密碼' }), pass]),
      el('label', { class: 's-check', for: 'sRemember' }, [remember, el('span', { text: '這支手機記住 30 天' })]),
      el('p', { class: 's-hint', text: '共用或借來的手機請取消勾選。' }),
      err, btn,
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!user.value.trim() || !pass.value) { err.textContent = '請輸入帳號和密碼'; return; }
      btn.disabled = true; btn.textContent = '登入中…'; err.textContent = '';
      const { status, body } = await api('/api/login', { json: { username: user.value.trim(), password: pass.value, remember: remember.checked } });
      btn.disabled = false; btn.textContent = '登入';
      if (status === 200) { S.me = null; return load(true); }
      if (body.error === 'locked') err.textContent = `嘗試次數過多，請 ${Math.max(1, Math.ceil((body.retryMs || 60000) / 60000))} 分鐘後再試`;
      else if (status === 0) err.textContent = body.message;
      else if (status === 403) err.textContent = '這個網址不能登入（來源檢查未通過），請直接重新掃描貼紙。';
      else err.textContent = '帳號或密碼錯誤';
      pass.select();
    });
    $root.replaceChildren(form);
    user.focus();
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    S.me = null;
    showLogin('已登出。');
  }

  // ── 錯誤畫面（403／410／400／404） ──
  function showError(kind, message, status) {
    S.data = null; setHeader(); setFoot();
    let title = '無法開啟這個點位', text = message || '請稍後再試，或聯絡能管人員。', actions = [];
    if (kind === 'forbidden_hospital') {
      title = '這張貼紙屬於別的院所';
      text = `貼紙代碼 ${code} 不是您目前登入院所的點位。若您是該院人員，請登出後改用該院帳號登入。`;
      actions.push(el('button', { type: 'button', class: 's-btn', text: '登出，改用其他帳號', onclick: logout }));
    } else if (kind === 'point_inactive') {
      title = '這個點位已停用';
      text = '這張貼紙對應的點位已經停用，不需要再填寫。若現場設備仍在使用，請通知能管人員更新點位。';
    } else if (kind === 'bad_code') {
      title = '貼紙代碼看不懂';
      text = `${code ? `「${code}」` : '這個網址'}不是有效的點位代碼（應為 803-E07 這種格式）。請重新掃描，或確認網址完整。`;
    } else if (kind === 'point_not_found') {
      title = '查無這個點位';
      text = `${code} 還沒有建在系統裡，或已被刪除。請聯絡能管人員確認貼紙。`;
    } else if (kind === 'network' || status === 0) {
      title = '連不上伺服器';
      actions.push(el('button', { type: 'button', class: 's-btn', text: '再試一次', onclick: () => load() }));
    } else {
      actions.push(el('button', { type: 'button', class: 's-btn ghost', text: '重新載入', onclick: () => load() }));
    }
    $root.replaceChildren(el('section', { class: 's-msg', role: 'alert' }, [
      el('h1', { class: 's-title', text: title }),
      el('p', { text }),
      code ? el('p', { class: 's-code', text: `貼紙代碼：${code}` }) : null,
      ...actions,
    ]));
    renderAccount();
  }

  function renderAccount() {
    $root.querySelector('.s-account')?.remove();
    if (!S.me || !S.me.username) return;
    $root.append(el('p', { class: 's-account' }, [
      el('span', { text: `登入帳號：${S.me.username}` }),
      el('button', { type: 'button', class: 's-linkbtn', text: '登出', onclick: logout }),
    ]));
  }

  // ════════════════════════════════════════════════════════════════
  // 表單
  // ════════════════════════════════════════════════════════════════
  const anyAnomaly = () => S.data.point.items.some((it) => it.type === 'status' && S.values[it.id] === ANOMALY);
  const itemName = (it) => it.equipmentName || it.label;
  // 舊紀錄沒有 reporter，退回 who（院名）
  const byName = (r) => (r && (r.reporter || r.who)) || '';

  function renderForm() {
    const d = S.data;
    const p = d.point;
    for (const k of Object.keys(refs)) delete refs[k];

    const meterNos = [...new Set(p.items.map((i) => i.meterNo).filter(Boolean))];
    const card = el('div', { class: 's-point' }, [
      el('span', { class: 's-pname', text: p.name }),
      meterNos.length ? el('span', { class: 's-pmeter', text: `電號 ${meterNos.join('、')}` }) : null,
      el('span', { class: 's-pmeta', text: [p.location, d.lastRecord ? `上次紀錄 ${fmtDay(d.lastRecord.at)} · ${byName(d.lastRecord)}` : '尚無紀錄'].filter(Boolean).join(' · ') }),
    ]);

    const banner = d.recordedThisPeriod && d.lastRecord
      ? el('div', { class: 's-callout info' }, [
        el('b', { text: `${fmtPeriod(d.period)}已記錄過` }),
        el('span', { text: `上次是 ${byName(d.lastRecord)} 在 ${fmtAt(d.lastRecord.at)} 記的。需要補記或更正時可以再記一筆，舊的那筆會保留。` }),
      ])
      : null;

    const topErr = el('div', { class: 's-callout bad hidden', id: 'sTopErr', role: 'alert' });

    // 連續的設備狀態項目（有連結設備的）合成一格「設備狀態」，一列一台
    const blocks = [];
    let group = null;
    for (const it of p.items) {
      if (it.type === 'status' && it.equipmentName) {
        if (!group) { group = { kind: 'statusGroup', items: [] }; blocks.push(group); }
        group.items.push(it);
      } else { group = null; blocks.push({ kind: 'item', item: it }); }
    }
    const cells = blocks.map((b) => (b.kind === 'statusGroup' ? statusGroupCell(b.items) : itemCell(b.item)));

    const noteLabel = el('label', { for: 'sNote', id: 'sNoteLabel' });
    const note = el('textarea', { id: 'sNote', rows: 3, maxlength: 2000, value: S.note });
    const noteErr = el('p', { class: 's-ferr', id: 'sNoteErr' });
    note.addEventListener('input', () => {
      S.note = note.value; noteErr.textContent = ''; noteField.classList.remove('s-invalid');
      // 寫了備註，各台「請寫明狀況」的錯就解除（其他錯留著）
      for (const [id, m] of Object.entries(S.errs)) if (m.includes(ANOMALY_NOTE)) setErr(id, m.filter((x) => x !== ANOMALY_NOTE));
    });
    const noteField = el('div', { class: 's-field', id: 'sNoteField' }, [noteLabel, note, noteErr]);

    const repInp = el('input', { id: 'sReporter', name: 'name', autocomplete: 'name', maxlength: REPORTER_MAX, enterkeyhint: 'done', placeholder: '例：王小明', value: S.reporter });
    const repErr = el('p', { class: 's-ferr', id: 'sReporterErr' });
    const repField = el('div', { class: 's-field', id: 'sReporterField' }, [
      el('label', { for: 'sReporter', text: '填寫人' }), repInp,
      el('p', { class: 's-hint', text: '帳號是全院共用，紀錄上要靠這格才看得出是誰填的。這支手機會記住，下次自動帶入。' }),
      repErr,
    ]);
    repInp.addEventListener('input', () => { S.reporter = repInp.value; repErr.textContent = ''; repField.classList.remove('s-invalid'); });

    const submitHint = el('p', { class: 's-hint', id: 'sSubmitHint' });
    const submit = el('button', { type: 'submit', class: 's-btn', id: 'sSubmit', text: '送出' });

    const form = el('form', { class: 's-form', novalidate: true }, [card, banner, topErr, ...cells, noteField, repField, submitHint, submit]);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    $root.replaceChildren(form);
    updateNote(); updateSubmit();
    renderAccount();
  }

  function updateNote() {
    const label = document.getElementById('sNoteLabel');
    const field = document.getElementById('sNoteField');
    if (!label) return;
    const bad = anyAnomaly();
    label.textContent = bad ? '異常說明（必填）：哪台、什麼狀況、通知了誰' : '備註（有異常才需要寫）';
    field.classList.toggle('s-noteneed', bad);
  }

  function pendingCount() {
    let n = 0;
    for (const b of Object.values(S.bills)) for (const m of Object.values(b.meta || {})) if (m && (m.state === 'todo' || m.state === 'low')) n++;
    return n;
  }
  function updateSubmit() {
    const btn = document.getElementById('sSubmit');
    const hint = document.getElementById('sSubmitHint');
    if (!btn) return;
    const n = pendingCount();
    btn.disabled = S.busy || n > 0;
    btn.textContent = S.busy ? '送出中…' : '送出';
    hint.textContent = n > 0 ? `電費單還有 ${n} 格沒確認，逐格看過、按「這格沒問題」後才能送出。` : '';
    hint.classList.toggle('s-warntext', n > 0);
  }

  // 欄位層級的錯誤（前端檢查＋伺服器回來的）
  function setErr(itemId, msgs) {
    if (msgs && msgs.length) S.errs[itemId] = msgs; else delete S.errs[itemId];
    refs[itemId]?.showErr();
  }
  function errBox(itemId) {
    const box = el('p', { class: 's-ferr' });
    const show = () => {
      const m = S.errs[itemId];
      box.textContent = m ? m.join('；') : '';
      box.closest('.s-cell, .s-srow')?.classList.toggle('s-invalid', !!m);
    };
    return { box, show };
  }

  function itemCell(it) {
    switch (it.type) {
      case 'reading': return readingCell(it);
      case 'status': return statusSingleCell(it);
      case 'bill': return billCell(it);
      case 'number': return numberCell(it);
      case 'text': return textCell(it);
      case 'photo': return photoCell(it);
      default: return el('div', { class: 's-cell' }, [el('p', { class: 's-muted', text: `「${it.label}」的項目類型（${it.type}）這一版還不支援，請聯絡維護窗口。` })]);
    }
  }

  const head = (it, extra) => el('div', { class: 's-chead' }, [
    el('span', { text: it.label + (it.unit ? `（${it.unit}）` : '') }),
    it.required ? el('em', { class: 's-req', text: '必填' }) : null,
    extra || null,
  ]);

  // ── reading：數字鍵盤、上次值、即時用量、超過 warnPct 提示、倒退確認 ──
  function readingCell(it) {
    const id = 'i-' + it.id;
    const last = it.last && typeof it.last.value === 'number' ? it.last : null;
    const inp = el('input', { id, class: 's-num', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '看表上的數字輸入', value: S.values[it.id] ?? '' });
    const prev = el('div', { class: 's-calc' }, last
      ? [el('span', { text: '上次 ' }), el('b', { text: fmtNum(last.value) }), el('span', { text: ` · ${fmtDay(last.at)}${typeof last.usage === 'number' ? `（當次用量 ${fmtNum(last.usage)}${it.unit ? ' ' + it.unit : ''}）` : ''}` })]
      : [el('span', { text: '第一次抄這個表，下次起自動算用量' })]);
    const live = el('div', { class: 's-live', 'aria-live': 'polite' });
    const dec = el('div', { class: 's-decrease hidden' });
    const { box: err, show: showErr } = errBox(it.id);
    const shots = (S.extra[it.id] ||= []);
    const photos = photoStrip(shots);
    const cam = cameraButton('📷 拍表面留存', async (file, ui) => {
      const ph = await upload(file, null, ui);
      if (ph) { shots.push(ph.photo); photos.refresh(); }
    });
    const cell = el('div', { class: 's-cell', 'data-item': it.id }, [
      el('label', { class: 's-chead', for: id }, [el('span', { text: it.label + (it.unit ? `（${it.unit}）` : '') }), it.required ? el('em', { class: 's-req', text: '必填' }) : null]),
      inp, prev, live, dec, err, el('div', { class: 's-row' }, [cam.node]), photos.node,
    ]);

    function update() {
      const raw = S.values[it.id] ?? '';
      const n = parseNum(raw);
      live.replaceChildren(); live.className = 's-live';
      cell.classList.remove('s-warncell');
      let decInfo = S.decreased[it.id] || null;
      if (n === undefined) { /* 還沒填 */ }
      else if (Number.isNaN(n)) { live.textContent = '只能輸入數字'; live.classList.add('bad'); }
      else if (last && CALC) {
        const r = CALC.readingUsage(n, last.value, { prevUsage: typeof last.usage === 'number' ? last.usage : undefined, warnPct: it.warnPct, unit: it.unit });
        if (r.needsConfirm) {
          decInfo = decInfo && decInfo.value === n ? decInfo : { prev: last.value, prevAt: last.at, value: n };
        } else {
          if (S.decreased[it.id]) { delete S.decreased[it.id]; decInfo = null; }
          live.append(el('span', { text: '本次用量 ' }), el('b', { text: `${fmtNum(r.value)}${it.unit ? ' ' + it.unit : ''}` }));
          if (r.level === 'warn') {
            live.append(el('span', { class: 's-warnmsg', text: `跟上次差很多：${r.msg.replace(/^本次用量 [^，]+，/, '')}。讀數沒抄錯的話照樣可以送出。` }));
            cell.classList.add('s-warncell');
          }
        }
      } else if (last) {
        if (n < last.value) decInfo = decInfo || { prev: last.value, prevAt: last.at, value: n };
        else live.append(el('span', { text: '本次用量 ' }), el('b', { text: `${fmtNum(n - last.value)}${it.unit ? ' ' + it.unit : ''}` }));
      }
      renderDecrease(decInfo);
    }
    function renderDecrease(info) {
      dec.replaceChildren();
      dec.classList.toggle('hidden', !info);
      cell.classList.toggle('s-badcell', !!info && !S.confirm.has(it.id));
      if (!info) { S.confirm.delete(it.id); return; }
      const cb = el('input', { type: 'checkbox', id: id + '-ok', checked: S.confirm.has(it.id) });
      cb.addEventListener('change', () => {
        if (cb.checked) S.confirm.add(it.id); else S.confirm.delete(it.id);
        cell.classList.toggle('s-badcell', !cb.checked);
      });
      dec.append(
        el('p', {}, [
          el('b', { text: `本次 ${fmtNum(info.value)} 比上次 ${fmtNum(info.prev)} 還小` }),
          el('span', { text: `（上次 ${fmtAt(info.prevAt)}）。先對一下有沒有抄錯位數；確定是換新表或表歸零，才勾下面這格。` }),
        ]),
        el('label', { class: 's-check', for: id + '-ok' }, [cb, el('span', { text: '確認換表或歸零（本次不計用量）' })]),
      );
    }
    inp.addEventListener('input', () => { S.values[it.id] = inp.value; setErr(it.id, null); update(); });
    refs[it.id] = { cell, update, showErr };
    update(); showErr();
    return cell;
  }

  // ── status：按鈕組，「異常」用警示色 ──
  function chips(it, onPick) {
    const opts = it.options || ['正常', ANOMALY, '停機'];
    const wrap = el('div', { class: 's-chips', role: 'group', 'aria-label': itemName(it) });
    const btns = opts.map((o) => el('button', {
      type: 'button', class: 's-chip' + (o === ANOMALY ? ' bad' : ''), 'aria-pressed': S.values[it.id] === o ? 'true' : 'false', text: o,
      onclick: () => {
        // 再點一次同一個選項＝取消選擇（點錯時不用整頁重來）
        S.values[it.id] = S.values[it.id] === o ? undefined : o;
        for (const b of btns) b.setAttribute('aria-pressed', S.values[it.id] === b.textContent ? 'true' : 'false');
        setErr(it.id, null);
        updateNote();
        onPick?.();
      },
    }));
    wrap.append(...btns);
    return wrap;
  }
  const lastStatus = (it) => (it.last && typeof it.last.value === 'string' ? el('span', { class: 's-last' + (it.last.value === ANOMALY ? ' bad' : ''), text: `上次 ${it.last.value}` }) : null);

  function statusGroupCell(items) {
    const rows = items.map((it) => {
      const { box, show } = errBox(it.id);
      const row = el('div', { class: 's-srow', 'data-item': it.id }, [
        el('div', { class: 's-sname' }, [el('span', { text: itemName(it) }), it.required ? el('em', { class: 's-req', text: '必填' }) : null, lastStatus(it)]),
        chips(it), box,
      ]);
      refs[it.id] = { cell: row, showErr: show };
      show();
      return row;
    });
    const label = items.every((i) => i.label === items[0].label) ? items[0].label : '設備狀態';
    const opts0 = items[0].options || [];
    // 多台設備時給一顆「其餘都正常」：只補還沒選的，已選的（包括異常）不動
    const allOk = items.length > 1 && opts0[0] && items.every((i) => (i.options || [])[0] === opts0[0])
      ? el('button', {
        type: 'button', class: 's-linkbtn', text: `其餘都${opts0[0]}`,
        onclick: () => {
          for (const it of items) if (S.values[it.id] === undefined) S.values[it.id] = opts0[0];
          for (const row of rows) for (const b of row.querySelectorAll('.s-chip')) b.setAttribute('aria-pressed', S.values[row.dataset.item] === b.textContent ? 'true' : 'false');
          updateNote();
        },
      })
      : null;
    return el('div', { class: 's-cell' }, [el('div', { class: 's-chead' }, [el('span', { text: label }), allOk]), ...rows]);
  }

  function statusSingleCell(it) {
    const { box, show } = errBox(it.id);
    const cell = el('div', { class: 's-cell', 'data-item': it.id }, [
      el('div', { class: 's-chead' }, [el('span', { text: itemName(it) }), it.required ? el('em', { class: 's-req', text: '必填' }) : null, lastStatus(it)]),
      chips(it), box,
    ]);
    refs[it.id] = { cell, showErr: show };
    show();
    return cell;
  }

  // ── number／text ──
  function numberCell(it) {
    const id = 'i-' + it.id;
    const inp = el('input', { id, class: 's-num', inputmode: 'decimal', autocomplete: 'off', value: S.values[it.id] ?? '' });
    const { box, show } = errBox(it.id);
    const lastV = it.last && typeof it.last.value === 'number' ? el('div', { class: 's-calc', text: `上次 ${fmtNum(it.last.value)}${it.unit ? ' ' + it.unit : ''} · ${fmtDay(it.last.at)}` }) : null;
    inp.addEventListener('input', () => {
      S.values[it.id] = inp.value;
      setErr(it.id, Number.isNaN(parseNum(inp.value)) ? ['只能輸入數字'] : null);
    });
    const cell = el('div', { class: 's-cell', 'data-item': it.id }, [
      el('label', { class: 's-chead', for: id }, [el('span', { text: it.label + (it.unit ? `（${it.unit}）` : '') }), it.required ? el('em', { class: 's-req', text: '必填' }) : null]),
      inp, lastV, box,
    ]);
    refs[it.id] = { cell, showErr: show };
    show();
    return cell;
  }

  function textCell(it) {
    const id = 'i-' + it.id;
    const ta = el('textarea', { id, rows: 2, maxlength: 2000, value: S.values[it.id] ?? '' });
    const { box, show } = errBox(it.id);
    ta.addEventListener('input', () => { S.values[it.id] = ta.value; setErr(it.id, null); });
    const cell = el('div', { class: 's-cell', 'data-item': it.id }, [
      el('label', { class: 's-chead', for: id }, [el('span', { text: it.label }), it.required ? el('em', { class: 's-req', text: '必填' }) : null]),
      ta, box,
    ]);
    refs[it.id] = { cell, showErr: show };
    show();
    return cell;
  }

  // ── 照片：拍照上傳（capture=environment 直接開後鏡頭） ──
  function cameraButton(text, onFile, { capture = true, accept = 'image/*', cls = 's-chip' } = {}) {
    const input = el('input', { type: 'file', accept, class: 's-file' });
    if (capture) input.setAttribute('capture', 'environment');
    const label = el('span', { text });
    const btn = el('label', { class: cls + ' s-filebtn' }, [input, label]);
    const status = el('span', { class: 's-upmsg', 'aria-live': 'polite' });
    const ui = { node: el('span', { class: 's-upwrap' }, [btn, status]), status, btn };
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (f) await onFile(f, ui);
    });
    return ui;
  }

  async function upload(file, itemId, ui) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'photo.jpg');
    if (itemId) fd.append('itemId', itemId);
    ui.btn.classList.add('busy');
    ui.status.className = 's-upmsg';
    ui.status.textContent = '上傳中…';
    const { status, body } = await api(`/api/inv/point/${encodeURIComponent(code)}/photo`, { method: 'POST', body: fd });
    ui.btn.classList.remove('busy');
    if (status === 401) { ui.status.textContent = ''; showLogin('登入已逾時，請重新登入；剛剛填的內容會保留。'); return null; }
    if (status !== 200) {
      ui.status.classList.add('bad');
      ui.status.textContent = status === 413 ? '檔案太大，請改拍一張或壓縮後再上傳' : status === 415 ? '只接受 JPG／PNG／WebP 照片或 PDF' : (body.message || `上傳失敗（${body.error || status}）`);
      return null;
    }
    ui.status.textContent = '已上傳';
    return body;
  }

  function photoStrip(list, onChange) {
    const node = el('div', { class: 's-thumbs' });
    const refresh = () => {
      node.replaceChildren(...list.map((ph, i) => el('span', { class: 's-thumb' }, [
        ph.mime === 'application/pdf'
          ? el('span', { class: 's-pdf', text: 'PDF' })
          : el('img', { src: `/api/inv/photo/${encodeURIComponent(ph.id)}`, alt: '已上傳的照片', loading: 'lazy' }),
        el('button', { type: 'button', class: 's-thumbx', 'aria-label': '移除這張照片', text: '×', onclick: () => { list.splice(i, 1); refresh(); onChange?.(); } }),
      ])));
    };
    refresh();
    return { node, refresh };
  }

  function photoCell(it) {
    S.photos[it.id] ||= [];
    const { box, show } = errBox(it.id);
    const strip = photoStrip(S.photos[it.id]);
    const cam = cameraButton('📷 拍照', async (file, ui) => {
      const ph = await upload(file, it.id, ui);
      if (ph) { S.photos[it.id].push(ph.photo); strip.refresh(); setErr(it.id, null); }
    });
    const cell = el('div', { class: 's-cell', 'data-item': it.id }, [head(it), el('div', { class: 's-row' }, [cam.node]), strip.node, box]);
    refs[it.id] = { cell, showErr: show };
    show();
    return cell;
  }

  // ── bill：拍電費單 → 解析出的格子標黃 → 逐格確認（複驗閘門，同健檢填報） ──
  function billCell(it) {
    const bill = (S.bills[it.id] ||= { values: {}, meta: {} });
    const { box, show } = errBox(it.id);
    const files = (S.extra[it.id] ||= []);
    const strip = photoStrip(files);
    const notes = el('div', { class: 's-billnote', 'aria-live': 'polite' });
    const grid = el('div', { class: 's-billgrid' });
    const counter = el('p', { class: 's-hint' });

    const onFile = (ui) => async (file) => {
      ui.status.textContent = '';
      const r = await upload(file, it.id, ui);
      if (!r) return;
      ui.status.textContent = '已上傳，解析完成';
      files.push(r.photo); strip.refresh();
      notes.replaceChildren();
      if (r.parseError) {
        notes.append(el('div', { class: 's-callout warn' }, [el('b', { text: '沒有自動帶入' }), el('span', { text: `${r.parseError.message || '解析失敗'}。照片已存，請對照電費單手動輸入下面的欄位。` })]));
        ui.status.textContent = '已上傳';
        return;
      }
      const row = (r.rows || [])[0];
      if (!row) { notes.append(el('div', { class: 's-callout warn', text: '這張照片沒有讀到電費單的數字，請換一張清楚的，或直接手動輸入。' })); return; }
      // 已經有人看過（ok）或親手改過（manual）的格子不覆蓋
      let added = 0, kept = 0;
      for (const [k, v] of Object.entries(row.values || {})) {
        const st = bill.meta[k]?.state;
        if (st === 'ok' || st === 'manual') { kept++; continue; }
        bill.values[k] = v; bill.meta[k] = row.meta?.[k] || { state: 'todo' }; added++;
      }
      const s = r.stats || {};
      notes.append(el('div', { class: 's-callout info' }, [
        el('b', { text: `帶入 ${added} 格，黃色的都要逐格對過` }),
        el('span', { text: `${s.low ? `其中 ${s.low} 格辨識信心低（橘框），請特別注意。` : ''}${kept ? `已確認過的 ${kept} 格沒有覆蓋。` : ''}數字跟電費單一樣就按「這格沒問題」，不一樣就直接改。` }),
        r.notes ? el('span', { class: 's-muted', text: `解析備註：${r.notes}` }) : null,
      ]));
      drawGrid();
      updateSubmit();
    };
    const camUi = cameraButton('📷 拍電費單', (f, ui) => onFile(ui)(f));
    const fileUi = cameraButton('選檔案（照片或 PDF）', (f, ui) => onFile(ui)(f), { capture: false, accept: 'image/*,application/pdf', cls: 's-chip ghost' });

    function cellState(k) { return bill.meta[k]?.state; }
    // 必填或已有值的欄位直接攤開；其餘（轉供、週六半尖峰、各時段需量…多數院所沒有）收進「其他欄位」，
    // 手機上 22 格全攤開太長。收起來的欄位照樣可填，帶入值後下次重畫就會攤開。
    let moreOpen = false;
    function drawGrid() {
      grid.replaceChildren();
      const cols = S.billCols || [];
      const shown = (c) => c.required || bill.values[c.key] !== undefined || bill.meta[c.key];
      const groups = (list, into) => {
        let curGroup = null, wrap = null;
        for (const c of list) {
          const g = c.group || '基本';
          if (g !== curGroup) {
            curGroup = g;
            wrap = el('div', { class: 's-bgrid' });
            into.append(el('p', { class: 's-bgroup', text: g }), wrap);
          }
          wrap.append(billField(c));
        }
      };
      groups(cols.filter(shown), grid);
      const rest = cols.filter((c) => !shown(c));
      if (rest.length) {
        const det = el('details', { class: 's-bmore', open: moreOpen }, [el('summary', { text: `其他欄位（${rest.length} 格，電費單上有才填）` })]);
        det.addEventListener('toggle', () => { moreOpen = det.open; });
        groups(rest, det);
        grid.append(det);
      }
      updateCounter();
    }
    function billField(c) {
      const fid = `b-${it.id}-${c.key}`;
      const v = bill.values[c.key];
      const isNum = c.type === 'number' || c.type === 'percent';
      const inp = el('input', {
        id: fid, autocomplete: 'off', value: v === undefined ? '' : (isNum && typeof v === 'number' ? String(v) : String(v)),
        type: c.type === 'month' ? 'month' : c.type === 'date' ? 'date' : 'text',
        inputmode: isNum ? 'decimal' : undefined, class: isNum ? 's-num' : undefined,
      });
      const f = el('div', { class: 's-bf', 'data-key': c.key });
      const mark = el('div', { class: 's-bmark' });
      const paint = () => {
        const st = cellState(c.key);
        const srvPending = S.pending[it.id]?.has(c.key);
        f.className = 's-bf' + (isNum ? '' : ' wide') + (st === 'todo' ? ' todo' : st === 'low' ? ' low' : '') + (srvPending && (st === 'todo' || st === 'low') ? ' flag' : '');
        mark.replaceChildren();
        if (st === 'todo' || st === 'low') {
          const src = bill.meta[c.key]?.source;
          mark.append(
            el('span', { text: (st === 'low' ? '信心低' : '待確認') + (src?.page ? ` · 第 ${src.page} 頁` : '') }),
            el('button', { type: 'button', class: 's-okbtn', text: '✓ 這格沒問題', onclick: () => { bill.meta[c.key] = { ...bill.meta[c.key], state: 'ok' }; S.pending[it.id]?.delete(c.key); paint(); updateCounter(); } }),
          );
        } else if (st === 'ok' && bill.meta[c.key]?.source) mark.append(el('span', { class: 's-okmark', text: '✓ 已確認' }));
      };
      inp.addEventListener('input', () => {
        const raw = inp.value;
        const n = isNum ? parseNum(raw) : undefined;
        const val = raw.trim() === '' ? undefined : isNum ? (Number.isNaN(n) ? raw : n) : raw.trim();
        if (val === undefined) delete bill.values[c.key]; else bill.values[c.key] = val;
        // 人親手改過就算看過了：有來源的變 ok，沒來源的是 manual
        const had = bill.meta[c.key]?.source;
        if (had) bill.meta[c.key] = { state: 'ok', source: had };
        else if (val === undefined) delete bill.meta[c.key];
        else bill.meta[c.key] = { state: 'manual' };
        S.pending[it.id]?.delete(c.key);
        setErr(it.id, null);
        paint(); updateCounter();
      });
      f.append(el('label', { for: fid, text: c.label + (c.unit ? `（${c.unit}）` : '') + (c.required ? ' *' : '') }), inp, mark);
      if (c.hint) f.append(el('span', { class: 's-bhint', text: c.hint }));
      paint();
      return f;
    }
    function updateCounter() {
      let n = 0;
      for (const m of Object.values(bill.meta)) if (m && (m.state === 'todo' || m.state === 'low')) n++;
      counter.textContent = n ? `還有 ${n} 格待確認` : (Object.keys(bill.values).length ? '每一格都確認過了' : '還沒有填任何欄位。拍照帶入，或直接對照電費單輸入。');
      counter.classList.toggle('s-warntext', n > 0);
      updateSubmit();
    }

    const cell = el('div', { class: 's-cell s-billcell', 'data-item': it.id }, [
      head(it),
      el('div', { class: 's-upload' }, [
        el('span', { text: '拍這個月的電費單，數字自動帶入；也可以直接手動輸入。' }),
        el('div', { class: 's-row' }, [camUi.node, fileUi.node]),
      ]),
      strip.node, notes, counter, grid, box,
    ]);
    refs[it.id] = { cell, showErr: show, redraw: () => { drawGrid(); } };
    drawGrid(); show();
    return cell;
  }

  // ════════════════════════════════════════════════════════════════
  // 送出
  // ════════════════════════════════════════════════════════════════
  function collect() {
    const values = {}, errs = {};
    for (const it of S.data.point.items) {
      const add = (id, m) => { (errs[id] ||= []).push(m); };
      if (it.type === 'reading' || it.type === 'number') {
        const n = parseNum(S.values[it.id]);
        if (n === undefined) { if (it.required) add(it.id, '這一格必填'); continue; }
        if (Number.isNaN(n)) { add(it.id, '只能輸入數字'); continue; }
        values[it.id] = n;
      } else if (it.type === 'status' || it.type === 'text') {
        const v = typeof S.values[it.id] === 'string' ? S.values[it.id].trim() : undefined;
        if (!v) { if (it.required) add(it.id, it.type === 'status' ? '請選一個狀態' : '這一格必填'); continue; }
        values[it.id] = v;
      } else if (it.type === 'photo') {
        const ids = (S.photos[it.id] || []).map((p) => p.id);
        if (!ids.length) { if (it.required) add(it.id, '請拍一張照片'); continue; }
        values[it.id] = ids;
      } else if (it.type === 'bill') {
        const b = S.bills[it.id];
        if (!b || !Object.keys(b.values).length) { if (it.required) add(it.id, '請拍電費單或輸入電費單的數字'); continue; }
        values[it.id] = { values: b.values, meta: b.meta };
      }
    }
    return { values, errs };
  }

  function markNote() {
    document.getElementById('sNoteField')?.classList.add('s-invalid');
    const e = document.getElementById('sNoteErr');
    if (e) e.textContent = '有設備選了「異常」，請寫一句說明：哪台、什麼狀況、通知了誰。';
  }

  function showTop(msg, list) {
    const box = document.getElementById('sTopErr');
    if (!box) return;
    box.replaceChildren();
    box.classList.toggle('hidden', !msg);
    if (!msg) return;
    box.append(el('b', { text: msg }));
    if (list && list.length) box.append(el('ul', {}, list.map((m) => el('li', { text: m }))));
  }
  function scrollToFirstProblem() {
    const t = document.querySelector('.s-invalid, .s-badcell, .s-bf.flag, #sTopErr:not(.hidden)');
    t?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function send() {
    if (S.busy) return;
    showTop('');
    for (const id of Object.keys(S.errs)) setErr(id, null);
    const noteField = document.getElementById('sNoteField');
    const noteErr = document.getElementById('sNoteErr');
    noteField.classList.remove('s-invalid'); noteErr.textContent = '';

    const { values, errs } = collect();
    let blocked = false;
    for (const [id, m] of Object.entries(errs)) { setErr(id, m); blocked = true; }
    if (anyAnomaly() && !S.note.trim()) {
      // 標在選了「異常」的那幾台（同名設備靠 itemId 分），備註欄也標紅
      for (const it of S.data.point.items) if (it.type === 'status' && S.values[it.id] === ANOMALY) setErr(it.id, [...(S.errs[it.id] || []), ANOMALY_NOTE]);
      markNote();
      blocked = true;
    }
    const repField = document.getElementById('sReporterField');
    repField.classList.remove('s-invalid'); document.getElementById('sReporterErr').textContent = '';
    const reporter = S.reporter.trim();
    if (reporter.length > REPORTER_MAX) {
      repField.classList.add('s-invalid');
      document.getElementById('sReporterErr').textContent = `姓名最長 ${REPORTER_MAX} 字`;
      blocked = true;
    }
    if (!Object.keys(values).length && !blocked) { showTop('還沒有填任何項目。'); blocked = true; }
    if (blocked) { scrollToFirstProblem(); return; }

    const photos = [...new Set(Object.values(S.extra).flat().map((p) => p.id))];
    const payload = { values, note: S.note.trim(), photos, confirmDecrease: [...S.confirm], ...(reporter ? { reporter } : {}) };
    S.busy = true; updateSubmit();
    const { status, body } = await api(`/api/inv/point/${encodeURIComponent(code)}/record`, { json: payload });
    S.busy = false; updateSubmit();

    if (status === 200) { saveReporter(reporter); return showDone(body, values); }
    if (status === 401) return showLogin('登入已逾時，請重新登入；剛剛填的內容會保留，登入後再按一次送出。');
    if (status === 410 || status === 403 && body.error === 'forbidden_hospital' || status === 404) return showError(body.error, body.message, status);

    if (status === 422 && body.error === 'reading_decreased') {
      for (const d of body.details || []) { S.decreased[d.itemId] = d; S.confirm.delete(d.itemId); refs[d.itemId]?.update?.(); }
      showTop('有讀數比上次小，請對一下再送出。確定是換表或歸零的話，在該格勾選確認後再按一次送出。');
    } else if (status === 422 && body.error === 'validation') {
      const unmatched = [];
      for (const dt of body.details || []) {
        // details：[{ itemId|null, message }]。itemId 對得到就標在該欄位（同名設備也分得開），對不到的列在上方
        const msg = typeof dt === 'string' ? dt : dt?.message || '';
        const it = dt && dt.itemId ? S.data.point.items.find((i) => i.id === dt.itemId) : null;
        if (!it) { if (msg) unmatched.push(msg); continue; }
        setErr(it.id, [...(S.errs[it.id] || []), msg.replace(`「${it.label}」`, '').replace(/^[：:\s]+/, '') || msg]);
        if (msg === ANOMALY_NOTE) markNote();
      }
      showTop('有欄位需要修正', unmatched);
    } else if (status === 409 && body.error === 'unverified') {
      S.pending = {};
      for (const p of body.pending || []) {
        const it = S.data.point.items.find((i) => i.type === 'bill' && (i.label === p.itemLabel)) || S.data.point.items.find((i) => i.type === 'bill');
        if (!it) continue;
        (S.pending[it.id] ||= new Set()).add(p.key);
        const b = S.bills[it.id];
        if (b && b.meta[p.key] && b.meta[p.key].state !== 'todo' && b.meta[p.key].state !== 'low') b.meta[p.key].state = p.state;
      }
      for (const id of Object.keys(S.pending)) refs[id]?.redraw?.();
      showTop(body.message || '電費單還有格子沒確認', (body.pending || []).map((p) => `${p.label}（${p.state === 'low' ? '信心低' : '待確認'}）`));
    } else if (status === 422 && body.error === 'photo_missing') {
      showTop(body.message || '有照片找不到了，請把照片移除後重新拍一張。');
    } else {
      showTop(body.message || `送出失敗（${body.error || status}），請稍後再試。`);
    }
    updateSubmit();
    scrollToFirstProblem();
  }

  // ── 送出後 ──
  function showDone(res, sent) {
    const d = S.data;
    const p = d.point;
    const rec = res.record || {};
    const rows = [];
    for (const it of p.items) {
      if (it.type !== 'reading' || sent[it.id] === undefined) continue;
      const u = res.usage ? res.usage[it.id] : undefined;
      const unit = it.unit ? ' ' + it.unit : '';
      let val;
      if (typeof u === 'number') val = el('b', { text: `${fmtNum(u)}${unit}` });
      else if (S.confirm.has(it.id)) val = el('span', { text: '已確認換表或歸零，本次不計用量' });
      else val = el('span', { text: '第一次抄表，下次起自動計算' });
      rows.push(el('div', { class: 's-drow' }, [el('span', { text: `本次用量·${it.label}` }), val]));
    }
    for (const a of rec.anomalies || []) {
      rows.push(el('div', { class: 's-drow' }, [
        el('span', { text: `${a.equipmentName || a.label} ${a.value || ANOMALY}` }),
        el('span', { class: 's-pill bad', text: '已列入未結異常' }),
      ]));
    }
    const bills = p.items.filter((i) => i.type === 'bill' && sent[i.id]);
    for (const it of bills) {
      const bv = sent[it.id].values || {};
      rows.push(el('div', { class: 's-drow' }, [el('span', { text: it.label }), el('span', { text: `已存 ${bv.period ? fmtPeriod(bv.period) + ' · ' : ''}${Object.keys(bv).length} 格` })]));
    }
    const nPhotos = (rec.photos || []).length;
    if (nPhotos) rows.push(el('div', { class: 's-drow' }, [el('span', { text: '照片' }), el('span', { text: `${nPhotos} 張` })]));
    rows.push(el('div', { class: 's-drow' }, [el('span', { text: '下次填寫期間' }), el('b', { text: fmtPeriod(res.nextPeriod) })]));

    const warns = (res.warnings || []).length
      ? el('div', { class: 's-callout warn' }, [el('b', { text: '請留意' }), el('ul', {}, res.warnings.map((w) => el('li', { text: w })))])
      : null;

    $root.replaceChildren(el('section', { class: 's-done' }, [
      el('div', { class: 's-callout ok s-donehead', role: 'status' }, [
        el('b', { text: '已送出' }),
        el('span', { text: `${d.hospitalName} · ${p.name}` }),
        el('span', { text: `${fmtAt(rec.at)} · ${fmtPeriod(res.period)}紀錄${byName(rec) ? ` · ${byName(rec)}` : ''}` }),
      ]),
      el('div', { class: 's-dlist' }, rows),
      warns,
      el('button', { type: 'button', class: 's-btn ghost', text: '再記一筆', onclick: () => { $root.replaceChildren(el('p', { class: 's-loading', text: '載入中…' })); load(); window.scrollTo(0, 0); } }),
    ]));
    renderAccount();
    window.scrollTo(0, 0);
  }

  load();
})();
