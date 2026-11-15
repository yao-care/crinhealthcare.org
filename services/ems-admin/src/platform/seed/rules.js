// 計算規則（指標定義）與報告模板種子。規則與模板都有版本；已封存的報告記住當時用的版本。

const R = (code, name, definition, description = '') => ({ code, name, definition, description });

export const RULES = [
  // ── 溫室氣體 ──
  R('ghg.s1.stationary', '範疇一 固定燃燒排放', { kind: 'combustion', items: ['OIL-GEN', 'OIL-BOILER', 'GAS-NG', 'GAS-LPG'], mode: 'stationary', unit: 'tCO2e' },
    '燃料消耗量 × 各氣體排放係數 × GWP'),
  R('ghg.s1.mobile', '範疇一 移動燃燒排放', { kind: 'combustion', items: ['OIL-VEH', 'OIL-FORK'], mode: 'mobile', unit: 'tCO2e' }),
  R('ghg.s1.refrigerant', '範疇一 冷媒逸散', { kind: 'refrigerant', items: ['GAS-REF', 'GAS-FIRE'], unit: 'tCO2e' },
    '補充量 × GWP；只有銘牌、沒有補充紀錄時標示活動資料不足，不以銘牌推定'),
  R('ghg.s1.insulating', '範疇一 絕緣氣體逸散（SF₆）', { kind: 'insulating', items: ['GAS-GCB'], unit: 'tCO2e' }),
  R('ghg.s1.process', '範疇一 醫療／工業氣體', { kind: 'process_gas', items: ['GAS-MED'], unit: 'tCO2e' }, 'N₂O、CO₂ 以使用量計；氧氣不計'),
  R('ghg.s1.septic', '範疇一 化糞池甲烷', { kind: 'septic', items: ['WAT-SEPTIC'], unit: 'tCO2e' }),
  R('ghg.s1.total', '範疇一 合計', { kind: 'add', of: ['ghg.s1.stationary', 'ghg.s1.mobile', 'ghg.s1.refrigerant', 'ghg.s1.insulating', 'ghg.s1.process', 'ghg.s1.septic'], unit: 'tCO2e' }),
  R('ghg.s2.electricity', '範疇二 外購電力', { kind: 'electricity_emission', items: ['ELE-GRID'], metric: 'elec_purchased_kwh', unit: 'tCO2e' }, '外購電力 × 當年度電力排放係數'),
  R('ghg.total', '溫室氣體排放總量（範疇一＋二）', { kind: 'add', of: ['ghg.s1.total', 'ghg.s2.electricity'], unit: 'tCO2e' }),
  R('ghg.intensity_bed', '每床排放強度', { kind: 'ratio', num: 'ghg.total', den: 'act.beds', unit: 'tCO2e/bed', scale: 1 }),
  R('ghg.intensity_m2', '單位面積排放強度', { kind: 'ratio', num: 'ghg.total', den: 'act.floor_area_m2', unit: 'kgCO2e/m2', scale: 1000 }),
  // ── 能源 ──
  R('energy.elec_kwh', '外購電力', { kind: 'sum', items: ['ELE-GRID'], metrics: ['elec_purchased_kwh'], unit: 'kWh' }),
  R('energy.elec_cost', '電費', { kind: 'sum', items: ['ELE-GRID'], metrics: ['elec_cost_twd'], unit: 'TWD' }),
  R('energy.peak_kw', '最高需量', { kind: 'sum', items: ['ELE-GRID'], metrics: ['elec_peak_demand_kw'], agg: 'max', unit: 'kW' }),
  R('energy.pv_kwh', '自發電量', { kind: 'sum', items: ['ELE-PV'], metrics: ['elec_generated_kwh'], unit: 'kWh' }),
  R('energy.pv_self_kwh', '自發自用電量', { kind: 'sum', items: ['ELE-PV'], metrics: ['elec_self_used_kwh'], unit: 'kWh' }),
  R('energy.diesel_l', '柴油用量', { kind: 'sum', metrics: ['oil_consumption_l'], fuel: 'diesel', unit: 'L' }),
  R('energy.gasoline_l', '汽油用量', { kind: 'sum', metrics: ['oil_consumption_l'], fuel: 'gasoline', unit: 'L' }),
  R('energy.fuel_oil_l', '燃料油用量', { kind: 'sum', metrics: ['oil_consumption_l'], fuel: 'fuel_oil', unit: 'L' }),
  R('energy.ng_m3', '天然氣用量', { kind: 'sum', items: ['GAS-NG'], metrics: ['ng_consumption_m3'], unit: 'Nm3' }),
  R('energy.lpg_kg', 'LPG 用量', { kind: 'sum', items: ['GAS-LPG'], metrics: ['lpg_consumption_kg'], unit: 'kg' }),
  R('energy.fuel_cost', '燃料費用', { kind: 'sum', metrics: ['oil_cost_twd', 'ng_cost_twd', 'lpg_cost_twd'], unit: 'TWD' }),
  R('energy.total_gj', '能源使用總量', { kind: 'energy_total', unit: 'GJ' }, '電力 3.6 MJ/kWh；燃料依熱值表'),
  R('energy.total_toe', '能源使用總量（公噸油當量）', { kind: 'energy_total', unit: 'toe' }),
  R('energy.eui_kwh_m2', '單位面積用電（EUI）', { kind: 'ratio', num: 'energy.elec_kwh', den: 'act.floor_area_m2', unit: 'kWh/m2', scale: 1 }),
  R('energy.kwh_per_bed', '每床用電', { kind: 'ratio', num: 'energy.elec_kwh', den: 'act.beds', unit: 'kWh/bed', scale: 1 }),
  R('energy.renewable_share', '再生能源占比', { kind: 'ratio', num: 'energy.pv_self_kwh', den: 'energy.elec_kwh', unit: 'pct', scale: 100 }),
  // ── 水 ──
  R('water.withdrawal_m3', '取水量', { kind: 'sum', items: ['WAT-TAP', 'WAT-GROUND'], metrics: ['water_withdrawal_m3'], unit: 'm3' }),
  R('water.tap_m3', '自來水取水量', { kind: 'sum', items: ['WAT-TAP'], metrics: ['water_withdrawal_m3'], unit: 'm3' }),
  R('water.ground_m3', '地下水取水量', { kind: 'sum', items: ['WAT-GROUND'], metrics: ['water_withdrawal_m3'], unit: 'm3' }),
  R('water.discharge_m3', '排水量', { kind: 'sum', items: ['WAT-DIS'], metrics: ['water_discharge_m3'], unit: 'm3' }),
  R('water.consumption_m3', '耗水量', { kind: 'water_consumption', unit: 'm3' }, '有直接耗水量用直接值；否則取水－排水，並註明口徑'),
  R('water.recycled_m3', '回收再利用水量', { kind: 'sum', items: ['WAT-RECY'], metrics: ['water_reused_m3'], unit: 'm3' }),
  R('water.cost', '水費', { kind: 'sum', metrics: ['water_cost_twd'], unit: 'TWD' }),
  R('water.per_bed_day', '每床日用水', { kind: 'ratio', num: 'water.withdrawal_m3', den: 'act.inpatient_days', unit: 'L/bed_day', scale: 1000 }),
  // ── 營運與韌性 ──
  R('gen.runtime_test_h', '發電機試機時數', { kind: 'sum', items: ['OIL-GEN'], metrics: ['gen_test_runtime_h'], unit: 'h' }),
  R('gen.runtime_outage_h', '發電機斷電運轉時數', { kind: 'sum', items: ['OIL-GEN'], metrics: ['gen_outage_runtime_h'], unit: 'h' }),
  R('gen.runtime_drill_h', '發電機演練時數', { kind: 'sum', items: ['OIL-GEN'], metrics: ['gen_drill_runtime_h'], unit: 'h' }),
  R('gen.diesel_stock_l', '期末柴油存量', { kind: 'sum', items: ['OIL-GEN'], metrics: ['oil_stock_l'], agg: 'latest_per_asset', unit: 'L' }),
  R('gen.diesel_purchase_l', '柴油採購入庫', { kind: 'sum', items: ['OIL-GEN'], metrics: ['oil_purchase_l'], unit: 'L' }),
  // ── 分母（獨立來源、定義與期間）──
  R('act.floor_area_m2', '樓地板面積', { kind: 'sum', items: ['ACT-CAP'], metrics: ['floor_area_m2'], agg: 'latest_per_asset', unit: 'm2' }),
  R('act.beds', '病床數', { kind: 'sum', items: ['ACT-CAP'], metrics: ['beds'], agg: 'latest_per_asset', unit: 'bed' }),
  R('act.staff_count', '年底員工人數', { kind: 'sum', items: ['ACT-STAFF'], metrics: ['staff_count'], agg: 'latest_per_asset', unit: 'person' }),
  R('act.staff_hours', '員工工時', { kind: 'sum', items: ['ACT-STAFF'], metrics: ['staff_hours'], unit: 'person_h' }),
  R('act.outpatient', '門急診人次', { kind: 'sum', items: ['ACT-PATIENT'], metrics: ['outpatient_visits'], unit: 'visit' }),
  R('act.inpatient_days', '住院人日', { kind: 'sum', items: ['ACT-PATIENT'], metrics: ['inpatient_days'], unit: 'bed_day' }),
];

