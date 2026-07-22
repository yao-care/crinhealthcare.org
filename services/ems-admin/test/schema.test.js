import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateHospital } from '../src/schema.js';

const hospDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'content', 'hospitals');

test('所有現有 hospital JSON 皆通過移植的 schema', () => {
  const files = readdirSync(hospDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1, '應至少有一個院所檔');
  for (const f of files) {
    const obj = JSON.parse(readFileSync(join(hospDir, f), 'utf8'));
    const r = validateHospital(obj);
    assert.ok(r.ok, `${f} 驗證失敗：${(r.errors || []).join(' | ')}`);
  }
});

test('壞資料被擋下（supply 缺 name）', () => {
  const bad = { name: 'x', layout: 'v2', resources: [{ id: 'power', icon: '⚡', name: '電力',
    peace: { perf: { act: [], text: '' }, endur: { days: '', pct: '' }, supply: [{ value: 'v', online: true }], supplySum: '', store: [], use: { headline: '', blocks: [] } },
    war: { perf: { act: [], text: '' }, endur: { days: '', pct: '' }, supply: [], supplySum: '', store: [], use: { headline: '', blocks: [] } } }] };
  const r = validateHospital(bad);
  assert.equal(r.ok, false);
});
