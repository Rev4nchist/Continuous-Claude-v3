/**
 * lane-board-stop-gate: the "FleetOps data is stale" line.
 *
 * The line is appended to a lane-board block reason that already happens. It never causes a block.
 * Failure list, one test (or group) each:
 *   F1  the line repeats inside the hour (throttle marker not written or not read)
 *   F2  a new export (new key) does not re-notify inside the hour
 *   F3  the line shows for a headless run or a stop_hook_active continuation (and touches the marker)
 *   F4  the marker cannot be written: the line shows anyway (it must be dropped; the board block still fires)
 *   F5  a missing, empty or corrupt refresh.json speaks (it must say nothing)
 *   F6  pending false and a fresh export speaks
 *   F7  pending true does not give the line
 *   F8  an export over 36 h old with pending false does not give the line (or one under 36 h does)
 *   F9  the line replaces the board instructions instead of following them
 *   F10 two sessions each get the line inside the hour (the throttle is per machine)
 *   F11 the time is not in America/Chicago, or the zone word is wrong across the DST change
 *   F12 the line blocks a turn the board gate would have approved (or burns the marker doing so);
 *       this holds for an approve by the publish budget rules too (a say-only batch, the daily cap)
 *   F13 a huge refresh.json or marker is read whole after the block is final (memory, slow stop)
 *   F14 the marker write leaves a .tmp file behind, or is not atomic
 *   F15 a headless opt-in (LANE_CONTEXT_HEADLESS=1) burns the marker for a run that cannot act on it
 *   F16 a marker write failure writes to stderr (an advisory hook fails open and silent)
 *   F17 the marker write follows a symlink to another file
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as gate from '../lane-board-stop-gate.js';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const payload = (sid = 'sess-1', extra: Record<string, unknown> = {}) => ({ session_id: sid, hook_event_name: 'Stop', ...extra });
const STALE = /FleetOps data is stale/;
const SKILL = 'Tell Dave in one line. Run the fleetops-refresh skill only if he asks.';

let tmp = '';
let pendingDir = '';
let dashDir = '';
let home = '';
let registry = '';
const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  LANE_BOARD_PENDING_DIR: pendingDir,
  LANE_DASH_STATE_DIR: dashDir,
  CCV3_USER_HOME: home,
  LANE_REGISTRY_PATH: registry,
  ...extra,
});
const marker = () => path.join(dashDir, '.refresh-shown.json');
const readMarker = () => JSON.parse(fs.readFileSync(marker(), 'utf8'));
const writeRefresh = (doc: unknown) => fs.writeFileSync(path.join(dashDir, 'refresh.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
const refreshDoc = (over: Record<string, unknown> = {}) => {
  const at = iso(NOW - 2 * HOUR);
  return { pending: true, key: at, exported_at: at, files: ['lanes.json'], cleared_at: null, ...over };
};
/** A fresh board batch for a session: the gate blocks it once. */
const batch = (sid = 'sess-1') => fs.writeFileSync(path.join(pendingDir, `${sid}.json`), JSON.stringify({ since: 'x', verbs: ['claim'], board: 'continuous-claude' }));
const reasonOf = (r: { output: object | null }): string => (r.output as { reason?: string } | null)?.reason ?? '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-fleetops-'));
  pendingDir = path.join(tmp, 'pending');
  dashDir = path.join(tmp, 'lane-dash');
  home = path.join(tmp, 'home');
  registry = path.join(tmp, 'registry.json');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(dashDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'continuous-claude', '.claude'), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ projects: [{ name: 'CCv3', key: 'continuous-claude', path: path.join(tmp, 'ccv3'), status: 'active' }] }));
  fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
    { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publish_from: 'lane-board.html' },
  ] }));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('stop gate with a stale FleetOps line', () => {
  it('F7: pending true adds the line to the board block, after the board steps', () => {
    writeRefresh(refreshDoc());
    batch();
    const reason = reasonOf(gate.stopGate(payload(), baseEnv(), NOW));
    expect(reason).toMatch(STALE);
    expect(reason).toContain('not uploaded');
    expect(reason).toContain(SKILL);
    expect(reason).not.toContain('older than 36 hours');
  });

  it('F9: the line follows the full board block reason; it does not replace it', () => {
    writeRefresh(refreshDoc());
    batch();
    const reason = reasonOf(gate.stopGate(payload(), baseEnv(), NOW));
    batch('sess-9');
    const boardOnly = reasonOf(gate.stopGate(payload('sess-9'), baseEnv({ LANE_DASH_STATE_DIR: path.join(tmp, 'nowhere') }), NOW));
    expect(boardOnly).toContain('Then finish your turn.');
    expect(reason.startsWith(boardOnly)).toBe(true);
    expect(reason.indexOf('Then finish your turn.')).toBeLessThan(reason.indexOf('FleetOps data is stale'));
    expect(reason.trimEnd().endsWith(SKILL)).toBe(true);
  });

  it('F7: the marker holds the key and the shown time, written before the block returns', () => {
    const doc = refreshDoc();
    writeRefresh(doc);
    batch();
    const out = gate.stopGate(payload(), baseEnv(), NOW);
    expect(out.output).toMatchObject({ decision: 'block' });
    const m = readMarker();
    expect(m.key).toBe(doc.key);
    expect(Date.parse(m.shown_at)).toBe(NOW);
  });

  it('F8: pending false and an export 37 h old gives the "older than 36 hours" line', () => {
    const at = iso(NOW - 37 * HOUR);
    writeRefresh(refreshDoc({ pending: false, key: at, exported_at: at, cleared_at: iso(NOW - 36 * HOUR) }));
    batch();
    const reason = reasonOf(gate.stopGate(payload(), baseEnv(), NOW));
    expect(reason).toMatch(STALE);
    expect(reason).toContain('older than 36 hours');
    expect(reason).not.toContain('not uploaded');
    expect(reason).toContain(SKILL);
  });

  it('F8: pending false and an export 35 h old says nothing', () => {
    const at = iso(NOW - 35 * HOUR);
    writeRefresh(refreshDoc({ pending: false, key: at, exported_at: at }));
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW))).not.toMatch(STALE);
  });

  it('F6: pending false and a fresh export says nothing and writes no marker', () => {
    writeRefresh(refreshDoc({ pending: false }));
    batch();
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F5: a missing, empty, corrupt or non-object refresh.json says nothing', () => {
    for (const body of [null, '', '   ', '{not json', '[]', 'null', '42', '"x"']) {
      fs.rmSync(path.join(dashDir, 'refresh.json'), { force: true });
      if (body !== null) writeRefresh(body);
      batch();
      const r = gate.stopGate(payload(), baseEnv(), NOW);
      expect(r.output).toMatchObject({ decision: 'block' });
      expect(reasonOf(r)).not.toMatch(STALE);
      expect(fs.existsSync(marker())).toBe(false);
    }
  });

  it('F5: a missing state dir says nothing', () => {
    fs.rmSync(dashDir, { recursive: true, force: true });
    batch();
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
  });
});

