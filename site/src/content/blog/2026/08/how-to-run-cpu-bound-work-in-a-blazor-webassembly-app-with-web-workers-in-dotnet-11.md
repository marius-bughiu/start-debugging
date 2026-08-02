---
title: "How to run CPU-bound work in a Blazor WebAssembly app with Web Workers in .NET 11"
description: "A complete guide to offloading CPU-bound work off the Blazor WebAssembly UI thread in .NET 11: why Task.Run does not help, the new blazorwebworker template, the WebWorkerClient API with cancellation and timeouts, the JSExport marshalling limits, and the second-runtime cost you pay per worker."
pubDate: 2026-08-02
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "webassembly"
  - "web-workers"
  - "performance"
---

Blazor WebAssembly runs your .NET code on the browser's single UI thread, so a tight `for` loop freezes the page: no repaints, no clicks, no `StateHasChanged`. `Task.Run` does not save you, because there is no second thread to run on. The fix in .NET 11 is the `blazorwebworker` project template, which scaffolds a class library whose methods execute inside a real browser Web Worker on a separate OS thread. You mark those methods `[JSExport]`, reference the library from your app, and call them through `WebWorkerClient.InvokeAsync<TResult>`.

Everything below targets .NET 11 (Preview 6 at the time of writing, SDK `11.0.100-preview.6`) with C# 14. The template shipped in .NET 11 Preview 1 under the name `webworker` and was [renamed to `blazorwebworker`](https://github.com/dotnet/aspnetcore/pull/66070) before release; projects generated with the old name keep working, only the template ID changed. Two capabilities are new in the final .NET 11 client: `InvokeVoidAsync`, and cancellation plus timeout support on both worker creation and invocation.

## The six steps, start to finish

1. Create a worker class library with `dotnet new blazorwebworker` and reference it from the Blazor WebAssembly app.
2. Write your CPU-bound code as `static` methods marked `[JSExport]` inside a `static partial class`.
3. Return primitives or strings only; serialize anything richer to JSON inside the worker.
4. Create the `WebWorkerClient` once (not per call) and hold it for the lifetime of the component or the app.
5. Invoke methods by their fully qualified name, passing a `CancellationToken` and a timeout.
6. Dispose the client to terminate the worker and free the second runtime it loaded.

The rest of this post is about why each of those matters, and what breaks when you skip one.

## Why `Task.Run` does not move work off the UI thread

This is the first thing people try, and it is worth understanding exactly why it fails before reaching for workers.

```csharp
// .NET 11, C# 14 - Blazor WebAssembly. This still freezes the browser.
private async Task Compute()
{
    status = "Working...";
    await Task.Run(() => CountPrimes(5_000_000));
    status = "Done";
}

private static int CountPrimes(int limit)
{
    var count = 0;
    for (var n = 2; n <= limit; n++)
    {
        var isPrime = true;
        for (var d = 2; d * d <= n; d++)
        {
            if (n % d == 0) { isPrime = false; break; }
        }
        if (isPrime) count++;
    }

    return count;
}
```

The `status = "Working..."` line never renders. The browser tab stops responding for several seconds, and then both status updates land at once.

The reason is that the Blazor WebAssembly runtime is single-threaded. `Task.Run` queues work to the .NET thread pool, but on the `browser-wasm` runtime that pool is emulated on the one thread the runtime owns. The delegate does not start until the current synchronous block yields, and once it starts, nothing else can interleave until it returns. `await Task.Delay(1)` before the loop lets the first render through, but the loop still blocks everything after it.

The obvious follow-up question is whether you can just turn threads on. The runtime does support `<WasmEnableThreads>true</WasmEnableThreads>`, but that is a runtime-level feature, and Blazor WebAssembly does not support it. Blazor's renderer relies on the historical single-threaded guarantee: render batches are handed to JavaScript through zero-copy shared memory and events are dispatched into .NET synchronously. The multithreaded runtime moves all .NET code to a background "deputy thread", which breaks both assumptions. The tracking issue [dotnet/aspnetcore#54365](https://github.com/dotnet/aspnetcore/issues/54365) is still open. Setting the flag on a Blazor WASM project gets you a build that does not run, not a faster app.

So the only real option is to run a second, independent copy of the .NET runtime inside a Web Worker, and talk to it by message passing. That is exactly what the template builds.

## Creating the worker project

Two commands and a project reference:

