#!/usr/bin/env node
/**
 * fetch-images.ts
 * Unsplash image pipeline for crinhealthcare.org
 *
 * Usage:
 *   pnpm fetch-images -- --collection services
 *   pnpm fetch-images -- --collection news --new-only
 *   pnpm fetch-images -- --all
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const KEYWORDS_PATH = join(PROJECT_ROOT, 'data', 'image-keywords.json');
const CONTENT_ROOT = join(PROJECT_ROOT, 'src', 'content');
const IMAGES_AUTO = join(PROJECT_ROOT, 'src', 'assets', 'images', 'auto');
const FALLBACK_DIR = join(PROJECT_ROOT, 'src', 'assets', 'images', 'fallback');

// All known collections
const ALL_COLLECTIONS = ['services', 'news', 'insights', 'case-studies', 'glossary', 'faq'];

// ---------------------------------------------------------------------------
// Load keyword map
// ---------------------------------------------------------------------------

const KEYWORDS: Record<string, string[]> = JSON.parse(
  readFileSync(KEYWORDS_PATH, 'utf-8')
);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  collection?: string;
  newOnly: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { newOnly: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--collection' && argv[i + 1]) {
      args.collection = argv[++i];
    } else if (argv[i] === '--new-only') {
      args.newOnly = true;
    } else if (argv[i] === '--all') {
      args.all = true;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Environment / API key
// ---------------------------------------------------------------------------

function loadEnvFile(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

const ENV = loadEnvFile();
const UNSPLASH_KEY: string | undefined =
  process.env.UNSPLASH_ACCESS_KEY ?? ENV['UNSPLASH_ACCESS_KEY'];

// ---------------------------------------------------------------------------
// Frontmatter parsing helpers (regex-based, no full YAML library rewrite)
// ---------------------------------------------------------------------------

interface ParsedFile {
  frontmatter: string;       // raw YAML string between the --- delimiters
  body: string;              // everything after the closing ---
  data: Record<string, unknown>;
}

function parseFrontmatter(content: string): ParsedFile {
  // Match --- … --- at the start of the file
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: '', body: content, data: {} };
  }
  const frontmatter = match[1];
  const body = match[2];

  // Minimal YAML key extraction (handles scalars, block sequences, and inline arrays)
  const data: Record<string, unknown> = {};
  const lines = frontmatter.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Inline array: tags: ["a", "b", "c"]
    const inlineArrayMatch = line.match(/^(\w[\w-]*):\s*\[([^\]]*)\]/);
    if (inlineArrayMatch) {
      const key = inlineArrayMatch[1];
      const inner = inlineArrayMatch[2];
      // Split on commas, strip surrounding quotes/spaces
      const items = inner
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
      data[key] = items;
      i++;
      continue;
    }

    // Scalar: key: "value" or key: value
    const scalarMatch = line.match(/^(\w[\w-]*):\s+"?([^"]*)"?\s*$/);
    if (scalarMatch) {
      data[scalarMatch[1]] = scalarMatch[2];
      i++;
      continue;
    }

    // Block sequence array: key:\n  - item1\n  - item2
    const arrayKeyMatch = line.match(/^(\w[\w-]*):\s*$/);
    if (arrayKeyMatch) {
      const key = arrayKeyMatch[1];
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+-\s+/)) {
        items.push(lines[i].replace(/^\s+-\s+"?/, '').replace(/"?\s*$/, '').trim());
        i++;
      }
      if (items.length > 0) {
        data[key] = items;
        continue;
      }
      // Not an array, record as undefined and continue
      data[key] = undefined;
      continue;
    }
    i++;
  }

  return { frontmatter, body, data };
}

/**
 * Inject or update a YAML block at the end of the frontmatter.
 * Replaces an existing heroImage block or appends a new one.
 */
