// 水足跡第三方查證資料包（工作清單 26-6；ISO 14046:2014 第 7 章 鑑定性審查 critical review）。
// GET /api/inv/report/water-verification?year=N → zip（report-routes.js 分派）。
//
// 查證人要「從結果追回原始紀錄」：清冊（結果）→ 計算過程與係數來源（怎麼算、用哪個係數、哪一版）
// → 原始紀錄（誰、什麼時候、填了什麼）→ 照片清單 → 異動紀錄（誰改過範疇、點位）→ 資料品質評估。
// 全部從同一份計算（public/inventory-compute.js 的 waterFootprint）與 buildWater 產出，不另算。
// 純函式：buildWaterVerification(inv, { year, today, hospitalName }) → { buffer, filename, files }。
import { zip } from './xlsx.js';
import { toXlsx } from './report-xlsx.js';
import { buildWater, waterYear } from './report-water.js';
import { WATER_SITE_BLOCKS } from './water-schema.js';
import { todayIso } from './report-model.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;

const csvCell = (v) => { const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => Buffer.from('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
const srcText = (s) => (s ? [s.doc, s.ref, s.law, s.note, s.url].filter(Boolean).join('｜') : '');
const FLOW_LABEL = { intake: '取水', use: '用水單元分表', discharge: '排放', reuse: '回收再利用', quality: '水質', saving: '節水改善' };
const WATER_BLOCK_IDS = new Set(WATER_SITE_BLOCKS.map((b) => b.id));

// 計算過程：每個結果一列（項目、公式、輸入、結果、單位、係數與來源、依據）
function calcRows(W, roc) {
  const F = W.flows, I = W.indirect, E = I.electricity, SC = W.scarcity;
  const rows = [['項目', '公式', '輸入', '結果', '單位', '係數／方法', '依據']];
  rows.push(['取水量', 'Σ 標「取水」項目的月用量（reading＝本次－上次讀數；公升 ÷1,000）', F.intake.bySource.map((b) => `${b.name} ${b.total ?? '—'}`).join('；'), F.intake.total, 'm³', F.intake.inferred ? '推定（點位未標流向）' : '實測', srcText(F.intake.source)]);
  rows.push(['排放量', 'Σ 標「排放」項目', F.discharge.byDestination.map((b) => `${b.name} ${b.total ?? '—'}`).join('；'), F.discharge.total, 'm³', F.discharge.measured ? '實測' : '未量測', srcText(F.discharge.source)]);
  rows.push(['回收再利用量', 'Σ 標「回收再利用」項目', '', F.reuse.total, 'm³', '', srcText(F.reuse.source)]);
  rows.push(['消耗量', F.consumption.method === 'balance' ? '取水－排放' : F.consumption.method === 'units' ? 'Σ 用水單元用水量 × 消耗比例' : '—', '', F.consumption.value, 'm³', F.consumption.msg, srcText(F.consumption.source)]);
  for (const u of F.units) rows.push([`用水單元·${u.name}`, u.metered ? 'Σ 分表用量' : u.estimated ? '估計占比 × 取水量' : '—', u.estimated ? `占比 ${u.share}%` : '', u.use, 'm³', `消耗比例 ${u.consumptionPct ?? '—'}%`, srcText(F.unitsSource)]);
  for (const p of W.performance) rows.push([`績效指標·${p.label}`, p.months ? 'Σ 同月取水 ÷ Σ 同月分母（每月實填）' : `取水 ÷ ${p.denomLabel}`, `分母 ${p.denominator ?? '—'}${p.monthsUsed !== undefined ? `（${p.monthsUsed} 個月）` : ''}`, p.value, p.unit, '', srcText(p.source)]);
  for (const c of W.baseline?.compare || []) rows.push([`與基線比較·${c.label}`, '（本年－基線）÷ 基線', `基線 ${c.baseline ?? '—'}`, c.diffPct, '%', c.msg, srcText(c.source)]);
  for (const t of W.targets.rows) rows.push([`目標達成度·${t.label}`, '（基線－本年）÷ 基線 ÷ 目標降幅', `基線 ${t.baseline ?? '—'}、本年 ${t.value ?? '—'}、目標 ${t.targetPct ?? '—'}%`, t.progressPct, '%', t.msg, srcText(W.targets.source)]);
  rows.push(['外購電力用電量', E.method === 'bill' ? 'Σ 電費單尖峰＋半尖峰＋週六半尖峰＋離峰（同電號同月取最後一筆）' : E.method === 'reading' ? 'Σ 連結電號的電表讀數用量' : '—', `${E.monthsCovered}/12 個月`, E.kwh, 'kWh', '', '']);
  rows.push(['間接用水·發電耗水', '用電量 × 耗水係數 ÷ 1,000', `${E.factor.consumption} L/kWh${E.factor.custom ? '（院方自訂）' : ''}`, E.consumption, 'm³', E.factor.custom ? E.factor.note : `${E.source.doc}（${C.WATER_ELEC.dataYear} 年）`, srcText(E.source)]);
  rows.push(['間接用水·發電取水', '用電量 × 取水係數 ÷ 1,000', `${E.factor.withdrawal} L/kWh`, E.withdrawal, 'm³', '', srcText(E.source)]);
  rows.push(['間接用水計入邊界', '範疇「系統邊界」', W.scope.boundary || '（未填，預設直接用水）', I.included ? '是' : '否', '', '', srcText(I.boundarySource)]);
  rows.push(['缺水足跡·直接', SC.method === 'monthly' ? 'Σ 月消耗 × 月別 CF' : '年消耗 × 年平均 CF', `${SC.region.label}；${SC.useLabel}；年平均 CF ${SC.cfAnnual}`, SC.direct.value, SC.unit, `${SC.model.name} ${SC.model.version}`, srcText(SC.source)]);
  for (const r of SC.rows || []) rows.push([`缺水足跡·${roc} 年 ${r.month} 月`, '月消耗 × 月別 CF（負值以 0 計）', `消耗 ${r.consumption ?? '—'} × CF ${r.cf}`, r.wsf, SC.unit, '', '']);
  rows.push(['缺水足跡·間接（外購電力）', '發電耗水 × 全國平均 CF（非農業）', `${SC.indirect.consumption ?? '—'} × ${SC.indirect.cf}`, SC.indirect.value, SC.unit, SC.indirect.included ? '計入' : '不計入', srcText(SC.cfSource)]);
  rows.push(['缺水足跡·合計', '直接＋間接（有納入邊界時）', '', SC.total, SC.unit, SC.msg, srcText(SC.source)]);
  rows.push([]);
  rows.push(['係數清單', '', '', '', '', '', '']);
  rows.push(['AWARE 特徵化因子', `${C.WATER_AWARE.name} ${C.WATER_AWARE.version}`, C.WATER_AWARE.file, '', 'm³ world-eq/m³', C.WATER_AWARE.published, C.WATER_AWARE.url]);
  for (const r of C.WATER_AWARE.regions) rows.push([`AWARE·${r.label}`, '年平均（非農業／農業／不分用途）', `${r.annual.nonAgri}／${r.annual.agri ?? '—'}／${r.annual.unknown ?? '—'}`, '', '', r.monthly?.nonAgri ? `月別（非農業）：${r.monthly.nonAgri.join('、')}` : '無月別', r.note || '']);
  rows.push(['發電用水係數（預設）', `耗水 ${C.WATER_ELEC.consumption}／取水 ${C.WATER_ELEC.withdrawal}`, `${C.WATER_ELEC.dataYear} 年`, '', 'L/kWh', C.WATER_ELEC.source.note, `${C.WATER_ELEC.source.doc} ${C.WATER_ELEC.source.ref} ${C.WATER_ELEC.source.url}`]);
  for (const x of C.WATER_EFFLUENT.items) rows.push([`放流水標準·${x.param}`, x.label, C.waterQualityLimitText(x), '', x.unit, '', x.basis]);
  return rows;
}

export function buildWaterVerification(inv, opts = {}) {
  const today = opts.today || todayIso();
  const Y = waterYear(opts.year, today) ?? waterYear(undefined, today);
  const roc = Y - 1911;
  const built = buildWater(inv, { ...opts, year: Y, today });
  const W = C.waterFootprint(inv, { year: Y });
  const hospital = inv.site?.basic?.userName || opts.hospitalName || '';
  const files = [];
  const dir = `水足跡查證資料包_${roc}年`;
  const add = (name, buf) => files.push([`${dir}/${name}`, buf]);

  const points = (inv.points || []).filter((p) => p.domain === 'water');
  const codes = new Set(points.map((p) => p.code));
  const recs = (inv.records || []).filter((r) => codes.has(r.pointCode) && String(r.period || '').startsWith(`${Y}-`)).sort((a, b) => (a.at < b.at ? -1 : 1));

  // 03 原始紀錄（每筆 × 每項目一列）
  const raw = [['紀錄 ID', '點位代碼', '點位名稱', '期別', '填寫時間', '填寫人（帳號）', '填寫人姓名', '項目 id', '項目', '類型', '流向', '值', '本次用量', '單位', '備註', '照片數', '異常']];
  for (const r of recs) {
    const p = points.find((x) => x.code === r.pointCode);
    for (const it of p?.items || []) {
      const v = r.values?.[it.id];
      if (v === undefined) continue;
      raw.push([r.id, r.pointCode, p.name, r.period, r.at, r.who, r.reporter || '', it.id, it.label, it.type, FLOW_LABEL[it.waterFlow] || '', Array.isArray(v) ? v.join(' ') : v, r.usage?.[it.id] ?? '', it.unit || '', r.note || '', (r.photos || []).length, (r.anomalies || []).length]);
    }
  }
  // 用電（間接用水的活動數據）
  const elec = [['來源', '電號', '月份', '度數（kWh）', '紀錄 ID', '點位', '填寫時間', '填寫人']];
  for (const x of W.indirect.electricity.rows) elec.push([x.source, x.meterNo, x.month, x.kwh, x.recordId, x.pointCode, x.at, x.who]);
  // 每月營運活動
  const monthly = [['月份', '住院人日', '門診人次', '急診人次', '住院人次']];
  for (const m of inv.annual?.[roc]?.waterMonthly || []) monthly.push([m.month, m.bedDays, m.outpatientVisits, m.erVisits, m.admissions]);
  const meta = inv.annual?.[roc]?._meta?.waterMonthly;
  if (meta) monthly.push([], ['最後儲存', meta.at, meta.who, meta.reporter || '']);

  // 04 照片清單
  const photos = [['照片 ID', '格式', '大小（bytes）', '紀錄 ID', '點位代碼', '點位名稱', '期別', '項目', '上傳紀錄時間', '填寫人', '系統內路徑']];
  for (const r of recs) {
    const p = points.find((x) => x.code === r.pointCode);
    for (const ph of r.photos || []) {
      const item = (p?.items || []).find((it) => it.type === 'photo' && (r.values?.[it.id] || []).includes(ph.id));
      photos.push([ph.id, ph.mime || '', ph.size || '', r.id, r.pointCode, p?.name || '', r.period, item?.label || '（紀錄附件）', r.at, r.who, `/api/inv/photo/${ph.id}`]);
    }
  }

  // 05 異動紀錄：水的初始建檔區塊、水類點位、點位匯入含水類點位
  const isWaterChange = (c) => {
    const t = String(c.target || '');
    if (t.startsWith('site.') && WATER_BLOCK_IDS.has(t.slice(5))) return true;
    if (t.startsWith('point.') && codes.has(t.slice(6))) return true;
    if (c.kind === 'point.import') return [...(c.links?.added || []), ...(c.links?.updated || [])].some((x) => codes.has(typeof x === 'string' ? x : x?.code));
    return false;
  };
  const changes = [['異動 ID', '時間', '操作人（帳號）', '姓名', '類別', '對象', '原因', '變更前', '變更後']];
  for (const c of (inv.changes || []).filter(isWaterChange)) changes.push([c.id, c.at, c.who, c.reporter || '', c.kind, c.target, c.reason, c.before, c.after]);

  // 06 資料品質評估
  const dq = [['檢查項目', '結果', '說明', '依據']];
  for (const c of W.completeness.checks) dq.push([c.label, c.ok ? '通過' : '未通過', c.ok ? '' : c.msg, srcText(c.source)]);
  dq.push(['完整度', `${W.completeness.pct}%`, `${W.completeness.passed}/${W.completeness.total} 項通過`, '']);
  dq.push([]);
  dq.push(['資料類別', '來源', '取得方式', '說明']);
  dq.push(['取水量', '貼紙點位（水表讀數）', W.flows.intake.inferred ? '推定' : '實測', `${W.completeness.monthsCovered}/12 個月`]);
  dq.push(['排放量', '貼紙點位', W.flows.discharge.measured ? '實測' : '未量測', '']);
  dq.push(['消耗量', '計算', W.flows.consumption.method === 'balance' ? '質量平衡' : W.flows.consumption.method === 'units' ? '估算' : '無', W.flows.consumption.msg]);
  dq.push(['營運活動（分母）', W.activity?.monthly ? '院方每月填報' : '初始建檔年值', W.activity?.monthly ? `${W.activity.monthsFilled}/12 個月` : '', '']);
  dq.push(['外購電力用電量', '電費單', W.indirect.electricity.method || '無', `${W.indirect.electricity.monthsCovered}/12 個月`]);
  dq.push(['發電用水係數', W.indirect.electricity.factor.custom ? '院方自訂' : '次級資料（台電永續報告書）', '', W.indirect.electricity.factor.note]);
  dq.push(['缺水特徵化因子', '次級資料（WULCA AWARE）', '', `${C.WATER_AWARE.version}；${W.scarcity.region.label}`]);
  dq.push(['水質', '貼紙點位（檢驗報告）', '', W.quality.msg]);
  dq.push([]);
  dq.push(['待補欄位（清冊）', '', '', '']);
  for (const m of built.missing) dq.push([m.sheet, m.field, m.why, '']);

  const readme = [
    `水足跡查證資料包｜${hospital}｜資料年 ${roc} 年（${Y} 年 1～12 月）｜產出 ${today}`,
    '',
    '用途：供 ISO 14046:2014 第 7 章鑑定性審查（critical review）或第三方查證使用。查證人可由結果追回原始紀錄。',
    '',
    '01 水足跡盤查清冊.xlsx      結果：目的與範疇、取水、用水單元、排放與回收、水平衡、間接用水、水質、績效指標與目標、衝擊評估（缺水足跡）、資料品質',
    '02 計算過程與係數來源.csv    每個結果的公式、輸入、係數與版本、依據條號；最後列出所有係數',
    '03 原始紀錄_水類點位.csv     每筆貼紙紀錄 × 每個項目：填寫人（帳號與姓名）、填寫時間、值、本次用量',
    '03b 原始紀錄_用電.csv        間接用水（外購電力）用到的電費單或電表讀數',
    '03c 每月營運活動.csv         院方每月填報的住院人日與門急診人次（績效指標分母）',
    '04 照片清單.csv              紀錄附的照片（水表、檢驗報告）；照片檔在系統內，依路徑登入後下載',
    '05 異動紀錄.csv              水足跡範疇、水源、用水單元、排放口、水質項目、水類點位的修改紀錄（含原因與前後值）',
    '06 資料品質評估.csv          完整度檢查、各類資料的取得方式（實測／估算／推定／次級資料）、待補欄位',
    '07 範疇與建檔資料.json       初始建檔的水足跡區塊與水類點位設定（原始資料）',
    '',
    '注意：ISO 14046、ISO 46001 正本尚未購買；5.2、5.3、5.4 與第 7 章條文內容部分取自二手來源，條號對照見 docs/water-footprint-spec.md §0。',
    `缺水足跡特徵化模型：${C.WATER_AWARE.name} ${C.WATER_AWARE.version}（${C.WATER_AWARE.url}）。發電用水係數：${C.WATER_ELEC.source.doc}（${C.WATER_ELEC.dataYear} 年）。`,
  ].join('\r\n');
  const setup = { year: Y, rocYear: roc, hospital, site: Object.fromEntries([...WATER_BLOCK_IDS].map((k) => [k, inv.site?.[k] ?? null])), points, factors: { aware: C.WATER_AWARE, electricity: C.WATER_ELEC, effluent: C.WATER_EFFLUENT } };

  add('00_說明.txt', Buffer.from('﻿' + readme + '\r\n', 'utf8'));
  add(`01_${built.filename}`, toXlsx(built));
  add('02_計算過程與係數來源.csv', csv(calcRows(W, roc)));
  add('03_原始紀錄_水類點位.csv', csv(raw));
  add('03b_原始紀錄_用電.csv', csv(elec));
  add('03c_每月營運活動.csv', csv(monthly));
  add('04_照片清單.csv', csv(photos));
  add('05_異動紀錄.csv', csv(changes));
  add('06_資料品質評估.csv', csv(dq));
  add('07_範疇與建檔資料.json', Buffer.from(JSON.stringify(setup, null, 2), 'utf8'));
  return { buffer: zip(new Map(files)), filename: `水足跡查證資料包_${roc}年_${hospital || '院所'}.zip`, files: files.map(([n]) => n), year: Y, counts: { records: recs.length, photos: photos.length - 1, changes: changes.length - 1 } };
}
