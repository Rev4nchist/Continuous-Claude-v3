// The store of offers and decisions behind the pathway-flow-v2 questions (design N1, .claudedocs/2026-11-06-pathway-flow-v2-design.md).
// Tests: scripts/github/decisions.test.mjs.
//
// An OFFER is a question the model must ask Dave with AskUserQuestion: its options are fixed by a script, not by the model.
// A DECISION is Dave's tap: the exact label of an open offer. A decision is bound to (step, key, head) and is used up once.
// The AskUserQuestion hook calls decisionRecord. The engine, the mod and the gates call decisionRead and decisionUse.
//
// Steps: ship (commit and push), open-pr, review, land, paid-round. Key: the repo plus a PR number or a branch (decisionKey).
// File: one JSON object { version, offers, decisions, misses }, each a map keyed by the triple. Writes run under file-lock.mjs and
// replace the file by a rename. Reads take no lock and never throw: a missing or corrupt file reads as empty (fail closed: no decision).
// Corrupt includes a section that is not a plain object (an array, a string, null): the whole store reads as empty and the next write repairs it.
// Entries older than a week are dropped at the next write.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { withLock } from './file-lock.mjs';

/** The env var that moves the store (tests). */
export const DECISIONS_ENV = 'CCV3_DECISIONS_FILE';
export const STEPS = Object.freeze(['ship', 'open-pr', 'review', 'land', 'paid-round', 'cli-skip']);
/** Dave may be asked again this many times after a miss. Miss 1 and 2 re-ask; miss 3 stops (missBump returns 3). */
export const MAX_REASKS = 2;
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** A miss count older than this is dropped: the re-asks are one quick loop, and a stop must not block a PR for good. */
const MISS_TTL_MS = 60 * 60 * 1000;
const liveMisses = (m) => (m && Date.now() - Date.parse(m.at) <= MISS_TTL_MS ? m.count : 0);

/**
 * The home folder from the OS account record, never from HOME or USERPROFILE (a command can set those for its own run). It falls back to os.homedir() only when the
 * account record cannot be read. A paying run (cr-paid.mjs postPaid) refuses when the two differ, so a moved home is loud there; in a normal session they are equal.
 */
export const accountHome = () => {
  try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); }
};

/** The store file: $CCV3_DECISIONS_FILE, else <account home>/.claude/state/ccv3-mods/decisions.json. */
export const decisionsPath = (env = process.env) => env[DECISIONS_ENV] || path.join(accountHome(), '.claude', 'state', 'ccv3-mods', 'decisions.json');

/** The key of a PR (`repo#12`) or of a branch (`repo@feat/x`). A PR number wins when both are given. */
export const decisionKey = ({ repo = REPO, pr, branch }) => (pr !== undefined && pr !== null ? `${repo}#${pr}` : `${repo}@${branch}`);

const empty = () => ({ version: 1, offers: {}, decisions: {}, misses: {} });
const idOf = ({ step, key, head }) => `${step}\n${key}\n${String(head).toLowerCase()}`;
const isText = (v) => typeof v === 'string' && v !== '';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The store, or an empty one when the file is missing, malformed, or has a section (offers, decisions, misses) that is not a plain object. */
function readStore(file) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (!isPlain(s)) return empty();
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? store : empty();
  } catch { return empty(); }
}

