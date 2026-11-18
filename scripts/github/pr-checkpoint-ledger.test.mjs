// Tests for the two-call protocol of pr-checkpoint.mjs (pathway-flow-v2, design section 2 step 3), behind the flag checkpoint.ledger.
// Run: node --test scripts/github/pr-checkpoint-ledger.test.mjs
// Every test runs the real engine CLI with --facts and --config (no git state, no gh) and a temp decision store (CCV3_DECISIONS_FILE).
// A tap is simulated with offerRead + decisionRecord on the same store, the way the AskUserQuestion hook does it.
//
// How the unit can fail, and the test that catches it:
//   the flag is false or missing (or --no-ledger is given) and the output still changes or an offer is written             -> LD1
//   call 1 prints a spec that breaks AskUserQuestion limits, hides the recommendation, or leaks the label map              -> LD2
//   call 1 writes no offer, or binds it to another key or head                                                              -> LD2
//   a paid record is written with no tap, or with a tap for another pathway                                                   -> LD3
//   a recorded paid pick leaves its tap, so a second record spends again                                                      -> LD4 and LD6
//   a tap on a paid row does not reach the record state (the one question; see also LD17 to LD21)                             -> LD19
//   none or "Keep as draft" asks a paid confirm, or Keep as draft leaves the decision in the store                          -> LD7
//   a call with no answer is not counted, the re-asks do not stop after 2, or a stop does not say the PR stays a draft     -> LD8
//   --confirm --by dave records with no tap, with a tap for another pathway or head, or with no --pr                         -> LD9
//   --confirm --by default records while the flag is on                                                                      -> LD9
//   a successful --confirm leaves the taps in the store, so they pay twice                                                   -> LD9
//   a tap for an old head counts for the new head                                                                            -> LD10
//   a payload text tells Dave to type '/pathway <' or '/slot pay'                                                            -> LD11
//   a stopped or auto-eligible result opens a question                                                                       -> LD12
//   the recommendation is held and row 0 is a paid pick that is not marked Recommended, or the question names the held one   -> LD14
//   --ask-anyway does not open the question for an auto-eligible PR, or opens one for a stopped result or with the flag off    -> LD15
//   a payload text says "Run /pathway", "run /pathway" or "/slot pay" (a bare word, not only "/pathway <")                    -> LD11
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REPO } from './review-router.mjs';
import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';

registerTempCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const ENGINE = path.join(HERE, 'pr-checkpoint.mjs');
const D = await import(pathToFileURL(path.join(HERE, 'lib', 'decisions.mjs')).href);

const NOW = '2026-11-06T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const PR = 349;
const KEY = `${DEFAULT_REPO}#${PR}`;
const BODY_TEXT = 'PR body\n';
const BODY_SHA = createHash('sha256').update(BODY_TEXT).digest('hex');
const STAMP = (head = HEAD) => ({ head, body_sha256: BODY_SHA, results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] });
const file = (filename) => ({ filename, additions: 10, deletions: 0 });
// Five control-plane files: band HIGH. With risk:high the band is CRITICAL and CodeRabbit is recommended; without it none is.
const FIVE = ['scripts/github/cr-fix.mjs', 'scripts/github/pr-checkpoint.mjs', '.claude/plugins/x/hooks/pr-loop/a.ts', 'scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/context.mjs'];
const LOW = ['apps/x/README.txt'];

const review = (head = HEAD) => ({ step: 'review', key: KEY, head });
const pick = (pathway, head = HEAD) => ({ step: 'paid-round', key: `${KEY}!pick:${pathway}`, head });

