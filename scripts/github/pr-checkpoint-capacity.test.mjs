// The live CodeRabbit capacity fact of the PR checkpoint, and the rules that read it (Dave 2026-11-06, /pathway evaluation R3, R4, R6).
// Run: node --test scripts/github/pr-checkpoint-capacity.test.mjs
// No test reaches GitHub, `cr` or ~/.claude: capacityFact takes every reader as a dep.
//
// How it can fail, and the test that catches it:
//   a reply of the bot is read wrong (free as wait, wait as free, a chat text as a reply)        -> CP1
//   facts.capacity free/wait/unknown does not set the legacy band, or unknown loses the manual band -> CP2
//   a fresh notice (under 60 min) is ignored, so a comment is posted anyway                         -> CP3
//   a fresh cache (under 5 min) is ignored, so a comment is posted anyway                           -> CP4
//   no fresh notice and no fresh cache: no probe is posted, or the reply is not parsed or cached    -> CP5
//   a probe is posted for a Dependabot PR, a PR with no number, or with the kill switch off          -> CP6
//   a gh error, a bad reply or no reply throws, blocks, or reads as free                             -> CP7
//   cr usage is not read, or an unavailable report reads as a number                                 -> CP8
//   an empty or passed slot file reads as anything but unknown                                      -> CP9
//   autoConfirm 'low' lets MID through, or true stops covering every band                            -> CP10
//   a recommendation reason stays generic and names no file, label or band                           -> CP11
//   unknown keeps the stale-count warning; the fact source overwrites the legacy source              -> CP2
//   a free notice older than 5 min, or a wait notice that passed, reads as free                      -> CP3, CP3b
//   a bot chat reply that echoes "reviews are available now" reads as free                           -> CP1
//   a "@coderabbitai full review" request, or a bot's own text, mis-voids a free notice              -> CP3c
//   one PR's cache answers another PR                                                                -> CP4b
//   a slow gh or a silent bot keeps the probe past about 30 s, or cr usage runs after the deadline   -> CP13
//   a probe posts without --probe, without --pr, for a non-draft, or when auto-confirm covers the PR -> CP6, CP12, CP12c
//   the wait text says "count is null"                                                               -> CP14
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, registerTempCleanup } from '../lib/temp-tracker.mjs';

// Remove the temp folders made through makeTempDir() when this file ends (never a prefix or age sweep).
registerTempCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const YAML = readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');
const NOW = '2026-11-06T18:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HEAD = 'a'.repeat(40);
const STAMP = { head: HEAD, body_sha256: 'f'.repeat(64), results: [{ step: 'git:branch', status: 'PASS', detail: 'ok' }] };
const load = () => import('./pr-checkpoint.mjs');
const ago = (min) => new Date(NOW_MS - min * 60_000).toISOString();

// The two replies of the bot to "@coderabbitai rate limit", copied from scripts/github/fixtures/replay/pr221.json.
const WAIT_REPLY = "<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated reply by CodeRabbit -->\nYou're currently rate limited under our [Fair Usage Limits Policy](https://docs.coderabbit.ai/management/rate-limits#fair-usage-limits-policy). Your current included review allowance is based on your included PR review attempts over the past 7 days. Your next review will be available in 12 minutes.";
const FREE_REPLY = '<!-- coderabbit-ai-generated:v1 -->\n\n<!-- This is an auto-generated reply by CodeRabbit -->\nYour [plan](https://docs.coderabbit.ai/management/plans) includes PR reviews subject to [rate limits](https://docs.coderabbit.ai/management/plans#rate-limits). Reviews are available now.';
const BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const comment = (body, at, user = BOT) => ({ body, user, created_at: at, updated_at: at });
const ok = (data) => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });

/** Fake deps. `posted` collects every gh call. The comment list changes after the post, like the real thread. */
function fakeDeps({ comments = [], reply = null, ghFails = false, usage = null, slot = null } = {}) {
  const dir = makeTempDir('capacity-');
  const calls = [];
  let postedAt = null;
  const gh = (args) => {
    calls.push(args);
    if (ghFails) return { status: 1, stdout: '', stderr: 'gh: boom' };
    if (args.includes('POST')) { postedAt = NOW; return ok({ id: 1, created_at: NOW, body: '@coderabbitai rate limit' }); }
    const all = postedAt && reply ? [...comments, comment(reply, new Date(NOW_MS + 4000).toISOString())] : comments;
    return ok(all);
  };
  return { calls, posts: () => calls.filter((a) => a.includes('POST')), deps: { gh, crUsage: () => usage, slotText: () => slot, cachePath: path.join(dir, 'cap.json'), sleep: () => {}, env: {} } };
}
const input = (over = {}) => ({ now: NOW, pr: 7, dependabot: false, policy: LIVE, probe: true, ...over });

