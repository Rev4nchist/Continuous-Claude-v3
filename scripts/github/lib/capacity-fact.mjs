// The live CodeRabbit capacity fact of the PR checkpoint (Dave 2026-11-06). Producer: pr-checkpoint.mjs gatherFacts. Tests: pr-checkpoint-capacity.test.mjs.
// capacityFact answers one question: does a free CodeRabbit PR review fit now? state 'free', 'wait' (nextSlotAt says when) or 'unknown'.
// It never throws and never blocks the checkpoint: every reader is wrapped, and any doubt is 'unknown'.
// Order: (1) a rate-limit notice on the PR that still holds, (2) a cache under 5 min old, (3) a notice the slot queue recorded,
// (4) one `@coderabbitai rate limit` comment (free, not a review) and its reply, (5) the slot queue file (it only says wait). Every reader is a dep, so a test never
// reaches GitHub, `cr` or ~/.claude.
// A notice holds when it is under 60 min old and (wait) its time has not passed, or (free) it is under 5 min old. 'free' comes only from a probe
// reply, a free notice under 5 min old or a cache entry under 5 min old.
// The probe posts only when input.probe is true (or a function that answers true just before the post): the caller decides that a question will be shown.
// One deadline of about 30 s (deps.now) covers the comment read, the post, the polls and `cr usage`. A reply after it is a notice for the next run.
// The reply carries no "reviews left" count, so cliRemaining is the CLI pool only (`cr usage --agent`, read-only).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsage } from '../pre-pr.mjs';
import { DEFAULT_REPO } from '../review-router.mjs';
import { codeRabbitNotice, codeRabbitRetryMinutes, coderabbitRequestComments, isCodeRabbitUser } from '../review-status.mjs';
import { configOf, parseState, slotOpensAt } from '../slot-queue-model.mjs';

const MIN = 60_000;
const NOTICE_FRESH_MS = 60 * MIN;
const CACHE_TTL_MS = 5 * MIN;
const BUDGET_MS = 30_000; // one deadline for the whole probe
const GH_TIMEOUT_MS = 20_000;
const POLL_STEP_MS = 3000;
const POLL_TRIES = 9; // 9 x 3 s: the poll waits about 25 s in all
const PROBE_BODY = '@coderabbitai rate limit';
// The auto-generated wording: the bot marker, then "...rate-limits). Reviews are available now." as the last sentence. A chat reply that quotes the words does not end that way.
const FREE_REPLY = /<!--\s*This is an auto-generated reply by CodeRabbit\s*-->[\s\S]{0,600}?[.)\]]\s+Reviews are available now\.\s*$/;
const WAIT_REPLY = /currently\s+rate\s+limited|next\s+review\s+will\s+be\s+available/i;
const SLOT_SOURCES = ['notice', 'post', 'seen'];

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const stamp = (c, field) => Date.parse(c?.[field] ?? '');
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/**
 * The bot's answer to "@coderabbitai rate limit": { state: 'free' } ("Reviews are available now."), { state: 'wait', minutes } ("Your next review
 * will be available in 12 minutes.", minutes null when it names no figure), or null for any other text. Wording copied from live PRs (replay fixtures).
 */
export function parseRateLimitReply(body) {
  const text = String(body ?? '');
  if (FREE_REPLY.test(text)) return { state: 'free' };
  return WAIT_REPLY.test(text) ? { state: 'wait', minutes: codeRabbitRetryMinutes(text) } : null;
}

/** A CodeRabbit comment as a notice { state, minutes?, at }: a reply to the probe, or a "rate limited" notice. Null for anything else. */
function noticeOf(c) {
  if (!isCodeRabbitUser(c?.user)) return null;
  const at = stamp(c, 'updated_at') || stamp(c, 'created_at');
  if (!Number.isFinite(at)) return null;
  const reply = parseRateLimitReply(c.body);
  if (reply) return { ...reply, at };
  return codeRabbitNotice(c.body) === 'rate limited' ? { state: 'wait', minutes: codeRabbitRetryMinutes(c.body), at } : null;
}

