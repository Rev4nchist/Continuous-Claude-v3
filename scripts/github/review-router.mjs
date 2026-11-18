#!/usr/bin/env node
/**
 * review-router.mjs: label a ready PR with its risk class and the PR bots that must review it (P3c, DW-80).
 * Spec: artifacts/ccv3-review-economy/router-spec.md. Config: review-router.config.json.
 * It spends no LLM credits. It never reviews, never merges, never removes a label.
 *
 * Usage: node scripts/github/review-router.mjs [<pr-number>] [--dry-run] [--repo owner/name]
 *          [--event opened|reopened|ready_for_review|synchronize] [--assume-ready] [--fixture file.json] [--config file.json]
 *   In GitHub Actions the PR number and event come from GITHUB_EVENT_PATH. Writes need GH_TOKEN.
 *   --dry-run     read-only gh calls, prints the planned writes. Always use it on a laptop first.
 *   --assume-ready  (dry run only) treat a draft or closed PR as an open ready one, to see what it would get.
 *   --fixture     read the PR, its files and its comments from a JSON file, not from gh (tests). Implies dry run.
 * Exit 0 = decision made, 2 = could not determine (nothing written).
 *
 * Memory: the router comment is the ONLY state. Actions keeps nothing between runs, and a label can be set by anyone.
 * The comment must be written by github-actions[bot] (type Bot) and start with the marker; a person's copy is ignored
 * and never edited. It holds <!-- review-router-state class=<x> head=<full sha> -->. No such comment = a first run.
 *   - first run: add the risk labels and the review labels. A review:* label a person set wins: only risk labels are added.
 *     A risk:* label a person set counts toward the class (it can only raise it).
 *   - later run: labels are added only when the class went UP. That includes a person's risk:* label above the comment
 *     class: it is a raise, and the router adds that class's review label.
 *   - an expected label that is missing with no rise means a person removed it. The router leaves it and writes
 *     held_reason "person_override". It never re-adds a risk:* or review:* label a person removed.
 *   - every run on an open ready PR rewrites the comment when its class or head changed, so READY can read
 *     which head the router has seen. A local run (no github-actions[bot] comment) must be --dry-run.
 *   - a hold in force is saved as held=<reason>. When the hold ends (deep_enabled on, credits under u2), the next
 *     run adds review:deep once ("released") and saves the state without the hold. After a config flip, re-run held
 *     PRs with workflow_dispatch; otherwise the release waits for the next push. A PR held by the router before
 *     held= existed (before 2026-10-27) has no saved hold: re-run it with workflow_dispatch BEFORE the flip, or a
 *     person adds review:deep by hand.
 *   - labeled / unlabeled by a person (risk:* or review:*): one ledger row with the label and the person, no writes.
 *   - PR checkpoint (spec 2026-10-28, section 3.3): at a person_override the comment also holds pathway=none|coderabbit|both
 *     (from the strongest review:* label) and pclass=<class at the checkpoint>. A later person_override or no_change run
 *     re-reads the pathway from the labels (no review:* label keeps the saved one) and keeps pclass. A raise keeps both.
 *     A ready_for_review with a review:* label is a new checkpoint only when a "pathway-confirmed head=<sha> pathway=<p>" marker comment (posted by /pathway before it marks the PR ready, by an OWNER, MEMBER or COLLABORATOR) names this head and the label's pathway: then pclass becomes the current class. Without one, pclass stays.
 *     A raise on a review:none PR adds risk:* only and posts "Class raised ... Call pr_checkpoint {pr}: it asks Dave whether to return the PR to draft and pick again.". A raise on a PR that
 *     already has review:coderabbit or review:deep-held adds neither of them (review:deep is still added when wanted).
 * Files: compare/<base>...<head sha> (pinned to the head), or the PR files list above 300 files.
 * Ledger: one JSON line on stdout, in $GITHUB_STEP_SUMMARY and in $RUNNER_TEMP/review-ledger.jsonl (the workflow uploads
 * it). On an error the line has decision "error" and the exit code is 2.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pullLabelNames, latestCodeRabbitSummary, codeRabbitNotice, commitsNamed, shaIsHead } from './review-status.mjs';
import { globToRegExp, matchGlob } from './lib/answer-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = 'Rev4nchist/Continuous-Claude-v3';

// ---------- glob: ** (whole segments, zero or more), * (one segment), ? (one char). Nothing else is special. ----------

export { globToRegExp, matchGlob };

// ---------- classes ----------

/** Higher number = higher risk. high is never set from paths. */
export const RANK = { docs: 0, normal: 1, high: 2, steering: 3, infra: 4, r3: 5 };
const PATH_CLASSES = ['r3', 'infra', 'steering', 'docs'];
const DEEP_CLASSES = new Set(['r3', 'infra', 'steering', 'high']);
const rank = (c) => RANK[c] ?? -1;

const normalizePath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

function compileClass(globs = []) {
  const pos = globs.filter((g) => !g.startsWith('!')).map(globToRegExp);
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
  return (p) => pos.some((re) => re.test(p)) && !neg.some((re) => re.test(p));
}

/** The PR class is the highest class of any path. A path that matches no class is normal. */
export function classify(paths, config) {
  const tests = PATH_CLASSES.map((c) => [c, compileClass(config.classes?.[c])]);
  const matched = {};
  let top = null;
  for (const raw of paths) {
    const p = normalizePath(raw);
    const c = tests.find(([, test]) => test(p))?.[0] ?? 'normal';
    matched[c] = (matched[c] ?? 0) + 1;
    if (top === null || rank(c) > rank(top)) top = c;
  }
  return { class: top ?? 'normal', matched };
}

// ---------- review band (.claudedocs/2026-11-01-review-matrix.md sections 2.1 to 2.3, option A) ----------

const LAND_STEP = 'scripts/github/' + ['land', 'pr'].join('-') + '.ps1';

