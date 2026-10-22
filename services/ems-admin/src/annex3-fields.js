// 匯出覆蓋率盤點（工作清單 24）：附表三（含附錄二）、附件一、附件二每張表每一欄 → 系統資料來源與狀態。
//
// 這份是 docs/annex3-field-map.md 的來源（node scripts/field-map.mjs 產生），test/export.test.js 會檢查：
//   - 每一欄都有來源與狀態；沒有「無來源」的欄位
//   - ref 指到的 schema 欄位真的存在（site 區塊、設備主檔、年度報表資料、節能計畫、措施、診斷團隊）
// 狀態：
//   auto    已自動帶入（改版前就有來源：初始建檔、設備主檔、點位紀錄、措施計畫或既有計算）
//   derive  可由其他欄位推得、本次補做
//   input   系統原本沒有來源、本次新增輸入欄位（ref 指向新欄位）
//   na      不屬系統範圍（紙本用印簽章）
// ref 寫法：site.<區塊>.<欄>｜eq.<類別>.<欄>｜annual.<區塊>.<欄>｜plan.<欄>｜measure.<replace|operation>.<欄>｜diag.<欄>｜team.<欄>｜member.<欄>
import { SITE_BLOCKS, EQUIPMENT_CATEGORIES } from './inventory-schema.js';
import { ANNUAL_BLOCKS } from './report-annual.js';
import { PLAN_FIELDS, MEASURE_TYPES, DIAGNOSIS_FIELDS, TEAM_FIELDS, MEMBER_FIELDS } from './report-schema.js';
import { TABLES } from './report-export.js';

export const STATUS = { auto: '已自動帶入', derive: '推得·本次補做', input: '新增輸入欄位', na: '系統外（紙本）' };

const out = [];
const E = (tableId, field, status, source, ref) => out.push({ tableId, field, status, source, ...(ref ? { ref } : {}) });
const site = (tableId, block, keys, status = 'auto', prefix = '') => {
  const b = SITE_BLOCKS.find((x) => x.id === block);
  for (const k of keys) { const f = b.fields.find((x) => x.key === k); E(tableId, `${prefix}${f.code ? `${f.code} ` : ''}${f.label}`, status, `初始建檔 › ${b.label}`, `site.${block}.${k}`); }
};
const annual = (tableId, block, keys, status = 'input', label) => {
  const b = ANNUAL_BLOCKS.find((x) => x.id === block);
  for (const k of keys) { const f = b.fields.find((x) => x.key === k); E(tableId, label ? label(f) : f.label, status, `報表資料輸入 › ${b.label}`, `annual.${block}.${k}`); }
};

// ── 一、二 ──
site('a3-01', 'staff', ['registered', 'name', 'unitTitle', 'regNo', 'regDate', 'address', 'phone', 'mobile', 'fax', 'email', 'unregisteredReasons', 'certNo', 'followUp'], 'auto', '一·');
site('a3-01', 'staff', ['name', 'unitTitle', 'regNo', 'regDate', 'active'], 'auto', '二·');

// ── 表三 ──
E('a3-03', '填表日期', 'auto', '初始建檔 › 基本資料；留白取產出日', 'site.basic.fillDate');
site('a3-03', 'basic', ['hqName', 'hqTaxId', 'hqRep', 'hqRepTitle', 'hqAddress', 'userNo', 'userName', 'owner', 'ownerTitle', 'taxId', 'userCategory', 'industry', 'siteAddress', 'contactAddress', 'beds', 'employees', 'workHours', 'floorArea', 'acArea', 'parkingArea']);
E('a3-03', '21 總能源費用', 'derive', '留白時＝電費單應繳總額＋表五之一燃料總價（燃料部分本次補做）；有填用填的', 'site.basic.energyCost');
site('a3-03', 'basic', ['revenue', 'energyCostRatio', 'occupancy', 'isSme']);
E('a3-03', '簽名用印（印信、能管人員、填表人、負責人）', 'na', '紙本／上傳檔用印');
site('a3-03m', 'meters', ['meterNo', 'contractKw', 'contractHalfPeakKw', 'contractSatHalfPeakKw', 'contractOffPeakKw', 'contractStandbyKw']);
E('a3-03m', '序號', 'derive', '初始建檔 › 電號；留白依排列順序編號', 'site.meters.seq');

