// M03 資料來源探索與組織知識庫（PRD §6.2、§11）
// 找不到負責人也能作業：關鍵字 → 候選證據／設備／合約／系統 → 候選窗口 → 詢問、轉介、查證 → 確認保管者 → 寫回知識庫。
// AI 或系統建議一律標「候選」，不會自動變成責任分工。
import { q, insert, update, newId, nowIso, audit, tx, parseJson } from './db.js';
import { assertCan, can, orgsFor } from './authz.js';
import { bad, notFound, conflict, j } from './util.js';
import { setWorkStatus } from './assets.js';
import { notify } from './collab.js';

// ── 聯絡人（個資：沒有 view.sensitive 時電話、信箱遮罩）──
export function listContacts(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  const sens = can(ctx, 'view.sensitive', orgId);
  return q.all('SELECT * FROM contacts WHERE org_id = ? ORDER BY name', orgId)
    .map((c) => (sens ? c : { ...c, phone: c.phone ? '（需權限）' : null, email: c.email ? '（需權限）' : null }));
}
export function saveContact(ctx, body) {
  assertCan(ctx, 'source.write', body.orgId);
  if (!body.name) throw bad('請填聯絡人姓名或單位窗口');
  const t = nowIso();
  const row = { name: body.name, unit: body.unit || null, title: body.title || null, phone: body.phone || null, email: body.email || null,
    user_id: body.userId || null, note: body.note || null, updated_at: t };
  if (body.id) {
    const c = q.get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', body.id, body.orgId); if (!c) throw notFound('聯絡人');
    if (row.phone === '（需權限）') delete row.phone; if (row.email === '（需權限）') delete row.email;
    update('contacts', c.id, row);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'contact.update', targetType: 'contact', targetId: c.id });
    return { id: c.id };
  }
  const id = newId('ct');
  insert('contacts', { id, org_id: body.orgId, ...row, created_by: ctx.userId, created_at: t });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'contact.create', targetType: 'contact', targetId: id });
  return { id };
}

