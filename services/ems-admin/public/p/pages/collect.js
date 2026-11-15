// 資料蒐集：現場盤點（PRD §7.3，手機友善、斷網暫存）、檔案匯入（映射／預覽／提交／撤銷）、電費單辨識（逐格確認）
import { state, get, post, upload, h, route, page, card, table, link, chip, domainChip, valueStateChip, fmtNum, fmtPeriod, fmtTime, fmtDate, action, btn, go, form, modal, confirmBox,
  toast, can, setQuery, searchBox, select, needOrg, render, note, dl, tabs, metricName, metricOf, assetTypeName, inclEndToExcl, download } from '../core.js';
import { obsTable } from './assets.js';

export function register() {
  route('/collect', pick, { title: '現場盤點' });
  route('/collect/:id', entry, { title: '現場盤點' });
  route('/imports', imports, { title: '匯入／辨識／介接' });
  route('/imports/:id', importDetail, { title: '匯入預覽' });
}

// ── 斷網暫存 ──
const QKEY = 'pf.queue';
const readQ = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
const writeQ = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); return true; } catch { return false; } };
async function flushQueue() {
  const qy = readQ(); if (!qy.length) return;
  const ok = await confirmBox('上傳暫存的盤點紀錄', `這支裝置有 ${qy.length} 筆離線時暫存的紀錄（最早 ${fmtTime(qy[0].savedAt)}）。確認後逐筆上傳；伺服器不會覆蓋既有資料，同期間已有不同數值時會另存新版本並提示。`, '確認上傳');
  if (!ok) return;
  const rest = []; let done = 0; const versions = [];
  for (const item of qy) {
    try { const r = await post('observations', item.body); done++; if (r.status === 'new_version') versions.push(item.label); } catch (e) { if (!navigator.onLine || e.status >= 500) rest.push(item); else rest.push({ ...item, error: e.message }); }
  }
  writeQ(rest);
  toast(`已上傳 ${done} 筆${versions.length ? `；${versions.length} 筆與伺服器原值不同，已存為新版本：${versions.join('、')}` : ''}${rest.length ? `；${rest.length} 筆未上傳` : ''}`, rest.length || versions.length ? 'warn' : 'ok');
}
window.addEventListener('online', () => { if (state.me) flushQueue(); });

async function pick(_, qy) {
  const orgId = needOrg();
  const rows = await get('assets', { orgId, q: qy.q, limit: 100 });
  const queued = readQ();
  const scanBox = h('div', { class: 'pf-scan' });
  const canScan = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  const startScan = async () => {
    const video = h('video', { playsinline: true, muted: true });
    scanBox.replaceChildren(video, btn('停止', () => { stream.getTracks().forEach((t) => t.stop()); scanBox.replaceChildren(); }, 'ghost'));
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream; await video.play();
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
      if (!video.srcObject) return;
      const codes = await det.detect(video).catch(() => []);
      const hit = codes.map((c) => c.rawValue).find((v) => /#\/collect\/|\/s\//.test(v));
      if (hit) {
        stream.getTracks().forEach((t) => t.stop());
        const m = /#\/collect\/([^/?#]+)/.exec(hit);
        if (m) return go(`#/collect/${m[1]}`);
        location.href = hit; return; // 舊貼紙點位網址
      }
      requestAnimationFrame(tick);
    };
    tick();
  };
  return page('現場盤點', { intro: '掃描設備或表計上的 QR Code，或搜尋標的。辨識出的數字要人工確認才會送出。' },
    queued.length ? note(h('span', `這支裝置有 ${queued.length} 筆離線暫存紀錄。`, ' ', btn('上傳', flushQueue, 'primary')), 'warn') : null,
    card(null, h('div', { class: 'pf-bar' }, canScan ? action('📷 掃描 QR Code', startScan, 'primary') : h('span', { class: 'muted pf-small' }, '此瀏覽器不支援直接掃描，請用相機 App 掃 QR Code 或搜尋'),
      searchBox(qy.q || '', (v) => setQuery({ q: v }), '搜尋設備、電號、水號、位置')), scanBox),
    table([{ label: '面向', render: (a) => domainChip(a.domain) }, { label: '標的', render: (a) => link(`#/collect/${a.id}`, a.name) },
      { label: '位置', render: (a) => [a.building_name, a.location, a.floor].filter(Boolean).join(' ') || '—' }, { label: '最後登錄', render: (a) => fmtDate(a.last_obs_at) }], rows,
    { empty: '找不到標的', onRow: (a) => go(`#/collect/${a.id}`) }));
}

