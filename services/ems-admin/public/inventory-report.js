'use strict';
// 申報與報告（管理端導覽「申報與報告」）：期限提醒、診斷措施、節能計畫、報表下載與待補欄位。
//
// 掛法：window.EMSInventoryReportUI.mount(containerEl, ctx)
//   ctx 可選：{ api(path, opts) → {status, body}, toast(msg, kind), reporter() → 操作人姓名 }；沒給就用 window.EMSUI 或內建的
//   操作人姓名：ctx.reporter 有給（inventory.js 頂部的「操作人」欄）就用它；沒給就自己在頂部放一欄，
//   存同一個 localStorage key（ems.sticker.reporter，與貼紙頁共用）。每次寫入自動帶 reporter。
// 規則判定與依據都走 inventory-compute.js（與伺服器同一份），沒載入就自己補載。
// 依據文字一律來自 API 回傳的 source（schema／計算庫單一來源），這裡不另寫一份。

(function () {
  const W = window;

  // ── 小工具 ──
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : String(c));
    return n;
  }
  async function defaultApi(path, opts = {}) {
    const headers = { 'X-Requested-With': 'ems-admin', ...(opts.headers || {}) };
    const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
    let body = null; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  }
  function loadCompute() {
    if (W.EMSInventoryCompute) return Promise.resolve(W.EMSInventoryCompute);
    return new Promise((resolve, reject) => {
      const s = el('script', { src: '/inventory-compute.js' });
      s.onload = () => resolve(W.EMSInventoryCompute);
      s.onerror = () => reject(new Error('無法載入 inventory-compute.js'));
      document.head.append(s);
    });
  }
  const blank = (v) => v === undefined || v === null || v === '';
  const fmtN = (v, d = 2) => (blank(v) ? '—' : (Math.round(Number(v) * 10 ** d) / 10 ** d).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const rocY = (y) => (blank(y) ? '' : Number(y) > 1911 ? Number(y) - 1911 : Number(y));

  // 依據：一行摘要，點開看原文摘錄
  function srcNode(s, prefix = '依據') {
    if (!s) return null;
    const line = [s.doc, s.ref].filter(Boolean).join(' ');
    return el('details', { class: 'r-src' },
      el('summary', { text: `${prefix}：${line}` }),
      el('div', { class: 'r-srcbody' },
        s.law ? el('p', { text: `文號：${s.law}${s.date ? `（${s.date}）` : ''}` }) : null,
        s.note ? el('p', { text: s.note }) : null,
        s.spec ? el('p', { class: 'muted', text: `對照 ${s.specDoc || 'docs/energy-audit-spec.md'} ${s.spec}` }) : null,
        s.text ? el('p', { class: 'r-quote', text: s.text }) : null));
  }
  const levelClass = (lv) => ({ ok: 'r-ok', warn: 'r-warn', error: 'r-bad', na: 'r-na' })[lv] || 'r-na';
  const checkNode = (r) => (r ? el('div', { class: `r-check ${levelClass(r.level)}` }, el('span', { text: r.msg }), srcNode(r.source)) : null);

  // ── 狀態 ──
  let ROOT = null, CTX = {}, C = null, SPEC = null;
  let M = null, P = null, DL = null, DIAG = null;
  const api = (p, o) => (CTX.api || W.EMSUI?.api || defaultApi)(p, o);
  const toast = (msg, kind) => (CTX.toast || W.EMSUI?.toast || ((m) => W.alert(m)))(msg, kind);
  // ── 操作人姓名 ──
  const REPORTER_KEY = 'ems.sticker.reporter';
  const REPORTER_MAX = 20;
  let ownReporter = '';
  try { ownReporter = W.localStorage.getItem(REPORTER_KEY) || ''; } catch { /* 被擋就每次重填 */ }
  const reporter = () => String((CTX.reporter ? CTX.reporter() : ownReporter) || '').trim();
  function operatorField() {
    const inp = el('input', { type: 'text', value: ownReporter, maxlength: String(REPORTER_MAX), placeholder: '例：王小明', autocomplete: 'name' });
    inp.addEventListener('input', () => {
      ownReporter = inp.value.slice(0, REPORTER_MAX);
      try { if (ownReporter.trim()) W.localStorage.setItem(REPORTER_KEY, ownReporter.trim()); else W.localStorage.removeItem(REPORTER_KEY); } catch { /* 存不了就算了 */ }
    });
    return el('label', { class: 'r-field' }, el('span', { class: 'r-flabel', text: '操作人' }), inp,
      el('span', { class: 'note', text: '帳號全院共用；填上姓名，修改紀錄會記成「姓名（院名）」。' }));
  }
  const send = (method, path, body) => {
    const b = { ...(body || {}) };
    if (reporter() && b.reporter === undefined) b.reporter = reporter();
    return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  };
  // DELETE 沒有 body：操作人姓名放 query
  const sendDelete = (path) => api(reporter() ? `${path}?reporter=${encodeURIComponent(reporter())}` : path, { method: 'DELETE' });
  const errMsg = (r) => r.body?.message || (r.body?.details || []).join('；') || r.body?.error || `錯誤 ${r.status}`;

  async function loadAll() {
    const [s, m, p, d, g] = await Promise.all([
      SPEC ? { body: { ok: true, spec: SPEC } } : api('/api/inv/report/spec'),
      api('/api/inv/report/measures'), api('/api/inv/report/plans'), api('/api/inv/report/deadlines'), api('/api/inv/report/diagnosis-data'),
    ]);
    if (!s.body?.ok || !m.body?.ok) throw new Error(errMsg(m.body ? m : s));
    SPEC = s.body.spec; M = m.body; P = p.body; DL = d.body; DIAG = g.body;
  }

  async function render() {
    ROOT.textContent = '';
    ROOT.append(el('p', { class: 'muted', text: '載入中…' }));
    try { C = await loadCompute(); await loadAll(); }
    catch (e) { ROOT.textContent = ''; ROOT.append(el('p', { class: 'err', text: `載入失敗：${e.message}` })); return; }
    ROOT.textContent = '';
    const body = el('div', { class: 'r-tabbody' });
    ROOT.append(el('div', { class: 'r-wrap' },
      el('h2', { class: 'r-h', text: '申報與報告' }),
      CTX.reporter ? null : operatorField(),
      tabBar(), TAB === 'work' ? null : yearBar(), body));
    if (TAB === 'work') {
      const anchor = (n, id) => { n.id = id; return n; };
      body.append(...[deadlinesCard(), anchor(diagnosisCard(), 'r-card-diagnosis'), anchor(measuresCard(), 'r-card-measures'), anchor(plansCard(), 'r-card-plans'), reportsCard(), waterCard()].filter(Boolean));
    } else await drawTab(body);
  }
  async function refresh(keepOpen) { const y = W.scrollY; await render(); W.scrollTo(0, y); if (keepOpen) openEditor(keepOpen); }

  // ── 期限提醒 ──
  function deadlinesCard() {
    const items = DL?.items || [];
    return el('section', { class: 'r-card' },
      el('h3', { text: '期限提醒' }), srcNode(SPEC.sources.deadlines),
      items.length ? el('ul', { class: 'r-dl' }, items.map((x) => el('li', { class: levelClass(x.level) },
        el('b', { text: x.dateRoc }), ' ', el('span', { text: x.label }), ' ', el('span', { class: 'muted', text: `剩 ${x.daysLeft} 天｜${x.basis}` }), srcNode(x.source))))
        : el('p', { class: 'muted', text: '沒有即將到期的項目' }),
      DL?.inputs && !DL.inputs.isoCertExpiry ? el('p', { class: 'note', text: '未填 ISO 50001 證書效期（初始建檔·能源政策）；有證書的話填上才會提醒。' }) : null);
  }

  // ── 診斷報告主檔與團隊 ──
  function fieldInput(f, value, onInput) {
    const id = `r-f-${Math.random().toString(36).slice(2, 8)}`;
    let input;
    if (f.type === 'select') {
      input = el('select', { id }, el('option', { value: '', text: '—' }), f.options.map((o) => el('option', { value: o, text: f.optionLabels?.[o] ? `${o} ${f.optionLabels[o]}` : o, selected: String(value ?? '') === String(o) })));
    } else if (f.type === 'boolean') {
      input = el('select', { id }, el('option', { value: '', text: '—' }), el('option', { value: 'true', text: '是', selected: value === true }), el('option', { value: 'false', text: '否', selected: value === false }));
    } else if (f.max && f.max > 500) {
      input = el('textarea', { id, rows: 3 }); input.value = value ?? '';
    } else {
      input = el('input', { id, type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'month' ? 'month' : 'text', step: f.type === 'number' ? 'any' : undefined, value: f.type === 'year' ? rocY(value) : value ?? '' });
    }
    input.addEventListener('input', () => onInput(f.type === 'boolean' ? (input.value === '' ? '' : input.value === 'true') : input.value));
    const unit = f.unit || '';
    return el('label', { class: 'r-field', for: id },
      el('span', { class: 'r-flabel', text: `${f.code ? `${f.code} ` : ''}${f.label}${unit ? `（${unit}）` : ''}${f.required ? ' *' : ''}` }),
      input, f.hint ? el('span', { class: 'note', text: f.hint }) : null, f.source ? srcNode(f.source) : null);
  }

  function diagnosisCard() {
    const d = JSON.parse(JSON.stringify(DIAG?.diagnosis || { teams: [] }));
    const box = el('div', { class: 'r-teams' });
    const drawTeams = () => {
      box.textContent = '';
      d.teams.forEach((t, i) => {
        t.members ||= [];
        const mbox = el('div', { class: 'r-members' });
        const drawMembers = () => {
          mbox.textContent = '';
          t.members.forEach((m, j) => mbox.append(el('div', { class: 'r-grid r-member' },
            SPEC.memberFields.map((f) => fieldInput(f, m[f.key], (v) => { m[f.key] = v; })),
            el('button', { type: 'button', class: 'link danger', text: '移除這位', onclick: () => { t.members.splice(j, 1); drawMembers(); } }))));
          mbox.append(el('button', { type: 'button', text: '＋ 人員', onclick: () => { t.members.push({}); drawMembers(); } }));
        };
        drawMembers();
        const chk = DIAG.checks?.[i];
        box.append(el('fieldset', { class: 'r-team' },
          el('legend', { text: t.name || `診斷團隊 ${i + 1}` }),
          el('div', { class: 'r-grid' }, SPEC.teamFields.map((f) => fieldInput(f, t[f.key], (v) => { t[f.key] = v; }))),
          chk ? checkNode(chk) : null,
          el('h4', { text: '人員明細' }), mbox,
          el('button', { type: 'button', class: 'link danger', text: '移除這個團隊', onclick: () => { d.teams.splice(i, 1); drawTeams(); } })));
      });
    };
    drawTeams();
    const msg = el('p', { class: 'err' });
    return el('section', { class: 'r-card' },
      el('h3', { text: '節能診斷報告·主檔與診斷團隊' }), srcNode(SPEC.sources.diagnosis),
      el('div', { class: 'r-grid' }, SPEC.diagnosisFields.map((f) => fieldInput(f, d[f.key], (v) => { d[f.key] = v; }))),
      el('p', { class: 'note', text: `提報年度 ${DIAG?.reportYear ?? ''}${DIAG?.retentionUntil ? `｜文件保存至 ${C.toRocDate(C.parseDate(DIAG.retentionUntil))}` : ''}` }),
      box,
      el('div', { class: 'r-actions' },
        el('button', { type: 'button', text: '＋ 診斷團隊', onclick: () => { d.teams.push({ members: [] }); drawTeams(); } }),
        el('button', { type: 'button', class: 'primary', text: '儲存主檔與團隊', onclick: async () => {
          const r = await send('PUT', '/api/inv/report/diagnosis-data', { diagnosis: d });
          if (!r.body?.ok) { msg.textContent = errMsg(r); return; }
          toast('已儲存', 'ok'); refresh();
        } })), msg);
  }

  // ── 措施 ──
  let openId = null;
  function openEditor(id) { const n = ROOT.querySelector(`[data-mid="${id}"]`); if (n) { n.open = true; n.scrollIntoView({ block: 'nearest' }); } }

  function liveChecks(type, v, m, box) {
    box.textContent = '';
    const pb = C.paybackYears(v.investment, v.savingCost);
    box.append(checkNode(pb));
    if (type === 'replace') {
      // R6 類別：措施上手動指定的優先；否則連設備主檔的用 inventory-compute.js 的 equipmentReplaceCategory（與管理端、伺服器同一支）
      const cat = v.replaceCategory || (m?.equipment && C.equipmentReplaceCategory ? C.equipmentReplaceCategory(m.equipment) : m?.replaceCategory);
      // 連設備主檔的以主檔製造年份判定（同伺服器）；措施上的製造年份只是報表顯示用
      const r6 = C.replacementRequired({ category: cat, mfgYear: m?.equipment ? m.equipment.madeYear : v.madeYear, reportYear: M.reportYear });
      box.append(checkNode(r6));
    }
    box.append(checkNode(C.planMandatory(pb)));
  }

  function measureEditor(type, m) {
    const t = SPEC.measureTypes[type];
    const vals = { ...(m ? m.fields : {}) };
    const shown = m ? { ...m.values } : { energyType: 'E01' };
    const checks = el('div', { class: 'r-checks' });
    const unitOf = () => SPEC.energyTypes.find((e) => e.code === (vals.energyType || shown.energyType || 'E01'))?.unit || '';
    const recompute = () => liveChecks(type, { ...shown, ...vals }, m, checks);
    const fields = t.fields.map((f) => {
      const ff = f.unitFrom ? { ...f, unit: unitOf() } : f;
      const placeholderVal = m && f.fromEquipment && blank(vals[f.key]) ? shown[f.key] : vals[f.key];
      return fieldInput(ff, placeholderVal, (x) => { vals[f.key] = x; recompute(); });
    });
    recompute();
    const msg = el('p', { class: 'err' });
    const reason = el('input', { type: 'text', placeholder: '修改原因（選填，會記入異動登錄）' });
    const save = async () => {
      const body = { measure: { fields: vals } };
      const r = m ? await send('PUT', `/api/inv/report/measures/${encodeURIComponent(m.id)}`, { ...body, reason: reason.value })
        : await send('POST', '/api/inv/report/measures', { measure: { type, fields: vals } });
      if (!r.body?.ok) { msg.textContent = errMsg(r); return; }
      toast(m ? '措施已更新' : '措施已新增', 'ok');
      openId = null; refresh();
    };
    return el('div', { class: 'r-editor' },
      m?.equipment ? el('p', { class: 'note', text: `帶入設備主檔：${m.equipment.name}（${m.equipment.categoryLabel}·${m.equipment.kind}${m.equipment.building ? `·${m.equipment.building}` : ''}）；空白格沿用設備主檔的值` }) : null,
      el('div', { class: 'r-grid' }, fields), checks,
      m ? reason : null,
      el('div', { class: 'r-actions' }, el('button', { type: 'button', class: 'primary', text: m ? '儲存措施' : '新增措施', onclick: save })), msg);
  }

  function measureRow(m) {
    const v = m.values;
    const badges = el('span', { class: 'r-badges' },
      m.mandatory ? el('span', { class: 'r-tag r-bad', text: 'R6 強制列入·不可刪' }) : null,
      m.planMandatory?.value ? el('span', { class: 'r-tag r-warn', text: 'R7 必列節能計畫' }) : null,
      m.origin === 'r6' && !m.mandatory ? el('span', { class: 'r-tag r-na', text: '原自動列入' }) : null);
    const del = el('button', { type: 'button', class: 'link danger', text: '刪除', disabled: !m.deletable, title: m.deletable ? '' : m.deleteBlockedBy?.msg,
      onclick: async () => {
        if (!W.confirm(`刪除措施「${v.name || m.id}」？${m.planId ? '對應的節能計畫也會一併移除。' : ''}`)) return;
        const r = await sendDelete(`/api/inv/report/measures/${encodeURIComponent(m.id)}`);
        if (!r.body?.ok) { toast(errMsg(r), 'err'); return; }
        toast('已刪除', 'ok'); refresh();
      } });
    return el('details', { class: 'r-item', 'data-mid': m.id, open: openId === m.id, ontoggle: (e) => { if (e.target.open) openId = m.id; } },
      el('summary', {},
        el('span', { class: 'r-no', text: m.no }), ' ',
        el('b', { text: v.name || '（未命名）' }), ' ', badges, ' ',
        el('span', { class: 'muted', text: `年節能 ${fmtN(v.annualSaving)} ${m.unit}｜回收 ${m.payback.value !== undefined ? `${fmtN(m.payback.value)} 年` : m.payback.msg}` })),
      m.mandatory ? el('div', { class: 'r-check r-bad' }, el('span', { text: `${m.r6.msg}：不可刪，可在「補充說明」補充` }), srcNode(m.r6.source)) : null,
      measureEditor(m.type, m), el('div', { class: 'r-actions' }, el('span', { class: 'muted', text: `措施 ID ${m.id}` }), del));
  }

  function measuresCard() {
    const sec = (type) => {
      const t = SPEC.measureTypes[type];
      const list = M.measures[type];
      const adder = el('div', { class: 'r-adder' });
      const addBtn = type === 'replace'
        ? el('div', { class: 'r-actions' },
          el('label', {}, '從設備主檔挑設備：',
            el('select', { onchange: async (e) => {
              const id = e.target.value; if (!id) return;
              const r = await send('POST', '/api/inv/report/measures', { measure: { type: 'replace', equipmentId: id, fields: {} } });
              if (!r.body?.ok) { toast(errMsg(r), 'err'); return; }
              openId = r.body.measure.id; toast('已帶入設備，請補預期成效', 'ok'); refresh(openId);
            } }, el('option', { value: '', text: '— 選擇設備 —' }), M.equipment.map((q) => el('option', { value: q.id, text: `${q.name || q.id}（${q.categoryLabel}·${q.kind}${q.madeYear ? `·${rocY(q.madeYear)} 年製` : ''}）${q.hasMeasure ? '·已有措施' : ''}${q.r6.value ? '·超齡' : ''}` })))),
          el('button', { type: 'button', text: '＋ 未在主檔的設備', onclick: () => { adder.textContent = ''; adder.append(measureEditor('replace', null)); } }))
        : el('div', { class: 'r-actions' }, el('button', { type: 'button', text: '＋ 操作面措施', onclick: () => { adder.textContent = ''; adder.append(measureEditor('operation', null)); } }));
      return el('div', { class: 'r-sub' },
        el('h4', { text: `${t.section}、${t.label}（${list.length} 項）` }), srcNode(t.source),
        list.length ? el('div', { class: 'r-list' }, list.map(measureRow)) : el('p', { class: 'muted', text: '尚無措施' }),
        addBtn, adder);
    };
    return el('section', { class: 'r-card' },
      el('h3', { text: '節能診斷措施（附件一）' }), srcNode(SPEC.sources.measures),
      el('p', { class: 'note', text: `提報年度 ${M.reportYear}｜${M.summary.msg}` }), M.summary.note ? el('p', { class: 'note', text: M.summary.note }) : null,
      sec('replace'), sec('operation'));
  }

  // ── 節能計畫 ──
  function planRow(p) {
    const vals = {};
    const orig = { ...p.fields };
    const checkBox = el('div', { class: 'r-checks' });
    const reason = el('input', { type: 'text', placeholder: '變更原因（改已填過的值時必填，R8）' });
    const recompute = () => {
      const next = { ...orig, ...vals };
      checkBox.textContent = '';
      checkBox.append(checkNode(C.planRowCheck({ paybackYears: p.paybackYears, completionYear: blank(next.completionYear) ? undefined : next.completionYear, note: next.note, reportYear: P.reportYear })));
      const changing = Object.keys(vals).some((k) => !blank(orig[k]) && String(orig[k]) !== String(vals[k]));
      reason.classList.toggle('r-need', changing);
    };
    recompute();
    const msg = el('p', { class: 'err' });
    const save = async () => {
      const r = await send('PUT', `/api/inv/report/plans/${encodeURIComponent(p.id)}`, { plan: { fields: vals }, reason: reason.value });
      if (!r.body?.ok) { msg.textContent = errMsg(r); return; }
      toast(r.body.unchanged ? '沒有變動' : '計畫已更新', 'ok'); refresh();
    };
    const del = el('button', { type: 'button', class: 'link danger', text: '自計畫移除', disabled: !p.deletable, title: p.deletable ? '' : 'R7：回收年限 < 10 年必須列入',
      onclick: async () => {
        if (!W.confirm(`把「${p.name}」移出節能計畫？`)) return;
        const r = await sendDelete(`/api/inv/report/plans/${encodeURIComponent(p.id)}`);
        if (!r.body?.ok) { toast(errMsg(r), 'err'); return; }
        refresh();
      } });
    return el('details', { class: 'r-item' },
      el('summary', {},
        el('span', { class: 'r-no', text: p.no }), ' ', el('b', { text: p.name }), ' ',
        p.mandatory ? el('span', { class: 'r-tag r-warn', text: 'R7 強制納入·不可刪' }) : null, ' ',
        el('span', { class: `r-tag ${levelClass(p.check.level)}`, text: p.check.ok === false ? '待補' : '完整' }), ' ',
        el('span', { class: 'muted', text: `完工 ${p.fields.completionYear ?? '—'}｜${p.fields.status || '規劃中'}｜年節能 ${fmtN(p.annualSaving)} ${p.unit}｜回收 ${fmtN(p.paybackYears)} 年` })),
      el('p', { class: 'note', text: `來源措施 ${p.measure ? `${p.measure.typeLabel} 第 ${p.measure.no} 項` : '（已刪除）'}｜措施 ID ${p.measureId}｜預計完工年度限 ${p.range[0]}～${p.range[1]}` }),
      el('div', { class: 'r-grid' }, SPEC.planFields.filter((f) => !f.group).map((f) => fieldInput(f, p.fields[f.key], (x) => { vals[f.key] = x; recompute(); }))),
      SPEC.planFields.some((f) => f.group) ? el('details', { class: 'r-subform' }, el('summary', { text: '申報表十／十一 執行資料（改善前後、執行期間、實際成效、所需人力）' }),
        el('div', { class: 'r-grid' }, SPEC.planFields.filter((f) => f.group).map((f) => fieldInput(f, p.fields[f.key], (x) => { vals[f.key] = x; recompute(); })))) : null,
      checkBox, reason,
      el('div', { class: 'r-actions' }, el('button', { type: 'button', class: 'primary', text: '儲存計畫', onclick: save }), del), msg,
      p.versions.length ? el('details', { class: 'r-versions' }, el('summary', { text: `版本紀錄（${p.versions.length}）` }),
        el('ol', {}, p.versions.map((v) => el('li', {},
          el('b', { text: `v${v.v} ${C.toRocDate(C.parseDate(v.at.slice(0, 10)))}` }), ` ${v.who || ''}：`,
          Object.keys(v.after).map((k) => `${SPEC.planFields.find((f) => f.key === k)?.label || k} ${v.before[k] ?? '（空）'} → ${v.after[k] ?? '（空）'}`).join('；'),
          el('span', { class: 'muted', text: `｜原因：${v.reason}` }))))) : null);
  }

  function plansCard() {
    const list = P?.plans || [];
    const candidates = [...M.measures.replace, ...M.measures.operation].filter((m) => !m.planId);
    const sel = el('select', {}, el('option', { value: '', text: '— 回收 ≥ 10 年的措施也可自願納入 —' }), candidates.map((m) => el('option', { value: m.id, text: `${m.typeLabel} ${m.no}：${m.values.name || m.id}` })));
    return el('section', { class: 'r-card' },
      el('h3', { text: '節能計畫（附件二）' }), srcNode(P?.source), srcNode(SPEC.sources.r8),
      el('p', { class: 'note', text: `提報年度 ${P?.reportYear}；預計完工年度限 ${P?.range?.[0]}～${P?.range?.[1]}；未填完工年度須在備註說明原因。` }),
      list.length ? el('div', { class: 'r-list' }, list.map(planRow)) : el('p', { class: 'muted', text: '尚無計畫項目' }),
      candidates.length ? el('div', { class: 'r-actions' }, sel, el('button', { type: 'button', text: '納入計畫', onclick: async () => {
        if (!sel.value) return;
        const r = await send('POST', '/api/inv/report/plans', { measureId: sel.value });
        if (!r.body?.ok) { toast(errMsg(r), 'err'); return; }
        refresh();
      } })) : null);
  }

  // ── 報表下載與待補欄位 ──
  function reportsCard() {
    const nowRoc = new Date().getFullYear() - 1911;
    const year = el('input', { type: 'number', value: YEAR || nowRoc - 1, min: 100, max: 200, class: 'r-year' });
    year.addEventListener('change', () => setYear(year.value));
    const missBox = el('div', { class: 'r-missing' });
    const showMissing = async (kind) => {
      missBox.textContent = '';
      missBox.append(el('p', { class: 'muted', text: '計算中…' }));
      const r = await api(`/api/inv/report/missing?kind=${kind}${kind === 'annex3' ? `&year=${encodeURIComponent(year.value)}` : ''}`);
      missBox.textContent = '';
      if (!r.body?.ok) { missBox.append(el('p', { class: 'err', text: errMsg(r) })); return; }
      const bySheet = new Map();
      for (const m of r.body.missing) { if (!bySheet.has(m.sheet)) bySheet.set(m.sheet, []); bySheet.get(m.sheet).push(m); }
      missBox.append(el('h4', { text: `${r.body.filename}·待補欄位 ${r.body.missing.length} 項` }));
      if (!r.body.missing.length) missBox.append(el('p', { class: 'muted', text: '沒有待補欄位' }));
      for (const [sheet, items] of bySheet) missBox.append(el('details', { class: 'r-misssheet' }, el('summary', { text: `${sheet}（${items.length}）` }),
        el('ul', {}, items.map((m) => el('li', {}, el('b', { text: m.field }), m.why ? `：${m.why}` : '')))));
    };
    const dl = (kind, label, src) => el('div', { class: 'r-dlrow' },
      el('a', { class: 'r-btn', href: `/api/inv/report/${kind}${kind === 'annex3' ? `?year=${year.value}` : ''}`, download: '', onclick: (e) => { if (kind === 'annex3') e.currentTarget.href = `/api/inv/report/annex3?year=${encodeURIComponent(year.value)}`; }, text: `下載 ${label}` }),
      el('button', { type: 'button', class: 'link', text: '看待補欄位', onclick: () => showMissing(kind) }), srcNode(src));
    return el('section', { class: 'r-card' },
      el('h3', { text: '報表產出（xlsx）' }),
      el('p', { class: 'note', text: '系統推得出的欄位全部帶入；推不出的留空，列在每份檔案最後的「待補欄位」工作表。能源署申報系統沒有公開匯入格式，本檔為對照官方格式的轉填稿。' }),
      el('label', { class: 'r-field' }, el('span', { class: 'r-flabel', text: '附表三資料年 N（民國）' }), year),
      dl('annex3', '附表三 年度申報', { doc: '附表三 能源查核制度申報表（非生產性質行業）', ref: '各表', law: '經能字第 11558000090 號', date: '115-01-23' }),
      dl('diagnosis', '附件一 節能診斷報告', SPEC.sources.diagnosis),
      dl('plan', '附件二 節能計畫', SPEC.sources.plans),
      missBox);
  }

  // ── 水足跡盤查清冊（工作清單 23；ISO 14046 盤查、ISO 46001 指標）──
  // 只在新後端（/api/inv/spec 有 water）時出現；摘要在瀏覽器用 inventory-compute.js 的 waterInventory 算（與報表同一份）
  function waterCard() {
    const WS = CTX.spec?.water;
    if (!WS) return null;
    const nowRoc = new Date().getFullYear() - 1911;
    const year = el('input', { type: 'number', value: nowRoc - 1, min: 100, max: 200, class: 'r-year' });
    const sum = el('div');
    const missBox = el('div', { class: 'r-missing' });
    const paint = () => {
      sum.textContent = '';
      const inv = CTX.inventory ? CTX.inventory() : null;
      if (!inv || !C?.waterInventory) return;
      const w = C.waterInventory(inv, { year: Number(year.value) + 1911 });
      const F = w.flows;
      const li = (level, text, src) => el('li', { class: levelClass(level) }, el('span', { text }), srcNode(src));
      sum.append(el('ul', { class: 'r-dl' },
        li(F.intake.total === undefined ? 'na' : F.intake.inferred ? 'warn' : 'ok', `取水 ${fmtN(F.intake.total)} m³${F.intake.inferred ? '（點位未標流向，推定）' : ''}${F.intake.replace ? `，其中替代水源 ${fmtN(F.intake.replace)} m³` : ''}`, F.intake.source),
        li(F.discharge.measured ? 'ok' : 'na', `排放 ${fmtN(F.discharge.total)} m³${F.reuse.total !== undefined ? `；回收再利用 ${fmtN(F.reuse.total)} m³` : ''}`, F.discharge.source),
        li(F.consumption.level, F.consumption.msg, F.consumption.source),
        ...w.performance.map((p) => {
          const c = w.baseline?.compare.find((x) => x.id === p.id);
          return li(c && c.level !== 'na' ? c.level : p.level, `${p.msg}${c && c.diffPct !== undefined ? `；${c.msg}` : ''}`, c?.source || p.source);
        }),
        li(w.completeness.pct >= 80 ? 'ok' : 'warn', `資料完整度 ${w.completeness.pct}%（${w.completeness.passed}/${w.completeness.total} 項）`, w.completeness.source)));
      const bad = w.completeness.checks.filter((x) => !x.ok);
      if (bad.length) sum.append(el('details', { class: 'r-misssheet' }, el('summary', { text: `未通過的資料品質檢查（${bad.length}）` }),
        el('ul', {}, bad.map((x) => el('li', {}, el('b', { text: x.label }), `：${x.msg}`)))));
    };
    year.addEventListener('change', paint);
    const showMissing = async () => {
      missBox.textContent = '';
      missBox.append(el('p', { class: 'muted', text: '計算中…' }));
      const r = await api(`/api/inv/report/missing?kind=water&year=${encodeURIComponent(year.value)}`);
      missBox.textContent = '';
      if (!r.body?.ok) { missBox.append(el('p', { class: 'err', text: r.body?.error === 'bad_kind' ? '伺服器尚未更新到水足跡盤查版本' : errMsg(r) })); return; }
      const bySheet = new Map();
      for (const m of r.body.missing) { if (!bySheet.has(m.sheet)) bySheet.set(m.sheet, []); bySheet.get(m.sheet).push(m); }
      missBox.append(el('h4', { text: `${r.body.filename}·待補欄位 ${r.body.missing.length} 項` }));
      if (!r.body.missing.length) missBox.append(el('p', { class: 'muted', text: '沒有待補欄位' }));
      for (const [sheet, items] of bySheet) missBox.append(el('details', { class: 'r-misssheet' }, el('summary', { text: `${sheet}（${items.length}）` }),
        el('ul', {}, items.map((m) => el('li', {}, el('b', { text: m.field }), m.why ? `：${m.why}` : '')))));
    };
    const card = el('section', { class: 'r-card' },
      el('h3', { text: '水足跡盤查清冊（xlsx）' }),
      el('p', { class: 'note', text: '依 ISO 14046 盤查結構：目的與範疇、取水（依水源別）、主要用水單元、排放與回收、水平衡、水質、用水績效指標與基線、資料品質、節水改善回報。只做盤查，不做衝擊評估。' }),
      el('label', { class: 'r-field' }, el('span', { class: 'r-flabel', text: '資料年（民國）' }), year),
      sum,
      el('div', { class: 'r-dlrow' },
        el('a', { class: 'r-btn', href: `/api/inv/report/water?year=${year.value}`, download: '', onclick: (e) => { e.currentTarget.href = `/api/inv/report/water?year=${encodeURIComponent(year.value)}`; }, text: '下載 水足跡盤查清冊' }),
        el('button', { type: 'button', class: 'link', text: '看待補欄位', onclick: () => showMissing() }), srcNode(WS.source)),
      missBox);
    paint();
    return card;
  }

  // ════════════════════ EMS-EXPORT-TABS（工作清單 24）════════════════════
  // 申報對照（照能源署線上申報畫面順序、每欄複製）／單表匯出／報表資料輸入（年度）／年度沿用（逐區塊確認）
  // 後端還沒更新時這些 API 回 404 unknown_report：分頁只顯示提示，「措施與計畫」照舊可用。
  const TABS = [['work', '措施與計畫'], ['filing', '申報對照'], ['tables', '單表匯出'], ['annual', '報表資料輸入'], ['carry', '年度沿用']];
  const TAB_KEY = 'ems.report.tab', YEAR_KEY = 'ems.report.year';
  let TAB = 'work', YEAR = new Date().getFullYear() - 1912;
  try { TAB = W.localStorage.getItem(TAB_KEY) || 'work'; const y = Number(W.localStorage.getItem(YEAR_KEY)); if (y > 100 && y < 200) YEAR = y; } catch { /* 存不了就用預設 */ }
  if (!TABS.some(([k]) => k === TAB)) TAB = 'work';
  let PENDING_FOCUS = null;   // 切到分頁後要捲到的區塊（去填連結）
  function setYear(v) { const y = Number(v); if (!(y > 100 && y < 200)) return; YEAR = y; try { W.localStorage.setItem(YEAR_KEY, String(y)); } catch {} }
  function setTab(k, focus) { TAB = k; PENDING_FOCUS = focus || null; try { W.localStorage.setItem(TAB_KEY, k); } catch {} render(); }
  function tabBar() {
    return el('nav', { class: 'r-tabs', role: 'tablist' }, TABS.map(([k, l]) => el('button', { type: 'button', role: 'tab', class: `r-tab${k === TAB ? ' on' : ''}`, 'aria-selected': k === TAB ? 'true' : 'false', text: l, onclick: () => setTab(k) })));
  }
  function yearBar() {
    const inp = el('input', { type: 'number', value: YEAR, min: 100, max: 200, class: 'r-year', 'aria-label': '資料年 N（民國）' });
    return el('div', { class: 'r-actions r-yearbar' },
      el('label', { class: 'r-inline' }, el('span', { class: 'r-flabel', text: '資料年 N（民國）' }), inp),
      el('button', { type: 'button', text: '切換', onclick: () => { setYear(inp.value); render(); } }),
      el('span', { class: 'muted', text: `${YEAR + 1} 年 1 月申報 ${YEAR} 年資料` }));
  }
  const oldBackend = (r) => r.status === 404 && (r.body?.error === 'unknown_report' || !r.body);
  const oldBackendNote = () => el('section', { class: 'r-card' }, el('p', { class: 'note', text: '這個分頁要等伺服器更新後才能使用（後端尚未重新啟動）。「措施與計畫」分頁照常可用。' }));
  const q = () => `year=${encodeURIComponent(YEAR)}`;

  // 去哪裡填：管理端分區（初始建檔、設備主檔、點位）或本頁分頁
  function gotoFill(fill) {
    if (!fill) return;
    if (fill.section) { if (CTX.goSection) CTX.goSection(fill.section); else toast('請到左側導覽對應的分區填寫', 'warn'); return; }
    if (fill.tab === 'annual') return setTab('annual', `r-an-${fill.block}`);
    if (fill.tab === 'work') return setTab('work', `r-card-${fill.anchor || 'plans'}`);
  }
  function fillLabel(fill) {
    if (!fill) return '';
    if (fill.section) return fill.section.startsWith('i-eq-') ? '設備主檔' : fill.section === 'i-points' ? '點位與進度（電費單）' : '初始建檔';
    if (fill.tab === 'annual') return '報表資料輸入';
    return { plans: '節能計畫', measures: '診斷措施', diagnosis: '診斷報告主檔' }[fill.anchor] || '措施與計畫';
  }
  const fillBtn = (fill, text = '去填') => (fill ? el('button', { type: 'button', class: 'link', text: `${text}（${fillLabel(fill)}）`, onclick: () => gotoFill(fill) }) : null);

  async function copyText(t) {
    try { await W.navigator.clipboard.writeText(t); toast('已複製', 'ok'); return; } catch { /* 沒權限就用舊方法 */ }
    const ta = el('textarea', { class: 'r-offscreen', 'aria-hidden': 'true' }); ta.value = t; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('已複製', 'ok'); } catch { toast('瀏覽器不允許複製，請手動選取', 'warn'); }
    ta.remove();
  }
  const copyBtn = (v, label) => el('button', { type: 'button', class: 'r-copy', text: '複製', title: label ? `複製「${label}」` : '複製', 'aria-label': label ? `複製${label}` : '複製', onclick: () => copyText(v) });
  const pend = (fill) => el('span', { class: 'r-tag r-warn', text: '待補' });

  async function drawTab(body) {
    body.append(el('p', { class: 'muted', text: '載入中…' }));
    try {
      const n = TAB === 'filing' ? await filingTab() : TAB === 'tables' ? await tablesTab() : TAB === 'annual' ? await annualTab() : await carryTab();
      body.textContent = ''; body.append(n);
    } catch (e) { body.textContent = ''; body.append(el('p', { class: 'err', text: `載入失敗：${e.message}` })); }
    if (PENDING_FOCUS) { const t = document.getElementById(PENDING_FOCUS); PENDING_FOCUS = null; if (t) { if (t.tagName === 'DETAILS') t.open = true; t.scrollIntoView({ block: 'start' }); } }
  }

  // ── 申報對照 ──
  function fieldLine(it) {
    const label = `${it.code ? `${it.code} ` : ''}${it.label}`;
    return el('div', { class: `r-fline${it.status === 'missing' ? ' r-fmiss' : ''}` },
      el('span', { class: 'r-fname', text: label }),
      el('span', { class: 'r-fval' }, it.status === 'ok' ? el('b', { text: `${it.value}${it.unit ? ` ${it.unit}` : ''}` }) : it.status === 'na' ? el('span', { class: 'r-tag r-na', text: '免填' }) : pend()),
      el('span', { class: 'r-fact' }, it.status === 'ok' ? copyBtn(it.value, it.label) : it.status === 'missing' ? fillBtn(it.fill) : null),
      it.note && it.status !== 'na' ? el('span', { class: 'note r-fnote', text: it.note }) : null);
  }
  function rowCard(row, cols) {
    if (row.empty) return el('p', { class: 'muted', text: row.text });
    const cells = row.cells;
    const title = cells[0]?.value || '';
    const miss = cells.slice(1).filter((c) => c.status === 'missing').length;
    const line = cells.map((c) => c.value).join('\t');
    return el('details', { class: 'r-frow' },
      el('summary', {}, el('b', { text: title || '（列）' }), ' ',
        el('span', { class: 'muted', text: cells.slice(1, 4).filter((c) => c.value).map((c) => `${c.label} ${c.value}`).join('｜') }), ' ',
        miss ? el('span', { class: 'r-tag r-warn', text: `待補 ${miss}` }) : null),
      el('div', { class: 'r-actions' }, el('button', { type: 'button', class: 'r-copy', text: '複製整列（Tab 分隔）', onclick: () => copyText(line) }), miss ? fillBtn(row.fill) : null),
      el('div', { class: 'r-flist' }, cells.map((c, i) => (i === 0 && c.label === cols[0] && !c.value ? null : fieldLine({ code: '', label: c.label, value: c.value, unit: '', status: c.status, fill: c.fill || row.fill })))));
  }
  function blockNode(b) {
    if (b.type === 'text') return b.text ? el('p', { class: 'note', text: b.text }) : null;
    if (b.type === 'fields') return el('div', { class: 'r-flist' }, b.items.map(fieldLine));
    return el('div', { class: 'r-rows' }, b.rows.length ? b.rows.map((r) => rowCard(r, b.columns)) : el('p', { class: 'muted', text: '（無資料）' }));
  }
  async function filingTab() {
    const r = await api(`/api/inv/report/filing?${q()}`);
    if (oldBackend(r)) return oldBackendNote();
    if (!r.body?.ok) throw new Error(errMsg(r));
    const F = r.body;
    const nav = el('nav', { class: 'r-toc', 'aria-label': '章節' }, F.tables.map((t) => el('a', { href: `#r-fl-${t.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`r-fl-${t.id}`)?.scrollIntoView({ block: 'start' }); } }, t.label, t.missingCount ? el('span', { class: 'r-tag r-warn', text: String(t.missingCount) }) : null)));
    const head = el('section', { class: 'r-card' },
      el('h3', { text: `申報對照頁（資料年 ${F.year}）` }),
      el('p', { class: 'note', text: '依新版附表三章節與欄位順序排列（前言、一～十一、附錄二），之後是附件一、附件二。每欄旁的「複製」貼到能源署申報系統對應欄；表格類每列可整列複製。空值標「待補」，按「去填」到填寫處。' }),
      el('p', {}, el('b', { text: `待補 ${F.missingTotal} 項` }), '｜',
        el('span', { class: F.carryover.complete ? 'r-tag r-ok' : 'r-tag r-warn', text: `年度沿用 ${F.carryover.confirmed}/${F.carryover.total}${F.carryover.complete ? ' 已完成' : ' 未完成'}` }), ' ',
        F.carryover.complete ? null : el('button', { type: 'button', class: 'link', text: '去確認', onclick: () => setTab('carry') }), ' ',
        el('a', { class: 'r-btn', href: `/api/inv/report/bundle?${q()}`, download: '' , text: '下載整包（zip）' })),
      el('details', { class: 'r-tocwrap' }, el('summary', { text: '章節目錄' }), nav));
    const cards = F.tables.map((t) => el('section', { class: 'r-card', id: `r-fl-${t.id}` },
      el('div', { class: 'r-cardhead' }, el('h3', { text: t.label }),
        t.missingCount ? el('span', { class: 'r-tag r-warn', text: `待補 ${t.missingCount}` }) : el('span', { class: 'r-tag r-ok', text: '已齊' })),
      el('div', { class: 'r-actions' },
        el('a', { class: 'link', href: `/api/inv/report/table/${t.id}?${q()}&format=xlsx`, download: '', text: '此表 xlsx' }),
        el('a', { class: 'link', href: `/api/inv/report/table/${t.id}?${q()}&format=csv`, download: '', text: '此表 CSV' }),
        fillBtn(t.fill, '填寫處')),
      t.sheets.map((s) => el('div', { class: 'r-sheet' },
        t.sheets.length > 1 || s.title !== t.label ? el('h4', { text: s.title }) : null,
        s.source ? srcNode(s.source) : null,
        s.blocks.map(blockNode))),
      t.missing.length ? el('details', { class: 'r-misssheet' }, el('summary', { text: `待補欄位（${t.missing.length}）` }),
        el('ul', {}, t.missing.map((m) => el('li', {}, el('b', { text: m.field }), m.why ? `：${m.why}` : '')))) : null));
    return el('div', { class: 'r-wrap' }, head, ...cards);
  }

  // ── 單表匯出 ──
  async function tablesTab() {
    const r = await api(`/api/inv/report/table?${q()}`);
    if (oldBackend(r)) return oldBackendNote();
    if (!r.body?.ok) throw new Error(errMsg(r));
    const groups = new Map();
    for (const t of r.body.tables) { const k = t.kind === 'annex3' ? '附表三 年度申報' : t.kind === 'diagnosis' ? '附件一 節能診斷報告' : '附件二 節能計畫'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    return el('div', { class: 'r-wrap' },
      el('section', { class: 'r-card' },
        el('h3', { text: `單表匯出（資料年 ${r.body.year}）` }),
        el('p', { class: 'note', text: '每張表可單獨下載 xlsx（含該表的待補欄位）或 CSV（UTF-8，Excel 可直接開）。內容與整本報表同一份。' }),
        el('div', { class: 'r-actions' },
          el('a', { class: 'r-btn', href: `/api/inv/report/bundle?${q()}`, download: '', text: '下載整包（每張表 CSV＋三本 xlsx）' }),
          el('a', { class: 'link', href: `/api/inv/report/plan-export?format=xlsx`, download: '', text: '節能計畫匯出檔（欄位齊全）' }))),
      [...groups].map(([g, list]) => el('section', { class: 'r-card' }, el('h3', { text: g }),
        el('ul', { class: 'r-tlist' }, list.map((t) => el('li', {},
          el('span', { class: 'r-tname' }, el('b', { text: t.label }), ' ', el('span', { class: 'muted', text: t.id }), t.sheets > 1 ? el('span', { class: 'muted', text: `（${t.sheets} 張）` }) : null),
          t.missing ? el('span', { class: 'r-tag r-warn', text: `待補 ${t.missing}` }) : el('span', { class: 'r-tag r-ok', text: '已齊' }),
          el('a', { class: 'link', href: `/api/inv/report/table/${t.id}?${q()}&format=xlsx`, download: '', text: 'xlsx' }),
          el('a', { class: 'link', href: `/api/inv/report/table/${t.id}?${q()}&format=csv`, download: '', text: 'CSV' })))))));
  }

  // ── 報表資料輸入（年度） ──
  function annualInput(f, value, set, refs) {
    const id = `r-a-${Math.random().toString(36).slice(2, 8)}`;
    let input;
    const opt = (v, t, sel) => el('option', { value: v, text: t, selected: sel });
    if (f.type === 'select') input = el('select', { id }, opt('', '—'), f.options.map((o) => opt(o, f.optionLabels?.[o] ? `${o} ${f.optionLabels[o]}` : o, String(value ?? '') === o)));
    else if (f.type === 'monthNo') input = el('select', { id }, opt('', '—'), Array.from({ length: 12 }, (_, i) => opt(String(i + 1), `${i + 1} 月`, Number(value) === i + 1)));
    else if (f.type === 'ref') input = el('select', { id }, opt('', '—'), (refs?.[f.ref] || []).map((o) => opt(o.id, o.label, value === o.id)));
    else if (f.type === 'boolean') input = el('select', { id }, opt('', '—'), opt('true', '是', value === true), opt('false', '否', value === false));
    else if (f.type === 'multiselect') {
      const cur = new Set(value || []);
      input = el('div', { class: 'r-checks-inline', id }, f.options.map((o) => { const c = el('input', { type: 'checkbox', checked: cur.has(o) }); c.addEventListener('change', () => { if (c.checked) cur.add(o); else cur.delete(o); set([...cur]); }); return el('label', { class: 'r-inline' }, c, o); }));
      return el('div', { class: 'r-field' }, el('span', { class: 'r-flabel', text: f.label }), input, f.hint ? el('span', { class: 'note', text: f.hint }) : null);
    } else if (f.max && f.max > 500) { input = el('textarea', { id, rows: 2 }); input.value = value ?? ''; }
    else input = el('input', { id, type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', step: f.type === 'number' ? 'any' : undefined, value: value ?? '' });
    const read = () => (f.type === 'boolean' ? (input.value === '' ? '' : input.value === 'true') : f.type === 'monthNo' ? (input.value === '' ? '' : Number(input.value)) : input.value);
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => set(read()));
    return el('label', { class: 'r-field', for: id }, el('span', { class: 'r-flabel', text: `${f.label}${f.unit ? `（${f.unit}）` : ''}${f.required ? ' *' : ''}` }), input, f.hint ? el('span', { class: 'note', text: f.hint }) : null);
  }
  function annualBlock(b, AN) {
    const cur = AN.data[b.id];
    let draft = JSON.parse(JSON.stringify(cur ?? (b.kind === 'form' ? {} : [])));
    if (b.kind === 'months') draft = Array.from({ length: 12 }, (_, i) => draft.find((r) => r.month === i + 1) || { month: i + 1 });
    const box = el('div');
    const fields = b.fields.filter((f) => !(b.kind === 'months' && f.key === 'month'));
    const draw = () => {
      box.textContent = '';
      if (b.kind === 'form') { box.append(el('div', { class: 'r-grid' }, b.fields.map((f) => annualInput(f, draft[f.key], (v) => { draft[f.key] = v; }, AN.refs)))); return; }
      if (b.kind === 'months') {
        const t = el('table', { class: 'r-mtable' }, el('thead', {}, el('tr', {}, el('th', { text: '月份' }), fields.map((f) => el('th', { text: `${f.label}${f.unit ? `（${f.unit}）` : ''}` })))),
          el('tbody', {}, draft.map((r) => el('tr', {}, el('th', { text: `${r.month} 月` }), fields.map((f) => { const i = el('input', { type: 'number', step: 'any', value: r[f.key] ?? '', 'aria-label': `${r.month} 月 ${f.label}` }); i.addEventListener('input', () => { r[f.key] = i.value; }); return el('td', {}, i); })))));
        box.append(el('div', { class: 'r-tablewrap' }, t));
        return;
      }
      draft.forEach((r, i) => box.append(el('div', { class: 'r-arow' }, el('div', { class: 'r-grid' }, b.fields.map((f) => annualInput(f, r[f.key], (v) => { r[f.key] = v; }, AN.refs))),
        el('button', { type: 'button', class: 'link danger', text: '移除這筆', onclick: () => { draft.splice(i, 1); draw(); } }))));
      box.append(el('button', { type: 'button', text: '＋ 新增一筆', onclick: () => { draft.push({}); draw(); } }));
    };
    draw();
    const msg = el('p', { class: 'err' });
    const meta = AN.meta?.[b.id];
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length)));
    const save = async () => {
      msg.textContent = '';
      let value = draft;
      if (b.kind === 'months') value = draft.map(clean).filter((r) => Object.keys(r).length > 1);
      else if (b.kind === 'table') value = draft.map(clean);
      else value = clean(draft);
      const r = await send('PUT', `/api/inv/report/annual/${b.id}?${q()}`, { value });
      if (!r.body?.ok) { msg.textContent = errMsg(r); return; }
      toast(r.body.warnings?.length ? `已儲存（提示：${r.body.warnings.join('；')}）` : '已儲存', r.body.warnings?.length ? 'warn' : 'ok');
      render();
    };
    const prevHas = AN.prev?.[b.id] && (Array.isArray(AN.prev[b.id]) ? AN.prev[b.id].length : Object.keys(AN.prev[b.id]).length);
    return el('details', { class: 'r-card r-anblock', id: `r-an-${b.id}`, open: PENDING_FOCUS === `r-an-${b.id}` },
      el('summary', {}, el('b', { text: b.label }), ' ',
        (Array.isArray(cur) ? cur.length : Object.keys(cur || {}).length) ? el('span', { class: 'r-tag r-ok', text: '已填' }) : el('span', { class: 'r-tag r-na', text: '未填' }),
        b.stable ? el('span', { class: 'r-tag', text: '可沿用前一年' }) : null),
      srcNode(b.source),
      meta ? el('p', { class: 'note', text: `上次儲存：${new Date(meta.at).toLocaleString('zh-TW', { hour12: false })}｜${meta.who}` }) : null,
      b.stable && prevHas && !(Array.isArray(cur) ? cur.length : Object.keys(cur || {}).length) ? el('p', { class: 'note' }, `${YEAR - 1} 年有資料，可到「年度沿用」一鍵沿用。`, el('button', { type: 'button', class: 'link', text: '前往', onclick: () => setTab('carry') })) : null,
      box, el('div', { class: 'r-actions' }, el('button', { type: 'button', class: 'primary', text: '儲存', onclick: save })), msg);
  }
  async function annualTab() {
    const r = await api(`/api/inv/report/annual?${q()}`);
    if (oldBackend(r)) return oldBackendNote();
    if (!r.body?.ok) throw new Error(errMsg(r));
    const AN = r.body;
    const byTable = new Map();
    for (const b of AN.spec.blocks) { if (!byTable.has(b.table)) byTable.set(b.table, []); byTable.get(b.table).push(b); }
    return el('div', { class: 'r-wrap' },
      el('section', { class: 'r-card' }, el('h3', { text: `報表資料輸入（資料年 ${AN.year}）` }),
        el('p', { class: 'note', text: '附表三裡每年要重填、初始建檔與點位紀錄推不出來的欄位。電號、建築、鍋爐、填表人都從既有資料選，不重打。存了就會出現在申報對照頁與匯出檔。' })),
      [...byTable.values()].flat().map((b) => annualBlock(b, AN)));
  }

  // ── 年度沿用 ──
  function diffNode(u) {
    if (!u.hasPrev) return el('p', { class: 'note', text: u.kind === 'annual' ? `${YEAR - 1} 年沒有這個區塊的資料。` : `${YEAR - 1} 年沒有確認快照（第一次申報），請確認目前資料就是 ${YEAR} 年的資料。` });
    const d = u.diff;
    if (!d || !d.count) return el('p', { class: 'note', text: u.empty && u.prevEmpty ? '兩年都沒有資料。' : `與 ${YEAR - 1} 年相同。` });
    const li = (t) => el('li', { text: t });
    return el('ul', { class: 'r-diff' },
      d.changed.map((c) => li(`${c.label}：${c.before || '（空）'} → ${c.after || '（空）'}`)),
      d.added.map((x) => li(`新增：${x.title || x.id}`)),
      d.removed.map((x) => li(`移除：${x.title || x.id}`)),
      d.rows.map((x) => el('li', {}, `修改：${x.title || x.id}`, el('ul', {}, x.fields.map((c) => li(`${c.label}：${c.before || '（空）'} → ${c.after || '（空）'}`))))));
  }
  async function carryTab() {
    const r = await api(`/api/inv/report/carryover?${q()}`);
    if (oldBackend(r)) return oldBackendNote();
    if (!r.body?.ok) throw new Error(errMsg(r));
    const V = r.body;
    const statusTag = (u) => (u.status === 'confirmed' ? el('span', { class: 'r-tag r-ok', text: '已確認' }) : u.status === 'stale' ? el('span', { class: 'r-tag r-bad', text: '確認後又修改·需重新確認' }) : el('span', { class: 'r-tag r-warn', text: '待確認' }));
    const act = async (u, copy) => {
      const res = await send('POST', `/api/inv/report/carryover/${encodeURIComponent(u.id)}?${q()}`, copy ? { copy: true } : { expectHash: u.hash });
      if (!res.body?.ok) { toast(errMsg(res), 'err'); if (res.status === 409) render(); return; }
      toast(copy ? `已沿用 ${YEAR - 1} 年並確認` : '已確認', 'ok'); render();
    };
    const card = (u) => el('section', { class: `r-card r-carry r-carry-${u.status}` },
      el('div', { class: 'r-cardhead' }, el('h4', { text: u.label }), statusTag(u),
        u.diff && u.diff.count ? el('span', { class: 'r-tag r-warn', text: `差異 ${u.diff.count}` }) : null),
      diffNode(u),
      u.confirmation ? el('p', { class: 'note', text: `${u.status === 'stale' ? '上次' : ''}確認：${new Date(u.confirmation.at).toLocaleString('zh-TW', { hour12: false })}｜${u.confirmation.who}${u.confirmation.copied ? '｜沿用前一年' : ''}` }) : null,
      el('div', { class: 'r-actions' },
        u.canCopy ? el('button', { type: 'button', class: 'primary', text: `沿用 ${YEAR - 1} 年資料並確認`, onclick: () => act(u, true) }) : null,
        u.status !== 'confirmed' && !u.canCopy ? el('button', { type: 'button', class: 'primary', text: u.diff?.count ? `差異已看過，確認 ${YEAR} 年資料` : `確認 ${YEAR} 年沿用`, onclick: () => act(u, false) }) : null,
        u.section ? el('button', { type: 'button', class: 'link', text: '去修改', onclick: () => gotoFill({ section: u.section }) }) : u.kind === 'annual' ? el('button', { type: 'button', class: 'link', text: '去修改', onclick: () => gotoFill({ tab: 'annual', block: u.block }) }) : null));
    return el('div', { class: 'r-wrap' },
      el('section', { class: 'r-card' }, el('h3', { text: `年度沿用（${V.prevYear} → ${V.year} 年）` }),
        el('p', { class: 'note', text: `初始建檔、組織、政策、建築、變壓器、設備主檔等通常不變的資料，新年度逐區塊看過與 ${V.prevYear} 年的差異後按確認，確認人與時間會記下來；確認後又修改的區塊要重新確認。全部確認完才算完成。` }),
        el('p', {}, el('b', { text: `已確認 ${V.confirmed}／${V.total}` }), ' ', V.complete ? el('span', { class: 'r-tag r-ok', text: '完成' }) : el('span', { class: 'r-tag r-warn', text: '未完成' }))),
      V.units.map(card));
  }

  W.EMSInventoryReportUI = {
    async mount(containerEl, ctx) {
      ROOT = containerEl; CTX = ctx || {};
      await render();
      return { refresh: () => refresh() };
    },
  };
})();
