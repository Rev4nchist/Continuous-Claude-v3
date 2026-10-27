#!/usr/bin/env python3
"""On-demand memory extraction.

Replaces the persistent memory daemon with session-end extraction.
Learnings are extracted when:
1. Session ends (via SessionEnd hook)
2. User explicitly runs /extract-learnings
3. Session has enough content (min_turns threshold)

Usage:
    from lazy_memory import should_extract, extract_session_learnings

    if should_extract(session_id, min_turns=10):
        learnings = extract_session_learnings(session_id, project_dir)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

# Import the v2 storage entrypoint. v1 (`store_learning`) has a different
# signature (worked/failed/decisions/patterns) that does not match the
# call site below; v2 takes (session_id, content, learning_type, ...).
#
# The previous version of this file imported a non-existent `LearningType`
# symbol, which raised ImportError. The except-clause then set BOTH
# `store_learning` and `LearningType` to None, and the storage branch was
# silently skipped -- L2 (session-end) learnings never reached postgres.
# That bug is the reason this file was rewritten; do NOT reintroduce a
# silent-None ImportError swallow here.
try:
    from store_learning import store_learning_v2 as _store_learning_v2
except ImportError as e:
    # Re-raise with context so a future regression is loud, not silent.
    raise ImportError(
        f"lazy_memory cannot import store_learning_v2 from store_learning: {e}. "
        "This used to be silently swallowed -- see Phase 1 of the memory "
        "remediation plan. Fix the import path or the store_learning module."
    ) from e

# Perception change signal patterns (from extract_thinking_blocks.py)
PERCEPTION_SIGNALS = [
    r"\bactually\b",
    r"\brealized?\b",
    r"\bthe issue\b",
    r"\bthat'?s why\b",
    r"\bturns out\b",
    r"\bI was wrong\b",
    r"\bworks because\b",
    r"\bthe problem is\b",
    r"\bOh,",
    r"\bAha\b",
    r"\bnow I see\b",
    r"\bnow I understand\b",
    r"\bI see now\b",
    r"\bmisunderstood\b",
    r"\bwait,?\b",
    r"\bhmm\b",
    r"\binteresting\b",
    r"\bunexpected\b",
    r"\bsurpris",
    r"\bdifferent than\b",
    r"\bdifferent from\b",
    r"\bnot what I\b",
    r"\bwasn'?t\b.*\bexpect",
]

PERCEPTION_PATTERN = re.compile("|".join(PERCEPTION_SIGNALS), re.IGNORECASE)

# Learning extraction patterns
LEARNING_PATTERNS = {
    "WORKING_SOLUTION": [
        r"(?:this|the) (?:fix|solution) (?:was|is)",
        r"fixed (?:by|with|using)",
        r"resolved by",
        r"the answer (?:was|is)",
        r"working now",
        r"that worked",
    ],
    "ERROR_FIX": [
        r"error was caused by",
        r"the bug was",
        r"issue was that",
        r"problem was",
        r"failed because",
        r"broke because",
    ],
    "FAILED_APPROACH": [
        r"didn'?t work",
        r"failed to",
        r"won'?t work because",
        r"that approach",
        r"tried .* but",
        r"attempted .* however",
    ],
    "CODEBASE_PATTERN": [
        r"pattern (?:here|used|is)",
        r"convention (?:is|here)",
        r"this codebase",
        r"this project",
        r"the architecture",
        r"consistently uses?",
    ],
    "ARCHITECTURAL_DECISION": [
        r"decided to",
        r"chose (?:to|this)",
        r"better approach",
        r"trade-?off",
        r"design decision",
        r"architecture",
    ],
}


def find_session_jsonl(session_id: str, project_dir: str) -> Path | None:
    """Find the JSONL file for a session.

    Searches in ~/.claude/projects/ using project path conversion.

    Args:
        session_id: Session identifier
        project_dir: Project directory path

    Returns:
        Path to JSONL file, or None if not found
    """
    # Convert project path to folder name
    project_folder = project_dir.replace("\\", "-").replace("/", "-").replace(":", "-").replace(".", "-").rstrip("-")

    # Search locations
    search_dirs = [
        Path.home() / ".claude" / "projects" / project_folder,
        Path.home() / ".opc-dev" / "projects" / project_folder,
    ]

    for search_dir in search_dirs:
        if not search_dir.exists():
            continue

        # Find JSONL files, sorted by modification time (newest first)
        jsonl_files = sorted(
            search_dir.glob("*.jsonl"),
            key=lambda x: x.stat().st_mtime,
            reverse=True
        )

        # Look for matching session ID in filename
        for jsonl in jsonl_files:
            if session_id in jsonl.stem:
                return jsonl

        # Fallback: return most recent JSONL
        if jsonl_files:
            return jsonl_files[0]

    return None


def count_turns(jsonl_path: Path) -> int:
    """Count conversation turns in a JSONL file.

    Args:
        jsonl_path: Path to session JSONL

    Returns:
        Number of user+assistant message pairs
    """
    user_count = 0
    assistant_count = 0

    try:
        with open(jsonl_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                try:
                    data = json.loads(line.strip())
                    msg_type = data.get('type')
                    if msg_type == 'user':
                        user_count += 1
                    elif msg_type == 'assistant':
                        assistant_count += 1
                except json.JSONDecodeError:
                    continue
    except OSError:
        return 0

    return min(user_count, assistant_count)


def should_extract(session_id: str, project_dir: str = ".", min_turns: int = 10) -> bool:
    """Check if session has enough content to extract learnings.

    Args:
        session_id: Session identifier
        project_dir: Project directory path
        min_turns: Minimum conversation turns required

    Returns:
        True if session has >= min_turns
    """
    jsonl_path = find_session_jsonl(session_id, project_dir)

    if not jsonl_path or not jsonl_path.exists():
        return False

    turns = count_turns(jsonl_path)
    return turns >= min_turns


def extract_thinking_blocks(jsonl_path: Path) -> list[dict[str, Any]]:
    """Extract thinking blocks with perception signals.

    Args:
        jsonl_path: Path to session JSONL

    Returns:
        List of thinking block dicts
    """
    blocks = []

    try:
        with open(jsonl_path, 'r', encoding='utf-8', errors='replace') as f:
            for line_num, line in enumerate(f, 1):
                try:
                    data = json.loads(line.strip())
                except json.JSONDecodeError:
                    continue

                if data.get('type') != 'assistant':
                    continue

                message = data.get('message', {})
                content = message.get('content')

                if not isinstance(content, list):
                    continue

                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'thinking':
                        thinking_text = item.get('thinking', '')
                        if not thinking_text:
                            continue

                        has_signal = bool(PERCEPTION_PATTERN.search(thinking_text))

                        if has_signal:
                            blocks.append({
                                'thinking': thinking_text,
                                'timestamp': data.get('timestamp'),
                                'line_num': line_num,
                            })
    except OSError:
        pass

    return blocks


def classify_learning(text: str) -> str:
    """Classify a learning by type based on content patterns.

    Args:
        text: Learning text content

    Returns:
        Learning type string
    """
    for learning_type, patterns in LEARNING_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return learning_type

    # Default to working solution
    return "WORKING_SOLUTION"


def extract_learnings_from_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """Extract a structured learning from a thinking block.

    Args:
        block: Thinking block dict

    Returns:
        Learning dict with content, type, context, tags
    """
    thinking = block.get('thinking', '')

    # Skip very short or very long blocks
    if len(thinking) < 100 or len(thinking) > 5000:
        return None

    # Skip blocks that are just code or lists
    if thinking.count('\n') > 20:
        return None

    # Extract key insight (first 2-3 sentences with perception signal)
    sentences = re.split(r'[.!?]+', thinking)
    insight_sentences = []

    for sent in sentences[:10]:
        sent = sent.strip()
        if len(sent) > 30 and PERCEPTION_PATTERN.search(sent):
            insight_sentences.append(sent)
            if len(insight_sentences) >= 3:
                break

    if not insight_sentences:
        return None

    content = '. '.join(insight_sentences) + '.'
    learning_type = classify_learning(content)

    # Extract context from surrounding text
    context_match = re.search(r'(?:working on|for|with|in)\s+([^.]+)', thinking[:500], re.IGNORECASE)
    context = context_match.group(1).strip() if context_match else "session insight"

    # Generate tags from content
    tags = []
    if 'hook' in content.lower():
        tags.append('hooks')
    if 'test' in content.lower():
        tags.append('testing')
    if 'error' in content.lower() or 'bug' in content.lower():
        tags.append('debugging')
    if 'performance' in content.lower():
        tags.append('performance')
    if 'database' in content.lower() or 'sql' in content.lower():
        tags.append('database')

    return {
        'content': content,
        'type': learning_type,
        'context': context,
        'tags': tags,
        'confidence': 'medium',
        'source_line': block.get('line_num'),
    }


def extract_session_learnings(
    session_id: str,
    project_dir: str,
    store: bool = True,
    max_learnings: int = 10
) -> list[dict[str, Any]]:
    """Extract learnings from a session and optionally store them.

    Args:
        session_id: Session identifier
        project_dir: Project directory path
        store: Whether to store learnings in database
        max_learnings: Maximum learnings to extract

    Returns:
        List of extracted learning dicts
    """
    jsonl_path = find_session_jsonl(session_id, project_dir)

    if not jsonl_path or not jsonl_path.exists():
        return []

    # Clamp to a sane range. The default is 10; a caller passing 10_000
    # would otherwise fan out 10k concurrent embedding+DB calls below and
    # spike the backend. The lower bound also rejects 0 / negatives that
    # would silently disable extraction.
    max_learnings = max(1, min(max_learnings, 100))

    # Extract thinking blocks with perception signals
    blocks = extract_thinking_blocks(jsonl_path)

    if not blocks:
        return []

    # Extract learnings from blocks
    learnings = []
    for block in blocks:
        learning = extract_learnings_from_block(block)
        if learning:
            learning['session_id'] = session_id
            learnings.append(learning)

            if len(learnings) >= max_learnings:
                break

    # Store if requested. store_learning_v2 is async, so previously each
    # learning was awaited via its own asyncio.run() call -- N event loops,
    # N pool reconnects, N round-trips serialized. Phase B1: bundle the
    # whole batch into a single asyncio.run() that fans out via gather.
    # Failures are still visible on stderr -- never silently swallowed.
    # If a future maintainer wants to skip storage, they must pass
    # store=False explicitly; reverting this branch to a no-op is the bug
    # we just fixed.
    if store and learnings:
        # Cap concurrency so the DB pool + embedding service aren't slammed
        # by a synchronous burst. With max_learnings clamped to <=100 above
        # and 8 here, the worst-case fan-out is 8 in-flight at a time.
        STORE_CONCURRENCY = 8

        async def _store_all():
            sem = asyncio.Semaphore(STORE_CONCURRENCY)

            async def _bounded(learning: dict) -> Any:
                async with sem:
                    return await _store_learning_v2(
                        session_id=session_id,
                        content=learning['content'],
                        learning_type=learning['type'],
                        context=learning['context'],
                        tags=learning['tags'],
                        confidence=learning['confidence'],
                        project_dir=project_dir,
                        # Regex extraction of reasoning on a hook trigger: not an
                        # observed fact, so it is an inference.
                        source="hook",
                        is_inference=True,
                    )

            tasks = [_bounded(learning) for learning in learnings]
            # return_exceptions=True so one bad learning doesn't cancel the
            # rest. Each result is either the v2 result dict or an Exception.
            return await asyncio.gather(*tasks, return_exceptions=True)

        try:
            results = asyncio.run(_store_all())
        except Exception as e:
            # asyncio.run itself failed (loop already running, etc.).
            # Surface and bail -- nothing was stored.
            print(
                f"Failed to store learnings (session={session_id}): {e}",
                file=sys.stderr,
            )
            results = []

        for result in results:
            if isinstance(result, Exception):
                # Any unexpected exception (e.g. DB outage, embedding service
                # crash) must be visible. We do NOT re-raise so a single
                # failed learning doesn't prevent storing the rest.
                print(
                    f"Failed to store learning (session={session_id}): {result}",
                    file=sys.stderr,
                )
            elif isinstance(result, dict) and not result.get('success'):
                # store_learning_v2 returned a failure dict (e.g. backend
                # unavailable). Surface it explicitly.
                print(
                    f"Failed to store learning (session={session_id}): "
                    f"{result.get('error', 'unknown error')}",
                    file=sys.stderr,
                )

    return learnings


def preview_extraction(session_id: str, project_dir: str) -> dict[str, Any]:
    """Preview what would be extracted without storing.

    Args:
        session_id: Session identifier
        project_dir: Project directory path

    Returns:
        Dict with preview info
    """
    jsonl_path = find_session_jsonl(session_id, project_dir)

    if not jsonl_path:
        return {
            'error': 'Session JSONL not found',
            'session_id': session_id,
        }

    turns = count_turns(jsonl_path)
    blocks = extract_thinking_blocks(jsonl_path)
    learnings = extract_session_learnings(session_id, project_dir, store=False)

    return {
        'session_id': session_id,
        'jsonl_path': str(jsonl_path),
        'turns': turns,
        'thinking_blocks': len(blocks),
        'learnings': learnings,
        'would_store': len(learnings),
    }


# CLI interface
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="On-demand memory extraction")
    parser.add_argument("command", choices=["check", "preview", "extract"],
                       help="Command to run")
    parser.add_argument("--session-id", "-s", required=True,
                       help="Session identifier")
    parser.add_argument("--project", "-p", default=".",
                       help="Project directory (default: current)")
    parser.add_argument("--min-turns", type=int, default=10,
                       help="Minimum turns for extraction (default: 10)")
    parser.add_argument("--max-learnings", type=int, default=10,
                       help="Maximum learnings to extract (default: 10)")
    parser.add_argument("--json", action="store_true",
                       help="Output as JSON")

    args = parser.parse_args()
    project = Path(args.project).resolve()

    if args.command == "check":
        should = should_extract(args.session_id, str(project), args.min_turns)
        if args.json:
            print(json.dumps({"should_extract": should, "min_turns": args.min_turns}))
        else:
            print(f"Should extract: {should}")
        sys.exit(0 if should else 1)

    elif args.command == "preview":
        preview = preview_extraction(args.session_id, str(project))
        if args.json:
            print(json.dumps(preview, indent=2, default=str))
        else:
            print(f"Session: {preview.get('session_id')}")
            print(f"JSONL: {preview.get('jsonl_path')}")
            print(f"Turns: {preview.get('turns')}")
            print(f"Thinking blocks: {preview.get('thinking_blocks')}")
            print(f"Would store: {preview.get('would_store')} learnings")
            if preview.get('learnings'):
                print("\nLearnings preview:")
                for i, l in enumerate(preview['learnings'][:3], 1):
                    print(f"  {i}. [{l['type']}] {l['content'][:100]}...")

    elif args.command == "extract":
        learnings = extract_session_learnings(
            args.session_id,
            str(project),
            store=True,
            max_learnings=args.max_learnings
        )
        if args.json:
            print(json.dumps(learnings, indent=2, default=str))
        else:
            print(f"Extracted {len(learnings)} learnings from session {args.session_id}")
            for l in learnings:
                print(f"  - [{l['type']}] {l['content'][:80]}...")