describe('throttle', () => {
  it('F1: a second batch inside the hour gets the board block but no line, and the marker stays', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW))).toMatch(STALE);
    const before = fs.readFileSync(marker(), 'utf8');
    batch();
    const second = gate.stopGate(payload(), baseEnv(), NOW + 30 * MIN);
    expect(second.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(second)).not.toMatch(STALE);
    expect(fs.readFileSync(marker(), 'utf8')).toBe(before);
  });

  it('F1: after the hour the line shows again and the marker moves', () => {
    writeRefresh(refreshDoc());
    batch();
    gate.stopGate(payload(), baseEnv(), NOW);
    batch();
    const later = NOW + 61 * MIN;
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), later))).toMatch(STALE);
    expect(Date.parse(readMarker().shown_at)).toBe(later);
  });

  it('F1: exactly one hour is not over one hour', () => {
    writeRefresh(refreshDoc());
    batch();
    gate.stopGate(payload(), baseEnv(), NOW);
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW + HOUR))).not.toMatch(STALE);
  });

  it('F2: a new export (new key) inside the hour shows the line at once', () => {
    writeRefresh(refreshDoc());
    batch();
    gate.stopGate(payload(), baseEnv(), NOW);
    const newAt = iso(NOW + 5 * MIN);
    writeRefresh(refreshDoc({ key: newAt, exported_at: newAt }));
    batch();
    const r = gate.stopGate(payload(), baseEnv(), NOW + 10 * MIN);
    expect(reasonOf(r)).toMatch(STALE);
    expect(readMarker().key).toBe(newAt);
  });

  it('F10: two sessions share one throttle', () => {
    writeRefresh(refreshDoc());
    batch('sess-1');
    batch('sess-2');
    expect(reasonOf(gate.stopGate(payload('sess-1'), baseEnv(), NOW))).toMatch(STALE);
    const other = gate.stopGate(payload('sess-2'), baseEnv(), NOW + 2 * MIN);
    expect(other.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(other)).not.toMatch(STALE);
  });

  it('F4: a marker that cannot be written drops the line; the board block still fires and is marked', () => {
    writeRefresh(refreshDoc());
    fs.mkdirSync(marker()); // a directory where the file should go: every write fails
    batch();
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(reasonOf(r)).toContain('Then finish your turn.');
    expect(JSON.parse(fs.readFileSync(path.join(pendingDir, 'sess-1.json'), 'utf8')).stopBlocked).toBe(true);
  });

  it('F1: a corrupt marker counts as no marker', () => {
    writeRefresh(refreshDoc());
    fs.writeFileSync(marker(), '{oops');
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW))).toMatch(STALE);
    expect(Date.parse(readMarker().shown_at)).toBe(NOW);
  });
});

