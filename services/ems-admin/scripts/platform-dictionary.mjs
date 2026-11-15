#!/usr/bin/env node
// 由種子產生資料字典文件：node scripts/platform-dictionary.mjs > ../../docs/ems-platform-dictionary.md
import { UNITS, METRICS, ITEMS, REFERENCE_ITEMS, ASSET_TYPES, WORK_STATUS, APPLICABILITY, USAGE_STATUS, DOMAINS } from '../src/platform/seed/dictionary.js';
import { allSeedFactors } from '../src/platform/seed/factors.js';
import { RULES, TEMPLATES } from '../src/platform/seed/rules.js';
import { DEFAULT_CONFIG } from '../src/platform/seed/config.js';
import { ROLES, ACTION_LABELS } from '../src/platform/authz.js';
const esc = (s) => String(s ?? '').replace(/\|/g, '／').replace(/\n/g, ' ');
const row = (...c) => `| ${c.map(esc).join(' | ')} |`;
const out = [];
out.push('# 油水電氣資料治理平台｜資料字典', '', '> 本檔由 `services/ems-admin/scripts/platform-dictionary.mjs` 從種子產生，請勿手改；正式值以管理後台的版本為準。', '');
out.push('## 面向', '', row('代碼', '名稱'), row('---', '---'), ...Object.entries(DOMAINS).map(([k, v]) => row(k, `${v.icon} ${v.name}`)), '');
out.push('## 盤點項目', '', row('代碼', '面向', '名稱', '標的類型', '指標', '需要的資料', '常見來源', '特殊規則', '盤查參照'), row('---', '---', '---', '---', '---', '---', '---', '---', '---'));
for (const i of [...ITEMS, ...REFERENCE_ITEMS]) out.push(row(i.code, DOMAINS[i.domain].name, i.name, (i.asset_types || []).map((t) => ASSET_TYPES[t] || t).join('、'), (i.metrics || []).join('、'),
  (i.required_data || []).join('、'), (i.source_hints || []).join('、'), (i.special_rules || []).join('；'), i.ghg_ref ? `範疇${i.ghg_ref.scope}／${i.ghg_ref.iso}／${i.ghg_ref.type}` : ''));
out.push('', '## 指標', '', row('代碼', '面向', '名稱', '語意', '值型態', '標準單位', '說明'), row('---', '---', '---', '---', '---', '---', '---'), ...METRICS.map((m) => row(...m)), '');
out.push('## 單位', '', row('代碼', '名稱', '維度', '基準單位', '換算倍率'), row('---', '---', '---', '---', '---'), ...UNITS.map((u) => row(...u)), '');
out.push('## 標的類型', '', row('代碼', '名稱'), row('---', '---'), ...Object.entries(ASSET_TYPES).map(([k, v]) => row(k, v)), '');
out.push('## 狀態軸', '', '**資料工作進度**：' + Object.values(WORK_STATUS).join(' → '), '', '**盤點適用性**：' + Object.values(APPLICABILITY).join('／'), '', '**用途採用狀態**：' + Object.values(USAGE_STATUS).join(' → '), '');
out.push('## 計算規則（指標）', '', row('代碼', '名稱', '定義', '說明'), row('---', '---', '---', '---'), ...RULES.map((r) => row(r.code, r.name, JSON.stringify(r.definition), r.description)), '');
out.push('## 報告模板', '', row('代碼', '版本', '名稱', '準則', '版次', '適用期間', '欄位數'), row('---', '---', '---', '---', '---', '---', '---'),
  ...TEMPLATES.map((t) => row(t.code, t.version || 1, t.name, t.standard, t.standard_version, `${t.applies_from || ''}～${t.applies_to || ''}`, t.sections.reduce((s, x) => s + x.fields.length, 0))), '');
out.push('## 預設係數（種子，待核准後發布）', '', row('代碼', '名稱', '值', '單位', '生效', '來源', '說明'), row('---', '---', '---', '---', '---', '---', '---'),
  ...allSeedFactors().map((f) => row(f.code, f.name, f.value, f.unit, `${f.valid_from}～${f.valid_to || ''}`, f.source, f.note)), '');
out.push('## 預設設定', '', ...Object.entries(DEFAULT_CONFIG).flatMap(([k, v]) => [`### ${k}`, '', '```json', JSON.stringify(v, null, 2), '```', '']));
out.push('## 角色', '', row('代碼', '名稱', '說明'), row('---', '---', '---'), ...Object.entries(ROLES).map(([k, v]) => row(k, v.name, v.desc)), '');
out.push('## 權限動作', '', row('代碼', '名稱'), row('---', '---'), ...Object.entries(ACTION_LABELS).map(([k, v]) => row(k, v)), '');
console.log(out.join('\n'));
