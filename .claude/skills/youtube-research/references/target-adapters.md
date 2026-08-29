# Target adapters and impact workflow

## Registration

Only registered targets are eligible for analysis. Record path, type, audience, objective,
topics, and policy. Never scan the workspace for files to modify.

```powershell
node scripts/youtube/target.mjs register "presentations/strategy.pptx" --id strategy-deck --type pptx --audience "CTO staff" --objective "Quarterly AI strategy" --topic "Agentic AI"
node scripts/youtube/target.mjs register "site/src/pages/agents.mdx" --id agents-page --audience "Technical buyers" --objective "Explain architecture" --topic "Agentic AI"
```

## Normalized snapshots

- PPTX: slide identity, text, notes, and chart titles/series through the read-only
  `python-pptx` adapter.
- Markdown/MDX/HTML/TSX/JSX: complete source plus heading/line locators.
- Cloud-only or unsupported formats: update package only; no application.

The impact package includes add/revise/retract/flag actions, exact locator, before/proposed
copy, rationale, evidence IDs, confidence, visual direction, and layout risks. Contradictions
and stale claims are first-class changes, not footnotes.

## Apply

`impact` never edits a target. `apply` first recomputes the baseline hash; any drift rejects
the package. For supported text targets it creates a local draft under the update run and
leaves the original unchanged. PPTX and complex site work use the appropriate presentation
or site skill against the package, then verify rendering, layout, links, tests, and console.

No command in this skill deploys or publishes. Publishing is a new explicit user request.
Store evidence IDs in speaker notes or sidecar mappings so public copy stays clean.
