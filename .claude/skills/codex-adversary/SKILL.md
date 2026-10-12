---
name: codex-adversary
description: Runs an OpenAI Codex (GPT) adversarial review of a diff or a plan and shows a receipt that names the reviewing model. Use when the user types /codex-adversary or /codex-adversarial, or asks for a Codex or cross-model review.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(node *adversary.mjs*)
---

# /codex-adversary

Runs one OpenAI Codex review through the runner and shows its receipt.
The receipt proves which GPT model reviewed. Without it, there is no Codex review.
Rule file: `.claude/rules-ondemand/codex-adversarial.md`.

## Arguments

- A base ref (for example `main`): review `<ref>...HEAD`. Default `main`.
- `--staged`: review the staged diff.
- `--working-tree`: review uncommitted work (staged plus unstaged tracked changes). Untracked files are not reviewed. Line 2 of the output reports the count.
- `--diff-file <abs path>`: review that diff file (passed to the runner as `--diff-file`, in place of `--base`).
- A plan path: review that plan file (`--mode plan`).
- `--focus <text>`: tell Codex where to attack. Write the text to a file and pass `--focus-file <abs>`. Never put free text in the command line.
- `--model <id>` and `--effort <level>`: override the default.

## Steps

1. Plan mode is active: run nothing. Answer `Cross-model pass deferred: plan mode. Exit plan mode, then run /codex-adversary again.`
2. Run the runner yourself, from this session. Do not spawn a subagent.
   Use the Bash tool with `run_in_background: true`:
   `node "$HOME/.claude/scripts/codex/adversary.mjs" run --project <abs dir> --mode code --base <ref> --via skill:codex-adversary`
   Plan review: `--mode plan --plan <abs path>`. Staged diff: `--staged` in place of `--base`. Uncommitted work: `--working-tree` in place of `--base`. Add `--focus-file <abs>` for a focus.
3. Wait for the completion notice. A run takes up to 9 minutes. Never poll in a loop.
4. Read line 1. If it matches the gate regex (see Label rule), take the run id from `run=` and run `node "$HOME/.claude/scripts/codex/adversary.mjs" verify <run-id>`. It spends no quota.
5. Only when verify prints `VERIFY ok` (exit 0): show Dave the receipt line and line 2 first, verbatim. Then show the findings grouped by confidence. Tag each finding `[Codex]`. If the receipt shows `json=0`, Codex answered in prose: show the raw answer and say so.
6. Verify fails: report `Cross-model pass: NO CODEX REVIEW (verify failed: <reason>)`. Show no findings as Codex's. Write no lift row.
7. Any other status: report `NO CODEX REVIEW (<status>)` and the fix below. Never write a review yourself.

| Status | Fix |
|---|---|
| `auth` | Run `codex login`, then retry. |
| `usage_limited` | Wait for the reset, or pass `--model gpt-5.6-luna`. |
| `timeout` | Narrow the diff, or raise `--timeout-s` (max 1800). |
| `bad_model`, `model_rejected` | Run `adversary.mjs models`, then pick a listed id. |
| other | Quote the reason from line 2. Do not retry in a loop. |

## Models

| Use | Model and effort |
|---|---|
| Default | `gpt-6.1-sol @ xhigh` |
| Security, data loss, migrations, final gates | `gpt-6-astra @ high` |
| Re-check loops, small diffs | `gpt-5.6-luna @ high` |
| Fallbacks | `gpt-5.6-sol`, `gpt-5.6-terra` |

`node "$HOME/.claude/scripts/codex/adversary.mjs" models` prints the live list.

## Label rule

A finding is `[Codex]` only when the receipt line matches `^CODEX-RECEIPT v1 status=ok run=\S+ model=gpt-[\w.-]+ `.
Never tag a Claude finding `[Codex]`. Never substitute a Claude reviewer without saying so.
Run `adversary.mjs verify <run-id>` before you tag any finding. No `VERIFY ok` means no `[Codex]` tag.
