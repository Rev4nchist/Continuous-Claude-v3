// Tests for the session-review HTML renderer. Run: node --test .claude/skills/session-review/scripts/test/render-html.test.mjs
// Failure modes, one test each (the source change that breaks it is in the test title):
//  1  partial or garbage input throws, or an empty section still renders
//  2  an N/A or bad score leaks NaN, undefined or null into the page
//  3  a string from the review JSON reaches the page unescaped (every field, three payloads)
//  4  a host other than the font hosts appears; a javascript: or data: link renders
//  5  a theme block, the max() gutter or the body rule is missing
//  6  the page is not content-only (doctype, html, head, body) or the title is wrong
//  7  the page grows past 200 KB, or a long string is not cut
//  8  a heatmap colour pair fails 4.5:1 contrast in either theme
//  9  the sparkline divides by zero (one point, flat series) or loses the endpoint
// 10  the details cards open more than the first one
// 11  the CLI writes no file, or accepts bad JSON
// 12  the page needs JavaScript, or uses a banned font or an emoji
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtml, validateReview } from '../render-html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'render-html.mjs');
const FIXTURE = path.join(HERE, 'fixtures', 'review-example.json');
const load = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const OPTIONAL_IDS = ['improvements', 'factory', 'watch', 'harness', 'trend'];
const PAYLOADS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '</style><script>'];
const ALLOWED_TAGS = new Set(['title', 'meta', 'link', 'style', 'main', 'header', 'section', 'footer', 'h1', 'h2', 'h3', 'h4', 'p', 'div', 'span', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'svg', 'polyline', 'circle', 'line', 'text', 'a', 'code', 'b', 'i', 'strong', 'em', 'dl', 'dt', 'dd', 'nav', 'time', 'path', 'rect', 'g']);

function leafPaths(node, prefix = [], out = []) {
  if (typeof node === 'string') out.push(prefix);
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) leafPaths(node[k], [...prefix, k], out);
  return out;
}
function setAt(obj, p, value) {
  let cur = obj;
  for (const k of p.slice(0, -1)) cur = cur[k];
  cur[p.at(-1)] = value;
}
const hasSection = (html, id) => html.includes(`id="${id}"`);

/** Block text after a marker, up to the first closing brace. */
function blockAfter(html, marker) {
  const i = html.indexOf(marker);
  assert.ok(i >= 0, `missing CSS block: ${marker}`);
  const open = html.indexOf('{', i);
  return html.slice(open + 1, html.indexOf('}', open));
}
function tokensOf(block) {
  const map = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
function lum(hex) {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? [...n].map((c) => c + c).join('') : n;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }

// ---- 1. partial input
test('1a garbage input never throws (a missing guard on null, string or wrong-typed sections)', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { sessions: 'x' }, { sessions: [null, 5, 'a'] }, { run: 5, improvements: {}, factory: 'x', trend: [] }]) {
    assert.doesNotThrow(() => renderHtml(bad));
    assert.doesNotThrow(() => validateReview(bad));
    assert.ok(Array.isArray(validateReview(bad)));
    assert.ok(renderHtml(bad).startsWith('<title>Session Review</title>'));
  }
});

test('1b partial input renders the heatmap and hides every optional section', () => {
  const full = load();
  const partial = { run: full.run, sessions: full.sessions.slice(0, 1) };
  const html = renderHtml(partial);
  assert.ok(hasSection(html, 'heatmap'));
  assert.ok(hasSection(html, 'sessions'));
  for (const id of OPTIONAL_IDS) assert.equal(hasSection(html, id), false, `section ${id} must be hidden`);
});

test('1c the full fixture shows every section', () => {
  const html = renderHtml(load());
  for (const id of ['summary', 'heatmap', 'sessions', ...OPTIONAL_IDS]) assert.ok(hasSection(html, id), `missing ${id}`);
});

test('1d empty optional arrays hide their sections (a length check replaced by a truthy check)', () => {
  const r = load();
  Object.assign(r, { improvements: [], watch: [], harness: [], trend: { points: [] }, factory: { stations: [] } });
  const html = renderHtml(r);
  for (const id of OPTIONAL_IDS) assert.equal(hasSection(html, id), false, id);
});

test('1e validateReview is clean for the fixture and names the bad field otherwise', () => {
  assert.deepEqual(validateReview(load()), []);
  const bad = load();
  bad.sessions[0].scores.goal = 7;
  bad.sessions[1].notes[0].text = 5;
  delete bad.run;
  const problems = validateReview(bad).join('\n');
  assert.match(problems, /sessions\[0\]\.scores\.goal/);
  assert.match(problems, /sessions\[1\]\.notes\[0\]\.text/);
  assert.match(problems, /run/);
});

