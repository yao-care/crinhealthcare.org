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
// 對外申報共用的機關基本資料（能源查核申報表三、環境部表1／表2、國健署填報）：欄位代碼＝鍵
const P = (key, label, o = {}) => [key, { key, label, group: 'basic', short: true, ...o }];
Object.assign(PROFILE_FIELDS, Object.fromEntries([
  P('taxId', '統一編號'), P('hqName', '總公司（法人、機關全銜）名稱', { hint: '分院以本身名義為法律行為時填分院名稱' }), P('representative', '代表人（姓名、職稱）'),
  P('managerName', '能源用戶負責人（姓名、職稱）'), P('address', '能源使用地址（含縣市、鄉鎮市區、郵遞區號）'), P('county', '縣市'), P('district', '鄉鎮市區'), P('zip', '郵遞區號'),
  P('contactPerson', '聯絡人（姓名、電話、電子信箱、傳真）'), P('industryCode', '行業別（主計總處代碼與名稱）', { default: '8610 醫院' }), P('userCategory', '用戶分類（能源查核）', { default: '醫院' }),
  P('energyManager', '能源管理人員（姓名、設置登記核准編號、登記日期、聯絡方式）', { group: 'energy' }), P('annualWorkHours', '全年工作時數（小時）', { group: 'energy', default: '8760' }),
  P('totalExpense', '總支出費用（萬元／年，算能源費用占比用）', { group: 'energy' }), P('iso50001', 'ISO／CNS 50001 驗證（驗證機構、證書有效期限；未通過填「否」）', { group: 'energy', default: '否' }),
  P('emis', '能源管理資訊系統（已監測的系統：電力、空調、照明…；沒有填「否」）', { group: 'energy' }),
  P('energyOrg', '能源查核管理組織（管理／推行／執行三階層：姓名、職稱、年度工作內容）', { group: 'energy', short: false }),
  P('energyPolicy', '能源管理政策推動情形（對外政策聲明、定期檢討、優先採購高效率設備、回應節能建議）', { group: 'energy', short: false }),
  P('moenvControlNo', '環境部管制編號（8 碼）', { group: 'moenv' }), P('moenvSiteNo', '分據點編號', { group: 'moenv', default: 'D00001' }),
  P('registration', '依法盤查登錄／自願性登錄', { group: 'moenv', default: '依法盤查登錄' }), P('registrationIndustry', '依法盤查登錄之行業別與納管條件代碼', { group: 'moenv' }),
  P('authority', '目的事業主管機關（代碼與名稱，見環境部代碼檔附表三）', { group: 'moenv' }), P('medicalCode', '醫事機構代碼', { group: 'moenv' }),
  P('govAgencyCode', '機關代碼（節能填報網站）', { group: 'gov' }), P('govHead', '機關首長（姓名、職稱、電話、電子信箱）', { group: 'gov' }),
  P('govReporter', '填報人員（姓名、職稱、電話、手機、電子信箱）', { group: 'gov' }), P('govSupervisor', '督導人員（姓名、部門、職稱、電話、電子信箱）', { group: 'gov' }),
  P('govParentAgency', '上級機關／主管機關（機關代碼）', { group: 'gov' }), P('govStaffRegular', '編制人員數', { group: 'gov' }), P('govStaffNonRegular', '非編制人員數（常駐）', { group: 'gov' }),
  P('govVisitors', '洽公或參訪人次（當年概估）', { group: 'gov' }), P('govWorkDays', '工作天數', { group: 'gov', default: '365' }), P('govWorkHours', '工作時間（例：24 小時）', { group: 'gov', default: '24 小時' }),
  P('govSurvey', '問卷與節約能源推動小組（強化節電管理、資訊機房、空調、照明、EMS、公用設備、落實節電措施等題目的回答）', { group: 'gov', short: false }),
  P('govGrowthReason', '用電／用油正（負）成長原因說明', { group: 'gov', short: false }),
  P('excludedEntities', '邊界內未納入計算之排放源（環境部表2-3；每行：名稱｜地址｜原因）', { group: 'moenv', short: false }),
]));
export const PROFILE_GROUPS = { ghg: '盤查報告說明', basic: '機關基本資料（各申報共用）', energy: '能源查核申報', moenv: '環境部盤查登錄', gov: '政府機關及學校節約能源填報網站' };

export function getProfile(orgId) {
  return j(q.get('SELECT data FROM org_profiles WHERE org_id = ?', orgId)?.data, {});
}
export function readProfile(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return { data: getProfile(orgId), fields: PROFILE_FIELDS, groups: PROFILE_GROUPS };
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
