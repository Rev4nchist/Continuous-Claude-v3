/**
 * FH-01a — warm the tldr code-analysis daemon at session start.
 *
 * Unit-tests the `warmTldrDaemon` helper in isolation by mocking
 * `child_process.spawn`, so no real tldr daemon is spawned. The session-start
 * hook fires this fire-and-forget on startup for code projects; the daemon's
 * own pidfile lock makes a redundant start a no-op, and it correctly restarts
 * when the prior daemon died (the tldr daemon is known not to persist reliably
 * on Windows — re-warming each session is the intent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({
  spawn: spawnMock,
  execSync: vi.fn(),
}));

import { warmTldrDaemon } from '../session-start-init-check.js';

describe('warmTldrDaemon (FH-01a)', () => {
  let onMock: ReturnType<typeof vi.fn>;
  let unrefMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onMock = vi.fn();
    unrefMock = vi.fn();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: onMock, unref: unrefMock });
    delete process.env.CCV3_TLDR_WARM_OFF;
  });

  it('spawns `tldr daemon start --project <dir>` detached + windowsHide + stdio:ignore, then unref()s', () => {
    const ok = warmTldrDaemon('C:/Users/x/proj');

    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [spawnedCmd, spawnedArgs, opts] = spawnMock.mock.calls[0];
    // On Windows the spawn goes through the spawn-hidden Node relay: a plain
    // detached tldr.exe lets its python child open a visible console window.
    const relayed = spawnedCmd === process.execPath && spawnedArgs[0] === '-e' && spawnedArgs[2] === '--';
    expect(relayed).toBe(process.platform === 'win32');
    const cmd = relayed ? spawnedArgs[3] : spawnedCmd;
    const args = relayed ? spawnedArgs.slice(4) : spawnedArgs;
    // .exe on Windows (NOT a .cmd shim), bare name elsewhere.
    expect(cmd).toMatch(/^tldr(\.exe)?$/);
    expect(args).toEqual(['daemon', 'start', '--project', 'C:/Users/x/proj']);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });

    // Detached + unref so it never holds the parent open / adds latency.
    expect(unrefMock).toHaveBeenCalledTimes(1);
    // An 'error' handler MUST be attached, else a missing `tldr` throws async
    // and could crash the hook process.
    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('is skipped (returns false, no spawn) when CCV3_TLDR_WARM_OFF is set', () => {
    process.env.CCV3_TLDR_WARM_OFF = '1';
    const ok = warmTldrDaemon('C:/Users/x/proj');
    expect(ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never throws if spawn fails (fire-and-forget)', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT: tldr not found');
    });
    expect(() => warmTldrDaemon('C:/Users/x/proj')).not.toThrow();
    expect(warmTldrDaemon('C:/Users/x/proj')).toBe(false);
  });
});
