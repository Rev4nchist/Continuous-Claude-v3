/**
 * skill-rules.json integrity + skill-activation-prompt E2E.
 *
 * Salvaged 2026-07-29 from the 5 arscontexta-* test files deleted in the same
 * commit. Those files were fossils -- the arscontexta subsystem was removed by
 * f9cdbef (2026-06-28) and 83 of their 115 tests had been red for a month --
 * but 3 pieces of their PASSING coverage were not arscontexta-specific and
 * existed nowhere else in the suite:
 *
 *   1. Every intentPattern in skill-rules.json compiles as a valid RegExp.
 *      The production matcher wraps `new RegExp(p)` in try/catch and returns
 *      false on throw, so a malformed pattern does not error -- it silently
 *      stops a skill from ever triggering. Nothing else checks this.
 *   2. dist/skill-activation-prompt.mjs survives empty and malformed input.
 *      arscontexta-hook-e2e.test.ts was the ONLY test that spawned that built
 *      hook at all.
 *   3. Named live skills still have triggers that fire. f9cdbef purged 25
 *      skills; this is the canary for the next purge taking a live one.
 *
 * Deliberately NOT salvaged: the arscontexta-specific assertions (vacuous --
 * nothing named arscontexta-* exists), the replicated WORKFLOW_TRIGGERS suite
 * (it asserted against regex constants defined in the test file itself, so
 * production drift could never fail it), and the skill-router graph functions
 * (already covered by skill-prerequisites / skill-coactivation / skill-loading
 * / skill-toposort / skill-backward-compat / skill-router-integration).
 *
 * Every assertion here carries a positive control: the validators are pulled
 * out as pure functions and run against a fixture with a known-bad value, so a
 * validator that silently stops checking anything fails this file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename_ = fileURLToPath(import.meta.url);
const __dirname_ = resolve(__filename_, '..');
const RULES_PATH = resolve(__dirname_, '..', '..', '..', 'skills', 'skill-rules.json');
const HOOK_PATH = resolve(__dirname_, '..', '..', 'dist', 'skill-activation-prompt.mjs');
/** continuous-claude root, not .claude/ -- the hook has a ~/.claude guard. */
const PROJECT_DIR = resolve(__dirname_, '..', '..', '..', '..');

interface PromptTriggers {
  keywords?: string[];
  intentPatterns?: string[];
}
interface Rule {
  promptTriggers?: PromptTriggers;
}
interface Rules {
  skills: Record<string, Rule>;
  agents?: Record<string, Rule>;
}

/**
 * Floors, not equalities. The fossil tests asserted `=== 83` skills and broke
 * the moment a legitimate purge landed, which is how they ended up red for a
 * month. A floor still catches the thing worth catching -- a purge or a bad
 * merge deleting live registrations -- without failing on additions.
 */
const MIN_SKILLS = 58;
const MIN_AGENTS = 18;

// ── validators, extracted so they can be run against a bad fixture ─────────

/** Returns "<section>.<name>: <pattern>" for every pattern that will not compile. */
function findInvalidPatterns(rules: Rules): string[] {
  const bad: string[] = [];
  const sections: Array<[string, Record<string, Rule> | undefined]> = [
    ['skills', rules.skills],
    ['agents', rules.agents],
  ];
  for (const [section, entries] of sections) {
    for (const [name, config] of Object.entries(entries ?? {})) {
      for (const pattern of config.promptTriggers?.intentPatterns ?? []) {
        try {
          new RegExp(pattern, 'i');
        } catch {
          bad.push(`${section}.${name}: ${pattern}`);
        }
      }
    }
  }
  return bad;
}

/** Total intentPatterns seen -- guards the loop above against checking nothing. */
function countPatterns(rules: Rules): number {
  let n = 0;
  for (const entries of [rules.skills, rules.agents]) {
    for (const config of Object.values(entries ?? {})) {
      n += config.promptTriggers?.intentPatterns?.length ?? 0;
    }
  }
  return n;
}

/**
 * Does any trigger on `skillName` fire for `prompt`?
 *
 * This mirrors the matcher in skill-activation-prompt.ts rather than importing
 * it, so it is coverage of skill-rules.json DATA, not of the matcher's logic.
 * Labelled explicitly because the file this replaced did the same thing without
 * saying so, which is how its workflow-trigger suite became a self-test.
 */
