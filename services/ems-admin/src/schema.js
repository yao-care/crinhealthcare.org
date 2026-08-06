// hospital JSON 驗證 schema —— 由 crinhealthcare.org/src/content.config.ts 逐段移植。
// 目的：送出前用與 Astro 建置「同一套」規則驗證，避免推上去才在 CI 掛掉。
// ⚠️ 維護提醒：content.config.ts 的 hospitals schema 若有增修，這裡要同步（見 README「Schema 同步」）。
import { z } from 'zod';

const emsTrend = z.object({
  act: z.array(z.number()),
  fc: z.array(z.number()).default([]),
  base: z.number().optional(),
  warn: z.number().optional(),
});

const emsBlock = z.object({
  name: z.string(),
  value: z.string().default(''),
  sub: z.string().default(''),
  color: z.string().default('chart-1'),
  kind: z.enum(['trend', 'status']).default('trend'),
  trend: emsTrend.optional(),
  segs: z.array(z.object({ label: z.string(), count: z.number(), color: z.string() })).optional(),
  pctOfTotal: z.string().default(''),
  lastYear: z.string().default(''),
  current: z.string().default(''),
  unit: z.string().default(''),
  daily: z.array(z.number()).default([]),
  lastYearDaily: z.array(z.number()).default([]),
  critical: z.boolean().default(false),
  items: z.array(z.string()).default([]),
  img: z.string().default(''),
  imgs: z.array(z.string()).default([]),
  caption: z.string().default(''),
});

const emsScenario = z.object({
  perf: emsTrend.extend({ text: z.string() }),
  endur: z.object({ days: z.string(), pct: z.string(), live: z.string().default('') }),
  supply: z.array(z.object({
    name: z.string(),
    value: z.string(),
    online: z.boolean(),
    esg: z.enum(['grey', 'green', 'blue', 'amber', 'na']).default('na'),
    pct: z.string().default(''),
    react: z.string().default(''),
    autonomous: z.boolean().default(false),
    warn: z.boolean().default(false),
    live: z.string().default(''),
  })),
  supplySum: z.string(),
  detailLabel: z.string().default(''),
  detail: z.array(z.object({
    name: z.string(),
    value: z.string(),
    warn: z.boolean().default(false),
  })).default([]),
  store: z.array(z.object({
    name: z.string(),
    days: z.string(),
    cap: z.string(),
    pct: z.number(),
    warn: z.boolean().default(false),
    state: z.string().default(''),
    critical: z.boolean().default(false),
    metrics: z.array(z.object({ k: z.string(), v: z.string() })).default([]),
    flags: z.array(z.object({ label: z.string(), tone: z.enum(['ok', 'warn', 'alert', 'off']).default('off') })).default([]),
    live: z.string().default(''),
  })),
  use: z.object({
    headline: z.string(),
    sub: z.string().default(''),
    blocks: z.array(emsBlock),
    map: z.object({
      title: z.string().default(''),
      legend: z.string().default(''),
      boxes: z.array(z.object({
        label: z.string(),
        kind: z.string().default('zone'),
        star: z.boolean().default(false),
      })).default([]),
    }).optional(),
  }),
  // v2 戰時平面配置圖（選用）：座標為 0–100 的畫布百分比
  plan: z.object({
    title: z.string().default(''),
    sub: z.string().default(''),
    zones: z.array(z.object({
      id: z.string().default(''),
      label: z.string(),
      kind: z.string().default('zone'),
      x: z.number(), y: z.number(), w: z.number(), h: z.number(),
      rot: z.number().default(0),
      sub: z.string().default(''),
      star: z.boolean().default(false),
    })).default([]),
    legend: z.array(z.object({ label: z.string(), kind: z.string() })).default([]),
    videos: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      src: z.string().default(''),
      at: z.number().default(0),
      poster: z.string().default(''),
      sec: z.number().default(0),
    })).default([]),
  }).optional(),
  // v2 戰時供電規劃（選用）：儲電櫃 + 逐項負載，彙總值全由 loads[].parts 推導
  power: z.object({
    title: z.string().default(''),
    note: z.string().default(''),
    usablePct: z.number().default(100),
    cabinets: z.array(z.object({
      name: z.string(),
      kwh: z.number(), kw: z.number(),
      out: z.string().default(''), loc: z.string().default(''), state: z.string().default(''),
    })).default([]),
    mobile: z.array(z.object({
      name: z.string(),
      qty: z.number().default(1),
      zone: z.string().default(''),
      use: z.string().default(''),
      kwh: z.number().default(0),
      kw: z.number().default(0),
      out: z.string().default(''),
      weight: z.string().default(''),
      spec: z.string().default(''),
      state: z.string().default(''),
    })).default([]),
    loads: z.array(z.object({
      name: z.string(),
      essential: z.boolean().default(true),
      parts: z.array(z.object({
        zone: z.string().default(''),
        n: z.string().default(''),
        qty: z.number(), w: z.number(),
        flat: z.boolean().default(false),
      })).default([]),
    })).default([]),
  }).optional(),
});

