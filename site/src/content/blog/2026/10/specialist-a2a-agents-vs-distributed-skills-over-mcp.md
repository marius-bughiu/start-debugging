---
title: "Specialist A2A Agents vs Distributed Skills over MCP: When to Collapse an Agent into a Skill"
description: "If a specialist agent is just a model loop wrapped around a few read-only calls into your own services, collapse it into a skill served over MCP: a SKILL.md plus typed tools that the parent model calls directly. Keep it an A2A agent when it needs its own model, private context, a long multi-step workflow or an independent lifecycle. Here is the decision matrix, the measured cost of each path, and the Agent Framework 1.17 wiring."
pubDate: 2026-10-29
template: vs
tags:
  - "ai-agents"
  - "mcp"
  - "agent-skills"
  - "microsoft-agent-framework"
  - "a2a"
  - "comparison"
---

**Short answer:** collapse a specialist A2A agent into a skill over MCP when it is a model loop wrapped around bounded, mostly read-only operations that your parent agent could pick itself. Publish a `SKILL.md` and typed MCP tools from the same service, and let the parent's model call the tools directly. Keep the specialist as an A2A agent when it needs its own model, private context it should not hand over, a long multi-step workflow, or a release cycle owned by another team. In Microsoft's own ski-resort demo (Agent Framework Python `agent-framework-core==1.17.0`, `ModelContextProtocol.AspNetCore` 1.2.0, model `gpt41`), the collapse halved model calls (6-7 down to 3) and cut mean latency from 15.5 s to 6.3 s, but used about 22% more tokens. Faster is not the same as cheaper.

