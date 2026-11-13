/**
 * Fix round 5, fixer N. Dave's decision (2026-11-13, relayed by the seat): "Hard denies always deny". A literal false of
 * decisions.enforceAppPush in <home>/continuous-claude/review-router.config.json softens ONLY the tap path of an app push (a push to a
 * default branch, a push form off the strict list, the reasons a push needs a tap). Every other app-push deny stays a deny.
 *
 * Ways it can fail (one row each):
 *   H1  a force spelling (flag, short bundle, + refspec, inside sh -c) warns when the flag is false
 *   H2  a subagent push warns when the flag is false
 *   H3  a mirror or + remote.<r>.push config warns
 *   H4  push config or a command option that widens the push (push.followTags, --follow-tags, -c push.*) warns
 *   H5  --repo warns
 *   H6  an unknown git global option before push, or a push no shape reads (sh -c), warns
 *   H7  a short bundle with o warns
 *   H8  the other app-push denies that are no tap path (two push URLs, position unknown) warn
 *   H9  the catch (a git throw) warns for a force push or a subagent push when the flag is false
 *   S1  the tap path no longer warns (over-correction): a default-branch push, a push off the strict list, a tree-read throw
 *   S2  a hard deny text names the flag
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRegistry } from '../shared/tap-scope.js';
import { decide, handle, type Decision, type Deps } from '../decision-gate.js';

const TREE = 't'.repeat(40);
const HEAD = 'a'.repeat(40);
let scratch = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_GUARD_DECISIONS_LOG'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dg-hard-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = `${scratch}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

interface Folder {
  remotes: Record<string, string>; pushUrls?: Record<string, string[]>; config?: string; pushRef?: string; throwOn?: string[];
}
const APP = '/work/app-x';
const URL = 'https://github.com/acme/app-x.git';
const TREES = new Set(['HEAD', 'feat', 'main', 'develop', 'topic', 'release']);
const REGISTRY = JSON.stringify({ projects: [{ key: 'app-x', path: APP }] });
/** The router config at <home>/continuous-claude: enforce on, enforceAppPush the literal false. */
const OFF = JSON.stringify({ decisions: { enforce: true, enforcePush: false, enforceAppPush: false } });