test('CP1: parseRateLimitReply reads the two real replies, and nothing else', async () => {
  const { parseRateLimitReply } = await load();
  assert.deepEqual(parseRateLimitReply(WAIT_REPLY), { state: 'wait', minutes: 12 });
  assert.deepEqual(parseRateLimitReply(FREE_REPLY), { state: 'free' });
  assert.equal(parseRateLimitReply('Thanks, I will look at the rate limit docs.'), null);
  assert.equal(parseRateLimitReply('@coderabbitai review'), null);
  const echo = '<!-- This is an auto-generated reply by CodeRabbit -->\nYou wrote: "Reviews are available now." I cannot confirm that. Please run the command again.';
  assert.equal(parseRateLimitReply(echo), null, 'a chat reply that echoes the words is no free reply');
  assert.equal(parseRateLimitReply('> Reviews are available now.\nThanks'), null, 'no bot marker');
});

async function resultFor(capacity, polOver = {}) {
  const { recommend, pathFiltersFrom } = await load();
  const policy = { ...LIVE, ...polOver, path_filters: pathFiltersFrom(YAML) };
  const facts = { head: HEAD, now: NOW, stamp: STAMP, files: [{ filename: 'apps/x/src/a.ts', additions: 5, deletions: 0 }], cli: null, dependabot: false, config_drift: false, labels: [], ...(capacity ? { capacity } : {}) };
  return recommend(facts, policy);
}
const fact = (over) => ({ state: 'unknown', nextSlotAt: null, minutesToSlot: null, lastNoticeAt: null, cliRemaining: null, checkedAt: NOW, source: 'none', ...over });

test('CP2: facts.capacity sets the band (free ok, wait high); unknown or absent keeps the manual band; the fact fields reach the result', async () => {
  const manual = { coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: 45, reviews_7d_manual_date: '2026-11-05' } };
  const free = await resultFor(fact({ state: 'free', source: 'probe' }), manual);
  assert.equal(free.capacity.band, 'ok');
  assert.equal(free.capacity.state, 'free');
  assert.equal(free.capacity.factSource, 'probe');
  assert.equal(free.capacity.source, null, 'the legacy source stays: the count is dropped, so no manual source');
  const wait = await resultFor(fact({ state: 'wait', source: 'notice', nextSlotAt: ago(-20), minutesToSlot: 20 }), manual);
  assert.equal(wait.capacity.band, 'high');
  assert.equal(wait.capacity.minutesToSlot, 20);
  for (const c of [fact(), null]) {
    const r = await resultFor(c, manual);
    assert.equal(r.capacity.band, 'high', 'the 45 count of 2026-11-05 still gives the old band');
    assert.equal(r.capacity.count, 45);
  }
  const stale = { coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: 45, reviews_7d_manual_date: '2026-10-01' } };
  const noFact = await resultFor(null, stale);
  assert.match(noFact.capacity.warning, /update reviews_7d_manual/, 'a caller with no fact keeps the stale-count warning');
  const unknown = await resultFor(fact({ source: 'none' }), stale);
  assert.equal(unknown.capacity.warning, null, 'an unknown fact object drops the stale-count warning');
  assert.equal(unknown.capacity.count, 45);
  assert.equal(unknown.capacity.source, 'manual', 'the legacy source is untouched');
  assert.equal(unknown.capacity.factSource, 'none');
  assert.equal((await resultFor(fact())).capacity.state, 'unknown');
  assert.equal((await resultFor(null)).capacity.state, undefined, 'a caller with no fact (a fixture) gets the old shape');
});

test('CP3: a rate-limit notice under 60 min old gives the state and posts nothing', async () => {
  const { capacityFact } = await load();
  const { deps, posts } = fakeDeps({ comments: [comment(WAIT_REPLY, ago(5))] });
  const r = capacityFact(input(), deps);
  assert.equal(r.state, 'wait');
  assert.equal(r.source, 'notice');
  assert.equal(r.minutesToSlot, 7, '12 minutes from 5 minutes ago');
  assert.equal(r.nextSlotAt, new Date(NOW_MS + 7 * 60_000).toISOString());
  assert.equal(r.lastNoticeAt, ago(5));
  assert.equal(posts().length, 0);
  const f = fakeDeps({ comments: [comment(WAIT_REPLY, ago(30))], reply: FREE_REPLY });
  const passed = capacityFact(input(), f.deps);
  assert.equal(f.posts().length, 1, 'the 12 minutes ended 18 minutes ago: a passed wait notice is no free proof, so the probe runs');
  assert.equal(passed.state, 'free');
  assert.equal(passed.source, 'probe');
  const young = capacityFact(input(), fakeDeps({ comments: [comment(FREE_REPLY, ago(2))] }).deps);
  assert.equal(young.state, 'free', 'a free reply under 5 minutes old holds');
  assert.equal(young.source, 'notice');
  assert.equal(young.checkedAt, ago(2), 'a free notice keeps its own time, so it ages out 5 minutes after the notice');
  const nearly = capacityFact(input(), fakeDeps({ comments: [comment(FREE_REPLY, ago(3))] }).deps);
  assert.equal(nearly.source, 'notice');
  assert.equal(nearly.checkedAt, ago(3), 'a free notice 3 minutes old is not re-stamped now');
  assert.equal(passed.checkedAt, NOW, 'a probe reply is stamped now');
  assert.equal(r.checkedAt, NOW, 'a wait notice is stamped now');
});

