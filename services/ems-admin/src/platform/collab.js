// 協作：待辦、留言、站內通知（＋Email 選用）、逾期提醒。PRD §6、§7、§18 通知
import { connect as tlsConnect } from 'node:tls';
import { q, insert, update, newId, nowIso, audit } from './db.js';
import { assertCan, orgsFor } from './authz.js';
import { bad, notFound } from './util.js';
import { getConfig } from './config-store.js';

export function notify(userId, kind, title, body = '', link = '') {
  if (!userId) return;
  if (!q.get('SELECT 1 FROM users WHERE id = ?', userId)) return;
  insert('notifications', { id: newId('ntf'), user_id: userId, kind, title, body, link, created_at: nowIso() });
}
// 通知某院所具某動作的所有人
export function notifyRole(orgId, action, kind, title, body, link, exceptUserId) {
  const users = q.all(`SELECT DISTINCT g.user_id, g.role, g.scope_type, g.scope_id FROM grants g JOIN users u ON u.id = g.user_id
                       WHERE g.revoked_at IS NULL AND u.status = 'active'`);
  const seen = new Set();
  for (const g of users) {
    if (g.user_id === exceptUserId || seen.has(g.user_id)) continue;
    const ctx = { userId: g.user_id, grants: users.filter((x) => x.user_id === g.user_id) };
    if (orgsFor(ctx, action).includes(orgId)) { seen.add(g.user_id); notify(g.user_id, kind, title, body, link); }
  }
}

export function myNotifications(ctx, { unread } = {}) {
  return q.all(`SELECT * FROM notifications WHERE user_id = ? ${unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`, ctx.userId);
}
export function markRead(ctx, ids) {
  const t = nowIso();
  if (ids === 'all') q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', t, ctx.userId);
  else for (const id of ids || []) q.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', t, id, ctx.userId);
}

// ── 待辦 ──
export function createTask(ctx, body) {
  assertCan(ctx, 'task.write', body.orgId);
  if (!body.title) throw bad('請填待辦標題');
  const t = nowIso(); const id = newId('tsk');
  insert('tasks', { id, org_id: body.orgId, kind: body.kind || 'general', target_type: body.targetType || null, target_id: body.targetId || null,
    title: body.title, assignee: body.assignee || null, due_date: body.dueDate || null, status: 'open', data: body.data || null,
    created_by: ctx.userId, created_at: t, updated_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'task.create', targetType: 'task', targetId: id, after: body });
  if (body.assignee && body.assignee !== ctx.userId) notify(body.assignee, 'task.assigned', body.title, body.data?.note || '', body.link || `#/workbench`);
  return { id };
}
// 系統自動建立（不經權限檢查）
export function systemTask(orgId, { kind, targetType, targetId, title, assignee, dueDate, data, link }) {
  const t = nowIso(); const id = newId('tsk');
  insert('tasks', { id, org_id: orgId, kind, target_type: targetType || null, target_id: targetId || null, title, assignee: assignee || null,
    due_date: dueDate || null, status: 'open', data: data || null, created_by: 'system', created_at: t, updated_at: t });
  if (assignee) notify(assignee, kind, title, '', link || '#/workbench');
  return { id };
}
export function updateTask(ctx, id, body) {
  const tk = q.get('SELECT * FROM tasks WHERE id = ?', id); if (!tk) throw notFound('待辦');
  assertCan(ctx, 'task.write', tk.org_id);
  const patch = { updated_at: nowIso() };
  if (body.status) { patch.status = body.status; if (body.status === 'done') patch.done_at = nowIso(); }
  if (body.assignee !== undefined) patch.assignee = body.assignee;
  if (body.dueDate !== undefined) patch.due_date = body.dueDate;
  update('tasks', id, patch);
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: tk.org_id, action: 'task.update', targetType: 'task', targetId: id, before: tk, after: patch });
  if (body.assignee && body.assignee !== tk.assignee) notify(body.assignee, 'task.assigned', tk.title, '改派給你', '#/workbench');
}
export function listTasks(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return [];
  const where = [`t.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.mine) {
    // 代理：被授權代理某人時，也看得到那個人的待辦
    const delegated = q.all('SELECT DISTINCT delegate_of FROM grants WHERE user_id = ? AND delegate_of IS NOT NULL AND revoked_at IS NULL AND (valid_to IS NULL OR valid_to >= ?)',
      ctx.userId, nowIso().slice(0, 10)).map((r) => r.delegate_of);
    const who = [ctx.userId, ...delegated];
    where.push(`t.assignee IN (${who.map(() => '?').join(',')})`); p.push(...who);
  }
  if (f.status) { where.push('t.status = ?'); p.push(f.status); } else where.push("t.status IN ('open','in_progress')");
  return q.all(`SELECT t.*, u.display_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee WHERE ${where.join(' AND ')}
                ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.created_at LIMIT 500`, ...p);
}

// ── 留言 ──
export function addComment(ctx, { orgId, targetType, targetId, body }) {
  assertCan(ctx, 'task.write', orgId);
  if (!body?.trim()) throw bad('留言不可空白');
  const id = newId('cm');
  insert('comments', { id, org_id: orgId, target_type: targetType, target_id: targetId, author: ctx.userId, body: body.trim(), at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'comment.add', targetType, targetId });
  return { id };
}
export function listComments(ctx, orgId, targetType, targetId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all('SELECT c.*, u.display_name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.author WHERE target_type = ? AND target_id = ? ORDER BY at', targetType, targetId);
}

// ── 逾期提醒（排程器每小時呼叫）──
export function remindOverdue(now = new Date()) {
  const cfg = getConfig('task.reminders') || { beforeDueDays: [3, 1], overdueEveryDays: 2 };
  const today = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const t of q.all("SELECT * FROM tasks WHERE status IN ('open','in_progress') AND due_date IS NOT NULL AND assignee IS NOT NULL")) {
    const dueIn = Math.round((Date.parse(t.due_date) - Date.parse(today)) / 86400000);
    const last = t.reminded_at ? Math.round((Date.parse(today) - Date.parse(t.reminded_at.slice(0, 10))) / 86400000) : Infinity;
    const shouldBefore = cfg.beforeDueDays.includes(dueIn) && last >= 1;
    const shouldOverdue = dueIn < 0 && last >= cfg.overdueEveryDays;
    if (!shouldBefore && !shouldOverdue) continue;
    notify(t.assignee, dueIn < 0 ? 'task.overdue' : 'task.due_soon', dueIn < 0 ? `已逾期 ${-dueIn} 天：${t.title}` : `${dueIn} 天後到期：${t.title}`, '', '#/workbench');
    update('tasks', t.id, { reminded_at: now.toISOString() });
    sent++;
  }
  for (const c of q.all("SELECT * FROM discrepancy_cases WHERE status NOT IN ('closed') AND due_date IS NOT NULL AND due_date < ? AND owner IS NOT NULL", today)) {
    const last = q.get("SELECT MAX(created_at) m FROM notifications WHERE user_id = ? AND kind = 'case.overdue' AND link = ?", c.owner, `#/quality/cases/${c.id}`)?.m;
    if (last && (Date.parse(today) - Date.parse(last.slice(0, 10))) / 86400000 < cfg.overdueEveryDays) continue;
    notify(c.owner, 'case.overdue', `差異案件逾期：${c.summary}`, '', `#/quality/cases/${c.id}`); sent++;
  }
  return sent;
}

