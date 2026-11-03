import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(homedir(), '.claude');
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, 'settings.json');
copyFileSync(join(here, 'live-settings.json'), dest);
rmSync(dest + '.bak-maestro', { force: true });
