// Tests for the opengrep engine in semgrep-ccv3.mjs. Run: node --test scripts/ratchets/semgrep-ccv3-opengrep.test.mjs
// No scanner starts: the spawn call is injected. The ratchet is the real scan-ratchet.mjs run().
//
// Failure modes, and the source change that makes each test fail:
//   OG1  opengrep is found but Docker still runs, or --metrics=off is sent    -> engine choice dropped, or the Docker flag list reused
//   OG2  the binary lookup: env first, then the newest version folder         -> the sort is by text (v1.9 beats v1.33), or env is ignored
//   OG3  opengrep names the rule scripts.ratchets.semgrep-ccv3.<id> and writes backslash paths
//        -> the report is not normalised, so no key matches the baseline or the --changed list
//   OG4  no opengrep                                                          -> no fallback to Docker, or the engine is not printed
//   OG5  a rule id with a dot                                                 -> the id prefix is cut at the last dot, so such an id would be cut wrong
//   OG6  a new finding still fails the ratchet through opengrep               -> findings are dropped in the normalise step
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RULES_DIR, findOpengrep, main, normaliseOpengrepReport } from './semgrep-ccv3.mjs';

const temp = () => mkdtempSync(path.join(tmpdir(), 'sg-og-'));
const ID = 'ccv3-graphql-connection-no-pageinfo';
const ogResult = (file) => ({ check_id: `scripts.ratchets.semgrep-ccv3.${ID}`, path: file, extra: { severity: 'ERROR' } });

function harness({ stdout, baselineCounts = {}, found = process.execPath }) {
  const dir = temp();
  const baseline = path.join(dir, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ tool: 'semgrep', reason: 'test', total: 0, counts: baselineCounts }));
  const lines = [];
  const calls = [];
  const deps = {
    spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout, stderr: '' }; },
    log: (s) => lines.push(String(s)),
    env: { DOCKER_BIN: 'docker-test' },
    findOpengrep: () => found,
    baseline,
    tmp: () => dir,
  };
  return { deps, lines, calls, dir };
}

test('OG1: with opengrep found, it runs (not Docker), from the repo root, without --metrics=off, and the engine is printed', () => {
  const h = harness({ stdout: JSON.stringify({ results: [], errors: [] }) });
  assert.equal(main([], h.deps), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].cmd, process.execPath);
  const args = h.calls[0].args;
  assert.ok(!args.some((a) => a.startsWith('--metrics')), 'opengrep rejects --metrics=off');
  assert.equal(args[0], 'scan');
  assert.equal(args[args.indexOf('--config') + 1], RULES_DIR);
  assert.ok(args.includes('--json') && args.includes('--quiet'));
  for (const e of ['scripts/ratchets/semgrep-ccv3', '.claude/cache', '.claude/worktrees', 'node_modules', '.git']) assert.equal(args[args.indexOf(e) - 1], '--exclude', e);
  assert.equal(args.at(-1), '.', 'the target is the root, and the run starts there');
  assert.equal(path.resolve(h.calls[0].opts.cwd), path.resolve(RULES_DIR, '..', '..', '..'));
  assert.ok(h.lines.some((l) => /engine: opengrep/.test(l)), h.lines.join('\n'));
});

test('OG2: findOpengrep prefers CCV3_OPENGREP, else the newest version folder under the home tools folder', () => {
  const home = temp();
  const base = path.join(home, 'tools', 'review-scanners', 'opengrep');
  for (const v of ['v1.9.0', 'v1.33.1', 'v1.10.2']) {
    mkdirSync(path.join(base, v), { recursive: true });
    writeFileSync(path.join(base, v, 'opengrep_windows_x86.exe'), '');
  }
  assert.equal(findOpengrep({ env: {}, home }), path.join(base, 'v1.33.1', 'opengrep_windows_x86.exe'));
  const own = path.join(home, 'mine.exe');
  writeFileSync(own, '');
  assert.equal(findOpengrep({ env: { CCV3_OPENGREP: own }, home }), own);
  assert.equal(findOpengrep({ env: { CCV3_OPENGREP: path.join(home, 'gone.exe') }, home }), path.join(base, 'v1.33.1', 'opengrep_windows_x86.exe'), 'a variable that names no file is ignored');
  assert.equal(findOpengrep({ env: {}, home: temp() }), null);
});

test('OG3: the opengrep report is normalised to the Docker form (rules.<id>, forward slashes), so the baseline and --changed match', () => {
  const norm = normaliseOpengrepReport({ results: [ogResult('scripts\\a.mjs')], errors: [{ path: '.claude\\x.mjs' }] });
  assert.equal(norm.results[0].check_id, `rules.${ID}`);
  assert.equal(norm.results[0].path, 'scripts/a.mjs');
  assert.equal(norm.errors[0].path, '.claude/x.mjs');
  // End to end through the ratchet: a baselined finding passes, so the key really matches.
  const stdout = JSON.stringify({ results: [ogResult('scripts\\a.mjs')], errors: [] });
  const known = harness({ stdout, baselineCounts: { [`rules.${ID}|scripts/a.mjs`]: 1 } });
  assert.equal(main([], known.deps), 0, known.lines.join('\n'));
});

test('OG4: with no opengrep it falls back to Docker and prints the engine', () => {
  const h = harness({ stdout: JSON.stringify({ results: [], errors: [] }), found: null });
  assert.equal(main([], h.deps), 0);
  assert.equal(h.calls[0].cmd, 'docker-test');
  assert.ok(h.lines.some((l) => /engine: docker/.test(l)), h.lines.join('\n'));
});

test('OG5: no rule id in the pack has a dot, because the id prefix is cut at the last dot', () => {
  const ids = readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml')).flatMap((f) => [...readFileSync(path.join(RULES_DIR, f), 'utf8').matchAll(/^\s*-?\s*id:\s*(\S+)/gm)].map((m) => m[1]));
  assert.ok(ids.length >= 3, 'the pack has rules');
  for (const id of ids) assert.ok(!id.includes('.'), id);
});

test('OG6: a new finding through opengrep still fails the ratchet, and a clean report passes', () => {
  const dirty = harness({ stdout: JSON.stringify({ results: [ogResult('scripts\\a.mjs')], errors: [] }) });
  assert.equal(main([], dirty.deps), 1);
  assert.ok(dirty.lines.some((l) => l.startsWith('NEW ') && l.includes(`rules.${ID}`)), dirty.lines.join('\n'));
});
