// 門檻與設定：把版本化設定（JSON）攤成選項表單。
// 有列舉的值用下拉選單、是非用勾選、數字用數字欄；結構太自由的（陣列物件、對照表）才留 JSON。
// 存檔時以原值為底，只覆寫表單上的鍵，不會弄丟沒列出來的欄位。
import { h } from '../core.js';

const SEV = [['error', '錯誤（擋下）'], ['warning', '警告'], ['info', '提示']];
const GWP = [
  ['auto', '依盤查年度自動選（111 年度以前 AR4；112 年度起 AR5，依環境部公告）'],
  ['AR4', 'AR4（IPCC 第四次評估報告）'],
  ['AR5', 'AR5（IPCC 第五次評估報告；環境部盤查登錄現行採用）'],
  ['AR6', 'AR6（IPCC 第六次評估報告；ISO 14064-1 自願盤查、第三方查證報告書常用）'],
];
const REF = [
  ['recharge', '補充量法：年度補充（維修灌充）量即逸散量（質量平衡）'],
  ['screening', '設備逸散率法：銘牌充填量 × 年逸散率（沒有補充紀錄時用；結果標為推估值）'],
];
const RULE_NAME = {
  required_type: '必填型態', period_valid: '期間合理', unit_convertible: '單位可換算', negative_usage: '用量為負', cumulative_backward: '累計讀值倒退',
  duplicate_source: '同一來源重複', false_independence: '假獨立來源', cross_source: '多來源比對差異', history_anomaly: '歷史波動異常', coverage_gap: '期間缺漏',
  oil_balance: '油料收支平衡', meter_balance: '總分表平衡', evidence_required: '需附佐證', period_end_pending: '期末待補',
};
const RULE_PARAM = { yoy_rel_pct: '年增減超過（%）', mom_rel_pct: '月增減超過（%）', min_history: '至少幾期歷史才比對', tolerance_pct: '容許差（%）', loss_max_pct: '總分表損失上限（%）' };
const SEM = { usage: '用量', cost: '費用', withdrawal: '取水', consumption: '消耗' };
const METHOD = { api: '介接', import: '檔案匯入', legacy: '舊系統移轉', ocr: '帳單辨識', manual: '人工登錄' };
const KIND = { combustion: '燃料燃燒', electricity: '外購電力', refrigerant: '冷媒', insulating: '絕緣氣體', process: '製程氣體', septic: '化糞池', imported_heat: '外購熱能' };
const PUBLIC_BLOCKS = [['domain_progress', '油水電氣盤點進度'], ['kpi_rates', '完成率指標'], ['usage_count', '數據被引用次數'], ['site_progress', '各院區進度']];

