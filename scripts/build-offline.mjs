#!/usr/bin/env node
// 把 dist/<醫院>/ 的看板頁與 4 個詳情子頁打包成「單一 HTML、可離線開啟」的檔案。
//
//   pnpm build && node scripts/build-offline.mjs 804
//   → dist-offline/804-offline.html（用瀏覽器直接開，不需網路、不需伺服器）
//
// 做法：
//   1. 五頁 body 各包一層 <div class="off-page">，「看詳情／回看板」的點擊改成頁內 hash 切換
//      （連結由 Svelte 產生，靜態改 href 會被 hydration 蓋掉，所以用事件攔截）
//   2. CSS 全部 inline；@font-face 只留頁面實際用到的 unicode 子集，再用 fontTools 把每個子集
//      裁到「這頁真的出現的字」後轉 data URI（丟掉 woff）——不裁的話光字型就 10 MB
//   3. Astro island 的 hydration 改成自帶：esbuild 把 svelte renderer + 各元件 chunk 打成單一 IIFE，
//      再用一段 inline script 沿用 astro 的 props 反序列化格式手動 mount（原本靠 import() 抓 /_astro/*.js，離線抓不到）
//   4. 拿掉 CSP meta、rss/sitemap link、preload —— 那些是給線上站用的，file:// 下只會擋路
//
// 旗標：--no-fonts 不內嵌字型（檔案小很多，中文改用系統字型）
//       --no-video 不內嵌影片（離線檔小很多，但影片區只剩標題卡）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const HOSPITAL = args.find((a) => !a.startsWith('-')) ?? '804';
const EMBED_FONTS = !args.includes('--no-fonts');
const EMBED_VIDEO = !args.includes('--no-video');
const OUT_DIR = path.join(ROOT, 'dist-offline');
const OUT = path.join(OUT_DIR, `${HOSPITAL}-offline.html`);

const ESBUILD = (() => {
  const base = path.join(ROOT, 'node_modules/.pnpm');
  const hit = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('@esbuild+linux-x64@'))
    .map((d) => path.join(base, d, 'node_modules/@esbuild/linux-x64/bin/esbuild'))
    .find((p) => fs.existsSync(p));
  if (!hit) throw new Error('找不到 esbuild 執行檔');
  return hit;
})();

const read = (p) => fs.readFileSync(p, 'utf8');
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// ── 1. 蒐集頁面 ──────────────────────────────────────────────
const boardFile = path.join(DIST, HOSPITAL, 'index.html');
if (!fs.existsSync(boardFile)) fail(`${boardFile} 不存在，先跑 pnpm build`);
const detailDir = path.join(DIST, HOSPITAL, 'detail');
const detailIds = fs.existsSync(detailDir)
  ? fs.readdirSync(detailDir).filter((d) => fs.existsSync(path.join(detailDir, d, 'index.html')))
  : [];

const pages = [
  { key: 'board', file: boardFile },
  ...detailIds.map((id) => ({ key: id, file: path.join(detailDir, id, 'index.html') })),
];

const assetPath = (url) => path.join(DIST, url.replace(/^\//, '').split('?')[0]);

function parsePage(file) {
  const html = read(file);
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
  return {
    title: (head.match(/<title>([\s\S]*?)<\/title>/) ?? [, ''])[1],
    description: (head.match(/<meta name="description" content="([^"]*)"/) ?? [, ''])[1],
    cssHrefs: [...head.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    headStyles: [...head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]),
    jsonLd: [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]),
    body,
  };
}

const parsed = pages.map((p) => ({ ...p, ...parsePage(p.file) }));

// ── 2. island：找出元件 chunk，改成自家 registry ────────────────
const components = new Map(); // name -> /_astro/xxx.hash.js
let rendererUrl = null;

for (const p of parsed) {
  p.body = p.body.replace(/<astro-island\b[^>]*>/g, (tag) => {
    const comp = tag.match(/component-url="([^"]+)"/)?.[1];
    const rend = tag.match(/renderer-url="([^"]+)"/)?.[1];
    if (rend) rendererUrl = rend;
    if (!comp) return tag;
    const name = path.basename(comp).split('.')[0];
    components.set(name, comp);
    return tag.replace('<astro-island', `<astro-island data-off="${name}"`);
  });
  // astro 的 island loader（靠 import() 抓 /_astro/*.js）離線沒用，拿掉
  p.body = p.body.replace(/<script>[\s\S]*?customElements\.define\("astro-island"[\s\S]*?<\/script>/g, '');
  p.body = p.body.replace(/<script>[\s\S]*?astro-island[\s\S]*?<\/script>/g, '');
}
if (!rendererUrl) fail('頁面裡找不到 renderer-url，astro island 結構可能變了');

