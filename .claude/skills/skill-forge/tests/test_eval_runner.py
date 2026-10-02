"""Eval runner: model policy, baseline isolation, headless flags, eval shapes, navigation, proposals."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import SCRIPTS, SKILL_DIR, run_py, write_skill

RUN_EVAL = SCRIPTS / "run_eval.py"


# ------------------------------------------------------------------ model policy

@pytest.mark.parametrize("spec", ["haiku", "claude-haiku-4-5", "CLAUDE-HAIKU-5", "sonnet,haiku", "opus, claude-3-haiku"])
def test_a_haiku_model_id_is_rejected(spec):
    from scripts.headless import resolve_models
    with pytest.raises(ValueError, match="(?i)haiku"):
        resolve_models(spec)


def test_the_default_model_loop_is_sonnet_opus_fable():
    from scripts.headless import resolve_models
    assert [m.id for m in resolve_models(None)] == ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]
    assert [m.id for m in resolve_models("opus")] == ["claude-opus-5-5"]
    assert all(m.effort == "high" for m in resolve_models(None))


def test_the_cli_rejects_haiku_before_it_runs_anything(tmp_path):
    evals = tmp_path / "evals.json"
    evals.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(3)]))
    skill_dir = write_skill(tmp_path, "probe-skill")
    r = run_py(RUN_EVAL, "behavior", "--skill-path", str(skill_dir), "--evals", str(evals),
               "--models", "claude-haiku-4-5", "--dry-run")
    assert r.returncode == 2
    assert "haiku" in r.stderr.lower()


# --------------------------------------------------------------- headless runs

def test_child_env_removes_the_api_key():
    from scripts.headless import child_env
    env = child_env({"ANTHROPIC_API_KEY": "sk-secret", "PATH": "x"})
    assert "ANTHROPIC_API_KEY" not in env and env["PATH"] == "x"


def test_command_has_the_headless_safety_flags(tmp_path):
    from scripts.headless import build_command, resolve_models
    model = resolve_models("sonnet")[0]
    cmd = build_command(model, tmp_path / "s.json", tmp_path / "m.json", exe="claude.exe")
    for flag in ("-p", "--verbose", "--strict-mcp-config", "--mcp-config", "--settings", "--max-turns", "--tools"):
        assert flag in cmd, cmd
    assert cmd[cmd.index("--output-format") + 1] == "stream-json"
    assert cmd[cmd.index("--model") + 1] == "claude-sonnet-5-5"
    assert cmd[cmd.index("--effort") + 1] == "high"


def test_behavior_runs_pre_approve_the_tools_they_may_use(tmp_path):
    # Found in the second live run: without a grant, `claude -p` denies the Skill tool call
    # ("Execute skill: premortem", is_error) and the skill body never loads.
    from scripts.headless import build_command, resolve_models
    model = resolve_models("sonnet")[0]
    cmd = build_command(model, tmp_path / "s.json", tmp_path / "m.json", tools="Skill,Read", allowed="Skill,Read", exe="claude.exe")
    assert cmd[cmd.index("--allowedTools") + 1] == "Skill,Read"
    assert "--allowedTools" not in build_command(model, tmp_path / "s.json", tmp_path / "m.json", exe="claude.exe")
    _, specs = _plan(tmp_path)
    assert all(s.command[s.command.index("--allowedTools") + 1] == s.command[s.command.index("--tools") + 1] for s in specs)


def _plan(tmp_path, evals=None):
    from scripts.headless import resolve_models
    from scripts.run_eval import plan_runs
    repo_skills = tmp_path / "repo" / ".claude" / "skills"
    skill = write_skill(repo_skills, "probe-skill", files={"references/a.md": "# A\n"})
    evals = evals or [{"id": 1, "name": "one", "prompt": "do it", "files": [], "skills": [], "assertions": ["it works"]}]
    specs = plan_runs(skill, evals, resolve_models("sonnet"), tmp_path / "out", tmp_path / "work", home=tmp_path / "home")
    return skill, specs


def test_the_real_skill_is_off_in_both_configs_and_hooks_are_off(tmp_path):
    # The real name is off in BOTH configs: a personal copy of the same name can never win. with_skill
    # runs a renamed copy instead (see test_eval_validity.py).
    _, specs = _plan(tmp_path)
    by_cfg = {s.config: json.loads(s.settings_path.read_text()) for s in specs}
    for cfg in by_cfg.values():
        assert cfg["skillOverrides"]["probe-skill"] == "off"
        assert cfg["disableAllHooks"] is True


def test_runs_happen_in_a_temp_project_and_the_repo_is_untouched(tmp_path):
    skill, specs = _plan(tmp_path)
    repo = tmp_path / "repo"
    before = hashlib.sha256((skill / "SKILL.md").read_bytes()).hexdigest()
    for s in specs:
        assert repo not in Path(s.cwd).parents and Path(s.cwd) != repo
        assert not (Path(s.cwd) / ".claude" / "commands").exists()
    assert not (repo / ".claude" / "commands").exists()
    assert hashlib.sha256((skill / "SKILL.md").read_bytes()).hexdigest() == before


def test_a_run_covers_every_eval_for_both_configs(tmp_path):
    evals = [{"id": i, "name": f"e{i}", "prompt": "p", "files": [], "skills": [], "assertions": ["a"]} for i in (1, 2, 3)]
    _, specs = _plan(tmp_path, evals)
    assert sorted((s.eval_id, s.config) for s in specs) == sorted((i, c) for i in (1, 2, 3) for c in ("with_skill", "without_skill"))
    assert len({str(s.run_dir) for s in specs}) == len(specs)


def test_trigger_project_renames_the_candidate_and_switches_the_real_skill_off(tmp_path):
    from scripts.run_eval import prepare_trigger_project
    skill = write_skill(tmp_path / "repo" / ".claude" / "skills", "probe-skill")
    before = (skill / "SKILL.md").read_bytes()
    project, candidate, settings = prepare_trigger_project(skill, "Does Z. Use when Q.", tmp_path / "work", home=tmp_path / "home")
    assert candidate != "probe-skill" and candidate.startswith("probe-skill")
    md = (project / ".claude" / "skills" / candidate / "SKILL.md").read_text(encoding="utf-8")
    assert f"name: {candidate}" in md and "description: Does Z. Use when Q." in md
    assert json.loads(settings.read_text())["skillOverrides"] == {"probe-skill": "off"}
    assert (skill / "SKILL.md").read_bytes() == before


# ------------------------------------------------------------------- streams

def _stream(*events):
    return "\n".join(json.dumps(e) for e in events)


def _tool(name, **inp):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}


def test_navigation_records_reads_in_order_and_the_skill_files_never_read(tmp_path):
    from scripts.headless import navigation, parse_stream
    skill = write_skill(tmp_path, "probe-skill", files={"references/a.md": "# A\n", "references/b.md": "# B\n", "scripts/run.py": "print(1)\n"})
    text = _stream(
        _tool("Skill", skill="probe-skill"),
        _tool("Read", file_path=str(skill / "references" / "a.md")),
        _tool("Read", file_path=str(tmp_path / "other.txt")),
        {"type": "result", "result": "done", "num_turns": 3},
    )
    info = parse_stream(text)
    assert info["skills_fired"] == ["probe-skill"]
    assert info["files_read"] == [str(skill / "references" / "a.md"), str(tmp_path / "other.txt")]
    nav = navigation(info["files_read"], skill)
    assert nav["skill_files_read"] == ["references/a.md"]
    assert nav["skill_files_unread"] == ["references/b.md", "scripts/run.py"]
    assert nav["reads_outside_skill"] == [str(tmp_path / "other.txt")]


def test_a_temp_project_path_is_the_long_form_not_an_8_3_short_name():
    # Found in the first live run: a C:\Users\DAVID~1.HAY\... path made Claude Code ask for
    # permission to read the project, and the Skill tool call failed with it.
    from scripts.headless import make_temp
    p = make_temp("skill-test-")
    try:
        assert "~" not in str(p)
    finally:
        p.rmdir()


def test_a_skill_tool_call_that_errors_is_reported_not_counted_as_a_fire():
    from scripts.headless import parse_stream
    ok = _stream({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "probe-skill"}}]}},
                 {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "loaded"}]}})
    bad = _stream({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "probe-skill"}}]}},
                  {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "Execute skill: probe-skill", "is_error": True}]}})
    assert parse_stream(ok)["skill_errors"] == []
    assert parse_stream(bad)["skill_errors"] == ["probe-skill: Execute skill: probe-skill"]


def test_the_init_event_shows_whether_the_skill_was_listed():
    from scripts.headless import parse_stream
    on = _stream({"type": "system", "subtype": "init", "skills": ["a", "probe-skill"]})
    off = _stream({"type": "system", "subtype": "init", "skills": ["a"]})
    assert parse_stream(on)["listed_skills"] == ["a", "probe-skill"]
    assert parse_stream(off)["listed_skills"] == ["a"]
    assert parse_stream("")["listed_skills"] is None


def test_an_event_whose_message_is_a_plain_string_does_not_break_the_parser(tmp_path):
    # Found in the first live run: some stream events carry "message": "<text>", not an object.
    from scripts.headless import parse_stream, render_transcript
    text = _stream({"type": "system", "message": "hello"}, {"type": "assistant", "message": "odd"},
                   {"type": "user", "message": "odd"}, _tool("Skill", skill="probe-skill"), {"type": "result", "result": "done"})
    assert parse_stream(text)["skills_fired"] == ["probe-skill"]
    assert "Tool: Skill" in render_transcript(text, "prompt")


def test_a_trigger_is_the_candidate_skill_tool_use_and_nothing_else():
    from scripts.headless import skill_fired
    assert skill_fired(_stream(_tool("Skill", skill="probe-skill-cand1a2b")), "probe-skill-cand1a2b")
    assert not skill_fired(_stream(_tool("Skill", skill="probe-skill")), "probe-skill-cand1a2b")
    assert not skill_fired(_stream(_tool("Read", file_path="x")), "probe-skill-cand1a2b")


# --------------------------------------------------------------- eval shapes

def test_the_guide_shape_maps_expected_behavior_to_assertions(tmp_path):
    from scripts.evals import load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps([{"skills": ["premortem"], "query": f"q{i}", "files": [], "expected_behavior": [f"does {i}"]} for i in range(3)]))
    evals = load_evals(p)
    assert [e["prompt"] for e in evals] == ["q0", "q1", "q2"]
    assert evals[0]["assertions"] == ["does 0"] and evals[0]["skills"] == ["premortem"]
    assert [e["id"] for e in evals] == [1, 2, 3]


def test_the_existing_evals_json_shape_still_loads(tmp_path):
    from scripts.evals import load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps({"skill_name": "x", "evals": [
        {"id": 7, "prompt": "p1", "expected_output": "an answer", "files": []},
        {"id": 8, "prompt": "p2", "expected_output": "y", "expectations": ["e1", "e2"]},
        {"id": 9, "prompt": "p3", "expected_output": "z", "assertions": ["a1"]}]}))
    evals = load_evals(p)
    assert [e["id"] for e in evals] == [7, 8, 9]
    assert evals[0]["assertions"] == ["an answer"]
    assert evals[1]["assertions"] == ["e1", "e2"] and evals[2]["assertions"] == ["a1"]


def test_fewer_than_three_evals_is_an_error(tmp_path):
    from scripts.evals import EvalError, load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps([{"query": "q", "expected_behavior": ["x"]}, {"query": "q2", "expected_behavior": ["y"]}]))
    with pytest.raises(EvalError, match="at least 3"):
        load_evals(p)
    assert len(load_evals(p, min_evals=2)) == 2


def test_an_eval_with_nothing_to_grade_is_an_error(tmp_path):
    from scripts.evals import EvalError, load_evals
    p = tmp_path / "e.json"
    p.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(2)] + [{"query": "q3"}]))
    with pytest.raises(EvalError, match="nothing to grade"):
        load_evals(p)


def test_the_dry_run_plans_three_models_two_configs_and_spends_nothing(tmp_path):
    evals = tmp_path / "evals.json"
    evals.write_text(json.dumps([{"query": f"q{i}", "expected_behavior": ["x"]} for i in range(3)]))
    write_skill(tmp_path, "probe-skill")
    r = run_py(RUN_EVAL, "behavior", "--skill-path", str(tmp_path / "probe-skill"), "--evals", str(evals), "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "18 runs planned" in r.stdout and "0 turns spent" in r.stdout
    for model in ("claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"):
        assert model in r.stdout


def _trigger_set(tmp_path, n=4):
    p = tmp_path / "triggers.json"
    p.write_text(json.dumps([{"query": f"q{i}", "should_trigger": i % 2 == 0} for i in range(n)]))
    return p


def test_the_description_loop_dry_run_plans_every_run_and_spends_nothing(tmp_path):
    skill = write_skill(tmp_path, "probe-skill")
    r = run_py(SCRIPTS / "run_loop.py", "--eval-set", str(_trigger_set(tmp_path)), "--skill-path", str(skill),
               "--models", "sonnet,opus,fable", "--runs-per-query", "2", "--report", "none", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "24 trigger runs per iteration" in r.stdout and "0 turns spent" in r.stdout
    assert "--tools" in r.stdout and "skillOverrides" in r.stdout


def test_the_trigger_and_loop_commands_reject_haiku(tmp_path):
    skill = write_skill(tmp_path, "probe-skill")
    sets = str(_trigger_set(tmp_path))
    loop = run_py(SCRIPTS / "run_loop.py", "--eval-set", sets, "--skill-path", str(skill), "--models", "haiku", "--report", "none", "--dry-run")
    trig = run_py(RUN_EVAL, "trigger", "--eval-set", sets, "--skill-path", str(skill), "--models", "claude-haiku-4-5", "--dry-run")
    improve = run_py(SCRIPTS / "run_loop.py", "--eval-set", sets, "--skill-path", str(skill), "--improve-model", "claude-haiku-4-5", "--report", "none", "--dry-run")
    for r in (loop, trig, improve):
        assert r.returncode == 2 and "haiku" in r.stderr.lower(), r.stdout + r.stderr


# ------------------------------------------------------ description proposals

def test_a_proposal_is_checked_against_the_cap_and_the_gate_rules():
    from scripts.improve_description import validate_proposal
    assert validate_proposal("probe-skill", "Does X. Use when Y.") == []
    assert any("400" in p for p in validate_proposal("probe-skill", "Does X. Use when Y. " + "x" * 400))
    assert validate_proposal("probe-skill", "I help you do X. Use when you need Y.")  # first and second person: G12
    assert validate_proposal("probe-skill", "Does X for Y.")  # no trigger: G14


def test_the_loop_does_not_need_the_anthropic_package():
    code = ("import sys; sys.modules['anthropic'] = None; sys.path.insert(0, %r); "
            "import scripts.improve_description, scripts.run_loop" % str(SKILL_DIR))
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_a_rejected_proposal_is_retried_with_the_problems_until_the_gate_accepts_one():
    from scripts.improve_description import improve_description
    replies = iter(["<new_description>Does X. Use when Y. " + "x" * 400 + "</new_description>",
                    "<new_description>Does X well. Use when Y.</new_description>"])
    prompts = []

    def ask(prompt, model):
        prompts.append(prompt)
        return next(replies)

    results = {"results": [], "summary": {"passed": 0, "total": 0}}
    out = improve_description("probe-skill", "body", "Does X. Use when Y.", results, [], "sonnet", ask=ask)
    assert out == "Does X well. Use when Y."
    assert len(prompts) == 2 and "400" in prompts[1]


def test_no_valid_proposal_after_three_attempts_returns_none():
    from scripts.improve_description import improve_description
    results = {"results": [], "summary": {"passed": 0, "total": 0}}
    out = improve_description("probe-skill", "body", "Does X. Use when Y.", results, [], "sonnet",
                              ask=lambda prompt, model: "<new_description>I help you with X.</new_description>")
    assert out is None


def test_a_double_quoted_description_is_read_with_its_escapes_resolved(tmp_path):
    # Found in the trigger smoke run: premortem's quoted description came back with backslashes in it,
    # so the loop would have tuned (and re-escaped) the wrong text.
    from scripts.utils import parse_skill_md
    d = write_skill(tmp_path, "probe-skill", description='"Does X. Use when the user says \\"foo\\" or \'bar\'."')
    assert parse_skill_md(d)[1] == 'Does X. Use when the user says "foo" or \'bar\'.'
    s = write_skill(tmp_path, "probe-two", description="'Does X. Use when it''s ready.'")
    assert parse_skill_md(s)[1] == "Does X. Use when it's ready."


def test_a_candidate_description_with_a_colon_is_quoted_so_the_frontmatter_still_parses(tmp_path):
    from scripts.run_eval import prepare_trigger_project
    skill = write_skill(tmp_path / "repo" / ".claude" / "skills", "probe-skill")
    project, candidate, _ = prepare_trigger_project(skill, "Does X: really. Use when Y.", tmp_path / "work")
    md = (project / ".claude" / "skills" / candidate / "SKILL.md").read_text(encoding="utf-8")
    assert 'description: "Does X: really. Use when Y."' in md


def test_the_grader_reply_is_read_from_its_json_fence():
    from scripts.run_eval import _extract_json
    reply = 'Here is my grading.\n```json\n{"expectations": [{"text": "a", "passed": true, "evidence": "e"}]}\n```\n'
    assert _extract_json(reply)["expectations"][0]["passed"] is True
    assert _extract_json("no json here") is None


def test_package_skill_still_validates_for_upload(tmp_path):
    good = write_skill(tmp_path / "a", "good-skill")
    bad = write_skill(tmp_path / "b", "bad-skill", extra_fm="disable-model-invocation: true\n")
    ok = run_py(SCRIPTS / "package_skill.py", str(good), str(tmp_path / "out"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert (tmp_path / "out" / "good-skill.skill").is_file()
    no = run_py(SCRIPTS / "package_skill.py", str(bad), str(tmp_path / "out"))
    assert no.returncode == 1
    assert not (tmp_path / "out" / "bad-skill.skill").exists()
