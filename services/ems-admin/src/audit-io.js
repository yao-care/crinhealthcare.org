// 能源診斷問卷的 xlsx ↔ JSON 雙向轉換。
//
// 匯入：讀上傳的活頁簿 → 產出 audit 物件（放進院所 JSON 的 audit 區塊）
// 匯出：拿「原始範本」＋ audit 物件 → 寫回同座標，交出去的格式與原版逐格相同
//
// 兩個方向都以 audit-fields.js 為唯一依據，所以不可能出現「匯入吃這格、匯出寫那格」。
import { readWorkbook, patchWorkbook, toRef } from './xlsx.js';
import {
  SHEET_A, SHEET_E, SHEET_P,
  CHILLER_FIELDS, CHILLER_FIRST_COL, CHILLER_COL_SPAN, CHILLER_MAX,
  INVENTORY_FIELDS, INVENTORY_FIRST_ROW, INVENTORY_MAX,
  POWER_HEADER, MONTH_FIELDS, MONTH_FIRST_ROW, MONTH_COUNT,
  fromCell, toCell,
} from './audit-fields.js';

const chillerCol = (i) => CHILLER_FIRST_COL + i * CHILLER_COL_SPAN;
const isEmpty = (o) => Object.values(o).every((v) => v === undefined);

// ── 匯入 ──
// 回傳 { audit, report }。report 給院方在送出前核對「解析到什麼」，
// 刻意不直接寫檔——解析結果先讓人看過再送出，是這個流程最重要的保護。
export function importAudit(buf) {
  const { sheets } = readWorkbook(buf);
  const missing = [SHEET_A, SHEET_E, SHEET_P].filter((s) => !sheets.has(s));
  if (missing.length) {
    const err = new Error(`上傳的檔案缺少工作表：${missing.join('、')}`);
    err.code = 'sheet_missing';
    throw err;
  }

  const warn = [];
  const cellOf = (sheet, ref) => sheets.get(sheet).cells.get(ref);

  // 表A：每台一個欄區塊
  const chillers = [];
  for (let i = 0; i < CHILLER_MAX; i++) {
    const col = chillerCol(i);
    const item = {};
    for (const f of CHILLER_FIELDS) {
      const v = fromCell(cellOf(SHEET_A, toRef(col, f.row)), f.type);
      if (v !== undefined) item[f.key] = v;
    }
    if (!isEmpty(item)) chillers.push(item);
  }

  // 表E：一列一筆
  const inventory = [];
  for (let r = 0; r < INVENTORY_MAX; r++) {
    const row = INVENTORY_FIRST_ROW + r;
    const item = {};
    for (const f of INVENTORY_FIELDS) {
      const v = fromCell(cellOf(SHEET_E, toRef(f.col, row)), f.type);
      if (v !== undefined) item[f.key] = v;
    }
    if (!isEmpty(item)) inventory.push(item);
  }

  // 表P：表頭 ＋ 12 個月
  const power = {};
  for (const f of POWER_HEADER) {
    const v = fromCell(cellOf(SHEET_P, f.cell), f.type);
    if (v !== undefined) power[f.key] = v;
  }
  const months = [];
  for (let m = 0; m < MONTH_COUNT; m++) {
    const row = MONTH_FIRST_ROW + m;
    const item = { month: m + 1 };
    for (const f of MONTH_FIELDS) {
      const v = fromCell(cellOf(SHEET_P, toRef(f.col, row)), f.type);
      if (v !== undefined) item[f.key] = v;
    }
    // ⚠️ 空白範本的「轉供度數」四欄預填了 0（12 個月都有）。若照單全收，
    // 任何人上傳沒填完的檔案都會得到 12 列全零的月份，維護表單就多出 12 列雜訊。
    // 判準改成「整月每個值都是 0 或空 → 視為未填」；真的有資料的月份不可能連
    // 總電費與契約容量都是 0，所以不會誤刪。
    if (MONTH_FIELDS.some((f) => item[f.key] !== undefined && item[f.key] !== 0)) months.push(item);
  }
  if (months.length) power.months = months;

  const audit = {};
  if (chillers.length) audit.chillers = chillers;
  if (inventory.length) audit.inventory = inventory;
  if (Object.keys(power).length) audit.power = power;

  // 必填漏填只警告不擋——院方常常是分次填完的，擋下來反而逼人填假資料
  for (const [idx, c] of chillers.entries())
    for (const f of CHILLER_FIELDS) if (f.required && c[f.key] === undefined) warn.push(`表A 第 ${idx + 1} 台缺「${f.label}」`);
  for (const [idx, c] of inventory.entries())
    for (const f of INVENTORY_FIELDS) if (f.required && c[f.key] === undefined) warn.push(`表E 第 ${idx + 1} 筆缺「${f.label}」`);
  for (const f of POWER_HEADER) if (f.required && power[f.key] === undefined) warn.push(`表P 缺「${f.label}」`);

  return {
    audit,
    report: {
      chillers: chillers.length,
      inventory: inventory.length,
      months: power.months ? power.months.filter((m) => Object.keys(m).length > 1).length : 0,
      warnings: warn,
    },
  };
}

// ── 匯出 ──
// templateBuf 必須是「原始空白範本」：我們只換值，其餘位元組原樣搬，
// 所以合併格/資料驗證/公式/列印範圍都會原封不動地留著。
export function exportAudit(templateBuf, audit = {}) {
  const pA = new Map(), pE = new Map(), pP = new Map();

  (audit.chillers ?? []).slice(0, CHILLER_MAX).forEach((item, i) => {
    const col = chillerCol(i);
    for (const f of CHILLER_FIELDS) pA.set(toRef(col, f.row), toCell(item[f.key], f.type));
  });

  (audit.inventory ?? []).slice(0, INVENTORY_MAX).forEach((item, r) => {
    const row = INVENTORY_FIRST_ROW + r;
    for (const f of INVENTORY_FIELDS) pE.set(toRef(f.col, row), toCell(item[f.key], f.type));
  });

  const power = audit.power ?? {};
  for (const f of POWER_HEADER) pP.set(f.cell, toCell(power[f.key], f.type));
  (power.months ?? []).forEach((item) => {
    const m = Number(item?.month);
    if (!(m >= 1 && m <= MONTH_COUNT)) return;
    const row = MONTH_FIRST_ROW + m - 1;
    for (const f of MONTH_FIELDS) pP.set(toRef(f.col, row), toCell(item[f.key], f.type));
  });

  return patchWorkbook(templateBuf, new Map([[SHEET_A, pA], [SHEET_E, pE], [SHEET_P, pP]]));
}
