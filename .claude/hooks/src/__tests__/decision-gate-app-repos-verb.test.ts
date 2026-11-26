/**
 * Fix round 6, fixer P. Dave's decision (2026-11-13, seat session, "Stop accidents, list the rest"): the gate stops ordinary commands
 * and mistakes; deliberate tricks go to Known limits. THE ONE RULE replaces the push word count: judge by the VERB of each git call
 * outside quotes.
 *
 * Ways it can fail (one row each; each R6 row names the change that breaks it):
 *   V1  verb push loses the strict reader (a plain push needs a tap, or a force push passes)
 *   V2  a commit message, a grep pattern or an echo text that holds push denies a command whose git verb is not push
 *   V3  a verb that is not a plain word (git pu${x}sh) passes, or a payload push (sh -c, eval) is a hard deny instead of the tap path
 *   V4  a force word of another command (test -f) beside a push is push-unsafe
 *   V5  an unread push (a global option the shape reader does not know) is a hard deny instead of the tap path
 *   I1  a review-router.config.json in the app repo shadows decisions.enforce of the home copy for a covered create or merge
 *   I2  a ~, $HOME, $env:USERPROFILE or %USERPROFILE% folder of a cd, -C or GIT_DIR misses a covered app repo from a CCv3 cwd
 *   I3  a throw in the push reader leaves a covered push allowed with no line
 *   W   a tap-path deny no tap can clear (a push not alone, an unread push) does not name the way out, or says no tap can be tied
 *   A   an inline -c alias.<n>=<value> whose value holds push is no push segment, so a force spelling beside it is not push-unsafe
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// I3 seam: mayRunUnderCmd runs only inside the push reader, so a throw there is a throw of the push reader. A cast, not a generic
// importOriginal type argument (CI semgrep).
const READER = vi.hoisted(() => ({ throws: false }));
vi.mock('../shared/shell-tools.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const mayRun = real.mayRunUnderCmd as (tool: string | undefined) => boolean;
  return { ...real, mayRunUnderCmd: (tool: string | undefined) => { if (READER.throws) throw new Error('push reader broke'); return mayRun(tool); } };
});

import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { readRegistry } from '../shared/tap-scope.js';
import { type Decision, type Deps } from '../decision-gate.js';
import { decideParsed, handleParsed } from './helpers/parse-first.js';

const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
const CCV3_URL = 'https://github.com/Rev4nchist/Continuous-Claude-v3.git';
const HOME = '/home/tester';
let scratch = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_GUARD_DECISIONS_LOG'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dg-verb-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = `${scratch}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
  READER.throws = false;
});
afterEach(() => {
  READER.throws = false;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

interface Folder { remotes: Record<string, string>; throwOn?: string[] }
const APP = '/work/app-x';
const CC = '/work/cc';
const HOME_APP = `${HOME}/app`;
const gh = (slug: string): Record<string, string> => ({ up: `https://github.com/${slug}.git` });
const FOLDERS: Record<string, Folder> = {
  [APP]: { remotes: gh('acme/app-x') },
  [HOME_APP]: { remotes: gh('acme/home-app') },
  [CC]: { remotes: { fork: CCV3_URL } },
  [`${HOME}/cc`]: { remotes: { fork: CCV3_URL } },
};
const REGISTRY = JSON.stringify({ projects: [{ key: 'app-x', path: APP }, { key: 'home-app', path: HOME_APP }] });
const BLOCK = JSON.stringify({ decisions: { enforce: true } });
/** enforceAppPush false: the tap path warns, a hard deny still denies. */
const SOFT = JSON.stringify({ decisions: { enforce: true, enforceAppPush: false } });
const TREES = new Set(['HEAD', 'feat', 'main', 'develop', 'topic']);

