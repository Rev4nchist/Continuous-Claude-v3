# CCv3 harness reference

[Back to the README](../../README.md)

CCv3 is a harness that wraps every Claude Code session. It adds hooks, rules, memory, agents,
guardrails and observability around the model. The model proposes each action. The harness
decides if the action runs, gives the model only the context it needs, and records the result.

CCv3 started from the MIT-licensed
[parcadei/Continuous-Claude-v3](https://github.com/parcadei/Continuous-Claude-v3).

Status: one operator uses CCv3 every day on a Windows 11 machine. The install path was verified
on a second machine on 2026-10-24 (PR #147). It is a development harness for one person. It is
not a multi-user product.

| Page | What it holds |
|---|---|
| [The layers](layers.md) | The harness shape and the six layers: hooks, rules, memory, agents, guardrails and observability. |
| [Self-improvement](self-improvement.md) | How the harness reviews itself on a schedule. |
| [Pull request review and CI](review-and-ci.md) | The checks each pull request passes before the operator merges it. |
| [Multi-agent communication](multi-agent.md) | How agents and sessions exchange work. |
| [Engineering principles](principles.md) | The rules the harness holds itself to. |
| [Repository map](repo-map.md) | Where each part lives in the repository. |
| [Testing and gates](gates.md) | What "done" means per surface, and the static gates with their current output. |
| [Related work](related-work.md) | FourthBot, a separate repository that applies the same harness shape. |
