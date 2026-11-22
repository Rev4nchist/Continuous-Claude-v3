// Ways the price-table builder and the drift check can fail. One test per way.
// P1 the Sonnet 5 footnote marker stays in a cell, so its rate parses wrong or not at all
// P2 a retired row is dropped, or kept without its retired flag
// P3 the table has fewer ids than the page (a row is skipped, or two rows share an id)
// P4 the two Haiku 5.5 rows collapse into one rate, or the over-100K rate is lost
// P5 the cache-hit rate is guessed from a multiplier (Fable 5.1 is 0.25, Fable 5 is 1.00)
// P6 fast-mode rates miss the "Opus 5 / Opus 4.8" shared row
// P7 web search, the US geo multiplier and the Haiku prompt threshold are not read from the page
// P8 a page with no model table passes as an empty table
// P9 the drift check ignores a changed rate, a new row, a removed row, a changed modifier or a changed rule text
// P10 the drift check flags fetchedAt, which changes on every run
// P11 the committed prices.json differs from what the saved page gives
// P12 the CLI exits 0 on a clean table and 1 on a changed rate, in a temp copy
// P13 a CRLF checkout of prices.generated.ts (core.autocrlf=true) fails --check, or a stale twin passes it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrices, diffPrices, parsePricing, toGeneratedTs } from './pricing-parse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'pricing-trimmed.md');
const md = readFileSync(FIXTURE, 'utf8');
const built = () => buildPrices(md, { source: 'https://example.test/pricing.md', fetchedAt: '2026-11-08T20:13:35.000Z' });
const clone = value => JSON.parse(JSON.stringify(value));

test('P1 Sonnet 5 parses as 2 in and 10 out with the footnote marker stripped', () => {
  const sonnet5 = parsePricing(md).models['claude-sonnet-5'];
  assert.equal(sonnet5.input, 2);
  assert.equal(sonnet5.output, 10);
  assert.equal(sonnet5.cacheHit, 0.2);
});

test('P2 retired rows stay in the table with retired true; live rows are false', () => {
  const { models } = parsePricing(md);
  for (const id of ['claude-opus-4-1', 'claude-opus-4', 'claude-sonnet-4']) assert.equal(models[id]?.retired, true, id);
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']) assert.equal(models[id]?.retired, false, id);
  assert.equal(models['claude-opus-4-1']?.input, 15);
  assert.equal(models['claude-opus-4-1']?.write1h, 30);
});

test('P3 every id of the page table is present once', () => {
  const ids = Object.keys(parsePricing(md).models);
  assert.deepEqual(ids, [
    'claude-fable-5-2', 'claude-mythos-5-2',
    'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5',
    'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
    'claude-opus-4-1', 'claude-opus-4',
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
    'claude-haiku-5-5', 'claude-haiku-4-5',
  ]);
});

test('P4 Haiku 5.5 keeps the low rates and gains an over100k tier', () => {
  const haiku = parsePricing(md).models['claude-haiku-5-5'];
  assert.deepEqual([haiku.input, haiku.write5m, haiku.write1h, haiku.cacheHit, haiku.output], [0.1, 0.125, 0.2, 0.01, 0.5]);
  assert.deepEqual(haiku.over100k, { input: 0.5, write5m: 0.625, write1h: 1, cacheHit: 0.05, output: 2.5 });
  assert.equal(parsePricing(md).models['claude-haiku-4-5'].over100k, undefined);
});

test('P5 cache hit comes from the cell: Fable 5.2 0.20, Fable 5.1 0.25, Fable 5 1.00, Opus 5.5 0.20, Sonnet 5.5 0.10', () => {
  const { models } = parsePricing(md);
  assert.equal(models['claude-fable-5-2'].cacheHit, 0.2);
  assert.equal(models['claude-mythos-5-2'].cacheHit, 0.2);
  assert.equal(models['claude-fable-5-1'].cacheHit, 0.25);
  assert.equal(models['claude-mythos-5-1'].cacheHit, 0.25);
  assert.equal(models['claude-fable-5'].cacheHit, 1);
  assert.equal(models['claude-mythos-5'].cacheHit, 1);
  assert.equal(models['claude-opus-5-5'].cacheHit, 0.2);
  assert.equal(models['claude-opus-5'].cacheHit, 0.5);
  assert.equal(models['claude-sonnet-5-5'].cacheHit, 0.1);
});

