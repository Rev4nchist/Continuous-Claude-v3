#!/usr/bin/env python3
"""
Comprehensive skill validation - merged from create-better-skills v2.0
and Anthropic's skill-creator plugin.

Validates skills against quality checklist with 8 validation categories:
  - Structure, metadata (frontmatter), allowed properties, TODO markers,
    word count, file paths, scripts, and examples.
"""

import sys
import os
import re
from pathlib import Path
from dataclasses import dataclass
from typing import List, Tuple

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


# --target upload: claude.ai upload, the Skills API and package_skill.py accept only these six
# top-level keys and hard-fail on any other.
UPLOAD_PROPERTIES = {
    "name", "description", "license", "allowed-tools", "metadata", "compatibility"
}

# --target claude-code (default): the keys Claude Code reads (code.claude.com/docs/en/skills).
# Claude Code ignores a key it does not know, so an unknown key is reported but never silently
# accepted. Keep this list in step with KNOWN_KEYS in scripts/skills/lib/skill-rules.mjs.
CLAUDE_CODE_PROPERTIES = UPLOAD_PROPERTIES | {
    "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
    "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths",
    "shell",
}

TARGETS = {"claude-code": CLAUDE_CODE_PROPERTIES, "upload": UPLOAD_PROPERTIES}
DEFAULT_TARGET = "claude-code"


@dataclass
class ValidationResult:
    """Result of a validation check"""
    severity: str  # "error", "warning", "info"
    category: str  # "metadata", "content", "resources", "structure"
    message: str
    passed: bool


def _parse_frontmatter(content: str) -> dict:
    """Parse YAML frontmatter, trying yaml.safe_load first, falling back to regex."""
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
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

    # Regex fallback for simple key: value pairs
    result = {}
    for m in re.finditer(r'^([a-z_-]+):\s*(.+?)(?=\n[a-z_-]+:|$)', raw, re.DOTALL | re.MULTILINE):
        result[m.group(1)] = m.group(2).strip()
    return result


def validate_basic_structure(skill_path: Path) -> List[ValidationResult]:
    """Validate basic skill structure"""
    results = []

    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        results.append(ValidationResult(
            severity="error", category="structure",
            message="SKILL.md not found", passed=False
        ))
        return results

    results.append(ValidationResult(
        severity="info", category="structure",
        message="SKILL.md found", passed=True
    ))
    return results


