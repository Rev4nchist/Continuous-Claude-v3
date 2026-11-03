import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepo(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'skills', 'tdd', 'SKILL.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = findRepo(process.cwd()) || findRepo(here);
if (!repo) {
  console.error('repo root not found');
  process.exit(1);
}
const fail = (msg) => { console.error(msg); process.exit(1); };
const tdd = path.join(repo, '.claude', 'skills', 'tdd');
const refs = path.join(tdd, 'references');
const pages = ['deep-modules.md', 'mocking-boundaries.md', 'philosophy.md', 'ccv3-tdd.md'];

for (const name of ['deep-modules.md', 'mocking-boundaries.md']) {
  if (fs.existsSync(path.join(tdd, name))) fail('orphan root copy: ' + name);
}
for (const name of pages) {
  if (!fs.existsSync(path.join(refs, name))) fail('missing references/' + name);
}
const dupes = fs.readdirSync(tdd).filter((f) => f.endsWith('.md') && f !== 'SKILL.md' && fs.existsSync(path.join(refs, f)));
if (dupes.length) fail('orphan duplicates: ' + dupes.join(', '));

const skill = fs.readFileSync(path.join(tdd, 'SKILL.md'), 'utf8');
for (const name of pages) {
  if (!skill.includes('](references/' + name + ')')) fail('SKILL.md missing link to references/' + name);
}

const docs = fs.readdirSync(tdd).filter((f) => f.endsWith('.md')).map((f) => path.join(tdd, f))
  .concat(fs.readdirSync(refs).filter((f) => f.endsWith('.md')).map((f) => path.join(refs, f)));
for (const file of docs) {
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (/const operation = \(/.test(line)) fail('sync operation ' + path.relative(tdd, file) + ':' + (i + 1));
  });
}
const philosophy = fs.readFileSync(path.join(refs, 'philosophy.md'), 'utf8');
if (!/const operation = async \(\) =>/.test(philosophy) || !philosophy.includes('await retryOperation(operation)')) {
  fail('philosophy retry example is not an async operation');
}
const wf = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ccv3-checks.yml'), 'utf8');
if (!wf.includes('node --test scripts/skills/tdd-tidy.test.mjs')) fail('ci does not run tdd-tidy');
console.log('tdd skill links resolve and retry examples are async');