test('P6 fast mode: Fable 5.2 and Mythos 5.2 16/80, Opus 5.5 8/40, Opus 5 and Opus 4.8 10/50, nobody else', () => {
  const { models } = parsePricing(md);
  assert.deepEqual([models['claude-fable-5-2'].fastInput, models['claude-fable-5-2'].fastOutput], [16, 80]);
  assert.deepEqual([models['claude-mythos-5-2'].fastInput, models['claude-mythos-5-2'].fastOutput], [16, 80]);
  assert.deepEqual([models['claude-opus-5-5'].fastInput, models['claude-opus-5-5'].fastOutput], [8, 40]);
  assert.deepEqual([models['claude-opus-5'].fastInput, models['claude-opus-5'].fastOutput], [10, 50]);
  assert.deepEqual([models['claude-opus-4-8'].fastInput, models['claude-opus-4-8'].fastOutput], [10, 50]);
  const withFast = Object.entries(models).filter(([, row]) => row.fastInput !== undefined).map(([id]) => id);
  assert.deepEqual(withFast, ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']);
});

test('P7 web search 0.01 per request, US geo 1.1 from 4.6 up, Haiku threshold 100000', () => {
  const parsed = parsePricing(md);
  assert.equal(parsed.modifiers.webSearchPerRequest, 0.01);
  assert.equal(parsed.modifiers.usGeoMultiplier, 1.1);
  assert.equal(parsed.modifiers.haikuPromptTierTokens, 100000);
  assert.equal(parsed.models['claude-opus-4-6'].geo, true);
  assert.equal(parsed.models['claude-sonnet-5-5'].geo, true);
  assert.equal(parsed.models['claude-opus-4-5'].geo, false);
  assert.equal(parsed.models['claude-haiku-4-5'].geo, false);
});

test('P8 a page with no model table throws; it never gives an empty table', () => {
  assert.throws(() => parsePricing('# Pricing\n\nNothing here.\n'), /Model pricing/);
  assert.throws(() => parsePricing(md.replace('## Model pricing', '## Models')), /Model pricing/);
});

test('P9 drift: a changed rate, a new row, a removed row, a changed modifier and changed rule text each show', () => {
  const base = built();
  assert.deepEqual(diffPrices(base, clone(base)), []);

  const rate = clone(base);
  rate.models['claude-sonnet-5-5'].cacheHit = 0.2;
  assert.match(diffPrices(base, rate).join('\n'), /claude-sonnet-5-5.*cacheHit/);

  const added = clone(base);
  added.models['claude-new-9'] = { ...added.models['claude-opus-5-5'] };
  assert.match(diffPrices(base, added).join('\n'), /claude-new-9/);

  const removed = clone(base);
  delete removed.models['claude-opus-4'];
  assert.match(diffPrices(base, removed).join('\n'), /claude-opus-4\b/);

  const modifier = clone(base);
  modifier.modifiers.webSearchPerRequest = 0.02;
  assert.match(diffPrices(base, modifier).join('\n'), /webSearchPerRequest/);

  const text = clone(base);
  text.sectionHash = 'x'.repeat(64);
  assert.match(diffPrices(base, text).join('\n'), /sectionHash/);
});

test('P10 drift ignores fetchedAt and the whitespace of the page', () => {
  const base = built();
  const later = { ...clone(base), fetchedAt: '2030-01-01T00:00:00.000Z' };
  assert.deepEqual(diffPrices(base, later), []);
  const spaced = buildPrices(md.replace(/\| /g, '|   '), { source: base.source, fetchedAt: base.fetchedAt });
  assert.deepEqual(diffPrices(base, spaced), []);
});

test('P10b a reworded rule line moves the section hash', () => {
  const reworded = buildPrices(md.replace('1.1x multiplier', '1.2x multiplier'), { source: 's', fetchedAt: 'f' });
  assert.ok(diffPrices(built(), reworded).length > 0);
});

test('P11 the committed prices.json is what the saved page gives', () => {
  const committed = JSON.parse(readFileSync(join(here, '..', '..', '.claude/plugins/ccv3-mods/hooks/shared/prices.json'), 'utf8'));
  assert.deepEqual(diffPrices(committed, built()), []);
  assert.equal(readFileSync(join(here, '..', '..', '.claude/plugins/ccv3-mods/hooks/shared/prices.generated.ts'), 'utf8').replace(/\r\n/g, '\n'), toGeneratedTs(committed));
});

const cli = (...args) => spawnSync(process.execPath, [join(here, 'refresh-prices.mjs'), ...args], { encoding: 'utf8' });

test('P12 CLI --check exits 0 on a clean table and 1 on one changed rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const clean = join(dir, 'prices.json');
  writeFileSync(clean, JSON.stringify(built(), null, 2));
  writeFileSync(join(dir, 'prices.generated.ts'), toGeneratedTs(built()));
  const ok = cli('--check', '--from', FIXTURE, '--prices', clean);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  const drifted = clone(built());
  drifted.models['claude-opus-5-5'].output = 21;
  const bad = join(dir, 'drifted.json');
  writeFileSync(bad, JSON.stringify(drifted, null, 2));
  const fail = cli('--check', '--from', FIXTURE, '--prices', bad);
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stdout, /claude-opus-5-5.*output/);
});