/** The ONE trust-boundary list (seat ruling D1, card prflow-trust-list), in two parts. No second list elsewhere.
 *  - engine (engine spec 13.4): a non-test file here forces CRITICAL. cursor-review.mjs is the review-tree boundary (AGENT_FILES
 *    strip, buildAgentEnv secret strip, prepareReview); backends/** joined 2026-11-17 (card engine-backend-trust-band). prompt.mjs and
 *    context.mjs stay on matrix.control_plane only, so a prompt-tuning PR is not CRITICAL. lib/** also holds the decision store.
 *  - tap: forces no band. These files are meant to keep Dave's tap at every risk band (D1): the named guard hooks (Dave 2026-11-17:
 *    only the named guards, not every hook) with the built dist that runs, the decision gate and ledger, the land step and the scripts
 *    it runs, hook registration and its removal, the review router, its config, READY, the review-pick record and its question screen,
 *    paid review spend, the settings render with its machine overlay and overlay chooser, the paid run path with its queue rules and
 *    pay question model, the review bot configs (CodeRabbit, Greptile) and the reviewer agents and files. They do not force CRITICAL: CRITICAL plus a trust file earns a paid CodeRabbit review (pr-checkpoint.mjs crTrigger), and
 *    Dave's 2026-11-04 rule keeps CodeRabbit scarce (seat ruling 2026-11-17, option A).
 *  bandOf reports both parts in tapFiles. NOT IN FORCE YET: no code reads tapFiles; the prflow cards will. Until then the tap part
 *  changes nothing. checkpoint.critical stays the aegis + critic floor. */
export const TRUST_BOUNDARY = Object.freeze({
  engine: Object.freeze([
    'scripts/github/local-review.mjs', 'scripts/github/cursor-review.mjs', 'scripts/github/local-review/record.mjs', 'scripts/github/review-filter.mjs',
    'scripts/github/lib/**', 'scripts/github/local-review/backends/**',
  ]),
  tap: Object.freeze([
    // named guard hooks: source and built dist
    '.claude/hooks/src/*-guard.ts', '.claude/hooks/src/pre-pr-gate.ts', '.claude/hooks/dist/*-guard.mjs', '.claude/hooks/dist/pre-pr-gate.mjs',
    // decision gate and ledger (the store is lib/decisions.mjs, in the engine part through lib/**)
    '.claude/hooks/src/decision-gate.ts', '.claude/hooks/src/decision-ledger.ts',
    '.claude/hooks/dist/decision-gate.mjs', '.claude/hooks/dist/decision-ledger.mjs', 'scripts/github/ship-ask.mjs',
    // land step and the scripts it runs: the land-tap check, the migration gate, the push wrapper
    LAND_STEP, 'scripts/github/land-recheck.mjs', 'scripts/github/land-none-check.mjs', 'scripts/github/land-decision.mjs',
    'scripts/github/migration-gate.mjs', 'scripts/git-safe.ps1',
    // hook registration: a removed entry turns a guard off without a change to the guard (Dave 2026-11-17)
    '.claude/settings.json.template', 'scripts/settings/apply-registrations.mjs',
    // review router, its config, READY, the review-pick record, the pick question screen, paid review spend (Dave 2026-11-17)
    'scripts/github/review-router.mjs', 'review-router.config.json', 'scripts/github/review-status.mjs', 'scripts/github/pr-checkpoint.mjs',
    '.claude/plugins/*/hooks/pr-checkpoint/**', 'scripts/github/cr-paid.mjs',
    // Dave 2026-11-17 ("All of both groups"): the settings render and machine overlay (a settingsOverlay hooks array replaces the
    // template array), the paid run path, the review bot config and the reviewer agents.
    'scripts/settings/render-settings.mjs', 'machine/*.json',
    'scripts/github/cr-fix.mjs', 'scripts/github/slot-queue.mjs', '.claude/plugins/*/hooks/pr-loop/model.ts', '.claude/plugins/*/hooks/pr-loop/slot.ts',
    '.coderabbit.yaml', '.claude/agents/aegis.md', '.claude/agents/critic.md', '.claude/agents/security-refuter.md',
    // the agent .json mirrors also carry the model (every-surface checklist, row Agents); critic has no tracked mirror
    '.claude/agents/aegis.json', '.claude/agents/security-refuter.json',
    // Dave 2026-11-17 ("Tap list 2: All of them"; PR 646 aegis and critic): the overlay chooser, the registration remover, the queue
    // rules and the pay question model, the second bot config and the reviewer files in config_files. pre-pr.mjs stays off (Dave).
    'scripts/settings/machine-profile.mjs', 'scripts/settings/remove-registrations.mjs',
    'scripts/github/slot-queue-model.mjs', '.claude/plugins/*/hooks/pr-loop/slot-model.ts',
    '.greptile/**', '.claude/agents/principal-reviewer.md', 'REVIEW.md', '.claude/skills/security/SKILL.md', '.claude/rules-ondemand/pr-review-loop.md',
  ]),
});
/** The engine part: the files that force CRITICAL. The name stays for its importers. */
export const CRITICAL_TRUST_BOUNDARY = TRUST_BOUNDARY.engine;

const anyGlob = (globs = []) => { const res = globs.map(globToRegExp); return (p) => res.some((re) => re.test(p)); };

