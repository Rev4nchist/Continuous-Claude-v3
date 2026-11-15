/**
 * file-claims -> guard log.
 *
 * Ways it can fail (one test each):
 *  1. A break-glass takeover (COORDINATION_BREAK_GLASS=1) leaves no 'override' record.
 *  2. An ordinary expired-lease takeover is logged as an override (over-logging).
 *  3. A blocked edit is no longer logged as a 'deny'.
 *
 * The hook runs main() on import and reads stdin, so the test mocks the DB call and fd 0,
 * then imports the real module. resolveFileClaim's outcome drives the record; the module's own
 * break-glass flag is read at import time and is not what the log must depend on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const claim = vi.hoisted(() => ({ decision: {} as Record<string, unknown>, payload: '' }));

vi.mock('../shared/db-utils-pg.js', () => ({ resolveFileClaim: async () => claim.decision }));
// Card coord-file-guard-named-file: a deny asks the lane table for a hint; no test reaches a real database.
vi.mock('../shared/holder-lane.js', () => ({ holderHoldsOpenLane: async () => null }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? claim.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

let dir: string;
let log: string;
let saved: string | undefined;

const records = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

async function runHook(decision: Record<string, unknown>): Promise<Record<string, unknown>> {
  claim.decision = decision;
  claim.payload = JSON.stringify({
    tool_name: 'Edit',
    session_id: 'sess-fc-test',
    cwd: dir,
    tool_input: { file_path: join(dir, 'target.ts') },
  });
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
  await import('../file-claims.js');
  await vi.waitFor(() => expect(out).toHaveBeenCalled());
  const printed = JSON.parse(String(out.mock.calls[0][0]));
  out.mockRestore();
  return printed;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-claims-log-'));
  log = join(dir, 'guard-decisions.jsonl');
  saved = process.env.CCV3_GUARD_DECISIONS_LOG;
  process.env.CCV3_GUARD_DECISIONS_LOG = log;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_GUARD_DECISIONS_LOG;
  else process.env.CCV3_GUARD_DECISIONS_LOG = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('file-claims guard log', () => {
  it('records an override when break-glass forces a takeover', async () => {
    const printed = await runHook({ outcome: 'takeover', holder: 'sess-holder', breakGlass: true, priorFence: 3, fence: 4 });
    expect(String(printed.message)).toContain('BREAK-GLASS');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      hook: 'file-claims',
      tool: 'Edit',
      decision: 'override',
      session_id: 'sess-fc-test',
    });
    expect(String(records()[0].reason)).toContain('sess-holder');
  });

  it('records nothing for an ordinary expired-lease takeover', async () => {
    await runHook({ outcome: 'takeover', holder: 'sess-holder', priorFence: 3, fence: 4 });
    expect(records()).toEqual([]);
  });

  it('records a deny when the edit is blocked', async () => {
    const printed = await runHook({ outcome: 'blocked', holder: 'sess-holder', leaseClass: 'file' });
    expect(JSON.stringify(printed)).toContain('deny');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ hook: 'file-claims', decision: 'deny' });
  });
});
