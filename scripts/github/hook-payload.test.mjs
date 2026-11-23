// Tests for hook-payload.mjs (card coord-hook-payload-gate). Run: node --test scripts/github/hook-payload.test.mjs
// No network. Every hook here is a tiny fake written into a temp folder; the real hooks are not run. The live guard log is a temp file.
//
// How the gate can fail, and the test that catches it (written before the code):
//   a hook prints a shape the harness ignores ({"result":"block"}) and the gate passes it           -> HP1
//   a hook crashes (exit 1) or prints text that is not JSON, and the gate passes it                 -> HP2
//   a fixture names a hook with no dist file and the gate passes; a hook with no fixture fails      -> HP3
//   a row from a fixture run reaches the live guard log and the gate does not see it                -> HP4
//   a fixture env can turn the isolation off                                                       -> HP5
//   a changed hook, a shared file or a dist file selects the wrong fixtures                         -> HP6
//   a guard in REQUIRES_FIXTURE changes with no fixture and the gate passes                        -> HP7
//   a fixture holds a real session id, a user path, a secret or a Windows path                     -> HP8
//   an orphan fixture folder, or a bad fixture file, is not reported                                -> HP9
//   the payload goes by argv, or the session id is the fixture's own                               -> HP10
//   a wrong decision (allow for deny) passes                                                        -> HP11
//   the output is not saved, or the summary has no count and time                                   -> HP12
//   classifyOutput maps a shape to the wrong name                                                   -> HP13
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRES_FIXTURE, classifyOutput, planFixtures, validateFixture, loadFixtures, runFixture, runPayloadGate, liveLogHasRun, ISOLATION_KEYS,
} from './hook-payload.mjs';
import * as hp from './hook-payload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const GATE_DENY = `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'no'}}));`;
const GATE_ALLOW = `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`;

