// 電力健檢填報資料的落地層。
//
// ⚠️ 這裡跟 repo.js 是**兩套完全分開的儲存**，不要合併：
//   repo.js       → REPO_DIR（公開的 crinhealthcare.org 工作副本）→ push 到 GitHub → 看板
//   audit-store   → config.dataDir（主機本地、**沒有 remote** 的 git 倉庫）→ 推不出去
// 聯絡人個資、電費單、逐筆排放源清單只能走這一支。哪天有人想「順便 push 一下」，
// 記得公文附件一那張表上有姓名、電話、電子郵件，而那個 repo 是 public。
//
// 為什麼還是用 git：院方會問「這個數字上週是多少、誰改的」，git log 直接答得出來，
// 而且免費拿到原子性與可回溯。沒有 remote 就不會外流。
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { blankAudit, BLOCKS } from './audit-schema.js';

const exec = promisify(execFile);

export function safeId(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error('不合法的院所代碼');
  return String(id);
}

const auditPath = (hid) => join(config.dataDir, `${safeId(hid)}.json`);
export const uploadDirFor = (hid) => join(config.uploadsDir, safeId(hid));

async function git(args, cwd = config.dataDir) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

let inited = null;
// dataDir 第一次使用時建目錄並 git init。刻意不設 origin：這個倉庫推不出去才是它的重點。
async function ensureInit() {
  if (inited) return inited;
  inited = (async () => {
    await mkdir(config.dataDir, { recursive: true });
    await mkdir(config.uploadsDir, { recursive: true });
    try { await access(join(config.dataDir, '.git')); return; } catch { /* 尚未 init */ }
    await git(['init', '-b', 'main']);
    await writeFile(join(config.dataDir, '.gitignore'), 'uploads/\n*.tmp\n', 'utf8');
    await writeFile(join(config.dataDir, 'README.md'),
      '# ems-admin 電力健檢填報資料\n\n' +
      '本倉庫**刻意沒有 remote**：內含院方聯絡人個資與電費資料，不得推送到任何遠端。\n' +
      '佐證檔案本體不在這裡（見 AUDIT_UPLOADS_DIR），只有結構化欄位值與複驗狀態。\n', 'utf8');
    await gitCommit(['.gitignore', 'README.md'], 'chore: init 健檢填報資料倉庫（無 remote）');
  })();
  return inited;
}

async function gitCommit(files, msg) {
  await git(['add', '--', ...files]);
  const status = await git(['status', '--porcelain', '--', ...files]);
  if (!status) return null;
  await git(['-c', `user.name=${config.gitAuthorName}`, '-c', `user.email=${config.gitAuthorEmail}`,
    'commit', '-m', msg]);
  return (await git(['rev-parse', 'HEAD'])).slice(0, 7);
}

// ── 互斥鎖：同院所同時送出時序列化（與 repo.js 同樣的理由） ──
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// 讀取：檔案不存在就回空白骨架（第一次登入的院所不該看到錯誤畫面）。
// 也順手補上 schema 新增的區塊，避免舊檔缺鍵讓前端到處 undefined。
export async function readAudit(hid) {
  await ensureInit();
  const blank = blankAudit();
  let saved = null;
  try { saved = JSON.parse(await readFile(auditPath(hid), 'utf8')); } catch { return blank; }
  const out = { ...blank, ...saved, blocks: { ...blank.blocks } };
  for (const b of BLOCKS) {
    const got = saved.blocks?.[b.id];
    if (!got) continue;
    out.blocks[b.id] = b.kind === 'table'
      ? { rows: Array.isArray(got.rows) ? got.rows : [] }
      : { values: got.values || {}, meta: got.meta || {} };
  }
  return out;
}

export async function saveAudit(hid, audit, meta) {
  await ensureInit();
  const rel = `${safeId(hid)}.json`;
  const body = { ...audit, updated: new Date().toISOString() };
  const json = JSON.stringify(body, null, 2) + '\n';
  return withLock(async () => {
    await writeFile(auditPath(hid), json, 'utf8');
    const who = meta?.who || 'ems-admin';
    const sha = await gitCommit([rel], `data(${hid}): 健檢填報更新（${who}）`);
    return { commit: sha, unchanged: sha === null, updated: body.updated };
  });
}

export async function auditHistory(hid, n = 10) {
  await ensureInit();
  const rel = `${safeId(hid)}.json`;
  let out = '';
  try { out = await git(['log', `-n${Math.min(Number(n) || 10, 50)}`, '--format=%H%x1f%ct%x1f%s', '--', rel]); }
  catch { return []; }
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha, ts, subject] = line.split('\x1f');
    return { sha, shortSha: sha.slice(0, 7), at: Number(ts) * 1000, subject };
  });
}

// ── 佐證檔案清單（存在 audit.files，檔案本體在 uploadsDir） ──
export async function removeUpload(hid, storedName) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(storedName))) throw new Error('不合法的檔名');
  await rm(join(uploadDirFor(hid), storedName), { force: true });
}

export async function readUpload(hid, storedName) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(storedName))) throw new Error('不合法的檔名');
  return readFile(join(uploadDirFor(hid), storedName));
}

export async function health() {
  await ensureInit();
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'unknown');
  let remotes = '';
  try { remotes = await git(['remote']); } catch { remotes = ''; }
  return { dataDir: config.dataDir, uploadsDir: config.uploadsDir, branch: head, remotes: remotes ? remotes.split('\n') : [] };
}