async function entry({ id }) {
  const d = await get(`assets/${id}`, { year: state.year });
  const a = d.asset;
  const metrics = (a.data_spec?.length ? a.data_spec.map((s) => s.metric || s) : d.item?.metrics || []).filter(Boolean);
  const allMetrics = metrics.length ? metrics : state.meta.metrics.filter((m) => m.domain === a.domain).map((m) => m.code);
  const recent = await get('observations', { assetId: id, limit: 10 });
  const today = new Date().toISOString().slice(0, 10);
  const draftKey = `pf.draft.${id}`;
  let draft = {}; try { draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch { /* 無 */ }
  // 精簡版：預設只問「哪個月（或哪天）、數字、照片」；單位、期間型態自動判斷，其餘收進「其他情況」
  const prevMonth = (() => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 7); })();
  const mOpts = allMetrics.map((c) => [c, metricName(c)]);
  const main = form([
    mOpts.length > 1 ? { key: 'metricCode', label: '要登錄什麼？', type: 'select', required: true, options: mOpts, wide: true } : null,
    { key: 'month', label: '哪個月份', type: 'month' },
    { key: 'day', label: '讀表／量測日', type: 'date' },
    { key: 'rawValue', label: '數字', inputmode: 'decimal' },
    { key: 'photo', label: '拍照（表頭、銘牌、帳單）', type: 'file', accept: 'image/*,.pdf', wide: true },
  ].filter(Boolean), { metricCode: draft.metricCode || allMetrics[0], month: draft.month || prevMonth, day: draft.day || today, rawValue: draft.rawValue });
  main.inputs.photo.setAttribute('capture', 'environment');
  const adv = form([
    { key: 'customPeriod', label: '帳單期間不是整月（例：9/28～10/27）', type: 'checkbox', wide: true },
    { key: 'periodStart', label: '計費起日', type: 'date' }, { key: 'periodEndIncl', label: '計費迄日（含當日）', type: 'date' },
    { key: 'valueState', label: '沒有數字時', type: 'select', options: [['measured', '有數字（實測）'], ['estimated', '有數字，但是估計值'], ['zero', '實際為零（沒有使用）'], ['missing', '缺漏（應該有但找不到）'], ['unknown', '未知'], ['not_applicable', '不適用']], required: true },
    { key: 'meterEvent', label: '表計狀況', type: 'select', required: true, options: [['none', '正常'], ['replace', '換新表（這次是新表的起始讀數）'], ['reset', '歸零'], ['rollover', '轉一圈回到 0']] },
    { key: 'rawUnit', label: '單位（不填＝標準單位）' }, { key: 'meterMultiplier', label: '表計倍率', type: 'number' },
    { key: 'note', label: '備註（設備狀態、異常說明）', type: 'textarea', wide: true },
  ], { valueState: draft.valueState || 'measured', meterEvent: 'none', meterMultiplier: a.meter_multiplier, customPeriod: false });
  const unitTag = h('span', { class: 'pf-chip' });
  main.inputs.rawValue.closest('label').querySelector('span').append(' ', unitTag);
  const curMetric = () => metricOf(main.inputs.metricCode?.value || allMetrics[0]);
  const updateHint = () => {
    const m = curMetric(); const pointLike = ['stock', 'cumulative'].includes(m?.value_kind);
    unitTag.textContent = adv.inputs.rawUnit.value || m?.std_unit || '';
    main.inputs.month.closest('label').classList.toggle('hidden', pointLike || adv.inputs.customPeriod.checked);
    main.inputs.day.closest('label').classList.toggle('hidden', !pointLike);
    for (const k of ['periodStart', 'periodEndIncl']) adv.inputs[k].closest('label').classList.toggle('hidden', pointLike || !adv.inputs.customPeriod.checked);
    adv.inputs.customPeriod.closest('label').classList.toggle('hidden', pointLike);
    adv.inputs.meterEvent.closest('label').classList.toggle('hidden', m?.value_kind !== 'cumulative');
    main.inputs.rawValue.closest('label').querySelector('span').firstChild.textContent = m?.value_kind === 'cumulative' ? '表頭讀數' : m?.value_kind === 'stock' ? '存量／數量' : '數字';
  };
  for (const i of [main.inputs.metricCode, adv.inputs.customPeriod, adv.inputs.rawUnit].filter(Boolean)) i.addEventListener('change', updateHint);
  updateHint();
  const saveDraft = () => { const v = {}; for (const [k, i] of Object.entries(main.inputs)) if (k !== 'photo') v[k] = i.value; v.valueState = adv.inputs.valueState.value; try { localStorage.setItem(draftKey, JSON.stringify(v)); } catch { /* 無痕 */ } };
  main.el.addEventListener('input', saveDraft);
  const nextMonth = (ym) => { const [y, mm] = ym.split('-').map(Number); return mm === 12 ? `${y + 1}-01-01` : `${y}-${String(mm + 1).padStart(2, '0')}-01`; };
  const f = { el: h('div', main.el, h('details', h('summary', { class: 'pf-small' }, '其他情況：帳單不是整月、沒有數字、換表、單位不同、備註'), adv.el)) };
  const dupWarn = h('div');
  const submit = async () => {
    const v1 = main.read(); if (!v1) return; const v2 = adv.read(); if (!v2) return;
    const m = curMetric(); const metricCode = m.code; const pointLike = ['stock', 'cumulative'].includes(m.value_kind);
    let periodStart; let periodEnd;
    if (pointLike) { if (!v1.day) throw new Error('請填讀表日'); periodStart = v1.day; periodEnd = v1.day; }
    else if (v2.customPeriod) { if (!v2.periodStart || !v2.periodEndIncl) throw new Error('請填計費起迄'); periodStart = v2.periodStart; periodEnd = inclEndToExcl(v2.periodEndIncl); }
    else { if (!v1.month) throw new Error('請選月份'); periodStart = `${v1.month}-01`; periodEnd = nextMonth(v1.month); }
    const hasNumber = ['measured', 'estimated'].includes(v2.valueState);
    if (hasNumber && (v1.rawValue === undefined || v1.rawValue === '')) throw new Error('請填數字；真的沒有數字，打開「其他情況」選缺漏或未知（不要填 0）');
    const v = { ...v2, metricCode, periodStart, rawValue: hasNumber ? v1.rawValue : undefined, photo: v1.photo };
    const body = { assetId: id, metricCode, periodStart, periodEnd, rawValue: v.rawValue, rawUnit: v.rawUnit, valueState: v.valueState,
      meterEvent: v.meterEvent, meterMultiplier: v.meterMultiplier, note: v.note, readingKind: m.value_kind === 'cumulative' ? 'cumulative' : undefined,
      sourceRecordKey: `field:${state.me.user.id}:${metricCode}:${periodStart}:${periodEnd}:${Date.now().toString(36)}` };
    const same = recent.filter((o) => o.metric_code === metricCode && o.period_start === periodStart && o.period_end === periodEnd);
    if (same.length && !(await confirmBox('同期間已有紀錄', `這個標的 ${fmtPeriod(periodStart, periodEnd)} 已有 ${same.length} 筆 ${metricName(metricCode)}（${same.map((o) => o.raw_value ?? o.value_state).join('、')}）。仍要再登錄一筆（不會覆蓋原紀錄）？`, '仍要登錄'))) return;
    if (!navigator.onLine) {
      const qq = readQ(); qq.push({ body, savedAt: new Date().toISOString(), label: `${a.name} ${metricName(metricCode)} ${periodStart}` });
      if (!writeQ(qq)) throw new Error('裝置無法暫存，請恢復網路後再送出');
      toast('目前離線，已暫存在這支裝置；恢復連線後會請你確認上傳', 'warn'); return;
    }
    let evidenceIds = [];
    if (v.photo) { const ev = await upload('evidence', { orgId: a.org_id, kind: '現場照片', assetId: id, confidentiality: 'internal' }, v.photo); evidenceIds = [ev.id]; }
    const r = await post('observations', { ...body, evidenceIds });
    try { localStorage.removeItem(draftKey); } catch { /* 無 */ }
    toast(r.status === 'duplicate' ? '內容與既有紀錄相同，未重複寫入' : '已送出');
    render();
  };
  return page(`📱 ${a.name}`, { crumbs: [['#/collect', '現場盤點'], a.name] },
    card(null, h('div', { class: 'pf-bar' }, domainChip(a.domain), chip(assetTypeName(a.asset_type)), a.location ? chip(a.location) : null, link(`#/assets/${id}`, '標的詳細')),
      d.item?.required_data?.length ? note(`這項需要：${d.item.required_data.join('、')}`) : null,
      d.item?.special_rules?.length ? note(d.item.special_rules.join('；'), 'warn') : null, f.el, dupWarn,
      h('div', { class: 'pf-actions' }, action('送出', submit, 'primary'), btn('清除草稿', () => { try { localStorage.removeItem(draftKey); } catch { /* 無 */ } render(); }, 'ghost')),
      h('p', { class: 'muted pf-small' }, '網路不穩時會自動暫存在這支裝置，恢復連線後由你確認再上傳。')),
    card('最近紀錄', table([{ label: '項目', render: (o) => metricName(o.metric_code) }, { label: '期間', render: (o) => fmtPeriod(o.period_start, o.period_end) },
      { label: '數字', render: (o) => (o.raw_value === null ? valueStateChip(o.value_state) : `${o.raw_value} ${o.raw_unit}`) }], recent.slice(0, 6), { empty: '還沒有紀錄' })));
}

