// 係數種子。全部以「待核准（pending）」寫入：系統管理員在後台核對來源後按發布，計算引擎只用已發布的版本。
//
// 組織型溫室氣體盤查依環境部係數，分兩個版本（同一代碼 v1／v2）：
//   v1＝環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月；2019 年起盤查適用）
//   v2＝環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」（112 年度盤查起適用；
//       環境部匯入說明：112 年度後 GWP 使用 AR5）
// 計算時依盤查年度取有效版本（v2 自 2023-01-01 起有效）。v2 沒有列的數值（例如燃料油、液化石油氣熱值）沿用 v1。
//
// 燃料係數存「公斤/兆焦耳」，另存熱值；計算時 單位排放係數＝係數 × 4186.8×10⁻⁹×10⁻³ × 熱值（兩版附表同一算法）。

// v1 起日放寬到 1900：6.0.4 版是兩份附件中最早的版本，2019 年以前（重算基準年）也以它計算
const V1 = { version: 1, valid_from: '1900-01-01', src: '環保署「溫室氣體排放係數管理表 6.0.4 版」（108 年 6 月）' };
const V2 = { version: 2, valid_from: '2023-01-01', src: '環境部 113 年 2 月 5 日環部授氣字第 1139101231 號公告「溫室氣體排放係數」' };
const FUEL_NAME = { diesel: '柴油', gasoline: '車用汽油', fuel_oil: '燃料油', lpg: '液化石油氣', ng: '天然氣' };

// 環境部盤查用熱值（ghg.heat.*）。能源查核、能源統計用的能源署熱值是另一組（heat.*），不混用
const GHG_HEAT = {
  v1: { diesel: [8400, 'L'], gasoline: [7800, 'L'], fuel_oil: [9600, 'L'], lpg: [6635, 'L'], ng: [8000, 'Nm3'] },
  // 113 年公告附表一「低位熱值」欄為事業自行鍵入，附件預填車用汽油、柴油、天然氣
  v2: { diesel: [8636, 'L'], gasoline: [7586, 'L'], ng: [8728, 'Nm3'] },
};

// IPCC 2006 預設排放係數（kg/TJ）與 95% 信賴區間（%）。兩版數值相同（6.0.4 版第 1～3 表；113 年公告附表一）
// 移動源車用汽油 CH₄、N₂O 採「氧化觸媒」（6.0.4 版建議值；環境部匯入表單參考係數同）
const S = (co2, ch4, n2o, ci) => ({ CO2: [co2, ...ci.co2], CH4: [ch4, ...ci.ch4], N2O: [n2o, ...ci.n2o] });
const LIQ = { ch4: [-66.7, 233.3], n2o: [-66.7, 233.3] }; const GAS = { ch4: [-70, 200], n2o: [-70, 200] };
const FUEL_EF = {
  stationary: {
    diesel: S(74100, 3, 0.6, { co2: [-2.0, 0.9], ...LIQ }),
    gasoline: S(69300, 3, 0.6, { co2: [-2.6, 5.3], ...LIQ }),
    fuel_oil: S(77400, 3, 0.6, { co2: [-2.5, 1.8], ...LIQ }),
    lpg: S(63100, 1, 0.1, { co2: [-2.4, 4.0], ...GAS }),
    ng: S(56100, 1, 0.1, { co2: [-3.2, 3.9], ...GAS }),
  },
  mobile: {
    gasoline: S(69300, 25, 8, { co2: [-2.6, 5.3], ch4: [-66.7, 244.0], n2o: [-66.7, 233.3] }),
    diesel: S(74100, 3.9, 3.9, { co2: [-2.0, 0.9], ch4: [-59.0, 143.6], n2o: [-66.7, 207.7] }),
    lpg: S(63100, 62, 0.2, { co2: [-2.4, 4.0], ch4: [null, null], n2o: [null, null] }),
  },
};
// 113 年公告附表一移動源另列天然氣（CH₄ 92、N₂O 3）；6.0.4 版無此列，111 年度以前退回固定源係數
const V2_ONLY = { mobile: { ng: S(56100, 92, 3, { co2: [-3.2, 3.9], ch4: [null, null], n2o: [null, null] }) } };
const IPCC_TABLE = { stationary: 'IPCC 2006 Vol.2 Ch.2 Table 2.2', mobile: 'IPCC 2006 Vol.2 Ch.3 Table 3.2.1、3.2.2' };

