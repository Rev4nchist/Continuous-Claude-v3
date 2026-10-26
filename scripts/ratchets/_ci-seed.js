// TEMPORARY CI seed for the P3a red/green proof. Reverted in the next commit.
const cp = require('child_process');
module.exports = (userInput) => cp.spawn(userInput, [], { shell: true });
