// 版本化設定（PRD §13.3、§18）：草稿 → 送審 → 發布（另一人核准）→ 可回復。
// 套用在 configuration_versions、factors、calculation_rules、report_templates 四張表，流程相同。
import { q, insert, update, newId, nowIso, audit, tx } from './db.js';
import { bad, conflict, notFound, j } from './util.js';
import { DEFAULT_CONFIG } from './seed/config.js';

const cache = new Map();
export function invalidateConfig() { cache.clear(); }

// 目前生效（已發布、最新版本）
export function getConfig(key) {
  if (cache.has(key)) return cache.get(key);
  const r = q.get("SELECT value, version FROM configuration_versions WHERE key = ? AND status = 'published' ORDER BY version DESC LIMIT 1", key);
  const v = r ? j(r.value) : DEFAULT_CONFIG[key];
  cache.set(key, v);
  return v;
}
export function configVersion(key) {
  return q.get("SELECT version FROM configuration_versions WHERE key = ? AND status = 'published' ORDER BY version DESC LIMIT 1", key)?.version || 0;
}

const TABLES = {
  config: { table: 'configuration_versions', keyCol: 'key', label: '設定' },
  factor: { table: 'factors', keyCol: 'code', label: '係數' },
  rule: { table: 'calculation_rules', keyCol: 'code', label: '計算規則' },
  template: { table: 'report_templates', keyCol: 'code', label: '報告模板' },
};

function meta(kind) { const m = TABLES[kind]; if (!m) throw bad('unknown_kind'); return m; }

export function listVersions(kind, key) {
  const m = meta(kind);
  return q.all(`SELECT * FROM ${m.table} WHERE ${m.keyCol} = ? ORDER BY version DESC`, key);
}

// 建草稿：以最新版本為底，套上 patch
export function createDraft(ctx, kind, key, patch, reason) {
  const m = meta(kind);
  if (!reason) throw bad('請填寫修改原因');
  const latest = q.get(`SELECT * FROM ${m.table} WHERE ${m.keyCol} = ? ORDER BY version DESC LIMIT 1`, key);
  if (kind === 'config' && !latest && DEFAULT_CONFIG[key] === undefined && !patch.allowNew) throw notFound('設定項目');
  const base = latest ? { ...latest } : { [m.keyCol]: key };
  delete base.id; delete base.allowNew;
  const row = { ...base, ...patch, id: newId(kind), version: (latest?.version || 0) + 1, status: 'draft', reason,
    created_by: ctx.userId, created_at: nowIso(), approved_by: null, approved_at: null };
  delete row.allowNew;
  if (kind === 'config') row.value = typeof patch.value === 'string' ? patch.value : JSON.stringify(patch.value ?? j(base.value));
  if (kind === 'template') { /* 欄位映射另外複製 */ }
  return tx(() => {
    insert(m.table, row);
    if (kind === 'template' && latest) {
      for (const mp of q.all('SELECT * FROM report_mappings WHERE template_id = ?', latest.id)) {
        insert('report_mappings', { ...mp, id: newId('map'), template_id: row.id });
      }
    }
    audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.draft`, targetType: kind, targetId: row.id, before: latest ? { version: latest.version } : null, after: { key, version: row.version, reason } });
    return row;
  });
}

export function editDraft(ctx, kind, id, patch) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r) throw notFound(m.label);
  if (r.status !== 'draft') throw conflict('只有草稿可以修改');
  const p = { ...patch };
  for (const k of ['id', 'version', 'status', 'created_by', 'approved_by', 'approved_at', m.keyCol]) delete p[k];
  if (kind === 'config' && p.value !== undefined && typeof p.value !== 'string') p.value = JSON.stringify(p.value);
  update(m.table, id, p);
  audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.edit_draft`, targetType: kind, targetId: id, after: p });
}

