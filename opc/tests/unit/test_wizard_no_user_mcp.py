"""Playwright setup must not register servers in ~/.mcp.json.

Servers are added at install with `claude mcp add-json --scope user`.
The wizard does not prompt for issue-tracker or error-monitor tokens,
and it does not write those tokens into .env.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

opc_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(opc_root))


def test_wizard_source_names_neither_tracker():
    text = (opc_root / "scripts" / "setup" / "wizard.py").read_text().lower()
    assert "linear" not in text
    assert "sentry" not in text


@pytest.mark.asyncio
async def test_devops_prompt_does_not_write_user_mcp_json(tmp_path):
    npm = MagicMock(returncode=0, stderr="")
    with patch("scripts.setup.wizard.Path.home", return_value=tmp_path), \
         patch("scripts.setup.wizard.subprocess.run", return_value=npm) as run:
        from scripts.setup.wizard import prompt_devops_integration
        result = await prompt_devops_integration()

    assert result == {}
    assert not (tmp_path / ".mcp.json").exists()
    assert run.call_count == 1
    argv = run.call_args.args[0]
    joined = " ".join(str(part) for part in argv)
    assert "@playwright/cli" in joined
    assert "linearis" not in joined
    assert "@sentry/cli" not in joined
