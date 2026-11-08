/**
 * lane-dash-project.test -- the shared projectOf module for the lane dashboard export.
 *
 *   node --test scripts/coordination/lane-dash-project.test.mjs
 *
 * Pure tests: no database. Each test names the change that breaks it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, loadProjectRules, projectOf, UNASSIGNED } from './lane-dash-project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.join(HERE, 'lane-projects.json');
const compile = (projects) => compileRules({ version: 1, projects });

describe('projectOf: sparse rules never throw (defect e)', () => {
  it('a rule with only a key matches nothing and does not throw', () => {
    // Breaks if projectOf reads rule.ids.includes or new RegExp(rule.idRe) without a default.
    const rules = compile([{ key: 'only-key' }]);
    assert.equal(projectOf({ id: 'anything', track: 'x' }, rules), UNASSIGNED);
  });

  it('a missing idRe is skipped, it does not become new RegExp(undefined) that matches every id', () => {
    // Breaks if the code runs new RegExp(undefined): that is /(?:)/ and matches every id.
    const rules = compile([{ key: 'ids-only', ids: ['exact-id'] }, { key: 'other', idRe: '^other-' }]);
    assert.equal(projectOf({ id: 'exact-id' }, rules), 'ids-only');
    assert.equal(projectOf({ id: 'random-lane' }, rules), UNASSIGNED);
    assert.equal(projectOf({ id: 'other-1' }, rules), 'other');
  });

  it('tracks given as a string is treated as no tracks (no substring match)', () => {
    // Breaks if tracks is not normalized to an array: 'review-engine'.includes('review') is true.
    const rules = compile([{ key: 'p', tracks: 'review-engine' }]);
    assert.equal(projectOf({ id: 'x', track: 'review' }, rules), UNASSIGNED);
  });

  it('a lane or rule set with missing fields returns unassigned', () => {
    // Breaks if projectOf dereferences lane.id or the rules object without a guard.
    const rules = compile([{ key: 'p', idRe: '^p-' }]);
    for (const lane of [undefined, null, {}, { id: 42 }, { id: null, track: null }]) {
      assert.equal(projectOf(lane, rules), UNASSIGNED);
    }
    assert.equal(projectOf({ id: 'p-1' }, undefined), UNASSIGNED);
    assert.equal(projectOf({ id: 'p-1' }, { projects: 'nope' }), UNASSIGNED);
  });
});

describe('compileRules: idRe must start with ^ (defect e)', () => {
  it('rejects an idRe that does not start with ^ and names the rule key', () => {
    // Breaks if the ^ check is removed: an unanchored regex matches mid-id.
    assert.throws(() => compile([{ key: 'loose', idRe: 'guard' }]), /loose.*\^/s);
  });

  it('rejects an empty idRe, a lone ^ and a non-string idRe', () => {
    // Breaks if the check is "truthy" instead of "string starting with ^ with a non-empty body".
    for (const idRe of ['', '^', 42, {}]) {
      assert.throws(() => compile([{ key: 'bad', idRe }]), /bad/, JSON.stringify(idRe));
    }
  });

  it('rejects an idRe that parses only because the wrapper balances it', () => {
    // Breaks if new RegExp(idRe) is not run alone first: '^a)|(b' becomes the valid ^(?:a)|(b) when wrapped.
    assert.throws(() => compile([{ key: 'wrapped', idRe: '^a)|(b' }]), /wrapped.*does not parse/s);
  });

  it('rejects a regex that does not parse, naming the rule key', () => {
    // Breaks if new RegExp errors escape without the rule key.
    assert.throws(() => compile([{ key: 'broken', idRe: '^(' }]), /broken/);
  });

  it('anchors every alternative: ^a|b does not match "xb"', () => {
    // Breaks if the module compiles the raw idRe: the second alternative would be unanchored.
    const rules = compile([{ key: 'p', idRe: '^foo-|bar-' }]);
    assert.equal(projectOf({ id: 'bar-1' }, rules), 'p');
    assert.equal(projectOf({ id: 'foo-1' }, rules), 'p');
    assert.equal(projectOf({ id: 'xbar-1' }, rules), UNASSIGNED);
  });

  it('rejects a rule without a key and a duplicate key', () => {
    // Breaks if a keyless rule is accepted: projectOf would return undefined.
    assert.throws(() => compile([{ idRe: '^a-' }]), /key/);
    assert.throws(() => compile([{ key: 'a' }, { key: 'a' }]), /duplicate/i);
  });

  it('rejects the reserved key unassigned', () => {
    // Breaks if a rule can claim the fallback key.
    assert.throws(() => compile([{ key: UNASSIGNED }]), /unassigned/);
  });
});

describe('projectOf: order', () => {
  it('first matching rule wins; ids and idRe run before tracks; tracks only after every rule', () => {
    // Breaks if the track pass is merged into the first pass (an earlier track would beat a later idRe).
    const rules = compile([
      { key: 'a', tracks: ['t'] },
      { key: 'b', idRe: '^b-' },
      { key: 'c', idRe: '^b-' },
    ]);
    assert.equal(projectOf({ id: 'b-1', track: 't' }, rules), 'b');
    assert.equal(projectOf({ id: 'z', track: 't' }, rules), 'a');
    assert.equal(projectOf({ id: 'z', track: 'u' }, rules), UNASSIGNED);
  });
});

describe('the committed lane-projects.json', () => {
  const rules = loadProjectRules(RULES_FILE);

  it('compiles, and no project is greymatter-design (its own board)', () => {
    // Breaks if the file gains a rule with a bad idRe, or the greymatter rule returns.
    assert.ok(rules.projects.length >= 8);
    assert.ok(!rules.projects.some((p) => p.key === 'greymatter-design'));
  });

  it('every terminal lane maps to its own project', () => {
    // Breaks if an idRe edit (for example the guard regex rewrite) drops a terminal lane out of its project.
    for (const p of rules.projects) {
      for (const id of p.terminalLanes) assert.equal(projectOf({ id, track: 'unsorted' }, rules), p.key, `${id} -> ${p.key}`);
    }
  });

  it('every ids entry reaches its own rule, and prepr-coord reaches pr-flow', () => {
    // Breaks if an earlier rule (for example review-engine prepr-) captures an id that a later rule lists.
    for (const p of rules.projects) {
      for (const id of p.ids) assert.equal(projectOf({ id, track: 'unsorted' }, rules), p.key, `ids ${id} -> ${p.key}`);
    }
    for (const id of ['prepr-coord', 'prepr-coord-x']) assert.equal(projectOf({ id, track: 'unsorted' }, rules), 'pr-flow', id);
    assert.equal(projectOf({ id: 'prepr-stamp', track: 'unsorted' }, rules), 'review-engine');
  });

  it('guard ids still map after the idRe was anchored', () => {
    // Breaks if the guard idRe rewrite loses the (^|-)guard(-|$) behaviour.
    for (const id of ['guard-prompt-text-fp', 'package-guard-residuals', 'x-guard', 'a-b-guard-c', 'guard-x']) {
      assert.equal(projectOf({ id, track: 'unsorted' }, rules), 'guard-hardening', id);
    }
    assert.equal(projectOf({ id: 'safeguard-x', track: 'unsorted' }, rules), UNASSIGNED);
  });

  it('a few real ids land where the project map put them', () => {
    // Breaks if a prefix is dropped from a rule.
    const map = { 're-cr-retire-gate': 'review-engine', 'trex-verify': 'trex', 'lane-dashboard': 'lane-board', 'sdlc-os': 'agentic-os-bridge', 'zzz-new-thing': UNASSIGNED };
    for (const [id, want] of Object.entries(map)) assert.equal(projectOf({ id, track: 'unsorted' }, rules), want, id);
  });

  it('loadProjectRules throws a clear error for a missing file and for bad JSON', () => {
    // Breaks if a read error escapes as an unrelated message.
    assert.throws(() => loadProjectRules(path.join(HERE, 'no-such-rules.json')), /no-such-rules/);
    const tmp = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.TEMP || '/tmp'), 'dash-rules-')), 'r.json');
    fs.writeFileSync(tmp, '{not json');
    assert.throws(() => loadProjectRules(tmp), /r\.json/);
  });
});
