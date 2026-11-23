# Verify map: the Agentic OS pages and app

Surface: the app in `apps/agentic-os/` (Next.js, port 3010), the `/os` pane of the `ccv3-mods` plugin (`.claude/plugins/ccv3-mods/`), the phone lane board (`scripts/coordination/render-board.mjs`), the kanban sync (`kanban-sync` skill) and the FleetOps page (`scripts/coordination/fleetops-html.mjs`).
Rule: a page is checked the way Dave opens it. Test web UI changes with `@playwright/mcp` at desktop and phone width, then say only what a headless run cannot cover.

| You changed | Run this | Artifact | Who runs it |
|---|---|---|---|
| App code | `npm run lint`, `npm run typecheck` in `apps/agentic-os` | the command output | by hand (no pre-pr row runs them today) |
| App source parsers (`src/server/sources/**`) | `node node_modules/@playwright/test/cli.js test --config apps/agentic-os/playwright.pure.config.ts --reporter=line` | the line report | pre-pr gate `scrub-invariant` |
| An app page or flow | `npm run dev` in `apps/agentic-os`, then Playwright at desktop and phone width | screenshots and the trace in `.claude/cache/e2e/` | by hand |
| A drizzle migration | `npm run db:check`, then the scratch-database run (see `docs/verify/lane-cli.md`) | the output | gate `lane-context-db` |
| The `/os` pane or any `ccv3-mods` file | `node scripts/mods/validate-mods.mjs` | the summary line | pre-pr gate `mods-validate` (the only place the tests that read `prices.json` run) |
| The phone lane board | `node scripts/coordination/render-board.mjs --project <key>` from the primary checkout; then publish by the Stop-gate steps and read the `<meta name="lane-board">` stamp back | the render line (`masked ... left 0`) and the read-back stamp | `render-board.test.mjs` in `coordination-tests`; the publish by hand |
| The kanban sync | `lane.mjs apply-kanban <file> --dry-run`, then apply | the plan and the `results` | by hand, with Dave's yes for state, band and note changes |
| The FleetOps page | the `fleetops-refresh` skill steps 3 to 9; the read-back check line and the upload hash check | `check: listed 0, stamp yes, embeds 1, h2 2` and `verify-upload: sha ok` | by hand, one refresh an hour |

## What no gate shows

- How the page looks on Dave's phone: record his word in the hub verifications; do not re-test.
- A page published to the wrong url: the stamp must name the board and the returned url must equal the registered one.