// ── 表四 ──
site('a3-04-1', 'org', ['level', 'name', 'title', 'duties']);
site('a3-04-2', 'policy', ['iso50001', 'isoBody']);
E('a3-04-2', '證書效期', 'derive', '初始建檔 › 能源政策；留白沿用排除條件 EX10 的效期（同一件事只填一處，兩處不同列待補）', 'site.policy.isoValidUntil');
site('a3-04-2', 'policy', ['q2PolicyStatement', 'q3Review', 'q4Procurement', 'q5Channel', 'emis', 'emisSystems']);

// ── 表五之一 ──
annual('a3-05-1', 'fuels', ['E02qty', 'E02cost', 'E03qty', 'E03cost', 'E04qty', 'E04cost', 'E05qty', 'E05cost', 'E06qty', 'E06cost'], 'input', (f) => `1–12 月 ${f.label}（${f.unit}）`);
E('a3-05-1', '總計、平均', 'derive', '由 1–12 月加總、平均');
annual('a3-05-1', 'fuelMeta', ['E02supplier', 'E02customerNo', 'E03supplier', 'E03customerNo', 'E04supplier', 'E04customerNo', 'E05supplier', 'E05customerNo', 'E06supplier', 'E06customerNo']);

// ── 表五之二 ──
E('a3-05-2', '編號', 'auto', '初始建檔 › 電號 序號', 'site.meters.seq');
E('a3-05-2', '電號', 'auto', '初始建檔 › 電號', 'site.meters.meterNo');
E('a3-05-2', '契約用電別', 'auto', '初始建檔 › 電號；留白取電費單', 'site.meters.tariffType');
E('a3-05-2', '戶名', 'auto', '初始建檔 › 電號', 'site.meters.accountName');
E('a3-05-2', '用電地址', 'derive', '初始建檔 › 電號；留白沿用表三 13 能源使用地址（本次補做）', 'site.meters.address');
E('a3-05-2', '行業別', 'derive', '初始建檔 › 電號；留白沿用表三 12 行業編號及分類（本次補做）', 'site.meters.industry');
for (const f of ['契約容量·經常', '契約容量·半尖峰/非夏月', '契約容量·週六半尖峰', '契約容量·離峰', '契約容量·備用']) E('a3-05-2', `1–12 月 ${f}`, 'auto', '電費單點位紀錄（經常）＋初始建檔 › 電號（其他 4 種）');
for (const f of ['最高需量·尖峰', '最高需量·半尖峰/非夏月半尖峰', '最高需量·週六半尖峰', '最高需量·離峰', '用電度數·尖峰', '用電度數·半尖峰/非夏月半尖峰', '用電度數·週六半尖峰', '用電度數·離峰', '用電度數·合計', '轉供度數', '功因', '總電費（元含稅）']) E('a3-05-2', `1–12 月 ${f}`, 'auto', '電費單點位紀錄（bill 項目；月份以帳單計費期間為準，同月取最後一筆）');
E('a3-05-2', '合計、平均', 'auto', '由 1–12 月計算');

// ── 表五之三 ──
E('a3-05-3', '照明耗電功率占最高尖峰需量', 'auto', '設備主檔照明 Σ(燈具電功率×數量) ÷ 電費單最高尖峰需量');
E('a3-05-3', '空調耗電功率占最高尖峰需量', 'auto', '設備主檔空調 Σ(設備電功率×數量) ÷ 最高尖峰需量');
E('a3-05-3', '空調總裝置噸數·中央空調系統', 'auto', '設備主檔中央空調主機 容量（RT）× 數量');
E('a3-05-3', '空調總裝置噸數·其他型式（窗箱分離式）', 'auto', '設備主檔箱型／窗型／分離式 容量（RT）× 數量');
annual('a3-05-3', 'acRun', ['summerMaxRtCentral', 'summerMaxRtPackaged']);

