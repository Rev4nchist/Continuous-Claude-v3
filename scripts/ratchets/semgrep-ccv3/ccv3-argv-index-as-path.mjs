// Semgrep test fixture. This code is wrong on purpose: it is the shape that rule
// ccv3-argv-index-as-path must flag, next to the shape it must accept.
// Each annotation sits on the line above the matched line.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Bad: argv[2] is the path, so a leading flag becomes the file name. The file reads a flag too,
// which is what makes the clash possible. (A script with positional arguments only is out of scope.)
const f = process.argv[2] || (process.env.USERPROFILE + '/settings.json');
const force = process.argv.includes('--force');
// ruleid: ccv3-argv-index-as-path
const text = fs.readFileSync(f, 'utf8');
// ruleid: ccv3-argv-index-as-path
fs.copyFileSync(f, f + '.bak');
// ruleid: ccv3-argv-index-as-path
fs.writeFileSync(f, text);

// Good: the flags are dropped first, then the first non-flag is the path.
const args = process.argv.slice(2);
const g = args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'settings.json');
// ok: ccv3-argv-index-as-path
fs.readFileSync(g, 'utf8');

// Good: argv[1] is the script itself, below the positional range.
const self = process.argv[1];
// ok: ccv3-argv-index-as-path
fs.readFileSync(self, 'utf8');
