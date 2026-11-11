// The review-engine rule must fire on a claim of a program lane and on nothing else.
// This test pipes real PreToolUse payloads into the built hook .claude/hooks/dist/rule-router.mjs, with the repo manifest
// and a temp state dir, the way scripts/rules/rule-router-probe.mjs does. It does not build the hook: build first
// (npm run build in .claude/hooks). Run: node --test scripts/review-engine/rule-trigger.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(repo, '.claude/hooks/dist/rule-router.mjs');
const RULES = join(repo, '.claude/rules-ondemand');
const state = mkdtempSync(join(tmpdir(), 'review-engine-trigger-'));
after(() => rmSync(state, { recursive: true, force: true, maxRetries: 3 }));

// The same env as the probe. CLAUDE_AGENT_ID is empty so a subagent run still sees the main-thread decision.
const env = {
  ...process.env, CLAUDE_RULES_ONDEMAND_DIR: RULES, CLAUDE_RULE_ROUTER_STATE_DIR: state,
  CLAUDE_RULE_ROUTER_LOG: join(state, 'fires.jsonl'), CCV3_GUARD_DECISIONS_LOG: join(state, 'guard-decisions.jsonl'), CLAUDE_AGENT_ID: '',
};

// Returns { kind, ids } where ids are the rule ids in the first parenthesis of the hook text, as the probe reads them.
function fire(session, command) {
  assert.ok(existsSync(HOOK), `built hook missing: ${HOOK}. Run npm run build in .claude/hooks first.`);
  const payload = { session_id: session, tool_name: 'Bash', tool_input: { command } };
  const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
  const h = JSON.parse(out.trim() || '{}').hookSpecificOutput || {};
  const text = h.permissionDecision === 'deny' ? h.permissionDecisionReason : (h.additionalContext || '');
  const kind = h.permissionDecision === 'deny' ? 'deny' : (h.additionalContext ? 'inject' : 'none');
  const ids = ((text.match(/\(([^)]*)\)/) || [, ''])[1]).split(', ').filter(Boolean);
  return { kind, ids };
}

const SHIM = 'C:/Users/dkhay/.claude/scripts/lane.mjs';
const denies = (r) => r.kind === 'deny' && r.ids.includes('review-engine');

test('T1 a claim of a re- lane blocks once with the review-engine rule; the same session then passes', () => {
  assert.ok(denies(fire('re-t1', `node ${SHIM} claim re-land-ledger --note "claimed"`)));
  assert.ok(!fire('re-t1', `node ${SHIM} claim re-land-ledger`).ids.includes('review-engine'));
});

test('T3 a quoted shim path and a flag value with a space block', () => {
  assert.ok(denies(fire('re-t3', `node "C:/Users/dkhay/.claude/scripts/lane.mjs" --note "a b" claim re-land-ledger`)));
});

test('T4 a flag before claim, and a flag after claim, both block', () => {
  assert.ok(denies(fire('re-t4', `node ${SHIM} --project x claim re-x`)));
  assert.ok(denies(fire('re-t4b', `node ${SHIM} claim --note "n o" re-x`)));
});

test('T5 a Windows backslash path blocks', () => {
  assert.ok(denies(fire('re-t5', 'node C:\\Users\\dkhay\\.claude\\scripts\\lane.mjs claim re-x')));
});

test('T6 the two program externals block', () => {
  assert.ok(denies(fire('re-t6', `node ${SHIM} claim hf-judge-precheck`)));
  assert.ok(denies(fire('re-t6b', `node ${SHIM} claim force-high-security-tier`)));
});

test('T6c a lane that only starts like an external does not block', () => {
  assert.ok(!fire('re-t6c', `node ${SHIM} claim hf-judge-precheck-extra`).ids.includes('review-engine'));
});

test('T7 a claim of a non-program lane does not load the rule', () => {
  assert.ok(!fire('re-t7', `node ${SHIM} claim coord-program-rule`).ids.includes('review-engine'));
});

test('T8 a claim named inside a note does not load the rule', () => {
  assert.ok(!fire('re-t8', `node ${SHIM} note coord-x "next: claim re-foo"`).ids.includes('review-engine'));
});

test('T9 an echo of a claim command loads nothing', () => {
  assert.deepEqual(fire('re-t9', `echo node ${SHIM} claim re-x`), { kind: 'none', ids: [] });
});

test('T10 lane.mjs next (a listing) does not load the rule', () => {
  assert.ok(!fire('re-t10', `node ${SHIM} next`).ids.includes('review-engine'));
});

test('T11 program.mjs ready loads nothing', () => {
  assert.deepEqual(fire('re-t11', 'node scripts/review-engine/program.mjs ready'), { kind: 'none', ids: [] });
});

// --- C4, C5, C7: flag shapes, node shapes, and regex cost ---------------------------------------------------------

test('C4 a boolean flag followed by another flag, before or after claim, blocks', () => {
  assert.ok(denies(fire('re-c4a', `node ${SHIM} claim --force --note "x" re-foo`)));
  assert.ok(denies(fire('re-c4b', `node ${SHIM} --json --project x claim re-foo`)));
  assert.ok(denies(fire('re-c4c', `node ${SHIM} claim --force --json hf-judge-precheck`)));
});

