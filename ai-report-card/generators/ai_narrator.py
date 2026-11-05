"""Generate AI narrative summaries using Claude API."""

import json
import logging
import os
from datetime import datetime
from pathlib import Path

log = logging.getLogger("ai_narrator")


class NarrativeGenerationError(Exception):
    """Raised in strict mode when AI narratives cannot be generated.

    Trips on: no ANTHROPIC_API_KEY, missing 'anthropic' SDK, or an API/parse failure.
    The caller (weekly_run) catches it to fail loud (non-zero exit) instead of silently
    shipping degraded template narratives to the VP.
    """


def _degrade_or_raise(
    snapshot: dict, reason: str, strict: bool, extra: dict | None = None
) -> dict:
    """Strict -> raise NarrativeGenerationError(reason); non-strict -> loud banner + degraded stamp.

    In non-strict mode the template fallback is preserved but the returned dict is stamped
    ``{"_degraded": True, "_reason": reason}`` so downstream rendering can show a visible
    banner in the artifact (not just the log).
    """
    if strict:
        raise NarrativeGenerationError(reason)
    log.warning(
        "\n" + "=" * 72 + "\n"
        "  TEMPLATE NARRATIVES  --  AI narrative generation DEGRADED\n"
        f"  Reason: {reason}\n"
        "  This report contains TEMPLATE placeholder text, NOT AI-written narratives.\n"
        "  Fix: set ANTHROPIC_API_KEY (the VP report requires it), or drop --allow-template.\n"
        + "=" * 72
    )
    fallback = _fallback_narratives(snapshot)
    fallback["_degraded"] = True
    fallback["_reason"] = reason
    if extra:
        fallback.update(extra)
    return fallback


def load_previous_snapshot(snapshots_dir: str) -> dict | None:
    """Load the most recent previous snapshot for delta comparison."""
    path = Path(snapshots_dir)
    if not path.exists():
        return None

    snapshots = sorted(path.glob("*.json"), reverse=True)
    # Skip the current one (first), return the previous
    for snap in snapshots[1:]:
        try:
            with open(snap) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
    return None


