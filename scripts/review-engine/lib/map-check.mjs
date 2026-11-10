// Lint rules for a parsed review-engine map. Pure: a model in, findings out. No I/O.
// A finding is { rule, lane, line, message }. Errors fail the check; notes do not.
// examined counts what each rule group looked at, so a pass over zero items shows.
import { entriesOverlap, ownsMatch } from './owns.mjs';
import { parseDeps } from './map-parse.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CHANGES = ['new', 'changed', 'unchanged', 'deferred'];
const REQUIRED = ['Depends on', 'Unblocks', 'Related', 'Owns', 'Do not touch', 'Cost', 'Needs Dave', 'Scope', 'Done when', 'Why'];
// GROUPS: a zero count means the rule saw nothing, so it adds a 'vacuous' note. COUNTERS also count chainUnparsed,
// where zero is the good state.
const GROUPS = ['ownerChains', 'ownerPhrases', 'overlapPairs', 'deps', 'heldTokens', 'sections', 'rows', 'dropped'];
const COUNTERS = [...GROUPS, 'chainUnparsed'];
// Two Owns entries on one path may skip the dependency-path rule only when both scopes name keys.
const KEY_SCOPE = /\bkeys? only\b/;

const finding = (rule, lane, line, message) => ({ rule, lane, line, message });
const listText = (deps) => (deps.length ? deps.join(', ') : 'none');

// Waves edges only. Holds are not edges. Externals have no edges.
function depMap(model) {
  const deps = new Map();
  for (const l of model.lanes) if (!deps.has(l.id)) deps.set(l.id, l.deps);
  for (const e of model.externals) if (!deps.has(e.id)) deps.set(e.id, []);
  return deps;
}

function closureOf(deps, id) {
  const seen = new Set();
  const todo = [...(deps.get(id) ?? [])];
  while (todo.length) {
    const d = todo.pop();
    if (seen.has(d)) continue;
    seen.add(d);
    todo.push(...(deps.get(d) ?? []));
  }
  return seen;
}

export const closure = (model, id) => closureOf(depMap(model), id);

// ctx: lookup tables shared by every rule group. rows keeps the first row of each id.
function buildCtx(model) {
  const rows = new Map();
  for (const l of model.lanes) if (!rows.has(l.id)) rows.set(l.id, l);
  const nodes = [...rows.values()].map((l) => ({ id: l.id, wave: l.wave, section: l.section }));
  for (const e of model.externals) if (!rows.has(e.id)) nodes.push({ id: e.id, wave: 0, section: e.section });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = depMap(model);
  const cache = new Map();
  const reach = (id) => {
    if (!cache.has(id)) cache.set(id, closureOf(deps, id));
    return cache.get(id);
  };
  return {
    model, rows, nodes, byId, reach,
    checked: [...rows.values()].filter((l) => l.cellCount === 7),
    dropped: new Set(model.dropped.map((d) => d.id)),
    examined: Object.fromEntries(COUNTERS.map((g) => [g, 0])),
  };
}

const ownsOf = (ctx, id) => ctx.byId.get(id)?.section?.owns ?? [];

// Rule group: one Waves row at a time.
function checkRows(ctx, out) {
  const seen = new Map();
  for (const l of ctx.model.lanes) {
    if (l.cellCount !== 7) continue;
    ctx.examined.rows++;
    const bad = (rule, message) => out.errors.push(finding(rule, l.id, l.line, message));
    if (l.wave === null) bad('bad-wave', `Waves line ${l.line}: wave '${l.waveRaw}' is not a whole number`);
    if (!ID_RE.test(l.id)) bad('bad-id', `lane '${l.id}': id must match ^[a-z0-9][a-z0-9-]*$ (lane.mjs seed rule, lane.mjs:178)`);
    if (seen.has(l.id)) bad('dup-lane', `lane '${l.id}': two Waves rows (lines ${seen.get(l.id)}, ${l.line})`);
    else seen.set(l.id, l.line);
    if (!['yes', ''].includes(l.needsDaveRaw)) bad('needs-dave', `lane '${l.id}': Needs Dave '${l.needsDaveRaw}' is not 'yes' or empty`);
    if (!CHANGES.includes(l.change)) bad('change', `lane '${l.id}': Change '${l.change}' is not new, changed, unchanged or deferred`);
  }
}

