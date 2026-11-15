# 油水電氣資料治理平台｜維運手冊

平台是 `services/ems-admin` 的一部分（同一個 pm2 程序 `ems-admin`、port 8470），入口 `/p/`、API `/api/v1/*`。

## 資料位置（全部在主機本地，不進 public repo）

| 內容 | 路徑 | 備註 |
|---|---|---|
| 平台資料庫 | `PLATFORM_DB`，預設 `AUDIT_DATA_DIR/platform/platform.sqlite`（正式：`/opt/ems-admin/data/platform/`） | SQLite WAL；不進 data 倉庫的 git |
| 備份 | `PLATFORM_BACKUP_DIR`，預設資料庫旁的 `backups/` | 每日一份，保留 `PLATFORM_BACKUP_KEEP`（預設 30）份 |
| 佐證檔 | `AUDIT_UPLOADS_DIR/platform/<組織>/evidence/<sha256>` | 以內容雜湊命名，唯讀權限 |
| 報告封存檔 | `AUDIT_UPLOADS_DIR/platform/<組織>/reports/` | 每份記雜湊 |

## 環境變數（`.env`，皆選填）

| 變數 | 用途 |
|---|---|
| `PLATFORM_DB` / `PLATFORM_BACKUP_DIR` / `PLATFORM_BACKUP_KEEP` | 資料庫與備份位置 |
| `PLATFORM_SCHEDULER=0` | 關閉排程（測試用） |
| `EVIDENCE_MAX_BYTES` | 單檔上限（預設 25 MB） |
| `CHROME_PATH` | 產 PDF 用的 headless Chromium；未設時找 Playwright 安裝的 headless shell |
| `SMTP_URL`（`smtps://帳號:密碼@主機:465`）、`SMTP_FROM` | Email 通知；另需在「門檻與設定」把 `notify.channels.email` 設為 true |
| `ANTHROPIC_API_KEY` | 電費單 PDF／照片辨識（與健檢填報共用） |

## 第一次上線

```bash
cd services/ems-admin
pm2 restart ems-admin                      # 啟動時自動建表、寫入種子（冪等）
EMS_PW='…' node scripts/platform-admin.mjs sysadmin admin-a "管理員甲"
EMS_PW='…' node scripts/platform-admin.mjs sysadmin admin-b "管理員乙"   # 係數與設定發布需要第二人
```

1. 甲、乙登入 `/p/` 改密碼。
2. 甲在「係數與計算規則」核對預設係數來源；乙按「核准全部待核准的系統預設係數」（或 `node scripts/platform-admin.mjs publish-seed-factors admin-b`）。
3. 各院用原本的院所帳號登入，替同仁開個人帳號。

## 排程（程序內）

| 頻率 | 工作 |
|---|---|
| 每分鐘 | 到期的介接同步（失敗指數退避；連續 5 次 → 停止並通知） |
| 每小時 | 待辦與差異案件逾期提醒；寄出 Email 通知（有設定時） |
| 每日 02:00（台灣時間） | 資料庫備份＋驗證（integrity_check、稽核雜湊鏈） |
| 每週日 03:00 | 驗證全部佐證檔雜湊 |

## CLI

```bash
node scripts/platform-admin.mjs verify          # 稽核鏈、定版資料集雜湊、佐證檔雜湊；有問題 exit 2
node scripts/platform-admin.mjs backup          # 立即備份並驗證
node scripts/platform-admin.mjs drill <備份檔名>  # 還原演練（唯讀比對筆數）
node scripts/platform-admin.mjs routes          # 列出 API
node scripts/platform-dictionary.mjs > ../../docs/ems-platform-dictionary.md   # 重新產生資料字典
```

## 還原

1. `pm2 stop ems-admin`
2. 先對要用的備份跑 `drill`，確認 `ok: true`。
3. 把目前的 `platform.sqlite`、`-wal`、`-shm` 移到別處保存（不要刪）。
4. `cp backups/platform-<時間>.sqlite platform.sqlite`
5. `pm2 start ems-admin`，再跑 `verify`。

佐證檔與報告封存檔不在資料庫裡；備份主機時要連 `AUDIT_UPLOADS_DIR/platform/` 一起備份。

## 安全

- 權限判斷集中在 `src/platform/authz.js`；路由不自行比對角色。
- 稽核事件以雜湊串鏈，資料庫 trigger 禁止修改與刪除；定版資料集、封存報告、原始觀測值也由 trigger 擋修改。
- 佐證檔：副檔名白名單＋檔頭檢查＋擋可執行檔；下載回 `Content-Security-Policy: sandbox`，每次下載記稽核。
- 公開看板只輸出彙總比率與件數，不含費用、識別碼、聯絡人。
- 推送介接權杖只存 SHA-256；外部 AI 辨識只在設定 `ANTHROPIC_API_KEY` 時啟用，限閱、機密佐證請院方確認後再用辨識功能。

## 上傳檔檢查

副檔名白名單、檔頭（magic bytes）比對、擋可執行檔，檔案以雜湊保存。業主決定不安裝掃毒服務（2026-11-15）。

## 測試報告

`docs/ems-platform-test-report.md`（功能、瀏覽器、負載、大量匯入、安全）。

## 開發與測試

```bash
pnpm test                                       # 含 test/platform.test.js（PRD §22 驗收逐條）與 test/platform-http.test.js
```

隔離實例與示範資料（不可對正式路徑執行）：

```bash
R=/tmp/ems-run; mkdir -p $R/{data,uploads,repo/src/content/hospitals}
cp ../../src/content/hospitals/*.json $R/repo/src/content/hospitals/; echo '{"accounts":[]}' > $R/accounts.json
export ACCOUNTS_FILE=$R/accounts.json REPO_DIR=$R/repo AUDIT_DATA_DIR=$R/data AUDIT_UPLOADS_DIR=$R/uploads \
  PLATFORM_DB=$R/data/platform/platform.sqlite JWT_SECRET=$(openssl rand -hex 16) HTTP_PORT=8476 COOKIE_SECURE=0
node scripts/platform-demo.mjs 803 2025          # 建一家院所一整年的示範資料（帳號 demo-*，密碼 Demo12345a）
node src/index.js
```
