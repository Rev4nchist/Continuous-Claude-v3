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

  it('tile 6 shows 4 project rows and tile 1 keeps 6 rows (Dave, 2026-11-08)', () => {
    // Breaks if project_rows is missing, is not 4, or tile 1's show_rows changes with it.
    assert.equal(val(cfg, 'project_rows'), 4);
    assert.equal(val(cfg, 'show_rows'), 6);
    assert.ok(row(cfg, 'project_rows').source.length > 0);
  });

  it('the file lists every default target, so the targets document has 14 rows and no key is left to the defaults', () => {
    // Breaks if a default target (such as project_rows) is added to the loader and not to the committed file, or the other way round.
    const fileKeys = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).targets.map((t) => t.key);
    assert.deepEqual([...fileKeys].sort(), normalizeConfig({}).targets.map((t) => t.key).sort());
    assert.equal(cfg.targets.length, 14);
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