def validate_frontmatter(content: str, target: str = DEFAULT_TARGET) -> List[ValidationResult]:
    """Validate YAML frontmatter against the key set of the chosen target"""
    results = []

    if not content.startswith('---'):
        results.append(ValidationResult(
            severity="error", category="metadata",
            message="No YAML frontmatter found (must start with ---)",
            passed=False
        ))
        return results

    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        results.append(ValidationResult(
            severity="error", category="metadata",
            message="Invalid frontmatter format", passed=False
        ))
        return results

    fm = _parse_frontmatter(content)

    # -- Allowed properties check (per target) --
    allowed = TARGETS[target]
    unexpected = set(fm.keys()) - allowed
    if unexpected:
        results.append(ValidationResult(
            severity="error", category="metadata",
            message=f"Unexpected frontmatter keys: {', '.join(sorted(unexpected))}. "
                    f"Allowed for --target {target}: {', '.join(sorted(allowed))}",
            passed=False
        ))

    # -- Required fields --
    if 'name' not in fm:
        results.append(ValidationResult(
            severity="error", category="metadata",
            message="Missing 'name' field in frontmatter", passed=False
        ))

    if 'description' not in fm:
        results.append(ValidationResult(
            severity="error", category="metadata",
            message="Missing 'description' field in frontmatter", passed=False
        ))

    # -- Name validation --
    name = str(fm.get('name', '')).strip()
    if name:
        if not re.match(r'^[a-z0-9-]+$', name):
            results.append(ValidationResult(
                severity="error", category="metadata",
                message=f"Name '{name}' must be kebab-case (lowercase, digits, hyphens only)",
                passed=False
            ))
        elif name.startswith('-') or name.endswith('-') or '--' in name:
            results.append(ValidationResult(
                severity="error", category="metadata",
                message=f"Name '{name}' cannot start/end with hyphen or have consecutive hyphens",
                passed=False
            ))
        else:
            results.append(ValidationResult(
                severity="info", category="metadata",
                message=f"Name '{name}' follows naming convention", passed=True
            ))

        # Max length (Anthropic spec: 64 chars)
        if len(name) > 64:
            results.append(ValidationResult(
                severity="error", category="metadata",
                message=f"Name too long ({len(name)} chars, max 64)", passed=False
            ))

    # -- Description validation --
    description = str(fm.get('description', '')).strip()
    if description:
        # Angle brackets
        if '<' in description or '>' in description:
            results.append(ValidationResult(
                severity="error", category="metadata",
                message="Description cannot contain angle brackets (< or >)",
                passed=False
            ))

        # Max chars (Anthropic spec: 1024)
        if len(description) > 1024:
            results.append(ValidationResult(
                severity="error", category="metadata",
                message=f"Description too long ({len(description)} chars, max 1024)",
                passed=False
            ))

        # Word count (50-150 recommended)
        word_count = len(description.split())
        if word_count < 50:
            results.append(ValidationResult(
                severity="warning", category="metadata",
                message=f"Description short ({word_count} words, recommend 50-150)",
                passed=False
            ))
        elif word_count > 150:
            results.append(ValidationResult(
                severity="warning", category="metadata",
                message=f"Description long ({word_count} words, recommend 50-150)",
                passed=False
            ))
        else:
            results.append(ValidationResult(
                severity="info", category="metadata",
                message=f"Description length OK ({word_count} words)", passed=True
            ))

        # Trigger keywords
        trigger_patterns = [
            r'when\s+users?\s+(request|ask|need|want)',
            r'use\s+when',
            r'for\s+(creating|generating|building|working with)',
            r'this\s+skill\s+(should\s+be\s+)?used?\s+when',
        ]
        has_trigger = any(re.search(p, description.lower()) for p in trigger_patterns)
        if not has_trigger:
            results.append(ValidationResult(
                severity="warning", category="metadata",
                message="Description missing trigger keywords (e.g., 'when users request', 'use when')",
                passed=False
            ))
        else:
            results.append(ValidationResult(
                severity="info", category="metadata",
                message="Trigger keywords present in description", passed=True
            ))

        # Third-person perspective
        you_count = len(re.findall(r'\byou\b', description.lower()))
        if you_count > 3:
            results.append(ValidationResult(
                severity="warning", category="metadata",
                message=f"Description uses second-person heavily ({you_count}x 'you') - prefer third-person",
                passed=False
            ))

    # -- Compatibility validation (optional field) --
    compatibility = str(fm.get('compatibility', '')).strip()
    if compatibility and len(compatibility) > 500:
        results.append(ValidationResult(
            severity="error", category="metadata",
            message=f"Compatibility too long ({len(compatibility)} chars, max 500)",
            passed=False
        ))

    return results


def check_todo_markers(content: str) -> List[ValidationResult]:
    """Check for remaining TODO markers"""
    results = []
    # Whole word, case-sensitive: TodoWrite and "todos" are not markers.
    todos = re.findall(r'\bTODO\b', content)
    if todos:
        results.append(ValidationResult(
            severity="error", category="content",
            message=f"Found {len(todos)} TODO markers - complete before packaging",
            passed=False
        ))
    else:
        results.append(ValidationResult(
            severity="info", category="content",
            message="No TODO markers found", passed=True
        ))
    return results


def check_word_count(content: str) -> List[ValidationResult]:
    """Check that SKILL.md is under 5k words"""
    results = []
    content_no_fm = re.sub(r'^---.*?---', '', content, flags=re.DOTALL)
    word_count = len(content_no_fm.split())

    if word_count > 5000:
        results.append(ValidationResult(
            severity="warning", category="content",
            message=f"SKILL.md long ({word_count} words, recommend <5000) - consider moving content to references/",
            passed=False
        ))
    else:
        results.append(ValidationResult(
            severity="info", category="content",
            message=f"Word count OK ({word_count} words)", passed=True
        ))
    return results


