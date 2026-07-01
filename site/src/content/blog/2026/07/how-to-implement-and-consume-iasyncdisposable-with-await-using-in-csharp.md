---
title: "How to implement and consume IAsyncDisposable with await using in C#"
description: "A complete guide to IAsyncDisposable in C#: when to use await using, how to write DisposeAsync and DisposeAsyncCore correctly, and the stacking and ConfigureAwait gotchas that leak resources."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "idisposable"
---

When a type holds a resource that can only be released asynchronously (a network stream that has to flush, a database transaction that has to commit or roll back, a channel writer that has to drain), `IDisposable` is the wrong contract. Its `Dispose()` method is synchronous, so the only way to run async cleanup from it is to block on a `Task`, which risks deadlocks and thread-pool starvation. C# 8.0 (shipped with .NET Core 3.0) added `IAsyncDisposable` and the `await using` statement precisely for this case. This post covers both sides: how to consume an async-disposable type with `await using`, and how to implement `DisposeAsync` correctly, including the `DisposeAsyncCore` pattern and the two gotchas (stacking and `ConfigureAwait`) that quietly leak resources. All examples target .NET 11 and C# 14, but the API and semantics are unchanged since C# 8.0.

## Why a synchronous Dispose is not enough

`IDisposable.Dispose()` returns `void`. If your cleanup needs to `await` (flush a buffer to a socket, send a final frame, commit a transaction), you have three bad options inside a synchronous `Dispose`: block with `.GetAwaiter().GetResult()`, block with `.Wait()`, or fire-and-forget and hope it finishes. The first two can deadlock in contexts with a single-threaded synchronization context and will tie up a thread-pool thread for the duration of the I/O; the third loses errors and can dispose the underlying handle before the async work completes.

`IAsyncDisposable` fixes this by making the cleanup itself awaitable:

```csharp
// System namespace, available since .NET Core 3.0 / C# 8.0
public interface IAsyncDisposable
{
    ValueTask DisposeAsync();
}
```

Note the return type is `ValueTask`, not `Task`. Disposal frequently completes synchronously (nothing to flush), and `ValueTask` avoids allocating a `Task` object on that common path. You almost never `await` a raw `DisposeAsync()` call yourself; the compiler does it for you through `await using`.

## Consuming an async-disposable with await using

The consumer side is the part you will write most often, because the framework already implements `IAsyncDisposable` on the types you care about: `Stream`, `FileStream`, `DbConnection`, `DbTransaction`, `Utf8JsonWriter`, `ChannelWriter<T>` wrappers, `ServiceProvider`, and more.

There are two forms. The `await using` statement scopes cleanup to an explicit block:

```csharp
// .NET 11, C# 14
await using (var stream = new FileStream("data.bin", FileMode.Open))
{
    await stream.ReadAsync(buffer);
} // DisposeAsync() is awaited here, at the closing brace
```

The `await using` declaration scopes cleanup to the end of the enclosing block, with no extra nesting:

```csharp
// .NET 11, C# 14
static async Task ProcessAsync()
{
    await using var stream = new FileStream("data.bin", FileMode.Open);

    await stream.ReadAsync(buffer);

    // DisposeAsync() is awaited when ProcessAsync's body exits,
    // whether by return or by an exception.
}
```

Both require the enclosing method to be `async`, because `await using` inserts an `await` at the disposal point. If you write `await using` in a non-async method you get a compile error, and if you accidentally drop the `await` and write plain `using` on an `IAsyncDisposable`, the compiler calls the synchronous `Dispose()` if the type also implements `IDisposable`, or fails to compile if it only implements `IAsyncDisposable`. That silent fallback to synchronous disposal is a real bug source: always reach for `await using` when the type is async-disposable.

A common idiom you will see with EF Core and ADO.NET stacks two `await`s on one line, one for the factory call and one hidden in the disposal:

```csharp
// .NET 11, C# 14 -- EF Core 11
await using var transaction = await context.Database.BeginTransactionAsync(token);

await context.SaveChangesAsync(token);
await transaction.CommitAsync(token);
// If CommitAsync is not reached (exception), DisposeAsync rolls back.
```

