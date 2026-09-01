// artifact-url.mjs — resolve a report type's canonical Notion artifact URL.
//
// WHY THIS EXISTS. make-run.mjs requires artifactUrl to be http(s) BY DESIGN ("artifact
// URLs must outlive promotion"), so a machine-local path can never go in that field. When
// the FourthOS sponsor site died and publishing moved to a local OneDrive folder, the
// honest short-term answer was to omit artifactUrl entirely — which left the Notion hub
// with no link at all for those rows, and the folder path readable only inside the summary
// text. That is a downgrade for anyone using the hub to find the report.
//
// The fix is to point artifactUrl at the type's own report child page under the Reports
// hub. That page is not the artifact, but it is the canonical, always-reachable, http
// PLACE THE ARTIFACT IS ANNOUNCED: refresh-pages.mjs keeps its "Current run" callout in
// sync with the newest registry row, so it carries the run's status and — for FourthOS —
// the published folder path from the summary. Hub -> report page -> where the package is.
//
// The 32-hex validation is the load-bearing part, and it is not new: run-research.ps1 has
// always done exactly this check inline, because a bare "https://www.notion.so/" passes
// make-run's http(s) test while linking nowhere. This module is that guard, made shared
// and testable rather than copied a third time.
//
// CLI:
//   node scripts/report-registry/artifact-url.mjs "FourthOS Sponsor"
//     -> prints the URL on stdout, exit 0
//     -> prints the reason on stderr, exit 1, prints NOTHING on stdout
//
// Callers must treat a nonzero exit as "no artifact URL" and omit the flag, never as a
// reason to abort the run: the registry row matters more than the link on it.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IDS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'report-runs.ids.json');
export const NOTION_PAGE_BASE = 'https://www.notion.so/';

// A Notion page id is 32 hex digits, with or without dashes. Anything else — empty,
// truncated, a placeholder, a stray "undefined" — must NOT become a URL.
export function normalizePageId(raw) {
  if (typeof raw !== 'string') return null;
  const bare = raw.replace(/-/g, '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(bare) ? bare : null;
}

export function notionPageUrl(raw) {
  const id = normalizePageId(raw);
  return id ? `${NOTION_PAGE_BASE}${id}` : null;
}

// Returns { url } or { error }. Never throws for ordinary bad input, so a caller can
// report the reason instead of dying.
export function artifactUrlForType(type, ids) {
  if (!type) return { error: 'no report type given' };
  const pages = (ids && ids.childPages) || {};
  if (!Object.prototype.hasOwnProperty.call(pages, type)) {
    return { error: `no childPages entry for "${type}" in report-runs.ids.json (known: ${Object.keys(pages).join(', ')})` };
  }
  const url = notionPageUrl(pages[type]);
  if (!url) {
    return { error: `childPages["${type}"] is not a valid 32-hex Notion page id (got ${JSON.stringify(pages[type])})` };
  }
  return { url };
}

export function loadIds(path = IDS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function main() {
  const type = process.argv[2];
  let ids;
  try {
    ids = loadIds();
  } catch (e) {
    console.error(`[artifact-url] cannot read ${IDS_PATH}: ${e.message}`);
    return 1;
  }
  const { url, error } = artifactUrlForType(type, ids);
  if (error) {
    console.error(`[artifact-url] ${error}`);
    return 1;
  }
  console.log(url);
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[artifact-url] ERROR: ${e.message}`);
    process.exit(1);
  }
}
