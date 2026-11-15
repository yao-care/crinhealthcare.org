// M06 數據品質：檢核規則引擎＋自動開差異案件（PRD §10.2–10.5）
// 規則與門檻從版本化設定讀（validation.rules、compare.thresholds），每次執行記下所用版本。
import { q, insert, update, newId, nowIso, audit, tx } from './db.js';
import { assertCan } from './authz.js';
import { getConfig, configVersion } from './config-store.js';
import { allocateMonthly, isCalendarMonth, round, j, yearRange } from './util.js';
import { openCase } from './cases.js';
import { setWorkStatus } from './assets.js';

const SEV_RANK = { info: 0, warning: 1, error: 2, blocker: 3 };

function thresholdsFor(semantics) {
  const c = getConfig('compare.thresholds') || {};
  return { ...(c.default || { abs: 0, rel_pct: 3 }), ...((c.byMetricSemantics || {})[semantics] || {}) };
}

// 執行檢核：範圍＝某院所（可選標的、期間）
export function runValidation(ctx, { orgId, assetId, from, to, year } = {}, { system = false } = {}) {
  if (!system) assertCan(ctx, 'validation.run', orgId);
  if (year && !from) [from, to] = yearRange(Number(year));
  const cfg = getConfig('validation.rules');
  const rules = cfg.rules;
  const runId = newId('vrun');
  const started = nowIso();
  const results = [];
  const push = (r) => results.push({ id: newId('vres'), run_id: runId, ...r });

  const where = ['o.org_id = ?', "o.quality_status <> 'superseded'"]; const p = [orgId];
  if (assetId) { where.push('o.asset_id = ?'); p.push(assetId); }
  if (from) { where.push('o.period_end > ?'); p.push(from); }
  if (to) { where.push('o.period_start < ?'); p.push(to); }
  const obs = q.all(`SELECT o.*, m.semantics, m.value_kind, m.domain, s.priority, s.name AS source_name FROM observations o JOIN metrics m ON m.code = o.metric_code
    JOIN data_sources s ON s.id = o.source_id WHERE ${where.join(' AND ')} ORDER BY o.asset_id, o.metric_code, o.period_start`, ...p);
  const evCount = new Map(q.all(`SELECT oe.observation_id, COUNT(*) n, GROUP_CONCAT(e.sha256) shas FROM observation_evidence oe JOIN evidence_files e ON e.id = oe.evidence_id GROUP BY oe.observation_id`)
    .map((r) => [r.observation_id, r]));
  const on = (code) => rules[code]?.enabled !== false && rules[code];

  // 逐筆規則
  for (const o of obs) {
    if (on('required_type') && ['measured', 'estimated'].includes(o.value_state) && o.value_std === null) {
      push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'required_type', severity: rules.required_type.severity, message: '數值缺漏或無法解讀' });
    }
    if (on('period_valid') && o.period_end < o.period_start) push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'period_valid', severity: rules.period_valid.severity, message: '期間迄日早於起日' });
    if (on('negative_usage') && o.value_std !== null && o.value_std < 0 && o.semantics !== 'cost') {
      push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'negative_usage', severity: rules.negative_usage.severity, message: '用量為負值' });
    }
    if (on('evidence_required') && (rules.evidence_required.methods || []).includes(o.method) && !evCount.get(o.id)) {
      push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'evidence_required', severity: rules.evidence_required.severity, message: '沒有附佐證（帳單、照片或紀錄）' });
    }
    if (on('period_end_pending') && o.value_state === 'pending_period_end') {
      push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'period_end_pending', severity: 'info', message: '尚未到資料期末（例：年底人數須統計至 12/31）' });
    }
  }

  // 累積讀值倒退
  if (on('cumulative_backward')) {
    const groups = groupBy(obs.filter((o) => o.reading_kind === 'cumulative' && o.value_std !== null), (o) => `${o.asset_id}|${o.metric_code}|${o.source_id}`);
    for (const list of groups.values()) {
      list.sort((a, b) => (a.period_end < b.period_end ? -1 : 1));
      for (let i = 1; i < list.length; i++) {
        if (list[i].value_std < list[i - 1].value_std && list[i].meter_event === 'none') {
          push({ observation_id: list[i].id, asset_id: list[i].asset_id, rule_code: 'cumulative_backward', severity: rules.cumulative_backward.severity,
            message: `讀數倒退（${list[i - 1].value_std} → ${list[i].value_std}），請確認是否換表、歸零或回轉`, details: { prev: list[i - 1].id } });
        }
      }
    }
  }

  // 同來源重複／假獨立證據
  if (on('duplicate_source') || on('false_independence')) {
    const byKey = groupBy(obs, (o) => `${o.asset_id}|${o.metric_code}|${o.period_start}|${o.period_end}`);
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      const bySrc = groupBy(list, (o) => o.source_id);
      for (const same of bySrc.values()) {
        if (same.length > 1 && on('duplicate_source')) {
          for (const o of same.slice(1)) push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'duplicate_source', severity: rules.duplicate_source.severity, message: '同一來源同期間有多筆紀錄（可能重複匯入）' });
        }
      }
      if (on('false_independence')) {
        const shaSrc = new Map();
        for (const o of list) for (const sha of (evCount.get(o.id)?.shas || '').split(',').filter(Boolean)) {
          if (!shaSrc.has(sha)) shaSrc.set(sha, new Set()); shaSrc.get(sha).add(o.source_id);
        }
        for (const [sha, srcs] of shaSrc) if (srcs.size > 1) {
          push({ asset_id: list[0].asset_id, rule_code: 'false_independence', severity: rules.false_independence.severity,
            message: '不同來源引用同一份佐證檔，不能視為獨立的兩筆證據', details: { sha256: sha, sources: [...srcs] } });
        }
      }
    }
  }

  // 跨來源差異（同標的、同語意、同自然月；需同邊界）
  if (on('cross_source')) {
    const series = new Map(); // key asset|semantics|unit|month → [{obs, value, aligned}]
    const tv = obs.length ? q.all(`SELECT * FROM transformed_values WHERE rule_code = 'alloc.daily_prorata' AND observation_id IN (${obs.map(() => '?').join(',')})`, ...obs.map((o) => o.id)) : [];
    const tvBy = groupBy(tv, (t) => t.observation_id);
    for (const o of obs) {
      if (o.value_std === null || !['interval'].includes(o.reading_kind) || ['cost'].includes(o.semantics) && false) continue;
      const parts = isCalendarMonth(o.period_start, o.period_end) ? [{ month: o.period_start, value: o.value_std, aligned: false }]
        : (tvBy.get(o.id) || []).map((t) => ({ month: t.period_start, value: t.value, aligned: true }));
      for (const pt of parts) {
        const k = `${o.asset_id}|${o.semantics}|${o.std_unit}|${pt.month}`;
        if (!series.has(k)) series.set(k, []);
        series.get(k).push({ o, ...pt });
      }
    }
    for (const [k, list] of series) {
      const bySrc = new Map();
      for (const x of list) { if (!bySrc.has(x.o.source_id)) bySrc.set(x.o.source_id, { ...x, value: 0, parts: [] }); const s = bySrc.get(x.o.source_id); s.value += x.value; s.parts.push(x); s.aligned = s.aligned || x.aligned; }
      if (bySrc.size < 2) continue;
      const srcs = [...bySrc.values()];
      const boundaries = new Set(srcs.map((s) => s.o.boundary_note || ''));
      const [assetIdK, semantics, unit, month] = k.split('|');
      if (boundaries.size > 1) {
        push({ asset_id: assetIdK, rule_code: 'cross_source', severity: 'info', message: `${month.slice(0, 7)} 各來源計量邊界不同，不直接比較`, details: { month, boundaries: [...boundaries] } });
        continue;
      }
      const ref = srcs.slice().sort((a, b) => b.o.priority - a.o.priority)[0];
      const th = thresholdsFor(semantics);
      for (const s of srcs) {
        if (s === ref) continue;
        const absDiff = Math.abs(s.value - ref.value);
        const relDiff = ref.value ? absDiff / Math.abs(ref.value) * 100 : null;
        const over = absDiff > (th.abs ?? 0) && (relDiff === null ? absDiff > 0 : relDiff > th.rel_pct);
        if (!over) continue;
        const aligned = s.aligned || ref.aligned;
        const severity = aligned ? 'info' : rules.cross_source.severity;
        const msg = `${month.slice(0, 7)} ${ref.o.source_name} ${round(ref.value, 2)} vs ${s.o.source_name} ${round(s.value, 2)} ${unit}（差 ${round(absDiff, 2)}${relDiff !== null ? `，${round(relDiff, 2)}%` : ''}）${aligned ? '；含計費期間分攤，僅供參考' : ''}`;
        const caseRes = aligned ? null : openCase({ orgId, kind: 'cross_source', ruleCode: 'cross_source', severity: relDiff !== null && relDiff > th.rel_pct * 3 ? 'high' : 'medium',
          assetId: assetIdK, metricCode: s.o.metric_code, periodStart: month, periodEnd: null,
          observationIds: [ref.o.id, s.o.id], summary: msg, absDiff: round(absDiff, 6), relDiff: relDiff === null ? null : round(relDiff, 4),
          details: { reference: ref.o.source_name, compared: s.o.source_name, thresholds: th }, fingerprint: `cross|${assetIdK}|${semantics}|${month}|${[ref.o.source_id, s.o.source_id].sort().join(',')}` });
        push({ observation_id: s.o.id, asset_id: assetIdK, rule_code: 'cross_source', severity, message: msg, case_id: caseRes?.id || null,
          details: { absDiff, relDiff, reference: ref.o.id } });
      }
    }
  }

  // 歷史異常：同來源同指標的月值與前 N 期平均比
  if (on('history_anomaly')) {
    const r = rules.history_anomaly;
    const groups = groupBy(obs.filter((o) => o.value_std !== null && o.reading_kind === 'interval' && o.semantics !== 'cost'), (o) => `${o.asset_id}|${o.metric_code}|${o.source_id}`);
    for (const list of groups.values()) {
      const hist = q.all(`SELECT period_start, value_std FROM observations WHERE asset_id = ? AND metric_code = ? AND source_id = ? AND quality_status IN ('valid','warning') AND value_std IS NOT NULL ORDER BY period_start`,
        list[0].asset_id, list[0].metric_code, list[0].source_id);
      for (const o of list) {
        const prior = hist.filter((h) => h.period_start < o.period_start).slice(-6);
        if (prior.length < (r.min_history || 3)) continue;
        const avg = prior.reduce((s, h) => s + h.value_std, 0) / prior.length;
        if (!avg) continue;
        const rel = Math.abs(o.value_std - avg) / avg * 100;
        const lastYear = hist.find((h) => h.period_start.slice(5, 7) === o.period_start.slice(5, 7) && Number(h.period_start.slice(0, 4)) === Number(o.period_start.slice(0, 4)) - 1);
        const yoy = lastYear?.value_std ? Math.abs(o.value_std - lastYear.value_std) / lastYear.value_std * 100 : null;
        if (rel > r.mom_rel_pct || (yoy !== null && yoy > r.yoy_rel_pct)) {
          push({ observation_id: o.id, asset_id: o.asset_id, rule_code: 'history_anomaly', severity: r.severity,
            message: `與近 ${prior.length} 期平均差 ${round(rel, 1)}%${yoy !== null ? `、與去年同月差 ${round(yoy, 1)}%` : ''}；若為季節性或營運量變動請註記`, details: { avg: round(avg, 3), yoy } });
        }
      }
    }
  }

  // 油槽存量平衡：期初＋入庫－期末－其他用途 ≈ 消耗
  if (on('oil_balance')) {
    const tanks = q.all("SELECT * FROM assets WHERE org_id = ? AND asset_type = 'fuel_tank' AND status <> 'archived'" + (assetId ? ' AND id = ?' : ''), orgId, ...(assetId ? [assetId] : []));
    for (const t of tanks) {
      const ob = (code) => q.all(`SELECT * FROM observations WHERE asset_id = ? AND metric_code = ? AND quality_status <> 'superseded' AND value_std IS NOT NULL ${from ? 'AND period_end > ?' : ''} ${to ? 'AND period_start < ?' : ''} ORDER BY period_end`,
        t.id, code, ...(from ? [from] : []), ...(to ? [to] : []));
      const stock = ob('oil_stock_l'); if (stock.length < 2) continue;
      const begin = stock[0]; const end = stock[stock.length - 1];
      // 交易歸屬：起日落在（期初量測日, 期末量測日] 之間
      const inWin = (r) => r.period_start >= begin.period_end && r.period_start <= end.period_end;
      const sum = (rows) => rows.filter(inWin).reduce((s, r) => s + r.value_std, 0);
      const purchase = sum(ob('oil_purchase_l')); const other = sum(ob('oil_other_use_l'));
      // 共用油槽：子設備消耗合計（不可把同一槽補油量分別算給每台）
      const children = q.all("SELECT child_id FROM asset_links WHERE parent_id = ? AND relation IN ('feeds','supplies') AND valid_to IS NULL", t.id).map((r) => r.child_id);
      const consumption = sum(ob('oil_consumption_l')) + children.reduce((s, c) => s + q.all(`SELECT value_std FROM observations WHERE asset_id = ? AND metric_code = 'oil_consumption_l' AND quality_status <> 'superseded'
        AND period_start >= ? AND period_start <= ?`, c, begin.period_end, end.period_end).reduce((x, r) => x + (r.value_std || 0), 0), 0);
      const implied = begin.value_std + purchase - end.value_std - other;
      const tol = rules.oil_balance.tolerance_pct;
      if (consumption === 0 && implied > 0) {
        push({ asset_id: t.id, rule_code: 'oil_balance', severity: 'info', message: `存量平衡推算消耗 ${round(implied, 1)} L（期初 ${begin.value_std}＋入庫 ${purchase}－期末 ${end.value_std}－其他 ${other}），尚無消耗紀錄，可作為核准的推估方法`, details: { implied, begin: begin.id, end: end.id } });
      } else if (implied > 0 && Math.abs(consumption - implied) / implied * 100 > tol) {
        const msg = `油槽平衡不符：推算消耗 ${round(implied, 1)} L，紀錄消耗 ${round(consumption, 1)} L`;
        const c = openCase({ orgId, kind: 'balance', ruleCode: 'oil_balance', severity: 'medium', assetId: t.id, metricCode: 'oil_consumption_l', periodStart: begin.period_end, periodEnd: end.period_end,
          observationIds: [begin.id, end.id], summary: msg, absDiff: round(Math.abs(consumption - implied), 3), relDiff: round(Math.abs(consumption - implied) / implied * 100, 3), fingerprint: `oil|${t.id}|${begin.id}|${end.id}` });
        push({ asset_id: t.id, rule_code: 'oil_balance', severity: rules.oil_balance.severity, message: msg, case_id: c?.id || null });
      }
    }
  }

  // 母表 vs 子表：子表合計不可大於母表；損失超過門檻提示
  if (on('meter_balance')) {
    const links = q.all(`SELECT l.parent_id, l.child_id FROM asset_links l JOIN assets a ON a.id = l.parent_id WHERE a.org_id = ? AND l.relation = 'submeter_of' AND l.valid_to IS NULL`, orgId);
    const parents = groupBy(links, (l) => l.parent_id);
    for (const [parentId, kids] of parents) {
      const monthly = (aid) => {
        const out = new Map();
        for (const o of q.all(`SELECT o.*, m.semantics FROM observations o JOIN metrics m ON m.code = o.metric_code WHERE o.asset_id = ? AND m.semantics = 'usage' AND o.quality_status <> 'superseded' AND o.value_std IS NOT NULL`, aid)) {
          const parts = isCalendarMonth(o.period_start, o.period_end) ? [{ period_start: o.period_start, value: o.value_std }] : allocateMonthly(o.period_start, o.period_end, o.value_std);
          for (const pt of parts) if ((!from || pt.period_start >= from) && (!to || pt.period_start < to)) out.set(pt.period_start, (out.get(pt.period_start) || 0) + pt.value);
        }
        return out;
      };
      const pm = monthly(parentId);
      const km = kids.map((k) => monthly(k.child_id));
      for (const [month, pv] of pm) {
        if (!km.every((m) => m.has(month))) continue;
        const sum = km.reduce((s, m) => s + m.get(month), 0);
        if (sum > pv * 1.001) {
          push({ asset_id: parentId, rule_code: 'meter_balance', severity: 'error', message: `${month.slice(0, 7)} 子表合計 ${round(sum, 1)} 大於母表 ${round(pv, 1)}，請檢查倍率或邊界` });
        } else if (pv && (pv - sum) / pv * 100 > rules.meter_balance.loss_max_pct) {
          push({ asset_id: parentId, rule_code: 'meter_balance', severity: rules.meter_balance.severity, message: `${month.slice(0, 7)} 未計量／損失 ${round((pv - sum) / pv * 100, 1)}%（母表 ${round(pv, 1)}、子表合計 ${round(sum, 1)}）` });
        }
      }
    }
  }

  // 期間覆蓋：適用標的的必要指標在期間內缺哪些月份
  if (on('coverage_gap') && from && to) {
    const assets = q.all(`SELECT a.*, i.metrics FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.applicability = 'applicable' AND a.status = 'active'` + (assetId ? ' AND a.id = ?' : ''),
      orgId, ...(assetId ? [assetId] : []));
    for (const a of assets) {
      const spec = j(a.data_spec, []);
      const required = spec.length ? spec.filter((s) => s.required !== false && s.frequency === 'monthly').map((s) => s.metric) : [];
      for (const m of required) {
        const months = new Set();
        for (const o of q.all(`SELECT period_start, period_end FROM observations WHERE asset_id = ? AND metric_code = ? AND quality_status NOT IN ('superseded','invalid') AND period_end > ? AND period_start < ?`, a.id, m, from, to)) {
          for (const part of allocateMonthly(o.period_start, o.period_end, 1)) months.add(part.period_start);
        }
        const all = allocateMonthly(from, to, 1).map((x) => x.period_start).filter((x) => x <= new Date().toISOString().slice(0, 10));
        const missing = all.filter((x) => !months.has(x));
        if (missing.length) push({ asset_id: a.id, rule_code: 'coverage_gap', severity: rules.coverage_gap.severity, message: `${m} 缺 ${missing.length} 個月：${missing.map((x) => x.slice(0, 7)).join('、')}`, details: { metric: m, missing } });
      }
    }
  }

  // 寫入結果並更新觀測品質狀態
  const worst = new Map();
  for (const r of results) if (r.observation_id) worst.set(r.observation_id, Math.max(worst.get(r.observation_id) ?? 0, SEV_RANK[r.severity]));
  tx(() => {
    insert('validation_runs', { id: runId, org_id: orgId, ruleset_version: configVersion('validation.rules'), scope: { assetId, from, to }, status: 'running', actor: ctx?.userId || 'system', started_at: started });
    for (const r of results) insert('validation_results', { ...r, details: r.details || null, case_id: r.case_id || null });
    for (const o of obs) {
      const w = worst.get(o.id) ?? 0;
      const status = w >= SEV_RANK.error ? 'invalid' : w === SEV_RANK.warning ? 'warning' : 'valid';
      if (o.quality_status !== status) update('observations', o.id, { quality_status: status });
    }
    const summary = { observations: obs.length, results: results.length, bySeverity: countBy(results, (r) => r.severity), byRule: countBy(results, (r) => r.rule_code) };
    update('validation_runs', runId, { status: 'done', summary, finished_at: nowIso() });
    // 標的進度：全部 valid 且無未結案件 → 待審核；有案件 → 差異處理中
    const touched = new Set(obs.map((o) => o.asset_id));
    for (const aid of touched) {
      const open = q.get("SELECT COUNT(*) n FROM discrepancy_cases WHERE asset_id = ? AND status <> 'closed'", aid).n;
      const a = q.get('SELECT work_status FROM assets WHERE id = ?', aid);
      if (['approved', 'locked', 'paused'].includes(a.work_status)) continue;
      setWorkStatus(ctx, aid, open ? 'discrepancy' : 'to_review', `檢核 ${runId}`, { system: true });
    }
    audit({ actor: ctx?.userId || 'system', actorName: ctx?.name, orgId, action: 'validation.run', targetType: 'validation_run', targetId: runId, after: summary });
  });
  return { runId, summary: { observations: obs.length, results: results.length, bySeverity: countBy(results, (r) => r.severity) } };
}

export function getRun(ctx, runId) {
  const r = q.get('SELECT * FROM validation_runs WHERE id = ?', runId); if (!r) return null;
  assertCan(ctx, 'view.internal', r.org_id);
  return { ...r, summary: j(r.summary), scope: j(r.scope),
    results: q.all('SELECT vr.*, a.name AS asset_name FROM validation_results vr LEFT JOIN assets a ON a.id = vr.asset_id WHERE run_id = ? ORDER BY CASE severity WHEN \'blocker\' THEN 0 WHEN \'error\' THEN 1 WHEN \'warning\' THEN 2 ELSE 3 END', runId) };
}
export function listRuns(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT * FROM validation_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT 50', orgId).map((r) => ({ ...r, summary: j(r.summary), scope: j(r.scope) }));
}

function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
function countBy(arr, fn) { const o = {}; for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; } return o; }
