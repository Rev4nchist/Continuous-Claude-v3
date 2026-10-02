"""Eval validity: the run must test what it claims to test, and a broken run must never count.

Each test names the way a result could be wrong. `headless.run_claude` is replaced by a fake that
returns a recorded-shape stream, so these tests spend nothing.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import SCRIPTS, SKILL_DIR, write_skill

from scripts import headless, run_eval  # noqa: E402  (conftest puts the skill dir on sys.path)


# ------------------------------------------------------------------ helpers

def stream(*events) -> str:
    return "\n".join(json.dumps(e) for e in events)


def init(skills):
    return {"type": "system", "subtype": "init", "skills": skills}


def tool(name, tid="t1", **inp):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def tool_error(tid="t1", text="denied"):
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text, "is_error": True}]}}


def result(subtype="success", text="done"):
    ev = {"type": "result", "subtype": subtype, "is_error": subtype != "success", "num_turns": 2}
    if subtype == "success":
        ev["result"] = text
    return ev


def fake_run(stdout, returncode=0):
    return headless.ClaudeRun(stdout, "", returncode, None if returncode == 0 else f"exit {returncode}", 1.0)


def patch_run(monkeypatch, fn):
    monkeypatch.setattr(headless, "run_claude", fn)


EVAL = {"id": 1, "name": "one", "prompt": "do it", "files": [], "skills": [], "assertions": ["it works"]}


def plan(tmp_path, personal=True, settings=None):
    """A planned eval of probe-skill with a fake home. Returns (skill, home, with_spec, base_spec)."""
    skill = write_skill(tmp_path / "repo" / ".claude" / "skills", "probe-skill", files={"references/a.md": "# A\n", "references/b.md": "# B\n"})
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    if personal:
        write_skill(home / ".claude" / "skills", "probe-skill", files={"references/a.md": "# A\n", "references/b.md": "# B\n"})
    if settings is not None:
        (home / ".claude" / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    specs = run_eval.plan_runs(skill, [EVAL], headless.resolve_models("sonnet"), tmp_path / "out", tmp_path / "work", home=home)
    by = {s.config: s for s in specs}
    return skill, home, by["with_skill"], by["without_skill"]


# ------------------------------------------- 1, 4: the personal copy must not win

def test_with_skill_runs_a_renamed_copy_and_the_baseline_gets_no_copy(tmp_path):
    _, _, w, b = plan(tmp_path)
    assert w.skill_alias and w.skill_alias != "probe-skill" and w.skill_alias.startswith("probe-skill")
    skills_dir = w.cwd / ".claude" / "skills"
    assert [p.name for p in skills_dir.iterdir()] == [w.skill_alias]
    md = (skills_dir / w.skill_alias / "SKILL.md").read_text(encoding="utf-8")
    assert f"name: {w.skill_alias}" in md and "description: Does X. Use when the user asks for X." in md
    assert b.skill_alias is None
    assert not list((b.cwd / ".claude" / "skills").glob("probe-skill*")) if (b.cwd / ".claude" / "skills").exists() else True


def test_reads_under_the_personal_copy_count_as_inside_the_skill(tmp_path, monkeypatch):
    _, home, w, _ = plan(tmp_path)
    personal = home / ".claude" / "skills" / "probe-skill"
    out = stream(init(["x", w.skill_alias]), tool("Skill", skill=w.skill_alias),
                 tool("Read", tid="t2", file_path=str(personal / "references" / "a.md")), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(w, 10)
    assert rec["navigation"]["skill_files_read"] == ["references/a.md"]
    assert rec["navigation"]["skill_files_unread"] == ["references/b.md"]
    assert rec["navigation"]["reads_outside_skill"] == []


def test_a_baseline_that_reads_the_personal_copy_is_contaminated_and_excluded(tmp_path, monkeypatch):
    _, home, _, b = plan(tmp_path)
    personal = home / ".claude" / "skills" / "probe-skill"
    out = stream(init(["x"]), tool("Read", file_path=str(personal / "SKILL.md")), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(b, 10)
    assert rec["baseline_contaminated"] is True
    assert "contaminated" in rec["excluded"]


def test_the_users_skill_overrides_are_in_both_settings_files(tmp_path):
    _, _, w, b = plan(tmp_path, settings={"skillOverrides": {"other-skill": "name-only"}, "apiKeyHelper": "x"})
    for spec in (w, b):
        cfg = json.loads(spec.settings_path.read_text())
        assert cfg["skillOverrides"] == {"other-skill": "name-only", "probe-skill": "off"}
        assert "apiKeyHelper" not in cfg  # only the override map is copied


def _plan_mismatched(tmp_path):
    """probe-skill's folder is probe_skill: Claude Code can register it under either name."""
    skills = tmp_path / "repo" / ".claude" / "skills"
    write_skill(skills, "probe-skill")
    (skills / "probe-skill").rename(skills / "probe_skill")
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    specs = run_eval.plan_runs(skills / "probe_skill", [EVAL], headless.resolve_models("sonnet"),
                               tmp_path / "out", tmp_path / "work", home=home)
    by = {s.config: s for s in specs}
    return by["with_skill"], by["without_skill"]


