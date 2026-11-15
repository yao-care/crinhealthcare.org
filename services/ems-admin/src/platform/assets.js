// M01 組織院區＋M02 標的台帳（PRD §4、§5.1、§5.2、§7.2）
import { q, insert, update, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, can, orgsFor, invalidateOrgs, orgById } from './authz.js';
import { bad, notFound, conflict, mask, j, isDate } from './util.js';
import { WORK_STATUS, APPLICABILITY, ASSET_TYPES, DOMAINS } from './seed/dictionary.js';

const ASSET_JSON = ['attrs', 'data_spec'];

// ── 組織、院區、建物、邊界 ──
export function listOrgs(ctx) {
  const ids = new Set(orgsFor(ctx, 'view.public'));
  return q.all('SELECT * FROM organizations ORDER BY code').filter((o) => ids.has(o.id) || o.kind === 'group' && q.all('SELECT id FROM organizations WHERE parent_id = ?', o.id).some((c) => ids.has(c.id)));
}

export function saveOrg(ctx, body) {
  const t = nowIso();
  if (body.id) {
    const o = q.get('SELECT * FROM organizations WHERE id = ?', body.id); if (!o) throw notFound('組織');
    assertCan(ctx, 'org.write', o.id);
    const patch = { name: body.name, parent_id: body.parentId, valid_from: body.validFrom, valid_to: body.validTo, updated_at: t };
    if (patch.parent_id === o.id) throw bad('上層組織不可是自己');
    update('organizations', o.id, patch);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: o.id, action: 'org.update', targetType: 'organization', targetId: o.id, before: o, after: patch });
    invalidateOrgs(); return { id: o.id };
  }
  assertCan(ctx, 'org.write', body.parentId || null);
  if (!body.code || !body.name || !body.kind) throw bad('請填代碼、名稱與類型');
  if (q.get('SELECT 1 FROM organizations WHERE code = ?', body.code)) throw conflict('組織代碼已存在');
  const id = newId('org');
  insert('organizations', { id, parent_id: body.parentId || null, kind: body.kind, code: body.code, name: body.name,
    valid_from: body.validFrom || '1900-01-01', valid_to: body.validTo || null, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: id, action: 'org.create', targetType: 'organization', targetId: id, after: body });
  invalidateOrgs(); return { id };
}

export function listSites(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  const sites = q.all('SELECT * FROM sites WHERE org_id = ? ORDER BY created_at', orgId);
  const bld = q.all('SELECT b.* FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.org_id = ?', orgId);
  return sites.map((s) => ({ ...s, buildings: bld.filter((b) => b.site_id === s.id) }));
}

export function saveSite(ctx, body) {
  const t = nowIso();
  assertCan(ctx, 'org.write', body.orgId);
  if (!body.name) throw bad('請填院區名稱');
  if (body.id) {
    const s = q.get('SELECT * FROM sites WHERE id = ? AND org_id = ?', body.id, body.orgId); if (!s) throw notFound('院區');
    const patch = { name: body.name, address: body.address, note: body.note, valid_from: body.validFrom, valid_to: body.validTo, updated_at: t };
    update('sites', s.id, patch);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'site.update', targetType: 'site', targetId: s.id, before: s, after: patch });
    return { id: s.id };
  }
  const id = newId('site');
  insert('sites', { id, org_id: body.orgId, name: body.name, address: body.address || null, note: body.note || null,
    valid_from: body.validFrom || '1900-01-01', valid_to: body.validTo || null, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'site.create', targetType: 'site', targetId: id, after: body });
  return { id };
}

export function saveBuilding(ctx, body) {
  const t = nowIso();
  const site = q.get('SELECT * FROM sites WHERE id = ?', body.siteId); if (!site) throw notFound('院區');
  assertCan(ctx, 'org.write', site.org_id);
  if (!body.name) throw bad('請填建物名稱');
  if (body.id) {
    const b = q.get('SELECT * FROM buildings WHERE id = ?', body.id); if (!b) throw notFound('建物');
    const patch = { name: body.name, floors: body.floors, floor_area_m2: body.floorAreaM2, note: body.note, valid_from: body.validFrom, valid_to: body.validTo, updated_at: t };
    update('buildings', b.id, patch);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: site.org_id, action: 'building.update', targetType: 'building', targetId: b.id, before: b, after: patch });
    return { id: b.id };
  }
  const id = newId('bld');
  insert('buildings', { id, site_id: site.id, name: body.name, floors: body.floors || null, floor_area_m2: body.floorAreaM2 ?? null, note: body.note || null,
    valid_from: body.validFrom || '1900-01-01', valid_to: body.validTo || null, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: site.org_id, action: 'building.create', targetType: 'building', targetId: id, after: body });
  return { id };
}

