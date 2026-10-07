---
title: "What Is the Agent Harness in Microsoft Agent Framework"
description: "The Agent Harness is Microsoft Agent Framework's batteries-included runtime: one call (AsHarnessAgent in .NET, create_harness_agent in Python) wraps any chat client in a tool loop with todos, plan/execute modes, file memory, tool approval, compaction and OpenTelemetry. Here is what it actually sends to the model on Microsoft.Agents.AI.Harness 1.23.0, what it costs per call, and how to trim it."
pubDate: 2026-10-07
template: how-to
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "agent-harness"
  - "dotnet"
  - "python"
---

**Short answer:** the Agent Harness is the opinionated runtime layer of Microsoft Agent Framework. You hand it a chat client, and it returns a normal agent (`HarnessAgent`, which derives from `AIAgent` in .NET, or the `Agent` returned by `create_harness_agent` in Python) that already runs the tool-calling loop, keeps a todo list, switches between "plan" and "execute" modes, writes working notes to file memory, gates tools behind approvals, compacts history near the token limit and emits OpenTelemetry. None of it is a new runtime: the harness composes the chat pipeline, context providers and middleware that already exist in the framework. On `Microsoft.Agents.AI.Harness` 1.23.0 with default options, every model call carries 15 tools and about 11,300 characters of instructions and tool schemas before your first word, so it is worth knowing what is in there and how to switch pieces off. The harness reached general availability in August 2026, after going stable at Build in June.

## Why a "harness" is now its own concept

A model on its own only produces text. Everything that makes Claude Code, Copilot CLI or Cursor feel like an agent is code around the model: the loop that executes tool calls and feeds results back, the history that gets persisted and trimmed, the prompt that tells the model to plan before acting, the guard that asks a human before `deploy` runs. The industry started calling that layer the harness, and Microsoft's own docs define it as "the runtime scaffolding that turns a language model into an agent that can perform work."

Before the harness shipped, building a long-running agent on Agent Framework meant assembling that layer yourself: wrap the `IChatClient` in `FunctionInvokingChatClient`, add a history provider, write a planning prompt, register approval middleware, wire up compaction. The [1.0 release](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) gave you the parts. The harness gives you the assembled product with sensible defaults, and you remove what you do not need instead of adding what you do.

The important design decision is that the result is still an `AIAgent`. Sessions, context providers, middleware, workflows, hosting, A2A and MCP exposure all work unchanged, because there is no separate agent type to integrate with.

## What the harness composes