function setup({ ledger = true, labels = ['risk:high'], paths = FIVE, head = HEAD, config = {} } = {}) {
  const dir = makeTempDir('ledger-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  writeFileSync(factsFile, JSON.stringify({ head, now: NOW, stamp: STAMP(head), files: paths.map(file), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels }));
  writeFileSync(bodyFile, BODY_TEXT);
  const checkpoint = { ...LIVE.checkpoint, autoConfirm: false, ...(ledger === 'omit' ? {} : { ledger }) };
  if (ledger === 'omit') delete checkpoint.ledger;
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null }, checkpoint, ...config }));
  const storeFile = path.join(dir, 'decisions.json');
  process.env.CCV3_DECISIONS_FILE = storeFile;
  const env = { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir, CCV3_DECISIONS_FILE: storeFile, PR_CHECKPOINT_NO_PROBE: '1' };
  const run = (args) => spawnSync(process.execPath, [ENGINE, ...args, ...(args.includes('--confirm') ? ['--state-dir', state] : []), '--facts', factsFile, '--config', cfgFile], { encoding: 'utf8', cwd: dir, env });
  const call = (extra = []) => { const r = run(['--json', '--pr', String(PR), ...extra]); assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`); return JSON.parse(r.stdout); };
  const confirm = (pathway, by = 'dave', extra = ['--pr', String(PR)]) => run(['--confirm', pathway, '--by', by, '--body', bodyFile, ...extra]);
  return { dir, call, confirm, pathwayFile: path.join(state, 'pathway.json'), storeFile };
}

/** Dave taps the option of `label` on the open offer of `triple`. */
const tap = (triple, label) => assert.deepEqual(D.decisionRecord({ ...triple, label }), { ok: true }, label);
const labelOf = (spec, re) => spec.options.find((o) => re.test(o.label)).label;

test('LD1: with the flag false, missing, or --no-ledger the output has no ledger block and no offer is written', () => {
  for (const [name, opts, extra] of [['false', { ledger: false }, []], ['missing', { ledger: 'omit' }, []], ['no-ledger', { ledger: true }, ['--no-ledger']]]) {
    const t = setup(opts);
    const out = t.call(extra);
    assert.equal('ledger' in out, false, name);
    assert.equal(out.recommended, 'coderabbit', name);
    assert.deepEqual(D.offerList(), [], `${name}: no offer`);
  }
  const t = setup({ ledger: 'true' });
  assert.equal('ledger' in t.call(), false, 'only the literal true turns the protocol on');
});

test('LD2: call 1 asks the review question: the recommendation marked (a paid one is row 1, not row 0), AskUserQuestion limits, an offer under (review, PR key, head), no label map in the print', () => {
  const t = setup();
  const { ledger } = t.call();
  assert.equal(ledger.state, 'ask');
  const s = ledger.ask;
  assert.deepEqual(Object.keys(s), ['header', 'question', 'options']);
  assert.ok(s.header.length <= 12 && s.header === `PR #${PR}`);
  assert.ok(s.question.split('\n').length <= 3, s.question);
  assert.ok(s.options.length >= 2 && s.options.length <= 4);
  assert.equal(s.options[0].label, 'Keep as draft ($0)', 'a paid recommendation is not row 0 (PR C)');
  assert.match(s.options[1].label, /^CodeRabbit review \(up to \$1\.25\) \(Recommended\)$/);
  assert.deepEqual(s.options.map((o) => o.label).filter((_, i) => i !== 1), ['Keep as draft ($0)', 'No review, land on CI ($0)']);
  assert.ok(s.options.every((o) => o.description.length > 0));
  assert.match(s.question, /^PR #349, band CRITICAL, 5 files\.\nRecommended: CodeRabbit review, because /);
  assert.match(s.question, /CodeRabbit slot: unknown/);
  const offer = D.offerRead(review());
  assert.equal(offer.open, true);
  assert.deepEqual(offer.labels, s.options.map((o) => o.label));
  assert.equal(offer.spec.values[s.options[1].label], 'coderabbit');
  const none = setup({ labels: [] }).call().ledger.ask;
  assert.match(none.options[0].label, /^No review, land on CI \(\$0\) \(Recommended\)$/, 'HIGH with no trigger is recommended none: none first');
});

test('LD3: a paid record with no tap, or with the tap of another pathway, is refused and writes nothing', () => {
  const t = setup();
  assert.equal(t.confirm('coderabbit').status, 1, 'no tap');
  tap(review(), labelOf(t.call().ledger.ask, /^No review/));
  assert.equal(t.confirm('coderabbit').status, 1, 'the tap is for none');
  assert.ok(!existsSync(t.pathwayFile));
});

