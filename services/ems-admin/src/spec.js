// 由 schema.js 的 zod 定義「自動」推導出前端表單規格（欄位樹）。
//
// 為什麼要這支：前端原本照「載入到的 JSON 長什麼樣」長表單，導致三個真實缺陷——
//   1. JSON 沒有的鍵（例：807 缺 peakShave、全 15 家都沒有 report/esgPanels）表單就看不到，院方無從補；
//   2. 空陣列沒有樣本可複製 → 只能顯示「請告知維護窗口」，第一筆永遠加不了；
//   3. 新增項目用空字串填所有欄位 → enum 欄位（esg/kind/tone）拿到 '' 直接 422。
// 改由 schema 推導後，這三件事都由「同一份 zod」決定，schema.js 一改這裡自動跟上。
import { hospitalSchema } from './schema.js';
import { metaFor, ENUM_LABELS } from './labels.js';

// ── zod 內省：剝掉 Optional/Default/Nullable 等包裝，取出核心型別與預設值 ──
function unwrap(t) {
  let optional = false;
  let hasDefault = false;
  let defaultValue;
  for (;;) {
    const n = t?._def?.typeName;
    if (n === 'ZodOptional' || n === 'ZodNullable') { optional = true; t = t._def.innerType; continue; }
    if (n === 'ZodDefault') { hasDefault = true; defaultValue = t._def.defaultValue(); t = t._def.innerType; continue; }
    if (n === 'ZodEffects') { t = t._def.schema; continue; }
    break;
  }
  return { core: t, optional, hasDefault, defaultValue };
}

// ownerKey：陣列項目自己沒有鍵名，中文選項表要沿用擁有它的欄位（例 show[] 用 show 的表）
function describe(t, path, ownerKey) {
  const { core, optional, hasDefault, defaultValue } = unwrap(t);
  const name = core?._def?.typeName;
  const meta = metaFor(path, ownerKey);
  const base = {
    path, optional, hasDefault, default: defaultValue,
    label: meta.label, ...(meta.hint ? { hint: meta.hint } : {}), ...(meta.suggest ? { suggest: meta.suggest } : {}),
  };

  if (name === 'ZodObject') {
    const shape = core._def.shape();
    const node = {
      ...base,
      type: 'object',
      fields: Object.entries(shape).map(([k, v]) => ({ key: k, ...describe(v, path ? `${path}.${k}` : k, k) })),
    };
    // optional 區塊在 JSON 裡可能整段不存在（例：report/esgPanels/env.carbon）。
    // 附一份空白骨架，前端才做得出「＋ 啟用此區塊」。
    if (optional) node.blank = blankFrom(node);
    return node;
  }
  if (name === 'ZodArray') {
    const item = describe(core._def.type, `${path}[]`, ownerKey);
    // 陣列項目自己通常沒有獨立標籤，沿用陣列的（否則麵包屑會露出英文鍵名）
    if (item.label === ownerKey) item.label = base.label;
    // itemBlank 隨 spec 一起送到前端：新增項目時直接複製它，enum 欄位就不會是 '' 而被 422 擋下
    return { ...base, type: 'array', item, itemBlank: blankFrom(item) };
  }
  if (name === 'ZodEnum') {
    return { ...base, type: 'enum', values: [...core._def.values], valueLabels: ENUM_LABELS[ownerKey] || null };
  }
  if (name === 'ZodNumber') return { ...base, type: 'number' };
  if (name === 'ZodBoolean') return { ...base, type: 'boolean' };
  if (name === 'ZodString') return { ...base, type: 'string' };
  return { ...base, type: 'unknown' };
}

export const hospitalSpec = describe(hospitalSchema, '', '');

// ── 依 spec 造一個「schema 合法」的空白值 ──
// 關鍵差異：enum 取第一個合法值（或其 default），不再塞 ''；有 default 的直接用 default。
export function blankFrom(spec) {
  if (!spec) return '';
  if (spec.type === 'object') {
    const o = {};
    for (const f of spec.fields) {
      if (f.optional && !f.hasDefault) continue;      // 純 optional 的巢狀區塊不預先展開
      o[f.key] = blankFrom(f);
    }
    return o;
  }
  if (spec.type === 'array') return [];
  if (spec.hasDefault && spec.default !== undefined) return spec.default;
  if (spec.type === 'enum') return spec.values[0];
  if (spec.type === 'number') return 0;
  if (spec.type === 'boolean') return false;
  return '';
}
