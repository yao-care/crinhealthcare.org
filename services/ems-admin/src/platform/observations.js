// M04 資料蒐集＋原始觀測（PRD §5、§10）
// 原始觀測不可覆寫：修正＝建立新版本（supersedes_id 指向舊版，舊版標 superseded）。
// 同來源重送（同 source_record_key）是冪等的：內容相同回原紀錄，內容不同才產生新版本。
import { q, insert, update, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, conflict, toNumber, convert, normUnit, isDate, allocateMonthly, isCalendarMonth, days, j, round } from './util.js';
import { setWorkStatus } from './assets.js';
import { linkEvidence } from './evidence.js';

const VALUE_STATES = ['measured', 'zero', 'estimated', 'missing', 'not_applicable', 'unknown', 'pending_period_end'];

export function metric(code) { return q.get('SELECT * FROM metrics WHERE code = ?', code); }

// 正規化並檢查一筆觀測（不寫入）；回 { row, problems }
export function normalize(input, asset) {
  const m = metric(input.metricCode);
  const problems = [];
  if (!m) { problems.push({ field: 'metricCode', msg: `不認得的指標 ${input.metricCode}` }); return { problems }; }
  if (!isDate(input.periodStart) || !isDate(input.periodEnd)) problems.push({ field: 'period', msg: '期間起迄須為 YYYY-MM-DD' });
  else if (m.value_kind === 'stock' || m.value_kind === 'cumulative' ? input.periodEnd < input.periodStart : input.periodEnd <= input.periodStart) {
    problems.push({ field: 'period', msg: '迄日須晚於起日' });
  }
  const state = input.valueState || 'measured';
  if (!VALUE_STATES.includes(state)) problems.push({ field: 'valueState', msg: '值狀態不正確' });
  const rawUnit = normUnit(input.rawUnit || m.std_unit, m.std_unit);
  let valueStd = null;
  const n = toNumber(input.rawValue);
  if (state === 'measured' || state === 'estimated') {
    if (n === undefined) problems.push({ field: 'rawValue', msg: '請填數值（不知道請改選「未知」或「缺漏」，不要填 0）' });
    else {
      const c = convert(n, rawUnit, m.std_unit);
      if (!c.ok) problems.push({ field: 'rawUnit', msg: c.msg });
      else {
        const mult = m.value_kind === 'cumulative' ? 1 : 1; // 倍率在差分時才乘（累積讀值存原始讀數）
        valueStd = round(c.value * mult, 9);
      }
    }
  } else if (state === 'zero') {
    valueStd = 0;
  } else if (n !== undefined) {
    problems.push({ field: 'rawValue', msg: '值狀態不是「實測」時不可填數值' });
  }
  if (m.semantics !== 'cost' && valueStd !== null && valueStd < 0 && m.value_kind !== 'stock') problems.push({ field: 'rawValue', msg: '用量不可為負數', severity: 'error' });
  const today = new Date().toISOString().slice(0, 10);
  const finalState = state === 'measured' && input.periodEnd > today && m.value_kind === 'stock' ? 'pending_period_end' : state;
  const row = {
    org_id: asset.org_id, asset_id: asset.id, metric_code: m.code, period_start: input.periodStart, period_end: input.periodEnd,
    raw_value: input.rawValue === undefined || input.rawValue === null || input.rawValue === '' ? null : String(input.rawValue), raw_unit: rawUnit,
    value_std: valueStd, std_unit: m.std_unit, value_state: finalState, reading_kind: input.readingKind || m.value_kind,
    meter_multiplier: Number(input.meterMultiplier || asset.meter_multiplier || 1), meter_event: input.meterEvent || 'none',
    quality_grade: input.qualityGrade || null, uncertainty: input.uncertainty || null, boundary_note: input.boundaryNote || null, note: input.note || null,
    acquired_at: input.acquiredAt || null,
  };
  return { row, problems, metric: m };
}

