---
title: "How to Make a Microsoft Agent Framework Background Run Survive a Host Restart"
description: "Turn on resilient background responses in a Foundry-hosted Microsoft Agent Framework agent with resilient_background=True or ResilientBackground = true, send store and background on every request, keep executor IDs stable, and make side effects idempotent so a crashed run resumes from its last workflow checkpoint."
pubDate: 2026-11-15
template: how-to
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "azure-ai-foundry"
  - "python"
  - "dotnet"
---

To make a Microsoft Agent Framework background run survive the host process dying, host the agent or workflow with the Foundry Responses host and turn on **resilient background responses**: `ResponsesServerOptions(resilient_background=True)` in Python (`agent-framework-foundry-hosting` 1.0.0b261112, `azure-ai-agentserver-responses` 2.4.0) or `options.ResilientBackground = true` in .NET (`Microsoft.Agents.AI.Foundry.Hosting` 1.28.0-preview.261106.1). Then every request has to send `"store": true` **and** `"background": true`. Only that combination is re-invoked after a crash. Anything else is marked failed. When the run is a workflow, it resumes from its last checkpoint rather than from scratch, provided the restarted process rebuilds the same workflow name and executor IDs.

The client-side `AllowBackgroundResponses` / `continuation_token` feature does not cover this case. It protects the *caller* against a dropped connection. It does nothing for *your* host if it is redeployed, scaled in or OOM-killed in the middle of a 20-minute run. The rest of this post covers the difference, the server setup in both languages, and the rules that decide whether a run comes back.

## Two kinds of "background" in Agent Framework

Agent Framework uses the word "background" for two features that sit at different layers:

