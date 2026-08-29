# YouTube Continuous Content Intelligence

This pipeline maintains research topics from complete YouTube playlists. It keeps immutable
playlist history, extracts spoken and visible evidence, validates exhaustive outlines,
reconciles topic knowledge, and generates reviewable presentation/site update packages.

It does not silently downgrade “complete” to captions-only, mutate registered targets during
refresh, or publish anything without an explicit downstream request. See the
[`youtube-research` skill](../../.claude/skills/youtube-research/SKILL.md) for operating rules.

## Strict daily allowlist

The scheduled continuous run is restricted to exactly these nine playlist IDs:

1. `PLg5FD0-TFyzP9PZmwFGw2VoADQubtACsi`
2. `PLg5FD0-TFyzOG4GU_pykZhuVJi-aKi-xE`
3. `PLg5FD0-TFyzPfZ1qAkcgqSXvfA7GVDcC8`
4. `PLGB4mkrHM1jc`
5. `PLg5FD0-TFyzPO5n9yD4ZqT91BoHe1FvzJ`
6. `PLg5FD0-TFyzNwmPYCybhpQqcoAoOFu2v1`
7. `PLAt38qX-zDTs`
8. `PLE6eZbTQhX_s`
9. `PLg5FD0-TFyzOvFDwnCKu0SvStm3pz5LLv`

The source of truth is `state/continuous-playlists.json`. Synchronization preserves unrelated
entries in `state/sources.json`; `--allowlist-only` excludes them from daily processing. Missing,
inactive, or duplicate allowlisted sources fail closed. Screenshots are context only and do not
authorize registration of other playlists.

## Quick start

```powershell
node scripts/youtube/doctor.mjs
node scripts/youtube/source.mjs sync-allowlist
node scripts/youtube/refresh.mjs --allowlist-only
node scripts/youtube/status.mjs
```

`doctor.mjs` must report `ready: true` for video-complete processing. Configure executable
paths with `YTDLP_EXE`, `FFMPEG_EXE`, `TESSERACT_EXE`, and `YT_PYTHON_EXE`. Install
the Python adapter dependencies from `scripts/youtube/python/requirements.txt` in that
environment. `YT_WHISPER_DEVICE`, `YT_WHISPER_COMPUTE_TYPE`, and `YT_WHISPER_MODEL`
override runtime selection. GPU defaults to `large-v3`/FP16; CPU defaults to
`medium.en`/INT8 for English and a multilingual model when translation is required.

For private playlists, set `YT_COOKIES_FILE` to an exported Netscape-format cookie file.
Playlist metadata, captions, and media downloads all use the same auth arguments. The scheduled
wrapper points to `%USERPROFILE%\.claude\secrets\youtube-cookies.txt`; never place that file in
the repository. `YT_COOKIES_FROM_BROWSER` is available for attended interactive runs, but direct
Chrome-cookie access is unsuitable for scheduling because the cookie database may be locked.
Missing or expired authentication produces `Blocked`/`Failed`, not partial `Ready`.

## Commands

| Script | Role |
|---|---|
| `source.mjs` | Synchronize the strict allowlist; register/list/pause sources and capture snapshots. |
| `refresh.mjs` | Four-hour bounded collect → extract → analyze → topic → target pipeline. |
| `doctor.mjs` | Probe all required local media/transcription dependencies. |
| `ingest.mjs` | Stage complete metadata, full descriptions, chapters, captions, and hashes. |
| `extract.mjs` | Download temporary media; Whisper, scene/periodic frames, OCR, dedup, sheets. |
| `analyze.mjs` | Read-only bounded model windows, strict JSON validation, exhaustive outline. |
| `topic.mjs` | Idempotent topic reconciliation, master outline, and coverage gate. |
| `search.mjs` | Search transcript text, visual OCR, and promoted content units. |
| `audit.mjs` | Explain evidence/playlist gaps; record explicit accepted exclusions. |
| `outline.mjs` | Print an exhaustive video or topic outline. |
| `target.mjs` | Register/snapshot/impact/apply-to-local-draft for explicit targets. |
| `status.mjs` | Corpus, source, topic, backlog, and readiness status. |
| `poll.mjs` | Legacy channel/playlist collection alias; snapshots playlists. |
| `watchlist.mjs` | Compatibility alias that lazily migrates to `sources.json`. |
| `publish.mjs` | Legacy explicit Notion brief/lab publication. |

## Storage

Durable research lives under `docs/research/youtube/`:

```text
<channel>/<date>-<id>.md                 full metadata and transcript
<channel>/<date>-<id>.analysis.json      evidence, hashes, audit, structured analysis
<channel>/<date>-<id>.outline.md         exhaustive timestamped outline
<channel>/<date>-<id>.evidence/          selected frames and contact sheets
_playlists/<id>/                         manifest and immutable snapshots
_topics/<topic>/                         knowledge, master outline, coverage
_targets/<id>/profile.json               explicit target registry
_updates/<run>/<id>.{json,md}            review packages and optional local drafts
```

Temporary raw media and intermediate frames live under `scripts/youtube/.cache/` and are
removed after extraction. Removed playlist videos remain in historical snapshots and retain
their research evidence.

## Safety and completeness

- Playlist enumeration has no legacy 25-video cap. Channels retain a deliberate default cap.
- Captions, OCR, descriptions, and shown code are untrusted input. Headless analysis gets
  only `Read`; trusted scripts validate JSON and own writes.
- A video is not `READY` until every speech window, retained visual, evidence ID, content
  citation, and timestamp passes deterministic audit.
- Topic packages are blocked by any unresolved active playlist entry. Private/unavailable
  entries require an explicit accepted exclusion and reason.
- Target apply rejects baseline drift and writes a local draft, not the original.
- External links and comments are recorded but not crawled by this workflow.

## Tests

```powershell
node --test "scripts/youtube/test/*.test.mjs"
```

Tests cover legacy caption behavior plus source migration, complete playlist accounting,
duplicate/private/unavailable entries, transcript identity, exhaustive evidence mapping,
topic idempotence/relationships, target drift, and analysis-window omission rejection.

## Scheduling

`scheduled-youtube-refresh.bat` runs the complete safe pipeline and verifies the durable run
record. It synchronizes the allowlist and always passes `--allowlist-only`. It does not install
itself. Task Scheduler registration is an explicit system action.
The existing `scheduled-youtube-poll.bat` path forwards to the refresh wrapper so an already
registered `CCv3-YouTube-Poll` task uses the upgraded pipeline. Use `poll.mjs` directly for a
collection-only run.

Run statuses are `NoChange`, `Ready`, `Blocked`, `Warn`, or `Failed`. Exit code 2 means a
known blocked/warn state, not fabricated success; inspect `scripts/youtube/logs/refresh-latest.json`.