function sourceFor(asset, input, ctx) {
  if (input.sourceId) {
    const s = q.get('SELECT * FROM data_sources WHERE id = ?', input.sourceId);
    if (!s) throw bad('資料來源不存在');
    if (s.org_id !== asset.org_id) throw bad('資料來源不屬於此院所');
    return s;
  }
  // 沒指定來源：用（或建立）此標的的「人工登錄」來源
  let s = q.get("SELECT * FROM data_sources WHERE asset_id = ? AND source_type = 'manual' AND acquisition = 'manual' AND active = 1 ORDER BY created_at LIMIT 1", asset.id);
  if (!s) {
    s = { id: newId('src'), org_id: asset.org_id, asset_id: asset.id, item_id: asset.item_id, name: '現場人工登錄', source_type: 'manual', acquisition: 'manual',
      priority: 30, owner_status: 'unknown', created_by: ctx?.userId || 'system', created_at: nowIso(), updated_at: nowIso() };
    insert('data_sources', s);
  }
  return s;
}

function same(a, b) {
  return a.raw_value === b.raw_value && a.raw_unit === b.raw_unit && a.value_state === b.value_state && a.meter_event === b.meter_event;
}

// 寫入一筆；回 { id, status: 'created'|'duplicate'|'new_version', problems }
export function addObservation(ctx, input, { method = 'manual', importJobId, syncJobId, skipCheck = false, evidenceIds = [] } = {}) {
  const asset = q.get('SELECT * FROM assets WHERE id = ?', input.assetId);
  if (!asset) throw notFound('標的');
  if (!skipCheck) assertCan(ctx, 'obs.write', asset.org_id);
  if (method === 'ocr' && !input.ocrConfirmed) throw bad('辨識結果須經人工確認才能成為觀測值', { code: 'ocr_unconfirmed' });
  const { row, problems } = normalize(input, asset);
  const blocking = problems.filter((p) => p.severity !== 'warning');
  if (blocking.length) throw bad(blocking.map((p) => p.msg).join('；'), { problems });
  const src = sourceFor(asset, input, ctx);
  const recordKey = String(input.sourceRecordKey || `${method}:${row.metric_code}:${row.period_start}:${row.period_end}${method === 'manual' ? ':' + Date.now().toString(36) : ''}`);
  return tx(() => {
    const prev = q.get(`SELECT * FROM observations WHERE asset_id = ? AND metric_code = ? AND period_start = ? AND period_end = ? AND source_id = ? AND source_record_key = ?
                        ORDER BY version DESC LIMIT 1`, asset.id, row.metric_code, row.period_start, row.period_end, src.id, recordKey);
    if (prev && same(prev, row)) return { id: prev.id, status: 'duplicate' };
    const id = newId('obs');
    const full = { id, ...row, source_id: src.id, source_record_key: recordKey, method, import_job_id: importJobId || null, sync_job_id: syncJobId || null,
      ocr_confirmed_by: method === 'ocr' ? ctx?.userId : null, quality_status: 'pending_validation', version: prev ? prev.version + 1 : 1,
      supersedes_id: prev?.id || null, submitted_by: ctx?.userId || 'system', submitted_at: nowIso() };
    insert('observations', full);
    if (prev) update('observations', prev.id, { quality_status: 'superseded' });
    for (const ev of evidenceIds) linkEvidence(id, ev);
    deriveTransforms(full);
    audit({ actor: ctx?.userId || 'system', actorName: ctx?.name, orgId: asset.org_id, action: prev ? 'observation.new_version' : 'observation.create',
      targetType: 'observation', targetId: id, before: prev ? { id: prev.id, raw_value: prev.raw_value } : null, after: { metric: row.metric_code, period: [row.period_start, row.period_end], raw: row.raw_value, unit: row.raw_unit, method } });
    if (['to_register', 'finding_source', 'source_found'].includes(asset.work_status)) setWorkStatus(ctx, asset.id, 'collecting', '已有觀測值', { system: true });
    return { id, status: prev ? 'new_version' : 'created' };
  });
}

