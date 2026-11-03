#!/usr/bin/env node
/**
 * slot-queue.mjs: the free CodeRabbit slot queue (CLI and IO). The rules are in slot-queue-model.mjs (pure).
 * One writer for ~/.claude/state/coderabbit-slot.json, under withLock (lib/file-lock.mjs). Plan: .claudedocs/2026-11-02-free-slot-queue-phase1-plan.md.
 *
 * Usage (the verb is argv[0]; any other position throws):
 *   tick [--session ID] [--json]                                    read GitHub, apply the queue rules, post when the slot is free
 *   add --pr N --band CRITICAL|HIGH|SAMPLE --head SHA40 [--round R] [--escalated] [--session ID] [--json]
 *   list [--json]                                                   rows from the file; reads nothing else
 *   decide --pr N --kind pay|wait|first [--json]                    Dave's answers (the mod runs this from his composer)
 *   drop --pr N --reason R [--json]                                 R = sample-ttl only drops a SAMPLE
 *   probe --pr N [--json]                                           the facts a tick reads for one PR; writes and posts nothing
 *
 * Exit: 0 ok; 2 bad input, a read error or a corrupt state file ({ ok: false, reason }); 3 decide pay got ESCALATE (nothing posted).
 * Facts note: headCommittedAt is read (commits/<sha>) so a notice that names no commit still ties to the head. carryHolds is false
 * unless deps.carryHolds says otherwise: the carry needs the non-pure review-status path, and a wrong false only costs one extra post.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPr, recordPaid } from './cr-paid.mjs';
import { ghApi } from './cr-fix.mjs';
import { codeRabbitHeadReview, coderabbitRequestComments, isCodeRabbitUser, readIssueComments } from './review-status.mjs';
import { withLock } from './lib/file-lock.mjs';
import {
  BANDS, configOf, parseState, pickNext, rowsOf, settle, slotOpensAt, timers,
} from './slot-queue-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';
const DEFAULT_CONFIG = path.join(HERE, '..', '..', 'review-router.config.json');
const DEFAULT_STATE = path.join(os.homedir(), '.claude', 'state', 'coderabbit-slot.json');
const SHA40 = /^[0-9a-f]{40}$/;
const MIN = 60_000;
const REVIEW_COMMENT = '@coderabbitai review';
const VERBS = ['tick', 'add', 'list', 'decide', 'drop', 'probe'];
const KINDS = ['pay', 'wait', 'first'];
const VALUE_FLAGS = { '--pr': 'pr', '--band': 'band', '--head': 'head', '--round': 'round', '--session': 'session', '--reason': 'reason', '--kind': 'kind' };
const BOOL_FLAGS = { '--json': 'json', '--escalated': 'escalated' };
const isDone = (it) => it.state === 'done' || it.state === 'dropped';
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const bad = (why) => new Error(`slot-queue: ${why}`);
const toast = (pr, text) => ({ kind: 'toast', pr, text });
const POST_BACKOFF_MIN = 10;
const WAITABLE = ['queued', 'timed-out', 'stuck'];

// ---- command line ----

function flagsOf(rest) {
  const o = { json: false, escalated: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (BOOL_FLAGS[rest[i]]) o[BOOL_FLAGS[rest[i]]] = true;
    else if (VALUE_FLAGS[rest[i]]) { o[VALUE_FLAGS[rest[i]]] = rest[i + 1]; i += 1; }
    else throw bad(`unknown argument: ${rest[i]}`);
  }
  return o;
}

const wholeNumber = (v, flag) => {
  if (!/^\d+$/.test(String(v ?? '')) || Number(v) === 0) throw bad(`${flag} needs a whole number above 0`);
  return Number(v);
};

/** { verb, pr, band, head, round, escalated, json, session, reason, kind } from argv. Throws on a bad verb, flag or value. */
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!VERBS.includes(verb)) throw bad(`usage: ${VERBS.join(' | ')} (the verb comes first)`);
  const o = { verb, ...flagsOf(rest) };
  if (verb !== 'tick' && verb !== 'list') o.pr = wholeNumber(o.pr, '--pr');
  if (verb === 'add') {
    if (!BANDS.includes(o.band)) throw bad(`--band must be one of ${BANDS.join(', ')}`);
    if (!SHA40.test(String(o.head))) throw bad('--head must be a 40-character lowercase commit sha');
    o.round = o.round === undefined ? 1 : wholeNumber(o.round, '--round');
  }
  if (verb === 'decide' && !KINDS.includes(o.kind)) throw bad(`--kind must be one of ${KINDS.join(', ')}`);
  if (verb === 'drop' && !String(o.reason ?? '').trim()) throw bad('--reason is required');
  return o;
}

