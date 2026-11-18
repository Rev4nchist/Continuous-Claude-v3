// The two-call protocol of the PR checkpoint (pathway-flow-v2, design section 2 step 3). Used by pr-checkpoint.mjs when
// checkpoint.ledger is true in review-router.config.json. Tests: scripts/github/pr-checkpoint-ledger.test.mjs.
//
// Call 1 of `pr_checkpoint {pr}` gets a question spec. The model asks it with AskUserQuestion. The AskUserQuestion hook records Dave's tap
// (decisions.mjs). Call 2 reads the tap. There is ONE question: the label of a paid row carries its price, and Dave's tap on it records the
// pick (card prflow-review-pick). One question; a paid row shows its price. A paid row is never row 0: a dialog that returns
// row 0 with no tap records nothing.
// Only when the tap exists does the engine let `--confirm <pathway> --by dave` record (ledgerConfirmProblem).
//
// Binding: the review question is step `review`, key `<repo>#<pr>`, head. (The plain key `<repo>#<pr>` of step `paid-round` is the
// ship-ask question for a paid round. The cr-paid.mjs limits stay hard stops when a paid round runs.)
import * as store from './decisions.mjs';

const PER_FILE = 0.25;
const GREPTILE_CREDITS = 3;
const usd = (n) => `$${n.toFixed(2)}`;
const one = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const clip = (t, n) => (one(t).length > n ? `${one(t).slice(0, n - 1)}…` : one(t));
const RECOMMENDED = ' (Recommended)';

const NAMES = { none: 'No review, land on CI', coderabbit: 'CodeRabbit review', both: 'CodeRabbit + Greptile', wait: 'Keep as draft' };

/** A free fact older than this is no longer a fact: the slot may have gone. The same figure as FREE_FACT_MAX_AGE_MS in the mod (model.ts). */
const FREE_FACT_MAX_AGE_MS = 5 * 60_000;
/** A checkedAt this far after the clock is clock skew and still fresh. Further ahead it cannot be trusted. The same figure as FUTURE_SKEW_MS in the mod. */
const FUTURE_SKEW_MS = 60_000;

/**
 * The CodeRabbit slot state at `nowMs`: 'free', 'wait' or 'unknown'. The same rule as slotOf in the mod (model.ts), so both copies of the question
 * read one fact the same way. A free fact with no readable checkedAt, one older than 5 minutes, or one more than 1 minute after the clock is unknown
 * (it fails closed, so the row is paid). So is a wait fact whose nextSlotAt has passed. A wait fact with no readable nextSlotAt has no time to pass,
 * so it ages out the way a free fact does. A null clock reads the fact as printed.
 */
export function slotStateOf(capacity, nowMs) {
  const cap = capacity && typeof capacity === 'object' ? capacity : {};
  const printed = cap.state === 'free' || cap.state === 'wait' ? cap.state : 'unknown';
  if (nowMs === null || nowMs === undefined) return printed;
  const checked = typeof cap.checkedAt === 'string' ? Date.parse(cap.checkedAt) : Number.NaN;
  const next = typeof cap.nextSlotAt === 'string' ? Date.parse(cap.nextSlotAt) : Number.NaN;
  const stale = !(nowMs - checked <= FREE_FACT_MAX_AGE_MS && checked - nowMs <= FUTURE_SKEW_MS);
  if (printed === 'free') return stale ? 'unknown' : 'free';
  if (printed === 'wait') return (Number.isFinite(next) ? next <= nowMs : stale) ? 'unknown' : 'wait';
  return 'unknown';
}

/** A paid row spends money: Greptile credits always, CodeRabbit unless the slot is free. `slot` is slotStateOf of the result's capacity. */
const isPaid = (pathway, slot) => pathway === 'both' || (pathway === 'coderabbit' && slot !== 'free');

/** The label of a pathway row, with its cost. The words are the mod's (model.ts labelFor): both copies must give one text. */
function labelOf(pathway, result, slot) {
  const up = usd(result.size.files * PER_FILE);
  if (pathway === 'none') return 'No review, land on CI ($0)';
  if (pathway === 'wait') return 'Keep as draft ($0)';
  if (pathway === 'both') return `CodeRabbit + Greptile (may cost up to ${up} + ${GREPTILE_CREDITS} credits)`;
  return slot === 'free' ? 'CodeRabbit now (free slot, $0)' : `CodeRabbit review (may cost up to ${up})`;
}

