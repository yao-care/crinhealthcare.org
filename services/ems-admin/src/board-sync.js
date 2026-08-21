// 填報資料 → 看板：送出填報時自動同步（業主 2026-08-21 指示：不要獨立的「發布」動作）。
//
// 同步的是**彙總數字**，不是原始資料。這條界線是刻意的，而且是這個服務唯一會把東西
// 推上公開 repo 的地方：
//   會上看板 → 用電度數、電費、需量、契約容量、排放量這類每月/年度的彙總
//   不會上看板 → 聯絡人姓名電話 email（附件一）、電費單原始檔、逐筆排放源清單、營運事件內文
// 新增同步項目前先問一句：這個數字公開在 crinhealthcare.org 上沒問題嗎？
//
// 寫入範圍限制在 esgPanels 裡 id 以 `power-audit` 開頭的面板：整批換掉，
// 其他面板與院方手動維護的 report/env.carbon 一律不碰（那些是人寫的內容，覆蓋掉就回不來了）。
import '../public/audit-compute.js';   // 副作用：掛上 globalThis.EMSAuditCompute（與瀏覽器共用同一份計算）
import { readHospital, saveHospital, hospitalExists } from './repo.js';
import { validateHospital } from './schema.js';

const { boardSummary } = globalThis.EMSAuditCompute;

export const PANEL_PREFIX = 'power-audit';

const nf = (v, digits = 0) => (v === undefined || v === null ? '' : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits }));
const ymLabel = (p) => { const m = /^(\d{4})-(\d{2})$/.exec(String(p || '')); return m ? `${m[1].slice(2)}/${m[2]}` : String(p || ''); };

// 由填報資料產生要放上看板的面板（沒有可同步的數字就回空陣列 → 面板整個移除）
export function buildPanels(audit) {
  const s = boardSummary(audit);
  const panels = [];

  const rows = [];
  const add = (label, value, unit) => { if (value !== undefined && value !== '') rows.push({ label, value: `${value}${unit || ''}`, cells: [], pending: false }); };
  add('填報期間', s.months ? `${s.months} 個月` : undefined);
  add('總用電量', nf(s.totalKwh), ' 度');
  add('總電費', nf(s.totalFee), ' 元');
  add('最高需量', nf(s.maxDemand, 1), ' kW');
  add('經常契約容量', nf(s.contractCapacity, 1), ' kW');
  add('契約容量利用率', s.contractUsePct === undefined ? undefined : nf(s.contractUsePct, 1), '%');
  add('排放量（填報期間）', nf(s.co2e, 2), ' tCO₂e');
  add('重大設備推估年用電', nf(s.majorLoadKwh), ' 度');

  if (rows.length) {
    panels.push({
      id: `${PANEL_PREFIX}-summary`, icon: '🔌', title: '電力健檢｜填報彙總',
      compare: false, cols: [], rows,
    });
  }

  if (s.monthly?.length) {
    panels.push({
      id: `${PANEL_PREFIX}-monthly`, icon: '📈', title: '電力健檢｜月別用電',
      compare: true,
      cols: s.monthly.map((m) => ymLabel(m.period)),
      rows: [
        { label: '用電度數（度）', value: '', cells: s.monthly.map((m) => nf(m.kwh)), pending: false },
        { label: '電費（元）', value: '', cells: s.monthly.map((m) => nf(m.fee)), pending: false },
        { label: '最高需量（kW）', value: '', cells: s.monthly.map((m) => nf(m.demand, 1)), pending: false },
      ],
    });
  }
  return panels;
}

// 把面板併進院所 JSON（純函式，好測）。回傳新的物件，不改原本那個。
export function mergePanels(hospital, panels) {
  const kept = (hospital.esgPanels || []).filter((p) => !String(p?.id || '').startsWith(PANEL_PREFIX));
  const next = { ...hospital };
  const merged = [...kept, ...panels];
  if (merged.length) next.esgPanels = merged;
  else delete next.esgPanels;
  return next;
}

// 送出填報後呼叫。看板同步失敗**不該讓填報失敗**——填報資料已經存好了，
// 同步只是衍生動作，所以這裡把錯誤包成結果回傳，不往上丟。
export async function syncToBoard(hid, audit, meta) {
  const panels = buildPanels(audit);
  try {
    if (!(await hospitalExists(hid))) return { ok: false, skipped: true, reason: 'hospital_not_found' };
    const hospital = await readHospital(hid);
    const next = mergePanels(hospital, panels);
    if (JSON.stringify(next) === JSON.stringify(hospital)) {
      return { ok: true, unchanged: true, panels: panels.length };
    }
    const v = validateHospital(next);
    if (!v.ok) return { ok: false, reason: 'validation', errors: v.errors.slice(0, 5) };
    const r = await saveHospital(hid, next, { who: `${meta?.who || 'ems-admin'}·健檢同步` });
    return { ok: true, panels: panels.length, ...r };
  } catch (e) {
    return { ok: false, reason: 'sync_failed', message: String(e.message || e) };
  }
}
