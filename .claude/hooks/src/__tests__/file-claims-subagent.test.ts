/**
 * Card coord-subagent-write-guard (gap 8): the file-claims hook judges a subagent's write BEFORE any claim.
 * The pure rules are in subagent-write.test.ts; this file runs the real `main()` with a real temp repo and home.
 *
 * Ways it can fail (one test each):
 *  1. A main-thread write of the same path is changed (it still goes to the claim check).
 *  2. A read-only subagent write to the state folder is not denied, or the claim check still runs after the deny.
 *  3. An untyped subagent write to the on-demand rules folder is not denied.
 *  4. The warn does not ride on the claim check's output, or shows twice for one path.
 *  5. A shell redirect of a read-only subagent into the state folder is not denied.
 *  6. A builder type (kraken) is denied.
 *  7. An unreadable payload or a missing session id crashes the hook.
 *  8. A deny output carries no reason text.
 *
 * The DB module is mocked (pattern of file-claims-memory-index.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const seen = vi.hoisted(() => ({ claimCalls: [] as string[], payload: '' }));

vi.mock('../shared/db-utils-pg.js', () => ({
  resolveFileClaim: async (filePath: string) => {
    seen.claimCalls.push(filePath);
    return { outcome: 'granted' };
  },
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

let root: string;
let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

type Out = { result?: string; message?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

async function runRaw(payload: string): Promise<Out> {
  seen.payload = payload;
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const text = out.mock.calls[0][0] as string;
  out.mockRestore();
  return JSON.parse(text) as Out;
}

function run(tool: string, toolInput: unknown, extra: Record<string, unknown> = {}): Promise<Out> {
  return runRaw(JSON.stringify({ tool_name: tool, session_id: 'sess-sub-1', cwd: repo, tool_input: toolInput, ...extra }));
}

const critic = { agent_id: 'a1', agent_type: 'critic' };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sub-guard-')));
  home = join(root, 'home');
  repo = join(root, 'repo');
  mkdirSync(join(home, '.claude', 'state'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  for (const k of ['HOME', 'USERPROFILE', 'CCV3_FILE_CLAIMS_STATE_DIR', 'COORDINATION_BREAK_GLASS']) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CCV3_FILE_CLAIMS_STATE_DIR = join(root, 'warned');
  delete process.env.COORDINATION_BREAK_GLASS;
  seen.claimCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('file-claims judges a subagent write first', () => {
  it('1: the main thread writing the state folder goes to the claim check, unchanged (breaks if the agent_id gate is dropped)', async () => {
    const out = await run('Write', { file_path: join(home, '.claude', 'state', 'x.json') });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(seen.claimCalls.length).toBe(1);
  });

  it('2 and 8: a read-only subagent Write to the state folder is denied with a reason and no claim is made', async () => {
    const out = await run('Write', { file_path: join(home, '.claude', 'state', 'x.json') }, critic);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('SUBAGENT WRITE BLOCKED');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('scratch folder');
    expect(seen.claimCalls.length).toBe(0);
  });

  it('3: an untyped subagent Write to the on-demand rules folder is denied', async () => {
    const out = await run('Write', { file_path: join(home, '.claude', 'rules-ondemand', 'x.md') }, { agent_id: 'a2' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('4: a write outside the scratch folder warns once and the claim check still runs', async () => {
    const file = join(repo, 'src', 'a.ts');
    const first = await run('Write', { file_path: file }, critic);
    expect(first.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(first.message ?? '').toContain('[WARN] subagent write');
    expect(seen.claimCalls.length).toBe(1);
    const second = await run('Write', { file_path: file }, critic);
    expect(second.message ?? '').not.toContain('subagent write');
  });

  it('5: a shell redirect of a read-only subagent into the state folder is denied', async () => {
    const target = join(home, '.claude', 'state', 'y.json').replace(/\\/g, '/');
    const out = await run('Bash', { command: `echo x > ${target}` }, critic);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('6: a builder subagent (kraken) is not judged by this guard', async () => {
    const out = await run('Write', { file_path: join(home, '.claude', 'state', 'x.json') }, { agent_id: 'a3', agent_type: 'kraken' });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(seen.claimCalls.length).toBe(1);
  });

  it('7: no session id and garbage input do not crash', async () => {
    const noSid = await runRaw(JSON.stringify({ tool_name: 'Write', cwd: repo, tool_input: { file_path: join(repo, 'src', 'b.ts') }, ...critic }));
    expect(noSid).toBeTruthy();
    const garbage = await runRaw('not json');
    expect(garbage.result).toBe('continue');
  });
});
