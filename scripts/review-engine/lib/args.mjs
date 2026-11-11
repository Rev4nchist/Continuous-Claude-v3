// Argument parsing for program.mjs. Pure: argv in, options out. An unknown flag or verb is a usage error (exit 2).
import { usageError } from './errors.mjs';

export const USAGE = `usage: node scripts/review-engine/program.mjs <verb> [options]
  check [--table]                                lint the Waves table and the sections (bare check = --table)
  check --diff <lane-id> [--branch <ref>] [--base <ref>]
  check --board | --orphans [--project <key>]    read the lane board (database)
  check --claims [--project <key>] [--since <event-id>]
  seed-file [--out <file>] [--project <key>] [--rank <file>]
  ready [--project <key>] [--as <session-id>]
  sync-board [--apply] [--project <key>] [--as <session-id>]
  status [--project <key>]
global: --json
test mode: --test-mode [--map <file> | --map-ref <ref>] [--repo <dir>] [--decisions <file>] [--lane-cli <path>]
exit codes: 0 pass, 1 check failed or error, 2 usage, 3 refused, 5 contract module missing`;

const GLOBAL = { json: 'bool', 'test-mode': 'bool', map: 'value', 'map-ref': 'value', repo: 'value', decisions: 'value', 'lane-cli': 'value' };
const VERBS = {
  check: { table: 'bool', diff: 'value', board: 'bool', claims: 'bool', orphans: 'bool', branch: 'value', base: 'value', project: 'value', since: 'value' },
  'seed-file': { out: 'value', project: 'value', rank: 'value' },
  ready: { project: 'value', as: 'value' },
  status: { project: 'value' },
  'sync-board': { apply: 'bool', project: 'value', as: 'value' },
};
const CHECK_MODES = ['table', 'diff', 'board', 'claims', 'orphans'];
const BOARD_KEY = /^[a-z0-9][a-z0-9-]*$/;

// Read one flag. Returns the next index. Accepts '--flag value' and '--flag=value'.
function readFlag(argv, i, spec, flags) {
  const [name, inline] = argv[i].slice(2).split(/=(.*)/s, 2);
  const kind = spec[name];
  if (!kind) throw usageError(`unknown flag '--${name}'\n${USAGE}`);
  if (kind === 'bool') {
    flags[name] = true;
    return i + 1;
  }
  const value = inline ?? argv[i + 1];
  if (value === undefined || (inline === undefined && value.startsWith('--'))) throw usageError(`flag '--${name}' needs a value\n${USAGE}`);
  flags[name] = value;
  return inline === undefined ? i + 2 : i + 1;
}

function checkModes(flags) {
  const modes = CHECK_MODES.filter((m) => flags[m]);
  if (modes.length > 1) throw usageError(`check takes one of --${CHECK_MODES.join(', --')}\n${USAGE}`);
  if ((flags.branch || flags.base) && !flags.diff) throw usageError(`--branch and --base go with --diff\n${USAGE}`);
  const mode = modes[0] ?? 'table';
  if (flags.project !== undefined && !['board', 'claims', 'orphans'].includes(mode)) throw usageError(`--project goes with --board, --claims or --orphans\n${USAGE}`);
  if (flags.since !== undefined && mode !== 'claims') throw usageError(`--since goes with --claims\n${USAGE}`);
  return mode;
}

// Values that reach SQL binds and child argv: a board key and an event id.
function checkValues(flags) {
  if (flags.project !== undefined && !BOARD_KEY.test(flags.project)) throw usageError(`--project must match ${BOARD_KEY} (got '${flags.project}')\n${USAGE}`);
  if (flags.since !== undefined && !/^\d+$/.test(flags.since)) throw usageError(`--since must be a whole number (got '${flags.since}')\n${USAGE}`);
}

// The handler key: 'check --table', 'check --diff', 'seed-file', 'ready' ...
const handlerKey = (verb, flags) => (verb === 'check' ? `check --${checkModes(flags)}` : verb);

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb.startsWith('--')) throw usageError(`missing verb\n${USAGE}`);
  if (!VERBS[verb]) throw usageError(`unknown verb '${verb}'\n${USAGE}`);
  const spec = { ...GLOBAL, ...VERBS[verb] };
  const flags = {};
  for (let i = 0; i < rest.length;) {
    if (!rest[i].startsWith('--')) throw usageError(`unexpected argument '${rest[i]}'\n${USAGE}`);
    i = readFlag(rest, i, spec, flags);
  }
  const key = handlerKey(verb, flags);
  checkValues(flags);
  return { verb, key, flags };
}
