---
title: "EF Core 11's New EF1004 Analyzer Catches a Silent Async Mistake"
description: "EF Core 11 Preview 5 ships the EF1004 analyzer. It flags ToAsyncEnumerable() on an IQueryable so you do not accidentally enumerate a database query synchronously inside an await foreach."
pubDate: 2026-06-14
tags:
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
---

.NET 11 Preview 5, released June 9, 2026, adds a new EF Core analyzer with diagnostic ID `EF1004`. It catches a mistake that has gotten much easier to make since `System.Linq.AsyncEnumerable` moved into the BCL in .NET 10: calling `ToAsyncEnumerable()` on an EF Core query and quietly running it synchronously.

## How the wrong call slipped in

Now that `System.Linq.AsyncEnumerable` ships in the runtime, its extension methods are in scope almost everywhere. One of them is `ToAsyncEnumerable()`, which adapts any `IEnumerable<T>` into an `IAsyncEnumerable<T>`. An EF Core `IQueryable<T>` is also an `IEnumerable<T>`, so the call compiles cleanly and looks correct next to an `await foreach`:

```csharp
// Looks async. Is not.
await foreach (var blog in db.Blogs.ToAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

The problem is that `ToAsyncEnumerable()` wraps synchronous enumeration. It walks the `IQueryable` using the blocking enumerator, so the database round trip runs on the calling thread. The `await foreach` gives you the syntax of streaming without any of the async behavior. Under load this is exactly the shape that starves the thread pool and produces deadlocks that only show up in production.

## What EF1004 wants instead

EF Core exposes its own `AsAsyncEnumerable()` method. That one routes the query through EF Core's async pipeline, so each row is materialized as it comes off the `DbDataReader` without blocking a thread:

```csharp
// Runs through EF Core's async query pipeline.
await foreach (var blog in db.Blogs.AsAsyncEnumerable())
{
    Console.WriteLine(blog.Name);
}
```

The two method names differ by three characters, both return `IAsyncEnumerable<T>`, and both compile. Before Preview 5 nothing told you which one you had picked. `EF1004` fires at build time the moment you call `ToAsyncEnumerable()` on an `IQueryable<T>`, pointing you at `AsAsyncEnumerable()`.

## Turning it into an error

The analyzer ships in the EF Core analyzer package and runs during a normal build, so you get the warning with no extra setup on a project referencing `Microsoft.EntityFrameworkCore` 11.0.0. If you want to guarantee nobody ships the synchronous version, promote it in your project file:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);EF1004</WarningsAsErrors>
</PropertyGroup>
```

This pairs naturally with the streaming patterns covered in [How to use IAsyncEnumerable&lt;T&gt; with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/): `AsAsyncEnumerable()` is the call that makes `await foreach` actually stream. EF1004 is just the guardrail that stops the look-alike from sneaking past code review.

Source: the [EF Core .NET 11 Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/efcore.md) and the [.NET 11 Preview 5 announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/).
