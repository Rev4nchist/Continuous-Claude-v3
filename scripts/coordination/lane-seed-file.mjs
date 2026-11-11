/**
 * lane-seed-file -- parse and check a `lane.mjs seed` file. Pure: no I/O, no database.
 * It takes the result of JSON.parse, not a path.
 *
 *   parseSeedFile(data)  { form: 'array', lanes } | { form: 'object', lanes, edges, dropped }
 *   findCycle(edges)     null, or an id path that starts and ends with the same id
 *
 * Two forms: an array of lanes (upsert only), or an object { lanes, edges } (upsert, then replace the edges).
 * The parser throws on File rules 1 to 5. It does not check lane items (checkSeedItems in lane.mjs does)
 * and it does not check `state` (a program rule, not a lane.mjs rule).
 * Contract: .claudedocs/re-execution/contracts/t2.1-contract.md, "Point 2".
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/; // the lane id rule (BOARD_KEY_RE in lane.mjs)
const EDGE_KEYS = ['dependsOn', 'lane'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Compare the key arrays, not a joined string: one key named 'dependsOn,lane' must not pass.
const sameKeys = (o, keys) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
};

/** Rule 1: the object form has exactly the keys `lanes` and `edges`, both arrays. */
function checkObjectShape(data) {
  for (const key of ['lanes', 'edges']) {
    if (!(key in data)) throw new Error(`seed file object: missing key "${key}"`);
  }
  for (const key of Object.keys(data)) {
    if (key !== 'lanes' && key !== 'edges') throw new Error(`seed file object: unknown key "${key}"`);
  }
  for (const key of ['lanes', 'edges']) {
    if (!Array.isArray(data[key])) throw new Error(`seed file object: "${key}" must be an array`);
  }
}

/** Rule 2: each lane id occurs once. Returns the set of ids. */
function laneIdSet(items) {
  const ids = new Set();
  for (const it of items) {
    const id = it?.id;
    if (typeof id !== 'string') continue; // the id rule for items is checkSeedItems in lane.mjs
    if (ids.has(id)) throw new Error(`seed file lanes: duplicate lane id "${id}"`);
    ids.add(id);
  }
  return ids;
}

/** Rules 3 to 5 for one edge. */
function checkEdge(e, at, ids) {
  if (!isPlainObject(e)) throw new Error(`seed file ${at} must be an object`);
  if (!sameKeys(e, EDGE_KEYS)) throw new Error(`seed file ${at} must have exactly the keys "lane" and "dependsOn"`);
  for (const key of ['lane', 'dependsOn']) {
    if (typeof e[key] !== 'string' || !ID_RE.test(e[key])) {
      throw new Error(`seed file ${at} ${key} ${JSON.stringify(e[key])} is not a valid lane id`);
    }
  }
  if (!ids.has(e.lane)) throw new Error(`seed file ${at}: lane "${e.lane}" is not in lanes`);
  if (e.lane === e.dependsOn) throw new Error(`seed file ${at}: "${e.lane}" depends on itself`);
}

/** Check every edge, then drop the duplicates. Keeps the first of each, in file order. */
function dedupeEdges(edges, ids) {
  const seen = new Set();
  const kept = [];
  edges.forEach((e, i) => {
    checkEdge(e, `edges[${i}]`, ids);
    const key = `${e.lane}\n${e.dependsOn}`;
    if (seen.has(key)) return;
    seen.add(key);
    kept.push({ lane: e.lane, dependsOn: e.dependsOn });
  });
  return { kept, dropped: edges.length - kept.length };
}

/**
 * Parse a seed file that JSON.parse already read. Throws on File rules 1 to 5.
 * A wrong top-level type keeps the old words "JSON array of lanes" (lane.mjs checkSeedItems).
 */
export function parseSeedFile(data) {
  if (Array.isArray(data)) return { form: 'array', lanes: data };
  if (!isPlainObject(data)) {
    throw new Error('seed file must hold a JSON array of lanes, or an object with "lanes" and "edges"');
  }
  checkObjectShape(data);
  const ids = laneIdSet(data.lanes);
  const { kept, dropped } = dedupeEdges(data.edges, ids);
  return { form: 'object', lanes: data.lanes, edges: kept, dropped };
}

/** Depth-first walk from `id`. `stack` holds the ids on the current path. Returns a cycle path or null. */
function walk(id, graph, state, stack) {
  state.set(id, 'open');
  stack.push(id);
  for (const next of graph.get(id) ?? []) {
    if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
    if (!state.has(next)) {
      const found = walk(next, graph, state, stack);
      if (found) return found;
    }
  }
  stack.pop();
  state.set(id, 'done');
  return null;
}

/**
 * Find a cycle in the edges (lane -> dependsOn). Returns null, or an id path that starts and ends with the
 * same id. It visits ids in sorted order, so the answer does not depend on the edge order.
 */
export function findCycle(edges) {
  const graph = new Map();
  for (const { lane, dependsOn } of edges) {
    if (!graph.has(lane)) graph.set(lane, []);
    graph.get(lane).push(dependsOn);
  }
  for (const list of graph.values()) list.sort();
  const state = new Map();
  for (const id of [...graph.keys()].sort()) {
    if (state.has(id)) continue;
    const found = walk(id, graph, state, []);
    if (found) return found;
  }
  return null;
}
