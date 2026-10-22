# ems-admin — 能源盤點 ＋ 電力健檢填報 ＋ EMS 看板維護

院所人員以帳密登入後，畫面分成**幾支平行的任務**（2026-08-21 改版；2026-10-22 加入能源盤點）：

| 任務 | 在做什麼 | 資料存哪 | 送出的門檻 |
|------|---------|---------|-----------|
| 📍 點位與進度／🏗 初始建檔／🗂 異動登錄／📑 申報與報告 | 能源盤點（貼紙點位＋三類填報），見下面「盤點改版」一節 | **主機本地**（`AUDIT_DATA_DIR/inventory/<hid>.json`）＋ `AUDIT_UPLOADS_DIR/<hid>/inventory/` | 各區塊各自存檔；伺服器逐筆驗證 |
| 📇 聯絡人與帳號＋🔌 電力健檢填報 | 依「軍醫院電力健檢」公文附件一／三填報：聯絡人、基本資料、電費單 12 個月、排放源清單、重大設備與負載、冰水主機、營運與異常事件；上傳佐證檔案自動解析 | **主機本地**（`AUDIT_DATA_DIR`，沒有 remote 的 git 倉庫）＋ `AUDIT_UPLOADS_DIR` | 每一格都複驗完 ＋ 六條自我檢核勾滿 |
| 🖥 看板維護 | 原本的整套看板欄位編輯（院所／各資源平戰時／環境參數／報表 ESG） | `REPO_DIR`（**公開的** crinhealthcare.org 工作副本） | zod schema 驗證 |

送出健檢填報時，**其中的彙總數字會自動同步到看板**（見下面「看板同步」）。獨立 pm2 部署於主機，**不隨 astro build**。

> ⚠️ **兩套儲存不可以合併。** `REPO_DIR` 指向的 repo 是 public。附件一那張表上有姓名、電話、電子郵件；電費單與逐筆排放源清單也不是該公開的東西。它們只能走 `AUDIT_DATA_DIR`。能源盤點（能管人員個資、電費單、設備清冊）同樣只走 `AUDIT_DATA_DIR`。

## 特性

- **每院獨立帳號**：一組帳號只能編輯自家院所（`hospitalId` 綁在 session，前後端都以此限定範圍）。
- **schema 驅動的結構化表單**：欄位樹由 `src/schema.js` 的 zod 定義**推導**而來（`src/spec.js`），不是照載入到的 JSON 長。值可改、結構鎖定＝院方不會改壞語法。**通用全 15 家**。
- **分區導覽**：左側依「院所／各資源（平時·戰時·設備）／環境參數／報表 ESG」分區，一次只渲染一區，並有全欄位搜尋。
- **常用／全部 兩段式**：預設只顯示日常會更新的讀值與狀態，代碼與座標收在「進階設定」裡。
- **看板對照圖**：一張真實看板截圖疊上可點擊熱區，點下去直接跳到表單對應欄位；欄位旁另有「🖥 看板位置」說明。
- **常駐送出狀態列**：進來就看得到「上次送出是什麼時候、有沒有上線」，不再只靠會消失的 toast。
- **送出前先看變更摘要**：列出這次改了哪些欄位、前後值各是什麼，確認後才推。有未送出修改時離開會擋，並存 localStorage 草稿（防 8 小時 session 逾時）。
- **送出前驗證**：用與 Astro 建置同一套 zod schema 驗證，不合規回 422，錯誤翻成中文並可點擊跳回該欄位。
- **安全**：scrypt 密碼雜湊、HMAC 簽章 session cookie（HttpOnly/SameSite=Strict/Secure）、POST 加 Origin 檢查（CSRF）、登入失敗節流。推送金鑰只在伺服器端。

## 盤點改版（貼紙點位＋三類填報）

2026-10-22 立項。需求依據 `../../docs/energy-audit-spec.md`；架構約定與 API 細節以 `../../docs/ems-admin-revamp.md` 為準（改架構要同步更新那份）。核心想法：**掃貼紙只記「這一次會變的東西」**，設備型號、容量、年份在管理端建一次，貼紙頁不出現。三類名稱固定為**初始建檔／定期更新／異動登錄**。

### 資料放哪（兩套儲存不可合併）

