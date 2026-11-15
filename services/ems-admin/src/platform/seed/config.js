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
  'notify.channels': { inApp: true, email: false },
  'export.retentionDays': 3650,
  'security.session': { idleMinutes: 480, rememberDays: 30 },
};
