#!/usr/bin/env python3
"""Run skill evals headlessly.

  behavior  Run each eval with the skill ON and OFF, on each model. Record which skill fired and
            which files the run read. Grade with --grade.
  trigger   Run trigger queries against a candidate description. Report the trigger rate.
  grade     Grade the runs of an earlier `behavior` run.

Baseline = the same prompt with the skill turned off through skillOverrides in a --settings file.
Every run happens in a temp project. Nothing is written into the repo, and no command file is
created. Headless rules (subscription billing, no hooks, no MCP, no shell): scripts/headless.py.

Examples:
  python scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals evals.json --out OUT --grade
  python scripts/run_eval.py behavior --skill-path .claude/skills/premortem --evals evals.json --dry-run
  python scripts/run_eval.py trigger --skill-path .claude/skills/premortem --eval-set triggers.json
"""

import argparse
import hashlib
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
from scripts.evals import EvalError, MIN_EVALS, load_evals  # noqa: E402
from scripts.utils import parse_skill_md  # noqa: E402

SKILL_DIR = Path(__file__).resolve().parent.parent
CONFIGS = ("with_skill", "without_skill")  # the viewer and aggregate_benchmark read these exact strings


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

    @property
    def skill_copy(self) -> Path:
        return self.cwd / ".claude" / "skills" / self.skill_name


def skill_name_of(skill_path: Path) -> str:
    name, _, _ = parse_skill_md(skill_path)
    return name or skill_path.name


def _exe() -> str:
    try:
        return headless.find_claude()
    except RuntimeError:
        return "claude"  # a dry run still prints the plan; a live run fails with a clear spawn error


def _build_project(cwd: Path, skill_path: Path, ev: dict) -> None:
    """A temp project: the skill under test, any skills the eval names, and the eval's input files."""
    skills_root = skill_path.parent
    names = [skill_path.name] + [s for s in ev.get("skills", []) if s != skill_path.name]
    for name in names:
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


def plan_runs(skill_path, evals, models, out_dir, work_dir, tools=headless.DEFAULT_TOOLS,
              max_turns=headless.DEFAULT_MAX_TURNS, exe=None) -> list[RunSpec]:
    """One RunSpec per model x eval x config. Writes the temp projects and settings files."""
    skill_path, out_dir, work_dir = Path(skill_path).resolve(), Path(out_dir), Path(work_dir)
    name = skill_name_of(skill_path)
    exe = exe or _exe()
    specs = []
    for model in models:
        for ev in evals:
            for config in CONFIGS:
                tag = f"{model.alias}-eval-{ev['id']}-{config}"
                cwd = work_dir / tag / "project"
                cwd.mkdir(parents=True)
                _build_project(cwd, skill_path, ev)
                overrides = {name: "off"} if config == "without_skill" else None
                settings = headless.write_settings(work_dir / tag / "settings.json", overrides)
                mcp = headless.write_empty_mcp(work_dir / tag / "mcp.json")
                command = headless.build_command(model, settings, mcp, tools, max_turns, exe=exe, allowed=tools)
                run_dir = Path(out_dir) / model.alias / f"eval-{ev['id']}" / config / "run-1"
                specs.append(RunSpec(ev["id"], ev, model, config, name, run_dir, cwd, settings, mcp, command, ev["prompt"]))
    return specs


# ----------------------------------------------------------------- execution

