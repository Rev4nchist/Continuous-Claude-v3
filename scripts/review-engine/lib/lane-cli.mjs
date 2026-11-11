// The only way program.mjs writes to the lane board: a child lane.mjs run. spawnSync with an argv array, never a shell string.
// Live mode runs the shim in ~/.claude/scripts/lane.mjs (it loads the primary checkout's copy).
// The worktree's own scripts/coordination/lane.mjs is never run from here (every-surface checklist, "Worktree copies").
// Test mode (amendment A2): the child gets an explicit env. All three database URL variables are the scratch URL that
// dbTarget already checked, so the child cannot reach the live database by inheritance. A missing URL is a refusal.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { refused } from './errors.mjs';
import { scrubUrls } from './db.mjs';

const DB_VARS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'];
const TIMEOUT_MS = 30000;

// The shim by default. --lane-cli <path> only in test mode: outside test mode it is refused (exit 3), as source.mjs does.
export function laneCliPath(flags, home = homedir()) {
  if (flags['lane-cli'] !== undefined) {
    if (!flags['test-mode']) throw refused('refused: --lane-cli needs --test-mode.');
    return resolve(flags['lane-cli']);
  }
  return join(home, '.claude/scripts/lane.mjs');
}

// Pure. The child env: a copy of base plus the session id. Test mode also pins the three URL variables to the checked url.
export function laneEnv({ testMode, url, sessionId, base = process.env }) {
  const env = { ...base };
  if (sessionId !== undefined) env.CLAUDE_CODE_SESSION_ID = sessionId;
  if (!testMode) return env;
  if (typeof url !== 'string' || url === '') throw refused('refused: test mode runs the lane CLI only with a checked scratch database url.');
  for (const name of DB_VARS) env[name] = url;
  return env;
}

// What went wrong, for the FAIL line of the verb. null on success. A database URL in the text is masked.
function failureText(res, timeout) {
  if (res.error?.code === 'ETIMEDOUT') return `lane.mjs timed out after ${timeout} ms`;
  if (res.error) return `lane.mjs could not start: ${scrubUrls(res.error.message)}`;
  if (res.status === 0) return null;
  const first = String(res.stderr ?? '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return `lane.mjs exit ${res.status}: ${scrubUrls(first)}`.trimEnd();
}

// Runs the CLI. Returns { status, stdout, stderr, failure }. status is null on a timeout or a spawn error. Never throws on a child failure.
export function runLane(args, { cli, testMode, url, sessionId, base, timeout = TIMEOUT_MS }) {
  const env = laneEnv({ testMode, url, sessionId, base });
  const res = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout, windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? '', stderr: scrubUrls(res.stderr ?? ''), failure: failureText(res, timeout) };
}
