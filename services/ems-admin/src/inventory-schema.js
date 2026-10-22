// 能源盤點（貼紙點位＋三類填報）的欄位規格與驗證。唯一真實來源。
//
// 三類固定名稱：初始建檔（site＋設備主檔）／定期更新（點位紀錄）／異動登錄（changes）。
// 欄位依據是 docs/energy-audit-spec.md（附表三 表三、四、七、八、九；R1／R2）。
// 前端所有表單都從 GET /api/inv/spec 長出來——新增欄位只改這支，不改前端。
//
// 為什麼點位項目要分「類型」而不是寫死表單：各院點位五花八門（電表、水表、冰水主機、
// 電費單），院方要能在管理端自己加點位、改欄位。寫死一次就要改一次程式。
import { z } from 'zod';
import { coerce, blockById, pendingCells, validateAudit } from './audit-schema.js';

// ── 欄位型別（site 區塊與設備主檔共用）──
// year：西元年；輸入 3 位數以下視為民國年自動 +1911（各表原文多用民國年，院方兩種都會填）。
// ref：連到另一個 site 表格的某一筆（f.ref＝區塊 id，目前只有 'buildings'），存的是那一筆的 id。
//      舊資料存的是名稱文字：讀取時用名稱（或編號）對回 id，對不上就保留原文字、列入待修（siteRefIssues）。
export const FIELD_TYPES = ['text', 'number', 'percent', 'month', 'date', 'year', 'select', 'multiselect', 'boolean', 'ref'];

const YES = { type: 'boolean' };

// ── 依據（工作清單第 21 項）──
// 畫面與報表都從這裡讀，不在前端另寫一份：依據寫兩處，改版時一定只改到一處。
// 形狀固定 { doc, ref?, law?, note? }；章節對照 docs/energy-audit-spec.md。
const LAW_ANNEX3 = '經能字第 11558000090 號';     // 115-01-23 附表三修正
const LAW_DIAG = '經能字第 11558001660 號';       // 115-05-18 節能診斷及節能計畫規定
const LAW_TARGET = '經能字第 11358040450 號';     // 114–117 年節約能源目標及執行計畫規定
// spec：docs/energy-audit-spec.md 的章節（與 public/inventory-compute.js 的 source 同形）
const A3_SPEC = { 表三: '§5.3', 表四: '§5.4', 表五: '§5.5', 表七: '§5.7', 表八: '§5.8', 表九: '§5.9', 一: '§5.1–5.2', 前言: '§5.0' };
const A3 = (ref, note) => {
  const k = Object.keys(A3_SPEC).find((x) => ref.startsWith(x));
  return { doc: '附表三', ref, law: LAW_ANNEX3, ...(k ? { spec: A3_SPEC[k] } : {}), ...(note ? { note } : {}) };
};
export const SOURCES = { LAW_ANNEX3, LAW_DIAG, LAW_TARGET };

// ════════════════════════════════════════════════════════════════
// 初始建檔：site 各區塊
// ════════════════════════════════════════════════════════════════

// 表三 能源用戶基本資料（01–25）＋表八的單值部分（功因改善、總盤抄表）
const BASIC_FIELDS = [
  { key: 'fillDate', label: '填表日期', type: 'date', group: '表三 填表' },
  { key: 'hqName', label: '總公司名稱', type: 'text', group: '表三 總公司', code: '01' },
  { key: 'hqTaxId', label: '總公司統一編號', type: 'text', group: '表三 總公司', code: '02' },
  { key: 'hqRep', label: '代表人', type: 'text', group: '表三 總公司', code: '03' },
  { key: 'hqRepTitle', label: '代表人職稱', type: 'text', group: '表三 總公司', code: '04' },
  { key: 'hqAddress', label: '總公司地址', type: 'text', group: '表三 總公司', code: '05' },
  { key: 'userNo', label: '用戶編號', type: 'text', group: '表三 能源用戶', code: '06' },
  { key: 'userName', label: '用戶名稱', type: 'text', required: true, group: '表三 能源用戶', code: '07' },
  { key: 'owner', label: '負責人', type: 'text', group: '表三 能源用戶', code: '08' },
  { key: 'ownerTitle', label: '負責人職稱', type: 'text', group: '表三 能源用戶', code: '09' },
  { key: 'taxId', label: '統一編號', type: 'text', group: '表三 能源用戶', code: '10' },
  { key: 'userCategory', label: '用戶分類', type: 'select', options: ['醫院', '辦公大樓', '學校', '其他'], default: '醫院', group: '表三 能源用戶', code: '11' },
  { key: 'industry', label: '行業編號及分類', type: 'text', group: '表三 能源用戶', code: '12' },
  { key: 'siteAddress', label: '能源使用地址', type: 'text', required: true, group: '表三 能源用戶', code: '13' },
  { key: 'contactAddress', label: '用戶聯絡地址', type: 'text', group: '表三 能源用戶', code: '14' },
  // 新版附表三把舊第 11 欄「電號」移出，改成獨立的「電號資料（含合併申報）」表＝下面的 meters 區塊
  { key: 'beds', label: '營業規模', type: 'number', unit: '床', required: true, group: '表三 規模', code: '15', hint: '醫院填病床數，必填（R9）' },
  { key: 'employees', label: '員工人數', type: 'number', unit: '人', group: '表三 規模', code: '16', hint: '醫院填陳報衛福部之執業醫事人員總數' },
  { key: 'workHours', label: '全年工作時數', type: 'number', unit: '小時/年', group: '表三 規模', code: '17' },
  { key: 'floorArea', label: '總樓地板面積', type: 'number', unit: 'm²', required: true, group: '表三 規模', code: '18', hint: '須附佐證；EUI 的分母' },
  { key: 'acArea', label: '總空調使用面積', type: 'number', unit: 'm²', group: '表三 規模', code: '19' },
  { key: 'parkingArea', label: '總室內停車場面積', type: 'number', unit: 'm²', group: '表三 規模', code: '20', hint: '室內面積＝總樓地板－室內停車場' },
  { key: 'energyCost', label: '總能源費用', type: 'number', unit: '萬元/年', group: '表三 規模', code: '21' },
  { key: 'revenue', label: '營業額', type: 'number', unit: '百萬元/年', group: '表三 規模', code: '22' },
  { key: 'energyCostRatio', label: '總能源費用占總支出比例', type: 'percent', unit: '%', group: '表三 規模', code: '23' },
  { key: 'occupancy', label: '出租率', type: 'percent', unit: '%', group: '表三 規模', code: '24', hint: '僅辦公大樓必填' },
  { key: 'isSme', label: '是否為中小企業', type: 'select', options: ['是', '否'], default: '否', group: '表三 規模', code: '25', hint: '公務機關、國防組織填「否」' },

  { key: 'pfAutoController', label: '功因自動調整器', type: 'select', options: ['有', '無'], group: '表八 功因改善' },
  { key: 'capacitorKvar', label: '電容器量', type: 'number', unit: 'kVar', group: '表八 功因改善' },
  { key: 'panelKv', label: '總盤電壓', type: 'number', unit: 'kV', group: '表八 總盤抄表' },
  { key: 'panelA', label: '總盤電流', type: 'number', unit: 'A', group: '表八 總盤抄表' },
  { key: 'panelPf', label: '總盤功因', type: 'percent', unit: '%', group: '表八 總盤抄表', hint: '合理值 > 95%' },
  { key: 'panelHvKvar', label: '高壓電容器量', type: 'number', unit: 'kVar', group: '表八 總盤抄表' },
];

