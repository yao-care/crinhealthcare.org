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
  site:      { basic, meters[], buildings[], transformers[], generators[], staff[], org[], policy, exemption,       // 初始建檔：附表三 一～四、七、八；R1/R2
               waterScope, waterActivity[], waterSources[], waterUnits[], waterDischarges[],                    // 水足跡盤查（ISO 14046／46001，第 23 項）
               waterQualityPlan[], waterUpstream[] },                                                          // 水質檢測項目覆寫、間接用水其他上游（第 26 項）
  equipment: [ { id, pointCode, building, category: 'ac'|'lighting'|'other', kind, fields{…表九欄位}, status: 'active'|'replaced'|'removed', replacedBy?, createdAt, updatedAt } ],
  points:    [ { code, domain: 'power'|'water', name, location, items[], active } ],
  records:   [ { id, pointCode, period: 'YYYY-MM', at, who, values{itemId: value}, note, photos[], anomalies[] } ],   // 定期更新
  changes:   [ { id, at, who, reporter, kind, target, before, after, reason, links? } ],                            // 異動登錄
  measures:  [ … ],  plans: [ … ]                                                                                  // 診斷措施、節能計畫（附件一、二）
  annual:        { [N]: { [blockId]: 物件|陣列, _meta:{ [blockId]:{at,who,reporter} } } },                         // 年度報表資料（資料年 N，第 24 項）；含 waterMonthly（第 26 項）
  snapshots:     { [N]: { at, site:{ [blockId]: 值 }, equipment:[…] } },                                         // N 年沿用確認當下的主檔快照
  confirmations: { [N]: { [unitId]: { at, who, reporter, hash, diffCount, copied? } } }                          // 年度沿用逐區塊確認
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
| GET | `/api/inv/points/template.xlsx` | 點位匯入範本（`?blank=1` 不帶現有點位） |
| POST | `/api/inv/points/import` | 點位批次匯入：預設只預覽，`apply: true` 才寫入（`src/points-import.js`） |
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
| GET | `/api/inv/report/table?year=N` | 可單獨匯出的表清單（tableId、章節、工作表數、待補數）（第 24 項） |
| GET | `/api/inv/report/table/:tableId?year=N&format=xlsx\|csv\|json` | 單表匯出；xlsx 附該表的待補欄位 |
| GET | `/api/inv/report/bundle?year=N` | 整包 zip：每張表一個 CSV＋三本 xlsx＋節能計畫匯出檔 |
| GET | `/api/inv/report/filing?year=N` | 申報對照頁資料：依附表三章節順序的欄位：值、待補與填寫處 |
| GET | `/api/inv/report/plan-export?format=xlsx\|csv` | 節能計畫匯出檔（＝`table/a2-export`） |
| GET | `/api/inv/report/table/a1-equip`、`/api/inv/report/table/a1-equip-due`（`?format=xlsx\|csv`） | 節能診斷設備清單：全部設備／僅使用年限達應辦理節能診斷（第 28 項） |
| GET／PUT | `/api/inv/report/annual?year=N`、`/api/inv/report/annual/:block?year=N` | 年度報表資料（N 與 N-1）／存一個年度區塊 `{ value }` |
| GET／POST | `/api/inv/report/carryover?year=N`、`/api/inv/report/carryover/:unit?year=N` | 年度沿用：差異與確認狀態／確認 `{ expectHash?, copy? }` |
| GET | `/api/inv/report/water?year=N` | 水足跡盤查清冊 xlsx（N＝民國資料年，4 位數視為西元；`format=json` 另回 `summary`）；待補清單用 `missing?kind=water` |
| GET | `/api/inv/report/water-verification?year=N` | 水足跡第三方查證資料包 zip（ISO 14046 第 7 章；第 26 項，`src/report-water-verify.js`）；年格式錯 400 `bad_year` |
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
- **點位批次匯入（2026-10-22，第 25 項，`src/points-import.js`；`inventory-routes.js` 在點位代碼比對之前分派）**：
  - `GET /api/inv/points/template.xlsx[?blank=1]`：三張工作表——「點位清單」（欄：點位代碼、類別、名稱、位置、項目 id、類型、標籤、單位、選項、warnPct、連結設備編號、連結電號；一列一個項目；點位代碼填「範例」的列匯入時略過；預設接著列出本院現有點位，改完上傳＝更新）、「說明」、「設備與電號」對照。
  - `POST /api/inv/points/import`：multipart（`file`＝xlsx／csv，文字欄 `apply`、`reporter`、`reason`）或 JSON `{ rows:[{欄名或英文 key: 值}], apply?, reporter?, reason?, source? }` → `{ ok, applied, nothing, preview:{ ok, counts:{add,update,unchanged,error,skipped,rows}, points:[{ action:'add'|'update'|'unchanged'|'error', code, autoCode, domain, name, location, items, rows[], errors[{row,message}], warnings[], changes[] }], errors[{row,code,name,message}], warnings[] }, change, commit }`。預覽不寫入；`apply` 時在鎖內重算，有任何錯誤回 422 `import_errors`（帶 preview）且整批不寫；沒錯就整批一次 commit、寫一筆 `point.import` 異動（`target:'points'`、`before.updated[]`、`after.{added[],updated[]}`、`links.{added,updated,source,equipmentPointCode?}`）。
  - 分組：有代碼依代碼、沒代碼依名稱；代碼名稱都空白的列接續上一列的點位。既有點位依代碼更新名稱／位置／項目（有項目列＝項目整批以檔案為準；沒有項目列＝保留原項目），代碼與類別不可改。項目 id 空白時沿用同標籤同類型的既有項目 id，否則自動配 `<類型><n>`；同 id 既有項目的其他屬性（冰水機群組、水足跡流向等）沿用。連結設備編號依序比對設備 id、`fields.deviceNo`、`fields.name`（須唯一），連結電號比對 `site.meters[].meterNo`；對不上列為錯誤。連到的使用中設備若還沒有 `pointCode`，套用時補上。
  - 維護者 CLI：`node scripts/import-points.mjs <hid> <file.xlsx|file.csv> [--apply] [--reporter 姓名] [--reason 原因] [--json]`，預設只預覽，直接寫 inventory-store（`AUDIT_DATA_DIR`），who＝「姓名（維護者）」。