// ---- dependencies and files ----

/** The queue settings: matrix.slot of the router config when it reads and parses, else the built-in DEFAULTS (a missing or broken file never stops a tick). */
function loadConfig(file) {
  try { return configOf(JSON.parse(readFileSync(file, 'utf8'))); } catch { return configOf({}); }
}

/** Deps with defaults. An undefined entry in `deps` is ignored, so a test can pass `checkPr: undefined`. */
function withDefaults(deps = {}) {
  const given = Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined));
  const d = {
    gh: ghApi, now: () => Date.now(), statePath: DEFAULT_STATE, configPath: DEFAULT_CONFIG, repo: DEFAULT_REPO, env: process.env, lockWaitMs: 5000,
    out: (l) => console.log(l), err: (l) => console.error(l), ...given,
  };
  return { ...d, cfg: { ...loadConfig(d.configPath), ...(given.cfg ?? {}) }, checkPr: given.checkPr ?? ((pr) => checkPr({ pr, repo: d.repo }, crDeps(d))) };
}

/** The deps cr-paid.mjs reads. Its clock gives a Date. A path left undefined keeps its own default. */
function crDeps(d) {
  const out = { gh: d.gh, now: () => new Date(d.now()), env: d.env };
  if (d.ledgerPath) out.ledgerPath = d.ledgerPath;
  if (d.pathFilters) out.pathFilters = d.pathFilters;
  return out;
}

function readState(file) {
  let text = null;
  try { text = readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return parseState(text);
}

function writeState(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw err;
  }
}

const LOCK_BUSY = Object.freeze({ busy: true });

/** Runs fn under the state file lock. LOCK_BUSY when another live session holds it past lockWaitMs. */
function locked(d, fn) {
  mkdirSync(path.dirname(d.statePath), { recursive: true });
  const r = withLock(d.statePath, { lockWaitMs: d.lockWaitMs }, fn);
  return r?.ok === false && r?.reason === 'lock' ? LOCK_BUSY : r;
}

const refuse = (reason, extra = {}) => ({ code: 2, body: { ok: false, reason, ...extra } });
const writeVerb = (d, fn) => {
  const r = locked(d, fn);
  return r === LOCK_BUSY ? refuse('the queue file is locked by another session; run the command again in a moment') : r;
};

const sessionOf = (a, d) => a.session ?? d.env.CLAUDE_CODE_SESSION_ID ?? d.env.CLAUDE_SESSION_ID ?? 'unknown';
const minutesUntil = (at, now) => Math.max(0, Math.ceil((at - now) / MIN));

function viewOf(state, d) {
  const now = d.now();
  return { rows: rowsOf(state, now, d.cfg), nextSlotInMin: minutesUntil(slotOpensAt(state, d.cfg), now) };
}

// ---- GitHub facts ----

const stampsOf = (list, field) => list.map((x) => Date.parse(x?.[field] ?? '')).filter(Number.isFinite);

function lightFacts(pr, pull) {
  return {
    pr, open: pull.state === 'open', merged: pull.merged === true, head: String(pull.head?.sha ?? '').toLowerCase(), reviewedHead: false,
    pending: false, limited: false, retryMinutes: null, reviewAts: [], requestAts: [], carryHolds: false,
  };
}

function fullFacts(base, d) {
  const [owner, name] = d.repo.split('/');
  const { pr, head } = base;
  const statuses = d.gh([`repos/${d.repo}/commits/${head}/status`]).statuses ?? [];
  const reviews = [d.gh(['--paginate', '--slurp', `repos/${d.repo}/pulls/${pr}/reviews?per_page=100`])].flat(2);
  const { comments, commentEdits } = readIssueComments(d.gh, owner, name, pr);
  const headCommittedAt = d.gh([`repos/${d.repo}/commits/${head}`]).commit?.committer?.date;
  const cr = codeRabbitHeadReview({ head, reviews, comments, statuses, commentEdits, headCommittedAt, nowMs: d.now() });
  const botReviews = reviews.filter((r) => isCodeRabbitUser(r?.user) && String(r.body ?? '').trim() !== '');
  return {
    ...base, reviewedHead: cr.reviewedHead, pending: cr.status === 'pending', limited: cr.rateLimited, retryMinutes: cr.retryMinutes,
    reviewAts: stampsOf(botReviews, 'submitted_at'), requestAts: stampsOf(coderabbitRequestComments(comments), 'created_at'),
    carryHolds: d.carryHolds ? d.carryHolds(pr) === true : false,
  };
}

