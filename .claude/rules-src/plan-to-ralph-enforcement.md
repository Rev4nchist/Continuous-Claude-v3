# Plan-to-Ralph Enforcement

After a plan is approved via ExitPlanMode, direct code edits (Edit/Write on code files) are **blocked** unless Ralph is active.

## How It Works

Two hooks work together:

1. **plan-exit-tracker** (PostToolUse on ExitPlanMode) -- writes a state file marking plan approval
2. **plan-to-ralph-enforcer** (PreToolUse on Edit|Write) -- reads that state and blocks code edits

## Decision Flow

| Condition | Result |
|-----------|--------|
| No plan approved | ALLOW |
| Plan approved + Ralph active | ALLOW |
| Plan approved + config/doc file (.json, .md, .yaml, .env) | ALLOW |
| Plan approved + code file (.ts, .py, .go, etc.) | **DENY** |

## Bypass Methods

- **Use /ralph** -- the intended workflow. Ralph delegates to agents who can edit freely.
- **Delete the state file** -- removes plan-approved state:
  ```bash
  rm $TEMP/claude-plan-approved-*.json
  ```
- **Disable the hook** -- remove plan-to-ralph-enforcer from settings.json

## Allowed File Types (always pass through)

Config/doc files are never blocked: `.json`, `.yaml`, `.yml`, `.md`, `.env`, `.gitignore`, `.ralph/*`, `IMPLEMENTATION_PLAN.md`, `tasks/*.md`

## Fail-Open Design

Both hooks fail open on any error -- if state can't be read, enforcement is skipped. This prevents the hooks from breaking normal workflows.

## Bypass-Permissions ($--dangerously-skip-permissions$) Interaction

**Important:** When bypass-permissions mode is active (also called "skip permissions" or "yolo mode"), Claude Code suppresses the interactive permission dialog that normally appears before `ExitPlanMode` executes. **That dialog is the user-approval gate** — there is no separate hook-enforced approval step in plan mode.

What that means in practice:

| Mode | Behavior on plan exit |
|------|----------------------|
| Normal | Permission dialog blocks until user approves → `ExitPlanMode` fires → state file written → enforcer blocks code edits going forward |
| Bypass | No dialog → `ExitPlanMode` fires immediately → state file written → enforcer blocks code edits going forward |

The post-approval enforcement (this hook denying Edit/Write on `.ts`/`.py`/etc. unless Ralph is active) works correctly in both modes. The thing bypass mode skips is the *human checkpoint* before the plan is "approved" — Claude can effectively self-approve its own plan and proceed.

Workflows that chain through `plan-agent` (`build/`, `refactor/`, `migrate/`) include CHECKPOINT prose telling the orchestrating model to wait for explicit user approval, but those checkpoints are model-side instructions — they also lose enforcement under bypass since they require a user message that never arrives.

**Recommendation:** for plan-mode workflows where the human-approval step matters, run without bypass. The dialog *is* the gate.