// ── 表五之四、五之五 ──
E('a3-05-4', 'N-1 年室內樓地板面積', 'derive', 'N-1 年沿用確認時的快照（本次補做）；可在報表資料輸入覆寫', 'annual.eui.prevFloorArea');
E('a3-05-4', 'N 年室內樓地板面積', 'auto', '初始建檔：總樓地板－室內停車場', 'site.basic.floorArea');
E('a3-05-4', '1–12 月 N-1／N 年 EUI', 'auto', '電費單度數 ÷ 室內面積');
E('a3-05-4', '每季／全年差異（%）、增加／減少', 'auto', '(N 年 EUI − N-1 年 EUI) ÷ N-1 年 EUI（兩年月份齊全才算）');
annual('a3-05-4', 'eui', ['elecReason1', 'elecReason2', 'elecReason3', 'elecReason4', 'elecReason5']);
E('a3-05-5', 'N-1／N 年室內樓地板面積', 'derive', '同表五之四', 'annual.eui.prevFloorArea');
E('a3-05-5', '1–12 月 N-1／N 年熱能（公斤油當量）', 'derive', '表五之一燃料量 × §6.1 熱值 ÷ 10,000（本次補做）', 'annual.fuels.E02qty');
E('a3-05-5', '1–12 月 N-1／N 年 EUI（公斤油當量/㎡）', 'derive', '熱能 ÷ 室內面積（本次補做）');
E('a3-05-5', '每季／全年差異（%）、增加／減少', 'derive', '同表五之四公式（本次補做）');
annual('a3-05-5', 'eui', ['heatReason1', 'heatReason2', 'heatReason3', 'heatReason4', 'heatReason5']);

// ── 六 ──
E('a3-06', '台電電費單總用電度數（含轉供）', 'auto', '電費單點位紀錄 N 年合計');
E('a3-06', '再生能源自用總度數', 'derive', '表十之三（二）自發自用認列節電量合計（本次補做）', 'annual.renewables.selfKwh');
E('a3-06', '再生能源回售台電總度數', 'derive', '表十之三（二）回售合計（本次補做）', 'annual.renewables.soldKwh');
E('a3-06', '再生能源總發電量', 'derive', '表十之三（二）年發電量合計（本次補做）', 'annual.renewables.genKwh');
E('a3-06', '依設備分類（空調、照明、冷凍冷藏、事務、送排風、給水污水、電梯、其他）度/年、%', 'auto', '設備主檔 Σ(電功率×數量×運轉時數) 估算');
E('a3-06', '熱能平衡·燃料別熱值（百萬卡/年）與占比', 'derive', '表五之一燃料量 × 熱值（本次補做；沒有表五之一才退回鍋爐年度使用量）', 'annual.fuels.E02qty');
annual('a3-06', 'heatUses', HEAT_KEYS(), 'input', (f) => `熱能平衡·用途·${f.label}（百萬卡/年）`);
E('a3-06', '熱能平衡·各用途占比', 'derive', '各用途 ÷ 用途合計');

// ── 七 ──
site('a3-07', 'buildings', ['code', 'name', 'builtYear', 'basementFloors', 'aboveFloors', 'floorArea', 'roof', 'entranceFacing']);
E('a3-07', '用戶分類', 'derive', '初始建檔 › 建築資料；留白沿用表三 11 用戶分類（本次補做）', 'site.buildings.userCategory');

// ── 八 ──
site('a3-08', 'transformers', ['building', 'code', 'brand', 'madeYear', 'kva', 'type', 'primaryKv', 'secondaryV', 'circuit', 'loadDesc', 'efficiency', 'opTempC', 'opPrimaryKv', 'opSecondaryV', 'opMaxA', 'opPf', 'opMaxKw']);
E('a3-08', '負載率', 'auto', '初始建檔 › 變壓器；留白依 [(1.732×V×A×PF÷1000)÷kVA]÷PF 計算', 'site.transformers.opLoadRate');
site('a3-08', 'basic', ['pfAutoController', 'capacitorKvar', 'panelKv', 'panelA', 'panelPf', 'panelHvKvar']);
site('a3-08', 'generators', ['code', 'kva', 'voltageV'], 'auto', '緊急發電機·');

