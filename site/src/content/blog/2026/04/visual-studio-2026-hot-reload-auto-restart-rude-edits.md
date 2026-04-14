---
title: "Hot Reload Auto-Restart in Visual Studio 2026: Rude Edits Stop Killing Your Debug Session"
description: "Visual Studio 2026 adds HotReloadAutoRestart, a project-level opt-in that restarts the app when a rude edit would otherwise end the debug session. It is especially useful for Razor and Aspire projects."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "visual-studio"
  - "hot-reload"
  - "razor"
---

One of the quieter wins in the Visual Studio 2026 March update is [Hot Reload auto-restart for rude edits](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload). A "rude edit" is a change the Roslyn EnC engine cannot apply in-process: modifying a method signature, renaming a class, swapping a base type. Until now the only honest answer was to stop the debugger, rebuild, and attach again. In .NET 10 projects with Visual Studio 2026 you can opt into a much better default: the IDE restarts the process for you and keeps the debug session going.

## Opting in with a single property

The feature is gated on a project-level MSBuild property, which means you can turn it on selectively for the projects where a process restart is cheap, like ASP.NET Core APIs, Blazor Server apps, or Aspire orchestrations, and leave it off for heavy desktop hosts.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

You can also hoist it into a `Directory.Build.props` so an entire solution opts in at once:

```xml
<Project>
  <PropertyGroup>
    <HotReloadAutoRestart>true</HotReloadAutoRestart>
  </PropertyGroup>
</Project>
```

When the property is set, rude edits trigger a targeted rebuild of the changed project and its dependents, a new process is launched, and the debugger reattaches. The non-restarted projects stay running, which matters a lot in Aspire: your Postgres container and your worker service do not need to bounce just because you renamed a controller method.

## Razor finally feels fast

The second half of the update is the Razor compiler. In previous versions, the Razor build lived in a separate process and a Hot Reload on a `.razor` file could take tens of seconds while the compiler cold-started. In Visual Studio 2026 the Razor compiler is co-hosted inside the Roslyn process, so editing a `.razor` file during Hot Reload is effectively free.

A small example to illustrate what now survives Hot Reload without a full restart:

```razor
@page "/counter"
@rendermode InteractiveServer

<h1>Counter: @count</h1>
<button @onclick="Increment">+1</button>

@code {
    private int count;

    private void Increment() => count++;
}
```

Changing the `<h1>` text, tweaking the lambda, or adding a second button keeps working with Hot Reload. If you now refactor `Increment` into an `async Task IncrementAsync()` (a rude edit because the signature changed), auto-restart kicks in, the process bounces, and you are back at `/counter` without touching the debugger toolbar.

## What to watch out for

Auto-restart does not preserve in-process state. If your debugging loop depends on a warm cache, an authenticated session, or a SignalR connection, you will lose it on restart. Two practical mitigations:

1. Move expensive warmup into `IHostedService` implementations that are cheap to re-run, or back them with a shared cache.
2. Use a [custom Hot Reload handler](https://learn.microsoft.com/en-us/visualstudio/debugger/hot-reload) via `MetadataUpdateHandlerAttribute` to clear and reseed caches when an update is applied.

```csharp
[assembly: MetadataUpdateHandler(typeof(MyApp.CacheResetHandler))]

namespace MyApp;

internal static class CacheResetHandler
{
    public static void UpdateApplication(Type[]? updatedTypes)
    {
        AppCache.Clear();
        AppCache.Warm();
    }
}
```

For Blazor and Aspire teams the combined effect is the biggest Hot Reload quality-of-life jump since the feature shipped. One MSBuild property, one co-hosted compiler, and the "stop, rebuild, re-attach" ritual that ate five minutes a dozen times a day finally goes away.
