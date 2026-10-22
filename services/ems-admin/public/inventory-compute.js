// 能源盤點：用量、業務規則 R1–R9、申報公式、期限提醒的純函式。
//
// ⚠️ 這支檔案刻意放在 public/（不是 src/），因為**伺服器與瀏覽器共用同一份**（同 audit-compute.js）：
//   - 瀏覽器：<script src="/inventory-compute.js"> 一般腳本，掛上 globalThis.EMSInventoryCompute
//   - 伺服器：`import '../public/inventory-compute.js'` 只求副作用，再讀 globalThis.EMSInventoryCompute
// 貼紙頁算出的用量、管理端顯示的檢核結果、產出申報表時的判定都走這一份，不會一邊算一種。
// 沒有 DOM 依賴、沒有 import，動它之前先確認兩邊都還能跑（pnpm test 有蓋）。
//
// 回傳約定（前端直接拿來顯示，不用再自己判斷）：
//   { ok, level, value, msg, ...其他欄位 }
//   ok    : true 通過／false 不通過／null 不適用或資料不足（畫面顯示「—」，不當成錯）
//   level : 'ok' | 'warn'（提示，可送出）| 'error'（擋下或必改）| 'na'（不適用）
//   value : 計算值（數字、布林或物件），算不出來是 undefined
//   msg   : 給院方看的中文句子
//   source: 依據 { doc, ref, law, spec }——doc 文件、ref 條次／表號、law 文號、spec 對照 energy-audit-spec.md 章節；
//           前端直接顯示在提示旁，讓院方知道「為什麼要我填這格」。依據集中在下面 SRC，改規定只改一處。
// 依據：docs/energy-audit-spec.md §2（R1–R9）、§3–§6（公式）。年份一律民國年（各表皆民國年）。

