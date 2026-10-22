# ems-admin 改版工作清單（貼紙點位＋三類填報）

> 立項：2026-10-22。需求依據：`docs/energy-audit-spec.md`（業主提供的能源盤點欄位與業務規則）。
> 雛形（業主已確認方向）：掃貼紙只記「這一次會變的東西」；設備型號、容量、年份在管理端建一次，貼紙頁不出現。
> 三類名稱固定為：**初始建檔／定期更新／異動登錄**。

## 勾選規則

- `[x]` 只能在**完成且驗證過**才勾，並在該項後面補上證據：commit、測試名稱、截圖路徑或線上網址。沒有證據的 `[x]` 視同未完成。
- 卡住的項目維持 `[ ]`，在下面寫「⛔ 卡點：…」。
- 業主同意不做的項目改成 `[-]` 並寫明日期與原話。

## 架構約定（各項實作都照這份，改動要同步更新本節）

**儲存**：全部落在 `config.dataDir`（主機本地、沒有 remote 的 git 倉庫），檔案 `inventory/<hid>.json`。**不可寫進 REPO_DIR（public repo）**。照片走 `config.uploadsDir/<hid>/inventory/`。

**資料結構**（`inventory/<hid>.json`）：

```
{
  version: 1,
  site:      { basic, meters[], buildings[], transformers[], generators[], staff[], org[], policy, exemption },   // 初始建檔：附表三 一～四、七、八；R1/R2
  equipment: [ { id, pointCode, building, category: 'ac'|'lighting'|'other', kind, fields{…表九欄位}, status: 'active'|'replaced'|'removed', replacedBy?, createdAt, updatedAt } ],
  points:    [ { code, domain: 'power'|'water', name, location, items[], active } ],
  records:   [ { id, pointCode, period: 'YYYY-MM', at, who, values{itemId: value}, note, photos[], anomalies[] } ],   // 定期更新
  changes:   [ { id, at, who, reporter, kind, target, before, after, reason, links? } ],                            // 異動登錄
  measures:  [ … ],  plans: [ … ]                                                                                  // 診斷措施、節能計畫（附件一、二）
}
```

**連結一律存 id**：設備主檔與變壓器的建築存 `site.buildings[].id`（schema 欄位型別 `ref`，`ref:'buildings'`）；設備與點位的連結以**點位項目的 `equipmentId` 為準**，設備主檔的 `pointCode` 只是跟著它的副本。

**操作人姓名（reporter）**：帳號一院一組。所有改變狀態的 `/api/inv`、`/api/inv/report` API 都收選填 `reporter`（trim 後 ≤ 20 字，超過 422 `validation`）；有填時 who＝「姓名（院名）」並另存 `reporter`，沒填 who 只有院名、reporter 為 null。規則在 `inventory-schema.js` 的 `parseReporter`／`whoLabel`。管理端頂部「操作人」欄與貼紙頁「填寫人」共用 localStorage key `ems.sticker.reporter`（`spec.reporter.storageKey`）。

**點位代碼**：`<hid>-<E|W><兩位數>`，例 `803-E07`。E＝電、W＝水。以最後一個 `-` 切出 hid。

**點位項目類型（`items[].type`）**——表單依此動態產生，新增點位或改欄位不改程式：
`reading`（累計讀數，自動算用量）／`status`（狀態選項，預設 正常／異常／停機，可自訂 options）／`bill`（電費單，拍照解析＋逐格確認，沿用 extract.js 與複驗閘門）／`number`（一般數值）／`text`／`photo`。
共同欄位：`id, label, unit?, equipmentId?, meterId?, options?, warnPct?, required?`。

