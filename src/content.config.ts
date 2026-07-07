import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const imageSchema = z.object({
  src: z.string(),
  alt: z.string(),
  credit: z.string().optional(),
  unsplashId: z.string().optional(),
});

const internationalBenchmarkSchema = z.object({
  region: z.string(),
  title: z.string(),
  summary: z.string(),
  sourceUrl: z.string(),
  comparison: z.string(),
});

const news = defineCollection({
  loader: glob({ base: 'src/content/news', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    source: z.string(),
    sourceUrl: z.string().optional(),
    publishDate: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string(),
    editorComment: z.string().optional(),
    editorPick: z.boolean().default(false),
    internationalBenchmark: internationalBenchmarkSchema.optional(),
    heroImage: imageSchema.optional(),
    draft: z.boolean().default(false),
  }),
});

const insights = defineCollection({
  loader: glob({ base: 'src/content/insights', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    publishDate: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string(),
    category: z.enum(['policy', 'guide', 'benchmark']),
    internationalBenchmark: internationalBenchmarkSchema.optional(),
    heroImage: imageSchema.optional(),
    inlineImages: z.array(imageSchema).default([]),
    draft: z.boolean().default(false),
  }),
});

const caseStudies = defineCollection({
  loader: glob({ base: 'src/content/case-studies', pattern: '**/*.md' }),
  schema: z.object({
    hospital: z.object({
      name: z.string(),
      location: z.string(),
      system: z.enum(['military', 'veterans', 'other']),
    }),
    publishDate: z.coerce.date(),
    tags: z.array(z.string()),
    summary: z.string(),
    services: z.array(
      z.enum(['carbon-audit', 'ems', 'esg-report', 'awards', 'subsidies', 'health-taiwan']),
    ),
    metrics: z.object({
      energySavingPercent: z.number().optional(),
      subsidyAmount: z.number().optional(),
      certifications: z.array(z.string()).default([]),
    }),
    heroImage: imageSchema.optional(),
    draft: z.boolean().default(false),
  }),
});

const glossary = defineCollection({
  loader: glob({ base: 'src/content/glossary', pattern: '**/*.md' }),
  schema: z.object({
    term: z.string(),
    definition: z.string(),
    category: z.enum(['carbon', 'energy', 'esg', 'policy', 'certification']),
    relatedTerms: z.array(z.string()).default([]),
    relatedServices: z.array(z.string()).default([]),
    heroImage: imageSchema.optional(),
    draft: z.boolean().default(false),
  }),
});

const faq = defineCollection({
  loader: glob({ base: 'src/content/faq', pattern: '**/*.md' }),
  schema: z.object({
    question: z.string(),
    answer: z.string(),
    category: z.enum(['general', 'membership', 'carbon-audit', 'ems', 'esg', 'subsidy']),
    order: z.number(),
  }),
});

const services = defineCollection({
  loader: glob({ base: 'src/content/services', pattern: '**/*.md' }),
  schema: z.object({
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    features: z.array(z.object({
      title: z.string(),
      description: z.string(),
    })),
    heroImage: imageSchema.optional(),
  }),
});

// ── EMS resource board (hospitals) ──
// 趨勢：即時(act) + 預測(fc) + 基準線(base) + 警戒線(warn)
const emsTrend = z.object({
  act: z.array(z.number()),
  fc: z.array(z.number()).default([]),
  base: z.number().optional(),
  warn: z.number().optional(),
});

// color 用 token 語意鍵：primary/accent/energy/alert/text-secondary/chart-1..5
const emsBlock = z.object({
  name: z.string(),
  value: z.string().default(''),
  sub: z.string().default(''),
  color: z.string().default('chart-1'),
  kind: z.enum(['trend', 'status']).default('trend'),
  trend: emsTrend.optional(),
  segs: z.array(z.object({ label: z.string(), count: z.number(), color: z.string() })).optional(),
  // v2 使用端卡片：佔總量% / 去年同期 / 現況電表 / 單位 / 每日序列 / 去年同期序列 / 關鍵(維生)負載
  pctOfTotal: z.string().default(''),
  lastYear: z.string().default(''),
  current: z.string().default(''),
  unit: z.string().default(''),
  daily: z.array(z.number()).default([]),
  lastYearDaily: z.array(z.number()).default([]),
  critical: z.boolean().default(false),
  // v2 使用端卡片（戰時收治區型）：卡身＝該區用電設備清單（品名×數量）；有值時取代電表欄
  items: z.array(z.string()).default([]),
  // v2 使用端卡片（現場影像回傳型）：img＝照片/串流截圖路徑（有值時卡身改鋪影像），caption＝圖說
  img: z.string().default(''),
  caption: z.string().default(''),
});

