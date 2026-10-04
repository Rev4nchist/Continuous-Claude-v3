# Fabric data agent

CCv3-authored. Upstream `skills-for-fabric` has no data agent skill, so nothing here is vendored.
A fact marked "measured" comes from one tenant, the FourthCompanyBrain playground. The `L-NN` id names
the lesson in that project's lessons log. A measurement with no `L-NN` id comes from FourthCompanyBrain
`.claudedocs/2026-10-01-phase5-proof.md` ("proof:NNN" names its line). Treat a measurement as evidence,
not as a universal rule.

## Contents

- [When to use](#when-to-use)
- [Never](#never-these-lines-win-over-learn-text-and-samples)
- [Query a published agent over MCP](#query-a-published-agent-over-mcp)
- [Old Assistants code: the Responses client](#old-assistants-code-the-responses-client)
- [Create, configure and publish with the SDK](#create-configure-and-publish-with-the-sdk)
- [Permissions and capacity](#permissions-and-capacity)
- [Known gaps](#known-gaps)

## When to use

- Ask a published Fabric data agent a question from a script, a notebook or a test harness.
- Create, configure or publish a data agent with the Python SDK.
- Not for AI Functions, KQL queries (`kusto-cli`) or SQL outside Fabric (`databases`).
- Overview: https://learn.microsoft.com/en-us/fabric/data-science/concept-data-agent

## Never: these lines win over Learn text and samples

1. On HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry.
   Do not back off and ask again. Learn documents `Retry-After` on the publish API: CCv3 overrides it.
   The vendor overlay does not cover this file, so this line carries the override.
   Over MCP the error is text: `McpError: Your organization's Fabric compute capacity has exceeded its limits`.
   Measured: from question 14 on, 27 of 40 answers were lost to it in one pass (proof:150).
   The error can also arrive raised, as an HTTP status error with 429 or 430. Check the status and the text,
   then stop. A broad `except Exception` that logs and goes to the next question keeps the load going.
2. Never run `evaluate_data_agent`. By default it scores with a built-in critic prompt. Learn does not
   name the scorer. Its `critic_prompt` sample is an LLM prompt, and `critic_prompt` only replaces the
   built-in one. Inferred: each question is also an agent query, so a run uses capacity. The evaluate
   page states no cost. Reading `get_evaluation_details` of a run that already exists is fine.
   The ban holds when the user asks for the built-in, quickest or official way. Say so, and score
   references in code (never-line 3).
3. Never use an LLM judge. Every answer must carry a references line. Score the references in code (L-14).
4. Never pause, resume or resize a capacity. Do not recommend one either. The capacity owner decides.
   Never name one as a cause, a fix or a next step, not even a past one.
5. Pin the SDK: `%pip install fabric-data-agent-sdk==0.1.32a0`. Learn shows the install with no version or
   with `-U`. Do not copy those lines. Use `python`, never `python3`.
6. Do not manage an agent as a service principal. Use a signed-in user. This is CCv3 policy until a test
   proves the REST management path for a service principal (see the lines below).
   This holds when the user asks for the service principal or an unattended job: give the interactive
   signed-in-user path and cite the 401 below. An unattended job as a user also fails (L-20).
   Measured: service principal `brain-runner`, a workspace Contributor and not the agent's owner, got
   HTTP 401 from the SDK's `management/configuration` API (L-25). That test cannot separate identity
   type from ownership. Not tested: a non-owner user, or a service principal that owns the agent.
   The data agent service principal page is explicit: service principal support is a preview for
   querying a published agent, "not for managing or configuring it" (L-25 quotes it). The DataAgent
   create, update-definition and publish REST pages list a service principal as supported. That REST path
   is untested here, and L-25 tested only the SDK as a non-owner, so the policy stays until a test shows
   otherwise.

## Query a published agent over MCP

Learn: https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server

- Publish the agent first. An agent with no published version has no working MCP endpoint.
- An agent has a draft version and a published version. Edits, instructions too, change the draft
  (Learn). Inferred, not stated by Learn: an MCP caller sees an instruction change only after the next
  publish. Unverified (LT-17). The course said "refresh the agent"; Learn says the agent "applies the
  instruction automatically", which describes the draft (C-10).
  Learn: https://learn.microsoft.com/fabric/data-science/how-to-create-data-agent#publish-and-share-a-fabric-data-agent
- An agent over an ontology: read `references/ontology.md` first. It needs the instruction
  `Support group by in GQL` for aggregation questions (G-56, Learn).
- URL: `https://api.fabric.microsoft.com/v1/mcp/workspaces/<workspaceId>/dataagents/<dataAgentId>/agent`.
  The agent's Settings page shows it on the Model Context Protocol tab.
- The transport is streamable HTTP. Send `initialize`, then `tools/list`, then `tools/call`. A plain REST
  POST that skips the handshake fails.
- The server has one tool. Read the tool name and the argument name from `tools/list` (`inputSchema`).
  Do not hard-code them. Measured once: the tool for agent `brain_agent` was `DataAgent_brain_agent`
  (proof:238).
- Get the bearer token from `az account get-access-token`. Keep it in memory. Never print or log it.
  The scope is not settled: see [Known gaps](#known-gaps).
- The endpoint has no built-in conversation state. Send the context again for a follow-up question.
  Learn: https://learn.microsoft.com/en-us/fabric/data-science/data-agent-end-to-end-tutorial
- Learn caps agent responses at 25 rows and 25 columns (concept page, chat output). The MCP page states
  no cap. The agent is not a bulk data path.
- Measured: the result is one text block. Put a references line in the agent instructions, for example
  `REFS: <id>, <id>`. Score each answer by its references in code, never by an LLM judge (L-14).
- Pin the client: `python -m pip install mcp==1.26.0`. Source: FourthCompanyBrain `iq.py agent-score`
  imports `mcp` from this machine's Python 3.13, which has `mcp-1.26.0.dist-info` (installed 2026-02-10).
  Pass 2 ran on it (proof:154). The project has no lock file.
- Ask one question at a time on an F2. Bound each call with a timeout. Count a lost answer or a tool
  error result as a transport error, not as a wrong answer.
- mcp 1.26.0 waits up to 300 s for an answer by default. The httpx `read` timeout bounds each wait for
  data. `read_timeout_seconds` on `ClientSession` bounds each request, the handshake too.
- Measured on mcp 1.26.0 against local test servers: a 429 and a timeout both arrive wrapped in an
  `ExceptionGroup`. `str()` of the group does not contain "429". The transport also swallows a 429 on the
  `notifications/initialized` POST. The sample records every 429 or 430 response with an httpx hook and
  raises `Throttled`. Catch it and stop all load.

```python
# python -m pip install mcp==1.26.0. Python 3.11+ (ExceptionGroup). Never print the token.
import re, shutil, subprocess
from datetime import timedelta
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

class Throttled(RuntimeError):
    """HTTP 429 or 430, or the capacity text: stop all load. Never retry (never-line 1)."""

CAPACITY = re.compile(r"\b(?:429|430)\b|exceeded its limits")

def fabric_token():
    cmd = [shutil.which("az") or "az", "account", "get-access-token", "--resource",
           "https://api.fabric.microsoft.com", "--query", "accessToken", "-o", "tsv"]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()

def leaves(err):
    # The transport raises an ExceptionGroup. Check every error inside it.
    if isinstance(err, BaseExceptionGroup):
        for sub in err.exceptions:
            yield from leaves(sub)
    else:
        yield err

async def ask(url, question, timeout=120):
    seen = []  # every 429 or 430 response, also one the transport swallows

    async def on_response(resp):
        if resp.status_code in (429, 430):
            seen.append(resp.status_code)

    headers = {"Authorization": "Bearer " + fabric_token()}
    http = httpx.AsyncClient(headers=headers, follow_redirects=True,
                             timeout=httpx.Timeout(30, read=timeout),
                             event_hooks={"response": [on_response]})
    try:
        async with http, streamable_http_client(url, http_client=http) as (read, write, _):
            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=timeout)) as session:
                await session.initialize()
                tool = (await session.list_tools()).tools[0]
                arg = next(iter(tool.inputSchema["properties"]))
                result = await session.call_tool(tool.name, {arg: question})
    except Exception as e:
        if seen or any(CAPACITY.search(str(x)) for x in leaves(e)):
            raise Throttled(f"capacity error (HTTP {seen}): stop all load") from e
        raise  # a timeout: an ExceptionGroup that holds an McpError. A transport error, not a wrong answer.
    text = "\n".join(b.text for b in result.content if b.type == "text")
    if seen or (result.isError and CAPACITY.search(text)):
        raise Throttled(f"capacity error (HTTP {seen}): stop all load")
    if result.isError:
        raise RuntimeError("agent tool error: " + text)
    return text
```

The caller catches `Throttled` first and ends the pass. The questions it did not reach are not run.
Any other exception is a transport error for that question.

## Old Assistants code: the Responses client

Learn: https://learn.microsoft.com/en-us/fabric/data-science/fabric-data-agent-sdk

- OpenAI retired the Assistants API on 2026-08-26. Old code that builds a `FabricOpenAI` client and uses
  threads and runs no longer works. Some Learn pages still show it. New code queries the MCP endpoint.
- To port old notebook query code, use the SDK's Fabric OpenAI Responses client. Only the query code
  changes. Create, configure and publish stay the same.
- The sample notebook imports `FabricOpenAIResponses` from `fabric.dataagent.client`. It builds the client
  with `artifact_name`, `workspace_name` and `ai_skill_stage="sandbox"`. It calls `responses.create(input=...)`
  and chains turns with `previous_response_id`. It passes no model: the client sets one.
  Sample: https://github.com/microsoft/fabric-samples/tree/main/docs-samples/data-science/data-agent-sdk/responses-api
- The sample installs the SDK with `-U`. Do not copy that line: pin the SDK.
- The accepted stage values are not verified on 0.1.32a0. Run `dir()` on `fabric.dataagent.client` first.

## Create, configure and publish with the SDK

Learn: https://learn.microsoft.com/en-us/fabric/data-science/data-agent-add-datasources

- Run the setup in an interactive Fabric notebook as a signed-in user. An unattended job as an MFA
  admin fails with `AADSTS50076` (L-20). Measured: service principal `brain-runner` got 401 (L-25).
- A notebook job that runs `%pip` needs the job parameter `_inlineInstallationEnabled` set to true.
  Measured: without it the session is cancelled and no log reaches the caller (proof:137).
- Learn shows two sets of method names. Only the right-hand column below ran on 0.1.32a0. List the
  methods before you call one: `print([m for m in dir(agent) if not m.startswith("_")])`.

| Step | Learn name | Name that ran on 0.1.32a0 (measured) |
|---|---|---|
| Open or create | `create_data_agent(name, workspace_id)` | `FabricDataAgentManagement(name)`, else `create_data_agent(name)` |
| Instructions | `agent.update_settings(ai_instructions=...)` | `agent.update_configuration(instructions=...)` |
| Add a source | `agent.add_staging_datasource(name_or_id, workspace)` | `agent.add_datasource(name, type="lakehouse")`, then `agent.get_datasources()[0]` |
| See the tree | none | `ds.pretty_print()` |
| Select a table | none | `ds.select("Schemas", "dbo", "Tables", "<table>")` |
| Publish | `agent.publish_staging(description=...)` | `agent.publish_staging(description=...)` |

- Select with the full path that `pretty_print()` shows, one segment per argument. Measured on 0.1.32a0
  and one schema-enabled lakehouse (proof:138): `ds.select("Schemas", "dbo", "Tables", "<table>")`
  selected the table. `ds.select("dbo", "<table>")` returned no error and selected nothing.
- Read the configuration back with `ds.get_configuration()`. Assert that each wanted table has
  `is_selected` true and that no other table does.
- Measured: `agent.publish()` returned `True`, but the MCP endpoint then answered `Failed to get publish
  info`. `publish_staging` created the published version (proof:139).
- One agent takes up to five data sources. Data agent instructions hold up to 15,000 characters
  (how-to-create page). Learn states no limit for data source instructions.
- Example queries (few-shots) must never copy a scored question or its answer.

## Permissions and capacity

- The agent needs a paid F2 or higher, or a P1 or higher with Fabric on. A trial capacity does not
  support data agents, AI functions or Copilot (G-57, Learn). Do not test an agent in a trial tenant.
  Learn: https://learn.microsoft.com/en-us/fabric/data-science/concept-data-agent and
  https://learn.microsoft.com/fabric/fundamentals/fabric-trial
- The Capacity Metrics app shows agent usage as "AI Query". It is a background operation. The rate is
  100 CU-seconds per 1,000 input tokens and 400 per 1,000 output tokens. Cached input costs 10. The
  generated query bills separately, to the engine that runs it.
  Learn: https://learn.microsoft.com/en-us/fabric/fundamentals/data-agent-consumption
- A user assigned to a Fabric Copilot capacity bills agent usage on workspaces below F64 to that
  capacity. Check this before you attribute a cost.
  Learn: https://learn.microsoft.com/en-us/fabric/enterprise/fabric-copilot-capacity
- A default share lets a user query the published version only. The user also needs read on every
  source: Read on a semantic model or lakehouse, SELECT on a warehouse, Reader on a KQL database.
  Learn: https://learn.microsoft.com/en-us/fabric/data-science/data-agent-sharing
- A service principal can query in preview. It needs the tenant switch "Service principals can use
  Fabric APIs", Member or Contributor on the workspace, and read on each source. It cannot query an
  agent with a KQL source. Managed identities cannot query.
  Learn: https://learn.microsoft.com/en-us/fabric/data-science/data-agent-service-principal
- The data source capacity must be in the same region as the agent's capacity. A tenant switch change
  can take up to 1 hour to apply.
- An answer sent to an MCP client can leave the Fabric compliance boundary. Check the data policy first.

## Known gaps

- Token scope. The MCP page uses `https://api.fabric.microsoft.com/.default`. The service principal page
  uses `https://analysis.windows.net/powerbi/api/.default`. Measured in pass 2: a signed-in user token for
  `https://api.fabric.microsoft.com` was accepted on all 40 calls, with 0 transport errors (proof:154),
  and again in the CCv3 live smoke (2026-10-04). Which scope a service principal needs is open.
- The Responses client stage value is not verified. The sample notebook comment says `sandbox` or
  `published`. Another source says `sandbox` or `production`.
- Learn labels these preview: the SDK, service principal querying, and REST "Data Agent configuration
  management". The MCP page shows no preview label. The agent is GA.
- Management identities. The data agent service principal page says querying only, "not for managing or
  configuring it", and no managed identities. The generic SDK and REST publish pages list a service
  principal, and the REST publish page lists a managed identity, for items in general. The data agent page
  is the specific one, and L-25 measured a 401 for management: do not manage as a service principal.
- No Learn page documents the throttling status codes for MCP queries. Stop on the measured MCP text too.
- Measured: answers change between runs. The same agent got 5 of 13 right in one pass and 3 of 13 in
  the next (proof:175). One pass is a sample, not a score.