test('P12b CLI --check never edits prices.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const file = join(dir, 'prices.json');
  const drifted = clone(built());
  drifted.models['claude-opus-5-5'].output = 21;
  writeFileSync(file, JSON.stringify(drifted, null, 2));
  const before = readFileSync(file, 'utf8');
  cli('--check', '--from', FIXTURE, '--prices', file);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('P12c CLI exits 2, not 0, when the page has no table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const page = join(dir, 'page.md');
  writeFileSync(page, '# Pricing\n');
  const res = cli('--check', '--from', page);
  assert.equal(res.status, 2, res.stdout + res.stderr);
});

test('P13 --check accepts a CRLF twin and rejects a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const file = join(dir, 'prices.json');
  writeFileSync(file, JSON.stringify(built(), null, 2));
  const twin = join(dir, 'prices.generated.ts');
  writeFileSync(twin, toGeneratedTs(built()).replace(/\n/g, '\r\n'));
  const crlf = cli('--check', '--from', FIXTURE, '--prices', file);
  assert.equal(crlf.status, 0, crlf.stdout + crlf.stderr);

  const stale = clone(built());
  stale.models['claude-opus-5-5'].output = 21;
  writeFileSync(twin, toGeneratedTs(stale));
  const bad = cli('--check', '--from', FIXTURE, '--prices', file);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /is not the twin/);
});

const withoutLines = drop => md.split(/\r?\n/).filter(line => !drop(line)).join(String.fromCharCode(10));
const savedPage = (text, name = 'page.md') => {
  const file = join(mkdtempSync(join(tmpdir(), 'prices-')), name);
  writeFileSync(file, text);
  return file;
};
const storedCopy = stored => {
  const dir = mkdtempSync(join(tmpdir(), 'prices-'));
  const file = join(dir, 'prices.json');
  writeFileSync(file, JSON.stringify(stored, null, 2));
  writeFileSync(join(dir, 'prices.generated.ts'), toGeneratedTs(stored));
  return file;
};

test('P14 --check exits 1 and names a model row that the page no longer has', () => {
  const page = savedPage(withoutLines(line => line.startsWith('| Claude Opus 4 (')));
  assert.equal(parsePricing(readFileSync(page, 'utf8')).models['claude-opus-4'], undefined);
  const res = cli('--check', '--from', page, '--prices', storedCopy(built()));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /removed models\.claude-opus-4\./);
});

test('P14b --check exits 1 and names a stored modifier key that the page no longer has', () => {
  const stored = clone(built());
  stored.modifiers.legacyFee = 3;
  const res = cli('--check', '--from', FIXTURE, '--prices', storedCopy(stored));
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /removed modifiers\.legacyFee/);
});

test('P14c diffPrices reports a removed and an added key in the same run', () => {
  const base = built();
  const next = clone(base);
  delete next.models['claude-opus-4'];
  next.models['claude-new-9'] = { ...next.models['claude-opus-5-5'] };
  const lines = diffPrices(base, next);
  assert.ok(lines.some(l => /^removed models\.claude-opus-4\./.test(l)), lines.join(' | '));
  assert.ok(lines.some(l => /^added models\.claude-new-9\./.test(l)), lines.join(' | '));
});

test('P15 a model table with a header and a ruler but no rows is a parse failure: exit 2', () => {
  const headerOnly = withoutLines(line => /^\| Claude /.test(line));
  assert.match(headerOnly, /\| Model \|/);
  assert.throws(() => parsePricing(headerOnly), /no model rows/);
  const res = cli('--check', '--from', savedPage(headerOnly), '--prices', storedCopy(built()));
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /no model rows/);
  const bare = withoutLines(line => /^\| (Claude |:-)/.test(line));
  assert.throws(() => parsePricing(bare), /no model rows/);
});
