// 最小 xlsx 讀寫：只用 Node 內建 zlib，不引入第三方套件。
//
// 為什麼不用 exceljs/SheetJS：
//   1. 本服務握有 repo 推送金鑰，相依套件愈少愈好（供應鏈面積）。
//   2. 匯出是要交給能源署／台電的報告書，格式必須與原範本「逐格相同」——
//      公式、資料驗證、合併儲存格、列印範圍、樣式都要原封不動。
//      函式庫是「重新產生」活頁簿，一定會掉東西；這裡改成「對原範本做外科手術」：
//      只換掉指定儲存格的值，其餘位元組原樣搬過去，從根本上不可能掉格式。
import { inflateRawSync, deflateRawSync } from 'node:zlib';

// ── CRC32（zip 需要，Node 沒有內建）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── ZIP 讀取 ──
// 從尾端找 EOCD，走中央目錄取得每個檔案；解壓時以「本地檔頭自己的」名稱/額外欄位長度為準
// （中央目錄與本地檔頭的 extra 長度常常不同，用錯會偏移幾個位元組讀出亂碼）。
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目錄項目簽章錯誤');
    const method = buf.readUInt16LE(off + 10);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compSize = buf.readUInt32LE(off + 20);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ── ZIP 寫出 ──
export function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(content, { level: 9 });
    // 壓不小就存原樣（小檔常見）
    const useStore = deflated.length >= content.length;
    const data = useStore ? content : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // 檔名為 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(content.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ── XML 小工具 ──
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
// Excel 的儲存格換行在 XML 裡是 CRLF；統一正規化成 \n，下游（表單、JSON、比對）才不會
// 因為看不見的 \r 而出現「值明明一樣卻判定為已修改」。
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/\r\n/g, '\n');
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// A1 → { col, row }（col 為 1-based）
export function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`不合法的儲存格位址：${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

export function toRef(col, row) {
  let s = '';
  for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s + row;
}

// ── 樣式：儲存格 s="N" → cellXfs[N] → fillId → 填滿色 ──
// 這份問卷把「填寫／下拉／自動帶出」編碼在底色上（每張表 A4/A5/A6 是圖例），
// 所以欄位型別要靠這個判定。回傳的色鍵只求「同色得同鍵」，不求還原真實 RGB。
function readStyles(files) {
  const xml = files.get('xl/styles.xml')?.toString('utf8');
  if (!xml) return { fillOfXf: [] };

  const fills = [];
  const fillsBlock = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? '';
  for (const f of fillsBlock.matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
    const pat = /<patternFill\b([^>]*)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(f[1]);
    if (!pat || !/patternType="solid"/.test(pat[1])) { fills.push(null); continue; }
    const fg = /<fgColor\b([^>]*)\/>/.exec(pat[2] ?? '')?.[1] ?? '';
    const rgb = /rgb="([^"]+)"/.exec(fg)?.[1];
    const theme = /theme="(\d+)"/.exec(fg)?.[1];
    const tint = /tint="([^"]+)"/.exec(fg)?.[1];
    fills.push(rgb ? `rgb:${rgb}` : theme ? `theme:${theme}/${Number(tint ?? 0).toFixed(3)}` : null);
  }

  const fillOfXf = [];
  const xfBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  for (const xf of xfBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(/fillId="(\d+)"/.exec(xf[1])?.[1] ?? 0);
    fillOfXf.push(fills[id] ?? null);
  }
  return { fillOfXf };
}

// ── 活頁簿讀取 ──
// 回傳 { sheets: Map<工作表名, { path, cells, formulas, fills }> }
// 值一律以字串回傳（電號、統編這種前導零不能被數字化吃掉）。
export function readWorkbook(buf) {
  const files = unzip(buf);
  const { fillOfXf } = readStyles(files);
  const wbXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';

  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  // sharedStrings：<si> 內可能有多個 <t>（含格式的字串會被切段），要全部串起來
  const ss = [];
  const ssXml = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ssXml) {
    for (const si of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      let s = '';
      for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(t[1]);
      ss.push(s);
    }
  }

  const sheets = new Map();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = unesc(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = rels.get(rid);
    if (!path || !files.has(path)) continue;

    const xml = files.get(path).toString('utf8');
    const cells = new Map();
    const formulas = new Set();
    const fills = new Map();
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      // 記下公式格：這些是「自動帶出」欄位，匯入不得寫入、表單不得當輸入框
      if (/<f[\s>/]/.test(body)) formulas.add(ref);
      const s = /s="(\d+)"/.exec(attrs)?.[1];
      if (s !== undefined && fillOfXf[Number(s)]) fills.set(ref, fillOfXf[Number(s)]);
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      if (type === 'inlineStr') {
        let s = '';
        for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(t[1]);
        if (s !== '') cells.set(ref, s);
        continue;
      }
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (v === undefined) continue;
      cells.set(ref, type === 's' ? (ss[Number(v)] ?? '') : unesc(v));
    }
    sheets.set(name, { path, cells, formulas, fills });
  }
  return { files, sheets };
}

// ── 把值寫回「原範本」的指定儲存格 ──
// patches: Map<工作表名, Map<A1, 值>>。值為 number → 寫成數值格；string → 寫成 inlineStr；'' → 清空。
//
// ⚠️ 數值一定要寫成數值格，不能圖方便全寫 inlineStr：
//    表P 的合計欄是 =SUM(I8:L8)／=MAX(D8:G8)，文字在 SUM 裡會被當 0，
//    整份交差報表的月合計、年合計會全部變空（踩過一次，靠 SUM 迴歸測試擋住）。
// 用 inlineStr 而非 sharedStrings 是刻意的：不必動 sharedStrings 的索引與 count，
// 那個動了極容易讓 Excel 判定檔案毀損。
// 有公式的格（<f>）一律跳過——那些是「自動帶出」欄位，值該由 Excel 自己算。
export function patchWorkbook(buf, patches) {
  const { files, sheets } = readWorkbook(buf);
  const out = new Map(files);
  const skippedFormula = [];

  for (const [sheetName, cellMap] of patches) {
    const sheet = sheets.get(sheetName);
    if (!sheet) throw new Error(`範本裡沒有工作表：${sheetName}`);
    let xml = out.get(sheet.path).toString('utf8');

    for (const [ref, value] of cellMap) {
      const { row } = parseRef(ref);
      const cellRe = new RegExp(`<c\\b([^>]*?r="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
      const hit = cellRe.exec(xml);

      if (hit && /<f[\s>]/.test(hit[2] ?? '')) { skippedFormula.push(`${sheetName}!${ref}`); continue; }

      const attrs = (hit?.[1] ?? ` r="${ref}"`).replace(/\s*t="[^"]*"/, '');
      const cell =
        value === '' || value === null || value === undefined
          ? `<c${attrs}/>`
          : typeof value === 'number'
            ? `<c${attrs}><v>${value}</v></c>`
            : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;

      if (hit) { xml = xml.slice(0, hit.index) + cell + xml.slice(hit.index + hit[0].length); continue; }

      // 該格原本不存在 → 插進所屬列（列不存在就整列補上，並維持列號遞增）
      const rowRe = new RegExp(`<row\\b([^>]*?r="${row}"[^>]*?)(?:/>|>([\\s\\S]*?)</row>)`);
      const rowHit = rowRe.exec(xml);
      if (rowHit) {
        const inner = (rowHit[2] ?? '') + cell;
        const sorted = [...inner.matchAll(/<c\b[^>]*?r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)]
          .sort((a, b) => parseRef(a[1]).col - parseRef(b[1]).col)
          .map((x) => x[0]).join('');
        const rebuilt = `<row${rowHit[1]}>${sorted}</row>`;
        xml = xml.slice(0, rowHit.index) + rebuilt + xml.slice(rowHit.index + rowHit[0].length);
      } else {
        const newRow = `<row r="${row}">${cell}</row>`;
        const rows = [...xml.matchAll(/<row\b[^>]*?r="(\d+)"/g)];
        const after = rows.find((r) => Number(r[1]) > row);
        if (after) xml = xml.slice(0, after.index) + newRow + xml.slice(after.index);
        else xml = xml.replace('</sheetData>', `${newRow}</sheetData>`);
      }
    }
    out.set(sheet.path, Buffer.from(xml, 'utf8'));
  }
  return { buffer: zip(out), skippedFormula };
}
