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
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
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
    expect(maskSecrets('rm -rf ~/build')).toBe('rm -rf ~/build');
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