| 資料 | 位置 | 說明 |
|------|------|------|
| 盤點資料 | `AUDIT_DATA_DIR/inventory/<hid>.json` | site（初始建檔）、equipment（設備主檔）、points、records（定期更新）、changes（異動登錄）、measures、plans、diagnosis。與健檢填報同一個**沒有 remote** 的 git 倉庫，每次寫入一個 commit（`src/inventory-store.js`，與 audit-store 共用一把鎖） |
| 現場照片、電費單照片 | `AUDIT_UPLOADS_DIR/<hid>/inventory/` | 二進位，不進 git |
| 看板 hospital JSON | `REPO_DIR`（public） | 盤點資料**一筆都不寫進去** |

### 點位網址與 QR

- 點位代碼 `<hid>-<E|W><兩位數>`（例 `803-E07`；E＝電、W＝水），以最後一個 `-` 切出 hid。新增點位自動配下一號，**停用的號碼不重發**；代碼與類別建好就不能改（網址已經印在貼紙上），改名、搬家只改名稱與位置。
- 每個點位固定網址 `PUBLIC_BASE_URL/s/<代碼>`（預設 `https://ems-admin.crinhealthcare.org/s/803-E07`），QR 與 NFC 寫同一個網址。單張 QR：`GET /api/inv/points/<代碼>/qr.png?size=512&download=1`；全部 QR 在管理端「點位與進度 › 列印全部 QR」排版列印。
- 貼紙頁（`public/s.html` ＋ `public/sticker.js`）未登入先登入，可勾「這支手機記住 30 天」。別家院所的代碼一律 403（貼紙貼在走廊，誰都拍得到）。

### 點位項目類型（`items[].type`）

表單依項目類型動態長出來，新增點位或改欄位不改程式：

| 類型 | 用途 |
|------|------|
| `reading` | 累計讀數（電表、水表）。自動算本次用量；讀數倒退擋下，確認換表／歸零才放行；用量差超過 `warnPct` 只提示 |
| `status` | 設備狀態，預設 正常／異常／停機（可自訂）。選「異常」備註必填，並列入「未結異常」 |
| `bill` | 電費單：拍照解析＋逐格確認（沿用 `extract.js` 與健檢的複驗閘門，伺服器那份判準才算數） |
| `number`／`text`／`photo` | 一般數值、文字、照片 |

共同欄位：`id, label, unit?, equipmentId?, meterId?, options?, warnPct?, required?`；冰水機群組月效率另有 `chillerGroup`＋`chillerRole`。

### 三類任務對應的畫面

| 類別 | 誰在哪裡填 | 畫面 |
|------|-----------|------|
| 初始建檔 | 能管人員，管理端 | 「🏗 初始建檔」：附表三 表三、電號、表七建築、表八變壓器與發電機、能管人員、表四組織與政策、R1／R2 判定；「設備主檔（表九）」三類設備。表單由 `GET /api/inv/spec` 長出來。建完預設唯讀 |
| 定期更新 | 現場人員，手機掃貼紙 | `/s/<代碼>` 貼紙頁；管理端「📍 點位與進度」看本期誰記了、未結異常（可結案）、點位管理與 QR |
| 異動登錄 | 能管人員，管理端 | 「🗂 異動登錄」：設備新增／汰換／移除／規格更正、人員異動、措施完工、計畫變更；每筆記時間、人、前後差異、原因 |
| （產出） | 能管人員，管理端 | 「📑 申報與報告」（`public/inventory-report.js`）：期限提醒、診斷措施、節能計畫、報表下載與待補欄位 |

幾條規則（伺服器把關，前端只是提早提示）：

- **原因必填**：已建檔的 site 區塊（`PUT /api/inv/site/:block`）、設備主檔（`PUT /api/inv/equipment/:id`）有變動卻沒帶 `reason` → 422 `reason_required`。第一次建檔、沒有變動不需要。
- **操作人姓名**：帳號一院一組。所有改變狀態的 `/api/inv`、`/api/inv/report` API 都收選填 `reporter`（≤20 字；DELETE 用 `?reporter=`），有填時 who＝「姓名（院名）」並另存 `reporter`。管理端頂部「操作人」欄與貼紙頁「填寫人」共用 localStorage key `ems.sticker.reporter`。
- **設備汰換**：異動登錄的「設備汰換」先建新設備，再把舊設備標成已汰換並帶 `replacedBy`；伺服器把所有點位項目的 `equipmentId` 改指新設備、新設備承接舊的所屬點位，記在同一筆異動。設備移除時回傳仍連著它的點位項目，管理端提示去點位移除。
- **設備↔點位以點位項目為準**：設備主檔的 `pointCode` 跟著點位項目的 `equipmentId` 走。`GET /api/inv` 回 `linkIssues`（對不上的清單），「點位與進度」列出並可一鍵修正。
- **建築用 id 連結**：設備主檔與變壓器的建築存 `buildings[].id`（下拉選）。舊資料存的是名稱文字，讀取時自動對回 id；對不上保留原文字、列「待修」（`siteRefIssues`）。發電機的官方欄位沒有建築物名稱，不受影響。

