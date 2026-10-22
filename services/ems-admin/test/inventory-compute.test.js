// 能源盤點共用計算（public/inventory-compute.js）的回歸測試。
//
// 每條規則至少一個通過、一個不通過，外加 spec 寫死的邊界值：
//   剛好 10 年（R6 公用設備、R7 回收年限）、剛好 95%（功因）、剛好 1,000 RT（冰水群組）。
// 邊界寫錯不會當場壞，只會讓某家醫院的申報表少列一台設備，所以每個邊界都要釘住。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;

// ── 工具 ──

test('民國／西元轉換與日期解析', () => {
  assert.equal(C.rocToAd(117), 2028);
  assert.equal(C.adToRoc(2028), 117);
  assert.equal(C.toRocYear(2020), 109);
  assert.equal(C.toRocYear(109), 109);
  assert.equal(C.toIso(C.parseDate('117-03-31')), '2028-03-31');
  assert.equal(C.toIso(C.parseDate('117/3/1')), '2028-03-01');
  assert.equal(C.toRocDate(C.parseDate('2028-03-31')), '117-03-31');
  assert.equal(C.parseDate('2026-02-30'), undefined);
  assert.equal(C.daysBetween('2026-10-22', '2026-10-31'), 9);
  // 2/29 加 1 年落在 2/28，不進位到 3/1
  assert.equal(C.toIso(C.addYears('2024-02-29', 1)), '2025-02-28');
  // Date 物件換成台北日曆日：UTC 16:30 已是台北隔天
  assert.equal(C.toIso(C.parseDate(new Date('2026-10-22T16:30:00Z'))), '2026-10-23');
});

// ── 用量 ──

test('用量：本次 − 上次，差異在 warnPct 內通過', () => {
  const r = C.readingUsage(1200, 1000, { prevUsage: 190, warnPct: 20 });
  assert.equal(r.value, 200);
  assert.equal(r.ok, true);
  assert.equal(r.rollback, false);
});

test('用量：超過 warnPct 提示，剛好等於不提示', () => {
  const over = C.readingUsage(1300, 1000, { prevUsage: 200, warnPct: 20 });
  assert.equal(over.level, 'warn');
  assert.equal(over.diffPct, 50);
  assert.match(over.msg, /增加 50%/);
  const edge = C.readingUsage(1240, 1000, { prevUsage: 200, warnPct: 20 });
  assert.equal(edge.level, 'ok');
  const down = C.readingUsage(1100, 1000, { prevUsage: 200, warnPct: 20 });
  assert.equal(down.level, 'warn');
  assert.match(down.msg, /減少 50%/);
});

test('用量：讀數倒退擋下並要求確認；首次抄表不算錯', () => {
  const r = C.readingUsage(900, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.level, 'error');
  assert.equal(r.rollback, true);
  assert.equal(r.value, undefined);
  const first = C.readingUsage(1000, undefined);
  assert.equal(first.ok, true);
  assert.equal(first.first, true);
  assert.equal(first.value, undefined);
  assert.equal(C.readingUsage('', 1000).ok, null);
});

test('用量：整筆紀錄只算 reading 型，分出 warnings 與 blocking', () => {
  const items = [
    { id: 'kwh', type: 'reading', label: '總表', unit: '度', warnPct: 10 },
    { id: 'water', type: 'reading', label: '水表' },
    { id: 'st', type: 'status' },
  ];
  const out = C.recordUsage(items, { kwh: 1500, water: 40, st: '正常' }, { values: { kwh: 1000, water: 50 }, usage: { kwh: 300 } });
  assert.deepEqual(out.usage, { kwh: 500 });
  assert.equal(out.warnings.length, 1);
  assert.equal(out.blocking.length, 1);
  assert.match(out.blocking[0], /水表/);
  assert.equal(out.results.st, undefined);
});

// ── R1 / R2 ──

