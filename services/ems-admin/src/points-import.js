// 點位清單批次匯入（工作清單第 25 項）：範本 xlsx 下載、上傳預覽、確認套用。
//
// 兩種來源共用這一支：
//   - 管理端「點位與進度 › 批次匯入點位」：GET /api/inv/points/template.xlsx、POST /api/inv/points/import
//   - 維護者 CLI：scripts/import-points.mjs（匯入業主提供的清單，直接寫 inventory-store）
//
// 規則（伺服器這份才算數）：
//   - 一列一個項目；同一個點位的列以「點位代碼」分組，沒有代碼的以「名稱」分組（空白代碼＝新增、自動配號）。
//   - 已存在的點位依代碼更新名稱／位置／項目；代碼與類別不可改（網址已印在貼紙上）。
//     某點位在檔案裡沒有任何項目欄 → 保留原本的項目，只改名稱／位置；位置空白 → 保留原位置。
//   - 項目 id 空白：既有點位找同標籤同類型的項目沿用 id（舊紀錄才接得上），否則自動配 <類型><n>。
//     同 id 的既有項目，範本沒有的屬性（冰水機群組、必填、水足跡流向等）原樣保留。
//   - 連結設備編號 → 設備 id（依序比對：系統 id、設備編號、設備名稱；要唯一）；連結電號 → site.meters[].id。對不上＝錯誤。
//   - 預覽不寫入；apply 時在鎖內重算一次，有任何錯誤整批不寫；沒錯就整批一次 commit、寫一筆 `point.import` 異動。
//     連到的設備若還沒有所屬點位（pointCode），順手補上（記在該筆異動的 links.equipmentPointCode）。
import { readWorkbook, buildWorkbook } from './xlsx.js';
import { config } from './config.js';
import { readInventory, mutateInventory, newId } from './inventory-store.js';
import { parseCode, makeCode, validatePoint, ITEM_TYPES, DOMAINS, parseReporter, whoLabel, REPORTER_MAX, EQUIPMENT_STATUS } from './inventory-schema.js';
import { readRawBody, parseMultipart } from './upload-io.js';

// ── 範本欄位（順序＝範本欄序）──
export const IMPORT_COLUMNS = [
  { key: 'code', label: '點位代碼', hint: '空白＝新增點位，系統自動配號；填既有代碼＝更新該點位。代碼建好就不能改' },
  { key: 'domain', label: '類別', hint: '電／水（填了代碼可省略，E＝電、W＝水）' },
  { key: 'name', label: '名稱', hint: '點位名稱，例：B1 冰水主機房。新增時必填' },
  { key: 'location', label: '位置', hint: '例：醫療大樓 B1。更新時空白＝保留原位置' },
  { key: 'itemId', label: '項目 id', hint: '英數、底線、連字號。空白自動配號；既有點位會沿用同標籤同類型的項目 id' },
  { key: 'type', label: '類型', hint: ITEM_TYPES.map((t) => `${t.label}（${t.id}）`).join('、') },
  { key: 'label', label: '標籤', hint: '貼紙頁上顯示的項目名稱，例：累計度數、1 號冰水機狀態' },
  { key: 'unit', label: '單位', hint: '累計讀數、一般數值用，例：kWh、m³、°C' },
  { key: 'options', label: '選項', hint: '設備狀態才用；以「、」分隔，例：正常、異常、停機（空白＝預設）。自訂時請保留「異常」' },
  { key: 'warnPct', label: 'warnPct', hint: '累計讀數才用：本次用量與上次差超過幾 % 時提示，例：30' },
  { key: 'equipment', label: '連結設備編號', hint: '設備主檔的設備編號（或設備名稱）；見「設備與電號」工作表' },
  { key: 'meter', label: '連結電號', hint: '初始建檔「電號」區塊的電號；見「設備與電號」工作表' },
];
// 範例列：點位代碼填這個字的列一律略過（範本裡的範例不必刪）
export const EXAMPLE_MARK = '範例';

