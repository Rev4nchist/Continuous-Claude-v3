import { codeRabbitNotice } from '/app/scripts/github/review-status.mjs';
if (codeRabbitNotice('plain text') !== null) {
  console.log('not ok 1 - a plain comment is a notice');
  process.exit(1);
}
console.log('ok 1 - a plain comment is not a notice');
