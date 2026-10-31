// Guards two P4 tidy-ups in the tdd skill folder, against the real repo files.
// Run: node --test scripts/skills/tdd-tidy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TDD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'skills', 'tdd');
const REFS = path.join(TDD, 'references');
const mdIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

// SKILL.md links only references/. A root copy is an orphan that drifts from the file the skill reads.
test('no root .md in the tdd folder duplicates a references/ file', () => {
  const dupes = mdIn(TDD).filter((f) => f !== 'SKILL.md' && fs.existsSync(path.join(REFS, f)));
  assert.deepEqual(dupes, [], `orphan duplicates of references/ files: ${dupes.join(', ')}`);
});

// retryOperation takes `() => Promise<T>` (ccv3-tdd.md:73, philosophy.md:75). A sync operation does not type-check.
// Only a doc that shows retryOperation is scanned, and a callback that returns a Promise on its line is valid.
test('every retry example in the tdd docs passes an async operation', () => {
  const files = [...mdIn(TDD).map((f) => path.join(TDD, f)), ...mdIn(REFS).map((f) => path.join(REFS, f))];
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('retryOperation')) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/const operation = \(/.test(line) && !/Promise/.test(line)) bad.push(`${path.relative(TDD, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `sync operation passed to retryOperation: ${bad.join(', ')}`);
});
