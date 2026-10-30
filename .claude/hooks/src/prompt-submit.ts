#!/usr/bin/env node
/**
 * prompt-submit: the 5 UserPromptSubmit hooks in ONE node process.
 *
 * WHY
 * Windows Defender scans every node.exe start and every file it loads. Claude Code
 * started 5 UserPromptSubmit hooks in parallel on every prompt. In parallel they took
 * up to 4.8 s (one of them alone: 119 ms), so they hit their 5 s timeouts and the
 * output was thrown away. One process pays for one start and loads pg once.
 *
 * WHAT IT RUNS
 *   heartbeat, memory-awareness, user-confirmation-detector, bus-session-populator,
 *   lane-context. Each exports `runX(raw)`: the raw stdin text in, the object its own
 *   main() prints out. Raw text, not a parsed object, because the five treat bad JSON
 *   five different ways. Each keeps its own rules.
 *
 * CONTRACT
 *   - stdout is exactly ONE JSON object, written once, then process.exit(0).
 *   - A job that throws or misses the deadline loses only its own output.
 *   - Exit code is always 0.
 *
 * Settings register this file alone on UserPromptSubmit (timeout 15 s). The five
 * standalone dists stay built, so an older settings.json keeps working.
 *
 * ASCII only.
 */

import { runHeartbeat } from './heartbeat.js';
import { runMemoryAwareness } from './memory-awareness.js';
import { runUserConfirmationDetector } from './user-confirmation-detector.js';
import { runBusSessionPopulator } from './bus-session-populator.js';
import { runLaneContext } from './lane-context.js';

export interface PromptJob {
  name: string;
  run: (raw: string) => Promise<unknown>;
}

export interface JobReport {
  name: string;
  status: 'ok' | 'error' | 'timeout';
  /** Time from the start of the job until its result was read. It includes time the
   *  other jobs spent blocking the loop. */
  ms: number;
  /** Time the job itself held the loop before its first await (its sync prefix). */
  syncMs: number;
  output: unknown;
}

/**
 * START order. Each job runs synchronously up to its first await, so the jobs with a
 * blocking prefix go BEFORE lane-context arms its pg connect timer. A loop blocked
 * past connectionTimeoutMillis fires the expired timer before the socket is polled,
 * which would be a false lane-context timeout.
 *
 * bus-session-populator is first on purpose: it bumps the turn that memory-awareness
 * reads. Run in parallel they raced; here the order is fixed. It changes only the
 * telemetry current_turn and the focus staleness.
 */
export const JOBS: PromptJob[] = [
  { name: 'bus-session-populator', run: runBusSessionPopulator },
  { name: 'user-confirmation-detector', run: runUserConfirmationDetector },
  { name: 'memory-awareness', run: runMemoryAwareness },
  { name: 'heartbeat', run: runHeartbeat },
  { name: 'lane-context', run: runLaneContext },
];

/** MERGE order: the template registration order. Completion order never matters. */
const MERGE_ORDER = ['heartbeat', 'memory-awareness', 'user-confirmation-detector', 'bus-session-populator', 'lane-context'];

const DEFAULT_DEADLINE_MS = 12000;
const MIN_DEADLINE_MS = 100;
const MAX_DEADLINE_MS = 13000;

function readDeadline(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_DEADLINE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.round(n)));
}

/**
 * Time allowed for the jobs, counted from process start in main(). 12 s plus the
 * write stays under the 15 s registration timeout. Env CCV3_PROMPT_SUBMIT_DEADLINE_MS
 * overrides it, clamped to 100..13000. runPromptSubmit() takes it as a budget from
 * its own start, so tests do not depend on how old the test process is.
 */
export const DEADLINE_MS = readDeadline(process.env.CCV3_PROMPT_SUBMIT_DEADLINE_MS);

