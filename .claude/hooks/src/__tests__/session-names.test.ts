/**
 * Automatic session names (Session identity Phase 1, item B).
 *
 * Failure list, one test each:
 *   N1  a word another live session holds is picked again (case matters: "Otter" holds "otter")
 *   N2  a word is hex-only (the `say --to <uuid prefix>` fallback would read it as an id)
 *   N3  a word is an agent name in .claude/agents
 *   N4  one uuid gets two different words, or the list is not 48 distinct words
 *   N5  all 48 held: no fallback, or the fallback is not "<word>2"
 *   N6  headless (sdk-*) is named, desktop is not, or CCV3_AUTONAME does not override
 *   N7  an ended file, or a file with no name, holds a word
 *   N8  the degraded scan holds a file older than 7 days, or an ended file
 *   N9  the TS word list drifts from AUTO_WORDS in scripts/coordination/session-label.mjs
 *   N10 selection: session_title, compact, an own name, resume/clear carry, fork carry only from a quiet parent
 *   N11 same-name hint: fires on a fresh unended twin only, never for an auto word, never for two twins
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readIdentity, writeIdentity } from '../shared/session-identity.js';
import {
  WORDS, autoNameAllowed, chooseName, heldDegraded, heldFromLive, isAutoName, namesHeld, pickName, sameNameHint,
} from '../shared/session-names.js';
// @ts-expect-error plain .mjs without types
import { AUTO_WORDS } from '../../../../scripts/coordination/session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(HERE, '..', '..', '..', 'agents');
const U = '11111111-aaaa-4bbb-8ccc-222222222222';
const P = '33333333-aaaa-4bbb-8ccc-444444444444';
const X = '55555555-aaaa-4bbb-8ccc-666666666666';
const Y = '77777777-aaaa-4bbb-8ccc-888888888888';
let dir: string;
const saved = process.env.CCV3_IDENTITY_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'names-'));
  process.env.CCV3_IDENTITY_DIR = join(dir, 'identity');
  mkdirSync(process.env.CCV3_IDENTITY_DIR, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.CCV3_IDENTITY_DIR; else process.env.CCV3_IDENTITY_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const held = (...names: string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));

describe('word list', () => {
  it('N4 has 48 distinct lowercase words', () => {
    expect(WORDS).toHaveLength(48);
    expect(new Set(WORDS).size).toBe(48);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+$/);
  });
  it('N2 has no hex-only word', () => {
    for (const w of WORDS) expect(w, w).not.toMatch(/^[0-9a-f]+$/);
  });
  it('N3 has no agent name', () => {
    const agents = readdirSync(AGENTS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3).toLowerCase());
    expect(agents.length).toBeGreaterThan(10); // not a vacuous check
    for (const w of WORDS) expect(agents, w).not.toContain(w);
  });
  it('N9 equals AUTO_WORDS in session-label.mjs', () => {
    expect([...WORDS]).toEqual([...AUTO_WORDS]);
  });
});

describe('pickName', () => {
  it('N4 gives one uuid one word, every time', () => {
    expect(pickName(U, held())).toBe(pickName(U, held()));
    expect(WORDS).toContain(pickName(U, held()));
  });
  it('N1 skips a held word, whatever its case', () => {
    const first = pickName(U, held());
    const next = pickName(U, held(first));
    expect(next).not.toBe(first);
    expect(WORDS).toContain(next);
    expect(pickName(U, held(first.toUpperCase()))).toBe(next);
  });
  it('N5 uses "<word>2" when all 48 are held', () => {
    const got = pickName(U, held(...WORDS));
    expect(got).toMatch(/^[a-z]+2$/);
    expect(WORDS).toContain(got.slice(0, -1));
  });
  it('N4 spreads different uuids over the list', () => {
    const words = new Set(Array.from({ length: 200 }, (_, i) => pickName(`${String(i).padStart(8, '0')}-aaaa-4bbb-8ccc-222222222222`, held())));
    expect(words.size).toBeGreaterThan(20);
  });
});

describe('autoNameAllowed', () => {
  it('N6 skips headless entrypoints, names the rest', () => {
    for (const e of ['sdk-cli', 'sdk-ts', 'sdk-py']) expect(autoNameAllowed({ CLAUDE_CODE_ENTRYPOINT: e }), e).toBe(false);
    for (const e of ['cli', 'claude-desktop', undefined]) expect(autoNameAllowed({ CLAUDE_CODE_ENTRYPOINT: e }), String(e)).toBe(true);
  });
  it('N6 CCV3_AUTONAME=1 forces a name, =0 turns it off', () => {
    expect(autoNameAllowed({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CCV3_AUTONAME: '1' })).toBe(true);
    expect(autoNameAllowed({ CLAUDE_CODE_ENTRYPOINT: 'cli', CCV3_AUTONAME: '0' })).toBe(false);
  });
});

describe('held words', () => {
  it('N7 holds a live unended name only', () => {
    writeIdentity(X, { name: 'Otter', endedAt: null });
    writeIdentity(Y, { name: 'heron', endedAt: new Date().toISOString() });
    writeIdentity(P, { name: null });
    const map = heldFromLive([X, Y, P, '99999999-aaaa-4bbb-8ccc-000000000000'], readIdentity);
    expect([...namesHeld(map)]).toEqual(['otter']);
    expect([...namesHeld(map, X)]).toEqual([]);
  });
  it('N8 degraded scan skips files older than 7 days and ended files', () => {
    writeIdentity(X, { name: 'otter', endedAt: null });
    writeIdentity(Y, { name: 'heron', endedAt: null });
    writeIdentity(P, { name: 'lynx', endedAt: new Date().toISOString() });
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(process.env.CCV3_IDENTITY_DIR!, `${Y}.json`), old, old);
    expect([...namesHeld(heldDegraded(Date.now()))]).toEqual(['otter']);
  });
  it('N8 degraded scan on a missing folder holds nothing and does not throw', () => {
    process.env.CCV3_IDENTITY_DIR = join(dir, 'nope');
    expect(namesHeld(heldDegraded(Date.now())).size).toBe(0);
  });
});

describe('chooseName', () => {
  const base = { uuid: U, source: 'startup', named: false, ownName: null, previousId: null, previousName: null, previousQuiet: false, held: new Map<string, string[]>() };
  const heldMap = (...pairs: Array<[string, string]>): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const [n, id] of pairs) m.set(n, [...(m.get(n) ?? []), id]);
    return m;
  };

  it('N10 a given name always wins: no pick', () => {
    expect(chooseName({ ...base, named: true })).toBeNull();
  });
  it('N10 compact does nothing', () => {
    expect(chooseName({ ...base, source: 'compact' })).toBeNull();
  });
  it('N10 a startup with no name picks a word', () => {
    expect(WORDS).toContain(chooseName(base));
  });
  it('N10 an own name is kept (resume keeps the same id)', () => {
    expect(chooseName({ ...base, source: 'resume', ownName: 'moose' })).toBe('moose');
  });
  it('N10 resume and clear carry the previous name', () => {
    for (const source of ['resume', 'clear']) {
      expect(chooseName({ ...base, source, previousId: P, previousName: 'yak' }), source).toBe('yak');
    }
  });
  it('N10 resume does not carry a word a third live session holds', () => {
    const got = chooseName({ ...base, source: 'resume', previousId: P, previousName: 'yak', held: heldMap(['yak', X]) });
    expect(got).not.toBe('yak');
    expect(WORDS).toContain(got);
  });
  it('N10 resume carries a word only the previous session holds', () => {
    expect(chooseName({ ...base, source: 'resume', previousId: P, previousName: 'yak', held: heldMap(['yak', P]) })).toBe('yak');
  });
  it('N10 a fork carries the name only from a quiet parent', () => {
    expect(chooseName({ ...base, source: 'fork', previousId: P, previousName: 'yak', previousQuiet: true })).toBe('yak');
    const fresh = chooseName({ ...base, source: 'fork', previousId: P, previousName: 'yak', previousQuiet: false, held: heldMap(['yak', P]) });
    expect(fresh).not.toBe('yak');
    expect(WORDS).toContain(fresh);
  });
  it('N10 a startup never carries a previous name', () => {
    const got = chooseName({ ...base, previousId: P, previousName: 'yak', previousQuiet: true, held: heldMap(['yak', P]) });
    expect(got).not.toBe('yak');
  });
  it('N1 a pick avoids every held word', () => {
    const first = pickName(U, held());
    const got = chooseName({ ...base, held: heldMap([first, X]) });
    expect(got).not.toBe(first);
  });
});

describe('isAutoName', () => {
  it('matches a list word and "<word>2", any case', () => {
    expect(isAutoName('otter')).toBe(true);
    expect(isAutoName('Otter2')).toBe(true);
    expect(isAutoName('otter3')).toBe(false);
    expect(isAutoName('trex')).toBe(false);
    expect(isAutoName(null)).toBe(false);
  });
});

describe('sameNameHint', () => {
  const NOW = Date.now();
  const twin = (id: string, o: Record<string, unknown> = {}) =>
    writeIdentity(id, { name: 'foo', cwd: 'C:/work/repo', endedAt: null, ...o });

  it('N11 names the one fresh unended twin in the same cwd', () => {
    twin(X);
    const line = sameNameHint(U, 'foo', 'c:\\work\\repo\\', NOW);
    expect(line).toContain(`foo #${X.slice(0, 8)}`);
    expect(line).toContain(`lane.mjs adopt --from ${X}`);
    expect(line).toContain('never ended');
  });
  it('N11 says nothing for an ended twin, another cwd, another name, or an old file', () => {
    twin(X, { endedAt: new Date().toISOString() });
    twin(Y, { cwd: 'C:/other' });
    expect(sameNameHint(U, 'foo', 'C:/work/repo', NOW)).toBeNull();
    expect(sameNameHint(U, 'bar', 'C:/work/repo', NOW)).toBeNull();
    expect(sameNameHint(U, 'foo', 'C:/work/repo', NOW + 7 * 3600_000)).toBeNull();
  });
  it('N11 says nothing when two twins match (ambiguous)', () => {
    twin(X);
    twin(Y);
    expect(sameNameHint(U, 'foo', 'C:/work/repo', NOW)).toBeNull();
  });
  it('N11 says nothing for an auto word (a manual adopt would be refused)', () => {
    writeIdentity(X, { name: 'otter', cwd: 'C:/work/repo', endedAt: null });
    expect(sameNameHint(U, 'otter', 'C:/work/repo', NOW)).toBeNull();
  });
  it('N11 never names the session itself', () => {
    twin(U);
    expect(sameNameHint(U, 'foo', 'C:/work/repo', NOW)).toBeNull();
  });
  it('N11 a corrupt file in the folder does not throw', () => {
    writeFileSync(join(process.env.CCV3_IDENTITY_DIR!, `${Y}.json`), '{nope');
    expect(sameNameHint(U, 'foo', 'C:/work/repo', NOW)).toBeNull();
  });
});
