// 排程：介接同步（每分鐘檢查到期）、逾期提醒與 Email（每小時）、每日備份、每週驗證佐證雜湊。
// 單一程序內執行；PLATFORM_SCHEDULER=0 關閉（測試用）。
import { runDue } from './integrations.js';
import { remindOverdue, sendPendingEmails } from './collab.js';
import { backupNow } from './backup.js';
import { verifyAllEvidence } from './evidence.js';
import { audit, q } from './db.js';

let timers = [];
let running = false;
export function startScheduler() {
  if (process.env.PLATFORM_SCHEDULER === '0' || timers.length) return;
  const safe = (name, fn) => async () => {
    if (running) return; running = true;
    try { await fn(); } catch (e) { console.error(`[platform] scheduler ${name}`, e.message); } finally { running = false; }
  };
  timers.push(setInterval(safe('integrations', () => runDue()), 60 * 1000));
  timers.push(setInterval(safe('reminders', async () => { remindOverdue(); await sendPendingEmails(); }), 60 * 60 * 1000));
  timers.push(setInterval(safe('daily', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const last = q.get("SELECT MAX(at) at FROM audit_events WHERE action = 'backup.create'")?.at || '';
    if (now.getUTCHours() === 18 && !last.startsWith(today)) backupNow('scheduler'); // 台灣時間 02:00
    if (now.getUTCDay() === 0 && now.getUTCHours() === 19) {
      const lastV = q.get("SELECT MAX(at) at FROM audit_events WHERE action = 'evidence.verify'")?.at || '';
      if (!lastV.startsWith(today)) { const r = await verifyAllEvidence(); audit({ actor: 'scheduler', action: 'evidence.verify', after: { checked: r.checked, bad: r.bad.length } }); }
    }
  }), 10 * 60 * 1000));
  for (const t of timers) t.unref?.();
}
export function stopScheduler() { timers.forEach(clearInterval); timers = []; }
