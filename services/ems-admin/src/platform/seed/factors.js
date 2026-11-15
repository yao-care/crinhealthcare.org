// 係數種子。全部以「待核准（pending）」寫入：系統管理員在後台核對來源後按發布，計算引擎只用已發布的版本。
// 每一筆都帶來源；推算出來的（例如每公升柴油 CO₂）把推算式寫在 note，不假裝是官方公告值。

const KCAL_TO_TJ = 4.1868e-9;
// 能源署「能源產品單位熱值表」（113 年起適用、114 年修正），與 public/inventory-compute.js ENERGY_UNITS 同源
const HEAT = {
  gasoline: { kcal: 7520, unit: 'L', name: '車用汽油' },
  diesel: { kcal: 8629, unit: 'L', name: '柴油' },
  fuel_oil: { kcal: 9320, unit: 'L', name: '燃料油' },
  lpg: { kcal: 10832, unit: 'kg', name: '液化石油氣' },
  ng: { kcal: 8107, unit: 'Nm3', name: '天然氣（NG1）' },
};
const HEAT_SRC = '經濟部能源署「能源產品單位熱值表」（113 年起適用、114 年修正）';
const IPCC = 'IPCC 2006 Guidelines Vol.2 Ch.2 Table 2.2／Ch.3 Table 3.2.1、3.2.2（預設排放係數，kg/TJ）';

// IPCC 2006 預設值（kg/TJ）。固定源用 Table 2.2 能源工業預設；移動源汽油 CH4/N2O 用 Table 3.2.2 未控制
const KG_PER_TJ = {
  gasoline: { stationary: { CO2: 69300, CH4: 3, N2O: 0.6 }, mobile: { CO2: 69300, CH4: 33, N2O: 3.2 } },
  diesel: { stationary: { CO2: 74100, CH4: 3, N2O: 0.6 }, mobile: { CO2: 74100, CH4: 3.9, N2O: 3.9 } },
  fuel_oil: { stationary: { CO2: 77400, CH4: 3, N2O: 0.6 } },
  lpg: { stationary: { CO2: 63100, CH4: 1, N2O: 0.1 } },
  ng: { stationary: { CO2: 56100, CH4: 1, N2O: 0.1 } },
};

export function fuelFactors() {
  const out = [];
  for (const [fuel, modes] of Object.entries(KG_PER_TJ)) {
    const h = HEAT[fuel];
    out.push({ code: `heat.${fuel}`, name: `${h.name}熱值`, category: 'heat', value: h.kcal, unit: `kcal/${h.unit}`, applies_to: fuel, source: HEAT_SRC, valid_from: '2024-01-01' });
    for (const [mode, gases] of Object.entries(modes)) {
      for (const [gas, kgtj] of Object.entries(gases)) {
        const perUnit = +(h.kcal * KCAL_TO_TJ * kgtj).toPrecision(6);
        out.push({
          code: `ef.${fuel}.${mode}.${gas}`, name: `${h.name}（${mode === 'mobile' ? '移動源' : '固定源'}）${gas} 排放係數`,
          category: 'emission', gas, value: perUnit, unit: `kg${gas}/${h.unit}`, applies_to: `${fuel}:${mode}`, valid_from: '2024-01-01',
          source: `${IPCC}；熱值 ${HEAT_SRC}`,
          note: `推算：${h.kcal} kcal/${h.unit} × 4.1868×10⁻⁹ TJ/kcal × ${kgtj} kg/TJ。院方若採環境部「溫室氣體排放係數管理表」公告值，請新增版本取代`,
        });
      }
    }
  }
  return out;
}

