"""Evals for an imported skill tree: a hub skill plus a vendored companion folder.

Three runner features, each with the way it can fail:
  --companion  The hub's ../_vendor/... links dangle in the temp project, or the baseline can read
               the vendored text (the lift number then proves nothing).
  --inject     The playbook text reaches one arm only, or the run does not record that it was injected.
  checks       A "never" case is graded by an LLM instead of a regex, or a run with no answer passes
               a not_regex check because the empty text matches nothing.
`headless.run_claude` is replaced by a fake that returns a recorded-shape stream, so nothing is spent.
"""

import json
import shutil
from pathlib import Path

import pytest

from conftest import SCRIPTS, run_py, write_skill
from test_eval_validity import fake_run, init, patch_run, result, stream, tool

from scripts import headless, run_eval  # noqa: E402  (conftest puts the skill dir on sys.path)
from scripts.evals import EvalError, load_evals  # noqa: E402

CANARY = "CANARY-7f3a9c-vendored-text"
EVAL = {"id": 1, "name": "one", "prompt": "do it", "files": [], "skills": [], "assertions": ["it works"], "checks": []}


def make_companion(tmp_path) -> Path:
    """A _vendor folder with one source: skills/x/SKILL.md and a shared common/ file."""
    vendor = tmp_path / "companion" / "_vendor"
    (vendor / "src" / "skills" / "x").mkdir(parents=True)
    (vendor / "src" / "common").mkdir(parents=True)
    (vendor / "src" / "skills" / "x" / "SKILL.md").write_text(f"# x\n{CANARY}\nSee ../../common/c.md\n", encoding="utf-8")
    (vendor / "src" / "common" / "c.md").write_text("# common\n", encoding="utf-8")
    return vendor


def plan(tmp_path, ev=None, companion=True, inject=None):
    """A planned eval of a hub skill. Returns (home, companion_dir, with_spec, base_spec)."""
    skill = write_skill(tmp_path / "repo" / ".claude" / "skills", "hub-skill",
                        body="# Hub\n\nRead [x](../_vendor/src/skills/x/SKILL.md).\n")
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    comp = make_companion(tmp_path) if companion else None
    specs = run_eval.plan_runs(skill, [ev or EVAL], headless.resolve_models("sonnet"), tmp_path / "out", tmp_path / "work",
                               home=home, companion=comp, inject=inject)
    by = {s.config: s for s in specs}
    return home, comp, by["with_skill"], by["without_skill"]


# ------------------------------------------------------------------ --companion

def test_the_companion_sits_next_to_the_eval_copy_so_the_hub_links_resolve(tmp_path):
    _, _, w, _ = plan(tmp_path)
    skills = w.cwd / ".claude" / "skills"
    assert (skills / "_vendor" / "src" / "common" / "c.md").is_file()
    # the hub's own relative link, written for the real tree, resolves from the renamed copy
    assert (w.copy_dir / ".." / "_vendor" / "src" / "skills" / "x" / "SKILL.md").resolve().is_file()
    # and the vendored skill's ../../common link resolves from where the companion landed
    assert (skills / "_vendor" / "src" / "skills" / "x" / ".." / ".." / "common" / "c.md").resolve().is_file()


def test_the_baseline_gets_no_companion_so_the_canary_never_reaches_it(tmp_path):
    _, _, w, b = plan(tmp_path)
    def holds_canary(cwd):
        return [p for p in Path(cwd).rglob("*") if p.is_file() and CANARY in p.read_text(encoding="utf-8", errors="ignore")]
    assert holds_canary(w.cwd), "with_skill must carry the vendored text"
    assert holds_canary(b.cwd) == []
    assert not (b.cwd / ".claude" / "skills" / "_vendor").exists()


