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

export const collections = { news, insights, 'case-studies': caseStudies, glossary, faq, services };
