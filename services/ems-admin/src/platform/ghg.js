// ISO 14064-1:2018 第 9.3.1 條必要內容：顯著性評估（類別 3–6 與土地利用）、基準年、報告自動段落。
import { q, insert, update, newId, nowIso, audit, tx } from './db.js';
import { assertCan, orgById } from './authz.js';
import { bad, notFound, conflict, j, round } from './util.js';
import { getConfig } from './config-store.js';
import { computeAll, gasClass, STATE_LABEL } from './calc.js';
import { SIGNIFICANCE_ITEMS, ISO_CATEGORIES, ASSET_TYPES } from './seed/dictionary.js';
import { MONTREAL } from './seed/factors.js';

// ── 顯著性評估 ──
export function listSignificance(ctx, orgId, year) {
  assertCan(ctx, 'view.internal', orgId);
  if (!year) throw bad('請指定年度');
  const t = nowIso();
  for (const [code, category, name] of SIGNIFICANCE_ITEMS) {
    if (!q.get('SELECT 1 FROM ghg_significance WHERE org_id = ? AND year = ? AND item_code = ?', orgId, year, code)) {
      insert('ghg_significance', { id: newId('sig'), org_id: orgId, year, item_code: code, category, name, updated_at: t });
    }
  }
  return { criteria: getConfig('ghg.significance'), categories: ISO_CATEGORIES,
    rows: q.all('SELECT s.*, u.display_name AS updated_by_name FROM ghg_significance s LEFT JOIN users u ON u.id = s.updated_by WHERE org_id = ? AND year = ? ORDER BY category, item_code', orgId, year)
      .map((r) => ({ ...r, evidence_ids: j(r.evidence_ids, []) })) };
}

export function saveSignificance(ctx, id, body) {
  const r = q.get('SELECT * FROM ghg_significance WHERE id = ?', id); if (!r) throw notFound('評估項目');
  assertCan(ctx, 'report.write', r.org_id);
  if (q.get("SELECT 1 FROM report_runs rr JOIN report_cases c ON c.id = rr.case_id WHERE c.org_id = ? AND c.year = ? AND rr.status = 'locked' AND c.template_id IN (SELECT id FROM report_templates WHERE code = 'GHG-INV')", r.org_id, r.year)) {
    throw conflict('本年度溫室氣體盤查報告已封存，評估結果不可再改；如需修正請開新版本資料集並重新產製');
  }
  const sig = body.significant === true || body.significant === 1 ? 1 : body.significant === false || body.significant === 0 ? 0 : null;
  if (sig !== null && !body.reason?.trim()) throw bad('請填判定理由');
  const quantified = body.quantified ? 1 : 0;
  let value = body.valueTco2e === '' || body.valueTco2e === undefined || body.valueTco2e === null ? null : Number(body.valueTco2e);
  if (value !== null && !Number.isFinite(value)) throw bad('排放量不是數字');
  if (quantified && value === null) throw bad('已量化請填排放量（tCO₂e）');
  if (quantified && !body.method?.trim()) throw bad('已量化請說明量化方法與係數來源');
  const patch = { significant: sig, criteria: body.criteria || null, reason: body.reason || null, quantified, value_tco2e: quantified ? value : null,
    method: body.method || null, data_source: body.dataSource || null, uncertainty_pct: body.uncertaintyPct === '' || body.uncertaintyPct === undefined ? null : Number(body.uncertaintyPct),
    evidence_ids: body.evidenceIds || j(r.evidence_ids, []), updated_by: ctx.userId, updated_at: nowIso() };
  update('ghg_significance', id, patch);
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: r.org_id, action: 'ghg.significance', targetType: 'significance', targetId: id, before: r, after: patch });
}

