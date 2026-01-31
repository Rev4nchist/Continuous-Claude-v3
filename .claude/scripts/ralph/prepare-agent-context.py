#!/usr/bin/env python3
"""Prepare context directory for Docker-isolated agents.

Generates context directory with:
- learnings.md: Relevant past learnings from memory
- knowledge-tree.json: Project structure
- task.md: Full task prompt with context
- meta.json: Task metadata for extraction

Usage:
    uv run python prepare-agent-context.py \
        --task-description "Implement authentication middleware" \
        --project-dir /path/to/project \
        --story-id STORY-001 \
        --output-dir /tmp/ralph-context/task-123

Memory Query Strategy:
    1. Similar task patterns (task type + implementation)
    2. Error patterns to avoid (failures with similar keywords)
    3. Codebase-specific patterns (project-scoped)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Load environment
global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

# Add scripts to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def get_project_id(project_dir: str) -> str:
    """Generate stable project ID from path."""
    abs_path = str(Path(project_dir).resolve())
    return hashlib.sha256(abs_path.encode()).hexdigest()[:16]


def get_project_name(project_dir: str) -> str:
    """Extract project name from path."""
    return Path(project_dir).resolve().name


def extract_task_keywords(description: str) -> list[str]:
    """Extract keywords from task description for memory queries."""
    stopwords = {
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had", "do", "does", "did", "will",
        "would", "could", "should", "may", "might", "must", "shall",
        "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above",
        "below", "between", "under", "again", "further", "then", "once",
        "and", "but", "or", "nor", "so", "yet", "both", "either",
        "neither", "not", "only", "own", "same", "than", "too", "very",
        "just", "also", "now", "here", "there", "when", "where", "why",
        "how", "all", "each", "few", "more", "most", "other", "some",
        "such", "no", "any", "this", "that", "these", "those", "it",
    }

    words = description.lower().split()
    keywords = [w.strip(".,;:!?()[]{}\"'") for w in words if len(w) > 2]
    keywords = [w for w in keywords if w not in stopwords and w.isalnum()]
    return keywords[:10]


def classify_task_type(description: str) -> str:
    """Classify task type from description."""
    desc_lower = description.lower()

    if any(w in desc_lower for w in ["test", "spec", "assert", "expect", "mock"]):
        return "test"
    if any(w in desc_lower for w in ["fix", "bug", "error", "issue", "broken"]):
        return "fix"
    if any(w in desc_lower for w in ["refactor", "clean", "reorganize", "restructure"]):
        return "refactor"
    if any(w in desc_lower for w in ["add", "create", "implement", "build", "new"]):
        return "implement"
    if any(w in desc_lower for w in ["update", "modify", "change", "enhance"]):
        return "update"
    if any(w in desc_lower for w in ["delete", "remove", "drop"]):
        return "delete"
    if any(w in desc_lower for w in ["debug", "investigate", "diagnose"]):
        return "debug"

    return "implement"


async def query_memory(
    query: str,
    k: int = 5,
    text_only: bool = True
) -> list[dict[str, Any]]:
    """Query memory for relevant learnings."""
    try:
        if text_only:
            from core.recall_learnings import search_learnings_text_only_postgres
            return await search_learnings_text_only_postgres(query, k)
        else:
            from core.recall_learnings import search_learnings_hybrid_rrf
            return await search_learnings_hybrid_rrf(query, k)
    except ImportError:
        # Fallback: run as subprocess
        import subprocess
        result = subprocess.run(
            [
                "uv", "run", "python",
                str(Path(__file__).parent.parent / "core" / "recall_learnings.py"),
                "--query", query,
                "--k", str(k),
                "--json",
            ] + (["--text-only"] if text_only else []),
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent.parent),
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return data.get("results", [])
        return []
    except Exception:
        return []


def format_learnings_md(
    task_description: str,
    working_solutions: list[dict],
    failed_approaches: list[dict],
    codebase_patterns: list[dict],
) -> str:
    """Format learnings as human-readable markdown."""
    lines = [
        f"# Relevant Learnings for: {task_description}",
        "",
        f"*Recalled at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}*",
        "",
    ]

    if working_solutions:
        lines.extend([
            "## What Worked Before",
            "",
        ])
        for i, learning in enumerate(working_solutions, 1):
            similarity = learning.get("similarity", learning.get("score", 0))
            created = learning.get("created_at", "")
            if isinstance(created, datetime):
                created_str = created.strftime("%Y-%m-%d")
            else:
                created_str = str(created)[:10]

            metadata = learning.get("metadata", {})
            learning_type = metadata.get("learning_type", "WORKING_SOLUTION")
            context = metadata.get("context", "")

            lines.extend([
                f"### {i}. [{learning_type}]",
                f"**Similarity:** {similarity:.2f} | **When:** {created_str}",
            ])
            if context:
                lines.append(f"**Context:** {context}")
            lines.extend([
                "",
                learning.get("content", ""),
                "",
                "---",
                "",
            ])

    if failed_approaches:
        lines.extend([
            "## What To Avoid",
            "",
        ])
        for i, learning in enumerate(failed_approaches, 1):
            similarity = learning.get("similarity", learning.get("score", 0))
            created = learning.get("created_at", "")
            if isinstance(created, datetime):
                created_str = created.strftime("%Y-%m-%d")
            else:
                created_str = str(created)[:10]

            metadata = learning.get("metadata", {})
            context = metadata.get("context", "")

            lines.extend([
                f"### {i}. [FAILED_APPROACH]",
                f"**Similarity:** {similarity:.2f} | **When:** {created_str}",
            ])
            if context:
                lines.append(f"**Context:** {context}")
            lines.extend([
                "",
                learning.get("content", ""),
                "",
                "---",
                "",
            ])

    if codebase_patterns:
        lines.extend([
            "## Codebase Patterns",
            "",
        ])
        for i, learning in enumerate(codebase_patterns, 1):
            metadata = learning.get("metadata", {})
            tags = metadata.get("tags", [])

            lines.extend([
                f"### {i}. [CODEBASE_PATTERN]",
            ])
            if tags:
                lines.append(f"**Tags:** {', '.join(tags)}")
            lines.extend([
                "",
                learning.get("content", ""),
                "",
                "---",
                "",
            ])

    if not (working_solutions or failed_approaches or codebase_patterns):
        lines.extend([
            "## No Relevant Learnings Found",
            "",
            "This appears to be a new type of task. Document learnings after completion!",
            "",
        ])

    return "\n".join(lines)


def load_knowledge_tree(project_dir: str) -> dict | None:
    """Load knowledge tree from project."""
    kt_paths = [
        Path(project_dir) / ".claude" / "knowledge-tree.json",
        Path(project_dir) / "knowledge-tree.json",
    ]

    for kt_path in kt_paths:
        if kt_path.exists():
            try:
                return json.loads(kt_path.read_text())
            except json.JSONDecodeError:
                continue

    return None


def create_task_md(
    task_description: str,
    story_id: str,
    iteration: int,
    max_iterations: int,
    project_name: str,
) -> str:
    """Create the task.md file content."""
    return f"""# Agent Task: {task_description}

