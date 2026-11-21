// 院所基本資料：盤查報告每年都要寫的組織描述、負責人、查證狀態等，填一次之後自動帶入
import { q, insert, update, nowIso, audit } from './db.js';
import { assertCan } from './authz.js';
import { j, bad } from './util.js';

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
  P('factoryRegNo', '工廠登記證編號（醫院無則留空）', { group: 'moenv' }), P('employees', '員工人數', { group: 'basic' }), P('orgEmail', '公私場所電子信箱（忘記密碼寄發信箱）', { group: 'moenv' }),
  P('contactMobile', '聯絡人手機', { group: 'basic' }), P('inventoryStandard', '盤查依據規範', { group: 'moenv', default: 'ISO / CNS 14064-1' }),
  P('significancePct', '顯著性門檻', { group: 'moenv', default: '3.0%' }), P('materialityPct', '實質性門檻', { group: 'moenv', default: '5.0%' }), P('exclusionPct', '排除門檻', { group: 'moenv', default: '0.5%' }),
  P('consolidation', '組織邊界設定方法（營運控制法／財務控制法／股權比例法）', { group: 'moenv', default: '營運控制法' }),
  P('offsiteAreas', '場址外涵蓋區域（例：院外宿舍、餐廳；盤查表單表二）', { group: 'moenv', short: false }), P('excludedAreas', '場址內扣除區域（盤查表單表二）', { group: 'moenv', short: false }),
  P('excludedEntities', '邊界內未納入計算之排放源（環境部表2-3；每行：名稱｜地址｜原因）', { group: 'moenv', short: false }),
]));
// 水足跡範疇與基線（ISO 14046 5.2／ISO 46001 6.2；原「初始建檔 › 水足跡盤查」併到這裡）。水源、用水單元、排放口改為水的盤點標的
const WF = (key, label, o = {}) => [key, { key, label, group: 'water', short: true, ...o }];
Object.assign(PROFILE_FIELDS, Object.fromEntries([
  WF('wfGoal', '盤查目的', { hint: '例：掌握院區取水、用水、排水，作為節水改善依據' }), WF('wfBoundary', '系統邊界（院區內直接用水／含間接用水）'),
  WF('wfBoundaryNote', '邊界說明（納入哪些建築、院區；外包廚房、洗衣是否納入）', { short: false }), WF('wfCutoff', '排除項目與截斷準則', { hint: '例：未設水表的零星用水（< 1%）不另計' }),
  WF('wfReportingUnits', '報告單位（每床日、每人次、每平方公尺樓地板、每員工）', { default: '每床日、每人次（門急診＋住院）' }),
  WF('wfBasin', '所在流域'), WF('wfSupplyArea', '供水系統（淨水場供水區）'), WF('wfTemporal', '時間代表性', { default: '逐月，依抄表期別（YYYY-MM）' }),
  WF('wfDataQuality', '資料品質要求', { hint: '例：取水以水費單與總表為準；分表每月抄一次' }), WF('wfBaselineYear', '用水基線年'),
  WF('wfBaselineNote', '基線選定理由與重設條件'), WF('wfTargetPct', '用水效率目標（較基線降低 %）'), WF('wfTargetYear', '目標年'),
  WF('wfTargetIndicator', '目標所指的指標（總取水量、每床日…）'), WF('wfElecWaterFactor', '外購電力用水係數（自訂，L/kWh；空白用預設）'),
  WF('wfElecWaterFactorNote', '自訂係數來源與年份'), WF('wfAwareRegion', '缺水特徵化因子地區（AWARE）'), WF('wfAwareUse', '特徵化因子用途別', { default: '非農業用水' }),
  WF('wfUpstream', '間接用水·其他上游（每行：類別｜名稱｜年用量｜單位｜係數與來源）', { short: false }),
]));
// 本院盤查計算方式（空白＝依平台「門檻與設定 › 排放量計算方式」）
const CALC = (key, label, options, hint) => [key, { key, label, group: 'calc', short: true, options, hint }];
Object.assign(PROFILE_FIELDS, Object.fromEntries([
  CALC('gwpSet', '全球暖化潛勢（GWP）版本', [['', '依平台預設'], ['AR5', 'AR5（環境部盤查登錄現行採用）'], ['AR6', 'AR6（ISO 14064-1 查證報告書常用）'], ['AR4', 'AR4'], ['auto', '依盤查年度自動選（111 年度以前 AR4，112 年度起 AR5）']],
    '環境部盤查登錄規定用 AR5；本院第三方查證的盤查報告書若用 AR6，選 AR6 平台算出的數字才會和報告書一致'),
  CALC('refrigerantMethod', '冷媒逸散量計算方式', [['', '依平台預設'], ['recharge', '補充量法：年度補充量即逸散量'], ['screening', '設備逸散率法：銘牌充填量 × 年逸散率']],
    '設備逸散率法要在冷媒設備填銘牌充填量與年逸散率，結果標為推估值'),
]));
export const PROFILE_GROUPS = { ghg: '盤查報告說明', basic: '機關基本資料（各申報共用）', energy: '能源查核申報', moenv: '環境部盤查登錄', gov: '政府機關及學校節約能源填報網站', calc: '盤查計算方式（本院）', water: '水足跡範疇與基線（ISO 14046／46001）' };

