/**
 * lane-dash-config.test -- the dashboard config loader.
 *
 *   node --test scripts/coordination/lane-dash-config.test.mjs
 *
 * Defect (a): wip_limit is null unless the config sets a number. Never default 3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeConfig, LIMIT_KEYS } from './lane-dash-config.mjs';
import { loadProjectRules, projectOf } from './lane-dash-project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'lane-dash.config.json');
const val = (cfg, key) => cfg.targets.find((t) => t.key === key)?.value;
const row = (cfg, key) => cfg.targets.find((t) => t.key === key);

describe('wip_limit (defect a)', () => {
  it('is null when the config has no wip_limit row', () => {
    // Breaks if the loader defaults wip_limit to 3 (the export-c.mjs:76 bug).
    const cfg = normalizeConfig({ version: 1, targets: [{ key: 'p0_cap', value: 5, label: 'P0', source: 's' }] });
    assert.equal(val(cfg, 'wip_limit'), null);
  });

  it('is null for an empty config and for no config at all', () => {
    // Breaks if an empty object falls back to a built-in number.
    assert.equal(val(normalizeConfig({}), 'wip_limit'), null);
    assert.equal(val(normalizeConfig(undefined), 'wip_limit'), null);
  });

  it('is null when set to null, and a number when the config sets a number', () => {
    // Breaks if null is coerced (Number(null) is 0) or a set number is ignored.
    const mk = (value) => normalizeConfig({ targets: [{ key: 'wip_limit', value, label: 'w', source: 'Dave' }] });
    assert.equal(val(mk(null), 'wip_limit'), null);
    assert.equal(val(mk(4), 'wip_limit'), 4);
  });

  it('throws on a string, zero, a negative number or NaN-like value', () => {
    // Breaks if "3" is accepted as a number: only a real number sets a limit.
    for (const value of ['3', 0, -1, NaN, Infinity, true, {}]) {
      assert.throws(() => normalizeConfig({ targets: [{ key: 'wip_limit', value }] }), /wip_limit/, String(value));
    }
  });

  it('the two Dave caps follow the same rule', () => {
    // Breaks if only wip_limit is validated.
    assert.deepEqual([...LIMIT_KEYS].sort(), ['dave_queue_cap', 'never_started_cap', 'wip_limit']);
    for (const key of LIMIT_KEYS) {
      assert.equal(val(normalizeConfig({}), key), null, key);
      assert.throws(() => normalizeConfig({ targets: [{ key, value: 'x' }] }), new RegExp(key));
    }
  });
});

describe('the committed lane-dash.config.json', () => {
  const cfg = loadConfig(CONFIG_FILE);

  it('leaves every Dave limit unset (null) until Dave sets one', () => {
    // Breaks if someone commits a proposed number such as wip_limit 3.
    for (const key of LIMIT_KEYS) assert.equal(val(cfg, key), null, key);
  });

  it('every target row has a source text, and the p0 cap is 5', () => {
    // Breaks if a row loses its source column (the page shows where each number came from).
    for (const t of cfg.targets) assert.ok(typeof t.source === 'string' && t.source.length > 0, t.key);
    assert.equal(val(cfg, 'p0_cap'), 5);
  });

  it('tile 6 shows 4 project rows and tile 1 shows 4 wait rows (Dave, 2026-11-08)', () => {
    // Breaks if project_rows or show_rows is missing or is not 4.
    assert.equal(val(cfg, 'project_rows'), 4);
    assert.equal(val(cfg, 'show_rows'), 4);
    assert.ok(row(cfg, 'project_rows').source.length > 0);
  });

  it('the file lists every default target, so the targets document has 15 rows and no key is left to the defaults', () => {
    // Breaks if a default target (such as project_rows) is added to the loader and not to the committed file, or the other way round.
    const fileKeys = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).targets.map((t) => t.key);
    assert.deepEqual([...fileKeys].sort(), normalizeConfig({}).targets.map((t) => t.key).sort());
    assert.equal(cfg.targets.length, 15);
  });

  it('keeps Done projects visible for 28 days and names the board', () => {
    // Breaks if the 4-week rule (defect b) is dropped from the config.
    assert.equal(val(cfg, 'done_visible_days'), 28);
    assert.equal(cfg.board, 'continuous-claude');
    assert.equal(cfg.stale_after_hours, 36);
    assert.equal(cfg.projects_stale_after_hours, 168);
  });
});

describe('loadConfig', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-cfg-'));

  it('a missing file gives the defaults, wip_limit null', () => {
    // Breaks if a missing file throws or defaults a limit.
    const cfg = loadConfig(path.join(tmp, 'nope.json'));
    assert.equal(val(cfg, 'wip_limit'), null);
    assert.equal(row(cfg, 'wip_limit').source.length > 0, true);
  });

  it('a missing file throws when it was asked for by name (required), and names the file', () => {
    // Breaks if an explicit --config typo falls back to the defaults without a word.
    assert.throws(() => loadConfig(path.join(tmp, 'typo.json'), { required: true }), /typo\.json/);
  });

  it('bad JSON throws and names the file', () => {
    // Breaks if a parse error is swallowed and defaults are used silently.
    const f = path.join(tmp, 'bad.json');
    fs.writeFileSync(f, '{oops');
    assert.throws(() => loadConfig(f), /bad\.json/);
  });
});

describe('the real config and the real project rules agree (fleetops-lanes-file-size part 1)', () => {
  const rules = loadProjectRules(path.join(HERE, 'lane-projects.json'));

  it('category_rows shows every category plus "No category yet"', () => {
    // Breaks if a category is added to lane-projects.json and category_rows is not raised: the last row would hide.
    const cap = loadConfig(CONFIG_FILE).targets.find((t) => t.key === 'category_rows').value;
    assert.ok(cap >= rules.projects.length + 1, `category_rows ${cap} < ${rules.projects.length} categories + 1`);
  });

  it('every category has a plain next goal', () => {
    // Breaks if a category loses its next_goal: its row then shows no Next goal line.
    for (const p of rules.projects) assert.ok(p.next_goal.trim().length > 0, p.key);
  });

  it('cards land in the categories of the approved draft (2026-11-13), first match wins', () => {
    // Breaks if a prefix is dropped, or the rule order changes which category a card gets.
    const cases = {
      'coord-drill-2': 'coordination', 'std-coordination': 'coordination', 'say-wake-test': 'coordination', 'keeper-visible-result': 'coordination',
      'prflow-push-blocks': 'pr-flow', 'ready-checks-followups': 'pr-flow', 'create-land-workdir': 'pr-flow',
      'prepr-coordination-gate': 'pr-flow', 'ready-outside-diff': 'review-engine', 'prepr-answer-key-cli-guard': 'review-engine',
      'system-eng-review': 'toolchain-gates', 'sched-tasks-failing-1109': 'toolchain-gates', 'dead-wizard-py-delete': 'toolchain-gates',
      'fleetops-lanes-file-size': 'agentic-os-bridge', 'notion-sync-test': 'agentic-os-bridge', 'harness-price-exact': 'agentic-os-bridge',
      'board-publish-budget': 'lane-board', 'kanban-band-first-live-sync': 'lane-board',
      'sweep-shared-head-once': 'review-engine', 'gold-schema-followups': 'review-engine', 'test-globs-followups': 'review-engine',
      'guards-cd-drive-letter': 'guard-hardening', 'identity-probe-mask-db-url': 'guard-hardening',
      'video-intake': 'unassigned',
    };
    for (const [id, want] of Object.entries(cases)) assert.equal(projectOf({ id, track: null }, rules), want, id);
  });
});
