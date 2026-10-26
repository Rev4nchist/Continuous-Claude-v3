/**
 * The coderabbit-cli manifest entry must route the CodeRabbit skill-install command.
 * Greptile finding 4376918073: rule-router strips `npx` before it tests the patterns, so a
 * `^npx\s+skills ...` pattern never matches. Failure modes: an install (with or without npx, any
 * -y flag or @version) loads no guidance; a plain mention of the word loads it by mistake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { matchRules, type Manifest } from '../rule-router.js';

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../rules-ondemand/manifest.json'), 'utf8'),
) as Manifest;

const ids = (tool: string, command: string): string[] =>
  matchRules({ session_id: 's', tool_name: tool, tool_input: { command } }, manifest).map((r) => r.id);

describe('rule-router manifest: coderabbit-cli', () => {
  it.each([
    'npx skills add coderabbitai/skills',
    'skills add coderabbitai/skills',
    'npx -y skills add coderabbitai/skills',
    'npx -y skills@latest add coderabbitai/skills -g',
    'cr review --agent',
    'coderabbit skills install',
  ])('routes %s on Bash and PowerShell', (command) => {
    expect(ids('Bash', command)).toContain('coderabbit-cli');
    expect(ids('PowerShell', command)).toContain('coderabbit-cli');
  });

  it.each([
    'npx skills add vercel-labs/skills',
    'git commit -m "npx skills add coderabbitai/skills is banned"',
    'echo "skills add coderabbitai/skills"',
    'cat .coderabbit.yaml',
  ])('does not route %s', (command) => {
    expect(ids('Bash', command)).not.toContain('coderabbit-cli');
  });
});
