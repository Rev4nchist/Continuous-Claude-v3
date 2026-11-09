// Tests that .github/workflows/ccv3-checks.yml runs lint, typecheck and build for apps/agentic-os.
// Run: node --test scripts/ratchets/ccv3-checks-agentic-os.test.mjs
// Text parse only: the repo has no YAML library at the root, and a parse check needs none.
//
// Failure modes, and the source change that makes each test fail:
//   AO1  the job is missing                      -> the agentic-os job is deleted or renamed
//   AO2  a script is not run in the app folder   -> a step drops its working-directory, or its npm run line
//   AO3  the install runs scripts or is missing  -> `npm ci --ignore-scripts` is removed or loses a flag
//   AO4  the job runs on every PR                -> a script step loses its scope `if`, or the scope step stops matching apps/agentic-os/
//   AO5  an action is not pinned, or a secret    -> a `uses:` tag replaces a SHA, or the job reads `secrets.`
//   AO6  a step can hang the runner              -> the job or a script step loses its timeout-minutes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const YML = path.join(here, '..', '..', '.github', 'workflows', 'ccv3-checks.yml');
const APP = 'apps/agentic-os';

/** The text of one job: from `  <name>:` to the next 2-space key. Null when absent. */
function jobBlock(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]) && !lines[i].startsWith('  #')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** The steps of a job block, each as its own text. */
function steps(block) {
  return block.split(/\n(?= {6}- )/).slice(1);
}

const field = (step, key) => new RegExp(`^ +(?:- )?${key}:\\s*(.+)$`, 'm').exec(step)?.[1].trim();
const job = () => jobBlock(readFileSync(YML, 'utf8'), 'agentic-os');
const stepRunning = (block, re) => steps(block).find((s) => re.test(field(s, 'run') ?? ''));

test('AO1: ccv3-checks.yml defines an agentic-os job', () => {
  assert.ok(job(), 'jobs: has no "agentic-os:" job');
});

for (const script of ['lint', 'typecheck', 'build']) {
  test(`AO2: the agentic-os job runs "npm run ${script}" in ${APP}`, () => {
    const step = stepRunning(job() ?? '', new RegExp(`^npm run ${script}$`));
    assert.ok(step, `no step runs "npm run ${script}"`);
    assert.equal(field(step, 'working-directory'), APP);
  });
}

test('AO3: the install is a lockfile install without scripts, in the app folder', () => {
  const step = stepRunning(job() ?? '', /^npm ci\b/);
  assert.ok(step, 'no "npm ci" step');
  assert.match(field(step, 'run'), /--ignore-scripts/);
  assert.equal(field(step, 'working-directory'), APP);
});

test('AO4: the job runs only when apps/agentic-os or this workflow changed', () => {
  const block = job() ?? '';
  const scope = steps(block).find((s) => field(s, 'id') === 'scope');
  assert.ok(scope, 'no step with id: scope');
  assert.ok(scope.includes(`${APP}/`), 'the scope step does not match the app folder');
  assert.ok(scope.includes('ccv3-checks'), 'the scope step does not match this workflow file');
  for (const script of ['lint', 'typecheck', 'build']) {
    const step = stepRunning(block, new RegExp(`^npm run ${script}$`));
    assert.ok(step && /steps\.scope\.outputs\.run == 'true'/.test(field(step, 'if') ?? ''), `"npm run ${script}" is not gated on the scope step`);
  }
  const install = stepRunning(block, /^npm ci\b/);
  assert.ok(install && /steps\.scope\.outputs\.run == 'true'/.test(field(install, 'if') ?? ''), 'the install is not gated on the scope step');
});

test('AO5: every action is pinned to a full SHA and the job reads no secret', () => {
  const block = job() ?? '';
  const uses = [...block.matchAll(/^\s+- uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 2, 'the job uses no checkout and setup-node');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a SHA`);
  assert.doesNotMatch(block, /secrets\./);
});

test('AO6: the job and every script step have a timeout', () => {
  const block = job() ?? '';
  assert.ok(/^ {4}timeout-minutes:\s*\d+/m.test(block), 'the job has no timeout-minutes');
  for (const script of ['lint', 'typecheck', 'build']) {
    const step = stepRunning(block, new RegExp(`^npm run ${script}$`));
    assert.ok(step && /^\d+$/.test(field(step, 'timeout-minutes') ?? ''), `"npm run ${script}" has no timeout-minutes`);
  }
});
