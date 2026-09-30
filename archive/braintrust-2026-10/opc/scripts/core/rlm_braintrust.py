"""Braintrust trajectory emitter for RLM calls.

Matches the REST-API pattern used by maestro_session_log.py -- no SDK dep.
"""
from __future__ import annotations

import os
from typing import Any

import aiohttp


async def emit_rlm_trajectory(
    session_id: str,
    event: dict[str, Any],
    *,
    project: str = "continuous-claude",
) -> None:
    api_key = os.environ.get("BRAINTRUST_API_KEY")
    if not api_key:
        return
    payload = {
        "project": project,
        "session_id": session_id,
        "type": f"rlm_{event.get('event', 'unknown')}",
        "data": event,
    }
    async with aiohttp.ClientSession() as s:
        await s.post(
            "https://api.braintrust.dev/v1/proxy/log",
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
            timeout=aiohttp.ClientTimeout(total=5),
        )