The first `await` unwraps the `Task<IDbContextTransaction>` from `BeginTransactionAsync`; the `await using` arranges for `DisposeAsync` to be awaited when the block exits. If an exception skips `CommitAsync`, the transaction's `DisposeAsync` rolls back for you.

## Implementing IAsyncDisposable when the class is sealed

If your type is `sealed` (or you are confident it will never be subclassed), the implementation is short. Just release your resources in `DisposeAsync`:

```csharp
// .NET 11, C# 14
public sealed class MetricsFlusher : IAsyncDisposable
{
    private readonly Channel<Metric> _channel = Channel.CreateUnbounded<Metric>();
    private readonly HttpClient _http;

    public MetricsFlusher(HttpClient http) => _http = http;

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.Complete();

        // Drain and ship whatever is buffered before we go away.
        await foreach (var metric in _channel.Reader.ReadAllAsync())
        {
            await _http.PostAsJsonAsync("/metrics", metric);
        }
    }
}
```

Because the class is `sealed`, there is no derived type to cascade cleanup to, so you do not need the `DisposeAsyncCore` split described next, and you do not need `GC.SuppressFinalize` unless the class also declares a finalizer (a sealed class that owns only managed async resources rarely does).

## Implementing the full async dispose pattern for a base class

The moment your class is *not* sealed, Microsoft's guidance changes. Any non-sealed class is a potential base class, and a derived class needs a hook to add its own async cleanup and have it composed with the base class's cleanup. That hook is a `protected virtual ValueTask DisposeAsyncCore()` method. `DisposeAsync` becomes boilerplate that calls `DisposeAsyncCore`, suppresses finalization, and returns:

```csharp
// .NET 11, C# 14
public class ExampleAsyncDisposable : IAsyncDisposable
{
    private IAsyncDisposable? _inner = new SomeAsyncResource();

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_inner is not null)
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        _inner = null;
    }
}
```

A derived class overrides `DisposeAsyncCore`, cleans up its own resources, and chains to `base.DisposeAsyncCore()`. It never touches `DisposeAsync`, so the `GC.SuppressFinalize(this)` call runs exactly once, at the most-derived level. This mirrors the synchronous `Dispose()` / `protected virtual void Dispose(bool)` pattern, just with `ValueTask` return types and no `bool disposing` parameter (there is no finalizer path to distinguish in the pure-async case).

## Supporting both IDisposable and IAsyncDisposable

It is common to implement both interfaces, so callers using synchronous `using` and callers using `await using` both get correct cleanup. The critical detail: if you implement only `IAsyncDisposable` and a caller wraps your object in a plain `using` (or hands it to a container that only knows about `IDisposable`), your `DisposeAsync` never runs and you leak the resource. Microsoft calls this out explicitly as a caution.

The dual pattern routes both entry points through shared logic and uses `Dispose(false)` from the async path so managed resources are not disposed twice:

```csharp
// .NET 11, C# 14
public class DualDisposable : IDisposable, IAsyncDisposable
{
    private Stream? _managed = new MemoryStream();
    private IAsyncDisposable? _asyncOnly = new SomeAsyncResource();

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        Dispose(disposing: false); // false: async path already handled managed async resources
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (disposing)
        {
            _managed?.Dispose();
            _managed = null;

            if (_asyncOnly is IDisposable d)
            {
                d.Dispose();
                _asyncOnly = null;
            }
        }
    }

    protected virtual async ValueTask DisposeAsyncCore()
    {
        if (_asyncOnly is not null)
        {
            await _asyncOnly.DisposeAsync().ConfigureAwait(false);
        }

        if (_managed is IAsyncDisposable ad)
        {
            await ad.DisposeAsync().ConfigureAwait(false);
        }
        else
        {
            _managed?.Dispose();
        }

        _asyncOnly = null;
        _managed = null;
    }
}
```

The `DisposeAsync` path passes `false` to `Dispose(bool)` because `DisposeAsyncCore` already disposed the managed resources asynchronously; passing `true` would try to dispose them a second time. This keeps the two paths functionally equivalent without double-disposing.

## The stacking gotcha that skips DisposeAsync