### 規則與依據的單一來源

- 欄位規格、驗證、依據：`src/inventory-schema.js`（盤點）、`src/report-schema.js`（措施、計畫、診斷團隊）。區塊、欄位群、設備類別、項目類型都帶 `source:{doc, ref, law, spec?, note?}`，畫面與報表都從那裡讀，不另寫一份。
- 規則與計算（R1–R9、用量、EUI、kW/RT、回收年限、機齡、期限）：`public/inventory-compute.js`，**伺服器與瀏覽器共用同一份**（同 `audit-compute.js` 的掛法）。R6 的設備類別只用它的 `equipmentReplaceCategory()`：日光燈、省電燈泡＝螢光燈具（2 年）、LED＝LED 燈具（8 年）、其他燈種不套門檻、空調與其他系統＝公用設備（10 年）。

### 報表產出與待補欄位

- `GET /api/inv/report/annex3?year=<民國資料年>`、`/diagnosis`、`/plan` 下載 xlsx（附表三年度申報、附件一節能診斷報告、附件二節能計畫）；加 `format=json` 只看工作表與待補清單。
- 每張工作表第 1 列表名、第 2 列依據（文件、表號、文號）、第 3 列院所與資料年。系統推不出的格子留空，逐項列在最後的「待補欄位」工作表；`GET /api/inv/report/missing?kind=annex3|diagnosis|plan&year=N` 回同一份清單（JSON）。
- R6 機齡超過門檻的設備自動列入設備汰換表、R7 回收 < 10 年自動列入節能計畫，兩者都不可刪（409 `mandatory`）；計畫改已填過的值要原因（R8 版本紀錄）。
- 能源署申報系統沒有公開匯入格式，xlsx 是對照官方表格的轉填稿。

### 舊資料轉移（健檢填報 → 盤點）

```bash
node scripts/migrate-inventory.mjs 803 --dry-run   # 先試跑看報告，不寫檔
node scripts/migrate-inventory.mjs 803             # 單一院所
node scripts/migrate-inventory.mjs --all           # 全部院所
```

bills／majorLoads／chillers／basic／contact 轉進新結構，**原健檢檔只讀不改**。重跑安全（轉過的記在 `migration.audit.map`，只補新出現的資料）。資料目錄取 `AUDIT_DATA_DIR`（沒設就讀 `.env`）。服務正在跑也不用重啟：盤點每次請求都重新讀檔。

### 部署注意：production 的工作目錄就是這個 repo

pm2 的 `ems-admin`（port 8470）`cwd` 就是本目錄（`ecosystem.config.cjs`），所以：

- **`public/` 存檔即上線**（靜態檔送 `no-store`）。後端（`src/`）要 `pm2 restart ems-admin` 才生效，因此前端必須能跑在舊後端上：`/api/inv/spec` 拿不到時 `app.js` 維持舊版導覽；新欄位（`linkIssues`、`linkedItems` 等）缺了要有退路。
- 改 `public/` 前先在副本改好、測過再一次複製回來，不要在這裡邊改邊試。
- `.env`、`accounts.json` 是 production 設定，本地測試不要拿來用（`config.js` 會自動讀本目錄的 `.env`）。

### 本地測試

```bash
pnpm test                                   # 全部回歸（測試自己開暫存目錄，不碰 production 資料）
(cd ../.. && node scripts/check-design.mjs)  # 要在 repo 根目錄跑：設計規範守門（含 public/ 的 CSS）
```

開一個跟 production 完全隔開的實例（不要複製 `.env`；`process.loadEnvFile` 不覆蓋已設的環境變數，但沒有 `.env` 最保險）：

```bash
SITE=$(git rev-parse --show-toplevel)                # crinhealthcare.org 根目錄
rsync -a --exclude node_modules --exclude .env --exclude accounts.json ./ /tmp/ems-scratch/
ln -s "$PWD/node_modules" /tmp/ems-scratch/node_modules && cd /tmp/ems-scratch
mkdir -p /tmp/ems-run/{data,uploads,repo/src/content/hospitals}
cp "$SITE/src/content/hospitals/803.json" /tmp/ems-run/repo/src/content/hospitals/   # 看板維護畫面要讀得到院所 JSON
echo '{"accounts":[]}' > /tmp/ems-run/accounts.json
ACCOUNTS_FILE=/tmp/ems-run/accounts.json EMS_PW='testpass' node scripts/hash-password.mjs hosp-803 803 "測試院所"
HTTP_PORT=8476 JWT_SECRET=$(openssl rand -hex 16) ACCOUNTS_FILE=/tmp/ems-run/accounts.json \
  REPO_DIR=/tmp/ems-run/repo AUDIT_DATA_DIR=/tmp/ems-run/data AUDIT_UPLOADS_DIR=/tmp/ems-run/uploads \
  COOKIE_SECURE=0 PUBLIC_BASE_URL=http://127.0.0.1:8476 node src/index.js
```

