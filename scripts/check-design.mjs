// 設計規範守門 v2（團隊共用；v1 源自 dreamer868，v2 加 css 白名單＋掃 .svelte）：
// 掃 src/ 下所有 .css/.astro/.svelte，違規即 exit 1（pnpm build 前自動跑）。
// 規則（見 src/styles/variables.css 檔頭）：
// 1. font-size 禁用 px（一律 var(--text-*) 階梯）
// 2. 顏色（hex / rgb() / hsl()）只准出現在 src/styles/variables.css
// 3. 禁 !important
// 4. 禁外部 CDN（fonts.googleapis / cdnjs / unpkg / jsdelivr）
// 5. 統一 css 檔案：src/ 下的 .css 只准 src/styles/ 白名單那幾檔，新增即 fail
//    （元件樣式寫 Astro/Svelte scoped <style> 或進 global.css）
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";

// 掃描範圍：Astro 站的 src/，外加獨立部署但同 repo 的 ems-admin 靜態前端
// （2026-08-06 加：該服務 public/ 直接靜態送出、不進 astro build，
//  先前不在守門範圍內，整份 style.css 漂成 hex 色 + px 字級）。
const ROOTS = [
  {
    dir: "src",
    tokenFile: join("src", "styles", "variables.css"),
    // 舊站遷移期可暫加既有檔（凍結用，禁再擴充）；新站一律只有這兩檔。
    styleDir: join("src", "styles"),
    styleWhitelist: new Set(["variables.css", "global.css"]),
    // TODO(待用戶拍板)：本站字級階梯仍是舊值（--text-xs 12px 起），
    // 未達團隊 v2 第 6 條「階梯 ≥18px」。抬高會動到全站視覺，故先不強制。
    ladderFloor: false,
  },
  {
    dir: join("services", "ems-admin", "public"),
    tokenFile: join("services", "ems-admin", "public", "tokens.css"),
    styleDir: join("services", "ems-admin", "public"),
    styleWhitelist: new Set(["tokens.css", "style.css"]),
    ladderFloor: true,
  },
];
const exts = new Set([".css", ".astro", ".svelte"]);
const LADDER_MIN_REM = 1.125; // 18px
// TODO(遷移遞延 2026-07-20，禁再擴充)：下列檔暫豁免「px 字級」單一規則——
// SVG 圖表文字字級走 viewBox 座標系（px＝user unit，隨圖等比縮放），
// 換成 rem 階梯會與圖表幾何脫鉤，需視覺調校後才能收（見 docs/ems-peak-shave.md）。
// 其餘四條規則仍照掃。
const PX_FONT_EXEMPT = new Set([
  join("src", "components", "charts", "PeakShaveChart.svelte"),
]);
const violations = [];

function walk(dir, root) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root);
    else if (exts.has(extname(p))) scan(p, root);
  }
}

// 規則 6：--text-* 階梯 token 值一律 ≥18px（clamp() 以最小值計），
// 堵「把 token 本身開小門」的洞。
function checkLadder(rel, lines) {
  lines.forEach((line, i) => {
    const m = /^\s*(--text-[a-z0-9-]+)\s*:\s*(.+?);/i.exec(line);
    if (!m) return;
    const raw = m[2].trim();
    const first = /(-?[0-9.]+)\s*rem/.exec(raw.startsWith("clamp") ? raw.slice(6) : raw);
    if (!first) return;
    if (Number(first[1]) < LADDER_MIN_REM)
      violations.push(`${rel}:${i + 1} 字級階梯低於 18px：${m[1]} = ${raw}（最小 ${LADDER_MIN_REM}rem）`);
  });
}

function scan(file, root) {
  const rel = relative(".", file);
  if (extname(file) === ".css") {
    const inStyles = rel.startsWith(root.styleDir + "/");
    if (!inStyles || !root.styleWhitelist.has(basename(file)))
      violations.push(
        `${rel} css 檔不在白名單（統一 css：${root.styleDir}/{${[...root.styleWhitelist].join(",")}}；元件樣式用 scoped <style>）`
      );
  }
  const isTokenFile = rel === root.tokenFile;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const loc = `${rel}:${i + 1}`;
    if (!PX_FONT_EXEMPT.has(rel) && /font-size\s*:\s*[0-9.]+px/i.test(line))
      violations.push(`${loc} px 字級（改用 var(--text-*)）: ${line.trim()}`);
    if (!isTokenFile && /(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/.test(line) && !/url\(/.test(line))
      violations.push(`${loc} token 外硬編顏色（改用 var(--color-*)）: ${line.trim()}`);
    if (/!important/.test(line))
      violations.push(`${loc} 禁用 !important: ${line.trim()}`);
    if (/(fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare|unpkg\.com|cdn\.jsdelivr)/.test(line))
      violations.push(`${loc} 外部 CDN（字型/資源一律自託管或系統堆疊）: ${line.trim()}`);
  });
  if (isTokenFile && root.ladderFloor) checkLadder(rel, lines);
}

for (const root of ROOTS) walk(root.dir, root);
if (violations.length) {
  console.error(`設計規範違規 ${violations.length} 處：\n` + violations.join("\n"));
  process.exit(1);
}
console.log(
  `設計規範檢查通過（${ROOTS.map((r) => r.dir).join(" + ")}）：` +
    "css 白名單、無 px 字級、無 token 外顏色、無 !important、無外部 CDN。"
);
