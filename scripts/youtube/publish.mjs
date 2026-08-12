#!/usr/bin/env node
// publish.mjs — push a finished digest (brief or lab spec) to the Notion
// "YouTube Research" database.
//
//   node scripts/youtube/publish.mjs <digest.md> [options]
//
//   --status S    draft|reviewed|ratified|dropped  (default: draft)
//   --replace     overwrite an existing row's page body (default: refuse)
//   --dry-run     print the row that would be written, touch nothing
//   --json        machine-readable result
//
// Idempotency key is the digest's `digest_id` frontmatter field. Re-publishing
// the same digest UPDATES its row rather than appending a duplicate; the page
// BODY is only rewritten with --replace, because silently clobbering a page a
// human may have annotated is exactly the kind of write the safety rules forbid.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiPost, apiPatch, createPageFromMarkdown, requireIds,
  title, richText, select, number, date,
} from './lib/notion.mjs';
import { parseFrontmatter } from './lib/corpus.mjs';
import { REPO_ROOT } from './lib/config.mjs';

// Digests are hard-wrapped at ~95 cols so they read well in an editor and diff
// cleanly. ntn's markdown converter, however, emits ONE Notion paragraph block
// PER SOURCE LINE — so a wrapped paragraph arrives in Notion split mid-sentence
// ("...62 with transcripts, ~262k" / "words, ingested 2026-07-25..."). Verified
// 2026-07-25: a 3.4k-word digest produced 85 paragraph blocks.
//
// So: re-join wrapped prose before publishing. Local markdown keeps its wrapping;
// only what ships to Notion is unwrapped. Structural lines are passed through
// untouched — fenced code, tables, headings, list markers, and blank lines all
// carry meaning that joining would destroy.
const FENCE_RE = /^\s*(```|~~~)/;
const STRUCTURAL_RE = /^\s*(#{1,6}\s|\||>|---\s*$|\*\*\*\s*$|___\s*$)/;
const LIST_RE = /^\s*([-*+]\s|\d+[.)]\s)/;

export function unwrapProse(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buf = [];
  let inFence = false;

  const flush = () => {
    if (buf.length) { out.push(buf.join(' ')); buf = []; }
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) { flush(); inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    if (line.trim() === '') { flush(); out.push(''); continue; }

    // A structural line never joins, and always terminates a run.
    if (STRUCTURAL_RE.test(line)) { flush(); out.push(line); continue; }

    // A list marker starts a NEW logical line, but its wrapped continuation
    // lines should fold into it — so start a fresh buffer rather than flushing
    // into passthrough.
    if (LIST_RE.test(line)) { flush(); buf.push(line.trimEnd()); continue; }

    buf.push(buf.length === 0 ? line.trimEnd() : line.trim());
  }
  flush();

  return out.join('\n');
}

const REQUIRED = ['digest_id', 'date', 'type', 'title'];
const VALID_TYPES = new Set(['brief', 'lab']);
const VALID_VERDICTS = new Set(['adopt', 'watch', 'skip', 'n/a']);
const VALID_STATUS = new Set(['draft', 'reviewed', 'ratified', 'dropped']);

function parseArgs(argv) {
  const o = { file: null, status: 'draft', replace: false, dryRun: false, printBody: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--status') { o.status = argv[++i]; continue; }
    if (a === '--replace') { o.replace = true; continue; }
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--print-body') { o.printBody = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    if (!o.file) o.file = a;
    else throw new Error(`Unexpected extra argument: ${a}`);
  }
  if (!o.file) throw new Error('Usage: publish.mjs <digest.md> [--status S] [--replace] [--dry-run]');
  if (!VALID_STATUS.has(o.status)) {
    throw new Error(`--status must be one of ${[...VALID_STATUS].join('|')}, got "${o.status}"`);
  }
  return o;
}

// Validate up front so a bad digest fails BEFORE any Notion write, not halfway
// through one.
function loadDigest(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Digest not found: ${path}`);

  const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const missing = REQUIRED.filter((k) => !meta[k]);
  if (missing.length) {
    throw new Error(`Digest ${file} is missing required frontmatter: ${missing.join(', ')}`);
  }
  if (!VALID_TYPES.has(meta.type)) {
    throw new Error(`type must be brief|lab, got "${meta.type}"`);
  }
  if (meta.verdict && !VALID_VERDICTS.has(meta.verdict)) {
    throw new Error(`verdict must be one of ${[...VALID_VERDICTS].join('|')}, got "${meta.verdict}"`);
  }
  if (!body.trim()) throw new Error(`Digest ${file} has no body content`);

  return { path, meta, body };
}

