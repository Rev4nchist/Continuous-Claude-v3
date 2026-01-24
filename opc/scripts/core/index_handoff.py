#!/usr/bin/env python3
"""Background handoff indexer for project-scoped memory.

Spawned by handoff-index hook after Write to handoff files.
Generates embeddings and stores in local .claude/memory/handoffs/.

Usage (typically called by hook, not directly):
    uv run python index_handoff.py --handoff path/to/handoff.yaml --project-dir .
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

import yaml
from dotenv import load_dotenv

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def parse_handoff(handoff_path: str) -> dict | None:
    """Parse YAML or MD handoff file."""
    path = Path(handoff_path)
    if not path.exists():
        return None

    content = path.read_text(encoding="utf-8")

    if path.suffix in (".yaml", ".yml"):
        try:
            data = yaml.safe_load(content)
            return {
                "session": data.get("session", path.parent.name),
                "goal": data.get("goal", ""),
                "now": data.get("now", ""),
                "outcome": data.get("status", data.get("outcome", "UNKNOWN")),
                "done_this_session": data.get("done_this_session", []),
                "decisions": data.get("decisions", {}),
                "findings": data.get("findings", {}),
                "worked": data.get("worked", []),
                "failed": data.get("failed", []),
                "next": data.get("next", []),
                "files": data.get("files", {}),
                "raw_content": content
            }
        except yaml.YAMLError:
            return None

    if path.suffix == ".md":
        data = {"raw_content": content}
        goal_match = content.find("## Goal")
        if goal_match != -1:
            end = content.find("\n## ", goal_match + 7)
            data["goal"] = content[goal_match+7:end if end != -1 else None].strip()[:500]

        now_match = content.find("### Now")
        if now_match != -1:
            end = content.find("\n## ", now_match + 7)
            data["now"] = content[now_match+7:end if end != -1 else None].strip()[:500]

        data["session"] = path.parent.name
        data["outcome"] = "UNKNOWN"
        return data

    return None


def build_embedding_text(handoff: dict) -> str:
    """Build text for embedding from handoff content."""
    parts = []

    if handoff.get("goal"):
        parts.append(f"Goal: {handoff['goal']}")
    if handoff.get("now"):
        parts.append(f"Current focus: {handoff['now']}")

    for task in handoff.get("done_this_session", [])[:5]:
        if isinstance(task, dict):
            parts.append(f"Completed: {task.get('task', '')}")

    for key, value in list(handoff.get("decisions", {}).items())[:5]:
        if isinstance(value, str):
            parts.append(f"Decision ({key}): {value}")

    for item in handoff.get("worked", [])[:3]:
        parts.append(f"Worked: {item}")

    for item in handoff.get("failed", [])[:3]:
        parts.append(f"Failed: {item}")

    return "\n".join(parts)


async def index_handoff(handoff_path: str, project_dir: str) -> dict:
    """Index a handoff file with embedding."""
    try:
        from db.embedding_service import EmbeddingService
    except ImportError as e:
        return {"success": False, "error": f"Embedding service not available: {e}"}

    handoff = parse_handoff(handoff_path)
    if not handoff:
        return {"success": False, "error": "Failed to parse handoff"}

    embedding_text = build_embedding_text(handoff)
    if not embedding_text.strip():
        return {"success": False, "error": "No content to embed"}

    embedder = EmbeddingService(provider="local")
    embedding = await embedder.embed(embedding_text)

    memory_dir = Path(project_dir) / ".claude" / "memory" / "handoffs"
    path = Path(handoff_path)
    session_name = handoff.get("session", path.parent.name)
    session_uuid = f"{session_name}-{hashlib.md5(path.parent.name.encode()).hexdigest()[:8]}"

    session_dir = memory_dir / session_uuid
    session_dir.mkdir(parents=True, exist_ok=True)

    task_id = path.stem
    output_path = session_dir / f"{task_id}.json"

    output_data = {
        "task_id": task_id,
        "session": session_name,
        "summary": (handoff.get("goal", "") or handoff.get("now", ""))[:200],
        "outcome": handoff.get("outcome", "UNKNOWN"),
        "embedding_text": embedding_text[:1000],
        "embedding": embedding,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "source_path": str(path.resolve()),
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    return {
        "success": True,
        "output_path": str(output_path),
        "embedding_dim": len(embedding),
        "session": session_name,
        "task_id": task_id,
    }


async def main():
    parser = argparse.ArgumentParser(description="Index handoff file with embedding")
    parser.add_argument("--handoff", required=True, help="Path to handoff file")
    parser.add_argument("--project-dir", default=".", help="Project directory")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    result = await index_handoff(args.handoff, args.project_dir)

    if args.json:
        print(json.dumps(result))
    else:
        if result["success"]:
            print(f"Indexed: {result['session']}/{result['task_id']}")
            print(f"  Output: {result['output_path']}")
        else:
            print(f"Failed: {result.get('error', 'unknown')}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
