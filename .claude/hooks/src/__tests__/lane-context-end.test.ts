/**
 * lane-context must not wait for the socket close after the watermark write.
 *
 * The watermark INSERT marks the events read. If `await client.end()` then runs before
 * the return value resolves, a slow close can cross the prompt-submit deadline. The
 * job is recorded as a timeout, its output is dropped, and the messages are already
 * marked read: lost with no trace.
 *
 * pg is mocked here because the real Client has no seam for a slow end().
 * [Source change that turns this red: `void client.end()` back to `await client.end()`.]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  queries: [] as string[],
  endCalled: false,
  connectDelayMs: 0,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> {
      if (fake.connectDelayMs > 0) await new Promise((res) => setTimeout(res, fake.connectDelayMs));
    }
    async query(sql: string): Promise<{ rows: unknown[] }> {
      fake.queries.push(sql);
      if (/FROM agentic_os\.lane_event/.test(sql)) {
        return { rows: [{ id: 7, occurred_at: 'now', lane_id: null, kind: 'say', session_id: 'peer-session', to_session_id: 'me-session', body: 'DM-BODY' }] };
      }
      return { rows: [] };
    }
    end(): Promise<void> {
      fake.endCalled = true;
      return new Promise(() => { /* the socket close never finishes */ });
    }
  }
  return { Client, default: { Client } };
});

import { runLaneContext } from '../lane-context.js';
import { runPromptSubmit } from '../prompt-submit.js';

const PAYLOAD = JSON.stringify({ session_id: 'me-session', hook_event_name: 'UserPromptSubmit', prompt: 'hello there friend' });

describe('lane-context: a slow client.end() after the watermark write', () => {
  const saved = process.env.CONTINUOUS_CLAUDE_DB_URL;
  const savedEnv = { reg: process.env.LANE_REGISTRY_PATH, cache: process.env.LANE_BOARD_CACHE, ep: process.env.CLAUDE_CODE_ENTRYPOINT };
  let dir = '';
  beforeEach(() => {
    // Hermetic board: a registry whose root covers the test cwd, no session cache.
    dir = mkdtempSync(join(tmpdir(), 'lc-end-'));
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ projects: [{ name: 'CCv3', key: 'continuous-claude', path: process.cwd(), status: 'active' }] }));
    process.env.LANE_REGISTRY_PATH = join(dir, 'registry.json');
    process.env.LANE_BOARD_CACHE = '0';
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    fake.queries.length = 0;
    fake.endCalled = false;
    fake.connectDelayMs = 0;
    process.env.CONTINUOUS_CLAUDE_DB_URL = 'postgres://fake@localhost:1/fake';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTINUOUS_CLAUDE_DB_URL; else process.env.CONTINUOUS_CLAUDE_DB_URL = saved;
    if (savedEnv.reg === undefined) delete process.env.LANE_REGISTRY_PATH; else process.env.LANE_REGISTRY_PATH = savedEnv.reg;
    if (savedEnv.cache === undefined) delete process.env.LANE_BOARD_CACHE; else process.env.LANE_BOARD_CACHE = savedEnv.cache;
    if (savedEnv.ep === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = savedEnv.ep;
    rmSync(dir, { recursive: true, force: true });
  });

  // Card tests-flaky-under-load-1115. The old row raced runLaneContext against a 1000 ms timer: a loaded machine made the work before
  // end() slower than that and the row read it as "waited for end()". These rows judge the ORDER: the output settles although the fake
  // end() promise never does. The timer is only a backstop, so that code that really waits for end() fails and does not hang.
  const BACKSTOP_MS = 25_000;
  async function settleOrBackstop(p: Promise<unknown>): Promise<unknown> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise((res) => { t = setTimeout(() => res('STUCK'), BACKSTOP_MS); t.unref?.(); });
    try { return await Promise.race([p, stuck]); } finally { clearTimeout(t); }
  }
  /** The output returns while end() is pending: end() was called, and the returned value still came back. */
  function expectOutputBeforeEndSettles(result: unknown): void {
    expect(result, 'runLaneContext waited for client.end()').not.toBe('STUCK');
    expect(JSON.stringify(result)).toContain('DM-BODY');
    expect(fake.queries.some((q) => /INSERT INTO agentic_os\.lane_watermark/.test(q)), 'watermark was written').toBe(true);
    expect(fake.endCalled, 'end() was still called').toBe(true);
  }

  it('returns the output without waiting for end()', async () => {
    expectOutputBeforeEndSettles(await settleOrBackstop(runLaneContext(PAYLOAD)));
  });

  // Red before the change: the old 1000 ms bar read this slow connect (1200 ms, a loaded machine) as a wait for end().
  it('a slow connect (1200 ms, a loaded machine) is not read as a wait for end()', async () => {
    fake.connectDelayMs = 1200;
    expectOutputBeforeEndSettles(await settleOrBackstop(runLaneContext(PAYLOAD)));
  });

  // The deadline is an input of the code under test (runPromptSubmit), so a time limit stays here. 4000 ms (was 600) lets a loaded
  // machine finish the work before it; a run that waits for end() still reaches the deadline and reads status timeout.
  it('prompt-submit keeps the output: status ok, not timeout, when the deadline falls after the watermark write', async () => {
    const { output, report } = await runPromptSubmit(PAYLOAD, [{ name: 'lane-context', run: runLaneContext }], 4000);
    expect(report[0].status).toBe('ok');
    expect(JSON.stringify(output)).toContain('DM-BODY');
  });
});
