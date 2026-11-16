# 油水電氣資料治理平台｜資料字典

> 本檔由 `services/ems-admin/scripts/platform-dictionary.mjs` 從種子產生，請勿手改；正式值以管理後台的版本為準。

## 面向

| 代碼 | 名稱 |
| --- | --- |
| oil | 🛢 油 |
| water | 💧 水 |
| electricity | ⚡ 電 |
| gas | 🧪 氣 |
| activity | 🏥 營運活動 |
| reference | 📎 其他盤查參照 |

## 盤點項目

| 代碼 | 面向 | 名稱 | 標的類型 | 指標 | 需要的資料 | 常見來源 | 特殊規則 | 盤查參照 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OIL-VEH | 油 | 公務車汽柴油 | 公務車、油卡 | oil_consumption_l、oil_cost_twd、vehicle_odometer_km | 加油日期、油種、公升數、費用、里程、油單／發票 | 油卡紀錄、加油發票、派車單、行照 | 油卡紀錄與發票比對；里程與油耗合理性 | 範疇1／類別一／mobile_combustion |
| OIL-FORK | 油 | 堆高機等機具用油 | 堆高機、機具 | oil_consumption_l、oil_cost_twd | 用油使用記錄表 | 用油紀錄表、採購單 |  | 範疇1／類別一／mobile_combustion |
| OIL-GEN | 油 | 緊急發電機柴油 | 緊急發電機、油槽 | oil_stock_l、oil_purchase_l、oil_issue_l、oil_consumption_l、oil_other_use_l、gen_test_runtime_h、gen_outage_runtime_h、gen_drill_runtime_h | 設備位置、發電機銘牌、儲槽存量、採購入庫、領用、試機與運轉時數 | 柴油使用紀錄、油槽量測紀錄、採購契約、保養廠商維護紀錄、試機紀錄 | 多台共用油槽時不可把同一槽補油量分別算給每台；無獨立計量時以核准的存量平衡推估並標示品質等級；試機、斷電、演練分開記錄 | 範疇1／類別一／stationary_combustion |
| OIL-BOILER | 油 | 鍋爐或機具燃油 | 鍋爐、油槽、供應契約 | oil_purchase_l、oil_stock_l、oil_consumption_l、oil_cost_twd | 油種、採購、補油、存量、流量 | 採購契約、補油單、流量計 | 採購量與實耗量分開 | 範疇1／類別一／stationary_combustion |
| OIL-LUBE | 油 | 潤滑油及噴霧產品（噴霧黃油、WD-40 等） | 產品（SDS） | lubricant_use_kg | 容量、氣體種類、數量、SDS | 物質安全資料表（SDS）、採購單、領用紀錄 | 依 SDS 確認推進氣體是否為溫室氣體，不以名稱推定 | 範疇1／類別一／fugitive |
| WAT-TAP | 水 | 自來水 | 水號、水表、建物 | water_withdrawal_m3、water_meter_reading_m3、water_cost_twd | 水費帳單、度數（m³）、計費起迄、讀表值 | 自來水帳單、總表抄表紀錄 | 帳單取水量不等於耗水量；跨期帳單依規則分攤；循環讀值、換表、回零、估抄另記 | 範疇3／類別四／upstream_water |
| WAT-GROUND | 水 | 地下水等其他水源 | 水井、水表 | water_withdrawal_m3、water_meter_reading_m3 | 取水量、水權狀 | 取水量紀錄、水權登記 |  |  |
| WAT-SUB | 水 | 建物／科室分表 | 水表 | water_metered_m3、water_meter_reading_m3 | 分表讀值 |  | 總表－分表合計＝未分配／管損 |  |
| WAT-DIS | 水 | 污水與排水 | 排放口、污水處理設施 | water_discharge_m3、wastewater_treated_m3、effluent_bod_mg_l | 排水量、處理方式、檢測紀錄、委外處理紀錄、是否接管 | 污水處理單、放流水檢測報告、下水道接管證明 | 先確認是否自行處理或接管；水量不等於排放量，排放另依方法量化 | 範疇3／類別四／wastewater |
| WAT-RECY | 水 | 回收再利用水 | 回收系統、水表 | water_recycled_m3、water_reused_m3 |  |  | 重複循環量不可列為新取水量 |  |
| WAT-SEPTIC | 水 | 化糞池（逸散甲烷） | 化糞池 |  | 年度員工人力工時、就診病患人次、住院病患人數／天數、是否接管 | 人事室工時統計、醫務管理統計 | 已接管公共污水下水道者不適用；依方法以人數與工時計算，不以水量×任意係數 | 範疇1／類別一／septic_ch4 |
| ELE-GRID | 電 | 外購電力 | 台電電號、計費點 | elec_purchased_kwh、elec_cost_twd、elec_peak_demand_kw、elec_contract_kw、elec_peak_kwh、elec_semipeak_kwh、elec_satsemipeak_kwh、elec_offpeak_kwh、elec_demand_semipeak_kw、elec_demand_satsemipeak_kw、elec_demand_offpeak_kw、elec_wheeled_kwh、elec_power_factor_pct、elec_contract_semipeak_kw、elec_contract_satsemipeak_kw、elec_contract_offpeak_kw | kWh、費用、契約容量、計費期間、帳單 | 台電電費帳單、EMS、電費繳費紀錄 | 計費區間不一定是自然月，保存原期間並另存分攤值；帳單與 EMS 先校準邊界再比較；計費期間跨年前後都要收集 | 範疇2／類別二／purchased_electricity |
| ELE-SUB | 電 | 院內分表 | 分電盤、電表、變電站、建物 | elec_metered_kwh、elec_meter_reading_kwh、elec_peak_demand_kw、equip_estimated_kwh | 所屬電號（上層標的）、有無電表、主要負載系統 |  | 母表與子表層級，損失與未計量部分；累積讀值差分處理換表、歸零、缺點與倍率；沒有電表的分盤以額定功率 × 運轉時數推估，品質等級低於表計 |  |
| ELE-HEAT | 電 | 外購蒸汽、熱能、冷能 | 供應契約、設備 | imported_energy_gj | 供應量（GJ 或噸蒸汽換算）、供應商排放係數、帳單 | 蒸汽供應契約、區域供冷／供熱帳單 | 排放係數向供應商取得，沒有係數時不可估算為 0 | 範疇2／類別二／imported_heat |
| ELE-PV | 電 | 自發自用與售電（太陽能等） | 太陽能系統、發電計量表 | elec_generated_kwh、elec_self_used_kwh、elec_exported_kwh、elec_rec_kwh |  |  | 避免同筆電量重複認列；憑證另依條件，不自行扣減排放量 |  |
| ELE-ESS | 電 | 儲能系統 | 儲能櫃 | ess_charge_kwh、ess_discharge_kwh、ess_soc_pct |  | 儲能櫃 Modbus、充放電表 | 充電與放電不可逕行互抵成組織用電 |  |
| ELE-EQUIP | 電 | 高耗能設備（空調、冰機、資訊機房） | 冰水主機、冷卻水塔、泵浦、空調箱、送排風機、照明、電梯、熱泵、空壓機、冷凍冷藏設備、事務設備、資訊機房、設備 | equip_runtime_h、equip_rated_kw、equip_estimated_kwh、elec_metered_kwh、chiller_load_rth | 系統別、容量與單位、額定電功率、數量、年運轉時數、製造年份 |  |  |  |
| ELE-SYS | 電 | 變壓器與電能系統 | 變壓器、進相電容器、能源管理系統（EMS） |  | 廠牌、製造年份、容量（kVA）、型式（乾式／油式／非晶質式）、一次／二次側電壓、功因調整器、電容器 | 電氣設備清冊、變壓器銘牌、電力技術人員巡檢紀錄 |  |  |
| GAS-NG | 氣 | 天然氣（鍋爐、廚房爐具） | 瓦斯帳號、氣表、鍋爐 | ng_consumption_m3、ng_meter_reading_m3、ng_cost_twd、ng_heat_kcal_m3 | 用量、費用、計費期間、熱值（如需） | 天然氣帳單、採購單、氣表 | 帳單、表計、鍋爐運轉三方比對 | 範疇1／類別一／stationary_combustion |
| GAS-LPG | 氣 | 液化石油氣（LPG） | LPG 鋼瓶、LPG 儲槽、供應契約 | lpg_purchase_kg、lpg_consumption_kg、lpg_stock_kg、lpg_cylinders、lpg_cost_twd |  | 採購單、鋼瓶交付單 | 採購、領用、庫存分開 | 範疇1／類別一／stationary_combustion |
| GAS-REF | 氣 | 冷媒（空調、冰水主機、飲水機、冷藏、乾燥機、公務車） | 分離式冷氣、窗型冷氣、冰水主機、飲水機、冷藏設備、乾燥機、公務車冷氣 | ref_charge_kg、ref_recharge_kg、ref_recovered_kg | 設備位置、廠牌、型號、銘牌照片、冷媒種類、充填量、補充／回收維修單 | 設備財產清冊、維修保養紀錄、銘牌照片 | 銘牌充填量是設備特徵，不等於年度逸散量；HCFC（如 R-22）屬蒙特婁議定書管制物質，不納入京都七種溫室氣體 | 範疇1／類別一／fugitive_refrigerant |
| GAS-GCB | 氣 | 高壓電器絕緣開關（GCB 氣體斷路器） | 氣體斷路器（GCB） | insul_gas_charge_kg、insul_gas_recharge_kg | 型式（ACB／VCB／GCB）、絕緣氣體、補充／維修紀錄 |  | ACB（空氣）、VCB（真空）不含 SF₆；只有 GCB 才需盤查 | 範疇1／類別一／fugitive_sf6 |
| GAS-MED | 氣 | 醫療／工業氣體（N₂O、CO₂ 瓶、氧氣） | 氣體鋼瓶、氣體供應 | n2o_purchase_kg、n2o_use_kg、co2_purchase_kg、co2_use_kg、o2_purchase_m3 |  | 採購單、氣體供應商出貨單、領用紀錄 | 不得假定全部採購量都是排放量；氧氣非溫室氣體，只列供應與風險管理 | 範疇1／類別一／process_gas |
| GAS-FIRE | 氣 | 消防設備（滅火器） | 滅火器 | fire_ext_charge_kg、fire_ext_refill_kg | 類別（CO₂、ABC／KBC／BC 乾粉、潔淨型）、數量清冊 |  | 乾粉滅火器不含溫室氣體 | 範疇1／類別一／fugitive |
| GAS-WWT | 氣 | 污水處理相關氣體 | 污水處理設施 | wastewater_treated_m3 |  |  | 依處理方法判斷甲烷，非水量×任意係數 | 範疇1／類別一／wastewater_ch4 |
| ACT-STAFF | 營運活動 | 員工人數與工時 | 院所營運活動 | staff_count、staff_hours、medical_staff_count | 年底員工人數（全職＋兼職，統計至 12/31）、年度工時 | 人事室 |  |  |
| ACT-PATIENT | 營運活動 | 就診與住院人次 | 院所營運活動 | outpatient_visits、inpatient_days |  | 醫務管理 |  |  |
| ACT-CAP | 營運活動 | 病床與樓地板面積 | 院所營運活動 | beds、floor_area_m2、aircon_area_m2、parking_area_m2 |  | 醫務管理、總務室、使用執照 |  |  |
| ACT-WASTE | 營運活動 | 廢棄物產出量 | 院所營運活動 | waste_general_kg、waste_hazardous_kg、waste_recycled_kg | 一般事業廢棄物（公斤）、有害事業廢棄物含感染性（公斤）、資源回收量（公斤） | 事業廢棄物清運聯單、環境部事業廢棄物申報系統、委託清除處理契約 |  |  |
| REF-LAND | 其他盤查參照 | 土地使用變更 |  |  |  |  |  |  |
| REF-UPTRANS | 其他盤查參照 | 上游（材料）運輸 |  |  |  |  |  |  |
| REF-DOWNTRANS | 其他盤查參照 | 下游（產品）運輸 |  |  |  |  |  |  |
| REF-COMMUTE | 其他盤查參照 | 員工通勤 |  |  |  |  |  |  |
| REF-VISITOR | 其他盤查參照 | 客戶與訪客運輸 |  |  |  |  |  |  |
| REF-TRAVEL | 其他盤查參照 | 員工商務旅行 |  |  |  |  |  |  |
| REF-PURCHASE | 其他盤查參照 | 上游物料採購 |  |  |  |  |  |  |
| REF-CAPEX | 其他盤查參照 | 年度資本財購買 |  |  |  |  |  |  |
| REF-WASTE | 其他盤查參照 | 廢棄物處理 |  |  |  |  |  |  |
| REF-LEASED | 其他盤查參照 | 使用租賃的設備 |  |  |  |  |  |  |
| REF-SERVICE | 其他盤查參照 | 其他由使用服務產生之排放 |  |  |  |  |  |  |
| REF-PRODUSE | 其他盤查參照 | 使用產品階段 |  |  |  |  |  |  |
| REF-DOWNLEASE | 其他盤查參照 | 下游承租的資產 |  |  |  |  |  |  |
| REF-EOL | 其他盤查參照 | 產品生命終止階段 |  |  |  |  |  |  |

