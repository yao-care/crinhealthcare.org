// 資料字典種子：單位、指標、盤點項目（PRD §4 四大面向＋營運活動分母＋保留參照）。
// 只在資料表為空或項目不存在時寫入；之後一律由管理後台維護（有版本）。

export const DOMAINS = {
  oil: { name: '油', icon: '🛢' },
  water: { name: '水', icon: '💧' },
  electricity: { name: '電', icon: '⚡' },
  gas: { name: '氣', icon: '🧪' },
  activity: { name: '營運活動', icon: '🏥' },
  reference: { name: '其他盤查參照', icon: '📎' },
};

// [code, 名稱, 維度, 基準單位, 換算到基準的倍率]
export const UNITS = [
  ['kWh', '度（kWh）', 'energy_e', 'kWh', 1], ['MWh', 'MWh', 'energy_e', 'kWh', 1000],
  ['kW', 'kW', 'power', 'kW', 1], ['MW', 'MW', 'power', 'kW', 1000],
  ['L', '公升', 'volume', 'L', 1], ['kL', '公秉', 'volume', 'L', 1000],
  ['m3', '立方公尺（度）', 'volume_w', 'm3', 1], ['ML', '百萬公升', 'volume_w', 'm3', 1000],
  ['Nm3', '立方公尺（氣體）', 'volume_g', 'Nm3', 1],
  ['kg', '公斤', 'mass', 'kg', 1], ['t', '公噸', 'mass', 'kg', 1000], ['g', '公克', 'mass', 'kg', 0.001],
  ['TWD', '新臺幣元', 'currency', 'TWD', 1], ['kTWD', '千元', 'currency', 'TWD', 1000],
  ['h', '小時', 'time', 'h', 1], ['km', '公里', 'distance', 'km', 1],
  ['pct', '%', 'ratio', 'pct', 1], ['count', '個／次', 'count', 'count', 1], ['cylinder', '瓶', 'count_cyl', 'cylinder', 1],
  ['person', '人', 'people', 'person', 1], ['person_h', '人時', 'people_time', 'person_h', 1], ['person_day', '人日', 'people_day', 'person_day', 1],
  ['visit', '人次', 'visits', 'visit', 1], ['bed', '床', 'beds', 'bed', 1], ['bed_day', '床日', 'bed_days', 'bed_day', 1],
  ['m2', '平方公尺', 'area', 'm2', 1], ['ping', '坪', 'area', 'm2', 3.305785],
  ['kcal', '千卡', 'heat', 'kcal', 1], ['MJ', 'MJ', 'heat', 'kcal', 238.8459], ['GJ', 'GJ', 'heat', 'kcal', 238845.9],
  ['kgCO2e', '公斤 CO₂e', 'ghg', 'kgCO2e', 1], ['tCO2e', '公噸 CO₂e', 'ghg', 'kgCO2e', 1000],
  ['toe', '公噸油當量', 'toe', 'toe', 1], ['kgoe', '公斤油當量', 'toe', 'toe', 0.001],
  ['mg_L', 'mg/L', 'concentration', 'mg_L', 1],
];

