// The two-call protocol of the PR checkpoint (pathway-flow-v2, design section 2 step 3). Used by pr-checkpoint.mjs when
// checkpoint.ledger is true in review-router.config.json. Tests: scripts/github/pr-checkpoint-ledger.test.mjs.
//
// Call 1 of `pr_checkpoint {pr}` gets a question spec. The model asks it with AskUserQuestion. The AskUserQuestion hook records Dave's tap
// in the decision store (decisions.mjs). Call 2 reads the tap. A paid pick (coderabbit, both) needs a second tap on a paid confirm.
// Only when the taps exist does the engine let `--confirm <pathway> --by dave` record (ledgerConfirmProblem).
//
// Store bindings: the review question is step `review`, key `<repo>#<pr>`, head. The paid confirm of a pick is step `paid-round`, key
// `<repo>#<pr>!pick:<pathway>`, head. (The plain key `<repo>#<pr>` of step `paid-round` is the ship-ask question for a paid round.)
import * as store from './decisions.mjs';

const PAID = ['coderabbit', 'both'];
const PER_FILE = 0.25;
const GREPTILE_CREDITS = 3;
const usd = (n) => `$${n.toFixed(2)}`;
const one = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const clip = (t, n) => (one(t).length > n ? `${one(t).slice(0, n - 1)}…` : one(t));
const RECOMMENDED = ' (Recommended)';

const NAMES = { none: 'No review, land on CI', coderabbit: 'CodeRabbit review', both: 'CodeRabbit + Greptile', wait: 'Keep as draft' };

/** The label of a pathway row, with its cost. */
function labelOf(pathway, result) {
  const up = usd(result.size.files * PER_FILE);
  if (pathway === 'none') return 'No review, land on CI ($0)';
  if (pathway === 'wait') return 'Keep as draft ($0)';
  if (pathway === 'both') return `CodeRabbit + Greptile (up to ${up} + ${GREPTILE_CREDITS} credits)`;
  return result.capacity?.state === 'free' ? 'CodeRabbit now (free slot, $0)' : `CodeRabbit review (up to ${up})`;
}

/** The recommendation of the question. A held recommendation (not among the open options) falls back to the safe pick: Keep as draft. */
function recommendedOf(result) {
  const rec = result.recommended;
  const open = result.options.some((o) => o.pathway === rec && o.available);
  return rec === 'wait' || open ? rec : 'wait';
}

/** The pathways of the question, recommended first: the open rows, then Keep as draft, then none. At most 4. */
function rowsOf(result) {
  const open = result.options.filter((o) => o.available && o.pathway !== 'wait').map((o) => o.pathway);
  const rec = recommendedOf(result);
  const first = [rec];
  const rest = [...open.filter((p) => p !== 'none'), 'wait', ...(open.includes('none') ? ['none'] : [])];
  return [...first, ...rest.filter((p) => !first.includes(p))];
}