const entry = path.join(OUT_DIR, '.entry.js');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  entry,
  [
    `import renderer from ${JSON.stringify(assetPath(rendererUrl))};`,
    ...[...components].map(([n, u], i) => `import C${i} from ${JSON.stringify(assetPath(u))};`),
    `window.__EMS_OFF__ = { renderer, comps: { ${[...components.keys()]
      .map((n, i) => `${JSON.stringify(n)}: C${i}`)
      .join(', ')} } };`,
  ].join('\n'),
);
const bundleFile = path.join(OUT_DIR, '.bundle.js');
execFileSync(ESBUILD, [
  entry,
  '--bundle',
  '--format=iife',
  '--platform=browser',
  '--minify',
  `--outfile=${bundleFile}`,
]);
const bundle = read(bundleFile);

// ── 3. CSS：合併、字型子集化、其他資產轉 data URI ────────────────
const usedChars = (() => {
  const set = new Set();
  const add = (s) => {
    for (const ch of s) set.add(ch.codePointAt(0));
  };
  for (const p of pages) add(read(p.file)); // 含 island props 內的中文資料
  add(bundle); // 圖表軸標籤等由 JS 產生的字
  return set;
})();

function parseUnicodeRange(spec) {
  return spec.split(',').map((raw) => {
    const t = raw.trim().replace(/^u\+/i, '');
    if (t.includes('?')) {
      const lo = parseInt(t.replace(/\?/g, '0'), 16);
      const hi = parseInt(t.replace(/\?/g, 'F'), 16);
      return [lo, hi];
    }
    const [a, b] = t.split('-');
    const lo = parseInt(a, 16);
    return [lo, b ? parseInt(b, 16) : lo];
  });
}

const rangeUsed = (ranges) => {
  for (const cp of usedChars) for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
};