def execute(spec: RunSpec, timeout: int) -> dict:
    """Run one spec. Write transcript.jsonl, transcript.md, outputs/response.md, timing.json and run.json."""
    run = headless.run_claude(spec.command, spec.prompt, spec.cwd, timeout)
    info = headless.parse_stream(run.stdout)
    nav = headless.navigation(info["files_read"], spec.skill_copy)
    copy_root = str(spec.skill_copy).replace("\\", "/").lower()
    read_skill = [f for f in info["files_read"] if f.replace("\\", "/").lower().startswith(copy_root + "/")]
    m = headless.metrics(info["result"], run.seconds)

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
        "skill_listed": None if info["listed_skills"] is None else spec.skill_name in info["listed_skills"],
        "skill_fired": any(s == spec.skill_name or s.endswith(":" + spec.skill_name) for s in info["skills_fired"]),
        "skills_fired": info["skills_fired"], "tool_counts": info["tool_counts"], "navigation": nav,
        # A baseline run that reads the skill's files found the skill without the Skill tool.
        "baseline_contaminated": spec.config == "without_skill" and bool(read_skill),
        "skill_errors": info["skill_errors"],
        "final_text": info["final_text"], "metrics": m,
        # A fired skill whose load failed is a broken run, not evidence about the skill.
        "error": run.error or (f"skill load failed: {info['skill_errors'][0]}" if info["skill_errors"] else None)
        or ("result error" if m["is_error"] else None),
        "stderr": run.stderr, "assertions": spec.eval["assertions"],
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
    grader = (SKILL_DIR / "agents" / "grader.md").read_text(encoding="utf-8")
    expectations = "\n".join(f"{i}. {a}" for i, a in enumerate(record["assertions"], 1))
    prompt = (f"{grader}\n\n---\n\nGrade this run now.\n\n"
              "Output rule for this run: you have only the Read tool. Do not write grading.json. "
              "Print the grading object as ONE JSON object in a ```json fence, and nothing after it.\n\n"
              f"expectations:\n{expectations}\n\n"
              "transcript_path: transcript.md\noutputs_dir: outputs\n"
              f"run_record: run.json (skill_fired={record['skill_fired']}; see navigation for the files read)\n")
    tmp = headless.make_temp("skill-grade-")
    try:
        cmd = headless.build_command(grader_model, headless.write_settings(tmp / "s.json"), headless.write_empty_mcp(tmp / "m.json"),
                                     tools="Read", max_turns=8, exe=_exe())
        run = headless.run_claude(cmd, prompt, run_dir, timeout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    info = headless.parse_stream(run.stdout)
    grading = _extract_json(info["final_text"] or "")
    if not grading or not isinstance(grading.get("expectations"), list):
        grading = {"expectations": [], "error": run.error or "grader returned no JSON", "raw": (info["final_text"] or "")[:1000]}
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


def prepare_trigger_project(skill_path, description: str, work_dir):
    """A temp project with a renamed copy of the skill that carries the candidate description.

    The real skill is switched off, so the model can only pick the candidate. Return
    (project_dir, candidate_name, settings_path). The source skill is never changed.
    """
    skill_path, work_dir = Path(skill_path).resolve(), Path(work_dir)
    name = skill_name_of(skill_path)
    candidate = f"{name}-cand{uuid.uuid4().hex[:6]}"
    project = work_dir / "project"
    dest = headless.copy_skill(skill_path, project / ".claude" / "skills" / candidate)
    text = (dest / "SKILL.md").read_text(encoding="utf-8").replace("\r\n", "\n")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        raise EvalError(f"{skill_path / 'SKILL.md'} has no frontmatter")
    kept, skipping = [], False
    for line in m.group(1).split("\n"):
        if re.match(r"^(name|description):", line):
            skipping = line.startswith("description:")
            continue
        if skipping and re.match(r"^[ \t]", line):
            continue
        skipping = False
        kept.append(line)
    fm = [f"name: {candidate}", f"description: {_yaml_scalar(description)}", *kept]
    (dest / "SKILL.md").write_text("---\n" + "\n".join(fm) + "\n---\n" + text[m.end():], encoding="utf-8", newline="\n")
    settings = headless.write_settings(work_dir / "settings.json", {name: "off"})
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
                     trigger_threshold=0.5, exe=None) -> dict:
    """Trigger rate per query for a candidate description, pooled over models and runs."""
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
            for item, model, fut in jobs:
                run = fut.result()
                q = per_query.setdefault(item["query"], {"item": item, "fired": 0, "runs": 0, "errors": 0, "by_model": {}})
                if run.error:
                    q["errors"] += 1
                    continue
                hit = headless.skill_fired(run.stdout, candidate)
                q["runs"] += 1
                q["fired"] += int(hit)
                bm = q["by_model"].setdefault(model.alias, [0, 0])
                bm[0] += int(hit)
                bm[1] += 1
    finally:
        shutil.rmtree(work, ignore_errors=True)

    results = []
    for query, q in per_query.items():
        runs, should = q["runs"], q["item"]["should_trigger"]
        rate = q["fired"] / runs if runs else None
        ok = rate is not None and (rate >= trigger_threshold if should else rate < trigger_threshold)
        results.append({"query": query, "should_trigger": should, "trigger_rate": rate, "triggers": q["fired"],
                        "runs": runs, "errors": q["errors"], "pass": ok,
                        "by_model": {k: f"{v[0]}/{v[1]}" for k, v in q["by_model"].items()}})
    passed = sum(1 for r in results if r["pass"])
    return {"skill_name": skill_name_of(skill_path), "description": description, "models": [m.id for m in models],
            "results": results, "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed}}


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
    name = skill_name_of(skill_path)
    out = Path(a.out) if a.out else Path(os.path.realpath(tempfile.gettempdir())) / "skill-eval" / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}"
    work = headless.make_temp("skill-eval-")
    try:
        specs = plan_runs(skill_path, evals, models, out, work, a.tools, a.max_turns)
        warn = _active_copy_warning(skill_path, name)
        if warn:
            print(f"Warning: {warn}", file=sys.stderr)
        if a.dry_run:
            print(f"exe: {specs[0].command[0]}  (shell=False; the prompt goes on stdin; ANTHROPIC_API_KEY removed)")
            for s in specs:
                print(f"[{s.model.alias} eval-{s.eval_id} {s.config}] settings={json.dumps(json.loads(s.settings_path.read_text()))}")
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
                g = grade_run(run_dir, grader)
                r["grading"] = g["summary"]
        headless.write_json(out / "summary.json", {"skill": name, "warnings": [warn] if warn else [], "runs": [
            {k: v for k, v in r.items() if k not in ("final_text", "prompt", "assertions")} for r in records]})
        for r in records:
            g = r.get("grading")
            print(f"{r['model']:7} eval-{r['eval_id']} {r['config']:13} listed={str(r['skill_listed']):5} fired={str(r['skill_fired']):5} "
                  f"read={r['navigation']['skill_files_read']} " + (f"pass={g['passed']}/{g['total']} " if g else "") +
                  f"error={r['error']}")
        print(f"summary: {out / 'summary.json'}")
        return 1 if any(r["error"] for r in records) else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _active_copy_warning(skill_path: Path, name: str):
    """A personal skill of the same name wins over the project copy. Say so when the copies differ."""
    active = Path.home() / ".claude" / "skills" / name / "SKILL.md"
    mine = skill_path / "SKILL.md"
    if active.is_file() and mine.is_file() and active.resolve() != mine.resolve():
        h = lambda p: hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()  # noqa: E731
        if h(active) != h(mine):
            return (f"~/.claude/skills/{name}/SKILL.md differs from {mine}. A personal skill wins over the project copy, "
                    "so with_skill runs use the active version. Sync first.")
    return None


