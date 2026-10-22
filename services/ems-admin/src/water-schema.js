// 水足跡盤查（工作清單第 23 項）：初始建檔的水區塊、點位項目的水屬性、用水點位範本。
//
// 依據：ISO 14046:2014（水足跡：原則、要求與指引）與 ISO 46001:2019（用水效率管理系統），
// 條號與取得程度見 docs/water-footprint-spec.md。本系統只做 ISO 14046 的「盤查」（5.3），
// 不做衝擊評估（5.4）——依 3.3.1 註 1，報表一律稱「水足跡盤查」。
//
// 這支只放純資料與小檢查；inventory-schema.js 把 WATER_SITE_BLOCKS 接到 SITE_BLOCKS 後面、
// 把 WATER_SPEC 放進 /api/inv/spec，前端表單照樣由 spec 動態長出來（不改前端就有新區塊）。
// 不 import inventory-schema.js（避免循環相依）。

const ISO14046 = 'ISO 14046:2014';
const ISO46001 = 'ISO 46001:2019';
const SPEC_DOC = 'docs/water-footprint-spec.md';
// source 形狀與其他區塊相同 { doc, ref, spec?, note? }；specDoc 讓畫面知道 spec 指的是哪一份文件
export const W14 = (ref, spec, note) => ({ doc: ISO14046, ref, ...(spec ? { spec, specDoc: SPEC_DOC } : {}), ...(note ? { note } : {}) });
export const W46 = (ref, spec, note) => ({ doc: ISO46001, ref, ...(spec ? { spec, specDoc: SPEC_DOC } : {}), ...(note ? { note } : {}) });
const SECONDHAND = '條文內容取自二手來源（未取得 ISO 原文），見規格 §0';

export const WATER_NAV_GROUP = '水足跡盤查（ISO 14046／46001）';

// ── 選項 ──
export const WATER_SOURCE_TYPES = ['自來水', '地下水', '雨水回收', '再生水（外購）', '院內回收水', '地表水', '外購水車', '其他'];
// ISO 46001 第 1 章 註 2「replace」：以再生水、雨水等取代自來水
export const REPLACE_SOURCE_TYPES = ['雨水回收', '再生水（外購）', '院內回收水'];
export const WATER_UNIT_KINDS = ['冷卻水塔', '洗衣房', '廚房餐廳', '消毒供應（滅菌）', '血液透析', '空調加濕', '景觀灌溉', '病房與一般衛生', '純水（RO）製造', '鍋爐補水', '檢驗實驗室', '消防', '其他'];
export const WATER_USE_FORMS = ['蒸發', '併入產品或廢棄物', '排到其他流域或海', '幾乎全數排入污水（非消耗）'];
export const DISCHARGE_DESTINATIONS = ['公共污水下水道', '自設污水處理設施後放流', '回收再利用', '委外清運', '其他'];
export const QUALITY_PARAMS = ['pH', '水溫', 'BOD', 'COD', 'SS', '大腸桿菌群', '氨氮', '總磷', '油脂', '餘氯', '導電度', '其他'];
export const REPORTING_UNITS = [
  { id: 'bedDay', label: '每床日', unit: 'L/床日' },
  { id: 'visit', label: '每人次（門急診＋住院）', unit: 'L/人次' },
  { id: 'area', label: '每平方公尺樓地板', unit: 'm³/m²·年' },
  { id: 'fte', label: '每員工（FTE）', unit: 'm³/人·年' },
];

