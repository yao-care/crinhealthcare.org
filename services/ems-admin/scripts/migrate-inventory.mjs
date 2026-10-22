#!/usr/bin/env node
// 健檢填報舊資料 → 能源盤點（工作清單第 16 項）。原 audit 檔只讀不改。
//
//   node scripts/migrate-inventory.mjs <hid|--all> [--dry-run] [--json]
//
// --dry-run 只印報告，不寫任何檔。資料目錄取 AUDIT_DATA_DIR（沒設就是 .env／預設 /opt/ems-admin/data）。
// 重跑安全：轉過的東西記在 inventory 的 migration.audit.map，只補新出現的資料。
// 寫入後若服務正在跑，不用重啟：inventory 每次請求都重新讀檔。
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--')) || (args.includes('--all') ? '--all' : null);
if (!target) {
  console.error('用法：node scripts/migrate-inventory.mjs <hid|--all> [--dry-run] [--json]');
  process.exit(2);
}

const { migrateHospital, migrateAll, formatReport } = await import('../src/inventory-migrate.js');
const { config } = await import('../src/config.js');

const reports = target === '--all' ? await migrateAll({ dryRun }) : [await migrateHospital(target, { dryRun })];
if (asJson) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  console.log(`資料目錄：${config.dataDir}${dryRun ? '（試跑，不寫檔）' : ''}`);
  if (!reports.length) console.log('沒有任何院所的健檢填報檔。');
  for (const r of reports) console.log(formatReport(r));
  const sum = (k) => reports.reduce((a, r) => a + (r.created?.[k] || 0), 0);
  console.log(`合計 ${reports.length} 家：電號 ${sum('meters')}、點位 ${sum('points')}、電費單紀錄 ${sum('records')}、設備 ${sum('equipment')}、能管人員 ${sum('staff')}、基本資料 ${sum('basicFields')} 欄；沒對上欄位 ${reports.reduce((a, r) => a + (r.unmapped?.length || 0), 0)} 個`);
}