1. **Provider background responses** ([Learn: Agent Background Responses](https://learn.microsoft.com/en-us/agent-framework/agents/background-responses)). Your code is the client. You set `AllowBackgroundResponses = true` on `AgentRunOptions` (.NET) or pass `options={"background": True}` (Python). The model provider, currently the OpenAI or Azure OpenAI Responses API or Foundry, runs the job and gives you a continuation token, and you poll or resume streaming with it. The work runs on the provider's side, so your process can restart as long as you persisted the token and the session.
2. **Resilient background responses** ([devblog, September 24, 2026](https://devblogs.microsoft.com/agent-framework/interactive-experiences-memory-and-resilient-execution/)). Your code is the server. You host an agent or workflow behind the Foundry Responses protocol (`POST /responses`), and the run executes in *your* container: workflow supersteps, local tool calls, the orchestration loop. If that container dies, nothing at the provider can resume it, because the provider never had it. Resilient background is the host-side mechanism that records the run, checkpoints it, and re-invokes it in the next process.

If your agent is a single model call with no local tools, (1) is enough. If it is a workflow, a [Magentic or handoff orchestration](/2026/07/agent-framework-orchestration-patterns-compared/), or anything that runs code between model calls, you need (2). As the devblog puts it, a longer timeout does not make an agent resilient.

## The scenario: a countdown that should outlive a kill -9

The upstream samples use a deliberately slow workflow so a crash lands mid-run. The Python one is a typed countdown: a start executor stores a label, and a countdown executor sleeps one second per step, yields the number, and sends `target - 1` to itself. A request with `target: 20` runs for about 20 seconds, which gives you enough time to kill the process and watch the run continue after a restart.

## Python: ResponsesHostServer with resilient_background

This is the [`resilient_long_running_workflow`](https://github.com/microsoft/agent-framework/tree/main/python/samples/04-hosting/foundry-hosted-agents/responses/resilient_long_running_workflow) sample, trimmed slightly. I installed the listed package versions in a Python 3.12 virtual environment and confirmed that every import resolves and that the `ResponsesHostServer`, `ResponsesServerOptions` and `CheckpointStoreProvider` signatures match. I did not start the server or run a crash test, so the restart behavior described here comes from the upstream sample, its README, and the package source, not from a run.

```python
# agent-framework-foundry-hosting 1.0.0b261112
# agent-framework-core 1.26.0, azure-ai-agentserver-responses 2.4.0, Python 3.12
import asyncio

from agent_framework import Executor, Workflow, WorkflowBuilder, WorkflowContext, handler
from agent_framework_foundry_hosting import (
    CheckpointStoreProvider,
    HostedResponseRequest,
    ResponsesHostServer,
    WorkflowTurn,
)
from azure.ai.agentserver.core.tasks import set_resilient_tasks_enabled
from azure.ai.agentserver.responses import ResponsesServerOptions
from pydantic import BaseModel, Field


class CountdownRequest(BaseModel):
    target: int = Field(ge=0)
    label: str = "countdown"


class StartExecutor(Executor):
    def __init__(self) -> None:
        super().__init__(id="start")  # stable ID: recovery matches on it

    @handler
    async def start(self, request: CountdownRequest, ctx: WorkflowContext[int, str]) -> None:
        ctx.set_state("label", request.label)
        await ctx.send_message(request.target)


class CountdownExecutor(Executor):
    def __init__(self) -> None:
        super().__init__(id="countdown")

    @handler
    async def countdown(self, target: int, ctx: WorkflowContext[int, str]) -> None:
        if target == 0:
            await ctx.yield_output(f"{ctx.get_state('label')} complete.")
            return
        await asyncio.sleep(1)
        await ctx.yield_output(str(target))
        await ctx.send_message(target - 1, target_id=self.id)


def build_workflow(request: HostedResponseRequest) -> Workflow:
    # A factory, not a singleton: fresh executors for every invocation AND every recovery.
    start, countdown = StartExecutor(), CountdownExecutor()
    return (
        WorkflowBuilder(name="countdown-workflow-v1", start_executor=start)
        .add_edge(start, countdown)
        .add_edge(countdown, countdown)
        .build()
    )


async def parse_response(request: HostedResponseRequest) -> WorkflowTurn[CountdownRequest]:
    return WorkflowTurn(input=CountdownRequest.model_validate_json(await request.get_input_text() or ""))


def main() -> None:
    set_resilient_tasks_enabled(True)
    ResponsesHostServer(
        workflow=build_workflow,
        parse_response=parse_response,
        checkpoint_store_provider=CheckpointStoreProvider(
            allowed_checkpoint_types=[f"{CountdownRequest.__module__}:{CountdownRequest.__qualname__}"],
        ),
        options=ResponsesServerOptions(resilient_background=True),
    ).run()


if __name__ == "__main__":
    main()
```

Three parts of this matter for recovery:

- **`workflow=build_workflow`** passes a factory. After a restart, the host calls it again and loads the stored checkpoint into the new graph. The checkpoint refers to executors by ID and to the workflow by name, so `"start"`, `"countdown"` and `"countdown-workflow-v1"` cannot change between deploys while runs are in flight. If you rename an executor, any checkpoint written under the old name no longer matches.
- **`CheckpointStoreProvider(allowed_checkpoint_types=[...])`** is an allowlist for the types the checkpoint deserializer may rebuild, written as `"module:qualname"`. Typed workflow state outside that list cannot be restored. Add an entry every time you introduce a new message or state model.
- **`set_resilient_tasks_enabled(True)`** is the AgentServer task-subsystem opt-in. Its docstring in `azure-ai-agentserver-core` 2.3.1b1 describes it as the switch for Invocations hosts and says Responses hosts use their own feature options. The sample still calls it before `ResponsesHostServer`, and the package README says Responses hosting must also enable the task subsystem. Keep it. It costs nothing, and leaving it out is the kind of mismatch you only find during an incident.

Hosting a plain agent instead of a workflow looks like `ResponsesHostServer(workflow_agent, options=ResponsesServerOptions(resilient_background=True))`, as shown in the devblog. The checkpoint-level resume is a workflow feature, though. For a non-workflow agent the host can re-invoke the handler, but there is no superstep boundary to restart from, so expect the turn to run again from its beginning.

## .NET: AddFoundryResponses with ResilientBackground

The .NET equivalent is the [`Hosted-Workflow-Resilient`](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/04-hosting/FoundryHostedAgents/responses/Hosted-Workflow-Resilient) sample. It chains three translator agents (French, then Spanish, then English) as a workflow and exposes the workflow as an `AIAgent`. The code below follows the sample. I have not compiled it.

```csharp
// Microsoft.Agents.AI.Foundry.Hosting 1.28.0-preview.261106.1, .NET 10
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;

var endpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT is not set."));

IChatClient chatClient = new AIProjectClient(endpoint, new DefaultAzureCredential())
    .GetProjectOpenAIClient()
    .GetChatClient("gpt-4o")
    .AsIChatClient();

// Fixed Id + Name on every agent: the restarted process must rebuild the same executor identities.
AIAgent french = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Id = "french-translator",
    Name = "French Translator",
    ChatOptions = new() { Instructions = "Translate the provided text to French. Return only the translation." },
});
AIAgent spanish = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Id = "spanish-translator",
    Name = "Spanish Translator",
    ChatOptions = new() { Instructions = "Translate the provided text to Spanish. Return only the translation." },
});
AIAgent english = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Id = "english-translator",
    Name = "English Translator",
    ChatOptions = new() { Instructions = "Translate the provided text to English. Return only the translation." },
});

AIAgent agent = new WorkflowBuilder(french)
    .AddEdge(french, spanish)
    .AddEdge(spanish, english)
    .Build()
    .AsAIAgent(name: "hosted-workflow-resilient");

var builder = WebApplication.CreateBuilder(args);
builder.AddFoundryResponses(agent, configure: options => options.ResilientBackground = true);

var app = builder.Build();
app.MapFoundryResponses();
app.Run();
```

The devblog shows the same switch registered as `builder.Services.AddFoundryResponses(agent, configure: options => options.ResilientBackground = true)`. The sample also contains an `#if` branch for an unreleased `FoundryResponsesServerOptions { ResilientBackground = true }` overload. Treat the `configure:` lambda as the stable shape across the 1.2x previews.

According to the sample README, after each completed superstep the host saves the `AgentSession`, records the workflow checkpoint ID in internal response metadata, and calls `ResponseEventStream.Checkpoint()`. Recovery looks up that exact checkpoint ID. It does not count how many output events the client has already received.

## The request has to opt in too

The server option only makes recovery possible. Each request decides whether it gets it. This is the decision function in `azure-ai-agentserver-responses` 2.4.0 (`hosting/_dispatch.py`), quoted as-is:

```python
# azure-ai-agentserver-responses 2.4.0, hosting/_dispatch.py
def decide_disposition(*, background: bool, resilient_background: bool, store: bool) -> str:
    if background and resilient_background and store:
        return DISPOSITION_REINVOKE
    return DISPOSITION_MARK_FAILED
```

The same file names the four rows of what it calls the resilience matrix:

| Row | `store` | `background` | `resilient_background` | After a crash |
| --- | --- | --- | --- | --- |
| 1 | true | true | true | Re-invoked, resumes from checkpoint |
| 2 | true | true | false | Marked failed |
| 3 | true | false | any | Marked failed |
| 4 | false | any | any | No resilient state, nothing to recover |

So a client that forgets `"store": true` loses the run silently, even though the server was configured correctly. A request that qualifies looks like this:

```bash
# Foundry Responses protocol, local host on :8088 (Python sample default)
curl -X POST http://localhost:8088/responses \
  -H "Content-Type: application/json" \
  -d '{"input":"{\"target\":20,\"label\":\"demo\"}","stream":true,"store":true,"background":true}'
```

Note the response `id` from the first event. After the host restarts, you either poll `GET /responses/<id>` until it reaches a terminal status, or reconnect to the event stream with `GET /responses/<id>?stream=true`. Those two calls are what the upstream README documents. It does not document a resume-after-cursor parameter, so do not build a client that relies on one.

## Where the state lives

Recovery is only as durable as the storage behind it.

- **Locally**, AgentServer writes response envelopes, the event replay log, scoped bindings and workflow checkpoints under `${AGENTSERVER_STATE_ROOT:-~/.agentserver}`, with the generic state stores at `state_stores/*.json` and tasks at `tasks/<agent>/<session>/`. When you test crashes, point `AGENTSERVER_STATE_ROOT` at a throwaway directory so one test does not recover another test's runs. If the directory is wiped between container starts, as it is on an ephemeral container filesystem with no volume, there is nothing to recover.
- **On Foundry Hosted Agents**, the .NET README splits ownership: AgentServer owns the background task, response events and response snapshots, Foundry state-store-backed session storage holds the `AgentSession` and the checkpoint reference, and a Foundry state-store-backed checkpoint store holds the checkpoints. The checkpoint store writes through the hosted agent's managed identity, so after the first `azd deploy` you have to grant that identity the **Foundry User** role on the project and wait a few minutes for it to propagate. Until then, checkpoint writes fail.

That second point is the most likely reason a resilient deploy "does nothing" in its first hour. If you followed [deploying an Agent Framework agent to Foundry Hosted Agents](/2026/06/deploy-a-microsoft-agent-framework-agent-to-foundry-hosted-agents/) before this feature existed, the role assignment is new.

## Recovery is at-least-once, so make side effects idempotent

The upstream docs state this plainly: recovery does not mean exactly-once execution of external effects. The host deduplicates what it *emits*. The README says it prevents duplicate output and usage for recovered checkpoints. But a superstep that was running when the process died runs again from its start. If that step sent an email, opened a pull request or charged a card before the crash, it will do it again.

The usual fixes apply:

```python
# Pattern, not an API: derive the key from data that is identical on replay.
async def file_ticket(summary: str, response_id: str, step: str) -> None:
    idempotency_key = f"{response_id}:{step}"
    await tickets.create(summary=summary, idempotency_key=idempotency_key)
```

- Key every external write on something stable across replays, such as the response ID plus the executor ID. Never use a fresh `uuid4()`, because each replay generates a new one.
- Split work so that each risky call is the last thing a superstep does. The less work that runs before the side effect, the less gets repeated.
- For human-approval steps, see [human-in-the-loop tool approval in Agent Framework](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/). An approval that was granted before the crash should not be requested a second time.

The Python hosting docstring makes the same point for the other mode, `background_source="provider"` (which requires `history_source="service"`): local tools must be idempotent, because a crash before the next continuation token is saved can replay them.

## Gotchas

- **Graceful shutdown is separate from crash recovery.** `ResponsesServerOptions(shutdown_grace_period_seconds=10)` is the default drain window. A handler that sees `context.shutdown` set can call `await context.exit_for_recovery()`. That leaves the response `in_progress` so the next process re-invokes it, instead of having it cut off and marked failed. Use it in long custom handlers so SIGTERM during a rolling deploy takes the recovery path.
- **Legacy unscoped sessions are not read.** If you previously hosted with `agent=workflow.as_agent()`, the README says existing unscoped workflow sessions are ignored. Start fresh response chains when you migrate.
- **Three IDs, not one.** The Foundry sandbox, the Responses continuation and the Agent Framework checkpoint are separate identities. If you also [isolate users and sessions in a hosted agent](/2026/10/how-to-isolate-users-and-sessions-in-a-foundry-hosted-microsoft-agent-framework-agent/), log all three on every recovery so you can trace one run across processes.
- **`steerable_conversations` is independent.** It sits next to `resilient_background` on the same options object, and the source comments say the two used to be coupled and no longer are. Turning on steering does not make runs resilient, and the reverse is also true.
- **This is not Durable Functions.** On Azure Functions, use the separate [Durable extension for Agent Framework](https://github.com/microsoft/agent-framework-durable-extension). For self-managed checkpointing outside Foundry hosting, the [durable workflows checkpoint-and-restart pattern](/2026/05/agent-framework-durable-workflows-checkpoint-restart/) is still the tool.
- **Still preview.** Every `Microsoft.Agents.AI.Foundry.Hosting` build on NuGet is a prerelease, and the Python package is `1.0.0b*`. Pin exact versions, because the option surface has already changed once (the direct-options overload in the .NET sample).

If your long run is an MCP tool call rather than an agent turn, the same poll-and-reconnect idea exists at the protocol level: see [the MCP Tasks extension](/2026/11/what-is-the-mcp-tasks-extension-and-when-do-you-need-poll-based-long-running-tools/). And because a run that survives a restart can still hit `overloaded_error` partway through, combine this with [retry and backoff for long agent loops](/2026/11/retry-and-backoff-for-long-agent-loops-under-overloaded-and-rate-limit-errors/).

## Sources

- [What's new in Microsoft Agent Framework: Interactive experiences, memory, and resilient execution](https://devblogs.microsoft.com/agent-framework/interactive-experiences-memory-and-resilient-execution/) (devblog, September 24, 2026)
- [Agent Background Responses](https://learn.microsoft.com/en-us/agent-framework/agents/background-responses) (Microsoft Learn, updated October 2026)
- [Python sample: resilient_long_running_workflow](https://github.com/microsoft/agent-framework/tree/main/python/samples/04-hosting/foundry-hosted-agents/responses/resilient_long_running_workflow)
- [.NET sample: Hosted-Workflow-Resilient](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/04-hosting/FoundryHostedAgents/responses/Hosted-Workflow-Resilient)
- [agent-framework-foundry-hosting on PyPI](https://pypi.org/project/agent-framework-foundry-hosting/)
- [Microsoft.Agents.AI.Foundry.Hosting on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI.Foundry.Hosting)
