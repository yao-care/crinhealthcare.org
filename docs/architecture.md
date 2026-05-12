# Architecture

crinhealthcare.org 的技術架構與已實作功能總覽。

> 修改程式碼前請先讀完本文件，避免重建已存在的功能。

## Tech Stack

| 項目 | 技術 | 說明 |
|------|------|------|
| Framework | Astro 5 (SSG) | Static Site Generation, `output: 'static'` |
| Interactive | Svelte 5 | Islands architecture via `@astrojs/svelte` |
| Charts | D3 submodules | d3-scale, d3-geo, d3-shape, d3-selection 等 |
| Colors | OKLCH CSS tokens | 定義在 `src/styles/tokens.css` |
| Content | Astro Content Collections | 6 collections with Zod validation |
| Search | Pagefind | Build-time indexing, `npx pagefind --site dist` |
| OG Images | Satori + Sharp | Build-time SVG-to-PNG (`src/pages/og/[...slug].png.ts`) |
| Deploy | GitHub Pages | `push main` auto-deploy via GitHub Actions |
| AI Engine | Anthropic Claude | claude-sonnet-4 for content generation + review |
| Web Search | Tavily API | Source discovery for news + insights |
| Image Source | Unsplash API | Tag-to-keyword mapping via `data/image-keywords.json` |

## Base URL

目前部署為 GitHub Pages 的 project site，base URL 為 `/crinhealthcare.org`：

```js
// astro.config.mjs
export default defineConfig({
  site: 'https://yao-care.github.io',
  base: '/crinhealthcare.org',
});
```

所有內部連結應使用 `url()` helper（`src/utils/url.ts`）以確保 base path 正確。DNS 設定完成後改回 `base: '/'`。

## Implemented SEO / AEO

以下功能已實作完成，**請勿重建**：

### JSON-LD Structured Data

- `src/components/seo/JsonLd.astro` — 通用 JSON-LD 元件，接受 schema object 或 array
- Homepage: `Organization` + `WebSite` (含 SearchAction)
- 各 collection detail page 可傳入對應的 schema type

### Meta Tags

- `src/layouts/Base.astro` 已包含完整 meta:
  - `<title>`, `<meta description>`, `<link canonical>`
  - Open Graph: `og:type`, `og:url`, `og:title`, `og:description`, `og:image`, `og:locale`, `og:site_name`
  - Twitter Card: `summary_large_image`
  - `<link rel="alternate" type="application/rss+xml">`
  - `<link rel="sitemap">`

### Feeds & Discoverability

- `robots.txt` — `public/robots.txt`
- `sitemap.xml` — `@astrojs/sitemap` integration, auto-generated
- RSS feeds (3):
  - `/rss.xml` — combined news + insights
  - `/news/rss.xml` — news only
  - `/insights/rss.xml` — insights only
- `llms.txt` — LLM-friendly summary (`src/pages/llms.txt.ts`)
- `llms-full.txt` — Full glossary + insights for RAG (`src/pages/llms-full.txt.ts`)

### OG Image Auto-Generation

- `src/pages/og/[...slug].png.ts` — build-time PNG for every content page
- `src/utils/og-template.ts` — SVG template with collection-specific colors
- Covers: news, insights, case-studies, glossary, services + static pages

### Pagefind Search

- Build step: `npx pagefind --site dist` (in `deploy.yml`)
- Search page: `src/pages/search.astro`

## Implemented Content Features

### 6 Content Collections

Schema 定義在 `src/content.config.ts`，使用 Zod validation：

| Collection | Schema Highlights |
|-----------|-------------------|
| `news` | title, source, sourceUrl, publishDate, tags, summary, editorComment, editorPick, internationalBenchmark, heroImage, draft |
| `insights` | title, publishDate, tags, summary, category (policy/guide/benchmark), internationalBenchmark, heroImage, inlineImages, draft |
| `case-studies` | hospital {name, location, system}, publishDate, tags, summary, services, metrics {energySavingPercent, subsidyAmount, certifications}, heroImage, draft |
| `glossary` | term, definition, category (carbon/energy/esg/policy/certification), relatedTerms, relatedServices, heroImage, draft |
| `faq` | question, answer, category (general/membership/carbon-audit/ems/esg/subsidy), order |
| `services` | name, description, icon, features [{title, description}], heroImage |

### Build-time Metrics Aggregation

- `src/utils/metrics.ts` — `aggregateMetrics()` 在 build time 計算：
  - `hospitalCount`: case-studies 數量
  - `totalSubsidy`: 補助金額總和
  - `maxEnergySaving`: 最大節能百分比
  - `eventCount`: events.yaml 活動數量
- 用於首頁 CountUp 元件

### D3 Interactive Charts