## 指標

| 代碼 | 面向 | 名稱 | 語意 | 值型態 | 標準單位 | 說明 |
| --- | --- | --- | --- | --- | --- | --- |
| elec_purchased_kwh | electricity | 外購電力用電量 | usage | interval | kWh | 台電帳單計費度數（含尖離峰合計） |
| elec_meter_reading_kwh | electricity | 電表累積讀值 | reading | cumulative | kWh | 累積讀值，系統計算差分；換表、歸零、倍率另記 |
| elec_metered_kwh | electricity | 表計用電量 | usage | interval | kWh | EMS／智慧電表／分表區間用電 |
| elec_cost_twd | electricity | 電費 | cost | interval | TWD | 帳單應繳總額 |
| elec_peak_demand_kw | electricity | 最高需量 | demand | interval | kW | 計費期間最高需量 |
| elec_contract_kw | electricity | 經常契約容量 | capacity | stock | kW |  |
| elec_peak_kwh | electricity | 尖峰度數 | usage_tou | interval | kWh | 帳單時段度數；夏月／非夏月依帳單 |
| elec_semipeak_kwh | electricity | 半尖峰度數 | usage_tou | interval | kWh |  |
| elec_satsemipeak_kwh | electricity | 週六半尖峰度數 | usage_tou | interval | kWh |  |
| elec_offpeak_kwh | electricity | 離峰度數 | usage_tou | interval | kWh |  |
| elec_demand_semipeak_kw | electricity | 半尖峰最高需量 | demand | interval | kW | 「最高需量」欄為尖峰時段 |
| elec_demand_satsemipeak_kw | electricity | 週六半尖峰最高需量 | demand | interval | kW |  |
| elec_demand_offpeak_kw | electricity | 離峰最高需量 | demand | interval | kW |  |
| elec_wheeled_kwh | electricity | 轉供度數 | wheeled | interval | kWh | 購買再生能源經台電電網轉供之用電量（帳單載明） |
| elec_power_factor_pct | electricity | 功率因數 | power_factor | interval | pct | 帳單平均功因 |
| elec_contract_semipeak_kw | electricity | 半尖峰契約容量 | capacity | stock | kW |  |
| elec_contract_satsemipeak_kw | electricity | 週六半尖峰契約容量 | capacity | stock | kW |  |
| elec_contract_offpeak_kw | electricity | 離峰契約容量 | capacity | stock | kW |  |
| elec_generated_kwh | electricity | 自發電量 | generation | interval | kWh | 太陽能等院內發電系統總發電 |
| elec_self_used_kwh | electricity | 自發自用電量 | self_use | interval | kWh |  |
| elec_exported_kwh | electricity | 售電／輸出電量 | export | interval | kWh | 躉售或轉供，不可再計入自用 |
| elec_rec_kwh | electricity | 再生能源憑證電量 | certificate | interval | kWh | 憑證認列另依條件，不因名稱為綠電自動扣減 |
| imported_energy_gj | electricity | 外購蒸汽／熱能／冷能 | usage | interval | GJ | 供應商帳單；類別二輸入能源 |
| ess_charge_kwh | electricity | 儲能充電量 | ess_charge | interval | kWh | 充電與放電不可互抵成組織用電 |
| ess_discharge_kwh | electricity | 儲能放電量 | ess_discharge | interval | kWh |  |
| ess_soc_pct | electricity | 儲能電量（SOC） | state | stock | pct |  |
| ess_charge_total_kwh | electricity | 儲能累積充電讀值 | reading | cumulative | kWh | PCS 累積充電量，系統差分成區間充電量 |
| ess_discharge_total_kwh | electricity | 儲能累積放電讀值 | reading | cumulative | kWh |  |
| equip_runtime_h | electricity | 設備運轉時數 | runtime | interval | h |  |
| equip_rated_kw | electricity | 設備額定功率 | capacity | stock | kW | 設備特徵，不是用電量 |
| equip_estimated_kwh | electricity | 設備推估用電 | estimate | estimate | kWh | 功率×時數推估，品質等級低於表計 |
| chiller_load_rth | electricity | 冰水主機總負荷 | load | interval | RTh | 冰水主機月總負荷（冷凍噸時）；效率＝耗電量 ÷ 總負荷 |
| oil_purchase_l | oil | 燃油採購／入庫量 | purchase | transaction | L | 採購量不等於消耗量 |
| oil_issue_l | oil | 燃油領用量 | issue | transaction | L |  |
| oil_consumption_l | oil | 燃油消耗量 | consumption | interval | L | 加油量視為消耗（公務車）或依存量平衡推算（儲槽） |
| oil_stock_l | oil | 儲槽存量 | stock | stock | L | 期初＋入庫－期末－其他用途＝消耗 |
| oil_other_use_l | oil | 其他用途領出 | other_use | transaction | L |  |
| oil_cost_twd | oil | 燃油費用 | cost | interval | TWD |  |
| vehicle_odometer_km | oil | 里程表讀值 | reading | cumulative | km |  |
| gen_test_runtime_h | oil | 發電機試機運轉時數 | runtime_test | interval | h | 試機 |
| gen_outage_runtime_h | oil | 發電機斷電運轉時數 | runtime_outage | interval | h | 真實斷電 |
| gen_drill_runtime_h | oil | 發電機演練運轉時數 | runtime_drill | interval | h | 演練 |
| lubricant_use_kg | oil | 潤滑油／噴霧產品使用量 | consumption | interval | kg | 是否屬排放活動依 SDS 成分判斷 |
| water_withdrawal_m3 | water | 取水量 | withdrawal | interval | m3 | 自來水帳單、地下水取水量（不是耗水量） |
| water_meter_reading_m3 | water | 水表累積讀值 | reading | cumulative | m3 | 循環讀值、換表、回零另記 |
| water_metered_m3 | water | 分表用水量 | usage | interval | m3 | 建物／科室分表 |
| water_cost_twd | water | 水費 | cost | interval | TWD |  |
| water_discharge_m3 | water | 排水量 | discharge | interval | m3 |  |
| water_consumption_m3 | water | 耗水量 | consumption | interval | m3 | 取水－排水－其他，須說明口徑 |
| water_recycled_m3 | water | 回收水量 | recycled | interval | m3 | 不可列為新取水量 |
| water_reused_m3 | water | 再利用水量 | reused | interval | m3 |  |
| wastewater_treated_m3 | water | 污水處理量 | treated | interval | m3 |  |
| effluent_bod_mg_l | water | 放流水 BOD | quality | stock | mg_L |  |
| ng_consumption_m3 | gas | 天然氣用量 | consumption | interval | Nm3 | 帳單用量 |
| ng_meter_reading_m3 | gas | 氣表累積讀值 | reading | cumulative | Nm3 |  |
| ng_cost_twd | gas | 天然氣費用 | cost | interval | TWD |  |
| ng_heat_kcal_m3 | gas | 天然氣熱值 | heat_value | stock | kcal | 每立方公尺千卡（帳單有載明時） |
| lpg_purchase_kg | gas | LPG 採購量 | purchase | transaction | kg |  |
| lpg_consumption_kg | gas | LPG 使用量 | consumption | interval | kg |  |
| lpg_stock_kg | gas | LPG 庫存量 | stock | stock | kg |  |
| lpg_cylinders | gas | LPG 鋼瓶數 | count | transaction | cylinder |  |
| lpg_cost_twd | gas | LPG 費用 | cost | interval | TWD |  |
| ref_charge_kg | gas | 冷媒原始充填量（銘牌） | nameplate | stock | kg | 設備特徵，不等於年度逸散量 |
| ref_recharge_kg | gas | 冷媒補充量 | recharge | transaction | kg | 維修補充，逸散量的主要依據 |
| ref_recovered_kg | gas | 冷媒回收量 | recovered | transaction | kg | 汰換或維修回收 |
| insul_gas_charge_kg | gas | 絕緣氣體充填量（SF₆ 等） | nameplate | stock | kg | 僅 GCB 等氣體絕緣設備；ACB／VCB 不適用 |
| insul_gas_recharge_kg | gas | 絕緣氣體補充量 | recharge | transaction | kg |  |
| co2_purchase_kg | gas | CO₂ 鋼瓶採購量 | purchase | transaction | kg |  |
| co2_use_kg | gas | CO₂ 使用量 | consumption | interval | kg |  |
| n2o_purchase_kg | gas | N₂O 採購量 | purchase | transaction | kg | 採購量不等於排放量 |
| n2o_use_kg | gas | N₂O 使用量 | consumption | interval | kg |  |
| o2_purchase_m3 | gas | 醫用氧氣採購量 | purchase | transaction | Nm3 | 非溫室氣體，只做供應管理 |
| fire_ext_charge_kg | gas | 滅火器藥劑量 | nameplate | stock | kg | CO₂、潔淨型（HFC）滅火器 |
| fire_ext_refill_kg | gas | 滅火器換藥／使用量 | recharge | transaction | kg |  |
| staff_count | activity | 員工人數（年底） | count | stock | person | 含全職與兼職，統計至 12/31 |
| staff_hours | activity | 員工工時 | hours | interval | person_h |  |
| outpatient_visits | activity | 門急診人次 | visits | interval | visit |  |
| inpatient_days | activity | 住院人日 | bed_days | interval | bed_day |  |
| beds | activity | 病床數 | capacity | stock | bed |  |
| floor_area_m2 | activity | 樓地板面積 | area | stock | m2 |  |
| aircon_area_m2 | activity | 空調使用面積 | area | stock | m2 | 能源查核申報基本資料 |
| parking_area_m2 | activity | 室內停車場面積 | area | stock | m2 | 室內樓地板面積＝總樓地板面積－室內停車場面積 |
| medical_staff_count | activity | 執業醫事人員數 | count | stock | person | 能源查核申報「員工人數」醫院填陳報衛福部之執業醫事人員總數 |
| waste_general_kg | activity | 一般事業廢棄物產出量 | waste | interval | kg | 清運聯單或委託清除處理紀錄 |
| waste_hazardous_kg | activity | 有害事業廢棄物產出量（含感染性） | waste | interval | kg |  |
| waste_recycled_kg | activity | 資源回收量 | waste | interval | kg |  |

