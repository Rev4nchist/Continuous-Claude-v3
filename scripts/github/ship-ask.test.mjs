// Tests for ship-ask.mjs: the AskUserQuestion spec of each ship step, and the offer it writes.
// Run: node --test scripts/github/ship-ask.test.mjs
// The CLI tests run the real script. --facts replaces git, gh and the ledger; CCV3_DECISIONS_FILE moves the store to a temp folder.
// --facts and SHIP_ASK_STATUS_SCRIPT are test seams: the script honours them only when SHIP_ASK_TEST=1. run() sets it unless told not to.
//
// How the unit can fail, and the test that catches it:
//   a spec breaks the AskUserQuestion limits (header over 12, question over 3 lines, 2 to 4 options, recommended first)   -> SA1
//   the paid-round question puts a paid pick first, or hides the cost or the caps, or drops the escalation reasons       -> SA2
//   land offers "Land now" for a PR that is not READY, or asks about a draft                                              -> SA3
//   open-pr offers "Open draft PR" with no stamp, a failed row or a moved head                                            -> SA4
//   commit-and-push recommends a commit when nothing is staged                                                            -> SA5
//   the CLI prints a spec but writes no offer (the hook could never record the tap), or writes one for bad usage          -> SA6
//   the offer is bound to another key or head than the spec names                                                         -> SA6
//   a text tells Dave to type a command ('/pathway <', '/slot pay')                                                       -> SA7
//   the real git path (staged count, branch, message subject) reads wrong                                                 -> SA8
//   land with a fake review-status runs the real gather path, and a draft or closed PR writes no offer                    -> SA9
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REPO } from './review-router.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ship-ask.mjs');
const load = () => import(pathToFileURL(SCRIPT).href);
const loadStore = () => import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);
const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const temp = (prefix) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

const SHIP = { branch: 'feat/x', head: HEAD, tree: 't', staged: 6, ahead: 2, subject: 'fix(pathway): drop stale labels' };
const OPEN = { branch: 'feat/x', head: HEAD, stampHead: HEAD, stampAt: '2026-11-06T10:00:00Z', now: '2026-11-06T10:17:00Z', rows: 9, fails: 0, cliDetail: '0 finding(s), advisory only.', costUsd: 0, capLeftUsd: 3 };
const LAND = { pr: 349, head: HEAD, ready: true, reasons: [], mergeable: 'clean', unresolved: 0, pathway: 'none', by: 'dave' };
const PAID = { pr: 349, head: HEAD, round: 1, files: 17, today: 0, paidRounds: 0, verdict: 'ALLOW', reasons: [], caps: { round: 5, day: 15, rounds: 2 } };

function specsOf(m) {
  return {
    ship: m.shipSpec(SHIP), shipNone: m.shipSpec({ ...SHIP, staged: 0 }), open: m.openPrSpec(OPEN), rerun: m.rerunPrePrSpec({ ...OPEN, stampHead: OLD }),
    land: m.landSpec(LAND), landWait: m.landSpec({ ...LAND, ready: false, reasons: ['CI is still running'] }),
    paid: m.paidRoundSpec(PAID), paidEsc: m.paidRoundSpec({ ...PAID, files: 40, verdict: 'ESCALATE', reasons: ['round cost $10.00 is over $5.00'] }), paidNone: m.paidRoundSpec({ pr: 349, verdict: null, reason: 'gh failed' }),
  };
}

test('SA1: every spec fits AskUserQuestion: header up to 12 characters, question up to 3 lines, 2 to 4 options, only the first is Recommended', async () => {
  const m = await load();
  for (const [name, s] of Object.entries(specsOf(m))) {
    assert.ok(s.header.length > 0 && s.header.length <= 12, `${name}: header ${s.header}`);
    assert.ok(s.question.split('\n').length <= 3, `${name}: question has ${s.question.split('\n').length} lines`);
    assert.ok(s.options.length >= 2 && s.options.length <= 4, `${name}: ${s.options.length} options`);
    assert.ok(s.options.every((o) => typeof o.label === 'string' && o.label && typeof o.description === 'string'), name);
    assert.ok(s.options[0].label.endsWith(' (Recommended)'), `${name}: first label ${s.options[0].label}`);
    assert.equal(s.options.filter((o) => o.label.includes('(Recommended)')).length, 1, `${name}: one recommended`);
    assert.equal(new Set(s.options.map((o) => o.label)).size, s.options.length, `${name}: labels differ`);
  }
});