test('R1：契約容量 > 800 瓩為能源用戶，剛好 800 不是', () => {
  assert.equal(C.energyUserCheck({ contractKw: 801 }).value, true);
  assert.equal(C.energyUserCheck({ contractKw: 800 }).value, false);
  assert.equal(C.energyUserCheck({}).ok, null);
});

test('R1：合併計算參數', () => {
  const meters = [{ contractKw: 500 }, { contractKw: 400 }];
  const sep = C.energyUserCheck({ meters, combine: false });
  assert.equal(sep.value, false);
  assert.equal(sep.basisKw, 500);
  const comb = C.energyUserCheck({ meters, combine: true });
  assert.equal(comb.value, true);
  assert.equal(comb.basisKw, 900);
});

test('R2 EX08：核准日 +5 年內成立，到期日當天仍成立，隔天失效', () => {
  const ex = { code: 'EX08', reason: '新設', evidence: ['f1'], approvedAt: '112-05-01' };
  const ok = C.exclusionCheck(ex, { today: '2026-10-22' });
  assert.equal(ok.value, true);
  assert.equal(ok.expiresAt, '2028-05-01');
  assert.equal(ok.expiresAtRoc, '117-05-01');
  assert.equal(C.exclusionCheck(ex, { today: '2028-05-01' }).value, true);
  const gone = C.exclusionCheck(ex, { today: '2028-05-02' });
  assert.equal(gone.value, false);
  assert.equal(gone.level, 'error');
  assert.equal(C.exclusionCheck({ code: 'EX08', reason: 'x', evidence: ['f'] }).ok, false);
});

test('R2 EX10：證書效期內通過、90 天內提醒、過期不成立', () => {
  const base = { code: 'EX10', reason: '已取得', evidence: ['cert.pdf'] };
  assert.equal(C.exclusionCheck({ ...base, certValidUntil: '2027-12-31' }, { today: '2026-10-22' }).level, 'ok');
  const soon = C.exclusionCheck({ ...base, certValidUntil: '2026-12-01' }, { today: '2026-10-22' });
  assert.equal(soon.level, 'warn');
  assert.equal(soon.value, true);
  assert.equal(soon.daysLeft, 40);
  const expired = C.exclusionCheck({ ...base, certValidUntil: '2026-10-21' }, { today: '2026-10-22' });
  assert.equal(expired.value, false);
});

test('R2：缺理由或佐證，排除不成立', () => {
  const r = C.exclusionCheck({ code: 'EX01', reason: '', evidence: [] });
  assert.equal(r.value, false);
  assert.match(r.msg, /理由與佐證/);
  assert.equal(C.exclusionCheck({ code: 'EX01', reason: '國軍', evidence: ['函'] }).value, true);
  assert.equal(C.exclusionCheck({ code: 'EX99' }).ok, false);
});

test('R1+R2：符合 > 800 但排除成立 → 不列管', () => {
  const s = C.energyUserStatus({ contractKw: 3000, exclusions: [{ code: 'EX01', reason: '國軍', evidence: ['函'] }] });
  assert.equal(s.value, false);
  assert.match(s.msg, /不列管/);
  const s2 = C.energyUserStatus({ contractKw: 3000, exclusions: [] });
  assert.equal(s2.value, true);
});

// ── R3 ──

const member = (o) => ({ fullTime: true, years: 6, energyCert: false, seniorElectric: false, ...o });

test('R3 Q-L1：1 技師＋2 具資格（≥1 能管證書）通過；少一人不通過', () => {
  const members = [member({ engineerDiscipline: '電機技師' }), member({ energyCert: true }), member({ seniorElectric: true })];
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-L1', members }).ok, true);
  const r = C.diagnosisTeamCheck({ code: 'Q-L1', members: members.slice(0, 2) });
  assert.equal(r.ok, false);
  assert.match(r.msg, /≥2 名/);
  // 年資剛好 5 年不算「> 5 年」
  const r5 = C.diagnosisTeamCheck({ code: 'Q-L1', members: [members[0], member({ energyCert: true }), member({ seniorElectric: true, years: 5 })] });
  assert.equal(r5.ok, false);
  // 非全職不算
  const pt = C.diagnosisTeamCheck({ code: 'Q-L1', members: [member({ engineerDiscipline: '電機', fullTime: false }), members[1], members[2]] });
  assert.equal(pt.ok, false);
});