test('CP3b: a free reply is void once a review was requested after it', async () => {
  const { capacityFact } = await load();
  const asked = comment('@coderabbitai review', ago(5), { login: 'Rev4nchist', type: 'User' });
  const f = fakeDeps({ comments: [comment(FREE_REPLY, ago(10)), asked], reply: FREE_REPLY });
  const r = capacityFact(input(), f.deps);
  assert.notEqual(r.source, 'notice', 'the free reply of 10 minutes ago is not trusted');
  const asked2 = comment('@coderabbitai review', ago(1), { login: 'Rev4nchist', type: 'User' });
  const f2 = fakeDeps({ comments: [comment(FREE_REPLY, ago(3)), asked2], reply: FREE_REPLY });
  assert.equal(capacityFact(input(), f2.deps).source, 'probe', 'a 3 minute old free reply, and a request after it: probe');
  const old = fakeDeps({ comments: [comment(FREE_REPLY, ago(10))], reply: WAIT_REPLY });
  const oldRun = capacityFact(input(), old.deps);
  assert.equal(old.posts().length, 1, 'a free notice 10 minutes old is past the 5 minute cache time: the probe runs');
  assert.equal(oldRun.state, 'wait');
  assert.equal(oldRun.source, 'probe');
});

test('CP3c: a request voids a free notice only when a person asked: "@coderabbitai full review" counts, a bot comment does not', async () => {
  const { capacityFact } = await load();
  const person = { login: 'Rev4nchist', type: 'User' };
  const full = fakeDeps({ comments: [comment(FREE_REPLY, ago(4)), comment('@coderabbitai full review', ago(2), person)], reply: WAIT_REPLY });
  assert.equal(capacityFact(input(), full.deps).source, 'probe', 'a full review request after the free reply voids it');
  const bot = fakeDeps({ comments: [comment(FREE_REPLY, ago(4)), comment('@coderabbitai review', ago(2), BOT)] });
  assert.equal(capacityFact(input(), bot.deps).source, 'notice', 'a bot comment that starts with the request words voids nothing');
  assert.equal(bot.posts().length, 0);
});

test('CP4: a cache under 5 min old gives the state and posts nothing; one over 5 min old does not', async () => {
  const { capacityFact } = await load();
  const f = fakeDeps({ reply: WAIT_REPLY });
  const repo = 'Rev4nchist/Continuous-Claude-v3#7';
  const cached = fact({ state: 'wait', source: 'probe', nextSlotAt: new Date(NOW_MS + 9 * 60_000).toISOString(), minutesToSlot: 9, checkedAt: ago(3) });
  writeFileSync(f.deps.cachePath, JSON.stringify({ [repo]: cached }));
  const r = capacityFact(input(), f.deps);
  assert.equal(r.state, 'wait');
  assert.equal(r.source, 'cache');
  assert.equal(r.minutesToSlot, 9);
  assert.equal(f.posts().length, 0);
  writeFileSync(f.deps.cachePath, JSON.stringify({ [repo]: { ...cached, checkedAt: ago(6) } }));
  capacityFact(input(), f.deps);
  assert.equal(f.posts().length, 1, 'a 6 minute old cache is stale');
  const keep = fakeDeps({ reply: WAIT_REPLY });
  writeFileSync(keep.deps.cachePath, JSON.stringify({ [repo]: fact({ state: 'free', source: 'probe', checkedAt: ago(4) }) }));
  const free = capacityFact(input(), keep.deps);
  assert.equal(free.state, 'free');
  assert.equal(free.source, 'cache');
  assert.equal(free.checkedAt, ago(4), 'a cached free fact keeps the cache entry time');
  const passed = fakeDeps({ reply: WAIT_REPLY });
  writeFileSync(passed.deps.cachePath, JSON.stringify({ [repo]: fact({ state: 'wait', source: 'probe', nextSlotAt: ago(1), minutesToSlot: 0, checkedAt: ago(3) }) }));
  const turned = capacityFact(input(), passed.deps);
  assert.equal(turned.state, 'free', 'the cached wait passed 1 minute ago');
  assert.equal(turned.source, 'cache');
  assert.equal(turned.checkedAt, NOW, 'a cached wait that becomes free is stamped now');
  const probed = fakeDeps({ reply: FREE_REPLY });
  assert.equal(capacityFact(input(), probed.deps).checkedAt, NOW, 'a probe reply is stamped now');
});

