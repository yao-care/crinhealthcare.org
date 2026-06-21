/**
 * scaffold-hospital-v2.ts
 * 由 docs/v2-template.json 產生一家醫院的 v2 空白骨架到 src/content/hospitals/<id>.json。
 * 用法: pnpm tsx scripts/scaffold-hospital-v2.ts <id> --name "醫院名" [--location "地點"] [--updated YYYY-MM-DD] [--force]
 * 產出後：只填【真實資料】、其餘留空；env.buildings 依該院官方樓層介紹填入。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const force = args.includes('--force');

if (!id) {
  console.error('用法: pnpm tsx scripts/scaffold-hospital-v2.ts <id> --name "醫院名" [--location "地點"] [--updated YYYY-MM-DD] [--force]');
  process.exit(1);
}

const outPath = join('src/content/hospitals', `${id}.json`);
if (existsSync(outPath) && !force) {
  console.error(`✗ ${outPath} 已存在。要覆蓋請加 --force（會清掉現有內容）。`);
  process.exit(1);
}

const strip = (o: any): any => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const r: any = {};
    for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = strip(o[k]);
    return r;
  }
  return o;
};

const data = strip(JSON.parse(readFileSync('docs/v2-template.json', 'utf-8')));
data.name = opt('name') ?? '';
data.location = opt('location') ?? '';
data.updated = opt('updated') ?? '';
data.version = data.version || 'v1';

writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
console.log(`✓ 已產生 ${outPath}（layout=v2 · 電/水/油/氣 4 資源 · env 待填）`);
console.log('  下一步：');
console.log('   1) 只填【真實資料】（能源審查/碳盤查/供儲），未取得留空、欄位保留。');
console.log('   2) env.peace/war.buildings 依官方樓層介紹填；ICU/手術室/產房 放入 criticalFloors。');
console.log('   3) 設備清單填 resources[].devices（含 manager/contact/vendor＝出問題找誰）。');
console.log(`   4) 驗證：pnpm tsx scripts/validate-hospital-v2.ts ${id}`);
