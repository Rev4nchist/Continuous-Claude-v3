// Shared by the advisory scanner steps in pre-pr (zizmor, osv, pssa): find a tool under ~/tools/review-scanners/<tool>/<version>/.
//   scannerBase(tool, home)        ~/tools/review-scanners/<tool>
//   versionFoldersNewestFirst(dir) the version folder names under dir, newest first ("v1.9.0" < "v1.32.0", "1.25.0" works too); [] when dir is missing
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const versionKey = (name) => (/\d+(?:\.\d+)*/.exec(name)?.[0] ?? '0').split('.').map(Number);

/** Sort comparator: the higher version first. Compares number by number, never as text. */
export function newer(a, b) {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

export const scannerBase = (tool, home = homedir()) => path.join(home, 'tools', 'review-scanners', tool);

export function versionFoldersNewestFirst(dir) {
  try { return readdirSync(dir).sort(newer); } catch { return []; }
}