關掉時用 `ss -ltnp | grep :8476` 取 pid 精準 kill，**不要 `pkill node`**（會連 production 一起殺）。

## 電力健檢填報（公文附件一／三）

### 欄位怎麼來的

`src/audit-schema.js` 是**唯一真實來源**：七個區塊的欄位表推導出前端表單／表格、驗證、xlsx 匯入對照、看板同步彙總。新增欄位只改那一支，`pnpm test` 會擋下沒有中文標籤、型別不合法、或計算欄位被標成必填的情況。

對應關係（別自己重新發明，範本的座標已經量好了）：

| 本系統區塊 | 公文 | V2 範本工作表 |
|-----------|------|--------------|
| `bills` 電費單 | 附件三 | 表P｜用電統計（表頭的電號/電價種類匯入時複製到每一列） |
| `majorLoads` 重大設備與負載 | 附件三 | 表E｜能源設備盤查 |
| `chillers` 冰水主機 | 附件三 | 表A 冰水主機（範本每台一欄，匯入時轉置成每台一列） |
| `basic` 基本資料 | 附件三 | 表Z｜基本資料（原註明不在範圍，本次公文要求納入） |
| `emissions` 排放源清單 / `events` 營運與異常事件 | 附件三 | 範本沒有，本系統新增 |
| `contact` 聯絡人 | 附件一 | 個資，`private: true`，永不同步 |

### 複驗閘門（這是整個功能的安全底線，不要拆）

上傳佐證檔案 → 解析 → **每一格標成 `todo`（待複驗）或 `low`（信心低）** → 院方逐格確認變 `ok` → 才准送出。人親手改過的格子直接算複驗過（有來源的變 `ok`，沒來源的是 `manual` 人工填寫）。

- 前後端各有一份判準（`audit-schema.pendingCells` 與 `audit.js` 的 `pending()`），**伺服器那份才算數**——前端擋不住的送出，後端回 409。
- 「全部確認」刻意要**捲到表格底部**才啟用。沒看過就整批按下去，這道閘門等於沒有。
- 掃描影本的辨識率不可能一直是 100%。任何「讓解析結果直接生效」的優化提案，先想清楚誰要為錯誤的度數負責。

### 兩條解析路徑

| 檔案 | 走哪裡 | 需要 API key |
|------|--------|-------------|
| xlsx／csv | `audit-io.js` 的逐格對照（V2 範本座標）。確定性、零成本、可重現 | 否 |
| PDF／掃描件／照片 | Claude 文件理解（`src/extract.js`）：結構化輸出綁 JSON schema，同時回每個值的頁碼供複驗對照 | 是（`ANTHROPIC_API_KEY`） |

**沒設 key 不會讓功能停擺**：xlsx 照樣解析，PDF 上傳仍會保存檔案，只是回一句「尚未開通自動解析，請手動填寫」。

實測一張兩頁的台電電費單（2026-08-21，`claude-opus-5`）：21 秒、輸入 12,821 tokens／輸出 751 tokens，25 個欄位全對，頁碼正確分辨第 1 頁與第 2 頁，民國 114 年 3 月正確換成 2025-03。**約 US$0.08／張**，15 院 × 12 個月估 US$15 上下。

兩個實作上的坑，改的時候別踩回去：

- **結構化輸出與 citations 不能併用**（API 會回 400）。所以頁碼是**放進 schema 自己收**（`pages` 欄），不是走 citations。
- **schema 裡不可以用 union 型別**（`['string','null']`）。結構化輸出對「帶 union 的參數」有上限 16 個，電費單 25 欄 ×（值＋頁碼）＝ 50 個會直接 400（`Schemas contains too many parameters with union types`）。改用同型別的哨兵值：值缺漏填空字串、頁碼不確定填 0，回來再轉成 undefined／null。
- **費用欄位可以是負數**：台電電費單的功率因數調整費是減項（實測 -24,530）。`feePowerFactor` 與 `feeOther` 標了 `allowNegative`，其餘費用欄仍擋負數。擋錯的後果是院方照實填反而送不出去。
- 值一律宣告成「字串或 null」再用 `coerce()` 正規化。解析器常回「1,234.5 kWh」「NT$3,872,510」，直接宣告 number 只會換來一堆型別錯誤與重試。`coerce` 另外處理民國年（114 年 3 月 → 2025-03）。
- `coerce` 的數字分支**一定要先確認清乾淨後還有數字**：`Number('')` 是 0，不擋的話「未提供」「無」這種字會被靜靜寫成 0 度、0 元，比留白危險得多。

