/**
 * pre-pr-gate: a body flag that is only quoted text of an earlier command must not deny a stamped --body-file create (RED step, lane g7-ppg-bodyflag).
 *
 * The flaw: `echo 'note --body here' ; gh pr create --draft --title t --body-file <stamped>` is denied "the PR body is not a file".
 * The words `--body` sit inside the quotes of the echo. They are text. The create itself has only a stamped --body-file.
 * Proof: scratchpad/proof7/ppg-body-flag-proof.mjs (the built hook, a temp repo with a fork remote and a valid stamp).
 *
 * Failure modes, one test group each:
 *   G1  text-only quoted flag words (--body, -b, --body-file) before the create are read as a real body flag (the gap, rows b to f)
 *   G2  the fix lets a REAL second body source through: an inline body, a second file, a different file (must stay denied)
 *   G3  the fix reads a text-only head that is not echo/commit as inert (python -c ...): kept denied, as today
 *   G4  the same text under PowerShell and under Desktop Commander (cmd.exe reads ' as a plain character: stricter only)
 *
 * Fakes, as pre-pr-gate.test.ts: no real git, no real files. deps() serves the stamp and the body files.
 */
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STAMP_REL, decide, type Deps } from '../pre-pr-gate.js';

const ROOT = '/work/ccv3';
const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-27T12:00:00Z');
const SESSION = '0b1f6c0e-5a4e-4c1e-9d5e-7b2a3c4d5e6f';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
const CCV3_REMOTES = 'fork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (fetch)\nfork\thttps://github.com/Rev4nchist/Continuous-Claude-v3.git (push)\n';
const WARN_CONFIG = { [join(ROOT, 'review-router.config.json')]: JSON.stringify({ checkpoint: { enforce: false } }) };

