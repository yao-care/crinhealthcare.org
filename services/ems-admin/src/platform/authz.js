// 權限：一人一帳號，權限＝角色 × 組織範圍 × 動作（PRD §3、§17）。
// 判斷一律走 can()；路由裡不准自己比對角色名稱。
import { q } from './db.js';

// PRD §3 九種角色＋院所管理者（替院內同仁開帳號）
export const ROLES = {
  collector: { name: '盤點承辦', desc: '建檔、找來源、取證、更新、回覆異常' },
  custodian: { name: '資料保管者／設備管理員', desc: '提供帳單、紀錄、設備資訊，確認真實來源' },
  reporter: { name: '報告承辦', desc: '建立報告需求、查證、比對、提出採用值、草擬報告' },
  reviewer: { name: '資料審核者', desc: '核對差異及裁決理由，批准或退回；資料集定版' },
  approver: { name: '報告核准者', desc: '核准對外報告、報告封存' },
  manager: { name: '管理者', desc: '追蹤院區、部門與年度進度，資源協調' },
  staff: { name: '一般同仁', desc: '瀏覽授權的進度與成果' },
  sysadmin: { name: '系統管理員', desc: '管理設定、規則、服務帳號、權限' },
  auditor: { name: '稽核／查驗人員', desc: '依授權查閱證據鏈、報告快照與歷程（唯讀）' },
  org_admin: { name: '院所管理者', desc: '管理本院帳號、角色與介接設定' },
};

// 角色 → 動作。注意「不應自動擁有」（PRD §3 右欄）：
//   盤點承辦不能核准採用值；報告承辦不能改原始證據；審核者不能刪稽核；
//   核准者不能改已封存版本（由 DB trigger 擋）；管理者不能經公開看板拿原始文件；
//   系統管理員不能代替業務判定資料正確性（沒有 decision.* / dataset.approve）；稽核只能讀。
const MATRIX = {
  collector: ['view.internal', 'view.evidence', 'asset.write', 'asset.applicability', 'source.write', 'search.write',
    'obs.write', 'import.write', 'obs.confirm_ocr', 'case.write', 'task.write'],
  custodian: ['view.internal', 'view.evidence', 'source.write', 'obs.write', 'import.write', 'case.write', 'task.write'],
  reporter: ['view.internal', 'view.sensitive', 'view.evidence', 'search.write', 'obs.confirm_ocr', 'case.write', 'case.assign',
    'decision.propose', 'dataset.write', 'report.write', 'export.download', 'validation.run', 'task.write'],
  reviewer: ['view.internal', 'view.sensitive', 'view.evidence', 'case.write', 'case.assign', 'decision.review',
    'dataset.approve', 'dataset.lock', 'report.review', 'asset.applicability.approve', 'validation.run', 'task.write'],
  approver: ['view.internal', 'view.sensitive', 'view.evidence', 'report.approve', 'export.download', 'task.write'],
  manager: ['view.internal', 'view.sensitive', 'view.management', 'dashboard.manage', 'export.download', 'case.assign', 'task.write'],
  staff: [],
  sysadmin: ['view.internal', 'config.write', 'config.approve', 'user.manage', 'integration.write', 'audit.read', 'org.write', 'backup.run'],
  auditor: ['view.internal', 'view.sensitive', 'view.evidence', 'view.management', 'audit.read', 'export.download'],
  org_admin: ['view.internal', 'user.manage', 'integration.write', 'org.write'],
};
// 任何登入者都有公開看板
const BASE = ['view.public'];

export const ACTIONS = [...new Set([...BASE, ...Object.values(MATRIX).flat()])];

