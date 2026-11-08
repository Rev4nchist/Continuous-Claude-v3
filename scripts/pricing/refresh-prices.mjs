#!/usr/bin/env node
/**
 * refresh-prices.mjs - Build and check the model price table of the ccv3-mods plugin.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing.md
 * Files:  .claude/plugins/ccv3-mods/hooks/shared/prices.json (the source of truth)
 *         .claude/plugins/ccv3-mods/hooks/shared/prices.generated.ts (its TypeScript twin; price.ts imports it)
 *
 * Usage:
 *   node scripts/pricing/refresh-prices.mjs            fetch the page, then write both files (a human runs this, then opens a PR)
 *   node scripts/pricing/refresh-prices.mjs --check    fetch, parse, compare. Exit 1 on drift. Never writes.
 * Flags:
 *   --from <file>     read a saved copy of the page, no network (offline mode)
 *   --prices <path>   prices.json to write or compare (default: the plugin's file)
 *   --fetched-at <t>  fetchedAt to store (default: now, or the saved copy's mtime with --from)
 * Exit: 0 clean (or written). 1 drift. 2 the page could not be fetched or parsed.
 * A price change never opens a PR on its own: the nightly check only fails.
 * Node builtins only.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrices, diffPrices, toGeneratedTs } from './pricing-parse.mjs';

const SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const pricesPath = resolve(value('--prices') ?? join(repoRoot, '.claude/plugins/ccv3-mods/hooks/shared/prices.json'));
const tsPath = join(dirname(pricesPath), 'prices.generated.ts');
const savedCopy = value('--from');

const fail2 = message => {
  console.error(`ENV: ${message}`);
  process.exit(2);
};

const loadPage = async () => {
  if (savedCopy !== undefined) return { md: readFileSync(savedCopy, 'utf8'), fetchedAt: statSync(savedCopy).mtime.toISOString() };
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail2(`GET ${SOURCE} gave HTTP ${res.status}`);
  return { md: await res.text(), fetchedAt: new Date().toISOString() };
};

const main = async () => {
  const page = await loadPage().catch(error => fail2(`cannot read the pricing page: ${error.message}`));
  let fresh;
  try {
    fresh = buildPrices(page.md, { source: SOURCE, fetchedAt: value('--fetched-at') ?? page.fetchedAt });
  } catch (error) {
    fail2(error.message);
  }
  const models = Object.keys(fresh.models).length;

  if (!flag('--check')) {
    writeFileSync(pricesPath, `${JSON.stringify(fresh, null, 2)}\n`);
    writeFileSync(tsPath, toGeneratedTs(fresh));
    console.log(`wrote ${pricesPath} and ${tsPath}: ${models} model ids, fetched ${fresh.fetchedAt}`);
    return;
  }

  let stored;
  try {
    stored = JSON.parse(readFileSync(pricesPath, 'utf8'));
  } catch (error) {
    fail2(`cannot read ${pricesPath}: ${error.message}`);
  }
  const drift = diffPrices(stored, fresh);
  try {
    // core.autocrlf=true gives a CRLF checkout of the twin; the content is the same.
    if (readFileSync(tsPath, 'utf8').replace(/\r\n/g, '\n') !== toGeneratedTs(stored)) drift.push(`${tsPath} is not the twin of ${pricesPath}`);
  } catch {
    drift.push(`${tsPath} is missing`);
  }
  if (drift.length === 0) {
    console.log(`PASS prices.json matches the page: ${models} model ids, ${Object.values(fresh.models).filter(m => m.retired).length} retired, hash ${fresh.sectionHash.slice(0, 12)}`);
    return;
  }
  console.log(`FAIL price drift: ${drift.length} difference(s) between ${pricesPath} and the page`);
  for (const line of drift) console.log(`  ${line}`);
  console.log('A human reviews the change, runs `node scripts/pricing/refresh-prices.mjs`, and opens a PR.');
  process.exit(1);
};

await main();
