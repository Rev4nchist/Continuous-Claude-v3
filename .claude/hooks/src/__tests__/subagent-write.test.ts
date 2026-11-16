/**
 * Card coord-subagent-write-guard (gap 8): shared/subagent-write.ts. Pure: every outside fact is passed in.
 * Seat ruling 2026-11-16 13:45: deny in the protected places, warn once per path elsewhere, read-only class from the
 * agent files, texts hold only the path and the scratch folder.
 *
 * Ways it can fail (one test each; the first line of the test names the change that turns it red):
 *  1. The main thread (no agent_id) is judged.
 *  2. A read-only subagent writes the state folder and is not denied.
 *  3. A protected place is missing from the deny list (settings, rules, rules-ondemand, repo root).
 *  4. The shell text of a subagent is not read (redirect, tee, mv, cp); a relative or ".." redirect escapes.
 *  5. The scratchpad of the session is denied or warned.
 *  6. A builder type is judged.
 *  7. A subagent with no agent_type is denied outside the protected places, or warned.
 *  8. The warn fires twice for one path.
 *  9. A path trick (..) escapes the scratchpad.
 * 10. A message holds anything but the path and the scratch folder.
 * 11. The class list drifts from the agent files.
 * 12. Bad input crashes a verdict, or a read is denied as a write.
 * 13. A repo-root file is denied for an untyped subagent.
 * 14. Spellings: case, drive letter, %USERPROFILE%, $env:USERPROFILE, /c/ form.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  READ_ONLY_AGENT_TYPES,
  classOf,
  insideScratch,
  judgeDirect,
  judgeShell,
  protectedKind,
  type SubagentDeps,
} from '../shared/subagent-write.js';

const SID = 'sess-1234';
const HOME = '/home/dave';
const TMP = '/tmp';
const SCRATCH = `${TMP}/claude/h1/${SID}/scratchpad`;
const TOP = '/work/ccv3';

type Harness = SubagentDeps & { mark: (p: string) => void };

/** Posix-style stand-ins. `warned` is true after `mark`, like the real once-per-path file. */
function deps(over: Partial<SubagentDeps> = {}): Harness {
  const shown = new Set<string>();
  return {
    home: HOME,
    tmp: TMP,
    tops: [TOP],
    sessionId: SID,
    cwd: TOP,
    fold: false,
    realPath: (p, cwd) => resolve(cwd, p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''),
    warned: (p) => shown.has(p),
    mark: (p) => void shown.add(p),
    scratchFolder: SCRATCH,
    ...over,
  };
}

const critic = { agent_id: 'a1', agent_type: 'critic' };
const untyped = { agent_id: 'a2' };
const kraken = { agent_id: 'a3', agent_type: 'kraken' };
const main = {};
const shell = (who: object, text: string, d: SubagentDeps = deps()) => judgeShell(who, text, d);

describe('subagent-write: who is judged', () => {
  it('1: the main thread is never judged (breaks if the agent_id gate is dropped)', () => {
    expect(judgeDirect(main, [`${HOME}/.claude/state/x.json`], deps()).kind).toBe('allow');
    expect(shell(main, `echo x > ${HOME}/.claude/state/x.json`).kind).toBe('allow');
  });

  it('6: a builder type is not judged (breaks if every typed subagent is judged)', () => {
    expect(judgeDirect(kraken, [`${HOME}/.claude/state/x.json`], deps()).kind).toBe('allow');
    expect(judgeDirect(kraken, [`${TOP}/README.md`], deps()).kind).toBe('allow');
    expect(shell(kraken, `echo x > ${HOME}/.claude/state/x.json`).kind).toBe('allow');
  });

  it('classOf names the four classes', () => {
    expect(classOf(main)).toBe('main');
    expect(classOf(untyped)).toBe('untyped');
    expect(classOf(kraken)).toBe('other');
    expect(classOf(critic)).toBe('readonly');
  });
});

