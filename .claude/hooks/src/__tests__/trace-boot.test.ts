/**
 * Unit tests for src/lib/trace-boot.ts (the esbuild --inject boot module).
 *
 * How the pure parts can fail, one test each:
 *   mode: a missing mode file is not hot; CCV3_HOOK_TRACE=0 does not beat a mode file; junk text is not hot
 *   hot set: the name list drifts from .claude/settings.json.template (a renamed or new hook goes unseen)
 *   source: a spawned dist test (CCV3_GUARD_DECISIONS_LOG or CCV3_HOOK_TRACE_DIR, no VITEST) is called live
 *   payload: session id lost from a cut buffer, or taken from text inside a command
 *   out: a deny reads as none, or text inside a string reads as a decision
 *   row: a key is missing, exitCode is not 0/1, the pid is used as a session id
 *   writer: no day file name, no cap, no prune, a throw on a bad dir, a counter line per drop
 *   error: command text, a path or a url leaves the process inside the error field (a class is stored, never message text)
 *   source: a run of the REPO dist (the hook e2e step of docs/testing-standard.md) is called live and feeds the doctor
 * The spawn tests (trace-boot-spawn.test.ts) cover the injected behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HOT_PROGRAMS, TRACE_MARKER, traceModeFrom, shouldTrace, traceSource, extractPayloadFields,
  classifyOut, buildRow, appendTraceRow, maskError, dayFileName,
} from '../lib/trace-boot.js';

const HOOKS_ROOT = join(__dirname, '..', '..');
const TEMPLATE = join(HOOKS_ROOT, '..', 'settings.json.template');

/** The programs the template registers on SessionStart, or on Pre/PostToolUse for Bash or PowerShell (no matcher means every tool). */
function hotFromTemplate(): Set<string> {
  const t = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; args?: string[] }> }>> };
  const hot = new Set<string>();
  for (const [event, groups] of Object.entries(t.hooks)) {
    for (const g of groups) {
      const m = g.matcher;
      const tools = event === 'PreToolUse' || event === 'PostToolUse';
      const matches = !m || m === '*' || ['Bash', 'PowerShell'].some((tool) => new RegExp(`^(?:${m})$`).test(tool));
      if (event !== 'SessionStart' && !(tools && matches)) continue;
      for (const h of g.hooks ?? []) {
        const name = [h.command, ...(h.args ?? [])].join(' ').match(/([A-Za-z0-9._-]+)\.mjs/)?.[1];
        if (name) hot.add(name);
      }
    }
  }
  return hot;
}

describe('trace mode', () => {
  it('a missing mode file means hot', () => expect(traceModeFrom({}, null)).toBe('hot'));
  it('reads off, hot and all, trimmed and case-folded', () => {
    expect(traceModeFrom({}, ' OFF\n')).toBe('off');
    expect(traceModeFrom({}, 'all')).toBe('all');
    expect(traceModeFrom({}, 'hot\r\n')).toBe('hot');
  });
  it('junk text in the mode file means hot, not off and not all', () => expect(traceModeFrom({}, 'banana')).toBe('hot'));
  it('CCV3_HOOK_TRACE=0 turns tracing off even when the file says all', () => {
    expect(traceModeFrom({ CCV3_HOOK_TRACE: '0' }, 'all')).toBe('off');
  });
});

describe('hot set', () => {
  it('HOT_PROGRAMS equals the programs the template registers on SessionStart and Bash/PowerShell tool events', () => {
    const want = hotFromTemplate();
    expect(want.size).toBeGreaterThan(20); // a floor from the template itself: an empty parse must not pass
    expect([...HOT_PROGRAMS].sort()).toEqual([...want].sort());
  });
  it('hot mode keeps a hot program and drops another; all keeps both; off keeps none', () => {
    expect(shouldTrace('destructive-command-guard', 'hot')).toBe(true);
    expect(shouldTrace('prompt-submit', 'hot')).toBe(false);
    expect(shouldTrace('prompt-submit', 'all')).toBe(true);
    expect(shouldTrace('destructive-command-guard', 'off')).toBe(false);
  });
});

