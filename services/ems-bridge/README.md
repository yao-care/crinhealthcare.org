# ems-bridge — 儲能櫃 Modbus TCP → HTTPS JSON 橋接

輪詢儲能櫃 Modbus TCP（規格書 Modbus_Protocol_Specification v1.0），解碼成語意化 JSON，供 crinhealthcare.org 803 頁面 client 端輪詢。**不隨 astro build**，獨立以 pm2 部署於主機。

## API

- `GET /api/ess` → `{ ok, ts, source: 'live'|'sim', data }`；連續 3 次讀取失敗 → `ok:false` 且回 503（前端 fallback 展示資料）
- `GET /healthz` → `{ ok, ts, source, uptime }`

`source` 誠實原則：只有真實 Modbus 讀值標 `live`（前端顯示綠色「● 即時」）；模擬器標 `sim`（前端一律以琥珀「● 展示資料」呈現）。`--sim-as-live` 僅供本地驗證前端即時樣式，**正式環境不可使用**。

## 本地開發

```bash
pnpm install
pnpm start:sim                 # 模擬模式（無實機）
curl localhost:8460/api/ess
pnpm test                      # node --test 解碼單測
```

前端本地對接：repo 根目錄 `PUBLIC_ESS_API=http://localhost:8460 pnpm dev`。

## 部署（主機 SOP）

1. `cd services/ems-bridge && pnpm install --prod`
2. `cp .env.example .env`，填 `CABINET_HOST`（留空=模擬模式先上線）
3. `pm2 start ecosystem.config.cjs && pm2 save`（**必 pm2 save**）
4. UFW：`ufw allow from 172.18.0.0/16 to any port 8460`（僅 NPM 可達，公網不開）
5. NPM Proxy Host：`ems-api.crinhealthcare.org` → `http://172.18.0.1:8460`（**Forward 用 172.18.0.1**），Let's Encrypt + Force SSL
6. 實機對接：`.env` 填 IP → `pm2 restart ems-bridge` → `pm2 logs ems-bridge` 看連線 → `curl https://ems-api.crinhealthcare.org/api/ess` 數值與廠商 HMI 核對；欄位偏差只改 `src/registers.js`（電池組定址用 `PACK_PAR_IND`/`PACK_SER_IND` env 調）

## 檔案

- `src/registers.js` — 點位表＋讀取計劃（規格書唯一落地處）
- `src/decode.js` — 純解碼（i16 二補數／u32 Lo-word-first／縮放）
- `src/simulator.js` — 產原始暫存器字組（sim 模式走完整 decode 路徑）
- `src/modbusClient.js` / `poller.js` / `server.js` / `index.js`
