/**
 * coord-drill-2 / scenarios.test.mjs -- the verdict logic of rows 3, 5 and 7, with no database and no child process.
 *
 *   node --test scripts/coordination/coord-drill-2/scenarios.test.mjs
 *
 * Failure modes, one test each:
 *   row 5   a probe changed the lane and another probe faulted: the FAIL reason hides the fault (critic 9).
 *   row 7   a non-zero exit that is not the known refusal but names "lane note" or "SendMessage" reads PASS (critic 10).
 *   row 3   the Edit control accepts a deny that does not name session A; a BREAK-GLASS warn counts as a stop;
 *           A's own first Edit is a deny or a warn and the row goes on (critic 11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ctlOk = { name: 'c', ok: true, detail: 'd' };

// ---------------------------------------------------------------- row 5

const probe = (over) => ({ fault: false, refused: true, changed: false, evidence: { code: 4 }, ...over });
const base5 = { id: '5', title: 't', rule: 'L2.10' };

test('row 5: one probe changed the lane and another faulted -> FAIL, and the reason and evidence name the faulted probe', async () => {
  const { finalRow } = await import('./s5-as-override.mjs');
  const row = finalRow({
    base: base5, ctlRow: ctlOk, evidence: { e: 1 },
    probes: [['state --override', probe({ changed: true, refused: false })], ['--as <holder>', probe({ fault: true, refused: false })], ['release --override', probe()]],
  });
  assert.equal(row.verdict, 'FAIL');
  assert.match(row.reason, /state --override/);
  assert.match(row.reason, /--as <holder>.*fault/i);
  assert.deepEqual(row.evidence.faulted, ['--as <holder>']);
});

test('row 5: all refused -> PASS; none changed and one faulted -> ERROR; a change and no fault -> FAIL without a fault note', async () => {
  const { finalRow } = await import('./s5-as-override.mjs');
  const three = (a, b, c) => [['state --override', a], ['--as <holder>', b], ['release --override', c]];
  assert.equal(finalRow({ base: base5, ctlRow: ctlOk, evidence: {}, probes: three(probe(), probe(), probe()) }).verdict, 'PASS');
  assert.equal(finalRow({ base: base5, ctlRow: ctlOk, evidence: {}, probes: three(probe(), probe({ fault: true, refused: false }), probe()) }).verdict, 'ERROR');
  const f = finalRow({ base: base5, ctlRow: ctlOk, evidence: {}, probes: three(probe({ changed: true, refused: false }), probe(), probe()) });
  assert.equal(f.verdict, 'FAIL');
  assert.doesNotMatch(f.reason, /fault/i);
});

// ---------------------------------------------------------------- row 7

const base7 = { id: '7', title: 't', rule: 'M4.12/L2.9' };
const say7 = (code, err, out = '') => ({ code, err, out });
const judge7 = async (second, n1 = 1, n2 = 1) => (await import('./s7-parked-say.mjs')).judge({ base: base7, ctl: ctlOk, second, n1, n2, evidence: {} });

test('row 7: the known refusal with no fallback is FAIL; the known refusal that names a fallback is PASS', async () => {
  assert.equal((await judge7(say7(1, 'no recent session matching "x"'))).verdict, 'FAIL');
  assert.equal((await judge7(say7(1, 'no recent session matching "x". Use SendMessage or lane note'))).verdict, 'PASS');
});

test('row 7: a non-zero exit with a fallback word but NOT the known refusal is ERROR, never PASS', async () => {
  assert.equal((await judge7(say7(1, 'lane note failed: something else broke'))).verdict, 'ERROR');
  assert.equal((await judge7(say7(1, 'SendMessage is not available here'))).verdict, 'ERROR');
});

test('row 7: delivery is PASS; exit 0 with no new event is ERROR', async () => {
  assert.equal((await judge7(say7(0, '', 'sent to x'), 1, 2)).verdict, 'PASS');
  assert.equal((await judge7(say7(0, '', 'sent to x'), 1, 1)).verdict, 'ERROR');
});

// ---------------------------------------------------------------- row 3

const call = (kind, text = '') => ({ kind, text, note: text, err: '' });

test('row 3: the Edit control must be a deny that names session A', async () => {
  const { checkControl } = await import('./s3-shell-write.mjs');
  const ids = { a: 'drill-run-s3-a', b: 'drill-run-s3-b' };
  assert.doesNotThrow(() => checkControl(call('deny', `held by ${ids.a}`), ids));
  assert.throws(() => checkControl(call('deny', 'denied for another reason'), ids), /does not name session A/);
  assert.throws(() => checkControl(call('warn', '[WARN] BREAK-GLASS: forced'), ids));
  assert.throws(() => checkControl(call('continue'), ids));
});

test('row 3: a BREAK-GLASS warn is a fault in A\'s Edit and in a shell call, not a stop', async () => {
  const { checkAEdit, failingGates } = await import('./s3-shell-write.mjs');
  const breakGlass = call('warn', '[WARN] BREAK-GLASS: forced the lock for "f.ts" away from session x');
  assert.throws(() => checkAEdit(breakGlass), /BREAK-GLASS/);
  assert.throws(() => checkAEdit(call('deny', 'held')), /denied/i);
  assert.doesNotThrow(() => checkAEdit(call('continue')));
  const matchers = ['Edit|Write|Bash|PowerShell'];
  assert.throws(() => failingGates({ bash: breakGlass, ps: call('deny') }, matchers), /BREAK-GLASS/);
  // A plain warn from a new shell guard is still a stop (the gap is closed).
  assert.deepEqual(failingGates({ bash: call('warn', '[WARN] shell write to a held file'), ps: call('deny') }, matchers), []);
});
