import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import sharp from 'sharp';
import { generateOgSvg } from '@/utils/og-template';

const COLLECTIONS = ['news', 'insights', 'case-studies', 'glossary', 'services'] as const;

export const getStaticPaths: GetStaticPaths = async () => {
  const paths: Array<{ params: { slug: string }; props: { title: string; collection: string } }> = [];

  for (const collection of COLLECTIONS) {
    const entries = await getCollection(collection);
    for (const entry of entries) {
      if ('draft' in entry.data && entry.data.draft) continue;

      // Get title from various schema shapes
      const title = ('title' in entry.data ? entry.data.title : null)
        ?? ('term' in entry.data ? entry.data.term : null)
        ?? ('name' in entry.data ? entry.data.name : null)
        ?? ('question' in entry.data ? entry.data.question : null)
        ?? 'Untitled';

      paths.push({
        params: { slug: `${collection}/${entry.id}` },
        props: { title, collection },
      });
    }
  }

  // Static pages
  const staticPages = [
    { slug: 'index', title: '協助醫療院所達成淨零排放', collection: 'website' },
    { slug: 'about', title: '關於協會', collection: 'website' },
    { slug: 'results', title: '合作成果', collection: 'website' },
    { slug: 'faq', title: '常見問題', collection: 'website' },
    { slug: 'join', title: '加入會員', collection: 'website' },
    { slug: 'contact', title: '聯絡我們', collection: 'website' },
  ];

  for (const page of staticPages) {
    paths.push({
      params: { slug: page.slug },
      props: { title: page.title, collection: page.collection },
    });
  }

  return paths;
};

export const GET: APIRoute = async ({ props }) => {
  const { title, collection } = props as { title: string; collection: string };
  const svg = generateOgSvg(title, collection);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