// ── 初始建檔：水的區塊（形狀同 inventory-schema 的 SITE_BLOCKS）──
const SCOPE_FIELDS = [
  { key: 'goal', label: '盤查目的', type: 'text', required: true, group: '目的與範疇', hint: '例：掌握院區取水、用水、排水，作為節水改善依據' },
  { key: 'boundary', label: '系統邊界', type: 'select', required: true, group: '目的與範疇',
    options: ['院區直接用水（取水→院內用水→排放）', '院區直接用水＋間接用水（另行估算）'], default: '院區直接用水（取水→院內用水→排放）' },
  { key: 'boundaryNote', label: '邊界說明', type: 'text', group: '目的與範疇', hint: '納入哪些建築、院區；外包廚房、洗衣是否納入' },
  { key: 'cutoff', label: '排除項目與截斷準則', type: 'text', group: '目的與範疇', hint: '例：未設水表的零星用水（< 1%）不另計' },
  { key: 'reportingUnits', label: '報告單位', type: 'multiselect', required: true, group: '報告單位', options: REPORTING_UNITS.map((u) => u.label), hint: '組織的水足跡評估以「報告單位」取代功能單位' },
  { key: 'drainageBasin', label: '所在流域', type: 'text', group: '地理與時間代表性', hint: '例：淡水河流域' },
  { key: 'supplyArea', label: '供水系統', type: 'text', group: '地理與時間代表性', hint: '例：○○淨水場供水區' },
  { key: 'temporal', label: '時間代表性', type: 'text', group: '地理與時間代表性', default: '逐月，依抄表期別（YYYY-MM）' },
  { key: 'dataQuality', label: '資料品質要求', type: 'text', group: '地理與時間代表性', hint: '例：取水以水費單與總表為準；分表每月抄一次' },
  { key: 'baselineYear', label: '用水基線年', type: 'year', required: true, group: '基線與目標', hint: '民國或西元皆可；績效指標與這一年比較' },
  { key: 'baselineNote', label: '基線選定理由與重設條件', type: 'text', group: '基線與目標', hint: '例：擴床、新建大樓啟用時重設' },
  { key: 'targetPct', label: '用水效率目標（較基線降低）', type: 'percent', unit: '%', group: '基線與目標' },
  { key: 'targetYear', label: '目標年', type: 'year', group: '基線與目標' },
];

const ACTIVITY_FIELDS = [
  { key: 'year', label: '年度', type: 'year', required: true, hint: '民國或西元皆可' },
  { key: 'bedDays', label: '住院人日', type: 'number', unit: '床日', hint: '每床日用水的分母' },
  { key: 'outpatientVisits', label: '門診人次', type: 'number', unit: '人次' },
  { key: 'erVisits', label: '急診人次', type: 'number', unit: '人次' },
  { key: 'admissions', label: '住院人次', type: 'number', unit: '人次' },
  { key: 'staffFte', label: '員工（FTE）', type: 'number', unit: '人', hint: '全時當量：總人時 ÷ 每日標準工時' },
  { key: 'floorArea', label: '樓地板面積', type: 'number', unit: 'm²', hint: '空白就用基本資料表三第 18 欄' },
  { key: 'note', label: '備註', type: 'text' },
];

const SOURCE_FIELDS = [
  { key: 'sourceType', label: '水源類型', type: 'select', required: true, options: WATER_SOURCE_TYPES, default: '自來水' },
  { key: 'name', label: '水源名稱', type: 'text', required: true, hint: '例：自來水 醫療大樓水號' },
  { key: 'accountNo', label: '水號或水權狀號', type: 'text' },
  { key: 'supplier', label: '供水單位', type: 'text' },
  { key: 'freshness', label: '水質類別', type: 'select', options: ['淡水', '半鹹水', '海水'], default: '淡水', hint: '淡水溶解固體一般 < 1,000 mg/L' },
  { key: 'waterBody', label: '取水水體／流域', type: 'text' },
  { key: 'permitVolume', label: '許可水量', type: 'number', unit: 'm³/年', hint: '地下水水權' },
  { key: 'note', label: '備註', type: 'text' },
];

const UNIT_FIELDS = [
  { key: 'kind', label: '用水單元', type: 'select', required: true, options: WATER_UNIT_KINDS },
  { key: 'name', label: '名稱', type: 'text', required: true, hint: '例：醫療大樓 RF 冷卻水塔' },
  { key: 'building', label: '建築', type: 'ref', ref: 'buildings' },
  { key: 'useForm', label: '用水型態', type: 'select', options: WATER_USE_FORMS, hint: '蒸發、併入產品＝消耗；排入污水＝非消耗' },
  { key: 'consumptionPct', label: '估計消耗比例', type: 'percent', unit: '%', hint: '排放量沒有量測時，用來估算消耗量' },
  { key: 'significant', label: '主要用水', type: 'boolean', hint: '占總用水大或節水潛力大' },
  { key: 'estimatedShare', label: '估計占總取水', type: 'percent', unit: '%', hint: '沒有分表時填' },
  { key: 'note', label: '備註', type: 'text' },
];

