"""Load behaviour evals. Two shapes are accepted and normalised to one.

Guide shape (Anthropic best practices):
    [{"skills": ["name"], "query": "...", "files": [], "expected_behavior": ["..."]}]
    or {"evals": [ ... the same ... ]}

Existing shape (references/schemas.md):
    {"skill_name": "x", "evals": [{"id": 1, "prompt": "...", "expected_output": "...",
                                    "files": [], "expectations": ["..."]}]}

Normalised eval: {"id", "name", "prompt", "files", "skills", "assertions"}.
`expected_behavior`, `expectations` and `assertions` all become `assertions`. When none is given,
`expected_output` becomes the single assertion.
"""

import json
from pathlib import Path

MIN_EVALS = 3


class EvalError(ValueError):
    """The evals file is not usable."""


def _assertions(raw: dict) -> list[str]:
    for key in ("assertions", "expectations", "expected_behavior"):
        value = raw.get(key)
        if isinstance(value, list) and value:
            return [str(v) for v in value]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
    out = raw.get("expected_output")
    return [str(out)] if isinstance(out, str) and out.strip() else []


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
        out.append({"id": eval_id, "name": str(raw.get("name") or f"eval-{eval_id}"), "prompt": prompt,
                    "files": list(raw.get("files") or []), "skills": list(raw.get("skills") or []),
                    "assertions": assertions})
    return out
