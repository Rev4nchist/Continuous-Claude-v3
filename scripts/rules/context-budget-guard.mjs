#!/usr/bin/env node
/**
 * context-budget-guard.mjs — ratchet on the instruction text EVERY session loads.
 *
 * Claude Code warns when its always-loaded instruction files pass 150,000 characters. That set is:
 * CLAUDE.md, every file it @-imports (recursively), and every rule in rules/ WITHOUT `paths:`
 * frontmatter (a path-scoped rule loads only when matching files are in play). The old
 * rules-budget-guard counted only the bytes of .claude/rules-src, so on 2026-09-24 the real set
 * reached 42 files / 153,689 chars while that guard still passed.
 *
 * Modes:
 *   (default)        the active set under ~/.claude — the number Claude Code itself reports.
 *   --repo           the repo sources that sync or are copied there: .claude/templates/CLAUDE.md.template,
 *                    RULES.md.template, .claude/<imported path>, .claude/rules-src/*.md.
 *   --repo --staged  the same, read from the git index (pre-commit).
 * Fails (exit 1) when the total passes maxChars in scripts/rules/context-budget.json.
 * Exit 0 with a note on any internal error (fail-open). Add --json for machine output.
 * Lowering maxChars after a cut is how the ratchet tightens; raising it is a reviewed edit.
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const REPO = args.includes('--repo');
const STAGED = args.includes('--staged');
const homeArg = args.indexOf('--home');
const HOME = homeArg >= 0 ? resolve(args[homeArg + 1]) : join(homedir(), '.claude');
const MAX_IMPORT_DEPTH = 5; // Claude Code's documented import depth

/** A source: `key` is the path as Claude Code sees it (relative to ~/.claude); `read` returns text or null. */
function makeSource() {
  if (!REPO) {
    return {
      read: (key) => (existsSync(join(HOME, key)) && statSync(join(HOME, key)).isFile() ? readFileSync(join(HOME, key), 'utf8') : null),
      rules: () => listDir(join(HOME, 'rules')).map((f) => `rules/${f}`),
    };
  }
  const repoPath = (key) => {
    if (key === 'CLAUDE.md') return '.claude/templates/CLAUDE.md.template';
    if (key === 'RULES.md') return '.claude/templates/RULES.md.template';
    if (key.startsWith('rules/')) return `.claude/rules-src/${key.slice(6)}`;
    return `.claude/${key}`;
  };
  const readRepo = (p) => {
    const abs = join(repo, p);
    const onDisk = existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
    if (!STAGED) return onDisk;
    // Claude Code counts \r, and sync copies the working-tree file. So when the staged blob equals
    // the file on disk apart from line endings, count the file on disk. Otherwise count the blob in
    // checkout form (--filters applies the CRLF conversion a checkout would).
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let blob;
    try { blob = git('show', `:${p}`); } catch { return null; }
    const lf = (s) => s.replace(/\r\n/g, '\n');
    if (onDisk != null && lf(onDisk) === lf(blob)) return onDisk;
    return git('cat-file', '--filters', `:${p}`);
  };
  const rulesSrc = () => {
    if (!STAGED) return listDir(join(repo, '.claude/rules-src'));
    const out = execFileSync('git', ['-C', repo, 'ls-files', '--', '.claude/rules-src/*.md'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map((p) => p.slice('.claude/rules-src/'.length));
  };
  return { read: (key) => readRepo(repoPath(key)), rules: () => rulesSrc().map((f) => `rules/${f}`) };
}

function listDir(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listDir(join(dir, e.name)).map((f) => `${e.name}/${f}`));
    else if (e.name.endsWith('.md')) out.push(e.name);
  }
  return out;
}

/** True when the file opens with YAML frontmatter that declares `paths:`. */
export function isPathScoped(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return Boolean(m && /^paths\s*:/m.test(m[1]));
}

/** @-imports outside fenced blocks and inline code, as keys relative to the importing file's folder. */
export function findImports(text, fromKey) {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const keys = [];
  for (const m of stripped.matchAll(/(?:^|\s)@((?:~\/)?[\w.\-/]+[\w\-/])/g)) {
    const raw = m[1];
    if (raw.startsWith('~/')) continue; // outside ~/.claude; not part of this set
    const base = dirname(fromKey) === '.' ? '' : dirname(fromKey);
    keys.push(relative('.', join(base, raw)).replace(/\\/g, '/'));
  }
  return keys;
}

function collect(src) {
  const files = new Map();
  const visit = (key, depth) => {
    if (files.has(key) || depth > MAX_IMPORT_DEPTH) return;
    const text = src.read(key);
    if (text == null) return; // an @token that is not a file (e.g. @playwright/mcp) is ignored
    files.set(key, text.length);
    for (const k of findImports(text, key)) visit(k, depth + 1);
  };
  visit('CLAUDE.md', 0);
  for (const key of src.rules()) {
    const text = src.read(key);
    if (text == null || isPathScoped(text)) continue;
    visit(key, 0);
  }
  return [...files].map(([file, chars]) => ({ file, chars })).sort((a, b) => b.chars - a.chars);
}

// Run only as a CLI, so tests can import the parsers without exiting the test process.
const isDirectRun = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) main();

function main() {
try {
  const budgetText = STAGED
    ? execFileSync('git', ['-C', repo, 'show', ':scripts/rules/context-budget.json'], { encoding: 'utf8' })
    : readFileSync(join(here, 'context-budget.json'), 'utf8');
  const budget = JSON.parse(budgetText);
  const rows = collect(makeSource());
  const total = rows.reduce((n, r) => n + r.chars, 0);
  const over = total > budget.maxChars;
  const where = REPO ? (STAGED ? 'repo (staged)' : 'repo') : HOME;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ where, files: rows.length, total, maxChars: budget.maxChars, limitChars: budget.limitChars, over, largest: rows.slice(0, 8) }));
  } else {
    console.log(`always-loaded: ${rows.length} files, ${total} chars (budget ${budget.maxChars}, Claude Code limit ${budget.limitChars}) [${where}]${over ? '  OVER BUDGET' : ''}`);
    if (over || args.includes('--verbose')) {
      for (const r of rows.slice(0, over ? 8 : rows.length)) console.log(`  ${String(r.chars).padStart(7)}  ${r.file}`);
    }
    if (over) console.log('  Move text behind a trigger (a hook, `paths:` frontmatter, or a skill), or raise maxChars in scripts/rules/context-budget.json deliberately.');
  }
  process.exit(over ? 1 : 0);
} catch (err) {
  console.log(`context-budget-guard: skipped (${err.message.split('\n')[0]})`);
  process.exit(0);
}
}