/** One fake git answer: on feat, remote up, refs/remotes/up/HEAD names develop. Status 1 for anything not listed. */
function answer(f: Folder, dir: string, a: string): { status: number; stdout: string } {
  const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
  const first = Object.keys(f.remotes)[0];
  if (a === 'remote -v') return ok(Object.entries(f.remotes).map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`).join('\n'));
  if (a === 'remote') return ok(Object.keys(f.remotes).join('\n'));
  if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${dir}\n${dir}/.git`);
  const url = /^remote get-url (?:--push (?:--all )?)?(?:--end-of-options )?(.+)$/.exec(a);
  if (url) return f.remotes[url[1]] ? ok(f.remotes[url[1]]) : { status: 2, stdout: '' };
  if (a === 'rev-parse --abbrev-ref @{push}') return ok(`${first}/feat`);
  if (a === 'rev-parse --symbolic-full-name @{push}') return ok(`refs/remotes/${first}/feat`);
  if (/^symbolic-ref --quiet --short refs\/remotes\/[^/]+\/HEAD$/.test(a)) return ok(`${first}/develop`);
  if (a === 'branch --show-current') return ok('feat');
  if (a === 'rev-parse HEAD' || /^rev-parse (?:--verify (?:--quiet )?)?(?:--end-of-options )?(?:feat|HEAD)\^\{commit\}$/.test(a)) return ok(HEAD);
  const t = /^rev-parse (?:--verify )?(?:--end-of-options )?(.+)\^\{tree\}$/.exec(a);
  if (t && TREES.has(t[1])) return ok(TREE);
  return { status: 1, stdout: '' };
}

function deps(config: string = BLOCK, appConfig: string | null = null, folders: Record<string, Folder> = FOLDERS): Deps {
  return {
    env: { ...process.env },
    home: HOME,
    readFile: (p) => {
      const f = p.replace(/\\/g, '/');
      if (f === `${APP}/review-router.config.json`) return appConfig;
      return f === `${HOME}/continuous-claude/review-router.config.json` ? config : null;
    },
    git: (cwd, args) => {
      const dir = cwd.replace(/\\/g, '/');
      const a = args.join(' ');
      const f = folders[dir];
      if (!f) return { status: 128, stdout: '' };
      if (f.throwOn?.includes(a)) throw new Error(`spawnSync git ETIMEDOUT (${a})`);
      return answer(f, dir, a);
    },
    tapScope: {
      registry: () => readRegistry({ path: '/reg/project-registry.json', deps: { readFile: () => REGISTRY, realpath: (p) => p } }),
      realpath: (p) => p,
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };
}
function tap(step: Step, key: string, label: string, tree?: string): void {
  expect(offerWrite({ step, key, head: HEAD, tree, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head: HEAD, label })).toEqual({ ok: true });
}
const bash = (command: string, cwd = APP, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's-verb', ...extra });
const pwsh = (command: string, cwd = APP) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd, session_id: 's-verb' });
const verdict = async (input: object, d: Deps = deps()): Promise<Decision> => await decideParsed(input, d);
type Out = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
const hookOut = async (input: object, d: Deps = deps()): Promise<Out> => JSON.parse(await handleParsed(JSON.stringify(input), d)).hookSpecificOutput ?? {};
/** The tap path with enforceAppPush false: the hook warns (no deny), scope app-push. */
async function warns(input: object, d: Deps = deps(SOFT)): Promise<void> {
  const v = await verdict(input, d);
  expect(v, JSON.stringify(input)).toMatchObject({ action: 'allow', scope: 'app-push' });
  expect(v.action === 'allow' ? v.warn : '', JSON.stringify(input)).toBeTruthy();
}