const TYPE_ALIASES = { 讀數: 'reading', 累計: 'reading', 狀態: 'status', 數值: 'number', 帳單: 'bill' };
const DOMAIN_ALIASES = { 電: 'power', 電力: 'power', power: 'power', e: 'power', 水: 'water', 用水: 'water', water: 'water', w: 'water' };
const ITEM_KEYS = ['itemId', 'type', 'label', 'unit', 'options', 'warnPct', 'equipment', 'meter'];
// 範本管得到的項目屬性；其餘（冰水機群組、必填、水足跡流向等）更新時沿用同 id 的既有項目
const TEMPLATE_ITEM_KEYS = new Set(['id', 'label', 'type', 'unit', 'options', 'warnPct', 'equipmentId', 'meterId']);

// 比較用：鍵排序後再序列化（舊資料的鍵順序可能跟 schema 輸出不同，不該因此算成「更新」）
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
const str = (v) => (v === undefined || v === null ? '' : String(v)).replace(/\r?\n/g, ' ').trim();
// 表頭比對：去空白、去括號註記、不分大小寫
const normHead = (h) => str(h).replace(/[（(][^）)]*[）)]/g, '').replace(/[\s_]/g, '').toLowerCase();
const HEAD_MAP = new Map();
for (const c of IMPORT_COLUMNS) { HEAD_MAP.set(normHead(c.label), c.key); HEAD_MAP.set(normHead(c.key), c.key); }
for (const [a, k] of [['代碼', 'code'], ['點位名稱', 'name'], ['項目代號', 'itemId'], ['項目類型', 'type'], ['項目名稱', 'label'], ['設備編號', 'equipment'], ['電號', 'meter'], ['用量警示', 'warnPct']]) HEAD_MAP.set(normHead(a), k);

// ════════════════════════ 讀檔 ════════════════════════

// 二維陣列（第一列不一定是表頭）→ 列物件。表頭＝前 20 列中第一個同時有「名稱」與「類型」的列。
export function rowsFromGrid(grid) {
  let hr = -1, map = null;
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const m = new Map();
    (grid[r] || []).forEach((h, ci) => { const k = HEAD_MAP.get(normHead(h)); if (k && !m.has(k)) m.set(k, ci); });
    if (m.has('name') && m.has('type')) { hr = r; map = m; break; }
  }
  if (hr < 0) return { rows: [], error: `找不到表頭列（要有「名稱」與「類型」欄，欄名照範本：${IMPORT_COLUMNS.map((c) => c.label).join('、')}）` };
  const rows = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const line = grid[r] || [];
    const o = { row: r + 1 };
    for (const c of IMPORT_COLUMNS) o[c.key] = map.has(c.key) ? str(line[map.get(c.key)]) : '';
    if (IMPORT_COLUMNS.every((c) => !o[c.key])) continue;
    rows.push(o);
  }
  return { rows, error: null, columns: [...map.keys()] };
}

function gridFromSheet(sheet) {
  const grid = [];
  for (const [ref, v] of sheet.cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    const r = Number(m[2]) - 1;
    (grid[r] ||= [])[col - 1] = v;
  }
  for (let i = 0; i < grid.length; i++) grid[i] ||= [];
  return grid;
}

// RFC 4180：雙引號包起來的欄位可含逗號、換行，"" 代表一個引號。Excel 存的 CSV 常帶 BOM。
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const out = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

// buf＋檔名 → { rows, error, sheet }。xlsx 優先找名為「點位清單」的工作表，否則第一張找得到表頭的。
export function parseImportFile(buf, filename = '') {
  const isXlsx = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!isXlsx) {
    if (/\.xlsx$/i.test(filename)) return { rows: [], error: '檔案不是有效的 xlsx' };
    return { ...rowsFromGrid(parseCsv(buf.toString('utf8'))), sheet: null };
  }
  let wb;
  try { wb = readWorkbook(buf); } catch (e) { return { rows: [], error: `xlsx 讀取失敗：${e.message}` }; }
  const names = [...wb.sheets.keys()];
  const order = [...names.filter((n) => n === '點位清單'), ...names.filter((n) => n !== '點位清單')];
  let firstErr = null;
  for (const n of order) {
    const r = rowsFromGrid(gridFromSheet(wb.sheets.get(n)));
    if (!r.error) return { ...r, sheet: n };
    firstErr ||= r.error;
  }
  return { rows: [], error: firstErr || 'xlsx 沒有工作表' };
}