test('R3 Q-L2：≥5 具資格且 ≥3 能管證書', () => {
  const five = [1, 2, 3].map(() => member({ energyCert: true })).concat([member({ seniorElectric: true }), member({ seniorElectric: true })]);
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-L2', members: five }).ok, true);
  const twoCert = [1, 2].map(() => member({ energyCert: true })).concat([1, 2, 3].map(() => member({ seniorElectric: true })));
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-L2', members: twoCert }).ok, false);
});

test('R3 Q-L3／Q-S1：須受委託', () => {
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-S1', commissioned: true }).ok, true);
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-L3', commissioned: false }).ok, false);
});

test('R3 Q-E1：提報日 ≤ 執照到期日（當天可）、科別限四種', () => {
  const lic = { discipline: '冷凍空調', expiresAt: '117-03-31' };
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-E1', licence: lic }, { reportDate: '2028-03-31' }).ok, true);
  const late = C.diagnosisTeamCheck({ code: 'Q-E1', licence: lic }, { reportDate: '2028-04-01' });
  assert.equal(late.ok, false);
  assert.match(late.msg, /超過執照到期日/);
  assert.equal(C.diagnosisTeamCheck({ code: 'Q-E1', licence: { ...lic, discipline: '土木' } }, { reportDate: '2027-01-01' }).ok, false);
});

// ── R5 ──

test('R5：回收年限＝投資 ÷ 年節省；節省 0 → 不適用', () => {
  const r = C.paybackYears(1000000, 250000);
  assert.equal(r.value, 4);
  assert.equal(r.ok, true);
  const zero = C.paybackYears(1000000, 0);
  assert.equal(zero.ok, null);
  assert.equal(zero.value, undefined);
  assert.equal(zero.msg, '無法回收／不適用');
  assert.equal(C.paybackYears('1,000,000', '').ok, null);
});

// ── R6 ──

test('R6：各類門檻「超過」才強制列入，剛好等於不列', () => {
  const at = (category, age) => C.replacementRequired({ category, mfgYear: 115 - age, reportYear: 115 }).value;
  assert.equal(at('公用設備', 10), false);   // 剛好 10 年
  assert.equal(at('公用設備', 11), true);
  assert.equal(at('螢光燈具', 2), false);
  assert.equal(at('螢光燈具', 3), true);
  assert.equal(at('LED 燈具', 8), false);
  assert.equal(at('LED 燈具', 9), true);
  assert.equal(at('製程設備', 20), false);
  assert.equal(at('製程設備', 21), true);
  assert.equal(at('其他', 50), false);
  const r = C.replacementRequired({ category: '公用設備', mfgYear: 100, reportYear: 115 });
  assert.equal(r.age, 15);
  assert.match(r.msg, /強制列入/);
});

