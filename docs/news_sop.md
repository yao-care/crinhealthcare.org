# News Automation SOP

crinhealthcare.org 新聞自動化完整作業流程。

---

## 1. Schedule & Trigger

### GitHub Actions 排程

- **Workflow**: `.github/workflows/news-automation.yml`
- **Cron**: `0 22,10 * * *` (UTC) = 每日台灣時間 06:00、18:00
- **Manual dispatch**: 可從 GitHub Actions 頁面手動觸發

### 本機執行

```bash
# 確認 .env 已設定 ANTHROPIC_API_KEY, TAVILY_API_KEY, UNSPLASH_ACCESS_KEY
pnpm tsx scripts/generate-news.ts
```

---

## 2. Pipeline Overview

```
搜尋 (Tavily) → 去重 (processed-sources.json) → 分群 → 生成 (Claude) → 審核 (reviewer loop) → 儲存 → 抓圖 (Unsplash) → commit/push
```

### 完整流程

1. 載入 `data/news-config.json` 設定
2. 使用 8 組搜尋查詢透過 Tavily API 搜尋新聞來源
3. 與 `data/processed-sources.json` 比對去重
4. 依標題關鍵字重疊度分群（至少 2 個共同詞）
5. 每組來源呼叫 Claude API 生成新聞稿
6. 生成後由 Claude 以三角色審核員檢查
7. 審核通過或達到最大迭代次數後儲存為 Markdown
8. 抓取 Unsplash 圖片配對新文章
9. commit + push（CI 環境），或 PR（未收斂的 drafts）

---

## 3. Data Sources

### 搜尋查詢（8 組）

定義在 `data/news-config.json` 的 `webSearch.queries`：

1. `台灣醫療機構碳盤查 最新`
2. `醫院 ESG 永續報告 台灣`
3. `環境部 碳費 醫療`
4. `台灣醫院 節能 ESCO`
5. `Healthcare carbon reduction Taiwan`
6. `Hospital sustainability Asia Pacific`
7. `醫療減碳 國際趨勢`
8. `台灣 溫室氣體 醫療院所`

### 偏好網域

優先從以下網域搜尋結果：

- `moeenv.gov.tw` (環境部)
- `mohw.gov.tw` (衛福部)
- `cna.com.tw` (中央社)
- `udn.com` (聯合新聞)
- `ltn.com.tw` (自由時報)
- `nhi.gov.tw` (健保署)
- `tgpf.org.tw` (台灣綠色生產力基金會)
- `hcwh.org` (Health Care Without Harm)
- `who.int` (WHO)
- `england.nhs.uk` (NHS England)

### API 參數

- `search_depth`: `basic`
- `max_results`: 5 per query
- 每次查詢間隔 2 秒（rate limit）

---

## 4. Dedup Mechanism

### 檔案

`data/processed-sources.json`

```json
{
  "processedUrls": ["https://...", "https://..."],
  "lastRun": "2026-05-12T10:00:00.000Z"
}
```

### 規則

- 搜尋結果的 URL 與 `processedUrls` 比對
- 已處理過的 URL 直接跳過
- 每次 run 結束後，所有處理過的組別中的 URL 都會加入記錄（含生成失敗的）
- 若去重後無新結果，pipeline 正常結束（不報錯）

---

## 5. Scoring & Grouping

### 分群規則

`groupResults()` 函式將搜尋結果按標題相關性分群：

1. 將每個結果的標題拆解為詞（長度 > 2 字元）
2. 計算兩個結果間的共同詞數量
3. 共同詞 >= 2 個即歸為同一組
4. 每組以第一個結果的標題作為 topic

### 生成限制

- 每次 run 最多生成 **3 篇**文章（控制 API 成本）
- 超出的組別留待下次 run 處理

---

## 6. Article Format

### Frontmatter

```yaml
---
title: "標題（20 字以內）"
source: "來源名稱"
sourceUrl: "主要來源網址"
publishDate: 2026-05-12
tags: ["碳盤查", "國軍醫院"]
summary: "50-80字摘要"
editorComment: "100-150字編輯評論"
editorPick: false
draft: false
---
```

### 正文結構

- 分 2-3 個小節，每節以 `##` 標題開頭
- 500-800 字
- 專業術語附英文原文
- 數據標註出處

### 檔名格式

`radar-{YYYY}-{MM}-{DD}-{HH}-{MM}-{hash}.md`

其中 `hash` 是 topic 字串的簡單雜湊（4 字元 base36）。

---

## 7. Review Mechanism

### 三角色審核

每篇文章生成後，由同一個 Claude API 呼叫模擬三角色審核：

| 角色 | 檢查重點 |
|------|---------|
| 醫療減碳專家 | 碳盤查/能源管理/ESG 技術描述是否正確 |
| 政策法規編輯 | 法規引用是否正確、政策解讀是否有偏差 |
| 事實查核編輯 | 數據出處是否明確、連結是否有效、是否有幻覺內容 |

