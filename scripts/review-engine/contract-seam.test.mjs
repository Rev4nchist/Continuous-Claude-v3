// Tests for lib/contract.mjs (the single seam to the gate-2 contract) and lib/liveness.mjs (the reclaim predicate copy).
// Failure modes:
//   C1 depSql returns something other than the very exports of scripts/coordination/lane-dep.mjs (a copy would drift)
//   C1b a builder in lane-dep.mjs drifts from the pinned text of contract point 4 (alias l, lifecycleWhere e)
//   C2 a bad alias or an ld_ alias is accepted by a builder (it could shadow an inner alias or inject SQL)
//   C3 depSql does not return a replacement module's exports by identity
//   C3b an absent lane-dep.mjs reads as success (it is exit 5: no local fallback copy exists any more)
//   C4 a module that exists but lacks an export reads as "absent" (must not fall back silently)
//   C5 seedParser: an absent module in live mode must not read as "validated"
//   C6 validateSeed passes a duplicate edge, a cycle or a thrown parse
//   L1 reclaimableSql drifts from lane.mjs (today: RECLAIMABLE; later: reclaimableSql(alias))
//   L2 liveness.mjs holds a bare last_heartbeat comparison
// The pinned strings are written out in full. They are the contract text, not a call to the code under test.
// Run: node --test scripts/review-engine/contract-seam.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExitError } from './lib/errors.mjs';
import { blockedStateErrors, depSql, seedParser, validateSeed, DEP_EXPORTS, SEED_FILE_NOTE } from './lib/contract.mjs';
import { ALIVE_AT, reclaimableSql, STALE_MINUTES } from './lib/liveness.mjs';
import * as laneDep from '../coordination/lane-dep.mjs';
import * as laneSeedFile from '../coordination/lane-seed-file.mjs';

const HERE = new URL('.', import.meta.url);
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

const LIFE_E = `(e.kind IN ('done','state_changed') OR (e.kind = 'kanban' AND e.detail->>'kind' = 'state'))`;
const LANDED_L = `(SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = l.id AND (ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) ORDER BY ld_e.id DESC LIMIT 1)`;
const MET_L = `(l.state = 'done' AND COALESCE((SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = l.id AND (ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) ORDER BY ld_e.id DESC LIMIT 1) ~ '^[0-9a-f]{40}$', false))`;
const OPEN_L = `EXISTS (SELECT 1 FROM agentic_os.lane_dep ld_d WHERE ld_d.lane_id = l.id AND NOT EXISTS (SELECT 1 FROM agentic_os.lane ld_x WHERE ld_x.id = ld_d.depends_on AND ld_x.project_key = ld_d.project_key AND (ld_x.state = 'done' AND COALESCE((SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = ld_x.id AND (ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) ORDER BY ld_e.id DESC LIMIT 1) ~ '^[0-9a-f]{40}$', false))))`;
const WAITS_L = `ARRAY(SELECT ld_d.depends_on FROM agentic_os.lane_dep ld_d WHERE ld_d.lane_id = l.id AND NOT EXISTS (SELECT 1 FROM agentic_os.lane ld_x WHERE ld_x.id = ld_d.depends_on AND ld_x.project_key = ld_d.project_key AND (ld_x.state = 'done' AND COALESCE((SELECT ld_e.detail->>'merged' FROM agentic_os.lane_event ld_e WHERE ld_e.lane_id = ld_x.id AND (ld_e.kind IN ('done','state_changed') OR (ld_e.kind = 'kanban' AND ld_e.detail->>'kind' = 'state')) ORDER BY ld_e.id DESC LIMIT 1) ~ '^[0-9a-f]{40}$', false))) ORDER BY ld_d.depends_on)`;

const ABSENT = new URL('./no-such-module.mjs', HERE).href;

