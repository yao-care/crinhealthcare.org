/**
 * seed-all.ts
 * Orchestrator: runs all seed scripts in sequence.
 */

import { execSync } from 'node:child_process';

const scripts = [
  'seed:team',
  'seed:events',
  'seed:services',
  'seed:case-studies',
  'seed:glossary',
  'seed:faq',
];

for (const script of scripts) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running ${script}...`);
  console.log('='.repeat(60));
  execSync(`pnpm ${script}`, { stdio: 'inherit' });
}

console.log('\nAll seed scripts completed!');