test('CP4b: the cache is keyed by repo and PR: the cache of PR 8 does not answer PR 7', async () => {
  const { capacityFact } = await load();
  const f = fakeDeps({ reply: FREE_REPLY });
  const cached = fact({ state: 'wait', source: 'probe', nextSlotAt: new Date(NOW_MS + 9 * 60_000).toISOString(), minutesToSlot: 9, checkedAt: ago(1) });
  writeFileSync(f.deps.cachePath, JSON.stringify({ 'Rev4nchist/Continuous-Claude-v3#8': cached }));
  const r = capacityFact(input(), f.deps);
  assert.equal(f.posts().length, 1, 'PR 7 has no cache entry');
  assert.equal(r.state, 'free');
  const saved = JSON.parse(readFileSync(f.deps.cachePath, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['Rev4nchist/Continuous-Claude-v3#7', 'Rev4nchist/Continuous-Claude-v3#8']);
});

test('CP5: no fresh notice and no fresh cache: one rate-limit comment is posted through gh api, the reply is read and cached', async () => {
  const { capacityFact } = await load();
  const f = fakeDeps({ comments: [comment(WAIT_REPLY, ago(120))], reply: FREE_REPLY });
  const r = capacityFact(input(), f.deps);
  assert.equal(f.posts().length, 1);
  const post = f.posts()[0];
  assert.equal(post[0], 'api');
  assert.ok(post.includes('repos/Rev4nchist/Continuous-Claude-v3/issues/7/comments'), post.join(' '));
  assert.ok(post.includes('body=@coderabbitai rate limit'), 'a raw -f field, so the @ is not read as a file');
  assert.ok(post.every((a) => !['pr', 'merge', 'create'].includes(a)), 'REST only');
  assert.equal(r.state, 'free');
  assert.equal(r.source, 'probe');
  assert.equal(r.lastNoticeAt, ago(120), 'the old notice is still the last notice');
  const saved = JSON.parse(readFileSync(f.deps.cachePath, 'utf8'));
  assert.equal(saved['Rev4nchist/Continuous-Claude-v3#7'].state, 'free');
  const again = capacityFact(input(), f.deps);
  assert.equal(again.state, 'free');
  assert.equal(f.posts().length, 1, 'the second call posts nothing: the cache and the reply on the PR both answer');
});

test('CP5b: a wait reply gives nextSlotAt and minutesToSlot from the figure', async () => {
  const { capacityFact } = await load();
  const r = capacityFact(input(), fakeDeps({ reply: WAIT_REPLY }).deps);
  assert.equal(r.state, 'wait');
  assert.equal(r.minutesToSlot, 12);
  assert.equal(r.nextSlotAt, new Date(NOW_MS + 12 * 60_000).toISOString());
});

test('CP6: no probe for a Dependabot PR, a PR with no number, the config kill switch or the env kill switch', async () => {
  const { capacityFact } = await load();
  const off = { ...LIVE, capacity: { ...LIVE.capacity, post_rate_limit_probe: false } };
  const cases = [
    ['dependabot', input({ dependabot: true }), {}], ['no number', input({ pr: null }), {}],
    ['config off', input({ policy: off }), {}], ['env off', input(), { PR_CHECKPOINT_NO_PROBE: '1' }],
    ['no --probe', input({ probe: false }), {}], ['probe unset', input({ probe: undefined }), {}], ['gate says no', input({ probe: () => false }), {}],
  ];
  for (const [name, inp, env] of cases) {
    const f = fakeDeps({ reply: FREE_REPLY });
    const r = capacityFact(inp, { ...f.deps, env });
    assert.equal(f.posts().length, 0, name);
    assert.equal(r.state, 'unknown', name);
  }
  const yes = fakeDeps({ reply: FREE_REPLY });
  assert.equal(capacityFact(input({ probe: () => true }), yes.deps).source, 'probe', 'the gate function is asked just before the post');
  assert.equal(LIVE.capacity.post_rate_limit_probe, true, 'the live config ships the probe on (Dave 2026-11-06)');
});

test('CP7: a gh error, no reply in the poll time, or a non-JSON answer gives unknown and never throws', async () => {
  const { capacityFact } = await load();
  const failed = capacityFact(input(), fakeDeps({ ghFails: true }).deps);
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.source, 'none');
  const f = fakeDeps({ reply: null });
  let naps = 0;
  const silent = capacityFact(input(), { ...f.deps, sleep: () => { naps += 1; } });
  assert.equal(silent.state, 'unknown', 'a probe with no reply is not free');
  assert.equal(f.posts().length, 1);
  assert.ok(naps >= 2 && naps <= 12, `the poll waits about 25 seconds in all (${naps} naps)`);
  const junk = capacityFact(input(), { ...fakeDeps().deps, gh: () => ({ status: 0, stdout: 'not json', stderr: '' }) });
  assert.equal(junk.state, 'unknown');
  assert.equal(typeof junk.checkedAt, 'string');
  const thrower = capacityFact(input(), { ...fakeDeps().deps, gh: () => { throw new Error('spawn gh ENOENT'); } });
  assert.equal(thrower.state, 'unknown');
});

