// 佐證檔案上傳：multipart/form-data 解析 ＋ 落地 ＋ 檔名正規化。
// 無框架、無相依套件（本服務只有 zod 與 anthropic sdk 兩個 runtime 相依）。
import { writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { config } from './config.js';
import { uploadDirFor, safeId } from './audit-store.js';
import { blockById } from './audit-schema.js';

// 允許的型別。刻意用白名單：這個目錄的內容之後會餵進解析器，也會被下載回去。
export const KINDS = {
  'application/pdf': { kind: 'pdf', ext: '.pdf' },
  'image/jpeg': { kind: 'image', ext: '.jpg' },
  'image/png': { kind: 'image', ext: '.png' },
  'image/webp': { kind: 'image', ext: '.webp' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'xlsx', ext: '.xlsx' },
  'text/csv': { kind: 'csv', ext: '.csv' },
};

// 副檔名兜底：瀏覽器對 xlsx/csv 的 MIME 常常給 application/octet-stream
const BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv' };

export function classify(mime, filename) {
  const byMime = KINDS[String(mime || '').split(';')[0].trim()];
  if (byMime) return byMime;
  const guess = BY_EXT[extname(String(filename || '')).toLowerCase()];
  return guess ? KINDS[guess] : null;
}

// ── multipart 解析 ──
// 只解析我們自己前端送出的那一種：一個 file 欄位 ＋ 幾個純文字欄位。
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('bad_multipart');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new Error('bad_multipart');
  pos += boundary.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;     // 結尾的 "--"
    if (buf[pos] === 0x0d) pos += 2;                            // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos, 'utf8');
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    let next = buf.indexOf(boundary, headEnd);
    if (next < 0) next = buf.length;
    const body = buf.slice(headEnd + 4, Math.max(headEnd + 4, next - 2));   // 去掉尾端 CRLF
    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    // RFC 5987 的 filename*=UTF-8''… （少數瀏覽器/工具會用）
    const fileStarM = /filename\*=\s*UTF-8''([^\r\n;]+)/i.exec(head);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(head);
    // head 已經用 utf8 解碼過，中文檔名這裡就是正確字串。
    // 千萬不要再套 decodeURIComponent(escape(x)) 那個 latin1 老把戲——
    // 對已經正確的字串做會直接丟 URIError（實測「用電統計_V2範本.xlsx」就炸了）。
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileStarM ? safeDecode(fileStarM[1]) : fileM ? fileM[1] : null,
      contentType: typeM ? typeM[1].trim() : null,
      data: body,
    });
    pos = next + boundary.length;
  }
  return parts;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── 檔名 ──
// 附件三要求「檔名可辨識，檔名包含院區、資料類型及年月」，所以不是原樣存原檔名，
// 而是自動改成 <院所>_<資料類型>_<年月>.<ext>；院方不用記命名規則。
// 磁碟上的實際檔名另外走 ASCII-safe（中文檔名跨系統很容易出事），中文名只做顯示與下載。
export function suggestName(hid, blockId, period, ext) {
  const b = blockById(blockId);
  const ym = String(period || '').replace(/\D/g, '').slice(0, 6) || yearMonthNow();
  return `${safeId(hid)}_${b?.label || blockId}_${ym}${ext}`;
}

function yearMonthNow() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function storeUpload(hid, blockId, { filename, contentType, data, period }) {
  const kind = classify(contentType, filename);
  if (!kind) { const e = new Error('unsupported_type'); e.code = 'unsupported_type'; throw e; }
  if (data.length > config.uploadMaxBytes) { const e = new Error('too_large'); e.code = 'too_large'; throw e; }

  const dir = uploadDirFor(hid);
  await mkdir(dir, { recursive: true });
  const storedName = `${safeId(hid)}_${blockId}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}${kind.ext}`;
  await writeFile(join(dir, storedName), data);

  return {
    id: storedName.replace(kind.ext, ''),
    block: blockId,
    storedName,
    displayName: suggestName(hid, blockId, period, kind.ext),
    originalName: filename || '未命名',
    kind: kind.kind,
    mime: Object.keys(KINDS).find((k) => KINDS[k] === kind) || contentType,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex').slice(0, 16),
    uploadedAt: new Date().toISOString(),
    parse: { state: 'pending' },
  };
}
