# EMS v2 戰情看板 — 各醫院套用 SOP

把 803（國軍臺中總醫院）的 v2 五區塊戰情看板，套用到其他醫院的標準作業程序。
目標：**可重複、可驗證、不靠記憶**，每家上線前都通過同一道關卡。

> **鐵律：只放真實資料。** 未取得的資料一律**留空白、欄位保留**（畫面顯示「—」），**嚴禁自己編示意值**。

---

## 0. 一次性基礎（已完成，新醫院不用動）

| 元件 | 角色 |
|------|------|
| `src/components/charts/EmsBoardV2.svelte` | Dashboard 五區塊（電/環境/水/油/氣），kiosk 等比% |
| `src/components/charts/EmsDetail.svelte` | 看詳情（資源鑽取頁，可捲動，含設備滿版列） |
| `src/pages/[hospital].astro` | 依 `layout:"v2"` 自動選 v2 元件 |
| `src/pages/[hospital]/detail/[resource].astro` | 看詳情路由（僅對 v2 醫院產生） |
| `src/utils/ems.ts` | 「資料→呈現」規則：供給紅底 / bar 前三高金銀銅 / 環境分級底色（附法規依據） |
| `src/content.config.ts` | Zod schema（全 optional，舊版醫院不受影響） |

新醫院只需：**資料 + `layout:"v2"`**。

---

## 1. 蒐集真實資料（每家一份「資料來源表」，每筆值附出處）

| 區塊 | 需要的真實資料 | 常見來源 |
|------|----------------|----------|
| ⚡電力 | SEU 分項用電(kWh+%)、全年用電、供給(市電/PV/發電機)、儲能(BESS/UPS) | 能源審查報告 |
| 💧水 | 供給水源、蓄水容量/水位、用水/污水 | 用水盤點 |
| ⛽油 | 油槽容量/油位/可供發電天數、耗油率 | 發電機/油料管理 |
| 🔥氣 | 天然氣、醫用氧氣供給/液氧槽存量/可供天數 | 醫用氣體管理 |
| 🇹🇼環境 | **各棟各樓層**溫/濕/CO₂；ICU/手術室/產房/嬰兒室樓層 | 官方樓層介紹頁 + 樓管/EMS |
| 📈碳盤查 | 2024/2025/2026 各項 tCO₂e | 溫室氣體盤查報告 |
| 🛠️設備 | 具名設備 + 位置 + 狀態 + 即時值 + **管理人/聯絡/維護廠商** | 設備台帳/權責表 |

> 樓層結構務必對照該院**官方樓層介紹**（如 803：`803.mnd.gov.tw/about/cate1/sn5`），不可臆測棟別/樓層。

---

## 2. 產生空白骨架（產生器）

```bash
pnpm tsx scripts/scaffold-hospital-v2.ts <id> --name "醫院名" --location "地點" --updated 2026-06-21
```
- 由 `docs/v2-template.json` 複製，產出 `src/content/hospitals/<id>.json`（layout=v2、四資源、env 待填）。
- 已存在要覆蓋才加 `--force`。

## 3. 填真實資料
- 把第 1 步的真實值填進骨架；**未取得留空**（`""` / `[]` / `0`）。
- `env.peace/war.buildings` 依官方樓層填；ICU/手術室/產房/嬰兒室放進 `env.criticalFloors`（格式 `大樓名+樓層`，如 `醫療大樓2F`）→ 自動套 ICU 濕度標準 50–80% + ★。
- 設備填 `resources[].devices`：左(status/reading)、中(daily/refDaily 趨勢)、右(manager/contact/vendor)。
- 供給/儲存/使用的項目名稱依實況增刪改名。

## 4. 切換（產生器已設 `layout:"v2"`，沿用舊檔則手動改）

---

## 5. 驗證關卡（上線前必過五道）

```bash
pnpm tsx scripts/validate-hospital-v2.ts <id>   # ① 結構完整性 + 完整度報告
pnpm exec astro check                            # ② 型別/內容無誤
pnpm build                                       # ③ 全 12+ 家建置通過（不破其他家）
pnpm preview --port 4399                         # ④ 本機開 /<id>/ 與 /<id>/detail/power 人工檢視
```
④ 人工檢視重點：五區塊無跑版、字級可讀、徽章不斷行、平戰切換、環境分級色、看詳情可捲動且設備列正常、無 console error。
⑤ 內容核對：對照「資料來源表」抽查，確認**只有真實值**、空白處為「—」。

> 結構錯誤（缺資源/缺 env）→ validator 退出碼 1，**不可上線**；空白是 ⚠ 提示，可上線（代表待補）。

---

## 6. 上線（部署）

```bash
git add src/content/hospitals/<id>.json
git commit -m "feat(ems): <醫院> 套用 v2 看板（真實資料/空白待補）"
git checkout main && git merge --ff-only <branch> && git push origin main
```
push 到 `main` → GitHub Actions `deploy.yml` 自動 build + 部署到 GitHub Pages。
上線後抽查：`https://crinhealthcare.org/<id>/`（v2 標記、真實值在線、看詳情不 404）。

---

## 「確保完整運行」的五道防線

1. **Zod schema**（`content.config.ts`）— 結構型別
2. **validator 腳本** — v2 專屬完整性（四資源/env/碳盤查）＋ 空白清單
3. **`astro check` / `pnpm build`** — 不破其他 11 家
4. **本機 preview 截圖人工檢視** — 視覺/跑版/console
5. **真實資料鐵律＋資料來源表** — 內容正確、可追溯

## 已知事項
- 看詳情的設備「即時值/趨勢圖」需該院接入即時量測或提供序列，否則顯示「待盤點」。
- 戰時數值多為各院機敏資料，未提供前留空白。
- 看詳情已解除全站 44px 觸控下限（kiosk 大螢幕、非觸控優先）；僅影響戰情盤面。
