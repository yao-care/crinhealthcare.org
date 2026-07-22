// HTTP 伺服器：登入 / 讀取 / 儲存 API + 靜態前端。Node 內建 http，無框架。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { config, originAllowed } from './config.js';
import { login } from './accounts.js';
import { signToken, setSessionCookie, clearSessionCookie, readSession } from './auth.js';
import { validateHospital } from './schema.js';
import { readHospital, saveHospital, hospitalExists } from './repo.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('payload_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const full = normalize(join(PUB, p));
  if (!full.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

// 對「改變狀態」的請求做同源/Origin 檢查（SameSite=Strict 之外再加一層 CSRF 防護）
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // 同源請求常無 Origin
  return originAllowed(o);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    // ── 健康檢查 ──
    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true, ts: Date.now() });
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── 登入 ──
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
      const { username, password } = await readBody(req);
      if (!username || !password) return json(res, 400, { ok: false, error: 'missing' });
      const r = login(String(username), String(password));
      if (!r.ok) return json(res, 401, { ok: false, error: r.code, retryMs: r.retryMs });
      setSessionCookie(res, signToken(r.session));
      return json(res, 200, { ok: true, hid: r.session.hid, name: r.session.name });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    // ── 以下皆需登入 ──
    const sess = readSession(req);
    if (pathname.startsWith('/api/')) {
      if (!sess) return json(res, 401, { ok: false, error: 'unauthorized' });

      if (req.method === 'GET' && pathname === '/api/me') {
        return json(res, 200, { ok: true, username: sess.sub, hid: sess.hid, name: sess.name });
      }

      // 讀取自家院所現況
      if (req.method === 'GET' && pathname === '/api/hospital') {
        if (!(await hospitalExists(sess.hid))) return json(res, 404, { ok: false, error: 'hospital_not_found' });
        const data = await readHospital(sess.hid);
        return json(res, 200, { ok: true, hospitalId: sess.hid, data });
      }

      // 儲存自家院所（送出即 push）
      if (req.method === 'POST' && pathname === '/api/hospital') {
        if (!originOk(req)) return json(res, 403, { ok: false, error: 'bad_origin' });
        const body = await readBody(req, 4 * 1024 * 1024);
        const data = body?.data;
        if (!data || typeof data !== 'object') return json(res, 400, { ok: false, error: 'missing_data' });
        const v = validateHospital(data);
        if (!v.ok) return json(res, 422, { ok: false, error: 'validation', details: v.errors });
        try {
          const r = await saveHospital(sess.hid, data, { who: sess.name || sess.sub });
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 500, { ok: false, error: 'save_failed', message: String(e.message || e) });
        }
      }

      return json(res, 404, { ok: false, error: 'not_found' });
    }

    // ── 靜態前端 ──
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end('method not allowed');
  } catch (e) {
    const msg = String(e.message || e);
    const code = msg === 'payload_too_large' ? 413 : msg === 'bad_json' ? 400 : 500;
    json(res, code, { ok: false, error: msg });
  }
});

export function start() {
  server.listen(config.httpPort, '0.0.0.0', () => {
    console.log(`[ems-admin] listening on 0.0.0.0:${config.httpPort} · repo=${config.repoDir}`);
  });
}