// 每個設定：[路徑, 標籤, 型態, 選項或提示]；路徑用「.」分層，'' 代表整個值是單一數字
const S = {
  'calc.settings': [
    ['gwpSet', '全球暖化潛勢（GWP）版本', 'select', GWP],
    ['refrigerantMethod', '冷媒逸散量計算方式', 'select', REF],
    ['precision.tCO2e', '排放量顯示小數位（tCO₂e）', 'number'], ['precision.kWh', '電量顯示小數位（度）', 'number'],
    ['precision.GJ', '熱值顯示小數位（GJ）', 'number'], ['precision.m3', '水量顯示小數位（m³）', 'number'],
  ],
  'calc.septic': [['visitHours', '門診每人次停留時數（小時）', 'number'], ['workdayHours', '員工每日工時（小時）', 'number'], ['note', '說明', 'textarea']],
  'case.sla': [['critical', '緊急案件處理期限（天）', 'number'], ['high', '高', 'number'], ['medium', '中', 'number'], ['low', '低', 'number']],
  'compare.thresholds': [
    ['default.abs', '預設絕對差門檻', 'number'], ['default.rel_pct', '預設相對差門檻（%）', 'number'],
    ...Object.entries(SEM).flatMap(([k, n]) => [[`byMetricSemantics.${k}.abs`, `${n}：絕對差門檻`, 'number'], [`byMetricSemantics.${k}.rel_pct`, `${n}：相對差門檻（%）`, 'number']]),
    ['reference', '相對差的分母', 'select', [['max_priority_source', '優先序最高的來源']]],
    ['zeroDenominator', '分母為 0 時', 'select', [['abs_only', '只看絕對差']]],
  ],
  'dashboard.visibility': [['public', '公開看板顯示的區塊', 'multi', PUBLIC_BLOCKS], ['hideBelowCount', '數量少於多少時隱藏', 'number']],
  'decision.policy': [
    ['highImpact.derived', '推算值需兩位審核', 'checkbox'], ['highImpact.estimated', '估計值需兩位審核', 'checkbox'], ['highImpact.notApplicable', '判定不適用需兩位審核', 'checkbox'],
    ['highImpact.relDiffPct', '來源差異超過（%）需兩位審核', 'number'],
    ['highImpact.absValueOver.kWh', '電量超過（度）需兩位審核', 'number'], ['highImpact.absValueOver.L', '油量超過（公升）需兩位審核', 'number'], ['highImpact.absValueOver.m3', '水量超過（m³）需兩位審核', 'number'],
    ['requireEvidenceForSelect', '選用來源時必須附佐證', 'checkbox'], ['reviewerMustDifferFromProposer', '審核者不可是提出者', 'checkbox'],
  ],
  'export.retentionDays': [['', '匯出檔與報告版本保存天數', 'number']],
  'ghg.significance': [['thresholdPct', '顯著性門檻（占類別一＋二總量 %）', 'number'], ['criteria', '判定準則', 'textarea']],
  'ghg.uncertainty': [
    ...Object.entries(METHOD).map(([k, n]) => [`activityByMethod.${k}`, `活動數據不確定性：${n}（±%）`, 'number']),
    ['activityEstimated', '活動數據不確定性：估計值（±%）', 'number'], ['activityDerived', '活動數據不確定性：推算值（±%）', 'number'],
    ...Object.entries(KIND).map(([k, n]) => [`factorByKind.${k}`, `係數不確定性：${n}（±%）`, 'number']),
    ['confidence', '信賴區間', 'select', [['95%', '95%'], ['90%', '90%']]], ['note', '說明', 'textarea'],
  ],
  'ghg.data_quality': [
    ...[1, 2, 3].map((n) => [`activityType.${n}`, `活動數據種類 ${n} 分`, 'text']),
    ...[1, 2, 3].map((n) => [`activityTrust.${n}`, `活動數據可信等級 ${n} 分`, 'text']),
    ...[1, 2, 3].map((n) => [`factorType.${n}`, `係數種類 ${n} 分`, 'text']),
    ['grades', '分級（積分上限與級別）', 'json'],
  ],
  'notify.channels': [['inApp', '系統內通知', 'checkbox'], ['email', 'Email 通知', 'checkbox']],
  'security.session': [['idleMinutes', '閒置逾時（分鐘）', 'number'], ['rememberDays', '記住登入（天）', 'number']],
  'task.reminders': [['beforeDueDays', '到期前幾天提醒（逗號分隔）', 'numlist'], ['overdueEveryDays', '逾期後每隔幾天再提醒', 'number']],
};

const getPath = (o, p) => (p === '' ? o : p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o));
function setPath(o, p, v) {
  if (p === '') return v;
  const ks = p.split('.'); let x = o;
  for (const k of ks.slice(0, -1)) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; x = x[k]; }
  x[ks.at(-1)] = v; return o;
}

