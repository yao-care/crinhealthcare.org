import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const newsEntries = await getCollection('news', ({ data }) => !data.draft);
  const insightsEntries = await getCollection('insights', ({ data }) => !data.draft);

  const newsItems = newsEntries.map((entry) => ({
    title: entry.data.title,
    pubDate: entry.data.publishDate,
    description: entry.data.summary,
    link: `/news/${entry.id}/`,
  }));

  const insightsItems = insightsEntries.map((entry) => ({
    title: entry.data.title,
    pubDate: entry.data.publishDate,
    description: entry.data.summary,
    link: `/insights/${entry.id}/`,
  }));

  const combined = [...newsItems, ...insightsItems].sort(
    (a, b) => b.pubDate.getTime() - a.pubDate.getTime()
  );

  return rss({
    title: '國際醫療減碳協會 — 最新動態',
    description: '醫療減碳、ESG 永續、碳盤查、能源管理相關新聞與深度內容',
    site: context.site!,
    items: combined.slice(0, 50),
  });
}
