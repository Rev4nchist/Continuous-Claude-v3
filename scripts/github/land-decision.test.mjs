// Tests for land-decision.mjs, the land-pr.ps1 check of Dave's land tap. Run: node --test scripts/github/land-decision.test.mjs
// Each case runs the real script against a temp decision store (CCV3_DECISIONS_FILE). Nothing is mocked.
//
// Failure modes:
//   LD1 a PR with no decision lands                              (check must exit 1)
//   LD2 Keep open, Return to draft or a non-land label lands     (check must exit 1)
//   LD3 a tap for an earlier head lands the moved head           (check must exit 1)
//   LD4 a tap for another PR lands this one                      (check must exit 1)
//   LD5 Land now or Land when READY for this head is refused     (check must exit 0)
//   LD6 the tap is not used up after the merge                   (use, then check must exit 1)
//   LD7 use deletes the tap of another PR or head                (the other tap must stay)
//   LD8 a corrupt store lands                                    (check must exit 1)
//   LD9 the refusal text tells Dave to type a command            (no "/pathway <", no "/slot pay")
//   LD10 bad usage exits 0                                       (exit 2)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./land-decision.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const dir = mkdtempSync(join(tmpdir(), 'land-decision-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let storeFile;
let n = 0;
beforeEach(() => { storeFile = join(dir, `decisions-${n++}.json`); });

const run = (args) => spawnSync('node', [script, ...args], { encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: storeFile } });

/** Dave's tap, through the real store: an offer that holds the label, then the decision. */
async function tap(pr, head, label) {
  process.env.CCV3_DECISIONS_FILE = storeFile;
  const s = await import('./lib/decisions.mjs');
  const key = s.decisionKey({ repo: REPO, pr });
  const spec = { header: 'Land', question: 'Land it?', options: [{ label }, { label: 'Some other option' }] };
  assert.equal(s.offerWrite({ step: 'land', key, head, spec }).ok, true);
  assert.deepEqual(s.decisionRecord({ step: 'land', key, head, label }), { ok: true });
}
const check = (pr, head = HEAD) => run(['check', String(pr), '--repo', REPO, '--head', head]);
const use = (pr, head = HEAD) => run(['use', String(pr), '--repo', REPO, '--head', head]);

describe('land-decision', () => {
  it('LD1 refuses a PR with no decision and names the question', () => {
    const r = check(7);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ship-ask\.mjs land --pr 7/);
  });

  it('LD2 refuses Keep open, Return to draft and any other label', async () => {
    for (const label of ['Keep open', 'Return to draft', 'Land never']) {
      await tap(7, HEAD, label);
      assert.equal(check(7).status, 1, label);
    }
  });

  it('LD3 refuses a tap for another head', async () => {
    await tap(7, OTHER, 'Land now (Recommended)');
    assert.equal(check(7, HEAD).status, 1);
  });

  it('LD4 refuses a tap for another PR', async () => {
    await tap(8, HEAD, 'Land now (Recommended)');
    assert.equal(check(7).status, 1);
  });

  it('LD5 accepts Land now and Land when READY for this PR and head', async () => {
    await tap(7, HEAD, 'Land now (Recommended)');
    assert.equal(check(7).status, 0);
    storeFile = join(dir, `decisions-${n++}.json`);
    await tap(7, HEAD, 'Land when READY (Recommended)');
    assert.equal(check(7).status, 0);
  });

  it('LD6 use takes the tap up: the same land is refused after it', async () => {
    await tap(7, HEAD, 'Land now (Recommended)');
    assert.equal(check(7).status, 0);
    assert.equal(use(7).status, 0);
    assert.equal(check(7).status, 1);
  });

  it('LD7 use keeps the taps of another PR and another head', async () => {
    await tap(7, HEAD, 'Land now (Recommended)');
    await tap(8, HEAD, 'Land now (Recommended)');
    await tap(7, OTHER, 'Land now (Recommended)');
    use(7, HEAD);
    assert.equal(check(8).status, 0);
    assert.equal(check(7, OTHER).status, 0);
  });

  it('LD8 refuses when the store is corrupt', () => {
    writeFileSync(storeFile, '{ not json');
    assert.equal(check(7).status, 1);
  });

  it('LD9 no refusal text tells Dave to type a command', () => {
    const r = check(7);
    assert.doesNotMatch(r.stdout + r.stderr, /\/pathway <|\/slot pay|run \/pathway/i);
  });

  it('LD10 bad usage exits 2', () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(['check', 'x', '--head', HEAD]).status, 2);
    assert.equal(run(['check', '7']).status, 2);
    assert.equal(run(['wipe', '7', '--head', HEAD]).status, 2);
  });
});
