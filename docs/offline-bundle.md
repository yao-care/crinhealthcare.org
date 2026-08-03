# 離線單檔看板（`pnpm build:offline`）

給客戶「一個 HTML 檔、雙擊就能看、完全不需網路」的 EMS 看板。

```bash
pnpm build                      # 先產生 dist/
pnpm build:offline 804          # → dist-offline/804-offline.html
pnpm build:offline 804 --no-fonts   # 不內嵌字型（檔案小 ~0.9 MB，中文改用系統字型）
```

`dist-offline/` 已在 `.gitignore`，產出檔不進版控——每次要給客戶就重跑。

## 它做了什麼

| 線上站的作法 | 離線單檔的作法 |
|---|---|
| 看板頁 + `detail/{power,water,oil,gas}` 共 5 個 HTML | 5 頁 body 各包一層 `.off-page`，同檔內用 `#power` 之類的 hash 切換 |
| 「🔎 看詳情」「← 戰情總覽」是真連結 | 連結由 Svelte 產生，靜態改 href 會被 hydration 蓋掉，所以用 **document 層級 click 攔截**轉成 hash |
| CSS 走 `/_astro/*.css`，字型走 `/_astro/*.woff2` | CSS inline；`@font-face` 先丟掉 unicode-range 用不到的子集，剩下的再用 fontTools 裁到「本頁真的出現的字」後轉 data URI（7.0 MB → 0.77 MB） |
| Astro island 靠 `import('/_astro/EmsBoardV2.*.js')` hydrate | esbuild 把 svelte renderer + 各元件 chunk 打成單一 IIFE 內嵌，另附一段 script 沿用 astro 的 props 反序列化格式手動 mount（切到該頁時才 hydrate） |
| CSP meta、rss/sitemap link | 拿掉——那是給線上站的，`file://` 下只會擋路 |

## 已驗證（804，Chromium 1600×1000 與 390×844）

- 五頁全部 hydrate 成功（`astro-island[ssr]` 歸零），console 零錯誤零警告
- context 設 `offline: true`、監聽所有請求：**沒有任何 file:// 以外的請求**
- 看板文字與 `dist/` 伺服版逐字相同（去空白後完全一致），字型堆疊、字級相同
- 平時 ⇄ 戰時切換、削峰填谷圖表、看詳情 → 回看板皆正常

## 注意

- **只適合 `liveData: false` 的醫院**。803 這種要輪詢 `ems-api.crinhealthcare.org` 的，離線會每 5 秒 fetch 失敗一次（畫面會退回展示資料，但 console 會一直噴錯）。要做 803 離線版得先把 poller 關掉。
- 字型子集是依「產出當下頁面上的字」裁的；**資料改了要重跑**，不能拿舊檔換新資料。
- 需要 `python3` + `fontTools` + `brotli`（主機已有）。裁切失敗會自動退回未裁切的子集檔，只是檔案變大，不影響正確性。
- 內容更新流程不變：改 `src/content/hospitals/<id>.json` → `pnpm build` → `pnpm build:offline <id>`。
