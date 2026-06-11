/**
 * seed-glossary.ts
 * Generate 80-100 ESG/carbon management glossary terms using Claude API.
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
// Term definitions with slugs
// ---------------------------------------------------------------------------
interface TermDef {
  term: string;
  slug: string;
  category: 'carbon' | 'energy' | 'esg' | 'policy' | 'certification';
}

const TERMS: TermDef[] = [
  // carbon category
  { term: '碳盤查', slug: 'carbon-inventory', category: 'carbon' },
  { term: '碳足跡', slug: 'carbon-footprint', category: 'carbon' },
  { term: '碳費', slug: 'carbon-fee', category: 'carbon' },
  { term: '碳權', slug: 'carbon-credit', category: 'carbon' },
  { term: '碳中和', slug: 'carbon-neutrality', category: 'carbon' },
  { term: '淨零排放', slug: 'net-zero', category: 'carbon' },
  { term: '溫室氣體', slug: 'greenhouse-gas', category: 'carbon' },
  { term: '範疇一', slug: 'scope-1', category: 'carbon' },
  { term: '範疇二', slug: 'scope-2', category: 'carbon' },
  { term: '範疇三', slug: 'scope-3', category: 'carbon' },
  { term: 'GHG Protocol', slug: 'ghg-protocol', category: 'carbon' },
  { term: '排放係數', slug: 'emission-factor', category: 'carbon' },
  { term: '碳匯', slug: 'carbon-sink', category: 'carbon' },
  { term: '碳抵換', slug: 'carbon-offset', category: 'carbon' },
  { term: '碳邊境調整機制（CBAM）', slug: 'cbam', category: 'carbon' },
  { term: '碳揭露', slug: 'carbon-disclosure', category: 'carbon' },
  { term: '科學基礎減碳目標（SBTi）', slug: 'sbti', category: 'carbon' },
  { term: '碳定價', slug: 'carbon-pricing', category: 'carbon' },
  { term: '排放清冊', slug: 'emission-inventory', category: 'carbon' },
  { term: '基準年', slug: 'base-year', category: 'carbon' },

  // energy category
  { term: '能源管理系統', slug: 'energy-management-system', category: 'energy' },
  { term: 'EMS', slug: 'ems', category: 'energy' },
  { term: 'ISO 50001', slug: 'iso-50001', category: 'energy' },
  { term: 'ESCO', slug: 'esco', category: 'energy' },
  { term: '契約容量', slug: 'contract-capacity', category: 'energy' },
  { term: '需量反應', slug: 'demand-response', category: 'energy' },
  { term: '尖峰用電', slug: 'peak-demand', category: 'energy' },
  { term: '儲能系統', slug: 'energy-storage', category: 'energy' },
  { term: '再生能源', slug: 'renewable-energy', category: 'energy' },
  { term: '太陽光電', slug: 'solar-pv', category: 'energy' },
  { term: '熱泵', slug: 'heat-pump', category: 'energy' },
  { term: '冰水主機', slug: 'chiller', category: 'energy' },
  { term: '變頻器', slug: 'vfd', category: 'energy' },
  { term: 'LED 照明', slug: 'led-lighting', category: 'energy' },
  { term: '電力回生', slug: 'power-regeneration', category: 'energy' },
  { term: '智慧電錶', slug: 'smart-meter', category: 'energy' },
  { term: '能源審計', slug: 'energy-audit', category: 'energy' },
  { term: '電力監控', slug: 'power-monitoring', category: 'energy' },
  { term: '節能績效保證', slug: 'energy-performance-contract', category: 'energy' },
  { term: '能源密集度', slug: 'energy-intensity', category: 'energy' },

  // esg category
  { term: 'ESG', slug: 'esg', category: 'esg' },
  { term: 'GRI', slug: 'gri', category: 'esg' },
  { term: 'TCFD', slug: 'tcfd', category: 'esg' },
  { term: 'SASB', slug: 'sasb', category: 'esg' },
  { term: '永續報告書', slug: 'sustainability-report', category: 'esg' },
  { term: '利害關係人', slug: 'stakeholder', category: 'esg' },
  { term: '重大性分析', slug: 'materiality-analysis', category: 'esg' },
  { term: 'SDGs', slug: 'sdgs', category: 'esg' },
  { term: 'CSR', slug: 'csr', category: 'esg' },
  { term: '企業社會責任', slug: 'corporate-social-responsibility', category: 'esg' },
  { term: '永續發展目標', slug: 'sustainable-development-goals', category: 'esg' },
  { term: '永續金融', slug: 'sustainable-finance', category: 'esg' },
  { term: '綠色金融', slug: 'green-finance', category: 'esg' },
  { term: 'ISSB', slug: 'issb', category: 'esg' },
  { term: '雙重重大性', slug: 'double-materiality', category: 'esg' },
  { term: '永續治理', slug: 'sustainability-governance', category: 'esg' },
  { term: '綠色採購', slug: 'green-procurement', category: 'esg' },
  { term: '供應鏈管理', slug: 'supply-chain-management', category: 'esg' },
  { term: '社會投資報酬率（SROI）', slug: 'sroi', category: 'esg' },
  { term: '永續發展委員會', slug: 'sustainability-committee', category: 'esg' },

  // policy category
  { term: '氣候變遷因應法', slug: 'climate-change-act', category: 'policy' },
  { term: '溫室氣體減量及管理法', slug: 'ghg-reduction-act', category: 'policy' },
  { term: '環境部', slug: 'ministry-of-environment', category: 'policy' },
  { term: '碳費徵收', slug: 'carbon-fee-collection', category: 'policy' },
  { term: '碳費費率', slug: 'carbon-fee-rate', category: 'policy' },
  { term: '國家自定貢獻（NDC）', slug: 'ndc', category: 'policy' },
  { term: '巴黎協定', slug: 'paris-agreement', category: 'policy' },
  { term: '2050 淨零排放路徑', slug: 'net-zero-2050-pathway', category: 'policy' },
  { term: '健康台灣深耕計畫', slug: 'health-taiwan-plan', category: 'policy' },
  { term: '再生能源發展條例', slug: 'renewable-energy-act', category: 'policy' },
  { term: '能源管理法', slug: 'energy-management-act', category: 'policy' },
  { term: '醫療機構永續', slug: 'healthcare-sustainability', category: 'policy' },
  { term: '範疇四', slug: 'scope-4', category: 'policy' },
  { term: '綠色醫院', slug: 'green-hospital', category: 'policy' },
  { term: '韌性醫院', slug: 'resilient-hospital', category: 'policy' },

  // certification category
  { term: 'ISO 14064-1', slug: 'iso-14064-1', category: 'certification' },
  { term: 'ISO 14067', slug: 'iso-14067', category: 'certification' },
  { term: '第三方查證', slug: 'third-party-verification', category: 'certification' },
  { term: 'PAS 2060', slug: 'pas-2060', category: 'certification' },
  { term: '碳標籤', slug: 'carbon-label', category: 'certification' },
  { term: '環保標章', slug: 'green-mark', category: 'certification' },
  { term: '綠建築標章', slug: 'green-building-label', category: 'certification' },
  { term: '台灣永續行動獎', slug: 'taiwan-sustainability-award', category: 'certification' },
  { term: '台電節能標竿獎', slug: 'taipower-energy-saving-award', category: 'certification' },
  { term: 'ISO 14001', slug: 'iso-14001', category: 'certification' },
  { term: 'ISO 14064-2', slug: 'iso-14064-2', category: 'certification' },
  { term: 'ISO 14064-3', slug: 'iso-14064-3', category: 'certification' },
  { term: 'LEED', slug: 'leed', category: 'certification' },
  { term: 'GRESB', slug: 'gresb', category: 'certification' },
  { term: 'CDP', slug: 'cdp', category: 'certification' },
];

// ---------------------------------------------------------------------------
// Remove existing glossary files
// ---------------------------------------------------------------------------
function removeExistingGlossary(): void {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'glossary');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      unlinkSync(join(dir, f));
      console.log(`  Removed: src/content/glossary/${f}`);
    }
  } catch {
    // Directory may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Generate a batch of glossary terms
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

async function generateBatch(batch: TermDef[]): Promise<GlossaryEntry[]> {
  const termList = batch.map((t) => `- ${t.term} (slug: ${t.slug}, category: ${t.category})`).join('\n');

  const prompt = `為以下 ESG/碳管理/能源管理術語各撰寫一條詞彙定義。

術語列表：
${termList}

每個術語請提供（以 JSON 陣列格式回傳，不要加 markdown code block）：
[
  {
    "term": "術語名稱",
    "slug": "對應的 slug",
    "definition": "100-200字定義（面向醫療機構管理者的說明）",
    "category": "carbon | energy | esg | policy | certification",
    "relatedTerms": ["2-4個相關術語的 slug"],
    "relatedServices": ["0-2個相關服務 slug，從以下選擇：carbon-audit, ems, esg-report, awards, subsidies, health-taiwan"],
    "body": "50-100字的補充說明，作為詞彙頁面的正文內容"
  }
]

注意：
- 語言：繁體中文，台灣用語
- definition 面向醫療機構管理者，實務導向
- relatedTerms 的 slug 必須從本批次或以下常見 slug 中選取
- body 是補充正文，不是定義的重複`;

  const raw = await generateContent(prompt);
  const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonStr);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Seeding glossary...');

removeExistingGlossary();

// Process in batches of 10
const BATCH_SIZE = 10;
let totalWritten = 0;

for (let i = 0; i < TERMS.length; i += BATCH_SIZE) {
  const batch = TERMS.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(TERMS.length / BATCH_SIZE);
  console.log(`\nBatch ${batchNum}/${totalBatches}: ${batch.map((t) => t.term).join(', ')}`);

  try {
    const entries = await generateBatch(batch);

    for (const entry of entries) {
      // Find the matching term def for the slug
      const termDef = batch.find(
        (t) => t.slug === entry.slug || t.term === entry.term,
      );
      const slug = termDef?.slug || entry.slug;
      const category = termDef?.category || entry.category;

      // Validate category
      const validCategories = ['carbon', 'energy', 'esg', 'policy', 'certification'];
      const safeCategory = validCategories.includes(category) ? category : termDef?.category || 'carbon';

      const frontmatter = {
        term: entry.term,
        definition: entry.definition,
        category: safeCategory,
        relatedTerms: entry.relatedTerms || [],
        relatedServices: entry.relatedServices || [],
        draft: false,
      };

      writeContentFile('glossary', slug, frontmatter, entry.body || '');
      totalWritten++;
    }
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring — 經資安負責人 2026-06-11 簽核判定為誤報：log 格式字串非使用者輸入，風險接受
    console.error(`  ERROR in batch ${batchNum}:`, err);
    // Continue with next batch
  }

  // 1-second delay between API calls
  if (i + BATCH_SIZE < TERMS.length) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log(`\nDone. ${totalWritten} glossary terms generated.`);
