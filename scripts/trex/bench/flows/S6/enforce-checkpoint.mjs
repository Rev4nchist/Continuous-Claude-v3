import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate-repo');
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, 'review-router.config.json'), JSON.stringify({ checkpoint: { enforce: true } }));
const r = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(r.stderr || 'git init failed');
  process.exit(r.status ?? 1);
}
