import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://crinhealthcare.org',
  // /review/ 為內部審閱用未公開頁：不進 sitemap（頁面本身另帶 noindex，站上也沒有任何連結）
  integrations: [
    svelte(),
    sitemap({
      filter: (page) => !page.includes('/review/') && !page.includes('/case-studies/ndmc-zuoying'),
    }),
  ],
  output: 'static',
  // 已下架頁面的轉向。GitHub Pages 是純靜態，發不出真正的 301 狀態碼；
  // Astro 靜態模式會產生一頁 meta refresh + rel=canonical，搜尋引擎照樣會把
  // 權重轉到目標頁，使用者點舊連結也會被帶過去。
  redirects: {
    '/case-studies/ndmc-zuoying': '/case-studies',
  },
});
