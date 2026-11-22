// Card coord-line-ends-lf. The plugin files (ccv3-mods) and the FleetOps page template are LF in the index and
// must be LF in every checkout, whatever core.autocrlf says. Three ways this fails, one test each:
//   1. a named file holds a CR byte in the index (i/crlf or i/mixed in `git ls-files --eol`);
//   2. no `eol=lf` rule covers a named file (`git check-attr eol` says unspecified), so a Windows checkout
//      with core.autocrlf=true writes CRLF;
//   3. the rule does not reach a file in a scratch repo with core.autocrlf=true, including a file that
//      does not exist yet, while a control file outside the rule still gets CRLF (proves autocrlf is on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT = 'git';
const NAMED = ['.claude/plugins/ccv3-mods', 'scripts/coordination/fleetops'];
const sh = (args, cwd, input) =>
  execFileSync(GIT, args, { cwd, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const root = sh(['rev-parse', '--show-toplevel'], process.cwd()).trim();
const tracked = sh(['ls-files', '-z', '--', ...NAMED], root).split('\0').filter(Boolean);

test('the two named folders track files (the test is not vacuous)', () => {
  assert.ok(tracked.length > 100, `only ${tracked.length} tracked files under ${NAMED.join(', ')}`);
});

test('no named file holds a CR byte in the index', () => {
  const bad = sh(['ls-files', '--eol', '--', ...NAMED], root)
    .split('\n')
    .filter((l) => /^i\/(crlf|mixed)\s/.test(l));
  assert.deepEqual(bad, [], `CR in the index:\n${bad.join('\n')}`);
});

test('an eol=lf rule covers every named file', () => {
  const out = sh(['check-attr', '-z', '--stdin', 'eol'], root, tracked.join('\0') + '\0').split('\0');
  const notLf = [];
  for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] !== 'lf') notLf.push(`${out[i]} -> ${out[i + 2]}`);
  assert.deepEqual(notLf, [], `${notLf.length} named file(s) without eol=lf, first: ${notLf.slice(0, 3).join('; ')}`);
});

test('a checkout with core.autocrlf=true writes LF for the named paths and CRLF for a control file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineends-'));
  try {
    const g = (...a) => sh(['-c', 'core.autocrlf=true', ...a], dir);
    sh(['init', '-q'], dir);
    writeFileSync(join(dir, '.gitattributes'), readFileSync(join(root, '.gitattributes')));
    const named = [
      '.claude/plugins/ccv3-mods/hooks/hud/model.ts',
      '.claude/plugins/ccv3-mods/hooks/hooks.json',
      '.claude/plugins/ccv3-mods/brand-new/deep/file.md',
      'scripts/coordination/fleetops/page.template.html',
    ];
    const control = 'notes/control.txt';
    for (const f of [...named, control]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'one\ntwo\nthree\n');
    }
    g('add', '-A');
    for (const f of [...named, control]) rmSync(join(dir, f));
    g('checkout-index', '-f', '-a');
    for (const f of named) {
      assert.ok(!readFileSync(join(dir, f)).includes(13), `${f} has a CR byte after checkout`);
    }
    assert.ok(readFileSync(join(dir, control)).includes(13), 'the control file has no CR: core.autocrlf did not run, the test proves nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