// [code, domain, 名稱, 語意, 值型態, 標準單位, 說明]
// 語意分開存：購買、領用、消耗、庫存、費用不可互相取代（PRD §4.1）；取水、排水、耗水分開（§4.2）
export const METRICS = [
  // 電
  ['elec_purchased_kwh', 'electricity', '外購電力用電量', 'usage', 'interval', 'kWh', '台電帳單計費度數（含尖離峰合計）'],
  ['elec_meter_reading_kwh', 'electricity', '電表累積讀值', 'reading', 'cumulative', 'kWh', '累積讀值，系統計算差分；換表、歸零、倍率另記'],
  ['elec_metered_kwh', 'electricity', '表計用電量', 'usage', 'interval', 'kWh', 'EMS／智慧電表／分表區間用電'],
  ['elec_cost_twd', 'electricity', '電費', 'cost', 'interval', 'TWD', '帳單應繳總額'],
  ['elec_peak_demand_kw', 'electricity', '最高需量', 'demand', 'interval', 'kW', '計費期間最高需量'],
  ['elec_contract_kw', 'electricity', '經常契約容量', 'capacity', 'stock', 'kW', ''],
  ['elec_generated_kwh', 'electricity', '自發電量', 'generation', 'interval', 'kWh', '太陽能等院內發電系統總發電'],
  ['elec_self_used_kwh', 'electricity', '自發自用電量', 'self_use', 'interval', 'kWh', ''],
  ['elec_exported_kwh', 'electricity', '售電／輸出電量', 'export', 'interval', 'kWh', '躉售或轉供，不可再計入自用'],
  ['elec_rec_kwh', 'electricity', '再生能源憑證電量', 'certificate', 'interval', 'kWh', '憑證認列另依條件，不因名稱為綠電自動扣減'],
  ['ess_charge_kwh', 'electricity', '儲能充電量', 'ess_charge', 'interval', 'kWh', '充電與放電不可互抵成組織用電'],
  ['ess_discharge_kwh', 'electricity', '儲能放電量', 'ess_discharge', 'interval', 'kWh', ''],
  ['ess_soc_pct', 'electricity', '儲能電量（SOC）', 'state', 'stock', 'pct', ''],
  ['ess_charge_total_kwh', 'electricity', '儲能累積充電讀值', 'reading', 'cumulative', 'kWh', 'PCS 累積充電量，系統差分成區間充電量'],
  ['ess_discharge_total_kwh', 'electricity', '儲能累積放電讀值', 'reading', 'cumulative', 'kWh', ''],
  ['equip_runtime_h', 'electricity', '設備運轉時數', 'runtime', 'interval', 'h', ''],
  ['equip_rated_kw', 'electricity', '設備額定功率', 'capacity', 'stock', 'kW', '設備特徵，不是用電量'],
  ['equip_estimated_kwh', 'electricity', '設備推估用電', 'estimate', 'estimate', 'kWh', '功率×時數推估，品質等級低於表計'],
  // 油
  ['oil_purchase_l', 'oil', '燃油採購／入庫量', 'purchase', 'transaction', 'L', '採購量不等於消耗量'],
  ['oil_issue_l', 'oil', '燃油領用量', 'issue', 'transaction', 'L', ''],
  ['oil_consumption_l', 'oil', '燃油消耗量', 'consumption', 'interval', 'L', '加油量視為消耗（公務車）或依存量平衡推算（儲槽）'],
  ['oil_stock_l', 'oil', '儲槽存量', 'stock', 'stock', 'L', '期初＋入庫－期末－其他用途＝消耗'],
  ['oil_other_use_l', 'oil', '其他用途領出', 'other_use', 'transaction', 'L', ''],
  ['oil_cost_twd', 'oil', '燃油費用', 'cost', 'interval', 'TWD', ''],
  ['vehicle_odometer_km', 'oil', '里程表讀值', 'reading', 'cumulative', 'km', ''],
  ['gen_test_runtime_h', 'oil', '發電機試機運轉時數', 'runtime_test', 'interval', 'h', '試機'],
  ['gen_outage_runtime_h', 'oil', '發電機斷電運轉時數', 'runtime_outage', 'interval', 'h', '真實斷電'],
  ['gen_drill_runtime_h', 'oil', '發電機演練運轉時數', 'runtime_drill', 'interval', 'h', '演練'],
  ['lubricant_use_kg', 'oil', '潤滑油／噴霧產品使用量', 'consumption', 'interval', 'kg', '是否屬排放活動依 SDS 成分判斷'],
  // 水
  ['water_withdrawal_m3', 'water', '取水量', 'withdrawal', 'interval', 'm3', '自來水帳單、地下水取水量（不是耗水量）'],
  ['water_meter_reading_m3', 'water', '水表累積讀值', 'reading', 'cumulative', 'm3', '循環讀值、換表、回零另記'],
  ['water_metered_m3', 'water', '分表用水量', 'usage', 'interval', 'm3', '建物／科室分表'],
  ['water_cost_twd', 'water', '水費', 'cost', 'interval', 'TWD', ''],
  ['water_discharge_m3', 'water', '排水量', 'discharge', 'interval', 'm3', ''],
  ['water_consumption_m3', 'water', '耗水量', 'consumption', 'interval', 'm3', '取水－排水－其他，須說明口徑'],
  ['water_recycled_m3', 'water', '回收水量', 'recycled', 'interval', 'm3', '不可列為新取水量'],
  ['water_reused_m3', 'water', '再利用水量', 'reused', 'interval', 'm3', ''],
  ['wastewater_treated_m3', 'water', '污水處理量', 'treated', 'interval', 'm3', ''],
  ['effluent_bod_mg_l', 'water', '放流水 BOD', 'quality', 'stock', 'mg_L', ''],
  // 氣
  ['ng_consumption_m3', 'gas', '天然氣用量', 'consumption', 'interval', 'Nm3', '帳單用量'],
  ['ng_meter_reading_m3', 'gas', '氣表累積讀值', 'reading', 'cumulative', 'Nm3', ''],
  ['ng_cost_twd', 'gas', '天然氣費用', 'cost', 'interval', 'TWD', ''],
  ['ng_heat_kcal_m3', 'gas', '天然氣熱值', 'heat_value', 'stock', 'kcal', '每立方公尺千卡（帳單有載明時）'],
  ['lpg_purchase_kg', 'gas', 'LPG 採購量', 'purchase', 'transaction', 'kg', ''],
  ['lpg_consumption_kg', 'gas', 'LPG 使用量', 'consumption', 'interval', 'kg', ''],
  ['lpg_stock_kg', 'gas', 'LPG 庫存量', 'stock', 'stock', 'kg', ''],
  ['lpg_cylinders', 'gas', 'LPG 鋼瓶數', 'count', 'transaction', 'cylinder', ''],
  ['lpg_cost_twd', 'gas', 'LPG 費用', 'cost', 'interval', 'TWD', ''],
  ['ref_charge_kg', 'gas', '冷媒原始充填量（銘牌）', 'nameplate', 'stock', 'kg', '設備特徵，不等於年度逸散量'],
  ['ref_recharge_kg', 'gas', '冷媒補充量', 'recharge', 'transaction', 'kg', '維修補充，逸散量的主要依據'],
  ['ref_recovered_kg', 'gas', '冷媒回收量', 'recovered', 'transaction', 'kg', '汰換或維修回收'],
  ['insul_gas_charge_kg', 'gas', '絕緣氣體充填量（SF₆ 等）', 'nameplate', 'stock', 'kg', '僅 GCB 等氣體絕緣設備；ACB／VCB 不適用'],
  ['insul_gas_recharge_kg', 'gas', '絕緣氣體補充量', 'recharge', 'transaction', 'kg', ''],
  ['co2_purchase_kg', 'gas', 'CO₂ 鋼瓶採購量', 'purchase', 'transaction', 'kg', ''],
  ['co2_use_kg', 'gas', 'CO₂ 使用量', 'consumption', 'interval', 'kg', ''],
  ['n2o_purchase_kg', 'gas', 'N₂O 採購量', 'purchase', 'transaction', 'kg', '採購量不等於排放量'],
  ['n2o_use_kg', 'gas', 'N₂O 使用量', 'consumption', 'interval', 'kg', ''],
  ['o2_purchase_m3', 'gas', '醫用氧氣採購量', 'purchase', 'transaction', 'Nm3', '非溫室氣體，只做供應管理'],
  ['fire_ext_charge_kg', 'gas', '滅火器藥劑量', 'nameplate', 'stock', 'kg', 'CO₂、潔淨型（HFC）滅火器'],
  ['fire_ext_refill_kg', 'gas', '滅火器換藥／使用量', 'recharge', 'transaction', 'kg', ''],
  // 營運活動（分母、化糞池）
  ['staff_count', 'activity', '員工人數（年底）', 'count', 'stock', 'person', '含全職與兼職，統計至 12/31'],
  ['staff_hours', 'activity', '員工工時', 'hours', 'interval', 'person_h', ''],
  ['outpatient_visits', 'activity', '門急診人次', 'visits', 'interval', 'visit', ''],
  ['inpatient_days', 'activity', '住院人日', 'bed_days', 'interval', 'bed_day', ''],
  ['beds', 'activity', '病床數', 'capacity', 'stock', 'bed', ''],
  ['floor_area_m2', 'activity', '樓地板面積', 'area', 'stock', 'm2', ''],
];