const DISCHARGE_FIELDS = [
  { key: 'destination', label: '去向', type: 'select', required: true, options: DISCHARGE_DESTINATIONS },
  { key: 'name', label: '名稱', type: 'text', required: true, hint: '例：污水處理場放流口' },
  { key: 'receivingBody', label: '承受水體或下水道系統', type: 'text' },
  { key: 'permitNo', label: '排放許可或納管文號', type: 'text' },
  { key: 'treatment', label: '處理方式', type: 'text' },
  { key: 'qualityParams', label: '水質檢測項目', type: 'multiselect', options: QUALITY_PARAMS, hint: '依各院放流水許可' },
  { key: 'note', label: '備註', type: 'text' },
];

const groupsOf = (fields, map) => [...new Set(fields.map((f) => f.group || ''))].map((name) => ({ name, source: map[name] || null }));

export const WATER_SITE_BLOCKS = [
  { id: 'waterScope', label: '水足跡範疇與基線', navGroup: WATER_NAV_GROUP, kind: 'form', fields: SCOPE_FIELDS,
    source: W14('5.2 目的與範疇（5.2.1～5.2.4）', '§2.1', '另依 ISO 46001 6.2.7 基線、6.3 目標'),
    groups: groupsOf(SCOPE_FIELDS, {
      目的與範疇: W14('5.2.1 目的、5.2.3 系統邊界；3.3.8、3.3.9', '§2.1', '組織的邊界另見附錄 A'),
      報告單位: W14('3.5.7 功能單位 註 1', '§2.1', '組織的評估可用「報告單位」；指標定義依 ISO 46001 3.4'),
      地理與時間代表性: W14('4.12 地理相關性；3.1.8 流域；3.2.1 註 2；5.2.4 資料品質要求', '§2.1'),
      基線與目標: W46('3.2 基線用水效率指標；6.2.7；6.3', '§2.1'),
    }) },
  { id: 'waterActivity', label: '營運活動資料', navGroup: WATER_NAV_GROUP, kind: 'table', rowLabel: '年度', fields: ACTIVITY_FIELDS,
    source: W46('3.4 營運活動指標；3.11 全時當量；6.2.5', '§2.2', '用水績效指標的分母，一年一筆') },
  { id: 'waterSources', label: '水源', navGroup: WATER_NAV_GROUP, kind: 'table', rowLabel: '水源', fields: SOURCE_FIELDS,
    source: W14('3.1.1～3.1.7 水的分類；3.2.2 取水；5.3.2 基本流', '§2.3', `取水依水源別彙整。5.3.2 ${SECONDHAND}`) },
  { id: 'waterUnits', label: '主要用水單元', navGroup: WATER_NAV_GROUP, kind: 'table', rowLabel: '用水單元', fields: UNIT_FIELDS,
    source: W46('6.2.4 用水審查；附錄 C 水平衡', '§2.4', `用水型態與消耗依 ISO 14046 3.2.1 註 2。6.2.4 ${SECONDHAND}`) },
  { id: 'waterDischarges', label: '排放與回收', navGroup: WATER_NAV_GROUP, kind: 'table', rowLabel: '排放口', fields: DISCHARGE_FIELDS,
    source: W14('3.1.9 基本水流；3.2.4 水質；5.3.2', '§2.5', `排放量、去向與水質。5.3.2 ${SECONDHAND}`) },
];

