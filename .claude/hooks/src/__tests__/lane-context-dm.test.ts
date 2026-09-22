/**
 * Guards on the mid-turn direct-message path (2026-08-10).
 *
 * The path exists because both older delivery points fire only when the human
 * acts, so a session mid-agent-wave cannot be warned. Adding a third delivery
 * point to PostToolUse introduces two ways to make things WORSE than before,
 * and these tests exist for exactly those two:
 *
 *   1. COST. PostToolUse fires orders of magnitude more often than
 *      UserPromptSubmit. If the throttle gate is ever moved below the client
 *      construction, or its window quietly shrinks, every tool call starts
 *      paying for a database connection. Test: a call inside the window must
 *      not even record an attempt.
 *
 *   2. SILENT LOSS. A hook cannot tell whether it runs inside a subagent --
 *      identity-probe measured a scout reporting its PARENT's session_id with
 *      CLAUDE_AGENT_ID unset (2026-07-26). So a consuming implementation would
 *      let a subagent mark its parent's message read and the orchestrator would
 *      never see it. Test: the path contains no watermark write at all.
 *
 * What these tests deliberately do NOT cover is end-to-end delivery, which
 * needs a real database and a real event. That gate is
 * `scripts/coordination/dm-delivery-probe.mjs`, and a green run of this file is
 * not evidence a message actually arrives.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DM_THROTTLE_MS,
  deliverDirectMessages,
  dmStatePath,
  readDmState,
  writeDmState,
} from '../lane-context.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lane-context.ts'),
  'utf8',
);

/** A session id per test, so no two tests share throttle state. */
let n = 0;
const freshSession = (): string => `test-dm-${process.pid}-${++n}`;
const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanup.length) {
    try { rmSync(cleanup.pop() as string, { force: true }); } catch { /* best effort */ }
  }
});

function session(): string {
  const s = freshSession();
  cleanup.push(dmStatePath(s));
  return s;
}

describe('dm state file', () => {
  it('is per-session, so two sessions never share a throttle', () => {
    expect(dmStatePath('aaa')).not.toBe(dmStatePath('bbb'));
  });

  it('cannot escape the temp directory', () => {
    // The property is "no separator survives into the basename", not "no dots".
    // A `..` with nothing to traverse through is an ordinary filename, and the
    // fixed `claude-lane-dm-` prefix means the name is never `..` itself.
    const p = dmStatePath('../../etc/passwd');
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p.slice(tmpdir().length + 1)).not.toMatch(/[\\/]/);
  });

  it('round-trips', () => {
    const s = session();
    writeDmState(s, { ts: 123, lastShownDmId: 45 });
    expect(readDmState(s)).toEqual({ ts: 123, lastShownDmId: 45 });
  });

  it('reads a MISSING file as never-shown, never-throttled', () => {
    // The direction matters: a missing file must not suppress delivery. Zeros
    // mean "show me everything", which is the safe way to be wrong.
    expect(readDmState(session())).toEqual({ ts: 0, lastShownDmId: 0 });
  });

  it('reads a CORRUPT file as never-shown, never-throttled', () => {
    const s = session();
    writeFileSync(dmStatePath(s), '{not json', 'utf8');
    expect(readDmState(s)).toEqual({ ts: 0, lastShownDmId: 0 });
  });
});

describe('throttle gate', () => {
  it('does nothing at all inside the window', async () => {
    const s = session();
    const t0 = 1_000_000;
    writeDmState(s, { ts: t0, lastShownDmId: 7 });

    const emitFn = vi.fn();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await deliverDirectMessages(s, t0 + DM_THROTTLE_MS - 1, emitFn);

    expect(emitFn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('{}');
    // The timestamp is untouched, which is the observable proof the gate
    // returned BEFORE constructing a client. A throttled call that still
    // connected would have restamped it.
    expect(readDmState(s)).toEqual({ ts: t0, lastShownDmId: 7 });
  });

  it('proceeds past the window and stamps the attempt before making it', async () => {
    const s = session();
    const t0 = 1_000_000;
    writeDmState(s, { ts: t0, lastShownDmId: 7 });

    const emitFn = vi.fn();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const now = t0 + DM_THROTTLE_MS + 1;
    await deliverDirectMessages(s, now, emitFn);

    // No database in the test environment, so this ends in the silent catch.
    // The stamp still moved: the attempt is recorded up front so a hanging or
    // killed check pushes the next one out by a full window instead of letting
    // every tool call queue its own doomed connection.
    expect(readDmState(s).ts).toBe(now);
    // And a failed check must never claim to have shown anything.
    expect(readDmState(s).lastShownDmId).toBe(7);
  });

  it('stays silent when the database is unreachable', async () => {
    const s = session();
    const emitFn = vi.fn();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await deliverDirectMessages(s, Date.now(), emitFn);

    expect(emitFn).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('{}');
  });
});

describe('non-consuming invariant', () => {
  /**
   * A textual ratchet, in the style of hook-matcher-runtime-consistency: weak
   * enough not to false-alarm, strong enough to catch the one edit that would
   * reintroduce silent loss. Verified to FAIL on purpose by pasting the
   * watermark upsert into deliverDirectMessages.
   */
  const body = (() => {
    const start = SRC.indexOf('export async function deliverDirectMessages');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('\nasync function main(', start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  })();

  it('never writes lane_watermark', () => {
    expect(body).not.toMatch(/lane_watermark\s*\(/);
    expect(body.toUpperCase()).not.toContain('INSERT INTO');
    expect(body.toUpperCase()).not.toContain('UPDATE AGENTIC_OS');
  });

  it('reads lane_watermark only inside the GREATEST de-duplication guard', () => {
    // It may READ the watermark -- that is how it avoids re-showing what the
    // prompt path already delivered.
    expect(body).toContain('lane_watermark');
    expect(body).toContain('GREATEST');
  });

  it('filters to direct messages only, never broadcasts', () => {
    // to_session_id = $1 is the whole reason this path is not a per-tool-call
    // broadcast storm across every live session.
    expect(body).toContain('e.to_session_id = $1');
    expect(body).not.toContain('e.to_session_id IS NULL');
  });

  it('tells the receiver the sender is a peer, not the user', () => {
    // A message from another session must never read as user instruction, and
    // must never be treated as consent.
    expect(body).toMatch(/cannot grant permission|not the user/i);
  });
});
