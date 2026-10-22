// 水足跡盤查清冊（工作清單 23）→ xlsx。GET /api/inv/report/water?year=N（report-routes.js 的 BUILDERS 分派）。
//
// 結構依 ISO 14046:2014 的方法架構：目的與範疇（5.2）→ 盤查（5.3：取水、用水單元、排放與回收、水質）
// → ISO 46001:2019 的水平衡（附錄 C）、用水績效指標與基線（3.2、3.4、6.2.5～6.2.7）→ 資料品質（4.8、5.2.4）。
// 只做盤查，不做衝擊評估（5.4）；依 3.3.1 註 1 檔名稱「水足跡盤查清冊」。條號與取得程度見 docs/water-footprint-spec.md。
//
// 每張工作表第 1 列表名、第 2 列依據、第 3 列院所與資料年（同附表三報表慣例）。推不出的格子留空並列入「待補欄位」。
// 計算全部走 public/inventory-compute.js 的 water* 函式（前後端同一份）。
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
  const W = C.waterInventory(inv, { year: Y });
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
    const shown = Array.isArray(v) ? v.join('、') : f.type === 'year' && v ? `${Number(v) - 1911} 年（${v}）` : f.type === 'percent' && v !== undefined ? `${v}%` : v;
    sc.row([f.label, shown, note]);
    if (blank(v) && (f.required || ['cutoff', 'drainageBasin', 'dataQuality'].includes(f.key))) sc.need(f.label, f.required ? '必填，尚未填寫（初始建檔 › 水足跡範疇與基線）' : '建議填寫（初始建檔 › 水足跡範疇與基線）');
  }
  sc.gap().text('本檔是 ISO 14046 的水足跡「盤查」（5.3），沒有進行衝擊評估（5.4）。依 3.3.1 註 1，未完整評估衝擊時不得單稱「水足跡」。');
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

  // 6. 水質
  const sq = new Sheet(ctx, '水質', '水足跡盤查清冊·水質', F.qualitySource);
  sq.widths(22, 16, 12, 8, 10, 10, 10, 10, 12).head(['排放口', '項目', '單位', '筆數', '最小', '最大', '平均', '最近一次', '最近期別']);
  for (const q of F.quality) sq.row([q.dischargeName, q.param, q.unit, q.n, q.min, q.max, q.avg, q.last, q.lastPeriod]);
  if (!F.quality.length) sq.row(['（無資料）']);
  for (const d of site.waterDischarges || []) for (const p of d.qualityParams || []) {
    if (!F.quality.some((q) => q.dischargeId === d.id && q.param === p && q.n > 0)) sq.need(`${d.name || d.id}·${p}`, `${roc} 年沒有抽測值（貼紙點位：水質抽測）`);
  }
  sq.text('標準限值依各院放流水許可，本表不判定是否合格。');

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
  if (scope.targetPct !== undefined) sp.text(`目標：較基線降低 ${scope.targetPct}%${scope.targetYear ? `（${scope.targetYear - 1911} 年）` : ''}`);
  sp.text(srcLine(C.WATER_SOURCES.baseline));
  sp.text('官方沒有醫院用水標竿（每床日），本表只與自己的基線比較。');

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
    },
    source: WATER_SPEC.source,
  };
}
