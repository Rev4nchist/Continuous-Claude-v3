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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60000 }); // each row now parses first (the PowerShell parse is about 330 ms); C2-11 makes 6 of them
import { decisionKey, decisionRecord, offerWrite, type Step } from '../shared/decisions-store.js';
import { decide, handle, type Deps } from '../decision-gate.js';
import { isPrOpenCommand } from '../pr-opened-review-loop.js';
import { classifyDestructive } from '../shared/destructive-classifier.js';
import { decideParsed, handleParsed } from './helpers/parse-first.js';

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const TREE = 't'.repeat(40);
const INDEX = 'i'.repeat(40);
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
  /** C3: the checked-out branch (default feat/x). */
  branch?: string;
  /** C3: the holdout scan seams: the id list, and the one line every outgoing diff adds. */
  scan?: { ids: string[]; added: string };
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
      if (a === 'branch --show-current') return { status: 0, stdout: `${w.branch ?? 'feat/x'}\n` };
      // C5 (card coord-decision-gate-round3-content-scan): the names read and the content read are one git log each.
      if (w.scan && args[0] === 'log' && args.includes('--name-only')) return { status: 0, stdout: `\u0001c5\0${HEAD}\0\0src/x.ts\0` };
      if (w.scan && args[0] === 'log' && args.includes('-p')) return { status: 0, stdout: `\u0001c5 ${HEAD}\n a message\ndiff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+${w.scan.added}\n` };
      if (w.scan && args[0] === 'for-each-ref') return { status: 0, stdout: '' };
      if (w.scan && a.startsWith('ls-files')) return { status: 0, stdout: '' };
      if (a === 'rev-parse --abbrev-ref @{push}') return { status: 128, stdout: '' };
      // A remote name the text does not show as upstream: only git can tell that `up` points at parcadei (R18-5).
      if (a === 'remote get-url up') return { status: 0, stdout: 'https://github.com/parcadei/Continuous-Claude-v3.git\n' };
      if (/^rev-parse (.+)\^\{commit\}$/.test(a)) return { status: 0, stdout: `${HEAD}\n` };
      if (/^rev-parse (.+)\^\{tree\}$/.test(a)) return { status: 0, stdout: `${TREE}\n` };
      // C4: the index tree (what a chained commit will hold) and the checkout root of a folder (/other is another checkout).
      if (a === 'write-tree') return { status: 0, stdout: `${INDEX}\n` };
      if (a === 'rev-parse --path-format=absolute --show-toplevel') return { status: 0, stdout: `${cwd.replace(/\\/g, '/').startsWith('/other') ? '/other' : '/repo'}\n` };
      return { status: 1, stdout: '' };
    },
    ...(w.scan ? { holdoutIds: () => w.scan!.ids, answerKeyHits: () => [] } : {}),
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
const run = async (input: object, w?: World): Promise<Out> => {
  const raw = await handleParsed(JSON.stringify(input), deps(w));
  return raw === '{}' ? {} : (JSON.parse(raw).hookSpecificOutput ?? {});
};

