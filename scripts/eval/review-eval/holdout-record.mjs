// The holdout.json writer. Pure of any default location: every function takes the path. HOLDOUT_PATH is only the name of the live file.
// One row per engineVersion: { engineVersion, majors, found, recall, pairedBar }. Counts only, no PR id. pairedBar is the holdout cell of the scorecard.
// engineVersion is the caller's label of the row; the ledger check ties the row to an arm by promptVersion and promptSha256, not by engineVersion.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function checkArgs({ path: file, engineVersion, majors, found, pairedBar, ledgerLines }) {
  if (!isText(file)) throw new Error('holdout path is missing');
  if (!isText(engineVersion)) throw new Error('engineVersion must be a non-empty string');
  if (!Number.isInteger(majors) || !Number.isInteger(found) || found < 0 || found > majors) throw new Error('majors and found must be integers with 0 <= found <= majors');
  if (!Array.isArray(ledgerLines)) throw new Error('ledgerLines must be an array');
  // The scorecard pairedBar is { holdout, dev }. Only the holdout cell belongs in this file: a dev number here would pass as a holdout number.
  if (pairedBar !== null && typeof pairedBar === 'object' && Object.hasOwn(pairedBar, 'dev')) throw new Error('pairedBar must be the holdout cell (scorecard pairedBar.holdout), not the card pairedBar with a dev key');
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
  if (Object.hasOwn(old.rows, engineVersion) && !replace) return { written: false, reason: 'exists' };
  const row = { engineVersion, majors, found, recall: majors ? found / majors : null, pairedBar };
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