// A folder name with a fixed prefix and no space. A normal run removes it in after().
function tempModule(name, text) {
  const dir = mkdtempSync(join(tmpdir(), 're-seam-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return pathToFileURL(file).href;
}

// ---- C1, C2: the module of builder A, through the seam

test('C1 depSql() returns the very functions of lane-dep.mjs (===), all 5', async () => {
  const got = await depSql();
  assert.deepEqual(Object.keys(got).sort(), [...DEP_EXPORTS].sort());
  assert.equal(DEP_EXPORTS.length, 5);
  for (const n of DEP_EXPORTS) {
    assert.equal(typeof laneDep[n], 'function', n);
    assert.strictEqual(got[n], laneDep[n], n);
  }
});

test('C1b the module output for alias l (and lifecycleWhere e) equals the pinned contract text', async () => {
  const sql = await depSql();
  assert.equal(sql.lifecycleWhere('e'), LIFE_E);
  assert.equal(sql.landedShaSql('l'), LANDED_L);
  assert.equal(sql.laneMetSql('l'), MET_L);
  assert.equal(sql.openDepSql('l'), OPEN_L);
  assert.equal(sql.waitsOnSql('l'), WAITS_L);
});

test('C1c another alias changes only the alias, never an inner alias', async () => {
  const sql = await depSql();
  assert.equal(sql.openDepSql('lane'), OPEN_L.replace('ld_d.lane_id = l.id', 'ld_d.lane_id = lane.id'));
  assert.equal(sql.lifecycleWhere('ev'), `(ev.kind IN ('done','state_changed') OR (ev.kind = 'kanban' AND ev.detail->>'kind' = 'state'))`);
});

test('C2 a bad alias or an ld_ alias throws on every builder', async () => {
  const sql = await depSql();
  for (const name of DEP_EXPORTS) {
    for (const bad of ['l; DROP TABLE x', 'ld_x', 'ld_', 'L', '1l', '', 'a.b', "l'"]) {
      assert.throws(() => sql[name](bad), /lane-dep: bad alias/, `${name}(${JSON.stringify(bad)})`);
    }
  }
  assert.throws(() => sql.laneMetSql('ld_x'), /lane-dep: bad alias "ld_x"/);
});

test('C1d the seed seam returns the very functions of lane-seed-file.mjs', async () => {
  const got = await seedParser({ testMode: false });
  assert.strictEqual(got.parseSeedFile, laneSeedFile.parseSeedFile);
  assert.strictEqual(got.findCycle, laneSeedFile.findCycle);
});

// ---- C3, C4: the module checks

test('C3 depSql returns a replacement module exports by identity', async () => {
  const url = tempModule('lane-dep.mjs', DEP_EXPORTS.map((n) => `export const ${n} = (a) => '${n}:' + a;`).join('\n'));
  const mod = await import(url);
  const got = await depSql({ url });
  for (const n of DEP_EXPORTS) assert.strictEqual(got[n], mod[n], n);
  assert.notStrictEqual(got.openDepSql, laneDep.openDepSql);
});

test('C3b an absent lane-dep.mjs is exit 5: there is no local copy to fall back to', async () => {
  await assert.rejects(depSql({ url: ABSENT }), (e) => e instanceof ExitError && e.exitCode === 5 && /lane-dep\.mjs is missing/.test(e.message));
});

test('C4 a module that exists but lacks an export is exit 5, never a silent fallback', async () => {
  const url = tempModule('lane-dep.mjs', `export const laneMetSql = (a) => a;`);
  await assert.rejects(depSql({ url }), (e) => e instanceof ExitError && e.exitCode === 5 && /lifecycleWhere/.test(e.message));
});

test('C4c an export that is not a function counts as missing', async () => {
  const url = tempModule('lane-dep.mjs', DEP_EXPORTS.map((n) => (n === 'waitsOnSql' ? `export const ${n} = 'text';` : `export const ${n} = (a) => a;`)).join('\n'));
  await assert.rejects(depSql({ url }), (e) => e instanceof ExitError && e.exitCode === 5 && /waitsOnSql/.test(e.message));
});

test('C4b a module that exists but throws on import is its own error, not "absent"', async () => {
  const url = tempModule('lane-dep.mjs', `throw new Error('boom from the module');`);
  await assert.rejects(depSql({ url }), /boom from the module/);
});

// ---- C5, C6: the seed parser seam

test('C5 seedParser: an absent module is null in test mode and exit 5 in live mode', async () => {
  assert.equal(await seedParser({ testMode: true, url: ABSENT }), null);
  await assert.rejects(seedParser({ testMode: false, url: ABSENT }), (e) => e instanceof ExitError && e.exitCode === 5 && /nothing written/i.test(e.message));
  assert.match(SEED_FILE_NOTE, /^seed-file: not validated \(scripts\/coordination\/lane-seed-file\.mjs is not on this branch yet\)$/);
});

test('C5b seedParser returns the module functions when the module exists', async () => {
  const url = tempModule('lane-seed-file.mjs', `export const parseSeedFile = () => 1; export const findCycle = () => null;`);
  const got = await seedParser({ testMode: false, url });
  assert.equal(typeof got.parseSeedFile, 'function');
  assert.equal(typeof got.findCycle, 'function');
});

test('C5c a seed module without findCycle is exit 5', async () => {
  const url = tempModule('lane-seed-file.mjs', `export const parseSeedFile = () => 1;`);
  await assert.rejects(seedParser({ testMode: true, url }), (e) => e instanceof ExitError && e.exitCode === 5);
});

const okParser = {
  parseSeedFile: (d) => ({ form: 'object', lanes: d.lanes, edges: d.edges, dropped: 0 }),
  findCycle: () => null,
};

test('C6 validateSeed: a clean file has no errors', () => {
  assert.deepEqual(validateSeed(okParser, [{ id: 'a' }], [{ lane: 'a', dependsOn: 'b' }]), { errors: [] });
});

test('C6b validateSeed: a thrown parse, a dropped duplicate and a cycle are each an error', () => {
  const throws = { ...okParser, parseSeedFile: () => { throw new Error('edge x: bad'); } };
  assert.deepEqual(validateSeed(throws, [], []).errors, ['seed-file: the parser refused the file: edge x: bad']);
  const dup = { ...okParser, parseSeedFile: (d) => ({ form: 'object', lanes: d.lanes, edges: d.edges, dropped: 2 }) };
  assert.match(validateSeed(dup, [], []).errors[0], /2 duplicate edge/);
  const cyc = { ...okParser, findCycle: () => ['a', 'b', 'a'] };
  assert.match(validateSeed(cyc, [], []).errors[0], /cycle a -> b -> a/);
});

test('C6d blockedStateErrors: a seed item with any state but blocked (or none) is an error that names the lane (contract point 2)', () => {
  assert.deepEqual(blockedStateErrors([{ id: 'a', state: 'blocked' }, { id: 'b', state: 'blocked' }]), []);
  assert.deepEqual(blockedStateErrors([{ id: 'a', state: 'blocked' }, { id: 'b', state: 'backlog' }, { id: 'c' }]),
    ["seed-file: lane 'b' has state 'backlog', not 'blocked'", "seed-file: lane 'c' has state 'undefined', not 'blocked'"]);
});

test('C6c validateSeed with the real parser: a clean file passes; a duplicate edge, a cycle and an unknown lane fail', () => {
  const real = { parseSeedFile: laneSeedFile.parseSeedFile, findCycle: laneSeedFile.findCycle };
  const lanes = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(validateSeed(real, lanes, [{ lane: 'a', dependsOn: 'b' }, { lane: 'b', dependsOn: 'ext-x' }]), { errors: [] });
  const dup = validateSeed(real, lanes, [{ lane: 'a', dependsOn: 'b' }, { lane: 'a', dependsOn: 'b' }]);
  assert.match(dup.errors.join('\n'), /1 duplicate edge/);
  const cycle = validateSeed(real, lanes, [{ lane: 'a', dependsOn: 'b' }, { lane: 'b', dependsOn: 'a' }]);
  assert.deepEqual(cycle.errors, ['seed-file: cycle a -> b -> a']);
  const unknown = validateSeed(real, lanes, [{ lane: 'zz', dependsOn: 'a' }]);
  assert.match(unknown.errors[0], /^seed-file: the parser refused the file: .*"zz" is not in lanes/);
});

// ---- L1, L2: liveness copy

// Reads the reclaim template out of lane.mjs source text. Today: const RECLAIMABLE = `...`. Later: reclaimableSql(alias).
// Returns the text with ALIVE_AT and STALE_MINUTES resolved from that same source, the alias 'l' and whitespace collapsed.
function extractReclaimable(text) {
  const today = /const RECLAIMABLE = `([^`]*)`/.exec(text);
  const later = /(?:const reclaimableSql = \(?alias\)? => |function reclaimableSql\(alias\)\s*\{\s*return )`([^`]*)`/.exec(text);
  const tpl = (today ?? later)?.[1];
  if (tpl === undefined) throw new Error('neither RECLAIMABLE nor reclaimableSql(alias) found');
  const alive = /const ALIVE_AT = \(alias = ''\) => `([^`]*)`/.exec(text)?.[1];
  const stale = /const STALE_MINUTES = (\d+);/.exec(text)?.[1];
  const out = tpl
    .replaceAll("${ALIVE_AT('s.')}", (alive ?? '').replaceAll('${alias}', 's.'))
    .replaceAll('${STALE_MINUTES}', stale ?? '')
    .replaceAll('${alias}', 'l');
  if (out.includes('${')) throw new Error(`unresolved template part in: ${out.slice(out.indexOf('${'), out.indexOf('${') + 30)}`);
  return norm(out);
}
const norm = (s) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

test('L1 reclaimableSql equals the template in lane.mjs (source compare)', () => {
  const text = readFileSync(new URL('../coordination/lane.mjs', HERE), 'utf8');
  assert.equal(norm(reclaimableSql('l')), extractReclaimable(text));
  assert.equal(/const STALE_MINUTES = (\d+);/.exec(text)[1], String(STALE_MINUTES));
  assert.equal(norm(ALIVE_AT('s.')), 'GREATEST(s.last_heartbeat, s.last_activity_at)');
});

test('L1b the extractor reads the future reclaimableSql(alias) form', () => {
  const future = [
    'const STALE_MINUTES = 5;',
    "const ALIVE_AT = (alias = '') => `GREATEST(${alias}last_heartbeat, ${alias}last_activity_at)`;",
    'const reclaimableSql = (alias) => `(',
    '  ${alias}.owner_session_id IS NULL',
    "  AND ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'",
    ')`;',
  ].join('\n');
  assert.equal(extractReclaimable(future), "(l.owner_session_id IS NULL AND GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '5 minutes')");
});