- **R1 不合併計算（2026-10-22，第 22 項）**：`energyUserCheck` 一律以單一電號的經常契約容量判定（任一電號 > 800 瓩即為能源用戶），`combine` 參數忽略；電號的「合併申報」、排除條件區塊的「同一登記主體契約容量合計」只作附表三表三與附錄二的輸出資料。
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

**水足跡盤查（2026-10-22，第 23 項；規格 `docs/water-footprint-spec.md`）**：

- 盤查（ISO 14046 5.3）＋缺水足跡衝擊評估（5.4，AWARE2.0；第 26 項）；依 3.3.1 註 1，衝擊結果一律稱「缺水足跡」，清冊名稱維持「水足跡盤查清冊」。條號依據寫在 `src/water-schema.js` 與計算庫的 `source`（`specDoc` 指向水足跡規格）。
- 初始建檔新增 5 個區塊（`src/water-schema.js` 的 `WATER_SITE_BLOCKS`，接在 `SITE_BLOCKS` 後面，`navGroup` 讓管理端另成「水足跡盤查」一組）：`waterScope`（form：目的、系統邊界、截斷準則、報告單位、流域、時間代表性、資料品質、基線年、目標）、`waterActivity`（table，一年一筆：住院人日、門急診與住院人次、員工 FTE、樓地板面積）、`waterSources`（水源類型、水號、水質類別、取水水體）、`waterUnits`（用水單元、建築 ref、用水型態、消耗比例、主要用水、估計占比）、`waterDischarges`（去向、承受水體、許可文號、水質檢測項目）。
- 點位項目新增選填屬性（只限 `domain:'water'`，舊點位不受影響）：`waterFlow: 'intake'|'use'|'discharge'|'reuse'|'quality'|'saving'`（只限 reading／number；quality、saving 只限 number）、`waterSourceId`、`waterUnitId`、`waterDischargeId`（連到上面三個 table 的 id，須存在）、`waterParam`（水質項目）。檢查在 `waterItemErrors()`。
- `GET /api/inv/spec` 多回 `spec.water`：`flows`、`pointTemplates`（9 個用水點位範本：自來水總表、地下水、雨水回收、院內回收水、冷卻水塔補水、用水單元分表、污水排放、水質抽測、節水改善回報）、`reportingUnits`、`qualityParams`。前端沒有 `spec.water`（舊後端）就不顯示範本、水屬性欄與報表卡片。
- 計算在 `public/inventory-compute.js` 檔尾另一段 IIFE（不動既有函式）：`waterFlows`、`waterActivityOf`、`waterPerformance`、`waterBaselineCompare`、`waterCompleteness`、`waterInventory`。單位 m³，公升自動 ÷1,000；整院沒有任何項目標 `intake` 時，水類點位的讀數推定為取水（`inferred`）。
- 報表 `src/report-water.js` 的 `buildWater()`，由 `report-routes.js` 的 `BUILDERS.water` 分派；工作表：目的與範疇、取水、主要用水單元、排放與回收、水平衡、水質、績效指標與基線、資料品質、節水改善回報、待補欄位。
- 貼紙頁頁尾依據（水類點位）：ISO 14046 5.3、ISO 46001 9.1。

