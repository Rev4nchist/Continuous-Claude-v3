// Packs: lanes that share one branch and count as one cap unit. Pure: no I/O.
// The map is the only source (amendment A6). One line, at the start of a line:
//   Pack: re-verifier, re-finder-v2 (branch re/re-verifier)
// No such line means no pack. A line that starts with 'Pack:' and has no readable form is reported in `bad`.

const LANE_ID = /^[a-z0-9][a-z0-9-]*$/;
const PACK_START = /^\s*(?:- )?Pack:/;
const PACK_LINE = /^\s*(?:- )?Pack:\s*(.+?)\s*\(branch\s+(\S+?)\)\s*$/;
const noTicks = (text) => text.replace(/`/g, '');

function readPack(text, line) {
  const m = PACK_LINE.exec(text);
  if (!m) return null;
  const lanes = m[1].split(',').map((x) => noTicks(x.trim()));
  const branch = noTicks(m[2]);
  return lanes.every((id) => LANE_ID.test(id)) && branch ? { branch, lanes, line } : null;
}

// { packs: [{ branch, lanes, line }], bad: [{ line, text }] }. line is the 1-based map line.
export function scanPacks(mapText) {
  const out = { packs: [], bad: [] };
  mapText.split(/\r?\n/).forEach((text, i) => {
    if (!PACK_START.test(text)) return;
    const pack = readPack(text, i + 1);
    if (pack) out.packs.push(pack);
    else out.bad.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

export const parsePacks = (mapText) => scanPacks(mapText).packs;

export const packOf = (id, packs = []) => packs.find((p) => p.lanes.includes(id)) ?? null;

// The branch a lane is seeded with: the pack branch, else re/<id>.
export const branchOf = (id, packs = []) => packOf(id, packs)?.branch ?? `re/${id}`;

// The cap unit of a board row: its stored re/ branch; else its pack branch; else its own id.
// A NULL-branch row (an external, an old card) is one unit by id.
export function unitKey(row, packs = []) {
  if (/^re\//.test(row.branch ?? '')) return row.branch;
  return packOf(row.id, packs)?.branch ?? row.id;
}