/** The facts of one PR. An awaiting-fix item on its own head reads the pull only; a closed PR needs nothing more. Throws on a read error. */
export function readFacts(pr, d, item = null) {
  const base = lightFacts(pr, d.gh([`repos/${d.repo}/pulls/${pr}`]));
  const waiting = item?.state === 'awaiting-fix' && item.head === base.head;
  return base.open && !waiting ? fullFacts(base, d) : base;
}

/**
 * The facts of every live item. An item whose read fails (a 404, say) gets none: settle and claim leave it as it is, so it cannot stop
 * the others. When every read fails the first error is thrown: that is an outage, and a tick must then write nothing (F16).
 */
function readAllFacts(state, d) {
  const facts = {};
  const failures = [];
  for (const it of state.items.filter((x) => !isDone(x))) {
    try { facts[it.pr] = readFacts(it.pr, d, it); } catch (err) { failures.push(err); }
  }
  if (failures.length > 0 && Object.keys(facts).length === 0) throw failures[0];
  return facts;
}

const PAID_TRIES = 3;

const safeVerdict = (d, pr) => {
  try { return d.checkPr(pr) ?? { verdict: null, reason: 'no answer' }; } catch (err) { return { verdict: null, reason: firstLine(err) }; }
};

/** The cr-paid verdicts of the items due their 30-minute ask, read before the lock: each read is about 6 gh calls (m6). */
function readVerdicts(state, d) {
  const now = d.now();
  const due = state.items.filter((it) => timers(it, now, d.cfg, state.holder).askPaid);
  return Object.fromEntries(due.map((it) => [it.pr, safeVerdict(d, it.pr)]));
}

// ---- tick ----

const recent = (state, d) => {
  const age = d.now() - (state.lastTickAt ?? 0);
  return age >= 0 && age < d.cfg.dedupe_min * MIN;
};

const slotWord = (row) => (row.nextSlotInMin > 0 ? ` Next slot in about ${row.nextSlotInMin} minutes.` : ' The slot is free now.');

const queuedText = (row) => `PR #${row.pr}: queued for the free CodeRabbit slot, ${row.position} of ${row.total}.${slotWord(row)}`;
const stuckText = (pr) => `PR #${pr}: two free-slot posts made no review, so the item is stuck. Type /slot drop ${pr} to remove it, or /slot wait ${pr} to try again.`;
const timeoutText = (pr) => `PR #${pr}: no free slot for 60 minutes; still queued; READY still needs a CodeRabbit review. Type /slot pay ${pr} or /slot wait ${pr}.`;

function paidText(pr, v) {
  if (v.verdict === 'ALLOW') return `PR #${pr}: no free slot for 30 minutes. Paid round $${Number(v.cost).toFixed(2)} (cr-paid ALLOW). Type /slot pay ${pr}, or wait.`;
  return `PR #${pr}: no free slot for 30 minutes. A paid round is not allowed (${v.reasons?.[0] ?? 'cr-paid ESCALATE'}). Type /slot wait ${pr} to keep waiting.`;
}

/** Toasts for what changed between two states of the same file: queued, reviewed, stuck. Posts and asks make their own. */
function changeActions(before, after, d) {
  const old = new Map(before.items.map((it) => [it.pr, it]));
  const rows = new Map(rowsOf(after, d.now(), d.cfg).map((r) => [r.pr, r]));
  return after.items.flatMap((it) => {
    const was = old.get(it.pr)?.state;
    if (was === it.state) return [];
    if (was === 'opening' && (it.state === 'queued' || it.state === 'timed-out')) return [toast(it.pr, queuedText(rows.get(it.pr)))];
    if (it.state === 'done' && it.dropReason === undefined) return [toast(it.pr, `PR #${it.pr}: CodeRabbit reviewed head ${it.head.slice(0, 7)}.`)];
    return it.state === 'stuck' ? [toast(it.pr, stuckText(it.pr))] : [];
  });
}

