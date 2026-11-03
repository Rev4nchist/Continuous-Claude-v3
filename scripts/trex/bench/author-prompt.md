You write TREX test flows for one code change ({ref}).

This folder is the code after the change. PR.diff is the change.
Read PR.diff, then the changed files. Read only inside this folder.
Do not run commands. Do not edit files.
Do not look for review notes, test answers or other test flows.

Write 1 to 3 flows. Each flow must fail if the change has a defect that a user would hit. It must pass if the change is correct.
Aim at the riskiest behaviour. Use the schema below with `mode: scripted`.

## Rules

- Drivers: cli, hook, mod-event, api, browser.
- Checks: exit, stdout, !stdout, json, status, body, !body, file, playwright.
- One line per check. Never use a `judge` check. Never write `start.note`.
- `paths` must name changed files (glob syntax: posix, no `./`, no braces).
- Flows run in a Linux container (Node 22, git, Postgres 16, Chromium, no network), or on a Windows host for the cases in "Host flows".
- Supply every fixture, spec or shim that a flow names. Put fixtures in your output.
- When you cannot build a risk (scale, OS limits, timing), list it under `cannotVerify`. Never write a flow that claims to test it.
- A flow file name ends in `.yaml`. A fixture name must NOT end in `.yaml` or `.yml`.

## Host flows

{hostRules}

A host flow may run only a `.ps1` that is already in this folder. Never write a `.ps1` file in your output.

## Schema

```yaml
id: pre-pr-gate-inline-body          # ^[a-z0-9-]{3,64}$, unique in your output
title: one line, 120 characters at most
description: one line
goal: one line
paths: [path/of/a/changed/file.ts]   # at least one changed file
symbols: [functionName]              # optional
driver: hook                         # cli | hook | mod-event | api | browser
mode: scripted
profile: container                   # container | host
needs: [git]                         # optional: db | git
start:                               # optional
  git: commit                        # in the container: git init, add, commit
  stamp: fixtures/stamp.json         # fixture path, relative to your folder
  db: fixtures/seed.sql              # needs db in `needs`
  run: [node, scripts/setup.mjs]     # optional setup argv
  cwd: .
steps:                               # 1 to 100 steps
  - action: {hook: .claude/hooks/dist/pre-pr-gate.mjs, payload: fixtures/payload.json}
    checks:
      - {text: gate blocks the call, stdout: "BLOCKED \\(pre-pr-gate\\)"}
limits: {timeoutMs: 60000, retries: 1, maxSteps: 20}
severity: P1                         # P0 | P1 | P2
```

Actions by driver:

- cli: `{cmd: [argv...], cwd?, env?, stdin?}`
- hook: `{hook: <path of a built hook in the code tree>, payload: <fixture path>}`
- mod-event: `{test: <name>}`
- api: `{method, path, bodyFile?}`
- browser: `{playwright, config, projects: [...]}`

Check kinds (one per check, plus `text`):

- `exit: int`
- `stdout: regex` and `"!stdout": regex`
- `json: {file, path, equals}`
- `status: int`
- `body: regex` and `"!body": regex`
- `file: path` with `"~": regex` or `"!~": regex`
- `playwright: passed`

Fixture paths are relative to your folder `{folder}`. `{{HEAD}}` in a stamp file becomes the in-container HEAD.

## Output format

Write each file as a fenced block that starts with ` ```file path=<relative path> `.
The path is relative to `{folder}`. It uses `/`. It never starts with `/`, never holds `..` and never holds a drive letter.
Close each block with a line that holds only ` ``` `.

End with exactly one ```json block and nothing after it:

{"flows":[{"id":"...","file":"<flow file path>","risk":"..."}],"cannotVerify":[{"risk":"...","why":"..."}]}

Every `.yaml` file you write must appear in `flows`. Every `file` in `flows` must be a block you wrote.

## The change

Changed files ({fileCount}):
{files}