```bash
# .NET 11 SDK
dotnet new blazorwasm -n SampleApp
dotnet new blazorwebworker -n WebWorker

cd SampleApp
dotnet add reference ../WebWorker/WebWorker.csproj
```

The generated library looks like this:

```
WebWorker/
├── WebWorker.csproj
├── WebWorkerClient.cs
├── WorkerMethods.cs
└── wwwroot/
    ├── dotnet-web-worker-client.js
    └── dotnet-web-worker.js
```

`dotnet-web-worker.js` is the worker entry point. It calls `dotnet.create()` to boot a WebAssembly runtime with no Blazor layer at all, then `getAssemblyExports(assemblyName)` to get a handle on your `[JSExport]` methods, and resolves incoming method names against that object graph. `dotnet-web-worker-client.js` runs on the main thread, spawns the worker, and correlates requests with responses by ID. `WebWorkerClient.cs` is the C# wrapper over that JavaScript client. You do not need to edit any of the three.

One project property matters and the template already sets it:

```xml
<PropertyGroup>
  <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
</PropertyGroup>
```

`[JSExport]` and `[JSImport]` generate marshalling code that uses pointers, so the compiler refuses without it. If you later add `[JSImport]` calls to the Blazor app project itself, you need the same property there.

## Writing the worker methods

Worker methods are `static`, marked `[JSExport]`, and live in a `static partial class`. The `partial` is not decorative: the JS interop source generator emits the other half. `[SupportedOSPlatform("browser")]` suppresses the platform-compatibility analyzer warnings, since these APIs only exist on the browser runtime.

`WebWorker/WorkerMethods.cs`:

```csharp
// .NET 11, C# 14
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

namespace WebWorker;

[SupportedOSPlatform("browser")]
public static partial class WorkerMethods
{
    [JSExport]
    public static int CountPrimes(int limit)
    {
        var count = 0;
        for (var n = 2; n <= limit; n++)
        {
            var isPrime = true;
            for (var d = 2; d * d <= n; d++)
            {
                if (n % d == 0) { isPrime = false; break; }
            }
            if (isPrime) count++;
        }

        return count;
    }

    [JSExport]
    public static string Analyze(string csv)
    {
        var rows = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var report = new Report(rows.Length, rows.Length == 0 ? 0 : rows.Max(r => r.Length));
        return JsonSerializer.Serialize(report);
    }
}

public record Report(int RowCount, int WidestRow);
```

Note the shape of `Analyze`. `[JSExport]` marshals a fixed set of types across the JavaScript boundary: primitives, `string`, `byte[]`, `Task<T>` of those, and a few JS-specific types. It does not marshal arbitrary POCOs or records. The standard workaround is to serialize inside the worker and deserialize on the other side, which is what the docs recommend and what the generated sample does. If your payload is a polymorphic hierarchy, the [`[JsonDerivedType]` discriminator setup](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/) applies here unchanged, because both ends are System.Text.Json.

Also worth knowing: `byte[]` does cross directly, and the generated client optimizes `ArrayBuffer` transfers so large binary results are moved rather than copied. If you are returning image or file bytes, prefer `byte[]` over base64 in a JSON string.

## Calling the worker from a component

`WebWorkerClient.CreateAsync` boots the worker and waits until the runtime inside it reports ready. That is an async operation involving a network fetch, so it belongs in `OnAfterRenderAsync`, not `OnInitializedAsync`.

`Pages/Home.razor.cs`:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using System.Runtime.Versioning;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using WebWorker;

namespace SampleApp.Pages;

[SupportedOSPlatform("browser")]
public partial class Home : ComponentBase, IAsyncDisposable
{
    private WebWorkerClient? worker;
    private string status = "Booting worker...";