const BODY = resolve('/work/body.md');
const OTHER = resolve('/work/other.md');
const TEXT = 'the stamped body\n';
const B = BODY.replace(/\\/g, '/');
const O = OTHER.replace(/\\/g, '/');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** A CCv3 checkout at ROOT with a fresh stamp for HEAD whose body hash matches BODY. OTHER exists but is not the stamped body. */
function deps(): Deps {
  const stamp = JSON.stringify({ head: HEAD, branch: 'feat/x', at: new Date(NOW - 3_600_000).toISOString(), body_sha256: sha(TEXT), results: [] });
  const files: Record<string, string> = { ...WARN_CONFIG, [join(ROOT, STAMP_REL)]: stamp, [BODY]: TEXT, [OTHER]: 'some other body\n' };
  return {
    git: (cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n` };
      if (key === 'remote -v') return { status: 0, stdout: CCV3_REMOTES };
      if (key === 'worktree list --porcelain') return { status: 0, stdout: '' };
      if (key === 'rev-parse HEAD') return { status: 0, stdout: `${HEAD}\n` };
      if (key === 'branch --show-current') return { status: 0, stdout: 'feat/x\n' };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && String(args[3]).startsWith('refs/remotes/fork/')) return { status: 1, stdout: '' };
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{commit}')) return { status: 0, stdout: `${HEAD}\n` };
      return { status: 1, stdout: '' };
    },
    readFile: (p) => files[p] ?? null,
    now: () => NOW,
    env: {},
  };
}

const payload = (tool_name: string, tool_input: Record<string, unknown>) => ({ tool_name, tool_input, cwd: ROOT, session_id: SESSION });
const bash = (command: string) => payload('Bash', { command });
const pwsh = (command: string) => payload('PowerShell', { command });
const dc = (command: string) => payload(`${DC}start_process`, { command, shell: 'cmd', timeout_ms: 1000 });

/** The verdict with the reason, so a failed row names the reason text. */
const verdict = (input: object): string => {
  const r = decide(input, deps());
  return r.action === 'deny' ? `deny: ${r.reason.slice(0, 120)}` : r.action;
};
const allowed = (input: object, label: string): void => {
  expect(verdict(input), label).toBe('allow');
};
const denied = (input: object, label: string): void => {
  expect(verdict(input), label).toMatch(/^deny/);
};

const CREATE = `gh pr create --draft --title t --body-file ${B}`;

describe('G1 quoted flag words of an earlier command are text, not a body flag (the gap)', () => {
  it('a: the plain create with the stamped --body-file is allowed (control: passes today)', () => {
    allowed(bash(CREATE), 'plain create');
  });
  it("b: echo 'note --body here' ; create", () => {
    allowed(bash(`echo 'note --body here' ; ${CREATE}`), 'single-quoted --body');
  });
  it('c: echo "note --body here" ; create', () => {
    allowed(bash(`echo "note --body here" ; ${CREATE}`), 'double-quoted --body');
  });
  it('d: git commit -m "see --body here" ; create', () => {
    allowed(bash(`git commit -m "see --body here" ; ${CREATE}`), 'commit message with --body');
  });
  it("e: echo 'note -b here' ; create", () => {
    allowed(bash(`echo 'note -b here' ; ${CREATE}`), 'single-quoted -b');
  });
  it("f: echo 'note --body-file x' ; create", () => {
    allowed(bash(`echo 'note --body-file x' ; ${CREATE}`), 'single-quoted --body-file after a word');
  });
  it("b2: the same text joined with && (echo 'note --body here' && create)", () => {
    allowed(bash(`echo 'note --body here' && ${CREATE}`), 'joined with &&');
  });
});

describe('G2 a REAL second body source stays denied (must pass today and after the fix)', () => {
  it('g: create with a real inline --body "text" and no file', () => {
    denied(bash('gh pr create --draft --title t --body "text"'), 'inline body, no file');
  });
  it('h: stamped --body-file PLUS a real --body "text"', () => {
    denied(bash(`${CREATE} --body "text"`), 'file plus inline body');
  });
  it('h2: stamped --body-file PLUS a real -b text', () => {
    denied(bash(`${CREATE} -b text`), 'file plus -b');
  });
  it('i: --body-file pointing at a file that is not the stamped body', () => {
    denied(bash(`gh pr create --draft --title t --body-file ${O}`), 'other file');
  });
  it('j: a real inline body AFTER an echo with quoted text', () => {
    denied(bash(`echo 'x' ; gh pr create --draft --title t --body "real"`), 'echo then inline body');
  });
  it('j2: quoted --body text in an echo AND a real inline body in the create', () => {
    denied(bash(`echo 'note --body here' ; gh pr create --draft --title t --body "real"`), 'text --body then real --body');
  });
  it('j3: a stamped --body-file plus a second real --body-file for another file, after an echo', () => {
    denied(bash(`echo 'note --body here' ; ${CREATE} --body-file ${O}`), 'second real --body-file');
  });
  it('j4: a --title that quotes --body-file <stamped> hides a real inline body, after an echo', () => {
    denied(bash(`echo 'note --body here' ; gh pr create --draft --title "x --body-file ${B}" --body evil`), 'title mimics the file flag');
  });
});

describe('G2b the body file must belong to the create (review finding, a hole before this change)', () => {
  it('m: an UNQUOTED --body-file <stamped> in another command, the create fills its body itself (--fill)', () => {
    denied(bash(`echo --body-file ${B} ; gh pr create --draft --title t --fill`), 'stamped path named by echo, create uses --fill');
  });
  it('m2: the same with the file named after the create text, create has no body flag', () => {
    denied(bash(`echo --body-file ${B} ; gh pr create --draft --title t`), 'stamped path named by echo, create has no body flag');
  });
});

describe('G2c several opens: a second create can carry a body that is not the stamped file (CodeRabbit CLI finding)', () => {
  it("m3: echo 'note --body here' ; stamped create ; a second create with --fill", () => {
    denied(bash(`echo 'note --body here' ; ${CREATE} ; gh pr create --draft --title t --fill`), 'stamped create then a --fill create');
  });
  it('m4: the same without the echo', () => {
    denied(bash(`${CREATE} ; gh pr create --draft --title t --fill`), 'two creates, one stamped');
  });
});

describe('G3 a text-only head that is not echo or commit is not read as inert (kept: denied today)', () => {
  it('python -c with --body in a string, then the create', () => {
    denied(bash(`python -c 'print("x --body y")' ; ${CREATE}`), 'python -c text');
  });
});

describe('G4 PowerShell and Desktop Commander readings', () => {
  it("k: PowerShell, echo 'note --body here' ; create (the gap, as b)", () => {
    allowed(pwsh(`echo 'note --body here' ; ${CREATE}`), 'PowerShell single-quoted --body');
  });
  it('k2: PowerShell, a plain stamped create (control: passes today)', () => {
    allowed(pwsh(CREATE), 'PowerShell plain create');
  });
  it('k3: PowerShell, real inline --body "text" and no file (as g) stays denied', () => {
    denied(pwsh('gh pr create --draft --title t --body "text"'), 'PowerShell inline body');
  });
  it('k4: PowerShell, a real inline body after an echo (as j) stays denied', () => {
    denied(pwsh(`echo 'x' ; gh pr create --draft --title t --body "real"`), 'PowerShell echo then inline body');
  });
  it('l: Desktop Commander cmd, real inline --body "text" and no file (as g) stays denied', () => {
    denied(dc('gh pr create --draft --title t --body "text"'), 'DC inline body');
  });
  it("l2: Desktop Commander cmd, wrapped create with a real inline body (echo 'x & create --body & rem ') stays denied", () => {
    denied(dc(`echo 'x & gh pr create --draft --title t --body "text" & rem '`), 'DC wrapped inline body');
  });
  it("l3: Desktop Commander cmd, a real inline body after an echo (as j) stays denied", () => {
    denied(dc(`echo 'x' & gh pr create --draft --title t --body "real"`), 'DC echo then inline body');
  });
  // cmd.exe reads ' as a plain character, so `--body` in echo 'note --body here' is NOT inert text there. The third reading may deny it.
  // Pinned as an accepted over-deny: a fix for the Bash and PowerShell readings must not make the cmd reading weaker.
  it("l4: Desktop Commander cmd, echo 'note --body here' & create stays denied (accepted over-deny, cmd reads the quote as a character)", () => {
    denied(dc(`echo 'note --body here' & ${CREATE}`), 'DC single-quoted --body');
  });
  // The body view blanks the echo string for Bash and PowerShell. cmd.exe runs the quoted create inside it, with a body that is not the stamped file.
  // The decision must still add the cmd reading although the stamped create (a non-inert segment) stops blankInertQuotes from changing the text.
  it("l6: Desktop Commander cmd, echo 'a & create --body evil' ; stamped create stays denied (the body view must not hide the cmd.exe run)", () => {
    denied(dc(`echo 'a & gh pr create --draft --title t --body "evil"' ; ${CREATE}`), 'DC echo-wrapped create then a stamped create');
  });
  it('l5: Desktop Commander cmd, a plain stamped create is allowed (control: passes today)', () => {
    allowed(dc(CREATE), 'DC plain create');
  });
});
