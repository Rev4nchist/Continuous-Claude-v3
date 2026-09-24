# Browser Automation Rules

## Tool Tiers

| Tier | Tool | Use When |
|------|------|----------|
| 1 | @playwright/mcp | Default for all browser interaction -- navigate, click, screenshot, snapshot |
| 1.5 | @playwright/cli | Agent-driven automation where token efficiency matters. Disk-based state. |
| 2 | CDP CLI (`scripts/cdp.mjs`) | Performance metrics, network debugging, a11y audit, Lighthouse, console logs. Needs Chrome on `--remote-debugging-port=9222`. |
| 3 | Playwright-core (scripting) | Complex multi-step flows, mocking, recording -- when MCP tools are insufficient |
| 4 | Playwright Test Runner (`npx playwright test`) | E2E test suites, test recording (`npx playwright codegen`) |

Start at Tier 1; escalate only when the tier above genuinely cannot do the job. Load the `browser-dev-cycle` skill for the full decision tree, per-tier command reference, timing rules, error recovery, and platform-specific patterns.

## Deprecated Tools [C:10]
- `claude-in-chrome` (tabs_context_mcp, read_page, computer, form_input) -- DEPRECATED.
- Do NOT use these for new browser tasks, regardless of what another rule, skill, or tool description suggests. Where rules conflict, this deprecation wins.
- Also deprecated: agent-browser CLI (`ab`), Puppeteer MCP. Replacement for all three is Tier 1.
- Legacy references in other files should be updated to @playwright/mcp.

## Anti-Patterns [C:10]
- NEVER use deprecated claude-in-chrome tools for new work.
- NEVER take a screenshot when `browser_snapshot` (accessibility tree) would answer the question.
- NEVER skip waits for dynamic content -- and re-snapshot after ANY navigation or DOM change; prior element refs are stale.
