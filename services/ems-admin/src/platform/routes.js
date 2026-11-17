// /api/v1/* 路由（PRD §16.2）。每條路由一列：方法、路徑、權限說明、處理函式。
// 這張表同時產生 OpenAPI 文件（GET /api/v1/openapi.json），不另外手寫一份。
import QRCode from 'qrcode';
import { q, parseJson, verifyAuditChain } from './db.js';
import { contextFor, can, assertCan, orgsFor, actionsFor, rolesIn, ROLES, ACTION_LABELS, Forbidden, orgById } from './authz.js';
import { HttpError, bad, notFound, j } from './util.js';
import { parseMultipart, readRawBody, classify } from '../upload-io.js';
import { config } from '../config.js';
import * as users from './users.js';
import * as A from './assets.js';
import * as S from './sources.js';
import * as E from './evidence.js';
import * as O from './observations.js';
import * as I from './imports.js';
import * as V from './validation.js';
import * as C from './cases.js';
import * as D from './datasets.js';
import * as R from './reports.js';
import * as X from './export.js';
import * as B from './dashboard.js';
import * as K from './collab.js';
import * as N from './integrations.js';
import * as CFG from './config-store.js';
import * as BK from './backup.js';
import * as G from './ghg.js';
import * as P from './profile.js';
import * as EM from './measures.js';
import * as T from './inv-tree.js';
import { computeAll, ALL_RULE_CODES, STATE_LABEL } from './calc.js';
import { DOMAINS, ASSET_TYPES, WORK_STATUS, APPLICABILITY, USAGE_STATUS, ASSET_ATTRS } from './seed/dictionary.js';
import { CASE_STATUS_LABEL } from './cases.js';
import { insert, update, newId, nowIso, audit } from './db.js';

const R_ = [];
const route = (method, path, summary, handler, opts = {}) => {
  const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  R_.push({ method, path, summary, handler, re, keys, ...opts });
};
const multipart = async (req, limit = E.MAX_BYTES + 1024 * 1024) => {
  const raw = await readRawBody(req, limit);
  const parts = parseMultipart(raw, req.headers['content-type']);
  const fields = {}; let file = null;
  for (const p of parts) { if (p.filename) file = p; else fields[p.name] = p.data.toString('utf8'); }
  return { fields, file };
};
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

// ── 自己 ──
route('GET', '/api/v1/me', '目前使用者、授權與可用動作', (ctx) => {
  const orgs = orgsFor(ctx, 'view.public').map((id) => { const o = orgById(id); return { id, code: o.code, name: o.name, kind: o.kind, parentId: o.parent_id, roles: rolesIn(ctx, id), actions: actionsFor(ctx, id) }; });
  const u = q.get('SELECT username, display_name, email, unit, must_change, totp_enabled, legacy FROM users WHERE id = ?', ctx.userId);
  return { user: { id: ctx.userId, ...u }, grants: ctx.grants, orgs, legacyHid: ctx.legacyHid, isGlobalAdmin: ctx.grants.some((g) => g.role === 'sysadmin' && g.scope_type === 'global') };
});
route('POST', '/api/v1/me/password', '變更自己的密碼', (ctx, { body }) => { users.changeOwnPassword(ctx, body.oldPassword, body.newPassword); return { ok: true }; });
route('POST', '/api/v1/me/totp/start', '開始設定兩步驟驗證', (ctx) => users.startTotp(ctx));
route('POST', '/api/v1/me/totp/confirm', '確認兩步驟驗證', (ctx, { body }) => { users.confirmTotp(ctx, body.code); return { ok: true }; });
route('POST', '/api/v1/me/totp/disable', '關閉自己的兩步驟驗證', (ctx) => { users.disableTotp(ctx, ctx.userId); return { ok: true }; });

route('GET', '/api/v1/meta', '資料字典與代碼表', () => ({
  domains: DOMAINS, assetTypes: ASSET_TYPES, workStatus: WORK_STATUS, applicability: APPLICABILITY, usageStatus: USAGE_STATUS, roles: ROLES, actionLabels: ACTION_LABELS,
  caseStatus: CASE_STATUS_LABEL, valueStates: STATE_LABEL, connectors: N.CONNECTORS, assetAttrs: ASSET_ATTRS, energyTypes: EM.ENERGY_TYPES,
  metrics: q.all('SELECT * FROM metrics WHERE active = 1 ORDER BY domain, code'), units: q.all('SELECT * FROM units ORDER BY dimension, to_base'),
  items: q.all('SELECT * FROM inventory_items WHERE active = 1 ORDER BY domain, code').map((i) => parseJson(i, ['asset_types', 'metrics', 'required_data', 'source_hints', 'special_rules', 'usage_candidates', 'ghg_ref', 'open_questions'])),
}));

// ── 組織 ──
route('GET', '/api/v1/orgs', '可見的組織', (ctx) => A.listOrgs(ctx));
route('POST', '/api/v1/orgs', '新增／修改組織（org.write）', (ctx, { body }) => A.saveOrg(ctx, body));
route('GET', '/api/v1/orgs/:id/sites', '院區與建物', (ctx, { params }) => A.listSites(ctx, params.id));
route('POST', '/api/v1/sites', '新增／修改院區', (ctx, { body }) => A.saveSite(ctx, body));
route('POST', '/api/v1/buildings', '新增／修改建物', (ctx, { body }) => A.saveBuilding(ctx, body));
route('GET', '/api/v1/orgs/:id/boundaries', '盤查／計量邊界', (ctx, { params }) => A.listBoundaries(ctx, params.id));
route('POST', '/api/v1/boundaries', '新增／修改邊界', (ctx, { body }) => A.saveBoundary(ctx, body));
route('GET', '/api/v1/orgs/:id/plans', '盤點計畫', (ctx, { params }) => A.listPlans(ctx, params.id));
route('POST', '/api/v1/plans', '新增／修改盤點計畫', (ctx, { body }) => A.savePlan(ctx, body));
route('POST', '/api/v1/orgs/:id/apply-template', '套用油水電氣盤點模板，產生待建檔標的', (ctx, { params, body }) => A.applyPlanTemplate(ctx, params.id, body));