test('R6 燈具類別：省電燈泡、日光燈＝螢光燈具（2 年）；LED＝LED 燈具（8 年）；其他燈種不套門檻（單一函式）', () => {
  const cat = (category, kind) => C.equipmentReplaceCategory({ category, kind });
  assert.equal(cat('lighting', '日光燈'), '螢光燈具');
  assert.equal(cat('lighting', '省電燈泡'), '螢光燈具');
  assert.equal(cat('lighting', 'LED'), 'LED 燈具');
  for (const k of ['鹵素燈', '複金屬燈', '高壓鈉燈', '高壓水銀燈', '其他']) assert.equal(cat('lighting', k), '其他', k);
  assert.equal(cat('ac', '中央空調主機'), '公用設備');
  assert.equal(cat('other', '電梯'), '公用設備');
  assert.equal(C.equipmentReplaceCategory(null), undefined);
  const r6 = (kind, age) => C.replacementRequired({ category: cat('lighting', kind), mfgYear: 115 - age, reportYear: 115 }).value;
  assert.equal(r6('省電燈泡', 3), true, '省電燈泡 3 年 > 2 年');
  assert.equal(r6('省電燈泡', 2), false);
  assert.equal(r6('LED', 9), true);
  assert.equal(r6('鹵素燈', 40), false, '其他燈種不套門檻');
  assert.equal(C.replaceCategory('省電燈泡'), 'fluorescent');
});

test('R6：機齡用民國年；誤填西元自動轉；製造晚於提報不通過', () => {
  assert.equal(C.equipmentAge(2015, 115).value, 11);
  assert.equal(C.equipmentAge(116, 115).ok, false);
  assert.equal(C.equipmentAge('', 115).ok, null);
});

// ── R7 ──

test('R7：回收 < 10 年強制納入，剛好 10 年不強制，不適用不強制', () => {
  assert.equal(C.planMandatory(9.99).value, true);
  assert.equal(C.planMandatory(10).value, false);
  assert.equal(C.planMandatory(C.paybackYears(100, 0)).value, false);
  assert.equal(C.planMandatory(C.paybackYears(100, 50)).value, true);
});

test('R7：完工年度限提報年度～+4，空白則備註必填', () => {
  const base = { paybackYears: 3, reportYear: 117 };
  assert.equal(C.planRowCheck({ ...base, completionYear: 117 }).ok, true);
  assert.equal(C.planRowCheck({ ...base, completionYear: 121 }).ok, true);
  const over = C.planRowCheck({ ...base, completionYear: 122 });
  assert.equal(over.ok, false);
  assert.match(over.msg, /117～121/);
  assert.equal(C.planRowCheck({ ...base, completionYear: 116 }).ok, false);
  const noYear = C.planRowCheck({ ...base, completionYear: '' });
  assert.equal(noYear.ok, false);
  assert.match(noYear.msg, /備註/);
  assert.equal(C.planRowCheck({ ...base, completionYear: '', note: '預算未核定' }).ok, true);
  assert.equal(C.planRowCheck({ ...base, completionYear: 117 }).mandatory, true);
});

// ── R9 ──

test('R9 能管人數：> 100,000 瓩須 ≥2 名且 ≥1 自置', () => {
  assert.equal(C.staffCountCheck({ contractKw: 120000, staff: [{ inHouse: true }, { inHouse: false }] }).ok, true);
  assert.equal(C.staffCountCheck({ contractKw: 120000, staff: [{ inHouse: true }] }).ok, false);
  assert.equal(C.staffCountCheck({ contractKw: 120000, staff: [{ inHouse: false }, { inHouse: false }] }).ok, false);
  assert.equal(C.staffCountCheck({ contractKw: 100000, staff: [{ inHouse: true }] }).ok, true);
});

test('R9 營業規模：醫院必填床數；出租率僅辦公大樓', () => {
  assert.equal(C.businessScaleCheck({ userClass: '醫院', beds: 500 }).ok, true);
  assert.equal(C.businessScaleCheck({ userClass: '醫院', beds: '' }).ok, false);
  assert.equal(C.businessScaleCheck({ userClass: '學校' }).ok, null);
  assert.equal(C.occupancyRateCheck({ userClass: '醫院' }).ok, null);
  assert.equal(C.occupancyRateCheck({ userClass: '辦公大樓' }).ok, false);
  assert.equal(C.occupancyRateCheck({ userClass: '辦公大樓', rate: 80 }).ok, true);
});