/**
 * bandOf(files, config, { labels, r }) -> { band, score, G, C, K, L, labelHigh, trustFiles, tapFiles, gateFiles, securityTier } | null
 *   tapFiles: the non-test files on either part of TRUST_BOUNDARY (engine or tap), same rename rule. It changes no band.
 *   files: path strings or { filename, previous_filename? } objects. A rename is ONE changed file with two names: it counts once,
 *   and a gate / config / logic test looks at both names (a rename into or out of the control plane counts).
 *   G gate files: non-test files on matrix.control_plane, any extension. C: a non-test review, merge or reviewer config file changed.
 *   K: one logic file outside dist/ and test files. L: a risk:high label, an r3 path or a non-test CRITICAL_TRUST_BOUNDARY file (forces CRITICAL). r: confirmed internal Majors, already
 *   weighted (+7 each); nothing posts that record yet, so callers pass 0. labelHigh: the risk:high label alone. trustFiles: the non-test
 *   CRITICAL_TRUST_BOUNDARY files. The interim CodeRabbit rule (pr-checkpoint.mjs bandRule) reads both. Score S = gate score + 3C + K + r. No matrix block: null.
 * Left out on purpose: H (needs both versions of settings.json.template), the split guard (reads other PRs) and the ratchet (needs saved state).
 */
export function bandOf(files, config, { labels = [], r = 0 } = {}) {
  const m = config?.matrix;
  if (!m) return null;
  const seen = new Map();
  for (const f of files ?? []) {
    const names = (typeof f === 'string' ? [f] : [f?.filename, f?.previous_filename]).filter(Boolean).map(normalizePath);
    if (names.length && !seen.has(names[0])) seen.set(names[0], names);
  }
  const entries = [...seen.values()];
  const isTest = (p) => m.test_markers.some((t) => `/${p}`.includes(t));
  const isLogic = (p) => !`/${p}`.includes('/dist/') && m.logic_ext.includes(path.posix.extname(p).slice(1));
  // The name that makes an entry count: the first non-test name that passes `match`.
  const hit = (names, match) => names.find((p) => !isTest(p) && match(p));
  const inPlane = anyGlob(m.control_plane);
  const inTrust = anyGlob(CRITICAL_TRUST_BOUNDARY);
  const gateFiles = entries.map((names) => hit(names, inPlane)).filter(Boolean);
  // Every name of a rename is checked, as for gateFiles: old path on the tier and new path off it (or the reverse) still counts.
  const inTier = anyGlob(m.security_tier);
  const securityTier = entries.map((names) => hit(names, (p) => inPlane(p) && inTier(p))).filter(Boolean);
  const G = gateFiles.length;
  const C = entries.some((names) => hit(names, anyGlob(m.config_files))) ? 1 : 0;
  const K = entries.some((names) => hit(names, isLogic)) ? 1 : 0;
  const labelHigh = labels.includes('risk:high');
  const trustFiles = entries.map((names) => hit(names, inTrust)).filter(Boolean);
  const inTap = anyGlob([...TRUST_BOUNDARY.engine, ...TRUST_BOUNDARY.tap]);
  const tapFiles = entries.map((names) => hit(names, inTap)).filter(Boolean);
  const L = labelHigh || classify(entries.flat(), config).class === 'r3' || trustFiles.length > 0;
  const gate = m.gate_score.reduce((best, [min, score]) => (G >= min && score > best ? score : best), 0);
  const score = gate + m.weights.config * C + m.weights.code * K + (Number.isFinite(r) && r > 0 ? r : 0);
  const band = L ? 'CRITICAL' : score >= m.bands.high ? 'HIGH' : score >= m.bands.elevated ? 'ELEVATED' : score >= m.bands.mid ? 'MID' : 'LOW';
  return { band, score, G, C, K, L, labelHigh, trustFiles, tapFiles, gateFiles, securityTier };
}

// ---------- credits ----------

/** credits_used_manual: a non-negative integer, else unknown. Unknown skips the u1 and u2 steps. */
export function creditsState(config, now = new Date()) {
  const g = config.greptile ?? {};
  const v = g.credits_used_manual;
  const used = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  const status = used === null ? 'unknown' : used >= g.u2_used ? 'u2' : used >= g.u1_used ? 'u1' : 'ok';
  const u3_due = Boolean(g.u3_date) && now.toISOString().slice(0, 10) >= g.u3_date;
  return { used, source: 'manual', status, u3_due };
}

// ---------- route: which labels and notes a class gets ----------

const HELD_APEX = 'High-risk PR. Greptile deep review is held (Apex billing, D3). Dave decides: wait, or land on CodeRabbit + xreview.';
const mention = (config) => (config.greptile?.notify_login ? ` @${config.greptile.notify_login}` : '');

function creditNotes(config, credits, held) {
  const g = config.greptile ?? {};
  const out = [];
  const count = `Greptile credits used: ${credits.used} of ${g.monthly_credits ?? '?'}`;
  if (held === 'apex_d3') out.push(HELD_APEX);
  else if (held === 'credits_u2') {
    out.push(`High-risk PR. ${count} (hold at ${g.u2_used}). Only r3 PRs get deep review now. Deep review is held. Dave decides: wait, or land on CodeRabbit + xreview.${mention(config)}`);
  } else if (credits.used !== null && credits.used >= g.u1_used) {
    out.push(`Warning: ${count} (warning at ${g.u1_used}, hold at ${g.u2_used}).${mention(config)}`);
  }
  return out;
}

/**
 * route(cls, labelsNow, config, credits) -> { add, wanted, comment, held }
 *   wanted: every label the class asks for. add: the ones not on the PR yet.
 *   held: 'apex_d3' (deep_enabled false) or 'credits_u2', else null.
 */
export function route(cls, labelsNow, config, credits) {
  const wanted = [`risk:${cls}`];
  if (cls === 'r3') wanted.push('risk:high');
  let held = null;
  const notes = [];
  if (cls === 'normal') wanted.push('review:coderabbit');
  if (DEEP_CLASSES.has(cls)) {
    // A person who set review:deep upgraded the PR on purpose: no hold, no held note, no second review label.
    if (labelsNow.includes('review:deep')) held = null;
    else if (!config.deep_enabled) held = 'apex_d3';
    else if (credits.status === 'u2' && cls !== 'r3') held = 'credits_u2';
    wanted.push(...(held ? ['review:coderabbit', 'review:deep-held'] : ['review:deep']));
    notes.push(...creditNotes(config, credits, held));
    if (credits.u3_due && credits.used === null) {
      notes.push(`Credit check due (U3, ${config.greptile.u3_date}): read the Greptile dashboard and set greptile.credits_used_manual in review-router.config.json.${mention(config)}`);
    }
  }
  const add = wanted.filter((l) => !labelsNow.includes(l));
  return { add, wanted, comment: notes.length ? notes.join('\n\n') : null, held };
}