test('CP8: cliRemaining comes from cr usage --agent; an unavailable or missing report gives null', async () => {
  const { capacityFact } = await load();
  const usage = '{"type":"usage","includedReviews":{"limit":10,"remaining":8,"fullCapacityInMs":2700000}}\n';
  const quiet = (u) => ({ ...fakeDeps({ comments: [comment(FREE_REPLY, ago(2))], usage: u }) });
  assert.equal(capacityFact(input(), quiet(usage).deps).cliRemaining, 8);
  assert.equal(capacityFact(input(), quiet('{"type":"status","phase":"usage","status":"unavailable"}\n').deps).cliRemaining, null);
  assert.equal(capacityFact(input(), quiet(null).deps).cliRemaining, null);
  const broken = { ...quiet(usage).deps, crUsage: () => { throw new Error('cr missing'); } };
  assert.equal(capacityFact(input(), broken).cliRemaining, null);
});

test('CP9: the slot queue file: an empty one is no data, not a free slot; a recorded notice that is still running gives wait', async () => {
  const { capacityFact } = await load();
  const slot = (nextAt, source, lastPostAt = 0) => JSON.stringify({ version: 1, lastTickAt: 0, slot: { nextAt, source, lastPostAt, lastPostPr: null }, holder: null, items: [] });
  const noProbe = { ...LIVE, capacity: { post_rate_limit_probe: false } };
  const empty = capacityFact(input({ policy: noProbe }), fakeDeps({ slot: slot(null, 'unknown') }).deps);
  assert.equal(empty.state, 'unknown');
  const missing = capacityFact(input({ policy: noProbe }), fakeDeps({ slot: null }).deps);
  assert.equal(missing.state, 'unknown');
  const open = NOW_MS + 15 * 60_000;
  const wait = capacityFact(input({ policy: noProbe }), fakeDeps({ slot: slot(open, 'notice') }).deps);
  assert.equal(wait.state, 'wait');
  assert.equal(wait.minutesToSlot, 15);
  assert.equal(wait.nextSlotAt, new Date(open).toISOString());
  const past = capacityFact(input({ policy: noProbe }), fakeDeps({ slot: slot(NOW_MS - 60_000, 'notice') }).deps);
  assert.equal(past.state, 'unknown', 'a spacing floor that passed is our rule, not a free slot of CodeRabbit');
  const f = fakeDeps({ slot: slot(open, 'notice'), reply: FREE_REPLY });
  assert.equal(capacityFact(input(), f.deps).state, 'wait', 'a notice the queue recorded settles it');
  assert.equal(f.posts().length, 0, 'and nothing is posted');
});

// ---------- the deadline ----------

/** Deps with a fake wall clock. Every gh call costs `cost` ms (cut to its timeoutMs), a sleep costs its ms. `lateAt`: the reply shows only after that clock time. */
function slowDeps({ cost, reply = WAIT_REPLY, lateAt = 0, usage = null, comments = [], slotCost = 0 }) {
  const f = fakeDeps({ usage });
  const clock = { t: 1_000_000 };
  const start = clock.t;
  const gh = (args, opts) => {
    f.calls.push(args);
    clock.t += Math.min(cost, opts?.timeoutMs ?? cost);
    if (args.includes('POST')) return ok({ id: 1, created_at: NOW });
    const live = clock.t - start >= lateAt ? [...comments, comment(reply, new Date(NOW_MS + 4000).toISOString())] : comments;
    return ok(live);
  };
  let naps = 0;
  const deps = { ...f.deps, gh, now: () => clock.t, slotText: () => { clock.t += slotCost; return null; }, sleep: (ms) => { naps += 1; clock.t += ms; } };
  return { ...f, deps, elapsed: () => clock.t - start, naps: () => naps, posts: () => f.calls.filter((a) => a.includes('POST')) };
}

test('CP13: one deadline of about 30 s covers the comment read, the post, the polls and cr usage; a late reply is a fresh notice next run', async () => {
  const { capacityFact } = await load();
  const usage = '{"type":"usage","includedReviews":{"limit":10,"remaining":8,"fullCapacityInMs":2700000}}\n';
  const slow = slowDeps({ cost: 10_000, lateAt: 60_000, usage });
  const r = capacityFact(input(), slow.deps);
  assert.equal(r.state, 'unknown', 'the reply came after the deadline');
  assert.equal(slow.posts().length, 1);
  assert.ok(slow.elapsed() <= 31_000, `the probe stops at the deadline (${slow.elapsed()} ms)`);
  assert.equal(r.cliRemaining, null, 'cr usage does not run after the deadline');
  assert.ok(slow.naps() <= 3, `${slow.naps()} naps: polling stops at the deadline`);
  const saved = JSON.parse(readFileSync(slow.deps.cachePath, 'utf8'));
  assert.equal(saved['Rev4nchist/Continuous-Claude-v3#7'].state, 'unknown', 'the probe is cached, so the next run does not post again');
  const late = comment(WAIT_REPLY, new Date(NOW_MS + 40_000).toISOString());
  const next = fakeDeps({ comments: [late] });
  writeFileSync(next.deps.cachePath, readFileSync(slow.deps.cachePath, 'utf8'));
  const again = capacityFact(input({ now: new Date(NOW_MS + 60_000).toISOString() }), next.deps);
  assert.equal(again.state, 'wait');
  assert.equal(again.source, 'notice', 'the late reply is read as a notice');
  assert.equal(next.posts().length, 0);
});

