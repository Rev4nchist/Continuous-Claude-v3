// Lane pr-review-loop-10k-cut. The full PR review rule is 64 KB and a hook cannot send it whole, so the manifest loads a
// short core file and the full file is read on demand. These tests read the real repo files. Each one is a way the
// session can lose the rule again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_CONTEXT_CAP, ROUTER_OVERHEAD } from '../ondemand-index-check.mjs';

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

/** A heading without its date or aside: "Paid PR reviews (Dave, 2026-10-30)" becomes "Paid PR reviews". */
const plain = (h) => h.replace(/\s+[(—].*$/, '').trim();

test('every ## section of the full file has a line in the core index, so a new section cannot hide', () => {
  const headings = full.split(/\r?\n/).filter((l) => /^## /.test(l)).map((l) => plain(l.slice(3)));
  assert.ok(headings.length >= 10, `read only ${headings.length} headings`);
  const missing = headings.filter((h) => !core.includes(h));
  assert.deepEqual(missing, [], `the core index has no line for: ${missing.join('; ')}`);
});

// A command that opens or starts the PR flow. The router joins every rule that fires on one call into ONE text, and
// Claude Code cuts that text above 10,000 characters. It tests `command` regexes on the segment and `segment` regexes
// on the segment with quotes kept. A deny-first rule makes the whole output a deny reason, which is not cut.
const ENTRY_COMMANDS = [
  'gh pr create --draft --title t -F body=@b.md',
  'gh api repos/Rev4nchist/Continuous-Claude-v3/pulls -X POST -F draft=true -F body=@b.md',
  'node scripts/github/pre-pr.mjs --body b.md',
  'node scripts/github/review-status.mjs 12',
  'node scripts/github/ship-ask.mjs open-pr --json',
];

const hit = (patterns, s) => (patterns || []).some((p) => new RegExp(p).test(s));

test('the joined text of every rule that fires with pr-review-loop on a PR entry command is under the hook cap', () => {
  const rows = [];
  for (const cmd of ENTRY_COMMANDS) {
    const matched = manifest.rules.filter((r) => hit(r.command, cmd) || hit(r.segment, cmd));
    assert.ok(matched.some((r) => r.id === 'pr-review-loop'), `pr-review-loop does not fire on: ${cmd}`);
    if (matched.some((r) => r.mode === 'deny-first')) continue;
    const chars = matched.reduce((n, r) => n + r.files.reduce((m, f) => m + size(f), 0) + ROUTER_OVERHEAD, 0) + 2 * (matched.length - 1);
    rows.push({ cmd, ids: matched.map((r) => r.id).join('+'), chars });
  }
  const over = rows.filter((r) => r.chars > HOOK_CONTEXT_CAP);
  assert.deepEqual(over, [], `joined text over ${HOOK_CONTEXT_CAP}: ${JSON.stringify(over)}`);
});