// ── 資料來源 ──
export function listSources(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (f.orgId) assertCan(ctx, 'view.internal', f.orgId);
  if (!orgIds.length) return [];
  const where = [`s.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.assetId) { where.push('s.asset_id = ?'); p.push(f.assetId); }
  if (f.ownerStatus) { where.push('s.owner_status = ?'); p.push(f.ownerStatus); }
  const rows = q.all(`SELECT s.*, a.name AS asset_name, i.name AS item_name FROM data_sources s LEFT JOIN assets a ON a.id = s.asset_id
    LEFT JOIN inventory_items i ON i.id = s.item_id WHERE ${where.join(' AND ')} ORDER BY s.priority DESC, s.created_at`, ...p);
  const contacts = q.all(`SELECT sc.*, c.name, c.unit FROM source_contacts sc JOIN contacts c ON c.id = sc.contact_id WHERE sc.valid_to IS NULL`);
  return rows.map((s) => ({ ...s, contacts: contacts.filter((c) => c.source_id === s.id) }));
}

export function saveSource(ctx, body) {
  const t = nowIso();
  let orgId = body.orgId;
  if (body.assetId) { const a = q.get('SELECT org_id FROM assets WHERE id = ?', body.assetId); if (!a) throw notFound('標的'); orgId = a.org_id; }
  assertCan(ctx, 'source.write', orgId);
  if (!body.name || !body.sourceType) throw bad('請填來源名稱與類型');
  const row = { asset_id: body.assetId || null, item_id: body.itemId || null, name: body.name, source_type: body.sourceType,
    acquisition: body.acquisition || 'manual', location: body.location || null, frequency: body.frequency || null,
    priority: Number.isFinite(+body.priority) ? +body.priority : 50, integration_id: body.integrationId || null, note: body.note || null,
    active: body.active === false ? 0 : 1, updated_at: t };
  if (body.id) {
    const s = q.get('SELECT * FROM data_sources WHERE id = ?', body.id); if (!s) throw notFound('來源');
    update('data_sources', s.id, row);
    audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'source.update', targetType: 'source', targetId: s.id, before: s, after: row });
    return { id: s.id };
  }
  const id = newId('src');
  tx(() => {
    insert('data_sources', { id, org_id: orgId, ...row, owner_status: 'unknown', created_by: ctx.userId, created_at: t });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId, action: 'source.create', targetType: 'source', targetId: id, after: row });
    if (row.asset_id) {
      const a = q.get('SELECT work_status FROM assets WHERE id = ?', row.asset_id);
      if (['to_register', 'finding_source'].includes(a.work_status)) setWorkStatus(ctx, row.asset_id, 'source_found', `建立來源：${row.name}`, { system: true });
    }
  });
  return { id };
}

// 保管者關聯：候選 → 確認（記生效日；部門異動不丟歷程：舊關聯設 valid_to，不刪）
export function linkSourceContact(ctx, { sourceId, contactId, relation = 'candidate', validFrom }) {
  const s = q.get('SELECT * FROM data_sources WHERE id = ?', sourceId); if (!s) throw notFound('來源');
  assertCan(ctx, 'source.write', s.org_id);
  const t = nowIso();
  const id = newId('sc');
  tx(() => {
    if (relation === 'custodian') {
      q.run("UPDATE source_contacts SET valid_to = ? WHERE source_id = ? AND relation = 'custodian' AND valid_to IS NULL", (validFrom || t).slice(0, 10), sourceId);
    }
    insert('source_contacts', { id, source_id: sourceId, contact_id: contactId, relation, verified: relation === 'custodian' ? 1 : 0,
      verified_by: relation === 'custodian' ? ctx.userId : null, verified_at: relation === 'custodian' ? t : null,
      valid_from: (validFrom || t).slice(0, 10), created_by: ctx.userId, created_at: t });
    const status = relation === 'custodian' ? 'confirmed' : (s.owner_status === 'confirmed' ? 'confirmed' : 'candidate');
    update('data_sources', sourceId, { owner_status: status, updated_at: t });
    if (s.asset_id) {
      const a = q.get('SELECT owner_status FROM assets WHERE id = ?', s.asset_id);
      if (a.owner_status !== 'confirmed') update('assets', s.asset_id, { owner_status: status, updated_at: t });
    }
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: s.org_id, action: 'source.contact_link', targetType: 'source', targetId: sourceId, after: { contactId, relation } });
  });
  return { id };
}
export function endSourceContact(ctx, linkId, validTo) {
  const l = q.get('SELECT sc.*, s.org_id FROM source_contacts sc JOIN data_sources s ON s.id = sc.source_id WHERE sc.id = ?', linkId); if (!l) throw notFound('關聯');
  assertCan(ctx, 'source.write', l.org_id);
  update('source_contacts', linkId, { valid_to: validTo || nowIso().slice(0, 10) });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: l.org_id, action: 'source.contact_end', targetType: 'source', targetId: l.source_id, before: l });
}

// ── 線索搜尋：輸入「柴油」→ 可能證據、設備、合約、系統、去年經驗 ──
export function suggest(ctx, orgId, keyword) {
  assertCan(ctx, 'view.internal', orgId);
  const kw = String(keyword || '').trim();
  if (!kw) return { items: [], assets: [], sources: [], knowledge: [], evidence: [] };
  const like = `%${kw}%`;
  const items = q.all(`SELECT id, code, domain, name, source_hints, required_data FROM inventory_items WHERE active = 1
    AND (name LIKE ? OR source_hints LIKE ? OR required_data LIKE ? OR description LIKE ? OR code LIKE ?)`, like, like, like, like, like)
    .map((r) => parseJson(r, ['source_hints', 'required_data']));
  const assets = q.all(`SELECT a.id, a.name, a.domain, a.asset_type, a.location, a.owner_status FROM assets a LEFT JOIN inventory_items i ON i.id = a.item_id
    WHERE a.org_id = ? AND (a.name LIKE ? OR a.location LIKE ? OR i.name LIKE ? OR a.attrs LIKE ?) LIMIT 30`, orgId, like, like, like, like);
  const sources = q.all(`SELECT s.id, s.name, s.source_type, s.location, s.owner_status FROM data_sources s WHERE s.org_id = ? AND (s.name LIKE ? OR s.location LIKE ? OR s.note LIKE ?) LIMIT 30`, orgId, like, like, like);
  // 知識庫：本院優先，其他院所的經驗也列出（只露「去哪裡找」，不露人名）
  const knowledge = q.all(`SELECT k.*, CASE WHEN k.org_id = ? THEN 1 ELSE 0 END AS own FROM source_knowledge k LEFT JOIN inventory_items i ON i.id = k.item_id
    WHERE k.keyword LIKE ? OR k.evidence_kind LIKE ? OR k.where_found LIKE ? OR i.name LIKE ? ORDER BY own DESC, k.year DESC LIMIT 30`, orgId, like, like, like, like)
    .map((k) => (k.own ? k : { ...k, how_found: k.how_found ? '（他院經驗）' + k.how_found.replace(/[一-龥]{2,4}(先生|小姐|主任|技正|組長)/g, '某窗口') : null, created_by: null }));
  const contacts = can(ctx, 'view.internal', orgId) ? q.all(`SELECT DISTINCT c.id, c.name, c.unit, sc.relation FROM contacts c JOIN source_contacts sc ON sc.contact_id = c.id
    JOIN data_sources s ON s.id = sc.source_id WHERE s.org_id = ? AND (s.name LIKE ? OR s.note LIKE ?) AND sc.valid_to IS NULL`, orgId, like, like) : [];
  const evidence = q.all(`SELECT id, filename, kind, uploaded_at FROM evidence_files WHERE org_id = ? AND (filename LIKE ? OR note LIKE ? OR kind LIKE ?) LIMIT 20`, orgId, like, like, like);
  // 建議路徑：把命中的項目的常見證據攤開
  const path = [...new Set(items.flatMap((i) => i.source_hints))].map((h) => ({ step: h, status: 'candidate' }));
  return { items, assets, sources, contacts, knowledge, evidence, path };
}

// ── 追查任務 ──
export function createSearchTask(ctx, body) {
  assertCan(ctx, 'search.write', body.orgId);
  if (!body.keyword) throw bad('請填要找的資料（關鍵字）');
  const t = nowIso();
  const id = newId('st');
  tx(() => {
    insert('source_search_tasks', { id, org_id: body.orgId, asset_id: body.assetId || null, item_id: body.itemId || null, keyword: body.keyword,
      description: body.description || null, status: 'open', assignee: body.assignee || ctx.userId, coordinator: body.coordinator || null,
      due_date: body.dueDate || null, created_by: ctx.userId, created_at: t, updated_at: t });
    if (body.assetId) setWorkStatus(ctx, body.assetId, 'finding_source', `建立追查：${body.keyword}`, { system: true });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'search.create', targetType: 'search_task', targetId: id, after: body });
    if (body.assignee && body.assignee !== ctx.userId) notify(body.assignee, 'search.assigned', `來源追查：${body.keyword}`, '', `#/sources/search/${id}`);
  });
  return { id };
}

