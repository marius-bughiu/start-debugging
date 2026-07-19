---
title: "How to Package Reusable Domain Expertise as an Agent Skill in .NET with the Microsoft Agent Framework"
description: "There is no single Skill type in the Microsoft Agent Framework, but you can package domain expertise as a reusable agent, reuse it in-process with AsAIFunction, and advertise it across frameworks as an A2A AgentSkill. Full walkthrough on Agent Framework 1.0 and .NET 11."
pubDate: 2026-07-18
tags:
  - "microsoft-agent-framework"
  - "agent-skills"
  - "ai-agents"
  - "a2a"
  - "dotnet"
  - "csharp"
  - "llm"
---

If you want to bottle up a piece of domain knowledge -- your expense policy, your contract-review rules, your incident-triage playbook -- and reuse it from a chat app, a batch job, and other agents without copy-pasting a system prompt, the [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) (GA April 2026) gives you three moving parts on .NET 11. You package the expertise as a **reusable `AIAgent`** (curated instructions plus a small set of tools). You reuse it in-process by calling `.AsAIFunction()` and handing it to a bigger agent as a tool. And you expose it across process and framework boundaries by hosting it over A2A, where the agent's capabilities are advertised as `AgentSkill` entries on its `AgentCard`. That A2A `AgentSkill` is the only place the word "skill" is a real, first-class type. This post builds one end to end against `Microsoft.Agents.AI`, model `gpt-4o-mini` (swap in `claude-sonnet-4-6` and nothing else changes).

## Why "skill" means two different things here

If you came from Semantic Kernel and searched for a `Skill` type to hold a single function, you already found the answer in [authoring a function tool in the Agent Framework](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/): there is no `Skill` type for code-level tools. A single unit of agent-callable code is an `AIFunction`, built from `AIFunctionFactory.Create`. Nothing about that changes.

"Packaging domain expertise" is a bigger unit than one function. Expertise is the *combination* of a well-tuned instruction set (the rules, the tone, the escalation logic) and the handful of tools that give it live data. That combination is an **agent**, not a tool. And once you want other people's agents -- possibly written in Python or Go, possibly on another team -- to discover and call it, you need a wire-level description of what it does. That description is the A2A `AgentSkill`, a type that genuinely exists in the `A2A` namespace and that the Agent Framework's A2A hosting serializes onto the agent's card. So the honest mental model is: package expertise as an agent, then advertise that agent's capabilities as one or more A2A skills.

## The expertise we are packaging

Take an expense-policy compliance expert. The domain knowledge is real and annoying to get right: per-category daily limits, an approval threshold, and the discipline to always check the live limit before ruling. We want that expert to be callable from three places without three copies of the prompt.

The instructions carry the judgment. A tool gives it the current numbers so the policy can change without a redeploy of the prompt.

```csharp
// Microsoft Agent Framework 1.0 (GA April 2026), .NET 11
// dotnet add package Microsoft.Agents.AI
// dotnet add package Microsoft.Extensions.AI.Abstractions
using System.ComponentModel;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

public sealed class ExpensePolicyTools(IPolicyStore store)
{
    [Description("Get the per-day reimbursement limit for a spend category, in USD.")]
    public async Task<string> GetLimitAsync(
        [Description("Category, for example 'meals', 'lodging', or 'airfare'.")] string category)
    {
        decimal? limit = await store.GetDailyLimitAsync(category);
        return limit is null
            ? $"No limit configured for {category}."
            : $"{category}: {limit:C} per day.";
    }
}
```

## Package the expertise as a reusable agent

The unit of reuse is a factory that takes an `IChatClient` and returns a configured `AIAgent`. Put it in a class library so every consumer references the same instructions and the same tool set. Keep it provider-agnostic: the factory never mentions OpenAI or Anthropic, it takes whatever `IChatClient` you hand it, exactly the seam the Agent Framework was built around (covered in [Building AI Agents in Pure C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/)).

```csharp
// Microsoft Agent Framework 1.0, .NET 11
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

public static class ExpenseComplianceSkill
{
    public const string Instructions = """
        You are an expense-policy compliance expert.
        Decide whether a claimed expense is reimbursable under company policy.
        Always call get_limit for the relevant category before you rule on it.
        State the limit you used. If a claim exceeds the limit, say by how much,
        and note that anything more than 25 percent over the limit needs manager approval.
        Never invent a limit.
        """;

    // The reuse boundary: one factory, any provider.
    public static AIAgent Create(IChatClient chat, IPolicyStore store) =>
        chat.CreateAIAgent(
            name: "ExpenseComplianceExpert",
            description: "Rules on whether an expense is reimbursable under company policy.",
            instructions: Instructions,
            tools: [AIFunctionFactory.Create(new ExpensePolicyTools(store).GetLimitAsync)]);
}
```