// JSON 的 rows：鍵可用範本欄名（中文）或英文 key
export function rowsFromJson(list) {
  if (!Array.isArray(list)) return { rows: [], error: 'rows 須為陣列' };
  const rows = list.map((r, i) => {
    const o = { row: Number(r?.row) || i + 1 };
    for (const c of IMPORT_COLUMNS) o[c.key] = '';
    for (const [k, v] of Object.entries(r && typeof r === 'object' ? r : {})) {
      const key = HEAD_MAP.get(normHead(k));
      if (key) o[key] = str(v);
    }
    return o;
  }).filter((o) => IMPORT_COLUMNS.some((c) => o[c.key]));
  return { rows, error: null };
}

// ════════════════════════ 對應（設備編號、電號 → id）════════════════════════

const eqLabel = (e) => e?.fields?.name || e?.kind || e?.id;
function resolveEquipment(inv, raw) {
  const v = str(raw);
  const byId = inv.equipment.find((e) => e.id === v);
  if (byId) return { id: byId.id, eq: byId };
  for (const [what, pick] of [['設備編號', (e) => str(e.fields?.deviceNo)], ['設備名稱', (e) => str(e.fields?.name)]]) {
    const hit = inv.equipment.filter((e) => pick(e) === v);
    // 同編號有新舊兩台（汰換）時取使用中的那台
    const act = hit.filter((e) => (e.status || 'active') === 'active');
    const list = act.length ? act : hit;
    if (list.length === 1) return { id: list[0].id, eq: list[0] };
    if (list.length > 1) return { error: `連結設備「${v}」對到 ${list.length} 台設備（依${what}），請改填唯一的設備編號` };
  }
  return { error: `連結設備「${v}」在設備主檔找不到（比對設備編號、設備名稱）` };
}
const meterKey = (s) => str(s).replace(/[\s-]/g, '');
function resolveMeter(inv, raw) {
  const v = str(raw);
  const meters = inv.site.meters || [];
  const byId = meters.find((m) => m.id === v);
  if (byId) return { id: byId.id };
  const hit = meters.filter((m) => meterKey(m.meterNo) === meterKey(v));
  if (hit.length === 1) return { id: hit[0].id };
  if (hit.length > 1) return { error: `連結電號「${v}」在電號區塊有 ${hit.length} 筆，請先整理電號資料` };
  return { error: `連結電號「${v}」在初始建檔「電號」區塊找不到` };
}

function parseType(raw) {
  const v = str(raw);
  const t = ITEM_TYPES.find((x) => x.id === v.toLowerCase() || x.label === v);
  return t ? t.id : TYPE_ALIASES[v] || null;
}
function parseDomain(raw) {
  const v = str(raw);
  return v ? DOMAIN_ALIASES[v.toLowerCase()] || DOMAIN_ALIASES[v] || null : undefined;
}

// ════════════════════════ 預覽（不寫入）════════════════════════

