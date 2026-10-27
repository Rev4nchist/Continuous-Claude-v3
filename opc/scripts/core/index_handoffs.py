#!/usr/bin/env python3
"""Bulk ingestion of session handoffs into archival_memory.

Walks ``thoughts/shared/handoffs/`` recursively, parses each YAML or
markdown handoff, splits its content into per-field entries, and stores
those entries in ``archival_memory`` with structured metadata so the
canonical recall path can surface handoff context.

Per-field entries:
  Each non-empty handoff field (goal, done, next, blockers, decisions)
  becomes one ``archival_memory`` row. The body is prefixed with the
  field name (e.g. "Decision: Chose Graphiti over AGE..."). Metadata
  records ``source=handoff``, ``handoff_path`` (relative), ``handoff_field``,
  ``outcome`` (SUCCEEDED|PARTIAL_PLUS|PARTIAL_MINUS|FAILED|UNKNOWN), and
  ``type`` (one of LEARNING_TYPES; inferred via incremental_extract.py).

Usage:
    # Default: dry-run scan, no DB writes
    uv run python opc/scripts/core/index_handoffs.py

    # Actually insert (transaction-wrapped)
    uv run python opc/scripts/core/index_handoffs.py --apply

    # Re-index a single handoff (idempotent dedup via metadata)
    uv run python opc/scripts/core/index_handoffs.py --apply \\
        --only-path thoughts/shared/handoffs/ralph-auto/ralph-handoff-X.yaml

    # Include archive/ subdirs and older files
    uv run python opc/scripts/core/index_handoffs.py --include-archived \\
        --max-age-days 365

Idempotency:
    Before inserting any row, the script checks whether an existing
    ``archival_memory`` entry already records the same
    ``(handoff_path, handoff_field)``. Matching rows are skipped so
    repeated ``--apply`` runs produce zero new entries.

Phase 1.7 of the memory hardening v2 plan (Task #8 / G7).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

# Load env (opc/.env is authoritative for DATABASE_URL, mirrors recall_learnings.py)
script_dir = Path(__file__).resolve().parent
opc_dir = script_dir.parent.parent  # opc/scripts/core -> opc/
opc_env = opc_dir / ".env"
if opc_env.exists():
    load_dotenv(opc_env, override=True)

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

# Make sibling modules importable (db.*, incremental_extract.infer_learning_type)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from memory_write_log import record_write_failure  # noqa: E402

# Re-use the canonical auto-type heuristic so handoff entries get the same
# type labels as the rest of the memory pipeline. Imported lazily so
# --dry-run on a machine without the full deps still runs.
try:
    from incremental_extract import infer_learning_type  # type: ignore
except Exception:  # pragma: no cover - defensive
    def infer_learning_type(content: str) -> str:  # type: ignore
        return "WORKING_SOLUTION"


# Fields we extract from each handoff -> archival_memory entry
HANDOFF_FIELDS = ("goal", "done", "next", "blockers", "decisions")

# Display prefixes for the content body
FIELD_PREFIXES = {
    "goal": "Goal",
    "done": "Done",
    "next": "Next",
    "blockers": "Blockers",
    "decisions": "Decision",  # singular reads better as a sentence prefix
}

# Valid outcome enum (matches handoff_outcome and session-outcome hook)
VALID_OUTCOMES = ("SUCCEEDED", "PARTIAL_PLUS", "PARTIAL_MINUS", "FAILED", "UNKNOWN")

DEFAULT_MAX_AGE_DAYS = 90


# --- Path utilities -----------------------------------------------------


def get_repo_root() -> Path:
    """Locate the continuous-claude repo root.

    The script lives at ``opc/scripts/core/index_handoffs.py``, so the
    repo root is two directories above ``opc/``.
    """
    return Path(__file__).resolve().parents[3]


def get_handoffs_dir(repo_root: Path | None = None) -> Path:
    """Path to ``thoughts/shared/handoffs/`` rooted in the repo."""
    root = repo_root or get_repo_root()
    return root / "thoughts" / "shared" / "handoffs"


def relative_handoff_path(abs_path: Path, repo_root: Path) -> str:
    """Path relative to ``thoughts/shared/handoffs/`` for metadata storage.

    Uses forward slashes regardless of OS so DB metadata is portable.
    """
    handoffs_dir = get_handoffs_dir(repo_root)
    try:
        rel = abs_path.resolve().relative_to(handoffs_dir.resolve())
    except ValueError:
        # File isn't under handoffs/: fall back to path relative to repo root
        try:
            rel = abs_path.resolve().relative_to(repo_root.resolve())
        except ValueError:
            rel = abs_path
    return str(rel).replace("\\", "/")


# --- Parsing ------------------------------------------------------------


def _stringify_field(value: Any, max_items: int = 12, max_chars: int = 1800) -> str:
    """Render a YAML or Markdown field value as a single string.

    Handles three shapes:
      - str: returned as-is (stripped, truncated)
      - list: rendered as bulleted lines
      - dict: rendered as ``key: value`` lines (deterministic order)

    Items beyond ``max_items`` are summarised; characters beyond
    ``max_chars`` are truncated with a marker so an oversize handoff
    section doesn't dominate one embedding.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        out = value.strip()
    elif isinstance(value, list):
        items: list[str] = []
        for entry in value[:max_items]:
            if isinstance(entry, dict):
                # Common shape in ralph YAML: {task: "...", files: [...]}
                if "task" in entry:
                    items.append(f"- {str(entry['task']).strip()}")
                else:
                    pairs = ", ".join(
                        f"{k}: {v}" for k, v in entry.items() if v
                    )
                    items.append(f"- {pairs}")
            elif entry:
                items.append(f"- {str(entry).strip()}")
        if len(value) > max_items:
            items.append(f"- ... (+{len(value) - max_items} more)")
        out = "\n".join(items)
    elif isinstance(value, dict):
        items = []
        for idx, (k, v) in enumerate(value.items()):
            if idx >= max_items:
                items.append(f"- ... (+{len(value) - max_items} more)")
                break
            if isinstance(v, str):
                items.append(f"- {k}: {v.strip()}")
            else:
                items.append(f"- {k}: {v}")
        out = "\n".join(items)
    else:
        out = str(value).strip()

    if len(out) > max_chars:
        out = out[: max_chars - 12].rstrip() + "... [truncated]"
    return out


