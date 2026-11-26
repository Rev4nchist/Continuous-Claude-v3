// RED stub (card listed-id-scan-tool): finds no hit and exits 0 on any input. The rows of scan-listed.test.mjs that expect a hit, an exit 1 or an exit 2 fail.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function scanText() { return { gate: 0, strict: 0, hits: [] }; }
export function main(argv) {
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root');
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ files: files.map((file) => ({ file, gate: 0, strict: 0, hits: [] })), gate: 0, strict: 0 })}\n`);
  return 0;
}
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exitCode = main(process.argv.slice(2));
