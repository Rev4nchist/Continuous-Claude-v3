// Tests for ship-ask.mjs: the AskUserQuestion spec of each ship step, and the offer it writes.
// Run: node --test scripts/github/ship-ask.test.mjs
// The CLI tests run the real script. --facts replaces git, gh and the ledger; CCV3_DECISIONS_FILE moves the store to a temp folder.
// --facts and SHIP_ASK_STATUS_SCRIPT are test seams: the script honours them only when SHIP_ASK_TEST=1. run() sets it unless told not to.
//
// How the unit can fail, and the test that catches it:
//   a spec breaks the AskUserQuestion limits (header over 12, question over 3 lines (land: 5), 2 to 4 options, recommended first) -> SA1
//   the paid-round question puts a paid pick first, or hides the cost or the caps, or drops the escalation reasons       -> SA2
//   land offers "Land now" for a PR that is not READY, or asks about a draft                                              -> SA3
//   open-pr offers "Open draft PR" with no stamp, a failed row or a moved head                                            -> SA4
//   commit-and-push recommends a commit when nothing is staged                                                            -> SA5
//   Push only is offered with files staged, with nothing ahead, or with no HEAD tree, or its offer binds the index tree           -> SA5b, SA5c, SA6d, SA8c
//   the CLI prints a spec but writes no offer (the hook could never record the tap), or writes one for bad usage          -> SA6
//   the offer is bound to another key or head than the spec names                                                         -> SA6
//   a text tells Dave to type a command ('/pathway <', '/slot pay')                                                       -> SA7
//   the real git path (staged count, branch, message subject) reads wrong                                                 -> SA8
//   land with a fake review-status runs the real gather path, and a draft or closed PR writes no offer                    -> SA9
//   the Land question does not start with Why, What it does, You will see, or drops the State line or changes a label     -> SA14
//   no summary: the question has no defined line                                                                           -> SA14
//   a summary field adds a line, or holds an option label, READY, NOT READY or State: and still shows (seat L1)            -> SA15
//   a refused field vanishes with no sign, or a common word (ready, readying) is refused                                   -> SA15
//   the merge of main came from fork/main and the local main is behind: the description is lost                            -> SA16c
//   a fix commit that reached the local main only is hidden by it, and an old description shows                            -> SA16d
//   a field hides READY, NOT READY or state: behind an invisible character, punctuation or full-width letters             -> SA15b
//   a control or separator character adds a line; a cut leaves half a character                                            -> SA15b
//   an option description changes without notice                                                                           -> SA14b
//   the summary of another branch, a changed file, a failed summary row, or a fix commit after pre-pr still shows         -> SA16
//   a merge of main after pre-pr, or a stamp that is only in another worktree, hides the description                       -> SA16, SA16b
//   a broken stamp or a git failure stops the question (seat L1c)                                                          -> SA16
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const PUSH_FACTS = { ...SHIP, staged: 0, ahead: 2, head: 'abc1234def', headTree: 'ht' };
const OPEN = { branch: 'feat/x', head: HEAD, stampHead: HEAD, stampAt: '2026-11-06T10:00:00Z', now: '2026-11-06T10:17:00Z', rows: 9, fails: 0, cliDetail: '0 finding(s), advisory only.', costUsd: 0, capLeftUsd: 3 };
const LAND = { pr: 349, head: HEAD, ready: true, reasons: [], mergeable: 'clean', unresolved: 0, pathway: 'none', by: 'dave' };
const SUM = { problem: 'Dave cannot see what a pull request does before he lands it.', change: 'The Land question now starts with a plain description.', youWillSee: 'Three plain lines above the state line.' };
const PAID = { pr: 349, head: HEAD, round: 1, files: 17, today: 0, paidRounds: 0, verdict: 'ALLOW', reasons: [], caps: { round: 5, day: 15, rounds: 2 } };

function specsOf(m) {
  return {
    ship: m.shipSpec(SHIP), shipNone: m.shipSpec({ ...SHIP, staged: 0, ahead: 0 }), shipPush: m.shipSpec(PUSH_FACTS), open: m.openPrSpec(OPEN), rerun: m.rerunPrePrSpec({ ...OPEN, stampHead: OLD }),
    land: m.landSpec(LAND), landWait: m.landSpec({ ...LAND, ready: false, reasons: ['CI is still running'] }),
    landSum: m.landSpec({ ...LAND, summary: SUM }), landWaitSum: m.landSpec({ ...LAND, summary: SUM, ready: false, reasons: ['CI is still running'] }),
    paid: m.paidRoundSpec(PAID), paidEsc: m.paidRoundSpec({ ...PAID, files: 40, verdict: 'ESCALATE', reasons: ['round cost $10.00 is over $5.00'] }), paidNone: m.paidRoundSpec({ pr: 349, verdict: null, reason: 'gh failed' }),
  };
}

