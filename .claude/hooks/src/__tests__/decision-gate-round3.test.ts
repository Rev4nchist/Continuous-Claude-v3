/**
 * decision-gate round 3 (card coord-decision-gate-round3; design note
 * C:/Users/dkhay/continuous-claude/.claudedocs/e2e-coord-decision-gate-round3/01-design-note.md). Own file: one red test per item,
 * one test per class with a spelling not in the list, one cost test per class. Every row runs in the shipped state: decisions.enforce
 * true, decisions.enforcePush ABSENT (a deny of scope push only warns today).
 *
 * Item 18 (Dave: "Land now, fix first in round 3"): a throw in a LATER member of a command that holds a push must not lose the hard
 * deny found before it, and a throw in a command that holds a push never ends in a warning.
 *   - an origin push, then a -C push to a folder whose git throws: the origin hard deny     -> R18-1 (red today: warn)
 *   - a force push to main, then a push in a folder whose git throws (`;` chain)             -> R18-2 (class: a spelling not in the list)
 *   - one push whose judging throws, no deny found before                                    -> R18-3 (hard deny, not a warn)
 *   - a command with no push whose judging throws                                            -> R18-C1 (cost: today's result kept)
 *   - a command with no gated shape whose judging throws                                     -> R18-C2 (cost: still allowed)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle, type Deps } from '../decision-gate.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
let dir = '';
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-gate-r3-'));
  saved = process.env.CCV3_DECISIONS_FILE;
  process.env.CCV3_DECISIONS_FILE = join(dir, 'decisions.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_DECISIONS_FILE; else process.env.CCV3_DECISIONS_FILE = saved;
  rmSync(dir, { recursive: true, force: true });
});

interface World {
  /** git THROWS for every call whose folder contains this text (a spawn error, a deadline). */
  throwIn?: string;
}

/** The shipped state: enforce true, enforcePush absent. A fake git for a CCv3 checkout at /repo. */
function deps(w: World = {}): Deps {
  const config = JSON.stringify({ decisions: { enforce: true } });
  const base = {
    env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'decisions.json') },
    home: '/home/nobody',
    readFile: (p: string) => (p.replace(/\\/g, '/').endsWith('/review-router.config.json') ? config : null),
    git: (cwd: string, args: string[]) => {
      if (w.throwIn && cwd.replace(/\\/g, '/').includes(w.throwIn)) throw new Error('git exploded');
      const a = args.join(' ');
      if (a === 'remote -v') return { status: 0, stdout: `fork\thttps://github.com/${REPO}.git (push)\n` };
      if (a === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
      if (a === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      // A remote name the text does not show as upstream: only git can tell that `up` points at parcadei (R18-5).
      if (a === 'remote get-url up') return { status: 0, stdout: 'https://github.com/parcadei/Continuous-Claude-v3.git\n' };
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      return { status: 1, stdout: '' };
    },
    // The registry: only the CCv3 root, at /repo. /elsewhere is under no root (an unregistered folder).
    tapScope: {
      registry: () => ({ state: 'ok', file: '/reg.json', entries: [{ key: 'continuous-claude', root: '/repo', status: 'active', tapGate: null, github: null }] }),
      realpath: (p: string) => p,
      readFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); },
    },
  };
  return base as unknown as Deps;
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', session_id: 'r3-test' });
interface Out { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
const run = (input: object, w?: World): Out => {
  const raw = handle(JSON.stringify(input), deps(w));
  return raw === '{}' ? {} : (JSON.parse(raw).hookSpecificOutput ?? {});
};

describe('R18: a throw in a command that holds a push keeps the deny found so far, else denies hard', () => {
  it('R18-1: an origin push, then a -C push to a folder whose git throws, gives the origin hard deny', () => {
    // Breaks when: the outer catch of handle() reads only the enforcement flags (today: a warning, and the origin push runs).
    const o = run(bash('git push origin feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-2: a force push to main, then a push in a folder whose git throws (; chain), gives the force-push hard deny', () => {
    // Breaks when: the deny found before the throw is dropped, in a chain spelled with ; and a cd (not the R18-1 shape).
    const o = run(bash('git push --force fork main; cd /gone && git push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-3: one push whose judging throws, with no deny found before, is a hard deny, not a warning', () => {
    // Breaks when: a throw in a push ends in warnOut while enforcePush is absent.
    const o = run(bash('git push fork feat/x'), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/could not verify/);
    expect(o.additionalContext).toBeUndefined();
  });

  it('R18-4: the throwing push FIRST, then an origin push, still gives the origin hard deny (the catch reads every push shape)', () => {
    // Breaks when: the catch reads only the denies judged before the throw, so a push after the throwing member is never read.
    const o = run(bash('git -C /gone push fork feat/x && git push origin feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-5: a push to a remote that git shows is upstream, then a push whose git throws, keeps the origin deny found by git', () => {
    // Breaks when: the catch drops the denies judged before the throw. The text alone (intentDeny) cannot see that `up` is parcadei.
    const o = run(bash('git push up feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin|parcadei|upstream/i);
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-C3 (cost, seat 20:00, Dave D1): a lone push in a resolved unregistered folder whose git throws keeps the old warning', () => {
    // Breaks when: the item 18 hard deny reaches a folder outside every registry root (a policy change that is Dave's).
    const o = run({ ...bash('git push up feat/x'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBeUndefined();
    expect(o.additionalContext).toContain('could not verify');
  });

  it('R18-6: the unregistered exemption is not a hole: a push there whose git throws, then an origin push, denies', () => {
    // Breaks when: the exemption for an unregistered folder also skips the intent read of the other push shapes.
    const o = run({ ...bash('git push up feat/x; git push origin main'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-C1 (cost): a PR create whose judging throws keeps today\'s result (decisions.enforce true: deny)', () => {
    // Breaks when: the item 18 change alters a command with no push.
    const o = run(bash(`gh pr create --repo ${REPO} --head feat/x --base main --title t --body b`), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/could not verify/);
  });

  it('R18-C2 (cost): a command with no gated shape whose git throws is still allowed', () => {
    // Breaks when: the new catch denies a call that holds no push, create, land or merge.
    expect(run(bash('git status && ls'), { throwIn: '/repo' })).toEqual({});
  });
});
