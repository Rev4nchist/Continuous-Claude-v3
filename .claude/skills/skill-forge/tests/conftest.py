"""Shared fixtures for the skill-forge tests.

Run from the repo root:  python -m pytest .claude/skills/skill-forge/tests
or:                      uv run --with pytest pytest .claude/skills/skill-forge/tests
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).resolve().parents[1]
REPO = SKILL_DIR.parents[2]
SCRIPTS = SKILL_DIR / "scripts"
GATE = REPO / "scripts" / "skills" / "audit-skills.mjs"

# Tests import the real modules as `scripts.<name>`, the way the CLI scripts do.
sys.path.insert(0, str(SKILL_DIR))


def write_skill(root: Path, name: str, description: str = "Does X. Use when the user asks for X.",
                body: str = "# Title\n\nDo the thing.\n", extra_fm: str = "", files: dict | None = None) -> Path:
    """Write a skill directory and return it."""
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n{extra_fm}---\n{body}", encoding="utf-8", newline="\n")
    for rel, text in (files or {}).items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
    return d


def run_gate(skill_dir: Path) -> dict:
    """The real gate on one skill directory: audit-skills.mjs --skill <dir> --json."""
    r = subprocess.run(["node", str(GATE), "--skill", str(skill_dir), "--json"],
                       capture_output=True, text=True, encoding="utf-8")
    return json.loads(r.stdout)


def gate_findings(report: dict) -> list[tuple[str, str]]:
    """Every (rule, message) in a gate report, except the listing-size rule G31."""
    return [(rid, x["msg"]) for rid, r in report["rules"].items() if rid != "G31" for x in r["findings"]]


def run_py(script: Path, *args: str, env: dict | None = None, cwd: Path | None = None):
    return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True,
                          encoding="utf-8", env=env, cwd=cwd)


@pytest.fixture
def skills_root(tmp_path):
    root = tmp_path / "skills"
    root.mkdir()
    return root


@pytest.fixture(autouse=True)
def _private_system_tempdir(tmp_path_factory, monkeypatch):
    """run_eval gives every planned run its own temp root under the system temp folder. Point that
    folder at a pytest dir so a test run leaves nothing behind."""
    import tempfile
    d = tmp_path_factory.mktemp("systemp")
    monkeypatch.setattr(tempfile, "tempdir", str(d))
