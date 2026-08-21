'use strict';
// 電力健檢填報的前端（公文附件一／三）。
//
// 與「看板維護」那一套（app.js）刻意分開：欄位來源不同（audit-schema 而非 hospital zod）、
// 儲存位置不同（主機本地而非公開 repo）、送出的門檻也不同（多了複驗與自我檢核）。
// 共用的只有 UI 小工具（window.EMSUI）與計算（window.EMSAuditCompute）。
//
// 三段式版面（每個區塊都一樣）：① 佐證檔案 ② 解析結果 ③ 填報表格／欄位。
// 最重要的規則：解析出來的值一律標成待複驗，**沒複驗完不准送出**。
// 掃描影本的辨識率不可能一直是 100%，這道閘門是院方唯一的保護。

(function () {
  const { el, api, toast, toastHide, confirmModal, closeModal } = window.EMSUI;
  const CALC = window.EMSAuditCompute;

  // ── 狀態 ──
  let SPEC = null;          // { blocks, stages, selfCheck, states }
  let AUDIT = null;         // 編輯中的填報資料
  let ORIG = null;          // 載入當下的快照
  let STATS = {}, STAGES = null, HISTORY = [];
  let EXTRACTION = true, MAX_BYTES = 25 * 1024 * 1024;
  let busy = false;
  let onChange = () => {};  // app.js 註冊：資料變動時更新徽章／導覽

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const blockOf = (id) => (SPEC?.blocks || []).find((b) => b.id === id) || null;
  const colsOf = (b) => (b.kind === 'table' ? b.columns : b.fields);
  const blkData = (id) => (AUDIT.blocks[id] ||= blockOf(id)?.kind === 'table' ? { rows: [] } : { values: {}, meta: {} });

  // ── 對外 ──
  const API = {
    async load() {
      if (!SPEC) {
        const { body } = await api('/api/audit/spec');
        if (!body?.ok) return false;
        SPEC = body.spec; EXTRACTION = body.extraction; MAX_BYTES = body.maxBytes || MAX_BYTES;
      }
      const { body } = await api('/api/audit');
      if (!body?.ok) return false;
      AUDIT = body.audit; ORIG = clone(body.audit);
      STATS = body.stats; STAGES = body.stages; HISTORY = body.history || [];
      return true;
    },
    spec: () => SPEC,
    // 導覽徽章要即時反映「剛剛解析進來、還沒複驗」的狀態，
    // 所以在前端重算，不用載入當下那份伺服器快照（那份只在首次渲染前有意義）。
    stats: () => (AUDIT ? liveStats() : STATS),
    stages: () => STAGES,
    // 未送出的修改數（給頂列徽章用）
    dirtyCount() {
      if (!AUDIT || !ORIG) return 0;
      let n = 0;
      for (const b of SPEC.blocks) {
        const a = JSON.stringify(AUDIT.blocks[b.id] || {});
        const o = JSON.stringify(ORIG.blocks[b.id] || {});
        if (a !== o) n += diffCount(ORIG.blocks[b.id], AUDIT.blocks[b.id], b);
      }
      return n;
    },
    pendingCount() { return pending().length; },
    onChange(fn) { onChange = fn; },
    renderSection, submit, renderStages, discard,
  };
  window.EMSAudit = API;

  function discard() { AUDIT = clone(ORIG); onChange(); }

  function diffCount(o, a, b) {
    if (b.kind === 'form') {
      const ov = o?.values || {}, av = a?.values || {};
      return new Set([...Object.keys(ov), ...Object.keys(av)]).size
        ? [...new Set([...Object.keys(ov), ...Object.keys(av)])].filter((k) => JSON.stringify(ov[k]) !== JSON.stringify(av[k])).length
        : 0;
    }
    const or = o?.rows || [], ar = a?.rows || [];
    let n = Math.abs(ar.length - or.length);
    for (let i = 0; i < Math.min(or.length, ar.length); i++) {
      const ov = or[i]?.values || {}, av = ar[i]?.values || {};
      n += [...new Set([...Object.keys(ov), ...Object.keys(av)])].filter((k) => JSON.stringify(ov[k]) !== JSON.stringify(av[k])).length;
    }
    return n;
  }

  // 各區塊的即時概況（與伺服器 blockStats 同一套判準，只是算的是編輯中的副本）
  function liveStats() {
    const out = {};
    for (const b of SPEC?.blocks || []) {
      const d = AUDIT?.blocks?.[b.id];
      const cols = colsOf(b);
      const required = cols.filter((c) => c.required && !c.computed);
      let rows = 0, filled = 0, missing = 0, todo = 0, low = 0;
      const tally = (values, meta) => {
        for (const c of required) if (values?.[c.key] === undefined || values?.[c.key] === '') missing++;
        for (const m of Object.values(meta || {})) {
          if (m?.state === 'todo') todo++; else if (m?.state === 'low') low++;
        }
        for (const c of cols) if (values?.[c.key] !== undefined && values?.[c.key] !== '') filled++;
      };
      if (b.kind === 'form') { rows = Object.keys(d?.values || {}).length ? 1 : 0; tally(d?.values, d?.meta); }
      else { rows = (d?.rows || []).length; for (const r of d?.rows || []) tally(r.values, r.meta); }
      out[b.id] = { rows, filled, missing, todo, low };
    }
    return out;
  }

  // 所有待複驗的格子（與伺服器端 pendingCells 同一套判準）
  function pending() {
    const out = [];
    for (const b of SPEC?.blocks || []) {
      const d = AUDIT?.blocks?.[b.id];
      if (!d) continue;
      const cols = colsOf(b);
      const scan = (meta, rowIdx) => {
        for (const [k, m] of Object.entries(meta || {})) {
          if (m?.state !== 'todo' && m?.state !== 'low') continue;
          out.push({ block: b.id, blockLabel: b.label, row: rowIdx, key: k, state: m.state, label: cols.find((c) => c.key === k)?.label || k });
        }
      };
      if (b.kind === 'form') scan(d.meta, null);
      else (d.rows || []).forEach((r, i) => scan(r.meta, i));
    }
    return out;
  }

  // ── 值的讀寫 ──
  function setValue(blockId, rowIdx, key, raw) {
    const b = blockOf(blockId);
    const col = colsOf(b).find((c) => c.key === key);
    const d = blkData(blockId);
    const target = b.kind === 'form' ? d : (d.rows[rowIdx] ||= { values: {}, meta: {} });
    target.values ||= {}; target.meta ||= {};

    const v = raw === '' || raw === null || raw === undefined ? undefined
      : (col.type === 'number' || col.type === 'percent') ? numOrRaw(raw) : String(raw);
    if (v === undefined) delete target.values[key]; else target.values[key] = v;

    // 人親手改過就算複驗過了：本來有來源的變 ok（複驗），本來沒有的是 manual（人工填寫）
    const had = target.meta[key]?.source;
    target.meta[key] = had ? { state: 'ok', source: had } : { state: 'manual' };
    if (v === undefined && !had) delete target.meta[key];
    onChange();
  }
  // 數字格：清掉千分位與單位再轉。清乾淨後沒有數字就把原字串留著，
  // 讓驗證去報「必須是數字」——絕不能因為 Number('') === 0 而悄悄變成 0。
  const numOrRaw = (raw) => {
    const cleaned = String(raw).replace(/[^\d.eE+-]/g, '');
    if (!/\d/.test(cleaned)) return String(raw);
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : String(raw);
  };

  function confirmCell(blockId, rowIdx, key) {
    const b = blockOf(blockId);
    const d = blkData(blockId);
    const target = b.kind === 'form' ? d : d.rows[rowIdx];
    const m = target?.meta?.[key];
    if (m && (m.state === 'todo' || m.state === 'low')) { m.state = 'ok'; onChange(); }
  }

  // 一次確認一個範圍。刻意只在畫面上有「捲到底」之後才開放（見 renderVerifyBar），
  // 沒看過就整批按下去，等於解析結果直接生效，那這道閘門就白做了。
  function confirmMany(blockId, rowIdx) {
    const b = blockOf(blockId);
    const d = blkData(blockId);
    const targets = b.kind === 'form' ? [d] : (rowIdx === null ? d.rows : [d.rows[rowIdx]]);
    let n = 0;
    for (const t of targets || []) {
      for (const m of Object.values(t?.meta || {})) if (m.state === 'todo' || m.state === 'low') { m.state = 'ok'; n++; }
    }
    onChange();
    return n;
  }

  // ═══════════════════ 渲染 ═══════════════════
  function renderSection(blockId, root) {
    const b = blockOf(blockId);
    if (!b) { root.append(el('p', { class: 'note', text: '找不到這個區塊。' })); return; }
    blkData(blockId);

    root.append(el('p', { class: 'a-intro' }, [
      el('span', { class: 'a-tag', text: b.attachment }),
      el('span', { text: b.intro || '' }),
    ]));

    if (b.private) {
      root.append(el('div', { class: 'a-privacy' }, [
        el('b', { text: '🔒 這一區的資料不會離開這台主機' }),
        el('span', { text: '姓名、電話、電子郵件只用於本案聯繫與報告交付，不會進入公開的原始碼倉庫，也不會出現在看板上。' }),
      ]));
    }

    if ((b.accepts || []).length) root.append(renderUpload(b));
    root.append(renderParseLog(b));
    root.append(el('h3', { class: 'a-step' }, [el('i', { text: (b.accepts || []).length ? '3' : '1' }), el('span', { text: b.kind === 'table' ? '填報表格' : '填報欄位' })]));
    root.append(b.kind === 'table' ? renderTable(b) : renderForm(b));
    root.append(renderVerifyBar(b));
  }

  // ── ① 佐證檔案 ──
  function renderUpload(b) {
    const box = el('div', { class: 'a-block' });
    box.append(el('h3', { class: 'a-step' }, [el('i', { text: '1' }), el('span', { text: '佐證檔案' })]));

    const kinds = { pdf: 'PDF', image: '照片／掃描影像', xlsx: 'Excel（V2 範本）' };
    const accepts = (b.accepts || []).map((k) => kinds[k]).filter(Boolean).join('、');
    const drop = el('div', { class: 'a-drop' }, [
      el('div', { class: 'a-drop-big', text: `把${b.label}的佐證檔案拖放到這裡` }),
      el('p', { class: 'note', text: EXTRACTION
        ? `接受 ${accepts}。上傳後會自動解析內容並填入下方，你只要逐格複驗。`
        : (b.accepts || []).includes('xlsx')
          // 缺 ANTHROPIC_API_KEY 只影響 PDF／影像；Excel 走的是逐格對照，不需要它
          ? `接受 ${accepts}。Excel（V2 範本）會自動解析；PDF 與影像的自動解析尚未開通，請手動填寫。`
          : `接受 ${accepts}。自動解析尚未開通，上傳只會保存檔案，欄位請手動填寫。` }),
      el('button', { type: 'button', class: 'primary', text: '選擇檔案…' }),
    ]);
    const input = el('input', { type: 'file', class: 'hidden-input', multiple: true,
      accept: '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.csv' });
    drop.querySelector('button').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { doUpload(b, [...input.files]); input.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('over');
      doUpload(b, [...(e.dataTransfer?.files || [])]);
    });
    box.append(drop, input);

    const files = (AUDIT.files || []).filter((f) => f.block === b.id);
    const list = el('ul', { class: 'a-files' });
    for (const f of files) list.append(fileRow(f));
    if (!files.length) list.append(el('li', { class: 'note', text: '尚未上傳任何佐證檔案。' }));
    box.append(list);
    return box;
  }

  function fileRow(f) {
    const p = f.parse || {};
    const pill = p.state === 'done'
      ? el('span', { class: 'a-pill ' + (p.low ? 'warn' : 'ok'),
          text: `已解析 · ${p.rows || 0} 筆 · ${p.cells || 0} 格${p.low ? ` · ${p.low} 格信心低` : ''}` })
      : p.state === 'failed'
        ? el('span', { class: 'a-pill err', text: '解析失敗' })
        : el('span', { class: 'a-pill busy', text: '未解析' });

    const row = el('li', { class: 'a-filerow' }, [
      el('span', { class: 'a-fico', text: f.kind === 'xlsx' ? '📊' : f.kind === 'image' ? '🖼' : '📄' }),
      el('span', { class: 'a-fname', text: f.displayName }),
      el('span', { class: 'a-forig', text: `原檔：${f.originalName} · ${Math.round(f.size / 1024)} KB` }),
      el('span', { class: 'grow' }),
      pill,
      el('a', { class: 'a-flink', href: `/api/audit/file?id=${encodeURIComponent(f.id)}`, target: '_blank', rel: 'noopener', text: '檢視' }),
    ]);
    const del = el('button', { type: 'button', class: 'link danger', text: '移除' });
    del.addEventListener('click', async () => {
      if (!(await confirmModal({ title: `移除「${f.displayName}」？`, body: '檔案會從主機刪除。已經填進表格的值不會跟著消失。', okText: '移除', danger: true }))) return;
      const { body } = await api('/api/audit/file/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' },
        body: JSON.stringify({ id: f.id }),
      });
      if (body?.ok) { AUDIT.files = (AUDIT.files || []).filter((x) => x.id !== f.id); ORIG.files = AUDIT.files; onChange(); }
      else toast('移除失敗', 'err');
    });
    row.append(del);
    if (p.state === 'failed' && p.message) row.append(el('p', { class: 'a-fnote err', text: p.message }));
    else if (p.notes) row.append(el('p', { class: 'a-fnote', text: p.notes }));
    return row;
  }

  async function doUpload(b, files) {
    if (!files.length || busy) return;
    for (const file of files) {
      if (file.size > MAX_BYTES) { toast(`「${file.name}」超過 ${Math.round(MAX_BYTES / 1024 / 1024)} MB 上限`, 'err'); continue; }
      busy = true;
      toast(`上傳「${file.name}」並解析中…（掃描件可能要一分鐘）`, 'busy');
      const fd = new FormData();
      fd.append('block', b.id);
      fd.append('period', '');
      fd.append('file', file, file.name);
      let r;
      try { r = await api('/api/audit/upload', { method: 'POST', headers: { 'X-Requested-With': 'ems-admin' }, body: fd }); }
      catch { toast('上傳失敗（網路問題）', 'err'); busy = false; continue; }
      busy = false;
      const { status, body } = r;
      if (status === 413) { toast('檔案太大', 'err'); continue; }
      if (!body?.ok) { toast('上傳失敗：' + (body?.message || body?.error || status), 'err'); continue; }

      AUDIT.files = [...(AUDIT.files || []), body.file];
      ORIG.files = AUDIT.files;
      if (body.parseError) {
        toastHide();
        await confirmModal({
          title: '檔案已上傳，但沒有解析成功',
          body: `${body.parseError.message}\n\n這個區塊的欄位請直接手動輸入。`,
          okText: '知道了', cancelText: '',
        });
      } else if (body.rows?.length) {
        await mergeParsed(b, body);
      } else {
        toast('這個檔案沒有解析到可填入的內容，請確認上傳的是正確的文件', 'warn');
      }
      onChange();
    }
  }

  // 解析結果併進資料：**一律當成新的待複驗值**，不覆寫院方已經複驗過的格子。
  async function mergeParsed(b, body) {
    const d = blkData(b.id);
    let added = 0, skipped = 0;
    if (b.kind === 'form') {
      const r = body.rows[0] || { values: {}, meta: {} };
      for (const [k, v] of Object.entries(r.values)) {
        if (d.meta?.[k]?.state === 'ok' || d.meta?.[k]?.state === 'manual') { skipped++; continue; }
        d.values[k] = v; d.meta[k] = r.meta[k]; added++;
      }
    } else {
      const key = b.keyColumn;
      for (const r of body.rows) {
        // 有鍵欄（電費單的計費期間）時，同一期已經存在就併進去，不製造重複列
        const idx = key && r.values[key] ? (d.rows || []).findIndex((x) => x.values?.[key] === r.values[key]) : -1;
        if (idx >= 0) {
          const t = d.rows[idx];
          for (const [k, v] of Object.entries(r.values)) {
            if (t.meta?.[k]?.state === 'ok' || t.meta?.[k]?.state === 'manual') { skipped++; continue; }
            t.values[k] = v; t.meta[k] = r.meta[k]; added++;
          }
        } else {
          d.rows.push({ values: r.values, meta: r.meta });
          added += Object.keys(r.values).length;
        }
      }
    }
    toastHide();
    const s = body.stats || {};
    await confirmModal({
      title: '解析完成，請逐格複驗',
      node: el('div', {}, [
        el('p', { text: `從這個檔案解析出 ${s.rows || 0} 筆、${added} 個欄位值。` }),
        s.low ? el('p', { class: 'a-warnline', text: `其中 ${s.low} 格信心較低（⚠️），一定要對照原文核對。` }) : null,
        skipped ? el('p', { class: 'note', text: `另有 ${skipped} 格因為你已經填過或複驗過，這次沒有覆蓋。` }) : null,
        body.notes ? el('p', { class: 'a-parsenote', text: body.notes }) : null,
        el('p', { class: 'note', text: '這些值目前都標成「待複驗」，在你逐格確認之前無法送出。' }),
      ]),
      okText: '開始複驗', cancelText: '',
    });
  }

  // ── ② 解析結果條 ──
  function renderParseLog(b) {
    const box = el('div', { class: 'a-block' });
    if (!(b.accepts || []).length) return box;
    box.append(el('h3', { class: 'a-step' }, [el('i', { text: '2' }), el('span', { text: '解析結果' })]));

    const list = pending().filter((p) => p.block === b.id);
    const todo = list.filter((p) => p.state === 'todo').length;
    const low = list.filter((p) => p.state === 'low').length;
    const files = (AUDIT.files || []).filter((f) => f.block === b.id && f.parse?.state === 'done');
    const cells = files.reduce((n, f) => n + (f.parse.cells || 0), 0);

    if (!files.length) {
      box.append(el('p', { class: 'note', text: '還沒有解析過任何檔案。你也可以直接在下方手動輸入。' }));
      return box;
    }
    const bar = el('div', { class: 'a-parsebar' + (list.length ? '' : ' clear') }, [
      el('span', { class: 'a-parse-t', text: `${files.length} 個檔案 · 解析出 ${cells} 個欄位值` }),
      todo ? el('span', { class: 'a-pill warn', text: `🟡 待複驗 ${todo}` }) : null,
      low ? el('span', { class: 'a-pill warn', text: `⚠️ 信心低 ${low}` }) : null,
      list.length ? null : el('span', { class: 'a-pill ok', text: '✅ 這一區已全部複驗' }),
    ]);
    box.append(bar);
    box.append(el('p', { class: 'note', text: '解析結果一律不直接生效。每一格都要人看過確認，未複驗的格子會擋住送出。' }));
    return box;
  }

  // ── ③ 表單（單筆區塊） ──
  function renderForm(b) {
    const d = blkData(b.id);
    const box = el('div', { class: 'a-panel' });
    for (const f of b.fields) {
      const m = d.meta?.[f.key];
      const val = d.values?.[f.key];
      const ctl = inputFor(f, val, (v) => setValue(b.id, null, f.key, v));
      const row = el('div', { class: 'field a-field ' + stateClass(m), 'data-acell': `${b.id}//${f.key}` }, [
        el('label', { class: 'flabel' }, [
          el('span', { text: f.label + (f.unit ? `（${f.unit}）` : '') }),
          f.required ? el('em', { class: 'a-req', text: '必填' }) : null,
        ]),
        el('div', { class: 'fctl' }, [
          ctl,
          f.hint ? el('div', { class: 'note', text: f.hint }) : null,
          stateNote(m, b.id, null, f.key),
        ]),
      ]);
      box.append(row);
    }
    return box;
  }

  let dlSeq = 0;   // datalist 的 id 必須唯一，否則同一欄在 12 列裡會撞成同一個
  function inputFor(f, val, on) {
    if (f.type === 'select') {
      // input.list 是唯讀屬性（只有 getter），一定要走 setAttribute，
      // 直接指派會丟 TypeError 讓整個表格渲染中斷——實測踩過。
      const wrap = el('div', { class: 'a-selectwrap' });
      const id = `dl-${++dlSeq}`;
      const inp = el('input', { type: 'text', value: val ?? '', placeholder: '可自由填寫或從建議中挑選' });
      inp.setAttribute('list', id);
      const dl = el('datalist', { id });
      for (const o of f.options || []) dl.append(el('option', { value: o }));
      inp.addEventListener('change', () => on(inp.value));
      wrap.append(inp, dl);
      return wrap;
    }
    const type = f.type === 'date' ? 'date' : f.type === 'month' ? 'month' : (f.type === 'number' || f.type === 'percent') ? 'number' : 'text';
    const inp = el('input', { type, value: val ?? '' });
    if (type === 'number') inp.step = 'any';
    inp.addEventListener('change', () => on(inp.value));
    return inp;
  }

  const stateClass = (m) => (m?.state === 'todo' ? 'st-todo' : m?.state === 'low' ? 'st-low' : m?.state === 'ok' ? 'st-ok' : m?.state === 'manual' ? 'st-manual' : '');
  const MARK = { todo: '🟡', low: '⚠️', ok: '✅', manual: '✏️' };

  function stateNote(m, blockId, rowIdx, key) {
    if (!m) return null;
    const src = m.source;
    const where = src ? `${src.name || '佐證檔'}${src.page ? ` · 第 ${src.page} 頁` : ''}` : '人工填寫';
    const wrap = el('div', { class: 'a-srcnote' }, [
      el('span', { class: 'a-mark', text: MARK[m.state] || '' }),
      el('span', { text: `${SPEC.states[m.state]?.label || m.state}｜${where}` }),
    ]);
    if (src?.file) {
      wrap.append(el('a', { class: 'a-flink', href: `/api/audit/file?id=${encodeURIComponent(src.file)}#page=${src.page || 1}`, target: '_blank', rel: 'noopener', text: '開啟對照 ↗' }));
    }
    if (m.state === 'todo' || m.state === 'low') {
      const ok = el('button', { type: 'button', class: 'a-okbtn', text: '✓ 這格沒問題' });
      ok.addEventListener('click', () => { confirmCell(blockId, rowIdx, key); });
      wrap.append(ok);
    }
    return wrap;
  }

  // ── ③ 表格（多筆區塊） ──
  function renderTable(b) {
    const d = blkData(b.id);
    const cols = b.columns;
    const wrap = el('div', { class: 'a-tablewrap' });
    const table = el('table', { class: 'a-table' });

    // 兩列表頭：第一列是欄位分組（契約與需量／計費度數／費用…），第二列才是欄位
    const groups = [];
    for (const c of cols) {
      const g = c.group || '';
      const last = groups[groups.length - 1];
      if (last && last.g === g) last.n++; else groups.push({ g, n: 1 });
    }
    const thead = el('thead');
    const gr = el('tr');
    gr.append(el('th', { class: 'a-th-idx', rowSpan: 2, text: '#' }));
    for (const g of groups) gr.append(el('th', { class: 'a-th-grp', colSpan: g.n, text: g.g }));
    gr.append(el('th', { class: 'a-th-act', rowSpan: 2, text: '' }));
    const cr = el('tr');
    for (const c of cols) {
      cr.append(el('th', { class: `a-col-${c.width || 'n'}${c.computed ? ' a-computed' : ''}`, title: c.hint || '' }, [
        el('span', { text: c.label }),
        c.unit ? el('i', { class: 'a-unit', text: c.unit }) : null,
        c.required ? el('em', { class: 'a-req', text: '＊' }) : null,
      ]));
    }
    thead.append(gr, cr);
    table.append(thead);

    const tbody = el('tbody');
    (d.rows || []).forEach((r, i) => tbody.append(tableRow(b, r, i)));
    if (!(d.rows || []).length) {
      tbody.append(el('tr', {}, [el('td', { class: 'a-empty', colSpan: cols.length + 2,
        text: `尚未有任何${b.rowLabel || '資料'}。上傳佐證檔案自動帶入，或按下方「＋ 新增一筆」手動輸入。` })]));
    }
    table.append(tbody);

    // 表尾合計
    const totals = CALC.computeTotals(cols, d.rows || []);
    if (Object.keys(totals).length) {
      const tf = el('tfoot');
      const tr = el('tr');
      tr.append(el('th', { text: `合計（${(d.rows || []).length} 筆）` }));
      for (const c of cols) tr.append(el('td', { class: 'a-numcell', text: totals[c.key] === undefined ? '' : fmt(totals[c.key]) }));
      tr.append(el('td'));
      tf.append(tr);
      table.append(tf);
    }
    wrap.append(table);

    const tools = el('div', { class: 'a-tools' });
    const add = el('button', { type: 'button', text: `＋ 新增一筆${b.rowLabel || ''}` });
    add.addEventListener('click', () => {
      if (b.max && (d.rows || []).length >= b.max) { toast(`「${b.label}」最多 ${b.max} 筆`, 'warn'); return; }
      d.rows.push({ values: {}, meta: {} });
      onChange();
    });
    tools.append(add, el('span', { class: 'note', text: '提示：在任一格貼上（Ctrl+V）從 Excel 複製的整塊資料，會自動往右往下填。' }));
    wrap.append(tools);
    return wrap;
  }

  function tableRow(b, r, i) {
    const cols = b.columns;
    const computed = CALC.computeRow(cols, r.values || {});
    const tr = el('tr');
    tr.append(el('th', { class: 'a-th-idx', text: String(i + 1) }));
    cols.forEach((c, ci) => {
      const m = r.meta?.[c.key];
      const td = el('td', { class: `a-cell ${stateClass(m)}${c.computed ? ' a-computed' : ''}`, 'data-acell': `${b.id}/${i}/${c.key}` });
      if (c.computed) {
        td.append(el('span', { class: 'a-num', text: computed[c.key] === undefined ? '—' : fmt(computed[c.key]) }));
        td.append(el('span', { class: 'a-cellsrc', text: '自動計算' }));
      } else {
        const inp = inputFor(c, r.values?.[c.key], (v) => setValue(b.id, i, c.key, v));
        const inner = inp.tagName === 'DIV' ? inp.querySelector('input') : inp;
        inner.classList.add('a-in');
        inner.addEventListener('paste', (e) => onPaste(e, b, i, ci));
        td.append(inp);
        if (m) {
          const src = m.source;
          const label = src ? `${MARK[m.state]} ${src.page ? `p.${src.page}` : (src.name || '')}` : MARK[m.state];
          const tag = el('button', {
            type: 'button', class: 'a-cellsrc a-cellbtn',
            title: src ? `${SPEC.states[m.state]?.label}｜${src.name || ''}${src.page ? ` 第 ${src.page} 頁` : ''}（點一下標記為已複驗）` : SPEC.states[m.state]?.label,
            text: label,
          });
          tag.addEventListener('click', () => confirmCell(b.id, i, c.key));
          td.append(tag);
        }
      }
      tr.append(td);
    });

    const act = el('td', { class: 'a-th-act' });
    const rowPending = Object.values(r.meta || {}).filter((m) => m.state === 'todo' || m.state === 'low').length;
    if (rowPending) {
      const okAll = el('button', { type: 'button', class: 'link', text: `✓ 整列（${rowPending}）` });
      okAll.addEventListener('click', () => confirmMany(b.id, i));
      act.append(okAll);
    }
    const del = el('button', { type: 'button', class: 'link danger', text: '刪除' });
    del.addEventListener('click', async () => {
      const key = b.keyColumn ? r.values?.[b.keyColumn] : null;
      if (!(await confirmModal({ title: `刪除第 ${i + 1} 筆${key ? `（${key}）` : ''}？`, body: '這筆資料會從填報中移除。', okText: '刪除', danger: true }))) return;
      blkData(b.id).rows.splice(i, 1);
      onChange();
    });
    act.append(del);
    tr.append(act);
    return tr;
  }

  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('zh-TW', { maximumFractionDigits: 3 }) : String(v ?? ''));

  // 從 Excel 貼一整塊：院方手上就是那張表，逐格敲兩百多個數字沒有人會做完
  function onPaste(e, b, rowIdx, colIdx) {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!/[\t\n]/.test(text)) return;          // 單一格的貼上維持瀏覽器預設
    e.preventDefault();
    const cols = b.columns;
    const d = blkData(b.id);
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length);
    lines.forEach((line, dr) => {
      const cells = line.split('\t');
      const ri = rowIdx + dr;
      while ((d.rows || []).length <= ri) d.rows.push({ values: {}, meta: {} });
      cells.forEach((cell, dc) => {
        const c = cols[colIdx + dc];
        if (!c || c.computed) return;
        setValue(b.id, ri, c.key, cell.trim());
      });
    });
    toast(`已貼上 ${lines.length} 列`, 'ok');
    onChange();
  }

  // ── 複驗攔截條 ──
  // 「全部確認」故意要捲到底才啟用：沒看過就整批按下去，這道閘門等於沒有。
  function renderVerifyBar(b) {
    const list = pending().filter((p) => p.block === b.id);
    if (!list.length) return el('div', { class: 'a-verify ok' }, [el('b', { text: '✅ 這一區已全部複驗' })]);

    const todo = list.filter((p) => p.state === 'todo').length;
    const low = list.filter((p) => p.state === 'low').length;
    const bar = el('div', { class: 'a-verify' }, [
      el('b', { text: '⛔ 這一區還不能送出' }),
      el('span', { text: `還有 ${todo} 格待複驗${low ? `、${low} 格信心低` : ''}。逐格確認，或點每一格上的標記。` }),
    ]);
    const all = el('button', { type: 'button', class: 'primary', text: `全部確認這 ${list.length} 格`, disabled: true });
    all.addEventListener('click', async () => {
      if (!(await confirmModal({
        title: `確認這 ${list.length} 格都核對過了？`,
        body: '按下去等於你已經對照佐證檔案看過每一個值。送出後這些數字會進入健檢報告，其中的彙總數字還會公開顯示在看板上。',
        okText: '我已核對，全部確認',
      }))) return;
      confirmMany(b.id, null);
    });
    const hint = el('span', { class: 'note', text: '（請先捲到表格底部再使用）' });
    bar.append(all, hint);

    // 捲到底才解鎖
    const unlock = () => {
      const pane = document.querySelector('.pane');
      if (!pane) return;
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 80) {
        all.disabled = false;
        hint.textContent = '';
        pane.removeEventListener('scroll', unlock);
      }
    };
    requestAnimationFrame(() => {
      const pane = document.querySelector('.pane');
      pane?.addEventListener('scroll', unlock);
      unlock();
    });
    return bar;
  }

  // ── 附件二：九階段進度 ──
  function renderStages(host) {
    if (!SPEC || !STAGES) return;
    host.textContent = '';
    host.className = 'stagesbar';
    for (const s of SPEC.stages) {
      const done = STAGES.done[s.id];
      const now = STAGES.current === s.id;
      const cls = ['stage', done ? 'done' : '', now ? 'now' : '', s.owner === 'org' ? 'them' : ''].filter(Boolean).join(' ');
      host.append(el('div', { class: cls, title: `完成條件：${s.done}｜負責：${s.owner === 'org' ? '專案執行單位' : s.owner === 'both' ? '雙方' : '院方'}` }, [
        el('i', { class: 'dot' }),
        el('span', { text: s.label }),
        now ? el('b', { class: 'a-here', text: '← 你在這' }) : null,
      ]));
    }
  }

  // ── 送出 ──
  async function submit() {
    if (busy) return;
    const pend = pending();
    if (pend.length) {
      const box = el('div', {}, [
        el('p', { text: `還有 ${pend.length} 個格子沒有複驗，解析出來的值不能直接送出。點擊項目可跳到該格：` }),
        ...pend.slice(0, 60).map((p) => {
          const bt = el('button', { type: 'button', class: 'errhit' }, [
            el('span', { class: 'hit-label', text: `${p.blockLabel}${p.row === null ? '' : ` 第 ${p.row + 1} 筆`} › ${p.label}` }),
            el('span', { class: 'hit-val', text: SPEC.states[p.state]?.label || p.state }),
          ]);
          bt.addEventListener('click', () => { closeModal(false); window.EMSUI.gotoAuditCell(p); });
          return bt;
        }),
      ]);
      if (pend.length > 60) box.append(el('p', { class: 'note', text: `…另有 ${pend.length - 60} 格未列出` }));
      return confirmModal({ title: '還有未複驗的格子', node: box, okText: '知道了', cancelText: '' });
    }

    // 附件三：送出前自我檢核
    const checks = [];
    const body = el('div', {}, [el('p', { text: '這次送出的填報會存入健檢系統，其中的彙總數字會自動同步到看板（公開顯示）。' })]);
    const sum = summaryNode();
    if (sum) body.append(sum);
    body.append(el('h3', { class: 'a-checkhead', text: '送出前自我檢核（附件三）' }));
    const okBtn = () => document.getElementById('modalOk');
    const refresh = () => { const b = okBtn(); if (b) { const n = checks.filter(Boolean).length; b.disabled = n < SPEC.selfCheck.length; b.textContent = n < SPEC.selfCheck.length ? `送出填報（尚有 ${SPEC.selfCheck.length - n} 項未確認）` : '送出填報'; } };
    SPEC.selfCheck.forEach((t, i) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { checks[i] = cb.checked; refresh(); });
      body.append(el('label', { class: 'a-chk' }, [cb, el('span', { text: t })]));
    });
    setTimeout(refresh, 0);
    if (!(await confirmModal({ title: '送出填報', node: body, okText: '送出填報', wide: true }))) return;

    busy = true;
    toast('送出中…', 'busy');
    const selfCheck = SPEC.selfCheck.map((_, i) => i).filter((i) => checks[i]);
    let res;
    try {
      res = await api('/api/audit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems-admin' },
        body: JSON.stringify({ audit: AUDIT, selfCheck }),
      });
    } catch { toast('送出失敗（網路問題），請再試一次', 'err'); busy = false; return; }
    busy = false;

    const { status, body: b } = res;
    if (status === 422) { toastHide(); return showErrors('格式檢查未通過', b?.details || []); }
    if (status === 409) { toastHide(); return confirmModal({ title: '尚未通過送出前檢查', body: b?.message || '請補齊後再送出。', okText: '知道了', cancelText: '' }); }
    if (!b?.ok) { toast('送出失敗：' + (b?.message || b?.error || status), 'err'); return; }

    ORIG = clone(AUDIT);
    STATS = b.stats; STAGES = b.stages;
    onChange();
    toastHide();

    const syncMsg = b.sync?.ok
      ? (b.sync.unchanged ? '看板彙總數字沒有變化，不需要更新。' : `看板已同步 ${b.sync.panels} 個面板，約 1–2 分鐘後上線。`)
      : `⚠️ 填報已存好，但看板同步沒有成功（${b.sync?.reason || '未知原因'}）。請聯絡維護窗口，填報資料不受影響。`;
    await confirmModal({
      title: '✅ 填報已送出',
      node: el('div', {}, [
        el('p', { text: `已存入健檢系統（${b.commit || '無變更'}）。` }),
        el('p', { text: syncMsg }),
        ...(b.warnings || []).slice(0, 10).map((w) => el('p', { class: 'note', text: '· ' + w })),
        (b.warnings || []).length ? el('p', { class: 'note', text: '以上是尚未填寫的必填欄位，可以之後補齊後再送出一次。' }) : null,
      ]),
      okText: '知道了', cancelText: '',
    });
  }

  // 送出確認裡先讓院方看到「哪些數字會公開」
  function summaryNode() {
    const s = CALC.boardSummary(AUDIT);
    const rows = [
      ['填報期間', s.months ? `${s.months} 個月` : null],
      ['總用電量', s.totalKwh?.toLocaleString('zh-TW'), '度'],
      ['總電費', s.totalFee?.toLocaleString('zh-TW'), '元'],
      ['最高需量', s.maxDemand, 'kW'],
      ['經常契約容量', s.contractCapacity, 'kW'],
      ['契約容量利用率', s.contractUsePct, '%'],
      ['排放量', s.co2e, 'tCO₂e'],
      ['重大設備推估年用電', s.majorLoadKwh?.toLocaleString('zh-TW'), '度'],
    ].filter((r) => r[1] !== null && r[1] !== undefined);
    if (!rows.length) return null;
    const box = el('div', { class: 'a-syncbox' }, [
      el('b', { text: '送出後會自動同步到看板（公開顯示）：' }),
      el('div', { class: 'a-synclist' }, rows.map((r) => el('span', { class: 'a-syncitem' }, [
        el('i', { text: r[0] }), el('b', { text: `${r[1]}${r[2] ? ' ' + r[2] : ''}` }),
      ]))),
      el('p', { class: 'note', text: '電費單原始檔、聯絡人個資、逐筆排放源清單與營運事件內文留在主機，不會公開。' }),
    ]);
    return box;
  }

  function showErrors(title, details) {
    const box = el('div', {}, [el('p', { text: `有 ${details.length} 個問題，資料尚未送出：` }),
      ...details.slice(0, 40).map((d) => el('p', { class: 'a-errline', text: '· ' + d }))]);
    return confirmModal({ title, node: box, okText: '知道了', cancelText: '' });
  }
})();
