---
title: "How to Deploy a Microsoft Agent Framework Agent to Foundry Hosted Agents"
description: "A step-by-step guide to taking a Microsoft Agent Framework agent from your laptop to a managed Foundry Hosted Agent: the C# host code, the azd deploy flow, identity, scaling, and the gotchas that bite in preview."
pubDate: 2026-06-23
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "azure-ai-foundry"
  - "dotnet"
  - "csharp"
---

You wrote an agent with the Microsoft Agent Framework, it runs on your laptop, and now you need a production home for it that does not involve hand-rolling a Dockerfile, a web server, autoscaling, secret rotation, and a tracing pipeline. That is exactly the gap **Foundry Hosted Agents** fills. You bring an `AIAgent`, wrap it in a few lines of hosting code, and `azd deploy` ships it as a container onto Microsoft-managed infrastructure with its own identity, scale-to-zero, session state, and OpenTelemetry traces already wired up.

This guide walks the full path on .NET, using the GA Agent Framework 1.0 runtime plus the `Microsoft.Agents.AI.Foundry.Hosting` package (preview as of June 2026). You need the **.NET 10 SDK**, **Azure Developer CLI (`azd`) 1.25.3 or later**, and the `microsoft.foundry` azd extension. Hosted agents themselves are in public preview and trending toward general availability in early July 2026, so expect command names to shift slightly under you.

## What "hosted" actually buys you

Before the code, it is worth being precise about what the platform takes off your plate, because it changes how you write the agent.

A Hosted Agent is your own container image, not a prompt-only definition you click together in the portal. You choose the framework, you control the runtime. When you deploy, Foundry Agent Service pulls the image from Azure Container Registry, provisions compute, assigns the agent its **own Microsoft Entra ID**, and exposes a dedicated endpoint. From there the platform owns the boring-but-critical parts:

- **Per-session isolation.** Every session runs in its own VM-isolated sandbox with a persistent `$HOME`. Sessions never see each other's files.
- **Scale to zero with stateful resume.** After 15 minutes of inactivity the compute is deprovisioned and the session state is persisted. The next request to that session ID provisions fresh compute and restores `$HOME` and any uploaded files, so the agent picks up where it left off. A session is permanently deleted only after 30 days idle.
- **Dedicated identity, no secrets in the image.** The agent authenticates with its own Entra ID for model calls, Toolbox tools, and downstream Azure services. You are explicitly told not to bake secrets into the image or environment variables.
- **Observability for free.** `APPLICATIONINSIGHTS_CONNECTION_STRING` is injected at runtime, and the protocol libraries emit OpenTelemetry by default, so traces land in Application Insights with zero extra wiring.
- **Immutable versions and traffic splitting.** Each deploy is a snapshot of image, resources, env vars, and protocol config. You can split traffic across versions for canary or blue/green rollouts and roll back instantly.

