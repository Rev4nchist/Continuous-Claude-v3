// The holdout.json writer. Pure of any default location: every function takes the path. HOLDOUT_PATH is only the name of the live file.
// One row per engineVersion: { engineVersion, majors, found, recall, pairedBar }. Counts only, no PR id.
// majors = distinct gold items (an integer). found may be a mean over replicates (fractional), 0 <= found <= majors. recall is null under MIN_CELL (20) majors.
// The caller gives the per-set pairedBar of a card ({ holdout, dev }). The row keeps its holdout cell through an allow-list of keys.
// engineVersion is the caller's label of the row; the ledger check ties the row to an arm by promptVersion and promptSha256, not by engineVersion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_CELL } from './score.mjs';

export const HOLDOUT_PATH = path.join(os.homedir(), '.claude', 'state', 'local-review', 'eval', 'holdout.json');

const isText = (x) => typeof x === 'string' && x !== '';

/** { schema: 1, rows } from the file. A missing file is empty. A damaged file throws. */
export function readHoldout(file) {
  if (!isText(file)) throw new Error('holdout path is missing');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { schema: 1, rows: {} };
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`holdout file is damaged (not JSON): ${err.message}`);
  }
  if (data?.schema !== 1 || data.rows === null || typeof data.rows !== 'object' || Array.isArray(data.rows)) throw new Error('holdout file is damaged (schema or rows)');
  return data;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** Keys of the holdout cell that the file keeps, each with the test of its value. Nothing else is copied: no cluster count, no free key, no PR id, no object, no free string. */
const isNum = (v) => v === null || Number.isFinite(v);
const CELL_KEYS = { status: (v) => v === 'NOTE', baseline: isText, candidate: isText };
const SUITE_CELLS = ['regression', 'capability', 'unassigned'];
const SUITE_KEYS = { ...Object.fromEntries(['delta', 'lo', 'hi', 'n', 'unpaired', 'd', 'nNeeded', 'B', 'used'].map((k) => [k, isNum])), wouldBe: (v) => v === null || v === 'PASS' || v === 'FAIL' };
const pick = (from, types) => Object.fromEntries(Object.entries(types).filter(([k, ok]) => Object.hasOwn(from, k) && ok(from[k])).map(([k]) => [k, from[k]]));
const isHoldoutCell = (c) => isObject(c) && c.status === 'NOTE' && isText(c.baseline) && isText(c.candidate) && SUITE_CELLS.every((n) => isObject(c[n]));

function checkArgs({ path: file, engineVersion, majors, found, pairedBar, ledgerLines }) {
  if (!isText(file)) throw new Error('holdout path is missing');
  if (!isText(engineVersion)) throw new Error('engineVersion must be a non-empty string');
  // majors = distinct gold items. found may be a mean over replicates, so it may be fractional.
  if (!Number.isInteger(majors) || majors < 0) throw new Error('majors must be an integer of 0 or more');
  if (!Number.isFinite(found) || found < 0 || found > majors) throw new Error('found must be a finite number with 0 <= found <= majors');
  if (!Array.isArray(ledgerLines)) throw new Error('ledgerLines must be an array');
  // pairedBar is the per-set object of a card: { holdout, dev }. A bare cell, a whole card or any other object is refused. null (a card with no compare) stays.
  if (pairedBar === null) return;
  const perSet = isObject(pairedBar) && isHoldoutCell(pairedBar.holdout) && Object.keys(pairedBar).every((k) => k === 'holdout' || k === 'dev');
  if (!perSet) throw new Error('pairedBar must be the per-set pairedBar of a card ({ holdout, dev }), not a bare cell or a whole card');
}

/** The holdout cell of the per-set pairedBar, through the allow-list. null stays null. */
function holdoutCell(pairedBar) {
  if (pairedBar === null) return null;
  const cell = pairedBar.holdout;
  return { ...pick(cell, CELL_KEYS), ...Object.fromEntries(SUITE_CELLS.filter((n) => isObject(cell[n])).map((n) => [n, pick(cell[n], SUITE_KEYS)])) };
}

/** The spend ledger has a line for this arm: reviewer engine, the same promptVersion and the same promptSha256. Both values must be set. */
const hasLedgerLine = (lines, promptVersion, promptSha256) => isText(promptVersion) && isText(promptSha256)
  && lines.some((l) => l?.reviewer === 'engine' && l.promptVersion === promptVersion && l.promptSha256 === promptSha256);

/**
 * Writes one row. Returns { written: true }, or { written: false, reason: 'no-ledger-line' | 'exists' }.
 * The file is written to a temp file in the same folder and then renamed, so a crash never leaves half a file.
 */
export function writeHoldout({ path: file, engineVersion, promptVersion, promptSha256, majors, found, pairedBar, ledgerLines, replace = false }) {
  checkArgs({ path: file, engineVersion, majors, found, pairedBar, ledgerLines });
  if (!hasLedgerLine(ledgerLines, promptVersion, promptSha256)) return { written: false, reason: 'no-ledger-line' };
  const old = readHoldout(file);
  if (Object.hasOwn(old.rows, engineVersion) && replace !== true) return { written: false, reason: 'exists' };
  // A recall under MIN_CELL majors is a percent that the card itself would not print.
  const row = { engineVersion, majors, found, recall: majors >= MIN_CELL ? found / majors : null, pairedBar: holdoutCell(pairedBar) };
  const next = { schema: 1, rows: { ...old.rows, [engineVersion]: row } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.holdout-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { written: true };
}
