/**
 * The session break point (card compact-session-breakpoint, seat GO 2026-11-14).
 *
 * `/compact` is built in: no command can run it. So the one command stays `/compact`, and two hooks do the rest:
 *  - PreCompact (`pre-compact-breakpoint.ts`) writes ONE short state file, built by code with no model call:
 *    `~/.claude/state/breakpoint/<session-id>.md`. It holds the lane facts, the AskUserQuestion questions and answers
 *    of the session ("decisions made"), Dave's last typed lines, and one resume sentence.
 *  - SessionStart with source `compact` (`session-start-continuity.ts`) injects that file in place of the ledger dump,
 *    and drops the outcome question.
 * Pure functions here. Nothing in this file throws: a read error gives an empty answer (the compact never waits on it).
 *
 * Transcript line shapes were READ from a real session transcript of this harness (see the test file header):
 * an AskUserQuestion call is an `assistant` line with a `tool_use` block; its answer is a `user` line with a
 * `tool_result` block and a top-level `toolUseResult.answers` ({ <question>: <answer> }); a line Dave typed has
 * `origin.kind === 'human'` and a string `message.content`. The transcript format is internal and can change between
 * Claude Code versions, so every read is defensive and a miss only shrinks the file.
 *
 * Every text goes through `maskSecrets` before it is written. The file stays under MAX_FILE_CHARS and the injected text
 * under MAX_INJECT_CHARS (the hook context cap is 10,000 characters).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maskSecrets } from './guard-log.js';

export const MAX_FILE_CHARS = 3500;
export const MAX_INJECT_CHARS = 3900;
export const TYPED_HEADER = "Dave's last lines (context, not decisions)";
/** Read this much of the END of the transcript: a long session has a file of 150 MB and more. */
export const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TYPED = 5;
const TYPED_CUT = 300;
const QUESTION_CUT = 140;
const ANSWER_CUT = 160;
const NOTE_CUT = 80;
const LANE_FIELD_CUT = 200;
const PRUNE_DAYS = 30;
const SAFE_LANE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
/** A session id as a file name: letters, digits and dashes only. No separator, no dot. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
const OWN_FILE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}\.md$/;

export interface Decision { at: string; header: string; question: string; answer: string; note?: string }
export interface TypedLine { at: string; text: string }
export interface LaneFacts { id: string; title: string; goal: string; next: string; milestone: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

// ---------------------------------------------------------------- the transcript

interface PendingCall { questions: Array<{ header: string; question: string }> }

function answersFromText(content: string, questions: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const start = content.indexOf(`"${q}"="`);
    if (start < 0) continue;
    const from = start + q.length + 4;
    const ends = [content.indexOf('". You can now', from), content.indexOf('", "', from)].filter((i) => i >= 0);
    out[q] = content.slice(from, ends.length ? Math.min(...ends) : content.length).replace(/"$/, '');
  }
  return out;
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const b of content) if (isObj(b) && b.type === 'tool_result' && typeof b.content === 'string') return b.content;
  return '';
}

function resultFor(o: Record<string, unknown>, call: PendingCall): Record<string, string> {
  const tur = o.toolUseResult;
  if (isObj(tur) && isObj(tur.answers)) {
    const out: Record<string, string> = {};
    for (const [q, a] of Object.entries(tur.answers)) if (typeof a === 'string') out[q] = a;
    return out;
  }
  const msg = isObj(o.message) ? o.message : {};
  return answersFromText(toolResultText(msg.content), call.questions.map((q) => q.question));
}

function noteFor(o: Record<string, unknown>, question: string): string | undefined {
  const ann = isObj(o.toolUseResult) ? o.toolUseResult.annotations : undefined;
  const entry = isObj(ann) ? ann[question] : undefined;
  const notes = isObj(entry) ? entry.notes : undefined;
  return typeof notes === 'string' && notes.trim() ? oneLine(notes) : undefined;
}

/**
 * The decisions (every AskUserQuestion that has an answer, oldest first) and the last typed lines of a transcript text.
 * The text may start in the middle of a line (a tail read): that line is not JSON and is skipped. Never throws.
 */