// 修正：同來源、同期間建立新版本（必填原因）
export function correctObservation(ctx, id, patch) {
  const o = q.get('SELECT * FROM observations WHERE id = ?', id); if (!o) throw notFound('觀測值');
  assertCan(ctx, 'obs.write', o.org_id);
  if (!patch.reason) throw bad('修正需填原因');
  if (o.quality_status === 'superseded') throw conflict('此版本已被取代，請修正最新版本');
  if (q.get(`SELECT 1 FROM approved_facts af JOIN datasets d ON d.id = af.dataset_id WHERE d.status = 'locked' AND af.observation_ids LIKE ?`, `%${id}%`)) {
    // 允許修正，但提醒：定版資料集不會改變
  }
  return addObservation(ctx, {
    assetId: o.asset_id, metricCode: o.metric_code, periodStart: patch.periodStart || o.period_start, periodEnd: patch.periodEnd || o.period_end,
    rawValue: patch.rawValue ?? o.raw_value, rawUnit: patch.rawUnit || o.raw_unit, valueState: patch.valueState || o.value_state,
    meterEvent: patch.meterEvent || o.meter_event, meterMultiplier: patch.meterMultiplier || o.meter_multiplier, sourceId: o.source_id,
    sourceRecordKey: o.source_record_key, note: `${patch.reason}${patch.note ? '；' + patch.note : ''}`, qualityGrade: patch.qualityGrade || o.quality_grade,
  }, { method: o.method === 'ocr' ? 'manual' : o.method });
}

// ── 衍生值：計費期間分攤到自然月、累積讀值差分 ──
export function deriveTransforms(obs) {
  q.run('DELETE FROM transformed_values WHERE observation_id = ?', obs.id);
  const t = nowIso();
  if (obs.reading_kind === 'interval' && obs.value_std !== null && !isCalendarMonth(obs.period_start, obs.period_end) && days(obs.period_start, obs.period_end) <= 400) {
    for (const part of allocateMonthly(obs.period_start, obs.period_end, obs.value_std)) {
      insert('transformed_values', { id: newId('tv'), observation_id: obs.id, rule_code: 'alloc.daily_prorata', rule_version: 1, period_start: part.period_start, period_end: part.period_end,
        value: round(part.value, 6), unit: obs.std_unit, method: { days: part.days, share: round(part.share, 6), from: [obs.period_start, obs.period_end] }, created_at: t });
    }
  }
  if (obs.reading_kind === 'cumulative') recomputeCumulative(obs.asset_id, obs.metric_code);
}

// 累積讀值 → 區間用量。換表（replace）：新表讀數為新起點，不與舊表相減；歸零（reset）同；
// 回轉（rollover）：依 attrs.rolloverAt（表頭最大值）補一圈。讀數倒退且沒有事件 → 不產生用量（檢核會報錯）。
export function recomputeCumulative(assetId, metricCode) {
  const asset = q.get('SELECT * FROM assets WHERE id = ?', assetId);
  const attrs = j(asset?.attrs, {});
  const usageMetric = { elec_meter_reading_kwh: 'elec_metered_kwh', water_meter_reading_m3: 'water_metered_m3', ng_meter_reading_m3: 'ng_consumption_m3', ess_charge_total_kwh: 'ess_charge_kwh', ess_discharge_total_kwh: 'ess_discharge_kwh', vehicle_odometer_km: null }[metricCode];
  const rows = q.all(`SELECT * FROM observations WHERE asset_id = ? AND metric_code = ? AND quality_status <> 'superseded' AND value_std IS NOT NULL ORDER BY period_end, submitted_at`, assetId, metricCode);
  // 讀數的時間點＝period_end（讀表日）
  for (const r of rows) q.run("DELETE FROM transformed_values WHERE observation_id = ? AND rule_code = 'cumulative.diff'", r.id);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]; const b = rows[i];
    if (['replace', 'reset'].includes(b.meter_event)) continue;
    let diff = b.value_std - a.value_std;
    let method = { prev: a.id, prevReading: a.value_std, reading: b.value_std, multiplier: b.meter_multiplier };
    if (diff < 0) {
      if (b.meter_event === 'rollover' && attrs.rolloverAt) { diff = attrs.rolloverAt - a.value_std + b.value_std; method.rollover = attrs.rolloverAt; }
      else continue;
    }
    const value = round(diff * (b.meter_multiplier || 1), 6);
    insert('transformed_values', { id: newId('tv'), observation_id: b.id, rule_code: 'cumulative.diff', rule_version: 1,
      period_start: a.period_end, period_end: b.period_end, value, unit: b.std_unit, method: { ...method, usageMetric }, created_at: nowIso() });
  }
}