def _cmd_trigger(a) -> int:
    models = _models_or_exit(a.models)
    skill_path = Path(a.skill_path)
    if not (skill_path / "SKILL.md").is_file():
        print(f"Error: no SKILL.md at {skill_path}", file=sys.stderr)
        return 1
    eval_set = json.loads(Path(a.eval_set).read_text(encoding="utf-8"))
    description = a.description or parse_skill_md(skill_path)[1]
    if a.dry_run:
        print_trigger_plan(eval_set, skill_path, description, models, a.runs_per_query)
        return 0
    out = run_trigger_eval(eval_set, skill_path, description, models, a.num_workers, a.timeout, a.runs_per_query, a.trigger_threshold)
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
        print(f"{r.parent}: {g['summary']['passed']}/{g['summary']['total']}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Run skill evals headlessly")
    sub = ap.add_subparsers(dest="mode", required=True)

    b = sub.add_parser("behavior", help="eval runs: skill on vs skill off, per model")
    b.add_argument("--skill-path", required=True)
    b.add_argument("--evals", required=True, help="evals JSON (guide shape or evals.json shape)")
    b.add_argument("--models", default=None, help="comma list of sonnet,opus,fable or claude-* ids (default: all three; never haiku)")
    b.add_argument("--eval-ids", default=None, help="run only these eval ids, for example 1 or 1,3")
    b.add_argument("--out", default=None, help="output folder (default: a temp folder, never inside the repo)")
    b.add_argument("--tools", default=headless.DEFAULT_TOOLS, help="built-in tools the run may use (default: read-only)")
    b.add_argument("--max-turns", type=int, default=headless.DEFAULT_MAX_TURNS)
    b.add_argument("--timeout", type=int, default=headless.DEFAULT_TIMEOUT)
    b.add_argument("--workers", type=int, default=3)
    b.add_argument("--min-evals", type=int, default=MIN_EVALS)
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