// rows → { ok, counts, points[], errors[], warnings[], skipped[] }
// points[]：{ action:'add'|'update'|'unchanged'|'error', code, autoCode, domain, name, location, items, rows[], errors[], warnings[], changes[] }
export function planImport(inv, hid, rows) {
  const skipped = [];
  const groups = [];
  const byCode = new Map(), byName = new Map();
  let cur = null;
  const loose = [];   // 不屬於任何點位的列
  for (const r of rows) {
    if (r.code === EXAMPLE_MARK) { skipped.push(r.row); cur = null; continue; }
    let g = null;
    if (r.code) {
      g = byCode.get(r.code);
      if (!g) { g = { code: r.code, rows: [] }; byCode.set(r.code, g); groups.push(g); }
      if (r.name && !byName.has(r.name)) byName.set(r.name, g);
    } else if (r.name) {
      g = byName.get(r.name);
      if (!g) { g = { code: '', rows: [] }; byName.set(r.name, g); groups.push(g); }
    } else if (cur) g = cur;   // 代碼、名稱都空白＝接續上一列的點位
    else { loose.push(r); continue; }
    g.rows.push(r);
    cur = g;
  }

  const existingNames = new Map(inv.points.map((p) => [p.name, p.code]));
  const fileCodes = new Set(groups.map((g) => g.code).filter(Boolean));
  const points = [];
  for (const g of groups) {
    const errors = [], warnings = [];
    const first = g.rows[0];
    const err = (row, message) => errors.push({ row, message });
    // 點位層欄位：同一點位各列填的不一致 → 錯誤（免得默默取第一個）
    const pick = (k) => {
      const vals = [...new Set(g.rows.map((r) => r[k]).filter(Boolean))];
      if (vals.length > 1) err(g.rows.find((r) => r[k] && r[k] !== vals[0]).row, `同一點位的「${IMPORT_COLUMNS.find((c) => c.key === k).label}」前後不一致：${vals.join('／')}`);
      return vals[0] || '';
    };
    const name = pick('name'), location = pick('location'), domRaw = pick('domain');
    let domain = parseDomain(domRaw);
    if (domain === null) { err(first.row, `類別「${domRaw}」看不懂，請填 電 或 水`); domain = undefined; }
    let existing = null;
    if (g.code) {
      const c = parseCode(g.code);
      if (!c) err(first.row, `點位代碼格式錯誤：${g.code}（應為 ${hid}-E07 這種形式）`);
      else if (c.hid !== hid) err(first.row, `點位代碼 ${g.code} 不屬於本院所（${hid}）`);
      else {
        if (domain && domain !== c.domain) err(first.row, `點位代碼 ${g.code} 是${DOMAINS[c.domain].label}，類別填「${domRaw}」不符（代碼與類別不可改）`);
        domain = c.domain;
        existing = inv.points.find((p) => p.code === g.code) || null;
      }
    } else if (!domain) err(first.row, '新增點位要填類別（電／水）');
    if (!existing && !name) err(first.row, '新增點位要填名稱');
    if (!g.code && name && existingNames.has(name)) warnings.push(`已有同名點位 ${existingNames.get(name)}；沒填代碼會另建一個新點位（要更新請填代碼）`);
    if (existing?.active === false) warnings.push('此點位已停用，更新後仍維持停用');

    // 項目
    const itemRows = g.rows.filter((r) => ITEM_KEYS.some((k) => r[k]));
    let items = null;
    if (itemRows.length) {
      items = [];
      const used = new Set(itemRows.map((r) => r.itemId).filter(Boolean));
      for (const r of itemRows) {
        const type = parseType(r.type);
        if (!r.type) { err(r.row, '項目「類型」必填'); continue; }
        if (!type) { err(r.row, `項目類型「${r.type}」看不懂，請填 ${ITEM_TYPES.map((t) => t.label).join('、')}`); continue; }
        if (!r.label) { err(r.row, '項目「標籤」必填'); continue; }
        let id = r.itemId;
        if (!id) {
          const reuse = existing?.items.find((it) => it.label === r.label && it.type === type && !used.has(it.id));
          if (reuse) id = reuse.id;
          else { let n = 1; while (used.has(`${type}${n}`) || existing?.items.some((it) => it.id === `${type}${n}`)) n++; id = `${type}${n}`; }
          used.add(id);
        }
        const prev = existing?.items.find((it) => it.id === id);
        const it = { id, label: r.label, type };
        if (r.unit) it.unit = r.unit;
        if (r.options) it.options = r.options.split(/[、,，;；/／|]/).map((s) => s.trim()).filter(Boolean);
        if (r.warnPct) {
          const n = Number(r.warnPct.replace(/%$/, ''));
          if (!Number.isFinite(n)) { err(r.row, `warnPct「${r.warnPct}」不是數字`); continue; }
          it.warnPct = n;
        }
        if (r.equipment) {
          const x = resolveEquipment(inv, r.equipment);
          if (x.error) { err(r.row, x.error); continue; }
          it.equipmentId = x.id;
          if (x.eq.status && x.eq.status !== 'active') warnings.push(`第 ${r.row} 列連結的設備「${eqLabel(x.eq)}」${EQUIPMENT_STATUS[x.eq.status] || x.eq.status}`);
        }
        if (r.meter) {
          const x = resolveMeter(inv, r.meter);
          if (x.error) { err(r.row, x.error); continue; }
          it.meterId = x.id;
        }
        if (prev && prev.type === type) for (const [k, v] of Object.entries(prev)) if (!TEMPLATE_ITEM_KEYS.has(k) && v !== undefined) it[k] = v;
        items.push(it);
      }
    } else if (!existing) err(first.row, '新增點位至少要有一個項目（類型、標籤）');

    const cand = existing
      ? { ...existing, name: name || existing.name, location: location || existing.location || '', items: items || existing.items }
      : { code: g.code || '', domain, name, location, items: items || [], active: true };
    points.push({ g, existing, cand, errors, warnings });
  }

  // 自動配號：同類別（含停用點位與檔案裡指定的代碼）最大號＋1，依檔案順序
  const maxNum = {};
  for (const code of [...inv.points.map((p) => p.code), ...fileCodes]) {
    const c = parseCode(code);
    if (c && c.hid === hid) maxNum[c.domain] = Math.max(maxNum[c.domain] || 0, c.num);
  }
  for (const p of points) {
    if (p.g.code || !p.cand.domain || p.errors.length) continue;
    const n = (maxNum[p.cand.domain] || 0) + 1;
    if (n > 99) { p.errors.push({ row: p.g.rows[0].row, message: `${DOMAINS[p.cand.domain].label}點位代碼已用完（最多 99 個）` }); continue; }
    maxNum[p.cand.domain] = n;
    p.cand.code = makeCode(hid, p.cand.domain, n);
    p.autoCode = true;
  }

  const out = [];
  for (const p of points) {
    let point = null;
    if (!p.errors.length) {
      const v = validatePoint(p.cand, inv);
      if (!v.ok) for (const m of v.errors) p.errors.push({ row: p.g.rows[0].row, message: m });
      else point = v.point;
    }
    const action = p.errors.length ? 'error' : !p.existing ? 'add' : canon(p.existing) === canon(point) ? 'unchanged' : 'update';
    const shown = point || p.cand;
    out.push({
      action, code: shown.code || '', autoCode: !!p.autoCode, domain: shown.domain || null, name: shown.name, location: shown.location || '',
      items: shown.items, rows: p.g.rows.map((r) => r.row), errors: p.errors, warnings: p.warnings,
      changes: action === 'update' ? describeChange(p.existing, point) : [],
      point: action === 'add' || action === 'update' ? point : undefined,
    });
  }
  const errors = [
    ...loose.map((r) => ({ row: r.row, code: '', name: '', message: '這一列沒有點位代碼也沒有名稱，而且前面沒有可接續的點位' })),
    ...out.flatMap((p) => p.errors.map((e) => ({ ...e, code: p.code, name: p.name }))),
  ].sort((a, b) => a.row - b.row);
  const counts = { add: 0, update: 0, unchanged: 0, error: 0 };
  for (const p of out) counts[p.action]++;
  counts.skipped = skipped.length;
  counts.rows = rows.length;
  if (!rows.length || rows.length === skipped.length) errors.push({ row: 0, code: '', name: '', message: '檔案裡沒有可匯入的列（範例列會略過）' });
  return { ok: errors.length === 0, counts, points: out, errors, warnings: out.flatMap((p) => p.warnings.map((w) => `${p.code || p.name}：${w}`)), skipped };
}

