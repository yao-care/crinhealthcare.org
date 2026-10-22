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
    // denomKeys：可按月填報的分母（申報與報告 › 報表資料輸入「水足跡·每月營運活動」，工作清單 26-3）
    { id: 'bedDay', label: '每床日', unit: 'L/床日', per: 'L', denom: (a) => num(a?.bedDays), denomLabel: '住院人日', denomKeys: ['bedDays'] },
    { id: 'visit', label: '每人次（門急診＋住院）', unit: 'L/人次', per: 'L',
      denom: (a) => { const xs = [a?.outpatientVisits, a?.erVisits, a?.admissions].map(num).filter((v) => v !== undefined); return xs.length ? xs.reduce((s, v) => s + v, 0) : undefined; },
      denomLabel: '門診＋急診＋住院人次', denomKeys: ['outpatientVisits', 'erVisits', 'admissions'] },
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

  // 營運活動資料：每月實填（annual[民國年].waterMonthly，工作清單 26-3）優先；沒有月資料的項目用 site.waterActivity 該年那一筆；
  // 樓地板面積空白用表三第 18 欄。from[key]＝'monthly'｜'yearly'，monthly＝12 個月的列（沒填的月是 null）。
  const MONTHLY_KEYS = ['bedDays', 'outpatientVisits', 'erVisits', 'admissions'];
  function waterMonthlyOf(inv, year) {
    const Y = num(year);
    const rows = inv?.annual?.[Y - 1911]?.waterMonthly;
    if (!Array.isArray(rows) || !rows.length) return null;
    const out = Array(12).fill(null);
    for (const r of rows) { const m = num(r?.month); if (m >= 1 && m <= 12 && MONTHLY_KEYS.some((k) => num(r[k]) !== undefined)) out[m - 1] = r; }
    return out.some(Boolean) ? out : null;
  }
  function waterActivityOf(inv, year) {
    const Y = num(year);
    const row = rowsOf(inv, 'waterActivity').find((a) => num(a.year) === Y || (num(a.year) !== undefined && num(a.year) + 1911 === Y));
    const mon = waterMonthlyOf(inv, Y);
    const fa = num(row?.floorArea) ?? num(inv?.site?.basic?.floorArea);
    if (!row && !mon) return fa !== undefined ? { year: Y, floorArea: fa, floorAreaFrom: 'basic', partial: true, from: {} } : null;
    const out = { ...(row || { year: Y }) };
    const from = {};
    for (const k of MONTHLY_KEYS) {
      const xs = mon ? mon.map((m) => num(m?.[k])).filter((v) => v !== undefined) : [];
      if (xs.length) { out[k] = xs.reduce((a, b) => a + b, 0); from[k] = 'monthly'; }
      else if (num(row?.[k]) !== undefined) from[k] = 'yearly';
    }
    const monthsFilled = mon ? mon.filter(Boolean).length : 0;
    return { ...out, floorArea: fa, floorAreaFrom: num(row?.floorArea) !== undefined ? 'waterActivity' : (fa !== undefined ? 'basic' : null),
      from, monthly: mon, monthsFilled, ...(row || monthsFilled === 12 ? {} : { partial: true }) };
  }
  // 報告單位（範疇勾的）→ 指標 id；都沒勾＝全部
  function waterIndicatorIds(scope) {
    const picked = (Array.isArray(scope?.reportingUnits) ? scope.reportingUnits : []).map((l) => WATER_INDICATORS.find((x) => x.label === l)?.id).filter(Boolean);
    return picked.length ? picked : WATER_INDICATORS.map((x) => x.id);
  }

  // ── 用水績效指標（ISO 46001 3.4、6.2.6）──
  // 分母按月實填時（activity.monthly），只拿「取水與分母都有資料的月份」相除，月份不齊也不會高估；monthsUsed 記用了幾個月。
  function waterPerformance({ intake, activity, ids, intakeMonths } = {}) {
    const W = num(intake);
    const use = ids && ids.length ? WATER_INDICATORS.filter((x) => ids.includes(x.id)) : WATER_INDICATORS;
    return use.map((x) => {
      const base = { id: x.id, label: x.label, unit: x.unit, denomLabel: x.denomLabel, source: WSRC.indicator };
      const monthly = x.denomKeys && activity?.monthly && x.denomKeys.some((k) => activity.from?.[k] === 'monthly') && Array.isArray(intakeMonths);
      if (monthly) {
        const rows = activity.monthly.map((m, i) => {
          const ds = m ? x.denomKeys.map((k) => num(m[k])).filter((v) => v !== undefined) : [];
          const d = ds.length ? ds.reduce((a, b) => a + b, 0) : undefined;
          const w = num(intakeMonths[i]);
          return { month: i + 1, intake: w, denominator: d, value: w !== undefined && d ? round((x.per === 'L' ? w * 1000 : w) / d, 3) : undefined };
        });
        const ok = rows.filter((r) => r.value !== undefined);
        const sw = ok.reduce((a, r) => a + r.intake, 0), sd = ok.reduce((a, r) => a + r.denominator, 0);
        const b2 = { ...base, denominator: ok.length ? sd : activity[x.denomKeys[0]], denomFrom: 'monthly', months: rows, monthsUsed: ok.length };
        if (!ok.length) return { ...b2, ok: null, level: 'na', value: undefined, msg: `${x.label}：取水與每月${x.denomLabel}沒有同一個月的資料，算不出` };
        const v = round((x.per === 'L' ? sw * 1000 : sw) / sd, 3);
        return { ...b2, ok: true, level: ok.length === 12 ? 'ok' : 'warn', value: v, msg: `${x.label}用水 ${C_fmt(v)} ${x.unit}${ok.length < 12 ? `（只用 ${ok.length} 個月：取水與${x.denomLabel}都有資料的月份）` : '（每月實填）'}` };
      }
      const d = x.denom(activity);
      const b1 = { ...base, denominator: d, denomFrom: x.denomKeys ? (activity?.from?.[x.denomKeys[0]] || null) : null };
      if (W === undefined) return { ...b1, ok: null, level: 'na', value: undefined, msg: `${x.label}：沒有取水量，算不出` };
      if (!d) return { ...b1, ok: null, level: 'na', value: undefined, msg: `${x.label}：缺${x.denomLabel}，算不出` };
      const v = round((x.per === 'L' ? W * 1000 : W) / d, 3);
      return { ...b1, ok: true, level: 'ok', value: v, msg: `${x.label}用水 ${C_fmt(v)} ${x.unit}` };
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
    add('activity', '營運活動資料（本年）', activity && !activity.partial, activity?.monthly ? `每月營運活動只填了 ${activity.monthsFilled}/12 個月（申報與報告 › 報表資料輸入）` : '請到申報與報告 › 報表資料輸入「水足跡·每月營運活動」按月填住院人日、門急診人次（或初始建檔「營運活動資料」填年值）');
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
    const performance = waterPerformance({ intake: flows.intake.total, activity, ids, intakeMonths: flows.intake.months });
    let BY = num(scope.baselineYear);
    if (BY !== undefined && BY < 1911) BY += 1911;
    let baseline = null;
    if (BY !== undefined) {
      const bf = BY === Y ? flows : waterFlows(inv, { year: BY });
      const ba = waterActivityOf(inv, BY);
      const bp = waterPerformance({ intake: bf.intake.total, activity: ba, ids, intakeMonths: bf.intake.months });
      baseline = { year: BY, flows: { intake: bf.intake.total }, rawFlows: bf, activity: ba, performance: bp, compare: waterBaselineCompare(performance, bp, { targetPct: scope.targetPct }), source: WSRC.baseline };
    }
    const completeness = waterCompleteness(inv, flows, { activity, baselineYear: BY, baselineFlows: baseline?.rawFlows });
    if (baseline) delete baseline.rawFlows;
    return { year: Y, scope, flows, activity, performance, baseline, completeness, source: WSRC.inventory };
  }

  Object.assign(C, {
    waterUnitFactor, waterItemAmount, waterFlows, waterMonthlyOf, waterActivityOf, waterIndicatorIds, waterPerformance, waterBaselineCompare, waterCompleteness, waterInventory,
    WATER_INDICATORS: WATER_INDICATORS.map(({ id, label, unit, denomLabel }) => ({ id, label, unit, denomLabel })),
    WATER_SOURCES: WSRC,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ════════════════════════════════════════════════════════════════
// 水足跡延伸（工作清單 26）：間接用水（外購電力）、缺水足跡衝擊評估（AWARE）、水質限值與超標、節水目標達成度。
// 依據：ISO 14046:2014 5.2.3（系統邊界）、5.4（水足跡衝擊評估）；ISO 46001:2019 6.2.7、6.3；
//       放流水標準、水污染防治措施及檢測申報管理辦法；WULCA AWARE 特徵化因子；台電永續報告書（發電用水）。
// 係數與版本全部放在這一段的常數（前後端同一份）；來源與取得程度見 docs/water-footprint-spec.md §9～§12。
// waterFootprint(inv, { year }) ＝ waterInventory ＋ indirect ＋ scarcity ＋ quality ＋ targets，報表與管理端都用這一支。
// ════════════════════════════════════════════════════════════════
(function (g) {
  'use strict';
  const C = g.EMSInventoryCompute;
  if (!C || !C.waterInventory) return;
  const num = C.num, round = C.round;
  const SPEC_DOC = 'docs/water-footprint-spec.md';
  const s14 = (ref, spec, note) => ({ doc: 'ISO 14046:2014', ref, spec, specDoc: SPEC_DOC, ...(note ? { note } : {}) });
  const s46 = (ref, spec, note) => ({ doc: 'ISO 46001:2019', ref, spec, specDoc: SPEC_DOC, ...(note ? { note } : {}) });
  const r3 = (v) => (v === undefined ? undefined : round(v, 3));
  const nf = (v, d = 2) => { if (v === undefined) return '—'; const [a, b] = String(round(v, d)).split('.'); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (b ? '.' + b : ''); };
  const blank = (v) => v === undefined || v === null || v === '';

  // 缺水特徵化因子（WULCA AWARE2.0，UNEP GLAM 推薦方法的現行版本）。單位 m³ world-eq / m³ 消耗；範圍 0.1～100。
  // 全國：AWARE20_Countries_and_Regions.xlsx 列 ID 406「Taiwan」（ecoinvent TW），工作表 CFs_nonagri／CFs_agri／CFs_unspecified，欄 Annual、Jan～Dec。
  // 縣市：AWARE20_Subnational_Resolution.xlsx 工作表 CFs_nonagri（GADM 4.1，只取年平均非農業）。
  // 流域：AWARE20_Native_CFs.xlsx 工作表 native_CFs（每流域一組月別 CF，用途別只差在年平均的加權）。
  // 全球平均（GLO）非農業 17.9、不分用途 39.5。
  const M = (a) => a;   // 月別 1～12 月
  const AWARE = {
    name: 'WULCA AWARE', version: 'AWARE2.0（Zenodo 資料 v1.0.2，檔內版本日 2025-04-03）',
    file: 'AWARE20_Countries_and_Regions.xlsx／AWARE20_Subnational_Resolution.xlsx／AWARE20_Native_CFs.xlsx',
    url: 'https://zenodo.org/records/21708463', published: '2025（Seitfudem et al., J. Industrial Ecology 29(3):891–907, doi:10.1111/jiec.70023）',
    regions: [
      { id: 'TWN', label: '臺灣（全國平均）', annual: { nonAgri: 6.88, agri: 10.4, unknown: 9.08 },
        monthly: { nonAgri: M([10.5, 27.2, 28.2, 3.36, 2.15, 0.26, 1.17, 0.327, 0.239, 0.661, 4.96, 5.03]), unknown: M([14.9, 43.5, 55.8, 3.87, 1.61, 0.253, 1.17, 0.317, 0.243, 0.738, 9.46, 7.72]) },
        note: 'AWARE20_Countries_and_Regions.xlsx 列 ID 406 Taiwan；GLAM 沒有獨立的 TWN 列' },
      { id: 'TW-TPE', label: '臺北市（縣市層級）', annual: { nonAgri: 0.404 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri；只有年平均' },
      { id: 'TW-NWT', label: '新北市（縣市層級）', annual: { nonAgri: 0.461 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri；只有年平均' },
      { id: 'TW-TXG', label: '臺中市（縣市層級）', annual: { nonAgri: 1.02 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri；只有年平均' },
      { id: 'TW-TNN', label: '臺南市（縣市層級）', annual: { nonAgri: 22.8 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri；只有年平均' },
      { id: 'TW-KHH', label: '高雄市（縣市層級）', annual: { nonAgri: 17.3 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri；只有年平均' },
      { id: 'TW-OTH', label: '其他縣市（臺灣省，縣市層級）', annual: { nonAgri: 6.68 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri「Taiwan」；只有年平均' },
      { id: 'TW-FJ', label: '金門、連江（縣市層級）', annual: { nonAgri: 1.66 }, note: 'AWARE20_Subnational_Resolution.xlsx CFs_nonagri「Fujian」；只有年平均' },
    { id: 'B43170', label: '流域 43170：淡水河流域（臺北、新北）', annual: { nonAgri: 0.59, agri: 0.991, unknown: 0.751 }, monthly: { nonAgri: M([0.642, 0.413, 0.456, 0.418, 0.335, 0.313, 2.06, 0.489, 0.26, 0.409, 0.569, 0.681]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43170（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43171', label: '流域 43171：東北角（基隆、新北東北）', annual: { nonAgri: 0.375, agri: 0.736, unknown: 0.398 }, monthly: { nonAgri: M([0.212, 0.197, 0.261, 0.319, 0.279, 0.237, 1.83, 0.473, 0.163, 0.155, 0.154, 0.191]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43171（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43443', label: '流域 43443：桃竹苗（新竹、苗栗）', annual: { nonAgri: 10.8, agri: 15.9, unknown: 14.8 }, monthly: { nonAgri: M([7.24, 3.48, 1.48, 0.932, 0.629, 0.502, 3.99, 0.809, 0.527, 3.09, 100, 7.9]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43443（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43445', label: '流域 43445：蘭陽溪流域（宜蘭）', annual: { nonAgri: 0.431, agri: 1.09, unknown: 0.894 }, monthly: { nonAgri: M([0.201, 0.231, 0.34, 0.487, 0.407, 0.36, 2.12, 0.466, 0.148, 0.102, 0.107, 0.156]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43445（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43724', label: '流域 43724：臺中沿海', annual: { nonAgri: 42.9, agri: 30.2, unknown: 32.1 }, monthly: { nonAgri: M([100, 100, 100, 2.12, 0.466, 0.347, 0.505, 0.247, 0.719, 13.1, 100, 100]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43724（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43725', label: '流域 43725：臺中內陸（大甲溪、大肚溪上游）', annual: { nonAgri: 0.789, agri: 0.61, unknown: 0.665 }, monthly: { nonAgri: M([2.03, 1.46, 1.09, 0.782, 0.388, 0.264, 0.371, 0.215, 0.258, 0.328, 0.778, 1.54]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43725（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B43727', label: '流域 43727：花蓮北部', annual: { nonAgri: 0.389, agri: 0.401, unknown: 0.398 }, monthly: { nonAgri: M([0.25, 0.308, 0.673, 0.991, 0.509, 0.381, 0.705, 0.292, 0.145, 0.1, 0.12, 0.196]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 43727（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44005', label: '流域 44005：濁水溪流域（彰化、雲林、南投）', annual: { nonAgri: 7.49, agri: 5.04, unknown: 5.27 }, monthly: { nonAgri: M([14, 16.9, 31.9, 1.97, 0.57, 0.178, 0.173, 0.103, 0.209, 0.764, 8.93, 14.5]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44005（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44008', label: '流域 44008：花蓮', annual: { nonAgri: 0.789, agri: 0.488, unknown: 0.627 }, monthly: { nonAgri: M([1.76, 1.72, 2.43, 0.857, 0.27, 0.17, 0.177, 0.112, 0.159, 0.201, 0.516, 1.14]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44008（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44284', label: '流域 44284：嘉義、臺南沿海', annual: { nonAgri: 27.3, agri: 36.3, unknown: 32.7 }, monthly: { nonAgri: M([100, 100, 100, 9.92, 5, 0.243, 0.246, 0.13, 0.261, 1.47, 6.22, 8.29]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44284（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44286', label: '流域 44286：東海岸（花東縱谷北段）', annual: { nonAgri: 1.0, agri: 0.296, unknown: 0.91 }, monthly: { nonAgri: M([1.75, 2.46, 2.92, 1.65, 0.618, 0.232, 0.248, 0.131, 0.156, 0.194, 0.453, 1.31]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44286（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44567', label: '流域 44567：臺南、高雄（曾文溪、高屏溪下游）', annual: { nonAgri: 17.7, agri: 30, unknown: 25.2 }, monthly: { nonAgri: M([6.82, 100, 100, 3.88, 1.11, 0.161, 0.159, 0.1, 0.179, 0.466, 1.79, 3.43]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44567（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44568', label: '流域 44568：屏東', annual: { nonAgri: 2.9, agri: 1.42, unknown: 1.69 }, monthly: { nonAgri: M([5.87, 7.43, 9.32, 5, 2.39, 0.289, 0.256, 0.15, 0.194, 0.33, 1.08, 2.77]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44568（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44569', label: '流域 44569：臺東', annual: { nonAgri: 2.84, agri: 2.99, unknown: 2.9 }, monthly: { nonAgri: M([2.7, 2.99, 6.04, 13, 5.02, 0.504, 0.402, 0.211, 0.194, 0.242, 0.542, 2.34]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44569（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44848', label: '流域 44848：高雄、屏東沿海', annual: { nonAgri: 42.3, agri: 38.5, unknown: 41.1 }, monthly: { nonAgri: M([100, 100, 76.6, 29.6, 3.48, 0.179, 0.206, 0.119, 0.296, 1.64, 100, 100]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44848（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B44849', label: '流域 44849：屏東南部', annual: { nonAgri: 6.56, agri: 8.59, unknown: 7.54 }, monthly: { nonAgri: M([6.49, 9.81, 34.3, 20.5, 2.95, 0.234, 0.22, 0.119, 0.163, 0.344, 1.13, 2.65]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 44849（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B45130', label: '流域 45130：恆春半島', annual: { nonAgri: 50.4, agri: 49.5, unknown: 50.4 }, monthly: { nonAgri: M([100, 100, 100, 100, 100, 0.544, 0.493, 0.261, 0.378, 0.74, 4.03, 100]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 45130（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    { id: 'B68126', label: '流域 68126：澎湖北部', annual: { nonAgri: 6.0, agri: 4.92, unknown: 5.15 }, monthly: { nonAgri: M([7.86, 19.2, 25.3, 3.56, 2.41, 0.42, 0.828, 0.345, 0.726, 1.96, 3.93, 6.24]) }, note: 'AWARE20_Native_CFs.xlsx native_CFs Basin_ID 68126（WaterGAP 0.5° 流域；地名為依網格位置的對照）' },
    ],
    source: { doc: 'WULCA AWARE2.0 特徵化因子', ref: 'Zenodo 10.5281/zenodo.21708463（v1.0.2）；方法：Seitfudem, Berger, Müller Schmied, Boulay (2025)', url: 'https://zenodo.org/records/21708463',
      note: '邊際 CF（消耗量不足以改變流域可用水量時適用）；WULCA 官方版本頁 https://wulca-waterlca.org/what-is-aware/official-versions/ 稱 AWARE2.0 為現行版本並列於 UNEP GLAM 建議', spec: '§10', specDoc: SPEC_DOC },
  };

  // 外購電力的發電用水係數（L/kWh）。台電自有火力電廠的淡水取水與耗水（自來水＋井水／河川／海淡水），
  // 不含海水直流冷卻（缺水足跡只看淡水，正確排除）、水力水庫蒸發、燃料上游與民營電廠 → 屬下限值。
  // 耗水強度＝耗水量 ÷（取水量 ÷ 公布之用水密集度）：8,258,135 m³ ÷ 136.5 TWh ≈ 0.0605 L/kWh。
  const ELEC_WATER = {
    consumption: 0.0605, withdrawal: 0.0651, unit: 'L/kWh', dataYear: 2025,
    source: { doc: '台灣電力公司《2025 永續報告書》', ref: '3.2.2 促進水資源使用效率·「2023-2025 年台電用水量統計表」（第 90 頁）；SASB IF-EU-140a.1',
      url: 'https://service.taipower.com.tw/csr/download/sustainables/Bd/2025-Taipower-Sustainability-Report-c.pdf',
      note: '2025 年火力：取水 8,884,954 m³、耗水 8,258,135 m³、用水密集度 65.11 公噸/GWh（＝0.0651 L/kWh）；耗水強度由取水量與密集度回推發電量後計算。不含海水冷卻、水力蒸發、燃料上游與民營電廠，為下限值', spec: '§9', specDoc: SPEC_DOC },
  };

  // 醫院預設水質檢測項目組（放流水標準 附表八「醫院、醫事機構」＋「共同適用」；檢測項目依 水污染防治措施及檢測申報管理辦法 附表一（五十三））。
  // 只套用在去向「自設污水處理設施後放流」（排入地面水體）的排放口；納管排入污水下水道的，限值依各地「下水道可容納排入之下水水質標準」，請院方自行設定。
  // schedule：限值自某月起生效（既設設施：氨氮 116-01 起 75、118-01 起 45；自由有效餘氯 116-01 起 2.0）。新設（113-12-18 前未招標）者請依許可證覆寫（氨氮 30）。
  // seasonal：水溫 5～9 月 ≤38℃、10～4 月 ≤35℃（排放於非海洋之地面水體）。
  const LAW_EFF = '放流水標準（113-12-18 環部水字第 1131081975 號令修正）';
  const effB = (ref) => `${LAW_EFF} 第 2 條 附表八 ${ref}`;
  const EFFLUENT_HOSPITAL = [
    { param: 'pH', label: '氫離子濃度指數', unit: '', min: 6.0, max: 9.0, basis: effB('共同適用') },
    { param: '水溫', label: '水溫', unit: '℃', max: 38, seasonal: { months: [5, 6, 7, 8, 9], max: 38, otherMax: 35 }, basis: effB('共同適用（5～9 月 ≤38℃、10～4 月 ≤35℃）') },
    { param: 'BOD', label: '生化需氧量', unit: 'mg/L', max: 30, basis: effB('醫院、醫事機構') },
    { param: 'COD', label: '化學需氧量', unit: 'mg/L', max: 100, basis: effB('醫院、醫事機構') },
    { param: 'SS', label: '懸浮固體', unit: 'mg/L', max: 30, basis: effB('醫院、醫事機構') },
    { param: '大腸桿菌群', label: '大腸桿菌群', unit: 'CFU/100mL', max: 200000, basis: effB('醫院、醫事機構') },
    { param: '自由有效餘氯', label: '自由有效餘氯', unit: 'mg/L', schedule: [{ from: '2027-01', max: 2.0 }], basis: effB('醫院、醫事機構（既設者 116-01-01 起適用；疫情指揮中心開設期間不適用）') },
    { param: '氨氮', label: '氨氮', unit: 'mg/L', schedule: [{ from: '2027-01', max: 75 }, { from: '2029-01', max: 45 }], basis: effB('醫院、醫事機構（自來水水質水量保護區以外；既設者 116-01-01 起 75、118-01-01 起 45；新設 30）') },
  ];
  const EFFLUENT_DEFAULT_DESTINATION = '自設污水處理設施後放流';
  const EFFLUENT_DEFAULT_FREQUENCY = '每半年';
  const EFFLUENT_FREQUENCY_SOURCE = { doc: '水污染防治措施及檢測申報管理辦法（115-04-20 修正）', ref: '第 83 條、第 84 條、附表一（五十三）醫院、醫事機構',
    note: '放流水排入地面水體：須設專責單位或甲級專責人員者每 3 個月（每季）、乙級或免設者每 6 個月；納管者每 6 個月。專責等級依「廢（污）水處理專責單位或人員設置及管理辦法」附表一（一般醫院：2,000 CMD 以上甲級）', spec: '§11', specDoc: SPEC_DOC };

  const XSRC = {
    boundary: s14('5.2.3 系統邊界；附錄 A（組織）', '§9', '間接用水＝外購電力等上游；依範疇設定決定是否納入'),
    indirect: s14('5.2.3 系統邊界；5.3 盤查（間接用水以係數估算）', '§9', '外購蒸汽、藥品耗材等其他上游只登錄、不量化'),
    scarcity: s14('5.4 水足跡衝擊評估（5.4.2 衝擊類別與特徵化模型之選擇、5.4.4 特徵化）；3.3.14 特徵化因子；3.3.17 缺水；3.3.1 註 1（加修飾語「缺水足跡」）', '§10', '特徵化模型：WULCA AWARE2.0。3.x 定義為一手；5.4 子條名取自官方西文譯本目錄，條文內容未取得'),
    quality: { doc: '放流水標準', ref: '第 2 條 附表八（醫院、醫事機構）', law: '環部水字第 1131081975 號令（113-12-18）', spec: '§11', specDoc: SPEC_DOC },
    target: s46('6.2.7 基線；6.3 目標與行動計畫；9.1 監測、量測', '§3.6'),
  };

  // ── 外購電力（間接用水的活動數據）──
  // 電費單：同電號同計費月份取最後送出的那筆（同 src/report-model.js billMonths；test/water.test.js 對兩邊結果）；
  // 沒有電費單時改用電類點位上「連結電號」的累計讀數（kWh／度）用量。
  const KWH_UNITS = ['kwh', '度', '瓩時', '千瓦時'];
  function waterElectricityKwh(inv, { year } = {}) {
    const Y = num(year);
    const points = inv?.points || [];
    const meters = inv?.site?.meters || [];
    const byKey = new Map();
    for (const r of inv?.records || []) {
      const p = points.find((x) => x.code === r.pointCode);
      if (!p) continue;
      for (const it of p.items || []) {
        if (it.type !== 'bill') continue;
        const b = r.values?.[it.id]?.values;
        if (!b) continue;
        const month = /^\d{4}-\d{2}$/.test(String(b.period || '')) ? b.period : r.period;
        const meter = (it.meterId && meters.find((m) => m.id === it.meterId)) || meters.find((m) => m.meterNo && String(m.meterNo) === String(b.meterNo || '')) || null;
        const key = `${meter?.id || `no:${b.meterNo || ''}`}|${month}`;
        const prev = byKey.get(key);
        if (!prev || String(r.at) > String(prev.at)) byKey.set(key, { month, meterNo: meter?.meterNo || b.meterNo || '', bill: b, recordId: r.id, pointCode: r.pointCode, at: r.at, who: r.who || '' });
      }
    }
    const months = Array(12).fill(undefined);
    const rows = [];
    for (const x of byKey.values()) {
      if (!String(x.month).startsWith(`${Y}-`)) continue;
      const xs = ['usePeak', 'useHalfPeak', 'useSatHalfPeak', 'useOffPeak'].map((k) => num(x.bill[k])).filter((v) => v !== undefined);
      if (!xs.length) continue;
      const kwh = xs.reduce((a, b) => a + b, 0);
      const i = Number(x.month.slice(5, 7)) - 1;
      months[i] = (months[i] || 0) + kwh;
      rows.push({ source: '電費單', meterNo: x.meterNo, month: x.month, kwh, recordId: x.recordId, pointCode: x.pointCode, at: x.at, who: x.who });
    }
    let method = rows.length ? 'bill' : null;
    if (!rows.length) {
      for (const p of points) {
        if (p.domain !== 'power') continue;
        for (const it of p.items || []) {
          if (it.type !== 'reading' || !it.meterId || !KWH_UNITS.includes(String(it.unit || '').trim().toLowerCase())) continue;
          for (const r of inv.records || []) {
            if (r.pointCode !== p.code || !String(r.period || '').startsWith(`${Y}-`)) continue;
            const v = num(r.usage?.[it.id]);
            if (v === undefined) continue;
            const i = Number(r.period.slice(5, 7)) - 1;
            months[i] = (months[i] || 0) + v;
            rows.push({ source: '電表讀數', meterNo: meters.find((m) => m.id === it.meterId)?.meterNo || '', month: r.period, kwh: v, recordId: r.id, pointCode: p.code, at: r.at, who: r.who || '' });
          }
        }
      }
      if (rows.length) method = 'reading';
    }
    rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : String(a.meterNo).localeCompare(String(b.meterNo))));
    const have = months.filter((v) => v !== undefined);
    return { year: Y, total: have.length ? r3(have.reduce((a, b) => a + b, 0)) : undefined, months: months.map(r3), monthsCovered: have.length, method, rows };
  }

  const indirectIncluded = (scope) => String(scope?.boundary || '').includes('間接');
  // ── 間接用水（ISO 14046 5.2.3）：外購電力 × 發電用水係數；其他上游（site.waterUpstream）只列出不量化 ──
  function waterIndirect(inv, { year } = {}) {
    const scope = inv?.site?.waterScope || {};
    const e = waterElectricityKwh(inv, { year });
    const custom = num(scope.elecWaterFactor);
    const cL = custom !== undefined ? custom : ELEC_WATER.consumption;
    const wL = custom !== undefined ? custom : ELEC_WATER.withdrawal;
    const f = { consumption: cL, withdrawal: wL, unit: 'L/kWh', custom: custom !== undefined, note: custom !== undefined ? (scope.elecWaterFactorNote || '院方自訂係數') : `${ELEC_WATER.source.doc}（${ELEC_WATER.dataYear} 年資料）` };
    const m3 = (kwh, L) => (kwh === undefined ? undefined : r3(kwh * L / 1000));
    const electricity = {
      kwh: e.total, months: e.months, monthsCovered: e.monthsCovered, method: e.method, rows: e.rows, factor: f,
      withdrawal: m3(e.total, wL), consumption: m3(e.total, cL), consumptionMonths: e.months.map((v) => m3(v, cL)),
      msg: e.total === undefined ? '資料年沒有電費單或電表讀數，算不出外購電力的間接用水'
        : `外購電力 ${nf(e.total, 0)} 度 × ${cL} L/度 ＝ 耗水 ${nf(m3(e.total, cL))} m³${e.monthsCovered < 12 ? `（只有 ${e.monthsCovered} 個月用電資料）` : ''}`,
      source: ELEC_WATER.source,
    };
    const upstream = (Array.isArray(inv?.site?.waterUpstream) ? inv.site.waterUpstream : []).map((u) => ({ ...u, quantified: false }));
    const included = indirectIncluded(scope);
    return { included, electricity, upstream, consumption: included ? electricity.consumption : undefined, source: XSRC.indirect, boundarySource: XSRC.boundary,
      msg: included ? '系統邊界含間接用水：外購電力以係數估算納入；其他上游只登錄不量化' : '系統邊界只含院區直接用水；間接用水僅供參考，不計入合計' };
  }

  // ── 缺水足跡（ISO 14046 5.4；AWARE）──
  function waterAwareRegion(id) { return AWARE.regions.find((r) => r.id === id) || AWARE.regions[0]; }
  function waterScarcity(inv, { year, flows, indirect } = {}) {
    const scope = inv?.site?.waterScope || {};
    const region = waterAwareRegion(scope.awareRegion);
    const useKey = scope.awareUse === '不分用途（unspecified）' ? 'unknown' : 'nonAgri';
    // 縣市層級只有非農業年平均、流域層級的月別 CF 不分用途 → 缺的用途別退回非農業（標 cfFallback）
    const cfFallback = region.annual[useKey] === undefined;
    const cfY = cfFallback ? region.annual.nonAgri : region.annual[useKey];
    const cfM = region.monthly?.[useKey] || region.monthly?.nonAgri || null;
    const F = flows || C.waterFlows(inv, { year });
    const cons = F.consumption;
    let rows = null, direct, method;
    const im = F.intake.months, dm = F.discharge.months;
    const monthlyOk = cons.method === 'balance' && cfM && im.some((v) => v !== undefined) && im.every((v, i) => v === undefined || dm[i] !== undefined);
    if (cons.value === undefined) { direct = undefined; method = null; }
    else if (monthlyOk) {
      rows = im.map((w, i) => {
        if (w === undefined) return { month: i + 1, consumption: undefined, cf: cfM[i], wsf: undefined };
        const c = Math.max(0, w - dm[i]);
        return { month: i + 1, consumption: r3(c), cf: cfM[i], wsf: r3(c * cfM[i]) };
      });
      direct = r3(rows.reduce((a, r) => a + (r.wsf || 0), 0));
      method = 'monthly';
    } else { direct = r3(cons.value * cfY); method = 'annual'; }
    const ind = indirect || waterIndirect(inv, { year });
    const cfInd = AWARE.regions[0].annual.nonAgri;   // 發電廠分布全台：用全國平均（非農業）
    const indValue = ind.electricity.consumption === undefined ? undefined : r3(ind.electricity.consumption * cfInd);
    const total = direct === undefined && (!ind.included || indValue === undefined) ? undefined : r3((direct || 0) + (ind.included ? (indValue || 0) : 0));
    const msgs = [];
    if (cons.value === undefined) msgs.push('沒有消耗量（取水－排放或用水單元估算），直接用水的缺水足跡算不出');
    else msgs.push(`直接用水：消耗 ${nf(cons.value)} m³ × ${method === 'monthly' ? '各月' : `年平均 ${cfY}`} CF ＝ ${nf(direct)} m³ world-eq${cons.method === 'units' ? '（消耗量為估算）' : ''}`);
    if (ind.included) msgs.push(indValue === undefined ? '間接用水（外購電力）沒有用電資料' : `間接用水（外購電力）：耗水 ${nf(ind.electricity.consumption)} m³ × 全國平均 ${cfInd} ＝ ${nf(indValue)} m³ world-eq`);
    return {
      unit: 'm³ world-eq', region: { id: region.id, label: region.label, note: region.note || '' }, use: useKey, useLabel: useKey === 'nonAgri' ? '非農業用水' : '不分用途',
      cfAnnual: cfY, cfMonthly: cfM, cfFallback, method, rows,
      direct: { consumption: cons.value, consumptionMethod: cons.method, value: direct },
      indirect: { included: ind.included, consumption: ind.electricity.consumption, cf: cfInd, value: indValue },
      total, model: { name: AWARE.name, version: AWARE.version, file: AWARE.file, url: AWARE.url, published: AWARE.published },
      msg: msgs.join('；'), level: total === undefined ? 'na' : cons.method === 'balance' ? 'ok' : 'warn', source: XSRC.scarcity, cfSource: AWARE.source,
    };
  }

  // ── 水質：預設項目組（放流水標準）＋依許可證覆寫（site.waterQualityPlan）→ 各排放口實際要測的項目、限值、頻率 ──
  const FREQ_PER_YEAR = { 每月: 12, 每季: 4, 每半年: 2, 每年: 1 };
  function waterQualityRules(inv) {
    const ds = Array.isArray(inv?.site?.waterDischarges) ? inv.site.waterDischarges : [];
    const plan = Array.isArray(inv?.site?.waterQualityPlan) ? inv.site.waterQualityPlan : [];
    const out = [];
    for (const d of ds) {
      const own = plan.filter((p) => p.dischargeId === d.id && p.param);
      if (own.length) {
        for (const p of own) out.push({ dischargeId: d.id, dischargeName: d.name || d.id, param: p.param, unit: p.unit || EFFLUENT_HOSPITAL.find((x) => x.param === p.param)?.unit || '',
          min: num(p.limitMin), max: num(p.limitMax), frequency: p.frequency || '', perYear: FREQ_PER_YEAR[p.frequency], basis: p.basis || '依排放許可（院方設定）', origin: 'permit' });
      } else if (d.destination === EFFLUENT_DEFAULT_DESTINATION) {
        const freq = d.defaultFrequency || EFFLUENT_DEFAULT_FREQUENCY;
        for (const x of EFFLUENT_HOSPITAL) out.push({ dischargeId: d.id, dischargeName: d.name || d.id, param: x.param, label: x.label, unit: x.unit, min: x.min, max: x.max, schedule: x.schedule, seasonal: x.seasonal, frequency: freq, perYear: FREQ_PER_YEAR[freq], basis: x.basis, origin: 'default' });
      }
    }
    return out;
  }
  // 某期別適用的上限：schedule（自某月起生效）、seasonal（依月份）；其餘用 max
  function maxAt(rule, period) {
    const p = String(period || '');
    if (rule.schedule) { const hit = rule.schedule.filter((x) => !p || x.from <= p).pop(); return hit ? hit.max : undefined; }
    if (rule.seasonal && /^\d{4}-\d{2}$/.test(p)) return rule.seasonal.months.includes(Number(p.slice(5, 7))) ? rule.seasonal.max : rule.seasonal.otherMax;
    return rule.max;
  }
  const rocM = (ym) => `${Number(ym.slice(0, 4)) - 1911}-${ym.slice(5, 7)}`;
  // 限值文字（報表、畫面用）：範圍、上限、分期生效、分季節
  function waterQualityLimitText(rule) {
    if (!rule) return '';
    const u = rule.unit ? ` ${rule.unit}` : '';
    if (rule.schedule) return rule.schedule.map((x) => `${rocM(x.from)} 起 ≤ ${x.max}${u}`).join('；');
    if (rule.seasonal) return `5～9 月 ≤ ${rule.seasonal.max}${u}；10～4 月 ≤ ${rule.seasonal.otherMax}${u}`;
    if (rule.min !== undefined && rule.max !== undefined) return `${rule.min}～${rule.max}${u}`;
    if (rule.max !== undefined) return `≤ ${rule.max}${u}`;
    if (rule.min !== undefined) return `≥ ${rule.min}${u}`;
    return '未設限值';
  }
  function waterQualityCheck(rule, value, period) {
    const v = num(value);
    if (!rule || v === undefined) return { exceeded: false };
    rule = { ...rule, max: maxAt(rule, period) };
    const lo = rule.min !== undefined && v < rule.min, hi = rule.max !== undefined && v > rule.max;
    if (!lo && !hi) return { exceeded: false };
    const lim = rule.min !== undefined && rule.max !== undefined ? `${rule.min}～${rule.max}` : hi ? `≤ ${rule.max}` : `≥ ${rule.min}`;
    return { exceeded: true, limit: lim, msg: `「${rule.param}」${v}${rule.unit ? ` ${rule.unit}` : ''} 超出限值 ${lim}${rule.unit ? ` ${rule.unit}` : ''}（${rule.basis}）` };
  }
  const paramOf = (it) => it.waterParam || it.label;
  // 貼紙頁送出時的超標提示（不擋送出）
  function waterQualityWarnings(inv, point, values, period) {
    if (point?.domain !== 'water') return [];
    const rules = waterQualityRules(inv);
    const out = [];
    for (const it of point.items || []) {
      if (it.waterFlow !== 'quality') continue;
      const rule = rules.find((r) => r.param === paramOf(it) && (!it.waterDischargeId || r.dischargeId === it.waterDischargeId));
      const c = waterQualityCheck(rule, values?.[it.id], period);
      if (c.exceeded) out.push(`${c.msg}，請通知污水處理負責人確認並依規定處理`);
    }
    return out;
  }
  function waterQualityAssess(inv, { year } = {}) {
    const Y = num(year);
    const rules = waterQualityRules(inv);
    const items = [];
    for (const p of inv?.points || []) if (p.domain === 'water') for (const it of p.items || []) if (it.waterFlow === 'quality') items.push({ p, it });
    const recs = (inv?.records || []).filter((r) => String(r.period || '').startsWith(`${Y}-`));
    const exceedances = [];
    const rows = rules.map((rule) => {
      const mine = items.filter(({ it }) => paramOf(it) === rule.param && (!it.waterDischargeId || it.waterDischargeId === rule.dischargeId));
      const vals = [];
      for (const { p, it } of mine) for (const r of recs) {
        if (r.pointCode !== p.code) continue;
        const v = num(r.values?.[it.id]);
        if (v === undefined) continue;
        vals.push(v);
        const c = waterQualityCheck(rule, v, r.period);
        if (c.exceeded) exceedances.push({ dischargeName: rule.dischargeName, param: rule.param, value: v, unit: rule.unit, limit: c.limit, period: r.period, at: r.at, who: r.who || '', pointCode: p.code, recordId: r.id, msg: c.msg });
      }
      const n = vals.length;
      return { ...rule, n, linked: mine.length > 0, exceeded: exceedances.filter((x) => x.dischargeName === rule.dischargeName && x.param === rule.param).length,
        shortfall: rule.perYear !== undefined && n < rule.perYear ? rule.perYear - n : 0 };
    });
    const missing = rows.filter((r) => !r.linked);
    return { rules: rows, exceedances, missing, defaults: EFFLUENT_HOSPITAL, source: XSRC.quality, frequencySource: EFFLUENT_FREQUENCY_SOURCE,
      msg: !rules.length ? '沒有需要檢測的排放口（自設污水處理設施後放流才套用預設項目組；納管排入污水下水道的請依納管許可自行設定）'
        : exceedances.length ? `資料年有 ${exceedances.length} 筆抽測超出限值` : '抽測值都在限值內',
      level: !rules.length ? 'na' : exceedances.length ? 'error' : missing.length || rows.some((r) => r.shortfall) ? 'warn' : 'ok' };
  }

  // ── 節水目標達成度（ISO 46001 6.3）──
  // 降幅＝（基線－本年）÷ 基線；達成度＝降幅 ÷ 目標降幅；有目標年時另算「依直線進度本年應達降幅」判斷是否落後。
  function waterTargets(W) {
    const scope = W.scope || {};
    const T = num(scope.targetPct);
    let TY = num(scope.targetYear); if (TY !== undefined && TY < 1911) TY += 1911;
    const BY = W.baseline?.year;
    const list = (W.baseline?.compare || []).map((c) => ({ id: c.id, label: c.label, unit: c.unit, value: c.value, baseline: c.baseline }));
    list.unshift({ id: 'total', label: '總取水量', unit: 'm³/年', value: W.flows.intake.total, baseline: W.baseline?.flows?.intake });
    const pick = scope.targetIndicator ? list.filter((x) => x.label === scope.targetIndicator) : list;
    const expected = T !== undefined && TY !== undefined && BY !== undefined && TY > BY ? round(Math.min(1, Math.max(0, (W.year - BY) / (TY - BY))) * T, 1) : undefined;
    const rows = pick.map((x) => {
      if (T === undefined) return { ...x, level: 'na', msg: '尚未設定節水目標（初始建檔 › 水足跡範疇與基線）' };
      if (x.value === undefined || !x.baseline) return { ...x, targetPct: T, level: 'na', msg: `${x.label}：本年或基線年缺資料，無法計算達成度` };
      const red = round((x.baseline - x.value) / x.baseline * 100, 1);
      const prog = round(red / T * 100, 0);
      const met = red >= T;
      const behind = !met && expected !== undefined && red < expected;
      return { ...x, targetPct: T, targetYear: TY, reductionPct: red, progressPct: prog, expectedPct: expected, met,
        level: met ? 'ok' : behind || red < 0 ? 'warn' : 'ok',
        msg: `${x.label}較基線${red >= 0 ? `降低 ${red}%` : `增加 ${-red}%`}，目標降低 ${T}%${TY ? `（${TY - 1911} 年）` : ''}：達成度 ${Math.max(prog, 0)}%${met ? '，已達成' : expected !== undefined ? `；依進度本年應降 ${expected}%${behind ? '，落後' : '，符合進度'}` : ''}` };
    });
    return { targetPct: T, targetYear: TY, baselineYear: BY, expectedPct: expected, rows, source: XSRC.target };
  }

  // ── 整合 ──
  function waterFootprint(inv, { year } = {}) {
    const W = C.waterInventory(inv, { year });
    const indirect = waterIndirect(inv, { year });
    const scarcity = waterScarcity(inv, { year, flows: W.flows, indirect });
    const quality = waterQualityAssess(inv, { year });
    const targets = waterTargets(W);
    // 延伸項目的資料品質檢查併入完整度（ISO 14046 4.8、5.2.4）
    const checks = W.completeness.checks.slice();
    const add = (key, label, ok, msg, source) => checks.push({ key, label, ok: !!ok, msg, source: source || W.completeness.source });
    if (indirect.included) add('indirect', '間接用水：外購電力 12 個月都有用電資料', indirect.electricity.monthsCovered === 12, `外購電力只有 ${indirect.electricity.monthsCovered} 個月用電資料（電費單）`, XSRC.indirect);
    if (quality.rules.length) {
      const bad = quality.rules.filter((r) => !r.linked || r.shortfall);
      add('qualityFreq', '水質檢測項目依頻率都有抽測', !bad.length, `未達頻率或沒有抽測點位：${bad.map((r) => `${r.dischargeName}·${r.param}`).join('、')}`, quality.frequencySource);
    }
    add('scarcity', '缺水足跡可計算（有消耗量）', scarcity.direct.value !== undefined, scarcity.msg, XSRC.scarcity);
    const okN = checks.filter((c) => c.ok).length;
    const completeness = { ...W.completeness, checks, passed: okN, total: checks.length, pct: round(okN / checks.length * 100, 0) };
    return { ...W, completeness, indirect, scarcity, quality, targets };
  }

  Object.assign(C, {
    waterElectricityKwh, waterIndirect, waterAwareRegion, waterScarcity, waterQualityRules, waterQualityCheck, waterQualityLimitText, waterQualityWarnings, waterQualityAssess, waterTargets, waterFootprint,
    WATER_AWARE: AWARE, WATER_ELEC: ELEC_WATER, WATER_EFFLUENT: { items: EFFLUENT_HOSPITAL, destination: EFFLUENT_DEFAULT_DESTINATION, frequency: EFFLUENT_DEFAULT_FREQUENCY, frequencies: Object.keys(FREQ_PER_YEAR).concat(['其他']), source: XSRC.quality, frequencySource: EFFLUENT_FREQUENCY_SOURCE },
    WATER_X_SOURCES: XSRC,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