### 看板同步

送出填報即同步（業主 2026-08-21 指示：不要獨立的「發布」動作）。`src/board-sync.js`：

- 只寫 `esgPanels` 裡 id 以 `power-audit` 開頭的面板，整批換掉。
- **其他面板、`report`、`env.carbon` 一律不碰**——那些是人寫的內容，覆蓋掉就回不來了。
- 同步的只有彙總（月數、總用電、總電費、最高需量、契約容量與利用率、排放量、重大設備推估年用電、月別趨勢）。原始電費單、聯絡人個資、逐筆排放源清單、營運事件內文都不上去。
- 同步失敗**不推翻已存好的填報**——填報是主要動作，同步是衍生動作。

### 計算欄位為什麼放在 `public/`

`public/audit-compute.js` 由**伺服器與瀏覽器共用同一份**（瀏覽器當一般腳本載入、伺服器 `import` 只求副作用後讀 `globalThis.EMSAuditCompute`）。合計度數、最高需量、推估年用電量不可能一邊算一種。它沒有 DOM 依賴也沒有 import，動它之前先確認兩邊都還能跑。

## API

- `POST /api/login` `{username,password}` → 設 cookie，回 `{ok,hid,name}`
- `POST /api/logout`
- `GET /api/me` → `{username,hid,name}`（未登入 401）
- `GET /api/schema` → `{spec}` 由 zod 推導的欄位樹（含中文標籤、enum 選項、新增用空白值）
- `GET /api/hospital` → 自家院所現況 `{hospitalId,data}`
- `POST /api/hospital` `{data}` → 驗證 → 寫檔 → commit+push → `{ok,commit,unchanged}`
- `GET /api/deploy?commit=<完整40碼sha>` → 該 commit 的部署狀態
- `GET /healthz`

電力健檢填報（以下皆需登入，且只能存取自家院所）：

- `GET /api/audit/spec` → `{ spec, extraction, maxBytes }` 欄位表＋九階段＋六條自我檢核
- `GET /api/audit` → `{ audit, history, stats, pending, stages }`
- `POST /api/audit` `{ audit, selfCheck:[0..5] }` → 驗證 → 複驗閘門（409）→ 自我檢核閘門（409）→ 寫檔 → 同步看板
- `POST /api/audit/upload`（multipart：`block`、`period`、`file`）→ 存檔＋解析，回 `{ file, rows, notes, stats, parseError }`；**rows 只是提案，不會自動寫入**
- `POST /api/audit/file/delete` `{ id }`
- `GET /api/audit/file?id=` → 佐證檔案本體（`Content-Disposition` 用中文的 displayName）
- `GET /api/audit/history`

能源盤點（`/api/inv/*`、`/s/:code`，路由在 `src/inventory-routes.js`，報表在 `src/report-routes.js`）：完整路由表與請求／回應形狀見 `../../docs/ems-admin-revamp.md`「架構約定」與「後端實作補充」。

## 表單為什麼要 schema 驅動（勿改回「照資料長」）

舊版照載入到的 JSON 遞迴長表單，造成三個院方碰得到的死路，都已改掉且有測試蓋住（`test/spec.test.js`）：

| 代號 | 症狀 | 現在的作法 |
|------|------|-----------|
| A1 | 按「＋新增一項」後送出必被 422 擋（新項目所有字串填 `''`，但 `esg`/`kind`/`tone` 是 enum，`''` 不合法；`.default()` 只在 undefined 時生效） | `spec.itemBlank` 由 `blankFrom()` 依 schema 產生，enum 取合法值 |
| A2 | 空陣列沒有樣本可複製 → 只印「請告知維護窗口」，第一筆永遠加不了（803 有 62 個空陣列；9 家院所 `devices` 是空的） | 陣列一律有「＋新增一項」，樣本來自 `itemBlank` |
| A3 | JSON 沒有的鍵表單完全看不到（807 缺 `hideMeta`/`peakShave`；`report`/`esgPanels` 15 家都沒有） | 走 schema 的欄位表；optional 區塊顯示「＋啟用此區塊」，缺的純量顯示 schema 預設值並標「未設定」 |

