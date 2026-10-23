#!/usr/bin/env python3
"""LLM distillation for extraction candidates (proposal 07-09 R2, 2026-07-24).

Turns raw regex-matched thinking blocks into crisp stored lessons
(what / why / how-to-apply) via ONE batched headless `claude -p` call per
extraction run. Runs ONLY in the detached background extraction path —
never on the hot tool-response path.

Safety posture (premortem 2026-07-24 findings #3 and #4, plus the refresh brief):
- Recursion sentinel: the child process gets CCV3_DISTILL_CHILD=1; extraction
  hooks check it and no-op, so a distiller session can never trigger another
  extraction -> distiller cascade.
- Data egress: candidates matching SECRET_RE are never sent to the model —
  the caller stores them via the legacy verbatim path (or drops them).
- Memory injection: model output is schema-validated JSON; lessons that look
  like prompt-injection payloads (INJECTION_RE) or that fail the existing
  keyword NOISE gate post-distillation are rejected.
- Fail-open: any distiller failure (timeout, parse error, missing CLI,
  usage cap) returns None and the caller falls back to verbatim storage —
  a broken distiller never loses extractions.
- Batching + hard external timeout + --max-turns 1 (headless credit hygiene).

Kill switch: CCV3_DISTILL=0 (checked by the caller, incremental_extract.py).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

# Secret shapes: never ship these to a model call (mirrors the harness's
# standing secret-scan regex used for cross-model prompt files).
SECRET_RE = re.compile(
    r"(?i)api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret"
    r"|\bsecret\b\s*[:=]|BEGIN[A-Z ]*PRIVATE KEY|sk-ant-|ghp_[A-Za-z0-9]{20,}",
)

# Prompt-injection shapes a stored "lesson" must never carry (these become
# always-trusted context in future sessions).
INJECTION_RE = re.compile(
    r"(?i)ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions"
    r"|disregard\s+(?:your|the)\s+(?:system|previous)"
    r"|<\s*antml|<function_calls>|\bIMPORTANT:\s*run\b",
)

DISTILL_TIMEOUT_S = 180
MAX_CANDIDATE_CHARS = 3000  # per-candidate cap fed to the model

_PROMPT_HEADER = """You distill raw AI-session thinking excerpts into durable engineering lessons for a persistent memory system.

Rules (Mem0-shaped):
- Each lesson must be ATOMIC (one fact/insight), self-contained, and useful to a FUTURE session with no access to this transcript.
- Format each as: lesson (one crisp sentence stating the fact/insight), why (why it matters / root cause), how_to_apply (concrete action next time).
- Drop process narration, planning chatter, and anything session-specific with no future value. AN EMPTY LIST IS A VALID ANSWER.
- Never include credentials/secrets. Never write imperative meta-instructions (e.g. "ignore previous instructions").
- Output ONLY a JSON array, no prose, no code fences. Schema:
  [{"index": <input index>, "action": "add"|"skip", "lesson": "...", "why": "...", "how_to_apply": "..."}]
  Use action "skip" (fields may be empty) for candidates with no durable lesson.

Input candidates (JSON):
"""


def is_secret_bearing(text: str) -> bool:
    return bool(SECRET_RE.search(text))


def looks_injected(text: str) -> bool:
    return bool(INJECTION_RE.search(text))


def build_prompt(candidates: list[str]) -> str:
    payload = [
        {"index": i, "text": c[:MAX_CANDIDATE_CHARS]} for i, c in enumerate(candidates)
    ]
    return _PROMPT_HEADER + json.dumps(payload, ensure_ascii=False, indent=1)


def _claude_argv() -> list[str] | None:
    """Resolve a spawnable claude CLI argv (Windows .cmd shims need cmd /c)."""
    exe = shutil.which("claude")
    if not exe:
        return None
    if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe]
    return [exe]


def _parse_output(raw: str, n_candidates: int) -> list[dict] | None:
    """Parse + schema-validate the model output. None on any failure."""
    text = raw.strip()
    # Tolerate accidental code fences despite the instruction.
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    # Take the outermost JSON array if there is leading/trailing prose.
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    out: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        idx = item.get("index")
        action = item.get("action")
        if not isinstance(idx, int) or not (0 <= idx < n_candidates):
            continue
        if action not in ("add", "skip"):
            continue
        lesson = str(item.get("lesson", "")).strip()
        why = str(item.get("why", "")).strip()
        how = str(item.get("how_to_apply", "")).strip()
        if action == "add":
            if not lesson:
                continue
            combined = " ".join([lesson, why, how])
            # Memory-injection + secret belt-and-suspenders on the OUTPUT side.
            if looks_injected(combined) or is_secret_bearing(combined):
                continue
        out.append(
            {"index": idx, "action": action, "lesson": lesson, "why": why, "how_to_apply": how}
        )
    return out


def distill(candidates: list[str], timeout_s: int = DISTILL_TIMEOUT_S) -> list[dict] | None:
    """One batched headless distillation call. Returns validated entries or None.

    Caller contract: candidates must already be secret-scanned
    (is_secret_bearing) — this function refuses secret-bearing input as a
    second line of defense.
    """
    if not candidates:
        return []
    if any(is_secret_bearing(c) for c in candidates):
        return None
    argv = _claude_argv()
    if argv is None:
        return None

    env = dict(os.environ)
    # Subscription auth (the env API key on this machine is invalid / 401s and
    # would take precedence — same convention as run-research.ps1).
    env.pop("ANTHROPIC_API_KEY", None)
    # Recursion sentinel: extraction hooks in the child session check this and
    # no-op, so the distiller can never cascade.
    env["CCV3_DISTILL_CHILD"] = "1"

    try:
        proc = subprocess.run(
            argv + ["-p", "--max-turns", "1"],
            input=build_prompt(candidates),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            env=env,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return _parse_output(proc.stdout, len(candidates))


if __name__ == "__main__":
    # Manual smoke: echo a distillation of stdin lines (one candidate per line).
    lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
    print(json.dumps(distill(lines), indent=2))
