// Tests for reply-thread.mjs. Run: node --test scripts/github/reply-thread.test.mjs
// No network: gh is an injected runner and the body file is an injected reader.
//
// Why this helper exists: 14 review-thread replies on PRs #225, #227 and #238 read
// "System.Collections.Hashtable[<id>]" or "System.Collections.Hashtable.body". The agent typed
// `gh api ... -f body=$replies[$id]` in PowerShell. An unquoted native argument expands `$replies`
// to the hashtable's ToString() and keeps `[<id>]` as literal text. The helper takes the text from a
// file, so no shell variable reaches the body.
//
// How the helper can fail, and the test that catches it (written before the code):
//   the body goes on the command line (-f body=<text>) instead of -F body=@<file>      -> RT1
//   the call goes to the wrong endpoint or method                                      -> RT1
//   a garbled "System.Collections.Hashtable..." body is posted                         -> RT2
//   an empty body or an unreadable file is posted                                      -> RT3
//   a bad PR number, comment id, unknown flag or missing --body-file is accepted        -> RT4
//   a gh failure prints a success line or exits 0                                      -> RT5
//   the success line is missing the id or the URL the caller needs                     -> RT6
//   a real process run with no arguments does not exit 2                               -> RT7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RT from './reply-thread.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = ['225', '4425309812', '--body-file', 'C:\\tmp\\reply.md'];

/** Fake deps: records every gh call; `files` maps path -> text. */
function fakes({ files = { 'C:\\tmp\\reply.md': 'Fixed in eb370b2e: it now checks both.\n' }, gh } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  return {
    calls,
    out,
    err,
    deps: {
      runGh: (args) => {
        calls.push(args);
        if (gh) return gh(args);
        return JSON.stringify({ id: 777, html_url: 'https://github.com/o/r/pull/225#discussion_r777' });
      },
      readFile: (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    },
  };
}

test('RT1: the body travels as -F body=@<file>, to the replies endpoint, by POST', () => {
  const f = fakes();
  assert.equal(RT.main(ARGV, f.deps), 0);
  assert.equal(f.calls.length, 1);
  const a = f.calls[0];
  assert.equal(a[0], 'api');
  assert.ok(a.includes('repos/Rev4nchist/Continuous-Claude-v3/pulls/225/comments/4425309812/replies'));
  assert.equal(a[a.indexOf('-X') + 1], 'POST');
  assert.equal(a[a.indexOf('-F') + 1], 'body=@C:\\tmp\\reply.md');
  assert.ok(!a.includes('-f'), 'no -f: the text never goes on the command line');
  assert.ok(!a.some((x) => x.includes('Fixed in')), 'the reply text is not an argument');
});

test('RT1b: --repo overrides the default repository', () => {
  const f = fakes();
  RT.main([...ARGV, '--repo', 'a/b'], f.deps);
  assert.ok(f.calls[0].includes('repos/a/b/pulls/225/comments/4425309812/replies'));
});

test('RT2: a garbled PowerShell hashtable body is refused and nothing is posted', () => {
  for (const bad of [
    'System.Collections.Hashtable[4424706285]',
    'System.Collections.Hashtable.body',
    '  System.Collections.Hashtable\n',
    'System.Collections.Generic.Dictionary`2[System.String,System.String][1]',
  ]) {
    const f = fakes({ files: { 'C:\\tmp\\reply.md': bad } });
    assert.equal(RT.main(ARGV, f.deps), 1, bad);
    assert.equal(f.calls.length, 0, 'gh must not run');
    assert.match(f.err.join(''), /hashtable|garbled/i);
  }
});

test('RT2b: the garbled type name is refused anywhere in the text, e.g. an interpolated string "Fixed in abc: $h.body"', () => {
  for (const bad of [
    'Fixed in abc1234: System.Collections.Hashtable.body',
    'Fixed in abc1234: the old text read System.Collections.Hashtable.\n',
    'Done.\nSystem.Management.Automation.PSCustomObject\n',
  ]) {
    const f = fakes({ files: { 'C:\\tmp\\reply.md': bad } });
    assert.equal(RT.main(ARGV, f.deps), 1, bad);
    assert.equal(f.calls.length, 0, 'gh must not run');
  }
});

test('RT2c: a real reply that names a hashtable without the System. type path is allowed', () => {
  const f = fakes({ files: { 'C:\\tmp\\reply.md': 'Fixed in abc1234: the replies map is now a plain object, not a Hashtable.\n' } });
  assert.equal(RT.main(ARGV, f.deps), 0);
});

test('RT3: an empty body or an unreadable file is refused and nothing is posted', () => {
  for (const files of [{ 'C:\\tmp\\reply.md': '' }, { 'C:\\tmp\\reply.md': ' \r\n\t\n' }, {}]) {
    const f = fakes({ files });
    assert.equal(RT.main(ARGV, f.deps), 1);
    assert.equal(f.calls.length, 0);
    assert.ok(f.err.join('').length > 0);
  }
});

test('RT4: bad arguments exit 2 and post nothing', () => {
  const bad = [
    [],
    ['225', '9'],
    ['x', '9', '--body-file', 'f'],
    ['225', 'y', '--body-file', 'f'],
    ['0', '9', '--body-file', 'f'],
    ['225', '9', '--body-file'],
    ['225', '9', '--body', 'inline text'],
    ['225', '9', '--body-file', 'f', '--repo'],
    ['225', '9', '--body-file', 'f', '--nope'],
    ['225', '9', '10', '--body-file', 'f'],
  ];
  for (const argv of bad) {
    const f = fakes({ files: { f: 'ok' } });
    assert.equal(RT.main(argv, f.deps), 2, JSON.stringify(argv));
    assert.equal(f.calls.length, 0);
    assert.match(f.err.join(''), /usage|unknown|invalid/i);
  }
});

test('RT5: a gh failure exits 1, names the cause, and prints no success line', () => {
  const f = fakes({
    gh: () => {
      throw new Error('gh: Not Found (HTTP 404)');
    },
  });
  assert.equal(RT.main(ARGV, f.deps), 1);
  assert.equal(f.out.join(''), '');
  assert.match(f.err.join(''), /404/);
});

test('RT5b: a gh reply that is not JSON or has no id exits 1', () => {
  for (const reply of ['', 'not json', '{}', '{"message":"Validation Failed"}']) {
    const f = fakes({ gh: () => reply });
    assert.equal(RT.main(ARGV, f.deps), 1, reply);
    assert.equal(f.out.join(''), '');
  }
});

test('RT6: success prints one line with the new comment id and URL', () => {
  const f = fakes();
  assert.equal(RT.main(ARGV, f.deps), 0);
  assert.equal(f.out.join(''), 'replied 777 https://github.com/o/r/pull/225#discussion_r777\n');
});

test('RT7: a real process with no arguments exits 2 with a usage line', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'reply-thread.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});