// ── 九 ──
E('a3-09-1-1', '項次', 'auto', '依群組排列');
E('a3-09-1-1', '建築名稱', 'auto', '同群組設備的建築（設備主檔 building → 表七）', 'eq.ac.chillerGroup');
E('a3-09-1-1', '冰水機群組名稱', 'auto', '設備主檔冰水機群組名稱＋點位項目 chillerGroup', 'eq.ac.chillerGroup');
E('a3-09-1-2', '建築名稱、群組名稱、月份', 'auto', '設備主檔與點位項目');
E('a3-09-1-2', '月耗電量（kWh）', 'auto', '點位項目 chillerRole=kwh 當月紀錄加總');
E('a3-09-1-2', '系統負荷（RTh）', 'auto', '點位項目 chillerRole=rth 當月紀錄加總');
E('a3-09-1-2', '效率（kW/RT）', 'auto', '月耗電 ÷ 月負荷');
annual('a3-09-1-2', 'chillerRemarks', ['remark', 'remarkOther']);
const eqCols = (tableId, catId, lead) => {
  const cat = EQUIPMENT_CATEGORIES.find((c) => c.id === catId);
  E(tableId, '建築物名稱', 'auto', '設備主檔 building → 表七建築名稱（存 id，名稱只建一次）');
  E(tableId, lead, 'auto', `設備主檔 › ${cat.label} 種類`);
  for (const f of cat.fields) if (f.group !== '鍋爐操作概況' && f.group !== '重大使用能源設備') E(tableId, f.label, 'auto', `設備主檔 › ${cat.label}`, `eq.${catId}.${f.key}`);
};
eqCols('a3-09-1-3', 'ac', '設備種類（13 類）');
eqCols('a3-09-2', 'lighting', '燈具種類');
eqCols('a3-09-3', 'other', '系統類別（9 類）');
E('a3-09-4', '各系統總容量（kW）', 'auto', '設備主檔 Σ(電功率×數量)');
annual('a3-09-4', 'systems', SYSTEM_KEYS(), 'input', (f) => f.label);
E('a3-09-4', '設備利用率（%）', 'derive', '年平均運轉容量 ÷ 總容量（本次補做）');
E('a3-09-4', '全年實際運轉時數、全年運轉時數（%）', 'auto', '設備主檔運轉時數（容量加權）÷ 8,760');
E('a3-09-5', '系統名稱、設備名稱', 'auto', '設備主檔中屬陸用燃油／燃氣蒸汽鍋爐（不含貫流式）者');
E('a3-09-5', '操作管理現況', 'input', '設備主檔 › 其他系統（鍋爐）', 'eq.other.opManagement');
E('a3-09-5', '實施設備維護現況', 'input', '設備主檔 › 其他系統（鍋爐）', 'eq.other.maintenance');
E('a3-09-6', '鍋爐項次', 'auto', '依設備主檔排列');
for (const k of ['inspectionNo', 'subKind', 'model', 'boilerEnergyType', 'boilerAnnualUse', 'capacity', 'capacityUnit', 'boilerOpStatus']) {
  const f = EQUIPMENT_CATEGORIES.find((c) => c.id === 'other').fields.find((x) => x.key === k);
  E('a3-09-6', f.label, 'auto', '設備主檔 › 其他系統（鍋爐）', `eq.other.${k}`);
}
E('a3-09-6', '年度使用量單位', 'auto', '依能源種類');
E('a3-09-7', '月份', 'auto', '1–12 月');
annual('a3-09-7', 'boilerTests', ['exhaustTempC', 'tempReason', 'o2Pct', 'o2Reason']);
annual('a3-09-8', 'pue', ['building', 'floor', 'upsType', 'kva', 'qty', 'avgEffPct', 'infraKwh', 'itKwh', 'tempSetC', 'measurePoint', 'monitor']);
E('a3-09-8', 'PUE', 'derive', '(a+b) ÷ b（本次補做）');