describe('source tag', () => {
  // A live row needs the script to sit under <home>/.claude/hooks/dist: a run of the REPO dist must never feed the doctor.
  let home: string;
  let liveScript: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'trace-src-'));
    const d = join(home, '.claude', 'hooks', 'dist');
    mkdirSync(d, { recursive: true });
    liveScript = join(d, 'x.mjs');
    writeFileSync(liveScript, '');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is live with a clean env and a script under <home>/.claude/hooks/dist', () => expect(traceSource({}, liveScript, home)).toBe('live'));
  it('is probe for a script outside <home>/.claude/hooks/dist (the repo dist), even with a clean env', () => {
    const repoDist = join(home, 'repo', '.claude', 'hooks', 'dist');
    mkdirSync(repoDist, { recursive: true });
    writeFileSync(join(repoDist, 'x.mjs'), '');
    expect(traceSource({}, join(repoDist, 'x.mjs'), home)).toBe('probe');
  });
  it('is probe for a sibling dir whose name starts like the live dist dir', () => {
    const sib = join(home, '.claude', 'hooks', 'dist-old');
    mkdirSync(sib, { recursive: true });
    writeFileSync(join(sib, 'x.mjs'), '');
    expect(traceSource({}, join(sib, 'x.mjs'), home)).toBe('probe');
  });
  it('is probe when there is no script path', () => expect(traceSource({}, undefined, home)).toBe('probe'));
  it('is test when VITEST is set, even to an empty string', () => expect(traceSource({ VITEST: '' }, liveScript, home)).toBe('test'));
  it('is probe when CCV3_GUARD_DECISIONS_LOG is set and VITEST is not (the existing dist-spawn tests)', () => {
    expect(traceSource({ CCV3_GUARD_DECISIONS_LOG: 'x.jsonl' }, liveScript, home)).toBe('probe');
  });
  it('is probe when CCV3_HOOK_TRACE_DIR is set', () => expect(traceSource({ CCV3_HOOK_TRACE_DIR: 'd' }, liveScript, home)).toBe('probe'));
  it('is test when VITEST is set with a trace dir', () => expect(traceSource({ VITEST: '1', CCV3_HOOK_TRACE_DIR: 'd' }, liveScript, home)).toBe('test'));
  it('honours CCV3_GUARD_SOURCE like the guard log does', () => expect(traceSource({ CCV3_GUARD_SOURCE: 'probe' }, liveScript, home)).toBe('probe'));
});

describe('payload fields', () => {
  const payload = { session_id: 'abc-123', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
  it('reads the three fields from a whole JSON payload', () => {
    expect(extractPayloadFields(JSON.stringify(payload))).toEqual({ sessionId: 'abc-123', event: 'PostToolUse', tool: 'Bash' });
  });
  it('reads the session id from a payload cut at 64 KB (not valid JSON any more)', () => {
    const cut = JSON.stringify({ ...payload, tool_input: { command: 'x'.repeat(100000) } }).slice(0, 65536);
    expect(extractPayloadFields(cut).sessionId).toBe('abc-123');
  });
  it('does not take a session id from text inside the command', () => {
    const evil = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "session_id": "evil"' }, session_id: 'real-1' });
    expect(extractPayloadFields(evil).sessionId).toBe('real-1');
    const cutEvil = JSON.stringify({ tool_input: { command: 'echo "session_id": "evil"' } }).slice(0, 60);
    expect(extractPayloadFields(cutEvil).sessionId).toBeNull();
  });
  it('rejects a session id with odd characters, and returns nulls for text that is not a payload', () => {
    expect(extractPayloadFields(JSON.stringify({ session_id: 'a b"c' })).sessionId).toBeNull();
    expect(extractPayloadFields('not json')).toEqual({ sessionId: null, event: null, tool: null });
    expect(extractPayloadFields('')).toEqual({ sessionId: null, event: null, tool: null });
  });
});

describe('stdout class', () => {
  const hso = (o: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } });
  it('maps permissionDecision deny, ask and allow', () => {
    expect(classifyOut(hso({ permissionDecision: 'deny' }))).toBe('deny');
    expect(classifyOut(hso({ permissionDecision: 'ask' }))).toBe('ask');
    expect(classifyOut(hso({ permissionDecision: 'allow' }))).toBe('allow');
  });
  it('maps decision block, additionalContext and systemMessage', () => {
    expect(classifyOut(JSON.stringify({ decision: 'block', reason: 'x' }))).toBe('block');
    expect(classifyOut(hso({ additionalContext: 'hello' }))).toBe('inject');
    expect(classifyOut(JSON.stringify({ systemMessage: 'hi' }))).toBe('message');
  });
  it('reads keys, not words: the word deny inside a context string is an inject', () => {
    expect(classifyOut(hso({ additionalContext: 'permissionDecision deny' }))).toBe('inject');
  });
  it('is none for empty output, plain text and a bare continue', () => {
    expect(classifyOut('')).toBe('none');
    expect(classifyOut('hello world')).toBe('none');
    expect(classifyOut(JSON.stringify({ result: 'continue' }))).toBe('none');
  });
  it('classifies output cut at 8 KB by key text', () => {
    const cut = (hso({ permissionDecision: 'deny', permissionDecisionReason: 'r'.repeat(20000) })).slice(0, 8192);
    expect(classifyOut(cut)).toBe('deny');
  });
});

