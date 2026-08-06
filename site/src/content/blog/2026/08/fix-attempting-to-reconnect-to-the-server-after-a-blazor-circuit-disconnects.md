---
title: "Fix: Attempting to reconnect to the server after a Blazor Server circuit disconnects"
description: "The reconnect modal means the SignalR circuit dropped, not that your app crashed. Decide whether the retry ended in failed or rejected, then fix sticky sessions, the 3-minute retention window, the 32 KB message limit, or persist circuit state with [PersistentState]."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-11"
  - "signalr"
---

The modal is not an error, it is Blazor telling you the SignalR circuit dropped and the client is retrying. What matters is how the retry ends. If it ends in `failed` ("Reconnection failed", "Failed to rejoin"), the browser never reached the server: check the WebSocket path through your proxy, the keep-alive timeouts, and the 32 KB `MaximumReceiveMessageSize` limit. If it ends in `rejected` ("Could not reconnect to the server", "Failed to resume the session"), the server was reached and refused: the circuit is gone because the app restarted, the load balancer sent you to a different instance without session affinity, or the 3-minute `DisconnectedCircuitRetentionPeriod` expired. On .NET 10 and .NET 11 the durable answer to the last group is to stop caring about circuit identity and mark your state with `[PersistentState]`.

```text
Attempting to reconnect to the server: 3 of 8
Reconnection failed. Try reloading the page if you're unable to reconnect.
Could not reconnect to the server. Reload the page to restore functionality.
```

Those are the .NET 8 and earlier strings, and they are what most people paste into a search box. On .NET 9 and later the same states have different wording, which is why the search results feel like they are about a different bug:

```text
Rejoining the server...
Rejoin failed... trying again in 5 seconds.
Failed to rejoin. Please retry or reload the page.
The session has been paused by the server.
Failed to resume the session. Please retry or reload the page.
```

Everything below is verified against .NET 11 Preview 6 (SDK `11.0.100-preview.6.26359.118`) with the Blazor Web App template on Interactive Server rendering, and notes where .NET 8, 9, and 10 behave differently. Blazor WebAssembly has no circuit, so if you are seeing this modal your components are rendering with `InteractiveServer` or `InteractiveAuto` currently resolved to server.

## Why a dropped WebSocket produces a modal instead of an exception

A server-side Blazor app keeps the component tree, every field on every component instance, and every circuit-scoped DI service in server memory. That bundle is the circuit. The browser holds only a rendered DOM and a SignalR connection; each click is an RPC to the server, and each render is a diff pushed back. Break the connection and the browser has nothing to render with, so the framework covers the page and tries to re-attach to the same circuit by ID.

Nobody has to write that UI. If your app defines an element with `id="components-reconnect-modal"`, Blazor toggles CSS classes on it. If it does not, Blazor injects its own built-in display, which is where the classic wording comes from. That is the important part for debugging: the message you see is generated entirely on the client, from client-side state. It tells you nothing about what the server thinks happened. The server-side story is in your logs.

## The three end states, and which one you actually have

Since .NET 10 the framework raises a `components-reconnect-state-changed` event on the modal element and sets a matching CSS class, so you can read the outcome instead of guessing:

| CSS class | Event `detail.state` | Meaning |
| --- | --- | --- |
| `components-reconnect-show` | `show` | Connection lost, retrying. |
| `components-reconnect-retrying` | `retrying` | A retry attempt is in flight. |
| `components-reconnect-paused` | `paused` | The circuit was paused (client or server initiated). |
| `components-reconnect-hide` | `hide` | Reconnected. Nothing was lost. |
| `components-reconnect-failed` | `failed` | The server was never reached. Call `Blazor.reconnect()`. |
| `components-reconnect-rejected` | `rejected` | The server was reached and refused. Call `location.reload()`. |

On .NET 9 and earlier you only get the CSS classes, no event. Either way, `failed` and `rejected` are the fork in the diagnosis, and they have almost no causes in common. Log which one you get before you change any configuration:

