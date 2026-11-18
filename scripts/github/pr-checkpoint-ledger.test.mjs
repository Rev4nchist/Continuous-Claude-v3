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
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
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

function setup({ ledger = true, labels = ['risk:high'], paths = FIVE, head = HEAD, config = {}, capacity = null } = {}) {
  const dir = makeTempDir('ledger-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  const factsAt = (now) => JSON.stringify({ head, now, stamp: STAMP(head), files: paths.map(file), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels, ...(capacity ? { capacity } : {}) });
  writeFileSync(factsFile, factsAt(NOW));
  writeFileSync(bodyFile, BODY_TEXT);
  const checkpoint = { ...LIVE.checkpoint, autoConfirm: false, ...(ledger === 'omit' ? {} : { ledger }) };
  if (ledger === 'omit') delete checkpoint.ledger;
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null }, checkpoint, ...config }));
  const storeFile = path.join(dir, 'decisions.json');
  process.env.CCV3_DECISIONS_FILE = storeFile;
  // PR_CHECKPOINT_TEST=1 is the test mode of --facts and --config (PR 1 taps, fixture guard). `mode.on = false` drops it and keeps the temp store.
  const mode = { on: true };
  const envOf = () => ({ ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir, CCV3_DECISIONS_FILE: storeFile, PR_CHECKPOINT_NO_PROBE: '1', ...(mode.on ? { PR_CHECKPOINT_TEST: '1' } : { PR_CHECKPOINT_TEST: '' }) });
  const run = (args) => spawnSync(process.execPath, [ENGINE, ...args, ...(args.includes('--confirm') ? ['--state-dir', state] : []), '--facts', factsFile, '--config', cfgFile], { encoding: 'utf8', cwd: dir, env: envOf() });
  // A drop run reads no facts and no config: only the store. It must never need --facts.
  const drop = (extra = ['--pr', String(PR)]) => spawnSync(process.execPath, [ENGINE, '--drop-taps', ...extra], { encoding: 'utf8', cwd: dir, env: envOf() });
  const call = (extra = []) => { const r = run(['--json', '--pr', String(PR), ...extra]); assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`); return JSON.parse(r.stdout); };
  const confirm = (pathway, by = 'dave', extra = ['--pr', String(PR)]) => run(['--confirm', pathway, '--by', by, '--body', bodyFile, ...extra]);
  const retime = (now) => writeFileSync(factsFile, factsAt(now));
  return { dir, call, confirm, retime, run, drop, mode, stateDir: state, pathwayFile: path.join(state, 'pathway.json'), storeFile };
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
  assert.match(s.options[1].label, /^CodeRabbit review \(may cost up to \$1\.25\) \(Recommended\)$/);
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
    recommended: 'both', why: ['Critical file x.'], size: { files: 5, lines: 50 }, auto: { band: 'CRITICAL', eligible: false }, capacity: { state: 'free', checkedAt: iso(NOW_MS - 60_000) },
    options: [option('coderabbit', true), option('both', false), option('wait', true), option('none', true)],
  };
  const spec = L.askSpecOf(PR, result, 'unknown.', NOW_MS);
  assert.equal(spec.options[0].label, 'Keep as draft ($0) (Recommended)');
  assert.equal(spec.values[spec.options[0].label], 'wait');
  assert.equal(spec.options.filter((o) => o.label.endsWith(' (Recommended)')).length, 1, 'one Recommended row');
  assert.match(spec.question, /Recommended: Keep as draft/);
  assert.doesNotMatch(spec.question, /Recommended: CodeRabbit \+ Greptile/);
  assert.ok(spec.options.length <= 4 && spec.question.split('\n').length <= 3);
  const open = { ...result, options: [option('coderabbit', true), option('both', true), option('wait', true), option('none', true)] };
  const openSpec = L.askSpecOf(PR, open, 'unknown.', NOW_MS);
  assert.deepEqual(openSpec.options.map((o) => o.label), ['Keep as draft ($0)', 'CodeRabbit now (free slot, $0)', 'CodeRabbit + Greptile (may cost up to $1.25 + 3 credits) (Recommended)', 'No review, land on CI ($0)'], 'Keep as draft leads, then the free-slot row, then the paid rows, then none');
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
//   the free-slot and the paid row share a label, or a re-ask shuffles the rows                                                     -> LD21
//   (the order of card prflow-review-pick puts both CodeRabbit rows after Keep as draft, so they share a position: the label tells them apart)
const PAID_PATHWAYS = ['coderabbit', 'both'];
const pathwayAt = (triple, spec, i) => D.offerRead(triple).spec.values[spec.options[i].label];

test('LD17: HIGH fixture: one question; every paid row carries its price; row 0 is no paid row; the question names the recommendation', () => {
  const t = setup();
  const { ledger } = t.call();
  const spec = ledger.ask;
  const paidRows = spec.options.filter((_, i) => PAID_PATHWAYS.includes(pathwayAt(review(), spec, i)));
  assert.ok(paidRows.length > 0, 'the fixture offers a paid row');
  for (const row of paidRows) assert.match(row.label, /\(may cost up to \$1\.25/);
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

const L = await import(pathToFileURL(path.join(HERE, 'lib', 'checkpoint-ledger.mjs')).href);
const ROW0 = /\(\$0\)( \(Recommended\))?$/;

test('LD21: free-slot and paid CodeRabbit rows never share a label; the free-slot row is $0 and sits after Keep as draft; a re-ask shows the same order', () => {
  const option = (pathway) => ({ pathway, available: true, reason: `${pathway} reason` });
  const resultOf = (recommended, state) => ({ recommended, why: ['Critical file x.'], size: { files: 5, lines: 50 }, auto: { band: 'HIGH', eligible: false }, capacity: { state, checkedAt: iso(NOW_MS - 60_000), nextSlotAt: iso(NOW_MS + 600_000) }, options: [option('coderabbit'), option('both'), option('wait'), option('none')] });
  for (const recommended of ['coderabbit', 'none']) {
    const at = {};
    for (const state of ['free', 'wait']) {
      const spec = L.askSpecOf(PR, resultOf(recommended, state), 'unknown.', NOW_MS);
      const labels = spec.options.map((o) => o.label);
      const cr = labels.findIndex((l) => /^CodeRabbit (now|review)/.test(l));
      at[state] = { cr, label: labels[cr] };
      assert.ok(labels.length <= 4);
      assert.equal(new Set(labels).size, labels.length, 'labels differ inside one question');
      assert.deepEqual(labels, L.askSpecOf(PR, resultOf(recommended, state), 'unknown.', NOW_MS).options.map((o) => o.label), 're-ask: same order');
      assert.match(labels[0], ROW0, `${recommended}/${state}: row 0 is a $0 row`);
      assert.notEqual(spec.values[labels[0]], 'coderabbit', `${recommended}/${state}: the CodeRabbit row is not row 0`);
    }
    assert.notEqual(at.free.label, at.wait.label, `${recommended}: label`);
    assert.ok(at.free.cr > 0 && at.free.label.includes('$0'), `${recommended}: the free-slot row is $0 and not row 0`);
    const freeLabels = L.askSpecOf(PR, resultOf(recommended, 'free'), 'x', NOW_MS).options.map((o) => o.label);
    assert.match(freeLabels[at.free.cr - 1], /^Keep as draft/, `${recommended}: Keep as draft sits right before the free-slot row`);
  }
  const t = setup();
  const again = [t.call().ledger.ask, t.call().ledger.ask];
  assert.deepEqual(again[0].options.map((o) => o.label), again[1].options.map((o) => o.label), 'a second call re-asks with the same rows');
});

// ---- the freshness rule and the second look at call 2 (card prflow-review-pick) ------------------------------------------------------
// The engine reads the CodeRabbit slot by the same rule as the mod (model.ts slotOf), at the time of the call. How it can fail:
//   a free fact older than 5 minutes, or with no readable checkedAt, still prints the $0 row                                      -> LD22
//   the order of the rows differs for the same fact, so row 0 is a paid row or the free row leads Keep as draft                    -> LD22
//   call 2 records a tap on a label that is no row of the question as it stands now (the slot went)                               -> LD23, LD24
//   the stale tap is not used up, or the re-ask is counted as a miss, or --confirm accepts it                                    -> LD23, LD24
const FRESH_FREE = { state: 'free', checkedAt: iso(NOW_MS - 60_000) };
const SLOT_NOTE = 'The CodeRabbit slot changed. Your tap was not recorded.';
const resultFor = (capacity, recommended) => ({
  recommended, why: ['Critical file x.'], size: { files: 5, lines: 50 }, auto: { band: 'HIGH', eligible: false }, capacity,
  options: ['none', 'coderabbit', 'both', 'wait'].map((pathway) => ({ pathway, available: true, reason: `${pathway} reason` })),
});

test('LD22: recommendation x slot fact: the rows and their order follow the fact read at the time of the call; row 0 is always a $0 row', () => {
  const free = 'CodeRabbit now (free slot, $0)';
  const paid = 'CodeRabbit review (may cost up to $1.25)';
  const both = 'CodeRabbit + Greptile (may cost up to $1.25 + 3 credits)';
  const facts = [
    ['free, checked 1 min ago', FRESH_FREE, free],
    ['free, checked 10 min ago', { state: 'free', checkedAt: iso(NOW_MS - 600_000) }, paid],
    ['free, no checkedAt', { state: 'free' }, paid],
    ['free, checkedAt unreadable', { state: 'free', checkedAt: 'soon' }, paid],
    ['free, checked 30 s ahead (clock skew)', { state: 'free', checkedAt: iso(NOW_MS + 30_000) }, free],
    ['free, checked 2 min ahead', { state: 'free', checkedAt: iso(NOW_MS + 120_000) }, paid],
    ['wait, next slot passed', { state: 'wait', checkedAt: iso(NOW_MS - 600_000), nextSlotAt: iso(NOW_MS - 60_000) }, paid],
    ['wait, next slot ahead', { state: 'wait', checkedAt: iso(NOW_MS - 60_000), nextSlotAt: iso(NOW_MS + 600_000) }, paid],
    ['unknown', { state: 'unknown' }, paid],
  ];
  for (const rec of ['coderabbit', 'none']) {
    for (const [name, capacity, crLabel] of facts) {
      const labels = L.askSpecOf(PR, resultFor(capacity, rec), 'x', NOW_MS).options.map((o) => o.label);
      const mark = (l, p) => (p === rec ? `${l} (Recommended)` : l);
      const expected = rec === 'none'
        ? [mark('No review, land on CI ($0)', 'none'), 'Keep as draft ($0)', crLabel, both]
        : ['Keep as draft ($0)', mark(crLabel, 'coderabbit'), both, 'No review, land on CI ($0)'];
      assert.deepEqual(labels, expected, `rec ${rec}, ${name}`);
    }
  }
});

test('LD22b: slotStateOf mirrors the mod rule: free ages out after 5 minutes, a wait whose slot passed is unknown, a wait with no slot time ages like free', () => {
  const at = (cap) => L.slotStateOf(cap, NOW_MS);
  assert.equal(at({ state: 'free', checkedAt: iso(NOW_MS - 300_000) }), 'free', 'exactly 5 minutes is still fresh');
  assert.equal(at({ state: 'free', checkedAt: iso(NOW_MS - 300_001) }), 'unknown');
  assert.equal(at({ state: 'free' }), 'unknown');
  assert.equal(at({ state: 'free', checkedAt: 'x' }), 'unknown');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS - 900_000), nextSlotAt: iso(NOW_MS + 1) }), 'wait');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS - 900_000), nextSlotAt: iso(NOW_MS) }), 'unknown', 'a slot time equal to now has passed');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS - 60_000) }), 'wait', 'no slot time, fresh');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS - 600_000) }), 'unknown', 'no slot time, old');
  // A checkedAt in the future is clock skew up to 1 minute; beyond that the fact cannot be trusted and fails closed (unknown, so paid).
  assert.equal(at({ state: 'free', checkedAt: iso(NOW_MS + 60_000) }), 'free', '1 minute ahead is skew');
  assert.equal(at({ state: 'free', checkedAt: iso(NOW_MS + 60_001) }), 'unknown', 'more than 1 minute ahead is stale');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS + 120_000) }), 'unknown', 'a wait with no slot time and a far-future checkedAt');
  assert.equal(at({ state: 'wait', checkedAt: iso(NOW_MS + 120_000), nextSlotAt: iso(NOW_MS + 600_000) }), 'wait', 'a wait with a slot time ahead does not read checkedAt');
  assert.equal(at({ state: 'maybe' }), 'unknown');
  assert.equal(at(undefined), 'unknown');
  assert.equal(L.slotStateOf({ state: 'free' }, null), 'free', 'a null clock reads the fact as printed, as the mod does');
});

test('LD23: call 2 after the slot went: the tap on the free-slot row is used up, nothing is recorded, the question is asked again with the new rows', () => {
  const free = 'CodeRabbit now (free slot, $0) (Recommended)';
  const paid = 'CodeRabbit review (may cost up to $1.25) (Recommended)';
  const t = setup({ capacity: FRESH_FREE });
  const first = t.call().ledger;
  assert.equal(first.state, 'ask');
  assert.deepEqual(first.ask.options.map((o) => o.label), ['Keep as draft ($0)', free, 'No review, land on CI ($0)']);
  tap(review(), free);
  t.retime(iso(NOW_MS + 600_000));
  // --confirm at the later time: the label is no row of the question now, so it is refused and nothing is written.
  const late = t.confirm('coderabbit');
  assert.equal(late.status, 1, `${late.stdout} ${late.stderr}`);
  assert.ok(!existsSync(t.pathwayFile));
  const second = t.call().ledger;
  assert.deepEqual([second.state, second.reasked], ['ask', 0], 'asked again, and the re-ask is no miss');
  assert.equal(second.note, SLOT_NOTE, 'the re-ask says why');
  assert.ok(second.text.includes(SLOT_NOTE), 'the text field carries the note');
  assert.ok(!('note' in first) && !first.text.includes(SLOT_NOTE), 'a normal first ask has no such line');
  assert.deepEqual(second.ask.options.map((o) => o.label), ['Keep as draft ($0)', paid, 'No review, land on CI ($0)']);
  assert.equal(D.decisionRead(review()), null, 'the stale tap is used up');
  assert.equal(D.offerRead(review()).open, true);
  assert.deepEqual(D.offerRead(review()).labels, second.ask.options.map((o) => o.label));
  assert.equal(D.missCount(review()), 0);
  assert.ok(!existsSync(t.pathwayFile), 'nothing was recorded');
  tap(review(), paid);
  const third = t.call().ledger;
  assert.deepEqual([third.state, third.pathway, third.by], ['record', 'coderabbit', 'dave'], 'a tap on the row as it stands is the paid yes');
  assert.equal(t.confirm('coderabbit').status, 0);
});

test('LD23b: with the slot unchanged the same tap records; Keep as draft stays kept when the slot went', () => {
  const same = setup({ capacity: FRESH_FREE });
  tap(review(), same.call().ledger.ask.options[1].label);
  same.retime(iso(NOW_MS + 120_000));
  assert.equal(same.call().ledger.state, 'record', 'still fresh 2 minutes later');
  const kept = setup({ capacity: FRESH_FREE });
  tap(review(), labelOf(kept.call().ledger.ask, /^Keep as draft/));
  kept.retime(iso(NOW_MS + 600_000));
  assert.equal(kept.call().ledger.state, 'kept-draft', 'Keep as draft records nothing, so a changed slot does not undo it');
});

test('LD24: ledgerConfirmProblem refuses a tap whose label is no row of the question as it stands; with no result it checks the tap only; --by auto is untouched', () => {
  setup();
  const result = resultFor(FRESH_FREE, 'coderabbit');
  const spec = L.askSpecOf(PR, result, 'x', NOW_MS);
  assert.equal(D.offerWrite({ ...review(), spec, tree: null, cwd: '/x' }).ok, true);
  const free = spec.options.find((o) => /^CodeRabbit now/.test(o.label)).label;
  tap(review(), free);
  const problem = (extra) => L.ledgerConfirmProblem({ pr: PR, head: HEAD, pathway: 'coderabbit', by: 'dave', ...extra });
  assert.equal(problem({}), null, 'old call shape: the tap decides');
  assert.equal(problem({ result, now: NOW_MS + 60_000 }), null, 'the label is still a row');
  assert.match(problem({ result, now: NOW_MS + 600_000 }), /no longer a row/);
  assert.equal(L.ledgerConfirmProblem({ pr: PR, head: HEAD, pathway: 'none', by: 'auto', result, now: NOW_MS + 600_000 }), null);
  assert.equal(D.decisionRead(review()).label, free, 'a refusal does not use the tap up');
});

test('LD25: the slot line of the question is built from the clocked slot state: a stale free fact never prints "free now" beside a paid row', () => {
  const slotLineOf = (capacity, nowMs) => {
    const t = setup({ capacity });
    t.retime(iso(nowMs));
    const ask = t.call().ledger.ask;
    return { line: ask.question.split('\n')[2], labels: ask.options.map((o) => o.label) };
  };
  const fresh = slotLineOf(FRESH_FREE, NOW_MS);
  assert.match(fresh.line, /^CodeRabbit slot: free now/);
  assert.ok(fresh.labels.some((l) => /^CodeRabbit now \(free slot/.test(l)));
  const stale = slotLineOf(FRESH_FREE, NOW_MS + 600_000);
  assert.match(stale.line, /^CodeRabbit slot: unknown/, stale.line);
  assert.ok(stale.labels.some((l) => /^CodeRabbit review \(may cost/.test(l)) && !stale.labels.some((l) => /free slot/.test(l)));
  const passed = slotLineOf({ state: 'wait', checkedAt: iso(NOW_MS - 600_000), nextSlotAt: iso(NOW_MS - 60_000), minutesToSlot: 3 }, NOW_MS);
  assert.match(passed.line, /^CodeRabbit slot: unknown/, 'a wait whose slot passed is unknown too');
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

// ---- PR 1 "taps" of card prflow-paid-run-guard ----------------------------------------------------------------------------------------
// A stored tap must not record after the PR went back to draft (A), a failed tap consume must not let a second confirm write (B), and a fixture
// run outside test mode must not write the real store (F). Every A test STORES a tap, unlike X4 of the mod tests. How it can fail:
//   the drop verb is missing, or leaves a tap, an offer or a miss of the PR (any head, either step)                                -> A1, A2, A3
//   the drop deletes the rows of another PR (349 against 3490) or of another step                                                  -> A3
//   a tap made after the drop is not read                                                                                         -> A4
//   a failed drop (store locked) exits 0 or says nothing                                                                          -> A5
//   a tap older than --repick-since records, a bad value passes it, or a newer tap is refused                                     -> A6
//   --confirm writes the record before the tap is used up, or ignores a failed consume                                             -> B1, B2, B3, B4
//   a record that throws after the consume leaves the tap, so the next confirm writes again                                      -> B4
//   the happy path, or --by auto, changes                                                                                         -> B5, B6
//   --facts or --config writes the store outside test mode, or the guard blocks a run that writes nothing                           -> F1, F2
//   the miss window of a stop restarts; the re-ask note names the wrong cause; the held recommendation is marked in one copy only    -> m6, m7, m5
const STALE_NOTE = 'The PR went back to draft. Your earlier tap was not recorded.';
const QUESTION_NOTE = 'The question changed. Your tap was not recorded.';
const holdLock = (t) => writeFileSync(`${t.storeFile}.lock`, `${process.pid} held-by-test`);
const freeLock = (t) => unlinkSync(`${t.storeFile}.lock`);
const paidTap = (t) => { const label = labelOf(t.call().ledger.ask, /^CodeRabbit review/); tap(review(), label); return label; };
const anOffer = { header: 'h', question: 'q', options: [{ label: 'a' }, { label: 'b' }], values: { a: 'none', b: 'wait' } };

test('A1: a tap at the head, a return to draft, call 1 at the same head: the drop ran, so the question is asked (it recorded before)', () => {
  const t = setup();
  paidTap(t);
  const dropped = t.drop();
  assert.equal(dropped.status, 0, `${dropped.stdout} ${dropped.stderr}`);
  assert.equal(D.decisionRead(review()), null, 'the tap is gone');
  const out = t.call().ledger;
  assert.deepEqual([out.state, out.reasked], ['ask', 0], 'asked afresh, no miss');
});

test('A2: a tap, a return to draft, then a direct --confirm --by dave with no flag is refused "No tap" and writes nothing', () => {
  const t = setup();
  paidTap(t);
  assert.equal(t.drop().status, 0);
  const r = t.confirm('coderabbit');
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`);
  assert.match(r.stderr, /No tap of Dave's for coderabbit/);
  assert.ok(!existsSync(t.pathwayFile));
});

