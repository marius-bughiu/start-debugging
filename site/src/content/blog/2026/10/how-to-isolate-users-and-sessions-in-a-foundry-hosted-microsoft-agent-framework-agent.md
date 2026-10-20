---
title: "How to Isolate Users and Sessions in a Foundry Hosted Microsoft Agent Framework Agent"
description: "On container protocol 2.0.0, Foundry hosted agents isolate conversations and sessions per Entra caller by default. When your own backend fronts many end users, you delegate with x-ms-user-identity, grant a custom impersonation role, and key everything your container stores by session ID plus user ID. Here is the C# for each layer and the traps that leak data between users."
pubDate: 2026-10-20
template: "how-to"
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "azure-ai-foundry"
  - "multi-tenancy"
  - "agent-security"
  - "csharp"
---

**Short answer:** move the agent to container protocol 2.0.0 (`Azure.AI.AgentServer.Core` 1.0.0-beta.26 or later; every C# snippet below compiles against `Microsoft.Agents.AI.Foundry.Hosting` 1.25.0-preview.261014.1, which pulls in 1.0.0-beta.29). From then on Foundry derives the caller from the Microsoft Entra token and keeps that caller's sessions, conversations and user-isolated state private. If your own backend authenticates the end users, it sends a stable, server-derived user ID in the `x-ms-user-identity` header. For that it needs a custom role with the `UserIdentityImpersonation` data action, because no built-in role grants it anymore. Your backend also gives each user their own `agent_session_id`. Inside the container, read `FoundryAgentRequestContext.Current.UserId` and key every file, row and cache entry you write by `(SessionId, UserId)`. If you key anything by session ID alone, users who land in the same session see each other's data.

Foundry Hosted Agents has been generally available for a while, and Microsoft rewrote the isolation docs on 2026-10-13. The old model, where the caller passed isolation keys on protocol 1.0.0, is gone. The platform now blocks requests to agents that still use protocol 1.0.0. If you followed [the original deploy walkthrough for a hosted Agent Framework agent](/2026/06/deploy-a-microsoft-agent-framework-agent-to-foundry-hosted-agents/) in June, your agent is probably still on that path.

## Three identities, and which one the platform isolates by

A request to a hosted agent involves three different principals. Most isolation bugs start with confusing them:

1. **The Entra caller.** The user or service principal whose token is on the HTTP request. It needs `Foundry Agent Consumer` (or a broader role) on the project or the agent to call the endpoint at all.
2. **The acted-for end user.** A customer your backend signed in with Google, GitHub or your own IdP. Foundry has never heard of them. Your backend names them in `x-ms-user-identity`.
3. **The agent identity.** The Entra identity Foundry gives every hosted agent. `DefaultAzureCredential` resolves to it inside the container, and it is what your code uses to call models, the Toolbox, the state store and any Azure resource.

Isolation follows identity 2 when the header is present, and identity 1 when it is not. Identity 3 is the same for every request, so anything your container stores under the agent's own credentials is shared across all users unless you partition it yourself.

Here is what the platform isolates for you on protocol 2.0.0:

| Data | Isolated per user automatically? |
| --- | --- |
| Conversation history (Responses protocol, `previous_response_id` chains, `conversation` objects) | Yes, even when users share a session |
| The list of sessions a caller can see and manage | Yes |
| Items in a durable state store created with user isolation | Yes, resolved from the platform call ID |
| `$HOME` and `/files` inside a session sandbox | Only if each user has their own session |
| Files, database rows, Redis keys and caches your code writes | No |
| Process-wide clients (MCP connections, HTTP clients holding a token) | No |

The last three rows are your job, and the rest of this post covers them.

## The scenario: a support agent behind your own API

The setup is common. An ASP.NET Core API authenticates customers with its own IdP and forwards their messages to a Foundry hosted Agent Framework agent over the Responses protocol. The agent has one tool that saves a note for the customer and one that reads notes back. Two customers, Alice and Bob, must never see each other's notes or conversation. The API runs under a managed identity, so if you forget delegation, Foundry sees every request as coming from that one managed identity.

## Step 1: the middle tier names the end user on every call

The .NET pattern from the docs is a `PipelinePolicy` that stamps the header on every request a client sends. You then create one `AIProjectClient` per end user:

```csharp
// Middle tier. .NET 10, Azure.AI.Projects 3.0.0-beta.5, Azure.AI.Extensions.OpenAI 3.0.0-beta.5
using System.ClientModel.Primitives;

public sealed class UserIdentityPolicy(string userId) : PipelinePolicy
{
    public override void Process(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int index)
    {
        message.Request.Headers.Set("x-ms-user-identity", userId);
        ProcessNext(message, pipeline, index);
    }

    public override ValueTask ProcessAsync(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int index)
    {
        message.Request.Headers.Set("x-ms-user-identity", userId);
        return ProcessNextAsync(message, pipeline, index);
    }
}
```

The important part is where `userId` comes from. It must come from the authenticated principal on the server, never from a request body, a query string or a header the browser controls:

```csharp
// Minimal API endpoint in the middle tier. .NET 10, Azure.AI.Projects 3.0.0-beta.5
using System.ClientModel;
using System.Security.Claims;
using System.Text.Json;
using Azure.AI.Extensions.OpenAI;
using Azure.AI.Projects;
using Azure.Identity;
using OpenAI.Responses;

#pragma warning disable AAIP001, OPENAI001, SCME0001

app.MapPost("/chat", async (ChatRequest req, ClaimsPrincipal user, SessionDirectory sessions) =>
{
    // Tenant-scoped, stable, server-derived. Allowed characters: letters, digits, . _ : - @
    string tenant = user.FindFirstValue("tid")!;
    string subject = user.FindFirstValue(ClaimTypes.NameIdentifier)!;
    string endUserId = $"{tenant}:{subject}";

    var options = new AIProjectClientOptions();
    options.AddPolicy(new UserIdentityPolicy(endUserId), PipelinePosition.PerCall);

    var project = new AIProjectClient(new Uri(projectEndpoint), new DefaultAzureCredential(), options);
    ProjectResponsesClient responses = project.ProjectOpenAIClient
        .GetProjectResponsesClientForAgentEndpoint("support-agent");

    var create = new CreateResponseOptions { PreviousResponseId = req.PreviousResponseId };
    create.InputItems.Add(ResponseItem.CreateUserMessageItem(req.Message));

    // Pin this user to their own session (see step 3).
    string? sessionId = await sessions.GetAsync(endUserId);
    if (sessionId is not null)
    {
        create.Patch.Set("$.agent_session_id"u8, sessionId);
    }

    ClientResult<ResponseResult> result = await responses.CreateResponseAsync(create);

    using var payload = JsonDocument.Parse(result.GetRawResponse().Content.ToString());
    await sessions.SetAsync(endUserId, payload.RootElement.GetProperty("agent_session_id").GetString()!);

    return Results.Ok(new { text = result.Value.GetOutputText(), responseId = result.Value.Id });
}).RequireAuthorization();
```

The platform treats the header value as an opaque string of 1 to 256 characters drawn from letters, digits and `. _ : - @`, and rejects anything else. A raw email address works, but a tenant-qualified subject ID is better because it survives an email change and does not put PII in your session metadata.

The `Patch.Set` line writes the extra `agent_session_id` body field through the experimental JSON patch support in System.ClientModel (hence `SCME0001` in the pragma). If your SDK version does not have it, send the request with `HttpClient` and a JSON body, the same way the sessions doc does for the Invocations protocol. Either way, the field goes in the **body** for Responses and in the **query string** (`?agent_session_id=`) for Invocations. A header or body field named `agent_session_id` on an Invocations call is forwarded to your container untouched and does not affect routing.

## Step 2: grant the impersonation permission explicitly

Delegation is a privileged operation. The calling identity needs `Microsoft.CognitiveServices/accounts/AIServices/agents/endpoints/UserIdentityImpersonation/action`. It used to come along with `Microsoft.CognitiveServices/*`, which is why older setups using `Foundry User` worked without changes. That is no longer the case: no built-in role grants it, and a caller without it gets a `403` as soon as it sends `x-ms-user-identity`.

```json
{
  "Name": "Foundry Agent User Identity Impersonation",
  "IsCustom": true,
  "Description": "Lets a trusted middle-tier service delegate the end-user identity to a hosted agent via the x-ms-user-identity header.",
  "Actions": [],
  "NotActions": [],
  "DataActions": [
    "Microsoft.CognitiveServices/accounts/AIServices/agents/endpoints/UserIdentityImpersonation/action"
  ],
  "NotDataActions": [],
  "AssignableScopes": [
    "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<account-name>"
  ]
}
```

```bash
# Azure CLI 2.80+
az role definition create --role-definition custom-impersonation-role.json

az role assignment create \
  --assignee <middle-tier-managed-identity-object-id> \
  --role "Foundry Agent User Identity Impersonation" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CognitiveServices/accounts/<account-name>
```

Pair this with `Foundry Agent Consumer` for the middle tier, **not** `Foundry User`. This is easy to miss: `Foundry User` carries the `sessions/read` and `sessions/write` data actions that let an identity list, read and delete *every* session on the agent, regardless of who created it. That access is meant for admins and incident tooling. A chat backend that has it can read across users with a single list call.

Remember also that any service holding the impersonation permission can act as any end user. The trust boundary is your middle tier. If a frontend can reach the agent endpoint directly with a token that has this role, Alice can type Bob's ID into the header.

## Step 3: decide how users map to sessions

The platform enforces a hard boundary between delegated and non-delegated callers. **It does not fence one delegated end user off from another at the session level.** If your middle tier sends Alice and Bob to the same `agent_session_id`, both can reach that sandbox's `$HOME` and uploaded files. Conversation history stays private, since Bob cannot continue Alice's `previous_response_id` chain and the call fails, but the filesystem is shared.

You have two valid designs:

- **One session per user (the default).** Omit `agent_session_id` on a user's first call, store the ID the platform returns against that user, and send it back on later calls. That is what `SessionDirectory` does above. The sandbox is then private to the user, so you can store per-user files under `$HOME` without any extra keying. The cost is that each session counts against the regional concurrent-session limit while it is processing a turn, and each one has its own CPU and memory allocation.
- **A bounded session pool (multiplexing).** Teams bots, ISV gateways and support platforms with thousands of mostly idle users map them onto a small pool. The docs describe sticky least-loaded, hash-based (`hash(user_id) % pool_size`), round-robin and group-based strategies. Sticky is the safe default because a user's turns and files stay together. With a pool, step 4 stops being optional.

Whichever you choose, the `SessionDirectory` lookup must be keyed by the same server-derived `endUserId` you put in the header. A session ID that came from the client is just as forgeable as a user ID that came from the client.

## Step 4: partition what the container writes

The Agent Framework host does not change for this. You still use `AgentHost.CreateBuilder`, `AddFoundryResponses` and `MapFoundryResponses`. What changes is that every tool touching storage reads the platform request context first and fails closed when it is missing.

`FoundryAgentRequestContext` is an `AsyncLocal`-backed context that the AgentServer middleware fills from the `x-agent-user-id` and `x-agent-foundry-call-id` headers before your handler runs. It flows across `await` points, so a tool invoked deep inside the agent loop still sees it. `SessionId` comes from the sandbox's `FOUNDRY_AGENT_SESSION_ID` environment variable, which is correct because one sandbox serves exactly one session.

```csharp
// Container. .NET 10, Microsoft.Agents.AI.Foundry.Hosting 1.25.0-preview.261014.1, Azure.AI.AgentServer.Core 1.0.0-beta.29
using System.ComponentModel;
using System.Security.Cryptography;
using System.Text;
using Azure.AI.AgentServer.Core;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;
using Microsoft.Extensions.AI;

static (string SessionId, string UserId) PartitionKey()
{
    var ctx = FoundryAgentRequestContext.Current;
    if (string.IsNullOrEmpty(ctx.UserId) || string.IsNullOrEmpty(ctx.SessionId))
    {
        // Protocol 2.0.0 always sets these when hosted. Locally they are null.
        throw new UnauthorizedAccessException("A platform user context is required.");
    }
    return (ctx.SessionId, ctx.UserId);
}

static string NotesPath()
{
    var (sessionId, userId) = PartitionKey();
    // Never put the raw ID in a path: hash it so no value can escape the directory.
    string userKey = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(userId)));
    string dir = Path.Combine(Environment.GetEnvironmentVariable("HOME")!, "notes", sessionId);
    Directory.CreateDirectory(dir);
    return Path.Combine(dir, $"{userKey}.md");
}

[Description("Save a short note for the current customer.")]
static async Task<string> SaveNote([Description("The note text")] string text)
{
    await File.AppendAllTextAsync(NotesPath(), $"- {DateTimeOffset.UtcNow:u} {text}\n");
    return "saved";
}

[Description("Read back the current customer's notes.")]
static async Task<string> ReadNotes()
{
    string path = NotesPath();
    return File.Exists(path) ? await File.ReadAllTextAsync(path) : "(no notes)";
}

var endpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")!);
var model = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME") ?? "gpt-4o";

AIAgent agent = new AIProjectClient(endpoint, new DefaultAzureCredential())
    .AsAIAgent(
        model: model,
        instructions: "You are a support agent. Use the notes tools to remember customer details.",
        name: "support-agent",
        tools: [AIFunctionFactory.Create(SaveNote), AIFunctionFactory.Create(ReadNotes)]);

var builder = AgentHost.CreateBuilder(args);
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());
builder.Build().Run();
```

Two details in that code are deliberate. First, the user ID is hashed before it reaches the filesystem. The platform allows `:` and `@` in delegated IDs, and the value originates outside your container, so treating it as a path segment invites traversal and odd-filename bugs. Second, the guard throws instead of falling back to a shared `"anonymous"` bucket. Mixing every user into one fallback partition is exactly the leak you are trying to prevent.

The same rule applies to external stores. If the tool writes to Cosmos DB, Postgres or Redis using the agent's managed identity, the partition key or key prefix must include the user ID. The trade-offs between one shared cache with prefixed keys and separate databases are the same ones I covered for [multi-tenant Redis caching in ASP.NET Core](/2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore/). The agent case adds one twist: the "tenant" here is the end user, and it arrives per request rather than per deployment.

### Process-wide clients carry the first caller's identity

The Agent Framework hosting docs call this out for Python, and it applies to C# too. An MCP connection, Toolbox client or memory provider created once at startup and then reused can keep the identity of whichever request opened it. The C# `AIAgent` above is a singleton, which is fine because its tools read the ambient context on every call. Anything that captures identity at construction time needs to be created per request instead. For your own `HttpClient`s that call Foundry services, add `FoundryCallIdHandler` so the per-request `x-agent-foundry-call-id` is echoed automatically. The handler deliberately never echoes `x-agent-user-id`, because downstream Foundry services resolve the user from the call ID and not from a value your container could tamper with.

## Step 5: use the state store's user isolation for anything durable

For state that must survive a container restart, such as preferences, framework checkpoints or Invocations-protocol history, the durable state store (preview) can do the partitioning for you. Create the store with `userIsolation: true`, and item operations are scoped to the user that the platform resolved from the call ID:

```csharp
// Azure.AI.AgentServer.Core 1.0.0-beta.29, state store preview
using Azure.AI.AgentServer.Core.Storage;

FoundryStateStore prefs = await FoundryStateStore.GetOrCreateAsync(
    "support/preferences",          // non-user scope only
    new DefaultAzureCredential(),
    userIsolation: true);            // applied only on first creation

await prefs.SetItemAsync(
    "language",
    new Dictionary<string, BinaryData> { ["value"] = BinaryData.FromObjectAsJson("de") });

StateStoreItem? item = await prefs.GetItemAsync("language");
```

Three rules keep this correct:

- **Do not put the user ID in the store name.** Store names show up in logs and error messages, and a name your code builds is not a verified identity. Put thread, run or workflow scope in the name and leave the user to `userIsolation`.
- **`userIsolation` only takes effect when the store is created.** If someone created `support/preferences` without it during a spike, `GetOrCreateAsync` returns that existing, shared store and silently ignores your flag. Use a new store name when you change isolation.
- **Carry the call ID into deferred work.** Background work that outlives the request has no ambient context, so item operations would act for nobody, or for whoever's request happens to be current. Capture `FoundryAgentRequestContext.Current.CallId` while you still have the request, and pass it to the `callId` overloads of `SetItemAsync` and `GetItemAsync` later.

If you instead keep history in your own database, the same `(session, user)` rule from step 4 applies. The broader question of [where agent chat history should live and who holds the bytes](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/) is worth answering before you pick.

## Verify it against a deployed agent, not locally

Local runs (`azd ai agent run`, `--local`) do not enforce isolation. There is no platform call ID and no user context, the state store falls back to single-user file storage, and the `PartitionKey()` guard above throws. That is the correct local behavior, but it means a passing local test tells you nothing. Run the A-A-B test against the deployed agent instead:

```bash
# azd 1.23+, azure.ai.agents extension; caller holds the impersonation role
azd ai agent invoke --protocol responses --user-identity "contoso:alice" \
  --new-session --new-conversation "Remember that my order number is 4711"

azd ai agent invoke --protocol responses --user-identity "contoso:alice" \
  "What is my order number?"

# Bob, pointed at Alice's session on purpose
azd ai agent invoke --protocol responses --user-identity "contoso:bob" \
  --session-id <alice-session-id> --new-conversation "Read back the customer's notes"
```

The platform lets Bob into Alice's session, because delegated users are not fenced from each other at the session level. That is the point of the test. He still must not see her conversation, and his `ReadNotes` call returns `(no notes)` because his hashed file name differs. If he gets her order number back, something in your container is keyed by session alone. Then send Bob's request with Alice's `previous_response_id`. The platform must reject it. Use two genuinely different identities. Two labels that resolve to the same Entra object ID do not count as a cross-user test.

Finally, list sessions as the middle tier's identity. If the list includes sessions it did not create, it has `Foundry User` or the `sessions/read` data action somewhere in its role assignments. Remove it.

## Gotchas that survive a careful first pass

- **Legacy headers now fail.** Sending a protocol 1.0.0 isolation header such as `x-agent-user-isolation-key` to a protocol 2.0.0 agent returns an error. Strip it from old clients during the migration.
- **The sessions API still documents a `Header` authorization scheme.** In that mode the platform reads `x-ms-user-isolation-key`, requires it on every session call, and does not validate the value. Treat it as a partitioning hint, not an authorization control. Prefer the default `Entra` scheme plus delegation.
- **`--user-identity` and saved IDs in `azd`.** `azd` saves session and conversation IDs per agent, not per user identity. If you switch `--user-identity` without `--new-session`, you can test the wrong session and conclude isolation is broken (or worse, that it works).
- **Idle timeout is per agent version.** `idle_timeout_seconds` (120 to 3,600, default 900) is part of the agent version. A session per user multiplies the number of suspended sandboxes, not the bill, since compute is deprovisioned when idle. It does multiply the number of sessions you need to delete when a user asks for erasure, so record the user-to-session mapping somewhere you can query.
- **Workflow agents are not request-safe by default.** If you host a workflow as an agent, a `WorkflowAgent` keeps state in memory between runs, and one instance must never serve two users. The hosting docs deprecate that form in favor of native workflow hosting with a request-aware factory. This matters if you followed [the Agent Framework harness walkthrough](/2026/10/what-is-the-agent-harness-in-microsoft-agent-framework/) and wrapped a workflow.

None of these settings replace application authorization. The platform answers "whose data is this?". Your middle tier still answers "may this user do that?", which is also where [human-in-the-loop approval for risky tool calls](/2026/05/agent-framework-human-in-the-loop-tool-approval-csharp/) belongs.

## Related

- [How to deploy a Microsoft Agent Framework agent to Foundry Hosted Agents](/2026/06/deploy-a-microsoft-agent-framework-agent-to-foundry-hosted-agents/)
- [Where to store agent chat history: cost, privacy and portability](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/)
- [Agent Framework durable workflows: checkpoint and restart](/2026/05/agent-framework-durable-workflows-checkpoint-restart/)
- [Redis key prefix vs separate database vs separate instance for multi-tenant caching](/2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore/)
- [What is the agent harness in Microsoft Agent Framework](/2026/10/what-is-the-agent-harness-in-microsoft-agent-framework/)

## Sources

- [Isolate hosted agent sessions per user](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/isolate-sessions-per-user) (Microsoft Learn, updated 2026-10-13)
- [Multiplex multiple users in one hosted agent session](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/multiplex-session-users) (Microsoft Learn, updated 2026-10-13)
- [Manage hosted agent sessions](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/manage-hosted-sessions)
- [Hosted agent permissions reference: delegate the end-user identity](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agent-permissions#delegate-the-end-user-identity)
- [Durable state store for Foundry hosted agents (preview)](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/agent-state-store)
- [Agent Framework: Foundry Hosted Agents](https://learn.microsoft.com/en-us/agent-framework/hosting/foundry-hosted-agent)
- [Session multiplexing sample](https://github.com/microsoft-foundry/foundry-samples/tree/main/samples/python/hosted-agents/bring-your-own/responses/session-multiplexing)
- [`Azure.AI.AgentServer.Core` on NuGet](https://www.nuget.org/packages/Azure.AI.AgentServer.Core)