// ---------- decide ----------

export const builderOf = (labels) => {
  const b = labels.filter((l) => l.startsWith('builder:')).map((l) => l.slice('builder:'.length));
  return b.length === 0 ? null : b.length === 1 ? b[0] : 'multiple';
};

// `\x3C` is `<`: a regex literal that starts with `<!--` stops Semgrep's JS parser (HTML-like comment).
const STATE_RE = /\x3C!--\s*review-router-state class=(\w+)(?: head=([0-9a-f]{40}))?(?: held=(\w+))?(?: pathway=(\w+))?(?: pclass=(\w+))?\s*-->/;
// The consumed marker id has its own line right after the state line, so the state line keeps the shape the previous router reads.
const CONSUMED_RE = /^\r?\n\x3C!--\s*review-router-consumed id=(\d+)\s*-->/;
const HOLDS = new Set(['apex_d3', 'credits_u2']);
const PATHWAYS = new Set(['none', 'coderabbit', 'both']);

const consumedFrom = (rest) => {
  const c = CONSUMED_RE.exec(rest);
  return c ? Number(c[1]) : null;
};

/** The class, head, hold, pathway, pclass and consumed marker id stored in a router comment body. Unknown or missing parts are null. */
export function stateFrom(body) {
  const m = STATE_RE.exec(String(body ?? ''));
  if (!m || !Object.hasOwn(RANK, m[1])) return { class: null, head: null, held: null, pathway: null, pclass: null, consumed: null };
  return {
    class: m[1], head: m[2] ?? null, held: HOLDS.has(m[3]) ? m[3] : null,
    pathway: PATHWAYS.has(m[4]) ? m[4] : null, pclass: Object.hasOwn(RANK, m[5]) ? m[5] : null,
    consumed: consumedFrom(String(body).slice(m.index + m[0].length)),
  };
}

/** The class the router decided before: from the router comment only. Labels are not memory. */
export const previousClassFrom = (body) => stateFrom(body).class;

/** The highest risk:* label on the PR (a person may have set it). */
const labelClassOf = (labels) => labels.filter((l) => l.startsWith('risk:')).map((l) => l.slice(5))
  .filter((c) => Object.hasOwn(RANK, c)).reduce((best, c) => (best === null || rank(c) > rank(best) ? c : best), null);

const higher = (a, b) => (a === null ? b : b === null ? a : rank(b) > rank(a) ? b : a);

// ---------- PR checkpoint: the pathway a person chose with a review:* label ----------

const PATHWAY_LABELS = [['review:deep', 'both'], ['review:deep-held', 'coderabbit'], ['review:coderabbit', 'coderabbit'], ['review:none', 'none']];
/** The pathway of the strongest review:* label on the PR (both > coderabbit > none), else null. */
export const pathwayFrom = (labels) => PATHWAY_LABELS.find(([l]) => labels.includes(l))?.[1] ?? null;

// The marker /pathway posts (pr-checkpoint.mjs applyPathway) before it marks a PR ready. `\x3C` is `<`: see STATE_RE.
const PATHWAY_MARKER_RE = /^\s*\x3C!--\s*pathway-confirmed head=([0-9a-f]{40}) pathway=(none|coderabbit|both)\s*-->/;
export const renderPathwayMarker = (head, pathway) => `\x3C!-- pathway-confirmed head=${head} pathway=${pathway} -->`;

/**
 * The pathways that /pathway confirmed for this head: from PR comments that START with a marker naming the full head sha.
 * Only a comment whose author_association is OWNER, MEMBER or COLLABORATOR counts: /pathway posts as the person who runs gh, and
 * anyone with write access can also add a review:* label (the same trust level). A missing field fails closed. A marker quoted
 * inside another comment, or for another head, never counts.
 * A marker is bound to one ready event: consumed is the id of the marker comment the router used last. A marker whose id is not
 * above it never counts again, and once an id is consumed a marker with no numeric id fails closed.
 */
const PATHWAY_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export function confirmedMarkers(comments, head, consumed = null) {
  const want = String(head ?? '').toLowerCase();
  const fresh = (c) => consumed === null || (Number.isFinite(c.id) && c.id > consumed);
  return (comments || []).filter((c) => PATHWAY_AUTHORS.has(c?.author_association) && fresh(c))
    .map((c) => ({ id: Number.isFinite(c.id) ? c.id : null, m: PATHWAY_MARKER_RE.exec(String(c?.body ?? '')) })).filter(({ m }) => m && m[1] === want)
    .map(({ id, m }) => ({ id, pathway: m[2] }));
}
export const confirmedPathways = (comments, head, consumed = null) => [...new Set(confirmedMarkers(comments, head, consumed).map((m) => m.pathway))];

// The id to save as consumed: the highest fresh marker id, or the used marker's own id when no id is above it. null for a marker with no id.
const highest = (usedId, top) => (usedId === null && top < 0 ? null : Math.max(usedId ?? -1, top));

