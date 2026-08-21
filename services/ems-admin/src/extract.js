// 佐證檔案 → 結構化欄位值。
//
// 兩條路，難度差很多，刻意分開處理：
//   xlsx／csv  → 走 audit-io.js 的逐格對照（V2 範本座標）。確定性、零成本、可重現。
//   pdf／影像  → 走 Claude 的文件理解。台電電費單各院排版不一致，寫死規則會一直壞。
//
// **不管走哪一條，結果都不直接生效**：每一格回來時標記 todo（待複驗）或 low（信心低），
// 由院方逐格確認過才會變 ok，還有 todo/low 就擋住送出（見 audit-schema.pendingCells）。
// 這一條是整個功能的安全底線，改動前先想清楚：掃描影本的辨識率不可能一直是 100%。
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { blockById, fieldsOf, coerce } from './audit-schema.js';
import { importAudit } from './audit-io.js';

// ── 供解析的欄位（計算欄位不解析，它由來源欄推導） ──
const extractable = (block) => fieldsOf(block).filter((f) => !f.computed);

// ── 結構化輸出的 JSON schema ──
// 值一律收字串再用 coerce() 正規化：解析器常回「1,234.5 kWh」「NT$3,872,510」
// 這種帶千分位與單位的寫法，直接宣告成 number 只會換來一堆型別錯誤與重試。
//
// 🔴 **不可以用 union 型別（['string','null']）**：結構化輸出對「帶 union 的參數」有
// 上限 16 個，電費單 25 欄 ×（值＋頁碼）＝ 50 個，直接 400
// （"Schemas contains too many parameters with union types"）。
// 所以改用同型別的哨兵值：值缺漏用空字串、頁碼不確定用 0，回來再轉成 undefined／null。
function outputSchema(block) {
  const cols = extractable(block);
  const values = {}, pages = {};
  for (const c of cols) {
    values[c.key] = { type: 'string', description: `${c.label}${c.unit ? `（${c.unit}）` : ''}${c.hint ? ` — ${c.hint}` : ''}；文件上沒有就填空字串` };
    pages[c.key] = { type: 'integer', description: `${c.label} 出現在文件的第幾頁（1 起算）；沒有或不確定填 0` };
  }
  const keys = cols.map((c) => c.key);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['rows', 'notes'],
    properties: {
      rows: {
        type: 'array',
        description: block.kind === 'table'
          ? `每一筆${block.rowLabel || '資料'}一個元素；文件裡有幾筆就回幾筆，沒有就回空陣列`
          : '固定回一個元素',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['values', 'pages', 'lowConfidence'],
          properties: {
            values: { type: 'object', additionalProperties: false, required: keys, properties: values },
            pages: { type: 'object', additionalProperties: false, required: keys, properties: pages },
            lowConfidence: {
              type: 'array', items: { type: 'string', enum: keys },
              description: '看不清楚、需要人工核對的欄位鍵名；寧可多列也不要漏列',
            },
          },
        },
      },
      notes: { type: 'string', description: '解析過程中值得院方知道的事，例如缺頁、單位不一致、疑似跨期。沒有就回空字串' },
    },
  };
}

function systemPrompt(block) {
  return [
    '你在協助台灣的軍醫院承辦人員把電力健檢的佐證文件轉成結構化欄位。',
    `目前要填的是「${block.label}」這一區（依據：軍醫院電力健檢公文${block.attachment}）。`,
    block.intro || '',
    '',
    '規則：',
    '- 只抄文件上真的看得到的數字與文字，看不到就填空字串。**絕對不要推算、不要補值、不要從其他欄位反推。**',
    '- 金額與度數保留原始數字，可以帶千分位；單位不用寫進值裡。',
    '- 台灣的民國年要換算成西元年：民國年＋1911（例如 114 年 3 月 → 2025-03、115 年 1 月 → 2026-01）。',
    '- 只要是模糊、被遮住、手寫、或你不確定自己讀對的欄位，就把它的鍵名放進 lowConfidence。寧可多列。',
    '- pages 要填該欄位實際出現的頁碼，讓院方能翻回原文核對。',
    block.kind === 'table'
      ? `- 文件裡有幾筆${block.rowLabel || '資料'}就回幾筆，不要合併也不要拆開。`
      : '- 這一區只有一筆，rows 固定回一個元素。',
  ].filter(Boolean).join('\n');
}

let client = null;
const getClient = () => (client ||= new Anthropic({ apiKey: config.anthropicApiKey }));

export const extractionEnabled = () => Boolean(config.anthropicApiKey);

