#!/usr/bin/env node
/**
 * sync-architecture-stats.mjs
 *
 * A thin wrapper (card ccv3-system-map-generator). The system map is now built by
 * scripts/architecture/build-system-map.mjs from the repo sources (hook registrations, skills, agents, rules,
 * the review engine Waves table). This script keeps its old name and flags because the hook
 * .claude/hooks/src/architecture-stats-sync.ts runs it with --apply after a commit that touches hooks, agents, skills or scripts.
 * The generated output holds no time and no commit id, so a run after a commit writes nothing unless a source changed.
 *
 * Usage:
 *   node scripts/sync-architecture-stats.mjs            # dry run (no writes)
 *   node scripts/sync-architecture-stats.mjs --apply    # write architecture.json and the embedded block of index.html
 *   node scripts/sync-architecture-stats.mjs --root <dir> --verbose
 *
 * Exit codes: 0 = ok (or nothing to change), 1 = a problem (bad file, listed id), 2 = a source reads "not checked" (nothing written).
 */
import { main } from './architecture/build-system-map.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--verbose' && a !== '-v');
main(args).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`ERROR: ${e.message}\n`); process.exitCode = 1; });
