import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';

// Project root (scripts/ is one level down)
export const PROJECT_ROOT = join(import.meta.dirname, '..', '..');

// Source materials directory
export const SOURCE_DIR = '/Users/lightman/yao.care/agent.procurement/cases/crinhealthcare.org/國際醫療減碳協會/converted_md';

export function readSourceFile(filename: string): string {
  return readFileSync(join(SOURCE_DIR, filename), 'utf-8');
}

export function writeContentFile(
  collection: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const dir = join(PROJECT_ROOT, 'src', 'content', collection);
  mkdirSync(dir, { recursive: true });

  // Convert frontmatter to YAML
  const yamlStr = stringify(frontmatter, { lineWidth: 0 });
  const content = `---\n${yamlStr}---\n\n${body}\n`;

  writeFileSync(join(dir, `${slug}.md`), content, 'utf-8');
  console.log(`  Created: src/content/${collection}/${slug}.md`);
}

export function writeDataFile(filename: string, data: unknown): void {
  const filepath = join(PROJECT_ROOT, 'data', filename);
  mkdirSync(dirname(filepath), { recursive: true });

  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
    writeFileSync(filepath, stringify(data, { lineWidth: 0 }), 'utf-8');
  } else {
    writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }
  console.log(`  Created: data/${filename}`);
}
