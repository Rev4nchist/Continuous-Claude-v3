#!/usr/bin/env python3
"""Create a skill scaffold: one SKILL.md that passes the skills gate.

Usage:
    init_skill.py <skill-name> [--path <parent-dir>] [--scripts] [--references] [--assets] [--dry-run]

The default parent directory is the repo's .claude/skills. The repo is the source of every skill.
Never scaffold into ~/.claude/skills: that is the active copy, and the next sync overwrites it.

The name rule comes from the gate (audit-skills.mjs --check-name), so this script and the gate
cannot disagree. The description is the placeholder "Does X. Use when Y." It passes the gate and
fails quick_validate.py until you replace it.
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # `scripts.*` imports work from any cwd
from scripts import gate  # noqa: E402
from scripts.utils import PLACEHOLDER_DESCRIPTION  # noqa: E402

SKILL_TEMPLATE = """---
name: {name}
description: {description}
---

# {title}

TODO: one sentence on what Claude must do that it does not already know.

## Workflow

1. TODO: first step, in the imperative.
2. TODO: second step.
"""

RESOURCES = {
    "scripts": (
        "example.py",
        "#!/usr/bin/env python3\n"
        '"""TODO: replace with a script for one deterministic step, or delete scripts/."""\n\n'
        'if __name__ == "__main__":\n    print("TODO")\n',
        "Run `scripts/example.py` for TODO: the deterministic step. Execute it, do not read it.",
    ),
    "references": (
        "reference.md",
        "# Reference\n\nTODO: detail that SKILL.md needs only sometimes.\n",
        "Read [reference.md](references/reference.md) only when TODO: the condition.",
    ),
    "assets": (
        "template.txt",
        "TODO: a file Claude copies into its output, or delete assets/.\n",
        "Copy `assets/template.txt` as the starting point for TODO: the output.",
    ),
}


def title_case_skill_name(skill_name: str) -> str:
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def active_skills_dir() -> Path:
    return Path.home() / ".claude" / "skills"


def is_inside(path: Path, parent: Path) -> bool:
    p, q = os.path.normcase(str(path.resolve())), os.path.normcase(str(parent.resolve()))
    return p == q or p.startswith(q + os.sep)


def default_parent() -> Path:
    root = gate.find_repo_root()
    if root is None:
        raise gate.GateError("cannot find the repo that holds scripts/skills/audit-skills.mjs. "
                             "Pass --path or set CCV3_REPO_ROOT.")
    return root / ".claude" / "skills"


def render(name: str, flags: set) -> str:
    text = SKILL_TEMPLATE.format(name=name, title=title_case_skill_name(name), description=PLACEHOLDER_DESCRIPTION)
    lines = [RESOURCES[k][2] for k in RESOURCES if k in flags]
    return text + ("\n" + "\n".join(lines) + "\n" if lines else "")


def init_skill(name: str, parent: Path, flags: set, dry_run: bool = False):
    """Create the skill. Return its directory, or None on an error (already printed)."""
    findings = gate.check_name(name)
    if findings:
        for f in findings:
            print(f"Error: {f['rule']} {f['msg']}", file=sys.stderr)
        return None
    if is_inside(parent, active_skills_dir()):
        print(f"Error: {parent} is the active skills folder (~/.claude/skills). Scaffold into the repo's "
              ".claude/skills; the next sync overwrites the active copy.", file=sys.stderr)
        return None
    skill_dir = parent.resolve() / name
    if skill_dir.exists():
        print(f"Error: skill directory already exists: {skill_dir}", file=sys.stderr)
        return None
    if dry_run:
        print(f"Would create {skill_dir}")
        return skill_dir
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(render(name, flags), encoding="utf-8", newline="\n")
    for key in RESOURCES:
        if key in flags:
            sub = skill_dir / key
            sub.mkdir()
            (sub / RESOURCES[key][0]).write_text(RESOURCES[key][1], encoding="utf-8", newline="\n")
    print(f"Created {skill_dir}")
    return skill_dir


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Create a skill scaffold (SKILL.md only by default).")
    ap.add_argument("name", help="skill name: lowercase letters, digits and hyphens, max 64")
    ap.add_argument("--path", help="parent directory (default: the repo's .claude/skills)")
    ap.add_argument("--scripts", action="store_true", help="also create scripts/")
    ap.add_argument("--references", action="store_true", help="also create references/")
    ap.add_argument("--assets", action="store_true", help="also create assets/")
    ap.add_argument("--dry-run", action="store_true", help="print the target and write nothing")
    args = ap.parse_args(argv)

    try:
        parent = Path(args.path) if args.path else default_parent()
        flags = {k for k in RESOURCES if getattr(args, k)}
        result = init_skill(args.name, parent, flags, args.dry_run)
    except gate.GateError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    if result is None:
        return 1
    if not args.dry_run:
        print("Next: replace every TODO and the placeholder description, then run "
              f"python scripts/quick_validate.py {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
