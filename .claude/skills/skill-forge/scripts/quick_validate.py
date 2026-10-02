#!/usr/bin/env python3
"""Validate a skill directory.

The shared rules (name, description shape and trigger, body size, references, dated text, retired
names, tool scope) live in the CCv3 skills gate, scripts/skills/audit-skills.mjs. This script runs
the gate on the skill and adds only the checks the gate does not cover:

  - the upload key set (--target upload), for claude.ai upload and the Skills API
  - unedited scaffold placeholders and TODO markers
  - script shebangs
  - the 500-char limit on compatibility

Usage: python quick_validate.py [--target claude-code|upload] <skill_directory>
"""

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # `scripts.*` imports work from any cwd
from scripts import gate  # noqa: E402
from scripts.utils import PLACEHOLDER_DESCRIPTION  # noqa: E402


# --target upload: claude.ai upload, the Skills API and package_skill.py accept only these six
# top-level keys and hard-fail on any other. The gate (G03) accepts every Claude Code key, so this
# is the one key check that stays here.
UPLOAD_PROPERTIES = {"name", "description", "license", "allowed-tools", "metadata", "compatibility"}
TARGETS = ("claude-code", "upload")
DEFAULT_TARGET = "claude-code"


@dataclass
class ValidationResult:
    severity: str  # "error", "warning", "info"
    category: str  # "gate", "metadata", "content", "resources", "structure"
    message: str
    passed: bool


def _frontmatter(content: str) -> dict:
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return {}
    raw = match.group(1)
    if HAS_YAML:
        try:
            parsed = yaml.safe_load(raw)
            if isinstance(parsed, dict):
                return parsed
        except yaml.YAMLError:
            pass
    return {m.group(1): m.group(2).strip()
            for m in re.finditer(r"^([A-Za-z0-9_-]+):\s*(.+?)(?=\n[A-Za-z0-9_-]+:|$)", raw, re.DOTALL | re.MULTILINE)}


def gate_results(skill_path: Path) -> List[ValidationResult]:
    """Run the gate on the skill. A rule that failed hard or regressed is an error."""
    report = gate.audit_skill(skill_path)
    results = []
    for rule_id, rule in report["rules"].items():
        if rule_id == "G31":  # listing size is a whole-repo number
            continue
        severity = "error" if rule["status"] in ("FAIL", "REGRESSION") else "warning"
        for x in rule["findings"]:
            where = f" (line {x['line']})" if x.get("line") else ""
            note = " [in the baseline, so not blocking]" if severity == "warning" else ""
            results.append(ValidationResult(severity, "gate", f"{x['rule']} {rule['name']}: {x['msg']}{where}{note}", False))
    for w in report.get("warnings", []):
        results.append(ValidationResult("warning", "gate", w, False))
    if not results:
        results.append(ValidationResult("info", "gate", "Skills gate: no findings", True))
    return results


def upload_results(content: str) -> List[ValidationResult]:
    """Frontmatter limits that only claude.ai upload and the Skills API enforce."""
    fm = _frontmatter(content)
    results = []
    unexpected = set(fm) - UPLOAD_PROPERTIES
    if unexpected:
        results.append(ValidationResult(
            "error", "metadata",
            f"Unexpected frontmatter keys for --target upload: {', '.join(sorted(unexpected))}. "
            f"Allowed: {', '.join(sorted(UPLOAD_PROPERTIES))}", False))
    for key in ("name", "description"):
        if key not in fm:
            results.append(ValidationResult("error", "metadata", f"Missing '{key}' field (required for upload)", False))
    return results