const newest = (list) => list.reduce((a, b) => (a === null || b.at > a.at ? b : a), null);

/** A free reply is void once a person asked for a review after it ("@coderabbitai review" or "full review"): that review may have used the slot. */
const voided = (n, requests) => n.state === 'free' && requests.some((c) => stamp(c, 'created_at') > n.at);

/** The wait notice's end time, or null when it names no figure. */
const waitEnd = (n) => (n.minutes === null ? null : n.at + n.minutes * MIN);

/** Does a notice still hold at `nowMs`? A wait: under 60 min old and its time has not passed. A free: under 5 min old and not void. */
function holds(n, requests, nowMs) {
  if (n.state === 'free') return nowMs - n.at <= CACHE_TTL_MS && !voided(n, requests);
  const end = waitEnd(n);
  return nowMs - n.at <= NOTICE_FRESH_MS && (end === null || end > nowMs);
}

/** The newest notice that still holds, or null. Anything older or passed falls through to the cache, then the probe. */
function freshNotice(notices, comments, nowMs) {
  const requests = coderabbitRequestComments(comments);
  return newest(notices.filter((n) => holds(n, requests, nowMs)));
}

/** What a holding notice says. */
function fromNotice(n) {
  return n.state === 'free' ? { state: 'free', source: 'notice' } : { state: 'wait', nextAtMs: waitEnd(n), source: 'notice' };
}

function build(nowMs, p) {
  const next = p.state === 'wait' ? (p.nextAtMs ?? null) : null;
  return {
    state: p.state, nextSlotAt: iso(next), minutesToSlot: next === null ? null : Math.max(0, Math.ceil((next - nowMs) / MIN)),
    lastNoticeAt: iso(p.lastNoticeMs ?? null), cliRemaining: p.cliRemaining ?? null, checkedAt: iso(nowMs), source: p.source,
  };
}

// ---------- readers ----------

function readComments(d, pr) {
  const r = callGh(d, ['api', '--paginate', '--slurp', `repos/${d.repo}/issues/${pr}/comments?per_page=100`]);
  if (r.status !== 0) throw new Error('gh api comments failed');
  return [JSON.parse(r.stdout)].flat(2).filter((c) => c && typeof c === 'object');
}

function readCache(d, nowMs) {
  const entry = safe(() => JSON.parse(readFileSync(d.cachePath, 'utf8'))[d.key], null);
  const age = nowMs - Date.parse(entry?.checkedAt ?? '');
  return entry && age >= 0 && age <= CACHE_TTL_MS ? entry : null;
}

function writeCache(d, fact) {
  safe(() => {
    const all = existsSync(d.cachePath) ? safe(() => JSON.parse(readFileSync(d.cachePath, 'utf8')), {}) : {};
    mkdirSync(path.dirname(d.cachePath), { recursive: true });
    writeFileSync(d.cachePath, `${JSON.stringify({ ...all, [d.key]: fact }, null, 2)}\n`);
  }, null);
}

/** The cached fact at `nowMs`, as a pick. A wait whose time passed is free. An unknown entry only says a probe ran lately. */
function fromCache(entry, nowMs) {
  if (entry.state === 'unknown') return { state: 'unknown', source: 'none', probed: true };
  const next = Date.parse(entry.nextSlotAt ?? '');
  const waiting = entry.state === 'wait' && (!Number.isFinite(next) || next > nowMs);
  return { state: waiting ? 'wait' : 'free', nextAtMs: waiting && Number.isFinite(next) ? next : null, source: 'cache' };
}

/**
 * The slot queue file as a pick, or null. It only ever says wait: its "free" is our own spacing floor (60 min after our last post), not
 * CodeRabbit's answer. An empty or unknown-source file is no data. recorded: the queue holds a notice that still runs.
 */
function slotPick(d, policy, nowMs) {
  const text = d.slotText();
  if (text === null || text === undefined) return null;
  const state = parseState(text);
  if (!SLOT_SOURCES.includes(state.slot.source)) return null;
  const opens = slotOpensAt(state, configOf(policy));
  if (opens <= nowMs) return null;
  return { state: 'wait', nextAtMs: opens, source: 'cache', recorded: state.slot.source === 'notice' };
}

