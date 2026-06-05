---
title: "Microsoft Agent Framework vs LangChain vs LlamaIndex in 2026"
description: "All three hit 1.0. Pick Microsoft Agent Framework if you live in Azure and .NET, LangChain/LangGraph for vendor-neutral graph orchestration, LlamaIndex for retrieval-grounded agents."
pubDate: 2026-06-05
template: vs
tags:
  - "comparison"
  - "ai-agents"
  - "microsoft-agent-framework"
  - "langchain"
  - "llamaindex"
  - "llm"
  - "mcp"
---

All three of the frameworks people argue about reached 1.0 in the last year, so the "it's all moving too fast to commit" excuse is gone. If you are starting a new agent project today and want the short version: pick **Microsoft Agent Framework** (1.0, April 3, 2026) if your shop is already on Azure and .NET, pick **LangChain 1.0 / LangGraph 1.0** (October 22, 2025) if you want vendor-neutral graph orchestration in Python or TypeScript, and pick **LlamaIndex Workflows 1.0** (June 30, 2025) if the agent is mostly retrieval over your own documents. The rest of this post is why those three sentences are the right call, and where each one breaks down.

The trap with these comparisons is that every framework now claims the same feature list: multi-agent orchestration, tool calling, human-in-the-loop, durable state, MCP support, observability. On paper they converge. The real decision is made by language, hosting, and what the agent actually spends its time doing, so that is what the table below sorts on.

## The feature matrix that actually decides it

| Dimension | Microsoft Agent Framework 1.0 | LangChain 1.0 / LangGraph 1.0 | LlamaIndex Workflows 1.0 |
| --- | --- | --- | --- |
| First release | April 3, 2026 | October 22, 2025 | June 30, 2025 |
| Primary languages | C# (.NET 10), Python, Java | Python, JavaScript/TypeScript | Python, TypeScript |
| Core abstraction | `AIAgent` over `IChatClient` | `create_agent` over LangGraph runtime | event-driven `Workflow` + `@step` |
| Multi-agent model | sequential, concurrent, handoff, group chat, Magentic-One | explicit state graph (nodes/edges) | `AgentWorkflow` orchestrator over agents |
| Durable state | checkpoint/restart middleware | LangGraph checkpointer (built in) | typed workflow state + checkpointing |
| Provider neutrality | any `IChatClient` connector | any model via `provider:model` string | any LLM integration package |
| Native ecosystem | Azure AI Foundry, Entra ID, M365 | LangSmith, LangGraph Platform | LlamaCloud, LlamaParse |
| MCP support | yes (client + A2A) | yes | yes |
| Best fit | Azure/.NET enterprise | complex stateful orchestration | retrieval-grounded agents |

Read that table top to bottom and the "winner" question mostly answers itself on row two. If your team writes C#, LangChain and LlamaIndex are not options, they are Python libraries with no .NET port. If your team writes Python and has no Azure mandate, Microsoft Agent Framework is the underdog and you are choosing between LangChain and LlamaIndex on the orchestration-versus-retrieval axis.

## What "a minimal agent" looks like in each

The fastest way to feel the difference is to write the same trivial agent in all three. Here is Microsoft Agent Framework, where the whole framework is built on the `IChatClient` abstraction from `Microsoft.Extensions.AI`:

```csharp
// Microsoft Agent Framework 1.0, .NET 10, Microsoft.Agents.AI
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

The thing to notice is `AsIChatClient()`. Every provider connector implements the same interface, so swapping OpenAI for Azure OpenAI, Anthropic, Bedrock, Gemini, or Ollama is a one-line change and nothing downstream moves. That single abstraction is the same one behind [adding tool calling to a Microsoft.Extensions.AI chat client](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/), which means the agent layer and the raw chat layer share a type system.

LangChain 1.0 collapsed its sprawling pre-1.0 API into a single `create_agent` entry point built on the LangGraph runtime:

```python
# LangChain 1.0 (released 2025-10-22), Python
from langchain.agents import create_agent
from langchain.tools import tool

