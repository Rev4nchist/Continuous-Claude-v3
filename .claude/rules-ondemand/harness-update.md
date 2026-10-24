# Harness Update Rule

Governs version/model changes for the Grok harness. Companion skill: `.claude/skills/harness-update/SKILL.md` (the executable playbook). The other cross-model CLI was removed and is not governed here.

## The rule

1. **Any CLI upgrade or new-model enablement MUST go through `/harness-update <harness>`.** No ad-hoc allowlist edits, no "the docs say it's supported."
2. **A live probe on this account is the only way a model id is admitted.** The probe is a positive call that succeeds, a negative call whose fabricated id shows the documented rejection shape, and a read of the ground-truth cache (`~/.grok/models_cache.json`).
3. **Rollback pin before upgrade.** Record the exact old version and its reinstall command in the session handoff before touching the install. `docs/grok-integration/DESIGN-RESEARCH.md` is a dated record and is not edited.
4. **Auth is asserted before and after** every upgrade; a fallback to API-key billing is a STOP, never a workaround.
5. **The edit-point registries in the skill are authoritative.** Adding a new harness or moving a file means updating the registry table in the same change. `/harness-update <harness> --dry-run` must report "consistent" at the end of any harness-touching PR.
6. **Safety-guard probes are part of every re-verification.** The probe that matters here is Grok's `--tools` read-only guard. A guard regression freezes the harness. Roll the CLI back to the pinned pre-upgrade version immediately, and record a dated `GUARD_REGRESSED` note in the session handoff. Do not edit `docs/grok-integration/DESIGN-RESEARCH.md`. Implement and resume stay refused until a new green guard probe is recorded in that handoff. Ask and review may continue only when the regressed guard does not protect them.
7. **Grok auto-updates itself** — a version change may happen without anyone running an upgrade. **This check is ADVISORY today, not mechanically enforced**: workers version-stamp their telemetry, but nothing blocks a write run on an unverified CLI version. On noticing any version drift (telemetry, session output, `--version`), run the playbook reactively before trusting the harness for write work. (Follow-up candidate: a hard preflight gate comparing live `--version` to the verified pin — flagged by grok-adversary 2026-07-11.)

## Evidence trail

Version pins below are informational. `docs/grok-integration/DESIGN-RESEARCH.md` is a dated record from 2026-07-11, not a living source of truth, and this table is not an instruction to edit it.

| Harness | Dated record | Verified as of |
|---|---|---|
| Grok | `docs/grok-integration/DESIGN-RESEARCH.md` (dated record, do not edit) | 0.2.93, 2026-07-11 |
