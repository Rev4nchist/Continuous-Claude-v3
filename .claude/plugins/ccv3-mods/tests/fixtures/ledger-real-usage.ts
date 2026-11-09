// Real usage records for the Agent Ledger price check (PR C). Token counts only, copied from Claude Code transcripts of 2026-11-08
// (deduped by message.id, first record wins). `expected` was computed apart from price.ts, by the Python exact-id rule of the
// validation (part1.py price(), copied to .claude/cache/e2e/2026-11-09-price-wire-reconcile-scripts/): advisor iterations at the iteration's own model, remainder at 5m.
// runA: a whole subagent file (Sonnet 5.5 steps, Fable 5.1 advisor iterations). runB: main-loop records with 1-hour cache writes.

export type RealStep = { model: string; effort: string | null; usage: Record<string, unknown> & { input_tokens: number; output_tokens: number } }
export type RealRun = { source: string; steps: RealStep[] }
export type RealUsage = {
  note: string
  runA: RealRun
  runB: RealRun
  expected: Record<'runA' | 'runB' | 'runAB', { usd: number; advisorUsd: number }>
  expectedBy: string
}

export const REAL_USAGE: RealUsage = {
  "note": "Deduped usage records (token counts only) copied from real Claude Code transcripts. runA = a whole subagent file; runB = main-loop records with 1-hour cache writes.",
  "runA": {
    "source": "f13b4159-32a4-4dfe-b2aa-e1fc3b1a2025\\subagents\\workflows\\wf_f12a2d38-efc\\agent-a51239235457b2185.jsonl",
    "steps": [
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 303,
          "cache_read_input_tokens": 0,
          "cache_creation_input_tokens": 24276,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 24276,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 303,
              "cache_read_input_tokens": 0,
              "cache_creation_input_tokens": 24276
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 4,
          "output_tokens": 40465,
          "cache_read_input_tokens": 24276,
          "cache_creation_input_tokens": 68105,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 6160,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 29336,
              "cache_read_input_tokens": 24276,
              "cache_creation_input_tokens": 6160
            },
            {
              "type": "advisor_message",
              "model": "claude-fable-5-1",
              "input_tokens": 32002,
              "output_tokens": 7881,
              "cache_read_input_tokens": 0,
              "cache_creation_input_tokens": 0
            },
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 11129,
              "cache_read_input_tokens": 0,
              "cache_creation_input_tokens": 61945
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 1772,
          "cache_read_input_tokens": 61945,
          "cache_creation_input_tokens": 11212,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 11212,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 1772,
              "cache_read_input_tokens": 61945,
              "cache_creation_input_tokens": 11212
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 299,
          "cache_read_input_tokens": 73157,
          "cache_creation_input_tokens": 3392,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 3392,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 299,
              "cache_read_input_tokens": 73157,
              "cache_creation_input_tokens": 3392
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 3974,
          "cache_read_input_tokens": 76549,
          "cache_creation_input_tokens": 710,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 710,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 3974,
              "cache_read_input_tokens": 76549,
              "cache_creation_input_tokens": 710
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 129,
          "cache_read_input_tokens": 77259,
          "cache_creation_input_tokens": 4204,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 4204,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 129,
              "cache_read_input_tokens": 77259,
              "cache_creation_input_tokens": 4204
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 629,
          "cache_read_input_tokens": 81463,
          "cache_creation_input_tokens": 551,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 551,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 629,
              "cache_read_input_tokens": 81463,
              "cache_creation_input_tokens": 551
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 135,
          "cache_read_input_tokens": 82014,
          "cache_creation_input_tokens": 860,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 860,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 135,
              "cache_read_input_tokens": 82014,
              "cache_creation_input_tokens": 860
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 746,
          "cache_read_input_tokens": 82874,
          "cache_creation_input_tokens": 371,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 371,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 746,
              "cache_read_input_tokens": 82874,
              "cache_creation_input_tokens": 371
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 764,
          "cache_read_input_tokens": 83245,
          "cache_creation_input_tokens": 1032,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 1032,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 764,
              "cache_read_input_tokens": 83245,
              "cache_creation_input_tokens": 1032
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 4,
          "output_tokens": 273,
          "cache_read_input_tokens": 169552,
          "cache_creation_input_tokens": 2165,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 998,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 152,
              "cache_read_input_tokens": 84277,
              "cache_creation_input_tokens": 998
            },
            {
              "type": "advisor_message",
              "model": "claude-fable-5-1",
              "input_tokens": 55694,
              "output_tokens": 5207,
              "cache_read_input_tokens": 0,
              "cache_creation_input_tokens": 0
            },
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 121,
              "cache_read_input_tokens": 85275,
              "cache_creation_input_tokens": 1167
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "high",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 3057,
          "cache_read_input_tokens": 86442,
          "cache_creation_input_tokens": 138,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 138,
            "ephemeral_1h_input_tokens": 0
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 3057,
              "cache_read_input_tokens": 86442,
              "cache_creation_input_tokens": 138
            }
          ]
        }
      }
    ]
  },
  "runB": {
    "source": "b32775bc-57cc-474a-a28f-340b2a48bc6d.jsonl",
    "steps": [
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 216,
          "cache_read_input_tokens": 36106,
          "cache_creation_input_tokens": 55201,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 55201
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 216,
              "cache_read_input_tokens": 36106,
              "cache_creation_input_tokens": 55201
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 4,
          "output_tokens": 330,
          "cache_read_input_tokens": 91307,
          "cache_creation_input_tokens": 4881,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 4881
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 4,
              "output_tokens": 330,
              "cache_read_input_tokens": 91307,
              "cache_creation_input_tokens": 4881
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 1,
          "output_tokens": 280,
          "cache_read_input_tokens": 96188,
          "cache_creation_input_tokens": 10480,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 10480
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 1,
              "output_tokens": 280,
              "cache_read_input_tokens": 96188,
              "cache_creation_input_tokens": 10480
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 91,
          "cache_read_input_tokens": 106668,
          "cache_creation_input_tokens": 3749,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 3749
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 91,
              "cache_read_input_tokens": 106668,
              "cache_creation_input_tokens": 3749
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 683,
          "cache_read_input_tokens": 110417,
          "cache_creation_input_tokens": 5827,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 5827
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 683,
              "cache_read_input_tokens": 110417,
              "cache_creation_input_tokens": 5827
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 287,
          "cache_read_input_tokens": 116244,
          "cache_creation_input_tokens": 1140,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 1140
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 287,
              "cache_read_input_tokens": 116244,
              "cache_creation_input_tokens": 1140
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 146,
          "cache_read_input_tokens": 117384,
          "cache_creation_input_tokens": 309,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 309
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 146,
              "cache_read_input_tokens": 117384,
              "cache_creation_input_tokens": 309
            }
          ]
        }
      },
      {
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "usage": {
          "input_tokens": 2,
          "output_tokens": 312,
          "cache_read_input_tokens": 117693,
          "cache_creation_input_tokens": 1001,
          "cache_creation": {
            "ephemeral_5m_input_tokens": 0,
            "ephemeral_1h_input_tokens": 1001
          },
          "server_tool_use": {
            "web_search_requests": 0
          },
          "speed": "standard",
          "inference_geo": "global",
          "iterations": [
            {
              "type": "message",
              "input_tokens": 2,
              "output_tokens": 312,
              "cache_read_input_tokens": 117693,
              "cache_creation_input_tokens": 1001
            }
          ]
        }
      }
    ]
  },
  "expected": {
    "runA": {
      "usd": 2.4392936,
      "advisorUsd": 1.5313599999999998
    },
    "runB": {
      "usd": 0.4330367,
      "advisorUsd": 0.0
    },
    "runAB": {
      "usd": 2.8723303,
      "advisorUsd": 1.5313599999999998
    }
  },
  "expectedBy": "part1.py price() (copy in .claude/cache/e2e/2026-11-09-price-wire-reconcile-scripts) (exact-id rates typed by hand); advisor at the iteration model, cache 0; remainder at 5m; no code shared with price.ts"
}