test('R9 EUI 差異：> 10% 須原因，剛好 10% 不必', () => {
  assert.equal(C.euiDiffCheck(100, 110).ok, true);
  assert.equal(C.euiDiffCheck(100, 110).reasonRequired, false);
  const r = C.euiDiffCheck(100, 115);
  assert.equal(r.ok, false);
  assert.equal(r.value, 15);
  assert.equal(C.euiDiffCheck(100, 85, '新大樓啟用').ok, true);
  assert.equal(C.euiDiffCheck(100, 89).ok, false);
});

test('R9 功因：剛好 95% 通過，低於提示；0.97 視為 97%', () => {
  assert.equal(C.powerFactorCheck(95).ok, true);
  assert.equal(C.powerFactorCheck(94.9).level, 'warn');
  assert.equal(C.powerFactorCheck(0.97).value, 97);
  assert.equal(C.powerFactorCheck('').ok, null);
});

test('R9 變壓器負載率：50～75% 含端點', () => {
  assert.equal(C.transformerLoadCheck({ loadPct: 50 }).ok, true);
  assert.equal(C.transformerLoadCheck({ loadPct: 75 }).ok, true);
  assert.equal(C.transformerLoadCheck({ loadPct: 49.9 }).level, 'warn');
  assert.equal(C.transformerLoadCheck({ loadPct: 80 }).level, 'warn');
  const r = C.transformerLoadCheck({ maxLoadKw: 600, capacityKva: 1000 });
  assert.equal(r.value, 60);
  assert.equal(r.ok, true);
});

test('R9 冰水群組：剛好 1,000 RT 必填 12 個月效率表', () => {
  const full = Array.from({ length: 12 }, () => ({ kwh: 1000, rth: 1500 }));
  const edge = C.chillerTableCheck({ capacities: [500, 500] });
  assert.equal(edge.value, true);
  assert.equal(edge.ok, false);
  assert.equal(C.chillerTableCheck({ capacities: [500, 500], months: full }).ok, true);
  const small = C.chillerTableCheck({ totalRt: 999 });
  assert.equal(small.value, false);
  assert.equal(small.ok, true);
});

test('R9 ISO 50001：通過免答 2–5，證書過期須作答', () => {
  const p = C.isoQuestions({ passed: true, certValidUntil: '2027-06-30', today: '2026-10-22' });
  assert.deepEqual(p.skip, [2, 3, 4, 5]);
  assert.equal(p.ok, true);
  assert.equal(C.isoQuestions({ passed: true }).ok, false);
  assert.deepEqual(C.isoQuestions({ passed: true, certValidUntil: '2026-01-01', today: '2026-10-22' }).skip, []);
  assert.deepEqual(C.isoQuestions({ passed: false }).value, [1, 2, 3, 4, 5, 6]);
});

test('R9 PUE 表與鍋爐條件', () => {
  assert.equal(C.pueTableRequired('電腦機房').value, true);
  assert.equal(C.pueTableRequired('醫院').value, false);
  const steam = C.boilerCheck({ kind: '蒸汽', type: '水管式', fuel: '天然氣' }).value;
  assert.deepEqual(steam, { selfTestRequired: true, majorEquipment: true });
  assert.deepEqual(C.boilerCheck({ kind: '蒸汽', type: '貫流式', fuel: '柴油' }).value, { selfTestRequired: false, majorEquipment: false });
  assert.deepEqual(C.boilerCheck({ kind: '熱水', type: '煙管式', fuel: '柴油' }).value, { selfTestRequired: false, majorEquipment: false });
  assert.deepEqual(C.boilerCheck({ kind: '蒸汽', type: '煙管式', fuel: '電' }).value, { selfTestRequired: true, majorEquipment: false });
});

// ── 公式 ──

