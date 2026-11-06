#!/usr/bin/env python3
"""Agent SDK usage probe: exact token counts and cost for a fixed task.

Why: cloud sessions and local sessions draw on the subscription pool, whose
meter is a percentage. The Agent SDK, run with an API key, returns exact token
counts per call. This probe gives a repeatable baseline in real tokens.

Two conditions, so setup overhead is visible:
  bare  - no settings, no tools, no CLAUDE.md. The floor for this prompt.
  repo  - cwd is this repo, project settings load (CLAUDE.md, CONTEXT.md,
          AGENTS.md, rules). The overhead every real session here pays.

Run it with a scrubbed environment so the child CLI cannot pick up this
session's CLAUDE_CODE_* variables or the session proxy URL:

  env -i HOME="$HOME" PATH="$PATH" ANTHROPIC_API_KEY=<dummy-or-real> \
      SSL_CERT_FILE=/root/.ccr/ca-bundle.crt HTTPS_PROXY="$HTTPS_PROXY" \
      python3 -I scripts/billing-probe/agent_sdk_usage_probe.py --runs 3

On Dave's Windows machine (PowerShell), with a dedicated key from the GreyMatter
org that has a spend cap. Do not commit the key:

  pip install claude-agent-sdk
  $env:ANTHROPIC_API_KEY = "<key>"
  Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue
  python scripts/billing-probe/agent_sdk_usage_probe.py --runs 3

Cloud sessions cannot run it: the credential tool refuses api.anthropic.com
because that host is authenticated by the session itself.

Output: .claude/cache/e2e/<date>-billing-probe.json (gitignored) plus a table.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from datetime import date
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / ".claude" / "cache" / "e2e"

# Fixed on purpose. Never edit between comparison runs.
PROMPT = (
    "List the first 12 prime numbers, one per line, then on a final line write "
    "the sum of them. No other text."
)
EXPECTED_SUM = 37 + 31 + 29 + 23 + 19 + 17 + 13 + 11 + 7 + 5 + 3 + 2  # 197


def options_for(condition: str, model: str) -> ClaudeAgentOptions:
    if condition == "bare":
        return ClaudeAgentOptions(
            model=model,
            tools=[],
            setting_sources=[],
            max_turns=1,
            system_prompt="You are a terse assistant.",
        )
    if condition == "repo":
        return ClaudeAgentOptions(
            model=model,
            tools=[],
            setting_sources=["project"],
            cwd=str(REPO),
            max_turns=1,
            system_prompt={"type": "preset", "preset": "claude_code"},
        )
    raise ValueError(condition)


async def one_run(condition: str, model: str) -> dict:
    result: ResultMessage | None = None
    async for msg in query(prompt=PROMPT, options=options_for(condition, model)):
        if isinstance(msg, ResultMessage):
            result = msg
    if result is None:
        raise RuntimeError("no ResultMessage returned")
    usage = result.usage or {}
    return {
        "condition": condition,
        "model": model,
        "is_error": result.is_error,
        "answer_ok": str(EXPECTED_SUM) in (result.result or ""),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
        "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
        "total_cost_usd": result.total_cost_usd,
        "duration_ms": result.duration_ms,
        "num_turns": result.num_turns,
    }


def summarize(rows: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for cond in sorted({r["condition"] for r in rows}):
        sel = [r for r in rows if r["condition"] == cond and not r["is_error"]]
        if not sel:
            out[cond] = {"runs": 0}
            continue
        out[cond] = {
            "runs": len(sel),
            **{
                k: round(statistics.mean(r[k] or 0 for r in sel), 6)
                for k in (
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_tokens",
                    "cache_read_tokens",
                    "total_cost_usd",
                )
            },
        }
    return out


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs", type=int, default=3, help="runs per condition")
    ap.add_argument("--model", default="claude-haiku-5-5")
    ap.add_argument("--conditions", nargs="+", default=["bare", "repo"])
    ap.add_argument("--name", default="billing-probe")
    args = ap.parse_args()

    rows: list[dict] = []
    for cond in args.conditions:
        for i in range(args.runs):
            row = await one_run(cond, args.model)
            rows.append(row)
            print(
                f"{cond:5} run {i + 1}: in={row['input_tokens']} out={row['output_tokens']} "
                f"cache_w={row['cache_creation_tokens']} cache_r={row['cache_read_tokens']} "
                f"cost=${row['total_cost_usd']} ok={row['answer_ok']}",
                flush=True,
            )

    summary = summarize(rows)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{date.today().isoformat()}-{args.name}.json"
    path.write_text(
        json.dumps({"prompt": PROMPT, "model": args.model, "summary": summary, "runs": rows}, indent=2)
    )
    print("\nmean per condition:")
    print(json.dumps(summary, indent=2))
    print(f"\nsaved: {path}")
    return 0 if all(not r["is_error"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
