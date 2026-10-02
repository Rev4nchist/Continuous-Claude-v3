"""init_skill.py: the scaffold must pass the gate, refuse bad names, and fail loudly until edited."""

import os
from pathlib import Path

import pytest

from conftest import REPO, SCRIPTS, gate_findings, run_gate, run_py

INIT = SCRIPTS / "init_skill.py"
VALIDATE = SCRIPTS / "quick_validate.py"


def test_fresh_scaffold_passes_the_gate(tmp_path):
    r = run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    assert r.returncode == 0, r.stdout + r.stderr
    report = run_gate(tmp_path / "my-new-skill")
    assert report["hardFailures"] == 0, report["rules"]
    assert report["regressions"] == [], report["regressions"]
    assert gate_findings(report) == []


def test_scaffold_has_no_when_to_use_section(tmp_path):
    run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    text = (tmp_path / "my-new-skill" / "SKILL.md").read_text(encoding="utf-8")
    assert "when to use" not in text.lower().replace("use when", "")


def test_default_scaffold_is_one_file(tmp_path):
    run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    assert sorted(p.name for p in (tmp_path / "my-new-skill").iterdir()) == ["SKILL.md"]


def test_flags_add_dirs_and_the_scaffold_still_passes_the_gate(tmp_path):
    r = run_py(INIT, "my-new-skill", "--path", str(tmp_path), "--scripts", "--references", "--assets")
    assert r.returncode == 0, r.stdout + r.stderr
    d = tmp_path / "my-new-skill"
    assert all((d / sub).is_dir() for sub in ("scripts", "references", "assets"))
    assert gate_findings(run_gate(d)) == []


@pytest.mark.parametrize("name", ["Bad_Name", "has_underscore", "claude-helper", "a" * 65, "review", "-lead", "UPPER"])
def test_bad_name_is_rejected_and_nothing_is_written(tmp_path, name):
    r = run_py(INIT, "--path", str(tmp_path), "--", name)  # "--": a name such as -lead is not an option
    assert r.returncode != 0
    assert "G05" in r.stdout + r.stderr or "G06" in r.stdout + r.stderr
    assert list(tmp_path.iterdir()) == []


def test_default_path_is_the_repo_skills_dir_and_dry_run_writes_nothing():
    r = run_py(INIT, "zz-dry-run-probe", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    expected = REPO / ".claude" / "skills" / "zz-dry-run-probe"
    assert str(expected) in r.stdout
    assert not expected.exists()


def test_scaffold_into_the_active_skills_dir_is_refused(tmp_path):
    home = tmp_path / "home"
    (home / ".claude" / "skills").mkdir(parents=True)
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    r = run_py(INIT, "my-new-skill", "--path", str(home / ".claude" / "skills"), env=env)
    assert r.returncode != 0
    assert "active" in (r.stdout + r.stderr).lower()
    assert not (home / ".claude" / "skills" / "my-new-skill").exists()


def test_scaffold_fails_quick_validate_until_the_placeholders_are_edited(tmp_path):
    run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    r = run_py(VALIDATE, str(tmp_path / "my-new-skill"))
    assert r.returncode == 1
    assert "placeholder" in (r.stdout + r.stderr).lower()


def test_an_existing_skill_dir_is_never_overwritten(tmp_path):
    run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    md = tmp_path / "my-new-skill" / "SKILL.md"
    md.write_text("edited by hand", encoding="utf-8")
    r = run_py(INIT, "my-new-skill", "--path", str(tmp_path))
    assert r.returncode != 0
    assert md.read_text(encoding="utf-8") == "edited by hand"
