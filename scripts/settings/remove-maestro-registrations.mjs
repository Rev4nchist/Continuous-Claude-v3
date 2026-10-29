import fs from 'node:fs';
const f = process.argv[2] || (process.env.USERPROFILE + '/.claude/settings.json');
const apply = process.argv.includes('--apply');
const re = /(maestro-enforcer|maestro-state-manager|maestro-cleanup|session-start-recovery)\.mjs/;
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
let removed = 0;
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = s.hooks[ev].map(g => ({ ...g, hooks: (g.hooks || []).filter(h => {
    const hit = re.test(JSON.stringify(h)); if (hit) removed++; return !hit; }) }))
    .filter(g => g.hooks.length > 0);
  if (s.hooks[ev].length === 0) delete s.hooks[ev];
}
console.log('entries removed:', removed);
if (apply) { fs.copyFileSync(f, f + '.bak-maestro'); fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n'); console.log('written', f); }