// 自動估算：能算的先算（活動量 × 已發布係數），並依門檻建議顯著與否；只是建議，按「採用」才寫入
export function estimateSignificance(ctx, orgId, year) {
  assertCan(ctx, 'view.internal', orgId);
  const ds = q.get("SELECT id FROM datasets WHERE org_id = ? AND year = ? AND status IN ('locked','approved','draft','in_review') ORDER BY CASE status WHEN 'locked' THEN 0 ELSE 1 END, version DESC LIMIT 1", orgId, year);
  const est = getConfig('ghg.significance_estimators') || {};
  const th = (getConfig('ghg.significance') || {}).thresholdPct ?? 1;
  const codes = [...new Set(['ghg.total', ...Object.values(est).map((e) => e.indicator)])];
  const res = ds ? computeAll(ds.id, codes).results : {};
  const total = res['ghg.total']?.value ?? null;
  const out = {};
  for (const [item, e] of Object.entries(est)) {
    const act = res[e.indicator];
    const f = q.get("SELECT * FROM factors WHERE code = ? AND status = 'published' ORDER BY version DESC LIMIT 1", e.factor);
    if (!ds) { out[item] = { note: '本年度還沒有資料集，無法估算' }; continue; }
    if (!act || act.value === null) { out[item] = { note: `缺活動量（${e.indicator}）` }; continue; }
    if (!f) { out[item] = { note: `係數庫沒有已發布的「${e.factor}」，新增後即可自動估算`, missingFactor: e.factor }; continue; }
    const t = act.value * f.value / 1000;
    const share = total ? t / total * 100 : null;
    out[item] = { tCO2e: round(t, 4), sharePct: share === null ? null : round(share, 2), suggestSignificant: share !== null && share >= th,
      method: `${e.label}：${round(act.value, 2)} × ${f.value}（${f.code} v${f.version}，${f.source}）`, factor: `${f.code} v${f.version}` };
  }
  return { datasetId: ds?.id || null, totalScope12: total, thresholdPct: th, estimates: out };
}

// 一鍵：尚未評估的全部判定不顯著（理由統一），之後只處理例外
export function markRestInsignificant(ctx, orgId, year, reason) {
  assertCan(ctx, 'report.write', orgId);
  const why = reason?.trim() || `預估占類別一＋二總量低於 ${(getConfig('ghg.significance') || {}).thresholdPct ?? 1}%，且無法規或利害關係人揭露要求`;
  let n = 0;
  for (const r of q.all('SELECT id FROM ghg_significance WHERE org_id = ? AND year = ? AND significant IS NULL', orgId, year)) { saveSignificance(ctx, r.id, { significant: false, reason: why }); n++; }
  return { updated: n };
}

// ── 基準年 ──
function snapshot(datasetId) {
  const codes = ['ghg.s1.total', 'ghg.s2.total', 'ghg.total', 'ghg.cat3', 'ghg.cat4', 'ghg.cat5', 'ghg.cat6', 'ghg.total_all', ...['co2', 'ch4', 'n2o', 'hfcs', 'pfcs', 'sf6', 'nf3'].map((g) => `ghg.s1.gas.${g}`)];
  const { results, factorVersions, ruleVersions } = computeAll(datasetId, codes);
  return { values: Object.fromEntries(codes.map((c) => [c, { value: results[c]?.value ?? null, state: results[c]?.value_state }])), factorVersions, ruleVersions };
}

// 建議基準年：最早一個已定版的年度
export function suggestBaseYear(orgId) {
  return q.get("SELECT id, year, name, version FROM datasets WHERE org_id = ? AND status IN ('locked','superseded') ORDER BY year, version DESC LIMIT 1", orgId);
}

export function listBaseYears(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT b.*, u.display_name AS created_by_name, d.name AS dataset_name, d.version AS dataset_version FROM ghg_base_years b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN datasets d ON d.id = b.dataset_id WHERE b.org_id = ? ORDER BY b.created_at', orgId)
    .map((b) => ({ ...b, emissions: j(b.emissions, {}) }));
}

