"""Tests for ai_narrator handling of thinking blocks and max_tokens truncation.

No network: a fake `anthropic` module is injected. Run from ai-report-card/:

    python -m unittest scripts.test_ai_narrator -v
"""

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from generators.ai_narrator import NarrativeGenerationError, generate_narratives  # noqa: E402


def _fake_anthropic(content, stop_reason):
    response = SimpleNamespace(
        content=content,
        stop_reason=stop_reason,
        usage=SimpleNamespace(output_tokens=10),
    )
    client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kwargs: response)
    )
    return SimpleNamespace(Anthropic=lambda api_key=None: client)


THINKING = SimpleNamespace(type="thinking", thinking="hmm")
TEXT = SimpleNamespace(type="text", text='{"executive_summary": "x"}')
CONFIG = {"ai": {"model": "claude-sonnet-5-5", "max_tokens": 100}}


def _run(content, stop_reason, strict):
    fake = _fake_anthropic(content, stop_reason)
    with patch.dict(sys.modules, {"anthropic": fake}), patch.dict(
        os.environ, {"ANTHROPIC_API_KEY": "test-not-a-key"}
    ):
        return generate_narratives({}, CONFIG, strict=strict)


class NarratorTest(unittest.TestCase):
    def test_thinking_then_text_parses(self):
        result = _run([THINKING, TEXT], "end_turn", True)
        self.assertTrue(result["ai_generated"])
        self.assertEqual(result["executive_summary"], "x")

    def test_max_tokens_strict_raises(self):
        with self.assertRaises(NarrativeGenerationError) as ctx:
            _run([THINKING], "max_tokens", True)
        self.assertIn("max_tokens", str(ctx.exception))

    def test_max_tokens_non_strict_degrades(self):
        result = _run([THINKING], "max_tokens", False)
        self.assertTrue(result["_degraded"])
        self.assertIn("max_tokens", result["_reason"])
        self.assertIn("max_tokens", result["ai_error"])


if __name__ == "__main__":
    unittest.main()
