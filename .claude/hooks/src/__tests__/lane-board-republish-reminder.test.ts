/**
 * lane-board-republish-reminder: ways the decision can fail, one test each.
 *
 *  1. Nags on every note, not once per batch      -> pending=true must be silent
 *  2. Misses a state-changing verb                -> each listed verb must fire
 *  3. Fires on a read-only verb                   -> board/next/inbox/list/show stay silent
 *  4. Fires on a dry run                          -> --dry-run stays silent
 *  5. Fires on a failed command                   -> is_error / non-zero exit / failure event
 *  6. Never clears after a republish              -> Artifact to the board url (or lane-board.html) clears
 *  7. Clears on an unrelated artifact             -> another url must not clear
 *  8. Fires on text that only names lane.mjs      -> echo/quoted text, or no lane.mjs at all
 *  9. Crashes or speaks on a bad payload          -> malformed input gives 'none'
 * 10. Registered on a tool the runtime rejects    -> Bash, PowerShell and Artifact all accepted
 *
 * Publish budget (lane board-publish-budget, spec .claudedocs/e2e-board-publish-budget/spec.md). One test per id:
 *   R1  say gives a publish reminder, or writes no pending file
 *   R2  note the same
 *   R3  claim still tells the session to publish now, or does not name the Stop gate
 *   R4  an Artifact read of the board url clears the pending file
 *   R5  an accepted publish of the board page does not clear, or does not set pages[id] and n
 *   R6  an asset upload clears the pending file, sets pages[id], or is counted
 *   R7  a publish to another url is not counted, or clears the pending file
 *   R8  a failed publish counts or clears (KEEP)
 *   R9  a new UTC day keeps yesterday's n, or drops pages
 *   R10 a session id that is not a uuid writes a budget file (KEEP)
 *   R11 a corrupt budget file stops the count, or throws
 *   R12 a budget folder that cannot be made throws or changes the pending behaviour (KEEP)
 * KEEP = the test passes on main too: it pins behaviour the change must not lose.
 * decide(payload, pending): `pending` now means "the board's pending file already holds an ask verb".
 *
 * Review fixes. PIN = a test gap: the test is green on correct code and red under the named change.
 *   F9  PIN the count goes into the UTC day: red with the local date (in a time zone 2 hours or more from UTC)
 *   F12 PIN only tool_name `Artifact` counts: red when `ArtifactData` passes the tool test
 *   F13 PIN pages[id] needs no pending file of the session; action null is a publish
 * F2 and F3 (the reminder's askAt for an old-shape file, the rename retry) are in lane-board-stop-gate.test.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decide, handle } from '../lane-board-republish-reminder.js';
import { boardArtifact, renderBoardCmd } from '../shared/lane-board.js';

const BOARD_ARTIFACT_URL = boardArtifact('continuous-claude')?.url as string;
const RENDER_COMMAND = renderBoardCmd('continuous-claude');

// Hermetic board: a temp registry whose continuous-claude root covers the test cwd, so decide() resolves a
// board without reading the real ~/.claude/project-registry.json. decide() never spawns a render.
let tmpRoot = '';
const savedEnv = { reg: process.env.LANE_REGISTRY_PATH, ep: process.env.CLAUDE_CODE_ENTRYPOINT };
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-'));
  fs.writeFileSync(path.join(tmpRoot, 'registry.json'), JSON.stringify({ projects: [
    { name: 'CCv3', key: 'continuous-claude', path: process.cwd(), status: 'active' },
  ] }));
  process.env.LANE_REGISTRY_PATH = path.join(tmpRoot, 'registry.json');
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
});
afterEach(() => {
  if (savedEnv.reg === undefined) delete process.env.LANE_REGISTRY_PATH; else process.env.LANE_REGISTRY_PATH = savedEnv.reg;
  if (savedEnv.ep === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = savedEnv.ep;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false },
  ...extra,
});

describe('lane change fires once per batch', () => {
  it('R3: reminds on the first claim; the text names the Stop gate and holds no publish steps', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs claim x'), false);
    expect(d.action).toBe('remind');
    expect(d.verb).toBe('claim');
    expect(d.message).toContain('out of date');
    expect(d.message).toContain('Stop gate');
    expect(d.message).not.toContain(RENDER_COMMAND);
    expect(d.message).not.toContain(BOARD_ARTIFACT_URL);
  });

  it('R2: a note is a lane change with no reminder text, on the first change too', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs note x "working on it"'), false);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('note');
    expect(d.message).toBeUndefined();
  });

  it('R1: a say is a lane change with no reminder text, on the first change too', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs say "hello all"'), false);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('say');
    expect(d.message).toBeUndefined();
  });

  it('stays silent but keeps tracking while the session is already pending', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs note x "again"'), true);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('note');
    expect(d.message).toBeUndefined();
  });

  it('(KEEP) a second ask verb in the same batch stays silent', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs release x'), true);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('release');
    expect(d.message).toBeUndefined();
  });

  it.each(['claim', 'release', 'done'])('the %s verb is a lane change that asks for a publish', (verb) => {
    expect(decide(bash(`node scripts/coordination/lane.mjs ${verb} a b`), false).action).toBe('remind');
  });

  it.each(['note', 'say', 'add', 'apply-kanban', 'adopt'])('the %s verb is a lane change that does not ask', (verb) => {
    const d = decide(bash(`node scripts/coordination/lane.mjs ${verb} a b`), false);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe(verb);
    expect(d.message).toBeUndefined();
  });

  it('accepts an absolute Windows path, a quoted path and a PowerShell call', () => {
    const cmds = [
      'node C:\\Users\\dkhay\\continuous-claude\\scripts\\coordination\\lane.mjs done lane-1',
      'node "C:\\Users\\dkhay\\continuous-claude\\scripts\\coordination\\lane.mjs" claim lane-1',
      'cd /c/repo && node ./scripts/coordination/lane.mjs release lane-1',
    ];
    for (const c of cmds) expect(decide(bash(c), false).action).toBe('remind');
    const ps = { ...bash('node scripts/coordination/lane.mjs claim x'), tool_name: 'PowerShell' };
    expect(decide(ps, false).action).toBe('remind');
  });
});

describe('park and the flag forms of state, release and done are lane changes', () => {
  it('a park command line reminds, with the verb park', () => {
    const d = decide(bash('node scripts/coordination/lane.mjs park re-program --for 24h --reason "seat away"'), false);
    expect(d.action).toBe('remind');
    expect(d.verb).toBe('park');
    expect(decide(bash('node scripts/coordination/lane.mjs park re-program --until 2026-11-12 --reason "x"'), true).action).toBe('mark');
  });

  it.each([
    'release L1 --blocked',
    'release --blocked L1',
    'done L1 --merged "PR 1"',
    'done L1 --no-pr --evidence "x"',
  ])('%s is still a lane change that asks for a publish', (rest) => {
    expect(decide(bash(`node scripts/coordination/lane.mjs ${rest}`), false).action).toBe('remind');
  });

  it.each([
    'state L1 active --reason "why now"',
    'state L1 active --override --reason "x"',
    'state L1 active --if-state ready',
  ])('%s is still a lane change (state does not ask for a publish)', (rest) => {
    const d = decide(bash(`node scripts/coordination/lane.mjs ${rest}`), false);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('state');
  });
});

describe('commands that must not fire', () => {
  it.each(['board', 'next', 'inbox', 'list', 'show', 'peers', 'mine'])('read-only verb %s', (verb) => {
    expect(decide(bash(`node scripts/coordination/lane.mjs ${verb}`), false).action).toBe('none');
  });

  it('--dry-run on a changing verb', () => {
    expect(decide(bash('node scripts/coordination/lane.mjs apply-kanban --dry-run board.json'), false).action).toBe('none');
    expect(decide(bash('node scripts/coordination/lane.mjs apply-kanban board.json --dry-run'), false).action).toBe('none');
  });

  it('a real change next to a dry run in another command still fires', () => {
    const c = 'node scripts/coordination/lane.mjs apply-kanban --dry-run f.json && node scripts/coordination/lane.mjs note x "y"';
    const d = decide(bash(c), false);
    expect(d.action).toBe('mark');
    expect(d.verb).toBe('note');
    const c2 = 'node scripts/coordination/lane.mjs apply-kanban --dry-run f.json && node scripts/coordination/lane.mjs claim x';
    expect(decide(bash(c2), false).action).toBe('remind');
  });

  it('an unrelated command, or one without lane.mjs', () => {
    expect(decide(bash('git status'), false).action).toBe('none');
    expect(decide(bash('node scripts/other.mjs note x'), false).action).toBe('none');
    expect(decide(bash('echo done'), false).action).toBe('none');
  });

  it('quoted text that only names lane.mjs', () => {
    expect(decide(bash('git commit -m "docs: run node scripts/coordination/lane.mjs done when finished"'), false).action).toBe('none');
    expect(decide(bash('echo node scripts/coordination/lane.mjs done'), false).action).toBe('none');
  });

  it('other tools', () => {
    expect(decide({ ...bash('node scripts/coordination/lane.mjs note x y'), tool_name: 'Edit' }, false).action).toBe('none');
    expect(decide({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: 'lane-board.html' } }, true).action).toBe('none');
  });
});

describe('failed tool response never fires', () => {
  const note = 'node scripts/coordination/lane.mjs note x "y"';
  it('is_error true', () => {
    expect(decide(bash(note, { tool_response: { is_error: true } }), false).action).toBe('none');
  });
  it('non-zero exit code in the response', () => {
    expect(decide(bash(note, { tool_response: { exit_code: 1 } }), false).action).toBe('none');
  });
  it('a PostToolUseFailure event', () => {
    expect(decide(bash(note, { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' }), false).action).toBe('none');
  });
  it('a zero exit code still fires', () => {
    expect(decide(bash(note, { tool_response: { exit_code: 0 } }), false).action).toBe('mark');
    const claim = 'node scripts/coordination/lane.mjs claim x';
    expect(decide(bash(claim, { tool_response: { exit_code: 0 } }), false).action).toBe('remind');
  });
});

describe('republish clears pending', () => {
  const artifact = (tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Artifact',
    tool_input,
    tool_response: { ok: true },
    ...extra,
  });

  it('a publish to the board url clears', () => {
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL, file_path: 'x.html' }), true).action).toBe('clear');
  });

  it('a publish of lane-board.html clears, even from a Windows path', () => {
    expect(decide(artifact({ file_path: 'C:\\repo\\lane-board.html' }), true).action).toBe('clear');
    expect(decide(artifact({ file_path: '/repo/lane-board.html' }), true).action).toBe('clear');
  });

  it('a publish to another artifact does not clear', () => {
    expect(decide(artifact({ url: 'https://claude.ai/artifact/someOtherId', file_path: 'other.html' }), true).action).toBe('none');
  });

  it('a failed publish does not clear', () => {
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL }, { tool_response: { is_error: true } }), true).action).toBe('none');
  });

  it('after the clear, the next ask verb reminds again', () => {
    const claim = bash('node scripts/coordination/lane.mjs claim x');
    expect(decide(claim, false).action).toBe('remind');
    expect(decide(claim, true).action).toBe('mark');
    expect(decide(artifact({ url: BOARD_ARTIFACT_URL }), true).action).toBe('clear');
    expect(decide(claim, false).action).toBe('remind');
  });

  it('R4: a read, list, open, pin or delete of the board url does not clear; a publish action does', () => {
    for (const action of ['read', 'list', 'open', 'pin', 'delete']) {
      expect(decide(artifact({ action, url: BOARD_ARTIFACT_URL }), true).action).toBe('none');
    }
    expect(decide(artifact({ action: 'publish', url: BOARD_ARTIFACT_URL, file_path: 'x.html' }), true).action).toBe('clear');
  });

  it('R6: an asset upload to the board url does not clear', () => {
    const input = { action: 'publish', url: BOARD_ARTIFACT_URL, asset: true, file_path: 'C:\\shots\\board.png' };
    expect(decide(artifact(input), true).action).toBe('none');
  });
});

describe('ask verbs and the publish budget (handle, against a temp pending dir)', () => {
  const NOW = Date.UTC(2026, 10, 12, 15, 0, 0); // fixed clock, mid-day UTC
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const TODAY = '2026-11-12';
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const CCV3_ID = 'RtrTNVfAq9uowmb2tfbzid';
  const CCV3_URL = `https://claude.ai/artifact/${CCV3_ID}`;
  const PH_ID = 'KaD7X6HnLKHKjzz7cecUVF';
  const PH_URL = `https://claude.ai/artifact/${PH_ID}`;
  const OTHER_URL = 'https://claude.ai/artifact/Vnf8urTCv7awKXwNT423F8';
  /** What the Artifact tool answers for an accepted page publish, and for an accepted asset upload. */
  const ACCEPTED = { url: CCV3_URL, path: 'index.html', artifact_id: 'a1', title: 'Lane board', version: 12, stored: true };
  const ASSET_OK = { written: true, owned: true, asset_upload: { id: '0123456789abcdef0123456789abcdef' } };

  let tmp = '';
  let dir = '';
  let cwd = '';
  let env: Record<string, string>;
  const spawn = vi.fn();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-budget-'));
    dir = path.join(tmp, 'pending');
    cwd = path.join(tmp, 'ccv3');
    const home = path.join(tmp, 'home');
    for (const d of [cwd, path.join(home, 'continuous-claude', '.claude')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: cwd, status: 'active' },
      { name: 'PH', key: 'ph-board', path: path.join(tmp, 'ph'), status: 'active', laneArtifact: PH_URL },
    ] }));
    fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
      { id: 'agentic-os-lane-board', url: CCV3_URL, publish_from: 'lane-board.html' },
    ] }));
    // Every handle() call gets this env: a temp pending dir and no auto-render. Never the default env.
    env = {
      LANE_REGISTRY_PATH: path.join(tmp, 'registry.json'),
      LANE_BOARD_PENDING_DIR: dir,
      CCV3_USER_HOME: home,
      LANE_RENDER_SCRIPT: path.join(tmp, 'render-board.mjs'),
      LANE_BOARD_AUTORENDER: '0',
    };
    spawn.mockClear();
  });
  afterEach(() => {
    expect(spawn).not.toHaveBeenCalled();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const lane = (rest: string, now: number = NOW, sid: string = SID) =>
    handle(bash(`node lane.mjs ${rest}`, { session_id: sid, cwd }), env, { spawn: spawn as never, now });
  const artifact = (tool_input: Record<string, unknown>, now: number = NOW, extra: Record<string, unknown> = {}) =>
    handle(
      { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Artifact', cwd, tool_input, tool_response: ACCEPTED, ...extra },
      env,
      { spawn: spawn as never, now },
    );
  const textOf = (r: { output: object | null }): string =>
    (r.output as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? '';
  const pendFile = (sid: string = SID, board?: string): string => path.join(dir, board ? `${sid}@${board}.json` : `${sid}.json`);
  const readPend = (sid: string = SID, board?: string) => JSON.parse(fs.readFileSync(pendFile(sid, board), 'utf8'));
  const budgetDir = (): string => path.join(dir, 'budget');
  const budgetFile = (sid: string = SID): string => path.join(budgetDir(), `${sid}.json`);
  /** The budget file of a session, or null when it is missing or not JSON. */
  const readBudget = (sid: string = SID): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(budgetFile(sid), 'utf8'));
    } catch {
      return null;
    }
  };
  const writeBudget = (body: object | string, sid: string = SID): void => {
    fs.mkdirSync(budgetDir(), { recursive: true });
    fs.writeFileSync(budgetFile(sid), typeof body === 'string' ? body : JSON.stringify(body));
  };

  // ---- lane changes ----

  it('R1: say gives no publish reminder and still writes the pending file with the verb', () => {
    const r = lane('say "hello all"');
    expect(r.output).toBeNull();
    expect(readPend()).toMatchObject({ verbs: ['say'], board: 'continuous-claude' });
  });

  it('R2: note gives no publish reminder and still writes the pending file with the verb', () => {
    const r = lane('note x "working on it"');
    expect(r.output).toBeNull();
    expect(readPend()).toMatchObject({ verbs: ['note'], board: 'continuous-claude' });
  });

  it.each(['add x --title t', 'state x active', 'adopt x', 'apply-kanban board.json'])(
    'R2: `%s` marks the change, says nothing and sets no askAt',
    (rest) => {
      const r = lane(rest);
      expect(r.output).toBeNull();
      expect(readPend().verbs).toEqual([rest.split(' ')[0]]);
      expect(readPend().askAt).toBeUndefined();
    },
  );

  it('R3: claim writes the pending file; the text names the Stop gate and does not say publish now', () => {
    const r = lane('claim x');
    expect(readPend()).toMatchObject({ verbs: ['claim'], board: 'continuous-claude' });
    const text = textOf(r);
    expect(text).toContain('out of date');
    expect(text).toContain('Stop gate');
    expect(text).toContain('kanban-sync step 7');
    expect(text).toContain('milestone');
    expect(text).not.toContain(renderBoardCmd('continuous-claude', env));
    expect(text).not.toContain(CCV3_URL);
    expect(text).not.toMatch(/at once publish|action read/);
  });

  it.each(['claim x', 'release x', 'done x', 'park x --for 24h --reason "away"'])(
    'R3: the ask verb in `%s` reminds and writes askAt = now',
    (rest) => {
      const r = lane(rest, NOW);
      expect(textOf(r)).toContain('Stop gate');
      expect(readPend().askAt).toBe(NOW);
    },
  );

  it('R3: a claim after a say in the same batch still gives the reminder; a second ask verb is silent', () => {
    expect(lane('say "hi"', NOW).output).toBeNull();
    expect(textOf(lane('claim x', NOW + MIN))).toContain('Stop gate');
    expect(lane('release x', NOW + 2 * MIN).output).toBeNull();
    expect(readPend().verbs).toEqual(['say', 'claim', 'release']);
  });

  it('an ask verb sets askAt and drops stopBlocked; any other verb keeps both', () => {
    lane('claim x', NOW);
    expect(readPend().askAt).toBe(NOW);
    fs.writeFileSync(pendFile(), JSON.stringify({ ...readPend(), stopBlocked: true })); // the Stop gate asked
    lane('say "hi"', NOW + MIN);
    lane('note x "y"', NOW + 2 * MIN);
    expect(readPend()).toMatchObject({ verbs: ['claim', 'say', 'note'], askAt: NOW, stopBlocked: true });
    lane('done x', NOW + 3 * MIN);
    expect(readPend().askAt).toBe(NOW + 3 * MIN);
    expect(readPend().stopBlocked).toBeUndefined();
  });

  // ---- Artifact calls ----

  it('R4: an Artifact read, list, open, pin or delete of the board url does not clear the pending file and is not counted', () => {
    lane('claim x', NOW - MIN);
    for (const action of ['read', 'list', 'open', 'pin', 'delete']) {
      expect(artifact({ action, url: CCV3_URL }, NOW, { tool_response: { read: true, owned: true } }).output).toBeNull();
    }
    expect(fs.existsSync(pendFile())).toBe(true);
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toBeNull();
  });

  it('R5: an accepted publish of the board page clears the pending file and sets pages[id] = now and n = 1', () => {
    lane('claim x', NOW - MIN);
    const r = artifact({ file_path: 'C:\\Users\\x\\continuous-claude\\lane-board.html', url: CCV3_URL }, NOW);
    expect(r.output).toBeNull();
    expect(fs.existsSync(pendFile())).toBe(false);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1, pages: { [CCV3_ID]: NOW } });
    expect(fs.readdirSync(budgetDir())).toEqual([`${SID}.json`]); // written through a .tmp file, none left
    // the same call with action publish, one minute later
    artifact({ action: 'publish', file_path: '/r/lane-board.html', url: CCV3_URL }, NOW + MIN);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 2, pages: { [CCV3_ID]: NOW + MIN } });
  });

  it('R5: a publish of another board\'s page clears that board\'s file and stamps that page id only', () => {
    lane('--project ph-board claim x', NOW - MIN);
    lane('claim x', NOW - MIN);
    artifact({ action: 'publish', file_path: '/r/lane-board-ph-board.html', url: PH_URL }, NOW);
    expect(fs.existsSync(pendFile(SID, 'ph-board'))).toBe(false);
    expect(fs.existsSync(pendFile())).toBe(true);
    const b = readBudget();
    expect(b).toMatchObject({ n: 1, pages: { [PH_ID]: NOW } });
    expect(b?.pages?.[CCV3_ID]).toBeUndefined();
  });

  it('R5: a publish of lane-board.html with no url (a new artifact) clears as today, counts, and sets no pages stamp', () => {
    lane('claim x', NOW - MIN);
    artifact({ file_path: 'C:\\r\\lane-board.html' }, NOW);
    expect(fs.existsSync(pendFile())).toBe(false);
    const b = readBudget();
    expect(b).toMatchObject({ day: TODAY, n: 1 });
    expect(b?.pages?.[CCV3_ID]).toBeUndefined();
  });

  it('R6: an accepted asset upload is not counted, sets no pages stamp and keeps the pending file', () => {
    lane('claim x', NOW - MIN);
    artifact({ action: 'publish', url: CCV3_URL, asset: true, file_path: 'C:\\shots\\board.png' }, NOW, { tool_response: ASSET_OK });
    expect(fs.existsSync(pendFile())).toBe(true);
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toBeNull();
    artifact({ action: 'publish', url: OTHER_URL, asset: true, file_path: 'C:\\shots\\other.png' }, NOW + MIN, { tool_response: ASSET_OK });
    expect(readBudget()).toBeNull();
    // a page publish after the uploads is the first count
    artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, NOW + 2 * MIN);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1 });
    expect(Object.keys(readBudget()?.pages ?? {})).toEqual([]);
  });

  it('ruling S2: a new pending file gets the shape marker; a rewrite of an old-shape file adds none', () => {
    lane('say "hi"', NOW);
    expect(readPend().v).toBe(2);
    lane('note x "y"', NOW + MIN);
    expect(readPend()).toMatchObject({ verbs: ['say', 'note'], v: 2 });
    fs.writeFileSync(pendFile(), JSON.stringify({ since: 'x', verbs: ['note'], board: 'continuous-claude' })); // old shape
    lane('say "again"', NOW + 2 * MIN);
    expect(readPend().verbs).toEqual(['note', 'say']);
    expect(readPend().v).toBeUndefined();
    lane('claim x', NOW + 3 * MIN); // an ask verb does not make an old-shape file new
    expect(readPend()).toMatchObject({ verbs: ['note', 'say', 'claim'], askAt: NOW + 3 * MIN });
    expect(readPend().v).toBeUndefined();
  });

  it.each([
    'note x "y"; node lane.mjs done x',
    'say "hi" && node lane.mjs claim x',
    'note x "y"\nnode lane.mjs park x --for 24h --reason "away"',
  ])('C5: an ask verb after another verb in one command is not lost: `%s`', (rest) => {
    const r = lane(rest, NOW);
    expect(textOf(r)).toContain('Stop gate');
    expect(readPend().askAt).toBe(NOW);
    expect(readPend().verbs).toHaveLength(1);
    expect(['done', 'claim', 'park']).toContain(readPend().verbs[0]);
  });

  it('C5: two verbs that do not ask in one command still mark the first one', () => {
    expect(lane('note x "y"; node lane.mjs say "hi"', NOW).output).toBeNull();
    expect(readPend().verbs).toEqual(['note']);
  });

  it('ruling S3: each sentence of the reminder has at most 20 words', () => {
    const text = textOf(lane('claim x'));
    expect(text).toContain('Do not publish before it asks.');
    for (const s of text.split(/\.\s+/)) expect(s.trim().split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  it('R7: an accepted publish to a url that is not a board page counts and keeps the pending file', () => {
    lane('claim x', NOW - MIN);
    artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, NOW);
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1 });
    artifact({ file_path: 'C:\\r\\new-page.html' }, NOW + MIN); // no url: a new artifact
    expect(readBudget()).toMatchObject({ day: TODAY, n: 2 });
    expect(Object.keys(readBudget()?.pages ?? {})).toEqual([]);
    expect(readPend().verbs).toEqual(['claim']);
  });

  it('R7: with no pending file at all, a publish is still counted', () => {
    artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, NOW);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1 });
  });

  it('R8 (KEEP): a failed publish is not counted and keeps the pending file', () => {
    lane('claim x', NOW - MIN);
    const input = { file_path: 'C:\\r\\lane-board.html', url: CCV3_URL };
    const refusal = 'publish 429: daily publish limit for your plan reached (200)';
    artifact(input, NOW, { hook_event_name: 'PostToolUseFailure', tool_response: undefined, error: refusal });
    artifact(input, NOW, { tool_response: { is_error: true, content: `Error: ${refusal}` } });
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toBeNull();
  });

  it('R9: a new UTC day restarts n at 1 and clears limit; pages and asked are kept', () => {
    const pages = { [CCV3_ID]: NOW - 20 * HOUR, SomeOtherPage: NOW - 30 * HOUR };
    const asked = { [CCV3_ID]: NOW - 19 * HOUR };
    writeBudget({ day: '2026-11-11', n: 7, limit: true, pages, asked });
    artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, NOW);
    const b = readBudget();
    expect(b).toMatchObject({ day: TODAY, n: 1, pages, asked });
    expect(b?.limit).not.toBe(true);
  });

  it('R9: the same UTC day adds 1 to n and keeps the asked stamps the gate wrote', () => {
    const asked = { [CCV3_ID]: NOW - 30 * MIN };
    writeBudget({ day: TODAY, n: 7, pages: {}, asked });
    artifact({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 8, pages: { [CCV3_ID]: NOW }, asked });
  });

  it('R10 (KEEP): a session id that is not a uuid writes no budget file; the pending file works as today', () => {
    for (const sid of ['s1', '../evil', 'aaaaaaaa-0000-4000-8000-00000000000Z']) {
      const publish = (tool_input: Record<string, unknown>) => handle(
        { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Artifact', cwd, tool_input, tool_response: ACCEPTED },
        env,
        { spawn: spawn as never, now: NOW },
      );
      expect(lane('claim x', NOW - MIN, sid).output).not.toBeNull();
      expect(fs.readdirSync(dir).filter((n) => !n.startsWith('.'))).toHaveLength(1);
      publish({ file_path: 'C:\\r\\report.html', url: OTHER_URL });
      expect(fs.readdirSync(dir).filter((n) => !n.startsWith('.'))).toHaveLength(1);
      publish({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL });
      expect(fs.readdirSync(dir).filter((n) => !n.startsWith('.'))).toEqual([]);
    }
    expect(fs.existsSync(budgetDir())).toBe(false);
    expect(fs.readdirSync(tmp).sort()).toEqual(['ccv3', 'home', 'pending', 'registry.json']); // nothing written beside the pending dir
  });

  it('R11: a corrupt budget file is rewritten; no throw, and the output is as normal', () => {
    writeBudget('{oops');
    lane('claim x', NOW - MIN);
    let r: { output: object | null } = { output: {} };
    expect(() => { r = artifact({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW); }).not.toThrow();
    expect(r.output).toBeNull();
    expect(fs.existsSync(pendFile())).toBe(false);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1, pages: { [CCV3_ID]: NOW } });
  });

  it('R11: a budget file that parses but holds bad values is rewritten with a clean count', () => {
    writeBudget({ day: TODAY, n: 'many', pages: 'x', asked: [1] });
    artifact({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1, pages: { [CCV3_ID]: NOW } });
  });

  it('R12 (KEEP): the budget folder cannot be made (a file is in its place): no throw, pending behaviour as today', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(budgetDir(), 'not a folder');
    expect(lane('claim x', NOW - MIN).output).not.toBeNull();
    expect(readPend().verbs).toEqual(['claim']);
    expect(() => artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, NOW)).not.toThrow();
    expect(readPend().verbs).toEqual(['claim']);
    expect(() => artifact({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW)).not.toThrow();
    expect(fs.existsSync(pendFile())).toBe(false);
    expect(fs.readFileSync(budgetDir(), 'utf8')).toBe('not a folder');
  });

  it('(KEEP) an ArtifactData call writes no budget file and clears nothing', () => {
    lane('claim x', NOW - MIN);
    const r = handle(
      { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'ArtifactData', cwd, tool_input: { action: 'set', url: CCV3_URL, collection: 'c', doc_id: 'd' }, tool_response: { ok: true } },
      env,
      { spawn: spawn as never, now: NOW },
    );
    expect(r.output).toBeNull();
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toBeNull();
  });

  // ---- review fixes (PIN = a test gap: green on correct code, red under the named change) ----

  it.each([
    ['no action', {}],
    ['action publish', { action: 'publish' }],
  ])('F12 (KEEP, PIN): an ArtifactData call with %s is not a publish: no budget file, nothing cleared', (_name, extra) => {
    // Red when the tool test accepts any name that starts with `Artifact`.
    lane('claim x', NOW - MIN);
    const r = handle(
      { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'ArtifactData', cwd, tool_input: { ...extra, url: CCV3_URL, file_path: 'C:\\r\\lane-board.html' }, tool_response: ACCEPTED },
      env,
      { spawn: spawn as never, now: NOW },
    );
    expect(r.output).toBeNull();
    expect(readPend().verbs).toEqual(['claim']);
    expect(readBudget()).toBeNull();
  });

  it('F13 (PIN): a publish of a board page by a session with no pending file for that board still sets pages[id]', () => {
    // The publish that follows a foreign ask. Red when the stamp needs a pending file of the session.
    artifact({ action: 'publish', file_path: '/r/lane-board-ph-board.html', url: PH_URL }, NOW);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1, pages: { [PH_ID]: NOW } });
    artifact({ file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW + MIN);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 2, pages: { [PH_ID]: NOW, [CCV3_ID]: NOW + MIN } });
    expect(fs.readdirSync(dir)).toEqual(['budget']);
  });

  it('F13 (PIN): action null is "no action": the call is a publish, it counts and it clears', () => {
    lane('claim x', NOW - MIN);
    artifact({ action: null, file_path: 'C:\\r\\lane-board.html', url: CCV3_URL }, NOW);
    expect(fs.existsSync(pendFile())).toBe(false);
    expect(readBudget()).toMatchObject({ day: TODAY, n: 1, pages: { [CCV3_ID]: NOW } });
  });

  it.each([
    // clock, the UTC date. A local date would give the other day in a zone on the far side of midnight.
    ['02:00Z (20:00 Central of the day before)', Date.UTC(2026, 10, 13, 2, 0, 0), '2026-11-13'],
    ['22:00Z (the next day east of UTC+2)', Date.UTC(2026, 10, 12, 22, 0, 0), '2026-11-12'],
  ])('F9 (PIN): a publish at %s is counted in the UTC day', (_name, at, utc) => {
    artifact({ file_path: 'C:\\r\\report.html', url: OTHER_URL }, at);
    expect(readBudget()).toMatchObject({ day: utc, n: 1 });
  });
});

describe('malformed payloads', () => {
  it.each([
    ['null', null],
    ['string', 'x'],
    ['empty object', {}],
    ['no tool_input', { tool_name: 'Bash', session_id: 's' }],
    ['command is a number', { tool_name: 'Bash', session_id: 's', tool_input: { command: 5 } }],
    ['tool_input is a string', { tool_name: 'Artifact', session_id: 's', tool_input: 'x' }],
    ['url is an object', { tool_name: 'Artifact', session_id: 's', tool_input: { url: {} } }],
  ])('%s gives none', (_name, payload) => {
    expect(decide(payload, false).action).toBe('none');
    expect(decide(payload, true).action).toBe('none');
  });

  it('a lane change without a session id gives none (no state key)', () => {
    const p = { tool_name: 'Bash', tool_input: { command: 'node scripts/coordination/lane.mjs note x y' } };
    expect(decide(p, false).action).toBe('none');
  });
});