## 單位

| 代碼 | 名稱 | 維度 | 基準單位 | 換算倍率 |
| --- | --- | --- | --- | --- |
| kWh | 度（kWh） | energy_e | kWh | 1 |
| MWh | MWh | energy_e | kWh | 1000 |
| kW | kW | power | kW | 1 |
| MW | MW | power | kW | 1000 |
| L | 公升 | volume | L | 1 |
| kL | 公秉 | volume | L | 1000 |
| m3 | 立方公尺（度） | volume_w | m3 | 1 |
| ML | 百萬公升 | volume_w | m3 | 1000 |
| Nm3 | 立方公尺（氣體） | volume_g | Nm3 | 1 |
| kg | 公斤 | mass | kg | 1 |
| t | 公噸 | mass | kg | 1000 |
| g | 公克 | mass | kg | 0.001 |
| TWD | 新臺幣元 | currency | TWD | 1 |
| kTWD | 千元 | currency | TWD | 1000 |
| h | 小時 | time | h | 1 |
| km | 公里 | distance | km | 1 |
| pct | % | ratio | pct | 1 |
| RTh | 冷凍噸時 | cooling_load | RTh | 1 |
| count | 個／次 | count | count | 1 |
| cylinder | 瓶 | count_cyl | cylinder | 1 |
| person | 人 | people | person | 1 |
| person_h | 人時 | people_time | person_h | 1 |
| person_day | 人日 | people_day | person_day | 1 |
| visit | 人次 | visits | visit | 1 |
| bed | 床 | beds | bed | 1 |
| bed_day | 床日 | bed_days | bed_day | 1 |
| m2 | 平方公尺 | area | m2 | 1 |
| ping | 坪 | area | m2 | 3.305785 |
| kcal | 千卡 | heat | kcal | 1 |
| MJ | MJ | heat | kcal | 238.8459 |
| GJ | GJ | heat | kcal | 238845.9 |
| kgCO2e | 公斤 CO₂e | ghg | kgCO2e | 1 |
| tCO2e | 公噸 CO₂e | ghg | kgCO2e | 1000 |
| toe | 公噸油當量 | toe | toe | 1 |
| kgoe | 公斤油當量 | toe | toe | 0.001 |
| mg_L | mg/L | concentration | mg_L | 1 |

## 標的類型

| 代碼 | 名稱 |
| --- | --- |
| vehicle | 公務車 |
| fuel_card | 油卡 |
| forklift | 堆高機 |
| machinery | 機具 |
| generator | 緊急發電機 |
| fuel_tank | 油槽 |
| boiler | 鍋爐 |
| supply_contract | 供應契約 |
| product | 產品（SDS） |
| water_account | 水號 |
| water_meter | 水表 |
| building | 建物 |
| well | 水井 |
| outfall | 排放口 |
| wwtp | 污水處理設施 |
| recycling_system | 回收系統 |
| septic_tank | 化糞池 |
| power_account | 台電電號 |
| billing_point | 計費點 |
| power_meter | 電表 |
| substation | 變電站 |
| pv_system | 太陽能系統 |
| generation_meter | 發電計量表 |
| ess | 儲能櫃 |
| chiller | 冰水主機 |
| ahu | 空調箱 |
| data_room | 資訊機房 |
| equipment | 設備 |
| gas_account | 瓦斯帳號 |
| gas_meter | 氣表 |
| lpg_cylinder | LPG 鋼瓶 |
| lpg_tank | LPG 儲槽 |
| split_ac | 分離式冷氣 |
| window_ac | 窗型冷氣 |
| water_dispenser | 飲水機 |
| refrigerator | 冷藏設備 |
| dryer | 乾燥機 |
| vehicle_ac | 公務車冷氣 |
| gcb | 氣體斷路器（GCB） |
| ems | 能源管理系統（EMS） |
| panel | 分電盤 |
| transformer | 變壓器 |
| capacitor | 進相電容器 |
| cooling_tower | 冷卻水塔 |
| pump | 泵浦 |
| fan | 送排風機 |
| lighting | 照明 |
| elevator | 電梯 |
| heat_pump | 熱泵 |
| air_compressor | 空壓機 |
| refrigeration | 冷凍冷藏設備 |
| office_equipment | 事務設備 |
| gas_cylinder | 氣體鋼瓶 |
| gas_supply | 氣體供應 |
| fire_extinguisher | 滅火器 |
| org_activity | 院所營運活動 |