/** Takes the slot for the first item that has facts: sets the holder. { state, item } with item null when nothing is picked. */
function claim(state, facts, now, d, session) {
  const known = { ...state, items: state.items.filter((it) => facts[it.pr]) };
  const item = pickNext(known, now, d.cfg, facts);
  if (!item) return { state, item: null };
  return { state: { ...state, holder: { pr: item.pr, head: item.head, at: now, session } }, item };
}

function tryPost(item, d) {
  try {
    d.gh(['-X', 'POST', `repos/${d.repo}/issues/${item.pr}/comments`, '-f', `body=${REVIEW_COMMENT}`]);
    return { ok: true };
  } catch (err) { return { ok: false, reason: firstLine(err) }; }
}

/** The state after a post try, and its toast. A failed post clears the holder and backs the slot off, so a standing error does not retry every tick. */
function afterPost(state, item, res, now) {
  if (!res.ok) {
    const slot = { ...state.slot, nextAt: Math.max(state.slot.nextAt ?? 0, now + POST_BACKOFF_MIN * MIN) };
    return { state: { ...state, holder: null, slot }, actions: [toast(item.pr, `PR #${item.pr}: the free-slot post failed (${res.reason}). It stays queued; the next try is in ${POST_BACKOFF_MIN} minutes.`)] };
  }
  const items = state.items.map((it) => (it.pr === item.pr ? { ...it, state: 'posted' } : it));
  const slot = { ...state.slot, lastPostAt: now, lastPostPr: item.pr, source: 'post' };
  return { state: { ...state, items, slot }, actions: [toast(item.pr, `PR #${item.pr}: free slot taken, ${REVIEW_COMMENT} posted.`)] };
}

const readFailText = (pr, v) => `PR #${pr}: no free slot for 30 minutes. The paid-round check could not be read (${v.reason ?? 'no reason'}). Type /slot pay ${pr} to try it again, or /slot wait ${pr} to keep waiting.`;

/** The paid ask from a verdict read before the lock. No verdict counts as a failed read (item.verdictFails); the third one gives up with one toast. */
function askPaid(it, v) {
  if (v === undefined) return { item: it, actions: [] };
  const asked = { ...it.asked, paid30: true };
  if (v.verdict) return { item: { ...it, asked }, actions: [toast(it.pr, paidText(it.pr, v))] };
  const fails = (it.verdictFails ?? 0) + 1;
  if (fails < PAID_TRIES) return { item: { ...it, verdictFails: fails }, actions: [] };
  return { item: { ...it, verdictFails: fails, asked }, actions: [toast(it.pr, readFailText(it.pr, v))] };
}

function askOne(it, t, verdicts) {
  if (t.askPaid) return askPaid(it, verdicts[it.pr]);
  if (it.state === 'timed-out' && !it.asked?.timeout60) return { item: { ...it, asked: { ...it.asked, timeout60: true } }, actions: [toast(it.pr, timeoutText(it.pr))] };
  return { item: it, actions: [] };
}

/** The 30-minute paid ask (CRITICAL) and the 60-minute time-out toast, each once per item (asked.*). Reads nothing: verdicts come in. */
function askTimers(state, now, d, verdicts) {
  const steps = state.items.map((it) => askOne(it, timers(it, now, d.cfg, state.holder), verdicts));
  return { state: { ...state, items: steps.map((s) => s.item) }, actions: steps.flatMap((s) => s.actions) };
}

function tickLocked(a, d, facts, verdicts) {
  const before = readState(d.statePath);
  if (recent(before, d)) return { code: 0, body: { ok: true, effective: false, locked: false, actions: [], ...viewOf(before, d) } };
  const now = d.now();
  const settled = settle(before, facts, now, d.cfg);
  const claimed = claim(settled, facts, now, d, sessionOf(a, d));
  if (claimed.item) writeState(d.statePath, { ...claimed.state, lastTickAt: now });
  const posted = claimed.item ? afterPost(claimed.state, claimed.item, tryPost(claimed.item, d), now) : { state: claimed.state, actions: [] };
  const asked = askTimers(posted.state, now, d, verdicts);
  const final = { ...asked.state, lastTickAt: now };
  writeState(d.statePath, final);
  const actions = [...changeActions(before, final, d), ...posted.actions, ...asked.actions];
  return { code: 0, body: { ok: true, effective: true, locked: false, actions, ...viewOf(final, d) } };
}