// ── 匯入／辨識／介接 ──
async function imports(_, qy) {
  const orgId = needOrg();
  const tab = qy.tab || (qy.kind === 'assets' ? 'assets' : 'file');
  const T = (k, l) => [`#/imports?tab=${k}`, l];
  let body;
  if (tab === 'ocr') body = ocrTab(orgId);
  else if (tab === 'jobs') body = await jobsTab(orgId);
  else if (tab === 'integrations') body = await integrationsTab(orgId);
  else body = await fileTab(orgId, tab === 'assets' ? 'assets' : 'observations');
  return page('匯入／辨識／介接', { intro: '三種取得方式並行：檔案匯入、帳單辨識（須逐格確認）、自動介接。原始檔一律進佐證庫並記雜湊。' },
    tabs([T('file', '觀測值匯入'), T('assets', '標的匯入'), T('ocr', '電費單辨識'), T('jobs', '匯入紀錄'), T('integrations', '介接狀態')], `#/imports?tab=${tab}`), body);
}

async function fileTab(orgId, kind) {
  const sources = kind === 'observations' ? await get('data-sources', { orgId }) : [];
  const f = form([{ key: 'file', label: '檔案（CSV 或 XLSX；第一列為表頭）', type: 'file', required: true, accept: '.csv,.xlsx', wide: true },
    kind === 'observations' ? { key: 'sourceId', label: '資料來源（不選則用各標的的「人工登錄」來源）', type: 'select', options: sources.map((s) => [s.id, `${s.name}${s.asset_name ? `（${s.asset_name}）` : ''}`]), wide: true } : null].filter(Boolean));
  return card(kind === 'assets' ? '批次匯入標的' : '批次匯入觀測值',
    h('p', h('button', { type: 'button', class: 'pf-link', onclick: () => download(`import-templates/${kind}`) }, '下載匯入範本'), '，填好後上傳。上傳後先看預覽與錯誤清單，確認才寫入；整批可撤銷。'),
    kind === 'observations' ? note('迄日請填含當日（例：帳單 9/28～10/27）。累積讀值與庫存的起迄填同一天（讀表日）。缺漏不要填 0，值狀態填「缺漏」或「未知」。') : null,
    f.el, h('div', { class: 'pf-actions' }, action('上傳並預覽', async () => {
      const v = f.read(); if (!v) return;
      const r = await upload('import-jobs', { orgId, kind, sourceId: v.sourceId }, v.file);
      if (r.duplicateFile) toast('這份檔案先前已上傳過（雜湊相同）；重送不會重複寫入同一筆資料', 'warn');
      go(`#/imports/${r.id}`);
    }, 'primary')));
}

