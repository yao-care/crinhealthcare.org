#!/usr/bin/env node
/**
 * generate-news.ts
 * Automated news generation pipeline for crinhealthcare.org
 *
 * Flow:
 * 1. Load config from data/news-config.json
 * 2. Search for news sources via Tavily API
 * 3. Dedup against data/processed-sources.json
 * 4. Group related results by topic
 * 5. Generate articles via Claude API with reviewer loop
 * 6. Save markdown to src/content/news/
 * 7. Update processed-sources.json
 *
 * Usage:
 *   pnpm tsx scripts/generate-news.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateContent } from './lib/ai.js';
import { stringify } from 'yaml';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'data', 'news-config.json');
const PROCESSED_PATH = join(PROJECT_ROOT, 'data', 'processed-sources.json');
const OUTPUT_DIR = join(PROJECT_ROOT, 'src', 'content', 'news');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NewsConfig {
  webSearch: {
    queries: string[];
    preferredDomains: string[];
    maxResultsPerQuery: number;
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

interface ProcessedSources {
  processedUrls: string[];
  lastRun: string | null;
}

interface TavilyResult {
  url: string;
  title: string;
  content: string;
  score?: number;
}

interface SourceGroup {
  topic: string;
  sources: TavilyResult[];
}

interface GeneratedArticle {
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
  isDraft: boolean;
  sourceUrls: string[];
}

// ---------------------------------------------------------------------------
// .env file loader (for local development)
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
      search_depth: 'basic',
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
// Dedup
// ---------------------------------------------------------------------------

function dedup(
  results: TavilyResult[],
  processedUrls: Set<string>,
): TavilyResult[] {
  return results.filter((r) => !processedUrls.has(r.url));
}

// ---------------------------------------------------------------------------
// Grouping — cluster results by keyword overlap in title
// ---------------------------------------------------------------------------

function groupResults(results: TavilyResult[]): SourceGroup[] {
  if (results.length === 0) return [];

  const used = new Set<number>();
  const groups: SourceGroup[] = [];

  for (let i = 0; i < results.length; i++) {
    if (used.has(i)) continue;
    const group: TavilyResult[] = [results[i]];
    used.add(i);

    // Find related results based on title word overlap
    const titleWordsI = new Set(
      results[i].title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    for (let j = i + 1; j < results.length; j++) {
      if (used.has(j)) continue;
      const titleWordsJ = results[j].title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const overlap = titleWordsJ.filter((w) => titleWordsI.has(w)).length;
      // Require at least 2 shared meaningful words
      if (overlap >= 2) {
        group.push(results[j]);
        used.add(j);
      }
    }

    groups.push({
      topic: results[i].title,
      sources: group,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Article generation with reviewer loop
// ---------------------------------------------------------------------------

async function generateArticle(
  group: SourceGroup,
  config: NewsConfig,
): Promise<GeneratedArticle> {
  const { generation, output } = config;

  // Build source context
  const sourceContext = group.sources
    .map(
      (s, i) =>
        `來源 ${i + 1}:\n標題: ${s.title}\n網址: ${s.url}\n摘要: ${s.content}`,
    )
    .join('\n\n');

  const prompt = `根據以下新聞來源，撰寫一篇醫療減碳新聞稿。

${sourceContext}

請以下列 YAML frontmatter + Markdown 格式輸出（不要加 \`\`\` 代碼區塊標記）：

---
title: "標題"
source: "來源名稱"
sourceUrl: "主要來源網址"
publishDate: ${new Date().toISOString().split('T')[0]}
tags: ["標籤1", "標籤2"]
summary: "50-80字摘要"
editorComment: "100-150字編輯評論"
editorPick: false
draft: false
---

## 小節標題一

正文內容...

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
      // Regenerate with reviewer feedback
      articleContent = await generateContent(
        `請根據以下審核意見修改新聞稿：\n\n審核意見：\n${reviewerFeedback}\n\n原始新聞稿：\n${articleContent}\n\n請輸出完整修改後的新聞稿（含 YAML frontmatter），不要加 \`\`\` 代碼區塊標記。`,
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
      '你是專業的新聞品質審核員。',
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
  const parsed = parseGeneratedArticle(articleContent, isDraft);

  // Generate filename
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('-');
  // Add a sequence suffix based on group topic hash to avoid collisions
  const hash = simpleHash(group.topic);
  const filename = `${output.filenamePrefix}-${timestamp}-${hash}.md`;

  return {
    filename,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    isDraft,
    sourceUrls: group.sources.map((s) => s.url),
  };
}

// ---------------------------------------------------------------------------
// Parse generated article (extract frontmatter + body)
// ---------------------------------------------------------------------------

interface ParsedArticle {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseGeneratedArticle(content: string, forceDraft: boolean): ParsedArticle {
  // Strip code block markers if AI wrapped output
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }

  // Extract frontmatter between --- delimiters
  const fmMatch = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!fmMatch) {
    // Fallback: treat entire content as body
    return {
      frontmatter: {
        title: 'Untitled',
        source: '協會編輯室',
        publishDate: new Date().toISOString().split('T')[0],
        tags: ['醫療永續'],
        summary: '',
        draft: true,
      },
      body: cleaned,
    };
  }

  const yamlStr = fmMatch[1];
  const body = fmMatch[2].trim();

  // Parse YAML frontmatter manually (lightweight, no dependency on yaml.parse for untrusted input)
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

    // Block sequence: key:\n  - item
    const blockKey = line.match(/^(\w[\w-]*):\s*$/);
    if (blockKey) {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^\s+-\s+/)) {
        items.push(lines[j].replace(/^\s+-\s+"?/, '').replace(/"?\s*$/, '').trim());
        j++;
      }
      if (items.length > 0) {
        frontmatter[blockKey[1]] = items;
        i = j - 1;
      }
    }
  }

  // Ensure required fields
  if (!frontmatter.title) frontmatter.title = 'Untitled';
  if (!frontmatter.source) frontmatter.source = '協會編輯室';
  if (!frontmatter.publishDate) frontmatter.publishDate = new Date().toISOString().split('T')[0];
  if (!Array.isArray(frontmatter.tags)) frontmatter.tags = ['醫療永續'];
  if (!frontmatter.summary) frontmatter.summary = '';
  if (forceDraft) frontmatter.draft = true;

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Simple hash for filename uniqueness
// ---------------------------------------------------------------------------

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Save article to markdown file
// ---------------------------------------------------------------------------

function saveArticle(article: GeneratedArticle): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const yamlStr = stringify(article.frontmatter, { lineWidth: 0 });
  const content = `---\n${yamlStr}---\n\n${article.body}\n`;

  const outputPath = join(OUTPUT_DIR, article.filename);
  writeFileSync(outputPath, content, 'utf-8');
  console.log(`  [saved] ${article.filename}${article.isDraft ? ' (draft)' : ''}`);
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
  const config: NewsConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

  // Load processed sources
  let processed: ProcessedSources = { processedUrls: [], lastRun: null };
  if (existsSync(PROCESSED_PATH)) {
    processed = JSON.parse(readFileSync(PROCESSED_PATH, 'utf-8'));
  }
  const processedUrls = new Set(processed.processedUrls);

  console.log('[news] Starting news generation pipeline');
  console.log(`  Processed URLs in history: ${processedUrls.size}`);

  // Step 1: Search for sources via Tavily
  console.log('\n[search] Searching for news sources...');
  const allResults: TavilyResult[] = [];

  for (const query of config.webSearch.queries) {
    console.log(`  Query: "${query}"`);
    const results = await searchTavily(
      query,
      config.webSearch.preferredDomains,
      config.webSearch.maxResultsPerQuery,
    );
    console.log(`    Found ${results.length} result(s)`);
    allResults.push(...results);
    await delay(2000);
  }

  // Step 2: Dedup
  console.log(`\n[dedup] Total results: ${allResults.length}`);
  const newResults = dedup(allResults, processedUrls);
  console.log(`  After dedup: ${newResults.length} new result(s)`);

  if (newResults.length === 0) {
    console.log('[done] No new sources found. Nothing to generate.');
    setGitHubOutput('has_drafts', 'false');
    return;
  }

  // Step 3: Group related results
  console.log('\n[group] Grouping related results...');
  const groups = groupResults(newResults);
  console.log(`  Created ${groups.length} group(s)`);

  // Step 4: Generate articles
  console.log('\n[generate] Generating articles...');
  const articles: GeneratedArticle[] = [];
  let hasDrafts = false;

  // Limit to 3 articles per run to control API costs
  const maxArticlesPerRun = 3;
  const groupsToProcess = groups.slice(0, maxArticlesPerRun);

  for (const group of groupsToProcess) {
    console.log(`\n  [article] Topic: "${group.topic}" (${group.sources.length} source(s))`);
    try {
      const article = await generateArticle(group, config);
      articles.push(article);
      if (article.isDraft) hasDrafts = true;
    } catch (err) {
      console.error(`  [error] Failed to generate article: ${(err as Error).message}`);
    }
  }

  // Step 5: Save articles
  console.log('\n[save] Saving articles...');
  for (const article of articles) {
    saveArticle(article);
  }

  // Step 6: Update processed sources
  const allNewUrls = articles.flatMap((a) => a.sourceUrls);
  // Also mark URLs from groups we processed but failed to generate
  for (const group of groupsToProcess) {
    for (const source of group.sources) {
      if (!allNewUrls.includes(source.url)) {
        allNewUrls.push(source.url);
      }
    }
  }

  processed.processedUrls = [...processedUrls, ...allNewUrls];
  processed.lastRun = new Date().toISOString();
  writeFileSync(PROCESSED_PATH, JSON.stringify(processed, null, 2), 'utf-8');
  console.log(`  Updated processed-sources.json (${processed.processedUrls.length} total URLs)`);

  // Step 7: Set GitHub Actions output
  setGitHubOutput('has_drafts', hasDrafts ? 'true' : 'false');

  console.log(`\n[done] Generated ${articles.length} article(s), ${hasDrafts ? 'some are drafts' : 'all approved'}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