// ── PDF／影像 ──
async function extractWithModel(block, file, buf) {
  const b64 = buf.toString('base64');
  const source = file.kind === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: file.mime, data: b64 } };

  // 串流：掃描件是長輸入、Opus 5 預設開思考，非串流容易撞 HTTP timeout
  const stream = getClient().messages.stream({
    model: config.extractModel,
    max_tokens: 32000,
    system: systemPrompt(block),
    output_config: { format: { type: 'json_schema', schema: outputSchema(block) }, effort: 'high' },
    messages: [{
      role: 'user',
      content: [source, { type: 'text', text: `請把這份文件裡屬於「${block.label}」的資料抽出來。` }],
    }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    const e = new Error('模型拒絕處理這份文件，請改用人工填寫或聯絡維護窗口');
    e.code = 'refusal';
    throw e;
  }
  const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { const e = new Error('解析結果不是合法 JSON'); e.code = 'bad_output'; throw e; }
  return { parsed, usage: msg.usage };
}

// ── xlsx：走既有的 V2 範本逐格引擎，再把表A/表E/表P 對回本系統的區塊 ──
// 對照關係：表A 冰水主機 → chillers／表E 能源設備盤查 → majorLoads／表P 用電統計 → bills。
// 表P 把電號、電價種類放在表頭（每月共用），這裡複製到每一列，因為本系統一列就是一張帳單。
function fromWorkbook(block, buf) {
  const { audit, report } = importAudit(buf);
  const mk = (values) => ({ values, pages: {}, lowConfidence: [] });
  let rows = [];
  if (block.id === 'chillers') rows = (audit.chillers || []).map(mk);
  else if (block.id === 'majorLoads') rows = (audit.inventory || []).map(mk);
  else if (block.id === 'bills') {
    const p = audit.power || {};
    const head = { meterNo: p.meterNo, tariffType: p.tariff, timeType: p.timeType };
    rows = (p.months || []).map((m) => mk({
      ...head,
      period: m.month ? `${new Date().getFullYear()}-${String(m.month).padStart(2, '0')}` : undefined,
      contractCapacity: m.contractCapacity,
      demandPeak: m.demandPeak, demandHalfPeak: m.demandHalfPeak,
      demandSatHalfPeak: m.demandSatHalfPeak, demandOffPeak: m.demandOffPeak,
      usePeak: m.usePeak, useHalfPeak: m.useHalfPeak,
      useSatHalfPeak: m.useSatHalfPeak, useOffPeak: m.useOffPeak,
      wheelPeak: m.wheelPeak, wheelHalfPeak: m.wheelHalfPeak,
      wheelSatHalfPeak: m.wheelSatHalfPeak, wheelOffPeak: m.wheelOffPeak,
      feeTotal: m.totalFee,
    }));
    // 範本只有月份沒有年份 → period 的年份是猜的，一律標成待複驗中的「信心低」
    for (const r of rows) if (r.values.period) r.lowConfidence.push('period');
  } else {
    const e = new Error(`「${block.label}」沒有對應的 Excel 範本工作表，請改用 PDF 或直接輸入`);
    e.code = 'no_sheet_mapping';
    throw e;
  }
  const notes = [
    ...(report.warnings || []).slice(0, 8),
    block.id === 'bills' && rows.length ? '⚠️ V2 範本的用電統計只有月份沒有年份，計費期間的年份是推算的，請務必核對。' : '',
  ].filter(Boolean).join('\n');
  return { parsed: { rows, notes }, usage: null };
}

// ── 對外：解析一個檔案，回傳可直接併進區塊的列 ──
// 回傳 { rows: [{ values, meta }], notes, stats }
export async function extractFile(blockId, file, buf) {
  const block = blockById(blockId);
  if (!block) throw new Error('unknown_block');

  let parsed, usage = null;
  if (file.kind === 'xlsx' || file.kind === 'csv') {
    ({ parsed, usage } = fromWorkbook(block, buf));
  } else {
    if (!extractionEnabled()) {
      const e = new Error('尚未設定文件解析服務（ANTHROPIC_API_KEY），請直接手動輸入，或聯絡維護窗口開通');
      e.code = 'extract_disabled';
      throw e;
    }
    ({ parsed, usage } = await extractWithModel(block, file, buf));
  }

  const cols = extractable(block);
  const rows = [];
  let todo = 0, low = 0;
  for (const raw of parsed.rows || []) {
    const values = {}, meta = {};
    for (const c of cols) {
      const v = coerce(raw.values?.[c.key], c.type);
      if (v === undefined) continue;
      values[c.key] = v;
      const isLow = Array.isArray(raw.lowConfidence) && raw.lowConfidence.includes(c.key);
      const page = Number(raw.pages?.[c.key]);
      meta[c.key] = {
        state: isLow ? 'low' : 'todo',
        // 頁碼 0 是「不確定」的哨兵（見 outputSchema 的註解），對外一律轉回 null
        source: { file: file.id, name: file.displayName, page: Number.isFinite(page) && page > 0 ? page : null },
      };
      if (isLow) low++; else todo++;
    }
    if (Object.keys(values).length) rows.push({ values, meta });
  }
  return {
    rows,
    notes: parsed.notes || '',
    stats: { rows: rows.length, cells: todo + low, todo, low, usage },
  };
}