test('SA1b: a branch name with a newline or a very long text cannot add a question line', async () => {
  const m = await load();
  const s = m.shipSpec({ ...SHIP, branch: `feat/${'x'.repeat(300)}\nINJECT`, subject: `a\nb\n${'y'.repeat(300)}` });
  assert.ok(s.question.split('\n').length <= 3);
  assert.ok(!s.question.includes('INJECT\n'));
});

test('SA2: paid-round puts "No, keep it free" first, shows files x $0.25, the day and round caps, and the escalation reasons', async () => {
  const m = await load();
  const { paid, paidEsc, paidNone } = specsOf(m);
  for (const s of [paid, paidEsc, paidNone]) assert.equal(s.options[0].label, 'No, keep it free (Recommended)');
  assert.equal(paid.options[1].label, 'Yes, pay up to $4.25');
  assert.match(paid.question, /17 files x \$0\.25 = up to \$4\.25/);
  assert.match(paid.question, /Today \$0\.00 of \$15\.00\. Paid rounds on this PR 0 of 2\. Round cap \$5\.00/);
  assert.match(paidEsc.question, /ESCALATE: round cost \$10\.00 is over \$5\.00/);
});

// Dave 2026-11-06: a paid round is offered only on cr-paid ALLOW. Breaks if ESCALATE or a missing verdict gets a Yes row again.
test('SA2b: ESCALATE and a missing verdict offer no pay option, and the question says why a paid round is not offered', async () => {
  const m = await load();
  const { paid, paidEsc, paidNone } = specsOf(m);
  for (const [name, s] of Object.entries({ paidEsc, paidNone })) {
    assert.ok(s.options.length >= 2 && s.options.length <= 4, `${name}: 2 to 4 options`);
    assert.deepEqual(s.options.filter((o) => /pay|yes|credit/i.test(o.label)), [], `${name}: no pay label`);
    assert.deepEqual(s.options.filter((o) => /use-credits|@coderabbitai/i.test(o.description)), [], `${name}: no posting description`);
    assert.match(s.question, /No paid round is offered/, `${name}: question states the rule`);
  }
  assert.match(paidEsc.question, /over the cap/);
  assert.match(paidNone.question, /no verdict/);
  assert.doesNotMatch(paid.question, /No paid round is offered/);
  assert.equal(paid.options.length, 2);
  assert.match(paid.options[1].label, /^Yes, pay/);
});

test('SA3: land says "Land now" only when READY; a draft or a closed PR gets no question', async () => {
  const m = await load();
  const { land, landWait } = specsOf(m);
  assert.equal(land.options[0].label, 'Land now (Recommended)');
  assert.equal(landWait.options[0].label, 'Land when READY (Recommended)');
  assert.match(landWait.question, /NOT READY/);
  assert.match(landWait.question, /Not ready: CI is still running/);
  assert.match(land.question, /review none, recorded by dave/);
  assert.deepEqual(land.options.map((o) => o.label).slice(1), ['Keep open', 'Return to draft']);
  assert.match(m.planOf('land', { ...LAND, isDraft: true }, { pr: 349 }).refuse, /draft/);
  assert.match(m.planOf('land', { ...LAND, prState: 'closed' }, { pr: 349 }).refuse, /closed/);
});

test('SA4: open-pr offers the draft PR only for a clean stamp at this head', async () => {
  const m = await load();
  const ok = m.planOf('open-pr', OPEN, {});
  assert.equal(ok.spec.options[0].label, 'Open draft PR (Recommended)');
  assert.match(ok.spec.question, /pre-pr passed at ccccccc, 17 min ago \(9 rows checked, 0 failed\)/);
  assert.match(ok.spec.question, /pre-pr cost \$0\.00/);
  for (const [name, over] of [['no stamp', { stampHead: null }], ['moved head', { stampHead: OLD }], ['failed row', { fails: 1 }]]) {
    const p = m.planOf('open-pr', { ...OPEN, ...over }, {});
    assert.ok(!p.spec.options.some((o) => o.label.startsWith('Open draft PR')), name);
    assert.match(p.spec.options[0].label, /^Re-run pre-pr \(up to \$3\.00 CLI\) \(Recommended\)$/, name);
    assert.equal(p.key, `${DEFAULT_REPO}@feat/x`);
  }
});

