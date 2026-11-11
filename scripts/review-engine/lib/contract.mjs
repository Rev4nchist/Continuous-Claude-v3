// The single seam to the gate-2 contract (scripts/coordination/lane-dep.mjs and lane-seed-file.mjs).
// Nothing else in scripts/review-engine names those modules.
// depSql() returns the exports of lane-dep.mjs. The pinned SQL text of contract point 4 lives only in contract-seam.test.mjs,
// which pins the module output, so drift in lane-dep.mjs is caught there.
// A module that exists but is broken is its own error, never "absent": the decision is existsSync, not a caught import error.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExitError } from './errors.mjs';

export const DEP_EXPORTS = ['landedShaSql', 'laneMetSql', 'openDepSql', 'waitsOnSql', 'lifecycleWhere'];
const DEP_URL = new URL('../../coordination/lane-dep.mjs', import.meta.url).href;
const SEED_URL = new URL('../../coordination/lane-seed-file.mjs', import.meta.url).href;
export const SEED_FILE_NOTE = 'seed-file: not validated (scripts/coordination/lane-seed-file.mjs is not on this branch yet)';
const SEED_MISSING = 'seed-file: scripts/coordination/lane-seed-file.mjs is missing (gate-2 contract commit not on this branch). Nothing written.';
const DEP_MISSING = 'contract module scripts/coordination/lane-dep.mjs is missing (gate-2 contract commit not on this branch).';

const present = (url) => existsSync(fileURLToPath(url));

// The 5 builders: the module exports, by identity. An absent module, or one without all 5 functions, is ExitError(5).
export async function depSql({ url = DEP_URL } = {}) {
  if (!present(url)) throw new ExitError(5, DEP_MISSING);
  const mod = await import(url);
  const missing = DEP_EXPORTS.filter((name) => typeof mod[name] !== 'function');
  if (missing.length) throw new ExitError(5, `contract module lane-dep.mjs has no export ${missing.join(', ')}; it is not the gate-2 contract.`);
  return Object.fromEntries(DEP_EXPORTS.map((name) => [name, mod[name]]));
}

// { parseSeedFile, findCycle } from lane-seed-file.mjs.
// An absent module: null in test mode (the caller adds SEED_FILE_NOTE and still writes the file); ExitError(5) in live mode.
// A module that exists without both functions is ExitError(5) in either mode.
export async function seedParser({ testMode = false, url = SEED_URL } = {}) {
  if (!present(url)) {
    if (testMode) return null;
    throw new ExitError(5, SEED_MISSING);
  }
  const mod = await import(url);
  if (typeof mod.parseSeedFile !== 'function' || typeof mod.findCycle !== 'function') {
    throw new ExitError(5, 'contract module lane-seed-file.mjs has no parseSeedFile and findCycle; it is not the gate-2 contract.');
  }
  return { parseSeedFile: mod.parseSeedFile, findCycle: mod.findCycle };
}

// Contract point 2: every item of the program seed is state 'blocked', with no exception (the parser does not check state).
export function blockedStateErrors(items) {
  return items.filter((i) => i.state !== 'blocked').map((i) => `seed-file: lane '${i.id}' has state '${i.state}', not 'blocked'`);
}

// Runs the parser on the payload the program will write. Pure given the parser. Returns { errors: [string] }.
// parseSeedFile returns { form, lanes, edges, dropped } for the object form and throws on a bad file.
// The program computes its edges without duplicates, so dropped > 0 is an error; a cycle is an error with its path.
export function validateSeed(parser, items, edges) {
  let parsed;
  try {
    parsed = parser.parseSeedFile({ lanes: items, edges });
  } catch (e) {
    return { errors: [`seed-file: the parser refused the file: ${e.message}`] };
  }
  const errors = [];
  if (parsed.dropped > 0) errors.push(`seed-file: ${parsed.dropped} duplicate edge(s) in the computed edges; buildEdges must give none`);
  const cycle = parser.findCycle(parsed.edges ?? []);
  if (cycle) errors.push(`seed-file: cycle ${cycle.join(' -> ')}`);
  return { errors };
}
