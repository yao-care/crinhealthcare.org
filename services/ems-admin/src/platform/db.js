// 平台資料庫：主機本地 SQLite（Node 內建 node:sqlite，不引第三方套件）。
//
// 為什麼不再用「每院一份 JSON」：PRD §5 要求標的／來源／原始觀測／採用值／成果引用五層分開，
// 觀測值是多來源、多版本的時間序列，還要稽核事件與定版快照。JSON 整檔重寫撐不住，也查不動。
//
// 位置：PLATFORM_DB，預設 AUDIT_DATA_DIR/platform/platform.sqlite —— 與健檢、盤點同一塊私有儲存，
// 絕不放進 REPO_DIR（public repo）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';

// node:sqlite 在 Node 22 會印 ExperimentalWarning；只濾掉這一條，其他警告照常輸出
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w?.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return origEmit.call(this, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
export const nowIso = () => new Date().toISOString();
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Schema（PRD §14.1）。每次 migration 只往後加，不改舊的 ──
const MIGRATIONS = [
  // 1：全部核心表
  `
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, parent_id TEXT REFERENCES organizations(id),
    kind TEXT NOT NULL CHECK (kind IN ('group','hospital','branch','unit')),
    code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, legacy_hid TEXT UNIQUE,
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE sites (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL, address TEXT, note TEXT,
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE buildings (
    id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id),
    name TEXT NOT NULL, floors TEXT, floor_area_m2 REAL, note TEXT,
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE boundaries (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ghg_operational','ghg_equity','energy','water','metering','custom')),
    site_ids TEXT NOT NULL DEFAULT '[]', definition TEXT, valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    display_name TEXT NOT NULL, email TEXT, phone TEXT, unit TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    must_change INTEGER NOT NULL DEFAULT 1, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
    legacy INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, password_changed_at TEXT
  );
  CREATE TABLE grants (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL, scope_type TEXT NOT NULL CHECK (scope_type IN ('global','org')), scope_id TEXT,
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    delegate_of TEXT, granted_by TEXT, created_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE INDEX grants_user ON grants(user_id);

  -- 資料字典
  CREATE TABLE units (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, dimension TEXT NOT NULL, base_unit TEXT NOT NULL, to_base REAL NOT NULL
  );
  CREATE TABLE metrics (
    code TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL,
    semantics TEXT NOT NULL, value_kind TEXT NOT NULL, std_unit TEXT NOT NULL REFERENCES units(code),
    description TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE inventory_items (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL CHECK (domain IN ('oil','water','electricity','gas','activity','reference')),
    subtype TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
    asset_types TEXT NOT NULL DEFAULT '[]', metrics TEXT NOT NULL DEFAULT '[]',
    required_data TEXT NOT NULL DEFAULT '[]', source_hints TEXT NOT NULL DEFAULT '[]',
    expected_frequency TEXT, collection_guidance TEXT, applicability_rules TEXT,
    special_rules TEXT NOT NULL DEFAULT '[]', usage_candidates TEXT NOT NULL DEFAULT '[]',
    ghg_ref TEXT, origin TEXT, open_questions TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE reference_activities (
    id TEXT PRIMARY KEY, workbook TEXT NOT NULL, sheet TEXT NOT NULL, row_no INTEGER NOT NULL,
    cells TEXT NOT NULL, scope TEXT, category TEXT, activity TEXT NOT NULL, required_data TEXT, note TEXT,
    item_codes TEXT NOT NULL DEFAULT '[]', domain_hint TEXT, import_job_id TEXT, created_at TEXT NOT NULL,
    UNIQUE (workbook, sheet, row_no)
  );

  -- 盤點計畫與標的
  CREATE TABLE inventory_plans (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), year INTEGER NOT NULL,
    name TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, boundary_id TEXT REFERENCES boundaries(id),
    coordinator TEXT REFERENCES users(id), domains TEXT NOT NULL DEFAULT '["oil","water","electricity","gas"]',
    review_rule TEXT, status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), site_id TEXT REFERENCES sites(id),
    building_id TEXT REFERENCES buildings(id), item_id TEXT REFERENCES inventory_items(id),
    domain TEXT NOT NULL CHECK (domain IN ('oil','water','electricity','gas','activity')),
    asset_type TEXT NOT NULL, name TEXT NOT NULL, external_key TEXT, external_key_sensitive INTEGER NOT NULL DEFAULT 0,
    parent_asset_id TEXT REFERENCES assets(id), shared INTEGER NOT NULL DEFAULT 0, leased INTEGER NOT NULL DEFAULT 0,
    location TEXT, floor TEXT, coords TEXT, meter_multiplier REAL NOT NULL DEFAULT 1,
    attrs TEXT NOT NULL DEFAULT '{}', data_spec TEXT NOT NULL DEFAULT '[]',
    applicability TEXT NOT NULL DEFAULT 'undetermined' CHECK (applicability IN ('undetermined','applicable','not_applicable','pending')),
    applicability_reason TEXT, applicability_by TEXT, applicability_at TEXT, applicability_approved_by TEXT,
    work_status TEXT NOT NULL DEFAULT 'to_register',
    owner_status TEXT NOT NULL DEFAULT 'unknown' CHECK (owner_status IN ('unknown','candidate','confirmed')),
    owner_user_id TEXT REFERENCES users(id), next_step TEXT, due_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','disabled','archived')),
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT, legacy_ref TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX assets_uk ON assets(org_id, IFNULL(site_id,''), asset_type, external_key, valid_from) WHERE external_key IS NOT NULL AND external_key <> '';
  CREATE INDEX assets_org ON assets(org_id, domain);
  CREATE TABLE asset_links (
    id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES assets(id), child_id TEXT NOT NULL REFERENCES assets(id),
    relation TEXT NOT NULL CHECK (relation IN ('submeter_of','feeds','supplies','part_of')),
    allocation TEXT, valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE asset_history (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), change_type TEXT NOT NULL,
    before TEXT, after TEXT, reason TEXT, actor TEXT, effective_at TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE work_events (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), axis TEXT NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, note TEXT, actor TEXT, at TEXT NOT NULL
  );

  -- 來源探索
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
    unit TEXT, title TEXT, phone TEXT, email TEXT, user_id TEXT REFERENCES users(id), note TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE data_sources (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), asset_id TEXT REFERENCES assets(id),
    item_id TEXT REFERENCES inventory_items(id), name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('bill','ems','api','file','manual','document','system','contract','record')),
    acquisition TEXT NOT NULL DEFAULT 'manual' CHECK (acquisition IN ('api','import','manual','ocr')),
    location TEXT, frequency TEXT, priority INTEGER NOT NULL DEFAULT 50,
    owner_status TEXT NOT NULL DEFAULT 'unknown' CHECK (owner_status IN ('unknown','candidate','confirmed')),
    integration_id TEXT, note TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE source_contacts (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id), contact_id TEXT NOT NULL REFERENCES contacts(id),
    relation TEXT NOT NULL CHECK (relation IN ('candidate','custodian','deputy','provider')),
    verified INTEGER NOT NULL DEFAULT 0, verified_by TEXT, verified_at TEXT,
    valid_from TEXT NOT NULL, valid_to TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE source_search_tasks (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), asset_id TEXT REFERENCES assets(id),
    item_id TEXT REFERENCES inventory_items(id), keyword TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','asking','referred','escalated','found','closed')),
    assignee TEXT REFERENCES users(id), coordinator TEXT REFERENCES users(id), result_source_id TEXT REFERENCES data_sources(id),
    due_date TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE TABLE inquiries (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES source_search_tasks(id), contact_id TEXT REFERENCES contacts(id),
    contact_name TEXT, channel TEXT, question TEXT NOT NULL, answer TEXT,
    outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','answered','referred','no_answer','not_holder','found')),
    referred_to_contact_id TEXT REFERENCES contacts(id), referred_to_name TEXT,
    actor TEXT, asked_at TEXT NOT NULL, answered_at TEXT
  );
  CREATE TABLE source_knowledge (
    id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id), item_id TEXT REFERENCES inventory_items(id),
    keyword TEXT, evidence_kind TEXT NOT NULL, where_found TEXT, how_found TEXT, year INTEGER,
    source_id TEXT REFERENCES data_sources(id), task_id TEXT REFERENCES source_search_tasks(id),
    confidence TEXT NOT NULL DEFAULT 'candidate' CHECK (confidence IN ('candidate','verified')),
    created_by TEXT, created_at TEXT NOT NULL
  );

  -- 證據
  CREATE TABLE evidence_files (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), sha256 TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL, storage_key TEXT NOT NULL,
    confidentiality TEXT NOT NULL DEFAULT 'internal' CHECK (confidentiality IN ('public','internal','restricted','secret')),
    kind TEXT, source_id TEXT REFERENCES data_sources(id), asset_id TEXT REFERENCES assets(id), note TEXT,
    uploaded_by TEXT, uploaded_at TEXT NOT NULL, UNIQUE (org_id, sha256)
  );

  -- 原始觀測（不可覆寫：修正一律新版本＋supersedes_id）
  CREATE TABLE observations (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), asset_id TEXT NOT NULL REFERENCES assets(id),
    metric_code TEXT NOT NULL REFERENCES metrics(code), period_start TEXT NOT NULL, period_end TEXT NOT NULL,
    raw_value TEXT, raw_unit TEXT NOT NULL, value_std REAL, std_unit TEXT NOT NULL,
    value_state TEXT NOT NULL DEFAULT 'measured' CHECK (value_state IN ('measured','zero','estimated','missing','not_applicable','unknown','pending_period_end')),
    reading_kind TEXT NOT NULL DEFAULT 'interval' CHECK (reading_kind IN ('interval','cumulative','stock','transaction','estimate')),
    meter_multiplier REAL NOT NULL DEFAULT 1,
    meter_event TEXT NOT NULL DEFAULT 'none' CHECK (meter_event IN ('none','replace','reset','rollover')),
    source_id TEXT NOT NULL REFERENCES data_sources(id), source_record_key TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('api','import','manual','ocr','legacy')),
    import_job_id TEXT, sync_job_id TEXT, ocr_confirmed_by TEXT,
    quality_status TEXT NOT NULL DEFAULT 'pending_validation' CHECK (quality_status IN ('pending_validation','valid','warning','invalid','superseded')),
    quality_grade TEXT, uncertainty TEXT, boundary_note TEXT, note TEXT,
    version INTEGER NOT NULL DEFAULT 1, supersedes_id TEXT REFERENCES observations(id),
    submitted_by TEXT, submitted_at TEXT NOT NULL, acquired_at TEXT,
    UNIQUE (asset_id, metric_code, period_start, period_end, source_id, source_record_key, version)
  );
  CREATE INDEX obs_asset ON observations(asset_id, metric_code, period_start);
  CREATE INDEX obs_org ON observations(org_id, quality_status);
  CREATE TABLE observation_evidence (
    observation_id TEXT NOT NULL REFERENCES observations(id), evidence_id TEXT NOT NULL REFERENCES evidence_files(id),
    page TEXT, PRIMARY KEY (observation_id, evidence_id)
  );
  CREATE TABLE transformed_values (
    id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES observations(id),
    rule_code TEXT NOT NULL, rule_version INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
    value REAL, unit TEXT NOT NULL, method TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX tv_obs ON transformed_values(observation_id);

  -- 檢核
  CREATE TABLE validation_runs (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), ruleset_version INTEGER NOT NULL,
    scope TEXT, status TEXT NOT NULL, summary TEXT, actor TEXT, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE validation_results (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES validation_runs(id), observation_id TEXT REFERENCES observations(id),
    asset_id TEXT REFERENCES assets(id), rule_code TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','blocker')),
    message TEXT NOT NULL, details TEXT, case_id TEXT
  );
  CREATE INDEX vr_run ON validation_results(run_id);

  -- 差異案件與裁決
  CREATE TABLE discrepancy_cases (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL, rule_code TEXT,
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
    asset_id TEXT REFERENCES assets(id), metric_code TEXT, period_start TEXT, period_end TEXT,
    observation_ids TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL, abs_diff REAL, rel_diff REAL, details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','investigating','awaiting_evidence','proposed','in_review','closed','reopened')),
    owner TEXT REFERENCES users(id), due_date TEXT, resolution TEXT, fingerprint TEXT,
    opened_by TEXT, opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE UNIQUE INDEX dc_fp ON discrepancy_cases(fingerprint) WHERE fingerprint IS NOT NULL AND status <> 'closed';
  CREATE TABLE case_events (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES discrepancy_cases(id), action TEXT NOT NULL,
    note TEXT, data TEXT, actor TEXT, at TEXT NOT NULL
  );

  -- 資料集與採用值
  CREATE TABLE datasets (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), boundary_id TEXT REFERENCES boundaries(id),
    year INTEGER NOT NULL, name TEXT NOT NULL, purpose TEXT, version INTEGER NOT NULL DEFAULT 1,
    parent_dataset_id TEXT REFERENCES datasets(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','locked','superseded')),
    hash TEXT, approved_by TEXT, approved_at TEXT, locked_by TEXT, locked_at TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), case_id TEXT REFERENCES discrepancy_cases(id),
    dataset_id TEXT NOT NULL REFERENCES datasets(id), asset_id TEXT NOT NULL REFERENCES assets(id), metric_code TEXT NOT NULL,
    period_start TEXT NOT NULL, period_end TEXT NOT NULL, basis TEXT NOT NULL DEFAULT 'default',
    decision_type TEXT NOT NULL CHECK (decision_type IN ('select_source','derived','not_applicable','missing','reject')),
    selected_observation_id TEXT REFERENCES observations(id), input_observation_ids TEXT NOT NULL DEFAULT '[]',
    value REAL, unit TEXT, value_state TEXT NOT NULL DEFAULT 'measured', method TEXT,
    reason TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]',
    impact TEXT NOT NULL DEFAULT 'normal' CHECK (impact IN ('normal','high')),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','first_approved','approved','rejected','returned','withdrawn')),
    proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL,
    reviewer1 TEXT, reviewed1_at TEXT, reviewer2 TEXT, reviewed2_at TEXT, review_note TEXT
  );
  CREATE TABLE approved_facts (
    id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id), org_id TEXT NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id), metric_code TEXT NOT NULL,
    period_start TEXT NOT NULL, period_end TEXT NOT NULL, basis TEXT NOT NULL DEFAULT 'default',
    value REAL, unit TEXT NOT NULL, value_state TEXT NOT NULL,
    decision_id TEXT REFERENCES decisions(id), observation_ids TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1, is_current INTEGER NOT NULL DEFAULT 1,
    approved_by TEXT, approved_at TEXT NOT NULL, superseded_at TEXT
  );
  CREATE UNIQUE INDEX af_current ON approved_facts(dataset_id, asset_id, metric_code, period_start, period_end, basis) WHERE is_current = 1;

  -- 計算
  CREATE TABLE factors (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('emission','gwp','heat','conversion','water','other')),
    gas TEXT, value REAL NOT NULL, unit TEXT NOT NULL, applies_to TEXT, gwp_set TEXT,
    valid_from TEXT NOT NULL, valid_to TEXT, source TEXT NOT NULL, source_url TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','retired')),
    created_by TEXT, created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, reason TEXT,
    UNIQUE (code, version)
  );
  CREATE TABLE calculation_rules (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT,
    definition TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','retired')),
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT,
    created_by TEXT, created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, reason TEXT,
    UNIQUE (code, version)
  );
  CREATE TABLE calculated_indicators (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, dataset_id TEXT NOT NULL REFERENCES datasets(id), report_run_id TEXT,
    indicator_code TEXT NOT NULL, rule_code TEXT NOT NULL, rule_version INTEGER NOT NULL,
    value REAL, unit TEXT, value_state TEXT NOT NULL DEFAULT 'measured', trace TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX ci_ds ON calculated_indicators(dataset_id, indicator_code);

  -- 報告
  CREATE TABLE report_templates (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
    standard TEXT NOT NULL, standard_version TEXT, applicability TEXT, applies_from TEXT, applies_to TEXT,
    sections TEXT NOT NULL DEFAULT '[]', export_formats TEXT NOT NULL DEFAULT '["xlsx","csv","pdf","docx"]',
    review_rules TEXT, attachment_rules TEXT, filename_pattern TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','retired')),
    created_by TEXT, created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, reason TEXT,
    UNIQUE (code, version)
  );
  CREATE TABLE report_mappings (
    id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES report_templates(id), field_id TEXT NOT NULL,
    section TEXT NOT NULL, label TEXT NOT NULL, data_type TEXT NOT NULL DEFAULT 'number',
    source_kind TEXT NOT NULL CHECK (source_kind IN ('indicator','metric_sum','text','manual','evidence_list','quality')),
    source_ref TEXT, unit TEXT, required INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, note TEXT,
    UNIQUE (template_id, field_id)
  );
  CREATE TABLE report_cases (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), template_id TEXT NOT NULL REFERENCES report_templates(id),
    name TEXT NOT NULL, year INTEGER NOT NULL, boundary_id TEXT REFERENCES boundaries(id), dataset_id TEXT REFERENCES datasets(id),
    due_date TEXT, reviewer TEXT REFERENCES users(id), approver TEXT REFERENCES users(id),
    confidentiality TEXT NOT NULL DEFAULT 'internal', publish_date TEXT, manual_values TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparing','in_review','approved','locked','exported','submitted_manual')),
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE report_runs (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES report_cases(id), run_no INTEGER NOT NULL,
    dataset_id TEXT NOT NULL REFERENCES datasets(id), dataset_hash TEXT, template_version INTEGER NOT NULL,
    factor_versions TEXT NOT NULL DEFAULT '{}', rule_versions TEXT NOT NULL DEFAULT '{}',
    results TEXT NOT NULL DEFAULT '{}', readiness TEXT, hash TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','returned','approved','locked','superseded')),
    created_by TEXT, created_at TEXT NOT NULL, submitted_at TEXT, reviewed_by TEXT, reviewed_at TEXT,
    approved_by TEXT, approved_at TEXT, locked_at TEXT, review_note TEXT
  );
  CREATE TABLE report_artifacts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES report_runs(id), format TEXT NOT NULL,
    storage_key TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE usage_links (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, fact_id TEXT REFERENCES approved_facts(id), asset_id TEXT REFERENCES assets(id),
    report_run_id TEXT REFERENCES report_runs(id), report_case_id TEXT, field_id TEXT, indicator_code TEXT, usage_name TEXT,
    usage_type TEXT NOT NULL DEFAULT 'report' CHECK (usage_type IN ('report','indicator','dashboard','management','filing')),
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','evaluated','mapped','cited','published')),
    used_at TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX ul_asset ON usage_links(asset_id);

  -- 協作
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, target_type TEXT, target_id TEXT, title TEXT NOT NULL,
    assignee TEXT REFERENCES users(id), due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
    data TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, reminded_at TEXT
  );
  CREATE INDEX tasks_assignee ON tasks(assignee, status);
  CREATE TABLE comments (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    author TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT, link TEXT, created_at TEXT NOT NULL, read_at TEXT, emailed_at TEXT
  );
  CREATE INDEX notif_user ON notifications(user_id, read_at);

  -- 介接與匯入
  CREATE TABLE integrations (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), connector TEXT NOT NULL, name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}', interval_min INTEGER NOT NULL DEFAULT 1440, enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'idle', cursor TEXT, last_sync_at TEXT, last_ok_at TEXT, last_error TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0, next_run_at TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE sync_jobs (
    id TEXT PRIMARY KEY, integration_id TEXT NOT NULL REFERENCES integrations(id), attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('running','ok','failed','dead')), cursor_before TEXT, cursor_after TEXT,
    stats TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE import_jobs (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL,
    filename TEXT NOT NULL, evidence_id TEXT REFERENCES evidence_files(id), mapping TEXT, preview TEXT, errors TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','previewed','committed','reverted','failed')),
    stats TEXT, created_by TEXT, created_at TEXT NOT NULL, committed_at TEXT, committed_by TEXT, reverted_at TEXT, reverted_by TEXT,
    signed_off_by TEXT, signed_off_at TEXT
  );

  -- 版本化設定
  CREATE TABLE configuration_versions (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','retired')),
    effective_at TEXT, reason TEXT, impact TEXT,
    created_by TEXT, created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
    UNIQUE (key, version)
  );

  -- 稽核（雜湊串鏈＋禁止修改刪除）
  CREATE TABLE audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, actor_name TEXT, org_id TEXT,
    action TEXT NOT NULL, target_type TEXT, target_id TEXT, before TEXT, after TEXT, ip TEXT,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  );
  CREATE INDEX ae_target ON audit_events(target_type, target_id);
  CREATE INDEX ae_org ON audit_events(org_id, at);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events 不可修改'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events 不可刪除'); END;

  -- 定版後禁止改動
  CREATE TRIGGER af_locked_guard BEFORE UPDATE ON approved_facts
    WHEN (SELECT status FROM datasets WHERE id = OLD.dataset_id) IN ('locked','superseded')
    BEGIN SELECT RAISE(ABORT, '資料集已定版，採用值不可修改'); END;
  CREATE TRIGGER af_locked_delete BEFORE DELETE ON approved_facts
    WHEN (SELECT status FROM datasets WHERE id = OLD.dataset_id) IN ('locked','superseded')
    BEGIN SELECT RAISE(ABORT, '資料集已定版，採用值不可刪除'); END;
  CREATE TRIGGER ds_locked_guard BEFORE UPDATE ON datasets
    WHEN (OLD.status = 'locked' AND (NEW.status NOT IN ('locked','superseded') OR NEW.hash IS NOT OLD.hash))
      OR (OLD.status = 'superseded' AND (NEW.status <> 'superseded' OR NEW.hash IS NOT OLD.hash))
    BEGIN SELECT RAISE(ABORT, '已定版的資料集不可修改'); END;
  CREATE TRIGGER af_locked_insert BEFORE INSERT ON approved_facts
    WHEN (SELECT status FROM datasets WHERE id = NEW.dataset_id) IN ('locked','superseded')
    BEGIN SELECT RAISE(ABORT, '資料集已定版，不可新增採用值'); END;
  CREATE TRIGGER rr_locked_guard BEFORE UPDATE ON report_runs
    WHEN OLD.status = 'locked' AND (NEW.results <> OLD.results OR NEW.hash IS NOT OLD.hash OR NEW.dataset_id <> OLD.dataset_id)
    BEGIN SELECT RAISE(ABORT, '報告已封存，結果不可修改'); END;
  CREATE TRIGGER obs_immutable BEFORE UPDATE ON observations
    WHEN NEW.raw_value IS NOT OLD.raw_value OR NEW.raw_unit <> OLD.raw_unit OR NEW.period_start <> OLD.period_start
      OR NEW.period_end <> OLD.period_end OR NEW.asset_id <> OLD.asset_id OR NEW.metric_code <> OLD.metric_code
      OR NEW.source_id <> OLD.source_id
    BEGIN SELECT RAISE(ABORT, '原始觀測值不可覆寫，請建立新版本'); END;
  `,
  // 2：ISO 14064-1 第 9.3.1 條必要內容（顯著性評估、類別 3–6、基準年、係數不確定性）
  `
  CREATE TABLE ghg_significance (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), year INTEGER NOT NULL,
    item_code TEXT NOT NULL, category INTEGER NOT NULL CHECK (category BETWEEN 1 AND 6), name TEXT NOT NULL,
    significant INTEGER, criteria TEXT, reason TEXT,
    quantified INTEGER NOT NULL DEFAULT 0, value_tco2e REAL, method TEXT, data_source TEXT, uncertainty_pct REAL,
    evidence_ids TEXT NOT NULL DEFAULT '[]', updated_by TEXT, updated_at TEXT NOT NULL,
    UNIQUE (org_id, year, item_code)
  );
  CREATE TABLE ghg_base_years (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), base_year INTEGER NOT NULL,
    dataset_id TEXT REFERENCES datasets(id), emissions TEXT NOT NULL DEFAULT '{}',
    policy TEXT, recalc_threshold_pct REAL, kind TEXT NOT NULL CHECK (kind IN ('set','recalculated')), reason TEXT NOT NULL,
    created_by TEXT, created_at TEXT NOT NULL
  );
  ALTER TABLE factors ADD COLUMN uncertainty_pct REAL;
  -- 定版時快照標的屬性（燃料、冷媒、生質比例、適用性），重算封存報告時不受日後修改影響
  CREATE TABLE dataset_asset_snapshots (
    dataset_id TEXT NOT NULL REFERENCES datasets(id), asset_id TEXT NOT NULL REFERENCES assets(id),
    attrs TEXT NOT NULL, applicability TEXT NOT NULL, asset_type TEXT NOT NULL, item_code TEXT, name TEXT NOT NULL,
    PRIMARY KEY (dataset_id, asset_id)
  );
  `,
  // 3：佐證檔病毒掃描結果
  `
  ALTER TABLE evidence_files ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'not_scanned';
  ALTER TABLE evidence_files ADD COLUMN scan_detail TEXT;
  `,
  // 4：院所基本資料（盤查報告每年重複的說明填一次）
  `
  CREATE TABLE org_profiles (
    org_id TEXT PRIMARY KEY REFERENCES organizations(id), data TEXT NOT NULL DEFAULT '{}', updated_by TEXT, updated_at TEXT NOT NULL
  );
  `,
  // 5：對外系統資料輸出（能源查核申報表七建築資料、表十／十一節約能源措施、表十之六歷年節電率）
  `
  ALTER TABLE buildings ADD COLUMN attrs TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE energy_measures (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), asset_id TEXT REFERENCES assets(id),
    year INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('done','plan')),
    source TEXT NOT NULL DEFAULT 'current' CHECK (source IN ('cross_year','current')),
    code TEXT, name TEXT NOT NULL, target TEXT, area TEXT, method TEXT,
    energy_type TEXT NOT NULL CHECK (energy_type IN ('electricity','fuel_oil','lpg','ng','gasoline','diesel')),
    period_from TEXT, period_to TEXT, calc_from_month INTEGER, calc_to_month INTEGER,
    saving REAL, peak_reduction_kw REAL, benefit_twd REAL, investment_twd REAL, calc_note TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    created_by TEXT, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX energy_measures_org ON energy_measures(org_id, year);
  CREATE TABLE energy_saving_years (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), asset_id TEXT REFERENCES assets(id),
    year INTEGER NOT NULL, saving_kwh REAL, usage_kwh REAL, deduct_kwh REAL, note TEXT,
    updated_by TEXT, updated_at TEXT NOT NULL, UNIQUE (org_id, asset_id, year)
  );
  `,
  // 6：114–117 年節約能源目標規定（前期超額節電量要分需量反應與非需量反應）
  `
  ALTER TABLE energy_measures ADD COLUMN demand_response INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE energy_saving_years ADD COLUMN dr_saving_kwh REAL;
  `,
  // 7：組織型盤查表單邏輯（盤查表單 3.0.0；係數 6.0.4 版＝v1、113 年 2 月 5 日公告＝v2）
  //    係數加 95% 信賴區間上下限與係數種類（表五 S 欄／表六 O 欄）；燃料係數改存 kg/TJ，舊的待核准每公升種子作廢重建
  `
  ALTER TABLE factors ADD COLUMN uncertainty_low REAL;
  ALTER TABLE factors ADD COLUMN uncertainty_high REAL;
  ALTER TABLE factors ADD COLUMN factor_class TEXT;
  DELETE FROM factors WHERE created_by = 'seed' AND status = 'pending' AND approved_by IS NULL
    AND (code LIKE 'ef.%.stationary.%' OR code LIKE 'ef.%.mobile.%' OR code IN ('septic.bod_g_per_person_day','septic.bo','septic.mcf'));
  `,
  // 8：盤點樹的網狀關係——盤或設備供應哪些建物／樓層（一盤可供多層、一層可由多盤供電）。floor 為 NULL＝整棟
  `
  CREATE TABLE asset_zones (
    id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), building_id TEXT NOT NULL REFERENCES buildings(id), floor TEXT,
    relation TEXT NOT NULL DEFAULT 'serves' CHECK (relation IN ('serves')),
    valid_from TEXT NOT NULL DEFAULT '1900-01-01', valid_to TEXT, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX asset_zones_asset ON asset_zones(asset_id);
  CREATE INDEX asset_zones_bld ON asset_zones(building_id, floor);
  `,
  // 9：環境部盤查表單（院方原本的 Excel）匯入時保留每一列原始儲存格，盤點樹「依盤查表單頁籤」照原檔欄位排出；
  // 數值本身仍是 observations（不可覆寫），這裡只記原檔長相與對到哪些觀測。同院同年重匯時整頁替換
  `
  CREATE TABLE ghg_sheet_rows (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), year INTEGER NOT NULL,
    evidence_id TEXT REFERENCES evidence_files(id), workbook TEXT NOT NULL, sheet TEXT NOT NULL, tab TEXT NOT NULL,
    part TEXT NOT NULL DEFAULT '', row_no INTEGER NOT NULL, cells TEXT NOT NULL,
    asset_id TEXT REFERENCES assets(id), observation_ids TEXT NOT NULL DEFAULT '[]', note TEXT,
    created_by TEXT, created_at TEXT NOT NULL, UNIQUE (org_id, year, sheet, part, row_no)
  );
  CREATE INDEX ghg_sheet_rows_tab ON ghg_sheet_rows(org_id, year, tab);
  `,
];

let db = null;

export function dbPath() {
  return process.env.PLATFORM_DB || join(config.dataDir, 'platform', 'platform.sqlite');
}

export function openDb(path = dbPath()) {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function closeDb() { if (db) { db.close(); db = null; } }

function migrate(d) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, at TEXT NOT NULL)');
  const done = new Set(d.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1;
    if (done.has(v)) return;
    d.exec('BEGIN');
    try {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (version, at) VALUES (?, ?)').run(v, nowIso());
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
  });
}