另外兩點也請維持：

- **不要在載入時把 schema 預設值寫進資料**。畫面顯示預設值、標「未設定」，使用者真的改了才寫。否則每個院所一開表單就出現一堆假的「未送出修改」，送出後 JSON 會被灌進一堆原本沒有的欄位。
- **變更比對要用 LCS 對齊陣列**（`alignArrays`）。照索引比的話，刪掉第 1 項會讓後面每一項都位移，一次刪除被算成三十幾筆修改。

## 院方的四個抱怨與對應作法（2026-08-06）

上線兩週後收到的回饋，四點都處理了。改動時請保住這四件事：

1. **「欄位太多找不到我要改的那個」** → 分區導覽＋全欄位搜尋。單頁 83,297px／1,175 個輸入框 → 常用模式下最大分區 5,267px／42 個輸入框。
2. **「我只想改幾個數字，為什麼要看到色票和座標」** → `src/labels.js` 的三層分級（1 常用／2 設定／3 代碼與座標），預設只顯示第 1 層。分層預設用鍵名判斷、少數例外在 `P` 表用 `t:` 覆蓋——**新增欄位若分錯層，最糟的情況是院方在常用模式下看不到該欄位**，所以有疑慮就標 `t: 1`。
   常用模式**故意不給陣列的增刪與排序**：新項目的必填欄位（名稱等）在該模式下看不到，讓人建出半套的項目只會更糟。
3. **「我不知道哪個欄位對應看板上哪一塊」** → `public/board-map.png` ＋ `board-map.json`（熱區座標），由 `scripts/make-board-map.mjs` 去線上抓真實看板量出來。**看板版面改版後要重跑**：`node scripts/make-board-map.mjs 802`。另外 `labels.js` 的 `where:` 是欄位級的文字說明。
4. **「送出後不知道有沒有成功」** → 常駐狀態列（`GET /api/history` 讀該院所檔案的 git log ＋ `GET /api/deploy` 查部署結論）。**注意 20 分鐘的 stale 判斷**：部署只要 1–2 分鐘，超過 20 分鐘還查不到結論就不要硬報「部署進行中」，那會讓人以為卡住。

## 欄位中文名稱（`src/labels.js`）

以**路徑**為鍵，不是鍵名。同一個鍵名在不同位置意思不同，最明顯的是 `pct`：

- `resources[].@.supply[].pct` 是自由文字（實際內容例：「插座110/220V · 82.6h」）
- `resources[].@.store[].pct` 是 0–100 的數字

舊版用扁平的 key→中文對照，兩者都標成「百分比」，畫面上出現「百分比: 插座110/220V」。路徑寫法：物件用 `.`、陣列項目用 `[]`、`peace`/`war` 兩個情境分支統一寫成 `@`。新增 schema 欄位時記得在這裡補標籤——`pnpm test` 會擋下沒有中文標籤的欄位。

## 本地開發

```bash
pnpm install
# 準備一個帶 origin 的 git 工作副本當 REPO_DIR（見 .env.example）
cp .env.example .env        # 填 JWT_SECRET / REPO_DIR，COOKIE_SECURE=0（本地 http）
EMS_PW='密碼' node scripts/hash-password.mjs hosp-802 802 "國軍高雄總醫院"
pnpm start                  # http://localhost:8470
pnpm test                   # schema 對所有現有院所 JSON 做回歸＋盤點、報表的回歸
```

> 這裡的 `.env` 是給「自己的開發機」用的。在 production 主機上請照上面「盤點改版 › 本地測試」另開實例，不要動本目錄的 `.env`。

## 部署（主機 SOP）

1. `cd services/ems-admin && pnpm install --prod`
2. **準備推送用工作副本**（與服務程式分開，避免互相干擾）：
   ```bash
   git clone <repo> /opt/ems-admin/repo
   cd /opt/ems-admin/repo
   # 設定可 push 的 origin：deploy key（SSH）或 https + 細粒度 PAT（僅該 repo、Contents:write）
   git config user.name "EMS Admin"; git config user.email "ems-admin@crinhealthcare.org"
   ```
3. **準備健檢填報的本地儲存**（與 `REPO_DIR` 完全分開，這兩個路徑不可以指到同一個地方）：
   ```bash
   mkdir -p /opt/ems-admin/data /opt/ems-admin/uploads
   chmod 700 /opt/ems-admin/data /opt/ems-admin/uploads   # 內含個資
   ```
   `data/` 會在服務第一次使用時自動 `git init`（**刻意不設 remote**，推不出去）；佐證檔案本體放 `uploads/`，不進 git。