describe('row', () => {
  const base = { ts: new Date('2026-11-09T10:00:00.000Z'), name: 'x', event: 'PreToolUse', tool: 'Bash', startupMs: 31.4, durationMs: 12.2, code: 0, sessionId: 's-1', out: 'allow' as const, error: null, source: 'live' as const };
  it('has exactly the twelve keys, ISO ts, and exitCode 0 for code 0', () => {
    const row = buildRow(base);
    expect(Object.keys(row).sort()).toEqual(['code', 'durationMs', 'error', 'event', 'exitCode', 'name', 'out', 'sessionId', 'source', 'startupMs', 'tool', 'ts']);
    expect(row.ts).toBe('2026-11-09T10:00:00.000Z');
    expect(row.exitCode).toBe(0);
  });
  it('keeps the real code and folds any non-zero code to exitCode 1', () => {
    const row = buildRow({ ...base, code: 3 });
    expect(row.code).toBe(3);
    expect(row.exitCode).toBe(1);
  });
  it('a missing session id is null, never the pid', () => {
    const row = buildRow({ ...base, sessionId: null });
    expect(row.sessionId).toBeNull();
    expect(JSON.stringify(row)).not.toContain(String(process.pid));
  });
  it('rounds the two times to 0.1 ms', () => {
    const row = buildRow({ ...base, startupMs: 31.456789, durationMs: 12.2499 });
    expect(row.startupMs).toBe(31.5);
    expect(row.durationMs).toBe(12.2);
  });
});

