#!/usr/bin/env node
// 用院所看板資料（src/content/hospitals/<hid>.json）替盤點樹建第一版骨架：只搬看板上已經寫明的東西。
//   node scripts/inv-from-board.mjs <hid> [--dry-run] [--outdoor 停車場,路燈]
//
// 建立：
//   分區   env.peace.buildings 的建物與樓層（樓層由上往下）；--outdoor 指定的周邊區域
//   台電   電力「受電」設備（例：大坑變電所 22.8KV）各一個外購電力電號標的（受電點），名稱用電壓
//   油     「柴油發電機 Gn xxxKW」各一台緊急發電機（額定 kW、所在建物）
// 重跑安全：每筆記 legacy_ref＝board:<hid>:<鍵>，已有就跳過。資料目錄取 AUDIT_DATA_DIR／PLATFORM_DB（沒設就讀 .env）。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
process.env.PLATFORM_SCHEDULER = '0';
const args = process.argv.slice(2);
const hid = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const oi = args.indexOf('--outdoor');
const outdoor = oi >= 0 ? String(args[oi + 1] || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [];
if (!hid) { console.error('用法：node scripts/inv-from-board.mjs <hid> [--dry-run] [--outdoor 停車場,路燈]'); process.exit(2); }

const { config } = await import('../src/config.js');
const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const { orgByHid } = await import('../src/platform/authz.js');
db.openDb(); runSeeds();
const { q, insert, newId, nowIso, audit, tx } = db;

const boardPath = join(config.repoDir || join(root, '..', '..'), 'src/content/hospitals', `${hid}.json`);
const board = JSON.parse(readFileSync(boardPath, 'utf8'));
const org = orgByHid(hid); if (!org) { console.error(`平台沒有 ${hid} 這個院所`); process.exit(2); }
let site = q.get('SELECT * FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', org.id);
const plan = [];
const t = nowIso();
const ref = (k) => `board:${hid}:${k}`;
const item = (code) => q.get('SELECT id FROM inventory_items WHERE code = ?', code)?.id;

if (!site) plan.push({ what: '院區', name: '本院區', run: () => { site = { id: newId('site') }; insert('sites', { id: site.id, org_id: org.id, name: '本院區', created_at: t, updated_at: t }); } });

// 分區：建物與樓層
const floorsText = (fl) => fl.map((f) => f.floor).filter(Boolean).join('、');
const bldByName = (name) => q.get('SELECT b.* FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.org_id = ? AND b.name = ?', org.id, name);
for (const b of board.env?.peace?.buildings || []) {
  if (!b.name || bldByName(b.name)) continue;
  plan.push({ what: '建物', name: `${b.name}（${floorsText(b.floors || [])}）`, run: () => {
    insert('buildings', { id: newId('bld'), site_id: site.id, name: b.name, floors: floorsText(b.floors || []), attrs: {}, note: `由看板環境參數建立`, created_at: t, updated_at: t });
  } });
}
if (outdoor.length && !bldByName('周邊')) {
  plan.push({ what: '周邊', name: outdoor.join('、'), run: () => {
    insert('buildings', { id: newId('bld'), site_id: site.id, name: '周邊', floors: outdoor.join('、'), attrs: { zoneKind: 'outdoor' }, created_at: t, updated_at: t });
  } });
}

const power = (board.resources || []).find((r) => r.id === 'power');
const mk = (key, row) => {
  if (q.get('SELECT 1 FROM assets WHERE org_id = ? AND legacy_ref = ?', org.id, ref(key))) return;
  plan.push({ what: row.asset_type, name: row.name, run: () => {
    const id = newId('ast');
    if (row.building_name) { row.building_id = bldByName(row.building_name)?.id || null; }
    delete row.building_name;
    const r = { id, org_id: org.id, site_id: site.id, status: 'active', work_status: 'to_register', owner_status: 'unknown', legacy_ref: ref(key), created_by: 'seed', created_at: t, updated_at: t, ...row };
    insert('assets', r);
    insert('asset_history', { id: newId('ah'), asset_id: id, change_type: 'create', after: r, reason: `由看板資料建立（${hid}.json）`, actor: 'seed', effective_at: t.slice(0, 10), at: t });
    audit({ actor: 'seed', actorName: '看板資料轉入', orgId: org.id, action: 'asset.create', targetType: 'asset', targetId: id, after: r });
  } });
};
// 台電：受電點各一個電號（受電總盤）。院方受電點以電壓命名（「大坑變電所 22.8KV」→「受電點 22.8kV」），變電所是台電端的供電來源，記在說明
for (const d of (power?.devices || []).filter((x) => x.system === '受電')) {
  const kv = (d.name.match(/([\d.]+)\s*KV/i) || [])[1];
  const sub = d.name.replace(/\s*[\d.]+\s*KV/i, '').trim();
  mk(`tpc:${d.name}`, { domain: 'electricity', item_id: item('ELE-GRID'), asset_type: 'power_account', name: kv ? `受電點 ${kv}kV` : `受電點（${sub}）`,
    attrs: { supplyKv: kv ? Number(kv) : undefined, note: `台電${sub}供電` } });
}
// 油：柴油發電機
for (const d of (power?.devices || []).filter((x) => /柴油發電機\s*G\d+/.test(x.name))) {
  const g = d.name.match(/(G\d+)/)[1]; const kw = (d.name.match(/(\d+)\s*KW/i) || [])[1];
  // 所在建物：loc 只對得到一棟才填（「醫療·綜合大樓」這種跨兩棟的不猜，原文留在 location）
  const names = (board.env?.peace?.buildings || []).map((b) => b.name).filter(Boolean);
  const loc = String(d.loc || '');
  const hits = names.filter((n) => loc.includes(n) || loc.includes(n.replace(/大樓$/, '')));
  const bname = hits.length === 1 ? hits[0] : null;
  mk(`gen:${g}`, { domain: 'oil', item_id: item('OIL-GEN'), asset_type: 'generator', name: `柴油發電機 ${g}`,
    building_name: bname || null, location: d.loc || null, attrs: { ratedKw: kw ? Number(kw) : undefined, fuel: 'diesel', note: d.reading || undefined } });
}

console.log(`${org.name}（${hid}）${dry ? '［試算］' : ''}`);
for (const p of plan) console.log(`  + ${p.what}：${p.name}`);
if (!plan.length) console.log('  （沒有要新增的）');
if (!dry && plan.length) {
  // 建物要先建，發電機才找得到所在建物
  tx(() => { for (const p of plan.filter((x) => x.what === '院區' || x.what === '建物' || x.what === '周邊')) p.run(); });
  tx(() => { for (const p of plan.filter((x) => !['院區', '建物', '周邊'].includes(x.what))) p.run(); });
  console.log('完成。');
}