test('EUI：電與熱，室內面積 = 總樓地板 − 室內停車場', () => {
  const e = C.euiElectric(1200000, 12000, 2000);
  assert.equal(e.value, 120);
  assert.equal(e.area, 10000);
  assert.equal(C.euiThermal(5000, 12000, 2000).value, 0.5);
  // 115-01-23 新版表五之五：單位改公斤油當量/㎡
  assert.match(C.euiThermal(5000, 12000, 2000).msg, /公斤油當量\/㎡/);
  assert.doesNotMatch(C.euiThermal(5000, 12000, 2000).msg, /公升/);
  assert.match(C.euiThermal(5000, 12000, 2000).source.ref, /表五之五/);
  assert.equal(C.euiElectric(1000, 100, 100).ok, false);
  assert.equal(C.euiElectric('', 100).ok, null);
});

test('冰水效率 kW/RT、PUE、能源費用比例、需量反應', () => {
  assert.equal(C.chillerEfficiency(65000, 100000).value, 0.65);
  assert.equal(C.chillerEfficiency(1, 0).ok, false);
  assert.equal(C.pue(500, 1000).value, 1.5);
  assert.equal(C.pue(1, 0).ok, false);
  assert.equal(C.energyCostRatio(50, 1000).value, 5);
  assert.equal(C.energyCostRatio(2000, 1000).ok, false);
  assert.equal(C.demandResponseSaving(200, 3).value, 600);
  assert.equal(C.annualConsumption(1000, 200, 50).value, 1150);
});

test('油當量換算（§6.1）與診斷摘要：天然氣預設 NG1', () => {
  assert.equal(C.toToe(10000, 'E01').value, 0.86);
  assert.equal(C.toToe(1, 'E02').value, 0.932);
  assert.equal(C.toToe(1000, 'E04').value, 0.8107);
  assert.equal(C.toToe(1000, 'E04', { ng: 'NG2' }).value, 0.8755);
  assert.equal(C.toToe(1, 'E99').ok, false);
  assert.equal(C.fuelsToKgoe({ E06: 1, E01: 999 }).value, 862.9, '電力不計入熱能');
  const s = C.diagnosisSummary([{ energyType: 'E01', annualSaving: 100000 }, { energyType: 'E04', annualSaving: 1000 }, { id: 'x' }]);
  assert.equal(s.value.count, 3);
  assert.equal(s.value.toe, 9.411);
  assert.equal(s.value.tenThousandKwh, 10);
  assert.equal(s.level, 'warn', '缺年節能量的措施要提示');
  assert.match(s.note, /NG1/);
  assert.equal(s.source.doc, '附件一 節能診斷報告');
});

test('表十之四 年度用電量計算（8 項可扣除）與表十一之四 年度用電量估算（6 項＋其他估算方式）', () => {
  assert.equal(C.DEDUCTIONS_N.length, 8);
  assert.equal(C.DEDUCTIONS_N1.length, 6);
  assert.ok(C.DEDUCTIONS_N.some((d) => d.key === 'safety') && !C.DEDUCTIONS_N1.some((d) => d.key === 'safety' || d.key === 'newRegulation'));
  const r = C.annualConsumptionN({ billKwh: 1000000, selfUseKwh: 5000, deductions: { newBuilding: 20000, safety: 5000 } });
  assert.equal(r.value, 980000);
  assert.equal(r.actual, 1005000);
  assert.equal(r.source.ref.startsWith('表十之四 年度用電量計算'), true);
  assert.equal(C.annualConsumptionN({ billKwh: 10, deductions: { ev: -1 } }).ok, false);
  assert.equal(C.annualConsumptionN({}).ok, null);
  const f = C.forecastConsumption({ actualKwh: 1005000, deductions: { construction: 5000, safety: 999 } });
  assert.equal(f.value, 1000000, '表十一之四沒有「安全考量」這項，不扣');
  assert.equal(C.forecastConsumption({ method: 'other', estimateKwh: 900000 }).ok, false, '其他估算方式須附說明');
  assert.equal(C.forecastConsumption({ method: 'other', estimateKwh: 900000, note: '新大樓' }).value, 900000);
  assert.match(f.source.ref, /表十一之四/);
});

