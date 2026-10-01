---
name: tldr-code
description: "Token-efficient AST code analysis: call graphs, dead code, complexity, impact. Use when asked to explore, refactor, understand, or find what calls or imports something."
allowed-tools: [Bash]
metadata:
  keywords: [debug, refactor, understand, complexity, "call graph", "data flow", "what calls", "how complex", search, explore, analyze, dead code, architecture, imports]
---

# TLDR-Code

Token-efficient code analysis. Measured, 30 days to 2026-09-30: the Read hook replaced 2.58 MB of raw reads with 0.16 MB of summaries (168 intercepts). Net saving after re-reads: pending T1-T4 (`docs/self-improvement/audits/`). The old "95%" figure was a marketing number, not a measurement.

Advanced features (daemon, semantic search, Python API, language table): `references/advanced-features.md`

> **Canonical entry point.** This is the single skill for TLDR usage. Routine analysis (call graph injection, AST-summarized reads, post-edit diagnostics) is handled automatically by 3 live hooks: `tldr-read-enforcer` (denies code Reads over 8 KB and returns an AST summary; fails open), `smart-search-router`, `post-edit-diagnostics`. `tldr-context-inject`, `impact-refactor`, `arch-context-inject`, `edit-context-inject` and `signature-helper` are not registered; do not expect them to fire. Don't add new `tldr-*` sub-skills; extend this one or extend a hook.

## Quick Reference

| Task | Command |
|------|---------|
| File tree | `tldr tree src/` |
| Code structure | `tldr structure . --lang python` |
| Search code | `tldr search "pattern" .` |
| Call graph | `tldr calls src/` |
| Who calls X? | `tldr impact func_name .` |
| Control flow | `tldr cfg file.py func` |
| Data flow | `tldr dfg file.py func` |
| Program slice | `tldr slice file.py func 42` |
| Dead code | `tldr dead src/` |
| Architecture | `tldr arch src/` |
| Imports | `tldr imports file.py` |
| Who imports X? | `tldr importers module_name .` |
| Affected tests | `tldr change-impact --git` |
| Type check | `tldr diagnostics file.py` |
| Semantic search | `tldr semantic search "auth flow"` |

---

## The 5-Layer Stack

```
Layer 1: AST         ~500 tokens   Function signatures, imports
Layer 2: Call Graph  +440 tokens   What calls what (cross-file)
Layer 3: CFG         +110 tokens   Complexity, branches, loops
Layer 4: DFG         +130 tokens   Variable definitions/uses
Layer 5: PDG         +150 tokens   Dependencies, slicing
───────────────────────────────────────────────────────────────
Total:              ~1,200 tokens  vs 23,000 raw (one sample file; not a measured average)
```

---

## CLI Commands

### Navigation & Search

```bash
tldr tree src/ --ext .py .ts           # File tree, filter by extension
tldr structure . --lang python          # Code structure (codemaps)
tldr search "def process" src/          # Text search
tldr search "TODO" . -C 3              # 3 lines context
tldr semantic search "auth flow"        # Natural language search
```

### File Analysis

```bash
tldr extract src/api.py                           # Full file info
tldr extract src/api.py --function process        # Filter to function
tldr context main --project src/ --depth 3        # LLM context (follows call graph)
```

### Flow Analysis

```bash
tldr cfg src/processor.py process_data   # Control flow: complexity, branches, loops
tldr dfg src/processor.py process_data   # Data flow: variable definitions/uses
tldr slice src/processor.py process_data 42             # What affects line 42
tldr slice src/processor.py process_data 42 --var result # Track specific variable
```

### Codebase Analysis

```bash
tldr calls src/ --lang python           # Cross-file call graph
tldr impact process_data src/ --depth 5 # Who calls this function?
tldr dead src/ --entry main cli test_   # Find unreachable code
tldr arch src/                          # Detect architectural layers
```

### Import Analysis

```bash
tldr imports src/api.py                 # What does this file import?
tldr importers datetime src/            # Who imports this module?
```

### Quality & Testing

```bash
tldr diagnostics src/api.py             # Type check + lint (pyright/ruff)
tldr diagnostics . --project            # Whole project
tldr diagnostics src/ --format text     # Human-readable output
tldr change-impact --git                # Tests affected by git diff
tldr change-impact --git-base main      # Diff against branch
tldr change-impact --run                # Actually run affected tests
```

---

## When to Use TLDR vs Grep

| Task | Use TLDR | Use Grep |
|------|----------|----------|
| Find function definition | `tldr extract file --function X` | - |
| Search code patterns | `tldr search "pattern"` | - |
| String literal search | - | `grep "literal"` |
| Config values | - | `grep "KEY="` |
| Cross-file calls | `tldr calls` | - |
| Reverse deps | `tldr impact func` | - |
| Complexity analysis | `tldr cfg file func` | - |
| Variable tracking | `tldr dfg file func` | - |
| Natural language query | `tldr semantic search` | - |

---

## Bug Fixing Workflow

**Key insight:** TLDR navigates, then you read. Don't fix bugs from summaries alone.

```bash
# 1. NAVIGATE: Find which files matter
tldr imports file.py              # What does buggy file depend on?
tldr impact func_name .           # Who calls the buggy function?
tldr calls .                      # Cross-file edges

# 2. READ: Get actual code for critical files (2-4 files, not all 50)
tldr search "def buggy_func" . -C 20   # Code with context
# Then use Read tool for full implementation if needed
```

