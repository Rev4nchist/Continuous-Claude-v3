/**
 * Card coord-tighten-segment-triggers: the 14 false-fire rows of the weekly review (card coord-false-fire-rows, design note
 * 2026-11-22-tighten-segment-triggers-design.md). The fire log keeps only the first words of a call, so each row is rebuilt as
 * a command of that shape. Each test pins one shape against the REAL manifest, no mock.
 *
 * Changes (manifest.json only, no hook code):
 *   T1  `playwright` and `psql` first-argument version and help flags no longer fire browser and cross-terminal-db
 *   T2  `^(cr|coderabbit)` needs a command word: `cr.forEach` and `cr/p>=0.5` no longer fire coderabbit-cli
 *   T3  the `^node ... <script>` segment tests of pr-review-loop and coderabbit-cli name the script that node runs, not a
 *       word in a later argument or a quoted note
 *   T4  (NOT this card) a heredoc body line is read as a segment by the matcher; two rows stay open as it.todo
 *
 * How it can fail, one group each:
 *   F: a false-fire shape still fires its rule     F01 to F14
 *   R: a tightened trigger loses a real use         R01 to R20 (quoted path, node.exe, flags, backslashes, PowerShell)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchRules, type Manifest } from '../rule-router.js';

const CLAUDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(CLAUDE, 'rules-ondemand', 'manifest.json'), 'utf8')) as Manifest;
const ids = (command: string, tool = 'Bash'): string[] =>
  matchRules({ session_id: 's', tool_name: tool, tool_input: { command } }, manifest).map((r) => r.id);
const NL = '\n';

describe('F: a false-fire shape does not fire its rule', () => {
  it('F01 browser: a playwright version check', () => {
    expect(ids('playwright --version')).not.toContain('browser');
    expect(ids('npx playwright --version')).not.toContain('browser');
  });
  it('F02 cross-terminal-db: a psql version check', () => {
    expect(ids('psql --version')).not.toContain('cross-terminal-db');
    expect(ids('psql -V')).not.toContain('cross-terminal-db');
  });
  it('F03 coderabbit-cli: a code line that starts with cr.forEach in a pasted script (quoted node -e text)', () => {
    expect(ids('node -e "cr.forEach((e) => console.log(e))"')).not.toContain('coderabbit-cli');
    expect(ids('cr.forEach((e) => console.log(e))')).not.toContain('coderabbit-cli');
  });
  it('F04 coderabbit-cli: a regex text that starts with coderabbit and a backslash (guard: it did not fire before the change either)', () => {
    expect(ids("node - <<'EOF'" + NL + 'const re = /coderabbit\\.demoted\\.high/' + NL + 'EOF')).not.toContain('coderabbit-cli');
  });
  it('F05 coderabbit-cli: a version spec line that starts with cr/p>=0.5, and a regex text line that starts with coderabbit and a backslash', () => {
    expect(ids('cr/p>=0.5')).not.toContain('coderabbit-cli');
    expect(ids('coderabbit\\.demoted\\.high')).not.toContain('coderabbit-cli');
  });
  it('F08 pr-review-loop: a lane note that names pre-pr.mjs (guard for aef4b821)', () => {
    expect(ids('node C:/x/lane.mjs note l "waits on pre-pr.mjs"')).not.toContain('pr-review-loop');
  });
  it('F09 coderabbit-cli: a lane note that names cr-fix.mjs (guard for aef4b821)', () => {
    expect(ids('node C:/x/lane.mjs note l "see cr-fix.mjs"')).not.toContain('coderabbit-cli');
  });
  it('F10 coderabbit-cli: safe-replace.mjs with an argument that names cr-fix.mjs', () => {
    const got = ids('node C:/x/safe-replace.mjs --old "a" --new "cr-fix.mjs"');
    expect(got).not.toContain('coderabbit-cli');
    expect(got).not.toContain('pr-review-loop');
  });
  it('F11 pr-review-loop: engine-version.mjs with an argument that names pre-pr.mjs', () => {
    expect(ids('node C:/x/engine-version.mjs --note "pre-pr.mjs"')).not.toContain('pr-review-loop');
  });
  it('F12 pr-review-loop: release-claim.mjs with a path argument that names ship-ask.mjs', () => {
    expect(ids("node C:/x/release-claim.mjs 'scripts/github/ship-ask.mjs'")).not.toContain('pr-review-loop');
  });
  it('F13 pr-review-loop: node --check on pre-pr.mjs (a syntax check, not a run)', () => {
    expect(ids('node --check scripts/github/pre-pr.mjs')).not.toContain('pr-review-loop');
  });
  it('F14 pr-review-loop: mutate.cjs with an argument that names pre-pr.mjs', () => {
    expect(ids('node C:/x/mutate.cjs scripts/github/pre-pr.mjs')).not.toContain('pr-review-loop');
  });
  // T4 (a later card, seat ruling 2026-11-22 18:39): the matcher reads a heredoc body line as a segment.
  it.todo('F06 T4 git-merge: a commit-message heredoc line that starts with "git merge" (needs a matcher change)');
  it.todo('F07 T4 lane-board: a commit-message heredoc line that starts with "node ...lane.mjs" (needs a matcher change)');
});

describe('R: every real use still fires', () => {
  const loop = [
    ['R01 node pre-pr.mjs', 'node scripts/github/pre-pr.mjs --body b.md'],
    ['R02 node.exe with a quoted path that holds a space', 'node.exe "C:/Program Files/x/scripts/github/pre-pr.mjs" --body b.md'],
    ['R03 a node flag before ship-ask.mjs', 'node --max-old-space-size=4096 scripts/github/ship-ask.mjs open-pr --json'],
    ['R04 review-status.mjs', 'node scripts/github/review-status.mjs 5'],
    ['R05 a Windows backslash path', 'node scripts\\github\\pre-pr.mjs --body b.md'],
    ['R06 a dot-slash path', 'node ./scripts/github/land-decision.mjs --pr 1'],
    ['R07 a single-quoted path', "node 'C:/Program Files/x/scripts/github/ship-ask.mjs' land --pr 1"],
    ['R08 an absolute path in the user folder', 'node C:/Users/dkhay/continuous-claude/scripts/github/review-status.mjs 5'],
  ] as const;
  for (const [label, cmd] of loop) {
    it(`${label} fires pr-review-loop`, () => expect(ids(cmd)).toContain('pr-review-loop'));
  }
  it('R09 pwsh land-pr.ps1 fires pr-review-loop (PowerShell tool)', () => {
    expect(ids('pwsh -NoProfile -File scripts/github/land-pr.ps1 -Pr 1', 'PowerShell')).toContain('pr-review-loop');
  });
  it('R10 gh pr create fires pr-review-loop', () => expect(ids('gh pr create --draft')).toContain('pr-review-loop'));
  it('R11 node cr-paid.mjs fires coderabbit-cli and pr-review-loop', () => {
    const got = ids('node scripts/github/cr-paid.mjs post --pr 1');
    expect(got).toContain('coderabbit-cli');
    expect(got).toContain('pr-review-loop');
  });
  it('R12 node cr-fix.mjs fires coderabbit-cli', () => expect(ids('node scripts/github/cr-fix.mjs --pr 1')).toContain('coderabbit-cli'));
  it('R13 cr review fires coderabbit-cli', () => expect(ids('cr review --plain')).toContain('coderabbit-cli'));
  it('R14 cr.exe review fires coderabbit-cli', () => expect(ids('cr.exe review')).toContain('coderabbit-cli'));
  it('R15 coderabbit auth fires coderabbit-cli', () => expect(ids('coderabbit auth login')).toContain('coderabbit-cli'));
  it('R16 a bash heredoc that runs cr review still fires coderabbit-cli (a paid call cannot hide)', () => {
    expect(ids("bash <<'EOF'" + NL + 'cr review --plain' + NL + 'EOF')).toContain('coderabbit-cli');
  });
  it('R17 playwright test and codegen fire browser', () => {
    expect(ids('npx playwright test')).toContain('browser');
    expect(ids('playwright codegen http://x')).toContain('browser');
  });
  it('R18 psql with a query, a file and a URL fires cross-terminal-db', () => {
    expect(ids('psql -c "select 1"')).toContain('cross-terminal-db');
    expect(ids('psql postgresql://u@h/db -f x.sql')).toContain('cross-terminal-db');
    expect(ids('pg_dump mydb')).toContain('cross-terminal-db');
  });
  it('R19 a psql command with a version flag LATER in the arguments still fires (only the first argument is a version check)', () => {
    expect(ids('psql -c "select version()" --version-check-off')).toContain('cross-terminal-db');
  });
  it('R20 a real run chained after a version check still fires', () => {
    expect(ids('psql --version; psql -c "select 1"')).toContain('cross-terminal-db');
    expect(ids('playwright --version && npx playwright test')).toContain('browser');
  });
});