/** The recommendation of the question. A held recommendation (not among the open options) falls back to the safe pick: Keep as draft. */
function recommendedOf(result) {
  const rec = result.recommended;
  const open = result.options.some((o) => o.pathway === rec && o.available);
  return rec === 'wait' || open ? rec : 'wait';
}

/**
 * The pathways of the question, at most 4. Row 0 is Keep as draft, or none when none is the recommendation: both cost $0. Then the free-slot
 * CodeRabbit row, then the paid rows (the recommendation first), then none. A paid row is never row 0. The free-slot and the paid CodeRabbit row
 * have different labels. The order depends only on the result and the clock, so a re-ask at the same time shows the same rows.
 */
function rowsOf(result, slot) {
  const open = result.options.filter((o) => o.available && o.pathway !== 'wait').map((o) => o.pathway);
  const rec = recommendedOf(result);
  const crs = open.filter((p) => p !== 'none');
  const paid = crs.filter((p) => isPaid(p, slot)).sort((a, b) => Number(b === rec) - Number(a === rec));
  const lead = rec === 'none' ? ['none'] : [];
  return [...new Set([...lead, 'wait', ...crs.filter((p) => !isPaid(p, slot)), ...paid, ...(open.includes('none') ? ['none'] : [])])];
}

function describe(pathway, result, first, slot) {
  const o = result.options.find((x) => x.pathway === pathway);
  const base = pathway === 'wait' ? 'Records nothing. The PR stays a draft.' : one(o?.reason ?? '');
  const spend = isPaid(pathway, slot) ? ' This tap records it and can cost money.' : '';
  const drift = first && result.config_drift ? ` Warning: ${result.config_drift_why ?? 'branch config differs from main'}.` : '';
  return `${base}${spend}${drift}`.trim() || 'No details.';
}

function questionOf(pr, result, slotLine) {
  const [why] = result.why.map((w) => w.replace(/[.\s]+$/, '')).filter(Boolean);
  const files = result.size.files;
  const rec = recommendedOf(result);
  const because = rec === result.recommended ? why : `${NAMES[result.recommended]} is held`;
  return [
    `PR #${pr}, band ${result.auto?.band ?? 'unknown'}, ${files} ${files === 1 ? 'file' : 'files'}.`,
    `Recommended: ${NAMES[rec]}${because ? `, because ${clip(because, 140)}` : ''}.`,
    `CodeRabbit slot: ${slotLine}`,
  ].join('\n');
}

/**
 * The review question. { header, question, options, values }: values maps each label to its pathway and stays in the store (the print drops it).
 * The recommendation carries " (Recommended)" at its row. Row 0 is a $0 row (Keep as draft, or none when it is the recommendation). 2 to 4 options.
 * `now` is the clock in ms: the CodeRabbit slot is read at that time (slotStateOf). Tests inject it.
 */
export function askSpecOf(pr, result, slotLine, now = Date.now()) {
  const slot = slotStateOf(result.capacity, now);
  const rows = rowsOf(result, slot);
  const rec = recommendedOf(result);
  const options = rows.map((p, i) => ({ label: `${labelOf(p, result, slot)}${p === rec ? RECOMMENDED : ''}`, description: describe(p, result, i === 0, slot) }));
  const values = Object.fromEntries(rows.map((p, i) => [options[i].label, p]));
  return { header: clip(`PR #${pr}`, 12), question: questionOf(pr, result, slotLine), options, values };
}

const printable = ({ header, question, options }) => ({ header, question, options });
const keyOf = (pr) => store.decisionKey({ pr });
/** The pathway of a tap: the offer's value map read at the tap's label, or null. */
const valueOf = (triple, d, tap = d.decisionRead(triple)) => d.offerRead(triple)?.spec?.values?.[tap?.label] ?? null;

/**
 * True when the tap was made before the PR went back to draft (`repickSince`, an ISO time: the mod's re-pick marker). No value means no marker, so
 * the drop of the taps (decisions.mjs dropKey) already ran. A value that does not parse, or a tap with no readable time, is stale: it fails closed.
 */
