---
title: "How to add policy enforcement and audit logging to a Microsoft Agent Framework agent"
description: "Wire the Agent Governance Toolkit into a Microsoft Agent Framework 1.0 agent so every tool call is checked against a YAML policy and written to a tamper-evident audit trail. Full C# middleware, policy file, and a hash-chained audit sink."
pubDate: 2026-06-25
tags:
  - "microsoft-agent-framework"
  - "ai-agents"
  - "dotnet"
  - "mcp"
  - "agent-governance"
  - "security"
---

If you have a [Microsoft Agent Framework 1.0](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) agent that can call tools, the model decides which tool runs and with what arguments. That is the whole point, and it is also the problem: nothing between the model's decision and your `database_query` function stops it from calling `database_query("DROP TABLE customers")` because a tool description was a little too friendly. The fix is two pieces of plumbing that belong in front of every tool call: a policy check that can deny the call, and an audit record that proves what was decided and why. This post wires both into an agent using the [Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) (`Microsoft.AgentGovernance`, MIT-licensed, targets `net8.0`) and Agent Framework's native function-calling middleware. By the end you have a `GovernanceKernel` evaluating each call against a YAML policy and a hash-chained JSONL audit trail you can verify after the fact.

This builds on the news overview I wrote when the toolkit shipped, [Agent Governance Toolkit puts a YAML policy in front of every MCP tool call from .NET](/2026/05/agent-governance-toolkit-mcp-policy-control-dotnet/). That post covered the three components in isolation. This one is the integration: how the kernel slots into a real agent's run loop, and how to turn its decisions into a compliance-grade log.

## Why a system prompt is not enforcement

The usual first attempt at "stop the agent from doing dangerous things" is to write it into the instructions: "Never run destructive SQL." That is a suggestion, not a guarantee. A prompt-injected tool result, an ambiguous user request, or a model that simply ignores the rule on turn 40 of a long loop all route around it. Instructions shape the distribution of what the model tries; they do not gate what actually executes.

