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
import { decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, handle, type Deps } from '../decision-gate.js';

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
    expect(o.additionalContext).toBeUndefined();
    // Seat request: the text says the check failed, not a policy, and to run the push again (pins the throw-only deny text).
    expect(o.permissionDecisionReason).toMatch(/push check could not run/);
    expect(o.permissionDecisionReason).toMatch(/not a policy block/);
    expect(o.permissionDecisionReason).toMatch(/Run the push again/);
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

/**
 * C2: a merge names its head sha in one known way, once. The head is read only from the --match-head-commit token of gh pr merge, or the
 * sha field (-f, -F, --raw-field, --field, with = or a space) of gh api .../pulls/<n>/merge. Text inside a value (--body, commit_message)
 * is never read. Two different values, a flag with no literal 40-hex value, an unpaired quote or an unknown gh pr merge flag: merge-no-head.
 *   - R3-c: --match-head-commit A --match-head-commit B                     -> C2-1 (red today: judged at A, gh uses B)
 *   - F-5: --body "sha=<tapped>" and no head flag                           -> C2-2 (red today: the sha is read from the body)
 *   - api commit_message="sha=<tapped>" -f sha=<other> (not in the list)    -> C2-3 (class)
 *   - a sha value that is a variable                                        -> C2-4
 *   - an unknown gh pr merge flag, an unpaired quote                        -> C2-5, C2-6
 *   - costs: the same sha twice, the = form, the api field forms still pass -> C2-C1..C3
 */
const OTHER = 'b'.repeat(40);
function tap(step: Step, key: string, head: string, label: string): void {
  expect(offerWrite({ step, key, head, spec: { header: 'T', question: 'Q?', options: [{ label }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step, key, head, label })).toEqual({ ok: true });
}
const landTap = (n: number) => tap('land', `${REPO}#${n}`, HEAD, 'Land now (Recommended)');
const verdictOf = (command: string) => decide(bash(command), deps());
const patternOf = (command: string): string => { const d = verdictOf(command); return d.action === 'deny' ? d.pattern : 'allow'; };
const MERGE = 'gh pr merge';

describe('C2: the merge head is read from one known place, once', () => {
  it('C2-1 (R3-c): two different --match-head-commit values deny merge-no-head', () => {
    // Breaks when: the sha is the first match of a regex over the segment (gh takes the LAST value).
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`)).toBe('merge-no-head');
  });
  it('C2-2 (F-5): a sha= inside --body is not a head: merge-no-head', () => {
    // Breaks when: the sha is read from any sha= text of the segment.
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --body "sha=${HEAD}"`)).toBe('merge-no-head');
  });
  it('C2-3 (class): an api merge whose commit_message holds sha=<tapped> and whose sha field is another head denies', () => {
    // Breaks when: a sha= inside another field value is read as the head.
    landTap(5);
    expect(verdictOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f sha=${OTHER}`).action).toBe('deny');
  });
  it('C2-3b (class): an api merge with sha=<tapped> only inside commit_message names no head: merge-no-head', () => {
    // Breaks when: any sha= text of a field value is read as the head (today: the tapped head is read and the merge passes).
    landTap(5);
    expect(patternOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f merge_method=squash`)).toBe('merge-no-head');
  });
  it('C2-4: a sha value that is not a literal (a variable, a substitution) denies merge-no-head', () => {
    landTap(5);
    for (const v of ['$SHA', '"$SHA"', '$(git rev-parse HEAD)', '`git rev-parse HEAD`', '%SHA%']) {
      expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${v}`), v).toBe('merge-no-head');
    }
  });
  it('C2-5: an unknown gh pr merge flag denies merge-no-head (the reader cannot know what it takes)', () => {
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --weird x`)).toBe('merge-no-head');
  });
  it('C2-6: an unpaired quote in the merge command denies merge-no-head', () => {
    landTap(5);
    expect(patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --body "open`)).toBe('merge-no-head');
  });
  it('C2-C1 (cost): the same sha given twice still passes with the tap', () => {
    // Breaks when: a repeat of ONE value is treated as two values.
    landTap(5);
    expect(verdictOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit=${HEAD}`).action).toBe('allow');
  });
  it('C2-C2 (cost): the plain forms still pass with the tap (space, =, quoted)', () => {
    landTap(5);
    for (const c of [`${MERGE} 5 --squash --match-head-commit ${HEAD}`, `${MERGE} 5 --squash --match-head-commit=${HEAD}`, `${MERGE} 5 --squash --match-head-commit "${HEAD}" --body "ok"`]) {
      expect(verdictOf(c).action, c).toBe('allow');
    }
  });
  it('C2-C4 (cost, named in the PR body): a merge that only shows with its quotes deleted (gh pr "merge") is merge-no-head even with the tap', () => {
    // Breaks when: the head is read from the quotes-deleted view, whose words are not what gh gets.
    landTap(5);
    expect(patternOf(`gh pr "merge" 5 --squash --match-head-commit ${HEAD}`)).toBe('merge-no-head');
  });
  it('C2-C5 (cost): a short-flag cluster of known flags still passes (-sd, -dR <repo>)', () => {
    // Breaks when: a cluster of known short flags is read as an unknown flag.
    landTap(5);
    expect(verdictOf(`${MERGE} 5 -sd --match-head-commit ${HEAD}`).action).toBe('allow');
    expect(verdictOf(`${MERGE} 5 -sdR ${REPO} --match-head-commit ${HEAD}`).action).toBe('allow');
  });
  it('C2-C3 (cost): the api sha field forms still pass with the tap', () => {
    landTap(5);
    for (const f of [`-f sha=${HEAD}`, `-F sha=${HEAD}`, `--raw-field sha=${HEAD}`, `--raw-field=sha=${HEAD}`, `--field sha=${HEAD}`, `-f "sha=${HEAD}"`]) {
      const c = `gh api repos/${REPO}/pulls/5/merge -X PUT ${f} -f merge_method=squash`;
      expect(verdictOf(c).action, c).toBe('allow');
    }
  });
});
