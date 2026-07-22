// repo：從 REPO_DIR（有推送權限的 git 工作副本）讀寫 hospital JSON，送出時 commit + push。
// git 操作以互斥鎖序列化（同時多人送出也不會撞）。
import { readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);
const HOSP_DIR = 'src/content/hospitals';

function hospitalPath(hid) {
  // hid 僅允許檔名安全字元，杜絕路徑穿越
  if (!/^[a-z0-9_-]+$/i.test(hid)) throw new Error('不合法的院所代碼');
  return join(config.repoDir, HOSP_DIR, `${hid}.json`);
}

export async function hospitalExists(hid) {
  try { await access(hospitalPath(hid)); return true; } catch { return false; }
}

export async function readHospital(hid) {
  const raw = await readFile(hospitalPath(hid), 'utf8');
  return JSON.parse(raw);
}

async function git(args) {
  const { stdout } = await exec('git', args, { cwd: config.repoDir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// ── 互斥鎖：所有 git 寫入序列化 ──
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {}); // 不讓單次失敗卡住後續
  return run;
}

// 寫檔 + commit + push。回傳 { commit, pushed }。
export async function saveHospital(hid, dataObj, meta) {
  const path = hospitalPath(hid);
  const json = JSON.stringify(dataObj, null, 2) + '\n';
  return withLock(async () => {
    // 先與遠端同步，降低 push 被拒機率
    await git(['fetch', 'origin', config.gitBranch]);
    await git(['checkout', config.gitBranch]);
    await git(['reset', '--hard', `origin/${config.gitBranch}`]);

    await writeFile(path, json, 'utf8');

    const status = await git(['status', '--porcelain', '--', `${HOSP_DIR}/${hid}.json`]);
    if (!status) return { commit: null, pushed: false, unchanged: true };

    const who = meta?.who || 'ems-admin';
    const msg = `chore(ems): ${hid} 維護表單更新（${who}）`;
    await git(['-c', `user.name=${config.gitAuthorName}`, '-c', `user.email=${config.gitAuthorEmail}`,
      'add', '--', `${HOSP_DIR}/${hid}.json`]);
    await git(['-c', `user.name=${config.gitAuthorName}`, '-c', `user.email=${config.gitAuthorEmail}`,
      'commit', '-m', msg]);
    const commit = await git(['rev-parse', '--short', 'HEAD']);
    await git(['push', 'origin', config.gitBranch]);
    return { commit, pushed: true, unchanged: false };
  });
}

// 健康檢查：確認 REPO_DIR 是 git 樹且能連遠端
export async function repoHealth() {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = await git(['remote', 'get-url', 'origin']);
  return { branch, remote };
}
