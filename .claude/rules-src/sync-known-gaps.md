---
paths:
  - ".claude/rules-src/**"
  - ".claude/rules-ondemand/**"
  - ".claude/hooks/**"
  - ".claude/skills/**"
  - ".claude/agents/**"
  - ".claude/templates/**"
  - ".claude/settings.json"
  - ".claude/settings.json.template"
  - ".claude/project-registry.json"
  - "scripts/sync-to-active.sh"
  - "scripts/sync-claude.sh"
---

# Sync Known Gaps

What auto-syncs (and what does not) between `continuous-claude/` (repo) and `~/.claude/` (active).

| Item | Auto-Syncs? | Why | Manual Command |
|------|-------------|-----|----------------|
| `hooks/src/*.ts` | **No (intentional)** | `sync-to-active.sh` explicitly EXCLUDES `hooks/src` — `dist/*.mjs` is what runs, and copying src stomps mtimes / breaks hook-dist-freshness. Source stays repo-only. | N/A (edit src in repo, rebuild → dist syncs) |
| `hooks/dist/*.mjs` | Yes | Sync script (the compiled artifact that actually runs) | `bash scripts/sync-to-active.sh` |
| `rules/*.md` | Yes | Post-commit hook copies | N/A |
| `skills/*/` | Yes | Post-commit hook copies | N/A |
| `agents/*.md` + `*.json` | Yes | Forward sync copies both. The `.json` sidecar is regenerated from the `.md` frontmatter first (`sync-agent-json.py`). | N/A |
| `docs/**/*.md` | Yes (NEW) | Added to SYNC_DIRS | `bash scripts/sync-to-active.sh` |
| `project-registry.json` | Yes (2026-07-15) | Repo copy is canonical; JSON-validated copy in BOTH full and `--changed` modes; active mirror never auto-deleted | `bash scripts/sync-to-active.sh` |
| `plugins/claude-hud/` (`launcher.mjs`, `config.json`) | Yes (2026-10-01) | The status line runs `launcher.mjs`. Only this subdir syncs; the rest of `plugins/` is Claude Code state. `--changed` deletes a file only when the repo deleted it. Edit `config.json` in the repo: a `/claude-hud:configure` edit is quarantined at the next repo change to it | `bash scripts/sync-to-active.sh` |
| `plugins/ccv3-mods/` (the Agentic OS mod) | Yes (2026-10-07) | `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` names the active copy. The engine writes `.claude-plugin/types/` itself on an interactive load, so the sync never copies, counts or deletes it. `--changed` deletes a file only when the repo deleted it | `bash scripts/sync-to-active.sh` |
| `settings.json` | NO | Intentional — local config | Manual copy (risky) |
| `settings.local.json` | NO | Intentional — machine-specific | Never sync |
| `CLAUDE.md` | Yes (2026-10-03) | Installed from `.claude/templates/CLAUDE.md.template` through the clobber guard; a deleted template never deletes it | `bash scripts/sync-to-active.sh` |
| `RULES.md` | Yes (2026-10-03) | Installed from `.claude/templates/RULES.md.template`, same as `CLAUDE.md` | `bash scripts/sync-to-active.sh` |
| `knowledge-tree.json` | NO | Generated per-project | `knowledge_tree.py --project` |
| `extraction-state.json` | NO | Runtime state | N/A (auto-managed) |

## Notes

- Forward sync runs from `main` only: in the primary checkout, or in a temp detached worktree at main's commit (`land-pr.ps1` sets `SYNC_MAIN_DETACHED=1`). A commit on a feature branch or in another worktree prints `Sync skipped`.
- The enhanced sync script (Task 2.0) closed the `dist/` and `scripts/ralph/` gaps
- `settings.json` remains intentionally local because hook registrations may differ between machines
- Use `/sync-drift` skill to detect unexpected drift
- Manual sync: `bash ~/continuous-claude/scripts/sync-to-active.sh`

## settings.json reconciliation (2026-08-31, harness-security lane)

The repo `.claude/settings.json` + `.claude/settings.json.template` are kept registration-complete
by `node scripts/settings/capture-active-registrations.mjs` (idempotent; run it after registering a
hook only in the active file). Two classes of divergence are EXPECTED and never captured:

**Machine-local top-level keys** (active-only, UI/prefs — do not add to repo or template):
`agentPushNotifEnabled`, `autoCompactEnabled`, `extraKnownMarketplaces`, `model`, `modelSettings`,
`remoteControlAtStartup`, `skipAutoPermissionPrompt`, `skipWorkflowUsageWarning`,
`switchModelsOnFlag`, `theme`, `tui`, `voiceEnabled`. The two `skillListing*` keys are NOT local:
they decide which skills the router sees, so they live in the template (P24).
Exception: the `modelSettings` entries for `claude-sonnet-5` and `claude-sonnet-5-5`
(`effortLevel: high`) are policy, not preference, and live in the template (Dave, 2026-09-30:
Sonnet always runs at high). Other `modelSettings` entries stay machine-local.
Exception: a GitHub-sourced `extraKnownMarketplaces` entry that backs a plugin in the template's
`enabledPlugins` lives in the template (`typesafe-ai`, `claude-hud`, 2026-10-01). Without it a new
machine cannot resolve the plugin. A `directory` marketplace (a local path) stays machine-local.
`enabledPlugins` does not download a plugin: the wizard runs `install_enabled_plugins()`
(`opc/scripts/setup/claude_integration.py`) after it writes `settings.json`.

**Machine-local hook registrations** (active-only by design; the capture script hard-excludes them):
- `permission-auto-allow.mjs` (PermissionRequest) — **SECURITY**: a permission-bypass policy. Must be
  opted into per machine, never inherited from the template by a fresh install.
- `linear-branch-context.mjs`, `sentry-deploy-release.mjs`, `vercel-deploy-context.mjs`,
  `sentry-error-context.mjs` — vendor integrations tied to this machine's accounts.

## Clobber guard + quarantine (2026-08-31, narrowed 2026-09-30)

`sync-to-active.sh` keeps a manifest (`~/.claude/state/sync-manifest.txt`) of the sha256 each
destination had when the sync last wrote it. The guard compares the destination with the incoming
source first, then with the manifest. Per file:

- Destination equals the source: nothing to copy, nothing to quarantine. A hand copy of the repo
  file lands here. The manifest entry is refreshed to the destination hash, so the next repo change
  does not quarantine it. Before 2026-09-30 the stale entry did, and 26 identical files were
  quarantined.
- Destination differs from the source only in line endings (CRLF vs LF, text files only): not an
  edit. The repo bytes are copied, nothing is quarantined. The EOL normalisation is for the
  comparison only. A text file with a real change plus CRLF is still an edit.
- Destination equals the manifest entry: active is merely stale. Normal forward copy.
- Anything else (differs from the source AND from the manifest, or has no manifest entry): the
  destination is a real edit. It is preserved to `~/.claude/.sync-quarantine/<ts>/` before the repo
  copy lands, and reported loudly.

The quarantine dir is the only copy of a clobbered edit. It is NEVER auto-purged. Diff the quarantine
against the repo before you delete it (`diff -r ~/.claude/.sync-quarantine/<ts> ~/continuous-claude/.claude`,
mind the `rules-src` to `rules` name change). Salvage real edits into the repo on a branch. The
script refuses to run under WSL.
