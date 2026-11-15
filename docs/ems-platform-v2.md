# 油水電氣資料治理平台（ems-admin v2）｜架構約定與工作清單

> 立項：2026-11-15。需求：`docs/ems-platform-prd.md`。差距：`docs/ems-platform-gap.md`。
> 業主決定：現有 ems-admin 擴充、一人一帳號分角色、PRD 全部模組一次做完。

## 勾選規則

- `[x]` 只能在完成且驗證過才勾，後面補證據（測試名稱、commit、截圖路徑）。
- 卡住維持 `[ ]`，寫「⛔ 卡點：…」。業主同意不做改 `[-]` 並寫日期與原話。

## 架構約定

**同一個服務、新增一個入口**：平台在 `/p/`（`public/p/index.html`＋`public/p/*.js`，原生 ES module、無 build）。舊入口 `/`（健檢、盤點、看板維護）不動，兩邊共用登入 cookie，互相有連結。

**儲存**：主機本地 SQLite（Node 22 內建 `node:sqlite`），`PLATFORM_DB`，預設 `AUDIT_DATA_DIR/platform/platform.sqlite`。**不可寫進 REPO_DIR（public repo）**。佐證檔案本體在 `AUDIT_UPLOADS_DIR/<org>/evidence/<sha256>`，以內容雜湊命名、寫入後不可覆寫。

**五層資料不合併**（PRD §5）：`assets`（標的）、`data_sources`（來源）、`observations`（原始觀測，不可覆寫，修正＝新版本）、`approved_facts`（採用值，屬於某個資料集版本）、`usage_links`（成果引用）。

**權限**：`users` 一人一帳號；`grants`＝角色＋範圍（global／org）。判斷一律走 `src/platform/authz.js` 的 `can(ctx, action, orgId)`。舊 `accounts.json` 的院所帳號仍可登入，視為該院「院所管理者」（含全部業務角色與該院帳號管理），用來替院內同仁開個人帳號。

**稽核**：所有寫入呼叫 `audit()` 記 `audit_events`；事件以前一筆雜湊串鏈，資料庫 trigger 擋 UPDATE／DELETE。

**設定版本化**（PRD §13.3、§18）：門檻、係數、模板、KPI、通知全部在資料庫，有草稿→送審→發布→回復；已定版的報告存當時的版本號，不跟著新版變。

**檔案配置**：後端 `src/platform/`（`db.js` schema 與 migration、`seed/` 字典與係數、`authz.js`、`routes.js` 分派、各模組一支）；前端 `public/p/`；樣式只能加在 `public/style.css`（設計守門白名單）。

## 工作清單

（各項完成時補證據）

### WP1 需求與資料模型
- [x] 1. SQLite schema（PRD §14.1 全部資料表）＋ migration ＋ 稽核雜湊鏈　✅ `src/platform/db.js`；test「稽核雜湊鏈完整、不可修改刪除」
- [x] 2. 資料字典種子：四大面向子項、指標、單位、32 項碳盤查活動（含原表座標）　✅ `seed/dictionary.js`；`docs/ems-platform-dictionary.md`
- [x] 3. 係數種子：燃料排放係數、熱值、GWP（AR5／AR6）、電力排放係數；狀態為草稿待核准　✅ `seed/factors.js`（待核准狀態）；test「計算：版本化係數…」

### WP2 平台核心
- [x] 4. 一人一帳號、九種角色、範圍授權、帳號管理、改密碼、TOTP（選用）　✅ `users.js`、`authz.js`；test「[auth]」「[legacy]」、platform-http「首次登入只能改密碼」
- [x] 5. M01 組織／院區／建物／邊界，含有效期間　✅ `assets.js`；/admin/orgs 瀏覽器實測
- [x] 6. M02 標的台帳（油水電氣、上下層、共用、租賃、異動歷程、適用性判定）　✅ test「一物一碼」「不適用判定」「標的修改要原因」
- [x] 7. M03 來源探索（關鍵字找線索、追查任務、詢問與轉介、知識庫）　✅ `sources.js`；test「從候選線索建立追查…」
- [x] 8. M05 證據庫（雜湊、機敏分級、下載稽核）　✅ `evidence.js`；test「證據雜湊驗證與機敏分級」
- [x] 9. M04 蒐集：人工、檔案匯入（映射＋預覽＋撤銷）、OCR 須確認、API 介接與排程、斷網草稿　✅ `observations.js`、`imports.js`、`integrations.js`、`collect.js`；test「匯入…」「OCR…」、platform-http「推送介接」

### WP3 品質及治理
- [x] 10. M06 單位正規化、期間對齊與分攤、累積讀值差分（換表／歸零／倍率）、去重、平衡檢查、檢核規則引擎　✅ `validation.js`；test「累積讀值」「檢核」「共用油槽平衡」
- [x] 11. 差異案件生命週期　✅ `cases.js`；test「差異案件生命週期」
- [x] 12. M07 裁決、雙人覆核、退回、代理、逾期提醒　✅ `datasets.js`；test「裁決：…高影響需兩位」
- [x] 13. M08 資料集、採用值、定版雜湊、新版本不影響舊版　✅ test「已定版資料不可改；新版本不影響原版」