function describeChange(a, b) {
  const out = [];
  if (a.name !== b.name) out.push(`名稱「${a.name}」→「${b.name}」`);
  if ((a.location || '') !== (b.location || '')) out.push(`位置「${a.location || '（無）'}」→「${b.location || '（無）'}」`);
  const A = new Map(a.items.map((i) => [i.id, i])), B = new Map(b.items.map((i) => [i.id, i]));
  const added = b.items.filter((i) => !A.has(i.id)).map((i) => i.label);
  const removed = a.items.filter((i) => !B.has(i.id)).map((i) => i.label);
  const changed = b.items.filter((i) => A.has(i.id) && canon(A.get(i.id)) !== canon(i)).map((i) => i.label);
  if (added.length) out.push(`新增項目：${added.join('、')}`);
  if (removed.length) out.push(`移除項目：${removed.join('、')}`);
  if (changed.length) out.push(`調整項目：${changed.join('、')}`);
  if (a.items.map((i) => i.id).join() !== b.items.map((i) => i.id).join() && !added.length && !removed.length && !changed.length) out.push('項目順序調整');
  return out;
}

// ════════════════════════ 套用 ════════════════════════

export class ImportError extends Error {
  constructor(status, body) { super(body.message || body.error); this.status = status; this.body = body; }
}

