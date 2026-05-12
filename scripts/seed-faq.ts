/**
 * seed-faq.ts
 * Generate 30-50 FAQ entries across 6 categories using Claude API.
 */

import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Load API key BEFORE importing ai.ts
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envFile = readFileSync('/Users/lightman/weiqi.kids/mohw-sustainability/.env', 'utf-8');
    const apiKey = envFile.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim();
    if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  } catch {
    console.error('ERROR: ANTHROPIC_API_KEY not set and .env file not found.');
    process.exit(1);
  }
}

// Dynamic imports — must come after env var is set
const { generateContent } = await import('./lib/ai.js');
const { writeContentFile, PROJECT_ROOT } = await import('./lib/fs-utils.js');

// ---------------------------------------------------------------------------
// Remove existing FAQ files
// ---------------------------------------------------------------------------
function removeExistingFaq(): void {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'faq');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      unlinkSync(join(dir, f));
      console.log(`  Removed: src/content/faq/${f}`);
    }
  } catch {
    // Directory may not exist yet
  }
}

// ---------------------------------------------------------------------------
// FAQ entry interface
// ---------------------------------------------------------------------------
interface FaqEntry {
  slug: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Generate FAQ entries for a category
// ---------------------------------------------------------------------------
async function generateCategoryFaq(
  category: string,
  categoryName: string,
  description: string,
): Promise<FaqEntry[]> {
  const prompt = `為國際醫療減碳協會網站撰寫「${categoryName}」類別的常見問題（FAQ），共 6 題。

類別代碼：${category}
類別說明：${description}

協會背景：
- 國際醫療減碳協會是非營利組織，所有服務免費
- 已服務 13 家國軍及榮民體系醫院
- 核心服務：碳盤查、能源管理系統、ESG 報告輔導、獎項申請、政府補助申請、健康台灣深耕計畫
- 已協助合作夥伴申請超過 5,900 萬元政府節能補助
- 多家醫院實現超過 15% 節能成效，最高達 42.99%

每題格式（以 JSON 陣列回傳，不要加 markdown code block）：
[
  {
    "slug": "kebab-case-slug-英文",
    "question": "問題（20-40字）",
    "answer": "答案（50-150字，引用協會服務與實績）",
    "category": "${category}",
    "order": 1
  }
]

注意：
- slug 使用英文 kebab-case，不要有中文
- 語言：繁體中文，台灣用語
- 答案要實用、具體，適當引用數據
- order 從 1 開始排序`;

  const raw = await generateContent(prompt);
  const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonStr);
}

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------
const CATEGORIES = [
  {
    category: 'general',
    name: '關於協會',
    description: '協會簡介、宗旨、服務範圍等一般問題',
  },
  {
    category: 'membership',
    name: '入會相關',
    description: '會員資格、入會流程、會費、會員權益',
  },
  {
    category: 'carbon-audit',
    name: '碳盤查相關',
    description: 'ISO 14064-1 碳盤查流程、費用、時程、認證',
  },
  {
    category: 'ems',
    name: '能源管理系統相關',
    description: 'EMS 系統、智慧電錶、節能監控、設備捐贈',
  },
  {
    category: 'esg',
    name: 'ESG 永續報告相關',
    description: 'ESG 報告撰寫、GRI 準則、永續發展委員會',
  },
  {
    category: 'subsidy',
    name: '政府補助相關',
    description: '政府節能補助、ESCO、空調汰換、申請流程',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Seeding FAQ...');

removeExistingFaq();

let totalWritten = 0;

for (const cat of CATEGORIES) {
  console.log(`\nGenerating: ${cat.name} (${cat.category})`);

  try {
    const entries = await generateCategoryFaq(
      cat.category,
      cat.name,
      cat.description,
    );

    for (const entry of entries) {
      // Validate category
      const validCategories = [
        'general',
        'membership',
        'carbon-audit',
        'ems',
        'esg',
        'subsidy',
      ];
      const safeCategory = validCategories.includes(entry.category)
        ? entry.category
        : cat.category;

      const frontmatter = {
        question: entry.question,
        answer: entry.answer,
        category: safeCategory,
        order: entry.order,
      };

      // Prefix slug with category to avoid collisions
      const slug = entry.slug.startsWith(cat.category)
        ? entry.slug
        : `${cat.category}-${entry.slug}`;

      writeContentFile('faq', slug, frontmatter, '');
      totalWritten++;
    }
  } catch (err) {
    console.error(`  ERROR generating FAQ for "${cat.name}":`, err);
  }

  // 1-second delay between API calls
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\nDone. ${totalWritten} FAQ entries generated.`);
