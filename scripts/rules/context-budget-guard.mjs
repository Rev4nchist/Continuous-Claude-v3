#!/usr/bin/env node
/**
 * context-budget-guard.mjs — ratchet on the instruction text EVERY session loads.
 *
 * Claude Code warns when its always-loaded instruction files pass 150,000 characters. That set is,
 * for the user scope (~/.claude) and for the project a session runs in: CLAUDE.md, every file it
 * @-imports (recursively), and every rule in rules/ WITHOUT `paths:` frontmatter (a path-scoped
 * rule loads only when matching files are in play). The old rules-budget-guard counted only the
 * bytes of .claude/rules-src, so on 2026-09-24 the real set reached 42 files / 153,689 chars while
 * that guard still passed.
 *
 * Modes:
 *   (default)          the active user set under ~/.claude — the number Claude Code reports in a
 *                      project with no instruction files. Add --project <dir> to include a project.
 *   --repo             the repo sources: .claude/templates/CLAUDE.md.template, RULES.md.template,
 *                      .claude/<imported path>, .claude/rules-src/*.md, PLUS this repo's own
 *                      CLAUDE.md chain, because sessions that work on the harness load both.
 *   --repo --staged    the same, read from the git index (pre-commit).
 * Fails (exit 1) when the total passes maxChars in scripts/rules/context-budget.json.
 * Exit 0 with a note on any internal error (fail-open). Add --json for machine output.
 * Lowering maxChars after a cut is how the ratchet tightens; raising it is a reviewed edit.
 * After a cut, run `--repo --tighten`: it sets maxChars to the total plus reserveChars (default
 * 300), so a later small addition fits without trims and a large one is a deliberate decision.
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { posix } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const REPO = args.includes('--repo');
const STAGED = args.includes('--staged');
const argValue = (name) => (args.indexOf(name) >= 0 ? resolve(args[args.indexOf(name) + 1]) : null);
const HOME = argValue('--home') ?? join(homedir(), '.claude');
const PROJECT = REPO ? repo : argValue('--project');
const MAX_IMPORT_DEPTH = 5; // Claude Code's documented import depth
const PROJECT_ROOTS = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

function readFileOrNull(abs) {
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
}

/**
 * A source reads keys of the form `user/<path>` (relative to ~/.claude) and `project/<path>`
 * (relative to the project root), and lists each scope's rule files.
 */
function makeSource() {
  if (!REPO) {
    return {
      read: (key) => {
        const [scope, rest] = splitKey(key);
        if (scope === 'user') return readFileOrNull(join(HOME, rest));
        return PROJECT ? readFileOrNull(join(PROJECT, rest)) : null;
      },
      rules: () => [
        ...listDir(join(HOME, 'rules')).map((f) => `user/rules/${f}`),
        ...(PROJECT ? listDir(join(PROJECT, '.claude/rules')).map((f) => `project/.claude/rules/${f}`) : []),
      ],
    };
  }
  // Repo mode: the user scope comes from the files that sync or are copied to ~/.claude.
  const userPath = (rest) => {
    if (rest === 'CLAUDE.md') return '.claude/templates/CLAUDE.md.template';
    if (rest === 'RULES.md') return '.claude/templates/RULES.md.template';
    if (rest.startsWith('rules/')) return `.claude/rules-src/${rest.slice(6)}`;
    return `.claude/${rest}`;
  };
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const readRepo = (p) => {
    const onDisk = readFileOrNull(join(repo, p));
    if (!STAGED) return onDisk;
    // Claude Code counts \r, and sync copies the working-tree file. So when the staged blob equals
    // the file on disk apart from line endings, count the file on disk. Otherwise count the blob in
    // checkout form (--filters applies the CRLF conversion a checkout would).
    let blob;
    try { blob = git('show', `:${p}`); } catch { return null; }
    const lf = (s) => s.replace(/\r\n/g, '\n');
    if (onDisk != null && lf(onDisk) === lf(blob)) return onDisk;
    return git('cat-file', '--filters', `:${p}`);
  };
  const listRepo = (dir) => {
    if (!STAGED) return listDir(join(repo, dir));
    return git('ls-files', '--', `${dir}/*.md`).split('\n').filter(Boolean).map((p) => p.slice(dir.length + 1));
  };
  return {
    read: (key) => {
      const [scope, rest] = splitKey(key);
      return readRepo(scope === 'user' ? userPath(rest) : rest);
    },
    rules: () => [
      ...listRepo('.claude/rules-src').map((f) => `user/rules/${f}`),
      // Never created in this repo (every-surface rule), but count it if it ever appears.
      ...listRepo('.claude/rules').map((f) => `project/.claude/rules/${f}`),
    ],
  };
}

