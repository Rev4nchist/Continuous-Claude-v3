/**
 * Regression: a ZOMBIE daemon (live PID, dead listener) must be detected by
 * tryStartDaemon — reported and refused fast — instead of being treated as
 * reachable and sending the caller into a query timeout.
 *
 * The trap this guards (CodeRabbit, PR #30): isDaemonReachable's Unix branch
 * deliberately returns true for a live PID whose ping fails ("socket might
 * just be busy", an anti-duplicate-spawn heuristic). Zombie detection must
 * therefore use the STRICT probe (isListenerAlive), which has no live-PID
 * fallback. This test fabricates the zombie state for real — no module
 * mocks: a pid file naming THIS test process (alive by definition) for a
 * unique project dir whose derived port has no listener.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import * as crypto from 'crypto';
import { tryStartDaemon, isListenerAlive } from '../lib/daemon-client.js';

// Mirrors daemon-client's getTldrTmpDir/getPidPath (both module-private).
function pidPathFor(projectDir: string): string {
  const hash = crypto.createHash('md5').update(resolve(projectDir)).digest('hex').substring(0, 8);
  const dir = process.platform === 'win32' ? 'C:/tmp' : tmpdir();
  if (process.platform === 'win32' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  return `${dir}/tldr-${hash}.pid`;
}

describe('daemon zombie detection (live PID, dead listener)', () => {
  // Unique per-run project dir -> unique endpoint nothing listens on.
  const projectDir = resolve(tmpdir(), `zombie-probe-${process.pid}-${Date.now()}`);
  const pidPath = pidPathFor(projectDir);
  let priorNoAutostart: string | undefined;

  beforeEach(() => {
    priorNoAutostart = process.env.CCV3_DAEMON_NO_AUTOSTART;
    mkdirSync(projectDir, { recursive: true });
    // A PID that is alive by definition: this test process.
    writeFileSync(pidPath, String(process.pid));
    // Safety net ONLY: if detection regresses, this stops a real daemon
    // spawn. The console.error assertion below keeps the test non-vacuous —
    // the escape hatch also returns false, so the return value alone would
    // pass even with detection broken.
    process.env.CCV3_DAEMON_NO_AUTOSTART = '1';
  });

  afterEach(() => {
    rmSync(pidPath, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    // Restore, don't blindly delete — the runner may have started with it set.
    if (priorNoAutostart === undefined) delete process.env.CCV3_DAEMON_NO_AUTOSTART;
    else process.env.CCV3_DAEMON_NO_AUTOSTART = priorNoAutostart;
  });

  it('strict probe reports the dead listener', () => {
    expect(isListenerAlive(projectDir)).toBe(false);
  });

  it('tryStartDaemon surfaces the zombie and returns false fast', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const result = tryStartDaemon(projectDir);
    const elapsed = Date.now() - t0;
    const zombieReported = errSpy.mock.calls.some((c) =>
      String(c[0]).includes('zombie'),
    );
    errSpy.mockRestore();

    expect(result).toBe(false);
    // The load-bearing assertion: the ZOMBIE branch fired, not the
    // no-autostart escape hatch (which would also return false).
    expect(zombieReported).toBe(true);
    // "Give up fast" is the contract — well under the old 31s query timeout.
    expect(elapsed).toBeLessThan(5000);
  });
});
