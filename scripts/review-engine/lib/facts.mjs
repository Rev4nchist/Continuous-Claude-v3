// Program facts read from the map text. Pure: text and a parsed model in, facts out. No I/O.
// Each fact comes from the map, so it also works for a test map. A fact the map lacks is stated in `notes`:
//   seatId   the master card. A constant: it is not a map lane.
//   ids      Waves lane ids plus external ids (the ids a board query binds).
//   slotIds  the backtick ids on the bullet that starts '- Cursor eval slot:' (amendment A7). null when there is no
//            such bullet: `ready` fails closed on null. An empty list means the bullet names nobody.
//   longIds  the map lane ids in the first sentence of the '- Long lanes' bullet. [] and a note when there is none.
//   go       true only when every 'Program state:' line is exactly GO, optionally followed by one parenthetical
//            (e.g. 'GO (Dave, 2026-11-20)'). An absent, unreadable or disagreeing line reads as HOLD, with a note.

const SEAT_ID = 're-program';
const SLOT_BULLET = /^(\s*)- Cursor eval slot:/;
const LONG_BULLET = /^\s*- Long lanes\b[^:]*:/;
// One form only: 'Program state: <value>' at the start of a line, with an optional '- ' bullet. Every other line that
// holds the label 'program state' followed by ':' or '|' (any case, any markdown: a heading, a table cell, backticks,
// a quoted example in prose) is unreadable and reads as HOLD. So a HOLD written in another form can never be missed
// beside a GO line. Plain prose such as 'the program state.' has no ':' or '|' after the label and is not a state line.
const STATE_MENTION = /program\s*state[\s*_`]*[:|]/i;
const STATE_LINE = /^\s*(?:- )?Program state:\s*(.*?)\s*$/;
// The whole value, anchored: GO or HOLD, then at most one parenthetical with no nested parenthesis. A prefix such as
// 'GO pending DP2' or 'GO-LATER' is unreadable, never GO.
const READABLE_STATE = /^(?:GO|HOLD)(?:\s*\([^()]*\))?$/;
const GO_STATE = /^GO(?:\s*\([^()]*\))?$/;
const ID_TICKS = /`([a-z0-9][a-z0-9-]*)`/g;

const idsIn = (text) => [...text.matchAll(ID_TICKS)].map((m) => m[1]);
const indentOf = (line) => /^\s*/.exec(line)[0].length;
const unique = (list) => [...new Set(list)];

// The bullet line plus the deeper-indented lines that continue it. A blank line, a bullet or a shallower line ends it.
function bulletText(lines, start) {
  const base = indentOf(lines[start]);
  const parts = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || indentOf(line) <= base || /^\s*- /.test(line)) break;
    parts.push(line);
  }
  return parts.join('\n');
}

function slotFact(lines, mapIds, notes) {
  const start = lines.findIndex((l) => SLOT_BULLET.test(l));
  if (start < 0) {
    notes.push('map fact missing: Cursor eval slot bullet');
    return null;
  }
  const ids = unique(idsIn(bulletText(lines, start)));
  for (const id of ids.filter((x) => !mapIds.includes(x))) notes.push(`Cursor eval slot bullet names '${id}', which is not a map lane`);
  return ids;
}

// The list is the first sentence: a later sentence may name `review`, a state, in backticks.
function longFact(lines, mapIds, notes) {
  const start = lines.findIndex((l) => LONG_BULLET.test(l));
  if (start < 0) {
    notes.push('map fact missing: Long lanes bullet');
    return [];
  }
  const text = bulletText(lines, start).replace(/\s+/g, ' ');
  const ids = unique(idsIn(text.split(/\.\s/)[0]));
  for (const id of ids.filter((x) => !mapIds.includes(x))) notes.push(`Long lanes bullet names '${id}', which is not a map lane`);
  return ids.filter((x) => mapIds.includes(x));
}

function goFact(lines, notes) {
  const values = lines.filter((l) => STATE_MENTION.test(l)).map((l) => STATE_LINE.exec(l)?.[1] ?? l.trim());
  if (values.length === 0) {
    notes.push('map fact missing: Program state line; reads as HOLD');
    return false;
  }
  const unreadable = values.filter((v) => !READABLE_STATE.test(v));
  for (const v of unreadable) notes.push(`unreadable Program state line '${v}'; reads as HOLD`);
  if (unreadable.length > 0) return false;
  const goes = values.map((v) => GO_STATE.test(v));
  if (goes.some(Boolean) && !goes.every(Boolean)) notes.push('Program state lines disagree; reads as HOLD');
  return goes.every(Boolean);
}

export function programFacts(mapText, model) {
  const lines = mapText.split(/\r?\n/);
  const notes = [];
  const ids = unique([...model.lanes.map((l) => l.id), ...model.externals.map((e) => e.id)]);
  const slotIds = slotFact(lines, ids, notes);
  const longIds = longFact(lines, ids, notes);
  const go = goFact(lines, notes);
  return { seatId: SEAT_ID, ids, slotIds, longIds, go, notes };
}
