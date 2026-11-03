import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const climb = (start, rel) => {
  let d = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(d, rel))) return d;
    const parent = path.dirname(d);
    if (parent === d) return '';
    d = parent;
  }
  return '';
};
const rel = 'scripts/github/review-status.mjs';
const root = climb(process.cwd(), rel) || climb(path.dirname(fileURLToPath(import.meta.url)), rel);
if (!root) throw new Error('review-status.mjs not found');
const { evaluate, readBodyEdits, bodyEditsPageReader } = await import(pathToFileURL(path.join(root, rel)).href);

const HEAD = 'a'.repeat(40);
const ed = (login, type) => ({ editor: { __typename: type, login } });
const greptile = ed('greptile-apps', 'Bot');
const person = ed('someone', 'User');
const bot = ed('coderabbitai', 'Bot');
const page = (nodes, cursor) => ({ pageInfo: { hasNextPage: cursor !== undefined, endCursor: cursor ?? null }, nodes });
const ready = (edits) => evaluate({
  pull: { number: 111, state: 'open', merged: false, mergeable_state: 'clean', head: { sha: HEAD, ref: 'feat/x' },
    body: `<!-- greptile_comment --><h2>Confidence Score: 5/5</h2><!-- greptile_confidence_score:5 --><sub>Last reviewed commit: ["fix"](https://github.com/o/r/commit/${HEAD})</sub><!-- /greptile_comment -->` },
  combined: { statuses: [] },
  checkRuns: [{ id: 2, app: { slug: 'greptile-apps' }, status: 'completed', conclusion: 'success', output: { summary: 'reviewed' } }],
  threads: [], bodyEdits: edits, proofGate: false,
}).ready;
const bit = (edits) => (ready(edits) ? 'ready' : 'blocked');
const noPageInfo = bit(readBodyEdits({ nodes: [greptile] }, () => { throw new Error('fetch'); }));
const newerPerson = bit(readBodyEdits(page([person], 'n1'), () => page([greptile])));
const buriedPerson = bit(readBodyEdits(page([bot], 'b1'), () => page([person, greptile])));
const longClean = bit(readBodyEdits(page(Array.from({ length: 20 }, () => bot), 'L'), () => page([greptile])));
let n = 0;
const overCap = bit(readBodyEdits(page([greptile], 'p0'), () => { n += 1; return n < 21 ? page([bot], `p${n}`) : page([bot]); }));
const onePage = bit(readBodyEdits(page([greptile]), () => { throw new Error('fetch'); }));
const args = [];
const conn = bodyEditsPageReader((a) => { args.push(...a); return { data: { repository: { pullRequest: { userContentEdits: page([greptile]) } } } }; }, 'o', 'r', 9)('cursor-9');
const q = String(args.find((a) => String(a).startsWith('query=')) ?? '');
const followUp = /userContentEdits\([^)]*first:\s*\d+[^)]*\)\s*\{\s*pageInfo\s*\{\s*hasNextPage/.test(q) && args.some((a) => String(a).includes('cursor-9')) && conn?.pageInfo?.hasNextPage === false ? 'yes' : 'no';
const line = `noPageInfo=${noPageInfo} newerPerson=${newerPerson} buriedPerson=${buriedPerson} longClean=${longClean} overCap=${overCap} onePage=${onePage} followUp=${followUp}`;
console.log(line);
process.exit(line === 'noPageInfo=blocked newerPerson=blocked buriedPerson=blocked longClean=ready overCap=blocked onePage=ready followUp=yes' ? 0 : 1);
