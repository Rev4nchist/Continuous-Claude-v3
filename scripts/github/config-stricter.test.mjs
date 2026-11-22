// Tests for coord-cap-override PR A: the stricter of main and the branch wins for review-router.config.json.
// Run: node --test scripts/github/config-stricter.test.mjs
// Each row of fixtures/stricter-config-cases.json is also run against the TypeScript twin by
// .claude/hooks/src/__tests__/pre-pr-gate-stricter.test.ts, so the two copies cannot differ.
// No network, no real git: git is a stub that serves the text a test gives it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadStricterConfig, readMainConfig, stricterConfig, viewOf } from './config-stricter.mjs';
import { resolveConfig, runPrePr, summaryBeforeLock } from './pre-pr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'stricter-config-cases.json'), 'utf8')).rows;
const SHOW = 'show fork/main:review-router.config.json';
const SHOW_LOCAL = 'show main:review-router.config.json';

/** A git stub: `main` is the text of fork/main's config, `localMain` the text of the local branch main (null: no such ref). */
function gitStub({ main = null, localMain = null, calls = [] } = {}) {
  return (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === SHOW) return main === null ? { status: 128, stdout: '' } : { status: 0, stdout: main };
    if (key === SHOW_LOCAL) return localMain === null ? { status: 128, stdout: '' } : { status: 0, stdout: localMain };
    // Served on purpose: the old code read the primary checkout's working tree through this answer. The new code never asks.
    if (key === 'rev-parse --git-common-dir') return { status: 0, stdout: '/work/wt/.git\n' };
    return { status: 1, stdout: '' };
  };
}

for (const row of CASES) {
  test(`${row.id}: ${row.name}`, () => {
    const got = stricterConfig(row.main, row.branch);
    assert.deepEqual(viewOf(got), row.expect);
    for (const [section, key, value] of row.keep ?? []) {
      assert.equal(key === null ? got[section] : got[section]?.[key], value, `${section}.${key} keeps the branch value`);
    }
  });
}

test('A11g: a branch cap of NaN (not JSON, so it is not a fixture row) is ignored and the main cap stays', () => {
  const got = stricterConfig({ coderabbit: { cli_daily_cap_usd: 3 } }, { coderabbit: { cli_daily_cap_usd: NaN } });
  assert.equal(viewOf(got).cap, 3);
});

test('A13: the inputs are not changed', () => {
  const main = { checkpoint: { enforce: true } };
  const branch = { checkpoint: { enforce: false }, coderabbit: { cli_daily_cap_usd: 9 } };
  const before = JSON.stringify([main, branch]);
  stricterConfig(main, branch);
  assert.equal(JSON.stringify([main, branch]), before);
});

test('A5a: no fork/main ref and a local main ref: the committed local main is the main side', () => {
  const localMain = JSON.stringify({ checkpoint: { enforce: true } });
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: null, localMain }) });
  assert.equal(got.source, 'local-main');
  assert.deepEqual(got.config, { checkpoint: { enforce: true } });
});

test('A5a2: fork/main is read first; it wins over the local main', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: JSON.stringify({ checkpoint: { enforce: true } }), localMain: JSON.stringify({ checkpoint: { enforce: false } }) }) });
  assert.equal(got.source, 'fork-main');
  assert.equal(got.config.checkpoint.enforce, true);
});

test('A5a3: a fork/main text that is not JSON counts as missing: the local main is used', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: '{not json', localMain: JSON.stringify({ checkpoint: { enforce: true } }) }) });
  assert.equal(got.source, 'local-main');
});

test('A5b: neither ref is readable: config null, source none, and the stricter config enforces with the branch cap', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: null, localMain: null }) });
  assert.deepEqual(got, { config: null, source: 'none' });
  const cfg = stricterConfig(got.config, { checkpoint: { enforce: false }, coderabbit: { cli_daily_cap_usd: 7 } });
  assert.deepEqual(viewOf(cfg), { enforce: true, cap: 7, summaryFail: false });
});

test('A5e: the working-tree file says enforce false, fork/main is missing, the committed local main says true: enforce (the card goal)', () => {
  const reads = [];
  const readFile = (p) => { reads.push(p); return JSON.stringify({ checkpoint: { enforce: false } }); };
  const cfg = loadStricterConfig({ root: '/work/wt', git: gitStub({ main: null, localMain: JSON.stringify({ checkpoint: { enforce: true } }) }), readFile });
  assert.equal(viewOf(cfg).enforce, true);
  assert.equal(reads.length, 1, `only the branch file is read from disk: ${reads.join(' | ')}`);
});

