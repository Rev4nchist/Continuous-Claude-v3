---
name: youtube-research
description: Turn YouTube channels and videos into organized, citation-backed research. Ingests transcripts into a local corpus, then synthesizes cited briefs (what the field says, verdict per idea) or lab specs (hypothesis, method, kill criteria). Use when the user says "/yt", "/youtube", points at a channel or video for research, asks to deep-dive, digest, or synthesize video content, wants to watch a channel for new uploads, or asks what a creator has said about a topic across their videos. Triggers on "youtube research", "deep dive this channel", "digest these videos", "what does X say about Y", "watch this channel", "yt dig", "yt lab", "spin up a lab from".
---

# YouTube Research Pipeline

Turns YouTube — a firehose of practical experiments and research — into an organized,
**verifiable** corpus you can synthesize from.

**Mental model:** the corpus is mechanical, the digest is judgment, and the citation is
the contract. Every non-obvious claim in a digest resolves to a clickable, second-accurate
deep link into a transcript on disk. A digest you cannot spot-check in one click is not a
digest, it is a summary — and summaries are how research corpora fill with confident noise.

---

## 1. Architecture

```
YouTube ──ingest──> corpus on disk ──search──> citations ──dig──> digest
                    (transcripts,              (vid + exact         (brief | lab spec,
                     metadata, chapters)        timestamp)           markdown on disk)
        ▲                                                                │
        └────────── watchlist + scheduled poll ──────────────────────────┘
                    (gathers only, never concludes)
```

Everything is markdown on disk. Synthesis has to grep across transcripts, so the
transcript **is** the index — no embedding store, no daemon, no external service.

---

## 2. Verbs

Scripts live inside the plugin; run them with `node`. `$CLAUDE_PLUGIN_ROOT` is set by
Claude Code when the plugin is active — if it is ever empty, substitute the plugin's
install path.

| Intent | Command |
|---|---|
| Pull a channel / video / playlist | `node "$CLAUDE_PLUGIN_ROOT/scripts/ingest.mjs" "<target>" --limit N` |
| Search the corpus (returns citations) | `node "$CLAUDE_PLUGIN_ROOT/scripts/search.mjs" "<regex>" [--channel SLUG]` |
| What do I have? | `node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs"` |
| Watch a channel | `node "$CLAUDE_PLUGIN_ROOT/scripts/watchlist.mjs" add "@handle" --topic "..."` |
| Check for new uploads | `node "$CLAUDE_PLUGIN_ROOT/scripts/poll.mjs" [--ingest]` |

`<target>` = `@handle` · channel URL · playlist URL · video URL · 11-char video id.

**Ingest is incremental.** Ids already in the corpus are skipped before any network call, so
re-running against a channel is cheap and only fetches genuinely new uploads.

**Where data lands.** The corpus is written to `docs/research/youtube/` **relative to the
current working directory** — so research belongs to the project you are in, not to the
plugin. Override with `YT_CORPUS_ROOT` to point at one shared corpus.

---

## 3. The `dig` method (this is the skill's real work)

When asked to deep-dive a channel or topic, follow these steps in order. Do not skip step 1;
synthesizing from a corpus you have not sized is how a "deep dive" quietly becomes three
videos' worth of vibes.

### Step 1 — Size the ground
Run `status.mjs`. Confirm the relevant channel is present and has transcripts. If the topic
spans videos you have not ingested, **ingest first** — say so, do not silently work with less.

### Step 2 — Retrieve, don't recall
Run `search.mjs` with several *distinct* phrasings of the topic (the creator's vocabulary is
rarely yours). Use `--context 2` to read around a hit before quoting it. Prefer 3–6 targeted
searches over one broad one.

Never quote a transcript from memory. If it is not in a search result you just ran, it does
not go in the digest.

### Step 3 — Read the strongest hits in full
Open the corpus files for the videos that matter (`docs/research/youtube/<slug>/<date>-<id>.md`).
Search finds candidates; it does not tell you what the creator actually argues.

### Step 4 — Synthesize with verdicts
Group findings into ideas. Give each idea a verdict:

| Verdict | Meaning |
|---|---|
| **ADOPT** | Do this. Include an integration sketch — which files/subsystems, what changes. |
| **WATCH** | Real, not yet. Say what would trigger revisiting. |
| **SKIP** | Not worth it, or not for us. Say why — a reasoned skip is a valuable output. |

"This channel is interesting but there is nothing here we should act on" is a legitimate and
useful digest. Do not manufacture ADOPTs.

### Step 5 — Cite everything
Every non-obvious claim carries `[vid:<id> @<M:SS>]` inline **and** appears in the Sources
table with a clickable link. Claims you cannot cite are marked `[Speculation]`.

Avoid: best, optimal, always, never, guaranteed. Prefer: may, could, typically, the demo showed.

**Distinguish demonstrated from asserted.** A creator running code on screen is evidence; the
same creator predicting an industry trend is opinion. Label them differently — this is the
single highest-value thing a digest does, because YouTube blurs them constantly.

**Weight by transcript source.** Each corpus file records `transcript_source: manual|auto`.
ASR (`auto`) mangles technical terms and names. Before quoting an ASR passage verbatim as a
precise claim, sanity-check it — or quote it as paraphrase.

### Step 6 — Write and index
Write the digest to `docs/research/youtube/_digests/<date>-<slug>.md` using a template below.

