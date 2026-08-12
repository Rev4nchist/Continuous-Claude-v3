# YouTube Research Pipeline

Deterministic (zero-LLM) scripts that turn YouTube into a citation-backed research corpus.
The judgment half — synthesizing digests — lives in
[`.claude/skills/youtube-research/SKILL.md`](../../.claude/skills/youtube-research/SKILL.md).

**Split of concerns:** these scripts *gather and retrieve*; the skill *concludes*. Nothing here
calls an LLM, so the nightly job is cheap, offline-safe, and cannot hallucinate.

## Layout

| File | Role |
|---|---|
| `ingest.mjs` | Pull channel/playlist/video → corpus markdown. Incremental. |
| `search.mjs` | Regex sweep → **citations** (video id + timestamp + deep link). |
| `status.mjs` | What is in the corpus, what is watched, what is pending. |
| `watchlist.mjs` | Subscribe/unsubscribe channels (`add` resolves before storing). |
| `poll.mjs` | Check watched channels for new uploads; `--ingest` to pull. Gathers only. |
| `publish.mjs` | Upsert a digest into the Notion `YouTube Research` DB. |
| `setup-notion.mjs` | One-time DB creation. **Confirm-gated.** |
| `lib/config.mjs` | Paths, tunables, citation helpers. Single source of truth. |
| `lib/vtt.mjs` | WebVTT → deduped, timestamped chunks. |
| `lib/ytdlp.mjs` | yt-dlp wrapper (2 processes per ingest, not 2 per video). |
| `lib/corpus.mjs` | Corpus read/write + search. |
| `lib/notion.mjs` | ntn wrapper (imports `NTN_EXE` from project-cards config). |
| `scheduled-youtube-poll.bat` | Task Scheduler wrapper (log capture + artifact verify). |

Corpus lives in `docs/research/youtube/`; digests in `docs/research/youtube/_digests/`.
Operational state (watchlist, logs) stays under `scripts/youtube/` — it is machine data, not
research output.

## Quick start

```bash
node scripts/youtube/ingest.mjs "@AndrejKarpathy" --limit 5
node scripts/youtube/status.mjs
node scripts/youtube/search.mjs "context window" --context 1
node scripts/youtube/watchlist.mjs add "@AndrejKarpathy" --topic "LLM engineering"
node scripts/youtube/poll.mjs --ingest
```

## Tests

```bash
node --test --test-reporter=spec "scripts/youtube/test/*.test.mjs"
```

Quote the glob. A bare directory arg (`scripts/youtube/test/`) is resolved as a *module* on
this Node/Windows build and fails with `MODULE_NOT_FOUND`, which reports as a failing suite
rather than a usage error — easy to misread as a broken test.

## Design decisions worth knowing

**Rolling-caption dedup is load-bearing.** YouTube ASR repeats each cue's trailing lines so
on-screen text scrolls. Measured on a real 13,632-line transcript: **66.7% of raw words were
duplicates** (36,445 → 12,151). Naive concatenation triples token cost *and* makes the model
over-weight repeated sentences. Dedup is deliberately conservative — it compares only against
the immediately preceding cue, because dropping a genuinely repeated phrase turns a real claim
unciteable, which is worse than an occasional survivor.

**`--sub-langs "en.*"` is a trap.** It globs 30+ machine-translated variants and gets HTTP 429'd
partway through (verified 2026-07-25). `SUB_LANGS` is pinned to `en,en-orig` and requests are
spaced by `--sleep-requests`. Widening it re-introduces the 429.

**Ingest is 2 processes, not 2 per video.** One flat-playlist call for the id list, one batched
call for metadata + subtitles. yt-dlp accepts many URLs per invocation.

**Incremental by id, before any network call.** Re-running against a channel costs one list
request and fetches only new uploads.

**Search returns citations, not filenames.** This is the design hinge: a synthesis step quotes
the corpus and every claim is verifiable in one click, by construction rather than by trust.

**Polling never synthesizes.** The nightly job raises `pendingDigest` and stops. An unattended
job that both gathers *and* concludes is how a corpus fills with confident noise.

## Known limits

- **No captions → no transcript.** `whisper` is not installed; there is no local fallback
  transcription. Such videos ingest as metadata-only and show in the `status.mjs` gap.
- **ASR quality.** Auto captions mangle technical terms and names. `transcript_source` records
  `manual` vs `auto` per video so digests can weight accordingly.
- **yt-dlp drift.** YouTube breaks extractors regularly; `yt-dlp -U` is the first debugging step.
- **Regex, not semantic search.** Strong on known vocabulary, blind to paraphrase — run several
  phrasings. Revisit if the corpus passes ~1,000 videos.

## Scheduling

Register the nightly poll (adjust time to taste):

```
schtasks /create /tn "CCv3-YouTube-Poll" /tr "C:\Users\david.hayes\continuous-claude\scripts\youtube\scheduled-youtube-poll.bat" /sc daily /st 07:00 /f
```

Logs land in `%USERPROFILE%\.claude\logs\youtube-poll\<YYYY-MM-DD>.log`. The wrapper verifies
the corpus is readable after the run rather than trusting the exit code alone.