def _detect_outcome(text: str, explicit: str | None = None) -> str:
    """Normalise an outcome marker to one of VALID_OUTCOMES."""
    if explicit:
        upper = explicit.strip().upper().replace("-", "_")
        if upper in VALID_OUTCOMES:
            return upper
        # Common alternative spellings used in legacy YAML
        if upper in ("SUCCESS", "DONE", "COMPLETE", "COMPLETED"):
            return "SUCCEEDED"
        if upper in ("PARTIAL", "IN_PROGRESS"):
            return "PARTIAL_PLUS"
    m = re.search(
        r"(?:outcome|status)\s*[:=]\s*([A-Z][A-Z_+-]+)",
        text,
        re.IGNORECASE,
    )
    if m:
        return _detect_outcome("", explicit=m.group(1))
    return "UNKNOWN"


FRONT_MATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_front_matter(content: str) -> tuple[dict[str, Any], str]:
    """Split ``--- ... ---`` front-matter from body. Returns ({}, content) on miss."""
    m = FRONT_MATTER_RE.match(content)
    if not m:
        return {}, content
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        fm = {}
    body = content[m.end() :]
    return (fm if isinstance(fm, dict) else {}), body


def parse_yaml_handoff(path: Path, content: str) -> dict[str, Any] | None:
    """Parse a YAML handoff (single-document, multi-doc, or hybrid markdown).

    Three observed shapes:

      1. Pure YAML: ``goal: ...`` etc. -- ``safe_load`` returns a dict.

      2. Front-matter style (multi-doc):

            ---
            type: auto-handoff
            session: ralph-auto
            ---
            goal: "..."

         ``safe_load`` rejects this with ``ComposerError``. We use
         ``safe_load_all`` and merge every mapping document.

      3. Hybrid: YAML front-matter followed by free-form markdown body
         (e.g. memory-remediation handoffs). PyYAML can't parse the body,
         so we fall back to: (a) the front-matter dict, plus (b) markdown
         section scanning on the body to recover ``done`` / ``next`` /
         ``decisions``.

    Returns ``None`` only if no usable structure can be recovered.
    """
    data: dict[str, Any] | None = None
    try:
        loaded = yaml.safe_load(content)
        if isinstance(loaded, dict):
            data = loaded
    except yaml.YAMLError:
        pass

    if data is None:
        # Multi-doc YAML: merge every dict document into one.
        try:
            docs = list(yaml.safe_load_all(content))
        except yaml.YAMLError:
            docs = []
        merged: dict[str, Any] = {}
        for doc in docs:
            if isinstance(doc, dict):
                for k, v in doc.items():
                    if k not in merged or not merged[k]:
                        merged[k] = v
        if merged:
            data = merged

    if data is None:
        # Hybrid handoff: YAML front-matter + free-form markdown body.
        fm, body = _parse_front_matter(content)
        if fm or body.strip():
            md_parsed = parse_md_handoff(path, body) if body.strip() else {}
            # Front-matter wins for explicit fields; markdown fills the gaps
            # for done/next/decisions which live in the body.
            data = {**md_parsed, **{k: v for k, v in fm.items() if v}}
            # Re-detect outcome using the *full* content (front-matter
            # exposes `outcome: PARTIAL_PLUS` and similar markers).
            data["outcome"] = _detect_outcome(content, fm.get("outcome") or fm.get("status"))
        if not data:
            return None

    # Synonyms across the handoff dialects we've shipped
    done = (
        data.get("done")
        or data.get("done_this_session")
        or data.get("completed")
    )
    nxt = data.get("next") or data.get("next_session") or data.get("pending")
    blockers = data.get("blockers") or data.get("questions")
    decisions = (
        data.get("decisions")
        or data.get("decided")
        or data.get("findings")
    )
    outcome = _detect_outcome(content, data.get("outcome") or data.get("status"))

    return {
        "goal": data.get("goal", ""),
        "done": done,
        "next": nxt,
        "blockers": blockers,
        "decisions": decisions,
        "outcome": outcome,
    }