Two details matter for downstream reuse. The `name` becomes the tool name when this agent is later exposed as a function, so give it something a model can reason about. The `description` is what a calling agent reads to decide *when* to delegate, so write it for the caller, not for your changelog.

Because the factory only depends on `IChatClient`, the calling app picks the provider:

```csharp
// OpenAI or Azure OpenAI:
IChatClient chat = new OpenAIClient(key).GetChatClient("gpt-4o-mini").AsIChatClient();

// Anthropic, same agent code, different model id:
// IChatClient chat = anthropicClient.AsIChatClient("claude-sonnet-4-6");

AIAgent expert = ExpenseComplianceSkill.Create(chat, policyStore);
Console.WriteLine(await expert.RunAsync("Can I expense a 90 dollar dinner in Berlin?"));
```

## Reuse it in-process with AsAIFunction

The cheapest reuse is inside the same process. A broader "expense assistant" agent should not re-learn the policy rules -- it should delegate policy questions to the expert you already packaged. The Agent Framework turns any `AIAgent` into a callable tool with `.AsAIFunction()`, so the outer agent treats the expert exactly like a function tool.

```csharp
// Microsoft Agent Framework 1.0, .NET 11
AIAgent complianceExpert = ExpenseComplianceSkill.Create(chat, policyStore);

AIAgent assistant = chat.CreateAIAgent(
    instructions: """
        Help employees file expense reports. Collect the line items,
        then delegate every policy or reimbursement question to the
        ExpenseComplianceExpert tool. Do not rule on policy yourself.
        """,
    tools: [complianceExpert.AsAIFunction()]);

Console.WriteLine(await assistant.RunAsync(
    "I paid 410 dollars for a hotel in Zurich and a 60 dollar taxi. What is covered?"));
```

The assistant now has one tool: the expert. When a policy question comes up, the outer model calls it, the inner agent runs its own tool-calling loop (checking the live limit), and the answer flows back up. You get reusability, a clean separation of concerns, and dynamic delegation -- the reasoning agent decides when the specialist is needed. It is the same composition the docs call "using an agent as a function tool," and it nests: the compliance expert could itself delegate to a currency-conversion agent the same way.

## Advertise it across boundaries as an A2A AgentSkill

In-process reuse only helps callers written in .NET who share your assembly. To let a Python router, a Go orchestrator, or another team's service discover and call this expert, host it over the Agent-to-Agent protocol. A2A is the "agent to agent" half of the picture explored in [A2A vs MCP](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/): MCP exposes tools to an agent, A2A exposes a whole agent to other agents, described by an `AgentCard`.

The hosting lives in two prerelease packages:

```bash
# Microsoft Agent Framework A2A hosting, prerelease as of July 2026
dotnet add package Microsoft.Agents.AI.Hosting.A2A.AspNetCore --prerelease
```

Register the packaged skill as a named agent in DI, then map it. The hosting builder exposes a factory overload so the agent can pull its `IChatClient` and its policy store straight from the container:

```csharp
// Microsoft Agent Framework 1.0, .NET 11, A2A hosting prerelease
using A2A;
using A2A.AspNetCore;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting;
using Microsoft.Extensions.AI;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<IPolicyStore, SqlPolicyStore>();
builder.Services.AddSingleton<IChatClient>(sp => /* your connector */);

// Register the packaged skill as a named agent.
var expert = builder.AddAIAgent(
    name: "expense-compliance",
    (sp, _) => ExpenseComplianceSkill.Create(
        sp.GetRequiredService<IChatClient>(),
        sp.GetRequiredService<IPolicyStore>()));

var app = builder.Build();

// Expose it over A2A and describe its capability as an AgentSkill.
app.MapA2A(expert, path: "/a2a/expense-compliance", agentCard: new()
{
    Name = "Expense Compliance Expert",
    Description = "Rules on whether an expense is reimbursable under company policy.",
    Version = "1.2.0",
    DefaultInputModes = ["text"],
    DefaultOutputModes = ["text"],
    Capabilities = new AgentCapabilities { Streaming = true },
    Skills =
    [
        new AgentSkill
        {
            Id = "check_reimbursable",
            Name = "Check reimbursable",
            Description = "Decide if a claimed expense is reimbursable and whether it needs manager approval.",
            Tags = ["expenses", "policy", "compliance", "finance"],
            Examples =
            [
                "Can I expense a 90 dollar dinner in Berlin?",
                "Is a 400 dollar hotel night within policy?"
            ]
        }
    ]
});

app.Run();
```

