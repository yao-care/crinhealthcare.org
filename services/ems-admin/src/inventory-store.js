// 能源盤點資料的落地層：config.dataDir/inventory/<hid>.json。
//
// ⚠️ 跟健檢填報（audit-store）同一個倉庫——主機本地、**沒有 remote** 的 git。
// 不可寫進 REPO_DIR（public repo）：能管人員姓名電話、電費單、設備清冊都不是該公開的東西。
//
// 為什麼所有寫入都走 mutateInventory（讀＋改＋寫在同一把鎖裡）：
// 貼紙頁是多支手機同時在掃，兩個人同時送出時若各自先讀再寫，後寫的會把先寫的紀錄蓋掉。
// 鎖跟 audit-store 共用，因為兩邊 commit 同一個倉庫，各用一把會撞 .git/index.lock。
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { config } from './config.js';
import { safeId, ensureInit, gitCommit, withLock, uploadDirFor } from './audit-store.js';
import { blankInventory, SITE_BLOCKS, resolveSiteRefs } from './inventory-schema.js';

const rel = (hid) => `inventory/${safeId(hid)}.json`;
const invPath = (hid) => join(config.dataDir, rel(hid));
export const photoDirFor = (hid) => join(uploadDirFor(hid), 'inventory');

// 短 id：時間序（方便排序與肉眼對照）＋亂數（同毫秒不撞）
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

// 讀檔＋補齊骨架：舊檔缺的區塊補空值，前端不用到處防 undefined
function normalize(saved) {
  const blank = blankInventory();
  if (!saved || typeof saved !== 'object') return blank;
  const out = { ...blank, ...saved, site: { ...blank.site, ...(saved.site || {}) } };
  for (const b of SITE_BLOCKS) {
    const v = out.site[b.id];
    out.site[b.id] = b.kind === 'form' ? (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) : (Array.isArray(v) ? v : []);
  }
  for (const k of ['equipment', 'points', 'records', 'changes', 'measures', 'plans']) if (!Array.isArray(out[k])) out[k] = [];
  // 舊資料的建築物名稱（文字）→ buildings[].id；對不上的保留原文字（siteRefIssues 會列待修）
  return resolveSiteRefs(out);
}

async function readRaw(hid) {
  try { return normalize(JSON.parse(await readFile(invPath(hid), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return blankInventory(); throw e; }
}

// 讀取：檔案不存在回空白骨架（第一次進來的院所不該看到錯誤畫面）
export async function readInventory(hid) {
  await ensureInit();
  return readRaw(hid);
}

// 讀＋改＋寫，全程持鎖。mutator(inv) 直接改 inv 並回傳要給呼叫端的結果；
// 丟例外 → 不寫檔（用於驗證失敗、讀數倒退等情況）。回傳 { result, commit, updated }。
export async function mutateInventory(hid, mutator, meta = {}) {
  await ensureInit();
  return withLock(async () => {
    const inv = await readRaw(hid);
    const result = await mutator(inv);
    inv.version = 1;
    inv.updated = new Date().toISOString();
    await mkdir(join(config.dataDir, 'inventory'), { recursive: true });
    // 先寫暫存檔再 rename：寫到一半當機也不會留下半截 JSON（.gitignore 已排除 *.tmp）
    const tmp = invPath(hid) + '.tmp';
    await writeFile(tmp, JSON.stringify(inv, null, 2) + '\n', 'utf8');
    await rename(tmp, invPath(hid));
    const sha = await gitCommit([rel(hid)], `inv(${hid}): ${meta.what || '更新'}（${meta.who || 'ems-admin'}）`);
    return { result, commit: sha, updated: inv.updated };
  });
}

// 整份覆寫（測試與日後資料轉移用）
export function saveInventory(hid, inv, meta) {
  return mutateInventory(hid, (cur) => { Object.assign(cur, normalize(inv)); }, meta);
}

// ── 照片：uploadsDir/<hid>/inventory/<id>.<ext>（二進位不進 git）──
const PHOTO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const EXT_MIME = Object.fromEntries(Object.entries(PHOTO_EXT).map(([m, e]) => [e, m]));
export const photoMime = (mime, filename) => {
  const m = String(mime || '').split(';')[0].trim();
  if (PHOTO_EXT[m]) return m;
  const ext = String(filename || '').toLowerCase().match(/\.(jpe?g|png|webp|pdf)$/)?.[1];
  return ext ? EXT_MIME[ext === 'jpeg' ? '.jpg' : `.${ext}`] : null;
};

export async function storePhoto(hid, pointCode, { mime, data }) {
  const dir = photoDirFor(hid);
  await mkdir(dir, { recursive: true });
  // 代碼裡的 '-' 換成 '_'：id 只用一種分隔符，日後切字串不會誤判
  const id = `${safeId(hid)}_${String(pointCode).replace(/[^A-Za-z0-9]/g, '_')}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const storedName = id + PHOTO_EXT[mime];
  await writeFile(join(dir, storedName), data);
  return { id, storedName, mime, size: data.length, uploadedAt: new Date().toISOString() };
}

// 依 id 找照片檔（不另建索引：檔案本身就是索引，id 也已限制成檔名安全字元）
export async function findPhoto(hid, id) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(id))) return null;
  let names;
  try { names = await readdir(photoDirFor(hid)); } catch { return null; }
  const name = names.find((n) => n.startsWith(id + '.'));
  if (!name) return null;
  const full = join(photoDirFor(hid), name);
  const st = await stat(full);
  return { id, storedName: name, path: full, size: st.size, mime: EXT_MIME[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' };
}

export async function readPhoto(hid, id) {
  const p = await findPhoto(hid, id);
  return p ? { ...p, data: await readFile(p.path) } : null;
}

// 這份盤點檔的 git log：管理端回答「這個數字誰、什麼時候改的」
export async function inventoryHistory(hid, n = 20) {
  await ensureInit();
  const out = await new Promise((resolve) => {
    execFile('git', ['log', `-n${Math.min(Number(n) || 20, 100)}`, '--format=%H%x1f%ct%x1f%s', '--', rel(hid)],
      { cwd: config.dataDir }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha, ts, subject] = line.split('\x1f');
    return { sha, shortSha: sha.slice(0, 7), at: Number(ts) * 1000, subject };
  });
}