export function fuelFactors() {
  const out = [];
  for (const [ver, V] of [['v1', V1], ['v2', V2]]) {
    for (const [fuel, [kcal, unit]] of Object.entries(GHG_HEAT[ver])) {
      out.push({ code: `ghg.heat.${fuel}`, version: V.version, name: `${FUEL_NAME[fuel]}低位熱值（盤查用）`, category: 'heat', value: kcal, unit: `kcal/${unit}`, applies_to: fuel,
        valid_from: V.valid_from, source: V.src, note: ver === 'v2' ? '公告附表一低位熱值欄（事業得依檢測或供應商資料自訂）' : '6.0.4 版「我國熱值」欄（能源局公告）' });
    }
    const table = ver === 'v2' ? { ...FUEL_EF, mobile: { ...FUEL_EF.mobile, ...V2_ONLY.mobile } } : FUEL_EF;
    for (const [mode, fuels] of Object.entries(table)) {
      for (const [fuel, gases] of Object.entries(fuels)) {
        for (const [gas, [kgtj, lo, hi]] of Object.entries(gases)) {
          out.push({
            code: `ef.${fuel}.${mode}.${gas}`, version: V.version, name: `${FUEL_NAME[fuel]}（${mode === 'mobile' ? '移動源' : '固定源'}）${gas} 排放係數`,
            category: 'emission', gas, value: kgtj, unit: `kg${gas}/TJ`, applies_to: `${fuel}:${mode}`, valid_from: V.valid_from,
            source: `${V.src}；${IPCC_TABLE[mode]}`, uncertainty_low: lo, uncertainty_high: hi, factor_class: '5國家排放係數',
            note: `單位排放係數＝${kgtj} kg/TJ × 4186.8×10⁻⁹×10⁻³ × 熱值（ghg.heat.${fuel}）${mode === 'mobile' && fuel === 'gasoline' ? '；車用汽油 CH₄、N₂O 採氧化觸媒' : ''}${lo === null ? '；IPCC 未提供不確定性' : ''}`,
          });
        }
      }
    }
  }
  return out;
}

// GWP：v1 依 6.0.4 版（統一採 IPCC 第四次評估報告 AR4）；v2 依 113 年公告附表四（AR5）。AR6 供 ISO 揭露比較用
const GWP = {
  AR4: { CO2: 1, CH4: 25, N2O: 298, SF6: 22800, NF3: 17200, 'HFC-23': 14800, 'HFC-32': 675, 'HFC-125': 3500, 'HFC-134a': 1430, 'HFC-143a': 4470, 'HFC-152a': 124, 'HFC-227ea': 3220, 'HFC-236fa': 9810 },
  AR5: { CO2: 1, CH4: 28, CH4_fossil: 30, N2O: 265, SF6: 23500, NF3: 16100, 'HFC-23': 12400, 'HFC-32': 677, 'HFC-125': 3170, 'HFC-134a': 1300, 'HFC-143a': 4800, 'HFC-152a': 138, 'HFC-227ea': 3350, 'HFC-236fa': 8060 },
  AR6: { CO2: 1, CH4: 27.9, N2O: 273, SF6: 25200, NF3: 17400, 'HFC-23': 14600, 'HFC-32': 771, 'HFC-125': 3740, 'HFC-134a': 1530, 'HFC-143a': 5810, 'HFC-152a': 164, 'HFC-227ea': 3600, 'HFC-236fa': 8690 },
};
// 混合冷媒組成（重量比，6.0.4 版第 4 表／ASHRAE 34）
export const BLENDS = {
  'R-410A': { 'HFC-32': 0.5, 'HFC-125': 0.5 },
  'R-404A': { 'HFC-125': 0.44, 'HFC-143a': 0.52, 'HFC-134a': 0.04 },
  'R-407A': { 'HFC-32': 0.2, 'HFC-125': 0.4, 'HFC-134a': 0.4 },
  'R-407C': { 'HFC-32': 0.23, 'HFC-125': 0.25, 'HFC-134a': 0.52 },
  'R-507A': { 'HFC-125': 0.5, 'HFC-143a': 0.5 },
};
// 6.0.4 版第 4 表直接列出的 AR4 混合冷媒 GWP（照表，不自行加權）
const AR4_BLEND_TABLE = { 'R-410A': 2088, 'R-404A': 3922, 'R-407A': 2107, 'R-407C': 1774, 'R-507A': 3985 };
export const REFRIGERANT_ALIASES = { 'R-134a': 'HFC-134a', 'R-32': 'HFC-32', 'R-125': 'HFC-125', 'R-143a': 'HFC-143a', 'R-23': 'HFC-23', 'R-152a': 'HFC-152a', 'FM-200': 'HFC-227ea', 'R-227ea': 'HFC-227ea' };
// 蒙特婁議定書管制物質：不屬京都七種溫室氣體，不計入（但仍列設備台帳）
export const MONTREAL = ['R-22', 'HCFC-22', 'R-123', 'HCFC-123', 'R-12', 'CFC-12', 'R-11', 'CFC-11', 'R-141b', 'HCFC-141b'];

