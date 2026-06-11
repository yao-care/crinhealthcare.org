/**
 * update-glossary.ts
 * Quarterly glossary refresh — adds 5-10 new ESG/carbon terms per quarter.
 *
 * Flow:
 * 1. Search for new ESG/carbon terminology via Tavily
 * 2. Compare against existing glossary slugs
 * 3. Generate definitions for new terms (target: 5-10 per quarter)
 * 4. Write to src/content/glossary/
 *
 * Usage:
 *   pnpm tsx scripts/update-glossary.ts
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Env validation — exit gracefully if keys missing
// ---------------------------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('INFO: ANTHROPIC_API_KEY not set — skipping glossary update.');
  process.exit(0);
}
if (!process.env.TAVILY_API_KEY) {
  console.log('INFO: TAVILY_API_KEY not set — skipping glossary update.');
  process.exit(0);
}

// Dynamic imports — must come after env var check
const { generateContent } = await import('./lib/ai.js');
const { writeContentFile, PROJECT_ROOT } = await import('./lib/fs-utils.js');

// ---------------------------------------------------------------------------
// Read existing glossary slugs
// ---------------------------------------------------------------------------
function getExistingSlugs(): Set<string> {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'glossary');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    return new Set(files.map((f) => f.replace(/\.md$/, '')));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Search for new ESG/carbon terms via Tavily
// ---------------------------------------------------------------------------
async function searchNewTerms(): Promise<string[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: 'new ESG carbon terminology 2026 medical healthcare sustainability',
      search_depth: 'advanced',
      max_results: 10,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    console.warn(`  Tavily search failed: ${response.status} — using fallback terms`);
    return [];
  }

  const data = await response.json() as { answer?: string; results?: Array<{ content: string }> };

  // Extract text from results to feed into Claude for term extraction
  const rawText = [
    data.answer || '',
    ...(data.results || []).map((r) => r.content),
  ].join('\n\n').slice(0, 8000);

  return [rawText];
}

// ---------------------------------------------------------------------------
// Ask Claude to identify new terms from search results
// ---------------------------------------------------------------------------
interface TermCandidate {
  term: string;
  slug: string;
  category: 'carbon' | 'energy' | 'esg' | 'policy' | 'certification';
}

async function extractNewTerms(
  searchText: string[],
  existingSlugs: Set<string>,
): Promise<TermCandidate[]> {
  const existingList = Array.from(existingSlugs).join(', ');
  const searchContext = searchText.join('\n\n') || '（無搜尋結果，請根據2026年最新ESG趨勢建議術語）';

  const prompt = `根據以下搜尋結果，找出 5-10 個適合加入醫療機構 ESG/碳管理詞彙表的新術語。

搜尋結果：
${searchContext}

現有術語 slug（不要重複）：
${existingList}

請回傳一個 JSON 陣列（不要加 markdown code block），每筆包含：
[
  {
    "term": "術語名稱（繁體中文或英文縮寫）",
    "slug": "kebab-case-english-slug",
    "category": "carbon | energy | esg | policy | certification"
  }
]

重要規則：
- slug 不能與現有術語重複
- 術語必須與醫療機構減碳、ESG、能源管理相關
- 優先選擇 2025-2026 年新興或重要性提升的術語
- 最多回傳 10 個術語`;

  const raw = await generateContent(prompt);
  const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const candidates: TermCandidate[] = JSON.parse(jsonStr);
    // Filter out any that already exist
    return candidates.filter((c) => !existingSlugs.has(c.slug));
  } catch (err) {
    console.error('  ERROR parsing term candidates:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Generate glossary entry for a term
// ---------------------------------------------------------------------------
interface GlossaryEntry {
  term: string;
  slug: string;
  definition: string;
  category: string;
  relatedTerms: string[];
  relatedServices: string[];
  body: string;
}

async function generateGlossaryEntry(candidate: TermCandidate): Promise<GlossaryEntry | null> {
  const prompt = `為以下術語撰寫詞彙表條目（面向台灣醫療機構管理者）：

術語：${candidate.term}
類別：${candidate.category}

請提供（JSON 格式，不要加 markdown code block）：
{
  "term": "${candidate.term}",
  "slug": "${candidate.slug}",
  "definition": "100-200字定義，面向醫療機構管理者",
  "category": "${candidate.category}",
  "relatedTerms": ["2-4個相關術語的 slug，使用常見 ESG 術語 slug"],
  "relatedServices": ["0-2個相關服務，從以下選擇：carbon-audit, ems, esg-report, awards, subsidies, health-taiwan"],
  "body": "50-100字補充說明"
}

語言：繁體中文，台灣用語`;

  try {
    const raw = await generateContent(prompt);
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring — 經資安負責人 2026-06-11 簽核判定為誤報：log 格式字串非使用者輸入，風險接受
    console.error(`  ERROR generating entry for "${candidate.term}":`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Quarterly glossary update starting...');

const existingSlugs = getExistingSlugs();
console.log(`  Existing glossary terms: ${existingSlugs.size}`);

console.log('  Searching for new ESG/carbon terminology...');
const searchResults = await searchNewTerms();

console.log('  Extracting new term candidates...');
const candidates = await extractNewTerms(searchResults, existingSlugs);

if (candidates.length === 0) {
  console.log('  No new terms identified — glossary is up to date.');
  process.exit(0);
}

console.log(`  Found ${candidates.length} new term candidates: ${candidates.map((c) => c.term).join(', ')}`);

let written = 0;
for (const candidate of candidates) {
  console.log(`\n  Generating: ${candidate.term}`);

  const entry = await generateGlossaryEntry(candidate);
  if (!entry) continue;

  const validCategories = ['carbon', 'energy', 'esg', 'policy', 'certification'];
  const safeCategory = validCategories.includes(entry.category) ? entry.category : candidate.category;

  const frontmatter = {
    term: entry.term,
    definition: entry.definition,
    category: safeCategory,
    relatedTerms: entry.relatedTerms || [],
    relatedServices: entry.relatedServices || [],
    draft: false,
  };

  writeContentFile('glossary', candidate.slug, frontmatter, entry.body || '');
  written++;

  // 1-second delay between API calls
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\nDone. ${written} new glossary terms added (${existingSlugs.size + written} total).`);
