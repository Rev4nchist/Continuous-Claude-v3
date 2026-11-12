// Tests that every actions/checkout in .github/workflows/ccv3-checks.yml (PC1 to PC6) and in every workflow file (PC7) sets persist-credentials: false.
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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// WORKFLOWS_DIR lets a test run point at copies of the workflow files (PC7 proof that it fails on an unprotected checkout).
const WORKFLOWS = process.env.WORKFLOWS_DIR || path.join(here, '..', '..', '.github', 'workflows');
const YML = path.join(WORKFLOWS, 'ccv3-checks.yml');
const KNOWN_JOBS = ['ratchets', 'hooks', 'agentic-os', 'coordination-db', 'trivy', 'semgrep'];

const lines = (file = YML) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

/** Every job name under `jobs:` (a 2-space key). */
function jobNames(file = YML) {
  const all = lines(file);
  const start = all.findIndex((l) => l === 'jobs:');
  assert.ok(start >= 0, `no top-level "jobs:" key in ${path.basename(file)}`);
  return all.slice(start + 1).map((l) => /^ {2}([\w-]+):\s*$/.exec(l)?.[1]).filter(Boolean);
}

/** The text of one job: from `  <name>:` to the next 2-space key. Null when absent. */
function jobBlock(name, file = YML) {
  const all = lines(file);
  const start = all.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i += 1) {
    if (/^ {2}\S/.test(all[i]) && !all[i].startsWith('  #')) { end = i; break; }
  }
  return all.slice(start, end).join('\n');
}

/** The checkout steps of a job, each as its own text (a step runs from `      - ` to the next one). */
const checkouts = (block) => block.split(/\n(?= {6}- )/).slice(1).filter((s) => /^ {6}- uses:\s*actions\/checkout@/.test(s) || /^ {8}uses:\s*actions\/checkout@/m.test(s));

/** The value of `persist-credentials:` in the `with:` mapping of one step, without a trailing comment. Undefined when absent. */
const persist = (step) => {
  const at = step.split('\n');
  const w = at.findIndex((l) => /^ {8}with:\s*$/.test(l));
  if (w < 0) return undefined;
  const end = at.findIndex((l, i) => i > w && /^ {0,8}\S/.test(l));
  return /^ {10}persist-credentials:\s*(\S+)/m.exec(at.slice(w + 1, end < 0 ? at.length : end).join('\n'))?.[1];
};

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

// PC7  a workflow other than ccv3-checks.yml adds or keeps an unprotected checkout -> any file in .github/workflows, not only ccv3-checks.yml
//      (zizmor found gitleaks.yml and no-work-user.yml this way; fixed in PR 524). Fails when a checkout there loses the line.
test('PC7: every workflow file in .github/workflows sets persist-credentials: false on every checkout', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.ok(files.length > 0, `no workflow files in ${WORKFLOWS}`);
  let seen = 0;
  for (const f of files) {
    const file = path.join(WORKFLOWS, f);
    for (const name of jobNames(file)) {
      for (const step of checkouts(jobBlock(name, file))) {
        seen += 1;
        assert.equal(persist(step), 'false', `a checkout in ${f} job ${name} does not set persist-credentials: false`);
      }
    }
  }
  assert.ok(seen >= KNOWN_JOBS.length, `only ${seen} checkout(s) found in ${files.length} file(s): the parse may be reading nothing`);
});

// The ratchet's own parsing, on small step texts. CodeRabbit CLI review of the first push found two ways PC1 and PC3 pass with nothing checked.
//   PC5  a named checkout step (`- name: X` then `uses: actions/checkout@`) is not seen -> checkouts() only reads `- uses:` as the first line
//   PC6  `persist-credentials: false` under `env:` counts as the input                  -> persist() reads any line of the step, not the `with:` mapping
const NAMED = '      - name: Checkout\n        uses: actions/checkout@abc # v1\n        with:\n          persist-credentials: false';
const PLAIN = '      - uses: actions/checkout@abc # v1\n        with:\n          fetch-depth: 0\n          persist-credentials: false   # why';
const IN_ENV = '      - uses: actions/checkout@abc # v1\n        env:\n          persist-credentials: false';
const BEFORE_WITH = '      - uses: actions/checkout@abc # v1\n        with:\n          fetch-depth: 0\n        env:\n          persist-credentials: false';

test('PC5: a named checkout step is found as a checkout', () => {
  assert.equal(checkouts(`  job:\n    steps:\n${NAMED}`).length, 1);
});

test('PC5: a named step that is not a checkout is not found', () => {
  assert.equal(checkouts('  job:\n    steps:\n      - name: Build\n        uses: actions/setup-node@abc').length, 0);
});

test('PC6: persist-credentials under env: is not the input', () => {
  assert.notEqual(persist(IN_ENV), 'false');
  assert.notEqual(persist(BEFORE_WITH), 'false');
});

test('PC6: persist-credentials in with: is read, with a comment and after other inputs', () => {
  assert.equal(persist(PLAIN), 'false');
  assert.equal(persist(NAMED), 'false');
});