// 盤點項目：PRD §4.1–4.4 的子項，加上原碳盤查表拆出來的項目
const I = (code, domain, subtype, name, o = {}) => ({ code, domain, subtype, name, ...o });
export const ITEMS = [
  // 油
  I('OIL-VEH', 'oil', 'vehicle_fuel', '公務車汽柴油', {
    asset_types: ['vehicle', 'fuel_card'], metrics: ['oil_consumption_l', 'oil_cost_twd', 'vehicle_odometer_km'],
    required_data: ['加油日期', '油種', '公升數', '費用', '里程', '油單／發票'], source_hints: ['油卡紀錄', '加油發票', '派車單', '行照'],
    expected_frequency: 'monthly', special_rules: ['油卡紀錄與發票比對', '里程與油耗合理性'],
    usage_candidates: ['燃料管理', '溫室氣體盤查（範疇一 移動燃燒）', 'ESG', '車隊汰換'], ghg_ref: { scope: 1, iso: '類別一', type: 'mobile_combustion' } }),
  I('OIL-FORK', 'oil', 'machinery_fuel', '堆高機等機具用油', {
    asset_types: ['forklift', 'machinery'], metrics: ['oil_consumption_l', 'oil_cost_twd'],
    required_data: ['用油使用記錄表'], source_hints: ['用油紀錄表', '採購單'], ghg_ref: { scope: 1, iso: '類別一', type: 'mobile_combustion' } }),
  I('OIL-GEN', 'oil', 'generator_diesel', '緊急發電機柴油', {
    asset_types: ['generator', 'fuel_tank'], metrics: ['oil_stock_l', 'oil_purchase_l', 'oil_issue_l', 'oil_consumption_l', 'oil_other_use_l', 'gen_test_runtime_h', 'gen_outage_runtime_h', 'gen_drill_runtime_h'],
    required_data: ['設備位置', '發電機銘牌', '儲槽存量', '採購入庫', '領用', '試機與運轉時數'],
    source_hints: ['柴油使用紀錄', '油槽量測紀錄', '採購契約', '保養廠商維護紀錄', '試機紀錄'],
    special_rules: ['多台共用油槽時不可把同一槽補油量分別算給每台', '無獨立計量時以核准的存量平衡推估並標示品質等級', '試機、斷電、演練分開記錄'],
    usage_candidates: ['溫室氣體盤查（範疇一 固定燃燒）', '備援韌性', '燃料庫存'], ghg_ref: { scope: 1, iso: '類別一', type: 'stationary_combustion' } }),
  I('OIL-BOILER', 'oil', 'boiler_fuel', '鍋爐或機具燃油', {
    asset_types: ['boiler', 'fuel_tank', 'supply_contract'], metrics: ['oil_purchase_l', 'oil_stock_l', 'oil_consumption_l', 'oil_cost_twd'],
    required_data: ['油種', '採購', '補油', '存量', '流量'], source_hints: ['採購契約', '補油單', '流量計'], special_rules: ['採購量與實耗量分開'],
    ghg_ref: { scope: 1, iso: '類別一', type: 'stationary_combustion' } }),
  I('OIL-LUBE', 'oil', 'lubricant_spray', '潤滑油及噴霧產品（噴霧黃油、WD-40 等）', {
    asset_types: ['product'], metrics: ['lubricant_use_kg'], required_data: ['容量', '氣體種類', '數量', 'SDS'],
    source_hints: ['物質安全資料表（SDS）', '採購單', '領用紀錄'], special_rules: ['依 SDS 確認推進氣體是否為溫室氣體，不以名稱推定'],
    applicability_rules: '依 SDS 成分判斷', ghg_ref: { scope: 1, iso: '類別一', type: 'fugitive' } }),
  // 水
  I('WAT-TAP', 'water', 'tap_water', '自來水', {
    asset_types: ['water_account', 'water_meter', 'building'], metrics: ['water_withdrawal_m3', 'water_meter_reading_m3', 'water_cost_twd'],
    required_data: ['水費帳單', '度數（m³）', '計費起迄', '讀表值'], source_hints: ['自來水帳單', '總表抄表紀錄'],
    special_rules: ['帳單取水量不等於耗水量', '跨期帳單依規則分攤', '循環讀值、換表、回零、估抄另記'],
    usage_candidates: ['ESG 水資源（GRI 303）', '水足跡', '用水與成本管理', '電力、水上游排放（參照）'], ghg_ref: { scope: 3, iso: '類別四', type: 'upstream_water' } }),
  I('WAT-GROUND', 'water', 'groundwater', '地下水等其他水源', {
    asset_types: ['well', 'water_meter'], metrics: ['water_withdrawal_m3', 'water_meter_reading_m3'],
    required_data: ['取水量', '水權狀'], source_hints: ['取水量紀錄', '水權登記'] }),
  I('WAT-SUB', 'water', 'submeter', '建物／科室分表', {
    asset_types: ['water_meter'], metrics: ['water_metered_m3', 'water_meter_reading_m3'],
    required_data: ['分表讀值'], special_rules: ['總表－分表合計＝未分配／管損'] }),
  I('WAT-DIS', 'water', 'discharge', '污水與排水', {
    asset_types: ['outfall', 'wwtp'], metrics: ['water_discharge_m3', 'wastewater_treated_m3', 'effluent_bod_mg_l'],
    required_data: ['排水量', '處理方式', '檢測紀錄', '委外處理紀錄', '是否接管'], source_hints: ['污水處理單', '放流水檢測報告', '下水道接管證明'],
    special_rules: ['先確認是否自行處理或接管', '水量不等於排放量，排放另依方法量化'],
    ghg_ref: { scope: 3, iso: '類別四', type: 'wastewater' } }),
  I('WAT-RECY', 'water', 'recycled', '回收再利用水', {
    asset_types: ['recycling_system', 'water_meter'], metrics: ['water_recycled_m3', 'water_reused_m3'],
    special_rules: ['重複循環量不可列為新取水量'] }),
  I('WAT-SEPTIC', 'water', 'septic', '化糞池（逸散甲烷）', {
    asset_types: ['septic_tank'], metrics: [], required_data: ['年度員工人力工時', '就診病患人次', '住院病患人數／天數', '是否接管'],
    source_hints: ['人事室工時統計', '醫務管理統計'], special_rules: ['已接管公共污水下水道者不適用', '依方法以人數與工時計算，不以水量×任意係數'],
    applicability_rules: '確認院區用水是否接管', ghg_ref: { scope: 1, iso: '類別一', type: 'septic_ch4' } }),
  // 電
  I('ELE-GRID', 'electricity', 'grid', '外購電力', {
    asset_types: ['power_account', 'billing_point'], metrics: ['elec_purchased_kwh', 'elec_cost_twd', 'elec_peak_demand_kw', 'elec_contract_kw'],
    required_data: ['kWh', '費用', '契約容量', '計費期間', '帳單'], source_hints: ['台電電費帳單', 'EMS', '電費繳費紀錄'],
    special_rules: ['計費區間不一定是自然月，保存原期間並另存分攤值', '帳單與 EMS 先校準邊界再比較', '計費期間跨年前後都要收集'],
    usage_candidates: ['溫室氣體盤查（範疇二）', 'ESG', '能源用戶申報（附表三）', '成本管理'], ghg_ref: { scope: 2, iso: '類別二', type: 'purchased_electricity' } }),
  I('ELE-SUB', 'electricity', 'submeter', '院內分表', {
    asset_types: ['power_meter', 'substation', 'building'], metrics: ['elec_metered_kwh', 'elec_meter_reading_kwh', 'elec_peak_demand_kw'],
    special_rules: ['母表與子表層級，損失與未計量部分', '累積讀值差分處理換表、歸零、缺點與倍率'] }),
  I('ELE-PV', 'electricity', 'onsite_generation', '自發自用與售電（太陽能等）', {
    asset_types: ['pv_system', 'generation_meter'], metrics: ['elec_generated_kwh', 'elec_self_used_kwh', 'elec_exported_kwh', 'elec_rec_kwh'],
    special_rules: ['避免同筆電量重複認列', '憑證另依條件，不自行扣減排放量'] }),
  I('ELE-ESS', 'electricity', 'storage', '儲能系統', {
    asset_types: ['ess'], metrics: ['ess_charge_kwh', 'ess_discharge_kwh', 'ess_soc_pct'], source_hints: ['儲能櫃 Modbus', '充放電表'],
    special_rules: ['充電與放電不可逕行互抵成組織用電'] }),
  I('ELE-EQUIP', 'electricity', 'high_load', '高耗能設備（空調、冰機、資訊機房）', {
    asset_types: ['chiller', 'ahu', 'data_room', 'equipment'], metrics: ['equip_runtime_h', 'equip_rated_kw', 'equip_estimated_kwh', 'elec_metered_kwh'],
    usage_candidates: ['ISO 50001', '設備汰換', '節能診斷'] }),
  // 氣
  I('GAS-NG', 'gas', 'natural_gas', '天然氣（鍋爐、廚房爐具）', {
    asset_types: ['gas_account', 'gas_meter', 'boiler'], metrics: ['ng_consumption_m3', 'ng_meter_reading_m3', 'ng_cost_twd', 'ng_heat_kcal_m3'],
    required_data: ['用量', '費用', '計費期間', '熱值（如需）'], source_hints: ['天然氣帳單', '採購單', '氣表'],
    special_rules: ['帳單、表計、鍋爐運轉三方比對'], ghg_ref: { scope: 1, iso: '類別一', type: 'stationary_combustion' } }),
  I('GAS-LPG', 'gas', 'lpg', '液化石油氣（LPG）', {
    asset_types: ['lpg_cylinder', 'lpg_tank', 'supply_contract'], metrics: ['lpg_purchase_kg', 'lpg_consumption_kg', 'lpg_stock_kg', 'lpg_cylinders', 'lpg_cost_twd'],
    source_hints: ['採購單', '鋼瓶交付單'], special_rules: ['採購、領用、庫存分開'], ghg_ref: { scope: 1, iso: '類別一', type: 'stationary_combustion' } }),
  I('GAS-REF', 'gas', 'refrigerant', '冷媒（空調、冰水主機、飲水機、冷藏、乾燥機、公務車）', {
    asset_types: ['split_ac', 'window_ac', 'chiller', 'water_dispenser', 'refrigerator', 'dryer', 'vehicle_ac'],
    metrics: ['ref_charge_kg', 'ref_recharge_kg', 'ref_recovered_kg'],
    required_data: ['設備位置', '廠牌', '型號', '銘牌照片', '冷媒種類', '充填量', '補充／回收維修單'],
    source_hints: ['設備財產清冊', '維修保養紀錄', '銘牌照片'],
    special_rules: ['銘牌充填量是設備特徵，不等於年度逸散量', 'HCFC（如 R-22）屬蒙特婁議定書管制物質，不納入京都七種溫室氣體'],
    ghg_ref: { scope: 1, iso: '類別一', type: 'fugitive_refrigerant' } }),
  I('GAS-GCB', 'gas', 'insulating_gas', '高壓電器絕緣開關（GCB 氣體斷路器）', {
    asset_types: ['gcb'], metrics: ['insul_gas_charge_kg', 'insul_gas_recharge_kg'],
    required_data: ['型式（ACB／VCB／GCB）', '絕緣氣體', '補充／維修紀錄'],
    special_rules: ['ACB（空氣）、VCB（真空）不含 SF₆；只有 GCB 才需盤查'], applicability_rules: '先確認開關型式',
    ghg_ref: { scope: 1, iso: '類別一', type: 'fugitive_sf6' } }),
  I('GAS-MED', 'gas', 'medical_gas', '醫療／工業氣體（N₂O、CO₂ 瓶、氧氣）', {
    asset_types: ['gas_cylinder', 'gas_supply'], metrics: ['n2o_purchase_kg', 'n2o_use_kg', 'co2_purchase_kg', 'co2_use_kg', 'o2_purchase_m3'],
    source_hints: ['採購單', '氣體供應商出貨單', '領用紀錄'],
    special_rules: ['不得假定全部採購量都是排放量', '氧氣非溫室氣體，只列供應與風險管理'], ghg_ref: { scope: 1, iso: '類別一', type: 'process_gas' } }),
  I('GAS-FIRE', 'gas', 'fire_extinguisher', '消防設備（滅火器）', {
    asset_types: ['fire_extinguisher'], metrics: ['fire_ext_charge_kg', 'fire_ext_refill_kg'],
    required_data: ['類別（CO₂、ABC／KBC／BC 乾粉、潔淨型）', '數量清冊'], special_rules: ['乾粉滅火器不含溫室氣體'],
    ghg_ref: { scope: 1, iso: '類別一', type: 'fugitive' } }),
  I('GAS-WWT', 'gas', 'wastewater_gas', '污水處理相關氣體', {
    asset_types: ['wwtp'], metrics: ['wastewater_treated_m3'], special_rules: ['依處理方法判斷甲烷，非水量×任意係數'],
    ghg_ref: { scope: 1, iso: '類別一', type: 'wastewater_ch4' } }),
  // 營運活動
  I('ACT-STAFF', 'activity', 'staff', '員工人數與工時', { asset_types: ['org_activity'], metrics: ['staff_count', 'staff_hours'],
    required_data: ['年底員工人數（全職＋兼職，統計至 12/31）', '年度工時'], source_hints: ['人事室'] }),
  I('ACT-PATIENT', 'activity', 'patients', '就診與住院人次', { asset_types: ['org_activity'], metrics: ['outpatient_visits', 'inpatient_days'], source_hints: ['醫務管理'] }),
  I('ACT-CAP', 'activity', 'capacity', '病床與樓地板面積', { asset_types: ['org_activity'], metrics: ['beds', 'floor_area_m2'], source_hints: ['醫務管理', '總務室', '使用執照'] }),
];