**Story:** {story_id}
**Iteration:** {iteration} / {max_iterations}
**Project:** {project_name}

---

## CRITICAL: Read Context First

Before implementing, you MUST read:
1. `/context/learnings.md` - Past patterns that worked/failed
2. `/context/knowledge-tree.json` - Project structure (if available)

These contain wisdom from previous sessions. **Apply patterns that worked. Avoid patterns that failed.**

---

## Task Details

{task_description}

---

## Output Requirements

After completing work, write results to `/workspace/.ralph/agent-output.json`:

```json
{{
  "status": "success" | "failure" | "blocked",
  "task_description": "{task_description}",
  "task_type": "implement" | "test" | "refactor" | "fix",
  "files_modified": ["path1", "path2"],
  "commit_hash": "abc123" | null,
  "approach_summary": "Brief description of approach taken",
  "key_insight": "One key thing that made this work (or would have)",
  "error_message": null | "description if failed",
  "failure_stage": null | "planning" | "implementation" | "testing",
  "avoid_next_time": null | "What to avoid if this failed",
  "verification": {{
    "tests_passed": true | false,
    "typecheck_passed": true | false,
    "lint_passed": true | false
  }}
}}
```

**Note:** Task-level learning only. One learning per task stored automatically based on this output.

---

## Remember

