# Continuous workflow

## Strict daily boundary

The scheduled continuous run processes exactly these nine playlist IDs and no channels,
individual videos, or other playlists:

1. `PLg5FD0-TFyzP9PZmwFGw2VoADQubtACsi`
2. `PLg5FD0-TFyzOG4GU_pykZhuVJi-aKi-xE`
3. `PLg5FD0-TFyzPfZ1qAkcgqSXvfA7GVDcC8`
4. `PLGB4mkrHM1jc`
5. `PLg5FD0-TFyzPO5n9yD4ZqT91BoHe1FvzJ`
6. `PLg5FD0-TFyzNwmPYCybhpQqcoAoOFu2v1`
7. `PLAt38qX-zDTs`
8. `PLE6eZbTQhX_s`
9. `PLg5FD0-TFyzOvFDwnCKu0SvStm3pz5LLv`

`scripts/youtube/state/continuous-playlists.json` is the reviewed machine-readable boundary.
Do not infer additional registrations from screenshots or playlist recommendations.

## Register

1. Run the dependency doctor.
2. Resolve and enumerate the complete playlist. Do not pass a legacy limit.
3. Register one topic source and any explicit target IDs.
4. Persist the initial immutable snapshot. Do not ingest unrelated channel content.

```powershell
node scripts/youtube/source.mjs add "<playlist-url>" --topic "Agentic AI" --target-id "deck-id"
```

The old `watchlist.mjs` command is a compatibility alias. It lazily migrates version-1
channels into `sources.json` and does not overwrite the user’s old watchlist.

Synchronize the approved set without deleting unrelated registry entries:

```powershell
node scripts/youtube/source.mjs sync-allowlist
```

## Refresh

```powershell
node scripts/youtube/refresh.mjs --allowlist-only
```

`--allowlist-only` validates that all nine sources are present, active, and unique before
selection. It excludes active channels and unrelated playlists. Manual non-daily refreshes may
still use `--topic`, but the scheduled wrapper always synchronizes and uses strict mode.

The orchestrator performs these atomic stages:

1. Enumerate every active source and save an immutable membership/order snapshot.
2. Force metadata/caption staging so source hashes detect revisions; reuse evidence when all
   hashes match.
3. For incomplete videos, acquire bounded media, transcribe with local Whisper, reconcile
   captions, extract visuals, OCR, perceptually deduplicate, and build contact sheets.
4. Split evidence into bounded overlapping windows. Make one read-only model call per window.
5. Validate exact input accounting and structured output. Promote a video only after its
   deterministic audit returns `READY`.
6. Reconcile topic knowledge and master outline.
7. Generate impact packages only if topic coverage is `READY`.
8. Write `refresh-latest.json` and a dated JSONL run log.

The default ceiling is four hours (`YT_REFRESH_CEILING_MS` can lower it for tests). Finished
videos remain promoted; unfinished work remains visible and target updates stay blocked.

Seven approved playlists require authenticated access in the current unauthenticated setup.
Set `YT_COOKIES_FILE` to an exported Netscape-format cookie file. The scheduled wrapper uses
`%USERPROFILE%\.claude\secrets\youtube-cookies.txt`; keep it outside the repository. An expired
or missing file is a blocked/failed run, never partial `Ready`. `YT_COOKIES_FROM_BROWSER` is
available for interactive use only; do not use direct Chrome-cookie access in Task Scheduler
because Chrome may lock its cookie database.

`--collect-only` captures source state and evidence metadata without claiming full analysis.

## Inspect

```powershell
node scripts/youtube/status.mjs --json
node scripts/youtube/audit.mjs "Agentic AI"
node scripts/youtube/outline.mjs "Agentic AI"
node scripts/youtube/outline.mjs <video-id>
node scripts/youtube/search.mjs "evaluation harness" --json
```

Search covers timestamped transcript text, visual OCR, and promoted content units. Open the
underlying evidence record before quoting. Audit results, not prose confidence, determine
whether the result is complete.

## Accepted exclusions

Only accept a gap after the user explicitly names it and supplies a reason:

```powershell
node scripts/youtube/audit.mjs "Agentic AI" --accept "position:12" --reason "Private video; owner accepted exclusion"
node scripts/youtube/topic.mjs "Agentic AI"
```

Removed videos remain historical evidence. Removing a source marks it inactive; it never
deletes snapshots, transcripts, outlines, or topic provenance.
