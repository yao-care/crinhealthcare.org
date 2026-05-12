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