test('C7a node flags before the script block', () => {
  assert.ok(denies(fire('re-c7a', `node --no-warnings ${SHIM} claim re-x`)));
  assert.ok(denies(fire('re-c7a2', `node --no-warnings --max-old-space-size=4096 ${SHIM} claim re-x`)));
});

test('C7b a full or quoted path to node.exe blocks', () => {
  assert.ok(denies(fire('re-c7b', `C:/Program/nodejs/node.exe ${SHIM} claim re-x`)));
  assert.ok(denies(fire('re-c7b2', `"C:/Program Files/nodejs/node.exe" "${SHIM}" claim re-x`)));
  assert.ok(denies(fire('re-c7b3', `'C:/Program Files/nodejs/node.exe' ${SHIM} claim re-x`)));
});

test('C7c a quoted script path that contains a space blocks', () => {
  assert.ok(denies(fire('re-c7c', 'node "C:/Users/Dave Hayes/.claude/scripts/lane.mjs" claim re-x')));
  assert.ok(denies(fire('re-c7c2', "node 'C:/Users/Dave Hayes/.claude/scripts/lane.mjs' claim force-high-security-tier")));
});

test('C7d a PowerShell variable as the script path blocks (covered, optional)', () => {
  assert.ok(denies(fire('re-c7d', 'node $shim claim re-x')));
});

test('C7e a claim inside a shell wrapper blocks', () => {
  assert.ok(denies(fire('re-c7e', `bash -c 'node --no-warnings ${SHIM} claim --force re-x'`)));
});

test('C-neg1 claim reboot and node-flag shapes of non-claims load nothing', () => {
  assert.ok(!fire('re-cn1', `node ${SHIM} claim reboot`).ids.includes('review-engine'));
  assert.ok(!fire('re-cn1b', `node --no-warnings ${SHIM} next`).ids.includes('review-engine'));
  assert.ok(!fire('re-cn1c', `node --no-warnings ${SHIM} claim --force coord-program-rule`).ids.includes('review-engine'));
});

test('C-neg2 a note that names a claim, with node flags, loads nothing', () => {
  assert.ok(!fire('re-cn2', `node --no-warnings ${SHIM} note coord-x "next: claim re-foo"`).ids.includes('review-engine'));
});

test('C-neg3 an echo of a node-flag claim loads nothing', () => {
  assert.deepEqual(fire('re-cn3', `echo node --no-warnings ${SHIM} claim re-x`), { kind: 'none', ids: [] });
});

// C5: the trigger runs on every Bash and PowerShell call, so a failing input must not cost exponential time.
function reviewEnginePattern() {
  const manifest = JSON.parse(readFileSync(join(RULES, 'manifest.json'), 'utf8'));
  const entry = manifest.rules.find((r) => r.id === 'review-engine');
  assert.ok(entry && entry.segment && entry.segment.length, 'review-engine segment pattern missing from manifest.json');
  return new RegExp(entry.segment[0]);
}

function ms(re, input) {
  const t0 = process.hrtime.bigint();
  re.test(input);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('C5 the pattern stays fast on a failing input with 40 quoted flag pairs and on 20,000-char adversarial strings', () => {
  const re = reviewEnginePattern();
  const bound = 1000;
  const pairs = ' --a "x"'.repeat(40);
  const inputs = {
    'before claim, 40 pairs then zzz': `node lane.mjs${pairs} zzz`,
    'after claim, 40 pairs then zzz': `node lane.mjs claim${pairs} zzz`,
    'after claim, 40 pairs then bad lane': `node lane.mjs claim${pairs} re`,
    '20k flag pairs': `node lane.mjs claim${' --a "x"'.repeat(2500)} zzz`,
    '20k bare flags': `node lane.mjs claim${' --a'.repeat(5000)} zzz`,
    '20k single-quoted pairs': `node lane.mjs${" --a 'x'".repeat(2500)} zzz`,
    '20k node flags': `node${' -a'.repeat(7000)} zzz`,
    '40 double-dash node flags then a non-lane script': `node${' --a'.repeat(40)} script.mjs`,
    '40 node flags with values': `node${' --no-warnings=1'.repeat(40)} script.mjs`,
    '20k quotes': `node ${'"'.repeat(20000)}`,
    '20k path chars': `node ${'a'.repeat(20000)}`,
    '20k spaces': `node lane.mjs${' '.repeat(20000)}x`,
  };
  for (const [name, input] of Object.entries(inputs)) {
    const took = ms(re, input);
    assert.ok(took < bound, `${name}: ${took.toFixed(1)} ms, bound ${bound} ms`);
  }
});

test('C5b the timing test would catch a backtracking pattern (control)', () => {
  const bad = /^node(\s+--a(\s+("[^"]*"|\S+))?)*\s+claim/;
  assert.ok(ms(bad, `node${' --a "x"'.repeat(26)} zzz`) > 20, 'control pattern is no longer slow; the bound proves nothing');
});
