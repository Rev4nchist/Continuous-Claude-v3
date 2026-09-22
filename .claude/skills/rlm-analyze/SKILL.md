---
name: rlm-analyze
description: Docker-sandboxed Recursive Language Model analysis of huge repos or documents. Use when the user says "/rlm-analyze", "analyze the whole repo for X", "summarize this huge document", or "find X across all files".
---

# /rlm-analyze -- Recursive analysis of large inputs

## When to use (trigger signals)

Use this skill when the user is asking for deep, multi-hop analysis over a
large input that would not fit comfortably in a standard prompt:

- "Analyze the whole [repo/codebase/directory] for X"
- "Summarize this 500-page document"
- "Find every [feature/safety-check/pattern] across all files"
- "How does [concept] work across the whole project?"
- "Give me an inventory of X in this codebase"
- Explicit: `/rlm-analyze <path> "<question>"`

Below ~300K chars of concatenated input, the skill transparently falls back
to prompt-cached Claude -- same answer path, no RLM overhead. Above that,
the Docker-sandboxed RLM engages: the model writes Python code to slice,
filter, and aggregate the corpus inside a REPL instead of stuffing it into
the prompt.

## When NOT to use

- Single-fact questions over a small file (use the built-in Read tool)
- A corpus that already has a vector index (use /recall or RAG)
- Streaming / sub-second latency required (RLM runs batch-only; 30s-few-min)
- User has no Anthropic API credits or Docker Desktop is not running

## Usage

Invoke with a path (file, directory, or glob) and a quoted question.

Optional flags: `--max-size <bytes>` (default 5MB) and `--budget <usd>`
(default 2.00).

## Examples

```
/rlm-analyze ./src "list every public API endpoint and its auth mechanism"
/rlm-analyze ./docs "summarize every policy change mentioned, cite the file"
/rlm-analyze "**/*.py" "find all places that call the deprecated foo()"
/rlm-analyze README.md "extract each configuration option and its default"
/rlm-analyze . "count functions longer than 50 lines, grouped by file"
```

Path resolution -- all relative to the current working directory when invoked:
- A file -> used as-is
- A directory -> recursive walk; skips `.git`, `node_modules`, `.venv`,
  `__pycache__`, `.next`, `dist`, `build`, `.claude/cache`, common binaries
- A glob -> expanded with `pathlib.glob` against cwd

Each included file is banner-prefixed so the RLM can enumerate files
without scanning the whole corpus: `===== {path} =====`.

## Portability across projects

This skill is a global Claude Code skill (synced into `~/.claude/skills/`)
and works from any project directory. Requirements (one-time per machine,
already satisfied by Continuous Claude setup):

- `CLAUDE_OPC_DIR` env var set to the continuous-claude `opc/` directory
- `ANTHROPIC_API_KEY` in environment or `opc/.env`
- Docker Desktop running (image `continuous-claude/rlm-sandbox:3.11` prebuilt)

If any prerequisite is missing, the CLI surfaces a clear error and exits.

## Safety envelope (hardcoded)

- `sandbox=docker` -- the local REPL backend is refused outright (LLM-written
  Python runs in the sandbox container, never on the host)
- `max_depth=1` -- Wang et al. (arXiv:2603.02615) showed deeper recursion
  degrades output quality
- `max_response_tokens=4096` per iteration -- bounds the cost of any
  pathological generation loop
- `max_budget_usd` default 2.00, user-overridable via `--budget`

## Output contract

Answer streams to stdout. A one-line status footer is emitted on stderr:

```
--- rlm-analyze path: rlm | trajectory: .claude/cache/rlm-logs/<timestamp> ---
```

Where `path` is one of:
- `rlm` -- Docker RLM engaged, produced a FINAL() answer
- `vanilla-threshold` -- input under 300K chars, used prompt-cached Claude
- `vanilla-fallback` -- RLM failed (timeout/budget/exception), vanilla Claude
  produced the answer instead (graceful degradation)

JSONL trajectory of every LLM call and REPL execution lands in
`.claude/cache/rlm-logs/<timestamp>/` for post-hoc inspection.

## Reference

- Architecture (4 Mermaid views + Excalidraw): `docs/architecture/rlm/rlm-architecture.md`
- Adoption plan: `C:/Users/david.hayes/.claude/plans/i-have-a-new-abstract-quail.md`
