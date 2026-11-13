// Tests for lib/repo-identity.mjs (card coord-decision-gate-app-repos, rule R5 and seat condition G2).
// Run: node --test scripts/github/repo-identity.test.mjs
// Pure functions: no file, no process, no env. The hook bundles this module (tap-scope.ts), and app-ask.mjs imports it.
//
// Failure modes, and the source change that turns a case red:
//   RI1 an https, scp or ssh:// GitHub remote gives no slug                    (drop one URL form)
//   RI2 the slug keeps its case or its .git, or a trailing slash breaks it     (remove toLowerCase or the .git strip)
//   RI3 a host that only looks like github.com gives a slug                    (host not anchored: github.com.evil.com, notgithub.com, user@ trick)
//   RI4 a URL with more or fewer path segments gives a slug                    (path not anchored at both ends)
//   RI5 empty, blank or non-text input throws or gives a slug                  (no type guard)
//   RI6 keyRepo does not fall back to local:<entry key>, or prefers the entry key over a slug
//   RI7 oneLine keeps a newline, a control or an invisible format character    (drop Cc, Cf, Zl or Zp from the class)
//   RI8 oneLine skips NFKC, so full-width letters pass as other text           (remove normalize)
//   RI9 oneLine keeps runs of spaces or edge spaces                            (remove the collapse or the trim)
//   RI10 oneLine clips past max, clips a short text, or cuts a surrogate pair  (clip by UTF-16 unit, or off by one)
//   RI11 the module starts a process                                           (a child_process import)
// Fix round 1, fixer C (ONE key rule for the gate and app-ask.mjs):
//   RI12 normPath folds /c/x, C:\x, c:/x/ differently, or loses // of a share   (a second normaliser, or one fold dropped)
//   RI13 a remote name with / reads as a URL                                    (the old /[:/\\]/ test)
//   RI14 the local: key drops the target, keeps a token, or a path takes the github field
//   RI15 @{push} split on the first /                                           (split('/')[0])
//   RI16 pushKey: a bare push ignores the @{push} branch, two pushurls pass, a URL remote or a name with / is misread
//   RI17 ghKey: keyed on the push URL, a named repo of another remote refused, the github field ignored
//   RI18 pushKey: configured is lost, or true for a typed URL or path (fixer E: the gate then reads a remote HEAD for a URL)
// Fix round 2, fixer G:
//   RI19 an https mirror on another host takes the github field (one tap licenses two repos)  (HOST_TAIL on any scheme)
//   RI20 sshTail reads a non-SSH URL or a path                                              (no scheme test)
//   RI21 the defaults of a push with no remote or branch differ from pushKey                (two rules)
// Fix round 3, fixer H:
//   RI22 an SSH form on a non-GitHub host (gitlab.com) takes the github field               (sshTail with no host test)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as identity from './lib/repo-identity.mjs';

const { ghKey, isUrlLike, keyRepo, normPath, oneLine, pushKey, pushRefOf, repoSlug } = identity;
// Fix round 2 (fixer G): read through the namespace, so a missing export fails its own rows only.
const sshTail = (...a) => identity.sshTail(...a);
const pushDefaults = (...a) => identity.pushDefaults(...a);

