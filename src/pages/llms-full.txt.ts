import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const glossary = await getCollection('glossary', ({ data }) => !data.draft);
  const insights = await getCollection('insights', ({ data }) => !data.draft);

  let text = '# 國際醫療減碳協會 — 完整知識庫\n\n';

  text += '## 詞彙庫\n\n';
  for (const term of glossary.sort((a, b) => a.data.term.localeCompare(b.data.term))) {
    text += `### ${term.data.term}\n`;
    text += `${term.data.definition}\n`;
    text += `分類: ${term.data.category}\n\n`;
  }

  text += '## 深度內容\n\n';
  for (const article of insights.sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime()
  )) {
    text += `### ${article.data.title}\n`;
    text += `日期: ${article.data.publishDate.toISOString().split('T')[0]}\n`;
    text += `分類: ${article.data.category}\n`;
    text += `${article.data.summary}\n\n`;
  }

  return new Response(text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
