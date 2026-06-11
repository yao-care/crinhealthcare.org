/**
 * audit-content.ts
 * Quarterly content quality audit — samples recent articles and checks quality.
 *
 * Flow:
 * 1. Sample 5-10 recent news + insights articles
 * 2. For each, call Claude API as quality reviewer
 * 3. Check for: factual accuracy, outdated info, broken references, quality score
 * 4. Generate audit-report.md with findings
 * 5. Exit gracefully if no API key
 *
 * Usage:
 *   pnpm tsx scripts/audit-content.ts
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Env validation — exit gracefully if key missing
// ---------------------------------------------------------------------------
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('INFO: ANTHROPIC_API_KEY not set — skipping content audit.');
  // Write a minimal report so the workflow step doesn't fail
  writeFileSync('audit-report.md', `# 內容品質審查報告

**狀態：** 略過（未設定 ANTHROPIC_API_KEY）

本次審查因缺少 API 金鑰而略過。
`);
  process.exit(0);
}

// Dynamic import — must come after env var check
const { generateContent } = await import('./lib/ai.js');

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ArticleSample {
  collection: string;
  slug: string;
  content: string;
  publishDate?: string;
}

interface AuditResult {
  collection: string;
  slug: string;
  qualityScore: number;  // 1-10
  issues: string[];
  strengths: string[];
  recommendation: 'keep' | 'update' | 'remove';
  summary: string;
}

// ---------------------------------------------------------------------------
// Sample recent articles
// ---------------------------------------------------------------------------
function sampleRecentArticles(collection: string, count: number): ArticleSample[] {
  const dir = join(PROJECT_ROOT, 'src', 'content', collection);
  const samples: ArticleSample[] = [];

  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f,
        mtime: statSync(join(dir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime)  // newest first
      .slice(0, count)
      .map((f) => f.name);

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const slug = file.replace(/\.md$/, '');

      // Extract publishDate from frontmatter
      const dateMatch = content.match(/publishDate:\s*['"]?(\d{4}-\d{2}-\d{2})/);
      const publishDate = dateMatch?.[1];

      samples.push({ collection, slug, content: content.slice(0, 3000), publishDate });
    }
  } catch {
    // Directory may not exist
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Audit a single article
// ---------------------------------------------------------------------------
async function auditArticle(article: ArticleSample): Promise<AuditResult> {
  const prompt = `請以內容品質審查員的角色，審查以下醫療減碳協會網站文章。

文章集合：${article.collection}
Slug：${article.slug}
發布日期：${article.publishDate || '未知'}

文章內容（前3000字）：
${article.content}

請提供審查結果（JSON 格式，不要加 markdown code block）：
{
  "qualityScore": 1-10的整體品質分數,
  "issues": ["發現的問題列表，如：資訊過時、連結失效、數據可疑、語言問題等"],
  "strengths": ["文章優點列表"],
  "recommendation": "keep | update | remove",
  "summary": "50字以內的總結"
}

審查標準：
- 事實準確性：數據、日期、組織名稱是否正確
- 時效性：資訊是否過時（特別是法規、補助金額、認證狀態）
- 內容品質：邏輯清晰、語言流暢、對醫療機構管理者有實用價值
- 品牌一致性：是否符合國際醫療減碳協會的形象與用語
- recommendation 說明：keep=可繼續使用、update=需要更新、remove=應下架`;

  try {
    const raw = await generateContent(prompt);
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    return {
      collection: article.collection,
      slug: article.slug,
      qualityScore: Math.min(10, Math.max(1, Number(result.qualityScore) || 5)),
      issues: Array.isArray(result.issues) ? result.issues : [],
      strengths: Array.isArray(result.strengths) ? result.strengths : [],
      recommendation: ['keep', 'update', 'remove'].includes(result.recommendation)
        ? result.recommendation
        : 'keep',
      summary: result.summary || '（無摘要）',
    };
  } catch (err) {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring — 經資安負責人 2026-06-11 簽核判定為誤報：log 格式字串非使用者輸入，風險接受
    console.error(`  ERROR auditing ${article.collection}/${article.slug}:`, err);
    return {
      collection: article.collection,
      slug: article.slug,
      qualityScore: 0,
      issues: ['審查時發生錯誤'],
      strengths: [],
      recommendation: 'keep',
      summary: '審查失敗',
    };
  }
}

// ---------------------------------------------------------------------------
// Generate audit report markdown
// ---------------------------------------------------------------------------
function generateReport(results: AuditResult[], auditDate: string): string {
  const total = results.length;
  const avgScore = total > 0
    ? (results.reduce((s, r) => s + r.qualityScore, 0) / total).toFixed(1)
    : 'N/A';

  const needsUpdate = results.filter((r) => r.recommendation === 'update');
  const needsRemoval = results.filter((r) => r.recommendation === 'remove');
  const goodContent = results.filter((r) => r.recommendation === 'keep');

  let report = `# 內容品質審查報告

**審查日期：** ${auditDate}
**審查文章數：** ${total}
**平均品質分數：** ${avgScore} / 10

## 摘要

| 狀態 | 數量 |
|------|------|
| 維持現狀 (keep) | ${goodContent.length} |
| 需要更新 (update) | ${needsUpdate.length} |
| 建議下架 (remove) | ${needsRemoval.length} |

`;

  if (needsRemoval.length > 0) {
    report += `## 建議下架文章\n\n`;
    for (const r of needsRemoval) {
      report += `### \`${r.collection}/${r.slug}\` (分數: ${r.qualityScore}/10)\n\n`;
      report += `**摘要：** ${r.summary}\n\n`;
      if (r.issues.length > 0) {
        report += `**問題：**\n${r.issues.map((i) => `- ${i}`).join('\n')}\n\n`;
      }
    }
  }

  if (needsUpdate.length > 0) {
    report += `## 需要更新的文章\n\n`;
    for (const r of needsUpdate) {
      report += `### \`${r.collection}/${r.slug}\` (分數: ${r.qualityScore}/10)\n\n`;
      report += `**摘要：** ${r.summary}\n\n`;
      if (r.issues.length > 0) {
        report += `**問題：**\n${r.issues.map((i) => `- ${i}`).join('\n')}\n\n`;
      }
      if (r.strengths.length > 0) {
        report += `**優點：**\n${r.strengths.map((s) => `- ${s}`).join('\n')}\n\n`;
      }
    }
  }

  report += `## 所有審查結果\n\n`;
  report += `| 集合 | Slug | 分數 | 建議 | 摘要 |\n`;
  report += `|------|------|------|------|------|\n`;
  for (const r of results) {
    const scoreEmoji = r.qualityScore >= 8 ? '✅' : r.qualityScore >= 5 ? '⚠️' : '❌';
    report += `| ${r.collection} | ${r.slug} | ${scoreEmoji} ${r.qualityScore}/10 | ${r.recommendation} | ${r.summary} |\n`;
  }

  report += `\n---\n*本報告由自動化審查工具生成，建議由人工確認後採取行動。*\n`;

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('Content quality audit starting...');

const auditDate = new Date().toISOString().slice(0, 10);

// Sample recent articles: 5 from news, 5 from insights
const newsArticles = sampleRecentArticles('news', 5);
const insightsArticles = sampleRecentArticles('insights', 5);
const allArticles = [...newsArticles, ...insightsArticles];

console.log(`  Sampled: ${newsArticles.length} news + ${insightsArticles.length} insights = ${allArticles.length} total`);

if (allArticles.length === 0) {
  console.log('  No articles found — writing empty report.');
  writeFileSync('audit-report.md', `# 內容品質審查報告\n\n**審查日期：** ${auditDate}\n\n目前無文章可審查。\n`);
  process.exit(0);
}

const results: AuditResult[] = [];

for (const article of allArticles) {
  console.log(`  Auditing: ${article.collection}/${article.slug}`);
  const result = await auditArticle(article);
  results.push(result);
  console.log(`    Score: ${result.qualityScore}/10 — ${result.recommendation} — ${result.summary}`);

  // 1-second delay between API calls
  await new Promise((r) => setTimeout(r, 1000));
}

const report = generateReport(results, auditDate);
writeFileSync('audit-report.md', report, 'utf-8');

console.log(`\nDone. Audit report written to audit-report.md`);
console.log(`  Average score: ${(results.reduce((s, r) => s + r.qualityScore, 0) / results.length).toFixed(1)}/10`);
console.log(`  Needs update: ${results.filter((r) => r.recommendation === 'update').length}`);
console.log(`  Needs removal: ${results.filter((r) => r.recommendation === 'remove').length}`);