// ── 十 ──
E('a3-10-1', '項次、已執行措施、能源種類、執行計畫說明', 'auto', '節能計畫 ← 措施（名稱、能源種類、使用效率評估與改善作法說明）');
E('a3-10-1', '措施來源（跨年度成效／N 年度計畫）', 'derive', 'N-1 年完工＝跨年度成效；N 年完工或執行中＝N 年度計畫（本次補做）', 'plan.actualDoneDate');
E('a3-10-1', '措施代碼', 'auto', '節能計畫（留白沿用措施的代碼，§7.7）', 'plan.officialCode');
for (const k of ['beforeState', 'afterState', 'execStart', 'execEnd', 'valueSource', 'formula', 'formulaText']) E('a3-10-1', PLAN_FIELDS.find((f) => f.key === k).label, 'input', '申報與報告 › 節能計畫（申報表十／十一欄）', `plan.${k}`);
E('a3-10-1', '本項措施總節能量', 'input', '節能計畫「實際總節能量」；留白以措施年節能量預估帶入', 'plan.actualSaving');
E('a3-10-1', '節約金額', 'derive', '實際總節能量 × N 年平均電價（電費 ÷ 度數）（本次補做）；沒有實際值用措施節省能源費用');
E('a3-10-1', '實際投資金額', 'input', '節能計畫「實際投資金額」；留白用措施投資金額', 'plan.actualInvestment');
E('a3-10-2', '項次、措施來源、措施代碼、已執行措施', 'auto', '同表十之一');
E('a3-10-2', '執行計畫期間', 'input', '節能計畫（與表十之一同一欄，只填一次）', 'plan.execStart');
E('a3-10-2', '節能效益金額、投資金額（千元）', 'derive', '表十之一 ÷ 1,000');
E('a3-10-2', '效益計算起月、迄月', 'derive', '實際完工日期（或執行期間迄月）次月起算最多 12 個月，截在 N 年（本次補做）', 'plan.actualDoneDate');
E('a3-10-2', '抑低尖峰需量', 'input', '節能計畫', 'plan.peakReductionKw');
E('a3-10-2', '節約能源量（電力、燃料油、液化石油氣、天然氣、汽油、柴油）、合計', 'auto', '節能量依能源種類放對應欄');
E('a3-10-3', '（一）月份', 'auto', '1–12 月');
annual('a3-10-3', 'dr', ['meterId', 'name', 'scheme', 'kw', 'hours'], 'input', (f) => `（一）${f.label}`);
E('a3-10-3', '（一）認列節電量、合計', 'derive', '實際抑低量 × 抑低時數（本次補做）');
annual('a3-10-3', 'renewables', ['type', 'meterId', 'area', 'installedAt', 'kw', 'genKwh', 'soldKwh'], 'input', (f) => `（二）${f.label}`);
E('a3-10-3', '（二）序號', 'derive', '依排列');
E('a3-10-3', '（二）自發自用認列節電量', 'derive', '留白＝年發電量－回售（本次補做）', 'annual.renewables.selfKwh');
E('a3-10-4', '列管電號 1–12 月電費單度數', 'auto', '表五之二合計');
E('a3-10-4', '表十之三（二）自發自用認列節電量', 'derive', '表十之三（二）合計（本次補做）');
E('a3-10-4', 'N 年全年實際用電量、年度用電量', 'auto', '電費單度數＋自發自用－可扣除');
annual('a3-10-4', 'deductN', ['newBuilding', 'newEquipment', 'rail', 'safety', 'construction', 'newRegulation', 'ev', 'eus', 'eusApproval']);

// ── 十一 ──
E('a3-11-1', '項次、預計執行措施、能源種類、執行計畫說明、經費、節能量估算、節約金額估算', 'auto', '節能計畫 ← 措施');
E('a3-11-1', '措施來源（跨年度成效／N+1 年度計畫）', 'derive', 'N 年完工＝跨年度成效；預計 N+1 年完工＝N+1 年度計畫（本次補做）');
E('a3-11-1', '措施代碼', 'auto', '節能計畫', 'plan.officialCode');
for (const k of ['beforeState', 'afterState', 'execStart']) E('a3-11-1', PLAN_FIELDS.find((f) => f.key === k).label, 'input', '節能計畫（與表十共用同一欄）', `plan.${k}`);
E('a3-11-1', '執行計畫所需人力', 'input', '節能計畫', 'plan.manpower');
E('a3-11-2', '項次、措施來源、措施代碼、預計執行措施、節能效益金額、投資金額、各能源預估節約量', 'auto', '同表十一之一');
E('a3-11-2', '預計執行計畫期間', 'input', '節能計畫', 'plan.execStart');
E('a3-11-2', '效益計算起月、迄月', 'derive', '執行期間迄月次月起算 12 個月，截在 N+1 年（本次補做）', 'plan.execEnd');
E('a3-11-2', '抑低尖峰需量', 'input', '節能計畫', 'plan.peakReductionKw');
annual('a3-11-3', 'drPlan', ['month', 'meterId', 'name', 'scheme', 'kw', 'hours'], 'input', (f) => `（一）${f.label}`);
E('a3-11-3', '（一）認列節電量', 'derive', '預估抑低量 × 時數（本次補做）');
annual('a3-11-3', 'renewablesPlan', ['type', 'meterId', 'area', 'installedAt', 'kw', 'genKwh', 'soldKwh', 'selfKwh'], 'input', (f) => `（二）${f.label}`);
E('a3-11-4', '沿用 N 年全年實際用電量', 'auto', '表十之四');
annual('a3-11-4', 'forecast', ['method', 'newBuilding', 'newEquipment', 'rail', 'construction', 'ev', 'eus', 'estimateKwh', 'note']);
E('a3-11-4', 'N+1 年年度用電量估算', 'auto', '沿用值－可扣除（或其他估算方式）');