export function listSearchTasks(ctx, f = {}) {
  const orgIds = f.orgId ? [f.orgId] : orgsFor(ctx, 'view.internal');
  if (!orgIds.length) return [];
  const where = [`t.org_id IN (${orgIds.map(() => '?').join(',')})`]; const p = [...orgIds];
  if (f.status) { where.push('t.status = ?'); p.push(f.status); } else if (!f.all) where.push("t.status NOT IN ('found','closed')");
  if (f.mine) { where.push('(t.assignee = ? OR t.coordinator = ?)'); p.push(ctx.userId, ctx.userId); }
  return q.all(`SELECT t.*, a.name AS asset_name, i.name AS item_name, u.display_name AS assignee_name, c.display_name AS coordinator_name,
      (SELECT COUNT(*) FROM inquiries iq WHERE iq.task_id = t.id) AS inquiry_count
    FROM source_search_tasks t LEFT JOIN assets a ON a.id = t.asset_id LEFT JOIN inventory_items i ON i.id = t.item_id
    LEFT JOIN users u ON u.id = t.assignee LEFT JOIN users c ON c.id = t.coordinator WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC`, ...p);
}

export function getSearchTask(ctx, id) {
  const t = q.get('SELECT * FROM source_search_tasks WHERE id = ?', id); if (!t) throw notFound('追查任務');
  assertCan(ctx, 'view.internal', t.org_id);
  const inquiries = q.all('SELECT iq.*, u.display_name AS actor_name FROM inquiries iq LEFT JOIN users u ON u.id = iq.actor WHERE task_id = ? ORDER BY asked_at', id);
  return { ...t, inquiries, suggestions: suggest(ctx, t.org_id, t.keyword) };
}

export function addInquiry(ctx, taskId, body) {
  const t = q.get('SELECT * FROM source_search_tasks WHERE id = ?', taskId); if (!t) throw notFound('追查任務');
  assertCan(ctx, 'search.write', t.org_id);
  if (!body.question) throw bad('請填詢問內容');
  if (!body.contactId && !body.contactName) throw bad('請填詢問對象');
  const id = newId('iq'); const at = nowIso();
  tx(() => {
    insert('inquiries', { id, task_id: taskId, contact_id: body.contactId || null, contact_name: body.contactName || null, channel: body.channel || null,
      question: body.question, outcome: 'pending', actor: ctx.userId, asked_at: at });
    update('source_search_tasks', taskId, { status: 'asking', updated_at: at });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: t.org_id, action: 'search.inquiry', targetType: 'search_task', targetId: taskId, after: { contact: body.contactId || body.contactName } });
  });
  return { id };
}

