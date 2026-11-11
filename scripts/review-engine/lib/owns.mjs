// Owns-list path matching. Pure: no I/O, no git.
// An entry is { path, kind? }. kind is 'file', 'glob' or 'dir'; it is derived when absent.
// Match rules: '**' is '.*', '*' is '[^/]*', a dir entry is a prefix. Case sensitive.

export function kindOf(path) {
  if (path.includes('*')) return 'glob';
  return path.endsWith('/') ? 'dir' : 'file';
}

const kind = (entry) => entry.kind ?? kindOf(entry.path);

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
}

// '**/' also matches zero directories, so 'a/**/b' matches 'a/b'.
export function globToRegExp(pattern) {
  const body = escapeRegExp(pattern)
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${body}${pattern.endsWith('/') ? '.*' : ''}$`);
}

export function ownsMatch(entry, file) {
  if (kind(entry) === 'file') return entry.path === file;
  return globToRegExp(entry.path).test(file);
}

// Two patterns overlap when some path matches both. Each pattern becomes a token list:
// { k: 'lit', c } one character, { k: 'star' } '[^/]*', { k: 'any' } '.*'. '**/' is '.*/' or nothing, so it gives two lists.
// A trailing '/' ends in 'any' (a dir entry is a prefix). Same rules as globToRegExp.
const LIT = (c) => ({ k: 'lit', c });
const STAR = { k: 'star' };
const ANY = { k: 'any' };

function tokensAt(pattern, i) {
  if (pattern.startsWith('**/', i)) return { len: 3, options: [[ANY, LIT('/')], []] };
  if (pattern.startsWith('**', i)) return { len: 2, options: [[ANY]] };
  if (pattern[i] === '*') return { len: 1, options: [[STAR]] };
  return { len: 1, options: [[LIT(pattern[i])]] };
}

function tokenLists(pattern) {
  let lists = [[]];
  for (let i = 0; i < pattern.length;) {
    const { len, options } = tokensAt(pattern, i);
    lists = lists.flatMap((list) => options.map((option) => [...list, ...option]));
    i += len;
  }
  return pattern.endsWith('/') ? lists.map((list) => [...list, ANY]) : lists;
}

const skippable = (t) => t !== undefined && t.k !== 'lit';
const accepts = (t, c) => t.k === 'any' || (t.k === 'star' ? c !== '/' : t.c === c);

// The next state pair when both tokens consume one character, or null. Two wildcards make no step: a skip covers them.
function stepPair(a, b, i, j) {
  if (a.k === 'lit' && b.k === 'lit') return a.c === b.c ? [i + 1, j + 1] : null;
  if (a.k === 'lit') return accepts(b, a.c) ? [i + 1, j] : null;
  if (b.k === 'lit') return accepts(a, b.c) ? [i, j + 1] : null;
  return null;
}

function nextPairs(A, B, i, j) {
  const next = [];
  if (skippable(A[i])) next.push([i + 1, j]);
  if (skippable(B[j])) next.push([i, j + 1]);
  const step = A[i] && B[j] ? stepPair(A[i], B[j], i, j) : null;
  if (step) next.push(step);
  return next;
}

function meet(A, B, i, j, memo) {
  if (i === A.length && j === B.length) return true;
  const key = `${i},${j}`;
  if (!memo.has(key)) memo.set(key, nextPairs(A, B, i, j).some(([x, y]) => meet(A, B, x, y, memo)));
  return memo.get(key);
}

function patternsMeet(pathA, pathB) {
  const listsB = tokenLists(pathB);
  return tokenLists(pathA).some((A) => listsB.some((B) => meet(A, B, 0, 0, new Map())));
}

// Path-only overlap. Scope and dependency paths are the caller's job.
export function entriesOverlap(a, b) {
  if (a.path === b.path) return true;
  const fileA = kind(a) === 'file';
  const fileB = kind(b) === 'file';
  if (fileA && fileB) return false;
  if (fileA) return ownsMatch(b, a.path);
  if (fileB) return ownsMatch(a, b.path);
  return patternsMeet(a.path, b.path);
}

// Two Owns entries on one path may skip the dependency-path rule only when both scopes name keys.
// The one copy of this test: map-check.mjs and conflicts() both use it.
const KEY_SCOPE = /\bkeys? only\b/;
export const bothKeyScoped = (x, y) => KEY_SCOPE.test(x.scope ?? '') && KEY_SCOPE.test(y.scope ?? '');

// The overlapping entry pairs [x, y] of two Owns lists that are not both key-scoped. Dependencies are not judged here:
// the caller (`ready`) asks about work in progress at the same time.
export function conflicts(ownsA, ownsB) {
  return ownsA.flatMap((x) => ownsB.map((y) => [x, y])).filter(([x, y]) => entriesOverlap(x, y) && !bothKeyScoped(x, y));
}