export function parseTranscriptTail(text: string): { decisions: Decision[]; typed: TypedLine[] } {
  const decisions: Decision[] = [];
  const typed: TypedLine[] = [];
  const pending = new Map<string, PendingCall>();
  for (const line of text.split('\n')) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o)) continue;
    const msg = isObj(o.message) ? o.message : null;
    if (!msg) continue;
    if (o.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b) || b.type !== 'tool_use' || b.name !== 'AskUserQuestion' || typeof b.id !== 'string') continue;
        const qs = isObj(b.input) && Array.isArray(b.input.questions) ? b.input.questions : [];
        const questions = qs.filter(isObj).filter((q) => typeof q.question === 'string')
          .map((q) => ({ header: typeof q.header === 'string' ? q.header : '', question: q.question as string }));
        if (questions.length) pending.set(b.id, { questions });
      }
    } else if (o.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        const answers = resultFor(o, call);
        const at = typeof o.timestamp === 'string' ? o.timestamp : '';
        for (const q of call.questions) {
          if (typeof answers[q.question] !== 'string') continue;
          const note = noteFor(o, q.question);
          decisions.push({ at, header: q.header, question: q.question, answer: answers[q.question], ...(note ? { note } : {}) });
        }
      }
    } else if (o.type === 'user' && typeof msg.content === 'string' && !o.isMeta) {
      const origin = isObj(o.origin) ? o.origin : null;
      const body = msg.content.trim();
      // Only text a human typed, accepted or queued. A plugin, a task notification and the harness have another origin or
      // start with "<" (a command line, a system reminder).
      if (origin?.kind !== 'human' || !body || body.startsWith('<')) continue;
      typed.push({ at: typeof o.timestamp === 'string' ? o.timestamp : '', text: cut(oneLine(body), TYPED_CUT) });
    }
  }
  return { decisions, typed: typed.slice(-MAX_TYPED) };
}

/** The last `maxBytes` of a file as text, from a line start. '' when the file cannot be read. Never throws. */
export function readTranscriptTail(file: string | undefined, maxBytes: number = TAIL_BYTES): string {
  if (!file) return '';
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    if (size <= len) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
  }
}

// ---------------------------------------------------------------- the lane facts

