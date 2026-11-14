/**
 * PR 566, CodeRabbit round 1 (Dave 2026-11-14, "Fix 5, list 3"). Ways each fix can fail (one row each, red before the fix):
 *   C1  a subagent create in a covered app folder reads decisions.enforce from the app folder's own config (enforce false there: a warn)
 *   C2  a create whose --head names another owner (owner:branch) is judged as the local branch of the same name
 *   C3  a long push option value keeps a user:token part when prose() cuts it before out() removes credentials
 * Controls: K1 a subagent create in the app folder with the home flag false only warns (the fix reads home, it does not hard-deny);
 *   K2 a create with a plain --head still gets the open-pr deny; K3 a short credential URL in the option is still removed.
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
  scratch = mkdtempSync(join(tmpdir(), 'dg-r566-')).replace(/\\/g, '/');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCV3_DECISIONS_FILE = `${scratch}/decisions.json`;
  process.env.LANE_REGISTRY_PATH = `${scratch}/no-registry.json`;
  delete process.env.CCV3_GUARD_DECISIONS_LOG;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(scratch, { recursive: true, force: true });
});

const APP = '/work/app-x';
const URL = 'https://github.com/acme/app-x.git';
const REGISTRY = JSON.stringify({ projects: [{ key: 'app-x', path: APP }] });
const HOME_CFG = '/home/tester/continuous-claude/review-router.config.json';
const ON = JSON.stringify({ decisions: { enforce: true } });
const OFF = JSON.stringify({ decisions: { enforce: false } });
/** A config inside the app repo that turns decisions.enforce off: the gate must not read it for a covered folder. */
const APP_CFG = JSON.stringify({ decisions: { enforce: false } });

function answer(a: string): { status: number; stdout: string } {
  const ok = (s: string) => ({ status: 0, stdout: `${s}\n` });
  if (a === 'remote -v') return ok(`up\t${URL} (fetch)\nup\t${URL} (push)`);
  if (a === 'remote') return ok('up');
  if (a === 'rev-parse --path-format=absolute --show-toplevel --git-common-dir') return ok(`${APP}\n${APP}/.git`);
  const g = /^remote get-url (?:--push (?:--all )?)?(?:--end-of-options )?up$/.exec(a);
  if (g) return ok(URL);
  if (/^symbolic-ref --quiet --short refs\/remotes\/up\/HEAD$/.test(a)) return ok('up/main');
  if (a.startsWith('config --get-regexp ')) return { status: 1, stdout: '' };
  if (a === 'branch --show-current') return ok('feat');
  if (a === 'rev-parse HEAD') return ok(HEAD);
  if (/^rev-parse (?:--verify )?(?:--end-of-options )?(?:feat|HEAD)\^\{commit\}$/.test(a)) return ok(HEAD);
  if (/^rev-parse (?:--verify )?(?:--end-of-options )?(?:refs\/heads\/)?(?:feat|topic|HEAD)\^\{tree\}$/.test(a)) return ok(TREE);
  return { status: 1, stdout: '' };
}

function deps(home: string = ON, throwOn: string[] = []): Deps {
  return {
    env: { ...process.env },
    home: '/home/tester',
    readFile: (p) => {
      const f = p.replace(/\\/g, '/');
      if (f === HOME_CFG) return home;
      if (f === `${APP}/review-router.config.json`) return APP_CFG;
      return null;
    },
    git: (cwd, args) => {
      if (cwd.replace(/\\/g, '/') !== APP) return { status: 128, stdout: '' };
      const a = args.join(' ');
      if (throwOn.includes(a)) throw new Error(`spawnSync git ETIMEDOUT (${a})`);
      return answer(a);
    },
    tapScope: {
      registry: () => readRegistry({ path: '/reg/project-registry.json', deps: { readFile: () => REGISTRY, realpath: (p) => p } }),
      realpath: (p) => p,
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  };
}
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: APP, session_id: 's-r566', ...extra });
const verdict = (input: object, home?: string): Decision => decide(input, deps(home));
const hookText = (input: object): string => {
  const o = JSON.parse(handle(JSON.stringify(input), deps())).hookSpecificOutput ?? {};
  return String(o.permissionDecisionReason ?? o.additionalContext ?? '');
};
/** deny, warn or pass of the hook stdout, with a git call that throws. */
const hookKind = (input: object, home: string, throwOn: string[]): string => {
  const o = JSON.parse(handle(JSON.stringify(input), deps(home, throwOn))).hookSpecificOutput ?? {};
  return o.permissionDecision === 'deny' ? 'deny' : typeof o.additionalContext === 'string' ? 'warn' : 'pass';
};
const CREATE = 'gh pr create --draft --title t --body b';
const HEAD_READ = 'rev-parse feat^{commit}';
const ROOT_READ = 'rev-parse --path-format=absolute --show-toplevel --git-common-dir';

