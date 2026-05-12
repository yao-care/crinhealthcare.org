import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://yao-care.github.io',
  base: '/crinhealthcare.org',
  integrations: [svelte(), sitemap()],
  output: 'static',
});
