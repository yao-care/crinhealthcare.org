import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const entries = await getCollection('insights', ({ data }) => !data.draft);
  const sorted = entries.sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime()
  );

  return rss({
    title: '國際醫療減碳協會 — 深度內容',
    description: '醫療減碳政策解讀、知識指南、國際標竿',
    site: context.site!,
    items: sorted.slice(0, 50).map((entry) => ({
      title: entry.data.title,
      pubDate: entry.data.publishDate,
      description: entry.data.summary,
      link: `/insights/${entry.id}/`,
    })),
  });
}
