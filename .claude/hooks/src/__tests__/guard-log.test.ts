/**
 * guard-log: the shared decision log for PreToolUse guard hooks.
 *
 * Ways it can fail (one test each):
 *  1. A line is missing a field, or is not one JSON object per line.
 *  2. A secret reaches the log (token shapes, key=value, flag value, URL password, header).
 *  3. The 80-char cut happens BEFORE masking, so a secret that straddles char 80 leaks its head.
 *  4. The agent id is lost (payload agent_id or CLAUDE_AGENT_ID).
 *  5. Tests write to the real log (VITEST with no override must not write).
 *  6. A logging failure throws and blocks a tool call.
 *  7. The destructive guard does not report an override, or reports one for a harmless command.
 *  8. cwd or permission_mode is in the payload and missing from the line (replay cannot tell why a guard decided).
 *  9. target is missing for a non-command tool (Read/Edit/Write file_path, Agent subagent_type, Skill skill),
 *     or a Bash call picks up a stray file_path.
 * 10. `agent` is not a boolean: false with no agent, true from the payload or from CLAUDE_AGENT_ID.
 * 11. cwd or target is unbounded, or a non-string value is written, or a path segment that looks like an id
 *     (a UUID directory) is erased. These are paths: replay needs them exact, so they are cut, not masked.
 * 12. Dropping the new fields changes the old shape: command stays 80 chars, agent_id stays absent without an agent.
 * 13. The file is not owner-only (POSIX only: Windows ignores the mode).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logGuardDecision, maskSecrets, commandHead, guardLogPath, COMMAND_HEAD_CHARS } from '../shared/guard-log.js';
import { decide } from '../destructive-command-guard.js';

/**
 * Credential-shaped fixtures are joined at runtime so no secret-looking literal sits in this file
 * (secret scanners flag literals). The joined values keep the shapes the masks must catch.
 */
const j = (...parts: string[]): string => parts.join('');
const PW = j('hun', 'ter2');
const PW_SPACED = j('hun', 'ter two');
const SECRET_WORD = j('S3', 'cret');

let dir: string;
let log: string;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ CCV3_GUARD_DECISIONS_LOG: log, ...extra });
const lines = (): Array<Record<string, unknown>> =>
  readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-log-'));
  log = join(dir, 'guard-decisions.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('logGuardDecision: line shape', () => {
  it('appends one JSON object per call with ts, hook, tool, decision, reason, session_id', () => {
    logGuardDecision('destructive-command-guard', { tool_name: 'Bash', session_id: 's1' }, 'deny', 'rm -rf', { env: env() });
    logGuardDecision('package-install-guard', { tool_name: 'PowerShell', session_id: 's2' }, 'ask', 'unpinned', { env: env() });
    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hook: 'destructive-command-guard', tool: 'Bash', decision: 'deny', reason: 'rm -rf', session_id: 's1' });
    expect(new Date(rows[0].ts as string).toISOString()).toBe(rows[0].ts);
    expect(rows[1]).toMatchObject({ hook: 'package-install-guard', tool: 'PowerShell', decision: 'ask' });
    expect('agent_id' in rows[0]).toBe(false);
  });

  it('records agent_id from the payload, and from CLAUDE_AGENT_ID when the payload has none', () => {
    logGuardDecision('h', { tool_name: 'Bash', session_id: 's', agent_id: 'sub-1' }, 'deny', 'r', { env: env() });
    logGuardDecision('h', { tool_name: 'Bash', session_id: 's' }, 'deny', 'r', { env: env({ CLAUDE_AGENT_ID: 'env-2' }) });
    expect(lines().map((r) => r.agent_id)).toEqual(['sub-1', 'env-2']);
  });
});

