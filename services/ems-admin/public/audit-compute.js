// 電力健檢：計算欄位的求值器，以及餵回看板的彙總計算。
//
// ⚠️ 這支檔案刻意放在 public/（不是 src/），因為**伺服器與瀏覽器共用同一份**：
//   - 瀏覽器：<script src="/audit-compute.js"> 一般腳本，掛上 globalThis.EMSAuditCompute
//   - 伺服器：`import '../public/audit-compute.js'` 只求副作用，再讀 globalThis.EMSAuditCompute
// 兩邊同一份程式，計算欄位（合計度數、最高需量、推估年用電量）不可能一邊算一種。
// 沒有 DOM 依賴、沒有 import，動它之前先確認兩邊都還能跑（pnpm test 有蓋）。

(function (g) {
  'use strict';

  const num = (v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // 宣告式計算欄位：{ op, of }。of 的元素若以 '%' 結尾代表該欄是百分比（60 → 0.6）。
  const OPS = {
    sum: (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) : undefined),
    max: (vals) => (vals.length ? Math.max(...vals) : undefined),
    product: (vals, all) => (all ? vals.reduce((a, b) => a * b, 1) : undefined),
  };

  // 回傳計算值；來源欄全空 → undefined（畫面顯示「—」，不寫進資料）
  function evalComputed(spec, row) {
    const op = OPS[spec.op];
    if (!op) return undefined;
    const picked = [];
    let missing = 0;
    for (const ref of spec.of) {
      const pct = ref.endsWith('%');
      const key = pct ? ref.slice(0, -1) : ref;
      const v = num(row?.[key]);
      if (v === undefined) { missing++; continue; }
      picked.push(pct ? v / 100 : v);
    }
    // product 只要缺一項就算不出來（推估年用電量不能把缺的當 1）
    return op(picked, missing === 0);
  }

  // 一整列的計算欄位（依 columns 定義），回傳 { key: value }
  function computeRow(columns, row) {
    const out = {};
    for (const c of columns) if (c.computed) {
      const v = evalComputed(c.computed, row);
      if (v !== undefined) out[c.key] = Math.round(v * 1000) / 1000;
    }
    return out;
  }

  // 直欄合計（表尾那一列）。計算欄位也一起加總，所以要先把每列補算完。
  function computeTotals(columns, rows) {
    const filled = (rows || []).map((r) => ({ ...(r?.values || {}), ...computeRow(columns, r?.values || {}) }));
    const out = {};
    for (const c of columns) {
      if (c.total === 'sum' || c.total === 'max') {
        const vals = filled.map((r) => num(r[c.key])).filter((v) => v !== undefined);
        if (vals.length) out[c.key] = c.total === 'max' ? Math.max(...vals) : Math.round(vals.reduce((a, b) => a + b, 0) * 1000) / 1000;
      }
    }
    return out;
  }

  // ── 餵回看板的彙總 ──
  // 送出填報就自動同步，同步的是「彙總數字」——原始電費單、聯絡人個資、逐筆排放源不上看板。
  // 這裡回傳的每一項都會顯示在公開看板上，新增項目前想清楚。
  function boardSummary(audit) {
    const B = audit?.blocks || {};
    const bills = (B.bills?.rows || []).map((r) => ({ ...(r.values || {}), ...computeRow(BILL_COLS_FOR_SUM, r.values || {}) }));
    const loads = (B.majorLoads?.rows || []).map((r) => ({ ...(r.values || {}), ...computeRow(LOAD_COLS_FOR_SUM, r.values || {}) }));
    const emis = (B.emissions?.rows || []).map((r) => r.values || {});

    const sum = (arr, k) => {
      const vals = arr.map((r) => num(r[k])).filter((v) => v !== undefined);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
    };
    const maxOf = (arr, k) => {
      const vals = arr.map((r) => num(r[k])).filter((v) => v !== undefined);
      return vals.length ? Math.max(...vals) : undefined;
    };

    const months = bills.length;
    const totalKwh = sum(bills, 'useTotal');
    const totalFee = sum(bills, 'feeTotal');
    const maxDemand = maxOf(bills, 'maxDemand');
    const contract = maxOf(bills, 'contractCapacity');
    const co2 = sum(emis, 'emission');
    const loadKwh = sum(loads, 'annualKwh');

    const out = {};
    if (months) out.months = months;
    if (totalKwh !== undefined) out.totalKwh = Math.round(totalKwh);
    if (totalFee !== undefined) out.totalFee = Math.round(totalFee);
    if (maxDemand !== undefined) out.maxDemand = Math.round(maxDemand * 10) / 10;
    if (contract !== undefined) out.contractCapacity = Math.round(contract * 10) / 10;
    if (co2 !== undefined) out.co2e = Math.round(co2 * 100) / 100;
    if (loadKwh !== undefined) out.majorLoadKwh = Math.round(loadKwh);
    if (contract !== undefined && maxDemand !== undefined && contract > 0) {
      out.contractUsePct = Math.round((maxDemand / contract) * 1000) / 10;   // 契約容量利用率
    }
    if (months) {
      out.monthly = bills
        .filter((r) => r.period)
        .sort((a, b) => String(a.period).localeCompare(String(b.period)))
        .map((r) => ({
          period: String(r.period),
          kwh: num(r.useTotal) === undefined ? null : Math.round(num(r.useTotal)),
          fee: num(r.feeTotal) === undefined ? null : Math.round(num(r.feeTotal)),
          demand: num(r.maxDemand) ?? null,
        }));
    }
    return out;
  }

  // boardSummary 要用到的計算欄位定義（與 audit-schema.js 的 columns 同形，只取需要的兩個）
  const BILL_COLS_FOR_SUM = [
    { key: 'useTotal', computed: { op: 'sum', of: ['usePeak', 'useHalfPeak', 'useSatHalfPeak', 'useOffPeak'] } },
    { key: 'maxDemand', computed: { op: 'max', of: ['demandPeak', 'demandHalfPeak', 'demandSatHalfPeak', 'demandOffPeak'] } },
  ];
  const LOAD_COLS_FOR_SUM = [
    { key: 'annualKwh', computed: { op: 'product', of: ['ratedKw', 'qty', 'loadPct%', 'hoursPerYear'] } },
  ];

  g.EMSAuditCompute = { num, evalComputed, computeRow, computeTotals, boardSummary };
})(typeof globalThis !== 'undefined' ? globalThis : this);
