# ems-admin — 電力健檢填報 ＋ EMS 看板維護

院所人員以帳密登入後，畫面分成**兩支平行的任務**（2026-08-21 改版）：

| 任務 | 在做什麼 | 資料存哪 | 送出的門檻 |
|------|---------|---------|-----------|
| 📇 聯絡人與帳號＋🔌 電力健檢填報 | 依「軍醫院電力健檢」公文附件一／三填報：聯絡人、基本資料、電費單 12 個月、排放源清單、重大設備與負載、冰水主機、營運與異常事件；上傳佐證檔案自動解析 | **主機本地**（`AUDIT_DATA_DIR`，沒有 remote 的 git 倉庫）＋ `AUDIT_UPLOADS_DIR` | 每一格都複驗完 ＋ 六條自我檢核勾滿 |
| 🖥 看板維護 | 原本的整套看板欄位編輯（院所／各資源平戰時／環境參數／報表 ESG） | `REPO_DIR`（**公開的** crinhealthcare.org 工作副本） | zod schema 驗證 |

送出健檢填報時，**其中的彙總數字會自動同步到看板**（見下面「看板同步」）。獨立 pm2 部署於主機，**不隨 astro build**。

> ⚠️ **兩套儲存不可以合併。** `REPO_DIR` 指向的 repo 是 public。附件一那張表上有姓名、電話、電子郵件；電費單與逐筆排放源清單也不是該公開的東西。它們只能走 `AUDIT_DATA_DIR`。

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

兩個實作上的坑，改的時候別踩回去：

- **結構化輸出與 citations 不能併用**（API 會回 400）。所以頁碼是**放進 schema 自己收**（`pages` 欄），不是走 citations。
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
pnpm test                   # schema 對所有現有院所 JSON 做回歸
```

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

> 改 `src/*` 後要 `pm2 restart ems-admin`；`public/*` 是靜態檔、存檔即生效（伺服器對靜態檔送 `no-store`）。