The [Agent Harness docs](https://learn.microsoft.com/en-us/agent-framework/concepts/harness) describe five layers:

1. **Chat client**: your connection to a model (OpenAI, Azure OpenAI, Foundry, Anthropic, Ollama, anything that implements `IChatClient`).
2. **Chat pipeline**: function invocation, message injection, per-service-call history persistence and optional compaction.
3. **Agent and context providers**: session-scoped instructions, tools, memory, todo state, operating modes.
4. **Middleware and decorators**: tool approval, observability and optional bounded looping.
5. **Application UX**: streaming, progress display and approval prompts. This one is yours; the harness does not ship a UI.

And this is the default capability set, condensed from the docs' capability matrix:

| Capability | Default |
| --- | --- |
| Function invocation loop | On, with a per-request iteration limit |
| History persisted after every model call | On |
| Compaction | On when you supply token limits or a strategy |
| Todo list (`todos_*` tools) | On |
| Plan and execute modes (`mode_get`, `mode_set`) | On, starting in plan mode |
| Session file memory (`file_memory_*` tools) | On |
| Shared file access | Opt-in |
| Tool approval with standing approvals and auto-approval rules | On |
| OpenTelemetry | On |
| Web search | On where the chat client supports it |
| Agent Skills | On in .NET, opt-in in Python |
| Background agents, shell tools, looping | Opt-in |

## Creating a harness agent

In .NET the package is `Microsoft.Agents.AI.Harness` and the entry point is an extension method on `IChatClient`:

```csharp
// Microsoft.Agents.AI.Harness 1.23.0, Microsoft.Extensions.AI 10.10.0, .NET 10
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

IChatClient chatClient = /* any IChatClient: OpenAI, Azure OpenAI, Foundry, Ollama... */;

AIAgent agent = chatClient.AsHarnessAgent(new HarnessAgentOptions
{
    Name = "research-agent",
    HarnessInstructions = "Use tools deliberately and report verified results.",
    ChatOptions = new ChatOptions
    {
        Instructions = "You are a research assistant focused on academic sources.",
    },
    MaxContextWindowTokens = 128_000,
    MaxOutputTokens = 16_384,
});

AgentSession session = await agent.CreateSessionAsync();
AgentResponse response = await agent.RunAsync("Compare three papers on KV-cache eviction.", session);
Console.WriteLine(response.Text);
```

`HarnessInstructions` replaces the built-in operating guidance (`HarnessAgent.DefaultInstructions`, 773 characters in 1.23.0), and your `ChatOptions.Instructions` are appended after it. Setting `MaxContextWindowTokens` is what turns compaction on, so set it to the real window of the model you are calling.

The Python equivalent, from the official docs (Python package `agent-framework` 1.20.0 at the time of writing):

```python
# agent-framework 1.20.0 (snippet from the official docs)
from agent_framework import create_harness_agent
from agent_framework.openai import OpenAIChatClient

agent = create_harness_agent(
    client=OpenAIChatClient(model="gpt-4o"),
    name="research-agent",
    harness_instructions="Use tools deliberately and report verified results.",
    agent_instructions="You are a research assistant focused on academic sources.",
    max_context_window_tokens=128_000,
    max_output_tokens=16_384,
)

session = agent.create_session()
response = await agent.run("Compare three papers on KV-cache eviction.", session=session)
print(response.text)
```

Go has no packaged harness yet. The docs tell you to compose the agent, context-provider, compaction and middleware packages yourself.

## What the model actually receives

Documentation lists capabilities. I wanted to see the prompt. The simplest way is to hand `AsHarnessAgent` a fake `IChatClient` that logs whatever arrives and returns scripted responses, so no tokens are spent and the output is deterministic:

```csharp
// Microsoft.Agents.AI.Harness 1.23.0, .NET 10. Fake model that logs each call.
class FakeClient : IChatClient
{
    int n;
    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages,
        ChatOptions? options = null, CancellationToken ct = default)
    {
        n++;
        Console.WriteLine($"call #{n}: instructions {options?.Instructions?.Length} chars, " +
            "tools: " + string.Join(", ", options?.Tools?.Select(t => t.Name) ?? []));
        foreach (var m in messages)
            Console.WriteLine($"  {m.Role}: {string.Join(" ", m.Contents.Select(c => c.GetType().Name))}");

        // First call: ask for a tool. Second call: finish.
        if (n == 1)
            return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant,
                [new FunctionCallContent("c1", "mode_get", new Dictionary<string, object?>())])));
        return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, "done")));
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken ct = default)
        => throw new NotImplementedException();
    public object? GetService(Type serviceType, object? serviceKey = null)
        => serviceType.IsInstanceOfType(this) ? this : null;
    public void Dispose() { }
}
```

Running `new FakeClient().AsHarnessAgent()` with no options and the prompt `"hello"` prints this tool list on the first call:

```text
web_search, todos_add, todos_complete, todos_remove, todos_get_remaining, todos_get_all,
mode_set, mode_get, file_memory_write, file_memory_read, file_memory_delete, file_memory_ls,
file_memory_grep, file_memory_replace, file_memory_replace_lines
```

`web_search` is a `HostedWebSearchTool`, a provider-side tool the chat client translates into the vendor's own search feature. The other 14 are local `AIFunction`s the harness executes itself. No skill tools appear because no skills directory exists in the probe's working folder.

The instructions are about 6,450 characters and come in five blocks, in this order:

1. **General guidelines** (the default harness instructions): think before acting, explain between tool calls, "Avoid making more than 4 tool calls in a row without explaining what you are doing", adapt after a failed call instead of repeating it, finish with a summary.
2. **Your agent instructions**, appended verbatim.
3. **Todo Items**: when to break work into todos and which `todos_*` tool does what.
4. **Agent Mode**: a full workflow for `plan` (analyze, create todos, ask clarifying questions one at a time, write the plan to a memory file, ask for approval to switch) and `execute` (work autonomously, do not ask questions, pick the most reasonable option on ambiguity). The block ends with "You are currently operating in the plan mode."
5. **File Based Memory**: how to name memory files, to check `file_memory_ls` before starting, and to offload large tool results to files so they survive compaction.

The message list also gets something you did not write. After your `"hello"`, the todo provider injects a second user message:

```text
### Current todo list
- none yet
```

Then the loop runs as you would expect. Call #2 carries the assistant's `FunctionCallContent` for `mode_get`, the harness-produced `FunctionResultContent` (`plan`), and the model finishes. The returned `AgentResponse.Messages` contains the call, the result and the final text, not just the last answer.

## What that costs per call

Instructions plus tool names, descriptions and JSON schemas add up to roughly 11,300 characters on every model call with default options, which is in the range of 2,500 to 3,000 tokens depending on the tokenizer. With every optional provider disabled the same probe sends 773 characters and zero tools.

That overhead is static across calls within a session, which makes it an ideal prompt-cache prefix: if your provider supports caching, the harness prefix is the part that will hit. If it does not, a 40-step research run pays for those tokens 40 times. Either way, the cheapest token is the tool you never registered.

## Trimming the composition

Every default has a targeted switch on `HarnessAgentOptions`:

```csharp
// Microsoft.Agents.AI.Harness 1.23.0: a lean harness for a single-purpose ops agent
AIAgent agent = chatClient.AsHarnessAgent(new HarnessAgentOptions
{
    ChatOptions = new ChatOptions
    {
        Instructions = "You deploy services. Confirm the environment before deploying.",
        Tools = [deployTool],
    },
    DisableWebSearch = true,          // no hosted search tool
    DisableFileMemory = true,         // no file_memory_* tools or memory prompt
    DisableAgentModeProvider = true,  // no plan/execute workflow, no mode_* tools
    DisableAgentSkillsProvider = true,
    MaximumIterationsPerRequest = 10, // null falls back to FunctionInvokingChatClient's 40
});
```

With that configuration my probe shows the instructions dropping to 2,355 characters and the tool list to `deploy` plus the five `todos_*` tools. Add `DisableTodoProvider = true` to get to the bare 773-character core.

The rest of the options, read from the 1.23.0 assembly: `CompactionStrategy` and `DisableCompaction`, `ChatHistoryProvider`, `AIContextProviders` for your own providers, `LoopEvaluators` and `LoopAgentOptions` for bounded re-invocation, `ToolApprovalAgentOptions` and `DisableToolAutoApproval`, `FileMemoryStore` and `FileAccessStore` with `FileAccessProviderOptions`, `AgentModeProviderOptions`, `AgentSkillsSource`, `DisableOpenTelemetry` and `OpenTelemetrySourceName`, and `BackgroundAgents` with `BackgroundAgentsProviderOptions` for delegating to named child agents in parallel.

If you need a constructor instead of the extension method, `new HarnessAgent(IChatClient, HarnessAgentOptions, ILoggerFactory, IServiceProvider)` is the full signature, and `HarnessAgent` itself derives from `DelegatingAIAgent`.

## Tool approval inside the harness

Approval is not a separate feature you bolt on. Wrap a tool in `ApprovalRequiredAIFunction` and the harness turns the model's call into a request instead of executing it:

```csharp
// Microsoft.Agents.AI.Harness 1.23.0
var deployTool = new ApprovalRequiredAIFunction(
    AIFunctionFactory.Create((string env) => $"deployed to {env}", "deploy", "Deploy the app"));

AgentResponse r = await agent.RunAsync("deploy staging", session);

var request = r.Messages.SelectMany(m => m.Contents)
    .OfType<ToolApprovalRequestContent>()
    .FirstOrDefault();

if (request is not null)
{
    // Show the user what will run, then:
    r = await agent.RunAsync(new ChatMessage(ChatRole.User, [request.CreateResponse(true)]), session);
}
```

In the probe, the first run returned a single assistant message containing `ToolApprovalRequestContent` and no tool executed. The second run executed `deploy`, and the model's next call saw a normal `FunctionCallContent` / `FunctionResultContent` pair in history. The approval response message itself was not persisted, so the transcript reads as if the model called the tool directly. For the full pattern, including rejection reasons and UI wiring, see the [human-in-the-loop tool approval walkthrough](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/).

The "standing approvals and auto-approval rules" in the capability matrix are what keep this from becoming a click-fest in long runs. They are configured through `ToolApprovalAgentOptions`, whose 1.23.0 surface is `AutoApprovalRules` and `MaxAutoApprovalIterations`. `DisableToolAutoApproval = true` turns auto-approval off when every call must be confirmed by a person.

## Gotchas I hit while probing

**The todo snapshot accumulates in history.** The `### Current todo list` message is injected on every `RunAsync` and persisted with the session. After three runs in one session, the history the model sees contains three snapshots. The snapshot also reflects the list at the start of the run, not after `todos_add` executes mid-loop, so the model relies on the tool result for the current state. On long conversations this is another argument for setting `MaxContextWindowTokens` so compaction can clean up.

**The harness starts in plan mode.** The default mode prompt tells the model to ask clarifying questions one at a time and to request approval before switching to execute. That is right for an interactive terminal agent and wrong for a headless job that nobody answers. For unattended runs, set `AgentModeProviderOptions.DefaultMode = "execute"`, or disable the mode provider entirely. The same options type exposes `Modes`, `Instructions`, `DisableModeSetTool` and `DisableModeGetTool` if you want custom modes or a mode the model cannot leave.

**Some options are still experimental.** `FileMemoryStore` fails the build with `MAAI001` ("for evaluation purposes only and is subject to change or removal") unless you suppress it. In Python the docs flag background agents, file access and looping as experimental, and shell tooling comes from the pre-release `agent-framework-tools` package.

**The terminal UI is a sample.** `HarnessConsole.RunAgentAsync` in .NET and the Textual `console` package in Python live in the samples folder, not in the shipped packages. Copy them, do not reference them.

**`web_search` depends on the client.** It is a hosted tool, so the harness does not execute it; the chat client has to translate `HostedWebSearchTool` into the provider's own search feature. My fake client received it anyway, which means the harness does not filter it out for you. For local models or providers without hosted search, set `DisableWebSearch = true` so you know exactly what the model is offered.

## When to use the harness and when not to

Use the harness when the job is open-ended and multi-step: research, coding, data analysis, anything where the model benefits from planning, writing notes it can recover after compaction, and a human checkpoint before risky tools. That is the class of work where hand-rolling the loop is mostly reinventing what is already here.

Skip it, or strip it down to the core, for narrow request/response agents: a classifier, an extraction step, a single-tool lookup inside a larger [workflow](/2026/10/what-is-the-difference-between-an-ai-agent-and-an-ai-workflow/). There the todo and mode prompts are noise the model has to read on every call, and a plain `ChatClientAgent` is cheaper and more predictable. Because both are `AIAgent`, you can mix them freely in the same [orchestration](/2026/07/agent-framework-orchestration-patterns-compared/), and when the harness agent needs to look like a plain chat client to some other component, [`AsIChatClient` from 1.22](/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) handles that.

### Read next

- [Microsoft Agent Framework 1.0: AI agents in C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) for the building blocks the harness composes.
- [Human-in-the-loop tool approval in Agent Framework](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/) for the approval flow in depth.
- [Agent Framework 1.23: function middleware can now swap the tool](/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/) for intercepting the calls the harness makes.
- [What is a context window and how do agents stretch it](/2026/10/what-is-a-context-window-and-how-do-agents-stretch-it-in-2026/) for why compaction and file memory matter.

### Sources

- [Agent Harness, Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/concepts/harness)
- [Microsoft.Agents.AI.Harness on NuGet](https://www.nuget.org/packages/Microsoft.Agents.AI.Harness)
- [.NET Harness samples](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Harness) and [Python Harness samples](https://github.com/microsoft/agent-framework/tree/main/python/samples/02-agents/harness)
- [InfoQ: Agent Framework Harness reaches GA](https://www.infoq.com/news/2026/08/agent-framework-harness-ga)