// 動作中文（畫面上顯示「你沒有 XX 權限」用）
export const ACTION_LABELS = {
  'view.public': '瀏覽公開進度', 'view.internal': '瀏覽盤點資料', 'view.sensitive': '檢視敏感欄位（電號、費用、聯絡資訊）',
  'view.evidence': '下載原始佐證', 'view.management': '管理看板', 'asset.write': '建立與維護標的', 'asset.applicability': '判定適用性',
  'asset.applicability.approve': '核准不適用判定', 'source.write': '維護資料來源', 'search.write': '建立來源追查',
  'obs.write': '登錄觀測值', 'import.write': '檔案匯入', 'obs.confirm_ocr': '確認辨識結果', 'case.write': '處理差異案件',
  'case.assign': '指派差異案件', 'decision.propose': '提出採用值', 'decision.review': '審核採用值', 'dataset.write': '建立資料集',
  'dataset.approve': '核准資料集', 'dataset.lock': '資料集定版', 'report.write': '建立與產製報告', 'report.review': '審查報告',
  'report.approve': '核准與封存報告', 'export.download': '下載匯出檔', 'dashboard.manage': '看板設定', 'config.write': '修改系統設定',
  'config.approve': '核准系統設定', 'user.manage': '帳號與權限管理', 'integration.write': '介接設定', 'audit.read': '查詢稽核日誌',
  'org.write': '組織院區維護', 'backup.run': '備份還原', 'validation.run': '執行檢核', 'task.write': '待辦與留言',
};

// ── 組織樹 ──
let orgCache = null;
export function invalidateOrgs() { orgCache = null; }
function orgs() {
  if (!orgCache) {
    const rows = q.all('SELECT id, parent_id, kind, code, name, legacy_hid FROM organizations');
    const byId = new Map(rows.map((r) => [r.id, r]));
    orgCache = { rows, byId };
  }
  return orgCache;
}
export function orgById(id) { return orgs().byId.get(id) || null; }
export function orgByHid(hid) { return orgs().rows.find((o) => o.legacy_hid === hid) || null; }
// 自己＋所有子孫
export function descendants(orgId) {
  const out = new Set([orgId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of orgs().rows) if (o.parent_id && out.has(o.parent_id) && !out.has(o.id)) { out.add(o.id); grew = true; }
  }
  return out;
}
export function allOrgIds() { return orgs().rows.map((o) => o.id); }

// ── 使用者情境 ──
const today = () => new Date().toISOString().slice(0, 10);

export function loadGrants(userId) {
  const d = today();
  return q.all(`SELECT role, scope_type, scope_id FROM grants
                WHERE user_id = ? AND revoked_at IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)`, userId, d, d);
}

export function contextFor(sess) {
  if (!sess?.uid) return null;
  const u = q.get('SELECT id, username, display_name, status FROM users WHERE id = ?', sess.uid);
  if (!u || u.status !== 'active') return null;
  const grants = loadGrants(u.id);
  return { userId: u.id, username: u.username, name: u.display_name, grants, legacyHid: sess.hid || null };
}

function grantCovers(g, orgId) {
  if (g.scope_type === 'global') return true;
  if (!orgId) return false;
  return descendants(g.scope_id).has(orgId);
}

export function can(ctx, action, orgId = null) {
  if (!ctx) return false;
  if (BASE.includes(action)) return orgId ? ctx.grants.some((g) => grantCovers(g, orgId)) : ctx.grants.length > 0;
  return ctx.grants.some((g) => (MATRIX[g.role] || []).includes(action) && (orgId ? grantCovers(g, orgId) : true));
}

// 某動作在哪些組織可做（清單頁用來限縮查詢範圍）
export function orgsFor(ctx, action) {
  if (!ctx) return [];
  const out = new Set();
  for (const g of ctx.grants) {
    if (!BASE.includes(action) && !(MATRIX[g.role] || []).includes(action)) continue;
    if (g.scope_type === 'global') return allOrgIds();
    for (const id of descendants(g.scope_id)) out.add(id);
  }
  return [...out];
}

export function rolesIn(ctx, orgId) {
  return [...new Set(ctx.grants.filter((g) => grantCovers(g, orgId)).map((g) => g.role))];
}

export function actionsFor(ctx, orgId) {
  const acts = new Set(BASE);
  for (const g of ctx.grants) if (grantCovers(g, orgId)) for (const a of MATRIX[g.role] || []) acts.add(a);
  return [...acts];
}

export class Forbidden extends Error {
  constructor(action) { super('forbidden'); this.action = action; this.status = 403; }
}
export function assertCan(ctx, action, orgId) {
  if (!can(ctx, action, orgId)) throw new Forbidden(action);
}
