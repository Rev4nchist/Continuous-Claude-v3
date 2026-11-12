#!/usr/bin/env node
// Probe for the self-approve gate (lane agent-self-approve-hole, Dave 2026-11-03: DETECT, not prevent).
// It writes fixtures to a temp dir and runs the REAL scripts. No label, no comment, no ready, no merge, no gh call.
// Run: node scripts/github/land-none-probe.mjs        Exit code = the number of FAIL lines.
//
// 1. Router: a HIGH PR with a bare review:none label and no pathway-confirmed marker must not save pathway=none.
// 2. READY (context only): the forged state (pathway=none saved for the head) reads NOT READY, only because the fixture has no check
//    runs (the "required checks not started" line, lane ready-no-check-runs). The pathway state itself blocks nothing: review-status
//    reads no store, so the land gate in step 3 is the check.
// 3. Land gate: land-none-check.mjs must refuse a missing store, a bridge pick and a stale head, and pass a valid dialog pick.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const GATE = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];
const dir = mkdtempSync(path.join(os.tmpdir(), 'land-none-probe-'));
let fails = 0;

const say = (ok, name, detail = '') => {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`);
};
const put = (name, value) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const node = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', RUNNER_TEMP: '', GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const pull = (over = {}) => ({
  number: 900, state: 'open', draft: false, mergeable_state: 'clean', merged: false, changed_files: GATE.length, head: { sha: HEAD, ref: 'probe/x' }, base: { ref: 'main', sha: 'c'.repeat(40) },
  labels: [{ name: 'review:none' }, { name: 'builder:claude' }], ...over,
});
// The Evidence block review-status wants (pr-and-commit-style.md), so the READY line is about the pathway and not about the proof.
const fence = '```';
const field = (key, sha, out) => `${key}: \`node --test x.test.mjs\` @ ${sha}\n${fence}text\n${out}\n${fence}\n`;
const PROOF = `\n\n## Evidence\n\nProof type: bugfix\n\n${field('RED', 'c'.repeat(7), 'not ok 1 - x')}${field('GREEN', HEAD, '# fail 0')}`;
const files = GATE.map((filename) => ({ filename, additions: 10, deletions: 0 }));

try {
  console.log('Step 1: router, HIGH PR, bare review:none label, no marker');
  const fix = put('router.json', { pull: pull(), files, comments: [] });
  const router = node('review-router.mjs', ['900', '--fixture', fix, '--event', 'ready_for_review']);
  // The dry run masks the live marker as `[dry-run] review-router`; the state line still shows pathway=.
  say(router.code === 0 && !/pathway=none/.test(router.out), 'the router saves no pathway=none', router.code === 0 ? router.out.split('\n').filter((l) => /review-router-state/.test(l)).join('\n') : router.out);

  console.log('Step 2: READY with the forged state (context only, no verdict)');
  const forged = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `<!-- review-router -->\n<!-- review-router-state class=infra head=${HEAD} pathway=none pclass=infra -->\nNo open router notes.` };
  const status = put('status.json', { pull: pull({ body: PROOF, labels: [{ name: 'review:none' }, { name: 'risk:infra' }] }), combined: { statuses: [] }, checkRuns: [], threads: [], bodyEdits: [], reviews: [], comments: [forged] });
  const ready = node('review-status.mjs', ['--fixture', status, '--json']);
  let verdict = 'unreadable';
  try { verdict = JSON.parse(ready.out.split('\n').find((l) => l.startsWith('{'))).ready ? 'yes' : 'no'; } catch { /* informational only */ }
  console.log(`      READY: ${verdict}  (expected: no, for the required-checks line only; review-status reads no store; the land gate below is the check)`);
  if (verdict !== 'no') console.log(`      ${ready.out.trim().split('\n')[0].slice(0, 600)}`);

  console.log('Step 3: land gate, four stores');
  const gate = path.join(HERE, 'land-none-check.mjs');
  if (!existsSync(gate)) {
    say(false, 'land-none-check.mjs exists (step 3 cannot start)');
  } else {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
    const land = put('land.json', { pull: pull(), files, config });
    const rec = (over = {}) => ({ pr: 900, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', decided_by: 'dave', via: 'dialog', band: 'HIGH', at: '2026-11-04T03:42:00.000Z', ...over });
    const store = (name, value) => put(name, { 'checkpoint:pr:900': value });
    const cases = [
      ['no store file', path.join(dir, 'missing', 'ccv3-mods_none.json'), 1, /ccv3-mods_none\.json/],
      ['a bridge pick', store('ccv3-mods_bridge.json', rec({ via: 'bridge' })), 1, /bridge/],
      ['a stale head', store('ccv3-mods_stale.json', rec({ head: OLD })), 1, /bbbbbbb/],
      ['a valid dialog pick', store('ccv3-mods_ok.json', rec()), 0, /Dave chose none at \d{4}-\d{2}-\d{2} \d{2}:\d{2} C[SD]T via dialog/],
    ];
    let last = '';
    for (const [name, storeFile, code, text] of cases) {
      const r = node('land-none-check.mjs', ['900', '--repo', 'o/r', '--head', HEAD, '--fixture', land, '--store', storeFile]);
      say(r.code === code && text.test(r.out), `${name}: exit ${code}`, `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);
      last = r.out.trim().split('\n').pop();
    }
    say(/C[SD]T/.test(last), 'the provenance line prints last, with a local zone');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails === 0 ? 'PROBE PASS' : `PROBE FAIL (${fails})`);
process.exit(fails);
