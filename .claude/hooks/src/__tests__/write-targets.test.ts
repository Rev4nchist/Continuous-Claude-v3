/**
 * Card coord-file-claims-all-writers: how file-claims finds the file a tool call writes.
 *
 * Group A (exact path field): Edit, Write, NotebookEdit, Desktop Commander write_file, edit_block, move_file.
 * Group B (shell text, no lexer): a needle match built from a CLAIMED path (seat word 2026-11-13 10:55).
 *
 * Ways group B can fail (one test each):
 *  1. A real write to a held file is missed (redirect, tee, Set-Content, sed -i, mv, cp, git checkout, rm).
 *  2. A read of a held file is denied (the three controls of the seat: a ">" that is not before the path).
 *  3. A cue inside another word counts ("cpu", "form").
 *  4. A path that only looks like the held file counts (src/a.tsx, other/src/a.ts).
 *  5. A spelling of the held file is missed (absolute, backslash, Git Bash drive form, quotes, ./).
 *  6. A cue after the path counts (the cue must come first).
 *  7. A claim that is not named gives a verdict.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CLAIM_TOOLS, classifyShellText, directWritePaths } from '../shared/write-targets.js';

const HELD = [{ filePath: 'src/a.ts', forms: ['src/a.ts', 'c:/repo/src/a.ts', '/c/repo/src/a.ts'] }];
const verdict = (text: string, fold = false) => classifyShellText(text, HELD, fold);

describe('classifyShellText: real writes to a held file', () => {
  it.each([
    ['echo x > src/a.ts'],
    ['echo x >> src/a.ts'],
    ['echo x >src/a.ts'],
    ['echo x > "src/a.ts"'],
    ["echo x > 'src/a.ts'"],
    ['echo x > ./src/a.ts'],
    ['echo x > c:/repo/src/a.ts'],
    ['echo x > c:\\repo\\src\\a.ts'],
    ['echo x > /c/repo/src/a.ts'],
    ['echo x | tee src/a.ts'],
    ["Set-Content -LiteralPath 'src/a.ts' -Value x"],
    ['Add-Content src/a.ts x'],
    ['"x" | Out-File src/a.ts'],
    ['sed -i s/a/b/ src/a.ts'],
    ['sed -i.bak s/a/b/ src/a.ts'],
    ['mv scratch.txt src/a.ts'],
    ['cp scratch.txt src/a.ts'],
    ['git checkout -- src/a.ts'],
    ['git restore src/a.ts'],
    ['rm src/a.ts'],
    ['Remove-Item src/a.ts'],
    ['Move-Item x src/a.ts'],
    ['Copy-Item x src/a.ts'],
  ])('denies: %s', (text) => {
    expect(verdict(text)).toMatchObject({ kind: 'deny', filePath: 'src/a.ts' });
  });
});

describe('classifyShellText: reads of a held file are not denied (seat controls)', () => {
  it.each([
    ['node --test src/a.ts 2>&1 | tail -5'],
    ['git diff main -- src/a.ts > scratch.txt'],
    ['cat src/a.ts 2>/dev/null'],
    ['grep -n foo src/a.ts'],
    ['cat src/a.ts; cp x y'],
  ])('mentions only: %s', (text) => {
    expect(verdict(text)).toEqual({ kind: 'mention', filePath: 'src/a.ts' });
  });
});

describe('classifyShellText: whole-word cues and path boundaries', () => {
  it('does not read cp inside cpu, rm inside form, or tee inside committee', () => {
    expect(verdict('echo cpu src/a.ts').kind).toBe('mention');
    expect(verdict('echo form src/a.ts').kind).toBe('mention');
    expect(verdict('echo committee src/a.ts').kind).toBe('mention');
  });
  it('does not match a path that only starts or ends like the held one', () => {
    expect(verdict('echo x > src/a.tsx')).toEqual({ kind: 'none' });
    expect(verdict('echo x > other/src/a.ts')).toEqual({ kind: 'none' });
    expect(verdict('echo x > src/a.ts.bak')).toEqual({ kind: 'none' });
    expect(verdict('rm xsrc/a.ts')).toEqual({ kind: 'none' });
  });
  it('folds case only when told to (win32, darwin)', () => {
    expect(verdict('echo x > SRC/A.TS', true).kind).toBe('deny');
    expect(verdict('echo x > SRC/A.TS', false)).toEqual({ kind: 'none' });
  });
  it('gives none for text with no claimed path, and for no claims', () => {
    expect(verdict('echo hello > scratch.txt')).toEqual({ kind: 'none' });
    expect(classifyShellText('echo x > src/a.ts', [], false)).toEqual({ kind: 'none' });
    expect(verdict('')).toEqual({ kind: 'none' });
  });
  it('a deny on one claim wins over a mention of another', () => {
    const two = [
      { filePath: 'src/b.ts', forms: ['src/b.ts'] },
      { filePath: 'src/a.ts', forms: ['src/a.ts'] },
    ];
    expect(classifyShellText('cat src/b.ts; echo x > src/a.ts', two, false)).toMatchObject({ kind: 'deny', filePath: 'src/a.ts' });
  });
});

describe('review round 1 (seat reviewer, 2026-11-13 11:21)', () => {
  it.each([
    ['echo x | bin/rm src/a.ts'],
    ['node cp.mjs src/a.ts'],
    ['node tee.ts src/a.ts'],
    ['echo a -> src/a.ts'],
    ['echo a => src/a.ts'],
    ['cp src/a.ts out.txt'],
    ['cp -r src/a.ts out.txt'],
    ['Copy-Item src/a.ts out.txt'],
    ['Copy-Item -Force -LiteralPath src/a.ts out.txt'],
  ])('F4 F5 F1a: a mention, never a deny: %s', (text) => {
    expect(verdict(text).kind).toBe('mention');
  });

  it.each([
    ['sed -E -i s/a/b/ src/a.ts', 'sed'],
    ['sed -e x -i src/a.ts', 'sed'],
    ['Tee-Object -FilePath src/a.ts', 'tee-object'],
    ['copy x src/a.ts', 'copy'],
    ['move x src/a.ts', 'move'],
    ['del src/a.ts', 'del'],
    ['erase src/a.ts', 'erase'],
    ['ri src/a.ts', 'ri'],
    ['Clear-Content src/a.ts', 'clear-content'],
    ['node scripts/tools/safe-replace.mjs src/a.ts old new', 'safe-replace'],
    ['rm -f out.log; cat src/a.ts', 'rm'],
    ['cp x src/a.ts', 'cp'],
    ['echo x &>src/a.ts', '>'],
    ['echo x 2>src/a.ts', '>'],
  ])('F3 F1: denies and names the cue: %s', (text, cue) => {
    const v = verdict(text);
    expect(v.kind).toBe('deny');
    expect(v.kind === 'deny' && v.cue.toLowerCase().startsWith(cue)).toBe(true);
  });

  it('F5: a ">" after - or = is not a redirect, a ">" after a space or a digit is', () => {
    expect(verdict('echo a ->src/a.ts').kind).toBe('mention');
    expect(verdict('echo a =>src/a.ts').kind).toBe('mention');
    expect(verdict('echo a >src/a.ts').kind).toBe('deny');
    expect(verdict('>src/a.ts').kind).toBe('deny');
  });

  it('F8: a long flag run does not backtrack, and text above the size cap is skipped', () => {
    const t0 = Date.now();
    expect(verdict(`sed ${'-ab '.repeat(10000)}src/a.ts`).kind).toBe('mention');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(verdict(`${'x '.repeat(40000)} > src/a.ts`)).toEqual({ kind: 'none' });
  });

  it('F2: a form that came from the lower-cased project key matches in any case, even where case is kept', () => {
    const claims = [{ filePath: 'src/a.ts', forms: [], ciForms: ['/tmp/abc/repo/src/a.ts'] }];
    expect(classifyShellText('echo x > /tmp/AbC/Repo/src/a.ts', claims, false).kind).toBe('deny');
    expect(classifyShellText('echo x > /tmp/AbC/Repo/src/b.ts', claims, false)).toEqual({ kind: 'none' });
  });

  it('a verdict carries the holder and the project for the message and the warn key', () => {
    const claims = [{ filePath: 'src/a.ts', holder: 'h1', project: 'p1', forms: ['src/a.ts'] }];
    expect(classifyShellText('cat src/a.ts', claims, false)).toEqual({ kind: 'mention', filePath: 'src/a.ts', holder: 'h1', project: 'p1' });
    expect(classifyShellText('rm src/a.ts', claims, false)).toEqual({ kind: 'deny', filePath: 'src/a.ts', holder: 'h1', project: 'p1', cue: 'rm' });
  });
});

describe('registration: the matcher and the runtime gate name the same tools', () => {
  const tpl = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'settings.json.template'), 'utf-8')) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ args?: string[] }> }> };
  };
  const entriesOf = (hook: string) =>
    tpl.hooks.PreToolUse.filter((e) => e.hooks.some((h) => (h.args ?? []).some((a) => a.endsWith(`/${hook}.mjs`))));
  const covers = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);

  it('file-claims is registered once, on a matcher that covers every tool the runtime gate handles', () => {
    const entries = entriesOf('file-claims');
    expect(entries).toHaveLength(1);
    for (const tool of CLAIM_TOOLS) expect(covers(entries[0].matcher, tool), tool).toBe(true);
  });
  it('the matcher names no tool the runtime gate ignores', () => {
    const matcher = entriesOf('file-claims')[0].matcher;
    expect(matcher.split('|').sort()).toEqual([...CLAIM_TOOLS].sort());
  });
  it('file-claims shares its entry with no other hook (decision-gate keeps Edit|Write)', () => {
    expect(entriesOf('file-claims')[0].hooks).toHaveLength(1);
    expect(entriesOf('decision-gate').some((e) => e.matcher === 'Edit|Write')).toBe(true);
  });
});

describe('directWritePaths (group A)', () => {
  const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
  it('reads the path field of each exact-path writer', () => {
    expect(directWritePaths({ tool_name: 'Edit', tool_input: { file_path: 'a' } })).toEqual(['a']);
    expect(directWritePaths({ tool_name: 'Write', tool_input: { file_path: 'a' } })).toEqual(['a']);
    expect(directWritePaths({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } })).toEqual(['n.ipynb']);
    expect(directWritePaths({ tool_name: `${DC}write_file`, tool_input: { path: 'w' } })).toEqual(['w']);
    expect(directWritePaths({ tool_name: `${DC}edit_block`, tool_input: { file_path: 'e' } })).toEqual(['e']);
  });
  it('move_file gives both paths, the destination first (review F9)', () => {
    expect(directWritePaths({ tool_name: `${DC}move_file`, tool_input: { source: 's', destination: 'd' } })).toEqual(['d', 's']);
  });
  it('gives an empty list for a missing or non-string field, and null for any other tool', () => {
    expect(directWritePaths({ tool_name: 'NotebookEdit', tool_input: {} })).toEqual([]);
    expect(directWritePaths({ tool_name: `${DC}move_file`, tool_input: { source: 's', destination: 5 } })).toEqual(['s']);
    expect(directWritePaths({ tool_name: 'Read', tool_input: { file_path: 'a' } })).toBeNull();
    expect(directWritePaths({ tool_name: 'Bash', tool_input: { command: 'x' } })).toBeNull();
    expect(directWritePaths({ tool_name: `${DC}read_file`, tool_input: { path: 'a' } })).toBeNull();
  });
});
