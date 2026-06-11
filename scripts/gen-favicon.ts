// 從 public/favicon.svg 生成多尺寸 public/favicon.ico
// 用 sharp（librsvg）渲染，避免 ImageMagick 對 SVG text 的 Ghostscript 依賴。
// ICO 容器包入 PNG 影像（現代瀏覽器皆支援），手動組裝 ICONDIR 標頭。
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const SRC = 'public/favicon.svg';
const OUT = 'public/favicon.ico';
const SIZES = [16, 32, 48];

const pngs = await Promise.all(
  SIZES.map((s) => sharp(SRC, { density: 384 }).resize(s, s).png().toBuffer()),
);

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(pngs.length, 4); // image count

let offset = 6 + pngs.length * 16;
const entries = pngs.map((png, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(SIZES[i], 0); // width
  e.writeUInt8(SIZES[i], 1); // height
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8); // image byte size
  e.writeUInt32LE(offset, 12); // offset
  offset += png.length;
  return e;
});

const ico = Buffer.concat([header, ...entries, ...pngs]);
writeFileSync(OUT, ico);
console.log(`${OUT} 已生成（${SIZES.join('/')}px，共 ${ico.length} bytes）`);

// 輸出放大預覽供目視確認渲染正確
await sharp(SRC, { density: 384 }).resize(96, 96).png().toFile('/tmp/fav-preview.png');
console.log('預覽：/tmp/fav-preview.png');
