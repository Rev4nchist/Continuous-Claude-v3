// Builds a small map text and runs the real parser and facts reader on it. Test support only: pure, no I/O.
// The shared fixture map (map.fixture.md) has fx- ids only; the board rules read re- ids, so the tests build their own map here.
//   buildMap({ lanes, externals, packs, slot, long, go }) returns { text, model, facts }.
//   lanes:     [{ id, wave = 0, phase = 'P1', deps = [], held = '', owns = ['<id>.mjs'], cost = '0 runs' }]
//              an owns item is a path, or [path, scope] for an entry like `cfg.json` (the a key only).
//   externals: [{ id, owns }], written as sections with the external subtitle.
//   packs:     [{ lanes, branch }], written as 'Pack:' lines.
//   slot:      ids on the '- Cursor eval slot:' bullet. undefined: a bullet naming nobody. null: no bullet.
//   long:      ids on the '- Long lanes' bullet. undefined: no bullet.
//   go:        true writes 'Program state: GO', anything else writes HOLD.
import { parseMap } from '../lib/map-parse.mjs';
import { programFacts } from '../lib/facts.mjs';

const HEADER = '| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |';
const ticks = (ids) => ids.map((id) => `\`${id}\``).join(', ');

function ownsText(owns) {
  const parts = owns.map((o) => (Array.isArray(o) ? `\`${o[0]}\` (${o[1]})` : `\`${o}\``));
  return parts.length ? parts.join(', ') : 'none';
}

function waveRow(lane) {
  const deps = lane.deps.length ? lane.deps.join(', ') : 'none';
  return `| ${lane.wave} | \`${lane.id}\` | ${lane.phase} | ${deps} |  | new | ${lane.held} |`;
}

function section(lane, subtitle) {
  const deps = lane.deps?.length ? lane.deps.join(', ') : 'none';
  return [
    `### ${lane.id}`, '', `**Title ${lane.id}** (${subtitle})`, '',
    `- Depends on: ${deps}`, `- Owns: ${ownsText(lane.owns)}`, `- Cost: ${lane.cost}`, '- Needs Dave: no', '',
    'Scope: Do the work.', '', 'Done when: It is done.', '',
  ].join('\n');
}

const fill = (lane) => ({ wave: 0, phase: 'P1', deps: [], held: '', owns: [`${lane.id}.mjs`], cost: '0 runs', ...lane });

function extras(spec) {
  const lines = [];
  if (spec.slot !== null) lines.push(`- Cursor eval slot: one token. Spenders: ${ticks(spec.slot ?? [])}.`);
  if (spec.long) lines.push(`- Long lanes (T14): ${ticks(spec.long)} run for weeks. Set the lane to state \`review\` between sessions.`);
  for (const p of spec.packs ?? []) lines.push(`Pack: ${p.lanes.join(', ')} (branch ${p.branch})`);
  lines.push(spec.go === true ? 'Program state: GO (Dave, 2026-11-12)' : 'Program state: HOLD');
  return lines;
}

export function buildMap(spec = {}) {
  const lanes = (spec.lanes ?? []).map(fill);
  const externals = (spec.externals ?? []).map((e) => fill({ ...e, wave: 0 }));
  const parts = [
    '# Test map', '', '## Waves', '', HEADER, '|---|---|---|---|---|---|---|', ...lanes.map(waveRow), '',
    ...extras(spec), '', '## Lanes', '',
    ...lanes.map((l) => section(l, `wave ${l.wave}, phase ${l.phase}, new`)),
    '## External lanes', '',
    ...externals.map((e) => section(e, 'counts as wave 0, external; card state `blocked`')),
  ];
  const text = `${parts.join('\n')}\n`;
  const model = parseMap(text);
  return { text, model, facts: programFacts(text, model) };
}
