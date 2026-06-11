/**
 * seed-case-studies.ts
 * Generate 13 hospital case study pages using Claude API.
 *
 * Sources:
 *   - 協會成果.md (hospital data table)
 *   - 國際醫療減碳協會服務內容說明.md (context)
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
// Hospital definitions
// ---------------------------------------------------------------------------
interface HospitalDef {
  slug: string;
  name: string;
  location: string;
  system: 'military' | 'veterans';
  services: string[];
  energySavingPercent: number;
  subsidyWan: number;
  certs: string[];
}

const HOSPITALS: HospitalDef[] = [
  {
    slug: 'ndmc-taoyuan',
    name: '國軍桃園總醫院',
    location: '桃園市',
    system: 'military',
    services: ['carbon-audit', 'ems', 'esg-report'],
    energySavingPercent: 25,
    subsidyWan: 560,
    certs: ['ISO 14064-1 113年度第三方認證', 'ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-kaohsiung',
    name: '國軍高雄總醫院',
    location: '高雄市',
    system: 'military',
    services: ['carbon-audit', 'ems', 'esg-report', 'awards'],
    energySavingPercent: 42.99,
    subsidyWan: 477,
    certs: ['ISO 14064-1 113年度第三方認證', 'ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-hualien',
    name: '國軍花蓮總醫院',
    location: '花蓮市',
    system: 'military',
    services: ['carbon-audit', 'ems'],
    energySavingPercent: 37,
    subsidyWan: 500,
    certs: ['ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-zuoying',
    name: '國軍左營總醫院',
    location: '高雄市',
    system: 'military',
    services: ['carbon-audit', 'ems'],
    energySavingPercent: 17.5,
    subsidyWan: 40,
    certs: ['ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-taichung',
    name: '國軍臺中總醫院',
    location: '台中市',
    system: 'military',
    services: ['carbon-audit', 'esg-report'],
    energySavingPercent: 0,
    subsidyWan: 0,
    certs: ['ISO 14064-1 113年度第三方認證', 'ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-university',
    name: '國防醫學大學',
    location: '台北市',
    system: 'military',
    services: ['carbon-audit'],
    energySavingPercent: 0,
    subsidyWan: 0,
    certs: ['ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'ndmc-gangshan',
    name: '國軍左營總醫院岡山分院',
    location: '高雄市',
    system: 'military',
    services: ['carbon-audit', 'ems'],
    energySavingPercent: 15,
    subsidyWan: 0,
    certs: [],
  },
  {
    slug: 'ndmc-hsinchu',
    name: '國軍桃園總醫院新竹分院',
    location: '新竹市',
    system: 'military',
    services: ['carbon-audit', 'ems'],
    energySavingPercent: 33,
    subsidyWan: 1500,
    certs: [],
  },
  {
    slug: 'tsgh-beitou',
    name: '三軍總醫院北投分院',
    location: '台北市',
    system: 'military',
    services: ['carbon-audit', 'ems'],
    energySavingPercent: 0,
    subsidyWan: 0,
    certs: [],
  },
  {
    slug: 'vghtc-chiayi',
    name: '臺中榮民總醫院嘉義分院',
    location: '嘉義市',
    system: 'veterans',
    services: ['carbon-audit', 'ems', 'esg-report'],
    energySavingPercent: 0,
    subsidyWan: 0,
    certs: ['ISO 14064-1 113年度第三方認證', 'ISO 14064-1 114年度第三方認證'],
  },
  {
    slug: 'vghtp-fenglin',
    name: '臺北榮民總醫院鳳林分院',
    location: '花蓮縣',
    system: 'veterans',
    services: ['carbon-audit'],
    energySavingPercent: 0,
    subsidyWan: 0,
    certs: [],
  },
  {
    slug: 'vghtp-yuli',
    name: '臺北榮民總醫院玉里分院',
    location: '花蓮縣',
    system: 'veterans',
    services: ['carbon-audit'],
    energySavingPercent: 0,
    subsidyWan: 500,
    certs: [],
  },
  {
    slug: 'vghtp-taitung',
    name: '臺北榮民總醫院臺東分院',
    location: '台東縣',
    system: 'veterans',
    services: ['carbon-audit'],
    energySavingPercent: 0,
    subsidyWan: 2441.9,
    certs: [],
  },
];

// ---------------------------------------------------------------------------
// Remove existing case study files
// ---------------------------------------------------------------------------
function removeExistingCaseStudies(): void {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'case-studies');
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      unlinkSync(join(dir, f));
      console.log(`  Removed: src/content/case-studies/${f}`);
    }
  } catch {
    // Directory may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Service slug to Chinese name mapping
// ---------------------------------------------------------------------------
const SERVICE_NAMES: Record<string, string> = {
  'carbon-audit': '公益 ISO 14064-1 碳盤查',
  ems: '主要迴路能源管理系統',
  'esg-report': '輔導 ESG 永續報告書',
  awards: '永續暨節能減碳獎項申請',
  subsidies: '政府補助計畫申請',
  'health-taiwan': '健康台灣深耕計畫',
};

// ---------------------------------------------------------------------------
// Generate a single case study
// ---------------------------------------------------------------------------
async function generateCaseStudy(hospital: HospitalDef): Promise<void> {
  const serviceNames = hospital.services
    .map((s) => SERVICE_NAMES[s] || s)
    .join('、');
  const certsStr =
    hospital.certs.length > 0 ? hospital.certs.join('、') : '尚未取得認證';

  const prompt = `根據以下醫院合作數據，撰寫一篇 800-1200 字的案例故事。

醫院：${hospital.name}
地點：${hospital.location}
體系：${hospital.system === 'military' ? '國軍體系' : '榮民體系'}
合作服務：${serviceNames}
節能成效：${hospital.energySavingPercent}%
申請補助金額：${hospital.subsidyWan}萬元
認證：${certsStr}

請包含以下章節（使用 ## 標題）：
1. 合作背景 — 醫院簡介、為何與協會合作
2. 面臨挑戰 — 醫療機構在減碳方面的挑戰
3. 解決方案 — 協會提供了哪些服務
4. 具體成果 — 引用上述數據
5. 未來展望 — 下一步計畫

重要規則：
- 引用實際數據，不要編造未提供的數據
- 如果節能成效為 0%，表示尚在執行初期，不要提及具體節能百分比
- 如果補助金額為 0，表示尚未申請補助，不要提及補助金額
- 語言：繁體中文，台灣用語
- 回傳純 Markdown，不要包裝在 JSON 或 code block 中
- 同時在第一行回傳一個 50-80 字的摘要，格式為 SUMMARY: 摘要內容`;

  try {
    const raw = await generateContent(prompt);

    // Extract summary
    let summary = '';
    let body = raw;
    const summaryMatch = raw.match(/^SUMMARY:\s*(.+?)(?:\n|$)/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      body = raw.slice(summaryMatch[0].length).trim();
    } else {
      // Fallback summary
      summary = `${hospital.name}與國際醫療減碳協會合作，推動${serviceNames}等服務。`;
    }

    // Build tags (no slash characters)
    const tags: string[] = [];
    if (hospital.system === 'military') tags.push('國軍醫院');
    if (hospital.system === 'veterans') tags.push('榮民醫院');
    tags.push('碳盤查');
    if (hospital.services.includes('ems')) tags.push('能源管理');
    if (hospital.services.includes('esg-report')) tags.push('ESG');
    if (hospital.energySavingPercent > 0) tags.push('節能成效');
    if (hospital.subsidyWan > 0) tags.push('政府補助');

    const frontmatter: Record<string, unknown> = {
      hospital: {
        name: hospital.name,
        location: hospital.location,
        system: hospital.system,
      },
      publishDate: '2026-03-20',
      tags,
      summary,
      services: hospital.services,
      metrics: {
        energySavingPercent: hospital.energySavingPercent || undefined,
        subsidyAmount: hospital.subsidyWan > 0 ? hospital.subsidyWan * 10000 : undefined,
        certifications: hospital.certs,
      },
      draft: false,
    };

    writeContentFile('case-studies', hospital.slug, frontmatter, body);
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring — 經資安負責人 2026-06-11 簽核判定為誤報：log 格式字串非使用者輸入，風險接受
    console.error(`  ERROR generating case study for "${hospital.name}":`, err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Seeding case studies...');

removeExistingCaseStudies();

for (const hospital of HOSPITALS) {
  console.log(`\nGenerating: ${hospital.name}`);
  await generateCaseStudy(hospital);
  // 1-second delay between API calls
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\nDone. ${HOSPITALS.length} case studies generated.`);