describe('subagent-write: the protected places', () => {
  it('2: a read-only subagent writing the state folder is denied (breaks if the state prefix is dropped)', () => {
    expect(judgeDirect(critic, [`${HOME}/.claude/state/review-engine/read-audit.jsonl`], deps()).kind).toBe('deny');
  });

  it('3: each protected place denies (breaks if one prefix is missing)', () => {
    for (const p of [
      `${HOME}/.claude/state/a.json`,
      `${HOME}/.claude/settings.json`,
      `${HOME}/.claude/settings.local.json`,
      `${HOME}/.claude/rules/x.md`,
      `${HOME}/.claude/rules-ondemand/x.md`,
      `${TOP}/SECRET-ci`,
    ]) {
      expect(judgeDirect(critic, [p], deps()).kind, p).toBe('deny');
    }
  });

  it('3b: a near miss is not protected (breaks if the match is a loose substring)', () => {
    for (const p of [`${HOME}/.claude/statefile.txt`, `${HOME}/.claude/rules-extra/x.md`, `${HOME}/.claude/settingsx/y`, `${TOP}/sub/file.txt`]) {
      expect(protectedKind(p, deps(), true), p).toBeNull();
    }
    expect(protectedKind(`${HOME}/.claude/settings.json`, deps(), false)).toBe('settings');
    expect(protectedKind(`${TOP}/SECRET-ci`, deps(), false)).toBeNull();
  });

  it('3c: the shell reads a near miss as no protected place, so no deny (breaks if the token has no end boundary or a null kind denies)', () => {
    for (const who of [critic, untyped]) {
      expect(shell(who, `echo x > ${HOME}/.claude/statefile.txt`).kind, 'statefile').not.toBe('deny');
      expect(shell(who, `echo x > ${HOME}/.claude/rules-src/x.md`).kind, 'rules-src').not.toBe('deny');
      expect(shell(who, `echo x > ~/.claude/settingsx/y`).kind, 'settingsx').not.toBe('deny');
    }
  });

  it('13: an untyped subagent is denied in the four places under ~/.claude, not at the repo root (breaks if repo root is judged for it)', () => {
    expect(judgeDirect(untyped, [`${HOME}/.claude/rules-ondemand/x.md`], deps()).kind).toBe('deny');
    expect(judgeDirect(untyped, [`${HOME}/.claude/state/x`], deps()).kind).toBe('deny');
    expect(judgeDirect(untyped, [`${TOP}/package.json`], deps()).kind).toBe('allow');
    expect(shell(untyped, `echo x > ${TOP}/package.json`).kind).toBe('allow');
  });

  it('7: an untyped subagent is never warned (breaks if the warn applies to every subagent)', () => {
    expect(judgeDirect(untyped, [`${TOP}/src/a.ts`], deps()).kind).toBe('allow');
    expect(shell(untyped, `echo hi > ${TOP}/notes.txt`).kind).toBe('allow');
  });

  it('9: a ".." out of the scratchpad is judged on the real path (breaks if the raw string is compared)', () => {
    const sneaky = `${SCRATCH}/../../../../../${HOME.slice(1)}/.claude/state/x.json`;
    expect(judgeDirect(critic, [sneaky], deps()).kind).toBe('deny');
    expect(shell(critic, `echo x > ${sneaky}`).kind).toBe('deny');
  });
});

