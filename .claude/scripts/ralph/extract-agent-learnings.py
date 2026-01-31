#!/usr/bin/env python3
"""Extract learnings from agent output and store in memory.

Parses agent-output.json after task completion and stores ONE learning per task.
Task-level granularity ensures clean signal without noise.

Usage:
    uv run python extract-agent-learnings.py \
        --output-file /workspace/.ralph/agent-output.json \
        --story-id STORY-001 \
        --task-description "Implement auth middleware" \
        --project-dir /path/to/project

Design Decision:
    Task-level only (not real-time). One clear signal per task completion.
    - Success → WORKING_SOLUTION
    - Failure → FAILED_APPROACH

Learning Content:
    For success: What worked, files modified, key insight
    For failure: What failed, error details, what to avoid
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

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


def format_success_learning(output: dict, task_description: str) -> str:
    """Format learning content for successful task."""
    files = output.get("files_modified", [])
    approach = output.get("approach_summary", "Standard implementation")
    insight = output.get("key_insight", "Completed successfully")
    task_type = output.get("task_type", "implement")
    verification = output.get("verification", {})
    learnings_applied = output.get("learnings_applied", [])

    lines = [
        f"Task completed: {task_description}",
        "",
        "What worked:",
        f"- Task type: {task_type}",
        f"- Files modified: {', '.join(files) if files else 'None'}",
        f"- Approach: {approach}",
    ]

    if verification:
        tests = verification.get("tests_passed")
        types = verification.get("typecheck_passed")
        lint = verification.get("lint_passed")
        if tests is not None:
            lines.append(f"- Tests: {'passed' if tests else 'failed'}")
        if types is not None:
            lines.append(f"- Type check: {'passed' if types else 'failed'}")
        if lint is not None:
            lines.append(f"- Lint: {'passed' if lint else 'failed'}")

    if learnings_applied:
        lines.append("")
        lines.append("Applied from past learnings:")
        for applied in learnings_applied:
            lines.append(f"- {applied}")

    lines.extend([
        "",
        f"Key insight: {insight}",
    ])

    return "\n".join(lines)


def format_failure_learning(output: dict, task_description: str) -> str:
    """Format learning content for failed task."""
    files = output.get("files_modified", [])
    error = output.get("error_message", "Unknown error")
    stage = output.get("failure_stage", "unknown")
    avoid = output.get("avoid_next_time", error)
    task_type = output.get("task_type", "implement")

    lines = [
        f"Task failed: {task_description}",
        "",
        "What went wrong:",
        f"- Task type: {task_type}",
        f"- Error: {error}",
        f"- Files attempted: {', '.join(files) if files else 'None'}",
        f"- Stage: {stage}",
        "",
        f"Avoid: {avoid}",
    ]

    return "\n".join(lines)


def generate_tags(output: dict, task_description: str) -> list[str]:
    """Generate tags for the learning."""
    tags = ["ralph"]

    task_type = output.get("task_type", "implement")
    tags.append(task_type)

    status = output.get("status", "unknown")
    tags.append(f"task-{status}")

    desc_lower = task_description.lower()
    if "auth" in desc_lower:
        tags.append("auth")
    if "api" in desc_lower:
        tags.append("api")
    if "database" in desc_lower or "db" in desc_lower:
        tags.append("database")
    if "test" in desc_lower:
        tags.append("testing")
    if "ui" in desc_lower or "component" in desc_lower:
        tags.append("ui")

    return tags


async def store_learning_async(
    session_id: str,
    learning_type: str,
    content: str,
    context: str,
    tags: list[str],
    confidence: str,
    project_dir: str | None,
) -> dict:
    """Store learning using the store_learning script."""
    try:
        from core.store_learning import store_learning_v2
        return await store_learning_v2(
            session_id=session_id,
            content=content,
            learning_type=learning_type,
            context=context,
            tags=tags,
            confidence=confidence,
            project_dir=project_dir,
        )
    except ImportError:
        # Fallback: run as subprocess
        cmd = [
            "uv", "run", "python",
            str(Path(__file__).parent.parent / "core" / "store_learning.py"),
            "--session-id", session_id,
            "--type", learning_type,
            "--content", content,
            "--context", context,
            "--tags", ",".join(tags),
            "--confidence", confidence,
            "--json",
        ]
        if project_dir:
            cmd.extend(["--project-dir", project_dir])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent.parent),
        )

        if result.returncode == 0:
            return json.loads(result.stdout)
        else:
            return {
                "success": False,
                "error": result.stderr or "Unknown error",
            }


async def extract_and_store(
    output_file: str,
    story_id: str,
    task_description: str,
    project_dir: str | None = None,
) -> dict:
    """Extract learning from agent output and store in memory.

    Args:
        output_file: Path to agent-output.json
        story_id: Story ID for session tracking
        task_description: Original task description
        project_dir: Project directory for scoping

    Returns:
        dict with storage result
    """
    output_path = Path(output_file)

    if not output_path.exists():
        return {
            "success": False,
            "error": f"Output file not found: {output_file}",
        }

    try:
        output = json.loads(output_path.read_text())
    except json.JSONDecodeError as e:
        return {
            "success": False,
            "error": f"Invalid JSON in output file: {e}",
        }

    status = output.get("status", "unknown")
    session_id = f"ralph-{story_id}"

    if status == "success":
        content = format_success_learning(output, task_description)
        learning_type = "WORKING_SOLUTION"
        confidence = "high"
    elif status == "failure":
        content = format_failure_learning(output, task_description)
        learning_type = "FAILED_APPROACH"
        confidence = "high"
    elif status == "blocked":
        # Don't store learning for blocked tasks (not enough signal)
        return {
            "success": True,
            "skipped": True,
            "reason": "Blocked tasks don't generate learnings",
        }
    else:
        return {
            "success": False,
            "error": f"Unknown status: {status}",
        }

    tags = generate_tags(output, task_description)

    result = await store_learning_async(
        session_id=session_id,
        learning_type=learning_type,
        content=content,
        context=task_description,
        tags=tags,
        confidence=confidence,
        project_dir=project_dir,
    )

    # Enhance result with extraction metadata
    result["status"] = status
    result["task_description"] = task_description
    result["learning_type"] = learning_type
    result["content_preview"] = content[:200] + "..." if len(content) > 200 else content

    return result


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract learnings from agent output and store in memory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--output-file",
        required=True,
        help="Path to agent-output.json",
    )
    parser.add_argument(
        "--story-id",
        required=True,
        help="Story ID for session tracking",
    )
    parser.add_argument(
        "--task-description",
        required=True,
        help="Original task description",
    )
    parser.add_argument(
        "--project-dir",
        default=os.environ.get("CLAUDE_PROJECT_DIR"),
        help="Project directory for scoping",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON",
    )

    args = parser.parse_args()

    try:
        result = await extract_and_store(
            output_file=args.output_file,
            story_id=args.story_id,
            task_description=args.task_description,
            project_dir=args.project_dir,
        )

        if args.json:
            print(json.dumps(result))
        else:
            if result.get("skipped"):
                print(f"~ Learning skipped: {result.get('reason')}")
            elif result.get("success"):
                print(f"✓ Learning stored ({result.get('learning_type')})")
                print(f"  Status: {result.get('status')}")
                print(f"  Memory ID: {result.get('memory_id', 'unknown')}")
                if result.get("scope"):
                    print(f"  Scope: {result.get('scope')}")
            else:
                print(f"✗ Failed: {result.get('error')}")

        return 0 if result.get("success") else 1

    except Exception as e:
        if args.json:
            print(json.dumps({"success": False, "error": str(e)}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
