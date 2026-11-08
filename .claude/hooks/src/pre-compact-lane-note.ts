#!/usr/bin/env node
/**
 * Pre-Compact Lane Note Hook
 *
 * When a session compacts, log ONE short compact event on every lane it holds.
 * The lane board then keeps a durable trail of each compaction.
 * The event never touches lane.note: Dave's progress note stays as he wrote it.
 *
 * Hook: PreCompact
 * Input: { trigger, session_id, transcript_path, cwd? }
 * Output: always one line { continue: true, systemMessage }
 *
 * Lane reads and writes go through the lane CLI shim only (never SQL):
 * the board trigger needs lane.client_version, and the CLI sets it.
 * The write is the event-only verb `compact <id> "text"`. There is NO fallback to `note`: an older CLI that
 * lacks the verb exits 2, and the hook skips. `note` would overwrite the progress note.
 * State: ~/.claude/state/pre-compact-lane-note.json ({ [session_id]: ms }), for the 5 minute cooldown.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { writeStateWithLock } from './shared/atomic-write.js';

interface PreCompactInput {
  trigger?: 'manual' | 'auto';
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  custom_instructions?: string;
}

interface HookOutput {
  continue: true;
  systemMessage: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaneRunner = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<RunResult>;

export interface Deps {
  runner: LaneRunner;
  now: () => Date;
  stateFile: string;
  laneCli: string;
}

const COOLDOWN_MS = 5 * 60 * 1000;
const CALL_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 10_000;
const TODO_MAX = 120;
const NOTE_MAX = 300;
const BRANCH_MAX = 80;
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const SAFE_LANE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

const skipped = (why: string): HookOutput => ({ continue: true, systemMessage: `[PreCompact] lane note skipped: ${why}` });

// ---------------------------------------------------------------- pure logic

/** Ids of lanes this session owns that are not done. */
export function pickHeldLanes(boardJson: unknown, sessionId: string): string[] {
  const lanes = (boardJson as { lanes?: unknown } | null)?.lanes;
  if (!Array.isArray(lanes)) return [];
  const ids: string[] = [];
  for (const l of lanes) {
    const lane = l as { id?: unknown; owner_session_id?: unknown; state?: unknown } | null;
    if (!lane || typeof lane.id !== 'string') continue;
    if (lane.owner_session_id !== sessionId || lane.state === 'done') continue;
    if (SAFE_LANE_ID.test(lane.id)) ids.push(lane.id);
  }
  return ids;
}

/** Printable ASCII only, one line. The shared sanitiser HTML-encodes, which a phone page would show raw. */
function toOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildCompactText(opts: { trigger: 'manual' | 'auto'; now: Date; todo: string | null; branch?: string | null }): string {
  const trigger = opts.trigger === 'manual' || opts.trigger === 'auto' ? opts.trigger : 'unknown';
  const hh = String(opts.now.getHours()).padStart(2, '0');
  const mm = String(opts.now.getMinutes()).padStart(2, '0');
  const todo = toOneLine(opts.todo ?? '').slice(0, TODO_MAX).trim();
  const branch = toOneLine(opts.branch ?? '').slice(0, BRANCH_MAX).trim();
  // No task: leave the clause out, so a session with none does not read as "nothing in progress".
  const text =
    `Compacting (${trigger}) at ${hh}:${mm} local${branch ? ` on branch ${branch}` : ''}.` +
    (todo ? ` Open task: ${todo}.` : '');
  return text.slice(0, NOTE_MAX);
}

interface Found {
  text: string;
  /** Line number of the call that set it, to compare a TodoWrite with a task update. */
  at: number;
}

/**
 * First in_progress todo of the LAST TodoWrite call.
 * Real transcript lines nest the call: { type:'assistant', message:{ content:[{ type:'tool_use', name, input }] } }.
 * lib/transcript-parser.ts reads top-level tool_name only, so it misses these.
 * api-request-blob lines repeat each call and are skipped.
 */
function lastTodoWrite(transcriptText: string): Found | null {
  let last: Array<{ content?: unknown; status?: unknown }> | null = null;
  let at = -1;
  const lines = transcriptText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('TodoWrite')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
      for (const part of entry.message.content) {
        if (part?.type === 'tool_use' && part.name === 'TodoWrite' && Array.isArray(part.input?.todos)) {
          last = part.input.todos;
          at = i;
        }
      }
    } catch { /* skip a partial or corrupt line */ }
  }
  const hit = last?.find((t) => t && t.status === 'in_progress' && typeof t.content === 'string');
  return hit ? { text: hit.content as string, at } : null;
}

export function firstInProgressTodo(transcriptText: string): string | null {
  return lastTodoWrite(transcriptText)?.text ?? null;
}

/**
 * The lowest-numbered task whose last TaskUpdate set it to in_progress.
 * Real shapes: TaskCreate is a tool_use with input.subject. Its id comes back in the next user line as
 * toolUseResult.task.id, matched by tool_use_id. TaskUpdate is a tool_use with input { taskId, status }.
 * A task created before the transcript tail has no known subject and is skipped.
 */
