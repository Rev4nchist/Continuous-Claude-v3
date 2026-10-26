/**
 * pr-opened-review-loop -- unit + dist-integration tests.
 *
 * Covers: gh pr create success fires; gh api POST pulls success fires; a GET
 * pulls call never fires; a failed create never fires; a second fire for the
 * same PR URL within a session is suppressed; pre-rename state files still
 * suppress repeats and are migrated on the next write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  alreadyFired,
  buildContext,
  extractPrInfo,
  isPrOpenCommand,
  legacyStatePath,
  markFired,
  responseText,
  statePath,
} from '../pr-opened-review-loop';

const HOOK = resolve(__dirname, '../../dist/pr-opened-review-loop.mjs');

function sessionId(): string {
  return `prlooptest-${Math.random().toString(36).slice(2)}`;
}

function statePathFor(sid: string): string {
  return join(tmpdir(), `pr-opened-review-loop-${sid}.json`);
}

function runHook(input: Record<string, unknown> | string): { stdout: string; status: number | null } {
  const res = spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: res.stdout.trim(), status: res.status };
}

describe('pr-opened-review-loop classifiers (unit)', () => {
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

  // P3b: only the collection endpoint opens a PR. Reply and review POSTs share the /pulls prefix.
  it('does not detect a thread-reply or review-comment POST under a pull', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5/comments/9/replies -X POST -f body=ok')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5/comments -X POST -f body=ok')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5/reviews -X POST -f event=COMMENT')).toBe(false);
  });

  it('detects a POST to the quoted, query-suffixed or end-of-string pulls collection', () => {
    expect(isPrOpenCommand('gh api "repos/o/r/pulls" --method POST -f title=x')).toBe(true);
    expect(isPrOpenCommand("gh api 'repos/o/r/pulls' -X POST")).toBe(true);
    expect(isPrOpenCommand('gh api repos/o/r/pulls?draft=true -X POST')).toBe(true);
    expect(isPrOpenCommand('gh api -X POST repos/o/r/pulls')).toBe(true);
  });

  it('does not detect a longer path that only starts with pulls', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pullsfoo -X POST')).toBe(false);
  });

  // Critic round: every spelling gh accepts for the method, a trailing slash, and gh's default POST when fields are given.
  it('detects every spelling of the POST method', () => {
    for (const method of ['-X POST', '-XPOST', '--method POST', '--method=POST', '-X post']) {
      expect(isPrOpenCommand(`gh api repos/o/r/pulls ${method} -f title=x`), method).toBe(true);
    }
  });

  it('detects the pulls collection with a trailing slash', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls/ -X POST -f title=x')).toBe(true);
    expect(isPrOpenCommand('gh api "repos/o/r/pulls/" --method=POST')).toBe(true);
  });

  it('treats fields with no method as a POST, because gh defaults to POST then', () => {
    for (const flag of ['-f title=x', '-F draft=true', '--raw-field title=x', '--field draft=true', '--input body.json', '-ftitle=x']) {
      expect(isPrOpenCommand(`gh api repos/o/r/pulls ${flag}`), flag).toBe(true);
    }
  });

  it('does not read flags from a pipe or a chained command as gh fields (a PR list is not a PR open)', () => {
    const lists = [
      'gh api repos/o/r/pulls | ConvertFrom-Json | Select-Object -First 1',
      'gh api repos/o/r/pulls | Where-Object -FilterScript { $_.draft }',
      'gh api repos/o/r/pulls | grep -F "html_url"',
      'gh api repos/o/r/pulls; Get-ChildItem -Force x',
      'gh api repos/o/r/pulls && echo -f=1',
    ];
    for (const cmd of lists) expect(isPrOpenCommand(cmd), cmd).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls -F "body=@pr.md" | ConvertFrom-Json'), 'a real field before the pipe still counts').toBe(true);
  });

  it('does not treat fields as a POST when the method is GET', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls -X GET -f state=open')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls --method=GET -F per_page=5')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls --method GET --field state=open')).toBe(false);
  });

  it('does not treat a longer path or a non-POST method as a PR open', () => {
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5 -f state=closed')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls/5/comments -f body=ok')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls -X PATCH -f title=x')).toBe(false);
    expect(isPrOpenCommand('gh api repos/o/r/pulls')).toBe(false);
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
    // The rule file it points at must exist under that name (renamed from pr-coderabbit-loop.md).
    expect(ctx).toContain('rules-ondemand/pr-review-loop.md');
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

describe('pr-opened-review-loop (dist integration)', () => {
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

  it('honours pre-rename state: a URL in the legacy file does not fire again', () => {
    const url = 'https://github.com/acme/widgets/pull/42';
    writeFileSync(legacyStatePath(sid), JSON.stringify([url]), 'utf8');
    const { stdout } = runHook({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat" --body "body"' },
      tool_response: { stdout: `${url}\n`, exit_code: 0 },
    });
    expect(stdout).toBe('{}');
    rmSync(legacyStatePath(sid), { force: true });
  });
});

// Rename migration (PR #154 review): sessions open across the rename keep
// their dedup state in the pre-rename file name.
describe('pr-opened-review-loop legacy state migration (unit)', () => {
  const URL_A = 'https://github.com/acme/widgets/pull/1';
  const URL_B = 'https://github.com/acme/widgets/pull/2';
  let sid: string;

  beforeEach(() => {
    sid = sessionId();
  });

  afterEach(() => {
    rmSync(statePath(sid), { force: true });
    rmSync(legacyStatePath(sid), { force: true });
  });

  it('legacy file name is the pre-rename prefix', () => {
    expect(legacyStatePath(sid)).toBe(join(tmpdir(), `pr-opened-coderabbit-loop-${sid}.json`));
    expect(statePath(sid)).toBe(statePathFor(sid));
  });

  it('legacy only: a URL seen there counts as fired', () => {
    writeFileSync(legacyStatePath(sid), JSON.stringify([URL_A]), 'utf8');
    expect(alreadyFired(sid, URL_A)).toBe(true);
    expect(alreadyFired(sid, URL_B)).toBe(false);
  });

  it('new only: a URL seen there counts as fired', () => {
    writeFileSync(statePath(sid), JSON.stringify([URL_A]), 'utf8');
    expect(alreadyFired(sid, URL_A)).toBe(true);
  });

  it('both files: a URL in either one counts as fired', () => {
    writeFileSync(statePath(sid), JSON.stringify([URL_A]), 'utf8');
    writeFileSync(legacyStatePath(sid), JSON.stringify([URL_B]), 'utf8');
    expect(alreadyFired(sid, URL_A)).toBe(true);
    expect(alreadyFired(sid, URL_B)).toBe(true);
  });

  it('neither file: nothing has fired', () => {
    expect(alreadyFired(sid, URL_A)).toBe(false);
  });

  it('markFired merges legacy URLs into the new file and deletes the legacy file', () => {
    writeFileSync(legacyStatePath(sid), JSON.stringify([URL_A]), 'utf8');
    markFired(sid, URL_B);
    const seen = JSON.parse(readFileSync(statePath(sid), 'utf8'));
    expect(seen).toEqual(expect.arrayContaining([URL_A, URL_B]));
    expect(existsSync(legacyStatePath(sid))).toBe(false);
    expect(alreadyFired(sid, URL_A)).toBe(true);
  });

  it('a corrupt legacy file is ignored, not fatal', () => {
    writeFileSync(legacyStatePath(sid), 'not json', 'utf8');
    expect(alreadyFired(sid, URL_A)).toBe(false);
    markFired(sid, URL_A);
    expect(alreadyFired(sid, URL_A)).toBe(true);
  });
});
