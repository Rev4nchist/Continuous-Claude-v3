#!/usr/bin/env bash
# Tri-model integration test suite — static tier
# PASS/FAIL per check; exit code = number of failures.
REPO="C:/Users/david.hayes/continuous-claude"
ACTIVE="$HOME/.claude"
FAIL=0
check() { # id, description, command
  local id="$1" desc="$2"; shift 2
  if eval "$@" >/dev/null 2>&1; then echo "PASS  $id  $desc"; else echo "FAIL  $id  $desc"; FAIL=$((FAIL+1)); fi
}

# --- Codex edit points (Track 1) ---
CW="$REPO/.claude/agents/codex-worker.md"
check S01 "codex-worker case gate has full 6-model allowlist" \
  "grep -q 'gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5.5|gpt-5.4|gpt-5.4-mini) : ;;' '$CW'"
check S02 "codex-worker constraint #3 prose lists 5.6 family" \
  "grep -q 'Model allowlist = .{gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini}' '$CW'"
check S03 "codex-worker input contract lists 5.6 family" \
  "grep -q 'gpt-5.5 (default) | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna | gpt-5.4 | gpt-5.4-mini' '$CW'"
check S04 "codex-worker documents max/ultra effort caveat" \
  "grep -q 'max.*and .ultra' '$CW' || grep -q 'accepts .max. and .ultra' '$CW'"
check S05 "codex-worker-safety allowlist updated w/ probe evidence" \
  "grep -q 'gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini' '$REPO/.claude/rules-ondemand/codex-worker-safety.md'"
check S06 "codex-worker-safety version drift says 0.144.1 installed" \
  "grep -q 'Installed CLI is .0.144.1' '$REPO/.claude/rules-ondemand/codex-worker-safety.md'"
check S07 "no stale 'Installed CLI is 0.131.0' anywhere in rules" \
  "! grep -rq 'Installed CLI is .0.131.0' '$REPO/.claude/rules/'"
check S08 "codex SKILL flags line lists 5.6 family" \
  "grep -q -- '--model gpt-5.5|gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5.4|gpt-5.4-mini' '$REPO/.claude/skills/codex/SKILL.md'"
check S09 "codex-adversary env-override validation case present" \
  "grep -q 'gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5.5|gpt-5.4|gpt-5.4-mini) : ;;' '$REPO/.claude/agents/codex-adversary.md'"
check S10 "codex-adversarial gpt-5.3-codex drift corrected" \
  "grep -q 'WRONG: every .-codex.-suffixed id probed on this account 400s' '$REPO/.claude/rules-ondemand/codex-adversarial.md'"
check S11 "codex-adversarial header notes 0.144.1 re-verification" \
  "grep -q '0.144.1. + re-verified 2026-07-11' '$REPO/.claude/rules-ondemand/codex-adversarial.md'"

# --- Grok files (Track 2) ---
GW="$REPO/.claude/agents/grok-worker.md"
check S12 "grok-worker model case gate (grok-4.5|grok-composer-2.5-fast)" \
  "grep -q 'grok-4.5|grok-composer-2.5-fast) : ;;' '$GW'"
check S13 "grok-worker identity pin (email fail-closed)" \
  "grep -q 'dkhayes44@gmail.com' '$GW'"
check S14 "grok-worker ask mode uses --tools read-only guard" \
  "grep -q -- '--tools \"read_file,list_dir,grep\"' '$GW'"
check S15 "grok-worker passes --no-subagents" \
  "grep -q -- '--no-subagents' '$GW'"
check S16 "grok-worker sanitizes XAI_API_KEY" \
  "grep -q 'env -u XAI_API_KEY' '$GW'"
check S17 "grok-worker uses out-of-repo worktree (.grok-worktrees)" \
  "grep -q 'grok-worktrees' '$GW'"
check S18 "grok-worker has data-egress gate (secret scan)" \
  "grep -Eqi 'secret[- ]scan' '$GW'"
check S19 "grok-worker never uses rm -rf as a command (negated mentions OK)" \
  "! grep -E '(^|;|&&)\s*rm -rf' '$GW' | grep -vq 'No rm -rf'"
check S20 "grok-adversary GROK_ADVERSARY_MODEL default + validation" \
  "grep -q 'GROK_ADVERSARY_MODEL:-grok-4.5' '$REPO/.claude/agents/grok-adversary.md' && grep -q 'grok-4.5|grok-composer-2.5-fast) : ;;' '$REPO/.claude/agents/grok-adversary.md'"
check S21 "grok-worker-safety says --sandbox is NOT protection" \
  "grep -Eqi 'sandbox.*(decorat|does not|do NOT|no[t]? protect)' '$REPO/.claude/rules-ondemand/grok-worker-safety.md'"
check S22 "grok SKILL has all four modes + model flag" \
  "grep -q 'implement' '$REPO/.claude/skills/grok/SKILL.md' && grep -q 'resume' '$REPO/.claude/skills/grok/SKILL.md' && grep -q 'review' '$REPO/.claude/skills/grok/SKILL.md' && grep -q 'grok-composer-2.5-fast' '$REPO/.claude/skills/grok/SKILL.md'"
check S23 "grok telemetry README exists" \
  "test -s '$REPO/.claude/logs/grok-worker.README.md'"