function triggersFor(prompt: string, skillName: string, rules: Rules): boolean {
  const config = rules.skills[skillName];
  if (!config?.promptTriggers) return false;
  const lower = prompt.toLowerCase();
  const { keywords, intentPatterns } = config.promptTriggers;
  if (keywords?.some((kw) => lower.includes(kw.toLowerCase()))) return true;
  return (intentPatterns ?? []).some((p) => {
    try {
      return new RegExp(p, 'i').test(lower);
    } catch {
      return false;
    }
  });
}

// ── fixtures for the positive controls ────────────────────────────────────

/** `[` is an unterminated character class -- invalid in every regex flavour. */
const BROKEN_FIXTURE: Rules = {
  skills: { 'fixture-skill': { promptTriggers: { intentPatterns: ['valid', '[unclosed'] } } },
  agents: { 'fixture-agent': { promptTriggers: { intentPatterns: ['(also-unclosed'] } } },
};

const EMPTY_FIXTURE: Rules = { skills: {}, agents: {} };

describe('skill-rules.json integrity', () => {
  let rules: Rules;

  beforeAll(() => {
    expect(existsSync(RULES_PATH), `skill-rules.json missing at ${RULES_PATH}`).toBe(true);
    rules = JSON.parse(readFileSync(RULES_PATH, 'utf-8')) as Rules;
  });

  describe('intentPattern regex validity', () => {
    it('every intentPattern compiles', () => {
      expect(findInvalidPatterns(rules)).toEqual([]);
    });

    it('checked a non-trivial number of patterns (non-vacuity)', () => {
      // If a refactor empties the sections this validator reads, the test above
      // passes on an empty list. This is the guard against that.
      expect(countPatterns(rules)).toBeGreaterThan(100);
    });

    it('POSITIVE CONTROL: the validator reports known-bad patterns', () => {
      const bad = findInvalidPatterns(BROKEN_FIXTURE);
      expect(bad).toHaveLength(2);
      expect(bad[0]).toContain('skills.fixture-skill');
      expect(bad[1]).toContain('agents.fixture-agent');
    });
  });

  describe('registration floors', () => {
    it(`at least ${MIN_SKILLS} skills registered`, () => {
      expect(Object.keys(rules.skills).length).toBeGreaterThanOrEqual(MIN_SKILLS);
    });

    it(`at least ${MIN_AGENTS} agents registered`, () => {
      expect(Object.keys(rules.agents ?? {}).length).toBeGreaterThanOrEqual(MIN_AGENTS);
    });

    it('the knowledge-guide agent is registered', () => {
      expect(rules.agents?.['knowledge-guide']).toBeDefined();
    });
  });

  describe('live skills still trigger (purge canary)', () => {
    const cases: Array<[string, string]> = [
      ['fix the bug in auth', 'systematic-debugging'],
      ['commit these changes', 'commit'],
      ['ralph mode', 'ralph'],
      ['health check', 'mot'],
    ];

    for (const [prompt, skill] of cases) {
      it(`"${prompt}" still triggers ${skill}`, () => {
        expect(triggersFor(prompt, skill, rules)).toBe(true);
      });
    }

    it('POSITIVE CONTROL: no trigger fires against an empty ruleset', () => {
      for (const [prompt, skill] of cases) {
        expect(triggersFor(prompt, skill, EMPTY_FIXTURE)).toBe(false);
      }
    });
  });
});

describe('skill-activation-prompt hook E2E', () => {
  /** Returns the spawn result; callers assert on it rather than on parsed output. */
  function runHook(rawStdin: string) {
    return spawnSync('node', [HOOK_PATH], {
      input: rawStdin,
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const payload = (prompt: string) =>
    JSON.stringify({
      session_id: 'skill-rules-integrity-test',
      transcript_path: '',
      cwd: PROJECT_DIR,
      permission_mode: 'default',
      prompt,
    });

  beforeAll(() => {
    expect(existsSync(HOOK_PATH), `built hook missing at ${HOOK_PATH} -- run npm run build`).toBe(
      true
    );
  });

  it('exits cleanly on an empty prompt', () => {
    const r = runHook(payload(''));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it('exits cleanly on malformed stdin', () => {
    const r = runHook('{ this is not json');
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it('emits parseable JSON or nothing at all for a generic prompt', () => {
    const r = runHook(payload('what is the weather today'));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const stdout = (r.stdout || '').trim();
    if (stdout) expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