// actor：{ who, reporter }。apply=false 只讀不寫；apply=true 鎖內重算、整批一次 commit。
// 回傳 { applied, preview, change?, commit? }；apply 時有錯誤丟 ImportError(422, { error:'import_errors', preview })。
export async function importPoints(hid, rows, { apply = false, actor, reason = '', source = '' } = {}) {
  if (!apply) return { applied: false, preview: planImport(await readInventory(hid), hid, rows) };
  const pre = planImport(await readInventory(hid), hid, rows);
  if (!pre.ok) throw new ImportError(422, { error: 'import_errors', message: `有 ${pre.errors.length} 個錯誤，整批未寫入`, preview: pre });
  if (!pre.counts.add && !pre.counts.update) return { applied: false, preview: pre, nothing: true };
  const why = String(reason || '').trim() || `批次匯入點位${source ? `（${source}）` : ''}`;
  const r = await mutateInventory(hid, (inv) => {
    const plan = planImport(inv, hid, rows);   // 鎖內重算：預覽之後別人可能改過點位
    if (!plan.ok) throw new ImportError(422, { error: 'import_errors', message: `有 ${plan.errors.length} 個錯誤，整批未寫入`, preview: plan });
    const before = [], added = [], updated = [];
    for (const p of plan.points) {
      if (p.action === 'add') { inv.points.push(p.point); added.push(p.point); }
      if (p.action === 'update') {
        const idx = inv.points.findIndex((x) => x.code === p.code);
        before.push(inv.points[idx]);
        inv.points[idx] = p.point;
        updated.push(p.point);
      }
    }
    // 設備主檔的所屬點位是點位項目的副本：還沒指定的使用中設備，跟著這次連到它的點位（已指定的不動，交給 linkIssues 提示）
    const synced = [];
    const now = new Date().toISOString();
    for (const p of [...added, ...updated]) {
      for (const it of p.items) {
        const e = it.equipmentId && inv.equipment.find((x) => x.id === it.equipmentId);
        if (e && !e.pointCode && (e.status || 'active') === 'active') { e.pointCode = p.code; e.updatedAt = now; synced.push({ equipmentId: e.id, pointCode: p.code }); }
      }
    }
    const change = {
      id: newId('c'), at: new Date().toISOString(), who: actor.who, reporter: actor.reporter ?? null,
      kind: 'point.import', target: 'points', before: { updated: before }, after: { added, updated }, reason: why,
      links: { added: added.map((p) => p.code), updated: updated.map((p) => p.code), source: source || null, ...(synced.length ? { equipmentPointCode: synced } : {}) },
    };
    inv.changes.push(change);
    return { preview: plan, change };
  }, { who: actor.who, what: `點位批次匯入 新增 ${pre.counts.add}、更新 ${pre.counts.update}` });
  return { applied: true, preview: r.result.preview, change: r.result.change, commit: r.commit };
}

// ════════════════════════ 範本 ════════════════════════

const DOMAIN_LABEL = (d) => DOMAINS[d]?.label || '';
const typeLabel = (id) => ITEM_TYPES.find((t) => t.id === id)?.label || id;