def test_both_arms_deny_reads_of_the_real_vendor_tree(tmp_path):
    _, _, w, b = plan(tmp_path)
    for spec in (w, b):
        deny = json.loads(spec.settings_path.read_text())["permissions"]["deny"]
        assert "Read(~/.claude/skills/_vendor/**)" in deny, deny
        assert "Read(~/.claude/skills/hub-skill/**)" in deny  # the existing deny stays


def test_both_arms_deny_reads_of_the_companion_repo_source(tmp_path):
    _, comp, w, b = plan(tmp_path)
    src = Path(comp).resolve().as_posix()
    for spec in (w, b):
        deny = json.loads(spec.settings_path.read_text())["permissions"]["deny"]
        assert any(src in r for r in deny), deny


def test_without_a_companion_nothing_changes(tmp_path):
    _, _, w, b = plan(tmp_path, companion=False)
    assert not (w.cwd / ".claude" / "skills" / "_vendor").exists()
    for spec in (w, b):
        assert "Read(~/.claude/skills/_vendor/**)" not in json.loads(spec.settings_path.read_text())["permissions"]["deny"]


def test_a_baseline_that_reads_the_real_vendor_tree_is_contaminated_and_excluded(tmp_path, monkeypatch):
    home, _, _, b = plan(tmp_path)
    real = home / ".claude" / "skills" / "_vendor" / "src" / "skills" / "x" / "SKILL.md"
    out = stream(init(["x"]), tool("Read", file_path=str(real)), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(b, 10)
    assert rec["baseline_contaminated"] is True
    assert "contaminated" in rec["excluded"]
    assert rec["navigation"]["companion_files_read"], rec["navigation"]


def test_a_with_skill_read_of_the_companion_is_recorded_and_still_counts(tmp_path, monkeypatch):
    _, _, w, _ = plan(tmp_path)
    read = w.cwd / ".claude" / "skills" / "_vendor" / "src" / "skills" / "x" / "SKILL.md"
    out = stream(init(["x", w.skill_alias]), tool("Skill", skill=w.skill_alias), tool("Read", tid="t2", file_path=str(read)), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(w, 10)
    assert rec["excluded"] is None, rec["excluded"]
    assert rec["navigation"]["companion_files_read"] == ["_vendor/src/skills/x/SKILL.md"]
    assert rec["navigation"]["reads_outside_skill"] == []
    assert rec["companion"] == "_vendor"


def test_a_companion_that_cannot_be_copied_is_an_eval_error_that_names_the_cause(tmp_path, monkeypatch):
    # Found on the real upstream tree: a path over 260 characters fails the copy on Windows with
    # shutil.Error([... WinError 3 ...]). That must reach the user as a message, not a traceback.
    def boom(src, dest):
        raise shutil.Error([(str(src), str(dest), "[WinError 3] The system cannot find the path specified")])
    monkeypatch.setattr(headless, "copy_companion", boom)
    with pytest.raises(EvalError, match=r"(?i)companion.*WinError 3"):
        plan(tmp_path)


def test_a_companion_that_is_not_a_folder_is_a_cli_error(tmp_path):
    evals = tmp_path / "evals.json"
    evals.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(3)]))
    skill = write_skill(tmp_path, "hub-skill")
    r = run_py(SCRIPTS / "run_eval.py", "behavior", "--skill-path", str(skill), "--evals", str(evals),
               "--companion", str(tmp_path / "missing"), "--dry-run")
    assert r.returncode == 1
    assert "companion" in r.stderr.lower()


# --------------------------------------------------------------------- --inject

def test_inject_prepends_the_text_to_the_prompt_in_both_arms_and_the_run_records_it(tmp_path, monkeypatch):
    playbook = tmp_path / "playbook.md"
    playbook.write_text("PLAYBOOK: stop on the first capacity error.\n", encoding="utf-8")
    inject = run_eval.load_inject(playbook)
    _, _, w, b = plan(tmp_path, inject=inject)
    for spec in (w, b):
        assert spec.prompt.startswith("PLAYBOOK: stop on the first capacity error."), spec.prompt
        assert spec.prompt.endswith("do it")
    seen = []
    patch_run(monkeypatch, lambda cmd, prompt, cwd, timeout=600: seen.append(prompt) or fake_run(stream(init(["x"]), result())))
    rec = run_eval.execute(b, 10)
    assert seen[0] == b.prompt
    assert rec["inject"] == {"file": str(playbook), "chars": len("PLAYBOOK: stop on the first capacity error.\n")}