```javascript
// .NET 10 or .NET 11, wwwroot or a collocated ReconnectModal.razor.js
const modal = document.getElementById("components-reconnect-modal");
modal.addEventListener("components-reconnect-state-changed", e => {
  console.log("[circuit]", e.detail.state, new Date().toISOString());
});
```

## The minimal repro

You do not need a broken app to see it. Any Interactive Server component plus a killed process is enough:

```csharp
// .NET 11 preview 6, C# 14. Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

var app = builder.Build();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();
app.Run();
```

Run it, open the counter page, click a few times, then stop the process with Ctrl+C. The modal appears within roughly half a second. Start the process again and watch what happens: the connection succeeds but the circuit ID is unknown to the new process, so you get `rejected`, not `hide`, and your count is back to zero. Contrast that with pulling the network cable (DevTools, Network, Offline): the retries never reach anything, you get `failed`, and restoring the network lets a retry land on the original circuit with the count intact, as long as you are inside the retention window.

That difference is the whole diagnosis in miniature. `failed` is a transport problem. `rejected` is a lifetime problem.

## Fix 1: session affinity, if you run more than one instance

This is the top production cause and it produces `rejected` on roughly every reconnect. The circuit lives in one process's memory. A reconnect that lands on any other instance cannot find the circuit ID and refuses. Two servers behind a round-robin load balancer means about half of all reconnects fail permanently, and it looks intermittent, which is why it survives testing.

Turn on session affinity (sticky sessions) at the load balancer: ARR affinity on Azure App Service, `sessionAffinity` on your ingress, `ip_hash` or a sticky cookie on nginx. The related symptom to search your logs for is `Invocation canceled due to the underlying connection being closed`. If you cannot use affinity, you cannot keep in-memory circuits across instances, and you want the distributed persistence in Fix 5 instead.

## Fix 2: align the retry schedule with the retention window

The server keeps a disconnected circuit for `DisconnectedCircuitRetentionPeriod`, default 3 minutes, and holds at most `DisconnectedCircuitMaxRetained` of them, default 100. After that the circuit is disposed and any later reconnect is `rejected` by definition.

The client-side schedule changed in .NET 9 and now routinely outlives that window:

- **.NET 8 and earlier**: `maxRetries: 8`, `retryIntervalMilliseconds: 20000`. Fixed 20-second interval, so the client gives up after about 160 seconds, just inside the server's 3 minutes.
- **.NET 9, .NET 10, .NET 11**: `maxRetries: 30` with a computed backoff. The first 10 attempts fire as fast as the handshake allows, attempts 11 to 20 are 5 seconds apart, and everything after that is 30 seconds apart. That is roughly 350 seconds of retrying against a circuit the server deleted at 180.

So on .NET 9 and later, a user who walks away for 4 minutes gets a modal that keeps counting down and then rejects. That is working as designed, but it is a bad experience, and it is worth making the two numbers agree. Either extend the server:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents(options =>
    {
        options.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(6);
        options.DisconnectedCircuitMaxRetained = 100;
        options.JSInteropDefaultCallTimeout = TimeSpan.FromSeconds(30);
    });
```

or shorten the client so it fails fast and reloads instead of pretending:

```html
<!-- .NET 10 or .NET 11, App.razor. Requires autostart="false" on the Blazor script. -->
<script src="_framework/blazor.web.js" autostart="false"></script>
<script>
  Blazor.start({
    circuit: {
      reconnectionOptions: {
        maxRetries: 8,
        retryIntervalMilliseconds:
          Array.prototype.at.bind([0, 0, 1000, 2000, 5000, 10000, 15000, 30000])
      }
    }
  });