// ── 查詢 ──
export function listObservations(ctx, f = {}) {
  let orgIds = orgsFor(ctx, 'view.internal');
  if (f.assetId) { const a = q.get('SELECT org_id FROM assets WHERE id = ?', f.assetId); if (!a) throw notFound('標的'); assertCan(ctx, 'view.internal', a.org_id); orgIds = [a.org_id]; }
  else if (f.orgId) { assertCan(ctx, 'view.internal', f.orgId); orgIds = [f.orgId]; }
  if (!orgIds.length) return [];
  const where = [`o.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.assetId) { where.push('o.asset_id = ?'); p.push(f.assetId); }
  if (f.metricCode) { where.push('o.metric_code = ?'); p.push(f.metricCode); }
  if (f.from) { where.push('o.period_end > ?'); p.push(f.from); }
  if (f.to) { where.push('o.period_start < ?'); p.push(f.to); }
  if (f.status) { where.push('o.quality_status = ?'); p.push(f.status); } else if (!f.includeSuperseded) where.push("o.quality_status <> 'superseded'");
  if (f.method) { where.push('o.method = ?'); p.push(f.method); }
  if (f.domain) { where.push('a.domain = ?'); p.push(f.domain); }
  const sens = (orgId) => can(ctx, 'view.sensitive', orgId);
  return q.all(`SELECT o.*, a.name AS asset_name, a.domain, m.name AS metric_name, m.semantics, s.name AS source_name, s.source_type, s.priority AS source_priority,
      u.display_name AS submitted_by_name, (SELECT COUNT(*) FROM observation_evidence oe WHERE oe.observation_id = o.id) AS evidence_count
    FROM observations o JOIN assets a ON a.id = o.asset_id JOIN metrics m ON m.code = o.metric_code JOIN data_sources s ON s.id = o.source_id
    LEFT JOIN users u ON u.id = o.submitted_by WHERE ${where.join(' AND ')} ORDER BY o.period_start DESC, o.submitted_at DESC LIMIT ${Math.min(Number(f.limit) || 500, 5000)}`, ...p)
    .map((o) => (o.semantics === 'cost' && !sens(o.org_id) ? { ...o, raw_value: '（需權限）', value_std: null, masked: true } : o));
}

export function observationDetail(ctx, id) {
  const o = q.get('SELECT * FROM observations WHERE id = ?', id); if (!o) throw notFound('觀測值');
  assertCan(ctx, 'view.internal', o.org_id);
  const versions = q.all('SELECT id, version, raw_value, raw_unit, value_state, quality_status, submitted_at, note FROM observations WHERE asset_id = ? AND metric_code = ? AND source_id = ? AND source_record_key = ? ORDER BY version',
    o.asset_id, o.metric_code, o.source_id, o.source_record_key);
  const transforms = q.all('SELECT * FROM transformed_values WHERE observation_id = ? ORDER BY period_start', id).map((t) => parseJson(t, ['method']));
  const evidence = q.all('SELECT e.id, e.filename, e.mime, e.confidentiality, oe.page FROM observation_evidence oe JOIN evidence_files e ON e.id = oe.evidence_id WHERE oe.observation_id = ?', id);
  const validations = q.all('SELECT r.rule_code, r.severity, r.message, r.case_id, v.started_at FROM validation_results r JOIN validation_runs v ON v.id = r.run_id WHERE r.observation_id = ? ORDER BY v.started_at DESC LIMIT 20', id);
  const facts = q.all(`SELECT af.id, af.dataset_id, d.name AS dataset_name, d.status AS dataset_status, af.value, af.unit FROM approved_facts af JOIN datasets d ON d.id = af.dataset_id
    WHERE af.observation_ids LIKE ? AND af.is_current = 1`, `%${id}%`);
  return { ...o, versions, transforms, evidence, validations, facts };
}

// 多源比對（PRD §8.2）：同標的、同指標語意、指定期間；原始／標準化／分攤後三層並列
export function comparison(ctx, assetId, { metricCode, from, to } = {}) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', assetId); if (!a) throw notFound('標的');
  assertCan(ctx, 'view.internal', a.org_id);
  const metricRow = metric(metricCode); if (!metricRow) throw bad('請指定指標');
  // 同語意的指標一起比（例：帳單外購電量 vs EMS 表計電量都是 usage／kWh）
  const peers = q.all('SELECT code FROM metrics WHERE semantics = ? AND std_unit = ? AND domain = ?', metricRow.semantics, metricRow.std_unit, metricRow.domain).map((m) => m.code);
  const obs = q.all(`SELECT o.*, s.name AS source_name, s.source_type, s.priority, m.name AS metric_name FROM observations o JOIN data_sources s ON s.id = o.source_id
    JOIN metrics m ON m.code = o.metric_code WHERE o.asset_id = ? AND o.metric_code IN (${peers.map(() => '?').join(',')}) AND o.quality_status <> 'superseded'
    ${from ? 'AND o.period_end > ?' : ''} ${to ? 'AND o.period_start < ?' : ''} ORDER BY o.period_start`, assetId, ...peers, ...(from ? [from] : []), ...(to ? [to] : []));
  const tv = obs.length ? q.all(`SELECT * FROM transformed_values WHERE observation_id IN (${obs.map(() => '?').join(',')})`, ...obs.map((o) => o.id)) : [];
  // 也把累積讀值差分出來的用量放進來
  const cum = q.all(`SELECT t.*, o.source_id, s.name AS source_name, s.priority FROM transformed_values t JOIN observations o ON o.id = t.observation_id JOIN data_sources s ON s.id = o.source_id
    WHERE o.asset_id = ? AND t.rule_code = 'cumulative.diff' AND o.quality_status <> 'superseded'`, assetId)
    .filter((t) => j(t.method, {}).usageMetric && peers.includes(j(t.method, {}).usageMetric));
  const rows = obs.map((o) => ({
    observationId: o.id, source: o.source_name, sourceType: o.source_type, priority: o.priority, method: o.method, metric: o.metric_name,
    periodStart: o.period_start, periodEnd: o.period_end, calendarMonth: isCalendarMonth(o.period_start, o.period_end),
    raw: o.raw_value, rawUnit: o.raw_unit, std: o.value_std, stdUnit: o.std_unit, valueState: o.value_state, quality: o.quality_status, boundaryNote: o.boundary_note,
    evidence: q.get('SELECT COUNT(*) n FROM observation_evidence WHERE observation_id = ?', o.id).n,
    allocated: tv.filter((t) => t.observation_id === o.id && t.rule_code === 'alloc.daily_prorata').map((t) => ({ periodStart: t.period_start, value: t.value, method: j(t.method) })),
  }));
  // 依自然月彙總各來源（已對齊的值）
  const months = new Map();
  const put = (month, src, value, how) => {
    if (!months.has(month)) months.set(month, []);
    months.get(month).push({ source: src, value, how });
  };
  for (const r of rows) {
    if (r.std === null) continue;
    if (r.calendarMonth) put(r.periodStart, r.source, r.std, '原始期間即自然月');
    else for (const al of r.allocated) put(al.periodStart, r.source, al.value, '依日數比例分攤');
  }
  for (const c of cum) {
    if (isCalendarMonth(c.period_start, c.period_end)) put(c.period_start, `${c.source_name}（讀值差分）`, c.value, '累積讀值差分');
    else for (const al of allocateMonthly(c.period_start, c.period_end, c.value)) put(al.period_start, `${c.source_name}（讀值差分）`, al.value, '讀值差分＋分攤');
  }
  const aligned = [...months.entries()].sort().map(([month, vals]) => {
    const nums = vals.map((v) => v.value);
    const spread = nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0;
    return { month, values: vals, sources: vals.length, absDiff: round(spread, 3), relDiffPct: nums.length > 1 && Math.max(...nums) ? round(spread / Math.max(...nums) * 100, 2) : 0 };
  });
  return { asset: { id: a.id, name: a.name, domain: a.domain }, metric: metricRow, peers, rows, aligned,
    notes: ['帳單期間與自然月不一致時，分攤後的值只能作為比對參考，不能直接判斷哪一筆正確', '不同計量邊界（boundary_note 不同）的資料不應直接比較'] };
}

// 標的的資料需求（指標）完整度：給工作台「來源完整度」欄
export function completeness(assetId, from, to) {
  const a = q.get('SELECT a.*, i.metrics FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.id = ?', assetId);
  const spec = j(a?.data_spec, []); const metrics = spec.length ? spec.map((s) => s.metric || s) : j(a?.metrics, []);
  if (!metrics.length) return { required: 0, covered: 0 };
  let covered = 0;
  for (const m of metrics) {
    const hit = q.get(`SELECT 1 FROM observations WHERE asset_id = ? AND metric_code = ? AND quality_status NOT IN ('superseded','invalid') AND period_end > ? AND period_start < ? LIMIT 1`, assetId, m, from, to);
    if (hit) covered++;
  }
  return { required: metrics.length, covered };
}
