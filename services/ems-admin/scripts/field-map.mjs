// 產生 docs/annex3-field-map.md（匯出欄位對照；來源 src/annex3-fields.js）
//   node scripts/field-map.mjs          寫檔
//   node scripts/field-map.mjs --check  只比對，不一致 exit 1
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fieldMapMarkdown, fieldStats } from '../src/annex3-fields.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/annex3-field-map.md');
const md = fieldMapMarkdown() + '\n';
if (process.argv.includes('--check')) {
  let cur = '';
  try { cur = readFileSync(out, 'utf8'); } catch {}
  if (cur !== md) { console.error('docs/annex3-field-map.md 與 src/annex3-fields.js 不一致，請跑 node scripts/field-map.mjs'); process.exit(1); }
  console.log('ok');
} else {
  writeFileSync(out, md);
  console.log(out, fieldStats());
}
