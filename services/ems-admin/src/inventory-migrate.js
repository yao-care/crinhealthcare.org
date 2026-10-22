// 舊資料轉移（工作清單第 16 項）：健檢填報 <hid>.json → 能源盤點 inventory/<hid>.json。
//
// 規則（改這裡要同步更新 README「舊資料轉移」）：
//   basic      → site.basic（附表三表三欄位；只填新版還空著的欄位，不蓋掉院方已在新版填的值）
//   bills      → 每個電號一筆 site.meters ＋ 一個「台電總表」bill 型點位；每張電費單一筆 record
//                （period＝帳單月份、who＝「舊資料轉入」，複驗狀態原樣帶過去：todo／low 仍待確認）
//   majorLoads → equipment（系統類別對到 ac／lighting／other；對不上用 other／其他，原值留在 legacy）
//   chillers   → equipment（ac／中央空調主機）；設備編號與重大設備某筆相同就併進那一筆，不重複建
//   contact    → 主要聯絡人轉成 site.staff 一筆「填表人員」；備援聯絡人與其餘欄位留在舊檔（個資不多搬）
//   emissions／events／佐證檔案清單 → 不轉，只記在報告裡
//
// ⚠️ 原 audit 檔完全不改不刪：這裡只讀它，從不呼叫 saveAudit。
// 冪等：轉過的東西記在 inv.migration.audit.map（來源鍵 → 新物件 id），重跑只補新出現的資料。
// 來源標記刻意不寫進 site 區塊或點位本身——那些物件在 PUT 時走嚴格驗證，多一個鍵就存不回去。
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { safeId } from './audit-store.js';
import { blockById, coerce } from './audit-schema.js';
import { blankInventory, SITE_BLOCKS, validateEquipment, validatePoint, makeCode, parseCode, siteBlockById } from './inventory-schema.js';
import { mutateInventory, newId } from './inventory-store.js';

export const MIGRATION_WHO = '舊資料轉入';
const SOURCE_DOC = '健檢填報（附件一／三）';

// ── 對應表（舊欄位 → 新欄位），報告與 README 都照這份 ──
export const BASIC_MAP = { campusName: 'userName', address: 'siteAddress', beds: 'beds', floorArea: 'floorArea' };
export const CONTACT_STAFF_MAP = { primaryName: 'name', primaryUnit: 'unitTitle', primaryPhone: 'phone', primaryEmail: 'email' };

// majorLoads.system → 設備類別；kind 由設備名稱關鍵字猜，猜不到用「其他」
const AC_KINDS = [
  [/冰水主機|空調主機|冰水機|chiller/i, '中央空調主機'], [/儲冰/, '儲冰槽'], [/冰水泵|冰水幫浦/, '冰水泵'],
  [/冷卻水泵|冷卻水幫浦/, '冷卻水泵'], [/區域泵|區域水泵/, '區域水泵'], [/冷卻水塔/, '冷卻水塔'], [/空調箱|AHU/i, '空調箱'],
  [/送風機|FCU/i, '小型送風機'], [/箱型/, '箱型冷氣'], [/窗型/, '窗型冷氣'], [/分離式/, '分離式冷氣'],
];
const LIGHT_KINDS = [[/LED/i, 'LED'], [/日光燈|T5|T8/i, '日光燈'], [/省電燈泡/, '省電燈泡'], [/鹵素/, '鹵素燈'], [/複金屬/, '複金屬燈'], [/高壓鈉/, '高壓鈉燈'], [/水銀/, '高壓水銀燈']];
const OTHER_KINDS = [[/電梯|電扶梯/, '電梯'], [/排風|送風|抽風/, '送排風'], [/冷凍|冷藏/, '冷凍冷藏'], [/鍋爐/, '鍋爐'], [/熱泵/, '熱泵'], [/空壓/, '壓縮空氣'], [/給水|污水|揚水|排水/, '給水污水']];
export const SYSTEM_MAP = {
  空調: { category: 'ac', guess: AC_KINDS },
  照明: { category: 'lighting', guess: LIGHT_KINDS },
  動力: { category: 'other', guess: OTHER_KINDS },
  醫療設備: { category: 'other', kind: '其他' },
  資料中心: { category: 'other', kind: '其他' },
  '鍋爐·蒸汽': { category: 'other', kind: '鍋爐' },
  空壓: { category: 'other', kind: '壓縮空氣' },
  給排水: { category: 'other', kind: '給水污水' },
  其他: { category: 'other', guess: OTHER_KINDS },
};