def test_a_folder_name_that_differs_from_the_frontmatter_name_is_also_off(tmp_path):
    w, b = _plan_mismatched(tmp_path)
    for spec in (w, b):
        cfg = json.loads(spec.settings_path.read_text())
        assert cfg["skillOverrides"]["probe-skill"] == "off" and cfg["skillOverrides"]["probe_skill"] == "off"


def test_both_settings_files_deny_reads_of_the_real_skill_folders(tmp_path):
    w, b = _plan_mismatched(tmp_path)
    for spec in (w, b):
        deny = json.loads(spec.settings_path.read_text())["permissions"]["deny"]
        assert "Read(~/.claude/skills/probe-skill/**)" in deny and "Read(~/.claude/skills/probe_skill/**)" in deny


def test_a_with_skill_run_where_the_real_skill_fires_is_excluded(tmp_path, monkeypatch):
    w, _ = _plan_mismatched(tmp_path)
    out = stream(init(["x", w.skill_alias, "probe_skill"]), tool("Skill", skill="probe_skill"), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(w, 10)
    assert rec["excluded"] and "real skill fired" in rec["excluded"], rec["excluded"]


def test_a_baseline_where_the_folder_name_fires_is_excluded(tmp_path, monkeypatch):
    _, b = _plan_mismatched(tmp_path)
    out = stream(init(["x"]), tool("Skill", skill="probe_skill"), result())
    patch_run(monkeypatch, lambda *a, **k: fake_run(out))
    rec = run_eval.execute(b, 10)
    assert rec["excluded"] and "fired" in rec["excluded"], rec["excluded"]


# ----------------------------------------------- 2, 3, 5: runs that must not count

def _case_ids(cases):
    return [c[0] for c in cases]


CASES = [
    # (id, config, builder(alias) -> (stdout, returncode), expected substring of `excluded`, or None)
    ("clean-with", "with_skill", lambda a: (stream(init(["x", a]), tool("Skill", skill=a), result()), 0), None),
    ("clean-baseline", "without_skill", lambda a: (stream(init(["x"]), result()), 0), None),
    ("baseline-lists-skill", "without_skill", lambda a: (stream(init(["x", "probe-skill"]), result()), 0), "listed"),
    ("baseline-lists-plugin-skill", "without_skill", lambda a: (stream(init(["plug:probe-skill"]), result()), 0), "listed"),
    ("baseline-fires-skill", "without_skill", lambda a: (stream(init(["x"]), tool("Skill", skill="plug:probe-skill"), result()), 0), "fired"),
    ("with-exit-1", "with_skill", lambda a: (stream(init([a]), result()), 1), "exit 1"),
    ("with-not-listed", "with_skill", lambda a: (stream(init(["x"]), result()), 0), "not listed"),
    ("no-result-event-exit-0", "with_skill", lambda a: (stream(init([a]), tool("Skill", skill=a)), 0), "no result"),
    ("max-turns-exit-0", "with_skill", lambda a: (stream(init([a]), tool("Skill", skill=a), result("error_max_turns")), 0), "error_max_turns"),
    ("skill-load-denied", "with_skill", lambda a: (stream(init([a]), tool("Skill", skill=a), tool_error(), result()), 0), "skill load failed"),
]


@pytest.mark.parametrize("case", CASES, ids=_case_ids(CASES))
def test_a_run_that_cannot_count_is_excluded_with_its_reason(tmp_path, monkeypatch, case):
    _, cfg, build, want = case
    _, _, w, b = plan(tmp_path)
    spec = w if cfg == "with_skill" else b
    stdout, code = build(w.skill_alias)
    patch_run(monkeypatch, lambda *a, **k: fake_run(stdout, code))
    rec = run_eval.execute(spec, 10)
    if want is None:
        assert rec["excluded"] is None, rec["excluded"]
    else:
        assert rec["excluded"] and want in rec["excluded"], rec["excluded"]


def test_the_result_error_helper_reads_the_subtype():
    ok = headless.parse_stream(stream(result()))
    assert headless.result_error(ok) is None
    assert "no result" in headless.result_error(headless.parse_stream(stream(init(["a"]))))
    assert "error_max_turns" in headless.result_error(headless.parse_stream(stream(result("error_max_turns"))))


def test_an_excluded_run_is_not_graded_and_the_benchmark_skips_it(tmp_path, monkeypatch):
    _, _, _, b = plan(tmp_path)
    patch_run(monkeypatch, lambda *a, **k: fake_run(stream(init(["probe-skill"]), result())))
    rec = run_eval.execute(b, 10)
    assert rec["excluded"]
    patch_run(monkeypatch, lambda *a, **k: pytest.fail("an excluded run must not reach the grader"))
    g = run_eval.grade_run(b.run_dir, headless.resolve_models("sonnet")[0])
    assert g["excluded"] == rec["excluded"] and g["summary"]["total"] == 0 and g["summary"]["pass_rate"] is None
    # the benchmark: a good run and the excluded run
    good = tmp_path / "out" / "sonnet" / "eval-1" / "with_skill" / "run-1"
    good.mkdir(parents=True)
    (good / "run.json").write_text(json.dumps({"excluded": None}), encoding="utf-8")
    (good / "grading.json").write_text(json.dumps({"expectations": [{"text": "a", "passed": True, "evidence": "e"}],
                                                   "summary": {"passed": 1, "failed": 0, "total": 1, "pass_rate": 1.0}}), encoding="utf-8")
    r = subprocess.run([sys.executable, str(SCRIPTS / "aggregate_benchmark.py"), str(tmp_path / "out" / "sonnet"), "--skill-name", "probe-skill"],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Skipped 1 excluded run" in r.stdout
    bench = json.loads((tmp_path / "out" / "sonnet" / "benchmark.json").read_text(encoding="utf-8"))
    assert [x["configuration"] for x in bench["runs"]] == ["with_skill"]


# ------------------------------------------------------------ 7: a blind grader

def test_the_grader_sees_only_the_transcript_and_the_outputs(tmp_path, monkeypatch):
    run_dir = tmp_path / "out" / "sonnet" / "eval-1" / "with_skill" / "run-1"
    (run_dir / "outputs").mkdir(parents=True)
    (run_dir / "run.json").write_text(json.dumps({"assertions": ["a"], "skill_fired": True, "config": "with_skill", "excluded": None}), encoding="utf-8")
    (run_dir / "transcript.md").write_text("# Transcript\n", encoding="utf-8")
    (run_dir / "outputs" / "response.md").write_text("answer", encoding="utf-8")
    seen = {}

    def fake(cmd, prompt, cwd, timeout=600):
        seen.update(prompt=prompt, cwd=Path(cwd), files=sorted(os.listdir(cwd)))
        return fake_run(stream(result(text='```json\n{"expectations": [{"text": "a", "passed": true, "evidence": "e"}]}\n```')))

    patch_run(monkeypatch, fake)
    g = run_eval.grade_run(run_dir, headless.resolve_models("sonnet")[0])
    assert g["summary"]["passed"] == 1
    assert seen["files"] == ["outputs", "transcript.md"]
    assert seen["cwd"] != run_dir
    assert "skill_fired" not in seen["prompt"] and "with_skill" not in seen["prompt"] and "run.json" not in seen["prompt"]
    assert (run_dir / "grading.json").is_file()


# ---------------------------------------------------- 8: trigger runs that error

def _candidate(cwd):
    return os.listdir(Path(cwd) / ".claude" / "skills")[0]


def _trigger(tmp_path, items, monkeypatch, fake, **kw):
    skill = write_skill(tmp_path / "repo" / ".claude" / "skills", "probe-skill")
    patch_run(monkeypatch, fake)
    return run_eval.run_trigger_eval(items, skill, "Does X. Use when Y.", headless.resolve_models("sonnet"), 1, 10, 1, **kw)


def test_a_fired_trigger_run_that_then_hits_max_turns_still_counts_as_fired(tmp_path, monkeypatch):
    def fake(cmd, prompt, cwd, timeout=120):
        return fake_run(stream(tool("Skill", skill=_candidate(cwd)), result("error_max_turns")), 1)

    out = _trigger(tmp_path, [{"query": "q", "should_trigger": True}], monkeypatch, fake)
    r = out["results"][0]
    assert (r["triggers"], r["runs"], r["pass"]) == (1, 1, True)


def test_too_many_failed_trigger_runs_stop_the_eval_with_a_clear_error(tmp_path, monkeypatch):
    fake = lambda cmd, prompt, cwd, timeout=120: headless.ClaudeRun("", "", None, "spawn failed: x", 0.1)  # noqa: E731
    with pytest.raises(run_eval.TriggerRunError, match="failed"):
        _trigger(tmp_path, [{"query": f"q{i}", "should_trigger": True} for i in range(4)], monkeypatch, fake)


def test_a_query_whose_runs_all_failed_is_unmeasured_not_a_zero_of_zero_failure(tmp_path, monkeypatch):
    def fake(cmd, prompt, cwd, timeout=120):
        if prompt == "bad":
            return headless.ClaudeRun("", "", None, "timeout", 0.1)
        return fake_run(stream(tool("Skill", skill=_candidate(cwd)), result()))

    items = [{"query": "bad", "should_trigger": True}] + [{"query": f"ok{i}", "should_trigger": True} for i in range(9)]
    out = _trigger(tmp_path, items, monkeypatch, fake)
    assert [r["query"] for r in out["results"]] == [f"ok{i}" for i in range(9)]
    assert out["unmeasured"] == ["bad"]
    assert out["summary"]["total"] == 9 and out["summary"]["failed"] == 0


def test_the_loop_stops_with_a_clear_message_when_trigger_runs_fail(tmp_path):
    skill = write_skill(tmp_path, "probe-skill")
    sets = tmp_path / "t.json"
    sets.write_text(json.dumps([{"query": "q", "should_trigger": True}]), encoding="utf-8")
    code = ("import sys; sys.path.insert(0, %r)\nfrom scripts import run_loop, run_eval\n"
            "def boom(*a, **k): raise run_eval.TriggerRunError('3 of 4 trigger runs failed')\n"
            "run_loop.run_trigger_eval = boom\n"
            "sys.argv = ['run_loop.py', '--eval-set', %r, '--skill-path', %r, '--report', 'none', '--holdout', '0']\n"
            "run_loop.main()\n") % (str(SKILL_DIR), str(sets), str(skill))
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode != 0
    assert "trigger runs failed" in r.stderr


# ---------------------------------------------- 17: an empty trigger set

@pytest.mark.parametrize("content", ["[]", "{}", '[{"query": "q"}]', '[{"should_trigger": true}]'])
def test_an_empty_or_malformed_trigger_set_is_rejected(tmp_path, content):
    skill = write_skill(tmp_path, "probe-skill")
    sets = tmp_path / "t.json"
    sets.write_text(content, encoding="utf-8")
    for argv in (["run_eval.py", "trigger"], ["run_loop.py"]):
        script = SCRIPTS / argv[0]
        args = [str(script), *argv[1:], "--eval-set", str(sets), "--skill-path", str(skill), "--dry-run"]
        if argv[0] == "run_loop.py":
            args += ["--report", "none"]
        r = subprocess.run([sys.executable, *args], capture_output=True, text=True, encoding="utf-8")
        assert r.returncode == 1 and "trigger" in r.stderr.lower(), (argv, r.stdout, r.stderr)


# ----------------------------------------------------------- 9, 10: the child env

def test_run_claude_passes_the_cleaned_env_to_the_child(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-test")
    code = "import os;print('ANTHROPIC_API_KEY' in os.environ, 'ANTHROPIC_AUTH_TOKEN' in os.environ)"
    run = headless.run_claude([sys.executable, "-c", code], "", tmp_path)
    assert run.stdout.strip() == "False False"


def test_the_auth_token_is_removed_as_well_as_the_api_key():
    env = headless.child_env({"ANTHROPIC_AUTH_TOKEN": "t", "anthropic_api_key": "k", "PATH": "p"})
    assert env == {"PATH": "p"}


def test_an_api_key_helper_in_the_user_settings_is_reported(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    assert headless.api_key_helper_warning(home) is None
    (home / ".claude" / "settings.json").write_text(json.dumps({"apiKeyHelper": "get-key.sh"}), encoding="utf-8")
    assert "apiKeyHelper" in headless.api_key_helper_warning(home)


def test_the_dry_run_prints_the_api_key_helper_warning(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"apiKeyHelper": "get-key.sh"}), encoding="utf-8")
    skill = write_skill(tmp_path, "probe-skill")
    evals = tmp_path / "e.json"
    evals.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(3)]), encoding="utf-8")
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    r = subprocess.run([sys.executable, str(SCRIPTS / "run_eval.py"), "behavior", "--skill-path", str(skill), "--evals", str(evals), "--dry-run"],
                       capture_output=True, text=True, encoding="utf-8", env=env)
    assert r.returncode == 0, r.stderr
    assert "apiKeyHelper" in r.stdout + r.stderr


