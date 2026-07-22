#!/usr/bin/env node
// 產生/追加一組院所帳號到 accounts.json（scrypt 雜湊）。
// 用法（密碼走環境變數，不落 argv / process list）：
//   EMS_PW='院方密碼' node scripts/hash-password.mjs <username> <hospitalId> "<顯示名稱>"
// 例：
//   EMS_PW='xxxx' node scripts/hash-password.mjs hosp-802 802 "國軍高雄總醫院"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { hashPassword } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const accountsFile = (() => {
  const p = process.env.ACCOUNTS_FILE || './accounts.json';
  return p.startsWith('/') ? p : resolve(root, p);
})();

const [username, hospitalId, displayName] = process.argv.slice(2);
const password = process.env.EMS_PW;
if (!username || !hospitalId || !password) {
  console.error('用法：EMS_PW=\'密碼\' node scripts/hash-password.mjs <username> <hospitalId> "<顯示名稱>"');
  process.exit(1);
}

const db = existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')) : { accounts: [] };
if (!Array.isArray(db.accounts)) { console.error('accounts.json 格式錯誤'); process.exit(1); }

const entry = { username, hospitalId, displayName: displayName || hospitalId, password: hashPassword(password) };
const i = db.accounts.findIndex((a) => a.username === username);
if (i >= 0) { db.accounts[i] = entry; console.log(`已更新帳號 ${username} → ${hospitalId}`); }
else { db.accounts.push(entry); console.log(`已新增帳號 ${username} → ${hospitalId}`); }

writeFileSync(accountsFile, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
console.log(`寫入 ${accountsFile}（權限 600）。目前共 ${db.accounts.length} 組帳號。`);
