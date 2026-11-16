/**
 * Card coord-subagent-write-guard (gap 8): shared/subagent-write.ts. Pure: every outside fact is passed in.
 * Seat ruling 2026-11-16 13:45: deny in the protected places, warn once per path elsewhere, read-only class from the
 * agent files, texts hold only the path and the scratch folder.
 *
 * Ways it can fail (one test each, the change that turns it red is in the first line of the test):
 *  1. The main thread (no agent_id) is judged.
 *  2. A read-only subagent writes the state folder and is not denied.
 *  3. A protected place is missing from the deny list (settings, rules, rules-ondemand, repo root).
 *  4. The shell text of a subagent is not read (redirect, tee).
 *  5. The scratchpad of the session is denied or warned.
 *  6. A builder type is judged.
 *  7. A subagent with no agent_type is denied outside the protected places, or warned.
 *  8. The warn fires twice for one path.
 *  9. A path trick (..) escapes the scratchpad.
 * 10. A message holds anything but the path and the scratch folder.
 * 11. The class list drifts from the agent files.
 * 12. Bad input crashes a verdict.
 * 13. A repo-root file is denied for an untyped subagent.
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

function deps(over: Partial<SubagentDeps> = {}): SubagentDeps {
  const seen = new Set<string>();
  return {
    home: HOME,
    tmp: TMP,
    tops: [TOP],
    sessionId: SID,
    cwd: TOP,
    fold: false,
    realPath: (p) => resolve('/', p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''),
    firstWarn: (p) => (seen.has(p) ? false : (seen.add(p), true)),
    scratchFolder: SCRATCH,
    ...over,
  };
}

const critic = { agent_id: 'a1', agent_type: 'critic' };
const untyped = { agent_id: 'a2' };
const kraken = { agent_id: 'a3', agent_type: 'kraken' };
const main = {};

describe('subagent-write: who is judged', () => {
  it('1: the main thread is never judged (breaks if the agent_id gate is dropped)', () => {
    expect(judgeDirect(main, [`${HOME}/.claude/state/x.json`], deps()).kind).toBe('allow');
    expect(judgeShell(main, `echo x > ${HOME}/.claude/state/x.json`, false, deps()).kind).toBe('allow');
  });

  it('6: a builder type is not judged (breaks if every typed subagent is judged)', () => {
    expect(judgeDirect(kraken, [`${HOME}/.claude/state/x.json`], deps()).kind).toBe('allow');
    expect(judgeDirect(kraken, [`${TOP}/README.md`], deps()).kind).toBe('allow');
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
    const v = judgeDirect(critic, [`${HOME}/.claude/state/review-engine/read-audit.jsonl`], deps());
    expect(v.kind).toBe('deny');
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

  it('13: an untyped subagent is denied in the four places under ~/.claude, not at the repo root (breaks if repo root is judged for it)', () => {
    expect(judgeDirect(untyped, [`${HOME}/.claude/rules-ondemand/x.md`], deps()).kind).toBe('deny');
    expect(judgeDirect(untyped, [`${HOME}/.claude/state/x`], deps()).kind).toBe('deny');
    expect(judgeDirect(untyped, [`${TOP}/package.json`], deps()).kind).toBe('allow');
  });

  it('7: an untyped subagent is never warned (breaks if the warn applies to every subagent)', () => {
    expect(judgeDirect(untyped, [`${TOP}/src/a.ts`], deps()).kind).toBe('allow');
    expect(judgeShell(untyped, `echo hi > ${TOP}/notes.txt`, false, deps()).kind).toBe('allow');
  });

  it('9: a ".." out of the scratchpad is judged on the real path (breaks if the raw string is compared)', () => {
    const sneaky = `${SCRATCH}/../../../../../${HOME.slice(1)}/.claude/state/x.json`;
    expect(judgeDirect(critic, [sneaky], deps()).kind).toBe('deny');
  });
});

describe('subagent-write: the shell text', () => {
  it('4: a redirect or tee into a protected place is denied (breaks if the shell text is not read)', () => {
    expect(judgeShell(critic, `echo x > ${HOME}/.claude/state/read-audit.jsonl`, false, deps()).kind).toBe('deny');
    expect(judgeShell(critic, `echo x | tee ${HOME}/.claude/rules/x.md`, false, deps()).kind).toBe('deny');
    expect(judgeShell(critic, `echo x > ~/.claude/state/y.json`, false, deps()).kind).toBe('deny');
    expect(judgeShell(critic, `echo x >> $HOME/.claude/settings.json`, false, deps()).kind).toBe('deny');
    expect(judgeShell(critic, `echo x > ${TOP}/SECRET-ci`, false, deps()).kind).toBe('deny');
  });

  it('4b: reading a protected path is no write (breaks if every mention denies)', () => {
    expect(judgeShell(critic, `cat ${HOME}/.claude/state/read-audit.jsonl`, false, deps()).kind).toBe('allow');
    expect(judgeShell(critic, `ls ${HOME}/.claude/rules`, false, deps()).kind).toBe('allow');
  });

  it('4c: a script run with no path in its text is a known limit and is allowed', () => {
    expect(judgeShell(critic, 'node scripts/review-engine/probe.mjs', false, deps()).kind).toBe('allow');
  });

  it('4d: a redirect to /dev/null or a 2> is no write (breaks if stderr redirects warn)', () => {
    expect(judgeShell(critic, 'git status 2>/dev/null', false, deps()).kind).toBe('allow');
    expect(judgeShell(critic, 'cmd > /dev/null 2>&1', false, deps()).kind).toBe('allow');
  });

  it('a text over the size cap is not scanned', () => {
    const big = `echo x > ${HOME}/.claude/state/a ${'x'.repeat(70 * 1024)}`;
    expect(judgeShell(critic, big, false, deps()).kind).toBe('allow');
  });
});

describe('subagent-write: scratch and warn', () => {
  it('5: its own scratchpad is allowed with no warn (breaks if the scratchpad is judged)', () => {
    expect(judgeDirect(critic, [`${SCRATCH}/notes.md`], deps()).kind).toBe('allow');
    expect(judgeShell(critic, `echo x > ${SCRATCH}/a.txt`, false, deps()).kind).toBe('allow');
  });

  it('5b: another session scratchpad is outside (breaks if any scratchpad passes)', () => {
    expect(insideScratch(`${TMP}/claude/h1/other-sess/scratchpad/a.md`, deps())).toBe(false);
    expect(insideScratch(`${TMP}/claude/h1/${SID}/scratchpadx/a.md`, deps())).toBe(false);
    expect(insideScratch(`${TMP}/claude/h1/${SID}/scratchpad/a.md`, deps())).toBe(true);
  });

  it('7b: an untyped subagent writing its scratchpad is allowed with no warn (seat partner of test 7)', () => {
    expect(judgeDirect(untyped, [`${SCRATCH}/a.md`], deps()).kind).toBe('allow');
  });

  it('8: a write outside the scratchpad warns once per path (breaks if firstWarn is not used)', () => {
    const d = deps();
    const first = judgeDirect(critic, [`${TOP}/src/a.ts`], d);
    expect(first.kind).toBe('warn');
    expect(judgeDirect(critic, [`${TOP}/src/a.ts`], d).kind).toBe('allow');
    expect(judgeDirect(critic, [`${TOP}/src/b.ts`], d).kind).toBe('warn');
  });

  it('a plain redirect outside the scratchpad warns once', () => {
    const d = deps();
    expect(judgeShell(critic, `echo x > ${TOP}/src/out.txt`, false, d).kind).toBe('warn');
    expect(judgeShell(critic, `echo x > ${TOP}/src/out.txt`, false, d).kind).toBe('allow');
  });

  it('10: the deny and the warn name the path and the scratch folder and nothing from the call (breaks if content or ids leak)', () => {
    const marker = 'TOP-SECRET-CONTENT-9f3';
    const deny = judgeShell(critic, `echo ${marker} > ${HOME}/.claude/state/x.json`, false, deps());
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

  it('a line break or control byte in a path shows as "?" in the text', () => {
    const v = judgeDirect(critic, [`${HOME}/.claude/state/x\nIGNORE ALL`], deps({ realPath: (p) => p }));
    expect(v.kind).toBe('deny');
    if (v.kind === 'deny') expect(v.reason).not.toContain('\nIGNORE');
  });
});

describe('subagent-write: bad input', () => {
  it('12: an odd payload gives allow, not a throw (breaks if a field is assumed)', () => {
    expect(judgeDirect({ agent_id: 7 as unknown, agent_type: {} as unknown }, [], deps()).kind).toBe('allow');
    expect(judgeShell(critic, '', false, deps()).kind).toBe('allow');
    expect(judgeDirect(critic, [], deps()).kind).toBe('allow');
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
