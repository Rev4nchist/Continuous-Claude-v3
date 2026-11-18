// "No review, land on CI" at every band (Dave 2026-11-04). After #281 a HIGH PR still got only coderabbit and both, so `/pathway 281 none`
// printed "Pathway none is not available" and Dave pressed GitHub "Ready for review" by hand, and the router then added review labels.
// Run: node --test scripts/github/pr-checkpoint-no-review.test.mjs
//
// How it can fail, and the test that catches it:
//   the engine does not offer `none` for a HIGH or CRITICAL PR (pure band, or band plus a critical file)   -> N1, N2
//   `none` is the recommendation, or the first option, for HIGH or CRITICAL                                  -> N1, N2
//   `--confirm none --by dave` is refused for HIGH or CRITICAL                                              -> N3
//   `--by default` or `--by auto` records `none` for HIGH or CRITICAL (an agent or a timer self-records)    -> N4
//   the apply of a `none` record adds a bot label, or skips the marker, or does not mark ready             -> N5
//   the router adds a bot label to a PR that holds a recorded `none` for the head (label + marker)        -> R1
//   the router stops adding labels when there is no record, or the marker names an older head             -> R2
//   READY does not accept review:none with the router state pathway=none, or accepts it without the state -> S1
//   a bare review:none label (no /pathway marker for the head) saves pathway=none at HIGH or CRITICAL        -> G1, G2, G3, G4, G7
//   the gate blocks a legit pick (marker for the head), a PR below HIGH, or the workflow re-run               -> G5, G6, G8
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';

registerTempCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
// These tests cover the plain (flag off) confirm path. checkpoint.ledger is on in the live config (Dave 2026-11-07), so pin it off here; pr-checkpoint-ledger.test.mjs covers the flag on.
const LIVE = (() => { const c = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8')); c.checkpoint = { ...c.checkpoint, ledger: false }; return c; })();
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-11-04T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const BODY_TEXT = 'PR body\nwith an Evidence block\n';
const BODY_SHA = createHash('sha256').update(BODY_TEXT).digest('hex');
const STAMP = { head: HEAD, body_sha256: BODY_SHA, results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };

const file = (filename, additions = 10, deletions = 0) => ({ filename, additions, deletions });

// FIVE: five control-plane files, none of them a checkpoint.critical file, so the band rule is the only rule (HIGH).
const FIVE = ['scripts/github/cr-fix.mjs', 'scripts/github/pr-checkpoint.mjs', '.claude/plugins/x/hooks/pr-loop/a.ts', 'scripts/github/local-review/prompt.mjs', 'scripts/github/local-review/context.mjs'];
// GATE: critical files, so the band rule sits beside R3 (the second exit of the option order).
const GATE = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];
const LOW = ['apps/x/README.txt'];
const MID = ['apps/x/src/a.ts', 'apps/x/src/b.ts', 'apps/x/src/c.ts'];
const ELEVATED = ['scripts/github/cr-fix.mjs', 'scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs'];

const CASES = [
  ['HIGH (band rule only)', FIVE, [], 'HIGH'],
  ['HIGH (band rule and a critical file)', GATE, [], 'HIGH'],
  ['CRITICAL (band rule only, risk:high)', FIVE, ['risk:high'], 'CRITICAL'],
  ['CRITICAL (band rule and a critical file, risk:high)', GATE, ['risk:high'], 'CRITICAL'],
];
// Interim CodeRabbit rule (Dave 2026-11-04): HIGH without the risk:high label is recommended none; the risk:high cases keep CodeRabbit.
const RECOMMENDED = (labels) => (labels.includes('risk:high') ? 'coderabbit' : 'none');

const load = () => import('./pr-checkpoint.mjs');

async function policy() {
  const { pathFiltersFrom } = await load();
  return {
    ...LIVE, deep_enabled: false,
    greptile: { ...LIVE.greptile, credits_used_manual: null },
    coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null },
    path_filters: pathFiltersFrom(YAML),
  };
}
const factsFor = (paths, labels) => ({
  head: HEAD, now: NOW, stamp: STAMP, files: paths.map((p) => file(p)), cli: { bySeverity: { minor: 1 } }, dependabot: false, config_drift: false, labels,
});
async function recommendFor(paths, labels = []) {
  const { recommend } = await load();
  return recommend(factsFor(paths, labels), await policy());
}

