// spec.js（由 zod 推導的表單規格）的回歸測試。
// 這裡守的是三個真實壞掉過的行為，改 schema.js / labels.js 時會第一時間發現：
//   A1 新增陣列項目送出被 422 擋下（enum 拿到 ''）
//   A2 空陣列沒有樣本可複製，第一筆永遠加不了
//   A3 JSON 沒有的 optional 區塊表單完全看不到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hospitalSpec, blankFrom } from '../src/spec.js';
import { validateHospital } from '../src/schema.js';

const hospDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'content', 'hospitals');
const load = (f) => JSON.parse(readFileSync(join(hospDir, f), 'utf8'));
const files = readdirSync(hospDir).filter((f) => f.endsWith('.json'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function walkSpec(spec, fn, path = '') {
  fn(spec, path);
  if (spec.type === 'object') for (const f of spec.fields) walkSpec(f, fn, path ? `${path}.${f.key}` : f.key);
  if (spec.type === 'array') walkSpec(spec.item, fn, `${path}[]`);
}

test('A1：每個陣列的 itemBlank 塞進任一院所後仍通過 schema（新增一項不會被 422 擋）', () => {
  for (const file of files) {
    const base = load(file);
    // 對資料裡實際存在的每個陣列，各插一筆 itemBlank 後驗證
    const visit = (obj, spec, path) => {
      if (!spec) return;
      if (spec.type === 'object') {
        if (!obj || typeof obj !== 'object') return;
        for (const f of spec.fields) visit(obj[f.key], f, `${path}.${f.key}`);
        return;
      }
      if (spec.type === 'array') {
        if (!Array.isArray(obj)) return;
        obj.push(clone(spec.itemBlank));
        const r = validateHospital(base);
        assert.ok(r.ok, `${file} 在 ${path} 新增一項後驗證失敗：${(r.errors || []).join(' | ')}`);
        obj.pop();
        if (spec.item.type === 'object') obj.forEach((v, i) => visit(v, spec.item, `${path}[${i}]`));
      }
    };
    visit(base, hospitalSpec, '');
  }
});

test('A1：itemBlank 不會把 enum 欄位填成空字串', () => {
  walkSpec(hospitalSpec, (s, path) => {
    if (s.type !== 'array') return;
    const check = (blank, spec, p) => {
      if (spec.type === 'enum') assert.ok(spec.values.includes(blank), `${p} 的空白值 ${JSON.stringify(blank)} 不在 enum ${spec.values.join('|')} 內`);
      if (spec.type === 'object' && blank && typeof blank === 'object') {
        for (const f of spec.fields) if (f.key in blank) check(blank[f.key], f, `${p}.${f.key}`);
      }
    };
    check(s.itemBlank, s.item, `${path}[]`);
  });
});

test('A2：每個陣列都有 itemBlank，空陣列也能建立第一筆', () => {
  walkSpec(hospitalSpec, (s, path) => {
    if (s.type === 'array') assert.notEqual(s.itemBlank, undefined, `${path} 缺 itemBlank`);
  });
});

test('A3：每個 optional 物件區塊都有可啟用的空白骨架，啟用後仍通過 schema', () => {
  const base = load('803.json');
  const enable = (obj, spec) => {
    if (spec.type !== 'object' || !obj || typeof obj !== 'object') return;
    for (const f of spec.fields) {
      if (f.type === 'object' && f.optional) {
        assert.notEqual(f.blank, undefined, `${f.path} 是 optional 物件但沒有 blank`);
        if (obj[f.key] == null) obj[f.key] = clone(f.blank);
      }
      if (f.type === 'object') enable(obj[f.key], f);
      if (f.type === 'array' && f.item.type === 'object' && Array.isArray(obj[f.key])) {
        for (const v of obj[f.key]) enable(v, f.item);
      }
    }
  };
  enable(base, hospitalSpec);
  const r = validateHospital(base);
  assert.ok(r.ok, `啟用所有 optional 區塊後驗證失敗：${(r.errors || []).join(' | ')}`);
  // 確認確實把全 15 家都沒有的 report / esgPanels 長出來了
  assert.ok(base.report, 'report 應可被啟用');
});

test('A5：每個欄位都有中文標籤（不會在畫面上露出英文鍵名）', () => {
  const bad = [];
  walkSpec(hospitalSpec, (s, path) => {
    if (path && /^[a-zA-Z][a-zA-Z0-9]*$/.test(s.label || '')) bad.push(`${path} → ${s.label}`);
  });
  assert.equal(bad.length, 0, `以下欄位仍是英文標籤：\n${bad.join('\n')}`);
});

test('B4：驗證錯誤訊息是中文，且保留可定位的 zod 路徑', () => {
  const base = load('803.json');
  base.resources[0].peace.supply[0].esg = 'purple';
  const r = validateHospital(base);
  assert.equal(r.ok, false);
  const e = r.errors[0];
  assert.match(e, /^resources\.0\.peace\.supply\.0\.esg: /, `錯誤應保留 zod 路徑，實際：${e}`);
  assert.match(e, /只能是這幾個值之一/, `錯誤訊息應為中文，實際：${e}`);
});

test('spec 涵蓋 schema：每個現有院所 JSON 的每個鍵都在 spec 裡找得到', () => {
  const find = (spec, key) => (spec.type === 'object' ? spec.fields.find((f) => f.key === key) : null);
  for (const file of files) {
    const data = load(file);
    const visit = (obj, spec, path) => {
      if (Array.isArray(obj)) { if (spec.type === 'array') obj.forEach((v, i) => visit(v, spec.item, `${path}[${i}]`)); return; }
      if (!obj || typeof obj !== 'object' || spec.type !== 'object') return;
      for (const k of Object.keys(obj)) {
        const f = find(spec, k);
        assert.ok(f, `${file} 的 ${path}.${k} 在 spec 裡沒有對應欄位（表單會漏掉它）`);
        visit(obj[k], f, `${path}.${k}`);
      }
    };
    visit(data, hospitalSpec, '');
  }
});

test('blankFrom 產出的空白院所本身就通過 schema', () => {
  const blank = blankFrom(hospitalSpec);
  const r = validateHospital(blank);
  assert.ok(r.ok, `空白院所驗證失敗：${(r.errors || []).join(' | ')}`);
});