// ── 小工具 ──
export const q = {
  get: (sql, ...p) => openDb().prepare(sql).get(...p) || null,
  all: (sql, ...p) => openDb().prepare(sql).all(...p),
  run: (sql, ...p) => openDb().prepare(sql).run(...p),
};

let txDepth = 0;
export function tx(fn) {
  const d = openDb();
  if (txDepth > 0) return fn();
  d.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); txDepth--; d.exec('COMMIT'); return r; }
  catch (e) { txDepth--; try { d.exec('ROLLBACK'); } catch { /* 已回滾 */ } throw e; }
}

// insert：物件 → INSERT；物件／陣列值自動 JSON.stringify，布林轉 0/1
export function insert(table, row) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const vals = keys.map((k) => enc(row[k]));
  openDb().prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
  return row;
}

export function update(table, id, patch, idCol = 'id') {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return 0;
  const r = openDb().prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`).run(...keys.map((k) => enc(patch[k])), id);
  return r.changes;
}

function enc(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// 讀出來的 JSON 欄位轉回物件
export function parseJson(row, cols) {
  if (!row) return row;
  const o = { ...row };
  for (const c of cols) if (typeof o[c] === 'string') { try { o[c] = JSON.parse(o[c]); } catch { /* 保留原字串 */ } }
  return o;
}

// ── 稽核事件：雜湊串鏈 ──
export function audit({ actor = null, actorName = null, orgId = null, action, targetType = null, targetId = null, before = null, after = null, ip = null }) {
  const d = openDb();
  const prev = d.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get();
  const prevHash = prev?.hash || 'genesis';
  const at = nowIso();
  const b = before == null ? null : JSON.stringify(before);
  const a = after == null ? null : JSON.stringify(after);
  const hash = sha256([prevHash, at, actor, orgId, action, targetType, targetId, b, a].map((x) => x ?? '').join('␟'));
  d.prepare(`INSERT INTO audit_events (at, actor, actor_name, org_id, action, target_type, target_id, before, after, ip, prev_hash, hash)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(at, actor, actorName, orgId, action, targetType, targetId, b, a, ip, prevHash, hash);
  return hash;
}

// 驗證整條鏈：回第一個斷點
export function verifyAuditChain() {
  const rows = openDb().prepare('SELECT * FROM audit_events ORDER BY seq').all();
  let prev = 'genesis';
  for (const r of rows) {
    const h = sha256([prev, r.at, r.actor, r.org_id, r.action, r.target_type, r.target_id, r.before, r.after].map((x) => x ?? '').join('␟'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq, count: rows.length };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
