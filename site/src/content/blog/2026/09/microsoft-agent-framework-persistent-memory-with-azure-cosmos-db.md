---
title: "How to Give a Microsoft Agent Framework Agent Persistent Memory with Azure Cosmos DB"
description: "Agent Framework ships an in-memory chat history provider and nothing else for .NET. Here is a Cosmos DB backed ChatHistoryProvider that survives process restarts, the container design that keeps a 200-turn session cheap, and the second provider you need if you want semantic recall across sessions."
pubDate: 2026-09-06
template: how-to
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "llm"
  - "dotnet"
  - "csharp"
  - "cosmos-db"
  - "azure"
---

Microsoft Agent Framework has two extension points that people both call "memory", and picking the wrong one is the most common reason a Cosmos DB integration ends up either useless or expensive. `ChatHistoryProvider` decides where the verbatim transcript lives and gets replayed into every request. `AIContextProvider` decides what extra context gets injected before the model sees anything, which is where semantic recall across sessions belongs. Neither has a first-party Cosmos DB implementation in .NET as of `Microsoft.Agents.AI` 1.19.0 (published 22 August 2026), so you write both yourself, and the whole thing is about eighty lines. This post uses `Microsoft.Agents.AI` 1.19.0, `Microsoft.Azure.Cosmos` 3.62.0, and `CommunityToolkit.VectorData.AzureCosmosDB` 1.0.0 on .NET 10.

## Two things called memory, and only one of them is the transcript

The distinction matters because the two providers run at different points in the pipeline and store different things.

A `ChatHistoryProvider` is the transcript. Its `ProvideChatHistoryAsync` runs before the model call and its return value is **prepended** to whatever the caller passed in, so every message it returns is paid for as input tokens on every turn. Its `StoreChatHistoryAsync` runs afterward with the new request and response messages. If you return 200 messages, you send 200 messages.

An `AIContextProvider` is enrichment. Its `ProvideAIContextAsync` returns extra instructions, messages, or tools that get merged into the request, and `StoreAIContextAsync` extracts whatever is worth keeping from the turn. This is where a vector search over past conversations belongs, because you want the three relevant messages from six months ago, not all of them.

Confusing the two produces the classic failure: someone loads every message the user ever sent through the history provider, the context window fills up by turn thirty, and the bill triples. Which of the two you actually want is a design decision worth making explicitly, and the tradeoffs are laid out in more depth in [where to store agent chat history](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/).

## What ships in the box, and what does not

