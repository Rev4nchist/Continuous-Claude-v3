// Rank input for seed-file: lane id to priority. Pure: a parsed JSON value in, { rank, errors, notes } out.
// Two shapes:
//   a flat object { "<lane id>": <whole number 1..999> }, the range of scripts/coordination/lane-band.mjs;
//   a packages.json: packageOrder.ids names packages, each package has an id and lanes[]. The ids are flattened in
//   packageOrder order, and the lane at position k (0-based, externals included) gets priority 10 + k.
// An unknown lane is an error (the caller exits 2). An external is noted and not written: externals are not seed items.

const MIN = 1;
const MAX = 999;
const BASE = 10;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPackages = (v) => isObject(v) && Array.isArray(v.packages) && Array.isArray(v.packageOrder?.ids);
const inRange = (n) => Number.isInteger(n) && n >= MIN && n <= MAX;

// [[id, value]] in rank order, plus the errors found while reading the shape.
function flatPairs(json) {
  return { pairs: Object.entries(json), errors: [] };
}

function packagePairs(json) {
  const byId = new Map(json.packages.map((p) => [p.id, p]));
  const pairs = [];
  const errors = [];
  for (const pid of json.packageOrder.ids) {
    const pkg = byId.get(pid);
    if (!pkg) errors.push(`rank: packageOrder names package '${pid}', which packages[] does not have`);
    for (const id of pkg?.lanes ?? []) pairs.push([id, BASE + pairs.length]);
  }
  return { pairs, errors };
}

function judge(id, value, model, out) {
  if (!inRange(value)) {
    out.errors.push(`rank: '${id}' has value ${JSON.stringify(value)}; want a whole number from ${MIN} to ${MAX}`);
    return;
  }
  if (model.externals.some((e) => e.id === id)) {
    out.notes.push(`rank ${value} for ${id} is not written: externals are not seed items`);
  } else if (!model.lanes.some((l) => l.id === id)) {
    out.errors.push(`rank: '${id}' is not a map lane`);
  } else if (id in out.rank) {
    out.notes.push(`rank: '${id}' appears more than once; the first value ${out.rank[id]} is kept`);
  } else {
    out.rank[id] = value;
  }
}

function sharedNotes(rank) {
  const byValue = new Map();
  for (const [id, v] of Object.entries(rank)) byValue.set(v, [...(byValue.get(v) ?? []), id]);
  return [...byValue].filter(([, ids]) => ids.length > 1).map(([v, ids]) => `rank ${v} is shared by ${ids.join(', ')}`);
}

export function rankOf(json, model) {
  const out = { rank: {}, errors: [], notes: [] };
  if (!isObject(json)) {
    out.errors.push('rank: the file must hold a JSON object (a flat id-to-number object, or a packages.json)');
    return out;
  }
  const { pairs, errors } = isPackages(json) ? packagePairs(json) : flatPairs(json);
  out.errors.push(...errors);
  for (const [id, value] of pairs) judge(id, value, model, out);
  out.notes.push(...sharedNotes(out.rank));
  return out;
}
