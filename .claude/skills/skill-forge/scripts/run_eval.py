#!/usr/bin/env python3
"""Run skill evals headlessly.

  behavior  Run each eval with the skill ON and OFF, on each model. Record which skill fired and
            which files the run read. Grade with --grade.
  trigger   Run trigger queries against a candidate description. Report the trigger rate.
  grade     Grade the runs of an earlier `behavior` run.

What the two configs run:
  with_skill     A renamed copy of the skill (<name>-eval<hex>) in a temp project, with the real name
                 off. A personal ~/.claude/skills/<name> copy therefore cannot win over the copy
                 under test.
  without_skill  The same prompt in a temp project with NO copy of the skill, and the real name off.
Both settings files carry the same user skillOverrides map and differ by nothing else.

An imported skill tree (a hub skill that links a vendored folder) adds two options:
  --companion <dir>  Copy <dir> (for example .claude/skills/_vendor) next to the eval copy, keeping its
                     layout, so ../_vendor/... links resolve. Only with_skill gets it. Both arms deny Read
                     of ~/.claude/skills/<dir name>/**, so a run reads only its own temp copy.
  --inject <file>    Prepend the file's text to the prompt in BOTH arms. It simulates the rule-router
                     injecting a rule, which a hooks-off eval never does. run.json records it.
An eval may carry "checks" (regex or not_regex on the final answer). They are graded without the LLM.

A run that errored, ended in a subtype other than success, lost its result event, or broke the
baseline (the skill listed, fired or read) is EXCLUDED: run.json says why, grading.json is written
as excluded, and aggregate_benchmark.py skips it. Nothing is written into the repo.

Keep the output folder outside the repo. The default is <temp>/skill-eval/<name>-<time>. The grader
runs in its own temp folder and never loads the repo's project config.
Headless rules (subscription billing, no hooks, no MCP, no shell): scripts/headless.py.

Examples:
  python scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals evals.json --grade
  python scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals evals.json --dry-run
  python scripts/run_eval.py trigger --skill-path .claude/skills/premortem --eval-set triggers.json
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # `scripts.*` imports work from any cwd
from scripts import headless  # noqa: E402
from scripts.evals import EvalError, MIN_EVALS, apply_checks, load_evals, load_trigger_set  # noqa: E402
from scripts.utils import parse_skill_md  # noqa: E402

SKILL_DIR = Path(__file__).resolve().parent.parent
CONFIGS = ("with_skill", "without_skill")  # the viewer and aggregate_benchmark read these exact strings
MAX_ERROR_SHARE = 0.25  # more failed trigger runs than this stops the eval


class TriggerRunError(RuntimeError):
    """Too many trigger runs failed to trust the score."""


# ------------------------------------------------------------------ planning

@dataclass
class RunSpec:
    eval_id: object
    eval: dict
    model: headless.Model
    config: str
    skill_name: str
    run_dir: Path
    cwd: Path
    settings_path: Path
    mcp_path: Path
    command: list
    prompt: str
    skill_alias: str | None = None   # the renamed copy a with_skill run uses; None for the baseline
    source_dir: Path | None = None   # the skill folder that was passed in
    personal_dir: Path | None = None  # ~/.claude/skills/<name>: reads there count as inside the skill
    real_names: tuple = ()  # the frontmatter name and the folder name: both are off in every run
    companion: Path | None = None  # the folder copied next to the eval copy (with_skill only)
    inject: dict | None = None  # {"file", "chars"} of the text prepended to the prompt, or None

    @property
    def copy_dir(self) -> Path | None:
        return self.cwd / ".claude" / "skills" / self.skill_alias if self.skill_alias else None


def skill_name_of(skill_path: Path) -> str:
    name, _, _ = parse_skill_md(skill_path)
    return name or skill_path.name


def _exe() -> str:
    try:
        return headless.find_claude()
    except RuntimeError:
        return "claude"  # a dry run still prints the plan; a live run fails with a clear spawn error


def _rename_copy(dest: Path, new_name: str, description: str | None = None) -> None:
    """Rewrite the frontmatter name of a copied skill, and its description when one is given."""
    text = (dest / "SKILL.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        raise EvalError(f"{dest / 'SKILL.md'} has no frontmatter")
    kept, skipping = [], False
    for line in m.group(1).split("\n"):
        key = re.match(r"^(name|description):", line)
        if key and (key.group(1) == "name" or description is not None):
            skipping = key.group(1) == "description"
            continue
        if skipping and re.match(r"^[ \t]", line):
            continue
        skipping = False
        kept.append(line)
    head = [f"name: {new_name}"]
    if description is not None:
        head.append(f"description: {_yaml_scalar(description)}")
    # without a new description the original description lines stay in `kept`
    (dest / "SKILL.md").write_text("---\n" + "\n".join(head + kept) + "\n---\n" + text[m.end():], encoding="utf-8", newline="\n")


def load_inject(path) -> dict:
    """Read the text --inject prepends to every prompt. Raise EvalError when it is missing or empty."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as e:
        raise EvalError(f"cannot read the inject file {path}: {e}") from None
    if not text.strip():
        raise EvalError(f"the inject file {path} is empty")
    return {"file": str(Path(path)), "text": text, "chars": len(text)}