function splitKey(key) {
  const i = key.indexOf('/');
  return [key.slice(0, i), key.slice(i + 1)];
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

/**
 * @-imports outside fenced blocks and inline code, as scoped keys. A relative import resolves
 * against the importing file's folder and stays in its scope; `@~/.claude/x` is `user/x`. Other
 * home paths, and any path that climbs out of its scope, are outside this set and skipped.
 */
export function findImports(text, fromKey) {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const [scope, rest] = splitKey(fromKey);
  const keys = [];
  for (const m of stripped.matchAll(/(?:^|\s)@((?:~\/)?[\w.\-/]+[\w\-/])/g)) {
    const raw = m[1];
    let target;
    if (raw.startsWith('~/.claude/')) target = ['user', posix.normalize(raw.slice('~/.claude/'.length))];
    else if (raw.startsWith('~/')) continue;
    else target = [scope, posix.normalize(posix.join(posix.dirname(rest), raw))];
    if (target[1].startsWith('..')) continue;
    keys.push(`${target[0]}/${target[1]}`);
  }
  return keys;
}

export function collect(src) {
  const files = new Map();
  const depthSeen = new Map(); // key -> shallowest depth reached, so a shorter path can reach deeper imports
  const visit = (key, depth) => {
    if (depth > MAX_IMPORT_DEPTH || (depthSeen.has(key) && depthSeen.get(key) <= depth)) return;
    const text = src.read(key);
    if (text == null) return; // an @token that is not a file (e.g. @playwright/mcp) is ignored
    depthSeen.set(key, depth);
    files.set(key, text.length);
    for (const k of findImports(text, key)) visit(k, depth + 1);
  };
  visit('user/CLAUDE.md', 0);
  if (PROJECT) for (const root of PROJECT_ROOTS) visit(`project/${root}`, 0);
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
    const where = REPO ? (STAGED ? 'repo (staged)' : 'repo') : HOME + (PROJECT ? ` + ${PROJECT}` : '');
    if (args.includes('--json')) {
      console.log(JSON.stringify({ where, files: rows.length, total, maxChars: budget.maxChars, limitChars: budget.limitChars, over, largest: rows.slice(0, 8) }));
    } else {
      console.log(`always-loaded: ${rows.length} files, ${total} chars (budget ${budget.maxChars}, Claude Code limit ${budget.limitChars}) [${where}]${over ? '  OVER BUDGET' : ''}`);
      if (over || args.includes('--verbose')) {
        for (const r of rows.slice(0, over ? 8 : rows.length)) console.log(`  ${String(r.chars).padStart(7)}  ${r.file}`);
      }
      if (over) console.log('  Move text behind a trigger (a hook, `paths:` frontmatter, or a skill), or raise maxChars in scripts/rules/context-budget.json deliberately.');
    }
    if (args.includes('--tighten')) tighten(budget, total);
    process.exit(over ? 1 : 0);
  } catch (err) {
    console.log(`context-budget-guard: skipped (${err.message.split('\n')[0]})`);
    process.exit(0);
  }
}

/**
 * --repo --tighten: after a cut, lower maxChars to total + reserveChars. Never raises it. Only the
 * repo set is the budgeted number; the live set is a subset, so tightening from it would be wrong.
 */
function tighten(budget, total) {
  if (!REPO || STAGED || args.includes('--json')) {
    // stderr, so a --json caller still gets one parseable JSON line on stdout.
    console.error('  --tighten needs --repo, without --staged or --json; maxChars unchanged.');
    return;
  }
  const reserve = Number.isFinite(budget.reserveChars) ? budget.reserveChars : 300;
  const target = total + reserve;
  if (target >= budget.maxChars) {
    console.log(`  tighten: maxChars stays ${budget.maxChars} (total + reserve = ${target}).`);
    return;
  }
  const file = join(here, 'context-budget.json');
  // Temp file + rename: a stopped write must never leave invalid JSON, which the guard would skip (fail open).
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...budget, maxChars: target }, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  console.log(`  tighten: maxChars ${budget.maxChars} -> ${target} (reserve ${reserve}).`);
}