// Rule group: Depends on. A dropped lane is dropped only, never also unknown.
function checkDeps(ctx, out) {
  for (const l of ctx.checked) {
    for (const d of l.deps) {
      ctx.examined.deps++;
      const bad = (rule, message) => out.errors.push(finding(rule, l.id, l.line, message));
      const dep = ctx.byId.get(d);
      if (ctx.dropped.has(d)) bad('dep-dropped', `lane '${l.id}': dependency '${d}' is a dropped lane`);
      else if (!dep) bad('dep-unknown', `lane '${l.id}': dependency '${d}' has no Waves row and no external section`);
      else if (l.wave !== null && dep.wave !== null && dep.wave >= l.wave) {
        bad('dep-order', `lane '${l.id}' (wave ${l.wave}): dependency '${d}' is in wave ${dep.wave}, not an earlier wave`);
      }
    }
  }
}

const HELD_FORMS = "is not a decision id, a lane id, '<lane> if <DP> = <answer>', first-flip, dave-yes or item-trigger";

// Rule group: Held until.
function checkHeld(ctx, out) {
  for (const l of ctx.checked) {
    for (const t of l.held) {
      ctx.examined.heldTokens++;
      const bad = (rule, message) => out.errors.push(finding(rule, l.id, l.line, message));
      if (t.kind === 'unknown') bad('held-token', `lane '${l.id}': Held until token '${t.text}' ${HELD_FORMS}`);
      else if (t.lane !== undefined && !ctx.byId.has(t.lane)) {
        bad('held-lane-unknown', `lane '${l.id}': Held until names lane '${t.lane}', which is not a map lane`);
      }
    }
  }
}

function checkSectionFields(node, out) {
  const { id, section } = node;
  for (const name of REQUIRED) {
    if (name in section.fields || name in section.blocks) continue;
    out.errors.push(finding('section-field', id, section.line, `lane '${id}' (line ${section.line}): section has no '${name}'`));
  }
}

function checkSectionDeps(ctx, out) {
  for (const l of ctx.checked) {
    const raw = l.section?.fields['Depends on'];
    if (raw === undefined || parseDeps(raw).join(',') === l.deps.join(',')) continue;
    const msg = `lane '${l.id}': section Depends on '${raw}' differs from the Waves table '${listText(l.deps)}'`;
    out.errors.push(finding('section-deps', l.id, l.section.line, msg));
  }
}

// Rule group: sections against rows.
function checkSections(ctx, out) {
  for (const l of ctx.rows.values()) {
    if (!l.section) out.errors.push(finding('section-missing', l.id, l.line, `lane '${l.id}': no '### ${l.id}' section`));
  }
  for (const s of ctx.model.sections) {
    if (ctx.rows.has(s.id) || s.external || ctx.dropped.has(s.id)) continue;
    out.errors.push(finding('orphan-section', s.id, s.line, `section '${s.id}' (line ${s.line}) has no Waves row and is not marked external`));
  }
  for (const node of ctx.nodes.filter((n) => n.section)) {
    ctx.examined.sections++;
    checkSectionFields(node, out);
  }
  checkSectionDeps(ctx, out);
}

function checkDropped(ctx, out) {
  const sectionIds = new Set(ctx.model.sections.map((s) => s.id));
  for (const d of ctx.model.dropped) {
    ctx.examined.dropped++;
    if (!ctx.rows.has(d.id) && !sectionIds.has(d.id)) continue;
    out.errors.push(finding('dropped-live', d.id, d.line, `dropped lane '${d.id}' still has a Waves row or a section`));
  }
}

function judgeOverlap(ctx, out, a, b, x, y) {
  ctx.examined.overlapPairs++;
  if (ctx.reach(a.id).has(b.id) || ctx.reach(b.id).has(a.id)) return;
  const path = (x.kind === 'file' ? x : y).path;
  const line = a.section?.line ?? null;
  if (KEY_SCOPE.test(x.scope ?? '') && KEY_SCOPE.test(y.scope ?? '')) {
    const msg = `file '${path}': '${a.id}' [${x.scope}] and '${b.id}' [${y.scope}] overlap, scoped to named keys, no dependency path`;
    out.notes.push(finding('owns-exempt', a.id, line, msg));
    return;
  }
  const msg = `file '${path}': owned by '${a.id}' and '${b.id}' with no dependency path between them`;
  out.errors.push(finding('owns-overlap', a.id, line, msg));
}

