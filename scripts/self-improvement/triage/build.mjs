#!/usr/bin/env node
// build.mjs — read every self-improvement proposal, normalize it, and render the
// self-contained Self-Improvement Triage Cockpit to out/triage.html.
//
// I/O lives here; the render is the pure assemble() in assemble.mjs. Usage:
//   node scripts/self-improvement/triage/build.mjs [--out <path>]
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // scripts/self-improvement/triage -> repo root
const PROPOSALS_DIR = join(REPO, 'docs', 'self-improvement', 'proposals');

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const OUT = outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(HERE, 'out', 'triage.html');

function parseFrontmatter(body) {
  const fm = {};
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return fm;
}

// Split a proposal body into its numbered "## N. Title" sections. Robust to the
// free-text parenthetical suffixes the corpus adds (matches on the leading digit).
function parseSections(body) {
  const afterFm = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = afterFm.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(\d+)\.\s+(.*)$/);
    if (h) {
      if (cur) sections.push(cur);
      cur = { n: Number(h[1]), title: h[2].trim(), md: '' };
    } else if (cur) {
      cur.md += (cur.md ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);
  for (const s of sections) s.md = s.md.trim();
  return sections;
}

const files = readdirSync(PROPOSALS_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f))
  .sort();

const proposals = files.map((file) => {
  const body = readFileSync(join(PROPOSALS_DIR, file), 'utf8');
  const fm = parseFrontmatter(body);
  return {
    id: file.replace(/\.md$/, ''),
    date: fm.date || file.slice(0, 10),
    component: fm.component || '',
    component_name: fm.component_name || fm.component || '',
    verdict: fm.verdict || 'unknown',
    headline: fm.headline || '',
    sources: fm.sources || 0,
    sections: parseSections(body),
  };
});

const html = assemble(proposals, { generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' });

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`triage: rendered ${proposals.length} proposals -> ${OUT} (${(html.length / 1024).toFixed(1)} KiB)`);
