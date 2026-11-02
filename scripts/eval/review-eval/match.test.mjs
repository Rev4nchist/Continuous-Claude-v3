// Failure modes (shadow F6-F9, P0 match rules).
//  sF6 double match            -> drop the one-to-one rule
//  sF7 tolerance edge          -> change tol (139 matches CR 130-136, 140 goes to the judge)
//  sF8 rename miss             -> ignore `renames`
//  sF9 downgrade as recall     -> ignore severity (the flag must be set; the caller does not recall it)
//  a different file never matches -> match on titles
//  no-line CR finding goes to the judge, marked low
//  nearest candidate wins, tie to the lower engine start
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEV, isMajor, matchFindings } from './match.mjs';

const cr = (id, file, start, end, sev = 'major') => ({ src: 'cr', id, file, start, end, sev });
const eng = (id, file, start, end, sev = 'major') => ({ src: 'engine', id, file, start, end, sev });

test('sF6 one CR finding and two engine findings on one line make 1 match and 1 engOnly', () => {
  // Breaks when: the one-to-one rule is dropped (both engine findings would match the same CR finding).
  const r = matchFindings([cr('c1', 'a.mjs', 10, 12)], [eng('e1', 'a.mjs', 11, 11), eng('e2', 'a.mjs', 11, 11)]);
  assert.equal(r.matches.length, 1);
  assert.equal(r.engOnly.length, 1);
  assert.equal(r.crOnly.length, 0);
});

test('sF7 tolerance edge: CR 130-136 matches engine 139 but not 140', () => {
  // Breaks when: tol changes from 3 (a bigger tol matches 140, a smaller one drops 139).
  const at = (n) => matchFindings([cr('c', 'a.mjs', 130, 136)], [eng('e', 'a.mjs', n, n)]);
  assert.equal(at(139).matches.length, 1);
  const out = at(140);
  assert.equal(out.matches.length, 0);
  assert.equal(out.toJudge.length, 1);
  assert.equal(out.toJudge[0].candidates[0].id, 'e');
  assert.equal(matchFindings([cr('c', 'a.mjs', 130, 136)], [eng('e', 'a.mjs', 127, 127)]).matches.length, 1);
  assert.equal(matchFindings([cr('c', 'a.mjs', 130, 136)], [eng('e', 'a.mjs', 126, 126)]).matches.length, 0);
});

test('sF8 a renamed path matches through the renames map', () => {
  // Breaks when: matchFindings ignores `renames`.
  const r = matchFindings([cr('c', 'old/a.mjs', 5, 5)], [eng('e', 'new/a.mjs', 5, 5)], { renames: { 'old/a.mjs': 'new/a.mjs' } });
  assert.equal(r.matches.length, 1);
  assert.equal(matchFindings([cr('c', 'old/a.mjs', 5, 5)], [eng('e', 'new/a.mjs', 5, 5)]).matches.length, 0);
});

test('sF9 a CR Major matched by an engine Minor is a severity downgrade', () => {
  // Breaks when: severity is ignored (the flag would be false and the pair would count as a recalled Major).
  const r = matchFindings([cr('c', 'a.mjs', 5, 5, 'major')], [eng('e', 'a.mjs', 5, 5, 'minor')]);
  assert.equal(r.matches[0].severityDowngrade, true);
  const same = matchFindings([cr('c', 'a.mjs', 5, 5, 'critical')], [eng('e', 'a.mjs', 5, 5, 'major')]);
  assert.equal(same.matches[0].severityDowngrade, false);
});

test('severity folds like SEVERITY_OF: critical+major are Major, trivial+nitpick are Minor, info is neither', () => {
  // Breaks when: SEV drifts from review-status SEVERITY_OF (trivial would count as Major) or info is made Major.
  assert.deepEqual([SEV.critical, SEV.major, SEV.minor, SEV.trivial, SEV.nitpick, SEV.info], ['critical', 'major', 'minor', 'minor', 'minor', 'info']);
  assert.equal(isMajor('critical') && isMajor('major'), true);
  assert.equal(isMajor('minor') || isMajor('info') || isMajor('unknown'), false);
});

test('a finding in another file never matches', () => {
  // Breaks when: the file check is dropped from the candidate rule.
  const r = matchFindings([cr('c', 'a.mjs', 5, 5)], [eng('e', 'b.mjs', 5, 5)]);
  assert.equal(r.matches.length, 0);
  assert.equal(r.toJudge.length, 0);
  assert.equal(r.crOnly.length, 1);
  assert.equal(r.engOnly.length, 1);
});

test('a CR finding with no line goes to the judge, marked low, when the file has an engine finding', () => {
  // Breaks when: a body finding with no line is matched on the file alone, or is dropped.
  const r = matchFindings([cr('c', 'a.mjs', null, null)], [eng('e', 'a.mjs', 50, 51)]);
  assert.equal(r.matches.length, 0);
  assert.equal(r.toJudge.length, 1);
  assert.equal(r.toJudge[0].low, true);
});

test('the nearest engine finding wins; a tie goes to the lower start', () => {
  // Breaks when: candidates are taken in input order instead of by distance.
  const near = matchFindings([cr('c', 'a.mjs', 20, 20)], [eng('far', 'a.mjs', 22, 22), eng('near', 'a.mjs', 20, 20)]);
  assert.equal(near.matches[0].eng.id, 'near');
  const tie = matchFindings([cr('c', 'a.mjs', 20, 20)], [eng('hi', 'a.mjs', 22, 22), eng('lo', 'a.mjs', 18, 18)]);
  assert.equal(tie.matches[0].eng.id, 'lo');
});
