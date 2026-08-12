#!/usr/bin/env node
// poll.mjs — check watched channels for new uploads; optionally ingest them.
//
//   node scripts/youtube/poll.mjs             # report only (safe, read-only)
//   node scripts/youtube/poll.mjs --ingest    # also pull new videos into the corpus
//   node scripts/youtube/poll.mjs --json      # machine-readable
//
// Deliberately does NOT synthesize. Polling gathers raw material and raises a
// `pendingDigest` count; deciding what is worth a digest is a judgment call that
// stays with you (or with an explicit `/yt dig`). An unattended job that both
// gathers AND concludes is how a research corpus fills with confident noise.
//
// Exit code is 0 for "polled successfully, nothing new" AND for "found N new".
// A non-zero exit means the poll itself failed — callers must distinguish these
// by reading the JSON, never by exit code alone (.claude/rules/headless-claude-mcp.md).
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WATCHLIST_PATH, LOG_ROOT, YT_ROOT } from './lib/config.mjs';
import { ensureDir, ingestedIds, allIngestedIds } from './lib/corpus.mjs';
import { listTarget } from './lib/ytdlp.mjs';

function loadWatchlist() {
  if (!existsSync(WATCHLIST_PATH)) return { version: 1, channels: [] };
  try {
    const w = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8'));
    return { version: w.version ?? 1, channels: w.channels ?? [] };
  } catch (e) {
    throw new Error(`watchlist.json is unreadable: ${e.message}`);
  }
}

function saveWatchlist(w) {
  writeFileSync(WATCHLIST_PATH, `${JSON.stringify(w, null, 2)}\n`, 'utf8');
}

function logLine(msg) {
  ensureDir(LOG_ROOT);
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(LOG_ROOT, `poll-${day}.log`), `${new Date().toISOString()} ${msg}\n`, 'utf8');
}

function main() {
  const argv = process.argv.slice(2);
  const doIngest = argv.includes('--ingest');
  const json = argv.includes('--json');
  const log = (...a) => { if (!json) console.log(...a); };

  const w = loadWatchlist();
  const active = w.channels.filter((c) => !c.paused);

  if (active.length === 0) {
    const out = { polled: 0, channels: [], totalNew: 0, errors: [] };
    if (json) console.log(JSON.stringify(out, null, 2));
    else log('Watchlist has no active channels.');
    logLine('poll: no active channels');
    return;
  }

  const known = allIngestedIds();
  const results = [];
  const errors = [];

  for (const ch of active) {
    try {
      const listing = listTarget(ch.target, { limit: ch.limit ?? 10 });
      const fresh = listing.entries.filter((e) => !known.has(e.id));

      results.push({
        slug: ch.slug,
        name: ch.name,
        checked: listing.entries.length,
        new: fresh.length,
        newVideos: fresh.map((e) => ({ id: e.id, title: e.title })),
      });

      ch.lastPolledAt = new Date().toISOString();
      ch.lastNewCount = fresh.length;

      log(`${ch.name}: ${fresh.length} new of ${listing.entries.length} checked`);
      for (const f of fresh) log(`    - ${f.title.slice(0, 70)}`);

      if (doIngest && fresh.length > 0) {
        // Reuse the ingest CLI rather than duplicating its logic — one code path
        // for "how a video becomes a corpus file", regardless of trigger.
        const res = spawnSync(
          process.execPath,
          [join(YT_ROOT, 'ingest.mjs'), ch.target, '--limit', String(ch.limit ?? 10), '--quiet'],
          { encoding: 'utf8', timeout: 20 * 60 * 1000, windowsHide: true, input: '' },
        );
        if (res.status !== 0) {
          const detail = (res.stderr || res.stdout || '').trim().slice(0, 300);
          errors.push({ slug: ch.slug, stage: 'ingest', detail });
          log(`    ! ingest failed: ${detail}`);
        } else {
          const after = ingestedIds(ch.slug);
          const landed = fresh.filter((f) => after.has(f.id)).length;
          ch.pendingDigest = (ch.pendingDigest ?? 0) + landed;
          results[results.length - 1].ingested = landed;
          log(`    ingested ${landed}`);
        }
      }
    } catch (e) {
      errors.push({ slug: ch.slug, stage: 'list', detail: e.message });
      log(`${ch.name}: POLL FAILED — ${e.message}`);
    }
  }

  saveWatchlist(w);

  const out = {
    polledAt: new Date().toISOString(),
    polled: active.length,
    totalNew: results.reduce((n, r) => n + r.new, 0),
    totalIngested: results.reduce((n, r) => n + (r.ingested ?? 0), 0),
    channels: results,
    errors,
  };

  logLine(`poll: ${out.polled} channels, ${out.totalNew} new, ${out.totalIngested} ingested, ${errors.length} error(s)`);

  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    log('');
    log(`Polled ${out.polled} channel(s) · ${out.totalNew} new · ${out.totalIngested} ingested · ${errors.length} error(s)`);
    if (out.totalNew > 0 && !doIngest) log('Run with --ingest to pull them into the corpus.');
  }

  // Fail loud only when EVERY channel failed — a single dead channel should not
  // mark the whole nightly run red.
  if (errors.length > 0 && errors.length === active.length) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(`poll failed: ${e.message}`);
  logLine(`poll: FATAL ${e.message}`);
  process.exit(1);
}