describe('the line never causes a block', () => {
  it('F12: a stale export with no pending board file approves and writes no marker', () => {
    writeRefresh(refreshDoc());
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    expect(r.output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F12: a batch that was already blocked approves and writes no marker', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(gate.stopGate(payload(), baseEnv(), NOW).output).not.toBeNull();
    fs.rmSync(marker());
    expect(gate.stopGate(payload(), baseEnv(), NOW + 2 * HOUR).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F12: a pending file for a board with no phone page approves and writes no marker', () => {
    writeRefresh(refreshDoc());
    // `claim`, not `note`: a note-only batch approves on any board now, so `note` would not test the page rule
    fs.writeFileSync(path.join(pendingDir, 'sess-1@zz-board.json'), JSON.stringify({ since: 'x', verbs: ['claim'], board: 'zz-board' }));
    expect(gate.stopGate(payload(), baseEnv(), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F12 (G1): a say-only batch approves and writes no marker', () => {
    writeRefresh(refreshDoc());
    const file = path.join(pendingDir, 'sess-1.json');
    fs.writeFileSync(file, JSON.stringify({ since: 'x', verbs: ['say', 'note'], board: 'continuous-claude' }));
    expect(gate.stopGate(payload(), baseEnv(), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).stopBlocked).toBeUndefined();
  });

  it('F12 (G7): a claim at 150 publishes of the UTC day approves and writes no marker', () => {
    writeRefresh(refreshDoc());
    fs.mkdirSync(path.join(pendingDir, 'budget'));
    fs.writeFileSync(
      path.join(pendingDir, 'budget', 'bbbbbbbb-0000-4000-8000-000000000002.json'),
      JSON.stringify({ day: iso(NOW).slice(0, 10), n: 150 }),
    );
    batch();
    expect(gate.stopGate(payload(), baseEnv(), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(pendingDir, 'sess-1.json'), 'utf8')).stopBlocked).toBeUndefined();
  });

  it('F3: a headless run gets no line and no marker', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(gate.stopGate(payload(), baseEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F3: stop_hook_active gets no line and no marker', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(gate.stopGate(payload('sess-1', { stop_hook_active: true }), baseEnv(), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F3: no session id gets no line and no marker', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(gate.stopGate({ hook_event_name: 'Stop' }, baseEnv(), NOW).output).toBeNull();
    expect(fs.existsSync(marker())).toBe(false);
  });
});

describe('time in America/Chicago', () => {
  const lineFor = (exportedAt: string): string => {
    writeRefresh(refreshDoc({ key: exportedAt, exported_at: exportedAt }));
    batch();
    // now is 2 h after the export so the export is neither old nor in the future
    return reasonOf(gate.stopGate(payload(), baseEnv(), Date.parse(exportedAt) + 2 * HOUR));
  };

  it('F11: a winter export reads CST', () => {
    expect(lineFor('2026-01-15T20:53:03.233Z')).toContain('(exported Jan 15, 2:53 PM CST, not uploaded)');
  });

  it('F11: a summer export reads CDT', () => {
    expect(lineFor('2026-07-15T20:53:03.233Z')).toContain('(exported Jul 15, 3:53 PM CDT, not uploaded)');
  });

  it('F11: either side of the spring change (2026-03-08, 2 AM local)', () => {
    expect(lineFor('2026-03-08T07:59:00.000Z')).toContain('(exported Mar 8, 1:59 AM CST, not uploaded)');
    fs.rmSync(marker(), { force: true });
    expect(lineFor('2026-03-08T08:01:00.000Z')).toContain('(exported Mar 8, 3:01 AM CDT, not uploaded)');
  });

  it('F11: either side of the autumn change (2026-11-01, 2 AM local)', () => {
    expect(lineFor('2026-11-01T06:30:00.000Z')).toContain('(exported Nov 1, 1:30 AM CDT, not uploaded)');
    fs.rmSync(marker(), { force: true });
    expect(lineFor('2026-11-01T07:30:00.000Z')).toContain('(exported Nov 1, 1:30 AM CST, not uploaded)');
  });

  it('F11: a midnight hour reads 12, not 0', () => {
    expect(lineFor('2026-01-15T06:05:00.000Z')).toContain('(exported Jan 15, 12:05 AM CST, not uploaded)');
  });
});

const canSymlink = ((): boolean => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'symprobe-'));
  try {
    fs.writeFileSync(path.join(d, 'a'), 'x');
    fs.symlinkSync(path.join(d, 'a'), path.join(d, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

describe('hardening', () => {
  const BIG = 70_000; // over the 65536 byte limit

  it('F13: an oversized refresh.json says nothing and writes no marker', () => {
    const at = iso(NOW - 2 * HOUR);
    writeRefresh(JSON.stringify({ pending: true, key: at, exported_at: at, pad: 'x'.repeat(BIG) }));
    batch();
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F13: a refresh.json just under the limit still works', () => {
    const at = iso(NOW - 2 * HOUR);
    const body = { pending: true, key: at, exported_at: at, pad: '' };
    body.pad = 'x'.repeat(65_000 - JSON.stringify(body).length);
    writeRefresh(JSON.stringify(body));
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW))).toMatch(STALE);
  });

  it('F13: an oversized marker counts as no marker, so the line shows and the marker is replaced by a small one', () => {
    const doc = refreshDoc();
    writeRefresh(doc);
    fs.writeFileSync(marker(), JSON.stringify({ key: doc.key, shown_at: iso(NOW), pad: 'x'.repeat(BIG) }));
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW + MIN))).toMatch(STALE);
    expect(fs.statSync(marker()).size).toBeLessThan(500);
  });

  it('F14: no .tmp file is left after a good write', () => {
    writeRefresh(refreshDoc());
    batch();
    expect(reasonOf(gate.stopGate(payload(), baseEnv(), NOW))).toMatch(STALE);
    expect(fs.readdirSync(dashDir).sort()).toEqual(['.refresh-shown.json', 'refresh.json']);
  });

  it('F14: no .tmp file is left after a failed write', () => {
    writeRefresh(refreshDoc());
    fs.mkdirSync(marker()); // the rename onto a directory fails
    batch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    gate.stopGate(payload(), baseEnv(), NOW);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dashDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('F15: a headless opt-in still blocks for the board but gets no line and leaves the marker alone', () => {
    writeRefresh(refreshDoc());
    batch();
    const r = gate.stopGate(payload(), baseEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', LANE_CONTEXT_HEADLESS: '1' }), NOW);
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('F16: a marker write failure writes nothing to stderr; the block still fires without the line', () => {
    writeRefresh(refreshDoc());
    fs.mkdirSync(marker());
    batch();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    const errCalls = errSpy.mock.calls.length;
    const stderrCalls = stderrSpy.mock.calls.length;
    vi.restoreAllMocks();
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(errCalls).toBe(0);
    expect(stderrCalls).toBe(0);
  });

  it('F16: a good write logs nothing to stderr', () => {
    writeRefresh(refreshDoc());
    batch();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gate.stopGate(payload(), baseEnv(), NOW);
    const n = spy.mock.calls.length;
    vi.restoreAllMocks();
    expect(n).toBe(0);
  });

  it.skipIf(!canSymlink)('F17: a marker that is a symlink is not followed; the line is dropped and the target is unchanged', () => {
    writeRefresh(refreshDoc());
    const target = path.join(tmp, 'victim.txt');
    fs.writeFileSync(target, 'keep me');
    fs.symlinkSync(target, marker());
    batch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = gate.stopGate(payload(), baseEnv(), NOW);
    vi.restoreAllMocks();
    expect(r.output).toMatchObject({ decision: 'block' });
    expect(reasonOf(r)).not.toMatch(STALE);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(marker()).isSymbolicLink()).toBe(true);
  });
});
