/**
 * migrate-hospital-to-v2.ts
 * 把舊版(stack/split)醫院 JSON「忠實遷移」成 v2：保留既有真實值，不新增/不臆造。
 * 用法: pnpm tsx scripts/migrate-hospital-to-v2.ts <id>|all
 *
 * 規則（只搬真實、其餘留空）：
 *  - power/water 資源 → v2 同名資源；use.value→current、sub 內%→pctOfTotal。
 *  - 重分類：使用端內的【碳排類】(tCO2e/係數/排放/逸散/範疇/公務車…) 不屬「用電」→ 移出使用端，
 *            去重後併入 env.carbon（零遺失）；使用端只留實際用量(度/kWh/m³…)。
 *  - oil/gas 舊版無資源 → 模板空白；天然氣 esgPanels(gas) 非碳排列 → 搬進 gas.use。
 *  - esgPanels(carbon) → env.carbon（吃 cols+cells 對照表 / label-value 簡表兩種）。
 *  - 治理/社會/節能等面板：v2 無對應 → 不顯示（資料仍在 git 舊版）。
 *  - env.buildings 留空（樓層另依官方樓層介紹填）；daily/戰時細節等 v2 新欄位留空。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src/content/hospitals';
const arg = process.argv[2];
if (!arg) { console.error('用法: pnpm tsx scripts/migrate-hospital-to-v2.ts <id>|all'); process.exit(1); }

const strip = (o: any): any => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') { const r: any = {}; for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = strip(o[k]); return r; }
  return o;
};
const TPL = strip(JSON.parse(readFileSync('docs/v2-template.json', 'utf-8')));
const tplRes = (id: string) => structuredClone(TPL.resources.find((r: any) => r.id === id));

const carbonRe = /tco2e|tco₂e|kgco2e|kgco₂e/i;
const carbonName = /碳|排放|逸散|範疇|間接|公務車|係數|類\s*[0-9]/;
const isCarbon = (name = '', value = '') => carbonRe.test(value) || carbonName.test(name);
const num = (s = '') => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };

const pctFrom = (sub = '') => { const m = sub.match(/([\d.]+)\s*%/); return m ? m[1] + '%' : ''; };
const v2supply = (s: any) => ({ name: s.name, value: s.value || '', online: !!s.online, esg: s.esg || 'na', pct: '', react: '', autonomous: false, warn: false });
const v2store = (s: any) => ({ name: s.name, cap: s.cap || '', pct: typeof s.pct === 'number' ? s.pct : 0, days: s.days || '', state: '', warn: !!s.warn, critical: false });
const v2use = (b: any) => ({ name: b.name, pctOfTotal: pctFrom(b.sub), current: b.value || '', unit: '', daily: [], lastYearDaily: [], critical: false, color: b.color || 'chart-1' });

// 回傳 {scn, carbon[]}：把碳排類 use 區塊抽出
function v2scn(sc: any) {
  const carbon: any[] = [];
  const blocks: any[] = [];
  for (const b of sc?.use?.blocks || []) {
    if (isCarbon(b.name, b.value)) carbon.push({ label: b.name, value: b.value || '' });
    else blocks.push(v2use(b));
  }
  return {
    scn: {
      perf: { act: [], text: sc?.perf?.text || '' },
      endur: { days: sc?.endur?.days || '', pct: sc?.endur?.pct || '' },
      supply: (sc?.supply || []).map(v2supply),
      supplySum: sc?.supplySum || '',
      store: (sc?.store || []).map(v2store),
      use: { headline: sc?.use?.headline || '', sub: sc?.use?.sub || '', blocks },
    },
    carbon,
  };
}

function migrateRes(old: any, id: string, icon: string, name: string, sink: any[]) {
  const o = (old.resources || []).find((r: any) => r.id === id);
  if (!o) return tplRes(id);
  const p = v2scn(o.peace); const w = v2scn(o.war);
  sink.push(...p.carbon, ...w.carbon);
  return { id, icon: o.icon || icon, name: o.name || name, peace: p.scn, war: w.scn, devices: [] };
}

function migrateCarbon(old: any) {
  const c = (old.esgPanels || []).find((p: any) => p.id === 'carbon');
  if (!c) return structuredClone(TPL.env.carbon);
  if (c.cols?.length) return { title: c.title || '碳盤查', cols: c.cols, rows: (c.rows || []).map((r: any) => ({ label: r.label, cells: r.cells || [] })) };
  return { title: c.title || '碳盤查', cols: ['項目', '數值'], rows: (c.rows || []).map((r: any) => ({ label: r.label, cells: [r.value || ''] })) };
}

// 去重後把抽出的碳排項併入碳盤查（label 或數值相同則略過 → 零遺失、不重複）
function mergeCarbon(carbon: any, items: any[]) {
  const norm = (s: string) => String(s).replace(/[\s,，()（）]/g, '');
  const haveLabel = new Set(carbon.rows.map((r: any) => norm(r.label)));
  const haveVal = new Set(carbon.rows.map((r: any) => num((r.cells || []).join(''))).filter((v: any) => v != null));
  for (const it of items) {
    if (haveLabel.has(norm(it.label))) continue;
    const v = num(it.value);
    if (v != null && haveVal.has(v)) continue;
    const cells = carbon.cols.length > 2 ? [it.value, '', ''] : [it.value];
    carbon.rows.push({ label: it.label, cells });
    haveLabel.add(norm(it.label)); if (v != null) haveVal.add(v);
  }
}

function migrate(id: string) {
  const old = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8'));
  if (old.layout === 'v2') { console.log(`- ${id}: 已是 v2，略過`); return false; }

  const carbonSink: any[] = [];
  const power = migrateRes(old, 'power', '⚡', '電力', carbonSink);
  const water = migrateRes(old, 'water', '💧', '水', carbonSink);
  const oil = tplRes('oil');
  const gas = tplRes('gas');
  // 天然氣面板 → gas.peace.use（非碳排列才放；碳排列進 carbonSink）
  const gp = (old.esgPanels || []).find((p: any) => p.id === 'gas');
  if (gp?.rows?.length) {
    const blocks: any[] = [];
    for (const r of gp.rows) {
      if (isCarbon(r.label, r.value)) carbonSink.push({ label: r.label, value: r.value || '' });
      else blocks.push({ name: r.label, pctOfTotal: '', current: r.value || '', unit: '', daily: [], lastYearDaily: [], critical: false, color: 'energy' });
    }
    if (blocks.length) gas.peace.use.blocks = blocks;
  }

  const carbon = migrateCarbon(old);
  mergeCarbon(carbon, carbonSink);

  const out = {
    name: old.name || '', location: old.location || '', version: 'v1', updated: old.updated || '',
    liveData: !!old.liveData, layout: 'v2',
    scenarios: old.scenarios || TPL.scenarios,
    resources: [power, water, oil, gas],
    env: { peace: { buildings: [] }, war: { buildings: [] }, criticalFloors: [], carbon },
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ ${id}：電力使用端 ${power.peace.use.blocks.length} 項(用電) · 碳盤查 ${carbon.rows.length} 列(含併入 ${carbonSink.length} 抽出項去重) · gas.use ${gas.peace.use.blocks.length}`);
  return true;
}

const ids = arg === 'all'
  ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
  : [arg];
let n = 0;
for (const id of ids) { try { if (migrate(id)) n++; } catch (e: any) { console.error(`✗ ${id}: ${e.message}`); } }
console.log(`\n完成：${n} 家遷移為 v2（碳排已重分類）。接著跑 validate-hospital-v2.ts 與 pnpm build。`);