export function setBaseYear(ctx, { orgId, baseYear, datasetId, policy, recalcThresholdPct, reason, kind = 'set' }) {
  assertCan(ctx, 'report.write', orgId);
  if (!baseYear || !datasetId) throw bad('請選基準年與該年度已定版的資料集');
  if (!reason?.trim()) throw bad(kind === 'set' ? '請填基準年選定理由' : '請填重新計算原因（結構變更、方法變更、發現重大錯誤…）');
  const d = q.get('SELECT * FROM datasets WHERE id = ?', datasetId);
  if (!d || d.org_id !== orgId || d.year !== Number(baseYear)) throw bad('資料集須屬於此院所且年度與基準年相同');
  if (!['locked', 'superseded'].includes(d.status)) throw conflict('基準年資料集須已定版');
  if (kind === 'recalculated' && !q.get("SELECT 1 FROM ghg_base_years WHERE org_id = ?", orgId)) throw conflict('尚未設定基準年');
  const id = newId('by');
  const emissions = snapshot(datasetId);
  insert('ghg_base_years', { id, org_id: orgId, base_year: Number(baseYear), dataset_id: datasetId, emissions, policy: policy || null,
    recalc_threshold_pct: recalcThresholdPct === undefined || recalcThresholdPct === '' ? null : Number(recalcThresholdPct), kind, reason, created_by: ctx.userId, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: `ghg.base_year_${kind}`, targetType: 'base_year', targetId: id, after: { baseYear, datasetId, reason, total: emissions.values['ghg.total'] } });
  return { id };
}

// ── 報告自動段落（source_kind = 'text'，source_ref = 下列鍵）──
const TYPE_LABEL = { stationary_combustion: '固定燃燒', mobile_combustion: '移動燃燒', fugitive: '逸散', fugitive_refrigerant: '逸散', fugitive_sf6: '逸散', process_gas: '製程',
  septic_ch4: '逸散', wastewater_ch4: '逸散', purchased_electricity: '輸入電力', imported_heat: '輸入能源', upstream_water: '其他間接', wastewater: '其他間接' };
const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: d }));
const tbl = (columns, rows) => ({ columns, rows });

function gasesFor(asset, type) {
  const a = j(asset.attrs, {});
  if (/combustion/.test(type)) return 'CO₂、CH₄、N₂O';
  if (type === 'fugitive_refrigerant' || (type === 'fugitive' && (a.refrigerant || a.agent))) {
    const g = a.refrigerant || a.agent; if (!g) return '（未填冷媒種類）';
    if (MONTREAL.includes(g)) return `${g}（蒙特婁議定書管制物質，不計入）`;
    return `${gasClass(g) || g}（${g}）`;
  }
  if (type === 'fugitive_sf6') return a.gas || 'SF₆';
  if (type === 'process_gas') return 'N₂O、CO₂';
  if (/septic|wastewater_ch4/.test(type)) return 'CH₄';
  if (type === 'purchased_electricity' || type === 'imported_heat') return 'CO₂e';
  return '—';
}

function dqFor(asset, facts, cfg) {
  const a = j(asset.attrs, {}); const dq = a.dq || {};
  let activityType = dq.activityType; let activityTrust = dq.activityTrust;
  if (!activityType || !activityTrust) {
    const obs = facts.flatMap((f) => j(f.observation_ids, [])).map((id) => q.get('SELECT o.method, s.source_type FROM observations o JOIN data_sources s ON s.id = o.source_id WHERE o.id = ?', id)).filter(Boolean);
    const derived = facts.some((f) => f.value_state === 'estimated' || q.get("SELECT 1 FROM decisions WHERE id = ? AND decision_type = 'derived'", f.decision_id));
    activityType = activityType || (derived ? 3 : obs.some((o) => o.method === 'api') ? 1 : 2);
    activityTrust = activityTrust || (obs.some((o) => o.source_type === 'bill') ? 1 : a.calibrated ? 2 : 3);
  }
  const factorType = dq.factorType || 3;
  const score = activityType * activityTrust * factorType;
  const grade = (cfg.grades || []).find((g) => score <= g.max)?.grade || '—';
  return { activityType, activityTrust, factorType, score, grade, overridden: !!(a.dq) };
}

