/**
 * Handoff selection by session id (package A2).
 * On compact the hook must pick only the handoff its own session wrote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  POINTER_MAX,
  buildHandoffPointer,
  handoffSkipReason,
  selectSessionHandoff,
} from '../shared/handoff-select.js';

const SID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const DAY = 24 * 60 * 60 * 1000;

function handoff(sid: string | null, opts: { outcome?: string; status?: string; goal?: string; now?: string } = {}): string {
  const lines = ['---', 'session: general', 'date: 2026-11-07'];
  lines.push(`status: ${opts.status ?? 'partial'}`);
  lines.push(`outcome: ${opts.outcome ?? 'PARTIAL_PLUS'}`);
  if (sid) lines.push(`session_id: ${sid}`);
  lines.push('---', '', `goal: ${opts.goal ?? 'ship A2'}`, `now: ${opts.now ?? 'run the tests'}`, '');
  return lines.join('\n');
}

describe('selectSessionHandoff', () => {
  let base: string;

  const put = (dir: string, file: string, content: string, ageMs = 0): string => {
    const d = path.join(base, dir);
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, file);
    fs.writeFileSync(p, content);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-select-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('picks the matching session even when another session wrote a newer file in another folder', () => {
    const mine = put('general', '2026-11-07_10-00_aaaaaaaa_mine.yaml', handoff(SID_A), 3_600_000);
    put('other-folder', '2026-11-07_11-00_bbbbbbbb_theirs.yaml', handoff(SID_B), 0);
    const got = selectSessionHandoff(base, [SID_A]);
    expect(got?.path).toBe(mine);
  });

  it('never returns a handoff of another session', () => {
    put('general', '2026-11-07_11-00_bbbbbbbb_theirs.yaml', handoff(SID_B));
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('never returns a handoff with no session_id', () => {
    put('general', 'legacy.yaml', handoff(null));
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('ignores a session_id that sits in the body, not the frontmatter', () => {
    put('general', 'body.yaml', `${handoff(SID_B)}\nnotes: session_id: ${SID_A}\n`);
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('needs the full id, not a prefix', () => {
    put('general', 'x.yaml', handoff(SID_A));
    expect(selectSessionHandoff(base, ['aaaaaaaa'])).toBeNull();
  });

  it('accepts any id in the list (clear: current plus previous)', () => {
    const p = put('general', 'x.yaml', handoff(SID_B));
    expect(selectSessionHandoff(base, [SID_A, SID_B])?.path).toBe(p);
  });

  it('takes the newest of this session when it has several', () => {
    put('general', 'old.yaml', handoff(SID_A, { goal: 'old' }), 2 * 3_600_000);
    const fresh = put('general', 'new.yaml', handoff(SID_A, { goal: 'new' }), 0);
    expect(selectSessionHandoff(base, [SID_A])?.path).toBe(fresh);
  });

  it('treats FAILED as terminal', () => {
    put('general', 'x.yaml', handoff(SID_A, { outcome: 'FAILED' }));
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('treats SUCCEEDED and status complete as terminal', () => {
    put('a', 'x.yaml', handoff(SID_A, { outcome: 'SUCCEEDED' }));
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
    fs.rmSync(path.join(base, 'a'), { recursive: true });
    put('b', 'x.yaml', handoff(SID_A, { status: 'complete', outcome: 'PARTIAL_PLUS' }));
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('keeps PARTIAL_PLUS and PARTIAL_MINUS resumable', () => {
    const p = put('general', 'x.yaml', handoff(SID_A, { outcome: 'PARTIAL_MINUS' }));
    expect(selectSessionHandoff(base, [SID_A])?.path).toBe(p);
  });

  it('does not fall back to an older partial when the newest of the session is terminal', () => {
    put('general', 'old.yaml', handoff(SID_A, { outcome: 'PARTIAL_PLUS' }), 2 * 3_600_000);
    put('general', 'new.yaml', handoff(SID_A, { outcome: 'FAILED' }), 0);
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
  });

  it('skips a handoff older than 7 days and keeps one at 6 days', () => {
    put('general', 'old.yaml', handoff(SID_A), 8 * DAY);
    expect(selectSessionHandoff(base, [SID_A])).toBeNull();
    const fresh = put('general', 'ok.yaml', handoff(SID_A), 6 * DAY);
    expect(selectSessionHandoff(base, [SID_A])?.path).toBe(fresh);
  });

  it('returns null when the handoffs folder does not exist or the id list is empty', () => {
    expect(selectSessionHandoff(path.join(base, 'missing'), [SID_A])).toBeNull();
    put('general', 'x.yaml', handoff(SID_A));
    expect(selectSessionHandoff(base, [])).toBeNull();
  });
});

describe('handoffSkipReason', () => {
  it('names the reason', () => {
    const now = Date.now();
    expect(handoffSkipReason(handoff(SID_A, { outcome: 'FAILED' }), now, now)).toBe('terminal');
    expect(handoffSkipReason(handoff(SID_A), now - 8 * DAY, now)).toBe('stale');
    expect(handoffSkipReason(handoff(SID_A), now, now)).toBeNull();
  });
});

describe('buildHandoffPointer', () => {
  it('holds the path, goal and now', () => {
    const project = path.join(os.tmpdir(), 'proj');
    const p = path.join(project, 'thoughts', 'shared', 'handoffs', 'general', 'x.yaml');
    const text = buildHandoffPointer(p, handoff(SID_A, { goal: 'ship A2', now: 'run tests' }), project);
    expect(text).toContain('thoughts/shared/handoffs/general/x.yaml');
    expect(text).toContain('goal: ship A2');
    expect(text).toContain('now: run tests');
  });

  it('stays within the length bound for very long goal and now', () => {
    const project = path.join(os.tmpdir(), 'proj');
    const p = path.join(project, 'thoughts', 'shared', 'handoffs', 'general', 'x.yaml');
    const long = 'word '.repeat(500);
    const text = buildHandoffPointer(p, handoff(SID_A, { goal: long, now: long }), project);
    expect(text.length).toBeLessThanOrEqual(POINTER_MAX);
    expect(text).toContain('thoughts/shared/handoffs/general/x.yaml');
    expect(text).toContain('goal: ');
    expect(text).toContain('now: ');
  });

  it('never carries the rest of the YAML body', () => {
    const project = path.join(os.tmpdir(), 'proj');
    const p = path.join(project, 'x.yaml');
    const text = buildHandoffPointer(p, `${handoff(SID_A)}\ndecisions:\n  - SECRET_BODY_MARKER: yes\n`, project);
    expect(text).not.toContain('SECRET_BODY_MARKER');
  });
});
