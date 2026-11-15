// 院所基本資料：盤查報告每年都要寫的組織描述、負責人、查證狀態等，填一次之後自動帶入
import { q, insert, update, nowIso, audit } from './db.js';
import { assertCan } from './authz.js';
import { j } from './util.js';

// 報告欄位代碼 → 基本資料鍵；沒有填時的預設文字
export const PROFILE_FIELDS = {
  org_note: { key: 'description', label: '組織描述（業務、規模、場址）' },
  responsible: { key: 'responsible', label: '報告負責人（姓名、職稱、聯絡方式）' },
  intended_use: { key: 'intendedUse', label: '報告目的與預期使用者', default: '依環境部溫室氣體盤查登錄規定揭露，並作為院內減碳目標管理依據' },
  removals: { key: 'removals', label: '溫室氣體移除量說明', default: '未量化：院區無植林等碳匯，移除量不適用' },
  verified: { key: 'verified', label: '是否經第三方查證', default: '未經第三方查證' },
  verifier: { key: 'verifier', label: '查證機構' },
  assurance: { key: 'assurance', label: '查證類型與保證等級' },
  boundary_note: { key: 'boundaryNote', label: '邊界補充說明' },
  base_year_note: { key: 'baseYearNote', label: '基準年選定理由補充' },
  methods_note: { key: 'methodsNote', label: '量化方法補充說明' },
  uncertainty_note: { key: 'uncertaintyNote', label: '不確定性影響說明', default: '主要排放源（外購電力、燃料）活動數據來自帳單，不確定性低；冷媒逸散與化糞池採推估方法，不確定性較高' },
};

export function getProfile(orgId) {
  return j(q.get('SELECT data FROM org_profiles WHERE org_id = ?', orgId)?.data, {});
}
export function readProfile(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return { data: getProfile(orgId), fields: PROFILE_FIELDS };
}
export function saveProfile(ctx, orgId, data) {
  assertCan(ctx, 'report.write', orgId);
  const allowed = new Set(Object.values(PROFILE_FIELDS).map((f) => f.key));
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([k, v]) => allowed.has(k) && typeof v === 'string').map(([k, v]) => [k, v.trim()]));
  const before = getProfile(orgId);
  if (q.get('SELECT 1 FROM org_profiles WHERE org_id = ?', orgId)) update('org_profiles', orgId, { data: clean, updated_by: ctx.userId, updated_at: nowIso() }, 'org_id');
  else insert('org_profiles', { org_id: orgId, data: clean, updated_by: ctx.userId, updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'org.profile', targetType: 'organization', targetId: orgId, before, after: clean });
}
// 報告手動欄位的值：案件填的 > 院所基本資料 > 預設文字
export function manualValue(fieldId, caseManual, profile) {
  if (caseManual[fieldId]) return { value: caseManual[fieldId], from: 'case' };
  const f = PROFILE_FIELDS[fieldId];
  if (f && profile[f.key]) return { value: profile[f.key], from: 'profile' };
  if (f?.default) return { value: f.default, from: 'default' };
  return { value: null, from: null };
}