def project_layout(cwd: Path) -> str:
    """One line for the dry run: what sits under .claude/skills in a temp project, with file counts."""
    skills = Path(cwd) / ".claude" / "skills"
    if not skills.is_dir():
        return "(no .claude/skills)"
    parts = [f"{d.name} ({sum(1 for f in d.rglob('*') if f.is_file())} files)" for d in sorted(skills.iterdir()) if d.is_dir()]
    return ", ".join(parts) or "(empty)"


def _build_project(cwd: Path, skill_path: Path, ev: dict, install_target: bool, companion: Path | None = None) -> str | None:
    """A temp project: any other skills the eval names, the eval's input files, and, for with_skill,
    a renamed copy of the skill under test plus the companion folder next to it. Return the copy's
    name, or None.

    The baseline project holds no copy of the skill and no companion at all.
    """
    skills_root = skill_path.parent
    for name in [s for s in ev.get("skills", []) if s != skill_path.name]:
        src = skills_root / name
        if not (src / "SKILL.md").is_file():
            raise EvalError(f"eval {ev['id']} names skill '{name}', but {src} has no SKILL.md")
        headless.copy_skill(src, cwd / ".claude" / "skills" / name)
    for rel in ev.get("files", []):
        src = skill_path / rel
        if not src.is_file():
            raise EvalError(f"eval {ev['id']} input file {rel} not found under {skill_path}")
        (cwd / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, cwd / rel)
    if not install_target:
        return None
    alias = f"{skill_name_of(skill_path)}-eval{uuid.uuid4().hex[:6]}"
    dest = headless.copy_skill(skill_path, cwd / ".claude" / "skills" / alias)
    _rename_copy(dest, alias)
    if companion:
        try:
            headless.copy_companion(companion, cwd / ".claude" / "skills" / companion.name)
        except (shutil.Error, OSError) as e:
            # shutil.Error holds a list of (src, dest, reason): show the first reason, not the list.
            first = e.args[0][0][2] if isinstance(e, shutil.Error) and e.args and e.args[0] else str(e)
            raise EvalError(f"cannot copy the companion {companion}: {first}. On Windows a path over 260 characters "
                            "fails: pass only the folders the hub links (skills/<allowlist> and common/).") from None
    return alias


def _absolute_deny(skill_path: Path) -> list[str]:
    """Read-deny patterns for the skill's own source folder (the repo copy a baseline can still find).

    Claude Code writes an absolute path in a permission rule with a leading // . On Windows both the
    drive form (//C:/Users/...) and the POSIX drive form (//c/Users/...) are given.
    """
    posix = Path(skill_path).resolve().as_posix().rstrip("/")
    rules = [f"/{posix}/**" if posix.startswith("/") else f"//{posix}/**"]
    if len(posix) > 2 and posix[1] == ":":
        rules.append(f"//{posix[0].lower()}{posix[2:]}/**")
    return rules