function updateFrontmatter(
  original: string,
  heroImage: HeroImageMeta
): string {
  const { frontmatter, body } = parseFrontmatter(original);

  // Build heroImage YAML block
  const heroBlock = [
    `heroImage:`,
    `  src: "${heroImage.src}"`,
    `  alt: "${heroImage.alt}"`,
    `  credit: "${heroImage.credit}"`,
    `  unsplashId: "${heroImage.unsplashId}"`,
  ].join('\n');

  let newFrontmatter: string;
  if (/^heroImage:/m.test(frontmatter)) {
    // Replace existing heroImage block (multi-line)
    newFrontmatter = frontmatter.replace(
      /^heroImage:[\s\S]*?(?=\n\w|\n---|\s*$)/m,
      heroBlock
    );
  } else {
    newFrontmatter = frontmatter + '\n' + heroBlock;
  }

  return `---\n${newFrontmatter}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Unsplash API
// ---------------------------------------------------------------------------

interface UnsplashResult {
  url: string;       // direct download URL (regular size ~1080px)
  credit: string;    // photographer name
  unsplashId: string;
}

async function searchUnsplash(query: string): Promise<UnsplashResult | null> {
  if (!UNSPLASH_KEY) {
    console.warn('  [warn] UNSPLASH_ACCESS_KEY not set — skipping API call');
    return null;
  }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    });
    if (!res.ok) {
      console.warn(`  [warn] Unsplash HTTP ${res.status} for query "${query}"`);
      return null;
    }
    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        urls: { regular: string };
        user: { name: string };
      }>;
    };
    if (!data.results?.length) {
      console.warn(`  [warn] No Unsplash results for "${query}"`);
      return null;
    }
    const photo = data.results[0];
    return {
      url: photo.urls.regular,
      credit: photo.user.name,
      unsplashId: photo.id,
    };
  } catch (err) {
    console.warn(`  [warn] Unsplash fetch error: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image download + compress with sharp
// ---------------------------------------------------------------------------

async function downloadAndCompress(
  url: string,
  outputPath: string
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const sharp = (await import('sharp')).default;
  await sharp(buffer)
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toFile(outputPath);
}

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core per-file logic
// ---------------------------------------------------------------------------

interface HeroImageMeta {
  src: string;       // relative path from project root, e.g. src/assets/images/auto/services/carbon-audit/hero.webp
  alt: string;
  credit: string;
  unsplashId: string;
}

async function processFile(
  filePath: string,
  collection: string,
  newOnly: boolean
): Promise<void> {
  const content = readFileSync(filePath, 'utf-8');
  const { data } = parseFrontmatter(content);
  const slug = filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'unknown';

  // Skip if heroImage already set (idempotent)
  if (data['heroImage']) {
    console.log(`  [skip] ${slug} — heroImage already set`);
    return;
  }

  // --new-only: skip files that already have an image saved on disk
  const outputDir = join(IMAGES_AUTO, collection, slug);
  const outputPath = join(outputDir, 'hero.webp');
  if (newOnly && existsSync(outputPath)) {
    console.log(`  [skip] ${slug} — image exists on disk (--new-only)`);
    return;
  }

  // Extract tags from frontmatter
  const tags = Array.isArray(data['tags']) ? (data['tags'] as string[]) : [];

  // Map tags to search terms
  let searchTerm: string | null = null;
  for (const tag of tags) {
    const terms = KEYWORDS[tag];
    if (terms?.length) {
      searchTerm = terms[0];
      break;
    }
  }

  // Fallback: use collection name as generic query
  if (!searchTerm) {
    const collectionFallbacks: Record<string, string> = {
      services: 'sustainable healthcare',
      news: 'environmental news',
      insights: 'healthcare sustainability research',
      'case-studies': 'hospital green energy',
      glossary: 'environmental terminology',
      faq: 'healthcare sustainability',
    };
    searchTerm = collectionFallbacks[collection] ?? 'sustainable healthcare';
    console.log(`  [info] ${slug} — no tag match, using generic term: "${searchTerm}"`);
  } else {
    console.log(`  [info] ${slug} — using term: "${searchTerm}"`);
  }

  // Search Unsplash
  const result = await searchUnsplash(searchTerm);
  if (!result) {
    // Fallback: log warning, check fallback dir
    const fallbackPath = join(FALLBACK_DIR, `${collection}-default.webp`);
    if (existsSync(fallbackPath)) {
      console.warn(`  [fallback] ${slug} — using fallback image`);
      // Copy fallback (not writing frontmatter change for fallback)
    } else {
      console.warn(`  [fallback] ${slug} — no fallback image available, skipping`);
    }
    return;
  }

  // Download and compress
  mkdirSync(outputDir, { recursive: true });
  try {
    await downloadAndCompress(result.url, outputPath);
    console.log(`  [ok] ${slug} — saved to ${outputPath.replace(PROJECT_ROOT + '/', '')}`);
  } catch (err) {
    console.warn(`  [warn] ${slug} — image compress failed: ${(err as Error).message}`);
    return;
  }

  // Determine alt text from frontmatter name/title
  const nameOrTitle = (data['name'] ?? data['title'] ?? slug) as string;
  const alt = `${nameOrTitle} — sustainable healthcare`;

  // Build relative src path (from project root, used as Astro asset path)
  const relativeSrc = outputPath.replace(PROJECT_ROOT + '/', '');

  const heroMeta: HeroImageMeta = {
    src: relativeSrc,
    alt,
    credit: result.credit,
    unsplashId: result.unsplashId,
  };

  // Update frontmatter
  const updated = updateFrontmatter(content, heroMeta);
  writeFileSync(filePath, updated, 'utf-8');
  console.log(`  [ok] ${slug} — frontmatter updated`);
}

// ---------------------------------------------------------------------------
// Process a collection
// ---------------------------------------------------------------------------

async function processCollection(
  collection: string,
  newOnly: boolean
): Promise<void> {
  const dir = join(CONTENT_ROOT, collection);
  if (!existsSync(dir)) {
    console.warn(`[warn] Collection directory not found: ${dir}`);
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));

  console.log(`\n[collection] ${collection} — ${files.length} file(s)`);

  for (const filePath of files) {
    await processFile(filePath, collection, newOnly);
    // Rate limit: 50 req/hr = 1 req per 72s on free tier.
    // We add 1.5s between requests for reasonable throughput.
    await delay(1500);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.collection && !args.all) {
    console.error(
      'Usage:\n' +
      '  pnpm fetch-images -- --collection <name>\n' +
      '  pnpm fetch-images -- --collection <name> --new-only\n' +
      '  pnpm fetch-images -- --all'
    );
    process.exit(1);
  }

  if (!UNSPLASH_KEY) {
    console.warn(
      '[warn] UNSPLASH_ACCESS_KEY is not set.\n' +
      '  Set it in .env or as an environment variable.\n' +
      '  Script will run but skip all API calls.\n'
    );
  }

  // Ensure output directories exist
  mkdirSync(IMAGES_AUTO, { recursive: true });
  mkdirSync(FALLBACK_DIR, { recursive: true });

  const collections = args.all
    ? ALL_COLLECTIONS
    : [args.collection as string];

  for (const collection of collections) {
    await processCollection(collection, args.newOnly);
  }

  console.log('\n[done] fetch-images complete');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