// ── 報告模板（PRD §12.2 七種）──
const F = (field_id, label, source_ref, o = {}) => ({ field_id, label, source_kind: 'indicator', source_ref, ...o });
const T = (code, name, standard, standard_version, sections, o = {}) => ({ code, name, standard, standard_version, sections, ...o });

export const TEMPLATES = [
  T('GHG-INV', '組織溫室氣體盤查', 'ISO 14064-1／環境部盤查登錄及查驗管理辦法', 'ISO 14064-1:2018', [
    { id: 's1', title: '範疇一 直接排放', fields: [
      F('s1_stationary', '固定燃燒', 'ghg.s1.stationary'), F('s1_mobile', '移動燃燒', 'ghg.s1.mobile'),
      F('s1_refrigerant', '冷媒逸散', 'ghg.s1.refrigerant'), F('s1_insulating', '絕緣氣體逸散', 'ghg.s1.insulating', { required: 0 }),
      F('s1_process', '醫療／工業氣體', 'ghg.s1.process', { required: 0 }), F('s1_septic', '化糞池甲烷', 'ghg.s1.septic', { required: 0 }),
      F('s1_total', '範疇一合計', 'ghg.s1.total')] },
    { id: 's2', title: '範疇二 輸入能源間接排放', fields: [F('s2_elec', '外購電力', 'ghg.s2.electricity'), F('elec_kwh', '外購電力用電量', 'energy.elec_kwh')] },
    { id: 'tot', title: '總量與強度', fields: [F('total', '排放總量', 'ghg.total'), F('int_bed', '每床排放強度', 'ghg.intensity_bed', { required: 0 }), F('int_m2', '單位面積排放強度', 'ghg.intensity_m2', { required: 0 })] },
    { id: 'q', title: '資料品質與佐證', fields: [{ field_id: 'quality', label: '資料品質摘要', source_kind: 'quality' }, { field_id: 'evidence', label: '佐證清單', source_kind: 'evidence_list' }] },
  ], { applicability: { note: '是否為應盤查登錄對象，依環境部公告及院方實際排放量判斷' } }),
  // GRI：2026-12-31 前發布用舊版（302/303/305），2027-01-01 起用新版（103/303/102）
  T('ESG-ENV', 'ESG 永續報告書環境面', 'GRI Standards', 'GRI 302:2016／303:2018／305:2016', [
    { id: 'energy', title: 'GRI 302 能源', fields: [F('302-1_total', '302-1 組織內部能源消耗（GJ）', 'energy.total_gj'), F('302-1_elec', '外購電力（kWh）', 'energy.elec_kwh'),
      F('302-1_renew', '再生能源自發自用（kWh）', 'energy.pv_self_kwh', { required: 0 }), F('302-3', '302-3 能源強度（kWh/m²）', 'energy.eui_kwh_m2', { required: 0 })] },
    { id: 'water', title: 'GRI 303 水與放流水', fields: [F('303-3', '303-3 取水量（m³）', 'water.withdrawal_m3'), F('303-4', '303-4 排水量（m³）', 'water.discharge_m3', { required: 0 }), F('303-5', '303-5 耗水量（m³）', 'water.consumption_m3', { required: 0 })] },
    { id: 'emis', title: 'GRI 305 排放', fields: [F('305-1', '305-1 範疇一（tCO₂e）', 'ghg.s1.total'), F('305-2', '305-2 範疇二（tCO₂e）', 'ghg.s2.electricity'), F('305-4', '305-4 排放強度（tCO₂e/床）', 'ghg.intensity_bed', { required: 0 })] },
    { id: 'text', title: '管理方針（文字段落）', fields: [{ field_id: 'narrative', label: '管理方針與績效說明', source_kind: 'manual', data_type: 'text', required: 0 }] },
  ], { applies_from: '1900-01-01', applies_to: '2026-12-31' }),
  T('ESG-ENV', 'ESG 永續報告書環境面', 'GRI Standards', 'GRI 103:2025／303:2018／102:2025', [
    { id: 'energy', title: 'GRI 103 能源 2025', fields: [F('103-energy_total', '能源消耗總量（GJ）', 'energy.total_gj'), F('103-elec', '外購電力（kWh）', 'energy.elec_kwh'),
      F('103-renew', '再生能源自發自用（kWh）', 'energy.pv_self_kwh', { required: 0 }), F('103-intensity', '能源強度（kWh/m²）', 'energy.eui_kwh_m2', { required: 0 })] },
    { id: 'water', title: 'GRI 303 水與放流水', fields: [F('303-3', '303-3 取水量（m³）', 'water.withdrawal_m3'), F('303-4', '303-4 排水量（m³）', 'water.discharge_m3', { required: 0 }), F('303-5', '303-5 耗水量（m³）', 'water.consumption_m3', { required: 0 })] },
    { id: 'climate', title: 'GRI 102 氣候變遷 2025', fields: [F('102-s1', '範疇一（tCO₂e）', 'ghg.s1.total'), F('102-s2', '範疇二（tCO₂e）', 'ghg.s2.electricity'), F('102-intensity', '排放強度（tCO₂e/床）', 'ghg.intensity_bed', { required: 0 })] },
    { id: 'text', title: '管理方針（文字段落）', fields: [{ field_id: 'narrative', label: '管理方針與績效說明', source_kind: 'manual', data_type: 'text', required: 0 }] },
  ], { applies_from: '2027-01-01', applies_to: null, version: 2 }),
  T('ISO50001', 'ISO 50001 能源管理績效', 'ISO 50001', 'ISO 50001:2018', [
    { id: 'enpi', title: '能源績效指標（EnPI）', fields: [F('total_gj', '能源使用總量（GJ）', 'energy.total_gj'), F('eui', '單位面積用電（kWh/m²）', 'energy.eui_kwh_m2'), F('per_bed', '每床用電（kWh/床）', 'energy.kwh_per_bed')] },
    { id: 'seu', title: '主要能源使用', fields: [F('elec', '外購電力（kWh）', 'energy.elec_kwh'), F('peak', '最高需量（kW）', 'energy.peak_kw', { required: 0 }), F('diesel', '柴油（L）', 'energy.diesel_l', { required: 0 }), F('ng', '天然氣（m³）', 'energy.ng_m3', { required: 0 })] },
    { id: 'base', title: '基線比較', fields: [{ field_id: 'baseline_note', label: '基線年與改善專案說明', source_kind: 'manual', data_type: 'text', required: 0 }] },
  ]),
  T('ENERGY-USER', '能源用戶申報資料準備（經濟部能源署）', '能源管理法第 9 條／能源用戶應申報使用能源之種類…（附表三）', '115-01-23 修正', [
    { id: 'use', title: '能源使用量', fields: [F('elec', '電力（度）', 'energy.elec_kwh'), F('fuel_oil', '燃料油（公升）', 'energy.fuel_oil_l', { required: 0 }), F('lpg', '液化石油氣（公斤）', 'energy.lpg_kg', { required: 0 }),
      F('ng', '天然氣（立方公尺）', 'energy.ng_m3', { required: 0 }), F('gasoline', '汽油（公升）', 'energy.gasoline_l', { required: 0 }), F('diesel', '柴油（公升）', 'energy.diesel_l', { required: 0 }), F('toe', '合計（公噸油當量）', 'energy.total_toe')] },
    { id: 'eui', title: '能源使用效率', fields: [F('eui', 'EUI（kWh/m²）', 'energy.eui_kwh_m2')] },
  ], { applicability: { note: '契約容量 800 瓩以上之能源用戶；詳細表格仍以「申報與報告」附表三匯出為準' } }),
  T('GOV-SAVING', '政府機關及學校節約能源填報資料準備', '經濟部能源署「政府機關及學校用電效率管理計畫」', '依當年度填報系統', [
    { id: 'use', title: '用電用油用水', fields: [F('elec', '用電量（度）', 'energy.elec_kwh'), F('eui', 'EUI（度/m²）', 'energy.eui_kwh_m2'), F('gasoline', '公務車汽油（公升）', 'energy.gasoline_l', { required: 0 }),
      F('diesel', '柴油（公升）', 'energy.diesel_l', { required: 0 }), F('water', '用水量（度）', 'water.withdrawal_m3')] },
  ], { applicability: { note: '與能源用戶申報是不同制度；適用對象依機關屬性確認' } }),
  T('HOSP-OPS', '醫院營運資料報告', '院內自訂', 'v1', [
    { id: 'cost', title: '水電燃料費', fields: [F('elec_cost', '電費', 'energy.elec_cost'), F('water_cost', '水費', 'water.cost'), F('fuel_cost', '燃料費', 'energy.fuel_cost', { required: 0 })] },
    { id: 'resil', title: '備援韌性', fields: [F('gen_test', '發電機試機時數', 'gen.runtime_test_h', { required: 0 }), F('gen_outage', '斷電運轉時數', 'gen.runtime_outage_h', { required: 0 }),
      F('gen_drill', '演練時數', 'gen.runtime_drill_h', { required: 0 }), F('diesel_stock', '期末柴油存量（L）', 'gen.diesel_stock_l', { required: 0 })] },
    { id: 'improve', title: '設備改善', fields: [{ field_id: 'improve_note', label: '設備改善說明', source_kind: 'manual', data_type: 'text', required: 0 }] },
  ]),
  T('GHG-EVIDENCE', '溫室氣體盤查佐證清單與查核追蹤表', 'ISO 14064-1 第 8 章／查驗作業', 'v1', [
    { id: 'ev', title: '佐證清單', fields: [{ field_id: 'evidence', label: '佐證清單', source_kind: 'evidence_list' }] },
    { id: 'q', title: '資料品質摘要', fields: [{ field_id: 'quality', label: '資料品質', source_kind: 'quality' }] },
    { id: 'track', title: '查核追蹤', fields: [{ field_id: 'track_note', label: '查核意見與改善追蹤', source_kind: 'manual', data_type: 'text', required: 0 }] },
  ]),
];
