# crinhealthcare.org

國際醫療減碳協會（CRIN Healthcare）官方網站 — 協助醫療院所達成淨零排放的非營利組織。

- 臨時網址: https://yao-care.github.io/crinhealthcare.org/
- 正式網址: https://crinhealthcare.org （DNS 設定後啟用）

## Tech Stack

| 項目 | 技術 |
|------|------|
| Framework | Astro 5 (SSG) |
| Interactive Islands | Svelte 5 |
| Charts | D3 submodules (d3-scale, d3-geo, d3-shape 等) |
| CSS | OKLCH tokens (`src/styles/tokens.css`) |
| Content | Astro Content Collections + Zod validation |
| Search | Pagefind (build-time) |
| OG Images | Satori + Sharp (build-time PNG) |
| Deploy | GitHub Pages via GitHub Actions |
| AI Engine | Anthropic Claude API (claude-sonnet-4) |
| Web Search | Tavily API |
| Image Source | Unsplash API |
| Package Manager | **pnpm** |

> AI agents: read `docs/architecture.md` before modifying code.

## AI Tasks

### 撰寫新聞 (News Automation)

自動從網路搜尋醫療減碳新聞，經 AI 改寫、三角色審核後發布。

```bash
pnpm tsx scripts/generate-news.ts
```

完整 SOP 見 `docs/news_sop.md`。

### 撰寫深度內容 (Insights Automation)

按 policy / guide / benchmark 三類輪替，生成 1500-3000 字深度專題。

```bash
pnpm tsx scripts/generate-insights.ts
```

完整 SOP 見 `docs/insights_sop.md`。

### Seed Scripts

首次部署或重建內容時，使用種子腳本產生初始資料：

```bash
pnpm seed:all           # 執行全部種子腳本
pnpm seed:team          # 團隊成員 → data/team.yaml
pnpm seed:events        # 活動紀錄 → data/events.yaml
pnpm seed:services      # 服務項目 → src/content/services/
pnpm seed:case-studies  # 案例研究 → src/content/case-studies/
pnpm seed:glossary      # 詞彙庫 → src/content/glossary/
pnpm seed:faq           # FAQ → src/content/faq/
```

### 抓取圖片

```bash
pnpm tsx scripts/fetch-images.ts --all                         # 所有 collection
pnpm tsx scripts/fetch-images.ts --collection news --new-only  # 僅新增的新聞
```

## Quick Start

```bash
pnpm install
pnpm dev           # localhost:4321
pnpm build         # build to dist/
pnpm preview       # preview build
```

## Project Structure

