import { redact } from './redact';
import { scrubPathsInText, stripControl } from './safe-message';

const MAX_PROJECT_LABEL = 60;
const HOME_ROOTS = new Set(['users', 'home']);
/** The longest home path: `//wsl$/Ubuntu/home/x`, `/mnt/c/Users/x`, `\\server\share\Users\x`. */
const MAX_HOME_DEPTH = 4;

/** `sessions.project` holds an absolute working directory. Return only its last folder, and `~`
 *  for a home folder, whose last folder is the user name. Secrets and any path left inside the
 *  folder name are removed too. A folder directly under `users` or `home` is a home folder when
 *  the path has at most four parts, so `/home/x/projects/home/site` stays `site`. A drive root has
 *  no folder name. */
export function projectLabel(raw: string): string {
  const parts = raw.split(/[\\/]/).filter((part) => part !== '');
  // Extended prefixes: `\\?\C:\x` and `\\?\UNC\server\share\x` name the same paths without them.
  if (parts[0] === '?') parts.shift();
  if (parts[0]?.toUpperCase() === 'UNC') parts.shift();
  const underHomeRoot =
    parts.length >= 2 && parts.length <= MAX_HOME_DEPTH && HOME_ROOTS.has(parts[parts.length - 2].toLowerCase());
  if (underHomeRoot) return '~';
  const last = parts.pop() ?? '';
  if (/^[A-Za-z]:$/.test(last) || last === '?') return 'unknown';
  const leaf = scrubPathsInText(redact(stripControl(last)).text);
  return leaf === '' ? 'unknown' : leaf.slice(0, MAX_PROJECT_LABEL);
}
