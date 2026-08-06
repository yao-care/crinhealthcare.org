#!/usr/bin/env node
// 把「草稿」文章打包成一份單檔 HTML 供內部審閱。
//
//   node scripts/build-draft-review.mjs            # 全部 draft:true 的 insights
//   node scripts/build-draft-review.mjs a.md b.md  # 指定檔案
//   → dist-offline/draft-review.html
//
// 為什麼要另外做這支：`src/pages/insights/*.astro` 一律 `!data.draft`，
// 草稿不會被建成任何頁面（連 sitemap/RSS 都沒有）——這正是「不推到外部」要的，
// 但也代表審閱的人在站上看不到。這支腳本**不碰 dist/、不產生任何站上頁面**，
// 只在本機把草稿渲染成一個檔，傳閱完即丟。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist-offline');
const OUT = path.join(OUT_DIR, 'draft-review.html');
const INSIGHTS = path.join(ROOT, 'src/content/insights');

// 借 Astro 自己的 markdown pipeline（跟站上同一套渲染，才看得出真實排版）
const mdPkg = fs
  .readdirSync(path.join(ROOT, 'node_modules/.pnpm'))
  .find((d) => d.startsWith('@astrojs+markdown-remark@'));
if (!mdPkg) {
  console.error('✗ 找不到 @astrojs/markdown-remark');
  process.exit(1);
}
const { createMarkdownProcessor } = await import(
  path.join(ROOT, 'node_modules/.pnpm', mdPkg, 'node_modules/@astrojs/markdown-remark/dist/index.js')
);
const processor = await createMarkdownProcessor({});

const args = process.argv.slice(2);
const files = args.length
  ? args.map((a) => path.resolve(ROOT, a))
  : fs.readdirSync(INSIGHTS).filter((f) => f.endsWith('.md')).map((f) => path.join(INSIGHTS, f));

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const docs = [];
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) continue;
  const fm = parseYaml(m[1]) ?? {};
  if (args.length === 0 && !fm.draft) continue;   // 沒指定檔案時只收草稿
  const { code } = await processor.render(m[2]);
  docs.push({ file: path.relative(ROOT, file), fm, html: code, words: m[2].replace(/\s/g, '').length });
}

if (!docs.length) {
  console.error('✗ 沒有 draft:true 的文章');
  process.exit(1);
}

const stamp = fs.statSync(files[0]).mtime.toISOString().slice(0, 16).replace('T', ' ');
const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>草稿審閱 · 國際醫療減碳協會</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f5f7; color: #1e2030;
         font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
         line-height: 1.85; }
  .wrap { max-width: 46rem; margin: 0 auto; padding: 2rem 1.2rem 5rem; }
  .banner { background: #8a2b2b; color: #fff; padding: .7rem 1rem; border-radius: .5rem;
            font-weight: 700; margin-bottom: 1.6rem; line-height: 1.6; }
  .banner small { display: block; font-weight: 400; opacity: .9; }
  .toc { background: #fff; border: 1px solid #dcdee3; border-radius: .5rem; padding: .9rem 1.2rem; margin-bottom: 2rem; }
  .toc ol { margin: .4rem 0 0; padding-left: 1.3rem; }
  .toc a { color: #1b6b73; }
  article { background: #fff; border: 1px solid #dcdee3; border-radius: .6rem;
            padding: 1.6rem 1.8rem 2rem; margin-bottom: 2rem; }
  h1 { font-size: 1.7rem; line-height: 1.4; margin: 0 0 .5rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 .6rem; padding-top: .3rem; border-top: 1px solid #eceef1; }
  .meta { font-size: .85rem; color: #5e6070; margin-bottom: 1.2rem; }
  .meta b { color: #1e2030; }
  .summary { background: #f0f4f5; border-left: 3px solid #1b6b73; padding: .7rem 1rem; margin: 0 0 1.4rem; font-size: .95rem; }
  .bench { background: #fbf7ee; border: 1px solid #e6dcc4; border-radius: .4rem; padding: .8rem 1rem; margin: 1.4rem 0; font-size: .9rem; }
  .bench b { color: #7a5c1e; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .92rem; }
  th, td { border: 1px solid #dcdee3; padding: .4rem .6rem; text-align: left; }
  th { background: #f4f5f7; }
  code { background: #f0f1f3; padding: .1rem .3rem; border-radius: .2rem; }
  a { color: #1b6b73; }
  .foot { font-size: .85rem; color: #5e6070; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">內部審閱用草稿，請勿外流
    <small>這些文章在 repo 裡標記 draft: true，不會出現在 crinhealthcare.org 的任何頁面、sitemap 或 RSS。本檔為本機產出、未上傳任何伺服器。產出時間 ${stamp}</small>
  </div>
  <nav class="toc"><b>本次審閱 ${docs.length} 篇</b>
    <ol>${docs.map((d, i) => `<li><a href="#a${i}">${esc(d.fm.title)}</a></li>`).join('')}</ol>
  </nav>
  ${docs
    .map(
      (d, i) => `<article id="a${i}">
    <h1>${esc(d.fm.title)}</h1>
    <div class="meta">
      <b>${esc(d.fm.publishDate ?? '')}</b> · 分類 ${esc(d.fm.category ?? '')} · 約 ${d.words} 字
      · 標籤 ${(d.fm.tags ?? []).map(esc).join('、')} · <code>${esc(d.file)}</code>
    </div>
    <p class="summary">${esc(d.fm.summary)}</p>
    ${
      d.fm.internationalBenchmark
        ? `<div class="bench"><b>國際標竿：${esc(d.fm.internationalBenchmark.region)} — ${esc(d.fm.internationalBenchmark.title)}</b>
             <div>${esc(d.fm.internationalBenchmark.summary)}</div>
             <div>對照：${esc(d.fm.internationalBenchmark.comparison)}</div>
             <div><a href="${esc(d.fm.internationalBenchmark.sourceUrl)}">${esc(d.fm.internationalBenchmark.sourceUrl)}</a></div>
           </div>`
        : ''
    }
    ${d.html}
  </article>`,
    )
    .join('\n')}
  <p class="foot">定稿後把 frontmatter 的 <code>draft: true</code> 改成 <code>false</code>，重新 build 才會上線。</p>
</div>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, page);
console.log(`✓ ${path.relative(ROOT, OUT)}  ${(Buffer.byteLength(page) / 1024).toFixed(0)} KB`);
docs.forEach((d) => console.log(`  · ${d.fm.title}（${d.words} 字）`));
