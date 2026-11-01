/**
 * state-table.mjs - the completeness check for a state x event table (check C5).
 *
 * A table test lists every state, every event, and one cell per pair. A cell either runs and asserts
 * ({ state, event, expect, run }, with a non-empty `expect`), or is `na` with a written reason ({ state, event, na }).
 * A table also names, for each kind of state bug, the events that cover it (an array of event ids), or
 * { na: '<reason>' }. `tableProblems` returns what is missing; a table test asserts that it returns [].
 *
 * The mod tests cannot import this file (a plugin test may not load a file outside its folder), so
 * .claude/plugins/ccv3-mods/tests/state-table.ts holds a twin with the same two checks. Change both together.
 */
export const KINDS = ['stale-read', 'duplicate', 'second-entry', 'timer-overlap', 'retained-flag'];

const hasReason = (na) => typeof na === 'string' && na.trim() !== '';

function cellProblems(states, events, cells) {
  const problems = [];
  const seen = new Set();
  for (const c of cells) {
    if (!states.includes(c.state)) problems.push(`unknown state ${c.state} in cell ${c.state} + ${c.event}`);
    if (!events.includes(c.event)) problems.push(`unknown event ${c.event} in cell ${c.state} + ${c.event}`);
    const key = `${c.state} + ${c.event}`;
    if (seen.has(key)) problems.push(`repeated cell ${key}`);
    seen.add(key);
    if ('na' in c && !hasReason(c.na)) problems.push(`cell ${key}: na needs a reason`);
    if (!('na' in c) && !hasReason(c.expect)) problems.push(`cell ${key}: a cell that runs needs an expect`);
  }
  for (const s of states) for (const e of events) if (!seen.has(`${s} + ${e}`)) problems.push(`missing cell ${s} + ${e}`);
  return problems;
}

function kindProblems(events, cells, kinds, required) {
  const problems = [];
  for (const kind of required) {
    const cover = kinds?.[kind];
    if (Array.isArray(cover) && cover.length > 0) {
      for (const e of cover) {
        if (!events.includes(e)) problems.push(`kind ${kind}: unknown event ${e}`);
        else if (!cells.some((c) => c.event === e && !('na' in c))) problems.push(`kind ${kind}: event ${e} has no cell that runs`);
      }
    } else if (cover && !Array.isArray(cover) && 'na' in cover) {
      if (!hasReason(cover.na)) problems.push(`kind ${kind}: na needs a reason`);
    } else {
      problems.push(`kind ${kind} has no event that covers it and no na reason`);
    }
  }
  return problems;
}

/** @returns {string[]} one line per problem; [] means the table is complete. */
export function tableProblems({ states, events, cells, kinds, required = KINDS }) {
  return [...cellProblems(states, events, cells), ...kindProblems(events, cells, kinds, required)];
}