describe('secrets never reach the log', () => {
  const SECRETS = [
    j('sk-', 'ant-api03-', 'abcdefghijklmnop'),
    j('gh', 'p_', 'abcdefghijklmnopqrstuvwx'),
    j('github_', 'pat_', '11ABCDEFG0abcdefgh'),
    j('xo', 'xb-', '1234-abcd-efgh'),
    j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    j('ey', 'JhbGciOiJIUzI1.', 'eyJzdWIiOiIxMjM0.', 'SflKxwRJSMeKKF2QT4'),
    j('0123456789abcdef', '0123456789abcdef', '0123'),
  ];
  it.each(SECRETS)('masks token shape %s', (secret) => {
    expect(maskSecrets(`curl -s https://x.test/${'a'} --data ${secret} end`)).not.toContain(secret);
  });

  it.each([
    ['key=value', `API_KEY=${j('hunter2', 'hunter2')} node run.js`, j('hunter2', 'hunter2')],
    ['quoted value', 'export TOKEN="my secret value" && go', 'my secret value'],
    ['flag value', `tool --api-key ${j('s3cr3t', 'value')} --other 1`, j('s3cr3t', 'value')],
    ['header', `curl -H x-api-key:${j('SECRET-', 'PROBE-123')} https://a.test`, j('SECRET-', 'PROBE-123')],
    ['bearer', 'curl -H "Authorization: Bearer abc.def.ghi" u', 'abc.def.ghi'],
    ['url password', `git clone https://bob:${j('p4ss', 'w0rd')}@host.test/r.git`, j('p4ss', 'w0rd')],
    ['curl -u user:pass', `curl -u admin:${PW} https://a.test/x`, PW],
    ['curl --user user:pass', `curl --user admin:${PW} https://a.test/x`, PW],
    ['curl -u with a quoted pair', `curl -u "admin:${PW}" https://a.test/x`, PW],
    ['mysql attached -p', `mysql -uroot -p${SECRET_WORD} -e "DROP DATABASE x"`, SECRET_WORD],
    ['mariadb attached -p', `mariadb -h db -u root -p${SECRET_WORD} mydb`, SECRET_WORD],
    ['mysqldump attached -p', `mysqldump -uroot -p${SECRET_WORD} --all-databases`, SECRET_WORD],
    ['sshpass -p', 'sshpass -p pw ssh host rm -rf /x', ' pw '],
    ['sshpass -p quoted', "sshpass -p 'pw 2' ssh host", 'pw 2'],
  ])('masks %s', (_n, cmd, secret) => {
    expect(maskSecrets(cmd)).not.toContain(secret);
  });

  // A password with a space inside quotes is ONE credential. Masking only its first word leaks the rest.
  it.each([
    ['curl -u, double quotes', `curl -u "admin:${PW_SPACED}" https://a.test/x`, 'curl -u "admin:***" https://a.test/x'],
    ['curl -u, single quotes', `curl -u 'admin:${PW_SPACED}' https://a.test/x`, "curl -u 'admin:***' https://a.test/x"],
    ['curl --user, double quotes', `curl --user "admin:${PW_SPACED}" https://a.test/x`, 'curl --user "admin:***" https://a.test/x'],
    ['curl -u, quoted password after a bare user', `curl -u admin:"${PW_SPACED}" https://a.test/x`, 'curl -u admin:*** https://a.test/x'],
    ['curl -u, single-quoted password after a bare user', `curl -u admin:'${PW_SPACED}' https://a.test/x`, 'curl -u admin:*** https://a.test/x'],
    ['mysql -p, double quotes', `mysql -uroot -p"${PW_SPACED}" -e "select 1"`, 'mysql -uroot -p*** -e "select 1"'],
    ['mysql -p, single quotes', `mysql -uroot -p'${PW_SPACED}' -e "select 1"`, 'mysql -uroot -p*** -e "select 1"'],
    ['sshpass -p, double quotes', `sshpass -p "${PW_SPACED}" ssh host ls`, 'sshpass -p *** ssh host ls'],
    ['sshpass -p, single quotes', `sshpass -p '${PW_SPACED}' ssh host ls`, 'sshpass -p *** ssh host ls'],
    ['sshpass -p, glued double quotes', `sshpass -p"${PW_SPACED}" ssh host ls`, 'sshpass -p*** ssh host ls'],
    ['URL password, double-quoted URL', `git clone "https://bob:${PW_SPACED}@host.test/r.git"`, 'git clone "https://***@host.test/r.git"'],
    ['URL password, single-quoted URL', `git clone 'https://bob:${PW_SPACED}@host.test/r.git'`, "git clone 'https://***@host.test/r.git'"],
  ])('masks the whole quoted credential: %s', (_n, cmd, masked) => {
    const out = maskSecrets(cmd);
    expect(out).not.toContain('ter two');
    expect(out).not.toContain('two');
    expect(out).toBe(masked);
  });

  it('keeps plain commands readable', () => {
    expect(maskSecrets('rm -rf /home/testuser/build')).toBe('rm -rf /home/testuser/build');
  });

  it('keeps the user name and the command shape when it masks a password', () => {
    expect(maskSecrets(`curl -u admin:${PW} https://a.test/x`)).toBe('curl -u admin:*** https://a.test/x');
    expect(maskSecrets(`mysql -uroot -p${SECRET_WORD} -e "select 1"`)).toBe('mysql -uroot -p*** -e "select 1"');
    expect(maskSecrets('sshpass -p pw ssh host ls')).toBe('sshpass -p *** ssh host ls');
  });

  it('does not touch -p or -u that belong to other tools', () => {
    expect(maskSecrets('mkdir -p build/out')).toBe('mkdir -p build/out');
    expect(maskSecrets('git push -u origin main')).toBe('git push -u origin main');
    expect(maskSecrets('docker run -p 8080:80 -u 1000:1000 img')).toBe('docker run -p 8080:80 -u 1000:1000 img');
    expect(maskSecrets('ssh -p 2222 host')).toBe('ssh -p 2222 host');
  });

  it('masks BEFORE the 80-char cut, so a secret across char 80 leaks no head', () => {
    const secret = j('sk-', 'ant-api03-', 'ZZZZYYYYXXXXWWWW');
    const cmd = `${'x'.repeat(COMMAND_HEAD_CHARS - 8)} ${secret}`; // secret starts ~8 chars before the cut
    const head = commandHead(cmd);
    expect(head.length).toBeLessThanOrEqual(COMMAND_HEAD_CHARS);
    expect(head).not.toContain('sk-ant');
    expect(head).not.toContain('ZZZZ');
  });

  it('writes a masked, 80-char command and a masked reason to the file', () => {
    const urlPw = j('topsecret', 'pw');
    const reasonPw = j('oops', '1234');
    const cmd = `psql postgresql://u:${urlPw}@h/db -c "${'y'.repeat(200)}"`;
    logGuardDecision('h', { tool_name: 'Bash' }, 'deny', `password=${reasonPw}`, { env: env(), command: cmd });
    const raw = readFileSync(log, 'utf8');
    expect(raw).not.toContain(urlPw);
    expect(raw).not.toContain(reasonPw);
    expect((lines()[0].command as string).length).toBeLessThanOrEqual(COMMAND_HEAD_CHARS);
  });
});