</script>
```

Returning `null` or `undefined` from `retryIntervalMilliseconds` stops retrying, which is what `Array.prototype.at` does once you run off the end of the array. Note the memory cost before you raise the server number: every retained circuit is a live component tree plus its scoped services, and 100 of them is a real number on a busy app.

## Fix 3: the 32 KB message limit, when the modal loops forever

If the modal appears repeatedly during normal use, especially right after a file upload, a large form post, or a big JS interop payload, you are almost certainly hitting `HubOptions.MaximumReceiveMessageSize`, which defaults to 32 KB. Exceeding it closes the circuit with an error, the client reconnects, the user repeats the action, and it closes again.

The browser console shows a generic close:

```text
Error: Connection disconnected with error 'Error: Server returned an error on close: Connection closed with an error.'
```

The real message only appears with `Microsoft.AspNetCore.SignalR` logging at Debug or Trace:

```text
System.IO.InvalidDataException: The maximum message size of 32768B was exceeded.
```

Raising the cap works and costs you DoS headroom:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 64 * 1024;
    });
```

The better fix for anything genuinely large is streaming JS interop, which chunks under the limit instead of raising it. Leave `MaximumParallelInvocationsPerClient` at its default of `1`: Blazor depends on it, and raising it breaks `InputFile` uploads.

A second flavour of the same problem happens on first load rather than on interaction. If prerendered state pushed through `PersistentComponentState` exceeds the limit, the circuit never starts and the log says `Circuit host not initialized`. Persist less, or raise the cap.

## Fix 4: timeouts and proxies that kill idle WebSockets

`failed` that only happens after an idle period, on mobile, or behind a reverse proxy is a transport timeout. Three numbers have to agree:

```csharp
// .NET 11 preview 6. Program.cs. These are the framework defaults, stated explicitly.
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddHubOptions(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    });
```

The rule is that the server timeout should be at least double the keep-alive interval. If you raise one, raise the other. Then make sure your infrastructure tolerates a connection that is idle between keep-alives: `proxy_read_timeout` on nginx, the WebSocket idle timeout on Application Gateway, and `webSocket enabled="true"` plus a sane `pingInterval` on IIS. A proxy that closes at 20 seconds will produce a reconnect modal every 20 seconds forever, and no amount of Blazor configuration will fix it.

Mobile browsers and background tabs are the other half of this. A throttled tab stops running timers, the keep-alive stops, and the server drops the circuit. .NET 9 and later reconnect immediately when the tab becomes visible again rather than waiting for the next scheduled retry, and the .NET 10 template's `ReconnectModal.razor.js` also re-attempts on `visibilitychange` after a failure, so upgrading is a genuine fix for the "came back to my tab and everything was gone" report.

## Fix 5: on .NET 10 and 11, persist the state and stop fighting the circuit

Everything above tries to keep one circuit alive. .NET 10 added the option to give up on that and keep the state instead. Mark component properties or scoped-service properties with `[PersistentState]`, and Blazor serializes them when the circuit is evicted, then rehydrates them into the new circuit when the same tab reconnects:

```razor
@* .NET 10 or .NET 11, Counter.razor *@
@page "/counter"
@rendermode InteractiveServer

<p role="status">Current count: @CurrentCount</p>
<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int CurrentCount { get; set; }

    private void IncrementCount() => CurrentCount++;
}
```