def build_prompt(snapshot: dict, previous: dict | None) -> str:
    """Build the prompt for Claude to generate narrative summaries."""
    git = snapshot.get("git", {})
    totals = git.get("totals", {})
    system = snapshot.get("system", {})
    memory = snapshot.get("memory", {})

    # Build delta info if previous snapshot exists
    delta_section = ""
    if previous:
        prev_totals = previous.get("git", {}).get("totals", {})
        prev_system = previous.get("system", {})
        delta_section = f"""
## Previous Week Comparison
- Previous week commits: {prev_totals.get('week_commits', 'N/A')}
- This week commits: {totals.get('week_commits', 0)}
- Previous hooks: {prev_system.get('hooks', 'N/A')}, Current: {system.get('hooks', 0)}
- Previous skills: {prev_system.get('skills', 'N/A')}, Current: {system.get('skills', 0)}
- Previous agents: {prev_system.get('agents', 'N/A')}, Current: {system.get('agents', 0)}
"""

    # Collect per-repo summaries
    repo_summaries = []
    for name, repo in git.get("repos", {}).items():
        if not repo.get("exists"):
            continue
        messages = repo.get("top_messages", [])[:10]
        msg_text = "\n".join(f"  - {m}" for m in messages) if messages else "  (no commits this week)"
        repo_summaries.append(f"""### {repo.get('label', name)}
- Commits this week: {repo.get('week_commits', 0)}
- Total commits: {repo.get('total_commits', 0)}
- Files changed: {repo.get('files_changed', 0)}
- Recent commit messages:
{msg_text}""")

    repos_text = "\n\n".join(repo_summaries)

    # Memory insights
    memory_text = ""
    if memory.get("available"):
        achievements = memory.get("achievements", [])
        decisions = memory.get("decisions", [])
        if achievements:
            ach_list = "\n".join(f"  - {a['content']}" for a in achievements[:5])
            memory_text += f"\n## Key Achievements (from memory)\n{ach_list}"
        if decisions:
            dec_list = "\n".join(f"  - {d['content']}" for d in decisions[:5])
            memory_text += f"\n## Decisions Made (from memory)\n{dec_list}"

    return f"""You are writing a weekly AI Enablement status report for Carly Hodges, VP Enterprise Transformation & Technology at Fourth. The author is David Hayes, AI Enablement Lead.

CRITICAL: You are writing for a VP who does not know what a git commit, hook, or agent is. Translate ALL technical activity into business outcomes.

Use this vocabulary mapping:
- hooks = "automated safeguards" (quality checks that prevent errors)
- skills = "AI workflows" (reusable processes that save time)
- agents = "specialized assistants" (AI workers that handle specific tasks)
- commits = "capability iterations" (incremental improvements to the platform)
- connectors = "enterprise integrations" (connections to business tools like SharePoint, Teams)
- learnings = "organizational insights" (institutional knowledge preserved across sessions)

Generate the following sections in JSON format:

1. "executive_summary" - 2-3 sentences leading with BUSINESS OUTCOME, not activity. Example: "The AI platform now enables 3 teams to automate content workflows..." NOT "74 commits were made this week..."
2. "capabilities_shipped" - Array of 3-5 strings. Each describes a NEW thing the organization can now do, derived from this week's commit messages. Frame as outcomes: "Marketing team can now generate brand-consistent content automatically" not "Added marketing brain integration"
3. "business_impact" - Object with keys: "time_saved" (estimate based on automation delivered), "risk_reduction" (based on safeguards added), "adoption" (teams/users enabled)
4. "this_week_highlights" - 3-5 bullet points framed as outcomes. "Engineering team now has automated code quality checks" not "Added 5 new hooks"
5. "strategic_progress" - 1-2 sentences on how this week's work advances Q1 goals (platform maturity, team adoption, enterprise integration)
6. "per_project" - Object with project name keys, each containing a "delta" string (1-2 sentences framed as what the project NOW ENABLES, not what code changed)
7. "outlook" - 1-2 sentences on what's ahead next week, framed as upcoming capabilities

Keep tone professional but energetic. Show momentum through outcomes, not activity counts.
Do NOT make up metrics - use only the data provided below. But DO translate raw metrics into business language.

# This Week's Raw Data (for your analysis - do NOT echo these numbers directly)

## Platform Metrics
- Capability iterations this week: {totals.get('week_commits', 0)}
- Total capability iterations: {totals.get('total_commits', 0)}
- Files improved: {totals.get('files_changed', 0)}
- Active contributors: {totals.get('contributor_count', 0)}

## Platform Components
- Automated safeguards: {system.get('hooks', 0)}
- AI workflows: {system.get('skills', 0)}
- Specialized assistants: {system.get('agents', 0)}
- Enterprise integrations (live): {system.get('connectors_live', 0)}
- Organizational insights stored: {memory.get('total_learnings', 0)}
{delta_section}

## Per-Repository Activity (analyze commit messages to extract capabilities)
{repos_text}
{memory_text}

Respond with ONLY a JSON object. No markdown, no code fences."""


def _first_text(response) -> str:
    """Return the text of the first text block (content[0] may be a thinking block)."""
    for block in response.content:
        if getattr(block, "type", None) == "text":
            return block.text
    raise ValueError("response has no text block")