// ── Email（選用）：設定 SMTP_URL=smtps://user:pass@host:465 與 SMTP_FROM 才寄 ──
export async function sendPendingEmails() {
  const channels = getConfig('notify.channels') || {};
  const url = process.env.SMTP_URL; const from = process.env.SMTP_FROM;
  if (!channels.email || !url || !from) return 0;
  const rows = q.all(`SELECT n.*, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.emailed_at IS NULL AND u.email IS NOT NULL AND n.created_at > ? LIMIT 50`,
    new Date(Date.now() - 86400000).toISOString());
  let sent = 0;
  for (const n of rows) {
    try { await smtpSend(url, from, n.email, `[EMS] ${n.title}`, `${n.title}\n\n${n.body || ''}\n\n${process.env.PUBLIC_BASE_URL || ''}/p/${n.link || ''}`); update('notifications', n.id, { emailed_at: nowIso() }); sent++; }
    catch (e) { console.error('[platform] email failed', e.message); break; }
  }
  return sent;
}

function smtpSend(url, from, to, subject, text) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: u.hostname, port: Number(u.port) || 465, servername: u.hostname });
    const lines = [];
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const steps = [
      null, `EHLO ems-admin`, 'AUTH LOGIN', b64(decodeURIComponent(u.username)), b64(decodeURIComponent(u.password)),
      `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA',
      [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64', '', b64(text), '.'].join('\r\n'), 'QUIT',
    ];
    let i = 0;
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      lines.push(d);
      const last = d.trim().split('\r\n').pop();
      if (/^[45]\d\d/.test(last)) { sock.destroy(); return reject(new Error(last)); }
      if (/^\d{3}-/.test(last)) return; // 多行回應未結束
      i++;
      if (i < steps.length) sock.write(steps[i] + '\r\n'); else { sock.end(); resolve(); }
    });
    sock.on('error', reject);
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('smtp timeout')); });
  });
}