@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"

agent = create_agent(
    "openai:gpt-5.4",
    tools=[search],
    system_prompt="You are a helpful assistant. Be concise and accurate.",
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "Find the retry policy docs."}]}
)
```

The `"openai:gpt-5.4"` provider string is LangChain's neutrality story: change the prefix to `anthropic:` or `google_genai:` and the rest holds. Underneath, `create_agent` is a compiled LangGraph state machine, which is why you get the checkpointer, durable execution, and human-in-the-loop for free the moment you need them.

LlamaIndex took the opposite design stance. Instead of one `create_agent` call, it exposes an event-driven workflow where you define steps and the events that flow between them:

```python
# LlamaIndex Workflows 1.0 (released 2025-06-30), Python
from llama_index.core.agent.workflow import FunctionAgent, AgentWorkflow
from llama_index.llms.openai import OpenAI

def search(query: str) -> str:
    """Search internal documents."""
    return f"Results for: {query}"

agent = FunctionAgent(
    tools=[search],
    llm=OpenAI(model="gpt-4o-mini"),
    system_prompt="Answer questions using the search tool.",
)

workflow = AgentWorkflow(agents=[agent], root_agent=agent.name)
response = await workflow.run(user_msg="Find the retry policy docs.")
```

`FunctionAgent` is the single-agent case; `AgentWorkflow` is the orchestrator that coordinates several agents and lets them hand off to each other. The event-driven core (`@step` methods that emit and consume typed `Event` objects) is what you drop down to when the high-level agent abstraction is not expressive enough.

## When to pick Microsoft Agent Framework

- **You write C#.** This is the only one of the three with a first-class .NET 10 SDK. If your codebase is C#, the choice is over before it starts. Agent Framework unified Semantic Kernel and AutoGen, so the [1.0 release of Microsoft Agent Framework in pure C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) is also the migration target for both predecessors.
- **You are Azure-native.** The differentiator is not the orchestration model, it is the integration depth: Azure AI Foundry for hosting, Entra ID for identity, Azure Monitor for telemetry, M365 surfaces. When you commit to Agent Framework you inherit that stack instead of wiring it yourself.
- **You need durable, resumable agents in production.** The framework ships checkpoint/restart as middleware, covered in [durable agent workflows with checkpoint and restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/), so a long-running agent survives a process recycle without bespoke persistence code.
- **You want approval gates baked in.** Tool execution can be paused for a human to approve, the pattern in [human-in-the-loop tool approval in C#](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/).

Where it breaks down: outside the Microsoft ecosystem, the gravity disappears. If you are not on Azure and not on .NET, you are adopting the youngest framework of the three (it shipped in April 2026) to get capabilities LangGraph has shipped and hardened since 2025.

## When to pick LangChain / LangGraph

- **You want maximum model and vendor optionality.** LangChain locks you into nothing. The `provider:model` string and the standard content-block spec mean you can move between OpenAI, Anthropic, and Gemini, including reasoning traces and citations, without rewriting your agent.
- **Your orchestration is genuinely complex.** LangGraph models agents as explicit state machines: sub-graphs inside graphs, parallel branches that merge, dynamic routing on intermediate results, fine-grained checkpoints. When the control flow is the hard part, explicit beats conversational.
- **You are deploying at scale and want a managed runtime.** Around 400 companies run on LangGraph Platform, and LangChain reports roughly 90M monthly downloads with production deployments at Uber, JPMorgan, BlackRock, LinkedIn, and Klarna. The operational story (LangSmith tracing, LangGraph Platform) is the most mature of the three.
- **You are in Python or TypeScript.** Full parity across both languages, which matters if your backend is Node.

Where it breaks down: the explicitness is a tax on simple agents. If your "agent" is a tool-calling loop over a document store, the graph machinery is overhead you pay for capability you do not use. The pre-1.0 reputation for churn also lingers; 1.0 promises no breaking changes until 2.0, but teams that got burned earlier are cautious.

## When to pick LlamaIndex

- **The agent is mostly retrieval over your own data.** This is LlamaIndex's home turf. Teams building retrieval-grounded agents get to production faster here because indexing, chunking, and querying are the framework's reason for existing, not a bolt-on. If your agent's main job is answering from a corpus, this is the shortest path.
- **You want a lightweight, event-driven core.** Workflows 1.0 is deliberately small. You compose `@step` functions connected by typed events, with resource injection for database clients and OpenTelemetry instrumentation when you need observability.
- **You value a predictable upgrade path.** LlamaIndex Workflows has lower churn and clearer versioning than LangGraph historically did, and the standalone `llama-index-workflows` package is re-exported through the old import paths so existing code keeps working.
- **You are in Python or TypeScript.** Same dual-language support as LangChain, via `pip install llama-index-workflows` or `npm i @llamaindex/workflow-core`.

Where it breaks down: it is the youngest at general-purpose multi-agent orchestration. If your system is a dozen agents with intricate handoffs and conditional routing rather than retrieval, you will find yourself rebuilding what LangGraph gives you out of the box.

## The gotcha that picks for you

Three forcing functions override every preference:

**Language is non-negotiable.** There is no C# LangChain and no C# LlamaIndex. If your team ships .NET, Microsoft Agent Framework is not "the recommended option," it is the only option, the same way [choosing a coding agent for a .NET 11 repo](/2026/06/claude-code-vs-cursor-vs-aider-for-a-dotnet-11-repo/) is constrained by what actually integrates with your toolchain.

**Hosting mandate is non-negotiable.** If your org has standardized on Azure AI Foundry and Entra ID, fighting that with a vendor-neutral framework means rebuilding identity, telemetry, and deployment by hand. The integration depth is the whole point of Agent Framework; throwing it away to use LangGraph on Azure is choosing the harder path twice.

**The workload shape decides the Python fight.** Between LangChain and LlamaIndex, ask one question: is the hard part the *orchestration* or the *retrieval*? Complex branching, multi-agent handoffs, and stateful control flow point to LangGraph. Grounding answers in a private corpus points to LlamaIndex. Most teams discover they are clearly one or the other within the first sprint.

One thing none of these frameworks lets you skip: tool design. Whichever you pick, your agent is only as good as the tools you expose to it, and the protocol you expose them over. All three support MCP, so the cross-cutting decision of [MCP versus OpenAPI plugins versus custom tool calling](/2026/06/mcp-vs-openapi-plugins-vs-custom-tool-calling-for-ai-agents/) applies no matter which framework wins the orchestration debate.

## The recommendation, restated with the full picture

Default to **Microsoft Agent Framework** if you are a C#/.NET shop or you live in Azure: it is 1.0, it unifies the two Microsoft frameworks you were already weighing, and the ecosystem integration is unmatched if you are inside it. Default to **LangChain/LangGraph** for vendor-neutral Python or TypeScript work where orchestration complexity is the hard problem and you want the most battle-tested production runtime. Default to **LlamaIndex** when the agent is fundamentally a retrieval engine with a tool-calling loop on top, and you want a small, predictable, event-driven framework rather than a large one.

The frameworks have converged on features; they have not converged on language, hosting, or workload. Sort on those three and the decision is sharper than any feature matrix makes it look.

## Sources

- [Microsoft Agent Framework 1.0 announcement](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/), Microsoft DevBlogs, April 3, 2026.
- [LangChain and LangGraph reach v1.0](https://www.langchain.com/blog/langchain-langgraph-1dot0), LangChain blog, October 22, 2025.
- [LangChain agents documentation (`create_agent`)](https://docs.langchain.com/oss/python/langchain/agents), Docs by LangChain.
- [Announcing Workflows 1.0](https://www.llamaindex.ai/blog/announcing-workflows-1-0-a-lightweight-framework-for-agentic-systems), LlamaIndex blog, June 30, 2025.
- [FunctionAgent / AgentWorkflow basics](https://developers.llamaindex.ai/python/examples/agent/agent_workflow_basic/), LlamaIndex developer docs.