def generate_narratives(snapshot: dict, config: dict, strict: bool = True) -> dict:
    """Generate AI narratives using Claude API.

    strict=True (default): raise NarrativeGenerationError when narratives cannot be
    AI-generated (no ANTHROPIC_API_KEY, missing 'anthropic' SDK, or API/parse error) so the
    caller fails loud rather than shipping template text.
    strict=False: keep the template fallback but log a loud banner and stamp the result
    ``{"_degraded": True, "_reason": ...}`` so the degraded state is visible in the artifact.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return _degrade_or_raise(snapshot, "ANTHROPIC_API_KEY is not set", strict)

    try:
        import anthropic
    except ImportError:
        return _degrade_or_raise(
            snapshot, "the 'anthropic' package is not installed", strict
        )

    ai_config = config.get("ai", {})
    model = ai_config.get("model", "claude-sonnet-5-5")
    max_tokens = ai_config.get("max_tokens", 16000)

    # Load previous snapshot for delta comparison
    snapshots_dir = Path(__file__).parent.parent / "data" / "snapshots"
    previous = load_previous_snapshot(str(snapshots_dir))

    prompt = build_prompt(snapshot, previous)

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}]
        )

        stop = getattr(response, "stop_reason", None)
        usage = getattr(response, "usage", None)
        log.info(
            "narrator response: stop_reason=%s output_tokens=%s thinking_tokens=%s",
            stop,
            getattr(usage, "output_tokens", None),
            getattr(getattr(usage, "output_tokens_details", None), "thinking_tokens", None),
        )
        if stop == "max_tokens":
            raise ValueError(
                f"response stopped at max_tokens={max_tokens} before the report JSON "
                "finished (thinking counts toward the cap); raise ai.max_tokens in config.yaml"
            )

        text = _first_text(response).strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            lines = text.split("\n")
            # Remove first and last fence lines
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        # Parse JSON response
        narratives = json.loads(text)
        narratives["ai_generated"] = True
        narratives["model"] = model
        narratives["generated_at"] = datetime.now().isoformat()
        return narratives

    except (json.JSONDecodeError, Exception) as e:
        return _degrade_or_raise(
            snapshot, f"Claude API call failed: {e}", strict, extra={"ai_error": str(e)}
        )


def _fallback_narratives(snapshot: dict) -> dict:
    """Template-based fallback when AI is unavailable."""
    git = snapshot.get("git", {})
    totals = git.get("totals", {})
    system = snapshot.get("system", {})

    week_commits = totals.get("week_commits", 0)
    total_commits = totals.get("total_commits", 0)
    hooks = system.get("hooks", 0)
    skills = system.get("skills", 0)
    agents = system.get("agents", 0)

    return {
        "executive_summary": (
            f"The AI Enablement platform continues to mature with {week_commits} capability "
            f"iterations this week, bringing total platform capabilities to {total_commits}+. "
            f"Teams now have access to {skills}+ AI workflows, {agents}+ specialized assistants, "
            f"and {hooks}+ automated safeguards ensuring quality and compliance."
        ),
        "capabilities_shipped": [
            "Platform reliability improvements across active projects",
            f"{hooks}+ automated safeguards protecting code quality and security",
            f"{skills}+ reusable AI workflows available to teams",
        ],
        "business_impact": {
            "time_saved": "AI workflows continue to reduce manual development overhead",
            "risk_reduction": f"{hooks}+ automated safeguards enforce quality standards",
            "adoption": "3 teams actively using AI-powered tools",
        },
        "this_week_highlights": [
            f"Platform expanded with {week_commits} capability iterations this week",
            f"{agents}+ specialized assistants handling development, testing, and review tasks",
            "All systems operational with continuous improvement pace maintained",
        ],
        "strategic_progress": "Steady progress toward full platform maturity and broader team adoption.",
        "per_project": {},
        "outlook": "Continued focus on expanding team-facing capabilities and enterprise integration readiness.",
        "ai_generated": False,
        "generated_at": datetime.now().isoformat(),
    }


if __name__ == "__main__":
    import yaml

    config_path = Path(__file__).parent.parent / "config.yaml"
    with open(config_path) as f:
        config = yaml.safe_load(f)

    # Load latest snapshot
    snapshots_dir = Path(__file__).parent.parent / "data" / "snapshots"
    snapshots = sorted(snapshots_dir.glob("*.json"), reverse=True)
    if snapshots:
        with open(snapshots[0]) as f:
            snapshot = json.load(f)
        try:
            result = generate_narratives(snapshot, config, strict=True)
            print(json.dumps(result, indent=2))
        except NarrativeGenerationError as e:
            print(f"NarrativeGenerationError: {e}")
            print(
                "Set ANTHROPIC_API_KEY, or call generate_narratives(..., strict=False) "
                "for template output."
            )
    else:
        print("No snapshots found. Run weekly_run.py --collect-only first.")