/** One fake git answer for /work/app-x: on feat, remote up, refs/remotes/up/HEAD names develop. Status 1 for anything not listed. */
function answer(f: Folder, a: string): { status: number; stdout: string } {
  const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
  if (a === 'remote -v') return ok(Object.entries(f.remotes).map(([n, u]) => `${n}\t${u} (fetch)\n${n}\t${u} (push)`).join('\n'));
  if (a === 'remote') return ok(Object.keys(f.remotes).join('\n'));
  if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${APP}\n${APP}/.git`);
  const ga = /^remote get-url --push --all (.+)$/.exec(a);
  if (ga) return ok((f.pushUrls?.[ga[1]] ?? [f.remotes[ga[1]]]).join('\n'));
  const gp = /^remote get-url --push (.+)$/.exec(a);
  if (gp) return ok((f.pushUrls?.[gp[1]] ?? [f.remotes[gp[1]]])[0]);
  const gu = /^remote get-url (.+)$/.exec(a);
  if (gu && f.remotes[gu[1]]) return ok(f.remotes[gu[1]]);
  if (a === 'rev-parse --abbrev-ref @{push}') return f.pushRef ? ok(f.pushRef) : { status: 128, stdout: '' };
  if (a === 'rev-parse --symbolic-full-name @{push}') return f.pushRef ? ok(`refs/remotes/${f.pushRef}`) : { status: 128, stdout: '' };
  if (/^symbolic-ref --quiet --short refs\/remotes\/up\/HEAD$/.test(a)) return ok('up/develop');
  if (a.startsWith('config --get-regexp ')) return f.config === undefined ? { status: 1, stdout: '' } : ok(f.config);
  if (a === 'branch --show-current') return ok('feat');
  if (a === 'rev-parse HEAD') return ok(HEAD);
  const t = /^rev-parse (.+)\^\{tree\}$/.exec(a);
  if (t && TREES.has(t[1].replace(/^refs\/heads\//, ''))) return ok(TREE);
  return { status: 1, stdout: '' };
}

function deps(f: Partial<Folder> = {}, config: string = OFF): Deps {
  const folder: Folder = { remotes: { up: URL }, ...f };
  return {
    env: { ...process.env },
    home: '/home/tester',
    readFile: (p) => (p.replace(/\\/g, '/') === '/home/tester/continuous-claude/review-router.config.json' ? config : null),
    git: (cwd, args) => {
      const a = args.join(' ');
      if (cwd.replace(/\\/g, '/') !== APP) return { status: 128, stdout: '' };
      if (folder.throwOn?.includes(a)) throw new Error(`spawnSync git ETIMEDOUT (${a})`);
      return answer(folder, a);
    },
    tapScope: {
      registry: () => readRegistry({ path: '/reg/project-registry.json', deps: { readFile: () => REGISTRY, realpath: (p) => p } }),
      realpath: (p) => p,
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };
}
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: APP, ...extra });
const verdict = (input: object, f?: Partial<Folder>): Decision => decide(input, deps(f));
const unsafe = { action: 'deny', pattern: 'push-unsafe', scope: 'app-push' };
const unresolved = { action: 'deny', pattern: 'push-target-unresolved', scope: 'app-push' };
/** The hook stdout of a call with the flag false. */
const hookOut = (input: object, f?: Partial<Folder>): { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } =>
  JSON.parse(handle(JSON.stringify(input), deps(f))).hookSpecificOutput ?? {};

describe('Dave 11-13 "Hard denies always deny": enforceAppPush false keeps every hard deny of an app push', () => {
  // Change that breaks H1 to H8: let decide() consult the enforceAppPush flag for every app-push deny (the round-5 head did).
  it('H1a a force flag: git push --force up topic is push-unsafe', () => {
    expect(verdict(bash('git push --force up topic'))).toMatchObject(unsafe);
  });
  it('H1b a force letter in a short bundle: git push -fu up topic is push-unsafe', () => {
    expect(verdict(bash('git push -fu up topic'))).toMatchObject(unsafe);
  });
  it('H1c a + refspec: git push up +topic is push-unsafe', () => {
    expect(verdict(bash('git push up +topic'))).toMatchObject(unsafe);
  });
  it('H1d a force spelling inside sh -c (the raw rule) is push-unsafe', () => {
    expect(verdict(bash("sh -c 'git push -f up topic'"))).toMatchObject(unsafe);
  });
  it('H1e an unsafe long-option prefix: git push --mirr up topic is push-unsafe', () => {
    expect(verdict(bash('git push --mirr up topic'))).toMatchObject(unsafe);
  });
  it('H2 a subagent push is denied subagent', () => {
    expect(verdict(bash('git push up topic', { agent_id: 'sub1' }))).toMatchObject({ action: 'deny', pattern: 'subagent', scope: 'app-push' });
  });
  it('H3a a mirror config (remote.up.mirror true) is push-unsafe', () => {
    expect(verdict(bash('git push up topic'), { config: 'remote.up.mirror true' })).toMatchObject(unsafe);
  });
  it('H3b a + push config (remote.up.push +refs/heads/topic:refs/heads/topic) is push-unsafe', () => {
    expect(verdict(bash('git push up topic'), { config: 'remote.up.push +refs/heads/topic:refs/heads/topic' })).toMatchObject(unsafe);
  });
  it('H4a push config that widens the push (push.followtags true) is push-target-unresolved', () => {
    expect(verdict(bash('git push up topic'), { config: 'push.followtags true' })).toMatchObject(unresolved);
  });
  it('H4b a command option that widens the push (--follow-tags) is push-target-unresolved', () => {
    expect(verdict(bash('git push --follow-tags up topic'))).toMatchObject(unresolved);
  });
  it('H4c a -c push key (git -c push.default=matching push) is push-target-unresolved', () => {
    expect(verdict(bash('git -c push.default=matching push'), { pushRef: 'up/topic' })).toMatchObject(unresolved);
  });
  it('H5 --repo is push-target-unresolved', () => {
    expect(verdict(bash('git push --repo https://github.com/acme/other.git up topic'))).toMatchObject(unresolved);
  });
  it('H6a an unknown git global option before push (git -p push up topic) is push-target-unresolved', () => {
    expect(verdict(bash('git -p push up topic'))).toMatchObject(unresolved);
  });
  it('H6b a push no shape reads (sh -c with no force word) is push-target-unresolved', () => {
    expect(verdict(bash("sh -c 'git push up topic'"))).toMatchObject(unresolved);
  });
  it('H7 a short bundle with o (git push -uo x up topic) is push-target-unresolved', () => {
    expect(verdict(bash('git push -uo x up topic'))).toMatchObject(unresolved);
  });
  // Not named by Dave; no tap can be tied to them, so they are no tap path. Listed for the seat.
  it('H8a push URLs of two repos is push-urls', () => {
    expect(verdict(bash('git push up topic'), { pushUrls: { up: [URL, 'https://github.com/acme/b.git'] } })).toMatchObject({ action: 'deny', pattern: 'push-urls', scope: 'app-push' });
  });
  it('H8b a push after popd (position unknown) is denied', () => {
    expect(verdict(bash('popd && git push up topic'))).toMatchObject({ action: 'deny', scope: 'app-push' });
  });
  it('S2 the hook prints a deny for a hard deny, and the text names no flag', () => {
    const out = hookOut(bash('git push --force up topic'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/^BLOCKED \(decision-gate\): /);
    expect(out.permissionDecisionReason).not.toMatch(/enforceAppPush|enforcePush|is true|\boff\b/);
  });
});

describe('Dave 11-13: the catch (a git throw) keeps a hard deny of an app push when enforceAppPush is false', () => {
  // Change that breaks it: unjudgeable reads only the scope flags (a covered force push whose git throws then warns).
  it('H9a a force push whose git remote -v throws: the hook denies', () => {
    expect(hookOut(bash('git push --force up topic'), { throwOn: ['remote -v'] }).permissionDecision).toBe('deny');
  });
  it('H9b a subagent push whose git remote -v throws: the hook denies', () => {
    expect(hookOut(bash('git push up topic', { agent_id: 'sub1' }), { throwOn: ['remote -v'] }).permissionDecision).toBe('deny');
  });
  it('S1c a plain push whose tree read throws: the hook warns (the tap path)', () => {
    const out = hookOut(bash('git push up main'), { throwOn: ['rev-parse main^{tree}'] });
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/^WARNING \(decision-gate, warn mode\)/);
  });
});

describe('Dave 11-13: enforceAppPush false still softens the tap path of an app push (guard pins)', () => {
  // Change that breaks it: make every app-push deny hard (the flag then does nothing).
  it('S1a a push to a default branch with no tap warns', () => {
    expect(verdict(bash('git push up main'))).toMatchObject({ action: 'allow', scope: 'app-push' });
    expect(verdict(bash('git push up develop'))).toMatchObject({ action: 'allow', scope: 'app-push' });
    const out = hookOut(bash('git push up main'));
    expect(out.permissionDecision).toBeUndefined();
    expect(out.additionalContext).toMatch(/^WARNING \(decision-gate, warn mode\)/);
    expect(out.additionalContext).not.toMatch(/enforceAppPush|enforcePush|is true/);
  });
  it('S1b a push off the strict list (an option it does not list) with no tap warns', () => {
    const d = verdict(bash('git push --atomic up topic'));
    expect(d).toMatchObject({ action: 'allow', scope: 'app-push' });
    expect(d.action === 'allow' ? d.warn : '').toMatch(/^ship: /);
  });
  it('the flag absent: the same tap-path push denies (the default is unchanged)', () => {
    expect(decide(bash('git push up main'), deps({}, JSON.stringify({ decisions: { enforce: true } })))).toMatchObject({ action: 'deny', pattern: 'ship', scope: 'app-push' });
  });
  it('a strict push to a branch that is no default branch passes with no line', () => {
    expect(verdict(bash('git push up topic'))).toEqual({ action: 'allow' });
  });
});
