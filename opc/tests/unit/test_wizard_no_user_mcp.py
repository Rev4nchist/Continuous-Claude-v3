"""DevOps setup may collect Linear and Sentry tokens for the env file.

It must not register those servers in ~/.mcp.json. Servers are added at
install with `claude mcp add-json --scope user`.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

opc_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(opc_root))


@pytest.mark.asyncio
async def test_devops_prompt_does_not_write_user_mcp_json(tmp_path):
    confirms = iter([True, True])
    prompts = iter(["lin-token", "workspace", "sen-token", "org"])
    npm = MagicMock(returncode=0, stderr="")
    with patch("scripts.setup.wizard.Path.home", return_value=tmp_path), \
         patch("scripts.setup.wizard.Confirm.ask", side_effect=lambda *_a, **_k: next(confirms)), \
         patch("scripts.setup.wizard.Prompt.ask", side_effect=lambda *_a, **_k: next(prompts)), \
         patch("scripts.setup.wizard.subprocess.run", return_value=npm):
        from scripts.setup.wizard import prompt_devops_integration
        result = await prompt_devops_integration()

    assert result["linear_api_token"] == "lin-token"
    assert result["sentry_auth_token"] == "sen-token"
    assert not (tmp_path / ".mcp.json").exists()
