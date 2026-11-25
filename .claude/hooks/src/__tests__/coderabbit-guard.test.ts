import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  classifyShellSegment,
  decide,
  readState,
  recordRun,
  statePath,
  writeState,
  checkRunCap,
  repoBranchKey,
  joinContinuations,
} from '../coderabbit-guard.js';

const HOOK = resolve(__dirname, '../../dist/coderabbit-guard.mjs');

// A folder outside any git repo. The guard checks a review run against the git repo it runs in (answer-key check), and these tests are
// about parsing and counting: they run in a folder where that check has nothing to read, so it never depends on this checkout.
const OTHER_REMOTE = 'https://github.com/someone/other-repo.git';
const NEUTRAL_CWD = mkdtempSync(join(tmpdir(), 'cr-guard-neutral-'));
afterAll(() => rmSync(NEUTRAL_CWD, { recursive: true, force: true }));

function runHook(
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env,
    cwd: NEUTRAL_CWD,
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

function deny(stdout: string): boolean {
  const o = JSON.parse(stdout);
  return o.hookSpecificOutput?.permissionDecision === 'deny';
}

const bash = (command: string) => ({ tool_name: 'Bash', cwd: NEUTRAL_CWD, tool_input: { command } });
const pwsh = (command: string) => ({ tool_name: 'PowerShell', cwd: NEUTRAL_CWD, tool_input: { command } });

// Built at runtime so no source line holds the billing flag followed by a value (secret scanners flag that).
const KEY_FLAG = ['--api', 'key'].join('-');
const KEY_VALUE = 'PLACEHOLDER';
const FAKE_PASS = ['sec', 'ret'].join('');
const FAKE_PROMPT = ['secret', 'value'].join('-');

describe('coderabbit-guard classifyShellSegment: blocks', () => {
  it('blocks --use-credits on cr review --agent', async () => {
    expect((await classifyShellSegment('cr review --agent --use-credits')).verdict).toBe('block');
  });

  it('blocks --api-key', async () => {
    expect((await classifyShellSegment(`coderabbit review --agent ${KEY_FLAG}=${KEY_VALUE}`)).verdict).toBe('block');
  });

  it('blocks forbidden flags even on a read-only subcommand', async () => {
    expect((await classifyShellSegment(`cr auth login ${KEY_FLAG} ${KEY_VALUE}`)).verdict).toBe('block');
    expect((await classifyShellSegment('cr doctor --use-credits')).verdict).toBe('block');
  });

  it('blocks code new and code push', async () => {
    expect((await classifyShellSegment('cr code new')).verdict).toBe('block');
    expect((await classifyShellSegment('cr code push')).verdict).toBe('block');
    expect((await classifyShellSegment('coderabbit code push')).verdict).toBe('block');
  });

  it('blocks skill installs, bare and wrapped', async () => {
    expect((await classifyShellSegment('npx skills add coderabbitai/skills -g -y')).verdict).toBe('block');
    expect((await classifyShellSegment('npx -y skills@latest add coderabbitai/skills')).verdict).toBe('block');
    expect((await classifyShellSegment('coderabbit skills install')).verdict).toBe('block');
  });

  it('blocks cr subcommands outside the allow list', async () => {
    expect((await classifyShellSegment('cr')).verdict).toBe('block');
    expect((await classifyShellSegment('cr auth logout')).verdict).toBe('block');
    expect((await classifyShellSegment('cr review')).verdict).toBe('block');
    expect((await classifyShellSegment('cr billing upgrade')).verdict).toBe('block');
  });

  it('blocks a forbidden segment hidden in a chain', async () => {
    const env = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') };
    expect((await decide(bash('git status && cr review --agent --use-credits'), env)).allow).toBe(false);
    expect((await decide(bash('cr doctor; cr code push'), env)).allow).toBe(false);
    expect((await decide(pwsh('git status; coderabbit skills install'), env)).allow).toBe(false);
  });
});

describe('coderabbit-guard classifyShellSegment: leading executable', () => {
  it.each([
    'cr review --agent',
    'cr.exe review --agent',
    'coderabbit review --agent',
    'coderabbit.exe review --agent',
    './cr review --agent',
    '"C:\\Program Files\\CodeRabbit\\cr.exe" review --agent',
    'FOO=bar BAZ="a b" cr review --agent',
    'npx cr review --agent',
    'npx -y coderabbit review --agent',
    'cmd /c cr review --agent',
    'pwsh -NoProfile -c "cr review --agent"',
    'bash -c "cr review --agent"',
  ])('counts as one run: %s', async (seg) => {
    const c = (await classifyShellSegment(seg));
    expect(c.verdict).toBe('allow');
    expect(c.countsRun).toBe(true);
  });

  // Seat ruling 17:10 (G1b verdict change 1): a Windows path with backslashes is a PowerShell path. Bash reads \T and \c as escapes, so the
  // program word is unreadable there (the Bash form is a named U1 deny row in the reader tests, added with rule U1 in G7).
  it('counts as one run in PowerShell: C:\\Tools\\cr.exe review --agent', async () => {
    const c = await classifyShellSegment('C:\\Tools\\cr.exe review --agent', true);
    expect(c.verdict).toBe('allow');
    expect(c.countsRun).toBe(true);
  });

  it.each([
    'git push fork feat/ccv3-cr-install',
    'git checkout feat/ccv3-cr-install',
    'git add .claude/rules-ondemand/coderabbit-cli.md',
    `git commit -m "feat(review): CodeRabbit gate ${KEY_FLAG} docs"`,
    'cat .coderabbit.yaml',
    'gh api repos/x/y/pulls/155',
    'echo cr',
    'grep -n coderabbit file',
    'git status',
    'echo "npx skills add coderabbitai/skills"',
  ])('ignores a segment that only mentions the word: %s', async (seg) => {
    expect((await classifyShellSegment(seg)).verdict).toBe('ignore');
  });
});

describe('coderabbit-guard classifyShellSegment: read-only allow list', () => {
  it.each([
    'cr doctor',
    'cr usage',
    'cr usage --agent',
    'cr auth login',
    'cr auth status',
    'cr --help',
    'cr -h',
    'cr review --help',
    'cr review --agent --help',
    'cr --version',
    'coderabbit.exe doctor',
    'coderabbit usage --agent',
    'coderabbit auth status',
    'coderabbit --version',
  ])('allows without counting a run: %s', async (seg) => {
    const c = (await classifyShellSegment(seg));
    expect(c.verdict).toBe('allow');
    expect(c.countsRun).toBeFalsy();
  });

  it('still blocks code new even when --help is present', async () => {
    expect((await classifyShellSegment('cr code new --help')).verdict).toBe('block');
  });
});

describe('coderabbit-guard run cap', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'repo#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the env override for the state path', () => {
    expect(statePath(env)).toBe(stateFile);
  });

  it('allows runs 1-2 and blocks run 3 for the same repo+branch key', async () => {
    const cmd = bash('cr review --agent');
    expect((await decide(cmd, env)).allow).toBe(true);
    expect((await decide(cmd, env)).allow).toBe(true);
    expect((await decide(cmd, env)).allow).toBe(false);
  });

  it.each(['&&', '||', ';', '|', '\n'])('counts both cr review segments joined by %j as 2 runs', async (sep) => {
    const chained = `cr review --agent ${sep} cr review --agent`;
    expect((await decide(bash(chained), env)).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(false);
  });

  it('counts PowerShell ; chains and a pwsh -c wrapper with two runs inside', async () => {
    expect((await decide(pwsh('cr review --agent; cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
    rmSync(stateFile);
    expect((await decide(bash('pwsh -c "cr review --agent && cr review --agent"'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(2);
  });

  it('blocks a chain with 3 runs and records nothing', async () => {
    const three = 'cr review --agent && cr review --agent && cr review --agent';
    expect((await decide(bash(three), env)).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('blocks a chain that would cross the cap and keeps the old count', async () => {
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    expect((await decide(bash('cr review --agent && cr review --agent'), env)).allow).toBe(false);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('blocked run 3 does not raise the stored count', async () => {
    for (let i = 0; i < 4; i++) (await decide(bash('cr review --agent'), env));
    expect(readState(stateFile).counts['repo#main']).toBe(2);
  });

  it('counts a run at PreToolUse time, before any result exists, so failed or rate-limited runs consume a slot', async () => {
    // The guard never sees the exit code or output of the run. Allowing the call is the count.
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('read-only commands never count and never write state', async () => {
    for (const c of ['cr doctor', 'cr usage --agent', 'cr auth status', 'cr --help', 'cr --version']) {
      expect((await decide(bash(c), env)).allow).toBe(true);
    }
    expect(existsSync(stateFile)).toBe(false);
    expect((await decide(bash('cr doctor && cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['repo#main']).toBe(1);
  });

  it('keeps separate counts per repo+branch key', async () => {
    const other = { ...env, CCV3_CODERABBIT_GUARD_KEY: 'repo#other' };
    (await decide(bash('cr review --agent'), env));
    (await decide(bash('cr review --agent'), env));
    expect((await decide(bash('cr review --agent'), other)).allow).toBe(true);
  });

  it('state holds only a counts map of numbers, no args or tokens', async () => {
    (await decide(bash(`cr review --agent --prompt ${FAKE_PROMPT}`), env));
    const raw = readFileSync(stateFile, 'utf8');
    expect(raw).not.toContain(FAKE_PROMPT);
    expect(raw).not.toMatch(/prompt|agent|review/);
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(['counts']);
    expect(parsed.counts).toEqual({ 'repo#main': 1 });
  });

  it('writes state atomically: no temp file is left behind and the file stays valid JSON', async () => {
    for (let i = 0; i < 2; i++) (await decide(bash('cr review --agent'), env));
    expect(readdirSync(dirname(stateFile))).toEqual(['state.json']);
    expect(() => JSON.parse(readFileSync(stateFile, 'utf8'))).not.toThrow();
  });

  it('writeState replaces an existing file in place', () => {
    writeState(stateFile, { counts: { a: 1 } });
    writeState(stateFile, { counts: { a: 2 } });
    expect(readState(stateFile).counts.a).toBe(2);
    expect(readdirSync(dirname(stateFile))).toEqual(['state.json']);
  });

  it('recordRun increments', () => {
    const s = recordRun({ counts: {} }, 'a#b');
    expect(s.counts['a#b']).toBe(1);
    expect(checkRunCap(s, 'a#b').ok).toBe(true);
    const s2 = recordRun(s, 'a#b');
    expect(checkRunCap(s2, 'a#b').ok).toBe(false);
  });
});

describe('coderabbit-guard decide: no over-block', () => {
  it.each([
    'git push fork feat/ccv3-cr-install',
    'git checkout feat/ccv3-cr-install',
    'git add .claude/rules-ondemand/coderabbit-cli.md',
    `git commit -m "feat(review): CodeRabbit gate ${KEY_FLAG} docs"`,
    'cat .coderabbit.yaml',
    'gh api repos/x/y/pulls/155',
    'echo cr',
    'grep -n coderabbit file',
  ])('allows %s on Bash and PowerShell', async (command) => {
    expect((await decide(bash(command), { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') })).allow).toBe(true);
    expect((await decide(pwsh(command), { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') })).allow).toBe(true);
    expect(existsSync(join(tmpdir(), 'cr-guard-never.json'))).toBe(false);
  });
});

describe('coderabbit-guard PowerShell tool follows the Bash rules', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-ps-'));
    env = { CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'), CCV3_CODERABBIT_GUARD_KEY: 'ps#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows runs 1-2 of a call-operator path and blocks run 3', async () => {
    const cmd = pwsh('& "C:\\Tools\\CodeRabbit\\cr.exe" review --agent');
    expect((await decide(cmd, env)).allow).toBe(true);
    expect((await decide(cmd, env)).allow).toBe(true);
    expect((await decide(cmd, env)).allow).toBe(false);
  });

  it('blocks forbidden flags, code push and read-only passes', async () => {
    expect((await decide(pwsh('cr review --agent --use-credits'), env)).allow).toBe(false);
    expect((await decide(pwsh('coderabbit.exe code push'), env)).allow).toBe(false);
    expect((await decide(pwsh('cr doctor'), env)).allow).toBe(true);
  });
});

describe('coderabbit-guard Skill and delegate', () => {
  it('blocks coderabbit:autofix skill', async () => {
    expect((await decide({ tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } })).allow).toBe(false);
  });

  it('allows other skills', async () => {
    expect((await decide({ tool_name: 'Skill', tool_input: { skill: 'commit' } })).allow).toBe(true);
  });

  it.each(['Task', 'Agent'])('allows a read-only autofix %s delegate', async (tool_name) => {
    expect(
      (await decide({
        tool_name,
        tool_input: { prompt: 'Run a read-only autofix review of the diff', subagent_type: 'critic' },
      })).allow,
    ).toBe(true);
  });

  it('blocks a delegate that carries the autofix skill', async () => {
    expect(
      (await decide({
        tool_name: 'Agent',
        tool_input: { skill: 'coderabbit:autofix', prompt: 'read-only autofix' },
      })).allow,
    ).toBe(false);
  });
});

describe('coderabbit-guard dist e2e', () => {
  let dir: string;
  let childEnv: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-dist-'));
    childEnv = {
      CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'),
      CCV3_CODERABBIT_GUARD_KEY: 'e2e#main',
      // The built hook runs without VITEST. Without this it appends to the real ~/.claude log.
      CCV3_GUARD_DECISIONS_LOG: join(dir, 'guard-decisions.jsonl'),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks use-credits via dist', () => {
    const r = runHook({ session_id: 'g1', ...bash('cr review --agent --use-credits') }, childEnv);
    expect(deny(r.stdout)).toBe(true);
  });

  it('allows review --agent twice then blocks third via dist', () => {
    const base = { session_id: 'g1', ...bash('cr review --agent') };
    expect(deny(runHook(base, childEnv).stdout)).toBe(false);
    expect(deny(runHook(base, childEnv).stdout)).toBe(false);
    expect(deny(runHook(base, childEnv).stdout)).toBe(true);
  });

  it('counts a chained pair as two runs via dist', () => {
    const chain = { session_id: 'g1', ...bash('cr review --agent && cr review --agent') };
    expect(deny(runHook(chain, childEnv).stdout)).toBe(false);
    expect(deny(runHook({ session_id: 'g1', ...bash('cr review --agent') }, childEnv).stdout)).toBe(true);
  });

  it('allows cr doctor and a git push of a cr branch via dist', () => {
    expect(deny(runHook({ session_id: 'g1', ...bash('cr doctor') }, childEnv).stdout)).toBe(false);
    expect(
      deny(runHook({ session_id: 'g1', ...pwsh('git push fork feat/ccv3-cr-install') }, childEnv).stdout),
    ).toBe(false);
  });

  it('allows a commit message and a PR body that talk about CodeRabbit, and uses no slot, via dist', () => {
    const commit = bash('git commit -m "feat: add guard (CodeRabbit CLI) for runs"');
    const body = pwsh("gh pr create --body @'\nCodeRabbit gate\ncr review --agent runs are capped at 2.\n'@");
    expect(deny(runHook({ session_id: 'g1', ...commit }, childEnv).stdout)).toBe(false);
    expect(deny(runHook({ session_id: 'g1', ...body }, childEnv).stdout)).toBe(false);
    expect(existsSync(childEnv.CCV3_CODERABBIT_GUARD_STATE)).toBe(false);
  });

  it('blocks billing flags behind sudo and Start-Process via dist', () => {
    expect(deny(runHook({ session_id: 'g1', ...bash('sudo cr review --agent --use-credits') }, childEnv).stdout)).toBe(true);
    expect(deny(runHook({ session_id: 'g1', ...pwsh('Start-Process cr -ArgumentList "review --agent --use-credits"') }, childEnv).stdout)).toBe(true);
  });

  it('writes an override line to the decision log, and only for a leading assignment, via dist', () => {
    const log = childEnv.CCV3_GUARD_DECISIONS_LOG;
    const echoed = runHook({ session_id: 'g1', ...bash('echo SKIP_CODERABBIT_GUARD=1 && cr review --use-credits') }, childEnv);
    expect(deny(echoed.stdout)).toBe(true);
    const led = runHook({ session_id: 'g2', ...bash('SKIP_CODERABBIT_GUARD=1 cr review --use-credits') }, childEnv);
    expect(deny(led.stdout)).toBe(false);
    const kinds = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).decision);
    expect(kinds).toEqual(['deny', 'override']);
  });

  it('blocks autofix skill via dist', () => {
    const r = runHook({ session_id: 'g1', tool_name: 'Skill', tool_input: { skill: 'coderabbit:autofix' } }, childEnv);
    expect(deny(r.stdout)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Review round. Failure modes:
//  1. Quoted text and heredoc bodies are split like shell code, so ordinary git and gh commands
//     that talk about CodeRabbit are denied, or burn a run slot.
//  2. Shell constructs and wrappers that run a command are not unwrapped, so billing flags pass.
//  3. The run counter key ignores the payload cwd and shares one key across repos and detached HEADs.
//  4. The override matches anywhere in the command and leaves no audit line.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: prose about CodeRabbit inside quotes and heredocs is not a CodeRabbit call', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-prose-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'prose#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, string]> = [
    ['parenthesis inside a double-quoted commit message', 'git commit -m "feat: add guard (CodeRabbit CLI) for runs"'],
    [
      'unquoted-delimiter heredoc body line starting with the tool name',
      'git commit -F - <<EOF\nfeat: gate\n\nCodeRabbit reviews are advisory.\ncr review --agent runs are capped at 2.\nEOF',
    ],
    [
      'quoted-delimiter heredoc body',
      "git commit -F - <<'EOF'\nfeat: gate\n\nCodeRabbit reviews are advisory.\ncr review --agent runs are capped at 2.\ncr review --use-credits is blocked.\nEOF",
    ],
    ['markdown table row in a gh body', 'gh pr create --title "t" --body "| CodeRabbit | label gated |"'],
    ['semicolon and ampersand inside single quotes', "git commit -m 'a; cr review --use-credits && b'"],
    ['newline inside a double-quoted message', 'git commit -m "line one\ncr review --agent runs are capped\nline three"'],
  ];

  it.each(cases)('allows and uses no slot on Bash: %s', async (_name, cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  // FLIPPED in round 9: these two were allowed. A cat heredoc is not a leading git or gh, so a cr word
  // with a billing flag in its body is denied by the raw check.
  it.each([
    ['dash heredoc with tab-indented delimiter (flipped r9)', 'cat <<-EOF\n\tcr review --agent --use-credits\n\tEOF'],
    ['two heredocs on one line (flipped r9)', `cat <<'A' <<'B'\ncr review --use-credits\nA\ncr review ${KEY_FLAG} ${KEY_VALUE}\nB`],
  ])('denies a cat heredoc that names cr and a billing flag: %s', async (_name, cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('allows a PowerShell here-string body that names the tool and a forbidden flag', async () => {
    const cmd = "gh pr create --title 't' --body @'\nCodeRabbit gate: it's advisory\ncr review --agent --use-credits is forbidden\n'@";
    expect((await decide(pwsh(cmd), env)).allow).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('does not treat a backtick in a PowerShell double-quoted string as command substitution', async () => {
    expect((await decide(pwsh('gh pr comment 1 --body "Run `cr review --use-credits` never"'), env)).allow).toBe(true);
    expect((await decide(bash('gh pr comment 1 --body "Run `cr review --use-credits` never"'), env)).allow).toBe(false);
  });

  it('still scans real commands next to quoted text', async () => {
    expect((await decide(bash('git commit -m "a; b" && cr review --use-credits'), env)).allow).toBe(false);
    expect((await decide(bash("cat <<'EOF'\nprose\nEOF\ncr review --use-credits"), env)).allow).toBe(false);
    expect((await decide(bash('echo "$(cr review --use-credits)"'), env)).allow).toBe(false);
    expect((await decide(bash('echo "a `cr review --use-credits` b"'), env)).allow).toBe(false);
    expect((await decide(bash("echo 'x' ; cr review --use-credits"), env)).allow).toBe(false);
  });

  it('reads a heredoc or here-string that feeds a shell as a script', async () => {
    expect((await decide(bash("bash <<'EOF'\ncr review --use-credits\nEOF"), env)).allow).toBe(false);
    expect((await decide(bash('sh <<-EOF\n\tcr code push\n\tEOF'), env)).allow).toBe(false);
    expect((await decide(bash('bash <<< "cr review --use-credits"'), env)).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect((await decide(bash('sh <<EOF\ncr review --agent\nEOF'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['prose#main']).toBe(1);
  });

  it('keeps a command after a heredoc separate, and lets two heredocs share one command', async () => {
    expect((await decide(bash("cat <<'A' <<'B'\nprose\nA\nprose\nB\ncr review --use-credits"), env)).allow).toBe(false);
    // Flipped in round 9: was allowed. Two cat heredocs with cr and a billing flag are now denied.
    expect((await decide(bash(`cat <<'A' <<'B'\ncr review --use-credits\nA\ncr review ${KEY_FLAG} ${KEY_VALUE}\nB`), env)).allow).toBe(false);
    // Two git heredoc messages stay allowed.
    expect((await decide(bash("git commit -F - <<'A' <<'B'\ncr review --use-credits\nA\nprose\nB"), env)).allow).toBe(true);
  });

  it('treats an unclosed quote as a literal, so a command after it is still scanned', async () => {
    expect((await decide(bash('echo "oops; cr review --use-credits'), env)).allow).toBe(false);
    expect((await decide(bash("echo it's; cr review --use-credits"), env)).allow).toBe(false);
  });

  it('counts two runs inside one quoted wrapper string', async () => {
    expect((await decide(bash("bash -c 'cr review --agent; cr review --agent'"), env)).allow).toBe(true);
    expect(readState(stateFile).counts['prose#main']).toBe(2);
  });
});

describe('coderabbit-guard: wrappers and shell constructs that run a command', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-wrap-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'wrap#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A third field names the shell that really runs the text. The braces of a script block are PowerShell syntax: in bash they are plain arguments.
  const wrap = (flags: string): Array<[string, string, ('bash' | 'pwsh')?]> => [
    ['if/then', `if true; then cr review ${flags}; fi`],
    ['if condition', `if cr review ${flags}; then echo done; fi`],
    ['brace group', `{ cr review ${flags}; }`],
    ['negation', `! cr review ${flags}`],
    ['sudo', `sudo cr review ${flags}`],
    ['doas', `doas cr review ${flags}`],
    ['xargs', `echo x | xargs cr review ${flags}`],
    ['eval', `eval "cr review ${flags}"`],
    ['for loop', `for i in 1 2 3 4 5; do cr review ${flags}; done`],
    ['while loop', `while true; do cr review ${flags}; done`],
    ['iex', `iex "cr review ${flags}"`],
    ['Invoke-Expression', `Invoke-Expression 'cr review ${flags}'`],
    ['Start-Process ArgumentList', `Start-Process cr -ArgumentList "review ${flags}"`],
    ['Start-Process FilePath and list', `Start-Process -FilePath cr -ArgumentList review,${flags.split(' ').join(',')}`],
    ['Start-Job', `Start-Job { cr review ${flags} }`, 'pwsh'],
    ['ForEach-Object', `1..5 | ForEach-Object { cr review ${flags} }`, 'pwsh'],
    ['percent alias', `1..5 | % { cr review ${flags} }`, 'pwsh'],
    ['bash -c', `bash -c 'cr review ${flags}'`],
    ['nested wrappers', `sudo bash -c "eval 'cr review ${flags}'"`],
  ];

  it.each(wrap('--agent --use-credits'))('blocks billing flags behind %s', async (_name, cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(false);
    expect((await decide(pwsh(cmd), env)).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it.each(wrap('--agent'))('counts exactly one run behind %s (a loop is counted once: the iteration count is not visible)', async (_name, cmd, shell) => {
    expect((await decide((shell === 'pwsh' ? pwsh : bash)(cmd), env)).allow).toBe(true);
    expect(readState(stateFile).counts['wrap#main']).toBe(1);
  });

  // Seat ruling 17:10 (G1b verdict change 2). Probe: .claudedocs/e2e-coord-guard-shell-parser/50-g1b-verdict-probe.txt.
  it.each(wrap('--agent').filter((w) => w[2] === 'pwsh'))('denies %s as a Bash text: in bash the braces are plain arguments, so the review has no call to place in a folder', async (_name, cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(false);
  });

  it.each([
    ['sudo', 'sudo cr code push'],
    ['eval', 'eval "cr skills install"'],
    ['Start-Process', 'Start-Process cr -ArgumentList "code new"'],
    ['xargs', `echo x | xargs coderabbit ${KEY_FLAG}=${KEY_VALUE}`],
  ])('blocks other forbidden commands behind %s', async (_name, cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(false);
  });

  it('does not unwrap a wrapper that runs something else', async () => {
    for (const c of ['sudo apt update', 'eval "echo cr"', 'Start-Process notepad', 'echo x | xargs echo cr', 'if true; then git status; fi']) {
      expect((await decide(bash(c), env)).allow).toBe(true);
    }
    expect(existsSync(stateFile)).toBe(false);
  });
});

// Real git runs are slow on this machine (seconds each under load), so this block gets a long timeout.
describe('coderabbit-guard: run counter key', { timeout: 180_000 }, () => {
  let dir: string;
  // git on this machine sometimes dies at start-up (the MSYS fork storm, see CONTEXT.md), so retry.
  const git = (cwd: string, ...args: string[]): string => {
    for (let attempt = 1; ; attempt++) {
      try {
        return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
  };
  const makeRepo = (name: string, branch: string, remote?: string, commit = false) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', branch);
    if (remote) git(path, 'remote', 'add', 'fork', remote);
    if (commit) git(path, 'commit', '-q', '--allow-empty', '-m', `init ${name}`);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps two repos with the same branch name apart when neither has an origin remote', () => {
    const a = makeRepo('a', 'feat/x');
    const b = makeRepo('b', 'feat/x');
    expect(repoBranchKey(a, {})).not.toBe(repoBranchKey(b, {}));
  });

  it('uses the first remote, not only origin, and never puts credentials in the key', () => {
    const a = makeRepo('a', 'feat/x', `https://user:${FAKE_PASS}@github.com/Rev4nchist/Continuous-Claude-v3.git`);
    const key = repoBranchKey(a, {});
    expect(key).toBe('github.com/rev4nchist/continuous-claude-v3#feat/x');
    expect(key).not.toContain(FAKE_PASS);
  });

  it('keeps host and owner in the key: same repo name, different owner or host, different keys', () => {
    const a = makeRepo('a', 'feat/x', 'https://github.com/alice/tools.git');
    const b = makeRepo('b', 'feat/x', 'https://github.com/bob/tools.git');
    const c = makeRepo('c', 'feat/x', 'https://gitlab.example.com/alice/tools.git');
    const keys = [a, b, c].map((p) => repoBranchKey(p, {}));
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    'https://github.com/alice/tools.git',
    'https://github.com/alice/tools',
    'https://user:s3cret@github.com/alice/tools.git',
    'https://s3cret@github.com/alice/tools.git/',
    'git@github.com:alice/tools.git',
    'ssh://git@github.com/alice/tools.git',
    'ssh://git@github.com:22/alice/tools.git',
  ])('one repo reached by https or ssh gets one credential-free key: %s', (remote) => {
    const a = makeRepo('a', 'feat/x', remote);
    const key = repoBranchKey(a, {});
    expect(key).toBe('github.com/alice/tools#feat/x');
    expect(key).not.toMatch(/s3cret|user|@/);
  });

  it('keys a detached HEAD by commit, not by the shared name HEAD', () => {
    const a = makeRepo('a', 'main', undefined, true);
    git(a, 'checkout', '-q', '--detach');
    const first = repoBranchKey(a, {});
    git(a, 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = repoBranchKey(a, {});
    expect(first).not.toMatch(/#HEAD$/);
    expect(second).not.toBe(first);
  });

  it('reads the payload cwd, not the hook process cwd', async () => {
    // A repo with no remote is unknown to the answer-key check, which then needs main refs: give these repos another repo's remote.
    const a = makeRepo('a', 'feat/a', OTHER_REMOTE);
    const b = makeRepo('b', 'feat/b', OTHER_REMOTE);
    const stateFile = join(dir, 'state.json');
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile };
    expect((await decide({ ...bash('cr review --agent'), cwd: a }, env)).allow).toBe(true);
    expect((await decide({ ...bash('cr review --agent'), cwd: b }, env)).allow).toBe(true);
    expect(Object.keys(readState(stateFile).counts).sort()).toEqual([repoBranchKey(a, {}), repoBranchKey(b, {})].sort());
  });

  it('follows a leading cd, because subagents run every command as cd <worktree> && ...', async () => {
    const a = makeRepo('a', 'feat/a', OTHER_REMOTE);
    const b = makeRepo('b', 'feat/b', OTHER_REMOTE);
    const stateFile = join(dir, 'state.json');
    const env = { CCV3_CODERABBIT_GUARD_STATE: stateFile };
    expect((await decide({ ...bash(`cd "${b}" && cr review --agent`), cwd: a }, env)).allow).toBe(true);
    expect(Object.keys(readState(stateFile).counts)).toEqual([repoBranchKey(b, {})]);
  });
});

describe('coderabbit-guard: override', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-ovr-'));
    logFile = join(dir, 'decisions.jsonl');
    env = {
      CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'),
      CCV3_CODERABBIT_GUARD_KEY: 'ovr#main',
      CCV3_GUARD_DECISIONS_LOG: logFile,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    'echo SKIP_CODERABBIT_GUARD=1 && cr review --use-credits',
    'echo "SKIP_CODERABBIT_GUARD=1"; cr review --use-credits',
    '# SKIP_CODERABBIT_GUARD=1\ncr review --use-credits',
    'cr review --use-credits # SKIP_CODERABBIT_GUARD=1',
    'SKIP_CODERABBIT_GUARD=10 cr review --use-credits',
  ])('does not accept the marker anywhere but the start: %s', async (cmd) => {
    expect((await decide(bash(cmd), env)).allow).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });

  it.each([
    ['Bash', bash('SKIP_CODERABBIT_GUARD=1 cr review --use-credits')],
    ['PowerShell', pwsh('$env:SKIP_CODERABBIT_GUARD=1; cr review --use-credits')],
  ])('accepts a leading assignment on %s and writes an override line', async (_t, input) => {
    expect((await decide({ session_id: 's1', ...input }, env)).allow).toBe(true);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ hook: 'coderabbit-guard', decision: 'override', session_id: 's1' });
  });
});

// ---------------------------------------------------------------------------------------------
// Greptile review of PR #155 (findings 4376918017, 4376918032, 4376918039): one fail-closed billing
// check on the RAW text of every segment that does not start with git or gh, independent of how
// parseInvocation reads wrappers.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: raw billing check (Greptile examples)', () => {
  const never = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never.json') };
  const REASON = /billing flag with a CodeRabbit CLI call/;

  const examples: Array<[string, string]> = [
    ['4376918017 xargs option value', 'xargs -n 1 cr review --agent --use-credits'],
    ['4376918017 sudo option value', 'sudo -u root cr review --agent --use-credits'],
    ['4376918032 Start-Process quoted path with spaces', 'Start-Process -FilePath "C:\\Program Files\\CodeRabbit\\cr.exe" -ArgumentList "review --agent --use-credits"'],
    ['4376918039 nested bash -c with backticks in a PowerShell call', "bash -c 'echo `cr review --agent --use-credits`'"],
    ['api key flag with =value', `sudo -u root cr review --agent ${KEY_FLAG}=${KEY_VALUE}`],
    ['api key flag in double quotes', `sudo -u root cr review --agent "${KEY_FLAG}" ${KEY_VALUE}`],
    ['--use-credits in single quotes', "xargs -n 1 coderabbit.exe review '--use-credits'"],
    ['path prefix /usr/bin/cr', 'sudo -u root /usr/bin/cr review --agent --use-credits'],
    ['pwsh -c payload', 'pwsh -NoProfile -c "& \'C:\\Program Files\\CodeRabbit\\cr.exe\' review --agent --use-credits"'],
    ['command substitution inside a non-git command', 'echo $(cr review --agent --use-credits)'],
  ];

  it.each(examples)('denies on Bash and PowerShell: %s', async (_name, command) => {
    for (const tool of [bash, pwsh]) {
      const d = (await decide(tool(command), never));
      expect(d.allow, `${tool === bash ? 'Bash' : 'PowerShell'}: ${command}`).toBe(false);
      expect(d.reason).toMatch(REASON);
    }
    expect(existsSync(join(tmpdir(), 'cr-guard-never.json'))).toBe(false);
  });

  it('denies a billing flag in a segment after a git segment', async () => {
    expect((await decide(bash('git status && xargs -n 1 cr review --agent --use-credits'), never)).allow).toBe(false);
  });

  it.each([
    'git commit -m "docs: cr review --use-credits is banned"',
    'gh pr comment 1 --body "never run coderabbit --api-key"',
    'git commit -F - <<EOF\ndocs: never run cr review --use-credits or coderabbit --api-key\nEOF',
    `git commit -m "$(cat <<'EOF'\nfix: cr review --use-credits is banned; coderabbit ${KEY_FLAG} too\nEOF\n)"`,
    'echo hello',
    'cat .coderabbit.yaml',
    'git push fork feat/ccv3-cr-install',
  ])('allows text that only talks about it: %s', async (command) => {
    expect((await decide(bash(command), never)).allow, command).toBe(true);
    // PowerShell has no heredoc: the same text there is not a valid commit.
    if (!command.includes('<<')) expect((await decide(pwsh(command), never)).allow, command).toBe(true);
  });

  it('still denies a real billing call after a heredoc commit in the same command', async () => {
    const cmd = "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && cr review --agent --use-credits";
    expect((await decide(bash(cmd), never)).allow).toBe(false);
  });
});

describe('coderabbit-guard: raw run counting when parseInvocation misses the call', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-raw-'));
    env = { CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'), CCV3_CODERABBIT_GUARD_KEY: 'raw#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['bash', 'xargs -n 1 cr review --agent'],
    ['bash', 'sudo -u root cr review --agent'],
    ['pwsh', 'Start-Process -FilePath "C:\\Program Files\\CodeRabbit\\cr.exe" -ArgumentList "review --agent"'],
    ['bash', "bash -c 'echo `cr review --agent`'"],
  ])('counts a review hidden in a wrapper (%s): %s', async (tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(readState(join(dir, 'state.json')).counts['raw#main']).toBe(1);
    expect((await decide(make(command), env)).allow).toBe(true);
    expect((await decide(make(command), env)).allow, 'third hidden review hits the cap').toBe(false);
  });

  it('does not double count a review that parseInvocation already found', async () => {
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    expect(readState(join(dir, 'state.json')).counts['raw#main']).toBe(1);
  });

  it.each([
    'cr doctor',
    'cr usage',
    'git commit -m "cr review notes"',
    'gh pr comment 1 --body "ran coderabbit review"',
    'echo cr',
    'cat .coderabbit.yaml',
    'echo review',
  ])('does not count: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Opus critic round 2 on PR #155: shims, search commands that mention "cr review", and text-only
// commands that mention a billing flag. The raw check reads only segments that EXECUTE their text.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: raw check accepts every Windows shim extension', () => {
  const never = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never-shim.json') };
  const exts = ['exe', 'cmd', 'bat', 'ps1'];
  const names = ['cr', 'coderabbit'];

  const cases: Array<[string, string]> = [];
  for (const name of names) {
    for (const ext of exts) {
      cases.push([`xargs ${name}.${ext}`, `xargs -n 1 ${name}.${ext} review --agent --use-credits`]);
      cases.push([
        `Start-Process ${name}.${ext}`,
        `Start-Process -FilePath "C:\\Program Files\\CodeRabbit\\${name}.${ext}" -ArgumentList "review --agent --use-credits"`,
      ]);
    }
  }

  it.each(cases)('denies on Bash and PowerShell: %s', async (_name, command) => {
    for (const tool of [bash, pwsh]) {
      const d = (await decide(tool(command), never));
      expect(d.allow, `${tool === bash ? 'Bash' : 'PowerShell'}: ${command}`).toBe(false);
      expect(d.reason).toMatch(/billing flag with a CodeRabbit CLI call/);
    }
  });

  it('counts a hidden review through a shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-guard-shim-'));
    const env = { CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'), CCV3_CODERABBIT_GUARD_KEY: 'shim#main' };
    try {
      expect((await decide(bash('xargs -n 1 cr.cmd review --agent'), env)).allow).toBe(true);
      expect(readState(join(dir, 'state.json')).counts['shim#main']).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coderabbit-guard: search commands that mention "cr review" do not use a slot', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-search-'));
    env = { CCV3_CODERABBIT_GUARD_STATE: join(dir, 'state.json'), CCV3_CODERABBIT_GUARD_KEY: 'search#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['bash', 'grep -rn "cr review" docs'],
    ['bash', 'git log --oneline | grep "cr review"'],
    ['bash', 'rg "cr review"'],
    ['pwsh', 'Select-String -Pattern "cr review"'],
  ])('allows 3 repeats and counts 0 runs (%s): %s', async (tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    for (let i = 0; i < 3; i++) expect((await decide(make(command), env)).allow, `run ${i + 1}`).toBe(true);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });

  it('still counts xargs -n 1 cr review --agent', async () => {
    expect((await decide(bash('xargs -n 1 cr review --agent'), env)).allow).toBe(true);
    expect(readState(join(dir, 'state.json')).counts['search#main']).toBe(1);
  });

  it.each([
    ['bash', 'time cr review --agent'],
    ['bash', 'nohup sh -c "cr review --agent"'],
    ['bash', 'sudo -u root cr review --agent'],
    ['pwsh', 'Start-Job -ScriptBlock { cr review --agent }'],
    ['pwsh', 'Invoke-Expression "cr review --agent"'],
  ])('still counts an executing wrapper (%s): %s', async (tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(readState(join(dir, 'state.json')).counts['search#main']).toBeGreaterThanOrEqual(1);
  });

  // Round 3 (M1): a wrapper the parser does not read (find -exec, watch) may run the review in a folder the check does not see.
  // It is denied in every folder, also this folder outside git, and it uses no slot.
  it.each([
    ['bash', 'find . -maxdepth 0 -exec cr review --agent {} ;'],
    ['bash', 'watch -n 5 cr review --agent'],
  ])('denies a wrapper the parser does not read (%s): %s', async (tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    const d = (await decide(make(command), env));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('run the review as its own plain command with --base <ref>');
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });
});

// FLIPPED in round 9 (Dave): the billing check reads the raw, unstripped command. A cr word with a
// billing flag is denied in any command that is not a leading git or gh. Every command below was
// allowed before; all 11 are now denied.
describe('coderabbit-guard: text-only commands that mention a billing flag are denied (flipped r9)', () => {
  const never = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never-text.json') };

  it.each([
    'rg "cr review --use-credits" .claude',
    'grep -n "coderabbit --api-key" file',
    'Select-String -Pattern "coderabbit --api-key"',
    'Set-Content notes.md "never run cr review --use-credits"',
    `echo '{"tool_input":{"command":"cr review --use-credits"}}' > payload.json`,
    'Write-Output "cr review --use-credits is banned"',
    'printf "%s" "coderabbit --api-key"',
    'cat docs/never-use-credits.md "cr review --use-credits"',
    'Get-Content notes.md | Select-String "cr review --use-credits"',
    'Out-File -FilePath n.txt -InputObject "cr review --use-credits"',
    'Add-Content notes.md "coderabbit --api-key"',
  ])('denies on Bash and PowerShell: %s', async (command) => {
    for (const tool of [bash, pwsh]) {
      const d = (await decide(tool(command), never));
      expect(d.allow, `${tool === bash ? 'Bash' : 'PowerShell'}: ${command}`).toBe(false);
      expect(d.reason).toMatch(/billing flag with a CodeRabbit CLI call/);
    }
    expect(existsSync(join(tmpdir(), 'cr-guard-never-text.json'))).toBe(false);
  });

  it('still denies an executing wrapper after a text-only command', async () => {
    expect((await decide(bash('echo hi && sudo -u root cr review --agent --use-credits'), never)).allow).toBe(false);
  });

  it('still denies env, nohup, timeout and find -exec wrappers with a billing flag', async () => {
    for (const cmd of [
      'env FOO=1 cr review --agent --use-credits',
      'nohup cr review --agent --use-credits',
      'timeout 60 cr review --agent --use-credits',
      'find . -maxdepth 0 -exec cr review --use-credits {} ;',
      `time coderabbit.cmd review ${KEY_FLAG} ${KEY_VALUE}`,
    ]) {
      expect((await decide(bash(cmd), never)).allow, cmd).toBe(false);
    }
    expect((await decide(pwsh('Start-Job -ScriptBlock { cr review --agent --use-credits }'), never)).allow).toBe(false);
    expect((await decide(pwsh('1..3 | ForEach-Object { cr.cmd review --agent --use-credits }'), never)).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Greptile round 3 on PR #155 (thread 4377276370): a command that mixes a parsed review with a
// hidden one must count each segment once. The parsed count must not hide the raw count.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: mixed parsed and hidden reviews count per segment', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const MIXED = 'cr review --agent && sudo -u root cr review --agent';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-mixed-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'mixed#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies the Greptile example at 1 used run: it adds 2 and only 1 is left', async () => {
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    const d = (await decide(bash(MIXED), env));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/run cap reached \(1 of 2 .*this command adds 2\)/);
    expect(readState(stateFile).counts['mixed#main']).toBe(1);
  });

  it('counts the Greptile example as 2 runs on a fresh state', async () => {
    expect((await decide(bash(MIXED), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(2);
  });

  it.each([
    'sudo -u root cr review --agent && cr review --agent',
    'cr review --agent && sudo -u root cr review --agent && cr doctor',
    'sudo -u root cr review --agent ; xargs -n 1 cr review --agent',
    'bash -c "cr review --agent" && sudo -u root cr review --agent',
    'bash -c "cr review --agent && sudo -u root cr review --agent"',
    'sh -c "bash -c \\"cr review --agent && sudo -u root cr review --agent\\""',
  ])('counts 2 for a mix in any order: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(2);
  });

  it('counts 2 for a PowerShell mix of a parsed and a Start-Process review', async () => {
    const cmd = 'cr review --agent; Start-Process -FilePath "cr.exe" -ArgumentList "review --agent"';
    expect((await decide(pwsh(cmd), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(2);
  });

  it('keeps two parsed reviews at 2 runs', async () => {
    expect((await decide(bash('cr review --agent && cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(2);
  });

  it('keeps a lone hidden review at 1 run', async () => {
    expect((await decide(bash('xargs -n 1 cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(1);
  });

  it('does not count a segment twice when the parser and the raw scan both see it', async () => {
    expect((await decide(bash('cr review --agent && cr doctor && echo "cr review"'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['mixed#main']).toBe(1);
  });

  // Round 3 (the one call rule): an UNQUOTED cr word followed by review is a call anywhere, also after echo. No parsed cr call stands for it,
  // so the check cannot place it: the whole command is denied with the way-out text and uses no slot. The quoted form above is data.
  it('denies an unquoted `echo cr review` as a call the check cannot place, and uses no slot', async () => {
    const d = (await decide(bash('cr review --agent && cr doctor && echo cr review'), env));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('run the review as its own plain command with --base <ref>');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('blocks a three-run mix and records nothing', async () => {
    expect((await decide(bash(`${MIXED} && xargs -n 1 cr review --agent`), env)).allow).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Greptile round 4 on PR #155 (thread 4377466158): the raw scan and the parser must attribute a
// review to the same segment. A `$( )` inside double quotes is one raw segment but several parsed
// segments, so an index-based match charged the fragment and then the real review again.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: a substitution before a review does not cost a second slot', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-subst-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: 'subst#main' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, 'bash' | 'pwsh', string]> = [
    ['quoted $( )', 'bash', 'echo "$(date)" && cr review --agent'],
    ['quoted backticks', 'bash', 'echo "`date`" && cr review --agent'],
    ['unquoted $( )', 'bash', 'echo $(date) && cr review --agent'],
    ['PowerShell quoted $( )', 'pwsh', 'Write-Output "$(Get-Date)"; cr review --agent'],
    ['bash -c with $( )', 'bash', 'bash -c "echo $(date) && cr review --agent"'],
  ];

  it.each(cases)('counts 1 on a fresh state, then allows a second review: %s', async (_name, tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(1);
    expect((await decide(make('cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(2);
  });

  it.each(cases)('allows the command at 1 used run and counts 2: %s', async (_name, tool, command) => {
    const make = tool === 'bash' ? bash : pwsh;
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    const d = (await decide(make(command), env));
    expect(d.allow, d.reason).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(2);
  });

  it('counts two real reviews inside one quoted string as 2', async () => {
    expect((await decide(bash('echo "$(cr review --agent) $(cr review --agent)"'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(2);
  });

  it('keeps counting a hidden review that follows a substitution', async () => {
    expect((await decide(bash('echo "$(date)" && sudo -u root cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(1);
  });

  it('keeps the regressions: mix counts 2, xargs counts 1, text-only counts 0', async () => {
    expect((await decide(bash('cr review --agent && sudo -u root cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(2);
    rmSync(stateFile);
    expect((await decide(bash('xargs -n 1 cr review --agent'), env)).allow).toBe(true);
    expect(readState(stateFile).counts['subst#main']).toBe(1);
    rmSync(stateFile);
    for (const t of ['grep -rn "cr review" docs', 'echo "cr review"', 'Set-Content n.md "cr review --agent"']) {
      expect((await decide(bash(t), env)).allow).toBe(true);
    }
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe('coderabbit-guard: an allowed non-review call never cancels a hidden review (Greptile r5)', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'hidden#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-hidden-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  const GREPTILE = 'sudo -u root cr review --agent # check with "$(cr --version)"';

  it.each([
    ['the Greptile example (comment holds an allowed call)', GREPTILE],
    ['hidden review then --version', 'sudo -u root cr review --agent && cr --version'],
    ['xargs review then doctor', 'xargs -n 1 cr review --agent; cr doctor'],
    ['--version then a hidden review inside bash -c', 'bash -c "cr --version; sudo cr review --agent"'],
  ])('counts 1 on a fresh state: %s', async (_name, command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('denies the Greptile example at 2 used runs with the cap reason', async () => {
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    expect((await decide(bash('cr review --agent'), env)).allow).toBe(true);
    const d = (await decide(bash(GREPTILE), env));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('run cap reached');
    expect(used()).toBe(2);
  });

  it.each([
    ['plain mix', 'cr review --agent && sudo -u root cr review --agent', 2],
    ['two plain reviews', 'cr review --agent && cr review --agent', 2],
    ['two reviews in one quoted string', 'echo "$(cr review --agent) $(cr review --agent)"', 2],
    ['substitution before a review', 'echo "$(date)" && cr review --agent', 1],
    ['parsed review plus allowed call in one span keeps 1', 'cr review --agent "$(cr --version)"', 1],
    ['--version alone', 'cr --version', 0],
    ['doctor then usage', 'cr doctor && cr usage --agent', 0],
    ['text only', 'echo "cr review"', 0],
    ['grep for the phrase', 'grep -rn "cr review" docs', 0],
  ])('keeps the count: %s', async (_name, command, runs) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(runs);
  });

  it('still denies Greptile billing examples', async () => {
    expect((await decide(bash(`sudo -u root cr review --agent ${KEY_FLAG}=${KEY_VALUE}`), env)).allow).toBe(false);
    expect((await decide(bash(`sudo -u root cr review --agent "${KEY_FLAG}" ${KEY_VALUE}`), env)).allow).toBe(false);
    expect(used()).toBe(0);
  });
});

describe('coderabbit-guard: a review --help call explains the review word only when it fills the span', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'helpspan#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-helpspan-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  it.each([
    'cr review --help',
    'cr review --agent --help',
  ])('counts 0 for a plain call: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  // Flipped in round 8: a wrapped help call is not plain, so it counts as a review.
  it.each([
    'bash -c "cr review --help"',
    'sudo cr review --help',
  ])('counts 1 for a wrapped call: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('counts 1 when a review --help call in a comment sits next to a hidden review', async () => {
    expect((await decide(bash('sudo -u root cr review --agent # see "$(cr review --help)"'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });
});

describe('coderabbit-guard: comments and arguments after -- never mark a review as help or version (xreview G17-001)', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'comment#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-comment-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  it.each([
    ['Bash', 'cr review --agent # --version', bash],
    ['Bash', 'cr review --agent # --help', bash],
    ['Bash', 'cr review --agent # -h', bash],
    ['Bash', 'cr review --agent #--version', bash],
    ['Bash', 'cr review --agent\n# --version', bash],
    ['PowerShell', 'cr review --agent # --version', pwsh],
    ['PowerShell', 'cr review --agent <# --version #>', pwsh],
    ['PowerShell', 'cr review <# note #> --agent <# --help #>', pwsh],
  ])('%s counts 1: %s', async (_tool, command, make) => {
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it.each([
    ['Bash', 'cr review --agent # --version', bash],
    ['Bash', 'cr review --agent # --help', bash],
    ['PowerShell', 'cr review --agent # --version', pwsh],
    ['PowerShell', 'cr review --agent <# --version #>', pwsh],
  ])('%s denies at the cap: %s', async (_tool, command, make) => {
    writeState(stateFile, { counts: { [KEY]: 2 } });
    const r = (await decide(make(command), env));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/run cap reached/);
    expect(used()).toBe(2);
  });

  it.each([
    ['Bash', 'cr doctor # check before review', bash],
    ['PowerShell', 'cr doctor # check before review', pwsh],
    ['PowerShell', 'cr doctor <# check before review #>', pwsh],
    ['Bash', 'cr usage # cr review is next', bash],
  ])('%s counts 0: %s', async (_tool, command, make) => {
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  it('counts 1 when the flag comes after --', async () => {
    expect((await decide(bash('cr review --agent -- --version'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('counts 1 when the flag is inside one quoted argument', async () => {
    expect((await decide(bash('cr review --agent "# --version"'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it.each(['cr --version', 'cr review --help', 'cr -h', 'cr review --agent --help'])('counts 0 for real info flag: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  it.each([
    'echo "a # b" && cr review --agent',
    'echo $# && cr review --agent',
    'cr doctor a#b && cr review --agent',
    "echo 'x # y' ; cr review --agent",
    'echo "https://x.test/p#anchor" && cr review --agent',
    'cat <<EOF\nline # one\nEOF\ncr review --agent',
  ])('does not strip a # that is not a comment: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('keeps a quoted # in PowerShell', async () => {
    expect((await decide(pwsh('Write-Output "a # b"; cr review --agent'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('a comment line ends at the newline: the next line still runs', async () => {
    expect((await decide(bash('echo hi # note\ncr review --agent'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('a git commit that quotes cr review --use-credits stays allowed with 0 runs', async () => {
    expect((await decide(bash('git commit -m "fix # cr review --use-credits"'), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  // FLIPPED in round 9: a comment that names cr next to a billing flag is denied (raw fail-closed check).
  it('a billing flag next to cr in a comment is denied (flipped r9), and so is one before it', async () => {
    expect((await decide(bash('cr doctor # cr review --use-credits'), env)).allow).toBe(false);
    expect((await decide(bash('cr review --agent --use-credits # ok'), env)).allow).toBe(false);
    expect(used()).toBe(0);
  });

  it('keeps Greptile regressions: comment with a substitution next to a hidden review counts 1', async () => {
    expect((await decide(bash('sudo -u root cr review --agent # check with "$(cr --version)"'), env)).allow).toBe(true);
    expect(used()).toBe(1);
    expect((await decide(bash('echo "$(date)" && cr review --agent'), env)).allow).toBe(true);
    expect(used()).toBe(2);
  });
});

describe('coderabbit-guard: one lexer pass tracks quotes and comments together (Greptile r7)', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'lexer#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-lexer-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  it('Bash: an apostrophe in a comment does not pair with a later quote and hide a billed review', async () => {
    const r = (await decide(bash("# don't retry\necho 'review # status'; cr review --agent --use-credits"), env));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/billing/i);
    expect(used()).toBe(0);
  });

  it('Bash: the same two lines without the billing flag count 1 run', async () => {
    expect((await decide(bash("# don't retry\necho 'review # status'; cr review --agent"), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('PowerShell: an apostrophe in a comment does not hide a review', async () => {
    expect((await decide(pwsh("# don't retry\nWrite-Output 'review # status'; cr review --agent"), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('PowerShell: the same two lines with a billing flag are denied', async () => {
    const r = (await decide(pwsh("# don't retry\nWrite-Output 'review # status'; cr review --agent --use-credits"), env));
    expect(r.allow).toBe(false);
    expect(used()).toBe(0);
  });

  it.each([
    ['Bash', '# say "hi\ncr review --agent', bash],
    ['PowerShell', '# say "hi\ncr review --agent', pwsh],
  ])('%s: an unbalanced double quote in a comment counts 1', async (_tool, command, make) => {
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('Bash: a comment that holds <<EOF does not start a heredoc', async () => {
    expect((await decide(bash('echo hi # cat <<EOF\ncr review --agent\nEOF'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it("PowerShell: a <# it's #> block comment before a review counts 1", async () => {
    expect((await decide(pwsh("<# it's #> cr review --agent"), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it("Bash: a real heredoc body holding # ' does not change the next line", async () => {
    expect((await decide(bash("cat <<EOF\n# '\nEOF\ncr review --agent"), env)).allow).toBe(true);
    expect(used()).toBe(1);
    expect((await decide(bash("cat <<EOF\n# '\nEOF\ncr review --agent --use-credits"), env)).allow).toBe(false);
  });

});

describe('coderabbit-guard: help and version are free only for a plain one-line call (Greptile r8)', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'plain#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-plain-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  const G1 = 'cr review --agent \\\n# --version';
  const G2 = 'cat <<EOF\n$(cr review --agent # --version\n)\nEOF';
  // G3 is the original text of the row: the # comment swallows the closing paren, so PowerShell cannot parse it (seat ruling 17:32, G7a). G3b keeps
  // the row's intent: the comment is closed on its own line, the text parses, and the comment still cannot make the review free.
  const G3 = '@"\n$(cr review --agent # --version)\n"@';
  const G3b = '@"\n$(cr review --agent # --version\n)\n"@';

  const SMUGGLED: Array<[string, string, (c: string) => Record<string, unknown>]> = [
    ['Bash line continuation then comment (thread 4379197493)', G1, bash],
    ['Bash substitution with a comment in a heredoc (thread 4379197510)', G2, bash],
    ['PowerShell expandable here-string with a comment', G3b, pwsh],
    ['PowerShell single-quote here-string earlier in the command', "@'\nnote\n'@; cr review --agent # --version", pwsh],
    ['Bash continuation then --version', 'cr review --agent \\\n--version', bash],
    ['PowerShell backtick continuation then --version', 'cr review --agent `\n--version', pwsh],
    ['Bash comment holds --help', 'cr review --agent # --help', bash],
    ['bash -c wrapper', 'bash -c "cr review --help"', bash],
    ['quoted substitution', 'echo "$(cr review --version)"', bash],
    ['sudo wrapper', 'sudo cr review --help', bash],
    ['plain help but a comment elsewhere in the command', 'cr review --help; echo hi # note', bash],
    ['plain help but a heredoc elsewhere in the command', 'cr review --help; cat <<EOF\nx\nEOF', bash],
    ['plain help but a newline inside a quoted argument', 'cr review --help "a\nb"', bash],
    ['PowerShell -ArgumentList payload', 'Start-Process cr -ArgumentList review,--help', pwsh],
    ['PowerShell block comment', 'cr review --help <# n #>', pwsh],
  ];

  it.each(SMUGGLED)('counts 1: %s', async (_name, command, make) => {
    expect((await decide(make(command), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it.each(SMUGGLED.slice(0, 3))('denies at 2 used runs: %s', async (_name, command, make) => {
    writeState(stateFile, { counts: { [KEY]: 2 } });
    const r = (await decide(make(command), env));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/run cap reached/);
    expect(used()).toBe(2);
  });

  it('unparseable in PowerShell: the comment swallows the paren, so the text is denied with the way-out and uses no run slot', async () => {
    const r = await decide(pwsh(G3), env);
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('run the review as its own plain command with --base <ref>');
    expect(r.reason).toContain('the command did not parse');
    expect(used()).toBe(0);
  });

  it.each([
    'cr review --help',
    'cr review --agent --help',
    'cr --version',
    'cr -h',
    'cr doctor',
    'cr usage --agent',
    'cr auth status',
    'echo hi && cr review --help',
  ])('a plain call counts 0: %s', async (command) => {
    expect((await decide(bash(command), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  it('a plain PowerShell call counts 0', async () => {
    expect((await decide(pwsh('cr review --help'), env)).allow).toBe(true);
    expect(used()).toBe(0);
  });

  it.each(['cr doctor # check', 'sudo cr doctor', 'bash -c "cr --version"', 'cr --version # x'])(
    'a read-only call with no review word counts 0 even when not plain: %s',
    async (command) => {
      expect((await decide(bash(command), env)).allow).toBe(true);
      expect(used()).toBe(0);
    },
  );

  it.each(['sudo cr --version review', 'bash -c "cr usage review"', 'cr --help "review"; echo hi # x'])(
    'a read-only call that is not plain and holds a review word counts 1: %s',
    async (command) => {
      expect((await decide(bash(command), env)).allow).toBe(true);
      expect(used()).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Round 9 (Dave, Greptile thread 4379473171): join line continuations BEFORE lexing, as the shell
// does, and run the billing check on the raw, unstripped command. The r8 lexShell rule "a # after an
// escaped newline starts a comment" is gone: after the join no escaped newline is left.
// ---------------------------------------------------------------------------------------------
describe('coderabbit-guard: joinContinuations works like the shell', () => {
  it('Bash: removes a backslash-newline outside quotes and inside double quotes', () => {
    expect(joinContinuations('echo foo\\\nbar')).toBe('echo foobar');
    expect(joinContinuations('echo "a\\\nb"')).toBe('echo "ab"');
  });

  it('Bash: removes a backslash CRLF pair', () => {
    expect(joinContinuations('echo foo\\\r\nbar')).toBe('echo foobar');
  });

  it('Bash: keeps a backslash-newline inside single quotes', () => {
    expect(joinContinuations("echo 'a\\\nb'")).toBe("echo 'a\\\nb'");
  });

  it('Bash: an escaped backslash before a newline is not a continuation', () => {
    expect(joinContinuations('echo \\\\\nnext')).toBe('echo \\\\\nnext');
  });

  it('Bash: a comment ends at its newline even after a backslash', () => {
    expect(joinContinuations('echo hi # note \\\necho two')).toBe('echo hi # note \\\necho two');
  });

  it('Bash: a # that follows a removed continuation joins its word and is not a comment start', () => {
    expect(joinContinuations('echo foo\\\n# note')).toBe('echo foo# note');
  });

  it('PowerShell: removes a backtick-newline outside single quotes, keeps it inside', () => {
    expect(joinContinuations('echo foo`\nbar', true)).toBe('echo foobar');
    expect(joinContinuations("echo 'a`\nb'", true)).toBe("echo 'a`\nb'");
    expect(joinContinuations('echo foo`\r\nbar', true)).toBe('echo foobar');
  });

  it('PowerShell: a backslash-newline is not a continuation', () => {
    expect(joinContinuations('echo foo\\\nbar', true)).toBe('echo foo\\\nbar');
  });

  it('returns the text unchanged when it holds no continuation', () => {
    expect(joinContinuations('cr review --agent')).toBe('cr review --agent');
  });
});

describe('coderabbit-guard: a continued word cannot hide a review (Greptile r9, thread 4379473171)', () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;
  const KEY = 'join#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-guard-join-'));
    stateFile = join(dir, 'state.json');
    env = { CCV3_CODERABBIT_GUARD_STATE: stateFile, CCV3_CODERABBIT_GUARD_KEY: KEY };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const used = (): number => (existsSync(stateFile) ? (readState(stateFile).counts[KEY] ?? 0) : 0);

  const GREPTILE = 'echo foo\\\n# note; cr review --agent --use-credits';
  const GREPTILE_FREE = 'echo foo\\\n# note; cr review --agent';
  const GREPTILE_PS = 'echo foo`\n# note; cr review --agent --use-credits';
  const GREPTILE_PS_FREE = 'echo foo`\n# note; cr review --agent';

  it('Bash: the exact Greptile example is denied', async () => {
    const r = (await decide(bash(GREPTILE), env));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/billing/i);
    expect(used()).toBe(0);
  });

  it('Bash: the same text without the billing flag counts 1', async () => {
    expect((await decide(bash(GREPTILE_FREE), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('Bash: the joined review is denied at the cap', async () => {
    writeState(stateFile, { counts: { [KEY]: 2 } });
    const r = (await decide(bash(GREPTILE_FREE), env));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/run cap reached/);
  });

  it('PowerShell: the backtick analogue is denied', async () => {
    expect((await decide(pwsh(GREPTILE_PS), env)).allow).toBe(false);
    expect(used()).toBe(0);
  });

  it('PowerShell: the backtick analogue without the billing flag counts 1', async () => {
    expect((await decide(pwsh(GREPTILE_PS_FREE), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('Bash: CRLF line endings give the same result', async () => {
    expect((await decide(bash(GREPTILE.replace(/\n/g, '\r\n')), env)).allow).toBe(false);
    expect((await decide(bash(GREPTILE_FREE.replace(/\n/g, '\r\n')), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it("Bash: a continuation inside single quotes is not joined, the review after it counts 1", async () => {
    expect((await decide(bash("echo 'a\\\nb'; cr review --agent"), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('Bash: a comment before a continued line does not swallow the next line', async () => {
    expect((await decide(bash('cr doctor # note \\\ncr review --agent'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  it('Bash: a billing flag split by a continuation is denied', async () => {
    expect((await decide(bash('cr review --agent --use-\\\ncredits'), env)).allow).toBe(false);
    expect(used()).toBe(0);
  });

  it('Bash: a continued call is not plain, so --version after it still counts 1', async () => {
    expect((await decide(bash('cr review --agent \\\n--version'), env)).allow).toBe(true);
    expect(used()).toBe(1);
  });

  // The old lexShell row of this place ("an escaped # is not a comment") moved to shell-ast.test.ts as the row "lexShell row: an escaped # is not a comment ..." (plan 44 section 4.2).
});

describe('coderabbit-guard: the billing check reads the raw command (Dave r9)', () => {
  const never = { CCV3_CODERABBIT_GUARD_STATE: join(tmpdir(), 'cr-guard-never-raw9.json') };

  it('denies a comment that names cr next to a billing flag', async () => {
    const r = (await decide(bash('# never run cr review --use-credits'), never));
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/billing flag with a CodeRabbit CLI call/);
  });

  it('denies a comment after a git command that names cr next to a billing flag', async () => {
    expect((await decide(bash('git commit -m ok # never run cr review --use-credits'), never)).allow).toBe(false);
  });

  it('denies a PowerShell block comment that names cr next to a billing flag', async () => {
    expect((await decide(pwsh('<# never run coderabbit review --use-credits #> git status'), never)).allow).toBe(false);
  });

  it.each([
    'git commit -m "docs: cr review --use-credits is banned"',
    'gh pr comment 1 --body "never run coderabbit --api-key"',
    'git commit -m "docs: coderabbit.exe review --use-credits is banned"',
  ])('allows a leading git or gh command that only quotes it, with 0 runs: %s', async (command) => {
    for (const tool of [bash, pwsh]) expect((await decide(tool(command), never)).allow, command).toBe(true);
    expect(existsSync(join(tmpdir(), 'cr-guard-never-raw9.json'))).toBe(false);
  });

  it('denies when one cr word is in a git commit and another leads a real call', async () => {
    expect((await decide(bash('git commit -m "cr notes" && cr review --agent --use-credits'), never)).allow).toBe(false);
  });

  it('denies a git word that is only an argument of another program', async () => {
    expect((await decide(bash('echo git commit -m "cr review --use-credits"'), never)).allow).toBe(false);
  });
});

describe('coderabbit-guard: the git and gh exemption covers only text that is not executed (Greptile r10, thread 4379851518)', () => {
  const stateFile = join(tmpdir(), 'cr-guard-never-r10.json');
  const never = { CCV3_CODERABBIT_GUARD_STATE: stateFile };
  const BT = '`';
  beforeEach(() => rmSync(stateFile, { force: true }));
  afterEach(() => rmSync(stateFile, { force: true }));

  const executed: Array<[string, string, boolean]> = [
    ['Greptile example: bash -c in a double-quoted $( )', `git commit -m "$(bash -c 'sudo -u root cr review --agent --use-credits')"`, false],
    ['backtick substitution in double quotes', `git commit -m "${BT}bash -c 'cr review --use-credits'${BT}"`, false],
    ['gh body with a $( ) in double quotes', 'gh pr comment 1 --body "$(cr review --agent --use-credits)"', false],
    ['PowerShell $( ) in double quotes', 'git commit -m "$(cr review --agent --use-credits)"', true],
    ['PowerShell $( ) in an expandable here-string', 'git commit -m @"\n$(cr review --agent --use-credits)\n"@', true],
    ['Bash unquoted heredoc with a $( )', 'git commit -F - <<EOF\n$(cr review --agent --use-credits)\nEOF', false],
    ['bash reads a quoted heredoc inside a double-quoted $( )', `git commit -m "$(bash <<'EOF'\ncr review --agent --use-credits\nEOF\n)"`, false],
    ['a $( ) next to quoted prose', 'git commit -m "docs: ok $(cr review --use-credits) done"', false],
  ];

  it.each(executed)('denies when the cr call runs: %s', async (_name, command, ps) => {
    const r = (await decide(ps ? pwsh(command) : bash(command), never));
    expect(r.allow, command).toBe(false);
    expect(r.reason).toMatch(/billing flag with a CodeRabbit CLI call/);
  });

  it('denies the gh $( ) example in the PowerShell tool too', async () => {
    expect((await decide(pwsh('gh pr comment 1 --body "$(cr review --agent --use-credits)"'), never)).allow).toBe(false);
  });

  it.each([
    `git commit -m 'docs: $(cr review --use-credits) is banned'`,
    'git commit -m "docs: cr review --use-credits is banned"',
    `gh pr comment 1 --body "never run coderabbit ${KEY_FLAG}"`,
  ])('allows text that is not executed, with 0 runs, in both tools: %s', async (command) => {
    for (const tool of [bash, pwsh]) expect((await decide(tool(command), never)).allow, command).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  it.each([
    `git commit -m "$(cat <<'EOF'\nfix: cr review --use-credits is banned\nEOF\n)"`,
    'git commit -m "docs: \\$(cr review --use-credits) is banned"',
  ])('allows Bash text that is not executed (data heredoc, escaped $): %s', async (command) => {
    expect((await decide(bash(command), never)).allow, command).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });
});
