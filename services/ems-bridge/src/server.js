// HTTP 伺服器（node 內建 http）：GET /api/ess、GET /healthz。綁 0.0.0.0（主機慣例：NPM 由 172.18.0.1 反代，UFW 擋公網）。
import http from 'node:http';
import { corsAllowed } from './config.js';

export function startServer({ httpPort, getSnapshot }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(corsAllowed(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
    };
    const url = req.url?.split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET' });
      return res.end();
    }
    if (req.method !== 'GET') {
      res.writeHead(405, headers);
      return res.end(JSON.stringify({ error: 'method not allowed' }));
    }
    const snap = getSnapshot();
    if (url === '/healthz') {
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: snap.ok, ts: snap.ts, source: snap.source, uptime: process.uptime() }));
    }
    if (url === '/api/ess') {
      res.writeHead(snap.ok ? 200 : 503, headers);
      return res.end(JSON.stringify(snap));
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(httpPort, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${httpPort}`);
  });
  return server;
}