const envFloor = z.object({
  floor: z.string(),
  temp: z.string().default(''),
  rh: z.string().default(''),
  co2: z.string().default(''),
});
const envBuildings = z.array(z.object({
  name: z.string(),
  floors: z.array(envFloor).default([]),
})).default([]);
const emsEnv = z.object({
  peace: z.object({ buildings: envBuildings }).default({ buildings: [] }),
  war: z.object({ buildings: envBuildings }).default({ buildings: [] }),
  thresholds: z.object({
    temp: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    rh: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    co2: z.object({ max: z.number().optional() }).optional(),
  }).optional(),
  criticalFloors: z.array(z.string()).default([]),
  carbon: z.object({
    title: z.string().default(''),
    cols: z.array(z.string()).default([]),
    rows: z.array(z.object({ label: z.string(), cells: z.array(z.string()).default([]) })).default([]),
  }).optional(),
});

export const hospitalSchema = z.object({
  name: z.string(),
  boardTitle: z.string().default(''),
  location: z.string().default(''),
  updated: z.string().default(''),
  version: z.string().default(''),
  hideMeta: z.boolean().default(false),
  liveData: z.boolean().default(false),
  layout: z.enum(['stack', 'split', 'v2']).default('stack'),
  show: z.array(z.enum(['power', 'water', 'oil', 'gas', 'env'])).optional(),
  peakShave: z.boolean().default(false),
  peakShaveHide: z.array(z.string()).default([]),
  env: emsEnv.optional(),
  scenarios: z.array(z.object({ id: z.string(), label: z.string() }))
    .default([{ id: 'peace', label: '平時' }, { id: 'war', label: '戰時/救災' }]),
  resources: z.array(z.object({
    id: z.string(),
    icon: z.string(),
    name: z.string(),
    peace: emsScenario,
    war: emsScenario,
    devices: z.array(z.object({
      name: z.string(),
      loc: z.string().default(''),
      system: z.string().default(''),
      status: z.string().default(''),
      reading: z.string().default(''),
      daily: z.array(z.number()).default([]),
      refDaily: z.array(z.number()).default([]),
      unit: z.string().default(''),
      manager: z.string().default(''),
      contact: z.string().default(''),
      vendor: z.string().default(''),
      live: z.string().default(''),
    })).default([]),
  })),
  report: z.object({
    esg: z.array(z.object({ item: z.string(), value: z.string(), unit: z.string().default('') })).default([]),
    benchmark: z.array(z.object({ item: z.string(), value: z.string(), unit: z.string().default('') })).default([]),
  }).optional(),
  esgPanels: z.array(z.object({
    id: z.string(),
    icon: z.string(),
    title: z.string(),
    compare: z.boolean().default(false),
    cols: z.array(z.string()).default([]),
    rows: z.array(z.object({
      label: z.string(),
      value: z.string().default(''),
      cells: z.array(z.string()).default([]),
      delta: z.object({ text: z.string(), good: z.boolean() }).optional(),
      pending: z.boolean().default(false),
    })).default([]),
  })).default([]),
});

// zod 的英文訊息院方看不懂（原本畫面上直接出現 "Invalid enum value. Expected 'grey' | ..."）。
// 這裡翻成中文；路徑仍保持 zod 原樣，前端要靠它把錯誤對回畫面上的欄位。
const TYPE_ZH = { string: '文字', number: '數字', boolean: '是/否', array: '清單', object: '區塊' };
function zhIssue(i) {
  switch (i.code) {
    case 'invalid_type':
      if (i.received === 'undefined') return '這是必填欄位，不能留空';
      return `格式應為${TYPE_ZH[i.expected] || i.expected}，目前是${TYPE_ZH[i.received] || i.received}`;
    case 'invalid_enum_value':
      return `只能是這幾個值之一：${(i.options || []).join('、')}（目前是「${i.received}」）`;
    case 'too_small':
      return `不能少於 ${i.minimum}`;
    case 'too_big':
      return `不能多於 ${i.maximum}`;
    case 'unrecognized_keys':
      return `有無法辨識的欄位：${(i.keys || []).join('、')}`;
    default:
      return i.message;
  }
}

// 驗證並回傳 { ok, data|errors }。strict 不加：容忍未知欄位（與 zod 預設 strip 一致，避免擋掉 schema 尚未涵蓋的欄位）
export function validateHospital(obj) {
  const r = hospitalSchema.safeParse(obj);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${zhIssue(i)}`) };
}