test('A3: the drop removes decisions, offers and misses of review and paid-round for this PR at every head, and nothing else', () => {
  const t = setup();
  const seed = (triple, label) => { assert.equal(D.offerWrite({ ...triple, spec: anOffer, tree: null, cwd: '/x' }).ok, true); if (label) tap(triple, label); };
  const paidRound = (key, head = HEAD) => ({ step: 'paid-round', key, head });
  const other = `${DEFAULT_REPO}#${PR}0`; // a prefix match would drop it
  seed(review(), 'a');
  seed(review(OLD), 'a');
  seed(paidRound(KEY), 'a');
  seed(paidRound(KEY, OLD));
  assert.equal(D.missBump(review()), 1);
  assert.equal(D.missBump(paidRound(KEY)), 1);
  seed({ ...review(), key: other }, 'a');
  seed({ step: 'land', key: KEY, head: HEAD }, 'a');
  const r = t.drop();
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  for (const triple of [review(), review(OLD), paidRound(KEY), paidRound(KEY, OLD)]) {
    assert.deepEqual([D.decisionRead(triple), D.offerRead(triple), D.missCount(triple)], [null, null, 0], JSON.stringify(triple));
  }
  assert.ok(D.decisionRead({ ...review(), key: other }), 'another PR keeps its tap');
  assert.ok(D.decisionRead({ step: 'land', key: KEY, head: HEAD }), 'another step keeps its tap');
});