This one bites people who try to be tidy. You cannot "stack" `await using` statements the way you can stack synchronous `using` statements, because if a constructor after the first throws, objects created earlier never get disposed:

```csharp
// .NET 11, C# 14 -- DO NOT DO THIS
var one = new ExampleAsyncDisposable();
var two = new AnotherAsyncDisposable(); // if this constructor throws...

await using (one.ConfigureAwait(false))
await using (two.ConfigureAwait(false))
{
    // ...neither one nor two has DisposeAsync called.
}
```

The problem is that the objects are constructed *before* the `await using` blocks are entered, so an exception between construction and the block leaves them un-disposed. The fix is to construct and scope in the same step. Any of these three shapes is safe:

```csharp
// .NET 11, C# 14 -- nested blocks
var one = new ExampleAsyncDisposable();
await using (one.ConfigureAwait(false))
{
    var two = new AnotherAsyncDisposable();
    await using (two.ConfigureAwait(false))
    {
        // two is disposed first, then one
    }
}

// .NET 11, C# 14 -- sequential declarations (cleanest)
await using var a = new ExampleAsyncDisposable();
await using var b = new AnotherAsyncDisposable();
// b is disposed before a at the end of the method
```

Prefer the declaration form. If a constructor throws, the compiler-generated cleanup for the already-declared variables still runs, and you avoid the whole class of stacking bugs.

## ConfigureAwait on await using

Inside library code you often want `ConfigureAwait(false)` so the disposal continuation does not capture the original synchronization context. You cannot just append it to the object; there is a dedicated extension, `ConfigureAwait(IAsyncDisposable, bool)`, that returns a `ConfiguredAsyncDisposable`:

```csharp
// .NET 11, C# 14
await using (stream.ConfigureAwait(false))
{
    await stream.ReadAsync(buffer);
}
```

In application code with no synchronization context to capture (ASP.NET Core, console apps, worker services), you can omit it; it has no effect there. In a library that might be called from a UI or legacy ASP.NET context, add it, matching the same reasoning you use for `ConfigureAwait(false)` on ordinary awaits.

## Where you do not have to dispose at all

Dependency injection handles this for you. When you register a service in an `IServiceCollection`, the container tracks whether the resolved instance implements `IDisposable` or `IAsyncDisposable` and disposes it at the end of its scope. A scoped service that implements `IAsyncDisposable` gets `DisposeAsync` awaited when the request scope ends, provided the scope itself was created and disposed asynchronously (ASP.NET Core does this). You do not write `await using` on injected services; you let the container own their lifetime. Manually disposing an injected service is a bug that can dispose it out from under other consumers.

## When to reach for IAsyncDisposable

Use it when disposal genuinely has to do I/O: flushing a buffered writer to a socket or file, committing or rolling back a transaction, completing and draining a [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/), or gracefully closing a long-lived connection. Do not add it to a type whose cleanup is purely synchronous (freeing a handle, clearing a field); a plain `IDisposable` is simpler and does not force every caller into an async method. And if your type produces an async stream, pair it with [IAsyncEnumerable&lt;T&gt;](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) rather than trying to bolt streaming onto disposal.

Async disposal is one piece of the broader async-correctness story. If your `DisposeAsync` does real work, thread a cancellation-aware timeout through it the same way you would [time out any async operation with CancellationTokenSource.CancelAfter](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/), and make sure you [propagate a CancellationToken through your async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) so cleanup can be bounded. When cleanup involves stopping in-flight work, the same discipline that lets you [cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) applies here.

Get the two rules right and async disposal is boring in the best way: use `await using` on the consuming side, and on the implementing side split `DisposeAsync` from `DisposeAsyncCore` for non-sealed types, implement `IDisposable` too if a synchronous caller might dispose you, and never stack `await using` blocks.

## Sources

- [Implement a DisposeAsync method (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync)
- [IAsyncDisposable interface (MS Learn API reference)](https://learn.microsoft.com/en-us/dotnet/api/system.iasyncdisposable)
- [using statement and declaration (C# language reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/statements/using)
- [ConfigureAwait FAQ (.NET Blog)](https://devblogs.microsoft.com/dotnet/configureawait-faq/)