export function answerInquiry(ctx, inquiryId, body) {
  const iq = q.get('SELECT iq.*, t.org_id FROM inquiries iq JOIN source_search_tasks t ON t.id = iq.task_id WHERE iq.id = ?', inquiryId); if (!iq) throw notFound('詢問');
  assertCan(ctx, 'search.write', iq.org_id);
  const outcomes = ['answered', 'referred', 'no_answer', 'not_holder', 'found'];
  if (!outcomes.includes(body.outcome)) throw bad('請選詢問結果');
  const at = nowIso();
  tx(() => {
    update('inquiries', inquiryId, { answer: body.answer || null, outcome: body.outcome, referred_to_contact_id: body.referredToContactId || null,
      referred_to_name: body.referredToName || null, answered_at: at });
    const status = body.outcome === 'referred' ? 'referred' : body.outcome === 'found' ? 'asking' : 'asking';
    update('source_search_tasks', iq.task_id, { status, updated_at: at });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: iq.org_id, action: 'search.answer', targetType: 'search_task', targetId: iq.task_id, after: { outcome: body.outcome } });
  });
}

// 第一次洽詢失敗 → 移交統籌人協調
export function escalate(ctx, taskId, { coordinator, note }) {
  const t = q.get('SELECT * FROM source_search_tasks WHERE id = ?', taskId); if (!t) throw notFound('追查任務');
  assertCan(ctx, 'search.write', t.org_id);
  if (!coordinator) throw bad('請指定統籌人');
  update('source_search_tasks', taskId, { status: 'escalated', coordinator, updated_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: t.org_id, action: 'search.escalate', targetType: 'search_task', targetId: taskId, after: { coordinator, note } });
  notify(coordinator, 'search.escalated', `來源追查需要協調：${t.keyword}`, note || '', `#/sources/search/${taskId}`);
}

// 找到了：建立（或指定既有）來源、確認保管者、寫知識庫
export function resolveSearch(ctx, taskId, body) {
  const t = q.get('SELECT * FROM source_search_tasks WHERE id = ?', taskId); if (!t) throw notFound('追查任務');
  assertCan(ctx, 'search.write', t.org_id);
  if (['found', 'closed'].includes(t.status)) throw conflict('此追查已結案');
  return tx(() => {
    let sourceId = body.sourceId;
    if (!sourceId) {
      if (!body.source?.name) throw bad('請填找到的資料來源');
      sourceId = saveSource(ctx, { ...body.source, orgId: t.org_id, assetId: body.source.assetId || t.asset_id, itemId: body.source.itemId || t.item_id }).id;
    }
    let contactId = body.contactId;
    if (!contactId && body.contact?.name) contactId = saveContact(ctx, { ...body.contact, orgId: t.org_id }).id;
    if (contactId) linkSourceContact(ctx, { sourceId, contactId, relation: body.confirmed ? 'custodian' : 'candidate', validFrom: body.validFrom });
    insert('source_knowledge', { id: newId('kn'), org_id: t.org_id, item_id: t.item_id, keyword: t.keyword, evidence_kind: body.evidenceKind || body.source?.sourceType || '資料',
      where_found: body.whereFound || body.source?.location || null, how_found: body.howFound || null, year: new Date().getFullYear(), source_id: sourceId, task_id: taskId,
      confidence: body.confirmed ? 'verified' : 'candidate', created_by: ctx.userId, created_at: nowIso() });
    update('source_search_tasks', taskId, { status: 'found', result_source_id: sourceId, updated_at: nowIso(), closed_at: nowIso() });
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: t.org_id, action: 'search.resolve', targetType: 'search_task', targetId: taskId, after: { sourceId, contactId } });
    return { sourceId, contactId };
  });
}

export function closeSearch(ctx, taskId, note) {
  const t = q.get('SELECT * FROM source_search_tasks WHERE id = ?', taskId); if (!t) throw notFound('追查任務');
  assertCan(ctx, 'search.write', t.org_id);
  update('source_search_tasks', taskId, { status: 'closed', updated_at: nowIso(), closed_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: t.org_id, action: 'search.close', targetType: 'search_task', targetId: taskId, after: { note } });
}

export function listKnowledge(ctx, orgId) {
  assertCan(ctx, 'view.internal', orgId);
  return q.all(`SELECT k.*, i.name AS item_name, s.name AS source_name FROM source_knowledge k LEFT JOIN inventory_items i ON i.id = k.item_id
    LEFT JOIN data_sources s ON s.id = k.source_id WHERE k.org_id = ? ORDER BY k.created_at DESC`, orgId);
}
export function addKnowledge(ctx, body) {
  assertCan(ctx, 'search.write', body.orgId);
  if (!body.evidenceKind) throw bad('請填證據種類');
  const id = newId('kn');
  insert('source_knowledge', { id, org_id: body.orgId, item_id: body.itemId || null, keyword: body.keyword || null, evidence_kind: body.evidenceKind,
    where_found: body.whereFound || null, how_found: body.howFound || null, year: body.year || new Date().getFullYear(), source_id: body.sourceId || null,
    confidence: 'candidate', created_by: ctx.userId, created_at: nowIso() });
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: body.orgId, action: 'knowledge.add', targetType: 'knowledge', targetId: id });
  return { id };
}
