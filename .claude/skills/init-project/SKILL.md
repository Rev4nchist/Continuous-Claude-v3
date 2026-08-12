---
name: init-project
description: Initialize Continuous Claude v3 for a new project with full toolset activation. Creates project CLAUDE.md (interview-driven, 8 sections), ROADMAP.md, knowledge tree, and project registry entry. Use when opening a new project folder for the first time, starting a new project, setting up CCv3 in an existing repo, or the user says "init project", "setup project", "new project", "initialize", "start new project".
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion]
metadata:
  user-invocable: true
  triggers: ["/init-project", "init project", "new project", "setup project", "initialize project", "start new project", "new project setup"]
---

# Init Project -- Full CCv3 Toolset Activation

Set up a project with the complete Continuous Claude v3 infrastructure. This goes beyond knowledge tree and ROADMAP -- it creates a comprehensive project CLAUDE.md, activates code intelligence, registers the project, and optionally scaffolds dev server management.

## What Gets Created

| Artifact | Purpose | Phase |
|----------|---------|-------|
| Git repo + `.gitignore` | Preflight: HEAD must exist (workers, hooks assume it) | 0 (auto) |
| `CLAUDE.md` | Project-specific instructions (stack, commands, conventions) | 1 (interview) |
| `ROADMAP.md` | Goal tracking, auto-synced by hooks | 2 (auto) |
| `.claude/knowledge-tree.json` | Project navigation map | 3 (auto) |
| Registry entry | Repo-canonical `project-registry.json` updated + synced | 5 (auto) |
| Sentry SDK | Per-framework error monitoring setup | 6 (conditional) |
| E2E test scaffold | `e2e/smoke.spec.ts` + `playwright.config.ts` | 7 (conditional, web only) |
| Dev server scripts | `scripts/dev-start.mjs` + `dev-cleanup.mjs` | 8 (conditional, web only) |

## Execution Flow

Run through each phase in order. Skip phases where the artifact already exists (re-running is safe).

---

### Phase 0: Git Preflight

Worktree-based workers (`/codex` and `/grok` implement mode branch a worktree from HEAD) and several hooks assume a git repo with at least one commit. Verify before anything else.

**Detect the real repo state with `git rev-parse`, never a bare `.git` directory test** (`.git` is a FILE in worktrees/submodules — a `-d .git` check misclassifies them):

```bash
git rev-parse --is-inside-work-tree 2>/dev/null   # "true" → repo exists
git rev-parse --show-toplevel 2>/dev/null          # where its root actually is
```

- **Toplevel is a PARENT directory** → you're inside another repo's tree. Do NOT `git init` a nested repo — surface this to the user and ask whether the project should be its own repo or live in the parent.
- **Repo exists here** → note current branch + remotes (feeds the Phase 1 git-workflow question). Warn if on `main` per global preflight rules. Verify HEAD exists (`git rev-parse HEAD`); if the repo has no commits yet, treat as the no-repo commit path below.
- **No repo** → confirm with the user, then:
  1. `git init`
  2. Seed `.gitignore` with exactly:
     ```
     node_modules/
     .env*
     !.env.example
     .dev-server.pid
     .claude/settings.local.json
     .claude/cache/
     .claude/knowledge-tree.json
     ```
     Do NOT ignore `CLAUDE.md`, `ROADMAP.md`, or `.claude/skill-rules.json` — those are committed project content. (`knowledge-tree.json` is regenerable, hence ignored.)
  3. **Check identity before committing**: `git config user.name` and `git config user.email`. If either is unset the commit fails silently and leaves no HEAD — ask the user for values (or set from the global config) before proceeding.
  4. Initial commit (use `--allow-empty` if the directory has nothing stageable yet) so HEAD always exists.

---

### Phase 1: Interview and CLAUDE.md Generation

This is the most important phase. A good project CLAUDE.md dramatically improves every future session.

**Step 1.1: Gather context automatically**

Before asking the user anything, scan the project:
- Read `package.json` (if present) for name, scripts, dependencies
- Read `README.md` (if present) for description
- Check for `tsconfig.json`, `next.config.*`, `vite.config.*`, `Cargo.toml`, `pyproject.toml`, `go.mod` to detect stack
- List top-level directories for project structure
- Check `.git/config` for remote names and URLs

**Step 1.2: Ask the user to confirm and fill gaps (AskUserQuestion)**

Present what you found, then use ONE `AskUserQuestion` call (up to 4 structured questions) covering the gaps:

1. **Identity** — project name + one-line description (offer the auto-detected values as the first option)
2. **Stack** — "detection correct?" with the detected stack as the recommended option
3. **Dev port/URL** — offer the next free port derived from the registry (see Phase 5) and the `https://<project>.localhost/` convention
4. **Git workflow** — remote convention (origin = upstream never push / fork = always push / single remote), seeded from what Phase 0 found