const isStale = (tap, repickSince) => repickSince !== null && repickSince !== undefined && !(Date.parse(tap?.at) >= Date.parse(repickSince));

/**
 * Opens (or re-opens) the question. An open offer with no tap is a miss: count it, and stop after MAX_REASKS re-asks.
 * `note` says why Dave sees the question again (a tap that was not recorded). It leads the text for the model and is also its own field.
 */
function askAgain(pr, triple, spec, d, note = null) {
  const reopened = d.offerRead(triple)?.open === true;
  const missed = reopened ? d.missBump(triple) : d.missCount(triple);
  if (missed > d.MAX_REASKS) return { state: 'stop', text: `Stop. PR #${pr} stays a draft. Nothing was recorded. Tell Dave.` };
  const w = d.offerWrite({ ...triple, spec, tree: null, cwd: process.cwd() });
  if (!w.ok) return { state: 'stop', text: `Stop. The question could not be saved (${w.reason}). PR #${pr} stays a draft. Nothing was recorded. Tell Dave.` };
  const again = missed > 0 ? ` No answer matched an option. This is re-ask ${missed} of ${d.MAX_REASKS}.` : '';
  const lead = note ? `${note} ` : '';
  return { state: 'ask', ask: printable(spec), reasked: missed, ...(note ? { note } : {}), text: `${lead}Call AskUserQuestion with ask, word for word, with the options in the order given.${again} Then call pr_checkpoint {pr} again.` };
}

const SLOT_CHANGED_NOTE = 'The CodeRabbit slot changed. Your tap was not recorded.';
const QUESTION_CHANGED_NOTE = 'The question changed. Your tap was not recorded.';
const REPICK_NOTE = 'The PR went back to draft. Your earlier tap was not recorded.';

// Why the results of decisionUse are ignored in `kept` and in the askAgain branches of ledgerStep (unlike ledgerUse, which a record needs):
// `kept` records nothing, so a tap that stays leaves the next call at Keep as draft again. In an askAgain branch the offerWrite of askAgain
// deletes the old decision of the triple, and when that write fails too (the lock) askAgain returns `stop`. Nothing records on any path.
const kept = (pr, d, triples) => { triples.forEach((t) => d.decisionUse(t)); return { state: 'kept-draft', text: `Nothing was recorded. PR #${pr} stays a draft. Call pr_checkpoint {pr} when Dave wants to pick again.` }; };

/**
 * Why a tapped label is no row of the question now: the slot (it is the CodeRabbit label of the other slot state) or the question itself (the price, the
 * rows). Both notes say the tap was not recorded.
 */
function changedNote(result, label, pathway) {
  const bare = String(label).endsWith(RECOMMENDED) ? String(label).slice(0, -RECOMMENDED.length) : String(label);
  const slotLabels = ['free', 'wait'].map((state) => labelOf('coderabbit', result, state));
  return pathway === 'coderabbit' && slotLabels.includes(bare) ? SLOT_CHANGED_NOTE : QUESTION_CHANGED_NOTE;
}

/**
 * ledgerStep({ pr, result, slotLine, askAnyway, now, repickSince, d }) -> { state, ask?, pathway?, by?, reasked?, text }. d is the decisions module (a test seam).
 * repickSince is an ISO time (--repick-since, the mod's re-pick marker): a tap made before it is used up and the question is asked again with a note
 * (REPICK_NOTE); a value that does not parse makes every tap stale. Null: no marker.
 * now is the clock in ms: the slot is read at that time (default Date.now(); a test injects it).
 * Call 2 builds the question again from the current result. A tap records only when its label is still a row of that question with the same
 * pathway (a free-slot tap is no yes once the slot is gone). Otherwise the tap is used up and the question is asked again with a `note` that
 * says why (the slot changed, or the question changed) and that the tap was not recorded; that is no miss.
 * Keep as draft records nothing, so it stays kept whatever the slot does.
 * askAnyway skips the auto-eligible short-circuit: the mod passes it (--ask-anyway) when auto-confirm failed, so Dave still gets the question.
 * state: none (no question: a stop or an auto-confirm), ask, record (run --confirm <pathway> --by dave; the tap records the pick),
 * kept-draft (nothing recorded), stop (the re-asks are used up).
 */
