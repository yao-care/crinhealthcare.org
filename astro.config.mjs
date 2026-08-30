import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://crinhealthcare.org',
  // /review/ 為內部審閱用未公開頁：不進 sitemap（頁面本身另帶 noindex，站上也沒有任何連結）
  integrations: [svelte(), sitemap({ filter: (page) => !page.includes('/review/') })],
  output: 'static',
});
