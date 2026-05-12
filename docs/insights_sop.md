# Insights Automation SOP

crinhealthcare.org 深度內容自動化完整作業流程。

---

## 1. Schedule & Trigger

### GitHub Actions 排程

- **Workflow**: `.github/workflows/insights-automation.yml`
- **Cron**: `0 0 * * 2,5` (UTC) = 每週二、週五台灣時間 08:00
- **Manual dispatch**: 可從 GitHub Actions 頁面手動觸發

### 本機執行

```bash
# 確認 .env 已設定 ANTHROPIC_API_KEY, TAVILY_API_KEY, UNSPLASH_ACCESS_KEY
pnpm tsx scripts/generate-insights.ts
```

---

## 2. Pipeline Overview

```
類別輪替 → 搜尋 (Tavily) → 去重 → 載入交叉引用 → 生成 (Claude) → 審核 (reviewer loop) → 儲存 → 抓圖 (Unsplash) → commit/push
```

### 完整流程

1. 載入 `data/insights-config.json` 設定
2. 讀取 `data/processed-insights.json`，決定下一個類別（輪替）
3. 使用該類別的搜尋策略透過 Tavily API 搜尋來源
4. 與已處理主題 URL 比對去重
5. 載入詞彙庫和案例研究的交叉引用資料
6. 呼叫 Claude API 生成深度文章（1500-3000 字）
7. 由 Claude 以三角色審核員檢查
8. 儲存為 Markdown
9. 抓取 Unsplash 圖片
10. commit + push 或建立 PR（未收斂的 drafts）

---

## 3. Category Rotation

### 三類輪替

每次 run 只生成 **1 篇**文章，類別按順序輪替：

```
policy → guide → benchmark → policy → guide → benchmark → ...
```

| Category | 中文名稱 | 內容方向 | 字數 |
|----------|---------|---------|------|
| `policy` | 政策法規分析 | 深入解析法規條文，提供醫療機構應對建議 | 1500-3000 |
| `guide` | 實務指引 | 可操作的步驟指引，引用實際案例 | 1500-3000 |
| `benchmark` | 國際標竿 | 比較國際做法與台灣現況 | 1500-3000 |

### 輪替紀錄

`data/processed-insights.json` 記錄上次使用的 category：

```json
{
  "processedTopics": ["https://...", "https://..."],
  "lastCategory": "policy",
  "lastRun": "2026-05-12T00:00:00.000Z"
}
```

---

## 4. Source Strategies

每個 category 有獨立的搜尋策略，定義在 `data/insights-config.json`。

### policy 類

| 項目 | 內容 |
|------|------|
| 查詢 | 台灣環境部碳費醫療法規、溫室氣體減量醫療機構規範、ESG 永續醫療政策、衛福部醫院節能規定、碳權交易醫療 |
| 偏好網域 | moeenv.gov.tw, mohw.gov.tw, law.moj.gov.tw, gazette.nat.gov.tw |
| Search depth | advanced |

### guide 類

| 項目 | 內容 |
|------|------|
| 查詢 | 醫院碳盤查步驟指引、ISO 14064 醫療機構實務、醫院能源管理最佳實務、ESG 報告醫療院所撰寫、ESCO 醫院節能改善案例 |
| 偏好網域 | tgpf.org.tw, bcsd.org.tw, ftis.org.tw, moeaidb.gov.tw |
| Search depth | advanced |

### benchmark 類

| 項目 | 內容 |
|------|------|
| 查詢 | NHS net zero healthcare update, WHO healthcare climate action, Healthcare Without Harm sustainability, Asia Pacific hospital carbon reduction, International hospital ESG benchmark |
| 偏好網域 | england.nhs.uk, who.int, hcwh.org, greenhospitals.org, globalgreenhealthyhospitals.org |
| Search depth | advanced |

---

## 5. Content Length & Structure

### 與 News 的差異

| 項目 | News | Insights |
|------|------|----------|
| 字數 | 500-800 | 1500-3000 |
| 小節 | 2-3 個 | 4-6 個 |
| maxTokens | 4096 | 8192 |
| 每次生成數 | 最多 3 篇 | 1 篇 |
| 交叉引用 | 無 | 詞彙庫 + 案例研究 |
| Category | 無 | policy / guide / benchmark |

### 正文結構（4-6 個 h2 小節）

```markdown
## 背景與政策脈絡
（政策背景、法規演變）

## 核心要點分析
（深度技術/政策分析）

## 實務案例
（具體案例、數據佐證）

## 台灣現況與挑戰
（台灣醫療機構面臨的具體情況）

## 國際比較
（benchmark 類必含，其他類選填）

## 結論與建議
（行動建議、未來展望）
```

---

## 6. InternationalBenchmark Block

`benchmark` 類文章建議在 frontmatter 包含 `internationalBenchmark` 區塊：

```yaml
internationalBenchmark:
  region: "英國"
  title: "NHS Greener NHS Programme"
  summary: "NHS 承諾在 2040 年達成淨零排放，涵蓋直接碳足跡與供應鏈。"
  sourceUrl: "https://www.england.nhs.uk/greenernhs/"
  comparison: "台灣醫療體系的碳管理尚處起步階段，NHS 的經驗可作為制度建置參考。"
```