test('N1: every band offers `none` as an open option; at HIGH and CRITICAL it is the recommendation (first) only without the CodeRabbit trigger, else last', async () => {
  for (const [name, paths, labels, band] of CASES) {
    const r = await recommendFor(paths, labels);
    assert.equal(r.band.band, band, name);
    const at = r.options.findIndex((o) => o.pathway === 'none');
    assert.equal(r.recommended, RECOMMENDED(labels), name);
    if (r.recommended === 'none') assert.equal(at, 0, `${name}: none is first when it is the recommendation`);
    else {
      assert.ok(at > 0, `${name}: none is offered and is not first (options: ${r.options.map((o) => o.pathway).join(', ')})`);
      assert.equal(at, r.options.length - 1, `${name}: none is last`);
    }
    assert.equal(r.options[at].available, true, name);
    assert.deepEqual(r.options[at].cost, [0, 0], name);
    assert.equal(r.options[at].label, 'review:none', name);
    assert.equal(r.options[0].pathway, r.recommended, `${name}: the recommendation stays first`);
    assert.ok(r.options.some((o) => o.pathway === 'coderabbit' && o.available), `${name}: CodeRabbit stays pressable`);
  }
  for (const [name, paths, band] of [['LOW', LOW, 'LOW'], ['MID', MID, 'MID'], ['ELEVATED', ELEVATED, 'ELEVATED']]) {
    const r = await recommendFor(paths);
    assert.equal(r.band.band, band);
    assert.ok(r.options.some((o) => o.pathway === 'none' && o.available), `${name} still offers none`);
  }
});

test('N2: the none option at HIGH and CRITICAL says what READY needs (CI and proof; the internal pass when a floor applies)', async () => {
  const plain = (await recommendFor(FIVE)).options.find((o) => o.pathway === 'none');
  assert.match(plain.reason, /No bot review/);
  const floor = (await recommendFor(GATE)).options.find((o) => o.pathway === 'none');
  assert.match(floor.reason, /aegis \+ critic/, 'a critical file keeps the internal-pass sentence');
});

// ---------- the CLI: --confirm ----------

function confirm(pathway, by, { paths, labels = [] }) {
  const dir = makeTempDir('checkpoint-noreview-');
  const state = path.join(dir, 'pre-pr');
  mkdirSync(state, { recursive: true });
  const factsFile = path.join(dir, 'facts.json');
  const cfgFile = path.join(dir, 'config.json');
  const bodyFile = path.join(dir, 'body.md');
  writeFileSync(factsFile, JSON.stringify(factsFor(paths, labels)));
  writeFileSync(bodyFile, BODY_TEXT);
  // The live config, kill switch as shipped: autoConfirm false. N4 also pins it TRUE, the worst case for a self-record.
  writeFileSync(cfgFile, JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null }, checkpoint: { ...LIVE.checkpoint, autoConfirm: true } }));
  const args = [path.join(HERE, 'pr-checkpoint.mjs'), '--confirm', pathway, '--by', by, '--body', bodyFile, '--state-dir', state, '--facts', factsFile, '--config', cfgFile];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dir, env: { ...process.env, PR_CHECKPOINT_TEST: '1', CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json'), GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir } });
  return { ...r, pathwayFile: path.join(state, 'pathway.json') };
}

test('N3: `--confirm none --by dave` records for HIGH and CRITICAL: label review:none, budget 0+0, decided_by dave', () => {
  for (const [name, paths, labels] of CASES) {
    const r = confirm('none', 'dave', { paths, labels });
    assert.equal(r.status, 0, `${name}: ${r.stdout} ${r.stderr}`);
    const rec = JSON.parse(readFileSync(r.pathwayFile, 'utf8'));
    assert.equal(rec.pathway, 'none', name);
    assert.equal(rec.label, 'review:none', name);
    assert.equal(rec.decided_by, 'dave', name);
    assert.deepEqual(rec.budget, [0, 0], name);
    assert.equal(rec.head, HEAD, name);
    assert.equal(rec.recommended, RECOMMENDED(labels), name);
  }
});

test('N4: `--by default` and `--by auto` cannot record `none` for HIGH or CRITICAL, even with autoConfirm true; nothing is written', () => {
  for (const [name, paths, labels] of CASES) {
    for (const by of ['default', 'auto']) {
      const r = confirm('none', by, { paths, labels });
      assert.equal(r.status, 1, `${name} --by ${by}: ${r.stdout} ${r.stderr}`);
      // none is the recommendation at HIGH without risk:high (interim rule), so the default pick is refused by its own rule: only Dave records none here.
      assert.match(r.stderr, by === 'default' ? /--by default (needs the recommended pathway|cannot record none at)/ : /--by auto is not allowed here/, `${name} --by ${by}`);
      assert.ok(!existsSync(r.pathwayFile), `${name} --by ${by}: no pathway.json`);
    }
  }
});

