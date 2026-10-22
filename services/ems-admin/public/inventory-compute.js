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

  // meters: [{ meterNo?, contractKw }]。一律以「單一電號」的經常契約容量判定：任一電號 > 800 瓩即為能源用戶。
  // 業主 2026-10-22 確認契約容量「不用」合併計算——勾「合併申報」或填合計都不影響 R1，
  // 那些欄位只是附表三表三電號資料與附錄二的輸出資料。舊呼叫端傳的 combine 參數一律忽略。
  function energyUserCheck({ meters, contractKw } = {}) {
    const list = (meters || []).map((m) => ({ no: m?.meterNo ?? m?.meter_no ?? null, kw: num(m?.contractKw ?? m?.contract_capacity_kw) })).filter((x) => x.kw !== undefined);
    if (num(contractKw) !== undefined) list.push({ no: null, kw: num(contractKw) });
    if (!list.length) return na('未填契約容量，無法判定是否為能源用戶');
    const basisKw = Math.max(...list.map((x) => x.kw));
    const isUser = basisKw > ENERGY_USER_KW;
    const over = list.filter((x) => x.kw > ENERGY_USER_KW);
    const overMeters = over.map((x) => x.no).filter((x) => x != null && x !== '');
    const n = list.length > 1 ? `${list.length} 個電號分開看，` : '';
    const msg = isUser
      ? `${n}${overMeters.length ? `電號 ${overMeters.join('、')} ` : ''}契約容量 ${fmt(basisKw)} 瓩 > 800 瓩，屬能源用戶（以單一電號判定，不合併計算）`
      : `${n}單一電號契約容量最大 ${fmt(basisKw)} 瓩 ≤ 800 瓩，非能源用戶（以單一電號判定，不合併計算）`;
    return pass(isUser, msg, { basisKw, combine: false, overMeters, meterCount: list.length, isEnergyUser: isUser });
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
  function energyUserStatus({ meters, contractKw, exclusions, today, userClass } = {}) {
    const r1 = W.energyUserCheck({ meters, contractKw });
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
    螢光燈具: 'fluorescent', 螢光燈: 'fluorescent', 日光燈: 'fluorescent', 省電燈泡: 'fluorescent', fluorescent: 'fluorescent',
    'LED 燈具': 'led', LED燈具: 'led', LED: 'led', led: 'led',
    公用設備: 'utility', utility: 'utility',
    製程設備: 'process', process: 'process',
    其他: 'other', other: 'other',
  };
  const replaceCategory = (c) => CATEGORY_ALIASES[String(c ?? '').trim()] ?? (blank(c) ? undefined : 'other');

  // 設備主檔（表九）→ R6 類別標籤。管理端、報表、伺服器都只用這一支，不各自寫對應表。
  //   照明：日光燈、省電燈泡＝螢光燈具（2 年）；LED＝LED 燈具（8 年）；其他燈種回「其他」＝不套門檻
  //   空調與其他系統＝公用設備（10 年）；醫院沒有製程設備
  const LAMP_REPLACE_CATEGORY = { 日光燈: '螢光燈具', 省電燈泡: '螢光燈具', LED: 'LED 燈具' };
  function equipmentReplaceCategory(eq) {
    if (!eq) return undefined;
    if (eq.category === 'lighting') return LAMP_REPLACE_CATEGORY[String(eq.kind ?? '').trim()] || '其他';
    return '公用設備';
  }

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

  // 表五之五（115-01-23 新版）：熱能 EUI 單位改「公斤油當量/㎡」（舊版為公升油當量/㎡）。
  // annualKgoe = 年熱能使用量（公斤油當量）；燃料量換算用 fuelsToKgoe()
  function euiThermal(annualKgoe, totalFloor, parking) {
    const l = num(annualKgoe);
    const a = indoorArea(totalFloor, parking);
    if (l === undefined) return na('未填年熱能使用量（公斤油當量）');
    if (a.ok !== true) return result(a.ok, a.level, undefined, a.msg);
    const v = round(l / a.value, 3);
    return pass(v, `熱能 EUI ${fmt(v, 3)} 公斤油當量/㎡`, { area: a.value, unit: '公斤油當量/㎡' });
  }

  // ── 油當量換算（§6.1 能源署「能源產品單位熱值表」113 年起適用、114 年修正）──
  // 1 公斤油當量＝10,000 千卡；1 公噸油當量＝10⁷ 千卡。toe = 公噸油當量／申報單位。
  // 天然氣分 NG1／NG2，熱值表沒寫哪類用戶適用哪一種（spec §9-5a 待確認）：預設 NG1，呼叫端可指定。
  const ENERGY_UNITS = {
    E01: { label: '電力', unit: '度', kcal: 860, toe: 0.000086 },
    E02: { label: '燃料油', unit: '公秉', kcal: 9320000, toe: 0.932 },
    E03: { label: '液化石油氣', unit: '公斤', kcal: 10832, toe: 0.0010832, note: '公斤↔公升取 1.818（112 年版熱值表註 1），待確認' },
    E04: { label: '天然氣', unit: '立方公尺', kcal: 8107, toe: 0.0008107, ng: { NG1: 0.0008107, NG2: 0.0008755 }, note: '先用 NG1 8,107 千卡/立方公尺；NG1／NG2 待確認' },
    E05: { label: '汽油', unit: '公升', kcal: 7520, toe: 0.000752 },
    E06: { label: '柴油', unit: '公秉', kcal: 8629000, toe: 0.8629 },
  };
  // 換成公噸油當量。code：E01–E06；opts.ng='NG2' 改用 NG2
  function toToe(amount, code, opts = {}) {
    const a = num(amount);
    const e = ENERGY_UNITS[code];
    if (!e) return fail(undefined, `未知的能源種類「${code ?? ''}」，無法換算油當量`);
    if (a === undefined) return na('未填能源量');
    const f = code === 'E04' && opts.ng && e.ng[opts.ng] ? e.ng[opts.ng] : e.toe;
    const v = round(a * f, 6);
    return pass(v, `${fmt(a)} ${e.unit}${e.label} ≈ ${fmt(v, 4)} 公噸油當量`, { factor: f, unit: e.unit, ng: code === 'E04' ? (opts.ng || 'NG1') : undefined });
  }
  // 表五之一各燃料量 → 公斤油當量合計（給表五之五 EUI 用）。fuels = { E02: 公秉, E03: 公斤, … }；電力不算熱能
  function fuelsToKgoe(fuels, opts = {}) {
    let total = 0, any = false;
    const parts = {};
    for (const code of ['E02', 'E03', 'E04', 'E05', 'E06']) {
      const r = toToe(fuels?.[code], code, opts);
      if (r.value === undefined) continue;
      any = true;
      parts[code] = round(r.value * 1000, 3);
      total += r.value * 1000;
    }
    if (!any) return na('未填熱能使用量');
    const v = round(total, 3);
    return pass(v, `年熱能使用量 ${fmt(v, 3)} 公斤油當量`, { parts });
  }

  // 附件一 一、診斷摘要：措施項數、節能潛力（公噸油當量）、節電潛力（萬度）。
  // measures = [{ energyType: 'E01'…, annualSaving }]（3.2＋3.3 全部）
  function diagnosisSummary(measures, opts = {}) {
    const list = measures || [];
    let toe = 0, kwh = 0;
    const missing = [];
    let usedNg = false;
    for (const m of list) {
      const r = toToe(m?.annualSaving, m?.energyType || 'E01', opts);
      if (r.value === undefined) { missing.push(m?.id ?? m?.no); continue; }
      toe += r.value;
      if ((m?.energyType || 'E01') === 'E01') kwh += num(m.annualSaving);
      if (m?.energyType === 'E04') usedNg = true;
    }
    const value = { count: list.length, toe: round(toe, 3), tenThousandKwh: round(kwh / 10000, 3), missing };
    const note = usedNg ? `天然氣以 ${opts.ng || 'NG1'} 熱值換算（NG1／NG2 待確認）` : '';
    const msg = `共包含 ${list.length} 項具體節能改善措施，計發掘節能潛力 ${fmt(value.toe, 3)} 公噸油當量，其中包括節電潛力 ${fmt(value.tenThousandKwh, 3)} 萬度`;
    if (missing.length) return warn(value, `${msg}（${missing.length} 項未填年節能量，未計入）`, { note });
    return pass(value, msg, { note });
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

  // 年度節電率 = 節電量 ÷ (節電量 + 用電量)（114–117 規定；新版附表三表十之四不再提供計算欄，系統自算）
  //   saving（或 a+b+c+d 各類節電量）、consumption（或 f 全年用電量 − g 可扣除用電量）
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

  // 平均年節電率 = (累計節電量 + 前期超額節電量) ÷ (累計節電量 + 累計用電量)（114–117 規定；
  // 舊版附表三表十之六「歷年平均年節電率總表」已於 115-01-23 版刪除，改由系統依規定自算）
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

  // 表十之四「年度用電量計算」可扣除用電量（可複選，各填度數並附用印佐證）——新版 8 項
  const DEDUCTIONS_N = [
    { key: 'newBuilding', no: 1, label: 'N 年啟用之新建築' },
    { key: 'newEquipment', no: 2, label: 'N 年啟用之新設備' },
    { key: 'rail', no: 3, label: '運輸軌道牽引用電' },
    { key: 'safety', no: 4, label: '具安全考量之用電區域（如醫療安全需求）' },
    { key: 'construction', no: 5, label: '工程施作區域用電' },
    { key: 'newRegulation', no: 6, label: '配合 N 年新法規增加之用電' },
    { key: 'ev', no: 7, label: '電動車充換電設施用電' },
    { key: 'eus', no: 8, label: '依能管法第 16 條能源使用說明書經核准範疇之用電（核准日起 5 年內；填核准日期及文號）' },
  ];
  // 表十一之四「年度用電量估算」可扣除用電量——6 項（無「安全考量區域」與「新法規」）
  const DEDUCTIONS_N1 = [
    { key: 'newBuilding', no: 1, label: 'N+1 年啟用之新建築' },
    { key: 'newEquipment', no: 2, label: 'N+1 年啟用之新設備' },
    { key: 'rail', no: 3, label: '運輸軌道牽引用電' },
    { key: 'construction', no: 4, label: '工程施作區域用電' },
    { key: 'ev', no: 5, label: '電動車充換電設施用電' },
    { key: 'eus', no: 6, label: '依能管法第 16 條能源使用說明書經核准範疇之用電' },
  ];
  const sumDeductions = (list, d) => {
    const parts = {};
    let total = 0;
    for (const x of list) {
      const v = num(d?.[x.key]);
      if (v === undefined) continue;
      if (v < 0) return { error: `可扣除用電量「${x.label}」不可為負數` };
      parts[x.key] = v;
      total += v;
    }
    return { parts, total };
  };

  // 表十之四 年度用電量計算：
  //   N 年全年實際用電量 = 列管電號 1–12 月電費單度數 + 表十之三（二）自發自用認列節電量
  //   年度用電量 = 全年實際用電量 − 可扣除用電量（8 項）
  function annualConsumptionN({ billKwh, selfUseKwh, deductions } = {}) {
    const b = num(billKwh);
    if (b === undefined) return na('未填列管電號 1–12 月電費單度數');
    const actual = b + (num(selfUseKwh) ?? 0);
    const d = sumDeductions(DEDUCTIONS_N, deductions);
    if (d.error) return fail(undefined, d.error);
    const v = round(actual - d.total, 2);
    if (v < 0) return fail(v, '可扣除用電量大於全年實際用電量，請確認');
    return pass(v, `年度用電量 ${fmt(v)} 度（全年實際 ${fmt(actual)} 度 − 可扣除 ${fmt(d.total)} 度）`, { actual: round(actual, 2), deducted: round(d.total, 2), parts: d.parts });
  }

  // 表十一之四 年度用電量估算：□沿用 N 年全年實際用電量（再減 6 項可扣除）或 □其他估算方式（須附說明）
  //   method: 'actual' | 'other'；other 時給 estimateKwh＋note
  function forecastConsumption({ method = 'actual', actualKwh, deductions, estimateKwh, note } = {}) {
    if (method === 'other') {
      const e = num(estimateKwh);
      if (e === undefined) return na('其他估算方式：未填估算用電量');
      if (blank(note)) return fail(e, '採其他估算方式須附估算說明');
      return pass(e, `N+1 年用電量估算 ${fmt(e)} 度（其他估算方式）`, { method });
    }
    const a = num(actualKwh);
    if (a === undefined) return na('未填 N 年全年實際用電量');
    const d = sumDeductions(DEDUCTIONS_N1, deductions);
    if (d.error) return fail(undefined, d.error);
    const v = round(a - d.total, 2);
    if (v < 0) return fail(v, '可扣除用電量大於 N 年全年實際用電量，請確認');
    return pass(v, `N+1 年用電量估算 ${fmt(v)} 度（沿用 N 年 ${fmt(a)} 度 − 可扣除 ${fmt(d.total)} 度）`, { method, deducted: round(d.total, 2), parts: d.parts });
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
    r1: { ...src('附表三', '前言（契約容量 > 800 瓩列管）', `${LAW.annex}；${LAW.target}`, '§2 R1'), note: '以單一電號契約容量判定，不合併計算（業主 2026-10-22）；合併申報欄位只用於附表三表三與附錄二' },
    ex: Object.fromEntries(Object.keys(EXCLUSIONS).map((k) => [k, src('能源用戶排除條件', k, k === 'EX08' ? `${LAW.act}第 16 條第 1 項` : LAW.exPending, '§2 R2')])),
    r3: src('附件一 節能診斷報告', '規定第三點第二項；附件一第四段診斷團隊聲明', LAW.diag, '§2 R3、§3.4'),
    r5: src('附件一 節能診斷報告', '表二、表三「回收年限」欄', LAW.diag, '§2 R5'),
    r6: src('附件一', '註 2', LAW.diag, '§2 R6'),
    r7: src('附件二 節能計畫', '註 1、註 2', LAW.diag, '§2 R7'),
    staff: src('附表三', '一、填表人員；二、其他技師或能管人員', LAW.annex, '§2 R9 能管人員人數'),
    scale: src('附表三', '表三 第 15 欄 營業規模', LAW.annex, '§2 R9 營業規模'),
    occupancy: src('附表三', '表三 第 24 欄 出租率', LAW.annex, '§2 R9 出租率'),
    euiDiff: src('附表三', '表五之四、表五之五', LAW.annex, '§2 R9 EUI 差異'),
    pf: src('附表三', '八、電能系統 變壓器運轉值（功因）', LAW.annex, '§2 R9 功因'),
    xfmr: src('附表三', '八、電能系統 變壓器運轉值（負載率）', LAW.annex, '§2 R9 變壓器負載率'),
    chillerTable: src('附表三', '表九之一（二）', LAW.annex, '§2 R9 冰水機群組效率表'),
    iso: src('附表三', '表四之二 第 1–5 題', LAW.annex, '§2 R9 ISO 50001'),
    pueTable: src('附表三', '表九之八', LAW.annex, '§2 R9 PUE 表'),
    boiler: src('附表三', '表九之五、表九之七', LAW.annex, '§2 R9 蒸汽鍋爐'),
    area: src('附表三', '表五之四（室內面積 = 總樓地板 − 室內停車場）', LAW.annex, '§5.5'),
    eui: src('附表三', '表五之四 電能績效自我評比', LAW.annex, '§6 換算'),
    euiThermal: src('附表三', '表五之五 熱能績效自我評比（公斤油當量/㎡）', LAW.annex, '§5.5、§6 換算'),
    kwrt: src('附表三', '表九之一（二）群組系統效率', LAW.annex, '§6 換算'),
    pue: src('附表三', '表九之八 PUE = (a+b) ÷ b', LAW.annex, '§6 換算'),
    costRatio: src('附表三', '表三 第 23 欄 總能源費用占總支出比例', LAW.annex, '§6 換算'),
    dr: src('附表三', '表十之三（一）需量反應', LAW.annex, '§6 換算'),
    consumption: src('114–117 規定', '年度用電量 = 購電 + 自發 − 售電', LAW.target, '§6'),
    target: src('114–117 規定', '平均年節電率目標', LAW.target, '§6'),
    // 新版附表三刪除表十之六、表十之四改為「年度用電量計算」：節電率改依 114–117 規定由系統自算
    annualRate: src('114–117 規定', '年度節電率 = 節電量 ÷ (節電量 + 用電量)', LAW.target, '§6'),
    avgRate: src('114–117 規定', '平均年節電率 = (累計節電量 + 前期超額) ÷ (累計節電量 + 累計用電量)', LAW.target, '§6'),
    consumptionN: src('附表三', '表十之四 年度用電量計算（可扣除用電量 8 項）', LAW.annex, '§5.10'),
    forecastN1: src('附表三', '表十一之四 年度用電量估算（可扣除用電量 6 項／其他估算方式）', LAW.annex, '§5.11'),
    toe: src('能源署 能源產品單位熱值表', '113 年起適用、114 年修正熱值（1 公斤油當量＝10,000 千卡）', undefined, '§6.1'),
    diagSummary: src('附件一 節能診斷報告', '一、診斷摘要（節能潛力 公噸油當量、節電潛力 萬度）', LAW.diag, '§3.1、§6.1'),
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
    annualConsumptionN: withSource(annualConsumptionN, SRC.consumptionN),
    forecastConsumption: withSource(forecastConsumption, SRC.forecastN1),
    toToe: withSource(toToe, SRC.toe),
    fuelsToKgoe: withSource(fuelsToKgoe, SRC.toe),
    diagnosisSummary: withSource(diagnosisSummary, SRC.diagSummary),
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
    num, round, rocToAd, adToRoc, toRocYear, parseDate, toIso, toRocDate, daysBetween, addYears, replaceCategory, equipmentReplaceCategory,
    // 常數
    ENERGY_USER_KW, EXCLUSIONS, ENGINEER_DISCIPLINES, REPLACE_THRESHOLDS, REPLACE_LABELS, PLAN_PAYBACK_YEARS, PLAN_SPAN_YEARS,
    FIRST_PERIOD_DUE, LAW, SOURCES: SRC, ENERGY_UNITS, DEDUCTIONS_N, DEDUCTIONS_N1,
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);

// ════════════════════════════════════════════════════════════════
// 水足跡盤查（工作清單 23）：取水／排放／消耗、用水單元占比、用水績效指標、基線比較、資料完整度。
// 依據：ISO 14046:2014（盤查 5.3）、ISO 46001:2019（用水審查 6.2.4、指標 6.2.5～6.2.7）；
// 條號與取得程度見 docs/water-footprint-spec.md §3。另起一段 IIFE 掛到同一個 EMSInventoryCompute 上，
// 不動上面任何既有函式。輸入是 inventory 的形狀 { site, points, records }，年份一律西元（records.period 是 YYYY-MM）。
// 單位：m³（水費單的「度」＝m³）；項目單位是公升時 ÷ 1,000。
// ════════════════════════════════════════════════════════════════
(function (g) {
  'use strict';
  const C = g.EMSInventoryCompute;
  if (!C) return;
  const num = C.num, round = C.round;
  const SPEC_DOC = 'docs/water-footprint-spec.md';
  const s14 = (ref, spec, note) => ({ doc: 'ISO 14046:2014', ref, spec, specDoc: SPEC_DOC, ...(note ? { note } : {}) });
  const s46 = (ref, spec, note) => ({ doc: 'ISO 46001:2019', ref, spec, specDoc: SPEC_DOC, ...(note ? { note } : {}) });
  const WSRC = {
    intake: s14('3.2.2 取水；5.3.2 基本流（依水源別）', '§3.1', '5.3.2 條文內容取自二手來源'),
    replace: s46('第 1 章 註 2 replace（以雨水、再生水取代自來水）', '§3.1'),
    discharge: s14('3.1.9 基本水流；3.2.1 註 2', '§3.2'),
    reuse: s46('第 1 章 註 3 reuse', '§3.2'),
    consumption: s14('3.2.1 註 2 消耗（取出後未回到同一流域）', '§3.3'),
    units: s46('6.2.4 用水審查；附錄 C 水平衡', '§3.4', '6.2.4 條文內容取自二手來源'),
    quality: s14('3.2.4 水質；5.3.2', '§2.5'),
    indicator: s46('3.4 營運活動指標；6.2.5、6.2.6', '§3.5'),
    baseline: s46('3.2 基線用水效率指標；6.2.7；6.3', '§3.6'),
    completeness: s14('4.8 完整性；5.2.4 資料品質要求', '§3.7'),
    saving: s46('6.3 目標與行動計畫；10.2 持續改善', '§2.6'),
    inventory: s14('5.3 水足跡盤查分析', '§3', '只做盤查，不做 5.4 衝擊評估'),
  };
  // 用水績效指標（ISO 46001 3.4）。label 與 src/water-schema.js 的 REPORTING_UNITS 相同（測試有對）
  const WATER_INDICATORS = [
    { id: 'bedDay', label: '每床日', unit: 'L/床日', per: 'L', denom: (a) => num(a?.bedDays), denomLabel: '住院人日' },
    { id: 'visit', label: '每人次（門急診＋住院）', unit: 'L/人次', per: 'L',
      denom: (a) => { const xs = [a?.outpatientVisits, a?.erVisits, a?.admissions].map(num).filter((v) => v !== undefined); return xs.length ? xs.reduce((s, v) => s + v, 0) : undefined; },
      denomLabel: '門診＋急診＋住院人次' },
    { id: 'area', label: '每平方公尺樓地板', unit: 'm³/m²·年', per: 'm3', denom: (a) => num(a?.floorArea), denomLabel: '樓地板面積' },
    { id: 'fte', label: '每員工（FTE）', unit: 'm³/人·年', per: 'm3', denom: (a) => num(a?.staffFte), denomLabel: '員工（FTE）' },
  ];
  const REPLACE_TYPES = ['雨水回收', '再生水（外購）', '院內回收水'];

  // 單位換算成 m³；空白視為 m³；認不得回 undefined
  function waterUnitFactor(unit) {
    const u = String(unit ?? '').trim().toLowerCase().replace(/\s/g, '');
    if (!u || ['m³', 'm3', '度', '立方公尺', '立方米', 'cmd', '噸', 'ton', 't'].includes(u)) return 1;
    if (['l', '公升', '升', 'litre', 'liter'].includes(u)) return 0.001;
    if (['kl', '公秉', '千公升'].includes(u)) return 1;
    return undefined;
  }
  // 一筆紀錄裡某項目的量（m³）：reading 取用量、number 取數值
  function waterItemAmount(item, record) {
    const raw = item.type === 'reading' ? record?.usage?.[item.id] : record?.values?.[item.id];
    const v = num(raw);
    if (v === undefined) return undefined;
    const f = waterUnitFactor(item.unit);
    return f === undefined ? undefined : v * f;
  }
  const monthIdx = (period) => { const m = /^(\d{4})-(\d{2})$/.exec(String(period || '')); return m ? Number(m[2]) - 1 : -1; };
  const inYear = (period, year) => String(period || '').startsWith(`${year}-`);
  const zeros = () => Array(12).fill(undefined);
  const addM = (arr, i, v) => { if (i >= 0 && i < 12 && v !== undefined) arr[i] = (arr[i] || 0) + v; };
  const sumM = (arr) => { const xs = arr.filter((v) => v !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined; };
  const r3 = (v) => (v === undefined ? undefined : round(v, 3));
  const rowsOf = (inv, id) => (Array.isArray(inv?.site?.[id]) ? inv.site[id] : []);

  // 全院所有水類點位的項目（含停用點位：停用前的紀錄照算）
  function waterItems(inv) {
    const out = [];
    for (const p of inv?.points || []) {
      if (p.domain !== 'water') continue;
      for (const it of p.items || []) out.push({ point: p, item: it });
    }
    return out;
  }

  // ── 取水／用水單元／排放／回收／水質／節水改善：資料年 year（西元）──
  function waterFlows(inv, { year } = {}) {
    const Y = num(year);
    const recs = (inv?.records || []).filter((r) => inYear(r.period, Y));
    const all = waterItems(inv);
    const tagged = all.filter((x) => x.item.waterFlow);
    // 退路：整院沒有任何項目標「取水」時，水類點位上沒標流向的讀數項目推定為取水（標 inferred）
    const anyIntake = tagged.some((x) => x.item.waterFlow === 'intake');
    const untaggedReadings = all.filter((x) => !x.item.waterFlow && x.item.type === 'reading');
    const intakeItems = anyIntake ? tagged.filter((x) => x.item.waterFlow === 'intake') : untaggedReadings;
    const inferred = !anyIntake && untaggedReadings.length > 0;
    const badUnits = [];
    const recsOf = (code) => recs.filter((r) => r.pointCode === code);
    const amountMonths = ({ point, item }) => {
      const ms = zeros();
      if (waterUnitFactor(item.unit) === undefined) { badUnits.push({ pointCode: point.code, itemId: item.id, label: item.label, unit: item.unit }); return ms; }
      for (const r of recsOf(point.code)) addM(ms, monthIdx(r.period), waterItemAmount(item, r));
      return ms;
    };

    // 取水（依水源）
    const sources = rowsOf(inv, 'waterSources');
    const bySrc = new Map();
    const srcBucket = (id) => {
      const key = id && sources.some((s) => s.id === id) ? id : '';
      if (!bySrc.has(key)) {
        const s = sources.find((x) => x.id === key);
        bySrc.set(key, { id: key || null, name: s?.name || '未指定水源', type: s?.sourceType || '', accountNo: s?.accountNo || '', freshness: s?.freshness || '', waterBody: s?.waterBody || '', months: zeros(), items: [] });
      }
      return bySrc.get(key);
    };
    for (const s of sources) srcBucket(s.id);
    const intakeM = zeros();
    for (const x of intakeItems) {
      const b = srcBucket(x.item.waterSourceId);
      const ms = amountMonths(x);
      ms.forEach((v, i) => { addM(b.months, i, v); addM(intakeM, i, v); });
      b.items.push({ pointCode: x.point.code, itemId: x.item.id, label: x.item.label });
    }
    const W = sumM(intakeM);
    const bySource = [...bySrc.values()].filter((b) => b.id || b.items.length).map((b) => {
      const total = sumM(b.months);
      return { ...b, months: b.months.map(r3), total: r3(total), share: W && total !== undefined ? round(total / W * 100, 1) : undefined };
    });
    const replaceTotal = bySource.filter((b) => REPLACE_TYPES.includes(b.type)).reduce((s, b) => (b.total === undefined ? s : (s || 0) + b.total), undefined);

    // 排放（依排放口）
    const dests = rowsOf(inv, 'waterDischarges');
    const byDest = new Map();
    const dBucket = (id) => {
      const key = id && dests.some((d) => d.id === id) ? id : '';
      if (!byDest.has(key)) {
        const d = dests.find((x) => x.id === key);
        byDest.set(key, { id: key || null, name: d?.name || '未指定排放口', destination: d?.destination || '', receivingBody: d?.receivingBody || '', permitNo: d?.permitNo || '', months: zeros(), items: [] });
      }
      return byDest.get(key);
    };
    for (const d of dests) dBucket(d.id);
    const disM = zeros();
    let dischargeMeasured = false;
    for (const x of tagged.filter((y) => y.item.waterFlow === 'discharge')) {
      dischargeMeasured = true;
      const b = dBucket(x.item.waterDischargeId);
      amountMonths(x).forEach((v, i) => { addM(b.months, i, v); addM(disM, i, v); });
      b.items.push({ pointCode: x.point.code, itemId: x.item.id, label: x.item.label });
    }
    const D = sumM(disM);
    const byDestination = [...byDest.values()].filter((b) => b.id || b.items.length).map((b) => ({ ...b, months: b.months.map(r3), total: r3(sumM(b.months)) }));

    // 回收再利用
    const reuseM = zeros();
    for (const x of tagged.filter((y) => y.item.waterFlow === 'reuse')) amountMonths(x).forEach((v, i) => addM(reuseM, i, v));
    const R = sumM(reuseM);

    // 用水單元
    const unitRows = rowsOf(inv, 'waterUnits');
    const useBy = new Map();
    for (const x of tagged.filter((y) => y.item.waterFlow === 'use')) {
      const key = x.item.waterUnitId && unitRows.some((u) => u.id === x.item.waterUnitId) ? x.item.waterUnitId : '';
      const cur = useBy.get(key) || { months: zeros(), items: [] };
      amountMonths(x).forEach((v, i) => addM(cur.months, i, v));
      cur.items.push({ pointCode: x.point.code, itemId: x.item.id, label: x.item.label });
      useBy.set(key, cur);
    }
    let meteredSum;
    const units = unitRows.map((u) => {
      const m = useBy.get(u.id);
      const metered = !!m;
      let use = metered ? sumM(m.months) : undefined;
      let estimated = false;
      if (!metered && num(u.estimatedShare) !== undefined && W !== undefined) { use = W * num(u.estimatedShare) / 100; estimated = true; }
      if (metered && use !== undefined) meteredSum = (meteredSum || 0) + use;
      const cp = num(u.consumptionPct);
      return {
        id: u.id, name: u.name || u.kind || u.id, kind: u.kind || '', building: u.building || '', useForm: u.useForm || '', significant: !!u.significant,
        metered, estimated, use: r3(use), months: metered ? m.months.map(r3) : zeros(), share: W && use !== undefined ? round(use / W * 100, 1) : undefined,
        consumptionPct: cp, consumption: use !== undefined && cp !== undefined ? r3(use * cp / 100) : undefined, items: m?.items || [],
      };
    });
    const orphan = useBy.get('');
    if (orphan) {
      const use = sumM(orphan.months);
      if (use !== undefined) meteredSum = (meteredSum || 0) + use;
      units.push({ id: null, name: '未指定用水單元', kind: '', metered: true, estimated: false, use: r3(use), months: orphan.months.map(r3), share: W && use !== undefined ? round(use / W * 100, 1) : undefined, items: orphan.items });
    }
    const unmetered = W !== undefined ? r3(W - (meteredSum || 0)) : undefined;

    // 消耗量：有排放量 → 質量平衡；沒有 → 用水單元消耗比例估算
    let consumption;
    if (W !== undefined && D !== undefined) {
      const v = W - D;
      // 排放有缺月時質量平衡會高估消耗：照算但提示
      const mi = intakeM.filter((x) => x !== undefined).length, md = disM.filter((x) => x !== undefined).length;
      const gap = md < mi ? `（排放只有 ${md} 個月資料、取水 ${mi} 個月，消耗量會偏高）` : '';
      consumption = { value: r3(v), method: 'balance', msg: `消耗量＝取水 ${C_fmt(W)} − 排放 ${C_fmt(D)} ＝ ${C_fmt(v)} m³${v < 0 ? '（排放大於取水，請檢查讀數或是否有未登錄的水源）' : gap}`, level: v < 0 || gap ? 'warn' : 'ok' };
    } else {
      const est = units.filter((u) => u.consumption !== undefined);
      if (W !== undefined && est.length) {
        const v = est.reduce((s, u) => s + u.consumption, 0);
        consumption = { value: r3(v), method: 'units', msg: `排放量未量測，依 ${est.length} 個用水單元的消耗比例估算：${C_fmt(v)} m³（估算）`, level: 'warn' };
      } else consumption = { value: undefined, method: null, msg: '排放量未量測，用水單元也沒有消耗比例，算不出消耗量', level: 'na' };
    }
    consumption.source = WSRC.consumption;

    // 水質（依排放口 × 項目）
    const qmap = new Map();
    for (const x of tagged.filter((y) => y.item.waterFlow === 'quality')) {
      const param = x.item.waterParam || x.item.label;
      const key = `${x.item.waterDischargeId || ''}|${param}`;
      const q = qmap.get(key) || { dischargeId: x.item.waterDischargeId || null, dischargeName: dests.find((d) => d.id === x.item.waterDischargeId)?.name || '未指定排放口', param, unit: x.item.unit || '', values: [] };
      for (const r of recsOf(x.point.code)) { const v = num(r.values?.[x.item.id]); if (v !== undefined) q.values.push({ v, period: r.period, at: r.at }); }
      qmap.set(key, q);
    }
    const quality = [...qmap.values()].map((q) => {
      const vs = q.values.map((x) => x.v);
      const last = q.values.slice().sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1))[0];
      return { dischargeId: q.dischargeId, dischargeName: q.dischargeName, param: q.param, unit: q.unit, n: vs.length,
        min: vs.length ? Math.min(...vs) : undefined, max: vs.length ? Math.max(...vs) : undefined,
        avg: vs.length ? round(vs.reduce((a, b) => a + b, 0) / vs.length, 3) : undefined, last: last?.v, lastPeriod: last?.period };
    });

    // 節水改善回報
    const savings = [];
    for (const x of tagged.filter((y) => y.item.waterFlow === 'saving')) {
      for (const r of recsOf(x.point.code)) {
        const v = num(r.values?.[x.item.id]);
        const texts = (x.point.items || []).filter((i) => i.type === 'text').map((i) => r.values?.[i.id]).filter(Boolean);
        if (v === undefined && !texts.length) continue;
        const u = unitRows.find((y) => y.id === x.item.waterUnitId);
        savings.push({ period: r.period, at: r.at, pointCode: x.point.code, pointName: x.point.name, action: texts.join('；'), saving: v, unitName: u?.name || '', who: r.who || '', note: r.note || '' });
      }
    }

    return {
      year: Y,
      intake: { total: r3(W), months: intakeM.map(r3), bySource, inferred, replace: r3(replaceTotal), replacePct: W && replaceTotal !== undefined ? round(replaceTotal / W * 100, 1) : undefined, source: WSRC.intake },
      discharge: { total: r3(D), months: disM.map(r3), byDestination, measured: dischargeMeasured, source: WSRC.discharge },
      reuse: { total: r3(R), months: reuseM.map(r3), rate: R !== undefined && (W || 0) + R > 0 ? round(R / ((W || 0) + R) * 100, 1) : undefined, source: WSRC.reuse },
      consumption,
      units, unmetered, unitsSource: WSRC.units,
      quality, qualitySource: WSRC.quality,
      savings, savingTotal: r3(savings.reduce((s, x) => (x.saving === undefined ? s : (s || 0) + x.saving), undefined)), savingSource: WSRC.saving,
      badUnits,
      untagged: all.filter((x) => !x.item.waterFlow && (x.item.type === 'reading' || x.item.type === 'number')).map((x) => ({ pointCode: x.point.code, pointName: x.point.name, itemId: x.item.id, label: x.item.label })),
      source: WSRC.inventory,
    };
  }
  // 訊息裡的數字（共用 fmt 沒有對外，這裡用 round＋千分位自做）
  function C_fmt(v) { if (v === undefined) return '—'; const [i, f] = String(round(v, 2)).split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); }

  // 營運活動資料（site.waterActivity 該年那一筆；樓地板面積空白用表三第 18 欄）
  function waterActivityOf(inv, year) {
    const Y = num(year);
    const row = rowsOf(inv, 'waterActivity').find((a) => num(a.year) === Y || (num(a.year) !== undefined && num(a.year) + 1911 === Y));
    const fa = num(row?.floorArea) ?? num(inv?.site?.basic?.floorArea);
    return row ? { ...row, floorArea: fa, floorAreaFrom: num(row.floorArea) !== undefined ? 'waterActivity' : (fa !== undefined ? 'basic' : null) } : (fa !== undefined ? { year: Y, floorArea: fa, floorAreaFrom: 'basic', partial: true } : null);
  }
  // 報告單位（範疇勾的）→ 指標 id；都沒勾＝全部
  function waterIndicatorIds(scope) {
    const picked = (Array.isArray(scope?.reportingUnits) ? scope.reportingUnits : []).map((l) => WATER_INDICATORS.find((x) => x.label === l)?.id).filter(Boolean);
    return picked.length ? picked : WATER_INDICATORS.map((x) => x.id);
  }

  // ── 用水績效指標（ISO 46001 3.4、6.2.6）──
  function waterPerformance({ intake, activity, ids } = {}) {
    const W = num(intake);
    const use = ids && ids.length ? WATER_INDICATORS.filter((x) => ids.includes(x.id)) : WATER_INDICATORS;
    return use.map((x) => {
      const d = x.denom(activity);
      const base = { id: x.id, label: x.label, unit: x.unit, denominator: d, denomLabel: x.denomLabel, source: WSRC.indicator };
      if (W === undefined) return { ...base, ok: null, level: 'na', value: undefined, msg: `${x.label}：沒有取水量，算不出` };
      if (!d) return { ...base, ok: null, level: 'na', value: undefined, msg: `${x.label}：缺${x.denomLabel}，算不出` };
      const v = round((x.per === 'L' ? W * 1000 : W) / d, 3);
      return { ...base, ok: true, level: 'ok', value: v, msg: `${x.label}用水 ${C_fmt(v)} ${x.unit}` };
    });
  }

  // ── 與基線比較（ISO 46001 3.2、6.2.7、6.3）──
  function waterBaselineCompare(curr, base, { targetPct } = {}) {
    const T = num(targetPct);
    return (curr || []).map((c) => {
      const b = (base || []).find((x) => x.id === c.id);
      const out = { id: c.id, label: c.label, unit: c.unit, value: c.value, baseline: b?.value, source: WSRC.baseline };
      if (c.value === undefined || b?.value === undefined || !b.value) return { ...out, ok: null, level: 'na', diffPct: undefined, met: undefined, msg: `${c.label}：本年或基線年缺資料，無法比較` };
      const diff = round((c.value - b.value) / b.value * 100, 1);
      const met = T === undefined ? undefined : diff <= -T;
      const dir = diff > 0 ? `增加 ${diff}%` : diff < 0 ? `減少 ${-diff}%` : '持平';
      const msg = `${c.label}較基線${dir}${T === undefined ? '' : met ? `，已達目標（降低 ${T}%）` : `，未達目標（降低 ${T}%）`}`;
      return { ...out, diffPct: diff, met, ok: met === undefined ? diff <= 0 : met, level: (met === false || (met === undefined && diff > 0)) ? 'warn' : 'ok', msg };
    });
  }

  // ── 資料完整度（ISO 14046 4.8、5.2.4）──
  function waterCompleteness(inv, flows, { activity, baselineYear, baselineFlows } = {}) {
    const checks = [];
    const add = (key, label, ok, msg) => checks.push({ key, label, ok: !!ok, msg, source: WSRC.completeness });
    const scope = inv?.site?.waterScope || {};
    const months = flows.intake.months.filter((v) => v !== undefined).length;
    const all = waterItems(inv);
    const has = (f) => all.some((x) => x.item.waterFlow === f);
    add('scope', '範疇必填（目的、系統邊界、報告單位、基線年）', scope.goal && scope.boundary && Array.isArray(scope.reportingUnits) && scope.reportingUnits.length && scope.baselineYear,
      '請到初始建檔「水足跡範疇與基線」填目的、系統邊界、報告單位、基線年');
    add('intakeTagged', '有標示「取水」的點位項目', has('intake'), flows.intake.inferred ? '沒有項目標「取水」，目前以水類點位的讀數推定；請在點位項目設定流向' : '請建立自來水總表等取水點位（可套用範本）');
    add('months', `取水 12 個月都有資料（目前 ${months}/12）`, months === 12, `取水只有 ${months} 個月有資料`);
    const srcs = rowsOf(inv, 'waterSources');
    const unlinked = srcs.filter((s) => !all.some((x) => x.item.waterSourceId === s.id));
    add('sources', '每個水源都有點位量測', srcs.length && !unlinked.length, srcs.length ? `尚未連到點位的水源：${unlinked.map((s) => s.name || s.id).join('、')}` : '尚未登錄水源');
    const sig = rowsOf(inv, 'waterUnits').filter((u) => u.significant);
    const sigNo = flows.units.filter((u) => u.id && u.significant && !u.metered);
    add('units', '主要用水單元都有分表', sig.length && !sigNo.length, sig.length ? `沒有分表的主要用水單元：${sigNo.map((u) => u.name).join('、')}（目前用估計占比）` : '尚未標示主要用水單元');
    add('discharge', '排放量有量測', flows.discharge.measured, '沒有「排放」點位項目：消耗量只能估算');
    add('activity', '營運活動資料（本年）', activity && !activity.partial, '請到初始建檔「營運活動資料」填本年住院人日、門急診人次、員工');
    add('baseline', '基線年有取水資料', baselineYear && baselineFlows && baselineFlows.intake.total !== undefined, baselineYear ? `基線年 ${baselineYear} 沒有取水資料` : '尚未設定基線年');
    const needQ = rowsOf(inv, 'waterDischarges').flatMap((d) => (d.qualityParams || []).map((p) => ({ d, p })));
    const missQ = needQ.filter(({ d, p }) => !flows.quality.some((q) => q.dischargeId === d.id && q.param === p && q.n > 0));
    add('quality', '排放口登錄的水質項目都有抽測值', !missQ.length, needQ.length ? `沒有抽測值：${missQ.map(({ d, p }) => `${d.name || d.id}·${p}`).join('、')}` : '排放口沒有登錄水質檢測項目');
    add('units-ok', '點位項目單位可換算成 m³', !flows.badUnits.length, `單位認不得：${flows.badUnits.map((b) => `${b.pointCode}「${b.label}」(${b.unit})`).join('、')}`);
    const okN = checks.filter((c) => c.ok).length;
    return { pct: round(okN / checks.length * 100, 0), passed: okN, total: checks.length, monthsCovered: months, checks, source: WSRC.completeness };
  }

  // ── 整合：一年的水足跡盤查 ──
  function waterInventory(inv, { year } = {}) {
    const Y = num(year);
    const scope = inv?.site?.waterScope || {};
    const flows = waterFlows(inv, { year: Y });
    const activity = waterActivityOf(inv, Y);
    const ids = waterIndicatorIds(scope);
    const performance = waterPerformance({ intake: flows.intake.total, activity, ids });
    let BY = num(scope.baselineYear);
    if (BY !== undefined && BY < 1911) BY += 1911;
    let baseline = null;
    if (BY !== undefined) {
      const bf = BY === Y ? flows : waterFlows(inv, { year: BY });
      const ba = waterActivityOf(inv, BY);
      const bp = waterPerformance({ intake: bf.intake.total, activity: ba, ids });
      baseline = { year: BY, flows: { intake: bf.intake.total }, rawFlows: bf, activity: ba, performance: bp, compare: waterBaselineCompare(performance, bp, { targetPct: scope.targetPct }), source: WSRC.baseline };
    }
    const completeness = waterCompleteness(inv, flows, { activity, baselineYear: BY, baselineFlows: baseline?.rawFlows });
    if (baseline) delete baseline.rawFlows;
    return { year: Y, scope, flows, activity, performance, baseline, completeness, source: WSRC.inventory };
  }

  Object.assign(C, {
    waterUnitFactor, waterItemAmount, waterFlows, waterActivityOf, waterIndicatorIds, waterPerformance, waterBaselineCompare, waterCompleteness, waterInventory,
    WATER_INDICATORS: WATER_INDICATORS.map(({ id, label, unit, denomLabel }) => ({ id, label, unit, denomLabel })),
    WATER_SOURCES: WSRC,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
