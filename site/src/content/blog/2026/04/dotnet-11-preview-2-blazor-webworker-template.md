---
title: "dotnet new webworker: first-class Web Workers for Blazor in .NET 11 Preview 2"
description: "A new project template in .NET 11 Preview 2 scaffolds the JS plumbing, WebWorkerClient, and JSExport boilerplate needed to run .NET code in a browser Web Worker."
pubDate: 2026-04-05
tags:
  - ".NET 11"
  - "Blazor"
  - "WebAssembly"
  - "Web Workers"
  - "ASP.NET Core"
---

Running CPU-heavy work in Blazor WebAssembly has always had the same nasty side effect: the UI thread stalls, animations jank, and the user suspects their browser has crashed. In [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) the team shipped a proper fix for that problem in the shape of a brand new project template, `dotnet new webworker`, which scaffolds every piece of plumbing you previously had to hand-roll.

## What the template actually gives you

The template produces a Razor class library targeting `net11.0` that contains:

1. The JavaScript bootstrapper that spins up a dedicated Web Worker and boots the .NET runtime inside it.
2. A `WebWorkerClient` C# type that hides the `postMessage` interop layer.
3. A sample `[JSExport]` method you can call from any component.

The important detail is that none of this depends on Blazor itself. The template works for standalone `wasmbrowser` apps, custom JS frontends, and Blazor WebAssembly alike. You wire it up with a single call:

```bash
dotnet new blazorwasm -n SampleApp
dotnet new webworker -n WebWorker
dotnet sln SampleApp.sln add WebWorker/WebWorker.csproj
dotnet add SampleApp/SampleApp.csproj reference WebWorker/WebWorker.csproj
```

## Defining a worker method

Worker methods are plain static methods decorated with `[JSExport]`. The runtime inside the worker sees them by their fully qualified name.

```csharp
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;

namespace WebWorker;

public static partial class PrimesWorker
{
    [JSExport]
    public static string ComputePrimes(int limit)
    {
        var primes = new List<int>();
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) primes.Add(n);
        }

        return JsonSerializer.Serialize(new { Count = primes.Count, Last = primes[^1] });
    }
}
```

`[JSExport]` methods are still limited to primitives and strings as return types, so anything non-trivial needs a JSON round-trip. The `WebWorkerClient` automatically deserializes the result for you on the other side.

## Calling it from a Blazor component

This is the part that used to be 200 lines of interop. In .NET 11 it is three:

```razor
@inject IJSRuntime JS

<button @onclick="Run">Find primes</button>
<p>@status</p>

@code {
    string status = "";

    async Task Run()
    {
        await using var worker = await WebWorkerClient.CreateAsync(JS);
        var result = await worker.InvokeAsync<PrimeResult>(
            "WebWorker.PrimesWorker.ComputePrimes",
            args: new object[] { 2_000_000 });

        status = $"Found {result.Count}, last was {result.Last}";
    }

    record PrimeResult(int Count, int Last);
}
```

`WebWorkerClient.CreateAsync` boots the worker, waits for the .NET runtime inside it to be ready, and returns a client you invoke by fully qualified method name. The main thread never blocks, so your `StateHasChanged` calls keep the UI smooth while two million numbers get factored on a background OS thread.

## Why this matters

Before .NET 11 the Blazor community relied on third-party packages like [Tewr/BlazorWorker](https://github.com/Tewr/BlazorWorker) or rolled a bespoke `JSImport`/`JSExport` bridge every time. The new template removes that class of boilerplate entirely, ships as the blessed path from Microsoft, and composes with the existing JSImport/JSExport source generators. If you have been postponing background work in Blazor because the plumbing cost was too high, Preview 2 is the release that makes the cost zero. Full release notes are on the [.NET 11 Preview 2 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) and the updated [.NET on Web Workers docs](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-10.0).
