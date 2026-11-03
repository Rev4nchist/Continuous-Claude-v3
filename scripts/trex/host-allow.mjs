/**
 * host-allow.mjs: the argv allowlist for `profile: host` flows (local TREX spec 13.2).
 * A host flow runs on the real machine, so it may start only two things:
 *   1. driver mod-event with {test}                          -> `claude plugin test`
 *   2. driver cli with cmd ["pwsh","-NoProfile","-File",<tree-relative .ps1>] and no other key
 * Authoring (lintFlow) and the runner both call hostActionOk, so the two stay in step.
 */

export const HOST_SHAPES = Object.freeze([
  Object.freeze({ driver: 'mod-event', shape: '{test: <name>}', runs: 'claude plugin test' }),
  Object.freeze({ driver: 'cli', shape: '{cmd: [pwsh, -NoProfile, -File, <tree-relative .ps1>]}', runs: 'pwsh -NoProfile -File <.ps1>' }),
]);

// A script the author writes lives here. Nobody reviews its content, so a host flow must not run it.
const BARRED_PREFIXES = Object.freeze(['scripts/trex/bench/flows/', '.trex/']);
const CMD_HEAD = Object.freeze(['pwsh', '-NoProfile', '-File']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKey = (action, key) => isObj(action) && Object.keys(action).length === 1 && key in action;

/** An error text when the path is not a safe posix relative path, else null. */
function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'the script path is empty or not a string';
  const bad = p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)
    || p.split('/').some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git');
  return bad ? `the script path ${JSON.stringify(p)} is not a posix relative path inside the tree` : null;
}

/** The .ps1 path of a cli `pwsh -NoProfile -File <p>` action, or null when the action has another shape. */
export function hostPs1Path(driver, action) {
  if (driver !== 'cli' || !onlyKey(action, 'cmd')) return null;
  const c = action.cmd;
  const shaped = Array.isArray(c) && c.length === CMD_HEAD.length + 1 && CMD_HEAD.every((x, i) => c[i] === x);
  return shaped && typeof c.at(-1) === 'string' ? c.at(-1) : null;
}

function treeProblem(p, treeHas) {
  const lower = p.toLowerCase();
  if (BARRED_PREFIXES.some((b) => lower.startsWith(b))) return `the script ${p} is under the bench flows folder or .trex: the author wrote it and nobody reviewed it`;
  let present = false;
  try { present = typeof treeHas === 'function' && treeHas(p) === true; } catch { present = false; }
  return present ? null : `the script ${p} does not exist at the group head`;
}

function ps1Problem(p) {
  if (!/\.ps1$/i.test(p)) return `the script ${JSON.stringify(p)} does not end in .ps1`;
  return pathProblem(p);
}

function cliProblem(action, treeHas) {
  const p = hostPs1Path('cli', action);
  if (p === null) return 'cli on host must be exactly {cmd: [pwsh, -NoProfile, -File, <tree .ps1>]}';
  return ps1Problem(p) ?? treeProblem(p, treeHas);
}

/** null when the host action is allowed, else the reason. `treeHas(path)` says whether the .ps1 exists at the group head. */
export function hostActionOk(driver, action, { treeHas } = {}) {
  if (driver === 'mod-event') {
    const ok = onlyKey(action, 'test') && typeof action.test === 'string' && action.test !== '' && !action.test.startsWith('-');
    return ok ? null : 'mod-event on host must be exactly {test: <name>}';
  }
  if (driver === 'cli') return cliProblem(action, treeHas);
  return `driver ${JSON.stringify(driver)} is not allowed on host (only mod-event and cli)`;
}
