---
title: "Blazor Server Circuits Now Pause Themselves When the Tab Goes Idle"
description: ".NET 11 Preview 7 adds an opt-in package that pauses interactive Server circuits when the browser tab is hidden, freeing memory and SignalR connections held by users who are not actually there."
pubDate: 2026-08-13
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "blazor"
  - "signalr"
---

.NET 11 Preview 7 shipped on August 11, 2026, and buried in the ASP.NET Core section is the fix for one of Blazor Server's oldest capacity problems: a circuit that nobody is looking at costs exactly as much as a circuit somebody is using. The [ASP.NET Core Preview 7 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/aspnetcore.md) introduce auto-pause, driven by [dotnet/aspnetcore#64886](https://github.com/dotnet/aspnetcore/issues/64886).

## Hidden tabs are not disconnected tabs

Blazor Server keeps per-user state in a circuit on the server, and that circuit lives as long as the SignalR connection does. When a user switches to another tab and forgets about yours, the WebSocket does not close. Desktop browsers happily hold it open for hours. The circuit keeps its component tree, its DI scope, its render queue, and its slot in your concurrency budget, for a user who left at lunchtime.

Auto-pause hooks the browser's visibility signal instead. When the tab has been hidden for a configurable delay, the client asks the server to pause the circuit, which releases it. When the user comes back, the circuit resumes.

## Turning it on

It is opt-in and lives in its own package:

```xml
<PackageReference Include="Microsoft.AspNetCore.Components.Server.AutoPause" />
```

Configuration hangs off the render mode registration:

```csharp
app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode()
    .WithBrowserOptions(options =>
    {
        options.AddAutoPause(pause =>
        {
            pause.Enabled = true; // default
            pause.HiddenDelay = TimeSpan.FromSeconds(30); // default is 2 minutes
        });
    });
```

`HiddenDelay` defaults to two minutes. Dropping it to 30 seconds reclaims memory faster, at the cost of more resume round trips from users who tab back and forth.

## The cases where it refuses to pause

The interesting engineering is in what auto-pause declines to do. It defers pausing when a text input or `contenteditable` element has focus, when unmuted audio or video is playing, when a Picture-in-Picture window is open, when a Web Lock is held, and while circuit activity is still in flight such as an `IJSRuntime` call or a stream transfer. In other words, a hidden tab that is still doing something on the user's behalf does not get pulled out from under them.

You can add your own deferral logic from a JavaScript initializer:

```javascript
// wwwroot/{ASSEMBLY NAME}.lib.module.js
export function beforeWebStart(options) {
  options.circuit ??= {};
  options.circuit.circuitHandlers ??= [];

  options.circuit.circuitHandlers.push({
    onCircuitPausing: async (signal) => {
      await savePendingWork(signal);
    },
  });
}
```

The `signal` aborts if the pause is cancelled, for example because the tab became visible again while your handler was still saving. On the server side, `Circuit.RequestCircuitPauseAsync` now returns `Task<bool>` and takes an optional cancellation token, so pause-deferral work can be cancelled when the connection drops.

## What you should check before enabling it

Auto-pause rides on the pause and resume plumbing introduced in .NET 10, which means resume rebuilds the circuit from persisted component state. Anything a component holds in a plain field, and never declares as persistent, is gone after a pause. Audit your stateful components before you flip this on in production, and watch your reconnect telemetry: the failure mode here looks a lot like [a circuit that disconnected on its own](/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/).

Preview 7 is a busy release. The C# side of it picked up [labeled break and continue](/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/) in the same drop.
