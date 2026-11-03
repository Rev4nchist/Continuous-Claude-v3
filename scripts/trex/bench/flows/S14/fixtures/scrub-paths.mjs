import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mark = path.join('apps', 'agentic-os', 'src', 'server', 'sources', 'safe-message.ts');
function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, mark))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = findRoot(here) || findRoot(process.cwd());
if (!root) {
  console.error('safe-message.ts not found');
  process.exit(1);
}
const src = path.join(root, 'apps', 'agentic-os', 'src', 'server', 'sources');
const dir = mkdtempSync(path.join(tmpdir(), 'scrub-'));
const safe = readFileSync(path.join(src, 'safe-message.ts'), 'utf8').replace("from './redact'", "from './redact.ts'");
writeFileSync(path.join(dir, 'safe-message.ts'), safe);
writeFileSync(path.join(dir, 'redact.ts'), readFileSync(path.join(src, 'redact.ts')));
const { scrubPathsInText, safeMessage } = await import(pathToFileURL(path.join(dir, 'safe-message.ts')).href);
const cases = [
  ['see "/home/alice/a"b/finance.txt', 'see "<path>'],
  ["see '/home/alice/O'Brien/finance.txt", "see '<path>"],
  ["/home/alice/Clients' Reports/finance.txt", '<path>'],
  ["Archive /home/alice/Clients' Reports/finance.txt before Friday", 'Archive <path> before Friday'],
  ['See /home/alice/file.txt [proof](../proof.md) now', 'See <path> [proof](../proof.md) now'],
];
const bad = [];
for (const [input, want] of cases) {
  const got = scrubPathsInText(input);
  if (got !== want) bad.push(JSON.stringify({ input, got, want }));
}
const msg = String.raw`open C:\Users\alice\Clients' Reports\finance.txt`;
const gotMsg = safeMessage(new Error(msg));
if (gotMsg !== 'open <path>') bad.push(JSON.stringify({ input: msg, got: gotMsg }));
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('PATH_SCRUB_OK');
