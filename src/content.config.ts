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
  value: z.string(),
  sub: z.string().default(''),
  color: z.string().default('chart-1'),
  kind: z.enum(['trend', 'status']).default('trend'),
  trend: emsTrend.optional(),
  segs: z.array(z.object({ label: z.string(), count: z.number(), color: z.string() })).optional(),
});

const emsScenario = z.object({
  perf: emsTrend.extend({ text: z.string() }),
  endur: z.object({ days: z.string(), pct: z.string() }),
  supply: z.array(z.object({
    name: z.string(),
    value: z.string(),
    online: z.boolean(),
    esg: z.enum(['grey', 'green', 'blue', 'amber', 'na']).default('na'),
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
  })),
  use: z.object({
    headline: z.string(),
    sub: z.string().default(''),
    blocks: z.array(emsBlock),
  }),
});

const hospitals = defineCollection({
  loader: glob({ base: 'src/content/hospitals', pattern: '**/*.json' }),
  schema: z.object({
    name: z.string(),
    location: z.string().default(''),
    updated: z.string().default(''),
    liveData: z.boolean().default(false),
    scenarios: z.array(z.object({ id: z.string(), label: z.string() }))
      .default([{ id: 'peace', label: '平時' }, { id: 'war', label: '戰時/救災' }]),
    resources: z.array(z.object({
      id: z.string(),
      icon: z.string(),
      name: z.string(),
      peace: emsScenario,
      war: emsScenario,
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