// 範本：點位清單（表頭＋範例列＋本院現有點位）、說明、設備與電號對照。blank=true 不帶現有點位。
export function buildTemplate(inv, hid, { blank = false } = {}) {
  const head = IMPORT_COLUMNS.map((c) => ({ v: c.label, s: 'head' }));
  const eqNo = (id) => { const e = inv.equipment.find((x) => x.id === id); return e ? str(e.fields?.deviceNo) || str(e.fields?.name) || e.id : ''; };
  const meterNo = (id) => str((inv.site.meters || []).find((m) => m.id === id)?.meterNo) || '';
  const ex = (code, dom, name, loc, id, type, label, unit, opts, warn, eq, mt) => [code, dom, name, loc, id, type, label, unit, opts, warn, eq, mt].map((v) => ({ v, s: 'cell' }));
  const rows = [head,
    ex(EXAMPLE_MARK, '電', 'B1 冰水主機房', '醫療大樓 B1', 'kwh', '累計讀數', '冰水主機子電表 累計度數', 'kWh', '', 30, '', ''),
    ex(EXAMPLE_MARK, '電', 'B1 冰水主機房', '醫療大樓 B1', 'ch1', '設備狀態', '1 號冰水機狀態', '', '正常、異常、停機', '', 'CH-01', ''),
    ex(EXAMPLE_MARK, '電', '台電總表', '配電室', 'bill', '電費單', '本月電費單', '', '', '', '', '07-12-3456-78-9'),
    ex(EXAMPLE_MARK, '水', '自來水總表', '大門左側水表箱', 'm3', '累計讀數', '水表累計讀數', 'm³', '', 40, '', ''),
  ];
  if (!blank) {
    for (const p of [...inv.points].sort((a, b) => a.code.localeCompare(b.code))) {
      for (const it of p.items) {
        rows.push(ex(p.code, DOMAIN_LABEL(p.domain), p.name, p.location || '', it.id, typeLabel(it.type), it.label, it.unit || '',
          (it.options || []).join('、'), it.warnPct ?? '', it.equipmentId ? eqNo(it.equipmentId) : '', it.meterId ? meterNo(it.meterId) : ''));
      }
    }
  }
  const guide = [
    [{ v: '點位匯入範本說明', s: 'title' }],
    [{ v: `院所 ${hid}｜一列一個項目；同一個點位的多個項目，點位代碼（或名稱）、類別、名稱、位置每列都填一樣即可（代碼與名稱都空白的列接續上一列的點位）。`, s: 'note' }],
    [{ v: `點位代碼填「${EXAMPLE_MARK}」的列是範例，匯入時一律略過，不必刪除。${blank ? '' : '範例列之後是本院目前的點位，改完直接上傳＝更新。'}`, s: 'note' }],
    [{ v: '上傳後先看預覽（綠＝新增、藍＝更新、紅＝錯誤），確認無誤才按「套用」；有任何錯誤整批不寫入。', s: 'note' }],
    [],
    [{ v: '欄位', s: 'head' }, { v: '說明', s: 'head' }],
    ...IMPORT_COLUMNS.map((c) => [{ v: c.label, s: 'cell' }, { v: c.hint, s: 'cell' }]),
    [],
    [{ v: '規則', s: 'head' }, { v: '', s: 'head' }],
    ...[
      ['代碼與類別', '已存在的點位代碼與類別不能改（貼紙網址已印出）。更新只改名稱、位置、項目。'],
      ['項目整批取代', '既有點位在檔案裡有項目列 → 該點位的項目以檔案為準（沒列到的項目會移除）；完全沒有項目列 → 保留原項目。'],
      ['項目 id', '已有紀錄的項目請保留原 id（或同標籤同類型），舊紀錄才接得上本次用量。'],
      ['連結設備', '填設備主檔的「設備編號」；沒有編號的設備可填設備名稱（須唯一）。對不上列為錯誤。'],
      ['連結電號', '填初始建檔「電號」區塊的電號。對不上列為錯誤。'],
      ['類型', ITEM_TYPES.map((t) => `${t.label}：${t.hint || ''}`).join('；')],
    ].map(([a, b]) => [{ v: a, s: 'cell' }, { v: b, s: 'cell' }]),
  ];
  const ref = [
    [{ v: '設備主檔（連結設備編號填左欄）', s: 'title' }],
    ['設備編號', '設備名稱', '類別', '種類', '狀態', '系統 id'].map((v) => ({ v, s: 'head' })),
    ...inv.equipment.map((e) => [str(e.fields?.deviceNo), str(e.fields?.name), e.category, e.kind, EQUIPMENT_STATUS[e.status] || e.status || '', e.id].map((v) => ({ v, s: 'cell' }))),
    [],
    [{ v: '電號（連結電號填左欄）', s: 'title' }],
    ['電號', '經常契約容量（kW）', '戶名', '系統 id'].map((v) => ({ v, s: 'head' })),
    ...(inv.site.meters || []).map((m) => [str(m.meterNo), m.contractKw ?? '', str(m.accountName), m.id].map((v) => ({ v, s: 'cell' }))),
  ];
  return buildWorkbook([
    { name: '點位清單', rows, cols: [14, 8, 22, 22, 12, 12, 28, 10, 22, 10, 16, 18] },
    { name: '說明', rows: guide, cols: [18, 100] },
    { name: '設備與電號', rows: ref, cols: [16, 28, 12, 14, 10, 24] },
  ]).buffer;
}

