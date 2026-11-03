import { decideRecheck, recheckPr } from '../../../../../scripts/github/land-recheck.mjs';

const HEAD = 'a'.repeat(40);
const READY = '2026-10-30T12:00:00Z';
const BEFORE = '2026-10-30T11:00:00Z';
const AFTER = '2026-10-30T12:05:00Z';
const BOT = { login: 'coderabbitai[bot]', type: 'Bot' };
const MARKER = '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
const review = (at, id = 1) => ({ id, user: BOT, commit_id: HEAD, submitted_at: at, body: 'Actionable comments posted: 1' });
const summary = (at, body) => ({ id: 900, user: BOT, body: body ?? `${MARKER}\nsummary`, created_at: BEFORE, updated_at: at });
const request = (at) => ({ id: 901, user: { login: 'Rev4nchist', type: 'User' }, body: '@coderabbitai review', created_at: at, updated_at: at });
const base = (over = {}) => ({
  readyHead: HEAD, readyAt: READY, pull: { head: { sha: HEAD } }, reviews: [review(BEFORE)],
  comments: [summary(BEFORE), request('2026-10-30T10:00:00Z')], commentEdits: { 900: [] },
  statuses: [{ context: 'CodeRabbit', state: 'success' }], ...over,
});
const bad = [];
const check = (name, r, want, extra) => {
  const got = r.ok ? 'ALLOW' : 'REFUSE';
  console.log(`${name}: ${got} ${r.refusals.join(' | ')}`);
  if (got !== want || (extra && !extra.test(r.refusals.join(' ')))) bad.push(name);
};
check('quiet', decideRecheck(base()), 'ALLOW');
check('review-after', decideRecheck(base({ reviews: [review(BEFORE), review(AFTER, 2)] })), 'REFUSE', /after the READY check/);
check('in-flight', decideRecheck(base({ comments: [summary(BEFORE), request('2026-10-30T11:30:00Z')] })), 'REFUSE', /in flight/);
check('head-moved', decideRecheck(base({ pull: { head: { sha: 'b'.repeat(40) } } })), 'REFUSE', /head changed/);
const cover = `${MARKER}\nNo actionable comments were generated.\n<!-- final_review_risk_coverage:{"coveredCommitId":"${HEAD}","kind":"reviewed"} -->`;
const crEdit = { editor: { __typename: 'Bot', login: 'coderabbitai' }, editedAt: '2026-10-30T13:48:07Z' };
const round = {
  readyAt: '2026-10-30T13:50:00Z', reviews: [review(BEFORE)],
  comments: [summary('2026-10-30T13:48:07Z', cover), request('2026-10-30T13:42:03Z')],
};
check('summary-only', decideRecheck(base({ ...round, commentEdits: { 900: [crEdit] } })), 'ALLOW');
const person = { editor: { __typename: 'User', login: 'Rev4nchist' }, editedAt: AFTER };
check('person-edit', decideRecheck(base({ ...round, commentEdits: { 900: [person, crEdit] } })), 'REFUSE', /in flight/);
const pages = [
  { statuses: Array.from({ length: 30 }, (_, i) => ({ context: `ci/${i}`, state: 'success' })) },
  { statuses: [{ context: 'CodeRabbit', state: 'pending' }] },
];
const gh = (args) => {
  if (args[0] === 'graphql') return { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
  const url = args.find((a) => String(a).startsWith('repos/')) ?? '';
  if (/\/pulls\/7$/.test(url)) return { head: { sha: HEAD } };
  if (/\/reviews/.test(url)) return [[review(BEFORE)]];
  if (/\/comments/.test(url)) return [[]];
  if (/\/status/.test(url)) return args.includes('--paginate') ? pages : [pages[0]];
  throw new Error(args.join(' '));
};
check('pending-page', recheckPr({ pr: 7, repo: 'o/n', head: HEAD, readyAt: READY }, gh), 'REFUSE', /pending/);
if (bad.length) process.exit(1);