// 電號（表五之二的表頭；合併申報清單也從這裡來）
const METER_FIELDS = [
  { key: 'seq', label: '序號', type: 'number', group: '電號資料' },
  { key: 'meterNo', label: '電號', type: 'text', required: true, group: '電號資料' },
  // 新版每個電號 5 種契約容量（舊版只有經常契約容量一欄）
  { key: 'contractKw', label: '經常契約容量', type: 'number', unit: 'kW', required: true, group: '契約容量', hint: 'R1：同一登記主體合計 > 800 瓩即為能源用戶' },
  { key: 'contractHalfPeakKw', label: '半尖峰／非夏月契約容量', type: 'number', unit: 'kW', group: '契約容量' },
  { key: 'contractSatHalfPeakKw', label: '週六半尖峰契約容量', type: 'number', unit: 'kW', group: '契約容量' },
  { key: 'contractOffPeakKw', label: '離峰契約容量', type: 'number', unit: 'kW', group: '契約容量' },
  { key: 'contractStandbyKw', label: '備用契約容量', type: 'number', unit: 'kW', group: '契約容量' },
  { key: 'combined', label: '合併申報', ...YES, group: '合併申報', hint: '須先依附錄二申請核准' },
  { key: 'combinedApproval', label: '合併申報核准文號', type: 'text', group: '合併申報' },
  { key: 'accountName', label: '戶名', type: 'text', group: '表五之二 表頭' },
  { key: 'tariffType', label: '契約用電別', type: 'text', group: '表五之二 表頭', hint: '例：高壓三段式時間電價' },
  { key: 'address', label: '用電地址', type: 'text', group: '表五之二 表頭' },
  { key: 'industry', label: '行業別', type: 'text', group: '表五之二 表頭' },
  { key: 'note', label: '備註', type: 'text', group: '表五之二 表頭' },
];

// 表七 建築資料
const BUILDING_FIELDS = [
  { key: 'code', label: '編號', type: 'text' },
  { key: 'name', label: '建築名稱', type: 'text', required: true, hint: '設備主檔用這個名稱對應，表九須一致' },
  { key: 'userCategory', label: '用戶分類', type: 'text' },
  { key: 'builtYear', label: '建造年份', type: 'year', hint: '民國或西元皆可' },
  { key: 'basementFloors', label: '地下樓層', type: 'number', unit: '層' },
  { key: 'aboveFloors', label: '地上樓層', type: 'number', unit: '層' },
  { key: 'floorArea', label: '建築總樓地板面積', type: 'number', unit: 'm²' },
  { key: 'roof', label: '屋頂構造', type: 'text' },
  { key: 'entranceFacing', label: '建築入口大門方位', type: 'select', options: ['東', '西', '南', '北', '東北', '東南', '西北', '西南'] },
];

// 表八 變壓器規格＋尖峰抄表運轉值
const TRANSFORMER_FIELDS = [
  { key: 'building', label: '建築物名稱', type: 'ref', ref: 'buildings', hint: '從「建築資料」選，表七、表八、表九的建築名稱才會一致' },
  { key: 'code', label: '變壓器編號', type: 'text', required: true },
  { key: 'brand', label: '廠牌', type: 'text' },
  { key: 'madeYear', label: '製造年份', type: 'year' },
  { key: 'kva', label: '容量', type: 'number', unit: 'kVA', required: true },
  { key: 'type', label: '型式', type: 'select', options: ['乾式', '油式', '非晶質式'] },
  { key: 'primaryKv', label: '一次側電壓', type: 'number', unit: 'kV' },
  { key: 'secondaryV', label: '二次側電壓', type: 'number', unit: 'V' },
  { key: 'circuit', label: '迴路名稱', type: 'text' },
  { key: 'loadDesc', label: '負載概述', type: 'text' },
  { key: 'efficiency', label: '效率', type: 'percent', unit: '%' },
  { key: 'opTempC', label: '運轉溫度', type: 'number', unit: '℃', group: '尖峰抄表' },
  { key: 'opPrimaryKv', label: '一次側實際電壓', type: 'number', unit: 'kV', group: '尖峰抄表' },
  { key: 'opSecondaryV', label: '二次側實際電壓', type: 'number', unit: 'V', group: '尖峰抄表' },
  { key: 'opMaxA', label: '二次側最大負載電流', type: 'number', unit: 'A', group: '尖峰抄表' },
  { key: 'opPf', label: '功因', type: 'percent', unit: '%', group: '尖峰抄表', hint: '合理值 > 95%' },
  { key: 'opMaxKw', label: '最大負載', type: 'number', unit: 'kW', group: '尖峰抄表' },
  { key: 'opLoadRate', label: '負載率', type: 'percent', unit: '%', group: '尖峰抄表', hint: '合理 50–75%' },
];

// 表八 緊急發電機（1–5 台）
const GENERATOR_FIELDS = [
  { key: 'code', label: '發電機編號', type: 'text', required: true },
  { key: 'kva', label: '容量', type: 'number', unit: 'kVA', required: true },
  { key: 'voltageV', label: '電壓', type: 'number', unit: 'V' },
];

// 一、填表人員／二、其他技師或能管人員（個資，只在主機本地）
const STAFF_FIELDS = [
  { key: 'role', label: '身分', type: 'select', required: true, options: ['填表人員', '其他技師或能管人員'] },
  { key: 'registered', label: '已完成技師或能管人員設置登記', ...YES },
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'unitTitle', label: '單位／職稱', type: 'text' },
  { key: 'regNo', label: '設置登記核准編號', type: 'text' },
  { key: 'regDate', label: '登記日期', type: 'date' },
  { key: 'inHouse', label: '自置人員', ...YES, hint: 'R9：契約容量 > 100,000 瓩須 ≥2 名、≥1 名自置' },
  { key: 'active', label: '仍執行能源管理業務', ...YES },
  { key: 'address', label: '聯絡地址', type: 'text' },
  { key: 'phone', label: '電話／分機', type: 'text' },
  { key: 'mobile', label: '手機', type: 'text' },
  { key: 'fax', label: '傳真／分機', type: 'text' },
  { key: 'email', label: '電子郵件', type: 'text' },
  {
    key: 'unregisteredReasons', label: '未設置原因', type: 'multiselect', hint: '未完成設置登記時填',
    // 新版不再填原能管員姓名，只勾「原能管員已不在職」再選現況
    options: ['原能管員已不在職', '登記辦理中', '參訓未通過', '無符合參訓資格人員', '欲委託尚未找到', '本年度首次申報', '不清楚規定', '其他'],
  },
  { key: 'certNo', label: '合格證書文號', type: 'text', hint: '未設置原因為「登記辦理中」時填' },
  { key: 'followUp', label: '後續改善方式', type: 'select', options: ['已規劃派員參訓', '將委託技師或合格能管人員'] },
];

// 表四之一 能源查核組織
const ORG_FIELDS = [
  { key: 'level', label: '類別', type: 'select', required: true, options: ['管理', '推行', '執行'], hint: '三階層須齊全；管理不得兼推行或執行' },
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'title', label: '職稱', type: 'text' },
  { key: 'duties', label: '實際年度工作內容', type: 'text' },
];

// 表四之二 能源政策
const EMIS_SYSTEMS = ['電力', '空調', '空壓', '照明', '冷凍冷藏', '送排風', '給水污水', '鍋爐', '熱泵', '其他'];
const POLICY_FIELDS = [
  { key: 'iso50001', label: '已通過 ISO/CNS 50001', ...YES, hint: '是 → 第 2–5 題免填' },
  { key: 'isoBody', label: '驗證機構', type: 'text' },
  { key: 'isoValidUntil', label: '證書效期', type: 'date', hint: '到期前會提醒' },
  { key: 'q2PolicyStatement', label: '高階主管對外發布能源政策聲明', ...YES },
  { key: 'q3Review', label: '定期檢討節能成效並留紀錄', ...YES },
  { key: 'q4Procurement', label: '採購優先高效率設備', ...YES },
  { key: 'q5Channel', label: '員工或供應商節能建議溝通管道', ...YES },
  { key: 'emis', label: '裝設能源管理資訊系統（EMIS）', ...YES },
  { key: 'emisSystems', label: 'EMIS 監控系統', type: 'multiselect', options: EMIS_SYSTEMS },
];