(function (g) {
  'use strict';

  // ── 共用小工具 ──

  const num = (v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
    return Number.isFinite(n) ? n : undefined;
  };
  const round = (v, d = 2) => (v === undefined ? undefined : Math.round(v * 10 ** d) / 10 ** d);
  // 千分位自己做：Intl 在不同 Node 建置（small-icu）結果可能不同，訊息文字要兩邊一致
  const fmt = (v, d = 2) => {
    if (v === undefined) return '—';
    const [i, f] = String(round(v, d)).split('.');
    return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
  };
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';

  const result = (ok, level, value, msg, extra) => ({ ok, level, value, msg, ...(extra || {}) });
  const pass = (value, msg, extra) => result(true, 'ok', value, msg, extra);
  const warn = (value, msg, extra) => result(false, 'warn', value, msg, extra);
  const fail = (value, msg, extra) => result(false, 'error', value, msg, extra);
  const na = (msg, extra) => result(null, 'na', undefined, msg, extra);

  // ── 民國／西元與日期 ──
  // 日期一律以「日曆日」處理（UTC 的年月日當作台灣日期），避免伺服器時區不同而差一天。

  const DAY = 86400000;
  const rocToAd = (y) => (num(y) === undefined ? undefined : num(y) + 1911);
  const adToRoc = (y) => (num(y) === undefined ? undefined : num(y) - 1911);
  // 年份正規化成民國年：民國年不可能超過 1911，>1911 的一定是誤填西元，順手轉回來
  const toRocYear = (y) => {
    const n = num(y);
    if (n === undefined) return undefined;
    return n > 1911 ? n - 1911 : n;
  };

  // 接受 Date、'2028-03-31'、民國 '117-03-31' / '117/3/31' / '117.3.31'；年 < 1000 視為民國
  function parseDate(v) {
    if (v === undefined || v === null || v === '') return undefined;
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return undefined;
      // Date 物件是「某個瞬間」，換成台北日曆日（UTC+8，台灣無日光節約）
      const t = new Date(v.getTime() + 8 * 3600000);
      return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    }
    const m = String(v).trim().match(/^(\d{2,4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return undefined;
    let y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < 1000) y += 1911;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    // 擋掉 2/30 這種被 JS 自動進位的日期
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
    return dt;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => (d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : undefined);
  const toRocDate = (d) => (d ? `${d.getUTCFullYear() - 1911}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : undefined);
  // b − a 的天數（b 在後為正）
  const daysBetween = (a, b) => {
    const x = parseDate(a);
    const y = parseDate(b);
    return x && y ? Math.round((y - x) / DAY) : undefined;
  };
  // 加 n 年；2/29 遇到平年落在 2/28（不讓 JS 進位到 3/1，否則期限會多算一天）
  function addYears(v, n) {
    const d = parseDate(v);
    if (!d) return undefined;
    const y = d.getUTCFullYear() + n;
    const mo = d.getUTCMonth();
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo, Math.min(d.getUTCDate(), last)));
  }

  // ── 用量（工作項目 4）──

  // reading 型項目：本次 − 上次。
  //   prevReading 沒有 → 首次抄表，算不出用量但不算錯
  //   本次 < 上次 → 讀數倒退，擋下請確認（多半是換表、抄錯位數或拍錯表）
  //   有上期用量且設了 warnPct → 差異超過 warnPct% 提示（剛好等於不提示）
  function readingUsage(curr, prevReading, opts = {}) {
    const c = num(curr);
    const p = num(prevReading);
    const prevUsage = num(opts.prevUsage);
    const warnPct = num(opts.warnPct);
    const label = opts.label ? `${opts.label}：` : '';
    if (c === undefined) return na(`${label}未填讀數`, { rollback: false });
    if (c < 0) return fail(undefined, `${label}讀數不可為負數`, { rollback: false });
    if (p === undefined) return pass(undefined, `${label}首次抄表，下次起自動計算用量`, { rollback: false, first: true });
    if (c < p) {
      return fail(undefined, `${label}本次讀數 ${fmt(c)} 小於上次 ${fmt(p)}，請確認是否換表或抄錯`, { rollback: true, needsConfirm: true });
    }
    const usage = round(c - p, 3);
    const unit = opts.unit ? ` ${opts.unit}` : '';
    if (warnPct === undefined || prevUsage === undefined) {
      return pass(usage, `${label}本次用量 ${fmt(usage)}${unit}`, { rollback: false });
    }
    if (prevUsage === 0) {
      // 上期 0 算不出百分比；本期有用量就提示（停機後恢復、或上期漏抄）
      if (usage === 0) return pass(usage, `${label}本次用量 0${unit}，與上期相同`, { rollback: false, diffPct: 0 });
      return warn(usage, `${label}本次用量 ${fmt(usage)}${unit}，上期為 0，請確認`, { rollback: false, diffPct: undefined });
    }
    const diffPct = round(((usage - prevUsage) / prevUsage) * 100, 1);
    if (Math.abs(diffPct) > warnPct) {
      const dir = diffPct > 0 ? '增加' : '減少';
      return warn(usage, `${label}本次用量 ${fmt(usage)}${unit}，比上期 ${fmt(prevUsage)}${unit} ${dir} ${fmt(Math.abs(diffPct), 1)}%（超過 ${fmt(warnPct)}%），請確認`, { rollback: false, diffPct });
    }
    return pass(usage, `${label}本次用量 ${fmt(usage)}${unit}，與上期差 ${fmt(diffPct, 1)}%`, { rollback: false, diffPct });
  }

  // 一整筆紀錄：依點位 items 把所有 reading 項目算一遍。
  //   prev = 上一筆紀錄 { values, usage }（usage 是上一筆當時算出的用量，拿來比較上期）
  //   回傳 { usage: {itemId: 用量}, results: {itemId: readingUsage 結果}, warnings: [msg], blocking: [msg] }
  //   blocking 有東西 → 讀數倒退，送出前必須讓使用者確認
  function recordUsage(items, values, prev) {
    const out = { usage: {}, results: {}, warnings: [], blocking: [], source: SRC.usage };
    for (const it of items || []) {
      if (it?.type !== 'reading') continue;
      const r = W.readingUsage(values?.[it.id], prev?.values?.[it.id], {
        prevUsage: prev?.usage?.[it.id], warnPct: it.warnPct, label: it.label, unit: it.unit,
      });
      out.results[it.id] = r;
      if (r.value !== undefined) out.usage[it.id] = r.value;
      if (r.rollback) out.blocking.push(r.msg);
      else if (r.level === 'warn') out.warnings.push(r.msg);
    }
    return out;
  }

  // ── R1 能源用戶判定 ──

  const ENERGY_USER_KW = 800;

  // meters: [{ contractKw }]。combine=true → 同一商工登記主體的契約容量合併計算（114–117 規定）；
  // false → 各電號分開看，任一電號 > 800 瓩即列管。
  // 國軍各院區是否合併尚待業主確認（spec §9-2），所以做成參數而不寫死。
  function energyUserCheck({ meters, contractKw, combine = false } = {}) {
    const list = (meters || []).map((m) => num(m?.contractKw ?? m?.contract_capacity_kw)).filter((v) => v !== undefined);
    if (num(contractKw) !== undefined) list.push(num(contractKw));
    if (!list.length) return na('未填契約容量，無法判定是否為能源用戶');
    const basisKw = combine ? list.reduce((a, b) => a + b, 0) : Math.max(...list);
    const isUser = basisKw > ENERGY_USER_KW;
    const how = combine ? `合併計算 ${list.length} 個電號` : '單一電號最大';
    const msg = isUser
      ? `契約容量（${how}）${fmt(basisKw)} 瓩 > 800 瓩，屬能源用戶`
      : `契約容量（${how}）${fmt(basisKw)} 瓩 ≤ 800 瓩，非能源用戶`;
    return pass(isUser, msg, { basisKw, combine, isEnergyUser: isUser });
  }

  // ── R2 排除條件 ──

  const EXCLUSIONS = {
    EX01: '國軍部隊用戶',
    EX02: '車道及隧道用電用戶',
    EX03: '專供軌道車輛牽引用電用戶',
    EX04: '港埠裝卸作業用電用戶',
    EX05: '廣播電臺用電用戶',
    EX06: '專供營繕工程施工用電用戶',
    EX07: '臨時用電用戶',
    EX08: '能源使用說明書新設用戶（核准日起 5 年內）',
    EX09: '適用電動車充換電設施電價之用戶',
    EX10: '取得 ISO/CNS 50001 證書且每年提供有效證書',
    EX11: '其他經中央主管機關認定之用戶',
  };
  // ISO 證書到期前多久開始提醒：每年要提供有效證書，留 90 天給院方辦換證
  const CERT_REMIND_DAYS = 90;

  // 單一排除條件：{ code, reason, evidence[], approvedAt（EX08）, certValidUntil（EX10）}
  // value = 這條排除目前是否成立。理由與佐證是 spec 明訂必填，缺了排除不成立。
  function exclusionCheck(ex, opts = {}) {
    const today = opts.today;
    const code = ex?.code;
    const label = EXCLUSIONS[code];
    if (!label) return fail(false, `未知的排除條件代碼「${code ?? ''}」`, { code });
    const base = { code, label };
    const missing = [];
    if (blank(ex.reason)) missing.push('理由');
    if (!Array.isArray(ex.evidence) || !ex.evidence.length) missing.push('佐證');
    const now = parseDate(today);

    // 業主 2026-10-22 確認：國軍醫院是主要執行單位，不屬「國軍部隊用戶」。
    // EX01 留在代碼表（其他單位仍可能適用），但醫院勾了也不能因此判為非能源用戶。
    if (code === 'EX01' && String(opts.userClass ?? '').includes('醫院')) {
      return na('EX01 不適用：業主 2026-10-22 確認國軍醫院為主要執行單位', { ...base, value: false, owner: true });
    }

    if (code === 'EX08') {
      const approved = parseDate(ex.approvedAt);
      if (!approved) return fail(false, `${code} 須填能源使用說明書核准日`, base);
      const expires = addYears(approved, 5);
      const left = now ? Math.round((expires - now) / DAY) : undefined;
      const extra = { ...base, expiresAt: toIso(expires), expiresAtRoc: toRocDate(expires), daysLeft: left };
      // 「核准日起 5 年內」：到期日當天仍算在內，隔天起失效
      if (left !== undefined && left < 0) return fail(false, `${code} 已於 ${toRocDate(expires)} 屆滿 5 年，不再適用排除，須恢復列管`, extra);
      if (missing.length) return fail(false, `${code} 須補${missing.join('與')}`, extra);
      return pass(true, `${code} 適用，排除效期至 ${toRocDate(expires)}${left !== undefined ? `（剩 ${left} 天）` : ''}`, extra);
    }
    if (code === 'EX10') {
      const until = parseDate(ex.certValidUntil);
      if (!until) return fail(false, `${code} 須填 ISO/CNS 50001 證書效期`, base);
      const left = now ? Math.round((until - now) / DAY) : undefined;
      const extra = { ...base, expiresAt: toIso(until), expiresAtRoc: toRocDate(until), daysLeft: left };
      if (left !== undefined && left < 0) return fail(false, `${code} 證書已於 ${toRocDate(until)} 過期，須提供新證書，否則恢復列管`, extra);
      if (missing.length) return fail(false, `${code} 須補${missing.join('與')}`, extra);
      if (left !== undefined && left <= CERT_REMIND_DAYS) {
        return warn(true, `${code} 證書將於 ${toRocDate(until)} 到期（剩 ${left} 天），請準備換證`, extra);
      }
      return pass(true, `${code} 適用，證書效期至 ${toRocDate(until)}`, extra);
    }
    if (missing.length) return fail(false, `${code} ${label}：須補${missing.join('與')}`, base);
    return pass(true, `${code} ${label}：適用`, base);
  }

  // 多條排除：任一成立即非能源用戶
  function exclusionsCheck(list, opts) {
    const items = (list || []).map((ex) => W.exclusionCheck(ex, opts));
    if (!items.length) return na('未勾選排除條件', { items, validCodes: [] });
    const validCodes = items.filter((r) => r.value === true).map((r) => r.code);
    const worst = items.some((r) => r.level === 'error') ? 'error' : items.some((r) => r.level === 'warn') ? 'warn' : 'ok';
    const msg = validCodes.length ? `排除條件成立：${validCodes.join('、')}` : '勾選的排除條件均不成立';
    return result(worst === 'ok', worst, validCodes.length > 0, msg, { items, validCodes });
  }

  // R1 + R2 合起來的最終判定
  function energyUserStatus({ meters, contractKw, combine, exclusions, today, userClass } = {}) {
    const r1 = W.energyUserCheck({ meters, contractKw, combine });
    const r2 = W.exclusionsCheck(exclusions, { today, userClass });
    if (r1.ok === null) return na(r1.msg, { r1, r2 });
    const excluded = r2.value === true;
    const isUser = r1.value === true && !excluded;
    let msg = r1.msg;
    if (r1.value && excluded) msg += `，但${r2.msg}，不列管`;
    else if (r1.value && r2.ok === false) msg += `；${r2.msg}`;
    const level = r2.level === 'error' || r2.level === 'warn' ? r2.level : 'ok';
    return result(level === 'ok', level, isUser, msg, { isEnergyUser: isUser, r1, r2 });
  }

  // ── R3 診斷團隊資格 ──

  const ENGINEER_DISCIPLINES = ['機械', '冷凍空調', '電機', '化工'];
  const isDiscipline = (d) => !blank(d) && ENGINEER_DISCIPLINES.some((x) => String(d).replace(/技師$/, '') === x);

  // team = { code: 'Q-L1'|'Q-L2'|'Q-L3'|'Q-S1'|'Q-E1', members[], commissioned, licence:{ discipline, expiresAt } }
  // members[] = { name, fullTime, engineerDiscipline, years, energyCert, seniorElectric }
  //   「具資格」= 年資 > 5 年 且（能管訓練合格證書 或 高級電氣技術人員）
  function diagnosisTeamCheck(team, { reportDate } = {}) {
    const code = team?.code;
    const ft = (team?.members || []).filter((m) => m?.fullTime);
    const qualified = ft.filter((m) => num(m.years) > 5 && (m.energyCert || m.seniorElectric));
    const certified = qualified.filter((m) => m.energyCert);
    const engineers = ft.filter((m) => isDiscipline(m.engineerDiscipline));
    const counts = { fullTime: ft.length, engineers: engineers.length, qualified: qualified.length, energyCert: certified.length };

    if (code === 'Q-L1') {
      const issues = [];
      if (engineers.length < 1) issues.push('需 ≥1 名機械／冷凍空調／電機／化工技師全職員工');
      if (qualified.length < 2) issues.push(`具 >5 年經驗＋能管證書或高級電氣資格之全職員工需 ≥2 名（目前 ${qualified.length}）`);
      if (certified.length < 1) issues.push('上述人員中需 ≥1 名具能管證書');
      return issues.length ? fail(counts, `Q-L1 資格不符：${issues.join('；')}`, { issues }) : pass(counts, 'Q-L1 資格符合', { issues });
    }
    if (code === 'Q-L2') {
      const issues = [];
      if (qualified.length < 5) issues.push(`具資格全職員工需 ≥5 名（目前 ${qualified.length}）`);
      if (certified.length < 3) issues.push(`其中具能管證書需 ≥3 名（目前 ${certified.length}）`);
      return issues.length ? fail(counts, `Q-L2 資格不符：${issues.join('；')}`, { issues }) : pass(counts, 'Q-L2 資格符合', { issues });
    }
    if (code === 'Q-L3' || code === 'Q-S1') {
      return team.commissioned
        ? pass(counts, `${code} 受主管機關委託提供節能減碳輔導服務，資格符合`, { issues: [] })
        : fail(counts, `${code} 須為受主管機關委託提供節能減碳輔導服務之單位，請附委託證明`, { issues: ['未受委託'] });
    }
    if (code === 'Q-E1') {
      const lic = team.licence || {};
      const issues = [];
      if (!isDiscipline(lic.discipline)) issues.push('執照科別須為機械／冷凍空調／電機／化工');
      const exp = parseDate(lic.expiresAt);
      const rep = parseDate(reportDate);
      if (!exp) issues.push('須填執照有效期限');
      else if (!rep) issues.push('須填提報日期才能檢核執照效期');
      else if (rep > exp) issues.push(`提報日 ${toRocDate(rep)} 已超過執照到期日 ${toRocDate(exp)}`);
      const extra = { issues, expiresAt: toIso(exp), daysLeft: exp && rep ? Math.round((exp - rep) / DAY) : undefined };
      return issues.length ? fail(counts, `Q-E1 資格不符：${issues.join('；')}`, extra) : pass(counts, `Q-E1 資格符合（執照效期至 ${toRocDate(exp)}）`, extra);
    }
    return fail(counts, `未選擇或未知的資格代碼「${code ?? ''}」`, { issues: ['資格代碼'] });
  }

  // ── R5 回收年限 ──

  function paybackYears(investment, annualSaving) {
    const inv = num(investment);
    const sav = num(annualSaving);
    if (inv === undefined || sav === undefined) return na('投資金額或節省費用未填');
    // 節省 0（或負的）永遠回收不了，不能顯示 Infinity
    if (sav <= 0) return na('無法回收／不適用', { notApplicable: true });
    const years = round(inv / sav, 2);
    return pass(years, `回收年限 ${fmt(years)} 年`, { notApplicable: false });
  }

  // ── R6 機齡與強制列入設備汰換表 ──

  // 門檻是「超過」：機齡 > 門檻才強制列入，剛好等於不列
  const REPLACE_THRESHOLDS = { fluorescent: 2, led: 8, utility: 10, process: 20 };
  const REPLACE_LABELS = { fluorescent: '螢光燈具', led: 'LED 燈具', utility: '公用設備', process: '製程設備', other: '其他' };
  const CATEGORY_ALIASES = {
    螢光燈具: 'fluorescent', 螢光燈: 'fluorescent', 日光燈: 'fluorescent', fluorescent: 'fluorescent',
    'LED 燈具': 'led', LED燈具: 'led', LED: 'led', led: 'led',
    公用設備: 'utility', utility: 'utility',
    製程設備: 'process', process: 'process',
    其他: 'other', other: 'other',
  };
  const replaceCategory = (c) => CATEGORY_ALIASES[String(c ?? '').trim()] ?? (blank(c) ? undefined : 'other');

  function equipmentAge(mfgYear, reportYear) {
    const m = toRocYear(mfgYear);
    const r = toRocYear(reportYear);
    if (m === undefined || r === undefined) return na('製造年份或提報年度未填');
    const age = r - m;
    if (age < 0) return fail(age, `製造年份 ${m} 晚於提報年度 ${r}，請確認`);
    return pass(age, `機齡 ${age} 年`);
  }

  // value = 是否強制列入（列入後不可刪，可補說明）
  function replacementRequired({ category, mfgYear, reportYear } = {}) {
    const cat = replaceCategory(category);
    const age = equipmentAge(mfgYear, reportYear);
    if (age.ok !== true) return result(age.ok, age.level, undefined, age.msg, { age: age.value, category: cat });
    const th = REPLACE_THRESHOLDS[cat];
    const extra = { age: age.value, category: cat, threshold: th };
    if (th === undefined) return pass(false, `機齡 ${age.value} 年（${REPLACE_LABELS[cat] ?? '未分類'}無強制汰換年限）`, extra);
    if (age.value > th) return warn(true, `${REPLACE_LABELS[cat]}機齡 ${age.value} 年，超過 ${th} 年，強制列入設備汰換表`, extra);
    return pass(false, `${REPLACE_LABELS[cat]}機齡 ${age.value} 年，未超過 ${th} 年`, extra);
  }

  // ── R7 節能計畫納入 ──

  const PLAN_PAYBACK_YEARS = 10;
  const PLAN_SPAN_YEARS = 4;   // 預計完工年度：提報年度～提報年度+4（共 5 年）

  // 回收 < 10 年必列入（自動帶入、不可刪）；剛好 10 年或不適用不強制
  function planMandatory(payback) {
    const y = typeof payback === 'object' && payback !== null ? payback.value : num(payback);
    if (y === undefined) return pass(false, '回收年限不適用，不強制納入節能計畫');
    if (y < PLAN_PAYBACK_YEARS) return pass(true, `回收年限 ${fmt(y)} 年 < 10 年，強制納入節能計畫`);
    return pass(false, `回收年限 ${fmt(y)} 年 ≥ 10 年，不強制納入`);
  }

  // 節能計畫一列：{ paybackYears, completionYear, note, reportYear }
  function planRowCheck({ paybackYears: pb, completionYear, note, reportYear } = {}) {
    const mandatory = planMandatory(pb).value;
    const rep = toRocYear(reportYear);
    const done = toRocYear(completionYear);
    const issues = [];
    if (done === undefined) {
      if (blank(note)) issues.push('未填預計完工年度，備註須說明未導入規劃之原因');
    } else if (rep === undefined) {
      issues.push('須有提報年度才能檢核預計完工年度');
    } else if (done < rep || done > rep + PLAN_SPAN_YEARS) {
      issues.push(`預計完工年度須在 ${rep}～${rep + PLAN_SPAN_YEARS} 年之間（目前 ${done}）`);
    }
    const extra = { mandatory, issues, range: rep === undefined ? undefined : [rep, rep + PLAN_SPAN_YEARS] };
    if (issues.length) return fail(mandatory, issues.join('；'), extra);
    return pass(mandatory, mandatory ? '強制納入，資料完整' : '資料完整', extra);
  }

  // ── R9 申報表檢核 ──

  // 能管人員：契約容量 > 100,000 瓩須 ≥2 名且 ≥1 名自置。staff[] = { inHouse }
  function staffCountCheck({ contractKw, staff } = {}) {
    const kw = num(contractKw);
    const list = staff || [];
    const inHouse = list.filter((s) => s?.inHouse).length;
    const value = { total: list.length, inHouse };
    if (kw !== undefined && kw > 100000) {
      if (list.length < 2 || inHouse < 1) return fail(value, `契約容量 > 100,000 瓩須設 ≥2 名能管人員且 ≥1 名自置（目前 ${list.length} 名、自置 ${inHouse} 名）`);
      return pass(value, `能管人員 ${list.length} 名（自置 ${inHouse} 名），符合`);
    }
    if (!list.length) return warn(value, '尚未登錄能管人員；未設置者須填未設置原因與後續改善方式');
    return pass(value, `能管人員 ${list.length} 名，符合`);
  }

  // 營業規模：醫院必填（床）
  function businessScaleCheck({ userClass, beds } = {}) {
    if (!String(userClass ?? '').includes('醫院')) return na('非醫院，營業規模（床）非必填');
    const b = num(beds);
    if (b === undefined || b <= 0) return fail(undefined, '醫院須填營業規模（病床數）');
    return pass(b, `營業規模 ${fmt(b, 0)} 床`);
  }

  // 出租率：僅辦公大樓必填
  function occupancyRateCheck({ userClass, rate } = {}) {
    if (!String(userClass ?? '').includes('辦公')) return na('非辦公大樓，出租率免填');
    const r = num(rate);
    if (r === undefined) return fail(undefined, '辦公大樓須填出租率');
    if (r < 0 || r > 100) return fail(r, '出租率須介於 0～100%');
    return pass(r, `出租率 ${fmt(r)}%`);
  }

  // EUI 年增減 > 10% 須填原因（剛好 10% 不必）
  function euiDiffCheck(prevEui, currEui, reason) {
    const p = num(prevEui);
    const c = num(currEui);
    if (p === undefined || c === undefined || p === 0) return na('缺前一年或本年 EUI，無法比較');
    const diffPct = round(((c - p) / p) * 100, 1);
    if (Math.abs(diffPct) > 10) {
      if (blank(reason)) return fail(diffPct, `EUI 差異 ${fmt(diffPct, 1)}%，超過 ±10%，須填原因`, { reasonRequired: true });
      return pass(diffPct, `EUI 差異 ${fmt(diffPct, 1)}%，已填原因`, { reasonRequired: true });
    }
    return pass(diffPct, `EUI 差異 ${fmt(diffPct, 1)}%`, { reasonRequired: false });
  }

  // 功因：合理值 95% 以上，低於才提示。0～1 的小數視為比值自動 ×100（電費單常印 0.97）
  function powerFactorCheck(pf) {
    let v = num(pf);
    if (v === undefined) return na('未填功因');
    if (v > 0 && v <= 1) v = round(v * 100, 2);
    if (v < 95) return warn(v, `功因 ${fmt(v)}% 低於 95%，建議檢查電容器或功因調整器`);
    return pass(v, `功因 ${fmt(v)}%`);
  }

  // 變壓器負載率：合理 50～75%（含端點）。可直接給 loadPct，或給 最大負載 kW ÷ 容量 kVA
  function transformerLoadCheck({ loadPct, maxLoadKw, capacityKva } = {}) {
    let v = num(loadPct);
    if (v === undefined) {
      const kw = num(maxLoadKw);
      const kva = num(capacityKva);
      if (kw === undefined || !kva) return na('未填負載率，或最大負載與容量');
      v = round((kw / kva) * 100, 1);
    }
    if (v < 50) return warn(v, `變壓器負載率 ${fmt(v, 1)}% 低於 50%，容量偏大`);
    if (v > 75) return warn(v, `變壓器負載率 ${fmt(v, 1)}% 高於 75%，負載偏高`);
    return pass(v, `變壓器負載率 ${fmt(v, 1)}%，在合理範圍`);
  }

  // 冰水機群組：單一群組主機總容量 ≥ 1,000 RT 必填效率表（表九之一（二）12 個月）。
  // capacities = 群組內各主機 RT；months = [{ kwh, rth }]
  function chillerTableCheck({ capacities, totalRt, months } = {}) {
    let rt = num(totalRt);
    if (rt === undefined) {
      const caps = (capacities || []).map(num).filter((v) => v !== undefined);
      if (!caps.length) return na('未填群組主機容量');
      rt = caps.reduce((a, b) => a + b, 0);
    }
    const filled = (months || []).filter((m) => num(m?.kwh) !== undefined && num(m?.rth) !== undefined).length;
    const extra = { totalRt: rt, monthsFilled: filled };
    if (rt < 1000) return pass(false, `群組總容量 ${fmt(rt)} RT < 1,000 RT，效率表免填`, extra);
    if (filled < 12) return fail(true, `群組總容量 ${fmt(rt)} RT ≥ 1,000 RT，須填 12 個月效率表（已填 ${filled} 個月）`, extra);
    return pass(true, `群組總容量 ${fmt(rt)} RT，效率表已填齊`, extra);
  }

  // ISO 50001：通過 → 表四之二第 2–5 題免填。value = 要答的題號
  function isoQuestions({ passed, certValidUntil, today } = {}) {
    if (passed) {
      const until = parseDate(certValidUntil);
      const left = until && parseDate(today) ? Math.round((until - parseDate(today)) / DAY) : undefined;
      if (!until) return fail([1], '已通過 ISO/CNS 50001，須填驗證機構與證書效期；第 2–5 題免答', { skip: [2, 3, 4, 5] });
      if (left !== undefined && left < 0) return fail([1, 2, 3, 4, 5, 6], `ISO 50001 證書已於 ${toRocDate(until)} 過期，第 2–5 題須作答`, { skip: [], daysLeft: left });
      return pass([1, 6], '已通過 ISO/CNS 50001，第 2–5 題免答', { skip: [2, 3, 4, 5], daysLeft: left });
    }
    return pass([1, 2, 3, 4, 5, 6], '未通過 ISO/CNS 50001，第 1–6 題皆須作答', { skip: [] });
  }

  // PUE 表：僅電信／電腦機房類用戶必填
  function pueTableRequired(userClass) {
    const required = /電信|機房|資料中心/.test(String(userClass ?? ''));
    return pass(required, required ? '電信／電腦機房類用戶，須填表九之八 PUE' : '非機房類用戶，PUE 表免填');
  }

  // 鍋爐：蒸汽且非貫流式 → 須填自我檢測（表九之七）；另燃煤／油／氣 → 列重大使用能源設備（表九之五）
  function boilerCheck({ kind, type, fuel } = {}) {
    const steam = String(kind ?? '').includes('蒸汽');
    const once = String(type ?? '').includes('貫流');
    const fossil = /煤|油|氣/.test(String(fuel ?? ''));
    const selfTest = steam && !once;
    const major = selfTest && fossil;
    const notes = [];
    if (selfTest) notes.push('須填表九之七蒸汽鍋爐自我檢測（1–12 月）');
    if (major) notes.push('列為重大使用能源設備（表九之五）');
    return pass({ selfTestRequired: selfTest, majorEquipment: major }, notes.length ? notes.join('；') : '免填蒸汽鍋爐自我檢測');
  }

  // ── 公式（§5、§6）──

  // 室內面積 = 總樓地板 − 室內停車場
  function indoorArea(totalFloor, parking) {
    const t = num(totalFloor);
    const p = num(parking) ?? 0;
    if (t === undefined) return na('未填總樓地板面積');
    const a = t - p;
    if (a <= 0) return fail(a, '室內面積（總樓地板 − 室內停車場）須大於 0');
    return pass(a, `室內面積 ${fmt(a)} ㎡`);
  }

  function euiElectric(annualKwh, totalFloor, parking) {
    const k = num(annualKwh);
    const a = indoorArea(totalFloor, parking);
    if (k === undefined) return na('未填年用電度數');
    if (a.ok !== true) return result(a.ok, a.level, undefined, a.msg);
    const v = round(k / a.value, 2);
    return pass(v, `電能 EUI ${fmt(v)} 度/㎡`, { area: a.value });
  }

  function euiThermal(annualLoe, totalFloor, parking) {
    const l = num(annualLoe);
    const a = indoorArea(totalFloor, parking);
    if (l === undefined) return na('未填年熱能使用量（公升油當量）');
    if (a.ok !== true) return result(a.ok, a.level, undefined, a.msg);
    const v = round(l / a.value, 3);
    return pass(v, `熱能 EUI ${fmt(v, 3)} 公升油當量/㎡`, { area: a.value });
  }

  // 冰水效率 kW/RT = 月耗電 kWh ÷ 系統負荷 RTh（數值越小越省）
  function chillerEfficiency(kwh, rth) {
    const k = num(kwh);
    const r = num(rth);
    if (k === undefined || r === undefined) return na('未填耗電量或系統負荷');
    if (r <= 0) return fail(undefined, '系統負荷 RTh 須大於 0');
    const v = round(k / r, 3);
    return pass(v, `冰水系統效率 ${fmt(v, 3)} kW/RT`);
  }

  // PUE = (基礎設施 a + 資訊設備 b) ÷ b
  function pue(a, b) {
    const x = num(a);
    const y = num(b);
    if (x === undefined || y === undefined) return na('未填基礎設施或資訊設備年用電');
    if (y <= 0) return fail(undefined, '資訊設備年用電須大於 0');
    const v = round((x + y) / y, 3);
    return pass(v, `PUE ${fmt(v, 3)}`);
  }

  // 能源費用比例 %（兩者單位須相同，呼叫端換好再丟進來）
  function energyCostRatio(energyCost, totalExpense) {
    const c = num(energyCost);
    const t = num(totalExpense);
    if (c === undefined || t === undefined) return na('未填總能源費用或總支出');
    if (t <= 0) return fail(undefined, '總支出須大於 0');
    const v = round((c / t) * 100, 2);
    if (v > 100) return fail(v, `能源費用比例 ${fmt(v)}% 超過 100%，請確認單位（萬元／百萬元）`);
    return pass(v, `能源費用占總支出 ${fmt(v)}%`);
  }

  // 需量反應認列節電量 = 實際抑低量 kW × 抑低時數 h
  function demandResponseSaving(kw, hours) {
    const k = num(kw);
    const h = num(hours);
    if (k === undefined || h === undefined) return na('未填抑低量或抑低時數');
    const v = round(k * h, 2);
    return pass(v, `需量反應認列節電量 ${fmt(v)} 度`);
  }

  // 年度用電量 = 購電 + 自發 − 售電
  function annualConsumption(purchased, selfGen, sold) {
    const p = num(purchased);
    if (p === undefined) return na('未填購電量');
    const v = round(p + (num(selfGen) ?? 0) - (num(sold) ?? 0), 2);
    return pass(v, `年度用電量 ${fmt(v)} 度`);
  }

  // 平均年節電率目標：全體契約容量 801～10,000 瓩 1%；> 10,000 瓩或國營事業 1.5%
  function savingTarget({ contractKw, stateOwned } = {}) {
    const kw = num(contractKw);
    if (stateOwned) return pass(1.5, '國營事業，平均年節電率目標 1.5%');
    if (kw === undefined) return na('未填契約容量，無法決定節電率目標');
    if (kw > 10000) return pass(1.5, '契約容量 > 10,000 瓩，平均年節電率目標 1.5%');
    return pass(1, '契約容量 801～10,000 瓩，平均年節電率目標 1%');
  }

  // 表十之四 年度節電率 = e ÷ (e + 用電量)；e = a+b+c+d，用電量 = f − g（可扣除用電量）
  function annualSavingRate({ a, b, c, d, saving, f, consumption, g, targetPct } = {}) {
    const parts = [a, b, c, d].map(num);
    const e = num(saving) ?? (parts.some((v) => v !== undefined) ? parts.reduce((s, v) => s + (v ?? 0), 0) : undefined);
    const fv = num(consumption) ?? num(f);
    if (e === undefined || fv === undefined) return na('未填節電量或年度用電量');
    const used = fv - (num(g) ?? 0);
    if (e + used <= 0) return fail(undefined, '節電量＋用電量須大於 0');
    const rate = round((e / (e + used)) * 100, 3);
    const extra = { saving: e, consumption: used };
    const t = num(targetPct);
    if (t !== undefined && rate < t) return warn(rate, `年度節電率 ${fmt(rate, 3)}%，未達目標 ${fmt(t)}%`, extra);
    return pass(rate, `年度節電率 ${fmt(rate, 3)}%`, extra);
  }

  // 表十之六 平均年節電率 = (累計節電量 + 前期超額節電量) ÷ (累計節電量 + 累計用電量)
  // years = [{ year, saving(S), consumption(C) }]
  function averageSavingRate(years, { prevExcess = 0, targetPct } = {}) {
    const rows = (years || []).filter((y) => num(y?.saving) !== undefined && num(y?.consumption) !== undefined);
    if (!rows.length) return na('尚無年度節電量與用電量');
    const S = rows.reduce((s, y) => s + num(y.saving), 0);
    const C = rows.reduce((s, y) => s + num(y.consumption), 0);
    if (S + C <= 0) return fail(undefined, '累計節電量＋用電量須大於 0');
    const rate = round(((S + (num(prevExcess) ?? 0)) / (S + C)) * 100, 3);
    const extra = { totalSaving: S, totalConsumption: C, years: rows.length };
    const t = num(targetPct);
    if (t !== undefined && rate < t) return warn(rate, `平均年節電率 ${fmt(rate, 3)}%，未達目標 ${fmt(t)}%`, extra);
    return pass(rate, `平均年節電率 ${fmt(rate, 3)}%（${rows.length} 年）`, extra);
  }

  // 表九之四：設備利用率 % = 年平均運轉容量 ÷ 總容量；全年運轉時數 % = 實際時數 ÷ 8,760
  function utilizationRate(avgRunningCapacity, totalCapacity) {
    const x = num(avgRunningCapacity);
    const t = num(totalCapacity);
    if (x === undefined || t === undefined) return na('未填平均運轉容量或總容量');
    if (t <= 0) return fail(undefined, '總容量須大於 0');
    const v = round((x / t) * 100, 1);
    if (v > 100) return fail(v, `設備利用率 ${fmt(v, 1)}% 超過 100%，請確認`);
    return pass(v, `設備利用率 ${fmt(v, 1)}%`);
  }

  function runHoursRate(hours) {
    const h = num(hours);
    if (h === undefined) return na('未填運轉時數');
    if (h < 0 || h > 8760) return fail(undefined, '全年運轉時數須介於 0～8,760 小時');
    const v = round((h / 8760) * 100, 1);
    return pass(v, `全年運轉時數 ${fmt(v, 1)}%`);
  }

  // ── 期限提醒（工作項目 15）──

  const FIRST_PERIOD_DUE = '2028-03-31';   // 民國 117-03-31：第一期節能診斷報告＋5 年節能計畫

  // 列出今天起（含今天）的申報期限，依日期排序。
  //   每年 1/31 附表三能源查核申報（前一年資料）、每年 3/31 節電執行情形與節電率、第一期 117-03-31。
  //   opts.isoCertExpiry / opts.licenceExpiry：證書、技師執照到期日（有填才列）
  //   opts.extra：[{ key, label, date }] 其他自訂期限
  //   遞迴期限只列「下一次」，畫面不需要一次塞好幾年
  function upcomingDeadlines(today, opts = {}) {
    const now = parseDate(today);
    if (!now) return [];
    const y = now.getUTCFullYear();
    const next = (mo, d) => {
      const thisYear = new Date(Date.UTC(y, mo - 1, d));
      return thisYear >= now ? thisYear : new Date(Date.UTC(y + 1, mo - 1, d));
    };
    const list = [];
    const jan = next(1, 31);
    list.push({ key: 'annex3', label: `附表三能源查核申報（${jan.getUTCFullYear() - 1 - 1911} 年資料）`, date: jan, basis: '每年 1 月底前', source: SRC.dueAnnex3 });
    const mar = next(3, 31);
    list.push({ key: 'saving-rate', label: `節電執行情形及節電率申報（${mar.getUTCFullYear() - 1 - 1911} 年）`, date: mar, basis: '每年 3/31 前', source: SRC.dueSavingRate });
    const first = parseDate(FIRST_PERIOD_DUE);
    if (first >= now) list.push({ key: 'first-period', label: '第一期節能診斷報告＋5 年節能計畫', date: first, basis: '診斷規定第四點', source: SRC.dueFirstPeriod });
    const iso = parseDate(opts.isoCertExpiry);
    if (iso && iso >= now) list.push({ key: 'iso50001', label: 'ISO/CNS 50001 證書到期', date: iso, basis: 'R2 EX10 每年須提供有效證書', source: SRC.ex.EX10 });
    const lic = parseDate(opts.licenceExpiry);
    if (lic && lic >= now) list.push({ key: 'licence', label: '診斷技師執照到期', date: lic, basis: 'R3 Q-E1 提報日須在執照效期內', source: SRC.r3 });
    for (const x of opts.extra || []) {
      const d = parseDate(x?.date);
      if (d && d >= now) list.push({ key: x.key ?? 'extra', label: x.label ?? '', date: d, basis: x.basis ?? '', source: x.source });
    }
    return list
      .map((x) => {
        const daysLeft = Math.round((x.date - now) / DAY);
        // 30 天內標 warn，讓前端直接上色
        const level = daysLeft <= 30 ? 'warn' : 'ok';
        return { key: x.key, label: x.label, date: toIso(x.date), dateRoc: toRocDate(x.date), daysLeft, basis: x.basis, source: x.source, level,
          msg: daysLeft === 0 ? `${x.label}：今天到期` : `${x.label}：${toRocDate(x.date)}（剩 ${daysLeft} 天）` };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  // ── 依據（source）──
  // 文號對照 energy-audit-spec.md §1.1；ref 盡量寫到點次／表號，查得到原文。
  const LAW = {
    diag: '能源用戶辦理節能診斷及訂定節能計畫規定（115-05-18 經能字第 11558001660 號）',
    annex: '能源用戶應申報使用能源之種類…附表三（115-01-23 經能字第 11558000090 號）',
    target: '114–117 年能源用戶訂定節約能源目標及執行計畫規定（114-01-02 經能字第 11358040450 號）',
    act: '能源管理法',
    // spec §2 R2 只列排除條件、沒附出處文號；先標待補，免得前端顯示空白像漏資料
    exPending: '文號待補（spec §2 R2 未載出處）',
  };
  const src = (doc, ref, law, spec) => ({ doc, ref, law, spec });
  const SRC = {
    usage: src('ems-admin 改版工作清單', '項目 4（本次讀數 − 上次）', undefined, 'docs/ems-admin-revamp.md'),
    r1: src('附表三', '前言（契約容量 > 800 瓩列管）；合併計算依 114–117 規定', `${LAW.annex}；${LAW.target}`, '§2 R1'),
    ex: Object.fromEntries(Object.keys(EXCLUSIONS).map((k) => [k, src('能源用戶排除條件', k, k === 'EX08' ? `${LAW.act}第 16 條第 1 項` : LAW.exPending, '§2 R2')])),
    r3: src('附件一 節能診斷報告', '規定第三點第二項；附件一第四段診斷團隊聲明', LAW.diag, '§2 R3、§3.4'),
    r5: src('附件一 節能診斷報告', '表二、表三「回收年限」欄', LAW.diag, '§2 R5'),
    r6: src('附件一', '註 2', LAW.diag, '§2 R6'),
    r7: src('附件二 節能計畫', '註 1、註 2', LAW.diag, '§2 R7'),
    staff: src('附表三', '一、填表人員；二、其他技師或能管人員', LAW.annex, '§2 R9 能管人員人數'),
    scale: src('附表三', '三、基本資料 16 營業規模', LAW.annex, '§2 R9 營業規模'),
    occupancy: src('附表三', '三、基本資料 25 出租率', LAW.annex, '§2 R9 出租率'),
    euiDiff: src('附表三', '表五之四、表五之五', LAW.annex, '§2 R9 EUI 差異'),
    pf: src('附表三', '八、電能系統 變壓器運轉值（功因）', LAW.annex, '§2 R9 功因'),
    xfmr: src('附表三', '八、電能系統 變壓器運轉值（負載率）', LAW.annex, '§2 R9 變壓器負載率'),
    chillerTable: src('附表三', '表九之一（二）', LAW.annex, '§2 R9 冰水機群組效率表'),
    iso: src('附表三', '表四之二 第 1–5 題', LAW.annex, '§2 R9 ISO 50001'),
    pueTable: src('附表三', '表九之八', LAW.annex, '§2 R9 PUE 表'),
    boiler: src('附表三', '表九之五、表九之七', LAW.annex, '§2 R9 蒸汽鍋爐'),
    area: src('附表三', '表五之四（室內面積 = 總樓地板 − 室內停車場）', LAW.annex, '§5.5'),
    eui: src('附表三', '表五之四 電能績效自我評比', LAW.annex, '§6 換算'),
    euiThermal: src('附表三', '表五之五 熱能績效自我評比', LAW.annex, '§6 換算'),
    kwrt: src('附表三', '表九之一（二）群組系統效率', LAW.annex, '§6 換算'),
    pue: src('附表三', '表九之八 PUE = (a+b) ÷ b', LAW.annex, '§6 換算'),
    costRatio: src('附表三', '三、基本資料 24 能源費用占總支出比例', LAW.annex, '§6 換算'),
    dr: src('附表三', '表十之三（二）需量反應', LAW.annex, '§6 換算'),
    consumption: src('114–117 規定', '年度用電量 = 購電 + 自發 − 售電', LAW.target, '§6'),
    target: src('114–117 規定', '平均年節電率目標', LAW.target, '§6'),
    annualRate: src('附表三', '表十之四 年度節電率', `${LAW.annex}；${LAW.target}`, '§5.10、§6'),
    avgRate: src('附表三', '表十之六 歷年平均年節電率', `${LAW.annex}；${LAW.target}`, '§5.10、§6'),
    util: src('附表三', '表九之四 系統耗電量彙整', LAW.annex, '§5.9'),
    dueAnnex3: src('申報種類數量項目效率期間及方式', '每年 1 月底前申報前一年資料', LAW.annex, '§1.3'),
    dueSavingRate: src('114–117 規定', '每年 3/31 前申報節電執行情形及節電率', LAW.target, '§1.3、§6'),
    dueFirstPeriod: src('能源用戶辦理節能診斷及訂定節能計畫規定', '第四點（第一期 117-03-31）', LAW.diag, '§1.3'),
  };

  // 規則函式一律包一層掛 source；內部互相呼叫走 W.*，巢狀結果（r1、r2、items、results）也帶得到
  const withSource = (fn, s) => (...args) => {
    const r = fn(...args);
    const source = typeof s === 'function' ? s(r, ...args) : s;
    return r && typeof r === 'object' && !Array.isArray(r) ? { ...r, source: r.source ?? source } : r;
  };
  const W = {
    readingUsage: withSource(readingUsage, SRC.usage),
    recordUsage,
    energyUserCheck: withSource(energyUserCheck, SRC.r1),
    exclusionCheck: withSource(exclusionCheck, (r, ex) => SRC.ex[ex?.code] ?? src('能源用戶排除條件', String(ex?.code ?? ''), LAW.exPending, '§2 R2')),
    exclusionsCheck: withSource(exclusionsCheck, src('能源用戶排除條件', 'EX01–EX11', LAW.exPending, '§2 R2')),
    energyUserStatus: withSource(energyUserStatus, src('能源用戶判定', 'R1 + R2', `${LAW.annex}；${LAW.target}`, '§2 R1、R2')),
    diagnosisTeamCheck: withSource(diagnosisTeamCheck, SRC.r3),
    paybackYears: withSource(paybackYears, SRC.r5),
    equipmentAge: withSource(equipmentAge, SRC.r6),
    replacementRequired: withSource(replacementRequired, SRC.r6),
    planMandatory: withSource(planMandatory, SRC.r7),
    planRowCheck: withSource(planRowCheck, SRC.r7),
    staffCountCheck: withSource(staffCountCheck, SRC.staff),
    businessScaleCheck: withSource(businessScaleCheck, SRC.scale),
    occupancyRateCheck: withSource(occupancyRateCheck, SRC.occupancy),
    euiDiffCheck: withSource(euiDiffCheck, SRC.euiDiff),
    powerFactorCheck: withSource(powerFactorCheck, SRC.pf),
    transformerLoadCheck: withSource(transformerLoadCheck, SRC.xfmr),
    chillerTableCheck: withSource(chillerTableCheck, SRC.chillerTable),
    isoQuestions: withSource(isoQuestions, SRC.iso),
    pueTableRequired: withSource(pueTableRequired, SRC.pueTable),
    boilerCheck: withSource(boilerCheck, SRC.boiler),
    indoorArea: withSource(indoorArea, SRC.area),
    euiElectric: withSource(euiElectric, SRC.eui),
    euiThermal: withSource(euiThermal, SRC.euiThermal),
    chillerEfficiency: withSource(chillerEfficiency, SRC.kwrt),
    pue: withSource(pue, SRC.pue),
    energyCostRatio: withSource(energyCostRatio, SRC.costRatio),
    demandResponseSaving: withSource(demandResponseSaving, SRC.dr),
    annualConsumption: withSource(annualConsumption, SRC.consumption),
    savingTarget: withSource(savingTarget, SRC.target),
    annualSavingRate: withSource(annualSavingRate, SRC.annualRate),
    averageSavingRate: withSource(averageSavingRate, SRC.avgRate),
    utilizationRate: withSource(utilizationRate, SRC.util),
    runHoursRate: withSource(runHoursRate, SRC.util),
    upcomingDeadlines,
  };

  g.EMSInventoryCompute = {
    ...W,
    // 工具（不是規則，不帶 source）
    num, round, rocToAd, adToRoc, toRocYear, parseDate, toIso, toRocDate, daysBetween, addYears, replaceCategory,
    // 常數
    ENERGY_USER_KW, EXCLUSIONS, ENGINEER_DISCIPLINES, REPLACE_THRESHOLDS, FIRST_PERIOD_DUE, LAW, SOURCES: SRC,
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