def plan_runs(skill_path, evals, models, out_dir, work_dir, tools=headless.DEFAULT_TOOLS,
              max_turns=headless.DEFAULT_MAX_TURNS, exe=None, home=None, companion=None, inject=None) -> list[RunSpec]:
    """One RunSpec per model x eval x config. Writes the temp projects and settings files.

    The real skill name is off in BOTH settings files, next to the user's own skillOverrides map.
    `companion` is a folder copied next to the eval copy in with_skill projects; both arms deny Read of
    its real twin under ~/.claude/skills. `inject` is load_inject()'s dict: its text starts every prompt.
    """
    skill_path, out_dir, work_dir = Path(skill_path).resolve(), Path(out_dir), Path(work_dir)
    home = Path(home) if home else Path.home()
    name = skill_name_of(skill_path)
    # Claude Code can register a skill under its folder name as well as its frontmatter name
    # (create_handoff's folder vs its name: create-handoff). Switch off and fence off both.
    real_names = list(dict.fromkeys([name, skill_path.name]))
    personal = home / ".claude" / "skills" / name
    overrides = {**headless.user_skill_overrides(home), **{n: "off" for n in real_names}}
    companion = Path(companion).resolve() if companion else None
    # Fence off every copy of the skill a baseline could read: the personal copies under both names,
    # the repo source folder, and (for a hub) the companion tree and its repo source.
    deny_reads = ([f"~/.claude/skills/{n}/**" for n in [*real_names, *([companion.name] if companion else [])]]
                  + _absolute_deny(skill_path) + (_absolute_deny(companion) if companion else []))
    exe = exe or _exe()
    specs = []
    for model in models:
        for ev in evals:
            for config in CONFIGS:
                tag = f"{model.alias}-eval-{ev['id']}-{config}"
                cwd = work_dir / tag / "project"
                cwd.mkdir(parents=True)
                alias = _build_project(cwd, skill_path, ev, install_target=config == "with_skill", companion=companion)
                settings = headless.write_settings(work_dir / tag / "settings.json", overrides, deny_reads)
                mcp = headless.write_empty_mcp(work_dir / tag / "mcp.json")
                command = headless.build_command(model, settings, mcp, tools, max_turns, exe=exe, allowed=tools)
                run_dir = Path(out_dir) / model.alias / f"eval-{ev['id']}" / config / "run-1"
                prompt = f"{inject['text'].rstrip()}\n\n---\n\n{ev['prompt']}" if inject else ev["prompt"]
                specs.append(RunSpec(ev["id"], ev, model, config, name, run_dir, cwd, settings, mcp, command, prompt,
                                     skill_alias=alias, source_dir=skill_path, personal_dir=personal,
                                     real_names=tuple(real_names), companion=companion,
                                     inject={"file": inject["file"], "chars": inject["chars"]} if inject else None))
    return specs


# ----------------------------------------------------------------- execution

def exclusion_reason(config: str, listed, fired: bool, read_skill: bool, error: str | None,
                     real_fired: bool = False) -> str | None:
    """Why a run must not be graded or counted, or None. A broken run says nothing about the skill."""
    if error:
        return error
    if config == "with_skill" and real_fired:
        return "the real skill fired instead of the eval copy (its off override did not apply)"
    if config == "without_skill":
        if listed:
            return "the skill is listed in the without_skill run (the off override did not apply, for example to a plugin skill)"
        if fired:
            return "the skill fired in the without_skill run"
        if read_skill:
            return "the without_skill run read the skill's files: baseline contaminated"
    elif listed is False:
        return "the skill is not listed in the with_skill run: the copy did not load"
    return None


