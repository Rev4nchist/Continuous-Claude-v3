import { verifiedBots } from '../../../../../scripts/github/review-status.mjs';

const head = 'b'.repeat(40);
const body = [
  '<!-- review-router -->',
  `<!-- review-router-state class=infra head=${head} pathway=none pclass=normal -->`,
  'noted',
].join('\n');
const comments = [{ id: 1, user: { login: 'github-actions[bot]', type: 'Bot' }, body }];
const need = verifiedBots(['review:none', 'risk:infra'], comments, head, true);
process.stdout.write(`${(need.blockers ?? []).join('\n')}\n`);