describe('R18: a throw in a command that holds a push keeps the deny found so far, else denies hard', () => {
  it('R18-1: an origin push, then a -C push to a folder whose git throws, gives the origin hard deny', async () => {
    // Breaks when: the outer catch of handle() reads only the enforcement flags (today: a warning, and the origin push runs).
    const o = await run(bash('git push origin feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-2: a force push to main, then a push in a folder whose git throws (; chain), gives the force-push hard deny', async () => {
    // Breaks when: the deny found before the throw is dropped, in a chain spelled with ; and a cd (not the R18-1 shape).
    const o = await run(bash('git push --force fork main; cd /gone && git push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-3: one push whose judging throws, with no deny found before, is a hard deny, not a warning', async () => {
    // Breaks when: a throw in a push ends in warnOut while enforcePush is absent.
    const o = await run(bash('git push fork feat/x'), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.additionalContext).toBeUndefined();
    // Seat request: the text says the check failed, not a policy, and to run the push again (pins the throw-only deny text).
    expect(o.permissionDecisionReason).toMatch(/push check could not run/);
    expect(o.permissionDecisionReason).toMatch(/not a policy block/);
    expect(o.permissionDecisionReason).toMatch(/Run the push again/);
  });

  it('R18-4: the throwing push FIRST, then an origin push, still gives the origin hard deny (the catch reads every push shape)', async () => {
    // Breaks when: the catch reads only the denies judged before the throw, so a push after the throwing member is never read.
    const o = await run(bash('git -C /gone push fork feat/x && git push origin feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-5: a push to a remote that git shows is upstream, then a push whose git throws, keeps the origin deny found by git', async () => {
    // Breaks when: the catch drops the denies judged before the throw. The text alone (intentDeny) cannot see that `up` is parcadei.
    const o = await run(bash('git push up feat/x && git -C /gone push fork feat/x'), { throwIn: '/gone' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin|parcadei|upstream/i);
    expect(o.permissionDecisionReason).not.toMatch(/could not verify/);
  });

  it('R18-C3 (cost, seat 20:00, Dave D1): a lone push in a resolved unregistered folder whose git throws keeps the old warning', async () => {
    // Breaks when: the item 18 hard deny reaches a folder outside every registry root (a policy change that is Dave's).
    const o = await run({ ...bash('git push up feat/x'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBeUndefined();
    expect(o.additionalContext).toContain('could not verify');
  });

  it('R18-6: the unregistered exemption is not a hole: a push there whose git throws, then an origin push, denies', async () => {
    // Breaks when: the exemption for an unregistered folder also skips the intent read of the other push shapes.
    const o = await run({ ...bash('git push up feat/x; git push origin main'), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/origin/i);
  });

  it('R18-C1 (cost): a PR create whose judging throws keeps today\'s result (decisions.enforce true: deny)', async () => {
    // Breaks when: the item 18 change alters a command with no push.
    const o = await run(bash(`gh pr create --repo ${REPO} --head feat/x --base main --title t --body b`), { throwIn: '/repo' });
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/could not verify/);
  });

  it('R18-C2 (cost): a command with no gated shape whose git throws is still allowed', async () => {
    // Breaks when: the new catch denies a call that holds no push, create, land or merge.
    expect(await run(bash('git status && ls'), { throwIn: '/repo' })).toEqual({});
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
const verdictOf = async (command: string) => await decideParsed(bash(command), deps());
const patternOf = async (command: string): Promise<string> => { const d = await verdictOf(command); return d.action === 'deny' ? d.pattern : 'allow'; };
const MERGE = 'gh pr merge';

describe('C2: the merge head is read from one known place, once', () => {
  it('C2-1 (R3-c): two different --match-head-commit values deny merge-no-head', async () => {
    // Breaks when: the sha is the first match of a regex over the segment (gh takes the LAST value).
    landTap(5);
    expect(await patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit ${OTHER}`)).toBe('merge-no-head');
  });
  it('C2-2 (F-5): a sha= inside --body is not a head: merge-no-head', async () => {
    // Breaks when: the sha is read from any sha= text of the segment.
    landTap(5);
    expect(await patternOf(`${MERGE} 5 --squash --body "sha=${HEAD}"`)).toBe('merge-no-head');
  });
  it('C2-3 (class): an api merge whose commit_message holds sha=<tapped> and whose sha field is another head denies', async () => {
    // Breaks when: a sha= inside another field value is read as the head.
    landTap(5);
    expect((await verdictOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f sha=${OTHER}`)).action).toBe('deny');
  });
  it('C2-3b (class): an api merge with sha=<tapped> only inside commit_message names no head: merge-no-head', async () => {
    // Breaks when: any sha= text of a field value is read as the head (today: the tapped head is read and the merge passes).
    landTap(5);
    expect(await patternOf(`gh api repos/${REPO}/pulls/5/merge -X PUT -f commit_message="sha=${HEAD}" -f merge_method=squash`)).toBe('merge-no-head');
  });
  it('C2-4: a sha value that is not a literal (a variable, a substitution) denies merge-no-head', async () => {
    landTap(5);
    for (const v of ['$SHA', '"$SHA"', '$(git rev-parse HEAD)', '`git rev-parse HEAD`', '%SHA%']) {
      expect(await patternOf(`${MERGE} 5 --squash --match-head-commit ${v}`), v).toBe('merge-no-head');
    }
  });
  it('C2-5: an unknown gh pr merge flag denies merge-no-head (the reader cannot know what it takes)', async () => {
    landTap(5);
    expect(await patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --weird x`)).toBe('merge-no-head');
  });
  it('C2-6: an unpaired quote in the merge command denies merge-no-head', async () => {
    landTap(5);
    // C2b (class C): the parser cannot read an unpaired quote, so the deny is parse-error. Main with a parse gives this answer; the hand reader is retired.
    expect(await patternOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --body "open`)).toBe('parse-error');
  });
  it('C2-C1 (cost): the same sha given twice still passes with the tap', async () => {
    // Breaks when: a repeat of ONE value is treated as two values.
    landTap(5);
    expect((await verdictOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} --match-head-commit=${HEAD}`)).action).toBe('allow');
  });
  it('C2-C2 (cost): the plain forms still pass with the tap (space, =, quoted)', async () => {
    landTap(5);
    for (const c of [`${MERGE} 5 --squash --match-head-commit ${HEAD}`, `${MERGE} 5 --squash --match-head-commit=${HEAD}`, `${MERGE} 5 --squash --match-head-commit "${HEAD}" --body "ok"`]) {
      expect((await verdictOf(c)).action, c).toBe('allow');
    }
  });
  it('C2-C4 (cost, named in the PR body): a merge that only shows with its quotes deleted (gh pr "merge") is merge-no-head even with the tap', async () => {
    // Breaks when: the head is read from the quotes-deleted view, whose words are not what gh gets.
    landTap(5);
    // C2b (class B): main with a parse gives this answer; the hand reader is retired. The parser reads the quoted subcommand as the merge call, so the tap decides.
    expect(await patternOf(`gh pr "merge" 5 --squash --match-head-commit ${HEAD}`)).toBe('allow');
    expect(await patternOf(`gh pr "merge" 9 --squash --match-head-commit ${HEAD}`), 'paired: no tap for PR 9').toBe('land');
    expect(await patternOf(`gh pr "merge" 5 --squash --match-head-commit ${OTHER}`), 'paired: a head that is not the tapped one').toBe('land');
  });
  it('C2-C5 (cost): a short-flag cluster of known flags still passes (-sd, -dR <repo>)', async () => {
    // Breaks when: a cluster of known short flags is read as an unknown flag.
    landTap(5);
    expect((await verdictOf(`${MERGE} 5 -sd --match-head-commit ${HEAD}`)).action).toBe('allow');
    expect((await verdictOf(`${MERGE} 5 -sdR ${REPO} --match-head-commit ${HEAD}`)).action).toBe('allow');
  });
  it('C2-C3 (cost): the api sha field forms still pass with the tap', async () => {
    landTap(5);
    for (const f of [`-f sha=${HEAD}`, `-F sha=${HEAD}`, `--raw-field sha=${HEAD}`, `--raw-field=sha=${HEAD}`, `--field sha=${HEAD}`, `-f "sha=${HEAD}"`, `-fsha=${HEAD}`]) {
      const c = `gh api repos/${REPO}/pulls/5/merge -X PUT ${f} -f merge_method=squash`;
      expect((await verdictOf(c)).action, c).toBe('allow');
    }
  });
});

/**
 * C2 seat findings (delta read of 429ca031, 2026-11-15): one rule, a character the merge reader does not model makes the head unread.
 *   - (a) a word the shell can expand ($VAR, "$VAR", $(...), `...`, {a,b}, a glob, @splat) can become more flags, a second head among them
 *   - (b) PowerShell quoting: a backtick escapes a quote, a backslash does not, so the words gh gets differ from the bash pairing
 *   - doubled single quotes split the same in bash and PowerShell: a green test, no change
 */
const pwsh = (command: string) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: '/repo', session_id: 'r3-test' });
const patternIn = async (input: object): Promise<string> => { const d = await decideParsed(input, deps()); return d.action === 'deny' ? d.pattern : 'allow'; };

describe('C2 seat findings: a character the merge reader does not model makes the head unread', () => {
  it('C2-7 (a): an expandable word in a gh pr merge segment denies merge-no-head, for Bash and PowerShell', async () => {
    // Breaks when: cliMergeHead skips a word that does not start with a dash, so a word the shell turns into a second head is not read.
    landTap(5);
    for (const extra of ['$EXTRA', '"$EXTRA"', '$(cat f)', '`cat f`', '{--match-head-commit,x}', '--match-head-commi?', '--m*', '${EXTRA}']) {
      const c = `${MERGE} 5 --squash --match-head-commit ${HEAD} ${extra}`;
      expect(await patternIn(bash(c)), `bash ${extra}`).toBe('merge-no-head');
    }
    for (const extra of ['$EXTRA', '@EXTRA', '$(Get-Content f)', '"$EXTRA"']) {
      const c = `${MERGE} 5 --squash --match-head-commit ${HEAD} ${extra}`;
      expect(await patternIn(pwsh(c)), `pwsh ${extra}`).toBe('merge-no-head');
    }
  });
  it('C2-7b (a, api): an expandable word in a gh api merge segment denies merge-no-head', async () => {
    // Breaks when: apiMergeHead skips a word that is not a field flag, so an expansion that becomes -f sha=<other> is not read.
    landTap(5);
    for (const extra of ['$EXTRA', '$(cat f)', '"$EXTRA"', '{-f,sha=x}']) {
      expect(await patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} ${extra}`)), extra).toBe('merge-no-head');
    }
  });
  it('C2-C8 (cost): the gh placeholders {owner}/{repo} in the api path still pass with the tap', async () => {
    // Breaks when: the rule reads gh's own placeholders (no comma: bash does not expand them) as a brace expansion.
    landTap(5);
    expect(await patternIn(bash(`gh api repos/{owner}/{repo}/pulls/5/merge -X PUT -f sha=${HEAD}`))).toBe('allow');
  });
  it('C2-8 (b): a PowerShell backtick quote or a backslash before a quote denies merge-no-head', async () => {
    // Breaks when: the reader pairs quotes by bash rules only. PowerShell: `" is a literal quote and \ escapes nothing, so a second head
    // that the bash pairing reads as --body text is a real flag for gh (gh takes the last head).
    landTap(5);
    const tick = `${MERGE} 5 --squash --match-head-commit ${HEAD} --body \`"x --match-head-commit ${OTHER} --body y\`"`;
    const slash = `${MERGE} 5 --squash --match-head-commit ${HEAD} --body "x\\" --match-head-commit ${OTHER} \\"y"`;
    // C2b: main with a parse gives these answers; the hand reader is retired. Bash cannot parse the backtick-quote text (parse-error, class C); every other cell stays merge-no-head.
    for (const [c, bashPattern] of [[tick, 'parse-error'], [slash, 'merge-no-head']]) {
      expect(await patternIn(pwsh(c)), `pwsh ${c}`).toBe('merge-no-head');
      expect(await patternIn(bash(c)), `bash ${c}`).toBe(bashPattern);
    }
  });
  it('C2-C6 (cost, green today): doubled single quotes split the same in bash and PowerShell, so the one head still passes', async () => {
    // Breaks when: a fix for (b) treats '' as unmodelled. Both shells read 'x '' --match-head-commit B '' y' as ONE body word.
    landTap(5);
    const c = `${MERGE} 5 --squash --body 'it''s x '' --match-head-commit ${OTHER} '' y' --match-head-commit ${HEAD}`;
    expect(await patternIn(pwsh(c))).toBe('allow');
    expect(await patternIn(bash(c))).toBe('allow');
  });
  it('C2-9 (seat delta i): a word that opens a comment (#) makes the head unread: the shell drops the head flag after it', async () => {
    // Breaks when: a # word is read as text, so the gate reads a tapped head that gh never gets (gh then merges with no head check).
    landTap(5);
    expect(await patternIn(bash(`${MERGE} 5 --squash # --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(await patternIn(pwsh(`${MERGE} 5 --squash #x --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(await patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT # -f sha=${HEAD}`))).toBe('merge-no-head');
  });
  it('C2-10 (seat delta ii): a redirect word with no target takes the next word as its file name', async () => {
    // Breaks when: a lone > is skipped as a word, so the next word (--match-head-commit) is read as a flag; the shell makes it a file name.
    landTap(5);
    expect(await patternIn(bash(`${MERGE} 5 --squash > --match-head-commit ${HEAD}`))).toBe('merge-no-head');
    expect(await patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT 2> -f sha=${HEAD}`))).toBe('merge-no-head');
  });
  it('C2-10b (seat delta ii): a separator in the merge text cuts it before the reader, so a head after it is not the merge head', async () => {
    // Breaks when: MERGE_CLI_RE reads past ; && || | or a newline (a head of the NEXT command would be read as the merge head).
    landTap(5);
    for (const sep of [';', '&&', '||', '|', '\n']) {
      expect(await patternIn(bash(`${MERGE} 5 --squash ${sep} echo --match-head-commit ${HEAD}`)), JSON.stringify(sep)).toBe('merge-no-head');
    }
  });
  it('C2-11 (seat delta iii): a curly quote makes the head unread: PowerShell takes it as a quote, the reader does not', async () => {
    // Breaks when: curly quotes are plain text to the reader, so a head flag inside a PowerShell string is read as a flag.
    landTap(5);
    for (const [o, c] of [['‘', '’'], ['“', '”'], ['„', '”']]) {
      // The closing quote stands alone: the head value stays a clean 40-hex word, so only the quote rule can deny it.
      expect(await patternIn(pwsh(`${MERGE} 5 --squash --body ${o}x --match-head-commit ${HEAD} ${c}`)), o).toBe('merge-no-head');
      expect(await patternIn(pwsh(`gh api repos/${REPO}/pulls/5/merge -X PUT -f merge_method=${o}squash -f sha=${HEAD} ${c}`)), o).toBe('merge-no-head');
    }
  });
  it('C2-C9 (cost, seat ruling A): any redirect in the merge text (2>err.txt, 2>&1) now makes the head unread', async () => {
    // Breaks when: the allowlist lets < > or a lone & through (the & of 2>&1 cuts the segment before a later head: pre-read finding 1).
    landTap(5);
    // C2b (class B): main with a parse gives this answer; the hand reader is retired. The parser reads a redirect as a redirect, so the cost is gone and the tap decides.
    expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>err.txt`))).toBe('allow');
    expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1`))).toBe('allow');
    expect(await patternIn(bash(`${MERGE} 9 --squash --match-head-commit ${HEAD} 2>&1`)), 'paired: no tap for PR 9').toBe('land');
    expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${OTHER} 2>&1`)), 'paired: a head that is not the tapped one').toBe('land');
  });
  it('C2-12 (pre-read 1): a head after 2>&1 or &>log is read: the & of a redirect does not end the merge text', async () => {
    // Breaks when: the head is read from the segment cut at &, so gh takes OTHER (the last) while the gate read TAPPED.
    landTap(5);
    // C2b (class B, one cell): main with a parse gives these answers; the hand reader is retired. In PowerShell `&>log` cuts the text at `&` (a background
    // operator), so the second head is a later statement and gh gets one head: allow. Bash and the other cells keep merge-no-head.
    for (const [tool, name] of [[bash, 'bash'], [pwsh, 'pwsh']] as const) {
      expect(await patternIn(tool(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1 --match-head-commit ${OTHER}`)), `${name} 2>&1`).toBe('merge-no-head');
      expect(await patternIn(tool(`${MERGE} 5 --squash --match-head-commit ${HEAD} &>log --match-head-commit ${OTHER}`)), `${name} &>log`).toBe(name === 'pwsh' ? 'not-inert' : 'merge-no-head'); // C2c: in PowerShell `&>log` is a call operator and a redirect word; the call has no literal program, so it is off the lists
      expect(await patternIn(tool(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} 2>&1 -f sha=${OTHER}`)), `${name} api`).toBe('merge-no-head');
    }
  });
  it('C2-13 (pre-read 2): an attached or unknown api field flag (-fsha=, -Fsha=, -f=sha=, -if sha=) makes the head unread', async () => {
    // Breaks when: apiMergeHead skips a dash word it does not know, so a second sha in an attached form is never read.
    landTap(5);
    for (const f of [`-fsha=${OTHER}`, `-Fsha=${OTHER}`, `-f=sha=${OTHER}`, `-if sha=${OTHER}`]) {
      expect(await patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} ${f}`)), f).toBe('merge-no-head');
    }
  });
  it('C2-14 (pre-read 3, 4): a non-ASCII space, a \\v or \\f, or a lone CR makes the head unread', async () => {
    // Breaks when: pairedWords splits on every JS \s (NBSP and the Unicode spaces are word characters for bash), or a lone CR is a
    // segment break for the gate and a word character for bash.
    landTap(5);
    openTap('feat/x'); // C2b: the create rows below now read the head and need the tap (the old rows were denied before the tap was asked)
    for (const sp of [' ', ' ', '\v', '\f', '\r']) {
      // C2b (class B): main with a parse gives these answers; the hand reader is retired. The parser reads the odd space as part of a word, so the tap decides
      // (a lone CR still makes the create head-unresolved). The paired rows prove the allow comes from the tap match, not from a lost read: no tap or a wrong head denies.
      expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} --body x${sp}y`)), JSON.stringify(sp)).toBe('allow');
      expect(await patternIn(bash(`${MERGE} 9 --squash --match-head-commit ${HEAD} --body x${sp}y`)), `no tap ${JSON.stringify(sp)}`).toBe('land');
      expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${OTHER} --body x${sp}y`)), `wrong head ${JSON.stringify(sp)}`).toBe('land');
      expect(await patternIn(bash(`gh pr create --head feat/x --title a${sp}b`)), `create ${JSON.stringify(sp)}`).toBe(sp === '\r' ? 'head-unresolved' : 'allow');
      expect(await patternIn(bash(`gh pr create --head feat/z --title a${sp}b`)), `create no tap ${JSON.stringify(sp)}`).toBe(sp === '\r' ? 'head-unresolved' : 'open-pr');
    }
  });
  it('C2-16 (allowlist, inside quotes): a curly quote inside an ASCII double-quoted word makes the head unread', async () => {
    // Breaks when: non-ASCII is allowed inside quotes. PowerShell closes "x“ at the curly quote and joins the rest into ONE word, so gh
    // gets no head flag while the gate reads the tapped one.
    landTap(5);
    expect(await patternIn(pwsh(`${MERGE} 5 --squash --body "x“" --match-head-commit ${HEAD} "y”"`))).toBe('merge-no-head');
  });
  // Split (CLI run 2 of C2b): one test of 5 lists x 2 tools x 6 texts = 60 parses ran past the timeout under load and filled the flake ledger. One test per tool and list now.
  describe('C2-17 (seat delta q3): a gh call run by another program (bash -c, pwsh -c, cmd /c, a here-string) makes the head unread', () => {
    // Breaks when: the reader starts at the gh word whatever comes before it. Another program parses the words again (cmd also expands
    // %X% inside double quotes), so the words gh gets cannot be proven from this text.
    const m = `${MERGE} 5 --squash --match-head-commit ${HEAD}`;
    const c = 'gh pr create --head feat/x --title t';
    // C2b (class B): main with a parse gives these answers; the hand reader is retired. The parser reads the inner call of bash -c, pwsh -Command and powershell -c, so
    // the tap decides; cmd /c and a here-string into Invoke-Expression are still unread. The paired rows (no tap, a wrong head) prove the allow comes from the tap
    // match, not from a lost read: each denies, with the land or open-pr pattern where the call is read and the old pattern where it is not.
    const wrap = (t: string): string[] => [`bash -c '${t}'`, `pwsh -Command '${t}'`, `cmd /c "${t}"`, `cmd /c ${t}`, `powershell -c ${t}`, `@'\n${t}\n'@ | Invoke-Expression`];
    const mTap = ['allow', 'allow', 'merge-no-head', 'merge-no-head', 'allow', 'merge-no-head'];
    const mDeny = ['land', 'land', 'merge-no-head', 'merge-no-head', 'land', 'merge-no-head'];
    const cTap = ['allow', 'allow', 'head-unresolved', 'head-unresolved', 'allow', 'head-unresolved'];
    const cDeny = ['open-pr', 'open-pr', 'head-unresolved', 'head-unresolved', 'open-pr', 'head-unresolved'];
    const lists: [string, string[], string[]][] = [['tapped merge', wrap(m), mTap], ['no-tap merge', wrap(`${MERGE} 9 --squash --match-head-commit ${HEAD}`), mDeny],
      ['wrong-head merge', wrap(`${MERGE} 5 --squash --match-head-commit ${OTHER}`), mDeny], ['tapped create', wrap(c), cTap], ['no-tap create', wrap('gh pr create --head feat/z --title t'), cDeny]];
    for (const tool of [bash, pwsh]) {
      for (const [label, texts, want] of lists) {
        it(`${tool === bash ? 'bash' : 'pwsh'}: ${label}`, async () => {
          landTap(5);
          openTap('feat/x');
          for (let i = 0; i < texts.length; i++) {
            expect(await patternIn(tool(texts[i])), `${tool === bash ? 'bash' : 'pwsh'} ${label} ${texts[i]}`).toBe(want[i]);
          }
        });
      }
    }
  });
  it('C2-C10 (cost): a literal NAME=value setting before gh (GH_REPO=..., GH_PROMPT_DISABLED=1) still passes', async () => {
    landTap(5);
    expect(await patternIn(bash(`GH_PROMPT_DISABLED=1 ${MERGE} 5 --squash --match-head-commit ${HEAD}`))).toBe('allow');
  });
  it('C2-15 (pre-read 6): a positional glob, brace, paren or comma word makes the head unread', async () => {
    // Breaks when: the allowlist lets * ? [ ] { } ( ) or , through outside quotes.
    landTap(5);
    // C2b (class B): main with a parse gives these answers; the hand reader is retired. A brace or comma word that bash does not expand is data now; the glob words
    // and the bracket word still make the head unread; a paren word is a parse error (class C).
    const now: Record<string, string> = { 'x*': 'merge-no-head', 'x?': 'merge-no-head', '[x]': 'merge-no-head', '{x}': 'allow', '(x)': 'parse-error', 'a,b': 'allow' };
    for (const w of ['x*', 'x?', '[x]', '{x}', '(x)', 'a,b']) {
      expect(await patternIn(bash(`${MERGE} 5 --squash --match-head-commit ${HEAD} ${w}`)), w).toBe(now[w]);
    }
  });
  it('C2-C7b (cost): a $ or a glob inside single quotes is literal in both shells (api form)', async () => {
    landTap(5);
    expect(await patternIn(bash(`gh api repos/${REPO}/pulls/5/merge -X PUT -f sha=${HEAD} -f commit_message='costs $5 (*)'`))).toBe('allow');
  });
  it('C2-C7 (cost): a $ or a glob inside single quotes is literal in both shells and still passes', async () => {
    // Breaks when: the rule reads characters inside single quotes as expandable.
    landTap(5);
    const c = `${MERGE} 5 --squash --body 'costs $5 (*)' --match-head-commit ${HEAD}`;
    expect(await patternIn(bash(c))).toBe('allow');
    expect(await patternIn(pwsh(c))).toBe('allow');
  });
});

/**
 * C1: a create names its head and base in one known way, once. gh pr create / gh pr new: --head, --head=, -H (else the checked-out branch),
 * --base, --base=, -B; every word belongs to the known flag set; -F is --body-file. gh api .../pulls POST: the head and base fields (-f, -F,
 * --raw-field, --field; space or =). head-unresolved for --input, a field from a file (=@), head_repo, two values, an unknown flag or field,
 * a value that is not literal, an unpaired quote. In the fake checkout every branch resolves to HEAD; the checked-out branch is feat/x.
 *   - R3-a: gh pr create --input <file>                       -> C1-1 (red today: the checked-out branch is judged, its tap passes)
 *   - F-2: gh pr new ...                                      -> C1-2 (red today: not seen as a create)
 *   - F-3: gh api .../pulls --raw-field=head=topic            -> C1-3 (red today: the = form is not read, feat/x is judged)
 *   - F-4: gh pr create -F head=approved                      -> C1-4 (red today: read as head `approved`)
 *   - class (not in the list): --head a -H b, -F head=@h.txt, head_repo, an unknown flag, a variable head, an unpaired quote -> C1-5..C1-9
 */
const API_CREATE = `gh api repos/${REPO}/pulls -X POST`;
const openTap = (branch: string) => tap('open-pr', decisionKey({ branch }), HEAD, 'Open draft PR (Recommended)');

describe('C1: a create names its head and base in one known way, once', () => {
  it('C1-1 (R3-a): --input on gh pr create or on the api create is head-unresolved, even with a tap for the checked-out branch', async () => {
    // Breaks when: an unknown create flag (or the api --input body file) leaves the head to fall back to the checked-out branch.
    openTap('feat/x');
    expect(await patternOf('gh pr create --input body.json --title t')).toBe('head-unresolved');
    expect(await patternOf(`${API_CREATE} --input body.json`)).toBe('head-unresolved');
  });
  it('C1-2 (F-2): gh pr new is a create (the gate and the review-loop reader)', async () => {
    // Breaks when: PR_CREATE_RE / the create reader match only `create`.
    expect(isPrOpenCommand('gh pr new --head feat/y --base main --title t')).toBe(true);
    expect(await patternOf('gh pr new --head feat/y --base main --title t')).toBe('open-pr');
  });
  it('C1-3 (F-3): the --raw-field=head= and --field=head= forms are read as the head', async () => {
    // Breaks when: HEAD_FIELD_RE takes only the space form, so the checked-out branch (tapped) is judged in place of `topic`.
    openTap('feat/x');
    for (const f of ['--raw-field=head=topic', '--field=head=topic']) {
      expect(await patternOf(`${API_CREATE} ${f} -f base=main -f title=t`), f).toBe('open-pr');
    }
    openTap('topic');
    expect((await verdictOf(`${API_CREATE} --raw-field=head=topic -f base=main -f title=t`)).action).toBe('allow');
  });
  it('C1-12 (seat 09:09, Lane Board Multi K9): a create with -R before pr (gh -R <repo> pr create --fill) is a create, and two ride on no one tap', async () => {
    // Breaks when: the create reader needs `gh pr` as adjacent words, so a gh global -R before pr is no create (no tap needed), or a
    // second -R create after a tapped one passes on the same tap.
    expect((await verdictOf(`gh -R ${REPO} pr create --fill`)).action).toBe('deny');
    expect((await verdictOf(`gh --repo ${REPO} pr create --fill`)).action).toBe('deny');
    expect(await patternOf(`gh -R ${REPO} pr merge 5 --squash --match-head-commit ${HEAD}`)).toBe('merge-no-head');
    expect(await patternIn(pwsh(`gh -R ${REPO} pr new --fill`))).toBe('head-unresolved');
    // Since PR 592 (merged in at 35342a75) the create reader also finds this create (shared GH_OPT_PREFIX in PR_CREATE_RE), so its
    // head-unresolved text can come first; the flag-first text is the deny when no create reader sees the call (a merge, a gh path).
    const d = await verdictOf(`gh -R ${REPO} pr create --fill`);
    expect(d.action === 'deny' && d.reason).toMatch(/Put the flag after the subcommand: gh pr create -R <repo>|cannot be read as gh reads it/);
    const m = await verdictOf(`gh -R ${REPO} pr merge 5 --squash --match-head-commit ${HEAD}`);
    expect(m.action === 'deny' && m.reason).toMatch(/Put the flag after the subcommand/);
    openTap('feat/x');
    expect((await verdictOf(`gh pr create --fill && gh -R ${REPO} pr create --fill`)).action).toBe('deny');
    expect((await verdictOf(`gh -R ${REPO} pr create --head feat/x --base main --title t --body-file b.md`)).action).toBe('deny'); // the tap does not clear it
  });
  it('C1-C12 (cost): the flag after the subcommand still passes with the tap; a gh flag with no create or merge in the text is no deny', async () => {
    // Breaks when: the rule fires on any gh flag, or on a create whose -R stands after the subcommand.
    openTap('feat/x');
    expect((await verdictOf(`gh pr create -R ${REPO} --head feat/x --base main --title t --body-file b.md`)).action).toBe('allow');
    expect(await verdictOf('gh --version && gh pr list')).toEqual({ action: 'allow' });
    expect(await verdictOf(`gh -R ${REPO} pr view 5`)).toEqual({ action: 'allow' });
  });
  it('C1-4 (F-4): -F on gh pr create is the body file, never a head field', async () => {
    // Breaks when: -F head=<x> is read as a head on gh pr create (a tap for `approved` then opens feat/x).
    openTap('approved');
    expect(await patternOf('gh pr create -F head=approved --title t')).toBe('open-pr');
  });
  it('C1-5 (class): two different heads on gh pr create (--head a -H b) are head-unresolved in a CCv3 checkout', async () => {
    // Breaks when: the CCv3 path reads the first head while gh takes the last.
    openTap('feat/a');
    expect(await patternOf('gh pr create --head feat/a -H feat/b --title t')).toBe('head-unresolved');
    expect(await patternOf(`${API_CREATE} -f head=feat/a -f head=feat/b -f base=main`)).toBe('head-unresolved');
  });
  it('C1-6 (class): a head or base field from a file (=@) is head-unresolved', async () => {
    openTap('feat/x');
    expect(await patternOf(`${API_CREATE} -F head=@h.txt -f base=main -f title=t`)).toBe('head-unresolved');
    expect(await patternOf(`${API_CREATE} -f head=feat/x -F base=@b.txt -f title=t`)).toBe('head-unresolved');
  });
  it('C1-7 (class, seat 2026-11-14): a head_repo field is head-unresolved', async () => {
    // Breaks when: head_repo (a branch of another repository) is ignored and the tap for the local branch passes.
    openTap('feat/x');
    expect(await patternOf(`${API_CREATE} -f head=feat/x -f head_repo=someone/fork -f base=main -f title=t`)).toBe('head-unresolved');
  });
  it('C1-8 (class): an unknown flag on gh pr create or an unknown field on the api create is head-unresolved', async () => {
    openTap('feat/x');
    expect(await patternOf('gh pr create --some-new-flag x --title t')).toBe('head-unresolved');
    expect(await patternOf(`${API_CREATE} -f head=feat/x -f base=main -f odd=1`)).toBe('head-unresolved');
  });
  it('C1-9 (class): a head that is not literal, or an unpaired quote, is head-unresolved', async () => {
    openTap('feat/x');
    // C2b (class C): the unpaired quote cannot be parsed, so its deny is parse-error; the other three keep head-unresolved.
    for (const c of ['gh pr create --head $B --title t', 'gh pr create --head %B% --title t', 'gh pr create --title "open', `${API_CREATE} -f head=$B -f base=main`]) {
      expect(await patternOf(c), c).toBe(c.endsWith('"open') ? 'parse-error' : 'head-unresolved');
    }
  });
  it('C1-10 (pre-read 1): a head after 2>&1 on gh pr create is read (CCv3 path, which reads the &-cut text)', async () => {
    openTap('feat/a');
    expect(await patternOf('gh pr create --head feat/a --title t 2>&1 --head feat/b')).toBe('head-unresolved');
  });
  it('C1-11 (advisor 3): an api create whose quoted title holds "gh pr new" is read by the api reader', async () => {
    // Breaks when: createRead takes the CLI reader when gh pr new|create appears anywhere, so the api head fields are not read.
    openTap('feat/x');
    expect(await patternOf(`${API_CREATE} -f head=topic -f base=main -f title="use gh pr new"`)).toBe('open-pr');
  });
  it('C1-C3 (cost, seat ruling 7): a heredoc body or a backslash path denies, and the deny text names the way out', async () => {
    // Breaks when: the deny text stops naming --body-file and -F body=@ (the way out of the cost).
    openTap('feat/x');
    const d = await verdictOf(`gh pr create --head feat/x --title t --body "$(cat <<'EOF'\nx\nEOF\n)"`);
    expect(d.action === 'deny' && d.pattern).toBe('head-unresolved');
    expect(d.action === 'deny' && d.reason).toMatch(/--body-file <path>/);
    expect(await patternOf('gh pr create --head feat/x --title t --body-file C:\\tmp\\b.md')).toBe('head-unresolved');
    expect((await verdictOf("gh pr create --head feat/x --title t --body-file 'C:/tmp/b.md'")).action).toBe('allow');
  });
  it('C1-12 (seat item 3): a backslash inside a path passes for the PowerShell tool only; next to a quote it is refused in every tool', async () => {
    // Breaks when: the PowerShell fact is lost (pwsh path refused), reaches Bash (bash path passes), or lets a backslash-quote through.
    openTap('feat/x');
    const body = '-F body=@C:\\Users\\me\\pr-body.md';
    expect((await verdictOf(`${API_CREATE} -f head=feat/x -f base=main -f title=t ${body}`)).action).toBe('deny');
    expect(await patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title=t ${body}`))).toBe('allow');
    // C2b: main with a parse gives these answers; the hand reader is retired. A backslash before a closing double quote is an unpaired quote for the parser (parse-error,
    // class C); a single-quoted value ends at its quote in PowerShell, so the call reads (class B) and the tap decides.
    expect(await patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title="a\\" -f head=feat/y"`))).toBe('parse-error');
    expect(await patternIn(pwsh(`${API_CREATE} -f head=feat/x -f base=main -f title='a\\' -F body=@C:\\b.md`))).toBe('allow');
    expect(await patternIn(pwsh(`${API_CREATE} -f head=feat/z -f base=main -f title='a\\' -F body=@C:\\b.md`)), 'paired: no tap for feat/z').toBe('open-pr');
    expect(await patternIn(pwsh(`gh pr create --head feat/x --title t --body-file 'C:\\tmp\\b.md'`))).toBe('allow');
  });
  it('C1-C4 (seat item 2): the deny texts name the way out for a redirect and for a variable', async () => {
    openTap('feat/x');
    // C2b (class B, redirect half): main with a parse gives this answer; the hand reader is retired. A redirect no longer makes the head unread, so the tapped create
    // and merge pass and the redirect way-out text has no deny to ride on. The variable half stays a deny with its way-out text.
    const d = await verdictOf('gh pr create --head $B --title t');
    expect(d.action === 'deny' && d.reason).toMatch(/put the value in the command as plain text or use a body file/);
    expect((await verdictOf('gh pr create --head feat/x --title t 2>&1')).action, 'redirect on a tapped create').toBe('allow');
    expect((await verdictOf('gh pr create --head feat/z --title t 2>&1')).action, 'paired: no tap for feat/z').toBe('deny');
    landTap(5);
    expect((await verdictOf(`${MERGE} 5 --squash --match-head-commit ${HEAD} 2>&1`)).action, 'redirect on a tapped merge').toBe('allow');
    expect((await verdictOf(`${MERGE} 9 --squash --match-head-commit ${HEAD} 2>&1`)).action, 'paired: no tap for PR 9').toBe('deny');
  });
  it('C1-C1 (cost): the plain gh pr create forms still pass with the tap', async () => {
    // Breaks when: a known flag or form of the plain create is read as unknown.
    openTap('feat/x');
    for (const c of [
      'gh pr create --head feat/x --base main --title "a b" --body "c d" --draft',
      'gh pr create --head=feat/x --base=main -t t -b b',
      'gh pr create -H feat/x -B main -t t -F body.md -l bug -a me -r you',
      'gh pr create --title t --body-file b.md --fill',
      'gh pr create -dF b.md --title t',
      `gh pr create -R ${REPO} --title t`,
      'gh pr new --title t --body b',
    ]) expect((await verdictOf(c)).action, c).toBe('allow');
  });
  it('C1-C2 (cost): the plain api create forms still pass with the tap', async () => {
    openTap('feat/x');
    for (const c of [
      `${API_CREATE} -f head=feat/x -f base=main -f title=t -F body=@b.md`,
      `gh api repos/${REPO}/pulls --method POST --raw-field=head=feat/x --field base=main -f title=t -F draft=true`,
      `gh api repos/{owner}/{repo}/pulls -X POST -f head=feat/x -f base=main -f title="a b" -f body='c $d'`,
    ]) expect((await verdictOf(c)).action, c).toBe('allow');
  });
});

/**
 * C4: no unmodelled state change before a push. A push is judged only when every step before the LAST step that names a push is a cd,
 * a read-only git call or a push, or when the command is the modelled `git commit ... && git push` (the index rule). Anything else (a
 * checkout, a reset, a merge, a commit joined by ; or ||, a group, a script) can move HEAD, the branch or the tree before the push, and
 * the gate reads them before the command runs: a HARD deny, push-state-unknown. A chained commit with a push that has its own -C is
 * judged on the index only when rev-parse --show-toplevel proves the same checkout (at most 3 extra git calls; a failed call denies).
 *   - item 16: git checkout re/topic && git push fork HEAD:main     -> C4-1 (red today: main is allowed with no tap)
 *   - R3-b: git commit -m x && git -C . push fork feat/x            -> C4-2 (red today: the HEAD tree is judged)
 *   - class: git reset --hard origin/main && git push fork HEAD:feat, a group, a ; commit -> C4-3..C4-6
 */
const shipTapOn = (tree: string) => {
  expect(offerWrite({ step: 'ship', key: decisionKey({ branch: 'feat/x' }), head: HEAD, tree, spec: { header: 'T', question: 'Q?', options: [{ label: 'Commit and push (Recommended)' }, { label: 'Another option' }] } }).ok).toBe(true);
  expect(decisionRecord({ step: 'ship', key: decisionKey({ branch: 'feat/x' }), head: HEAD, label: 'Commit and push (Recommended)' })).toEqual({ ok: true });
};

/** The push pattern in the shipped state (enforcePush absent): a soft deny comes back as allow with a warn that opens with its pattern. */
const pushPat = async (command: string): Promise<string> => {
  const d = await verdictOf(command);
  if (d.action === 'deny') return d.pattern;
  return 'warn' in d && typeof d.warn === 'string' ? `warn:${d.warn.split(':')[0]}` : 'allow';
};

describe('C4: no unmodelled state change before a push', () => {
  it('C4-1 (item 16): a checkout before a push to main is a hard deny (the gate would judge the head from before the checkout)', async () => {
    // Breaks when: a push of HEAD:main after a branch change is allowed as a main push, or scanned against the old head.
    const d = await verdictOf('git checkout re/topic && git push fork HEAD:main');
    expect(d.action === 'deny' && d.pattern).toBe('push-state-unknown');
    expect(d.action === 'deny' && d.reason).toMatch(/Run the branch change and the push as two commands/);
    // Dave 2026-11-15: the exact two-command form for the top measured case (a commit the index rule cannot model).
    expect(d.action === 'deny' && d.reason).toMatch(/commit in one command .* and push in the next command \(git push <remote> <branch>\)/);
    expect((await run(bash('git checkout re/topic && git push fork HEAD:main'))).permissionDecision).toBe('deny'); // hard: enforcePush absent
  });
  it('C4-2 (R3-b): a chained commit and a push with -C . are judged on the index when the same checkout is proven', async () => {
    // Breaks when: a push with its own -C after a commit reads the HEAD tree (an old tap then passes the new contents).
    shipTapOn(TREE);
    expect(await pushPat('git commit -m x && git -C . push fork feat/x')).toBe('warn:ship');
    shipTapOn(INDEX);
    expect(await pushPat('git commit -m x && git -C . push fork feat/x')).toBe('allow');
  });
  it('C4-3 (class): a chained commit and a push in ANOTHER checkout is push-tree-unresolved', async () => {
    shipTapOn(INDEX);
    shipTapOn(TREE);
    expect(await pushPat('git commit -m x && git -C /other/wt push fork feat/x')).toBe('warn:push-tree-unresolved');
  });
  it('C4-4 (class, design note): a reset, a merge or a ; commit before the push is push-state-unknown, whatever the tap', async () => {
    // Breaks when: a state change the gate does not model falls back to the HEAD tree rule (a tap on the OLD tree passes the new commit).
    shipTapOn(TREE);
    for (const c of ['git reset --hard origin/main && git push fork HEAD:feat/x', 'git merge fork/main && git push fork feat/x',
      'git commit -F m.txt; git push fork feat/x', 'git stash pop && git push fork feat/x', 'npm run build && git push fork feat/x']) {
      expect(await patternOf(c), c).toBe('push-state-unknown');
    }
  });
  it('C4-5 (class): a push inside a group after a change of branch is push-state-unknown (the last step that names a push decides)', async () => {
    shipTapOn(TREE);
    expect(await patternOf('git push fork feat/x; (git checkout other; git push fork feat/x)')).toBe('push-state-unknown');
    expect(await patternOf('git status > s.txt; git push fork feat/x')).toBe('push-state-unknown');
  });
  it('C4-C3 (cost): the words of the push step itself are the push reader\'s business, not C4 (a wrapper, a redirect after it)', async () => {
    // Breaks when: C4 also judges the last push step, so a wrapper or a redirect on the push itself becomes a hard state deny.
    shipTapOn(TREE);
    expect(await pushPat('nice -n 5 git push fork feat/x')).toBe('allow');
    expect(await pushPat('git push fork feat/x > log.txt')).not.toBe('push-state-unknown');
  });
  it('C4-C1 (cost): a pipe or 2>&1 AFTER the push, a read before it, a second push: still judged by the tap', async () => {
    // Breaks when: the rule reads what follows the last push, or refuses cd and read-only git before it.
    shipTapOn(TREE);
    for (const c of ['git push fork feat/x 2>&1 | tail -5', 'cd /repo && git status && git push fork feat/x', 'git push fork feat/x && git log -1',
      'git push fork feat/x; git push fork feat/x', 'pwsh -File scripts/git-safe.ps1 push fork feat/x']) {
      expect(await pushPat(c), c).toBe('allow');
    }
  });
  it('C4-C2 (cost): the modelled commit && push (the index rule) still passes with a tap on the index tree', async () => {
    shipTapOn(INDEX);
    expect(await pushPat('git commit -F m.txt && git push fork feat/x')).toBe('allow');
    expect(await pushPat('pwsh -File scripts/git-safe.ps1 commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x')).toBe('allow');
  });
  it('C4-7 (CLI :2394, Dave 2026-11-15 "Fix now"): a pipe after the last push feeds only a listed read-only program, else push-state-unknown', async () => {
    // Breaks when: what follows the last push is ignored. Both sides of a pipe run at the same time, so `| git reset --hard` can move HEAD
    // before the push reads it (the index rule then passes a tap on the wrong tree).
    shipTapOn(INDEX);
    for (const c of ['git commit -F m.txt && git push fork HEAD:feat/x | git reset --hard other', 'git push fork feat/x | ForEach-Object { $_ }',
      'git push fork feat/x | tail -3 > .git/HEAD', 'git push fork feat/x | Tee-Object out.txt', 'git push fork feat/x | node x.js',
      'git push fork feat/x | tail -3 >> log.txt', 'git push fork feat/x | Select-String x -Path $(git reset --hard o)', "git push fork feat/x | 'tail' -3"]) {
      expect(await patternOf(c), c).toBe('push-state-unknown');
    }
    expect(await patternIn(pwsh('git push fork feat/x 2>&1 | ForEach-Object { git reset --hard o }'))).toBe('push-state-unknown');
  });
  it('C4-8 (seat read of f1e57235): a background & after the last push, or a sort that can write a file, is push-state-unknown', async () => {
    // Breaks when: only a single | after the push is read, so `push & git reset --hard` (both run at the same time) keeps the index rule,
    // or sort stays on the list (sort -o writes a file with no redirect).
    shipTapOn(INDEX);
    for (const c of ['git commit -F m.txt && git push fork HEAD:feat/x & git reset --hard other', 'git commit -F m.txt && git push fork HEAD:feat/x &',
      'git push fork feat/x & tail -3', 'git push fork feat/x | sort -o .git/HEAD', 'git push fork feat/x | sort']) {
      expect(await patternOf(c), c).toBe('push-state-unknown');
    }
    expect((await verdictOf('git commit -F m.txt && git push fork HEAD:feat/x & git reset --hard other')).action === 'deny'
      && (await verdictOf('git commit -F m.txt && git push fork HEAD:feat/x & git reset --hard other') as { reason: string }).reason).toMatch(/runs at the same time/);
  });
  it('C4-8b: a & that ends an && or | list holding the push backgrounds the push too', async () => {
    // Breaks when: only the separator right after the push is read (bash backgrounds the whole and-or list: push && x & reset).
    shipTapOn(INDEX);
    for (const c of ['git push fork feat/x && git log -1 & git reset --hard o', 'git push fork feat/x | tail -1 & git reset --hard o']) {
      expect(await patternOf(c), c).toBe('push-state-unknown');
    }
  });
  it('C4-8c (seat word): a backgrounded group or subshell that holds the push is push-state-unknown; a ; inside quotes ends nothing', async () => {
    // The groups deny by the C4 group rule, not by backgroundAfter: the step that opens the group (`( git commit ...`, `{ git commit ...`)
    // is "other" (segmentKind refuses ( ) { }), so the push is not modelled. The walk reads the quote-masked text, so a quoted ; or &
    // is no separator: `grep "a;b" & reset` is still a background push, and `grep "x & y"; git status` is not.
    shipTapOn(INDEX);
    for (const c of ['( git commit -F m.txt && git push fork HEAD:feat/x ) & git reset --hard other', '{ git commit -F m.txt; git push fork HEAD:feat/x; } & git reset --hard other',
      'git push fork feat/x | grep "a;b" & git reset --hard o']) {
      const d = await verdictOf(c);
      expect(d.action === 'deny' && d.pattern, c).toBe('push-state-unknown');
    }
    shipTapOn(TREE);
    expect(await pushPat('git push fork feat/x | grep "x & y"; git status')).toBe('allow');
  });
  it('C4-C8 (cost): && after the push, 2>&1, and a & after a ; (the push is done by then) are no background push', async () => {
    // The measured case (2 of 588): git-safe push ... 2>&1 | tail -1; cd x && ... & ... (the & comes after the ; that ends the push).
    shipTapOn(TREE);
    for (const c of ['git push fork feat/x && git log -1', 'git push fork feat/x 2>&1 && git status', 'git push fork feat/x | tail -1; npm run watch & git status']) {
      expect(await pushPat(c), c).toBe('allow');
    }
  });
  it('C4-C7 (cost): listed consumers, a chain of them, 2>&1 and a null redirect still pass', async () => {
    // Breaks when: the consumer rule refuses the measured git-safe flows (175 Select-Object and 67 tail of 588 a week).
    shipTapOn(TREE);
    for (const c of ['git push fork feat/x | tail -5', 'git push fork feat/x 2>&1 | grep -v x | tail -3', 'git push fork feat/x | tail -3 > /dev/null',
      'git push fork feat/x | cut -c1-80 | wc -l', 'git push fork feat/x | head -2']) {
      expect(await pushPat(c), c).toBe('allow');
    }
    for (const c of ['git push fork feat/x 2>&1 | Select-Object -Last 5', 'git push fork feat/x | Out-String', 'git push fork feat/x | Select-String rejected | Out-Null',
      'git push fork feat/x 2>&1 | Select-Object -Last 3 > $null']) {
      expect(await patternIn(pwsh(c)), c).toBe('allow');
    }
  });
  it('C4-6 (measured flow): commit && push with a pipe AFTER the push is the index rule, not the HEAD tree rule', async () => {
    // Breaks when: commitPrecedesPush reads the whole text, so a trailing pipe makes the commit-and-push flow fall to the HEAD tree
    // (an old tap passes the new contents) or to push-state-unknown (the git-safe commit-and-push flow, found by the C4 measure).
    const c = 'git commit -F m.txt && pwsh -File scripts/git-safe.ps1 push fork feat/x 2>&1 | Select-Object -Last 3';
    shipTapOn(TREE);
    expect(await pushPat(c)).toBe('warn:ship');
    shipTapOn(INDEX);
    expect(await pushPat(c)).toBe('allow');
  });
});

/**
 * C3: a push is read whole, or it is denied hard (seat rulings 2026-11-15 08:55, milestone 538 of re-program.md). The source AND the
 * destination of a refspec decide the re/ scan; a push that moves the repo (--git-dir, GIT_DIR=) or that only a payload holds is a HARD
 * deny where a folder is CCv3 or cannot be placed. Only the text of a deny changes for a re/ push with a pipe after it (Q4 option b).
 *   - item 15: git push fork re/x:feat/y, refs/heads/re/x:feat/y, HEAD:feat/y on re/topic -> C3-1 (red today: no scan, a ship warn)
 *   - item 10: git --git-dir=.git push, GIT_DIR=.git git push                              -> C3-2 (red today: a warn)
 *   - Q1: sh -c 'git push fork re/x' in a CCv3 root                                        -> C3-3 (red today: a plain allow)
 *   - builder A: git-safe push of re/ with 2>&1 | Select-Object                            -> C3-4 (red today: "also commits")
 *   - item 11: & git-safe.ps1 'push' '--force' (destructive classifier)                    -> C3-5 (red today: no ask)
 */
const ID = 'HOLD-ID-1';
const verdictIn = async (input: object, w: World) => await decideParsed(input, deps(w));
const patIn = async (input: object, w: World): Promise<string> => { const d = await verdictIn(input, w); return d.action === 'deny' ? d.pattern : 'warn' in d && typeof d.warn === 'string' ? `warn:${d.warn.split(':')[0]}` : 'allow'; };

describe('C3: a push is read whole, or it is denied hard', () => {
  it('C3-1 (item 15): a re/ SOURCE pushed to another destination is scanned for holdout ids', async () => {
    // Breaks when: isRe reads only the destination branch, so re/x:feat/y (or HEAD:feat/y on a re/ branch) skips the scan.
    const w: World = { scan: { ids: [ID], added: `see ${ID}` } };
    expect(await patIn(bash('git push fork re/x:feat/y'), w)).toBe('holdout-id');
    expect(await patIn(bash('git push fork refs/heads/re/x:feat/y'), w)).toBe('holdout-id'); // a spelling not in the list
    expect(await patIn(bash('git push fork HEAD:feat/y'), { ...w, branch: 're/topic' })).toBe('holdout-id');
    expect((await run(bash('git push fork re/x:feat/y'), w)).permissionDecision).toBe('deny'); // hard: enforcePush absent
  });
  it('C3-C1 (cost): the same pushes with no id in their content keep the ship rule; a feat source is not a re/ scan', async () => {
    const w: World = { scan: { ids: [ID], added: 'clean line' } };
    expect(await patIn(bash('git push fork re/x:feat/y'), w)).toBe('warn:ship');
    expect(await patIn(bash('git push fork HEAD:feat/y'), { ...w, branch: 're/topic' })).toBe('warn:ship');
    expect(await patIn(bash('git push fork feat/z:feat/y'), { scan: { ids: [ID], added: `see ${ID}` } })).toBe('warn:ship');
  });
  it('C3-2 (item 10): a push that moves the repo (--git-dir, GIT_DIR=) in a CCv3 root is a hard deny, not a warn', async () => {
    // Breaks when: the moved-repo fallback of intentDeny stays soft, so with enforcePush absent the push (re/ unscanned) only warns.
    for (const c of ['git --git-dir=.git push fork re/x', 'GIT_DIR=.git git push fork re/x', 'git --work-tree=. push fork feat/x']) {
      const o = await run(bash(c));
      expect(o.permissionDecision, c).toBe('deny');
      expect(o.permissionDecisionReason, c).toMatch(/push-target-unresolved|checkout this command runs in cannot be known|checkout is unknown/);
    }
  });
  it('C3-C2 (cost, R18-C3 narrowing): the same push in a resolved unregistered folder keeps the warning', async () => {
    // Breaks when: the item 10 hard deny reaches a folder outside every registry root (Dave D1).
    for (const c of ['git --git-dir=.git push up feat/x', 'GIT_DIR=.git git push up feat/x']) {
      const o = await run({ ...bash(c), cwd: '/elsewhere/app' });
      expect(o.permissionDecision, c).toBeUndefined();
      expect(o.additionalContext, c).toMatch(/WARNING \(decision-gate, warn mode\)/); // the warning itself, not an empty answer
    }
  });
  it('C3-3 (seat Q1): a push that only a payload holds (sh -c, bash -c, pwsh -c) in a CCv3 root is a hard push-target-unresolved', async () => {
    // Breaks when: the raw rule skips a CCv3 root, so a re/ push in a payload runs with no scan and no tap (today: a plain allow).
    for (const c of ["sh -c 'git push fork re/x'", 'bash -c "git push fork feat/x"', `sh -c 'git -C "/repo/My App" push fork feat/x'`]) {
      const d = await verdictOf(c);
      expect(d.action === 'deny' && d.pattern, c).toBe('push-target-unresolved');
      expect(d.action === 'deny' && d.reason, c).toMatch(/run git push as its own command/i);
      expect((await run(bash(c))).permissionDecision, c).toBe('deny');
    }
    expect(await patternIn(pwsh("pwsh -c 'git push fork feat/x'"))).toBe('push-target-unresolved');
  });
  it('C3-C3 (cost): a command that only names push in a payload as text, and a plain push, keep today\'s result', async () => {
    // Breaks when: the CCv3 raw rule fires on a word, not on a git push call.
    expect(await verdictOf("sh -c 'echo push the button'")).toEqual({ action: 'allow' });
    expect(await verdictOf('git commit -m "push later"')).toEqual({ action: 'allow' });
    expect(await pushPat('git push fork main')).toBe('allow');
  });
  it('C3-4 (builder A, seat Q4 option b): a re/ push with 2>&1 | Select-Object is denied with the real cause, not "also commits"', async () => {
    // Breaks when: the scan text for a push that is not alone says the command commits or changes the branch.
    const c = 'pwsh -File scripts/git-safe.ps1 push fork re/topic 2>&1 | Select-Object -Last 3';
    const d = await decideParsed(pwsh(c), deps({ scan: { ids: [ID], added: 'clean' }, branch: 're/topic' }));
    expect(d.action === 'deny' && d.pattern).toBe('holdout-scan-unavailable');
    expect(d.action === 'deny' && d.reason).not.toMatch(/also commits/);
    expect(d.action === 'deny' && d.reason).toMatch(/run the push with no pipe and no redirect/i);
    // The chained commit keeps its own text.
    const e = await decideParsed(bash('git commit -F m.txt && git push fork re/topic'), deps({ scan: { ids: [ID], added: 'clean' }, branch: 're/topic' }));
    expect(e.action === 'deny' && e.reason).toMatch(/also commits/);
  });
  it('C3-5 (item 11): a quoted push word after the git wrapper is read as push by the destructive classifier', () => {
    // Breaks when: the wrapper force-push rule needs an unquoted push, so '& git-safe.ps1 'push' '--force'' gets no ask.
    for (const c of ["& scripts/git-safe.ps1 'push' '--force' fork x", '& scripts/git-safe.ps1 "push" --force fork x', "pwsh -File scripts/git-safe.ps1 -C . 'push' '+feat/x'"]) {
      expect(classifyDestructive(c, 0, 'PowerShell'), c).toBe('git push --force');
    }
  });
  it('C3-5b (seat fix 1): a quoted option value that starts with push, then a later value with ; still asks (the option value is not the subcommand)', () => {
    // Breaks when: WRAPPER_OPT refuses a quoted value that starts with push, so the rule reads that value as the subcommand and the ;
    // inside it ends the match before the real --force (an ask dropped: only-tightens broken).
    // The quoted wrapper path with a blank is read only by the wrapper rule (the quote-stripped rewrite cannot name it).
    for (const c of ["& scripts/git-safe.ps1 -Remote 'push;x' push --force fork x", '& scripts/git-safe.ps1 -Remote "push|x" push --force fork x',
      "& 'C:\\my repo\\scripts\\git-safe.ps1' -Remote 'push;x' push --force fork x"]) {
      expect(classifyDestructive(c, 0, 'PowerShell'), c).toBe('git push --force');
    }
  });
  it('C3-6 (seat fix 2): a remote list that throws is no proof of "not CCv3": the raw rule and the gh flag-first rule deny', async () => {
    // Breaks when: a throw from isCcv3Checkout reads as "not CCv3", so a payload push or a flag-first create in that folder passes.
    for (const c of ["sh -c 'git push fork re/x'", `gh -R ${REPO} pr create --fill`]) {
      expect((await run(bash(c), { throwIn: '/repo' })).permissionDecision, c).toBe('deny');
    }
  });
  it('C3-C6 (cost, R18-C3 narrowing): the same throw in a resolved folder under no registry root keeps today\'s result', async () => {
    // The flag-first row uses a merge: since PR 592 the create reader also reads gh -R ... pr create, and a create whose git throws is a
    // deny there by today's rule (R18-C1), so a create cannot show the flag-first narrowing.
    for (const c of ["sh -c 'git push up feat/x'", `gh -R ${REPO} pr merge 5 --squash --match-head-commit ${HEAD}`]) {
      expect((await run({ ...bash(c), cwd: '/elsewhere/app' }, { throwIn: '/elsewhere' })).permissionDecision, c).toBeUndefined();
    }
  });
  it('C3-7 (seat fix 4): a source taken from HEAD or @ with ~ or ^ reads the checked-out branch for the re/ scan', async () => {
    // Breaks when: sendsRe matches only a bare HEAD or @, so HEAD~0:feat/y on a re/ branch skips the scan.
    const w: World = { scan: { ids: [ID], added: `see ${ID}` }, branch: 're/topic' };
    for (const c of ['git push fork @:feat/y', 'git push fork HEAD~0:feat/y', 'git push fork @~0:feat/y', 'git push fork HEAD^0:feat/y']) {
      expect(await patIn(bash(c), w), c).toBe('holdout-id');
    }
  });
  it('C3-8 (seat fix 5): popd and Pop-Location before a push are a folder change (the position reader), not an unmodelled step', async () => {
    // Breaks when: pushPrefix reads popd or Pop-Location as "other", so a push after it is push-state-unknown.
    // An absolute -C names the push folder, so the position reader lets it through and C4 decides (with a bare push, position-unknown
    // comes first and hides C4).
    shipTapOn(TREE);
    expect(await pushPat('popd && git -C /repo push fork feat/x')).toBe('allow');
    expect(await patternIn(pwsh('Pop-Location; git -C /repo push fork feat/x'))).not.toBe('push-state-unknown');
  });
  it('C3-9 (seat fix 6): a push to a local path before the last push moves a local branch: push-state-unknown', async () => {
    // Breaks when: every push step before the last push counts as safe, so git push . HEAD:feat/x moves feat/x before the judged push.
    shipTapOn(TREE);
    for (const c of ['git push . HEAD:feat/x && git push fork feat/x', 'git push ../other main && git push fork feat/x', 'git push /tmp/r.git x && git push fork feat/x']) {
      expect(await patternOf(c), c).toBe('push-state-unknown');
    }
    expect(await pushPat('git push fork other && git push fork feat/x')).not.toBe('push-state-unknown'); // cost: a push to a remote first
  });
  it('C1-13 (seat fix 3): a gh named by its path with a flag first is head-unresolved or merge-no-head', async () => {
    // Breaks when: GH_FLAG_FIRST needs a bare gh word, so /usr/bin/gh -R ... or C:\\tools\\gh.exe -R ... is read by no reader.
    expect(await patternOf(`/usr/bin/gh -R ${REPO} pr create --fill`)).toBe('head-unresolved');
    expect(await patternIn(pwsh(`C:\\tools\\gh.exe -R ${REPO} pr create --fill`))).toBe('head-unresolved');
    expect(await patternIn(pwsh(`& "C:\\Program Files\\GitHub CLI\\gh.exe" -R ${REPO} pr merge 5 --squash --match-head-commit ${HEAD}`))).toBe('merge-no-head');
  });
  it('C3-C5 (cost; item 13 Known limit, seat Q3): a plain wrapper push asks no more than today; a message that names the wrapper still asks', () => {
    expect(classifyDestructive('pwsh -File scripts/git-safe.ps1 push fork feat/x', 0, 'PowerShell')).toBeNull();
    expect(classifyDestructive("& scripts/git-safe.ps1 'push' fork feat/x", 0, 'PowerShell')).toBeNull();
    // Item 13 stays as it is (Known limit): the rule keeps asking on a quoted message that names the wrapper and a force form.
    expect(classifyDestructive('git commit -m "document git-safe.ps1 push --force"', 0, 'PowerShell')).toBe('git push --force');
  });
});