This question got concrete on September 16, 2026, when the Agent Framework team published [From Specialist Agents to Distributed Skills over MCP](https://devblogs.microsoft.com/agent-framework/from-specialist-agents-to-distributed-skills-over-mcp/) by Tommaso Stocchi. It takes a typical multi-agent setup, an advisor that calls four specialist agents over A2A, and rewrites it so each specialist service becomes an MCP skill provider instead. The [demo repository](https://github.com/tommasodotNET/ski-resort-demo) keeps both versions side by side at commit `56f453a`, which makes it the cleanest before/after I have seen for this decision. Everything below is pinned to that commit.

## The two shapes, on one domain

The domain is lift traffic at a ski resort. The data comes from a `LiftDataService` that calls an internal HTTP endpoint. What changes is who reasons about it.

**Specialist A2A agent.** The lift-traffic service hosts its own `ChatClientAgent` on `gpt41`, gives it the lift tools, and exposes it with an Agent Card over A2A. The advisor resolves the card and turns the remote agent into a function tool:

```csharp
// Advisor side, Microsoft.Agents.AI + A2A .NET SDK (ski-resort-demo @ 56f453a)
var resolver = new A2ACardResolver(httpClient.BaseAddress!, httpClient,
    agentCardPath: "/.well-known/agent-card.json");
var agentCard = await resolver.GetAgentCardAsync();
AIAgent liftAgent = agentCard.AsAIAgent(httpClient);

var advisor = projectClient.AsAIAgent(
    model: deploymentName,
    instructions: "...You have access to four specialist agents as tools...",
    tools: [liftAgent.AsAIFunction(), weatherAgent.AsAIFunction() /* ... */]);
```

When the user asks "where should I start, considering weather and wait times?", the advisor's model calls `liftAgent` with a natural-language task. The lift agent's model then decides which lift tools to call, calls them, and writes a prose answer. The advisor's model reads that prose and writes its own answer. Two reasoning loops per specialist touched.

**Distributed skill over MCP.** The same service hosts an MCP endpoint instead. It publishes two resources (a discovery index and a `SKILL.md`) and the operations as typed tools:

```csharp
// Provider side, ModelContextProtocol.AspNetCore 1.2.0, net10.0 (ski-resort-demo @ 56f453a)
builder.Services.AddSingleton<LiftDataService>();
builder.Services.AddMcpServer(o => o.ServerInfo = new() { Name = "lifttrafficskills", Version = "1.0.0" })
    .WithHttpTransport()
    .WithResources<LiftTrafficSkillResources>()   // skill://index.json + skill://lift-traffic/SKILL.md
    .WithTools<LiftTrafficTools>();                // typed, read-only operations

var app = builder.Build();
app.MapMcp("/skillsmcp");
```

```csharp
[McpServerToolType]
public sealed class LiftTrafficTools(LiftDataService service)
{
    [McpServerTool(Name = "lift_traffic_least_busy_area", ReadOnly = true,
                   Destructive = false, UseStructuredContent = true)]
    [Description("Recommend the open lift with the shortest wait, or report that no lifts are open.")]
    public async Task<LeastBusyArea> LeastBusyArea(CancellationToken ct) =>
        Read<LeastBusyArea>(await service.SuggestLessBusyAreaAsync(ct));
    // ...lift_traffic_lifts, lift_traffic_lift_status, lift_traffic_wait_times
}
```

There is no model in this service anymore. The advisor's model reads the skill description, loads the skill when it is relevant, and then calls `lift_traffic_least_busy_area` itself. One reasoning loop total.

The detail that makes the demo honest: in the A2A version, the specialist's tool class is the same code. The A2A project's `LiftTrafficTools` carries both `AIFunction` registrations for its own agent and `[McpServerTool]` attributes, with a comment noting there is "exactly one implementation per capability; only the hosting surface differs." In other words, the specialist agent was a `gpt41` call sitting between the advisor and four functions. That is the pattern to look for in your own system.

## The decision matrix

| Question | Specialist A2A agent | Skill over MCP |
| --- | --- | --- |
| Who picks the operations? | The specialist's model | The parent's model |
| Model calls per specialist touched | 2+ (specialist loop + parent reads its prose) | 0 extra (parent calls tools directly) |
| What crosses the wire | Natural-language task in, artifact/prose out | Typed tool arguments in, structured content out |
| Parent sees intermediate data | No, only the specialist's summary | Yes, raw tool results land in the parent's context |
| Specialist can use a different model | Yes | No, the parent's model does the reasoning |
| Private context / prompts stay with the owner | Yes, opaque by design | No, `SKILL.md` instructions are read by the caller |
| Long, multi-step or long-running workflows | Natural fit (A2A tasks, streaming, push) | Awkward; each step is a parent turn |
| Independent deploy and versioning | Agent Card + endpoint | MCP server + skill index; tool schemas are the contract |
| Initial parent context | Small (one function per agent) | Skill summaries only, then full tool schemas after `load_skill` |
| Debugging | Two transcripts to correlate | One transcript, one trace |
| Spec maturity (October 2026) | A2A 1.0 | MCP tools/resources stable; skill discovery is a draft SEP |

The [A2A vs MCP comparison](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/) I wrote in July framed the axis as "structured tool vs opaque agent." This post is the follow-up question: once you have a fleet of opaque agents, which of them should never have been opaque?

## When to collapse the agent into a skill

Collapse it when all of the following are true:

- **The competence is bounded.** It is a handful of operations on one domain: "read lift status", "get forecast", "check slope closures". The Microsoft sample has 4 skills and 12 tools in total.
- **The operations are application logic, not reasoning.** If the specialist's prompt is mostly "call the right function and summarize", the specialist's model adds a hop, not judgment. The advisor's model can read a tool description as well as the specialist's model can.
- **The parent can interpret the results.** Structured output like `{ "liftId": "lift-3", "waitTimeMinutes": 2.5 }` is easier for the parent to combine with weather data than a paragraph that already rounded and editorialized it.
- **Latency matters more than marginal tokens.** Every removed loop is a removed round trip to the model, and model round trips dominate wall-clock time in these systems.

A good smell test: open the specialist's transcript for ten real requests. If it calls one or two tools and paraphrases the JSON every time, it is a skill wearing an agent costume.

## When to keep it an A2A agent

Keep the agent when any of these hold:

- **It needs its own model.** A specialist fine-tuned on your claims data, or a cheap small model that should handle a high-volume classification step, cannot be collapsed into a parent running a different model.
- **Its context is private.** A2A's opacity is a feature across trust boundaries. Another team, or another company, may not want to hand you its prompts and raw data. A skill's `SKILL.md` is instructions *for your model*, so whoever loads it reads it.
- **It runs a substantial multi-step workflow.** A research agent that searches, reads ten pages and reconciles them would flood the parent's context with every intermediate result if you flattened it. That is exactly the case where a separate context window earns its cost, the same argument as in [nested subagent depth](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/). The ski demo keeps its web-research agent as an agent tool in both versions for this reason.
- **It has an independent lifecycle.** If the specialist is long-running, resumable or owned and versioned by another team on its own schedule, A2A's task model and Agent Card are the right contract.

One trap the Microsoft post calls out explicitly: wrapping an existing agent in an MCP tool without removing its internal model loop is only a transport change. You still pay for two reasoning loops, you just moved them behind `tools/call`. The collapse means deleting the specialist's model, not re-exposing it.

## What the numbers actually say

The article ran three paired requests, fresh conversations, same processes, `gpt41`, prompt "considering weather and waiting time, where should i start?":

| Pair | Path | Elapsed | Input tokens | Output tokens | Total | Model calls |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A2A | 16.416 s | 2,971 | 578 | 3,549 | 6 |
| 1 | Skills over MCP | 8.661 s | 4,341 | 178 | 4,519 | 3 |
| 2 | Skills over MCP | 5.866 s | 4,337 | 165 | 4,502 | 3 |
| 2 | A2A | 12.835 s | 2,974 | 580 | 3,554 | 6 |
| 3 | A2A | 17.188 s | 3,394 | 637 | 4,031 | 7 |
| 3 | Skills over MCP | 4.517 s | 4,341 | 171 | 4,512 | 3 |

Mean elapsed: 15.480 s for A2A, 6.348 s for skills. Total tokens across the three runs: 11,134 for A2A, 13,533 for skills.

Read the token columns carefully, because they explain the trade:

- **Output tokens drop by roughly 70%** (about 580 to about 170). Each specialist wrote a prose answer that the advisor then rewrote. With skills, only the final answer is generated.
- **Input tokens rise by roughly 40%** (about 3,000 to about 4,340). After `load_skill`, the full `SKILL.md` and every tool schema from that provider sit in the parent's context, and raw JSON results come back instead of summaries.
- **Model calls halve.** That, more than tokens, is where the 9 seconds went.

Whether this is cheaper for you depends on your price ratio. On most current models output tokens cost 4-5x input, so trading ~400 output tokens for ~1,300 input tokens can come out close to even or slightly ahead, and prompt caching of the stable `SKILL.md` and schemas tilts it further. The article recorded 6,144 cached input tokens on the skills path but could not collect complete cache data for A2A, so do not read the raw totals as a billing ratio. The authors say as much: three runs, live data that changed between requests, and A2A doing slightly more work (more lift-traffic calls) in some pairs. Treat it as a direction, then measure your own.

Also notice pair 1: the advisor's top-level usage on the A2A path was 1,751 tokens, and the total only reached 3,549 once the specialists' own calls were added. If your dashboards only meter the orchestrator, your A2A setup looks about half as expensive as it is.

## Wiring the parent: progressive disclosure, then direct calls

On the consuming side, the demo's Python advisor uses `SkillsProvider` fed by an `MCPSkillsSource` per provider session. The model starts each turn seeing only skill names and descriptions plus a `load_skill` helper:

```python
# agent-framework>=1.17.0, mcp>=1.24.0 (ski-resort-demo @ 56f453a)
from agent_framework import (SkillsProvider, MCPSkillsSource,
                             CachingSkillsSource, AggregatingSkillsSource)

sources = [CachingSkillsSource(MCPSkillsSource(client=session)) for session in sessions]
skills_provider = SkillsProvider(
    AggregatingSkillsSource(sources),
    disable_load_skill_approval=True,
    disable_read_skill_resource_approval=True,
)
agent = chat_client.as_agent(
    instructions=INSTRUCTIONS,
    context_providers=[skills_provider],
    middleware=[skill_tools],   # binds a successful load_skill to that provider's tools
)
await skill_tools.initialize(agent, exit_stack)  # opens one MCPStreamableHTTPTool per provider
```

The interesting part is `skill_tools`, a `FunctionMiddleware` that runs after `load_skill`. When the load succeeds it calls the experimental `context.add_tools(...)` with that provider's MCP tools, so they become callable on the next model iteration:

```python
# Inside SkillToolsMiddleware.process, agent-framework 1.17.0
await call_next()
if context.function.name != "load_skill":
    return
skill, native = self.catalogs.get(context.arguments["skill_name"].lower())
# 1.17 returns raw SKILL.md text, not a typed success result,
# so compare against the cached content to detect a real load.
if context.result[0].text == await skill.get_content():
    context.add_tools(native.functions)
```

Two things are worth copying from this design. First, the `SKILL.md` itself says "loading is progressive disclosure, not authorization": loading a skill only makes tools visible, and approvals and auth stay in code. Second, the approvals are disabled on purpose, because in 1.17 an approval pause starts a new function loop and drops the `add_tools` registrations. If you need human approval on these tools, you will hit that.

The middleware is optional. With a small catalog (a dozen tools), the article notes you can register every MCP tool up front and skip progressive disclosure entirely. The middleware pays off when you have many providers and do not want every schema in every turn, which is the same pressure described in [reducing how many MCP tools an agent loads](/2026/05/how-to-reduce-the-number-of-mcp-tools-claude-loads/).

If your parent is .NET rather than Python, the client side is `UseMcpSkills` from `Microsoft.Agents.AI.Mcp`. I walked through that wiring, and the archive-skill limits that silently drop content, in [serving agent skills from an MCP server in .NET](/2026/08/serve-agent-skills-from-an-mcp-server-in-dotnet-with-usemcpskills/). The two halves are independent: the demo's providers are .NET and its skills advisor is Python.

## Gotchas before you migrate

**Skill discovery is not core MCP yet.** The `skill://index.json` resource follows a pinned, older draft of SEP-2640. The September 3, 2026 revision of that proposal moves to dedicated `skills/list` and `skills/get` methods, and its PR was still open when the article was written. The demo does not implement those methods. Plan for one more change on the discovery side; tools and resources themselves are stable.

**The Agent Card description becomes the skill description.** Routing used to live in the Agent Card. After the move it lives in the `description` of the skill index entry, which is what the parent's model sees before loading anything. Port it deliberately; a vague description means the skill never gets loaded.

**Group operations per provider, not per tool.** Loading a skill exposes all of that provider's tool schemas. One skill per provider, with related operations together, keeps the unused-schema cost down. Splitting one domain across five tiny skills multiplies load calls instead.

**Keep state and permissions in code.** Pagination cursors, authorization and file lifecycle belong in tool handlers, not in `SKILL.md` prose. The parent's model now calls your service directly, so input validation in the handler is the only gate. The demo's tools mark themselves `ReadOnly = true, Destructive = false` and validate arguments (`MinLength(1)`, `ThrowIfNullOrWhiteSpace`). If you are designing a larger surface, the [MCP server design notes for a big internal API](/2026/08/mcp-server-design-for-a-large-internal-api-surface/) apply.

**Migrate one read-only domain first.** Keep the A2A path deployed behind a flag, run the same prompts through both, and compare model calls, latency and total tokens, including the specialists' own usage. The article's recommendation and mine agree: start with the most boring, read-oriented specialist.

## The recommendation, restated

Default to skills over MCP for specialists that are thin model loops around your own read-mostly services. You get one reasoning loop, typed results, one trace and roughly half the model round trips. Keep A2A for specialists that bring something the parent cannot: a different model, private context, a long workflow or an independent owner. Most real systems end up with both, a coordinator holding a few skills and calling one or two genuine agents. The same split shows up in coding agents too, as the [skills vs subagents vs MCP servers breakdown](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/) for Claude Code argues.

## Related

- [A2A vs MCP: agent-to-agent vs agent-to-tool](/2026/07/a2a-protocol-vs-mcp-agent-to-agent-vs-agent-to-tool/)
- [How to serve agent skills from an MCP server in .NET with UseMcpSkills](/2026/08/serve-agent-skills-from-an-mcp-server-in-dotnet-with-usemcpskills/)
- [Packaging domain expertise as an agent skill in Microsoft Agent Framework](/2026/07/package-domain-expertise-as-an-agent-skill-microsoft-agent-framework/)
- [Nested subagent depth: when it helps and when it burns tokens](/2026/09/nested-subagent-depth-when-it-helps-and-when-it-burns-tokens/)
- [Claude Code skills vs subagents vs MCP servers](/2026/07/claude-code-skills-vs-subagents-vs-mcp-servers-when-to-build-each/)

## Sources

- [From Specialist Agents to Distributed Skills over MCP](https://devblogs.microsoft.com/agent-framework/from-specialist-agents-to-distributed-skills-over-mcp/), Microsoft Agent Framework blog, September 16, 2026
- [tommasodotNET/ski-resort-demo at commit 56f453a](https://github.com/tommasodotNET/ski-resort-demo/commit/56f453a2c52de91ac71ef19da83caec4976f5a17)
- [Agent Skills in Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/agents/skills)
- [Agent Skills specification](https://agentskills.io/specification)
- [MCP specification 2025-11-25: resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