## 狀態軸

**資料工作進度**：待建檔 → 找來源中 → 已找到來源 → 蒐集中 → 待驗證 → 差異處理中 → 待審核 → 已核准 → 已定版 → 退回補件 → 暫停／封存

**盤點適用性**：未判定／適用／不適用／待查證

**用途採用狀態**：候選用途 → 評估適用 → 已對應欄位 → 已引用 → 已出報告／已完成申報資料準備

## 計算規則（指標）

| 代碼 | 名稱 | 定義 | 說明 |
| --- | --- | --- | --- |
| ghg.s1.stationary | 範疇一 固定燃燒排放 | {"kind":"combustion","items":["OIL-GEN","OIL-BOILER","GAS-NG","GAS-LPG"],"mode":"stationary","unit":"tCO2e"} | 燃料消耗量 × 各氣體排放係數 × GWP |
| ghg.s1.mobile | 範疇一 移動燃燒排放 | {"kind":"combustion","items":["OIL-VEH","OIL-FORK"],"mode":"mobile","unit":"tCO2e"} |  |
| ghg.s1.refrigerant | 範疇一 冷媒逸散 | {"kind":"refrigerant","items":["GAS-REF","GAS-FIRE"],"unit":"tCO2e"} | 補充量 × GWP；只有銘牌、沒有補充紀錄時標示活動資料不足，不以銘牌推定 |
| ghg.s1.insulating | 範疇一 絕緣氣體逸散（SF₆） | {"kind":"insulating","items":["GAS-GCB"],"unit":"tCO2e"} |  |
| ghg.s1.process | 範疇一 醫療／工業氣體 | {"kind":"process_gas","items":["GAS-MED"],"unit":"tCO2e"} | N₂O、CO₂ 以使用量計；氧氣不計 |
| ghg.s1.septic | 範疇一 化糞池甲烷 | {"kind":"septic","items":["WAT-SEPTIC"],"unit":"tCO2e"} |  |
| ghg.s1.total | 範疇一 合計 | {"kind":"add","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s2.electricity | 範疇二 外購電力 | {"kind":"electricity_emission","items":["ELE-GRID"],"metric":"elec_purchased_kwh","unit":"tCO2e"} | 外購電力 × 當年度電力排放係數 |
| ghg.total | 溫室氣體排放總量（範疇一＋二） | {"kind":"add","of":["ghg.s1.total","ghg.s2.electricity"],"unit":"tCO2e"} |  |
| ghg.s2.imported_heat | 類別二 外購蒸汽／熱能／冷能 | {"kind":"simple_emission","items":["ELE-HEAT"],"metric":"imported_energy_gj","factorPrefix":"ef.imported_heat","unit":"tCO2e","uKind":"imported_heat"} | 供應量 × 供應商排放係數（係數須由後台新增並發布） |
| ghg.s2.total | 類別二 合計 | {"kind":"add","of":["ghg.s2.electricity","ghg.s2.imported_heat"],"unit":"tCO2e"} |  |
| ghg.total | 溫室氣體排放總量（類別一＋類別二） | {"kind":"add","of":["ghg.s1.total","ghg.s2.total"],"unit":"tCO2e"} |  |
| ghg.s1.gas.co2 | 類別一 CO₂ | {"kind":"gas_split","gas":"CO2","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.ch4 | 類別一 CH₄ | {"kind":"gas_split","gas":"CH4","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.n2o | 類別一 N₂O | {"kind":"gas_split","gas":"N2O","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.hfcs | 類別一 HFCs | {"kind":"gas_split","gas":"HFCs","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.pfcs | 類別一 PFCs | {"kind":"gas_split","gas":"PFCs","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.sf6 | 類別一 SF₆ | {"kind":"gas_split","gas":"SF6","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.s1.gas.nf3 | 類別一 NF₃ | {"kind":"gas_split","gas":"NF3","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic"],"unit":"tCO2e"} |  |
| ghg.biogenic_co2 | 生質 CO₂（另計，不納入總量） | {"kind":"biogenic","items":["OIL-GEN","OIL-BOILER","OIL-VEH","OIL-FORK","GAS-NG","GAS-LPG"],"unit":"tCO2e"} | 燃料含生質成分（標的專屬欄位 biogenicShare）時，生質部分的 CO₂ 另列 |
| ghg.cat3 | 類別三 間接排放（已量化之顯著項目） | {"kind":"significance","category":3,"unit":"tCO2e"} |  |
| ghg.cat4 | 類別四 間接排放（已量化之顯著項目） | {"kind":"significance","category":4,"unit":"tCO2e"} |  |
| ghg.cat5 | 類別五 間接排放（已量化之顯著項目） | {"kind":"significance","category":5,"unit":"tCO2e"} |  |
| ghg.cat6 | 類別六 間接排放（已量化之顯著項目） | {"kind":"significance","category":6,"unit":"tCO2e"} |  |
| ghg.indirect_3_6 | 類別三～六 合計 | {"kind":"add","of":["ghg.cat3","ghg.cat4","ghg.cat5","ghg.cat6"],"unit":"tCO2e"} |  |
| ghg.total_all | 溫室氣體排放總量（類別一～六已量化項目） | {"kind":"add","of":["ghg.total","ghg.indirect_3_6"],"unit":"tCO2e"} |  |
| ghg.uncertainty_pct | 盤查總不確定性（95% 信賴區間） | {"kind":"uncertainty","of":["ghg.s1.stationary","ghg.s1.mobile","ghg.s1.refrigerant","ghg.s1.insulating","ghg.s1.process","ghg.s1.septic","ghg.s2.electricity","ghg.s2.imported_heat"],"unit":"pct"} | 各排放源活動數據與係數不確定性以誤差傳遞法合成 |
| ghg.intensity_bed | 每床排放強度 | {"kind":"ratio","num":"ghg.total","den":"act.beds","unit":"tCO2e/bed","scale":1} |  |
| ghg.intensity_m2 | 單位面積排放強度 | {"kind":"ratio","num":"ghg.total","den":"act.floor_area_m2","unit":"kgCO2e/m2","scale":1000} |  |
| energy.elec_kwh | 外購電力 | {"kind":"sum","items":["ELE-GRID"],"metrics":["elec_purchased_kwh"],"unit":"kWh"} |  |
| energy.elec_cost | 電費 | {"kind":"sum","items":["ELE-GRID"],"metrics":["elec_cost_twd"],"unit":"TWD"} |  |
| energy.peak_kw | 最高需量 | {"kind":"sum","items":["ELE-GRID"],"metrics":["elec_peak_demand_kw"],"agg":"max","unit":"kW"} |  |
| energy.pv_kwh | 自發電量 | {"kind":"sum","items":["ELE-PV"],"metrics":["elec_generated_kwh"],"unit":"kWh"} |  |
| energy.pv_self_kwh | 自發自用電量 | {"kind":"sum","items":["ELE-PV"],"metrics":["elec_self_used_kwh"],"unit":"kWh"} |  |
| energy.diesel_l | 柴油用量 | {"kind":"sum","metrics":["oil_consumption_l"],"fuel":"diesel","unit":"L"} |  |
| energy.gasoline_l | 汽油用量 | {"kind":"sum","metrics":["oil_consumption_l"],"fuel":"gasoline","unit":"L"} |  |
| energy.fuel_oil_l | 燃料油用量 | {"kind":"sum","metrics":["oil_consumption_l"],"fuel":"fuel_oil","unit":"L"} |  |
| energy.ng_m3 | 天然氣用量 | {"kind":"sum","items":["GAS-NG"],"metrics":["ng_consumption_m3"],"unit":"Nm3"} |  |
| energy.lpg_kg | LPG 用量 | {"kind":"sum","items":["GAS-LPG"],"metrics":["lpg_consumption_kg"],"unit":"kg"} |  |
| energy.fuel_cost | 燃料費用 | {"kind":"sum","metrics":["oil_cost_twd","ng_cost_twd","lpg_cost_twd"],"unit":"TWD"} |  |
| energy.total_gj | 能源使用總量 | {"kind":"energy_total","unit":"GJ"} | 電力 3.6 MJ/kWh；燃料依熱值表 |
| energy.total_toe | 能源使用總量（公噸油當量） | {"kind":"energy_total","unit":"toe"} |  |
| energy.eui_kwh_m2 | 單位面積用電（EUI） | {"kind":"ratio","num":"energy.elec_kwh","den":"act.floor_area_m2","unit":"kWh/m2","scale":1} |  |
| energy.kwh_per_bed | 每床用電 | {"kind":"ratio","num":"energy.elec_kwh","den":"act.beds","unit":"kWh/bed","scale":1} |  |
| energy.renewable_share | 再生能源占比 | {"kind":"ratio","num":"energy.pv_self_kwh","den":"energy.elec_kwh","unit":"pct","scale":100} |  |
| water.withdrawal_m3 | 取水量 | {"kind":"sum","items":["WAT-TAP","WAT-GROUND"],"metrics":["water_withdrawal_m3"],"unit":"m3"} |  |
| water.tap_m3 | 自來水取水量 | {"kind":"sum","items":["WAT-TAP"],"metrics":["water_withdrawal_m3"],"unit":"m3"} |  |
| water.ground_m3 | 地下水取水量 | {"kind":"sum","items":["WAT-GROUND"],"metrics":["water_withdrawal_m3"],"unit":"m3"} |  |
| water.discharge_m3 | 排水量 | {"kind":"sum","items":["WAT-DIS"],"metrics":["water_discharge_m3"],"unit":"m3"} |  |
| water.consumption_m3 | 耗水量 | {"kind":"water_consumption","unit":"m3"} | 有直接耗水量用直接值；否則取水－排水，並註明口徑 |
| water.recycled_m3 | 回收再利用水量 | {"kind":"sum","items":["WAT-RECY"],"metrics":["water_reused_m3"],"unit":"m3"} |  |
| water.cost | 水費 | {"kind":"sum","metrics":["water_cost_twd"],"unit":"TWD"} |  |
| water.per_bed_day | 每床日用水 | {"kind":"ratio","num":"water.withdrawal_m3","den":"act.inpatient_days","unit":"L/bed_day","scale":1000} |  |
| gen.runtime_test_h | 發電機試機時數 | {"kind":"sum","items":["OIL-GEN"],"metrics":["gen_test_runtime_h"],"unit":"h"} |  |
| gen.runtime_outage_h | 發電機斷電運轉時數 | {"kind":"sum","items":["OIL-GEN"],"metrics":["gen_outage_runtime_h"],"unit":"h"} |  |
| gen.runtime_drill_h | 發電機演練時數 | {"kind":"sum","items":["OIL-GEN"],"metrics":["gen_drill_runtime_h"],"unit":"h"} |  |
| gen.diesel_stock_l | 期末柴油存量 | {"kind":"sum","items":["OIL-GEN"],"metrics":["oil_stock_l"],"agg":"latest_per_asset","unit":"L"} |  |
| gen.diesel_purchase_l | 柴油採購入庫 | {"kind":"sum","items":["OIL-GEN"],"metrics":["oil_purchase_l"],"unit":"L"} |  |
| act.floor_area_m2 | 樓地板面積 | {"kind":"sum","items":["ACT-CAP"],"metrics":["floor_area_m2"],"agg":"latest_per_asset","unit":"m2"} |  |
| act.beds | 病床數 | {"kind":"sum","items":["ACT-CAP"],"metrics":["beds"],"agg":"latest_per_asset","unit":"bed"} |  |
| act.staff_count | 年底員工人數 | {"kind":"sum","items":["ACT-STAFF"],"metrics":["staff_count"],"agg":"latest_per_asset","unit":"person"} |  |
| act.staff_hours | 員工工時 | {"kind":"sum","items":["ACT-STAFF"],"metrics":["staff_hours"],"unit":"person_h"} |  |
| act.outpatient | 門急診人次 | {"kind":"sum","items":["ACT-PATIENT"],"metrics":["outpatient_visits"],"unit":"visit"} |  |
| act.inpatient_days | 住院人日 | {"kind":"sum","items":["ACT-PATIENT"],"metrics":["inpatient_days"],"unit":"bed_day"} |  |
| act.aircon_area_m2 | 空調使用面積 | {"kind":"sum","items":["ACT-CAP"],"metrics":["aircon_area_m2"],"agg":"latest_per_asset","unit":"m2"} |  |
| act.parking_area_m2 | 室內停車場面積 | {"kind":"sum","items":["ACT-CAP"],"metrics":["parking_area_m2"],"agg":"latest_per_asset","unit":"m2"} |  |
| act.medical_staff | 執業醫事人員數 | {"kind":"sum","items":["ACT-STAFF"],"metrics":["medical_staff_count"],"agg":"latest_per_asset","unit":"person"} |  |
| waste.general_kg | 一般事業廢棄物產出量 | {"kind":"sum","items":["ACT-WASTE"],"metrics":["waste_general_kg"],"unit":"kg"} |  |
| waste.hazardous_kg | 有害事業廢棄物產出量（含感染性） | {"kind":"sum","items":["ACT-WASTE"],"metrics":["waste_hazardous_kg"],"unit":"kg"} |  |
| waste.recycled_kg | 資源回收量 | {"kind":"sum","items":["ACT-WASTE"],"metrics":["waste_recycled_kg"],"unit":"kg"} |  |
| energy.wheeled_kwh | 轉供度數（再生能源） | {"kind":"sum","items":["ELE-GRID"],"metrics":["elec_wheeled_kwh"],"unit":"kWh"} |  |
| energy.total_cost | 總能源費用（油電燃氣） | {"kind":"sum","metrics":["elec_cost_twd","oil_cost_twd","ng_cost_twd","lpg_cost_twd"],"unit":"TWD"} |  |

## 報告模板

| 代碼 | 版本 | 名稱 | 準則 | 版次 | 適用期間 | 欄位數 |
| --- | --- | --- | --- | --- | --- | --- |
| GHG-INV | 1 | 組織溫室氣體盤查 | ISO 14064-1／環境部盤查登錄及查驗管理辦法 | ISO 14064-1:2018 | ～ | 14 |
| GHG-INV | 2 | 組織溫室氣體盤查報告書 | ISO 14064-1／環境部盤查登錄及查驗管理辦法 | ISO 14064-1:2018 | ～ | 58 |
| ESG-ENV | 1 | ESG 永續報告書環境面 | GRI Standards | GRI 302:2016／303:2018／305:2016 | 1900-01-01～2026-12-31 | 11 |
| ESG-ENV | 2 | ESG 永續報告書環境面 | GRI Standards | GRI 103:2025／303:2018／102:2025 | 2027-01-01～ | 11 |
| ISO50001 | 1 | ISO 50001 能源管理績效 | ISO 50001 | ISO 50001:2018 | ～ | 8 |
| ENERGY-USER | 1 | 能源用戶申報資料準備（經濟部能源署） | 能源管理法第 9 條／能源用戶應申報使用能源之種類…（附表三） | 115-01-23 修正 | ～ | 8 |
| GOV-SAVING | 1 | 政府機關及學校節約能源填報資料準備 | 經濟部能源署「政府機關及學校用電效率管理計畫」 | 依當年度填報系統 | ～ | 5 |
| HOSP-OPS | 1 | 醫院營運資料報告 | 院內自訂 | v1 | ～ | 8 |
| GHG-EVIDENCE | 1 | 溫室氣體盤查佐證清單與查核追蹤表 | ISO 14064-1 第 8 章／查驗作業 | v1 | ～ | 3 |
| GHG-REGISTRY | 1 | 環境部盤查登錄匯入表單 | 環境部「事業溫室氣體排放量資訊平台」盤查系統用匯入表單 | 匯入表單 V5（代碼檔 V2） | ～ | 5 |
| GHG-FORM | 1 | 組織型溫室氣體盤查表單 | 環保署「溫室氣體盤查表單」（表一～表九） | 3.0.0 版（係數：6.0.4 版／113 年 2 月 5 日公告） | ～ | 14 |
| ENERGY-USER | 2 | 非生產性質行業能源查核申報資料準備 | 能源管理法第 9、12 條／能源查核制度申報表附表三（非生產性質行業） | 附表三（112-01-04 行政院公報版） | ～ | 17 |
| GOV-SAVING | 2 | 政府機關及學校節約能源填報資料準備 | 經濟部能源署「政府機關及學校節約能源填報網站」 | 依當年度填報系統 | ～ | 8 |
| GOV-SAVING | 3 | 政府機關及學校節約能源填報資料準備 | 經濟部能源署「政府機關及學校節約能源填報網站」（ea01.moeaea.gov.tw/e0402） | 網站 2026-11 版各填報頁 | ～ | 21 |
| HOSP-HPA | 1 | 醫院節能減碳網路填報資料準備 | 衛生福利部國民健康署「醫院節能減碳網路填報系統」 | 依當年度填報系統（項目參照 108 年操作手冊） | ～ | 15 |
| OEW-CONTROL | 1 | 油電水節能管制資料準備 | 「油電水節能管制系統」 | 通用格式（欄位待依系統畫面核對） | ～ | 8 |

## 預設係數（種子，待核准後發布）

| 代碼 | 版本 | 名稱 | 值 | 單位 | 生效 | 95% 信賴區間 | 係數種類 | 來源 | 說明 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ghg.heat.diesel | 1 | 柴油低位熱值（盤查用） | 8400 | kcal/L | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月） | 6.0.4 版「我國熱值」欄（能源局公告） |
| ghg.heat.gasoline | 1 | 車用汽油低位熱值（盤查用） | 7800 | kcal/L | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月） | 6.0.4 版「我國熱值」欄（能源局公告） |
| ghg.heat.fuel_oil | 1 | 燃料油低位熱值（盤查用） | 9600 | kcal/L | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月） | 6.0.4 版「我國熱值」欄（能源局公告） |
| ghg.heat.lpg | 1 | 液化石油氣低位熱值（盤查用） | 6635 | kcal/L | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月） | 6.0.4 版「我國熱值」欄（能源局公告） |
| ghg.heat.ng | 1 | 天然氣低位熱值（盤查用） | 8000 | kcal/Nm3 | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月） | 6.0.4 版「我國熱值」欄（能源局公告） |
| ef.diesel.stationary.CO2 | 1 | 柴油（固定源）CO2 排放係數 | 74100 | kgCO2/TJ | 1900-01-01～ | -2%／+0.9% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝74100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.stationary.CH4 | 1 | 柴油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.stationary.N2O | 1 | 柴油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.gasoline.stationary.CO2 | 1 | 車用汽油（固定源）CO2 排放係數 | 69300 | kgCO2/TJ | 1900-01-01～ | -2.6%／+5.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝69300 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.gasoline.stationary.CH4 | 1 | 車用汽油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.gasoline.stationary.N2O | 1 | 車用汽油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.fuel_oil.stationary.CO2 | 1 | 燃料油（固定源）CO2 排放係數 | 77400 | kgCO2/TJ | 1900-01-01～ | -2.5%／+1.8% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝77400 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.fuel_oil.stationary.CH4 | 1 | 燃料油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.fuel_oil.stationary.N2O | 1 | 燃料油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.lpg.stationary.CO2 | 1 | 液化石油氣（固定源）CO2 排放係數 | 63100 | kgCO2/TJ | 1900-01-01～ | -2.4%／+4% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝63100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.stationary.CH4 | 1 | 液化石油氣（固定源）CH4 排放係數 | 1 | kgCH4/TJ | 1900-01-01～ | -70%／+200% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.stationary.N2O | 1 | 液化石油氣（固定源）N2O 排放係數 | 0.1 | kgN2O/TJ | 1900-01-01～ | -70%／+200% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.ng.stationary.CO2 | 1 | 天然氣（固定源）CO2 排放係數 | 56100 | kgCO2/TJ | 1900-01-01～ | -3.2%／+3.9% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝56100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.ng.stationary.CH4 | 1 | 天然氣（固定源）CH4 排放係數 | 1 | kgCH4/TJ | 1900-01-01～ | -70%／+200% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.ng.stationary.N2O | 1 | 天然氣（固定源）N2O 排放係數 | 0.1 | kgN2O/TJ | 1900-01-01～ | -70%／+200% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.gasoline.mobile.CO2 | 1 | 車用汽油（移動源）CO2 排放係數 | 69300 | kgCO2/TJ | 1900-01-01～ | -2.6%／+5.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝69300 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.gasoline.mobile.CH4 | 1 | 車用汽油（移動源）CH4 排放係數 | 25 | kgCH4/TJ | 1900-01-01～ | -66.7%／+244% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝25 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.gasoline.mobile.N2O | 1 | 車用汽油（移動源）N2O 排放係數 | 8 | kgN2O/TJ | 1900-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝8 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.diesel.mobile.CO2 | 1 | 柴油（移動源）CO2 排放係數 | 74100 | kgCO2/TJ | 1900-01-01～ | -2%／+0.9% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝74100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.mobile.CH4 | 1 | 柴油（移動源）CH4 排放係數 | 3.9 | kgCH4/TJ | 1900-01-01～ | -59%／+143.6% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝3.9 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.mobile.N2O | 1 | 柴油（移動源）N2O 排放係數 | 3.9 | kgN2O/TJ | 1900-01-01～ | -66.7%／+207.7% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝3.9 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.lpg.mobile.CO2 | 1 | 液化石油氣（移動源）CO2 排放係數 | 63100 | kgCO2/TJ | 1900-01-01～ | -2.4%／+4% | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝63100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.mobile.CH4 | 1 | 液化石油氣（移動源）CH4 排放係數 | 62 | kgCH4/TJ | 1900-01-01～ |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝62 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg）；IPCC 未提供不確定性 |
| ef.lpg.mobile.N2O | 1 | 液化石油氣（移動源）N2O 排放係數 | 0.2 | kgN2O/TJ | 1900-01-01～ |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝0.2 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg）；IPCC 未提供不確定性 |
| ghg.heat.diesel | 2 | 柴油低位熱值（盤查用） | 8636 | kcal/L | 2023-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」 | 公告附表一低位熱值欄（事業得依檢測或供應商資料自訂） |
| ghg.heat.gasoline | 2 | 車用汽油低位熱值（盤查用） | 7586 | kcal/L | 2023-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」 | 公告附表一低位熱值欄（事業得依檢測或供應商資料自訂） |
| ghg.heat.ng | 2 | 天然氣低位熱值（盤查用） | 8728 | kcal/Nm3 | 2023-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」 | 公告附表一低位熱值欄（事業得依檢測或供應商資料自訂） |
| ef.diesel.stationary.CO2 | 2 | 柴油（固定源）CO2 排放係數 | 74100 | kgCO2/TJ | 2023-01-01～ | -2%／+0.9% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝74100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.stationary.CH4 | 2 | 柴油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.stationary.N2O | 2 | 柴油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.gasoline.stationary.CO2 | 2 | 車用汽油（固定源）CO2 排放係數 | 69300 | kgCO2/TJ | 2023-01-01～ | -2.6%／+5.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝69300 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.gasoline.stationary.CH4 | 2 | 車用汽油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.gasoline.stationary.N2O | 2 | 車用汽油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline） |
| ef.fuel_oil.stationary.CO2 | 2 | 燃料油（固定源）CO2 排放係數 | 77400 | kgCO2/TJ | 2023-01-01～ | -2.5%／+1.8% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝77400 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.fuel_oil.stationary.CH4 | 2 | 燃料油（固定源）CH4 排放係數 | 3 | kgCH4/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.fuel_oil.stationary.N2O | 2 | 燃料油（固定源）N2O 排放係數 | 0.6 | kgN2O/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.6 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.fuel_oil） |
| ef.lpg.stationary.CO2 | 2 | 液化石油氣（固定源）CO2 排放係數 | 63100 | kgCO2/TJ | 2023-01-01～ | -2.4%／+4% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝63100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.stationary.CH4 | 2 | 液化石油氣（固定源）CH4 排放係數 | 1 | kgCH4/TJ | 2023-01-01～ | -70%／+200% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.stationary.N2O | 2 | 液化石油氣（固定源）N2O 排放係數 | 0.1 | kgN2O/TJ | 2023-01-01～ | -70%／+200% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.ng.stationary.CO2 | 2 | 天然氣（固定源）CO2 排放係數 | 56100 | kgCO2/TJ | 2023-01-01～ | -3.2%／+3.9% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝56100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.ng.stationary.CH4 | 2 | 天然氣（固定源）CH4 排放係數 | 1 | kgCH4/TJ | 2023-01-01～ | -70%／+200% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.ng.stationary.N2O | 2 | 天然氣（固定源）N2O 排放係數 | 0.1 | kgN2O/TJ | 2023-01-01～ | -70%／+200% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.2 Table 2.2 | 單位排放係數＝0.1 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.gasoline.mobile.CO2 | 2 | 車用汽油（移動源）CO2 排放係數 | 69300 | kgCO2/TJ | 2023-01-01～ | -2.6%／+5.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝69300 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.gasoline.mobile.CH4 | 2 | 車用汽油（移動源）CH4 排放係數 | 25 | kgCH4/TJ | 2023-01-01～ | -66.7%／+244% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝25 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.gasoline.mobile.N2O | 2 | 車用汽油（移動源）N2O 排放係數 | 8 | kgN2O/TJ | 2023-01-01～ | -66.7%／+233.3% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝8 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.gasoline）；車用汽油 CH₄、N₂O 採氧化觸媒 |
| ef.diesel.mobile.CO2 | 2 | 柴油（移動源）CO2 排放係數 | 74100 | kgCO2/TJ | 2023-01-01～ | -2%／+0.9% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝74100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.mobile.CH4 | 2 | 柴油（移動源）CH4 排放係數 | 3.9 | kgCH4/TJ | 2023-01-01～ | -59%／+143.6% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝3.9 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.diesel.mobile.N2O | 2 | 柴油（移動源）N2O 排放係數 | 3.9 | kgN2O/TJ | 2023-01-01～ | -66.7%／+207.7% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝3.9 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.diesel） |
| ef.lpg.mobile.CO2 | 2 | 液化石油氣（移動源）CO2 排放係數 | 63100 | kgCO2/TJ | 2023-01-01～ | -2.4%／+4% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝63100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg） |
| ef.lpg.mobile.CH4 | 2 | 液化石油氣（移動源）CH4 排放係數 | 62 | kgCH4/TJ | 2023-01-01～ |  | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝62 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg）；IPCC 未提供不確定性 |
| ef.lpg.mobile.N2O | 2 | 液化石油氣（移動源）N2O 排放係數 | 0.2 | kgN2O/TJ | 2023-01-01～ |  | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝0.2 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.lpg）；IPCC 未提供不確定性 |
| ef.ng.mobile.CO2 | 2 | 天然氣（移動源）CO2 排放係數 | 56100 | kgCO2/TJ | 2023-01-01～ | -3.2%／+3.9% | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝56100 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng） |
| ef.ng.mobile.CH4 | 2 | 天然氣（移動源）CH4 排放係數 | 92 | kgCH4/TJ | 2023-01-01～ |  | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝92 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng）；IPCC 未提供不確定性 |
| ef.ng.mobile.N2O | 2 | 天然氣（移動源）N2O 排放係數 | 3 | kgN2O/TJ | 2023-01-01～ |  | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」；IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2 | 單位排放係數＝3 kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.ng）；IPCC 未提供不確定性 |
| gwp.AR4.CO2 | 1 | CO2 GWP（AR4） | 1 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.CH4 | 1 | CH4 GWP（AR4） | 25 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.N2O | 1 | N2O GWP（AR4） | 298 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.SF6 | 1 | SF6 GWP（AR4） | 22800 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.NF3 | 1 | NF3 GWP（AR4） | 17200 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-23 | 1 | HFC-23 GWP（AR4） | 14800 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-32 | 1 | HFC-32 GWP（AR4） | 675 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-125 | 1 | HFC-125 GWP（AR4） | 3500 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-134a | 1 | HFC-134a GWP（AR4） | 1430 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-143a | 1 | HFC-143a GWP（AR4） | 4470 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-152a | 1 | HFC-152a GWP（AR4） | 124 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-227ea | 1 | HFC-227ea GWP（AR4） | 3220 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.HFC-236fa | 1 | HFC-236fa GWP（AR4） | 9810 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） |  |
| gwp.AR4.R-410A | 1 | R-410A GWP（AR4） | 2088 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） | 6.0.4 版表列值 |
| gwp.AR4.R-404A | 1 | R-404A GWP（AR4） | 3922 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） | 6.0.4 版表列值 |
| gwp.AR4.R-407A | 1 | R-407A GWP（AR4） | 2107 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） | 6.0.4 版表列值 |
| gwp.AR4.R-407C | 1 | R-407C GWP（AR4） | 1774 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） | 6.0.4 版表列值 |
| gwp.AR4.R-507A | 1 | R-507A GWP（AR4） | 3985 | kgCO2e/kg | 1900-01-01～ |  |  | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 4 表（IPCC 第四次評估報告，2007） | 6.0.4 版表列值 |
| gwp.AR5.CO2 | 1 | CO2 GWP（AR5） | 1 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.CH4 | 1 | CH4 GWP（AR5） | 28 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.CH4_fossil | 1 | 石化甲烷 GWP（AR5） | 30 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） | 適用於化石燃料逸散之甲烷（公告附表四註 1）；燃料燃燒之 CH₄ 採 28 |
| gwp.AR5.N2O | 1 | N2O GWP（AR5） | 265 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.SF6 | 1 | SF6 GWP（AR5） | 23500 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.NF3 | 1 | NF3 GWP（AR5） | 16100 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-23 | 1 | HFC-23 GWP（AR5） | 12400 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-32 | 1 | HFC-32 GWP（AR5） | 677 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-125 | 1 | HFC-125 GWP（AR5） | 3170 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-134a | 1 | HFC-134a GWP（AR5） | 1300 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-143a | 1 | HFC-143a GWP（AR5） | 4800 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-152a | 1 | HFC-152a GWP（AR5） | 138 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-227ea | 1 | HFC-227ea GWP（AR5） | 3350 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.HFC-236fa | 1 | HFC-236fa GWP（AR5） | 8060 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013） |  |
| gwp.AR5.R-410A | 1 | R-410A GWP（AR5） | 1923.5 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.5 + HFC-125×0.5 |
| gwp.AR5.R-404A | 1 | R-404A GWP（AR5） | 3942.8 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-125×0.44 + HFC-143a×0.52 + HFC-134a×0.04 |
| gwp.AR5.R-407A | 1 | R-407A GWP（AR5） | 1923.4 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.2 + HFC-125×0.4 + HFC-134a×0.4 |
| gwp.AR5.R-407C | 1 | R-407C GWP（AR5） | 1624.21 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.23 + HFC-125×0.25 + HFC-134a×0.52 |
| gwp.AR5.R-507A | 1 | R-507A GWP（AR5） | 3985 | kgCO2e/kg | 1900-01-01～ |  |  | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表四（IPCC 第五次評估報告，2013）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-125×0.5 + HFC-143a×0.5 |
| gwp.AR6.CO2 | 1 | CO2 GWP（AR6） | 1 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.CH4 | 1 | CH4 GWP（AR6） | 27.9 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.N2O | 1 | N2O GWP（AR6） | 273 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.SF6 | 1 | SF6 GWP（AR6） | 25200 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.NF3 | 1 | NF3 GWP（AR6） | 17400 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-23 | 1 | HFC-23 GWP（AR6） | 14600 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-32 | 1 | HFC-32 GWP（AR6） | 771 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-125 | 1 | HFC-125 GWP（AR6） | 3740 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-134a | 1 | HFC-134a GWP（AR6） | 1530 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-143a | 1 | HFC-143a GWP（AR6） | 5810 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-152a | 1 | HFC-152a GWP（AR6） | 164 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-227ea | 1 | HFC-227ea GWP（AR6） | 3600 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.HFC-236fa | 1 | HFC-236fa GWP（AR6） | 8690 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告） |  |
| gwp.AR6.R-410A | 1 | R-410A GWP（AR6） | 2255.5 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.5 + HFC-125×0.5 |
| gwp.AR6.R-404A | 1 | R-404A GWP（AR6） | 4728 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-125×0.44 + HFC-143a×0.52 + HFC-134a×0.04 |
| gwp.AR6.R-407A | 1 | R-407A GWP（AR6） | 2262.2 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.2 + HFC-125×0.4 + HFC-134a×0.4 |
| gwp.AR6.R-407C | 1 | R-407C GWP（AR6） | 1907.93 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-32×0.23 + HFC-125×0.25 + HFC-134a×0.52 |
| gwp.AR6.R-507A | 1 | R-507A GWP（AR6） | 4775 | kgCO2e/kg | 1900-01-01～ |  |  | IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）；組成依 ASHRAE Standard 34 | 依組成加權：HFC-125×0.5 + HFC-143a×0.5 |
| ef.electricity.2005 | 1 | 94 年度電力排放係數 | 0.555 | kgCO2e/kWh | 2005-01-01～2005-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2006 | 1 | 95 年度電力排放係數 | 0.562 | kgCO2e/kWh | 2006-01-01～2006-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2007 | 1 | 96 年度電力排放係數 | 0.558 | kgCO2e/kWh | 2007-01-01～2007-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2008 | 1 | 97 年度電力排放係數 | 0.555 | kgCO2e/kWh | 2008-01-01～2008-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2009 | 1 | 98 年度電力排放係數 | 0.543 | kgCO2e/kWh | 2009-01-01～2009-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2010 | 1 | 99 年度電力排放係數 | 0.534 | kgCO2e/kWh | 2010-01-01～2010-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2011 | 1 | 100 年度電力排放係數 | 0.534 | kgCO2e/kWh | 2011-01-01～2011-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2012 | 1 | 101 年度電力排放係數 | 0.529 | kgCO2e/kWh | 2012-01-01～2012-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2013 | 1 | 102 年度電力排放係數 | 0.519 | kgCO2e/kWh | 2013-01-01～2013-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2014 | 1 | 103 年度電力排放係數 | 0.518 | kgCO2e/kWh | 2014-01-01～2014-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2015 | 1 | 104 年度電力排放係數 | 0.525 | kgCO2e/kWh | 2015-01-01～2015-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2016 | 1 | 105 年度電力排放係數 | 0.53 | kgCO2e/kWh | 2016-01-01～2016-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2017 | 1 | 106 年度電力排放係數 | 0.554 | kgCO2e/kWh | 2017-01-01～2017-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2018 | 1 | 107 年度電力排放係數 | 0.533 | kgCO2e/kWh | 2018-01-01～2018-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2019 | 1 | 108 年度電力排放係數 | 0.509 | kgCO2e/kWh | 2019-01-01～2019-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2020 | 1 | 109 年度電力排放係數 | 0.502 | kgCO2e/kWh | 2020-01-01～2020-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2021 | 1 | 110 年度電力排放係數 | 0.509 | kgCO2e/kWh | 2021-01-01～2021-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2022 | 1 | 111 年度電力排放係數 | 0.495 | kgCO2e/kWh | 2022-01-01～2022-12-31 |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 5 表（能源局公告） |  |
| ef.electricity.2023 | 1 | 112 年度電力排放係數 | 0.494 | kgCO2e/kWh | 2023-01-01～2023-12-31 |  | 5國家排放係數 | 經濟部能源署公告「電力排碳係數」（113 年公告：購買公用售電業電力者依最新公告值） |  |
| ef.electricity.2024 | 1 | 113 年度電力排放係數 | 0.474 | kgCO2e/kWh | 2024-01-01～2024-12-31 |  | 5國家排放係數 | 經濟部能源署公告「電力排碳係數」（113 年公告：購買公用售電業電力者依最新公告值） |  |
| septic.ef_person_hour | 1 | 化糞池 CH₄ 排放係數 | 0.00000159375 | tCH4/person_hour | 1900-01-01～ |  | 5國家排放係數 | 環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）第 6 表「八、化糞池」 | BOD 排放因子 0.6 公噸CH₄/公噸BOD × 平均污水濃度 200 mg/L × 每人每小時廢水量 15.625 L × 處理效率 85%（範例參數；年 0.003825 公噸/人，以 300 天 × 8 小時換算每人·時） |
| septic.ef_person_hour | 2 | 化糞池 CH₄ 排放係數 | 1.40625e-7 | tCH4/person_hour | 2023-01-01～ |  | 5國家排放係數 | 環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」附表三「一、生活廢水及廢棄污泥」 | BOD 排放因子 0.6 × 甲烷修正係數 0.5（化糞池系統）× 平均污水濃度 100 mg/L ÷ 10⁹ × 每人每小時廢水量 18.75 L ÷ 4（公告附表三範例參數與試算式） |
| heat.gasoline | 1 | 車用汽油熱值（能源統計） | 7520 | kcal/L | 2024-01-01～ |  |  | 經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正） |  |
| heat.diesel | 1 | 柴油熱值（能源統計） | 8629 | kcal/L | 2024-01-01～ |  |  | 經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正） |  |
| heat.fuel_oil | 1 | 燃料油熱值（能源統計） | 9320 | kcal/L | 2024-01-01～ |  |  | 經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正） |  |
| heat.lpg | 1 | 液化石油氣熱值（能源統計） | 10832 | kcal/kg | 2024-01-01～ |  |  | 經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正） |  |
| heat.ng | 1 | 天然氣熱值（能源統計） | 8107 | kcal/Nm3 | 2024-01-01～ |  |  | 經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正） |  |

## 預設設定

### compare.thresholds

```json
{
  "default": {
    "abs": 0,
    "rel_pct": 3
  },
  "byMetricSemantics": {
    "usage": {
      "abs": 50,
      "rel_pct": 3
    },
    "cost": {
      "abs": 100,
      "rel_pct": 1
    },
    "withdrawal": {
      "abs": 5,
      "rel_pct": 5
    },
    "consumption": {
      "abs": 5,
      "rel_pct": 5
    }
  },
  "reference": "max_priority_source",
  "zeroDenominator": "abs_only"
}
```

### validation.rules

```json
{
  "version": 1,
  "rules": {
    "required_type": {
      "enabled": true,
      "severity": "error"
    },
    "period_valid": {
      "enabled": true,
      "severity": "error"
    },
    "unit_convertible": {
      "enabled": true,
      "severity": "error"
    },
    "negative_usage": {
      "enabled": true,
      "severity": "error"
    },
    "cumulative_backward": {
      "enabled": true,
      "severity": "error"
    },
    "duplicate_source": {
      "enabled": true,
      "severity": "warning"
    },
    "false_independence": {
      "enabled": true,
      "severity": "warning"
    },
    "cross_source": {
      "enabled": true,
      "severity": "warning"
    },
    "history_anomaly": {
      "enabled": true,
      "severity": "warning",
      "yoy_rel_pct": 40,
      "mom_rel_pct": 60,
      "min_history": 3
    },
    "coverage_gap": {
      "enabled": true,
      "severity": "warning"
    },
    "oil_balance": {
      "enabled": true,
      "severity": "warning",
      "tolerance_pct": 5
    },
    "meter_balance": {
      "enabled": true,
      "severity": "warning",
      "loss_max_pct": 8
    },
    "evidence_required": {
      "enabled": true,
      "severity": "warning",
      "methods": [
        "manual",
        "import",
        "ocr"
      ]
    },
    "period_end_pending": {
      "enabled": true,
      "severity": "info"
    }
  }
}
```

### decision.policy

```json
{
  "highImpact": {
    "derived": true,
    "estimated": true,
    "notApplicable": true,
    "relDiffPct": 10,
    "absValueOver": {
      "kWh": 100000,
      "L": 5000,
      "m3": 10000
    }
  },
  "requireEvidenceForSelect": true,
  "reviewerMustDifferFromProposer": true
}
```

### case.sla

```json
{
  "low": 30,
  "medium": 14,
  "high": 7,
  "critical": 3
}
```

### task.reminders

```json
{
  "beforeDueDays": [
    3,
    1
  ],
  "overdueEveryDays": 2
}
```

### calc.settings

```json
{
  "gwpSet": "auto",
  "precision": {
    "tCO2e": 4,
    "kWh": 0,
    "GJ": 3,
    "m3": 1
  },
  "refrigerantMethod": "recharge"
}
```

### calc.septic

```json
{
  "visitHours": 2,
  "workdayHours": 8,
  "note": "門診人次以每次停留 2 小時折算人日；院方採用指引不同時請修改"
}
```

### dashboard.visibility

```json
{
  "public": [
    "domain_progress",
    "kpi_rates",
    "usage_count",
    "site_progress"
  ],
  "hideBelowCount": 0
}
```

### ghg.uncertainty

```json
{
  "activityByMethod": {
    "api": 2,
    "import": 2,
    "legacy": 2,
    "ocr": 3,
    "manual": 5
  },
  "activityEstimated": 20,
  "activityDerived": 10,
  "factorByKind": {
    "combustion": 5,
    "electricity": 5,
    "refrigerant": 10,
    "insulating": 10,
    "process": 10,
    "septic": 50,
    "imported_heat": 10
  },
  "confidence": "95%",
  "note": "活動數據與係數的相對不確定性（±%）；以誤差傳遞法合成（IPCC 2006 Vol.1 Ch.3 方法 1）"
}
```

### ghg.significance

```json
{
  "thresholdPct": 1,
  "criteria": "預估排放量占類別一＋類別二總量 1% 以上，或法規、主管機關、利害關係人要求揭露者，判定為顯著並量化"
}
```

### ghg.significance_estimators

```json
{
  "UPSTREAM-ENERGY": {
    "indicator": "energy.elec_kwh",
    "factor": "ef.upstream.electricity",
    "label": "外購電力（度）× 電力上游排放係數（kgCO₂e/度）"
  },
  "UPSTREAM-WATER": {
    "indicator": "water.withdrawal_m3",
    "factor": "ef.upstream.water",
    "label": "取水量（m³）× 自來水排放係數（kgCO₂e/m³）"
  },
  "WASTEWATER": {
    "indicator": "water.discharge_m3",
    "factor": "ef.wastewater.treatment",
    "label": "排水量（m³）× 污水處理排放係數（kgCO₂e/m³）"
  },
  "REF-COMMUTE": {
    "indicator": "act.staff_count",
    "factor": "ef.commute.per_staff",
    "label": "員工人數 × 每人年通勤排放（kgCO₂e/人）"
  }
}
```

### ghg.data_quality

```json
{
  "activityType": {
    "1": "自動連續量測",
    "2": "間歇量測（帳單、抄表）",
    "3": "自行推估"
  },
  "activityTrust": {
    "1": "有外部校正或第三方證明",
    "2": "有內部校正紀錄",
    "3": "未校正或無紀錄"
  },
  "factorType": {
    "1": "自廠發展／實測係數",
    "2": "同製程／設備經驗係數、製造廠提供",
    "3": "區域／國家／國際排放係數"
  },
  "grades": [
    {
      "max": 10,
      "grade": "第一級"
    },
    {
      "max": 19,
      "grade": "第二級"
    },
    {
      "max": 27,
      "grade": "第三級"
    }
  ]
}
```

### notify.channels

```json
{
  "inApp": true,
  "email": false
}
```

### export.retentionDays

```json
3650
```

### security.session

```json
{
  "idleMinutes": 480,
  "rememberDays": 30
}
```

## 角色

| 代碼 | 名稱 | 說明 |
| --- | --- | --- |
| collector | 盤點承辦 | 建檔、找來源、取證、更新、回覆異常 |
| custodian | 資料保管者／設備管理員 | 提供帳單、紀錄、設備資訊，確認真實來源 |
| reporter | 報告承辦 | 建立報告需求、查證、比對、提出採用值、草擬報告 |
| reviewer | 資料審核者 | 核對差異及裁決理由，批准或退回；資料集定版 |
| approver | 報告核准者 | 核准對外報告、報告封存 |
| manager | 管理者 | 追蹤院區、部門與年度進度，資源協調 |
| staff | 一般同仁 | 瀏覽授權的進度與成果 |
| sysadmin | 系統管理員 | 管理設定、規則、服務帳號、權限 |
| auditor | 稽核／查驗人員 | 依授權查閱證據鏈、報告快照與歷程（唯讀） |
| org_admin | 院所管理者 | 管理本院帳號、角色與介接設定 |

## 權限動作

| 代碼 | 名稱 |
| --- | --- |
| view.public | 瀏覽公開進度 |
| view.internal | 瀏覽盤點資料 |
| view.sensitive | 檢視敏感欄位（電號、費用、聯絡資訊） |
| view.evidence | 下載原始佐證 |
| view.management | 管理看板 |
| asset.write | 建立與維護標的 |
| asset.applicability | 判定適用性 |
| asset.applicability.approve | 核准不適用判定 |
| source.write | 維護資料來源 |
| search.write | 建立來源追查 |
| obs.write | 登錄觀測值 |
| import.write | 檔案匯入 |
| obs.confirm_ocr | 確認辨識結果 |
| case.write | 處理差異案件 |
| case.assign | 指派差異案件 |
| decision.propose | 提出採用值 |
| decision.review | 審核採用值 |
| dataset.write | 建立資料集 |
| dataset.approve | 核准資料集 |
| dataset.lock | 資料集定版 |
| report.write | 建立與產製報告 |
| report.review | 審查報告 |
| report.approve | 核准與封存報告 |
| export.download | 下載匯出檔 |
| dashboard.manage | 看板設定 |
| config.write | 修改系統設定 |
| config.approve | 核准系統設定 |
| user.manage | 帳號與權限管理 |
| integration.write | 介接設定 |
| audit.read | 查詢稽核日誌 |
| org.write | 組織院區維護 |
| backup.run | 備份還原 |
| validation.run | 執行檢核 |
| task.write | 待辦與留言 |