**水足跡延伸（2026-10-22，第 26、27 項；規格 `docs/water-footprint-spec.md` §9～§13）**：

- 係數常數全部在 `public/inventory-compute.js` 第三段 IIFE（前後端同一份，帶版本與來源）：`WATER_AWARE`（AWARE2.0：全國、7 個縣市、18 個流域）、`WATER_ELEC`（台電 2025 永續報告書：耗水 0.0605、取水 0.0651 L/kWh）、`WATER_EFFLUENT`（放流水標準 附表八 醫院預設 8 項、預設頻率每半年）。函式：`waterElectricityKwh`、`waterIndirect`、`waterScarcity`、`waterQualityRules／Check／LimitText／Warnings／Assess`、`waterTargets`，整合成 `waterFootprint(inv,{year})`（＝`waterInventory`＋indirect、scarcity、quality、targets，完整度多 3 項檢查）。報表與管理端只呼叫 `waterFootprint`。
- `site.waterScope` 新增 `targetIndicator`、`elecWaterFactor`、`elecWaterFactorNote`、`awareRegion`（AWARE 地區 id，預設 `TWN`）、`awareUse`。系統邊界選「＋間接用水」＝外購電力的發電用水計入合計（`boundary` 含「間接」）。
- 新 site 區塊（`water-schema.js`）：`waterQualityPlan`（`{ dischargeId(ref waterDischarges), param, unit, limitMin, limitMax, frequency, basis, note }`；某排放口有任一列即整組覆寫，沒有列且去向「自設污水處理設施後放流」才套預設組）、`waterUpstream`（外購蒸汽、藥品耗材等，只登錄不量化）。`waterDischarges` 多 `defaultFrequency`（每季／每半年）。
- 每月營運活動：年度區塊 `annual[N].waterMonthly`（`report-annual.js`，kind months，`water:true`＝不屬附表三、不進欄位盤點）；`waterActivityOf` 有月資料的項目以月合計為準，`waterPerformance` 只拿取水與分母同月都有的月份相除。院方在「申報與報告 › 報表資料輸入」填（`PUT /api/inv/report/annual/waterMonthly?year=N`）。
- 貼紙送出：水質項目超出限值 → `warnings` 提示（不擋；`inventory-routes.js` 呼叫 `waterQualityWarnings`）。
- 管理端：水足跡卡片（申報與報告 › 措施與計畫）顯示間接用水、缺水足跡、水質超標、目標達成度（`<progress class="r-progress">`）、下載查證資料包；初始建檔「水質檢測項目與頻率」上方列目前生效的項目。第 26 項的畫面元素只在 `spec.water.aware` 存在（新後端）時出現。
- 第 27 項：水足跡工作表進 `TABLES`（`w-01`～`w-11`，kind `water`，chapter「水足跡」，排在附件二之後）→ 單表匯出、整包（`水足跡盤查_N年資料/`）、申報對照頁最後的「水足跡」章節。年度沿用的單位本來就是「每個 site 區塊」，水的 7 個區塊都在內、逐一確認（`annual.waterMonthly` 每年重填，不是沿用單位）。已完工的節能計畫不受 R7「預計完工年度須在提報年度～+4」範圍限制（`report-routes.js` 計畫 PUT 對 `status:'已完工'` 濾掉範圍檢核；其餘 R7、R8 照舊）。