function describe(pathway, result, first) {
  const o = result.options.find((x) => x.pathway === pathway);
  const base = pathway === 'wait' ? 'Records nothing. The PR stays a draft.' : one(o?.reason ?? '');
  const drift = first && result.config_drift ? ` Warning: ${result.config_drift_why ?? 'branch config differs from main'}.` : '';
  return `${base}${drift}`.trim() || 'No details.';
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
 * The recommendation is first and carries " (Recommended)". 2 to 4 options.
 */
export function askSpecOf(pr, result, slotLine) {
  const rows = rowsOf(result);
  const options = rows.map((p, i) => ({ label: `${labelOf(p, result)}${i === 0 ? RECOMMENDED : ''}`, description: describe(p, result, i === 0) }));
  const values = Object.fromEntries(rows.map((p, i) => [options[i].label, p]));
  return { header: clip(`PR #${pr}`, 12), question: questionOf(pr, result, slotLine), options, values };
}

/** The paid confirm of one pick. The FIRST option is "No, keep the PR a draft (Recommended)". */
export function paidConfirmSpecOf(pr, pathway, result) {
  const up = usd(result.size.files * PER_FILE);
  const no = `No, keep the PR a draft${RECOMMENDED}`;
  const yes = `Yes, record ${pathway} (up to ${up})`;
  const question = [`PR #${pr}: record ${NAMES[pathway]} (up to ${up})?`, 'It can cost money.', 'If you say No, nothing is recorded and the PR stays a draft.'].join('\n');
  return {
    header: clip(`PR #${pr}`, 12), question, values: { [no]: 'no', [yes]: 'yes' },
    options: [{ label: no, description: 'Records nothing. The PR stays a draft. No money is spent.' }, { label: yes, description: `Records ${pathway}, labels the PR and marks it ready for review.` }],
  };
}

const printable = ({ header, question, options }) => ({ header, question, options });
const keyOf = (pr) => store.decisionKey({ pr });
const pickKey = (pr, pathway) => `${keyOf(pr)}!pick:${pathway}`;
const valueOf = (triple, d) => d.offerRead(triple)?.spec?.values?.[d.decisionRead(triple)?.label] ?? null;

/** Opens (or re-opens) the question. An open offer with no tap is a miss: count it, and stop after MAX_REASKS re-asks. */
function askAgain(pr, triple, spec, d) {
  const reopened = d.offerRead(triple)?.open === true;
  const missed = reopened ? d.missBump(triple) : d.missCount(triple);
  if (missed > d.MAX_REASKS) return { state: 'stop', text: `Stop. PR #${pr} stays a draft. Nothing was recorded. Tell Dave.` };
  const w = d.offerWrite({ ...triple, spec, tree: null, cwd: process.cwd() });
  if (!w.ok) return { state: 'stop', text: `Stop. The question could not be saved (${w.reason}). PR #${pr} stays a draft. Nothing was recorded. Tell Dave.` };
  const again = missed > 0 ? ` No answer matched an option. This is re-ask ${missed} of ${d.MAX_REASKS}.` : '';
  return { state: triple.step === 'review' ? 'ask' : 'confirm-paid', ask: printable(spec), reasked: missed, text: `Call AskUserQuestion with ask, word for word.${again} Then call pr_checkpoint {pr} again.` };
}

const kept = (pr, d, triples) => { triples.forEach((t) => d.decisionUse(t)); return { state: 'kept-draft', text: `Nothing was recorded. PR #${pr} stays a draft. Call pr_checkpoint {pr} when Dave wants to pick again.` }; };

/**
 * ledgerStep({ pr, result, slotLine, askAnyway, d }) -> { state, ask?, pathway?, by?, reasked?, text }. d is the decisions module (a test seam).
 * askAnyway skips the auto-eligible short-circuit: the mod passes it (--ask-anyway) when auto-confirm failed, so Dave still gets the question.
 * state: none (no question: a stop or an auto-confirm), ask, confirm-paid (ask holds the paid confirm), record (run --confirm <pathway> --by dave),
 * kept-draft (nothing recorded), stop (the re-asks are used up).
 */
export function ledgerStep({ pr, result, slotLine, askAnyway = false, d = store }) {
  if (result.recommended === null || (result.auto?.eligible === true && askAnyway !== true) || result.options.length === 0) return { state: 'none', text: 'No question is needed.' };
  const triple = { step: 'review', key: keyOf(pr), head: result.head };
  const pathway = valueOf(triple, d);
  if (pathway === null) return askAgain(pr, triple, askSpecOf(pr, result, slotLine), d);
  if (pathway === 'wait') return kept(pr, d, [triple]);
  const record = { state: 'record', pathway, by: 'dave', text: `Dave picked ${pathway}. Record it.` };
  if (!PAID.includes(pathway)) return record;
  const paid = { step: 'paid-round', key: pickKey(pr, pathway), head: result.head };
  const answer = valueOf(paid, d);
  if (answer === null) return askAgain(pr, paid, paidConfirmSpecOf(pr, pathway, result), d);
  return answer === 'yes' ? record : kept(pr, d, [paid, triple]);
}

/**
 * Why `--confirm <pathway> --by <by>` must refuse while the ledger flag is on, or null. Dave's pick needs his tap on the review question
 * (and, for a paid pathway, his Yes on the paid confirm). --by default never records. --by auto is not a tap and keeps its own rules.
 */
export function ledgerConfirmProblem({ pr, head, pathway, by, d = store }) {
  if (by === 'auto') return null;
  if (by === 'default') return 'checkpoint.ledger is on: --by default records nothing. Only Dave\'s tap (--by dave) or an eligible auto-confirm records.';
  if (pr === null) return 'checkpoint.ledger is on: --confirm needs --pr <number>, the PR whose question Dave answered.';
  const tapped = valueOf({ step: 'review', key: keyOf(pr), head }, d);
  if (tapped !== pathway) return `No tap of Dave's for ${pathway} on PR #${pr} at ${String(head).slice(0, 7)}. Call pr_checkpoint {pr}: it asks Dave.`;
  if (!PAID.includes(pathway)) return null;
  return valueOf({ step: 'paid-round', key: pickKey(pr, pathway), head }, d) === 'yes' ? null : `${pathway} is paid and Dave has not said Yes to the paid confirm. Call pr_checkpoint {pr}: it asks Dave.`;
}

/** Uses up the taps of a recorded pathway. Call it after --confirm wrote the record. */
export function ledgerUse({ pr, head, pathway, d = store }) {
  d.decisionUse({ step: 'review', key: keyOf(pr), head });
  if (PAID.includes(pathway)) d.decisionUse({ step: 'paid-round', key: pickKey(pr, pathway), head });
}
