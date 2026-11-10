// Argument parsing for program.mjs. Pure: argv in, options out. An unknown flag or verb is a usage error (exit 2).
import { usageError } from './errors.mjs';

export const USAGE = `usage: node scripts/review-engine/program.mjs <verb> [options]
  check [--table]                                lint the Waves table and the sections (bare check = --table)
  check --diff <lane-id> [--branch <ref>] [--base <ref>]
  check --board | --claims | --orphans           part 2, not built (exit 5)
  seed-file [--out <file>] [--project <key>]     --edges-out <file> is part 2 (exit 5)
  ready | status | sync-board [--apply]          part 2, not built (exit 5)
global: --json
test mode: --test-mode [--map <file> | --map-ref <ref>] [--repo <dir>]
exit codes: 0 pass, 1 check failed, 2 usage, 3 refused, 5 part 2 not built`;

const GLOBAL = { json: 'bool', 'test-mode': 'bool', map: 'value', 'map-ref': 'value', repo: 'value' };
const VERBS = {
  check: { table: 'bool', diff: 'value', board: 'bool', claims: 'bool', orphans: 'bool', branch: 'value', base: 'value' },
  'seed-file': { out: 'value', project: 'value', 'edges-out': 'value' },
  ready: {},
  status: {},
  'sync-board': { apply: 'bool' },
};
const CHECK_MODES = ['table', 'diff', 'board', 'claims', 'orphans'];

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
  return modes[0] ?? 'table';
}

// The handler key: 'check --table', 'check --diff', 'seed-file', 'seed-file --edges-out', 'ready' ...
function handlerKey(verb, flags) {
  if (verb === 'check') return `check --${checkModes(flags)}`;
  if (verb === 'seed-file' && flags['edges-out'] !== undefined) return 'seed-file --edges-out';
  return verb;
}

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
  return { verb, key: handlerKey(verb, flags), flags };
}
