---
title: "How to persist state across the Blazor static-to-interactive render boundary in .NET 11"
description: "A prerendered Blazor component runs its initialization twice and loses state at the interactive handoff. Fix it with the [PersistentState] attribute or the PersistentComponentState service in .NET 11."
pubDate: 2026-06-09
template: how-to
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "csharp"
  - "ssr"
---

A Blazor component on the Blazor Web App template runs its initialization twice: once during prerendering (static server-side rendering) and again when the component renders interactively. Anything you fetched or computed in `OnInitializedAsync` the first time is gone by the second, so the component refetches, and the user sees the prerendered UI flicker as it gets replaced. The fix is to capture that state during prerendering and hand it across the boundary. In .NET 11 you have two ways to do it: the declarative `[PersistentState]` attribute (the easy path, available since .NET 10) and the imperative `PersistentComponentState` service (available since .NET 8, for anything the attribute cannot express). This post targets .NET 11 (preview at time of writing, GA scheduled November 2026) and the `Microsoft.AspNetCore.Components` 11.0.x package set.

## Why the component initializes twice

The Blazor Web App template renders a page in two passes. The first pass is prerendering: the server runs your component as static HTML, executes `OnInitialized` / `OnInitializedAsync`, and ships the resulting markup so the page paints fast and indexes well. The second pass is interactivity: once the runtime starts (a SignalR circuit for `InteractiveServer`, the downloaded WASM payload for `InteractiveWebAssembly`, or either for `InteractiveAuto`), Blazor instantiates a fresh copy of the component and runs initialization a second time.

That second instance does not inherit any field you set during prerendering. It starts from defaults. If your initialization looked like this:

```razor
@* PrerenderedCounter1.razor *@
@* .NET 11, Blazor Web App, any interactive render mode *@
@page "/prerendered-counter-1"
@inject ILogger<PrerenderedCounter1> Logger

<p role="status">Current count: @currentCount</p>

@code {
    private int currentCount;

    protected override void OnInitialized()
    {
        currentCount = Random.Shared.Next(100);
        Logger.LogInformation("currentCount set to {Count}", currentCount);
    }
}
```

you will see `currentCount set to 41` during prerendering and `currentCount set to 92` a moment later when the component goes interactive, with a visible flip from 41 to 92 in the browser. With a random number it is just a curiosity. With a database call it is a duplicated query, a slower time-to-interactive, and a real flicker between the prerendered value and the refetched one.

This is specifically the prerender-to-interactive boundary. If your `Routes` component has no render mode and you reach the page through an internal [enhanced navigation](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing), prerendering does not happen at all, so initialization runs once and there is nothing to persist. To reproduce the double-init you need a full page load.

## The declarative fix: the `[PersistentState]` attribute

The cleanest way to carry state across the boundary in .NET 11 is to put it on a public property and annotate it with `[PersistentState]`. Blazor serializes the property into the prerendered HTML, then deserializes it back into the interactive instance before initialization. Your job is just to detect whether the value was restored:

```razor
@* PrerenderedCounter2.razor *@
@* .NET 11 / .NET 10. [PersistentState] requires aspnetcore 10.0+ *@
@page "/prerendered-counter-2"
@inject ILogger<PrerenderedCounter2> Logger

<p role="status">Current count: @CurrentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    [PersistentState]
    public int? CurrentCount { get; set; }

    protected override void OnInitialized()
    {
        if (CurrentCount is null)
        {
            CurrentCount = Random.Shared.Next(100);
            Logger.LogInformation("CurrentCount set to {Count}", CurrentCount);
        }
        else
        {
            Logger.LogInformation("CurrentCount restored to {Count}", CurrentCount);
        }
    }

    private void IncrementCount() => CurrentCount++;
}
```

Now the log reads `CurrentCount set to 96` during prerendering and `CurrentCount restored to 96` when interactivity kicks in. Same value, no second `Random.Shared.Next`, no flicker.

Three rules make this work and they are easy to trip over:

1. **The property must be `public`.** The framework uses reflection on it for serialization, trimming analysis, and source generation. A `private` field with the attribute will not be picked up.
2. **Use a nullable or default-detectable type.** You need to distinguish "restored" from "never set." A nullable (`int?`, `WeatherForecast[]?`) is the idiomatic signal. For reference types, `null` means prerendering needs to populate it.
3. **Populate only when null.** The `if (CurrentCount is null)` guard is what keeps the expensive work on the prerender pass and skips it on the interactive pass.

The realistic version is a data load. Fetch on prerender, reuse on interactive:

