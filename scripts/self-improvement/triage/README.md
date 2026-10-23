# Self-Improvement Triage Cockpit

An interactive, self-contained HTML page for reviewing and prioritizing the daily
self-improvement research proposals (`docs/self-improvement/proposals/*.md`), then
exporting a machine-readable file Claude Code turns into ROADMAP entries + project plans.

Fills the gap the self-improvement loop had: proposals were written to disk with no
human-reviewable surface (the Reports Hub row showed Artifact = "—"). This is that surface.

## Build

```bash
node scripts/self-improvement/triage/build.mjs            # -> out/triage.html
node scripts/self-improvement/triage/build.mjs --out X    # custom output path
```

Open `out/triage.html` in a browser. It is fully self-contained (inline CSS + JS, no CDN,
no network) and stores your triage state in the browser's `localStorage`, so it survives a
refresh. Re-run `build.mjs` any time to pick up new proposals (your queue is keyed by
proposal id, so it persists across rebuilds).

## Architecture (mirrors `scripts/project-cards`)

- **`build.mjs`** — I/O entry: reads every `proposals/*.md`, parses the 6-key frontmatter
  (`date, component, component_name, verdict, headline, sources`) + the 7 numbered `## N.`
  sections, and calls `assemble()`.
- **`assemble.mjs`** — PURE `assemble(proposals, opts) -> htmlString`. Escapes all proposal
  text (`esc()` from `../../project-cards/lib/util.mjs`) then renders markdown to safe HTML,
  injects the payload via the `/*__EMBEDDED_DATA__*/` placeholder, and resolves `{{TOKEN}}`
  chrome tokens on the template (fails loud on an unknown token). No I/O — unit-testable.
- **`template.html`** — the self-contained page (chrome + all interactivity).
- **`test/assemble.test.mjs`** — `node test/assemble.test.mjs` (determinism, XSS/`</script>`/
  `{{TOKEN}}`/`$&` injection safety, markdown rendering).

## Using the cockpit

- **Backlog** (left): every proposal as a card — click to expand the 7 sections (why/how/
  benefit). Filter by verdict / component / search.
- **＋ Prioritize** moves a card into the **Priority Queue** (right). There, set a bucket
  (**Now / Next / Later / Someday**), reorder (↑/↓), add a note, return to backlog, or drop.
- **✕ Drop** (with reason) removes a proposal you won't pursue.
- **Export JSON** / **Export MD** download the triage decision for Claude Code.
- Keyboard: `↑`/`↓` select, `Enter` expand, `P` prioritize.

## Export schema (the round-trip contract Claude Code consumes)

```json
{
  "generatedAt": "<ISO>",
  "source": "self-improvement-triage",
  "version": 1,
  "basis": { "proposalsGeneratedAt": "<build stamp>", "total": 16 },
  "priorities": [
    {
      "rank": 1,
      "bucket": "now",                 // now | next
      "id": "2026-07-18-skills",
      "component": "skills",
      "component_name": "Skills System",
      "verdict": "adopt",
      "headline": "…",
      "sources": 9,
      "proposalPath": "docs/self-improvement/proposals/2026-07-18-skills.md",
      "note": "<your note>"
    }
  ],
  "deferred": [ { "…": "same shape, bucket = later | someday, rank restarts at 1" } ],
  "dropped":  [ { "id": "…", "reason": "…" } ]
}
```

**How Claude Code uses it:** hand the exported JSON back and ask CC to act on it — for each
`priorities` entry (in `rank` order) it adds a ROADMAP entry and, for `now`, can spin up a
project plan from the referenced proposal; `deferred` become lower-priority ROADMAP items;
`dropped` proposals get marked dropped. Read `proposalPath` for full why/how/benefit detail.

## Part C — WIRED (2026-07-24)

- **Hosting:** `publish.mjs` builds and publishes the cockpit to the `ai-enablement-decks`
  Pages site, unlisted (no decks.json card): a dated immutable folder
  `self-improvement/<YYYY-MM-DD>/` plus a mutable `self-improvement/latest/` alias.
  Live: `https://rev4nchist.github.io/ai-enablement-decks/self-improvement/latest/`
- **Loop regen:** `run-research.ps1` calls `triage/publish.mjs` non-fatally after each
  research run, so the hosted copy always reflects the current proposal set.
- **Registry `artifactUrl` deliberately does NOT point here** — it stays on the per-run
  Notion Self-Improvement child page (immutable per-run contract; premortem
  findings #1/#2, 2026-07-24). The old "feed the cockpit URL into --artifactUrl" idea
  from `we-had-been-working-quirky-planet.md` is superseded.
