#!/usr/bin/env node
// watchlist.mjs — manage the set of channels the poller checks for new uploads.
//
//   node scripts/youtube/watchlist.mjs list
//   node scripts/youtube/watchlist.mjs add "@handle" [--label "Name"] [--limit N] [--topic "..."]
//   node scripts/youtube/watchlist.mjs remove <slug>
//   node scripts/youtube/watchlist.mjs pause <slug> | resume <slug>
//
// `add` RESOLVES the target against YouTube before storing it, so a typo fails
// here (loud, interactive) instead of silently producing an empty poll every
// night forever.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WATCHLIST_PATH, STATE_ROOT, slugify } from './lib/config.mjs';
import { ensureDir } from './lib/corpus.mjs';
import { listTarget, normalizeTarget } from './lib/ytdlp.mjs';

function load() {
  if (!existsSync(WATCHLIST_PATH)) return { version: 1, channels: [] };
  try {
    const w = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8'));
    return { version: w.version ?? 1, channels: w.channels ?? [] };
  } catch {
    return { version: 1, channels: [] };
  }
}

function save(w) {
  ensureDir(STATE_ROOT);
  writeFileSync(WATCHLIST_PATH, `${JSON.stringify(w, null, 2)}\n`, 'utf8');
}

function cmdList(w) {
  if (!w.channels.length) {
    console.log('Watchlist is empty.');
    console.log('  add one: node scripts/youtube/watchlist.mjs add "@handle"');
    return;
  }
  const width = Math.max(8, ...w.channels.map((c) => c.name.length));
  console.log(`${'CHANNEL'.padEnd(width)}  SLUG${' '.repeat(Math.max(1, 22 - 4))}LIMIT  STATE   PENDING  TOPIC`);
  for (const c of w.channels) {
    console.log(
      `${c.name.padEnd(width)}  ${(c.slug || '').padEnd(22)}${String(c.limit ?? 10).padStart(5)}  ` +
      `${(c.paused ? 'paused' : 'active').padEnd(7)} ${String(c.pendingDigest ?? 0).padStart(7)}  ${c.topic ?? ''}`,
    );
  }
}

function cmdAdd(w, argv) {
  const target = argv[0];
  if (!target || target.startsWith('--')) throw new Error('add requires a target: watchlist.mjs add "@handle"');

  let label = null;
  let limit = 10;
  let topic = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--label') { label = argv[++i]; continue; }
    if (argv[i] === '--limit') { limit = Number(argv[++i]); continue; }
    if (argv[i] === '--topic') { topic = argv[++i]; continue; }
    throw new Error(`Unknown flag: ${argv[i]}`);
  }

  // Resolve now so a bad handle fails loudly here, not silently at 6am.
  const url = normalizeTarget(target);
  process.stdout.write(`Resolving ${target} ... `);
  const listing = listTarget(target, { limit: 1 });
  const name = label || listing.channel;
  const slug = slugify(name);
  console.log(`ok — "${name}"`);

  if (w.channels.some((c) => c.slug === slug)) {
    console.log(`Already watching "${name}" (${slug}). Nothing to do.`);
    return;
  }

  w.channels.push({
    slug,
    name,
    target,
    url,
    channelId: listing.channelId ?? null,
    limit,
    topic,
    paused: false,
    addedAt: new Date().toISOString(),
    lastPolledAt: null,
    lastNewCount: 0,
    pendingDigest: 0,
  });
  save(w);
  console.log(`Watching "${name}" (${slug}) — poll checks the ${limit} most recent uploads.`);
}

function cmdRemove(w, argv) {
  const slug = argv[0];
  if (!slug) throw new Error('remove requires a slug (see: watchlist.mjs list)');
  const before = w.channels.length;
  w.channels = w.channels.filter((c) => c.slug !== slug);
  if (w.channels.length === before) {
    console.log(`No watched channel with slug "${slug}".`);
    return;
  }
  save(w);
  // Deliberately does NOT touch the corpus — un-watching stops future polling,
  // it does not throw away research already gathered.
  console.log(`Removed "${slug}" from the watchlist. Corpus files are untouched.`);
}

function cmdToggle(w, argv, paused) {
  const slug = argv[0];
  if (!slug) throw new Error(`${paused ? 'pause' : 'resume'} requires a slug`);
  const ch = w.channels.find((c) => c.slug === slug);
  if (!ch) { console.log(`No watched channel with slug "${slug}".`); return; }
  ch.paused = paused;
  save(w);
  console.log(`${ch.name} is now ${paused ? 'paused' : 'active'}.`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const w = load();

  switch (cmd) {
    case undefined:
    case 'list': return cmdList(w);
    case 'add': return cmdAdd(w, rest);
    case 'remove': return cmdRemove(w, rest);
    case 'pause': return cmdToggle(w, rest, true);
    case 'resume': return cmdToggle(w, rest, false);
    default:
      throw new Error(`Unknown command "${cmd}". Use: list | add | remove | pause | resume`);
  }
}

try {
  main();
} catch (e) {
  console.error(`watchlist failed: ${e.message}`);
  process.exit(1);
}