test('SA4b: open-pr shows the Change sentence in place of the CLI cost line, in 3 lines; with no Change the CLI line stays', async () => {
  const m = await load();
  const change = 'Pre-pr now reads a plain summary of the PR and prints it before any gate runs.';
  const withChange = m.openPrSpec({ ...OPEN, change });
  const lines = withChange.question.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `Change: ${change}`);
  assert.doesNotMatch(withChange.question, /pre-pr cost|CLI:/);
  assert.match(lines[2], /Open a draft PR for feat\/x on fork\?/);
  const long = m.openPrSpec({ ...OPEN, change: 'word '.repeat(80) }).question.split('\n');
  assert.equal(long.length, 3);
  assert.ok(long[1].length <= 160, String(long[1].length));
  assert.match(m.openPrSpec({ ...OPEN, change: null }).question, /CLI: 0 finding\(s\), advisory only\. pre-pr cost \$0\.00\./);
});

test('SA4c: the real open-pr path reads the Change line of .claude/cache/pre-pr/summary.md only when its hash is the stamp summary_sha256', async () => {
  const repo = temp('shipask-summary-');
  const gitIn = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  gitIn('init', '-q', '-b', 'feat/real');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  gitIn('add', 'a.txt');
  gitIn('commit', '-q', '-m', 'one');
  const head = gitIn('rev-parse', 'HEAD').stdout.trim();
  const dir = path.join(repo, '.claude', 'cache', 'pre-pr');
  mkdirSync(dir, { recursive: true });
  const summary = 'Branch: feat/real\r\nChange: Adds the plain summary step to pre-pr.\r\nRisk: Low\r\n';
  writeFileSync(path.join(dir, 'summary.md'), summary);
  const { hashOf } = await import(pathToFileURL(path.join(HERE, 'lib', 'pr-summary.mjs')).href);
  const stamp = (sha, summaryStatus = 'PASS', summaryOk) => writeFileSync(path.join(dir, 'stamp.json'), JSON.stringify({ head, at: new Date().toISOString(), summary_sha256: sha, ...(summaryOk === undefined ? {} : { summary_ok: summaryOk }), results: [{ step: 'summary', status: summaryStatus, detail: 'x' }, { step: 'coderabbit', status: 'PASS', detail: '0 finding(s), advisory only.' }] }));
  stamp(hashOf(summary));
  const ok = run(['open-pr', '--branch', 'feat/real', '--json'], { cwd: repo });
  assert.equal(ok.status, 0, ok.stderr);
  const q = JSON.parse(ok.stdout).question;
  assert.match(q, /\nChange: Adds the plain summary step to pre-pr\.\n/);
  assert.doesNotMatch(q, /pre-pr cost/);
  stamp(hashOf(summary), 'NOTE', true);
  const older = JSON.parse(run(['open-pr', '--branch', 'feat/real', '--json'], { cwd: repo }).stdout).question;
  assert.match(older, /\nChange: Adds the plain summary step to pre-pr\.\n/, 'a NOTE with no real problem (an older Head, a long sentence) still shows the Change');
  stamp(hashOf(summary), 'NOTE', false);
  const noted = JSON.parse(run(['open-pr', '--branch', 'feat/real', '--json'], { cwd: repo }).stdout).question;
  assert.doesNotMatch(noted, /Change:/, 'a NOTE that hides a real problem (a leftover file from another branch) shows no Change');
  assert.match(noted, /pre-pr cost/);
  stamp(hashOf(summary), 'NOTE');
  const unmarked = JSON.parse(run(['open-pr', '--branch', 'feat/real', '--json'], { cwd: repo }).stdout).question;
  assert.doesNotMatch(unmarked, /Change:/, 'a NOTE row in a stamp with no summary_ok shows no Change');
  stamp(hashOf('another text\n'));
  const stale = JSON.parse(run(['open-pr', '--branch', 'feat/real', '--json'], { cwd: repo }).stdout).question;
  assert.doesNotMatch(stale, /Change:/);
  assert.match(stale, /pre-pr cost/);
});