// ── 帳號 ──
route('GET', '/api/v1/users', '帳號清單（user.manage）', (ctx, { query }) => {
  if (!can(ctx, 'user.manage', query.orgId || null)) throw new Forbidden('user.manage');
  return users.listUsers(ctx, query.orgId || null);
});
route('GET', '/api/v1/users/directory', '同院所人員（指派用，只含姓名與單位）', (ctx, { query }) => {
  assertCan(ctx, 'view.internal', query.orgId);
  return q.all(`SELECT DISTINCT u.id, u.display_name, u.unit FROM users u JOIN grants g ON g.user_id = u.id WHERE g.revoked_at IS NULL AND u.status = 'active'
    AND (g.scope_type = 'global' OR g.scope_id = ? OR g.scope_id = (SELECT parent_id FROM organizations WHERE id = ?)) ORDER BY u.display_name`, query.orgId, query.orgId)
    .map((u) => ({ ...u, roles: q.all("SELECT DISTINCT role FROM grants WHERE user_id = ? AND revoked_at IS NULL", u.id).map((r) => r.role) }));
});
route('POST', '/api/v1/users', '建立個人帳號', (ctx, { body }) => users.createUser(ctx, body));
route('PATCH', '/api/v1/users/:id', '修改帳號資料或停用', (ctx, { params, body }) => { users.updateUser(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/users/:id/password', '重設密碼（下次登入須變更）', (ctx, { params, body }) => { users.resetPassword(ctx, params.id, body.password); return { ok: true }; });
route('POST', '/api/v1/users/:id/grants', '新增角色授權（可設有效期間、代理）', (ctx, { params, body }) => users.addGrant(ctx, params.id, body));
route('DELETE', '/api/v1/grants/:id', '撤銷授權', (ctx, { params }) => { users.revokeGrant(ctx, params.id); return { ok: true }; });
route('POST', '/api/v1/users/:id/totp/disable', '關閉他人的兩步驟驗證', (ctx, { params }) => { users.disableTotp(ctx, params.id); return { ok: true }; });

// ── 字典維護（system admin；有版本號）──
route('POST', '/api/v1/inventory-items', '新增／修改盤點項目（config.write）', (ctx, { body }) => {
  assertCan(ctx, 'config.write', null);
  const t = nowIso();
  const cols = { domain: body.domain, subtype: body.subtype, name: body.name, description: body.description, asset_types: body.assetTypes, metrics: body.metrics, required_data: body.requiredData,
    source_hints: body.sourceHints, expected_frequency: body.expectedFrequency, collection_guidance: body.collectionGuidance, applicability_rules: body.applicabilityRules,
    special_rules: body.specialRules, usage_candidates: body.usageCandidates, ghg_ref: body.ghgRef, active: body.active === undefined ? undefined : (body.active === false ? 0 : 1), updated_at: t };
  const ex = q.get('SELECT * FROM inventory_items WHERE code = ?', body.code);
  if (ex) { update('inventory_items', ex.id, { ...cols, version: ex.version + 1 }); audit({ actor: ctx.userId, actorName: ctx.name, action: 'item.update', targetType: 'item', targetId: ex.id, before: ex, after: cols }); return { id: ex.id, version: ex.version + 1 }; }
  if (!body.code || !body.name || !body.domain) throw bad('代碼、名稱、面向必填');
  const id = newId('item'); insert('inventory_items', { id, code: body.code, ...cols, created_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'item.create', targetType: 'item', targetId: id, after: cols }); return { id, version: 1 };
});
route('POST', '/api/v1/metrics', '新增指標（config.write）', (ctx, { body }) => {
  assertCan(ctx, 'config.write', null);
  if (!body.code || !body.name || !body.stdUnit || !body.semantics || !body.valueKind) throw bad('代碼、名稱、標準單位、語意、值型態必填');
  if (q.get('SELECT 1 FROM metrics WHERE code = ?', body.code)) throw bad('指標代碼已存在（指標代碼不可改，請新增）');
  if (!q.get('SELECT 1 FROM units WHERE code = ?', body.stdUnit)) throw bad('單位不存在');
  insert('metrics', { code: body.code, domain: body.domain, name: body.name, semantics: body.semantics, value_kind: body.valueKind, std_unit: body.stdUnit, description: body.description || null });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'metric.create', targetType: 'metric', targetId: body.code, after: body }); return { ok: true };
});
route('POST', '/api/v1/units', '新增單位（config.write）', (ctx, { body }) => {
  assertCan(ctx, 'config.write', null);
  if (!body.code || !body.name || !body.dimension || !body.baseUnit || !(Number(body.toBase) > 0)) throw bad('單位欄位不完整');
  if (q.get('SELECT 1 FROM units WHERE code = ?', body.code)) throw bad('單位已存在（換算倍率不可改，避免影響歷史計算）');
  insert('units', { code: body.code, name: body.name, dimension: body.dimension, base_unit: body.baseUnit, to_base: Number(body.toBase) });
  audit({ actor: ctx.userId, actorName: ctx.name, action: 'unit.create', targetType: 'unit', targetId: body.code, after: body }); return { ok: true };
});

// ── 標的 ──
route('GET', '/api/v1/assets', '標的台帳（篩選：orgId、domain、workStatus、applicability、ownerStatus、q）', (ctx, { query }) => A.listAssets(ctx, query));
route('POST', '/api/v1/assets', '新增標的（一物一碼）', (ctx, { body }) => A.createAsset(ctx, body));
route('GET', '/api/v1/assets/:id', '標的詳細：歷程、上下層、來源、觀測摘要、成果引用', (ctx, { params, query }) => {
  const a = A.getAsset(ctx, params.id);
  const y = Number(query.year) || new Date().getFullYear();
  return { asset: a, ...A.assetHistory(ctx, params.id), links: A.assetLinks(ctx, params.id), sources: S.listSources(ctx, { orgId: a.org_id, assetId: a.id }),
    completeness: O.completeness(a.id, `${y}-01-01`, `${y + 1}-01-01`), usage: R.feedbackFor(ctx, { assetId: a.id }), usageCandidates: R.usageCandidates(a.id),
    cases: C.listCases(ctx, { orgId: a.org_id, assetId: a.id, all: true }), searchTasks: S.listSearchTasks(ctx, { orgId: a.org_id, all: true }).filter((t) => t.asset_id === a.id),
    item: a.item_id ? parseJson(q.get('SELECT * FROM inventory_items WHERE id = ?', a.item_id), ['asset_types', 'metrics', 'required_data', 'source_hints', 'special_rules', 'usage_candidates', 'ghg_ref']) : null };
});
route('PATCH', '/api/v1/assets/:id', '修改標的（已建檔須填原因）', (ctx, { params, body }) => A.updateAsset(ctx, params.id, body));
route('POST', '/api/v1/assets/:id/disable', '停用標的（保留歷史）', (ctx, { params, body }) => A.disableAsset(ctx, params.id, body.reason));
route('POST', '/api/v1/assets/:id/clone', '複製歷史標的', (ctx, { params, body }) => A.cloneAsset(ctx, params.id, body));
route('POST', '/api/v1/assets/:id/applicability', '判定適用性', (ctx, { params, body }) => A.setApplicability(ctx, params.id, body));
route('POST', '/api/v1/assets/:id/applicability/approve', '核准／退回不適用判定', (ctx, { params, body }) => { A.approveApplicability(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/assets/:id/work-status', '變更資料工作進度（留事件）', (ctx, { params, body }) => { A.setWorkStatus(ctx, params.id, body.status, body.note); return { ok: true }; });
route('GET', '/api/v1/assets/:id/comparison', '多源比對（metric 必填）', (ctx, { params, query }) => O.comparison(ctx, params.id, { metricCode: query.metric, from: query.from, to: query.to }));
route('GET', '/api/v1/assets/:id/qr.png', '標的 QR Code（掃描直接開現場盤點）', async (ctx, { params, res }) => {
  const a = A.getAsset(ctx, params.id);
  const png = await QRCode.toBuffer(`${config.publicBaseUrl}/p/#/collect/${a.id}`, { width: 512, margin: 2 });
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="${encodeURIComponent(a.name)}.png"`, 'Cache-Control': 'no-store' });
  res.end(png); return RAW;
});
route('POST', '/api/v1/asset-links', '建立上下層（總表→分表、油槽→設備）', (ctx, { body }) => A.linkAssets(ctx, body));
route('DELETE', '/api/v1/asset-links/:id', '結束上下層關係', (ctx, { params }) => { A.unlinkAssets(ctx, params.id); return { ok: true }; });

// ── 來源與追查 ──
// ── 盤點樹（院所頁三欄：左樹、中節點內容、右報告欄位）──
route('GET', '/api/v1/orgs/:id/inv-tree', '盤點樹：油水電氣；電分台電（電號→分盤→設備）與分區（建物→樓層）', (ctx, { params }) => T.tree(ctx, params.id));
route('GET', '/api/v1/inv-node', '盤點節點內容（kind=asset｜building｜floor；year、metric 選填）', (ctx, { query }) => {
  if (query.kind === 'asset') return T.assetNode(ctx, query.id, { year: query.year, metric: query.metric });
  if (query.kind === 'building' || query.kind === 'floor') return T.zoneNode(ctx, query.orgId, query.id);
  throw bad('kind 須為 asset、building 或 floor');
});
route('GET', '/api/v1/inv-fields', '某標的（某指標）或建物會用在哪些報告欄位', (ctx, { query }) => {
  if (query.profileKey) return T.profileFieldsFor(query.profileKey);
  if (query.assetId) { const a = A.getAsset(ctx, query.assetId); return T.fieldsFor({ asset: q.get('SELECT * FROM assets WHERE id = ?', a.id), metric: query.metric || null }); }
  return T.fieldsFor({ zone: true });
});
route('POST', '/api/v1/asset-zones', '標的供應範圍（建物或樓層；網狀關係）', (ctx, { body }) => T.addZoneLink(ctx, body));
route('DELETE', '/api/v1/asset-zones/:id', '結束供應範圍', (ctx, { params }) => T.endZoneLink(ctx, params.id));

route('GET', '/api/v1/data-sources', '資料來源', (ctx, { query }) => S.listSources(ctx, query));
route('POST', '/api/v1/data-sources', '新增／修改資料來源', (ctx, { body }) => S.saveSource(ctx, body));
route('POST', '/api/v1/source-contacts', '來源與窗口關聯（候選／確認保管者／代理）', (ctx, { body }) => S.linkSourceContact(ctx, body));
route('DELETE', '/api/v1/source-contacts/:id', '結束窗口關聯（保留歷程）', (ctx, { params, query }) => { S.endSourceContact(ctx, params.id, query.validTo); return { ok: true }; });
route('GET', '/api/v1/contacts', '聯絡窗口', (ctx, { query }) => S.listContacts(ctx, query.orgId));
route('POST', '/api/v1/contacts', '新增／修改聯絡窗口', (ctx, { body }) => S.saveContact(ctx, body));
route('GET', '/api/v1/source-suggest', '用關鍵字找線索', (ctx, { query }) => S.suggest(ctx, query.orgId, query.q));
route('GET', '/api/v1/source-search-tasks', '來源追查任務', (ctx, { query }) => S.listSearchTasks(ctx, { ...query, mine: query.mine === '1', all: query.all === '1' }));
route('POST', '/api/v1/source-search-tasks', '不知道找誰時建立追查', (ctx, { body }) => S.createSearchTask(ctx, body));
route('GET', '/api/v1/source-search-tasks/:id', '追查詳細（含建議線索）', (ctx, { params }) => S.getSearchTask(ctx, params.id));
route('POST', '/api/v1/source-search-tasks/:id/inquiries', '記錄一次詢問', (ctx, { params, body }) => S.addInquiry(ctx, params.id, body));
route('POST', '/api/v1/inquiries/:id/answer', '記錄回覆或轉介', (ctx, { params, body }) => { S.answerInquiry(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/source-search-tasks/:id/escalate', '移交統籌人協調', (ctx, { params, body }) => { S.escalate(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/source-search-tasks/:id/resolve', '找到來源：建立來源、確認保管者、寫入知識庫', (ctx, { params, body }) => S.resolveSearch(ctx, params.id, body));
route('POST', '/api/v1/source-search-tasks/:id/close', '結案（找不到或不需要）', (ctx, { params, body }) => { S.closeSearch(ctx, params.id, body.note); return { ok: true }; });
route('GET', '/api/v1/knowledge', '來源知識庫', (ctx, { query }) => S.listKnowledge(ctx, query.orgId));
route('POST', '/api/v1/knowledge', '新增知識（候選）', (ctx, { body }) => S.addKnowledge(ctx, body));

// ── 證據 ──
route('POST', '/api/v1/evidence', '上傳佐證（multipart：file、orgId、confidentiality、kind、assetId、sourceId）', async (ctx, { req }) => {
  const { fields, file } = await multipart(req);
  if (!file) throw bad('沒有檔案');
  return E.storeEvidence(ctx, { orgId: fields.orgId, filename: file.filename, data: file.data, confidentiality: fields.confidentiality || 'internal', kind: fields.kind, assetId: fields.assetId || null, sourceId: fields.sourceId || null, note: fields.note });
}, { multipart: true });
route('GET', '/api/v1/evidence', '佐證文件庫', (ctx, { query }) => E.listEvidence(ctx, query));
route('PATCH', '/api/v1/evidence/:id', '修改佐證的機敏等級或說明', (ctx, { params, body }) => { E.updateEvidenceMeta(ctx, params.id, body); return { ok: true }; });
route('GET', '/api/v1/evidence/:id/file', '下載原始佐證（留稽核）', async (ctx, { params, res, req }) => {
  const { ev, data } = await E.readEvidence(ctx, params.id, { ip: req.socket.remoteAddress });
  res.writeHead(200, { 'Content-Type': ev.mime, 'Content-Length': data.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(ev.filename)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  res.end(data); return RAW;
});

// ── 觀測 ──
route('GET', '/api/v1/observations', '原始觀測值（不含已取代版本，includeSuperseded=1 顯示全部）', (ctx, { query }) => O.listObservations(ctx, { ...query, includeSuperseded: query.includeSuperseded === '1' }));
route('POST', '/api/v1/observations', '新增原始觀測值', (ctx, { body }) => O.addObservation(ctx, body, { method: body.method === 'ocr' ? 'ocr' : 'manual', evidenceIds: body.evidenceIds || [] }));
route('POST', '/api/v1/observations/batch', '批次觀測（冪等：同 sourceRecordKey 重送不會重複）', (ctx, { body }) => {
  const items = body.items || []; if (!Array.isArray(items) || items.length > 2000) throw bad('items 須為陣列且不超過 2000 筆');
  const out = { created: 0, duplicate: 0, new_version: 0, errors: [] };
  items.forEach((it, i) => { try { out[O.addObservation(ctx, it, { method: 'manual', evidenceIds: it.evidenceIds || [] }).status]++; } catch (e) { out.errors.push({ index: i, msg: e.message }); } });
  return out;
});
route('GET', '/api/v1/observations/:id', '觀測值詳細：版本、分攤／差分、佐證、檢核、採用', (ctx, { params }) => O.observationDetail(ctx, params.id));
route('POST', '/api/v1/observations/:id/correct', '修正（建立新版本，原值保留）', (ctx, { params, body }) => O.correctObservation(ctx, params.id, body));
route('POST', '/api/v1/ocr/bill', '電費單辨識（結果只是提案，須逐格確認後才寫入）', async (ctx, { req }) => {
  const { fields, file } = await multipart(req);
  if (!file) throw bad('沒有檔案');
  assertCan(ctx, 'obs.write', fields.orgId);
  const ev = await E.storeEvidence(ctx, { orgId: fields.orgId, filename: file.filename, data: file.data, kind: '電費單', confidentiality: 'restricted', assetId: fields.assetId || null });
  const cls = classify(file.contentType, file.filename);
  if (!cls) throw bad('不支援的檔案類型');
  const { extractFile } = await import('../extract.js');
  try {
    const r = await extractFile('bills', { id: ev.id, kind: cls.kind, displayName: file.filename, mime: file.contentType }, file.data);
    const MAP = { useTotal: ['elec_purchased_kwh', 'kWh'], feeTotal: ['elec_cost_twd', 'TWD'], maxDemand: ['elec_peak_demand_kw', 'kW'], contractCapacity: ['elec_contract_kw', 'kW'] };
    const proposals = r.rows.map((row) => ({ period: row.values.period, meterNo: row.values.meterNo,
      values: Object.entries(MAP).filter(([k]) => row.values[k] !== undefined).map(([k, [metric, unit]]) => ({ field: k, metric, unit, value: row.values[k], state: row.meta[k]?.state, page: row.meta[k]?.source?.page })) }));
    return { evidenceId: ev.id, proposals, notes: r.notes, confirmRequired: true };
  } catch (e) { return { evidenceId: ev.id, proposals: [], notes: e.message, disabled: e.code === 'extract_disabled', confirmRequired: true }; }
}, { multipart: true });

// ── 匯入 ──
route('POST', '/api/v1/import-jobs', '上傳匯入檔並預檢（multipart：file、orgId、kind=observations|assets|ghg_workbook、sourceId）', async (ctx, { req }) => {
  const { fields, file } = await multipart(req);
  if (!file) throw bad('沒有檔案');
  return I.uploadImport(ctx, { orgId: fields.orgId, filename: file.filename, data: file.data, kind: fields.kind || 'observations', sourceId: fields.sourceId || null });
}, { multipart: true });
route('GET', '/api/v1/import-jobs', '匯入紀錄', (ctx, { query }) => I.listImports(ctx, query.orgId));
route('GET', '/api/v1/import-jobs/:id', '匯入預覽與錯誤清單', (ctx, { params }) => I.getImport(ctx, params.id));
route('POST', '/api/v1/import-jobs/:id/remap', '修改欄位對應後重新預覽', (ctx, { params, body }) => I.remapImport(ctx, params.id, body.mapping));
route('POST', '/api/v1/import-jobs/:id/commit', '提交匯入', (ctx, { params, body }) => I.commitImport(ctx, params.id, body));
route('POST', '/api/v1/import-jobs/:id/revert', '整批撤銷', (ctx, { params, body }) => I.revertImport(ctx, params.id, body));
route('POST', '/api/v1/import-jobs/:id/sign-off', '移轉結果簽收', (ctx, { params }) => { I.signOffImport(ctx, params.id); return { ok: true }; });
route('GET', '/api/v1/import-templates/:kind', '下載匯入範本（observations.xlsx、assets.xlsx）', (ctx, { params, res }) => {
  const buf = params.kind.startsWith('assets') ? I.assetTemplate() : I.observationTemplate();
  res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(params.kind.startsWith('assets') ? '標的匯入範本.xlsx' : '觀測值匯入範本.xlsx')}` });
  res.end(buf); return RAW;
});
route('GET', '/api/v1/reference-activities', '歷史碳盤查表項目（含原始座標）', (ctx) => { if (!can(ctx, 'view.internal', null)) throw new Forbidden('view.internal'); return I.listReferenceActivities(ctx); });
route('POST', '/api/v1/reference-activities/:id/mapping', '人工指定參照項目對應的盤點項目', (ctx, { params, body }) => { I.setReferenceMapping(ctx, params.id, body.itemCodes || []); return { ok: true }; });

// ── 檢核與差異 ──
route('POST', '/api/v1/validations/runs', '執行檢核（orgId、assetId、year 或 from/to）', (ctx, { body }) => V.runValidation(ctx, body));
route('GET', '/api/v1/validations/runs', '檢核執行紀錄', (ctx, { query }) => V.listRuns(ctx, query.orgId));
route('GET', '/api/v1/validations/runs/:id', '檢核結果', (ctx, { params }) => V.getRun(ctx, params.id));
route('GET', '/api/v1/discrepancy-cases', '差異案件', (ctx, { query }) => C.listCases(ctx, { ...query, mine: query.mine === '1', all: query.all === '1' }));
route('POST', '/api/v1/discrepancy-cases', '人工提報差異', (ctx, { body }) => C.reportCase(ctx, body));
route('GET', '/api/v1/discrepancy-cases/:id', '差異案件詳細', (ctx, { params }) => C.getCase(ctx, params.id));
route('POST', '/api/v1/discrepancy-cases/:id/assign', '指派', (ctx, { params, body }) => { C.assignCase(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/discrepancy-cases/:id/progress', '調查中／要求補件', (ctx, { params, body }) => { C.caseProgress(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/discrepancy-cases/:id/note', '補充說明', (ctx, { params, body }) => { C.addCaseNote(ctx, params.id, body.note); return { ok: true }; });
route('POST', '/api/v1/discrepancy-cases/:id/close', '不需調整直接結案（須理由）', (ctx, { params, body }) => { C.closeCase(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/discrepancy-cases/:id/reopen', '重新開啟', (ctx, { params, body }) => { C.reopenCase(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/discrepancy-cases/:id/decisions', '對案件提出採用方案', (ctx, { params, body }) => D.proposeDecision(ctx, { ...body, caseId: params.id }));

// ── 裁決與資料集 ──
route('POST', '/api/v1/decisions', '提出採用值（需權限）', (ctx, { body }) => D.proposeDecision(ctx, body));
route('POST', '/api/v1/decisions/bulk', '批次帶出單一來源的採用值草案', (ctx, { body }) => D.proposeBulk(ctx, body));
route('GET', '/api/v1/decisions/pending', '待審核採用值', (ctx, { query }) => D.listPendingDecisions(ctx, query));
route('POST', '/api/v1/decisions/:id/review', '核准或退回（高影響需兩位）', (ctx, { params, body }) => D.reviewDecision(ctx, params.id, body));
route('POST', '/api/v1/decisions/:id/withdraw', '撤回自己提出的裁決', (ctx, { params }) => { D.withdrawDecision(ctx, params.id); return { ok: true }; });
route('GET', '/api/v1/datasets', '資料集', (ctx, { query }) => D.listDatasets(ctx, query.orgId));
route('POST', '/api/v1/datasets', '建立資料集', (ctx, { body }) => D.createDataset(ctx, body));
route('GET', '/api/v1/datasets/:id', '資料集內容（採用值、裁決）', (ctx, { params }) => D.getDataset(ctx, params.id));
route('GET', '/api/v1/datasets/:id/candidates', '某標的某指標的候選數值', (ctx, { params, query }) => D.candidates(ctx, params.id, query.assetId, query.metric));
route('POST', '/api/v1/datasets/:id/submit', '資料集送審', (ctx, { params }) => { D.submitDataset(ctx, params.id); return { ok: true }; });
route('POST', '/api/v1/datasets/:id/approve', '審核資料集', (ctx, { params, body }) => { D.approveDataset(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/datasets/:id/lock', '資料定版', (ctx, { params }) => D.lockDataset(ctx, params.id));
route('POST', '/api/v1/datasets/:id/new-version', '定版後開新版本', (ctx, { params, body }) => D.newDatasetVersion(ctx, params.id, body));
route('GET', '/api/v1/datasets/:id/verify', '驗證定版雜湊', (ctx, { params }) => { const d = q.get('SELECT org_id FROM datasets WHERE id = ?', params.id); if (!d) throw notFound('資料集'); assertCan(ctx, 'view.internal', d.org_id); return D.verifyDataset(params.id); });
route('GET', '/api/v1/datasets/:id/indicators', '試算指標（codes 以逗號分隔；預設全部）', (ctx, { params, query }) => {
  const d = q.get('SELECT org_id FROM datasets WHERE id = ?', params.id); if (!d) throw notFound('資料集'); assertCan(ctx, 'view.internal', d.org_id);
  const r = computeAll(params.id, query.codes ? query.codes.split(',') : ALL_RULE_CODES());
  if (!can(ctx, 'view.sensitive', d.org_id)) for (const [k, v] of Object.entries(r.results)) if (/cost/.test(k)) r.results[k] = { ...v, value: null, masked: true, trace: {} };
  return r;
});

// ── 版本化設定（係數、規則、模板、設定）──
const KIND_TABLE = { factors: 'factor', rules: 'rule', templates: 'template', 'configuration-versions': 'config' };
route('GET', '/api/v1/admin/factors', '係數庫（全部版本）', (ctx) => { assertCan(ctx, 'view.internal', null); return q.all('SELECT * FROM factors ORDER BY category, code, version DESC'); });
route('GET', '/api/v1/admin/rules', '計算規則（全部版本）', (ctx) => { assertCan(ctx, 'view.internal', null); return q.all('SELECT * FROM calculation_rules ORDER BY code, version DESC').map((r) => parseJson(r, ['definition'])); });
route('GET', '/api/v1/admin/templates', '報告模板（全部版本）', (ctx) => { if (!can(ctx, 'view.internal', null)) throw new Forbidden('view.internal'); return R.listTemplates(); });
route('GET', '/api/v1/admin/templates/:id', '模板欄位映射', (ctx, { params }) => { if (!can(ctx, 'view.internal', null)) throw new Forbidden('view.internal'); return R.templateDetail(params.id); });
route('POST', '/api/v1/admin/templates/:id/mappings', '新增／修改模板欄位（草稿）', (ctx, { params, body }) => { R.saveMapping(ctx, params.id, body); return { ok: true }; });
route('DELETE', '/api/v1/admin/templates/:id/mappings/:fieldId', '刪除模板欄位（草稿）', (ctx, { params }) => { R.deleteMapping(ctx, params.id, decodeURIComponent(params.fieldId)); return { ok: true }; });
route('GET', '/api/v1/admin/configuration-versions', '系統設定（全部版本）', (ctx) => { assertCan(ctx, 'view.internal', null); return q.all('SELECT * FROM configuration_versions ORDER BY key, version DESC').map((r) => parseJson(r, ['value', 'impact'])); });
route('POST', '/api/v1/admin/:kind/draft', '建立草稿（key、patch、reason）', (ctx, { params, body }) => { assertCan(ctx, 'config.write', null); return CFG.createDraft(ctx, kindOf(params.kind), body.key, body.patch || {}, body.reason); });
route('PATCH', '/api/v1/admin/:kind/:id', '修改草稿', (ctx, { params, body }) => { assertCan(ctx, 'config.write', null); CFG.editDraft(ctx, kindOf(params.kind), params.id, body); return { ok: true }; });
route('POST', '/api/v1/admin/:kind/:id/submit', '送審', (ctx, { params }) => { assertCan(ctx, 'config.write', null); CFG.submit(ctx, kindOf(params.kind), params.id); return { ok: true }; });
route('POST', '/api/v1/admin/:kind/:id/publish', '核准發布（須另一人）', (ctx, { params, body }) => { assertCan(ctx, 'config.approve', null); return CFG.publish(ctx, kindOf(params.kind), params.id, body); });
route('POST', '/api/v1/admin/:kind/:id/reject', '退回草稿', (ctx, { params, body }) => { assertCan(ctx, 'config.approve', null); CFG.reject(ctx, kindOf(params.kind), params.id, body.note); return { ok: true }; });
route('POST', '/api/v1/admin/:kind/:id/rollback', '以此版本內容建立新草稿（回復）', (ctx, { params, body }) => { assertCan(ctx, 'config.write', null); return CFG.rollbackTo(ctx, kindOf(params.kind), params.id, body.reason); });
route('POST', '/api/v1/admin/:kind/:id/retire', '停用此版本', (ctx, { params, body }) => { assertCan(ctx, 'config.approve', null); CFG.retire(ctx, kindOf(params.kind), params.id, body.reason); return { ok: true }; });
route('GET', '/api/v1/admin/:kind/:id/impact', '影響預覽', (ctx, { params }) => {
  const kind = kindOf(params.kind); const table = { factor: 'factors', rule: 'calculation_rules', template: 'report_templates', config: 'configuration_versions' }[kind];
  const r = q.get(`SELECT * FROM ${table} WHERE id = ?`, params.id); if (!r) throw notFound('版本'); return CFG.impactOf(kind, r);
});
function kindOf(k) { const v = KIND_TABLE[k]; if (!v) throw notFound('設定類型'); return v; }

// ── 報告 ──
route('GET', '/api/v1/report-templates', '可用的報告模板（依發布日期選版次）', (ctx, { query }) => R.listTemplates().filter((t) => t.status === 'published' && (!query.publishDate || ((!t.applies_from || t.applies_from <= query.publishDate) && (!t.applies_to || t.applies_to >= query.publishDate)))));
route('GET', '/api/v1/report-templates/:id', '報告模板的各表與欄位（院所頁右欄用）', (ctx, { params }) => { if (!orgsFor(ctx, 'view.internal').length) throw new Forbidden('view.internal'); return R.templateDetail(params.id); });
route('GET', '/api/v1/report-cases', '報告案件', (ctx, { query }) => R.listCases(ctx, query.orgId));
route('POST', '/api/v1/report-cases', '建立報告案件', (ctx, { body }) => R.createCase(ctx, body));
route('GET', '/api/v1/report-cases/:id', '報告案件詳細', (ctx, { params }) => R.getCase(ctx, params.id));
route('PATCH', '/api/v1/report-cases/:id', '修改報告案件（資料集、審核人、文字段落）', (ctx, { params, body }) => { R.updateCase(ctx, params.id, body); return { ok: true }; });
route('GET', '/api/v1/report-cases/:id/readiness', '報告就緒度與缺漏', (ctx, { params }) => R.readiness(ctx, params.id));
route('GET', '/api/v1/report-cases/:id/runs', '報告版本清單', (ctx, { params }) => R.listRuns(ctx, params.id));
route('POST', '/api/v1/report-cases/:id/runs', '產製報告（凍結結果與版本）', (ctx, { params }) => R.generateRun(ctx, params.id));
route('POST', '/api/v1/report-cases/:id/manual-submission', '記錄已依官方格式人工送件（不代表自動申報）', (ctx, { params, body }) => { R.markManualSubmission(ctx, params.id, body); return { ok: true }; });
route('GET', '/api/v1/report-runs/:id', '報告版本內容', (ctx, { params }) => R.getRun(ctx, params.id));
route('POST', '/api/v1/report-runs/:id/submit', '送審', (ctx, { params }) => { R.submitRun(ctx, params.id); return { ok: true }; });
route('POST', '/api/v1/report-runs/:id/review', '審查通過或退回', (ctx, { params, body }) => { R.reviewRun(ctx, params.id, body); return { ok: true }; });
route('POST', '/api/v1/report-runs/:id/approve', '核准並封存', (ctx, { params, body }) => R.approveRun(ctx, params.id, body));
route('GET', '/api/v1/report-runs/:id/reproduce', '以封存版本重算並比對', (ctx, { params }) => R.reproduce(ctx, params.id));
route('GET', '/api/v1/report-runs/:id/export', '匯出 xlsx／csv／docx／pdf／html', async (ctx, { params, query, res }) => {
  const out = await X.exportRun(ctx, params.id, query.format || 'xlsx');
  res.writeHead(200, { 'Content-Type': out.mime, 'Content-Length': out.data.length, 'Content-Disposition': `${query.format === 'html' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(out.filename)}`, 'Cache-Control': 'private, no-store' });
  res.end(out.data); return RAW;
});

// ── ISO 14064-1：顯著性評估、基準年 ──
route('GET', '/api/v1/ghg/significance', '間接排放顯著性評估（orgId、year）', (ctx, { query }) => G.listSignificance(ctx, query.orgId, Number(query.year)));
route('PATCH', '/api/v1/ghg/significance/:id', '更新顯著性評估與量化結果', (ctx, { params, body }) => { G.saveSignificance(ctx, params.id, body); return { ok: true }; });
route('GET', '/api/v1/ghg/significance/estimate', '顯著性自動估算（建議值）', (ctx, { query }) => G.estimateSignificance(ctx, query.orgId, Number(query.year)));
route('POST', '/api/v1/ghg/significance/rest-insignificant', '尚未評估的項目一鍵判定不顯著', (ctx, { body }) => G.markRestInsignificant(ctx, body.orgId, Number(body.year), body.reason));
route('GET', '/api/v1/ghg/base-years/suggest', '建議基準年', (ctx, { query }) => { assertCan(ctx, 'view.internal', query.orgId); return G.suggestBaseYear(query.orgId); });
route('GET', '/api/v1/org-profile', '院所基本資料', (ctx, { query }) => P.readProfile(ctx, query.orgId));
route('PUT', '/api/v1/org-profile', '儲存院所基本資料', (ctx, { body }) => { P.saveProfile(ctx, body.orgId, body.data); return { ok: true }; });
route('GET', '/api/v1/ghg/base-years', '基準年與重新計算紀錄', (ctx, { query }) => G.listBaseYears(ctx, query.orgId));
route('GET', '/api/v1/energy-measures', '節約能源措施（orgId、year、kind=done|plan）', (ctx, { query }) => EM.readMeasures(ctx, query));
route('POST', '/api/v1/energy-measures', '新增或修改節約能源措施', (ctx, { body }) => EM.saveMeasure(ctx, body));
route('DELETE', '/api/v1/energy-measures/:id', '刪除節約能源措施（需原因）', (ctx, { params, body, query }) => { EM.cancelMeasure(ctx, params.id, body?.reason || query.reason); return { ok: true }; });
route('GET', '/api/v1/energy-saving-rate', '歷年節電量、用電量與平均年節電率（orgId、assetId、year）', (ctx, { query }) => EM.readSavingRate(ctx, query));
route('PUT', '/api/v1/energy-saving-years', '填寫某年度節電量、用電量或扣除用電量', (ctx, { body }) => { EM.saveSavingYear(ctx, body); return { ok: true }; });
route('POST', '/api/v1/ghg/base-years', '設定基準年或重新計算（kind=set|recalculated）', (ctx, { body }) => G.setBaseYear(ctx, body));
route('GET', '/api/v1/ghg/preview', '盤查報告自動段落預覽（orgId、year、datasetId）', (ctx, { query }) => {
  assertCan(ctx, 'view.internal', query.orgId);
  const keys = ['org_boundary', 'report_boundary', 'indirect_table', 'exclusions', 'base_year', 'source_inventory', 'data_quality', 'uncertainty_table'];
  const calc = query.datasetId ? computeAll(query.datasetId, ['ghg.total_all', 'ghg.uncertainty_pct']) : { results: {}, factorVersions: {}, ruleVersions: {} };
  return G.buildBlocks(keys, { caseRow: { org_id: query.orgId, year: Number(query.year), boundary_id: query.boundaryId || null }, datasetId: query.datasetId || null, ...calc });
});

// ── 成果回饋、看板 ──
route('GET', '/api/v1/usage-links', '成果實際引用（assetId 或 mine=1）', (ctx, { query }) => R.feedbackFor(ctx, { assetId: query.assetId, mine: query.mine === '1', orgId: query.orgId }));
route('GET', '/api/v1/dashboards/progress', '分級看板（level=public|management|report|energy）', (ctx, { query }) => {
  const lv = query.level || 'public';
  const args = { orgId: query.orgId || null, year: query.year };
  if (lv === 'management') return B.managementBoard(ctx, args);
  if (lv === 'report') return B.reportBoard(ctx, args);
  if (lv === 'energy') return B.energyBoard(ctx, args);
  return B.publicBoard(ctx, args);
});
route('GET', '/api/v1/workbench', '我的工作台數字', (ctx, { query }) => B.workbenchCounts(ctx, query.orgId));

// ── 協作 ──
route('GET', '/api/v1/tasks', '待辦（mine=1 含代理）', (ctx, { query }) => K.listTasks(ctx, { ...query, mine: query.mine === '1' }));
route('POST', '/api/v1/tasks', '新增待辦／派工', (ctx, { body }) => K.createTask(ctx, body));
route('POST', '/api/v1/tasks/batch', '批次派工', (ctx, { body }) => ({ ids: (body.items || []).map((it) => K.createTask(ctx, it).id) }));
route('PATCH', '/api/v1/tasks/:id', '更新待辦（完成、改派、改期）', (ctx, { params, body }) => { K.updateTask(ctx, params.id, body); return { ok: true }; });
route('GET', '/api/v1/comments', '留言', (ctx, { query }) => K.listComments(ctx, query.orgId, query.targetType, query.targetId));
route('POST', '/api/v1/comments', '留言', (ctx, { body }) => K.addComment(ctx, body));
route('GET', '/api/v1/notifications', '我的通知', (ctx, { query }) => K.myNotifications(ctx, { unread: query.unread === '1' }));
route('POST', '/api/v1/notifications/read', '標為已讀', (ctx, { body }) => { K.markRead(ctx, body.ids || 'all'); return { ok: true }; });

// ── 介接 ──
route('GET', '/api/v1/integrations', '介接設定與健康狀態', (ctx, { query }) => N.listIntegrations(ctx, query.orgId));
route('POST', '/api/v1/integrations', '新增／修改介接', (ctx, { body }) => N.saveIntegration(ctx, body));
route('POST', '/api/v1/integrations/:id/run', '立即同步', async (ctx, { params }) => N.runIntegration(params.id, { manualCtx: ctx }));
route('POST', '/api/v1/integrations/:id/token', '換發推送權杖（只顯示一次）', (ctx, { params }) => N.rotatePushToken(ctx, params.id));

// ── 稽核、備份 ──
route('GET', '/api/v1/audit-events', '稽核日誌查詢', (ctx, { query }) => {
  const orgIds = query.orgId ? [query.orgId] : orgsFor(ctx, 'audit.read');
  const global = ctx.grants.some((g) => ['sysadmin', 'auditor'].includes(g.role) && g.scope_type === 'global');
  if (!global && !orgIds.length) throw new Forbidden('audit.read');
  if (query.orgId) assertCan(ctx, 'audit.read', query.orgId);
  const where = []; const p = [];
  if (!global || query.orgId) { where.push(`(org_id IN (${orgIds.map(() => '?').join(',')})${global ? '' : ''})`); p.push(...orgIds); }
  for (const [k, col] of [['targetType', 'target_type'], ['targetId', 'target_id'], ['actor', 'actor'], ['action', 'action']]) if (query[k]) { where.push(`${col} = ?`); p.push(query[k]); }
  if (query.from) { where.push('at >= ?'); p.push(query.from); }
  if (query.to) { where.push('at < ?'); p.push(query.to); }
  return q.all(`SELECT seq, at, actor, actor_name, org_id, action, target_type, target_id, ip, ${query.detail === '1' ? 'before, after,' : ''} hash FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ${Math.min(Number(query.limit) || 200, 2000)}`, ...p);
});
route('GET', '/api/v1/audit-events/verify', '驗證稽核雜湊鏈', (ctx) => { if (!can(ctx, 'audit.read', null)) throw new Forbidden('audit.read'); return verifyAuditChain(); });
route('GET', '/api/v1/admin/backups', '備份清單', (ctx) => { assertCan(ctx, 'backup.run', null); return BK.listBackups(); });
route('POST', '/api/v1/admin/backups', '立即備份並驗證', (ctx) => { assertCan(ctx, 'backup.run', null); return BK.backupNow(ctx.userId); });
route('POST', '/api/v1/admin/backups/:name/drill', '還原演練（唯讀比對）', (ctx, { params }) => { assertCan(ctx, 'backup.run', null); return BK.restoreDrill(params.name, ctx.userId); });
route('GET', '/api/v1/admin/evidence-verify', '驗證全部佐證檔雜湊', async (ctx) => { assertCan(ctx, 'backup.run', null); return E.verifyAllEvidence(); });

route('GET', '/api/v1/openapi.json', 'API 文件（OpenAPI 3）', (ctx, { res }) => { const b = JSON.stringify(openapi(), null, 2); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(b); return RAW; }, { public: true });

// 不需登入：外部系統推送（Bearer 權杖）
route('POST', '/api/v1/integrations/:id/push', '外部系統推送觀測（Authorization: Bearer 權杖；PRD §16.3 格式）', (ctx, { params, body, req }) =>
  N.pushObservations(params.id, String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), body.observations), { public: true, noOrigin: true });

export const RAW = Symbol('raw');

function openapi() {
  const paths = {};
  for (const r of R_) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    paths[p] = paths[p] || {};
    paths[p][r.method.toLowerCase()] = { summary: r.summary, parameters: r.keys.map((k) => ({ name: k, in: 'path', required: true, schema: { type: 'string' } })),
      ...(r.multipart ? { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } } } : ['POST', 'PATCH'].includes(r.method) ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { 200: { description: 'OK' }, 401: { description: '未登入' }, 403: { description: '沒有權限' }, 409: { description: '狀態衝突' }, 422: { description: '資料驗證失敗' } },
      security: r.public ? [] : [{ cookie: [] }] };
  }
  return { openapi: '3.0.3', info: { title: '油水電氣資料治理平台 API', version: '1.0.0', description: '所有寫入需登入且依角色、院所授權；已核准資料不提供直接覆寫。' },
    servers: [{ url: '/' }], components: { securitySchemes: { cookie: { type: 'apiKey', in: 'cookie', name: 'ems_admin_session' }, bearer: { type: 'http', scheme: 'bearer' } } }, paths };
}

// ── 分派 ──
export async function handlePlatform({ req, res, sess, pathname, json, readBody, originOk }) {
  if (!pathname.startsWith('/api/v1/')) return false;
  const url = new URL(req.url, 'http://x');
  const query = Object.fromEntries(url.searchParams);
  const r = R_.find((x) => x.method === req.method && x.re.test(pathname));
  if (!r) return json(res, 404, { ok: false, error: 'not_found' });
  const m = r.re.exec(pathname); const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  if (req.method !== 'GET' && !r.noOrigin && !originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
  let ctx = null;
  if (!r.public) {
    ctx = contextFor(sess);
    if (!ctx) return json(res, 401, { ok: false, error: 'unauthorized' });
    // 第一次登入或被重設密碼：只准改密碼與查自己
    const mc = q.get('SELECT must_change FROM users WHERE id = ?', ctx.userId)?.must_change;
    if (mc && !['/api/v1/me', '/api/v1/me/password', '/api/v1/meta'].includes(pathname)) return json(res, 403, { ok: false, error: 'must_change_password', message: '請先變更密碼' });
  }
  try {
    const body = r.multipart || req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req, 8 * 1024 * 1024);
    const out = await r.handler(ctx, { params, query, body, req, res });
    if (out === RAW) return true;
    return json(res, 200, { ok: true, data: out ?? null });
  } catch (e) {
    const status = e.status || (e instanceof Forbidden ? 403 : /SQLITE_CONSTRAINT|不可修改|不可新增|不可刪除|不可覆寫/.test(e.message) ? 409 : 500);
    if (status === 500) console.error('[platform]', req.method, pathname, e);
    return json(res, status, { ok: false, error: status === 403 ? 'forbidden' : e.code || 'error', message: status === 403 && e.action ? `你沒有「${ACTION_LABELS[e.action] || e.action}」權限` : e.message,
      ...(e.problems ? { problems: e.problems } : {}), ...(e.errors ? { errors: e.errors } : {}), ...(e.impact ? { impact: e.impact } : {}), ...(e.fields ? { fields: e.fields } : {}) });
  }
}

export const routeTable = () => R_.map((r) => ({ method: r.method, path: r.path, summary: r.summary }));
export { j as _j, HttpError as _HttpError };
