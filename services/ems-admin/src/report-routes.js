// 申報與報告的 API（/api/inv/report/...）。inventory-routes.js 把這個前綴整段分派過來：
//   export async function handleReport({ req, res, sess, kind, json, readBody, originOk, readInventory })
// kind＝前綴後面的路徑（例：'measures'、'measures/m-eq-xxx'、'annex3'），回 truthy 表示已處理。
//
// 寫入一律走 mutateInventory（同一把鎖、同一個無 remote 的 git 倉庫）；寫入前先 materialize，
// 讓 R6／R7 自動帶入的列以決定性 id 落地（畫面上看到的 id 就是存進去的 id）。
import { mutateInventory, newId } from './inventory-store.js';
import { categoryById, parseReporter, whoLabel, REPORTER_MAX } from './inventory-schema.js';
import { reportSpec, MEASURE_TYPES, PLAN_FIELDS, validateMeasureInput, normalizeFields, validateDiagnosis } from './report-schema.js';
import {
  materialize, measuresView, plansView, measureView, planView, reportYearOf, diagnosisOf, todayIso, r6For,
} from './report-model.js';
import { buildAnnex3, buildDiagnosis, buildPlan, toXlsx } from './report-xlsx.js';
import '../public/inventory-compute.js';

const C = globalThis.EMSInventoryCompute;

class HttpErr extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const who = (sess) => sess.name || sess.sub;
const blankV = (v) => v === undefined || v === null || v === '';

// actor＝{ who:「姓名（院名）」或院名, reporter:姓名|null }（規則同 inventory-routes：parseReporter）
function pushChange(inv, actor, { kind, target, before, after, reason }) {
  const c = { id: newId('c'), at: new Date().toISOString(), who: actor.who, reporter: actor.reporter, kind, target, before: before ?? null, after: after ?? null, reason: reason || '' };
  inv.changes.push(c);
  return c;
}

// 欄位合併：input 裡出現但值為空的鍵＝清掉；其餘以驗證後的值覆蓋
function mergeFields(cur, input, normalized) {
  const next = { ...(cur || {}) };
  for (const k of Object.keys(input || {})) if (blankV(input[k])) delete next[k];
  Object.assign(next, normalized);
  return next;
}

// 設備主檔可挑的設備（設備汰換措施從這裡帶入）
function equipmentChoices(inv, ry) {
  return inv.equipment.filter((e) => !e.status || e.status === 'active').map((e) => {
    const r6 = r6For(e, ry);
    return {
      id: e.id, name: e.fields?.name || '', category: e.category, categoryLabel: categoryById(e.category)?.label || e.category, kind: e.kind,
      madeYear: e.fields?.madeYear, replaceCategory: C.equipmentReplaceCategory(e), r6: { value: r6.value, msg: r6.msg, age: r6.age, level: r6.level },
      hasMeasure: (inv.measures || []).some((m) => m.equipmentId === e.id),
    };
  });
}

function measuresPayload(inv, ry) {
  const mv = measuresView(inv, ry);
  const all = [...mv.replace, ...mv.operation];
  return {
    reportYear: ry, measures: mv,
    summary: C.diagnosisSummary(all.map((m) => ({ id: m.id, energyType: m.values.energyType, annualSaving: m.values.annualSaving }))),
    equipment: equipmentChoices(inv, ry),
  };
}

function deadlines(inv, today) {
  const policy = inv.site.policy || {};
  const ex = inv.site.exemption || {};
  const diag = diagnosisOf(inv);
  const lic = diag.teams.filter((t) => t.licenceExpiresAt).sort((a, b) => (a.licenceExpiresAt < b.licenceExpiresAt ? -1 : 1));
  const extra = [];
  // 第二張以後的技師執照（upcomingDeadlines 的 licenceExpiry 只吃一個）
  for (const t of lic.slice(1)) extra.push({ key: `licence-${t.id || t.name}`, label: `診斷技師執照到期（${t.name}）`, date: t.licenceExpiresAt, basis: 'R3 Q-E1 提報日須在執照效期內', source: C.SOURCES.r3 });
  if (ex.approvalDate) extra.push({ key: 'ex08', label: 'EX08 能源使用說明書排除效期屆滿', date: C.toIso(C.addYears(ex.approvalDate, 5)), basis: 'R2 EX08 核准日起 5 年內', source: C.SOURCES.ex.EX08 });
  if (diag.reportDate) extra.push({ key: 'retention', label: '診斷團隊資格文件與報告保存期限', date: C.toIso(C.addYears(diag.reportDate, 5)), basis: '附件一第四段：留存至少 5 年', source: C.SOURCES.r3 });
  const iso = policy.isoValidUntil || ex.isoValidUntil;
  const items = C.upcomingDeadlines(today, { isoCertExpiry: iso, licenceExpiry: lic[0]?.licenceExpiresAt, extra });
  if (lic[0]) { const it = items.find((x) => x.key === 'licence'); if (it) { const l = `診斷技師執照到期（${lic[0].name}）`; it.msg = it.msg.replace(it.label, l); it.label = l; } }
  return { today, items, inputs: { isoCertExpiry: iso || null, licences: lic.map((t) => ({ team: t.name, expiresAt: t.licenceExpiresAt })) }, source: reportSpec.sources.deadlines };
}