const dataUri = (file) => {
  const ext = path.extname(file).slice(1);
  const mime =
    { woff2: 'font/woff2', woff: 'font/woff', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm' }[ext] ??
    'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

const fontStat = { kept: 0, dropped: 0, before: 0, after: 0 };

// 用 fontTools 把單一子集檔再裁到「實際用到的字」；失敗就退回原檔（只是比較大，不影響正確性）
// 快取以「用到的字」的雜湊當目錄名 —— 醫院資料改了字集就變，不能沿用舊快取（會缺字）
const charsHash = createHash('sha1')
  .update([...usedChars].sort((a, b) => a - b).join(','))
  .digest('hex')
  .slice(0, 12);
const CACHE = path.join(OUT_DIR, `.fontcache-${charsHash}`);
const charsFile = path.join(OUT_DIR, '.chars.txt');
let charsWritten = false;
function subsetFont(file) {
  if (!charsWritten) {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(charsFile, [...usedChars].map((cp) => String.fromCodePoint(cp)).join(''));
    charsWritten = true;
  }
  const out = path.join(CACHE, path.basename(file));
  if (fs.existsSync(out)) return out;
  try {
    execFileSync('python3', [
      '-m', 'fontTools.subset', file,
      `--text-file=${charsFile}`,
      '--flavor=woff2',
      '--layout-features=*',
      `--output-file=${out}`,
    ], { stdio: 'pipe' });
    return fs.existsSync(out) ? out : file;
  } catch (e) {
    console.warn(`  ! 字型裁切失敗，改用原檔：${path.basename(file)}`);
    return file;
  }
}

function processCss(css) {
  // @font-face：只留用得到的子集，且只保留 woff2
  css = css.replace(/@font-face\{[^}]*\}/g, (rule) => {
    const ur = rule.match(/unicode-range:([^;}]*)/)?.[1];
    if (!EMBED_FONTS) return '';
    if (ur && !rangeUsed(parseUnicodeRange(ur))) {
      fontStat.dropped++;
      return '';
    }
    const woff2 = rule.match(/url\((\/[^)]+\.woff2)\)/)?.[1];
    if (!woff2) return rule;
    const file = assetPath(woff2);
    if (!fs.existsSync(file)) return rule;
    const slim = subsetFont(file);
    fontStat.kept++;
    fontStat.before += fs.statSync(file).size;
    fontStat.after += fs.statSync(slim).size;
    return rule.replace(/src:[^;}]*/, `src:url(${dataUri(slim)}) format("woff2")`);
  });
  // 其餘 /_astro/ 資產（圖片等）
  css = css.replace(/url\((\/[^)"']+)\)/g, (m, url) => {
    const file = assetPath(url);
    return fs.existsSync(file) ? `url(${dataUri(file)})` : m;
  });
  return css;
}

const cssSeen = new Set();
let cssOut = '';
for (const p of parsed) {
  for (const href of p.cssHrefs) {
    if (cssSeen.has(href)) continue;
    cssSeen.add(href);
    const file = assetPath(href);
    if (!fs.existsSync(file)) fail(`缺 CSS：${file}`);
    cssOut += `\n/* ${href} */\n` + processCss(read(file));
  }
  for (const s of p.headStyles) cssOut += '\n' + processCss(s);
}