export function submit(ctx, kind, id) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r) throw notFound(m.label);
  if (r.status !== 'draft') throw conflict('只有草稿可以送審');
  update(m.table, id, { status: 'pending' });
  audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.submit`, targetType: kind, targetId: id });
}

// 發布：核准者不可是建立者（seed 建立的除外）；同 key 舊版本保留為已發布歷史，取最新版本生效
export function publish(ctx, kind, id, { impactAck = false } = {}) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r) throw notFound(m.label);
  if (!['pending', 'draft'].includes(r.status)) throw conflict('此版本不是待核准狀態');
  if (r.status === 'draft') throw conflict('請先送審');
  if (r.created_by === ctx.userId) throw conflict('核准者不可以是建立者（需另一位管理員核准）');
  const impact = impactOf(kind, r);
  if (impact.lockedReports > 0 && !impactAck) throw conflict('此變更不影響已封存報告，但會影響之後的計算；請確認後再發布', { impact });
  tx(() => {
    if (kind === 'factor') {
      // 同代碼舊版本設有效迄日，不刪
      q.run(`UPDATE factors SET valid_to = COALESCE(valid_to, ?) WHERE code = ? AND status = 'published' AND id <> ? AND valid_from < ?`,
        r.valid_from, r.code, id, r.valid_from);
    }
    update(m.table, id, { status: 'published', approved_by: ctx.userId, approved_at: nowIso(), ...(kind === 'config' ? { effective_at: nowIso(), impact } : {}) });
    audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.publish`, targetType: kind, targetId: id, after: { key: r[m.keyCol], version: r.version, impact } });
  });
  invalidateConfig();
  return { impact };
}

export function reject(ctx, kind, id, note) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r || r.status !== 'pending') throw conflict('此版本不是待核准狀態');
  update(m.table, id, { status: 'draft' });
  audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.reject`, targetType: kind, targetId: id, after: { note } });
}

// 回復：把某個舊版本的內容複製成新草稿（不直接改歷史）
export function rollbackTo(ctx, kind, id, reason) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r) throw notFound(m.label);
  const patch = { ...r };
  for (const k of ['id', 'version', 'status', 'created_by', 'created_at', 'approved_by', 'approved_at', 'reason']) delete patch[k];
  if (kind === 'config') patch.value = r.value;
  return createDraft(ctx, kind, r[m.keyCol], patch, reason || `回復至第 ${r.version} 版`);
}

export function retire(ctx, kind, id, reason) {
  const m = meta(kind);
  const r = q.get(`SELECT * FROM ${m.table} WHERE id = ?`, id);
  if (!r) throw notFound(m.label);
  update(m.table, id, { status: 'retired' });
  audit({ actor: ctx.userId, actorName: ctx.name, action: `${kind}.retire`, targetType: kind, targetId: id, after: { reason } });
  invalidateConfig();
}

// 影響預覽：有多少尚未封存／已封存的報告用到
export function impactOf(kind, r) {
  const runs = q.all("SELECT status, factor_versions, rule_versions, template_version, case_id FROM report_runs WHERE status <> 'superseded'");
  let affectedOpen = 0; let lockedReports = 0;
  for (const run of runs) {
    let uses = false;
    if (kind === 'factor') uses = Object.keys(j(run.factor_versions, {})).includes(r.code);
    else if (kind === 'rule') uses = Object.keys(j(run.rule_versions, {})).includes(r.code);
    else if (kind === 'template') uses = !!q.get('SELECT 1 FROM report_cases c JOIN report_templates t ON t.id = c.template_id WHERE c.id = ? AND t.code = ?', run.case_id, r.code);
    else uses = true;
    if (!uses) continue;
    if (run.status === 'locked') lockedReports++; else affectedOpen++;
  }
  return { affectedOpenReports: affectedOpen, lockedReports, note: lockedReports ? '已封存的報告保留當時版本，不會被改變' : '' };
}

// 計算用：取某代碼在某日有效的已發布係數
export function factorAt(code, date) {
  return q.get(`SELECT * FROM factors WHERE code = ? AND status = 'published' AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
                ORDER BY version DESC LIMIT 1`, code, date, date);
}
export function ruleCurrent(code) {
  return q.get("SELECT * FROM calculation_rules WHERE code = ? AND status = 'published' ORDER BY version DESC LIMIT 1", code);
}
export function ruleVersion(code, version) {
  return q.get('SELECT * FROM calculation_rules WHERE code = ? AND version = ?', code, version);
}