test('N5: applying a none record adds review:none only, posts the marker for the head, then marks the PR ready', async () => {
  const { applyPathway } = await load();
  const record = { head: HEAD, body_sha256: BODY_SHA, pathway: 'none', label: 'review:none', class: 'steering', recommended: 'coderabbit', decided_by: 'dave', at: NOW, budget: [0, 0] };
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ isDraft: true, headRefOid: HEAD }), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(applyPathway({ pr: 281, record, gh }), { ok: true });
  const labels = calls.filter((a) => a.includes('--add-label')).map((a) => a[a.indexOf('--add-label') + 1]);
  assert.deepEqual(labels, ['review:none'], 'no bot label');
  const note = calls.find((a) => a[1] === 'comment');
  assert.match(note[note.indexOf('--body') + 1], new RegExp(`^<!-- pathway-confirmed head=${HEAD} pathway=none -->`));
  assert.equal(calls.at(-1)[1], 'ready', 'ready is last');
});

// ---------- the router and READY: a recorded none is honoured ----------

const router = () => import('./review-router.mjs');
const status = () => import('./review-status.mjs');

const MARKER = (head, pathway = 'none') => `<!-- pathway-confirmed head=${head} pathway=${pathway} -->\nCheckpoint: ${pathway} at ${head.slice(0, 7)}, chosen in /pathway.`;
const comment = (id, body, association = 'OWNER') => ({ id, body, author_association: association, user: { login: 'Rev4nchist', type: 'User' } });
const pr = () => ({ number: 281, head: HEAD, draft: false, state: 'open', paths: GATE, files: GATE.map((p) => file(p)), codeRabbitRateLimited: false });
const BOT_LABELS = ['review:coderabbit', 'review:deep', 'review:deep-held'];

test('R1: ready_for_review with a recorded none for this head (review:none label + marker) adds no bot label and saves pathway none', async () => {
  const { decide, confirmedMarkers } = await router();
  const confirmed = confirmedMarkers([comment(11, MARKER(HEAD))], HEAD, null);
  assert.deepEqual(confirmed.map((m) => m.pathway), ['none']);
  const d = decide('ready_for_review', pr(), ['review:none', 'builder:claude'], null, LIVE, { now: new Date(NOW), confirmed });
  assert.equal(d.reason, 'person_override');
  assert.deepEqual(d.add.filter((l) => BOT_LABELS.includes(l)), [], `added: ${d.add.join(', ')}`);
  assert.equal(d.pathway, 'none');
  assert.ok(d.pclass, 'pclass saved, so READY can accept review:none');
  assert.equal(d.held, null, 'no hold note either');
});

test('R2: with no record, or a marker for an older head, the router still adds the review labels', async () => {
  const { decide, confirmedMarkers } = await router();
  const none = decide('ready_for_review', pr(), ['builder:claude'], null, LIVE, { now: new Date(NOW), confirmed: [] });
  assert.equal(none.reason, 'routed');
  assert.ok(none.add.some((l) => BOT_LABELS.includes(l)), `added: ${none.add.join(', ')}`);
  const old = confirmedMarkers([comment(11, MARKER(OLD_HEAD))], HEAD, null);
  assert.deepEqual(old, [], 'a marker for another head never counts');
  const stale = decide('ready_for_review', pr(), ['builder:claude'], null, LIVE, { now: new Date(NOW), confirmed: old });
  assert.ok(stale.add.some((l) => BOT_LABELS.includes(l)), `added: ${stale.add.join(', ')}`);
  const stranger = confirmedMarkers([comment(12, MARKER(HEAD), 'NONE')], HEAD, null);
  assert.deepEqual(stranger, [], 'a marker from a non-collaborator never counts');
});

const routerComment = (state) => ({ id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `<!-- review-router -->\n<!-- review-router-state ${state} -->\nNo open router notes.` });

test('S1: READY accepts review:none when the router saved pathway=none for the head, and refuses it without that state', async () => {
  const { verifiedBots, NONE_NO_CHECKPOINT_NOTE } = await status();
  const labels = ['review:none', 'risk:steering'];
  const saved = [routerComment(`class=steering head=${HEAD} pathway=none pclass=steering`)];
  const ok = verifiedBots(labels, saved, HEAD);
  assert.equal(ok.greptile, false);
  assert.equal(ok.coderabbit, false);
  assert.deepEqual(ok.blockers, []);
  const unsaved = verifiedBots(labels, [routerComment(`class=steering head=${HEAD}`)], HEAD);
  assert.deepEqual(unsaved.blockers, [NONE_NO_CHECKPOINT_NOTE], 'a bare review:none label is not a record');
  const older = verifiedBots(labels, [routerComment(`class=steering head=${OLD_HEAD} pathway=none pclass=steering`)], HEAD);
  assert.equal(older.blockers.length, 1, 'a record for an older head does not count');
});