// R1 能源用戶判定／R2 排除條件
export const EXEMPTION_CODES = [
  // 業主 2026-10-22 確認：國軍醫院是主要執行單位，不屬「國軍部隊用戶」。
  // 保留在清單裡讓畫面說得清楚為什麼沒得選，但不放進可選的 options。
  { code: 'EX01', label: '國軍部隊用戶', applicable: false, note: '國軍醫院不適用（業主 2026-10-22 確認）' },
  { code: 'EX02', label: '車道及隧道用電用戶' },
  { code: 'EX03', label: '專供軌道車輛牽引用電用戶' },
  { code: 'EX04', label: '港埠裝卸作業用電用戶' },
  { code: 'EX05', label: '廣播電臺用電用戶' },
  { code: 'EX06', label: '專供營繕工程施工用電用戶' },
  { code: 'EX07', label: '臨時用電用戶' },
  { code: 'EX08', label: '能源使用說明書新設用戶（核准日起 5 年內）' },
  { code: 'EX09', label: '適用電動車充換電設施電價之用戶' },
  { code: 'EX10', label: '取得 ISO/CNS 50001 證書且每年提供有效證書' },
  { code: 'EX11', label: '其他經中央主管機關認定之用戶' },
];
const EXEMPTION_FIELDS = [
  { key: 'combinedContractKw', label: '同一登記主體契約容量合計', type: 'number', unit: 'kW', hint: 'R1；留白則以「電號」區塊加總' },
  { key: 'exempt', label: '符合排除條件', ...YES },
  { key: 'exemptCode', label: '排除條件', type: 'select', options: EXEMPTION_CODES.filter((e) => e.applicable !== false).map((e) => e.code), optionLabels: Object.fromEntries(EXEMPTION_CODES.map((e) => [e.code, e.label])) },
  { key: 'reason', label: '理由', type: 'text', hint: '符合排除條件時必填' },
  { key: 'evidence', label: '佐證文件', type: 'text' },
  { key: 'approvalDate', label: '能源使用說明書核准日', type: 'date', hint: 'EX08：自動算 5 年到期日' },
  { key: 'isoValidUntil', label: 'ISO 50001 證書效期', type: 'date', hint: 'EX10：到期提醒' },
];

// 欄位群（field.group）各自的依據。未列到的群組沿用區塊的 source。
function groupsOf(fields, map) {
  const names = [...new Set(fields.map((f) => f.group || ''))];
  return names.map((name) => ({ name, source: map[name] || null }));
}

// kind：form＝單一物件；table＝多筆（每筆自帶 id，供點位項目 meterId 等連結）
export const SITE_BLOCKS = [
  { id: 'basic', label: '能源用戶基本資料', source: A3('表三、表八'), kind: 'form', fields: BASIC_FIELDS,
    groups: groupsOf(BASIC_FIELDS, { '表三 填表': A3('表三'), '表三 總公司': A3('表三 01–05'), '表三 能源用戶': A3('表三 06–14'), '表三 規模': A3('表三 15–25', '營業規模醫院必填（R9）；出租率僅辦公大樓；第 25 欄中小企業為新版新增'), '表八 功因改善': A3('表八 功因改善'), '表八 總盤抄表': A3('表八 總盤抄表', '功因合理值 > 95%（R9）') }) },
  { id: 'meters', label: '電號', source: A3('表三 電號資料（含合併申報）', '每個電號 5 種契約容量；表五之二每電號一張'), kind: 'table', rowLabel: '電號', fields: METER_FIELDS,
    groups: groupsOf(METER_FIELDS, { 電號資料: A3('表三 電號資料（含合併申報）'), 契約容量: A3('表三 電號資料（含合併申報）', '經常、半尖峰/非夏月、週六半尖峰、離峰、備用'), 合併申報: { doc: '附表三', ref: '附錄二 合併申報申請表', law: LAW_ANNEX3, spec: '§5.12', note: '同址多電號，或相鄰不同地址且用電無法分割' }, '表五之二 表頭': A3('表五之二') }) },
  { id: 'buildings', label: '建築資料', source: A3('表七', '建築名稱須與表九一致'), kind: 'table', rowLabel: '建築', fields: BUILDING_FIELDS },
  { id: 'transformers', label: '變壓器', source: A3('表八 變壓器規格'), kind: 'table', rowLabel: '變壓器', fields: TRANSFORMER_FIELDS,
    groups: groupsOf(TRANSFORMER_FIELDS, { '': A3('表八 變壓器規格'), '尖峰抄表': A3('表八 變壓器運轉值', '負載率合理 50–75%、功因 > 95%（R9）') }) },
  { id: 'generators', label: '緊急發電機', source: A3('表八 緊急發電機', '1–5 台'), kind: 'table', rowLabel: '發電機', max: 5, fields: GENERATOR_FIELDS },
  { id: 'staff', label: '能管人員', source: A3('一、填表人員；二、其他技師或能管人員', '契約容量 > 100,000 瓩須 ≥2 名、≥1 名自置（R9）'), kind: 'table', rowLabel: '人員', private: true, fields: STAFF_FIELDS },
  { id: 'org', label: '能源查核組織', source: A3('表四之一', '管理／推行／執行三階層須齊全；管理不得兼推行或執行'), kind: 'table', rowLabel: '成員', fields: ORG_FIELDS },
  { id: 'policy', label: '能源政策', source: A3('表四之二', '已通過 ISO 50001 → 第 2–5 題免填（R9）'), kind: 'form', fields: POLICY_FIELDS },
  { id: 'exemption', label: '能源用戶判定與排除條件', source: { doc: '114–117 年節約能源目標及執行計畫規定', ref: 'R1 能源用戶判定、R2 排除條件', law: LAW_TARGET, spec: '§2', note: '契約用電容量 > 800 瓩；同一商工登記主體合併計算。國軍醫院不適用 EX01（業主 2026-10-22 確認）' }, kind: 'form', fields: EXEMPTION_FIELDS },
];
export const siteBlockById = (id) => SITE_BLOCKS.find((b) => b.id === id) || null;

// ════════════════════════════════════════════════════════════════
// 設備主檔（＝表九清冊）。設備只建一次檔，診斷報告從這裡挑設備帶入。
// 欄位上的 kinds：只有這些 kind 才顯示／接受該欄（例：節能標章只問箱窗分離式）。
// ════════════════════════════════════════════════════════════════
const ENERGY_TYPES = ['電力', '燃料油', '液化石油氣', '天然氣', '汽油', '柴油', '其他'];
const PACKAGED = ['箱型冷氣', '窗型冷氣', '分離式冷氣'];
const AC_MOTOR = ['冰水泵', '冷卻水泵', '區域水泵', '冷卻水塔', '空調箱', '小型送風機'];
const MOTOR_FIELDS = (kinds) => [
  { key: 'motorIE', label: '馬達效率等級', type: 'select', options: ['IE1', 'IE2', 'IE3', 'IE4'], group: '馬達資料', kinds },
  { key: 'motorKw', label: '馬達功率', type: 'number', unit: 'kW', group: '馬達資料', kinds },
  { key: 'motorHp', label: '馬力', type: 'number', unit: 'HP', group: '馬達資料', kinds },
  { key: 'motorPoles', label: '極數', type: 'number', unit: '極', group: '馬達資料', kinds },
  { key: 'motorEff', label: '額定效率', type: 'percent', unit: '%', group: '馬達資料', kinds },
];

const AC_FIELDS = [
  { key: 'name', label: '設備名稱', type: 'text', required: true, hint: '貼紙頁只顯示這個名稱' },
  { key: 'deviceNo', label: '設備編號', type: 'text' },
  { key: 'brand', label: '廠牌', type: 'text' },
  { key: 'chillerGroup', label: '冰水機群組名稱', type: 'text', hint: '表九之一（一）；群組主機總容量 ≥ 1,000 RT 須填群組效率', source: A3('表九之一（一）（二）', '單一群組主機總容量 ≥ 1,000 冷凍噸必填群組效率（R9）') },
  { key: 'model', label: '型式', type: 'text' },
  { key: 'inverter', label: '變頻控制', ...YES },
  { key: 'energyLabel', label: '節能標章', ...YES, kinds: PACKAGED },
  { key: 'efficiencyGrade', label: '能源效率等級', type: 'select', options: ['1', '2', '3', '4', '5'], kinds: PACKAGED },
  { key: 'registrationNo', label: '登錄編號', type: 'text', kinds: PACKAGED },
  { key: 'powerKw', label: '設備電功率', type: 'number', unit: 'kW', required: true },
  { key: 'madeYear', label: '製造年份', type: 'year', required: true, hint: '算機齡（R6 必列汰換）', source: { doc: '附件一', ref: '註 2', law: LAW_DIAG, spec: '§3.2（R6）', note: '公用設備超過 10 年應列設備汰換表' } },
  { key: 'capacity', label: '設備容量', type: 'number' },
  { key: 'capacityUnit', label: '容量單位', type: 'text', hint: '例：RT、kW、CMH' },
  { key: 'qty', label: '現有數量', type: 'number', unit: '台', required: true },
  { key: 'hoursPerYear', label: '運轉時數', type: 'number', unit: 'h/年' },
  { key: 'energyType', label: '使用能源種類', type: 'select', options: ENERGY_TYPES, default: '電力' },
  { key: 'voltageV', label: '電壓', type: 'number', unit: 'V' },
  ...MOTOR_FIELDS(AC_MOTOR),
];