```razor
@* ContactList.razor -- .NET 11, InteractiveAuto render mode *@
@page "/contacts"
@inject IContactService Contacts

@if (Items is null)
{
    <p>Loading...</p>
}
else
{
    <ul>@foreach (var c in Items) { <li>@c.Name</li> }</ul>
}

@code {
    [PersistentState]
    public IReadOnlyList<Contact>? Items { get; set; }

    protected override async Task OnInitializedAsync()
    {
        // Runs the query on the prerender pass; the interactive pass
        // gets Items back already populated and skips the call.
        Items ??= await Contacts.GetAllAsync();
    }
}
```

### Keeping state attached to the right instance

When a page renders several components of the same type in a loop, persisted state has to be matched back to the correct instance. Use the `@key` directive so Blazor can line up the serialized blobs with the right component:

```razor
@* Parent.razor -- .NET 11 *@
@page "/parent"

@foreach (var element in elements)
{
    <PersistentChild @key="element.Name" />
}
```

Inside `PersistentChild`, the `[PersistentState]` property is restored per key. Without `@key`, two instances can end up swapping or dropping their state.

### Read-only data and enhanced navigation

By default, persisted state is loaded only when an interactive component first appears on the page. That is deliberate: it stops a later enhanced navigation to the same page from clobbering live state such as a half-edited form. If your state is read-only and cheap to be wrong about for a moment (cached data that rarely changes), opt in to updates during enhanced navigation with `AllowUpdates`:

```csharp
// .NET 11 -- allow the value to refresh on enhanced navigation
[PersistentState(AllowUpdates = true)]
public WeatherForecast[]? Forecasts { get; set; }

protected override async Task OnInitializedAsync()
{
    Forecasts ??= await ForecastService.GetForecastAsync();
}
```

Note that cross-enhanced-navigation persistence is a .NET 10+ capability. On .NET 8 and .NET 9 the `PersistentComponentState` service only delivered state on the initial page load, never across an enhanced navigation on an already-running circuit. If you depend on that behavior, .NET 11 is where it works cleanly.

### Skipping restore in specific situations

.NET 10 added a second job for `[PersistentState]`: persisting state when an `InteractiveServer` circuit is evicted and restoring it on reconnect, so a dropped connection no longer wipes component state. That introduces two cases where you may want to opt out of a restore. `RestoreBehavior` controls them:

```csharp
// Do not restore the prerendered value (start fresh on interactivity)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipInitialValue)]
public string? NoPrerenderedData { get; set; }

// Do not restore the last snapshot on reconnection (force fresh data after a reconnect)
[PersistentState(RestoreBehavior = RestoreBehavior.SkipLastSnapshot)]
public int CounterNotRestoredOnReconnect { get; set; }
```

## The imperative fix: the `PersistentComponentState` service

The attribute covers most cases, but sometimes you need to persist something that is not a single property: a value derived from several fields, a key you compute at runtime, or state you only persist under certain conditions. Inject the `PersistentComponentState` service and register a callback. This is the original .NET 8 mechanism and it still works in .NET 11 exactly as before:

```razor
@* PrerenderedCounter3.razor -- .NET 11, PersistentComponentState service *@
@page "/prerendered-counter-3"
@implements IDisposable
@inject ILogger<PrerenderedCounter3> Logger
@inject PersistentComponentState ApplicationState

<p role="status">Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

@code {
    private int currentCount;
    private PersistingComponentStateSubscription persistingSubscription;

    protected override void OnInitialized()
    {
        if (!ApplicationState.TryTakeFromJson<int>(
            nameof(currentCount), out var restoredCount))
        {
            currentCount = Random.Shared.Next(100);
            Logger.LogInformation("currentCount set to {Count}", currentCount);
        }
        else
        {
            currentCount = restoredCount!;
            Logger.LogInformation("currentCount restored to {Count}", currentCount);
        }

        // Register LAST to avoid a race condition at app shutdown.
        persistingSubscription = ApplicationState.RegisterOnPersisting(PersistCount);
    }

    private Task PersistCount()
    {
        ApplicationState.PersistAsJson(nameof(currentCount), currentCount);
        return Task.CompletedTask;
    }

    private void IncrementCount() => currentCount++;

    void IDisposable.Dispose() => persistingSubscription.Dispose();
}
```

The shape is always the same:

1. `TryTakeFromJson<T>("key", out var value)` first. If it returns `true`, you are on the interactive pass and the value was restored. If `false`, you are on the prerender pass and need to produce the value.
2. Register a persist callback with `RegisterOnPersisting`, and inside it call `PersistAsJson("key", value)`. Register it at the **end** of initialization to avoid a race during app shutdown.
3. Dispose the `PersistingComponentStateSubscription` so the callback does not leak. Implementing `IDisposable` is not optional here.

If you need to control restoration imperatively the same way `RegisterOnPersisting` controls persistence, .NET 10 added `RegisterOnRestoring`, which lets you hook the restore step. That pairs naturally with the circuit-reconnection scenarios above.

## Persisting state that lives in a service, not a component