// At HIGH and CRITICAL a bare review:none label is not a pick (lane agent-self-approve-hole, Dave 2026-11-03). Anyone with write access can
// add the label, so the router saves pathway none there only when a fresh pathway-confirmed marker for the head names none. A null band
// (a label event, a config with no matrix block) keeps the old behaviour.
const NONE_GATED = new Set(['HIGH', 'CRITICAL']);
export const NONE_UNCONFIRMED_NOTE = 'review:none at band HIGH or CRITICAL has no pathway confirmation for this head, so the router saved no checkpoint. Call pr_checkpoint {pr}: it asks Dave whether to return the PR to draft and pick again.';
// A none saved with no marker (consumed null) at a band below HIGH stays when a push raises the band. The state keeps no band, so this
// is the signal: a pick made at HIGH or above needs a marker, and a marker sets consumed. Detect only: the pathway is not changed.
export const NONE_BAND_RAISED_NOTE = 'review:none was saved with no pathway confirmation, and the band is HIGH or CRITICAL now. The pathway is unchanged. Call pr_checkpoint {pr}: it asks Dave whether to return the PR to draft and pick again. land-pr.ps1 refuses until Dave picks again for this head.';
const namesNone = (confirmed) => confirmed.some((c) => (typeof c === 'string' ? c : c?.pathway) === 'none');
/** True when `wanted` is a change to none at HIGH or CRITICAL that no fresh none marker for the head backs. */
const noneGated = (wanted, saved, confirmed, band) => NONE_GATED.has(band) && wanted === 'none' && saved.pathway !== 'none' && !namesNone(confirmed);
/** True when a saved none, made with no marker, is kept at HIGH or CRITICAL with no fresh none marker. */
const noneBandRaised = (pathway, saved, confirmed, band) => NONE_GATED.has(band) && pathway === 'none' && saved.pathway === 'none' && saved.consumed === null && !namesNone(confirmed);

/**
 * The pathway and pclass this run saves. First run: only a person_override writes them (pclass = the class then).
 * Later runs: person_override and no_change re-read the pathway from the labels (no review:* label keeps the saved one);
 * every reason keeps pclass, except a ready_for_review that /pathway confirmed: a pathway-confirmed marker for this head names the
 * pathway of the review:* label on the PR. That is a new checkpoint and pclass becomes the current class (this clears the class-raised note).
 * A ready_for_review without such a marker (a person clicked "Ready for review", or ran gh pr ready) is not a checkpoint.
 * The marker's id is saved as consumed (the router already skipped older ones), so the same marker cannot start a second checkpoint.
 * opened and reopened happen without one. A comment saved before the checkpoint existed (no pclass) stays without them.
 */
function checkpointOf({ event, reason, previousClass, labelsNow, effective, saved, confirmed = [], band = null }) {
  const none = { pathway: null, pclass: null, consumed: null, noneUnconfirmed: false, noneBandRaised: false };
  // The highest fresh marker for the head, whatever its pathway: an unused one above the used marker must not stay live.
  const top = confirmed.reduce((best, c) => (Number.isFinite(c?.id) && c.id > best ? c.id : best), -1);
  // The newest marker that names the label's pathway: the one this ready event uses up.
  const used = event === 'ready_for_review' && hasReview(labelsNow)
    ? confirmed.map((c) => (typeof c === 'string' ? { id: null, pathway: c } : c)).filter((c) => c.pathway === pathwayFrom(labelsNow)).reduce((best, c) => (best === null || (c.id ?? -1) > (best.id ?? -1) ? c : best), null)
    : null;
  if (previousClass === null) {
    const wanted = reason === 'person_override' ? pathwayFrom(labelsNow) : null;
    const gated = noneGated(wanted, saved, confirmed, band);
    const pathway = gated ? null : wanted;
    return pathway ? { pathway, pclass: effective, consumed: used ? highest(used.id, top) : null, noneUnconfirmed: false, noneBandRaised: false } : { ...none, noneUnconfirmed: gated };
  }
  // A confirmed ready_for_review is a new checkpoint, also when it is a raise run (a draft run saves no class).
  const redone = used !== null;
  const reread = reason === 'person_override' || reason === 'no_change' || redone;
  const wanted = (reread ? pathwayFrom(labelsNow) : null) ?? saved.pathway;
  const gated = noneGated(wanted, saved, confirmed, band);
  const pathway = gated ? saved.pathway : wanted;
  // A saved class with no pclass (a gated first run) saves a pathway only when a confirmed ready event makes the checkpoint now.
  if (pathway === null || (saved.pclass === null && !redone)) return { ...none, noneUnconfirmed: gated };
  return { pathway, pclass: redone ? effective : saved.pclass, consumed: (redone ? highest(used.id, top) : null) ?? saved.consumed, noneUnconfirmed: gated, noneBandRaised: noneBandRaised(pathway, saved, confirmed, band) };
}

const raiseNote = (from, to) => `Class raised from ${from} to ${to} after the checkpoint. Call pr_checkpoint {pr}: it asks Dave whether to return the PR to draft and pick again.`;

/**
 * What a raise may add. A review:none PR, or one whose saved pathway is none, gets risk:* only (it wants no bot). A PR with review:coderabbit or
 * review:deep-held gets no second CodeRabbit label; review:deep is still added when it is wanted.
 */
function raiseAdds(add, labelsNow, savedNone) {
  const has = (l) => labelsNow.includes(l);
  const codeRabbit = has('review:coderabbit') || has('review:deep-held');
  if ((has('review:none') || savedNone) && !codeRabbit) return add.filter((l) => l.startsWith('risk:'));
  return codeRabbit ? add.filter((l) => l !== 'review:coderabbit' && l !== 'review:deep-held') : add;
}

const READY_EVENTS = new Set(['opened', 'reopened', 'ready_for_review']);
// A person adding or removing a risk:* or review:* label: the person wins, the router only writes a ledger row (spec 2).
const LABEL_EVENTS = new Set(['labeled', 'unlabeled']);
const CR_LABELS = ['review:coderabbit', 'review:deep', 'review:deep-held'];
const hasReview = (labels) => labels.some((l) => l.startsWith('review:'));