# Heading regex: `## Foo`, `### Foo`, etc. (case-insensitive matched per field)
def _extract_md_section(content: str, heading_name: str) -> str:
    """Pull text under a Markdown heading until the next same-or-higher heading.

    Tolerant to common variants: "## Done", "### Done This Session",
    "Done:" inline, etc.
    """
    # Multi-line heading match (``^## Foo`` etc.)
    pattern = re.compile(
        rf"^\s{{0,3}}#{{1,6}}\s+{re.escape(heading_name)}\b[^\n]*\n",
        re.IGNORECASE | re.MULTILINE,
    )
    m = pattern.search(content)
    if m:
        start = m.end()
        # next heading of any depth
        nxt = re.search(r"^\s{0,3}#{1,6}\s+", content[start:], re.MULTILINE)
        end = start + nxt.start() if nxt else len(content)
        return content[start:end].strip()

    # Inline "Done:" / "Decision:" prefix
    inline = re.search(
        rf"^\s*{re.escape(heading_name)}\s*[:=]\s*(.+?)(?:\n\s*\n|\Z)",
        content,
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    if inline:
        return inline.group(1).strip()
    return ""


def _extract_bold_field(content: str, label: str) -> str:
    """Extract a `**Label:** value` inline field common in kraken handoffs."""
    m = re.search(
        rf"^\s*\*\*{re.escape(label)}:?\*\*\s*(.+?)(?:\n\s*\n|\n\s*\*\*|\Z)",
        content,
        re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    return m.group(1).strip() if m else ""


def parse_md_handoff(path: Path, content: str) -> dict[str, Any]:
    """Parse a Markdown handoff via heuristic section scanning.

    Supports both prose handoffs (``## Goal`` / ``## Done`` / ``## Next``) and
    the kraken checkpoint format used under ``thoughts/shared/handoffs/kraken-*/``:

        ## Checkpoints
        **Task:** ...
        ### Phase Status
        - Phase 1 (Tests Written): VALIDATED ...
        ### Resume Context
        - Current focus: ...
        - Next action: ...
        - Blockers: ...
    """
    goal = (
        _extract_md_section(content, "Goal")
        or _extract_md_section(content, "Objective")
        or _extract_md_section(content, "Task")
        or _extract_bold_field(content, "Task")
    )
    done = (
        _extract_md_section(content, "Done")
        or _extract_md_section(content, "Done This Session")
        or _extract_md_section(content, "Completed")
        or _extract_md_section(content, "What's done")
        or _extract_md_section(content, "Phase Status")
    )
    nxt = (
        _extract_md_section(content, "Next")
        or _extract_md_section(content, "Next Steps")
        or _extract_md_section(content, "What's pending")
        or _extract_md_section(content, "Resume")
        or _extract_md_section(content, "Resume Context")
    )
    blockers = (
        _extract_md_section(content, "Blockers")
        or _extract_md_section(content, "Questions")
        or _extract_md_section(content, "Issues")
        or _extract_bold_field(content, "Blockers")
    )
    decisions = (
        _extract_md_section(content, "Decisions")
        or _extract_md_section(content, "Findings")
        or _extract_md_section(content, "Architectural Decisions")
        or _extract_md_section(content, "Validation State")
    )
    outcome = _detect_outcome(content)
    return {
        "goal": goal,
        "done": done,
        "next": nxt,
        "blockers": blockers,
        "decisions": decisions,
        "outcome": outcome,
    }


def parse_handoff_file(path: Path) -> dict[str, Any] | None:
    """Dispatch to the YAML or markdown parser based on suffix."""
    if not path.exists() or not path.is_file():
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix in (".yaml", ".yml"):
        return parse_yaml_handoff(path, content)
    if path.suffix == ".md":
        return parse_md_handoff(path, content)
    return None


# --- Discovery ----------------------------------------------------------


def discover_handoffs(
    handoffs_dir: Path,
    max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    include_archived: bool = False,
) -> list[Path]:
    """List handoff files that pass the age + archive filters."""
    if not handoffs_dir.exists():
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    cutoff_ts = cutoff.timestamp()

    files: list[Path] = []
    for ext in (".yaml", ".yml", ".md"):
        for f in handoffs_dir.rglob(f"*{ext}"):
            if not f.is_file():
                continue
            parts = {p.lower() for p in f.parts}
            if not include_archived and "archive" in parts:
                continue
            try:
                mtime = f.stat().st_mtime
            except OSError:
                continue
            if mtime < cutoff_ts:
                continue
            files.append(f)

    # Stable order: newest first
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files


# --- Per-handoff entry builder ------------------------------------------


def build_entries(
    path: Path,
    parsed: dict[str, Any],
    repo_root: Path,
) -> list[dict[str, Any]]:
    """Convert a parsed handoff into per-field archival_memory rows."""
    rel_path = relative_handoff_path(path, repo_root)
    outcome = parsed.get("outcome", "UNKNOWN")
    session_id = path.stem  # filename without extension

    entries: list[dict[str, Any]] = []
    for field in HANDOFF_FIELDS:
        raw = parsed.get(field)
        body = _stringify_field(raw)
        if not body.strip():
            continue

        prefix = FIELD_PREFIXES[field]
        content = f"{prefix}: {body}"
        learning_type = infer_learning_type(content)

        metadata = {
            "source": "handoff",
            "handoff_path": rel_path,
            "handoff_field": field,
            "outcome": outcome,
            "type": learning_type,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
        }

        entries.append(
            {
                "content": content,
                "metadata": metadata,
                "session_id": session_id,
                "agent_id": "handoff-indexer",
                "scope": "PROJECT",
                "learning_type": learning_type,
            }
        )
    return entries


# --- Embedder cache -----------------------------------------------------


_embedder = None


def get_embedder():
    """Singleton EmbeddingService(provider='local') -- avoid BGE reload."""
    global _embedder
    if _embedder is None:
        from db.embedding_service import EmbeddingService

        _embedder = EmbeddingService(provider="local")
    return _embedder


# --- DB plumbing --------------------------------------------------------


async def get_project_id(project_dir: Path) -> str:
    """Hash project root into a 16-char project_id, matching store_learning."""
    import hashlib

    return hashlib.sha256(str(project_dir.resolve()).encode()).hexdigest()[:16]


async def existing_handoff_keys(memory) -> set[tuple[str, str]]:
    """Read which ``(handoff_path, handoff_field)`` pairs are already stored.

    Used by --apply so re-runs are idempotent.
    """
    from db.postgres_pool import get_connection

    keys: set[tuple[str, str]] = set()
    async with get_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT metadata->>'handoff_path' AS path,
                   metadata->>'handoff_field' AS field
            FROM archival_memory
            WHERE metadata->>'source' = 'handoff'
            """
        )
    for row in rows:
        path = row["path"]
        field = row["field"]
        if path and field:
            keys.add((path, field))
    return keys


async def archival_count() -> int:
    """Total rows in archival_memory (for before/after reporting)."""
    from db.postgres_pool import get_connection

    async with get_connection() as conn:
        row = await conn.fetchrow("SELECT COUNT(*) AS n FROM archival_memory")
    return int(row["n"])


# --- Apply --------------------------------------------------------------


async def index_handoffs(
    handoff_files: list[Path],
    repo_root: Path,
    apply: bool,
) -> dict[str, Any]:
    """Parse handoffs, dedup, optionally insert, return a structured summary."""
    summary: dict[str, Any] = {
        "scanned": len(handoff_files),
        "parsed": 0,
        "parse_failures": 0,
        "candidate_entries": 0,
        "skipped_existing": 0,
        "inserted": 0,
        "by_field": {f: 0 for f in HANDOFF_FIELDS},
        "by_outcome": {o: 0 for o in VALID_OUTCOMES},
        "errors": [],
        "before_count": 0,
        "after_count": 0,
        "sample": [],
    }

    parsed_entries: list[dict[str, Any]] = []
    for f in handoff_files:
        parsed = parse_handoff_file(f)
        if parsed is None:
            summary["parse_failures"] += 1
            continue
        summary["parsed"] += 1
        for entry in build_entries(f, parsed, repo_root):
            parsed_entries.append(entry)
            summary["candidate_entries"] += 1
            summary["by_field"][entry["metadata"]["handoff_field"]] += 1
            summary["by_outcome"][entry["metadata"]["outcome"]] += 1

    # Pre-fill sample with the first 3 candidate entries
    for entry in parsed_entries[:3]:
        summary["sample"].append(
            {
                "content_preview": entry["content"][:200],
                "metadata": entry["metadata"],
            }
        )

    if not apply:
        return summary

    # --- DB writes ------------------------------------------------------
    try:
        from db.memory_factory import create_memory_service
    except ImportError as exc:
        summary["errors"].append(f"memory factory import failed: {exc}")
        return summary

    # A database that is down at setup must leave a trace too, not only a
    # per-entry store failure. The error is still raised as before.
    try:
        summary["before_count"] = await archival_count()
        memory = await create_memory_service(
            backend="postgres",
            session_id="handoff-indexer",
            agent_id="handoff-indexer",
        )
        project_id = await get_project_id(repo_root)
    except Exception as exc:
        record_write_failure("index_handoffs", f"setup failed: {exc}", "handoff-indexer")
        raise

    try:
        existing = await existing_handoff_keys(memory)
        embedder = get_embedder()

        for entry in parsed_entries:
            key = (
                entry["metadata"]["handoff_path"],
                entry["metadata"]["handoff_field"],
            )
            if key in existing:
                summary["skipped_existing"] += 1
                continue

            try:
                embedding = await embedder.embed(entry["content"])
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(
                    f"embed failed for {key[0]}#{key[1]}: {exc}"
                )
                continue

            try:
                # Each entry gets its own session_id (handoff filename stem) so
                # cross-session recall surfaces handoffs distinctly.
                memory.session_id = entry["session_id"]
                memory.agent_id = entry["agent_id"]
                await memory.store(
                    entry["content"],
                    metadata=entry["metadata"],
                    embedding=embedding,
                    scope=entry["scope"],
                    project_id=project_id,
                )
                summary["inserted"] += 1
                existing.add(key)  # avoid double-insert within the run
            except Exception as exc:  # noqa: BLE001
                summary["errors"].append(
                    f"store failed for {key[0]}#{key[1]}: {exc}"
                )
                record_write_failure("index_handoffs", exc, entry["session_id"])
                continue
    finally:
        await memory.close()

    summary["after_count"] = await archival_count()
    return summary


# --- CLI ----------------------------------------------------------------


def _print_summary(summary: dict[str, Any], apply: bool) -> None:
    print("=" * 60)
    print(f"Handoff indexer summary ({'APPLY' if apply else 'DRY RUN'})")
    print("=" * 60)
    print(f"Files scanned:        {summary['scanned']}")
    print(f"Files parsed:         {summary['parsed']}")
    print(f"Parse failures:       {summary['parse_failures']}")
    print(f"Candidate entries:    {summary['candidate_entries']}")
    if apply:
        print(f"Skipped (exists):     {summary['skipped_existing']}")
        print(f"Inserted:             {summary['inserted']}")
        print(
            f"archival_memory rows: {summary['before_count']} -> "
            f"{summary['after_count']}"
            f" (+{summary['after_count'] - summary['before_count']})"
        )
    print()
    print("By field:")
    for field, n in summary["by_field"].items():
        print(f"  {field:10s}: {n}")
    print()
    print("By outcome:")
    for outcome, n in summary["by_outcome"].items():
        print(f"  {outcome:14s}: {n}")
    if summary["errors"]:
        print()
        print(f"Errors: {len(summary['errors'])}")
        for err in summary["errors"][:5]:
            print(f"  - {err}")
        if len(summary["errors"]) > 5:
            print(f"  ... (+{len(summary['errors']) - 5} more)")
    if summary.get("sample"):
        print()
        print("Sample (first 3 candidates):")
        for idx, item in enumerate(summary["sample"], 1):
            print(f"  [{idx}] {item['content_preview'][:160]}")
            print(f"      path={item['metadata']['handoff_path']}")
            print(
                f"      field={item['metadata']['handoff_field']}"
                f" outcome={item['metadata']['outcome']}"
                f" type={item['metadata']['type']}"
            )


async def amain(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    handoffs_dir = get_handoffs_dir(repo_root)

    if args.only_path:
        only = Path(args.only_path)
        if not only.is_absolute():
            only = (repo_root / args.only_path).resolve()
        if not only.exists():
            print(f"--only-path target does not exist: {only}", file=sys.stderr)
            return 2
        files = [only]
    else:
        files = discover_handoffs(
            handoffs_dir,
            max_age_days=args.max_age_days,
            include_archived=args.include_archived,
        )

    summary = await index_handoffs(
        files,
        repo_root=repo_root,
        apply=args.apply,
    )

    if args.json:
        print(json.dumps(summary, default=str, indent=2))
    else:
        _print_summary(summary, apply=args.apply)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Index session handoffs into archival_memory."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, runs a dry scan.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Default mode -- scan and classify, no DB writes.",
    )
    parser.add_argument(
        "--max-age-days",
        type=int,
        default=DEFAULT_MAX_AGE_DAYS,
        help=f"Skip handoffs older than N days (default: {DEFAULT_MAX_AGE_DAYS}).",
    )
    parser.add_argument(
        "--include-archived",
        action="store_true",
        help="Include files under archive/ subdirectories.",
    )
    parser.add_argument(
        "--only-path",
        type=str,
        default=None,
        help="Index a single handoff file (used by the hook for fast updates).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit the summary as JSON.",
    )
    args = parser.parse_args()

    if args.dry_run and args.apply:
        print("--dry-run and --apply are mutually exclusive", file=sys.stderr)
        return 2

    return asyncio.run(amain(args))


if __name__ == "__main__":
    sys.exit(main())
