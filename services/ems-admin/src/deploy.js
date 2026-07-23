// 查詢某 commit 的 GitHub Pages 部署狀態，並確認 live 看板頁活著。
// 用主機的 gh（read-only 查 Actions），與推送用的 PAT 分離。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GH = process.env.GH_BIN || 'gh';
const REPO = 'yao-care/crinhealthcare.org';
const DEPLOY_WF = 'Deploy to GitHub Pages';

export async function deployStatus(sha, hid) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad_sha');
  let runs = [];
  try {
    const { stdout } = await exec(GH, ['api', `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=15`],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    runs = (JSON.parse(stdout).workflow_runs || []).filter((r) => r.name === DEPLOY_WF);
  } catch (e) {
    return { phase: 'unknown', detail: String(e.message || e) };
  }
  if (runs.length === 0) return { phase: 'pending' };                 // run 尚未登記
  const run = runs.sort((a, b) => (b.run_number || 0) - (a.run_number || 0))[0];
  if (run.status !== 'completed') return { phase: 'deploying', status: run.status };
  if (run.conclusion !== 'success') return { phase: 'failed', conclusion: run.conclusion };

  // 部署成功 → 確認 live 看板頁真的活著
  const url = `https://crinhealthcare.org/${hid}/`;
  let ok = false, code = 0;
  try { const res = await fetch(url, { redirect: 'follow' }); code = res.status; ok = res.ok; } catch { /* 尚未傳播 */ }
  return ok ? { phase: 'done', url } : { phase: 'propagating', url, code };
}