This is on by default when `AddInteractiveServerComponents` is called. The in-memory provider keeps up to 1,000 persisted circuits for two hours, both configurable:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.Configure<CircuitOptions>(options =>
{
    options.PersistedCircuitInMemoryMaxRetained = 2_000;
    options.PersistedCircuitInMemoryRetentionPeriod = TimeSpan.FromHours(3);
});
```

For multiple instances, assign a `HybridCache` and the persisted state becomes distributed, with its own `PersistedCircuitDistributedRetentionPeriod` defaulting to eight hours. That is the escape hatch when session affinity is not available:

```csharp
// .NET 11 preview 6. Program.cs
builder.Services.AddHybridCache()
    .AddRedis("{CONNECTION STRING}");

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
```

Constraints worth knowing before you rely on this: it only works for Interactive Server rendering, the state must be JSON serializable (EF Core entities with cycles will not survive), a full page refresh discards it, and there is no guarantee of recovery, so the app falls back to the normal disconnected experience if persistence fails. Use `@key` when rendering persisted components in a loop.

The same machinery powers pausing. `Blazor.pauseCircuit()` and `Blazor.resumeCircuit()` let you drop the circuit for a hidden tab and rebuild it on return, and .NET 11 adds the server side of that with `Circuit.RequestCircuitPauseAsync(CancellationToken)`, so a deployment can ask connected clients to pause and persist before the process stops instead of handing every user a rejected reconnect. Clients can defer with the `onPauseRequested` callback in `Blazor.start`.

## Gotchas that send people to the wrong fix

- **The reconnect modal is not `blazor-error-ui`.** The yellow bar reading "An unhandled error has occurred" is a component exception, which also tears the circuit down. If you see both, fix the exception first: every unhandled exception in a component terminates the circuit, and the reconnect that follows is always `rejected`.
- **Only the first matching element gets the classes.** If a layout and a page both render an element with `id="components-reconnect-modal"`, only the first one Blazor finds is toggled, and the second looks broken.
- **The 500 ms delay is deliberate.** Blazor waits about half a second before showing the modal so a transient blip does not flash the UI. Lengthen it with CSS, `transition: visibility 0s linear 1000ms`, rather than with JavaScript.
- **`Reconnection failed` and `Could not reconnect` are different states.** The first should call `Blazor.reconnect()`, the second must call `location.reload()`. Wiring both to the same handler produces either an infinite retry loop or a reload that throws away recoverable state.
- **`_blazor` returning 404 or 400 is not this bug.** That is the hub endpoint not being mapped or a proxy stripping the upgrade headers, and no reconnect will ever succeed.
- **The parked-tab case is now upgradeable.** Reconnecting a two-hour-old tab was never possible with in-memory circuits alone. On .NET 10 and later it is, with `[PersistentState]`.

## Related

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) covers the hosting-model tradeoff that puts you on circuits in the first place.
- [How to persist state across the Blazor static-to-interactive render boundary in .NET 11](/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) is the full treatment of `[PersistentState]` and `PersistentComponentState`.
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) sets up the distributed cache that backs circuit persistence across instances.
- [Fix: JavaScript interop calls cannot be issued at this time (Blazor prerendering)](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) is the other Blazor error that comes from misreading which render pass you are in.
- [Migrate a Blazor Server app to Blazor United (Blazor Web App) in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) is the path to the template that ships the customizable `ReconnectModal` component.

## Sources

- Microsoft Learn, [ASP.NET Core Blazor SignalR guidance](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/signalr?view=aspnetcore-11.0) (reconnect CSS classes, the `components-reconnect-state-changed` event table, `MaximumReceiveMessageSize`, hub timeouts, session affinity).
- Microsoft Learn, [ASP.NET Core Blazor server-side state management](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/server?view=aspnetcore-11.0) (circuit state persistence defaults, `PersistedCircuitInMemoryRetentionPeriod`, pause and resume, `Circuit.RequestCircuitPauseAsync`).
- Microsoft Learn, [CircuitOptions.DisconnectedCircuitRetentionPeriod](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.components.server.circuitoptions.disconnectedcircuitretentionperiod) (the 3-minute default).
- dotnet/aspnetcore, [`CircuitStartOptions.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/CircuitStartOptions.ts) (`maxRetries` of 30 and the 0 ms / 5 s / 30 s tiers in `computeDefaultRetryInterval`; the .NET 8 branch has `maxRetries: 8` and `retryIntervalMilliseconds: 20000`).
- dotnet/aspnetcore, [`DefaultReconnectDisplay.ts`](https://github.com/dotnet/aspnetcore/blob/main/src/Components/Web.JS/src/Platform/Circuits/DefaultReconnectDisplay.ts) (the exact modal strings in each state, on both the .NET 8 and current branches).
- dotnet/aspnetcore, [`ReconnectModal.razor.js` in the Blazor Web App template](https://github.com/dotnet/aspnetcore/blob/main/src/ProjectTemplates/Web.ProjectTemplates/content/BlazorWeb-CSharp/BlazorWebCSharp.1/Components/Layout/ReconnectModal.razor.js) (the `Blazor.reconnect()` then `Blazor.resumeCircuit()` then `location.reload()` sequence and the `visibilitychange` retry).
