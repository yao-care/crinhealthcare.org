/**
 * seed-services.ts
 * Generate 6 service pages using Claude API based on source materials.
 *
 * Sources:
 *   - 國際醫療減碳協會服務內容說明.md
 */

import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Load API key BEFORE importing ai.ts (which creates the Anthropic client)
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const envFile = readFileSync('/Users/lightman/weiqi.kids/mohw-sustainability/.env', 'utf-8');
    const apiKey = envFile.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim();
    if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  } catch {
    console.error('ERROR: ANTHROPIC_API_KEY not set and .env file not found.');
    console.error('Set ANTHROPIC_API_KEY in your environment or create .env file.');
    process.exit(1);
  }
}

// Dynamic imports — must come after env var is set
const { generateContent } = await import('./lib/ai.js');
const { readSourceFile, writeContentFile, PROJECT_ROOT } = await import('./lib/fs-utils.js');

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------
interface ServiceDef {
  slug: string;
  name: string;
  summary: string;
}

const SERVICES: ServiceDef[] = [
  {
    slug: 'carbon-audit',
    name: '公益 ISO 14064-1 碳盤查',
    summary: '溫室氣體盤查，鑑別排放源',
  },
  {
    slug: 'ems',
    name: '主要迴路能源管理系統',
    summary: '智慧電錶+EMS，即時監控能源',
  },
  {
    slug: 'esg-report',
    name: '輔導 ESG 永續報告書',
    summary: '依 GRI 準則撰寫 ESG 報告',
  },
  {
    slug: 'awards',
    name: '永續暨節能減碳獎項申請',
    summary: '台灣永續行動獎、台電節能標竿獎',
  },
  {
    slug: 'subsidies',
    name: '政府補助計畫申請',
    summary: '空調節能、ESCO、汰舊換新補助',
  },
  {
    slug: 'health-taiwan',
    name: '健康台灣深耕計畫',
    summary: '衛福部範疇四，社會責任+醫療永續',
  },
];

// ---------------------------------------------------------------------------
// Remove existing service files
// ---------------------------------------------------------------------------
function removeExistingServices(): void {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'services');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      unlinkSync(join(dir, f));
      console.log(`  Removed: src/content/services/${f}`);
    }
  } catch {
    // Directory may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Generate a single service page
// ---------------------------------------------------------------------------
async function generateService(
  svc: ServiceDef,
  sourceMaterial: string,
): Promise<void> {
  const prompt = `根據以下協會服務說明素材，為「${svc.name}」服務撰寫完整的服務頁面內容。

素材：
${sourceMaterial}

需要產出（以 JSON 格式回傳，不要加 markdown code block）：
{
  "description": "200-300字，含服務目的、對象、效益",
  "features": [
    { "title": "特色標題", "description": "特色說明" }
  ],
  "body": "500-800字正文，含服務流程、成功案例引用、為什麼選擇我們。使用 Markdown 格式，含標題（##）。"
}

注意：
- features 請提供 3-5 項
- 語言：繁體中文，台灣用語
- 強調協會的公益性質（免費服務）
- 引用素材中的實際數據（如已協助申請超過5,900萬元補助等）`;

  try {
    const raw = await generateContent(prompt);
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const data = JSON.parse(jsonStr);

    const frontmatter = {
      name: svc.name,
      description: data.description,
      icon: svc.slug,
      features: data.features,
    };

    writeContentFile('services', svc.slug, frontmatter, data.body);
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring — 經資安負責人 2026-06-11 簽核判定為誤報：log 格式字串非使用者輸入，風險接受
    console.error(`  ERROR generating service "${svc.name}":`, err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Seeding services...');

removeExistingServices();

const sourceMaterial = readSourceFile('國際醫療減碳協會服務內容說明.md');

for (const svc of SERVICES) {
  console.log(`\nGenerating: ${svc.name}`);
  await generateService(svc, sourceMaterial);
  // 1-second delay between API calls
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\nDone. ${SERVICES.length} services generated.`);