function sideNotes({ builder, labelsNow, wanted, pr: p }) {
  const out = [];
  if ([...wanted, ...labelsNow].some((l) => CR_LABELS.includes(l)) && p.codeRabbitRateLimited) {
    out.push('CodeRabbit is rate limited on the current head. Greptile does not take its place. Dave decides: wait, or land with -IgnoreReview.');
  }
  if (builder === null) out.push('No builder label. Add `builder:claude` or `builder:grok` so the cross-family reviewer can be chosen. Nothing is blocked.');
  if (builder === 'multiple') out.push('More than one builder label. Keep exactly one of `builder:claude` or `builder:grok`. Nothing is blocked.');
  return out;
}

/**
 * A saved hold, no hold now, review:deep wanted and missing, review:deep-held still on (a person who removed it opted out).
 * A credit hold ends only on a known count: an unknown or mistyped credits_used_manual never spends credits.
 */
const releasable = (previousHeld, r, labelsNow, credits) => Boolean(previousHeld) && r.held === null &&
  !(previousHeld === 'credits_u2' && credits.used === null) &&
  r.wanted.includes('review:deep') && !labelsNow.includes('review:deep') && labelsNow.includes('review:deep-held');

/**
 * decide(event, pr, labelsNow, previousClass, config, { now, previousHeld }) -> a decision
 *   previousHeld: the hold saved in the router comment (apex_d3, credits_u2) or null.
 *   previousPathway, previousPclass: the checkpoint attributes saved in the router comment, or null. confirmed: pathways /pathway confirmed for this head (confirmedMarkers; a plain pathway string has no id). previousConsumed: the marker id saved in the router comment.
 *   pr: { number, head, draft, state, paths, files?, codeRabbitRateLimited }  (files: the raw file objects; the band counts a rename once)
 *   -> { reason, class, effective, matched, previousClass, add, comment, held, pathway, pclass, noneUnconfirmed, noneBandRaised, builder, credits, band, noop }
 * band: bandOf() of the PR paths and labels (the review band), or null on a label event or a config without a matrix block.
 * reason: draft | not_open | event_ignored | person_label | routed | raised | released | person_override | no_change.
 * noop true = touch nothing, not even the comment. The decision never has a "remove".
 */
export function decide(event, pr, labelsNow, previousClass, config, opts = {}) {
  const credits = creditsState(config, opts.now ?? new Date());
  const { class: cls, matched } = classify(pr.paths ?? [], config);
  const builder = builderOf(labelsNow);
  const band = LABEL_EVENTS.has(event) ? null : bandOf(pr.files ?? pr.paths ?? [], config, { labels: labelsNow });
  const out = { reason: null, class: cls, effective: cls, head: pr.head, matched, previousClass, add: [], comment: null, held: null, pathway: null, pclass: null, consumed: null, noneUnconfirmed: false, noneBandRaised: false, builder, credits, band, noop: true };
  const stop = (reason) => ({ ...out, reason });
  // A label event reads no files, so it reports no class, on any PR state.
  if (LABEL_EVENTS.has(event)) return { ...stop('person_label'), class: null, effective: null, matched: {} };
  if (pr.draft) return stop('draft');
  if (pr.state !== 'open') return stop('not_open');
  // edited counts only when the base branch changed (a stacked PR retargeted to main). A title edit does nothing.
  const routable = event === 'synchronize' || READY_EVENTS.has(event) || (event === 'edited' && pr.baseChanged === true);
  if (!routable) return stop('event_ignored');

  const seen = higher(cls, labelClassOf(labelsNow));
  const effective = higher(previousClass, seen);
  const r = route(effective, labelsNow, config, credits);
  let { add } = r;
  let reason;
  if (previousClass === null) {
    reason = hasReview(labelsNow) ? 'person_override' : 'routed';
    if (reason === 'person_override') add = add.filter((l) => l.startsWith('risk:'));
  } else if (rank(seen) > rank(previousClass)) {
    reason = 'raised';
    // Person wins on a raise only where it can never lower review: a removed review:coderabbit stays
    // removed when the new class gets review:deep or review:deep-held, because READY reads both as
    // needing CodeRabbit. Every other label the new class wants is added, even if it looks removed:
    // the router keeps no history of what an earlier run added under an earlier config.
    const deepLabel = add.includes('review:deep') || add.includes('review:deep-held') || labelsNow.includes('review:deep') || labelsNow.includes('review:deep-held');
    const crRemoved = previousClass !== null && route(previousClass, [], config, credits).wanted.includes('review:coderabbit') && !labelsNow.includes('review:coderabbit');
    if (deepLabel && crRemoved) add = add.filter((l) => l !== 'review:coderabbit');
  } else if (releasable(opts.previousHeld, r, labelsNow, credits)) {
    // The saved state says the router held this PR, and the hold is gone (deep review switched on, or
    // credits back under u2). review:deep was never added, so it is not a person removal. Add only it.
    // The state is saved without the hold, so a later removal of review:deep by a person is not undone.
    add = ['review:deep'];
    reason = 'released';
  } else {
    add = [];
    reason = r.wanted.some((l) => !labelsNow.includes(l)) ? 'person_override' : 'no_change';
  }
  const personChose = previousClass === null && reason === 'person_override';
  const saved = { pathway: opts.previousPathway ?? null, pclass: opts.previousPclass ?? null, consumed: opts.previousConsumed ?? null };
  const cp = checkpointOf({ event, reason, previousClass, labelsNow, effective, saved, confirmed: opts.confirmed ?? [], band: band?.band ?? null });
  // One signal for "wants no bot": the saved pathway (also after a person removed review:none) drives the adds and the hold alike.
  if (reason === 'raised') add = raiseAdds(add, labelsNow, cp.pathway === 'none');
  // A review:none PR wants no bot: no hold and no hold note. If the class rose above the checkpoint class, say so on every run.
  const quiet = personChose || cp.pathway === 'none';
  const raisedNone = cp.pathway === 'none' && rank(effective) > rank(cp.pclass);
  const notes = [
    ...(cp.noneUnconfirmed ? [NONE_UNCONFIRMED_NOTE] : []),
    ...(cp.noneBandRaised ? [NONE_BAND_RAISED_NOTE] : []),
    ...(raisedNone ? [raiseNote(cp.pclass, effective)] : []),
    ...(quiet ? [] : [r.comment].filter(Boolean)),
    ...sideNotes({ builder, labelsNow, wanted: r.wanted, pr }),
  ];
  return { ...out, reason, effective, add, ...cp, held: quiet ? null : r.held, comment: notes.length ? notes.join('\n\n') : null, noop: false };
}