**路由**：

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/s/:code` | 貼紙落地頁（`public/s.html`），不需登入即可載入頁面 |
| GET | `/api/inv/point/:code` | 點位表單（項目＋上次值＋院名）。未登入 401；hid 不符 403 |
| POST | `/api/inv/point/:code/record` | 送出一次紀錄 → 回 `{record, usage, warnings}` |
| POST | `/api/inv/point/:code/photo` | 上傳照片（multipart） |
| GET | `/api/inv` | 整份資料（管理端） |
| GET | `/api/inv/spec` | 初始建檔欄位規格、設備類別欄位、項目類型 |
| PUT | `/api/inv/site/:block` | 更新初始建檔某區塊 |
| POST／PUT | `/api/inv/equipment`、`/api/inv/equipment/:id` | 設備主檔新增／修改（修改自動寫一筆 changes） |
| POST／PUT | `/api/inv/points`、`/api/inv/points/:code` | 點位新增／修改 |
| GET | `/api/inv/points/:code/qr.png` | 該點位網址的 QR 圖檔 |
| GET | `/api/inv/progress?period=YYYY-MM` | 本期進度：各點位是否已記錄、未結異常 |
| GET／POST | `/api/inv/changes` | 異動登錄 |
| GET | `/api/inv/report/:kind` | 申報表與報告產出（kind：`annex3`、`diagnosis`、`plan`） |
| GET | `/api/inv/report/spec` | 措施、計畫、診斷團隊的欄位規格與依據 |
| GET／POST | `/api/inv/report/measures` | 診斷措施（附件一 3.2／3.3）列表／新增 |
| GET／PUT／DELETE | `/api/inv/report/measures/:id` | 單筆措施；R6 強制列入的 DELETE 回 409 |
| GET／POST | `/api/inv/report/plans` | 節能計畫（附件二）列表／自願納入 `{measureId}` |
| PUT／DELETE | `/api/inv/report/plans/:id` | 修改（R7 檢核、R8 版本紀錄）；R7 強制納入的 DELETE 回 409 |
| GET／PUT | `/api/inv/report/diagnosis-data` | 診斷報告主檔（提報日期、期別）與診斷團隊（3.4） |
| GET | `/api/inv/report/deadlines` | 期限提醒（含 ISO 證書、技師執照效期） |
| GET | `/api/inv/report/missing?kind=annex3\|diagnosis\|plan&year=N` | 該份報表的待補欄位清單（JSON） |
| POST | `/api/login` | 新增 `remember: true` → session 30 天（貼紙頁用） |
| POST | `/api/inv/anomalies/:id/close` | 未結異常結案 `{note}` → `{anomaly}`；已結案 409（後端實作時新增） |
| GET | `/api/inv/photo/:id` | 讀回已上傳的照片（後端實作時新增） |

**後端實作補充（2026-10-22，`src/inventory-routes.js`）**——前端與報表照這份接：

- 路徑帶點位代碼的，代碼切出的 hid ≠ session.hid 一律 403 `forbidden_hospital`；代碼格式錯 400 `bad_code`。改變狀態的請求 Origin 不符 403 `bad_origin`。點位停用 410 `point_inactive`。
- `GET /api/inv/point/:code` → `{ hid, hospitalName, point:{code,domain,name,location,active,url,items[ …item, options(狀態型已補預設), equipmentName, meterNo?(有 meterId 才有；電號已刪則 null), last:{value,usage,at,period}|null ]}, lastRecord:{id,at,period,who,reporter}|null, period, nextPeriod, recordedThisPeriod, source:{doc,law?,text}, billColumns? }`。`billColumns` 只在點位有 bill 型項目時附上（同 spec.billColumns），貼紙頁不必再打 `/api/inv/spec`。
- `POST /api/inv/point/:code/record` body `{ values:{itemId:值}, period?='本月(台灣時間)', note?, photos?:[photoId], confirmDecrease?:[itemId], reporter? }` → `{ record, usage, warnings, period, nextPeriod, commit }`。
  - 422 `validation`（`details:[{ itemId|null, message }]`；itemId 指向出錯的項目，同名 label 的多台設備靠它分；null＝不屬於某項目，例：不認得的項目、填寫人過長。**只有這支**是這個形狀，其他 API 的 validation details 仍是字串陣列）／422 `reading_decreased`（`details:[{itemId,label,prev,prevAt,value,message}]`；把該 itemId 放進 `confirmDecrease` 重送＝確認換表或歸零，本次用量記 null）／409 `unverified`（電費單有 todo/low 格子，`pending[]`）／422 `photo_missing`。
  - 任何 status 值為「異常」而 note 空白 → 422 `validation`，每個異常項目一筆 `{ itemId, message:'設備回報異常時請在備註寫明狀況' }`。
  - `reporter`：填寫人姓名（選填，trim 後最長 20 字，超過 422 validation itemId null）。帳號一院一組，有填時 `record.who`＝「姓名（院名）」，另存 `record.reporter`（沒填為 null，who 只有院名）。progress 的 `lastBy`、異常的 `reportedBy` 都取 `record.who`，因此帶得到姓名。貼紙頁把姓名記在該手機 localStorage（`ems.sticker.reporter`），下次自動帶入。其他寫入 API 的 reporter 見下面「操作人姓名（2026-10-22 補）」。
  - 值的形狀：reading/number 數字；status 選項字串（值為「異常」→ 開一筆 anomaly）；text 字串；photo 為 photoId 陣列；bill 為 `{ values:{電費單欄位(同 audit bills)}, meta:{欄位:{state,source}} }`。
  - record 比上面的資料結構多 `usage:{itemId: 數字|null}`（第一次抄表為 null）與 `reporter:姓名|null`。anomaly 形狀 `{ id, itemId, label, value, equipmentId, equipmentName, note, openedAt, closedAt, closedBy, closeNote }`。
- `POST /api/inv/point/:code/photo` multipart：`file`（jpg/png/webp/pdf）、`itemId?`。回 `{ photo:{id,…} }`；itemId 是 bill 型時另回 `{ rows, notes, stats, parseError }`（extract.js 解析，**只是提案**）。
- `GET /api/inv/progress` → `{ period, nextPeriod, points:[{code,name,location,domain,recorded,records,lastAt,lastBy}], total, done, openAnomalies:[…anomaly, recordId, pointCode, pointName, period, reportedBy] }`（只算 active 點位）。
- `PUT /api/inv/site/:block` body `{ value, reason?, reporter? }`：form 區塊是物件、table 區塊是陣列；**table 每筆自帶 `id`**（沒給就自動配），點位項目的 `meterId`、設備與變壓器的 `building` 都用這個 id 連結。區塊原本有資料**且有變動**時寫一筆 change（staff → `staff`，其他 → `site`），此時**沒有 `reason` → 422 `reason_required`**；第一次建檔、沒變動不需要原因。`ref` 欄位（變壓器的建築）存檔時給名稱也會換成 id，對不上保留原文字並回 warning（不擋存檔）。
- `POST /api/inv/equipment` body `{ equipment:{ building?(buildings[].id), category, kind, fields, pointCode?, status? }, reason?, reporter? }`：初始建檔不記異動，帶 `reason` 才記 `equipment.add`。`PUT /api/inv/equipment/:id` body `{ equipment:{部分欄位；fields 為整包取代；replacedBy?}, reason, changeKind?('equipment.correct' 等), reporter? }`：有變動就寫 change（status→replaced 記 `equipment.replace`、→removed 記 `equipment.remove`），**有變動沒有 `reason` → 422 `reason_required`**；沒變動回 `unchanged:true`（不要原因）。
  - **汰換連結**：status 改 `replaced` 時可帶 `replacedBy`（新設備 id，也接受放在 body 頂層）。新設備須存在、使用中、不是自己；status 不是 replaced 卻帶 replacedBy → 422。成功時：所有點位項目的 `equipmentId` 從舊 id 改指新 id、新設備 `pointCode` 承接舊的（舊的沒有就取第一個改指過來的點位）、舊設備存 `replacedBy`，全部記在**同一筆** change：`after.replacedBy`、`links:{ replacedBy, items:[{pointCode,itemId,label}], newPointCode:{from,to} }`；回應另附 `relinked`（＝links）。管理端「設備汰換」流程：先建新設備（POST，帶 reason），再 PUT 舊設備 `{status:'replaced', replacedBy}`。
  - 回應 `linkedItems:[{pointCode,pointName,active,itemId,label}]`：設備不是使用中（移除、或汰換沒指定新設備）時仍連到它的點位項目；管理端據此提示去點位移除或改連（舊後端沒有這欄時前端自己從點位算）。
- `GET /api/inv` 另回 `linkIssues`（`equipmentLinkIssues`）：`item_missing_equipment`（項目連到不存在的設備）、`item_inactive_equipment`（連到已汰換／移除的設備，帶 `replacedBy`）、`equipment_point_mismatch`／`equipment_point_unlinked`（使用中設備的 `pointCode` 與連到它的點位項目不符；`expected`＝應改成的點位或 null）。管理端在「點位與進度」列出，設備類可一鍵「依點位項目修正」（PUT pointCode，原因自動帶「依點位項目同步設備所屬點位」）。以及 `siteRefIssues`：ref 欄位對不上的清單 `[{block,rowId,field,value,message}]`，管理端在建檔總覽與該區塊標「待修」，附表三表八的待補欄位也會列出。
- 舊資料的建築物名稱：`inventory-store.js` 讀檔時（`resolveSiteRefs`）用名稱、其次編號對回唯一一筆建築的 id；對不上保留原文字。發電機的官方欄位（表八：編號、容量、電壓）沒有建築物名稱，所以只有變壓器用 ref。
- **操作人姓名（2026-10-22 補）**：上面每支寫入 API（site、equipment、points、anomalies close、changes）與 `/api/inv/report/*` 的 POST／PUT 都收 body `reporter`，DELETE 收 `?reporter=`。寫進 `change.who`／`change.reporter`、異常結案的 `closedBy`／`closedReporter`、計畫版本的 `who`／`reporter`，以及資料倉庫的 git commit 訊息。照片上傳不記人（照片隨紀錄送出時才有填寫人）。
- `POST /api/inv/points` body `{ point:{ domain, name, location?, items, active?, code? } }`：不給 code 自動配下一號（停用的號碼不重發）；`PUT /api/inv/points/:code` 只能改 name／location／items／active，改 code 或 domain 回 422；有變動記一筆 `point` change。
- `GET /api/inv/changes` → `{ items(新的在前), kinds }`；`POST /api/inv/changes` body `{ change:{ kind, target?, before?, after?, reason(必填) } }`，kind 見 spec.changeKinds。
- `GET /api/inv/points/:code/qr.png?size=512&download=1`：網址前綴取 `config.publicBaseUrl`（環境變數 `PUBLIC_BASE_URL`，預設 `https://ems-admin.crinhealthcare.org`）。
- `GET /api/inv/spec` → `{ spec:{ fieldTypes, site[], equipment:{categories,status}, itemTypes, statusDefaults, anomalyValue, domains, changeKinds, billColumns, exemptionCodes, chillerGroupMonth, measureCodes }, extraction, maxBytes, baseUrl }`；區塊、欄位群（`groups[]`）、設備類別、項目類型、部分欄位都帶 `source:{doc,ref,law,spec?,note?}`。
- `/api/inv/report/:kind` 分派到 `src/report-routes.js`：`export async function handleReport({ req, res, sess, kind, json, readBody, originOk, readInventory })`，回 truthy 表示已處理；檔案不存在時回 501。

**申報與報告補充（2026-10-22，`src/report-schema.js`／`report-model.js`／`report-xlsx.js`／`report-routes.js`，前端 `public/inventory-report.js` 掛 `window.EMSInventoryReportUI.mount(el, ctx)`）**：

- `measures[]`：`{ id, type:'replace'|'operation', equipmentId?, origin:'r6'|'manual', fields{…附件一欄位, energyType(E01–E06), officialCode(§7.7), replaceCategory?, secret?, note}, createdAt, updatedAt }`。設備汰換沒填的格子沿用設備主檔（名稱、廠牌、型式、製造年份、容量、數量、運轉時數）。
- `plans[]`：`{ id, measureId, origin:'r7'|'manual', fields{ completionYear(民國), note, status:規劃中|執行中|已完工|取消, actualDoneDate, officialCode }, versions:[{ v, at, who, reporter, before, after, reason }] }`。名稱、年節能量、投資、回收年限一律從措施即時帶出（措施 ID 貫穿）。
- `diagnosis{ reportDate, period, teams:[{ id, name, type, code(Q-L1…Q-E1), commissioned, docs, licenceDiscipline, licenceNo, licenceExpiresAt, members[] }] }`：附件一報告主檔＋3.4 診斷團隊。放 measures 旁獨立區塊、不放 site（site 建完唯讀，團隊每期會換）。提報日期的年度＝R6 機齡與 R7 完工年度的「提報年度」，沒填用今年。
- R6／R7 自動帶入用決定性 id：R6 `m-eq-<設備id>`、R7 `p-<措施id>`。GET 時在記憶體補上（不寫檔），任何寫入前先落地。強制與否每次即時判定；強制的 DELETE 回 409 `mandatory`（帶 `rule`、`source`）。
- 計畫 PUT：`planRowCheck` 不過回 422（`rule:'R7'`）；改掉已填過的值須帶 `reason`，否則 422 `reason_required`（R8）。每次變動寫一筆 version，並寫 changes（`plan.change`；狀態改「已完工」記 `measure.done`）。
- 表九之一（二）冰水機群組月效率：**不另建月表，從點位紀錄推導**。點位項目新增兩個可選屬性 `chillerGroup`（群組名稱，對應設備主檔的冰水機群組名稱）、`chillerRole:'kwh'|'rth'`（要一起設定，只限 reading／number 型；舊點位不受影響）。某群組某月＝該期別紀錄加總（reading 取用量、number 取數值）；建築取同群組設備的建築；群組總容量＝中央空調主機容量（單位 RT）×數量。
- xlsx：每張工作表第 1 列表名、第 2 列「依據：文件 表號｜文號（日期）｜註」、第 3 列院所與資料年；推不出的格子留空並列入最後的「待補欄位」工作表。表五之二月份以帳單載明的計費期間為準，同電號同月多筆取最後送出的那筆。產檔用 `src/xlsx.js` 新增的 `buildWorkbook()`。

**前後端共用計算**：`public/inventory-compute.js`（同 `audit-compute.js` 的掛法：瀏覽器一般腳本、伺服器 import 後讀 `globalThis.EMSInventoryCompute`），放 R1–R9、用量、EUI、kW/RT、回收年限、機齡、期限。R6 的設備類別只用 `equipmentReplaceCategory(eq)`（管理端、報表、伺服器同一支，各自不再有對應表）：日光燈、省電燈泡＝螢光燈具（2 年）；LED＝LED 燈具（8 年）；其他燈種回「其他」＝不套門檻；空調與其他系統＝公用設備（10 年）。

**部署**：production（pm2 `ems-admin`，port 8470）的工作目錄就是 `services/ems-admin`，`public/` 存檔即上線、`src/` 要重啟才生效，前端改動必須在舊後端上也不壞（`/api/inv` 拿不到時 `app.js` 維持舊版；新回應欄位缺了要有退路）。

**樣式**：`public/` 只准 `tokens.css`／`style.css`（`scripts/check-design.mjs` 守門），顏色只用 oklch token、字級只用 `--text-*`（≥18px）。

**檔案分工**：各項標註主要檔案；同一個檔案只由一項負責，`server.js` 只加一行分派到 `inventory-routes.js`。

## 工作項目

### 一、貼紙點位（定期更新）

- [ ] 1. 點位資料與項目類型：`inventory-schema.js` 定義點位、六種項目類型與驗證；`inventory-store.js` 讀寫（互斥鎖、git commit、無 remote）。
- [ ] 2. 每個點位固定網址 `/s/<代碼>`；QR 圖檔端點（QR 與 NFC 寫同一網址）。
- [ ] 3. 貼紙落地頁（手機）：依點位設定動態長表單——讀數、設備狀態、電費單拍照帶入＋逐格確認、備註、照片；設備只顯示名稱。
- [ ] 4. 自動算用量（本次讀數 − 上次），跟上次用量差超過 `warnPct` 時提示；讀數小於上次時擋下並請確認。
- [ ] 5. 送出後畫面：成功與否、本次用量、下次填寫期間；設備回報異常列入「未結異常」。
- [ ] 6. 登入：貼紙頁未登入先登入，可選「這支手機記住 30 天」。

### 二、管理端

- [ ] 7. 點位管理：新增／修改／停用點位、設定項目、連結設備與電號；列出每個點位網址；下載單張與全部 QR。點位改名或搬家網址不變。
- [ ] 8. 本期進度：各點位本期是否已記錄、未結異常清單（可結案）。
- [ ] 9. 初始建檔：基本資料（表三）、電號、建築（表七）、變壓器與發電機（表八）、能管人員（一、二）、查核組織與政策（表四）、能源用戶判定與排除條件（R1／R2）；設備主檔依表九三類欄位，表單由 `/api/inv/spec` 動態產生；建完預設唯讀。
- [ ] 10. 異動登錄：設備新增／汰換／移除／規格更正、人員異動、措施完工、計畫變更；每筆記時間、人、前後差異、原因。
- [ ] 11. 院區主檔＝現有 16 個客戶（看板 id／帳號），寫進 `docs/ems-admin-units.md`。軍醫局令名單中非客戶的單位不納入（業主 2026-10-22）。

### 三、自動產出

- [ ] 12. 診斷措施與節能計畫的資料輸入（附件一 3.2／3.3／3.4、附件二），措施 ID 貫穿到計畫。
- [ ] 13. 產出附表三年度申報、節能診斷報告（附件一）、節能計畫（附件二）為 xlsx；只留系統推不出的欄位給院方補。
- [ ] 14. 規則自動化：R1、R2 到期、R5 回收年限、R6 機齡強制列入、R7 回收 < 10 年強制納入與備註必填、R9 各項提示、EUI／kW/RT／PUE 計算。
- [ ] 21. 引用條款上畫面：每個區塊、欄位群、規則提示、期限提醒都標出依據（公文文號、法條、附件／附表與表號、註記），例如「附表三 表九之一（三）」「附件一 註 2」「經能字第 11558001660 號」。依據寫在 schema 與計算庫的 `source` 欄位（單一來源），畫面與產出報表都從那裡讀；點一下可展開原文摘錄。貼紙頁只在頁尾放一行依據。
- [ ] 15. 期限提醒：每年 1 月底、3/31、第一期 117-03-31、ISO 50001 證書與技師執照到期。

### 四、資料與收尾

- [ ] 16. 舊資料轉移：現有健檢填報（bills／majorLoads／chillers／basic／contact）轉進新結構，原檔保留不刪。
- [ ] 17. 附表三最新版逐欄核對（spec 標 🔄 處）、公噸油當量換算係數、能源署申報系統匯入格式；結果補進 `docs/energy-audit-spec.md`。
- [ ] 18. README 更新（新結構、路由、禁止事項）。
- [ ] 19. `pnpm test` 全過、`node scripts/check-design.mjs` 全過。
- [ ] 20. 部署上線（pm2 restart ems-admin），線上建臨時帳號實測：手機寬度掃描頁、送出、管理端 QR；截圖存證後移除臨時帳號。

## 需要業主決定或提供

- ~~國軍醫院是否屬「國軍部隊用戶」排除對象~~ → 2026-10-22 業主確認：「國軍醫院就是主要執行單位，不是排除」。系統一律視為要辦理，EX01 不套用於醫院。
- 各院區契約容量是否合併計算。
- 水足跡要記的項目（目前預設：水表讀數＋有無異常）。
- 各院點位清單（業主提供，或院方在管理端自建）。
- 設備異常通知對象與管道（目前只在管理端列「未結異常」，不對外發送）。
