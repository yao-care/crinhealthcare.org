// 種子：服務啟動時跑一次，冪等（已存在的不覆蓋）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { q, insert, newId, nowIso, tx, audit } from './db.js';
import { config } from '../config.js';
import { UNITS, METRICS, ITEMS, REFERENCE_ITEMS } from './seed/dictionary.js';
import { allSeedFactors } from './seed/factors.js';
import { RULES, TEMPLATES } from './seed/rules.js';
import { DEFAULT_CONFIG } from './seed/config.js';
import { invalidateOrgs } from './authz.js';

// 院所階層：分院掛在總院之下（docs/ems-admin-units.md）；三總本院不是客戶，三總分院直接掛在群組下
const GROUPS = [
  { code: 'MND', name: '國軍醫院', match: (hid) => /^\d{3}$/.test(hid) },
  { code: 'VAC', name: '榮民醫院', match: (hid) => /^[a-z]+$/.test(hid) },
];
const PARENT = { 816: '803', 813: '804', 814: '806' };

function hospitalList() {
  const out = new Map();
  const dir = config.repoDir ? join(config.repoDir, 'src', 'content', 'hospitals') : '';
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try { out.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8')).name || f); } catch { /* 略過壞檔 */ }
    }
  }
  if (existsSync(config.accountsFile)) {
    try {
      for (const a of JSON.parse(readFileSync(config.accountsFile, 'utf8')).accounts || []) {
        if (a.hospitalId && !out.has(a.hospitalId)) out.set(a.hospitalId, a.displayName || a.hospitalId);
      }
    } catch { /* 帳號檔壞了不擋種子 */ }
  }
  return out;
}

export function seedOrgs(extra = new Map()) {
  const list = new Map([...hospitalList(), ...extra]);
  const t = nowIso();
  tx(() => {
    for (const g of GROUPS) {
      if (!q.get('SELECT 1 FROM organizations WHERE code = ?', g.code)) {
        insert('organizations', { id: newId('org'), kind: 'group', code: g.code, name: g.name, created_at: t, updated_at: t });
      }
    }
    const sorted = [...list.keys()].sort((a, b) => (PARENT[a] ? 1 : 0) - (PARENT[b] ? 1 : 0));
    for (const hid of sorted) {
      if (q.get('SELECT 1 FROM organizations WHERE legacy_hid = ?', hid)) continue;
      const parentHid = PARENT[hid];
      const parent = parentHid ? q.get('SELECT id FROM organizations WHERE legacy_hid = ?', parentHid)
        : q.get('SELECT id FROM organizations WHERE code = ?', (GROUPS.find((g) => g.match(hid)) || GROUPS[0]).code);
      const id = newId('org');
      insert('organizations', { id, parent_id: parent?.id || null, kind: parentHid || /分院/.test(list.get(hid)) ? 'branch' : 'hospital',
        code: hid, name: list.get(hid), legacy_hid: hid, created_at: t, updated_at: t });
      insert('sites', { id: newId('site'), org_id: id, name: '本院區', created_at: t, updated_at: t });
    }
  });
  invalidateOrgs();
}

export function seedDictionary() {
  const t = nowIso();
  q.run('CREATE TABLE IF NOT EXISTS seed_marks (key TEXT PRIMARY KEY, at TEXT NOT NULL)');
  tx(() => {
    for (const [code, name, dimension, base, toBase] of UNITS) {
      if (!q.get('SELECT 1 FROM units WHERE code = ?', code)) insert('units', { code, name, dimension, base_unit: base, to_base: toBase });
    }
    for (const [code, domain, name, semantics, kind, unit, desc] of METRICS) {
      if (!q.get('SELECT 1 FROM metrics WHERE code = ?', code)) insert('metrics', { code, domain, name, semantics, value_kind: kind, std_unit: unit, description: desc || null });
    }
    for (const it of [...ITEMS, ...REFERENCE_ITEMS]) {
      const ex = q.get('SELECT id, asset_types, metrics, version FROM inventory_items WHERE code = ?', it.code);
      if (ex) {
        // 已存在：只補「種子從沒套用過」的標的類型與指標。套用過的記在 seed_marks，管理者之後刪掉的不會在重啟時被加回來
        const cur = { asset_types: JSON.parse(ex.asset_types || '[]'), metrics: JSON.parse(ex.metrics || '[]') };
        const add = { asset_types: [], metrics: [] };
        for (const k of ['asset_types', 'metrics']) {
          for (const x of it[k] || []) {
            const mark = `item:${it.code}:${k}:${x}`;
            if (q.get('SELECT 1 FROM seed_marks WHERE key = ?', mark)) continue;
            q.run('INSERT INTO seed_marks (key, at) VALUES (?, ?)', mark, t);
            if (!cur[k].includes(x)) add[k].push(x);
          }
        }
        if (add.asset_types.length || add.metrics.length) {
          q.run('UPDATE inventory_items SET asset_types = ?, metrics = ?, version = version + 1, updated_at = ? WHERE id = ?', JSON.stringify([...cur.asset_types, ...add.asset_types]), JSON.stringify([...cur.metrics, ...add.metrics]), t, ex.id);
          audit({ actor: 'system', action: 'dictionary.seed_merge', targetType: 'inventory_item', targetId: ex.id, before: cur, after: add });
        }
        continue;
      }
      insert('inventory_items', {
        id: newId('item'), code: it.code, domain: it.domain, subtype: it.subtype, name: it.name, description: it.description || null,
        asset_types: it.asset_types || [], metrics: it.metrics || [], required_data: it.required_data || [], source_hints: it.source_hints || [],
        expected_frequency: it.expected_frequency || null, collection_guidance: it.collection_guidance || null,
        applicability_rules: it.applicability_rules || null, special_rules: it.special_rules || [], usage_candidates: it.usage_candidates || [],
        ghg_ref: it.ghg_ref || null, created_at: t, updated_at: t,
      });
      for (const k of ['asset_types', 'metrics']) for (const x of it[k] || []) q.run('INSERT OR IGNORE INTO seed_marks (key, at) VALUES (?, ?)', `item:${it.code}:${k}:${x}`, t);
    }
  });
}

