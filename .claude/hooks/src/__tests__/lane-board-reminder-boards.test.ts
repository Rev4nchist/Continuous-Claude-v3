/**
 * lane-board-republish-reminder: boards, pending names and auto-render (PR2).
 *
 * Failure list, one test (or group) each:
 *   R1  a global flag before the verb (--project x, --as id, --json) hides the verb; a value is read as the verb
 *   R2  a CCv3 change does not write <sid>.json, or does not spawn the render
 *   R3  another board shares <sid>.json with CCv3 (one board's publish clears the other's batch)
 *   R4  a board with no phone page writes a pending file (the Stop gate would block on a page nobody can publish)
 *   R5  every change spawns a render (N sessions, N renders); or the debounce is global, not per board
 *   R6  the seams LANE_BOARD_AUTORENDER and LANE_RENDER_SCRIPT are missing; the default is a relative path
 *   R7  a failed or read-only command renders
 *   R8  a publish clears the wrong board's file, or none
 *   R12 a board's page is its registry laneArtifact: its change writes <sid>@<board>.json; a publish clears that
 *       file only on a url-id match, never by file name; a publish to another board's url clears the other file
 *
 * Every handle() call gets an explicit env with LANE_RENDER_SCRIPT set and a spy for spawn: the default render
 * script on main (before PR2 merges) takes --project as an output file name.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELAYED_RENDER_SRC, RENDER_DEBOUNCE_MS, boardPageFile, handle, laneChange, ownedLaneBoard } from '../lane-board-republish-reminder.js';
import { renderBoardCmd } from '../shared/lane-board.js';
import { listPending, pendingFile } from '../shared/lane-board-pending.js';

const PH_URL = 'https://claude.ai/artifact/KaD7X6HnLKHKjzz7cecUVF';
const GM_URL = 'https://claude.ai/artifact/UcUbP216jcKLNQLb18TL7Y';

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false },
  ...extra,
});

describe('R1: the verb is found after global flags', () => {
  it.each([
    ['node lane.mjs --project zz claim x', 'claim'],
    ['node lane.mjs --as abc-1 note x "y"', 'note'],
    ['node lane.mjs --json --project=zz done x', 'done'],
    ['node lane.mjs --agent kraken --project zz say "hi"', 'say'],
    ['LANE_PROJECT=zz node lane.mjs release x', 'release'],
    ['node C:/Users/dkhay/.claude/scripts/lane.mjs --project zz add x --title t', 'add'],
  ])('%s', (cmd, verb) => {
    expect(laneChange(cmd, 'Bash')?.verb).toBe(verb);
  });

  it('a value-taking flag never turns its value into the verb', () => {
    expect(laneChange('node lane.mjs --project claim board', 'Bash')).toBeNull();
    expect(laneChange('node lane.mjs --json board', 'Bash')).toBeNull();
  });

  it('reads the board from --project, --project=, LANE_PROJECT= and $env:LANE_PROJECT', () => {
    expect(laneChange('node lane.mjs --project zz claim x', 'Bash')?.project).toBe('zz');
    expect(laneChange('node lane.mjs claim x --project zz', 'Bash')?.project).toBe('zz');
    expect(laneChange('node lane.mjs --project=zz claim x', 'Bash')?.project).toBe('zz');
    expect(laneChange('LANE_PROJECT=zz node lane.mjs claim x', 'Bash')?.project).toBe('zz');
    expect(laneChange("$env:LANE_PROJECT='zz'; node lane.mjs claim x", 'PowerShell')?.project).toBe('zz');
    expect(laneChange('node lane.mjs claim x', 'Bash')?.project).toBeNull();
  });
});

describe('R2..R8: handle() against a real pending dir', () => {
  let tmp = '';
  let dir = '';
  let home = '';
  let zz = '';
  let nowhere = '';
  let cwd = '';
  let env: Record<string, string>;
  const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const pageOf = (board: string): string => boardPageFile(board, env) as string;
  const unref = vi.fn();
  const spawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown> = {}) => {
    spawned.push({ cmd, args: [...args], opts });
    return { unref, on: () => undefined } as never;
  };
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';

  const run = (command: string, extra: Record<string, unknown> = {}, now = 1_700_000_000_000) =>
    handle({ ...bash(command, { session_id: SID, cwd }), ...extra }, env, { spawn: spawnFn as never, now });
  const publish = (input: Record<string, unknown>) =>
    handle({ session_id: SID, tool_name: 'Artifact', tool_input: input, tool_response: { ok: true } }, env, { spawn: spawnFn as never, now: 1 });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-boards-'));
    dir = path.join(tmp, 'pending');
    home = path.join(tmp, 'home');
    cwd = path.join(tmp, 'ccv3');
    zz = path.join(tmp, 'zz');
    nowhere = path.join(tmp, 'nowhere');
    for (const d of [cwd, zz, nowhere, path.join(home, 'continuous-claude', '.claude')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: cwd, status: 'active' },
      { name: 'ZZ', key: 'zz-board', path: zz, status: 'active' },
      { name: 'PH', key: 'ph-board', path: path.join(tmp, 'ph'), status: 'active', laneArtifact: PH_URL },
      { name: 'GM', key: 'gm-board', path: path.join(tmp, 'gm'), status: 'active', laneArtifact: GM_URL },
    ] }));
    fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
      { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publish_from: 'lane-board.html' },
      { id: 'other-page', board: 'ph-board', url: 'https://claude.ai/artifact/PHPHPH1', publish_from: 'lane-board-ph-board.html' },
    ] }));
    env = {
      LANE_REGISTRY_PATH: path.join(tmp, 'registry.json'),
      LANE_BOARD_PENDING_DIR: dir,
      CCV3_USER_HOME: home,
      LANE_RENDER_SCRIPT: path.join(tmp, 'render-board.mjs'),
    };
    spawned.length = 0;
    unref.mockClear();
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const files = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')) : []);

  it('R2: a CCv3 claim writes <sid>.json, reminds with the absolute render command and spawns one render', () => {
    const r = handle(bash('node lane.mjs claim x', { session_id: SID, cwd }), env, { spawn: spawnFn as never, now: 1_700_000_000_000 });
    expect(files()).toEqual([`${SID}.json`]);
    const pend = JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8'));
    expect(pend.board).toBe('continuous-claude');
    expect(pend.verbs).toEqual(['claim']);
    const text = JSON.stringify(r.output);
    expect(text).toContain(renderBoardCmd('continuous-claude', env));
    expect(text).not.toContain('node scripts/coordination');
    expect(text).toContain('https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe(process.execPath);
    expect(spawned[0].args).toEqual([env.LANE_RENDER_SCRIPT, pageOf('continuous-claude'), '--project', 'continuous-claude']);
    expect(unref).toHaveBeenCalled();
  });

  it('R3: a board whose registry entry has a laneArtifact writes its own <sid>@<board>.json, not <sid>.json', () => {
    const r = run('node lane.mjs --project ph-board claim x');
    expect(files()).toEqual([`${SID}@ph-board.json`]);
    expect(pendingFile(SID, 'ph-board', env)).toBe(path.join(dir, `${SID}@ph-board.json`));
    expect(listPending(SID, env).map((e) => e.board)).toEqual(['ph-board']);
    const text = JSON.stringify(r.output);
    expect(text).toContain(PH_URL);
    expect(text).toContain('lane-board-ph-board.html');
    expect(text).not.toContain('RtrTNVfAq9uowmb2tfbzid');
  });

  it('R3: an artifacts.json entry that names a board does not give it a page', () => {
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: cwd, status: 'active' },
      { name: 'PH', key: 'ph-board', path: path.join(tmp, 'ph'), status: 'active' },
    ] }));
    run('node lane.mjs --project ph-board claim x');
    expect(files()).toEqual([]);
  });

  it('R4: a board with NO artifact writes no pending file, says render-only, and still renders', () => {
    const r = run('node lane.mjs --project zz-board claim x');
    expect(files()).toEqual([]);
    expect(JSON.stringify(r.output)).toMatch(/render-only|no phone page/i);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual([env.LANE_RENDER_SCRIPT, pageOf('zz-board'), '--project', 'zz-board']);
  });

  it('R4: the board comes from payload.cwd when no flag is given', () => {
    run('node lane.mjs claim x', { cwd: zz });
    expect(spawned[0].args.slice(2)).toEqual(['--project', 'zz-board']);
    expect(files()).toEqual([]);
  });

  it('R4: an unregistered cwd with no flag is not a lane change (the CLI would have refused)', () => {
    const r = run('node lane.mjs claim x', { cwd: nowhere });
    expect(r.output).toBeNull();
    expect(spawned).toHaveLength(0);
    expect(files()).toEqual([]);
  });

  it('R5: auto-render is debounced 20 s per board (leading + one trailing); another board is independent', () => {
    run('node lane.mjs claim x', {}, 1_700_000_000_000);
    run('node lane.mjs note x "y"', {}, 1_700_000_010_000);
    expect(spawned).toHaveLength(2); // the leading render, and one trailing render for the change inside the window
    run('node lane.mjs --project zz-board claim z', {}, 1_700_000_010_000);
    expect(spawned).toHaveLength(3);
    run('node lane.mjs note x "z"', {}, 1_700_000_021_000);
    expect(spawned).toHaveLength(4); // outside the window: a leading render again
    expect(spawned[3].args[0]).toBe(env.LANE_RENDER_SCRIPT);
  });

  it('R5: a second change while pending marks silently and renders again after the debounce', () => {
    run('node lane.mjs claim x', {}, 1_700_000_000_000);
    const r = run('node lane.mjs note x "y"', {}, 1_700_000_030_000);
    expect(r.output).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).verbs).toEqual(['claim', 'note']);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args[0]).toBe(env.LANE_RENDER_SCRIPT); // 30 s later: a leading render, not a delayed one
  });

  it('R5 (trailing edge): changes at 0 / 5 / 10 s give two renders, the second delayed to the end of the window', () => {
    run('node lane.mjs claim x', {}, 1_700_000_000_000);
    run('node lane.mjs note x "a"', {}, 1_700_000_005_000);
    run('node lane.mjs note x "b"', {}, 1_700_000_010_000);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].args[0]).toBe(env.LANE_RENDER_SCRIPT);
    expect(spawned[1].args.slice(0, 3)).toEqual(['-e', DELAYED_RENDER_SRC, String(RENDER_DEBOUNCE_MS - 5_000)]);
    expect(spawned[1].args.slice(3)).toEqual([env.LANE_RENDER_SCRIPT, pageOf('continuous-claude'), '--project', 'continuous-claude']);
    // the next change after the window renders at once and starts a fresh window
    run('node lane.mjs note x "c"', {}, 1_700_000_021_000);
    run('node lane.mjs note x "d"', {}, 1_700_000_026_000);
    expect(spawned).toHaveLength(4);
    expect(spawned[2].args[0]).toBe(env.LANE_RENDER_SCRIPT);
    expect(spawned[3].args[0]).toBe('-e');
  });

  it('R5 (trailing edge): the delayed child sleeps, then renders once with the render arguments', () => {
    const marker = path.join(tmp, 'rendered.json');
    const script = path.join(tmp, 'fake-render.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2) }));`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['-e', DELAYED_RENDER_SRC, '300', script, 'OUT.html', '--project', 'zz-board'], { timeout: 20_000 });
    expect(r.status).toBe(0);
    const got = JSON.parse(fs.readFileSync(marker, 'utf8')) as { at: number; argv: string[] };
    expect(got.argv).toEqual(['OUT.html', '--project', 'zz-board']);
    expect(got.at - t0).toBeGreaterThanOrEqual(250);
  });

  it('R9: the render child runs in the primary checkout with an absolute output file first (never a bare --project)', () => {
    run('node lane.mjs claim x', { cwd: zz });
    run('node lane.mjs claim x');
    for (const sp of spawned) {
      expect(sp.opts.cwd).toBe(`${home.replace(/\\/g, '/')}/continuous-claude`);
      expect(path.isAbsolute(sp.args[1])).toBe(true);
      expect(sp.args[1].startsWith('--')).toBe(false);
    }
    expect(spawned[0].args[1]).toBe(pageOf('zz-board'));
    expect(spawned[1].args[1]).toBe(pageOf('continuous-claude'));
  });

  it('R9: an OLD render-board.mjs (argv[2] is the output file) writes the right page and no file named --project', () => {
    const old = path.join(tmp, 'old-render.mjs');
    fs.writeFileSync(old, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2] || 'lane-board.html', 'old page');");
    env.LANE_RENDER_SCRIPT = old;
    const primary = path.join(home, 'continuous-claude');
    const elsewhere = path.join(tmp, 'session-folder');
    fs.mkdirSync(elsewhere, { recursive: true });
    run('node lane.mjs claim x', { cwd: zz });
    const r = spawnSync(process.execPath, spawned[0].args, { cwd: elsewhere });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(primary, 'lane-board-zz-board.html'))).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.existsSync(path.join(primary, '--project'))).toBe(false);
  });

  it('R9: boardPageFile mirrors render-board-args defaultOut, and refuses a key that is not a plain board key', async () => {
    const mjs = pathToFileURL(path.join(__dirname, '../../../../scripts/coordination/render-board-args.mjs')).href;
    const { defaultOut } = (await import(/* @vite-ignore */ mjs)) as { defaultOut: (repo: string, board: string) => string };
    const repo = `${home.replace(/\\/g, '/')}/continuous-claude`;
    for (const b of ['continuous-claude', 'zz-board', 'a1']) {
      expect(boardPageFile(b, env)).toBe(defaultOut(repo, b).replace(/\\/g, '/'));
    }
    for (const bad of ['../x', 'A', '-x', 'a b', '', 'x/y']) expect(boardPageFile(bad, env)).toBeNull();
  });

  it('R6: LANE_BOARD_AUTORENDER=0 turns the render off but keeps the reminder', () => {
    env.LANE_BOARD_AUTORENDER = '0';
    const r = run('node lane.mjs claim x');
    expect(spawned).toHaveLength(0);
    expect(r.output).not.toBeNull();
  });

  it('R6: with no LANE_RENDER_SCRIPT the default is the primary checkout render-board.mjs, absolute', () => {
    delete env.LANE_RENDER_SCRIPT;
    run('node lane.mjs claim x');
    expect(spawned[0].args[0].replace(/\\/g, '/')).toBe(`${home.replace(/\\/g, '/')}/continuous-claude/scripts/coordination/render-board.mjs`);
  });

  it('R7: a failed or read-only command renders nothing and writes nothing', () => {
    run('node lane.mjs claim x', { tool_response: { is_error: true } });
    run('node lane.mjs board');
    run('node lane.mjs apply-kanban --dry-run f.json');
    expect(spawned).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('R8: publishing the default board page clears its pending file (by url, and by file name)', () => {
    run('node lane.mjs claim x');
    publish({ url: 'https://claude.ai/artifact/PHPHPH1', file_path: 'x.html' });
    expect(listPending(SID, env).map((e) => e.board)).toEqual(['continuous-claude']);
    publish({ file_path: 'C:\\r\\lane-board.html' });
    expect(listPending(SID, env)).toEqual([]);
    run('node lane.mjs claim y', {}, 1_700_000_100_000);
    publish({ url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', file_path: 'x.html' });
    expect(listPending(SID, env)).toEqual([]);
  });

  it('R8: a leftover <sid>@<board>.json is not cleared by a publish of another page', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}@ph-board.json`), JSON.stringify({ board: 'ph-board', verbs: ['claim'] }));
    publish({ file_path: '/r/lane-board.html' });
    expect(listPending(SID, env).map((e) => e.board)).toEqual(['ph-board']);
  });

  it('R12: two boards with different artifacts: a publish to one url clears only that board file', () => {
    run('node lane.mjs claim x');
    run('node lane.mjs --project ph-board claim x');
    run('node lane.mjs --project gm-board claim x');
    expect(files().sort()).toEqual([`${SID}.json`, `${SID}@gm-board.json`, `${SID}@ph-board.json`]);
    publish({ url: GM_URL, file_path: 'whatever.html' });
    expect(files().sort()).toEqual([`${SID}.json`, `${SID}@ph-board.json`]);
    publish({ url: PH_URL, file_path: 'whatever.html' });
    expect(files()).toEqual([`${SID}.json`]);
    publish({ url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', file_path: 'whatever.html' });
    expect(files()).toEqual([]);
  });

  it('R12: lane-board-<key>.html published to the DEFAULT url clears only the default board file', () => {
    run('node lane.mjs claim x');
    run('node lane.mjs --project ph-board claim x');
    publish({ url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', file_path: '/r/lane-board-ph-board.html' });
    expect(files()).toEqual([`${SID}@ph-board.json`]);
  });

  it('R12: a non-default file name with no url, or with a wrong url, clears nothing (no basename match off the default board)', () => {
    run('node lane.mjs --project ph-board claim x');
    publish({ file_path: '/r/lane-board-ph-board.html' });
    publish({ url: 'https://claude.ai/artifact/SomethingElse1', file_path: '/r/lane-board-ph-board.html' });
    publish({ url: 'https://claude.ai/artifact/KaD7X6HnLKHKjzz7cecUVF/extra', file_path: 'x.html' });
    expect(files()).toEqual([`${SID}@ph-board.json`]);
  });

  it('R12: a publish whose url merely contains the artifact id elsewhere clears nothing', () => {
    run('node lane.mjs --project ph-board claim x');
    publish({ url: 'https://evil.example/?u=https://claude.ai/artifact/KaD7X6HnLKHKjzz7cecUVF', file_path: 'x.html' });
    expect(files()).toEqual([`${SID}@ph-board.json`]);
  });

  it('R12: a non-default id that CONTAINS the default id clears its own board file, not the default one', () => {
    const LONG_URL = 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzidX';
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: cwd, status: 'active' },
      { name: 'LONG', key: 'long-board', path: path.join(tmp, 'long'), status: 'active', laneArtifact: LONG_URL },
    ] }));
    run('node lane.mjs claim x');
    run('node lane.mjs --project long-board claim x');
    expect(files().sort()).toEqual([`${SID}.json`, `${SID}@long-board.json`]);
    publish({ url: LONG_URL, file_path: 'whatever.html' });
    expect(files()).toEqual([`${SID}.json`]);
    publish({ url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', file_path: 'whatever.html' });
    expect(files()).toEqual([]);
  });

  it('R12: a publish to a non-default page whose id contains the default id leaves the default file when that board has no pending file', () => {
    const LONG_URL = 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzidX';
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: cwd, status: 'active' },
      { name: 'LONG', key: 'long-board', path: path.join(tmp, 'long'), status: 'active', laneArtifact: LONG_URL },
    ] }));
    run('node lane.mjs claim x');
    publish({ url: LONG_URL, file_path: 'whatever.html' });
    expect(files()).toEqual([`${SID}.json`]);
  });

  it('R8: an unrelated publish clears nothing', () => {
    run('node lane.mjs claim x');
    publish({ url: 'https://claude.ai/artifact/other', file_path: 'o.html' });
    expect(listPending(SID, env)).toHaveLength(1);
  });
});

describe('R10: a command aimed at another database or registry is not a live lane change', () => {
  const SCRATCH = 'postgresql://claude:pw@localhost:5432/lanes_pr1_ab12cd34';
  it.each([
    [`CONTINUOUS_CLAUDE_DB_URL=${SCRATCH} node scripts/coordination/lane.mjs add zz-1 --title t`, 'Bash'],
    [`DATABASE_URL=${SCRATCH} node lane.mjs claim x`, 'Bash'],
    [`OPC_POSTGRES_URL=${SCRATCH} node lane.mjs note x "y"`, 'Bash'],
    ['LANE_REGISTRY_PATH=/tmp/r.json node lane.mjs claim x', 'Bash'],
    [`LANE_PROJECT=zz DATABASE_URL=${SCRATCH} node lane.mjs claim x`, 'Bash'],
    [`export DATABASE_URL=${SCRATCH}; node lane.mjs add x`, 'Bash'],
    [`$env:DATABASE_URL='${SCRATCH}'; node lane.mjs add x --title t`, 'PowerShell'],
    [`$env:CONTINUOUS_CLAUDE_DB_URL = "${SCRATCH}"; node lane.mjs claim x`, 'PowerShell'],
    ["$env:LANE_REGISTRY_PATH='C:\\t\\r.json'; node lane.mjs claim x", 'PowerShell'],
  ])('%s', (cmd, tool) => {
    expect(laneChange(cmd, tool)).toBeNull();
  });

  it('an unrelated env prefix, or a database name only inside quotes, still counts', () => {
    expect(laneChange('FOO=1 node lane.mjs claim x', 'Bash')?.verb).toBe('claim');
    expect(laneChange('LANE_PROJECT=zz node lane.mjs claim x', 'Bash')?.verb).toBe('claim');
    expect(laneChange('node lane.mjs note x "DATABASE_URL=foo was wrong"', 'Bash')?.verb).toBe('note');
  });

  it('handle(): no pending file, no render, no output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-'));
    try {
      const spawned: unknown[] = [];
      const env = { LANE_BOARD_PENDING_DIR: path.join(tmp, 'p'), LANE_REGISTRY_PATH: path.join(tmp, 'reg.json'), CCV3_USER_HOME: tmp, LANE_RENDER_SCRIPT: path.join(tmp, 'r.mjs') };
      fs.mkdirSync(path.join(tmp, 'cc'));
      fs.writeFileSync(env.LANE_REGISTRY_PATH, JSON.stringify({ projects: [{ name: 'CCv3', key: 'continuous-claude', path: path.join(tmp, 'cc'), status: 'active' }] }));
      const r = handle(bash(`DATABASE_URL=${SCRATCH} node lane.mjs claim x`, { cwd: path.join(tmp, 'cc'), session_id: 's9' }), env, { spawn: ((...a: unknown[]) => { spawned.push(a); return {}; }) as never, now: 1 });
      expect(r.output).toBeNull();
      expect(r.decision.action).toBe('none');
      expect(spawned).toHaveLength(0);
      expect(fs.existsSync(env.LANE_BOARD_PENDING_DIR)).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('R11: note|state|release|done in a cwd with no board use the board of the lane the caller owns', () => {
  let tmp = '';
  let env: Record<string, string>;
  let home = '';
  let nowhere = '';
  let zz = '';
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const spawned: Array<{ args: string[] }> = [];
  const spawnFn = (_c: string, args: readonly string[]) => { spawned.push({ args: [...args] }); return { unref: () => undefined, on: () => undefined } as never; };
  const call = (command: string, cwd: string, deps: { ownedBoard?: string | null } = {}) =>
    handle(bash(command, { session_id: SID, cwd }), env, { spawn: spawnFn as never, now: 1_700_000_000_000, ...deps });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-'));
    home = path.join(tmp, 'home');
    nowhere = path.join(tmp, 'nowhere');
    zz = path.join(tmp, 'zz');
    for (const d of [nowhere, zz, path.join(tmp, 'cc'), path.join(home, 'continuous-claude', '.claude')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'reg.json'), JSON.stringify({ projects: [
      { name: 'CCv3', key: 'continuous-claude', path: path.join(tmp, 'cc'), status: 'active' },
      { name: 'ZZ', key: 'zz-board', path: zz, status: 'active' },
    ] }));
    env = { LANE_REGISTRY_PATH: path.join(tmp, 'reg.json'), LANE_BOARD_PENDING_DIR: path.join(tmp, 'pending'), CCV3_USER_HOME: home, LANE_RENDER_SCRIPT: path.join(tmp, 'r.mjs') };
    spawned.length = 0;
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('laneChange reads the lane id and --as after the verb, past global flags', () => {
    expect(laneChange('node lane.mjs done L1', 'Bash')).toMatchObject({ verb: 'done', laneId: 'L1', as: null });
    expect(laneChange('node lane.mjs --json note L2 "text"', 'Bash')).toMatchObject({ verb: 'note', laneId: 'L2' });
    expect(laneChange('node lane.mjs state --as abc-123 L3 ready', 'Bash')).toMatchObject({ verb: 'state', laneId: 'L3', as: 'abc-123' });
    expect(laneChange('node lane.mjs release L4 --note "x y"', 'Bash')).toMatchObject({ verb: 'release', laneId: 'L4' });
    expect(laneChange('node lane.mjs say "hi"', 'Bash')).toMatchObject({ verb: 'say', laneId: null });
  });

  it('done in an unregistered cwd, owner board known: writes the CCv3 pending file and reminds', () => {
    const r = call('node C:/Users/dkhay/.claude/scripts/lane.mjs done L1', nowhere, { ownedBoard: 'continuous-claude' });
    expect(r.decision).toMatchObject({ action: 'remind', board: 'continuous-claude', verb: 'done' });
    expect(fs.existsSync(path.join(tmp, 'pending', `${SID}.json`))).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('the same for note, state and release', () => {
    for (const cmd of ['note L1 "x"', 'state L1 active', 'release L1']) {
      expect(call(`node lane.mjs ${cmd}`, nowhere, { ownedBoard: 'continuous-claude' }).decision.action).toBe('remind');
      fs.rmSync(path.join(tmp, 'pending'), { recursive: true, force: true });
    }
  });

  it('a lane on a board with no phone page is render-only', () => {
    expect(call('node lane.mjs done L1', nowhere, { ownedBoard: 'zz-board' }).decision).toMatchObject({ action: 'render', board: 'zz-board' });
  });

  it('no owned board (lookup found nothing or failed): not a change, as before', () => {
    expect(call('node lane.mjs done L1', nowhere, { ownedBoard: null }).decision.action).toBe('none');
    expect(call('node lane.mjs done L1', nowhere).decision.action).toBe('none');
  });

  it('only the owner-keyed verbs use it: claim, add, say in an unregistered cwd stay none', () => {
    for (const cmd of ['claim L1', 'add L1 --title t', 'say "hi"']) {
      expect(call(`node lane.mjs ${cmd}`, nowhere, { ownedBoard: 'continuous-claude' }).decision.action).toBe('none');
    }
  });

  it('the cwd board and --project win over the owned board', () => {
    expect(call('node lane.mjs done L1', zz, { ownedBoard: 'continuous-claude' }).decision.board).toBe('zz-board');
    expect(call('node lane.mjs --project zz-board done L1', nowhere, { ownedBoard: 'continuous-claude' }).decision.board).toBe('zz-board');
  });

  describe('ownedLaneBoard (the lookup)', () => {
    const run = vi.fn();
    const payload = (command: string, cwd: string, extra: Record<string, unknown> = {}) => bash(command, { session_id: SID, cwd, ...extra });
    beforeEach(() => { run.mockReset(); run.mockResolvedValue([{ project_key: 'zz-board' }]); });

    it('asks for my latest event on that lane id and returns its board', async () => {
      expect(await ownedLaneBoard(payload('node lane.mjs done L1', nowhere), env, run)).toBe('zz-board');
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toMatch(/FROM agentic_os\.lane_event WHERE lane_id = \$1 AND session_id = \$2 ORDER BY id DESC LIMIT 1/);
      expect(run.mock.calls[0][1]).toEqual(['L1', SID]);
    });

    it('--as names the owner', async () => {
      await ownedLaneBoard(payload('node lane.mjs note --as other-sid L1 "x"', nowhere), env, run);
      expect(run.mock.calls[0][1]).toEqual(['L1', 'other-sid']);
    });

    it.each([
      ['a cwd that has a board', 'node lane.mjs done L1', () => zz],
      ['--project', 'node lane.mjs --project zz-board done L1', () => nowhere],
      ['a verb that is not owner-keyed', 'node lane.mjs claim L1', () => nowhere],
      ['no lane id', 'node lane.mjs done', () => nowhere],
      ['a scratch-database command', 'DATABASE_URL=postgresql://x/lanes_pr1_a node lane.mjs done L1', () => nowhere],
      ['a command that is not lane.mjs', 'git status', () => nowhere],
    ])('never connects for %s', async (_n, cmd, cwd) => {
      expect(await ownedLaneBoard(payload(cmd, cwd()), env, run)).toBeNull();
      expect(run).not.toHaveBeenCalled();
    });

    it('never connects for a failed command', async () => {
      expect(await ownedLaneBoard(payload('node lane.mjs done L1', nowhere, { tool_response: { is_error: true } }), env, run)).toBeNull();
      expect(run).not.toHaveBeenCalled();
    });

    it('fails open: a query error, no row, or a key that is not a board key gives null', async () => {
      run.mockRejectedValueOnce(new Error('connection refused'));
      expect(await ownedLaneBoard(payload('node lane.mjs done L1', nowhere), env, run)).toBeNull();
      run.mockResolvedValueOnce([]);
      expect(await ownedLaneBoard(payload('node lane.mjs done L1', nowhere), env, run)).toBeNull();
      run.mockResolvedValueOnce([{ project_key: '../evil' }]);
      expect(await ownedLaneBoard(payload('node lane.mjs done L1', nowhere), env, run)).toBeNull();
    });
  });
});