export function gwpFactors() {
  const out = [];
  const meta = {
    AR4: `${V1.src}第 4 表（IPCC 第四次評估報告，2007）`,
    AR5: `${V2.src}附表四（IPCC 第五次評估報告，2013）`,
    AR6: 'IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100；ISO 揭露比較用，非環境部公告）',
  };
  for (const [set, gases] of Object.entries(GWP)) {
    for (const [gas, v] of Object.entries(gases)) {
      out.push({ code: `gwp.${set}.${gas}`, version: 1, name: `${gas === 'CH4_fossil' ? '石化甲烷' : gas} GWP（${set}）`, category: 'gwp', gas: gas === 'CH4_fossil' ? 'CH4' : gas, gwp_set: set, value: v,
        unit: 'kgCO2e/kg', valid_from: '1900-01-01', source: meta[set], note: gas === 'CH4_fossil' ? '適用於化石燃料逸散之甲烷（公告附表四註 1）；燃料燃燒之 CH₄ 採 28' : null });
    }
    for (const [blend, comp] of Object.entries(BLENDS)) {
      const listed = set === 'AR4' ? AR4_BLEND_TABLE[blend] : null;
      const v = listed ?? +Object.entries(comp).reduce((s, [g, w]) => s + gases[g] * w, 0).toFixed(2);
      out.push({ code: `gwp.${set}.${blend}`, version: 1, name: `${blend} GWP（${set}）`, category: 'gwp', gas: blend, gwp_set: set, value: v, unit: 'kgCO2e/kg', valid_from: '1900-01-01',
        source: listed ? meta[set] : `${meta[set]}；組成依 ASHRAE Standard 34`, note: listed ? '6.0.4 版表列值' : `依組成加權：${Object.entries(comp).map(([g, w]) => `${g}×${w}`).join(' + ')}` });
    }
  }
  return out;
}