For cross-file bugs (field name mismatch, type mismatch): TLDR finds which files matter, then you read them.

---

## Decision Tree: Which Command?

```
Need to find code?
  └─ By name/pattern → tldr search
  └─ By meaning → tldr semantic search

Need to understand code?
  └─ What it calls → tldr calls / tldr extract
  └─ Who calls it → tldr impact
  └─ How complex → tldr cfg
  └─ Variable flow → tldr dfg
  └─ What affects line X → tldr slice

Need to analyze codebase?
  └─ Dead code → tldr dead
  └─ Architecture → tldr arch
  └─ Import graph → tldr imports / tldr importers

Need to validate changes?
  └─ Type errors → tldr diagnostics
  └─ Affected tests → tldr change-impact
```

---

<!-- archived-rule:tldr-cli.md ref:b800899 -->
## Reference: pre-split text of `rules/tldr-cli.md` (archived 2026-07-29)

The rule now carries only the invariants an agent must hold *before* deciding to use this
tool. The evidence trail, version pins, probe archaeology and long caveats live here, and
load only once this skill does. Verbatim snapshot, so nothing that was trimmed is lost:

````markdown
# TLDR CLI - Code Analysis Tool

You have `tldr` available on PATH for token-efficient code analysis.

## Commands

```bash
# Core analysis
tldr tree [path]                    # File tree
tldr structure [path] --lang <lang> # Code structure (codemaps)
tldr search <pattern> [path]        # Search files
tldr extract <file>                 # Full file info
tldr context <entry> --project .    # LLM-ready context

# Flow analysis
tldr cfg <file> <function>          # Control flow graph
tldr dfg <file> <function>          # Data flow graph
tldr slice <file> <func> <line>     # Program slice
tldr calls [path]                   # Cross-file call graph

# Codebase analysis
tldr impact <func> [path]           # Who calls this function? (reverse call graph)
tldr dead [path]                    # Find unreachable/dead code
tldr arch [path]                    # Detect architectural layers

# Import analysis
tldr imports <file>                 # Parse imports from a file
tldr importers <module> [path]      # Find all files that import a module

# Quality & testing (NEW)
tldr diagnostics <file|path>        # Type check + lint (pyright/ruff)
tldr change-impact [files...]       # Find tests affected by changes
```

## When to Use

- **Before reading files**: Run `tldr structure .` to see what exists
- **Finding code**: Use `tldr search "pattern"` instead of grep for structured results
- **Understanding functions**: Use `tldr cfg` for complexity, `tldr dfg` for data flow
- **Debugging**: Use `tldr slice file.py func 42` to find what affects line 42
- **Context for tasks**: Use `tldr context entry_point` to get relevant code
- **Impact analysis**: Use `tldr impact func_name` before refactoring to see what would break
- **Dead code**: Use `tldr dead src/` to find unused functions for cleanup
- **Architecture**: Use `tldr arch src/` to understand layer structure
- **Import tracking**: Use `tldr imports file.py` to see what a file imports
- **Reverse imports**: Use `tldr importers module_name src/` to find who imports a module
- **Before tests**: Use `tldr diagnostics .` to catch type errors before running tests
- **Selective testing**: Use `tldr change-impact` to run only affected tests

## Languages

Supports: `python`, `typescript`, `go`, `rust`

## Example Workflow

```bash
# 1. See project structure
tldr tree src/ --ext .py

# 2. Find relevant code
tldr search "process_data" src/

# 3. Get context for a function
tldr context process_data --project src/ --depth 2

# 4. Understand control flow
tldr cfg src/processor.py process_data

# 5. Before refactoring - check impact
tldr impact process_data src/ --depth 3

# 6. Find dead code to clean up
tldr dead src/ --entry main cli
```

## Codebase Analysis Commands

### Impact Analysis
```bash
tldr impact <function> [path] --depth N --file <filter>
```
Shows reverse call graph - all functions that call the target. Useful before refactoring.

### Dead Code Detection
```bash
tldr dead [path] --entry <patterns>
```
Finds functions never called (excluding entry points like main, test_, etc.)

### Architecture Detection
```bash
tldr arch [path]
```
Analyzes call patterns to detect:
- Entry layer (controllers/handlers)
- Middle layer (services)
- Leaf layer (utilities)
- Circular dependencies

### Import Analysis
```bash
tldr imports <file> [--lang python]
```
Parses all import statements from a file. Returns JSON with module names, imported names, aliases.

### Reverse Import Lookup
```bash
tldr importers <module> [path] [--lang python]
```
Finds all files that import a given module. Complements `tldr impact` which tracks function *calls* - this tracks *imports*.

### Diagnostics (Type Check + Lint)
```bash
tldr diagnostics <file>              # Single file
tldr diagnostics . --project         # Whole project
tldr diagnostics src/ --format text  # Human-readable output
tldr diagnostics src/ --no-lint      # Type check only
```
Runs pyright (types) + ruff (lint) and returns structured errors. Use before tests to catch type errors early.

### Change Impact (Selective Testing)
```bash
tldr change-impact                   # Auto-detect (session/git)
tldr change-impact src/foo.py        # Explicit files
tldr change-impact --session         # Session-modified files
tldr change-impact --git             # Git diff files
tldr change-impact --run             # Actually run affected tests
```
Finds which tests to run based on changed code. Uses call graph + import analysis.

## Output

All commands output JSON (except `context` which outputs LLM-ready text, `diagnostics --format text` for human output).
````
