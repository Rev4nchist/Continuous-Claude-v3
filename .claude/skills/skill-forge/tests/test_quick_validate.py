"""quick_validate.py: one trigger rule (the gate's), upload target kept, node missing is a clear error."""

import os
import shutil
import sys
from pathlib import Path

import pytest

from conftest import SCRIPTS, run_gate, run_py, write_skill

VALIDATE = SCRIPTS / "quick_validate.py"


@pytest.mark.parametrize("description", [
    "Does X. Triggers on foo bar.",           # gate TRIGGER_RE accepts "triggers on"
    "Does X. Use this skill when Y happens.",
    "Does X. When the user asks for Y.",
    "Does X for Y.",                           # no trigger at all: the gate fails G14
    "Handles things quickly.",
    "This skill should be used for reports.",
    "Does X for creating reports.",            # the old quick_validate regex accepted "for creating"; the gate rejects it
])
def test_trigger_verdict_matches_the_gate(skills_root, description):
    d = write_skill(skills_root, "probe-skill", description=description)
    gate_says_ok = run_gate(d)["rules"]["G14"]["count"] == 0
    r = run_py(VALIDATE, str(d))
    assert (r.returncode == 0) == gate_says_ok, r.stdout + r.stderr
    if not gate_says_ok:
        assert "G14" in r.stdout


def test_the_documented_vet_skill_call_forms_both_work(skills_root):
    # vet-skill calls `quick_validate.py --skill-path <dir>/SKILL.md`; that call used to print usage and exit 1.
    d = write_skill(skills_root, "probe-skill")
    by_flag = run_py(VALIDATE, "--skill-path", str(d / "SKILL.md"))
    by_dir = run_py(VALIDATE, "--skill-path", str(d))
    assert by_flag.returncode == 0, by_flag.stdout + by_flag.stderr
    assert by_dir.returncode == 0, by_dir.stdout + by_dir.stderr


def test_there_is_no_50_to_150_word_band(skills_root):
    d = write_skill(skills_root, "probe-skill", description="Does X. Use when Y.")
    r = run_py(VALIDATE, str(d))
    assert "words" not in r.stdout.lower()


def test_upload_target_rejects_claude_code_keys_but_claude_code_target_accepts(skills_root):
    d = write_skill(skills_root, "probe-skill", extra_fm="disable-model-invocation: true\n")
    ok = run_py(VALIDATE, str(d))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    bad = run_py(VALIDATE, "--target", "upload", str(d))
    assert bad.returncode == 1
    assert "disable-model-invocation" in bad.stdout


def test_missing_node_is_a_clear_error_not_a_pass(skills_root):
    d = write_skill(skills_root, "probe-skill")
    py_dir = str(Path(sys.executable).parent)
    if shutil.which("node", path=py_dir):
        pytest.skip("node sits next to python on this machine")
    env = {k: v for k, v in os.environ.items() if k.upper() != "PATH"}
    env["PATH"] = py_dir
    r = run_py(VALIDATE, str(d), env=env)
    assert r.returncode != 0
    assert "node" in (r.stdout + r.stderr).lower()


def test_todowrite_is_not_a_todo_marker(skills_root):
    d = write_skill(skills_root, "probe-skill", body="# Title\n\nCall TodoWrite and update the todos.\n")
    r = run_py(VALIDATE, str(d))
    assert r.returncode == 0, r.stdout + r.stderr


def test_a_backticked_todo_is_documentation_not_a_marker(skills_root):
    d = write_skill(skills_root, "probe-skill", body="# Title\n\nReplace every `TODO` before you ship.\n")
    r = run_py(VALIDATE, str(d))
    assert r.returncode == 0, r.stdout + r.stderr


def test_only_a_runnable_script_needs_a_shebang(skills_root):
    d = write_skill(skills_root, "probe-skill", files={
        "scripts/lib.py": "def f():\n    return 1\n",
        "scripts/run.py": "import sys\nif __name__ == '__main__':\n    sys.exit(0)\n"})
    r = run_py(VALIDATE, str(d))
    assert "run.py: missing shebang" in r.stdout
    assert "lib.py" not in r.stdout


def test_a_real_todo_marker_fails(skills_root):
    d = write_skill(skills_root, "probe-skill", body="# Title\n\nTODO: write this.\n")
    r = run_py(VALIDATE, str(d))
    assert r.returncode == 1
    assert "TODO" in r.stdout


def test_a_new_skill_with_a_ratchet_finding_fails(skills_root):
    # G24: a reference over 100 lines with no contents. A skill that is not in the baseline gets no slack.
    big = "# Big\n\n" + "line\n" * 120
    d = write_skill(skills_root, "probe-skill", body="# Title\n\nSee [big](references/big.md).\n", files={"references/big.md": big})
    r = run_py(VALIDATE, str(d))
    assert r.returncode == 1
    assert "G24" in r.stdout


def test_a_missing_examples_section_is_not_a_warning(skills_root):
    d = write_skill(skills_root, "probe-skill")
    r = run_py(VALIDATE, str(d))
    assert "example" not in r.stdout.lower()
