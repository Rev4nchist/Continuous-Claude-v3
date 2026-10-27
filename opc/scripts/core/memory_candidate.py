"""Schema for a memory candidate, checked before it reaches the store.

One list of learning types lives here. store_learning.py imports it.
This module imports nothing from store_learning.py, so there is no import cycle.

``validate_candidate`` returns ``(candidate, [])`` or ``(None, reasons)``.
A reason has the shape ``schema:<field>:<pydantic error type>``, for example
``schema:source:literal_error``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError

LearningType = Literal[
    "FAILED_APPROACH",
    "WORKING_SOLUTION",
    "USER_PREFERENCE",
    "CODEBASE_PATTERN",
    "ARCHITECTURAL_DECISION",
    "ERROR_FIX",
    "OPEN_THREAD",
]
LEARNING_TYPES: list[str] = list(get_args(LearningType))

Source = Literal["hook", "manual", "handoff", "llm"]

MAX_CONTENT_CHARS = 4000
MAX_CONTEXT_CHARS = 1000
MAX_TAG_CHARS = 100
MAX_TAGS = 30


class Evidence(BaseModel):
    """Where an extractor row came from in the transcript."""

    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["thinking_block", "tool_error"]
    line: int = Field(ge=0)
    hash: str = Field(pattern=r"^[0-9a-f]{16}$")


class MemoryCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)
    learning_type: LearningType
    source: Source
    is_inference: bool
    session_id: str = Field(min_length=1, max_length=200)
    context: str | None = Field(default=None, max_length=MAX_CONTEXT_CHARS)
    tags: list[Annotated[str, Field(max_length=MAX_TAG_CHARS)]] = Field(
        default_factory=list, max_length=MAX_TAGS
    )
    confidence: Literal["high", "medium", "low"] | None = None
    evidence: Evidence | None = None


def validate_candidate(data: dict[str, Any]) -> tuple[MemoryCandidate | None, list[str]]:
    """Validate one candidate. Content is stripped before the length check."""
    data = dict(data)
    if isinstance(data.get("content"), str):
        data["content"] = data["content"].strip()
    try:
        return MemoryCandidate.model_validate(data), []
    except ValidationError as exc:
        reasons = [
            "schema:" + ".".join(str(p) for p in err["loc"]) + ":" + err["type"]
            for err in exc.errors()
        ]
        return None, reasons


def clip_fields(
    content: str, context: str | None, tags: list[str] | None
) -> tuple[str, str | None, list[str] | None]:
    """Cut text to the schema caps so a long CLI or hook write is kept, not rejected.

    The caps guard against runaway extractor output. A caller that passes a long
    prompt or error text (agent-error-capture does) was stored before the schema existed.
    """
    clipped_tags = [t[:MAX_TAG_CHARS] for t in tags[:MAX_TAGS]] if tags else tags
    clipped_context = context[:MAX_CONTEXT_CHARS] if isinstance(context, str) else context
    return content[:MAX_CONTENT_CHARS], clipped_context, clipped_tags