    [Inject] private IJSRuntime JSRuntime { get; set; } = default!;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            worker = await WebWorkerClient.CreateAsync(JSRuntime);
            status = "Ready";
            StateHasChanged();
        }
    }

    private async Task Run()
    {
        if (worker is null) return;

        status = "Working...";

        var count = await worker.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes", [5_000_000]);

        status = $"Found {count} primes";
    }

    public async ValueTask DisposeAsync()
    {
        if (worker is not null)
        {
            await worker.DisposeAsync();
        }
    }
}
```

Now `status = "Working..."` renders immediately, the spinner spins, and the UI stays interactive while five million numbers get factored on another OS thread.

The method name is a string: `AssemblyName.ClassName.MethodName`. The worker splits it and walks the exports object returned by `getAssemblyExports`, so a typo is a runtime failure rather than a compile error. Wrapping each call in a small typed method on a service class is worth the ten lines, because it gives you one place where the magic strings live.

The `OnAfterRenderAsync` placement is not stylistic. In a Blazor Web App whose `.Client` project is prerendered on the server, JS interop is unavailable during the prerender pass, and calling into it there throws the [JavaScript interop calls cannot be issued at this time](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) error. `OnAfterRenderAsync` only runs after interactivity is established, so the worker is created exactly once, on the client.

## Cancellation and timeouts

This is the .NET 11 addition that makes the client usable in production. The full surface:

```csharp
// .NET 11
public sealed class WebWorkerClient : IAsyncDisposable
{
    public static async Task<WebWorkerClient> CreateAsync(
        IJSRuntime jsRuntime,
        int timeoutMs = 60000,
        string? assemblyName = null,
        CancellationToken cancellationToken = default);

    public async Task<TResult> InvokeAsync<TResult>(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async Task InvokeVoidAsync(
        string method,
        object[] args,
        int timeoutMs = 60000,
        CancellationToken cancellationToken = default);

    public async ValueTask DisposeAsync();
}
```

Both `timeoutMs` and the token guard the main thread's wait, not the worker's execution. A `[JSExport]` method running a synchronous loop cannot observe a `CancellationToken`, because there is no way to interrupt it from outside. What cancellation buys you is the ability to stop awaiting and tear down a stuck worker:

```csharp
// .NET 11, C# 14
private CancellationTokenSource? cts;

private async Task RunCancellable()
{
    cts?.Cancel();
    cts?.Dispose();
    cts = new CancellationTokenSource();

    try
    {
        var count = await worker!.InvokeAsync<int>(
            "WebWorker.WorkerMethods.CountPrimes",
            [5_000_000],
            timeoutMs: 10_000,
            cancellationToken: cts.Token);

        status = $"Found {count} primes";
    }
    catch (OperationCanceledException)
    {
        status = "Cancelled";

        // The worker is still busy. Kill it and start a fresh one.
        await worker.DisposeAsync();
        worker = await WebWorkerClient.CreateAsync(JSRuntime);
    }
}

private void Cancel() => cts?.Cancel();
```

Disposing after a cancellation is the important half. If you cancel the await but keep the client, the abandoned computation keeps burning a core and the next `InvokeAsync` queues behind it. `DisposeAsync` calls `terminate()` on the underlying `Worker`, which stops it immediately regardless of what it is doing. The general shape of threading a token through a call chain is covered in the guide to [propagating a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), and [`CancellationTokenSource.CancelAfter`](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) composes with `timeoutMs` if you want a client-side deadline that also fires your own cleanup.

For work whose result you do not need, `InvokeVoidAsync` skips the result round-trip:

```csharp
await worker.InvokeVoidAsync("WebWorker.WorkerMethods.WarmCaches", []);
```

## The cost: each worker downloads its own runtime

This is the part that surprises people, and it drives most of the design decisions above.

The worker does not share the main thread's runtime. It boots a second, complete .NET WebAssembly runtime: `dotnet.js`, the runtime `.wasm`, and every assembly your worker library transitively references. The browser HTTP cache means the second fetch is usually cheap after the first load, but instantiation is not free, and the memory is genuinely doubled because the two runtimes have separate heaps.

The practical rules that follow:

- **Create the client once, reuse it forever.** `CreateAsync` per button click is the single most common way to make a worker slower than the code it replaced.
- **For app-wide use, register it as a singleton** and initialize it lazily rather than creating it per component:

  ```csharp
  // .NET 11, C# 14 - Program.cs of the Blazor WebAssembly app
  builder.Services.AddSingleton<WorkerService>();
  ```

  ```csharp
  public sealed class WorkerService(IJSRuntime js) : IAsyncDisposable
  {
      private WebWorkerClient? client;
      private readonly SemaphoreSlim gate = new(1, 1);

      private async Task<WebWorkerClient> GetClientAsync(CancellationToken ct)
      {
          if (client is not null) return client;

          await gate.WaitAsync(ct);
          try
          {
              return client ??= await WebWorkerClient.CreateAsync(js, cancellationToken: ct);
          }
          finally
          {
              gate.Release();
          }
      }

      public async Task<int> CountPrimesAsync(int limit, CancellationToken ct = default)
      {
          var c = await GetClientAsync(ct);
          return await c.InvokeAsync<int>(
              "WebWorker.WorkerMethods.CountPrimes", [limit], cancellationToken: ct);
      }