describe('subagent-write: the shell text', () => {
  it('4: a redirect or tee into a protected place is denied (breaks if the shell text is not read)', () => {
    expect(shell(critic, `echo x > ${HOME}/.claude/state/read-audit.jsonl`).kind).toBe('deny');
    expect(shell(critic, `echo x | tee ${HOME}/.claude/rules/x.md`).kind).toBe('deny');
    expect(shell(critic, `echo x > ~/.claude/state/y.json`).kind).toBe('deny');
    expect(shell(critic, `echo x >> $HOME/.claude/settings.json`).kind).toBe('deny');
    expect(shell(critic, `echo x > ${TOP}/SECRET-ci`).kind).toBe('deny');
  });

  it('4a: a relative or ".." redirect resolves against the cwd (breaks if the redirect target skips the real path)', () => {
    expect(shell(critic, 'echo x > notes.txt').kind).toBe('deny'); // cwd is the checkout root
    expect(shell(critic, `echo x > /tmp/../home/dave/.claude/state/x.json`).kind).toBe('deny');
    expect(shell(critic, 'echo x > src/ok.txt').kind).toBe('warn'); // inside the checkout, not its root
    expect(shell(untyped, `echo x > /tmp/../home/dave/.claude/state/x.json`).kind).toBe('deny');
    expect(shell(untyped, 'echo x > notes.txt').kind).toBe('allow');
  });

  it('4e: mv and cp name a protected path as an operand (breaks if the verb list or the operand rule is dropped)', () => {
    expect(shell(critic, `mv /tmp/a ${HOME}/.claude/state/x.json`).kind).toBe('deny');
    expect(shell(critic, `mv ${HOME}/.claude/rules/x.md /tmp/a`).kind).toBe('deny'); // the move removes it
    expect(shell(critic, `cp /tmp/a ${HOME}/.claude/rules/x.md`).kind).toBe('deny');
    expect(shell(critic, `rm -f ${HOME}/.claude/state/old.json`).kind).toBe('deny');
    expect(shell(critic, `sed -i s/a/b/ ${HOME}/.claude/settings.json`).kind).toBe('deny');
  });

  it('4b: reading a protected path is no write, also after a write verb earlier in the text (breaks if any earlier cue arms a deny)', () => {
    expect(shell(critic, `cat ${HOME}/.claude/state/read-audit.jsonl`).kind).toBe('allow');
    expect(shell(critic, `ls ${HOME}/.claude/rules`).kind).toBe('allow');
    expect(shell(critic, `grep -rn "rm" ~/.claude/rules`).kind).toBe('allow');
    expect(shell(critic, `rm ${SCRATCH}/a; cat ~/.claude/settings.json`).kind).toBe('allow');
    expect(shell(critic, `rm /tmp/x; ls ${TOP}/src`).kind).toBe('allow');
    expect(shell(critic, `cp ${HOME}/.claude/rules/x.md /tmp/copy.md`).kind).toBe('allow'); // first operand of cp is read
  });

  it('4c: a script run with no path in its text is a known limit and is allowed', () => {
    expect(shell(critic, 'node scripts/review-engine/probe.mjs').kind).toBe('allow');
  });

  it('4d: stderr redirects and /dev/null are no write (breaks if the digit lookbehind or the /dev filter is dropped)', () => {
    expect(shell(critic, 'git status 2>/dev/null').kind).toBe('allow');
    expect(shell(critic, 'cmd > /dev/null 2>&1').kind).toBe('allow');
    expect(shell(critic, `node x 2> ${TOP}/src/err.log`).kind).toBe('allow');
    expect(shell(critic, `node x 2>> ${TOP}/src/err.log`).kind).toBe('allow');
  });

  it('4f: a ">" inside quotes is data, not a redirect (breaks if quoted text is scanned)', () => {
    expect(shell(critic, `node -e "console.log(1 > 0)"`).kind).toBe('allow');
    expect(shell(critic, `echo 'a > b'`).kind).toBe('allow');
    expect(shell(critic, `echo x > "${HOME}/.claude/state/q.json"`).kind).toBe('deny'); // a quoted TARGET still counts
  });

  it('a "~" target is the home, not a folder named "~" (breaks if the target is not expanded)', () => {
    expect(shell(critic, 'echo x > ~/n.txt').kind).toBe('warn');
    const v = shell(critic, 'echo x > ~/n.txt');
    expect(v.kind === 'warn' ? v.path : '').toBe(`${HOME}/n.txt`);
  });

  it('a text over the size cap is not scanned', () => {
    const big = `echo x > ${HOME}/.claude/state/a ${'x'.repeat(70 * 1024)}`;
    expect(shell(critic, big).kind).toBe('allow');
  });
});