def test_without_inject_the_prompt_is_the_eval_prompt_and_run_json_says_none(tmp_path, monkeypatch):
    _, _, w, b = plan(tmp_path)
    assert w.prompt == b.prompt == "do it"
    patch_run(monkeypatch, lambda *a, **k: fake_run(stream(init(["x"]), result())))
    assert run_eval.execute(b, 10)["inject"] is None


def test_an_empty_inject_file_is_an_error(tmp_path):
    empty = tmp_path / "empty.md"
    empty.write_text("  \n", encoding="utf-8")
    with pytest.raises(EvalError, match="empty"):
        run_eval.load_inject(empty)
    with pytest.raises(EvalError, match="inject"):
        run_eval.load_inject(tmp_path / "missing.md")


# ------------------------------------------------------------- checks: loading

def _write_evals(tmp_path, extra):
    items = [{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(2)] + [extra]
    p = tmp_path / "evals.json"
    p.write_text(json.dumps(items), encoding="utf-8")
    return p


def test_an_eval_may_carry_checks_and_needs_no_assertion_when_it_has_one(tmp_path):
    p = _write_evals(tmp_path, {"query": "q3", "checks": [{"type": "not_regex", "pattern": "retry", "flags": "i"}]})
    ev = load_evals(p)[2]
    assert ev["checks"] == [{"type": "not_regex", "pattern": "retry", "flags": "i"}]
    assert ev["assertions"] == []


@pytest.mark.parametrize("check", [
    {"type": "contains", "pattern": "x"},
    {"type": "regex"},
    {"type": "regex", "pattern": "("},
    {"type": "regex", "pattern": "x", "flags": "z"},
    "not-an-object",
])
def test_a_malformed_check_is_an_error(tmp_path, check):
    p = _write_evals(tmp_path, {"query": "q3", "expected_behavior": ["x"], "checks": [check]})
    with pytest.raises(EvalError, match="check"):
        load_evals(p)


def test_an_eval_with_neither_assertions_nor_checks_is_still_an_error(tmp_path):
    p = _write_evals(tmp_path, {"query": "q3", "checks": []})
    with pytest.raises(EvalError, match="nothing to grade"):
        load_evals(p)


# ------------------------------------------------------------- checks: grading

def graded_run(tmp_path, monkeypatch, checks, final_text, assertions=(), subtype="success"):
    """Run a baseline spec through a fake stream, then return (grading, grader_calls)."""
    ev = {**EVAL, "assertions": list(assertions), "checks": checks}
    _, _, _, b = plan(tmp_path, ev=ev)
    out = stream(init(["x"]), result(subtype, final_text)) if subtype == "success" else stream(init(["x"]), tool("Grep"), result(subtype))
    patch_run(monkeypatch, lambda *a, **k: fake_run(out, 0 if subtype == "success" else 1))
    run_eval.execute(b, 10)
    calls = []

    def grader(cmd, prompt, cwd, timeout=600):
        calls.append(prompt)
        exps = [{"text": a, "passed": True, "evidence": "e"} for a in assertions]
        return fake_run(stream(result(text="```json\n" + json.dumps({"expectations": exps}) + "\n```")))
    patch_run(monkeypatch, grader)
    return run_eval.grade_run(b.run_dir, headless.resolve_models("sonnet")[0]), calls


def test_checks_are_graded_by_regex_with_no_grader_call(tmp_path, monkeypatch):
    checks = [{"type": "not_regex", "pattern": "retry with backoff", "flags": "i"},
              {"type": "regex", "pattern": "stop"}]
    g, calls = graded_run(tmp_path, monkeypatch, checks, "I would stop all load and report the 429.")
    assert calls == [], "a run with only checks must not reach the LLM grader"
    assert [e["passed"] for e in g["expectations"]] == [True, True]
    assert g["summary"] == {"passed": 2, "failed": 0, "total": 2, "pass_rate": 1.0}


def test_a_not_regex_check_fails_when_the_answer_matches_it_and_flags_apply(tmp_path, monkeypatch):
    checks = [{"type": "not_regex", "pattern": "retry with backoff", "flags": "i"},
              {"type": "regex", "pattern": "STOP"}]  # no i flag: lower-case "stop" must not match
    g, _ = graded_run(tmp_path, monkeypatch, checks, "Just Retry With Backoff and stop.")
    assert [e["passed"] for e in g["expectations"]] == [False, False]
    assert "Retry With Backoff" in g["expectations"][0]["evidence"]
    assert g["summary"]["failed"] == 2 and g["summary"]["pass_rate"] == 0.0


def test_checks_and_assertions_are_graded_side_by_side(tmp_path, monkeypatch):
    checks = [{"type": "not_regex", "pattern": "python3"}]
    g, calls = graded_run(tmp_path, monkeypatch, checks, "Use python.", assertions=["it works"])
    assert len(calls) == 1 and "it works" in calls[0]
    assert "python3" not in calls[0], "the grader must not see the deterministic checks"
    assert len(g["expectations"]) == 2 and g["summary"]["total"] == 2 and g["summary"]["passed"] == 2


def test_a_run_with_no_answer_fails_every_check_instead_of_passing_not_regex_on_empty_text(tmp_path, monkeypatch):
    checks = [{"type": "not_regex", "pattern": "retry"}]
    g, calls = graded_run(tmp_path, monkeypatch, checks, "", subtype="error_max_turns")
    assert calls == []
    assert g["no_answer"] is True
    assert [e["passed"] for e in g["expectations"]] == [False]
    assert g["summary"]["total"] == 1 and g["summary"]["pass_rate"] == 0.0


def test_run_json_records_the_checks(tmp_path, monkeypatch):
    checks = [{"type": "regex", "pattern": "x", "flags": ""}]
    ev = {**EVAL, "checks": checks}
    _, _, _, b = plan(tmp_path, ev=ev)
    patch_run(monkeypatch, lambda *a, **k: fake_run(stream(init(["x"]), result())))
    assert run_eval.execute(b, 10)["checks"] == checks


# ------------------------------------------------------------------ dry run, end to end

def test_the_dry_run_shows_the_project_layout_the_deny_rules_and_the_injection(tmp_path):
    vendor = make_companion(tmp_path)
    playbook = tmp_path / "playbook.md"
    playbook.write_text("PLAYBOOK rule text\n", encoding="utf-8")
    evals = tmp_path / "evals.json"
    evals.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(3)]))
    skill = write_skill(tmp_path / "skills", "hub-skill", body="# Hub\n\n[x](../_vendor/src/skills/x/SKILL.md)\n")
    r = run_py(SCRIPTS / "run_eval.py", "behavior", "--skill-path", str(skill), "--evals", str(evals), "--models", "sonnet",
               "--companion", str(vendor), "--inject", str(playbook), "--eval-ids", "1", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Read(~/.claude/skills/_vendor/**)" in r.stdout
    layout = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("project:")]
    assert len(layout) == 2, r.stdout
    with_line = next(ln for ln in layout if "with_skill" in ln)
    base_line = next(ln for ln in layout if "without_skill" in ln)
    assert "_vendor" in with_line and "hub-skill-eval" in with_line
    assert "_vendor" not in base_line
    assert "PLAYBOOK rule text" in r.stdout  # the stdin line shows the injected prompt
    assert "inject:" in r.stdout and "0 turns spent" in r.stdout