export function getProfile(orgId) {
  return j(q.get('SELECT data FROM org_profiles WHERE org_id = ?', orgId)?.data, {});
}
export function readProfile(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return { data: getProfile(orgId), fields: PROFILE_FIELDS, groups: PROFILE_GROUPS };
}
// 公開資料先補的欄位記在 data._pub[key] = { url, quote, asOf }：畫面淡黃底。
// 院方儲存一次就算看過、全部確認（標記清掉）；院方已有值的欄位，公開資料不覆蓋。
export function saveProfile(ctx, orgId, data) {
  assertCan(ctx, 'report.write', orgId);
  const allowed = new Set(Object.values(PROFILE_FIELDS).map((f) => f.key));
  const opts = Object.fromEntries(Object.values(PROFILE_FIELDS).filter((f) => f.options).map((f) => [f.key, f.options.map(([o]) => o)]));
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([k, v]) => allowed.has(k) && typeof v === 'string').map(([k, v]) => [k, v.trim()]));
  for (const [k, v] of Object.entries(clean)) if (opts[k] && !opts[k].includes(v)) throw bad(`「${Object.values(PROFILE_FIELDS).find((f) => f.key === k).label}」只能選列出的選項`);
  const before = getProfile(orgId);
  writeProfile(ctx.userId, orgId, clean);
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'org.profile', targetType: 'organization', targetId: orgId, before, after: clean });
}
function writeProfile(by, orgId, data) {
  if (q.get('SELECT 1 FROM org_profiles WHERE org_id = ?', orgId)) update('org_profiles', orgId, { data, updated_by: by, updated_at: nowIso() }, 'org_id');
  else insert('org_profiles', { org_id: orgId, data, updated_by: by, updated_at: nowIso() });
}
// 公開資料補空欄：entries = { key: { value, url, quote, asOf } }；只填空的欄位，回實際填了哪些
export function fillProfileFromPublic(orgId, entries) {
  const allowed = new Set(Object.values(PROFILE_FIELDS).map((f) => f.key));
  const before = getProfile(orgId);
  const next = { ...before, _pub: { ...(before._pub || {}) } };
  const filled = [];
  for (const [k, e] of Object.entries(entries || {})) {
    const v = String(e?.value ?? '').trim();
    if (!allowed.has(k) || !v || !e.url || (before[k] && !before._pub?.[k])) continue;
    next[k] = v; next._pub[k] = { url: e.url, quote: e.quote || '', asOf: e.asOf || '' }; filled.push(k);
  }
  if (!filled.length) return [];
  writeProfile('public-data', orgId, next);
  audit({ actor: 'public-data', actorName: '公開資料補登', orgId, action: 'org.profile', targetType: 'organization', targetId: orgId, before, after: next });
  return filled;
}
// 報告手動欄位的值：案件填的 > 院所基本資料 > 預設文字
export function manualValue(fieldId, caseManual, profile) {
  if (caseManual[fieldId]) return { value: caseManual[fieldId], from: 'case' };
  const f = PROFILE_FIELDS[fieldId];
  if (f && profile[f.key]) return { value: profile[f.key], from: 'profile' };
  if (f?.default) return { value: f.default, from: 'default' };
  return { value: null, from: null };
}
