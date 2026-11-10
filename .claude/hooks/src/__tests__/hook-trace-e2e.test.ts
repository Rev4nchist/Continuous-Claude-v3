/**
 * End to end: a REAL built hook (dist/*.mjs) gets a real payload and writes one trace row.
 * Run after `npm run build`. The spawn env deletes the VITEST key, sets CCV3_HOOK_TRACE_DIR and a temp HOME.
 *
 * How it can fail, one test each:
 *   a built hot hook writes no row, or the row has the wrong session id, event or tool
 *   a fake token in the command reaches the trace file
 *   the guard's deny is not recorded as deny
 *   a spawned built hook is called live (it would feed the doctor's count check)
 *   the tracer changes stdout or the exit status of a real dist (same dist run traced and with CCV3_HOOK_TRACE=0)
 *   an __esm-layout bundle (periodic-extract: modules wrapped in init_*()) writes no row or the wrong session id
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const FAKE_TOKEN = 'gh' + 'p_' + 'FAKEtokenFAKEtokenFAKEtoken0123456789'; // joined at runtime: secret scanners flag literals
let dir: string;
let traceDir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trace-e2e-')); traceDir = join(dir, 'trace'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runDist(hook: string, payload: object, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: dir, USERPROFILE: dir, CCV3_HOOK_TRACE_DIR: traceDir,
    CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard-decisions.jsonl'), MSYS_EVENT_LOG: join(dir, 'msys-events.jsonl'),
  };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.CCV3_HOOK_TRACE;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [resolve(__dirname, `../../dist/${hook}.mjs`)], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000, env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const rows = (): Array<Record<string, any>> => (existsSync(traceDir) ? readdirSync(traceDir) : [])
  .filter((f) => /^hook-trace-.*\.jsonl$/.test(f))
  .flatMap((f) => readFileSync(join(traceDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const traceText = () => (existsSync(traceDir) ? readdirSync(traceDir) : []).map((f) => readFileSync(join(traceDir, f), 'utf8')).join('');

describe('built hot hooks write one row', () => {
  it('msys-crash-capture (PostToolUse Bash) writes one row with the payload session id, and no token', () => {
    const r = runDist('msys-crash-capture', {
      session_id: 'e2e-session-001', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: `echo ${FAKE_TOKEN}` }, tool_response: { stdout: FAKE_TOKEN, exit_code: 0 },
    });
    expect(r.status).toBe(0);
    const got = rows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'msys-crash-capture', event: 'PostToolUse', tool: 'Bash', sessionId: 'e2e-session-001', code: 0, exitCode: 0, source: 'probe' });
    expect(got[0].startupMs).toBeGreaterThan(0);
    expect(traceText()).not.toContain(FAKE_TOKEN);
    expect(traceText()).not.toContain('echo');
  });

  it('destructive-command-guard records out deny for a deny, with no command text in the row', () => {
    const r = runDist('destructive-command-guard', {
      session_id: 'e2e-session-002', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: `git reset --hard HEAD~5 # ${FAKE_TOKEN}` }, cwd: dir,
    });
    expect(r.status).toBe(0);
    // The guard asks in an interactive run and denies in an unattended one: the row must say which it was.
    const decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
    expect(['deny', 'ask']).toContain(decision);
    const got = rows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'destructive-command-guard', event: 'PreToolUse', tool: 'Bash', sessionId: 'e2e-session-002', out: decision, source: 'probe' });
    expect(traceText()).not.toContain(FAKE_TOKEN);
    expect(traceText()).not.toContain('reset');
  });

  it('destructive-command-guard gives the same stdout and status traced and with CCV3_HOOK_TRACE=0, and the off run writes no row', () => {
    const payload = {
      session_id: 'e2e-session-005', hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD~5' }, cwd: dir,
    };
    const traced = runDist('destructive-command-guard', payload);
    expect(rows()).toHaveLength(1);
    rmSync(traceDir, { recursive: true, force: true });
    const off = runDist('destructive-command-guard', payload, { CCV3_HOOK_TRACE: '0' });
    expect(rows()).toHaveLength(0);
    expect(traced.stdout).not.toBe('');
    expect(traced.stdout).toBe(off.stdout);
    expect(traced.status).toBe(off.status);
  });

  it('periodic-extract (__esm layout, invalid DB url, temp HOME and TEMP) writes one row with the payload session id and the same stdout traced and off', () => {
    const payload = { session_id: 'e2e-session-004', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `echo ${FAKE_TOKEN}` } };
    const bad = 'postgresql://nobody:x@127.0.0.1:1/none';
    const env = { TEMP: dir, TMP: dir, TMPDIR: dir, CONTINUOUS_CLAUDE_DB_URL: bad, DATABASE_URL: bad, OPC_POSTGRES_URL: bad };
    const traced = runDist('periodic-extract', payload, env);
    const got = rows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'periodic-extract', event: 'PostToolUse', tool: 'Bash', sessionId: 'e2e-session-004', source: 'probe' });
    expect(traceText()).not.toContain(FAKE_TOKEN);
    rmSync(traceDir, { recursive: true, force: true });
    const off = runDist('periodic-extract', payload, { ...env, CCV3_HOOK_TRACE: '0' });
    expect(rows()).toHaveLength(0);
    expect(traced.stdout).toBe(off.stdout);
    expect(traced.status).toBe(off.status);
  });

  it('a hook that is not in the hot set writes nothing while the mode file is missing', () => {
    const r = runDist('epistemic-reminder', { session_id: 'e2e-session-003', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: dir });
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(rows().filter((x) => x.name === 'epistemic-reminder')).toHaveLength(0);
  });

});
