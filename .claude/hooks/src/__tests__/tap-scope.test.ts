/**
 * shared/tap-scope.ts: the coverage reader of rule R2 (card coord-decision-gate-app-repos; seat answers S2, S5, S6).
 * Every file access goes through injected functions, so no test reads the real registry mirror or the real home.
 *
 * How it can fail, and the source change that turns a case red:
 *   P1 the registry path order is wrong (argument, then LANE_REGISTRY_PATH, then <home>/.claude)      -> swap the order
 *   P2 a missing file reads as corrupt, or an unreadable / bad file reads as missing (S5: never silent) -> merge the two states
 *   P3 a BOM makes a good file corrupt                                                                -> remove the BOM strip
 *   R1 a CCv3 checkout gets any other reason (G4 needs CCv3 stdout byte-equal)                        -> move the isCcv3 test below the registry state
 *   R2 a folder under or above an entry root is covered (prefix match as in lane-board)              -> isUnder in place of equality
 *   R3 an inactive or off entry falls through to the live parent of a worktree                       -> skip a not-live entry in the walk
 *   R4 a status other than inactive is not live, or 'Inactive' is live                               -> compare status without lower case
 *   R5 tapGate 'off' in another case is ignored, or another value switches the gate off              -> exact match or truthy test
 *   R6 the continuous-claude entry is covered                                                        -> drop the ccv3-root test
 *   R7 the same folder in two spellings does not match (\ vs /, /c/ vs c:/, drive case, trailing /) -> drop a normalise step
 *   R8 a POSIX path loses its case (Linux CI)                                                        -> lower-case every path
 *   R9 a symlinked or junction folder does not match its real root, or a realpath error throws       -> drop realpath or its catch
 *   R10 an empty toplevel matches an entry with no usable path                                      -> keep entries with root ''
 *   F8 a network root is resolved, or every root is resolved at read time; the path test matches by string prefix, counts a root
 *      that is not live, or misses a linked worktree outside its root -> realpath in entryOf or on // and \\; startsWith; drop the walk
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverageOf, keyRepo, normPath, oneLine, readRegistry, repoSlug, underLiveRoot, type Registry } from '../shared/tap-scope.js';
// @ts-ignore TS7016: repo-identity.mjs has no declaration file.
import * as identityModule from '../../../../scripts/github/lib/repo-identity.mjs';

process.env.CCV3_DECISIONS_FILE = '/nonexistent-scratch/decisions.json';
process.env.LANE_REGISTRY_PATH = '/nonexistent-scratch/project-registry.json';

const slash = (p: string): string => p.replace(/\\/g, '/');
const errno = (code: string): Error => Object.assign(new Error(code), { code });
const fileOf = (text: string) => (): string => text;
const identity = (p: string): string => p;
const regJson = (projects: unknown): string => JSON.stringify({ projects });
const reg = (projects: unknown): Registry => readRegistry({ path: '/r.json', deps: { readFile: fileOf(regJson(projects)), realpath: identity } });

const APP = { name: 'App', key: 'app', path: 'D:/Work/App', status: 'active' };

describe('readRegistry path order', () => {
  const seen = (opts: Parameters<typeof readRegistry>[0]): string => {
    let read = '';
    readRegistry({ ...opts, deps: { ...opts?.deps, readFile: (p) => { read = p; throw errno('ENOENT'); } } });
    return slash(read);
  };
  it('P1 the argument wins over LANE_REGISTRY_PATH', () => {
    expect(seen({ path: '/a/reg.json', env: { LANE_REGISTRY_PATH: '/b/reg.json', HOME: '/h' } })).toBe('/a/reg.json');
  });
  it('P1 LANE_REGISTRY_PATH wins over the home copy', () => {
    expect(seen({ env: { LANE_REGISTRY_PATH: '/b/reg.json', USERPROFILE: '/u', HOME: '/h' } })).toBe('/b/reg.json');
  });
  it('P1 with neither, <home>/.claude/project-registry.json (USERPROFILE, then HOME)', () => {
    expect(seen({ env: { USERPROFILE: '/u', HOME: '/h' } })).toBe('/u/.claude/project-registry.json');
    expect(seen({ env: { HOME: '/h' } })).toBe('/h/.claude/project-registry.json');
  });
  it('P1 the result names the file it read', () => {
    const r = readRegistry({ env: { LANE_REGISTRY_PATH: '/b/reg.json' }, deps: { readFile: () => { throw errno('ENOENT'); } } });
    expect(slash(r.file)).toBe('/b/reg.json');
  });
});

describe('readRegistry state', () => {
  const state = (readFile: (p: string) => string) => readRegistry({ path: '/r.json', deps: { readFile, realpath: identity } });
  it('P2 ENOENT is missing', () => {
    expect(state(() => { throw errno('ENOENT'); })).toEqual({ state: 'missing', entries: [], file: '/r.json' });
  });
  it('P2 any other read error is corrupt', () => {
    expect(state(() => { throw errno('EACCES'); }).state).toBe('corrupt');
    expect(state(() => { throw errno('EISDIR'); }).state).toBe('corrupt');
  });
  it('P2 bad JSON, null, no projects array are corrupt', () => {
    for (const text of ['{', 'null', '[]', '{}', '{"projects":{}}', '"x"']) expect(state(fileOf(text)).state, text).toBe('corrupt');
  });
  it('P3 a BOM before the JSON is ok', () => {
    expect(state(fileOf(`\uFEFF${regJson([APP])}`)).state).toBe('ok');
  });
  // Fix round 1 (F5): the github field rides along. Change that breaks it: entryOf drops github (the gate then keys an alias remote as local:).
  it('entries keep key, root, status, tapGate and github; a bad entry is skipped', () => {
    const r = reg([APP, { name: 'My Tool', path: 'E:\\Tools\\My Tool\\', tapGate: 'off', github: 'Acme/Tool' }, { key: 'rel', path: 'relative/dir' }, null, 'x', { key: 'nopath' }]);
    expect(r.state).toBe('ok');
    expect(r.entries).toEqual([
      { key: 'app', root: 'd:/work/app', status: 'active', tapGate: null, github: null },
      { key: 'my-tool', root: 'e:/tools/my tool', status: 'active', tapGate: 'off', github: 'Acme/Tool' },
    ]);
  });
  it('a covered entry gives its github field to the gate', () => {
    expect(coverageOf({ toplevel: 'D:/Work/App', isCcv3: false }, reg([{ ...APP, github: 'Acme/App' }]), { realpath: identity }).github).toBe('Acme/App');
  });
  it('the default deps read a real file (a temp folder, never the home)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tap-scope-'));
    try {
      const file = join(dir, 'project-registry.json');
      writeFileSync(file, regJson([APP]));
      expect(readRegistry({ path: file }).state).toBe('ok');
      expect(readRegistry({ path: join(dir, 'none.json') }).state).toBe('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coverageOf', () => {
  const live = reg([APP]);
  const cover = (toplevel: string, registry: Registry = live, worktreeMainRoot: string | null = null, isCcv3 = false) =>
    coverageOf({ toplevel, worktreeMainRoot, isCcv3 }, registry, { realpath: identity });

  it('R1 a CCv3 checkout is ccv3 first, before a missing or corrupt registry', () => {
    const corrupt = readRegistry({ path: '/r.json', deps: { readFile: fileOf('{') } });
    const missing = readRegistry({ path: '/r.json', deps: { readFile: () => { throw errno('ENOENT'); } } });
    for (const r of [live, corrupt, missing]) expect(cover('D:/Work/App', r, null, true)).toEqual({ covered: false, entryKey: null, reason: 'ccv3' });
  });
  it('S5 a missing and a corrupt registry each have their own reason', () => {
    const corrupt = readRegistry({ path: '/r.json', deps: { readFile: fileOf('{') } });
    const missing = readRegistry({ path: '/r.json', deps: { readFile: () => { throw errno('ENOENT'); } } });
    expect(cover('D:/Work/App', missing)).toEqual({ covered: false, entryKey: null, reason: 'registry-missing' });
    expect(cover('D:/Work/App', corrupt)).toEqual({ covered: false, entryKey: null, reason: 'registry-corrupt' });
  });
  it('a toplevel equal to a live entry root is covered', () => {
    expect(cover('D:/Work/App')).toEqual({ covered: true, entryKey: 'app', reason: 'covered', github: null });
  });
  it('R2 a repo under an entry root, or above it, is not covered', () => {
    expect(cover('D:/Work/App/sub')).toEqual({ covered: false, entryKey: null, reason: 'no-entry' });
    expect(cover('D:/Work')).toEqual({ covered: false, entryKey: null, reason: 'no-entry' });
    expect(cover('D:/Work/Apple')).toEqual({ covered: false, entryKey: null, reason: 'no-entry' });
  });
  it('a worktree whose main root is an entry root is covered', () => {
    expect(cover('D:/Work/App/.claude/worktrees/x', live, 'D:/Work/App')).toEqual({ covered: true, entryKey: 'app', reason: 'covered', github: null });
    expect(cover('D:/elsewhere/wt', live, 'D:/Work/App')).toEqual({ covered: true, entryKey: 'app', reason: 'covered', github: null });
  });
  it('R3 the nearest entry stops the walk: inactive or off at the toplevel never falls to the live main root', () => {
    const nested = (extra: object) => reg([APP, { key: 'wt', path: 'D:/Work/App/wt', ...extra }]);
    expect(cover('D:/Work/App/wt', nested({ status: 'inactive' }), 'D:/Work/App')).toEqual({ covered: false, entryKey: 'wt', reason: 'inactive' });
    expect(cover('D:/Work/App/wt', nested({ tapGate: 'off' }), 'D:/Work/App')).toEqual({ covered: false, entryKey: 'wt', reason: 'off' });
  });
  it('R4 status inactive in any case is not live; every other status is live', () => {
    for (const status of ['inactive', 'Inactive', 'INACTIVE']) expect(cover('D:/Work/App', reg([{ ...APP, status }])).reason, status).toBe('inactive');
    for (const status of ['active', 'in-development', 'archived', 7, undefined]) {
      expect(cover('D:/Work/App', reg([{ ...APP, status }])).reason, String(status)).toBe('covered');
    }
  });
  it('R5 tapGate off in any case switches the gate off; any other value does not', () => {
    for (const tapGate of ['off', 'OFF', ' Off ']) expect(cover('D:/Work/App', reg([{ ...APP, tapGate }])).reason, tapGate).toBe('off');
    for (const tapGate of ['on', '', 'of', true, false, 0, null]) {
      expect(cover('D:/Work/App', reg([{ ...APP, tapGate }])).reason, String(tapGate)).toBe('covered');
    }
  });
  it('R6 the continuous-claude entry is never covered', () => {
    const ccv3 = reg([{ key: 'continuous-claude', path: 'C:/Users/me/continuous-claude', status: 'active' }]);
    expect(cover('C:/Users/me/continuous-claude', ccv3)).toEqual({ covered: false, entryKey: 'continuous-claude', reason: 'ccv3-root' });
    expect(cover('C:/x/wt', ccv3, 'C:/Users/me/continuous-claude').reason).toBe('ccv3-root');
  });
  it('R7 the same Windows folder in other spellings matches', () => {
    for (const p of ['d:\\work\\app', 'D:\\Work\\App\\', '/d/Work/App', 'D:/WORK/APP/', 'D:/Work//App', '//?/D:/Work/App']) {
      expect(cover(p).reason, p).toBe('covered');
    }
  });
  it('R8 a POSIX path keeps its case', () => {
    const posix = reg([{ key: 'svc', path: '/srv/App' }]);
    expect(cover('/srv/App', posix).reason).toBe('covered');
    expect(cover('/srv/app', posix).reason).toBe('no-entry');
    expect(cover('/srv/App/', posix).reason).toBe('covered');
  });
  it('R9 realpath maps a link to its real root; a realpath error keeps the raw path', () => {
    const realpath = (p: string): string => {
      if (slash(p) === 'L:/link') return 'D:\\Work\\App';
      throw errno('ENOENT');
    };
    const r = readRegistry({ path: '/r.json', deps: { readFile: fileOf(regJson([APP])), realpath } });
    expect(coverageOf({ toplevel: 'L:/link', isCcv3: false }, r, { realpath }).reason).toBe('covered');
    expect(coverageOf({ toplevel: 'D:/Work/App', isCcv3: false }, r, { realpath }).reason).toBe('covered');
  });
  it('R9 coverageOf works with two arguments (default realpath, a folder that does not exist)', () => {
    expect(coverageOf({ toplevel: 'Q:/no/such/folder', isCcv3: false }, live).reason).toBe('no-entry');
  });
  it('R10 an empty toplevel is never covered', () => {
    expect(cover('', reg([APP, { key: 'blank', path: '' }])).reason).toBe('no-entry');
  });
  it('the first of two entries with the same root decides', () => {
    expect(cover('D:/Work/App', reg([APP, { ...APP, key: 'app2', tapGate: 'off' }]))).toEqual({ covered: true, entryKey: 'app', reason: 'covered', github: null });
    expect(cover('D:/Work/App', reg([{ ...APP, status: 'inactive' }, { ...APP, key: 'app2' }])).reason).toBe('inactive');
  });
});

describe('F8 network roots and the no-git path test (fix round 1)', () => {
  const NAS = { key: 'nas', path: '\\\\nas\\share\\app' };
  const NAS2 = { key: 'nas2', path: '//nas2/x' };
  /** A realpath that records each call and throws on a network path, as a stalled share would never return. */
  const recorder = () => {
    const seen: string[] = [];
    const realpath = (p: string): string => {
      seen.push(slash(p));
      if (/^[\\/]{2}/.test(p)) throw new Error(`realpath on a network path: ${p}`);
      return p;
    };
    return { seen, realpath };
  };
  const regOf = (projects: unknown, realpath: (p: string) => string): Registry => readRegistry({ path: '/r.json', deps: { readFile: fileOf(regJson(projects)), realpath } });
  const noFile = (): string => { throw errno('ENOENT'); };
  // Change that breaks it: realpath every entry root in readRegistry (entryOf), or realpath a root that starts with // or \\.
  it('readRegistry runs no realpath; coverageOf and underLiveRoot never realpath a network root', () => {
    const { seen, realpath } = recorder();
    const r = regOf([NAS, NAS2, APP], realpath);
    expect(seen).toEqual([]);
    expect(r.entries.map((e) => e.root)).toEqual(['//nas/share/app', '//nas2/x', 'd:/work/app']);
    expect(coverageOf({ toplevel: 'Q:/stray', isCcv3: false }, r, { realpath }).reason).toBe('no-entry');
    expect(underLiveRoot('Q:/stray', r, { realpath, readFile: noFile })).toBe(false);
    expect(seen.filter((p) => p.startsWith('//'))).toEqual([]);
  });
  it('a network root still matches by its raw path, with no realpath at all', () => {
    const { seen, realpath } = recorder();
    const r = regOf([NAS], realpath);
    expect(coverageOf({ toplevel: '\\\\nas\\share\\app', isCcv3: false }, r, { realpath }).reason).toBe('covered');
    expect(underLiveRoot('//nas/share/app/src', r, { realpath, readFile: noFile })).toBe(true);
    expect(seen).toEqual([]);
  });
  // Change that breaks it: realpath the entry roots before the raw compare.
  it('a raw match needs no realpath of an entry root; an entry root is resolved only when no raw match exists', () => {
    const { seen, realpath } = recorder();
    const r = regOf([APP, { key: 'b', path: 'D:/Work/B' }], realpath);
    expect(coverageOf({ toplevel: 'D:/Work/App', isCcv3: false }, r, { realpath }).reason).toBe('covered');
    expect(seen).toEqual([]);
    const link = (p: string): string => (slash(p).toLowerCase() === 'd:/work/b' ? 'E:/real/B' : p);
    expect(coverageOf({ toplevel: 'E:/real/B', isCcv3: false }, regOf([APP, { key: 'b', path: 'D:/Work/B' }], link), { realpath: link }).entryKey).toBe('b');
  });
  // Change that breaks it: a string startsWith in place of a path-segment prefix, or inactive / off / continuous-claude roots counted.
  it('underLiveRoot: a live root at or above the folder, by path segment; inactive, off and continuous-claude roots do not count', () => {
    const r = regOf([APP, { key: 'old', path: 'D:/Old', status: 'inactive' }, { key: 'off', path: 'D:/Off', tapGate: 'off' }, { key: 'continuous-claude', path: 'C:/cc' }], identity);
    const at = (dir: string) => underLiveRoot(dir, r, { realpath: identity, readFile: noFile });
    expect([at('D:/Work/App'), at('d:\\work\\app\\src'), at('D:/Work/Apple'), at('D:/Work'), at('D:/Old/x'), at('D:/Off'), at('C:/cc/x')]).toEqual([true, true, false, false, false, false, false]);
  });
  it('underLiveRoot: outsideCcv3 also refuses a live root inside the continuous-claude root', () => {
    const r = regOf([{ key: 'continuous-claude', path: 'C:/cc' }, { key: 'agentic', path: 'C:/cc/apps/agentic' }], identity);
    expect(underLiveRoot('C:/cc/apps/agentic', r, { realpath: identity, readFile: noFile })).toBe(true);
    expect(underLiveRoot('C:/cc/apps/agentic', r, { realpath: identity, readFile: noFile }, { outsideCcv3: true })).toBe(false);
  });
  // Change that breaks it: drop the .git file walk (a linked worktree outside its root is then never covered).
  it('underLiveRoot: a linked worktree outside the root is found through its .git file and commondir, with no git process', () => {
    const files: Record<string, string> = { 'e:/wt/.git': 'gitdir: D:/Work/App/.git/worktrees/wt\n', 'd:/work/app/.git/worktrees/wt/commondir': '../..\n' };
    const readFile = (p: string): string => { const t = files[slash(p).toLowerCase()]; if (t === undefined) throw errno('ENOENT'); return t; };
    const r = regOf([APP], identity);
    expect(underLiveRoot('E:/wt/sub', r, { realpath: identity, readFile })).toBe(true);
    expect(underLiveRoot('E:/other', r, { realpath: identity, readFile })).toBe(false);
  });
  it('underLiveRoot: a missing or corrupt registry is false', () => {
    const missing = readRegistry({ path: '/r.json', deps: { readFile: noFile } });
    const corrupt = readRegistry({ path: '/r.json', deps: { readFile: fileOf('{') } });
    for (const r of [missing, corrupt]) expect(underLiveRoot('D:/Work/App', r, { realpath: identity, readFile: noFile })).toBe(false);
  });
});

