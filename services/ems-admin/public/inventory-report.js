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
        s.spec ? el('p', { class: 'muted', text: `對照 docs/energy-audit-spec.md ${s.spec}` }) : null,
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
    ROOT.append(el('div', { class: 'r-wrap' },
      el('h2', { class: 'r-h', text: '申報與報告' }),
      CTX.reporter ? null : operatorField(),
      deadlinesCard(), diagnosisCard(), measuresCard(), plansCard(), reportsCard()));
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
      input = el('input', { id, type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', step: f.type === 'number' ? 'any' : undefined, value: f.type === 'year' ? rocY(value) : value ?? '' });
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
      el('div', { class: 'r-grid' }, SPEC.planFields.map((f) => fieldInput(f, p.fields[f.key], (x) => { vals[f.key] = x; recompute(); }))),
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
    const year = el('input', { type: 'number', value: nowRoc - 1, min: 100, max: 200, class: 'r-year' });
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

  W.EMSInventoryReportUI = {
    async mount(containerEl, ctx) {
      ROOT = containerEl; CTX = ctx || {};
      await render();
      return { refresh: () => refresh() };
    },
  };
})();