def validate_file_paths(skill_path: Path, content: str) -> List[ValidationResult]:
    """Validate that referenced file paths exist"""
    results = []
    patterns = [
        r'`(scripts/[^`]+)`',
        r'`(references/[^`]+)`',
        r'`(assets/[^`]+)`',
    ]
    missing_files = []
    referenced_files = set()

    for pattern in patterns:
        matches = re.findall(pattern, content)
        for match in matches:
            referenced_files.add(match)
            file_path = skill_path / match
            if not file_path.exists():
                missing_files.append(match)

    if missing_files:
        results.append(ValidationResult(
            severity="error", category="resources",
            message=f"Referenced files don't exist: {', '.join(missing_files)}",
            passed=False
        ))
    elif referenced_files:
        results.append(ValidationResult(
            severity="info", category="resources",
            message=f"All {len(referenced_files)} referenced files exist", passed=True
        ))
    return results


def validate_scripts(skill_path: Path) -> List[ValidationResult]:
    """Validate scripts have shebangs and are properly formatted"""
    results = []
    scripts_dir = skill_path / 'scripts'
    if not scripts_dir.exists():
        return results

    scripts = list(scripts_dir.glob('*.py')) + list(scripts_dir.glob('*.sh'))
    if not scripts:
        return results

    issues = []
    for script in scripts:
        content = script.read_text(encoding='utf-8', errors='replace')
        if not content.startswith('#!'):
            issues.append(f"{script.name}: Missing shebang")
        if os.name != 'nt' and not os.access(script, os.X_OK):
            issues.append(f"{script.name}: Not executable")

    if issues:
        results.append(ValidationResult(
            severity="warning", category="resources",
            message=f"Script issues: {'; '.join(issues)}", passed=False
        ))
    else:
        results.append(ValidationResult(
            severity="info", category="resources",
            message=f"All {len(scripts)} scripts validated", passed=True
        ))
    return results


def check_examples_present(content: str) -> List[ValidationResult]:
    """Check if skill includes examples"""
    results = []
    has_examples = bool(re.search(r'##\s*Examples?', content, re.IGNORECASE))
    has_example_entries = bool(re.search(r'\*\*Example \d+:', content))

    if not has_examples and not has_example_entries:
        results.append(ValidationResult(
            severity="warning", category="content",
            message="No examples section found - examples improve skill usability",
            passed=False
        ))
    else:
        results.append(ValidationResult(
            severity="info", category="content",
            message="Examples section present", passed=True
        ))
    return results


def validate_skill(skill_path, target: str = DEFAULT_TARGET) -> Tuple[bool, str]:
    """
    Comprehensive validation of a skill.

    Returns:
        (is_valid, message) tuple
    """
    skill_path = Path(skill_path)
    all_results = []

    all_results.extend(validate_basic_structure(skill_path))

    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text(encoding='utf-8', errors='replace')

    all_results.extend(validate_frontmatter(content, target))
    all_results.extend(check_todo_markers(content))
    all_results.extend(check_word_count(content))
    all_results.extend(validate_file_paths(skill_path, content))
    all_results.extend(validate_scripts(skill_path))
    all_results.extend(check_examples_present(content))

    errors = [r for r in all_results if r.severity == "error" and not r.passed]
    warnings = [r for r in all_results if r.severity == "warning" and not r.passed]
    passed = [r for r in all_results if r.passed]

    report_lines = []
    report_lines.append("\nValidation Report:")
    report_lines.append(f"  {len(passed)} checks passed")

    if warnings:
        report_lines.append(f"  {len(warnings)} warnings:")
        for w in warnings:
            report_lines.append(f"     - {w.message}")

    if errors:
        report_lines.append(f"  {len(errors)} errors:")
        for e in errors:
            report_lines.append(f"     - {e.message}")
        report_lines.append("\n  Fix errors before packaging")

    report = "\n".join(report_lines)

    is_valid = len(errors) == 0
    if is_valid:
        return True, "Skill validation passed!" + report
    else:
        return False, "Skill has validation errors" + report


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
        print("  --target claude-code  (default) the frontmatter keys Claude Code reads")
        print("  --target upload       the six keys claude.ai upload and the Skills API accept")
        print("\nValidates skill against quality checklist:")
        print("  - Metadata (name, description, allowed properties)")
        print("  - Content (TODO markers, word count, examples)")
        print("  - Resources (file paths, script validation)")
        sys.exit(1)

    valid, message = validate_skill(parsed[0], parsed[1])
    print(message)
    sys.exit(0 if valid else 1)