# ------------------------------------------------------------ 11: temp dir leak

def test_an_improve_attempt_removes_its_temp_dir(tmp_path, monkeypatch):
    from scripts import improve_description
    made = []
    real = headless.make_temp

    def spy(prefix):
        p = real(prefix)
        made.append(p)
        return p

    monkeypatch.setattr(headless, "make_temp", spy)
    patch_run(monkeypatch, lambda *a, **k: fake_run(stream(result(text="<new_description>Does X. Use when Y.</new_description>"))))
    improve_description._ask("prompt", headless.resolve_models("sonnet")[0])
    assert made and not any(p.exists() for p in made)


# ------------------------------------------------------------------ 12: TODO scan

def test_a_todo_in_any_skill_file_fails_and_the_message_names_the_file(skills_root):
    d = write_skill(skills_root, "probe-skill", body="# T\n\nSee [r](references/r.md).\n", files={"references/r.md": "# R\n\nTODO: finish.\n"})
    r = subprocess.run([sys.executable, str(SCRIPTS / "quick_validate.py"), str(d)], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 1 and "references/r.md" in r.stdout and "TODO" in r.stdout


def test_files_that_write_todo_markers_on_purpose_and_test_folders_are_not_scanned(skills_root):
    d = write_skill(skills_root, "probe-skill", files={
        "scripts/gen.py": '"""todo-ok: this file writes TODO markers on purpose."""\nx = "TODO"\n',
        "tests/test_x.py": "# TODO: not a skill file\n",
        "evals/evals.json": '{"note": "TODO"}',
    })
    r = subprocess.run([sys.executable, str(SCRIPTS / "quick_validate.py"), str(d)], capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stdout


# -------------------------------------------------------- 13, 18: the evals file

@pytest.mark.parametrize("field,value", [("files", ["../secret.txt"]), ("files", ["/etc/passwd"]), ("files", ["C:/Windows/win.ini"]),
                                         ("files", ["a/../../b"]), ("skills", ["../other"]), ("skills", ["a/b"]), ("skills", ["/abs"])])
def test_an_eval_may_not_name_a_path_outside_the_skill(tmp_path, field, value):
    from scripts.evals import EvalError, load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"], **({field: value} if i == 0 else {})} for i in range(3)]), encoding="utf-8")
    with pytest.raises(EvalError, match="(?i)outside|relative|path"):
        load_evals(p)


def test_expected_behavior_wins_over_expectations_and_assertions(tmp_path):
    from scripts.evals import load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["from-behavior"], "expectations": ["from-expectations"],
                              "assertions": ["from-assertions"]} for i in range(3)]), encoding="utf-8")
    assert load_evals(p)[0]["assertions"] == ["from-behavior"]
    p.write_text(json.dumps([{"query": f"q{i}", "expectations": ["from-expectations"], "assertions": ["from-assertions"]} for i in range(3)]), encoding="utf-8")
    assert load_evals(p)[0]["assertions"] == ["from-expectations"]


