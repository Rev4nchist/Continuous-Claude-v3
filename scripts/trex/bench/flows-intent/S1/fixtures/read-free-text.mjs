import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'apps/agentic-os/src/server/sources/state-files.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('state-files.ts not found');
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'trex-s1-'));
writeFileSync(join(dir, 's1.json'), readFileSync(join(here, 'state.json')));
process.env.AGENTIC_OS_STATE_DIR = dir;

const sources = join(repoRoot(), 'apps/agentic-os/src/server/sources');
const { readStateFiles } = await import(pathToFileURL(join(sources, 'state-files.ts')).href);
const { safeMessage } = await import(pathToFileURL(join(sources, 'safe-message.ts')).href);
const brief = (await readStateFiles()).snapshots[0]?.brief;
if (!brief) {
  console.log('NO_SNAPSHOT');
  process.exit(1);
}
const ask = brief.ask[0] ?? { text: '', recommend: '' };
const error = safeMessage(new Error('open failed C:\\Users\\Ada Lovelace\\zzsecret99.txt please retry'));
console.log(`GOAL ${brief.goal ?? ''}`);
console.log(`PLAN ${brief.plan[0]?.text ?? ''}`);
console.log(`ASK ${ask.text}`);
console.log(`REC ${ask.recommend ?? ''}`);
console.log(`DECISION ${brief.decisions[0]?.text ?? ''}`);
console.log(`ERROR ${error}`);