const cliRemaining = (d) => {
  if (d.left() <= 0) return null;
  const text = d.crUsage({ timeoutMs: Math.min(GH_TIMEOUT_MS, d.left()) });
  return text ? (parseUsage(text)?.remaining ?? null) : null;
};

// ---------- the probe ----------

const killed = (env) => Boolean(env?.PR_CHECKPOINT_NO_PROBE) && env.PR_CHECKPOINT_NO_PROBE !== '0';

/** input.probe: true, or a function that answers true. Anything else (absent, false, an error) is no. The function runs here, just before a post. */
const probeAsked = (input) => safe(() => (typeof input.probe === 'function' ? input.probe() === true : input.probe === true), false);

/**
 * Post only when the caller asked (input.probe), and never for a Dependabot PR, a PR with no number, or with a kill switch off (config
 * capacity.post_rate_limit_probe false, or the env var PR_CHECKPOINT_NO_PROBE).
 */
function mayPost(input, d) {
  const allowed = Number.isInteger(input.pr) && input.pr > 0 && !input.dependabot && input.policy?.capacity?.post_rate_limit_probe !== false && !killed(d.env);
  return allowed && probeAsked(input);
}

/** One gh call inside the deadline: it gets what is left of the budget as its timeout, and none runs once the budget is spent. */
function callGh(d, args) {
  const left = d.left();
  if (left <= 0) return { status: 1, stdout: '', stderr: 'capacity probe deadline' };
  return d.gh(args, { timeoutMs: Math.max(1000, Math.min(GH_TIMEOUT_MS, left)) });
}

/** The bot's reply after `postedMs`, or null. */
function replyAfter(list, postedMs) {
  const hit = list.find((c) => isCodeRabbitUser(c?.user) && stamp(c, 'created_at') >= postedMs && parseRateLimitReply(c.body));
  return hit ? parseRateLimitReply(hit.body) : null;
}

/** Posts one rate-limit comment and polls for the reply. { posted: false } when the post failed, else { posted: true, reply }. */
function probe(input, d, nowMs) {
  if (d.left() <= POLL_STEP_MS) return { posted: false, reply: null }; // no time left to read an answer, so post nothing
  const url = `repos/${d.repo}/issues/${input.pr}/comments`;
  const post = callGh(d, ['api', '-X', 'POST', url, '-f', `body=${PROBE_BODY}`]);
  if (post.status !== 0) return { posted: false, reply: null };
  const postedMs = safe(() => stamp(JSON.parse(post.stdout), 'created_at'), NaN);
  const since = Number.isFinite(postedMs) ? postedMs : nowMs;
  for (let i = 0; i < POLL_TRIES && d.left() > POLL_STEP_MS; i += 1) {
    d.sleep(POLL_STEP_MS);
    const r = callGh(d, ['api', `${url}?per_page=100&since=${iso(since)}`]);
    const reply = r.status === 0 ? safe(() => replyAfter([JSON.parse(r.stdout)].flat(2), since), null) : null;
    if (reply) return { posted: true, reply };
  }
  return { posted: true, reply: null };
}

function fromReply(reply, nowMs) {
  if (reply.state === 'free') return { state: 'free', source: 'probe' };
  return { state: 'wait', nextAtMs: reply.minutes === null ? null : nowMs + reply.minutes * MIN, source: 'probe' };
}

// ---------- the answer ----------

/** The fact for a run that reads nothing (no stamp, so the checkpoint stops before the capacity matters). */
export const idleCapacity = (now) => build(Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now(), { state: 'unknown', source: 'none' });

