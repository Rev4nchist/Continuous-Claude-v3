/**
 * decision-gate PR B step 1: the async parse is hoisted out of the sync decide/handle (card coord-guard-shell-parser, note 63).
 * parseCalls is async, decide and handle are sync (about 20 test files call them sync), so main parses first and passes the result in on Deps.parsed.
 * Failure modes, one row each:
 *   H1 a Bash text that holds a trigger word is parsed once, with the bash dialect
 *   H2 a PowerShell text that holds a trigger word is parsed with the pwsh dialect
 *   H3 a text with no trigger word is NOT parsed (a pwsh child costs 400 ms or more on every shell call otherwise)
 *   H4 unreadable input, a write tool and a parse that throws leave deps unchanged, and never throw
 *   H5 Desktop Commander (shell unknown) is parsed as both dialects
 */
import { describe, expect, it, vi } from 'vitest';
import { withParsed, type Deps } from '../decision-gate.js';

vi.setConfig({ testTimeout: 60000 });
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
const base = { git: () => ({ status: 1, stdout: '' }), readFile: () => null, env: {}, home: '/h' } as unknown as Deps;
const payload = (tool_name: string, command: string) => JSON.stringify({ tool_name, tool_input: { command }, cwd: '/repo' });
const P = 'pu' + 'sh';

describe('withParsed (step 1 of the PR B port)', () => {
  it('H1: a Bash text with a trigger word is parsed as bash and the git call is in the result', async () => {
    const d = await withParsed(payload('Bash', `git ${P} fork feat/x | tail -3`), base);
    expect(d.parsed?.text).toBe(`git ${P} fork feat/x | tail -3`);
    expect(Object.keys(d.parsed?.byDialect ?? {})).toEqual(['bash']);
    expect(d.parsed?.byDialect.bash?.calls.some((c) => c.words[0]?.lit === 'git')).toBe(true);
  });
  it('H1b: the raw command is parsed, with heredoc bodies kept (readCommand blanks them for the old reader)', async () => {
    const text = `cat <<'EOF' | git ${P} fork feat/x\nbody line\nEOF`;
    const d = await withParsed(payload('Bash', text), base);
    expect(d.parsed?.text).toBe(text);
  });
  it('H2: a PowerShell text with a trigger word is parsed as pwsh', async () => {
    const d = await withParsed(payload('PowerShell', `git ${P} fork feat/x 2>&1 | Select-Object -Last 3`), base);
    expect(Object.keys(d.parsed?.byDialect ?? {})).toEqual(['pwsh']);
    expect(d.parsed?.byDialect.pwsh?.calls.some((c) => c.words[0]?.lit === 'git')).toBe(true);
  });
  it('H3: a text with no trigger word is not parsed', async () => {
    for (const [tool, text] of [['Bash', 'ls -la src'], ['PowerShell', 'Get-ChildItem -Recurse'], ['Bash', 'npm test']] as const) {
      const d = await withParsed(payload(tool, text), base);
      expect(d.parsed, text).toBeUndefined();
    }
  });
  it('H4: bad JSON, a non-object, a write tool and a missing command leave deps unchanged', async () => {
    for (const raw of ['{not json', '[]', 'null', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x.md', content: `git ${P}` } }), JSON.stringify({ tool_name: 'Bash', tool_input: {} })]) {
      const d = await withParsed(raw, base);
      expect(d, raw).toBe(base);
    }
  });
  it('H4b: a parser that throws does not throw out of withParsed, and the failure stays visible in the result (rule F1 reads it in a later step)', async () => {
    const boom = { ...base, parseOpts: { bashProvider: async () => { throw new Error('wasm trap'); } } } as unknown as Deps;
    const d = await withParsed(payload('Bash', `git ${P} fork feat/x`), boom);
    expect(d.parsed?.byDialect.bash?.errors.length).toBeGreaterThan(0);
    expect(d.parsed?.byDialect.bash?.calls).toEqual([]);
  });
  it('H5: a Desktop Commander start_process text is parsed as both dialects', async () => {
    const d = await withParsed(payload(`${DC}start_process`, `git ${P} fork feat/x`), base);
    expect(Object.keys(d.parsed?.byDialect ?? {}).sort()).toEqual(['bash', 'pwsh']);
  });
});
