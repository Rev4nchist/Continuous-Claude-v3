---
name: skill-forge
description: Authors, evaluates and tunes Claude Code skills with skill-on vs skill-off evals. Use when the user wants to create, improve, test or benchmark a skill, or fix one that misfires.
---

# Skill Forge

Skill Forge builds, tests and tunes skills for Claude Code. Claude Code is the only target platform.
A skill is a folder with a `SKILL.md`. Claude sees the name and description every turn. The body loads only after the skill fires.

## Rules (read first)

After compaction, Claude Code re-attaches only the first 5,000 tokens of a skill body. The rules that must hold are first on purpose.

1. Work in the repo. Scaffold into `.claude/skills/` of the repo. Never write to `~/.claude/skills`: the next sync overwrites it.
2. Pass the gate. Run `node scripts/skills/audit-skills.mjs --skill .claude/skills/<name>`. It must show 0 hard failures and 0 ratchet regressions. `quick_validate.py` runs the same gate.
3. Write the description as "Does X. Use when Y." Use one line, third person, at most 400 characters. The hard limit is 1,024.
4. Name specific terms in the description. Do not push ("always use this"). Add "Not for Z" when a near miss exists.
5. Keep the body short. Add only what Claude does not know. Do not add a "When to Use" section: the body loads after the skill fired.
6. Write 3 evals or more before long docs. Compare skill on against skill off. Test Sonnet at high effort, Opus and Fable. Never Haiku.
7. Spend no API key. Headless runs use `claude -p` on the subscription. The scripts remove `ANTHROPIC_API_KEY` from the child env.
8. A rule that must always hold belongs in a hook. A skill body is advice, and the model can skip it.

## Requirements

Python 3.10 or newer, Node.js and the `claude` CLI on PATH. `quick_validate.py` and `init_skill.py` call the gate (`scripts/skills/audit-skills.mjs`) and fail with a clear message when Node is missing. PyYAML is optional: `quick_validate.py` uses it for the upload key check when it is installed. Run the scripts from the continuous-claude repo, or set `CCV3_REPO_ROOT`.

## Workflow

Copy this checklist and tick each step.

```
- [ ] 1 Capture intent
- [ ] 2 Write 3+ evals
- [ ] 3 Scaffold
- [ ] 4 Write the minimum SKILL.md that passes the evals
- [ ] 5 Run the evals: skill on vs off, each model
- [ ] 6 Grade, then read the navigation
- [ ] 7 Improve and rerun
- [ ] 8 Tune the description
- [ ] 9 Validate
```

If the user already has a draft, start at the step that fits. If the user wants a quick draft with no evals, do steps 1, 3, 4 and 9, and say that the skill is untested.

### 1. Capture intent

Take the answers from the conversation first. Ask only for what is missing.

- What must Claude do that it cannot do without the skill?
- Which user phrases trigger it? Which near misses must not?
- What does good output look like? Can a script or a grader check it?

A subjective skill (tone, art) needs human review. An objective skill (file transform, extraction, code) needs assertions.

Pick the degree of freedom. High: prose heuristics, when many approaches work. Medium: a parameterised script, when one pattern is preferred. Low: an exact script, when the operation is fragile or ordered.

### 2. Write evals

Write at least 3 evals. Save them to `evals/evals.json` in the skill folder. Both shapes load. The guide shape:

```json
[
  {
    "skills": ["premortem"],
    "query": "Premortem this plan: move the cron jobs to a new host on Friday.",
    "files": [],
    "expected_behavior": ["Sorts risks into tigers, paper tigers and elephants", "Names a rollback risk"]
  }
]
```

`expected_behavior` becomes the assertions that the grader checks. See [schemas](references/schemas.md) for the other shape and every field.

### 3. Scaffold

```bash
python "${CLAUDE_SKILL_DIR}/scripts/init_skill.py" <skill-name>
```

This creates `.claude/skills/<skill-name>/SKILL.md` and nothing else. Add `--scripts`, `--references` or `--assets` for those folders. The script asks the gate to check the name and refuses a bad one. Use `--path` for a different parent folder.

The scaffold passes the gate. It fails `quick_validate.py` until you replace the placeholder description and every `TODO`.