test('節電率：年度、平均（含前期超額）、目標', () => {
  const r = C.annualSavingRate({ a: 10, b: 0, c: 5, d: 5, f: 1000, g: 20 });
  assert.equal(r.saving, 20);
  assert.equal(r.consumption, 980);
  assert.equal(r.value, 2);
  assert.equal(C.annualSavingRate({ saving: 5, consumption: 995, targetPct: 1 }).level, 'warn');
  const avg = C.averageSavingRate([{ saving: 10, consumption: 990 }, { saving: 10, consumption: 990 }], { prevExcess: 20, targetPct: 1 });
  assert.equal(avg.value, 2);
  assert.equal(avg.ok, true);
  assert.equal(C.averageSavingRate([{ saving: 5, consumption: 995 }], { targetPct: 1 }).level, 'warn');
  assert.equal(C.savingTarget({ contractKw: 10000 }).value, 1);
  assert.equal(C.savingTarget({ contractKw: 10001 }).value, 1.5);
  assert.equal(C.savingTarget({ stateOwned: true }).value, 1.5);
});

test('表九之四：設備利用率、全年運轉時數比例', () => {
  assert.equal(C.utilizationRate(300, 400).value, 75);
  assert.equal(C.utilizationRate(500, 400).ok, false);
  assert.equal(C.runHoursRate(4380).value, 50);
  assert.equal(C.runHoursRate(9000).ok, false);
});

// ── 期限 ──

test('期限：今天 2026-10-22 起的下一次申報期限與天數', () => {
  const list = C.upcomingDeadlines('2026-10-22', { isoCertExpiry: '2026-12-01', licenceExpiry: '2020-01-01' });
  const byKey = Object.fromEntries(list.map((x) => [x.key, x]));
  assert.equal(byKey.iso50001.daysLeft, 40);
  assert.equal(byKey.annex3.date, '2027-01-31');
  assert.equal(byKey.annex3.daysLeft, 101);
  assert.match(byKey.annex3.label, /115 年資料/);
  assert.equal(byKey['saving-rate'].date, '2027-03-31');
  assert.equal(byKey['first-period'].dateRoc, '117-03-31');
  assert.equal(byKey.licence, undefined);   // 已過期的不列
  // 依天數排序
  assert.deepEqual(list.map((x) => x.daysLeft), [...list.map((x) => x.daysLeft)].sort((a, b) => a - b));
});

test('期限：當天到期仍列（0 天），過了跳下一年；第一期過後不再列', () => {
  const onDay = C.upcomingDeadlines('2027-01-31');
  const a = onDay.find((x) => x.key === 'annex3');
  assert.equal(a.daysLeft, 0);
  assert.equal(a.level, 'warn');
  assert.match(a.msg, /今天到期/);
  const after = C.upcomingDeadlines('2028-04-01');
  assert.equal(after.find((x) => x.key === 'annex3').date, '2029-01-31');
  assert.equal(after.find((x) => x.key === 'first-period'), undefined);
});

// ── 業主決定與依據 ──

test('R2 EX01：醫院不適用國軍部隊用戶排除（業主 2026-10-22 確認），仍列管', () => {
  const ex01 = { code: 'EX01', reason: '國軍', evidence: ['函'] };
  const r = C.exclusionCheck(ex01, { userClass: '醫院' });
  assert.equal(r.ok, null);
  assert.equal(r.level, 'na');
  assert.equal(r.value, false);
  assert.match(r.msg, /業主 2026-10-22 確認國軍醫院為主要執行單位/);
  const s = C.energyUserStatus({ contractKw: 3000, userClass: '醫院', exclusions: [ex01] });
  assert.equal(s.value, true);
  assert.equal(s.r2.items[0].level, 'na');
  // 非醫院單位仍可適用 EX01
  assert.equal(C.energyUserStatus({ contractKw: 3000, userClass: '其他', exclusions: [ex01] }).value, false);
});

