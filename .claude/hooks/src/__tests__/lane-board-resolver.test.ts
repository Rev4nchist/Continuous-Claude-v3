/**
 * Lane board resolver: drift test plus behaviour.
 *
 * The resolver lives in two copies (a hook module and a plain-JS twin for lane.mjs).
 * Every case runs against BOTH and asserts equal output, so a change to one copy
 * that is not mirrored in the other fails here.
 *
 * Fixtures are real folders under os.tmpdir(). The resolver never stats registry
 * roots, so some registry roots deliberately point at folders that do not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tsTwin from '../shared/lane-board.js';

// The .mjs twin sits outside tsc's rootDir, so load it by URL at run time.
const mjsUrl = pathToFileURL(path.resolve(__dirname, '../../../../scripts/coordination/lane-board.mjs')).href;
const mjsTwin: typeof tsTwin = await import(/* @vite-ignore */ mjsUrl);

type Opts = Parameters<typeof tsTwin.resolveBoard>[1];
type Result = ReturnType<typeof tsTwin.resolveBoard>;

let tmp: string;
const mk = (...parts: string[]): string => {
  const p = path.join(tmp, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const writeRegistry = (projects: Array<Record<string, unknown>>): string => {
  const file = path.join(tmp, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ version: '1.0', projects }));
  return file;
};
const entry = (name: string, p: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: p,
  status: 'active',
  ...extra,
});

/** Run one resolver call on both twins, assert equal output, return it. */
const both = (cwd: string, opts: Opts = {}): Result => {
  const a = tsTwin.resolveBoard(cwd, opts);
  const b = mjsTwin.resolveBoard(cwd, opts);
  expect(b).toEqual(a);
  return a;
};
/** Same for a call that must throw: both twins throw the same message. */
const bothThrow = (cwd: string, opts: Opts): string => {
  const msgs = [tsTwin, mjsTwin].map((t) => {
    try {
      t.resolveBoard(cwd, opts);
    } catch (e) {
      return (e as Error).message;
    }
    return '<no throw>';
  });
  expect(msgs[1]).toBe(msgs[0]);
  return msgs[0];
};