Give every question an "infer from codebase / use defaults" style option so "just figure it out" is one click. Skip questions Phase 0/1.1 already answered definitively. Follow up conversationally for critical conventions the structured form can't capture.

**Step 1.3: Generate CLAUDE.md**

Read the template at `references/claude-md-template.md` and fill in all placeholders with gathered information. Write to `CLAUDE.md` in the project root.

The template has 8 sections. Every section matters:
1. **Project Overview** -- name, description, status
2. **Tech Stack** -- table format, every layer
3. **Local Dev** -- port, URL, dev command (skippable for libraries)
4. **Directory Structure** -- tree with purpose annotations
5. **Conventions** -- coding standards the project follows
6. **Commands** -- every dev/test/build/deploy command
7. **Git Workflow** -- remote convention, branch strategy
8. **CCv3 Integration** -- pointers to global capabilities (memory, agents, hooks)

Section 8 is critical because it tells future sessions about the full toolset. Without it, Claude operates on generic defaults and misses 90% of the infrastructure.

---

### Phase 2: ROADMAP.md

If `ROADMAP.md` doesn't exist, create it:

```markdown
# Project Roadmap

## Current Focus
**[Ask the user for their immediate goal]**
- What you're working on
- Started: YYYY-MM-DD

## Completed
- [x] Initial CCv3 setup (YYYY-MM-DD)

## Planned
- [ ] [Ask user for first planned feature]

## Recent Planning Sessions
_Planning sessions will be recorded here automatically by hooks._
```

Ask the user for their current focus so the ROADMAP starts populated.

---

### Phase 3: Knowledge Tree