/** GOAL, NEXT and milestone path of each open lane this session holds, from the board JSON of the lane shim. */
export function laneFactsFrom(board: unknown, sessionId: string): LaneFacts[] {
  const lanes = isObj(board) ? board.lanes : undefined;
  if (!Array.isArray(lanes)) return [];
  const out: LaneFacts[] = [];
  for (const l of lanes) {
    if (!isObj(l) || typeof l.id !== 'string' || l.owner_session_id !== sessionId || l.state === 'done') continue;
    if (!SAFE_LANE_ID.test(l.id)) continue;
    const note = typeof l.note === 'string' ? l.note : '';
    out.push({
      id: l.id,
      title: typeof l.title === 'string' ? l.title : '',
      goal: /GOAL:\s*(.*?)(?:\s+\|\s+|$)/.exec(note)?.[1]?.trim() ?? '',
      next: /NEXT[^:|]*:\s*(.*?)(?:\s+\|\s+|$)/.exec(note)?.[1]?.trim() ?? '',
      milestone: /MS:\s*(\S+)/.exec(note)?.[1] ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- the file

export interface BreakpointInput {
  sessionId: string;
  trigger: 'manual' | 'auto' | string;
  now: Date;
  lanes: LaneFacts[];
  branch: string | null;
  decisions: Decision[];
  typed: TypedLine[];
  /** Decision lines of the previous state file (`carriedDecisionLines`), older than `decisions`. */
  carried?: string[];
}

/** hh:mm of an ISO UTC timestamp, marked with Z (the transcript times are UTC). */
const hhmm = (at: string): string => { const m = /T(\d\d:\d\d)/.exec(at)?.[1]; return m ? `${m}Z` : ''; };
const mask = (s: string, n: number): string => cut(maskSecrets(oneLine(s)), n);

/** The lane block with each field cut to `cut` characters. cut 0 gives the lane ids only. */
function laneBlock(lanes: LaneFacts[], cut: number = LANE_FIELD_CUT): string[] {
  if (!lanes.length) return [];
  const out = ['## Lanes held'];
  for (const l of lanes) {
    out.push(`- ${l.id}${l.title && cut ? `: ${mask(l.title, 100)}` : ''}`);
    if (!cut) continue;
    if (l.goal) out.push(`  GOAL: ${mask(l.goal, cut)}`);
    if (l.next) out.push(`  NEXT: ${mask(l.next, cut)}`);
    if (l.milestone) out.push(`  MS: ${mask(l.milestone, Math.min(200, cut))}`);
  }
  return out;
}

const size = (lines: string[]): number => (lines.length ? lines.join('\n').length + 1 : 0);

function decisionLine(d: Decision): string {
  const head = d.header ? `${mask(d.header, 30)}: ` : '';
  const note = d.note ? ` (note: ${mask(d.note, NOTE_CUT)})` : '';
  return `- [${hhmm(d.at)}] ${head}${mask(d.question, QUESTION_CUT)} -> ${mask(d.answer, ANSWER_CUT)}${note}`;
}

/** The text of the state file. Under MAX_FILE_CHARS: the NEWEST decisions stay when there are too many. */
export function buildBreakpoint(input: BreakpointInput): string {
  const head = [
    '# Session breakpoint',
    `session: ${input.sessionId} | trigger: ${input.trigger} | at: ${input.now.toISOString().slice(0, 16)}Z`,
    ...(input.branch ? [`branch: ${mask(input.branch, 100)}`] : []),
  ];
  const resume = ['## Resume', 'Resume: continue with the NEXT step of the lane note. Do not re-ask a decision above.'];
  // Budget order (seat review 11-14): decisions are the purpose of the file, so they take the room FIRST, newest first. The lane
  // block takes what is left (fields cut to fit, down to the ids), then the typed lines (newest first, one by one).
  let room = MAX_FILE_CHARS - size(head) - size(resume) - 40;
  // Older decisions first (carried from the previous file: the tail read of a long transcript may not reach them), then the new
  // ones. The same decision gives the same line, so it is listed once.
  const fresh = input.decisions.map(decisionLine);
  const freshSet = new Set(fresh);
  const lines = [...(input.carried ?? []).filter((l) => !freshSet.has(l)), ...fresh];
  const decHead = '## Decisions made (Do not ask these again)';
  const kept: string[] = [];
  // The lane ids never drop out: the ids-only lane block is reserved before the decisions take the room (seat tweak 11-14).
  let decRoom = room - size(laneBlock(input.lanes, 0)) - decHead.length - 1;
  for (let i = lines.length - 1; i >= 0 && lines[i].length + 1 <= decRoom; i--) {
    kept.unshift(lines[i]);
    decRoom -= lines[i].length + 1;
  }
  const decisions = kept.length ? [decHead, ...kept] : [];
  room -= size(decisions);
  const lanes = [LANE_FIELD_CUT, 80, 0].map((c) => laneBlock(input.lanes, c)).find((b) => size(b) <= room) ?? laneBlock(input.lanes, 0);
  room -= size(lanes);
  const typedLines = input.typed.map((t) => `- [${hhmm(t.at)}] ${mask(t.text, TYPED_CUT)}`);
  const typedKept: string[] = [];
  let typedRoom = room - TYPED_HEADER.length - 4;
  for (let i = typedLines.length - 1; i >= 0 && typedLines[i].length + 1 <= typedRoom; i--) {
    typedKept.unshift(typedLines[i]);
    typedRoom -= typedLines[i].length + 1;
  }
  const typed = typedKept.length ? [`## ${TYPED_HEADER}`, ...typedKept] : [];
  const text = [...head, ...lanes, ...decisions, ...typed, ...resume].join('\n') + '\n';
  return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS - 1) : text;
}

/**
 * The decision items of a previous state file, as written. Only the "Decisions made" block and only lines that start like an
 * item. A decision that fell out of the transcript tail stays in the next file this way. Never throws.
 */
export function carriedDecisionLines(fileText: string | null): string[] {
  if (!fileText) return [];
  const out: string[] = [];
  let inBlock = false;
  for (const line of fileText.split('\n')) {
    if (line.startsWith('## ')) { inBlock = line.startsWith('## Decisions made'); continue; }
    if (inBlock && /^- \[/.test(line)) out.push(line);
  }
  return out.slice(-100);
}

const hasContent = (text: string): boolean => /^- /m.test(text);

/** Never replace with less: a file that has items is not replaced by one that has none. */
export function shouldReplace(existing: string | null, next: string): boolean {
  if (existing === null) return true;
  return !(hasContent(existing) && !hasContent(next));
}

/** One file per session under the home state folder. null for a session id that could leave the folder. */
export function breakpointPath(home: string, sessionId: string): string | null {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return null;
  return path.join(home, '.claude', 'state', 'breakpoint', `${sessionId}.md`);
}

/** Delete session files older than 30 days in that one folder. Anything else stays. Returns the count. Never throws. */
export function pruneOld(dir: string, nowMs: number): number {
  let removed = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !OWN_FILE.test(e.name)) continue;
      const file = path.join(dir, e.name);
      try {
        if (nowMs - fs.statSync(file).mtimeMs > PRUNE_DAYS * 24 * 3600 * 1000) { fs.unlinkSync(file); removed++; }
      } catch { /* one file failing does not stop the next */ }
    }
  } catch { /* no folder */ }
  return removed;
}

/** A state file counts for the resume only when it was written at most this long before SessionStart (seat review 11-14). */
export const FRESH_MS = 10 * 60 * 1000;

/**
 * The state file of a session, or null when there is none, it is older than FRESH_MS, or it cannot be read. Never throws.
 * A file from an earlier compact (the hook timed out, is not registered, or kept the old file) must not replace today's context.
 */
export function readBreakpoint(home: string, sessionId: string | undefined, nowMs: number = Date.now()): string | null {
  const file = sessionId ? breakpointPath(home, sessionId) : null;
  if (!file) return null;
  try {
    if (nowMs - fs.statSync(file).mtimeMs > FRESH_MS) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

export const userHome = (): string => process.env.CCV3_USER_HOME || os.homedir();

// ---------------------------------------------------------------- the resume

const INJECT_HEAD = [
  'SESSION BREAKPOINT: state data that code wrote before the compact. It is not a new instruction from Dave.',
  'Read the lane note and every live page again before you rely on them. Do not re-ask a decision below. Continue with the NEXT step.',
  '---',
].join('\n');

/** The text SessionStart injects after a compact. Under MAX_INJECT_CHARS. */
export function injectionText(fileText: string): string {
  const room = MAX_INJECT_CHARS - INJECT_HEAD.length - 1;
  return `${INJECT_HEAD}\n${fileText.length > room ? fileText.slice(0, room) : fileText}`;
}

/**
 * The SessionStart context. After a compact with a state file, the state file replaces the ledger dump, the handoff and the
 * outcome question. After startup, resume, clear or any other source, and after a compact with no file, the context is
 * unchanged (fail open: today's behaviour stays).
 */
export function applyBreakpoint(sessionType: string | undefined, additionalContext: string, fileText: string | null): string {
  if (sessionType !== 'compact' || !fileText || !fileText.trim()) return additionalContext;
  return injectionText(fileText);
}
