---
title: "Agent Framework 1.23: Function Middleware Can Finally Swap the Tool It Is Calling"
description: "Microsoft Agent Framework .NET 1.23.0 honors assignments to FunctionInvocationContext.Function, so middleware can redirect a tool call to a different AIFunction. A new WrapWithPendingMiddleware helper keeps the rest of the chain in the loop."
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
---

Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) shipped on October 1, 2026, with a long list of fixes and five changes flagged BREAKING. The one I want to focus on is not flagged at all, because the maintainers treat it as a bug fix: [PR #8615](https://github.com/microsoft/agent-framework/pull/8615) makes function middleware actually able to replace the function it is about to call.

## The setter that did nothing

Function-calling middleware registered with `AIAgentBuilder.Use(...)` receives a `FunctionInvocationContext`. Its `Function` property has a public setter, and nothing stopped you from assigning a different `AIFunction` before calling `next`. Up to 1.22, that assignment was silently ignored. Changes to `context.Arguments` were honored, but the continuation always invoked the function the wrapper had captured when the tool list was built.

That blocked a whole class of patterns: routing a risky call to a guarded implementation, swapping a per-tenant implementation at run time, or substituting a stub in an integration test without rebuilding the agent. The usual workaround was to skip `next` and invoke the other function yourself, which bypassed every middleware registered after yours.

## Redirecting a call in 1.23

`FunctionInvocationDelegatingAgent` now captures the target before your callback runs and dispatches on whatever `context.Function` holds afterwards. If you left it alone, behavior is identical to 1.22. If you replaced it, the replacement runs:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

The model asked for `delete_customer`, the arguments flow through untouched, and the sandboxed version produces the tool result.

## Why WrapWithPendingMiddleware exists

A replacement is invoked directly. Without the helper, `AuditMiddleware` in the example above would never see the redirected call. The new `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` wraps your replacement in the callbacks that have not run yet for this invocation, so the rest of the chain still observes it.

Three rules from the source:

- Call it from inside a running callback, before you call `next`. Once the continuation has run, there is nothing left pending, and the helper throws `InvalidOperationException`.
- If no callbacks are pending, it returns your function unchanged.
- It is marked `[Experimental]` with diagnostic `MAAI001`, hence the pragma.

One thing replacement does not change: tool approval and telemetry still reflect the function the model originally requested, because the call is resolved before any callback runs. If `delete_customer` requires approval, the user still approves `delete_customer`, even though your middleware later runs something else. That is the right default for auditing, but do not rely on a swap to dodge an approval gate.

## The rest of 1.23, briefly

If you are upgrading, grep for these BREAKING entries too: tool-name validation and pending-call handling when the tool list changes between runs ([#8754](https://github.com/microsoft/agent-framework/pull/8754)), stricter approval response binding ([#8641](https://github.com/microsoft/agent-framework/pull/8641)), and an allow list for configuration and environment keys in declarative workflows, with process environment fallback now off unless you set `AllowProcessEnvironmentVariableFallback = true` ([#8200](https://github.com/microsoft/agent-framework/pull/8200)). The release also bumps `Microsoft.Extensions.AI` to 10.10.1 and OpenAI to 2.14.0.

Coming from 1.21 or earlier? Start with [what 1.22 changed about AsIChatClient and per-run tools](/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/), then move to `Microsoft.Agents.AI` 1.23.0.