def execute(spec: RunSpec, timeout: int) -> dict:
    """Run one spec. Write transcript.jsonl, transcript.md, outputs/response.md, timing.json and run.json."""
    run = headless.run_claude(spec.command, spec.prompt, spec.cwd, timeout)
    info = headless.parse_stream(run.stdout)
    # A read under the source folder, the renamed copy or the personal copy is a read of the skill.
    real_names = spec.real_names or (spec.skill_name,)
    personal_roots = [spec.personal_dir.parent / n for n in real_names] if spec.personal_dir else []
    roots = [r for r in (spec.copy_dir, *personal_roots) if r]
    # A read under the companion (the temp copy or its real twin in ~/.claude/skills) is a read of the skill too.
    comp_roots = []
    if spec.companion:
        comp_roots = [spec.cwd / ".claude" / "skills" / spec.companion.name]
        if spec.personal_dir:
            comp_roots.append(spec.personal_dir.parent / spec.companion.name)
    nav = headless.navigation(info["files_read"], spec.source_dir or spec.copy_dir, extra_roots=roots, companion_roots=comp_roots)
    read_skill = bool(nav["skill_files_read"] or nav["companion_files_read"])
    m = headless.metrics(info["result"], run.seconds)
    listed = info["listed_skills"]

    def matches(names, targets):
        return any(headless.name_matches(s, t) for s in names for t in targets)

    # with_skill: the renamed copy; baseline: any real name (frontmatter or folder).
    targets = (spec.skill_alias,) if spec.skill_alias else real_names
    skill_listed = None if listed is None else matches(listed, targets)
    skill_fired = matches(info["skills_fired"], targets)
    real_fired = bool(spec.skill_alias) and matches(info["skills_fired"], real_names)
    # A stop at the turn cap is an answer that failed, not a broken run: excluding it would drop
    # exactly the baselines that floundered without the skill. It is graded 0 without a grader call.
    no_answer = (info.get("result") or {}).get("subtype") == "error_max_turns" and not info["skill_errors"]
    error = None if no_answer else (
        run.error
        or (f"skill load failed: {info['skill_errors'][0]}" if info["skill_errors"] else None)
        or headless.result_error(info))
    excluded = exclusion_reason(spec.config, skill_listed, skill_fired, read_skill, error, real_fired)

    d = spec.run_dir
    (d / "outputs").mkdir(parents=True, exist_ok=True)
    (d / "transcript.jsonl").write_text(run.stdout, encoding="utf-8", newline="\n")
    (d / "transcript.md").write_text(headless.render_transcript(run.stdout, spec.prompt), encoding="utf-8", newline="\n")
    (d / "outputs" / "response.md").write_text(info["final_text"] or "", encoding="utf-8", newline="\n")
    headless.write_json(d / "timing.json", {"total_tokens": m["total_tokens"], "duration_ms": int(m["duration_seconds"] * 1000),
                                            "total_duration_seconds": m["duration_seconds"]})
    record = {
        "eval_id": spec.eval_id, "eval_name": spec.eval["name"], "config": spec.config, "skill": spec.skill_name,
        "model": spec.model.alias, "model_id": spec.model.id, "effort": spec.model.effort, "prompt": spec.prompt,
        "skill_alias": spec.skill_alias, "skill_listed": skill_listed, "skill_fired": skill_fired,
        "skills_fired": info["skills_fired"], "tool_counts": info["tool_counts"], "navigation": nav,
        # A baseline run that reads the skill's files found the skill without the Skill tool.
        "baseline_contaminated": spec.config == "without_skill" and read_skill,
        "skill_errors": info["skill_errors"],
        "companion": spec.companion.name if spec.companion else None,
        "inject": spec.inject,
        "final_text": info["final_text"], "metrics": m,
        # A fired skill whose load failed, or a run that did not end in success, is a broken run.
        "error": error,
        # The run stopped at --max-turns without a final answer: it counts, and every assertion fails.
        "no_answer": no_answer,
        # Why this run must not be graded or counted. None when it counts.
        "excluded": excluded,
        "stderr": run.stderr, "assertions": spec.eval["assertions"], "checks": spec.eval.get("checks") or [],
    }
    headless.write_json(d / "run.json", record)
    return record


def run_behavior(specs, timeout, workers) -> list[dict]:
    records = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(execute, s, timeout): s for s in specs}
        for fut in as_completed(futures):
            s = futures[fut]
            rec = fut.result()
            records.append(rec)
            print(f"  [{s.model.alias} eval-{s.eval_id} {s.config}] fired={rec['skill_fired']} "
                  f"read={len(rec['navigation']['skill_files_read'])} error={rec['error']}", file=sys.stderr)
    return sorted(records, key=lambda r: (r["model"], str(r["eval_id"]), r["config"]))


# ------------------------------------------------------------------- grading

def _extract_json(text: str) -> dict | None:
    for m in reversed(list(re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL))):
        try:
            return json.loads(m.group(1))
        except ValueError:
            continue
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            return None
    return None


