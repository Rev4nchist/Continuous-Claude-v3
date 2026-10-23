#!/usr/bin/env node
/**
 * Fail when a runtime file names the removed cross-model CLI.
 * Dated history is listed in the allow file, one path with one reason.
 * Live files are not whole-file allowed. A token entry names the exact
 * strings that may remain, each with a count. Counts are whole tokens:
 * a letter, digit, dot, underscore, or hyphen on either side is a
 * different token, so h2-codex2 and h2-codex.x do not satisfy h2-codex.
 * A new hit, or a count change, fails. A scan of zero files fails. An
 * allow entry that does not occur in its file fails (a pass on zero
 * inputs is a fail), except a frozen entry, which is a path that must
 * stay byte-for-byte with the base commit. Eval records are frozen.
 * A file of 2 MB or more fails unless its allow entry sets "oversized"
 * to true and gives a reason. That exemption is the size, not the
 * contents: a listed file that shrinks under 2 MB is scanned, and a hit
 * in it fails. A leftover-damage check fails on empty name or label
 * elements, empty name-like JSON values, a link whose name is missing
 * (-x.html, /.ext), and a slash, dash, or plus with only spaces between
 * two of the same mark.
 *
 *   node scripts/ratchets/no-<token>.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile } from './no-work-user.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const TOKEN = ['c', 'o', 'd', 'e', 'x'].join('');
const NEEDLE = new RegExp(TOKEN, 'gi');
const SELF = join('scripts', 'ratchets', `no-${TOKEN}.mjs`);
const ALLOW_FILE = join('scripts', 'ratchets', `no-${TOKEN}-allow.json`);
const SIZE_LIMIT = 2_000_000;
const BASE = 'e613eea466cff609c04e7b879d3a9d0dcc1b365c';
const FROZEN_SPECS = [
  'docs/fable-manual/eval',
  'docs/fable-manual/golden',
  'docs/fable-manual/EXTRACTION-REPORT.md',
  'docs/fable-manual/TRAP-TESTS.md',
];

const DAMAGE = [
  /<(h[1-6]|span|div|p|a|label|text|td|th|li)\b[^>]*\bclass=["'][^"']*(?:agent-name|label-main|label-sub|\blbl\b|\blabel\b)[^"']*["'][^>]*>\s*<\/\1>/gi,
  /<text\b[^>]*>\s*<\/text>/gi,
  /"(?:agent-name|name|label|file|title|href)"\s*:\s*""/g,
  /"[^"\\]*(?:agents|names|labels)[^"\\]*"\s*:\s*\[\s*""/g,
  /(?:^|["'\s])-[A-Za-z0-9][\w.-]*\.html\b/gm,
  /(?<![\w$])\/\.(?:html|jsonl|json|md|mjs|js|ts|tsx|css|pdf|txt|yml|yaml|sh|ps1)\b/g,
  /(?<=\S)[ \t]+([/+-])[ \t]+\1[ \t]+(?=\S)/g,
];

const ALIAS = new RegExp(
  [
    '\\bRetired (CLI|runner)\\b',
    '/retired\\b',
    '\\.retired/',
    'retired-(?:adversar|lift|integration|worker|rollout)',
    '--retired\\b',
    '\\bretired exec\\b',
    '`retired`',
    '(?<!\\*)\\*{4}(?!\\*)',
    ' / / ',
  ].join('|'),
  'g',
);

const ROOTS = [
  '.claude',
  'scripts',
  'opc',
  'vendor',
  '.workroom',
  'docs/reviews',
  'docs/self-improvement',
  'apps',
  'tests',
  'e2e',
  'machine',
];

const SKIP_DIR = new Set(['node_modules', '.git', '.venv', '__pycache__']);

function gitignored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function classify(rel, abs, size, out, oversized, unlisted, allow, seenAllow) {
  if (size >= SIZE_LIMIT) {
    const row = allow.get(rel);
    if (row?.oversized) {
      seenAllow.add(rel);
      oversized.push(`${rel} ${size} allowed`);
    } else {
      oversized.push(`${rel} ${size}`);
      unlisted.push(rel);
    }
    return;
  }
  out.push(abs);
}

function walk(dir, out, oversized, unlisted, allow, seenAllow) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    const rel = relative(REPO, abs).replace(/\\/g, '/');
    if ((name === 'cache' || name === '.cache') && gitignored(rel)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out, oversized, unlisted, allow, seenAllow);
    else if (st.isFile()) classify(rel, abs, st.size, out, oversized, unlisted, allow, seenAllow);
  }
}

function tokenList(row) {
  if (!Array.isArray(row.tokens) || row.tokens.length === 0) return null;
  return row.tokens.map((tok) => {
    if (!tok || typeof tok.text !== 'string' || !Number.isInteger(tok.count) || tok.count < 1) {
      return null;
    }
    return { text: tok.text, count: tok.count };
  });
}

function isBoundary(ch) {
  return ch === undefined || !/[A-Za-z0-9_.-]/.test(ch);
}

function damageCount(text) {
  let n = 0;
  for (const re of DAMAGE) {
    re.lastIndex = 0;
    const found = text.match(re);
    if (found) n += found.length;
  }
  return n;
}

function underFrozen(rel) {
  return FROZEN_SPECS.some((spec) => rel === spec || rel.startsWith(`${spec}/`));
}

function applyTokens(text, tokens) {
  const sorted = [...tokens].sort((a, b) => b.text.length - a.text.length);
  let rest = text;
  const problems = [];
  for (const tok of sorted) {
    const spans = [];
    let from = 0;
    while (from <= rest.length) {
      const i = rest.indexOf(tok.text, from);
      if (i < 0) break;
      const before = i === 0 ? undefined : rest[i - 1];
      const afterAt = i + tok.text.length;
      const after = afterAt >= rest.length ? undefined : rest[afterAt];
      if (isBoundary(before) && isBoundary(after)) {
        spans.push(i);
        from = afterAt;
      } else {
        from = i + 1;
      }
    }
    if (spans.length !== tok.count) {
      problems.push(`${JSON.stringify(tok.text)} expected ${tok.count} found ${spans.length}`);
    }
    for (let s = spans.length - 1; s >= 0; s--) {
      const i = spans[s];
      rest = rest.slice(0, i) + rest.slice(i + tok.text.length);
    }
  }
  return { left: scanFile(rest, NEEDLE), problems };
}

function main() {
  const allowRaw = JSON.parse(readFileSync(join(REPO, ALLOW_FILE), 'utf8'));
  if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
    process.stdout.write('RESULT: FAIL - allow-list empty\n');
    process.exit(1);
  }
  const allow = new Map();
  for (const row of allowRaw) {
    if (!row || !row.path || !row.reason) {
      process.stdout.write('RESULT: FAIL - allow entry missing path or reason\n');
      process.exit(1);
    }
    const tokens = row.tokens == null ? null : tokenList(row);
    if (row.tokens != null && (!tokens || tokens.some((t) => !t))) {
      process.stdout.write(`RESULT: FAIL - bad token entry ${row.path}\n`);
      process.exit(1);
    }
    const frozen = row.frozen === true;
    if (frozen && tokens) {
      process.stdout.write(`RESULT: FAIL - frozen entry has tokens ${row.path}\n`);
      process.exit(1);
    }
    const path = row.path.replace(/\\/g, '/');
    if (frozen && !underFrozen(path)) {
      process.stdout.write(`RESULT: FAIL - frozen entry outside eval paths ${path}\n`);
      process.exit(1);
    }
    allow.set(path, {
      reason: String(row.reason),
      tokens,
      oversized: row.oversized === true,
      frozen,
    });
  }

  const files = [];
  const oversized = [];
  const unlistedOversized = [];
  const seenAllow = new Set();
  for (const rel of ROOTS) {
    const abs = join(REPO, rel);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      walk(abs, files, oversized, unlistedOversized, allow, seenAllow);
    }
  }
  for (const name of readdirSync(REPO)) {
    const abs = join(REPO, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    classify(name, abs, st.size, files, oversized, unlistedOversized, allow, seenAllow);
  }

  let hits = 0;
  const listed = [];
  let aliasHits = 0;
  const aliasListed = [];
  let damageHits = 0;
  const damageListed = [];
  for (const file of files) {
    const rel = relative(REPO, file).replace(/\\/g, '/');
    if (rel === SELF || rel === ALLOW_FILE) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const alias = text.match(ALIAS);
    if (alias && alias.length) {
      aliasHits += alias.length;
      aliasListed.push(`${rel} ${alias.length}`);
    }
    const row = allow.get(rel);
    const wholeFile = row && !row.tokens;
    if (!wholeFile) {
      const d = damageCount(text);
      if (d) {
        damageHits += d;
        damageListed.push(`${rel} ${d}`);
      }
    }
    if (row?.frozen) {
      seenAllow.add(rel);
      continue;
    }
    const n = scanFile(text, NEEDLE);
    if (row?.oversized && !row.tokens) {
      seenAllow.add(rel);
      if (n) {
        hits += n;
        listed.push(`${rel} ${n} oversized allow does not cover a file under 2MB`);
      }
      continue;
    }
    if (!n) continue;
    if (row?.tokens) {
      const applied = applyTokens(text, row.tokens);
      seenAllow.add(rel);
      if (applied.problems.length || applied.left) {
        hits += applied.left + applied.problems.length;
        listed.push(`${rel} ${applied.left} ${applied.problems.join('; ')}`.trim());
      }
      continue;
    }
    if (row) {
      seenAllow.add(rel);
      continue;
    }
    hits += n;
    listed.push(`${rel} ${n}`);
  }

  for (const [path, row] of allow) {
    if (!row.frozen) continue;
    const abs = join(REPO, path);
    if (statSync(abs, { throwIfNoEntry: false })?.isFile()) seenAllow.add(path);
  }

  let frozenStat = '';
  try {
    execFileSync('git', ['diff', '--exit-code', '--stat', BASE, '--', ...FROZEN_SPECS], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    frozenStat = `${err.stdout || ''}${err.stderr || ''}`.trim();
  }

  const missing = [...allow.keys()].filter((p) => !seenAllow.has(p));
  process.stdout.write(`files: ${files.length}\n`);
  process.stdout.write(`allow: ${allow.size}\n`);
  process.stdout.write(`hits: ${hits}\n`);
  process.stdout.write(`alias: ${aliasHits}\n`);
  process.stdout.write(`damage: ${damageHits}\n`);
  process.stdout.write(`frozen: ${frozenStat ? 'drift' : '0'}\n`);
  process.stdout.write(`oversized: ${oversized.length}\n`);
  for (const line of oversized) process.stdout.write(`  oversized ${line}\n`);
  for (const line of listed) process.stdout.write(`  ${line}\n`);
  for (const line of aliasListed) process.stdout.write(`  alias ${line}\n`);
  for (const line of damageListed) process.stdout.write(`  damage ${line}\n`);
  if (frozenStat) process.stdout.write(`  frozen\n${frozenStat}\n`);
  if (files.length === 0) {
    process.stdout.write('RESULT: FAIL - scanned 0 files\n');
    process.exit(1);
  }
  if (missing.length) {
    process.stdout.write(`RESULT: FAIL - allow entries with no hit (${missing.length})\n`);
    for (const p of missing) process.stdout.write(`  ${p}\n`);
    process.exit(1);
  }
  if (unlistedOversized.length) {
    process.stdout.write(`RESULT: FAIL - oversized file without an allow entry (${unlistedOversized.length})\n`);
    for (const p of unlistedOversized) process.stdout.write(`  ${p}\n`);
    process.exit(1);
  }
  if (frozenStat) {
    process.stdout.write('RESULT: FAIL - eval bytes differ from base\n');
    process.exit(1);
  }
  if (hits || aliasHits || damageHits) {
    process.stdout.write('RESULT: FAIL - removed CLI name\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: OK\n');
}

main();