const LIGHTING_FIELDS = [
  { key: 'name', label: '設備名稱', type: 'text', required: true, hint: '貼紙頁只顯示這個名稱，例：B1 停車場 LED' },
  { key: 'brand', label: '廠牌', type: 'text' },
  { key: 'area', label: '裝設區域', type: 'text' },
  { key: 'tubeType', label: '燈管型式', type: 'text' },
  { key: 'spec', label: '容量規格', type: 'text', hint: '例：20W×4' },
  { key: 'ballast', label: '安定器型式', type: 'text' },
  { key: 'wattPerFixture', label: '燈具電功率', type: 'number', unit: 'W/具', required: true },
  { key: 'madeYear', label: '製造年份', type: 'year', required: true, hint: 'R6：螢光燈具 > 2 年、LED > 8 年必列汰換', source: { doc: '附件一', ref: '註 2', law: LAW_DIAG, spec: '§3.2（R6）', note: '螢光燈具超過 2 年、LED 燈具超過 8 年應列設備汰換表' } },
  { key: 'qty', label: '現有數量', type: 'number', unit: '具', required: true },
  { key: 'hoursPerYear', label: '運轉時數', type: 'number', unit: 'h/年' },
];

const OTHER_FIELDS = [
  { key: 'name', label: '系統／設備名稱', type: 'text', required: true, hint: '貼紙頁只顯示這個名稱' },
  // 表九之三各系統的子類別（新版補列）；選項依 kind 而不同
  { key: 'subKind', label: '子類別', type: 'text', optionsByKind: {
    冷凍冷藏: ['冷凍設備', '冷藏設備', '其他'],
    事務設備: ['個人電腦含顯示器', '影印機', '飲水機', '其他'],
    送排風: ['停車場排風機', '屋頂抽排風機', '廚房抽排風機', '廁所排風機', '其他'],
    給水污水: ['污水排水', '給水', '其他'],
    電梯: ['病床梯', '客梯', '電扶梯', '貨梯', '其他'],
    鍋爐: ['蒸汽', '熱水', '其他'],
    熱泵: ['熱泵', '熱泵水泵', '熱泵輔助加熱器', '熱泵儲水槽'],
    壓縮空氣: ['空壓機', '冷凍式乾燥機', '吸附式乾燥機', '冷卻水泵', '冷卻水塔', '增壓機'],
    其他: ['電熱水器', '其他'],
  } },
  { key: 'deviceNo', label: '設備編號', type: 'text' },
  { key: 'brand', label: '廠牌', type: 'text' },
  { key: 'chillerGroup', label: '冰水機群組名稱', type: 'text' },
  // 型式的選項依 kind 而不同（鍋爐、熱泵有固定選項；其他自由填）
  { key: 'model', label: '型式', type: 'text', optionsByKind: {
    鍋爐: ['貫流式', '煙管式', '水管式', '其他'],
    熱泵: ['空氣源', '水源', '地熱源', '雙熱源'],
  } },
  { key: 'inverter', label: '變頻控制', ...YES, kinds: ['電梯'] },
  { key: 'regen', label: '電力回生裝置', ...YES, kinds: ['電梯'] },
  { key: 'powerKw', label: '設備電功率', type: 'number', unit: 'kW', required: true, hint: '鍋爐填送風機額定電功率' },
  { key: 'madeYear', label: '製造年份', type: 'year', required: true },
  { key: 'capacity', label: '設備容量', type: 'number' },
  { key: 'capacityUnit', label: '容量單位', type: 'text', hint: '鍋爐：公噸/小時或仟卡/小時' },
  { key: 'qty', label: '現有數量', type: 'number', unit: '台', required: true },
  { key: 'hoursPerYear', label: '運轉時數', type: 'number', unit: 'h/年' },
  { key: 'energyType', label: '使用能源種類', type: 'select', options: ENERGY_TYPES, default: '電力' },
  { key: 'voltageV', label: '電壓', type: 'number', unit: 'V' },
  // 馬達資料：泵浦、風車、電梯必填
  ...MOTOR_FIELDS(['送排風', '給水污水', '壓縮空氣', '冷凍冷藏', '電梯']),
  // 表九之六 鍋爐操作概況（新版「燃料種類」改「能源種類」，並新增電力）
  { key: 'inspectionNo', label: '構造檢查號碼', type: 'text', group: '鍋爐操作概況', kinds: ['鍋爐'] },
  { key: 'boilerEnergyType', label: '能源種類', type: 'select', options: ['燃料油', '液化石油氣', '天然氣', '柴油', '電力'], group: '鍋爐操作概況', kinds: ['鍋爐'] },
  { key: 'boilerAnnualUse', label: '年度使用量', type: 'number', group: '鍋爐操作概況', kinds: ['鍋爐'], hint: '單位依能源種類：燃料油、柴油 公秉；液化石油氣 公斤；天然氣 立方公尺；電力 度' },
  { key: 'boilerOpStatus', label: '操作狀態', type: 'select', options: ['正常使用中', '已無操作', '平時不使用設備維修時使用'], group: '鍋爐操作概況', kinds: ['鍋爐'] },
];

export const EQUIPMENT_CATEGORIES = [
  {
    id: 'ac', label: '空調設備', source: A3('表九之一（三）', '節能標章、能源效率等級、登錄編號僅箱型、窗型、分離式'),
    kinds: ['中央空調主機', '儲冰槽', '冰水泵', '冷卻水泵', '區域水泵', '冷卻水塔', '空調箱', '小型送風機', '箱型冷氣', '窗型冷氣', '分離式冷氣', '空調加熱設備', '其他'],
    fields: AC_FIELDS,
    groups: groupsOf(AC_FIELDS, { '': A3('表九之一（三）'), 馬達資料: A3('表九之一（三）', '馬達資料限泵浦、風車類') }),
  },
  {
    id: 'lighting', label: '照明', source: A3('表九之二'),
    kinds: ['日光燈', '省電燈泡', '鹵素燈', '複金屬燈', '高壓鈉燈', '高壓水銀燈', 'LED', '其他'],
    fields: LIGHTING_FIELDS,
    groups: groupsOf(LIGHTING_FIELDS, { '': A3('表九之二') }),
  },
  {
    id: 'other', label: '其他系統', source: A3('表九之三', '鍋爐、熱泵型式有固定選項；變頻與電力回生僅電梯'),
    kinds: ['冷凍冷藏', '事務設備', '送排風', '給水污水', '電梯', '鍋爐', '熱泵', '壓縮空氣', '其他'],
    fields: OTHER_FIELDS,
    groups: groupsOf(OTHER_FIELDS, { '': A3('表九之三'), 馬達資料: A3('表九之三', '泵浦、風車、電梯必填'), 鍋爐操作概況: A3('表九之六', '能源種類含電力（新版）') }),
  },
];
export const categoryById = (id) => EQUIPMENT_CATEGORIES.find((c) => c.id === id) || null;
export const EQUIPMENT_STATUS = { active: '使用中', replaced: '已汰換', removed: '已移除' };