async function importDetail({ id }) {
  const jb = await get(`import-jobs/${id}`);
  const rows = jb.preview?.rows || [];
  const errs = jb.errors || [];
  const st = { previewed: ['預覽中', 'todo'], committed: ['已提交', 'ok'], reverted: ['已撤銷', ''], failed: ['失敗', 'alert'] }[jb.status] || [jb.status, ''];
  const cols = jb.kind === 'observations' ? [
    { label: '列', key: '_row', num: true }, { label: '標的', key: 'asset_name' }, { label: '指標', render: (r) => metricName(r.metric_code) }, { label: '期間', render: (r) => fmtPeriod(r.period_start, r.period_end) },
    { label: '數值', render: (r) => (r.raw_value === null ? valueStateChip(r.value_state) : `${r.raw_value} ${r.raw_unit || ''}`) }, { label: '值狀態', render: (r) => valueStateChip(r.value_state) }, { label: '來源紀錄鍵', key: 'source_record_key' }]
    : jb.kind === 'assets' ? [{ label: '列', key: '_row', num: true }, { label: '名稱', key: 'name' }, { label: '類型', render: (r) => assetTypeName(r.assetType) }, { label: '識別碼', key: 'externalKey' }, { label: '位置', key: 'location' }]
      : [{ label: '列', key: 'row_no', num: true }, { label: '範疇', key: 'scope' }, { label: '類別', key: 'category' }, { label: '活動來源', key: 'activity' }, { label: '對應項目', render: (r) => r.item_codes.join('、') || '—' }, { label: '面向', key: 'domain_hint' }];
  return page(`匯入：${jb.filename}`, { crumbs: [['#/imports?tab=jobs', '匯入紀錄'], jb.filename] },
    card(null, dl([['狀態', chip(...st)], ['類型', { observations: '觀測值', assets: '標的', ghg_workbook: '歷史碳盤查工作簿' }[jb.kind]], ['可匯入', `${rows.length} 列`], ['錯誤', `${errs.length} 列`],
      ['結果', jb.stats ? Object.entries(jb.stats).map(([k, v]) => `${k}: ${v}`).join('、') : '—'], ['上傳', fmtTime(jb.created_at)], ['提交', fmtTime(jb.committed_at)], ['簽收', jb.signed_off_at ? fmtTime(jb.signed_off_at) : '未簽收'],
      ['原始檔', jb.evidence_id ? h('a', { href: `/api/v1/evidence/${jb.evidence_id}/file`, target: '_blank', rel: 'noopener' }, '開啟') : '—']]),
    h('div', { class: 'pf-actions' },
      jb.status === 'previewed' && can('import.write', jb.org_id) ? action(errs.length ? `只匯入正確的 ${rows.length} 列` : `確認匯入 ${rows.length} 列`, async () => {
        if (errs.length && !(await confirmBox('有錯誤列', `${errs.length} 列有錯誤將被略過，確定只匯入正確的列？`))) return;
        const r = await post(`import-jobs/${id}/commit`, { allowErrors: true }); toast(`已匯入：新增 ${r.created}、重複 ${r.duplicate}、新版本 ${r.new_version || 0}、失敗 ${r.failed}`); render(); }, 'primary') : null,
      jb.status === 'committed' && can('import.write', jb.org_id) ? action('整批撤銷', async () => {
        const f = form([{ key: 'reason', label: '撤銷原因', required: true, wide: true }]);
        await modal('整批撤銷', f.el, { okText: '撤銷', onOk: async () => { const v = f.read(); if (!v) return false; const r = await post(`import-jobs/${id}/revert`, v); toast(`已撤銷 ${r.reverted} 筆`); render(); } });
      }, 'danger-btn') : null,
      jb.status === 'committed' && !jb.signed_off_at && can('dataset.approve', jb.org_id) ? action('簽收移轉結果', async () => { await post(`import-jobs/${id}/sign-off`); toast('已簽收'); render(); }) : null)),
    errs.length ? card(`錯誤清單（${errs.length}）`, table([{ label: '列', key: 'row', num: true }, { label: '問題', key: 'msg' }], errs)) : null,
    jb.kind === 'observations' && jb.status === 'previewed' ? mappingCard(jb) : null,
    card(`預覽（前 ${Math.min(rows.length, 500)} 列）`, table(cols, rows, { empty: '沒有可匯入的列' })));
}