If you already shipped a [Microsoft Agent Framework 1.0 agent in pure C#](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/), none of that agent logic changes. Hosting is a thin layer you add around it.

## Choosing a protocol before you write a line

A Hosted Agent exposes one or more protocols, and this is the first real decision. There are two you will care about on day one:

- **Responses** is the OpenAI-compatible `/responses` endpoint. The platform manages conversation history, streaming events, and session lifecycle for you, and any OpenAI-compatible SDK can call it. This is the right default for chatbots, assistants, and multi-turn Q&A with tools.
- **Invocations** gives you full control of the HTTP request and response. Arbitrary JSON in, arbitrary JSON out, and you manage session state yourself. Reach for it when an external system dictates the payload (a GitHub or Stripe webhook), or when the work is not conversational at all (classification, extraction, batch).

There is also an **Invocations (WebSocket)** variant for real-time voice that is preview-only and, at the time of writing, available solely in North Central US. Start with Responses. A single agent can support both protocols simultaneously, so adding Invocations later is not a rewrite.

## The C# host: an agent in a dozen lines

Here is the minimal Responses host. Install the packages first:

```dotnetcli
# .NET 10 SDK, Agent Framework 1.0, Foundry hosting preview (June 2026)
dotnet add package Microsoft.Agents.AI.Foundry.Hosting --prerelease
dotnet add package Azure.AI.Projects --prerelease
```

Then the program itself:

```csharp
// Program.cs -- .NET 10, Microsoft.Agents.AI.Foundry.Hosting (preview)
using Azure.AI.AgentServer.Core;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;

var projectEndpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT is not set."));
var deployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME") ?? "gpt-4o";

AIAgent agent = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
    .AsAIAgent(
        model: deployment,
        instructions: "You are a helpful AI assistant.",
        name: "my-agent");

var builder = AgentHost.CreateBuilder(args);
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
```

Three things are doing the work here. `AgentHost.CreateBuilder(args)` returns an application host that is preconfigured for the Foundry hosting environment (health checks, telemetry, the lot). `AddFoundryResponses(agent)` registers your agent with the Responses protocol handler. `RegisterProtocol("responses", ...)` plus `MapFoundryResponses()` maps the `/responses` HTTP endpoint that the platform will route traffic to.

Notice what is *not* here. There is no connection string, no API key, no managed-identity configuration. `DefaultAzureCredential` resolves to the agent's injected Entra identity at runtime, and `FOUNDRY_PROJECT_ENDPOINT` plus `AZURE_AI_MODEL_DEPLOYMENT_NAME` are injected by the platform. Locally, you export them yourself.

The agent you pass to `AddFoundryResponses` is an ordinary `AIAgent`. Everything you already know about the framework still applies, including [function tools authored inline, as a method, or as a class](/2026/05/microsoft-agent-framework-function-tools-inline-method-class/) and [human-in-the-loop approval gates on risky tool calls](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/). The hosting layer does not constrain the agent's behavior, only how it is exposed and operated.

## Scaffold, run locally, then deploy

The fastest way to a working project is the `azd` agent commands. Install the extension and scaffold from a sample manifest:

```bash
# Azure Developer CLI 1.25.3+
azd ext install microsoft.foundry

mkdir my-hosted-agent && cd my-hosted-agent
azd ai agent init -m <path-or-url-to-agent.manifest.yaml> --deploy-mode code
```

The interactive flow asks for an agent name, a Foundry project (new or existing), tenant, subscription, region, and a model deployment. That produces an `azure.yaml` and the agent code in a new folder.

Before deploying, run it locally. The same `DefaultAzureCredential` works against your `az login` session, so export the two variables the platform would otherwise inject and start the host:

```bash
export FOUNDRY_PROJECT_ENDPOINT="https://<account>.services.ai.azure.com/api/projects/<project>"
export AZURE_AI_MODEL_DEPLOYMENT_NAME="gpt-4o"

azd ai agent run        # host starts on http://localhost:8088
```

Hit it the way a client would:

```bash
curl -X POST http://localhost:8088/responses \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello!"}'
```

Once it behaves locally, provision and deploy. Provisioning creates a resource group with a Foundry instance, project, model deployment, Application Insights, and a container registry. Deploying packages the agent as a container, pushes it to ACR, and hands it to Agent Service:

```bash
azd provision     # one-time: Foundry project, model, App Insights, ACR
azd deploy        # build image, push to ACR, deploy the version
```

When `azd deploy` finishes it prints the playground link and the version endpoint, something like `https://ai-account-<name>.services.ai.azure.com/api/projects/<project>/agents/<name>/versions/1`. The endpoint is live the moment deploy returns. Publishing is not required for programmatic access. You can smoke-test from the CLI:

```bash
azd ai agent invoke "Write a haiku about deploying cloud applications."
azd ai agent monitor --follow   # stream container logs
```

## How identity and config actually flow at runtime

This trips people up coming from Container Apps or AKS, where you wire managed identity and app settings yourself. On a Hosted Agent there are two identities, and you touch neither by hand:

- The **agent identity** is a dedicated Entra ID created at deploy time. It is what your container authenticates with -- model invocation, tool access, downstream Azure calls. `azd` assigns the required Foundry User role at account scope automatically.
- The **project managed identity** is system-assigned on the Foundry project and is used by the platform for infrastructure operations like pulling your image from ACR. It is not your agent's runtime identity.

For your own external resources, say an Azure Storage account or a SQL database, you assign RBAC manually to the *agent's* Entra ID. That is the whole point of the no-secrets model: grant the identity, never ship a key.

Configuration rides in on environment variables, which are immutable per version. The platform always injects three:

| Variable | Purpose |
| --- | --- |
| `FOUNDRY_PROJECT_ENDPOINT` | Endpoint URL for the Foundry project |
| `AZURE_AI_MODEL_DEPLOYMENT_NAME` | The model deployment name |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Application Insights connection string for telemetry |

Because the App Insights string is injected and the protocol libraries emit OpenTelemetry by default, your traces show up under Investigate > Transaction search in the linked Application Insights resource without you touching the telemetry pipeline. If you have wired durable, restartable agent state before, for example with [Agent Framework's Durable Task checkpointing](/2026/05/agent-framework-durable-workflows-checkpoint-restart/), note that for Responses agents the platform already persists conversation history and session `$HOME` for you, so you can often drop your own persistence layer.

## Adding tools the hosted way

Here is a real constraint that surprises people: **you cannot add tools directly to a hosted agent's definition.** There is no "attach this MCP server to the deployment" knob. Instead, Foundry provisions a **Toolbox MCP endpoint** in your project, and your agent code connects to it as a standard MCP client to reach Code Interpreter, Web Search, Azure AI Search, OpenAPI tools, custom MCP connections, and A2A.

In practice that means your tool wiring is ordinary MCP client code inside the agent, the same shape you would write if you were [building or consuming an MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/). The benefit is consolidated auth: the Toolbox handles OAuth identity passthrough, agent identity, and key-based auth across all those tools, instead of you juggling credentials per tool.

## Right-sizing, and the cost trap nobody warns you about

Sandbox sizes are deliberately small: 0.5 vCPU / 1 GiB, 1 vCPU / 2 GiB, or 2 vCPU / 4 GiB. The number you set describes **a single session**, not the aggregate footprint of the agent, because every session gets its own sandbox.

That is the trap. Billing is CPU plus memory across all *active* sessions, so oversizing multiplies your bill by your concurrency. Allocate 2 vCPU "to be safe" and run 40 concurrent sessions and you are paying for 80 vCPU. Size to a representative single session: run a real workload, open Application Insights, go to Investigate > Performance, and compare observed CPU and memory peaks against your allocation. If sustained peaks exceed roughly 70% of allocation, bump the next version up. If they sit well below, drop it. Every version is immutable, so retest after each change.

The default cap is **50 concurrent active sessions per subscription per region**, adjustable through a support request. Each session gets up to 20 GiB of disk at 1 vCPU or larger, with about 20% reserved for the system.

## Rolling out new versions without downtime

Because each `azd deploy` produces an immutable version, the upgrade story is built in. Deploy version 2, then split traffic, send 10% to the new version, watch the traces, and shift the rest once it is healthy. If something regresses, roll back to version 1 instantly. One subtlety worth knowing: if you redeploy with no actual change to the image, env vars, or protocol config, the platform does not mint a new version, so you will not accidentally pile up identical snapshots.

## Preview-era gotchas to plan around

A few rough edges as of June 2026:

- **Regions are limited.** Hosted agents are in roughly 20 regions including East US 2, North Central US, Sweden Central, and West US, but not everywhere. Check the list before you pick a project region.
- **ACR must stay public.** Private-network-secured Azure Container Registry is not yet supported for the agent image, even though the rest of the deployment supports VNet-isolated outbound traffic.
- **CLI names are in flux.** The agent extension is preview. If `azd ai agent init` fails, run `azd version` to confirm 1.25.3 or later and `azd ext upgrade` to pull the latest agent extension. Expect command and flag churn until GA.
- **Windows ARM64 local runs can fail to build native wheels** for the Python sample path. If you are on the .NET path this does not affect you, but mixed teams hit it.
- **Custom Invocations handlers do not get free state.** Only the Responses protocol gets platform-managed conversation history. If you write an Invocations handler with an in-memory session dictionary, that state is lost on restart. Use Cosmos DB or another durable store.

If you are still deciding whether Agent Framework is even the right base for this, the tradeoffs against the older stack are worth reading in [Microsoft Agent Framework vs Semantic Kernel for a greenfield .NET agent](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/). But once you have committed to an `AIAgent`, Foundry Hosted Agents is the shortest line from that object to a scaled, observable, identity-secured production endpoint, and most of the work is deciding on a protocol and not oversizing the sandbox.

When you are done experimenting, `azd down` tears down the whole resource group, Foundry project, ACR, App Insights, and all, in about two to five minutes.

## Source links

- [Foundry Hosted Agents -- Agent Framework hosting integration (Microsoft Learn)](https://learn.microsoft.com/en-us/agent-framework/hosting/foundry-hosted-agent)
- [Hosted agents in Foundry Agent Service, preview concepts (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents)
- [Quickstart: Deploy your first hosted agent (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/foundry/agents/quickstarts/quickstart-hosted-agent)
- [From Local to Production: Deploy Your Agent Framework Agent with Foundry Hosted Agents (Microsoft Agent Framework blog)](https://devblogs.microsoft.com/agent-framework/from-local-to-production-deploy-your-microsoft-agent-framework-agent-with-foundry-hosted-agents/)
- [Microsoft Agent Framework at Build 2026: Hosted Agents and more (devblogs)](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-at-build-2026-announce/)
