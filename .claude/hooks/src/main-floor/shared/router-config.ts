/**
 * review-router.config.json, found without git: the first copy from `cwd` upward, else <home>/continuous-claude.
 * A worktree has its own copy, so a session in a worktree reads that branch's flags. Used by decision-gate (decisions.enforce)
 * and pr-opened-review-loop (checkpoint.ledger). Only a literal boolean true counts as on: callers read `=== true`.
 */
import { dirname, join } from 'path';

const CONFIG_REL = 'review-router.config.json';

/** The text of the config, or null when no copy exists. */
export function routerConfigText(cwd: string, readFile: (path: string) => string | null, home: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const text = readFile(join(dir, CONFIG_REL));
    if (text !== null) return text;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return readFile(join(home, 'continuous-claude', CONFIG_REL));
}

/** True only when `section.key` of the config is the boolean true. A missing file, bad JSON or any other value is false. */
export function routerFlag(cwd: string, readFile: (path: string) => string | null, home: string, section: string, key: string): boolean {
  const text = routerConfigText(cwd, readFile, home);
  if (text === null) return false;
  try {
    const cfg = JSON.parse(text) as Record<string, Record<string, unknown> | undefined> | null;
    return cfg?.[section]?.[key] === true;
  } catch {
    return false;
  }
}
