// Shared helpers of the pure board decisions (ready, sync, board-check, claims, orphans, status). Pure: no I/O, no clock.
// A program lane is a map lane, an external lane, or any lane whose id starts with 're-'. The seat (re-program) is a program lane
// that is not a map lane; the cap, the slot and the orphan list treat it on its own.

export const IN_WORK = ['active', 'review'];

export const isProgramId = (id, facts) => facts.ids.includes(id) || id.startsWith('re-');
export const isWorkerRe = (id, facts) => id.startsWith('re-') && id !== facts.seatId;
export const owner8 = (id) => (id ? String(id).slice(0, 8) : '-');

// Lane id to the board row's `met`. Feeds judgeHolds.
export const metTable = (rows) => new Map(rows.map((r) => [r.id, r.met === true]));

// Rows in work: program rows in active or review, minus the seat.
export const workRows = (rows, facts) => rows.filter((r) => IN_WORK.includes(r.state) && isProgramId(r.id, facts) && r.id !== facts.seatId);

// Map id to { id, wave, phase, held, owns, deps, external }. Waves lanes first, then externals (wave 0, no phase, no hold).
export function laneIndex(model) {
  const index = new Map();
  for (const l of model.lanes) {
    index.set(l.id, { id: l.id, wave: l.wave, phase: l.phase, held: l.held, owns: l.section?.owns ?? [], deps: l.deps, external: false });
  }
  for (const e of model.externals) {
    index.set(e.id, { id: e.id, wave: 0, phase: null, held: [], owns: e.section?.owns ?? [], deps: [], external: true });
  }
  return index;
}

const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' };
const CENTRAL = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ...PARTS });

// Central time with the zone name, for text output: '2026-11-10 15:30 CST'. Never a Z time. A null or bad time is 'unknown'.
export function fmtTime(value) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const p = Object.fromEntries(CENTRAL.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// The result line of a check: 'RESULT pass (0 errors)'.
export const resultLine = (n, noun = 'errors') => `RESULT ${n === 0 ? 'pass' : 'fail'} (${n} ${noun})`;
