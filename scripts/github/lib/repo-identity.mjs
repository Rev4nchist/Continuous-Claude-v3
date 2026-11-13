// Repo identity for the tap gate outside CCv3 (card coord-decision-gate-app-repos, rule R5, seat condition G2; fix round 1: F3 to F6).
// ONE key rule. The decision-gate hook bundles this file through .claude/hooks/src/shared/tap-scope.ts, and the app offer writer
// (app-ask.mjs) imports it, so both read the same git facts the same way and build the same key. No file, no env and no process of
// its own: every git answer comes through the injected `git(args) -> { status, stdout }` (the gate's Deps git, or app-ask's runner).
//
//   repoSlug(url)                         lowercased 'owner/repo' of a github.com remote URL, else null
//   keyRepo({ url, entryKey, github })    the key repo of one target (see keyRepo)
//   normPath(p)                           the path fold of tap-scope.ts and app-ask.mjs (one rule for both)
//   isUrlLike(text)                       a URL, an scp form or a path, never a remote name (names may hold /)
//   pushRefOf(git, names)                 { remote, branch } of @{push}, split by the longest remote name
//   sshTail(url)                          lowercased owner/repo of an SSH form URL (scp or ssh://), else null (fix round 2, fixer G)
//   needsGithubField(url, github)         an SSH host alias with no github field in the entry: open-pr and merge need that field
//   pushKey(git, o)                       the key of a push: the push URLs of the remote, the destination branch
//   pushDefaults(git, remote)             the remote and branch a push takes when the command names none (ONE rule with pushKey)
//   ghKey(git, o)                         the key of a create or merge: the FETCH URL of a remote (gh reads it), or the named repo
//   openPrKey({ repo, branch, base })     the open-pr key: repo@branch, plus :base when the create names one (fix round 5, F8)
//   oneLine(text, max)                    one plain line for a question text, clipped to max code points
//   stripCredentials(text)                a remote or URL without its user and token part (the strip of the key; seat review 1, item 2)

const NAME = '([\\w.-]+)';
const TAIL = `${NAME}\\/([\\w.-]+?)(?:\\.git)?\\/?$`;
/** https, http, git and ssh URL forms. A user part (`user@`, `user:token@`) and an ssh port are allowed; the host is github.com exactly. */
const URL_FORM = new RegExp(`^(?:https?|git|ssh):\\/\\/(?:[^@/\\s]+@)?github\\.com(?::\\d+)?\\/${TAIL}`, 'i');
/** The scp form of ssh: `git@github.com:owner/repo.git`. */
const SCP_FORM = new RegExp(`^(?:[\\w.-]+@)?github\\.com:${TAIL}`, 'i');
/** The owner/repo at the end of a URL with a host: compared with the github field only, and only for an SSH form (sshTail). */
const HOST_TAIL = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/;
/**
 * An SSH form: ssh:// (also git+ssh://, ssh+git://), or the scp form [user@]host:path (no scheme, no slash before the colon). The host has
 * two or more characters: a one-letter host is a drive (D:acme/app.git is a drive-relative path, not scp).
 */
const SSH_FORM = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/|(?:[^@/\s:]+@)?[^@/\s:]{2,}:(?!\/\/))/i;
/** The host of an SSH form: after ssh:// and an optional user@ (up to a port colon or a slash), or before the colon of the scp form. */
const SSH_HOST = /^(?:(?:git\+)?ssh(?:\+git)?:\/\/(?:[^@/\s]+@)?([^/\s:]+)|(?:[^@/\s:]+@)?([^@/\s:]{2,}):)/i;
/**
 * Fix round 3 (fixer H, item 6): the hosts whose owner/repo tail may be a GitHub repo. github.com, ssh.github.com (port 443), or an ssh
 * config alias: one word with no dot (letters, digits, _ and -; so no IP address, no [::1] and no other domain such as gitlab.com).
 */
const githubHost = (host) => host === 'github.com' || host === 'ssh.github.com' || /^[a-z0-9_-]+$/.test(host);
const OWNER_REPO = /^([\w.-]+)\/([\w.-]+)$/;
const DOTS = /^\.+$/;

