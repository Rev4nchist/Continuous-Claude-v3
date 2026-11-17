/**
 * Card coord-hooks-followups, item 4 step 1: the payload log of subagent calls (design note
 * .claudedocs/coordination/2026-11-16-coord-payload-log-design.md, seat ruling section 8).
 * LOG ONLY: the log records which fields a marked call carries; it changes no verdict and prints nothing.
 *
 * Ways it can fail (one test each; the first words of a test name the change that turns it red):
 *  1. No flag file, and a log is still written.
 *  2. A call without the marker is logged.
 *  3. A call with the marker is not logged, or the line is not valid JSON, or a field is missing.
 *  4. A secret, a path or a command text of the payload reaches the log.
 *  5. A bad marker (empty, short, upper case, spaces, 41 characters) logs.
 *  6. A hostile agent_type string reaches the log, or breaks the line.
 *  7. A payload key with a bad name reaches the log.
 *  8. The cap (about 200 lines) is not held.
 *  9. An unwritable log (a folder in its place) throws.
 * 10. An empty agent_id counts as present.
 * 11. The session field is wrong for same, different and missing ids.
 * 12. The log changes the hook's output (deny stays a deny, same text as with no flag).
 * 13. Removing the flag does not stop the log (reverse state).
 * 14. The marker itself is written to the log (also as a key name).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logPayloadIfMarked, PAYLOAD_LOG_CAP } from '../shared/payload-log.js';

const seen = vi.hoisted(() => ({ payload: '' }));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async () => ({ outcome: 'granted' }),
  listBlockingClaims: async () => ({ claims: [], degraded: false }),
}));
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => true }));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

const MARK = 'probe-marker-7f3a';
let root: string;
let home: string;
let flag: string;
let log: string;
const saved: Record<string, string | undefined> = {};

const lines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const setFlag = (text: string): void => writeFileSync(flag, text);
const marked = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tool_name: 'Write',
  session_id: 'sess-p-1',
  tool_input: { file_path: `/x/scratch/${MARK}.txt`, content: 'c' },
  ...extra,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'payload-log-')));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude', 'state'), { recursive: true });
  flag = join(home, '.claude', 'state', 'payload-log.flag');
  log = join(home, '.claude', 'state', 'payload-log.jsonl');
  for (const k of ['CCV3_USER_HOME', 'CLAUDE_CODE_SESSION_ID']) saved[k] = process.env[k];
  process.env.CCV3_USER_HOME = home;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('payload log: which marked calls it records', () => {
  it('1: no flag file means no log (breaks if the flag check is dropped)', () => {
    logPayloadIfMarked(marked());
    expect(existsSync(log)).toBe(false);
  });

  it('2: a call without the marker is not logged (breaks if every call is logged)', () => {
    setFlag(MARK);
    logPayloadIfMarked({ ...marked(), tool_input: { file_path: '/x/other.txt' } });
    expect(lines()).toEqual([]);
  });

  it('3: a marked call writes one valid line with every field of the design (breaks if a field is dropped)', () => {
    setFlag(`${MARK}\n`);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-p-1';
    logPayloadIfMarked(marked({ agent_id: 'a1', agent_type: 'critic', permission_mode: 'default', transcript_path: '/t.jsonl' }));
    const rows = lines();
    expect(rows.length).toBe(1);
    const row = JSON.parse(rows[0]) as Record<string, unknown>;
    expect(row.n).toBe(1);
    expect(typeof row.ts).toBe('string');
    expect(row.tool).toBe('Write');
    expect(row.agent_id).toBe('present');
    expect(row.agent_type).toBe('critic');
    expect(row.permission_mode).toBe('default');
    expect(row.session).toBe('same');
    expect(row.transcript).toBe('present');
    expect(row.keys).toEqual(['agent_id', 'agent_type', 'permission_mode', 'session_id', 'tool_input', 'tool_name', 'transcript_path']);
  });

  it('4: no secret, path or command text reaches the log (breaks if a value is copied)', () => {
    setFlag(MARK);
    logPayloadIfMarked({
      tool_name: 'Bash',
      session_id: 'sess-secret-id-1',
      agent_id: 'agent-secret-id-9',
      cwd: '/very/private/folder',
      tool_input: { command: `echo ${MARK} token=sk-live-SECRETVALUE123 > /very/private/folder/x` },
    });
    const text = readFileSync(log, 'utf8');
    for (const bad of ['SECRETVALUE', 'sk-live', '/very/private', 'sess-secret-id-1', 'agent-secret-id-9', 'echo']) expect(text).not.toContain(bad);
    expect(lines().length).toBe(1);
  });

  it('5: a bad marker logs nothing (empty, short, upper case, spaces, 41 characters)', () => {
    for (const bad of ['', 'short', 'UPPER-CASE-MARKER', 'has space marker1', 'a'.repeat(41), '../../etc-marker']) {
      setFlag(bad);
      logPayloadIfMarked({ tool_name: 'Write', tool_input: { file_path: `/x/${bad}.txt` } });
    }
    expect(lines()).toEqual([]);
  });

  it('6: a hostile agent_type becomes other and the line stays valid (breaks if the value is copied)', () => {
    setFlag(MARK);
    logPayloadIfMarked(marked({ agent_id: 'a1', agent_type: 'x"\n,"evil":1' }));
    const rows = lines();
    expect(rows.length).toBe(1);
    expect((JSON.parse(rows[0]) as { agent_type: string }).agent_type).toBe('other');
    logPayloadIfMarked(marked({ agent_id: 'a1' }));
    expect((JSON.parse(lines()[1]) as { agent_type: string }).agent_type).toBe('absent');
    logPayloadIfMarked(marked({ agent_id: 'a1', agent_type: 'general-purpose' }));
    expect((JSON.parse(lines()[2]) as { agent_type: string }).agent_type).toBe('general-purpose');
  });

  it('7: a key with a bad name is dropped from keys (breaks if keys are not filtered)', () => {
    setFlag(MARK);
    logPayloadIfMarked(marked({ 'Bad Key': 1, UPPER: 2, ['k'.repeat(80)]: 3, fine_key: 4 }));
    const row = JSON.parse(lines()[0]) as { keys: string[] };
    expect(row.keys).toContain('fine_key');
    expect(row.keys).not.toContain('Bad Key');
    expect(row.keys).not.toContain('UPPER');
    expect(row.keys.some((k) => k.length > 40)).toBe(false);
  });

  it('8: the cap holds about 200 lines (breaks if the cap check is dropped)', () => {
    setFlag(MARK);
    writeFileSync(log, '{"n":1}\n'.repeat(PAYLOAD_LOG_CAP));
    logPayloadIfMarked(marked());
    expect(lines().length).toBe(PAYLOAD_LOG_CAP);
    writeFileSync(log, '{"n":1}\n'.repeat(PAYLOAD_LOG_CAP - 1));
    logPayloadIfMarked(marked());
    expect(lines().length).toBe(PAYLOAD_LOG_CAP);
  });

  it('9: a folder in the place of the log does not throw (breaks if the write is not guarded)', () => {
    setFlag(MARK);
    mkdirSync(log);
    expect(() => logPayloadIfMarked(marked())).not.toThrow();
  });

  it('10: an empty agent_id is absent, a real one is present (breaks if the empty string counts)', () => {
    setFlag(MARK);
    logPayloadIfMarked(marked({ agent_id: '' }));
    logPayloadIfMarked(marked({ agent_id: 'a1' }));
    logPayloadIfMarked(marked());
    const ids = lines().map((l) => (JSON.parse(l) as { agent_id: string }).agent_id);
    expect(ids).toEqual(['absent', 'present', 'absent']);
  });

  it('11: session is same, diff or absent (breaks if the comparison is wrong)', () => {
    setFlag(MARK);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-p-1';
    logPayloadIfMarked(marked());
    logPayloadIfMarked(marked({ session_id: 'another' }));
    delete process.env.CLAUDE_CODE_SESSION_ID;
    logPayloadIfMarked(marked());
    const s = lines().map((l) => (JSON.parse(l) as { session: string }).session);
    expect(s).toEqual(['same', 'diff', 'absent']);
  });

  it('13: removing the flag stops the log on the next call (reverse state)', () => {
    setFlag(MARK);
    logPayloadIfMarked(marked());
    rmSync(flag);
    logPayloadIfMarked(marked());
    expect(lines().length).toBe(1);
  });

  it('14: the marker is never written, also as a key name or a tool name (breaks if the marker is echoed)', () => {
    const plain = 'probemarker7f3a'; // no hyphen: the only marker form that also passes the key filter
    setFlag(plain);
    logPayloadIfMarked({ tool_name: 'Write', tool_input: { file_path: `/x/${plain}.txt` }, [plain]: 1 });
    expect(readFileSync(log, 'utf8')).not.toContain(plain);
    expect(lines().length).toBe(1);
    // A tool name equal to the marker passes the tool filter: the last guard drops the whole line.
    logPayloadIfMarked({ tool_name: plain, tool_input: { file_path: `/x/${plain}.txt` } });
    expect(readFileSync(log, 'utf8')).not.toContain(plain);
    expect(lines().length).toBe(1);
  });
});

describe('payload log in the real file-claims hook', () => {
  let repo: string;
  type Out = { result?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

  async function runHook(payload: Record<string, unknown>): Promise<string> {
    seen.payload = JSON.stringify(payload);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    await import('../file-claims.js');
    await vi.waitFor(() => expect(out).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(out.mock.calls.length).toBe(1);
    const text = out.mock.calls[0][0] as string;
    out.mockRestore();
    return text;
  }

  beforeEach(() => {
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    for (const k of ['HOME', 'USERPROFILE', 'CCV3_FILE_CLAIMS_STATE_DIR']) saved[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(root, 'warned');
  });

  it('12: the log runs before the judge and changes no output (breaks if the log changes a verdict or prints)', async () => {
    const stateFile = join(home, '.claude', 'state', `${MARK}.json`);
    const payload = { tool_name: 'Write', session_id: 'sess-p-2', cwd: repo, agent_id: 'a1', agent_type: 'critic', tool_input: { file_path: stateFile } };
    const without = await runHook(payload);
    expect((JSON.parse(without) as Out).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(lines()).toEqual([]);
    setFlag(MARK);
    const withFlag = await runHook(payload);
    expect(withFlag).toBe(without);
    expect(lines().length).toBe(1);
    expect((JSON.parse(lines()[0]) as { agent_type: string }).agent_type).toBe('critic');
  });
});