function pick(input, d, nowMs) {
  const comments = input.pr ? safe(() => readComments(d, input.pr), []) : [];
  const notices = comments.map(noticeOf).filter(Boolean);
  const lastWait = newest(notices.filter((n) => n.state === 'wait'));
  const withLast = (p, cachedMs = null) => ({ ...p, lastNoticeMs: lastWait?.at ?? cachedMs });
  const fresh = freshNotice(notices, comments, nowMs);
  if (fresh) return withLast(fromNotice(fresh));
  const entry = readCache(d, nowMs);
  const cached = entry ? fromCache(entry, nowMs) : null;
  if (cached && cached.state !== 'unknown') return withLast(cached, Date.parse(entry.lastNoticeAt ?? ''));
  const slot = safe(() => slotPick(d, input.policy, nowMs), null);
  if (slot?.recorded) return withLast(slot);
  if (!cached && mayPost(input, d)) {
    const r = probe(input, d, nowMs);
    const got = r.reply ? fromReply(r.reply, nowMs) : { state: 'unknown', source: 'none' };
    if (r.posted) writeCache(d, build(nowMs, withLast(got)));
    if (r.reply) return withLast(got);
  }
  return withLast(slot ?? { state: 'unknown', source: 'none' });
}

/**
 * The capacity fact { state, nextSlotAt, minutesToSlot, lastNoticeAt, cliRemaining, checkedAt, source }, as the contract says (times are ISO strings).
 * input: { now (ISO), pr (number or null), dependabot, policy (the router config), probe (true or a function: may a comment be posted), root (the checkout, for the cache) }.
 * deps: see defaultDeps. deps.now() is the wall clock (ms) of the 30 s deadline; input.now is the time the freshness rules read.
 */
export function capacityFact(input, deps = {}) {
  const d = { ...defaultDeps({ root: input.root }), ...deps };
  const until = d.now() + BUDGET_MS;
  d.left = () => until - d.now();
  d.key = `${d.repo}#${input.pr ?? 0}`;
  const parsed = Date.parse(input.now);
  const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
  const picked = safe(() => pick(input, d, nowMs), null) ?? { state: 'unknown', source: 'none' };
  return build(nowMs, { ...picked, cliRemaining: safe(() => cliRemaining(d), null) });
}

// ---------- real readers ----------

/** Sleeps without a timer, so the synchronous engine can wait for the bot. */
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The real gh, or `node $PR_CHECKPOINT_GH <args>` (the test seam). The personal config dir holds the fork account, as cr-fix.mjs ghApi does. */
function ghFor(env) {
  const personal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = env.GH_CONFIG_DIR || (existsSync(personal) ? personal : undefined);
  return (args, { timeoutMs = GH_TIMEOUT_MS } = {}) => {
    const fake = env.PR_CHECKPOINT_GH;
    const r = spawnSync(fake ? process.execPath : 'gh', fake ? [fake, ...args] : args, { encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, GH_TIMEOUT_MS), env: { ...env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) } });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || String(r.error?.message ?? '') };
  };
}

/** `cr usage --agent` (read-only, never a run), or `node $PR_CHECKPOINT_CR usage --agent` (the test seam); PR_CHECKPOINT_CR=off skips it. */
function crUsageFor(env) {
  return ({ timeoutMs = GH_TIMEOUT_MS } = {}) => {
    if (env.PR_CHECKPOINT_CR === 'off') return null;
    const fake = env.PR_CHECKPOINT_CR;
    const r = spawnSync(fake ? process.execPath : 'cr', fake ? [fake, 'usage', '--agent'] : ['usage', '--agent'], { encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, GH_TIMEOUT_MS) });
    return typeof r.stdout === 'string' && r.stdout !== '' ? r.stdout : null;
  };
}

/** The slot queue file text, or null when missing. PR_CHECKPOINT_SLOT_STATE names another file (the test seam). */
function slotTextFor(env) {
  const file = env.PR_CHECKPOINT_SLOT_STATE || path.join(os.homedir(), '.claude', 'state', 'coderabbit-slot.json');
  return () => (existsSync(file) ? readFileSync(file, 'utf8') : null);
}

export function defaultDeps({ root, env = process.env } = {}) {
  return {
    repo: DEFAULT_REPO, env, gh: ghFor(env), crUsage: crUsageFor(env), slotText: slotTextFor(env), sleep: nap, now: Date.now,
    cachePath: path.join(root ?? process.cwd(), '.claude', 'cache', 'coderabbit-capacity.json'),
  };
}