// GWP：AR5（IPCC 第五次評估報告，100 年）與 AR6（第六次）。冷媒混合物依組成重量比加權
const GWP = {
  AR5: { CO2: 1, CH4: 28, N2O: 265, SF6: 23500, NF3: 16100, 'HFC-23': 12400, 'HFC-32': 677, 'HFC-125': 3170, 'HFC-134a': 1300, 'HFC-143a': 4800, 'HFC-227ea': 3350 },
  AR6: { CO2: 1, CH4: 27.9, N2O: 273, SF6: 25200, NF3: 17400, 'HFC-23': 14600, 'HFC-32': 771, 'HFC-125': 3740, 'HFC-134a': 1530, 'HFC-143a': 5810, 'HFC-227ea': 3600 },
};
// ASHRAE 34 組成（重量 %）
export const BLENDS = {
  'R-410A': { 'HFC-32': 0.5, 'HFC-125': 0.5 },
  'R-404A': { 'HFC-125': 0.44, 'HFC-134a': 0.04, 'HFC-143a': 0.52 },
  'R-407C': { 'HFC-32': 0.23, 'HFC-125': 0.25, 'HFC-134a': 0.52 },
  'R-507A': { 'HFC-125': 0.5, 'HFC-143a': 0.5 },
};
export const REFRIGERANT_ALIASES = { 'R-134a': 'HFC-134a', 'R-32': 'HFC-32', 'R-125': 'HFC-125', 'R-143a': 'HFC-143a', 'R-23': 'HFC-23', 'FM-200': 'HFC-227ea', 'R-227ea': 'HFC-227ea' };
// 蒙特婁議定書管制物質：不屬京都七種溫室氣體，不計入（但仍列設備台帳）
export const MONTREAL = ['R-22', 'HCFC-22', 'R-123', 'HCFC-123', 'R-12', 'CFC-12', 'R-11', 'CFC-11', 'R-141b', 'HCFC-141b'];

export function gwpFactors() {
  const out = [];
  for (const [set, gases] of Object.entries(GWP)) {
    const src = set === 'AR5' ? 'IPCC AR5 WG1 Ch.8 Table 8.A.1（GWP100）' : 'IPCC AR6 WG1 Ch.7 Table 7.SM.7（GWP100）';
    for (const [gas, v] of Object.entries(gases)) {
      out.push({ code: `gwp.${set}.${gas}`, name: `${gas} GWP（${set}）`, category: 'gwp', gas, gwp_set: set, value: v, unit: 'kgCO2e/kg', valid_from: '1900-01-01', source: src });
    }
    for (const [blend, comp] of Object.entries(BLENDS)) {
      const v = +Object.entries(comp).reduce((s, [g, w]) => s + gases[g] * w, 0).toFixed(1);
      out.push({ code: `gwp.${set}.${blend}`, name: `${blend} GWP（${set}）`, category: 'gwp', gas: blend, gwp_set: set, value: v, unit: 'kgCO2e/kg', valid_from: '1900-01-01',
        source: `${src}；組成依 ASHRAE Standard 34`, note: `加權：${Object.entries(comp).map(([g, w]) => `${g}×${w}`).join(' + ')}` });
    }
  }
  return out;
}

// 電力排放係數：經濟部能源署每年公告前一年度數值。只放確定的年度，其餘由後台新增
export function electricityFactors() {
  const src = '經濟部能源署公告「電力排放係數」';
  return [
    [2021, 0.509], [2022, 0.495], [2023, 0.494], [2024, 0.474],
  ].map(([y, v]) => ({ code: `ef.electricity.${y}`, name: `${y - 1911} 年度電力排放係數`, category: 'emission', gas: 'CO2e', value: v, unit: 'kgCO2e/kWh',
    applies_to: 'electricity', valid_from: `${y}-01-01`, valid_to: `${y}-12-31`, source: src }));
}

// 化糞池：環境部溫室氣體盤查指引常用參數（BOD 每人每日、最大甲烷產生量、化糞池 MCF）
export function septicFactors() {
  const src = 'IPCC 2006 Vol.5 Ch.6（Bo 0.6 kgCH4/kgBOD；化糞池 MCF 0.5）；BOD 負荷依環境部盤查指引常用值，請依院方採用指引核對';
  return [
    { code: 'septic.bod_g_per_person_day', name: '每人每日 BOD 負荷', category: 'other', value: 40, unit: 'g/person_day', source: src, valid_from: '1900-01-01' },
    { code: 'septic.bo', name: '最大甲烷產生量 Bo', category: 'other', gas: 'CH4', value: 0.6, unit: 'kgCH4/kgBOD', source: src, valid_from: '1900-01-01' },
    { code: 'septic.mcf', name: '化糞池甲烷修正因子 MCF', category: 'other', value: 0.5, unit: 'ratio', source: src, valid_from: '1900-01-01' },
  ];
}

export function allSeedFactors() {
  return [...fuelFactors(), ...gwpFactors(), ...electricityFactors(), ...septicFactors()];
}
