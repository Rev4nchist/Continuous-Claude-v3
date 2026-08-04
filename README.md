# youtube-research

A Claude Code plugin that turns YouTube channels into a **citation-backed research corpus**
on disk, then helps you synthesize cited briefs and lab specs from it.

The point: every non-obvious claim in a digest resolves to a clickable, second-accurate deep
link into a transcript you have locally. A digest you cannot spot-check in one click is a
summary, and summaries are how research corpora fill with confident noise.

---

## What it does

```
YouTube ──ingest──> corpus on disk ──search──> citations ──dig──> digest
                    (transcripts,              (vid + exact         (brief | lab spec,
                     metadata, chapters)        timestamp)           markdown on disk)
```

Two halves:

- **Machinery** (`skills/youtube-research/scripts/`) — deterministic Node scripts. Zero LLM
  calls, so polling is cheap, offline-safe, and cannot hallucinate. They live *inside* the
  skill directory so that hosts which mount only skill directories (e.g. Claude web) still
  receive them.
- **Judgment** (`skills/youtube-research/SKILL.md`) — the `dig` method Claude follows to turn a
  corpus into a digest with verdicts and citations.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | ESM, `node:test`. No npm dependencies at all. |
| **yt-dlp on PATH** | Does the actual fetching. `winget install yt-dlp` / `brew install yt-dlp` / `pipx install yt-dlp`. Override the binary with `YTDLP_EXE`. |

There is no API key, no account, and no external service. Nothing leaves your machine except
the yt-dlp requests to YouTube.

---

## Install

```bash
git clone <this-repo-url> claude-youtube-research
```

Then load it in Claude Code:

```bash
claude --plugin-dir /path/to/claude-youtube-research
```

To install permanently, add it to your plugin config or copy the directory into your plugins
folder. Verify it loaded by asking Claude something that hits the trigger phrases, e.g.
*"deep dive this channel: @AndrejKarpathy"*.

---

## Quick start

Run these from **the project you want the research to live in** — the corpus is written
relative to your current directory.

```bash
YTR="/path/to/claude-youtube-research/skills/youtube-research"
node "$YTR/scripts/ingest.mjs" "@AndrejKarpathy" --limit 5
node "$YTR/scripts/status.mjs"
node "$YTR/scripts/search.mjs" "context window" --context 1
node "$YTR/scripts/watchlist.mjs" add "@AndrejKarpathy" --topic "LLM engineering"
node "$YTR/scripts/poll.mjs" --ingest
```

In Claude Code you normally do not type these — you say *"deep dive @channel on <topic>"* and
the skill drives them.

---

## Where files land

| Path | What |
|---|---|
| `docs/research/youtube/<channel>/<date>-<id>.md` | one markdown file per video: frontmatter + timestamped transcript |
| `docs/research/youtube/<channel>/_channel.json` | ingest state for that channel |
| `docs/research/youtube/_digests/<date>-<slug>.md` | finished briefs and lab specs |
| `docs/research/youtube/_digests/INDEX.md` | append-only index of digests |
| `docs/research/youtube/_state/watchlist.json` | watched channels (machine data) |
| `docs/research/youtube/_state/logs/poll-<date>.log` | poll run logs |

All paths are **relative to the current working directory**, so research belongs to the project
you are in — not to the plugin's install directory.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `YT_CORPUS_ROOT` | `<cwd>/docs/research/youtube` | Point every command at one shared corpus |
| `YT_STATE_ROOT` | `<corpus>/_state` | Keep watchlist/logs out of the project tree |
| `YTDLP_EXE` | `yt-dlp` | Pinned or non-PATH yt-dlp build |
| `YT_SUB_LANGS` | `en,en-orig` | Subtitle tracks to request (see the 429 note below) |
| `YT_CHUNK_CHARS` | `220` | Transcript chunk size before a new `[MM:SS]` stamp |
| `YTDLP_TIMEOUT_MS` | `900000` | Hard ceiling per yt-dlp invocation |

---

## Scheduling a poll

Polling **gathers only** — it raises a `pendingDigest` count and stops. Deciding what earns
synthesis stays with you. Set it up with your OS scheduler, running from your project dir:

**Windows (Task Scheduler)**

```
schtasks /create /tn "YouTube-Poll" ^
  /tr "cmd /c cd /d C:\path\to\your-project && node C:\path\to\claude-youtube-research\skills\youtube-research\scripts\poll.mjs --ingest" ^
  /sc daily /st 07:00 /f
```

**macOS / Linux (cron)**

```
0 7 * * * cd /path/to/your-project && node /path/to/claude-youtube-research/skills/youtube-research/scripts/poll.mjs --ingest
```

`poll.mjs` exits 0 for both "nothing new" and "found N new" — read the `--json` output to tell
them apart, never the exit code alone. It exits non-zero only when *every* watched channel
failed, so one dead channel does not mark the whole run red.

---

## Tests

```bash
node --test --test-reporter=spec "skills/youtube-research/scripts/test/*.test.mjs"
```

Quote the glob. A bare directory arg (`.../scripts/test/`) is resolved as a *module* on some
Node/Windows builds and fails with `MODULE_NOT_FOUND`, which reports as a failing suite rather
than a usage error — easy to misread as broken tests.

---

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

**Polling never synthesizes.** An unattended job that both gathers *and* concludes is how a
corpus fills with confident noise.

---

## Known limits

- **No captions → no transcript.** `whisper` is not bundled; there is no local fallback
  transcription. Such videos ingest as metadata-only and show in the `status.mjs` gap.
- **ASR quality.** Auto captions mangle technical terms and names. `transcript_source` records
  `manual` vs `auto` per video so digests can weight accordingly.
- **yt-dlp drift.** YouTube breaks extractors regularly; `yt-dlp -U` is the first debugging step.
- **Regex, not semantic search.** Strong on known vocabulary, blind to paraphrase — run several
  phrasings. Revisit if the corpus passes ~1,000 videos.
- **Respect scale and terms.** A bare `@channel` ingest defaults to 25 videos. Pulling a large
  channel is slow, rate-limited, and a deliberate act. Use this on content you are entitled to
  access, and consistent with YouTube's terms.