describe('normPath', () => {
  it('R7/R8 forward slashes, /c/ to c:/, lower case on drive paths only, no trailing slash', () => {
    expect(normPath('C:\\Users\\Me\\')).toBe('c:/users/me');
    expect(normPath('/c/Users/Me')).toBe('c:/users/me');
    expect(normPath('/srv/Mixed/Case/')).toBe('/srv/Mixed/Case');
    expect(normPath('/')).toBe('/');
  });
});

describe('normPath is one rule (fix round 1)', () => {
  // Change that breaks it: a second normaliser in tap-scope.ts (app-ask.mjs imports the repo-identity.mjs one).
  it('tap-scope normPath IS the repo-identity.mjs function, and folds /c/x, C:\\x and //x as app-ask does', () => {
    expect(normPath).toBe(identityModule.normPath);
    expect([normPath('/c/x'), normPath('C:\\x'), normPath('c:/x/'), normPath('//nas/x/'), normPath('\\\\nas\\x')]).toEqual(['c:/x', 'c:/x', 'c:/x', '//nas/x', '//nas/x']);
  });
});

describe('repo-identity door', () => {
  it('the typed door gives the functions of scripts/github/lib/repo-identity.mjs', () => {
    expect(repoSlug('git@github.com:Acme/App.git')).toBe('acme/app');
    expect(keyRepo({ url: null, entryKey: 'app' })).toBe('local:app');
    expect(oneLine('a\nb', 10)).toBe('a b');
  });
});

