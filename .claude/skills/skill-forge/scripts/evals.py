"""Load behaviour evals and trigger sets. Two eval shapes are accepted and normalised to one.

Guide shape (Anthropic best practices):
    [{"skills": ["name"], "query": "...", "files": [], "expected_behavior": ["..."]}]
    or {"evals": [ ... the same ... ]}

Existing shape (references/schemas.md):
    {"skill_name": "x", "evals": [{"id": 1, "prompt": "...", "expected_output": "...",
                                    "files": [], "expectations": ["..."]}]}

Normalised eval: {"id", "name", "prompt", "files", "skills", "assertions"}.
The assertions come from the first of `expected_behavior`, `expectations`, `assertions` that holds
a list or a string. When none does, `expected_output` becomes the single assertion.

`files` are paths relative to the skill folder and `skills` are skill folder names. Neither may
point outside: no absolute path and no `..` part.
"""

import json
import re
from pathlib import Path

MIN_EVALS = 3
ASSERTION_KEYS = ("expected_behavior", "expectations", "assertions")  # the first one present wins


class EvalError(ValueError):
    """The evals file is not usable."""


def _assertions(raw: dict) -> list[str]:
    for key in ASSERTION_KEYS:
        value = raw.get(key)
        if isinstance(value, list) and value:
            return [str(v) for v in value]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
    out = raw.get("expected_output")
    return [str(out)] if isinstance(out, str) and out.strip() else []


def _relative_path(value, what: str, eval_id) -> str:
    text = str(value)
    parts = re.split(r"[\\/]+", text)
    if (not text or text.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", text) or ".." in parts):
        raise EvalError(f"eval {eval_id} {what} '{text}' must be a relative path inside the skill: no absolute path, no '..'")
    return text


def _skill_name(value, eval_id) -> str:
    text = str(value)
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", text) or text == "..":
        raise EvalError(f"eval {eval_id} skill '{text}' must be a skill folder name, not a path")
    return text


def load_evals(path, min_evals: int = MIN_EVALS) -> list[dict]:
    """Read and normalise an evals file. Raise EvalError on a problem."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise EvalError(f"cannot read evals file {path}: {e}") from None
    items = data.get("evals") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise EvalError("evals file must be a list of evals or an object with an 'evals' list")
    if len(items) < min_evals:
        raise EvalError(f"a skill needs at least {min_evals} evals, found {len(items)}")

    out, seen = [], set()
    for index, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise EvalError(f"eval {index} is not an object")
        prompt = raw.get("prompt") or raw.get("query")
        if not isinstance(prompt, str) or not prompt.strip():
            raise EvalError(f"eval {index} has no prompt (use 'query' or 'prompt')")
        eval_id = raw.get("id", index)
        if eval_id in seen:
            raise EvalError(f"eval id {eval_id} is used twice")
        seen.add(eval_id)
        assertions = _assertions(raw)
        if not assertions:
            raise EvalError(f"eval {eval_id} has nothing to grade (give expected_behavior, expectations or expected_output)")
        files = [_relative_path(f, "file", eval_id) for f in raw.get("files") or []]
        skills = [_skill_name(s, eval_id) for s in raw.get("skills") or []]
        out.append({"id": eval_id, "name": str(raw.get("name") or f"eval-{eval_id}"), "prompt": prompt,
                    "files": files, "skills": skills, "assertions": assertions})
    return out


def load_trigger_set(path) -> list[dict]:
    """Read a trigger set: a non-empty list of {"query": str, "should_trigger": bool}.

    An empty set would score 0 of 0 and read as "all passed", so it is an error.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise EvalError(f"cannot read trigger set {path}: {e}") from None
    if not isinstance(data, list) or not data:
        raise EvalError("the trigger set must be a non-empty list of {query, should_trigger} (an empty set would score 0 of 0)")
    for i, item in enumerate(data, start=1):
        if not (isinstance(item, dict) and isinstance(item.get("query"), str) and item["query"].strip()
                and isinstance(item.get("should_trigger"), bool)):
            raise EvalError(f"trigger set item {i} needs a non-empty string 'query' and a boolean 'should_trigger'")
    return data
