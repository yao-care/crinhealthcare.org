// 產生「看板對照圖」素材：public/board-map.png ＋ public/board-map.json
//
// 為什麼要這個：院方反映「不知道哪個欄位對應看板上哪一塊」。這支腳本去線上抓一張真實看板截圖，
// 同時量出各區塊的座標，前端就能在截圖上疊可點擊的熱區，點下去直接跳到表單對應分區。
// 全 15 家都是 layout v2、同樣 power/water/oil/gas 四個區塊，所以一張對照圖對所有院所都成立。
//
// 一次性素材產生器，不進 CI、不隨服務啟動跑。看板版面改版時才需要重跑：
//   node scripts/make-board-map.mjs [院所代碼，預設 802]
// 主機沒裝 playwright，借其他專案的 playwright-core ＋ 快取 chromium（見下方常數）。
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PW_CORE = '/root/six-hats/node_modules/.pnpm/playwright-core@1.58.2/node_modules/playwright-core/index.js';
const CHROME = '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const hid = process.argv[2] || '802';
const { chromium } = (await import(PW_CORE)).default;
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(`https://crinhealthcare.org/${hid}/`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);   // 等圖表動畫定格

// 量出每個資源區塊裡「供給端／儲存端／使用端／標題列」的位置
const regions = await page.evaluate(() => {
  const out = [];
  const push = (elm, label, part, resourceId) => {
    if (!elm) return;
    const r = elm.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label, part, resourceId });
  };
  // 資源區塊的順序＝資料裡 resources 的順序；用標題列的圖示＋名稱辨識
  const blocks = [...document.querySelectorAll('section.block')];
  const ID_BY_ICON = { '⚡': 'power', '💧': 'water', '⛽': 'oil', '🛢': 'oil', '🔥': 'gas', '🌡': 'env' };
  for (const b of blocks) {
    const nameEl = b.querySelector('.bname');
    const txt = (nameEl?.textContent || '').trim();
    const icon = [...txt][0];
    const nm = txt.replace(/^\P{L}+/u, '').trim() || txt;
    // 環境參數區塊不分供/儲/使，整塊當一個熱區（它的圖示是 🇹🇼 不是資源圖示，所以認名稱不認圖示）
    if (nm.startsWith('環境參數')) { push(b, '環境參數（各大樓樓層溫濕度／CO₂）', 'env', 'env'); continue; }
    const rid = ID_BY_ICON[icon] || '';
    push(b.querySelector('.bhead'), `${nm}：標題列（效能摘要／續航）`, 'head', rid);
    push(b.querySelector('.seg.supply'), `${nm}：供給端`, 'supply', rid);
    push(b.querySelector('.seg.store'), `${nm}：儲存端`, 'store', rid);
    // 使用端沒有專屬 class，取左欄以外的另一半
    const body = b.querySelector('.bbody');
    const left = b.querySelector('.leftcol');
    if (body && left) {
      const br = body.getBoundingClientRect(), lr = left.getBoundingClientRect();
      const x = Math.round(lr.right), w = Math.round(br.right - lr.right);
      if (w > 40) out.push({ x, y: Math.round(br.y), w, h: Math.round(br.height), label: `${nm}：使用端`, part: 'use', resourceId: rid });
    }
  }
  return out;
});

const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.body.scrollHeight }));
await page.setViewportSize({ width: 1600, height: Math.min(size.h, 4000) });
await page.waitForTimeout(600);
await page.screenshot({ path: join(PUB, 'board-map.png') });
await writeFile(join(PUB, 'board-map.json'),
  JSON.stringify({ hospital: hid, width: 1600, height: Math.min(size.h, 4000), capturedFrom: `https://crinhealthcare.org/${hid}/`, regions }, null, 2));

console.log(`board-map.png / board-map.json 已更新（取自 ${hid}，${regions.length} 個熱區）`);
for (const r of regions) console.log(`  ${r.resourceId || '?'}/${r.part}  ${r.label}`);
await browser.close();