test('CP13b: readers that eat the budget leave no time to post, and a fast run still gets its answer and cr usage', async () => {
  const { capacityFact } = await load();
  const spent = slowDeps({ cost: 100, lateAt: 1e9, slotCost: 28_000 });
  const r = capacityFact(input(), spent.deps);
  assert.equal(spent.posts().length, 0, 'under one poll step left: a comment could not be read back, so none is posted');
  assert.equal(r.state, 'unknown');
  assert.ok(spent.elapsed() <= 31_000, `${spent.elapsed()} ms`);
  const usage = '{"type":"usage","includedReviews":{"limit":10,"remaining":8,"fullCapacityInMs":2700000}}\n';
  const fast = slowDeps({ cost: 100, lateAt: 0, usage });
  const ok2 = capacityFact(input(), fast.deps);
  assert.equal(ok2.state, 'wait');
  assert.equal(ok2.cliRemaining, 8);
});

test('CP14: a wait fact is worded from the next slot time, never from the count', async () => {
  const { recommend, pathFiltersFrom } = await load();
  const policy = { ...LIVE, path_filters: pathFiltersFrom(YAML), coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null }, checkpoint: { ...LIVE.checkpoint, autoConfirm: false } };
  const label = { ...policy, matrix: { ...policy.matrix } };
  const facts = { head: HEAD, now: NOW, stamp: STAMP, files: [{ filename: 'apps/x/src/a.ts', additions: 5, deletions: 0 }], cli: null, dependabot: false, config_drift: false, labels: [], capacity: fact({ state: 'wait', source: 'notice', nextSlotAt: new Date(NOW_MS + 20 * 60_000).toISOString(), minutesToSlot: 20 }) };
  const noMatrix = { ...label, matrix: undefined };
  const r = recommend(facts, noMatrix);
  assert.equal(r.recommended, 'wait', JSON.stringify(r.why));
  const text = [...r.why, ...r.options.map((o) => o.reason)].join(' | ');
  assert.doesNotMatch(text, /null/, text);
  assert.doesNotMatch(text, /7-day count/, text);
  assert.match(text, /in 20 min/, text);
  const unknownCount = recommend({ ...facts, capacity: fact({ state: 'unknown' }) }, { ...noMatrix, coderabbit: { ...noMatrix.coderabbit, reviews_7d_manual: 45, reviews_7d_manual_date: '2026-11-05' } });
  assert.match(unknownCount.why.join(' '), /7-day count is 45/, 'a count that exists keeps the count wording');
});

// ---------- autoConfirm ----------

const GATE = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];
const LOW = ['apps/x/README.txt'];
const MID = ['apps/x/src/a.ts', 'apps/x/src/b.ts', 'apps/x/src/c.ts'];
async function autoFor(paths, autoConfirm, labels = []) {
  const { recommend, pathFiltersFrom } = await load();
  const policy = { ...LIVE, path_filters: pathFiltersFrom(YAML), checkpoint: { ...LIVE.checkpoint, autoConfirm }, coderabbit: { ...LIVE.coderabbit, reviews_7d_manual: null, reviews_7d_manual_date: null } };
  return recommend({ head: HEAD, now: NOW, stamp: STAMP, files: paths.map((p) => ({ filename: p, additions: 10, deletions: 0 })), cli: null, dependabot: false, config_drift: false, labels }, policy);
}

test("CP10: autoConfirm 'low' covers LOW only; true still covers LOW, MID and ELEVATED; the critical-file floor still stops 'low'", async () => {
  const low = await autoFor(LOW, 'low');
  assert.equal(low.band.band, 'LOW');
  assert.equal(low.auto.eligible, true, low.auto.reason);
  const mid = await autoFor(MID, 'low');
  assert.equal(mid.band.band, 'MID');
  assert.equal(mid.auto.eligible, false);
  assert.match(mid.auto.reason, /LOW/);
  assert.equal((await autoFor(MID, true)).auto.eligible, true, 'true keeps the legacy meaning');
  assert.equal((await autoFor(LOW, true)).auto.eligible, true);
  for (const value of ['LOW', 'Low', 'true', 1, null]) {
    const r = await autoFor(LOW, value);
    assert.equal(r.auto.eligible, false, `autoConfirm ${JSON.stringify(value)}: only the exact word low`);
  }
  const critical = await autoFor(['scripts/github/review-status.mjs', ...LOW], 'low');
  assert.equal(critical.auto.eligible, false, 'a critical file needs Dave');
  assert.equal(LIVE.checkpoint.autoConfirm, 'low', 'the live config ships low (Dave 2026-11-06)');
});

