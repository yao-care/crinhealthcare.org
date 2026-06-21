/**
 * validate-hospital-v2.ts
 * 檢查 v2 醫院 JSON 的「結構完整性」+ 列出空白項（完整度報告）。
 * 用法: pnpm tsx scripts/validate-hospital-v2.ts [<id>]   （不給 id = 檢查所有 layout:"v2"）
 * 結構錯誤 → 退出碼 1（CI/上線前 gate）；空白只是提示(⚠)，不算錯。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src/content/hospitals';
const arg = process.argv[2];
const files = arg ? [`${arg}.json`] : readdirSync(dir).filter((f) => f.endsWith('.json'));
const REQUIRED_RES = ['power', 'water', 'oil', 'gas'];
let hardErrors = 0;
let checked = 0;

for (const f of files) {
  let d: any;
  try {
    d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
  } catch (e: any) {
    console.error(`✗ ${f}: JSON 解析失敗 — ${e.message}`);
    hardErrors++;
    continue;
  }
  if (d.layout !== 'v2') {
    if (arg) console.log(`- ${f}: layout=${d.layout}（非 v2，略過）`);
    continue;
  }
  checked++;
  const id = f.replace('.json', '');
  const errs: string[] = [];
  const warns: string[] = [];

  const ids = (d.resources || []).map((r: any) => r.id);
  for (const r of REQUIRED_RES) if (!ids.includes(r)) errs.push(`缺資源 ${r}`);
  for (const r of d.resources || []) {
    for (const sc of ['peace', 'war']) {
      const s = r[sc];
      if (!s) { errs.push(`${r.id}.${sc} 缺`); continue; }
      if (!Array.isArray(s.supply)) errs.push(`${r.id}.${sc}.supply 非陣列`);
      if (!Array.isArray(s.store)) errs.push(`${r.id}.${sc}.store 非陣列`);
      if (!s.use || !Array.isArray(s.use.blocks)) errs.push(`${r.id}.${sc}.use.blocks 非陣列`);
    }
  }
  if (!d.env) errs.push('缺 env');
  else {
    if (!d.env.peace?.buildings?.length) warns.push('env.peace.buildings 空（樓層待填）');
    if (!d.env.war?.buildings?.length) warns.push('env.war.buildings 空（戰時樓層待填）');
    if (!d.env.carbon?.rows?.length) warns.push('env.carbon 空');
  }
  if (!d.version) warns.push('version 空');
  if (!d.updated) warns.push('updated 空');

  // 完整度（空白統計，提示用）
  let useTot = 0, useFilled = 0, devTot = 0, devNoContact = 0, floorTot = 0, floorFilled = 0;
  for (const r of d.resources || []) {
    for (const sc of ['peace', 'war']) for (const b of r[sc]?.use?.blocks || []) { useTot++; if (b.current) useFilled++; }
    for (const v of r.devices || []) { devTot++; if (!v.manager && !v.contact) devNoContact++; }
  }
  for (const sc of ['peace', 'war']) for (const b of d.env?.[sc]?.buildings || []) for (const fl of b.floors || []) { floorTot++; if (fl.temp || fl.rh || fl.co2) floorFilled++; }

  console.log(`\n${errs.length ? '✗ 結構不完整' : '✓ 結構完整'}  ${id}  (${d.name || '未命名'})`);
  errs.forEach((e) => console.log(`   ✗ ${e}`));
  warns.forEach((w) => console.log(`   ⚠ ${w}`));
  console.log(`   完整度：使用端 ${useFilled}/${useTot} 有現況值 · 樓層 ${floorFilled}/${floorTot} 有量測 · 設備 ${devTot} 台（${devNoContact} 台缺管理人/聯絡）`);
  if (errs.length) hardErrors++;
}

console.log(`\n檢查 ${checked} 家 v2。${hardErrors ? `✗ ${hardErrors} 家有結構錯誤，需修正後才可上線。` : '✓ 全部結構通過。'}`);
process.exit(hardErrors ? 1 : 0);
