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
// Full ref names (fail-closed fix, CLI finding 1): an abbreviated fork/main can be shadowed by a local branch or a tag.
const FORK_REF = 'refs/remotes/fork/main';
const LOCAL_REF = 'refs/heads/main';
const SHOW = `show ${FORK_REF}:review-router.config.json`;
const SHOW_LOCAL = `show ${LOCAL_REF}:review-router.config.json`;
const EXISTS_FORK = `rev-parse --verify --quiet ${FORK_REF}`;
const EXISTS_LOCAL = `rev-parse --verify --quiet ${LOCAL_REF}`;
const STRICT_ALL = { enforce: true, cap: 0, summaryFail: true };

/**
 * A git stub. `main` is the text of fork/main's config, `localMain` the text of the local branch main.
 * A ref exists when its text is not null, or when `forkRef` / `localRef` says so (a ref that exists and whose show fails).
 */
function gitStub({ main = null, localMain = null, forkRef = main !== null, localRef = localMain !== null, calls = [] } = {}) {
  return (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === EXISTS_FORK) return { status: forkRef ? 0 : 1, stdout: '' };
    if (key === EXISTS_LOCAL) return { status: localRef ? 0 : 1, stdout: '' };
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

const BRANCH_LOOSE = { checkpoint: { enforce: false }, coderabbit: { cli_daily_cap_usd: 7 }, pre_pr: { summary_mode: 'note' } };
const LOOSE_MAIN = JSON.stringify({ checkpoint: { enforce: false }, coderabbit: { cli_daily_cap_usd: 50 }, pre_pr: { summary_mode: 'note' } });

test('A5a3 (finding 3): fork/main exists but its text is not JSON: the main side is strict, and the local main is NOT used', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: '{not json', localMain: LOOSE_MAIN }) });
  assert.equal(got.source, 'fork-main-unreadable');
  assert.deepEqual(viewOf(stricterConfig(got.config, BRANCH_LOOSE)), STRICT_ALL);
});

test('A5a4 (finding 3): fork/main exists but git show fails: strict, no fallback to the local main', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: null, forkRef: true, localMain: LOOSE_MAIN }) });
  assert.equal(got.source, 'fork-main-unreadable');
  assert.deepEqual(viewOf(stricterConfig(got.config, BRANCH_LOOSE)), STRICT_ALL);
});

test('A5a5 (finding 3): fork/main is a JSON value that is not an object (an array): strict', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: '[]', localMain: LOOSE_MAIN }) });
  assert.equal(got.source, 'fork-main-unreadable');
});

test('A5a6: fork/main is absent and the local main exists but is not JSON: strict (the fallback only reads a good local main)', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: null, localMain: '{not json' }) });
  assert.equal(got.source, 'local-main-unreadable');
  assert.deepEqual(viewOf(stricterConfig(got.config, BRANCH_LOOSE)), STRICT_ALL);
});

test('A5g: the existence check fails with an error other than "no such ref" (status 128): strict', () => {
  const git = (args) => (args.join(' ') === EXISTS_FORK ? { status: 128, stdout: '' } : { status: 1, stdout: '' });
  const got = readMainConfig({ root: '/work/wt', git });
  assert.equal(got.source, 'git-error');
  assert.deepEqual(viewOf(stricterConfig(got.config, BRANCH_LOOSE)), STRICT_ALL);
});

test('A15 (finding 1): the main read uses the full ref names and never the abbreviated ones', () => {
  const calls = [];
  readMainConfig({ root: '/work/wt', git: gitStub({ main: null, localMain: JSON.stringify({}), calls }) });
  assert.ok(calls.includes(SHOW_LOCAL), calls.join(' | '));
  assert.ok(calls.includes(EXISTS_FORK), calls.join(' | '));
  assert.equal(calls.filter((c) => /^show (fork\/main|main):/.test(c) || /^rev-parse --verify --quiet (fork\/main|main)$/.test(c)).length, 0, calls.join(' | '));
  const calls2 = [];
  readMainConfig({ root: '/work/wt', git: gitStub({ main: JSON.stringify({}), calls: calls2 }) });
  assert.ok(calls2.includes(SHOW), calls2.join(' | '));
});

test('A15b (finding 1): a good fork/main wins even when a local main is present (no fallback while the ref exists)', () => {
  const got = readMainConfig({ root: '/work/wt', git: gitStub({ main: JSON.stringify({ checkpoint: { enforce: true } }), localMain: LOOSE_MAIN }) });
  assert.equal(got.source, 'fork-main');
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

test('A5c: a git that throws is never an error and never a loose main side: strict', () => {
  const got = readMainConfig({ root: '/work/wt', git: () => { throw new Error('spawn git ENOENT'); } });
  assert.equal(got.source, 'git-error');
  assert.deepEqual(viewOf(stricterConfig(got.config, BRANCH_LOOSE)), STRICT_ALL);
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
    if (key === EXISTS_FORK) return { status: 0, stdout: '' };
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
    if (key === EXISTS_FORK) return { status: 0, stdout: '' };
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