beforeEach(() => {
  // realpath: os.tmpdir() can be an 8.3 short name on Windows; the resolver realpaths the cwd.
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-board-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('twin drift', () => {
  it('both copies export the same names', () => {
    expect(Object.keys(mjsTwin).sort()).toEqual(Object.keys(tsTwin).sort());
    expect(Object.keys(tsTwin).sort()).toEqual([
      'DEFAULT_BOARD', 'artifactIdOf', 'boardArtifact', 'boardRoots', 'isHeadless', 'laneCliCmd', 'laneShimPath', 'loadRegistry',
      'normalizeRoot', 'pendingKey', 'primaryRepo', 'renderBoardCmd', 'resolveBoard', 'wmKey',
    ]);
  });

  it('normalizeRoot agrees on awkward inputs', () => {
    for (const p of ['C:\\Users\\Dave\\Proj\\', '/c/Users/Dave', '/C/Users', 'c:/a//b/', '\\\\?\\C:\\x\\y', 'rel/path', '']) {
      expect(mjsTwin.normalizeRoot(p)).toBe(tsTwin.normalizeRoot(p));
    }
  });
});

describe('derived helpers (PR2 exports), both twins', () => {
  const env = { CCV3_USER_HOME: 'C:\\Users\\Dave\\' } as Record<string, string>;

  it('DEFAULT_BOARD is continuous-claude in both', () => {
    expect(tsTwin.DEFAULT_BOARD).toBe('continuous-claude');
    expect(mjsTwin.DEFAULT_BOARD).toBe('continuous-claude');
  });

  it('wmKey: bare id on the default board, id@board elsewhere', () => {
    for (const t of [tsTwin, mjsTwin]) {
      expect(t.wmKey('abc', 'continuous-claude')).toBe('abc');
      expect(t.wmKey('abc', 'greymatter')).toBe('abc@greymatter');
    }
  });

  it('primaryRepo / laneShimPath / laneCliCmd / renderBoardCmd: forward slashes, CCV3_USER_HOME wins, no trailing slash', () => {
    for (const t of [tsTwin, mjsTwin]) {
      expect(t.primaryRepo(env)).toBe('C:/Users/Dave/continuous-claude');
      expect(t.laneShimPath(env)).toBe('C:/Users/Dave/.claude/scripts/lane.mjs');
      expect(t.laneCliCmd(env)).toBe('node C:/Users/Dave/.claude/scripts/lane.mjs');
      expect(t.renderBoardCmd('zz', env)).toBe(
        'node C:/Users/Dave/continuous-claude/scripts/coordination/render-board.mjs --project zz',
      );
    }
  });

  it('primaryRepo falls back to os.homedir() with forward slashes and never prints a literal ~', () => {
    const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
    for (const t of [tsTwin, mjsTwin]) {
      expect(t.primaryRepo({})).toBe(`${home}/continuous-claude`);
      expect(t.laneCliCmd({})).not.toContain('~');
      expect(t.laneCliCmd({})).not.toContain('\\');
    }
  });

  it('pendingKey: wmKey with every char outside [A-Za-z0-9@_-] replaced by _', () => {
    for (const t of [tsTwin, mjsTwin]) {
      expect(t.pendingKey('abc-123', 'continuous-claude')).toBe('abc-123');
      expect(t.pendingKey('abc-123', 'green')).toBe('abc-123@green');
      expect(t.pendingKey('../a b', 'x')).toBe('___a_b@x');
    }
  });

  describe('boardArtifact', () => {
    const write = (body: unknown): string => {
      const f = path.join(tmp, 'artifacts.json');
      fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
      return f;
    };
    // Hermetic: a call that names no registry reads an empty one, never ~/.claude/project-registry.json.
    // A call that names no artifacts.json or home reads a temp home that holds the fallback id, never
    // <real home>/continuous-claude/.claude/artifacts.json (the default-id check of a non-default board reads it).
    const hermeticHome = (): string => {
      const home = path.join(tmp, 'hermetic-home');
      fs.mkdirSync(path.join(home, 'continuous-claude', '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'), JSON.stringify({ artifacts: [
        { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publish_from: 'lane-board.html' },
      ] }));
      return home;
    };
    const run = (board: string, opts: Parameters<typeof tsTwin.boardArtifact>[1] = {}) => {
      const empty = path.join(tmp, 'empty-registry.json');
      fs.writeFileSync(empty, JSON.stringify({ projects: [] }));
      const o = { registryPath: empty, ...opts, env: { CCV3_USER_HOME: hermeticHome(), ...opts.env } };
      const a = tsTwin.boardArtifact(board, o);
      expect(mjsTwin.boardArtifact(board, o)).toEqual(a);
      return a;
    };

    it('the default board reads the entry whose id is agentic-os-lane-board', () => {
      const f = write({ artifacts: [
        { id: 'other', url: 'https://claude.ai/artifact/AAA', publish_from: 'x.html' },
        { id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/GGG111', publish_from: 'page.html' },
      ] });
      expect(run('continuous-claude', { artifactsPath: f })).toEqual({
        id: 'GGG111', url: 'https://claude.ai/artifact/GGG111', publishFrom: 'page.html',
      });
    });

    it('no other board has an artifact, even when an entry carries a board field', () => {
      const f = write({ artifacts: [
        { id: 'lane-board-g', board: 'greymatter', url: 'https://claude.ai/artifact/GGG111', publish_from: 'lane-board-greymatter.html' },
      ] });
      expect(run('greymatter', { artifactsPath: f })).toBeNull();
      expect(run('zz-board', { artifactsPath: f })).toBeNull();
    });

    it('a board with no entry has no artifact (null), except the default board', () => {
      const f = write({ artifacts: [] });
      expect(run('greymatter', { artifactsPath: f })).toBeNull();
      expect(run('continuous-claude', { artifactsPath: f })).toEqual({
        id: 'RtrTNVfAq9uowmb2tfbzid', url: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid', publishFrom: 'lane-board.html',
      });
    });

    it('a missing or corrupt file gives the fallback for the default board and null for others', () => {
      const missing = path.join(tmp, 'nope.json');
      const corrupt = write('{not json');
      for (const f of [missing, corrupt]) {
        expect(run('greymatter', { artifactsPath: f })).toBeNull();
        expect(run('continuous-claude', { artifactsPath: f })?.id).toBe('RtrTNVfAq9uowmb2tfbzid');
      }
    });

    it('the artifacts.json entry overrides the fallback; an entry with another id does not', () => {
      const f = write({ artifacts: [{ id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/NEW999', publish_from: 'lane-board.html' }] });
      expect(run('continuous-claude', { artifactsPath: f })?.id).toBe('NEW999');
      const g = write({ artifacts: [{ id: 'something-else', board: 'continuous-claude', url: 'https://claude.ai/artifact/NEW999', publish_from: 'lane-board.html' }] });
      expect(run('continuous-claude', { artifactsPath: g })?.id).toBe('RtrTNVfAq9uowmb2tfbzid');
    });

    it('finds <primaryRepo>/.claude/artifacts.json through opts.env', () => {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(path.join(home, 'continuous-claude', '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, 'continuous-claude', '.claude', 'artifacts.json'),
        JSON.stringify({ artifacts: [{ id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/ZZ1', publish_from: 'z.html' }] }));
      expect(run('continuous-claude', { env: { CCV3_USER_HOME: home } })?.id).toBe('ZZ1');
    });

    describe('laneArtifact on a non-default board (Option B)', () => {
      const URL_A = 'https://claude.ai/artifact/KaD7X6HnLKHKjzz7cecUVF';
      const URL_B = 'https://claude.ai/artifact/UcUbP216jcKLNQLb18TL7Y';
      const URL_C = 'https://claude.ai/artifact/Zq3mW8rTnV5xHb2yPd4LsA';
      const reg = (projects: Array<Record<string, unknown>>) => ({ registryPath: writeRegistry(projects) });
      const gm = (extra: Record<string, unknown> = {}) => entry('GreyMatter Design', 'D:/GreyMatter.Design', { key: 'greymatter-design', ...extra });

      it('an active entry with board === key and a laneArtifact gives id, rebuilt url and lane-board-<key>.html', () => {
        expect(run('greymatter-design', reg([gm({ laneArtifact: URL_A })]))).toEqual({
          id: 'KaD7X6HnLKHKjzz7cecUVF', url: URL_A, publishFrom: 'lane-board-greymatter-design.html',
        });
      });

      it('no laneArtifact, or an inactive entry, or an unknown board gives null (no fallback)', () => {
        expect(run('greymatter-design', reg([gm()]))).toBeNull();
        expect(run('greymatter-design', reg([gm({ laneArtifact: URL_A, status: 'inactive' })]))).toBeNull();
        expect(run('nope', reg([gm({ laneArtifact: URL_A })]))).toBeNull();
      });

      it('a url that fails the strict check gives null', () => {
        for (const bad of [
          'https://evil.example/artifact/x', 'http://claude.ai/artifact/abc', 'https://claude.ai/artifact/abc/extra',
          'https://claude.ai/artifact/abc?x=1', 'https://claude.ai/artifact/', 'https://claude.ai.evil.example/artifact/abc',
          ' https://claude.ai/artifact/abc', 'https://claude.ai/artifact/abc\n', 'https://Claude.ai/artifact/abc', 42,
        ]) {
          expect(run('greymatter-design', reg([gm({ laneArtifact: bad })]))).toBeNull();
        }
      });

      it('a board key that is not a plain board key gives null', () => {
        for (const bad of ['A', '-x', 'a b', '../x', '']) {
          expect(run(bad, reg([entry('Bad', 'D:/bad', { key: bad, laneArtifact: URL_A })]))).toBeNull();
        }
      });

      it('an id used by two boards, or equal to the default board id, gives null', () => {
        const two = reg([gm({ laneArtifact: URL_A }), entry('Other', 'D:/other', { key: 'other', laneArtifact: URL_A })]);
        expect(run('greymatter-design', two)).toBeNull();
        expect(run('other', two)).toBeNull();
        const own = reg([gm({ laneArtifact: 'https://claude.ai/artifact/RtrTNVfAq9uowmb2tfbzid' })]);
        expect(run('greymatter-design', own)).toBeNull();
        const distinct = reg([gm({ laneArtifact: URL_A }), entry('Other', 'D:/other', { key: 'other', laneArtifact: URL_B })]);
        expect(run('greymatter-design', distinct)?.id).toBe('KaD7X6HnLKHKjzz7cecUVF');
        expect(run('other', distinct)?.id).toBe('UcUbP216jcKLNQLb18TL7Y');
      });

      it('an id equal to the default board id from artifacts.json also gives null', () => {
        const f = write({ artifacts: [{ id: 'agentic-os-lane-board', url: URL_A, publish_from: 'lane-board.html' }] });
        expect(run('greymatter-design', { ...reg([gm({ laneArtifact: URL_A })]), artifactsPath: f })).toBeNull();
      });

      it('a nested entry (laneBoard set) never gives its own key a page, and cannot lend one to its parent board', () => {
        // Three DISTINCT urls: no duplicate-id rule can hide a missing `e.board === e.key` filter.
        const projects = [
          gm({ laneArtifact: URL_A }),
          entry('Agentic OS', 'D:/os', { key: 'agentic-os', laneBoard: 'continuous-claude', laneArtifact: URL_B }),
          entry('Sub', 'D:/gm/sub', { key: 'gm-sub', laneBoard: 'greymatter-design', laneArtifact: URL_C }),
        ];
        expect(run('agentic-os', reg(projects))).toBeNull();
        expect(run('gm-sub', reg(projects))).toBeNull();
        expect(run('greymatter-design', reg(projects))?.id).toBe('KaD7X6HnLKHKjzz7cecUVF');
        expect(run('continuous-claude', reg(projects))?.id).toBe('RtrTNVfAq9uowmb2tfbzid');
      });

      it('a nested entry that repeats a real board id does not void that board', () => {
        const projects = [
          gm({ laneArtifact: URL_A }),
          entry('Sub', 'D:/gm/sub', { key: 'gm-sub', laneBoard: 'greymatter-design', laneArtifact: URL_A }),
        ];
        expect(run('greymatter-design', reg(projects))?.id).toBe('KaD7X6HnLKHKjzz7cecUVF');
      });

      it('two registry entries with the same key give null (no first-wins guess)', () => {
        const twice = reg([gm({ laneArtifact: URL_A }), entry('GreyMatter Again', 'D:/gm2', { key: 'greymatter-design', laneArtifact: URL_B })]);
        expect(run('greymatter-design', twice)).toBeNull();
      });

      it('a stray laneArtifact on the continuous-claude entry is not another board\'s duplicate', () => {
        const stray = entry('CCv3', 'D:/ccv3', { key: 'continuous-claude', laneArtifact: URL_A });
        expect(run('greymatter-design', reg([stray, gm({ laneArtifact: URL_A })]))?.id).toBe('KaD7X6HnLKHKjzz7cecUVF');
      });

      it('laneArtifact on the continuous-claude entry is ignored: artifacts.json and the fallback still win', () => {
        const projects = [entry('CCv3', 'D:/ccv3', { key: 'continuous-claude', laneArtifact: URL_B })];
        expect(run('continuous-claude', reg(projects))?.id).toBe('RtrTNVfAq9uowmb2tfbzid');
        const f = write({ artifacts: [{ id: 'agentic-os-lane-board', url: 'https://claude.ai/artifact/GGG111', publish_from: 'page.html' }] });
        expect(run('continuous-claude', { ...reg(projects), artifactsPath: f })).toEqual({
          id: 'GGG111', url: 'https://claude.ai/artifact/GGG111', publishFrom: 'page.html',
        });
      });

      it('reads the registry from opts.env.LANE_REGISTRY_PATH when registryPath is absent, and loadRegistry exposes the raw string', () => {
        const file = writeRegistry([gm({ laneArtifact: URL_A })]);
        // CCV3_USER_HOME keeps the default-id check off the real <home>/continuous-claude/.claude/artifacts.json.
        const env = { LANE_REGISTRY_PATH: file, CCV3_USER_HOME: hermeticHome() };
        const a = tsTwin.boardArtifact('greymatter-design', { env });
        expect(mjsTwin.boardArtifact('greymatter-design', { env })).toEqual(a);
        expect(a?.id).toBe('KaD7X6HnLKHKjzz7cecUVF');
        const rows = tsTwin.loadRegistry({ registryPath: file });
        expect(mjsTwin.loadRegistry({ registryPath: file })).toEqual(rows);
        expect(rows[0].artifact).toBe(URL_A);
        const none = tsTwin.loadRegistry({ registryPath: writeRegistry([gm()]) });
        expect(none[0].artifact).toBeNull();
      });
    });
  });
});

describe('normalizeRoot', () => {
  it('folds backslashes, case and trailing slash', () => {
    expect(tsTwin.normalizeRoot('C:\\Users\\Dave\\Proj\\')).toBe('c:/users/dave/proj');
  });
  it('folds a leading /c/ to c:/', () => {
    expect(tsTwin.normalizeRoot('/c/Users/Dave')).toBe('c:/users/dave');
    expect(tsTwin.normalizeRoot('/C/Users/')).toBe('c:/users');
  });
  it('strips the extended-length prefix', () => {
    expect(tsTwin.normalizeRoot('\\\\?\\C:\\x\\y')).toBe('c:/x/y');
  });
});

describe('registry matching', () => {
  it('matches a subfolder and the root itself', () => {
    const foo = mk('a', 'foo');
    const sub = mk('a', 'foo', 'sub', 'deep');
    const registry = writeRegistry([entry('Foo', foo)]);
    expect(both(foo, { registryPath: registry })).toMatchObject({ key: 'foo', source: 'registry' });
    expect(both(sub, { registryPath: registry })).toMatchObject({ key: 'foo', source: 'registry' });
  });

  it('matches across slash style and case', () => {
    const foo = mk('a', 'foo');
    const sub = mk('a', 'foo', 'sub');
    // Registry root written with backslashes and upper case; cwd in the native form.
    const registry = writeRegistry([entry('Foo', foo.replace(/\//g, '\\').toUpperCase())]);
    expect(both(sub, { registryPath: registry })).toMatchObject({ key: 'foo' });
  });

  it.skipIf(process.platform !== 'win32')('matches a Git Bash style /c/ root', () => {
    const foo = mk('a', 'foo');
    const gitBash = '/' + foo[0].toLowerCase() + foo.slice(2).replace(/\\/g, '/');
    const registry = writeRegistry([entry('Foo', gitBash)]);
    expect(both(foo, { registryPath: registry })).toMatchObject({ key: 'foo' });
  });

  it('respects the path-segment boundary: foo does not match foobar', () => {
    const foo = mk('a', 'foo');
    const foobar = mk('a', 'foobar');
    const registry = writeRegistry([entry('Foo', foo)]);
    expect(both(foobar, { registryPath: registry })).toBeNull();
    expect(both(path.join(foobar, 'x'), { registryPath: registry })).toBeNull();
  });

  it('longest matching root wins', () => {
    const outer = mk('p');
    const inner = mk('p', 'inner');
    const registry = writeRegistry([entry('Outer', outer), entry('Inner', inner)]);
    expect(both(path.join(inner, 'x'), { registryPath: registry })).toMatchObject({ key: 'inner' });
    expect(both(mk('p', 'other'), { registryPath: registry })).toMatchObject({ key: 'outer' });
  });

  it('a nested entry with laneBoard maps to the parent board', () => {
    const parent = mk('ccv3');
    const app = mk('ccv3', 'apps', 'os');
    const registry = writeRegistry([
      entry('continuous-claude', parent),
      entry('Agentic OS', app, { laneBoard: 'continuous-claude' }),
    ]);
    const r = both(path.join(app, 'src'), { registryPath: registry });
    expect(r).toMatchObject({ key: 'continuous-claude', source: 'registry', via: 'agentic-os' });
  });

  it('uses the explicit key field instead of the slugified name', () => {
    const d = mk('k');
    const registry = writeRegistry([entry('Some Name!', d, { key: 'custom-key' })]);
    expect(both(d, { registryPath: registry })).toMatchObject({ key: 'custom-key' });
  });

  it('slugifies a name without a key', () => {
    const d = mk('k');
    const registry = writeRegistry([entry('ECG  Lead_Reactivation Engine!', d)]);
    expect(both(d, { registryPath: registry })).toMatchObject({ key: 'ecg-lead-reactivation-engine' });
  });

  it('skips inactive entries', () => {
    const d = mk('gone');
    const registry = writeRegistry([entry('Gone', d, { status: 'inactive' })]);
    expect(both(d, { registryPath: registry })).toBeNull();
  });

  it('an inactive inner entry falls through to the active parent', () => {
    const outer = mk('p');
    const inner = mk('p', 'inner');
    const registry = writeRegistry([entry('Outer', outer), entry('Inner', inner, { status: 'inactive' })]);
    expect(both(inner, { registryPath: registry })).toMatchObject({ key: 'outer' });
  });

  it('accepts in-development entries', () => {
    const d = mk('dev');
    const registry = writeRegistry([entry('Dev', d, { status: 'in-development' })]);
    expect(both(d, { registryPath: registry })).toMatchObject({ key: 'dev' });
  });

  it('resolves under an active root that does not exist on disk (no stat of roots)', () => {
    const dead = path.join(tmp, 'dead-root');
    const registry = writeRegistry([entry('Dead', dead)]);
    expect(both(path.join(dead, 'sub'), { registryPath: registry })).toMatchObject({ key: 'dead' });
  });

  it('falls back to the normalised string when the cwd was deleted', () => {
    const foo = mk('a', 'foo');
    const registry = writeRegistry([entry('Foo', foo)]);
    const gone = path.join(foo, 'deleted', 'child');
    expect(fs.existsSync(gone)).toBe(false);
    expect(both(gone, { registryPath: registry })).toMatchObject({ key: 'foo' });
  });

  it('returns null for an unregistered scratch dir and for the home dir', () => {
    const foo = mk('a', 'foo');
    const registry = writeRegistry([entry('Foo', foo)]);
    expect(both(mk('scratch'), { registryPath: registry })).toBeNull();
    expect(both(os.homedir(), { registryPath: registry })).toBeNull();
  });

  it('returns null for a missing, empty or corrupt registry (fail open)', () => {
    const d = mk('d');
    expect(both(d, { registryPath: path.join(tmp, 'nope.json') })).toBeNull();
    const corrupt = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ not json');
    expect(both(d, { registryPath: corrupt })).toBeNull();
    fs.writeFileSync(corrupt, JSON.stringify({ projects: 'nope' }));
    expect(both(d, { registryPath: corrupt })).toBeNull();
  });

  it('reads a registry that starts with a BOM', () => {
    const d = mk('d');
    const file = path.join(tmp, 'bom.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ projects: [entry('Bom', d)] }));
    expect(both(d, { registryPath: file })).toMatchObject({ key: 'bom' });
  });

  it('ignores entries with an empty or relative path', () => {
    const d = mk('d');
    const registry = writeRegistry([entry('Empty', ''), entry('Slash', '/'), entry('Rel', 'd')]);
    expect(both(d, { registryPath: registry })).toBeNull();
  });

  it('finds the registry from LANE_REGISTRY_PATH and from HOME', () => {
    const d = mk('d');
    const registry = writeRegistry([entry('Env', d)]);
    expect(both(d, { env: { LANE_REGISTRY_PATH: registry } })).toMatchObject({ key: 'env' });
    const home = mk('home', '.claude');
    fs.copyFileSync(registry, path.join(home, 'project-registry.json'));
    expect(both(d, { env: { HOME: path.dirname(home), USERPROFILE: path.dirname(home) } })).toMatchObject({ key: 'env' });
  });

  it('prefers opts.registryPath over LANE_REGISTRY_PATH', () => {
    const d = mk('d');
    const good = writeRegistry([entry('Good', d)]);
    expect(both(d, { registryPath: good, env: { LANE_REGISTRY_PATH: path.join(tmp, 'nope.json') } })).toMatchObject({ key: 'good' });
  });
});

describe('worktree gitdir fallback', () => {
  const addWorktree = (root: string, name: string, worktreeDir: string, content?: string) => {
    const d = path.join(root, '.git', 'worktrees', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'gitdir'), content ?? path.join(worktreeDir, '.git') + '\n');
  };

  it('finds a worktree outside the root through its gitdir file', () => {
    const root = mk('repo');
    const wt = mk('elsewhere', 'wt1');
    addWorktree(root, 'wt1', wt);
    const registry = writeRegistry([entry('Repo', root)]);
    const r = both(path.join(mk('elsewhere', 'wt1', 'src')), { registryPath: registry });
    expect(r).toMatchObject({ key: 'repo', source: 'worktree-gitdir' });
    expect(both(wt, { registryPath: registry })).toMatchObject({ key: 'repo', source: 'worktree-gitdir' });
  });

  it('applies the segment boundary to the worktree dir', () => {
    const root = mk('repo');
    const wt = mk('elsewhere', 'wt1');
    mk('elsewhere', 'wt1x');
    addWorktree(root, 'wt1', wt);
    const registry = writeRegistry([entry('Repo', root)]);
    expect(both(path.join(tmp, 'elsewhere', 'wt1x'), { registryPath: registry })).toBeNull();
  });

  it('honours CRLF in the gitdir file', () => {
    const root = mk('repo');
    const wt = mk('elsewhere', 'wt1');
    addWorktree(root, 'wt1', wt, path.join(wt, '.git') + '\r\n');
    const registry = writeRegistry([entry('Repo', root)]);
    expect(both(wt, { registryPath: registry })).toMatchObject({ key: 'repo' });
  });

  it('does not read worktrees of an inactive root', () => {
    const root = mk('repo');
    const wt = mk('elsewhere', 'wt1');
    addWorktree(root, 'wt1', wt);
    const registry = writeRegistry([entry('Repo', root, { status: 'inactive' })]);
    expect(both(wt, { registryPath: registry })).toBeNull();
  });

  it('prefers the registry prefix match over a worktree match', () => {
    const root = mk('repo');
    const other = mk('other');
    const wt = mk('other', 'wt1');
    addWorktree(root, 'wt1', wt);
    const registry = writeRegistry([entry('Repo', root), entry('Other', other)]);
    expect(both(wt, { registryPath: registry })).toMatchObject({ key: 'other', source: 'registry' });
  });

  it('ignores a gitdir file that names no worktree dir', () => {
    const root = mk('repo');
    addWorktree(root, 'bad', tmp, '/.git\n');
    addWorktree(root, 'bad2', tmp, 'not-absolute/.git\n');
    addWorktree(root, 'bad3', tmp, 'C:/somewhere/else\n');
    const registry = writeRegistry([entry('Repo', root)]);
    expect(both(mk('scratch'), { registryPath: registry })).toBeNull();
  });

  it('reads at most 100 gitdir files per root', () => {
    const root = mk('repo');
    for (let i = 0; i < 100; i++) addWorktree(root, 'a' + String(i).padStart(3, '0'), path.join(tmp, 'filler', String(i)));
    const wt = mk('elsewhere', 'late');
    addWorktree(root, 'z-late', wt);
    const registry = writeRegistry([entry('Repo', root)]);
    expect(both(wt, { registryPath: registry })).toBeNull();
  });

  it('never trusts a .git file planted in the cwd', () => {
    const root = mk('repo');
    addWorktree(root, 'real', mk('elsewhere', 'real'));
    const registry = writeRegistry([entry('Repo', root)]);
    const planted = mk('planted');
    fs.writeFileSync(path.join(planted, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'real')}\n`);
    expect(both(planted, { registryPath: registry })).toBeNull();
    // A planted .git directory with its own gitdir/worktrees layout is ignored too.
    const plantedDir = mk('planted2');
    fs.mkdirSync(path.join(plantedDir, '.git', 'worktrees', 'x'), { recursive: true });
    fs.writeFileSync(path.join(plantedDir, '.git', 'worktrees', 'x', 'gitdir'), path.join(plantedDir, '.git') + '\n');
    expect(both(plantedDir, { registryPath: registry })).toBeNull();
  });

  it('ignores GIT_DIR and GIT_COMMON_DIR, in opts.env and in process.env', () => {
    const root = mk('repo');
    const registry = writeRegistry([entry('Repo', root)]);
    const scratch = mk('scratch');
    const git = { GIT_DIR: path.join(root, '.git'), GIT_COMMON_DIR: path.join(root, '.git'), GIT_WORK_TREE: root };
    expect(both(scratch, { registryPath: registry, env: git })).toBeNull();
    expect(both(root, { registryPath: registry, env: git })).toMatchObject({ key: 'repo' });
    const saved = { d: process.env.GIT_DIR, c: process.env.GIT_COMMON_DIR };
    process.env.GIT_DIR = git.GIT_DIR;
    process.env.GIT_COMMON_DIR = git.GIT_COMMON_DIR;
    try {
      expect(both(scratch, { registryPath: registry })).toBeNull();
    } finally {
      if (saved.d === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.d;
      if (saved.c === undefined) delete process.env.GIT_COMMON_DIR; else process.env.GIT_COMMON_DIR = saved.c;
    }
  });
});

describe('boardRoots', () => {
  /** Same call on both twins, equal output. */
  const bothRoots = (key: string, opts: Opts = {}): string[] => {
    const a = tsTwin.boardRoots(key, opts);
    expect(mjsTwin.boardRoots(key, opts)).toEqual(a);
    return a;
  };

  it('returns the root of the entry and of every nested entry mapped to the board', () => {
    const parent = mk('ccv3');
    const app = mk('ccv3', 'apps', 'os');
    const other = mk('other');
    const registry = writeRegistry([
      entry('continuous-claude', parent),
      entry('Agentic OS', app, { laneBoard: 'continuous-claude' }),
      entry('Other', other),
    ]);
    const roots = bothRoots('continuous-claude', { registryPath: registry });
    expect(roots).toEqual([tsTwin.normalizeRoot(parent), tsTwin.normalizeRoot(app)]);
    expect(bothRoots('other', { registryPath: registry })).toEqual([tsTwin.normalizeRoot(other)]);
  });

  it('skips inactive entries and entries with an unusable path', () => {
    const live = mk('live');
    const dead = mk('dead');
    const registry = writeRegistry([
      entry('Live', live, { key: 'b' }),
      entry('Dead', dead, { key: 'b', status: 'inactive' }),
      entry('Rel', 'relative/path', { key: 'b' }),
      entry('Empty', '', { key: 'b' }),
    ]);
    expect(bothRoots('b', { registryPath: registry })).toEqual([tsTwin.normalizeRoot(live)]);
  });

  it('an unknown board, a missing registry and a board named by entry key (not board) give []', () => {
    const p = mk('p');
    const registry = writeRegistry([entry('App', p, { key: 'app', laneBoard: 'parent' })]);
    expect(bothRoots('nope', { registryPath: registry })).toEqual([]);
    expect(bothRoots('app', { registryPath: registry })).toEqual([]);
    expect(bothRoots('parent', { registryPath: registry })).toEqual([tsTwin.normalizeRoot(p)]);
    expect(bothRoots('p', { registryPath: path.join(tmp, 'nope.json') })).toEqual([]);
  });

  it('does not repeat a root and reads LANE_REGISTRY_PATH from opts.env', () => {
    const p = mk('p');
    const registry = writeRegistry([entry('P1', p, { key: 'x', laneBoard: 'b' }), entry('P2', p, { key: 'y', laneBoard: 'b' })]);
    expect(bothRoots('b', { env: { LANE_REGISTRY_PATH: registry } })).toEqual([tsTwin.normalizeRoot(p)]);
  });
});

describe('headless rule', () => {
  it('isHeadless: sdk entrypoint is headless unless LANE_CONTEXT_HEADLESS=1', () => {
    for (const t of [tsTwin, mjsTwin]) {
      expect(t.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toBe(true);
      expect(t.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toBe(true);
      expect(t.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', LANE_CONTEXT_HEADLESS: '1' })).toBe(false);
      expect(t.isHeadless({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe(false);
      expect(t.isHeadless({})).toBe(false);
    }
  });

  it('a headless hook gets no board', () => {
    const d = mk('d');
    const registry = writeRegistry([entry('D', d)]);
    expect(both(d, { registryPath: registry, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } })).toBeNull();
  });

  it('LANE_CONTEXT_HEADLESS=1 opts a headless hook back in', () => {
    const d = mk('d');
    const registry = writeRegistry([entry('D', d)]);
    const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', LANE_CONTEXT_HEADLESS: '1' };
    expect(both(d, { registryPath: registry, env })).toMatchObject({ key: 'd' });
  });

  it('cli=true ignores the headless rule; so does headlessOk', () => {
    const d = mk('d');
    const registry = writeRegistry([entry('D', d)]);
    const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
    expect(both(d, { registryPath: registry, env, cli: true })).toMatchObject({ key: 'd' });
    expect(both(d, { registryPath: registry, env, headlessOk: true })).toMatchObject({ key: 'd' });
  });
});

describe('CLI board selection (--project / LANE_PROJECT)', () => {
  it('--project selects a registered board from any cwd', () => {
    const a = mk('a');
    const b = mk('b');
    const registry = writeRegistry([entry('A', a), entry('B', b)]);
    const r = both(a, { registryPath: registry, cli: true, projectFlag: 'b' });
    expect(r).toMatchObject({ key: 'b', source: 'flag' });
  });

  it('LANE_PROJECT is used when there is no flag', () => {
    const a = mk('a');
    const b = mk('b');
    const registry = writeRegistry([entry('A', a), entry('B', b)]);
    const r = both(a, { registryPath: registry, cli: true, env: { LANE_PROJECT: 'b' } });
    expect(r).toMatchObject({ key: 'b', source: 'env' });
  });

  it('the flag beats LANE_PROJECT, and both beat the cwd', () => {
    const a = mk('a');
    const b = mk('b');
    const c = mk('c');
    const registry = writeRegistry([entry('A', a), entry('B', b), entry('C', c)]);
    const r = both(a, { registryPath: registry, cli: true, projectFlag: 'c', env: { LANE_PROJECT: 'b' } });
    expect(r).toMatchObject({ key: 'c', source: 'flag' });
  });

  it('an entry with laneBoard returns its board, and its board name is accepted too', () => {
    const p = mk('p');
    const app = mk('p', 'app');
    const registry = writeRegistry([entry('P', p), entry('App', app, { laneBoard: 'p' })]);
    expect(both(mk('x'), { registryPath: registry, cli: true, projectFlag: 'app' })).toMatchObject({ key: 'p', via: 'app' });
    expect(both(mk('x'), { registryPath: registry, cli: true, projectFlag: 'p' })).toMatchObject({ key: 'p' });
  });

  it('an unknown board throws and lists the registered keys', () => {
    const a = mk('a');
    const b = mk('b');
    const registry = writeRegistry([entry('A', a), entry('B', b)]);
    expect(bothThrow(a, { registryPath: registry, cli: true, projectFlag: 'zzz' })).toBe("unknown board 'zzz'; registered: a, b");
    expect(bothThrow(a, { registryPath: registry, cli: true, env: { LANE_PROJECT: 'nope' } })).toBe(
      "unknown board 'nope'; registered: a, b",
    );
  });

  it('an inactive entry is not a valid board', () => {
    const a = mk('a');
    const b = mk('b');
    const registry = writeRegistry([entry('A', a), entry('B', b, { status: 'inactive' })]);
    expect(bothThrow(a, { registryPath: registry, cli: true, projectFlag: 'b' })).toBe("unknown board 'b'; registered: a");
  });

  it('an empty registry still throws with a readable list', () => {
    expect(bothThrow(tmp, { registryPath: path.join(tmp, 'nope.json'), cli: true, projectFlag: 'a' })).toBe(
      "unknown board 'a'; registered: (none)",
    );
  });

  it('hooks (cli not set) ignore the flag and LANE_PROJECT', () => {
    const a = mk('a');
    const b = mk('b');
    const registry = writeRegistry([entry('A', a), entry('B', b)]);
    const r = both(a, { registryPath: registry, projectFlag: 'b', env: { LANE_PROJECT: 'b' } });
    expect(r).toMatchObject({ key: 'a', source: 'registry' });
  });

  it('a headless hook with LANE_PROJECT set still gets nothing', () => {
    const a = mk('a');
    const registry = writeRegistry([entry('A', a)]);
    expect(both(a, { registryPath: registry, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', LANE_PROJECT: 'a' } })).toBeNull();
  });
});