test('SA5: commit-and-push recommends the commit only when files are staged', async () => {
  const m = await load();
  const { ship, shipNone } = specsOf(m);
  assert.equal(ship.options[0].label, 'Commit and push (Recommended)');
  assert.match(ship.question, /Commit 6 files on feat\/x and push to fork\?\nMessage: 'fix\(pathway\): drop stale labels'\.\n2 commits ahead of fork\/main\./);
  assert.ok(!shipNone.options.some((o) => o.label.startsWith('Commit and push')));
  assert.equal(shipNone.options[0].label, 'Stop here (Recommended)');
});

function run(args, { facts, store, cwd, env = {}, seams = true } = {}) {
  const dir = temp('shipask-');
  const factsFile = facts ? path.join(dir, 'facts.json') : null;
  if (facts) writeFileSync(factsFile, JSON.stringify(facts));
  const storeFile = store ?? path.join(dir, 'decisions.json');
  const full = { ...process.env, CCV3_DECISIONS_FILE: storeFile, ...env };
  if (seams) full.SHIP_ASK_TEST = '1'; else delete full.SHIP_ASK_TEST;
  const r = spawnSync(process.execPath, [SCRIPT, ...args, ...(factsFile ? ['--facts', factsFile] : [])], { cwd: cwd ?? dir, encoding: 'utf8', env: full });
  return { ...r, storeFile };
}

test('SA6: the CLI prints the spec and writes the offer for the step, key and head, so the hook can record the tap', async () => {
  const d = await loadStore();
  for (const [args, facts, step, key, head] of [
    [['land', '--pr', '349', '--json'], LAND, 'land', `${DEFAULT_REPO}#349`, HEAD],
    [['paid-round', '--pr', '349', '--json'], PAID, 'paid-round', `${DEFAULT_REPO}#349`, HEAD],
    [['open-pr', '--branch', 'feat/x', '--json'], OPEN, 'open-pr', `${DEFAULT_REPO}@feat/x`, HEAD],
    [['commit-and-push', '--branch', 'feat/x', '--json'], SHIP, 'ship', `${DEFAULT_REPO}@feat/x`, HEAD],
  ]) {
    const r = run(args, { facts });
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    const spec = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(spec), ['header', 'question', 'options']);
    process.env.CCV3_DECISIONS_FILE = r.storeFile;
    const offer = d.offerRead({ step, key, head });
    assert.ok(offer, `${args[0]}: an offer exists for ${step} ${key}`);
    assert.deepEqual(offer.labels, spec.options.map((o) => o.label));
    assert.equal(d.decisionRecord({ step, key, head, label: spec.options[0].label }).ok, true, `${args[0]}: the first label records`);
    assert.equal(d.decisionRead({ step, key, head: OLD }), null, 'bound to the head');
  }
});

test('SA6b: bad usage exits 2 and writes no offer; a step with no question exits 1 and writes none', async () => {
  const d = await loadStore();
  for (const args of [[], ['push'], ['land'], ['land', '--pr', 'x'], ['land', '--pr', '0'], ['open-pr', '--pr', '5'], ['land', '--pr', '5', '--msg', 'f'], ['land', '--pr', '5', '--bogus', '1']]) {
    const r = run(args, { facts: LAND });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    process.env.CCV3_DECISIONS_FILE = r.storeFile;
    assert.deepEqual(d.offerList(), []);
  }
  const draft = run(['land', '--pr', '349', '--json'], { facts: { ...LAND, isDraft: true } });
  assert.equal(draft.status, 1);
  assert.equal(draft.stdout, '', 'no spec is printed when no offer is written');
  process.env.CCV3_DECISIONS_FILE = draft.storeFile;
  assert.deepEqual(d.offerList(), []);
});

test('SA6c: without --json the CLI prints readable text, still with the offer written', async () => {
  const r = run(['land', '--pr', '349'], { facts: LAND });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Land: PR #349 is READY/);
  assert.match(r.stdout, /1\. Land now \(Recommended\) - /);
});

test('SA7: no text tells Dave to type or paste a command', async () => {
  const m = await load();
  const all = JSON.stringify(Object.values(specsOf(m)));
  assert.doesNotMatch(all, /\/pathway </);
  assert.doesNotMatch(all, /\/slot pay/);
  assert.doesNotMatch(all, /run \/pathway/i);
  assert.doesNotMatch(all, /\btype\b/i);
});