const emsScenario = z.object({
  perf: emsTrend.extend({ text: z.string() }),
  // live：即時資料覆蓋標記（'ess'=儲能櫃 Modbus 橋接；見 utils/essLive）。用機器鍵不比對名稱字串。
  endur: z.object({ days: z.string(), pct: z.string(), live: z.string().default('') }),
  supply: z.array(z.object({
    name: z.string(),
    value: z.string(),
    online: z.boolean(),
    esg: z.enum(['grey', 'green', 'blue', 'amber', 'na']).default('na'),
    // v2：佔供給比% / 反應時間 / 是否零外部依賴(自主) / 異常(紅底)
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
    // v2：充/放/待命狀態 / 是否關鍵儲備
    state: z.string().default(''),
    critical: z.boolean().default(false),
    // v2：智慧儲存設備（如行動儲電櫃）的儀表板格點（選用）；欄位以設備通訊協定（Modbus 點位表）為準
    // metrics＝標籤/數值格（stat-tile 格點）；flags＝狀態 pills（運轉/併網/警報，tone: ok/warn/alert/off）
    metrics: z.array(z.object({ k: z.string(), v: z.string() })).default([]),
    flags: z.array(z.object({ label: z.string(), tone: z.enum(['ok', 'warn', 'alert', 'off']).default('off') })).default([]),
    live: z.string().default(''),
  })),
  use: z.object({
    headline: z.string(),
    sub: z.string().default(''),
    blocks: z.array(emsBlock),
    // v2 開設配置圖（選用）：一列帶狀方塊呈現場地佈置（如 803 B1 地下收治場所，p4 規劃圖）
    map: z.object({
      title: z.string().default(''),
      legend: z.string().default(''),
      boxes: z.array(z.object({
        label: z.string(),
        kind: z.string().default('zone'),   // zone(收治區)/facility(設施)/road(車道)/command(指揮)
        star: z.boolean().default(false),   // ★ 固定電源點
      })).default([]),
    }).optional(),
  }),
});

// v2 環境參數：多棟大樓 × 樓層的 溫/濕/CO₂ 矩陣（依情境）＋ 異常門檻 ＋ 碳盤查表（與情境無關）
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
  // 超出門檻 → 標紅（值在 floors 以字串存，元件 parseFloat 後比對）
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

const hospitals = defineCollection({
  loader: glob({ base: 'src/content/hospitals', pattern: '**/*.json' }),
  schema: z.object({
    name: z.string(),
    location: z.string().default(''),
    updated: z.string().default(''),
    // v2 頂列「版本」欄（圖示 v1）；updated 仍存西元，顯示時轉民國
    version: z.string().default(''),
    liveData: z.boolean().default(false),
    // 版面：stack＝上半資源/下半面板；split＝左半資源/右半面板(50%)；v2＝五大區塊(電/環境/水/油/氣)新框架
    layout: z.enum(['stack', 'split', 'v2']).default('stack'),
    // v2 限定只顯示這些區塊（power/water/oil/gas/env）；未設＝全顯示。留下的區塊自動撐滿版面。
    show: z.array(z.enum(['power', 'water', 'oil', 'gas', 'env'])).optional(),
    // v2 環境參數（特例：不分供/儲/使、無看詳情）
    env: emsEnv.optional(),
    scenarios: z.array(z.object({ id: z.string(), label: z.string() }))
      .default([{ id: 'peace', label: '平時' }, { id: 'war', label: '戰時/救災' }]),
    resources: z.array(z.object({
      id: z.string(),
      icon: z.string(),
      name: z.string(),
      peace: emsScenario,
      war: emsScenario,
      // v2 看詳情：設備層具名清單（選用，有資料才顯示）。每台一條滿版列：
      //   左=即時訊息(狀態/即時值) · 中=趨勢圖(daily 長條 + refDaily 參考線) · 右=維護者資訊(出問題找誰)
      devices: z.array(z.object({
        name: z.string(),
        loc: z.string().default(''),
        system: z.string().default(''),
        // 左：即時訊息
        status: z.string().default(''),       // 運轉/待命/維護/異常
        reading: z.string().default(''),      // 即時值/訊息（如 負載68% / 7.2°C）
        // 中：趨勢圖
        daily: z.array(z.number()).default([]),
        refDaily: z.array(z.number()).default([]),
        unit: z.string().default(''),
        // 右：維護者資訊
        manager: z.string().default(''),      // 管理人/權責人
        contact: z.string().default(''),      // 聯絡（分機/電話）
        vendor: z.string().default(''),       // 維護廠商
        live: z.string().default(''),         // 即時資料覆蓋標記（'ess'）
      })).default([]),
    })),
    // 匯出用：ESG 報告 / 節能標竿獎各自的欄位（項目·數值·單位）
    report: z.object({
      esg: z.array(z.object({ item: z.string(), value: z.string(), unit: z.string().default('') })).default([]),
      benchmark: z.array(z.object({ item: z.string(), value: z.string(), unit: z.string().default('') })).default([]),
    }).optional(),
    // 下半部面板：碳盤查 / 社會 / 治理等（非供儲用流程，用 label-value 卡呈現）
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
  }),
});

export const collections = { news, insights, 'case-studies': caseStudies, glossary, faq, services, hospitals };
