// Lane pr-review-loop-10k-cut. The full PR review rule is 64 KB and a hook cannot send it whole, so the manifest loads a
// short core file and the full file is read on demand. These tests read the real repo files. Each one is a way the
// session can lose the rule again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_CONTEXT_CAP, KNOWN_COFIRE_OVER, REFERENCE_ONLY, ROUTER_OVERHEAD, checkIndex } from '../ondemand-index-check.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude', 'rules-ondemand');
const read = (f) => readFileSync(join(DIR, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const core = read('pr-review-loop-core.md');
const full = read('pr-review-loop.md');
const size = (f) => read(f).trim().length;

/** The core file may not grow past this: with pr-and-commit-style (3,866) and the router lines it must stay under the hook cap. */
const CORE_MAX = 4500;

test('the manifest loads the core file for pr-review-loop and never the 64 KB file', () => {
  const entry = manifest.rules.find((r) => r.id === 'pr-review-loop');
  assert.deepEqual(entry.files, ['pr-review-loop-core.md']);
});

test('the core file is small enough to reach a session whole', () => {
  assert.ok(core.trim().length <= CORE_MAX, `core is ${core.trim().length} characters, the limit is ${CORE_MAX}`);
});

test('the core file names the full file by its active path and says to read it before open, checkpoint and land', () => {
  assert.ok(core.includes('C:/Users/dkhay/.claude/rules-ondemand/pr-review-loop.md'));
  assert.match(core, /Read the matching section of the full rule with the Read tool BEFORE the open, the checkpoint and the land steps/);
});

test('the core file carries the decision that stops the wrong question: below risk band HIGH the pick is none', () => {
  assert.match(core, /Below risk band HIGH the recommended pick is none/);
  assert.match(core, /Only Dave merges/);
});

test('the core file tells the session to ask the question that pr_checkpoint returns and to call it again (checkpoint.ledger is true)', () => {
  const config = JSON.parse(readFileSync(join(DIR, '..', '..', 'review-router.config.json'), 'utf8'));
  assert.equal(config.checkpoint.ledger, true, 'the core text assumes checkpoint.ledger true; update the core when the flag changes');
  assert.match(core, /It returns his question: ask it with AskUserQuestion word for word, then call `pr_checkpoint` again/);
});

test('the core file allows a plain review request only when a round is left, and a paid one only after ALLOW and a tap', () => {
  assert.match(core, /plain `@coderabbitai review` only when the `pr_watch` line says a round is left/);
  assert.match(core, /`--use-credits`\) needs `cr-paid\.mjs check` to print ALLOW and his tap/);
});

// The gate (ondemand-index-check.mjs) holds the rest: the section index, the path link and the joined text of rules that
// fire together. It runs on every edit under .claude/rules-ondemand, so the real repo must pass it.
test('the real manifest, index and rule files pass the index gate, including the section index and the co-fire sizes', () => {
  const indexText = readFileSync(join(DIR, '..', 'rules-src', 'on-demand-rules.md'), 'utf8');
  const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  const sizes = Object.fromEntries(files.map((f) => [f, size(f)]));
  const texts = Object.fromEntries(files.map((f) => [f, read(f)]));
  assert.deepEqual(checkIndex({ manifest, indexText, files, sizes, texts, referenceOnly: REFERENCE_ONLY, knownCofire: KNOWN_COFIRE_OVER }), []);
});

test('the PR entry commands that start a session fit the hook cap with the rules that fire beside the core file', () => {
  const entry = ['gh pr create --draft', 'gh api repos/o/r/pulls -X POST', 'node scripts/github/pre-pr.mjs', 'node scripts/github/review-status.mjs 1', 'node scripts/github/ship-ask.mjs open-pr'];
  const test1 = (patterns, s) => (patterns || []).some((p) => new RegExp(p).test(s));
  for (const cmd of entry) {
    const matched = manifest.rules.filter((r) => test1(r.command, cmd) || test1(r.segment, cmd));
    assert.ok(matched.some((r) => r.id === 'pr-review-loop'), `pr-review-loop does not fire on: ${cmd}`);
    const chars = matched.reduce((n, r) => n + r.files.reduce((m, f) => m + size(f), 0) + ROUTER_OVERHEAD, 0) + 2 * (matched.length - 1);
    assert.ok(chars <= HOOK_CONTEXT_CAP, `${cmd}: ${matched.map((r) => r.id).join('+')} join to ${chars}`);
  }
});