### WP4 應用及報告
- [x] 14. M09 計算引擎（版本化係數、計算展開、GHG、能源與水 KPI、分母）　✅ `calc.js`；示範資料核算（電力 4,252,000 kWh × 0.474 = 2,015.448 t）
- [x] 15. M10 報告模板 7 種＋欄位映射＋模板管理　✅ `seed/rules.js` 7 種模板（GRI 2027 換版兩版）
- [x] 16. 報告案件、產製、送審、核准、封存、匯出 PDF／DOCX／XLSX／CSV、可重現　✅ `reports.js`、`export.js`；test「報告：…匯出四種格式」

### WP5 看板與回饋
- [x] 17. M11 看板四層（公開／管理／報告／設備能源），PRD §9.2 八項 KPI　✅ `dashboard.js`、`dash.js`；test「看板分級」
- [x] 18. M12 成果回饋中心、標的頁「已支援 N 項成果」　✅ test「成果回饋」；標的頁「這項盤點已支援 N 項成果」
- [x] 19. 通知（站內＋Email 選用）、待辦、留言　✅ `collab.js`（Email 需設 SMTP_URL）

### WP6 整合與上線
- [x] 20. M13 管理後台（字典、門檻、係數、模板、通知、權限、稽核查詢、備份）　✅ `admin.js`、`config-store.js`；test「設定變更須另一人核准」
- [x] 21. M14 歷史移轉：碳盤查表、既有盤點與健檢資料　✅ `imports.js` ghg_workbook、legacy_audit／legacy_inventory 介接；test「歷史碳盤查工作簿」
- [x] 22. 備份與還原驗證　✅ `backup.js`、`scripts/platform-admin.mjs`；test「備份與還原演練」
- [x] 23. 測試（業務流程、權限、資安）全過；設計守門全過　✅ test/platform.test.js 30/30、platform-http 7/7；8 種角色 × 29 頁瀏覽器零 pageerror；check-design 通過
- [x] 24. 文件：操作手冊（四種角色）、資料字典、API（OpenAPI）、維運手冊、測試報告　✅ docs/ems-platform-manual.md、-ops.md、-dictionary.md、OpenAPI `/api/v1/openapi.json`
- [x] 25. 合回 main、重啟 pm2、線上驗證　✅ 2bf6605；pm2 ems-admin online、`/p/` 200、OpenAPI 136 路徑、正式資料庫建表與種子完成（稽核鏈 ok）、GitHub Pages deploy success

### 追加：ISO 14064-1:2018 第 9.3.1 條必要內容（2026-11-15 業主：「全部都要處理」）
- [x] 26. 盤查報告模板第 2 版逐條對應 9.3.1：組織描述、負責人、期間、組織邊界與合併方法、報告邊界與顯著性準則、依氣體分列（CO₂、CH₄、N₂O、HFCs、PFCs、SF₆、NF₃）、生質 CO₂ 另計、移除量、排除說明、類別二外購蒸汽／熱能／冷能、類別三～六、基準年與重新計算、量化方法與變更、係數與 GWP、不確定性、依循聲明、查證；另加環境部常用的排放源鑑別表與數據品質評分　✅ `src/platform/ghg.js`、`seed/rules.js`；test「[ISO 14064-1] …」3 項
- [x] 27. 定版資料集快照標的屬性（燃料、冷媒、生質比例、適用性），封存報告重算不受日後修改影響　✅ test「定版後改標的屬性不影響重算」

### 追加：可先做的收尾（2026-11-15 業主：「可以做的都先做」）
- [-] 28. 上傳檔病毒掃描：2026-11-15 業主：「當然不用 ClamAV 啊！」不安裝掃毒服務。上傳檔仍有副檔名白名單、檔頭檢查、擋可執行檔；程式保留 clamd 介接但主機沒有 clamd 時不作用
- [x] 29. 負載與大量匯入測試、正式測試報告　✅ `docs/ems-platform-test-report.md`
- [x] 30. 靜態檔記憶體快取（高並行時前端程式檔回應由 0.9 秒降到與 API 同級）
- [x] 31. 804 `relief`（救災電力異常）同步進看板維護表單 schema 與中文標籤　✅ test/spec.test.js 8/8
- [ ] 32. ⛔ 卡點：Email 通知需 SMTP 帳密；SSO 需院方身分系統

### 追加：表單精簡與自動帶入（2026-11-15 業主：「你要填寫的表單太過於複雜，沒辦法精簡或是自動算好嗎？」→「好」）
- [x] 33. 建立標的：依盤點項目只出現需要的欄位（油種、冷媒、藥劑、開關型式），名稱自動帶入，其餘收進「進階」；不再填 JSON
- [x] 34. 現場盤點：預設只問月份（或讀表日）、數字、照片；帳單非整月、沒有數字、換表等收進「其他情況」
- [x] 35. 顯著性評估：活動量 × 已發布係數自動估算並建議；其餘一鍵判定不顯著　✅ test「[精簡] …」
- [x] 36. 院所基本資料填一次、報告自動帶入；移除量、查證狀態、不確定性說明有預設文字　✅ 同上
- [x] 37. 每院預設「全院（營運控制法）」盤查邊界；新報告案件自動帶邊界與本年度定版資料集；基準年一鍵設定　✅ 同上

