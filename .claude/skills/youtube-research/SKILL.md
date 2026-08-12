---
name: youtube-research
description: Turn YouTube channels and videos into organized, citation-backed research that moves projects forward or spins up lab experiments. Ingests transcripts into a local corpus, synthesizes cited briefs (what the field says, verdict per idea) or lab specs (hypothesis, method, kill criteria), and publishes them to the Notion "YouTube Research" database. Use when the user says "/yt", "/youtube", points at a channel or video for research, asks to deep-dive, digest, or synthesize video content, wants to watch a channel for new uploads, or asks what a creator has said about a topic across their videos. Triggers on "youtube research", "deep dive this channel", "digest these videos", "what does X say about Y", "watch this channel", "yt dig", "yt lab", "spin up a lab from".
---

# YouTube Research Pipeline

Turns YouTube — a firehose of practical experiments and research — into an organized,
**verifiable** corpus you can synthesize from, and lands the output where you read it.

**Mental model:** the corpus is mechanical, the digest is judgment, and the citation is
the contract. Every non-obvious claim in a digest resolves to a clickable, second-accurate
deep link into a transcript on disk. A digest you cannot spot-check in one click is not a
digest, it is a summary — and summaries are how research corpora fill with confident noise.

This mirrors the proven `docs/self-improvement/` loop (cited proposal → verdict → INDEX →
ratify) with a different source. Same discipline, same review path.

---

## 1. Architecture

```
YouTube ──ingest──> corpus on disk ──search──> citations ──dig──> digest ──publish──> Notion
                    (transcripts,              (vid + exact         (brief |          (Research DB,
                     metadata, chapters)        timestamp)           lab spec)         what you read)
        ▲                                                                │
        └────────── watchlist + nightly poll ────────────────────────────┘
                    (gathers only, never concludes)
```

**Two stores, two jobs, no sync.**
- **Disk** (`docs/research/youtube/`) — transcripts. Synthesis has to grep across them; Notion
  is a poor corpus store. Canonical for raw material.
- **Notion** (`YouTube Research` DB) — finished digests. Canonical for what you read and triage.

---

## 2. Verbs

| Intent | Command |
|---|---|
| Pull a channel / video / playlist | `node scripts/youtube/ingest.mjs "<target>" --limit N` |
| Search the corpus (returns citations) | `node scripts/youtube/search.mjs "<regex>" [--channel SLUG]` |
| What do I have? | `node scripts/youtube/status.mjs` |
| Watch a channel | `node scripts/youtube/watchlist.mjs add "@handle" --topic "..."` |
| Check for new uploads | `node scripts/youtube/poll.mjs [--ingest]` |
| Publish a digest | `node scripts/youtube/publish.mjs <digest.md>` |
| One-time Notion setup | `node scripts/youtube/setup-notion.mjs --confirm` |

`<target>` = `@handle` · channel URL · playlist URL · video URL · 11-char video id.

**Ingest is incremental.** Ids already in the corpus are skipped before any network call, so
re-running against a channel is cheap and only fetches genuinely new uploads.

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
Group findings into ideas. Give each idea a verdict, exactly as the self-improvement loop does:

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

### Step 6 — Write and publish
Write to `docs/research/youtube/_digests/<date>-<slug>.md` using a template below, then:

```
node scripts/youtube/publish.mjs docs/research/youtube/_digests/<date>-<slug>.md
```

Append a row to `docs/research/youtube/_digests/INDEX.md` (same shape as the
self-improvement INDEX: date, type, channels, verdict, headline, citations, link).

---

## 4. Output templates

Both share one frontmatter contract, which `publish.mjs` validates before any Notion write.

**Markdown that survives the Notion conversion** (verified 2026-07-25 against ntn 0.18.1):
headings, bullets, numbered lists, tables (native Notion tables), links, and `**bold**` all
convert cleanly. Two things do not — avoid them in digests:
- **Multi-line `>` blockquotes** become one quote block *per line*, not one block. Use a bold
  lead-in paragraph instead (the templates below already do).
- **`*emphasis*` nested inside a blockquote** stays literal asterisks.

**Hard-wrapping is handled for you — do not work around it.** ntn emits one Notion paragraph
block *per source line*, so a wrapped paragraph would arrive split mid-sentence (a 3.4k-word
digest produced 85 fragment blocks before the fix). `publish.mjs` now re-joins wrapped prose via
`unwrapProse()` before sending, leaving fenced code, tables, headings, and list structure
untouched. Keep authoring digests hard-wrapped at ~95 cols — it diffs better, and only the
Notion copy is unwrapped. Inspect exactly what will ship with `--print-body`.

The page body is written once, at creation. `publish.mjs` re-publish updates row properties
only — Notion has no atomic body-replace, and silently clobbering a page you may have annotated
is exactly the write the safety rules forbid. To genuinely change a published body, delete the
page in Notion and re-publish.

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
3. **Do not publish to Notion without being asked**, unless the user's request obviously
   implies it ("digest and publish", "put it in Notion"). Writing to a shared Notion surface
   follows `.claude/rules/notion-cli-safety.md`.
4. **The `YouTube Research` DB is job-owned** — pipelines upsert rows, humans read views. Do
   not hand-edit rows in Notion and expect them to survive a re-publish.
5. **Polling gathers, it never concludes.** The nightly job raises `pendingDigest`; a human or
   an explicit `/yt dig` decides what earns synthesis.
6. **Corpus files are append-only in spirit.** Re-ingest with `--force` only when a transcript
   is genuinely wrong; digests cite into these files by timestamp.
7. **Respect scale.** A bare `@channel` ingest defaults to 25 videos. Ingesting a 1,000-video
   channel is a deliberate act — state the cost before doing it.

---

## 6. Known limits (state these, do not paper over them)

| Limit | Detail |
|---|---|
| No captions | Videos without English captions ingest as metadata-only. `whisper` is **not** installed, so there is no local fallback transcription today. `status.mjs` shows the transcript-vs-video gap. |
| ASR quality | Auto captions mangle technical terms, names, and code. `transcript_source` records which track was used. |
| yt-dlp drift | YouTube breaks extractors regularly. If ingest starts failing, `yt-dlp -U` first, before debugging anything else. |
| Rate limits | Subtitle requests are the throttle. `SUB_LANGS` is pinned to two tracks and requests are spaced; widening it re-introduces the HTTP 429 that an `en.*` glob caused. |
| Search is regex, not semantic | Excellent for known vocabulary, blind to paraphrase. Run several phrasings. Revisit if the corpus passes ~1,000 videos. |

---

## 7. Worked example

```
# 1. gather
node scripts/youtube/ingest.mjs "@AndrejKarpathy" --limit 5

# 2. see what landed
node scripts/youtube/status.mjs

# 3. retrieve with citations (several phrasings)
node scripts/youtube/search.mjs "context window" --context 1
node scripts/youtube/search.mjs "tokeniz(er|ation)"
node scripts/youtube/search.mjs "hallucinat"

# 4. read the strongest videos in full, then write the digest
#    -> docs/research/youtube/_digests/2026-07-25-karpathy-llm-workflows.md

# 5. publish
node scripts/youtube/publish.mjs docs/research/youtube/_digests/2026-07-25-karpathy-llm-workflows.md

# 6. subscribe for future uploads
node scripts/youtube/watchlist.mjs add "@AndrejKarpathy" --topic "LLM engineering"
```