// ── 表九之一（二）冰水機群組系統效率（逐月）──
// 不在 site／設備主檔裡（它是每月的量測結果），欄位規格放這裡給報表與點位項目共用。
// 存放方式：不另建月表，從點位紀錄推導——點位項目標 chillerGroup＋chillerRole（kwh／rth），
// 報表把該群組、該月所有紀錄的值加總（reading 型取用量、number 型取數值）。建築取設備主檔同群組設備的建築。
export const CHILLER_GROUP_MONTH = {
  derivation: '點位項目 chillerGroup＋chillerRole（kwh／rth）；月值＝當月紀錄加總（reading 取用量、number 取數值）',
  source: A3('表九之一（二）', '單一群組冰水主機含備用機總容量 ≥ 1,000 RT 必填；逐時量測紀錄保存 ≥ 5 年'),
  fields: [
    { key: 'building', label: '建築名稱', type: 'text', required: true },
    { key: 'group', label: '冰水機群組名稱', type: 'text', required: true },
    { key: 'month', label: '月份', type: 'month', required: true },
    { key: 'kwh', label: '月耗電量', type: 'number', unit: 'kWh' },
    { key: 'rth', label: '系統負荷', type: 'number', unit: 'RTh' },
    { key: 'kwPerRt', label: '效率', type: 'number', unit: 'kW/RT', computed: '月耗電 ÷ 月負荷' },
    { key: 'remark', label: '備註', type: 'select', options: ['整月未開主機', '其他'], source: A3('表九之一（二）', '新版新增備註欄') },
    { key: 'remarkOther', label: '備註（其他）', type: 'text' },
  ],
};

// ── 節約能源措施代碼（附表三附錄一，§7.7）──
// 代碼＝系統類別碼＋設備類別碼＋節能方法碼（2 碼），例：AA06 中央空調主機汰舊換新。
// 申報表十／十一一律用這套官方代碼；附件一／二內部分類（C01…、A01…）是另一回事。
export const MEASURE_CODES = {
  source: { doc: '附表三', ref: '附錄一 節約能源措施代碼表', law: LAW_ANNEX3, spec: '§7.7' },
  systems: [
    { code: 'A', label: '空調', devices: ['中央空調主機', '儲冰槽', '冰水泵', '冷卻水泵', '區域水泵', '冷卻水塔', '空調箱', '小型送風機', '箱型冷氣', '窗型冷氣', '分離式冷氣', '空調加熱設備', '其他'] },
    { code: 'L', label: '照明', devices: ['日光燈', '省電燈泡', '鹵素燈', '複金屬燈', '高壓鈉燈', '高壓水銀燈', '電子安定器', '自然採光', '控制開關', '其他'] },
    { code: 'F', label: '冷凍冷藏', devices: ['冷凍', '冷藏', '其他'] },
    { code: 'R', label: '事務', devices: ['個人電腦', '影印機', '飲水機', '其他'] },
    { code: 'B', label: '送排風', devices: ['停車場排風機', '屋頂抽排風機', '廚房抽排風機', '廁所排風機', '其他'] },
    { code: 'W', label: '給水污水', devices: ['污水排水', '給水', '其他'] },
    { code: 'E', label: '電梯', devices: ['病床梯', '客梯', '電扶梯', '貨梯', '其他'] },
    { code: 'O', label: '其他設備', devices: ['蒸汽鍋爐', '電熱水器', '熱泵熱水系統', '製程', '其他'] },
    { code: 'P', label: '電力系統', devices: ['供電負載', '變壓器', '功因改善進相電容器', '緊急發電機'] },
  ].map((s) => ({ ...s, devices: s.devices.map((label, i) => ({ code: String.fromCharCode(65 + i), label })) })),
  methods: Object.entries({
    '00': '能源管理', '01': '系統整合', '02': '可停電力', '03': '負載需量調整', '04': '新設或增設', '05': '設備改善', '06': '汰舊換新',
    '07': '增設監控系統控制', '08': '操作調整', '09': '保養維修', '10': '廢棄物利用', '11': '熱回收', '12': '水回收',
    '20': '採用變頻器', '21': '增設儲冰系統', '22': '加強保溫', '23': '外氣冷房', '24': '溫度合理調整與控制', '25': '台數控制',
    '26': '採用熱泵加熱系統', '27': '加強散熱效果', '31': '採用電子安定器', '32': '採用調光電子安定器', '33': '採用省電燈泡',
    '34': '採用高效率三波長燈管', '35': '採用高效率光源', '36': '採用時間開關', '37': '採用照度開關', '38': '採用紅外線開關',
    '39': '採用二線式照明控制開關', '40': '採用自然採光', '51': '採用太陽能電池', '52': '採用隔熱貼紙', '53': '採用液晶顯示器',
    '54': '採用省電模式', '61': '契約容量合理化調整', '62': '採用功因調整器', '63': '採用電壓調整器', '99': '其他節能措施',
  }).map(([code, label]) => ({ code, label })),
};
export function isMeasureCode(code) {
  const m = /^([A-Z])([A-Z])(\d{2})$/.exec(String(code || ''));
  if (!m) return false;
  const sys = MEASURE_CODES.systems.find((s) => s.code === m[1]);
  return Boolean(sys?.devices.some((d) => d.code === m[2]) && MEASURE_CODES.methods.some((x) => x.code === m[3]));
}

// ════════════════════════════════════════════════════════════════
// 點位與項目類型（定期更新）
// ════════════════════════════════════════════════════════════════
export const DEFAULT_STATUS_OPTIONS = ['正常', '異常', '停機'];
// 選到這個值就開一筆「未結異常」。自訂 options 時請保留「異常」這個字，否則不會進未結清單。
export const ANOMALY_VALUE = '異常';
export const ANOMALY_NOTE_MSG = '設備回報異常時請在備註寫明狀況';

export const ITEM_TYPES = [
  { id: 'reading', label: '累計讀數', hint: '電表、水表的累計值；系統自動算本次用量，讀數倒退會擋下', valueType: 'number', usesUnit: true, usesWarnPct: true, source: A3('表五之二', '用電度數；水表讀數為院內水足跡紀錄（非附表三欄位）') },
  { id: 'status', label: '設備狀態', hint: `預設 ${DEFAULT_STATUS_OPTIONS.join('／')}；選「${ANOMALY_VALUE}」會列入未結異常`, valueType: 'select', usesOptions: true, source: A3('表九之五', '重大使用能源設備之操作管理與維護現況') },
  { id: 'bill', label: '電費單', hint: '拍照自動解析，逐格確認後才能送出', valueType: 'bill', source: A3('表五之二', '依帳單逐月填：契約容量、最高需量、用電度數、功因、總電費') },
  { id: 'number', label: '一般數值', hint: '例：出水溫度、壓力', valueType: 'number', usesUnit: true, source: { doc: '院內紀錄', note: '依點位設定，非申報表固定欄位' } },
  { id: 'text', label: '文字', valueType: 'text', source: { doc: '院內紀錄' } },
  { id: 'photo', label: '照片', hint: '值是上傳後拿到的照片 id 陣列', valueType: 'photos', source: { doc: '附表三', ref: '前言', law: LAW_ANNEX3, note: '佐證留存' } },
];
const ITEM_TYPE_IDS = ITEM_TYPES.map((t) => t.id);

export const DOMAINS = { power: { letter: 'E', label: '電' }, water: { letter: 'W', label: '水' } };
const LETTER_TO_DOMAIN = { E: 'power', W: 'water' };

// 點位代碼：<hid>-<E|W><兩位數>，以最後一個 '-' 切出 hid（hid 本身可以含 '-'）
const RE_CODE = /^([A-Za-z0-9_-]+)-([EW])(\d{2})$/;
export function parseCode(code) {
  const m = RE_CODE.exec(String(code || ''));
  if (!m) return null;
  return { hid: m[1], letter: m[2], num: Number(m[3]), domain: LETTER_TO_DOMAIN[m[2]] };
}
export function makeCode(hid, domain, num) {
  return `${hid}-${DOMAINS[domain].letter}${String(num).padStart(2, '0')}`;
}

const itemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, '項目代號只能用英數、底線、連字號（最多 40 字）'),
  label: z.string().trim().min(1, '項目名稱必填').max(60),
  type: z.enum(ITEM_TYPE_IDS, { errorMap: () => ({ message: `項目類型須為 ${ITEM_TYPE_IDS.join('／')}` }) }),
  unit: z.string().max(20).optional(),
  equipmentId: z.string().max(60).optional(),
  meterId: z.string().max(60).optional(),
  options: z.array(z.string().trim().min(1).max(20)).min(2).max(12).optional(),
  warnPct: z.number().positive().max(10000).optional(),
  required: z.boolean().optional(),
  // 表九之一（二）冰水機群組月效率（報表從點位紀錄推導）：標示這個項目屬於哪個冰水機群組、
  // 量的是月耗電量（kwh）還是系統負荷（rth）。2026-10-22 報表項目新增，舊點位沒有這兩個鍵也照常通過。
  chillerGroup: z.string().trim().min(1).max(60).optional(),
  chillerRole: z.enum(['kwh', 'rth']).optional(),
}).strict();