const log = (line: string): void => {
  try { process.stderr.write(line.endsWith('\n') ? line : `${line}\n`); } catch { /* stderr gone */ }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const rank = (name: string): number => {
  const i = MERGE_ORDER.indexOf(name);
  return i === -1 ? MERGE_ORDER.length : i;
};

/**
 * Merge the job outputs into the one object the harness reads.
 *
 *   result            dropped (legacy: the harness does not read it)
 *   continue:true     dropped (the default)
 *   continue:false    kept, with the first stopReason in fixed order
 *   decision:'block'  the first block wins, with its reason
 *   additionalContext non-empty values joined with a blank line, under one
 *                     hookSpecificOutput for UserPromptSubmit
 *   systemMessage     non-empty values joined with a newline
 *   any other key     the first job in fixed order wins; a conflict is logged
 * Nothing left gives {}.
 */
export function mergeOutputs(results: Array<{ name: string; output: unknown }>): Record<string, unknown> {
  const ordered = results.map((r, i) => ({ ...r, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i);
  const merged: Record<string, unknown> = {};
  const contexts: string[] = [];
  const messages: string[] = [];

  for (const { name, output } of ordered) {
    if (!isObject(output)) continue;
    const blocks = output.decision === 'block';
    if (output.continue === false && !('continue' in merged)) {
      merged.continue = false;
      if (output.stopReason !== undefined) merged.stopReason = output.stopReason;
    }
    if (blocks && !('decision' in merged)) {
      merged.decision = 'block';
      if (output.reason !== undefined) merged.reason = output.reason;
    }
    for (const [key, value] of Object.entries(output)) {
      if (key === 'result' || key === 'continue' || key === 'stopReason') continue;
      if (blocks && (key === 'decision' || key === 'reason')) continue;
      if (key === 'hookSpecificOutput') {
        const ctx = isObject(value) ? value.additionalContext : undefined;
        if (typeof ctx === 'string' && ctx.trim()) contexts.push(ctx);
      } else if (key === 'systemMessage') {
        if (typeof value === 'string' && value) messages.push(value);
      } else if (!(key in merged)) {
        merged[key] = value;
      } else if (JSON.stringify(merged[key]) !== JSON.stringify(value)) {
        log(`[prompt-submit] ${name} output key "${key}" conflicts with an earlier job; kept the earlier value`);
      }
    }
  }

  if (contexts.length) {
    merged.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: contexts.join('\n\n') };
  }
  if (messages.length) merged.systemMessage = messages.join('\n');
  return merged;
}

/** True unless the payload names an event other than UserPromptSubmit. */
function isPromptEvent(raw: string): boolean {
  try {
    const event = (JSON.parse(raw) as { hook_event_name?: unknown } | null)?.hook_event_name;
    return typeof event !== 'string' || event === '' || event === 'UserPromptSubmit';
  } catch {
    return true;
  }
}

let safetyNetsInstalled = false;

/** Cuts the deadline of the run in progress; null when no run is active. */
let cutDeadline: (() => void) | null = null;

const DEFAULT_GRACE_MS = 1000;
const MAX_GRACE_MS = 5000;

/** Time other jobs get to finish after an uncaught exception. Env CCV3_PROMPT_SUBMIT_GRACE_MS, 0..5000. */
function readGrace(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_GRACE_MS;
  return Math.min(MAX_GRACE_MS, Math.max(0, Math.round(n)));
}

/**
 * An abandoned job that rejects or throws late must not change the exit code.
 * Skipped under vitest: a handler there would hide real failures of the test worker.
 *
 * An uncaught exception is usually an emitter error (a pg socket, an embedding client)
 * that a job did not handle, so that job's promise never settles. Waiting for the
 * deadline would stall every prompt for 12 s, where the standalone hook crashed at once.
 * So the first one starts a short grace timer, then cuts the deadline: the jobs that
 * finished ship, and the stuck one is a timeout.
 */
function installSafetyNets(): void {
  if (safetyNetsInstalled || process.env.VITEST) return;
  safetyNetsInstalled = true;
  process.on('unhandledRejection', (err) => log(`[prompt-submit] late rejection ignored: ${String(err)}`));
  process.on('uncaughtException', (err) => {
    log(`[prompt-submit] uncaught exception, cutting the deadline: ${String((err as Error)?.stack ?? err)}`);
    const cut = cutDeadline;
    if (!cut) return;
    const grace = setTimeout(cut, readGrace(process.env.CCV3_PROMPT_SUBMIT_GRACE_MS));
    grace.unref(); // the deadline timer keeps the loop alive until the cut
  });
}

/** The real stdout.write, kept once the guard is installed. emitAndExit writes through it. */
let realStdoutWrite: typeof process.stdout.write | null = null;

/**
 * A write to stdout while the process runs would corrupt the one-JSON contract.
 * Send it to stderr, tagged. console.log goes through process.stdout.write, so it is
 * covered. In the hook process the guard stays installed until exit: a timed-out job
 * is still running when the result is written, so only emitAndExit may use the real
 * write. Under vitest the guard is released after each run.
 */
function guardStdout(): () => void {
  if (!realStdoutWrite) {
    realStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8');
      log(`[prompt-submit stray] ${text}`);
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
  }
  const original = realStdoutWrite;
  return () => {
    if (!process.env.VITEST) return;
    process.stdout.write = original;
    realStdoutWrite = null;
  };
}

const TIMED_OUT = Symbol('timed-out');

async function runJob(job: PromptJob, raw: string, deadline: Promise<typeof TIMED_OUT>): Promise<JobReport> {
  const start = Date.now();
  let running: Promise<unknown>;
  try {
    running = Promise.resolve(job.run(raw)); // starts the job now, in call order
  } catch (err) {
    running = Promise.reject(err);
  }
  const syncMs = Date.now() - start;
  const outcome = await Promise.race([
    running.then(
      (output) => ({ status: 'ok' as const, output }),
      (err: unknown) => { log(`[prompt-submit] ${job.name} threw: ${String((err as Error)?.stack ?? err)}`); return { status: 'error' as const, output: null }; },
    ),
    deadline.then(() => ({ status: 'timeout' as const, output: null })),
  ]);
  return { name: job.name, ...outcome, ms: Date.now() - start, syncMs };
}

/**
 * Run the jobs and merge their outputs. `deadlineMs` is a budget from now.
 * Does not write to stdout and does not exit: see emitAndExit().
 */
export async function runPromptSubmit(
  raw: string,
  jobs: PromptJob[] = JOBS,
  deadlineMs: number = DEADLINE_MS,
): Promise<{ output: Record<string, unknown>; report: JobReport[] }> {
  installSafetyNets();
  if (!isPromptEvent(raw)) return { output: {}, report: [] };

  const restoreStdout = guardStdout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cut: () => void = () => {};
  try {
    const deadline = new Promise<typeof TIMED_OUT>((done) => {
      cut = () => done(TIMED_OUT);
      timer = setTimeout(cut, deadlineMs);
    });
    cutDeadline = cut;
    const report = await Promise.all(jobs.map((job) => runJob(job, raw, deadline)));
    for (const r of report) log(`[prompt-submit] ${r.name} ${r.status} ${r.ms}ms (sync ${r.syncMs}ms)`);
    return { output: mergeOutputs(report.map((r) => ({ name: r.name, output: r.output }))), report };
  } finally {
    if (timer) clearTimeout(timer);
    if (cutDeadline === cut) cutDeadline = null;
    restoreStdout();
  }
}

/**
 * Write the one JSON object, then exit 0. The forced exit is mandatory: an abandoned
 * lane-context client keeps a socket open, the embedding-client timers are not unref'd,
 * and a hung job holds its handles. Detached children (the embedding daemon, the
 * learning store) are unref'd and survive. The second timer covers a closed stdout pipe.
 */
export function emitAndExit(output: object): void {
  setTimeout(() => process.exit(0), 2000);
  // The captured real write: the guard (if installed) must not divert the one payload.
  const write = (realStdoutWrite ?? process.stdout.write) as (chunk: string, cb: () => void) => boolean;
  write.call(process.stdout, JSON.stringify(output), () => process.exit(0));
}

async function readStdin(): Promise<string> {
  // No safety timer here: hook-contract-guard.mjs rule B forbids one that is not unref'd.
  const chunks: Buffer[] = [];
  try {
    for await (const c of process.stdin) chunks.push(c as Buffer);
  } catch {
    // Unreadable stdin: the jobs get what arrived.
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  // process.uptime() includes node bootstrap, so the deadline is measured from process start.
  const budget = Math.max(MIN_DEADLINE_MS, DEADLINE_MS - Math.round(process.uptime() * 1000));
  log(`[prompt-submit] budget ${budget}ms (uptime ${Math.round(process.uptime() * 1000)}ms)`);
  const { output } = await runPromptSubmit(raw, JOBS, budget);
  emitAndExit(output);
}

// Basename check, not `includes`: a directory named like a hook must not start it.
if (/(^|[\\/])prompt-submit\.(mjs|js|ts)$/.test(process.argv[1] || '')) {
  main().catch((err) => {
    log(`[prompt-submit] fatal: ${String(err)}`);
    emitAndExit({});
  });
}