```
crinhealthcare.org/
├── AGENTS.md                    # AI agent instructions
├── CLAUDE.md                    # Claude Code project rules
├── README.md                    # This file
├── astro.config.mjs
├── package.json
├── svelte.config.js
├── tsconfig.json
├── .npmrc
├── .gitignore
│
├── .github/
│   ├── dependabot.yml           # npm + GitHub Actions auto-update
│   └── workflows/
│       ├── deploy.yml           # Build + Pagefind + lychee + deploy
│       ├── news-automation.yml  # Cron: daily 06:00 + 18:00 TPE
│       ├── insights-automation.yml  # Cron: Tue/Fri 08:00 TPE
│       ├── glossary-update.yml  # Cron: quarterly (Jan/Apr/Jul/Oct 1st)
│       ├── faq-update.yml       # Cron: quarterly (Jan/Apr/Jul/Oct 15th)
│       ├── case-studies-update.yml  # Cron: annual (Jan 1st)
│       └── content-quality-audit.yml  # Cron: quarterly (20th)
│
├── data/
│   ├── events.yaml              # 活動紀錄（時間軸頁面使用）
│   ├── team.yaml                # 團隊成員（關於頁面使用）
│   ├── news-config.json         # 新聞自動化設定（搜尋、生成、審核）
│   ├── insights-config.json     # 深度內容設定（類別輪替、搜尋策略）
│   ├── image-keywords.json      # 標籤→Unsplash 關鍵字對照
│   ├── processed-sources.json   # 新聞去重紀錄
│   └── processed-insights.json  # 深度內容去重紀錄
│
├── public/
│   ├── favicon.svg
│   └── robots.txt
│
├── scripts/
│   ├── lib/
│   │   ├── ai.ts                # Anthropic Claude API wrapper
│   │   └── fs-utils.ts          # File/YAML write helpers
│   ├── generate-news.ts         # News automation pipeline
│   ├── generate-insights.ts     # Insights automation pipeline
│   ├── fetch-images.ts          # Unsplash image pipeline
│   ├── update-glossary.ts       # Quarterly glossary update
│   ├── update-faq.ts            # Quarterly FAQ update
│   ├── update-case-studies.ts   # Annual case study update
│   ├── audit-content.ts         # Quarterly content quality audit
│   ├── seed-all.ts              # Orchestrator for all seed scripts
│   ├── seed-team.ts
│   ├── seed-events.ts
│   ├── seed-services.ts
│   ├── seed-case-studies.ts
│   ├── seed-glossary.ts
│   └── seed-faq.ts
│
└── src/
    ├── content.config.ts         # Zod schemas for 6 collections
    ├── env.d.ts
    ├── assets/
    │   └── images/
    │       ├── auto/             # Unsplash pipeline 下載的圖片
    │       └── fallback/         # 手動準備的備用圖片
    ├── components/
    │   ├── blocks/               # Page sections (Astro)
    │   │   ├── Hero.astro
    │   │   ├── Nav.astro
    │   │   ├── Footer.astro
    │   │   ├── NewsFeed.astro
    │   │   ├── NewsItem.astro
    │   │   ├── ServiceGrid.astro
    │   │   ├── ServiceCard.astro
    │   │   ├── CtaBanner.astro
    │   │   └── Quote.astro
    │   ├── charts/               # D3 interactive charts (Svelte)
    │   │   ├── CountUp.svelte
    │   │   ├── MetricsDashboard.svelte
    │   │   ├── ResultsMap.svelte
    │   │   └── Timeline.svelte
    │   ├── seo/
    │   │   └── JsonLd.astro
    │   └── ui/                   # Reusable UI components (Astro)
    │       ├── Badge.astro
    │       ├── Button.astro
    │       ├── Card.astro
    │       ├── Icon.astro
    │       └── Tag.astro
    ├── content/
    │   ├── news/                 # Auto-generated news articles
    │   ├── insights/             # Auto-generated deep content
    │   ├── case-studies/         # Seed + annual update
    │   ├── glossary/             # Seed + quarterly update
    │   ├── faq/                  # Seed + quarterly update
    │   └── services/             # Seed, rarely changes
    ├── layouts/
    │   ├── Base.astro            # HTML head, OG meta, skip link
    │   ├── Page.astro            # Nav + Footer wrapper
    │   └── Article.astro         # Article detail layout
    ├── pages/
    │   ├── index.astro           # Homepage
    │   ├── 404.astro
    │   ├── contact.astro
    │   ├── faq.astro
    │   ├── join.astro
    │   ├── search.astro          # Pagefind search page
    │   ├── rss.xml.ts            # Combined RSS feed
    │   ├── llms.txt.ts           # LLM-friendly summary
    │   ├── llms-full.txt.ts      # Full knowledge base for LLMs
    │   ├── about/
    │   │   ├── index.astro
    │   │   ├── team.astro
    │   │   └── timeline.astro
    │   ├── news/
    │   │   ├── index.astro
    │   │   ├── [...slug].astro
    │   │   └── rss.xml.ts
    │   ├── insights/
    │   │   ├── index.astro
    │   │   ├── [...slug].astro
    │   │   └── rss.xml.ts
    │   ├── case-studies/
    │   │   ├── index.astro
    │   │   └── [...slug].astro
    │   ├── glossary/
    │   │   ├── index.astro
    │   │   └── [...term].astro
    │   ├── services/
    │   │   ├── index.astro
    │   │   └── [...slug].astro
    │   ├── results/
    │   │   └── index.astro
    │   ├── tags/
    │   │   └── [tag].astro
    │   └── og/
    │       └── [...slug].png.ts  # OG image auto-generation
    ├── styles/
    │   ├── tokens.css            # OKLCH colour + layout tokens
    │   ├── typography.css
    │   └── global.css
    └── utils/
        ├── metrics.ts            # Build-time metrics aggregation
        ├── og-template.ts        # OG image SVG template
        └── url.ts                # Base URL prefix helper
```

## Deployment

Push to `main` triggers the full pipeline:

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `npx pagefind --site dist` (build search index)
4. `lychee` link check (non-blocking)
5. Upload to GitHub Pages
6. On failure: auto-create GitHub Issue

## Environment Variables

| Variable | Purpose | Required for |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Claude API (content generation) | news, insights, glossary, faq, case-studies, audit |
| `TAVILY_API_KEY` | Web search (source discovery) | news, insights, glossary, faq, case-studies |
| `UNSPLASH_ACCESS_KEY` | Image download | fetch-images |

Set in `.env` for local development, or as GitHub Actions secrets for CI.

## Documentation Index

| Document | Description |
|----------|-------------|
| [AGENTS.md](AGENTS.md) | AI agent instructions |
| [CLAUDE.md](CLAUDE.md) | Claude Code project-specific rules |
| [docs/architecture.md](docs/architecture.md) | Architecture, implemented features, what NOT to rebuild |
| [docs/content-guide.md](docs/content-guide.md) | Content maintenance for all 6 content types |
| [docs/news_sop.md](docs/news_sop.md) | News automation SOP |
| [docs/insights_sop.md](docs/insights_sop.md) | Insights automation SOP |
