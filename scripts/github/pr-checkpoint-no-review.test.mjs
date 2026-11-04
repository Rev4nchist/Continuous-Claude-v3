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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
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

test('N1: every band offers `none` as an open option; at HIGH and CRITICAL it is never first and never the recommendation', async () => {
  for (const [name, paths, labels, band] of CASES) {
    const r = await recommendFor(paths, labels);
    assert.equal(r.band.band, band, name);
    const at = r.options.findIndex((o) => o.pathway === 'none');
    assert.ok(at > 0, `${name}: none is offered and is not first (options: ${r.options.map((o) => o.pathway).join(', ')})`);
    assert.equal(at, r.options.length - 1, `${name}: none is last`);
    assert.equal(r.options[at].available, true, name);
    assert.deepEqual(r.options[at].cost, [0, 0], name);
    assert.equal(r.options[at].label, 'review:none', name);
    assert.notEqual(r.recommended, 'none', `${name}: no review is never recommended`);
    assert.equal(r.options[0].pathway, r.recommended, `${name}: the recommendation stays first`);
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'checkpoint-noreview-'));
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
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dir, env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir } });
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
    assert.notEqual(rec.recommended, 'none', name);
  }
});

test('N4: `--by default` and `--by auto` cannot record `none` for HIGH or CRITICAL, even with autoConfirm true; nothing is written', () => {
  for (const [name, paths, labels] of CASES) {
    for (const by of ['default', 'auto']) {
      const r = confirm('none', by, { paths, labels });
      assert.equal(r.status, 1, `${name} --by ${by}: ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr, by === 'default' ? /--by default needs the recommended pathway/ : /--by auto is not allowed here/, `${name} --by ${by}`);
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