// ---------- reasons name the trigger ----------

test('CP11: the reason names the real trigger: the label, the critical file, a gate file, or the first file and the band', async () => {
  const text = (r) => r.why.join(' ');
  const plain = await autoFor(MID, false);
  assert.match(plain.why[0], /below HIGH/, 'the old phrase stays');
  assert.match(plain.why[0], /apps\/x\/src\/a\.ts/, 'a plain PR names its first file');
  const low = await autoFor(LOW, false);
  assert.ok(text(low).includes('apps/x/README.txt'), text(low));
  const labelled = await autoFor(['scripts/a.mjs'], false, ['risk:high']);
  assert.match(text(labelled), /risk:high label/);
  const crit = await autoFor(['scripts/github/review-status.mjs', 'scripts/a.mjs'], false);
  assert.match(crit.why[0], /critical file scripts\/github\/review-status\.mjs/);
  const gate = await autoFor(['scripts/github/cr-fix.mjs', 'scripts/a.mjs'], false);
  assert.match(gate.why[0], /gate file scripts\/github\/cr-fix\.mjs/);
  assert.match((await autoFor(LOW, 'low')).auto.reason, /apps\/x\/README\.txt/, 'the auto-confirm reason names it too');
});

// ---------- the wired engine ----------

/**
 * The real engine in a temp git repo with a stamp, a fake gh (env PR_CHECKPOINT_GH) that serves PR 7 and its comments, no `cr` and no slot file.
 * The fake gh keeps a call log and a flag file: after a POST, the comment list holds the bot's reply.
 */
function wiredRun(repo, { author = 'Rev4nchist', noProbe = false, args = ['--probe', '--pr', '7'], draft = true, state = 'OPEN', json = true } = {}) {
  const script = path.join(repo, 'fake-gh.mjs');
  const log = path.join(repo, 'gh-calls.jsonl');
  const reply = JSON.stringify({ body: WAIT_REPLY, user: BOT });
  writeFileSync(script, [
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    'const a = process.argv.slice(2);',
    "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
    "const flag = process.env.FAKE_GH_LOG + '.posted';",
    "if (a[0] === 'pr') process.stdout.write(JSON.stringify({ labels: [], number: 7, author: { login: process.env.FAKE_GH_AUTHOR }, state: process.env.FAKE_GH_STATE, isDraft: process.env.FAKE_GH_DRAFT === '1', url: 'https://github.com/Rev4nchist/Continuous-Claude-v3/pull/7' }));",
    "else if (a.includes('POST')) { writeFileSync(flag, '1'); process.stdout.write(JSON.stringify({ id: 1, created_at: new Date().toISOString() })); }",
    "else process.stdout.write(JSON.stringify(existsSync(flag) ? [{ ...JSON.parse(process.env.FAKE_GH_REPLY), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] : []));",
  ].join('\n'));
  const env = {
    ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_LEDGER: path.join(repo, 'no-ledger.jsonl'), PR_CHECKPOINT_CR: 'off', PR_CHECKPOINT_SLOT_STATE: path.join(repo, 'no-slot.json'),
    PR_CHECKPOINT_GH: script, FAKE_GH_LOG: log, FAKE_GH_AUTHOR: author, FAKE_GH_STATE: state, FAKE_GH_DRAFT: draft ? '1' : '0', FAKE_GH_REPLY: reply, ...(noProbe ? { PR_CHECKPOINT_NO_PROBE: '1' } : {}),
  };
  const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), ...(json ? ['--json'] : []), ...args, '--config', path.join(repo, 'cfg.json')], { cwd: repo, encoding: 'utf8', env });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, out: r.status === 0 && json ? JSON.parse(r.stdout) : null, posts: calls.filter((c) => c.includes('POST')) };
}

function wiredRepo({ autoConfirm = false } = {}) {
  const repo = realpathSync(makeTempDir('capacity-wired-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  const config = JSON.stringify({ ...LIVE, deep_enabled: false, greptile: { ...LIVE.greptile, credits_used_manual: null }, checkpoint: { ...LIVE.checkpoint, autoConfirm } });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  writeFileSync(path.join(repo, 'review-router.config.json'), config); // main holds the same config: no drift, so auto-confirm can apply
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('checkout', '-q', '-b', 'feat/x');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'guide.md'), 'two\n');
  git('add', '.');
  git('commit', '-q', '-m', 'two');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(path.join(repo, '.claude', 'cache', 'pre-pr'), { recursive: true });
  writeFileSync(path.join(repo, '.claude', 'cache', 'pre-pr', 'stamp.json'), JSON.stringify({ head, body_sha256: 'f'.repeat(64), results: [] }));
  writeFileSync(path.join(repo, 'cfg.json'), config);
  return repo;
}

