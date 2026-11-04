// Tests for classify.mjs. Each test imports the real classify. One test per way the pre-filter can go wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './classify.mjs';

const f = (file, extra = {}) => ({ file, title: 't', body: 'b', ...extra });
const blockedOf = (file, extra, opts) => classify(f(file, extra), opts).blocked;

// The real body of the S15 daemon-client.ts:570 finding: it names a Unix branch and a Windows branch.
const DAEMON_CLIENT_BODY = 'queryDaemonSync puts JSON.stringify(query) into a shell command. On Unix, execSync runs echo \'${input}\' | nc, and a single quote in a search pattern or file path closes that quote and runs the rest as shell. On Windows, the payload is interpolated into powershell -Command "...", and replacing " with \\" does not keep cmd.exe inside one quoted string.';

test('a .ps1 file is windows-only (break: drop the extension rule)', () => {
  assert.deepEqual(classify(f('scripts/start-embedding-daemon.ps1')), { blocked: 'windows-only', surface: 'windows-script' });
});

test('.bat, .cmd and .psm1 files are windows-only', () => {
  for (const file of ['a/run.bat', 'a/run.CMD', 'a/mod.psm1']) assert.equal(blockedOf(file), 'windows-only', file);
});

test('any file under a scheduled folder is windows-only, even a .sh', () => {
  assert.equal(blockedOf('.claude/scripts/scheduled/nightly.sh'), 'windows-only');
  assert.equal(blockedOf('scheduled/x.mjs'), 'windows-only');
});

test('a folder that only contains the word scheduled is not windows-only', () => {
  assert.equal(blockedOf('scripts/unscheduled/x.mjs'), null);
  assert.equal(blockedOf('scripts/scheduled-tasks.mjs'), null);
});

test('a body that names the win32 branch of process.platform is windows-only (break: drop the body rule)', () => {
  const body = "The fix is wrong when process.platform === 'win32' because the path joins with a backslash.";
  assert.equal(blockedOf('scripts/a.mjs', { body }), 'windows-only');
  assert.equal(blockedOf('scripts/a.mjs', { body: 'This path is win32-only.' }), 'windows-only');
});

test('a body that names the non-win32 branch is not blocked', () => {
  assert.equal(blockedOf('scripts/a.mjs', { body: "if (process.platform !== 'win32') the chmod runs." }), null);
});

test('the daemon-client.ts finding that names Unix and Windows is not blocked (break: match the word Windows)', () => {
  assert.deepEqual(classify(f('.claude/hooks/src/daemon-client.ts', { title: 'Sync daemon query is passed through a shell', body: DAEMON_CLIENT_BODY })), { blocked: null, surface: 'node' });
});

test('rule files are surface-unverifiable in rules, rules-src and rules-ondemand', () => {
  for (const file of ['.claude/rules/a.md', '.claude/rules-src/a.md', '.claude/rules-ondemand/pr-review-loop.md']) {
    assert.deepEqual(classify(f(file)), { blocked: 'surface-unverifiable', surface: 'rule' }, file);
  }
});

test('SKILL.md and any file under .claude/skills are surface-unverifiable', () => {
  assert.deepEqual(classify(f('plugins/x/SKILL.md')), { blocked: 'surface-unverifiable', surface: 'skill' });
  assert.deepEqual(classify(f('.claude/skills/review/run.mjs')), { blocked: 'surface-unverifiable', surface: 'skill' });
});

test('agent definitions and their json mirror are surface-unverifiable', () => {
  assert.deepEqual(classify(f('.claude/agents/kraken.md')), { blocked: 'surface-unverifiable', surface: 'agent' });
  assert.equal(blockedOf('.claude/agents/kraken.json'), 'surface-unverifiable');
});

test('a plain .md doc is surface-unverifiable (break: only block rules)', () => {
  assert.deepEqual(classify(f('docs/guide.md')), { blocked: 'surface-unverifiable', surface: 'doc' });
  assert.equal(blockedOf('README.MD'), 'surface-unverifiable');
});

test('rendered CSS and HTML are surface-unverifiable', () => {
  assert.deepEqual(classify(f('apps/agentic-os/src/web/app.css')), { blocked: 'surface-unverifiable', surface: 'ui' });
  assert.equal(blockedOf('apps/agentic-os/index.html'), 'surface-unverifiable');
});

test('code files are not blocked: .mjs, .sh, a hook .ts, an app .ts', () => {
  assert.deepEqual(classify(f('scripts/github/review-status.mjs')), { blocked: null, surface: 'node' });
  assert.deepEqual(classify(f('.claude/scripts/sync-to-active.sh')), { blocked: null, surface: 'shell' });
  assert.equal(blockedOf('.claude/hooks/src/memory-awareness.ts'), null);
  assert.equal(blockedOf('apps/agentic-os/src/server/sources/safe-message.ts'), null);
});

test('a ccv3-mods .tsx entry file is mods-host: node cannot load JSX or the claude-code module', () => {
  assert.deepEqual(classify(f('.claude/plugins/ccv3-mods/hooks/agentic-os/index.tsx')), { blocked: 'mods-host', surface: 'mods-entry' });
});

test('a ccv3-mods .ts model with no claude-code import is not blocked (the bench flows load these)', () => {
  assert.deepEqual(classify(f('.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts')), { blocked: null, surface: 'mods-model' });
  const source = "import { redact } from '../shared/redact'\nimport type { OsBrief } from '../../types'\n";
  assert.equal(blockedOf('.claude/plugins/ccv3-mods/hooks/agentic-os/brief.ts', {}, { source }), null);
});

test('a ccv3-mods .ts file that imports claude-code at run time is mods-host', () => {
  const source = "import { atom, read, update } from 'claude-code'\nimport type { EngineInterface } from 'claude-code'\n";
  assert.deepEqual(classify(f('.claude/plugins/ccv3-mods/hooks/pr-loop/slot.ts'), { source }), { blocked: 'mods-host', surface: 'mods-engine' });
});

test('a type-only claude-code import is erased, so it does not block', () => {
  const source = "import type { EngineInterface } from 'claude-code'\n";
  assert.equal(blockedOf('.claude/plugins/ccv3-mods/hooks/pr-loop/slot-model.ts', {}, { source }), null);
});

test('a .tsx outside ccv3-mods is not mods-host', () => {
  assert.equal(blockedOf('apps/agentic-os/src/web/Page.tsx'), null);
});

test('path forms are normalised: backslashes, ./ prefix, upper case extension', () => {
  assert.equal(blockedOf('scripts\\start.PS1'), 'windows-only');
  assert.equal(blockedOf('./.claude/rules-src/a.md'), 'surface-unverifiable');
  assert.equal(blockedOf('.claude\\plugins\\ccv3-mods\\hooks\\agentic-os\\index.tsx'), 'mods-host');
});

test('windows-only wins over surface-unverifiable for a .ps1 in a skill folder', () => {
  assert.equal(blockedOf('.claude/skills/x/run.ps1'), 'windows-only');
});

test('a finding with no file is an error, not a silent pass', () => {
  assert.throws(() => classify({ title: 'x' }), /file/);
  assert.throws(() => classify(null), /file/);
});

test('classify is pure: the same input gives the same output and the input is not changed', () => {
  const input = f('a.ps1');
  const frozen = JSON.stringify(input);
  assert.deepEqual(classify(input), classify(input));
  assert.equal(JSON.stringify(input), frozen);
});
