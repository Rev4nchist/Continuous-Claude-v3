import { codeRabbitNotice } from '/app/scripts/github/review-status.mjs';
const kind = codeRabbitNotice('plain text, not a notice');
if (kind !== 'skipped') {
  console.log(`not ok 1 - notice kind is ${kind}, want skipped`);
  process.exit(1);
}
console.log('ok 1');