test('CP12 (wired): with --probe --pr 7 the real engine posts one rate-limit comment through gh api, prints the fact in capacity, and a second run posts nothing', () => {
  const repo = wiredRepo();
  const first = wiredRun(repo);
  assert.equal(first.r.status, 0, `${first.r.stdout} ${first.r.stderr}`);
  assert.equal(first.posts.length, 1, 'one probe comment');
  assert.equal(first.out.capacity.state, 'wait');
  assert.equal(first.out.capacity.factSource, 'probe');
  assert.equal(first.out.capacity.minutesToSlot, 12);
  assert.equal(first.out.capacity.band, 'high', 'the old band field follows the live state');
  assert.equal(first.out.capacity.cliRemaining, null, 'cr is off in this run');
  assert.ok(existsSync(path.join(repo, '.claude', 'cache', 'coderabbit-capacity.json')), 'the cache is written under .claude/cache of the checkout');
  const second = wiredRun(repo);
  assert.equal(second.posts.length, 1, 'the reply on the PR and the cache answer the second run');
  assert.ok(first.posts[0].includes('repos/Rev4nchist/Continuous-Claude-v3/issues/7/comments'));
  assert.equal(second.out.capacity.state, 'wait');
});

test('CP12c (wired): no post without --probe, without --pr, for a non-draft or closed PR, when auto-confirm covers the PR, or in --confirm; the checkpoint still answers', () => {
  const cases = [
    ['no --probe', wiredRepo(), { args: ['--pr', '7'] }],
    ['--probe without --pr', wiredRepo(), { args: ['--probe'] }],
    ['PR is ready, not a draft', wiredRepo(), { draft: false }],
    ['PR is closed', wiredRepo(), { state: 'CLOSED' }],
    ['PR number differs from the flag', wiredRepo(), { args: ['--probe', '--pr', '8'] }],
    ['auto-confirm covers the PR', wiredRepo({ autoConfirm: 'low' }), {}],
  ];
  for (const [name, repo, opts] of cases) {
    const run = wiredRun(repo, opts);
    assert.equal(run.r.status, 0, `${name}: ${run.r.stdout} ${run.r.stderr}`);
    assert.equal(run.posts.length, 0, name);
    assert.equal(run.out.capacity.state, 'unknown', name);
    assert.ok(run.out.recommended !== undefined, name);
  }
  const auto = wiredRun(wiredRepo({ autoConfirm: 'low' }), {});
  assert.equal(auto.out.auto.eligible, true, 'the auto case really is auto-eligible');
  const repo = wiredRepo();
  wiredRun(repo, { args: ['--pr', '7'] });
  const log = path.join(repo, 'gh-calls.jsonl');
  const read = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const before = read().length;
  const confirm = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--confirm', 'none', '--by', 'dave', '--body', path.join(repo, 'a.txt'), '--probe', '--pr', '7', '--config', path.join(repo, 'cfg.json')], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', PR_CHECKPOINT_LEDGER: path.join(repo, 'no-ledger.jsonl'), PR_CHECKPOINT_CR: 'off', PR_CHECKPOINT_SLOT_STATE: path.join(repo, 'no-slot.json'), PR_CHECKPOINT_GH: path.join(repo, 'fake-gh.mjs'), FAKE_GH_LOG: path.join(repo, 'gh-calls.jsonl') },
  });
  assert.ok(read().length > before, `--confirm read through the fake gh (${confirm.stderr})`);
  assert.equal(read().filter((c) => c.includes('POST')).length, 0, '--confirm never posts');
  const text = wiredRun(wiredRepo(), { json: false });
  assert.equal(text.r.status, 0, text.r.stderr);
  assert.equal(text.posts.length, 0, 'the text plan (no --json) never posts');
  assert.equal(wiredRun(wiredRepo(), {}).posts.length, 1, 'control: the same repo with --json --probe --pr does post');
});

test('CP12d (wired): a bad --pr value is a usage error (exit 2)', () => {
  const repo = wiredRepo();
  for (const bad of [['--pr'], ['--pr', 'x'], ['--pr', '0']]) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'pr-checkpoint.mjs'), '--json', ...bad, '--config', path.join(repo, 'cfg.json')], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stdout} ${r.stderr}`);
  }
});

test('CP12b (wired): a Dependabot PR author or the env kill switch: no post, state unknown, the checkpoint still answers', () => {
  for (const opts of [{ author: 'app/dependabot' }, { noProbe: true }]) {
    const run = wiredRun(wiredRepo(), opts);
    assert.equal(run.r.status, 0, `${run.r.stdout} ${run.r.stderr}`);
    assert.equal(run.posts.length, 0, JSON.stringify(opts));
    assert.equal(run.out.capacity.state, 'unknown');
    assert.equal(run.out.recommended, 'none', JSON.stringify(run.out.why));
  }
});