def metadata_results(content: str) -> List[ValidationResult]:
    fm = _frontmatter(content)
    results = []
    description = str(fm.get("description", "")).strip()
    if PLACEHOLDER_DESCRIPTION.rstrip(".").lower() in description.lower():
        results.append(ValidationResult(
            "error", "metadata",
            f'Description is still the scaffold placeholder "{PLACEHOLDER_DESCRIPTION}". '
            "Say what the skill does and when to use it.", False))
    compatibility = str(fm.get("compatibility", "")).strip()
    if len(compatibility) > 500:
        results.append(ValidationResult(
            "error", "metadata", f"Compatibility too long ({len(compatibility)} chars, max 500)", False))
    return results


def check_todo_markers(content: str) -> List[ValidationResult]:
    # Whole word, case-sensitive: TodoWrite and "todos" are not markers. A backticked `TODO` is
    # documentation about markers, not an unfinished one.
    todos = re.findall(r"\bTODO\b", re.sub(r"`[^`\n]*`", " ", content))
    if todos:
        return [ValidationResult("error", "content", f"Found {len(todos)} TODO markers. Complete them before packaging.", False)]
    return [ValidationResult("info", "content", "No TODO markers found", True)]


def validate_scripts(skill_path: Path) -> List[ValidationResult]:
    scripts_dir = skill_path / "scripts"
    if not scripts_dir.exists():
        return []
    # A shebang matters for a script that runs. A library module (no __main__ guard) is imported.
    scripts = [s for s in list(scripts_dir.glob("*.py")) + list(scripts_dir.glob("*.sh"))
               if s.suffix == ".sh" or "__main__" in s.read_text(encoding="utf-8", errors="replace")]
    issues = [f"{s.name}: missing shebang" for s in scripts
              if not s.read_text(encoding="utf-8", errors="replace").startswith("#!")]
    if issues:
        return [ValidationResult("warning", "resources", f"Script issues: {'; '.join(issues)}", False)]
    return [ValidationResult("info", "resources", f"All {len(scripts)} scripts have a shebang", True)] if scripts else []


def validate_skill(skill_path, target: str = DEFAULT_TARGET) -> Tuple[bool, str]:
    """Return (is_valid, report). A gate that cannot run is an error, never a pass."""
    skill_path = Path(skill_path)
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    try:
        results = gate_results(skill_path)
    except gate.GateError as e:
        return False, f"Skill validation could not run the gate: {e}"
    results += metadata_results(content)
    if target == "upload":
        results += upload_results(content)
    results += check_todo_markers(content)
    results += validate_scripts(skill_path)

    errors = [r for r in results if r.severity == "error" and not r.passed]
    warnings = [r for r in results if r.severity == "warning" and not r.passed]
    lines = ["\nValidation Report:", f"  {sum(1 for r in results if r.passed)} checks passed"]
    if warnings:
        lines.append(f"  {len(warnings)} warnings:")
        lines += [f"     - {w.message}" for w in warnings]
    if errors:
        lines.append(f"  {len(errors)} errors:")
        lines += [f"     - {e.message}" for e in errors]
        lines.append("\n  Fix errors before packaging")
    report = "\n".join(lines)
    if errors:
        return False, "Skill has validation errors" + report
    return True, "Skill validation passed!" + report


def _parse_args(argv):
    """Return (skill_directory, target) or None when the arguments are wrong."""
    target = DEFAULT_TARGET
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--target" and i + 1 < len(argv):
            target = argv[i + 1]
            i += 2
        elif argv[i].startswith("--target="):
            target = argv[i].split("=", 1)[1]
            i += 1
        else:
            rest.append(argv[i])
            i += 1
    if len(rest) != 1 or target not in TARGETS:
        return None
    return rest[0], target


if __name__ == "__main__":
    parsed = _parse_args(sys.argv[1:])
    if parsed is None:
        print("Usage: python quick_validate.py [--target claude-code|upload] <skill_directory>")
        print("  --target claude-code  (default) the shared gate rules")
        print("  --target upload       the gate rules plus the six keys claude.ai upload accepts")
        sys.exit(1)
    valid, message = validate_skill(parsed[0], parsed[1])
    print(message)
    sys.exit(0 if valid else 1)
