# Content Maintenance Guide

crinhealthcare.org 的 6 種 Content Collections 維護指南。

Schema 定義在 `src/content.config.ts`，所有 frontmatter 都經過 Zod 驗證。

---

## 1. News (`src/content/news/`)

### 概述

新聞由 `scripts/generate-news.ts` 自動產生，透過 GitHub Actions 每日兩次執行。也可手動新增或編輯。

### Frontmatter Schema

```yaml
---
title: "國軍桃園總醫院完成第三方碳盤查認證"    # Required, string
source: "環境資訊中心"                          # Required, string
sourceUrl: "https://e-info.org.tw/..."          # Optional, string (URL)
publishDate: 2026-05-12                         # Required, date (YYYY-MM-DD, UTC+8)
tags:                                           # Required, string[]
  - "碳盤查"
  - "國軍醫院"
summary: "國軍桃園總醫院完成 ISO 14064-1..."    # Required, string (50-80 字)
editorComment: "此案例展示..."                   # Optional, string (100-150 字)
editorPick: false                               # Optional, boolean (default: false)
internationalBenchmark:                         # Optional, object
  region: "英國"
  title: "NHS Net Zero"
  summary: "NHS 承諾..."
  sourceUrl: "https://..."
  comparison: "與台灣比較..."
heroImage:                                      # Optional, object
  src: "/src/assets/images/auto/news/example.jpg"
  alt: "Description"
  credit: "Photo by Author on Unsplash"
  unsplashId: "abc123"
draft: false                                    # Optional, boolean (default: false)
---
```

### 檔案命名

自動產生的檔名格式：`radar-YYYY-MM-DD-HH-MM-{hash}.md`

手動新增時建議使用有意義的 slug：`military-hospital-certification.md`

### 新增步驟

1. 在 `src/content/news/` 建立 `.md` 檔案
2. 填寫完整的 frontmatter（至少 title, source, publishDate, tags, summary）
3. 撰寫 Markdown 正文（分 2-3 個 `##` 小節，500-800 字）
4. 執行 `pnpm build` 驗證 schema

### 刪除

直接刪除 `.md` 檔案即可。已處理的來源 URL 記錄在 `data/processed-sources.json`，無需手動清理。

---

## 2. Insights (`src/content/insights/`)

### 概述

深度內容由 `scripts/generate-insights.ts` 自動產生，每週二、五各一篇。按三類輪替：

| category | 中文名稱 | 內容方向 |
|----------|---------|---------|
| `policy` | 政策法規分析 | 深入解析法規條文，提供醫療機構應對建議 |
| `guide` | 實務指引 | 可操作的步驟指引，引用實際案例 |
| `benchmark` | 國際標竿 | 比較國際做法與台灣現況 |

### Frontmatter Schema

```yaml
---
title: "台灣碳費制度對醫療機構的影響分析"       # Required, string (25 字以內)
publishDate: 2026-05-12                         # Required, date
tags:                                           # Required, string[]
  - "碳費"
  - "法規政策"
  - "醫療永續"
summary: "環境部公告碳費收費辦法..."             # Required, string (80-120 字)
category: "policy"                              # Required, enum: policy | guide | benchmark
internationalBenchmark:                         # Optional (benchmark 類建議必填)
  region: "英國"
  title: "NHS Net Zero"
  summary: "..."
  sourceUrl: "https://..."
  comparison: "..."
heroImage:                                      # Optional
  src: "/src/assets/images/auto/insights/example.jpg"
  alt: "Description"
inlineImages: []                                # Optional, array of image objects
draft: false                                    # Optional, boolean (default: false)
---
```

### 檔案命名

自動產生的檔名格式：`insight-{category}-YYYY-MM-DD.md`

### 新增步驟

1. 在 `src/content/insights/` 建立 `.md` 檔案
2. 填寫 frontmatter，category 必須是三選一
3. 撰寫正文（分 4-6 個 `##` 小節，1500-3000 字）
4. benchmark 類文章建議包含 `internationalBenchmark` 區塊
5. 可在正文中交叉引用詞彙表術語（粗體標示）和案例研究

---

## 3. Case Studies (`src/content/case-studies/`)

### 概述

案例研究由 seed 腳本初始建立，每年 1 月 1 日由 `scripts/update-case-studies.ts` 透過 GitHub Actions 更新。更新結果以 PR 形式提交，需人工審核後合併。

### Frontmatter Schema