const pairsOf = (xs, ys) => xs.flatMap((x) => ys.map((y) => [x, y]));

// Every overlapping entry pair of two lanes goes to judgeOverlap.
function overlapsOf(ctx, out, a, b) {
  for (const [x, y] of pairsOf(ownsOf(ctx, a.id), ownsOf(ctx, b.id))) {
    if (entriesOverlap(x, y)) judgeOverlap(ctx, out, a, b, x, y);
  }
}

// Rule group: two lanes that own one path need a dependency path, or both entries carry a key scope.
function checkOverlaps(ctx, out) {
  const { nodes } = ctx;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) overlapsOf(ctx, out, nodes[i], nodes[j]);
  }
}

// An Owns entry covers a file when its path equals the file, ends with '/' + the file, or a dir or glob entry matches it.
// A bare chain name matches a dir or glob entry only when the pattern itself matches that name.
const covers = (e, file) => e.path === file || e.path.endsWith(`/${file}`) || ownsMatch(e, file);
const ownsFile = (ctx, id, file) => ownsOf(ctx, id).some((e) => covers(e, file));

function checkOwnerChains(ctx, out) {
  for (const chain of ctx.model.ownerChains) {
    ctx.examined.ownerChains++;
    for (const id of chain.lanes) {
      if (chain.files.some((f) => ownsFile(ctx, id, f))) continue;
      const file = chain.files.join(', ');
      out.errors.push(finding('owner-chain', id, chain.line,
        `Owner chains line ${chain.line}: '${file}' lists '${id}', whose Owns list has no '${file}'`));
    }
  }
}

// Every owner-chain clause the parser could not turn into a chain is shown, so none is skipped in silence.
function noteUnparsedChains(ctx, out) {
  for (const c of ctx.model.chainUnparsed) {
    ctx.examined.chainUnparsed++;
    out.notes.push(finding('chain-unparsed', null, c.line,
      `Owner chains line ${c.line}: no rule reads this clause (it is not '<files>: <lanes>'): '${c.text}'`));
  }
}

// A backticked Owns token that looks like a path but fails the path rule is dropped from the Owns list. That is an error.
function checkOwnsTokens(ctx, out) {
  for (const { id, section } of ctx.nodes) {
    for (const token of section?.ownsRejected ?? []) {
      out.errors.push(finding('owns-token', id, section.line,
        `lane '${id}' (line ${section.line}): Owns token '${token}' looks like a path but is not a plain path `
        + '([\\w.~*/-] only), so the overlap and diff checks cannot see it'));
    }
  }
}

function checkOwnerPhrases(ctx, out) {
  for (const p of ctx.model.ownerPhrases) {
    ctx.examined.ownerPhrases++;
    for (const f of p.files.filter((file) => !ownsFile(ctx, p.lane, file))) {
      out.errors.push(finding('owner-phrase', p.lane, p.line,
        `Shared contracts line ${p.line}: Owner '${p.lane}' (${f}), but '${p.lane}' Owns has no '${f}'`));
    }
  }
}

function proseNotes(ctx, out) {
  for (const { id, section } of ctx.nodes) {
    if (!section?.ownsProse) continue;
    out.notes.push(finding('owns-prose', id, section.line,
      `lane '${id}' (line ${section.line}): Owns has text outside backticks: '${section.ownsProse}'`));
  }
}

function vacuousNotes(ctx, out) {
  for (const g of GROUPS.filter((name) => ctx.examined[name] === 0)) {
    out.notes.push(finding('vacuous', null, null, `vacuous: ${g} examined 0 items`));
  }
}

export function checkTable(model) {
  const out = { errors: [...model.errors], notes: [] };
  const ctx = buildCtx(model);
  if (model.errors.some((e) => e.rule === 'waves-missing')) return { ...out, examined: ctx.examined };
  for (const group of [checkRows, checkDeps, checkHeld, checkSections, checkDropped, checkOverlaps, checkOwnerChains, noteUnparsedChains, checkOwnerPhrases, checkOwnsTokens, proseNotes]) {
    group(ctx, out);
  }
  vacuousNotes(ctx, out);
  return { ...out, examined: ctx.examined };
}
