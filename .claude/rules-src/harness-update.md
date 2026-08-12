# Harness Update Rule

Governs version/model changes for every cross-model harness (Codex, Grok, future). Companion skill: `.claude/skills/harness-update/SKILL.md` (the executable playbook).

## The rule

1. **Any CLI upgrade or new-model enablement MUST go through `/harness-update <harness>`.** No ad-hoc allowlist edits, no "the docs say it's supported."
2. **Live probe on this account is the ONLY admission ticket** for a model id: positive probe (real call succeeds) + negative probe (fabricated id shows the documented rejection shape) + ground-truth cache read (`~/.codex/models_cache.json` / `~/.grok/models_cache.json`).
3. **Rollback pin before upgrade** — exact old version + reinstall command recorded in the harness's DESIGN-RESEARCH doc before touching the install.
4. **Auth is asserted before and after** every upgrade; a fallback to API-key billing is a STOP, never a workaround.
5. **The edit-point registries in the skill are authoritative.** Adding a new harness or moving a file means updating the registry table in the same change. `/harness-update <harness> --dry-run` must report "consistent" at the end of any harness-touching PR.
6. **Safety-guard probes are part of every re-verification** — e.g. Grok's `--tools` read-only guard and Codex's sandbox behavior. A guard regression FREEZES the harness, concretely: (1) roll the CLI back to the pinned pre-upgrade version immediately; (2) add a dated `GUARD_REGRESSED` section to the harness's DESIGN-RESEARCH doc; (3) implement/resume are refused (workers/rules updated to hard-reject) until a new green guard probe is recorded there; ask/review may continue only if the regressed guard doesn't protect them.
7. **Grok auto-updates itself** — a version change may happen without anyone running an upgrade. **This check is ADVISORY today, not mechanically enforced**: workers version-stamp their telemetry, but nothing blocks a write run on an unverified CLI version. On noticing any version drift (telemetry, session output, `--version`), run the playbook reactively before trusting the harness for write work. (Follow-up candidate: a hard preflight gate comparing live `--version` to the verified pin — flagged by grok-adversary 2026-07-11.)

## Evidence trail

Version pins below are informational mirrors — the DESIGN-RESEARCH docs are the source of truth, and this table is a registered edit point in the playbook's registry (updated by every `/harness-update` run).

| Harness | Design doc | Verified as of |
|---|---|---|
| Codex | `docs/codex-integration/DESIGN-RESEARCH.md` (§13 = latest) | 0.144.1, 2026-07-11 |
| Grok | `docs/grok-integration/DESIGN-RESEARCH.md` | 0.2.93, 2026-07-11 |
