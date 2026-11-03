import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(homedir(), '.claude');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(srcDir, 'settings.json'), join(outDir, 'settings.json'));
copyFileSync(join(srcDir, 'settings.json.bak-maestro'), join(outDir, 'settings.json.bak-maestro'));