Generate the knowledge tree:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/knowledge_tree.py --project "$(pwd)" --verbose
```

If this fails (missing dependencies, wrong env), note it and continue. The session-start hook will auto-generate it on next session.

---

### Phase 4: Next.js DevTools MCP (Conditional)

If the project is **Next.js 16 or above** (check the `next` version in `package.json` — the runtime endpoint `/_next/mcp` requires v16+), add the official Vercel devtools MCP to the project's **root `.mcp.json`** so the agent gets live runtime access (build/runtime/type errors, routes, server actions, dev logs) from the running dev server:

```jsonc
// <project>/.mcp.json  — merge into existing mcpServers if the file already exists
{
  "mcpServers": {
    "next-devtools": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "next-devtools-mcp@latest"],
      "type": "stdio"
    }
  }
}
```

- **Windows:** use the `cmd /c` wrapper above — bare `npx` fails on Windows (see `windows-platform.md`). The official Vercel docs show bare `npx`; we wrap it.
- It auto-connects when the dev server runs (`npm run dev`); with no dev server it no-ops harmlessly. This is why it's project-scoped, **not** global.
- Pairs with the globally-vendored `next-best-practices` / `next-cache-components` / `next-upgrade` skills — those cover *static* best-practice knowledge; this MCP is the *runtime* side.
- **Skip if** Next.js < 16 (no `/_next/mcp` endpoint) or not a Next.js project.

Reference: https://nextjs.org/docs/app/guides/mcp

---

### Phase 5: Project Registry

**The REPO copy is canonical**: `~/continuous-claude/.claude/project-registry.json`. The `~/.claude/` copy is a sync mirror — never hand-write it.

1. **Assign a port** (web projects): collect ALL `port` values from the registry (including non-web 8xxx entries) and pick the next free 3xxx.
2. **Update the repo registry** in a SINGLE Node read-modify-write process (temp file + rename — never the Edit tool, never separate read/write calls; see the project-registry skill's atomic-write rule):

```javascript
// node -e, one process: read, push, validate, atomic rename
const fs = require('fs');
const p = 'C:/Users/david.hayes/continuous-claude/.claude/project-registry.json';
const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
reg.projects.push({
  name: "Project Name",
  path: "C:/Users/.../Projects/project-name",
  stack: ["Next.js", "TypeScript", "Drizzle"],   // ARRAY, per schema
  description: "One-line description",           // required
  port: 3006,
  url: "https://project.localhost/",
  devCommand: "npm run dev",
  status: "active"
});
const tmp = p + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
JSON.parse(fs.readFileSync(tmp, 'utf8'));  // validate before replacing
fs.renameSync(tmp, p);
```

3. **Propagate to the mirror**: `bash ~/continuous-claude/scripts/sync-to-active.sh` (the script JSON-validates and copies the registry), or note that the next commit's post-commit sync will carry it.

---

### Phase 6: Sentry SDK Setup (Conditional)

If the project deploys to Vercel or Railway, offer Sentry instrumentation:

1. **Detect framework**:
   - Next.js → `npx @sentry/wizard@latest -i nextjs`
   - Node.js/Express → `npm install @sentry/node @sentry/profiling-node`
   - Python → `uv add sentry-sdk`

2. **Configure environment** — add to `.env.local`:
   ```
   SENTRY_DSN=<from Sentry project settings>
   NEXT_PUBLIC_SENTRY_DSN=<same DSN for client-side>
   ```

3. **Verify**: `sentry-cli info` confirms authentication

4. **Skip if**: User declines, project is local-only, or no `SENTRY_AUTH_TOKEN` env var set.

Reference: `.claude/skills/sentry-cli/references/sdk-setup.md` for full per-framework guide.

---

### Phase 7: E2E Test Scaffolding (Conditional, Web Only)

If the project has `package.json` with a `dev` script and serves on a port, offer to scaffold E2E tests.

Ask the user: "Want me to set up E2E testing with Playwright? This adds a smoke test that verifies your app loads correctly."

If yes:
1. Verify `@playwright/test` is installed (or install it: `npm install -D @playwright/test`)
2. Verify Chromium browser: `npx playwright install chromium`
3. Create `e2e/smoke.spec.ts` with project-specific baseURL from registry
4. Verify `playwright.config.ts` exists (or create minimal config)
5. Add npm scripts if missing: `test:e2e`, `test:e2e:headed`, `test:e2e:codegen`
6. Run the smoke test to verify: `npx playwright test e2e/smoke.spec.ts`

The smoke test should check:
- Homepage loads (200 response)
- No console errors
- Key elements are visible (heading, navigation)

Skip entirely for non-web projects (libraries, CLI tools, scripts).

---

### Phase 8: Dev Server Setup (Conditional, Web Only)

If the project has `package.json` with a `dev` script and serves on a port, offer to scaffold the dev server cleanup pattern. Read `references/dev-server-pattern.md` for templates.

Ask the user: "Want me to set up managed dev server scripts? This prevents zombie processes when restarting dev."

If yes:
1. Create `scripts/dev-start.mjs` and `scripts/dev-cleanup.mjs`
2. Set `DEV_PORT` in `.env.local`
3. Update `package.json` dev script to `node scripts/dev-start.mjs`
4. Add `.dev-server.pid` to `.gitignore`

---

### Phase 9: Summary

Present a completion summary:

```
CCv3 initialized for [Project Name]:
  Git preflight    -- [Repo exists on branch X / Initialized + first commit / Nested-repo warning]
  CLAUDE.md        -- [X lines], 8 sections
  ROADMAP.md       -- Created with current focus: [goal]
  Knowledge tree   -- [Generated / Deferred to next session]
  Registry         -- Added to repo-canonical registry (port [PORT]) + mirror synced
  Sentry SDK       -- [Configured / Skipped (user declined or local-only)]
  E2E tests        -- [Scaffolded / Skipped (not a web project)]
  Dev server       -- [Scaffolded / Skipped (not a web project)]

Next steps:
  - Start working: just tell me what to build
  - Deep analysis: /onboard (for existing codebases)
  - Set up workflows: /build, /fix, /ralph
```

---

## Brownfield vs Greenfield

**Greenfield (empty/new project):** Interview will be shorter. Many fields will be "TBD". The CLAUDE.md is a living document -- it grows as the project develops.

**Brownfield (existing codebase):** Auto-detection fills most fields. After init-project, suggest `/onboard` for deep architecture analysis. The onboard agent creates a detailed handoff with component maps and patterns.

---

## Hooks That Activate Automatically

These hooks work in every project once CCv3 is installed globally. Init-project doesn't configure them -- they just work.

| Hook | Event | What It Does |
|------|-------|-------------|
| `post-plan-roadmap` | ExitPlanMode | Updates ROADMAP.md with planning session |
| `post-edit-diagnostics` | PostToolUse:Edit/Write | Runs `tsc --noEmit` on TS edits |
| `session-start-continuity` | SessionStart | Loads handoff context, resumes state |
| `tree-invalidate` | PostToolUse:Write | Marks knowledge tree for refresh |
| `pre-compact-extract` / `session-end-extract` | PreCompact / SessionEnd | Captures learnings automatically |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Knowledge tree fails | Skip it -- hooks auto-generate on next session start |
| Can't detect stack | Ask the user directly. Auto-detection is a convenience, not required. |
| Port conflict | Check `~/.claude/project-registry.json` for used ports, pick next available |
| User says "skip the interview" | Use auto-detected values and reasonable defaults. Generate CLAUDE.md with placeholder markers for missing info. |
