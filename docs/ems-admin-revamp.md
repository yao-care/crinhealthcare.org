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
  equipment: [ { id, pointCode, building, category: 'ac'|'lighting'|'other', kind, fields{…表九欄位}, status: 'active'|'replaced'|'removed', createdAt, updatedAt } ],
  points:    [ { code, domain: 'power'|'water', name, location, items[], active } ],
  records:   [ { id, pointCode, period: 'YYYY-MM', at, who, values{itemId: value}, note, photos[], anomalies[] } ],   // 定期更新
  changes:   [ { id, at, who, kind, target, before, after, reason } ],                                             // 異動登錄
  measures:  [ … ],  plans: [ … ]                                                                                  // 診斷措施、節能計畫（附件一、二）
}
```

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
| POST | `/api/login` | 新增 `remember: true` → session 30 天（貼紙頁用） |

**前後端共用計算**：`public/inventory-compute.js`（同 `audit-compute.js` 的掛法：瀏覽器一般腳本、伺服器 import 後讀 `globalThis.EMSInventoryCompute`），放 R1–R9、用量、EUI、kW/RT、回收年限、機齡、期限。

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
- [ ] 11. 院區主檔：軍醫局令 18 個單位與現有 15 個帳號對照表（含尚無帳號的單位），寫進 docs。

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