| Component | Location | Purpose |
|-----------|----------|---------|
| `CountUp.svelte` | `src/components/charts/` | 首頁 KPI 數字動畫（scroll 觸發） |
| `ResultsMap.svelte` | `src/components/charts/` | 合作醫院台灣地圖（d3-geo） |
| `Timeline.svelte` | `src/components/charts/` | 活動時間軸（about/timeline 頁面） |
| `MetricsDashboard.svelte` | `src/components/charts/` | 進階統計圖表（results 頁面） |

所有 Svelte charts 使用 `client:visible` 載入策略。

## Implemented Accessibility

- `<a href="#main" class="skip-link">跳至主要內容</a>` — skip-to-content link
- Focus ring via CSS
- ARIA attributes on FAQ accordion
- 44px minimum touch target on interactive elements
- `<noscript>` fallback for Svelte charts
- `lang="zh-Hant"` on `<html>`
- Alt text required on all images (schema level enforcement)

## Implemented CI/CD

### 7 GitHub Actions Workflows

| Workflow | File | Schedule | Purpose |
|----------|------|----------|---------|
| Deploy | `deploy.yml` | push main | Build + Pagefind + lychee + deploy |
| News | `news-automation.yml` | daily 06:00/18:00 TPE | Auto-generate news |
| Insights | `insights-automation.yml` | Tue/Fri 08:00 TPE | Auto-generate insights |
| Glossary | `glossary-update.yml` | quarterly (1st) | Update glossary terms |
| FAQ | `faq-update.yml` | quarterly (15th) | Update FAQ entries |
| Case Studies | `case-studies-update.yml` | annual (Jan 1) | Review/update case studies |
| Quality Audit | `content-quality-audit.yml` | quarterly (20th) | Sample + audit content quality |

### Dependabot

- npm packages: weekly update
- GitHub Actions: monthly update
- Config: `.github/dependabot.yml`

### Failure Notification

所有 workflow 包含 `notify-failure` job：失敗時自動建立 GitHub Issue（label: `bug`）。

## Component Overview

### Blocks (Astro)

| Component | File | Purpose |
|-----------|------|---------|
| Hero | `blocks/Hero.astro` | 首頁 hero section |
| Nav | `blocks/Nav.astro` | 導覽列 |
| Footer | `blocks/Footer.astro` | 頁尾 |
| NewsFeed | `blocks/NewsFeed.astro` | 首頁最新動態列表 |
| NewsItem | `blocks/NewsItem.astro` | 單一新聞卡片 |
| ServiceGrid | `blocks/ServiceGrid.astro` | 服務項目網格 |
| ServiceCard | `blocks/ServiceCard.astro` | 單一服務卡片 |
| CtaBanner | `blocks/CtaBanner.astro` | CTA 行動呼籲橫幅 |
| Quote | `blocks/Quote.astro` | 引言區塊 |

### Charts (Svelte)

| Component | File | D3 Modules | Purpose |
|-----------|------|------------|---------|
| CountUp | `charts/CountUp.svelte` | d3-interpolate | KPI 數字滾動動畫 |
| ResultsMap | `charts/ResultsMap.svelte` | d3-geo, d3-selection | 台灣地圖 + 醫院標記 |
| Timeline | `charts/Timeline.svelte` | d3-scale, d3-time-format | 活動時間軸 |
| MetricsDashboard | `charts/MetricsDashboard.svelte` | d3-scale, d3-shape, d3-array | 統計圖表儀表板 |

### SEO

| Component | File | Purpose |
|-----------|------|---------|
| JsonLd | `seo/JsonLd.astro` | JSON-LD structured data injection |

### UI

| Component | File | Purpose |
|-----------|------|---------|
| Badge | `ui/Badge.astro` | 標籤/狀態徽章 |
| Button | `ui/Button.astro` | 按鈕元件 |
| Card | `ui/Card.astro` | 通用卡片 |
| Icon | `ui/Icon.astro` | SVG icon 元件 |
| Tag | `ui/Tag.astro` | 文章標籤 |

### Layouts

| Layout | File | Purpose |
|--------|------|---------|
| Base | `layouts/Base.astro` | HTML head, meta, fonts, skip link |
| Page | `layouts/Page.astro` | Nav + main + Footer wrapper |
| Article | `layouts/Article.astro` | Article detail page layout |

### Utilities

| Utility | File | Purpose |
|---------|------|---------|
| metrics | `utils/metrics.ts` | Build-time metrics from case-studies + events |
| og-template | `utils/og-template.ts` | OG image SVG generation |
| url | `utils/url.ts` | Base URL prefix helper |

## Path Aliases

Defined in `tsconfig.json`:

```json
{
  "@/*": ["src/*"],
  "@components/*": ["src/components/*"],
  "@layouts/*": ["src/layouts/*"],
  "@utils/*": ["src/utils/*"]
}
```