- Fresh context = no accumulated errors
- Apply past learnings proactively
- Document what you learn for future agents
"""


async def prepare_context(
    task_description: str,
    project_dir: str,
    story_id: str,
    output_dir: str,
    iteration: int = 1,
    max_iterations: int = 30,
) -> dict[str, Any]:
    """Prepare the context directory for an agent.

    Returns:
        dict with status and paths to generated files
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    project_name = get_project_name(project_dir)
    project_id = get_project_id(project_dir)
    task_type = classify_task_type(task_description)
    keywords = extract_task_keywords(task_description)

    # Query memory for similar tasks
    query1 = f"{task_type} {' '.join(keywords[:5])}"
    results1 = await query_memory(query1, k=5, text_only=True)

    # Query for failures to avoid
    query2 = f"{task_type} errors failures"
    results2 = await query_memory(query2, k=3, text_only=True)

    # Query for project-specific patterns
    query3 = f"{project_name} patterns conventions"
    results3 = await query_memory(query3, k=3, text_only=True)

    # Categorize results
    working_solutions = []
    failed_approaches = []
    codebase_patterns = []

    for result in results1:
        metadata = result.get("metadata", {})
        learning_type = metadata.get("learning_type", "")
        if learning_type == "FAILED_APPROACH":
            failed_approaches.append(result)
        else:
            working_solutions.append(result)

    for result in results2:
        metadata = result.get("metadata", {})
        learning_type = metadata.get("learning_type", "")
        if learning_type == "FAILED_APPROACH" and result not in failed_approaches:
            failed_approaches.append(result)

    for result in results3:
        metadata = result.get("metadata", {})
        learning_type = metadata.get("learning_type", "")
        if learning_type == "CODEBASE_PATTERN" and result not in codebase_patterns:
            codebase_patterns.append(result)

    # Generate learnings.md
    learnings_md = format_learnings_md(
        task_description,
        working_solutions[:5],
        failed_approaches[:3],
        codebase_patterns[:3],
    )
    learnings_path = output_path / "learnings.md"
    learnings_path.write_text(learnings_md, encoding="utf-8")

    # Copy or generate knowledge tree
    knowledge_tree = load_knowledge_tree(project_dir)
    kt_path = output_path / "knowledge-tree.json"
    if knowledge_tree:
        kt_path.write_text(json.dumps(knowledge_tree, indent=2), encoding="utf-8")
    else:
        kt_path.write_text(json.dumps({
            "project": project_name,
            "note": "No knowledge tree found - agent should explore codebase",
        }, indent=2), encoding="utf-8")

    # Generate task.md
    task_md = create_task_md(
        task_description,
        story_id,
        iteration,
        max_iterations,
        project_name,
    )
    task_path = output_path / "task.md"
    task_path.write_text(task_md, encoding="utf-8")

    # Generate meta.json
    meta = {
        "task_description": task_description,
        "story_id": story_id,
        "project_dir": str(Path(project_dir).resolve()),
        "project_id": project_id,
        "project_name": project_name,
        "task_type": task_type,
        "iteration": iteration,
        "max_iterations": max_iterations,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "memory_queries": {
            "similar_tasks": query1,
            "failures": query2,
            "patterns": query3,
        },
        "learnings_count": {
            "working_solutions": len(working_solutions[:5]),
            "failed_approaches": len(failed_approaches[:3]),
            "codebase_patterns": len(codebase_patterns[:3]),
        },
    }
    meta_path = output_path / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "success": True,
        "output_dir": str(output_path),
        "files": {
            "learnings": str(learnings_path),
            "knowledge_tree": str(kt_path),
            "task": str(task_path),
            "meta": str(meta_path),
        },
        "learnings_count": meta["learnings_count"],
    }


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare context directory for Docker-isolated agents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--task-description",
        required=True,
        help="What the agent should do",
    )
    parser.add_argument(
        "--project-dir",
        required=True,
        help="Project path (for knowledge tree)",
    )
    parser.add_argument(
        "--story-id",
        required=True,
        help="Story ID for tracking",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Where to write context files",
    )
    parser.add_argument(
        "--iteration",
        type=int,
        default=1,
        help="Current iteration number (default: 1)",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=30,
        help="Maximum iterations (default: 30)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON",
    )

    args = parser.parse_args()

    try:
        result = await prepare_context(
            task_description=args.task_description,
            project_dir=args.project_dir,
            story_id=args.story_id,
            output_dir=args.output_dir,
            iteration=args.iteration,
            max_iterations=args.max_iterations,
        )

        if args.json:
            print(json.dumps(result))
        else:
            print(f"Context prepared at: {result['output_dir']}")
            print(f"  Learnings: {result['learnings_count']['working_solutions']} solutions, "
                  f"{result['learnings_count']['failed_approaches']} failures, "
                  f"{result['learnings_count']['codebase_patterns']} patterns")
            print(f"  Files generated: {len(result['files'])}")

        return 0

    except Exception as e:
        if args.json:
            print(json.dumps({"success": False, "error": str(e)}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