```yaml
---
hospital:                                       # Required, object
  name: "國軍桃園總醫院"                         # Required, string
  location: "桃園市"                             # Required, string
  system: "military"                            # Required, enum: military | veterans | other
publishDate: 2026-03-20                         # Required, date
tags:                                           # Required, string[]
  - "國軍醫院"
  - "碳盤查"
summary: "國軍桃園總醫院自 112 年起..."          # Required, string
services:                                       # Required, string[] (enum values)
  - "carbon-audit"                              # carbon-audit | ems | esg-report | awards | subsidies | health-taiwan
  - "esg-report"
metrics:                                        # Required, object
  energySavingPercent: 15                        # Optional, number
  subsidyAmount: 500000                          # Optional, number (NTD)
  certifications:                               # Optional, string[] (default: [])
    - "ISO 14064-1 113年度第三方認證"
heroImage:                                      # Optional
  src: "..."
  alt: "..."
draft: false                                    # Optional, boolean
---
```

### hospital.system 值

| 值 | 說明 |
|----|------|
| `military` | 國軍體系醫院 |
| `veterans` | 榮民體系醫院 |
| `other` | 其他醫療機構 |

### services 可用值

| 值 | 服務名稱 |
|----|---------|
| `carbon-audit` | 公益 ISO 14064-1 碳盤查 |
| `ems` | 主迴路能源管理系統 |
| `esg-report` | ESG 永續報告書 |
| `awards` | 永續暨節能減碳獎項 |
| `subsidies` | 政府補助計畫 |
| `health-taiwan` | 健康台灣深耕計畫 |

### 正文結構建議

```markdown
## 合作背景
（醫院介紹、合作起源）

## 面臨挑戰
（推動永續發展的困難）

## 解決方案
（協會提供的服務細節）

## 具體成果
（量化成果、認證、節能數據）
```

---

## 4. Glossary (`src/content/glossary/`)

### 概述

詞彙庫由 seed 腳本初始建立（約 90 個術語），每季由 `scripts/update-glossary.ts` 更新。新增術語時自動配對 Unsplash 圖片。

### Frontmatter Schema

```yaml
---
term: "基準年"                                  # Required, string
definition: "組織設定減碳目標時..."              # Required, string (1-2 句定義)
category: "carbon"                              # Required, enum: carbon | energy | esg | policy | certification
relatedTerms:                                   # Optional, string[] (default: [])
  - "carbon-inventory"                          # 引用其他 glossary entry 的 slug
  - "emission-inventory"
relatedServices:                                # Optional, string[] (default: [])
  - "carbon-audit"                              # 引用 services collection 的 slug
heroImage:                                      # Optional
  src: "..."
  alt: "..."
draft: false                                    # Optional, boolean
---
```

### category 值

| 值 | 中文分類 |
|----|---------|
| `carbon` | 碳管理 |
| `energy` | 能源管理 |
| `esg` | ESG / 永續 |
| `policy` | 法規政策 |
| `certification` | 認證標準 |

### 交叉引用規則

- `relatedTerms`: 填寫其他 glossary entry 的檔名（不含 `.md`）
- `relatedServices`: 填寫 services collection 的檔名（不含 `.md`）
- 正文中提及其他術語時可使用粗體標示

### 新增步驟

1. 在 `src/content/glossary/` 建立 `{slug}.md`
2. slug 用英文 kebab-case（如 `carbon-credit.md`）
3. 填寫 term（中文）、definition、category
4. 選填 relatedTerms 和 relatedServices

---

## 5. FAQ (`src/content/faq/`)

### 概述

FAQ 由 seed 腳本初始建立，每季由 `scripts/update-faq.ts` 更新。FAQ 不需要圖片。

### Frontmatter Schema

```yaml
---
question: "碳盤查涵蓋哪些排放範疇？"            # Required, string
answer: "本會輔導的碳盤查涵蓋範疇一..."         # Required, string (完整回答)
category: "carbon-audit"                        # Required, enum
order: 3                                        # Required, number (同 category 內排序)
---
```

### category 值

| 值 | 中文分類 |
|----|---------|
| `general` | 一般問題 |
| `membership` | 會員相關 |
| `carbon-audit` | 碳盤查 |
| `ems` | 能源管理 |
| `esg` | ESG / 永續 |
| `subsidy` | 補助申請 |

### 排序

`order` 欄位控制同一 category 內的顯示順序，數字越小越前面。

### 正文

FAQ 的正文通常為空（`answer` 已包含完整回答）。若需要更詳細的說明，可在正文中補充。

---

## 6. Services (`src/content/services/`)

### 概述

服務項目由 seed 腳本建立，內容穩定，甚少更動。目前有 6 個服務項目。

### Frontmatter Schema

