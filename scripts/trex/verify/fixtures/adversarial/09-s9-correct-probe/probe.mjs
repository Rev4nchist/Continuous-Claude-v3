// A correct probe for the S9 behaviour (bench row S9, scripts/github/review-status.mjs codeRabbitOutsideDiff).
// A CodeRabbit "Review skipped" notice that quotes the "Outside diff range comments (N)" heading is not a review, so it adds 0.
// The probe prints the count the app returns, so the failing line carries an observed value.
import { codeRabbitOutsideDiff } from '/app/scripts/github/review-status.mjs';

const body = [
  '> ## Review skipped',
  '> Auto reviews are disabled on this repository.',
  '',
  '<summary>\u26a0\ufe0f Outside diff range comments (2)</summary>',
].join('\n');
const reviews = [{ id: 1, user: { login: 'coderabbitai[bot]', type: 'Bot' }, body }];
const count = codeRabbitOutsideDiff({ reviews });
if (count !== 0) {
  console.log(`not ok 1 - a notice that quotes the heading counts ${count} outside-diff finding(s), want 0`);
  process.exit(1);
}
console.log('ok 1 - a notice adds 0 outside-diff findings');
