/**
 * The stricter of main and the branch for review-router.config.json (card coord-cap-override, PR A).
 * The TypeScript twin of scripts/github/config-stricter.mjs. One fixture test (scripts/github/fixtures/stricter-config-cases.json,
 * run by config-stricter-twin.test.ts) fails when the two copies differ. Read the .mjs file for the rule.
 * Known limit: a stale local fork/main is still stricter than trusting the branch alone.
 */
const CONFIG_FILE = 'review-router.config.json';
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const validCap = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const sub = (o: Obj | null | undefined, key: string): Obj | undefined => (o && isObj(o[key]) ? (o[key] as Obj) : undefined);

export interface ConfigView { enforce: boolean; cap: number | null; summaryFail: boolean }

export function viewOf(cfg: unknown): ConfigView {
  const c = isObj(cfg) ? cfg : null;
  const cap = sub(c, 'coderabbit')?.cli_daily_cap_usd;
  return {
    enforce: sub(c, 'checkpoint')?.enforce === true,
    cap: validCap(cap) ? cap : null,
    summaryFail: sub(c, 'pre_pr')?.summary_mode === 'fail',
  };
}

/** A copy of `branch` with the three keys at their stricter value. `main` null means no main side could be read. Pure. */
export function stricterConfig(main: unknown, branch: unknown): Obj {
  const out: Obj = isObj(branch) ? structuredClone(branch) : {};
  const m = isObj(main) ? main : null;
  const block = (name: string): Obj => sub(out, name) ?? {};

  const checkpoint = sub(out, 'checkpoint');
  const branchSets = checkpoint !== undefined && Object.hasOwn(checkpoint, 'enforce');
  const enforce = m === null || sub(m, 'checkpoint')?.enforce === true || (branchSets && checkpoint?.enforce !== false);
  out.checkpoint = { ...block('checkpoint'), enforce };

  const caps = [sub(m, 'coderabbit')?.cli_daily_cap_usd, sub(out, 'coderabbit')?.cli_daily_cap_usd].filter(validCap);
  if (caps.length > 0) out.coderabbit = { ...block('coderabbit'), cli_daily_cap_usd: Math.min(...caps) };

  if (sub(m, 'pre_pr')?.summary_mode === 'fail' || sub(out, 'pre_pr')?.summary_mode === 'fail') out.pre_pr = { ...block('pre_pr'), summary_mode: 'fail' };
  return out;
}

function objectOf(text: string | null | undefined): Obj | null {
  if (typeof text !== 'string') return null;
  try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

type Git = (cwd: string, args: string[]) => { status: number; stdout: string };

/** The committed config at `ref`, or null: no such ref, a git error, or a text that is not a JSON object. Never a fetch. */
function committedConfig(top: string, git: Git, ref: string): Obj | null {
  try {
    const shown = git(top, ['show', `${ref}:${CONFIG_FILE}`]);
    return shown.status === 0 ? objectOf(shown.stdout) : null;
  } catch { return null; }
}

/**
 * The main side of the config for the checkout at `top`: the local ref fork/main (git show, never a fetch), else the local branch main.
 * Both are committed text. A working-tree file is never read: it holds whatever the checked-out branch edited. Neither readable: null.
 */
export function mainConfigOf(top: string, git: Git): Obj | null {
  return committedConfig(top, git, 'fork/main') ?? committedConfig(top, git, 'main');
}