export function firstInProgressTask(transcriptText: string): Found | null {
  const pending = new Map<string, string>(); // tool_use id of a TaskCreate -> subject
  const subjects = new Map<string, string>(); // task id -> subject
  const status = new Map<string, { status: string; at: number }>();
  const lines = transcriptText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('TaskCreate') && !line.includes('TaskUpdate') && !line.includes('"task"')) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      if (entry.type === 'assistant') {
        for (const part of content) {
          if (part?.type !== 'tool_use') continue;
          if (part.name === 'TaskCreate' && typeof part.input?.subject === 'string' && typeof part.id === 'string') {
            pending.set(part.id, part.input.subject);
          } else if (part.name === 'TaskUpdate' && typeof part.input?.taskId === 'string') {
            if (typeof part.input.subject === 'string') subjects.set(part.input.taskId, part.input.subject);
            if (typeof part.input.status === 'string') status.set(part.input.taskId, { status: part.input.status, at: i });
          }
        }
      } else if (entry.type === 'user' && typeof entry.toolUseResult?.task?.id === 'string') {
        for (const part of content) {
          const subject = part?.type === 'tool_result' ? pending.get(part.tool_use_id) : undefined;
          if (subject !== undefined) subjects.set(entry.toolUseResult.task.id, subject);
        }
      }
    } catch { /* skip a partial or corrupt line */ }
  }
  const open = [...status.entries()]
    .filter(([id, s]) => s.status === 'in_progress' && subjects.has(id))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return open.length ? { text: subjects.get(open[0][0]) as string, at: open[0][1].at } : null;
}

/** The open work item: the newer of the last TodoWrite and the last task update. */
export function currentWorkText(transcriptText: string): string | null {
  const todo = lastTodoWrite(transcriptText);
  const task = firstInProgressTask(transcriptText);
  if (todo && task) return todo.at > task.at ? todo.text : task.text;
  return (todo ?? task)?.text ?? null;
}

/** The branch at cwd or above, read from .git/HEAD. Follows the `gitdir:` pointer of a linked worktree. Never throws. */
export function branchOf(cwd: string | undefined): string | null {
  try {
    let dir = path.resolve(cwd || '.');
    for (let i = 0; i < 8; i++) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
          if (!m) return null;
          gitDir = path.resolve(dir, m[1].trim());
        }
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8'));
        return ref ? ref[1].trim() : null;
      }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch { /* no repo, or unreadable: leave the branch out */ }
  return null;
}

export function inCooldown(state: unknown, sessionId: string, nowMs: number): boolean {
  const last = (state as Record<string, unknown> | null)?.[sessionId];
  return typeof last === 'number' && nowMs - last < COOLDOWN_MS;
}

// ---------------------------------------------------------------- IO

function readState(stateFile: string): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Record this session and drop entries older than the cooldown. Never throws. */
function stampState(stateFile: string, sessionId: string, nowMs: number): void {
  try {
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(readState(stateFile))) {
      if (typeof v === 'number' && nowMs - v < COOLDOWN_MS) next[k] = v;
    }
    next[sessionId] = nowMs;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeStateWithLock(stateFile, JSON.stringify(next, null, 2));
  } catch { /* fail open: a state error must not block the hook */ }
}

/** Read at most the last 8 MB of the transcript. TodoWrite rewrites its whole list and tasks are recent, so the tail is enough. */
function readTranscriptTail(file: string | undefined): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Run the lane CLI with a hidden window and a timeout. Never throws; code -1 means it did not run. */
export const spawnLaneCli = (laneCli: string): LaneRunner => (args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(process.execPath, [laneCli, ...args], {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ code: -1, stdout, stderr });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      stderr += 'timeout';
      done(-1);
    }, opts.timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => done(-1));
    proc.on('close', (code) => done(code ?? -1));
  });

// ---------------------------------------------------------------- orchestration

export async function runPreCompactLaneNote(input: PreCompactInput, deps: Deps): Promise<HookOutput> {
  try {
    const sessionId = input.session_id;
    if (!sessionId) return skipped('no session id');
    const started = deps.now().getTime();

    if (inCooldown(readState(deps.stateFile), sessionId, started)) return skipped('cooldown (noted within 5 minutes)');

    const cwd = input.cwd || process.cwd();
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const left = () => Math.min(CALL_TIMEOUT_MS, TOTAL_BUDGET_MS - (deps.now().getTime() - started));

    const boardRun = await deps.runner(['board', '--json'], { cwd, env, timeoutMs: left() });
    if (boardRun.code !== 0) return skipped(`lane board unavailable (exit ${boardRun.code})`);
    let boardJson: unknown;
    try {
      boardJson = JSON.parse(boardRun.stdout);
    } catch {
      return skipped('lane board output is not JSON');
    }

    const held = pickHeldLanes(boardJson, sessionId);
    if (held.length === 0) return skipped('no held lane');

    const text = buildCompactText({
      trigger: input.trigger as 'manual' | 'auto',
      now: deps.now(),
      todo: currentWorkText(readTranscriptTail(input.transcript_path)),
      branch: branchOf(cwd),
    });

    let written = 0;
    for (const laneId of held) {
      if (left() <= 0) break;
      try {
        const r = await deps.runner(['compact', laneId, text], { cwd, env, timeoutMs: left() });
        if (r.code === 0) written++;
      } catch { /* one lane failing must not stop the next */ }
    }
    if (written === 0) return skipped('every compact event write failed');
    stampState(deps.stateFile, sessionId, started);
    return { continue: true, systemMessage: `[PreCompact] compact event logged on ${written} lane(s)` };
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
    const home = process.env.CCV3_USER_HOME || os.homedir();
    const laneCli = path.join(home, '.claude', 'scripts', 'lane.mjs');
    out = await runPreCompactLaneNote(input, {
      runner: spawnLaneCli(laneCli),
      now: () => new Date(),
      // One file under ~/.claude/state, not the project folder: no stray state file in every project you compact in.
      stateFile: path.join(home, '.claude', 'state', 'pre-compact-lane-note.json'),
      laneCli,
    });
  } catch {
    out = skipped('bad hook input');
  }
  console.log(JSON.stringify(out));
}

// Run only as the hook entry, so tests can import this module.
if ((process.argv[1] || '').includes('pre-compact-lane-note')) {
  main().catch(() => console.log(JSON.stringify(skipped('error'))));
}