// ════════════════════════ HTTP（inventory-routes.js 分派進來）════════════════════════

const MAX_FILE = 5 * 1024 * 1024;
const truthy = (v) => v === true || ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export async function handlePointsImport({ req, res, sess, pathname, json, readBody }) {
  const hid = sess.hid;
  if (pathname === '/api/inv/points/template.xlsx') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
    const blank = truthy(new URL(req.url, 'http://x').searchParams.get('blank'));
    const buf = buildTemplate(await readInventory(hid), hid, { blank });
    const zh = encodeURIComponent(`點位匯入範本-${hid}.xlsx`);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="points-template-${encodeURIComponent(hid)}.xlsx"; filename*=UTF-8''${zh}`, 'Cache-Control': 'private, no-store',
    });
    res.end(buf);
    return true;
  }
  if (pathname !== '/api/inv/points/import') return null;
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const ct = req.headers['content-type'] || '';
  let rows, fields = {}, source = '';
  if (ct.includes('multipart/form-data')) {
    let parts;
    try { parts = parseMultipart(await readRawBody(req, MAX_FILE + 64 * 1024), ct); }
    catch (e) { return json(res, String(e.message) === 'payload_too_large' ? 413 : 400, { ok: false, error: String(e.message || e), message: '檔案太大（上限 5 MB）或格式錯誤' }); }
    for (const p of parts) if (!p.filename) fields[p.name] = p.data.toString('utf8');
    const file = parts.find((p) => p.filename && p.data?.length);
    if (!file) return json(res, 400, { ok: false, error: 'no_file', message: '請選擇 xlsx 或 csv 檔' });
    const parsed = parseImportFile(file.data, file.filename);
    if (parsed.error) return json(res, 400, { ok: false, error: 'bad_file', message: parsed.error });
    rows = parsed.rows; source = str(file.filename).slice(0, 120);
  } else {
    let body;
    try { body = await readBody(req, 2 * 1024 * 1024); } catch { return json(res, 400, { ok: false, error: 'bad_json' }); }
    fields = body && typeof body === 'object' ? body : {};
    const parsed = rowsFromJson(fields.rows);
    if (parsed.error) return json(res, 400, { ok: false, error: 'bad_rows', message: parsed.error });
    rows = parsed.rows; source = str(fields.source).slice(0, 120);
  }
  const rp = parseReporter(fields.reporter === '' ? null : fields.reporter);
  if (!rp.ok) return json(res, 422, { ok: false, error: 'validation', details: [`填寫人姓名最長 ${REPORTER_MAX} 字`], message: `填寫人姓名最長 ${REPORTER_MAX} 字` });
  const base = sess.name || sess.sub;
  const actor = { who: whoLabel(base, rp.reporter), reporter: rp.reporter };
  try {
    const r = await importPoints(hid, rows, { apply: truthy(fields.apply), actor, reason: fields.reason, source });
    return json(res, 200, { ok: true, applied: r.applied, nothing: !!r.nothing, preview: r.preview, change: r.change || null, commit: r.commit || null, baseUrl: config.publicBaseUrl });
  } catch (e) {
    if (e instanceof ImportError) return json(res, e.status, { ok: false, ...e.body });
    throw e;
  }
}