// ---------- self-approve: a bare review:none label at HIGH or CRITICAL saves no checkpoint ----------
// Dave's lane agent-self-approve-hole (2026-11-03): DETECT. At HIGH and CRITICAL the router saves pathway none only when a fresh
// pathway-confirmed marker for the head names none. READY then gives NONE_NO_CHECKPOINT_NOTE for a bare label.

const NONE_LABELS = ['review:none', 'builder:claude'];
const run = async (event, labels, over = {}, opts = {}) => {
  const { decide } = await router();
  return decide(event, { ...pr(), ...over }, labels, over.previousClass ?? null, LIVE, { now: new Date(NOW), ...opts });
};
const markers = async (...cs) => (await router()).confirmedMarkers(cs, HEAD, null);

test('G1: HIGH first run with review:none and no marker saves no pathway and writes the unconfirmed note', async () => {
  const { NONE_UNCONFIRMED_NOTE, NONE_BAND_RAISED_NOTE } = await router();
  assert.equal(typeof NONE_UNCONFIRMED_NOTE, 'string', 'the router exports the note');
  for (const note of [NONE_UNCONFIRMED_NOTE, NONE_BAND_RAISED_NOTE]) {
    assert.match(note, /Call pr_checkpoint \{pr\}/, 'the note sends the model to the tool, then a tap');
    assert.doesNotMatch(note, /\/pathway|\/slot/, 'the note names no typed command');
  }
  const d = await run('ready_for_review', NONE_LABELS);
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.pathway, null);
  assert.equal(d.pclass, null);
  assert.ok(d.comment?.includes(NONE_UNCONFIRMED_NOTE), `comment: ${d.comment}`);
});

test('G2: CRITICAL (risk:high) first run with review:none and no marker saves no pathway', async () => {
  const { NONE_UNCONFIRMED_NOTE } = await router();
  const d = await run('ready_for_review', [...NONE_LABELS, 'risk:high']);
  assert.equal(d.band.band, 'CRITICAL');
  assert.equal(d.pathway, null);
  assert.ok(d.comment?.includes(NONE_UNCONFIRMED_NOTE), `comment: ${d.comment}`);
});

test('G3: a swap from review:coderabbit to review:none at HIGH on synchronize keeps pathway coderabbit', async () => {
  const d = await run('synchronize', NONE_LABELS, { previousClass: 'infra' }, { previousPathway: 'coderabbit', previousPclass: 'infra' });
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.pathway, 'coderabbit');
  assert.equal(d.pclass, 'infra');
});

test('G4: a marker that names coderabbit does not let review:none save at HIGH', async () => {
  const confirmed = await markers(comment(11, MARKER(HEAD, 'coderabbit')));
  assert.deepEqual(confirmed.map((m) => m.pathway), ['coderabbit']);
  const d = await run('ready_for_review', NONE_LABELS, {}, { confirmed });
  assert.equal(d.pathway, null);
});

test('G5: HIGH ready_for_review with a fresh none marker for the head saves pathway none and consumes the marker', async () => {
  const confirmed = await markers(comment(11, MARKER(HEAD)));
  const d = await run('ready_for_review', NONE_LABELS, {}, { confirmed });
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.pathway, 'none');
  assert.ok(d.pclass);
  assert.equal(d.consumed, 11);
  assert.ok(!(d.comment ?? '').includes('no pathway confirmation'), 'no unconfirmed note for a legit pick');
});

test('G6: ELEVATED first run with review:none and no marker still saves pathway none', async () => {
  const d = await run('ready_for_review', NONE_LABELS, { paths: ELEVATED, files: ELEVATED.map((p) => file(p)) });
  assert.equal(d.band.band, 'ELEVATED');
  assert.equal(d.pathway, 'none');
});

test('G8: HIGH first run on synchronize (the workflow re-run) with a fresh none marker for the head saves pathway none', async () => {
  const confirmed = await markers(comment(11, MARKER(HEAD)));
  const d = await run('synchronize', NONE_LABELS, {}, { confirmed });
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.pathway, 'none');
  assert.equal(d.consumed, null, 'only a ready_for_review uses the marker up');
});