describe('PR 566 CodeRabbit round 2 (Dave 10:47: "One last fix, then land")', () => {
  // Change that breaks C4: drop the namedHeads check in appCreateIn.
  it('C4 a create that names two different heads is denied head-unresolved', () => {
    expect(verdict(bash('gh pr create --draft --head feat --head topic --title t --body b'))).toMatchObject({ action: 'deny', pattern: 'head-unresolved' });
  });
  it('K4 control: the same head twice is one head (the open-pr deny)', () => {
    expect(verdict(bash('gh pr create --draft --head feat --head feat --title t --body b'))).toMatchObject({ action: 'deny', pattern: 'open-pr' });
  });
  // Change that breaks C5: coveredCall rethrows the body's error as it is (no AppScopeError).
  it('C5 a git throw inside a covered create, home enforce true, app config false: the catch denies', () => {
    expect(hookKind(bash(CREATE), ON, [HEAD_READ])).toBe('deny');
  });
  it('K5 control: the same throw with home enforce false only warns', () => {
    expect(hookKind(bash(CREATE), OFF, [HEAD_READ])).toBe('warn');
  });
  // Change that breaks C6: coveredCall keeps push true on the coverage read's AppScopeError (app-push joins the scopes).
  it('C6 a coverage-read throw of a covered create with home enforce false warns, not denies by the push flag', () => {
    expect(hookKind(bash(CREATE), OFF, [ROOT_READ])).toBe('warn');
  });
  it('K6 control: the same coverage-read throw of a covered PUSH still denies (app-push default on)', () => {
    expect(hookKind(bash('git push up main'), OFF, [ROOT_READ])).toBe('deny');
  });
});

describe('PR 566 CodeRabbit round 1: the three output fixes', () => {
  // Change that breaks C1: drop homeFlags from the subagent deny (subagentDeny returns the base deny).
  it('C1 a subagent create in a covered app folder denies on the home flag, whatever the app config says', () => {
    expect(verdict(bash('gh pr create --draft --title t --body b', { agent_id: 'sub1' }))).toMatchObject({ action: 'deny', pattern: 'subagent' });
  });
  it('K1 control: with the home flag false the same subagent create only warns', () => {
    const d = verdict(bash('gh pr create --draft --title t --body b', { agent_id: 'sub1' }), OFF);
    expect(d.action).toBe('allow');
    expect((d as { warn?: string }).warn).toMatch(/^subagent:/);
  });
  // Change that breaks C2: remove the headOwner check in appCreate.
  it('C2 a create whose --head names another owner is denied head-foreign', () => {
    expect(verdict(bash('gh pr create --draft --head other-user:feat --title t --body b'))).toMatchObject({ action: 'deny', pattern: 'head-foreign' });
  });
  it('C2b the REST form -f head=other-user:feat is denied head-foreign', () => {
    expect(verdict(bash('gh api repos/acme/app-x/pulls -X POST -f head=other-user:feat -f base=main -f title=t -F draft=true'))).toMatchObject({ action: 'deny', pattern: 'head-foreign' });
  });
  it('K2 control: a plain --head feat still gets the open-pr deny (no tap)', () => {
    expect(verdict(bash('gh pr create --draft --head feat --title t --body b'))).toMatchObject({ action: 'deny', pattern: 'open-pr' });
  });
  // Change that breaks C3: prose() cuts before CREDS_RE runs (the order at 0f413fa8).
  it('C3 a long --recurse-submodules value: the deny text keeps no user or token part after the cut', () => {
    // The token "--recurse-submodules=" is 21 code points: the URL starts at 181, the user name ends at 197, so the 200 cut falls in the token.
    const value = `${'x'.repeat(160)}https://someuser:tok1234567890secret@example.com/r.git`;
    const text = hookText(bash(`git push --recurse-submodules=${value} up topic`));
    expect(text).not.toBe('');
    expect(text).not.toMatch(/someuser|tok1234/);
  });
  it('K3 control: a short credential URL in the option is still removed', () => {
    const text = hookText(bash('git push --recurse-submodules=https://someuser:tok1234@example.com/r.git up topic'));
    expect(text).not.toBe('');
    expect(text).not.toMatch(/someuser|tok1234/);
  });
});