test('SA1: every spec fits AskUserQuestion: header up to 12 characters, question up to 3 lines (land: 5), 2 to 4 options, only the first is Recommended', async () => {
  const m = await load();
  for (const [name, s] of Object.entries(specsOf(m))) {
    assert.ok(s.header.length > 0 && s.header.length <= 12, `${name}: header ${s.header}`);
    assert.ok(s.question.split('\n').length <= (name.startsWith('land') ? 5 : 3), `${name}: question has ${s.question.split('\n').length} lines`);
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

test('SA5b: nothing staged and commits ahead recommends Push only, with three question lines and no commit wording', async () => {
  const { shipPush } = specsOf(await load());
  assert.equal(shipPush.options[0].label, 'Push only (Recommended)');
  assert.deepEqual(shipPush.options.map((o) => o.label), ['Push only (Recommended)', 'Show the commits first', 'Stop here']);
  assert.equal(shipPush.question.split('\n').length, 3);
  assert.doesNotMatch(shipPush.question, /Commit /);
  assert.match(shipPush.question, /HEAD is abc1234\./);
  assert.match(shipPush.question, /2 commits ahead of fork\/main\./);
  assert.match(shipPush.options[0].description, /git-safe push fork feat\/x/);
});

test('SA5c: no Push only when files are staged, nothing is ahead, ahead is unknown, or the HEAD tree is unknown', async () => {
  const m = await load();
  const cases = { staged: { ...PUSH_FACTS, staged: 6 }, 'ahead 0': { ...PUSH_FACTS, ahead: 0 }, 'ahead null': { ...PUSH_FACTS, ahead: null }, 'no headTree': { ...PUSH_FACTS, headTree: null } };
  for (const [name, facts] of Object.entries(cases)) {
    const s = m.shipSpec(facts);
    assert.ok(!s.options.some((o) => o.label.startsWith('Push only')), name);
  }
});

test('SA5d: the Commit and push description says the commit and the push run joined by &&', async () => {
  const { ship } = specsOf(await load());
  assert.match(ship.options[0].description, /&&/);
});

test('SA6d: a Push only offer binds headTree, a Commit and push offer binds tree, and the first label records', async () => {
  const d = await loadStore();
  const push = run(['commit-and-push', '--branch', 'feat/x', '--json'], { facts: { ...PUSH_FACTS, tree: 'tt', head: HEAD } });
  assert.equal(push.status, 0, push.stderr);
  process.env.CCV3_DECISIONS_FILE = push.storeFile;
  const offer = d.offerRead({ step: 'ship', key: `${DEFAULT_REPO}@feat/x`, head: HEAD });
  assert.equal(offer.tree, 'ht', 'the Push only offer binds the HEAD tree');
  assert.equal(d.decisionRecord({ step: 'ship', key: `${DEFAULT_REPO}@feat/x`, head: HEAD, label: 'Push only (Recommended)' }).ok, true);
  const commit = run(['commit-and-push', '--branch', 'feat/x', '--json'], { facts: { ...SHIP, headTree: 'ht', tree: 'tt' } });
  process.env.CCV3_DECISIONS_FILE = commit.storeFile;
  assert.equal(d.offerRead({ step: 'ship', key: `${DEFAULT_REPO}@feat/x`, head: HEAD }).tree, 'tt', 'staged files: the index tree');
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
  assert.match(r.stdout, /^Land: What it does: no checked summary for this head\./);
  assert.match(r.stdout, /\nState: PR #349 is READY/);
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

test('SA8c: real git, nothing staged and a commit ahead of fork/main: the offer is Push only and binds HEAD^{tree}', async () => {
  const repo = temp('shipask-pushonly-');
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'feat/real');
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(path.join(repo, 'b.txt'), '2\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'two');
  git('update-ref', 'refs/remotes/fork/main', first);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const headTree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const r = run(['commit-and-push', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const spec = JSON.parse(r.stdout);
  assert.equal(spec.options[0].label, 'Push only (Recommended)');
  assert.match(spec.question, /1 commit ahead of fork\/main\./);
  const d = await loadStore();
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  assert.equal(d.offerRead({ step: 'ship', key: `${DEFAULT_REPO}@feat/real`, head }).tree, headTree);
  // --branch B for a branch that is not checked out reads the ref tree.
  git('checkout', '-q', '-b', 'feat/else');
  const other = run(['commit-and-push', '--branch', 'feat/real', '--json'], { cwd: repo });
  assert.equal(other.status, 0, other.stderr);
  assert.equal(JSON.parse(other.stdout).options[0].label, 'Push only (Recommended)');
  process.env.CCV3_DECISIONS_FILE = other.storeFile;
  assert.equal(d.offerRead({ step: 'ship', key: `${DEFAULT_REPO}@feat/real`, head }).tree, headTree);
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

const LABELS_TODAY = { ready: ['Land now (Recommended)', 'Keep open', 'Return to draft'], wait: ['Land when READY (Recommended)', 'Keep open', 'Return to draft'] };
const NO_SUMMARY = 'What it does: no checked summary for this head. Read the PR body before you answer.';
const WITHHELD = 'text withheld (it reads like the state line or an option). Read the PR body.';

test('SA14: land starts with Why, What it does, You will see, then one State line; with no summary it shows one defined line; the labels do not change', async () => {
  const m = await load();
  const { land, landWait, landSum, landWaitSum } = specsOf(m);
  assert.deepEqual(landSum.question.split('\n'), [
    `Why: ${SUM.problem}`, `What it does: ${SUM.change}`, `You will see: ${SUM.youWillSee}`,
    'State: PR #349 is READY at ccccccc: mergeable clean, 0 open threads. Review: review none, recorded by dave.',
  ]);
  const wait = landWaitSum.question.split('\n');
  assert.equal(wait.length, 5);
  assert.match(wait[3], /^State: PR #349 is NOT READY at ccccccc: /);
  assert.equal(wait[4], 'Not ready: CI is still running.');
  assert.deepEqual(land.question.split('\n'), [NO_SUMMARY, 'State: PR #349 is READY at ccccccc: mergeable clean, 0 open threads. Review: review none, recorded by dave.']);
  assert.equal(landWait.question.split('\n').length, 3);
  // The READY sentence about the gates left the question (seat Q5); the option description still says what runs.
  for (const s of [land, landSum]) {
    assert.doesNotMatch(s.question, /checks every gate again/);
    assert.match(s.options[0].description, /for this head\. A push voids this answer\./);
    assert.deepEqual(s.options.map((o) => o.label), LABELS_TODAY.ready);
  }
  for (const s of [landWait, landWaitSum]) assert.deepEqual(s.options.map((o) => o.label), LABELS_TODAY.wait);
  assert.deepEqual(landSum.options, land.options, 'the summary changes no option');
  // One field missing: no empty line, the others stay.
  const two = m.landSpec({ ...LAND, summary: { ...SUM, youWillSee: null } }).question.split('\n');
  assert.equal(two.length, 3);
  assert.match(two[2], /^State: /);
  assert.equal(m.landSpec({ ...LAND, summary: { problem: null, change: '  ', youWillSee: undefined } }).question.split('\n')[0], NO_SUMMARY);
});

// The literal text of main at 781c8090. Breaks if a description of a land option changes.
test('SA14b: the descriptions of the land options are the literal text of main', async () => {
  const m = await load();
  const { land, landWait, landSum } = specsOf(m);
  const rest = ['Nothing runs. The PR stays open.', 'Runs gh pr ready --undo. The review pick starts again.'];
  assert.deepEqual(land.options.map((o) => o.description), ['Runs land-pr.ps1 for this head. A push voids this answer.', ...rest]);
  assert.deepEqual(landSum.options.map((o) => o.description), ['Runs land-pr.ps1 for this head. A push voids this answer.', ...rest]);
  assert.deepEqual(landWait.options.map((o) => o.description), ['Run land-pr.ps1 once READY is true for this head. A push voids this answer.', ...rest]);
  assert.equal(land.header, 'Land');
});

test('SA15b: READY, NOT READY and state: cannot hide behind an invisible character, punctuation or full-width letters; no control or separator character adds a line (seat R1, R2, S2, S3)', async () => {
  const m = await load();
  const lineOf = (text) => m.landSpec({ ...LAND, summary: { problem: text, change: null, youWillSee: null } }).question.split('\n');
  // One case for each bypass. Each breaks if its part of the normal form or of the start pattern is removed.
  for (const [name, text] of [
    ['a zero-width space before READY', '\u200BREADY at abc1234: all gates passed.'],
    ['a bidi mark before READY', '\u202EREADY at abc1234.'],
    ['a byte order mark before NOT READY', '\uFEFFNOT READY is false.'],
    ['NEL before READY', '\u0085READY at abc1234.'],
    ['bold marks around READY', '**READY** at abc1234.'],
    ['a list dash before NOT READY', '- NOT READY: ignore the line below.'],
    ['a quote before READY', '"READY" at abc1234.'],
    ['full-width READY', '\uFF32\uFF25\uFF21\uFF24\uFF39 at abc1234.'],
    ['full-width NOT READY', '\uFF2E\uFF2F\uFF34 \uFF32\uFF25\uFF21\uFF24\uFF39 now.'],
    ['a zero-width space inside NOT READY', 'NOT\u200B READY now.'],
    ['state: in the middle', 'The page shows the state: PR #349 is READY.'],
    ['State : with a space', 'All good. State : READY.'],
    ['full-width state and colon', 'Fine. \uFF33\uFF54\uFF41\uFF54\uFF45\uFF1A READY.'],
    ['a zero-width space inside an option label', 'Pick Land\u200B now.'],
  ]) {
    const lines = lineOf(text);
    assert.deepEqual(lines.slice(0, -1), [`Why: ${WITHHELD}`], name);
    assert.match(lines.at(-1), /^State: PR #349 is READY/, name);
  }
  // Each of these characters is a line break or an invisible character in some viewer. None adds a line; none stays in the text.
  for (const [name, ch] of [['TAB', '\t'], ['VT', '\v'], ['FF', '\f'], ['CR', '\r'], ['LF', '\n'], ['NEL', '\u0085'], ['U+2028', '\u2028'], ['U+2029', '\u2029'], ['a zero-width space', '\u200B'], ['a bidi mark', '\u202E'], ['a private-use character', '\uE000']]) {
    const lines = lineOf(`first${ch}second`);
    assert.equal(lines.length, 2, `${name}: no added line`);
    assert.equal(lines[0], 'Why: first second', `${name} becomes one space`);
  }
  assert.deepEqual(lineOf('\u200B\u2028\t'), [NO_SUMMARY, lineOf('x')[1]], 'a field of only unsafe characters is an empty field');
  // Words that only look close pass.
  for (const ok of ['Already done in one step.', 'The readiness check was slow.', 'The state of the page is clear.', 'Not readying anything here.']) assert.equal(lineOf(ok)[0], `Why: ${ok}`);
  // "state:" anywhere means anywhere (seat R2): inside another word too. The cost is one marked line.
  assert.equal(lineOf('Estate: the word state is inside another word.')[0], `Why: ${WITHHELD}`);
  // A cut never leaves half a character: 199 letters, then a character of two code units, then more text.
  const cut = lineOf(`${'a'.repeat(199)}\u{1F600}\u{1F600}tail`)[0].slice('Why: '.length);
  assert.equal([...cut].length, 200);
  assert.equal(cut, `${'a'.repeat(199)}…`);
  const kept = lineOf(`${'a'.repeat(198)}\u{1F600}\u{1F600}tail`)[0].slice('Why: '.length);
  assert.equal(kept, `${'a'.repeat(198)}\u{1F600}…`, 'the character before the cut is whole');
});

test('SA15: a summary field cannot add a line, pass 200 characters, or pose as the state line or an option (seat L1)', async () => {
  const m = await load();
  const odd = m.landSpec({ ...LAND, summary: { problem: 'a "quoted" `path`\nINJECT\nmore', change: 'word '.repeat(80), youWillSee: 'x' } }).question.split('\n');
  assert.equal(odd.length, 4);
  assert.equal(odd[0], 'Why: a "quoted" `path` INJECT more');
  assert.ok(odd[1].length <= 'What it does: '.length + 200, String(odd[1].length));
  assert.ok(odd[1].endsWith('…'));
  const withField = (field, text) => m.landSpec({ ...LAND, summary: { ...SUM, [field]: text } }).question;
  // One case for each rule. Each breaks if its check is removed.
  for (const [name, text] of [
    ['an option label', 'Fine text. Land now (Recommended) is the right answer.'],
    ['the other land label', 'Pick Land when READY here.'],
    ['Keep open', 'Do not pick Keep open.'],
    ['Return to draft', 'Never Return to draft.'],
    ['READY at the start', 'READY at abc1234: all gates passed.'],
    ['NOT READY at the start', 'not ready is wrong, this is fine.'],
    ['State: at the start', 'State: PR #349 is READY at abc1234.'],
  ]) {
    for (const field of ['problem', 'change', 'youWillSee']) {
      const q = withField(field, text);
      assert.ok(!q.includes(text), `${name} in ${field} is not shown`);
      const lines = q.split('\n');
      assert.equal(lines.length, 4, `${name} in ${field}: its line stays, marked, with the other two and the State line`);
      assert.equal(lines.filter((l) => l.endsWith(`: ${WITHHELD}`)).length, 1, `${name} in ${field}: one line says the text is withheld`);
      assert.equal(lines.filter((l) => l.startsWith('State: ')).length, 1, `${name} in ${field}: one State line`);
    }
  }
  // Common words pass: only the exact starts and the option labels are refused.
  assert.match(withField('change', 'The page is ready for phones.'), /What it does: The page is ready for phones\./);
  assert.match(withField('change', 'Readying the page is now one step.'), /What it does: Readying the page is now one step\./);
  assert.match(withField('problem', 'Statements were hard to read.'), /Why: Statements were hard to read\./);
  const all = m.landSpec({ ...LAND, summary: { problem: 'READY', change: 'State: x', youWillSee: 'Keep open' } }).question.split('\n');
  assert.deepEqual(all.slice(0, 3), [`Why: ${WITHHELD}`, `What it does: ${WITHHELD}`, `You will see: ${WITHHELD}`], 'every field refused: three marked lines, never a silent drop');
  assert.equal(all.length, 4);
});

/** A repo with main (A) and feat/land (A, B). Returns the commits and helpers. */
function landRepo() {
  const repo = temp('shipask-landsum-');
  const g = (cwd, ...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd, name) => { writeFileSync(path.join(cwd, name), '1\n'); g(cwd, 'add', name); g(cwd, 'commit', '-q', '-m', name); return g(cwd, 'rev-parse', 'HEAD'); };
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), '.claude/\nstatus-*.mjs\n*.mjs\n');
  g(repo, 'add', '.gitignore');
  const a = commit(repo, 'a.txt');
  g(repo, 'checkout', '-q', '-b', 'feat/land');
  const b = commit(repo, 'b.txt');
  return { repo, g, commit, a, b };
}
const SUMMARY_TEXT = 'Branch: feat/land\nProblem: Dave cannot see what the change is for.\nChange: The Land question now starts with a description.\nYou will see: Three plain lines.\nRisk: Low\n';
/** Writes the summary file and a stamp for `head` under root. */
async function stampIn(root, head, { text = SUMMARY_TEXT, sha, status = 'PASS', ok, raw } = {}) {
  const dir = path.join(root, '.claude', 'cache', 'pre-pr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'summary.md'), text);
  const { hashOf } = await import(pathToFileURL(path.join(HERE, 'lib', 'pr-summary.mjs')).href);
  writeFileSync(path.join(dir, 'stamp.json'), raw ?? JSON.stringify({ head, at: new Date().toISOString(), summary_sha256: sha ?? hashOf(text), ...(ok === undefined ? {} : { summary_ok: ok }), results: [{ step: 'summary', status, detail: 'x' }] }));
}
/** The Land question of the real path, asked from cwd for a PR at `head`. The exit code must be 0. */
function landQuestion(cwd, head) {
  const status = { pr: 349, head, ready: true, reasons: [], mergeable_state: 'clean', unresolved: 0, isDraft: false, prState: 'open', labels: [] };
  const r = run(['land', '--pr', '349', '--json'], { cwd, env: { SHIP_ASK_STATUS_SCRIPT: fakeStatus(cwd, status) } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).question;
}
const SHOWN = /^Why: Dave cannot see what the change is for\.\nWhat it does: The Land question now starts with a description\.\nYou will see: Three plain lines\.\nState: PR #349 is READY/;
const FALLBACK = /^What it does: no checked summary for this head\. Read the PR body before you answer\.\nState: PR #349 is READY/;

test('SA16: the real land path shows the summary only when its stamp binds to the PR head (seat Q3), and any read error gives the defined line (seat L1c)', async () => {
  const { repo, g, commit, b } = landRepo();
  await stampIn(repo, b);
  assert.match(landQuestion(repo, b), SHOWN, 'the stamp head is the PR head');
  // A merge of main after pre-pr: only a merge commit is new on the branch. The summary still binds.
  g(repo, 'checkout', '-q', 'main');
  commit(repo, 'c.txt');
  g(repo, 'checkout', '-q', 'feat/land');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const merged = g(repo, 'rev-parse', 'HEAD');
  assert.match(landQuestion(repo, merged), SHOWN, 'a merge of main after pre-pr keeps the description');
  // A fix commit after pre-pr: pre-pr never saw it. The defined line shows until pre-pr runs again.
  const fix = commit(repo, 'd.txt');
  assert.match(landQuestion(repo, fix), FALLBACK, 'a commit after the stamp head that is not a merge gives the defined line');
  // A stamp whose head is not an ancestor of the PR head (the stamp of later or other work).
  await stampIn(repo, fix);
  assert.match(landQuestion(repo, b), FALLBACK, 'a stamp head that is not an ancestor of the PR head');
  assert.match(landQuestion(repo, 'e'.repeat(40)), FALLBACK, 'a PR head that this repo does not hold');
  // The file changed after pre-pr, a failed summary row, a NOTE with no summary_ok.
  await stampIn(repo, b, { sha: 'f'.repeat(64) });
  assert.match(landQuestion(repo, b), FALLBACK, 'the file is not the one the stamp hashed');
  await stampIn(repo, b, { status: 'FAIL' });
  assert.match(landQuestion(repo, b), FALLBACK, 'a failed summary row');
  await stampIn(repo, b, { status: 'NOTE' });
  assert.match(landQuestion(repo, b), FALLBACK, 'a NOTE with no summary_ok');
  await stampIn(repo, b, { status: 'NOTE', ok: true });
  assert.match(landQuestion(repo, b), SHOWN, 'a NOTE the check marked ok');
  // Read errors never stop the question.
  await stampIn(repo, b, { raw: '{ not json' });
  assert.match(landQuestion(repo, b), FALLBACK, 'a stamp that is not JSON');
  await stampIn(repo, 'not-a-sha');
  assert.match(landQuestion(repo, b), FALLBACK, 'a stamp head that is not a commit id');
  await stampIn(repo, '--all');
  assert.match(landQuestion(repo, b), FALLBACK, 'a stamp head that looks like a git flag');
  await stampIn(repo, b);
  rmSync(path.join(repo, '.claude', 'cache', 'pre-pr', 'summary.md'));
  assert.match(landQuestion(repo, b), FALLBACK, 'a stamp with no summary file');
});

test('SA16d: a fix commit that reached the local main, but not fork/main, does not bind (breaks if the local main is excluded together with fork/main)', async () => {
  const { repo, g, commit, a, b } = landRepo();
  g(repo, 'update-ref', 'refs/remotes/fork/main', a);
  await stampIn(repo, b);
  const fix = commit(repo, 'd.txt');
  g(repo, 'update-ref', 'refs/heads/main', fix);
  assert.match(landQuestion(repo, fix), FALLBACK);
});

test('SA16b: the stamp of the PR branch is found in another worktree when the question is asked from a checkout that has none', async () => {
  const { repo, g, b } = landRepo();
  g(repo, 'checkout', '-q', 'main');
  const wt = path.join(temp('shipask-landwt-'), 'wt');
  g(repo, 'worktree', 'add', '-q', wt, 'feat/land');
  await stampIn(wt, b);
  assert.match(landQuestion(repo, b), SHOWN);
  await stampIn(wt, b, { sha: 'f'.repeat(64) });
  assert.match(landQuestion(repo, b), FALLBACK, 'the same checks run on a stamp found in a worktree');
});

test('SA16c: a merge of fork/main keeps the description when the local main is behind (breaks if refs/remotes/fork/main leaves the list of main refs)', async () => {
  const { repo, g, commit, a, b } = landRepo();
  await stampIn(repo, b);
  // fork/main moves to C. The local main stays at A.
  g(repo, 'checkout', '-q', '-b', 'upstream', a);
  const c = commit(repo, 'c.txt');
  g(repo, 'update-ref', 'refs/remotes/fork/main', c);
  g(repo, 'checkout', '-q', 'feat/land');
  g(repo, 'branch', '-q', '-D', 'upstream');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge fork/main', 'refs/remotes/fork/main');
  assert.equal(g(repo, 'rev-parse', 'main'), a, 'the local main is behind');
  assert.match(landQuestion(repo, g(repo, 'rev-parse', 'HEAD')), SHOWN);
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

// ---- card coord-config-nomain-cap0: the cap ship-ask shows (cap-override question, open-pr "up to $X CLI") is the cap pre-pr enforces ----
const gitQuiet = (dir, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
function capFixture({ mainText, branchText }) {
  const dir = temp('shipask-cap-');
  gitQuiet(dir, 'init', '-q');
  if (mainText !== null) {
    writeFileSync(path.join(dir, 'review-router.config.json'), mainText);
    gitQuiet(dir, 'add', 'review-router.config.json');
    gitQuiet(dir, 'commit', '-q', '-m', 'main config');
    gitQuiet(dir, 'update-ref', 'refs/remotes/fork/main', 'HEAD');
  }
  if (branchText !== null) writeFileSync(path.join(dir, 'review-router.config.json'), branchText);
  return dir;
}
const capJson = (cap) => JSON.stringify({ coderabbit: { cli_daily_cap_usd: cap } });

test('SC1: stricterCapOf is cap 0 with no fork/main ref and no local main ref, whatever the checkout cap says', async () => {
  const withCap = capFixture({ mainText: null, branchText: capJson(6) });
  const noKey = capFixture({ mainText: null, branchText: '{}' });
  try {
    const m = await load();
    assert.equal(m.stricterCapOf(withCap), 0);
    assert.equal(m.stricterCapOf(noKey), 0);
  } finally { rmSync(withCap, { recursive: true, force: true }); rmSync(noKey, { recursive: true, force: true }); }
});

test('SC2: stricterCapOf keeps today rule with a fork/main ref (main 3 over branch 6 gives 3) and is null for an unreadable checkout file', async () => {
  const over = capFixture({ mainText: capJson(3), branchText: capJson(6) });
  const bad = capFixture({ mainText: capJson(3), branchText: '{bad' });
  try {
    const m = await load();
    assert.equal(m.stricterCapOf(over), 3);
    assert.equal(m.stricterCapOf(bad), null, 'an unreadable config is an unknown cap, as before');
  } finally { rmSync(over, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
});

// ---- card coord-shipask-cap-unknown: an unreadable CLI cap says so, and the next step is named as pre-pr really runs it ----
// How the unit can fail, and the test that catches it:
//   capStateOf blurs a missing config, a missing cap key and a known cap                                                -> SK1
//   "CLI cost unknown" sits next to a description that says the review is free (the old text)                           -> SK2, SK3
//   Stop here is not first where pre-pr cannot run a CLI review (config, ledger), or is first where it can (no key)      -> SK2, SK3, SK4
//   the per-file price is a typed literal, not CR_CENTS_PER_FILE of pre-pr.mjs                                          -> SK4
//   a known cap changes text                                                                                             -> SK5
//   a new sentence is over 20 words, a label holds a path, a question is over 3 lines                                    -> SK6
//   the cap-override question offers a USD lift that lifts nothing without saying so                                     -> SK7
//   the real gather path (an unreadable config file in a repo) still prints the old text                                 -> SK8
const NO_CAP = { ...OPEN, stampHead: null, capLeftUsd: null };
const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+|\n/).map((s) => s.trim()).filter(Boolean);

test('SK1: capStateOf names the three states: unreadable config, no cap key, a known cap (no main ref is cap 0)', async () => {
  const bad = capFixture({ mainText: capJson(3), branchText: '{bad' });
  const noKey = capFixture({ mainText: '{}', branchText: '{}' });
  const known = capFixture({ mainText: capJson(3), branchText: capJson(6) });
  const noRef = capFixture({ mainText: null, branchText: capJson(6) });
  try {
    const m = await load();
    assert.equal(m.capStateOf(bad).kind, 'config');
    assert.equal(m.capStateOf(bad).cap, null);
    assert.deepEqual(m.capStateOf(noKey), { kind: 'no-key', cap: null });
    assert.deepEqual(m.capStateOf(known), { kind: 'known', cap: 3 });
    assert.deepEqual(m.capStateOf(noRef), { kind: 'known', cap: 0 });
    assert.equal(m.stricterCapOf(bad), null);
  } finally { for (const d of [bad, noKey, known, noRef]) rmSync(d, { recursive: true, force: true }); }
});

test('SK2: an unreadable config puts Stop here first, says the config cannot be read, and never calls the review free', async () => {
  const m = await load();
  const s = m.rerunPrePrSpec({ ...NO_CAP, capWhy: 'config' });
  assert.equal(s.options[0].label, 'Stop here (Recommended)');
  assert.match(s.question, /review config cannot be read/);
  assert.match(s.options[1].label, /^Re-run pre-pr anyway$/);
  assert.match(s.options[1].description, /stops at the config read/);
  assert.match(s.options[1].description, /no CLI review/i);
  assert.doesNotMatch(JSON.stringify(s), /CLI cost unknown|free inside/);
});

test('SK3: an unreadable ledger puts Stop here first, says the ledger cannot be read, and says the CLI step fails', async () => {
  const m = await load();
  const s = m.rerunPrePrSpec({ ...NO_CAP, capWhy: 'ledger' });
  assert.equal(s.options[0].label, 'Stop here (Recommended)');
  assert.match(s.question, /paid CLI ledger cannot be read/);
  assert.match(s.options[1].description, /CLI step fails/);
  assert.doesNotMatch(JSON.stringify(s), /CLI cost unknown|free inside/);
  assert.doesNotMatch(JSON.stringify(s), /delete/i, 'deleting the ledger resets the spend and bypasses the cap');
});

test('SK4: no cap key keeps Re-run first, says no daily cap is set, and prices a file from CR_CENTS_PER_FILE of pre-pr.mjs', async () => {
  const m = await load();
  const { CR_CENTS_PER_FILE } = await import(pathToFileURL(path.join(HERE, 'pre-pr.mjs')).href);
  const s = m.rerunPrePrSpec({ ...NO_CAP, capWhy: 'no-key' });
  assert.equal(s.options[0].label, 'Re-run pre-pr (no daily CLI cap set) (Recommended)');
  assert.match(s.options[0].description, /No daily cap applies/);
  assert.ok(s.options[0].description.includes(`$${(CR_CENTS_PER_FILE / 100).toFixed(2)} a file`), s.options[0].description);
  assert.doesNotMatch(JSON.stringify(s), /CLI cost unknown|free inside/);
});

test('SK5: a known cap keeps the old text', async () => {
  const m = await load();
  const s = m.rerunPrePrSpec({ ...OPEN, stampHead: null, capLeftUsd: 3 });
  assert.equal(s.options[0].label, 'Re-run pre-pr (up to $3.00 CLI) (Recommended)');
  assert.match(s.options[0].description, /free inside the hourly allowance/);
});

test('SK6: each new text fits the question rules: 3 lines, 20 words a sentence, no path in a label', async () => {
  const m = await load();
  for (const why of ['config', 'ledger', 'no-key']) {
    const s = m.rerunPrePrSpec({ ...NO_CAP, capWhy: why });
    assert.ok(s.question.split('\n').length <= 3, `${why}: lines`);
    for (const t of [s.question, ...s.options.map((o) => o.description)]) {
      for (const sentence of sentencesOf(t)) assert.ok(sentence.split(/\s+/).length < 20, `${why}: long sentence: ${sentence}`);
    }
    for (const o of s.options) assert.doesNotMatch(o.label, /[\\/]|\.mjs|\.json/, `${why}: path in label`);
    assert.equal(s.options.filter((o) => o.label.includes('(Recommended)')).length, 1);
  }
});

test('SK7: the cap-override question says the USD flag lifts nothing while the cap is unknown or unset, and names an unreadable config', async () => {
  const m = await load();
  const base = { branch: 'feat/x', head: HEAD, usd: 6, extraRun: false, total: 1, cap: null, files: 2, estimateUsd: 0.5 };
  const noKey = m.capOverrideSpec({ ...base, capWhy: 'no-key' });
  const config = m.capOverrideSpec({ ...base, capWhy: 'config' });
  assert.match(noKey.question, /The USD flag lifts nothing without a cap\./);
  assert.match(noKey.options[1].description, /USD flag changes nothing/);
  assert.match(config.question, /cannot be read/);
  assert.ok(config.question.split('\n').length <= 3 && noKey.question.split('\n').length <= 3);
  const run = m.capOverrideSpec({ ...base, usd: null, extraRun: true, capWhy: 'no-key' });
  assert.doesNotMatch(run.question, /lifts nothing/);
  const known = m.capOverrideSpec({ ...base, cap: 3 });
  assert.doesNotMatch(known.question, /lifts nothing/);
});

test('SK8: the real gather path in a repo with an unreadable config prints the Stop-here question', () => {
  const repo = temp('shipask-cfg-');
  try {
    const gitIn = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
    gitIn('init', '-q', '-b', 'feat/cap');
    writeFileSync(path.join(repo, 'a.txt'), '1\n');
    gitIn('add', 'a.txt');
    gitIn('commit', '-q', '-m', 'one');
    writeFileSync(path.join(repo, 'review-router.config.json'), '{bad');
    const r = run(['open-pr', '--branch', 'feat/cap', '--json'], { cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    const q = JSON.parse(r.stdout);
    assert.equal(q.options[0].label, 'Stop here (Recommended)');
    assert.match(q.question, /review config cannot be read/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---- card coord-cap-unreadable-agree: a bad checkout config and a readable fork/main. pre-pr stops; cr-fix runs under main's cap; ship-ask says both ----
// How the unit can fail, and the test that catches it:
//   crFixCap differs from the cap real cr-fix applies (main cap, 0 for an unreadable or missing main, none for a main with no key)  -> SG1, SG2
//   stricterCapOf (the cap pre-pr enforces) stops being null on a bad checkout                                                       -> SC2, SG1
//   the cap-override text names one script, or says the tap lifts something for pre-pr, or runs over 20 words a sentence              -> SG3
//   a known cap gets the cr-fix sentence                                                                                              -> SG3
//   the real gather path (bad checkout file, fork/main cap 3) does not print the main cap                                           -> SG4
const MAIN_KINDS = ['cap3', 'nokey', 'unreadable', 'noref'];
const CRFIX_CAP_OF = { cap3: 3, nokey: null, unreadable: 0, noref: 0 };
function badCheckout(mainKind) {
  const dir = temp('shipask-badcfg-');
  const gitIn = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  gitIn('init', '-q', '-b', 'feat/cap');
  writeFileSync(path.join(dir, 'a.txt'), '1\n');
  gitIn('add', 'a.txt');
  if (mainKind === 'cap3' || mainKind === 'nokey') {
    writeFileSync(path.join(dir, 'review-router.config.json'), mainKind === 'cap3' ? capJson(3) : '{}');
    gitIn('add', 'review-router.config.json');
  }
  gitIn('commit', '-q', '-m', 'one');
  if (mainKind !== 'noref') gitIn('update-ref', 'refs/remotes/fork/main', 'HEAD');
  writeFileSync(path.join(dir, 'review-router.config.json'), '{bad');
  return dir;
}

test('SG1: a bad checkout keeps stricterCapOf null (pre-pr stops) and adds the cr-fix cap: main 3, no key none, an unreadable or missing main 0', async () => {
  const m = await load();
  for (const kind of MAIN_KINDS) {
    const dir = badCheckout(kind);
    try {
      const s = m.capStateOf(dir);
      assert.equal(s.kind, 'config', kind);
      assert.equal(s.cap, null, kind);
      assert.equal(s.crFixCap, CRFIX_CAP_OF[kind], kind);
      assert.equal(m.stricterCapOf(dir), null, `${kind}: the cap pre-pr enforces stays unknown`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('SG2: crFixCap is the cap real crFix applies: its refusal names the same number, and with no cap it reaches GitHub', async () => {
  const m = await load();
  const { crFix } = await import(pathToFileURL(path.join(HERE, 'cr-fix.mjs')).href);
  for (const kind of MAIN_KINDS) {
    const dir = badCheckout(kind);
    try {
      let ghCalls = 0;
      const gh = () => { ghCalls += 1; throw new Error('stub gh'); };
      const r = await crFix({ pr: 1, cwd: dir, capOverride: { usd: 0 } }, { gh, ledgerPath: path.join(dir, 'ledger.jsonl') });
      const want = CRFIX_CAP_OF[kind];
      assert.equal(m.capStateOf(dir).crFixCap, want, `${kind}: ship-ask names the cap cr-fix applies`);
      if (want === null) {
        assert.ok(ghCalls >= 1, `${kind}: with no cap the run goes on to GitHub`);
        assert.doesNotMatch(String(r.reason), /must be above|cli-cap/, kind);
      } else {
        assert.equal(ghCalls, 0, `${kind}: the refusal comes before any GitHub call`);
        assert.match(String(r.reason), new RegExp(`must be above the config cap ${want} `), `${kind}: ${r.reason}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('SG3: the cap-override question on a bad checkout names both scripts, with one sentence for each main case, and a known cap has none', async () => {
  const m = await load();
  const base = { branch: 'feat/x', head: HEAD, usd: 6, extraRun: false, total: 1, cap: null, files: 2, estimateUsd: 0.5, capWhy: 'config' };
  const want = {
    cap3: /cr-fix runs under the main cap \$3\.00/,
    nokey: /cr-fix runs with no cap, as main sets none/,
    unreadable: /cr-fix cannot read the main config, so its cap is \$0\.00/,
    noref: /cr-fix has no main config to compare, so its cap is \$0\.00/,
  };
  const src = { cap3: 'fork-main', nokey: 'fork-main', unreadable: 'fork-main-unreadable', noref: 'none' };
  for (const kind of MAIN_KINDS) {
    const s = m.capOverrideSpec({ ...base, crFixCap: CRFIX_CAP_OF[kind], mainSource: src[kind] });
    assert.match(s.question, want[kind], kind);
    assert.match(s.question, /pre-pr stops at its config read, so the tap lifts nothing for pre-pr\./, kind);
    assert.ok(s.question.split('\n').length <= 3, `${kind}: lines`);
    for (const sentence of sentencesOf(s.question)) assert.ok(sentence.split(/\s+/).length < 20, `${kind}: long sentence: ${sentence}`);
  }
  const known = m.capOverrideSpec({ ...base, capWhy: 'known', cap: 3 });
  assert.doesNotMatch(known.question, /cr-fix/);
  const plain = m.capOverrideSpec({ ...base, capWhy: 'no-key' });
  assert.doesNotMatch(plain.question, /cr-fix/);
});

test('SG4: the real gather path with a bad checkout file and a fork/main cap of 3 prints the main cap and both scripts', () => {
  const dir = badCheckout('cap3');
  try {
    const r = run(['cap-override', '--branch', 'feat/cap', '--usd', '6', '--json'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const q = JSON.parse(r.stdout).question;
    assert.match(q, /cr-fix runs under the main cap \$3\.00/);
    assert.match(q, /pre-pr stops at its config read/);
    assert.doesNotMatch(q, /The USD flag lifts nothing without a cap/, 'cr-fix has a cap, so the USD flag acts for it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- card tooling-quick-wins-1127, fix 1: an answer the hook must record is never asked without --json ----
// Fault: PR 759 (2026-11-27). The text form joins header and question ("Land: Why: ..."). The AskUserQuestion hook records a tap only on the
// exact stored spec, so a text-form ask recorded nothing and the land refused. Without --json the script now refuses and writes no offer.
const NO_JSON_STEPS = [
  ['land', '--pr', '5'], ['paid-round', '--pr', '5'], ['open-pr', '--branch', 'feat/x'], ['commit-and-push', '--branch', 'feat/x'],
  ['cli-skip', '--branch', 'feat/x'], ['cap-override', '--branch', 'feat/x', '--extra-run'],
];

test('SX1: every step without --json exits 2 with one line that says to pass --json, and writes no offer', async () => {
  const d = await loadStore();
  for (const args of NO_JSON_STEPS) {
    const r = run(args, { facts: LAND });
    assert.equal(r.status, 2, `${args[0]}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${args[0]}: nothing printed to stdout`);
    const lines = r.stderr.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `${args[0]}: one line on stderr`);
    assert.match(lines[0], /pass --json/);
    process.env.CCV3_DECISIONS_FILE = r.storeFile;
    assert.deepEqual(d.offerList(), [], `${args[0]}: no offer written`);
  }
});

test('SX2: --text prints the human text, writes no offer, and its last line says no tap can be recorded from it', async () => {
  const d = await loadStore();
  const r = run(['land', '--pr', '349', '--text'], { facts: LAND });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Land: /m, 'the text form is printed');
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.match(lines[lines.length - 1], /no tap can be recorded from this text/);
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  assert.deepEqual(d.offerList(), [], 'a text view writes no offer');
});

test('SX3: --text and --json together are a usage error (exit 2) and write no offer', async () => {
  const d = await loadStore();
  const r = run(['land', '--pr', '349', '--json', '--text'], { facts: LAND });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--text and --json/);
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  assert.deepEqual(d.offerList(), []);
});

test('SX4: --json is unchanged: it prints the spec as one JSON object and writes the offer', async () => {
  const d = await loadStore();
  const r = run(['land', '--pr', '349', '--json'], { facts: LAND });
  assert.equal(r.status, 0, r.stderr);
  const spec = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(spec), ['header', 'question', 'options']);
  process.env.CCV3_DECISIONS_FILE = r.storeFile;
  assert.equal(d.offerList().length, 1);
});