// ---------- the one router comment ----------

export const ROUTER_MARKER = '<!-- review-router -->';
/**
 * held is written only while a hold is in force; pathway and pclass only after a checkpoint, and consumed (a marker id) on its own line after the state line. A comment without them
 * is byte-identical to before.
 */
export const renderComment = (text, cls, head = null, held = null, { pathway = null, pclass = null, consumed = null } = {}) =>
  `${ROUTER_MARKER}\n<!-- review-router-state class=${cls}${head ? ` head=${head}` : ''}${held ? ` held=${held}` : ''}${pathway ? ` pathway=${pathway}` : ''}${pclass ? ` pclass=${pclass}` : ''} -->\n${consumed ? `<!-- review-router-consumed id=${consumed} -->\n` : ''}${text}`;
const RESOLVED_TEXT = 'No open router notes.';
const ROUTER_BOT = { login: 'github-actions[bot]', type: 'Bot' };

/**
 * The router's own comment: written by github-actions[bot] (type Bot) and starting with the marker. The lowest id
 * wins, so a later copy cannot take its place. A person's comment that quotes the marker is ignored and never edited.
 */
export function findRouterComment(comments) {
  return (comments || [])
    .filter((c) => c?.user?.login === ROUTER_BOT.login && c?.user?.type === ROUTER_BOT.type && String(c?.body ?? '').startsWith(ROUTER_MARKER))
    .reduce((best, c) => (best === null || (c.id ?? Infinity) < (best.id ?? Infinity) ? c : best), null);
}

/** A dry-run print must not carry a live marker: someone could paste it into a comment. */
export const maskMarker = (text) => String(text).replaceAll('<!-- review-router', '<!-- [dry-run] review-router');

/**
 * What to write: labels in one call; the router comment created once, then updated in place whenever its text,
 * class or head differs. It is written on every open ready run (resolved text when there are no notes).
 */
export function planOps(d, existing) {
  if (d.noop) return [];
  const ops = [];
  if (d.add.length > 0) ops.push({ op: 'labels', labels: d.add });
  const body = renderComment(d.comment ?? RESOLVED_TEXT, d.effective, d.head, d.held, { pathway: d.pathway, pclass: d.pclass, consumed: d.consumed });
  if (!existing) ops.push({ op: 'comment-create', body });
  else if (existing.body !== body) ops.push({ op: 'comment-update', id: existing.id, body });
  return ops;
}

export function applyOps(ops, { repo, pr, dryRun, gh }) {
  const done = [];
  for (const o of ops) {
    if (o.op === 'labels') {
      done.push(`add labels: ${o.labels.join(', ')}`);
      if (!dryRun) gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/labels`, ...o.labels.flatMap((l) => ['-f', `labels[]=${l}`])]);
    } else if (o.op === 'comment-create') {
      done.push(`create the router comment:\n${dryRun ? maskMarker(o.body) : o.body}`);
      if (!dryRun) gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${o.body}`]);
    } else if (o.op === 'comment-update') {
      done.push(`update router comment ${o.id}:\n${dryRun ? maskMarker(o.body) : o.body}`);
      if (!dryRun) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${o.id}`, '-f', `body=${o.body}`]);
    }
  }
  return done;
}

// ---------- inputs ----------

/**
 * Paths of the PR, with the old name of a rename. A count that differs from changed_files is an error:
 * fewer = truncated, more = compared against a base the PR does not use. Never a smaller or larger PR.
 */
export function changedPaths(files, pull) {
  if (files.length !== (pull.changed_files ?? 0)) throw new Error(`file list incomplete or stale (${files.length} of ${pull.changed_files}); cannot classify`);
  return [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
}

/** CodeRabbit's newest summary is a rate-limit notice for the head. Chat replies and other authors do not count. */
export function codeRabbitRateLimited(comments, head) {
  const s = latestCodeRabbitSummary(comments);
  if (!s || codeRabbitNotice(s.body) !== 'rate limited') return false;
  return commitsNamed(s.body).some((sha) => shaIsHead(sha, head));
}

// ---------- ledger ----------

const NOT_DONE = new Set(['draft', 'not_open', 'event_ignored', 'person_label', 'person_override']);

export function ledgerLine({ d, pr, event, ops = [], now = new Date() }) {
  const c = ops.find((o) => o.op.startsWith('comment'));
  return JSON.stringify({
    ts: now.toISOString(), tool: 'router', pr: pr.number, head: pr.head, event, class: d.class, decision: d.reason,
    paths_matched: d.matched, labels_added: d.add, held_reason: NOT_DONE.has(d.reason) ? d.reason : d.held,
    builder: d.builder, credits: d.credits, comment: c ? c.op.slice('comment-'.length) : 'none',
    ...(d.band ? { band: d.band.band, band_score: d.band.score, band_g: d.band.G } : {}),
    ...(pr.labelChange ? { label: pr.labelChange.name, by: pr.labelChange.by } : {}),
    ...(pr.filesSource ? { files_source: pr.filesSource } : {}),
    ...(pr.assumedReady ? { assumed_ready: true } : {}),
    ...(d.noneUnconfirmed ? { none_unconfirmed: true } : {}),
    ...(d.noneBandRaised ? { none_band_raised: true } : {}),
  });
}

/** The ledger line for a run that could not decide. Nothing was written. */
export const ledgerErrorLine = ({ number = null, head = null, event = null, message, now = new Date() }) =>
  JSON.stringify({ ts: now.toISOString(), tool: 'router', pr: number, head, event, decision: 'error', error: message });

function emitLedger(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`json\n${line}\n\`\`\`\n`);
  if (process.env.RUNNER_TEMP) appendFileSync(path.join(process.env.RUNNER_TEMP, 'review-ledger.jsonl'), `${line}\n`);
}

