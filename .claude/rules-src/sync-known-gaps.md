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
| `agents/*.yml` | Yes | Post-commit hook copies | N/A |
| `docs/**/*.md` | Yes (NEW) | Added to SYNC_DIRS | `bash scripts/sync-to-active.sh` |
| `project-registry.json` | Yes (2026-07-15) | Repo copy is canonical; JSON-validated copy in BOTH full and `--changed` modes; active mirror never auto-deleted | `bash scripts/sync-to-active.sh` |
| `settings.json` | NO | Intentional — local config | Manual copy (risky) |
| `settings.local.json` | NO | Intentional — machine-specific | Never sync |
| `CLAUDE.md` | NO | Intentional — may differ per machine | Manual review |
| `RULES.md` | NO | Intentional — may differ per machine | Manual review |
| `knowledge-tree.json` | NO | Generated per-project | `knowledge_tree.py --project` |
| `extraction-state.json` | NO | Runtime state | N/A (auto-managed) |

## Notes

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

**Machine-local hook registrations** (active-only by design; the capture script hard-excludes them):
- `permission-auto-allow.mjs` (PermissionRequest) — **SECURITY**: a permission-bypass policy. Must be
  opted into per machine, never inherited from the template by a fresh install.
- `linear-branch-context.mjs`, `sentry-deploy-release.mjs`, `vercel-deploy-context.mjs`,
  `sentry-error-context.mjs` — vendor integrations tied to this machine's accounts.

## Clobber guard + quarantine (2026-08-31)

`sync-to-active.sh` keeps a manifest (`~/.claude/state/sync-manifest.txt`) of the sha256 each
destination had when the sync last wrote it. A destination that diverged from the manifest (edited
directly in `~/.claude` since the last sync) is preserved to `~/.claude/.sync-quarantine/<ts>/`
before the repo copy lands, and reported loudly. The quarantine dir is the only copy of a clobbered
edit — review and delete it yourself; it is NEVER auto-purged. The script refuses to run under WSL.
