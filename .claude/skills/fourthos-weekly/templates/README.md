# FourthOS Sponsor Site — templates

Lock the design once; fill data weekly. Keeps every tier visually consistent and kills per-week drift.

## `shell.html` — the shared chrome

Canonical for **all three tiers**: brand tokens (`:root`), fonts, the custom FourthOS SVG mark, the
sticky **top bar** (breadcrumb + tier tabs + data-driven week-switcher + its JS), and the footer.
The generator builds each page = shell + tier content by substituting placeholders.

| Placeholder | Value (example) |
|---|---|
| `{{TITLE}}` / `{{META_DESC}}` | tab title / description |
| `{{SITE_ROOT}}` | `/ai-enablement-decks` (Pages base, no trailing slash) |
| `{{DECK_BASE}}` | `/ai-enablement-decks/fourthos/2026-06-24` (this week's deck root, no slash) |
| `{{DATE_ISO}}` / `{{DATE_HUMAN}}` | `2026-06-24` / `24 June 2026` |
| `{{TIER}}` | `hub` \| `briefing` \| `deep-dive` (sets `body[data-tier]` → active tab) |
| `{{BREADCRUMB_CURRENT}}` | `Hub` \| `The Briefing` \| `Deep Dive` |
| `{{HEAD_EXTRA}}` | tier-specific `<style>` (merge into the one `<style>` block) |
| `{{CONTENT}}` | tier body markup |

## Hard rules

- **Root-absolute deck links only:** `{{DECK_BASE}}/briefing.html` etc. NEVER bare `briefing.html`
  (trailing-slash fragile on GitHub Pages → resolves to `/fourthos/briefing.html` → 404).
- **Self-contained:** one `<style>`, inline JS, zero external requests except the Google Fonts link.
  The custom mark + architecture diagram are inline SVG.
- **Week-switcher** reads `{{SITE_ROOT}}/decks.json` at runtime (derives root from `location.pathname`,
  filters `section==="sponsor-updates"`, sorts desc) — so older decks list new weeks automatically.
- **Deep-link anchors (must exist, `scroll-margin-top:80px`):** briefing `#sponsor-actions`,
  `#outcomes`, `#risk-radar`; deep-dive `#outputs`, `#concept`. The hub links into these.

## Per-tier content contract

- **hub (`index.html`)** — headline hero (eyebrow date · H1 = `headline` · subhead = `subheadline` ·
  primary CTA → `briefing.html#sponsor-actions`), **Recently shipped** chip row (`shipped[]`),
  two nav cards, **sponsor-lens glance** (Needs you / What moved / Watch). **No RAG/health pill.**
- **briefing (`briefing.html`)** — portfolio cards, `#sponsor-actions`, `#risk-radar`, `#outcomes`;
  tier pager (← Hub · Deep Dive →).
- **deep-dive (`deep-dive.html`)** — `#concept` (Concept Spotlight), inline architecture SVG,
  `#outputs`; tier pager (← The Briefing · Back to Hub →).

The reference rendered implementation is the live deck `ai-enablement-decks/fourthos/2026-06-24/`.
