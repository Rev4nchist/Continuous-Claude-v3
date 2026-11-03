import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../../../../../scripts/github/review-status.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const head = 'a'.repeat(40);
const bot = { login: 'coderabbitai[bot]', type: 'Bot' };
const ids = ['b13798430e444855810d559e', 'a808bb67b4cf1eb535da039d', '8ca84b7835e8f0beaf1cbae0'];
const reviewBody = readFileSync(join(root, 'scripts/github/fixtures/coderabbit-severity/pr193-review-5683574334-outside-three.md'), 'utf8');
const review = (id, commit) => ({ id, user: bot, commit_id: commit, submitted_at: '2026-10-28T10:00:00Z', body: reviewBody });
const greptile = `Summary.\n<!-- greptile_comment -->\n<h2>Confidence Score: 5/5</h2>\n<!-- greptile_confidence_score:5 -->\n<sub>Last reviewed commit: ["f"](https://github.com/o/r/commit/${head})</sub>\n<!-- /greptile_comment -->`;
const list = (bullets) => `${greptile}\n\n## Outside-diff: handled\n\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;
const run = (prBody, reviews) => evaluate({
  pull: { number: 193, state: 'open', merged: false, mergeable_state: 'clean', body: prBody, head: { sha: head, ref: 'feat/x' } },
  combined: { statuses: [] },
  checkRuns: [{ id: 2, name: 'Greptile Review', app: { slug: 'greptile-apps' }, status: 'completed', conclusion: 'success', output: { summary: 'Greptile has reviewed the Pull Request.' } }],
  threads: [],
  bodyEdits: [{ editor: { __typename: 'Bot', login: 'greptile-apps' } }],
  reviews, comments: [], proofGate: false,
});
const filler = run(list(['finding 1: fixed', 'finding 2: fixed', 'finding 3: fixed']), [review(1, head)]);
const named = run(list(ids.map((id) => `${id}: fixed`)), [review(1, 'b'.repeat(40)), review(2, head)]);
const hidden = run(list([`<!-- ${ids.join(' ')} -->`]), [review(1, head)]);
const why = filler.reasons.find((r) => /outside-diff/i.test(r)) ?? '';
console.log(`filler: ${filler.ready ? 'READY' : 'NOT READY'}`);
console.log(`named-missing: ${ids.filter((id) => why.includes(id)).join(' ')}`);
console.log(`ids: ${named.ready ? 'READY' : 'NOT READY'} count=${named.coderabbitOutsideDiff}`);
console.log(`html-comment: ${hidden.ready ? 'READY' : 'NOT READY'}`);
if (filler.ready || ids.some((id) => !why.includes(id)) || !named.ready || named.coderabbitOutsideDiff !== 3 || hidden.ready) {
  console.log(filler.reasons.concat(named.reasons).join(' | '));
  process.exit(1);
}