// Seat review 1, item 4: a registry that does not parse is read once more (a write in progress); a missing file named by
// LANE_REGISTRY_PATH is marked, so the gate shows its notice. Change that breaks it: no retry; envPath set for the argument or home path.
describe('readRegistry retry and envPath (seat review 1, item 4)', () => {
  const counted = (texts: (string | Error)[]) => {
    let n = 0;
    const readFile = (): string => { const t = texts[Math.min(n++, texts.length - 1)]; if (t instanceof Error) throw t; return t; };
    return { readFile, reads: () => n };
  };
  it('a bad read then a good read is ok, after two reads', () => {
    const f = counted(['{"projects":[', regJson([APP])]);
    expect(readRegistry({ path: '/r.json', deps: { readFile: f.readFile } }).state).toBe('ok');
    expect(f.reads()).toBe(2);
  });
  it('two bad reads are corrupt, after two reads; an EACCES is retried too', () => {
    const f = counted(['{']);
    expect(readRegistry({ path: '/r.json', deps: { readFile: f.readFile } }).state).toBe('corrupt');
    expect(f.reads()).toBe(2);
    const g = counted([errno('EACCES'), regJson([APP])]);
    expect(readRegistry({ path: '/r.json', deps: { readFile: g.readFile } }).state).toBe('ok');
  });
  it('a good file and a missing file are read once', () => {
    const f = counted([regJson([APP])]);
    readRegistry({ path: '/r.json', deps: { readFile: f.readFile } });
    expect(f.reads()).toBe(1);
    const m = counted([errno('ENOENT')]);
    readRegistry({ path: '/r.json', deps: { readFile: m.readFile } });
    expect(m.reads()).toBe(1);
  });
  it('envPath is true only for a file named by LANE_REGISTRY_PATH', () => {
    const missing = () => { throw errno('ENOENT'); };
    expect(readRegistry({ env: { LANE_REGISTRY_PATH: '/b/reg.json' }, deps: { readFile: missing } }).envPath).toBe(true);
    expect(readRegistry({ path: '/a/reg.json', env: { LANE_REGISTRY_PATH: '/b/reg.json' }, deps: { readFile: missing } }).envPath).toBeUndefined();
    expect(readRegistry({ env: { HOME: '/h' }, deps: { readFile: missing } }).envPath).toBeUndefined();
  });
});
