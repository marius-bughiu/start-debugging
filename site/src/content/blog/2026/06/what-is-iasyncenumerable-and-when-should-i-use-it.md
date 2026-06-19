---
title: "What is IAsyncEnumerable<T> and when should I use it?"
description: "IAsyncEnumerable<T> is the interface for asynchronous streams: a sequence whose elements arrive over time and each one may require an await. Here is what it actually is, how await foreach and yield drive it, and the rule for when to reach for it over Task<List<T>>."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "iasyncenumerable"
---

`IAsyncEnumerable<T>` is the interface for an asynchronous stream: a sequence you pull one element at a time, where producing each element may require awaiting something (a network read, a database row, a file chunk). It is the async sibling of `IEnumerable<T>`. You produce it with an iterator method that combines `yield return` and `await`, and you consume it with `await foreach`. Reach for it when you have many items that arrive over time and you do not want to buffer them all into memory before processing the first one. If you only ever produce a single result, or the whole collection is already in memory, you do not need it. This post (current as of .NET 11, C# 14) explains the mechanics, the reason the obvious alternatives fail, and the decision rule.

## The gap that `Task<T>` and `IEnumerable<T>` leave open

Line up the four shapes and the missing cell is obvious:

| | single value | many values |
| --- | --- | --- |
| **synchronous** | `T` | `IEnumerable<T>` |
| **asynchronous** | `Task<T>` | `IAsyncEnumerable<T>` |

`Task<T>` gives you one value, later. `IEnumerable<T>` gives you many values, but the act of fetching each one is synchronous: `MoveNext()` returns a `bool`, not something you can await. For years the bottom-right cell had no first-class type, and people faked it with two bad workarounds.

The first is `Task<IEnumerable<T>>` (or `Task<List<T>>`). This awaits once, then hands you the entire collection. It works, but it defeats the point of streaming: nothing is visible to your code until everything has been fetched. A query returning five million rows allocates a list of five million before your loop body runs once.

The second is `IEnumerable<Task<T>>`. This is worse. It is a synchronous sequence of tasks, which means the iterator decides the full set of work up front, and you have no natural way to apply backpressure or to stop producing tasks once a consumer loses interest. You also cannot `await` inside the `MoveNext` that produces the next task, so any per-element latency blocks the thread.

`IAsyncEnumerable<T>`, added in C# 8 and .NET Core 3.0, fills the cell properly. Each step of the iteration is itself awaitable, so the producer can await between elements and the consumer pulls the next element only when it is ready for it.

## What the interface actually looks like

There is no magic here. The contract is small:

```csharp
// System.Collections.Generic
public interface IAsyncEnumerable<out T>
{
    IAsyncEnumerator<T> GetAsyncEnumerator(
        CancellationToken cancellationToken = default);
}

public interface IAsyncEnumerator<out T> : IAsyncDisposable
{
    T Current { get; }
    ValueTask<bool> MoveNextAsync();
    ValueTask DisposeAsync();
}
```

Two details carry the whole design.

`MoveNextAsync` returns `ValueTask<bool>` rather than `Task<bool>`. That choice is deliberate. You call `MoveNextAsync` once per element, so a stream of 100,000 items means 100,000 calls. If each one allocated a `Task` object on the heap, async streams would be an allocation disaster. `ValueTask<bool>` allocates nothing when the result is already available synchronously (a buffered row, for example), which is the common case in a fast producer. You pay the heap cost only when an element genuinely has to wait.

`IAsyncEnumerator<T>` implements `IAsyncDisposable`, not `IDisposable`. Cleanup is asynchronous because closing the underlying resource (a socket, a `DbDataReader`) may itself require I/O. This is why the consuming loop needs `await foreach` and not a plain `foreach`: the disposal at the end of iteration has to be awaited.

You almost never call these members by hand. The compiler does it for you on both ends.

## Producing a stream: `yield return` meets `await`

An async iterator method is one that returns `IAsyncEnumerable<T>` and contains both `await` and `yield return`. The compiler rewrites it into a state machine that knows how to suspend at each `await` and resume on the next `MoveNextAsync`:

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var reader = new StreamReader(path);
    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Read what that gives you. Each line is read asynchronously, then yielded immediately. The caller can process line one while line two is still being read off disk. Memory never holds more than a single line plus the reader's internal buffer, regardless of whether the file is 10 lines or 10 gigabytes. The `using` on the reader is honored through the generated `DisposeAsync`, so the file handle closes when iteration ends, including when the consumer breaks early or an exception unwinds the loop.

The `[EnumeratorCancellation]` attribute on the token parameter is the part people forget. It tells the compiler that this parameter should receive the token a consumer passes via `WithCancellation`, threading external cancellation into the iterator body. Without it, the parameter is just an ordinary argument that defaults to `CancellationToken.None` and ignores whatever the consumer supplied. More on that below, because it is the single most common correctness bug with async streams.

## Consuming a stream: `await foreach`

The consumer side is one keyword longer than a normal loop:

```csharp
// .NET 11, C# 14
await foreach (var line in ReadLinesAsync("huge.log", ct))
{
    if (line.Contains("ERROR"))
        await alertSink.WriteAsync(line, ct);
}
```

The compiler expands this into calls to `GetAsyncEnumerator`, a loop of `await MoveNextAsync()` reading `Current` each turn, and an `await DisposeAsync()` in a finally block. The loop is fully sequential: element N+1 is not requested until your body finishes with element N. That sequential, demand-driven shape is the feature, not a limitation. It is what bounds memory and gives you natural backpressure: a slow consumer automatically slows the producer, because the producer's next `await` does not resume until the next `MoveNextAsync` call.

If iteration order does not matter and you want concurrency, `await foreach` is the wrong tool. Use [Parallel.ForEachAsync](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), which can consume an `IAsyncEnumerable<T>` and run the body for multiple elements at once with a degree-of-parallelism cap. `await foreach` is for ordered, one-at-a-time processing.

## Cancellation: the `WithCancellation` plus `[EnumeratorCancellation]` pair

A bare `await foreach (var x in stream)` gives you nowhere to pass a token, because the language syntax has no slot for it. The two pieces that close the loop are `WithCancellation` on the consumer and `[EnumeratorCancellation]` on the producer:

```csharp
// Producer: token parameter is tagged
public static async IAsyncEnumerable<int> ProduceAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    for (var i = 0; ; i++)
    {
        await Task.Delay(100, ct);
        yield return i;
    }
}

// Consumer: token is forwarded into GetAsyncEnumerator
await foreach (var n in ProduceAsync().WithCancellation(ct))
{
    Console.WriteLine(n);
}
```

`WithCancellation` does not wrap the sequence in another iterator or add overhead. It records the token so that when the compiler calls `GetAsyncEnumerator(token)`, the token flows in, and `[EnumeratorCancellation]` routes it to the producer's parameter. Cancel the token and the pending `await Task.Delay` throws `OperationCanceledException`, which propagates out through your `await foreach`.

Skipping the token is how you get hung background jobs and stuck requests in production: a stream over a network or database holds a connection for the entire loop, and without a token there is no way to abort it when the caller goes away. Treat `WithCancellation(ct)` as mandatory on any stream backed by I/O.

## `ConfigureAwait` works on the loop too

`await foreach` awaits internally, so it picks up synchronization-context capture the same way a normal `await` does. In library code that should not marshal back to a captured context, apply `ConfigureAwait(false)` to the whole loop with `ConfigureAwait`:

```csharp
await foreach (var item in stream.ConfigureAwait(false))
{
    Process(item);
}
```

This configures both the `MoveNextAsync` awaits and the final `DisposeAsync` await. In a modern ASP.NET Core app there is no synchronization context to capture, so it is a no-op there, but it still matters for library code, console hosts, and anything that might run under a UI or legacy context. The trade-offs are the same as everywhere else in async code, covered in [whether ConfigureAwait still matters in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## LINQ over async streams is now in the box

A long-standing rough edge was that `IAsyncEnumerable<T>` had no LINQ. To write `stream.Where(...).Select(...)` you pulled in the community `System.Linq.Async` NuGet package. As of .NET 10 that changed: the runtime ships `System.Linq.AsyncEnumerable` in the BCL, so the standard operators work on any `IAsyncEnumerable<T>` with no package reference, and .NET 11 inherits this.

```csharp
// .NET 11: Where/Select/Take resolve from the BCL, no NuGet package
var firstTenErrors = ReadLinesAsync("huge.log", ct)
    .Where(l => l.Contains("ERROR"))
    .Take(10);

await foreach (var line in firstTenErrors.WithCancellation(ct))
    Console.WriteLine(line);
```

If you are migrating an older project, remove the explicit `System.Linq.Async` reference when you move to .NET 10 or later; leaving it in causes ambiguous-overload errors against the now-built-in methods. One naming change to know: the old `SelectAwait`/`WhereAwait` operators that took async lambdas are gone, and you pass the async delegate to the regular `Select`/`Where` instead. Code that multitargets older runtimes should reference the `System.Linq.AsyncEnumerable` package rather than `System.Linq.Async`.

## When you should reach for it

Use `IAsyncEnumerable<T>` when all three of these hold:

1. There are **many** elements, or an unknown or unbounded number.
2. Producing each element involves **asynchronous I/O** (database, network, file, message queue).
3. You want to **start processing before the last element arrives**, or you cannot afford to hold them all in memory at once.

Concrete fits: streaming rows out of a database for an export, as covered in [using IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/); reading a paginated API page by page and yielding each item as the pages arrive; tailing a log or a message stream that never ends; piping data into a [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) or a `PipeWriter`. In ASP.NET Core, returning `IAsyncEnumerable<T>` from a minimal API or controller action streams the JSON array to the client element by element instead of buffering the whole response.

## When you should not

Async streams are not free, and they are not always the right shape:

- **The data is already in memory.** Iterating a `List<T>` or an array? Use `foreach`. Wrapping an in-memory collection in an async stream adds state-machine overhead and buys nothing, because no element ever actually awaits.
- **There is exactly one result.** A method that returns one record should return `Task<T>`. A stream of one is just ceremony.
- **The set is small and bounded and you need random access, `Count`, or multiple passes.** `Task<List<T>>` (via `ToListAsync`) is simpler and lets you index, count, and re-enumerate. Streaming gives you a forward-only, single-pass sequence; if you need more than that, materialize it.
- **You need true parallelism over the elements.** A single `await foreach` is sequential by design. For fan-out, use `Parallel.ForEachAsync` or collect tasks and `Task.WhenAll`.

A useful rule of thumb: if you find yourself calling `ToListAsync()` on the stream immediately, you did not want a stream, you wanted the list. And if you are tempted to wrap a plain in-memory list as `IAsyncEnumerable<T>` just to satisfy a method signature, reconsider the signature.

## A note on disposal and early exit

Because the enumerator is `IAsyncDisposable`, the `await foreach` guarantees `DisposeAsync` runs when the loop ends for any reason: normal completion, a `break`, or an exception tearing through the body. That is what makes the `using` inside an async iterator safe. The subtle consequence is that breaking out early does not necessarily stop the underlying source instantly. A database may have already spooled rows the server side; a buffered network reader may have prefetched the next chunk. The disposal sends the cancel signal, but a little already-in-flight work can still complete. This is almost never a problem, but it explains the occasional "why is this query still running after my loop exited" moment in a profiler.

Async streams turned the awkward bottom-right cell of the value/collection matrix into a first-class language feature. The mental model is the whole game: it is `IEnumerable<T>` where every step can `await`, driven by `await foreach`, and worth using exactly when elements arrive over time and you would rather process them as they come than wait for all of them.

## Related

- [How to use IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) applies all of this to streaming database rows.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) is the side-by-side decision guide for the three sequence interfaces.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) is the HTTP-response counterpart to producing a stream.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) goes deeper on the cancellation tokens that async streams depend on.
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) is the other main way to consume results as they complete.

## Sources

- [IAsyncEnumerable<T> interface, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1?view=net-10.0).
- [Generate and consume async streams, C# docs](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream).
- [EnumeratorCancellationAttribute class, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute?view=net-10.0).
- [Breaking change: System.Linq.AsyncEnumerable in .NET 10, MS Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/asyncenumerable).
- [async-streams design doc, dotnet/roslyn on GitHub](https://github.com/dotnet/roslyn/blob/main/docs/features/async-streams.md).