For .NET, `Microsoft.Agents.AI` gives you `InMemoryChatHistoryProvider` (with an optional `ChatReducer`, for example `new MessageCountingChatReducer(20)`) and a filesystem provider. That is it. [Issue #1396](https://github.com/microsoft/agent-framework/issues/1396) on the agent-framework repo asked for concrete Cosmos DB store implementations and was closed without shipping one. Python got a dedicated `agent-framework-azure-cosmos-memory` package with a `CosmosMemoryContextProvider` in July 2026; the .NET side did not.

So the shape of the work is: implement `ChatHistoryProvider`, hand it a `Container`, and let the framework call you. The single most important rule is stated plainly in the storage docs and is easy to violate:

> A `ChatHistoryProvider` instance is attached to an agent and the same instance would be used for all sessions.

One provider instance, many concurrent sessions. Your Cosmos `Container` reference goes in a field. The conversation ID does not. Session-scoped values live in the `AgentSession`, and `ProviderSessionState<T>` is the helper that puts them there.

## The container design that survives a 200-turn session

Two shapes are possible, and the difference is not cosmetic.

**One item per session.** The whole transcript is a JSON array on a single document that you rewrite every turn. Simple, and wrong for anything long-running. A Cosmos DB item is capped at 2 MB, and more importantly the write cost scales with the item, not with the delta. Writing a 1 KB item costs roughly 5 RU, so rewriting a document that has grown to 28 KB costs roughly 140 RU for two new messages.

**One item per message.** Partition key is the conversation ID, sort key is a monotonic sequence number. Each turn appends two small items and reads back the tail.

Take a 40-turn support session where each request/response pair is about 700 bytes of JSON. Rewriting a single document costs, summed over the session, roughly `5 RU/KB * 0.7 KB * (1 + 2 + ... + 40)`, which is about 2,900 RU for the writes alone, plus another 600 RU for the reads. Appending instead costs about 10 RU per turn for the two `CreateItem` operations and a single-partition query whose charge tracks the size of the result set, landing near 1,100 RU total. Roughly a third, and it never approaches the 2 MB ceiling. These are estimates from the documented per-KB rules; log `response.RequestCharge` on your own payloads before you trust any of them.

Create the container with the conversation ID as the partition key and TTL armed but off by default, so individual items can opt in:

```csharp
// Microsoft.Azure.Cosmos 3.62.0, .NET 10
var cosmos = new CosmosClient(
    accountEndpoint: Environment.GetEnvironmentVariable("COSMOS_ENDPOINT")!,
    tokenCredential: new DefaultAzureCredential(),
    new CosmosClientOptions
    {
        // ChatMessage content is polymorphic: TextContent, FunctionCallContent,
        // FunctionResultContent. Only the Agent Framework resolver round-trips it.
        UseSystemTextJsonSerializerWithOptions = AIJsonUtilities.DefaultOptions
    });

Database db = await cosmos.CreateDatabaseIfNotExistsAsync("agentmemory");

Container transcripts = await db.CreateContainerIfNotExistsAsync(
    new ContainerProperties("transcripts", partitionKeyPath: "/conversationId")
    {
        DefaultTimeToLive = -1  // TTL enabled, no container default: items opt in via "ttl"
    },
    throughput: 400);
```

That `UseSystemTextJsonSerializerWithOptions` line is not optional. `ChatMessage.Contents` is a list of `AIContent`, and the default `System.Text.Json` options have no polymorphic type resolver for it. Skip this and your tool calls round-trip as empty objects, which shows up two weeks later as an agent that forgets it ever called a tool.

## A Cosmos-backed ChatHistoryProvider in about eighty lines

```csharp
// Microsoft.Agents.AI 1.19.0, Microsoft.Azure.Cosmos 3.62.0
using System.Text.Json.Serialization;
using Microsoft.Agents.AI;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.AI;

public sealed class CosmosChatHistoryProvider : ChatHistoryProvider
{
    private readonly Container _container;
    private readonly ProviderSessionState<State> _sessionState;
    private readonly int _maxMessages;

    public CosmosChatHistoryProvider(Container container, int maxMessages = 60)
    {
        this._container = container;
        this._maxMessages = maxMessages;
        this._sessionState = new ProviderSessionState<State>(
            stateInitializer: _ => new State { ConversationId = Guid.NewGuid().ToString("N") },
            stateKey: nameof(CosmosChatHistoryProvider));
    }

    public override string StateKey => this._sessionState.StateKey;

    protected override async ValueTask<IEnumerable<ChatMessage>> ProvideChatHistoryAsync(
        InvokingContext context, CancellationToken cancellationToken = default)
    {
        State state = this._sessionState.GetOrInitializeState(context.Session);

        // TOP N + ORDER BY seq DESC reads the tail, so the query charge stays flat
        // as the conversation grows instead of scaling with its full length.
        var query = new QueryDefinition("SELECT TOP @take * FROM c ORDER BY c.seq DESC")
            .WithParameter("@take", this._maxMessages);

        var messages = new List<ChatMessage>();
        using FeedIterator<MessageDocument> iterator = this._container.GetItemQueryIterator<MessageDocument>(
            query,
            requestOptions: new QueryRequestOptions
            {
                // Single logical partition. Without this it fans out across every conversation.
                PartitionKey = new PartitionKey(state.ConversationId)
            });

        while (iterator.HasMoreResults)
        {
            FeedResponse<MessageDocument> page = await iterator.ReadNextAsync(cancellationToken);
            messages.AddRange(page.Select(d => d.Message));
        }

        messages.Reverse();  // newest-first from the query, oldest-first for the model
        return messages;
    }

    protected override async ValueTask StoreChatHistoryAsync(
        InvokedContext context, CancellationToken cancellationToken = default)
    {
        State state = this._sessionState.GetOrInitializeState(context.Session);

        // The base InvokedCoreAsync already stripped messages that this provider
        // contributed, so everything here is genuinely new.
        List<ChatMessage> newMessages =
            [.. context.RequestMessages, .. context.ResponseMessages ?? []];

        if (newMessages.Count == 0)
        {
            return;
        }

        // A transactional batch is capped at 100 operations and every item must
        // share the partition key. A tool-heavy turn can exceed 100; chunk it.
        foreach (ChatMessage[] chunk in newMessages.Chunk(100))
        {
            TransactionalBatch batch = this._container.CreateTransactionalBatch(
                new PartitionKey(state.ConversationId));

            foreach (ChatMessage message in chunk)
            {
                int seq = state.NextSequence++;
                batch.CreateItem(new MessageDocument
                {
                    Id = $"{state.ConversationId}-{seq:D6}",
                    ConversationId = state.ConversationId,
                    Sequence = seq,
                    Message = message,
                    TimeToLiveSeconds = 90 * 24 * 60 * 60  // 90 days
                });
            }

            using TransactionalBatchResponse response = await batch.ExecuteAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(
                    $"Cosmos batch failed with {response.StatusCode}: {response.ErrorMessage}");
            }
        }

        this._sessionState.SaveState(context.Session, state);
    }

    public sealed class State
    {
        [JsonPropertyName("conversationId")]
        public string ConversationId { get; set; } = string.Empty;

        [JsonPropertyName("nextSequence")]
        public int NextSequence { get; set; }
    }

    internal sealed class MessageDocument
    {
        [JsonPropertyName("id")]
        public required string Id { get; init; }

        [JsonPropertyName("conversationId")]
        public required string ConversationId { get; init; }

        [JsonPropertyName("seq")]
        public required int Sequence { get; init; }

        [JsonPropertyName("message")]
        public required ChatMessage Message { get; init; }

        [JsonPropertyName("ttl")]
        public int? TimeToLiveSeconds { get; init; }
    }
}
```

Two details are load-bearing. The `PartitionKey` on `QueryRequestOptions` turns a cross-partition fan-out into a single-partition read, which is the difference between a few RU and a few hundred on a busy container. And `TOP @take ... ORDER BY seq DESC` caps what you load: without it, turn 200 pays to read 400 documents and then pays again to send them all as input tokens.

## Wiring it up, and what SerializeSession actually carries

```csharp
// Microsoft.Agents.AI 1.19.0
AIAgent agent = new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential())
    .GetChatClient("gpt-5.4-mini")
    .AsAIAgent(new ChatClientAgentOptions
    {
        Name = "SupportAgent",
        ChatOptions = new() { Instructions = "You are a support engineer. Be concise." },
        ChatHistoryProvider = new CosmosChatHistoryProvider(transcripts)
    });

AgentSession session = await agent.CreateSessionAsync();
Console.WriteLine(await agent.RunAsync("My build fails with MSB4018 after the .NET 11 bump.", session));

// Persist the session, not the transcript.
JsonElement serialized = agent.SerializeSession(session);
await sessions.UpsertItemAsync(
    new SessionDocument { Id = userId, State = serialized },
    new PartitionKey(userId));
```

Days later, in a different process:

```csharp
SessionDocument stored = await sessions.ReadItemAsync<SessionDocument>(userId, new PartitionKey(userId));
AgentSession resumed = await agent.DeserializeSessionAsync(stored.State);
Console.WriteLine(await agent.RunAsync("Did we ever sort that build out?", resumed));
```

Here is the payoff, and it is the thing worth internalising. With `InMemoryChatHistoryProvider`, `SerializeSession` produces a blob containing every message, which grows without bound and which you then store somewhere anyway. With the Cosmos provider, the serialized session is a `conversationId` and an integer. The transcript stayed in Cosmos DB the whole time, queryable by your own tooling, subject to your own TTL and retention policy, and the session document is small enough to sit on a user row.

One constraint the docs are blunt about: do not attach a local history provider to a service-managed session. If your chat client keeps conversation state server-side (an OpenAI Responses `conv_*` identifier, for example), the service is the source of truth and a local provider will double-count. Pick one.

## Semantic recall across sessions is the other provider

Once the transcript is durable, "remember what this user told me in March" is a vector search, and that is `ChatHistoryMemoryProvider`, an `AIContextProvider` that ships in `Microsoft.Agents.AI`. It stores each turn in a `Microsoft.Extensions.VectorData` store and retrieves the semantically closest messages before each invocation.

The package situation here is a trap, because almost every sample you will find online is on a dead name. The connector was `Microsoft.SemanticKernel.Connectors.CosmosNoSql` (last preview 1.74.0-preview, March 2026, deprecated), then `CommunityToolkit.VectorData.CosmosNoSql` 1.0.0 (July 2026, also deprecated), and is now `CommunityToolkit.VectorData.AzureCosmosDB` 1.0.0 (19 August 2026). The type went from `CosmosNoSqlVectorStore` to `CosmosVectorStore`, and the DI extension is `AddCosmosVectorStore()`.

```csharp
// CommunityToolkit.VectorData.AzureCosmosDB 1.0.0, Microsoft.Agents.AI 1.19.0
VectorStore vectorStore = new CosmosVectorStore(db, new CosmosVectorStoreOptions
{
    EmbeddingGenerator = new AzureOpenAIClient(new Uri(endpoint), credential)
        .GetEmbeddingClient("text-embedding-3-large")
        .AsIEmbeddingGenerator()
});

AIAgent agent = chatClient.AsAIAgent(new ChatClientAgentOptions
{
    Name = "SupportAgent",
    ChatOptions = new() { Instructions = "You are a support engineer. Be concise." },
    ChatHistoryProvider = new CosmosChatHistoryProvider(transcripts),
    AIContextProviders =
    [
        new ChatHistoryMemoryProvider(
            vectorStore,
            collectionName: "memories",
            vectorDimensions: 3072,
            session => new ChatHistoryMemoryProvider.State(
                // Tag new messages with this session...
                storageScope: new() { UserId = userId, SessionId = conversationId },
                // ...but search across every session this user ever had.
                searchScope: new() { UserId = userId }))
    ]
});
```

The asymmetry between `storageScope` and `searchScope` is the entire feature. Store narrow, search wide, and the agent recalls a preference stated three sessions ago without replaying those sessions as input tokens. `ChatHistoryMemoryProviderOptions` also lets you flip `SearchTime` from the default `BeforeAIInvoke` to `OnDemandFunctionCalling`, which exposes the search as a tool and lets the model decide when recall is worth a round trip. That is usually the better default once the memory store has real volume, and it is the same tradeoff described in [migrating an agent from chunking-and-RAG to a large context window](/2026/08/migrate-from-rag-chunking-to-a-1m-token-context-window/).

## The Cosmos DB gotchas that only surface in production

**3072 dimensions will not fit a flat index.** `text-embedding-3-large` produces 3072-dimensional vectors. A Cosmos DB `flat` vector index caps at 505 dimensions. You need `quantizedFlat` or `diskANN`, both of which cap at 4,096. Get this wrong and container creation fails, which is the good outcome; the bad outcome is silently reaching for `flat` with a smaller model and wondering why recall is poor.

**Approximate indexes need volume.** `quantizedFlat` and `diskANN` require at least 1,000 indexed vectors before quantization is meaningful. Below that, Cosmos DB falls back to a full scan and your RU charges are higher than the index promised. A memory store in its first week is exactly this case, so do not benchmark recall or cost on a fresh container.

**Vector search does not work on shared-throughput accounts.** Database-level (shared) throughput and vector indexing are mutually exclusive. Provision the memory container with dedicated throughput.

**Hierarchical partition keys plus vector search needs a conversation with Microsoft.** The docs say to contact `cosmossearch@microsoft.com` to have the account configured so the partitioning scheme is used during search. If you were planning `/tenantId/userId/conversationId` as a three-level key on the vector container, plan that call first.

**The 20 GB logical partition limit is a real ceiling.** Partitioning transcripts by conversation ID keeps each partition tiny. Partitioning by `userId` does not, and a heavy user with years of tool-call payloads will hit it. Hierarchical partition keys are the documented fix.

**Retrieved memories are untrusted input.** The provider injects vector-store hits straight into the model's context without validation, which the Microsoft docs flag explicitly as an indirect prompt injection surface. If a past turn contains attacker-controlled text, it comes back later as an instruction. The structural fix is not a better system prompt; it is [labelling flows and constraining what tainted context can trigger](/2026/09/information-flow-control-to-block-prompt-injection-in-agents/).

**Bind resumed sessions to the authenticated caller.** A serialized session is an opaque state object that grants access to a conversation. Store it as trusted server-side state and verify ownership before calling `DeserializeSessionAsync` with it.

## Related

- [Where to store agent chat history: cost, privacy, and portability tradeoffs](/2026/09/where-to-store-agent-chat-history-cost-privacy-portability/)
- [Migrate a Semantic Kernel app to Microsoft Agent Framework 1.0](/2026/07/migrate-a-semantic-kernel-app-to-microsoft-agent-framework-1-0/)
- [Microsoft Agent Framework vs Semantic Kernel for a greenfield .NET agent](/2026/06/microsoft-agent-framework-vs-semantic-kernel-for-a-greenfield-net-agent/)
- [Agent Framework workflows that survive process restarts](/2026/05/agent-framework-durable-workflows-checkpoint-restart/)
- [EF Core 11 turns on Cosmos DB transactional batches by default](/2026/04/efcore-11-cosmos-transactional-batches/)

## Sources

- [Storage: built-in modes and custom history providers](https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/storage), Microsoft Learn
- [Context providers](https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/context-providers), Microsoft Learn
- [Chat History Memory Provider for Agent Framework](https://learn.microsoft.com/en-us/agent-framework/integrations/chat-history-memory-provider), Microsoft Learn
- [Integrated vector store in Azure Cosmos DB for NoSQL](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/vector-search), Microsoft Learn
- [Azure Cosmos DB service quotas and default limits](https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits), Microsoft Learn
- [Request units as a throughput and performance currency](https://learn.microsoft.com/en-us/azure/cosmos-db/request-units), Microsoft Learn
- [.NET: Cosmos DB store implementations (issue #1396)](https://github.com/microsoft/agent-framework/issues/1396), microsoft/agent-framework
- [Native agent memory for Microsoft Agent Framework, powered by Azure Cosmos DB](https://devblogs.microsoft.com/cosmosdb/native-agent-memory-for-microsoft-agent-framework-powered-by-azure-cosmos-db/), Azure Cosmos DB Blog
- [CommunityToolkit.VectorData.AzureCosmosDB 1.0.0](https://www.nuget.org/packages/CommunityToolkit.VectorData.AzureCosmosDB), NuGet