function writeStore(file, store) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(store, null, 2)}\n`;
  writeFileSync(tmp, text);
  try { renameSync(tmp, file); } catch {
    try { unlinkSync(tmp); } catch { /* gone */ }
    writeFileSync(file, text);
  }
}

function prune(store, now) {
  for (const group of [store.offers, store.decisions, store.misses]) {
    for (const [id, row] of Object.entries(group)) {
      if (!(now - Date.parse(row?.at) <= MAX_AGE_MS)) delete group[id];
    }
  }
}

/**
 * The store for a writer that must not replace what it cannot read. { store } when the file is not there (a missing store is an empty one) or reads
 * well. { unreadable: true } for any other read error (a lock held by a scanner, a folder in its place), text that does not parse, or a store of the
 * wrong shape: such a file may hold taps of other PRs.
 */
function readStoreStrict(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? { store: empty() } : { unreadable: true }; }
  try {
    const s = JSON.parse(text);
    if (!isPlain(s)) return { unreadable: true };
    const store = { ...empty(), ...s };
    return [store.offers, store.decisions, store.misses].every(isPlain) ? { store } : { unreadable: true };
  } catch { return { unreadable: true }; }
}

/**
 * Runs fn(store) under the lock and saves the store. Returns fn's value, or { ok: false, reason: 'lock' }.
 * `strict` (opt-in; every old call is unchanged): a store that exists but cannot be read is refused, nothing is written: { ok: false, reason: 'unreadable-store' }.
 * The other writers keep the design of the header: an unreadable store reads as empty and their write repairs it.
 */
function update(fn, { strict = false } = {}) {
  const file = decisionsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const locked = withLock(file, {}, () => {
    let store;
    if (strict) {
      const read = readStoreStrict(file);
      if (read.unreadable) return { ok: false, reason: 'unreadable-store', detail: `the decision store ${file} exists but cannot be read or parsed: repair or delete it` };
      store = read.store;
    } else store = readStore(file);
    prune(store, Date.now());
    const out = fn(store);
    writeStore(file, store);
    return out;
  });
  return locked;
}

/** Why a spec cannot be an offer, or null. 2 to 4 options with distinct text labels. */
function specProblem(spec) {
  const options = spec?.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return 'the spec needs 2 to 4 options';
  const labels = options.map((o) => o?.label);
  if (!labels.every(isText)) return 'every option needs a text label';
  return new Set(labels).size === labels.length ? null : 'the option labels must differ';
}

/**
 * offerWrite({ step, key, head, spec, tree, cwd }) -> { ok: true, nonce } | { ok: false, reason }.
 * Opens the question for (step, key, head). It drops an older decision for the triple (a new question needs a new tap) and keeps the miss
 * count (a re-ask must not reset it). It closes every other open offer with the same step and key (older heads), so a stale offer takes no tap. spec is { header, question, options: [{ label, ... }] }; extra keys are stored as given.
 * Do not call it when you still want to use a recorded decision.
 */
export function offerWrite({ step, key, head, spec, tree, cwd }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return { ok: false, reason: 'bad-offer: step, key and head are needed' };
  const bad = specProblem(spec);
  if (bad) return { ok: false, reason: `bad-offer: ${bad}` };
  return update((store) => {
    const id = idOf({ step, key, head });
    const nonce = randomUUID();
    // An older head's offer of the same step and key must not take a later tap: close it (the stale tap then records nothing).
    for (const other of Object.values(store.offers)) {
      if (other?.step === step && other?.key === key && other.open === true) other.open = false;
    }
    store.offers[id] = { nonce, step, key, head: String(head).toLowerCase(), tree: tree ?? null, cwd: cwd ?? null, spec, labels: spec.options.map((o) => o.label), at: new Date().toISOString(), open: true };
    delete store.decisions[id];
    return { ok: true, nonce };
  });
}

/**
 * decisionRecord({ step, key, head, label }) -> { ok: true } | { ok: false, reason }.
 * Records only an EXACT label of the open offer for the triple, then closes the offer. Reasons: no-open-offer, no-match, lock.
 * A label that ends the question (such as "Keep open") is still a decision: the reader decides what a label means.
 */
export function decisionRecord({ step, key, head, label, entry }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return { ok: false, reason: 'no-open-offer' };
  return update((store) => {
    const id = idOf({ step, key, head });
    const offer = store.offers[id];
    if (!offer || offer.open !== true) return { ok: false, reason: 'no-open-offer' };
    if (typeof label !== 'string' || !offer.labels.includes(label)) return { ok: false, reason: 'no-match' };
    // tapAt is the time of Dave's tap and `entry` the entry point of the process that recorded it (CLAUDE_CODE_ENTRYPOINT of the hook). Both are stamped
    // here, once, on EVERY decision: a paid post later ages on tapAt and reads the stamp (card prflow-paid-run-guard). A call with no entry stamps null.
    const at = new Date().toISOString();
    store.decisions[id] = { label, at, tapAt: at, entry: isText(entry) ? entry : null, tree: offer.tree, nonce: offer.nonce };
    offer.open = false;
    delete store.misses[id];
    return { ok: true };
  });
}

/** decisionRead({ step, key, head }) -> { label, at } | null. No lock; any read error is null. */
export function decisionRead({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return null;
  const d = readStore(decisionsPath()).decisions[idOf({ step, key, head })];
  return d && typeof d.label === 'string' ? { label: d.label, at: d.at } : null;
}

/** The label, the row time, the tap time and the entry stamp of a stored row. A missing or non-text tapAt or entry is null (never defaulted). */
const stampedRow = (d) => ({ label: d.label, at: d.at, tapAt: isText(d.tapAt) ? d.tapAt : null, entry: isText(d.entry) ? d.entry : null });

/** decisionRowRead({ step, key, head }) -> { label, at, tapAt, entry } | null. Like decisionRead, with the stamp. No lock; any read error is null. */
export function decisionRowRead({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return null;
  const d = readStore(decisionsPath()).decisions[idOf({ step, key, head })];
  return d && typeof d.label === 'string' ? stampedRow(d) : null;
}

/** The cap in whole cents that a label names with "up to $X" (up to 2 decimals), or null: a label with no price is no paid yes. Only a positive price counts. */
export function capCentsOfLabel(label) {
  const m = /up to \$(\d+(?:\.\d{1,2})?)/.exec(String(label ?? ''));
  const cents = m ? Math.round(Number(m[1]) * 100) : 0;
  return cents > 0 ? cents : null;
}

/**
 * paidRoundWrite({ key, head, label, tapAt, entry }) -> { ok: true } | { ok: false, reason }. Writes the one paid yes of a paid pick: step `paid-round`,
 * the PR key, the head, the tapped label, the tap's own time (tapAt) and the tap's entry stamp, both copied from the tap the confirm used up.
 * The row keeps its own `at` (now) for the prune. It writes nothing for a label with no price, or a tapAt or entry that is not text:
 * no price, no yes; no stamp, no yes. It replaces an older row of the same triple.
 */
export function paidRoundWrite({ key, head, label, tapAt, entry }) {
  if (!isText(key) || !isText(head)) return { ok: false, reason: 'bad-row: key and head are needed' };
  if (capCentsOfLabel(label) === null) return { ok: false, reason: 'no-price: the tapped label names no price' };
  if (!isText(tapAt) || !isText(entry)) return { ok: false, reason: 'no-stamp: the tap has no tap time or entry point' };
  return update((store) => {
    store.decisions[idOf({ step: 'paid-round', key, head })] = { label, at: new Date().toISOString(), tapAt, entry, tree: null, nonce: null };
    return { ok: true };
  });
}

/**
 * decisionUse({ step, key, head, label? }) -> { ok: true } | { ok: false, reason }. Uses the decision up (call it AFTER the action succeeds). Resets the miss count.
 * With a label, the row is used only when its label is that one, else { ok: false, reason: 'label-changed' } and the row stays: a tap that Dave recorded
 * between the read and the use is not used up by the decision that was read (PR 576 follow-up, item 2). No label: the row is used whatever its label.
 * Two more guards, both optional (an old call behaves as before), both judged inside the lock on the stored row, after the label check:
 * `at` (the tap time that was read): a row with another time is a newer tap of the same label, { ok: false, reason: 'tap-changed' } and it stays.
 * `check(row) -> boolean`: false is { ok: false, reason: 'slot-changed' } and the row stays (the caller judges the row against a clock read at the use).
 * `paidRound` (card prflow-paid-run-guard, seat option A): in the SAME lock that uses the tap up, the paid-round row of the same key and head is written from the used
 * row (its label, tapAt and entry stamp). The tap and its paid row are one step: a drop of the taps before the use leaves no tap and so no row; a drop after it removes the
 * row. The result then carries `paid`: { ok: true } or { ok: false, reason } (no price, no stamp: the tap is still used up and no row is written).
 */
export function decisionUse({ step, key, head, label, at, check, returnRow = false, paidRound = false }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return { ok: false, reason: 'no-decision' };
  return update((store) => {
    const id = idOf({ step, key, head });
    if (typeof label === 'string' && store.decisions[id] && store.decisions[id].label !== label) return { ok: false, reason: 'label-changed' };
    if (typeof at === 'string' && store.decisions[id] && store.decisions[id].at !== at) return { ok: false, reason: 'tap-changed' };
    if (typeof check === 'function' && store.decisions[id] && check(store.decisions[id]) !== true) return { ok: false, reason: 'slot-changed' };
    const row = store.decisions[id];
    delete store.decisions[id];
    delete store.offers[id];
    delete store.misses[id];
    if (!row) return { ok: false, reason: 'no-decision' };
    const paid = paidRound === true ? paidRowFrom(store, { key, head, row }) : null;
    // `returnRow`: the used row's stamp, taken inside the lock before the delete (a paid confirm copies it; no other caller asks for it).
    return { ok: true, ...(returnRow === true ? { row: stampedRow(row) } : {}), ...(paid ? { paid } : {}) };
  });
}

/** Writes the paid-round row of a used tap into the store under the lock the caller holds. { ok: true } or { ok: false, reason }: the same refusals as paidRoundWrite (no price, no stamp). */
function paidRowFrom(store, { key, head, row }) {
  const stamp = stampedRow(row);
  if (capCentsOfLabel(stamp.label) === null) return { ok: false, reason: 'no-price: the tapped label names no price' };
  if (!isText(stamp.tapAt) || !isText(stamp.entry)) return { ok: false, reason: 'no-stamp: the tap has no tap time or entry point' };
  store.decisions[idOf({ step: 'paid-round', key, head })] = { label: stamp.label, at: new Date().toISOString(), tapAt: stamp.tapAt, entry: stamp.entry, tree: null, nonce: null };
  return { ok: true };
}

/** missCount({ step, key, head }) -> the misses in the last hour (0 when none). */
export function missCount({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return 0;
  return liveMisses(readStore(decisionsPath()).misses[idOf({ step, key, head })]);
}

/**
 * missBump({ step, key, head }) -> the new count. Miss 1 and 2 may re-ask (MAX_REASKS); a count above MAX_REASKS means stop.
 * Fails closed: when the store cannot be locked it returns MAX_REASKS + 1.
 */
export function missBump({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return MAX_REASKS + 1;
  const r = update((store) => {
    const id = idOf({ step, key, head });
    const prior = store.misses[id];
    const count = liveMisses(prior) + 1;
    // Once the count is above MAX_REASKS the stop is on: a later miss must not restart its window (MISS_TTL_MS counts from `at`).
    const at = count - 1 > MAX_REASKS ? prior.at : new Date().toISOString();
    store.misses[id] = { count, at };
    return { ok: true, count };
  });
  return r.ok === true ? r.count : MAX_REASKS + 1;
}

/**
 * dropKey({ steps, key }) -> { ok: true, dropped } | { ok: false, reason }. Removes every decision, offer and miss of the listed steps for the key,
 * at ALL heads, in ONE locked update (a crash cannot leave half a drop). `dropped` is the number of rows removed. A bad call (no steps, an unknown
 * step, no key) removes nothing and returns reason 'bad-drop: ...'. The key matches whole: PR 7 never takes the rows of PR 70.
 * A store file that exists but cannot be read or parsed is refused (reason 'unreadable-store') and left as it was: replacing it with an empty store
 * would lose the taps of every other PR. A store that is not there is a good empty drop.
 * Used when a PR goes back to draft: a tap Dave made for the old question must not record for the new one (card prflow-paid-run-guard).
 */
export function dropKey({ steps, key } = {}) {
  if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => STEPS.includes(s)) || !isText(key)) return { ok: false, reason: 'bad-drop: steps and key are needed' };
  const prefixes = steps.map((step) => `${step}\n${key}\n`); // the id of idOf, up to the head
  return update((store) => {
    let dropped = 0;
    for (const group of [store.offers, store.decisions, store.misses]) {
      for (const id of Object.keys(group)) {
        if (prefixes.some((prefix) => id.startsWith(prefix))) { delete group[id]; dropped += 1; }
      }
    }
    return { ok: true, dropped };
  }, { strict: true });
}

/** The open offers: [{ nonce, step, key, head, tree, cwd, spec, labels, at }]. The AskUserQuestion hook matches an answer against them. */
export function offerList() {
  return Object.values(readStore(decisionsPath()).offers).filter((o) => o?.open === true);
}

/** The newest offer of the triple, open or closed, or null. The engine reads its spec.values to map a label to a pathway. */
export function offerRead({ step, key, head }) {
  if (!STEPS.includes(step) || !isText(key) || !isText(head)) return null;
  return readStore(decisionsPath()).offers[idOf({ step, key, head })] ?? null;
}
