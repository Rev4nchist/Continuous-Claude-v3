// Tests for ship-ask.mjs: the AskUserQuestion spec of each ship step, and the offer it writes.
// Run: node --test scripts/github/ship-ask.test.mjs
// The CLI tests run the real script. --facts replaces git, gh and the ledger; CCV3_DECISIONS_FILE moves the store to a temp folder.
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
  assert.match(paidEsc.options[1].label, /^Yes, pay over the cap \(up to \$10\.00\)$/);
  assert.match(paidEsc.question, /ESCALATE: round cost \$10\.00 is over \$5\.00/);
  assert.match(paidNone.options[1].label, /cost unknown/);
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

test('SA5: commit-and-push recommends the commit only when files are staged', async () => {
  const m = await load();
  const { ship, shipNone } = specsOf(m);
  assert.equal(ship.options[0].label, 'Commit and push (Recommended)');
  assert.match(ship.question, /Commit 6 files on feat\/x and push to fork\?\nMessage: 'fix\(pathway\): drop stale labels'\.\n2 commits ahead of fork\/main\./);
  assert.ok(!shipNone.options.some((o) => o.label.startsWith('Commit and push')));
  assert.equal(shipNone.options[0].label, 'Stop here (Recommended)');
});

function run(args, { facts, store, cwd, env = {} } = {}) {
  const dir = temp('shipask-');
  const factsFile = facts ? path.join(dir, 'facts.json') : null;
  if (facts) writeFileSync(factsFile, JSON.stringify(facts));
  const storeFile = store ?? path.join(dir, 'decisions.json');
  const r = spawnSync(process.execPath, [SCRIPT, ...args, ...(factsFile ? ['--facts', factsFile] : [])], { cwd: cwd ?? dir, encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: storeFile, ...env } });
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

test('SA10: the store key of a PR is the same repo string the engine uses', async () => {
  const d = await loadStore();
  assert.equal(d.decisionKey({ pr: 1 }), `${DEFAULT_REPO}#1`);
  assert.equal(d.decisionKey({ branch: 'b' }), `${DEFAULT_REPO}@b`);
});