// ---------- main ----------

export function makeGh() {
  const ghPersonal = path.join(os.homedir(), '.config', 'gh-personal');
  const dir = process.env.GH_CONFIG_DIR || (existsSync(ghPersonal) ? ghPersonal : undefined);
  const env = { ...process.env, ...(dir ? { GH_CONFIG_DIR: dir } : {}) };
  return (args) => {
    const out = execFileSync('gh', args, { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : {};
  };
}

const flag = (args, k) => args.includes(k);
const opt = (args, k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

/** GitHub compare returns at most 300 changed files, all on the first page (measured 2026-10-26). */
export const COMPARE_FILE_CAP = 300;

/**
 * Read the PR, its files and its comments. The files come from compare/<base>...<head sha>, pinned to the head
 * the router records, so a files list that lags a push cannot be saved under the new head (N5). Above the compare
 * cap the paginated PR files list is used (filesSource 'pulls'); changedPaths still refuses a count mismatch.
 */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const FILE_READ_ATTEMPTS = 3;

function readFiles(gh, repo, number, pull) {
  if ((pull.changed_files ?? 0) <= COMPARE_FILE_CAP) {
    // base.sha, not base.ref: after a merge, main...head is empty (measured on #164, 0 of 6 files).
    return { files: gh(['api', `repos/${repo}/compare/${pull.base.sha}...${pull.head.sha}`]).files ?? [], filesSource: 'compare' };
  }
  return { files: gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/files?per_page=100`]).flat(), filesSource: 'pulls' };
}

/**
 * opts.filesNeeded false (a label event) skips the file reads. Right after a push, changed_files or base.sha can
 * lag the head; a count mismatch re-reads the PR (up to FILE_READ_ATTEMPTS, opts.sleep between) before
 * changedPaths refuses it.
 */
export function loadLive(gh, repo, number, opts = {}) {
  const { filesNeeded = true, sleep = sleepSync, waitMs = 3000 } = opts;
  let pull = gh(['api', `repos/${repo}/pulls/${number}`]);
  let read = { files: null, filesSource: null };
  for (let attempt = 1; filesNeeded; attempt++) {
    read = readFiles(gh, repo, number, pull);
    if (read.files.length === (pull.changed_files ?? 0) || attempt >= FILE_READ_ATTEMPTS) break;
    sleep(waitMs);
    pull = gh(['api', `repos/${repo}/pulls/${number}`]);
  }
  const comments = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?per_page=100`]).flat();
  return { pull, files: read.files, comments, filesSource: read.filesSource };
}

function load(args, gh, repo, number, filesNeeded) {
  const fixture = opt(args, '--fixture');
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8'));
  return loadLive(gh, repo, number, { filesNeeded });
}

function origin(args) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : null;
  const number = Number(args.find((a) => /^\d+$/.test(a)) ?? payload?.pull_request?.number);
  const event = opt(args, '--event') ?? payload?.action ?? 'ready_for_review';
  const labelChange = LABEL_EVENTS.has(event) && payload?.label ? { name: payload.label.name ?? null, by: payload.sender?.login ?? null } : null;
  return { number, event, baseChanged: Boolean(payload?.changes?.base), labelChange };
}

function main() {
  const args = process.argv.slice(2);
  const { number, event, baseChanged, labelChange } = origin(args);
  const fixture = opt(args, '--fixture');
  const dryRun = flag(args, '--dry-run') || Boolean(fixture);
  let head = null;
  try {
    if (!number) throw new Error('usage: review-router.mjs <pr-number> [--dry-run] [--event name]');
    if (flag(args, '--assume-ready') && !dryRun) throw new Error('--assume-ready needs --dry-run');
    const repo = opt(args, '--repo') ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
    const config = JSON.parse(readFileSync(opt(args, '--config') ?? path.join(HERE, '..', '..', 'review-router.config.json'), 'utf8'));
    const gh = fixture ? null : makeGh();
    const labelEvent = LABEL_EVENTS.has(event);
    const { pull, files, comments, filesSource = null } = load(args, gh, repo, number, !labelEvent);
    head = pull.head.sha;
    const assumed = flag(args, '--assume-ready');
    const labels = pullLabelNames(pull);
    const prState = {
      number: pull.number ?? number, head, draft: assumed ? false : pull.draft === true, baseChanged,
      state: assumed ? 'open' : pull.state, paths: labelEvent ? [] : changedPaths(files, pull), files: labelEvent ? [] : files, assumedReady: assumed,
      codeRabbitRateLimited: codeRabbitRateLimited(comments, head), labelChange, filesSource,
    };
    const existing = findRouterComment(comments);
    const saved = stateFrom(existing?.body);
    const now = new Date();
    const d = decide(event, prState, labels, saved.class, config, { now, previousHeld: saved.held, previousPathway: saved.pathway, previousPclass: saved.pclass, previousConsumed: saved.consumed, confirmed: confirmedMarkers(comments, head, saved.consumed) });
    const ops = planOps(d, existing);
    const done = applyOps(ops, { repo, pr: number, dryRun, gh });
    emitLedger(ledgerLine({ d, pr: prState, event, ops, now }));
    if (dryRun) {
      for (const text of done.length ? done : ['no writes planned']) console.log(`# DRY RUN: ${text.replace(/\n/g, '\n# ')}`);
    }
  } catch (err) {
    const message = String(err.message).split('\n')[0];
    emitLedger(ledgerErrorLine({ number: number || null, head, event, message }));
    console.error(`review-router: could not determine (${message})`);
    process.exit(2);
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) main();
