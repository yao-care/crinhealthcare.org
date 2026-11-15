#!/usr/bin/env node
// 平台維運 CLI（資料目錄取 AUDIT_DATA_DIR／PLATFORM_DB；沒設就讀 .env）
//   node scripts/platform-admin.mjs sysadmin <帳號> <姓名>        建立／重設全域系統管理員（密碼走環境變數 EMS_PW）
//   node scripts/platform-admin.mjs verify                        驗證稽核雜湊鏈、定版資料集雜湊、佐證檔雜湊
//   node scripts/platform-admin.mjs backup                        立即備份並驗證
//   node scripts/platform-admin.mjs drill <備份檔名>              還原演練（唯讀比對）
//   node scripts/platform-admin.mjs publish-seed-factors <核准者帳號>  一次核准系統預設係數（需另一位管理員帳號）
//   node scripts/platform-admin.mjs routes                        列出 API 路由
process.env.PLATFORM_SCHEDULER = '0';
const [cmd, ...args] = process.argv.slice(2);
const db = await import('../src/platform/db.js');
const { runSeeds } = await import('../src/platform/seed.js');
db.openDb(); runSeeds();
if (cmd === 'sysadmin') {
  const { bootstrapSysadmin } = await import('../src/platform/users.js');
  if (!args[0] || !process.env.EMS_PW) { console.error('用法：EMS_PW=密碼 node scripts/platform-admin.mjs sysadmin <帳號> <姓名>'); process.exit(1); }
  const id = bootstrapSysadmin({ username: args[0], displayName: args[1] || args[0], password: process.env.EMS_PW });
  console.log(`已建立／重設系統管理員 ${args[0]}（${id}）；首次登入須變更密碼`);
} else if (cmd === 'verify') {
  const { verifyDataset } = await import('../src/platform/datasets.js');
  const { verifyAllEvidence } = await import('../src/platform/evidence.js');
  const chain = db.verifyAuditChain();
  const ds = db.q.all("SELECT id, name FROM datasets WHERE status IN ('locked','superseded')").map((d) => ({ ...d, ...verifyDataset(d.id) }));
  const ev = await verifyAllEvidence();
  console.log(JSON.stringify({ auditChain: chain, datasets: ds.filter((d) => !d.ok), datasetsChecked: ds.length, evidence: ev }, null, 2));
  process.exit(chain.ok && ds.every((d) => d.ok) && !ev.bad.length ? 0 : 2);
} else if (cmd === 'backup') {
  const { backupNow } = await import('../src/platform/backup.js');
  console.log(JSON.stringify(backupNow('cli'), null, 2));
} else if (cmd === 'drill') {
  const { restoreDrill } = await import('../src/platform/backup.js');
  console.log(JSON.stringify(restoreDrill(args[0]), null, 2));
} else if (cmd === 'publish-seed-factors') {
  const { publish } = await import('../src/platform/config-store.js');
  const { contextFor } = await import('../src/platform/authz.js');
  const u = db.q.get('SELECT id FROM users WHERE username = ?', args[0]);
  if (!u) { console.error('找不到核准者帳號'); process.exit(1); }
  const ctx = contextFor({ uid: u.id });
  let n = 0;
  for (const f of db.q.all("SELECT id FROM factors WHERE status = 'pending' AND created_by = 'seed'")) { publish(ctx, 'factor', f.id, { impactAck: true }); n++; }
  console.log(`已核准 ${n} 筆系統預設係數（核准者 ${args[0]}）`);
} else if (cmd === 'routes') {
  const { routeTable } = await import('../src/platform/routes.js');
  for (const r of routeTable()) console.log(`${r.method.padEnd(6)} ${r.path}  ${r.summary}`);
} else {
  console.error('指令：sysadmin | verify | backup | drill | publish-seed-factors | routes'); process.exit(1);
}
