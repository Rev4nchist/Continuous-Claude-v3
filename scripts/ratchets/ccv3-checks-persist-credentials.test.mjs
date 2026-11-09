// Tests that every actions/checkout in .github/workflows/ccv3-checks.yml sets persist-credentials: false.
// Run: node --test scripts/ratchets/ccv3-checks-persist-credentials.test.mjs
// Why: without it the checkout leaves the git token in .git/config for every later step (zizmor "artipacked", Medium).
// No job in this workflow pushes or fetches a private remote. changed-files.sh runs only local `git diff`, and the
// full-history fetch happens inside the checkout step, before the token is removed.
// Text parse only: the repo has no YAML library at the root (same approach as ccv3-checks-agentic-os.test.mjs).
//
// Failure modes, and the source change that makes each test fail:
//   PC1  a job's checkout leaves the token on disk   -> `persist-credentials: false` is deleted from a checkout, or set to true
//   PC2  a known job loses its checkout, or is gone  -> the job is renamed or deleted, so PC1 would pass with nothing to check
//   PC3  a new job adds an unprotected checkout      -> any job in the file, not only the six below, gets a checkout without the line
//   PC4  the line sits on the wrong step             -> `persist-credentials: false` is moved to setup-node: the checkout step itself is read
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const YML = path.join(here, '..', '..', '.github', 'workflows', 'ccv3-checks.yml');
const KNOWN_JOBS = ['ratchets', 'hooks', 'agentic-os', 'coordination-db', 'trivy', 'semgrep'];

const lines = () => readFileSync(YML, 'utf8').replace(/\r\n/g, '\n').split('\n');

/** Every job name under `jobs:` (a 2-space key). */
function jobNames() {
  const all = lines();
  const start = all.findIndex((l) => l === 'jobs:');
  assert.ok(start >= 0, 'no top-level "jobs:" key');
  return all.slice(start + 1).map((l) => /^ {2}([\w-]+):\s*$/.exec(l)?.[1]).filter(Boolean);
}

/** The text of one job: from `  <name>:` to the next 2-space key. Null when absent. */
function jobBlock(name) {
  const all = lines();
  const start = all.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^ {2}\S/.test(all[i]) && !all[i].startsWith('  #')) { end = i; break; }
  }
  return all.slice(start, end).join('\n');
}

/** The checkout steps of a job, each as its own text (a step runs from `      - ` to the next one). */
const checkouts = (block) => block.split(/\n(?= {6}- )/).slice(1).filter((s) => /^ {6}- uses:\s*actions\/checkout@/.test(s));

/** The value of `persist-credentials:` inside one step, without a trailing comment. Undefined when absent. */
const persist = (step) => /^ +persist-credentials:\s*(\S+)/m.exec(step)?.[1];

for (const name of KNOWN_JOBS) {
  test(`PC1/PC2: the ${name} job has a checkout, and it sets persist-credentials: false`, () => {
    const block = jobBlock(name);
    assert.ok(block, `jobs: has no "${name}:" job`);
    const found = checkouts(block);
    assert.ok(found.length > 0, `the ${name} job has no actions/checkout step`);
    for (const step of found) assert.equal(persist(step), 'false', `a checkout in ${name} does not set persist-credentials: false`);
  });
}

test('PC3: every job in the file that checks out code sets persist-credentials: false, known or new', () => {
  const names = jobNames();
  for (const known of KNOWN_JOBS) assert.ok(names.includes(known), `known job ${known} is missing from jobs:`);
  for (const name of names) {
    for (const step of checkouts(jobBlock(name))) assert.equal(persist(step), 'false', `a checkout in ${name} does not set persist-credentials: false`);
  }
});
