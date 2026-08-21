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

  // ── 電力健檢填報：資料一律落在主機本地，不進公開 repo ──
  // 為什麼分開：REPO_DIR 指向的是公開的 crinhealthcare.org，
  // 聯絡人個資、電費單、逐筆排放源清單推上去就等於公開。
  // 填報資料只走下面兩個路徑：dataDir 自己是一個「沒有 remote」的 git 倉庫
  // （留稽核軌跡但推不出去），uploadsDir 存佐證檔案本體
  // （二進位，刻意不進 git，避免倉庫膨脹）。
  dataDir: process.env.AUDIT_DATA_DIR || '/opt/ems-admin/data',
  uploadsDir: process.env.AUDIT_UPLOADS_DIR || '/opt/ems-admin/uploads',
  uploadMaxBytes: Number(process.env.AUDIT_UPLOAD_MAX_BYTES || 25 * 1024 * 1024),

  // 佐證檔案自動解析（PDF／掃描件／照片）。沒設 key 也能用，
  // 只是解析功能會停用、改請院方自行填寫——不因為缺 key 就讓整個填報流程停擺。
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  extractModel: process.env.AUDIT_EXTRACT_MODEL || 'claude-opus-5',
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