function tickVerb(a, d) {
  const first = readState(d.statePath);
  if (recent(first, d) || !first.items.some((it) => !isDone(it))) return { code: 0, body: { ok: true, effective: false, locked: false, actions: [], ...viewOf(first, d) } };
  const facts = readAllFacts(first, d);
  const verdicts = readVerdicts(first, d);
  const r = locked(d, () => tickLocked(a, d, facts, verdicts));
  return r === LOCK_BUSY ? { code: 0, body: { ok: true, effective: false, locked: true, actions: [], ...viewOf(first, d) } } : r;
}

// ---- add, list, probe ----

function newItem(a, d) {
  const now = d.now();
  const sample = a.band === 'SAMPLE';
  const state = a.round > 1 ? 'awaiting-fix' : sample ? 'queued' : 'opening';
  return {
    pr: a.pr, head: a.head, band: a.band, escalated: a.escalated, round: a.round, state, queuedAt: state === 'queued' ? now : 0, addedAt: now,
    posts: 0, pin: false, asked: { paid30: false, timeout60: false }, session: sessionOf(a, d),
  };
}

/** The item an add leaves in the file: the same round on a live item changes nothing, anything else is a new item. */
function addedItem(a, d, old) {
  if (old && !isDone(old) && old.round >= a.round) return old;
  return newItem(a, d);
}

function addLocked(a, d) {
  const state = readState(d.statePath);
  const old = state.items.find((it) => it.pr === a.pr);
  const item = addedItem(a, d, old);
  const next = { ...state, items: [...state.items.filter((it) => it.pr !== a.pr), item] };
  if (item !== old) writeState(d.statePath, next);
  const view = viewOf(next, d);
  const row = view.rows.find((r) => r.pr === a.pr);
  return { code: 0, body: { ok: true, item, position: row.position, total: row.total, nextSlotInMin: view.nextSlotInMin } };
}

const addVerb = (a, d) => writeVerb(d, () => addLocked(a, d));

function listVerb(a, d) {
  return { code: 0, body: { ok: true, ...viewOf(readState(d.statePath), d) } };
}

const probeVerb = (a, d) => ({ code: 0, body: { ok: true, facts: readFacts(a.pr, d) } });

// ---- decide, drop ----

const decision = (kind, it, now) => ({ kind, head: it.head, at: now, by: 'dave' });
const replaceItem = (state, item) => ({ ...state, items: state.items.map((it) => (it.pr === item.pr ? item : it)) });

function waitItem(it, now) {
  const reopen = it.state === 'timed-out' || it.state === 'stuck';
  return {
    ...it, queuedAt: now, asked: { paid30: false, timeout60: false }, verdictFails: 0, state: reopen ? 'queued' : it.state,
    posts: it.state === 'stuck' ? 0 : it.posts, decision: decision('wait', it, now),
  };
}

/** Why a paid round may not go out now, or null. Checked before any verdict is read. */
function payRefusal(a, state, it, d) {
  if (it.state === 'posted') return `PR ${a.pr} is already posted: a review was requested for this head. Wait for CodeRabbit, or type /slot drop ${a.pr}.`;
  if (state.holder) return `PR ${state.holder.pr} holds the free slot (it expires ${d.cfg.holder_max_min} minutes after its post). Type /slot pay ${a.pr} again after that.`;
  if (it.decision?.kind === 'pay' && it.decision.head === it.head) return `PR ${a.pr}: Dave already paid for this head; a second paid round needs a new head.`;
  return null;
}

/** The file after a paid post: the item is posted on the head cr-paid read, and the paid post takes the holder and the spacing like a free one (C10). */
function paidState(state, it, a, d, v) {
  const now = d.now();
  const head = v.head ?? it.head;
  const item = { ...it, head, state: 'posted', decision: decision('pay', { head }, now) };
  const slot = { ...state.slot, lastPostAt: now, lastPostPr: a.pr, source: 'post' };
  return { ...replaceItem(state, item), holder: { pr: a.pr, head, at: now, session: sessionOf(a, d) }, slot };
}

const paidFailure = (d, err) => refuse(
  `the paid post failed (${firstLine(err)}); the round is counted and the item is marked posted. If no review comes in ${d.cfg.holder_max_min} minutes it returns to the queue.`,
  { posted: false },
);

/**
 * Order: the ledger row and the posted state first, the POST last. Every failure then errs toward counting a round that was not bought,
 * never toward a paid post that is not counted. A ledger error posts nothing and leaves the file as it was.
 */
