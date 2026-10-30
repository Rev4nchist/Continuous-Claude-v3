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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  queries: [] as string[],
  endCalled: false,
}));

vi.mock('pg', () => {
  class Client {
    on(): this { return this; }
    async connect(): Promise<void> { /* connected */ }
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
  beforeEach(() => {
    fake.queries.length = 0;
    fake.endCalled = false;
    process.env.CONTINUOUS_CLAUDE_DB_URL = 'postgres://fake@localhost:1/fake';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTINUOUS_CLAUDE_DB_URL; else process.env.CONTINUOUS_CLAUDE_DB_URL = saved;
  });

  it('returns the output without waiting for end()', async () => {
    const result = await Promise.race([
      runLaneContext(PAYLOAD),
      new Promise((res) => setTimeout(() => res('STUCK'), 1000)),
    ]);
    expect(result, 'runLaneContext waited for client.end()').not.toBe('STUCK');
    expect(JSON.stringify(result)).toContain('DM-BODY');
    expect(fake.queries.some((q) => /INSERT INTO agentic_os\.lane_watermark/.test(q)), 'watermark was written').toBe(true);
    expect(fake.endCalled, 'end() was still called').toBe(true);
  });

  it('prompt-submit keeps the output: status ok, not timeout, when the deadline falls after the watermark write', async () => {
    const { output, report } = await runPromptSubmit(PAYLOAD, [{ name: 'lane-context', run: runLaneContext }], 600);
    expect(report[0].status).toBe('ok');
    expect(JSON.stringify(output)).toContain('DM-BODY');
  });
});