/** Lowercased 'owner/repo' of a github.com remote URL (https, ssh scp form, ssh://, with or without .git, any case), else null. */
export function repoSlug(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  const m = URL_FORM.exec(text) ?? SCP_FORM.exec(text);
  if (!m || DOTS.test(m[1]) || DOTS.test(m[2])) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/** Fold a path for an equality test: forward slashes, no \\?\ prefix, /c/ to c:/, lower case on a drive path only, one slash, no trailing slash. */
export function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/^\/\/[?.]\//, '');
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase();
  return s.replace(/(?<=.)\/{2,}/g, '/').replace(/(?<=.)\/+$/, '');
}

/** A local path: absolute, relative (. ..), home (~), a drive letter, a share (\\ or //) or a file:// URL. */
const isPathLike = (t) => /^[\\/.~]/.test(t) || /^[a-zA-Z]:(?:[\\/]|$)/.test(t) || /^file:/i.test(t);

/**
 * A URL, an scp form (`host:path`) or a path. A git remote name can hold / but never a colon and never starts with . / \ or ~, so a
 * name like team/fork is no URL (F5: the old test /[:/\\]/ read it as one).
 */
export function isUrlLike(text) {
  const t = String(text ?? '').trim();
  return t !== '' && (isPathLike(t) || t.includes(':'));
}

/** The github field of a registry entry as a lowercased owner/repo (a slug or a github.com URL), else null. */
export function githubField(v) {
  if (typeof v !== 'string') return null;
  const slug = repoSlug(v);
  if (slug) return slug;
  const m = OWNER_REPO.exec(v.trim());
  return m && !DOTS.test(m[1]) && !DOTS.test(m[2]) ? v.trim().toLowerCase() : null;
}

/**
 * A remote or URL with its user and token part removed: `scheme://user:token@host/...` to `scheme://host/...` (up to the LAST @ before the
 * first slash, so a raw @ in a token goes too), and the user of the scp form (`user@host:path`). A remote name or a path without a user
 * part is returned as given (trimmed). Seat review 1, item 2: app-ask.mjs shows and stores a remote only through this, and so does the key.
 */
export function stripCredentials(text) {
  return String(text ?? '').trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1').replace(/^[^@/\s]+@(?=[^@/:\s]+:)/, '');
}

