// The stricter of main and the branch for review-router.config.json (card coord-cap-override, PR A).
// A branch must not loosen a gate by editing its own copy of the config. Three keys take the stricter value:
//   checkpoint.enforce           true wins (a branch value that is not the boolean false counts as true)
//   coderabbit.cli_daily_cap_usd the lower valid number wins (a value that is not a finite number of 0 or more is ignored)
//   pre_pr.summary_mode          'fail' wins
// Every other key keeps the branch value. The main side is a COMMITTED ref, never a working-tree file (a working tree holds the branch's own edits):
// the local ref fork/main first (no fetch), else the local branch main. Neither readable fails closed: enforce true, and the branch cap and mode stay.
// Known limit: a stale local fork/main is still stricter than trusting the branch alone.
// The TypeScript twin is .claude/hooks/src/shared/config-stricter.ts. One fixture test (fixtures/stricter-config-cases.json) keeps them equal.
import path from 'node:path';

const CONFIG_FILE = 'review-router.config.json';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const validCap = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** The facts the stricter rule covers, read from a config: { enforce, cap, summaryFail }. */
export function viewOf(cfg) {
  const cap = cfg?.coderabbit?.cli_daily_cap_usd;
  return {
    enforce: cfg?.checkpoint?.enforce === true,
    cap: validCap(cap) ? cap : null,
    summaryFail: cfg?.pre_pr?.summary_mode === 'fail',
  };
}

/** A copy of `branch` with the three keys at their stricter value. `main` null means no main side could be read. Pure: neither input changes. */
export function stricterConfig(main, branch) {
  const out = isObj(branch) ? structuredClone(branch) : {};
  const m = isObj(main) ? main : null;
  const block = (name) => (isObj(out[name]) ? out[name] : {});

  const branchSets = isObj(out.checkpoint) && Object.hasOwn(out.checkpoint, 'enforce');
  const enforce = m === null || m.checkpoint?.enforce === true || (branchSets && out.checkpoint.enforce !== false);
  out.checkpoint = { ...block('checkpoint'), enforce };

  const caps = [m?.coderabbit?.cli_daily_cap_usd, out.coderabbit?.cli_daily_cap_usd].filter(validCap);
  if (caps.length > 0) out.coderabbit = { ...block('coderabbit'), cli_daily_cap_usd: Math.min(...caps) };

  if (m?.pre_pr?.summary_mode === 'fail' || out.pre_pr?.summary_mode === 'fail') out.pre_pr = { ...block('pre_pr'), summary_mode: 'fail' };
  return out;
}

/** The JSON object in `text`, or null (not a string, not JSON, not an object). */
function objectOf(text) {
  if (typeof text !== 'string') return null;
  try { const v = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

/** The committed config at `ref` ('fork/main' or 'main'), or null: no such ref, a git error, or a text that is not a JSON object. No fetch. */
function committedConfig(git, ref) {
  try {
    const shown = git(['show', `${ref}:${CONFIG_FILE}`]);
    return shown.status === 0 ? objectOf(shown.stdout) : null;
  } catch { return null; }
}

/**
 * The main side: { config, source }. The local ref fork/main first (git show, no fetch), else the local branch main. Both are committed text:
 * a working-tree file is never read, because it holds whatever the checked-out branch edited. Neither readable: { config: null, source: 'none' }.
 * `git(args)` returns { status, stdout }.
 */
export function readMainConfig({ git }) {
  const fork = committedConfig(git, 'fork/main');
  if (fork) return { config: fork, source: 'fork-main' };
  const local = committedConfig(git, 'main');
  if (local) return { config: local, source: 'local-main' };
  return { config: null, source: 'none' };
}

/** The config a run uses: the branch file of `root` made stricter by the main side. Throws when the branch file is missing or not a JSON object. */
export function loadStricterConfig({ root, git, readFile }) {
  const file = path.join(root, CONFIG_FILE);
  const branch = objectOf(readFile(file, 'utf8'));
  if (branch === null) throw new Error(`${file} is missing or is not a JSON object`);
  return stricterConfig(readMainConfig({ git }).config, branch);
}
