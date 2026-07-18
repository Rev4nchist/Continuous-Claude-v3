// assemble.mjs — PURE, zero-LLM assembler for the Self-Improvement Triage Cockpit.
//
// Given a normalized proposal list, produce a self-contained interactive HTML page
// (byte-identical for identical inputs + generatedAt). All proposal text is HTML-
// escaped BEFORE any markdown formatting, so nothing raw from a proposal file can
// inject markup — the client renders the pre-sanitized HTML via innerHTML safely.
//
// The assembler does NO I/O. build.mjs reads + parses the proposal files and passes
// the normalized array IN. Mirrors scripts/project-cards/assembler.mjs conventions:
// template loaded once, single-pass {{TOKEN}} substitution that fails loud, plus the
// skill-forge /*__EMBEDDED_DATA__*/ JSON-injection pattern for the proposal payload.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { esc } from '../../project-cards/lib/util.mjs';

export { esc };

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(HERE, 'template.html'), 'utf8');

// ---------------------------------------------------------------------------
// Safe markdown -> HTML. Escape FIRST (esc), then apply block + inline transforms
// on the escaped text. Deterministic and pure. Handles the constructs the proposal
// corpus actually uses: fenced code, tables, ATX headings, ordered/unordered lists,
// blockquotes, horizontal rules, paragraphs, and inline code/bold/italic/links.
// ---------------------------------------------------------------------------

// Inline spans, applied to ALREADY-ESCAPED text. Order matters: code first (so its
// contents aren't reformatted), then links, then bold, then italic.
function inline(escaped) {
  let s = escaped;
  // `inline code` (no nested formatting)
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // [text](url) — only allow http(s) / mailto to avoid javascript: URIs.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return m; // leave non-safe links as literal text
  });
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  // _italic_ or *italic* (single, not part of **)
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?![\w])/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  return s;
}

function renderTable(rows) {
  // rows: array of already-escaped raw table lines (| a | b |). rows[1] is the
  // |---|---| separator. Cells split on unescaped pipes.
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2);
  const th = header.map((c) => `<th>${inline(c)}</th>`).join('');
  const trs = body
    .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

export function mdToSafeHtml(md) {
  const raw = String(md ?? '');
  const lines = esc(raw).split('\n'); // escape ALL of it up front
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' ').trim())}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushPara();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // table: a header line followed by a |---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(buf));
      continue;
    }

    // ATX heading (### and deeper within a section body -> h4..h6)
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = Math.min(6, h[1].length + 1); // shift down one; sections own h3
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // blockquote (collapse consecutive > lines)
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${inline(buf.join(' ').trim())}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }

    // blank line -> paragraph boundary
    if (/^\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }

    // default: accumulate into a paragraph
    para.push(line);
    i += 1;
  }
  flushPara();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// assemble(proposals, opts) -> HTML string
//   proposals: [{ id, date, component, component_name, verdict, headline,
//                 sources, sections: [{ n, title, md }] }]  (normalized by build.mjs)
//   opts.generatedAt: ISO-ish stamp string (injected; keeps assemble deterministic)
// ---------------------------------------------------------------------------
export function assemble(proposals = [], opts = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const generatedAt = String(opts.generatedAt ?? '');

  // Pre-render every section body to safe HTML at build time. The embedded payload
  // carries only escaped-then-formatted HTML, so the client's innerHTML is safe.
  const data = list.map((p) => ({
    id: String(p.id ?? ''),
    date: String(p.date ?? ''),
    component: String(p.component ?? ''),
    componentName: String(p.component_name ?? p.componentName ?? p.component ?? ''),
    verdict: String(p.verdict ?? 'unknown').toLowerCase(),
    headline: String(p.headline ?? ''),
    sources: Number.isFinite(+p.sources) ? +p.sources : 0,
    proposalPath: `docs/self-improvement/proposals/${p.id}.md`,
    sections: (Array.isArray(p.sections) ? p.sections : []).map((s) => ({
      n: Number(s.n) || 0,
      title: String(s.title ?? ''),
      html: mdToSafeHtml(s.md),
    })),
  }));

  // Sort newest-first for display (build.mjs may pass any order).
  data.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const counts = { total: data.length, adopt: 0, watch: 0, skip: 0, other: 0 };
  for (const d of data) {
    if (d.verdict === 'adopt') counts.adopt += 1;
    else if (d.verdict === 'watch') counts.watch += 1;
    else if (d.verdict === 'skip') counts.skip += 1;
    else counts.other += 1;
  }

  // JSON payload for the client. Embedded via a comment placeholder so it can never
  // be re-interpreted as a template {{TOKEN}}. Escape "</" to avoid closing the
  // host <script> element early.
  const payload = JSON.stringify({ generatedAt, counts, proposals: data })
    .replace(/<\//g, '<\\/');

  const tokens = {
    GENERATED_AT: esc(generatedAt),
    COUNT_TOTAL: esc(counts.total),
    COUNT_ADOPT: esc(counts.adopt),
    COUNT_WATCH: esc(counts.watch),
    COUNT_SKIP: esc(counts.skip),
  };

  // Resolve chrome tokens on the TEMPLATE FIRST — so proposal text that happens to
  // contain "{{...}}" can never be reinterpreted as a token — then inject the data
  // payload LAST via a function replacement (a string replacement would let "$&"/"$1"
  // sequences inside the JSON be special-cased by String.prototype.replace).
  let html = TEMPLATE.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
      throw new Error(`assemble: unresolved template token ${match}`);
    }
    return tokens[key];
  });
  html = html.replace('/*__EMBEDDED_DATA__*/', () => `const EMBEDDED_DATA = ${payload};`);
  return html;
}
