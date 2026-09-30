"""Production wrapper around rlms (alexzhang13/rlm).

Enforces:
- Docker sandbox (refuses "local" -- its exec() keeps __import__/open unrestricted)
- max_depth=1 (Wang reproduction: depth>=2 degrades)
- Budget + iteration + timeout caps
- Graceful vanilla-Claude fallback on any RLM failure
- Threshold gate: below min_context_chars, skip RLM entirely
- Dual backend: "claude_cli" (default, routes through Max subscription)
  or "anthropic" (Developer API escape hatch).
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

from rlm import RLM

logger = logging.getLogger(__name__)

Sandbox = Literal["docker", "modal", "e2b", "daytona", "prime"]
Backend = Literal["claude_cli", "anthropic"]


@dataclass(frozen=True)
class RLMPolicy:
    """Production safety envelope for RLM invocations.

    Defaults chosen for Anthropic + Docker on Windows.
    """
    sandbox: Sandbox = "docker"
    docker_image: str = "continuous-claude/rlm-sandbox:3.11"
    max_depth: int = 1                     # Wang et al. 2603.02615 -- never raise
    max_iterations: int = 40
    max_budget_usd: float = 2.00            # silent-no-op on anthropic today; still set
    max_timeout_s: float = 900.0
    max_tokens: int = 1_500_000
    max_response_tokens: int = 4096   # per-iteration Anthropic max_tokens; bounds generation-loop cost (32768 default was 8-min worst case)
    max_concurrent_subcalls: int = 4
    min_context_chars: int = 300_000        # below: fall back to vanilla
    fallback_on_error: bool = True
    # "claude_cli": route all LLM calls through `claude -p` (Max subscription, no Developer API).
    # "anthropic": use the Anthropic SDK (Developer API, separately billed).
    backend: Backend = "claude_cli"


@dataclass(frozen=True)
class RLMResult:
    answer: str
    path: Literal["rlm", "vanilla-threshold", "vanilla-fallback"]
    trajectory_path: Path | None = None
    usage: dict[str, Any] = field(default_factory=dict)


def _assert_safe(policy: RLMPolicy) -> None:
    if policy.sandbox == "local":  # type: ignore[comparison-overlap]
        raise ValueError(
            "RLMPolicy refuses sandbox='local'. The rlms default exec() "
            "keeps __import__ and open unrestricted -- effectively "
            "RCE-by-LLM. Use 'docker' (installed) or 'modal'/'e2b'."
        )


def rlm_complete(
    question: str,
    context: str,
    *,
    policy: RLMPolicy | None = None,
    model: str = "claude-sonnet-4-6",
    api_key: str | None = None,
    on_trajectory: Callable[[dict[str, Any]], None] | None = None,
    trajectory_dir: Path | None = None,
) -> RLMResult:
    """Run an RLM query.

    Args:
      question: Short user question. Stays in root-model context.
      context: The long data blob. Lives in the REPL's `context` variable --
               never stuffed into the root prompt.
      policy: Safety envelope. Required sandbox, budget, depth caps.
      model: Anthropic model ID.
      api_key: falls back to env ANTHROPIC_API_KEY.
      on_trajectory: callback per iteration for live observability
                     (e.g. write to a local log).
      trajectory_dir: where to persist JSONL trajectory.

    Returns:
      RLMResult with answer + which path was taken + usage info.
    """
    policy = policy or RLMPolicy()
    _assert_safe(policy)

    # Auto-scale for large corpora: >1M char inputs need proportionally more headroom
    effective_max_tokens = policy.max_tokens
    effective_timeout = policy.max_timeout_s
    effective_iterations = policy.max_iterations
    if len(context) > 1_000_000:
        # Scale token budget by corpus size, cap at 3M tokens
        scale = min(len(context) / 1_000_000, 3.0)
        if policy.max_tokens == 1_500_000:  # only auto-scale if default
            effective_max_tokens = int(1_500_000 * scale)
        if policy.max_timeout_s == 900.0:
            effective_timeout = min(1200.0, 900.0 * (scale / 2 + 0.5))
        if policy.max_iterations == 40:
            effective_iterations = min(80, int(40 * (scale / 2 + 0.5)))

    # API key is only required for the Anthropic SDK backend.
    # The claude_cli backend uses the local Max session instead.
    if policy.backend == "anthropic":
        api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
    else:
        # Not used on the claude_cli path, but keep the variable defined for downstream fns.
        api_key = api_key or os.environ.get("ANTHROPIC_API_KEY") or ""

    # Threshold guard: below min_context_chars, RLM is overhead for no gain.
    if len(context) < policy.min_context_chars:
        logger.info(
            "rlm_complete: context=%d < threshold=%d -- using vanilla (%s)",
            len(context), policy.min_context_chars, policy.backend,
        )
        return RLMResult(
            answer=_vanilla_claude(
                question, context, model=model, api_key=api_key, backend=policy.backend
            ),
            path="vanilla-threshold",
        )

    # Wire callbacks
    def _on_iter(**kw: Any) -> None:
        if on_trajectory:
            on_trajectory({"event": "iteration", **kw})

    def _on_sub(**kw: Any) -> None:
        if on_trajectory:
            on_trajectory({"event": "subcall", **kw})

    # Build the agent
    env_kwargs: dict[str, Any] = {}
    if policy.sandbox == "docker":
        env_kwargs = {"image": policy.docker_image}

    rlm_logger = _make_logger(trajectory_dir) if trajectory_dir else None
    traj_path = Path(rlm_logger.log_dir) if rlm_logger else None

    # Backend-specific kwargs. For claude_cli we omit api_key (unused) and max_tokens
    # (claude -p has no --max-tokens flag; kept for signature compatibility only).
    if policy.backend == "claude_cli":
        rlm_backend_name = "claude_cli"
        rlm_backend_kwargs = {
            "model_name": model,
            "max_tokens": policy.max_response_tokens,
            "max_budget_usd": policy.max_budget_usd,
        }
    else:
        rlm_backend_name = "anthropic"
        rlm_backend_kwargs = {
            "model_name": model,
            "api_key": api_key,
            "max_tokens": policy.max_response_tokens,
        }

    # rlms 0.1.1 does not accept max_concurrent_subcalls — set on policy but not passed.
    # For claude_cli backend, rlms' ClientBackend literal doesn't include "claude_cli",
    # so we must build RLM under a monkey-patch of rlm.clients.get_client.
    with _maybe_register_claude_cli_backend(policy.backend):
        agent = RLM(
            backend=rlm_backend_name,  # type: ignore[arg-type]
            backend_kwargs=rlm_backend_kwargs,
            environment=policy.sandbox,
            environment_kwargs=env_kwargs,
            max_depth=policy.max_depth,
            max_iterations=effective_iterations,
            max_budget=policy.max_budget_usd,
            max_timeout=effective_timeout,
            max_tokens=effective_max_tokens,
            on_iteration_complete=_on_iter,
            on_subcall_complete=_on_sub,
            logger=rlm_logger,
            verbose=False,
        )

        try:
            result = agent.completion(prompt=context, root_prompt=question)
            return RLMResult(
                answer=result.choices[0].message.content,
                path="rlm",
                trajectory_path=traj_path,
                usage=_extract_usage(result),
            )
        except Exception as exc:  # noqa: BLE001 -- we intentionally catch all
            if not policy.fallback_on_error:
                raise
            logger.warning(
                "rlm_complete: RLM failed (%s) -- falling back to vanilla Claude",
                exc, exc_info=True,
            )
            # Safely truncate to fit Claude 1M context
            truncated = context[: min(len(context), 900_000)]
            return RLMResult(
                answer=_vanilla_claude(
                    question, truncated, model=model, api_key=api_key, backend=policy.backend
                ),
                path="vanilla-fallback",
            )


def _vanilla_claude(
    question: str, context: str, *, model: str, api_key: str, backend: Backend,
) -> str:
    """Router: pick the vanilla path that matches policy.backend."""
    if backend == "claude_cli":
        return _vanilla_via_cli(question, context, model=model)
    return _vanilla_via_sdk(question, context, model=model, api_key=api_key)


def _vanilla_via_sdk(
    question: str, context: str, *, model: str, api_key: str,
) -> str:
    """Direct Claude call via the Anthropic SDK with prompt-cached context block.

    Used below threshold and as the fallback path when backend='anthropic'.
    Caching the context means repeated calls to the same large doc cost ~10%
    on cache hit. This path hits api.anthropic.com (Developer API billing).
    """
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=4096,
        system=[
            {
                "type": "text",
                "text": "Answer using only the provided <context>.",
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": f"<context>\n{context}\n</context>",
                "cache_control": {"type": "ephemeral"},
            },
        ],
        messages=[{"role": "user", "content": question}],
    )
    return resp.content[0].text


def _vanilla_via_cli(question: str, context: str, *, model: str) -> str:
    """Direct Claude call via `claude -p`. Routes through Max subscription.

    No prompt caching here -- the CLI doesn't expose ephemeral cache_control
    like the SDK does. We rely on Max's internal caching plus the large
    context window of claude-opus/sonnet.
    """
    from scripts.core.rlm_claude_cli_client import ClaudeCliClient

    client = ClaudeCliClient(model_name=model)
    messages = [
        {"role": "system", "content": "Answer using only the provided <context>."},
        {
            "role": "user",
            "content": f"<context>\n{context}\n</context>\n\n{question}",
        },
    ]
    return client.completion(messages)


@contextmanager
def _maybe_register_claude_cli_backend(backend: Backend) -> Iterator[None]:
    """Temporarily register "claude_cli" in rlms' get_client dispatcher.

    rlms' `ClientBackend` Literal doesn't include our custom backend, so we
    monkey-patch `rlm.clients.get_client` for the duration of an RLM session
    and restore the original after. This is the least-invasive way to plug a
    custom LM client into rlms 0.1.1 without forking the package.
    """
    if backend != "claude_cli":
        yield
        return

    import rlm.clients as _rlm_clients  # noqa: WPS433 -- deliberate patch surface

    original = _rlm_clients.get_client

    def _patched(b: str, backend_kwargs: dict[str, Any]):
        if b == "claude_cli":
            from scripts.core.rlm_claude_cli_client import ClaudeCliClient
            return ClaudeCliClient(**backend_kwargs)
        return original(b, backend_kwargs)  # type: ignore[arg-type]

    _rlm_clients.get_client = _patched  # type: ignore[assignment]
    # Also patch in modules that imported get_client by name at import time.
    try:
        import rlm.core.rlm as _rlm_core
        _rlm_core.get_client = _patched  # type: ignore[assignment]
    except Exception:  # noqa: BLE001
        _rlm_core = None  # type: ignore[assignment]
    try:
        import rlm.core.lm_handler as _rlm_lm_handler
        _rlm_lm_handler_original = getattr(_rlm_lm_handler, "get_client", None)
        if _rlm_lm_handler_original is not None:
            _rlm_lm_handler.get_client = _patched  # type: ignore[assignment]
    except Exception:  # noqa: BLE001
        _rlm_lm_handler = None  # type: ignore[assignment]
        _rlm_lm_handler_original = None

    try:
        yield
    finally:
        _rlm_clients.get_client = original  # type: ignore[assignment]
        if _rlm_core is not None:
            _rlm_core.get_client = original  # type: ignore[assignment]
        if _rlm_lm_handler is not None and _rlm_lm_handler_original is not None:
            _rlm_lm_handler.get_client = _rlm_lm_handler_original  # type: ignore[assignment]


def _make_logger(log_dir: Path):
    from rlm.logger import RLMLogger
    log_dir.mkdir(parents=True, exist_ok=True)
    return RLMLogger(log_dir=str(log_dir))


def _extract_usage(result: Any) -> dict[str, Any]:
    """Pull token counts + cost from rlms result. Best-effort across providers."""
    try:
        u = getattr(result, "usage", None) or {}
        return {
            "input_tokens": getattr(u, "input_tokens", None),
            "output_tokens": getattr(u, "output_tokens", None),
            "cost": getattr(u, "total_cost", None),
        }
    except Exception:  # noqa: BLE001
        return {}