**匯出與年度沿用（2026-10-22，第 24 項；`src/report-export.js`／`report-export-routes.js`／`report-annual.js`／`annex3-fields.js`，前端 `public/inventory-report.js` 的分頁）**：

- **單一來源**：單表 xlsx／CSV、整包 zip、申報對照頁都從 `report-xlsx.js` 的 `buildAnnex3／buildDiagnosis／buildPlan` 同一份工作表挑出來，不另算。`TABLES`（`report-export.js`）是 tableId ↔ 工作表名稱的對照，順序＝新版附表三章節（前言、一～十一、附錄二），之後附件一、附件二；表五之二每電號一張用 `prefix` 對。新增或改名工作表要同步改 `TABLES`（`test/export.test.js` 會擋）。
- `handleReport` 解析完操作人後先呼叫 `handleExport({ res, sess, method, head, id, q, body, A, json, readInventory, today })`，回 null 才走原本的分派。`year` 一律民國資料年，沒給＝今年－1；格式錯 400 `bad_year`。
- 工作表列可帶 `meta.fill`（`report-xlsx.js` 的 `FILL`）：`{ section:'i-site-<block>'|'i-eq-<cat>'|'i-points' }`＝管理端分區，`{ tab:'annual', block }`／`{ tab:'work', anchor:'plans'|'measures'|'diagnosis' }`＝申報與報告的分頁；`meta.cells[i]` 可逐格覆寫。申報對照頁的「去填」照這個跳。xlsx 產檔不看 meta。
- CSV：UTF-8 BOM、CRLF、與 xlsx 同一份列（含抬頭三列）。zip 用 `src/xlsx.js` 的 `zip()`（`Map` 輸入，零相依）。
- **年度報表資料 `annual[N]`**（`report-annual.js` 的 `ANNUAL_BLOCKS`）：附表三每年重填、系統原本沒有來源的欄位——表五之一燃料帳單（months）＋供應商、表五之三夏季最大運轉噸數、表五之四／五之五 EUI 差異原因與 N-1 年面積覆寫、表六熱能用途、表九之一（二）備註、表九之四年平均運轉容量、表九之七蒸汽鍋爐自我檢測、表九之八 PUE、表十之三 需量反應／再生能源、表十之四可扣除用電量、表十一之三、表十一之四、附錄二。kind：form／table（每筆自帶 id）／months（1–12 月）。電號、建築、人員、鍋爐一律存 site／設備主檔的 id（`ref`），不重打。存檔不寫 changes，只記 `_meta`（時間、操作人）與 git commit。
- **節能計畫新增欄位**（`PLAN_FIELDS` 的 group「申報表十／十一」）：改善前／後狀況、執行計畫期間起迄（`month` 型，存西元 YYYY-MM）、數值來源、節能量計算方式＋說明、實際總節能量、實際投資金額、抑低尖峰需量、所需人力。表十與表十一共用同一筆計畫，不另存。表十措施來源：N-1 年完工＝跨年度成效；效益計算期間＝完工（或執行迄月）次月起 12 個月、截在該年。狀態「已完工」的計畫不受 R7 完工年度範圍限制（第 27 項起，改完工年度也不擋；R8 原因照舊）。
- **設備主檔新增欄**（其他系統·鍋爐）：`opManagement` 操作管理現況、`maintenance` 維護現況（表九之五，跟著設備存一次）。ISO 50001 證書效期以表四之二為準，排除條件 EX10 留白即沿用；兩處不同列待補。
- **年度沿用**：單位＝每個 site 區塊（`site.<id>`，含之後新增的區塊）、`equipment`（整份設備主檔；比對忽略 pointCode 與時間戳）、stable 的年度區塊（`annual.fuelMeta|pue|renewables|app2`）。site／設備比的是 N-1 年快照 vs 目前主檔；年度區塊比 N-1 vs N，N 空時可 `copy`（`carryClear` 欄位清空，例：再生能源發電量）。確認存 `confirmations[N][unit]`（含 `hash`）與 `snapshots[N]`；目前值的 hash 對不上＝`stale`（需重新確認）。POST 帶 `expectHash` 而內容已變 → 409 `changed`。全部 confirmed 才 `complete`；未完成會列在附表三「待補欄位」。表五之四／五之五的 N-1 年面積取 `snapshots[N-1].site.basic`。
- **節能計畫匯出檔**：`PLAN_EXPORT_MAP`（`report-export.js`）是表頭↔欄位對照（含 `importable` 欄與對回用的 `key: measureId`），`readPlanExport(buf, map)` 用同一份對照讀回。前 8 欄（`official: true`）照能源署公開的節能計畫範例：編號｜設備/措施名稱｜年節能量預估｜單位｜投資金額(元)｜回收年限(年)｜預計完工年度｜備註（第 28 項，來源見 `docs/energy-plan-import-format.md`）；其後是系統附加欄。設備/措施名稱由 `officialPlanName()` 組（設備汰換＝「設備種類/措施名稱」），`dash: true` 的欄空值或 0 寫「-」。讀回時沒有措施 ID 欄（能源署原檔）就改用 `altKey: 'no'`（編號）對列，回傳 `keyField`；「-」讀成空。能源署申報系統的 xlsx 原檔要登入才拿得到，拿到後只改這份對照。
- **節能診斷設備清單**（第 28 項）：`EQUIP_LIST_MAP`／`equipListRows()`／`buildEquipListExport()`，對應申報系統「2.設備清單下載」。前 11 欄照能源署範例（編號｜設備名稱｜廠牌｜型式｜製造年份｜容量｜容量單位｜數量｜運轉時數(小時)｜年耗能量｜年耗能量單位），其後附系統別、設備種類、建築、R6 類別、機齡、是否應辦理診斷、設備 ID。來源＝設備主檔 ac／lighting／other 中使用中的設備；`a1-equip-due` 只列 R6 判定為「是」的。製造年份一律西元（範例如此），年耗能量只有連到設備汰換措施且已填時才帶。
- **匯出檔類表**：`TABLES` 裡 kind 在 `RAW_EXPORTS`（`planExport`、`equipList`）的表自己產檔，不從整本 xlsx 挑工作表，不進申報對照頁，單表 xlsx 不附待補欄位頁；整包 zip 另放（節能計畫匯出 xlsx＋CSV、設備清單兩種 xlsx）。新增這類檔案時在 `RAW_EXPORTS` 登記。
- **欄位覆蓋盤點**：`src/annex3-fields.js` → `docs/annex3-field-map.md`（`node services/ems-admin/scripts/field-map.mjs` 產生；測試比對兩者一致、每個 ref 指到真的欄位）。

