import { stripControl } from '../server/sources/safe-message';

/**
 * The open Question flag (card agentic-os-readers, reader 2). PURE: no 'server-only', no '@/' import.
 *
 * Source: the `step` of a session state file. The plugin adds a step at tool start and removes it at tool end
 * (.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx:1058-1066), so a step in the file means the tool runs and its
 * absence is the end. The step has no question text. A flag holds the session label, the start time, the age and the
 * certainty: never the step label and never the full session id.
 * [Speculation] Whether a snapshot is written while the dialog is open is not proven; the chip is the weaker fallback.
 */

export const OPEN_QUESTION_FRESH_MS = 10 * 60_000;
const CHIP_WAITING = 'waiting-on-dave';
const LABEL_CLIP = 160;

export type QuestionSnapshot = {
  /** "name #sid8", built by the caller from the identity file. */
  label: string;
  /** The snapshot write time (epoch ms). */
  at: number;
  endedAt: number | null;
  chip: string | null;
  step: { tool: string; startedAt: number } | null;
};
export type OpenQuestion = { session: string; certainty: 'sure' | 'guessed'; startedAtMs: number | null; ageSec: number | null };
export type StepFields = { tool: string; label: string; startedAt: number; id: string | null; questions: number | null };

export function foldOpenQuestions(snapshots: QuestionSnapshot[], nowMs: number): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const s of snapshots) {
    if (s.endedAt !== null) continue;
    // KNOWN LIMIT (card agentic-os-readers-edge-limits): a session that waits on Dave and stays idle drops out once its last state write is older
    // than the fresh limit, because the plugin writes no snapshot while a dialog stays open. Kept on purpose: the other side is a crashed session.
    if (nowMs - s.at > OPEN_QUESTION_FRESH_MS) continue; // a crashed session leaves a step behind
    if (s.step?.tool === 'AskUserQuestion') {
      out.push({ session: s.label, certainty: 'sure', startedAtMs: s.step.startedAt, ageSec: Math.max(0, Math.floor((nowMs - s.step.startedAt) / 1000)) });
    } else if (s.chip === CHIP_WAITING) {
      out.push({ session: s.label, certainty: 'guessed', startedAtMs: null, ageSec: null });
    }
  }
  // The oldest question first; a guessed flag (no start time) after every sure one.
  return out.sort((a, b) => (a.startedAtMs ?? Number.POSITIVE_INFINITY) - (b.startedAtMs ?? Number.POSITIVE_INFINITY));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The step of a state file: the three old fields, plus the plugin's `id` and a question count (1 to 4, AskUserQuestion only). */
export function parseStepFields(value: unknown): StepFields | null {
  if (!isRecord(value)) return null;
  const { tool, startedAt, label, id, questions } = value;
  if (typeof tool !== 'string' || tool === '' || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  const count = tool === 'AskUserQuestion' && Array.isArray(questions) && questions.length >= 1 && questions.length <= 4 ? questions.length : null;
  return {
    tool: tool.slice(0, 80),
    label: typeof label === 'string' ? stripControl(label.slice(0, LABEL_CLIP)) : '',
    startedAt,
    id: typeof id === 'string' && id !== '' ? id.slice(0, 80) : null,
    questions: count,
  };
}