// ── 附錄二 ──
annual('a3-app2', 'app2', ['applyDate']);
E('a3-app2', '填表人', 'derive', '報表資料輸入 › 附錄二 選能管人員；留白取身分為「填表人員」者（本次補做）', 'annual.app2.applicantStaffId');
E('a3-app2', '聯絡電話', 'derive', '留白取填表人電話（本次補做）', 'annual.app2.phone');
E('a3-app2', '主申報·用戶編號、用戶名稱', 'derive', '表三 06、07（本次補做）', 'site.basic.userNo');
E('a3-app2', '主申報·台電電號、電號戶名', 'derive', '初始建檔 › 電號（附錄二指定，或第一個未勾合併申報者）（本次補做）', 'annual.app2.mainMeterId');
E('a3-app2', '主申報·能源使用地址', 'derive', '電號用電地址，留白取表三 13（本次補做）', 'site.meters.address');
E('a3-app2', '申請單位', 'derive', '報表資料輸入 › 附錄二；留白取用戶名稱（本次補做）', 'annual.app2.applyUnit');
annual('a3-app2', 'app2', ['applyReason', 'applyReasonText']);
E('a3-app2', '合併申報（多筆）·用戶編號、用戶名稱、台電電號、電號戶名、能源使用地址、申請單位、申請理由', 'derive', '初始建檔 › 電號 勾「合併申報」者（本次補做）', 'site.meters.combined');
annual('a3-app2', 'app2', ['evidence']);
E('a3-app2', '用印簽章', 'na', '紙本用印');

// ── 附件一 ──
E('a1-00', 'DR-00-01 能源用戶名稱', 'auto', '表三 07', 'site.basic.userName');
for (const f of DIAGNOSIS_FIELDS) E('a1-00', `${f.code} ${f.label}`, 'auto', '申報與報告 › 診斷報告主檔', `diag.${f.key}`);
E('a1-00', 'DR-00-04 保存期限', 'auto', '提報日＋5 年');
E('a1-01', 'DR-01-02 措施項數、DR-01-03 節能潛力、DR-01-04 節電潛力', 'auto', '3.2＋3.3 措施加總，§6.1 換算');
E('a1-02', '編號', 'auto', '依排列');
for (const f of MEASURE_TYPES.replace.fields.filter((x) => !x.system)) E('a1-02', f.label, 'auto', f.fromEquipment ? '措施；留白沿用設備主檔（設備只建一次）' : '申報與報告 › 診斷措施', `measure.replace.${f.key}`);
E('a1-02', '回收年限', 'auto', 'R5 投資 ÷ 年節省費用');
E('a1-03', '編號', 'auto', '依排列');
for (const f of MEASURE_TYPES.operation.fields.filter((x) => !x.system)) E('a1-03', f.label, 'auto', '申報與報告 › 診斷措施', `measure.operation.${f.key}`);
E('a1-03', '回收年限', 'auto', 'R5');
for (const f of TEAM_FIELDS) E('a1-04', `診斷團隊·${f.label}`, 'auto', '申報與報告 › 診斷團隊', `team.${f.key}`);
for (const f of MEMBER_FIELDS) E('a1-04', `人員明細·${f.label}`, 'auto', '申報與報告 › 診斷團隊', `member.${f.key}`);
E('a1-04', '文件保存到期日', 'auto', '提報日＋5 年');