function mappingCard(jb) {
  const OBS = [['asset', '標的'], ['metric', '指標代碼'], ['start', '起日'], ['end', '迄日（含）'], ['value', '數值'], ['unit', '單位'], ['state', '值狀態'], ['key', '來源紀錄鍵'], ['meterEvent', '表計事件'], ['note', '備註']];
  const m = jb.mapping || {};
  const f = form(OBS.map(([k, l]) => ({ key: k, label: `${l} → 第幾欄（從 1 起）`, type: 'number' })), Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v + 1])));
  return card('欄位對應', h('p', { class: 'muted pf-small' }, '系統依表頭自動對應；表頭名稱不同時，在這裡指定欄位位置後重新預覽。'), f.el,
    h('div', { class: 'pf-actions' }, action('重新預覽', async () => {
      const v = f.read(); if (!v) return;
      const mapping = Object.fromEntries(Object.entries(v).filter(([, x]) => x).map(([k, x]) => [k, Number(x) - 1]));
      await post(`import-jobs/${jb.id}/remap`, { mapping }); toast('已重新預覽'); render();
    })));
}

async function jobsTab(orgId) {
  const rows = await get('import-jobs', { orgId });
  return card(null, table([{ label: '檔案', render: (j) => link(`#/imports/${j.id}`, j.filename) }, { label: '類型', key: 'kind' }, { label: '狀態', key: 'status' },
    { label: '列數', render: (j) => `${j.stats?.rows ?? '—'}（錯 ${j.stats?.errors ?? 0}）` }, { label: '上傳', render: (j) => fmtTime(j.created_at) }, { label: '提交', render: (j) => fmtTime(j.committed_at) },
    { label: '簽收', render: (j) => (j.signed_off_at ? chip('已簽收', 'ok') : '—') }], rows, { empty: '沒有匯入紀錄' }));
}

