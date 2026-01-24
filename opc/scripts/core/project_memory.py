#!/usr/bin/env python3
"""Project-scoped memory with local-first index and global DB fallback.

Local-first architecture:
- .claude/memory/index.json: Summary tree (always loaded at session start)
- .claude/memory/handoffs/{session-uuid8}/{task}.json: Full indexed content

Query flow:
1. Local topic_index keyword match (<10ms)
2. Local vector search if no keyword match
3. Global DB fallback (scope=GLOBAL) for cross-project learnings

Usage:
    # Initialize project memory
    uv run python project_memory.py init --project-dir .

    # Update index with a handoff
    uv run python project_memory.py update --project-dir . --handoff path/to/handoff.yaml

    # Query memory (local-first, global fallback)
    uv run python project_memory.py query "authentication" --project-dir . --k 5

    # List indexed sessions
    uv run python project_memory.py list --project-dir .
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

import yaml
from dotenv import load_dotenv

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()


def get_project_id(project_dir: str) -> str:
    """Generate stable project ID from absolute path."""
    abs_path = str(Path(project_dir).resolve())
    return hashlib.sha256(abs_path.encode()).hexdigest()[:16]


def get_memory_dir(project_dir: str) -> Path:
    """Get .claude/memory directory for a project."""
    return Path(project_dir) / ".claude" / "memory"


def get_index_path(project_dir: str) -> Path:
    """Get path to index.json."""
    return get_memory_dir(project_dir) / "index.json"


def init_project_index(project_dir: str) -> dict:
    """Create or load project memory index."""
    memory_dir = get_memory_dir(project_dir)
    index_path = get_index_path(project_dir)

    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "handoffs").mkdir(exist_ok=True)

    if index_path.exists():
        with open(index_path) as f:
            return json.load(f)

    index = {
        "version": "1.0",
        "project_id": get_project_id(project_dir),
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "sessions": {},
        "topic_index": {}
    }

    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)

    return index


def load_index(project_dir: str) -> dict | None:
    """Load existing index or return None. Handles corrupted files gracefully."""
    index_path = get_index_path(project_dir)
    if not index_path.exists():
        return None
    try:
        with open(index_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return None


def save_index(project_dir: str, index: dict) -> None:
    """Save index to disk atomically to prevent corruption."""
    index_path = get_index_path(project_dir)
    index["last_updated"] = datetime.now(timezone.utc).isoformat()

    temp_path = index_path.with_suffix(".tmp")
    try:
        with open(temp_path, "w") as f:
            json.dump(index, f, indent=2)
        temp_path.replace(index_path)
    except Exception:
        if temp_path.exists():
            temp_path.unlink()
        raise


def parse_handoff(handoff_path: str) -> dict | None:
    """Parse YAML or MD handoff file. Handles binary/corrupted files gracefully."""
    path = Path(handoff_path)
    if not path.exists():
        return None

    try:
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None

    if path.suffix in (".yaml", ".yml"):
        try:
            data = yaml.safe_load(content)
            if data is None or not isinstance(data, dict):
                return None
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
            data["goal"] = content[goal_match+7:end if end != -1 else None].strip()[:200]

        now_match = content.find("### Now")
        if now_match != -1:
            end = content.find("\n## ", now_match + 7)
            data["now"] = content[now_match+7:end if end != -1 else None].strip()[:200]

        data["session"] = path.parent.name
        data["outcome"] = "UNKNOWN"
        return data

    return None


def extract_topics(handoff: dict) -> list[str]:
    """Extract searchable topics from handoff content."""
    topics = set()

    text_fields = [
        handoff.get("goal", ""),
        handoff.get("now", ""),
        " ".join(str(t.get("task", "")) for t in handoff.get("done_this_session", []) if isinstance(t, dict)),
        " ".join(str(d) for d in handoff.get("decisions", {}).values() if isinstance(d, str)),
    ]

    combined = " ".join(text_fields).lower()

    topic_keywords = [
        "authentication", "auth", "login", "oauth", "jwt",
        "database", "sql", "postgres", "migration", "schema",
        "api", "rest", "graphql", "endpoint",
        "testing", "test", "jest", "pytest", "unit", "integration",
        "deployment", "deploy", "ci", "cd", "docker", "kubernetes",
        "performance", "optimization", "cache", "caching",
        "security", "validation", "sanitization",
        "ui", "frontend", "react", "component", "styling",
        "backend", "server", "node", "express",
        "hook", "hooks", "skill", "skills", "mcp",
        "memory", "recall", "learning", "embedding",
        "windows", "linux", "macos", "platform",
        "error", "debug", "fix", "bug",
        "refactor", "cleanup", "architecture"
    ]

    for kw in topic_keywords:
        if kw in combined:
            topics.add(kw)

    return list(topics)


def _acquire_lock(lock_path: Path, timeout: float = 5.0) -> bool:
    """Acquire a file-based lock with timeout."""
    import time
    start = time.time()
    while time.time() - start < timeout:
        try:
            lock_path.touch(exist_ok=False)
            return True
        except FileExistsError:
            time.sleep(0.05)
    return False


def _release_lock(lock_path: Path) -> None:
    """Release a file-based lock."""
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


def update_index(project_dir: str, handoff_path: str) -> dict | None:
    """Add or update handoff in index. Thread-safe via file locking."""
    handoff = parse_handoff(handoff_path)
    if not handoff:
        return None

    memory_dir = get_memory_dir(project_dir)
    memory_dir.mkdir(parents=True, exist_ok=True)
    lock_path = memory_dir / "index.lock"

    if not _acquire_lock(lock_path):
        return None

    try:
        index = load_index(project_dir) or init_project_index(project_dir)

        session_name = handoff.get("session", "unknown")
        path = Path(handoff_path)
        task_id = path.stem

        session_uuid = f"{session_name}-{hashlib.md5(path.parent.name.encode()).hexdigest()[:8]}"

        task_entry = {
            "id": task_id,
            "summary": (handoff.get("goal", "") or handoff.get("now", ""))[:150],
            "outcome": handoff.get("outcome", "UNKNOWN"),
            "key_decisions": list(handoff.get("decisions", {}).keys())[:5],
            "key_files": [],
            "indexed_at": datetime.now(timezone.utc).isoformat()
        }

        files = handoff.get("files", {})
        if isinstance(files, dict):
            task_entry["key_files"] = (
                files.get("created", [])[:3] +
                files.get("modified", [])[:3]
            )

        if session_uuid not in index["sessions"]:
            index["sessions"][session_uuid] = {
                "name": session_name,
                "tasks": []
            }

        tasks = index["sessions"][session_uuid]["tasks"]
        existing_idx = next((i for i, t in enumerate(tasks) if t["id"] == task_id), None)
        if existing_idx is not None:
            tasks[existing_idx] = task_entry
        else:
            tasks.append(task_entry)

        topics = extract_topics(handoff)
        task_ref = f"{session_uuid}/{task_id}"
        for topic in topics:
            if topic not in index["topic_index"]:
                index["topic_index"][topic] = []
            if task_ref not in index["topic_index"][topic]:
                index["topic_index"][topic].append(task_ref)

        save_index(project_dir, index)
        return task_entry
    finally:
        _release_lock(lock_path)


def search_local_topics(project_dir: str, query: str, k: int = 5) -> list[dict]:
    """Fast keyword search in topic_index (<10ms)."""
    index = load_index(project_dir)
    if not index:
        return []

    query_lower = query.lower()
    query_words = query_lower.split()

    matches = []
    for topic, refs in index["topic_index"].items():
        if any(word in topic or topic in word for word in query_words):
            for ref in refs:
                session_uuid, task_id = ref.split("/", 1)
                if session_uuid in index["sessions"]:
                    session = index["sessions"][session_uuid]
                    task = next((t for t in session["tasks"] if t["id"] == task_id), None)
                    if task:
                        matches.append({
                            "session": session["name"],
                            "task_id": task_id,
                            "summary": task.get("summary", ""),
                            "outcome": task.get("outcome", "UNKNOWN"),
                            "topic_match": topic,
                            "source": "local_topic"
                        })

    seen = set()
    unique = []
    for m in matches:
        key = f"{m['session']}/{m['task_id']}"
        if key not in seen:
            seen.add(key)
            unique.append(m)

    return unique[:k]


async def search_local_vector(project_dir: str, query: str, k: int = 5) -> list[dict]:
    """Vector search in local handoff embeddings."""
    try:
        from db.embedding_service import EmbeddingService
    except ImportError:
        return []

    memory_dir = get_memory_dir(project_dir)
    handoffs_dir = memory_dir / "handoffs"

    if not handoffs_dir.exists():
        return []

    embedder = EmbeddingService(provider="local")
    query_embedding = await embedder.embed(query)

    results = []
    for session_dir in handoffs_dir.iterdir():
        if not session_dir.is_dir():
            continue
        for task_file in session_dir.glob("*.json"):
            try:
                with open(task_file) as f:
                    data = json.load(f)
                if "embedding" not in data:
                    continue

                similarity = cosine_similarity(query_embedding, data["embedding"])
                results.append({
                    "session": session_dir.name,
                    "task_id": task_file.stem,
                    "summary": data.get("summary", ""),
                    "content": data.get("content", "")[:300],
                    "similarity": similarity,
                    "source": "local_vector"
                })
            except (json.JSONDecodeError, KeyError):
                continue

    results.sort(key=lambda x: x["similarity"], reverse=True)
    return results[:k]


async def search_global(query: str, k: int = 5) -> list[dict]:
    """Search global learnings (scope=GLOBAL) in PostgreSQL."""
    try:
        from db.memory_factory import create_memory_service
        from db.embedding_service import EmbeddingService
    except ImportError:
        return []

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("CONTINUOUS_CLAUDE_DB_URL")
    if not db_url:
        return []

    try:
        embedder = EmbeddingService(provider="local")
        query_embedding = await embedder.embed(query)

        memory = await create_memory_service(backend="postgres", session_id="global-search")

        results = await memory.search_vector(
            query_embedding,
            limit=k,
            filters={"scope": "GLOBAL"}
        )

        await memory.close()

        return [{
            "id": str(r.get("id", ""))[:8],
            "content": r.get("content", "")[:300],
            "similarity": r.get("similarity", 0),
            "source": "global_db",
            "type": r.get("metadata", {}).get("learning_type", "UNKNOWN")
        } for r in results]
    except Exception as e:
        return []


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    import math
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


async def search(project_dir: str, query: str, k: int = 5) -> dict:
    """Search with local-first, global fallback strategy."""
    local_topic = search_local_topics(project_dir, query, k)

    if local_topic:
        return {
            "query": query,
            "results": local_topic,
            "source": "local_topic",
            "count": len(local_topic)
        }

    local_vector = await search_local_vector(project_dir, query, k)

    if local_vector:
        return {
            "query": query,
            "results": local_vector,
            "source": "local_vector",
            "count": len(local_vector)
        }

    global_results = await search_global(query, k)

    return {
        "query": query,
        "results": global_results,
        "source": "global_db" if global_results else "none",
        "count": len(global_results)
    }


def list_sessions(project_dir: str) -> list[dict]:
    """List all indexed sessions."""
    index = load_index(project_dir)
    if not index:
        return []

    sessions = []
    for session_uuid, data in index["sessions"].items():
        sessions.append({
            "uuid": session_uuid,
            "name": data["name"],
            "task_count": len(data["tasks"]),
            "tasks": [t["id"] for t in data["tasks"]]
        })

    return sessions


async def main():
    parser = argparse.ArgumentParser(description="Project-scoped memory management")
    parser.add_argument("command", choices=["init", "update", "query", "list"])
    parser.add_argument("--project-dir", default=".", help="Project directory")
    parser.add_argument("--handoff", help="Path to handoff file (for update)")
    parser.add_argument("query_text", nargs="?", help="Search query (for query command)")
    parser.add_argument("-k", type=int, default=5, help="Number of results")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command == "init":
        index = init_project_index(args.project_dir)
        if args.json:
            print(json.dumps({"success": True, "project_id": index["project_id"]}))
        else:
            print(f"Initialized project memory: {index['project_id']}")

    elif args.command == "update":
        if not args.handoff:
            print("Error: --handoff required for update", file=sys.stderr)
            sys.exit(1)
        result = update_index(args.project_dir, args.handoff)
        if result:
            if args.json:
                print(json.dumps({"success": True, "task": result}))
            else:
                print(f"Indexed: {result['id']} - {result['summary'][:50]}")
        else:
            print("Failed to parse handoff", file=sys.stderr)
            sys.exit(1)

    elif args.command == "query":
        if not args.query_text:
            print("Error: query text required", file=sys.stderr)
            sys.exit(1)
        results = await search(args.project_dir, args.query_text, args.k)
        if args.json:
            print(json.dumps(results))
        else:
            print(f"Query: {results['query']} | Source: {results['source']} | Count: {results['count']}")
            for r in results["results"]:
                summary = r.get("summary", r.get("content", ""))[:80]
                print(f"  - {r.get('session', r.get('id', '?'))}: {summary}")

    elif args.command == "list":
        sessions = list_sessions(args.project_dir)
        if args.json:
            print(json.dumps(sessions))
        else:
            for s in sessions:
                print(f"{s['name']} ({s['task_count']} tasks): {', '.join(s['tasks'][:3])}")


if __name__ == "__main__":
    asyncio.run(main())
