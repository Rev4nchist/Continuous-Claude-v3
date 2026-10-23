#!/usr/bin/env bash
# Grok harness static checks. The other cross-model CLI was removed.
# PASS/FAIL per check; exit code = number of failures.
REPO="$HOME/continuous-claude"
ACTIVE="$HOME/.claude"
FAIL=0
check() { # id, description, command
  local id="$1" desc="$2"; shift 2
  if eval "$@" >/dev/null 2>&1; then echo "PASS  $id  $desc"; else echo "FAIL  $id  $desc"; FAIL=$((FAIL+1)); fi
}

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
check S24 "cli-integration has a Grok INTEGRATED row" \
  "grep -q 'Grok (xAI)' '$REPO/.claude/skills/cli-integration/SKILL.md' && grep -q 'INTEGRATED' '$REPO/.claude/skills/cli-integration/SKILL.md'"

HK="$REPO/.claude/hooks/src/plan-exit-premortem-prompt.ts"
check S25 "hook source offers the Grok harness and Skip" \
  "grep -q '\"Grok\"' '$HK' && grep -q 'Skip -- proceed to implementation' '$HK'"
check S26 "hook source routes --grok" \
  "grep -q '/premortem --grok' '$HK'"
check S27 "hook dist rebuilt with Grok content (repo)" \
  "grep -q 'Grok' '$REPO/.claude/hooks/dist/plan-exit-premortem-prompt.mjs'"
check S29 "premortem skill documents --grok" \
  "grep -q -- '--grok' '$REPO/.claude/skills/premortem/SKILL.md'"
check S30 "premortem skill references grok-adversary + grok-lift.jsonl" \
  "grep -q 'grok-adversary' '$REPO/.claude/skills/premortem/SKILL.md' && grep -q 'grok-lift.jsonl' '$REPO/.claude/skills/premortem/SKILL.md'"

HU="$REPO/.claude/skills/harness-update/SKILL.md"
check S31 "harness-update skill keeps the Grok registry" \
  "grep -q 'Grok edit points' '$HU'" # heading that still ships
check S33 "harness-update registry lists grok edit-point files" \
  "grep -q 'grok-worker.md' '$HU' && grep -q 'grok-worker-safety.md' '$HU' && grep -q 'skills/grok/SKILL.md' '$HU' && grep -q 'grok-adversary.md' '$HU'"
check S34 "harness-update rule keeps the Grok pin" \
  "grep -q '0.2.93' '$REPO/.claude/rules-ondemand/harness-update.md'"
check S36 "dated record DESIGN-RESEARCH still has the guard table" \
  "grep -q 'read_file,list_dir,grep' '$REPO/docs/grok-integration/DESIGN-RESEARCH.md'"

for f in agents/grok-worker.md agents/grok-adversary.md rules-ondemand/grok-worker-safety.md rules-ondemand/harness-update.md skills/grok/SKILL.md skills/harness-update/SKILL.md skills/premortem/SKILL.md hooks/src/plan-exit-premortem-prompt.ts; do # files that still ship
  check "SYNC" "repo==active: $f" "cmp -s '$REPO/.claude/$f' '$ACTIVE/$f'"
done

check S40 "grok SKILL references grok-worker + grok-adversary (files exist)" \
  "grep -q 'grok-worker' '$REPO/.claude/skills/grok/SKILL.md' && grep -q 'grok-adversary' '$REPO/.claude/skills/grok/SKILL.md' && test -f '$REPO/.claude/agents/grok-worker.md' && test -f '$REPO/.claude/agents/grok-adversary.md'"

echo "----"
echo "FAILURES: $FAIL"
exit $FAIL
