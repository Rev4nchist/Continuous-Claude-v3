---
date: 2026-07-25
component: youtube-research
component_name: YouTube Research Pipeline
verdict: adopt
headline: The pipeline shipped today is a raw-store, read-whole-file design that burned 2.5M tokens to produce 65k of findings — a 14–83x read amplification that CCv3 already diagnosed and fixed elsewhere (`f1eb429`, distill-before-store); move retrieval to the 240-char chunk that already exists, scope it by the `project_id` column `archival_memory` already has, and the Agentic OS requirement is ~80% served by substrate we already run.
sources: 12
---
# YouTube Research Pipeline — Next-Evolution Proposal (2026-07-25)

> **Iteration note.** This is not a frontier scan of external practice. It is a same-day
> post-mortem of a subsystem built and dogfooded in one session, grounded in measured cost
> from its first real run rather than in literature. That makes its evidence unusually strong
> (every number below is from this machine, today) and its external-validity claims unusually
> weak (n=1 corpus, n=1 dig). Treated accordingly: recommendations that rest on measurement
> are ADOPT; recommendations that rest on inference are WATCH.

## 1. Where CCv3 is today

**Shipped 2026-07-25** on `feature/youtube-research` (3 commits, 98 files):

- `scripts/youtube/ingest.mjs` — yt-dlp → one markdown file per video, incremental by video id.
- `scripts/youtube/lib/vtt.mjs` — rolling-ASR dedup. Measured: removes **66.7%** of raw words
  on a real 13,632-line transcript (36,445 → 12,151).
- `scripts/youtube/search.mjs` — regex sweep returning citations (video id + second + deep link).
- `scripts/youtube/publish.mjs` — upserts digests into the Notion `YouTube Research` DB.
- `.claude/skills/youtube-research/SKILL.md` — the `dig` method and output templates.
- Corpus today: **72 videos, 2 channels, 408,768 words, 9,327 transcript chunks.**

**First real run** (Workflow `wf_08dc3a65-234`, 11 agents, 5 research dimensions + 5 citation
auditors + 1 synthesis over the 67-video Jake Van Clief corpus):

| Metric | Value |
|---|---|
| Subagent tokens consumed | **2,506,699** |
| Findings produced | ~65,000 chars across 11 agent returns (journal.jsonl) |
| Tool calls | 185 |
| Wall clock | 25.8 min |
| Citations surviving mechanical audit | 30/30 (0 rejected; 5 additionally hand-checked) |

Output quality was good — the audit caught nothing because the finders were disciplined, and
five hand-spot-checks confirmed verbatim quotes at exact timestamps. **The problem is not
quality. It is cost.**

## 2. Measurement (what the run actually spent money on)

Corpus geometry, measured across all 72 files:

| Unit | Size | Est. tokens |
|---|---|---|
| One transcript chunk (the `[M:SS]` line) | 240 chars avg | **~60** |
| Median video file | ~17,296 chars | **~4,300** |
| p90 video file | ~57,731 chars | ~14,400 |
| Largest video file | 101,766 chars | **~25,000** |
| A ±2-chunk window around a hit | ~1,200 chars | **~300** |
| Whole corpus, raw | 1.63 MB (Van Clief) | ~408,000 |

The `dig` method in `SKILL.md` step 3 instructs: *"Read the 2-4 most relevant transcript files
IN FULL."* With a median file at ~4,300 tokens and the largest at ~25,000, five parallel
finders each reading 2–4 files accounts for the bulk of 2.5M tokens.

**Read amplification is 14x at the median and 83x at the worst case** — the ratio of a
whole-file read to the ±2-chunk window that actually contains the cited claim.

Corroborating shape: 2.5M tokens in, ~65k chars out. The system is overwhelmingly a *reader*,
not a *writer*, and it reads at the wrong granularity.

## 3. Gap analysis

**The lesson was already learned in this repo and not applied.** Commit `f1eb429`
(2026-07-09 R1–R3) shipped **LLM distill-before-store** for the learning loop, replacing raw
verbatim capture of thinking blocks with a distilled artifact. `opc/scripts/core/distill_learning.py`
is live. The YouTube corpus stores raw ASR and re-derives meaning on every read — the identical
pathology, shipped 16 days later.

**The substrate for the fix is already running.** Verified against the live database:

```
archival_memory: id, session_id, agent_id, content, metadata jsonb,
                 embedding vector(1024), created_at, project_id, scope,
                 valid_from, valid_until
```

`project_id` already exists. `embedding vector(1024)` already exists. `embedding_daemon.py`,
`recall_learnings.py` (hybrid RRF), and `distill_learning.py` are all present. The "drop a
YouTube link into a project and pull it during a session" requirement is not a new system —
it is a new *row type* in a system we already operate.

**Access-pattern mismatch.** The shipped design optimizes for **batch digest production**
(gather → synthesize → publish an artifact). The stated Agentic OS need is **session-time
retrieval** (project-scoped context injected while working). The former is served well; the
latter is not served at all. `search.mjs` returns a filename and lets the caller read
everything — which is precisely the amplification above.

**Unmeasured quality risk.** All 62 transcribed Van Clief videos are `transcript_source: auto`.
ASR mangles technical terms — the exact tokens a technical claim rests on. The SKILL flags this
as a caveat and the digest repeats it, but nobody has quantified the error rate. 5 of 72 videos
have no captions at all and are metadata-only.

**Undifferentiated signal density.** A 92-minute loosely-structured livestream ("Afternoon Tea")
and a 13-minute technical explainer are weighted identically by retrieval. Van Clief's corpus is
~40% long-form conversation by duration.

## 4. Recommendations

### P0 — ADOPT: return chunk windows, not file paths

