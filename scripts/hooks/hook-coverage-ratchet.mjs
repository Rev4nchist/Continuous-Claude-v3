#!/usr/bin/env node
/**
 * hook-coverage-ratchet -- every hook registered in .claude/settings.json.template needs a test.
 *
 * A "test" is a test file that CI runs, with real evidence for the dist name:
 *   - .claude/hooks/src/__tests__/**\/*.test.ts (the vitest include in .claude/hooks/vitest.config.ts), or
 *   - scripts/**\/*.test.(mjs|js|cjs|ts) whose path appears in package.json "test:scripts" or in
 *     .github/workflows/ccv3-checks.yml (a file CI never runs proves nothing).
 * Evidence, per name:
 *   1. an import, dynamic import or require that resolves to .claude/hooks/src/<name>(.ts|.js|.mjs|.mts).
 *      Only the top level of src counts: shared/ and lib/ do not. The path resolves from the test file, or
 *   2. a resolveHook('<name>') call, or
 *   3. a spawn call (spawn, exec, execFile, fork, runHook...) with a string that ends in <name>.mjs in the same
 *      call, or a constant that holds such a string and is passed to a spawn call.
 * A name in a comment, a plain string list or a test title is NOT evidence. Probes (scripts/coordination/*-probe.mjs)
 * are NOT tests: CI does not run them.
 *
 * The baseline (scripts/hooks/hook-coverage-baseline.json, key "untested") lists hooks that have no test today. It may
 * only shrink: MAX_UNTESTED caps its length, and lowering MAX_UNTESTED is part of every shrink.
 *   untested-not-in-baseline       a registered hook has no test and is not in the baseline (a new hook shipped untested)
 *   stale-baseline                 a baseline name is now tested, or no longer registered: remove from baseline
 *   baseline-over-cap              the baseline is longer than MAX_UNTESTED
 *   baseline-duplicate             a name is in the baseline twice
 *   baseline-malformed             the baseline is not a list, or an entry is not a string
 *   unparsed-registration          a command hook in settings has no hooks/dist/<name>.mjs (or dist/<name>.mjs) path
 *   vacuous                        zero registrations: 0 of 0 proves nothing
 *   registration-count-regression  fewer registrations than the floor (MIN_REGISTERED)
 *   unreadable-settings | unreadable-baseline   an input file cannot be read
 *
 * Same split as trace-marker-check.mjs: pure exported functions, then a CLI. The registration parser reads args, as
 * hook-contract-guard.mjs does: the entries are {command:"node", args:[path]}.
 *
 * Follow-up, not done here: check the LIVE ~/.claude/settings.json against the tests too. This ratchet reads the
 * template only, so a hook registered only in a live copy is not covered. The doctor is not wired to it yet.
 *
 * USAGE
 *   node scripts/hooks/hook-coverage-ratchet.mjs            # exit 1 on a finding
 *   node scripts/hooks/hook-coverage-ratchet.mjs --json
 *   node scripts/hooks/hook-coverage-ratchet.mjs --settings <file> --baseline <file>   # check another copy
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Floor, not a target. Raise on purpose; never lower to make a run pass. */
export const MIN_REGISTERED = 60;
/** Ceiling on the baseline length. Lower it in every commit that removes a baseline name. Never raise it. */
export const MAX_UNTESTED = 14;
const HOOK_TEST_ROOT = join('.claude', 'hooks', 'src', '__tests__');
const HOOK_TEST_FILE = /\.test\.ts$/;
const SCRIPT_TEST_FILE = /\.test\.(?:ts|mjs|js|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const SPAWN_CALL = '\\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|fork|runHook\\w*)\\s*\\(';
const IMPORT_SPEC = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
// Same pattern as WHOLE_LINE_BLOCK in scripts/coordination/kanban-strip.mjs.
const WHOLE_LINE_BLOCK = /^[ \t]*\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*(?:\r?\n|$)/gm;
const DIST_NAME = /(?:hooks[/\\]|(?:^|[\s"'])(?:\.[/\\])?)dist[/\\]([A-Za-z0-9._-]+)\.mjs(?![\w.-])/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosix = (p) => p.replaceAll('\\', '/');

/** Drop whole-line block comments, full-line comments and trailing comments, so a name in a comment is not evidence. */
export function stripComments(text) {
  return text
    .replace(WHOLE_LINE_BLOCK, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** True when the test file imports .claude/hooks/src/<name> (top level of src only). */
function importsHook(name, testPath, code) {
  const target = new RegExp(`^\\.claude/hooks/src/${escapeRe(name)}(?:\\.(?:js|ts|mjs|mts))?$`);
  const dir = posix.dirname(toPosix(testPath));
  for (const m of code.matchAll(IMPORT_SPEC)) {
    if (m[1].startsWith('.') && target.test(posix.normalize(posix.join(dir, m[1])))) return true;
  }
  return false;
}

/** True when a spawn call holds a string ending in <name>.mjs, directly or through a constant passed to the call. */
function spawnsHook(name, code) {
  const n = escapeRe(name);
  const dist = `['"/\\\\]${n}\\.mjs`;
  if (new RegExp(`${SPAWN_CALL}[^;]*?${dist}`).test(code)) return true;
  const decl = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=;]+)?=[^;]*?${dist}`, 'g');
  for (const m of code.matchAll(decl)) {
    if (new RegExp(`${SPAWN_CALL}[^;]*?\\b${m[1]}\\b`).test(code)) return true;
  }
  return false;
}

function hasEvidence(name, test) {
  const resolver = new RegExp(`resolveHook\\(\\s*['"]${escapeRe(name)}['"]`);
  return importsHook(name, test.path, test.code) || resolver.test(test.code) || spawnsHook(name, test.code);
}

/** Registered names with no test evidence, sorted. tests: [{path, text}]. */
export function untestedHooks({ registered, tests }) {
  const stripped = tests.map((t) => ({ path: t.path, code: stripComments(t.text) }));
  return [...registered].filter((name) => !stripped.some((t) => hasEvidence(name, t))).sort();
}

/** Baseline shape findings, and the clean list of string names. */
function checkBaselineShape(baseline, maxUntested) {
  const findings = [];
  if (!Array.isArray(baseline)) {
    findings.push({ kind: 'baseline-malformed', detail: `baseline "untested" must be a list of hook names, got ${typeof baseline}.` });
    return { names: [], findings };
  }
  const names = baseline.filter((n) => typeof n === 'string');
  if (names.length !== baseline.length) {
    findings.push({ kind: 'baseline-malformed', detail: `${baseline.length - names.length} baseline entr(ies) are not strings. Every entry must be a hook name.` });
  }
  const dups = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dups.length) findings.push({ kind: 'baseline-duplicate', detail: `baseline lists a name twice: ${dups.join(', ')}. Remove the copy.` });
  if (names.length > maxUntested) {
    findings.push({ kind: 'baseline-over-cap', detail: `baseline has ${names.length} names, MAX_UNTESTED is ${maxUntested}. The baseline may only shrink: remove names, never add. Part of every shrink: lowering MAX_UNTESTED to the new baseline length.` });
  }
  return { names, findings };
}

/** Findings for one run. baseline: array of names. unparsed: command hooks the parser could not read. */
export function hookCoverageFindings({ registered, tests, baseline, minRegistered = MIN_REGISTERED, maxUntested = MAX_UNTESTED, unparsed = [] }) {
  const findings = [];
  if (unparsed.length) {
    findings.push({ kind: 'unparsed-registration', detail: `${unparsed.length} command hook(s) in settings have no hooks/dist/<name>.mjs path, so no test can be checked: ${unparsed.join(' | ')}.` });
  }
  const shape = checkBaselineShape(baseline, maxUntested);
  findings.push(...shape.findings);
  if (registered.length === 0) {
    findings.push({ kind: 'vacuous', detail: '0 hooks registered: the coverage check proved nothing. Check the settings file and the args-aware parser.' });
    return findings; // the baseline-content findings would only repeat the same fault
  }
  if (registered.length < minRegistered) {
    findings.push({ kind: 'registration-count-regression', detail: `${registered.length} hooks registered, floor is ${minRegistered}. Check the parser before you assume registrations were removed.` });
  }
  const untested = untestedHooks({ registered, tests });
  const base = new Set(shape.names);
  const fresh = untested.filter((n) => !base.has(n));
  if (fresh.length) {
    findings.push({ kind: 'untested-not-in-baseline', detail: `${fresh.length} registered hook(s) have no test that imports or spawns them: ${fresh.join(', ')}. Add a test file for each. Do not add them to the baseline.` });
  }
  const regSet = new Set(registered);
  const untestedSet = new Set(untested);
  const stale = [...base].filter((n) => !untestedSet.has(n));
  if (stale.length) {
    const why = stale.map((n) => `${n} (${regSet.has(n) ? 'now tested' : 'no longer registered'})`).join(', ');
    findings.push({ kind: 'stale-baseline', detail: `${stale.length} baseline name(s) are out of date: ${why}. Edit the baseline: remove from baseline. It may only shrink. Part of every shrink: lowering MAX_UNTESTED to the new baseline length.` });
  }
  return findings;
}

/** Hook dist names and unreadable command hooks from a parsed settings object. Args-aware. */
export function parseRegistrations(settings) {
  const names = new Set();
  const unparsed = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (h?.type !== 'command' && typeof h?.command !== 'string') continue;
        const text = [h.command, ...(Array.isArray(h.args) ? h.args : [])].join(' ').trim();
        const m = text.match(DIST_NAME);
        if (m) names.add(m[1]);
        else unparsed.push(text);
      }
    }
  }
  return { names: [...names].sort(), unparsed };
}

/** Hook dist names from a parsed settings object. */
export function registeredHookNames(settings) {
  return parseRegistrations(settings).names;
}

/** A glob-ish token from package.json or the workflow -> an anchored regex. `*` stays in one segment, `**` crosses. */
function tokenToRegex(token) {
  const body = token.split('**').map((seg) => seg.split('*').map(escapeRe).join('[^/]*')).join('.*');
  return new RegExp(`^${body}$`);
}

/** Regexes for every script test that CI runs: named in package.json test:scripts or in ccv3-checks.yml. */
function wiredScriptTests(repoRoot) {
  const texts = [];
  try { texts.push(String(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts?.['test:scripts'] ?? '')); } catch { /* no wiring */ }
  try {
    const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'ccv3-checks.yml'), 'utf8');
    texts.push(wf.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n'));
  } catch { /* no wiring */ }
  const tokens = texts.join('\n').match(/[\w.@/*-]+\.test\.(?:mjs|js|cjs|ts)/g) ?? [];
  return tokens.map((t) => tokenToRegex(t.replace(/^\.\//, '')));
}

/** Every test file CI runs: [{path (relative to repoRoot), text}]. */
export function loadTestFiles(repoRoot) {
  const out = [];
  const walk = (dir, accept) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, accept); continue; }
      const rel = relative(repoRoot, p);
      if (accept(e.name, toPosix(rel))) out.push({ path: rel, text: readFileSync(p, 'utf8') });
    }
  };
  walk(join(repoRoot, HOOK_TEST_ROOT), (name) => HOOK_TEST_FILE.test(name));
  const wired = wiredScriptTests(repoRoot);
  walk(join(repoRoot, 'scripts'), (name, rel) => SCRIPT_TEST_FILE.test(name) && wired.some((re) => re.test(rel)));
  return out;
}