describe('repoSlug', () => {
  const good = [
    ['https://github.com/Acme/App.git', 'acme/app'],
    ['https://github.com/acme/app', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'],
    ['HTTPS://GITHUB.COM/Acme/My.App.GIT', 'acme/my.app'],
    ['http://github.com/acme/app', 'acme/app'],
    ['https://user@github.com/acme/app.git', 'acme/app'],
    ['https://x-access-token:abc@github.com/acme/app.git', 'acme/app'],
    ['git@github.com:Acme/App.git', 'acme/app'],
    ['git@GitHub.com:acme/app', 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'acme/app'],
    ['ssh://git@github.com:22/Acme/App', 'acme/app'],
    ['git://github.com/acme/app.git', 'acme/app'],
    ['  https://github.com/acme/app.git\n', 'acme/app'],
    ['https://github.com/Rev4nchist/Continuous-Claude-v3.git', 'rev4nchist/continuous-claude-v3'],
  ];
  for (const [url, slug] of good) it(`RI1/RI2 ${JSON.stringify(url)} -> ${slug}`, () => assert.equal(repoSlug(url), slug));

  const bad = [
    'https://gitlab.com/acme/app.git',
    'https://github.com.evil.com/acme/app',
    'https://notgithub.com/acme/app',
    'https://github.com@evil.com/acme/app',
    'https://evil.com/github.com/acme/app',
    'git@evil.com:acme/app.git',
    'git@github.com.evil.com:acme/app.git',
    'https://github.com/acme/app/tree/main',
    'https://github.com/acme',
    'https://github.com/acme/app.git/extra',
    'https://github.com/./app',
    'https://github.com/acme/..',
    'C:/Users/dkhay/Projects/app',
    '/srv/git/app.git',
    '',
    '   ',
    null,
    undefined,
    42,
  ];
  for (const url of bad) it(`RI3/RI4/RI5 ${JSON.stringify(url)} -> null`, () => assert.equal(repoSlug(url), null));
});

describe('keyRepo', () => {
  it('RI6 a GitHub remote gives its slug, whatever the entry key', () => {
    assert.equal(keyRepo({ url: 'git@github.com:Acme/App.git', entryKey: 'other' }), 'acme/app');
  });
  it('RI6 no remote URL gives local:<entry key>; a non-GitHub URL gives local:<entry key>:<target>', () => {
    assert.equal(keyRepo({ url: 'https://gitlab.com/acme/app.git', entryKey: 'my-app' }), 'local:my-app:https://gitlab.com/acme/app.git');
    assert.equal(keyRepo({ url: null, entryKey: 'my-app' }), 'local:my-app');
    assert.equal(keyRepo({ entryKey: 'my-app' }), 'local:my-app');
  });
  // Change that breaks it: drop the target from the local: key (one tap then licenses a push to any non-GitHub target).
  it('RI14 two non-GitHub targets of one entry give two keys; a path target is folded by normPath; credentials are dropped', () => {
    const a = keyRepo({ url: 'C:\\bak\\App.git', entryKey: 'app' });
    const b = keyRepo({ url: 'https://gitlab.com/x/y.git', entryKey: 'app' });
    assert.equal(a, 'local:app:c:/bak/app.git');
    assert.notEqual(a, b);
    assert.equal(keyRepo({ url: '/c/bak/App.git/', entryKey: 'app' }), a);
    assert.equal(keyRepo({ url: 'https://me:s3cret@gitlab.com/x/y.git', entryKey: 'app' }), b);
    assert.equal(/s3cret/.test(keyRepo({ url: 'https://me:s3cret@gitlab.com/x/y.git', entryKey: 'app' })), false);
  });
  // Change that breaks it: ignore the github field (an SSH host alias then keys as local: and app-ask refuses open-pr: a dead end, F5).
  it('RI14 an SSH host alias or ssh.github.com:443 whose owner/repo equals the github field of the entry keys as that repo', () => {
    assert.equal(keyRepo({ url: 'git@github-work:Acme/App.git', entryKey: 'app', github: 'Acme/App' }), 'acme/app');
    assert.equal(keyRepo({ url: 'ssh://git@ssh.github.com:443/acme/app.git', entryKey: 'app', github: 'acme/app' }), 'acme/app');
    assert.equal(keyRepo({ url: 'git@github-work:acme/other.git', entryKey: 'app', github: 'acme/app' }), 'local:app:github-work:acme/other.git');
  });
  // Change that breaks it: let a local path take the github field (a tap for acme/app then licenses a push to D:/acme/app.git).
  it('RI14 a local path never takes the github field, even when its last two parts match', () => {
    assert.equal(keyRepo({ url: 'D:/acme/app.git', entryKey: 'app', github: 'acme/app' }), 'local:app:d:/acme/app.git');
    assert.equal(keyRepo({ url: '/srv/acme/app', entryKey: 'app', github: 'acme/app' }), 'local:app:/srv/acme/app');
  });
  it('RI6 no slug and no entry key gives null, never "local:"', () => {
    assert.equal(keyRepo({ url: null, entryKey: '' }), null);
    assert.equal(keyRepo({ url: '/srv/x.git' }), null);
    assert.equal(keyRepo({ url: '/srv/x.git', entryKey: '   ' }), null);
  });
});

describe('oneLine', () => {
  it('RI7 newlines, CR, TAB, VT, FF, NEL and NUL become one space', () => {
    assert.equal(oneLine('feat/x\nREADY', 80), 'feat/x READY');
    assert.equal(oneLine('a\r\nb\tc\u000Bd\u000Ce\u0085f\u0000g', 80), 'a b c d e f g');
  });
  it('RI7 line and paragraph separators become a space', () => {
    assert.equal(oneLine('a\u2028b\u2029c', 80), 'a b c');
  });
  it('RI7 invisible format characters (zero width, bidi, BOM, soft hyphen) become a space', () => {
    assert.equal(oneLine('ma\u200Bin', 80), 'ma in');
    assert.equal(oneLine('\u202Eevil\u202C', 80), 'evil');
    assert.equal(oneLine('\uFEFFx\u00ADy\u2060z', 80), 'x y z');
  });
  it('RI8 NFKC folds full-width letters and compat spaces', () => {
    assert.equal(oneLine('\uFF32\uFF25\uFF21\uFF24\uFF39', 80), 'READY');
    assert.equal(oneLine('a\u3000b\u00A0c', 80), 'a b c');
  });
  it('RI9 runs of spaces become one and the edges are trimmed', () => {
    assert.equal(oneLine('   a    b  \n\n c   ', 80), 'a b c');
  });
  it('RI10 a text at max is kept whole; a longer one is clipped to max with the ellipsis', () => {
    assert.equal(oneLine('abcdef', 6), 'abcdef');
    assert.equal(oneLine('abcdefg', 6), 'abcde\u2026');
    assert.equal([...oneLine('x'.repeat(500), 60)].length, 60);
  });
  it('RI10 the clip counts code points and never cuts a surrogate pair', () => {
    const out = oneLine('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 3);
    assert.equal(out, '\u{1F600}\u{1F600}\u2026');
    assert.equal(/[\uD800-\uDFFF]/.test(out.replace(/\u{1F600}/gu, '')), false);
  });
  it('RI10 a space at the cut is not kept before the ellipsis', () => {
    assert.equal(oneLine('ab cdef', 4), 'ab\u2026');
  });
  it('RI5 null, undefined and numbers give text, never a throw', () => {
    assert.equal(oneLine(null, 10), '');
    assert.equal(oneLine(undefined, 10), '');
    assert.equal(oneLine(12345, 10), '12345');
  });
  it('RI10 a max that is not a whole number above 0 throws', () => {
    assert.throws(() => oneLine('a', 0), RangeError);
    assert.throws(() => oneLine('a', 2.5), RangeError);
    assert.throws(() => oneLine('a'), RangeError);
  });
});

describe('normPath (shared with tap-scope.ts)', () => {
  // Change that breaks it: a second normaliser in app-ask or tap-scope that skips one fold.
  it('RI12 /c/x, C:\\x and c:/x/ fold to one form; // and \\\\ stay a network path; the \\\\?\\ prefix goes', () => {
    for (const p of ['/c/Users/Me', 'C:\\Users\\Me', 'c:/users/me/', 'C:/Users//Me', '\\\\?\\C:\\Users\\Me']) assert.equal(normPath(p), 'c:/users/me', p);
    assert.equal(normPath('\\\\nas\\Share\\App'), '//nas/Share/App');
    assert.equal(normPath('//nas/Share/App/'), '//nas/Share/App');
    assert.equal(normPath('/srv/Mixed/'), '/srv/Mixed');
    assert.equal(normPath('/'), '/');
  });
});

describe('isUrlLike', () => {
  // Change that breaks it: the old /[:/\\]/ test (a remote named team/fork then reads as a URL, F5).
  it('RI13 a remote name, also one with a slash, is no URL; a URL, an scp form and a path are', () => {
    for (const name of ['origin', 'team/fork', 'up-stream', 'a.b']) assert.equal(isUrlLike(name), false, name);
    for (const url of ['https://github.com/a/b', 'git@github.com:a/b', 'host:a/b', '/srv/x.git', './x', '../x', '~/x', 'C:\\x', 'C:/x', 'file:///x', '\\\\nas\\x']) assert.equal(isUrlLike(url), true, url);
  });
});

/** A fake git: { remotes: { name: { url, push?: [urls] } }, pushRef?: 'refs/remotes/...', branch? }. Unknown args fail (status 1). */
function fakeGit(f) {
  const calls = [];
  const ok = (s) => ({ status: 0, stdout: `${s}\n` });
  const run = (args) => {
    const a = args.join(' ');
    calls.push(a);
    if (a === 'remote') return ok(Object.keys(f.remotes ?? {}).join('\n'));
    if (a === 'rev-parse --symbolic-full-name @{push}') return f.pushRef ? ok(f.pushRef) : { status: 128, stdout: '' };
    if (a === 'branch --show-current') return ok(f.branch ?? 'feat');
    const all = /^remote get-url --push --all (.+)$/.exec(a);
    if (all) { const r = f.remotes?.[all[1]]; return r ? ok((r.push ?? [r.url]).join('\n')) : { status: 2, stdout: '' }; }
    const one = /^remote get-url (.+)$/.exec(a);
    if (one) { const r = f.remotes?.[one[1]]; return r ? ok(r.url) : { status: 2, stdout: '' }; }
    return { status: 1, stdout: '' };
  };
  return Object.assign(run, { calls });
}
const GH = (slug) => ({ url: `https://github.com/${slug}.git` });

describe('pushRefOf', () => {
  // Change that breaks it: split('/')[0] (a remote named team/fork then reads as team, F5).
  it('RI15 the remote of @{push} is the longest remote name that prefixes the ref; the rest is the branch', () => {
    const git = fakeGit({ remotes: { team: GH('a/team'), 'team/fork': GH('a/fork') }, pushRef: 'refs/remotes/team/fork/feat/x' });
    assert.deepEqual(pushRefOf(git, ['team', 'team/fork']), { remote: 'team/fork', branch: 'feat/x' });
    assert.equal(pushRefOf(fakeGit({ remotes: {} }), []), null);
  });
});

describe('pushKey', () => {
  const base = { entryKey: 'app', github: null };
  it('RI16 a named remote keys by its push URL; the branch is the one given', () => {
    const git = fakeGit({ remotes: { up: { url: 'https://github.com/acme/app.git', push: ['https://github.com/me/app.git'] } } });
    assert.deepEqual(pushKey(git, { ...base, remote: 'up', branch: 'feat' }), { ok: true, key: 'me/app', remote: 'up', branch: 'feat', configured: true });
  });
  // Change that breaks it: key a bare push on the current branch (push.default=upstream then updates up/main on a tap for feat).
  it('RI16 a bare push keys on the branch of @{push} when its remote is the push remote; else on the current branch', () => {
    const git = fakeGit({ remotes: { up: GH('acme/app'), mirror: GH('acme/m') }, pushRef: 'refs/remotes/up/main', branch: 'feat' });
    assert.deepEqual(pushKey(git, { ...base, remote: null, branch: null }), { ok: true, key: 'acme/app', remote: 'up', branch: 'main', configured: true });
    assert.deepEqual(pushKey(git, { ...base, remote: 'up', branch: null }), { ok: true, key: 'acme/app', remote: 'up', branch: 'main', configured: true });
    assert.deepEqual(pushKey(git, { ...base, remote: 'mirror', branch: null }), { ok: true, key: 'acme/m', remote: 'mirror', branch: 'feat', configured: true });
  });
  // Change that breaks it: read only the first pushurl (git push then also updates a second repo with no tap for it).
  it('RI16 two push URLs of two repos are refused (one pushurl per tap); two of one repo are fine', () => {
    const two = fakeGit({ remotes: { up: { url: 'x', push: ['https://github.com/acme/a.git', 'https://github.com/acme/b.git'] } } });
    assert.deepEqual(pushKey(two, { ...base, remote: 'up', branch: 'feat' }), { ok: false, why: 'multi-pushurl', remote: 'up', keys: ['acme/a', 'acme/b'] });
    const same = fakeGit({ remotes: { up: { url: 'x', push: ['https://github.com/acme/a.git', 'git@github.com:Acme/A.git'] } } });
    assert.equal(pushKey(same, { ...base, remote: 'up', branch: 'feat' }).key, 'acme/a');
  });
  it('RI16 a URL that is no remote keys by that URL; a name that is no remote and no URL is refused', () => {
    const git = fakeGit({ remotes: { up: GH('acme/app') } });
    assert.equal(pushKey(git, { ...base, remote: 'https://github.com/acme/other.git', branch: 'feat' }).key, 'acme/other');
    assert.equal(pushKey(git, { ...base, remote: 'D:/bak/app.git', branch: 'feat' }).key, 'local:app:d:/bak/app.git');
    assert.deepEqual(pushKey(git, { ...base, remote: 'nope', branch: 'feat' }), { ok: false, why: 'unknown-remote', remote: 'nope' });
  });
  // Change that breaks it: let a URL typed in the command take the github field (a tap for acme/app then licenses a push to gitlab).
  it('RI16 the github field keys a configured alias remote, never a URL typed in the command with the same owner/repo', () => {
    const git = fakeGit({ remotes: { origin: { url: 'git@github-work:acme/app.git' } } });
    const id = { entryKey: 'app', github: 'acme/app' };
    assert.equal(pushKey(git, { ...id, remote: 'origin', branch: 'feat' }).key, 'acme/app');
    assert.equal(pushKey(git, { ...id, remote: 'https://gitlab.com/acme/app.git', branch: 'feat' }).key, 'local:app:https://gitlab.com/acme/app.git');
  });
  // Change that breaks it: resolve a remote name only after the URL test (a remote named team/fork then keys as a path).
  it('RI16 a remote name with a slash is resolved by git first', () => {
    const git = fakeGit({ remotes: { 'team/fork': GH('acme/fork') } });
    assert.equal(pushKey(git, { ...base, remote: 'team/fork', branch: 'feat' }).key, 'acme/fork');
  });
  // Fixer E (Dave 11-13): the gate reads refs/remotes/<remote>/HEAD only for a configured remote. Change that breaks it: drop
  // `configured` from the ok result, or set it true for a URL or a path typed in the command.
  it('RI18 configured is true for a remote of the checkout, false for a URL or a path typed in the command', () => {
    const git = fakeGit({ remotes: { up: GH('acme/app'), 'team/fork': GH('acme/fork') } });
    assert.equal(pushKey(git, { ...base, remote: 'up', branch: 'feat' }).configured, true);
    assert.equal(pushKey(git, { ...base, remote: 'team/fork', branch: 'feat' }).configured, true);
    assert.equal(pushKey(git, { ...base, remote: 'https://github.com/acme/app.git', branch: 'feat' }).configured, false);
    assert.equal(pushKey(git, { ...base, remote: 'D:/bak/app.git', branch: 'feat' }).configured, false);
  });
  it('RI16 no remote and no @{push}: name-remote; a detached HEAD: no-branch', () => {
    assert.deepEqual(pushKey(fakeGit({ remotes: { up: GH('a/b') } }), { ...base, remote: null, branch: null }), { ok: false, why: 'name-remote' });
    assert.deepEqual(pushKey(fakeGit({ remotes: { up: GH('a/b') }, branch: '' }), { ...base, remote: 'up', branch: null }), { ok: false, why: 'no-branch', remote: 'up', key: 'a/b' });
  });
});

describe('ghKey', () => {
  const base = { entryKey: 'app', github: null };
  // Change that breaks it: key a create or merge on the push URL (the tap then names me/fork while gh acts on acme/upstream, F6).
  it('RI17 one remote: the key is the fetch repo; a push URL of another repo with no -R is refused', () => {
    const split = fakeGit({ remotes: { origin: { url: 'https://github.com/acme/upstream.git', push: ['https://github.com/me/fork.git'] } } });
    assert.deepEqual(ghKey(split, { ...base, named: null }), { ok: false, why: 'fetch-push-differ', key: 'acme/upstream', remote: 'origin', pushKeys: ['me/fork'] });
    assert.deepEqual(ghKey(split, { ...base, named: 'acme/upstream' }), { ok: true, key: 'acme/upstream', remote: 'origin' });
    assert.equal(ghKey(split, { ...base, named: 'me/fork' }).why, 'repo-differs');
    assert.deepEqual(ghKey(fakeGit({ remotes: { origin: GH('acme/app') } }), { ...base, named: null }), { ok: true, key: 'acme/app', remote: 'origin' });
  });
  // Change that breaks it: compare the named repo with the @{push} key only (two remotes and no @{push} is then a dead end, F4).
  it('RI17 two remotes: a named repo that is the fetch repo of exactly one remote keys on that remote; none named is refused', () => {
    const two = fakeGit({ remotes: { origin: GH('acme/app'), fork: GH('me/app') } });
    assert.deepEqual(ghKey(two, { ...base, named: 'me/app' }), { ok: true, key: 'me/app', remote: 'fork' });
    assert.deepEqual(ghKey(two, { ...base, named: null }), { ok: false, why: 'two-remotes', remotes: ['origin', 'fork'] });
    assert.deepEqual(ghKey(two, { ...base, named: 'other/lib' }), { ok: false, why: 'repo-differs', key: null, remote: null, remotes: ['origin', 'fork'] });
    const up = fakeGit({ remotes: { origin: GH('acme/app'), fork: GH('me/app') }, pushRef: 'refs/remotes/fork/feat' });
    assert.deepEqual(ghKey(up, { ...base, named: null }), { ok: false, why: 'unnamed', key: 'me/app', remote: 'fork', remotes: ['origin', 'fork'] });
    assert.deepEqual(ghKey(up, { ...base, named: 'other/lib' }), { ok: false, why: 'repo-differs', key: 'me/app', remote: 'fork', remotes: ['origin', 'fork'] });
  });
  it('RI17 no remote: local:<entry key>; the github field keys an SSH alias', () => {
    assert.deepEqual(ghKey(fakeGit({ remotes: {} }), { ...base, named: null }), { ok: true, key: 'local:app', remote: null });
    const alias = fakeGit({ remotes: { origin: { url: 'git@github-work:acme/app.git' } } });
    assert.deepEqual(ghKey(alias, { entryKey: 'app', github: 'acme/app', named: 'acme/app' }), { ok: true, key: 'acme/app', remote: 'origin' });
  });
});

// ---------- fix round 2, fixer G ----------

describe('sshTail and the github field (fixer G, item 6: principal minor HOST_TAIL)', () => {
  // Change that breaks it: map the owner/repo tail of an https (or any non-SSH) URL to the github field again.
  it('RI19 a non-GitHub https mirror with the same owner/repo as the github field keys as local:<entry>:<url>', () => {
    const id = { entryKey: 'app', github: 'acme/app' };
    assert.equal(keyRepo({ url: 'https://gitlab.com/acme/app.git', ...id }), 'local:app:https://gitlab.com/acme/app.git');
    assert.equal(keyRepo({ url: 'http://gitlab.com/acme/app', ...id }), 'local:app:http://gitlab.com/acme/app');
    assert.equal(keyRepo({ url: 'git://mirror.example/acme/app.git', ...id }), 'local:app:git://mirror.example/acme/app.git');
  });
  it('RI19 an SSH form (scp or ssh://) whose owner/repo equals the github field keys as that repo', () => {
    const id = { entryKey: 'app', github: 'acme/app' };
    assert.equal(keyRepo({ url: 'git@github-work:Acme/App.git', ...id }), 'acme/app');
    assert.equal(keyRepo({ url: 'github-work:acme/app', ...id }), 'acme/app');
    assert.equal(keyRepo({ url: 'ssh://git@alias:2222/acme/app.git', ...id }), 'acme/app');
  });
  // Change that breaks it: sshTail accepts an https URL, or a drive path, or a URL with no owner/repo tail.
  it('RI20 sshTail: the lowercased owner/repo of an scp or ssh:// URL, else null', () => {
    assert.equal(sshTail('git@github-work:Acme/App.git'), 'acme/app');
    assert.equal(sshTail('ssh://git@host:22/acme/app'), 'acme/app');
    assert.equal(sshTail('https://gitlab.com/acme/app.git'), null);
    assert.equal(sshTail('C:/x/acme/app'), null);
    assert.equal(sshTail('/srv/acme/app.git'), null);
    assert.equal(sshTail('git@host:app.git'), null);
    assert.equal(sshTail(null), null);
  });
  // Change that breaks it: read a one-letter host as an scp host (a drive-relative path D:acme/app.git then takes the github field).
  it('RI20 a drive-relative path (D:acme/app.git) is no SSH form and never takes the github field', () => {
    assert.equal(sshTail('D:acme/app.git'), null);
    assert.equal(keyRepo({ url: 'D:acme/app.git', entryKey: 'app', github: 'acme/app' }), 'local:app:D:acme/app.git');
  });
  // Fix round 3 (fixer H, item 6): only github.com, ssh.github.com or an ssh config alias (a host with no dot) maps to the github field.
  // Change that breaks it: read the owner/repo tail of an SSH form on any host (git@gitlab.com:acme/app.git then keys as acme/app).
  it('RI22 an SSH form on a host that is not GitHub (gitlab.com, any dotted host, an IP) keys as local:<entry>:<url>', () => {
    const id = { entryKey: 'app', github: 'acme/app' };
    assert.equal(keyRepo({ url: 'git@gitlab.com:acme/app.git', ...id }), 'local:app:gitlab.com:acme/app.git');
    assert.equal(keyRepo({ url: 'ssh://git@gitlab.com/acme/app.git', ...id }), 'local:app:ssh://gitlab.com/acme/app.git');
    for (const url of ['git@gitlab.com:acme/app.git', 'ssh://git@gitlab.com/acme/app.git', 'git@git.example.org:acme/app.git', 'ssh://git@[::1]/acme/app.git', 'ssh://git@10.0.0.1:22/acme/app.git']) {
      assert.equal(sshTail(url), null, url);
    }
  });
  it('RI22 github.com, ssh.github.com and an alias host with no dot keep the github field', () => {
    const id = { entryKey: 'app', github: 'acme/app' };
    assert.equal(keyRepo({ url: 'ssh://git@ssh.github.com:443/Acme/App.git', ...id }), 'acme/app');
    assert.equal(sshTail('git@SSH.GitHub.com:acme/app.git'), 'acme/app');
    assert.equal(sshTail('git@github-work:acme/app.git'), 'acme/app');
    assert.equal(sshTail('ssh://git@alias_2:2222/acme/app.git'), 'acme/app');
  });
});

describe('pushDefaults (fixer G, item 4: what app-ask reads with no --remote or no --branch)', () => {
  // Change that breaks it: pushKey and pushDefaults read the defaults by two rules (the gate then drops a flag app-ask reads otherwise).
  it('RI21 the remote of @{push}; the branch of @{push} for that remote, else the current branch', () => {
    const git = fakeGit({ remotes: { up: GH('acme/app'), mirror: GH('acme/m') }, pushRef: 'refs/remotes/up/main', branch: 'feat' });
    assert.deepEqual(pushDefaults(git, null), { remote: 'up', branch: 'main' });
    assert.deepEqual(pushDefaults(git, 'mirror'), { remote: 'mirror', branch: 'feat' });
    assert.deepEqual(pushDefaults(fakeGit({ remotes: { up: GH('a/b') } }), null), { remote: null, branch: 'feat' });
  });
});

describe('purity', () => {
  it('RI11 the module imports no process API', () => {
    const src = readFileSync(new URL('./lib/repo-identity.mjs', import.meta.url), 'utf8');
    assert.equal(/child_process|\bspawn|\bexecSync|\bexecFile/.test(src), false);
  });
});
