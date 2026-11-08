/**
 * lane-dash-project -- which work project a lane belongs to, for the lane dashboard export.
 *
 * "Project" is not a column. This module reads a rules file (lane-projects.json) and gives each lane one project key.
 *   Pass 1: for each rule in order, a lane matches when its id matches `idRe` or is in `ids`. First match wins.
 *   Pass 2: for each rule in order, a lane matches when its track is in `tracks`.
 *   Else:   'unassigned'.
 *
 * Two functions, two contracts.
 *   compileRules / loadProjectRules  fail fast. A bad rule throws, and the message names the rule key.
 *   projectOf                        never throws. A sparse rule, a sparse lane or no rules gives 'unassigned'.
 *
 * `idRe` rules (the bugs this module exists to prevent):
 *   - A missing `idRe` is skipped. It is never passed to new RegExp(undefined), which matches every id.
 *   - `idRe` must be a string that starts with ^. A loose regex would match in the middle of an id.
 *   - The whole pattern is compiled as ^(?:...), so every alternative is anchored, not just the first.
 *   - A pattern that matches the empty id is refused: anchored, it would match every id.
 *   - `ids`, `tracks` and `terminalLanes` default to []. A value that is not an array becomes [].
 *     A string would otherwise match by substring through String.prototype.includes.
 *
 * Importing this file does no I/O.
 */
import { readFileSync } from 'node:fs';

export const UNASSIGNED = 'unassigned';

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : []);

function compileIdRe(key, idRe) {
  if (idRe === undefined || idRe === null) return null;
  if (typeof idRe !== 'string' || !idRe.startsWith('^') || idRe.length < 2) {
    throw new Error(`rule '${key}': idRe must be a string that starts with ^ and has a pattern after it (got ${JSON.stringify(idRe)})`);
  }
  let re;
  try {
    new RegExp(idRe); // alone first: '^a)|(b' parses only after the wrapper below balances it
    re = new RegExp(`^(?:${idRe.slice(1)})`);
  } catch (e) {
    throw new Error(`rule '${key}': idRe does not parse: ${e.message}`);
  }
  if (re.test('')) throw new Error(`rule '${key}': idRe matches the empty id, so it would match every id`);
  return re;
}

/** Validate and compile a parsed rules object. Throws on the first bad rule. */
export function compileRules(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.projects)) throw new Error('rules: expected an object with a "projects" array');
  const seen = new Set();
  const projects = raw.projects.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error(`rules: project #${i} is not an object`);
    const key = p.key;
    if (typeof key !== 'string' || !key) throw new Error(`rules: project #${i} has no key`);
    if (key === UNASSIGNED) throw new Error(`rule '${key}': the key '${UNASSIGNED}' is reserved for lanes no rule matches`);
    if (seen.has(key)) throw new Error(`rules: duplicate key '${key}'`);
    seen.add(key);
    return {
      key,
      name: typeof p.name === 'string' ? p.name : key,
      goal: typeof p.goal === 'string' ? p.goal : '',
      done: typeof p.done === 'string' ? p.done : '',
      idRe: typeof p.idRe === 'string' ? p.idRe : null,
      re: compileIdRe(key, p.idRe),
      ids: strings(p.ids),
      tracks: strings(p.tracks),
      terminalLanes: strings(p.terminalLanes),
      parked: p.parked === true,
      proposed: p.proposed === true,
      focus: p.focus === true,
    };
  });
  return { version: raw.version ?? 1, projects };
}

/** Read, parse and compile a rules file. Every error names the file. */
export function loadProjectRules(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  try {
    return compileRules(raw);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/** The project key for a lane ({id, track}). Never throws. */
export function projectOf(lane, rules) {
  const id = typeof lane?.id === 'string' ? lane.id : null;
  const track = typeof lane?.track === 'string' ? lane.track : null;
  const list = Array.isArray(rules?.projects) ? rules.projects : [];
  if (id !== null) {
    for (const p of list) {
      if ((p?.re instanceof RegExp && p.re.test(id)) || (Array.isArray(p?.ids) && p.ids.includes(id))) return p.key;
    }
  }
  if (track !== null) {
    for (const p of list) if (Array.isArray(p?.tracks) && p.tracks.includes(track)) return p.key;
  }
  return UNASSIGNED;
}