// ── 點位項目的水屬性 ──
export const WATER_FLOWS = {
  intake: { label: '取水', hint: '從院外取進來的水（自來水總表、地下水、雨水回收）', source: W14('3.2.2 取水；3.1.9 基本水流', '§3.1') },
  use: { label: '用水單元分表', hint: '院內各用水單元的分表（冷卻水塔、洗衣房…）；不重複計入取水', source: W46('6.2.4 用水審查；附錄 C', '§3.4') },
  discharge: { label: '排放', hint: '排出院外的水（污水下水道、放流口）', source: W14('3.1.9 基本水流；3.2.1 註 2', '§3.2') },
  reuse: { label: '回收再利用', hint: '院內回收後再使用的水（灰水、RO 濃排回收）', source: W46('第 1 章 註 3 reuse', '§3.2') },
  quality: { label: '水質', hint: '水質抽測值；要填水質項目（例：pH、COD）', source: W14('3.2.4 水質', '§2.5') },
  saving: { label: '節水改善', hint: '節水改善回報的預估年節水量（m³/年）', source: W46('第 1 章 註 1～3；6.3 目標與行動計畫', '§2.6') },
};
const QUANTITY_TYPES = ['reading', 'number'];
const WATER_KEYS = ['waterFlow', 'waterSourceId', 'waterUnitId', 'waterDischargeId', 'waterParam'];
export const hasWaterAttrs = (it) => WATER_KEYS.some((k) => it?.[k] !== undefined);

// 點位項目水屬性的檢查（zod 型別在 inventory-schema 的 itemSchema；這裡只管跨欄位與連結）
export function waterItemErrors(point, it, inv) {
  const errors = [];
  if (!hasWaterAttrs(it)) return errors;
  const L = `「${it.label}」`;
  if (point.domain !== 'water') { errors.push(`${L}水屬性（流向、水源、用水單元、排放口）只能用在水類點位`); return errors; }
  if (it.waterFlow && !QUANTITY_TYPES.includes(it.type)) errors.push(`${L}只有累計讀數或一般數值能設定水的流向`);
  if ((it.waterFlow === 'quality' || it.waterFlow === 'saving') && it.type !== 'number') errors.push(`${L}水質、節水改善只能用一般數值`);
  if (it.waterParam && it.waterFlow !== 'quality') errors.push(`${L}水質項目只能用在流向「水質」的項目`);
  if (it.waterSourceId && it.waterFlow && it.waterFlow !== 'intake') errors.push(`${L}只有「取水」項目能連結水源`);
  if (it.waterUnitId && it.waterFlow && !['use', 'saving'].includes(it.waterFlow)) errors.push(`${L}只有「用水單元分表」「節水改善」項目能連結用水單元`);
  if (it.waterDischargeId && it.waterFlow && !['discharge', 'quality'].includes(it.waterFlow)) errors.push(`${L}只有「排放」「水質」項目能連結排放口`);
  if (inv) {
    const has = (block, id) => (inv.site?.[block] || []).some((r) => r.id === id);
    if (it.waterSourceId && !has('waterSources', it.waterSourceId)) errors.push(`${L}連結的水源不存在：${it.waterSourceId}`);
    if (it.waterUnitId && !has('waterUnits', it.waterUnitId)) errors.push(`${L}連結的用水單元不存在：${it.waterUnitId}`);
    if (it.waterDischargeId && !has('waterDischarges', it.waterDischargeId)) errors.push(`${L}連結的排放口不存在：${it.waterDischargeId}`);
  }
  return errors;
}

