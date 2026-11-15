// 報告匯出：XLSX／CSV／DOCX／PDF／HTML（PRD §8.3）。每次匯出都存成封存檔並記雜湊。
// PDF 用主機上的 headless Chromium 把 HTML 印成 PDF（CHROME_PATH 可覆寫）；找不到瀏覽器時回明確錯誤，不產出假檔。
import { mkdir, writeFile, readFile, access, rm, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { q, insert, newId, nowIso, audit, sha256 } from './db.js';
import { config } from '../config.js';
import { assertCan } from './authz.js';
import { conflict, notFound, HttpError, j, exclusiveEndToInclusive } from './util.js';
import { buildWorkbook, zip, esc } from '../xlsx.js';
import { getRun } from './reports.js';
import { STATE_LABEL } from './calc.js';

const exec = promisify(execFile);
const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', html: 'text/html; charset=utf-8',
};
export const exportMime = (f) => MIME[f];

const fmtVal = (f) => {
  if (!f) return '';
  if (f.masked) return '（需權限）';
  if (f.value === null || f.value === undefined) return STATE_LABEL[f.state] || '缺漏';
  return typeof f.value === 'number' ? f.value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(f.value);
};

// 報告內容的中性結構：章節 → 欄位 → 值（含狀態、指標、計算展開摘要）
function model(run) {
  const maps = run.template.mappings;
  const sections = (run.template.sections || []).map((s) => ({
    ...s,
    fields: maps.filter((m) => m.section === s.id).map((m) => {
      const f = run.results.fields?.[m.field_id] || {};
      const ind = f.indicator ? run.results.indicators?.[f.indicator] : null;
      return { id: m.field_id, label: m.label, required: !!m.required, kind: m.source_kind, value: f.value, unit: f.unit || ind?.unit || '', state: f.state, masked: f.masked,
        indicator: f.indicator, formula: ind?.trace?.formula || '', notes: ind?.trace?.notes || [], factors: ind?.trace?.factors || [], list: f.list, quality: f.quality };
    }),
  }));
  return {
    title: run.case_name, year: run.year, template: `${run.template.name}（${run.template.standard_version || run.template.standard}，模板 v${run.template.version}）`,
    runNo: run.run_no, status: run.status, hash: run.hash, datasetId: run.dataset_id, datasetHash: run.dataset_hash, approvedAt: run.approved_at, lockedAt: run.locked_at,
    factorVersions: run.factor_versions, ruleVersions: run.rule_versions, sections,
  };
}

function toRows(m) {
  const rows = [[{ v: m.title, s: 'title' }], [{ v: `${m.template}｜第 ${m.runNo} 版｜狀態 ${m.status}`, s: 'note' }], [{ v: `報告雜湊 ${m.hash}`, s: 'note' }], []];
  rows.push(['章節', '欄位', '數值', '單位', '狀態', '指標', '計算式', '說明'].map((v) => ({ v, s: 'head' })));
  for (const s of m.sections) for (const f of s.fields) {
    if (f.kind === 'evidence_list') { for (const e of f.list || []) rows.push([s.title, f.label, e.filename, '', '', e.metric_code, `${e.asset_name} ${e.period_start}～${exclusiveEndToInclusive(e.period_end)}`, `sha256 ${e.sha256.slice(0, 12)}…`].map((v) => ({ v, s: 'cell' }))); continue; }
    if (f.kind === 'quality') { rows.push([s.title, f.label, JSON.stringify(f.quality?.byState || {}), '', '', '', `採用值 ${f.quality?.facts ?? 0} 筆、高影響裁決 ${f.quality?.highImpact ?? 0} 筆、未結差異 ${f.quality?.openCases ?? 0} 件`, ''].map((v) => ({ v, s: 'cell' }))); continue; }
    rows.push([s.title, f.label, typeof f.value === 'number' && !f.masked ? f.value : fmtVal(f), f.unit, STATE_LABEL[f.state] || f.state || '', f.indicator || '', f.formula, f.notes.join('；')].map((v) => ({ v, s: 'cell' })));
  }
  rows.push([]);
  rows.push([{ v: '係數版本', s: 'head' }, { v: '規則版本', s: 'head' }]);
  rows.push([{ v: Object.entries(m.factorVersions || {}).map(([k, v]) => `${k} v${v}`).join('\n'), s: 'cell' }, { v: Object.entries(m.ruleVersions || {}).map(([k, v]) => `${k} v${v}`).join('\n'), s: 'cell' }]);
  return rows;
}

