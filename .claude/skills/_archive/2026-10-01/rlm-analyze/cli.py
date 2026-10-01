"""Skill dispatcher for /rlm-analyze.

Resolves <path> (file / directory / glob), concatenates readable files
with banner headers, caps total size, then shells to the Python CLI
at opc/scripts/core/rlm_cli.py which owns the actual RLM invocation.

Session context stays clean: everything runs out-of-process, only the
final answer flows back to Claude Code via stdout.

Usage:
    python .claude/skills/rlm-analyze/cli.py <path> "<question>"
    python .claude/skills/rlm-analyze/cli.py <path> "<question>" --max-size 10485760 --budget 3.00
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MB


# Directory names that should never be traversed
_SKIP_DIR_NAMES = {
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    ".next",
    "dist",
    "build",
    "cache",  # catches .claude/cache via path-parts match
}

# File suffixes that indicate binary / non-text content -- skip always
_SKIP_SUFFIXES = {
    ".pyc",
    ".pyd",
    ".so",
    ".dll",
    ".exe",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".lock",
    ".ico",
    ".bin",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
}


def _gather(path: Path, max_bytes: int) -> tuple[str, list[str]]:
    """Walk path (file/dir/glob) and return (concatenated, included_file_list).

    - File path: use as-is.
    - Directory path: rglob for every file, skipping dot-dir-like noise and
      binary-suffix files.
    - Anything else: treat the str form as a glob pattern.

    Each included file is prefixed with ``\n\n===== {path} =====\n`` so the
    RLM can enumerate files by running ``regex.findall(r"===== (.+) =====",
    context)`` without paying the cost of scanning all bytes.

    Stops adding files once the concatenated UTF-8 byte length would exceed
    ``max_bytes``. The returned corpus is guaranteed to fit within the cap.
    """
    files: list[Path] = []
    if path.is_file():
        files = [path]
    elif path.is_dir():
        for f in sorted(path.rglob("*")):
            if not f.is_file():
                continue
            # Skip any file whose ancestor (relative to path) is in skip list.
            try:
                rel = f.relative_to(path)
            except ValueError:
                rel = f
            if any(part in _SKIP_DIR_NAMES for part in rel.parts):
                continue
            if f.suffix.lower() in _SKIP_SUFFIXES:
                continue
            files.append(f)
    else:
        # Treat as a glob pattern relative to cwd
        files = [Path(p) for p in Path().glob(str(path)) if Path(p).is_file()]

    parts: list[str] = []
    total = 0
    included: list[str] = []
    for f in files:
        try:
            content = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        chunk = f"\n\n===== {f} =====\n{content}\n"
        chunk_bytes = len(chunk.encode("utf-8"))
        if total + chunk_bytes > max_bytes:
            break
        parts.append(chunk)
        total += chunk_bytes
        included.append(str(f))
    return "".join(parts), included


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="/rlm-analyze")
    ap.add_argument("path", help="file, directory, or glob pattern")
    ap.add_argument("question", help="analysis question (quoted string)")
    ap.add_argument(
        "--max-size",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="cap concatenated input bytes (default: 5 MB)",
    )
    ap.add_argument(
        "--budget",
        type=float,
        default=2.00,
        help="max USD budget for the RLM call (default: 2.00)",
    )
    return ap


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    corpus, included = _gather(Path(args.path), args.max_size)
    if not corpus:
        print("rlm-analyze: no readable files matched", file=sys.stderr)
        return 2

    print(
        f"rlm-analyze: collected {len(included)} files, "
        f"{len(corpus):,} chars",
        file=sys.stderr,
    )

    opc = os.environ.get("CLAUDE_OPC_DIR")
    if not opc:
        print(
            "rlm-analyze: CLAUDE_OPC_DIR not set -- cannot locate opc/ for "
            "`uv run python -m scripts.core.rlm_cli`",
            file=sys.stderr,
        )
        return 3

    tf = tempfile.NamedTemporaryFile(
        "w", suffix=".txt", delete=False, encoding="utf-8"
    )
    try:
        tf.write(corpus)
        tf.close()

        cmd = [
            "uv", "run", "python", "-m", "scripts.core.rlm_cli",
            "--mode", "skill",
            "--question", args.question,
            "--input-file", tf.name,
            "--budget-usd", str(args.budget),
        ]
        result = subprocess.run(
            cmd,
            cwd=opc,
            env={**os.environ, "PYTHONPATH": "."},
            capture_output=False,
        )
        return result.returncode
    finally:
        try:
            os.unlink(tf.name)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
