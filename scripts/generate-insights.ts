#!/usr/bin/env node
/**
 * generate-insights.ts
 * Deep content generation pipeline for crinhealthcare.org
 *
 * Flow:
 * 1. Load config from data/insights-config.json
 * 2. Determine next category via rotation (policy → guide → benchmark → ...)
 * 3. Search sources via Tavily API using category-specific strategy
 * 4. Dedup against data/processed-insights.json
 * 5. Generate deep article via Claude API with reviewer loop
 * 6. Add cross-references to glossary/case-studies
 * 7. Save markdown to src/content/insights/
 * 8. Update processed-insights.json
 *
 * Usage:
 *   pnpm tsx scripts/generate-insights.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateContent } from './lib/ai.js';
import { stringify } from 'yaml';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'data', 'insights-config.json');
const PROCESSED_PATH = join(PROJECT_ROOT, 'data', 'processed-insights.json');
const OUTPUT_DIR = join(PROJECT_ROOT, 'src', 'content', 'insights');
const GLOSSARY_DIR = join(PROJECT_ROOT, 'src', 'content', 'glossary');
const CASE_STUDIES_DIR = join(PROJECT_ROOT, 'src', 'content', 'case-studies');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InsightCategory = 'policy' | 'guide' | 'benchmark';

interface CategoryStrategy {
  queries: string[];
  preferredDomains: string[];
}

interface InsightsConfig {
  categories: {
    rotation: InsightCategory[];
    searchStrategies: Record<InsightCategory, CategoryStrategy>;
  };
  generation: {
    model: string;
    maxTokens: number;
    targetWordCount: { min: number; max: number };
    maxReviewerIterations: number;
    systemPrompt: string;
    reviewerPrompt: string;
  };
  output: {
    collection: string;
    filenamePrefix: string;
    contentDir: string;
  };
}

interface ProcessedInsights {
  processedTopics: string[];
  lastCategory: InsightCategory | null;
  lastRun: string | null;
}

interface TavilyResult {
  url: string;
  title: string;
  content: string;
  score?: number;
}

interface GeneratedInsight {
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
  isDraft: boolean;
  topic: string;
}

// ---------------------------------------------------------------------------
// .env file loader
// ---------------------------------------------------------------------------

function loadEnvFile(): void {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Tavily API
// ---------------------------------------------------------------------------

async function searchTavily(
  query: string,
  domains: string[],
  maxResults: number,
): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      max_results: maxResults,
      include_domains: domains.length > 0 ? domains : undefined,
    }),
  });

  if (!res.ok) {
    console.warn(`  [warn] Tavily HTTP ${res.status} for query "${query}"`);
    return [];
  }

  const data = await res.json();
  return (data.results ?? []) as TavilyResult[];
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Category rotation
// ---------------------------------------------------------------------------

function getNextCategory(
  rotation: InsightCategory[],
  lastCategory: InsightCategory | null,
): InsightCategory {
  if (!lastCategory) return rotation[0];
  const idx = rotation.indexOf(lastCategory);
  return rotation[(idx + 1) % rotation.length];
}

// ---------------------------------------------------------------------------
// Cross-reference: load glossary terms and case study slugs
// ---------------------------------------------------------------------------

interface CrossRefData {
  glossaryTerms: string[];
  caseStudySlugs: string[];
}

function loadCrossReferences(): CrossRefData {
  const glossaryTerms: string[] = [];
  const caseStudySlugs: string[] = [];

  // Load glossary terms from frontmatter
  if (existsSync(GLOSSARY_DIR)) {
    const files = readdirSync(GLOSSARY_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = readFileSync(join(GLOSSARY_DIR, file), 'utf-8');
      const termMatch = content.match(/^term:\s+"?([^"\n]+)"?/m);
      if (termMatch) {
        glossaryTerms.push(termMatch[1].trim());
      }
      // Also use slug as fallback
      caseStudySlugs.push(file.replace(/\.md$/, ''));
    }
  }

  // Load case study slugs
  if (existsSync(CASE_STUDIES_DIR)) {
    const files = readdirSync(CASE_STUDIES_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      caseStudySlugs.push(file.replace(/\.md$/, ''));
    }
  }

  return { glossaryTerms, caseStudySlugs };
}

// ---------------------------------------------------------------------------
// Article generation with reviewer loop
// ---------------------------------------------------------------------------

async function generateInsight(
  category: InsightCategory,
  sources: TavilyResult[],
  config: InsightsConfig,
  crossRefs: CrossRefData,
): Promise<GeneratedInsight> {
  const { generation, output } = config;

  // Build source context
  const sourceContext = sources
    .map(
      (s, i) =>
        `來源 ${i + 1}:\n標題: ${s.title}\n網址: ${s.url}\n內容: ${s.content}`,
    )
    .join('\n\n');

  // Build cross-reference hints
  const glossaryHint =
    crossRefs.glossaryTerms.length > 0
      ? `\n\n可交叉引用的詞彙表術語：${crossRefs.glossaryTerms.join('、')}`
      : '';
  const caseStudyHint =
    crossRefs.caseStudySlugs.length > 0
      ? `\n\n可引用的案例研究：${crossRefs.caseStudySlugs.join('、')}`
      : '';

  // Category-specific instructions
  const categoryInstructions: Record<InsightCategory, string> = {
    policy: `這是一篇「政策法規分析」文章。請深入解析相關法規條文，並提供醫療機構的具體應對建議。`,
    guide: `這是一篇「實務指引」文章。請提供可操作的步驟指引，引用實際案例，讓讀者能夠按圖索驥。`,
    benchmark: `這是一篇「國際標竿」文章。請比較國際做法與台灣現況，提出可借鏡之處。\n\n請在 frontmatter 中包含 internationalBenchmark 區塊：\ninternationalBenchmark:\n  region: "地區名稱"\n  title: "標竿計畫名稱"\n  summary: "簡述"\n  sourceUrl: "來源網址"\n  comparison: "與台灣的比較分析"`,
  };

  const prompt = `${categoryInstructions[category]}

根據以下來源資料，撰寫一篇深度專題文章（1500-3000字）。

${sourceContext}
${glossaryHint}
${caseStudyHint}

請以下列 YAML frontmatter + Markdown 格式輸出（不要加 \`\`\` 代碼區塊標記）：

---
title: "標題（25字以內）"
publishDate: ${new Date().toISOString().split('T')[0]}
tags: ["標籤1", "標籤2", "標籤3"]
summary: "80-120字摘要"
category: "${category}"
draft: false
---

## 小節標題一

正文內容（請分 4-6 個小節）...

## 小節標題二

正文內容...`;

  let articleContent = '';
  let isDraft = false;

  for (let iteration = 0; iteration < generation.maxReviewerIterations; iteration++) {
    console.log(`    [gen] Iteration ${iteration + 1}/${generation.maxReviewerIterations}`);

    // Generate article
    if (iteration === 0) {
      articleContent = await generateContent(
        prompt,
        generation.systemPrompt,
        generation.model,
      );
    } else {
      articleContent = await generateContent(
        `請根據以下審核意見修改專題文章：\n\n審核意見：\n${reviewerFeedback}\n\n原始文章：\n${articleContent}\n\n請輸出完整修改後的文章（含 YAML frontmatter），不要加 \`\`\` 代碼區塊標記。`,
        generation.systemPrompt,
        generation.model,
      );
    }

    await delay(2000);

    // Run reviewer check
    const reviewerPromptFilled = generation.reviewerPrompt.replace(
      '{article_content}',
      articleContent,
    );
    var reviewerFeedback = await generateContent(
      reviewerPromptFilled,
      '你是專業的深度內容品質審核員。',
      generation.model,
    );

    await delay(2000);

    if (reviewerFeedback.includes('APPROVED')) {
      console.log(`    [ok] Reviewer approved at iteration ${iteration + 1}`);
      break;
    }

    console.log(`    [review] Reviewer has suggestions, iterating...`);

    if (iteration === generation.maxReviewerIterations - 1) {
      console.log(`    [warn] Max iterations reached, saving as draft`);
      isDraft = true;
    }
  }

  // Parse the generated content
  const parsed = parseGeneratedInsight(articleContent, category, isDraft);

  // Generate filename
  const now = new Date();
  const dateStr = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const filename = `${output.filenamePrefix}-${category}-${dateStr}.md`;

  // Derive topic from title for dedup tracking
  const topic = (parsed.frontmatter.title as string) || `${category}-${dateStr}`;

  return {
    filename,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    isDraft,
    topic,
  };
}

// ---------------------------------------------------------------------------
// Parse generated insight
// ---------------------------------------------------------------------------

interface ParsedInsight {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseGeneratedInsight(
  content: string,
  category: InsightCategory,
  forceDraft: boolean,
): ParsedInsight {
  // Strip code block markers if AI wrapped output
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }

  // Extract frontmatter between --- delimiters
  const fmMatch = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!fmMatch) {
    return {
      frontmatter: {
        title: 'Untitled',
        publishDate: new Date().toISOString().split('T')[0],
        tags: ['醫療永續'],
        summary: '',
        category,
        draft: true,
      },
      body: cleaned,
    };
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();

  // Parse YAML frontmatter — same lightweight parser as generate-news
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inline array: tags: ["a", "b"]
    const inlineArray = line.match(/^(\w[\w-]*):\s*\[([^\]]*)\]/);
    if (inlineArray) {
      frontmatter[inlineArray[1]] = inlineArray[2]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
      continue;
    }

    // Nested object start (e.g., internationalBenchmark:)
    const nestedKey = line.match(/^(\w[\w-]*):\s*$/);
    if (nestedKey) {
      const key = nestedKey[1];
      // Check if next lines are indented key-value pairs (nested object)
      const nested: Record<string, string> = {};
      let j = i + 1;
      let isNested = false;
      while (j < lines.length && /^\s+\w/.test(lines[j])) {
        const nestedMatch = lines[j].match(/^\s+(\w[\w-]*):\s+"?(.*?)"?\s*$/);
        if (nestedMatch) {
          nested[nestedMatch[1]] = nestedMatch[2];
          isNested = true;
        }
        // Check for block sequence items
        const seqMatch = lines[j].match(/^\s+-\s+"?(.*?)"?\s*$/);
        if (seqMatch && !isNested) {
          // This is a block array, not a nested object
          const items: string[] = [seqMatch[1]];
          j++;
          while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
            const m = lines[j].match(/^\s+-\s+"?(.*?)"?\s*$/);
            if (m) items.push(m[1]);
            j++;
          }
          frontmatter[key] = items;
          i = j - 1;
          break;
        }
        j++;
      }
      if (isNested && Object.keys(nested).length > 0) {
        frontmatter[key] = nested;
        i = j - 1;
        continue;
      }
      continue;
    }

    // Scalar with quotes: key: "value"
    const quotedScalar = line.match(/^(\w[\w-]*):\s+"(.*)"$/);
    if (quotedScalar) {
      frontmatter[quotedScalar[1]] = quotedScalar[2];
      continue;
    }

    // Boolean / number / unquoted scalar
    const scalarMatch = line.match(/^(\w[\w-]*):\s+(.+)$/);
    if (scalarMatch) {
      const key = scalarMatch[1];
      const val = scalarMatch[2].trim();
      if (val === 'true') frontmatter[key] = true;
      else if (val === 'false') frontmatter[key] = false;
      else if (/^\d+$/.test(val)) frontmatter[key] = parseInt(val, 10);
      else frontmatter[key] = val.replace(/^["']|["']$/g, '');
      continue;
    }
  }

  // Ensure required fields
  if (!frontmatter.title) frontmatter.title = 'Untitled';
  if (!frontmatter.publishDate) frontmatter.publishDate = new Date().toISOString().split('T')[0];
  if (!Array.isArray(frontmatter.tags)) frontmatter.tags = ['醫療永續'];
  if (!frontmatter.summary) frontmatter.summary = '';
  if (!frontmatter.category) frontmatter.category = category;
  if (forceDraft) frontmatter.draft = true;

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Save insight
// ---------------------------------------------------------------------------

function saveInsight(insight: GeneratedInsight): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const yamlStr = stringify(insight.frontmatter, { lineWidth: 0 });
  const content = `---\n${yamlStr}---\n\n${insight.body}\n`;

  const outputPath = join(OUTPUT_DIR, insight.filename);
  writeFileSync(outputPath, content, 'utf-8');
  console.log(`  [saved] ${insight.filename}${insight.isDraft ? ' (draft)' : ''}`);
}

// ---------------------------------------------------------------------------
// GitHub Actions output helper
// ---------------------------------------------------------------------------

function setGitHubOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
    console.log(`  [gha] Set output ${key}=${value}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvFile();

  // Check required API keys
  if (!process.env.TAVILY_API_KEY) {
    console.warn('[warn] TAVILY_API_KEY is not set. Exiting gracefully.');
    setGitHubOutput('has_drafts', 'false');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[warn] ANTHROPIC_API_KEY is not set. Exiting gracefully.');
    setGitHubOutput('has_drafts', 'false');
    return;
  }

  // Load config
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[error] Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config: InsightsConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

  // Load processed insights
  let processed: ProcessedInsights = { processedTopics: [], lastCategory: null, lastRun: null };
  if (existsSync(PROCESSED_PATH)) {
    processed = JSON.parse(readFileSync(PROCESSED_PATH, 'utf-8'));
  }

  console.log('[insights] Starting insights generation pipeline');
  console.log(`  Last category: ${processed.lastCategory ?? 'none'}`);
  console.log(`  Processed topics: ${processed.processedTopics.length}`);

  // Step 1: Determine next category
  const category = getNextCategory(
    config.categories.rotation,
    processed.lastCategory,
  );
  console.log(`\n[category] Next category: ${category}`);

  // Step 2: Search sources using category-specific strategy
  const strategy = config.categories.searchStrategies[category];
  console.log(`\n[search] Searching for ${category} sources...`);

  const allResults: TavilyResult[] = [];
  for (const query of strategy.queries) {
    console.log(`  Query: "${query}"`);
    const results = await searchTavily(
      query,
      strategy.preferredDomains,
      5,
    );
    console.log(`    Found ${results.length} result(s)`);
    allResults.push(...results);
    await delay(2000);
  }

  // Step 3: Dedup — filter out previously processed topics by URL
  const processedTopicSet = new Set(processed.processedTopics);
  const newResults = allResults.filter((r) => !processedTopicSet.has(r.url));
  console.log(`\n[dedup] Total: ${allResults.length}, New: ${newResults.length}`);

  if (newResults.length === 0) {
    console.log('[done] No new sources found. Nothing to generate.');
    setGitHubOutput('has_drafts', 'false');
    return;
  }

  // Step 4: Load cross-references
  const crossRefs = loadCrossReferences();
  console.log(`\n[crossref] Glossary terms: ${crossRefs.glossaryTerms.length}, Case studies: ${crossRefs.caseStudySlugs.length}`);

  // Step 5: Generate insight article (one per run)
  console.log(`\n[generate] Generating ${category} insight...`);

  // Use top sources (up to 5 most relevant)
  const topSources = newResults.slice(0, 5);
  let insight: GeneratedInsight;
  let hasDrafts = false;

  try {
    insight = await generateInsight(category, topSources, config, crossRefs);
    if (insight.isDraft) hasDrafts = true;
  } catch (err) {
    console.error(`[error] Failed to generate insight: ${(err as Error).message}`);
    setGitHubOutput('has_drafts', 'false');
    return;
  }

  // Step 6: Save insight
  console.log('\n[save] Saving insight...');
  saveInsight(insight);

  // Step 7: Update processed insights
  const newTopicUrls = topSources.map((s) => s.url);
  processed.processedTopics = [...processed.processedTopics, ...newTopicUrls];
  processed.lastCategory = category;
  processed.lastRun = new Date().toISOString();
  writeFileSync(PROCESSED_PATH, JSON.stringify(processed, null, 2), 'utf-8');
  console.log(`  Updated processed-insights.json (category: ${category})`);

  // Step 8: Set GitHub Actions output
  setGitHubOutput('has_drafts', hasDrafts ? 'true' : 'false');

  console.log(`\n[done] Generated 1 ${category} insight${hasDrafts ? ' (draft)' : ''}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