// ── 用水點位範本（管理端「套用用水點位範本」）──
// items 裡的 id 是建議值；套用時前端會避開既有 id 重新配號。連結（水源、用水單元、排放口）套用後再選。
const st = (label) => ({ id: 'status', label, type: 'status' });
export const WATER_POINT_TEMPLATES = [
  { id: 'main-meter', label: '自來水總表', purpose: '用水數據填報', name: '自來水總表', hint: '院區總取水；連結水源（自來水各水號）',
    source: WATER_FLOWS.intake.source,
    items: [{ id: 'intake', label: '總表讀數', type: 'reading', unit: 'm³', warnPct: 30, waterFlow: 'intake', required: true }, st('水表狀態')] },
  { id: 'groundwater', label: '地下水抽水量', purpose: '用水數據填報', name: '地下水抽水', hint: '連結水源（地下水）',
    source: WATER_FLOWS.intake.source,
    items: [{ id: 'intake', label: '抽水量水表讀數', type: 'reading', unit: 'm³', warnPct: 30, waterFlow: 'intake', required: true }, st('抽水設備狀態')] },
  { id: 'rainwater', label: '雨水回收量', purpose: '用水數據填報', name: '雨水回收', hint: '雨水是替代水源：連結水源（雨水回收）',
    source: W46('第 1 章 註 2 replace；ISO 14046 3.2.2', '§2.6'),
    items: [{ id: 'intake', label: '雨水回收水表讀數', type: 'reading', unit: 'm³', waterFlow: 'intake', required: true }, st('回收系統狀態')] },
  { id: 'reuse', label: '院內回收水量', purpose: '用水數據填報', name: '回收水', hint: '灰水、RO 濃排等院內回收後再用的水',
    source: WATER_FLOWS.reuse.source,
    items: [{ id: 'reuse', label: '回收水量計讀數', type: 'reading', unit: 'm³', waterFlow: 'reuse', required: true }, st('回收設備狀態')] },
  { id: 'cooling-tower', label: '冷卻水塔補水', purpose: '用水數據填報', name: '冷卻水塔補水', hint: '連結用水單元（冷卻水塔）；補水大部分蒸發',
    source: WATER_FLOWS.use.source,
    items: [{ id: 'makeup', label: '補水水表讀數', type: 'reading', unit: 'm³', warnPct: 40, waterFlow: 'use', required: true }, st('冷卻水塔狀態')] },
  { id: 'unit-submeter', label: '用水單元分表', purpose: '用水數據填報', name: '用水單元分表', hint: '洗衣房、廚房、透析、消毒供應等；連結用水單元',
    source: WATER_FLOWS.use.source,
    items: [{ id: 'use', label: '分表讀數', type: 'reading', unit: 'm³', warnPct: 40, waterFlow: 'use', required: true }, st('設備狀態')] },
  { id: 'discharge', label: '污水排放量', purpose: '用水數據填報', name: '污水排放', hint: '連結排放口',
    source: WATER_FLOWS.discharge.source,
    items: [{ id: 'discharge', label: '放流水量計讀數', type: 'reading', unit: 'm³', warnPct: 40, waterFlow: 'discharge', required: true }, st('處理設施狀態')] },
  { id: 'quality', label: '水質抽測', purpose: '水足跡登錄', name: '放流水水質抽測', hint: '項目依各院放流水許可增減；連結排放口',
    source: WATER_FLOWS.quality.source,
    items: [
      { id: 'ph', label: 'pH', type: 'number', waterFlow: 'quality', waterParam: 'pH' },
      { id: 'cod', label: 'COD', type: 'number', unit: 'mg/L', waterFlow: 'quality', waterParam: 'COD' },
      { id: 'ss', label: 'SS', type: 'number', unit: 'mg/L', waterFlow: 'quality', waterParam: 'SS' },
      { id: 'coliform', label: '大腸桿菌群', type: 'number', unit: 'CFU/100mL', waterFlow: 'quality', waterParam: '大腸桿菌群' },
      { id: 'report', label: '檢驗報告', type: 'photo' },
    ] },
  { id: 'saving', label: '節水改善回報', purpose: '節水改善回報', name: '節水改善回報', hint: '改善完成時回報一次；可連結用水單元',
    source: WATER_FLOWS.saving.source,
    items: [
      { id: 'action', label: '改善內容', type: 'text', required: true },
      { id: 'saving', label: '預估年節水量', type: 'number', unit: 'm³/年', waterFlow: 'saving' },
      { id: 'photo', label: '改善照片', type: 'photo' },
    ] },
];

export const WATER_SPEC = {
  navGroup: WATER_NAV_GROUP,
  flows: WATER_FLOWS,
  sourceTypes: WATER_SOURCE_TYPES,
  replaceSourceTypes: REPLACE_SOURCE_TYPES,
  reportingUnits: REPORTING_UNITS,
  qualityParams: QUALITY_PARAMS,
  pointTemplates: WATER_POINT_TEMPLATES,
  itemKeys: WATER_KEYS,
  source: W14('5.3 水足跡盤查分析', '§2', '只做盤查，不做 5.4 衝擊評估；依 3.3.1 註 1 稱「水足跡盤查」'),
};