### 收斂規則

- 審核回覆包含 `APPROVED` → 通過，儲存為正式文章
- 審核有修改建議 → 送回生成模型修改，重新審核
- 最大迭代次數：**3 次**（定義在 `data/news-config.json` 的 `generation.maxReviewerIterations`）
- 3 次未收斂 → 標記為 `draft: true`

### Draft 處理

在 CI 環境中，若有 draft：

1. 建立新分支 `news/review-{YYYYMMDD-HHMM}`
2. commit draft 文章
3. 建立 PR，標題：`News: reviewer 未收斂，需人工審核 {date}`
4. PR 帶有 `needs-review` label

---

## 8. Image Matching

### Unsplash Pipeline

新聞生成後，workflow 接著執行：

```bash
pnpm tsx scripts/fetch-images.ts --collection news --new-only
```

### 匹配流程

1. 讀取新文章的 `tags`
2. 從 `data/image-keywords.json` 查找對應的英文搜尋關鍵字
3. 呼叫 Unsplash API 搜尋
4. 下載圖片到 `src/assets/images/auto/news/`
5. 更新文章 frontmatter 的 `heroImage` 欄位

### 圖片歸屬

每張 Unsplash 圖片必須保留：
- `unsplashId`: photo ID
- `credit`: 攝影師歸屬文字

---

## 9. Daily Operations

### 例行檢查

1. 檢查 GitHub Actions 的 News Automation run 是否成功
2. 若有 PR（`needs-review` label），進行人工審核
3. 審核通過的 PR 合併到 main（自動觸發部署）

### 手動觸發

GitHub Actions > News Automation > Run workflow > Run workflow

### 手動編輯

1. 在 `src/content/news/` 找到對應文章
2. 修改 frontmatter 或正文
3. 若要將 draft 改為正式：`draft: false`
4. commit + push

### 刪除文章

直接刪除檔案即可。`processed-sources.json` 中的 URL 無需清理。

---

## 10. Content Rules

### 語言規則

- 使用**繁體中文**（台灣用語）
- 禁止簡體中文或中國用語
- 專業術語附英文原文：碳盤查（Carbon Inventory）
- 數據必須標註出處

### 禁止事項

- 不使用「碳达峰」（用「碳達峰」）
- 不使用「软件」（用「軟體」）
- 不使用「数据」（用「資料」或「數據」）
- 不使用中國特有政策用語

### 標籤規則

- 從預定義標籤中選擇 2-4 個
- tags 禁止含 `/` 字元
- 完整標籤清單見 `data/news-config.json` 的 systemPrompt

### 引用規則

- 數據需標明來源機構和年份
- 外部連結使用原始 URL
- 不引用付費牆內容的全文

---

## 11. Related Files

| 檔案 | 用途 |
|------|------|
| `scripts/generate-news.ts` | 新聞生成主程式 |
| `scripts/fetch-images.ts` | Unsplash 圖片抓取 |
| `scripts/lib/ai.ts` | Claude API wrapper |
| `data/news-config.json` | 搜尋查詢 + 生成設定 + prompts |
| `data/processed-sources.json` | 去重紀錄 |
| `data/image-keywords.json` | 標籤→圖片關鍵字對照 |
| `.github/workflows/news-automation.yml` | CI workflow |
| `src/content/news/` | 文章輸出目錄 |
| `src/content.config.ts` | Schema 定義 |

---

## 12. Troubleshooting

### `[warn] TAVILY_API_KEY is not set`

Tavily API key 未設定。本機：檢查 `.env`。CI：檢查 GitHub Secrets。

### `[warn] ANTHROPIC_API_KEY is not set`

Anthropic API key 未設定。同上。

### `[warn] Tavily HTTP 429`

Tavily API rate limit。每次查詢間有 2 秒延遲，若仍觸發 429，降低 `maxResultsPerQuery` 或減少查詢數量。

### `[done] No new sources found`

所有搜尋結果都已在 `processed-sources.json` 中。正常情況。若需重新處理：
1. 清空 `data/processed-sources.json` 的 `processedUrls` array
2. 重新執行

### `[warn] Max iterations reached, saving as draft`

文章經 3 次審核迭代仍未通過。文章標記為 `draft: true`，需人工檢查修改。

### Build 失敗：Schema validation error

新文章的 frontmatter 不符合 `src/content.config.ts` 定義的 schema。常見問題：
- `tags` 包含 `/` 字元
- `publishDate` 格式不是 `YYYY-MM-DD`
- 缺少必填欄位

### 生成的文章品質不佳

修改 `data/news-config.json` 中的：
- `generation.systemPrompt`: 調整生成指令
- `generation.reviewerPrompt`: 加強審核標準
- `generation.maxReviewerIterations`: 增加到 4-5 次