test('A5c: a git that throws counts as no main side, never as an error', () => {
  const got = readMainConfig({ root: '/work/wt', git: () => { throw new Error('spawn git ENOENT'); } });
  assert.equal(got.source, 'none');
});

test('A10a: the main read runs no git fetch and no pull', () => {
  const calls = [];
  readMainConfig({ root: '/work/wt', git: gitStub({ main: null, calls }) });
  assert.ok(calls.length > 0);
  assert.equal(calls.filter((c) => /\b(fetch|pull|remote)\b/.test(c)).length, 0, calls.join(' | '));
});

test('A9a: resolveConfig gives the stricter cap and summary mode to a branch that raised the cap and set the mode to note', () => {
  const branch = { coderabbit: { cli_daily_cap_usd: 99 }, pre_pr: { summary_mode: 'note' } };
  const main = { coderabbit: { cli_daily_cap_usd: 3 }, pre_pr: { summary_mode: 'fail' } };
  const read = (p) => (p.endsWith('review-router.config.json') ? JSON.stringify(branch) : null);
  const cfg = resolveConfig({ root: '/work/wt', git: gitStub({ main: JSON.stringify(main) }), readFile: read });
  assert.deepEqual(viewOf(cfg), { enforce: false, cap: 3, summaryFail: true });
});

test('A9b: resolveConfig passes an injected config through unchanged (a test or caller that supplies one)', () => {
  const given = { coderabbit: { cli_daily_cap_usd: 99 } };
  assert.equal(resolveConfig({ root: '/work/wt', git: gitStub({ main: '{}' }), readFile: () => null, config: given }), given);
});

test('A9c: resolveConfig throws on a branch file that is missing or not JSON, as the old read did', () => {
  assert.throws(() => resolveConfig({ root: '/work/wt', git: gitStub({ main: '{}' }), readFile: () => null }));
  assert.throws(() => resolveConfig({ root: '/work/wt', git: gitStub({ main: '{}' }), readFile: () => '{bad' }));
});

test('A9d: summaryBeforeLock runs the summary check in fail mode when main says fail and the branch says note', () => {
  let seen = null;
  const summaryCheck = ({ mode }) => { seen = mode; return { result: { status: 'PASS' } }; };
  const branch = JSON.stringify({ pre_pr: { summary_mode: 'note' } });
  const git = (args) => {
    const key = args.join(' ');
    if (key === SHOW) return { status: 0, stdout: JSON.stringify({ pre_pr: { summary_mode: 'fail' } }) };
    if (key === 'rev-parse HEAD') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
    if (key === 'rev-parse --git-common-dir') return { status: 0, stdout: '/primary/.git\n' };
    return { status: 1, stdout: '' };
  };
  summaryBeforeLock({ root: '/work/wt', git, summaryCheck, readFile: () => branch });
  assert.equal(seen, 'fail');
});

test('A9e: loadStricterConfig on a real read of this checkout gives a config with the same enforce as the file when main is this file', () => {
  const text = readFileSync(path.resolve(HERE, '..', '..', 'review-router.config.json'), 'utf8');
  const cfg = loadStricterConfig({ root: path.resolve(HERE, '..', '..'), git: gitStub({ main: text }), readFile: (p) => readFileSync(p, 'utf8') });
  assert.equal(viewOf(cfg).enforce, JSON.parse(text).checkpoint.enforce === true);
});

test('A14: pre-pr resolves the config after the fetch, so a fork/main that the fetch moves decides the summary mode', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stricter-order-'));
  writeFileSync(path.join(root, 'review-router.config.json'), JSON.stringify({ pre_pr: { summary_mode: 'note' } }));
  let fetched = false;
  const git = (args) => {
    const key = args.join(' ');
    if (key === SHOW) return { status: 0, stdout: JSON.stringify({ pre_pr: { summary_mode: fetched ? 'fail' : 'note' } }) };
    if (key === 'rev-parse HEAD') return { status: 0, stdout: 'a'.repeat(40), stderr: '' };
    if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  let mode = null;
  const summaryCheck = (o) => { mode = o.mode; return { result: { step: 'summary', status: 'FAIL', detail: 'stub', notes: [] }, sha: null }; };
  await runPrePr({ root, base: 'main', bodyText: 'x', git, fetch: () => { fetched = true; return null; }, summaryCheck, ledgerPath: path.join(root, 'ledger.jsonl'), gateLogPath: path.join(root, 'gate.jsonl'), crStore: null, guardLog: () => {}, osvLockfiles: [], findOsv: () => null, findPssa: () => null }).catch(() => {});
  assert.equal(mode, 'fail');
});