test('L1c the extractor throws when neither form is in the text', () => {
  assert.throws(() => extractReclaimable('const NOTHING = 1;'), /neither RECLAIMABLE nor reclaimableSql/);
});

test('L1d the drift check fails when the copy differs from the source', () => {
  const text = readFileSync(new URL('../coordination/lane.mjs', HERE), 'utf8');
  const drifted = text.replace("interval '${STALE_MINUTES} minutes'", "interval '${STALE_MINUTES} seconds'");
  assert.notEqual(norm(reclaimableSql('l')), extractReclaimable(drifted));
});

test('L1e reclaimableSql takes the alias on every owner and lease column', () => {
  const sql = reclaimableSql('o');
  assert.match(sql, /o\.owner_session_id IS NULL/);
  assert.match(sql, /o\.lease_expires_at/);
  assert.equal(/\bl\./.test(sql), false);
  assert.throws(() => reclaimableSql('o; DROP'), /bad alias/);
});

test('L2 liveness.mjs and its output use GREATEST and hold no bare heartbeat comparison', () => {
  const BARE = [
    /last_heartbeat\s*(?:>=|<=|>|<)\s*(?:NOW|now)\s*\(\)/,
    /(?:NOW|now)\s*\(\)[^;\n]{0,60}?(?:>=|<=|>|<)\s*last_heartbeat/,
  ];
  const source = readFileSync(new URL('./lib/liveness.mjs', HERE), 'utf8');
  assert.match(source, /GREATEST\(/);
  for (const text of [source, reclaimableSql('l')]) {
    for (const re of BARE) assert.equal(re.test(text), false, String(re));
  }
  assert.match(reclaimableSql('l'), /GREATEST\(s\.last_heartbeat, s\.last_activity_at\)/);
});
