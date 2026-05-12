/**
 * update-faq.ts
 * Quarterly FAQ refresh — adds 3-5 new Q&A pairs per quarter.
 *
 * Flow:
 * 1. Search for common questions about medical ESG/carbon audit via Tavily
 * 2. Compare against existing FAQ slugs
 * 3. Generate 3-5 new Q&A pairs
 * 4. Write to src/content/faq/
 *
 * Usage:
 *   pnpm tsx scripts/update-faq.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Env validation — exit gracefully if keys missing
// ---------------------------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('INFO: ANTHROPIC_API_KEY not set — skipping FAQ update.');
  process.exit(0);
}
if (!process.env.TAVILY_API_KEY) {
  console.log('INFO: TAVILY_API_KEY not set — skipping FAQ update.');
  process.exit(0);
}

// Dynamic imports — must come after env var check
const { generateContent } = await import('./lib/ai.js');
const { writeContentFile, PROJECT_ROOT } = await import('./lib/fs-utils.js');

// ---------------------------------------------------------------------------
// Read existing FAQ slugs and questions
// ---------------------------------------------------------------------------
function getExistingFaq(): { slugs: Set<string>; questions: string[] } {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'faq');
  const slugs = new Set<string>();
  const questions: string[] = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      slugs.add(f.replace(/\.md$/, ''));
      // Extract question from frontmatter
      const content = readFileSync(join(dir, f), 'utf-8');
      const match = content.match(/^question:\s*(.+)$/m);
      if (match) questions.push(match[1].trim());
    }
  } catch {
    // Directory may not exist yet
  }

  return { slugs, questions };
}

// ---------------------------------------------------------------------------
// Search for common medical ESG questions via Tavily
// ---------------------------------------------------------------------------
async function searchCommonQuestions(): Promise<string> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: 'common questions medical hospital ESG carbon audit sustainability Taiwan 2026',
      search_depth: 'advanced',
      max_results: 8,
      include_answer: true,
    }),
  });

  if (!response.ok) {
    console.warn(`  Tavily search failed: ${response.status} — using Claude's knowledge`);
    return '';
  }

  const data = await response.json() as { answer?: string; results?: Array<{ content: string }> };

  return [
    data.answer || '',
    ...(data.results || []).map((r) => r.content),
  ].join('\n\n').slice(0, 6000);
}

// ---------------------------------------------------------------------------
// Generate new FAQ entries
// ---------------------------------------------------------------------------
interface FaqEntry {
  slug: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

async function generateNewFaqEntries(
  searchContext: string,
  existingQuestions: string[],
  existingSlugs: Set<string>,
): Promise<FaqEntry[]> {
  const existingQList = existingQuestions.slice(0, 20).map((q, i) => `${i + 1}. ${q}`).join('\n');
  const context = searchContext || '（無搜尋結果，請根據台灣醫療機構減碳常見問題生成）';

  const prompt = `根據以下參考資料，為國際醫療減碳協會網站生成 3-5 個新的常見問題（FAQ），不能與現有問題重複。

參考資料：
${context}

現有問題（不要重複）：
${existingQList}

協會背景：
- 國際醫療減碳協會，非營利組織，所有服務免費
- 已服務 13 家國軍及榮民體系醫院
- 核心服務：碳盤查（ISO 14064-1）、能源管理系統、ESG 報告輔導、獎項申請、政府補助申請
- 已協助申請超過 5,900 萬元政府節能補助
- 多家醫院節能超過 15%，最高達 42.99%

請回傳 JSON 陣列（不要加 markdown code block），3-5 個新問題：
[
  {
    "slug": "kebab-case-english-slug",
    "question": "問題（20-40字）",
    "answer": "答案（50-150字，引用協會服務與實績）",
    "category": "general | membership | carbon-audit | ems | esg | subsidy",
    "order": 10
  }
]

重要規則：
- slug 使用英文 kebab-case，需包含 category 前綴（如 carbon-audit-xxx）
- 問題必須是真實醫療機構管理者會問的問題
- 答案要具體實用，適當引用數據
- 語言：繁體中文，台灣用語`;

  const raw = await generateContent(prompt);
  const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const entries: FaqEntry[] = JSON.parse(jsonStr);
    // Filter out any with duplicate slugs
    return entries.filter((e) => !existingSlugs.has(e.slug));
  } catch (err) {
    console.error('  ERROR parsing FAQ entries:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Quarterly FAQ update starting...');

const { slugs: existingSlugs, questions: existingQuestions } = getExistingFaq();
console.log(`  Existing FAQ entries: ${existingSlugs.size}`);

console.log('  Searching for common medical ESG/carbon questions...');
const searchContext = await searchCommonQuestions();

console.log('  Generating new FAQ entries...');
const newEntries = await generateNewFaqEntries(searchContext, existingQuestions, existingSlugs);

if (newEntries.length === 0) {
  console.log('  No new FAQ entries generated — FAQ is up to date.');
  process.exit(0);
}

console.log(`  Generated ${newEntries.length} new FAQ entries`);

const validCategories = ['general', 'membership', 'carbon-audit', 'ems', 'esg', 'subsidy'];
let written = 0;

for (const entry of newEntries) {
  const safeCategory = validCategories.includes(entry.category) ? entry.category : 'general';

  // Ensure slug has category prefix
  const slug = entry.slug.startsWith(safeCategory)
    ? entry.slug
    : `${safeCategory}-${entry.slug}`;

  // Avoid collisions after prefix normalization
  if (existingSlugs.has(slug)) {
    console.log(`  Skipping duplicate slug: ${slug}`);
    continue;
  }

  const frontmatter = {
    question: entry.question,
    answer: entry.answer,
    category: safeCategory,
    order: entry.order || 10,
  };

  writeContentFile('faq', slug, frontmatter, '');
  written++;
}

console.log(`\nDone. ${written} new FAQ entries added (${existingSlugs.size + written} total).`);