# --------------------------------------------------------------- 15, 16: I/O

def test_the_loop_writes_utf8_whatever_the_console_encoding_is(tmp_path):
    skill = write_skill(tmp_path, "probe-skill")
    sets = tmp_path / "t.json"
    sets.write_text(json.dumps([{"query": "q", "should_trigger": True}]), encoding="utf-8")
    rep, res = tmp_path / "report.html", tmp_path / "res"
    code = ("import sys; sys.path.insert(0, %r)\nfrom scripts import run_loop\n"
            "run_loop.webbrowser.open = lambda *a, **k: None\n"
            "def fake(*a, **k):\n"
            "    return {'results': [{'query': 'q', 'should_trigger': True, 'trigger_rate': 1.0, 'triggers': 1, 'runs': 1, 'errors': 0, 'pass': True, 'by_model': {}}],\n"
            "            'summary': {'total': 1, 'passed': 1, 'failed': 0}}\n"
            "run_loop.run_trigger_eval = fake\n"
            "sys.argv = ['run_loop.py', '--eval-set', %r, '--skill-path', %r, '--report', %r, '--results-dir', %r, '--holdout', '0',\n"
            "            '--description', 'Does X \\u2192 Y. Use when Z.']\n"
            "run_loop.main()\n") % (str(SKILL_DIR), str(sets), str(skill), str(rep), str(res))
    env = {**os.environ, "PYTHONUTF8": "0", "PYTHONIOENCODING": "utf-8"}  # open() falls back to the locale codec (cp1252 on Windows)
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, encoding="utf-8", env=env)
    assert r.returncode == 0, r.stderr
    assert "\u2192" in rep.read_text(encoding="utf-8")
    found = [json.loads(p.read_text(encoding="utf-8")) for p in res.rglob("results.json")]
    assert found and "\u2192" in found[0]["best_description"]


def test_a_hung_gate_is_a_gate_error_not_a_hang(monkeypatch):
    from scripts import gate

    def hang(cmd, **kw):
        assert kw.get("timeout"), "run_gate must pass a timeout"
        raise subprocess.TimeoutExpired(cmd, kw["timeout"])

    monkeypatch.setattr(gate.subprocess, "run", hang)
    with pytest.raises(gate.GateError, match="(?i)timed out"):
        gate.run_gate("--check-name", "x")