/** The whole check for one tree. */
export function checkRepo({ repoRoot, settingsPath, baselinePath, minRegistered = MIN_REGISTERED, maxUntested = MAX_UNTESTED }) {
  const settingsFile = settingsPath ?? join(repoRoot, '.claude', 'settings.json.template');
  const baselineFile = baselinePath ?? join(repoRoot, 'scripts', 'hooks', 'hook-coverage-baseline.json');
  const input = [];
  let registered = [];
  let unparsed = [];
  let baseline = [];
  try {
    ({ names: registered, unparsed } = parseRegistrations(JSON.parse(readFileSync(settingsFile, 'utf8'))));
  } catch (err) {
    input.push({ kind: 'unreadable-settings', detail: `${settingsFile}: ${err.message}` });
  }
  try { baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).untested ?? []; } catch (err) {
    input.push({ kind: 'unreadable-baseline', detail: `${baselineFile}: ${err.message}` });
  }
  const tests = loadTestFiles(repoRoot);
  const findings = [...input, ...hookCoverageFindings({ registered, tests, baseline, minRegistered, maxUntested, unparsed })];
  return {
    ok: findings.length === 0,
    registered: registered.length,
    testFiles: tests.length,
    untested: untestedHooks({ registered, tests }),
    baseline: Array.isArray(baseline) ? baseline : [],
    findings,
  };
}

/** One verdict line. It always carries the registered count. */
export function verdictLine(r) {
  const tested = r.registered - r.untested.length;
  return `${r.ok ? 'PASS' : 'FAIL'}  hook-coverage-ratchet  ${r.registered} registered, ${tested} tested, ${r.untested.length} untested (baseline ${r.baseline.length})`;
}

function main(argv) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? resolve(argv[i + 1] ?? '') : undefined; };
  const r = checkRepo({ repoRoot, settingsPath: opt('--settings'), baselinePath: opt('--baseline') });
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(verdictLine(r));
    for (const f of r.findings) console.log(`  ${f.kind}: ${f.detail}`);
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