const empty = (v) => v === undefined || v === null || String(v).trim() === '';
const label = (block, key) => {
  if (block === 'contact' || block === 'basic' || block === 'bills' || block === 'majorLoads' || block === 'chillers') {
    const b = blockById(block);
    const f = (b.kind === 'table' ? b.columns : b.fields).find((c) => c.key === key);
    return f?.label || key;
  }
  return key;
};

// ── 讀檔（純讀，不經 ensureInit：dry-run 不該在資料目錄留下任何東西）──
const auditFile = (hid) => join(config.dataDir, `${safeId(hid)}.json`);
const invFile = (hid) => join(config.dataDir, 'inventory', `${safeId(hid)}.json`);

export async function readAuditRaw(hid) {
  try { return JSON.parse(await readFile(auditFile(hid), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function readInventoryRaw(hid) {
  let saved;
  try { saved = JSON.parse(await readFile(invFile(hid), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return blankInventory(); throw e; }
  const blank = blankInventory();
  const out = { ...blank, ...saved, site: { ...blank.site, ...(saved.site || {}) } };
  for (const b of SITE_BLOCKS) {
    const v = out.site[b.id];
    out.site[b.id] = b.kind === 'form' ? (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) : (Array.isArray(v) ? v : []);
  }
  for (const k of ['equipment', 'points', 'records', 'changes', 'measures', 'plans']) if (!Array.isArray(out[k])) out[k] = [];
  return out;
}

// 資料目錄裡有哪些院所的健檢檔（<hid>.json，排除 README 之類）
export async function listAuditHids() {
  let names = [];
  try { names = await readdir(config.dataDir); } catch { return []; }
  return names.filter((n) => /^[a-z0-9_-]+\.json$/i.test(n)).map((n) => n.slice(0, -5)).sort();
}

// ════════════════════════════════════════════════════════════════
// 轉移本體：純函式，直接改 inv，回傳報告。dry-run 拿複本跑同一支。
// ════════════════════════════════════════════════════════════════
export function migrateAudit(hid, audit, inv, { now = new Date().toISOString() } = {}) {
  const rows = (id) => (Array.isArray(audit?.blocks?.[id]?.rows) ? audit.blocks[id].rows : []);
  const form = (id) => audit?.blocks?.[id]?.values || {};
  inv.migration ||= {};
  const mig = inv.migration.audit ||= { source: SOURCE_DOC, map: {}, unmapped: {}, runs: [] };
  mig.map ||= {}; mig.unmapped ||= {}; mig.runs ||= [];
  const map = mig.map;

  const report = {
    hid, auditUpdated: audit?.updated || null,
    created: { basicFields: 0, meters: 0, points: 0, records: 0, equipment: 0, staff: 0 },
    merged: 0,                // 冰水主機併進重大設備同一台
    skipped: { already: 0, existing: 0, deleted: 0 },
    pendingCells: 0,          // 帶過去仍是 todo／low 的電費單格子
    unmapped: [],             // { block, row, field, label, value, reason }
    notMigrated: {},          // 區塊 → 筆數（emissions／events／files／contact 其餘欄位）
    warnings: [],
  };
  const unmapped = (block, row, field, value, reason) => report.unmapped.push({ block, row, field, label: label(block, field), value, reason });
  const seen = (key) => { if (map[key]) { report.skipped.already++; return true; } return false; };

  // ── basic → site.basic ──
  const basic = form('basic');
  const contact = form('contact');
  const basicField = (fieldKey) => siteBlockById('basic').fields.find((f) => f.key === fieldKey);
  for (const [oldKey, v] of Object.entries(basic)) {
    if (empty(v)) continue;
    if (map[`basic.${oldKey}`]) { report.skipped.already++; continue; }
    const newKey = BASIC_MAP[oldKey];
    if (!newKey) { unmapped('basic', null, oldKey, v, '新版表三沒有對應欄位'); mig.unmapped[`basic.${oldKey}`] = v; continue; }
    const f = basicField(newKey);
    const val = f.type === 'number' ? coerce(v, 'number') : String(v).trim();
    if (val === undefined) { unmapped('basic', null, oldKey, v, '不是數字'); continue; }
    if (!empty(inv.site.basic[newKey])) {
      if (inv.site.basic[newKey] !== val) report.warnings.push(`基本資料「${f.label}」新版已有值（${inv.site.basic[newKey]}），保留新版，不用舊值（${val}）`);
      continue;
    }
    inv.site.basic[newKey] = val;
    map[`basic.${oldKey}`] = newKey;
    report.created.basicFields++;
  }
  // 院區名稱沒填時，用聯絡人表上的醫院全銜補「用戶名稱」
  if (empty(inv.site.basic.userName) && !empty(contact.hospitalName) && !map['contact.hospitalName']) {
    inv.site.basic.userName = String(contact.hospitalName).trim();
    map['contact.hospitalName'] = 'userName';
    report.created.basicFields++;
  }

  // ── bills → meters ＋ 台電總表點位 ＋ records ──
  const billCols = blockById('bills').columns.filter((c) => !c.computed);
  const byMeter = new Map();
  rows('bills').forEach((r, i) => {
    const no = String(r?.values?.meterNo ?? '').trim();
    if (!byMeter.has(no)) byMeter.set(no, []);
    byMeter.get(no).push({ row: r, idx: i });
  });
  let seq = inv.site.meters.length;
  for (const [meterNo, list] of byMeter) {
    const mKey = `meter:${meterNo}`;
    // 電號：轉過就沿用；院方已在新版手動建同一個電號也沿用，不另建
    let meter = null;
    if (map[mKey]) {
      meter = inv.site.meters.find((m) => m.id === map[mKey]) || null;
      if (!meter) { report.skipped.deleted++; report.warnings.push(`電號 ${meterNo || '（未填）'} 轉入後已在新版刪除，不重建，該電號 ${list.length} 張電費單也不轉`); continue; }
    } else if (meterNo && (meter = inv.site.meters.find((m) => m.meterNo === meterNo))) {
      map[mKey] = meter.id; report.skipped.existing++;
    } else {
      // 契約容量、用電種類取最新一期帳單
      const latest = [...list].sort((a, b) => String(b.row.values?.period || '').localeCompare(String(a.row.values?.period || '')))[0].row.values || {};
      const tariff = [latest.tariffType, latest.timeType].filter((x) => !empty(x)).join(' ');
      meter = { id: newId('met'), seq: ++seq };
      if (meterNo) meter.meterNo = meterNo;
      const kw = coerce(latest.contractCapacity, 'number');
      if (kw !== undefined) meter.contractKw = kw;
      if (tariff) meter.tariffType = tariff;
      meter.note = meterNo ? `${MIGRATION_WHO}（健檢填報電費單）` : `${MIGRATION_WHO}：舊電費單未填電號，請補`;
      if (!meterNo) report.warnings.push(`有 ${list.length} 張電費單沒填電號，歸到一個未填電號的電號資料，請補電號`);
      inv.site.meters.push(meter);
      map[mKey] = meter.id;
      report.created.meters++;
    }

    // 點位：每個電號一個 bill 型「台電總表」
    const pKey = `point:${meterNo}`;
    let point = null;
    if (map[pKey]) {
      point = inv.points.find((p) => p.code === map[pKey]) || null;
      if (!point) { report.skipped.deleted++; report.warnings.push(`點位 ${map[pKey]} 已不存在，電號 ${meterNo || '（未填）'} 的電費單不轉`); continue; }
    } else {
      const used = inv.points.map((p) => parseCode(p.code)).filter((c) => c && c.domain === 'power').map((c) => c.num);
      const n = (used.length ? Math.max(...used) : 0) + 1;
      if (n > 99) { report.warnings.push('電類點位代碼已用完（99 個），台電總表點位無法建立'); continue; }
      const v = validatePoint({
        code: makeCode(hid, 'power', n), domain: 'power', name: `台電總表 ${meterNo || '（未填電號）'}`.slice(0, 60), location: '',
        items: [{ id: 'bill', label: '電費單', type: 'bill', meterId: meter.id }], active: true,
      }, inv);
      if (!v.ok) { report.warnings.push(`台電總表點位建立失敗：${v.errors.join('；')}`); continue; }
      point = v.point;
      inv.points.push(point);
      map[pKey] = point.code;
      report.created.points++;
    }
    const billItem = point.items.find((it) => it.type === 'bill');
    if (!billItem) { report.warnings.push(`點位 ${point.code} 已沒有電費單項目，電費單不轉`); continue; }

    for (const { row, idx } of list) {
      const period = coerce(row.values?.period, 'month');
      if (!/^\d{4}-\d{2}$/.test(period || '')) { unmapped('bills', idx + 1, 'period', row.values?.period ?? null, '計費期間空白或格式不對，這張電費單不轉'); continue; }
      const rKey = `bill:${meterNo}|${period}`;
      if (seen(rKey)) continue;
      // 新版若已經有同點位同期別的電費單（院方掃貼紙填過），以新版為準
      if (inv.records.some((x) => x.pointCode === point.code && x.period === period && x.values?.[billItem.id])) {
        report.skipped.existing++; map[rKey] = 'existing'; continue;
      }
      const values = {};
      for (const c of billCols) {
        const v = row.values?.[c.key];
        if (empty(v) && v !== 0) continue;
        const cv = c.type === 'number' || c.type === 'percent' ? (typeof v === 'number' ? v : coerce(v, 'number')) : coerce(v, c.type);
        if (cv !== undefined) values[c.key] = cv;
      }
      values.period = period;
      for (const k of Object.keys(row.values || {})) if (!billCols.some((c) => c.key === k) && !blockById('bills').columns.some((c) => c.key === k)) unmapped('bills', idx + 1, k, row.values[k], '電費單欄位表沒有這一欄');
      // 複驗狀態原樣保留：沒確認過的格子在新版一樣是待確認
      const meta = {};
      for (const [k, m] of Object.entries(row.meta || {})) if (m && typeof m === 'object') meta[k] = { ...m };
      report.pendingCells += Object.values(meta).filter((m) => m.state === 'todo' || m.state === 'low').length;
      const rec = {
        id: newId('r'), pointCode: point.code, period, at: audit?.updated || now, who: MIGRATION_WHO,
        values: { [billItem.id]: { values, meta } }, usage: {}, note: `${MIGRATION_WHO}（健檢填報電費單第 ${idx + 1} 筆）`, photos: [], anomalies: [],
      };
      inv.records.push(rec);
      map[rKey] = rec.id;
      report.created.records++;
    }
  }

  // ── majorLoads → equipment ──
  const addEquipment = (key, block, idx, eq, legacy) => {
    const v = validateEquipment({ ...eq, status: 'active' }, inv);
    // 欄位格式不合（例：製造年份寫「約 2010」）只丟那一格，其餘照轉；原值都在 legacy
    for (const e of v.errors) unmapped(block, idx + 1, '', null, `設備欄位${e}，這一格不轉（原值留在 legacy）`);
    const rec = {
      id: newId('eq'), building: null, category: eq.category, kind: eq.kind, pointCode: null, status: 'active',
      fields: v.fields, legacy: { source: SOURCE_DOC, block, row: idx + 1, values: legacy }, createdAt: now, updatedAt: now,
    };
    inv.equipment.push(rec);
    map[key] = rec.id;
    report.created.equipment++;
    return rec;
  };
  const loadKeyCount = new Map();
  const loadByDeviceNo = new Map();
  rows('majorLoads').forEach((r, i) => {
    const o = r?.values || {};
    const base = `majorLoads:${String(o.deviceNo ?? '').trim()}|${String(o.name ?? '').trim()}`;
    const dup = loadKeyCount.get(base) || 0;
    loadKeyCount.set(base, dup + 1);
    const key = dup ? `${base}#${dup + 1}` : base;
    if (seen(key)) { if (!empty(o.deviceNo)) loadByDeviceNo.set(String(o.deviceNo).trim(), map[key]); return; }
    const sys = SYSTEM_MAP[String(o.system ?? '').trim()];
    let category = 'other', kind = '其他';
    if (sys) {
      category = sys.category;
      kind = sys.kind || (sys.guess || []).find(([re]) => re.test(String(o.name || '')))?.[1] || '其他';
    } else unmapped('majorLoads', i + 1, 'system', o.system ?? null, '系統類別對不上，歸「其他系統／其他」');
    const name = empty(o.name) ? `${o.system || '設備'} ${o.deviceNo || i + 1}` : String(o.name).trim();
    const fields = { name };
    const kw = coerce(o.ratedKw, 'number');
    if (category === 'lighting') {
      if (kw !== undefined) fields.wattPerFixture = Math.round(kw * 1000 * 1000) / 1000;
      const spec = [o.capacity, o.capacityUnit].filter((x) => !empty(x)).join(' ');
      if (spec) fields.spec = spec;
      if (!empty(o.deviceNo)) unmapped('majorLoads', i + 1, 'deviceNo', o.deviceNo, '照明表九之二沒有設備編號欄');
    } else {
      if (!empty(o.deviceNo)) fields.deviceNo = String(o.deviceNo).trim();
      if (kw !== undefined) fields.powerKw = kw;
      if (!empty(o.capacity)) fields.capacity = o.capacity;
      if (!empty(o.capacityUnit)) fields.capacityUnit = String(o.capacityUnit).trim();
    }
    if (!empty(o.madeYear)) fields.madeYear = String(o.madeYear).trim();
    if (!empty(o.qty)) fields.qty = o.qty;
    if (!empty(o.hoursPerYear)) fields.hoursPerYear = o.hoursPerYear;
    for (const k of ['loadPct', 'annualKwh']) if (!empty(o[k])) unmapped('majorLoads', i + 1, k, o[k], '表九沒有這一欄（原值留在設備的 legacy）');
    if (sys && !sys.kind && kind === '其他') report.warnings.push(`重大設備第 ${i + 1} 筆「${name}」從名稱猜不出種類，先歸「${category === 'ac' ? '空調' : category === 'lighting' ? '照明' : '其他系統'}／其他」，請確認`);
    const rec = addEquipment(key, 'majorLoads', i, { category, kind, fields }, { ...o });
    if (!empty(o.deviceNo) && category === 'ac') loadByDeviceNo.set(String(o.deviceNo).trim(), rec.id);
  });

  // ── chillers → equipment（ac／中央空調主機）──
  rows('chillers').forEach((r, i) => {
    const o = r?.values || {};
    const key = `chillers:${String(o.deviceNo ?? '').trim()}|${String(o.systemName ?? '').trim()}`;
    if (seen(key)) return;
    const rt = coerce(o.capacityRt, 'number');
    const inverter = /變頻/.test(String(o.originType || '')) ? true : /定頻/.test(String(o.originType || '')) ? false : undefined;
    const extra = ['age', 'maintenance', 'chilledOutSpring', 'chilledOutSummer', 'chilledOutAutumn', 'chilledOutWinter',
      'coolingInSpring', 'coolingInSummer', 'coolingInAutumn', 'coolingInWinter', 'roomTemp', 'roomHumidity'];
    for (const k of extra) if (!empty(o[k])) unmapped('chillers', i + 1, k, o[k], k === 'age' ? '機齡換不成製造年份（不推算），請補製造年份；原值留在 legacy' : '表九沒有這一欄（原值留在設備的 legacy）');

    // 同一台已經在重大設備轉過 → 補欄位，不重複建
    const twinId = !empty(o.deviceNo) && loadByDeviceNo.get(String(o.deviceNo).trim());
    const twin = twinId && inv.equipment.find((e) => e.id === twinId);
    if (twin) {
      const f = { ...twin.fields };
      if (empty(f.model) && !empty(o.originType)) f.model = String(o.originType).trim();
      if (f.inverter === undefined && inverter !== undefined) f.inverter = inverter;
      if (empty(f.capacity) && rt !== undefined) { f.capacity = rt; f.capacityUnit = 'RT'; }
      const v = validateEquipment({ ...twin, fields: f }, inv);
      twin.fields = v.fields;
      if (twin.kind === '其他') twin.kind = '中央空調主機';
      twin.legacy = { ...twin.legacy, chiller: { block: 'chillers', row: i + 1, values: { ...o } } };
      map[key] = twin.id;
      report.merged++;
      report.warnings.push(`冰水主機第 ${i + 1} 筆（${o.deviceNo}）與重大設備同一台，併入同一筆設備`);
      return;
    }
    const fields = { name: [o.systemName, o.deviceNo].filter((x) => !empty(x)).join(' ') || `冰水主機 ${i + 1}`, qty: 1 };
    if (!empty(o.deviceNo)) fields.deviceNo = String(o.deviceNo).trim();
    if (!empty(o.originType)) fields.model = String(o.originType).trim();
    if (inverter !== undefined) fields.inverter = inverter;
    if (rt !== undefined) { fields.capacity = rt; fields.capacityUnit = 'RT'; }
    addEquipment(key, 'chillers', i, { category: 'ac', kind: '中央空調主機', fields }, { ...o });
  });

  // ── contact → site.staff（主要聯絡人一筆「填表人員」）──
  const hasPrimary = Object.keys(CONTACT_STAFF_MAP).some((k) => !empty(contact[k]));
  if (hasPrimary && !seen('staff:primary')) {
    const name = String(contact.primaryName || '').trim();
    const dup = name && inv.site.staff.find((s) => s.name === name);
    if (dup) { map['staff:primary'] = dup.id; report.skipped.existing++; }
    else {
      const row = { id: newId('sta'), role: '填表人員' };
      for (const [o, n] of Object.entries(CONTACT_STAFF_MAP)) if (!empty(contact[o])) row[n] = String(contact[o]).trim();
      if (!row.name) report.warnings.push('主要聯絡人沒有姓名，轉成能管人員後請補姓名');
      inv.site.staff.push(row);
      map['staff:primary'] = row.id;
      report.created.staff++;
    }
  }
  const contactLeft = Object.keys(contact).filter((k) => !empty(contact[k]) && !CONTACT_STAFF_MAP[k] && k !== 'hospitalName');
  if (contactLeft.length) report.notMigrated.contact = contactLeft.map((k) => label('contact', k));

  // ── 不轉的 ──
  for (const id of ['emissions', 'events']) if (rows(id).length) report.notMigrated[id] = rows(id).length;
  if (Array.isArray(audit?.files) && audit.files.length) report.notMigrated.files = audit.files.length;

  const total = Object.values(report.created).reduce((a, b) => a + b, 0);
  report.changed = total > 0 || report.merged > 0;
  if (report.changed) mig.runs.push({ at: now, auditUpdated: report.auditUpdated, created: report.created, merged: report.merged });
  return report;
}

// 一家院所：讀舊檔 → 算 → （非 dry-run 且有新東西才）寫。原 audit 檔只讀不寫。
export async function migrateHospital(hid, { dryRun = false } = {}) {
  safeId(hid);
  const audit = await readAuditRaw(hid);
  if (!audit) return { hid, missing: true, changed: false };
  const preview = migrateAudit(hid, audit, structuredClone(await readInventoryRaw(hid)));
  if (dryRun || !preview.changed) return { ...preview, dryRun, commit: null };
  // 鎖內重算一次（寫入以鎖內讀到的最新內容為準，不拿預覽結果硬蓋）
  const r = await mutateInventory(hid, (inv) => migrateAudit(hid, audit, inv), { who: MIGRATION_WHO, what: '健檢填報舊資料轉入' });
  return { ...r.result, dryRun: false, commit: r.commit };
}

export async function migrateAll(opts) {
  const out = [];
  for (const hid of await listAuditHids()) out.push(await migrateHospital(hid, opts));
  return out;
}

// 報告轉成給人看的文字
export function formatReport(rep) {
  if (rep.missing) return `【${rep.hid}】沒有健檢填報檔，略過`;
  const c = rep.created;
  const lines = [
    `【${rep.hid}】${rep.dryRun ? '（試跑，未寫檔）' : rep.changed ? `已寫入${rep.commit ? `（commit ${rep.commit}）` : ''}` : '沒有新資料要轉'}　舊檔更新於 ${rep.auditUpdated || '—'}`,
    `  新建：基本資料 ${c.basicFields} 欄、電號 ${c.meters}、點位 ${c.points}、電費單紀錄 ${c.records}、設備 ${c.equipment}、能管人員 ${c.staff}`,
    `  略過：已轉過 ${rep.skipped.already}、新版已有 ${rep.skipped.existing}、轉入後被刪 ${rep.skipped.deleted}${rep.merged ? `；冰水主機併入重大設備 ${rep.merged}` : ''}`,
  ];
  if (rep.pendingCells) lines.push(`  電費單仍待複驗的格子：${rep.pendingCells}（照舊要逐格確認）`);
  const nm = rep.notMigrated || {};
  const nmText = [nm.emissions && `排放源 ${nm.emissions} 筆`, nm.events && `營運事件 ${nm.events} 筆`, nm.files && `佐證檔案 ${nm.files} 個`, nm.contact && `聯絡人其餘欄位（${nm.contact.join('、')}）`].filter(Boolean);
  if (nmText.length) lines.push(`  不轉（留在舊檔）：${nmText.join('、')}`);
  if (rep.unmapped.length) {
    lines.push(`  沒對上的欄位 ${rep.unmapped.length} 個：`);
    for (const u of rep.unmapped) lines.push(`    - ${u.block}${u.row ? ` 第 ${u.row} 筆` : ''}${u.field ? `「${u.label}」` : ''}${u.value !== null && u.value !== undefined ? `＝${JSON.stringify(u.value)}` : ''}：${u.reason}`);
  }
  for (const w of rep.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join('\n');
}