**部署**：production（pm2 `ems-admin`，port 8470）的工作目錄就是 `services/ems-admin`，`public/` 存檔即上線、`src/` 要重啟才生效，前端改動必須在舊後端上也不壞（`/api/inv` 拿不到時 `app.js` 維持舊版；新回應欄位缺了要有退路）。

**樣式**：`public/` 只准 `tokens.css`／`style.css`（`scripts/check-design.mjs` 守門），顏色只用 oklch token、字級只用 `--text-*`（≥18px）。

**檔案分工**：各項標註主要檔案；同一個檔案只由一項負責，`server.js` 只加一行分派到 `inventory-routes.js`。

## 工作項目

### 一、貼紙點位（定期更新）

- [x] 1. 點位資料與項目類型：`inventory-schema.js` 定義點位、六種項目類型與驗證；`inventory-store.js` 讀寫（互斥鎖、git commit、無 remote）。　✅ cd7e73e；test/inventory.test.js
- [x] 2. 每個點位固定網址 `/s/<代碼>`；QR 圖檔端點（QR 與 NFC 寫同一網址）。　✅ cd7e73e；test/inventory.test.js（qr.png）
- [x] 3. 貼紙落地頁（手機）：依點位設定動態長表單——讀數、設備狀態、電費單拍照帶入＋逐格確認、備註、照片；設備只顯示名稱。　✅ 50d20cf；public/s.html、sticker.js；390px 截圖實測（scratch 8472/8475）
- [x] 4. 自動算用量（本次讀數 − 上次），跟上次用量差超過 `warnPct` 時提示；讀數小於上次時擋下並請確認。　✅ 50d20cf；test/inventory.test.js（reading_decreased）、inventory-compute.test.js
- [x] 5. 送出後畫面：成功與否、本次用量、下次填寫期間；設備回報異常列入「未結異常」。　✅ 50d20cf；test/inventory.test.js（異常進未結清單與結案）
- [x] 6. 登入：貼紙頁未登入先登入，可選「這支手機記住 30 天」。　✅ cd7e73e；test/inventory.test.js（remember TTL 30 天）

