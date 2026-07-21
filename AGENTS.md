# AGENTS.md

Instructions for ChatGPT Codex, Claude Code, and other AI coding agents working on this project.

## Project

**crinhealthcare.org** — 國際醫療減碳協會（CRIN Healthcare）官方網站。
Astro 5 SSG + Svelte 5 islands + D3 submodules + OKLCH CSS tokens.

Package manager: **pnpm** (not npm, not yarn).

## Common AI Tasks

| User says | Command |
|-----------|---------|
| 撰寫新聞 | `pnpm tsx scripts/generate-news.ts` |
| 撰寫深度內容 | `pnpm tsx scripts/generate-insights.ts` |
| 更新詞彙庫 | `pnpm tsx scripts/update-glossary.ts` |
| 更新 FAQ | `pnpm tsx scripts/update-faq.ts` |
| 更新案例 | `pnpm tsx scripts/update-case-studies.ts` |
| 抓取圖片 | `pnpm tsx scripts/fetch-images.ts --all` |
| 內容審核 | `pnpm tsx scripts/audit-content.ts` |
| 產生全部種子資料 | `pnpm seed:all` |

All scripts require environment variables in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
TAVILY_API_KEY=tvly-...
UNSPLASH_ACCESS_KEY=...
```

## Important Rules

### Language

- 所有內容使用**台灣繁體中文**
- 禁止簡體中文或中國用語（例：用「軟體」不用「软件」，用「程式碼」不用「代码」）
- 專業術語附英文原文，例如：碳盤查（Carbon Inventory）

### Dates

- 日期使用台灣時間（UTC+8）
- frontmatter 中的 `publishDate` 格式為 `YYYY-MM-DD`

### Tags

- tags 陣列中的值**禁止含 `/` 字元**
- 從 `data/news-config.json` 的 systemPrompt 中列出的標籤選用

### D3

- **禁止** `import * as d3` 或 `import d3`
- **只能**匯入子模組：`import { scaleLinear } from 'd3-scale'`

### Svelte Islands

- 使用 `client:visible` 或 `client:idle`
- **禁止** `client:load`（影響首屏效能）

### CSS（設計規範 v2，`pnpm build` 前 `scripts/check-design.mjs` 自動守門）

1. font-size 禁用 px（一律 var(--text-*) 階梯；例外清單見 check-design.mjs 的 PX_FONT_EXEMPT）
2. 顏色（hex/rgb/hsl）只准出現在 `src/styles/variables.css`（本站以 OKLCH 為準；favicon 除外）
3. 禁 important 覆寫
4. 禁外部 CDN（字型自託管 @fontsource 或系統堆疊）
5. 統一 css 檔：src/ 下的 .css 只准 `src/styles/{variables,global}.css`，元件樣式寫 scoped `<style>`

### 內容守門（去 AI 味，`pnpm build` 前 `scripts/check-content.mjs` 自動守門）

- 掃 `src/**/*.md(x)`：強 AI 指紋（如「不是X而是Y」「值得注意的是」「隨著…的發展」「至關重要」「研究顯示」等）單一命中即擋 build；軟訊號（賦能/破折號下定義/首先其次最後/拔高收尾…）分四層累積，同一檔跨 ≥3 層升級為擋。
- **預設只掃相對 `origin/main` 的變動檔（grandfather 存量，不追殺既有內容）**；抓不到 git base 時掃 0 檔並 `exit 0`，永不誤擋。
- 產文後自檢：`pnpm check:content`（變動檔）／`pnpm check:content:all`（全站盤點，永不 exit 1）／`node scripts/check-content.mjs <file>`（單檔）。
- 改法見團隊「文案去 AI 味」檢查表：AI 出初稿、人味靠最後 20% 手動微調。

### Content Schema

- Schema 定義在 `src/content.config.ts`
- 修改 schema 前必須先讀取完整檔案，確認 Zod 型別
- 6 個 Content Collections: `news`, `insights`, `case-studies`, `glossary`, `faq`, `services`

### Accessibility

- 每頁只有一個 `<h1>`，標題層級不跳級
- 所有圖片必須有 `alt` text
- 按鈕/連結的觸控目標至少 44px

### General

- 修改前先讀取完整檔案，不要猜測現有內容
- 不要刪除 `.gitkeep` 檔案
- 修改前先分析問題，禁止 trial-and-error

## SOP Documents

- 新聞自動化完整 SOP: `docs/news_sop.md`
- 深度內容自動化完整 SOP: `docs/insights_sop.md`
- 內容維護指南: `docs/content-guide.md`
- 架構文件: `docs/architecture.md`
