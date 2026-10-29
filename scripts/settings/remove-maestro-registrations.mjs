import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const f = args.find(a => !a.startsWith('--')) || path.join(os.homedir(), '.claude', 'settings.json');
const re = /(maestro-enforcer|maestro-state-manager|maestro-cleanup|maestro-detector|session-start-recovery)\.mjs/;
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
let removed = 0;
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = s.hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => {
    const hit = re.test(JSON.stringify(h)); if (hit) removed++; return !hit; }) }))
    .filter(g => g.hooks.length > 0);
  if (s.hooks[ev].length === 0) delete s.hooks[ev];
}
console.log('entries removed:', removed);
if (apply) {
  fs.copyFileSync(f, f + '.bak-maestro');
  const tmp = f + '.tmp-maestro';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, f);
  console.log('written', f);
}