```yaml
---
name: "公益 ISO 14064-1 碳盤查"                 # Required, string
description: "國際醫療減碳協會依循..."           # Required, string (長描述)
icon: "carbon-audit"                            # Required, string (icon identifier)
features:                                       # Required, array of objects
  - title: "全程免費公益輔導"
    description: "從啟動會議到第三方認證..."
  - title: "第三方查證協助"
    description: "協助院所準備查證文件..."
heroImage:                                      # Optional
  src: "..."
  alt: "..."
---
```

### 現有服務

| 檔案 | 服務名稱 |
|------|---------|
| `carbon-audit.md` | 公益 ISO 14064-1 碳盤查 |
| `ems.md` | 主迴路能源管理系統 |
| `esg-report.md` | ESG 永續報告書輔導 |
| `awards.md` | 永續暨節能減碳獎項申請 |
| `subsidies.md` | 政府補助計畫申請 |
| `health-taiwan.md` | 健康台灣深耕計畫 |

---

## Data Files

### `data/events.yaml`

活動紀錄，用於時間軸頁面和 metrics 統計。

```yaml
- date: 2025-09-05
  title: ISO 14064-1授證儀式
  organization: 國軍臺中總醫院
  attendees: 20          # null if unknown
  type: certification    # seminar | meeting | certification | donation
```

### `data/team.yaml`

團隊成員資料，用於 about/team 頁面。

```yaml
- name: 葉蔭民
  title: 理事長
  role: chairman         # chairman | honorary-chairman | secretary-general | ...
  bio: "現任理事長，長期致力於..."
```

### `data/news-config.json`

新聞自動化設定：搜尋查詢、偏好網域、生成模型、system prompt、reviewer prompt。

### `data/insights-config.json`

深度內容設定：類別輪替、每類搜尋策略、生成模型、system prompt。

### `data/image-keywords.json`

標籤到 Unsplash 搜尋關鍵字的對照表。

### `data/processed-sources.json`

新聞去重紀錄：已處理的來源 URL 列表。

### `data/processed-insights.json`

深度內容去重紀錄：已處理的主題 URL 列表、上次使用的 category。

---

## Tags 規則

- Tags 必須是純文字字串
- **禁止在 tag 中使用 `/` 字元**（會破壞 URL 路由）
- 建議從以下標籤中選用：

> 碳盤查、能源管理、ESG、節能、太陽能、AI治理、碳費、儲能、ISO認證、永續報告、淨零排放、溫室氣體、ESCO、健康台灣、獎項認證、補助申請、碳權、法規政策、國際標竿、碳中和、再生能源、智慧醫院、冰水主機、空調系統、醫療永續、環境部、NHS、國軍醫院、榮民醫院

---

## Image Management

### 自動圖片 (`src/assets/images/auto/`)

- 由 `scripts/fetch-images.ts` 從 Unsplash 下載
- 按 collection 分子目錄：`auto/news/`, `auto/insights/`, `auto/glossary/` 等
- frontmatter 的 `heroImage.unsplashId` 記錄 Unsplash photo ID
- `heroImage.credit` 記錄攝影師歸屬

### 備用圖片 (`src/assets/images/fallback/`)

- 手動準備的備用圖片，當 Unsplash API 不可用時使用
- 目前包含基本的 placeholder 圖片

### 圖片抓取指令

```bash
pnpm tsx scripts/fetch-images.ts --all                         # 全部 collection
pnpm tsx scripts/fetch-images.ts --collection news --new-only  # 僅新新聞
pnpm tsx scripts/fetch-images.ts --collection glossary         # 僅詞彙庫
```

---

## Timezone 規則

- 所有 `publishDate` 使用台灣時間 (UTC+8)
- GitHub Actions cron 使用 UTC 時間，已換算為台灣時間：
  - `0 22 * * *` UTC = 06:00 TPE
  - `0 10 * * *` UTC = 18:00 TPE
  - `0 0 * * 2,5` UTC = Tue/Fri 08:00 TPE

---

## Schema Validation 疑難排解

### 常見錯誤

**`Invalid enum value`**

frontmatter 中的 enum 值不在允許範圍內。檢查 `src/content.config.ts` 的 `z.enum()`。

**`Required at "xxx"`**

缺少必填欄位。確認 frontmatter 包含所有 required 欄位。

**`Expected array, received string`**

`tags` 或其他 array 欄位格式錯誤。確認使用 YAML array 語法。

**`Expected date, received string`**

`publishDate` 格式錯誤。使用 `YYYY-MM-DD` 格式（不加引號）。

### 驗證方式

```bash
pnpm build    # 完整 build 會觸發 schema validation
pnpm check    # Astro 的型別檢查
```
