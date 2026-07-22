# ems-admin — EMS 看板維護表單

院所人員以帳密登入，載入自家 `src/content/hospitals/<id>.json`，用**結構化表單**（不必懂 JSON）修改，送出後由**伺服器端** `git commit + push`，觸發 GitHub Actions 自動部署，看板約 1–2 分鐘後更新。獨立 pm2 部署於主機，**不隨 astro build**。

## 特性

- **每院獨立帳號**：一組帳號只能編輯自家院所（`hospitalId` 綁在 session，前後端都以此限定範圍）。
- **結構化表單**：依載入的 JSON 結構自動長出分區欄位；值可改、結構鎖定＝院方不會改壞語法。陣列可增/刪項。**通用全 12 家**（同一份表單程式適用任何院所）。
- **送出前驗證**：用由 `src/content.config.ts` 移植的**同一套 zod schema**（`src/schema.js`）驗證，不合規直接回 422，不會把壞資料推上 CI。
- **安全**：scrypt 密碼雜湊、HMAC 簽章 session cookie（HttpOnly/SameSite=Strict/Secure）、POST 加 Origin 檢查（CSRF）、登入失敗節流。推送金鑰只在伺服器端。

## API

- `POST /api/login` `{username,password}` → 設 cookie，回 `{ok,hid,name}`
- `POST /api/logout`
- `GET /api/me` → `{username,hid,name}`（未登入 401）
- `GET /api/hospital` → 自家院所現況 `{hospitalId,data}`
- `POST /api/hospital` `{data}` → 驗證 → 寫檔 → commit+push → `{ok,commit,unchanged}`
- `GET /healthz`

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
3. `cp .env.example .env`，填：
   - `JWT_SECRET`（`openssl rand -hex 32`）
   - `REPO_DIR=/opt/ems-admin/repo`
   - `ACCOUNTS_FILE`（預設 `./accounts.json`）
4. **建帳號**（每院一組，密碼走環境變數不落 argv）：
   ```bash
   EMS_PW='院方密碼' node scripts/hash-password.mjs hosp-802 802 "國軍高雄總醫院"
   # 每家一組：hosp-803/803、hosp-804/804 …
   ```
5. `pm2 start ecosystem.config.cjs && pm2 save`（**必 pm2 save**）
6. UFW：`ufw allow from 172.18.0.0/16 to any port 8470`（僅 NPM 可達，公網不開）
7. NPM Proxy Host：`ems-admin.crinhealthcare.org` → `http://172.18.0.1:8470`（**Forward 用 172.18.0.1**），Let's Encrypt + Force SSL
8. 驗證：`curl https://ems-admin.crinhealthcare.org/healthz` → `{ok:true}`；瀏覽器登入 → 改值 → 送出 → 看 GitHub Actions 部署 → 看板更新

> ⚠️ **推送金鑰安全**：`REPO_DIR` 的 origin 具 push 權限，等同可改正式站。金鑰只存主機（deploy key 私鑰 / PAT），**絕不進前端、不進 repo**。`.env`、`accounts.json` 已於 `.gitignore` 排除。

## Schema 同步

`src/schema.js` 是 `crinhealthcare.org/src/content.config.ts` 的 `hospitals` schema 副本。**content.config.ts 若增修 hospital 欄位，這裡要同步**，否則新欄位可能被驗證擋下或漏驗。`pnpm test` 會用所有現有院所 JSON 回歸，是最快的對齊檢查。

## 檔案

- `src/config.js` — .env 載入＋啟動檢查
- `src/schema.js` — 移植的 zod 驗證 schema
- `src/auth.js` — scrypt 雜湊、HMAC token、cookie
- `src/accounts.js` — 帳號載入＋登入節流
- `src/repo.js` — 讀寫 hospital JSON、git commit/push（互斥鎖序列化）
- `src/server.js` — HTTP 路由＋靜態
- `public/` — 登入＋遞迴結構化表單（原生 JS，無 build）
- `scripts/hash-password.mjs` — 產/追加院所帳號
