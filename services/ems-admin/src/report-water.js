// 水足跡盤查清冊（工作清單 23）→ xlsx。GET /api/inv/report/water?year=N（report-routes.js 的 BUILDERS 分派）。
//
// 結構依 ISO 14046:2014 的方法架構：目的與範疇（5.2）→ 盤查（5.3：取水、用水單元、排放與回收、水質）
// → ISO 46001:2019 的水平衡（附錄 C）→ 間接用水（5.2.3，外購電力）→ 水質（放流水標準）→ 用水績效指標、基線與目標達成度
// （3.2、3.4、6.2.5～6.2.7、6.3）→ 衝擊評估（5.4，缺水足跡，AWARE）→ 資料品質（4.8、5.2.4）。
// 依 3.3.1 註 1，衝擊結果稱「缺水足跡」；檔名仍為「水足跡盤查清冊」。條號與取得程度見 docs/water-footprint-spec.md。
//
// 每張工作表第 1 列表名、第 2 列依據、第 3 列院所與資料年（同附表三報表慣例）。推不出的格子留空並列入「待補欄位」。
// 計算全部走 public/inventory-compute.js 的 waterFootprint（前後端同一份）。
// 純函式：buildWater(inv, { year, today, hospitalName }) → { sheets, missing, filename, summary }。
import { siteBlockById, refLabel } from './inventory-schema.js';
import { WATER_SPEC } from './water-schema.js';
import { todayIso } from './report-model.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;
const blank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const val = (v) => (v === undefined || v === null ? '' : v);
const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`);

function srcLine(s) {
  if (!s) return '';
  return `依據：${s.doc}${s.ref ? ` ${s.ref}` : ''}${s.note ? `｜${s.note}` : ''}${s.spec ? `｜${s.specDoc || ''} ${s.spec}` : ''}`;
}

class Sheet {
  constructor(ctx, name, title, source) {
    this.ctx = ctx; this.name = name; this.rows = []; this.cols = []; this.source = source;
    this.rows.push([{ v: title, s: 'title' }]);
    this.rows.push([{ v: srcLine(source), s: 'note' }]);
    this.rows.push([{ v: `${ctx.hospital}｜${ctx.yearLabel}｜產出 ${ctx.todayRoc}`, s: 'note' }]);
    this.rows.push([]);
    ctx.sheets.push(this);
  }
  head(cells) { this.rows.push(cells.map((v) => ({ v, s: 'head' }))); return this; }
  row(cells) { this.rows.push(cells.map((v) => ({ v: val(v), s: 'cell' }))); return this; }
  text(t) { this.rows.push([{ v: t, s: 'note' }]); return this; }
  gap() { this.rows.push([]); return this; }
  widths(...w) { this.cols = w; return this; }
  need(field, why) { this.ctx.missing.push({ sheet: this.name, field, why: why || '' }); return this; }
}

// 資料年：民國 2～3 位數（同附表三），4 位數視為西元；沒給＝去年
export function waterYear(year, today = todayIso()) {
  const s = year === undefined || year === null || year === '' ? '' : String(year).trim();
  if (!s) return Number(today.slice(0, 4)) - 1;
  if (!/^\d{2,4}$/.test(s)) return null;
  const n = Number(s);
  return s.length <= 3 ? n + 1911 : n;
}

export function buildWater(inv, opts = {}) {
  const today = opts.today || todayIso();
  const Y = waterYear(opts.year, today) ?? waterYear(undefined, today);   // 格式錯的年（路由已擋）退回去年
  const roc = Y - 1911;
  const ctx = {
    sheets: [], missing: [], todayRoc: C.toRocDate(C.parseDate(today)),
    hospital: inv.site?.basic?.userName || opts.hospitalName || '（未填用戶名稱）',
    yearLabel: `資料年 ${roc} 年（${Y} 年 1～12 月）`,
  };
  const site = inv.site || {};
  const W = C.waterFootprint(inv, { year: Y });
  const F = W.flows;
  const scope = site.waterScope || {};
  const bName = (id) => refLabel(site, 'buildings', id);

  // 1. 目的與範疇（5.2）
  const sc = new Sheet(ctx, '目的與範疇', '水足跡盤查清冊·目的與範疇', { doc: 'ISO 14046:2014', ref: '5.2.1～5.2.4；3.3.8、3.3.9、3.5.7', spec: '§2.1', specDoc: 'docs/water-footprint-spec.md' });
  sc.widths(30, 60, 50).head(['欄位', '內容', '說明']);
  const scopeBlock = siteBlockById('waterScope');
  for (const f of scopeBlock.fields) {
    let v = scope[f.key];
    let note = f.hint || '';
    if (blank(v) && f.default !== undefined) { v = f.default; note = `預設值${note ? `；${note}` : ''}`; }
    const shown = Array.isArray(v) ? v.join('、') : f.type === 'year' && v ? `${Number(v) - 1911} 年（${v}）` : f.type === 'percent' && v !== undefined ? `${v}%` : f.optionLabels?.[v] ? `${v} ${f.optionLabels[v]}` : v;
    sc.row([f.label, shown, note]);
    if (blank(v) && (f.required || ['cutoff', 'drainageBasin', 'dataQuality'].includes(f.key))) sc.need(f.label, f.required ? '必填，尚未填寫（初始建檔 › 水足跡範疇與基線）' : '建議填寫（初始建檔 › 水足跡範疇與基線）');
  }
  sc.gap().text('本檔含 ISO 14046 的水足跡盤查（5.3）與缺水足跡衝擊評估（5.4，AWARE）；未評估水質劣化類衝擊。依 3.3.1 註 1，結果稱「缺水足跡」，不單稱「水足跡」。');
  sc.text(`系統邊界：${W.indirect.included ? '院區直接用水＋間接用水（外購電力以係數估算；其他上游只登錄）' : '院區直接用水（間接用水只列參考值，不計入）'}`);
  sc.text('單位：m³（水費單的「度」＝m³）。消耗量依 3.2.1 註 2：取出後沒有回到同一流域的水。');

  // 2. 取水（依水源別）
  const si = new Sheet(ctx, '取水', '水足跡盤查清冊·取水（依水源別）', F.intake.source);
  si.widths(14, 22, 16, 10, 16, ...MONTHS.map(() => 10), 12, 10).head(['水源類型', '水源名稱', '水號／水權狀號', '水質類別', '取水水體', ...MONTHS, '合計（m³）', '占比（%）']);
  for (const b of F.intake.bySource) si.row([b.type, b.name, b.accountNo, b.freshness, b.waterBody, ...b.months, b.total, b.share]);
  if (!F.intake.bySource.length) si.row(['（無資料）']);
  si.row(['合計', '', '', '', '', ...F.intake.months, F.intake.total, F.intake.total !== undefined ? 100 : '']);
  si.gap().row(['替代水源量（雨水、再生水、院內回收水）', F.intake.replace, 'm³', F.intake.replacePct !== undefined ? `${F.intake.replacePct}%` : '']);
  si.text(srcLine(C.WATER_SOURCES.replace));
  if (F.intake.inferred) si.text('⚠ 沒有任何點位項目標「取水」，本表以水類點位的讀數項目推定；請到點位管理設定流向。');
  if (!site.waterSources?.length) si.need('水源', '尚未登錄水源（初始建檔 › 水源）');
  if (F.intake.total === undefined) si.need('取水量', `${roc} 年沒有取水紀錄（貼紙點位：自來水總表等）`);
  for (const b of F.intake.bySource) if (b.id && !b.items.length) si.need(`水源「${b.name}」取水量`, '沒有點位項目連到這個水源');
  F.intake.months.forEach((v, i) => { if (v === undefined && F.intake.total !== undefined) si.need(`取水 ${i + 1} 月`, '該月沒有取水紀錄'); });

  // 3. 主要用水單元
  const su = new Sheet(ctx, '主要用水單元', '水足跡盤查清冊·主要用水單元', F.unitsSource);
  su.widths(16, 24, 16, 10, 22, 10, 14, 10, 12, 14).head(['用水單元', '名稱', '建築', '主要用水', '用水型態', '有分表', '用水量（m³）', '占比（%）', '消耗比例（%）', '估計消耗（m³）']);
  for (const u of F.units) {
    su.row([u.kind, u.name, bName(u.building), u.significant ? '是' : '', u.useForm, u.metered ? '是' : (u.estimated ? '否（估計占比）' : '否'), u.use, u.share, u.consumptionPct, u.consumption]);
    if (u.id && u.use === undefined) su.need(`用水單元「${u.name}」用水量`, '沒有分表也沒有估計占比');
  }
  if (!F.units.length) { su.row(['（無資料）']); su.need('主要用水單元', '尚未登錄（初始建檔 › 主要用水單元）'); }
  su.row(['未分表量（含管損、一般衛生）', '', '', '', '', '', F.unmetered, F.intake.total && F.unmetered !== undefined ? C.round(F.unmetered / F.intake.total * 100, 1) : '', '', '']);
  if (F.unmetered !== undefined && F.unmetered < 0) su.text('⚠ 分表合計大於總取水，請檢查讀數或是否有取水點位未標流向。');
  su.text(srcLine(C.WATER_SOURCES.consumption));

  // 4. 排放與回收
  const sd = new Sheet(ctx, '排放與回收', '水足跡盤查清冊·排放與回收', F.discharge.source);
  sd.widths(18, 22, 20, 18, ...MONTHS.map(() => 10), 12).head(['去向', '名稱', '承受水體／下水道', '許可或納管文號', ...MONTHS, '合計（m³）']);
  for (const b of F.discharge.byDestination) sd.row([b.destination, b.name, b.receivingBody, b.permitNo, ...b.months, b.total]);
  if (!F.discharge.byDestination.length) sd.row(['（無資料）']);
  sd.row(['排放合計', '', '', '', ...F.discharge.months, F.discharge.total]);
  sd.gap().row(['回收再利用', '', '', '', ...F.reuse.months, F.reuse.total]);
  sd.row(['回收率（回收 ÷（取水＋回收））', F.reuse.rate !== undefined ? `${F.reuse.rate}%` : '']);
  sd.text(srcLine(F.reuse.source));
  if (!site.waterDischarges?.length) sd.need('排放口', '尚未登錄（初始建檔 › 排放與回收）');
  if (!F.discharge.measured) sd.need('排放量', '沒有「排放」點位項目，消耗量只能估算');

  // 5. 水平衡（ISO 46001 附錄 C）
  const sb = new Sheet(ctx, '水平衡', '水足跡盤查清冊·水平衡', { doc: 'ISO 46001:2019', ref: '附錄 C 水平衡圖；ISO 14046 3.2.1 註 2', spec: '§3.3', specDoc: 'docs/water-footprint-spec.md' });
  sb.widths(34, 16, 60).head(['項目', 'm³', '說明']);
  sb.row(['取水', F.intake.total, F.intake.inferred ? '推定（點位未標流向）' : '標「取水」的點位項目合計']);
  sb.row(['回收再利用', F.reuse.total, '院內回收後再用，不重複計入取水']);
  sb.row(['有分表的用水單元合計', F.units.filter((u) => u.metered).reduce((s, u) => (u.use === undefined ? s : (s || 0) + u.use), undefined), '']);
  sb.row(['未分表量', F.unmetered, '取水 − 有分表的用水單元']);
  sb.row(['排放', F.discharge.total, F.discharge.measured ? '' : '未量測']);
  sb.row(['消耗', F.consumption.value, F.consumption.msg]);
  if (F.consumption.value === undefined) sb.need('消耗量', F.consumption.msg);

  // 5-1. 間接用水（5.2.3 系統邊界；外購電力 × 發電用水係數）
  const I = W.indirect, E = I.electricity;
  const sx = new Sheet(ctx, '間接用水', '水足跡盤查清冊·間接用水（外購電力等上游）', I.boundarySource);
  sx.widths(30, 14, 14, ...MONTHS.map(() => 10), 14).text(I.msg).gap();
  sx.head(['項目', '係數', '單位', ...MONTHS, '合計']);
  sx.row(['外購電力用電量（度）', '', 'kWh', ...E.months, E.kwh]);
  sx.row(['發電耗水量（m³）', E.factor.consumption, 'L/kWh', ...E.consumptionMonths, E.consumption]);
  sx.row(['發電取水量（m³）', E.factor.withdrawal, 'L/kWh', ...MONTHS.map(() => ''), E.withdrawal]);
  sx.row(['計入合計', I.included ? '是' : '否（系統邊界只含直接用水）']);
  sx.gap().text(`活動數據：${E.method === 'bill' ? '電費單（同電號同月取最後送出的那筆）' : E.method === 'reading' ? '電類點位連結電號的累計讀數' : '無'}；${E.monthsCovered}/12 個月`);
  sx.text(`係數：${E.factor.custom ? `院方自訂（${E.factor.note}）` : `${E.source.doc} ${E.source.ref}｜${E.source.note}｜${E.source.url}`}`);
  if (E.kwh === undefined) sx.need('外購電力用電量', `${roc} 年沒有電費單或電表讀數（貼紙點位：電費單）`);
  else if (E.monthsCovered < 12) sx.need('外購電力用電量', `只有 ${E.monthsCovered} 個月用電資料`);
  if (E.factor.custom && !scope.elecWaterFactorNote) sx.need('自訂係數來源', '有自訂外購電力用水係數時須寫出處與年份');
  sx.gap().head(['其他上游（只登錄、不量化）', '類別', '年用量', '單位', '備註']);
  for (const u of I.upstream) sx.row([u.name, u.category, u.annualQty, u.unit, u.note || '尚無係數，未量化']);
  if (!I.upstream.length) sx.row(['（未登錄）', '', '', '', '外購蒸汽、藥品耗材等，在初始建檔「間接用水·其他上游」登錄']);

  // 6. 水質（放流水標準預設組＋依許可覆寫；超標提示）
  const Q = W.quality;
  const sq = new Sheet(ctx, '水質', '水足跡盤查清冊·水質（檢測項目、限值與超標）', Q.source);
  sq.widths(22, 16, 12, 22, 10, 10, 8, 8, 10, 10, 10, 34).head(['排放口', '項目', '單位', '限值', '頻率', '應測次數', '實測', '超標', '最小', '最大', '平均', '依據']);
  for (const r of Q.rules) {
    const st = F.quality.find((q) => q.dischargeId === r.dischargeId && q.param === r.param);
    sq.row([r.dischargeName, r.param, r.unit, C.waterQualityLimitText(r), r.frequency, r.perYear, r.n, r.exceeded, st?.min, st?.max, st?.avg, `${r.origin === 'default' ? '預設：' : '許可：'}${r.basis}`]);
    if (!r.linked) sq.need(`${r.dischargeName}·${r.param}`, '沒有水質抽測點位項目連到這個項目（貼紙點位：水質抽測）');
    else if (r.shortfall) sq.need(`${r.dischargeName}·${r.param}`, `${roc} 年應測 ${r.perYear} 次（${r.frequency}），實測 ${r.n} 次`);
  }
  if (!Q.rules.length) sq.row(['（無需檢測的排放口）']);
  // 舊的寫法：排放口上勾的水質項目（沒有限值）
  const ruleKey = new Set(Q.rules.map((r) => `${r.dischargeId}|${r.param}`));
  for (const q of F.quality) if (!ruleKey.has(`${q.dischargeId}|${q.param}`)) sq.row([q.dischargeName, q.param, q.unit, '未設限值', '', '', q.n, '', q.min, q.max, q.avg, '']);
  for (const d of site.waterDischarges || []) for (const p of d.qualityParams || []) {
    if (!ruleKey.has(`${d.id}|${p}`) && !F.quality.some((q) => q.dischargeId === d.id && q.param === p && q.n > 0)) sq.need(`${d.name || d.id}·${p}`, `${roc} 年沒有抽測值（貼紙點位：水質抽測）`);
  }
  sq.gap().text(Q.msg);
  if (Q.exceedances.length) {
    sq.gap().head(['超標期別', '排放口', '項目', '測值', '單位', '限值', '填寫人', '點位', '紀錄 ID']);
    for (const x of Q.exceedances) sq.row([x.period, x.dischargeName, x.param, x.value, x.unit || '—', x.limit, x.who, x.pointCode, x.recordId]);
  }
  sq.text(`檢測頻率依據：${Q.frequencySource.doc} ${Q.frequencySource.ref}｜${Q.frequencySource.note}`);
  sq.text('預設項目組只套用在去向「自設污水處理設施後放流」的排放口；納管排入污水下水道者依當地下水道機構標準，請在初始建檔「水質檢測項目與頻率」設定。');

  // 7. 用水績效指標與基線
  const sp = new Sheet(ctx, '績效指標與基線', '水足跡盤查清冊·用水績效指標與基線', C.WATER_SOURCES.indicator);
  const act = W.activity;
  sp.widths(26, 18, 18, 16, 46).head(['營運活動資料', `${roc} 年`, W.baseline ? `基線 ${W.baseline.year - 1911} 年` : '基線年', '單位', '說明']);
  const ACT = siteBlockById('waterActivity').fields.filter((f) => f.type === 'number');
  for (const f of ACT) {
    sp.row([f.label, act?.[f.key], W.baseline?.activity?.[f.key], f.unit || '', f.key === 'floorArea' && act?.floorAreaFrom === 'basic' ? '取自基本資料表三第 18 欄' : '']);
  }
  if (!act || act.partial) sp.need(`營運活動資料 ${roc} 年`, '初始建檔 › 營運活動資料：住院人日、門急診人次、員工');
  sp.gap().head(['用水績效指標', `${roc} 年`, '基線年', '單位', '與基線比較']);
  for (const p of W.performance) {
    const cmp = W.baseline?.compare.find((x) => x.id === p.id);
    sp.row([p.label, p.value, cmp?.baseline, p.unit, cmp ? cmp.msg : '未設定基線年']);
    if (p.value === undefined) sp.need(`績效指標·${p.label}`, p.msg);
  }
  if (!W.baseline) sp.need('用水基線年', '初始建檔 › 水足跡範疇與基線');
  // 每月實填的分母（申報與報告 › 報表資料輸入）
  const monthlyP = W.performance.filter((p) => p.months);
  if (monthlyP.length) {
    sp.gap().head(['每月（實填分母）', ...MONTHS]);
    sp.row(['取水（m³）', ...F.intake.months]);
    for (const p of monthlyP) {
      sp.row([`${p.denomLabel}`, ...p.months.map((m) => m.denominator)]);
      sp.row([`${p.label}（${p.unit}）`, ...p.months.map((m) => m.value)]);
    }
  }
  if (act?.monthly && act.monthsFilled < 12) sp.need(`每月營運活動 ${roc} 年`, `只填了 ${act.monthsFilled}/12 個月（申報與報告 › 報表資料輸入）`);
  // 節水目標達成度（ISO 46001 6.3）
  const TG = W.targets;
  sp.gap().head(['節水目標達成度', '本年', '基線', '降幅（%）', '達成度（%）', '說明']);
  for (const t of TG.rows) sp.row([t.label, t.value, t.baseline, t.reductionPct, t.progressPct, t.msg]);
  if (TG.targetPct === undefined) sp.need('節水目標', '初始建檔 › 水足跡範疇與基線：用水效率目標（較基線降低 %）與目標年');
  sp.text(srcLine(TG.source));
  sp.text(srcLine(C.WATER_SOURCES.baseline));
  sp.text('官方沒有醫院用水標竿（每床日），本表只與自己的基線比較。');

  // 7-1. 衝擊評估：缺水足跡（ISO 14046 5.4；AWARE）
  const SC = W.scarcity;
  const sa = new Sheet(ctx, '衝擊評估', '水足跡盤查清冊·衝擊評估（缺水足跡）', SC.source);
  sa.widths(30, 22, 18, 60).head(['項目', '值', '單位', '說明']);
  sa.row(['特徵化模型', `${SC.model.name} ${SC.model.version}`, '—', `${SC.model.file}｜${SC.model.url}`]);
  sa.row(['地區（流域）', SC.region.label, '—', SC.region.note || '初始建檔 › 水足跡範疇與基線「缺水特徵化因子地區」']);
  sa.row(['用途別', SC.useLabel, '—', SC.cfFallback ? '這個地區沒有該用途別的因子，改用非農業年平均' : '醫院屬非農業用水']);
  sa.row(['年平均特徵化因子 CF', SC.cfAnnual, 'm³ world-eq/m³', SC.method === 'monthly' ? '本年改用月別 CF（見下表）' : '年消耗 × 年平均 CF']);
  sa.row(['直接用水消耗量', SC.direct.consumption, 'm³', SC.direct.consumptionMethod === 'balance' ? '取水－排放（質量平衡）' : SC.direct.consumptionMethod === 'units' ? '用水單元消耗比例估算' : '算不出']);
  sa.row(['直接用水缺水足跡', SC.direct.value, 'm³ world-eq', SC.method === 'monthly' ? '逐月消耗 × 月別 CF' : '年消耗 × 年平均 CF']);
  sa.row(['間接用水（外購電力）消耗量', SC.indirect.consumption, 'm³', SC.indirect.included ? '計入' : '不計入（系統邊界只含直接用水）；僅供參考']);
  sa.row(['間接用水缺水足跡', SC.indirect.value, 'm³ world-eq', `× 全國平均 CF ${SC.indirect.cf}（發電廠分布全台）`]);
  sa.row(['缺水足跡合計', SC.total, 'm³ world-eq', SC.msg]);
  if (SC.rows) {
    sa.gap().head(['月份', '消耗量（m³）', '月別 CF', '缺水足跡（m³ world-eq）']);
    for (const r of SC.rows) sa.row([`${r.month} 月`, r.consumption, r.cf, r.wsf]);
  }
  if (SC.total === undefined) sa.need('缺水足跡', SC.msg);
  sa.gap().text(`特徵化因子來源：${SC.cfSource.doc} ${SC.cfSource.ref || ''}${SC.cfSource.note ? `｜${SC.cfSource.note}` : ''}`);
  sa.text('缺水足跡＝Σ（消耗量 × CF）。CF 表示該地區每消耗 1 m³ 相對於世界平均的缺水程度（AWARE：0.1～100）。結果是「缺水足跡」，不是完整的水足跡（未含水質劣化類衝擊）。');
  sa.text('ISO 14046 5.4 的條文內容未取得原文（二手來源），見 docs/water-footprint-spec.md §0、§10。');

  // 8. 資料品質
  const sk = new Sheet(ctx, '資料品質', '水足跡盤查清冊·資料品質與完整度', W.completeness.source);
  sk.widths(40, 10, 70).head(['檢查項目', '結果', '說明']);
  for (const c of W.completeness.checks) sk.row([c.label, c.ok ? '通過' : '未通過', c.ok ? '' : c.msg]);
  sk.row(['完整度', `${W.completeness.pct}%`, `${W.completeness.passed}/${W.completeness.total} 項通過`]);
  sk.gap().head(['點位', '名稱', ...MONTHS]);
  const recs = (inv.records || []).filter((r) => String(r.period || '').startsWith(`${Y}-`));
  for (const p of (inv.points || []).filter((x) => x.domain === 'water')) {
    sk.row([p.code, `${p.name}${p.active === false ? '（停用）' : ''}`, ...MONTHS.map((_, i) => recs.filter((r) => r.pointCode === p.code && r.period === `${Y}-${String(i + 1).padStart(2, '0')}`).length || '')]);
  }
  if (F.untagged.length) sk.gap().text(`未設定流向的數值項目（不列入計算${F.intake.inferred ? '，讀數已推定為取水' : ''}）：${F.untagged.map((x) => `${x.pointCode}「${x.label}」`).join('、')}`);

  // 9. 節水改善回報
  const sv = new Sheet(ctx, '節水改善回報', '水足跡盤查清冊·節水改善回報', F.savingSource);
  sv.widths(10, 12, 20, 40, 14, 18, 20).head(['期別', '點位', '用水單元', '改善內容', '預估年節水量（m³/年）', '填寫人', '備註']);
  for (const s of F.savings) sv.row([s.period, s.pointCode, s.unitName, s.action, s.saving, s.who, s.note]);
  if (!F.savings.length) sv.row(['（無資料）']);
  sv.row(['合計', '', '', '', F.savingTotal]);

  // 10. 待補欄位
  const sm = new Sheet(ctx, '待補欄位', '水足跡盤查清冊·待補欄位', { doc: '系統產出說明', ref: '下列欄位系統無法由現有資料推得，請院方補填', note: '其餘欄位已由初始建檔與貼紙點位紀錄帶入' });
  sm.widths(22, 46, 60).head(['工作表', '欄位', '說明']);
  if (!ctx.missing.length) sm.row(['—', '無', '所有欄位都已帶入']);
  for (const m of ctx.missing) sm.row([m.sheet, m.field, m.why]);

  return {
    sheets: ctx.sheets, missing: ctx.missing, filename: `水足跡盤查清冊_${roc}年_${ctx.hospital}.xlsx`,
    summary: {
      year: Y, rocYear: roc, intake: F.intake.total, discharge: F.discharge.total, reuse: F.reuse.total, consumption: F.consumption.value, consumptionMethod: F.consumption.method,
      performance: W.performance.map(({ id, label, unit, value }) => ({ id, label, unit, value })), completeness: W.completeness.pct,
      scarcity: W.scarcity.total, scarcityDirect: W.scarcity.direct.value, indirectConsumption: W.indirect.electricity.consumption, indirectIncluded: W.indirect.included,
      qualityExceedances: W.quality.exceedances.length, targets: W.targets.rows.map(({ id, label, reductionPct, progressPct, met }) => ({ id, label, reductionPct, progressPct, met })),
    },
    source: WATER_SPEC.source,
  };
}