test('LD4 and LD6: a recorded paid pick uses its tap up: a second record is refused and the next call asks afresh', () => {
  const t = setup();
  tap(review(), labelOf(t.call().ledger.ask, /^CodeRabbit review/));
  assert.equal(t.confirm('coderabbit').status, 0);
  const again = t.confirm('coderabbit');
  assert.equal(again.status, 1, `${again.stdout} ${again.stderr}`);
  assert.equal(t.call().ledger.state, 'ask', 'the next call asks afresh');
});

test('LD7: none records with no paid confirm; Keep as draft records nothing and clears the tap', () => {
  const t = setup();
  const ask = t.call().ledger.ask;
  tap(review(), labelOf(ask, /^No review/));
  const out = t.call().ledger;
  assert.deepEqual([out.state, out.pathway, out.by], ['record', 'none', 'dave']);
  assert.equal(D.offerRead(pick('none')), null, 'no paid confirm for none');
  assert.equal(t.confirm('none').status, 0);

  const k = setup();
  const kAsk = k.call().ledger.ask;
  tap(review(), labelOf(kAsk, /^Keep as draft/));
  assert.equal(k.call().ledger.state, 'kept-draft');
  assert.equal(D.decisionRead(review()), null);
  assert.equal(k.confirm('none').status, 1, 'Keep as draft is no tap for none');
});

