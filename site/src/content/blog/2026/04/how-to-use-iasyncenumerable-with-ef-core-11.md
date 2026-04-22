---
title: "How to use IAsyncEnumerable<T> with EF Core 11"
description: "EF Core 11 queries implement IAsyncEnumerable<T> directly. Here is how to stream rows with await foreach, when to prefer it over ToListAsync, and the gotchas around connections, tracking, and cancellation."
pubDate: 2026-04-22
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
---

If you have a query in EF Core 11 that returns a lot of rows, you do not have to materialize the whole thing into a `List<T>` before you start processing. An EF Core `IQueryable<T>` already implements `IAsyncEnumerable<T>`, so you can `await foreach` directly over it and each row is yielded as the database produces it. No `ToListAsync` needed, no custom iterator, no `System.Linq.Async` package. That is the short answer. This post walks through the mechanics, the version specifics for EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14), and the gotchas that bite people who bolt streaming onto a codebase that was not designed for it.

## Why EF Core exposes `IAsyncEnumerable<T>` at all

EF Core's query pipeline is built around a data reader. When you call `ToListAsync()`, EF Core opens a connection, executes the command, and pulls rows off the reader into a buffered list until the reader is exhausted, then closes everything. You get a `List<T>`, which is convenient, but the full result set now lives in your process memory and the first row is only visible to your code after the last row has been read.

`IAsyncEnumerable<T>` turns that inside out. You ask for rows one at a time. EF Core opens the connection, runs the command, and yields the first materialized entity as soon as the first row comes off the wire. Your code starts working immediately. Memory stays bounded to what your loop body retains. For reports, exports, and pipelines that transform rows before writing them somewhere else, this is the pattern you want.

Because `DbSet<TEntity>` and the `IQueryable<TEntity>` returned by any LINQ chain both implement `IAsyncEnumerable<TEntity>`, you do not need an explicit `AsAsyncEnumerable()` call for it to work. The interface is there. The async foreach machinery picks it up.

## The minimal example

```csharp
// .NET 11, C# 14, Microsoft.EntityFrameworkCore 11.0.0
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();

await foreach (var invoice in db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt))
{
    await ProcessAsync(invoice);
}
```

That is the whole thing. No `ToListAsync`. No intermediate allocation. The underlying `DbDataReader` stays open for the duration of the loop. Every iteration pulls another row off the wire, materializes the `Invoice`, and hands it to your loop body.

Contrast with the list-based version:

```csharp
// Buffers every row into memory before the first ProcessAsync call
var invoices = await db.Invoices
    .Where(i => i.Status == InvoiceStatus.Pending)
    .OrderBy(i => i.CreatedAt)
    .ToListAsync();

foreach (var invoice in invoices)
{
    await ProcessAsync(invoice);
}
```

For 50 rows, the difference is invisible. For 5 million rows, the streaming version finishes the first invoice before the buffered version has finished allocating the list.

## Passing a cancellation token the right way

The `IQueryable<T>.GetAsyncEnumerator(CancellationToken)` overload takes a token, but when you write `await foreach (var x in query)` you do not get a place to pass one. The fix is `WithCancellation`:

```csharp
public async Task ExportPendingAsync(CancellationToken ct)
{
    await foreach (var invoice in db.Invoices
        .Where(i => i.Status == InvoiceStatus.Pending)
        .AsNoTracking()
        .WithCancellation(ct))
    {
        ct.ThrowIfCancellationRequested();
        await writer.WriteAsync(invoice, ct);
    }
}
```

`WithCancellation` does not wrap the sequence in another iterator. It just threads the token into the call to `GetAsyncEnumerator`, which EF Core forwards into `DbDataReader.ReadAsync`. If the caller cancels the token, the pending `ReadAsync` is cancelled, the command is aborted on the server, and `OperationCanceledException` bubbles up through your `await foreach`.

Do not skip the token. A forgotten token on a streaming EF Core query is a hung request in production when the HTTP client disconnects. The list-based path fails the same way, but it hurts more here because the connection is held for the whole loop, not just the materialization step.

