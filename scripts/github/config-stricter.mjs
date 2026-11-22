// The stricter of main and the branch for review-router.config.json (card coord-cap-override, PR A).
// A branch must not loosen a gate by editing its own copy of the config. Three keys take the stricter value:
//   checkpoint.enforce           true wins (a branch value that is not the boolean false counts as true)
//   coderabbit.cli_daily_cap_usd the lower valid number wins (a value that is not a finite number of 0 or more is ignored)
//   pre_pr.summary_mode          'fail' wins
// Every other key keeps the branch value. The main side is the local ref fork/main (no fetch), else the primary checkout file.
// No main side at all fails closed: enforce true, and the branch cap and mode stay.
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

/**
 * The main side: { config, source }. The local ref fork/main first (git show, no fetch). Else the config file of the primary checkout.
 * A text that is not a JSON object counts as missing. A git or read error counts as missing. Both missing: { config: null, source: 'none' }.
 * `git(args)` returns { status, stdout }. `readFile(path, 'utf8')` returns the text, or throws or gives null when there is no file.
 */
export function readMainConfig({ root, git, readFile }) {
  try {
    const shown = git(['show', `fork/main:${CONFIG_FILE}`]);
    const config = shown.status === 0 ? objectOf(shown.stdout) : null;
    if (config) return { config, source: 'fork-main' };
  } catch { /* no ref, or no git: try the primary file */ }
  try {
    const common = git(['rev-parse', '--git-common-dir']);
    if (common.status === 0 && common.stdout.trim() !== '') {
      const primary = path.dirname(path.resolve(root, common.stdout.trim()));
      const config = objectOf(readFile(path.join(primary, CONFIG_FILE), 'utf8'));
      if (config) return { config, source: 'primary' };
    }
  } catch { /* no primary file */ }
  return { config: null, source: 'none' };
}

/** The config a run uses: the branch file of `root` made stricter by the main side. Throws when the branch file is missing or not a JSON object. */
export function loadStricterConfig({ root, git, readFile }) {
  const file = path.join(root, CONFIG_FILE);
  const branch = objectOf(readFile(file, 'utf8'));
  if (branch === null) throw new Error(`${file} is missing or is not a JSON object`);
  return stricterConfig(readMainConfig({ root, git, readFile }).config, branch);
}