4. `cp .env.example .env`，填：
   - `JWT_SECRET`（`openssl rand -hex 32`）
   - `REPO_DIR=/opt/ems-admin/repo`
   - `ACCOUNTS_FILE`（預設 `./accounts.json`）
   - `ANTHROPIC_API_KEY`（PDF／掃描件自動解析用；不填則只有 xlsx 會解析）
   - `AUDIT_DATA_DIR` / `AUDIT_UPLOADS_DIR`（預設就是上一步那兩個路徑）
5. **建帳號**（每院一組，密碼走環境變數不落 argv）：
   ```bash
   EMS_PW='院方密碼' node scripts/hash-password.mjs hosp-802 802 "國軍高雄總醫院"
   # 每家一組：hosp-803/803、hosp-804/804 …
   ```
6. `pm2 start ecosystem.config.cjs && pm2 save`（**必 pm2 save**）
7. UFW：`ufw allow from 172.18.0.0/16 to any port 8470`（僅 NPM 可達，公網不開）
8. NPM Proxy Host：`ems-admin.crinhealthcare.org` → `http://172.18.0.1:8470`（**Forward 用 172.18.0.1**），Let's Encrypt + Force SSL
9. 驗證：`curl https://ems-admin.crinhealthcare.org/healthz` → `{ok:true}`；瀏覽器登入 → 改值 → 送出 → 看 GitHub Actions 部署 → 看板更新

> ⚠️ **推送金鑰安全**：`REPO_DIR` 的 origin 具 push 權限，等同可改正式站。金鑰只存主機（deploy key 私鑰 / PAT），**絕不進前端、不進 repo**。`.env`、`accounts.json` 已於 `.gitignore` 排除。

## Schema 同步（漂移過一次，請照做）

`src/schema.js` 是 `crinhealthcare.org/src/content.config.ts` 的 `hospitals` schema 副本。**content.config.ts 若增修 hospital 欄位，這裡要同步**，否則新欄位不會出現在表單上（表單現在照 schema 長）。

2026-08-06 實際漂移過：`content.config.ts` 已有的 `boardTitle`、`resources[].@.plan`（戰時平面配置圖）、`resources[].@.power`（戰時供電規劃）三段從未同步過來，804 的 B1 開設配置圖因此在表單上完全看不到。已補齊。

`pnpm test` 的「spec 涵蓋 schema」會拿全 15 家 JSON 的**每一個鍵**去比對 spec，漏同步會直接測試失敗——這是最快的對齊檢查。改完 schema 也要在 `src/labels.js` 補中文標籤，否則「每個欄位都有中文標籤」那條測試會擋下。

## 設計規範（2026-08-06 起納入守門，勿再寫死色/字級）

本服務的畫面**受團隊 CSS 設計規範 v2 管**，由站台的 `../../scripts/check-design.mjs` 一起掃
（該腳本現在掃兩塊：`src/` 與 `services/ems-admin/public/`）。**違規會擋掉整個站台的 `pnpm build`。**

- 顏色只准寫在 `public/tokens.css`，而且只用 **oklch**；`style.css` 一律 `var(--color-*)`，禁 hex／rgb／rgba。
- 字級只准用 `var(--text-*)` 階梯，禁 px。階梯值本身**不得低於 18px**（`--text-xs: 1.125rem` 是下限，腳本會查）。
- 禁 important 覆寫。要壓過既有規則就拉選擇器權重：`.hidden.hidden`（取代原本的 `display:none` 加 important）、
  `.invalid:focus`（0,2,0，壓過 `input:focus` 的 0,1,1）——這兩處有註解，別改回去。
- `public/` 下的 `.css` 只准 `tokens.css` 與 `style.css` 兩檔，新增檔即 fail。
- 品牌色與 `../../src/styles/variables.css` 同源（teal `oklch(0.45 0.15 195)`）。**改品牌色兩邊都要改**——
  這裡是鏡射不是 import（服務獨立部署，拿不到 Astro 的 src/）。
- 錯誤色分兩支：`--color-alert`（L=0.65，配白字只有 3.56:1，**只當邊框/圖示**）與
  `--color-alert-strong`（L=0.52，6.08:1，錯誤文字與危險按鈕用這支）。別把文字改回 `--color-alert`。

**為什麼會走到這一步**：ems-admin 不進 astro build，先前不在守門掃描範圍內，整份 `style.css`
漂成 hex 色票（自成一套綠）＋ 11–15px 字級，被用戶當場抓到。納入守門就是為了不再漂。

