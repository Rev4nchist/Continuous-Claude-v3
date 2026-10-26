// Tests for review-skip-sync.mjs. Run: node --test scripts/ratchets/review-skip-sync.test.mjs
// Each case builds a temp repo root and runs the real script against it with --root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./review-skip-sync.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..', '..');
const GLOBS = ['**/*.min.js', '**/*.lock', '**/dist/**', 'docs/reviews/**'];

const reviewMd = (globs) => `# REVIEW.md\n\nPurpose line.\n\n## Skip paths\n\n\`\`\`\n${globs.join('\n')}\n\`\`\`\n`;
const yaml = (globs, eol = '\n') => [
  'language: en', 'reviews:', '  auto_review:', '    enabled: false', '  path_filters:',
  ...globs.map((g) => `    - "!${g}"`), '  profile: chill', '',
].join(eol);

function makeRoot({ review = reviewMd(GLOBS), greptile = GLOBS, coderabbit = yaml(GLOBS) } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-skip-sync-'));
  if (review !== null) writeFileSync(path.join(root, 'REVIEW.md'), review);
  mkdirSync(path.join(root, '.greptile'));
  writeFileSync(path.join(root, '.greptile', 'config.json'), JSON.stringify({ autoReview: ['open'], ignorePatterns: greptile.join('\n') }));
  writeFileSync(path.join(root, '.coderabbit.yaml'), coderabbit);
  return root;
}

function run(opts) {
  const root = makeRoot(opts);
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('in sync: exit 0, even when the lists are in a different order', () => {
  const r = run({ greptile: [...GLOBS].reverse() });
  assert.equal(r.code, 0, r.out);
});

test('in sync with CRLF line endings in the YAML and a comment inside path_filters', () => {
  const crlf = yaml(GLOBS, '\r\n').replace('    - "!**/*.lock"', '    # a comment\r\n    - "!**/*.lock"');
  assert.equal(run({ coderabbit: crlf }).code, 0);
});

test('a glob missing from the Greptile config: exit 1, and it names the glob', () => {
  const r = run({ greptile: GLOBS.filter((g) => g !== '**/*.lock') });
  assert.equal(r.code, 1);
  assert.match(r.out, /greptile/i);
  assert.match(r.out, /missing.*\*\*\/\*\.lock/);
});

test('a glob missing from the CodeRabbit config: exit 1', () => {
  const r = run({ coderabbit: yaml(GLOBS.filter((g) => g !== 'docs/reviews/**')) });
  assert.equal(r.code, 1);
  assert.match(r.out, /coderabbit/i);
  assert.match(r.out, /missing.*docs\/reviews/);
});

test('an extra glob in the CodeRabbit config: exit 1, and it names the glob', () => {
  const r = run({ coderabbit: yaml([...GLOBS, 'src/generated/**']) });
  assert.equal(r.code, 1);
  assert.match(r.out, /extra.*src\/generated/);
});

test('an extra glob in the Greptile config: exit 1', () => {
  assert.equal(run({ greptile: [...GLOBS, 'vendor/**'] }).code, 1);
});

test('a path_filters entry without "!" is an include filter, not a skip path', () => {
  const withInclude = yaml(GLOBS).replace('  profile: chill', '    - "src/**"\n  profile: chill');
  assert.equal(run({ coderabbit: withInclude }).code, 0);
});

test('REVIEW.md without a "Skip paths" section: exit 2', () => {
  assert.equal(run({ review: '# REVIEW.md\n\nNo section here.\n' }).code, 2);
});

test('REVIEW.md with the section but no fenced block: exit 2', () => {
  assert.equal(run({ review: '# REVIEW.md\n\n## Skip paths\n\n- **/*.min.js\n' }).code, 2);
});

test('REVIEW.md with an empty list: exit 2, never a vacuous pass', () => {
  assert.equal(run({ review: reviewMd([]), greptile: [], coderabbit: yaml([]) }).code, 2);
});

test('a missing REVIEW.md: exit 2', () => {
  assert.equal(run({ review: null }).code, 2);
});

test('a CodeRabbit config without path_filters: exit 2', () => {
  assert.equal(run({ coderabbit: 'language: en\nreviews:\n  profile: chill\n' }).code, 2);
});

test('this repo: REVIEW.md, .greptile/config.json and .coderabbit.yaml are in sync', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', REPO_ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
