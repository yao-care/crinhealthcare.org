# 削峰填谷 · 需量控制（803）— 流程與維護

803 電力看板「使用端」下半的即時圖：用**時間電價套利**（離峰充、尖峰放）＋太陽能，把買電從貴時段挪到便宜時段、算出省下的電費。

> **現況＝展示資料（模擬）**：PV 為 803「規劃中」、行動儲電櫃為小型設備，故本圖為 what-if 示意，畫面以 **● 展示資料** 標示。曲線形狀用來說明邏輯，數字非實測。之後可無縫接真值（見 §6）。

---

## 1. 出現在哪、何時顯示

- 位置：電力區塊「⚙️ 使用端」的**下半**（上＝現況分項卡＋現場影像；下＝本圖）。**概念上屬使用端**（需量控制＝管用電需求），不是獨立區塊。
- **只有平時顯示**（`!war`）：時間電價套利是平時經濟調度；戰時使用端維持收治區卡＋B1 圖。
- **只有開了旗標的醫院顯示**：`src/content/hospitals/<id>.json` 頂層 `"peakShave": true`（目前只有 803）。

---

## 2. 檔案地圖

| 檔案 | 角色 |
|------|------|
| `src/utils/peakShaveDemo.ts` | **資料層**：電價/時段、24h profile 產生器、KPI＋省錢公式。可調旋鈕全在這 |
| `src/components/charts/PeakShaveChart.svelte` | **圖表元件**：d3-scale/shape 產 path、Svelte 渲染 SVG；client 時鐘每 5s 更新 |
| `src/components/charts/EmsBoardV2.svelte` | 掛載點（使用端下半 `{#if hospital.peakShave && r.id==='power' && !war}`）＋ 版面 CSS |
| `src/content.config.ts` | schema：`peakShave: z.boolean().default(false)` |
| `src/content/hospitals/803.json` | 開關：`"peakShave": true` |

d3 用站內既有子模組（`d3-scale`/`d3-shape`/`d3-array`…，已在 package.json）。**禁止 `import d3` 或走 CDN**（CSP 只允許 self）。

---

## 3. 圖表元素對照（怎麼讀）

**座標軸**
- 橫軸＝一天 24 小時；紅色虛線「**現在**」＝當下時刻。
- 左縱軸＝功率 kW；**右縱軸＝電池電量 %**（只有電池電量線看右軸）。

**背景四色帶＝台電時間電價**（幾點電貴/便宜）
- 🟩 離峰 $2.54（00–09）／🟨 半尖峰 $5.8（09–16、22–24）／🟥 尖峰 $9.39（16–22）。

**線與堆疊區塊**（下方圖例對應）
- ⬛ **負載**（黑線）＝當下要用多少電。
- ⬜ **台電購電**（灰，最底）＋🟩 **太陽能**（綠）＋🟦 **儲電櫃放電**（藍）由下往上疊，頂到負載線＝「這一刻用電由 買電＋太陽能＋放電 共同供應」。
- ▪️ **電池電量**（藍綠虛線，看右軸）＝SOC，**上升＝充電、下降＝放電**。

**故事**：半夜離峰買便宜電充飽電池（填谷，電量線爬升）→ 白天太陽能扛一部分 → 傍晚尖峰放電扛負載（削峰，灰色買電被壓低、電量線陡降）。

**KPI（前置「今日累計」小標頭）**：今日綠電 / 台電購電 / 離峰充電(00–09) / 尖峰放電(16–22) / 今日省電費。

---

## 4. 電價與時段（TARIFF，在 peakShaveDemo.ts）

台電高壓三段式時間電價，夏月（5/16–10/15）平日：

| 時段 | 時間 | 費率（元/度，示意） | tone |
|------|------|------|------|
| 離峰 | 00–09 | 2.54 | accent（綠） |
| 半尖峰 | 09–16、22–24 | 5.8 | energy（琥珀） |
| 尖峰 | 16–22 | 9.39 | alert（紅） |

> 費率為**以台電 114/10 電價表為基準之示意值**。上線接真值前，依醫院實際**契約種類**核對台電最新電價表，改 `TARIFF[*].price` 即可（時段邊界改 `bandOfHour()`）。

---

## 5. 可調旋鈕（全在 peakShaveDemo.ts）

