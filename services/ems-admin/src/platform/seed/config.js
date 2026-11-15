// 版本化設定的預設值（PRD §18）。種子以「已發布 v1」寫入，之後的修改走草稿→送審→發布。
export const DEFAULT_CONFIG = {
  // 比對與檢核（PRD §10.3、§10.4）
  'compare.thresholds': {
    default: { abs: 0, rel_pct: 3 },
    byMetricSemantics: { usage: { abs: 50, rel_pct: 3 }, cost: { abs: 100, rel_pct: 1 }, withdrawal: { abs: 5, rel_pct: 5 }, consumption: { abs: 5, rel_pct: 5 } },
    reference: 'max_priority_source', // 相對差分母：優先序最高的來源；分母為 0 時只看絕對差
    zeroDenominator: 'abs_only',
  },
  'validation.rules': {
    version: 1,
    rules: {
      required_type: { enabled: true, severity: 'error' },
      period_valid: { enabled: true, severity: 'error' },
      unit_convertible: { enabled: true, severity: 'error' },
      negative_usage: { enabled: true, severity: 'error' },
      cumulative_backward: { enabled: true, severity: 'error' },
      duplicate_source: { enabled: true, severity: 'warning' },
      false_independence: { enabled: true, severity: 'warning' },
      cross_source: { enabled: true, severity: 'warning' },
      history_anomaly: { enabled: true, severity: 'warning', yoy_rel_pct: 40, mom_rel_pct: 60, min_history: 3 },
      coverage_gap: { enabled: true, severity: 'warning' },
      oil_balance: { enabled: true, severity: 'warning', tolerance_pct: 5 },
      meter_balance: { enabled: true, severity: 'warning', loss_max_pct: 8 },
      evidence_required: { enabled: true, severity: 'warning', methods: ['manual', 'import', 'ocr'] },
      period_end_pending: { enabled: true, severity: 'info' },
    },
  },
  // 裁決（PRD §8.2 高影響雙人覆核）
  'decision.policy': {
    highImpact: { derived: true, estimated: true, notApplicable: true, relDiffPct: 10, absValueOver: { kWh: 100000, L: 5000, m3: 10000 } },
    requireEvidenceForSelect: true,
    reviewerMustDifferFromProposer: true,
  },
  'case.sla': { low: 30, medium: 14, high: 7, critical: 3 }, // 天
  'task.reminders': { beforeDueDays: [3, 1], overdueEveryDays: 2 },
  'calc.settings': { gwpSet: 'AR5', precision: { tCO2e: 4, kWh: 0, GJ: 3, m3: 1 }, refrigerantMethod: 'recharge' },
  'calc.septic': { visitHours: 2, workdayHours: 8, note: '門診人次以每次停留 2 小時折算人日；院方採用指引不同時請修改' },
  // 看板（PRD §9）：公開層只顯示這些欄位
  'dashboard.visibility': {
    public: ['domain_progress', 'kpi_rates', 'usage_count', 'site_progress'],
    hideBelowCount: 0,
  },
  // ISO 14064-1：不確定性預設值（院方依採用指引調整；觀測值有填不確定性時以觀測值為準）
  'ghg.uncertainty': {
    activityByMethod: { api: 2, import: 2, legacy: 2, ocr: 3, manual: 5 }, activityEstimated: 20, activityDerived: 10,
    factorByKind: { combustion: 5, electricity: 5, refrigerant: 10, insulating: 10, process: 10, septic: 50, imported_heat: 10 },
    confidence: '95%', note: '活動數據與係數的相對不確定性（±%）；以誤差傳遞法合成（IPCC 2006 Vol.1 Ch.3 方法 1）',
  },
  'ghg.significance': {
    thresholdPct: 1, criteria: '預估排放量占類別一＋類別二總量 1% 以上，或法規、主管機關、利害關係人要求揭露者，判定為顯著並量化',
  },
  // 顯著性評估自動估算：活動量（指標）× 係數。係數要在係數庫新增並發布後才會估算（系統不內建數值）
  'ghg.significance_estimators': {
    'UPSTREAM-ENERGY': { indicator: 'energy.elec_kwh', factor: 'ef.upstream.electricity', label: '外購電力（度）× 電力上游排放係數（kgCO₂e/度）' },
    'UPSTREAM-WATER': { indicator: 'water.withdrawal_m3', factor: 'ef.upstream.water', label: '取水量（m³）× 自來水排放係數（kgCO₂e/m³）' },
    'WASTEWATER': { indicator: 'water.discharge_m3', factor: 'ef.wastewater.treatment', label: '排水量（m³）× 污水處理排放係數（kgCO₂e/m³）' },
    'REF-COMMUTE': { indicator: 'act.staff_count', factor: 'ef.commute.per_staff', label: '員工人數 × 每人年通勤排放（kgCO₂e/人）' },
  },
  // 環境部「溫室氣體排放量盤查作業指引」數據品質評分：三項等級相乘得積分，再分級（院方依採用版本調整）
  'ghg.data_quality': {
    activityType: { 1: '自動連續量測', 2: '間歇量測（帳單、抄表）', 3: '自行推估' },
    activityTrust: { 1: '有外部校正或第三方證明', 2: '有內部校正紀錄', 3: '未校正或無紀錄' },
    factorType: { 1: '自廠發展／實測係數', 2: '同製程／設備經驗係數、製造廠提供', 3: '區域／國家／國際排放係數' },
    grades: [{ max: 10, grade: '第一級' }, { max: 19, grade: '第二級' }, { max: 27, grade: '第三級' }],
  },
  'notify.channels': { inApp: true, email: false },
  'export.retentionDays': 3650,
  'security.session': { idleMinutes: 480, rememberDays: 30 },
};