Then append a row to `docs/research/youtube/_digests/INDEX.md`: date, type, channels, verdict,
headline, citation count, link. The INDEX is append-only and is how a reader finds past work
without re-reading every digest.

---

## 4. Output templates

Both share one frontmatter contract. Keep digests hard-wrapped at ~95 cols — it diffs better.

### Brief — "what does this content mean for us"

```markdown
---
digest_id: 2026-07-25-karpathy-llm-workflows
date: 2026-07-25
type: brief
title: "Karpathy's LLM workflow patterns vs our agent harness"
topic: "practical LLM workflow patterns"
channels: "Andrej Karpathy"
verdict: adopt
videos: 5
citations: 14
corpus_path: docs/research/youtube/andrej-karpathy
---

# <title>

**Scope.** Which videos, what question, what was deliberately out of scope.

## 1. What the source actually demonstrates
Separate demonstrated-on-screen from asserted. Cite both. [vid:ID @12:04]

## 2. Gap vs what we do today
Verify against the repo — read the files, do not trust memory. Cite `file:line`.

## 3. Verdicts
| Idea | Verdict | Rationale | Citation |
|---|---|---|---|
| ... | ADOPT | ... | [vid:ID @8:31] |

## 4. Integration sketch (ADOPTs only)
Which files/subsystems change, in what order, and how you would know it worked.

## 5. Sources
| Video | Uploaded | Track | Key timestamps |
|---|---|---|---|
| [title](https://youtu.be/ID) | 2025-02-27 | auto | [12:04](https://youtu.be/ID?t=724) |
```

### Lab — "turn a finding into a buildable experiment"

```markdown
---
digest_id: 2026-07-25-lab-context-compaction
date: 2026-07-25
type: lab
title: "Lab: does transcript-style compaction beat our current summarizer?"
topic: "context compaction"
channels: "Andrej Karpathy"
verdict: n/a
videos: 2
citations: 6
corpus_path: docs/research/youtube/andrej-karpathy
---

# Lab: <idea>

## Hypothesis
One falsifiable sentence. If you cannot falsify it, it is not a hypothesis.

## Prior art (from the corpus)
What the source demonstrated, and where it stopped. [vid:ID @04:20]

## Method
1. Smallest spike that could disprove the hypothesis
2. What you measure, against what baseline

## Success criteria
Concrete and pre-committed. A number, not "feels better".

## Kill criteria
What result makes you stop. **Write this before running anything.**

## First commit
The single smallest change that starts the experiment.
```

---

## 5. Guardrails

1. **Never fabricate a timestamp.** A wrong citation is worse than no citation — it looks
   verified and is not. Every `[vid:… @…]` must come from a search result or a corpus read.
2. **Never quote the corpus from memory.** Re-run the search.
3. **Polling gathers, it never concludes.** A scheduled poll raises `pendingDigest`; a human or
   an explicit `/yt dig` decides what earns synthesis.
4. **Corpus files are append-only in spirit.** Re-ingest with `--force` only when a transcript
   is genuinely wrong; digests cite into these files by timestamp.
5. **Respect scale.** A bare `@channel` ingest defaults to 25 videos. Ingesting a 1,000-video
   channel is a deliberate act — state the cost before doing it.
6. **Ingesting is a network operation against a third party.** Pulling a large channel is slow
   and rate-limited; say what you are about to fetch before fetching it.

---

## 6. Known limits (state these, do not paper over them)

| Limit | Detail |
|---|---|
| Requires yt-dlp | `yt-dlp` must be on PATH (or set `YTDLP_EXE`). Without it, every ingest fails. |
| No captions | Videos without English captions ingest as metadata-only. `whisper` is **not** bundled, so there is no local fallback transcription. `status.mjs` shows the transcript-vs-video gap. |
| ASR quality | Auto captions mangle technical terms, names, and code. `transcript_source` records which track was used. |
| yt-dlp drift | YouTube breaks extractors regularly. If ingest starts failing, `yt-dlp -U` first, before debugging anything else. |
| Rate limits | Subtitle requests are the throttle. `SUB_LANGS` is pinned to two tracks and requests are spaced; widening it re-introduces the HTTP 429 that an `en.*` glob caused. |
| Search is regex, not semantic | Excellent for known vocabulary, blind to paraphrase. Run several phrasings. Revisit if the corpus passes ~1,000 videos. |

---

## 7. Worked example

```bash
# 1. gather
node "$CLAUDE_PLUGIN_ROOT/scripts/ingest.mjs" "@AndrejKarpathy" --limit 5

# 2. see what landed
node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs"

# 3. retrieve with citations (several phrasings)
node "$CLAUDE_PLUGIN_ROOT/scripts/search.mjs" "context window" --context 1
node "$CLAUDE_PLUGIN_ROOT/scripts/search.mjs" "tokeniz(er|ation)"
node "$CLAUDE_PLUGIN_ROOT/scripts/search.mjs" "hallucinat"

# 4. read the strongest videos in full, then write the digest
#    -> docs/research/youtube/_digests/2026-07-25-karpathy-llm-workflows.md
#    -> append a row to _digests/INDEX.md

# 5. subscribe for future uploads
node "$CLAUDE_PLUGIN_ROOT/scripts/watchlist.mjs" add "@AndrejKarpathy" --topic "LLM engineering"
```