/** A non-GitHub target, normalised for a key: a path by normPath; a URL with its user and token part and trailing slashes removed. */
function targetOf(url) {
  const t = url.trim();
  if (isPathLike(t)) return normPath(t.replace(/^file:\/\//i, ''));
  return stripCredentials(t).replace(/\/+$/, '');
}

/**
 * The lowercased owner/repo at the end of an SSH form URL (scp form or ssh://), else null: an https or other scheme, a path, or no
 * owner/repo tail. An SSH host alias (git@github-work:o/r.git) is read here (fix round 2, fixer G, item 6). Fix round 3 (fixer H):
 * only on a GitHub host or an alias with no dot (githubHost): git@gitlab.com:acme/app.git gives null, so it keys as local:<entry>:<url>.
 */
export function sshTail(url) {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  if (t === '' || isPathLike(t) || !SSH_FORM.test(t)) return null;
  const h = SSH_HOST.exec(t);
  if (!h || !githubHost((h[1] ?? h[2]).toLowerCase())) return null;
  const m = HOST_TAIL.exec(t);
  return m && !DOTS.test(m[1]) && !DOTS.test(m[2]) ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The repo part of a decision key for one target.
 *   no URL (a folder with no remote)              local:<entryKey>
 *   a github.com URL                              its lowercased owner/repo
 *   an SSH form URL (scp or ssh://) whose owner/repo tail equals the github field of the entry (an SSH host alias, ssh.github.com:443):
 *                                                 that repo (F5). An https mirror on another host never takes it (fixer G, item 6).
 *   any other URL or a path                       local:<entryKey>:<target>, so two non-GitHub targets never share a key
 * Null when the key needs the entry key and there is none.
 */
export function keyRepo({ url, entryKey, github } = {}) {
  const key = typeof entryKey === 'string' ? entryKey.trim() : '';
  if (url === undefined || url === null || String(url).trim() === '') return key ? `local:${key}` : null;
  const slug = repoSlug(url);
  if (slug) return slug;
  const field = githubField(github);
  if (field && sshTail(String(url)) === field) return field;
  return key ? `local:${key}:${targetOf(String(url))}` : null;
}

/**
 * True when a remote URL is an SSH host alias (an SSH form with an owner/repo tail and no github.com slug) and the entry has no github
 * field: open-pr and merge then have no GitHub repo to name, and the way out is a github field in the registry entry (fixer G, item 7).
 */
export const needsGithubField = (url, github) => repoSlug(url) === null && sshTail(url) !== null && githubField(github) === null;

// ---------- the git facts (through the injected git) ----------

const out = (git, args) => {
  const r = git(args);
  return r && r.status === 0 ? String(r.stdout ?? '').trim() : null;
};
const lines = (text) => (text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const uniq = (list) => [...new Set(list)];

/** The remote names of the checkout (`git remote`). */
export const remoteNames = (git) => lines(out(git, ['remote']));

/**
 * { remote, branch } of the push target of the current branch (`git rev-parse --symbolic-full-name @{push}`: refs/remotes/<remote>/<branch>),
 * or null. A remote name may hold /, so the remote is the LONGEST name in `names` that prefixes the ref (F5: not split('/')[0]).
 */
export function pushRefOf(git, names) {
  const m = /^refs\/remotes\/(.+)$/.exec(out(git, ['rev-parse', '--symbolic-full-name', '@{push}']) ?? '');
  if (!m) return null;
  const remote = names.filter((n) => m[1].startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: m[1].slice(remote.length + 1) } : null;
}

/**
 * The URLs of a remote: a configured remote first (git remote get-url; with `push`, --push --all: every pushurl), else the text itself
 * when it is a URL or a path. Null when it is neither.
 */
export function remoteUrls(git, remote, push) {
  return targetsOf(git, remote, push)?.urls ?? null;
}
/** { urls, configured } of remoteUrls: `configured` is false for a URL or path typed in the command (no remote of that name). */
function targetsOf(git, remote, push) {
  // Seat review 1, item 5: --end-of-options, so a remote word that starts with - never reaches git as an option.
  const listed = out(git, ['remote', 'get-url', ...(push ? ['--push', '--all'] : []), '--end-of-options', remote]);
  if (listed !== null) return { urls: lines(listed), configured: true };
  return isUrlLike(remote) ? { urls: [remote.trim()], configured: false } : null;
}
/**
 * The github field counts only for a CONFIGURED remote (the registry owner set it up). A URL typed in the command never takes it: a tap for
 * acme/app must not license `git push https://gitlab.com/acme/app.git` (its owner/repo tail is the same).
 */
const idFor = (t, { entryKey, github }) => ({ entryKey, github: t.configured ? github : null });

/**
 * The key of a push: o = { remote, branch, entryKey, github }. remote: the remote or URL the push names, else the remote of @{push}.
 * branch: the destination the push names; null for a bare push, which updates the branch of @{push} when the push goes to that remote
 * (push.default=upstream, a tracking branch with another name), else the current branch.
 * { ok: true, key, remote, branch, configured } or { ok: false, why }: name-remote (no remote and no @{push}), unknown-remote, no-key,
 * multi-pushurl (the push URLs name more than one repo: one pushurl per tap), no-branch (detached HEAD).
 * configured: the remote is a remote of the checkout (false for a URL or a path typed in the command: it has no remote HEAD ref).
 */
export function pushKey(git, { remote = null, branch = null, entryKey = null, github = null } = {}) {
  let d;
  const defaults = () => (d ??= pushDefaults(git, remote));
  const via = remote ?? defaults().remote;
  if (via === null) return { ok: false, why: 'name-remote' };
  const t = targetsOf(git, via, true);
  if (t === null || t.urls.length === 0) return { ok: false, why: 'unknown-remote', remote: via };
  const id = idFor(t, { entryKey, github });
  const keys = uniq(t.urls.map((url) => keyRepo({ url, ...id })));
  if (keys.includes(null)) return { ok: false, why: 'no-key', remote: via };
  if (keys.length > 1) return { ok: false, why: 'multi-pushurl', remote: via, keys };
  const dest = branch ?? defaults().branch;
  if (!dest) return { ok: false, why: 'no-branch', remote: via, key: keys[0] };
  return { ok: true, key: keys[0], remote: via, branch: dest, configured: t.configured };
}

/**
 * What a push takes when the command names no remote or no branch: { remote, branch }. remote: the one given, else the remote of @{push}
 * (null when none). branch: the branch of @{push} when the push goes to that remote (push.default=upstream), else the current branch
 * ('' when detached). ONE rule for pushKey and for the gate's F2 test of what app-ask reads by itself (fixer G, item 4).
 */
export function pushDefaults(git, remote = null) {
  const up = pushRefOf(git, remoteNames(git));
  const via = remote ?? up?.remote ?? null;
  const branch = up !== null && up.remote === via ? up.branch : out(git, ['branch', '--show-current']) ?? '';
  return { remote: via, branch };
}

/** The key of the fetch URL of a remote (gh reads the fetch URL for a create or a merge), or null. */
export function fetchKey(git, remote, { entryKey = null, github = null } = {}) {
  const t = targetsOf(git, remote, false);
  return t && t.urls.length > 0 ? keyRepo({ url: t.urls[0], ...idFor(t, { entryKey, github }) }) : null;
}

/** The remote gh reads for a create or a merge with no -R: the remote of @{push}, else the only remote, else null. */
export function ghRemote(git, names = remoteNames(git)) {
  return pushRefOf(git, names)?.remote ?? (names.length === 1 ? names[0] : null);
}

/**
 * The key of a create or a merge: o = { named, entryKey, github }. named: the repo the command names (-R), lowercased, or null.
 *   named          it must be the fetch repo of a remote of the folder: then that repo, with the first such remote (F4)
 *   no remote      local:<entryKey>
 *   one remote     the fetch repo; a push URL of another repo is refused, because gh may act on another repo than the tap (F6)
 *   several        refused: two-remotes (no @{push}) or unnamed (gh may pick another remote than @{push})
 * { ok: true, key, remote } or { ok: false, why, ... }: why is repo-differs, two-remotes, unnamed, fetch-push-differ or no-key.
 */
export function ghKey(git, { named = null, entryKey = null, github = null } = {}) {
  const names = remoteNames(git);
  const id = { entryKey, github };
  if (named !== null) {
    const hit = names.find((r) => fetchKey(git, r, id) === named);
    if (hit !== undefined) return { ok: true, key: named, remote: hit };
    const via = ghRemote(git, names);
    const key = via !== null ? fetchKey(git, via, id) : names.length === 0 ? keyRepo({ entryKey }) : null;
    return { ok: false, why: 'repo-differs', key, remote: via, remotes: names };
  }
  if (names.length === 0) return keyRepo({ entryKey }) ? { ok: true, key: keyRepo({ entryKey }), remote: null } : { ok: false, why: 'no-key', remotes: names };
  const via = ghRemote(git, names);
  if (via === null) return { ok: false, why: 'two-remotes', remotes: names };
  const key = fetchKey(git, via, id);
  if (key === null) return { ok: false, why: 'no-key', remote: via, remotes: names };
  if (names.length > 1) return { ok: false, why: 'unnamed', key, remote: via, remotes: names };
  const pushKeys = uniq((remoteUrls(git, via, true) ?? []).map((url) => keyRepo({ url, entryKey, github })));
  if (pushKeys.some((k) => k !== key)) return { ok: false, why: 'fetch-push-differ', key, remote: via, pushKeys };
  return { ok: true, key, remote: via };
}

/**
 * The open-pr key of an app repo (fix round 5, F8): `<repo>@<branch>`, the branch key of the store (decisions.mjs decisionKey), plus
 * `:<base>` when the create names the base branch it targets. A colon is in no git ref name, so the base never runs into the branch, and
 * a tap for base dev never licenses a create into main. No base (null, undefined or ''): the key of before (gh then takes the default
 * branch, and a create that names a base needs its own tap). The decision gate and app-ask.mjs both build the key here.
 */
export function openPrKey({ repo, branch, base = null } = {}) {
  const key = `${repo}@${branch}`;
  return typeof base === 'string' && base !== '' ? `${key}:${base}` : key;
}

/** Control, format, private-use and lone-surrogate characters, and the line and paragraph separators. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * One plain line (seat condition G2): NFKC, every unsafe character to a space, runs of white space to one space, trimmed.
 * A text longer than max code points is cut to max - 1 points plus an ellipsis, so the result never passes max and never
 * splits a surrogate pair. max must be a whole number above 0.
 */
export function oneLine(text, max) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`oneLine: max must be a whole number above 0, got ${max}`);
  const plain = String(text ?? '').normalize('NFKC').replace(UNSAFE_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  const points = [...plain];
  if (points.length <= max) return plain;
  return `${points.slice(0, max - 1).join('').trimEnd()}\u2026`;
}