check S24 "cli-integration-strategy has Grok INTEGRATED row" \
  "grep -q 'Grok (xAI) | INTEGRATED' '$REPO/.claude/skills/cli-integration/SKILL.md'"

# --- Plan-reviewer panel (Track 3) ---
HK="$REPO/.claude/hooks/src/plan-exit-premortem-prompt.ts"
check S25 "hook source offers Codex/Grok/Both/Skip" \
  "grep -q '\"Grok\"' '$HK' && grep -q 'Both -- Codex . Grok in parallel' '$HK' && grep -q 'Skip -- proceed' '$HK'"
check S26 "hook source routes --grok and --reviewers both" \
  "grep -q '/premortem --grok' '$HK' && grep -q '/premortem --reviewers both' '$HK'"
check S27 "hook dist rebuilt with Grok content (repo)" \
  "grep -q 'Grok' '$REPO/.claude/hooks/dist/plan-exit-premortem-prompt.mjs'"
check S28 "hook dist rebuilt with Grok content (active ~/.claude)" \
  "grep -q 'Grok' '$ACTIVE/hooks/dist/plan-exit-premortem-prompt.mjs'"
check S29 "premortem skill documents --grok and --reviewers both" \
  "grep -q -- '--grok' '$REPO/.claude/skills/premortem/SKILL.md' && grep -q -- '--reviewers both' '$REPO/.claude/skills/premortem/SKILL.md'"
check S30 "premortem skill references grok-adversary + grok-lift.jsonl" \
  "grep -q 'grok-adversary' '$REPO/.claude/skills/premortem/SKILL.md' && grep -q 'grok-lift.jsonl' '$REPO/.claude/skills/premortem/SKILL.md'"

# --- Harness-update playbook (Track 4) ---
HU="$REPO/.claude/skills/harness-update/SKILL.md"
check S31 "harness-update skill exists with both registries" \
  "grep -q 'Codex edit points' '$HU' && grep -q 'Grok edit points' '$HU'"
check S32 "harness-update registry lists all 6 codex edit-point files" \
  "grep -q 'codex-worker.md' '$HU' && grep -q 'codex-worker-safety.md' '$HU' && grep -q 'skills/codex/SKILL.md' '$HU' && grep -q 'codex-adversary.md' '$HU' && grep -q 'codex-adversarial.md' '$HU' && grep -q 'cli-integration-strategy.md' '$HU'"
check S33 "harness-update registry lists grok edit-point files" \
  "grep -q 'grok-worker.md' '$HU' && grep -q 'grok-worker-safety.md' '$HU' && grep -q 'skills/grok/SKILL.md' '$HU' && grep -q 'grok-adversary.md' '$HU'"
check S34 "harness-update rule exists w/ evidence table" \
  "grep -q '0.144.1' '$REPO/.claude/rules-ondemand/harness-update.md' && grep -q '0.2.93' '$REPO/.claude/rules-ondemand/harness-update.md'"

# --- Docs / evidence ---
check S35 "codex DESIGN-RESEARCH has v3 section" \
  "grep -q '## 13. v3' '$REPO/docs/codex-integration/DESIGN-RESEARCH.md'"
check S36 "grok DESIGN-RESEARCH exists w/ guard table" \
  "grep -q 'read_file,list_dir,grep' '$REPO/docs/grok-integration/DESIGN-RESEARCH.md'"
check S37 "models_cache 0.131.0 snapshot committed" \
  "test -s '$REPO/docs/codex-integration/snapshots/models_cache.0.131.0.json'"

# --- Sync drift (repo vs active) for touched files ---
for f in agents/grok-worker.md agents/grok-adversary.md agents/codex-worker.md agents/codex-adversary.md rules-ondemand/grok-worker-safety.md rules-ondemand/codex-worker-safety.md rules-ondemand/codex-adversarial.md rules-ondemand/harness-update.md skills/grok/SKILL.md skills/codex/SKILL.md skills/harness-update/SKILL.md skills/premortem/SKILL.md hooks/src/plan-exit-premortem-prompt.ts; do
  check "SYNC" "repo==active: $f" "cmp -s '$REPO/.claude/$f' '$ACTIVE/$f'"
done

# --- Telemetry integrity ---
check S38 "grok-worker.jsonl rows are valid JSON with required fields" \
  "test -s '$REPO/.claude/logs/grok-worker.jsonl' && tail -1 '$REPO/.claude/logs/grok-worker.jsonl' | jq -e '.ts and .mode and .model and (.exit_code|type==\"number\") and .session_id'"
check S39 "codex-lift.jsonl last row valid" \
  "tail -1 '$REPO/.claude/logs/codex-lift.jsonl' | jq -e '.ts and .skill'"

# --- Cross-references: skills point at agents that exist ---
check S40 "grok SKILL references grok-worker + grok-adversary (files exist)" \
  "grep -q 'grok-worker' '$REPO/.claude/skills/grok/SKILL.md' && grep -q 'grok-adversary' '$REPO/.claude/skills/grok/SKILL.md' && test -f '$REPO/.claude/agents/grok-worker.md' && test -f '$REPO/.claude/agents/grok-adversary.md'"

echo "----"
echo "FAILURES: $FAIL"
exit $FAIL
