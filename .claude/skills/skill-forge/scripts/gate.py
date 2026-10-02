"""Bridge to the CCv3 skills gate (scripts/skills/audit-skills.mjs).

The gate owns every shared rule: name format, description shape and trigger, body size, references,
dated text, retired names. skill-forge scripts call it and never keep a second copy of a rule.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

GATE_REL = Path("scripts") / "skills" / "audit-skills.mjs"

# The gate rules that read only the description (DESCRIPTION_RULES in scripts/skills/lib/skill-rules.mjs,
# minus the cross-skill G30 and G31).
DESCRIPTION_GATE_RULES = "G01,G02,G08,G09,G10,G11,G12,G13,G14"

# New descriptions stay under the gate's ratchet length (G09). The hard limit is 1,024 (G08).
DESCRIPTION_MAX_CHARS = 400


class GateError(RuntimeError):
    """The gate could not run. This is never a pass."""


def find_repo_root(start: Path | None = None) -> Path | None:
    """The repo root that holds the gate. Walk up from this script, then from the cwd.

    CCV3_REPO_ROOT overrides both. The active copy under ~/.claude has no gate next to it, so a
    run from there needs the walk from the cwd or the override.
    """
    env = os.environ.get("CCV3_REPO_ROOT")
    starts = [Path(env)] if env else []
    starts += [start or Path(__file__).resolve().parent, Path.cwd()]
    for s in starts:
        for parent in [s, *s.parents]:
            if (parent / GATE_REL).is_file():
                return parent
    return None


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        raise GateError("node was not found on PATH. The skills gate (scripts/skills/audit-skills.mjs) "
                        "needs Node.js. Install Node and run this again.")
    return node


def gate_path() -> Path:
    root = find_repo_root()
    if root is None:
        raise GateError("the skills gate scripts/skills/audit-skills.mjs was not found above this script or the "
                        "current directory. Run from the continuous-claude repo or set CCV3_REPO_ROOT.")
    return root / GATE_REL


GATE_TIMEOUT_SECONDS = 30  # the same limit G32 gives the scaffold run


def run_gate(*args: str) -> subprocess.CompletedProcess:
    cmd = [find_node(), str(gate_path()), *args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=GATE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise GateError(f"the skills gate timed out after {GATE_TIMEOUT_SECONDS}s: node audit-skills.mjs {' '.join(args)}") from None


def _json(proc: subprocess.CompletedProcess) -> dict:
    try:
        return json.loads(proc.stdout)
    except ValueError:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        raise GateError("the skills gate did not return JSON: " + " | ".join(tail)) from None


def audit_skill(skill_dir: Path | str) -> dict:
    """The gate report for one skill directory (audit-skills.mjs --skill <dir> --json)."""
    return _json(run_gate("--skill", str(skill_dir), "--json"))


def check_name(name: str) -> list[dict]:
    """G05 and G06 findings for a bare name. Empty means the name is valid."""
    return _json(run_gate("--check-name", name, "--json"))["findings"]


def check_description(name: str, description: str) -> list[str]:
    """Problems with a candidate description: the 400-char cap plus the gate's description rules."""
    problems = []
    if len(description) > DESCRIPTION_MAX_CHARS:
        problems.append(f"description is {len(description)} chars (max {DESCRIPTION_MAX_CHARS})")
    if "\n" in description:
        problems.append("description must be one line")
    with tempfile.TemporaryDirectory(prefix="skill-desc-") as tmp:
        d = Path(tmp) / name
        d.mkdir()
        # Plain scalar on purpose: a ": " that Claude Code cannot parse must fail here too.
        (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {description}\n---\n# {name}\n",
                                    encoding="utf-8", newline="\n")
        report = _json(run_gate("--skill", str(d), "--rules", DESCRIPTION_GATE_RULES, "--json"))
    for rule_id, rule in report["rules"].items():
        if rule_id == "G09":  # the 400-char cap, already reported above
            continue
        problems += [f"{x['rule']} {x['msg']}" for x in rule["findings"]]
    return problems