// 電力排放係數：94～111 年依 6.0.4 版第 5 表（能源局公告）；112 年起依經濟部能源署當年公告
export function electricityFactors() {
  const v604 = { 2005: 0.555, 2006: 0.562, 2007: 0.558, 2008: 0.555, 2009: 0.543, 2010: 0.534, 2011: 0.534, 2012: 0.529, 2013: 0.519, 2014: 0.518,
    2015: 0.525, 2016: 0.530, 2017: 0.554, 2018: 0.533, 2019: 0.509, 2020: 0.502, 2021: 0.509, 2022: 0.495 };
  const moea = { 2023: 0.494, 2024: 0.474 };
  return [...Object.entries(v604).map(([y, v]) => [+y, v, `${V1.src}第 5 表（能源局公告）`]), ...Object.entries(moea).map(([y, v]) => [+y, v, '經濟部能源署公告「電力排碳係數」（113 年公告：購買公用售電業電力者依最新公告值）']),
    // 114 年度起能源署分「產業」與「民生住宅」兩種，醫院盤查用產業電力排碳係數（115-06-02 公告；公用售電業總值 0.467、民生住宅 0.471）
    [2025, 0.466, '經濟部能源署 115 年 6 月 2 日公告 114 年度「產業電力排碳係數」']]
    .map(([y, v, src]) => ({ code: `ef.electricity.${y}`, version: 1, name: `${y - 1911} 年度電力排放係數`, category: 'emission', gas: 'CO2e', value: v, unit: 'kgCO2e/kWh',
      applies_to: 'electricity', valid_from: `${y}-01-01`, valid_to: `${y}-12-31`, source: src, factor_class: '5國家排放係數' }));
}

// 化糞池：tCH₄／人·時。v1＝6.0.4 版第 6 表「八、化糞池」範例參數；v2＝113 年公告附表三「一、生活廢水及廢棄污泥」化糞池範例參數。
// 參數不同時院方以「自訂係數」新增版本（例如實測污水濃度）
export function septicFactors() {
  // 6.0.4：0.6 × 200 mg/L ÷ 10⁹ × 300 天 × (8 時 × 15.625 L/時) × 85% ＝ 0.003825 公噸/人·年 → ÷(300×8) 換算每人·時
  const v1 = 0.6 * 200 / 1e9 * 300 * (8 * 15.625) * 0.85 / (300 * 8);
  // 113 年：BOD 排放因子 0.6 × MCF 0.5 × 100 mg/L ÷ 10⁹ × 18.75 L/時 ÷ 4（公告附表三試算式）
  const v2 = 0.6 * 0.5 * 100 / 1e9 * 18.75 / 4;
  return [
    { code: 'septic.ef_person_hour', version: 1, name: '化糞池 CH₄ 排放係數', category: 'emission', gas: 'CH4', value: +v1.toPrecision(10), unit: 'tCH4/person_hour', valid_from: V1.valid_from,
      source: `${V1.src}第 6 表「八、化糞池」`, factor_class: '5國家排放係數',
      note: 'BOD 排放因子 0.6 公噸CH₄/公噸BOD × 平均污水濃度 200 mg/L × 每人每小時廢水量 15.625 L × 處理效率 85%（範例參數；年 0.003825 公噸/人，以 300 天 × 8 小時換算每人·時）' },
    { code: 'septic.ef_person_hour', version: 2, name: '化糞池 CH₄ 排放係數', category: 'emission', gas: 'CH4', value: +v2.toPrecision(10), unit: 'tCH4/person_hour', valid_from: V2.valid_from,
      source: `${V2.src}附表三「一、生活廢水及廢棄污泥」`, factor_class: '5國家排放係數',
      note: 'BOD 排放因子 0.6 × 甲烷修正係數 0.5（化糞池系統）× 平均污水濃度 100 mg/L ÷ 10⁹ × 每人每小時廢水量 18.75 L ÷ 4（公告附表三範例參數與試算式）' },
  ];
}

// 能源署「能源產品單位熱值表」（113 年起適用、114 年修正）：能源查核、能源統計用（不是盤查用熱值）
export function energyHeatFactors() {
  const src = '經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正）';
  return [['gasoline', 7520, 'L'], ['diesel', 8629, 'L'], ['fuel_oil', 9320, 'L'], ['lpg', 10832, 'kg'], ['ng', 8107, 'Nm3']]
    .map(([fuel, kcal, unit]) => ({ code: `heat.${fuel}`, version: 1, name: `${FUEL_NAME[fuel]}熱值（能源統計）`, category: 'heat', value: kcal, unit: `kcal/${unit}`, applies_to: fuel, source: src, valid_from: '2024-01-01' }));
}

export function allSeedFactors() {
  return [...fuelFactors(), ...gwpFactors(), ...electricityFactors(), ...septicFactors(), ...energyHeatFactors()];
}