### 二、管理端

- [x] 7. 點位管理：新增／修改／停用點位、設定項目、連結設備與電號；列出每個點位網址；下載單張與全部 QR。點位改名或搬家網址不變。　✅ 50d20cf；public/inventory.js；playwright 功能測試（scratch 8473）
- [x] 8. 本期進度：各點位本期是否已記錄、未結異常清單（可結案）。　✅ 50d20cf；public/inventory.js；playwright 功能測試（scratch 8473）
- [x] 9. 初始建檔：基本資料（表三）、電號、建築（表七）、變壓器與發電機（表八）、能管人員（一、二）、查核組織與政策（表四）、能源用戶判定與排除條件（R1／R2）；設備主檔依表九三類欄位，表單由 `/api/inv/spec` 動態產生；建完預設唯讀。　✅ 50d20cf；public/inventory.js、src/inventory-schema.js；test/inventory.test.js（reason_required）
- [x] 10. 異動登錄：設備新增／汰換／移除／規格更正、人員異動、措施完工、計畫變更；每筆記時間、人、前後差異、原因。　✅ 50d20cf；test/inventory.test.js（replacedBy 改指向、changes）
- [x] 11. 院區主檔＝現有 16 個客戶（看板 id／帳號），寫進 `docs/ems-admin-units.md`。軍醫局令名單中非客戶的單位不納入（業主 2026-10-22）。　✅ eb57b4c；docs/ems-admin-units.md

### 三、自動產出

- [x] 12. 診斷措施與節能計畫的資料輸入（附件一 3.2／3.3／3.4、附件二），措施 ID 貫穿到計畫。　✅ 50d20cf；test/report.test.js（R6/R7 自動帶入、計畫版本）
- [x] 13. 產出附表三年度申報、節能診斷報告（附件一）、節能計畫（附件二）為 xlsx；只留系統推不出的欄位給院方補。　✅ 50d20cf；test/report.test.js（三種 xlsx 產出可讀回）
- [x] 14. 規則自動化：R1、R2 到期、R5 回收年限、R6 機齡強制列入、R7 回收 < 10 年強制納入與備註必填、R9 各項提示、EUI／kW/RT／PUE 計算。　✅ cd7e73e、50d20cf；test/inventory-compute.test.js
- [x] 21. 引用條款上畫面：每個區塊、欄位群、規則提示、期限提醒都標出依據（公文文號、法條、附件／附表與表號、註記），例如「附表三 表九之一（三）」「附件一 註 2」「經能字第 11558001660 號」。依據寫在 schema 與計算庫的 `source` 欄位（單一來源），畫面與產出報表都從那裡讀；點一下可展開原文摘錄。貼紙頁只在頁尾放一行依據。　✅ cd7e73e、50d20cf；schema 與計算庫 source 欄位，test/inventory-compute.test.js（每條規則有 source）
- [x] 15. 期限提醒：每年 1 月底、3/31、第一期 117-03-31、ISO 50001 證書與技師執照到期。　✅ 50d20cf；/api/inv/report/deadlines，test/inventory-compute.test.js

### 四、資料與收尾

