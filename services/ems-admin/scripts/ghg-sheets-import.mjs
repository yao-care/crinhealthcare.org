#!/usr/bin/env node
// 匯入院方原本填的環境部溫室氣體盤查表單（類別1(固定)、類別1(移動)、類別1(製程)、類別1(冷煤)、類別1(其它)、類別1(化糞池調查表)、類別2(用電量)）
//   node scripts/ghg-sheets-import.mjs <院所代碼> <盤查表單.xlsx> [--year 2023] [--apply] [--dataset]
//
// 不加 --apply 只預覽：列出會建哪些標的、幾筆觀測，並把逐列加總和原檔左上角的年總量對帳（對不上就不要匯）。
// --apply：寫入（原檔進證據庫；觀測來源紀錄鍵＝年度＋頁籤＋列號，重跑不重複）並跑該年度檢核。
// --dataset：該年度還沒有資料集時建一個草稿資料集（比照 2025 年）。
// 操作人記為該院院所帳號（hosp-<代碼>）。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
process.env.PLATFORM_SCHEDULER = '0';
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--year');
const [hid, file] = pos;
if (!hid || !file) { console.error('用法：node scripts/ghg-sheets-import.mjs <院所代碼> <盤查表單.xlsx> [--year 2023] [--apply] [--dataset]'); process.exit(2); }

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const { orgByHid, contextFor } = await import('../src/platform/authz.js');
const GS = await import('../src/platform/ghg-sheets.js');
const { runValidation } = await import('../src/platform/validation.js');
const DS = await import('../src/platform/datasets.js');
db.openDb(); runSeeds();

const org = orgByHid(hid); if (!org) { console.error(`平台沒有 ${hid} 這個院所`); process.exit(2); }
const u = db.q.get('SELECT id FROM users WHERE username = ? AND status = ?', `hosp-${hid}`, 'active');
if (!u) { console.error(`找不到院所帳號 hosp-${hid}（先用院所帳號登入一次平台）`); process.exit(2); }
const ctx = contextFor({ uid: u.id, hid });

const data = readFileSync(file);
const res = await GS.importWorkbook(ctx, { orgId: org.id, filename: basename(file), data, year: opt('--year') ? Number(opt('--year')) : undefined, apply: flag('--apply') });
console.log(`${org.name} ${res.year} 年盤查表單：${res.rows} 列`);
console.log('對帳（逐列加總 ↔ 原檔年總量）：');
for (const c of res.check) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}：${c.mine} ↔ ${c.theirs}`);
if (res.skipped.length) { console.log('略過：'); for (const k of res.skipped) console.log(`  ${k.sheet} 第 ${k.row} 列：${k.why}`); }
console.log(`${flag('--apply') ? '新建' : '會新建'}標的 ${res.assetsCreated.length} 個${res.assetsCreated.length ? '：' + res.assetsCreated.join('、') : ''}`);
console.log(`觀測：${JSON.stringify(res.observations)}`);
if (res.check.some((c) => !c.ok) && !flag('--apply')) console.log('⚠ 有對不上的合計，先查原檔再匯入');
if (flag('--apply')) {
  const run = runValidation(ctx, { orgId: org.id, year: res.year }, { system: true });
  console.log(`檢核：${JSON.stringify(run.summary || run)}`);
  if (flag('--dataset') && !db.q.get('SELECT 1 FROM datasets WHERE org_id = ? AND year = ?', org.id, res.year)) {
    const ds = DS.createDataset(ctx, { orgId: org.id, year: res.year, name: `${res.year} 年度共用資料集（盤查表單）`, purpose: `由 ${basename(file)} 匯入` });
    console.log(`已建草稿資料集 ${ds.id}`);
  }
}
db.closeDb();