test('A4: Dave taps again after the return: call 2 records the new tap, and --confirm writes the record', () => {
  const t = setup();
  paidTap(t);
  assert.equal(t.drop().status, 0);
  assert.equal(t.call().ledger.state, 'ask');
  tap(review(), labelOf(D.offerRead(review()).spec, /^CodeRabbit review/));
  const second = t.call().ledger;
  assert.deepEqual([second.state, second.pathway], ['record', 'coderabbit']);
  assert.equal(t.confirm('coderabbit').status, 0);
});

test('A5: the drop fails (the store is locked): exit 1 with the reason, the tap stays, and the verb works once the lock is free', () => {
  const t = setup();
  const label = paidTap(t);
  holdLock(t);
  const failed = t.drop();
  assert.equal(failed.status, 1, `${failed.stdout} ${failed.stderr}`);
  assert.match(failed.stderr, /refused: the taps of PR #349 could not be cleared \(lock\)/);
  assert.equal(D.decisionRead(review()).label, label, 'nothing was dropped');
  freeLock(t);
  assert.equal(t.drop().status, 0);
  assert.equal(D.decisionRead(review()), null);
});

test('A5b: --drop-taps needs a good --pr and no other mode, and it reads no facts', () => {
  const t = setup();
  assert.equal(t.drop([]).status, 2, 'no --pr');
  assert.equal(t.drop(['--pr', '0']).status, 2, 'a bad PR number');
  assert.equal(t.drop(['--pr', String(PR), '--confirm', 'none', '--by', 'dave', '--body', 'x']).status, 2, 'with --confirm');
  assert.equal(t.drop(['--pr', String(PR), '--json']).status, 2, 'with --json');
  assert.equal(t.drop(['--pr', String(PR)]).status, 0, 'a good call with no fixture flags');
});

test('A6: --repick-since: a tap made before it is used up and asked again (no miss); a newer tap records; a bad value is stale; --confirm refuses a stale tap', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  for (const [name, since, stale] of [['marker after the tap', future, true], ['bad value', 'not-a-date', true], ['marker before the tap', past, false]]) {
    const t = setup();
    const label = paidTap(t);
    if (stale) {
      const refused = t.confirm('coderabbit', 'dave', ['--pr', String(PR), '--repick-since', since]);
      assert.equal(refused.status, 1, `${name}: ${refused.stdout} ${refused.stderr}`);
      assert.ok(refused.stderr.includes(STALE_NOTE), name);
      assert.ok(!existsSync(t.pathwayFile), name);
      assert.equal(D.decisionRead(review()).label, label, `${name}: a refusal does not use the tap up`);
      const out = t.call(['--repick-since', since]).ledger;
      assert.deepEqual([out.state, out.reasked, out.note], ['ask', 0, STALE_NOTE], name);
      assert.ok(out.text.startsWith(STALE_NOTE), name);
      assert.equal(D.decisionRead(review()), null, `${name}: the stale tap is used up`);
      assert.equal(D.missCount(review()), 0, `${name}: no miss`);
    } else {
      assert.equal(t.call(['--repick-since', since]).ledger.state, 'record', name);
      assert.equal(t.confirm('coderabbit', 'dave', ['--pr', String(PR), '--repick-since', since]).status, 0, name);
    }
  }
});