test('LD8: a call with no answer counts a miss; re-ask 1 of 2, re-ask 2 of 2, then stop and say the PR stays a draft', () => {
  const t = setup();
  const states = [0, 1, 2, 3].map(() => t.call().ledger);
  assert.deepEqual(states.map((l) => l.state), ['ask', 'ask', 'ask', 'stop']);
  assert.deepEqual(states.slice(0, 3).map((l) => l.reasked), [0, 1, 2]);
  assert.match(states[1].text, /1 of 2/);
  assert.match(states[2].text, /2 of 2/);
  assert.equal(states[3].ask ?? null, null, 'no question after the stop');
  assert.match(states[3].text, /PR #349 stays a draft\. Nothing was recorded\./);
  assert.equal(D.missCount(review()), 3);
});

test('LD9: --confirm --by dave needs the matching tap and --pr; --by default is refused while the flag is on', () => {
  const t = setup();
  const refused = (r, re, name) => { assert.equal(r.status, 1, `${name}: ${r.stdout} ${r.stderr}`); assert.match(r.stderr, re, name); assert.ok(!existsSync(t.pathwayFile), `${name}: nothing written`); };
  refused(t.confirm('none'), /no tap|tap/i, 'no tap at all');
  const ask = t.call().ledger.ask;
  tap(review(), labelOf(ask, /^CodeRabbit review/));
  refused(t.confirm('none'), /tap/i, 'a tap for another pathway');
  refused(t.confirm('both'), /held|tap/i, 'both is held here and has no tap');
  refused(t.confirm('coderabbit', 'dave', []), /--pr/, 'no --pr');
  refused(t.confirm('coderabbit', 'default'), /ledger|default/i, '--by default');
  assert.equal(t.confirm('coderabbit').status, 0, 'the tap on the paid row is the paid yes');
});

test('LD10: a tap for an old head does not count for the new head', () => {
  const t = setup({ head: HEAD });
  const spec = { header: 'h', question: 'q', options: [{ label: 'a' }, { label: 'b' }], values: { a: 'none', b: 'wait' } };
  assert.equal(D.offerWrite({ ...review(OLD), spec, tree: null, cwd: '/x' }).ok, true);
  tap(review(OLD), 'a');
  assert.equal(t.call().ledger.state, 'ask', 'the new head asks again');
  assert.equal(t.confirm('none').status, 1);
});

test('LD11: no payload text tells Dave to type or paste a command', () => {
  const t = setup();
  const texts = [];
  for (let i = 0; i < 4; i++) texts.push(JSON.stringify(t.call().ledger));
  tap(review(), JSON.parse(texts[0]).ask.options[0].label);
  texts.push(JSON.stringify(t.call().ledger));
  const all = texts.join('\n');
  assert.doesNotMatch(all, /\/pathway </);
  assert.doesNotMatch(all, /\/slot pay/);
  assert.doesNotMatch(all, /run \/pathway/i);
  assert.match(all, /pr_checkpoint \{pr\}/);
});

test('LD12: a stopped result (no stamp head match) and an auto-eligible LOW PR open no question and write no offer', () => {
  const stopped = setup({ head: HEAD });
  const facts = JSON.parse(readFileSync(path.join(stopped.dir, 'facts.json'), 'utf8'));
  writeFileSync(path.join(stopped.dir, 'facts.json'), JSON.stringify({ ...facts, stamp: STAMP(OLD) }));
  const out = stopped.call();
  assert.equal(out.recommended, null);
  assert.equal(out.ledger.state, 'none');
  assert.deepEqual(D.offerList(), []);
  const auto = setup({ paths: LOW, labels: [], config: { checkpoint: { ...LIVE.checkpoint, autoConfirm: 'low', ledger: true } } });
  const a = auto.call();
  assert.equal(a.auto.eligible, true);
  assert.equal(a.ledger.state, 'none');
  assert.deepEqual(D.offerList(), []);
});

test('LD13: the live config has checkpoint.ledger ON (Dave 2026-11-07), decisions.enforce ON (Dave 2026-11-07), and auto-confirm at low', () => {
  assert.strictEqual(LIVE.checkpoint.ledger, true, 'checkpoint.ledger is on (Dave, 2026-11-07)');
  assert.strictEqual(LIVE.decisions?.enforce, true, 'decisions.enforce is on (Dave, 2026-11-07)');
  assert.strictEqual(LIVE.checkpoint.autoConfirm, 'low');
  const docs = LIVE._doc.join('\n');
  assert.match(docs, /checkpoint\.ledger/);
  assert.match(docs, /decisions\.enforce/);
});

test('LD14: when the recommendation is held, row 0 is "Keep as draft ($0) (Recommended)" and the question says so', async () => {
  const L = await import(pathToFileURL(path.join(HERE, 'lib', 'checkpoint-ledger.mjs')).href);
  const option = (pathway, available) => ({ pathway, available, reason: `${pathway} reason` });
  const result = {
    recommended: 'both', why: ['Critical file x.'], size: { files: 5, lines: 50 }, auto: { band: 'CRITICAL', eligible: false }, capacity: { state: 'free' },
    options: [option('coderabbit', true), option('both', false), option('wait', true), option('none', true)],
  };
  const spec = L.askSpecOf(PR, result, 'unknown.');
  assert.equal(spec.options[0].label, 'Keep as draft ($0) (Recommended)');
  assert.equal(spec.values[spec.options[0].label], 'wait');
  assert.equal(spec.options.filter((o) => o.label.endsWith(' (Recommended)')).length, 1, 'one Recommended row');
  assert.match(spec.question, /Recommended: Keep as draft/);
  assert.doesNotMatch(spec.question, /Recommended: CodeRabbit \+ Greptile/);
  assert.ok(spec.options.length <= 4 && spec.question.split('\n').length <= 3);
  const open = { ...result, options: [option('coderabbit', true), option('both', true), option('wait', true), option('none', true)] };
  const openSpec = L.askSpecOf(PR, open, 'unknown.');
  assert.equal(openSpec.options[0].label, 'CodeRabbit now (free slot, $0)', 'the $0 row leads; the open paid recommendation is not row 0 (PR C)');
  assert.match(openSpec.options[2].label, /^CodeRabbit \+ Greptile \(up to \$1\.25 \+ 3 credits\) \(Recommended\)$/);
});

test('LD15: --ask-anyway opens the question for an auto-eligible PR whose auto-confirm failed; only with the flag, only with the ledger on, never for a stopped result', () => {
  const auto = () => setup({ paths: LOW, labels: [], config: { checkpoint: { ...LIVE.checkpoint, autoConfirm: 'low', ledger: true } } });
  const plain = auto();
  assert.equal(plain.call().ledger.state, 'none', 'without the flag the auto short-circuit stays');
  assert.deepEqual(D.offerList(), []);
  const t = auto();
  const out = t.call(['--ask-anyway']);
  assert.equal(out.auto.eligible, true);
  assert.equal(out.ledger.state, 'ask');
  assert.match(out.ledger.ask.options[0].label, /^No review, land on CI \(\$0\) \(Recommended\)$/);
  assert.equal(D.offerRead(review()).open, true, 'the offer is written');
  const off = setup({ ledger: false, paths: LOW, labels: [] });
  assert.equal('ledger' in off.call(['--ask-anyway']), false, 'the flag cannot turn the ledger on');
  const stopped = setup({ head: HEAD });
  const facts = JSON.parse(readFileSync(path.join(stopped.dir, 'facts.json'), 'utf8'));
  writeFileSync(path.join(stopped.dir, 'facts.json'), JSON.stringify({ ...facts, stamp: STAMP(OLD) }));
  assert.equal(stopped.call(['--ask-anyway']).ledger.state, 'none', 'a stopped result opens no question');
});

// ---- one question for a paid pick (card prflow-review-pick, PR C) ---------------------------------------------------------------------
// The price is in the label of the paid row, so Dave's tap on it is the paid yes. No second "paid confirm" question exists.
// How the unit can fail, and the test that catches it:
//   a paid row is row 0, so a dialog that returns row 0 with no tap spends money                                                  -> LD17, LD18
//   a paid label has no price                                                                                                       -> LD17
//   a paid tap still opens a paid confirm (state confirm-paid), or --confirm still wants the paid tap                              -> LD19
//   the spec Dave sees differs from the offer the hook matches, or a paid-round offer is opened                                    -> LD19
//   the decision row of a paid pick loses the price of the label Dave tapped                                                        -> LD20
//   the free-slot and the paid row share a label or a position, or a re-ask shuffles the rows                                       -> LD21
const PAID_PATHWAYS = ['coderabbit', 'both'];
const pathwayAt = (triple, spec, i) => D.offerRead(triple).spec.values[spec.options[i].label];

test('LD17: HIGH fixture: one question; every paid row carries its price; row 0 is no paid row; the question names the recommendation', () => {
  const t = setup();
  const { ledger } = t.call();
  const spec = ledger.ask;
  const paidRows = spec.options.filter((_, i) => PAID_PATHWAYS.includes(pathwayAt(review(), spec, i)));
  assert.ok(paidRows.length > 0, 'the fixture offers a paid row');
  for (const row of paidRows) assert.match(row.label, /\(up to \$1\.25\)/);
  assert.equal(PAID_PATHWAYS.includes(pathwayAt(review(), spec, 0)), false, `row 0 is "${spec.options[0].label}"`);
  assert.match(spec.question, /Recommended: CodeRabbit review, because /);
  assert.equal(spec.options.filter((o) => o.label.endsWith(' (Recommended)')).length, 1, 'one Recommended row');
});

test('LD18: a dialog that returns row 0 with no tap records no spend: kept-draft, --confirm refused, no paid-round offer', () => {
  const t = setup();
  let out;
  for (const round of [1, 2]) {
    const asked = t.call().ledger;
    assert.match(asked.text, /options in the order given/, 'the model is told to keep the option order');
    tap(review(), asked.ask.options[0].label);
    out = t.call().ledger;
    assert.equal(out.state, 'kept-draft', `row 0, round ${round}`);
  }
  assert.equal(D.offerRead(pick('coderabbit')), null, 'no paid confirm was opened');
  for (const p of PAID_PATHWAYS) assert.equal(t.confirm(p).status, 1, p);
  assert.ok(!existsSync(t.pathwayFile));
});

test('LD19: a tap on the paid row is the paid yes: states ask then record, no confirm-paid, --confirm records by dave and uses the tap up', () => {
  const t = setup();
  const first = t.call().ledger;
  tap(review(), labelOf(first.ask, /^CodeRabbit review/));
  const second = t.call().ledger;
  assert.deepEqual([first.state, second.state, second.pathway, second.by], ['ask', 'record', 'coderabbit', 'dave']);
  assert.equal(D.offerRead(pick('coderabbit')), null, 'no paid-round offer for the pick');
  assert.deepEqual(first.ask, (({ header, question, options }) => ({ header, question, options }))(D.offerRead(review()).spec), 'the printed question is the stored offer');
  const r = t.confirm('coderabbit');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(JSON.parse(readFileSync(t.pathwayFile, 'utf8')).decided_by, 'dave');
  assert.equal(D.decisionRead(review()), null, 'the tap is used up');
});

test('LD20: the decision row of a paid pick holds the label Dave tapped, with its price', () => {
  const t = setup();
  const label = labelOf(t.call().ledger.ask, /^CodeRabbit review/);
  tap(review(), label);
  const row = D.decisionRead(review());
  assert.equal(row.label, label);
  assert.match(row.label, /\$1\.25/);
});

test('LD21: free-slot and paid CodeRabbit rows never share a label or a position; a re-ask shows the same order', async () => {
  const L = await import(pathToFileURL(path.join(HERE, 'lib', 'checkpoint-ledger.mjs')).href);
  const option = (pathway) => ({ pathway, available: true, reason: `${pathway} reason` });
  const resultOf = (recommended, state) => ({ recommended, why: ['Critical file x.'], size: { files: 5, lines: 50 }, auto: { band: 'HIGH', eligible: false }, capacity: { state }, options: [option('coderabbit'), option('both'), option('wait'), option('none')] });
  const seen = [];
  for (const recommended of ['coderabbit', 'none']) {
    const at = {};
    for (const state of ['free', 'wait']) {
      const spec = L.askSpecOf(PR, resultOf(recommended, state), 'unknown.');
      const cr = spec.options.findIndex((o) => /^CodeRabbit (now|review)/.test(o.label));
      at[state] = { cr, label: spec.options[cr].label };
      assert.ok(spec.options.length <= 4);
      assert.equal(new Set(spec.options.map((o) => o.label)).size, spec.options.length, 'labels differ inside one question');
      assert.deepEqual(spec.options.map((o) => o.label), L.askSpecOf(PR, resultOf(recommended, state), 'unknown.').options.map((o) => o.label), 're-ask: same order');
      if (state === 'wait') assert.notEqual(spec.values[spec.options[0].label], 'coderabbit', `${recommended}: paid row is not row 0`);
      seen.push(spec.options.map((o) => o.label).join(' | '));
    }
    assert.notEqual(at.free.label, at.wait.label, `${recommended}: label`);
    assert.notEqual(at.free.cr, at.wait.cr, `${recommended}: position`);
  }
  const t = setup();
  const again = [t.call().ledger.ask, t.call().ledger.ask];
  assert.deepEqual(again[0].options.map((o) => o.label), again[1].options.map((o) => o.label), 'a second call re-asks with the same rows');
});

// Every text the engine, the status script and the land scripts build must send Dave to a tap, never to a typed command (Dave 2026-11-06).
// The scan skips comment lines: only code, so a string literal that says "Run /pathway" fails here.
test('LD16: no built text of the engine, status, router, ask, land and slot-queue files says "Run /pathway" or "/slot pay", "/slot drop" or "/slot wait"', () => {
  const files = ['pr-checkpoint.mjs', 'review-status.mjs', 'review-router.mjs', 'ship-ask.mjs', 'land-decision.mjs', 'land-pr.ps1', 'slot-queue.mjs', 'lib/checkpoint-ledger.mjs', 'lib/decisions.mjs'];
  const hits = [];
  for (const f of files) {
    readFileSync(path.join(HERE, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
      if (/run \/pathway|\/slot (pay|drop|wait)|type \/pathway/i.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