State does not always belong to a component. If a scoped DI service holds the data, you can persist its properties too. Mark the property with `[PersistentState]` and register the service for persistence with `RegisterPersistentService`, telling Blazor which render mode it applies to (the render mode cannot be inferred from the service type):

```csharp
// CounterTracker.cs -- .NET 11
public class CounterTracker
{
    [PersistentState]
    public int CurrentCount { get; set; }

    public void IncrementCount() => CurrentCount++;
}
```

```csharp
// Program.cs -- .NET 11
using Microsoft.AspNetCore.Components.Web;

builder.Services.AddScoped<CounterTracker>();

builder.Services.AddRazorComponents()
    .RegisterPersistentService<CounterTracker>(RenderMode.InteractiveAuto);
```

Only scoped services are supported. The render mode argument (`RenderMode.Server`, `RenderMode.Webassembly`, or `RenderMode.InteractiveAuto`) decides which interactive contexts get the deserialized state. Because serialization works off the actual instance, you can mark an abstraction as the persistent service and keep the concrete implementation internal, which is handy when the prerender server and the WebAssembly client share an interface but not the implementation.

## What goes over the wire, and the security line you cannot cross

The persisted state is embedded in the HTML and transferred to the client. Where that lands depends on the render mode, and this is the one mistake that turns a convenience into a leak:

- **`InteractiveServer`**: the state round-trips through the browser but is protected by [ASP.NET Core Data Protection](https://learn.microsoft.com/en-us/aspnet/core/security/data-protection/introduction), so it is encrypted in transit.
- **`InteractiveWebAssembly` and `InteractiveAuto`**: the state is exposed to the browser in the clear, because WebAssembly code runs on the client and needs to read it. The `Auto` mode can resolve to WebAssembly, so treat it like the CSR case.

The rule: never put anything private in persisted state on a WebAssembly or Auto component. Persist the contact list, not the access token. If you need server-only secrets, keep them server-side and fetch them after interactivity, or stay on `InteractiveServer`.

## Serialization, trimming, and Native AOT

By default `[PersistentState]` and `PersistAsJson` serialize with `System.Text.Json` using default settings. That has two consequences worth planning for.

First, the default serializer is not trimmer-safe. If you publish with IL trimming or [Native AOT](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), you must preserve the types you persist or the round-trip will fail at runtime once the metadata is trimmed away. Wire up a `JsonSerializerContext` source generator for your persisted types, the same discipline you would apply when [writing a custom JsonConverter for System.Text.Json](/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/).

Second, if the default JSON shape does not suit you (a compact binary format, a legacy encoding, a type System.Text.Json handles awkwardly), .NET 10 introduced `PersistentComponentStateSerializer<T>` so you can take over serialization for a specific type:

```csharp
// Registered in Program.cs; applies to int? persisted state
builder.Services.AddSingleton<PersistentComponentStateSerializer<int?>,
    CustomIntSerializer>();
```

The serializer implements `Persist(T value, IBufferWriter<byte> writer)` and `Restore(ReadOnlySequence<byte> data)`. Without a registered custom serializer for a type, Blazor falls back to JSON, so you only implement this for the types that need it.

## Components embedded in Razor Pages or MVC

One gotcha that does not apply to the Blazor Web App template but bites people embedding Blazor into an existing app: if you drop interactive components into a Razor Pages or MVC view, the persist mechanism needs the tag helper added by hand. Put `<persist-component-state />` just before the closing `</body>` in your layout:

```cshtml
@* Pages/Shared/_Layout.cshtml -- only needed for Razor Pages / MVC hosts *@
<body>
    ...
    <persist-component-state />
</body>
```

Pure Blazor Web App projects wire this up automatically; you only need the tag helper in the mixed-hosting case.

## Picking between the two models

Reach for `[PersistentState]` first. It is less code, it handles the prerender boundary and circuit reconnection for free, and `AllowUpdates` plus `RestoreBehavior` cover the common variations declaratively. Drop to the `PersistentComponentState` service when the unit of state is not a single public property, when you compute the persistence key at runtime, or when you need to persist conditionally inside the callback. Both can coexist in the same app, and both solve the same underlying problem: making sure the work you did during prerendering survives the jump to interactivity instead of running all over again.

If you are still deciding which render modes your pages should use, the trade-offs in [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) frame where prerendering even applies, and if you are moving an older app onto this model, the [Blazor Server to Blazor Web App migration checklist](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) calls out prerendering double-execution as the single thing that bites. For passing one-time messages rather than persisting render state, [Blazor SSR's TempData support in .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) is the right tool instead.

Primary source: [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/en-us/aspnet/core/blazor/state-management/prerendered-state-persistence?view=aspnetcore-11.0) on Microsoft Learn, which documents the `[PersistentState]` attribute, the `PersistentComponentState` service, `RegisterPersistentService`, and the `PersistentComponentStateSerializer<T>` extensibility point for .NET 10 and .NET 11.