def grade_run(run_dir: Path, grader_model: headless.Model, timeout: int = 300) -> dict:
    """Grade one run with agents/grader.md through `claude -p`. Write grading.json."""
    run_dir = Path(run_dir)
    record = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    if record.get("excluded"):
        # A broken run is not graded. The grading file says why, and the benchmark skips it.
        grading = {"excluded": record["excluded"], "expectations": [],
                   "summary": {"passed": 0, "failed": 0, "total": 0, "pass_rate": None}}
        headless.write_json(run_dir / "grading.json", grading)
        return grading
    checks = record.get("checks") or []
    if record.get("no_answer"):
        # Stopped at the turn cap with no final answer: nothing to grade, so every assertion and every
        # check fails. A not_regex check must not pass on the empty text.
        why = "the run stopped at the turn cap without a final answer"
        exps = [{"text": a, "passed": False, "evidence": why} for a in record["assertions"]]
        exps += [{**e, "passed": False, "evidence": why} for e in apply_checks(checks, "")]
        grading = {"expectations": exps, "no_answer": True,
                   "summary": {"passed": 0, "failed": len(exps), "total": len(exps), "pass_rate": 0.0}}
        headless.write_json(run_dir / "grading.json", grading)
        return grading
    det = apply_checks(checks, record.get("final_text") or "")
    if not record["assertions"]:
        # Only deterministic checks: no LLM grader call.
        passed = sum(1 for e in det if e["passed"])
        grading = {"expectations": det, "summary": {"passed": passed, "failed": len(det) - passed, "total": len(det),
                                                    "pass_rate": round(passed / len(det), 2) if det else 0.0}}
        headless.write_json(run_dir / "grading.json", grading)
        return grading
    grader = (SKILL_DIR / "agents" / "grader.md").read_text(encoding="utf-8")
    expectations = "\n".join(f"{i}. {a}" for i, a in enumerate(record["assertions"], 1))
    # The grader is blind: it gets the transcript and the outputs, and nothing that names the
    # configuration (no run.json, no skill_fired). skill_fired and navigation go to summary.json.
    prompt = (f"{grader}\n\n---\n\nGrade this run now.\n\n"
              "Output rule for this run: you have only the Read tool. Do not write grading.json. "
              "Print the grading object as ONE JSON object in a ```json fence, and nothing after it.\n\n"
              f"expectations:\n{expectations}\n\n"
              "transcript_path: transcript.md\noutputs_dir: outputs\n")
    tmp = headless.make_temp("skill-grade-")
    try:
        sandbox = tmp / "run"
        sandbox.mkdir()
        shutil.copy2(run_dir / "transcript.md", sandbox / "transcript.md")
        shutil.copytree(run_dir / "outputs", sandbox / "outputs")
        cmd = headless.build_command(grader_model, headless.write_settings(tmp / "s.json"), headless.write_empty_mcp(tmp / "m.json"),
                                     tools="Read", max_turns=8, exe=_exe())
        run = headless.run_claude(cmd, prompt, sandbox, timeout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    info = headless.parse_stream(run.stdout)
    grading = _extract_json(info["final_text"] or "")
    if not grading or not isinstance(grading.get("expectations"), list) or not grading["expectations"]:
        # No usable grading is not a score of 0: exclude the run so the benchmark skips it.
        reason = f"grading failed: {run.error or headless.result_error(info) or 'grader returned no expectations'}"
        grading = {"excluded": reason, "expectations": [], "raw": (info["final_text"] or "")[:1000], "grader_model": grader_model.id,
                   "summary": {"passed": 0, "failed": 0, "total": 0, "pass_rate": None}}
        headless.write_json(run_dir / "grading.json", grading)
        return grading
    grading["expectations"] = grading["expectations"] + det
    exps = grading["expectations"]
    passed = sum(1 for e in exps if e.get("passed"))
    grading["summary"] = {"passed": passed, "failed": len(exps) - passed, "total": len(exps),
                          "pass_rate": round(passed / len(exps), 2) if exps else 0.0}
    grading["grader_model"] = grader_model.id
    headless.write_json(run_dir / "grading.json", grading)
    return grading


# ------------------------------------------------------------------- trigger

def _yaml_scalar(s: str) -> str:
    return json.dumps(s, ensure_ascii=False) if (re.search(r":(\s|$)|\s#|^[\[\]{}>|*&!%@`\"'#-]", s) or s != s.strip()) else s


def prepare_trigger_project(skill_path, description: str, work_dir, home=None):
    """A temp project with a renamed copy of the skill that carries the candidate description.

    The real skill is switched off, so the model can only pick the candidate. Return
    (project_dir, candidate_name, settings_path). The source skill is never changed.
    """
    skill_path, work_dir = Path(skill_path).resolve(), Path(work_dir)
    name = skill_name_of(skill_path)
    candidate = f"{name}-cand{uuid.uuid4().hex[:6]}"
    project = work_dir / "project"
    dest = headless.copy_skill(skill_path, project / ".claude" / "skills" / candidate)
    _rename_copy(dest, candidate, description)
    overrides = {**headless.user_skill_overrides(home), name: "off"}
    settings = headless.write_settings(work_dir / "settings.json", overrides)
    return project, candidate, settings


def print_trigger_plan(eval_set, skill_path, description, models, runs_per_query) -> None:
    """The dry run of a trigger eval: what would run, and 0 turns spent."""
    work = headless.make_temp("skill-trigger-plan-")
    try:
        _, candidate, settings = prepare_trigger_project(skill_path, description, work)
        mcp = headless.write_empty_mcp(work / "mcp.json")
        print(f"exe: {_exe()}  (shell=False; the query goes on stdin; ANTHROPIC_API_KEY removed)")
        print(f"candidate skill: {candidate}   settings: {json.dumps(json.loads(settings.read_text()))}")
        for model in models:
            cmd = headless.build_command(model, settings, mcp, tools="Skill", max_turns=2, exe=_exe())
            print(f"argv ({model.alias}): {json.dumps(cmd[1:])}")
        total = len(eval_set) * len(models) * runs_per_query
        print(f"dry-run: {total} trigger runs per iteration ({len(eval_set)} queries x {len(models)} models x "
              f"{runs_per_query} runs), 0 turns spent")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_trigger_eval(eval_set, skill_path, description, models, workers, timeout, runs_per_query=3,
                     trigger_threshold=0.5, exe=None, max_error_share=MAX_ERROR_SHARE) -> dict:
    """Trigger rate per query for a candidate description, pooled over models and runs.

    A run counts when the stream shows the model's choice: it fired the candidate (even if the run
    then hit --max-turns or exited non-zero), or it ended cleanly without firing. A run that failed
    without firing is a failure, not a miss. More failures than `max_error_share` of all runs raise
    TriggerRunError. A query whose runs all failed is listed under "unmeasured" and never scored 0/0.
    """
    if not eval_set:
        raise EvalError("the trigger set is empty: it would score 0 of 0 and read as all passed")
    work = headless.make_temp("skill-trigger-")
    try:
        project, candidate, settings = prepare_trigger_project(skill_path, description, work)
        mcp = headless.write_empty_mcp(work / "mcp.json")
        exe = exe or _exe()
        jobs = []
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            for item in eval_set:
                for model in models:
                    cmd = headless.build_command(model, settings, mcp, tools="Skill", max_turns=2, exe=exe)
                    for _ in range(runs_per_query):
                        jobs.append((item, model, pool.submit(headless.run_claude, cmd, item["query"], project, timeout)))
            per_query: dict[str, dict] = {}
            failed, total, first_error = 0, 0, None
            for item, model, fut in jobs:
                run = fut.result()
                total += 1
                q = per_query.setdefault(item["query"], {"item": item, "fired": 0, "runs": 0, "errors": 0, "by_model": {}})
                info = headless.parse_stream(run.stdout)
                hit = any(headless.name_matches(s, candidate) for s in info["skills_fired"])
                problem = run.error or headless.result_error(info)
                if problem and not hit:
                    failed += 1
                    q["errors"] += 1
                    first_error = first_error or problem
                    continue
                q["runs"] += 1
                q["fired"] += int(hit)
                bm = q["by_model"].setdefault(model.alias, [0, 0])
                bm[0] += int(hit)
                bm[1] += 1
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if total and failed / total > max_error_share:
        raise TriggerRunError(f"{failed} of {total} trigger runs failed (limit {max_error_share:.0%}); first error: {first_error}")
    results, unmeasured = [], []
    for query, q in per_query.items():
        runs, should = q["runs"], q["item"]["should_trigger"]
        if not runs:
            unmeasured.append(query)
            continue
        rate = q["fired"] / runs
        ok = rate >= trigger_threshold if should else rate < trigger_threshold
        results.append({"query": query, "should_trigger": should, "trigger_rate": rate, "triggers": q["fired"],
                        "runs": runs, "errors": q["errors"], "pass": ok,
                        "by_model": {k: f"{v[0]}/{v[1]}" for k, v in q["by_model"].items()}})
    if not results:
        raise TriggerRunError(f"no trigger query could be measured; first error: {first_error}")
    passed = sum(1 for r in results if r["pass"])
    return {"skill_name": skill_name_of(skill_path), "description": description, "models": [m.id for m in models],
            "results": results, "unmeasured": unmeasured, "failed_runs": failed,
            "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed}}


# ----------------------------------------------------------------------- CLI

def _models_or_exit(spec):
    try:
        return headless.resolve_models(spec)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)


def _cmd_behavior(a) -> int:
    models = _models_or_exit(a.models)
    skill_path = Path(a.skill_path).resolve()
    if not (skill_path / "SKILL.md").is_file():
        print(f"Error: no SKILL.md at {skill_path}", file=sys.stderr)
        return 1
    try:
        evals = load_evals(a.evals, a.min_evals)
        if a.eval_ids:
            wanted = {x.strip() for x in a.eval_ids.split(",")}
            evals = [e for e in evals if str(e["id"]) in wanted]
            if not evals:
                raise EvalError(f"--eval-ids {a.eval_ids} matches no eval")
    except EvalError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    companion, inject = None, None
    try:
        if a.companion:
            companion = Path(a.companion).resolve()
            if not companion.is_dir():
                raise EvalError(f"--companion {a.companion} is not a folder")
        if a.inject:
            inject = load_inject(a.inject)
    except EvalError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    name = skill_name_of(skill_path)
    out = Path(a.out) if a.out else Path(os.path.realpath(tempfile.gettempdir())) / "skill-eval" / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}"
    work = headless.make_temp("skill-eval-")
    try:
        try:
            specs = plan_runs(skill_path, evals, models, out, work, a.tools, a.max_turns, companion=companion, inject=inject)
        except EvalError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1
        warn = headless.api_key_helper_warning()
        if warn:
            print(f"Warning: {warn}", file=sys.stderr)
        if a.dry_run:
            print(f"exe: {specs[0].command[0]}  (shell=False; the prompt goes on stdin; API credentials removed from the child env)")
            for s in specs:
                print(f"[{s.model.alias} eval-{s.eval_id} {s.config}] skill copy={s.skill_alias or 'none'} "
                      f"settings={json.dumps(json.loads(s.settings_path.read_text()))}")
                print(f"  project: {s.config} | .claude/skills: {project_layout(s.cwd)}")
                if s.inject:
                    print(f"  inject: {s.inject['file']} ({s.inject['chars']} chars) prepended to the prompt")
                print(f"  argv: {json.dumps(s.command[1:])}")
                print(f"  stdin: {json.dumps(s.prompt)}")
            print(f"dry-run: {len(specs)} runs planned ({len(models)} models x {len(evals)} evals x 2 configs), 0 turns spent")
            return 0
        print(f"Running {len(specs)} headless sessions into {out}", file=sys.stderr)
        records = run_behavior(specs, a.timeout, a.workers)
        if a.grade:
            grader = _models_or_exit(a.grader_model)[0]
            for r in records:
                run_dir = out / r["model"] / f"eval-{r['eval_id']}" / r["config"] / "run-1"
                r["grading"] = grade_run(run_dir, grader)["summary"]  # an excluded run is not sent to the grader
        excluded = [{"model": r["model"], "eval_id": r["eval_id"], "config": r["config"], "reason": r["excluded"]}
                    for r in records if r["excluded"]]
        headless.write_json(out / "summary.json", {"skill": name, "warnings": [warn] if warn else [], "excluded": excluded, "runs": [
            {k: v for k, v in r.items() if k not in ("final_text", "prompt", "assertions")} for r in records]})
        for r in records:
            g = r.get("grading")
            score = f"pass={g['passed']}/{g['total']} " if g and g["total"] else ""
            print(f"{r['model']:7} eval-{r['eval_id']} {r['config']:13} listed={str(r['skill_listed']):5} fired={str(r['skill_fired']):5} "
                  f"read={r['navigation']['skill_files_read']} {score}" + (f"EXCLUDED: {r['excluded']}" if r["excluded"] else ""))
        print(f"excluded: {len(excluded)} of {len(records)} runs")
        print(f"summary: {out / 'summary.json'}")
        return 1 if excluded else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _cmd_trigger(a) -> int:
    models = _models_or_exit(a.models)
    skill_path = Path(a.skill_path)
    if not (skill_path / "SKILL.md").is_file():
        print(f"Error: no SKILL.md at {skill_path}", file=sys.stderr)
        return 1
    try:
        eval_set = load_trigger_set(a.eval_set)
    except EvalError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    warn = headless.api_key_helper_warning()
    if warn:
        print(f"Warning: {warn}", file=sys.stderr)
    description = a.description or parse_skill_md(skill_path)[1]
    if a.dry_run:
        print_trigger_plan(eval_set, skill_path, description, models, a.runs_per_query)
        return 0
    try:
        out = run_trigger_eval(eval_set, skill_path, description, models, a.num_workers, a.timeout, a.runs_per_query, a.trigger_threshold)
    except (TriggerRunError, EvalError) as e:
        print(f"Error: trigger runs failed: {e}", file=sys.stderr)
        return 1
    if a.verbose:
        s = out["summary"]
        print(f"Results: {s['passed']}/{s['total']} passed", file=sys.stderr)
        for r in out["results"]:
            print(f"  [{'PASS' if r['pass'] else 'FAIL'}] rate={r['triggers']}/{r['runs']} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0


def _cmd_grade(a) -> int:
    grader = _models_or_exit(a.grader_model)[0]
    runs = sorted(Path(a.out).glob("*/eval-*/*/run-*/run.json"))
    if not runs:
        print(f"Error: no run.json under {a.out}", file=sys.stderr)
        return 1
    for r in runs:
        g = grade_run(r.parent, grader)
        print(f"{r.parent}: " + (f"EXCLUDED: {g['excluded']}" if g.get("excluded") else f"{g['summary']['passed']}/{g['summary']['total']}"))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Run skill evals headlessly")
    sub = ap.add_subparsers(dest="mode", required=True)

    b = sub.add_parser("behavior", help="eval runs: skill on vs skill off, per model")
    b.add_argument("--skill-path", required=True)
    b.add_argument("--evals", required=True, help="evals JSON (guide shape or evals.json shape)")
    b.add_argument("--models", default=None, help="comma list of sonnet,opus,fable or claude-* ids (default: all three; never haiku)")
    b.add_argument("--eval-ids", default=None, help="run only these eval ids, for example 1 or 1,3")
    b.add_argument("--out", default=None, help="output folder. Keep it outside the repo (default: <temp>/skill-eval/<name>-<time>)")
    b.add_argument("--tools", default=headless.DEFAULT_TOOLS, help="built-in tools the run may use (default: read-only)")
    b.add_argument("--max-turns", type=int, default=headless.DEFAULT_MAX_TURNS)
    b.add_argument("--timeout", type=int, default=headless.DEFAULT_TIMEOUT)
    b.add_argument("--workers", type=int, default=3)
    b.add_argument("--min-evals", type=int, default=MIN_EVALS)
    b.add_argument("--companion", default=None, help="folder copied next to the eval copy in with_skill runs (for example "
                   ".claude/skills/_vendor), keeping its layout. Both arms deny Read of ~/.claude/skills/<folder>/**")
    b.add_argument("--inject", default=None, help="file whose text is prepended to the prompt in BOTH arms "
                   "(simulates the rule-router injecting a rule; recorded in run.json)")
    b.add_argument("--grade", action="store_true", help="grade every run with agents/grader.md")
    b.add_argument("--grader-model", default="sonnet")
    b.add_argument("--dry-run", action="store_true", help="print the plan and spend nothing")
    b.set_defaults(fn=_cmd_behavior)

    t = sub.add_parser("trigger", help="trigger rate of a description")
    t.add_argument("--eval-set", required=True, help='JSON list of {"query": ..., "should_trigger": true|false}')
    t.add_argument("--skill-path", required=True)
    t.add_argument("--description", default=None, help="candidate description (default: the current one)")
    t.add_argument("--models", default="sonnet", help="comma list (default: sonnet)")
    t.add_argument("--num-workers", type=int, default=5)
    t.add_argument("--timeout", type=int, default=120)
    t.add_argument("--runs-per-query", type=int, default=3)
    t.add_argument("--trigger-threshold", type=float, default=0.5)
    t.add_argument("--verbose", action="store_true")
    t.add_argument("--dry-run", action="store_true", help="print the plan and spend nothing")
    t.set_defaults(fn=_cmd_trigger)

    g = sub.add_parser("grade", help="grade the runs under an earlier behavior output folder")
    g.add_argument("--out", required=True)
    g.add_argument("--grader-model", default="sonnet")
    g.set_defaults(fn=_cmd_grade)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
