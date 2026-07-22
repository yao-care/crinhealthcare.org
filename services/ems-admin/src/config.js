// 設定：.env（services/ems-admin/.env）。缺關鍵值 → 啟動即報錯（fail fast）。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const abs = (p, base) => (p.startsWith('/') ? p : resolve(base, p));

export const config = {
  httpPort: Number(process.env.HTTP_PORT || 8470),
  jwtSecret: process.env.JWT_SECRET || '',
  accountsFile: abs(process.env.ACCOUNTS_FILE || './accounts.json', root),
  repoDir: process.env.REPO_DIR || '',
  gitBranch: process.env.GIT_BRANCH || 'main',
  gitAuthorName: process.env.GIT_AUTHOR_NAME || 'EMS Admin',
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'ems-admin@crinhealthcare.org',
  allowOrigins: (process.env.ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: process.env.COOKIE_SECURE !== '0',
};

// 本地開發（localhost）一律視為同源放行
export function originAllowed(origin) {
  if (!origin) return true; // 同源請求常無 Origin header
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return config.allowOrigins.includes(origin);
}

export function assertConfig() {
  const miss = [];
  if (!config.jwtSecret || config.jwtSecret.length < 16) miss.push('JWT_SECRET（至少 16 字元亂數）');
  if (!config.repoDir) miss.push('REPO_DIR（git 工作副本路徑）');
  if (miss.length) {
    console.error('[ems-admin] 設定缺漏，無法啟動：\n  - ' + miss.join('\n  - '));
    process.exit(1);
  }
}
