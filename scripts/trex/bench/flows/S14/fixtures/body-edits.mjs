import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRoot(start) {
  let dir = path.resolve(start);
  const mark = path.join('scripts', 'github', 'review-status.mjs');
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, mark))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = findRoot(here) || findRoot(process.cwd());
if (!root) {
  console.error('review-status.mjs not found');
  process.exit(1);
}
const rs = await import(pathToFileURL(path.join(root, 'scripts/github/review-status.mjs')).href);
const bot = { editor: { __typename: 'Bot', login: 'coderabbitai' } };
const person = { editor: { __typename: 'User', login: 'someone' } };
const greptile = { editor: { __typename: 'Bot', login: 'greptile-apps' } };
const page = (nodes, next) => ({ pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes });
const head = 'a'.repeat(40);
const body = `Summary text.\n<!-- greptile_comment -->\n<h2>Confidence Score: 5/5</h2>\n<!-- greptile_confidence_score:5 -->\n<sub>Reviews (2) · Last reviewed commit: ["fix"](https://github.com/o/r/commit/${head})</sub>\n<!-- /greptile_comment -->`;
const judge = (bodyEdits) => rs.evaluate({
  pull: { number: 7, state: 'open', merged: false, mergeable_state: 'clean', body, head: { sha: head, ref: 'feat/x' } },
  combined: { statuses: [] },
  checkRuns: [{ id: 2, app: { slug: 'greptile-apps' }, status: 'completed', conclusion: 'success', output: { summary: 'Greptile has reviewed the Pull Request.' } }],
  threads: [], bodyEdits, proofGate: false,
});
const fail = (m) => { console.error(m); process.exit(1); };
const byCursor = { c1: page([person], 'c2'), c2: page([greptile]) };
const hidden = judge(rs.readBodyEdits(page([bot], 'c1'), (c) => byCursor[c] ?? null));
if (hidden.ready || !hidden.reasons.some((r) => /edited by someone after Greptile/.test(r))) fail(hidden.reasons.join(' | '));
if (!judge(rs.readBodyEdits(page([bot], 'c1'), () => page([greptile]))).ready) fail('bots then Greptile were not READY');
const calls = [];
rs.bodyEditsPageReader((args) => {
  calls.push(args);
  return { data: { repository: { pullRequest: { userContentEdits: page([greptile]) } } } };
}, 'o', 'r', 7)('c9');
const q = calls.flat().map(String).join('\n');
if (!/pageInfo\{\s*hasNextPage\s+endCursor\s*\}/.test(q) || !/after:\$c/.test(q)) fail(`query: ${q}`);
const src = readFileSync(path.join(root, 'scripts/github/review-status.mjs'), 'utf8');
if (!/userContentEdits\(first:\s*20\)\{\s*pageInfo\{\s*hasNextPage\s+endCursor\s*\}/.test(src)) fail('main query has no pageInfo');
console.log('BODY_EDITS_OK');
