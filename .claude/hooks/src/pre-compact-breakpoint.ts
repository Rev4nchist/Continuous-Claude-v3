#!/usr/bin/env node
/**
 * Pre-Compact Breakpoint Hook (card compact-session-breakpoint)
 *
 * When a session compacts (`/compact` or auto), write ONE short state file for the session, built by code with no model call:
 * `~/.claude/state/breakpoint/<session-id>.md` (shared/breakpoint.ts). SessionStart (source compact) injects it after the
 * compact, so Dave types no resume text and answers no outcome question, and a decision he made is not asked again.
 *
 * Hook: PreCompact. Input (Claude Code hooks docs): { trigger: 'manual'|'auto', custom_instructions, session_id, transcript_path, cwd }.
 * Output: always one line { continue: true, systemMessage }. It never blocks a compact: every read error gives a smaller
 * file or no file, and a write error gives "skipped".
 * No peer notice, no Notion row, no lane note change (pre-compact-lane-note.ts logs its own board event).
 * The hook deletes only its OWN session files older than 30 days in its one folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  breakpointPath,
  buildBreakpoint,
  carriedDecisionLines,
  laneFactsFrom,
  parseTranscriptTail,
  pruneOld,
  readSeatShortCard,
  readTranscriptTail,
  seatRoleLines,
  shouldReplace,
  userHome,
  type LaneFacts,
} from './shared/breakpoint.js';
import { spawnLaneCli, branchOf, type LaneRunner } from './pre-compact-lane-note.js';

interface PreCompactInput {
  trigger?: 'manual' | 'auto';
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  custom_instructions?: string | null;
}

interface HookOutput { continue: true; systemMessage: string }

export interface BreakpointDeps {
  home: string;
  now: () => Date;
  runner: LaneRunner;
  branchOf: (cwd: string | undefined) => string | null;
}

const CALL_TIMEOUT_MS = 4000;
const skipped = (why: string): HookOutput => ({ continue: true, systemMessage: `[PreCompact] breakpoint skipped: ${why}` });

/** The lanes of this session. boardOk is false when the read failed or timed out: the holder is then unknown (seat item 6). */
async function lanesOf(sessionId: string, cwd: string, deps: BreakpointDeps): Promise<{ lanes: LaneFacts[]; boardOk: boolean }> {
  try {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const run = await deps.runner(['board', '--json'], { cwd, env, timeoutMs: CALL_TIMEOUT_MS });
    if (run.code !== 0) return { lanes: [], boardOk: false };
    return { lanes: laneFactsFrom(JSON.parse(run.stdout), sessionId), boardOk: true };
  } catch {
    return { lanes: [], boardOk: false };
  }
}

function readExisting(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export async function runPreCompactBreakpoint(input: PreCompactInput, deps: BreakpointDeps): Promise<HookOutput> {
  try {
    const sessionId = input.session_id;
    const file = sessionId ? breakpointPath(deps.home, sessionId) : null;
    if (!sessionId || !file) return skipped('no usable session id');
    const cwd = input.cwd || process.cwd();
    const { decisions, typed } = parseTranscriptTail(readTranscriptTail(input.transcript_path));
    const { lanes, boardOk } = await lanesOf(sessionId, cwd, deps);
    const existing = readExisting(file);
    const facts = {
      sessionId,
      trigger: input.trigger === 'auto' ? 'auto' as const : 'manual' as const,
      now: deps.now(),
      lanes,
      branch: deps.branchOf(cwd),
      decisions,
      typed,
      roleLines: seatRoleLines({ boardOk, lanes }, readSeatShortCard(deps.home)),
      ...(input.transcript_path ? { fullListPath: input.transcript_path } : {}),
    };
    // Never replace with less: judge only what THIS compact found. Carried decisions are not new information, so a compact that
    // found nothing keeps the old file as it is (with its lanes and typed lines).
    if (!shouldReplace(existing, buildBreakpoint(facts))) return { continue: true, systemMessage: '[PreCompact] breakpoint kept (nothing new to save)' };
    writeAtomic(file, buildBreakpoint({ ...facts, carried: carriedDecisionLines(existing) }));
    pruneOld(path.dirname(file), deps.now().getTime());
    return { continue: true, systemMessage: `[PreCompact] breakpoint saved: ${decisions.length} decision(s), ${lanes.length} lane(s)` };
  } catch (err) {
    return skipped(`error (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`);
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  let out: HookOutput;
  try {
    const raw = await readStdin();
    const input: PreCompactInput = raw.trim() ? JSON.parse(raw) : {};
    const home = userHome();
    out = await runPreCompactBreakpoint(input, {
      home,
      now: () => new Date(),
      runner: spawnLaneCli(path.join(home, '.claude', 'scripts', 'lane.mjs')),
      branchOf,
    });
  } catch {
    out = skipped('bad hook input');
  }
  console.log(JSON.stringify(out));
}

// Run only as the hook entry, so tests can import this module.
if ((process.argv[1] || '').includes('pre-compact-breakpoint')) {
  main().catch(() => console.log(JSON.stringify(skipped('error'))));
}