// ── 3.5 影片：整份檔案只放一份，執行時再接回 <video> ─────────────
// 戰時配置圖是「按下轉戰時」才由 island 渲染，SSR HTML 裡沒有 <video>，
// 影片路徑只存在 astro-island 的 props JSON 裡；而同一份 props 會出現在 5 個頁面，
// 直接把 data URI 塞回字串＝同一支影片存 5 份（實測 127 MB）。
// 作法：路徑原樣保留，另外輸出一份「路徑 → data URI」表，載入時轉 blob URL 再補上 src。
// --no-video 則把路徑清空，影片區只剩標題卡。
const videoStat = { kept: 0, dropped: 0, bytes: 0 };
const videoMap = {};
{
  const re = /\/videos\/[^"'&<>\\]+?\.(?:mp4|webm|jpg|jpeg|png|webp)/g;   // 影片與佇列縮圖
  const seen = new Set();
  for (const p of parsed) for (const m of p.body.matchAll(re)) seen.add(m[0]);
  for (const url of seen) {
    const file = assetPath(url);
    if (!fs.existsSync(file)) continue;
    if (!EMBED_VIDEO) { videoStat.dropped++; continue; }
    videoStat.kept++;
    videoStat.bytes += fs.statSync(file).size;
    videoMap[url] = dataUri(file);
  }
  if (!EMBED_VIDEO) for (const p of parsed) p.body = p.body.replace(re, '');
}

const videoShim = Object.keys(videoMap).length
  ? `
<script id="off-videos" type="application/json">${JSON.stringify(videoMap)}</script>
<script>
(function () {
  var M = JSON.parse(document.getElementById('off-videos').textContent);
  // 先攔 setAttribute/src：元素一被建立就換成 data URI，否則會先對 /videos/... 發一次
  // 注定失敗的請求（file:// 下是 ERR_FILE_NOT_FOUND，console 一片紅）。
  var key = function (s) { var i = String(s || '').indexOf('#'); return i < 0 ? s : s.slice(0, i); };
  var setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (n === 'src' && M[key(v)]) {
      setAttr.call(this, 'data-off-src', v);   // 留下原路徑，稍後才換得到 blob
      v = M[key(v)] + (String(v).indexOf('#') < 0 ? '' : String(v).slice(String(v).indexOf('#')));
    }
    return setAttr.call(this, n, v);
  };
  ['HTMLImageElement', 'HTMLVideoElement', 'HTMLMediaElement'].forEach(function (k) {
    var C = window[k];
    if (!C) return;
    var d = Object.getOwnPropertyDescriptor(C.prototype, 'src');
    if (!d || !d.set) return;
    Object.defineProperty(C.prototype, 'src', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, M[key(v)] ? M[key(v)] : v); },
    });
  });
  var B = {};   // 路徑 → blob URL（data URI 直接餵給 <video> 很吃記憶體，轉 blob 播起來才順）
  function fix(el) {
    var s = el.getAttribute('data-off-src') || el.getAttribute('src') || '';
    if (s.indexOf('/videos/') !== 0) return;
    var i = s.indexOf('#'), p = i < 0 ? s : s.slice(0, i), h = i < 0 ? '' : s.slice(i);
    if (B[p]) { setAttr.call(el, 'src', B[p] + h); if (el.tagName === 'VIDEO') el.load(); }
  }
  function fixAll() { document.querySelectorAll('video,img').forEach(fix); }
  Object.keys(M).forEach(function (p) {
    fetch(M[p]).then(function (r) { return r.blob(); }).then(function (b) {
      B[p] = URL.createObjectURL(b);
      fixAll();
    });
  });
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'VIDEO' || n.tagName === 'IMG') fix(n);
        if (n.querySelectorAll) n.querySelectorAll('video,img').forEach(fix);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', fixAll);
})();
</script>`
  : '';

// ── 4. body：頁面容器 + id 去重 ───────────────────────────────
let bodyOut = '';
for (const p of parsed) {
  let b = p.body;
  if (p.key !== 'board') {
    b = b.replace(/id="main"/g, `id="main-${p.key}"`).replace(/href="#main"/g, `href="#main-${p.key}"`);
  }
  bodyOut += `\n<div class="off-page" id="off-${p.key}" data-off-page="${p.key}">\n${b}\n</div>\n`;
}

const board = parsed[0];
const routes = parsed.map((p) => p.key);

// ── 5. runtime：hash 路由 + 手動 hydration ─────────────────────
const runtime = `
(function () {
  var RT = window.__EMS_OFF__;
  var ROUTES = ${JSON.stringify(routes)};

  // astro 的 props 反序列化格式（[type, value] tuple）
  var T = {
    0: function (v) { return obj(v); }, 1: function (v) { return v.map(one); },
    2: function (v) { return new RegExp(v); }, 3: function (v) { return new Date(v); },
    4: function (v) { return new Map(v.map(one)); }, 5: function (v) { return new Set(v.map(one)); },
    6: function (v) { return BigInt(v); }, 7: function (v) { return new URL(v); },
    8: function (v) { return new Uint8Array(v); }, 9: function (v) { return new Uint16Array(v); },
    10: function (v) { return new Uint32Array(v); }, 11: function (v) { return Number.POSITIVE_INFINITY * v; }
  };
  function one(t) { return t[0] in T ? T[t[0]](t[1]) : undefined; }
  function obj(v) {
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(Object.entries(v).map(function (e) { return [e[0], one(e[1])]; }));
  }

  function slotsOf(el) {
    var out = {};
    el.querySelectorAll('template[data-astro-template]').forEach(function (t) {
      if (t.closest('astro-island') === el) { out[t.getAttribute('data-astro-template') || 'default'] = t.innerHTML; t.remove(); }
    });
    el.querySelectorAll('astro-slot').forEach(function (s) {
      if (s.closest('astro-island') === el) out[s.getAttribute('name') || 'default'] = s.innerHTML;
    });
    return out;
  }

  function hydrate(root) {
    root.querySelectorAll('astro-island[ssr]').forEach(function (el) {
      var name = el.getAttribute('data-off');
      var Comp = RT && RT.comps[name];
      if (!Comp) { console.error('[offline] 找不到元件 ' + name); return; }
      var props = {};
      try { props = el.hasAttribute('props') ? obj(JSON.parse(el.getAttribute('props'))) : {}; }
      catch (e) { console.error('[offline] props 解析失敗', e); }
      try {
        RT.renderer(el)(Comp, props, slotsOf(el), { client: el.getAttribute('client') || 'load' });
        el.removeAttribute('ssr');
      } catch (e) { console.error('[offline] hydration 失敗 ' + name, e); }
    });
  }

  function show(key) {
    if (ROUTES.indexOf(key) < 0) key = ROUTES[0];
    ROUTES.forEach(function (k) {
      var el = document.getElementById('off-' + k);
      if (el) el.classList.toggle('is-active', k === key);
    });
    var page = document.getElementById('off-' + key);
    if (page) hydrate(page);
    document.title = page && page.dataset.offTitle ? page.dataset.offTitle : document.title;
    window.scrollTo(0, 0);
  }

  function keyFromHash() { return (location.hash || '').replace(/^#/, '') || ROUTES[0]; }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var href = a.getAttribute('href') || '';
    var m = href.match(/detail\\/([a-z0-9_-]+)\\/?$/i);
    if (m && ROUTES.indexOf(m[1]) >= 0) { e.preventDefault(); location.hash = '#' + m[1]; return; }
    if (/^(\\.\\.\\/)+$/.test(href) || /^\\/?${HOSPITAL}\\/?$/.test(href)) { e.preventDefault(); location.hash = '#' + ROUTES[0]; return; }
    if (href.charAt(0) === '#' || /^https?:/i.test(href) || /^mailto:/i.test(href)) return;
    // 其餘站內連結離線沒有對應內容 —— 導回線上站
    e.preventDefault();
    window.open('https://crinhealthcare.org' + (href.charAt(0) === '/' ? href : '/' + href), '_blank', 'noopener');
  });

  window.addEventListener('hashchange', function () { show(keyFromHash()); });
  show(keyFromHash());
})();
`;

// ── 6. 輸出 ────────────────────────────────────────────────
const favicon = path.join(DIST, 'favicon.svg');
const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${board.title}</title>
<meta name="description" content="${board.description}">
<meta name="generator" content="crinhealthcare.org offline bundle (scripts/build-offline.mjs)">
${fs.existsSync(favicon) ? `<link rel="icon" href="${dataUri(favicon)}">` : ''}
<style>
.off-page{display:none}
.off-page.is-active{display:block}
</style>
<style>${cssOut}</style>
${board.jsonLd.map((j) => `<script type="application/ld+json">${j}</script>`).join('\n')}
</head>
<body>
${bodyOut}
${videoShim}
<script>${bundle}</script>
<script>${runtime}</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
fs.rmSync(entry, { force: true });
fs.rmSync(bundleFile, { force: true });

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
console.log(`✓ ${path.relative(ROOT, OUT)}  ${mb(Buffer.byteLength(html))}`);
console.log(`  頁面：${routes.join(' / ')}`);
console.log(`  元件：${[...components.keys()].join(', ')}`);
console.log(
  EMBED_VIDEO
    ? `  影片與縮圖：內嵌 ${videoStat.kept} 個檔（原始 ${mb(videoStat.bytes)}）`
    : `  影片：未內嵌（--no-video），${videoStat.dropped} 支只剩標題卡`,
);
console.log(
  EMBED_FONTS
    ? `  字型：保留 ${fontStat.kept} 個子集、捨棄 ${fontStat.dropped} 個未用到的；裁切後 ${mb(fontStat.before)} → ${mb(fontStat.after)}`
    : '  字型：未內嵌（用系統字型）',
);
