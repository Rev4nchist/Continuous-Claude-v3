#!/usr/bin/env node
/**
 * update-blocklist.mjs — Auto-update malicious-packages.json from GitHub Advisory API
 *
 * Sources:
 *   A. GitHub Advisory API — type=malware, ecosystem=npm (confirmed malware)
 *   B. GitHub Advisory API — type=reviewed, ecosystem=pip, severity=critical
 *
 * Usage:
 *   node scripts/update-blocklist.mjs                     # Dry run — show what would change
 *   node scripts/update-blocklist.mjs --apply             # Write changes to malicious-packages.json
 *   node scripts/update-blocklist.mjs --apply --rebuild   # Write + rebuild hooks
 *
 * Requires: gh CLI authenticated (gh auth status)
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST_PATH = resolve(__dirname, '../.claude/hooks/src/shared/malicious-packages.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REBUILD = args.includes('--rebuild');

// ---------------------------------------------------------------------------
// GitHub Advisory API queries
// ---------------------------------------------------------------------------

/**
 * Synchronous backoff that exists on Windows.
 *
 * This was `execSync('sleep N')`. There is no `sleep` on Windows, so the retry
 * path threw `'sleep' is not recognized as an internal or external command` --
 * FROM INSIDE THE CATCH BLOCK, so it escaped ghApiPaginated entirely and killed
 * the whole run. The retry logic did not merely fail to wait; it converted every
 * transient GitHub hiccup into a total failure of the daily security update.
 * 28 scheduled runs, 24 [ERROR]s, 0 completions.
 *
 * Atomics.wait blocks the thread with no subprocess at all, which is the point:
 * the previous implementation shelled out to sleep for three seconds of waiting.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Set when any page exhausted its retries -- see the note in main(). */
let fetchWasIncomplete = false;
/** Set when a fetch stopped at MAX_PAGES rather than at the end of the feed. */
let fetchWasCapped = false;

/**
 * Hard ceiling on pagination.
 *
 * Found by actually running it: with the Windows `sleep` bug fixed, the npm
 * malware query no longer died on the first retry -- it paginated to page
 * 11,180 (1,118,000 advisories), ran for ~2.5 HOURS, and then died with
 * "FATAL ERROR: Reached heap limit - JavaScript heap out of memory", exit 134.
 * `allResults.push(...pageData)` accumulates the entire feed in memory and the
 * feed is now far larger than this script was written for.
 *
 * Fixing the sleep therefore turned a fast wrong answer into a slow wrong
 * answer. That is worse operationally, and it is the honest result of the first
 * end-to-end run rather than something the component tests could have shown.
 *
 * 200 pages = 20,000 advisories per query. Paired with `sort=published&
 * direction=desc` below so the cap keeps the NEWEST advisories -- the ones a
 * supply-chain guard actually needs -- instead of an arbitrary slice. Hitting
 * the cap is reported and is NOT treated as a clean run.
 */
const MAX_PAGES = Number(process.env.BLOCKLIST_MAX_PAGES || 200);

function ghApiPaginated(endpoint, { retries = 3, timeoutMs = 60000 } = {}) {
  // Fetch page-by-page to avoid ENOBUFS on large datasets (npm malware = 100+ pages)
  const allResults = [];
  let page = 1;
  const perPage = endpoint.includes('per_page=') ? '' : '&per_page=100';
  // Newest first, so MAX_PAGES truncates the OLD tail rather than an arbitrary
  // slice. A blocklist that is missing 2019 advisories is fine; one missing last
  // week's is not.
  const order = endpoint.includes('sort=') ? '' : '&sort=published&direction=desc';
  const separator = endpoint.includes('?') ? '&' : '?';

  while (true) {
    const url = `${endpoint}${perPage}${order}${separator}page=${page}`;
    let pageData = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = execSync(`gh api "${url}"`, {
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024, // 50MB per page
          timeout: timeoutMs,
        });
        const trimmed = result.trim();
        if (!trimmed) { pageData = []; break; }
        pageData = JSON.parse(trimmed);
        break;
      } catch (err) {
        const isBuffer = err.message?.includes('ENOBUFS') || err.message?.includes('maxBuffer');
        const isTimeout = err.message?.includes('ETIMEDOUT') || err.killed;
        const reason = isBuffer ? 'BUFFER_OVERFLOW' : isTimeout ? 'TIMEOUT' : err.message?.slice(0, 80);
        console.error(`  Page ${page} attempt ${attempt}/${retries}: ${reason}`);
        if (attempt < retries) {
          sleepSync(attempt * 3000);
        }
      }
    }

    if (pageData === null) {
      // Partial data is NOT a success. The merge below is additive, so a short
      // fetch cannot delete an existing blocklist entry -- but it can silently
      // fail to ADD one, and this is the feed for a supply-chain guard. A run
      // that fetched 4 of 100 pages must not exit 0 looking identical to a run
      // that fetched all of them.
      fetchWasIncomplete = true;
      console.error(`  Giving up on page ${page} after ${retries} attempts. Returning ${allResults.length} results so far.`);
      break;
    }

    if (!Array.isArray(pageData) || pageData.length === 0) break;

    allResults.push(...pageData);

    if (page >= MAX_PAGES) {
      fetchWasCapped = true;
      console.error(`\n  Reached MAX_PAGES=${MAX_PAGES} (${allResults.length} advisories). Stopping.`);
      console.error(`  Results are sorted newest-first, so this is the most recent ${allResults.length}.`);
      console.error(`  Raise with BLOCKLIST_MAX_PAGES if genuinely needed -- but note an`);
      console.error(`  unbounded run OOMed at page 11,180 after 2.5 hours (exit 134).`);
      break;
    }
    process.stdout.write(`  Page ${page}: +${pageData.length} (total: ${allResults.length})\r`);

    if (pageData.length < 100) break; // last page
    page++;
  }

  console.log(`  Fetched ${allResults.length} advisories across ${page} pages`);
  return allResults;
}

