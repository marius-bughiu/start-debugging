---
title: "SignalR clients can finally cancel a running hub method in .NET 11 Preview 6"
description: "Cancelling the CancellationToken you pass to InvokeAsync now reaches the server and cancels the hub method. This closes a SignalR request open since 2019."
pubDate: 2026-07-24
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
  - "csharp"
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) shipped on 2026-07-15, and it closes one of SignalR's longest-standing feature requests. [Issue #11542](https://github.com/dotnet/aspnetcore/issues/11542), "Possibility to cancel long running hub method from client," had been open since 2019. [PR #64098](https://github.com/dotnet/aspnetcore/pull/64098) finally wired it up: the `CancellationToken` you pass to `InvokeAsync` on the .NET client now actually reaches the server and cancels the hub method.

## The token that used to lie to you

Before Preview 6, the .NET SignalR client already accepted a `CancellationToken` on `InvokeAsync`. It just did not do what most people assumed. Cancelling it stopped the *client* from waiting for a result, but the hub method on the server kept running to completion. There was no way to tell the server "stop, the caller walked away." Streaming invocations did send a `CancelInvocation` message, but regular request-response invocations did not.

That gap is now gone. When you cancel the token passed to `InvokeAsync`, the client sends a `CancelInvocationMessage` to the server, which finds the matching invocation and cancels it.

## Wiring it up

On the server, declare a `CancellationToken` parameter on the hub method. SignalR fills it in as a synthetic argument, so the client never sends it:

```csharp
public class ReportHub : Hub
{
    public async Task<string> BuildReport(int rows, CancellationToken cancellationToken)
    {
        for (var i = 0; i < rows; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(50, cancellationToken); // real work here
        }

        return "done";
    }
}
```

Until Preview 6, a `CancellationToken` parameter on a non-streaming hub method was ignored: the framework only synthesized one for streaming methods. Now `HubMethodDescriptor` allows it everywhere.

On the client, pass a token and cancel it when you no longer need the result:

```csharp
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(2));

try
{
    var result = await connection.InvokeAsync<string>(
        "BuildReport", 100_000, cts.Token);
}
catch (OperationCanceledException)
{
    // The server's token fired too, so the hub method stopped.
}
```

## What happens under the hood

`DefaultHubDispatcher` registers each invocation's `CancellationTokenSource` in `ActiveRequestCancellationSources`, keyed by invocation id. When the `CancelInvocationMessage` arrives, it looks up that source and calls `Cancel()`, which trips the token your hub method is watching. This is the same registry streaming invocations already used, now shared with regular ones.

Two things to keep in mind. Cancellation is cooperative: if your hub method never checks the token or never forwards it to the async calls it makes, nothing stops. And this is a preview, so the behavior can still shift before .NET 11 ships in November 2026.

The same Preview 6 also [turned on automatic CSRF protection](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/), so it is a good release to test against. Full details are in the [ASP.NET Core Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). If you have ever built a "cancel" button that only lied to the user, this is the release that makes it honest.