// ---- 2. N/A and bad numbers
test('2 N/A and bad numbers render as N/A with no NaN, undefined or null in the page', () => {
  const r = load();
  r.sessions[0].scores.efficiency = 'high';
  r.sessions[1].scores.goal = Number.NaN;
  r.sessions[2].active_ms = 'soon';
  r.sessions[2].cost_usd = Infinity;
  r.improvements[0].expected_saving_min = null;
  r.improvements[1].chains = 'two';
  const html = renderHtml(r);
  assert.doesNotMatch(html, /NaN|Infinity|undefined|\bnull\b/);
  assert.match(html, /hm-na/);
  assert.match(html, />N\/A</);
  const clean = renderHtml(load());
  assert.doesNotMatch(clean, /NaN|undefined|\bnull\b/);
  assert.ok((clean.match(/hm-na/g) || []).length >= 5, 'fixture has N/A cells');
});

test('2b heatmap maps 0.0 to band 1 and 1.0 to band 5, and covers a scorer outside the fixture list', () => {
  const r = { sessions: [{ label: 'a #11111111', scores: { goal: 0, procedure: 1, tests: 0.5 } }] };
  const html = renderHtml(r);
  assert.match(html, /class="hm hm-1"[^>]*>0\.0</);
  assert.match(html, /class="hm hm-5"[^>]*>1\.0</);
  assert.match(html, /class="hm hm-3"[^>]*>0\.5</);
  assert.match(html, />procedure</);
});

// ---- 3. escaping
test('3a every string field, with each payload, is escaped (one field at a time)', () => {
  const base = load();
  const paths = leafPaths(base);
  assert.ok(paths.length > 100, `fixture has ${paths.length} string fields`);
  for (const payload of PAYLOADS) {
    for (const p of paths) {
      const r = load();
      setAt(r, p, payload);
      assertSafe(renderHtml(r), `${p.join('.')} <- ${payload}`);
    }
  }
});

test('3b every string field set at once is escaped, and the payload shows as text', () => {
  for (const payload of PAYLOADS) {
    const r = load();
    for (const p of leafPaths(r)) setAt(r, p, payload);
    const html = renderHtml(r);
    assertSafe(html, `all <- ${payload}`);
    assert.ok(html.includes('&lt;') && html.includes('&gt;'), 'payload is visible as escaped text');
  }
});

test('3c keys from the review JSON are escaped (a score key used as a column name)', () => {
  const r = { sessions: [{ label: 'x', scores: { '<script>alert(1)</script>': 0.5, '"><img src=x onerror=alert(1)>': 0.2 } }] };
  assertSafe(renderHtml(r), 'score keys');
});

function assertSafe(html, where) {
  assert.equal((html.match(/<script/gi) || []).length, 0, `raw <script in ${where}`);
  assert.equal((html.match(/<\/style>/gi) || []).length, 1, `extra </style> in ${where}`);
  assert.equal((html.match(/<title>/g) || []).length, 1, `extra <title> in ${where}`);
  assert.ok(html.startsWith('<title>Session Review</title>'), `title changed in ${where}`);
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    assert.ok(ALLOWED_TAGS.has(m[1].toLowerCase()), `tag <${m[1]}> not allowed in ${where}`);
    const noValues = m[2].replace(/"[^"]*"|'[^']*'/g, '""');
    assert.doesNotMatch(noValues, /\son[a-z]+\s*=/i, `event attribute in ${where}`);
    assert.doesNotMatch(noValues, /\sstyle\s*=/i, `style attribute from input in ${where}`);
  }
}