export function seedFactors() {
  const t = nowIso();
  tx(() => {
    for (const f of allSeedFactors()) {
      const version = f.version || 1;
      if (q.get('SELECT 1 FROM factors WHERE code = ? AND version = ?', f.code, version)) continue;
      insert('factors', { id: newId('fac'), status: 'pending', created_by: 'seed', created_at: t, reason: '系統預設值，待核對來源後發布', ...f, version });
    }
  });
}

export function seedRulesAndTemplates() {
  const t = nowIso();
  tx(() => {
    for (const r of RULES) {
      const version = r.version || 1;
      if (q.get('SELECT 1 FROM calculation_rules WHERE code = ? AND version = ?', r.code, version)) continue;
      insert('calculation_rules', { id: newId('rule'), code: r.code, version, name: r.name, description: r.description || null,
        definition: r.definition, status: 'published', created_by: 'seed', created_at: t, approved_by: 'seed', approved_at: t });
    }
    for (const tp of TEMPLATES) {
      const version = tp.version || 1;
      if (q.get('SELECT 1 FROM report_templates WHERE code = ? AND version = ?', tp.code, version)) continue;
      const id = newId('tpl');
      insert('report_templates', { id, code: tp.code, version, name: tp.name, standard: tp.standard, standard_version: tp.standard_version,
        applicability: tp.applicability || null, applies_from: tp.applies_from || null, applies_to: tp.applies_to || null,
        sections: tp.sections.map((s) => ({ id: s.id, title: s.title })), status: 'published', created_by: 'seed', created_at: t, approved_by: 'seed', approved_at: t });
      let sort = 0;
      for (const s of tp.sections) {
        for (const f of s.fields) {
          insert('report_mappings', { id: newId('map'), template_id: id, field_id: f.field_id, section: s.id, label: f.label,
            data_type: f.data_type || (f.source_kind === 'indicator' ? 'number' : f.source_kind), source_kind: f.source_kind,
            source_ref: f.source_ref || null, required: f.required === 0 ? 0 : 1, sort: sort++ });
        }
      }
    }
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (q.get('SELECT 1 FROM configuration_versions WHERE key = ?', key)) continue;
      insert('configuration_versions', { id: newId('cfg'), key, version: 1, value, status: 'published', effective_at: t,
        reason: '系統預設值', created_by: 'seed', created_at: t, approved_by: 'seed', approved_at: t });
    }
  });
}

// 每個院所自動建一筆「院所營運活動」標的，放員工人數、人次、床數、面積這些分母
export function seedActivityAssets() {
  const t = nowIso();
  const items = q.all("SELECT id, code FROM inventory_items WHERE domain = 'activity'");
  tx(() => {
    for (const o of q.all("SELECT id FROM organizations WHERE kind IN ('hospital','branch')")) {
      const site = q.get('SELECT id FROM sites WHERE org_id = ? ORDER BY created_at LIMIT 1', o.id);
      for (const it of items) {
        if (q.get('SELECT 1 FROM assets WHERE org_id = ? AND item_id = ?', o.id, it.id)) continue;
        insert('assets', { id: newId('ast'), org_id: o.id, site_id: site?.id || null, item_id: it.id, domain: 'activity', asset_type: 'org_activity',
          name: { 'ACT-STAFF': '員工人數與工時', 'ACT-PATIENT': '就診與住院人次', 'ACT-CAP': '病床與樓地板面積', 'ACT-WASTE': '廢棄物產出量' }[it.code] || it.code,
          applicability: 'applicable', created_by: 'seed', created_at: t, updated_at: t });
      }
    }
  });
}

// 每院預設一個「營運控制法」盤查邊界，涵蓋全部院區（院方可再改）
export function seedDefaultBoundaries() {
  const t = nowIso();
  tx(() => {
    for (const o of q.all("SELECT id FROM organizations WHERE kind IN ('hospital','branch')")) {
      if (q.get("SELECT 1 FROM boundaries WHERE org_id = ? AND kind IN ('ghg_operational','ghg_equity')", o.id)) continue;
      const sites = q.all('SELECT id FROM sites WHERE org_id = ?', o.id).map((s) => s.id);
      insert('boundaries', { id: newId('bnd'), org_id: o.id, name: '全院（營運控制法）', kind: 'ghg_operational', site_ids: sites,
        definition: '系統預設：本院營運控制之全部院區與建物。如有委外或租賃設施請修改', created_by: 'seed', created_at: t, updated_at: t });
    }
  });
}

export function runSeeds(opts = {}) {
  seedOrgs(opts.extraHospitals);
  seedDictionary();
  seedFactors();
  seedRulesAndTemplates();
  seedActivityAssets();
  seedDefaultBoundaries();
  if (!q.get("SELECT 1 FROM audit_events WHERE action = 'system.seed'")) audit({ actor: 'system', action: 'system.seed' });
}