describe('day files', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trace-boot-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const row = (ts: string) => buildRow({ ts: new Date(ts), name: 'x', event: null, tool: null, startupMs: 1, durationMs: 1, code: 0, sessionId: null, out: 'none', error: null, source: 'probe' });

  it('names the file by the UTC date of ts', () => {
    expect(dayFileName(new Date('2026-11-09T23:59:59.000Z'))).toBe('hook-trace-2026-11-09.jsonl');
    expect(dayFileName(new Date('2026-11-10T00:00:00.000Z'))).toBe('hook-trace-2026-11-10.jsonl');
  });
  it('creates the dir on the first write and appends one JSON line per row', () => {
    const sub = join(dir, 'a', 'b');
    expect(appendTraceRow(row('2026-11-09T10:00:00Z'), { dir: sub })).toBe('written');
    expect(appendTraceRow(row('2026-11-09T10:00:01Z'), { dir: sub })).toBe('written');
    const lines = readFileSync(join(sub, 'hook-trace-2026-11-09.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).ts).toBe('2026-11-09T10:00:01.000Z');
  });
  it('drops a row past the day cap and keeps ONE counter line, rewritten, not one line per drop', () => {
    const opts = { dir, capBytes: 400 };
    const results = Array.from({ length: 6 }, (_, i) => appendTraceRow(row(`2026-11-09T10:00:0${i}Z`), opts));
    const written = results.filter((r) => r === 'written').length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(6);
    const dropped = readFileSync(join(dir, 'hook-trace-2026-11-09.dropped'), 'utf8').trim().split('\n');
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(dropped[0]).dropped).toBe(6 - written);
    const size = readFileSync(join(dir, 'hook-trace-2026-11-09.jsonl')).length;
    expect(size).toBeLessThan(400 + 400); // never more than one row past the cap
  });
  it('prunes day files and .dropped files older than 10 days on the first write of a new day, and nothing else', () => {
    for (const d of ['2026-10-29', '2026-10-30', '2026-10-31']) writeFileSync(join(dir, `hook-trace-${d}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'hook-trace-2026-10-29.dropped'), '{"dropped":1}\n');
    writeFileSync(join(dir, 'hook-trace.jsonl'), '{}\n'); // the legacy file
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    appendTraceRow(row('2026-11-09T10:00:00Z'), { dir });
    const left = readdirSync(dir).sort();
    // 11-09 minus 10 days = 10-30: older than that goes; 10-30 and 10-31 stay
    expect(left).toEqual(['hook-trace-2026-10-30.jsonl', 'hook-trace-2026-10-31.jsonl', 'hook-trace-2026-11-09.jsonl', 'hook-trace.jsonl', 'unrelated.txt']);
  });
  it('returns error and does not throw when the dir cannot be made', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(appendTraceRow(row('2026-11-09T10:00:00Z'), { dir: join(file, 'sub') })).toBe('error');
    expect(existsSync(join(file, 'sub'))).toBe(false);
  });
});

describe('error text', () => {
  it('stores a class (name plus code), never message text', () => {
    const e = Object.assign(new Error('spawnSync x ENOENT'), { code: 'ENOENT' });
    expect(maskError(e)).toBe('Error/ENOENT');
    expect(maskError(new SyntaxError('Unexpected token } in JSON at position 4'))).toBe('SyntaxError');
    expect(maskError(Object.assign(new Error('x'), { code: 42 }))).toBe('Error');
  });
  it('leaves no path from an unquoted spawn error (probe case 1)', () => {
    const err = Object.assign(new Error('spawnSync C:/Users/dkhay/secret-project/run.ps1 ENOENT'), { code: 'ENOENT' });
    const text = maskError(err);
    for (const bad of ['secret-project', 'C:/', 'run.ps1', 'dkhay']) expect(text).not.toContain(bad);
  });
  it('leaves no url or command text from an unquoted message (probe case 2)', () => {
    const text = maskError(new Error('cannot handle command: git push https://internal.example.com/repo.git'));
    for (const bad of ['internal.example.com', 'https', 'git push', 'repo.git']) expect(text).not.toContain(bad);
  });
  it('drops the text of a "Command failed" command and any token', () => {
    // Fixtures are joined at runtime: secret scanners flag literals.
    const err = new Error(`Command failed: git commit -m '${'gh' + 'p_'}abcdefghijklmnopqrstuvwxyz0123456789' --token=${'sk_' + 'live_'}abcdef1234567890abcdef`);
    const text = maskError(err);
    expect(text.startsWith('Error')).toBe(true);
    for (const bad of ['ghp_', 'sk_live_', 'git commit -m']) expect(text).not.toContain(bad);
  });
  it('is at most 120 characters, also for a long name, and handles a thrown string and a thrown object', () => {
    expect(maskError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(120);
    const odd = Object.assign(new Error('m'), { name: 'N'.repeat(300), code: 'C'.repeat(300) });
    expect(maskError(odd).length).toBeLessThanOrEqual(120);
    expect(maskError('plain string /etc/passwd')).toBe('string');
    expect(maskError({ message: 'C:/secret' })).toBe('object');
  });
  it('drops a code that holds anything but word characters', () => {
    expect(maskError(Object.assign(new Error('m'), { code: 'C:/secret/x' }))).toBe('Error');
  });
  it('keeps the class "Error" for a non-string name', () => {
    expect(maskError(Object.assign(new Error('m'), { name: 12345 }))).toBe('Error');
    expect(maskError(Object.assign(new Error('m'), { name: { toString: () => 'Foo' } }))).toBe('Error');
  });
  it('returns "Error" and does not throw when a name or code getter throws', () => {
    const boom = new Error('m');
    Object.defineProperty(boom, 'name', { get() { throw new Error('boom'); } });
    expect(maskError(boom)).toBe('Error');
    const bad = new Error('m');
    Object.defineProperty(bad, 'code', { get() { throw new Error('boom'); } });
    expect(maskError(bad)).toBe('Error');
  });
});

describe('marker', () => {
  it('is the string the static check greps for', () => expect(TRACE_MARKER).toBe('__CCV3_HOOK_TRACE_V1__'));
});