test('G7: verifiedBots gives NONE_NO_CHECKPOINT_NOTE for the comment a gated run renders', async () => {
  const { renderComment } = await router();
  const { verifiedBots, NONE_NO_CHECKPOINT_NOTE } = await status();
  const d = await run('ready_for_review', NONE_LABELS);
  const body = renderComment(d.comment ?? 'No open router notes.', d.effective, d.head, d.held, { pathway: d.pathway, pclass: d.pclass, consumed: d.consumed });
  const bot = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body };
  assert.deepEqual(verifiedBots(['review:none'], [bot], HEAD).blockers, [NONE_NO_CHECKPOINT_NOTE]);
});

// ---------- fix round 2 (aegis M1, M2, m4; critic major) ----------

test('G9: after a gated first run (class saved, no pclass), the draft-then-/pathway recovery saves pathway none with a fresh none marker', async () => {
  const first = await run('ready_for_review', NONE_LABELS);
  assert.equal(first.pathway, null);
  const confirmed = await markers(comment(11, MARKER(HEAD)));
  const d = await run('ready_for_review', NONE_LABELS, { previousClass: first.class }, { confirmed, previousPathway: null, previousPclass: null });
  assert.equal(d.band.band, 'HIGH');
  assert.equal(d.pathway, 'none');
  assert.equal(d.pclass, d.effective, 'a confirmed ready event is a new checkpoint at the current class');
  assert.equal(d.consumed, 11);
  const bare = await run('synchronize', NONE_LABELS, { previousClass: first.class }, { previousPathway: null, previousPclass: null });
  assert.equal(bare.pathway, null, 'without the marker the same state still saves nothing');
});

test('G10: pathway none saved bare at ELEVATED, then a push makes the band HIGH: the pathway stays and the router says the band rose', async () => {
  const { NONE_BAND_RAISED_NOTE } = await router();
  assert.equal(typeof NONE_BAND_RAISED_NOTE, 'string', 'the router exports the note');
  const first = await run('ready_for_review', NONE_LABELS, { paths: ELEVATED, files: ELEVATED.map((p) => file(p)) });
  assert.equal(first.band.band, 'ELEVATED');
  assert.equal(first.pathway, 'none');
  assert.equal(first.consumed, null);
  const later = await run('synchronize', NONE_LABELS, { previousClass: first.class }, { previousPathway: 'none', previousPclass: first.pclass, previousConsumed: null });
  assert.equal(later.band.band, 'HIGH');
  assert.equal(later.pathway, 'none', 'no auto-change of the saved pathway');
  assert.ok(later.comment?.includes(NONE_BAND_RAISED_NOTE), `comment: ${later.comment}`);
});

test('G11: a none that was confirmed by a marker at HIGH raises no band note on a later push', async () => {
  const { NONE_BAND_RAISED_NOTE } = await router();
  const confirmed = await markers(comment(11, MARKER(HEAD)));
  const first = await run('ready_for_review', NONE_LABELS, {}, { confirmed });
  assert.equal(first.consumed, 11);
  const later = await run('synchronize', NONE_LABELS, { previousClass: first.class }, { previousPathway: 'none', previousPclass: first.pclass, previousConsumed: 11 });
  assert.equal(later.pathway, 'none');
  assert.ok(!(later.comment ?? '').includes(NONE_BAND_RAISED_NOTE));
});

test('G12: land-none-check.mjs is a control-plane gate file, a security-tier file and a checkpoint.critical file, beside land-recheck.mjs', async () => {
  const { bandOf } = await router();
  const gate = 'scripts/github/land-none-check.mjs';
  const b = bandOf([gate], LIVE);
  assert.deepEqual(b.gateFiles, [gate]);
  assert.deepEqual(b.securityTier, [gate]);
  assert.ok(LIVE.checkpoint.critical.includes(gate));
  assert.ok(LIVE.matrix.control_plane.includes('scripts/github/land-recheck.mjs'));
});

test('S2: a lone risk:docs is no-bot only when the router classed this head as docs; a higher saved class keeps a bot required with a reason', async () => {
  const { verifiedBots } = await status();
  const docs = verifiedBots(['risk:docs'], [routerComment(`class=docs head=${HEAD}`)], HEAD);
  assert.equal(docs.greptile, false);
  assert.equal(docs.coderabbit, false);
  assert.equal(docs.unverified, undefined);
  const swapped = verifiedBots(['risk:docs'], [routerComment(`class=infra head=${HEAD}`)], HEAD);
  assert.ok(swapped.greptile || swapped.coderabbit, 'a bot is required again');
  assert.match(swapped.unverified, /risk:docs/);
  const off = verifiedBots(['risk:docs'], [routerComment(`class=infra head=${HEAD}`)], HEAD, false);
  assert.equal(off.coderabbit, true, 'with Greptile off the fallback is CodeRabbit');
});
