#!/usr/bin/env node
/**
 * decision-ledger -- PostToolUse (matcher: AskUserQuestion). Pathway flow v2, design N2.
 *
 * A script (ship-ask.mjs, the pr_checkpoint engine) writes an OFFER: a question the model must ask Dave. The model
 * passes the question to AskUserQuestion word for word. This hook reads the answer. An exact option label of one
 * open offer becomes a DECISION in the store (decisions.mjs), bound to the offer's step, key and head.
 * Anything else (free text, an empty answer, an array) records nothing, and the hook tells the model to ask again:
 * "re-ask 1 of 2", then "Stop".
 *
 * Match rule: header, question text and the option labels (in order) must all equal one open offer. Two offers can share
 * a header and labels (land, two PRs), so the question text picks the PR. If more than one offer still matches, nothing
 * is recorded (fail closed). A question with an offer's header that matches no offer is not recorded: the hook says so.
 * A question that has no offer with its header is not ours: the hook says nothing.
 *
 * Miss count. The pr_checkpoint engine owns it for the review offers (step review, and the paid confirm of a pick):
 * it bumps the count when the model calls it again with no tap. This hook only READS it there, or one bad answer would
 * cost two re-asks. Every other offer (ship, open-pr, land, the paid-round question) has no engine call, so this hook
 * bumps its count.
 *
 * Main session only: a subagent's AskUserQuestion never records. Fails open: any error is {} and nothing records.
 * Two gates: the matcher in settings.json.template (AskUserQuestion) and the tool_name check below.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { MAX_REASKS, decisionRecord, missBump, missCount, offerList, type Offer, type TapAudit } from './shared/decisions-store.js';

const TOOL = 'AskUserQuestion';

interface Question { question?: unknown; header?: unknown; options?: unknown }
interface HookInput { tool_name?: string; tool?: string; tool_input?: { questions?: unknown }; tool_response?: unknown; agent_id?: string; cwd?: string }

const isText = (v: unknown): v is string => typeof v === 'string';
const labelsOf = (q: Question): string[] => (Array.isArray(q.options) ? q.options.map((o) => (o as { label?: unknown })?.label).filter(isText) : []);
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The answers, keyed by question text. The tool result is an object { questions, answers }, a JSON string of it, or the text
 * `Your questions have been answered: "<question>"="<answer>". You can now continue ...`. A value that is not a string is dropped.
 */
