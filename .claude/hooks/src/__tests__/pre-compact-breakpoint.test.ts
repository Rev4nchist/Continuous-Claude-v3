/**
 * Card compact-session-breakpoint: the PreCompact hook that writes the state file.
 * Input fields come from the Claude Code hooks docs (PreCompact: trigger, custom_instructions, session_id, transcript_path, cwd).
 *
 * Ways this can fail (one test each):
 *  1. A manual compact writes no state file (today's behaviour: the red test of the card).
 *  2. An auto compact writes none.
 *  3. A read error (no transcript, no lane shim, a lane shim that throws) blocks the compact or loses the rest.
 *  4. A write error (the folder is a file) throws.
 *  5. A compact with nothing to save replaces a good file.
 *  6. A session id that could leave the folder writes outside it.
 *  7. The hook removes a file that is not its own old file.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPreCompactBreakpoint, type BreakpointDeps } from '../pre-compact-breakpoint.js';

const SID = '4c4b5eb5-0b86-4552-af79-7c1a0a9f59ac';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bp-hook-'));

const askLine = (id: string, q: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T12:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ header: 'Land', question: q, multiSelect: false, options: [{ label: 'a', description: '' }] }] } }] } });
const ansLine = (id: string, q: string, a: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-14T12:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "${q}"="${a}".` }] }, toolUseResult: { questions: [], answers: { [q]: a }, annotations: {} } });
const typedLine = (t: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-14T12:03:00.000Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: t } });

const board = { lanes: [{ id: 'compact-session-breakpoint', title: 'Compact', owner_session_id: SID, state: 'active', note: 'GOAL: compact in place | NEXT: red tests | MS: C:/r/m.md' }] };

function setup(over: Partial<BreakpointDeps> = {}) {
  const home = tmp();
  const transcript = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(transcript, [askLine('t1', 'Land PR 571?'), ansLine('t1', 'Land PR 571?', 'Land now'), typedLine('yes build it')].join('\n'));
  const calls: string[][] = [];
  const deps: BreakpointDeps = {
    home,
    now: () => new Date(),
    runner: async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify(board), stderr: '' }; },
    branchOf: () => 'feat/x',
    ...over,
  };
  const file = path.join(home, '.claude', 'state', 'breakpoint', `${SID}.md`);
  return { home, transcript, deps, calls, file };
}

describe('runPreCompactBreakpoint: the state file', () => {
  it.each(['manual', 'auto'] as const)('writes the state file on a %s compact', async (trigger) => {
    const { transcript, deps, file } = setup();
    const out = await runPreCompactBreakpoint({ session_id: SID, trigger, transcript_path: transcript, cwd: 'C:/r' }, deps);
    expect(out.continue).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('compact-session-breakpoint');
    expect(text).toContain('Land PR 571? -> Land now');
    expect(text).toContain('yes build it');
    expect(text).toContain('NEXT: red tests');
  });

  it('asks the lane shim as this session (CLAUDE_CODE_SESSION_ID of the input)', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const { transcript, deps } = setup({ runner: async (_a, o) => { seenEnv = o.env; return { code: 0, stdout: JSON.stringify(board), stderr: '' }; } });
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    expect(seenEnv?.CLAUDE_CODE_SESSION_ID).toBe(SID);
  });
});

describe('runPreCompactBreakpoint: fails open on every read error', () => {
  it('writes the lane facts when the transcript is missing', async () => {
    const { deps, file } = setup();
    const out = await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: 'C:/no/such.jsonl' }, deps);
    expect(out.continue).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('compact-session-breakpoint');
  });
  it('writes the decisions when the lane shim fails', async () => {
    const { transcript, deps, file } = setup({ runner: async () => ({ code: 2, stdout: '', stderr: 'boom' }) });
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    expect(fs.readFileSync(file, 'utf8')).toContain('Land PR 571? -> Land now');
  });
  it('survives a lane shim that throws, and a board that is not JSON', async () => {
    for (const runner of [async () => { throw new Error('x'); }, async () => ({ code: 0, stdout: 'not json', stderr: '' })]) {
      const { transcript, deps } = setup({ runner });
      const out = await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
      expect(out.continue).toBe(true);
    }
  });
  it('returns continue and does not throw when the state folder cannot be written', async () => {
    const { transcript, deps, home } = setup();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'state'), 'a file where a folder should be');
    const out = await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    expect(out.continue).toBe(true);
    expect(out.systemMessage).toMatch(/skipped/i);
  });
  it('returns continue for empty input', async () => {
    const { deps } = setup();
    expect((await runPreCompactBreakpoint({}, deps)).continue).toBe(true);
  });
});

describe('runPreCompactBreakpoint: never replace with less', () => {
  it('keeps a good file when this compact has nothing to save', async () => {
    const { transcript, deps, file } = setup();
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    const good = fs.readFileSync(file, 'utf8');
    const empty = { ...deps, runner: async () => ({ code: 2, stdout: '', stderr: '' }), branchOf: () => null };
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: 'C:/no/such.jsonl' }, empty);
    expect(fs.readFileSync(file, 'utf8')).toBe(good);
  });
});

describe('runPreCompactBreakpoint: a decision older than the transcript window stays (seat item 4)', () => {
  it('carries the decisions of the previous state file into the next one', async () => {
    const { transcript, deps, file } = setup();
    // First compact: the transcript still holds the first decision.
    const first = path.join(tmp(), 'first.jsonl');
    fs.writeFileSync(first, [askLine('t0', 'Which card first?'), ansLine('t0', 'Which card first?', 'the compact card')].join('\n'));
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: first }, deps);
    expect(fs.readFileSync(file, 'utf8')).toContain('Which card first? -> the compact card');
    // Second compact: the tail read no longer reaches that decision (transcript holds only the new one).
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('Which card first? -> the compact card');
    expect(text).toContain('Land PR 571? -> Land now');
    expect(text.split('Which card first?').length - 1).toBe(1);
  });
});

describe('runPreCompactBreakpoint: bad session id and old files', () => {
  it('writes nothing for a session id that could leave the folder', async () => {
    const { transcript, deps, home } = setup();
    const out = await runPreCompactBreakpoint({ session_id: '../../evil', trigger: 'manual', transcript_path: transcript }, deps);
    expect(out.continue).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'state', 'breakpoint'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'evil.md'))).toBe(false);
  });
  it('removes its own session files older than 30 days and nothing else', async () => {
    const { transcript, deps, home } = setup();
    const dir = path.join(home, '.claude', 'state', 'breakpoint');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, '11111111-2222-3333-4444-555555555555.md');
    const other = path.join(dir, 'keep.txt');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(other, 'x');
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(other, past, past);
    await runPreCompactBreakpoint({ session_id: SID, trigger: 'manual', transcript_path: transcript }, deps);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });
});