const pointSchema = z.object({
  code: z.string(),
  domain: z.enum(['power', 'water']),
  name: z.string().trim().min(1, '點位名稱必填').max(60),
  location: z.string().max(120).default(''),
  items: z.array(itemSchema).min(1, '點位至少要有一個項目').max(30),
  active: z.boolean().default(true),
}).strict();

const zodErrors = (r) => r.error.issues.map((i) => `${i.path.join('.') || '（整體）'}：${i.message}`);

// 驗證點位；inv 用來檢查 equipmentId／meterId 是否真的存在（連到不存在的設備，貼紙頁會顯示空名稱）
export function validatePoint(point, inv) {
  const r = pointSchema.safeParse(point);
  if (!r.success) return { ok: false, errors: zodErrors(r) };
  const p = r.data;
  const errors = [];
  const c = parseCode(p.code);
  if (!c) errors.push(`點位代碼格式錯誤：${p.code}（應為 <院所>-E07 這種形式）`);
  else if (c.domain !== p.domain) errors.push(`點位代碼 ${p.code} 的字母與類別不符（E＝電、W＝水）`);
  const ids = new Set();
  for (const it of p.items) {
    if (ids.has(it.id)) errors.push(`項目代號重複：${it.id}`);
    ids.add(it.id);
    if (it.options && it.type !== 'status') errors.push(`「${it.label}」不是狀態型，不能設定選項`);
    if (it.warnPct !== undefined && it.type !== 'reading') errors.push(`「${it.label}」不是累計讀數，不能設定用量警示`);
    if ((it.chillerGroup || it.chillerRole) && !(it.chillerGroup && it.chillerRole)) errors.push(`「${it.label}」冰水機群組與量測角色（kwh／rth）要一起設定`);
    if (it.chillerRole && it.type !== 'reading' && it.type !== 'number') errors.push(`「${it.label}」只有累計讀數或一般數值能標成冰水機群組的 kWh／RTh`);
    if (it.equipmentId && inv && !inv.equipment.some((e) => e.id === it.equipmentId)) errors.push(`「${it.label}」連結的設備不存在：${it.equipmentId}`);
    if (it.meterId && inv && !(inv.site.meters || []).some((m) => m.id === it.meterId)) errors.push(`「${it.label}」連結的電號不存在：${it.meterId}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, point: p };
}

export const itemOptions = (item) => (item.type === 'status' ? (item.options?.length ? item.options : DEFAULT_STATUS_OPTIONS) : undefined);

// ════════════════════════════════════════════════════════════════
// 欄位值驗證（site 區塊、設備主檔共用）
// ════════════════════════════════════════════════════════════════
const RE_MONTH = /^\d{4}-\d{2}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 單一欄位的正規化＋檢查。回傳 { value } 或 { error }；value 為 undefined 表示留白。
function normField(f, raw, kind) {
  if (raw === undefined || raw === null || raw === '') return { value: undefined };
  switch (f.type) {
    case 'number': case 'percent': {
      const n = typeof raw === 'number' ? raw : coerce(raw, 'number');
      if (typeof n !== 'number' || !Number.isFinite(n)) return { error: '必須是數字' };
      if (n < 0) return { error: '不可為負數' };
      return { value: n };
    }
    case 'year': {
      const s = String(raw).trim();
      if (!/^\d{2,4}$/.test(s)) return { error: '年份格式錯誤（填 2015 或民國 104）' };
      const y = s.length <= 3 ? Number(s) + 1911 : Number(s);
      if (y < 1900 || y > 2100) return { error: '年份不合理' };
      return { value: y };
    }
    case 'month': { const v = coerce(raw, 'month'); return RE_MONTH.test(v) ? { value: v } : { error: '格式須為 YYYY-MM' }; }
    case 'date': { const v = coerce(raw, 'date'); return RE_DATE.test(v) ? { value: v } : { error: '格式須為 YYYY-MM-DD' }; }
    case 'boolean': return typeof raw === 'boolean' ? { value: raw } : { error: '必須是是／否' };
    case 'select': {
      const v = String(raw);
      return f.options.includes(v) ? { value: v } : { error: `不在選項內（${f.options.join('／')}）` };
    }
    case 'ref': {
      const v = String(raw).trim();
      if (v.length > 120) return { error: '超過 120 字' };
      return v ? { value: v } : { value: undefined };
    }
    case 'multiselect': {
      if (!Array.isArray(raw)) return { error: '必須是陣列' };
      const bad = raw.filter((x) => !f.options.includes(x));
      return bad.length ? { error: `不在選項內：${bad.join('、')}` } : { value: [...new Set(raw)] };
    }
    default: {
      const v = String(raw).trim();
      if (v.length > 500) return { error: '超過 500 字' };
      const opts = f.optionsByKind?.[kind];
      if (opts && !opts.includes(v)) return { error: `不在選項內（${opts.join('／')}）` };
      return v ? { value: v } : { value: undefined };
    }
  }
}

// 檢查一組欄位值。必填漏填只列 warnings（與健檢填報同一個判準：院方分次填完，硬擋只會逼出假資料）。
function checkFields(fields, values, where, kind) {
  const errors = [], warnings = [], out = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { errors: [`${where}資料格式錯誤`], warnings, values: out };
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(values)) {
    if (k === 'id') continue;
    const f = known.get(k);
    if (!f) { errors.push(`${where}不認得的欄位：${k}`); continue; }
    if (f.kinds && kind && !f.kinds.includes(kind) && values[k] !== undefined && values[k] !== '' && values[k] !== null) {
      errors.push(`${where}「${f.label}」不適用於「${kind}」`); continue;
    }
    const r = normField(f, values[k], kind);
    if (r.error) errors.push(`${where}「${f.label}」${r.error}`);
    else if (r.value !== undefined) out[k] = r.value;
  }
  for (const f of fields) {
    if (!f.required || (f.kinds && kind && !f.kinds.includes(kind))) continue;
    if (out[f.key] === undefined) warnings.push(`${where}「${f.label}」尚未填寫`);
  }
  return { errors, warnings, values: out };
}

// 驗證並正規化 site 的某區塊。table 的每筆保留／補上 id（點位項目的 meterId 靠它連結）。
// inv 有給時，ref 欄位（變壓器的建築）用名稱對回 id；對不上的保留原文字，只列 warning（待修，不擋存檔）。
export function validateSiteBlock(blockId, value, newId, inv) {
  const b = siteBlockById(blockId);
  if (!b) return { ok: false, errors: [`沒有這個區塊：${blockId}`], warnings: [] };
  if (b.kind === 'form') {
    const r = checkFields(b.fields, value, `${b.label}·`);
    return { ok: !r.errors.length, errors: r.errors, warnings: r.warnings, value: r.values };
  }
  if (!Array.isArray(value)) return { ok: false, errors: [`${b.label}必須是陣列`], warnings: [] };
  if (b.max && value.length > b.max) return { ok: false, errors: [`${b.label}最多 ${b.max} 筆`], warnings: [] };
  const errors = [], warnings = [], rows = [], ids = new Set();
  value.forEach((row, i) => {
    const r = checkFields(b.fields, row, `${b.label} 第 ${i + 1} 筆·`);
    errors.push(...r.errors); warnings.push(...r.warnings);
    let id = typeof row?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.id) ? row.id : newId(blockId);
    if (ids.has(id)) id = newId(blockId);
    ids.add(id);
    rows.push({ id, ...r.values });
  });
  if (inv) {
    // 這一次存的建築區塊（就是 buildings 本身時）以新值為準
    const site = blockId === 'buildings' ? { ...inv.site, buildings: rows } : inv.site;
    rows.forEach((row, i) => {
      for (const f of b.fields) {
        if (f.type !== 'ref' || row[f.key] === undefined) continue;
        const id = resolveRef(site, f.ref, row[f.key]);
        if (id) row[f.key] = id;
        else warnings.push(`${b.label} 第 ${i + 1} 筆·「${f.label}」對不到${siteBlockById(f.ref)?.label || f.ref}：${row[f.key]}（保留原文字，待修）`);
      }
    });
  }
  return { ok: !errors.length, errors, warnings, value: rows };
}

// ── ref 欄位（目前只有變壓器的建築物名稱 → buildings[].id）──
const refName = (row) => String(row?.name || row?.code || row?.id || '');
// 值是 id 就回 id；是名稱（或編號）且只對到一筆就回那筆的 id；否則 null
export function resolveRef(site, ref, v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const rows = Array.isArray(site?.[ref]) ? site[ref] : [];
  if (rows.some((r) => r.id === v)) return v;
  const t = v.trim();
  const hit = rows.filter((r) => String(r.name || '').trim() === t);
  const hits = hit.length ? hit : rows.filter((r) => String(r.code || '').trim() === t);
  return hits.length === 1 ? hits[0].id : null;
}
const refFields = () => SITE_BLOCKS.filter((b) => b.kind === 'table').flatMap((b) => b.fields.filter((f) => f.type === 'ref').map((f) => ({ b, f })));
// 讀取時把舊資料的名稱文字換成 id（直接改 inv；下一次寫入就落地）
export function resolveSiteRefs(inv) {
  for (const { b, f } of refFields()) {
    for (const row of inv.site?.[b.id] || []) {
      const v = row?.[f.key];
      if (typeof v !== 'string' || !v) continue;
      const id = resolveRef(inv.site, f.ref, v);
      if (id && id !== v) row[f.key] = id;
    }
  }
  return inv;
}
// 對不上的 ref（舊資料的名稱文字、或建築被刪掉）→ 管理端標「待修」
export function siteRefIssues(inv) {
  const out = [];
  for (const { b, f } of refFields()) {
    (inv.site?.[b.id] || []).forEach((row, i) => {
      const v = row?.[f.key];
      if (v === undefined || v === null || v === '') return;
      if (resolveRef(inv.site, f.ref, v) === v) return;
      const title = row.code || row.name || `第 ${i + 1} 筆`;
      out.push({
        block: b.id, rowId: row.id, field: f.key, value: v,
        message: `${b.label}「${title}」的${f.label}「${v}」對不到${siteBlockById(f.ref)?.label || f.ref}，請改選（待修）`,
      });
    });
  }
  return out;
}
export const refLabel = (site, ref, v) => {
  const id = resolveRef(site, ref, v);
  return id ? refName((site?.[ref] || []).find((r) => r.id === id)) : (v ? String(v) : '');
};

// 驗證設備主檔一筆（新增或修改後的完整樣貌）
export function validateEquipment(eq, inv) {
  const errors = [], warnings = [];
  if (!eq || typeof eq !== 'object') return { ok: false, errors: ['設備資料格式錯誤'], warnings };
  const cat = categoryById(eq.category);
  if (!cat) return { ok: false, errors: [`設備類別須為 ${EQUIPMENT_CATEGORIES.map((c) => c.id).join('／')}`], warnings };
  if (!cat.kinds.includes(eq.kind)) errors.push(`「${cat.label}」沒有「${eq.kind}」這個種類（可選：${cat.kinds.join('、')}）`);
  if (eq.status !== undefined && !Object.hasOwn(EQUIPMENT_STATUS, eq.status)) errors.push('設備狀態須為 active／replaced／removed');
  if (eq.building && inv && !(inv.site.buildings || []).some((b) => b.id === eq.building)) errors.push(`建築不存在：${eq.building}（請先在「建築資料」建立）`);
  if (eq.pointCode && inv && !inv.points.some((p) => p.code === eq.pointCode)) errors.push(`點位不存在：${eq.pointCode}`);
  const r = checkFields(cat.fields, eq.fields || {}, '', eq.kind);
  errors.push(...r.errors); warnings.push(...r.warnings);
  return { ok: !errors.length, errors, warnings, fields: r.values };
}

// ════════════════════════════════════════════════════════════════
// 送出一次點位紀錄的判定（純函式，方便測試）
// ════════════════════════════════════════════════════════════════
const round = (n) => Math.round(n * 1000) / 1000;

// 用量＝本次讀數－上次讀數。之後換成 public/inventory-compute.js 的共用版本。
export function readingUsage(cur, prev) {
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  return round(cur - prev);
}

// 找出該點位某項目最近一筆有數值的紀錄（records 依 at 遞增或任意順序皆可）
export function lastValue(records, pointCode, itemId) {
  let best = null;
  for (const r of records) {
    if (r.pointCode !== pointCode) continue;
    const v = r.values?.[itemId];
    if (typeof v !== 'number') continue;
    if (!best || String(r.at) > String(best.at)) best = r;
  }
  return best ? { value: best.values[itemId], usage: best.usage?.[itemId] ?? null, at: best.at, period: best.period } : null;
}

// 回傳 { errors, issues, decreases, pending, warnings, values, usage, anomalyItems }
//   issues     → 422 validation 的 details：[{ itemId|null, message }]。同名 label 的多台設備
//                只靠訊息文字對不回欄位，前端要用 itemId 標錯（itemId null＝不屬於某個項目）
//   errors     → issues 的訊息字串（同順序；給只要文字的呼叫端）
//   decreases  → 422（讀數倒退，除非該項目在 confirmDecrease 名單裡：換表、歸零）
//   pending    → 409（電費單還有沒複驗的格子）
//   warnings   → 照樣存檔，只是回給前端提示（用量差超過 warnPct）
//   note       → 紀錄的備註；有 status 選了「異常」而備註空白 → 該 status 項目一筆 issue
export function assessRecord(point, records, rawValues, { confirmDecrease = [], note } = {}) {
  const issues = [], decreases = [], pending = [], warnings = [];
  const err = (itemId, message) => { issues.push({ itemId, message }); };
  const values = {}, usage = {}, anomalyItems = [];
  const input = rawValues && typeof rawValues === 'object' ? rawValues : {};
  const known = new Set(point.items.map((i) => i.id));
  for (const k of Object.keys(input)) if (!known.has(k)) err(null, `不認得的項目：${k}`);

  for (const it of point.items) {
    const raw = input[it.id];
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (empty) { if (it.required) err(it.id, `「${it.label}」必填`); continue; }

    if (it.type === 'reading' || it.type === 'number') {
      const n = typeof raw === 'number' ? raw : coerce(raw, 'number');
      if (typeof n !== 'number' || !Number.isFinite(n)) { err(it.id, `「${it.label}」必須是數字`); continue; }
      if (it.type === 'reading' && n < 0) { err(it.id, `「${it.label}」讀數不可為負數`); continue; }
      values[it.id] = n;
      if (it.type !== 'reading') continue;
      const prev = lastValue(records, point.code, it.id);
      if (!prev) { usage[it.id] = null; continue; }        // 第一次抄表：沒有上次，算不出用量
      const u = readingUsage(n, prev.value);
      if (u < 0) {
        if (confirmDecrease.includes(it.id)) { usage[it.id] = null; warnings.push(`「${it.label}」讀數比上次小，已依確認視為換表或歸零，本次不計用量`); continue; }
        decreases.push({
          itemId: it.id, label: it.label, prev: prev.value, prevAt: prev.at, value: n,
          message: `「${it.label}」本次讀數 ${n} 小於上次 ${prev.value}（${prev.period}）。請確認是否抄錯；若是換表或歸零，請勾選確認後再送出。`,
        });
        continue;
      }
      usage[it.id] = u;
      if (it.warnPct && typeof prev.usage === 'number' && prev.usage > 0) {
        const diffPct = Math.abs(u - prev.usage) / prev.usage * 100;
        if (diffPct > it.warnPct) {
          warnings.push(`「${it.label}」本次用量 ${u}${it.unit || ''} 與上次 ${prev.usage}${it.unit || ''} 差 ${Math.round(diffPct)}%（超過 ${it.warnPct}%），請確認讀數`);
        }
      }
    } else if (it.type === 'status') {
      const opts = itemOptions(it);
      const v = String(raw);
      if (!opts.includes(v)) { err(it.id, `「${it.label}」須為 ${opts.join('／')}`); continue; }
      values[it.id] = v;
      if (v === ANOMALY_VALUE) {
        anomalyItems.push(it);
        if (note !== undefined && !String(note).trim()) err(it.id, ANOMALY_NOTE_MSG);
      }
    } else if (it.type === 'text') {
      const v = String(raw).trim();
      if (v.length > 2000) { err(it.id, `「${it.label}」超過 2000 字`); continue; }
      if (v) values[it.id] = v;
    } else if (it.type === 'photo') {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every((x) => typeof x === 'string' && RE_PHOTO_ID.test(x))) { err(it.id, `「${it.label}」照片代號不正確`); continue; }
      values[it.id] = [...new Set(arr)];
    } else if (it.type === 'bill') {
      // 電費單：沿用健檢填報的欄位定義與複驗閘門。值的形狀 { values:{電費單欄位}, meta:{欄位:{state,source}} }
      const r = checkBill(raw, it.label);
      for (const m of r.errors) err(it.id, m);
      warnings.push(...r.warnings); pending.push(...r.pending);
      if (!r.errors.length) values[it.id] = { values: r.bill.values, meta: r.bill.meta };
    }
  }
  return { errors: issues.map((i) => i.message), issues, decreases, pending, warnings, values, usage, anomalyItems };
}

export const RE_PHOTO_ID = /^[A-Za-z0-9_-]{8,80}$/;

function checkBill(raw, label) {
  const errors = [], warnings = [];
  if (!raw || typeof raw !== 'object' || typeof raw.values !== 'object') return { errors: [`「${label}」格式錯誤（應為 { values, meta }）`], warnings, pending: [] };
  const cols = blockById('bills').columns;
  const values = {};
  for (const c of cols) {
    if (c.computed) continue;
    const v = raw.values[c.key];
    if (v === undefined || v === null || v === '') continue;
    values[c.key] = c.type === 'number' || c.type === 'percent' ? (typeof v === 'number' ? v : coerce(v, 'number')) : coerce(v, c.type);
  }
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const bill = { values, meta };
  const v = validateAudit({ blocks: { bills: { rows: [bill] } } });
  errors.push(...v.errors.map((e) => `「${label}」${e}`));
  warnings.push(...v.warnings.map((e) => `「${label}」${e}`));
  // 伺服器端那份判準才算數：解析出來還沒逐格確認（todo/low）就不准送
  const pending = pendingCells({ blocks: { bills: { rows: [bill] } } }).map((p) => ({ ...p, itemLabel: label }));
  return { errors, warnings, pending, bill };
}

// ════════════════════════════════════════════════════════════════
// 異動登錄的種類
// ════════════════════════════════════════════════════════════════
export const CHANGE_KINDS = {
  'equipment.add': '設備新增',
  'equipment.replace': '設備汰換',
  'equipment.remove': '設備移除',
  'equipment.correct': '規格更正',
  'equipment.update': '設備資料修改',
  'staff': '人員異動',
  'site': '初始建檔資料修改',
  'point': '點位異動',
  'measure.done': '措施完工',
  'plan.change': '計畫變更',
  'other': '其他',
};

// ════════════════════════════════════════════════════════════════
// 操作人姓名（reporter）
// 帳號一院一組，session 只看得到院名。所有改變狀態的 API 都接受選填 reporter（trim 後 ≤ 20 字）：
// 有填 → who＝「姓名（院名）」並另存 reporter；沒填 → who 只有院名、reporter 為 null。
// 貼紙頁與管理端共用同一個 localStorage key（ems.sticker.reporter），同一支手機／電腦填一次就好。
// ════════════════════════════════════════════════════════════════
export const REPORTER_MAX = 20;
export const REPORTER_STORAGE_KEY = 'ems.sticker.reporter';
export const REPORTER_ERROR = `填寫人姓名最長 ${REPORTER_MAX} 字`;
export function parseReporter(raw) {
  if (raw === undefined || raw === null) return { ok: true, reporter: null };
  if (typeof raw !== 'string') return { ok: false, message: REPORTER_ERROR };
  const r = raw.trim();
  if (r.length > REPORTER_MAX) return { ok: false, message: REPORTER_ERROR };
  return { ok: true, reporter: r || null };
}
export const whoLabel = (base, reporter) => (reporter ? `${reporter}（${base}）` : base);

// ════════════════════════════════════════════════════════════════
// 設備 ↔ 點位的一致性
// 連結以「點位項目的 equipmentId」為準；設備主檔的 pointCode 只是方便查的副本。
// GET /api/inv 回傳這份清單，管理端在「點位與進度」列出並提供修正。
// ════════════════════════════════════════════════════════════════
export function linkedItemsOf(inv, equipmentId) {
  const out = [];
  for (const p of inv.points || []) {
    for (const it of p.items || []) {
      if (it.equipmentId === equipmentId) out.push({ pointCode: p.code, pointName: p.name, active: p.active !== false, itemId: it.id, label: it.label });
    }
  }
  return out;
}

export function equipmentLinkIssues(inv) {
  const out = [];
  const eqName = (e) => e?.fields?.name || e?.kind || e?.id || '';
  const byId = new Map((inv.equipment || []).map((e) => [e.id, e]));
  for (const p of inv.points || []) {
    for (const it of p.items || []) {
      if (!it.equipmentId) continue;
      const e = byId.get(it.equipmentId);
      const base = { pointCode: p.code, pointName: p.name, itemId: it.id, label: it.label, equipmentId: it.equipmentId };
      if (!e) {
        out.push({ type: 'item_missing_equipment', ...base, message: `點位 ${p.code}「${it.label}」連到的設備不存在（${it.equipmentId}），請到點位改連或移除` });
      } else if (e.status && e.status !== 'active') {
        const nu = e.replacedBy ? byId.get(e.replacedBy) : null;
        out.push({
          type: 'item_inactive_equipment', ...base, equipmentName: eqName(e), status: e.status, replacedBy: e.replacedBy || null,
          message: `點位 ${p.code}「${it.label}」仍連到${EQUIPMENT_STATUS[e.status] || e.status}的設備「${eqName(e)}」${nu ? `，應改連「${eqName(nu)}」` : '，請到點位移除或改連'}`,
        });
      }
    }
  }
  for (const e of inv.equipment || []) {
    if (e.status && e.status !== 'active') continue;
    const linked = [...new Set(linkedItemsOf(inv, e.id).map((x) => x.pointCode))];
    const cur = e.pointCode || null;
    if (linked.length && !linked.includes(cur)) {
      out.push({
        type: 'equipment_point_mismatch', equipmentId: e.id, equipmentName: eqName(e), pointCode: cur, expected: linked[0], linkedPoints: linked,
        message: `設備「${eqName(e)}」主檔的所屬點位是 ${cur || '（未指定）'}，但連到它的點位項目在 ${linked.join('、')}`,
      });
    } else if (!linked.length && cur) {
      out.push({
        type: 'equipment_point_unlinked', equipmentId: e.id, equipmentName: eqName(e), pointCode: cur, expected: null, linkedPoints: [],
        message: `設備「${eqName(e)}」主檔的所屬點位是 ${cur}，但該點位沒有任何項目連到它`,
      });
    }
  }
  return out;
}

// ── 前端用的規格（純資料）──
export const inventorySpec = {
  fieldTypes: FIELD_TYPES,
  site: SITE_BLOCKS,
  equipment: { categories: EQUIPMENT_CATEGORIES, status: EQUIPMENT_STATUS },
  itemTypes: ITEM_TYPES,
  statusDefaults: DEFAULT_STATUS_OPTIONS,
  anomalyValue: ANOMALY_VALUE,
  domains: DOMAINS,
  codePattern: '<hid>-<E|W><兩位數>',
  changeKinds: CHANGE_KINDS,
  billColumns: blockById('bills').columns,   // bill 型項目的逐格確認表單照這份長
  exemptionCodes: EXEMPTION_CODES,
  chillerGroupMonth: CHILLER_GROUP_MONTH,
  chillerRoles: { kwh: '月耗電量（kWh）', rth: '系統負荷（RTh）' },
  measureCodes: MEASURE_CODES,
  reporter: { max: REPORTER_MAX, storageKey: REPORTER_STORAGE_KEY },
};

// ── 空白骨架 ──
export function blankInventory() {
  const site = {};
  for (const b of SITE_BLOCKS) site[b.id] = b.kind === 'form' ? {} : [];
  return { version: 1, updated: null, site, equipment: [], points: [], records: [], changes: [], measures: [], plans: [] };
}
