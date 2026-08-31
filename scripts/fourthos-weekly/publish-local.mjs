// publish-local.mjs -- publish a FourthOS sponsor package to a LOCAL shareable folder.
//
// WHY THIS EXISTS. The sponsor site was GitHub Pages on Rev4nchist/ai-enablement-decks.
// That repo was made private ~2026-08-06, which deletes the Pages site on the free tier,
// and it CANNOT be made public again (Dave, 2026-08-31). Every promoted week plus the
// preview has been HTTP 404 since. The replacement target is a local folder under
// "OneDrive - Fourth Limited": Dave shares it from there, Fourth-internal, nothing public.
//
// THE PROBLEM THAT MAKES THIS MORE THAN A COPY. The generated decks link to each other
// with ABSOLUTE paths rooted at the Pages base path -- 82 of them across the three files:
//
//     href="/ai-enablement-decks/fourthos/preview/briefing.html#sponsor-actions"
//
// Copied anywhere else and opened, every one of those resolves against the filesystem
// root and 404s. A plain copy produces a package whose navigation is entirely dead, and
// it LOOKS fine until someone clicks. So this tool rewrites them to relative and then
// PROVES the output has none left, rather than trusting the rewrite.
//
// CLI:
//   node scripts/fourthos-weekly/publish-local.mjs                    # publish the preview
//   node scripts/fourthos-weekly/publish-local.mjs --dry-run          # report, write nothing
//   node scripts/fourthos-weekly/publish-local.mjs --source <dir>     # a dated package
//   node scripts/fourthos-weekly/publish-local.mjs --date 2026-08-05  # override folder name
//   node scripts/fourthos-weekly/publish-local.mjs --dest <dir>       # override dest root
//
// Exit codes: 0 published (or dry run clean) - 1 nothing published, reason printed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SOURCE = 'C:/Users/david.hayes/Projects/ai-enablement-decks/fourthos/preview';
export const BASE_PATH = '/ai-enablement-decks';
export const DECK_FILES = ['index.html', 'briefing.html', 'deep-dive.html'];

// The destination root. Prefer the live OneDrive env var so this keeps working if the
// tenant folder is ever renamed; fall back to the known path.
export function defaultDestRoot(env = process.env) {
  const od = env.OneDrive || env.OneDriveCommercial;
  const root = od && od.trim() ? od : 'C:/Users/david.hayes/OneDrive - Fourth Limited';
  return join(root, 'FourthOS Sponsor Updates');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- the rewrite (pure) ----------------------------------------------------------
//
// Four shapes, and one that must NOT be guessed at:
//   <base>/fourthos/<segment>/            -> index.html      (this package's own root)
//   <base>/fourthos/<segment>/#frag       -> index.html#frag
//   <base>/fourthos/<segment>/<file>      -> <file>          (sibling in the same folder)
//   <base>/ or <base>/#frag               -> the HUB, which does not exist locally.
//                                            The href is STRIPPED, leaving the anchor's
//                                            text in place. Rendering a dead breadcrumb
//                                            that silently goes nowhere is worse than a
//                                            non-clickable one.
//   anything else under <base>/           -> UNRESOLVED. Reported, never rewritten.
//                                            A link to a DIFFERENT dated package has no
//                                            local target, and quietly pointing it at a
//                                            sibling file would be a fabricated link.
export function rewriteLinks(html, { segment, basePath = BASE_PATH } = {}) {
  if (!segment) throw new Error('rewriteLinks: segment is required');
  const selfPrefix = `${basePath}/fourthos/${segment}/`;
  const counts = { self: 0, hub: 0, unresolved: 0 };
  const unresolved = [];

  // Hub links first: strip the href, keep the element and its text.
  let out = html.replace(
    new RegExp(`\\s*href="${escapeRe(basePath)}/(#[^"]*)?"`, 'g'),
    () => { counts.hub += 1; return ''; },
  );

  out = out.replace(new RegExp(`href="${escapeRe(basePath)}/[^"]*"`, 'g'), (match) => {
    const target = match.slice('href="'.length, -1);
    if (!target.startsWith(selfPrefix)) {
      counts.unresolved += 1;
      if (!unresolved.includes(target)) unresolved.push(target);
      return match;
    }
    const rest = target.slice(selfPrefix.length);
    counts.self += 1;
    if (rest === '') return 'href="index.html"';
    if (rest.startsWith('#')) return `href="index.html${rest}"`;
    return `href="${rest}"`;
  });

  return { html: out, counts, unresolved };
}

// Any absolute-root href left in the OUTPUT is a bug in the rewrite, not a warning.
export function findAbsoluteHrefs(html) {
  return [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
}

export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { f[k] = true; } else { f[k] = next; i += 1; }
  }
  return f;
}

