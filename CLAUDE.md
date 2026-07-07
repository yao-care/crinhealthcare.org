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
- CSS 色彩用 OKLCH token，不寫死 hex（favicon 除外）
- 中文內容用繁體中文，不用簡體或中國用語
- 每頁只有一個 h1，標題層級不跳級

## EMS 戰情看板維護（803 及各醫院）

要改動 803 電力看板或相關功能時，先讀對應維護文件（別靠記憶）：

| 主題 | 文件 |
|------|------|
| v2 五區塊看板套用到各醫院的 SOP（供/儲/使、看詳情、鐵律：只放真實資料） | [`docs/ems-v2_sop.md`](docs/ems-v2_sop.md) |
| **削峰填谷 · 需量控制**即時圖：流程、圖表判讀、電價/時段、可調旋鈕、接真值(三態)、RWD 與已知坑 | [`docs/ems-peak-shave.md`](docs/ems-peak-shave.md) |
| 儲能櫃 Modbus 即時三態（loading/live/demo）formatter 與 scenario 覆蓋 | `src/utils/essLive.svelte.ts` |

改動後一律：`pnpm build`＋大螢幕/手機截圖驗證＋開 console 確認零 pageerror＋情境切換正常 → commit＋push main → **確認 GitHub Pages deploy success**（`gh run watch`）。
