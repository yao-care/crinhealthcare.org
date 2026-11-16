// 節約能源措施（能源查核申報表十、表十一）與歷年節電率（表十之四、表十之六）
import { q, insert, update, newId, nowIso, audit } from './db.js';
import { assertCan, can } from './authz.js';
import { bad, notFound, j, convert } from './util.js';
import { makeContext } from './calc.js';

export const ENERGY_TYPES = { electricity: '電力（度）', fuel_oil: '燃料油（公秉）', lpg: '液化石油氣（公斤）', ng: '天然氣（立方公尺）', gasoline: '汽油（公升）', diesel: '柴油（公秉）' };
const NUM = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const MONTH = /^\d{4}-\d{2}$/;

export function listMeasures(orgId, year, kind) {
  const w = ['org_id = ?', "status = 'active'"]; const p = [orgId];
  if (year) { w.push('year = ?'); p.push(Number(year)); }
  if (kind) { w.push('kind = ?'); p.push(kind); }
  return q.all(`SELECT * FROM energy_measures WHERE ${w.join(' AND ')} ORDER BY year, kind, created_at`, ...p).map((m) => ({ ...m, evidence_ids: j(m.evidence_ids, []) }));
}
export function readMeasures(ctx, { orgId, year, kind }) {
  assertCan(ctx, 'view.internal', orgId);
  const list = listMeasures(orgId, year, kind);
  return can(ctx, 'view.sensitive', orgId) ? list : list.map((m) => ({ ...m, benefit_twd: null, investment_twd: null, masked: true }));
}

function clean(body) {
  const row = {
    asset_id: body.assetId || null, year: Number(body.year), kind: body.kind, source: body.source || 'current', code: body.code?.trim() || null, name: body.name?.trim(),
    target: body.target || null, area: body.area || null, method: body.method || null, energy_type: body.energyType || 'electricity',
    period_from: body.periodFrom || null, period_to: body.periodTo || null, calc_from_month: NUM(body.calcFromMonth), calc_to_month: NUM(body.calcToMonth),
    saving: NUM(body.saving), peak_reduction_kw: NUM(body.peakReductionKw), benefit_twd: NUM(body.benefitTwd), investment_twd: NUM(body.investmentTwd), calc_note: body.calcNote || null,
  };
  if (!row.name) throw bad('請填措施名稱');
  if (!Number.isInteger(row.year) || row.year < 2015) throw bad('年度不正確（自 104 年起）');
  if (!['done', 'plan'].includes(row.kind)) throw bad('請選已執行或計畫');
  if (!['cross_year', 'current'].includes(row.source)) throw bad('措施來源只能是跨年度成效或當年度計畫');
  if (!ENERGY_TYPES[row.energy_type]) throw bad('能源種類不正確');
  for (const k of ['period_from', 'period_to']) if (row[k] && !MONTH.test(row[k])) throw bad('執行期間請用 YYYY-MM');
  if (row.period_from && row.period_to && row.period_from > row.period_to) throw bad('執行期間起月不可晚於迄月');
  for (const k of ['calc_from_month', 'calc_to_month']) if (row[k] !== null && !(row[k] >= 1 && row[k] <= 12)) throw bad('效益計算起迄月為 1～12');
  for (const k of ['saving', 'peak_reduction_kw', 'benefit_twd', 'investment_twd']) if (row[k] !== null && !Number.isFinite(row[k])) throw bad('數值欄位不是數字');
  if (row.code && !/^[A-Z][A-Z]\d{2}$/.test(row.code)) throw bad('措施代碼格式為系統類別＋設備類別＋方法代碼，例：AA06');
  return row;
}

export function saveMeasure(ctx, body) {
  const t = nowIso();
  if (body.id) {
    const m = q.get('SELECT * FROM energy_measures WHERE id = ?', body.id); if (!m) throw notFound('措施');
    assertCan(ctx, 'report.write', m.org_id);
    const row = clean({ ...body, year: body.year ?? m.year, kind: body.kind ?? m.kind });
    if (row.asset_id && !q.get('SELECT 1 FROM assets WHERE id = ? AND org_id = ?', row.asset_id, m.org_id)) throw bad('電號不屬於此院所');
    update('energy_measures', m.id, { ...row, updated_by: ctx.userId, updated_at: t });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: m.org_id, action: 'measure.update', targetType: 'energy_measure', targetId: m.id, before: m, after: row });
    return { id: m.id };
  }
  assertCan(ctx, 'report.write', body.orgId);
  const row = clean(body);
  if (row.asset_id && !q.get('SELECT 1 FROM assets WHERE id = ? AND org_id = ?', row.asset_id, body.orgId)) throw bad('電號不屬於此院所');
  const id = newId('em');
  insert('energy_measures', { id, org_id: body.orgId, ...row, created_by: ctx.userId, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'measure.create', targetType: 'energy_measure', targetId: id, after: row });
  return { id };
}

export function cancelMeasure(ctx, id, reason) {
  const m = q.get('SELECT * FROM energy_measures WHERE id = ?', id); if (!m) throw notFound('措施');
  assertCan(ctx, 'report.write', m.org_id);
  if (!reason?.trim()) throw bad('請填刪除原因');
  update('energy_measures', id, { status: 'cancelled', updated_by: ctx.userId, updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: m.org_id, action: 'measure.cancel', targetType: 'energy_measure', targetId: id, before: m, after: { reason } });
}