## Turn off tracking unless you actually need it

`AsNoTracking()` matters more when streaming than when buffering. With change tracking on, every entity yielded by the enumerator is added to the `ChangeTracker`. That is a reference the GC cannot collect until you dispose the `DbContext`. Streaming a million rows into a tracked query defeats the point of streaming: memory grows linearly with rows, same as `ToListAsync`.

```csharp
await foreach (var row in db.AuditEvents
    .AsNoTracking()
    .Where(e => e.OccurredAt >= cutoff)
    .WithCancellation(ct))
{
    await sink.WriteAsync(row, ct);
}
```

Only keep tracking if you intend to mutate the entities and call `SaveChangesAsync` inside the loop, which, as the next section argues, you should almost never do.

## You cannot open a second query on the same context while one is streaming

This is the most common production gotcha. The `DbDataReader` that EF Core opens when you start enumerating holds the connection. If inside the loop you call another EF Core method that needs that connection, you get:

```
System.InvalidOperationException: There is already an open DataReader associated
with this Connection which must be closed first.
```

On SQL Server you can work around it by enabling Multiple Active Result Sets (`MultipleActiveResultSets=True` in the connection string), but MARS has its own performance trade-offs and is not supported on every provider. The better pattern is to not mix operations on one context. Either:

- Collect the IDs you need first, close the stream, then do the follow-up work; or
- Use a second `DbContext` for the inner calls.

```csharp
await foreach (var order in queryCtx.Orders
    .AsNoTracking()
    .WithCancellation(ct))
{
    await using var writeCtx = await factory.CreateDbContextAsync(ct);
    writeCtx.Orders.Attach(order);
    order.ProcessedAt = DateTime.UtcNow;
    await writeCtx.SaveChangesAsync(ct);
}
```

`IDbContextFactory<TContext>` (registered via `AddDbContextFactory` in your DI wiring) is the cleanest way to get that second context without fighting scoped lifetimes.

## Streaming and transactions do not combine well

A streaming enumerator holds a connection open for as long as your loop runs. If that loop also participates in a transaction, the transaction stays open for the whole loop. Long-running transactions are how you get lock escalation, blocked writers, and the kind of timeouts that only show up under load.

Two rules that keep this sane:

1. Do not open a transaction around a streaming read unless you specifically need a consistent snapshot.
2. If you do need a snapshot, consider `SNAPSHOT` isolation on SQL Server or a `REPEATABLE READ` isolation on your provider of choice, and treat the loop body as a hot path. No HTTP calls, no user-facing waits.

For bulk processing jobs, the usual shape is: stream read, per-row or batched write in a short transaction on a separate context, commit, move on.

## `AsAsyncEnumerable` exists, and sometimes you need it

If you have a method that accepts `IAsyncEnumerable<T>` and you want to feed an EF Core query to it, passing the `IQueryable<T>` directly compiles, because the interface is implemented, but it looks wrong at the call site. `AsAsyncEnumerable` is a no-op at runtime that makes the intent explicit:

```csharp
public async Task ExportAsync(IAsyncEnumerable<Invoice> source, CancellationToken ct)
{
    // Consumes a generic async sequence. Does not know it is EF.
}

await ExportAsync(
    db.Invoices.AsNoTracking().AsAsyncEnumerable(),
    ct);
```

It also forces the call to leave the `IQueryable` world. Once you go through `AsAsyncEnumerable()`, any further LINQ operators run on the client as async iterator operators, not as SQL. That is the behaviour you want here, because the receiving method should not accidentally rewrite the query.

## What happens if you break out of the loop early

Async iterators clean up on disposal. When the `await foreach` exits, for any reason (break, exception, or completion), the compiler calls `DisposeAsync` on the enumerator, which closes the `DbDataReader` and returns the connection to the pool. This is why the `await using` on the `DbContext` still matters, but the individual query does not need its own using block.

