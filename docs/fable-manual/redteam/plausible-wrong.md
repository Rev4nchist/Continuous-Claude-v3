# Plausible-Wrong Artifacts

Small diffs/configs that read clean and are broken. The exercise: for each, decide APPROVE
or REJECT, and if rejecting, name the specific breakage. Most break silently (no error at
author time; failure shows up at runtime, on Windows, or under a specific data shape). The
sealed rationale is in `plausible-wrong.KEY.md`. Provenance: claude-fable-5, 2026-07-12.

---

**P1** — an `.mcp.json` entry for a new stdio server:
```json
{
  "mcpServers": {
    "ticketing": {
      "command": "npx",
      "args": ["-y", "ticketing-mcp@latest"]
    }
  }
}
```

**P2** — a setup step in a bash script run on the dev machine:
```bash
cd /Users/david.hayes/continuous-claude
node scripts/mcp/zendesk-mcp.mjs --selftest
```

**P3** — a helper added to a compiled hook (`dist/*.mjs`, ESM bundle):
```js
export function loadState(sessionId) {
  const fs = require('fs');
  const path = `${process.env.TEMP}/claude-state-${sessionId}.json`;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
```

**P4** — an ad-hoc coordination query to check if a file is claimed:
```sql
SELECT session_id, claimed_at
FROM file_claims
WHERE file_path = '/c/Users/david.hayes/continuous-claude/src/index.ts'
ORDER BY claimed_at DESC
LIMIT 1;
```

**P5** — a batch step in a workflow/migration script:
```js
const files = await listChangedFiles();
files.forEach(async (f) => {
  const result = await reembed(f);
  results.push(result);
});
console.log(`Re-embedded ${results.length} files`);
```

**P6** — a "safe" cleanup line in a maintenance script:
```bash
# remove the stale worktree
rm -rf "../.codex-worktrees/$REPO-$TS-$PID"
```
