#!/usr/bin/env python3
"""Improve a skill description from trigger-eval results.

The proposal comes from `claude -p` on the subscription (no Anthropic API, no API key). Every
proposal is checked against the 400-char cap and the gate's description rules before it is
accepted. The convention is one line, third person: "Does X. Use when Y."
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # `scripts.*` imports work from any cwd
from scripts import gate, headless  # noqa: E402
from scripts.utils import parse_skill_md  # noqa: E402

MAX_ATTEMPTS = 3


def validate_proposal(name: str, description: str) -> list[str]:
    """Problems with a proposed description. An empty list means it is acceptable."""
    return gate.check_description(name, description)


def _clean(text: str) -> str:
    match = re.search(r"<new_description>(.*?)</new_description>", text, re.DOTALL)
    raw = match.group(1) if match else text
    return " ".join(raw.strip().strip('"').split())


def build_prompt(skill_name, skill_content, current_description, eval_results, history, test_results=None) -> str:
    failed = [r for r in eval_results["results"] if r["should_trigger"] and not r["pass"]]
    false = [r for r in eval_results["results"] if not r["should_trigger"] and not r["pass"]]
    scores = f"Train: {eval_results['summary']['passed']}/{eval_results['summary']['total']}"
    if test_results:
        scores += f", Test: {test_results['summary']['passed']}/{test_results['summary']['total']}"

    p = [f'You are tuning the description of a Claude Code skill named "{skill_name}". Claude sees only the name and this '
         "description when it chooses a skill. The body loads after the choice.\n",
         f"Current description:\n<current_description>\n{current_description}\n</current_description>\n",
         f"Scores: {scores}\n"]
    if failed:
        p.append("FAILED TO TRIGGER (should have):")
        p += [f'  - "{r["query"]}" ({r["triggers"]}/{r["runs"]} runs fired)' for r in failed]
    if false:
        p.append("FALSE TRIGGERS (should not have):")
        p += [f'  - "{r["query"]}" ({r["triggers"]}/{r["runs"]} runs fired)' for r in false]
    if history:
        p.append("\nPREVIOUS ATTEMPTS (do not repeat them):")
        for h in history:
            p.append(f'  - train={h.get("train_passed", h.get("passed", 0))}/{h.get("train_total", h.get("total", 0))}: "{h["description"]}"')
    p.append(f"\nSkill body, for context:\n<skill_content>\n{skill_content}\n</skill_content>\n")
    p.append(
        "Write one new description. Rules:\n"
        '- One line, third person, in the form "Does X. Use when Y." Never "I" or "you".\n'
        f"- At most {gate.DESCRIPTION_MAX_CHARS} characters. Shorter is better: every description is paid for on every turn.\n"
        "- Name the specific terms and situations that should trigger it. Add \"Not for Z\" when a near miss needs it. "
        "Do not push: no \"always use this\", no lists of every query.\n"
        "- Generalise from the failures to the user's intent. Do not copy the failing queries.\n"
        '- Avoid ": " and " #" inside the text (they break plain YAML), and no angle brackets.\n\n'
        "Reply with only the description inside <new_description> tags.")
    return "\n".join(p)


def _ask(prompt: str, model: headless.Model, timeout: int = 300) -> str:
    """One tool-less `claude -p` turn on the subscription. Return the reply text."""
    tmp = headless.make_temp("skill-improve-")
    try:
        cmd = headless.build_command(model, headless.write_settings(tmp / "s.json"), headless.write_empty_mcp(tmp / "m.json"),
                                     tools="", max_turns=1)
        run = headless.run_claude(cmd, prompt, tmp, timeout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    info = headless.parse_stream(run.stdout)
    if not info["final_text"]:
        raise RuntimeError(f"claude -p returned no text ({run.error or run.stderr.strip() or 'empty'})")
    return info["final_text"]


def improve_description(skill_name, skill_content, current_description, eval_results, history, model,
                        test_results=None, log_dir=None, iteration=None, ask=_ask):
    """Return a valid new description, or None when no attempt passes the checks."""
    if isinstance(model, str):
        model = headless.resolve_models(model)[0]
    prompt = build_prompt(skill_name, skill_content, current_description, eval_results, history, test_results)
    attempts, description, problems = [], None, []
    for n in range(1, MAX_ATTEMPTS + 1):
        ask_prompt = prompt if not problems else (
            f"{prompt}\n\nYour previous proposal was rejected:\n  {description}\nProblems:\n  - " + "\n  - ".join(problems) +
            "\nWrite a new description that fixes every problem.")
        description = _clean(ask(ask_prompt, model))
        problems = validate_proposal(skill_name, description)
        attempts.append({"attempt": n, "description": description, "chars": len(description), "problems": problems})
        if not problems:
            break
    if log_dir:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        (Path(log_dir) / f"improve_iter_{iteration or 'unknown'}.json").write_text(
            json.dumps({"iteration": iteration, "prompt": prompt, "attempts": attempts}, indent=2), encoding="utf-8")
    return None if problems else description


def main():
    ap = argparse.ArgumentParser(description="Improve a skill description based on eval results")
    ap.add_argument("--eval-results", required=True, help="eval results JSON (from run_eval.py trigger)")
    ap.add_argument("--skill-path", required=True)
    ap.add_argument("--history", default=None)
    ap.add_argument("--model", default="sonnet", help="sonnet, opus, fable or a claude-* id (never haiku)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)
    try:
        model = headless.resolve_models(args.model)[0]
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)
    eval_results = json.loads(Path(args.eval_results).read_text(encoding="utf-8"))
    history = json.loads(Path(args.history).read_text(encoding="utf-8")) if args.history else []
    name, _, content = parse_skill_md(skill_path)
    current = eval_results["description"]

    new = improve_description(name, content, current, eval_results, history, model)
    if args.verbose:
        print(f"Improved: {new}", file=sys.stderr)
    print(json.dumps({"description": new, "history": history + [{
        "description": current, "passed": eval_results["summary"]["passed"], "failed": eval_results["summary"]["failed"],
        "total": eval_results["summary"]["total"], "results": eval_results["results"]}]}, indent=2))
    sys.exit(0 if new else 1)


if __name__ == "__main__":
    main()
