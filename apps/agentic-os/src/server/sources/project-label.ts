import { redact } from './redact';
import { scrubPathsInText } from './safe-message';

const MAX_PROJECT_LABEL = 60;
const HOME_ROOTS = new Set(['users', 'home']);

/** `sessions.project` holds an absolute working directory. Return only its last folder, and `~`
 *  for a home folder, whose last folder is the user name. Secrets and any path left inside the
 *  folder name are removed too. A folder directly under `users` or `home` is a home folder at any
 *  depth (`/mnt/c/Users/x`, `\\server\share\Users\x`). A drive root has no folder name. */
export function projectLabel(raw: string): string {
  const parts = raw.split(/[\\/]/).filter((part) => part !== '');
  if (parts.length >= 2 && HOME_ROOTS.has(parts[parts.length - 2].toLowerCase())) return '~';
  const last = parts.pop() ?? '';
  if (/^[A-Za-z]:$/.test(last) || last === '?') return 'unknown';
  const leaf = scrubPathsInText(redact(last).text);
  return leaf === '' ? 'unknown' : leaf.slice(0, MAX_PROJECT_LABEL);
}