function sendXlsx(res, buf, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, no-store',
  });
  res.end(buf);
  return true;
}

const BUILDERS = { annex3: buildAnnex3, diagnosis: buildDiagnosis, plan: buildPlan };

export async function handleReport({ req, res, sess, kind, json, readBody, originOk, readInventory }) {
  const hid = sess.hid;
  const method = req.method;
  const GET = method === 'GET';
  // inventory-routes 只對 POST／PUT 做 Origin 檢查；DELETE 在這裡補
  if (!GET && !originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
  const q = new URL(req.url, 'http://x').searchParams;
  const readJson = async () => { const b = await readBody(req, 2 * 1024 * 1024); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; };
  const today = todayIso();
  const [head, rawId] = String(kind).split('/');
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (String(kind).split('/').length > 2) return null;

  // 改變狀態的請求先讀 body 並解析操作人姓名（DELETE 沒有 body，改從 ?reporter= 帶）
  let body = {}, A = null;
  if (!GET) {
    body = method === 'DELETE' ? {} : await readJson();
    const rp = parseReporter(body.reporter !== undefined ? body.reporter : (q.get('reporter') ?? undefined));
    if (!rp.ok) return json(res, 422, { ok: false, error: 'validation', details: [`填寫人姓名最長 ${REPORTER_MAX} 字`], message: rp.message });
    A = { who: whoLabel(who(sess), rp.reporter), reporter: rp.reporter };
  }

  const run = async (fn, what) => {
    try {
      const r = await mutateInventory(hid, (inv) => { materialize(inv, reportYearOf(inv, today)); return fn(inv, reportYearOf(inv, today)); }, { who: A.who, what });
      return r;
    } catch (e) {
      if (e instanceof HttpErr) { json(res, e.status, { ok: false, ...e.body }); return null; }
      throw e;
    }
  };
  const view = async () => { const inv = await readInventory(hid); const ry = reportYearOf(inv, today); materialize(inv, ry); return { inv, ry }; };

  // ── 規格 ──
  if (GET && head === 'spec' && !id) return json(res, 200, { ok: true, spec: reportSpec });

  // ── 產出 xlsx／待補清單 ──
  if (GET && BUILDERS[head] && !id) {
    const inv = await readInventory(hid);
    const year = q.get('year');
    if (head === 'annex3' && year !== null && !/^\d{2,3}$/.test(year)) return json(res, 400, { ok: false, error: 'bad_year', message: '資料年請填民國年，例：114' });
    const built = BUILDERS[head](inv, { year: year ? Number(year) : undefined, today, hospitalName: sess.name });
    if (q.get('format') === 'json') return json(res, 200, { ok: true, filename: built.filename, sheets: built.sheets.map((s) => ({ name: s.name, source: s.source })), missing: built.missing });
    return sendXlsx(res, toXlsx(built), built.filename);
  }
  if (GET && head === 'missing' && !id) {
    const k = q.get('kind') || 'annex3';
    if (!BUILDERS[k]) return json(res, 400, { ok: false, error: 'bad_kind' });
    const inv = await readInventory(hid);
    const built = BUILDERS[k](inv, { year: q.get('year') ? Number(q.get('year')) : undefined, today, hospitalName: sess.name });
    return json(res, 200, { ok: true, kind: k, filename: built.filename, missing: built.missing });
  }

  // ── 期限提醒 ──
  if (GET && head === 'deadlines' && !id) {
    const inv = await readInventory(hid);
    return json(res, 200, { ok: true, ...deadlines(inv, today) });
  }

  // ── 診斷報告主檔與診斷團隊 ──
  if (head === 'diagnosis-data' && !id) {
    if (GET) {
      const inv = await readInventory(hid);
      const d = diagnosisOf(inv);
      const checks = d.teams.map((t) => C.diagnosisTeamCheck({ code: t.code, members: t.members, commissioned: t.commissioned, licence: { discipline: t.licenceDiscipline, expiresAt: t.licenceExpiresAt } }, { reportDate: d.reportDate }));
      return json(res, 200, { ok: true, diagnosis: d, reportYear: reportYearOf(inv, today), checks, retentionUntil: d.reportDate ? C.toIso(C.addYears(d.reportDate, 5)) : null });
    }
    if (method === 'PUT') {
      const v = validateDiagnosis(body.diagnosis);
      if (v.errors.length) return json(res, 422, { ok: false, error: 'validation', details: v.errors });
      const r = await run((inv) => {
        const before = inv.diagnosis || null;
        v.value.teams = v.value.teams.map((t) => ({ ...t, id: t.id || newId('team'), members: t.members.map((m) => ({ ...m, id: m.id || newId('mb') })) }));
        inv.diagnosis = v.value;
        // 診斷團隊換人是人員異動；第一次填不記
        const change = before && JSON.stringify(before) !== JSON.stringify(v.value)
          ? pushChange(inv, A, { kind: 'staff', target: 'diagnosis', before, after: v.value, reason: String(body.reason || '') }) : null;
        return { diagnosis: inv.diagnosis, change };
      }, '診斷報告主檔與診斷團隊');
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
  }

  // ── 措施（附件一 3.2／3.3）──
  if (head === 'measures') {
    if (GET && !id) { const { inv, ry } = await view(); return json(res, 200, { ok: true, ...measuresPayload(inv, ry) }); }
    if (GET && id) {
      const { inv, ry } = await view();
      const m = inv.measures.find((x) => x.id === id);
      return m ? json(res, 200, { ok: true, measure: measureView(m, inv, ry) }) : json(res, 404, { ok: false, error: 'measure_not_found' });
    }
    if (method === 'POST' && !id) {
      const input = body.measure || {};
      const v = validateMeasureInput(input.type, input.fields);
      if (v.errors.length) return json(res, 422, { ok: false, error: 'validation', details: v.errors });
      const r = await run((inv, ry) => {
        if (input.type === 'replace' && input.equipmentId && !inv.equipment.some((e) => e.id === input.equipmentId)) throw new HttpErr(422, { error: 'validation', details: [`設備不存在：${input.equipmentId}`] });
        if (input.type === 'operation' && input.equipmentId) throw new HttpErr(422, { error: 'validation', details: ['操作面措施不連結單一設備'] });
        const now = new Date().toISOString();
        const m = { id: newId('m'), type: input.type, equipmentId: input.equipmentId || null, origin: 'manual', fields: v.values, createdAt: now, updatedAt: now };
        inv.measures.push(m);
        materialize(inv, ry);   // 回收 < 10 年 → 立刻帶入節能計畫
        return { measure: measureView(m, inv, ry), ...measuresPayload(inv, ry) };
      }, `措施新增（${MEASURE_TYPES[input.type].label}）`);
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
    if (method === 'PUT' && id) {
      const input = body.measure || {};
      const r = await run((inv, ry) => {
        const m = inv.measures.find((x) => x.id === id);
        if (!m) throw new HttpErr(404, { error: 'measure_not_found' });
        const v = validateMeasureInput(m.type, input.fields);
        if (v.errors.length) throw new HttpErr(422, { error: 'validation', details: v.errors });
        if (input.equipmentId !== undefined && input.equipmentId !== m.equipmentId) {
          if (m.origin === 'r6') throw new HttpErr(422, { error: 'equipment_locked', message: '這筆是依附件一註 2 自動列入的設備，不能改連其他設備' });
          if (input.equipmentId && !inv.equipment.some((e) => e.id === input.equipmentId)) throw new HttpErr(422, { error: 'validation', details: [`設備不存在：${input.equipmentId}`] });
          m.equipmentId = input.equipmentId || null;
        }
        const before = { ...m.fields };
        m.fields = mergeFields(m.fields, input.fields, v.values);
        if (m.type === 'operation' && !m.fields.name) throw new HttpErr(422, { error: 'validation', details: ['「措施名稱」必填'] });
        m.updatedAt = new Date().toISOString();
        materialize(inv, ry);
        const changed = JSON.stringify(before) !== JSON.stringify(m.fields);
        const change = changed && body.reason ? pushChange(inv, A, { kind: 'other', target: `measure.${id}`, before, after: m.fields, reason: String(body.reason) }) : null;
        return { measure: measureView(m, inv, ry), change, ...measuresPayload(inv, ry) };
      }, `措施修改 ${id}`);
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
    if (method === 'DELETE' && id) {
      const r = await run((inv, ry) => {
        const idx = inv.measures.findIndex((x) => x.id === id);
        if (idx < 0) throw new HttpErr(404, { error: 'measure_not_found' });
        const mvw = measureView(inv.measures[idx], inv, ry);
        if (mvw.mandatory) throw new HttpErr(409, { error: 'mandatory', rule: 'R6', message: `${mvw.r6.msg}：依附件一註 2 應列於設備汰換表，不可刪除，可在「補充說明」補充`, source: mvw.r6.source });
        const [m] = inv.measures.splice(idx, 1);
        const plans = inv.plans.filter((p) => p.measureId === id);
        inv.plans = inv.plans.filter((p) => p.measureId !== id);
        const change = pushChange(inv, A, { kind: 'other', target: `measure.${id}`, before: { measure: m, plans }, after: null, reason: '刪除診斷措施' });
        return { deleted: id, deletedPlans: plans.map((p) => p.id), change, ...measuresPayload(inv, ry) };
      }, `措施刪除 ${id}`);
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
  }

  // ── 節能計畫（附件二）──
  if (head === 'plans') {
    if (GET && !id) {
      const { inv, ry } = await view();
      return json(res, 200, { ok: true, reportYear: ry, range: [ry, ry + C.PLAN_SPAN_YEARS], plans: plansView(inv, ry), source: reportSpec.sources.plans });
    }
    if (method === 'POST' && !id) {
      // 回收 ≥ 10 年的措施也可以自願納入計畫
      const r = await run((inv, ry) => {
        const m = inv.measures.find((x) => x.id === body.measureId);
        if (!m) throw new HttpErr(422, { error: 'validation', details: ['請指定要納入計畫的措施（measureId）'] });
        if (inv.plans.some((p) => p.measureId === m.id)) throw new HttpErr(409, { error: 'duplicate', message: '這項措施已在節能計畫中' });
        const now = new Date().toISOString();
        const p = { id: `p-${m.id}`, measureId: m.id, origin: 'manual', fields: {}, versions: [], createdAt: now, updatedAt: now };
        inv.plans.push(p);
        return { plan: planView(p, inv, ry, inv.plans.length) };
      }, '節能計畫新增');
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
    if (method === 'PUT' && id) {
      const input = body.plan?.fields ?? body.plan ?? {};
      const n = normalizeFields(PLAN_FIELDS, input);
      if (n.errors.length) return json(res, 422, { ok: false, error: 'validation', details: n.errors });
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const r = await run((inv, ry) => {
        const p = inv.plans.find((x) => x.id === id);
        if (!p) throw new HttpErr(404, { error: 'plan_not_found' });
        const before = { ...(p.fields || {}) };
        const next = mergeFields(p.fields, input, n.values);
        const check = C.planRowCheck({ paybackYears: planView(p, inv, ry, 0).paybackYears, completionYear: next.completionYear, note: next.note, reportYear: ry });
        if (check.ok === false) throw new HttpErr(422, { error: 'validation', rule: 'R7', details: check.issues, message: check.msg, source: check.source });
        const keys = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
        if (!keys.length) return { plan: planView(p, inv, ry, inv.plans.indexOf(p) + 1), unchanged: true };
        // R8：已填過的值被改掉才是「變更」，要原因；空格第一次填寫不必
        const isChange = keys.some((k) => !blankV(before[k]));
        if (isChange && !reason) throw new HttpErr(422, { error: 'reason_required', rule: 'R8', message: '節能計畫變更須填變更原因（R8 保留版本紀錄：變更前後、日期、原因）', details: ['變更原因必填'] });
        const at = new Date().toISOString();
        const ver = { v: (p.versions || []).length + 1, at, who: A.who, reporter: A.reporter, before: Object.fromEntries(keys.map((k) => [k, before[k] ?? null])), after: Object.fromEntries(keys.map((k) => [k, next[k] ?? null])), reason: reason || '初次填寫' };
        p.versions = [...(p.versions || []), ver];
        p.fields = next;
        p.updatedAt = at;
        const kindC = next.status === '已完工' && before.status !== '已完工' ? 'measure.done' : 'plan.change';
        const change = isChange || kindC === 'measure.done' ? pushChange(inv, A, { kind: kindC, target: `plan.${id}`, before: ver.before, after: ver.after, reason: ver.reason }) : null;
        return { plan: planView(p, inv, ry, inv.plans.indexOf(p) + 1), version: ver, change };
      }, `節能計畫修改 ${id}`);
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
    if (method === 'DELETE' && id) {
      const r = await run((inv, ry) => {
        const idx = inv.plans.findIndex((x) => x.id === id);
        if (idx < 0) throw new HttpErr(404, { error: 'plan_not_found' });
        const pvw = planView(inv.plans[idx], inv, ry, idx + 1);
        if (pvw.mandatory) {
          const pm = C.planMandatory(pvw.paybackYears);
          throw new HttpErr(409, { error: 'mandatory', rule: 'R7', message: `${pm.msg}：依附件二註 1 應列入節能計畫，不可刪除；未導入請在備註說明原因`, source: pm.source });
        }
        const [p] = inv.plans.splice(idx, 1);
        const change = pushChange(inv, A, { kind: 'plan.change', target: `plan.${id}`, before: p, after: null, reason: '自節能計畫移除' });
        return { deleted: id, change };
      }, `節能計畫刪除 ${id}`);
      if (!r) return true;
      return json(res, 200, { ok: true, ...r.result, commit: r.commit });
    }
  }

  return null;
}