export function ledgerStep({ pr, result, slotLine, askAnyway = false, now = Date.now(), repickSince = null, d = store }) {
  if (result.recommended === null || (result.auto?.eligible === true && askAnyway !== true) || result.options.length === 0) return { state: 'none', text: 'No question is needed.' };
  const triple = { step: 'review', key: keyOf(pr), head: result.head };
  const spec = askSpecOf(pr, result, slotLine, now);
  const tapped = d.decisionRead(triple);
  const pathway = valueOf(triple, d, tapped);
  if (pathway === null) return askAgain(pr, triple, spec, d);
  if (isStale(tapped, repickSince)) {
    d.decisionUse(triple);
    return askAgain(pr, triple, spec, d, REPICK_NOTE);
  }
  if (pathway === 'wait') return kept(pr, d, [triple]);
  if (spec.values[tapped.label] !== pathway) {
    d.decisionUse(triple);
    return askAgain(pr, triple, spec, d, changedNote(result, tapped.label, pathway));
  }
  return { state: 'record', pathway, by: 'dave', text: `Dave picked ${pathway}. Record it.` };
}

/**
 * Why `--confirm <pathway> --by <by>` must refuse while the ledger flag is on, and the label of the tap it read. { problem, label }: problem is null when the
 * confirm may go on; label is the tap's label (null for --by auto, which has no tap), the one ledgerUse must use up.
 * Dave's pick needs his tap on the review question (the label of a paid row carries its price; the tap records the pick). One question; a paid row shows its price.
 * --by default never records. --by auto is not a tap and keeps its own rules. A tap made before `repickSince` (see ledgerStep) is refused with REPICK_NOTE.
 * With `result` (and `now`, in ms) the tapped label must also be a row of the question as it stands now, with the same pathway: a tap on a
 * free-slot row is refused once the slot is gone. Without `result` only the tap is checked. A refusal does not use the tap up (ledgerStep does).
 */
export function ledgerConfirmCheck({ pr, head, pathway, by, result = null, now = Date.now(), repickSince = null, d = store }) {
  const no = (problem) => ({ problem, label: null });
  if (by === 'auto') return no(null);
  if (by === 'default') return no("checkpoint.ledger is on: --by default records nothing. Only Dave's tap (--by dave) or an eligible auto-confirm records.");
  if (pr === null) return no('checkpoint.ledger is on: --confirm needs --pr <number>, the PR whose question Dave answered.');
  const triple = { step: 'review', key: keyOf(pr), head };
  const tapped = d.decisionRead(triple);
  if (valueOf(triple, d, tapped) !== pathway) return no(`No tap of Dave's for ${pathway} on PR #${pr} at ${String(head).slice(0, 7)}. Call pr_checkpoint {pr}: it asks Dave.`);
  if (isStale(tapped, repickSince)) return no(`${REPICK_NOTE} Call pr_checkpoint {pr}: it asks Dave again.`);
  if (result === null) return { problem: null, label: tapped.label };
  const row = askSpecOf(pr, result, '', now).values[tapped.label];
  return row === pathway ? { problem: null, label: tapped.label } : no(`Dave's tap for ${pathway} on PR #${pr} is no longer a row of the question (the CodeRabbit slot changed). Nothing was recorded. Call pr_checkpoint {pr}: it asks Dave again.`);
}

/** The refusal text of ledgerConfirmCheck, or null. */
export const ledgerConfirmProblem = (args) => ledgerConfirmCheck(args).problem;

/**
 * Uses up the tap of a pathway and returns the result of decisionUse: { ok: true }, or { ok: false, reason } (no-decision, label-changed, lock).
 * --confirm --by dave calls it BEFORE it writes the record and refuses on a failure, so one tap never gives two records. `label` is the label that
 * ledgerConfirmCheck read: a tap Dave made in between is label-changed and stays. No label: the tap is used whatever its label (--by auto).
 */
export function ledgerUse({ pr, head, label, d = store }) {
  return d.decisionUse({ step: 'review', key: keyOf(pr), head, label });
}
