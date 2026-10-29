#!/usr/bin/env python3
"""Skill Router API - Deterministic skill/agent routing for workflow orchestration.

Provides JSON in/out interface for:
- Matching skills based on keywords and intent patterns
- Matching agents based on task type
- Calculating complexity scores
- Recommending orchestration patterns

USAGE:
    # CLI mode - JSON in, JSON out
    echo '{"task": "debug intermittent auth errors", "context": "production", "files": []}' | \
        uv run python scripts/core/core/skill_router.py

    # Direct invocation
    uv run python scripts/core/core/skill_router.py --task "implement new feature" --context "greenfield"

    # With file analysis
    uv run python scripts/core/core/skill_router.py --task "fix bug" --files src/auth.ts src/api.ts

API:
    Input (JSON):
        {
            "task": "string - description of sub-task",
            "context": "string - relevant background",
            "files": ["array of file paths"],
            "current_pattern": "optional - pattern already selected",
            "exclude_agents": ["optional - agents to skip"],
            "cwd": "optional - working directory"
        }

    Output (JSON):
        {
            "skills": [...],
            "agents": [...],
            "complexity_score": 0.72,
            "recommended_pattern": "hierarchical",
            "llm_assisted": false,
            "greenfield_score": 0.0,
            "suggest_ralph": false
        }
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# =============================================================================
# Configuration Constants
# =============================================================================

# Complexity score weights (prompt-level)
PROMPT_WEIGHTS = {
    "multiple_files": 0.2,
    "task_conjunctions": 0.15,  # per conjunction
    "uncertainty_markers": 0.1,
    "architecture_keywords": 0.3,
    "debug_intermittent": 0.25,
    "new_project_intent": 0.35,
}

# Complexity score weights (file-level)
FILE_WEIGHTS = {
    "imports_over_10": 0.15,
    "cross_module": 0.2,
    "test_files": 0.1,
    "config_files": 0.15,
}

# Complexity thresholds
COMPLEXITY_THRESHOLD_SUGGEST = 0.5
COMPLEXITY_THRESHOLD_FORCE = 0.7

# Pattern-to-agent mapping
PATTERN_AGENT_MAP = {
    "swarm": "research-agent",
    "hierarchical": "kraken",
    "pipeline": "kraken",
    "generator_critic": "review-agent",
    "adversarial": "validate-agent",
    "map_reduce": "kraken",
    "jury": "validate-agent",
    "event_driven": "kraken",
    "circuit_breaker": "kraken",
}

# Agent type mapping
AGENT_TYPES = {
    "scout": "exploration",
    "oracle": "research",
    "architect": "planning",
    "phoenix": "refactoring",
    "kraken": "implementation",
    "spark": "quick-fix",
    "arbiter": "testing",
    "atlas": "e2e-testing",
    "critic": "review",
    "judge": "review",
    "surveyor": "review",
    "liaison": "integration",
    "sleuth": "debugging",
    "debug-agent": "debugging",
    "aegis": "security",
    "profiler": "performance",
    "herald": "release",
    "scribe": "documentation",
}


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class PromptSignal:
    name: str
    weight: float
    detected: bool
    detail: str = ""


@dataclass
class FileSignal:
    name: str
    weight: float
    file_path: str = ""
    value: int = 0


@dataclass
class SkillMatch:
    name: str
    enforcement: str
    priority: str
    confidence: float
    reason: str
    match_type: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "enforcement": self.enforcement,
            "priority": self.priority,
            "confidence": self.confidence,
            "reason": self.reason,
            "match_type": self.match_type,
        }


@dataclass
class AgentMatch:
    name: str
    type: str
    confidence: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "confidence": self.confidence,
            "reason": self.reason,
        }


@dataclass
class ComplexityScore:
    total: float
    prompt_score: float
    file_score: float
    prompt_signals: list[PromptSignal] = field(default_factory=list)
    file_signals: list[FileSignal] = field(default_factory=list)
    action: str = "proceed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": round(self.total, 3),
            "prompt_score": round(self.prompt_score, 3),
            "file_score": round(self.file_score, 3),
            "prompt_signals": [
                {"name": s.name, "weight": s.weight, "detected": s.detected, "detail": s.detail}
                for s in self.prompt_signals
            ],
            "file_signals": [
                {"name": s.name, "weight": s.weight, "file_path": s.file_path, "value": s.value}
                for s in self.file_signals
            ],
            "action": self.action,
        }


@dataclass
class RouterOutput:
    skills: list[SkillMatch] = field(default_factory=list)
    agents: list[AgentMatch] = field(default_factory=list)
    complexity_score: float = 0.0
    recommended_pattern: str | None = None
    llm_assisted: bool = False
    greenfield_score: float = 0.0
    suggest_ralph: bool = False
    complexity_breakdown: ComplexityScore | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "skills": [s.to_dict() for s in self.skills],
            "agents": [a.to_dict() for a in self.agents],
            "complexity_score": round(self.complexity_score, 3),
            "recommended_pattern": self.recommended_pattern,
            "llm_assisted": self.llm_assisted,
            "greenfield_score": round(self.greenfield_score, 3),
            "suggest_ralph": self.suggest_ralph,
        }


# =============================================================================
# Skill Rules Loading
# =============================================================================

def load_skill_rules() -> dict[str, Any]:
    """Load skill-rules.json from global .claude folder."""
    home = Path.home()
    rules_path = home / ".claude" / "skills" / "skill-rules.json"

    if not rules_path.exists():
        return {"skills": {}, "agents": {}}

    with open(rules_path, encoding="utf-8") as f:
        return json.load(f)


# =============================================================================
# Complexity Scoring
# =============================================================================

def extract_prompt_signals(task: str, context: str = "") -> list[PromptSignal]:
    """Extract complexity signals from task description."""
    signals = []
    combined = f"{task} {context}".lower()

    # Multiple files mentioned
    file_patterns = r"(?:[\w/\\]+\.\w{2,4})"
    files_found = re.findall(file_patterns, combined)
    signals.append(PromptSignal(
        name="multiple_files",
        weight=PROMPT_WEIGHTS["multiple_files"] if len(files_found) > 1 else 0.0,
        detected=len(files_found) > 1,
        detail=f"Found {len(files_found)} file references" if len(files_found) > 1 else "",
    ))

    # Task conjunctions
    conjunctions = ["and also", "and then", "then also", ", and ", " also "]
    conjunction_count = sum(1 for c in conjunctions if c in combined)
    signals.append(PromptSignal(
        name="task_conjunctions",
        weight=min(PROMPT_WEIGHTS["task_conjunctions"] * conjunction_count, 0.45),
        detected=conjunction_count > 0,
        detail=f"Found {conjunction_count} task conjunctions" if conjunction_count > 0 else "",
    ))

    # Uncertainty markers
    uncertainty = ["how", "should i", "what's the best way", "which approach", "is it better"]
    has_uncertainty = any(u in combined for u in uncertainty)
    signals.append(PromptSignal(
        name="uncertainty_markers",
        weight=PROMPT_WEIGHTS["uncertainty_markers"] if has_uncertainty else 0.0,
        detected=has_uncertainty,
        detail="Question/uncertainty detected" if has_uncertainty else "",
    ))

    # Architecture keywords
    arch_keywords = ["refactor", "migrate", "redesign", "restructure", "architect", "overhaul"]
    arch_found = [k for k in arch_keywords if k in combined]
    signals.append(PromptSignal(
        name="architecture_keywords",
        weight=PROMPT_WEIGHTS["architecture_keywords"] if arch_found else 0.0,
        detected=len(arch_found) > 0,
        detail=f"Architecture keywords: {', '.join(arch_found)}" if arch_found else "",
    ))

    # Debug + intermittent pattern
    debug_keywords = ["debug", "fix", "bug", "error", "issue"]
    intermittent = ["intermittent", "sometimes", "random", "sporadic", "occasional", "flaky"]
    has_debug = any(d in combined for d in debug_keywords)
    has_intermittent = any(i in combined for i in intermittent)
    signals.append(PromptSignal(
        name="debug_intermittent",
        weight=PROMPT_WEIGHTS["debug_intermittent"] if (has_debug and has_intermittent) else 0.0,
        detected=has_debug and has_intermittent,
        detail="Debug + intermittent pattern detected" if (has_debug and has_intermittent) else "",
    ))

    # New project intent
    new_keywords = ["build", "create", "new", "implement", "add feature", "develop"]
    scratch_keywords = ["from scratch", "new project", "new app", "new feature", "greenfield"]
    has_new = any(n in combined for n in new_keywords)
    has_scratch = any(s in combined for s in scratch_keywords)
    signals.append(PromptSignal(
        name="new_project_intent",
        weight=PROMPT_WEIGHTS["new_project_intent"] if (has_new and has_scratch) else 0.0,
        detected=has_new and has_scratch,
        detail="New project/feature intent detected" if (has_new and has_scratch) else "",
    ))

    return signals


def extract_file_signals(files: list[str], cwd: str = "") -> list[FileSignal]:
    """Extract complexity signals from file analysis."""
    signals = []

    if not files:
        return signals

    # Cross-module changes
    dirs = set()
    for f in files:
        path = Path(f)
        if path.parent.name:
            dirs.add(str(path.parent))
    cross_module = len(dirs) > 1
    signals.append(FileSignal(
        name="cross_module",
        weight=FILE_WEIGHTS["cross_module"] if cross_module else 0.0,
        value=len(dirs),
    ))

    # Test files
    test_patterns = [".test.", ".spec.", "_test.", "_spec.", "test_", "tests/"]
    test_files = [f for f in files if any(p in f.lower() for p in test_patterns)]
    signals.append(FileSignal(
        name="test_files",
        weight=FILE_WEIGHTS["test_files"] if test_files else 0.0,
        value=len(test_files),
    ))

    # Config files
    config_patterns = ["package.json", "tsconfig", "pyproject.toml", "setup.py", ".env", "config"]
    config_files = [f for f in files if any(p in f.lower() for p in config_patterns)]
    signals.append(FileSignal(
        name="config_files",
        weight=FILE_WEIGHTS["config_files"] if config_files else 0.0,
        value=len(config_files),
    ))

    # Import analysis (would require file reading - simplified here)
    # In full implementation, read files and count imports
    signals.append(FileSignal(
        name="imports_over_10",
        weight=0.0,  # Would be set after actual file analysis
        value=0,
    ))

    return signals


def calculate_complexity(task: str, context: str, files: list[str], cwd: str = "") -> ComplexityScore:
    """Calculate total complexity score from signals."""
    prompt_signals = extract_prompt_signals(task, context)
    file_signals = extract_file_signals(files, cwd)

    prompt_score = sum(s.weight for s in prompt_signals if s.detected)
    file_score = sum(s.weight for s in file_signals if s.weight > 0)
    total = min(prompt_score + file_score, 1.0)  # Cap at 1.0

    # Determine action
    if total >= COMPLEXITY_THRESHOLD_FORCE:
        action = "force_workflow"
    elif total >= COMPLEXITY_THRESHOLD_SUGGEST:
        action = "suggest_workflow"
    else:
        action = "proceed"

    return ComplexityScore(
        total=total,
        prompt_score=prompt_score,
        file_score=file_score,
        prompt_signals=prompt_signals,
        file_signals=file_signals,
        action=action,
    )


# =============================================================================
# Greenfield Detection
# =============================================================================

def calculate_greenfield_score(task: str, context: str, cwd: str = "") -> float:
    """Calculate greenfield project detection score."""
    score = 0.0
    combined = f"{task} {context}".lower()

    # Check prompt signals
    new_keywords = ["build", "create", "new", "implement", "start", "init"]
    if any(k in combined for k in new_keywords):
        score += 0.15

    scratch_keywords = ["from scratch", "new project", "greenfield", "new app"]
    if any(k in combined for k in scratch_keywords):
        score += 0.2

    # Check folder state (simplified - full impl would check actual directory)
    if cwd:
        cwd_path = Path(cwd)
        if cwd_path.exists():
            # No .git
            if not (cwd_path / ".git").exists():
                score += 0.1
            # No package.json or pyproject.toml
            if not (cwd_path / "package.json").exists() and not (cwd_path / "pyproject.toml").exists():
                score += 0.1
            # Few files
            file_count = sum(1 for _ in cwd_path.iterdir() if _.is_file())
            if file_count < 5:
                score += 0.1

    return min(score, 1.0)


# =============================================================================
# Skill Matching
# =============================================================================

def match_skills(task: str, context: str, rules: dict[str, Any]) -> list[SkillMatch]:
    """Match task against skill rules."""
    matches = []
    combined = f"{task} {context}".lower()

    skills = rules.get("skills", {})
    for skill_name, config in skills.items():
        triggers = config.get("promptTriggers", {})
        if not triggers:
            continue

        # Keyword matching
        keywords = triggers.get("keywords", [])
        matched_keyword = None
        for kw in keywords:
            if kw.lower() in combined:
                matched_keyword = kw
                break

        # Intent pattern matching
        intent_patterns = triggers.get("intentPatterns", [])
        matched_intent = False
        for pattern in intent_patterns:
            try:
                if re.search(pattern, combined, re.IGNORECASE):
                    matched_intent = True
                    break
            except re.error:
                continue

        if matched_keyword or matched_intent:
            match_type = "intent" if matched_intent else "keyword"
            confidence = 0.9 if matched_intent else 0.75

            matches.append(SkillMatch(
                name=skill_name,
                enforcement=config.get("enforcement", "suggest"),
                priority=config.get("priority", "medium"),
                confidence=confidence,
                reason=f"{'Intent pattern' if matched_intent else 'Keyword'} match: {matched_keyword or 'pattern'}",
                match_type=match_type,
            ))

    # Sort by priority and confidence
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    matches.sort(key=lambda m: (priority_order.get(m.priority, 4), -m.confidence))

    return matches


def match_agents(task: str, context: str, rules: dict[str, Any], exclude: list[str] = None) -> list[AgentMatch]:
    """Match task against agent rules."""
    matches = []
    combined = f"{task} {context}".lower()
    exclude = exclude or []

    agents = rules.get("agents", {})
    for agent_name, config in agents.items():
        if agent_name in exclude:
            continue

        triggers = config.get("promptTriggers", {})
        if not triggers:
            continue

        # Keyword matching
        keywords = triggers.get("keywords", [])
        matched_keyword = None
        for kw in keywords:
            if kw.lower() in combined:
                matched_keyword = kw
                break

        # Intent pattern matching
        intent_patterns = triggers.get("intentPatterns", [])
        matched_intent = False
        for pattern in intent_patterns:
            try:
                if re.search(pattern, combined, re.IGNORECASE):
                    matched_intent = True
                    break
            except re.error:
                continue

        if matched_keyword or matched_intent:
            confidence = 0.85 if matched_intent else 0.7

            matches.append(AgentMatch(
                name=agent_name,
                type=AGENT_TYPES.get(agent_name, config.get("type", "general")),
                confidence=confidence,
                reason=f"{'Intent pattern' if matched_intent else 'Keyword'} match",
            ))

    # Sort by confidence
    matches.sort(key=lambda m: -m.confidence)

    return matches


# =============================================================================
# Pattern Recommendation
# =============================================================================

def recommend_pattern(task: str, context: str, skills: list[SkillMatch], complexity: float) -> str | None:
    """Recommend orchestration pattern based on task analysis."""
    combined = f"{task} {context}".lower()

    # Research patterns
    if any(k in combined for k in ["research", "find", "explore", "understand", "analyze"]):
        if any(k in combined for k in ["multiple", "compare", "different"]):
            return "swarm"
        return "hierarchical"

    # Implementation patterns
    if any(k in combined for k in ["implement", "build", "create", "add"]):
        if complexity >= 0.7:
            return "pipeline"
        return "hierarchical"

    # Debug patterns
    if any(k in combined for k in ["debug", "fix", "investigate", "root cause"]):
        return "hierarchical"

    # Review patterns
    if any(k in combined for k in ["review", "validate", "check", "audit"]):
        if "critical" in combined or "security" in combined:
            return "jury"
        return "generator_critic"

    # Refactoring patterns
    if any(k in combined for k in ["refactor", "migrate", "upgrade"]):
        return "pipeline"

    # Default based on complexity
    if complexity >= 0.7:
        return "hierarchical"

    return None


# =============================================================================
# Main Router Function
# =============================================================================

def route(
    task: str,
    context: str = "",
    files: list[str] = None,
    current_pattern: str = None,
    exclude_agents: list[str] = None,
    cwd: str = "",
) -> RouterOutput:
    """Main routing function - returns skills, agents, and complexity score."""
    files = files or []
    exclude_agents = exclude_agents or []

    # Load rules
    rules = load_skill_rules()

    # Calculate complexity
    complexity = calculate_complexity(task, context, files, cwd)

    # Calculate greenfield score
    greenfield = calculate_greenfield_score(task, context, cwd)

    # Match skills
    skills = match_skills(task, context, rules)

    # Match agents
    agents = match_agents(task, context, rules, exclude_agents)

    # Recommend pattern
    pattern = current_pattern or recommend_pattern(task, context, skills, complexity.total)

    # Suggest Ralph for greenfield
    suggest_ralph = greenfield > 0.4

    return RouterOutput(
        skills=skills,
        agents=agents,
        complexity_score=complexity.total,
        recommended_pattern=pattern,
        llm_assisted=False,  # Would be True if LLM disambiguation was used
        greenfield_score=greenfield,
        suggest_ralph=suggest_ralph,
        complexity_breakdown=complexity,
    )


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """CLI entry point - reads JSON from stdin or args."""
    parser = argparse.ArgumentParser(description="Skill Router API")
    parser.add_argument("--task", type=str, help="Task description")
    parser.add_argument("--context", type=str, default="", help="Context")
    parser.add_argument("--files", nargs="*", default=[], help="Files involved")
    parser.add_argument("--cwd", type=str, default="", help="Working directory")
    parser.add_argument("--pattern", type=str, help="Current pattern")
    parser.add_argument("--exclude", nargs="*", default=[], help="Agents to exclude")
    parser.add_argument("--verbose", action="store_true", help="Include complexity breakdown")

    args = parser.parse_args()

    # Try stdin JSON first
    if not sys.stdin.isatty():
        try:
            input_data = json.load(sys.stdin)
            task = input_data.get("task", "")
            context = input_data.get("context", "")
            files = input_data.get("files", [])
            cwd = input_data.get("cwd", "")
            pattern = input_data.get("current_pattern")
            exclude = input_data.get("exclude_agents", [])
        except json.JSONDecodeError:
            print(json.dumps({"error": "Invalid JSON input"}))
            sys.exit(1)
    elif args.task:
        task = args.task
        context = args.context
        files = args.files
        cwd = args.cwd
        pattern = args.pattern
        exclude = args.exclude
    else:
        parser.print_help()
        sys.exit(1)

    # Route
    result = route(
        task=task,
        context=context,
        files=files,
        current_pattern=pattern,
        exclude_agents=exclude,
        cwd=cwd,
    )

    # Output
    output = result.to_dict()
    if args.verbose and result.complexity_breakdown:
        output["complexity_breakdown"] = result.complexity_breakdown.to_dict()

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
