/**
 * lane-dep-source: the callers of the dependency gate use the shared builder (contract point 4, "Source-text check").
 *
 * The twin test (lane-dep-twin.test.ts) pins what the builders return. It cannot see a caller that stops calling them.
 * This file reads the source text of the three callers and fails when one drops `openDepSql('l')`.
 *
 *   S1  the banner claimable query in lane-context.ts contains openDepSql('l') and keeps owner_session_id IS NULL
 *   S2  the claim SQL in lane.mjs (claimDepClause) contains openDepSql('l') and is spliced into the claim UPDATE
 *   S3  the next SQL in lane.mjs contains openDepSql('l') and splices it into the query
 *   S4  the banner's claimable heading says "Claimable (claim by id):" and no longer says "Claimable next:"
 *       (S4 does not check the Commands line; lane-dep-banner.test.ts D4 covers it)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_HOOK = readFileSync(join(__dirname, '../lane-context.ts'), 'utf8');
const SRC_LANE_MJS = readFileSync(join(__dirname, '../../../../scripts/coordination/lane.mjs'), 'utf8');
const OPEN_DEP = "${openDepSql('l')}";

/** The text from `start` up to the first `end` after it; fails the test when `start` is missing. */
const between = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `${start} not found`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i);
  expect(j, `${end} not found after ${start}`).toBeGreaterThan(i);
  return src.slice(i, j);
};

describe('S1: the banner claimable query', () => {
  const query = between(SRC_HOOK, 'claimable = (await client.query', '.rows;');

  it('filters out a lane with an open dependency', () => {
    expect(query).toContain(`AND NOT ${OPEN_DEP}`);
  });

  it('still offers only an unowned lane', () => {
    expect(query).toContain('owner_session_id IS NULL');
  });

  it('imports the builder from the hook twin', () => {
    expect(SRC_HOOK).toMatch(/import \{[^}]*\bopenDepSql\b[^}]*\} from '\.\/shared\/lane-dep\.js'/);
  });
});

describe('S2: the claim SQL in lane.mjs', () => {
  it('claimDepClause holds openDepSql(l) and applies to a lane that is not held', () => {
    const clause = between(SRC_LANE_MJS, 'const claimDepClause = ', ';\n');
    expect(clause).toContain(OPEN_DEP);
    expect(clause).toContain("l.state IN ('backlog','ready') OR l.owner_session_id IS NULL");
  });

  it('the claim UPDATE splices that clause in, unless --dep-override', () => {
    const fn = between(SRC_LANE_MJS, 'async function claimUpdate(', 'RETURNING l.*');
    expect(fn).toContain('withDeps && !override ? claimDepClause');
    expect(fn).toContain('${dep}');
  });
});

describe('S3: the next SQL in lane.mjs', () => {
  const next = between(SRC_LANE_MJS, 'async next(c) {', 'ORDER BY');

  it('builds its dependency filter from openDepSql(l)', () => {
    expect(next).toContain(`AND NOT ${OPEN_DEP}`);
  });

  it('splices that filter into the query', () => {
    expect(next).toContain('${noOpenDep}');
  });
});

describe('S4: the banner text', () => {
  it('the claimable heading says claim by id', () => {
    expect(SRC_HOOK).toContain("'Claimable (claim by id):'");
    expect(SRC_HOOK).not.toContain("'Claimable next:'");
  });
});
