#!/usr/bin/env node
// 維護者匯入業主提供的點位清單（工作清單第 25 項）。規則與管理端「批次匯入點位」同一支（src/points-import.js）。
//
//   node scripts/import-points.mjs <hid> <file.xlsx|file.csv> [--apply] [--reporter 姓名] [--reason 原因] [--json]
//
// 預設只預覽（不寫檔）；加 --apply 才寫入：整批一次 commit，寫一筆「點位批次匯入」異動。有任何錯誤整批不寫。
// 資料目錄取 AUDIT_DATA_DIR（沒設就是 .env／預設 /opt/ems-admin/data）。服務正在跑也不用重啟：盤點每次請求都重新讀檔。
// 範本：管理端「點位與進度 › 批次匯入點位 › 下載範本」，或 GET /api/inv/points/template.xlsx。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const valued = new Set(['--reporter', '--reason']);
const pos = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const [hid, file] = pos;
if (!hid || !file) {
  console.error('用法：node scripts/import-points.mjs <hid> <file.xlsx|file.csv> [--apply] [--reporter 姓名] [--reason 原因] [--json]');
  process.exit(2);
}
const apply = flag('--apply');

const { parseImportFile, importPoints, ImportError } = await import('../src/points-import.js');
const { parseReporter, whoLabel, DOMAINS } = await import('../src/inventory-schema.js');
const { config } = await import('../src/config.js');

const rp = parseReporter(opt('--reporter') ?? null);
if (!rp.ok) { console.error(rp.message); process.exit(2); }
const actor = { who: whoLabel('維護者', rp.reporter), reporter: rp.reporter };

const parsed = parseImportFile(await readFile(file), file);
if (parsed.error) { console.error(`讀檔失敗：${parsed.error}`); process.exit(1); }

let r, failed = false;
try {
  r = await importPoints(hid, parsed.rows, { apply, actor, reason: opt('--reason'), source: basename(file) });
} catch (e) {
  if (!(e instanceof ImportError)) throw e;
  r = { applied: false, preview: e.body.preview };
  failed = true;
}
const P = r.preview;
if (flag('--json')) {
  console.log(JSON.stringify({ hid, dataDir: config.dataDir, apply, applied: r.applied, commit: r.commit || null, preview: P }, null, 2));
} else {
  const MARK = { add: '＋新增', update: '～更新', unchanged: '　不變', error: '✕錯誤' };
  console.log(`資料目錄：${config.dataDir}｜院所 ${hid}｜${basename(file)}${parsed.sheet ? `（工作表「${parsed.sheet}」）` : ''}${apply ? '' : '（預覽，不寫檔）'}`);
  for (const p of P.points) {
    console.log(`${MARK[p.action]} ${p.code || '（未配號）'}${p.autoCode ? '（自動配號）' : ''} ${DOMAINS[p.domain]?.label || ''} ${p.name || ''}${p.location ? ` · ${p.location}` : ''}｜${p.items.length} 個項目｜第 ${p.rows.join('、')} 列`);
    for (const c of p.changes) console.log(`      ${c}`);
    for (const w of p.warnings) console.log(`      ⚠ ${w}`);
  }
  for (const e of P.errors) console.log(`✕ 第 ${e.row} 列${e.code || e.name ? `（${e.code || e.name}）` : ''}：${e.message}`);
  const c = P.counts;
  console.log(`合計：新增 ${c.add}、更新 ${c.update}、不變 ${c.unchanged}、錯誤 ${P.errors.length}；略過範例列 ${c.skipped}`);
  if (r.applied) console.log(`已寫入（commit ${String(r.commit || '').slice(0, 7)}），異動登錄記一筆「點位批次匯入」。`);
  else if (failed) console.log('有錯誤，整批未寫入。');
  else if (apply && r.nothing) console.log('沒有要新增或更新的點位，未寫入。');
  else if (!apply) console.log(P.ok ? '預覽沒有錯誤；確認後加 --apply 寫入。' : '請先修正錯誤再加 --apply。');
}
process.exit(failed || (!P.ok) ? 1 : 0);
