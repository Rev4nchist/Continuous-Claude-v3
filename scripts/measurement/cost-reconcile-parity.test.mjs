// Parity: the exact-id price rule in cost-reconcile-lib.mjs gives the same dollars as hooks/shared/price.ts.
// The mjs rule cannot import price.ts (TypeScript, no file extension in its import), so the test bundles price.ts and the real-usage
// fixture with esbuild into a temp folder and imports the bundles. esbuild comes from scripts/lib/resolve-deps.mjs.
// Without esbuild the tests SKIP with the ENV reason. They never pass without a comparison.
//
// How the two rules can drift, one test each:
// X1  a step of the real-usage fixture (Sonnet 5.5 with Fable 5.1 advisor iterations, a 5m remainder, 1-hour writes) costs a different amount
// X2  the fixture `expected` totals (made by the Python rule, apart from both) differ from the mjs rule
// X3  an id, a rate class or a modifier differs: every id in prices.json, with fast mode, US geo, web search and the Haiku tier
// X4  normalizeModelId differs for a provider prefix, a date suffix, [1m] or a Bedrock version
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireDep } from '../lib/resolve-deps.mjs';
import { loadPrices, normalizeModelId, priceStep, priceUsage } from './cost-reconcile-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PLUGIN = join(REPO, '.claude', 'plugins', 'ccv3-mods');
const prices = loadPrices(join(PLUGIN, 'hooks', 'shared', 'prices.json'));

let esbuild = null;
let skip = false;
try { esbuild = requireDep('esbuild', { repoRoot: REPO }); } catch (error) { skip = `ENV: ${error.message.slice(0, 160)}`; }

const tmp = mkdtempSync(join(tmpdir(), 'ccv3-cost-parity-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
const bundle = async (entry, name) => {
  const out = esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
};
const closeTo = (a, b, label, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${label}: ${a} vs ${b}`);

test('X1 every step of the real-usage fixture costs the same in price.ts and in the mjs rule', { skip }, async () => {
  const price = await bundle(join(PLUGIN, 'hooks', 'shared', 'price.ts'), 'price');
  const { REAL_USAGE } = await bundle(join(PLUGIN, 'tests', 'fixtures', 'ledger-real-usage.ts'), 'fixture');
  let steps = 0;
  let advisorSteps = 0;
  for (const run of [REAL_USAGE.runA, REAL_USAGE.runB]) {
    for (const step of run.steps) {
      const ts = price.stepCost(step.usage, step.model);
      const mjs = priceStep(prices, step.usage, step.model);
      closeTo(mjs.usd, ts.usd, `${run.source} ${step.model}`);
      assert.equal(mjs.unknown, ts.unknown);
      steps += 1;
      if (price.advisorCost(step.usage) > 0) advisorSteps += 1;
    }
  }
  assert.ok(steps >= 10, `only ${steps} fixture steps compared`);
  assert.ok(advisorSteps >= 1, 'the fixture must hold an advisor step');
});

test('X2 the fixture expected totals (Python rule) equal the mjs rule', { skip }, async () => {
  const { REAL_USAGE } = await bundle(join(PLUGIN, 'tests', 'fixtures', 'ledger-real-usage.ts'), 'fixture2');
  const total = (run) => run.steps.reduce((s, step) => s + priceStep(prices, step.usage, step.model).usd, 0);
  closeTo(total(REAL_USAGE.runA), REAL_USAGE.expected.runA.usd, 'runA', 1e-9);
  closeTo(total(REAL_USAGE.runB), REAL_USAGE.expected.runB.usd, 'runB', 1e-9);
});

test('X3 every id of prices.json gives the same dollars, with fast mode, US geo, web search and the Haiku tier', { skip }, async () => {
  const price = await bundle(join(PLUGIN, 'hooks', 'shared', 'price.ts'), 'price3');
  const base = { input_tokens: 1234, output_tokens: 5678, cache_read_input_tokens: 90123, cache_creation_input_tokens: 4567, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } };
  const variants = [
    base,
    { ...base, speed: 'fast' },
    { ...base, inference_geo: 'us' },
    { ...base, speed: 'fast', inference_geo: 'us', server_tool_use: { web_search_requests: 3 } },
    { ...base, cache_read_input_tokens: 100_000 }, // prompt over 100,000: the Haiku high tier
  ];
  const ids = Object.keys(prices.models);
  assert.ok(ids.length >= 19);
  for (const id of ids) {
    for (const [i, usage] of variants.entries()) closeTo(priceUsage(prices, usage, id), price.estimate(usage, id), `${id} variant ${i}`);
  }
  assert.equal(priceUsage(prices, base, 'claude-nope-1'), null);
  assert.equal(price.estimate(base, 'claude-nope-1'), null);
  assert.equal(priceUsage(prices, base, '<synthetic>'), 0);
});

test('X4 normalizeModelId matches price.ts for prefixes, dates, [1m] and Bedrock versions', { skip }, async () => {
  const price = await bundle(join(PLUGIN, 'hooks', 'shared', 'price.ts'), 'price4');
  const ids = [
    'claude-sonnet-5-5', 'claude-opus-5-5[1m]', 'anthropic.claude-sonnet-5-5-v1:0', 'us.anthropic.claude-opus-4-8-20260101-v1:0',
    'vertex_ai/claude-haiku-5-5@20260301', 'claude-fable-5-1-20261001', '  Claude-Opus-5  ', 'opus', '<synthetic>', '',
  ];
  for (const id of ids) assert.equal(normalizeModelId(id), price.normalizeModelId(id), JSON.stringify(id));
});
