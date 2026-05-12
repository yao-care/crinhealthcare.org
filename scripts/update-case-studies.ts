/**
 * update-case-studies.ts
 * Annual case study review — searches for updates on partner hospitals
 * and generates draft updates requiring human review.
 *
 * Flow:
 * 1. Read existing case-studies to get hospital names
 * 2. Search for updates about partner hospitals via Tavily
 * 3. Generate updated content for hospitals with new info
 * 4. Save with draft: true (requires human review for data accuracy)
 * 5. Exit with output for PR creation
 *
 * Usage:
 *   pnpm tsx scripts/update-case-studies.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Env validation — exit gracefully if keys missing
// ---------------------------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('INFO: ANTHROPIC_API_KEY not set — skipping case study review.');
  process.exit(0);
}
if (!process.env.TAVILY_API_KEY) {
  console.log('INFO: TAVILY_API_KEY not set — skipping case study review.');
  process.exit(0);
}

// Dynamic imports — must come after env var check
const { generateContent } = await import('./lib/ai.js');
const { writeContentFile, PROJECT_ROOT } = await import('./lib/fs-utils.js');

// ---------------------------------------------------------------------------
// Read existing case studies
// ---------------------------------------------------------------------------
interface CaseStudyMeta {
  slug: string;
  hospitalName: string;
  rawContent: string;
}

function readExistingCaseStudies(): CaseStudyMeta[] {
  const dir = join(PROJECT_ROOT, 'src', 'content', 'case-studies');
  const results: CaseStudyMeta[] = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const slug = f.replace(/\.md$/, '');
      const content = readFileSync(join(dir, f), 'utf-8');

      // Extract hospital name from frontmatter
      const nameMatch = content.match(/name:\s*(.+)/);
      const hospitalName = nameMatch ? nameMatch[1].trim() : slug;

      results.push({ slug, hospitalName, rawContent: content });
    }
  } catch {
    // Directory may not exist yet
  }

  return results;
}

// ---------------------------------------------------------------------------
// Search for hospital updates via Tavily
// ---------------------------------------------------------------------------
async function searchHospitalUpdates(hospitalName: string): Promise<string> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query: `${hospitalName} 節能 ESG 永續 碳盤查 獎項 認證 2025 2026`,
      search_depth: 'basic',
      max_results: 5,
    }),
  });

  if (!response.ok) {
    return '';
  }

  const data = await response.json() as { results?: Array<{ title: string; content: string; url: string }> };
  const results = data.results || [];

  if (results.length === 0) return '';

  return results
    .map((r) => `標題: ${r.title}\n來源: ${r.url}\n摘要: ${r.content.slice(0, 500)}`)
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Generate updated case study content
// ---------------------------------------------------------------------------
interface UpdateResult {
  slug: string;
  hospitalName: string;
  hasUpdate: boolean;
  updatedContent?: string;
  updatedFrontmatter?: Record<string, unknown>;
}

async function generateCaseStudyUpdate(
  caseStudy: CaseStudyMeta,
  searchResults: string,
): Promise<UpdateResult> {
  const prompt = `根據以下現有案例內容和最新搜尋結果，判斷是否需要更新此醫院的案例故事。

醫院：${caseStudy.hospitalName}

現有案例內容：
${caseStudy.rawContent.slice(0, 2000)}

最新搜尋結果：
${searchResults || '（無新資訊）'}

請回答（JSON 格式，不要加 markdown code block）：
{
  "hasUpdate": true/false,
  "reason": "說明是否有需要更新的新資訊",
  "updatedBody": "如果 hasUpdate=true，提供更新後的完整正文（Markdown，800-1200字）；否則為 null",
  "newCerts": ["如果有新認證，列出；否則空陣列"],
  "newAwards": ["如果有新獎項，列出；否則空陣列"],
  "updatedEnergySavingNote": "如果節能數據有更新，說明；否則 null"
}

重要規則：
- 只有在搜尋結果中有明確新資訊時才設 hasUpdate: true
- 不要編造或推測未確認的數據
- 更新內容仍需維持原有結構（合作背景、挑戰、解決方案、成果、展望）
- 語言：繁體中文，台灣用語`;

  try {
    const raw = await generateContent(prompt);
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    if (!result.hasUpdate || !result.updatedBody) {
      return { slug: caseStudy.slug, hospitalName: caseStudy.hospitalName, hasUpdate: false };
    }

    // Parse existing frontmatter to update it
    const fmMatch = caseStudy.rawContent.match(/^---\n([\s\S]+?)\n---/);
    const existingFm: Record<string, unknown> = {};
    if (fmMatch) {
      // Basic parsing — just pass updated notes through Claude result
      existingFm.updateNote = result.reason;
      if (result.newCerts?.length > 0) existingFm.newCerts = result.newCerts;
      if (result.newAwards?.length > 0) existingFm.newAwards = result.newAwards;
    }

    return {
      slug: caseStudy.slug,
      hospitalName: caseStudy.hospitalName,
      hasUpdate: true,
      updatedContent: result.updatedBody,
      updatedFrontmatter: existingFm,
    };
  } catch (err) {
    console.error(`  ERROR processing update for "${caseStudy.hospitalName}":`, err);
    return { slug: caseStudy.slug, hospitalName: caseStudy.hospitalName, hasUpdate: false };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Annual case study review starting...');

const caseStudies = readExistingCaseStudies();
console.log(`  Found ${caseStudies.length} existing case studies`);

if (caseStudies.length === 0) {
  console.log('  No case studies found — nothing to update.');
  process.exit(0);
}

const updatedCases: string[] = [];

for (const caseStudy of caseStudies) {
  console.log(`\n  Checking: ${caseStudy.hospitalName}`);

  // Search for hospital updates
  const searchResults = await searchHospitalUpdates(caseStudy.hospitalName);

  // Generate update assessment
  const updateResult = await generateCaseStudyUpdate(caseStudy, searchResults);

  if (!updateResult.hasUpdate) {
    console.log(`    No updates needed`);
  } else {
    console.log(`    Updates found — writing draft`);

    // Build updated frontmatter preserving original + marking as draft
    const frontmatter: Record<string, unknown> = {
      ...(updateResult.updatedFrontmatter || {}),
      draft: true,
      reviewNote: `年度自動審查 ${new Date().toISOString().slice(0, 10)} — 請確認數據正確性後移除 draft: true`,
      lastReviewDate: new Date().toISOString().slice(0, 10),
    };

    writeContentFile(
      'case-studies',
      `${caseStudy.slug}-review`,
      frontmatter,
      updateResult.updatedContent || '',
    );

    updatedCases.push(caseStudy.hospitalName);
  }

  // 1.5-second delay between API calls
  await new Promise((r) => setTimeout(r, 1500));
}

if (updatedCases.length === 0) {
  console.log('\nDone. No case studies needed updating.');
} else {
  console.log(`\nDone. ${updatedCases.length} case study draft(s) created:`);
  for (const name of updatedCases) {
    console.log(`  - ${name}`);
  }
  console.log('\nNOTE: All updates saved with draft: true — human review required before publishing.');
}

// Exit code 0 — caller (workflow) will check for new files and create PR
process.exit(0);
