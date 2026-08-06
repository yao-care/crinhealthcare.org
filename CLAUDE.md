# crinhealthcare.org

國際醫療減碳協會官方網站。

## 技術棧

- Astro 5 (SSG) + Svelte 5 islands + D3 submodules
- pnpm, TypeScript, OKLCH CSS tokens
- GitHub Pages via GitHub Actions

## 規則

- D3 只能匯入子模組（d3-scale, d3-geo 等），禁止 `import * as d3` 或 `import d3`
- Svelte islands 用 `client:visible` 或 `client:idle`，不用 `client:load`
- 所有圖片必須有 alt text
- CSS 設計規範 v2（`pnpm build` 前 `scripts/check-design.mjs` 自動守門，違規直接 fail）：
  1. font-size 禁用 px，一律 var(--text-*) 階梯（遞延例外：PeakShaveChart.svelte 的 SVG 座標系字級，見腳本 PX_FONT_EXEMPT TODO）
  2. 顏色（hex/rgb/hsl）只准出現在該掃描範圍的 token 檔（OKLCH 為準；favicon 除外）
  3. 禁 important 覆寫
  4. 禁外部 CDN（字型自託管 @fontsource 或系統堆疊）
  5. 統一 css 檔：src/ 下的 .css 只准 `src/styles/{variables,global}.css`，元件樣式寫 Astro/Svelte scoped `<style>`
  6. **字級階梯下限 ≥18px**（2026-08-06 起全站生效）：`--text-*` 的值一律 ≥`1.125rem`，`clamp()` 以最小值計。守門**掃每一個檔案**，不是只掃 token 檔——元件裡自建一套 `--text-*` 覆寫全站階梯同樣算違規。
  - **掃描範圍有兩塊**：`src/`（token 檔＝`src/styles/variables.css`）與 `services/ems-admin/public/`（token 檔＝`public/tokens.css`，白名單只准 `tokens.css`／`style.css`）。ems-admin 不進 astro build，2026-08-06 前不在守門範圍，整份 style.css 已漂成 hex 色＋px 字級。
  - ⚠️ **唯一豁免：`EmsBoardV2.svelte`**（kiosk 看板私有階梯 8–26px）。它是 `height:100dvh + overflow:hidden` 的一屏資料牆，實測改吃 18px 階梯後 1920×1080 內容需 1414px、放寬成可捲動又會讓 SOC 量表溢出到下一區塊。「≥18px」與「一屏不捲動」在 1080p 互斥，要合規得重新設計看板密度＝產品決策，**已回報待拍板**。腳本內 `LADDER_FLOOR_EXEMPT` 有完整量測紀錄，**禁再擴充**。
  - 🔴 **`html` 的 font-size 不准寫成 `var(--text-*)`**：階梯全是 rem，根字級一旦不是預設 16px，整座階梯會再乘一次（2026-08-06 抓到的舊坑：名目 18px 實際渲染 24.75px）。內文字級寫在 `body`。
- 內容守門（去 AI 味，`pnpm build` 前 `scripts/check-content.mjs` 自動守門，設計守門之後、`astro build` 之前）：掃 `src/**/*.md(x)`，強 AI 指紋單一命中即擋、軟訊號跨 ≥3 層升級擋；**預設只掃相對 `origin/main` 變動檔（grandfather 存量）**，抓不到 git base 時掃 0 檔 exit 0。自檢：`pnpm check:content`／`pnpm check:content:all`（全站盤點不擋）／`node scripts/check-content.mjs <file>`。改法見「文案去 AI 味」檢查表。
- 中文內容用繁體中文，不用簡體或中國用語
- 每頁只有一個 h1，標題層級不跳級

## EMS 戰情看板維護（803 及各醫院）

要改動 803 電力看板或相關功能時，先讀對應維護文件（別靠記憶）：

| 主題 | 文件 |
|------|------|
| v2 五區塊看板套用到各醫院的 SOP（供/儲/使、看詳情、鐵律：只放真實資料） | [`docs/ems-v2_sop.md`](docs/ems-v2_sop.md) |
| **削峰填谷 · 需量控制**即時圖：流程、圖表判讀、電價/時段、可調旋鈕、接真值(三態)、RWD 與已知坑 | [`docs/ems-peak-shave.md`](docs/ems-peak-shave.md) |
| 儲能櫃 Modbus 即時三態（loading/live/demo）formatter 與 scenario 覆蓋 | `src/utils/essLive.svelte.ts` |
| **離線單檔看板**（給客戶一個 HTML、雙擊即看、零網路）：`pnpm build:offline <醫院>` | [`docs/offline-bundle.md`](docs/offline-bundle.md) |
| **804 戰時＝B1 平面配置圖＋行動儲電櫃供電**（整頁取代五區塊）：分區幾何、配色語彙、oklab/cqw 兩個坑、供電數字的推算依據 | [`docs/ems-804-war-plan.md`](docs/ems-804-war-plan.md) |

改動後一律：`pnpm build`＋大螢幕/手機截圖驗證＋開 console 確認零 pageerror＋情境切換正常 → commit＋push main → **確認 GitHub Pages deploy success**（`gh run watch`）。