function findExistingRow(dataSourceId, digestId) {
  const res = apiPost(`v1/data_sources/${dataSourceId}/query`, {
    filter: { property: 'Digest ID', rich_text: { equals: digestId } },
    page_size: 1,
  });
  return res.results?.[0] ?? null;
}

function buildProperties(meta, status, corpusPath) {
  return {
    Title: title(meta.title),
    Type: select(meta.type),
    Topic: richText(meta.topic ?? ''),
    Channels: richText(meta.channels ?? ''),
    Verdict: select(meta.verdict ?? 'n/a'),
    Status: select(status),
    Videos: number(meta.videos ?? null),
    Citations: number(meta.citations ?? null),
    Date: date(meta.date),
    'Digest ID': richText(meta.digest_id),
    'Corpus Path': richText(corpusPath),
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { path, meta, body } = loadDigest(o.file);
  const corpusPath = meta.corpus_path || relative(REPO_ROOT, path).replace(/\\/g, '/');

  // Inspect exactly what would ship to Notion, without publishing.
  if (o.printBody) { console.log(unwrapProse(body).trim()); return; }

  if (o.dryRun) {
    const preview = {
      digestId: meta.digest_id, title: meta.title, type: meta.type,
      topic: meta.topic ?? null, channels: meta.channels ?? null,
      verdict: meta.verdict ?? 'n/a', status: o.status,
      videos: meta.videos ?? null, citations: meta.citations ?? null,
      date: meta.date, corpusPath, bodyChars: body.length,
    };
    console.log(o.json ? JSON.stringify(preview, null, 2)
      : `DRY RUN — would publish:\n${JSON.stringify(preview, null, 2)}`);
    return;
  }

  const ids = requireIds();
  const existing = findExistingRow(ids.dataSourceId, meta.digest_id);
  const props = buildProperties(meta, o.status, corpusPath);

  let pageId;
  let action;

  if (existing) {
    pageId = existing.id;
    apiPatch(`v1/pages/${pageId}`, { properties: props });
    action = 'updated';

    if (o.replace) {
      // Body replacement is deliberately NOT automatic — see module header.
      console.error(
        '  note: --replace updates row properties but does not rewrite the page body.\n'
        + '        Notion has no atomic body-replace; delete the page in Notion and re-publish\n'
        + '        if the body genuinely needs to change.',
      );
    }
  } else {
    // ntn converts the markdown body into Notion blocks for us.
    const created = createPageFromMarkdown(`data-source:${ids.dataSourceId}`, unwrapProse(body).trim());
    pageId = created.id || created.page?.id;
    if (!pageId) throw new Error(`pages create returned no id: ${JSON.stringify(created).slice(0, 300)}`);
    apiPatch(`v1/pages/${pageId}`, { properties: props });
    action = 'created';
  }

  const url = `https://app.notion.com/p/${String(pageId).replace(/-/g, '')}`;
  const result = { action, digestId: meta.digest_id, pageId, url, status: o.status };

  if (o.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${action}: ${meta.title}\n  ${url}`);
}

// Only run the CLI when this file is the entry point — `unwrapProse` is imported
// by the test suite, and importing a module must never execute its main().
const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  try {
    main();
  } catch (e) {
    console.error(`publish failed: ${e.message}`);
    process.exit(1);
  }
}