      public async ValueTask DisposeAsync()
      {
          if (client is not null) await client.DisposeAsync();
          gate.Dispose();
      }
  }
  ```

  The semaphore matters because two components rendering at once will both see `client is null` and both call `CreateAsync`, giving you two runtimes where you wanted one.

- **Keep the worker library's dependency graph small.** Every package you reference from the worker project is an extra assembly downloaded and loaded into the second runtime. Put only the compute code there, not your shared model library with its EF Core and validation dependencies attached.
- **Batch calls.** Each invocation is a `postMessage` round-trip with a serialization step at both ends. Ten calls in a loop is measurably worse than one call with an array argument.

## What does not cross the boundary

The worker is a genuinely separate runtime, and treating it like a background thread in the same process is where the bugs come from.

**No shared state.** Static fields in your worker assembly exist twice: one copy in the main-thread runtime, one in the worker. Writing to a static from a component and reading it from a `[JSExport]` method returns whatever the worker's copy happens to hold. All state must travel in the arguments and the return value.

**No dependency injection.** Worker methods are static and the worker runtime never builds a service provider. If your compute code needs configuration, pass it in as arguments or as a JSON blob.

**No DOM, no `IJSRuntime`, no `NavigationManager`.** A Web Worker has no `document` and no `window`. Anything that touches the UI has to happen back on the main thread after `InvokeAsync` returns.

**No progress callbacks, out of the box.** The generated client models request and response, not streaming. If you need a progress bar for a long computation, split the work into chunks and make one call per chunk, updating the UI between calls.

## Debugging and trimming, the two rough edges

Exceptions thrown inside a `[JSExport]` method come back as a message string across `postMessage`, so the C# stack trace you get on the main thread describes the interop layer, not your loop. When a worker method misbehaves, the fastest path is usually to temporarily call the same static method directly from the component, reproduce it on the main thread with the debugger attached, and then move it back.

Trimming is the second thing to watch. Published Blazor apps trim aggressively, and the worker resolves your methods by name at runtime through `getAssemblyExports`. The `[JSExport]` attribute is what keeps those methods rooted, so an exported method is safe. Anything it reaches only through reflection is not. If a worker call works in `dotnet run` and fails after `dotnet publish`, reflection plus trimming is the first hypothesis to test, and the same [trim-safety rules that apply to Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) apply here.

Finally, be honest about whether you need this at all. If you are building a Blazor Web App rather than a standalone WebAssembly app, the server can usually do the computation faster than the client can boot a second runtime, and a plain API call is less machinery for the same result. The tradeoffs between the hosting models are laid out in the comparison of [Blazor Server, WebAssembly, and United](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/). Web Workers are the right answer when the data is already on the client, when the work is genuinely CPU-bound rather than IO-bound, and when a round trip to the server is not acceptable. For everything else, the server is still a thread pool with better hardware.

## Related

- [dotnet new webworker: first-class Web Workers for Blazor in .NET 11 Preview 2](/2026/04/dotnet-11-preview-2-blazor-webworker-template/)
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Fix: JavaScript interop calls cannot be issued at this time during Blazor prerendering](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)
- [How to serialize a polymorphic type hierarchy with JsonDerivedType in System.Text.Json](/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/)
- [How to write a Dart isolate for CPU-bound work](/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/)

## Sources

- [ASP.NET Core Blazor with .NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-with-dotnet-on-web-workers?view=aspnetcore-11.0), Microsoft Learn
- [.NET on Web Workers](https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-on-webworkers?view=aspnetcore-11.0), Microsoft Learn
- [What's new in ASP.NET Core in .NET 11: New Blazor Web Worker template](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-11?view=aspnetcore-11.0), Microsoft Learn
- [.NET Web Worker template update to Blazor Web Worker template (dotnet/aspnetcore #66070)](https://github.com/dotnet/aspnetcore/pull/66070), GitHub
- [Make Blazor WebAssembly work on multithreaded runtime (dotnet/aspnetcore #54365)](https://github.com/dotnet/aspnetcore/issues/54365), GitHub
- [JSExportAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.javascript.jsexportattribute), Microsoft Learn
- [Running background tasks in Blazor with Web Workers](https://andrewlock.net/exploring-the-dotnet-11-preview-1-running-background-tasks-in-blazor-with-web-workers/), Andrew Lock
- [Web Workers API](https://developer.mozilla.org/docs/Web/API/Web_Workers_API), MDN