describe('where it writes', () => {
  it('uses CCV3_GUARD_DECISIONS_LOG when set', () => {
    expect(guardLogPath({ CCV3_GUARD_DECISIONS_LOG: '/tmp/x.jsonl' })).toBe('/tmp/x.jsonl');
  });

  it('resolves the default path from the env it is given, not the process home', () => {
    expect(guardLogPath({ USERPROFILE: dir })).toBe(join(dir, '.claude', 'logs', 'guard-decisions.jsonl'));
    expect(guardLogPath({ HOME: dir })).toBe(join(dir, '.claude', 'logs', 'guard-decisions.jsonl'));
  });

  it('writes nothing under VITEST when no override is set (a test never touches the real log)', () => {
    // CCV3_GUARD_DECISIONS_LOG is deliberately NOT in this env. The env home is a temp dir, so a
    // broken shouldWrite would put the line under dir/.claude, where this test sees it.
    logGuardDecision('h', { tool_name: 'Bash' }, 'deny', 'r', { env: { VITEST: 'true', HOME: dir, USERPROFILE: dir } });
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  it('never throws when the log path cannot be written', () => {
    const asDir = join(dir, 'is-a-dir');
    mkdirSync(asDir);
    expect(() => logGuardDecision('h', { tool_name: 'Bash' }, 'deny', 'r', { env: { CCV3_GUARD_DECISIONS_LOG: asDir } })).not.toThrow();
  });
});

describe('destructive guard reports an override', () => {
  const input = { tool_name: 'Bash', permission_mode: 'bypassPermissions' };

  it('flags override with the matched rule when the SKIP prefix lets a destructive command through', () => {
    const d = decide('SKIP_DESTRUCTIVE_GUARD=1 rm -rf build', input, {});
    expect(d.decision).toBe('allow');
    expect(d.override).toBe(true);
    expect(d.pattern).toBeTruthy();
  });

  it('flags the env-var form and the PowerShell form too', () => {
    expect(decide('rm -rf build', input, { SKIP_DESTRUCTIVE_GUARD: '1' }).override).toBe(true);
    expect(decide("$env:SKIP_DESTRUCTIVE_GUARD='1'; git reset --hard x", { tool_name: 'PowerShell' }, {}).override).toBe(true);
  });

  it('does not flag an override when the command was harmless anyway', () => {
    const d = decide('SKIP_DESTRUCTIVE_GUARD=1 ls -la', input, {});
    expect(d.decision).toBe('allow');
    expect(d.override).toBeUndefined();
  });

  it('does not flag an ordinary deny', () => {
    expect(decide('rm -rf build', input, {}).override).toBeUndefined();
  });
});

describe('replay fields: cwd, permission_mode, target, agent', () => {
  const row = (input: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}, opts: { command?: string } = {}) => {
    logGuardDecision('h', { tool_name: 'Bash', session_id: 's', ...input }, 'deny', 'r', { env: env(extraEnv), ...opts });
    return lines().pop() as Record<string, unknown>;
  };

  it('writes cwd and permission_mode from the payload', () => {
    const r = row({ cwd: 'C:\\work\\repo', permission_mode: 'bypassPermissions' });
    expect(r.cwd).toBe('C:\\work\\repo');
    expect(r.permission_mode).toBe('bypassPermissions');
  });

  it('leaves cwd, permission_mode and target out of the line when the payload has none', () => {
    const r = row({});
    expect('cwd' in r).toBe(false);
    expect('permission_mode' in r).toBe(false);
    expect('target' in r).toBe(false);
  });

  it.each([
    ['Read', { file_path: '/a/b.ts' }, '/a/b.ts'],
    ['Edit', { file_path: '/a/c.ts', old_string: 'x', new_string: 'y' }, '/a/c.ts'],
    ['Write', { file_path: '/a/d.ts', content: 'z' }, '/a/d.ts'],
    ['Agent', { subagent_type: 'scout', prompt: 'p' }, 'scout'],
    ['Skill', { skill: 'databases' }, 'databases'],
  ])('derives target from tool_input for %s', (tool, tool_input, target) => {
    expect(row({ tool_name: tool, tool_input }).target).toBe(target);
  });

  it('an explicit input.target wins over the derived one', () => {
    expect(row({ tool_name: 'Read', tool_input: { file_path: '/a' }, target: '/explicit' }).target).toBe('/explicit');
  });

  it('a Bash call gets no target, even when tool_input carries a file_path', () => {
    const r = row({ tool_name: 'Bash', tool_input: { command: 'ls', file_path: '/stray' } });
    expect('target' in r).toBe(false);
  });

  it('agent is false with no agent, true from the payload agent_id, true from CLAUDE_AGENT_ID', () => {
    expect(row({}).agent).toBe(false);
    expect(row({ agent_id: 'sub-1' }).agent).toBe(true);
    expect(row({}, { CLAUDE_AGENT_ID: 'env-2' }).agent).toBe(true);
  });

  it('cuts a long cwd and a long target; the bound is 300 characters', () => {
    const r = row({ tool_name: 'Read', cwd: `/${'c'.repeat(1000)}`, tool_input: { file_path: `/${'f'.repeat(1000)}` } });
    expect((r.cwd as string).length).toBe(300);
    expect((r.target as string).length).toBe(300);
  });

  it('ignores a non-string cwd, permission_mode and target', () => {
    const r = row({ cwd: { a: 1 }, permission_mode: 7, tool_name: 'Read', tool_input: { file_path: ['x'] } });
    expect('cwd' in r).toBe(false);
    expect('permission_mode' in r).toBe(false);
    expect('target' in r).toBe(false);
  });

  it('keeps a UUID directory name in cwd and target (paths are cut, not masked)', () => {
    // Letters and digits: the generic long-token mask would erase this name if pathText ran maskSecrets.
    const uuid = 'd11fb964-286c-483c-a5fc-7d6c40bcbb40';
    const r = row({ tool_name: 'Read', cwd: `/tmp/${uuid}/scratchpad`, tool_input: { file_path: `/tmp/${uuid}/f.txt` } });
    expect(r.cwd).toBe(`/tmp/${uuid}/scratchpad`);
    expect(r.target).toBe(`/tmp/${uuid}/f.txt`);
  });

  it('still cuts command at 80 characters and writes no agent_id without an agent', () => {
    const r = row({ cwd: '/x' }, {}, { command: 'z'.repeat(500) });
    expect((r.command as string).length).toBe(COMMAND_HEAD_CHARS);
    expect('agent_id' in r).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the log owner-only (0o600)', () => {
    row({});
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });
});