// Derive the folder name for this package: --date wins, then card.json's date, then today.
export function resolvePublishDate(sourceDir, flagDate, now = new Date()) {
  if (typeof flagDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flagDate)) return flagDate;
  const card = join(sourceDir, 'card.json');
  if (existsSync(card)) {
    try {
      const d = JSON.parse(readFileSync(card, 'utf8')).date;
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    } catch { /* fall through to today */ }
  }
  return now.toISOString().slice(0, 10);
}

export function main() {
  const f = parseFlags(process.argv.slice(2));
  const dryRun = f['dry-run'] === true;
  const sourceDir = resolve(typeof f.source === 'string' ? f.source : DEFAULT_SOURCE);
  const segment = basename(sourceDir);

  if (!existsSync(sourceDir)) {
    console.error(`[publish-local] source does not exist: ${sourceDir}`);
    return 1;
  }
  const missing = DECK_FILES.filter((n) => !existsSync(join(sourceDir, n)));
  if (missing.length) {
    console.error(`[publish-local] source is not a complete package -- missing: ${missing.join(', ')}`);
    return 1;
  }

  // A failed-run marker does NOT block publishing: the FourthOS preview has carried an
  // _ERROR.md from the 08-12/19/26 Pages failures while the HTML itself is the good,
  // hand-tuned 08-05 package. Blocking here would refuse to publish the one artifact
  // worth sharing. Report it loudly instead, with the file dates, so what is being
  // shared is never in doubt.
  const errPath = join(sourceDir, '_ERROR.md');
  if (existsSync(errPath)) {
    const first = readFileSync(errPath, 'utf8').split(/\r?\n/).find((l) => l.trim()) || '(empty)';
    console.error(`[publish-local] NOTE: source carries _ERROR.md from a failed run -- "${first.trim().slice(0, 100)}"`);
    console.error('[publish-local] the HTML below is published anyway; check its dates:');
  }
  for (const n of DECK_FILES) {
    console.error(`[publish-local]   ${n}  ${statSync(join(sourceDir, n)).mtime.toISOString().slice(0, 10)}`);
  }

  const date = resolvePublishDate(sourceDir, f.date);
  const destRoot = resolve(typeof f.dest === 'string' ? f.dest : defaultDestRoot());
  const destDir = join(destRoot, date);

  console.error(`[publish-local] ${sourceDir}  ->  ${destDir}${dryRun ? '  (DRY RUN)' : ''}`);

  const written = [];
  let totalSelf = 0;
  let totalHub = 0;
  const allUnresolved = [];

  for (const name of DECK_FILES) {
    const raw = readFileSync(join(sourceDir, name), 'utf8');
    const { html, counts, unresolved } = rewriteLinks(raw, { segment });
    totalSelf += counts.self;
    totalHub += counts.hub;
    for (const u of unresolved) if (!allUnresolved.includes(u)) allUnresolved.push(u);

    const left = findAbsoluteHrefs(html);
    if (left.length) {
      console.error(`[publish-local] ABORT: ${name} still has ${left.length} absolute link(s) after rewrite:`);
      for (const l of [...new Set(left)].slice(0, 8)) console.error(`[publish-local]     ${l}`);
      console.error('[publish-local] nothing written. A package with dead navigation must not be shared.');
      return 1;
    }
    written.push([name, html]);
  }

  console.error(`[publish-local] rewrote ${totalSelf} in-package link(s); neutralised ${totalHub} hub breadcrumb(s)`);
  if (allUnresolved.length) {
    console.error(`[publish-local] ABORT: ${allUnresolved.length} link(s) point outside this package and have no local target:`);
    for (const u of allUnresolved) console.error(`[publish-local]     ${u}`);
    return 1;
  }

  if (dryRun) {
    console.error('[publish-local] DRY RUN clean -- rerun without --dry-run to publish.');
    console.log(destDir);
    return 0;
  }

  mkdirSync(destDir, { recursive: true });
  for (const [name, html] of written) writeFileSync(join(destDir, name), html, 'utf8');
  const card = join(sourceDir, 'card.json');
  if (existsSync(card)) writeFileSync(join(destDir, 'card.json'), readFileSync(card, 'utf8'), 'utf8');

  // Verify from DISK, not from the in-memory string that was just checked. The write is
  // the step that can still go wrong (encoding, truncation, a half-full volume).
  for (const name of DECK_FILES) {
    const back = readFileSync(join(destDir, name), 'utf8');
    const left = findAbsoluteHrefs(back);
    if (left.length) {
      console.error(`[publish-local] POST-WRITE CHECK FAILED: ${name} on disk has ${left.length} absolute link(s).`);
      return 1;
    }
  }
  console.error(`[publish-local] published ${DECK_FILES.length} file(s); post-write check clean (0 absolute links on disk).`);
  console.log(destDir);
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[publish-local] ERROR: ${e.message}`);
    process.exit(1);
  }
}