| 常數 | 意義 | 換真值時 |
|------|------|----------|
| `TARIFF` | 電價費率/時段色 tone | 依實際電價表 |
| `bandOfHour()` | 時段邊界 | 依契約時段 |
| `LOAD[24]` | 醫院逐時負載 kW | 換實際負載曲線 |
| `PV[24]` | 太陽能逐時發電 kW | PV 建置後換實測（現為規劃中示意） |
| `CHG[24]` / `DIS[24]` | 逐時充/放電 kW（離峰充、尖峰放） | 依實際調度策略/EMS 排程 |
| `BATT_KWH` | 儲電櫃可用容量 | 依實機規格 |
| `SOC_MIN` | SOC 下限 | 依實機設定 |

**省錢公式**（`buildPeakShave`）：`省 = Σ(放電×當時電價) − Σ(充電×當時電價) + Σ(PV×當時電價) − 循環損耗(8%)`。

**鐵律沿用**：隨機游走一律**界限夾制**（`jitter`＋`clamp`），否則長時間飄出合理範圍（儲電櫃教訓）。

---

## 6. 接真實資料（三態，比照儲能櫃 essLive）

現在是**純前端模擬**（`buildPeakShave(現在時刻, phase)`）。要接真值時，比照 `src/utils/essLive.svelte.ts` 的三態 poller：

1. 新增 poller（`createPeakShavePoller`）：輪詢橋接 API（例如 `services/ems-bridge` 增 `/api/demand`），回 `loading / live / demo` 三態。
2. `PeakShaveChart` 改由 poller 取資料；失敗或 `source==='sim'` → demo（維持 ● 展示資料）、`live` → 綠「● 即時」。
3. **可部分接真**：`ems-bridge` 已有負載電表（`meters.load`）與電池 SOC/充放（`battery`/`pcs`）→ 負載、電量、充/放可先接真；PV 待建置；台電購電 = 負載 − PV − 放電。
4. **前端零改動原則**：資料格式對齊 `PeakShaveData`，切換來源不動圖。

> 誠實原則：只有 API `source==='live'` 才算即時；`sim`／連線失敗一律展示資料。

---

## 7. 版面 / RWD（EmsBoardV2.svelte）

- **大螢幕 kiosk**：`.v2` 滿版 `100dvh`、單屏不捲動；供/儲/使橫向 % 分欄等比縮放。
- **grid 撐爆坑**：`.bbody` 用 `grid-template-columns: minmax(0,0.85fr) minmax(0,1.6fr)`（**不可**用純 `0.85fr 1.6fr`）＋ `leftcol/usecol/usechart` 補 `min-width:0`。否則使用端塞入本圖後，圖的 min-content 會撐爆欄位、吃掉左欄、圖寬溢出。
- **手機（≤700px）斷點**：改直向堆疊＋整頁可捲動（`.v2 height:auto;overflow:visible`）、`.bbody` 單欄、儲電櫃 `.tgrid` 單欄（解疊字）、`.cards`/`.usechart` 改 `flex:none`（否則塌陷高度下重疊）。**改斷點務必同時用 ~1600px 回歸驗證大螢幕沒壞。**

---

## 8. 已知坑（改動前必讀）

- **Svelte 5 `$effect` 自我重觸發＝無限迴圈**（`effect_update_depth_exceeded`）：effect 內**同步**讀又寫同一 `$state` 會炸，且**整個 island hydration 失敗**（情境切換/輪播全死，SSR 靜態畫面看似正常）。本元件的 client 時鐘：setup 只同步「寫」`nowH`、`phase` 累加放進**非同步** interval callback。**驗互動一定開 console 抓 pageerror ＋ 實測點切換**。
- **Astro content 持久快取**：只改 `content.config.ts` schema、沒改 JSON 檔時，glob loader 不重新解析（新欄位被 strip、畫面吃不到）。改 schema 後 `rm -rf node_modules/.astro` 再 build。zod `.object()` 預設 strip 未知欄位，**新增 JSON 欄位必須同步加進 schema**。

---

## 9. 改完驗證與上線

1. `pnpm build`（必要時先 `rm -rf node_modules/.astro`）→ `pnpm preview --port 4399`。
2. 截圖驗證：大螢幕（~1600）＋手機（390）都看，開 console 確認**零 pageerror**、情境切換正常。
3. `git add … && git commit`（`feat(ems)/fix(ems):` 繁中訊息）→ `git push origin main`。
4. **push 後必確認 GitHub Pages deploy success**（`gh run watch <id> --exit-status`），別只看 push。

關聯：本頁看板整體套用見 [`ems-v2_sop.md`](./ems-v2_sop.md)；儲能櫃 Modbus 三態見 `src/utils/essLive.svelte.ts`。
