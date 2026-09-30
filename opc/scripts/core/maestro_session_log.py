#!/usr/bin/env python3
"""Maestro Session Logger - Log orchestration sessions locally.

Creates session-level logs for Maestro orchestrations including:
- Original prompt and complexity score
- Pattern selected
- Agents spawned
- Skills loaded
- Outcome (success/failure)
- Decision overrides

USAGE:
    # Start session
    uv run python scripts/core/core/maestro_session_log.py start \
        --prompt "implement auth feature" \
        --complexity 0.75 \
        --pattern hierarchical

    # Log agent spawn
    uv run python scripts/core/core/maestro_session_log.py agent \
        --session-id <id> \
        --agent kraken \
        --task "implement middleware"

    # Log skill load
    uv run python scripts/core/core/maestro_session_log.py skill \
        --session-id <id> \
        --skill systematic-debugging

    # Log override
    uv run python scripts/core/core/maestro_session_log.py override \
        --session-id <id> \
        --hook-pattern swarm \
        --maestro-pattern hierarchical \
        --reason "detected dependencies"

    # End session
    uv run python scripts/core/core/maestro_session_log.py end \
        --session-id <id> \
        --outcome success

Sessions are stored under ~/.claude/state/maestro_sessions/. No remote upload.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Config
STATE_DIR = Path.home() / ".claude" / "state" / "maestro_sessions"
LOG_FILE = Path.home() / ".claude" / "state" / "maestro_session.log"


def ensure_dirs():
    """Ensure state directories exist."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)


def log(level: str, message: str):
    """Log to file."""
    ensure_dirs()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a") as f:
        f.write(f"{timestamp} [{level}] {message}\n")


def get_timestamp() -> str:
    """Get ISO timestamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate_session_id() -> str:
    """Generate session ID."""
    return f"maestro-{uuid.uuid4().hex[:12]}"


def load_session(session_id: str) -> dict[str, Any]:
    """Load session state."""
    ensure_dirs()
    state_file = STATE_DIR / f"{session_id}.json"
    if state_file.exists():
        return json.loads(state_file.read_text())
    return {}


def save_session(session_id: str, data: dict[str, Any]):
    """Save session state."""
    ensure_dirs()
    state_file = STATE_DIR / f"{session_id}.json"
    state_file.write_text(json.dumps(data, indent=2))


def cmd_start(args):
    """Start a new Maestro session."""
    session_id = generate_session_id()

    session = {
        "session_id": session_id,
        "start_time": get_timestamp(),
        "end_time": None,
        "original_prompt": args.prompt,
        "complexity_score": args.complexity,
        "pattern_selected": args.pattern,
        "agents_spawned": [],
        "skills_loaded": [],
        "overrides": [],
        "outcome": "in_progress",
        "learnings_stored": False,
    }

    save_session(session_id, session)
    log("INFO", f"Started session: {session_id}")

    print(json.dumps({"session_id": session_id, "status": "started"}))
    return session_id


def cmd_agent(args):
    """Log agent spawn."""
    session = load_session(args.session_id)
    if not session:
        print(json.dumps({"error": "Session not found"}))
        return

    session["agents_spawned"].append({
        "name": args.agent,
        "task": args.task,
        "spawned_at": get_timestamp(),
    })

    save_session(args.session_id, session)
    print(json.dumps({"status": "logged"}))


def cmd_skill(args):
    """Log skill load."""
    session = load_session(args.session_id)
    if not session:
        print(json.dumps({"error": "Session not found"}))
        return

    session["skills_loaded"].append({
        "name": args.skill,
        "loaded_at": get_timestamp(),
    })

    save_session(args.session_id, session)
    print(json.dumps({"status": "logged"}))


def cmd_override(args):
    """Log decision override."""
    session = load_session(args.session_id)
    if not session:
        print(json.dumps({"error": "Session not found"}))
        return

    session["overrides"].append({
        "timestamp": get_timestamp(),
        "hook_suggestion": {
            "pattern": args.hook_pattern,
            "confidence": args.hook_confidence or 0.0,
        },
        "maestro_choice": {
            "pattern": args.maestro_pattern,
            "confidence": args.maestro_confidence or 0.0,
        },
        "reason": args.reason,
    })

    save_session(args.session_id, session)
    log("INFO", f"Override logged: {args.hook_pattern} -> {args.maestro_pattern}")
    print(json.dumps({"status": "logged"}))


def cmd_end(args):
    """End session and save the outcome locally."""
    session = load_session(args.session_id)
    if not session:
        print(json.dumps({"error": "Session not found"}))
        return

    session["end_time"] = get_timestamp()
    session["outcome"] = args.outcome
    session["learnings_stored"] = args.learnings_stored

    save_session(args.session_id, session)

    log("INFO", f"Ended session: {args.session_id} ({args.outcome})")

    # Summary output
    summary = {
        "session_id": args.session_id,
        "outcome": args.outcome,
        "duration_agents": len(session["agents_spawned"]),
        "skills_loaded": len(session["skills_loaded"]),
        "overrides": len(session["overrides"]),
    }
    print(json.dumps(summary))


def cmd_show(args):
    """Show session details."""
    session = load_session(args.session_id)
    if not session:
        print(json.dumps({"error": "Session not found"}))
        return

    print(json.dumps(session, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Maestro Session Logger")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # start
    start_parser = subparsers.add_parser("start", help="Start new session")
    start_parser.add_argument("--prompt", required=True, help="Original prompt")
    start_parser.add_argument("--complexity", type=float, default=0.0, help="Complexity score")
    start_parser.add_argument("--pattern", help="Pattern selected")

    # agent
    agent_parser = subparsers.add_parser("agent", help="Log agent spawn")
    agent_parser.add_argument("--session-id", required=True, help="Session ID")
    agent_parser.add_argument("--agent", required=True, help="Agent name")
    agent_parser.add_argument("--task", default="", help="Task description")

    # skill
    skill_parser = subparsers.add_parser("skill", help="Log skill load")
    skill_parser.add_argument("--session-id", required=True, help="Session ID")
    skill_parser.add_argument("--skill", required=True, help="Skill name")

    # override
    override_parser = subparsers.add_parser("override", help="Log decision override")
    override_parser.add_argument("--session-id", required=True, help="Session ID")
    override_parser.add_argument("--hook-pattern", required=True, help="Hook suggested pattern")
    override_parser.add_argument("--hook-confidence", type=float, help="Hook confidence")
    override_parser.add_argument("--maestro-pattern", required=True, help="Maestro chosen pattern")
    override_parser.add_argument("--maestro-confidence", type=float, help="Maestro confidence")
    override_parser.add_argument("--reason", required=True, help="Reason for override")

    # end
    end_parser = subparsers.add_parser("end", help="End session")
    end_parser.add_argument("--session-id", required=True, help="Session ID")
    end_parser.add_argument("--outcome", choices=["success", "failure", "partial"], required=True)
    end_parser.add_argument("--learnings-stored", action="store_true", help="Whether learnings were stored")
    end_parser.add_argument("--upload", action="store_true", help="Deprecated, ignored (remote upload removed)")

    # show
    show_parser = subparsers.add_parser("show", help="Show session details")
    show_parser.add_argument("--session-id", required=True, help="Session ID")

    args = parser.parse_args()

    if args.command == "start":
        cmd_start(args)
    elif args.command == "agent":
        cmd_agent(args)
    elif args.command == "skill":
        cmd_skill(args)
    elif args.command == "override":
        cmd_override(args)
    elif args.command == "end":
        cmd_end(args)
    elif args.command == "show":
        cmd_show(args)


if __name__ == "__main__":
    main()