### 4. Write SKILL.md

Set `name` and `description`. Add any other key only for a reason. The frontmatter rules for Claude Code are in the [authoring guide](references/authoring-guide.md#frontmatter-for-claude-code). The short version:

- Default: both Claude and the user can invoke the skill. `disable-model-invocation: true` makes it user-only and removes its description from the listing. `user-invocable: false` hides it from the `/` menu and keeps Claude able to use it.
- `allowed-tools` pre-approves tools for the turn. It never restricts. Use `disallowed-tools` or a deny rule to restrict. Scope shell grants, for example `Bash(git status *)`. Never grant bare `Bash`.
- `metadata:` is ignored. Never put a real key name inside it.

Write the body like this:

- Use imperative steps. Give one default and one escape hatch, not a menu.
- Use one term for one concept.
- Show an input and output pair where the output style matters.
- Say "run" for a script that executes and "read" for a file that loads.
- Link every reference file from `SKILL.md`. References stay one level deep. A reference over 100 lines starts with a contents list.
- Use forward slashes in paths.
- Write no dated text. Put legacy advice under an "Old patterns" heading.
- Name MCP tools by their runtime name: `mcp__<server>__<tool>`. Never assume a server is installed.
- Keep the body under 500 lines. Aim for far less.

Read the [authoring guide](references/authoring-guide.md) for the substitution rules, the listing budget, templates and worked examples.

### 5. Run the evals

```bash
python "${CLAUDE_SKILL_DIR}/scripts/run_eval.py" behavior \
  --skill-path .claude/skills/<name> --evals .claude/skills/<name>/evals/evals.json --grade
```

The output goes to a temp folder (`<temp>/skill-eval/<name>-<time>`), and the script prints it. Keep any `--out` folder outside the repo. A folder without `SKILL.md` under `.claude/skills/` fails gate rule G29.

For every model and eval, the script makes two runs, each in its own temp project:

- `with_skill`: a renamed copy of the skill (`<name>-eval<hex>`) from the folder you pass. The real name is off. A personal copy in `~/.claude/skills/<name>` therefore cannot win over the copy under test.
- `without_skill`: the same prompt and no copy of the skill. The real name is off here too.

Both settings files carry your own `skillOverrides` map and differ in nothing else.

Every run is `claude -p --output-format stream-json --verbose` with hooks off, an empty strict MCP config, read-only tools and a turn cap. The default models are Sonnet at high effort, Opus and Fable. Use `--models sonnet,opus` for a subset, `--eval-ids 1` for one eval and `--dry-run` to print the plan and spend nothing. The run sees only the read-only tools `Skill`, `Read`, `Glob` and `Grep`, and they are pre-approved. Pass `--tools` for an eval that needs more. Every tool you name there is pre-approved too.

Each run folder holds `transcript.jsonl`, `transcript.md`, `outputs/response.md`, `run.json` and `grading.json`. `run.json` records `skill_fired` and the navigation (see step 6). Reads under the personal copy count as reads of the skill.

A run is excluded when it errored, did not end with a `success` result, lost its result event, or broke the baseline (the skill was listed, fired or read in `without_skill`). An excluded run is not graded. Its `grading.json` says why, and `aggregate_benchmark.py` skips it and prints the count.

### 6. Grade and read the navigation

`--grade` runs `agents/grader.md` through `claude -p` for each run. To grade later, run `run_eval.py grade --out <folder>`.

The grader is blind: it sees `transcript.md` and `outputs/` only. Skill use and navigation are in `run.json` and `summary.json`.

Read `run.json` for each run. Check four things:

- `skill_listed` and `skill_fired`: with the skill on, both must be true. With the skill off, `skill_listed` must be false, which proves the override worked.
- `excluded` and `error`: a run with a reason there does not count. A failed Skill tool call reports `skill load failed`. Fix the cause and rerun.
- `navigation.skill_files_read` and `skill_files_unread`: a file that is never read is dead weight. Remove it or point to it better. A file read in an odd order, or a section read every time, belongs in `SKILL.md`.
- `navigation.reads_outside_skill`: the run looked elsewhere for something the skill should have said.

Then build the benchmark and open the viewer.

```bash
python "${CLAUDE_SKILL_DIR}/scripts/aggregate_benchmark.py" <out>/<model> --skill-name <name>
python "${CLAUDE_SKILL_DIR}/eval-viewer/generate_review.py" <out>/<model> --skill-name <name> --benchmark <out>/<model>/benchmark.json
```

Add `--static <file.html>` to the viewer for a standalone page. For a blind A/B between two skill versions, read `agents/comparator.md` and `agents/analyzer.md`. Most skills do not need it.

### 7. Improve and rerun

- Generalise from the failures. Do not patch single cases.
- Read transcripts, not only outputs. Cut the parts that send the model down useless paths.
- Explain why. A reason works better than ALWAYS or NEVER in capitals.
- If every run wrote the same helper script, bundle it in `scripts/`.

Rerun into `iteration-2`. Stop when feedback is empty or progress stops.

### 8. Tune the description

Do this after the skill works. Write 20 queries: 8 to 10 that should trigger and 8 to 10 near misses that should not. Use realistic phrasing, paths and typos. Fill the placeholders `__EVAL_DATA_PLACEHOLDER__`, `__SKILL_NAME_PLACEHOLDER__` and `__SKILL_DESCRIPTION_PLACEHOLDER__` in `assets/eval_review.html`. The user edits the queries there and exports `eval_set.json`.

```bash
python "${CLAUDE_SKILL_DIR}/scripts/run_loop.py" --eval-set <eval_set.json> \
  --skill-path .claude/skills/<name> --models sonnet --max-iterations 5 --verbose
```

Add `--dry-run` to print the plan and spend nothing. An empty query set is an error. If more than a quarter of the trigger runs fail, the loop stops with an error. A query whose runs all failed is listed as `unmeasured` and is never scored as a failure. The loop scores each description with fresh headless runs and reads the `Skill` tool call. A copy of the skill carries the candidate description, and the real skill is switched off. Proposals come from `claude -p`. Each one stays under 400 characters and passes the gate's description rules.

Apply `best_description` to the frontmatter yourself. Show the user the before and after, and the scores.

Every model-visible description costs context on every turn. When the listing is over budget, Claude Code drops the descriptions of the least-invoked skills first. Put the key use case first and keep it short.

### 9. Validate

```bash
python "${CLAUDE_SKILL_DIR}/scripts/quick_validate.py" .claude/skills/<name>
claude plugin validate .claude/skills
```

The first command runs the gate and the checks the gate does not cover (placeholders, `TODO` markers, script shebangs). The second finds YAML parse errors. A YAML error drops the frontmatter, so the skill never triggers.

Claude Code reloads an edited `SKILL.md` live. No restart is needed. `/reload-skills` is needed only for a new top-level skills folder.

`package_skill.py` builds a `.skill` zip for claude.ai upload or the Skills API only. It validates with `--target upload`, which accepts six frontmatter keys. Claude Code skills do not need packaging.

## Reference index

| Resource | Purpose |
|----------|---------|
| `references/authoring-guide.md` | Frontmatter, substitutions, listing budget, templates, examples, troubleshooting |
| `references/schemas.md` | JSON schemas for evals, runs, grading, benchmark and comparison |
| `agents/grader.md` | Grades assertions against a transcript and outputs |
| `agents/comparator.md` | Blind A/B comparison of two outputs |
| `agents/analyzer.md` | Explains a comparison result and benchmark patterns |
| `scripts/init_skill.py` | Scaffolds a skill |
| `scripts/quick_validate.py` | Runs the gate and the extra checks |
| `scripts/run_eval.py` | Behaviour evals, trigger evals and grading |
| `scripts/run_loop.py` | Description tuning loop |
| `scripts/improve_description.py` | One description proposal through `claude -p` |
| `scripts/aggregate_benchmark.py` | Benchmark statistics from grading files |
| `scripts/generate_report.py` | HTML report of the tuning loop |
| `scripts/package_skill.py` | `.skill` zip for upload |
| `eval-viewer/generate_review.py` | Interactive viewer for eval runs |
| `assets/eval_review.html` | Editor for the trigger query set |