export function parseAnswers(resp: unknown, questions: Question[]): Record<string, string> {
  if (isText(resp)) {
    try { return parseAnswers(JSON.parse(resp), questions); } catch { return answersFromText(resp, questions); }
  }
  const answers = (resp as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return {};
  return Object.fromEntries(Object.entries(answers).filter((e): e is [string, string] => isText(e[1])));
}

/** Text form. After `"<question>"="` the answer is an option label when the text goes on with that label and a quote, else free text. */
function answersFromText(text: string, questions: Question[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    if (!isText(q.question)) continue;
    const at = text.indexOf(`"${q.question}"="`);
    if (at < 0) continue;
    const rest = text.slice(at + q.question.length + 4);
    const label = [...labelsOf(q)].sort((a, b) => b.length - a.length).find((l) => rest.startsWith(`${l}"`));
    out[q.question] = label ?? rest.split(/"\. You can now continue/)[0].replace(/"\.?$/, '');
  }
  return out;
}

/** Review offers belong to the pr_checkpoint engine (it bumps the miss count on its re-call): the review pick and the paid confirm of a pick. */
const engineOwned = (o: Offer): boolean => o.step === 'review' || (o.step === 'paid-round' && o.key.includes('!pick:'));
const prOf = (o: Offer): string => /#(\d+)/.exec(o.key)?.[1] ?? '';

const STOP_TAIL: Record<string, string> = {
  review: 'The PR stays a draft.',
  'paid-round': 'Nothing paid runs.',
  'cli-skip': 'The CLI review skip stays refused.',
};

function missText(o: Offer): string {
  const triple = { step: o.step, key: o.key, head: o.head };
  const engine = engineOwned(o);
  const count = engine ? missCount(triple) : missBump(triple);
  const stop = engine ? count >= MAX_REASKS : count > MAX_REASKS;
  if (stop) return `Stop. Nothing was recorded: the answer to the "${o.step}" question matched no option after ${MAX_REASKS} re-asks. ${STOP_TAIL[o.step] ?? 'The action does not run.'} Tell Dave. Do not ask again.`;
  const n = engine ? count + 1 : count;
  const how = engine ? `Call pr_checkpoint with pr: ${prOf(o)} (it returns the question again)` : 'Ask the same question again with AskUserQuestion, word for word';
  return `No match. Nothing was recorded for the "${o.step}" question: the answer was not one of its options (re-ask ${n} of ${MAX_REASKS}). ${how}.`;
}

/**
 * The audit facts for the decision log (card decision-append-log): the session label from its identity file and the lane ids from `lane.mjs mine --json` (2 s cap).
 * Any failure gives null for that part, and the tap still records. Skipped (both null) under vitest and with CCV3_DECISION_AUDIT=off, so a unit test never spawns the lane CLI.
 * It runs once per matched tap, before the store lock, and never for a question that is not ours.
 */
export function auditFacts(env: NodeJS.ProcessEnv = process.env, cwd?: string): TapAudit {
  if (env.VITEST || env.CCV3_DECISION_AUDIT === 'off') return { session: null, lane: null };
  const id = env.CLAUDE_CODE_SESSION_ID ?? '';
  let session: string | null = null;
  if (/^[0-9a-f-]{8,64}$/i.test(id)) {
    session = id.slice(0, 8);
    try {
      const j = JSON.parse(readFileSync(join(homedir(), '.claude', 'state', 'identity', `${id}.json`), 'utf8')) as { short?: unknown; name?: unknown };
      const short = isText(j.short) && j.short ? j.short : session;
      session = isText(j.name) && j.name ? `${short} ${j.name}` : short;
    } catch { /* the 8-hex handle stays */ }
  }
  let lane: string[] | null = null;
  try {
    const r = spawnSync(process.execPath, [join(homedir(), '.claude', 'scripts', 'lane.mjs'), 'mine', '--json'], { encoding: 'utf8', timeout: 2000, windowsHide: true, cwd, env });
    const start = (r.stdout ?? '').indexOf('[');
    if (r.status === 0 && start >= 0) {
      const rows = JSON.parse((r.stdout ?? '').slice(start)) as unknown;
      if (Array.isArray(rows)) lane = rows.map((x) => (x as { id?: unknown })?.id).filter(isText);
    }
  } catch { /* lane stays null */ }
  return { session, lane };
}

/** The note for one asked question, or null when it is not an offer question. */
function noteFor(q: Question, answers: Record<string, string>, offers: Offer[], getAudit: () => TapAudit): string | null {
  if (!isText(q.question) || !isText(q.header)) return null;
  const sameHeader = offers.filter((o) => o.spec?.header === q.header);
  if (sameHeader.length === 0) return null;
  const labels = labelsOf(q);
  const hits = sameHeader.filter((o) => o.spec?.question === q.question && sameList(o.labels, labels));
  if (hits.length !== 1) return `Not recorded: the "${q.header}" question does not match one open offer (${hits.length === 0 ? 'its text or options differ' : 'two offers match'}). Ask the question exactly as the script printed it.`;
  const o = hits[0];
  const answer = answers[q.question];
  if (!isText(answer) || !o.labels.includes(answer)) return missText(o);
  // The entry point is the hook's own environment: the model cannot change it. The store stamps it with the tap time (a paid post reads both).
  const r = decisionRecord({ step: o.step, key: o.key, head: o.head, label: answer, entry: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, audit: getAudit() });
  // The tap is recorded even when the decision log could not be written (fail open): say so, so Dave and the seat know the audit line is missing.
  if (r.ok) return `Recorded "${answer}" for the ${o.step} question (${o.key}).${r.log?.ok === false ? ` The decision log was NOT written (${r.log.reason}): the tap is recorded, the audit line is missing. Tell Dave.` : ''}`;
  return r.reason === 'lock' ? `Not recorded: the decision store was busy. Ask the same question again.` : null;
}

/** The whole hook: stdin text in, stdout text out. Never throws. */
export function handle(raw: string, getAudit: () => TapAudit = () => auditFacts(process.env, undefined)): string {
  try {
    const input = JSON.parse(raw.trim() || '{}') as HookInput;
    if ((input.tool_name || input.tool) !== TOOL || input.agent_id || process.env.CLAUDE_AGENT_ID) return '{}';
    const asked = input.tool_input?.questions;
    const questions = (Array.isArray(asked) ? asked : []) as Question[];
    const answers = parseAnswers(input.tool_response, questions);
    const offers = offerList();
    const notes = questions.map((q) => noteFor(q, answers, offers, getAudit)).filter(isText);
    if (notes.length === 0) return '{}';
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } });
  } catch {
    return '{}';
  }
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  try { console.log(handle(readFileSync(0, 'utf8'))); } catch { console.log('{}'); }
}