export function buildBlocks(keys, { caseRow, datasetId, results, factorVersions, ruleVersions }) {
  const ds = datasetId ? q.get('SELECT * FROM datasets WHERE id = ?', datasetId) : null;
  const orgId = caseRow.org_id; const year = caseRow.year;
  const org = orgById(orgId);
  const out = {};
  const B = (key, fn) => { if (keys.includes(key)) { try { out[key] = fn(); } catch (e) { out[key] = { state: 'blocked', text: `無法產生：${e.message}` }; } } };

  B('org', () => {
    const parent = org.parent_id ? orgById(org.parent_id) : null;
    const sites = q.all('SELECT s.name, (SELECT COUNT(*) FROM buildings b WHERE b.site_id = s.id) n FROM sites s WHERE s.org_id = ?', orgId);
    return { state: 'measured', text: `${org.name}（代碼 ${org.code}${parent ? `，隸屬${parent.name}` : ''}）。院區：${sites.map((s) => `${s.name}${s.n ? `（建物 ${s.n} 棟）` : ''}`).join('、') || '未建檔'}。` };
  });
  B('period', () => ({ state: 'measured', text: `${year}-01-01 至 ${year}-12-31（民國 ${year - 1911} 年 1 月 1 日至 12 月 31 日）。資料集：${ds ? `${ds.name} 第 ${ds.version} 版${ds.hash ? `（定版雜湊 ${ds.hash.slice(0, 16)}…）` : ''}` : '未指定'}。` }));
  B('conformance', () => ({ state: 'measured', text: '本報告依 ISO 14064-1:2018「組織層級溫室氣體排放與移除之量化及報告附指引之規範」第 9 章編製，並參照環境部「溫室氣體排放量盤查登錄及查驗管理辦法」與盤查作業指引。報告內容是否經查證，見「查證」一節。' }));
  B('org_boundary', () => {
    const bnd = caseRow.boundary_id ? q.get('SELECT * FROM boundaries WHERE id = ?', caseRow.boundary_id) : ds?.boundary_id ? q.get('SELECT * FROM boundaries WHERE id = ?', ds.boundary_id) : null;
    if (!bnd) return { state: 'missing', text: '報告案件尚未指定盤查邊界。請在「組織院區與邊界」建立營運控制法或股權法邊界，並在報告案件選定。' };
    const approach = { ghg_operational: '營運控制法', ghg_equity: '股權比例法' }[bnd.kind] || `${bnd.kind}（非盤查用邊界類型）`;
    const sites = j(bnd.site_ids, []).map((id) => q.get('SELECT name FROM sites WHERE id = ?', id)?.name).filter(Boolean);
    const def = j(bnd.definition, null);
    return { state: ['ghg_operational', 'ghg_equity'].includes(bnd.kind) ? 'measured' : 'missing',
      text: `合併方法：${approach}。邊界「${bnd.name}」涵蓋：${sites.join('、') || '本院全部院區'}。${def ? `說明：${typeof def === 'string' ? def : JSON.stringify(def)}` : ''}` };
  });
  B('report_boundary', () => {
    const cfg = getConfig('ghg.significance') || {};
    const rows = q.all('SELECT category, COUNT(*) n, SUM(significant IS NULL) unassessed, SUM(significant = 1) sig, SUM(significant = 1 AND quantified = 1) qn FROM ghg_significance WHERE org_id = ? AND year = ? GROUP BY category', orgId, year);
    const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));
    const table = tbl(['類別', '是否納入', '說明'], [
      [ISO_CATEGORIES[1], '納入', '固定燃燒、移動燃燒、製程、逸散（冷媒、SF₆、化糞池）；土地利用變更依顯著性評估'],
      [ISO_CATEGORIES[2], '納入', '外購電力；外購蒸汽、熱能、冷能'],
      ...[3, 4, 5, 6].map((c) => { const r = byCat[c]; return [ISO_CATEGORIES[c], !r ? '未評估' : r.unassessed ? '評估未完成' : r.sig ? `納入 ${r.sig} 項顯著項目（已量化 ${r.qn} 項）` : '經評估不顯著，未量化', '依顯著性評估表']; }),
    ]);
    const missing = !rows.length || rows.some((r) => r.unassessed);
    return { state: missing ? 'missing' : 'measured', text: `顯著性準則：${cfg.criteria || '（未設定）'}${cfg.thresholdPct !== undefined ? `（門檻 ${cfg.thresholdPct}%）` : ''}`, table };
  });
  B('indirect_table', () => {
    const rows = q.all('SELECT * FROM ghg_significance WHERE org_id = ? AND year = ? ORDER BY category, item_code', orgId, year);
    if (!rows.length) return { state: 'missing', text: '尚未進行間接排放顯著性評估（溫室氣體盤查設定 › 顯著性評估）。' };
    return { state: rows.some((r) => r.significant === null) ? 'missing' : 'measured', text: rows.some((r) => r.significant === null) ? '尚有項目未評估。' : '',
      table: tbl(['類別', '項目', '顯著性', '判定理由', '已量化', 'tCO₂e', '量化方法'], rows.map((r) => [`類別${'一二三四五六'[r.category - 1]}`, r.name,
        r.significant === null ? '未評估' : r.significant ? '顯著' : '不顯著', r.reason || '', r.quantified ? '是' : '否', fmt(r.value_tco2e), r.method || ''])) };
  });
  B('exclusions', () => {
    const rows = [];
    for (const a of q.all("SELECT a.*, i.name AS item_name, i.ghg_ref FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND a.applicability = 'not_applicable' AND i.ghg_ref IS NOT NULL", orgId)) {
      rows.push([a.name, a.item_name || '', '判定不適用', `${a.applicability_reason || ''}${a.applicability_approved_by ? '' : '（不適用判定尚待核准）'}`]);
    }
    for (const a of q.all("SELECT a.*, i.name AS item_name FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code IN ('GAS-REF','GAS-FIRE') AND a.status <> 'archived'", orgId)) {
      const g = j(a.attrs, {}).refrigerant || j(a.attrs, {}).agent;
      if (g && MONTREAL.includes(g)) rows.push([a.name, a.item_name, '不屬京都議定書管制氣體', `${g} 為蒙特婁議定書管制物質，不列入溫室氣體排放量`]);
    }
    for (const r of q.all('SELECT * FROM ghg_significance WHERE org_id = ? AND year = ? AND significant = 0', orgId, year)) rows.push([r.name, `類別${'一二三四五六'[r.category - 1]}`, '不顯著', r.reason || '']);
    for (const r of q.all('SELECT * FROM ghg_significance WHERE org_id = ? AND year = ? AND significant = 1 AND quantified = 0', orgId, year)) rows.push([r.name, `類別${'一二三四五六'[r.category - 1]}`, '顯著但未量化', r.reason || '（須補說明未量化原因）']);
    return { state: 'measured', text: rows.length ? '' : '本期無排除之排放源。', table: rows.length ? tbl(['排放源', '項目／類別', '排除型態', '理由'], rows) : null };
  });
  B('base_year', () => {
    const list = q.all('SELECT * FROM ghg_base_years WHERE org_id = ? ORDER BY created_at', orgId);
    if (!list.length) return { state: 'missing', text: '尚未設定基準年（溫室氣體盤查設定 › 基準年）。首次盤查可將本年度設為基準年。' };
    const cur = list[list.length - 1]; const em = j(cur.emissions, {}).values || {};
    const set = list.find((b) => b.kind === 'set');
    return { state: 'measured', text: `基準年：${cur.base_year} 年。選定理由：${set?.reason || ''}。重新計算政策：${cur.policy || set?.policy || '（未填）'}${(cur.recalc_threshold_pct ?? set?.recalc_threshold_pct) !== null && (cur.recalc_threshold_pct ?? set?.recalc_threshold_pct) !== undefined ? `；累積變動達基準年排放量 ${cur.recalc_threshold_pct ?? set?.recalc_threshold_pct}% 即重新計算` : ''}。`,
      table: tbl(['紀錄', '日期', '資料集', '類別一', '類別二', '類別一＋二', '原因'], list.map((b) => { const v = j(b.emissions, {}).values || {};
        return [b.kind === 'set' ? '設定' : '重新計算', b.created_at.slice(0, 10), b.dataset_id, fmt(v['ghg.s1.total']?.value), fmt(v['ghg.s2.total']?.value), fmt(v['ghg.total']?.value), b.reason]; })),
      baseTotal: em['ghg.total']?.value ?? null };
  });
  B('methods', () => {
    const rows = Object.keys(ruleVersions || {}).filter((c) => c.startsWith('ghg.')).sort().map((c) => {
      const r = q.get('SELECT * FROM calculation_rules WHERE code = ? AND version = ?', c, ruleVersions[c]);
      return [r?.name || c, `${c} v${ruleVersions[c]}`, results?.[c]?.trace?.formula || '', r?.description || ''];
    });
    return { state: 'measured', text: '採排放係數法：活動數據（經審核之採用值）× 排放係數 × GWP。選用理由：醫院排放源以燃料燃燒、外購電力與冷媒逸散為主，無連續排放監測系統，排放係數法為主管機關指引建議之方法。',
      table: tbl(['項目', '規則版本', '公式', '說明'], rows) };
  });
  B('method_changes', () => {
    const prev = q.get(`SELECT rr.* FROM report_runs rr JOIN report_cases c ON c.id = rr.case_id JOIN report_templates t ON t.id = c.template_id
      WHERE c.org_id = ? AND t.code = ? AND c.year < ? AND rr.status = 'locked' ORDER BY c.year DESC, rr.run_no DESC LIMIT 1`, orgId, 'GHG-INV', year);
    if (!prev) return { state: 'measured', text: '無前次已封存之盤查報告可比較（首次盤查或前次未於本系統封存）。' };
    const pf = j(prev.factor_versions, {}); const pr = j(prev.rule_versions, {});
    const rows = [];
    for (const [k, v] of Object.entries(factorVersions || {})) if (pf[k] !== v) rows.push(['係數', k, pf[k] ? `v${pf[k]}` : '（前次未使用）', `v${v}`]);
    for (const [k, v] of Object.entries(pr)) if (!(k in (factorVersions || {})) && !(k in (ruleVersions || {}))) { /* 前次有、本次沒用到的規則 */ }
    for (const [k, v] of Object.entries(ruleVersions || {})) if (pr[k] !== v) rows.push(['計算規則', k, pr[k] ? `v${pr[k]}` : '（前次未使用）', `v${v}`]);
    for (const [k] of Object.entries(pf)) if (!(k in (factorVersions || {}))) rows.push(['係數', k, `v${pf[k]}`, '（本次未使用）']);
    return { state: 'measured', text: rows.length ? `與 ${prev.created_at.slice(0, 4)} 年度前次報告（第 ${prev.run_no} 版）相比，下列係數或規則有變更：` : '與前次報告相比，係數與計算規則沒有變更。',
      table: rows.length ? tbl(['類型', '代碼', '前次', '本次'], rows) : null };
  });
  B('factors', () => {
    const rows = Object.entries(factorVersions || {}).filter(([c]) => !c.startsWith('gwp.')).sort().map(([c, v]) => {
      const f = q.get('SELECT * FROM factors WHERE code = ? AND version = ?', c, v);
      return [f?.name || c, `${c} v${v}`, fmt(f?.value, 6), f?.unit || '', `${f?.valid_from || ''}～${f?.valid_to || ''}`, f?.source || ''];
    });
    return { state: 'measured', text: '', table: tbl(['係數', '代碼與版本', '值', '單位', '有效期間', '來源'], rows) };
  });
  B('gwp', () => {
    const set = (getConfig('calc.settings') || {}).gwpSet || 'AR5';
    const rows = Object.entries(factorVersions || {}).filter(([c]) => c.startsWith('gwp.')).sort().map(([c, v]) => {
      const f = q.get('SELECT * FROM factors WHERE code = ? AND version = ?', c, v);
      return [f?.gas || c, fmt(f?.value, 2), f?.note || '', f?.source || ''];
    });
    return { state: 'measured', text: `採用 IPCC ${set === 'AR6' ? '第六次' : '第五次'}評估報告（${set}）100 年全球暖化潛勢。`, table: tbl(['氣體', 'GWP', '說明', '來源'], rows) };
  });
  B('uncertainty_table', () => {
    const r = results?.['ghg.uncertainty_pct'];
    if (!r || r.value === null) return { state: 'missing', text: '無法評估不確定性（沒有排放量或資料不足）。' };
    return { state: 'measured', text: `總不確定性 ±${fmt(r.value * 1, 2)}%（${(getConfig('ghg.uncertainty') || {}).confidence || '95%'} 信賴區間）。${(r.trace.notes || []).join('；')}`,
      table: tbl(['排放源', '項目', '期數', 'tCO₂e', '活動數據 ±%', '係數 ±%', '合成 ±%'], r.trace.inputs.map((i) => [i.asset || i.indicator, q.get('SELECT name FROM calculation_rules WHERE code = ? ORDER BY version DESC', i.indicator)?.name || i.indicator, i.periods || 1, fmt(i.tCO2e), fmt(i.activityPct, 2), fmt(i.factorPct, 2), fmt(i.combinedPct, 2)])) };
  });
  const emissionAssets = () => q.all(`SELECT a.*, i.code AS item_code, i.name AS item_name, i.ghg_ref FROM assets a JOIN inventory_items i ON i.id = a.item_id
    WHERE a.org_id = ? AND a.status <> 'archived' AND i.ghg_ref IS NOT NULL AND i.domain <> 'reference' ORDER BY i.code, a.name`, orgId);
  B('source_inventory', () => {
    const rows = emissionAssets().map((a) => {
      const ref = j(a.ghg_ref, {}); const attrs = j(a.attrs, {});
      const src = q.all('SELECT name FROM data_sources WHERE asset_id = ? AND active = 1', a.id).map((s) => s.name).join('、');
      return [a.name, ASSET_TYPES[a.asset_type] || a.asset_type, `範疇${ref.scope}／${ref.iso}`, TYPE_LABEL[ref.type] || ref.type, attrs.fuel || attrs.refrigerant || attrs.agent || attrs.gas || '—',
        gasesFor(a, ref.type), src || '—', { applicable: '適用', not_applicable: '不適用', pending: '待查證', undetermined: '未判定' }[a.applicability]];
    });
    return { state: rows.some((r) => r[7] === '未判定') ? 'partial' : 'measured', text: rows.some((r) => r[7] === '未判定') ? '尚有排放源未判定適用性。' : '',
      table: tbl(['排放源', '設備類型', '範疇／類別', '排放型式', '原燃物料', '可能產生之溫室氣體', '活動數據來源', '適用性'], rows) };
  });
  B('data_quality', () => {
    const cfg = getConfig('ghg.data_quality') || {};
    const rows = []; let wSum = 0; let wScore = 0;
    const emissionByAsset = new Map();
    for (const r of Object.values(results || {})) for (const i of r.trace?.inputs || []) if (i.assetId && i.kgCO2e && !i.excluded) emissionByAsset.set(i.assetId, (emissionByAsset.get(i.assetId) || 0) + i.kgCO2e);
    for (const a of emissionAssets()) {
      if (a.applicability !== 'applicable') continue;
      const facts = datasetId ? q.all('SELECT * FROM approved_facts WHERE dataset_id = ? AND asset_id = ? AND is_current = 1', datasetId, a.id) : [];
      if (!facts.length) continue;
      const d = dqFor(a, facts, cfg);
      const e = emissionByAsset.get(a.id) || 0;
      wSum += e; wScore += e * d.score;
      rows.push([a.name, `${d.activityType}（${cfg.activityType?.[d.activityType] || ''}）`, `${d.activityTrust}（${cfg.activityTrust?.[d.activityTrust] || ''}）`, `${d.factorType}（${cfg.factorType?.[d.factorType] || ''}）`,
        d.score, d.grade, fmt(e / 1000), d.overridden ? '人工指定' : '系統推定']);
    }
    const avg = wSum ? wScore / wSum : null;
    const grade = avg === null ? '—' : (cfg.grades || []).find((g) => avg <= g.max)?.grade || '—';
    return { state: rows.length ? 'measured' : 'missing', text: rows.length ? `依排放量加權平均積分 ${fmt(avg, 2)}，整體${grade}。等級可在標的專屬欄位 dq（activityType／activityTrust／factorType）人工指定。` : '資料集沒有排放源採用值。',
      table: rows.length ? tbl(['排放源', '活動數據種類', '活動數據可信度', '排放係數種類', '積分', '等級', 'tCO₂e', '依據'], rows) : null };
  });
  return out;
}

export { STATE_LABEL as _STATE_LABEL, round as _round };