`search.mjs` and the SKILL's `dig` method should hand back the ±N chunks around each hit
(default N=2, `--window` to widen), not a filename plus an instruction to read it. The chunks
already exist and are already parsed; only the return shape changes.

- Expected: **~300 tokens per hit instead of 4,300–25,000.**
- Honest bound: real-world savings will be **5–10x, not 83x** — some questions genuinely need
  three windows, and occasionally a full read is correct. `--full` stays available.

### P0 — ADOPT: project scoping

`ingest.mjs --project <id>`; `project_id` recorded in video frontmatter and in the channel
state file; `search.mjs --project <id>`. Mirrors the column `archival_memory` already carries.
Prerequisite for everything the Agentic OS needs, and costs nothing to add now.

### P1 — ADOPT: distill once at ingest

One LLM pass per video at ingest → a structured **video card** (~400 tokens): thesis, claims
with timestamps, entities, topics, and the demonstrated-vs-asserted split the `dig` method
currently re-derives by hand every single time.

- **72 cards ≈ 29k tokens to survey the entire corpus, versus ~408k to read it raw.**
- Progressive disclosure, the same Tier-1/Tier-2 shape `fourthos-weekly` already uses: read
  cards first, drill to chunks only where a card looks relevant.
- Reuses `distill_learning.py`'s batched-headless-call pattern, including its secret-egress guard.

### P1 — ADOPT: embeddings over chunks, hybrid with regex

A `youtube_chunks` table (video_id, channel_slug, project_id, start_seconds, text, embedding,
metadata) fed by the existing BGE daemon, queried with the hybrid-RRF pattern already
implemented in `recall_learnings.py`. Regex stays as the exact-match arm; RRF over both.

Motivation is measured indirectly: each of the 5 finders was instructed to run 4–8 distinct
phrasings *because* regex cannot see paraphrase. Recall was never measured, which is itself
the finding — we do not know what those 5 agents missed.

### P2 — ADOPT: session-time retrieval surface

A query module (`lib/retrieve.mjs`) the Agentic OS imports, plus a context-injection hook
structurally identical to `memory-awareness.ts`. The dashboard owns HTTP; we own the query.

### P3 — WATCH: ASR quality measurement

Hand-score ~50 chunks containing technical terms against the audio before deciding whether a
correction pass is warranted. Cheap to do, and it gates a much more expensive decision.

### P3 — WATCH: signal-density weighting

Down-weight long-form conversational content in ranking. Plausible, unmeasured, and easy to get
wrong — a 92-minute conversation contained the single most load-bearing citation in the Van
Clief digest (the self-disclaimer at `[28:50]`). **Do not implement on intuition.**

### SKIP: whisper transcription for caption-less videos

5 of 72 videos (7%), all short and low-signal (a channel trailer, a VEO 3 clip, "Miami, No
Vices"). Standing up local transcription to recover them is not justified by the observed rate.
Revisit if a caption-less video ever blocks a real question.

### SKIP: a separate vector store

pgvector is running, the daemon is warm, and `recall_learnings.py` already implements the
retrieval pattern. A second store would duplicate the freshness, migration, and ops surface for
no capability gain.

## 5. Integration approach

**Phase 1 (P0s) — no schema change, no LLM cost, no new dependency.**
1. `lib/corpus.mjs` — `searchCorpus()` gains `window` and returns surrounding chunks.
2. `search.mjs` — render windows; `--window N`, `--full` escape hatch.
3. `ingest.mjs` / `watchlist.mjs` — `--project <id>`, persisted to frontmatter + `_channel.json`.
4. `search.mjs` / `status.mjs` — `--project` filter.
5. `SKILL.md` — `dig` step 3 changes from "read files in full" to "widen the window; read in full
   only when the window is genuinely insufficient."
6. Tests for windowing and project filtering.

**Phase 2 (P1s) — schema + LLM, gated on Phase 1 landing.**
7. `youtube_chunks` table + backfill from the existing markdown corpus (idempotent).
8. Embed on ingest via the resident daemon; hybrid RRF retrieval.
9. Distill-at-ingest → video cards; `dig` reads cards before chunks.

**Phase 3 (P2) — Agentic OS surface.** Query module + injection hook, once the dashboard exists
to consume it.

The markdown corpus remains canonical for **citation and archival** in all phases — Postgres is
an index over it, never a replacement. A digest cites into files; if the DB is lost, citations
still resolve.

## 6. Benefits

- **Phase 1:** an estimated 5–10x reduction in dig cost, from measured read amplification. The
  2.5M-token run becomes roughly 250–500k with no quality loss, because the cited claim lives in
  the window either way.
- **Phase 2:** corpus survey drops from ~408k tokens to ~29k. Paraphrase-blind retrieval becomes
  semantic. Both reuse running infrastructure.
- **Phase 3:** the Agentic OS gets project-scoped video context without a bespoke backend.

## 7. Open questions

1. **Window size.** N=2 (~300 tokens) is a guess from chunk geometry, not a measurement. Worth
   an A/B on the same 5 dimensions once Phase 1 lands — we have a perfect baseline run to
   compare against (`wf_08dc3a65-234`).
2. **Card staleness.** A distilled card reflects one model's reading. Re-distilling 72 videos on
   every prompt change is expensive; versioning cards by prompt hash is the obvious answer but
   adds machinery.
3. **Corpus growth in git.** 2.6 MB today against an 86 MB `.git`. At ~1,000 videos it is ~30 MB.
   The commit message says revisit at ~50 MB; no mechanism enforces that.
4. **Does `project_id` belong on the chunk or on the video?** A video can legitimately serve two
   projects. Many-to-many is more correct and more machinery; start with a single id and see if
   it actually binds.