// validation.rules：依實際規則逐條產生（新增規則不用改這裡）
function specFor(key, value) {
  if (S[key]) return S[key];
  if (key === 'validation.rules') {
    return Object.entries(value?.rules || {}).flatMap(([id, r]) => [
      ['', `${RULE_NAME[id] || id}`, 'heading'],
      [`rules.${id}.enabled`, '啟用', 'checkbox'], [`rules.${id}.severity`, '嚴重程度', 'select', SEV],
      ...Object.keys(r).filter((k) => !['enabled', 'severity'].includes(k)).map((k) =>
        Array.isArray(r[k]) ? [`rules.${id}.${k}`, k === 'methods' ? '哪些登錄方式要附佐證（逗號分隔：manual、import、ocr、api）' : k, 'list'] : [`rules.${id}.${k}`, RULE_PARAM[k] || k, 'number']),
    ]);
  }
  return null; // 沒有表單定義：維持 JSON
}

export function configOpts(key, latest) {
  const spec = specFor(key, latest?.value);
  if (!spec) return { fields: [{ key: 'value', label: '設定值（JSON）', type: 'json', required: true, wide: true }], toPatch: (v) => ({ value: v.value }), values: (r) => ({ value: r.value }) };
  const fields = []; const multi = {};
  spec.forEach(([p, label, type, opt], i) => {
    if (type === 'heading') { fields.push({ type: 'heading', key: `h${i}`, label }); return; }
    if (type === 'multi') { multi[p] = opt; fields.push({ type: 'heading', key: `h${i}`, label }); opt.forEach(([v, l]) => fields.push({ key: `${p}::${v}`, label: l, type: 'checkbox' })); return; }
    fields.push({ key: p || '_', label, wide: ['textarea', 'json'].includes(type) || (type === 'select' && opt.some(([, l]) => l.length > 20)),
      type: ['numlist', 'list'].includes(type) ? 'text' : type, options: type === 'select' ? opt : undefined });
  });
  const values = (r) => {
    const out = {};
    for (const [p, , type] of spec) {
      if (type === 'heading') continue;
      const v = getPath(r.value, p);
      if (type === 'multi') { for (const [o] of multi[p]) out[`${p}::${o}`] = Array.isArray(v) && v.includes(o); continue; }
      out[p || '_'] = Array.isArray(v) && type !== 'json' ? v.join(', ') : v;
    }
    return out;
  };
  const toPatch = (v) => {
    let value = structuredClone(latest?.value ?? {});
    for (const [p, , type] of spec) {
      if (type === 'heading') continue;
      let x;
      if (type === 'multi') x = multi[p].filter(([o]) => v[`${p}::${o}`]).map(([o]) => o);
      else {
        x = v[p || '_'];
        if (type === 'numlist') x = String(x ?? '').split(/[,，\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
        else if (type === 'list') x = String(x ?? '').split(/[,，\s]+/).filter(Boolean);
        else if (type === 'checkbox') x = !!x;
        else if (x === undefined) x = type === 'number' ? null : '';
      }
      value = setPath(value, p, x);
    }
    return { value };
  };
  return { fields, values, toPatch, spec, multi };
}

// 目前生效值：用標籤與選項文字呈現
export function configView(key, value) {
  const spec = specFor(key, value);
  if (!spec) return null;
  const rows = [];
  for (const [p, label, type, opt] of spec) {
    if (type === 'heading') { rows.push(h('dt', { class: 'pf-cfg-head' }, label), h('dd', { class: 'pf-cfg-head' }, '')); continue; }
    const v = getPath(value, p);
    let shown;
    if (type === 'select') shown = (opt.find(([o]) => o === v) || [v, v ?? '（未設定）'])[1];
    else if (type === 'checkbox') shown = v ? '是' : '否';
    else if (type === 'multi') shown = opt.filter(([o]) => (v || []).includes(o)).map(([, l]) => l).join('、') || '（無）';
    else if (type === 'json') shown = JSON.stringify(v);
    else if (Array.isArray(v)) shown = v.join('、');
    else shown = v === undefined || v === null || v === '' ? '（未設定）' : String(v);
    rows.push(h('dt', label), h('dd', shown));
  }
  return h('dl', { class: 'pf-dl pf-cfg' }, rows);
}
