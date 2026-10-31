/**
 * The guard-decisions row for a Read that got a TLDR summary instead of the file.
 * The hook blocks the Read to inject the summary. Nothing is refused, so the row must not be a deny.
 *
 * Failure mode this test pins (name the source change that breaks it):
 *  1. the row is logged as 'deny', and every deny count includes each injected summary
 *     -> change 'inject' back to 'deny' in logSummaryInjected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logSummaryInjected } from '../tldr-read-enforcer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tldr-guard-row-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('logSummaryInjected', () => {
  it('writes one row with decision inject, not deny', () => {
    const log = join(dir, 'guard-decisions.jsonl');
    logSummaryInjected(
      { session_id: 's1', tool_name: 'Read', tool_input: { file_path: join(dir, 'a.ts') } } as any,
      { CCV3_GUARD_DECISIONS_LOG: log },
    );
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      hook: 'tldr-read-enforcer',
      tool: 'Read',
      decision: 'inject',
      reason: 'tldr-summary-injected',
    });
  });
});