One non-obvious consequence: if you `break` after the first row of a 10-million-row query, EF Core does not read the other rows, but the database may have already spooled a lot of them. The query plan does not know you lost interest. For SQL Server, the client-side `DbDataReader.Close` sends a cancel over the TDS stream and the server bails out, but for huge rowcounts you can still see a few seconds of server work after your loop exits. This is almost never a problem, but it is worth knowing when a debugger shows a query running on the server after your test already passed.

## Do not misuse `ToListAsync` on top of a streaming source

Every once in a while someone writes this:

```csharp
// Pointless: materializes the whole thing, then streams it
var all = await db.Invoices.ToListAsync(ct);
await foreach (var item in all.ToAsyncEnumerable()) { }
```

There is no benefit. If you want streaming, go straight from the `IQueryable` into the `await foreach`. If you want buffering, keep the `List<T>` and use a regular `foreach`. Mixing them always reveals someone who was not sure which they wanted.

Similarly, calling `.ToAsyncEnumerable()` on an EF Core query is redundant in EF Core 11: the source already implements the interface. It compiles and works, but do not add it.

## Client evaluation still sneaks in

EF Core's query translator is good, but not every LINQ expression translates to SQL. If it cannot, EF Core 11 throws by default on the final operator (unlike EF Core 2.x's silent client-eval). Streaming does not change this: if your `.Where` filter references a method EF Core cannot translate, the whole query fails at enumeration time, not at `await foreach` start.

The surprise is that with `await foreach`, the exception surfaces on the first `MoveNextAsync`, which is inside the loop header, not before it. Wrap the setup in a `try` if you want to distinguish setup errors from processing errors:

```csharp
try
{
    await foreach (var row in query.WithCancellation(ct))
    {
        try { await ProcessAsync(row, ct); }
        catch (Exception ex) { log.LogWarning(ex, "Row {Id} failed", row.Id); }
    }
}
catch (Exception ex)
{
    log.LogError(ex, "Query failed before first row");
    throw;
}
```

## When `ToListAsync` is still the right answer

Streaming is not universally better. Reach for `ToListAsync` when:

- The result set is small and bounded (say, under a few thousand rows).
- You need to iterate the result more than once.
- You need `Count`, indexing, or any other `IList<T>` operation.
- You plan to bind the result to a UI control or serialize it into a response body that expects a materialized collection.

Streaming wins when the result is large, when memory matters, when the consumer is itself async (a `PipeWriter`, an `IBufferWriter<T>`, a `Channel<T>`, a message bus), or when first-byte latency matters more than total throughput.

## Quick checklist for EF Core 11 streaming

- `await foreach` directly over an `IQueryable<T>`. No `ToListAsync`.
- Always `AsNoTracking()` unless you have a concrete reason not to.
- Always `WithCancellation(ct)`.
- Use `IDbContextFactory<TContext>` if you need a second context for writes inside the loop.
- Do not wrap a streaming read in a long transaction.
- Do not open a second reader on the same context without MARS.
- Expect the first `MoveNextAsync` to surface translation and connection errors.

## Related

- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/) pairs well with streaming reads when your entities are immutable.
- [Single-step EF Core 11 migrations with `dotnet ef update add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) covers the tooling side of the same release.
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) for the other main `IAsyncEnumerable<T>` pattern in modern .NET.
- [HttpClient GetFromJsonAsAsyncEnumerable](/2023/10/httpclient-get-json-as-asyncenumerable/) shows the same streaming shape on the HTTP side.
- [EF Core 11 preview 3 prunes reference joins in split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) for the performance context in the same release.

## Sources

- [EF Core Async Queries, MS Learn](https://learn.microsoft.com/en-us/ef/core/miscellaneous/async).
- [`DbContext` lifetime and pooling, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/).
- [`IDbContextFactory<TContext>`, MS Learn](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- [`AsyncEnumerableReader` in the EF Core source on GitHub](https://github.com/dotnet/efcore).