function ocrTab(orgId) {
  const f = form([{ key: 'file', label: '電費單（PDF、照片；或 V2 範本 XLSX）', type: 'file', required: true, accept: '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv', wide: true }]);
  const out = h('div');
  return card('電費單辨識', note('辨識結果只是提案：每一格都要你確認或修改後才會成為觀測值。掃描影本的辨識率不會是 100%。'), f.el,
    h('div', { class: 'pf-actions' }, action('上傳並辨識', async () => {
      const v = f.read(); if (!v) return;
      out.replaceChildren(h('p', { class: 'muted' }, '辨識中…（PDF 約 20 秒）'));
      const r = await upload('ocr/bill', { orgId }, v.file);
      out.replaceChildren(await ocrConfirm(orgId, r));
    }, 'primary')), out);
}

async function ocrConfirm(orgId, r) {
  if (!r.proposals.length) return note(r.disabled ? '尚未開通自動辨識（需設定 ANTHROPIC_API_KEY）；檔案已存入佐證庫，請到現場盤點手動登錄並附上這份佐證。' : `沒有辨識出資料：${r.notes || ''}`, 'warn');
  const grid = await get('assets', { orgId, domain: 'electricity' });
  const accounts = grid.filter((a) => a.asset_type === 'power_account' || a.item_code === 'ELE-GRID');
  const blocks = r.proposals.map((p) => {
    const match = accounts.find((a) => a.external_key && p.meterNo && String(a.external_key).replace(/\D/g, '') === String(p.meterNo).replace(/\D/g, ''));
    const head = form([{ key: 'assetId', label: `電號 ${p.meterNo || '（未辨識）'} 對應的標的`, type: 'select', required: true, options: accounts.map((a) => [a.id, a.name]) },
      { key: 'periodStart', label: '計費起日', type: 'date', required: true, default: p.period ? `${p.period}-01` : '' }, { key: 'periodEndIncl', label: '計費迄日（含）', type: 'date', required: true }], { assetId: match?.id });
    const cells = p.values.map((c) => {
      const input = h('input', { value: c.value, inputmode: 'decimal' });
      const ok = h('input', { type: 'checkbox' });
      input.addEventListener('input', () => { ok.checked = true; });
      return { c, input, ok, row: h('tr', h('td', metricName(c.metric)), h('td', input), h('td', c.unit), h('td', c.state === 'low' ? chip('信心低', 'alert') : chip('待確認', 'todo')), h('td', c.page ? `第 ${c.page} 頁` : '—'), h('td', h('label', ok, ' 已核對'))) };
    });
    const submit = action('確認寫入', async () => {
      const hv = head.read(); if (!hv) return;
      if (cells.some((x) => !x.ok.checked)) throw new Error('每一格都要勾「已核對」才能送出');
      for (const x of cells) {
        const stock = x.c.metric === 'elec_contract_kw';
        await post('observations', { assetId: hv.assetId, metricCode: x.c.metric, periodStart: hv.periodStart, periodEnd: stock ? hv.periodStart : inclEndToExcl(hv.periodEndIncl), rawValue: x.input.value, rawUnit: x.c.unit,
          method: 'ocr', ocrConfirmed: true, evidenceIds: [r.evidenceId], sourceRecordKey: `ocr:${r.evidenceId}:${x.c.metric}` });
      }
      toast('已寫入'); submit.disabled = true;
    }, 'primary');
    return card(`計費期間 ${p.period || '?'}`, head.el, h('div', { class: 'pf-table-wrap' }, h('table', { class: 'pf-table' }, h('thead', h('tr', ['欄位', '值', '單位', '狀態', '頁碼', '核對'].map((t) => h('th', t)))), h('tbody', cells.map((x) => x.row)))),
      h('div', { class: 'pf-actions' }, submit));
  });
  return h('div', note(`佐證已存檔（${r.evidenceId}）。帳單計費期間不一定是自然月，請照帳單填起迄。`), blocks, r.notes ? note(r.notes) : null);
}

async function integrationsTab(orgId) {
  const rows = await get('integrations', { orgId }).catch(() => []);
  return card('介接狀態', table([{ label: '名稱', key: 'name' }, { label: '類型', key: 'label' }, { label: '狀態', render: (i) => chip({ idle: '正常', running: '同步中', error: '失敗（將重試）', dead: '已停止' }[i.status] || i.status, { idle: 'ok', error: 'warn', dead: 'alert' }[i.status]) },
    { label: '最後成功', render: (i) => fmtTime(i.last_ok_at) }, { label: '錯誤', key: 'last_error' }, { label: '下次', render: (i) => fmtTime(i.next_run_at) }], rows, { empty: '沒有設定介接' }),
  can('integration.write') ? h('p', link('#/admin/integrations', '介接設定 →')) : null);
}