describe('R6-V1 verb push: the strict reader as today', () => {
  // Change that breaks it: judge a literal push verb by the raw word rule alone (no strict reading, no force test).
  it('R6-V1 git push up topic passes; git push up main takes the tap path; git push -f up topic is push-unsafe', async () => {
    expect(await verdict(bash('git push up topic'))).toEqual({ action: 'allow' });
    expect(await verdict(bash('git push up main'))).toMatchObject({ action: 'deny', pattern: 'ship', scope: 'app-push' });
    expect(await verdict(bash('git push -f up topic'), deps(SOFT))).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
});

describe('R6-V2 another literal git verb is no push: allowed in a covered folder', () => {
  // Change that breaks it: count the word push anywhere in a text that holds git (the round-5 rawVerdict).
  const rows = ["git add a && git commit -m 'push the fix'", "git commit -am 'push fix'", "grep -rn 'git push' docs", "echo 'run git push later'", 'git stash push', 'git log --grep push'];
  for (const cmd of rows) {
    it(`R6-V2 ${cmd}: allowed`, async () => { expect(await verdict(bash(cmd)), cmd).toEqual({ action: 'allow' }); });
  }
});

describe('R6-V3 a verb that is not a plain word, or a shell payload with git and push: the tap path, never a hard deny', () => {
  // Change that breaks it: read only the literal word push (git pu${x}sh passes with no line).
  it('R6-V3a git pu${x}sh up main: denied by default, scope app-push', async () => {
    expect(await verdict(bash('git pu${x}sh up main'))).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  // Change that breaks it: keep a payload or odd-verb push a hard deny (it denies whatever enforceAppPush says).
  for (const cmd of ['git pu${x}sh up main', "sh -c 'git push up topic'", "eval 'git push up topic'", 'git "push" up topic']) {
    it(`R6-V3b ${cmd}: warns when enforceAppPush is false (the tap path)`, async () => { await warns(bash(cmd)); });
  }
});

describe('R6-V4 a force word counts only in the segment of a git push call', () => {
  // Change that breaks it: read a force spelling anywhere in the raw text (test -f is a force word of test, not of the push).
  it('R6-V4a test -f x && git push up topic with a topic tap: still denied, on the tap path (round 3 C4)', async () => {
    // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown,
    // on the tap path. It is not a force word: the pattern is not push-unsafe.
    tap('ship', 'acme/app-x@topic', 'Commit and push', TREE);
    expect(await verdict(bash('test -f x && git push up topic'))).toMatchObject({ action: 'deny', pattern: 'push-state-unknown' });
  });
  it('R6-V4b test -f x && git push up topic with no tap: the tap path (warns when enforceAppPush is false)', async () => {
    await warns(bash('test -f x && git push up topic'));
  });
});

describe('R6-V5 an unread push takes the tap path; the hard denies stay', () => {
  // Change that breaks it: give an unread push (no shape reads it) the hard push-target-unresolved deny again.
  for (const cmd of ['git -p push up topic', 'doas git push up topic']) {
    it(`R6-V5a ${cmd}: warns when enforceAppPush is false`, async () => { await warns(bash(cmd)); });
  }
  // Change that breaks it: read only an unquoted git word (a quoted executable with an option PUSH_GIT does not read then has no call
  // and no shape: a silent pass). Red on the first round-6 tree, not on bd13cd0d.
  it('R6-V5c a quoted git executable: "git" -p push -f up main is push-unsafe; "git" -p push up topic warns when enforceAppPush is false', async () => {
    expect(await verdict(bash('"git" -p push -f up main'))).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
    await warns(bash('"git" -p push up topic'));
  });
  // Change that breaks it: send a hard deny to the tap path too.
  it('R6-V5b --repo, a subagent push and a force flag still deny when enforceAppPush is false', async () => {
    const d = deps(SOFT);
    expect(await verdict(bash('git push --repo https://github.com/acme/o.git up topic'), d)).toMatchObject({ action: 'deny', scope: 'app-push' });
    expect(await verdict(bash('git push up topic', APP, { agent_id: 's1' }), d)).toMatchObject({ action: 'deny', pattern: 'subagent' });
    expect(await verdict(bash('git push --force up topic'), d)).toMatchObject({ action: 'deny', pattern: 'push-unsafe' });
  });
});

/** The way out a tap-path deny names when no tap can clear the command as written (seat rulings a and b, 11-13). */
const WAY_OUT = 'run git push as its own command: git push <remote> <branch>';
const reasonOf = async (input: object): Promise<string> => { const v = await verdict(input); return v.action === 'deny' ? v.reason : ''; };

describe('R6-W the tap-path deny names the way out when no tap can clear the command', () => {
  // Change that breaks it: give a push with another command beside it the plain ship text (it tells Dave to tap "Push only",
  // and that tap never counts for a push that is not alone in its command).
  it('R6-Wa test -f x && git push up feat: the ship deny names the way out, never that no tap can be tied to it', async () => {
    // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown, on the tap path.
    expect(await verdict(bash('test -f x && git push up feat'))).toMatchObject({ action: 'deny', pattern: 'push-state-unknown', scope: 'app-push' });
    const why = await reasonOf(bash('test -f x && git push up feat'));
    expect(why).toContain(WAY_OUT);
    expect(why).not.toMatch(/no tap can be tied/i);
  });
  // Change that breaks it: give the not-alone text to every push that is neither alone nor chained (a leading git add makes
  // commitPrecedesPush false, but add, commit and push is the Commit and push flow, and its tap binds the staged tree).
  for (const cmd of ['git add -A && git commit -m fix && git push up feat', 'git add -A && git commit -m "push the fix" && git push up feat']) {
    it(`R6-Wc ${cmd}: push-state-unknown on the tap path, with the two-command way out (round 3 C4)`, async () => {
      // Round 3 C4 (Dave 2026-11-15, "Strict here, soft in apps"): a step before the push that the gate does not model is push-state-unknown,
      // on the tap path: git add before the commit changes the index the gate reads, so no tap clears it. The text names the two commands.
      expect(await verdict(bash(cmd))).toMatchObject({ action: 'deny', pattern: 'push-state-unknown', scope: 'app-push' });
      await warns(bash(cmd)); // the tap path: enforceAppPush false softens it (Dave 11-13)
      const why = await reasonOf(bash(cmd));
      expect(why).toContain('commit first, push in a separate command');
      expect(why).toContain(WAY_OUT);
    });
  }
  // Change that breaks it: count a git add with no commit as the Commit and push flow (the push sends HEAD, so that tap cannot clear it).
  it('R6-Wd git add -A && git push up feat (no commit): the not-alone text', async () => {
    expect(await reasonOf(bash('git add -A && git push up feat'))).toContain(WAY_OUT);
  });
  // Change that breaks it: keep the round-5 unread text ("No tap can be tied to it: ...").
  it('R6-Wb git -p push up topic: the unread deny names the way out, never that no tap can be tied to it', async () => {
    expect(await verdict(bash('git -p push up topic'))).toMatchObject({ action: 'deny', pattern: 'push-target-unresolved', scope: 'app-push' });
    const why = await reasonOf(bash('git -p push up topic'));
    expect(why).toContain(WAY_OUT);
    expect(why).not.toMatch(/no tap can be tied/i);
  });
});

describe('R6-A an inline -c alias.<n>=<value> whose value holds push is a push segment for the force test', () => {
  // Change that breaks it: count a segment for the force test only by its push calls and payloads (the alias call is no push call).
  it('R6-Aa git -c alias.x=push x -f up feat: push-unsafe, also when enforceAppPush is false', async () => {
    expect(await verdict(bash('git -c alias.x=push x -f up feat'))).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
    expect(await verdict(bash('git -c alias.x=push x -f up feat'), deps(SOFT))).toMatchObject({ action: 'deny', pattern: 'push-unsafe', scope: 'app-push' });
  });
  // Change that breaks it: make every alias push a hard deny (it denies whatever enforceAppPush says).
  it('R6-Ab git -c alias.x=push x up feat with no force spelling: the tap path (warns when enforceAppPush is false)', async () => {
    await warns(bash('git -c alias.x=push x up feat'));
  });
});

describe('R6-I1 a covered create or merge reads decisions.enforce from the home copy only', () => {
  // Change that breaks it: read decisions.enforce from the payload cwd upward for a covered folder (router-config lookup).
  const CREATE = 'gh pr create --draft --head feat --title t';
  const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
  for (const cmd of [CREATE, MERGE, `popd && ${CREATE}`]) {
    it(`R6-I1a ${cmd} with an app-repo config that has no enforce: denied`, async () => {
      expect(await verdict(bash(cmd), deps(BLOCK, '{}')), cmd).toMatchObject({ action: 'deny', scope: 'other' });
    });
  }
  it('R6-I1b a covered create whose coverage git throws, with an app-repo config that has no enforce: the hook denies', async () => {
    const f = { ...FOLDERS, [APP]: { ...FOLDERS[APP], throwOn: ['rev-parse --path-format=absolute --show-toplevel --git-common-dir'] } };
    expect((await hookOut(bash(CREATE), deps(SOFT, '{}', f))).permissionDecision).toBe('deny');
  });
  it('R6-I1c CCv3 keeps the cwd-upward lookup (no tapScope change): a CCv3 create with no enforce anywhere warns', async () => {
    const v = await verdict(bash(CREATE, CC), deps('{}'));
    expect(v).toMatchObject({ action: 'allow', scope: 'other' });
  });
});

describe('R6-I2 a home folder (~, $HOME, $env:USERPROFILE, %USERPROFILE%) is expanded for the coverage test', () => {
  // Change that breaks it: drop every unexpanded folder before the coverage test (the CCv3 cwd then decides: scope push, warn).
  const rows: [string, object][] = [
    ['cd ~', bash('cd ~/app && git push -f up main', CC)],
    ['-C ~', bash('git -C ~/app push -f up main', CC)],
    ['GIT_DIR ~', bash('GIT_DIR=~/app/.git git push -f up main', CC)],
    ['cd $HOME', bash('cd $HOME/app && git push -f up main', CC)],
    ['cd %USERPROFILE%', bash('cd %USERPROFILE%/app && git push -f up main', CC)],
    ['cd $env:USERPROFILE', pwsh('cd $env:USERPROFILE/app; git push -f up main', CC)],
  ];
  for (const [name, input] of rows) {
    it(`R6-I2a ${name} from a CCv3 cwd, a force push into the covered home app: denied even with enforceAppPush false`, async () => {
      expect((await hookOut(input, deps(SOFT))).permissionDecision, name).toBe('deny');
      expect(await verdict(input, deps(SOFT)), name).toMatchObject({ action: 'deny', scope: 'app-push' });
    });
  }
  // G4: a CCv3 target keeps the base deny and text.
  it('R6-I2b cd ~/cc (a CCv3 checkout) from a CCv3 cwd: the base cd-unexpanded deny, scope push, base text', async () => {
    const v = await verdict(bash('cd ~/cc && git push fork feat', CC), deps(BLOCK));
    expect(v).toMatchObject({ action: 'allow', scope: 'push' });
    expect(v.action === 'allow' ? v.warn : '').toMatch(/^cd-unexpanded: /);
    expect(v.action === 'allow' ? v.warn : '').not.toMatch(/judged for Dave's tap/);
  });
  // Change that breaks it: judge the known folders with coveredAmong again (it stops at the CCv3 cwd, so the covered folder beside the
  // value is never tested: scope push, warn). Red on the first round-6 tree, not on bd13cd0d (there it was hard-denied by the word count).
  it('R6-I2d cd /work/app-x && cd $D && git push up main from a CCv3 cwd: the app-push tap path; cd $D alone keeps the base deny', async () => {
    expect(await verdict(bash('cd /work/app-x && cd $D && git push up main', CC))).toMatchObject({ action: 'deny', pattern: 'cd-unexpanded', scope: 'app-push' });
    const base = await verdict(bash('cd $D && git push fork feat', CC));
    expect(base).toMatchObject({ action: 'allow', scope: 'push' });
    expect(base.action === 'allow' ? base.warn : '').not.toMatch(/judged for Dave's tap/);
  });
  // Change that breaks it: keep the cd-unexpanded deny of a covered folder hard (it denies whatever enforceAppPush says).
  it('R6-I2c cd $D && git push up topic from a covered cwd: the tap path (warns when enforceAppPush is false)', async () => {
    await warns(bash('cd $D && git push up topic'));
    expect(await verdict(bash('cd $D && git push up topic'))).toMatchObject({ action: 'deny', pattern: 'cd-unexpanded', scope: 'app-push' });
  });
});

describe('R6-I3 a throw in the push reader is a push off the list: the tap path', () => {
  // Change that breaks it: let gatedScopes and pushUnderLiveRoot swallow the reader throw (no scope: the call passes with no line).
  it('R6-I3a covered folder: the hook denies by default', async () => {
    READER.throws = true;
    const out = await hookOut(bash('git push up main'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain("could not verify Dave's tap");
  });
  it('R6-I3b covered folder, enforceAppPush false: the hook warns (tap path, not a hard deny)', async () => {
    READER.throws = true;
    const out = await hookOut(bash('git push up main'), deps(SOFT));
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/^WARNING \(decision-gate, warn mode\)/);
  });
  it('R6-I3c a CCv3 cwd keeps the base output ({})', async () => {
    READER.throws = true;
    expect(await handleParsed(JSON.stringify(bash('git push fork feat', CC)), deps())).toBe('{}');
  });
});