// fetchNpmMalware and fetchPypiCritical removed — ghApiPaginated called directly in main()

// ---------------------------------------------------------------------------
// Parse advisories into blocklist entries
// ---------------------------------------------------------------------------

function parseAdvisory(advisory, ecosystem) {
  const ghsaId = advisory.ghsa_id || advisory.id || 'unknown';
  const summary = advisory.summary || '';
  const publishedAt = advisory.published_at || new Date().toISOString();
  const date = publishedAt.split('T')[0];
  const htmlUrl = advisory.html_url || `https://github.com/advisories/${ghsaId}`;

  // Extract affected package names and versions
  const entries = [];

  const vulnerabilities = advisory.vulnerabilities || [];
  for (const vuln of vulnerabilities) {
    const pkg = vuln.package;
    if (!pkg) continue;

    // Skip packages from other ecosystems (multi-ecosystem advisories include all)
    const pkgEcosystem = (pkg.ecosystem || '').toLowerCase();
    if (pkgEcosystem && pkgEcosystem !== ecosystem) continue;

    const name = pkg.name;
    if (!name) continue;

    // Extract version range
    const range = vuln.vulnerable_version_range || '';
    const firstPatched = vuln.first_patched_version?.identifier;

    // For malware, we want to block ALL versions (the package itself is malicious)
    const isMalware = advisory.type === 'malware';

    entries.push({
      name: name.toLowerCase(),
      ecosystem,
      isMalware,
      range,
      firstPatched,
      reason: `${summary} (${ghsaId})`,
      date,
      advisory: htmlUrl,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Merge into existing blocklist
// ---------------------------------------------------------------------------

function mergeIntoBlocklist(blocklist, entries) {
  let newPackages = 0;
  let updatedPackages = 0;

  for (const entry of entries) {
    const section = entry.ecosystem; // 'npm' or 'pypi'
    if (!blocklist[section]) blocklist[section] = {};

    const existing = blocklist[section][entry.name];

    if (!existing) {
      // New package
      if (entry.isMalware) {
        blocklist[section][entry.name] = {
          blocked_all: true,
          reason: entry.reason,
          date: entry.date,
          advisory: entry.advisory,
        };
      } else {
        blocklist[section][entry.name] = {
          blocked_versions: [],
          reason: entry.reason,
          date: entry.date,
          advisory: entry.advisory,
        };
      }
      newPackages++;
    } else {
      // Existing package — update if we have new info
      if (entry.isMalware && !existing.blocked_all) {
        existing.blocked_all = true;
        existing.reason = entry.reason;
        existing.date = entry.date;
        existing.advisory = entry.advisory;
        updatedPackages++;
      }
      // Don't overwrite manually curated entries with less specific data
    }
  }

  return { newPackages, updatedPackages };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Verify gh is available
  try {
    execSync('gh auth status', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    console.error('Error: gh CLI not authenticated. Run: gh auth login');
    process.exit(1);
  }

  // Read existing blocklist
  let blocklist;
  try {
    blocklist = JSON.parse(readFileSync(BLOCKLIST_PATH, 'utf-8'));
  } catch {
    console.error(`Error: Could not read ${BLOCKLIST_PATH}`);
    process.exit(1);
  }

  const existingNpm = Object.keys(blocklist.npm || {}).length;
  const existingPypi = Object.keys(blocklist.pypi || {}).length;
  console.log(`Current blocklist: ${existingNpm} npm + ${existingPypi} PyPI = ${existingNpm + existingPypi} packages\n`);

  // Fetch advisories
  const npmAdvisories = ghApiPaginated('/advisories?type=malware&ecosystem=npm&per_page=100');
  const pypiAdvisories = ghApiPaginated('/advisories?type=reviewed&ecosystem=pip&severity=critical&per_page=100');

  console.log(`  npm malware advisories found: ${npmAdvisories.length}`);
  console.log(`  PyPI critical advisories found: ${pypiAdvisories.length}\n`);

  // Parse into entries
  const npmEntries = npmAdvisories.flatMap(a => parseAdvisory(a, 'npm'));
  const pypiEntries = pypiAdvisories.flatMap(a => parseAdvisory(a, 'pypi'));
  const allEntries = [...npmEntries, ...pypiEntries];

  console.log(`  Parsed entries: ${npmEntries.length} npm + ${pypiEntries.length} PyPI = ${allEntries.length} total\n`);

  // Merge
  const { newPackages, updatedPackages } = mergeIntoBlocklist(blocklist, allEntries);

  const finalNpm = Object.keys(blocklist.npm || {}).length;
  const finalPypi = Object.keys(blocklist.pypi || {}).length;

  console.log('--- Results ---');
  console.log(`  New packages added: ${newPackages}`);
  console.log(`  Existing packages updated: ${updatedPackages}`);
  console.log(`  Final blocklist: ${finalNpm} npm + ${finalPypi} PyPI = ${finalNpm + finalPypi} packages`);

  if (newPackages === 0 && updatedPackages === 0) {
    console.log('\nBlocklist is already up to date.');
    return;
  }

  if (!APPLY) {
    console.log('\nDry run complete. Use --apply to write changes.');
    // Show what would be added
    if (newPackages > 0) {
      console.log('\nNew packages that would be added:');
      for (const entry of allEntries) {
        const section = entry.ecosystem;
        // Check if this is genuinely new (not in original blocklist)
        if (!blocklist[section]?.[entry.name]) continue; // already merged, check original
        console.log(`  ${section}/${entry.name}: ${entry.reason}`);
      }
    }
    return;
  }

  // Write updated blocklist
  writeFileSync(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2) + '\n');
  console.log(`\nWritten to ${BLOCKLIST_PATH}`);

  if (REBUILD) {
    console.log('\nRebuilding hooks...');
    try {
      execSync('npm run build', {
        cwd: resolve(__dirname, '../.claude/hooks'),
        encoding: 'utf-8',
        stdio: 'inherit',
      });
      console.log('Hooks rebuilt successfully.');
    } catch {
      console.error('Hook rebuild failed. Run manually: cd .claude/hooks && npm run build');
    }

    console.log('\nSyncing to ~/.claude/...');
    try {
      execSync('bash scripts/sync-to-active.sh', {
        cwd: resolve(__dirname, '..'),
        encoding: 'utf-8',
        stdio: 'inherit',
      });
    } catch {
      console.error('Sync failed. Run manually: bash scripts/sync-to-active.sh');
    }
  }
}

main()
  .then(() => {
    // Checked HERE, not inside main(), because main() has several early returns
    // ("already up to date", dry run) and each one would otherwise need its own
    // copy of this check -- which is how the liveness predicate ended up wrong
    // at eight sites. One exit path, one assertion.
    if (fetchWasIncomplete) {
      console.error(
        '\n[ERROR] Advisory fetch was INCOMPLETE -- at least one page exhausted its retries.\n' +
        '        Any changes fetched were merged and written (the merge is additive, so\n' +
        '        nothing was removed), but this run did NOT see the full advisory set and\n' +
        '        must not be recorded as a successful daily update. Re-run when GitHub is\n' +
        '        reachable: node scripts/update-blocklist.mjs --apply');
      process.exit(1);
    }
    if (fetchWasCapped) {
      console.error(
        `\n[WARN] Advisory fetch hit MAX_PAGES=${MAX_PAGES}. The newest advisories WERE\n` +
        '       fetched and merged (results are sorted newest-first), so the blocklist is\n' +
        '       current; the older tail of the feed was not read. This is a bounded,\n' +
        '       deliberate truncation and is logged rather than hidden -- a silent cap is\n' +
        '       the defect this whole exercise is about. Exiting 0.');
    }
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