// 原碳盤查表的非油水電氣項目：保留為參照（PRD §0、§19），不塞進四大類
export const REFERENCE_ITEMS = [
  ['REF-LAND', '土地使用變更'], ['REF-UPTRANS', '上游（材料）運輸'], ['REF-DOWNTRANS', '下游（產品）運輸'],
  ['REF-COMMUTE', '員工通勤'], ['REF-VISITOR', '客戶與訪客運輸'], ['REF-TRAVEL', '員工商務旅行'],
  ['REF-PURCHASE', '上游物料採購'], ['REF-CAPEX', '年度資本財購買'], ['REF-WASTE', '廢棄物處理'],
  ['REF-LEASED', '使用租賃的設備'], ['REF-SERVICE', '其他由使用服務產生之排放'],
  ['REF-PRODUSE', '使用產品階段'], ['REF-DOWNLEASE', '下游承租的資產'], ['REF-EOL', '產品生命終止階段'],
].map(([code, name]) => I(code, 'reference', 'ghg_reference', name, { applicability_rules: '非油水電氣主入口；是否量化依報告邊界決定' }));

// 原表活動來源文字 → 盤點項目（M14 匯入時用；比對用「包含」）
export const WORKBOOK_MAP = [
  ['公務車輛用油', ['OIL-VEH', 'GAS-REF']], ['公務車', ['OIL-VEH']], ['堆高機', ['OIL-FORK']], ['天然氣或LPG', ['GAS-NG', 'GAS-LPG']],
  ['空調設備', ['GAS-REF', 'ELE-EQUIP']], ['冰水主機', ['GAS-REF', 'ELE-EQUIP']], ['飲水機', ['GAS-REF']], ['冷藏設備', ['GAS-REF']],
  ['滅火器', ['GAS-FIRE']], ['緊急發電機', ['OIL-GEN']], ['化糞池', ['WAT-SEPTIC', 'ACT-STAFF', 'ACT-PATIENT']],
  ['噴霧式黃油', ['OIL-LUBE']], ['噴霧潤滑油', ['OIL-LUBE']], ['乾燥機', ['GAS-REF']], ['絕緣開關', ['GAS-GCB']], ['CO2 瓶', ['GAS-MED']],
  ['土地使用變更', ['REF-LAND']], ['外購電力', ['ELE-GRID']], ['上游(材料)運輸', ['REF-UPTRANS']], ['下游(產品)運輸', ['REF-DOWNTRANS']],
  ['員工通勤', ['REF-COMMUTE']], ['客戶與訪客', ['REF-VISITOR']], ['商務旅行', ['REF-TRAVEL']], ['上游物料採購', ['REF-PURCHASE']],
  ['電力、水上游', ['ELE-GRID', 'WAT-TAP']], ['資本財', ['REF-CAPEX']], ['廢棄物', ['REF-WASTE']], ['汙水處理', ['WAT-DIS', 'GAS-WWT']],
  ['租賃的設備', ['REF-LEASED']], ['使用服務產生', ['REF-SERVICE']], ['使用產品階段', ['REF-PRODUSE']], ['下游承租', ['REF-DOWNLEASE']],
  ['生命終止', ['REF-EOL']],
];

