/**
 * msys-crash-capture -- reconstructed source (2026-08-31, harness-security lane).
 * Unit-tests the exported classifiers plus an integration pass of the dist
 * bundle: ok:1 denominator rows, ok:0 crash rows, self-reference suppression,
 * and the 5 MiB rotation. Log writes are redirected via MSYS_EVENT_LOG.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  isMsysCrash,
  redactCommand,
  responseText,
  rotateIfNeeded,
} from '../msys-crash-capture';

const HOOK = resolve(__dirname, '../../dist/msys-crash-capture.mjs');
const SESSION_ID = 'msystest-0000-0000-0000-000000000000';
const CRASH_TEXT = '0 [main] bash fatal error - add_item ("\\??\\C:\\Git", "/") failed, errno 1';

let logDir: string;
let logPath: string;

function runHook(input: Record<string, unknown> | string): { stdout: string; status: number | null } {
  const res = spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, MSYS_EVENT_LOG: logPath },
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

function logRows(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('msys-crash-capture classifiers (unit)', () => {
  it('recognises the MSYS crash signatures', () => {
    expect(isMsysCrash(CRASH_TEXT, 'git commit')).toBe(true);
    expect(isMsysCrash('cygheap base mismatch detected', 'ls')).toBe(true);
    expect(isMsysCrash("couldn't allocate heap", 'ls')).toBe(true);
    expect(isMsysCrash('ordinary stderr noise', 'git commit')).toBe(false);
  });

  it('suppresses self-referential commands (grepping the log is not a crash)', () => {
    expect(isMsysCrash(CRASH_TEXT, 'grep add_item ~/.claude/logs/msys-events.jsonl')).toBe(false);
    expect(isMsysCrash(CRASH_TEXT, 'vim windows-platform.md')).toBe(false);
  });

  it('redacts secrets and truncates to 200 chars', () => {
    expect(redactCommand('curl -H api_key=abc123 x')).toContain('api_key=<redacted>');
    expect(redactCommand('x'.repeat(500)).length).toBe(200);
  });

  it('redacts HTTP Authorization Bearer and Basic credentials', () => {
    const bearer = redactCommand('curl -H "Authorization: Bearer eyJhbGciOi.secret" api.example.com');
    expect(bearer).toContain('Authorization: Bearer <redacted>');
    expect(bearer).not.toContain('eyJhbGciOi.secret');
    const basic = redactCommand('curl -H "authorization: basic dXNlcjpwYXNz" api.example.com');
    expect(basic).toContain('basic <redacted>');
    expect(basic).not.toContain('dXNlcjpwYXNz');
  });

  it('extracts text from string and object responses', () => {
    expect(responseText('plain')).toBe('plain');
    expect(responseText({ stdout: 'a', stderr: 'b' })).toBe('a\nb');
    expect(responseText(null)).toBe('');
  });

  it('rotates the log at the byte cap', () => {
    const d = mkdtempSync(join(tmpdir(), 'msys-rot-'));
    const p = join(d, 'log.jsonl');
    writeFileSync(p, 'x'.repeat(100));
    expect(rotateIfNeeded(p, 50)).toBe(true);
    expect(existsSync(p + '.1')).toBe(true);
    expect(rotateIfNeeded(join(d, 'absent.jsonl'), 50)).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('msys-crash-capture (dist integration)', () => {
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'msys-cap-'));
    logPath = join(logDir, 'msys-events.jsonl');
  });
  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it('writes an ok:1 denominator row for a successful Bash call', () => {
    const { stdout, status } = runHook({
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'hi', exit_code: 0 },
    });
    expect(status).toBe(0);
    expect(stdout).toBe('{}');
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'bash-tool', tool: 'Bash', ok: 1 });
  });

  it('writes a full ok:0 row for an MSYS crash', () => {
    runHook({
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -F msg.txt' },
      tool_response: { stderr: CRASH_TEXT, exit_code: 127 },
    });
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lane: 'bash-tool',
      ok: 0,
      signature: 'fatal error - add_item',
      exit_code: 127,
      session_id: SESSION_ID,
    });
    // Census is sampled after the fact -- a number or null, never absent.
    expect(rows[0]).toHaveProperty('msys_alive_after');
  });

  it('ignores non-command tools and writes no row', () => {
    const { stdout } = runHook({ session_id: SESSION_ID, tool_name: 'Edit', tool_input: {} });
    expect(stdout).toBe('{}');
    expect(logRows()).toHaveLength(0);
  });

  it('handles PowerShell as a command tool', () => {
    runHook({
      session_id: SESSION_ID,
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-Date' },
      tool_response: { stdout: 'ok', exit_code: 0 },
    });
    expect(logRows()[0]).toMatchObject({ tool: 'PowerShell', ok: 1 });
  });

  it('never crashes on malformed stdin', () => {
    const { stdout, status } = runHook('not json');
    expect(status).toBe(0);
    expect(stdout).toBe('{}');
    expect(logRows()).toHaveLength(0);
  });
});
