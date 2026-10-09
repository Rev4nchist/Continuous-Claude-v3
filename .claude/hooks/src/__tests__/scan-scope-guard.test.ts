/**
 * scan-scope-guard: a direct active-scanner call is denied; everything else passes.
 *
 * One test per way the executable can hide: plain, chained, path-qualified,
 * Windows .exe, env-var prefix, quoted. Plus the must-not-block cases: the
 * wrapper itself, benign commands, and dual-use nmap.
 */
import { describe, it, expect } from 'vitest';
import { leadingExe, blockedTool, segmentize, BLOCKED } from '../scan-scope-guard.js';

describe('leadingExe', () => {
  it('reads a bare command', () => expect(leadingExe('nuclei -u http://x')).toBe('nuclei'));
  it('strips a unix path', () => expect(leadingExe('/usr/bin/sqlmap -u x')).toBe('sqlmap'));
  it('strips a windows path and .exe', () => expect(leadingExe('C:\\tools\\nuclei.exe -u x')).toBe('nuclei'));
  it('drops env-var prefixes', () => expect(leadingExe('FOO=bar nuclei -u x')).toBe('nuclei'));
  it('keeps a .py suffix', () => expect(leadingExe('zap-baseline.py -t x')).toBe('zap-baseline.py'));
  it('reads a quoted executable', () => expect(leadingExe('"C:\\a b\\nikto.exe" -h x')).toBe('nikto'));
  it('returns empty on empty input', () => expect(leadingExe('   ')).toBe(''));
});

describe('blockedTool', () => {
  it('blocks a plain scanner', () => expect(blockedTool('nuclei -u http://x')).toBe('nuclei'));
  it('blocks a scanner after a chain', () => expect(blockedTool('cd web && sqlmap -u http://x')).toBe('sqlmap'));
  it('blocks a scanner after a pipe', () => expect(blockedTool('echo x | nikto -h http://x')).toBe('nikto'));
  it('blocks zap-baseline.py', () => expect(blockedTool('zap-baseline.py -t http://x')).toBe('zap-baseline.py'));
  it('blocks masscan and wpscan and dalfox', () => {
    expect(blockedTool('masscan 10.0.0.0/8')).toBe('masscan');
    expect(blockedTool('wpscan --url http://x')).toBe('wpscan');
    expect(blockedTool('dalfox url http://x')).toBe('dalfox');
  });

  it('allows the sanctioned wrapper', () =>
    expect(blockedTool('node scripts/security/scoped-scan.mjs web http://localhost:3000')).toBeNull());
  it('allows benign commands', () => {
    expect(blockedTool('npm audit')).toBeNull();
    expect(blockedTool('git status')).toBeNull();
    expect(blockedTool('ls -la')).toBeNull();
  });
  it('does not block dual-use nmap', () => expect(blockedTool('nmap -sV localhost')).toBeNull());
  it('does not block a substring match', () => expect(blockedTool('nucleitool --help')).toBeNull());

  // Windows backslash path must survive (the Bash classifier turned \t into a tab).
  it('blocks a windows .exe path', () => expect(blockedTool('C:\\tools\\sqlmap.exe -u http://x')).toBe('sqlmap'));
  it('blocks inside command substitution', () => expect(blockedTool('echo $(nuclei -u http://x)')).toBe('nuclei'));
  it('blocks inside backticks', () => expect(blockedTool('x=`nikto -h http://x`')).toBe('nikto'));
});

describe('BLOCKED set', () => {
  it('is non-empty and all lowercase', () => {
    expect(BLOCKED.size).toBeGreaterThan(0);
    for (const t of BLOCKED) expect(t).toBe(t.toLowerCase());
  });
});