// 標的類型中文
export const ASSET_TYPES = {
  vehicle: '公務車', fuel_card: '油卡', forklift: '堆高機', machinery: '機具', generator: '緊急發電機', fuel_tank: '油槽',
  boiler: '鍋爐', supply_contract: '供應契約', product: '產品（SDS）', water_account: '水號', water_meter: '水表', building: '建物',
  well: '水井', outfall: '排放口', wwtp: '污水處理設施', recycling_system: '回收系統', septic_tank: '化糞池',
  power_account: '台電電號', billing_point: '計費點', power_meter: '電表', substation: '變電站', pv_system: '太陽能系統',
  generation_meter: '發電計量表', ess: '儲能櫃', chiller: '冰水主機', ahu: '空調箱', data_room: '資訊機房', equipment: '設備',
  gas_account: '瓦斯帳號', gas_meter: '氣表', lpg_cylinder: 'LPG 鋼瓶', lpg_tank: 'LPG 儲槽', split_ac: '分離式冷氣',
  window_ac: '窗型冷氣', water_dispenser: '飲水機', refrigerator: '冷藏設備', dryer: '乾燥機', vehicle_ac: '公務車冷氣',
  gcb: '氣體斷路器（GCB）', gas_cylinder: '氣體鋼瓶', gas_supply: '氣體供應', fire_extinguisher: '滅火器', org_activity: '院所營運活動',
};

// 資料工作進度（PRD §5.2）
export const WORK_STATUS = {
  to_register: '待建檔', finding_source: '找來源中', source_found: '已找到來源', collecting: '蒐集中', to_validate: '待驗證',
  discrepancy: '差異處理中', to_review: '待審核', approved: '已核准', locked: '已定版', returned: '退回補件', paused: '暫停／封存',
};
export const APPLICABILITY = { undetermined: '未判定', applicable: '適用', not_applicable: '不適用', pending: '待查證' };
export const USAGE_STATUS = { candidate: '候選用途', evaluated: '評估適用', mapped: '已對應欄位', cited: '已引用', published: '已出報告／已完成申報資料準備' };
