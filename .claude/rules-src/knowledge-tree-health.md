# Knowledge Tree Health

The knowledge tree (`knowledge-tree.json`) is critical for project navigation. It can silently break.

## Session Start Check

If `.claude/knowledge-tree.json` is missing or empty, regenerate immediately:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/knowledge_tree.py --project <project-dir> --verbose
```

Validate after generation:

```bash
cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/core/tree_schema.py --validate <project-dir>/.claude/knowledge-tree.json
```

## Known Failure Modes

| Failure | Cause | Fix |
|---------|-------|-----|
| Tree missing, no auto-regen | Hook exclusion skipped this project | Fixed in session-start-init-check.ts; manual regen if needed |
| Unicode crash on Windows | Python emojis crash cp1252 encoding | Fixed in commit 5a36ef2; use ASCII only in scripts |
| Tree stale after major changes | Hooks didn't trigger (no watcher daemon by design) | Manual regen with command above |
| Empty tree file (0 bytes) | Script crashed mid-write | Delete and regenerate |

## Architecture

- **Hooks**: `tree-invalidate.ts` (marks stale), `session-start-init-check.ts` (auto-generates on read), `pageindex-watch.ts`
- **Scripts**: `knowledge_tree.py` (generator), `query_tree.py` (queries), `tree_schema.py` (validation), `lazy_tree.py` (on-demand wrapper)
- **Skill**: `.claude/skills/knowledge-tree/SKILL.md`
- **Output**: `.claude/knowledge-tree.json`
- **Note**: There is no persistent watcher daemon. Trees are regenerated lazily when stale-marked or missing.

## Prevention

- Never use emoji/Unicode in Python scripts that write to stdout on Windows
- The `session-start-init-check` hook auto-generates trees for projects with code files
- If the hook skips your project, use the manual regen command above