export function listBoundaries(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT * FROM boundaries WHERE org_id = ? ORDER BY created_at', orgId).map((b) => parseJson(b, ['site_ids', 'definition']));
}
export function saveBoundary(ctx, body) {
  const t = nowIso();
  assertCan(ctx, 'org.write', body.orgId);
  if (!body.name || !body.kind) throw bad('請填邊界名稱與類型');
  const row = { name: body.name, kind: body.kind, site_ids: body.siteIds || [], definition: body.definition || null,
    valid_from: body.validFrom || '1900-01-01', valid_to: body.validTo || null, updated_at: t };
  if (body.id) {
    const b = q.get('SELECT * FROM boundaries WHERE id = ? AND org_id = ?', body.id, body.orgId); if (!b) throw notFound('邊界');
    update('boundaries', b.id, row);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'boundary.update', targetType: 'boundary', targetId: b.id, before: b, after: row });
    return { id: b.id };
  }
  const id = newId('bnd');
  insert('boundaries', { id, org_id: body.orgId, ...row, created_by: ctx.userId, created_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'boundary.create', targetType: 'boundary', targetId: id, after: row });
  return { id };
}

// ── 盤點計畫（PRD §6.1）──
export function savePlan(ctx, body) {
  assertCan(ctx, 'asset.write', body.orgId);
  const t = nowIso();
  if (!body.year || !isDate(body.periodStart) || !isDate(body.periodEnd)) throw bad('請填年度與期間');
  const row = { year: body.year, name: body.name || `${body.year} 年度油水電氣盤點`, period_start: body.periodStart, period_end: body.periodEnd,
    boundary_id: body.boundaryId || null, coordinator: body.coordinator || null, domains: body.domains || ['oil', 'water', 'electricity', 'gas'],
    review_rule: body.reviewRule || null, status: body.status || 'active', updated_at: t };
  if (body.id) { update('inventory_plans', body.id, row); audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'plan.update', targetType: 'plan', targetId: body.id, after: row }); return { id: body.id }; }
  const id = newId('plan');
  insert('inventory_plans', { id, org_id: body.orgId, ...row, created_by: ctx.userId, created_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'plan.create', targetType: 'plan', targetId: id, after: row });
  return { id };
}
export function listPlans(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT * FROM inventory_plans WHERE org_id = ? ORDER BY year DESC', orgId).map((p) => parseJson(p, ['domains']));
}

// 套用盤點模板：依項目字典替尚未有標的的項目建「待建檔」草稿標的（PRD §6.1 第 2、3 點）
export function applyPlanTemplate(ctx, orgId, { domains = ['oil', 'water', 'electricity', 'gas'], itemCodes } = {}) {
  assertCan(ctx, 'asset.write', orgId);
  const items = q.all("SELECT * FROM inventory_items WHERE active = 1 AND domain IN ('oil','water','electricity','gas')")
    .filter((i) => domains.includes(i.domain) && (!itemCodes || itemCodes.includes(i.code)));
  const site = q.get('SELECT id FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', orgId);
  let created = 0;
  tx(() => {
    for (const it of items) {
      if (q.get('SELECT 1 FROM assets WHERE org_id = ? AND item_id = ?', orgId, it.id)) continue;
      const types = j(it.asset_types, []);
      createAsset(ctx, { orgId, siteId: site?.id, itemId: it.id, domain: it.domain, assetType: types[0] || 'equipment',
        name: `${it.name}（待建檔）`, status: 'draft' }, { skipCheck: true });
      created++;
    }
  });
  return { created };
}

// ── 標的 ──
function withOrg(a) { return a && { ...parseJson(a, ASSET_JSON) }; }

export function getAsset(ctx, id) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id);
  if (!a) throw notFound('標的');
  assertCan(ctx, 'view.internal', a.org_id);
  return present(ctx, withOrg(a));
}

function present(ctx, a) {
  const sensitive = can(ctx, 'view.sensitive', a.org_id);
  return { ...a, external_key: a.external_key_sensitive && !sensitive ? mask(a.external_key) : a.external_key, masked: !!(a.external_key_sensitive && !sensitive) };
}

