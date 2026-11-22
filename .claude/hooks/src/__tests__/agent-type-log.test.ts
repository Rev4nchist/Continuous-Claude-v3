/**
 * Card coord-hooks-followups, step 2b: the agent_type log (design note
 * .claudedocs/coordination/2026-11-22-coord-agent-type-log-design.md, seat GO 2026-11-22 with changes A to D).
 * LOG ONLY: the log records the first sighting of each raw agent_type outside the known list; it changes no verdict.
 *
 * Ways it can fail (one test each; the first words of a test name the change that turns it red):
 *  T1  An unknown type with an agent_id writes no line, or a wrong one.
 *  T2  The same value twice writes two lines.
 *  T3  A main-session call (no agent_id) with an unknown type writes a line.
 *  T4  A known type (critic, kraken, general-purpose) writes a line.
 *  T5  A subagent with no agent_type, or a non-string one, writes a line.
 *  T6  A hostile value (slash, space, quote, newline) reaches the file as text.
 *  T7  A 61-character value reaches the file as text.
 *  T8  An id, a path, a transcript path or a tool input text reaches the line.
 *  T9  The cap (50 lines) is not held, or a file above 8 KB is read or appended.
 *  T10 An unwritable log (a folder in its place) throws.
 *  T11 CCV3_AGENT_TYPE_LOG=0 does not stop the log (reverse state: unset logs again).
 *  T12 The real file-claims hook changes its output because of the log, or the line lands in the real home.
 *  T13 A main-session call, a known type or the env switch touches the file system at all (change A).
 *
 * Every test sets CCV3_USER_HOME to a temp folder (change D).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { AGENT_TYPE_LOG_CAP, AGENT_TYPE_LOG_MAX_BYTES, logUnknownAgentType } from '../shared/payload-log.js';

const seen = vi.hoisted(() => ({ payload: '', fsCalls: [] as string[] }));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async () => ({ outcome: 'granted' }),
  listBlockingClaims: async () => ({ claims: [], degraded: false }),
}));
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => true }));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  const spy =
    (name: string, fn: unknown) =>
    (p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string') seen.fsCalls.push(`${name} ${p}`);
      return (fn as (...a: unknown[]) => unknown)(p, ...rest);
    };
  return {
    ...real,
    existsSync: spy('existsSync', real.existsSync) as typeof real.existsSync,
    statSync: spy('statSync', real.statSync) as typeof real.statSync,
    mkdirSync: spy('mkdirSync', real.mkdirSync) as typeof real.mkdirSync,
    appendFileSync: spy('appendFileSync', real.appendFileSync) as typeof real.appendFileSync,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (p === 0) return seen.payload;
      if (typeof p === 'string') seen.fsCalls.push(`readFileSync ${p}`);
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
  };
});

// The real home, read before any test changes USERPROFILE (Windows) or HOME.
const REAL_LOG = join(homedir(), '.claude', 'state', 'agent-types-seen.jsonl');
const realLogBefore = existsSync(REAL_LOG) ? statSync(REAL_LOG).mtimeMs : null;

let root: string;
let home: string;
let log: string;
const saved: Record<string, string | undefined> = {};

const lines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const rows = (): Array<Record<string, unknown>> => lines().map((l) => JSON.parse(l) as Record<string, unknown>);
const sub = (type: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tool_name: 'Write',
  session_id: 'sess-a-1',
  agent_id: 'agent-secret-id-9',
  agent_type: type,
  tool_input: { file_path: '/very/private/folder/x.txt', content: 'c' },
  transcript_path: '/very/private/t.jsonl',
  ...extra,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-type-log-')));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude', 'state'), { recursive: true });
  log = join(home, '.claude', 'state', 'agent-types-seen.jsonl');
  for (const k of ['CCV3_USER_HOME', 'CCV3_AGENT_TYPE_LOG', 'CLAUDE_CODE_SESSION_ID']) saved[k] = process.env[k];
  process.env.CCV3_USER_HOME = home;
  delete process.env.CCV3_AGENT_TYPE_LOG;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  seen.fsCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('agent_type log: which calls it records', () => {
  it('T1: an unknown type with an agent_id writes one valid line with every field (breaks if the line or a field is dropped)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-a-1';
    logUnknownAgentType(sub('workflow-agent'));
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0].value).toBe('workflow-agent');
    expect(r[0].tool).toBe('Write');
    expect(r[0].agent_id).toBe('present');
    expect(r[0].session).toBe('same');
    expect(typeof r[0].ts).toBe('string');
    expect(Object.keys(r[0]).sort()).toEqual(['agent_id', 'session', 'tool', 'ts', 'value']);
  });

  it('T2: the same value twice writes one line, a second value writes a second (breaks if the dedupe is dropped)', () => {
    logUnknownAgentType(sub('workflow-agent'));
    logUnknownAgentType(sub('workflow-agent'));
    expect(lines().length).toBe(1);
    logUnknownAgentType(sub('other-agent'));
    expect(rows().map((r) => r.value)).toEqual(['workflow-agent', 'other-agent']);
  });

  it('T3: no agent_id (main session) or an empty one writes nothing (breaks if the agent_id test is dropped)', () => {
    logUnknownAgentType({ tool_name: 'Write', agent_type: 'workflow-agent' });
    logUnknownAgentType(sub('workflow-agent', { agent_id: '' }));
    logUnknownAgentType(sub('workflow-agent', { agent_id: 7 }));
    expect(lines()).toEqual([]);
  });

  it('T4: a known type writes nothing (breaks if the known list is not applied)', () => {
    for (const t of ['critic', 'kraken', 'general-purpose', 'Explore', 'scout', 'spark', 'claude', 'Plan']) logUnknownAgentType(sub(t));
    expect(lines()).toEqual([]);
  });

  it('T5: no agent_type, an empty one or a non-string one writes nothing (that is the untyped class, not this log)', () => {
    const noType = sub(undefined);
    delete noType.agent_type;
    for (const p of [noType, sub(''), sub(null), sub(42), sub({ a: 1 })]) logUnknownAgentType(p);
    expect(lines()).toEqual([]);
  });

  it('T6: a hostile value is stored as invalid and the line stays valid (breaks if the value is copied)', () => {
    for (const bad of ['a/b', 'a b', 'x"\n,"evil":1', '../../etc', 'sk-live-SECRET value', '\u0000']) logUnknownAgentType(sub(bad));
    const r = rows();
    expect(r.length).toBe(1); // every bad value is the same word, so the dedupe keeps one
    expect(r[0].value).toBe('invalid');
    const text = readFileSync(log, 'utf8');
    for (const leak of ['evil', 'sk-live', 'etc', 'a/b']) expect(text).not.toContain(leak);
  });

  it('T7: 60 characters are kept and 61 become invalid (breaks if the length limit moves)', () => {
    logUnknownAgentType(sub('a'.repeat(60)));
    logUnknownAgentType(sub('b'.repeat(61)));
    expect(rows().map((r) => r.value)).toEqual(['a'.repeat(60), 'invalid']);
  });

  it('T8: no id, path, transcript path or tool input text reaches the line (breaks if a value is copied)', () => {
    logUnknownAgentType(sub('workflow-agent', { cwd: '/very/private/cwd', tool_name: '/very/private/tool"' }));
    const text = readFileSync(log, 'utf8');
    for (const bad of ['agent-secret-id-9', 'sess-a-1', '/very/private', 'content', 't.jsonl']) expect(text).not.toContain(bad);
    expect(rows()[0].tool).toBe('other'); // a hostile tool name becomes other (TOOL_RE)
  });

  it('T9: the cap holds at 50 lines, a file above 8 KB is not read or appended (breaks if either check is dropped)', () => {
    writeFileSync(log, '{"value":"v"}\n'.repeat(AGENT_TYPE_LOG_CAP));
    logUnknownAgentType(sub('fresh-one'));
    expect(lines().length).toBe(AGENT_TYPE_LOG_CAP);
    writeFileSync(log, '{"value":"v"}\n'.repeat(AGENT_TYPE_LOG_CAP - 1));
    logUnknownAgentType(sub('fresh-one'));
    expect(lines().length).toBe(AGENT_TYPE_LOG_CAP);
    // Change B: above the byte limit nothing is read and nothing is written.
    writeFileSync(log, 'x'.repeat(AGENT_TYPE_LOG_MAX_BYTES + 1));
    seen.fsCalls.length = 0;
    logUnknownAgentType(sub('fresh-two'));
    expect(readFileSync(log, 'utf8').length).toBe(AGENT_TYPE_LOG_MAX_BYTES + 1);
    expect(seen.fsCalls.filter((c) => c.startsWith('readFileSync') && c.includes('agent-types-seen'))).toEqual([]);
    expect(seen.fsCalls.filter((c) => c.startsWith('appendFileSync'))).toEqual([]);
  });

  it('T10: an unreadable log (a folder in its place) and a missing state folder do not throw (breaks if the outer guard is dropped)', () => {
    mkdirSync(log);
    expect(() => logUnknownAgentType(sub('workflow-agent'))).not.toThrow();
    rmSync(log, { recursive: true });
    rmSync(join(home, '.claude'), { recursive: true });
    expect(() => logUnknownAgentType(sub('workflow-agent'))).not.toThrow();
    expect(rows().length).toBe(1); // the state folder is made when it is missing
    for (const bad of [null, 42, 'text', undefined, []]) expect(() => logUnknownAgentType(bad)).not.toThrow();
  });

  it('T11: CCV3_AGENT_TYPE_LOG=0 stops the log, unset logs again (reverse state)', () => {
    process.env.CCV3_AGENT_TYPE_LOG = '0';
    logUnknownAgentType(sub('workflow-agent'));
    expect(lines()).toEqual([]);
    delete process.env.CCV3_AGENT_TYPE_LOG;
    logUnknownAgentType(sub('workflow-agent'));
    expect(lines().length).toBe(1);
  });
});

describe('agent_type log: cost and the real hook', () => {
  it('T13: a main-session call, a known type and the env switch touch no file (breaks if the file test runs before the candidate test)', () => {
    rmSync(join(home, '.claude'), { recursive: true });
    seen.fsCalls.length = 0;
    logUnknownAgentType({ tool_name: 'Write', agent_type: 'workflow-agent' });
    logUnknownAgentType(sub('critic'));
    logUnknownAgentType(sub('kraken'));
    process.env.CCV3_AGENT_TYPE_LOG = '0';
    logUnknownAgentType(sub('workflow-agent'));
    expect(seen.fsCalls).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false); // the state folder is never made
  });

  describe('in the real file-claims hook', () => {
    type Out = { result?: string; hookSpecificOutput?: { permissionDecision?: string } };

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
      const repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
      for (const k of ['HOME', 'USERPROFILE', 'CCV3_FILE_CLAIMS_STATE_DIR']) saved[k] = process.env[k];
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(root, 'warned');
    });

    it('T12: the log changes no output and the line lands in the temp home, not the real one (breaks if the log changes a verdict or ignores CCV3_USER_HOME)', async () => {
      const repo = join(root, 'repo');
      const stateFile = join(home, '.claude', 'state', 'x.json');
      const unknownTypeWrite = { tool_name: 'Write', session_id: 'sess-a-2', cwd: repo, agent_id: 'a1', agent_type: 'workflow-agent', tool_input: { file_path: stateFile } };
      const untyped = { ...unknownTypeWrite, agent_type: undefined };
      process.env.CCV3_AGENT_TYPE_LOG = '0';
      const without = await runHook(unknownTypeWrite);
      const withoutUntyped = await runHook(untyped);
      expect(lines()).toEqual([]);
      delete process.env.CCV3_AGENT_TYPE_LOG;
      const withLog = await runHook(unknownTypeWrite);
      const withLogUntyped = await runHook(untyped);
      expect(withLog).toBe(without);
      expect(withLogUntyped).toBe(withoutUntyped);
      expect((JSON.parse(withLogUntyped) as Out).hookSpecificOutput?.permissionDecision).toBe('deny'); // the untyped deny stays
      expect(rows().map((r) => r.value)).toEqual(['workflow-agent']);
      // Change D: the real home got no file and no change.
      expect(existsSync(REAL_LOG) ? statSync(REAL_LOG).mtimeMs : null).toBe(realLogBefore);
    });
  });
});