function csv(m) {
  const lines = [['章節', '欄位', '數值', '單位', '狀態', '指標', '計算式', '說明']];
  for (const s of m.sections) for (const f of s.fields) {
    if (f.kind === 'evidence_list') { for (const e of f.list || []) lines.push([s.title, f.label, e.filename, '', '', e.metric_code, e.asset_name, e.sha256]); continue; }
    if (f.kind === 'quality') { lines.push([s.title, f.label, JSON.stringify(f.quality), '', '', '', '', '']); continue; }
    lines.push([s.title, f.label, f.masked ? '' : f.value ?? '', f.unit, STATE_LABEL[f.state] || f.state || '', f.indicator || '', f.formula, f.notes.join('；')]);
  }
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return Buffer.from('﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n'), 'utf8');
}

export function html(m) {
  const sec = m.sections.map((s) => `<section><h2>${esc(s.title)}</h2><table><thead><tr><th>欄位</th><th>數值</th><th>單位</th><th>狀態</th><th>計算與說明</th></tr></thead><tbody>${
    s.fields.map((f) => {
      if (f.kind === 'evidence_list') return `<tr><td>${esc(f.label)}</td><td colspan="4"><ol>${(f.list || []).map((e) => `<li>${esc(e.filename)}（${esc(e.asset_name)}，${esc(e.metric_code)}，sha256 ${esc(e.sha256.slice(0, 16))}…）</li>`).join('') || '<li>無</li>'}</ol></td></tr>`;
      if (f.kind === 'quality') return `<tr><td>${esc(f.label)}</td><td colspan="4">採用值 ${f.quality?.facts ?? 0} 筆；狀態 ${esc(JSON.stringify(f.quality?.byState || {}))}；高影響裁決 ${f.quality?.highImpact ?? 0}；未結差異 ${f.quality?.openCases ?? 0}</td></tr>`;
      return `<tr><td>${esc(f.label)}</td><td class="num">${esc(fmtVal(f))}</td><td>${esc(f.unit)}</td><td>${esc(STATE_LABEL[f.state] || f.state || '')}</td><td>${esc(f.formula)}${f.notes.length ? `<br><small>${esc(f.notes.join('；'))}</small>` : ''}</td></tr>`;
    }).join('')}</tbody></table></section>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
    body{font-family:"Noto Sans CJK TC","Noto Serif CJK TC",sans-serif;font-size:12pt;margin:18mm;color:#111}
    h1{font-size:18pt;margin:0 0 4pt}h2{font-size:14pt;margin:14pt 0 4pt;border-bottom:1px solid #999}
    table{border-collapse:collapse;width:100%;font-size:10.5pt}th,td{border:1px solid #bbb;padding:3pt 5pt;vertical-align:top;text-align:left}th{background:#eee}
    .num{text-align:right;white-space:nowrap}.meta{font-size:9.5pt;color:#444}small{color:#555}</style></head><body>
    <h1>${esc(m.title)}</h1><p class="meta">${esc(m.template)}｜第 ${m.runNo} 版｜狀態：${esc(m.status)}${m.lockedAt ? `｜封存：${esc(m.lockedAt)}` : ''}<br>
    報告雜湊 ${esc(m.hash)}｜資料集 ${esc(m.datasetId)}${m.datasetHash ? `（雜湊 ${esc(m.datasetHash.slice(0, 16))}…）` : ''}</p>
    <p class="meta">缺漏、不適用、估計值一律明示，不以 0 代替。本文件為依官方格式準備之資料，不代表已完成官方申報。</p>${sec}
    <h2>係數與規則版本</h2><p class="meta">${esc(Object.entries(m.factorVersions || {}).map(([k, v]) => `${k} v${v}`).join('、'))}</p>
    <p class="meta">${esc(Object.entries(m.ruleVersions || {}).map(([k, v]) => `${k} v${v}`).join('、'))}</p></body></html>`;
}

function docx(m) {
  const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const cell = (t, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${head ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const row = (cells, head) => `<w:tr>${cells.map((c) => cell(c, head)).join('')}</w:tr>`;
  const tbl = (rows) => `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
  let body = p(m.title, 'Title') + p(`${m.template}｜第 ${m.runNo} 版｜狀態 ${m.status}`) + p(`報告雜湊 ${m.hash}`) + p('缺漏、不適用、估計值一律明示，不以 0 代替。本文件不代表已完成官方申報。');
  for (const s of m.sections) {
    body += p(s.title, 'Heading1');
    const rows = [row(['欄位', '數值', '單位', '狀態', '計算與說明'], true)];
    for (const f of s.fields) {
      if (f.kind === 'evidence_list') { for (const e of f.list || []) rows.push(row([f.label, e.filename, '', '', `${e.asset_name}｜sha256 ${e.sha256.slice(0, 16)}…`])); continue; }
      if (f.kind === 'quality') { rows.push(row([f.label, String(f.quality?.facts ?? 0), '筆', '', JSON.stringify(f.quality?.byState || {})])); continue; }
      rows.push(row([f.label, fmtVal(f), f.unit, STATE_LABEL[f.state] || f.state || '', [f.formula, ...f.notes].filter(Boolean).join('；')]));
    }
    body += tbl(rows);
  }
  body += p('係數與規則版本', 'Heading1') + p(Object.entries(m.factorVersions || {}).map(([k, v]) => `${k} v${v}`).join('、')) + p(Object.entries(m.ruleVersions || {}).map(([k, v]) => `${k} v${v}`).join('、'));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files = new Map([
    ['[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ['word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')],
    ['word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="Microsoft JhengHei"/><w:sz w:val="22"/><w:lang w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`)],
    ['word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`)],
  ]);
  return zip(files);
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const home = process.env.HOME || '/root';
  return [`${home}/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell`, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
}
async function pdf(htmlStr) {
  const cands = [].concat(chromePath());
  let bin = null;
  for (const c of cands) { try { await access(c); bin = c; break; } catch { /* 下一個 */ } }
  if (!bin) throw new HttpError(503, '主機沒有可用的 Chromium，無法產生 PDF；請改下載 DOCX 或 HTML 列印版（維運：設定 CHROME_PATH）');
  const dir = await mkdtemp(join(tmpdir(), 'ems-pdf-'));
  try {
    const src = join(dir, 'r.html'); const out = join(dir, 'r.pdf');
    await writeFile(src, htmlStr, 'utf8');
    await exec(bin, ['--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${src}`], { timeout: 60000 });
    return await readFile(out);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// 產生（或取回已存在的同格式封存檔）
export async function exportRun(ctx, runId, format) {
  const run = getRun(ctx, runId);
  assertCan(ctx, 'export.download', run.org_id);
  if (!MIME[format]) throw new HttpError(422, '格式只能是 xlsx、csv、docx、pdf、html');
  const maskedAny = Object.values(run.results.fields || {}).some((f) => f.masked);
  const existing = !maskedAny && ['locked'].includes(run.status) ? q.get('SELECT * FROM report_artifacts WHERE run_id = ? AND format = ? ORDER BY created_at DESC LIMIT 1', runId, format) : null;
  if (existing) {
    const data = await readFile(existing.storage_key);
    if (sha256(data) !== existing.sha256) throw new HttpError(500, '封存檔雜湊不符，請通知系統管理員');
    audit({ actor: ctx.userId, actorName: ctx.name, orgId: run.org_id, action: 'report.download', targetType: 'report_run', targetId: runId, after: { format, artifact: existing.id } });
    return { data, filename: fileName(run, format), mime: MIME[format] };
  }
  const m = model(run);
  let data;
  if (format === 'xlsx') data = buildWorkbook([{ name: '報告', rows: toRows(m), cols: [18, 26, 16, 10, 10, 22, 40, 40] }]).buffer;
  else if (format === 'csv') data = csv(m);
  else if (format === 'docx') data = docx(m);
  else if (format === 'html') data = Buffer.from(html(m), 'utf8');
  else data = await pdf(html(m));
  const hash = sha256(data);
  if (!maskedAny) {
    const dir = join(config.uploadsDir, 'platform', run.org_id, 'reports');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const key = join(dir, `${runId}-${format}-${hash.slice(0, 12)}`);
    try { await access(key); } catch { await writeFile(key, data, { mode: 0o400 }); }
    insert('report_artifacts', { id: newId('art'), run_id: runId, format, storage_key: key, sha256: hash, size: data.length, created_by: ctx.userId, created_at: nowIso() });
    if (run.status === 'locked') q.run("UPDATE report_cases SET status = 'exported', updated_at = ? WHERE id = ? AND status = 'locked'", nowIso(), run.case_id);
  }
  audit({ actor: ctx.userId, actorName: ctx.name, orgId: run.org_id, action: 'report.export', targetType: 'report_run', targetId: runId, after: { format, sha256: hash, masked: maskedAny } });
  return { data, filename: fileName(run, format), mime: MIME[format] };
}

function fileName(run, format) {
  return `${run.year}-${run.template.code}-${run.case_name}-v${run.run_no}${run.status === 'locked' ? '' : '-草稿'}.${format}`.replace(/[\\/:*?"<>|]/g, '_');
}
