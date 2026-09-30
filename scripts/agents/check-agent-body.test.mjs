// Failure modes for the agent-body ratchet, one test each. Each test imports the real functions
// and fails when the named detector change is made. The end-to-end check is the script run against
// the real repo and against a fixture agents dir (see .claude/cache/e2e/2026-09-30-agent-body-ratchet.txt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTools, toolConflicts, mentionsRpCli, deadScripts, regressions } from './check-agent-body.mjs';

const agent = (tools, body) => `---\nname: t\n${tools === null ? '' : tools + '\n'}---\n${body}`;
const BASH_BLOCK = '# Step\n\n```bash\nls -la\n```\n';

test('tools as an inline YAML list are parsed', () => {
  assert.deepEqual(parseTools(agent('tools: [Read, "Grep", Glob]', '')), ['Read', 'Grep', 'Glob']);
});

test('a quoted comma-string scalar is unquoted before splitting (CodeRabbit PR #68)', () => {
  assert.deepEqual(parseTools(agent('tools: "Read, Bash"', '')), ['Read', 'Bash']);
  assert.deepEqual(toolConflicts(agent('tools: "Read, Bash"', BASH_BLOCK)), []);
});

test('an explicit empty list grants nothing, so a bash block is a conflict (CodeRabbit PR #68)', () => {
  assert.deepEqual(parseTools(agent('tools: []', '')), []);
  assert.ok(toolConflicts(agent('tools: []', BASH_BLOCK)).length > 0);
});

test('tools as a block YAML list are parsed', () => {
  assert.deepEqual(parseTools(agent('tools:\n  - Read\n  - Bash  # shell', '')), ['Read', 'Bash']);
});

test('tools as a comma string are parsed', () => {
  assert.deepEqual(parseTools(agent('tools: Read, Grep, Bash', '')), ['Read', 'Grep', 'Bash']);
});

test('absent tools means inherit all, so a bash block is not a conflict', () => {
  assert.equal(parseTools(agent(null, BASH_BLOCK)), null);
  assert.deepEqual(toolConflicts(agent(null, BASH_BLOCK)), []);
});

test('a bash block with no Bash tool is a conflict; with Bash it is not', () => {
  assert.equal(toolConflicts(agent('tools: [Read, Grep]', BASH_BLOCK)).length, 1);
  assert.equal(toolConflicts(agent('tools: [Read, Bash]', BASH_BLOCK)).length, 0);
});

test('a bash block that only shows example output is not a conflict', () => {
  const body = 'Example output:\n\n```bash\nPASS 12 tests\n```\n';
  assert.deepEqual(toolConflicts(agent('tools: [Read]', body)), []);
});

test('a bash block of only comments is not a conflict', () => {
  assert.deepEqual(toolConflicts(agent('tools: [Read]', '```bash\n# nothing to run\n```\n')), []);
});

test('a non-shell fence (json, markdown) is not a conflict', () => {
  assert.deepEqual(toolConflicts(agent('tools: [Read]', '```json\n{"a": 1}\n```\n```markdown\nWrite to: x.md\n```\n')), []);
});

test('an instruction to write a file without Write is a conflict; with Write it is not', () => {
  const body = 'Write to: `$DIR/out.md`\n';
  assert.equal(toolConflicts(agent('tools: [Read, Grep]', body)).length, 1);
  assert.equal(toolConflicts(agent('tools: [Read, Write]', body)).length, 0);
});

test('a prohibition on writing is not a conflict', () => {
  assert.deepEqual(toolConflicts(agent('tools: [Read]', 'Never write to files. Do not create a file.\n')), []);
});

test('CRLF files parse the same as LF files', () => {
  const crlf = agent('tools: [Read, Grep]', BASH_BLOCK).replace(/\n/g, '\r\n');
  assert.deepEqual(parseTools(crlf), ['Read', 'Grep']);
  assert.equal(toolConflicts(crlf).length, 1);
});

test('rp-cli in the body counts; rp-cli in frontmatter alone does not', () => {
  assert.equal(mentionsRpCli(agent('tools: [Read]', "rp-cli -e 'tree'\n")), true);
  assert.equal(mentionsRpCli('---\ndescription: uses rp-cli\n---\nbody\n'), false);
});

test('a script path that exists under no root is dead; one under a root is not', () => {
  const text = agent(null, 'uv run python -m runtime.harness scripts/gone.py --x\nuv run scripts/here.py\n');
  const exists = (p) => p.replace(/\\/g, '/').endsWith('/opc/scripts/here.py') || p.replace(/\\/g, '/').endsWith('/opc/src/runtime/harness.py');
  assert.deepEqual(deadScripts(text, ['/r', '/r/opc'], exists), ['scripts/gone.py']);
});

test('a script path with a placeholder or $VAR prefix is resolved or skipped, not reported', () => {
  const text = agent(null, 'cd $CLAUDE_OPC_DIR && python $CLAUDE_OPC_DIR/scripts/mcp/x.py\npython scripts/{name}.py\n');
  const exists = (p) => p.replace(/\\/g, '/').endsWith('/opc/scripts/mcp/x.py');
  assert.deepEqual(deadScripts(text, ['/r/opc'], exists), []);
});

test('runtime.harness is dead when its module is missing from every root', () => {
  assert.deepEqual(deadScripts(agent(null, 'python -m runtime.harness\n'), ['/r'], () => false), ['runtime.harness']);
});

test('ratchet fails only when a count rises above baseline', () => {
  const base = { toolConflicts: 8, rpCli: 15, deadScripts: 7 };
  assert.deepEqual(regressions({ toolConflicts: 8, rpCli: 15, deadScripts: 7 }, base), []);
  assert.deepEqual(regressions({ toolConflicts: 3, rpCli: 0, deadScripts: 0 }, base), []);
  assert.deepEqual(regressions({ toolConflicts: 9, rpCli: 15, deadScripts: 7 }, base), ['toolConflicts']);
});