test('SA8: the real git path reads the staged count, the branch, the message subject and the head', async () => {
  const repo = temp('shipask-git-');
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'feat/real');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  writeFileSync(path.join(repo, 'b.txt'), '2\n');
  writeFileSync(path.join(repo, 'c.txt'), '3\n');
  git('add', 'b.txt', 'c.txt');
  const msg = path.join(repo, 'msg.txt');
  writeFileSync(msg, 'feat(x): real subject\n\nbody\n');
  const r = run(['commit-and-push', '--msg', msg, '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const spec = JSON.parse(r.stdout);
  assert.match(spec.question, /^Commit 2 files on feat\/real and push to fork\?\nMessage: 'feat\(x\): real subject'\.\nCommits ahead of fork\/main: unknown\./);
  const d = await loadStore();
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  const head = git('rev-parse', 'HEAD').stdout.trim();
  assert.equal(d.offerRead({ step: 'ship', key: `${DEFAULT_REPO}@feat/real`, head }).head, head);
});

test('SA8b: --branch B reads the head and the tree of branch B, not of the checked-out branch; a missing branch writes no offer', async () => {
  const repo = temp('shipask-branch-');
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'feat/other');
  writeFileSync(path.join(repo, 'b.txt'), '2\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'two');
  const otherHead = git('rev-parse', 'refs/heads/feat/other').stdout.trim();
  const otherTree = git('rev-parse', 'refs/heads/feat/other^{tree}').stdout.trim();
  git('checkout', '-q', 'main');
  const mainHead = git('rev-parse', 'HEAD').stdout.trim();
  assert.notEqual(otherHead, mainHead);
  const d = await loadStore();
  const r = run(['commit-and-push', '--branch', 'feat/other', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  const key = `${DEFAULT_REPO}@feat/other`;
  const offer = d.offerRead({ step: 'ship', key, head: otherHead });
  assert.ok(offer, 'the offer is bound to the head of feat/other');
  assert.equal(offer.tree, otherTree, 'the tree is the tree of feat/other');
  assert.equal(d.offerRead({ step: 'ship', key, head: mainHead }), null, 'not bound to the checked-out head');
  // open-pr reads the same ref (its stamp does not exist here, so the re-run spec is offered at the branch head).
  const o = run(['open-pr', '--branch', 'feat/other', '--json'], { cwd: repo });
  assert.equal(o.status, 0, o.stderr);
  process.env.CCV3_DECISIONS_FILE = o.storeFile;
  assert.ok(d.offerRead({ step: 'open-pr', key, head: otherHead }), 'open-pr: bound to the head of feat/other');
  // A branch that does not exist: exit 1, the reason on stderr, no offer.
  const none = run(['commit-and-push', '--branch', 'feat/nope', '--json'], { cwd: repo });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /feat\/nope/);
  assert.equal(none.stdout, '');
  process.env.CCV3_DECISIONS_FILE = none.storeFile;
  assert.deepEqual(d.offerList(), []);
});

function fakeStatus(dir, body) {
  const file = path.join(dir, 'fake-status.mjs');
  writeFileSync(file, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});`);
  return file;
}

test('SA9: land runs review-status.mjs for the PR, reads READY and the recorded pathway, and a draft writes no offer', async () => {
  const repo = temp('shipask-land-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  mkdirSync(path.join(repo, '.claude', 'cache', 'pre-pr'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'cache', 'pre-pr', 'pathway.json'), JSON.stringify({ head: HEAD, pathway: 'coderabbit', decided_by: 'dave' }));
  const status = { pr: 349, head: HEAD, ready: true, reasons: [], mergeable_state: 'clean', unresolved: 0, isDraft: false, prState: 'open', labels: [{ name: 'review:coderabbit' }] };
  const ok = run(['land', '--pr', '349', '--json'], { cwd: repo, env: { SHIP_ASK_STATUS_SCRIPT: fakeStatus(repo, status) } });
  assert.equal(ok.status, 0, ok.stderr);
  const spec = JSON.parse(ok.stdout);
  assert.equal(spec.options[0].label, 'Land now (Recommended)');
  assert.match(spec.question, /review coderabbit, recorded by dave/);
  const stale = run(['land', '--pr', '349', '--json'], { cwd: repo, env: { SHIP_ASK_STATUS_SCRIPT: fakeStatus(repo, { ...status, head: OLD, ready: false, reasons: ['no review'] }) } });
  assert.match(JSON.parse(stale.stdout).question, /Review: review coderabbit\.\n|Review: review coderabbit\./, 'a record for another head is not used, the label is');
  assert.doesNotMatch(JSON.parse(stale.stdout).question, /recorded by/);
  const draft = run(['land', '--pr', '349', '--json'], { cwd: repo, env: { SHIP_ASK_STATUS_SCRIPT: fakeStatus(repo, { ...status, isDraft: true }) } });
  assert.equal(draft.status, 1);
});

test('SA11: without SHIP_ASK_TEST=1, --facts is ignored with one stderr warning and the real path runs (breaks if the gate is removed)', async () => {
  const repo = temp('shipask-noseam-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // With the seam on, the facts answer and the branch need not exist. With it off, the real path finds no feat/nope.
  const on = run(['commit-and-push', '--branch', 'feat/nope', '--json'], { cwd: repo, facts: SHIP });
  assert.equal(on.status, 0, on.stderr);
  const off = run(['commit-and-push', '--branch', 'feat/nope', '--json'], { cwd: repo, facts: SHIP, seams: false });
  assert.equal(off.status, 1, off.stderr);
  assert.match(off.stderr, /feat\/nope/);
  assert.equal(off.stdout, '');
  const warns = off.stderr.split('\n').filter((l) => /--facts/.test(l) && /SHIP_ASK_TEST/.test(l));
  assert.equal(warns.length, 1, off.stderr);
  const d = await loadStore();
  const saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = off.storeFile;
  try {
    assert.deepEqual(d.offerList(), [], 'no offer is written from ignored facts');
  } finally {
    if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  }
});

test('SA12: statusScriptOf honours SHIP_ASK_STATUS_SCRIPT only in test mode (breaks if the gate is removed)', async () => {
  const m = await load();
  const real = m.statusScriptOf({});
  assert.match(real, /review-status\.mjs$/);
  assert.equal(m.statusScriptOf({ SHIP_ASK_STATUS_SCRIPT: 'C:/x/fake.mjs', SHIP_ASK_TEST: '1', CCV3_DECISIONS_FILE: path.join(os.tmpdir(), 'x-decisions.json') }), 'C:/x/fake.mjs');
  assert.equal(m.statusScriptOf({ SHIP_ASK_STATUS_SCRIPT: 'C:/x/fake.mjs' }), real);
  assert.equal(m.statusScriptOf({ SHIP_ASK_STATUS_SCRIPT: 'C:/x/fake.mjs', SHIP_ASK_TEST: '0' }), real);
});

test('SA13: SHIP_ASK_TEST=1 alone, with no temp CCV3_DECISIONS_FILE or the real default store, leaves the seams off (breaks if the store check is removed)', async () => {
  const m = await load();
  const d = await loadStore();
  const real = m.statusScriptOf({});
  const fake = { SHIP_ASK_STATUS_SCRIPT: 'C:/x/fake.mjs', SHIP_ASK_TEST: '1' };
  assert.equal(m.statusScriptOf(fake), real, 'no CCV3_DECISIONS_FILE');
  assert.equal(m.statusScriptOf({ ...fake, CCV3_DECISIONS_FILE: '' }), real, 'empty CCV3_DECISIONS_FILE');
  assert.equal(m.statusScriptOf({ ...fake, CCV3_DECISIONS_FILE: d.decisionsPath({}) }), real, 'the default real store path');
  // The CLI: facts are ignored, the real path runs, and it writes no offer to the real store.
  const repo = temp('shipask-nostore-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const facts = path.join(repo, 'facts.json');
  writeFileSync(facts, JSON.stringify(SHIP));
  const env = { ...process.env, SHIP_ASK_TEST: '1' };
  delete env.CCV3_DECISIONS_FILE;
  const r = spawnSync(process.execPath, [SCRIPT, 'commit-and-push', '--branch', 'feat/nope', '--json', '--facts', facts], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n').filter((l) => /--facts/.test(l) && /SHIP_ASK_TEST/.test(l)).length, 1, r.stderr);
});

test('SA10: the store key of a PR is the same repo string the engine uses', async () => {
  const d = await loadStore();
  assert.equal(d.decisionKey({ pr: 1 }), `${DEFAULT_REPO}#1`);
  assert.equal(d.decisionKey({ branch: 'b' }), `${DEFAULT_REPO}@b`);
});