That `AgentSkill` is the payoff. From the `A2A` namespace, its shape is fixed: `Id`, `Name`, `Description`, and `Tags` are required (`Tags` is a `List<string>`), while `Examples`, `InputModes`, and `OutputModes` are optional. The A2A hosting serves the card at the mapped path -- a `GET` to `/a2a/expense-compliance/v1/card` returns the JSON, and messages go to `/a2a/expense-compliance/v1/message:stream`. Any A2A-compliant client can now read the card, see a skill tagged `expenses` and `policy` with two worked examples, and decide to route a reimbursement question here.

One card can advertise several skills. If the same expert also validates receipts, add a second `AgentSkill` with its own `Id` and `Tags` rather than standing up a second endpoint. Skills are descriptions of what the one agent can do, not separate deployments.

## Let other agents discover and call the skill

On the consuming side, the flow mirrors the in-process case, just over HTTP. A client resolves the card from its URL, wraps the remote agent through the Agent Framework's A2A provider, and gets back an ordinary `AIAgent`. From there it is the same `.AsAIFunction()` call from earlier, so a local router agent can treat a remote skill exactly like a local one:

```csharp
// Consume a remote A2A skill and hand it to a local router agent.
// The A2A provider resolves the card and returns an AIAgent.
AIAgent remoteExpert = /* A2A provider wraps https://finance.internal/a2a/expense-compliance */;

AIAgent router = chat.CreateAIAgent(
    instructions: "Route finance questions to the expense compliance expert.",
    tools: [remoteExpert.AsAIFunction()]);
```

Because the card carries the skill's `Description`, `Tags`, and `Examples`, a router can pick the right remote agent from a directory of cards before it ever sends a message. That is the discovery story A2A is built for, and it is why the metadata is worth filling in properly.

## Versioning, tags, and the gotchas that bite

**The card is a claim, not a guard rail.** The `Skills` list advertises what the agent says it can do. It does not restrict what the agent actually does at runtime. Enforcement still lives in the instructions and in tool gating -- if a skill must never fire an irreversible action unsupervised, wrap that tool with the approval pattern from [human-in-the-loop tool approval](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/), not in a hopeful sentence on the card.

**Tags and examples are the discovery surface, so do not leave them empty.** A router agent (or a human browsing a registry) matches on `Tags` and reads `Examples` to decide whether a skill fits. An `AgentSkill` with an empty `Tags` list is technically valid and practically invisible. Write tags the way you would write search keywords.

**Version the card when the behavior changes.** `Version` is a plain string on the `AgentCard`. Bump it whenever you change the instructions or the tool set so consumers can pin a known-good contract and notice when the expert's behavior shifts under them.

**Keep the tool set tight.** Every tool the packaged agent carries spends tokens describing itself and adds a branch the inner model can get wrong. The same "a dozen sharp tools beat thirty overlapping ones" rule from the [function-tool walkthrough](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/) applies doubly here, because a bloated specialist is a bloated tool for every agent that delegates to it.

**Watch the DI lifetime.** If `IPolicyStore` is a scoped `DbContext` and you register the agent as a singleton, you have captured a scoped dependency in a long-lived object. Build the agent per scope, or resolve `IServiceScopeFactory` and open a scope inside the tool. It is the identical trap as [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

**One skill, two protocols.** Because `.AsAIFunction()` turns the agent into a plain `AIFunction`, the same packaged expertise can also be surfaced as an MCP tool if your consumers speak MCP instead of A2A. Pick the protocol per audience; the expert underneath stays one factory. If you are weighing that choice, the trade-offs are laid out in [migrating a Semantic Kernel plugin to an MCP server](/2026/05/migrate-a-semantic-kernel-plugin-to-an-mcp-server/).

The shape to remember is small: instructions plus tools make an agent, `.AsAIFunction()` makes that agent reusable in-process, and an `AgentSkill` on an `AgentCard` makes it discoverable everywhere else. Write the expertise once, describe it well, and let the routing agents find it.

Sources:

- [A2A Integration -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a)
- [Tools overview: using an agent as a function tool -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/tools/)
- [A2A Agent provider -- Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/agents/providers/agent-to-agent)
- [A2A .NET SDK: AgentCard and AgentSkill -- a2aproject/a2a-dotnet](https://github.com/a2aproject/a2a-dotnet)
- [Microsoft Agent Framework version 1.0 -- DevBlogs](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/)