- [x] 16. 舊資料轉移：現有健檢填報（bills／majorLoads／chillers／basic／contact）轉進新結構，原檔保留不刪。　✅ 50d20cf；test/migrate.test.js；production 副本 dry-run：0 家可轉
- [x] 17. 附表三最新版逐欄核對（spec 標 🔄 處）、公噸油當量換算係數、能源署申報系統匯入格式；結果補進 `docs/energy-audit-spec.md`。　✅ 6397f07；docs/energy-audit-spec.md
- [x] 18. README 更新（新結構、路由、禁止事項）。　✅ 50d20cf；README「盤點改版」一節
- [x] 19. `pnpm test` 全過、`node scripts/check-design.mjs` 全過。　✅ 50d20cf；pnpm test 121/121、check-design 通過
- [x] 20. 部署上線（pm2 restart ems-admin），線上建臨時帳號實測：手機寬度掃描頁、送出、管理端 QR；截圖存證後移除臨時帳號。　✅ 2026-10-22 業主授權後 pm2 restart；正式網址以臨時帳號 zztest 實測貼紙頁（登入、送出）與管理端（點位、QR），0 個 pageerror；測試帳號與資料已移除（data 倉庫 7b5067d）

### 五、第二輪（業主 2026-10-22 回覆）

- [x] 22. R1 能源用戶判定一律不合併計算契約容量（業主：「不用」）；「合併申報」欄位只留作附表三表三輸出。　✅ 42a13a0；test/inventory-compute.test.js（R1 不合併）；2026-10-22 已重啟上線
- [x] 23. 水足跡依 ISO 規範（ISO 14046 水足跡、ISO 46001 用水效率管理）：研究要記哪些項目 → 用水點位項目範本、初始建檔的水源／用水單元／排放、計算與報告；依據 source 標到條款。　✅ 42a13a0；docs/water-footprint-spec.md、test/water.test.js；2026-10-22 已重啟上線
- [x] 24. 匯出資料完整準備、可重複利用：每張表都能單獨匯出（xlsx／CSV）、照能源署線上申報畫面順序排好的「申報對照頁」方便逐欄貼上、跨表共用欄位只填一次、新年度自動帶入去年不變的資料（院方確認後沿用）。　✅ 42a13a0；docs/annex3-field-map.md（451 欄皆有來源或填寫處）、test/export.test.js；2026-10-22 已重啟上線
- [x] 25. 點位清單兩種來源都要：管理端批次匯入（下載範本 xlsx → 上傳 → 預覽 → 套用）＋維護者用 CLI 匯入業主提供的清單；院方仍可自行新增。　✅ 42a13a0；test/points-import.test.js；2026-10-22 已重啟上線
- 異常通知：維持只在管理端列出（業主：「現在這樣就好」）。

### 六、第三輪（業主 2026-10-22 回覆）

- [x] 26. 水足跡延伸（業主：「都要」）：衝擊評估（缺水足跡，AWARE 特徵化因子）、間接用水（外購電力等）納入系統邊界、床日數與門急診人次由院方填報、基線年與節水目標設定、水質檢測項目與頻率（放流水標準預設組＋依許可證覆寫）、第三方查證資料包（ISO 14046 第 7 章）。ISO 正本由業主決定是否購買。　✅ cfa6304；docs/water-footprint-spec.md §9–§13、test/water.test.js；2026-10-22 已重啟上線
- [x] 27. 匯出（業主：「依照你的建議執行」）：年度沿用維持全部區塊逐一確認；已完工節能計畫不受 R7 完工年度範圍限制；水足跡報表納入單表匯出與申報對照頁。　✅ cfa6304；test/export.test.js（水足跡匯出、R7 已完工）；2026-10-22 已重啟上線
- [x] 28. 節能計畫匯入格式：找外部公開範本（能源署操作手冊、說明會簡報、輔導團隊範本等），找到就對齊 `PLAN_EXPORT_MAP`。　✅ cfa6304；docs/energy-plan-import-format.md（能源署說明會簡報截圖對齊，xlsx 細節待實檔）；2026-10-22 已重啟上線

## 需要業主決定或提供

- ~~國軍醫院是否屬「國軍部隊用戶」排除對象~~ → 2026-10-22 業主確認：「國軍醫院就是主要執行單位，不是排除」。系統一律視為要辦理，EX01 不套用於醫院。
- 各院區契約容量是否合併計算。
- 水足跡要記的項目（目前預設：水表讀數＋有無異常）。
- 各院點位清單（業主提供，或院方在管理端自建）。
- 設備異常通知對象與管道（目前只在管理端列「未結異常」，不對外發送）。