function payLocked(a, d, state, it) {
  const refused = payRefusal(a, state, it, d);
  if (refused) return refuse(refused, { posted: false });
  const v = d.checkPr(a.pr);
  if (!v?.verdict) return refuse(`no cr-paid verdict (${v?.reason ?? 'unknown'})`, { posted: false });
  if (v.verdict !== 'ALLOW') return { code: 3, body: { ok: false, verdict: v.verdict, reasons: v.reasons ?? [], posted: false } };
  recordPaid({ pr: a.pr, head: v.head, files: v.files }, crDeps(d));
  writeState(d.statePath, paidState(state, it, a, d, v));
  try { d.gh(['-X', 'POST', `repos/${d.repo}/issues/${a.pr}/comments`, '-f', `body=${v.comment}`]); } catch (err) { return paidFailure(d, err); }
  return { code: 0, body: { ok: true, verdict: 'ALLOW', cost: v.cost, files: v.files, posted: true } };
}

function decideLocked(a, d) {
  const state = readState(d.statePath);
  const it = state.items.find((x) => x.pr === a.pr);
  if (!it || isDone(it)) return refuse(`no live queue item for PR ${a.pr}`);
  if (a.kind === 'pay') return payLocked(a, d, state, it);
  if (a.kind === 'wait' && !WAITABLE.includes(it.state)) return refuse(`PR ${a.pr} is ${it.state}; /slot wait restarts the clock of a queued, timed-out or stuck item only`);
  const next = a.kind === 'first' ? { ...it, pin: true, decision: decision('first', it, d.now()) } : waitItem(it, d.now());
  writeState(d.statePath, replaceItem(state, next));
  return { code: 0, body: { ok: true, item: next, posted: false } };
}

const decideVerb = (a, d) => writeVerb(d, () => decideLocked(a, d));

function dropLocked(a, d) {
  const state = readState(d.statePath);
  const it = state.items.find((x) => x.pr === a.pr);
  if (a.reason === 'sample-ttl' && it && it.band !== 'SAMPLE') return refuse(`PR ${a.pr} is not a SAMPLE item, so sample-ttl does not drop it`);
  if (!it || isDone(it)) return { code: 0, body: { ok: true, dropped: false } };
  const holder = state.holder?.pr === a.pr ? null : state.holder;
  writeState(d.statePath, { ...replaceItem(state, { ...it, state: 'dropped', dropReason: a.reason }), holder });
  return { code: 0, body: { ok: true, dropped: true } };
}

const dropVerb = (a, d) => writeVerb(d, () => dropLocked(a, d));

// ---- output and main ----

const VERB_FUNCS = { tick: tickVerb, add: addVerb, list: listVerb, decide: decideVerb, drop: dropVerb, probe: probeVerb };

const rowLine = (r) => `#${r.pr} ${r.band} ${r.state}${r.position ? ` ${r.position} of ${r.total}` : ''} queued ${r.queuedMin} min, posts ${r.posts}${r.dropReason ? `, ${r.dropReason}` : ''}`;

function textLines(body) {
  const lines = (body.actions ?? []).map((a) => a.text);
  if (body.rows) lines.push(...body.rows.map(rowLine));
  return lines.length > 0 || body.rows ? lines : [JSON.stringify(body)];
}

function emit(d, a, res) {
  if (res.body.ok === false) return fail(d, a.json, res.body.reason ?? `${res.body.verdict}: ${(res.body.reasons ?? []).join('; ')}`, res);
  if (a.json) d.out(JSON.stringify(res.body));
  else textLines(res.body).forEach((l) => d.out(l));
  return res.code;
}

function fail(d, json, reason, res = { code: 2, body: { ok: false, reason } }) {
  if (json) d.out(JSON.stringify(res.body));
  else d.err(String(reason).startsWith('slot-queue:') ? reason : `slot-queue: ${reason}`);
  return res.code;
}

/** Runs one command and returns the exit code. Output goes to deps.out and deps.err. */
export function main(argv, deps) {
  const d = withDefaults(deps);
  try {
    const a = parseArgs(argv);
    const res = VERB_FUNCS[a.verb](a, d);
    return emit(d, a, res);
  } catch (err) {
    return fail(d, argv.includes('--json'), firstLine(err));
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) process.exitCode = main(process.argv.slice(2));
