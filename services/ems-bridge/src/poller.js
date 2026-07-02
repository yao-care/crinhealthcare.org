// 輪詢主迴圈：每 pollMs 讀取→解碼→更新快照。連續失敗 ≥3 → ok:false（HTTP 端回 503）。
import { decode } from './decode.js';

export function startPoller(client, { pollMs, source }) {
  let snapshot = { ok: false, ts: null, source, data: null };
  let failures = 0;
  let timer = null;
  let stopped = false;

  async function cycle() {
    try {
      const raw = await client.readAll();
      snapshot = { ok: true, ts: new Date().toISOString(), source, data: decode(raw) };
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= 3) snapshot = { ...snapshot, ok: false };
      if (failures === 3) console.error(`[poller] 連續 3 次讀取失敗：${err.message}`);
    }
    if (!stopped) timer = setTimeout(cycle, pollMs);
  }
  cycle();

  return {
    getSnapshot: () => snapshot,
    stop() { stopped = true; clearTimeout(timer); },
  };
}