/** A temp repo root with fake hooks. hooks: { name: { dist: source|null, src: bool, fixtures: { case: fixtureObject } } } */
function makeRoot(hooks) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  for (const [name, h] of Object.entries(hooks)) {
    mkdirSync(path.join(root, '.claude', 'hooks', 'dist'), { recursive: true });
    mkdirSync(path.join(root, '.claude', 'hooks', 'src'), { recursive: true });
    if (h.dist != null) writeFileSync(path.join(root, '.claude', 'hooks', 'dist', `${name}.mjs`), h.dist);
    if (h.src !== false) writeFileSync(path.join(root, '.claude', 'hooks', 'src', `${name}.ts`), '// fake\n');
    for (const [c, fx] of Object.entries(h.fixtures ?? {})) {
      const dir = path.join(root, '.claude', 'hooks', 'fixtures', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${c}.json`), JSON.stringify(fx));
    }
  }
  return root;
}
const fx = (over = {}) => ({
  case: 'c1', event: 'PreToolUse',
  input: { session_id: 'fixture', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
  expect: { exit: [0], shape: 'gate', decision: 'deny' },
  ...over,
});
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test('HP1 a hook that prints the ignored shape fails a gate fixture', async () => {
  const root = makeRoot({ h1: { dist: `console.log(JSON.stringify({result:'block',message:'x'}));`, fixtures: { c1: fx() } } });
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/h1.ts'], runId: 'r1', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true);
    assert.match(r.lines.join('\n'), /h1\/c1.*shape/);
  } finally { cleanup(root); }
});

test('HP2 a crash and non-JSON output fail', async () => {
  const root = makeRoot({
    crash: { dist: `process.stderr.write('boom'); process.exit(1);`, fixtures: { c1: fx() } },
    text: { dist: `console.log('hello');`, fixtures: { c1: fx() } },
  });
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/crash.ts', '.claude/hooks/src/text.ts'], runId: 'r2', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true);
    const text = r.lines.join('\n');
    assert.match(text, /crash\/c1.*exit 1/);
    assert.match(text, /text\/c1.*(not JSON|shape)/);
  } finally { cleanup(root); }
});

test('HP3 a missing dist file fails; a hook with no fixtures is a note, not a failure', async () => {
  const root = makeRoot({
    nodist: { dist: null, fixtures: { c1: fx() } },
    nofix: { dist: GATE_ALLOW },
  });
  try {
    const bad = await runPayloadGate({ root, changed: ['.claude/hooks/src/nodist.ts'], runId: 'r3', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(bad.failed, true);
    assert.match(bad.lines.join('\n'), /nodist.*dist/);
    const ok = await runPayloadGate({ root, changed: ['.claude/hooks/src/nofix.ts'], runId: 'r3b', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(ok.failed, false);
    assert.match(ok.lines.join('\n'), /NOTE.*nofix.*no fixture/);
  } finally { cleanup(root); }
});

test('HP4 a row with this run id in the live log fails the gate; other rows do not', async () => {
  const live = (root) => path.join(root, 'live.jsonl');
  // The fake hook leaks to a path named in its own fixture env, like a hook that ignores the override.
  const leak = `import {appendFileSync} from 'node:fs'; let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s); appendFileSync(process.env.FAKE_LIVE_LOG, JSON.stringify({session_id:i.session_id})+'\\n'); ${GATE_DENY}});`;
  const root = makeRoot({ leaky: { dist: leak, fixtures: { c1: fx({ env: { FAKE_LIVE_LOG: '__LIVE__' } }) } } });
  try {
    // __LIVE__ in a fixture env value is replaced by the test's live log path (the runner supports this one token for the probe only).
    writeFileSync(live(root), JSON.stringify({ session_id: 'someone-else' }) + '\n');
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/leaky.ts'], runId: 'r4', liveLogPath: live(root) });
    assert.equal(r.failed, true);
    assert.match(r.lines.join('\n'), /live guard log.*fixture-r4/);
  } finally { cleanup(root); }
  const root2 = makeRoot({ clean: { dist: GATE_DENY, fixtures: { c1: fx() } } });
  try {
    writeFileSync(live(root2), JSON.stringify({ session_id: 'someone-else' }) + '\n');
    const r2 = await runPayloadGate({ root: root2, changed: ['.claude/hooks/src/clean.ts'], runId: 'r4b', liveLogPath: live(root2) });
    assert.equal(r2.failed, false, r2.lines.join('\n'));
  } finally { cleanup(root2); }
  assert.equal(liveLogHasRun(path.join(os.tmpdir(), 'hp-does-not-exist.jsonl'), 'x'), false);
});

test('HP5 a fixture env cannot set or clear an isolation key', () => {
  for (const key of ISOLATION_KEYS) {
    const problems = validateFixture(fx({ env: { [key]: 'x' } }), 'h/c1');
    assert.ok(problems.some((p) => p.includes(key)), `${key} was accepted`);
  }
  assert.ok(ISOLATION_KEYS.includes('CCV3_GUARD_DECISIONS_LOG'));
  assert.ok(ISOLATION_KEYS.includes('HOME') && ISOLATION_KEYS.includes('USERPROFILE'));
});

test('HP6 planFixtures: src, shared, dist and docs paths', () => {
  const fixtureHooks = ['a', 'b'];
  assert.deepEqual(planFixtures(['.claude/hooks/src/a.ts'], { fixtureHooks }).hooks, ['a']);
  assert.deepEqual(planFixtures(['.claude/hooks/dist/b.mjs'], { fixtureHooks }).hooks, ['b']);
  assert.deepEqual(planFixtures(['.claude/hooks/src/shared/output.ts'], { fixtureHooks }).hooks, ['a', 'b']);
  assert.deepEqual(planFixtures(['docs/x.md', 'scripts/github/pre-pr.mjs'], { fixtureHooks }).hooks, []);
  assert.deepEqual(planFixtures(['.claude/hooks/src/__tests__/a.test.ts'], { fixtureHooks }).hooks, []);
  assert.deepEqual(planFixtures(['.claude/hooks/fixtures/a/c1.json'], { fixtureHooks }).hooks, ['a']);
  assert.deepEqual(planFixtures(['.claude/hooks/src/a.ts', '.claude/hooks/dist/a.mjs'], { fixtureHooks }).hooks, ['a']);
});

test('HP7 a changed guard with no fixture fails; a changed hook outside the list does not', async () => {
  assert.deepEqual([...REQUIRES_FIXTURE].sort(), ['coderabbit-guard', 'decision-gate', 'destructive-command-guard', 'package-install-guard', 'pre-pr-gate']);
  const plan = planFixtures(['.claude/hooks/src/decision-gate.ts', '.claude/hooks/src/other.ts'], { fixtureHooks: [] });
  assert.deepEqual(plan.missing, ['decision-gate']);
  const root = makeRoot({ 'decision-gate': { dist: GATE_ALLOW } });
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/decision-gate.ts'], runId: 'r7', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true);
    assert.match(r.lines.join('\n'), /decision-gate.*requires a fixture/);
  } finally { cleanup(root); }
});

test('HP8 a scrubbed fixture passes; a real id, user path, drive path, backslash path or secret fails', () => {
  assert.deepEqual(validateFixture(fx(), 'h/c1'), []);
  const bad = [
    ['session id', { input: { session_id: '82ced24f-394d-41da-99e9-e6ff873e1448', tool_name: 'Bash' } }],
    ['user path', { input: { session_id: 'fixture', tool_name: 'Bash', tool_input: { command: 'cat /Users/someone/x' } } }],
    ['drive path', { input: { session_id: 'fixture', tool_name: 'Read', tool_input: { file_path: 'C:/work/x' } } }],
    ['backslash path', { input: { session_id: 'fixture', tool_name: 'Read', tool_input: { file_path: 'src\\x.ts' } } }],
    ['secret', { input: { session_id: 'fixture', tool_name: 'Bash', tool_input: { command: 'echo ghp_' + 'a'.repeat(36) } } }],
  ];
  for (const [name, over] of bad) {
    const problems = validateFixture(fx(over), 'h/c1');
    assert.ok(problems.length > 0, `${name} was accepted`);
  }
});

test('HP9 an orphan fixture folder and a bad fixture file are reported', () => {
  const root = makeRoot({
    orphan: { dist: GATE_ALLOW, src: false, fixtures: { c1: fx() } },
    badshape: { dist: GATE_ALLOW, fixtures: { c1: fx({ expect: { exit: [0], shape: 'nope' } }) } },
  });
  try {
    const { problems } = loadFixtures(root, ['orphan', 'badshape']);
    const text = problems.join('\n');
    assert.match(text, /orphan.*no source/);
    assert.match(text, /badshape\/c1.*shape/);
  } finally { cleanup(root); }
});

test('HP10 the payload goes on stdin, not argv; the session id is unique per run', async () => {
  const probe = `let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s); console.log(JSON.stringify({result:'continue',argc:process.argv.length,sid:i.session_id}));});`;
  const root = makeRoot({ p: { dist: probe, fixtures: { c1: fx({ expect: { exit: [0], shape: 'continue' } }) } } });
  try {
    const { fixtures } = loadFixtures(root, ['p']);
    const r = await runFixture({ root, ...fixtures[0], runId: 'abc' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.argc, 2);
    assert.equal(out.sid, 'fixture-abc');
    const r2 = await runFixture({ root, ...fixtures[0], runId: 'abd' });
    assert.equal(JSON.parse(r2.stdout).sid, 'fixture-abd');
  } finally { cleanup(root); }
});

test('HP11 a wrong decision fails', async () => {
  const root = makeRoot({ allowing: { dist: GATE_ALLOW, fixtures: { c1: fx() } } });
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/allowing.ts'], runId: 'r11', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true);
    assert.match(r.lines.join('\n'), /allowing\/c1.*decision.*allow.*deny/);
  } finally { cleanup(root); }
});

test('HP12 the output is saved and the summary names the count and the time', async () => {
  const root = makeRoot({ good: { dist: GATE_DENY, fixtures: { c1: fx(), c2: fx({ case: 'c2' }) } } });
  const save = path.join(root, 'saved');
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/good.ts'], runId: 'r12', liveLogPath: path.join(root, 'live.jsonl'), saveDir: save, today: '2026-11-22' });
    assert.equal(r.failed, false, r.lines.join('\n'));
    assert.ok(existsSync(path.join(save, '2026-11-22-hook-payload-good-c1.json')));
    assert.deepEqual(readdirSync(save).sort(), ['2026-11-22-hook-payload-good-c1.json', '2026-11-22-hook-payload-good-c2.json']);
    assert.match(r.summary, /^hook-payload: 2 fixtures run for 1 hooks in \d+ ms$/);
    assert.match(readFileSync(path.join(save, '2026-11-22-hook-payload-good-c1.json'), 'utf8'), /permissionDecision/);
  } finally { cleanup(root); }
});

test('HP13 classifyOutput names the four shapes', () => {
  assert.equal(classifyOutput(''), 'empty');
  assert.equal(classifyOutput('{}'), 'empty');
  assert.equal(classifyOutput('{"result":"continue"}'), 'continue');
  assert.equal(classifyOutput('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"x"}}'), 'inject');
  assert.equal(classifyOutput('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}'), 'gate');
  assert.equal(classifyOutput('{"result":"block","message":"x"}'), 'other');
  assert.equal(classifyOutput('hello'), 'other');
});

test('HP15 the hook runs in a throwaway git repo with a fork remote, never in the checkout', async () => {
  // decision-gate printed "git remote -v failed (exit 128)" in a plain temp folder, so its deny rule was never judged.
  const probe = `import {execFileSync} from 'node:child_process'; import {readFileSync} from 'node:fs'; let r=''; try { r=execFileSync('git',['remote','-v'],{encoding:'utf8'}); } catch (e) { r='ERR'; }
    let cfg=null; try { cfg=JSON.parse(readFileSync('review-router.config.json','utf8')); } catch {}
    console.log(JSON.stringify({result:'continue',remotes:r,cwd:process.cwd(),cfg}));`;
  const root = makeRoot({ g: { dist: probe, fixtures: { c1: fx({ expect: { exit: [0], shape: 'continue' } }) } } });
  try {
    const { fixtures } = loadFixtures(root, ['g']);
    const r = await runFixture({ root, ...fixtures[0], runId: 'git1' });
    const out = JSON.parse(r.stdout);
    assert.match(out.remotes, /^fork\s+https:\/\/github\.com\/.+\(fetch\)/m);
    assert.notEqual(path.resolve(out.cwd), path.resolve(root));
    assert.ok(!path.resolve(out.cwd).startsWith(path.resolve(REPO)));
    // Guards read decisions.enforce from review-router.config.json: without it decision-gate only warns and a deny is never judged.
    assert.equal(out.cfg?.decisions?.enforce, true);
    assert.equal(out.cfg?.decisions?.enforcePush, true);
  } finally { cleanup(root); }
});

// CLI review of 7eb137dc (seat ruling 07:3x): items 2, 3 and 4.
test('HP16 a guard whose fixture folder holds no fixture file fails by name; a folder alone is not coverage', async () => {
  const root = makeRoot({ 'decision-gate': { dist: GATE_ALLOW } });
  try {
    const dir = path.join(root, '.claude', 'hooks', 'fixtures', 'decision-gate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), 'notes only\n');
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/decision-gate.ts'], runId: 'r16', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true);
    assert.match(r.lines.join('\n'), /decision-gate.*no fixture file/);
    // A hook outside the list with an empty folder is not an error: only the five guards must have fixtures.
    const other = makeRoot({ other: { dist: GATE_ALLOW } });
    try {
      mkdirSync(path.join(other, '.claude', 'hooks', 'fixtures', 'other'), { recursive: true });
      const ok = await runPayloadGate({ root: other, changed: ['.claude/hooks/src/other.ts'], runId: 'r16b', liveLogPath: path.join(other, 'live.jsonl') });
      assert.equal(ok.failed, false);
    } finally { cleanup(other); }
  } finally { cleanup(root); }
});

test('HP17 a staged-only change is a changed file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hp-git-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-q');
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git('add', 'base.txt');
    git('commit', '-q', '-m', 'base');
    mkdirSync(path.join(root, '.claude', 'hooks', 'src'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'hooks', 'src', 'new-guard.ts'), '// new\n');
    git('add', '.claude/hooks/src/new-guard.ts'); // staged: not in the committed diff, the unstaged diff or the untracked list
    assert.ok(hp.changedFromGit(root, 'HEAD').includes('.claude/hooks/src/new-guard.ts'));
  } finally { cleanup(root); }
});

test('HP18 an output with no hookEventName is not a gate or an inject result', async () => {
  assert.equal(classifyOutput('{"hookSpecificOutput":{"permissionDecision":"deny"}}'), 'other');
  assert.equal(classifyOutput('{"hookSpecificOutput":{"hookEventName":"","permissionDecision":"deny"}}'), 'other');
  assert.equal(classifyOutput('{"hookSpecificOutput":{"additionalContext":"x"}}'), 'other');
  const root = makeRoot({ ignored: { dist: `console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}}));`, fixtures: { c1: fx() } } });
  try {
    const r = await runPayloadGate({ root, changed: ['.claude/hooks/src/ignored.ts'], runId: 'r18', liveLogPath: path.join(root, 'live.jsonl') });
    assert.equal(r.failed, true, 'Claude Code ignores this output, so a fixture that expects deny must not pass');
  } finally { cleanup(root); }
});

test('HP19 the package-install fixtures run the package manager their name says', () => {
  const dir = path.join(REPO, '.claude', 'hooks', 'fixtures', 'package-install-guard');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const named = file.match(/^deny-(npm|pip)-/);
    if (!named) continue;
    const command = JSON.parse(readFileSync(path.join(dir, file), 'utf8')).input.tool_input.command;
    assert.ok(command.startsWith(`${named[1]} `), `${file} runs "${command}"`);
  }
});

test('HP14 every saved fixture in this repo is valid and names a source file', () => {
  const dir = path.join(REPO, '.claude', 'hooks', 'fixtures');
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const { problems } = loadFixtures(REPO, names);
  assert.deepEqual(problems, []);
});
