import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handoffMessage, formatAge } from '../pre-compact-continuity.js';

let root: string;
const NOW = Date.parse('2026-11-08T12:00:00Z');

function put(rel: string, ageMs: number, body = 'x: 1\n'): string {
  const p = path.join(root, 'thoughts', 'shared', 'handoffs', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  const t = new Date(NOW - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-test-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('handoffMessage', () => {
  it('reports no ledger and no handoff when the folder is missing', () => {
    expect(handoffMessage(root, undefined, NOW)).toBe('[PreCompact] no ledger and no handoff found');
  });

  it('reports no handoff when the folder has only non-yaml files', () => {
    put('a/notes.md', 1000);
    expect(handoffMessage(root, undefined, NOW)).toBe('[PreCompact] no ledger and no handoff found');
  });

  it('reports the newest yaml by mtime in any subfolder, with a relative path', () => {
    put('old/one.yaml', 3 * 3600_000);
    put('deep/er/two.yaml', 5 * 60_000);
    expect(handoffMessage(root, undefined, NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/deep/er/two.yaml (5m ago)',
    );
  });

  it('prefers the file named with the session sid8 over a newer file', () => {
    put('s/h-abcd1234-x.yaml', 2 * 3600_000);
    put('s/newer.yaml', 60_000);
    expect(handoffMessage(root, 'abcd1234-0000-1111-2222-333333333333', NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/s/h-abcd1234-x.yaml (2h ago)',
    );
  });

  it('falls back to newest by mtime when no file name carries the sid8', () => {
    put('s/a.yaml', 2 * 3600_000);
    put('s/b.yml', 60_000);
    expect(handoffMessage(root, 'ffffffff-0000-1111-2222-333333333333', NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/s/b.yml (1m ago)',
    );
  });

  it('names the newest of several files that carry the same sid8', () => {
    put('s/h-abcd1234-old.yaml', 3 * 3600_000);
    put('s/h-abcd1234-new.yaml', 10 * 60_000);
    put('s/other-newest.yaml', 1000);
    expect(handoffMessage(root, 'abcd1234-0000-1111-2222-333333333333', NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/s/h-abcd1234-new.yaml (10m ago)',
    );
  });

  it.each([['abc'], ['']])('falls back to the newest file overall for session_id %j (shorter than 8)', (sid) => {
    put('s/abc-old.yaml', 2 * 3600_000);
    put('s/newest.yaml', 60_000);
    expect(handoffMessage(root, sid, NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/s/newest.yaml (1m ago)',
    );
  });

  it('finds a file with an uppercase .YAML extension', () => {
    put('s/UPPER.YAML', 5 * 60_000);
    expect(handoffMessage(root, undefined, NOW)).toBe(
      '[PreCompact] newest handoff: thoughts/shared/handoffs/s/UPPER.YAML (5m ago)',
    );
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatAge(5_000)).toBe('just now');
    expect(formatAge(90_000)).toBe('1m ago');
    expect(formatAge(7_200_000)).toBe('2h ago');
    expect(formatAge(3 * 86_400_000)).toBe('3d ago');
    expect(formatAge(-5)).toBe('just now');
  });
});