此區塊用於：
- 頁面上顯示國際比較卡片
- 與 news 文章的 internationalBenchmark 共用同一 Zod schema

---

## 7. Cross-linking

### 交叉引用機制

生成前，`loadCrossReferences()` 會讀取：

1. **詞彙庫術語**：掃描 `src/content/glossary/*.md` 的 `term` 欄位
2. **案例研究 slug**：掃描 `src/content/case-studies/*.md` 的檔名

這些資料作為提示（hint）傳給 Claude，在生成 prompt 中包含：

```
可交叉引用的詞彙表術語：基準年、碳盤查、ISO 14064-1、...
可引用的案例研究：ndmc-taichung、ndmc-kaohsiung、...
```

### 正文中的交叉引用

- 提及詞彙表術語時使用**粗體**標示
- 提及案例研究時引導讀者參考案例研究專區

---

## 8. Review Mechanism

與 News 相同的三角色審核機制，但額外檢查：

| 檢查項目 | 說明 |
|---------|------|
| 字數 | 是否達到 1500 字以上 |
| 交叉引用 | 是否適當引用詞彙表和案例研究 |
| benchmark 比較表 | benchmark 類是否包含國際比較 |
| 小節數量 | 是否有 4-6 個 h2 小節 |

### 收斂規則

同 News：最大 3 次迭代，未收斂標記為 draft，CI 環境建立 PR。

---

## 9. Image Matching

新文章生成後，workflow 執行：

```bash
pnpm tsx scripts/fetch-images.ts --collection insights --new-only
```

流程與 News 相同：讀取 tags → 查 image-keywords.json → Unsplash API → 下載到 `src/assets/images/auto/insights/`。

---

## 10. Dedup Mechanism

### 檔案

`data/processed-insights.json`

```json
{
  "processedTopics": ["https://url1", "https://url2"],
  "lastCategory": "guide",
  "lastRun": "2026-05-12T00:00:00.000Z"
}
```

### 規則

- 以搜尋結果的 URL 為去重鍵
- 每次 run 處理的 top 5 sources URL 全部加入紀錄
- `lastCategory` 用於決定下次輪替

---

## 11. Daily Operations

### 例行檢查（每週二、五）

1. 檢查 GitHub Actions 的 Insights Automation run 是否成功
2. 確認新文章已部署到網站
3. 若有 PR（`needs-review` label），進行人工審核

### 手動觸發

GitHub Actions > Insights Automation > Run workflow > Run workflow

### 手動指定 category

目前不支援 CLI 參數指定 category（自動輪替）。若需強制特定 category：

1. 修改 `data/processed-insights.json` 的 `lastCategory`
2. 設為目標 category 的**前一個**：
   - 想要 `policy` → 設 `lastCategory: "benchmark"`
   - 想要 `guide` → 設 `lastCategory: "policy"`
   - 想要 `benchmark` → 設 `lastCategory: "guide"`
3. 執行腳本

---

## 12. Related Files

| 檔案 | 用途 |
|------|------|
| `scripts/generate-insights.ts` | 深度內容生成主程式 |
| `scripts/fetch-images.ts` | Unsplash 圖片抓取 |
| `scripts/lib/ai.ts` | Claude API wrapper |
| `data/insights-config.json` | 類別策略 + 生成設定 + prompts |
| `data/processed-insights.json` | 去重紀錄 + 類別輪替狀態 |
| `data/image-keywords.json` | 標籤→圖片關鍵字對照 |
| `.github/workflows/insights-automation.yml` | CI workflow |
| `src/content/insights/` | 文章輸出目錄 |
| `src/content/glossary/` | 交叉引用來源：詞彙庫 |
| `src/content/case-studies/` | 交叉引用來源：案例研究 |
| `src/content.config.ts` | Schema 定義 |

---

## 13. Troubleshooting

### `[warn] TAVILY_API_KEY is not set` / `[warn] ANTHROPIC_API_KEY is not set`

API key 未設定。本機：檢查 `.env`。CI：檢查 GitHub Secrets。

### `[done] No new sources found`

所有搜尋結果的 URL 都已在 `processedTopics` 中。處理方式：
1. 正常情況——該 category 的來源暫時沒有更新
2. 若需重新處理：清空 `processedTopics` array

### `[warn] Max iterations reached, saving as draft`

文章經 3 次審核未通過。標記為 `draft: true`，需人工修改。

### Build 失敗：category 不是 policy/guide/benchmark

frontmatter 的 `category` 值必須是 `z.enum(['policy', 'guide', 'benchmark'])` 三者之一。

### 交叉引用未生效

- 確認 `src/content/glossary/` 和 `src/content/case-studies/` 有 `.md` 檔案
- `loadCrossReferences()` 從 frontmatter 中讀取 `term` 欄位
- 若 glossary 為空，交叉引用提示會被略過

### 生成的文章深度不足

修改 `data/insights-config.json` 中的：
- `generation.systemPrompt`: 強調深度分析要求
- `generation.reviewerPrompt`: 加入字數和深度的明確門檻
- `generation.targetWordCount`: 調整目標字數範圍
- `generation.maxReviewerIterations`: 增加迭代次數