// ── 附件二 ──
E('a2-01', '編號、節能改善措施、年節能量預估［年節能量｜單位］、投資金額、回收年限', 'auto', '措施 ID 貫穿：由措施即時帶出');
E('a2-01', '預計完工年度', 'auto', '申報與報告 › 節能計畫', 'plan.completionYear');
E('a2-01', '備註', 'auto', '申報與報告 › 節能計畫', 'plan.note');
for (const k of ['status', 'actualDoneDate', 'officialCode']) E('a2-01', `系統另加·${PLAN_FIELDS.find((f) => f.key === k).label}`, 'auto', '節能計畫', `plan.${k}`);
E('a2-01', '系統另加·來源措施 ID、是否強制納入', 'auto', 'R7 自動判定');
E('a2-02', '版本號、變更日期、變更人、變更前後、原因', 'auto', 'R8 版本紀錄');

function HEAT_KEYS() { return ANNUAL_BLOCKS.find((b) => b.id === 'heatUses').fields.map((f) => f.key); }
function SYSTEM_KEYS() { return ANNUAL_BLOCKS.find((b) => b.id === 'systems').fields.map((f) => f.key); }

export const FIELD_MAP = out;

// ref 是否指到真的 schema 欄位（測試用）
export function refExists(ref) {
  const [kind, a, b] = String(ref).split('.');
  const has = (fields, k) => fields.some((f) => f.key === k);
  if (kind === 'site') { const blk = SITE_BLOCKS.find((x) => x.id === a); return Boolean(blk && has(blk.fields, b)); }
  if (kind === 'eq') { const c = EQUIPMENT_CATEGORIES.find((x) => x.id === a); return Boolean(c && has(c.fields, b)); }
  if (kind === 'annual') { const blk = ANNUAL_BLOCKS.find((x) => x.id === a); return Boolean(blk && has(blk.fields, b)); }
  if (kind === 'plan') return has(PLAN_FIELDS, a);
  if (kind === 'measure') return Boolean(MEASURE_TYPES[a] && has(MEASURE_TYPES[a].fields, b));
  if (kind === 'diag') return has(DIAGNOSIS_FIELDS, a);
  if (kind === 'team') return has(TEAM_FIELDS, a);
  if (kind === 'member') return has(MEMBER_FIELDS, a);
  return false;
}

export function fieldStats(list = FIELD_MAP) {
  const by = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
  for (const e of list) by[e.status]++;
  return { total: list.length, ...by };
}

// docs/annex3-field-map.md
export function fieldMapMarkdown() {
  const st = fieldStats();
  const lines = [
    '# 附表三、附件一、附件二 匯出欄位對照',
    '',
    '> 由 `services/ems-admin/src/annex3-fields.js` 產生（`node services/ems-admin/scripts/field-map.mjs`），不要手改；改來源請改那支再重產。',
    '> 版本：附表三 115-01-23（經能字第 11558000090 號）；附件一、二 115-05-18（經能字第 11558001660 號）。工作清單第 24 項。',
    '',
    `共 ${st.total} 欄：${STATUS.auto} ${st.auto}、${STATUS.derive} ${st.derive}、${STATUS.input} ${st.input}、${STATUS.na} ${st.na}。沒有「無資料來源」的欄位。`,
    '',
    '狀態：**已自動帶入**＝改版前就有來源；**推得·本次補做**＝可由其他欄位推得、這次補上計算；**新增輸入欄位**＝原本沒有來源、這次新增填寫處（「報表資料輸入」是申報與報告裡的新分頁，資料按資料年 N 分開存）；**系統外**＝紙本用印。',
    '',
    '每張表可單獨下載：`GET /api/inv/report/table/<tableId>?year=N&format=xlsx|csv`。',
    '',
  ];
  for (const t of TABLES) {
    const rows = FIELD_MAP.filter((e) => e.tableId === t.id);
    if (!rows.length) continue;
    lines.push(`## ${t.label}（\`${t.id}\`）`, '', '| 欄位 | 來源 | 狀態 |', '|---|---|---|');
    for (const e of rows) lines.push(`| ${e.field} | ${e.source}${e.ref ? `（\`${e.ref}\`）` : ''} | ${STATUS[e.status]} |`);
    lines.push('');
  }
  return lines.join('\n');
}