describe('subagent-write: spellings (design test 8)', () => {
  const win = (): SubagentDeps =>
    deps({ home: 'C:/Users/Dave', tmp: 'C:/Temp', tops: ['C:/Work/Ccv3'], cwd: 'C:/Work/Ccv3', fold: true, realPath: (p) => p.replace(/\\/g, '/') });

  it('14: case, drive letter and slash differences decide on one spelling (breaks if fold is ignored)', () => {
    expect(judgeDirect(critic, ['c:\\users\\dave\\.CLAUDE\\State\\x.json'], win()).kind).toBe('deny');
    expect(judgeDirect(critic, ['C:/USERS/DAVE/.claude/rules-ondemand/a.md'], win()).kind).toBe('deny');
    expect(judgeDirect(critic, ['c:/work/ccv3/SECRET'], win()).kind).toBe('deny');
  });

  it('14b: every home spelling of a shell text is read (breaks if a form is missing)', () => {
    for (const home of ['C:/Users/Dave', '/c/Users/Dave', '~', '$HOME', '${HOME}', '$env:USERPROFILE', '%USERPROFILE%', 'c:\\Users\\Dave']) {
      expect(shell(critic, `echo x > ${home}/.claude/state/x.json`, win()).kind, home).toBe('deny');
    }
  });

  it('14c: a checkout top in /c/ form is the root too (breaks if topForms is dropped)', () => {
    expect(shell(critic, 'echo x > /c/Work/Ccv3/notes.txt', win()).kind).toBe('deny');
    expect(shell(critic, 'echo x > C:/Work/Ccv3/notes.txt', win()).kind).toBe('deny');
  });

  it('14d: a primary checkout and a linked worktree are both roots (breaks if only one top is judged)', () => {
    const d = deps({ tops: [TOP, '/work/ccv3/.claude/worktrees/w1'] });
    expect(shell(critic, `echo x > ${TOP}/notes.txt`, d).kind).toBe('deny');
    expect(shell(critic, 'echo x > /work/ccv3/.claude/worktrees/w1/notes.txt', d).kind).toBe('deny');
    expect(shell(critic, 'echo x > /work/ccv3/.claude/worktrees/w1/src/a.txt', d).kind).not.toBe('deny');
  });
});

describe('subagent-write: scratch and warn', () => {
  it('5: its own scratchpad is allowed with no warn (breaks if the scratchpad is judged)', () => {
    expect(judgeDirect(critic, [`${SCRATCH}/notes.md`], deps()).kind).toBe('allow');
    expect(shell(critic, `echo x > ${SCRATCH}/a.txt`).kind).toBe('allow');
  });

  it('5b: another session scratchpad is outside (breaks if any scratchpad passes)', () => {
    expect(insideScratch(`${TMP}/claude/h1/other-sess/scratchpad/a.md`, deps())).toBe(false);
    expect(insideScratch(`${TMP}/claude/h1/${SID}/scratchpadx/a.md`, deps())).toBe(false);
    expect(insideScratch(`${TMP}/claude/h1/${SID}/scratchpad/a.md`, deps())).toBe(true);
    expect(insideScratch(`${TMP}/anything.txt`, deps())).toBe(false);
  });

  it('7b: an untyped subagent writing its scratchpad is allowed with no warn (seat partner of test 7)', () => {
    expect(judgeDirect(untyped, [`${SCRATCH}/a.md`], deps()).kind).toBe('allow');
  });

  it('8: a write outside the scratchpad warns until the caller marks the path shown (breaks if "warned" is not asked)', () => {
    const d = deps();
    const first = judgeDirect(critic, [`${TOP}/src/a.ts`], d);
    expect(first.kind).toBe('warn');
    if (first.kind === 'warn') d.mark(first.path);
    expect(judgeDirect(critic, [`${TOP}/src/a.ts`], d).kind).toBe('allow');
    expect(judgeDirect(critic, [`${TOP}/src/b.ts`], d).kind).toBe('warn');
  });

  it('8b: a verdict marks nothing by itself, so a warn that is never printed does not silence the path', () => {
    const d = deps();
    expect(judgeDirect(critic, [`${TOP}/src/a.ts`], d).kind).toBe('warn');
    expect(judgeDirect(critic, [`${TOP}/src/a.ts`], d).kind).toBe('warn');
  });

  it('a plain redirect outside the scratchpad warns once marked', () => {
    const d = deps();
    const v = shell(critic, `echo x > ${TOP}/src/out.txt`, d);
    expect(v.kind).toBe('warn');
    if (v.kind === 'warn') d.mark(v.path);
    expect(shell(critic, `echo x > ${TOP}/src/out.txt`, d).kind).toBe('allow');
  });

  it('10: the deny and the warn name the path and the scratch folder and nothing from the call (breaks if content or ids leak)', () => {
    const marker = 'TOP-SECRET-CONTENT-9f3';
    const deny = shell(critic, `echo ${marker} > ${HOME}/.claude/state/x.json`);
    expect(deny.kind).toBe('deny');
    const text = deny.kind === 'deny' ? deny.reason : '';
    expect(text).toContain(`${HOME}/.claude/state/x.json`);
    expect(text).toContain(SCRATCH);
    expect(text).not.toContain(marker);
    expect(text).not.toContain('a1');
    const warn = judgeDirect(critic, [`${TOP}/src/x.txt`], deps());
    const wtext = warn.kind === 'warn' ? warn.text : '';
    expect(wtext).toContain(`${TOP}/src/x.txt`);
    expect(wtext).toContain(SCRATCH);
    expect(wtext).not.toContain('a1');
  });

  it('10b: with no scratch folder found the text names the pattern, and control bytes of the id show as "?"', () => {
    const d = deps({ scratchFolder: undefined, sessionId: 'sid\nINJECT' });
    const v = judgeDirect(critic, [`${HOME}/.claude/state/x`], d);
    expect(v.kind).toBe('deny');
    if (v.kind === 'deny') {
      expect(v.reason).toContain('/claude/<hash>/sid?INJECT/scratchpad');
      expect(v.reason).not.toContain('\nINJECT');
    }
    const w = judgeDirect(critic, [`${TOP}/src/x.txt`], d);
    expect(w.kind).toBe('warn');
    if (w.kind === 'warn') expect(w.text).not.toContain('\nINJECT');
  });

  it('a line break or control byte in a path shows as "?" in the deny and the warn', () => {
    const d = deps({ realPath: (p) => p });
    const v = judgeDirect(critic, [`${HOME}/.claude/state/x\nIGNORE ALL`], d);
    expect(v.kind).toBe('deny');
    if (v.kind === 'deny') expect(v.reason).not.toContain('\nIGNORE');
    const w = judgeDirect(critic, [`${TOP}/src/x\nIGNORE ALL`], d);
    expect(w.kind).toBe('warn');
    if (w.kind === 'warn') expect(w.text).not.toContain('\nIGNORE');
  });
});