改字級後注意兩件實測會壞的地方：窄螢幕 topbar 三顆按鈕會折行（已用 `--text-xs` ＋小 padding 收），
陣列列的「刪除」鈕會被擠成兩行（已 `flex: none` ＋ `white-space: nowrap`）。

## 檔案

- `src/config.js` — .env 載入＋啟動檢查
- `src/schema.js` — 移植的 zod 驗證 schema＋中文化的錯誤訊息
- `src/spec.js` — 由 zod 內省推導出前端欄位樹（含 `itemBlank`／`blank` 空白骨架）
- `src/labels.js` — 路徑 → 中文名稱／說明／建議值／enum 中文選項／分層 `t`／看板位置 `where`
- `src/auth.js` — scrypt 雜湊、HMAC token、cookie
- `src/accounts.js` — 帳號載入＋登入節流
- `src/repo.js` — 讀寫 hospital JSON、git commit/push（互斥鎖序列化）
- `src/server.js` — HTTP 路由＋靜態
- `public/tokens.css` — 設計 token（oklch 色票＋≥18px 字級階梯）；顏色/字級只准改這裡
- `public/style.css` — 版面樣式，一律引用 token（禁 hex/px 字級/important，見上節）
- `public/` — 登入＋分區導覽表單（原生 JS，無 build）
- `public/board-map.png` / `board-map.json` — 看板對照圖素材（由下面那支腳本產生，直接 commit 進 repo）
- `scripts/hash-password.mjs` — 產/追加院所帳號
- `scripts/make-board-map.mjs` — 重新產生看板對照圖（一次性，不進 CI；看板改版才需要跑）
- `src/audit-schema.js` — 電力健檢七個區塊的欄位表（唯一真實來源）＋九階段＋六條自我檢核＋驗證＋複驗狀態
- `src/audit-store.js` — 健檢填報資料的落地（主機本地、**無 remote** 的 git 倉庫）
- `src/upload-io.js` — multipart 解析、佐證檔案落地、檔名正規化
- `src/extract.js` — 佐證檔案 → 結構化欄位值（xlsx 走逐格對照；PDF／影像走 Claude）
- `src/audit-io.js` / `src/audit-fields.js` / `src/xlsx.js` — V2 範本的逐格匯入匯出引擎
- `src/board-sync.js` — 填報彙總 → 看板 `esgPanels`（只碰 `power-audit*`）
- `src/audit-routes.js` — 健檢的 API 路由（server.js 只負責分派）
- `public/audit-compute.js` — **伺服器與瀏覽器共用**的計算欄位求值器與看板彙總
- `public/audit.js` — 健檢填報前端（三段式版面、表格編輯器、複驗標記、送出檢核）
- `test/spec.test.js` — A1–A5 的回歸測試＋schema 對齊檢查
- `test/audit.test.js` — 健檢的回歸測試（計算、複驗閘門、看板同步不越界、xlsx 對照）
- `src/inventory-schema.js` — 盤點的欄位規格、點位與項目類型、驗證、依據 source、操作人姓名與設備↔點位一致性（唯一真實來源）
- `src/inventory-store.js` — 盤點資料落地（`AUDIT_DATA_DIR/inventory/`，無 remote）＋照片
- `src/inventory-routes.js` — `/api/inv/*` 路由（server.js 只分派）
- `src/report-schema.js` / `src/report-model.js` / `src/report-xlsx.js` / `src/report-routes.js` — 措施、計畫、診斷團隊的規格、推導、xlsx 產出與 `/api/inv/report/*` 路由
- `src/inventory-migrate.js` / `scripts/migrate-inventory.mjs` — 健檢填報舊資料 → 盤點
- `public/inventory-compute.js` — **伺服器與瀏覽器共用**的 R1–R9 規則與計算
- `public/inventory.js` — 管理端（點位與進度、初始建檔、設備主檔、異動登錄）
- `public/inventory-report.js` — 管理端「申報與報告」
- `public/s.html` / `public/sticker.js` — 貼紙落地頁（手機）
- `test/inventory.test.js` / `test/inventory-compute.test.js` / `test/report.test.js` / `test/migrate.test.js` — 盤點的回歸測試

> 改 `src/*` 後要 `pm2 restart ems-admin`；`public/*` 是靜態檔、存檔即生效（伺服器對靜態檔送 `no-store`）。production 的工作目錄就是這個 repo，所以 `public/` 的改動一存檔就上線，見「盤點改版 › 部署注意」。