// ── 歷年節電量與用電量 ──
export function saveSavingYear(ctx, { orgId, assetId = null, year, savingKwh, usageKwh, deductKwh, note }) {
  assertCan(ctx, 'report.write', orgId);
  const y = Number(year); if (!Number.isInteger(y) || y < 2015) throw bad('年度不正確（自 104 年起）');
  const row = { saving_kwh: NUM(savingKwh), usage_kwh: NUM(usageKwh), deduct_kwh: NUM(deductKwh), note: note || null, updated_by: ctx.userId, updated_at: nowIso() };
  for (const k of ['saving_kwh', 'usage_kwh', 'deduct_kwh']) if (row[k] !== null && !(Number.isFinite(row[k]) && row[k] >= 0)) throw bad('數值須為 0 以上的數字');
  if ((row.deduct_kwh || 0) > 0 && !row.note) throw bad('有扣除用電量時請說明項目（新建築、新設備、安全考量用電區域…）');
  const ex = q.get('SELECT * FROM energy_saving_years WHERE org_id = ? AND asset_id IS ? AND year = ?', orgId, assetId || null, y);
  if (ex) update('energy_saving_years', ex.id, row);
  else insert('energy_saving_years', { id: newId('esy'), org_id: orgId, asset_id: assetId || null, year: y, ...row });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'saving_year.save', targetType: 'energy_saving_year', targetId: `${assetId || 'org'}:${y}`, before: ex || null, after: row });
}

function usageFromDataset(orgId, assetId, year) {
  const ds = q.get(`SELECT id, name, version, status FROM datasets WHERE org_id = ? AND year = ? ORDER BY CASE status WHEN 'locked' THEN 0 WHEN 'superseded' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, version DESC LIMIT 1`, orgId, year);
  if (!ds) return null;
  const cx = makeContext(ds.id);
  const fs = cx.facts.filter((f) => f.metric_code === 'elec_purchased_kwh' && f.item_code === 'ELE-GRID' && (!assetId || f.asset_id === assetId) && !['missing', 'unknown', 'not_applicable'].includes(f.value_state));
  if (!fs.length) return null;
  return { value: fs.reduce((s, f) => { const c = convert(f.value || 0, f.unit, 'kWh'); return s + (c.ok ? c.value : f.value || 0); }, 0), ds };
}

// 表十之六：R_n ＝ ΣS ÷（ΣS ＋ ΣC － ΣD）× 100%，自最早有資料的年度起累計
export function savingRateTable(orgId, assetId, upToYear) {
  const manual = new Map(q.all('SELECT * FROM energy_saving_years WHERE org_id = ? AND asset_id IS ? AND year <= ?', orgId, assetId || null, upToYear).map((r) => [r.year, r]));
  // 全院措施（沒指定電號）只在只有一個列管電號、或算全院時計入，避免多電號時重複計入每個電號
  const nAccts = q.get("SELECT COUNT(*) n FROM assets a JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code = 'ELE-GRID' AND a.status <> 'archived' AND a.applicability <> 'not_applicable'", orgId).n;
  const measures = q.all("SELECT * FROM energy_measures WHERE org_id = ? AND status = 'active' AND kind = 'done' AND energy_type = 'electricity' AND year BETWEEN 2015 AND ?", orgId, upToYear)
    .filter((m) => !assetId || m.asset_id === assetId || (!m.asset_id && nAccts <= 1));
  const years = [...new Set([...manual.keys(), ...measures.map((m) => m.year)])];
  for (let y = 2015; y <= upToYear; y++) if (!years.includes(y) && q.get('SELECT 1 FROM datasets WHERE org_id = ? AND year = ?', orgId, y)) years.push(y);
  years.sort((a, b) => a - b);
  const rows = []; let cs = 0; let cc = 0; let cd = 0;
  for (const y of years) {
    const m = manual.get(y);
    const fromMeasures = measures.filter((x) => x.year === y && x.saving !== null);
    const saving = m?.saving_kwh ?? (fromMeasures.length ? fromMeasures.reduce((s, x) => s + x.saving, 0) : null);
    const ds = m?.usage_kwh === null || m?.usage_kwh === undefined ? usageFromDataset(orgId, assetId, y) : null;
    const usage = m?.usage_kwh ?? ds?.value ?? null;
    const deduct = m?.deduct_kwh ?? null;
    if (saving === null && usage === null) continue;
    // 沒有用電量 C 的年度不累計（只累計節電量會高估節電率），列出並提示補用電量
    if (usage !== null) { cs += saving || 0; cc += usage; cd += deduct || 0; }
    const den = cs + cc - cd;
    rows.push({ year: y, saving, usage, deduct, rate: usage === null || den <= 0 ? null : cs / den * 100, incomplete: usage === null,
      from: [m?.saving_kwh !== null && m?.saving_kwh !== undefined ? '節電量手填' : fromMeasures.length ? `措施 ${fromMeasures.length} 項` : '', m?.usage_kwh !== null && m?.usage_kwh !== undefined ? '用電量手填' : ds ? `用電量取自資料集 ${ds.ds.name} v${ds.ds.version}` : ''].filter(Boolean).join('；'),
      note: [m?.note, usage === null ? '缺本年度用電量 C，未計入累計' : ''].filter(Boolean).join('；') });
  }
  return { rows };
}

export function readSavingRate(ctx, { orgId, assetId, year }) {
  assertCan(ctx, 'view.internal', orgId);
  return savingRateTable(orgId, assetId || null, Number(year));
}
