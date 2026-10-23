"""One-shot smoke: RLM audit of the entire Continuous Claude architecture.

Corpus: rules + skill metadata + agents + hook TS source + core Python + docs.
Question: structured 10-section architectural audit.
Policy: generous budget, Docker sandbox, max_depth=1, max_response_tokens=6144.

Run from opc/:
    uv run python scripts/smoke_architecture_audit.py
"""
from __future__ import annotations

import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from scripts.core.rlm_client import rlm_complete, RLMPolicy


ROOT = Path("~/continuous-claude")
HOME = Path("~/.claude")


def gather_sources() -> list[Path]:
    sources: list[Path] = []
    sources.extend(sorted((ROOT / ".claude/rules").glob("*.md")))
    sources.extend(sorted((ROOT / ".claude/skills").glob("*/SKILL.md")))
    sources.extend(sorted((ROOT / ".claude/agents").glob("*.md")))
    sources.extend(sorted((ROOT / ".claude/hooks/src").glob("*.ts")))
    sources.extend(sorted((ROOT / "opc/scripts/core").glob("*.py")))
    sources.extend(sorted((ROOT / "docs/architecture").rglob("*.md")))
    for name in ("CLAUDE.md", "RULES.md", "ROADMAP.md"):
        p = ROOT / name
        if p.exists():
            sources.append(p)
    for name in ("CLAUDE.md", "RULES.md"):
        p = HOME / name
        if p.exists():
            sources.append(p)
    kt = ROOT / ".claude/knowledge-tree.json"
    if kt.exists():
        sources.append(kt)
    return sources


def build_corpus(sources: list[Path]) -> tuple[str, list[str], list[tuple[str, str]]]:
    parts: list[str] = []
    included: list[str] = []
    skipped: list[tuple[str, str]] = []
    for f in sources:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
            parts.append(f"\n\n===== {f} =====\n{text}\n")
            included.append(str(f))
        except Exception as exc:
            skipped.append((str(f), str(exc)))
    return "".join(parts), included, skipped


AUDIT_QUESTION = """You are auditing the Continuous Claude (CCv3) architecture. The corpus contains every operational rule, every skill SKILL.md, every agent definition, every hook TypeScript source file, the core Python memory/ralph/knowledge-tree scripts, the architecture docs, CLAUDE.md, RULES.md, and ROADMAP.md. Treat the banner path of each file as its identity.

Produce a structured audit report with these 10 sections. Cite filenames for every finding. Be exhaustive and specific. No vague claims.

## 1. COVERAGE MAP
Count by category:
- Total operational rules (.claude/rules/*.md)
- Total skills (SKILL.md files)
- Total agents (.claude/agents/*.md)
- Total hooks (hooks/src/*.ts)
- Total core Python scripts

## 2. OVERLAP / REDUNDANCY
Identify skills or rules that cover the same territory. List at least 8 specific overlaps by name, with shared territory described.

## 3. TRIGGER RELIABILITY (skills)
Scan skill descriptions. Flag:
- Under 30 words
- No explicit "use when" / "when users request" phrase
- Vague single-keyword triggers
- References to nonexistent files/skills
List at least 6 specific skills with the specific issue.

## 4. RULE CONFLICTS / TENSIONS
Rule pairs that could contradict under some condition. Name the pair, quote the tension, describe when it fires. At least 4 pairs.

## 5. HOOK RELIABILITY SURVEY
From the TS source in hooks/src/*.ts, list hooks with:
- Missing try/catch around main logic
- Edit tool used on settings.json (violates windows-platform.md)
- Long spawnSync operations risking SessionEnd timeout
- Crashes on missing env vars
- Unicode/emoji in stdout (Windows cp1252 breakage)
- No test file in src/__tests__/
At least 5 concrete findings with filenames.

## 6. STALE / BROKEN REFERENCES
- Files referencing claude-in-chrome (deprecated)
- References to nonexistent files/skills/agents/hooks
- CLI tools referenced but not in cli-integration-strategy.md inventory
- TODO / FIXME / deprecated markers
At least 6 concrete findings.

## 7. MISSING GUARDRAILS
Dangerous operations with no safety rule:
- CLI tools without a *-safety.md rule
- Hooks that mutate state without audit logging
- Python scripts that write files without dry-run option
- Skills/agents doing destructive operations without confirmation gates
At least 3 gaps with specific recommendations.

## 8. STRUCTURAL DRIFT
- ROADMAP.md goals vs shipped state
- Docs describing rules/skills/agents that no longer exist
- Rules referencing renamed/removed hooks
- Memory patterns documented but not implemented
At least 3 concrete drift points.

## 9. TOP 10 CONCRETE TIGHTENING RECOMMENDATIONS
Rank by impact (highest first). Each: specific (file/component names), actionable (what change), justified (which finding motivates it).

## 10. SYSTEM HEALTH VERDICT
One paragraph, 80 words max. Healthy / partially healthy / unhealthy? Biggest single risk. Biggest single strength.

Be exhaustive. Cite filenames. Enumerate, do not summarize."""


def main() -> int:
    sources = gather_sources()
    corpus, included, skipped = build_corpus(sources)

    print(f"corpus: {len(corpus):,} chars across {len(included)} files "
          f"({len(skipped)} skipped)", flush=True)

    def bucket(needle: str) -> int:
        norm = lambda s: s.replace("\\", "/")
        return sum(1 for s in included if needle in norm(s))

    print(
        f"breakdown: rules={bucket('/rules/')}, "
        f"skills={bucket('/skills/')}, "
        f"agents={bucket('/agents/')}, "
        f"hooks={bucket('/hooks/src/')}, "
        f"core_py={bucket('/opc/scripts/core/')}, "
        f"docs={bucket('/docs/')}",
        flush=True,
    )

    policy = RLMPolicy(
        max_budget_usd=15.00,
        max_timeout_s=900.0,
        max_iterations=80,
        max_response_tokens=6144,
    )

    traj = ROOT / f".claude/cache/rlm-logs/architecture-audit-{datetime.now():%Y%m%d-%H%M%S}"
    traj.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    try:
        result = rlm_complete(AUDIT_QUESTION, corpus, policy=policy, trajectory_dir=traj)
        elapsed = time.time() - t0
        print("\n=== RESULT ===", flush=True)
        print(f"path:       {result.path}", flush=True)
        print(f"usage:      {result.usage}", flush=True)
        print(f"elapsed:    {elapsed:.1f}s ({elapsed/60:.1f} min)", flush=True)
        print(f"trajectory: {traj}", flush=True)
        print(f"answer len: {len(result.answer):,} chars", flush=True)
        print("\n=== AUDIT REPORT ===", flush=True)
        print(result.answer, flush=True)
        return 0
    except Exception as exc:
        elapsed = time.time() - t0
        print(f"\n=== FAILED after {elapsed:.1f}s ===", flush=True)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
