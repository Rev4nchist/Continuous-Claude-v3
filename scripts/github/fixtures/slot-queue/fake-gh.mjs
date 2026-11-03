// A fake GitHub for the slot-queue tests. Test helper only: nothing in production imports it.
// makeGh(worldPath, logPath, opts) returns a `gh(argv)` function with the shape of cr-fix.mjs ghApi (argv after "gh api", parsed JSON back).
// The world is a JSON file read on every call, so a test (or a child process) can change it between calls:
//   { "repo": "o/r", "prs": { "900": { state, merged, head, committedAt, statuses[], reviews[], comments[], files[] } } }
// A POST to issues/N/comments appends one JSON line {pr, body} to logPath. Any argv this file does not know throws.
// opts: peekState (a state file path: at post time its holder and lock go to <logPath>.peek), postDelayMs (sleep inside a post), failPost, failAll (every call throws), callsPath (every argv is logged there).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function nodeOf(c) {
  return {
    databaseId: c.id, body: c.body, updatedAt: c.updated_at ?? c.created_at, lastEditedAt: null,
    author: { __typename: c.user.type, login: c.user.login.replace(/\[bot\]$/, '') },
    userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function graphqlComments(pr) {
  const nodes = (pr.comments ?? []).map(nodeOf);
  return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } };
}

function pullOf(pr) {
  return { state: pr.state, merged: pr.merged === true, head: { sha: pr.head }, base: { ref: 'main' } };
}

/** The list endpoints and the single-object endpoints, keyed by the path after "repos/<o>/<r>/". */
function lookup(pr, sub) {
  const [kind, , leaf] = sub.split('/');
  if (kind === 'pulls' && leaf === undefined) return pullOf(pr);
  if (kind === 'pulls' && leaf === 'reviews') return pr.reviews ?? [];
  if (kind === 'pulls' && leaf === 'files') return pr.files ?? [];
  if (kind === 'pulls' && leaf === 'commits') return [];
  if (kind === 'issues' && leaf === 'comments') return pr.comments ?? [];
  throw new Error(`fake-gh: unknown path ${sub}`);
}

function commitRead(pr, sha, leaf) {
  if (sha !== pr.head) throw new Error(`fake-gh: ${sha} is not the head of the PR`);
  if (leaf === 'status') return { state: 'success', statuses: pr.statuses ?? [] };
  return { sha, commit: { committer: { date: pr.committedAt ?? '2026-01-01T00:00:00Z' } } };
}

function readPath(world, apiPath, paginated) {
  const clean = apiPath.split('?')[0];
  const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/(\w+)(?:\/(\w+))?$/.exec(clean);
  if (!m || m[1] !== world.repo) throw new Error(`fake-gh: unknown path ${apiPath}`);
  const [, , kind, id, leaf] = m;
  if (kind === 'commits') {
    const pr = Object.values(world.prs).find((p) => p.head === id);
    if (!pr) throw new Error(`fake-gh: no PR has head ${id}`);
    return commitRead(pr, id, leaf);
  }
  const pr = world.prs[id];
  if (!pr) throw new Error(`fake-gh: no PR ${id}`);
  const out = lookup(pr, `${kind}/${id}${leaf ? `/${leaf}` : ''}`);
  return paginated ? [out] : out;
}

/** What a second reader would see at the moment of the post: the holder in the state file, and whether the lock file exists. */
function peek(statePath, out) {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  appendFileSync(out, `${JSON.stringify({ holderPr: state.holder?.pr ?? null, locked: existsSync(`${statePath}.lock`) })}\n`);
}

function post(world, argv, logPath, opts) {
  const m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(argv[2] ?? '');
  const body = argv[argv.indexOf('-f') + 1]?.replace(/^body=/, '');
  if (argv[1] !== 'POST' || !m || body === undefined || !world.prs[m[1]]) throw new Error(`fake-gh: unknown post ${JSON.stringify(argv)}`);
  if (opts.failPost) throw new Error('fake-gh: the post failed');
  if (opts.peekState) peek(opts.peekState, `${logPath}.peek`);
  if (opts.postDelayMs) sleepSync(opts.postDelayMs);
  appendFileSync(logPath, `${JSON.stringify({ pr: Number(m[1]), body })}\n`);
  return { id: 1 };
}

export function makeGh(worldPath, logPath, opts = {}) {
  return (argv) => {
    if (opts.callsPath) appendFileSync(opts.callsPath, `${JSON.stringify(argv)}\n`);
    if (opts.failAll) throw new Error('fake-gh: GitHub is down');
    const world = JSON.parse(readFileSync(worldPath, 'utf8'));
    if (argv[0] === 'graphql') {
      const n = argv[argv.indexOf('-F') + 1]?.replace(/^n=/, '');
      if (!world.prs[n]) throw new Error(`fake-gh: no PR ${n}`);
      return graphqlComments(world.prs[n]);
    }
    if (argv[0] === '-X') return post(world, argv, logPath, opts);
    if (argv[0] === '--paginate' && argv[1] === '--slurp') return readPath(world, argv[2], true);
    if (argv.length === 1) return readPath(world, argv[0], false);
    throw new Error(`fake-gh: unknown argv ${JSON.stringify(argv)}`);
  };
}
