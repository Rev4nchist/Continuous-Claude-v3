// RED stub (coord-cap-override PR A): models today's behaviour, the branch value always wins. The change replaces the body of stricterConfig,
// readMainConfig and loadStricterConfig. viewOf is final.
import path from 'node:path';

/** The facts the stricter rule covers, read from a config: { enforce, cap, summaryFail }. */
export function viewOf(cfg) {
  const cap = cfg?.coderabbit?.cli_daily_cap_usd;
  return {
    enforce: cfg?.checkpoint?.enforce === true,
    cap: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : null,
    summaryFail: cfg?.pre_pr?.summary_mode === 'fail',
  };
}

export const stricterConfig = (_main, branch) => branch;
export const readMainConfig = () => ({ config: null, source: 'none' });
export const loadStricterConfig = ({ root, readFile }) => JSON.parse(readFile(path.join(root, 'review-router.config.json'), 'utf8'));
