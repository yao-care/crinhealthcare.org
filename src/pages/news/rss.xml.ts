import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const entries = await getCollection('news', ({ data }) => !data.draft);
  const sorted = entries.sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime()
  );

  return rss({
    title: '國際醫療減碳協會 — 新聞',
    description: '醫療減碳、ESG 永續、碳盤查相關新聞',
    site: context.site!,
    items: sorted.slice(0, 50).map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.publishDate,
      description: entry.data.summary,
      link: `/news/${entry.id}/`,
    })),
  });
}