test('依據：每條規則與期限的結果都帶 source', () => {
  const calls = {
    readingUsage: [1, 0], energyUserCheck: [{ contractKw: 900 }], exclusionCheck: [{ code: 'EX08' }],
    exclusionsCheck: [[{ code: 'EX10' }]], energyUserStatus: [{ contractKw: 900 }], diagnosisTeamCheck: [{ code: 'Q-L1' }],
    paybackYears: [1, 1], equipmentAge: [100, 115], replacementRequired: [{ category: 'LED', mfgYear: 100, reportYear: 115 }],
    planMandatory: [3], planRowCheck: [{}], staffCountCheck: [{}], businessScaleCheck: [{ userClass: '醫院' }],
    occupancyRateCheck: [{}], euiDiffCheck: [1, 2], powerFactorCheck: [96], transformerLoadCheck: [{ loadPct: 60 }],
    chillerTableCheck: [{ totalRt: 10 }], isoQuestions: [{}], pueTableRequired: ['醫院'], boilerCheck: [{}],
    indoorArea: [10], euiElectric: [1, 10], euiThermal: [1, 10], chillerEfficiency: [1, 1], pue: [1, 1],
    energyCostRatio: [1, 10], demandResponseSaving: [1, 1], annualConsumption: [1], savingTarget: [{ contractKw: 900 }],
    annualSavingRate: [{ saving: 1, consumption: 99 }], averageSavingRate: [[{ saving: 1, consumption: 99 }]],
    annualConsumptionN: [{ billKwh: 1 }], forecastConsumption: [{ actualKwh: 1 }], toToe: [1, 'E01'], fuelsToKgoe: [{ E06: 1 }],
    diagnosisSummary: [[]],
    utilizationRate: [1, 2], runHoursRate: [10],
  };
  for (const [name, args] of Object.entries(calls)) {
    const r = C[name](...args);
    assert.ok(r.source && r.source.doc && r.source.ref && r.source.spec, `${name} 缺 source`);
  }
  assert.equal(C.replacementRequired({ category: 'LED', mfgYear: 100, reportYear: 115 }).source.doc, '附件一');
  assert.equal(C.replacementRequired({ category: 'LED', mfgYear: 100, reportYear: 115 }).source.ref, '註 2');
  assert.match(C.replacementRequired({}).source.law, /經能字第 11558001660 號/);
  // 新版附表三已刪除表十之六；節電率依 114–117 規定，依據不得再指向已刪除的表
  for (const k of Object.keys(C.SOURCES)) assert.doesNotMatch(String(C.SOURCES[k].ref), /表十之六/, `${k} 仍引用已刪除的表十之六`);
  const rec = C.recordUsage([{ id: 'k', type: 'reading' }], { k: 2 }, { values: { k: 1 } });
  assert.ok(rec.source && rec.results.k.source);
  for (const d of C.upcomingDeadlines('2026-10-22', { isoCertExpiry: '2027-01-01', licenceExpiry: '2027-06-01' })) {
    assert.ok(d.source && d.source.law, `${d.key} 缺 source`);
  }
  assert.match(C.upcomingDeadlines('2026-10-22').find((d) => d.key === 'first-period').source.ref, /第四點/);
  // 沒漏包：規則函式數＝上面清單＋recordUsage／upcomingDeadlines
  const ruleFns = Object.keys(C).filter((k) => typeof C[k] === 'function' && !['num', 'round', 'rocToAd', 'adToRoc', 'toRocYear', 'parseDate', 'toIso', 'toRocDate', 'daysBetween', 'addYears', 'replaceCategory', 'equipmentReplaceCategory', 'recordUsage', 'upcomingDeadlines'].includes(k));
  assert.deepEqual(ruleFns.sort(), Object.keys(calls).sort());
});