test('B1: the lock is held when the tap is consumed: --confirm is refused, nothing is recorded, a second confirm is refused too, and the tap survives for the retry', () => {
  const t = setup();
  const label = paidTap(t);
  holdLock(t);
  for (const round of [1, 2]) {
    const r = t.confirm('coderabbit');
    assert.equal(r.status, 1, `round ${round}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /Dave's tap for coderabbit on PR #349 could not be used up \(lock\)\. Nothing was recorded\. Call pr_checkpoint \{pr\} again\./);
    assert.ok(!existsSync(t.pathwayFile), `round ${round}: no record`);
  }
  freeLock(t);
  assert.equal(D.decisionRead(review()).label, label, 'the refused confirms did not burn the tap');
  assert.equal(t.confirm('coderabbit').status, 0, 'one record once the lock is free');
  assert.equal(t.confirm('coderabbit').status, 1, 'and the tap is used up now');
});

test('B2 and B3: ledgerUse returns the result of the consume: label-changed (the new tap stays) when Dave tapped again in between, then no-decision when the tap is gone', () => {
  const t = setup();
  const label = paidTap(t);
  const check = L.ledgerConfirmCheck({ pr: PR, head: HEAD, pathway: 'coderabbit', by: 'dave' });
  assert.equal(check.problem, null);
  assert.equal(check.label, label, 'the check hands back the label it read');
  // B3: Dave answers a new question before the consume.
  assert.equal(D.offerWrite({ ...review(), spec: D.offerRead(review()).spec, tree: null, cwd: '/x' }).ok, true);
  const other = D.offerRead(review()).spec.options.find((o) => /^No review/.test(o.label)).label;
  tap(review(), other);
  assert.deepEqual(L.ledgerUse({ pr: PR, head: HEAD, label: check.label }), { ok: false, reason: 'label-changed' });
  assert.equal(D.decisionRead(review()).label, other, 'the new tap stays');
  // B2: nothing left to use.
  assert.deepEqual(L.ledgerUse({ pr: PR, head: HEAD, label: other }), { ok: true });
  assert.deepEqual(L.ledgerUse({ pr: PR, head: HEAD, label: other }), { ok: false, reason: 'no-decision' });
});

test('B4: the record write throws after the consume: no record and no tap, so the next confirm is refused "No tap"', () => {
  const t = setup();
  paidTap(t);
  mkdirSync(t.pathwayFile); // a folder where the record file goes: the write throws
  const broke = t.confirm('coderabbit');
  assert.notEqual(broke.status, 0, `${broke.stdout} ${broke.stderr}`);
  assert.equal(D.decisionRead(review()), null, 'the tap is used up');
  rmdirSync(t.pathwayFile);
  const again = t.confirm('coderabbit');
  assert.equal(again.status, 1, `${again.stdout} ${again.stderr}`);
  assert.match(again.stderr, /No tap of Dave's for coderabbit/);
  assert.ok(!existsSync(t.pathwayFile), 'no record at all');
});

test('B5: the happy path: one record by dave, the tap is used up, a second confirm is refused and the record stays', () => {
  const t = setup();
  paidTap(t);
  const r = t.confirm('coderabbit');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const record = readFileSync(t.pathwayFile, 'utf8');
  assert.equal(JSON.parse(record).decided_by, 'dave');
  assert.equal(D.decisionRead(review()), null);
  assert.equal(t.confirm('coderabbit').status, 1);
  assert.equal(readFileSync(t.pathwayFile, 'utf8'), record);
});

test('B6: --by auto is unchanged: it needs no tap, records, and still uses up a tap of the PR when one is there', () => {
  const t = setup({ paths: LOW, labels: [], config: { checkpoint: { ...LIVE.checkpoint, autoConfirm: 'low', ledger: true } } });
  assert.equal(D.offerWrite({ ...review(), spec: anOffer, tree: null, cwd: '/x' }).ok, true);
  tap(review(), 'a');
  const r = t.confirm('none', 'auto');
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(JSON.parse(readFileSync(t.pathwayFile, 'utf8')).decided_by, 'auto');
  assert.equal(D.decisionRead(review()), null, 'the old order: record, then use the tap up');
});

test('F1: a fixture run (--facts, --config) outside test mode writes no offer and no decision, and says why; a run that writes nothing still works', () => {
  const t = setup();
  const label = paidTap(t); // test mode on: the offer and the tap exist
  const before = readFileSync(t.storeFile, 'utf8');
  t.mode.on = false;
  for (const r of [t.run(['--json', '--pr', String(PR)]), t.confirm('coderabbit')]) {
    assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /refused: --facts and --config are for tests\. A live question reads GitHub\./);
  }
  assert.equal(readFileSync(t.storeFile, 'utf8'), before, 'the store is byte for byte the same');
  assert.equal(D.decisionRead(review()).label, label);
  assert.ok(!existsSync(t.pathwayFile));
  const quiet = t.run(['--json', '--pr', String(PR), '--no-ledger']);
  assert.equal(quiet.status, 0, `${quiet.stdout} ${quiet.stderr}`);
  const fresh = setup();
  fresh.mode.on = false;
  assert.equal(fresh.run(['--json', '--pr', String(PR)]).status, 1, 'a clean store gets no offer either');
  assert.deepEqual(D.offerList(), []);
});

test('F2: the same run in test mode works: it writes the offer', () => {
  const t = setup();
  assert.equal(t.call().ledger.state, 'ask');
  assert.equal(D.offerRead(review()).open, true);
});

test('m6: missBump keeps the first time once the count is above the re-asks, so the stop window does not restart', async () => {
  const t = setup();
  const atOf = () => JSON.parse(readFileSync(t.storeFile, 'utf8')).misses[`review\n${KEY}\n${HEAD}`].at;
  assert.deepEqual([D.missBump(review()), D.missBump(review()), D.missBump(review())], [1, 2, 3]);
  const stopAt = atOf();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(D.missBump(review()), 4);
  assert.equal(atOf(), stopAt, 'the window of the stop did not restart');
});

test('m7: the re-ask note names its cause: the slot, or the question (a tapped label that is no row for another reason)', () => {
  const free = 'CodeRabbit now (free slot, $0) (Recommended)';
  const t = setup({ capacity: FRESH_FREE });
  assert.equal(t.call().ledger.ask.options[1].label, free);
  tap(review(), free);
  t.retime(iso(NOW_MS + 600_000));
  assert.equal(t.call().ledger.note, SLOT_NOTE, 'the slot went');
  // A label that no slot state of the question can give: the question changed.
  const priced = setup();
  const odd = 'CodeRabbit review (may cost up to $0.75)';
  assert.equal(D.offerWrite({ ...review(), spec: { header: 'h', question: 'q', options: [{ label: odd }, { label: 'Keep as draft ($0)' }], values: { [odd]: 'coderabbit' } }, tree: null, cwd: '/x' }).ok, true);
  tap(review(), odd);
  const out = priced.call().ledger;
  assert.equal(out.state, 'ask');
  assert.equal(out.note, QUESTION_NOTE);
});

test('m5: with the recommendation held the engine marks Keep as draft (the mod copy does the same: checkpoint-two-copy)', () => {
  const option = (pathway, available) => ({ pathway, available, reason: `${pathway} reason` });
  const result = { recommended: 'both', why: ['x.'], size: { files: 5, lines: 50 }, auto: { band: 'HIGH', eligible: false }, capacity: { state: 'wait', checkedAt: iso(NOW_MS - 60_000), nextSlotAt: iso(NOW_MS + 600_000) }, options: [option('coderabbit', true), option('both', false), option('wait', true), option('none', true)] };
  const labels = L.askSpecOf(PR, result, 'x', NOW_MS).options.map((o) => o.label);
  assert.deepEqual(labels.filter((l) => l.endsWith(' (Recommended)')), ['Keep as draft ($0) (Recommended)']);
});
