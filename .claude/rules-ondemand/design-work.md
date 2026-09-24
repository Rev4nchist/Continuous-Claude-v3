# Design Work

Which design skill to load, and the guard rails for the one that spends money. Fourth brand rules
win over any skill's own taste: for Fourth work, load `fourth-brand-guidelines` first and obey its
hard rules.

## Which skill

"Design a frontend" with no other qualifier means `frontend-design`. Everything else routes by the
row that matches:

| The ask | Primary skill | Supporting tools |
|---|---|---|
| New UI, components or an app screen with strong visual direction (the default) | `frontend-design` (plugin) | `ui-ux-pro-max` for palette and type; shadcn MCPs (`shadcn`, `shadcnspace`) for real components; `shadcn-create` for theming |
| A distinctive scroll-driven marketing page: cinematic or layered hero, scrollytelling, video that scrubs with scroll, "a site that feels like an experience" | `scroll-craft` | its `references/fourth.md` for Fourth; kie.ai only with Dave's yes |
| A conversion landing page, lead capture or sales page from a brief | `landing-page-builder` | `landing-page-score` to grade it |
| Polish, critique or harden an existing interface | `impeccable` | `ui-audit`; the `ui-compliance-reviewer` agent |
| A chart, graph, KPI row or dashboard | `dataviz` | none |
| A published claude.ai page (Artifact) | `artifact-design` | `anthropic-skills:web-artifacts-builder` for multi-component React artifacts |
| Slides or a deck | `fourth-presentation-suite` (Fourth EBR/QBR/sales), `frontend-slides` (other HTML decks) | none |
| An architecture, sequence or data-flow diagram | `archify` | `excalidraw-mcp` for an editable canvas |
| React or Next.js performance on the built UI | `react-perf`, `next-best-practices` | the `react-perf-reviewer` agent |

Pick one primary skill. Do not stack `scroll-craft` and `landing-page-builder` on the same page.

**One copy per skill in Claude Code.** `frontend-design` comes from the official plugin;
`scroll-craft`, `frontend-slides` and `fourth-presentation-suite` come from this repo. Their
claude.ai account copies (`anthropic-skills:<name>`) exist for claude.ai on the web and are switched
off here with `skillOverrides`. Never load an `anthropic-skills:` copy of one of these four in Claude
Code. Refresh the web copy from the repo when the repo skill changes.

## Before the first delivery (P06, P07)

- **Plain-language pass** on any deck, explainer or page for someone other than Dave. Name the
  audience. Give only the deliverable's text to a fresh subagent told "you are <audience>". It
  lists every title it cannot follow without opening the item and every term it does not know.
  Fix each one, then deliver. A "no jargon" checklist line alone failed in 3 sessions.
- **From-scratch UI:** in the first reply, name the product it will mirror in one line, so Dave
  can correct it before the build.
- **Team-facing artifact:** before the first publish, name its audience and the account that must
  own it. Say so when that is not the account this session publishes under.

## Verify every web build

Before calling a design done, look at it in a browser. A green build is not a working page.

1. Render and read it: Tier 1 `@playwright/mcp` snapshot, or the `browser-automation` skill for
   console errors and failed requests (`browser-automation.md`; never `claude-in-chrome`).
   Then look at it: a screenshot at desktop width and at phone width (~390px). A snapshot is the
   accessibility tree; it cannot show overlap, clipping, contrast or a broken layout.
2. Accessibility: `ui-audit`, or the `ui-compliance-reviewer` agent for a full pass.
3. User flows that matter: `qa-test`, or the `sentinel` agent for role-based flows.
4. scroll-craft pages add the skill's own `shoot.mjs` contact sheet and the `budget.mjs` gate.
5. State what was not verified, such as a real phone.

## scroll-craft guard rails [C:10]

- **Paid generation is confirm-first.** Every `kie.mjs still` and `kie.mjs shot` spends kie.ai
  credits on a separate account and uploads each `--ref`, head and tail file to kie.ai hosts. Before
  the first batch, state the count of stills and clips, the estimated credits, and which files will
  be uploaded; then wait for Dave's yes. Rerolls after that batch are a new confirmation.
  `kie.mjs probe` is free. A brief written under "creative delegation" never authorizes spend.
  Each paid job is logged to `<workspace>/kie-spend.jsonl`; report the build's total from
  `spend.mjs --build <name>`.
- **Never upload confidential or client assets** (Fourth customer material, unreleased product
  shots) without asking. Treat anything uploaded as public.
- **The API key.** `KIE_AI_API_KEY` comes from the environment. Never write it to a `.env` inside a
  build folder or repo: `kie.mjs` searches up to 7 parent folders for one. Absent key = build from
  supplied photos and footage, which needs no key.
- **Workspace.** `SCROLLCRAFT_HOME` points at `C:\Users\david.hayes\Projects\scrollcraft`. Without it
  the skill writes `<git root>/scrollcraft`, which inside `continuous-claude` puts builds in the
  harness repo. Run `node <skill>/scripts/workspace.mjs` and check the path before any build.
- **Local server.** `serve.mjs` binds `127.0.0.1` and refuses dotfiles (CCv3 patch). State the port
  when you start it and stop it when the task ends; never leave an orphaned `&` server.
- **Windows.** Run `encode.sh` through Git Bash by full path: `bash` on PATH is WSL. ffmpeg must be a
  full build (`doctor.mjs` checks).
- **Verification.** The skill's own `shoot.mjs` harness (playwright-core) is the scroll check, and
  `budget.mjs` (desktop and `--mobile`) gates opening weight, LCP and layout shift. For
  interactive checks use Tier 1 `@playwright/mcp` per `browser-automation.md`; never
  `claude-in-chrome`. Report what a headless run cannot cover: a real phone.
- **Publishing is confirm-first.** Deploying a build or `device-diag.html` anywhere reachable by
  others needs Dave's yes, like any outward-facing action.