Enforcement has to live below the model, on the code path that invokes the tool. Agent Framework gives you exactly that seam. Per the [middleware docs](https://learn.microsoft.com/en-us/agent-framework/agents/middleware/) (Agent Framework 1.0, doc revised April 2026), function-calling middleware "allows interception of all function calls executed by the agent, so that input and output can be inspected and modified as needed." That interception point is where policy belongs, because by the time a function middleware runs, the model has already committed to a tool name and a concrete argument set. You are no longer guessing what the model might do. You can see the call and decide.

## The scenario: a support agent with a real database tool

Take a support agent that can read customer records. It uses a `ChatClientAgent` (function-calling middleware is "currently only supported with an `AIAgent` that uses `FunctionInvokingChatClient`, for example, `ChatClientAgent`," so this matters), and it exposes one tool:

```csharp
// Agent Framework 1.0, .NET 10
[Description("Query the customer database with a SQL statement.")]
static string DatabaseQuery(
    [Description("A SQL statement to run.")] string query)
{
    // ... executes against the support read-replica ...
    return Db.Run(query);
}

AIAgent agent = chatClient
    .CreateAIAgent(
        instructions: "You are a support agent. Use database_query to look up customers.",
        tools: [AIFunctionFactory.Create(DatabaseQuery, name: "database_query")]);
```

The tool is read-only by intent, not by construction. A `SELECT` is fine; a `DELETE FROM` is a Tuesday-afternoon incident. Instructions cannot close that gap. A policy can.

## Step 1: define the policy

The toolkit reads YAML policy files. Each policy has an `id`, a numeric `priority`, a `match` block that can pin the tool name and constrain its arguments by regex, and an `effect` of `allow` or `deny`. A minimal policy for the scenario blocks destructive SQL and allows everything else on that tool:

```yaml
# policies/support.yaml
version: 1
policies:
  - id: block-destructive-sql
    priority: 100
    match:
      tool: database_query
      args:
        query:
          regex: "(?i)(DROP|TRUNCATE|DELETE\\s+FROM|UPDATE\\s)\\s"
    effect: deny
    reason: "Destructive SQL is not allowed from the support agent."
  - id: allow-readonly-by-default
    priority: 10
    match:
      tool: database_query
    effect: allow
```

The `priority` is what makes conflicts deterministic. The deny sits at `100`, the catch-all allow at `10`, so a `DELETE` matches both but the higher-priority deny wins. When two policies share a priority and disagree, the kernel falls back to its configured conflict strategy, which you set next.

## Step 2: build the governance kernel

The kernel loads the policy files once at startup. Construct it with `DenyOverrides` so that any tie or ambiguity resolves to a denial, never an accidental allow:

```csharp
using Microsoft.AgentGovernance;

var kernel = new GovernanceKernel(new GovernanceOptions
{
    PolicyPaths = new() { "policies/support.yaml" },
    ConflictStrategy = ConflictResolutionStrategy.DenyOverrides,
    EnablePromptInjectionDetection = true
});
```

`ConflictResolutionStrategy.DenyOverrides` is the only setting that belongs in production. The `AllowOverrides` alternative exists for permissive local sandboxes and should never ship. `EnablePromptInjectionDetection` turns on the scanner that flags tool output and arguments carrying injection patterns, which matters once a tool's result can itself influence the next call.

A single evaluation looks like this:

```csharp
EvaluationResult result = kernel.EvaluateToolCall(
    agentId: "support-bot",
    toolName: "database_query",
    args: new() { ["query"] = "SELECT * FROM customers WHERE id = 42" });

// result.Allowed   -> bool
// result.Reason    -> string explaining the decision
// result.MatchedPolicy -> which policy id fired
```

That is the whole enforcement primitive. The rest is wiring it onto the agent's tool-call path so you never have to call it by hand.

## Step 3: wrap every tool call in function-calling middleware

Function-calling middleware in Agent Framework is a callback with a fixed signature: it receives the agent, a `FunctionInvocationContext`, a `next` delegate that runs the actual function, and a cancellation token. Returning the result of `next` runs the tool; returning something else without calling `next` substitutes your own result and the function never executes. That second path is the deny.

```csharp
async ValueTask<object?> GovernanceMiddleware(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    // context.Function.Name is the tool the model chose;
    // context.Arguments is the concrete argument set it committed to.
    var args = context.Arguments.ToDictionary(
        kv => kv.Key, kv => kv.Value?.ToString() ?? "");

    EvaluationResult decision = kernel.EvaluateToolCall(
        agentId: "support-bot",
        toolName: context.Function.Name,
        args: args);

    if (!decision.Allowed)
    {
        // Do NOT call next(): the tool never runs.
        // Return a refusal as the tool result so the model can recover gracefully.
        return $"BLOCKED by policy {decision.MatchedPolicy}: {decision.Reason}";
    }

    return await next(context, cancellationToken);
}
```

Register it with the agent builder. Function and agent middleware both attach through `AsBuilder().Use(...)`:

```csharp
AIAgent governedAgent = agent
    .AsBuilder()
        .Use(GovernanceMiddleware)
    .Build();
```

Now every tool call the model makes flows through `GovernanceMiddleware` first. A `SELECT` matches `allow-readonly-by-default`, `next` runs, and the query executes. A `DELETE FROM customers` matches `block-destructive-sql`, `next` is never called, and the model receives `BLOCKED by policy block-destructive-sql: Destructive SQL is not allowed from the support agent.` as the tool result. Because you returned a value instead of throwing, the chat history stays consistent and the model can explain to the user that it cannot perform the action.

There is a harder stop available. Setting `context.Terminate = true` ends the function-calling loop entirely and prevents any remaining queued tool calls in the same turn from running. The docs warn that this "might result in your chat history being left in an inconsistent state," because you can end up with a function-call entry and no matching result. Reserve `Terminate` for a hard kill (the agent tried something that should end the turn), and use the return-a-refusal pattern for routine denials.

## Step 4: turn each decision into an audit record

A denial that nobody can reconstruct later is not governance, it is a log line that scrolled past. Auditors and incident responders need a tamper-evident record of every decision: what policy was active, what the agent requested, and why it was allowed or denied. The toolkit's audit chain gives you that, and the schema is worth copying even if you roll the sink yourself.

Each [audit entry](https://microsoft.github.io/agent-governance-toolkit/tutorials/04-audit-and-compliance/) carries an `entry_id`, a UTC `timestamp`, the `event_type` (`tool_invocation`, `tool_blocked`, `policy_violation`), the acting `agent_did`, the `action` taken, the matched rule, an `outcome`, a `previous_hash` linking to the prior entry, and an `entry_hash` that is a SHA-256 digest of the entry content. The `previous_hash` is what makes the log tamper-evident: changing any past entry breaks the chain from that point forward, so a deleted or edited record is detectable.

Capture that from the same middleware. Define a record and a sink, then write one entry per decision:

```csharp
public record AuditEntry(
    string EntryId, DateTime TimestampUtc, string EventType,
    string AgentId, string ToolName, string Action,
    string? MatchedPolicy, string Reason,
    string? TraceId, string PreviousHash, string EntryHash);

public sealed class HashChainedAuditSink
{
    private readonly string _path;
    private readonly byte[] _key;     // HMAC secret, from a key vault
    private string _previousHash = new string('0', 64);

    public HashChainedAuditSink(string path, byte[] key)
    {
        _path = path; _key = key;
    }

    public AuditEntry Write(string agentId, string tool, EvaluationResult d, string? traceId)
    {
        var id = Guid.NewGuid().ToString("n");
        var ts = DateTime.UtcNow;
        var eventType = d.Allowed ? "tool_invocation" : "tool_blocked";
        var action = d.Allowed ? "allow" : "deny";

        // Hash chain: digest = HMAC(key, previousHash + canonical payload)
        var payload = $"{id}|{ts:O}|{eventType}|{agentId}|{tool}|{action}|{d.MatchedPolicy}|{d.Reason}";
        var hash = Convert.ToHexString(
            System.Security.Cryptography.HMACSHA256.HashData(
                _key, System.Text.Encoding.UTF8.GetBytes(_previousHash + payload)))
            .ToLowerInvariant();

        var entry = new AuditEntry(id, ts, eventType, agentId, tool, action,
            d.MatchedPolicy, d.Reason, traceId, _previousHash, hash);

        File.AppendAllText(_path,
            System.Text.Json.JsonSerializer.Serialize(entry) + Environment.NewLine);
        _previousHash = hash;
        return entry;
    }
}
```

Wire it into the middleware so allowed and denied calls are both recorded:

```csharp
async ValueTask<object?> GovernanceMiddleware(
    AIAgent agent, FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    var args = context.Arguments.ToDictionary(kv => kv.Key, kv => kv.Value?.ToString() ?? "");
    var decision = kernel.EvaluateToolCall("support-bot", context.Function.Name, args);

    auditSink.Write("support-bot", context.Function.Name, decision,
        traceId: System.Diagnostics.Activity.Current?.TraceId.ToString());

    if (!decision.Allowed)
        return $"BLOCKED by policy {decision.MatchedPolicy}: {decision.Reason}";

    return await next(context, cancellationToken);
}
```

Pulling the `TraceId` off `Activity.Current` is what ties each governance decision back to the surrounding request span, so a blocked call shows up next to the trace that triggered it. If you are already running OpenTelemetry, this is the line that makes governance events queryable alongside everything else; see [how to use OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) for the collector side. For human-readable operational logs in parallel, emit the same fields through Serilog as covered in [structured logging with Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Verifying the trail and using the managed sink

A tamper-evident log is only useful if you actually check it. Verification walks the file and recomputes each `entry_hash` from the stored `previous_hash` plus the payload, confirming the chain is intact:

```csharp
bool VerifyChain(string path, byte[] key)
{
    var prev = new string('0', 64);
    foreach (var line in File.ReadLines(path))
    {
        var e = System.Text.Json.JsonSerializer.Deserialize<AuditEntry>(line)!;
        if (e.PreviousHash != prev) return false;     // chain broken
        var payload = $"{e.EntryId}|{e.TimestampUtc:O}|{e.EventType}|{e.AgentId}|{e.ToolName}|{e.Action}|{e.MatchedPolicy}|{e.Reason}";
        var expected = Convert.ToHexString(
            System.Security.Cryptography.HMACSHA256.HashData(
                key, System.Text.Encoding.UTF8.GetBytes(prev + payload))).ToLowerInvariant();
        if (e.EntryHash != expected) return false;     // entry tampered
        prev = e.EntryHash;
    }
    return true;
}
```

The hand-rolled sink above is deliberately small so you can see the mechanism. In production you do not have to maintain it: the toolkit ships a `FileAuditSink` that does the HMAC signing and hash chaining for you, rotates the file at a configurable size, and exposes integrity verification plus Merkle inclusion proofs so you can prove a single entry belongs to the chain without shipping the whole log. The toolkit's own [audit and compliance guide](https://microsoft.github.io/agent-governance-toolkit/tutorials/04-audit-and-compliance/) documents `verify_integrity` and CloudEvents export for downstream SIEM ingestion. The point of building it once by hand is that you understand what those managed methods are protecting against, so you can answer the auditor's "how do we know this log was not edited" with the actual mechanism rather than a vendor name.

## Gotchas worth pinning before you ship

**Function middleware needs the right client.** The interception point only exists for an `AIAgent` backed by a `FunctionInvokingChatClient`. A `ChatClientAgent` qualifies; a raw provider client wired without function-invocation support does not, and your middleware will silently never see the calls. If your policy seems to do nothing, check this first.

**Evaluate the arguments the tool will actually receive.** The model can produce arguments in odd shapes, and the policy regex matches what you pass to `EvaluateToolCall`, not what the user typed. Read the concrete values off `context.Arguments` inside the middleware, after the framework has bound them, so the policy sees exactly what the function would have run with.

**Denial as a tool result, termination as a kill switch.** Returning a refusal string keeps the conversation coherent and lets the model apologize and move on. `context.Terminate = true` is a blunt instrument that can desync chat history. Default to the former.

**The HMAC key is the trust anchor.** A hash chain signed with a key that sits in the same repo as the agent proves nothing to an attacker who already has the repo. Put the key in a vault, rotate it, and keep the audit file on storage the agent's own identity cannot delete. Tamper-evidence assumes the key and the verifier are outside the blast radius.

**Policy is per-agent, not per-tenant by default.** The `agentId` you pass is just a string. If you run multiple tenants through one agent, push the tenant into the policy match or the `agentId` so a permissive tenant's rules cannot leak onto a stricter one.

For the broader picture of where this kernel sits relative to the rest of the framework, the [Microsoft Agent Framework 1.0 walkthrough](/2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp/) covers the agent and orchestration model, and if your tools live behind MCP rather than in-process functions, [building a custom MCP server in C# on .NET 11](/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) shows the server side that the same governance kernel can front.

Two pieces of middleware, one YAML file, and a signed log: the model still decides, but now something below it decides whether the decision gets to happen, and writes down what it chose either way.

Sources: [Agent Governance Toolkit (GitHub)](https://github.com/microsoft/agent-governance-toolkit), [Agent Framework middleware docs](https://learn.microsoft.com/en-us/agent-framework/agents/middleware/), [Governance Toolkit audit and compliance guide](https://microsoft.github.io/agent-governance-toolkit/tutorials/04-audit-and-compliance/), [Agent Framework and Governance Toolkit, better together](https://devblogs.microsoft.com/agent-framework/governance-at-the-speed-of-agents-microsoft-agent-framework-and-agent-governance-toolkit-better-together/).