// ---- 4. hosts and links
test('4a the page names no host except the two font hosts', () => {
  const html = renderHtml(load());
  const hosts = new Set([...html.matchAll(/https?:\/\/([^/\s"'<>&?#]+)/gi)].map((m) => m[1].toLowerCase()));
  assert.ok(hosts.has('fonts.googleapis.com'));
  for (const h of hosts) assert.ok(['fonts.googleapis.com', 'fonts.gstatic.com'].includes(h), `unexpected host ${h}`);
  assert.equal((html.match(/<link /g) || []).length, 1, 'exactly one <link>');
  assert.doesNotMatch(html, /xmlns|w3\.org/i, 'inline SVG needs no namespace host');
});

test('4b links render only for https:// values, with rel noopener; javascript: and data: stay text', () => {
  const r = load();
  r.factory.pr_signals = [
    { text: 'good', url: 'https://github.com/Rev4nchist/continuous-claude/pull/9001' },
    { text: 'bad1', url: 'javascript:alert(1)' },
    { text: 'bad2', url: 'data:text/html,<b>x</b>' },
    { text: 'bad3', url: '  JAVASCRIPT:alert(1)' },
    { text: 'bad4', url: 'http://example.com/' },
  ];
  const html = renderHtml(r);
  assert.match(html, /<a href="https:\/\/github\.com\/Rev4nchist\/continuous-claude\/pull\/9001" rel="noopener noreferrer"/);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:text/i);
  assert.doesNotMatch(html, /http:\/\/example/);
  assert.match(html, /bad1/);
});

test('4c a link value with a quote cannot break out of the href', () => {
  const r = load();
  r.factory.pr_signals = [{ text: 't', url: 'https://x.test/"><img src=x onerror=alert(1)>' }];
  assertSafe(renderHtml(r), 'href');
});

// ---- 5. theme and layout
test('5 theme blocks, tokens, gutter and layout rules are present', () => {
  const html = renderHtml(load());
  assert.match(html, /:root\s*\{/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/);
  assert.match(html, /:root\[data-theme="dark"\]\s*\{/);
  assert.equal((html.match(/^\s*color-scheme: dark;/gm) || []).length, 2);
  assert.match(html, /color-scheme: light/);
  assert.match(html, /body\s*\{\s*background:\s*var\(--bg\);\s*color:\s*var\(--fg\)/);
  assert.ok(html.includes('padding-left: max(16px, env(safe-area-inset-left, 0px))'));
  assert.ok(html.includes('padding-right: max(16px, env(safe-area-inset-right, 0px))'));
  assert.match(html, /padding-block:/);
  assert.match(html, /overflow-x:\s*auto/);
  assert.match(html, /min-width:\s*0/);
  assert.match(html, /font-variant-numeric:\s*tabular-nums/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /text-wrap:\s*balance/);
  assert.match(html, /name="claude:viewport-fit-sides" content="cover"/);
});

test('5b the light and the two dark blocks define the same token names', () => {
  const html = renderHtml(load());
  const light = Object.keys(tokensOf(blockAfter(html, ':root {'))).sort();
  const dark1 = Object.keys(tokensOf(blockAfter(html, ':root:not([data-theme="light"]) {'))).sort();
  const dark2 = Object.keys(tokensOf(blockAfter(html, ':root[data-theme="dark"] {'))).sort();
  assert.ok(light.length > 30);
  assert.deepEqual(dark1, light);
  assert.deepEqual(dark2, light);
});

// ---- 6. content-only
test('6 the page starts with the title and meta and has no doctype, html, head or body tag', () => {
  const html = renderHtml(load());
  assert.ok(html.startsWith('<title>Session Review</title>\n<meta name="claude:viewport-fit-sides" content="cover">'));
  assert.doesNotMatch(html, /<!doctype|<html|<head|<body/i);
});

// ---- 7. size and caps
test('7a the fixture page is under 200 KB', () => {
  const bytes = Buffer.byteLength(renderHtml(load()));
  assert.ok(bytes < 200 * 1024, `${bytes} bytes`);
});

test('7b a long string is cut with an ellipsis (no cap in the escape helper)', () => {
  const r = load();
  r.sessions[0].goal = 'x'.repeat(50000);
  r.sessions[0].notes[0].text = 'y'.repeat(50000);
  const html = renderHtml(r);
  assert.ok(Buffer.byteLength(html) < 200 * 1024);
  assert.match(html, /x{50}…/);
  assert.doesNotMatch(html, /x{2000}/);
});

test('7c the cap never cuts an escape entity in half', () => {
  const r = load();
  r.sessions[0].goal = '<'.repeat(5000);
  const html = renderHtml(r);
  assert.doesNotMatch(html, /&(?!(amp|lt|gt|quot|#39);)/, 'a bare or cut entity');
  assert.match(html, /&lt;&lt;&lt;/);
});

// ---- 8. contrast
test('8 each heatmap, pill and text colour pair keeps 4.5:1 contrast in both themes', () => {
  const html = renderHtml(load());
  const light = tokensOf(blockAfter(html, ':root {'));
  const themes = {
    light,
    'dark (media)': { ...light, ...tokensOf(blockAfter(html, ':root:not([data-theme="light"]) {')) },
    'dark (attribute)': { ...light, ...tokensOf(blockAfter(html, ':root[data-theme="dark"] {')) },
  };
  const pairs = [['--fg', '--bg'], ['--fg', '--surface'], ['--fg-muted', '--bg'], ['--fg-muted', '--surface'], ['--accent-fg', '--accent-bg'], ['--good-fg', '--good-bg'], ['--warn-fg', '--warn-bg'], ['--crit-fg', '--crit-bg'], ['--chip-fg', '--chip-bg'], ['--fg-muted', '--na-a'], ['--fg-muted', '--na-b'], ['--fg-muted', '--surface-2'], ['--accent-fg', '--surface'], ['--warn-fg', '--surface']];
  for (let i = 1; i <= 5; i++) pairs.push([`--hm${i}-fg`, `--hm${i}-bg`]);
  for (const [name, t] of Object.entries(themes)) {
    for (const [f, b] of pairs) {
      assert.ok(/^#[0-9a-f]{3,6}$/i.test(t[f] || '') && /^#[0-9a-f]{3,6}$/i.test(t[b] || ''), `${name}: ${f} or ${b} is not a hex colour`);
      const c = contrast(t[f], t[b]);
      assert.ok(c >= 4.5, `${name}: ${f} on ${b} is ${c.toFixed(2)}`);
    }
  }
});

test('8b the five heatmap bands differ from each other in both themes', () => {
  const html = renderHtml(load());
  for (const m of [':root {', ':root[data-theme="dark"] {']) {
    const t = tokensOf(blockAfter(html, m));
    const fills = [1, 2, 3, 4, 5].map((i) => t[`--hm${i}-bg`]);
    assert.equal(new Set(fills).size, 5, m);
  }
});

// ---- 9. sparkline
test('9a the sparkline has an emphasised endpoint and finite coordinates', () => {
  const html = renderHtml(load());
  assert.match(html, /<polyline /);
  assert.match(html, /<circle [^>]*class="sp-end"/);
  const pts = /<polyline [^>]*points="([^"]+)"/.exec(html)[1].trim().split(/\s+/);
  assert.equal(pts.length, 6);
  for (const p of pts) for (const n of p.split(',')) assert.ok(Number.isFinite(Number(n)), p);
});

test('9b one point and a flat series render without NaN (a zero range divides by zero)', () => {
  for (const points of [[{ run_ts: 'a', mean: 0.5 }], [{ run_ts: 'a', mean: 0.5 }, { run_ts: 'b', mean: 0.5 }, { run_ts: 'c', mean: 0.5 }]]) {
    const html = renderHtml({ sessions: [], trend: { points } });
    assert.ok(hasSection(html, 'trend'));
    assert.doesNotMatch(html, /NaN|Infinity/);
    assert.match(html, /sp-end/);
  }
});

test('9c points with bad means are dropped, and a trend with none hides', () => {
  const html = renderHtml({ trend: { points: [{ run_ts: 'a', mean: 'x' }, { run_ts: 'b', mean: null }] } });
  assert.equal(hasSection(html, 'trend'), false);
});

// ---- 10. details
test('10 only the first session card is open', () => {
  const html = renderHtml(load());
  const cards = html.match(/<details[^>]*>/g) || [];
  assert.equal(cards.length, 4);
  assert.match(cards[0], /\sopen/);
  for (const c of cards.slice(1)) assert.doesNotMatch(c, /\sopen/);
});

// ---- 11. CLI
test('11a the CLI writes the page from a review file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
  try {
    const out = path.join(dir, 'sub', 'page.html');
    const res = spawnSync(process.execPath, [CLI, '--in', FIXTURE, '--out', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const html = fs.readFileSync(out, 'utf8');
    assert.equal(html, renderHtml(load()));
    assert.match(res.stdout, /page\.html/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('11b the CLI exits 2 on bad JSON, a missing file or missing flags, and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
  try {
    const badIn = path.join(dir, 'bad.json');
    fs.writeFileSync(badIn, '{ not json');
    const out = path.join(dir, 'page.html');
    assert.equal(spawnSync(process.execPath, [CLI, '--in', badIn, '--out', out], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [CLI, '--in', path.join(dir, 'none.json'), '--out', out], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [CLI, '--in', FIXTURE], { encoding: 'utf8' }).status, 2);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('11c the CLI still renders a partial review and prints the problems to stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
  try {
    const input = path.join(dir, 'p.json');
    fs.writeFileSync(input, JSON.stringify({ sessions: [{ label: 'a', scores: { goal: 9 } }] }));
    const out = path.join(dir, 'p.html');
    const res = spawnSync(process.execPath, [CLI, '--in', input, '--out', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /sessions\[0\]\.scores\.goal/);
    assert.ok(fs.existsSync(out));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 12. no JS, fonts, no emoji
test('12 no script, no event attribute, the chosen fonts, no banned font, no emoji', () => {
  const html = renderHtml(load());
  assert.doesNotMatch(html, /<script|\son[a-z]+=|opacity:\s*0[;\s}]/i);
  assert.match(html, /family=Bricolage\+Grotesque/);
  assert.match(html, /family=IBM\+Plex\+Sans/);
  assert.match(html, /family=IBM\+Plex\+Mono/);
  assert.doesNotMatch(html, /Inter\b|Space Grotesk/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
  assert.match(html, /EXAMPLE/, 'the example fixture is marked');
});