export function listAssets(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (f.orgId) assertCan(ctx, 'view.internal', f.orgId);
  if (!orgIds.length) return [];
  const where = [`a.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.domain) { where.push('a.domain = ?'); p.push(f.domain); }
  if (f.siteId) { where.push('a.site_id = ?'); p.push(f.siteId); }
  if (f.workStatus) { where.push('a.work_status = ?'); p.push(f.workStatus); }
  if (f.applicability) { where.push('a.applicability = ?'); p.push(f.applicability); }
  if (f.ownerStatus) { where.push('a.owner_status = ?'); p.push(f.ownerStatus); }
  if (f.itemId) { where.push('a.item_id = ?'); p.push(f.itemId); }
  if (!f.includeDisabled) where.push("a.status <> 'archived'");
  if (f.q) { where.push('(a.name LIKE ? OR a.external_key LIKE ? OR a.location LIKE ? OR i.name LIKE ?)'); const s = `%${f.q}%`; p.push(s, s, s, s); }
  const rows = q.all(`SELECT a.*, i.name AS item_name, i.code AS item_code, s.name AS site_name, b.name AS building_name, o.name AS org_name,
      u.display_name AS owner_name,
      (SELECT COUNT(*) FROM data_sources ds WHERE ds.asset_id = a.id AND ds.active = 1) AS source_count,
      (SELECT COUNT(*) FROM observations ob WHERE ob.asset_id = a.id AND ob.quality_status <> 'superseded') AS obs_count,
      (SELECT MAX(submitted_at) FROM observations ob WHERE ob.asset_id = a.id) AS last_obs_at,
      (SELECT COUNT(*) FROM discrepancy_cases dc WHERE dc.asset_id = a.id AND dc.status <> 'closed') AS open_cases,
      (SELECT COUNT(DISTINCT COALESCE(ul.report_case_id, ul.usage_name)) FROM usage_links ul WHERE ul.asset_id = a.id AND ul.status IN ('cited','published')) AS usage_count
    FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id LEFT JOIN sites s ON s.id = a.site_id
    LEFT JOIN buildings b ON b.id = a.building_id LEFT JOIN organizations o ON o.id = a.org_id LEFT JOIN users u ON u.id = a.owner_user_id
    WHERE ${where.join(' AND ')} ORDER BY a.domain, i.code, a.name LIMIT ${Math.min(Number(f.limit) || 500, 2000)}`, ...p);
  return rows.map((r) => present(ctx, withOrg(r)));
}

const ASSET_FIELDS = {
  siteId: 'site_id', buildingId: 'building_id', itemId: 'item_id', domain: 'domain', assetType: 'asset_type', name: 'name',
  externalKey: 'external_key', externalKeySensitive: 'external_key_sensitive', parentAssetId: 'parent_asset_id', shared: 'shared', leased: 'leased',
  location: 'location', floor: 'floor', coords: 'coords', meterMultiplier: 'meter_multiplier', attrs: 'attrs', dataSpec: 'data_spec',
  ownerUserId: 'owner_user_id', ownerStatus: 'owner_status', nextStep: 'next_step', dueDate: 'due_date', status: 'status',
  validFrom: 'valid_from', validTo: 'valid_to',
};

function validateAsset(row) {
  if (!row.name) throw bad('請填標的名稱');
  if (!DOMAINS[row.domain] || row.domain === 'reference') throw bad('請選油、水、電、氣類別');
  if (row.asset_type && !ASSET_TYPES[row.asset_type]) throw bad(`不認得的標的類型 ${row.asset_type}`);
  if (row.meter_multiplier !== undefined && !(Number(row.meter_multiplier) > 0)) throw bad('表計倍率須大於 0');
  if (row.parent_asset_id) {
    const p = q.get('SELECT org_id FROM assets WHERE id = ?', row.parent_asset_id);
    if (!p) throw bad('上層標的不存在');
  }
}

export function createAsset(ctx, body, { skipCheck = false } = {}) {
  if (!skipCheck) assertCan(ctx, 'asset.write', body.orgId);
  const t = nowIso();
  const row = { id: newId('ast'), org_id: body.orgId };
  for (const [k, col] of Object.entries(ASSET_FIELDS)) if (body[k] !== undefined) row[col] = body[k];
  if (!row.domain && row.item_id) row.domain = q.get('SELECT domain FROM inventory_items WHERE id = ?', row.item_id)?.domain;
  validateAsset(row);
  if (row.external_key && q.get(`SELECT 1 FROM assets WHERE org_id = ? AND IFNULL(site_id,'') = IFNULL(?, '') AND asset_type = ? AND external_key = ? AND status <> 'archived'`,
    row.org_id, row.site_id || null, row.asset_type, row.external_key)) {
    throw conflict('同院區已有相同類型與識別碼的標的（一物一碼），請改用既有標的或先停用舊的', { code: 'duplicate_asset' });
  }
  row.work_status = row.work_status || 'to_register';
  row.owner_status = row.owner_user_id ? 'confirmed' : (row.owner_status || 'unknown');
  Object.assign(row, { created_by: ctx.userId, created_at: t, updated_at: t });
  tx(() => {
    insert('assets', row);
    insert('asset_history', { id: newId('ah'), asset_id: row.id, change_type: 'create', after: row, reason: body.reason || null, actor: ctx.userId, effective_at: row.valid_from || t.slice(0, 10), at: t });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: row.org_id, action: 'asset.create', targetType: 'asset', targetId: row.id, after: row });
  });
  return { id: row.id };
}

export function updateAsset(ctx, id, body) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'asset.write', a.org_id);
  const patch = {};
  for (const [k, col] of Object.entries(ASSET_FIELDS)) if (body[k] !== undefined && k !== 'domain') patch[col] = body[k];
  // 識別碼被遮罩時前端送回的是遮罩字串，不能寫回
  if (patch.external_key && /•/.test(patch.external_key)) delete patch.external_key;
  validateAsset({ ...a, ...patch });
  const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(j(a[k], a[k])));
  if (!changed.length) return { id, unchanged: true };
  if (a.status !== 'draft' && !body.reason) throw bad('已建檔的標的修改需填寫原因', { code: 'reason_required' });
  patch.updated_at = nowIso();
  if (patch.owner_user_id) patch.owner_status = 'confirmed';
  tx(() => {
    update('assets', id, patch);
    insert('asset_history', { id: newId('ah'), asset_id: id, change_type: body.changeType || 'update', before: Object.fromEntries(changed.map((k) => [k, a[k]])),
      after: Object.fromEntries(changed.map((k) => [k, patch[k]])), reason: body.reason || null, actor: ctx.userId, effective_at: body.effectiveAt || patch.updated_at.slice(0, 10), at: patch.updated_at });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: a.org_id, action: 'asset.update', targetType: 'asset', targetId: id, before: a, after: patch });
  });
  return { id };
}

// 停用（不刪除；舊資料保留）
export function disableAsset(ctx, id, reason) {
  if (!reason) throw bad('停用需填原因');
  return updateAsset(ctx, id, { status: 'disabled', validTo: new Date().toISOString().slice(0, 10), reason, changeType: 'disable' });
}

// 複製歷史標的（跨年度沿用）：新標的、同規格，不帶觀測值
export function cloneAsset(ctx, id, overrides = {}) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'asset.write', a.org_id);
  const body = { orgId: a.org_id, siteId: a.site_id, buildingId: a.building_id, itemId: a.item_id, domain: a.domain, assetType: a.asset_type,
    name: overrides.name || `${a.name}（複製）`, externalKey: overrides.externalKey ?? null, externalKeySensitive: !!a.external_key_sensitive,
    parentAssetId: a.parent_asset_id, shared: !!a.shared, leased: !!a.leased, location: a.location, floor: a.floor, meterMultiplier: a.meter_multiplier,
    attrs: j(a.attrs, {}), dataSpec: j(a.data_spec, []), reason: `複製自 ${a.name}` };
  return createAsset(ctx, body);
}

// 適用性判定（PRD §5.2）：不適用須記原因＋核准人
export function setApplicability(ctx, id, { applicability, reason }) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'asset.applicability', a.org_id);
  if (!APPLICABILITY[applicability]) throw bad('不認得的適用性');
  if (applicability === 'not_applicable' && !reason) throw bad('判定不適用必須填原因');
  const t = nowIso();
  tx(() => {
    update('assets', id, { applicability, applicability_reason: reason || null, applicability_by: ctx.userId, applicability_at: t,
      applicability_approved_by: null, updated_at: t });
    insert('work_events', { id: newId('we'), asset_id: id, axis: 'applicability', from_status: a.applicability, to_status: applicability, note: reason || null, actor: ctx.userId, at: t });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: a.org_id, action: 'asset.applicability', targetType: 'asset', targetId: id, before: { applicability: a.applicability }, after: { applicability, reason } });
  });
  return { id, needsApproval: applicability === 'not_applicable' };
}
export function approveApplicability(ctx, id, { approve = true, note } = {}) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'asset.applicability.approve', a.org_id);
  if (a.applicability !== 'not_applicable') throw conflict('只有「不適用」判定需要核准');
  if (a.applicability_by === ctx.userId) throw conflict('核准者不可以是判定者');
  const t = nowIso();
  if (approve) update('assets', id, { applicability_approved_by: ctx.userId, updated_at: t });
  else update('assets', id, { applicability: 'pending', applicability_approved_by: null, updated_at: t });
  insert('work_events', { id: newId('we'), asset_id: id, axis: 'applicability', from_status: 'not_applicable', to_status: approve ? 'not_applicable(approved)' : 'pending', note: note || null, actor: ctx.userId, at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: a.org_id, action: approve ? 'asset.applicability_approve' : 'asset.applicability_reject', targetType: 'asset', targetId: id, after: { note } });
}

// 資料工作進度：可往返，但每次都留事件
export function setWorkStatus(ctx, id, status, note, { system = false } = {}) {
  const a = q.get('SELECT * FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  if (!system) assertCan(ctx, 'asset.write', a.org_id);
  if (!WORK_STATUS[status]) throw bad('不認得的進度狀態');
  if (a.work_status === status) return;
  const t = nowIso();
  update('assets', id, { work_status: status, updated_at: t });
  insert('work_events', { id: newId('we'), asset_id: id, axis: 'work', from_status: a.work_status, to_status: status, note: note || null, actor: ctx?.userId || 'system', at: t });
}

export function assetLinks(ctx, id) {
  const a = q.get('SELECT org_id FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'view.internal', a.org_id);
  return q.all(`SELECT l.*, p.name AS parent_name, c.name AS child_name FROM asset_links l JOIN assets p ON p.id = l.parent_id JOIN assets c ON c.id = l.child_id
                WHERE l.parent_id = ? OR l.child_id = ?`, id, id).map((r) => parseJson(r, ['allocation']));
}
export function linkAssets(ctx, { parentId, childId, relation, allocation, validFrom, validTo }) {
  const p = q.get('SELECT * FROM assets WHERE id = ?', parentId); const c = q.get('SELECT * FROM assets WHERE id = ?', childId);
  if (!p || !c) throw notFound('標的');
  if (p.org_id !== c.org_id) throw bad('不同院所的標的不能建立層級關係');
  if (parentId === childId) throw bad('不可連到自己');
  assertCan(ctx, 'asset.write', p.org_id);
  if (!['submeter_of', 'feeds', 'supplies', 'part_of'].includes(relation)) throw bad('關係類型不正確');
  // 防循環：childId 的子孫不可包含 parentId
  const seen = new Set([childId]); let frontier = [childId];
  while (frontier.length) {
    const next = q.all(`SELECT child_id FROM asset_links WHERE parent_id IN (${frontier.map(() => '?').join(',')})`, ...frontier).map((r) => r.child_id);
    if (next.includes(parentId)) throw bad('會形成循環關係');
    frontier = next.filter((x) => !seen.has(x)); frontier.forEach((x) => seen.add(x));
  }
  const id = newId('lnk');
  insert('asset_links', { id, parent_id: parentId, child_id: childId, relation, allocation: allocation || null, valid_from: validFrom || '1900-01-01', valid_to: validTo || null, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: p.org_id, action: 'asset.link', targetType: 'asset', targetId: parentId, after: { childId, relation, allocation } });
  return { id };
}
export function unlinkAssets(ctx, linkId) {
  const l = q.get('SELECT l.*, a.org_id FROM asset_links l JOIN assets a ON a.id = l.parent_id WHERE l.id = ?', linkId); if (!l) throw notFound('關係');
  assertCan(ctx, 'asset.write', l.org_id);
  update('asset_links', linkId, { valid_to: new Date().toISOString().slice(0, 10) });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: l.org_id, action: 'asset.unlink', targetType: 'asset', targetId: l.parent_id, before: l });
}

export function assetHistory(ctx, id) {
  const a = q.get('SELECT org_id FROM assets WHERE id = ?', id); if (!a) throw notFound('標的');
  assertCan(ctx, 'view.internal', a.org_id);
  const hist = q.all('SELECT h.*, u.display_name AS actor_name FROM asset_history h LEFT JOIN users u ON u.id = h.actor WHERE asset_id = ? ORDER BY at DESC', id).map((r) => parseJson(r, ['before', 'after']));
  const work = q.all('SELECT w.*, u.display_name AS actor_name FROM work_events w LEFT JOIN users u ON u.id = w.actor WHERE asset_id = ? ORDER BY at DESC', id);
  return { history: hist, work };
}

export const orgName = (id) => orgById(id)?.name || id;