describe('subagent-write: bad input', () => {
  it('12: an odd payload gives allow, not a throw, and the protected path stays unjudged for a bad agent_id (breaks if a field is assumed)', () => {
    const odd = { agent_id: 7 as unknown, agent_type: {} as unknown };
    expect(judgeDirect(odd, [`${HOME}/.claude/state/x`], deps()).kind).toBe('allow');
    expect(judgeShell(odd, `echo x > ${HOME}/.claude/state/x`, deps()).kind).toBe('allow');
    expect(judgeShell(critic, '', deps()).kind).toBe('allow');
    expect(judgeDirect(critic, [], deps()).kind).toBe('allow');
    expect(judgeDirect(critic, [undefined as unknown as string, ''], deps()).kind).toBe('allow');
    expect(judgeShell(critic, undefined as unknown as string, deps()).kind).toBe('allow');
  });
});

describe('subagent-write: the class list follows the agent files', () => {
  it('11: READ_ONLY_AGENT_TYPES is exactly the agents with no Write and no Edit tool (breaks when an agent file or the list changes alone)', () => {
    const dir = resolve(__dirname, '../../../agents');
    const want: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      const line = /^tools:[ \t]*(.*)$/m.exec(fm);
      if (!line) continue; // no tools line: the agent inherits all tools; not read-only
      let tools = line[1];
      if (!tools.trim()) {
        const after = fm.slice(fm.indexOf(line[0]) + line[0].length).split(/\r?\n/);
        const items: string[] = [];
        for (const l of after) {
          if (/^\s+-\s*\S/.test(l)) items.push(l.replace(/^\s+-\s*/, '').trim());
          else if (l.trim() !== '') break;
        }
        tools = items.join(',');
      }
      if (tools.includes('*')) continue;
      const names = tools.replace(/[\[\]]/g, '').split(',').map((s) => s.trim());
      if (!names.includes('Write') && !names.includes('Edit')) want.push(f.replace(/\.md$/, ''));
    }
    expect([...READ_ONLY_AGENT_TYPES].sort()).toEqual(want.sort());
  });
});
