/**
 * pr-opened-coderabbit-loop -- unit + dist-integration tests.
 *
 * Covers: gh pr create success fires; gh api POST pulls success fires; a GET
 * pulls call never fires; a failed create never fires; a second fire for the
 * same PR URL within a session is suppressed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  buildContext,
  extractPrInfo,
  isPrOpenCommand,
  responseText,
} from '../pr-opened-coderabbit-loop';

const HOOK = resolve(__dirname, '../../dist/pr-opened-coderabbit-loop.mjs');

function sessionId(): string {
  return `prlooptest-${Math.random().toString(36).slice(2)}`;
}

function statePathFor(sid: string): string {
  return join(tmpdir(), `pr-opened-coderabbit-loop-${sid}.json`);
}

function runHook(input: Record<string, unknown> | string): { stdout: string; status: number | null } {
  const res = spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

describe('pr-opened-coderabbit-loop classifiers (unit)', () => {
  it('detects gh pr create', () => {
    expect(isPrOpenCommand('gh pr create --title "x" --body "y"')).toBe(true);
  });

  it('detects gh api POST to a pulls endpoint', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls -X POST -f title=x -f head=a -f base=main')).toBe(
      true,
    );
    expect(
      isPrOpenCommand('gh api repos/o/r/pulls --method POST -f title=x -f head=a -f base=main'),
    ).toBe(true);
  });

  it('does not detect a GET to a pulls endpoint', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5')).toBe(false);
  });

  it('does not detect unrelated gh api calls', () => {
    expect(isPrOpenCommand('gh api repos/o/r/issues -X POST -f title=x')).toBe(false);
  });

  it('extracts owner/repo/number/url from a PR URL', () => {
    const info = extractPrInfo('some text https://github.com/acme/widgets/pull/42 trailing');
    expect(info).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: '42',
      url: 'https://github.com/acme/widgets/pull/42',
    });
  });

  it('returns null when no PR URL is present', () => {
    expect(extractPrInfo('{"number": 42, "state": "open"}')).toBeNull();
  });

  it('extracts text from string and object responses', () => {
    expect(responseText('plain')).toBe('plain');
    expect(responseText({ stdout: 'a', stderr: 'b' })).toBe('a\nb');
    expect(responseText(null)).toBe('');
  });

  it('builds context naming the loop, owner/repo/number and the never-merge rule for another repo', () => {
    const ctx = buildContext({ owner: 'acme', repo: 'widgets', number: '42', url: 'https://github.com/acme/widgets/pull/42' });
    expect(ctx).toContain('PR OPENED: https://github.com/acme/widgets/pull/42');
    expect(ctx).toContain('/loop 5m');
    expect(ctx).toContain('acme/widgets PR #42');
    expect(ctx).toContain('never merge');
  });

  // A repo-less pr_watch watches Rev4nchist/Continuous-Claude-v3 only: naming it for another repo's PR would watch the wrong PR.
  it('for the CCv3 repo names pr_watch first with the PR number, and the loop only as the fallback', () => {
    const ctx = buildContext({ owner: 'Rev4nchist', repo: 'Continuous-Claude-v3', number: '107', url: 'https://github.com/Rev4nchist/Continuous-Claude-v3/pull/107' });
    expect(ctx).toContain('pr_watch');
    expect(ctx).toContain('pr: 107');
    expect(ctx.indexOf('pr_watch')).toBeLessThan(ctx.indexOf('/loop 5m'));
    expect(ctx).toMatch(/only if (that|the) tool (does not exist|is missing)/i);
    expect(ctx).toContain('never merge');
  });

  it('for another repo does not send the model to pr_watch', () => {
    const ctx = buildContext({ owner: 'acme', repo: 'widgets', number: '42', url: 'https://github.com/acme/widgets/pull/42' });
    expect(ctx).not.toContain('pr_watch');
  });
});

describe('pr-opened-coderabbit-loop (dist integration)', () => {
  let sid: string;

  beforeEach(() => {
    sid = sessionId();
  });

  afterEach(() => {
    const p = statePathFor(sid);
    if (existsSync(p)) rmSync(p, { force: true });
  });

  it('fires additionalContext for a successful gh pr create', () => {
    const { stdout, status } = runHook({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat" --body "body"' },
      tool_response: { stdout: 'https://github.com/acme/widgets/pull/42\n', exit_code: 0 },
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'PR OPENED: https://github.com/acme/widgets/pull/42',
    );
  });

  it('fires for a successful gh api POST to pulls with a number field', () => {
    const body = JSON.stringify({
      number: 7,
      html_url: 'https://github.com/acme/widgets/pull/7',
      state: 'open',
    });
    const { stdout } = runHook({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh api repos/acme/widgets/pulls -X POST -f title=x -f head=a -f base=main' },
      tool_response: { stdout: body, exit_code: 0 },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'PR OPENED: https://github.com/acme/widgets/pull/7',
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain('acme/widgets PR #7');
  });

  it('does not fire for a GET to a pulls endpoint', () => {
    const { stdout } = runHook({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh api repos/acme/widgets/pulls/7' },
      tool_response: { stdout: JSON.stringify({ number: 7, html_url: 'https://github.com/acme/widgets/pull/7' }), exit_code: 0 },
    });
    expect(stdout).toBe('{}');
  });

  it('does not fire for a failed gh pr create', () => {
    const { stdout } = runHook({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat" --body "body"' },
      tool_response: { stdout: '', stderr: 'error: pull request create failed', exit_code: 1 },
    });
    expect(stdout).toBe('{}');
  });

  it('suppresses a second fire for the same PR URL in the same session', () => {
    const input = {
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat" --body "body"' },
      tool_response: { stdout: 'https://github.com/acme/widgets/pull/42\n', exit_code: 0 },
    };
    const first = runHook(input);
    expect(JSON.parse(first.stdout).hookSpecificOutput).toBeDefined();
    const second = runHook(input);
    expect(second.stdout).toBe('{}');
  });

  it('ignores non-command tools', () => {
    const { stdout } = runHook({ session_id: sid, tool_name: 'Edit', tool_input: {} });
    expect(stdout).toBe('{}');
  });

  it('handles PowerShell as a command tool', () => {
    const { stdout } = runHook({
      session_id: sid,
      tool_name: 'PowerShell',
      tool_input: { command: 'gh pr create --title "feat" --body "body"' },
      tool_response: { stdout: 'https://github.com/acme/widgets/pull/99\n', exit_code: 0 },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('pull/99');
  });

  it('never crashes on malformed stdin', () => {
    const { stdout, status } = runHook('not json');
    expect(status).toBe(0);
    expect(stdout).toBe('{}');
  });
});
