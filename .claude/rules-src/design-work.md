# Design Work

Which design skill to load, and the guard rails for the one that spends money. Fourth brand rules
win over any skill's own taste: for Fourth work, load `fourth-brand-guidelines` first and obey its
hard rules.

## Which skill

| The ask | Skill |
|---|---|
| A distinctive scroll-driven marketing page: cinematic or layered hero, scrollytelling, video that scrubs with scroll, "a site that feels like an experience" | `scroll-craft` |
| A conversion landing page, lead capture or sales page from a brief | `landing-page-builder`, then `landing-page-score` |
| New UI, components or an app screen with strong visual direction | `frontend-design` |
| Polish, critique or harden an existing interface | `impeccable`; accessibility pass: `ui-audit` |
| Palette, font pairing or style reference | `ui-ux-pro-max` |
| Slides or a deck | `fourth-presentation-suite` (Fourth EBR/QBR/sales), `frontend-slides` (other HTML decks) |
| An architecture, sequence or data-flow diagram | `archify` |

Pick one primary skill. Do not stack `scroll-craft` and `landing-page-builder` on the same page.

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
