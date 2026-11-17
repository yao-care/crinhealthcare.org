#!/usr/bin/env node
// 公開資料先補院所資料（每一筆都要有來源網址；只補空欄，不覆蓋院方已填的值）
//   node scripts/pub-import.mjs <院所代碼> <公開資料.json> [--dry-run]
//
// JSON 格式：{ fields: { taxId: {value,url,quote,asOf}, ... }, buildings: [{name,floorsAbove,floorsBelow,floorAreaM2,note,url,quote}] }
// 寫入：
//   院所基本資料  對得上的欄位補進去，標「公開資料・待院方確認」（data._pub）
//   院區地址      sites.address 空的才補
//   建物          名稱不存在才建，note 記來源
//   病床數        營運數據「病床與樓地板面積」，來源＝「公開資料（待院方確認）」，值狀態＝推估
// 公開資料檔放 scratchpad 或 /opt 底下，不進 repo。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
process.env.PLATFORM_SCHEDULER = '0';
const args = process.argv.slice(2);
const [hid, file] = args.filter((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
if (!hid || !file) { console.error('用法：node scripts/pub-import.mjs <院所代碼> <公開資料.json> [--dry-run]'); process.exit(2); }

const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
const { orgByHid } = await import('../src/platform/authz.js');
const P = await import('../src/platform/profile.js');
const O = await import('../src/platform/observations.js');
db.openDb(); runSeeds();
const { q, insert, update, newId, nowIso, audit } = db;

const pub = JSON.parse(readFileSync(file, 'utf8'));
const org = orgByHid(hid); if (!org) { console.error(`平台沒有 ${hid} 這個院所`); process.exit(2); }
const F = pub.fields || {};
// 維基百科不算可靠來源，不拿來補
const trusted = (u) => u && !/wikipedia\.org/i.test(u);
const ok = (e) => e && trusted(e.url) && String(e.value ?? '').trim() !== '';
const val = (e) => String(e.value).trim();
const out = [];

// 欄位對照：公開資料鍵 → 基本資料鍵
const entries = {};
for (const k of ['taxId', 'hqName', 'representative', 'address', 'county', 'district', 'zip', 'medicalCode', 'authority', 'govAgencyCode', 'govParentAgency', 'moenvControlNo', 'employees']) {
  if (ok(F[k])) entries[k] = F[k];
}
if (ok(F.representative)) {
  const head = [val(F.representative), ok(F.phone) ? `總機 ${val(F.phone)}` : ''].filter(Boolean).join('，');
  entries.govHead = { value: head, url: F.representative.url, quote: F.representative.quote, asOf: F.representative.asOf };
}
// 組織描述：機關全銜、層級、病床、院址，各段都是公開資料原文整理
const desc = [ok(F.hqName) ? val(F.hqName) : org.name, ok(F.hospitalLevel) ? val(F.hospitalLevel) : '', ok(F.beds) ? `病床 ${val(F.beds)}` : '', ok(F.address) ? `院址 ${val(F.address)}` : ''].filter(Boolean);
const descSrc = [F.hospitalLevel, F.beds, F.address].find(ok);
if (desc.length > 1 && descSrc) entries.description = { value: desc.join('；'), url: descSrc.url, quote: [F.hospitalLevel, F.beds].filter(ok).map((e) => e.quote).join(' ／ '), asOf: descSrc.asOf };

const cur = P.getProfile(org.id);
const willFill = Object.keys(entries).filter((k) => !(cur[k] && !cur._pub?.[k]));
out.push(`基本資料：${willFill.length ? willFill.join('、') : '（無可補）'}`);

const site = q.get('SELECT * FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', org.id);
const addr = ok(F.address) && site && !site.address ? val(F.address) : null;
if (addr) out.push(`院區地址：${addr}`);

const floorsOf = (b) => {
  const up = Number(b.floorsAbove) || 0; const dn = Number(b.floorsBelow) || 0;
  return [...Array.from({ length: up }, (_, i) => `${up - i}F`), ...Array.from({ length: dn }, (_, i) => `B${i + 1}`)].join('、');
};
const bldByName = (name) => q.get('SELECT b.* FROM buildings b JOIN sites s ON s.id = b.site_id WHERE s.org_id = ? AND b.name = ?', org.id, name);
// 「全院…」是全院合計的樓地板面積，不是一棟建物：記到營運數據的總樓地板面積
const whole = (pub.buildings || []).find((b) => /^全院/.test(b.name || '') && Number(b.floorAreaM2) > 0 && trusted(b.url));
const newB = (pub.buildings || []).filter((b) => b.name && !/^全院/.test(b.name) && trusted(b.url) && !bldByName(b.name));
for (const b of newB) out.push(`建物：${b.name}${floorsOf(b) ? `（${floorsOf(b)}）` : ''}${b.floorAreaM2 ? ` ${b.floorAreaM2} m²` : ''}`);

const bedsN = ok(F.beds) ? Number(String(F.beds.value).replace(/[^\d.]/g, '')) : NaN;
const cap = q.get("SELECT a.* FROM assets a JOIN inventory_items i ON i.id = a.item_id WHERE a.org_id = ? AND i.code = 'ACT-CAP' AND a.status = 'active' LIMIT 1", org.id);
const doBeds = Number.isFinite(bedsN) && bedsN > 0 && cap;
if (doBeds) out.push(`營運數據 病床數：${bedsN}`);
if (whole && cap) out.push(`營運數據 總樓地板面積：${whole.floorAreaM2} m²`);

console.log(`${hid} ${org.name}${dry ? '（試跑）' : ''}\n  ${out.join('\n  ')}`);
if (dry) process.exit(0);

P.fillProfileFromPublic(org.id, entries);
const t = nowIso();
if (addr) { update('sites', site.id, { address: addr, updated_at: t }); audit({ actor: 'public-data', actorName: '公開資料補登', orgId: org.id, action: 'site.update', targetType: 'site', targetId: site.id, before: { address: null }, after: { address: addr, source: F.address.url } }); }
for (const b of newB) {
  const id = newId('bld');
  insert('buildings', { id, site_id: site.id, name: b.name, floors: floorsOf(b) || null, floor_area_m2: Number(b.floorAreaM2) || null,
    attrs: { pub: { url: b.url, quote: b.quote || '' } }, note: `公開資料・待院方確認：${b.url}${b.note ? `（${b.note}）` : ''}`, created_at: t, updated_at: t });
  audit({ actor: 'public-data', actorName: '公開資料補登', orgId: org.id, action: 'building.create', targetType: 'building', targetId: id, after: { name: b.name, source: b.url } });
}
const pubSrc = () => {
  let src = q.get("SELECT * FROM data_sources WHERE asset_id = ? AND name = '公開資料（待院方確認）'", cap.id);
  if (!src) { src = { id: newId('src'), org_id: org.id, asset_id: cap.id, item_id: cap.item_id, name: '公開資料（待院方確認）', source_type: 'document', acquisition: 'import', priority: 10, owner_status: 'unknown', note: '院方提供正式數字後以院方為準', created_by: 'public-data', created_at: t, updated_at: t }; insert('data_sources', src); }
  return src;
};
if (whole && cap) {
  const d = t.slice(0, 10);
  O.addObservation({ userId: 'public-data', name: '公開資料補登' }, { assetId: cap.id, metricCode: 'floor_area_m2', periodStart: d, periodEnd: d, rawValue: Number(whole.floorAreaM2), rawUnit: 'm2', valueState: 'estimated', sourceId: pubSrc().id, sourceRecordKey: `pub:floor_area_m2:${d}`, note: `${whole.url}　${whole.quote || ''}${whole.note ? `（${whole.note}）` : ''}`.trim() }, { method: 'import', skipCheck: true });
}
if (doBeds) {
  const src = pubSrc();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(F.beds.asOf || '') ? F.beds.asOf : t.slice(0, 10);
  O.addObservation({ userId: 'public-data', name: '公開資料補登' }, { assetId: cap.id, metricCode: 'beds', periodStart: d, periodEnd: d, rawValue: bedsN, rawUnit: 'bed', valueState: 'estimated', sourceId: src.id, sourceRecordKey: `pub:beds:${d}`, note: `${F.beds.url}　${F.beds.quote || ''}`.trim() }, { method: 'import', skipCheck: true });
}
console.log('  已寫入');
