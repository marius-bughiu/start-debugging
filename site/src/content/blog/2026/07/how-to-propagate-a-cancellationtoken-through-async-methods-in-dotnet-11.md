---
title: "How to propagate a CancellationToken through async methods in .NET 11"
description: "Thread a CancellationToken cleanly through every layer of an async call chain in .NET 11: last-parameter convention, default values, linked tokens, ASP.NET Core RequestAborted, and the CA2016 analyzer that catches the ones you drop."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
---

Cancellation in .NET only works if the token reaches the code that does the blocking. A `CancellationToken` that you create at the top of a request but never pass into `HttpClient.GetAsync`, `DbContext.SaveChangesAsync`, or a `Stream.ReadAsync` call is dead weight: the outer operation still runs to completion because nothing downstream is listening. Propagating the token means threading that one parameter through every async method between the place cancellation is requested and the place work actually happens. This post covers the mechanical rules on .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): where the parameter goes, what its default should be, how to combine tokens, how ASP.NET Core hands you one for free, and how the `CA2016` analyzer finds the calls you forgot to forward. Every sample compiles against .NET 11.

## Why a token that does not travel is useless

.NET cancellation is cooperative. There is no `Task.Kill()`, and the runtime never interrupts a thread on its own. A `CancellationToken` is just a signal that flips from "not requested" to "requested" when someone calls `Cancel()` on the owning `CancellationTokenSource`. Code reacts to that flip only if it either checks `token.IsCancellationRequested`, calls `token.ThrowIfCancellationRequested()`, or hands the token to a framework API that does those checks internally. If the token never arrives at the blocking call, the blocking call cannot know it should stop.

That is the whole reason propagation matters. Consider this chain:

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

You can call `Cancel()` all day. `LoadRowsAsync` and `EnrichAsync` never see the signal, so `BuildReportAsync` finishes its full work before the `catch (OperationCanceledException)` at the call site ever has a chance to fire. The fix is not clever code, it is discipline: the token has to be a parameter on every method in the path, and every call has to forward it.

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## The end-to-end propagation procedure

Here is the sequence to thread a token from an entry point down to an I/O call. Each step is a rule you apply mechanically.

1. **Accept the token as the last parameter.** Give every async method in the chain a `CancellationToken` parameter, and put it last so it reads consistently across your codebase and matches the framework's own signatures.
2. **Name it consistently.** Use `cancellationToken` in public library APIs (this is the BCL convention) or `ct` in internal app code. Pick one and stay with it so forwarding is grep-able.
3. **Forward it to every awaited call that accepts one.** If a method you call has a `CancellationToken` overload or parameter, pass your token into it. Do not pass `CancellationToken.None` "to be safe" -- that silently opts the call out of cancellation.
4. **Give it a default only at true entry points.** Library-facing methods use `CancellationToken cancellationToken = default` so callers who do not care can omit it. Internal methods that always have a token should not default it, so a missing argument is a compile-time reminder.
5. **Combine tokens when you add your own deadline.** If a method needs its own timeout on top of the caller's token, link them with `CancellationTokenSource.CreateLinkedTokenSource` rather than choosing one and dropping the other.
6. **Turn on `CA2016`.** Let the analyzer flag the calls you missed in steps 3 to 5.

The rest of this post expands the parts of that list that have real nuance.

## Where the parameter goes and what to call it

The convention across the entire BCL is: `CancellationToken` is the **last** parameter, and it is named `cancellationToken`. Look at any modern async API and you will see the shape:

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

Match that in your own code. Two reasons this is not just cosmetic:

- **The `CA2016` analyzer keys off the last-parameter position.** It looks at a method that takes a `CancellationToken` as its last parameter, then checks whether the calls inside forward it. Put the token in the middle and you weaken the tooling that is supposed to catch your mistakes.
- **Optional parameters must come last anyway.** When you default the token (`= default`), C# forces it to sit after all non-optional parameters, so the last-parameter rule falls out of the language rules for free.

For the name, the split is: `cancellationToken` for anything public or library-shaped (consistency with the BCL wins), `ct` is acceptable and common in application-internal code where brevity helps readability of long call chains. The important thing is that it is one name, so a reader scanning a method can instantly see whether the token is being forwarded or dropped.

## `default`, `CancellationToken.None`, and when to default at all

`default(CancellationToken)` and `CancellationToken.None` are the same value: a token that can never be cancelled. `IsCancellationRequested` is always `false` and `CanBeCanceled` is `false`. They differ only in intent-signaling, and the language gives you `= default` as the idiomatic optional-parameter form:

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

The decision that trips people up is **whether to default the parameter at all**. The rule that keeps you honest:

- **Public / library methods: default it.** Callers who genuinely have no token (a top-level console `Main`, a fire-and-forget path) can omit it, and the method still compiles. This is why every BCL async method defaults the token.
- **Internal methods that always run under a token: do not default it.** If `BuildReportAsync` is only ever called from a request handler that has a token, leaving the parameter non-optional means the compiler yells the moment someone calls it without forwarding a token. That compile error is a feature. Defaulting it there would let a dropped token slip through as a silent `CancellationToken.None`.

The anti-pattern to avoid is reaching for `CancellationToken.None` inside a method that already has a real token in scope. That is not "safe," it is a cancellation leak dressed up as caution.

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

The only legitimate use of `CancellationToken.None` is a call you deliberately want to run to completion even if the outer operation is cancelled -- for example, writing a final audit record or releasing a resource. Make that intent obvious with a comment, because a reviewer will otherwise read it as a bug.

## Combining a caller's token with your own timeout

A common real situation: a method receives the caller's `CancellationToken`, but also needs its own timeout ("give up on this downstream call after 5 seconds"). Do not choose one and ignore the other. Link them so cancellation from **either** source stops the work. `CancellationTokenSource.CreateLinkedTokenSource` produces a source whose token trips when any of its parent tokens trip:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

Two details make this correct:

- **Dispose the linked source.** `CreateLinkedTokenSource` registers callbacks on its parents; not disposing it leaks those registrations for the lifetime of the longest-lived parent token. The `using` handles it.
- **The `when` filter separates the two cancellation causes.** When the token trips you get an `OperationCanceledException` either way. Checking `timeoutCts.IsCancellationRequested` against `cancellationToken.IsCancellationRequested` tells you which source fired, so a caller-initiated cancel propagates as-is while a timeout surfaces as a `TimeoutException`. This is the same discipline you need when you [cancel a long-running Task without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

If you only need a timeout and there is no inbound token, `CancelAfter` on a single source is simpler than a linked one. Reach for linking specifically when a caller token and a local deadline both have to win.

## ASP.NET Core hands you a token: use it

In a web app you rarely create the top-of-chain token yourself. ASP.NET Core exposes `HttpContext.RequestAborted`, a `CancellationToken` that trips when the client disconnects or the server aborts the request. Both minimal APIs and MVC controllers bind it automatically: declare a `CancellationToken` parameter and the framework fills it from `RequestAborted`.

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

That injected token is the entry point for the whole propagation chain. Forward it into `BuildAsync`, which forwards it into its EF Core queries and `HttpClient` calls, and a client that closes the browser tab now stops all of that downstream work instead of paying for a query nobody will read. The behavior to expect: when `RequestAborted` fires mid-request, your awaits throw `OperationCanceledException` (or its `TaskCanceledException` subclass), which the framework treats as a cancelled request rather than a 500. If you see that exception in logs from `HttpClient`, it is often exactly this working as intended -- see [why a TaskCanceledException surfaces from HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) for the timeout-versus-cancel distinction.

One caveat specific to background work: `RequestAborted` is scoped to the request. If a request handler kicks off work that should outlive the response, do not hand it `RequestAborted` -- it will be cancelled the instant the response completes. That work belongs in a hosted service with its own lifetime, which is the pattern behind [running fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Propagating through streaming and `IAsyncEnumerable<T>`

Async streams need the token wired through the iterator, and the mechanism is slightly different because the consumer, not the producer, supplies the token at enumeration time. The producer marks the parameter with `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

The consumer attaches a token with `WithCancellation`, and the compiler routes it into the `[EnumeratorCancellation]` parameter:

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

Without `[EnumeratorCancellation]`, the token from `WithCancellation` is silently ignored and the enumeration cannot be cancelled -- a subtle propagation break that the `CA2016` analyzer does not always catch. If you are new to async streams, the [when-to-reach-for IAsyncEnumerable](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) rundown covers the wider picture.

## Let `CA2016` catch the ones you drop

Threading a token through a deep call chain by hand is exactly the kind of task where you will miss one call. The `CA2016` analyzer ("Forward the CancellationToken parameter to methods that take one") is built for this: it inspects a method that has a `CancellationToken` as its last parameter, then flags any call inside that could accept the token -- directly or via an overload -- but does not. Turn it into a build error so a dropped token fails CI instead of shipping:

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

`CA2016` ships with the .NET SDK analyzers, which are on by default for projects targeting .NET 11, so you only need to raise the severity. It comes with a code fix, so in Visual Studio or with `dotnet format analyzers` you can auto-forward the token across a whole file. What it will not do is invent a token where the enclosing method has none -- that is the case for making the parameter non-optional on internal methods, so the compiler forces you to add it.

A note on `CA2016`'s blind spots: it keys on the last-parameter convention and on the presence of a matching overload. It will not flag a call that takes the token in a non-last position, and it does not reason about `[EnumeratorCancellation]` routing. Treat it as a strong net for the common case, not a proof that every path is covered.

## The propagation mistakes that keep tokens from working

A few patterns break propagation even when the token is technically present:

- **Fresh source per call.** Creating `new CancellationTokenSource()` inside a method and passing *its* token ignores the caller's token entirely. Link, do not replace.
- **`async void`.** A token cannot propagate out of an `async void` method because there is no `Task` for a caller to await or to observe the `OperationCanceledException` on. Keep cancellation paths on `async Task` -- the reasons overlap heavily with [why async void is almost always wrong](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).
- **Swallowing `OperationCanceledException`.** Catching it and returning a default value hides the cancellation from callers, so an outer `Task.WhenAll` or await never learns the operation stopped. Let it bubble unless you have a specific reason to translate it (like the timeout case above).
- **Forgetting the sync leaf.** A tight CPU loop at the bottom of an async chain has no awaited API to hand the token to. Add an explicit `cancellationToken.ThrowIfCancellationRequested()` inside the loop so the token still has a checkpoint.

Propagation is not a feature you turn on; it is a property you maintain. Every new async method is one more link that either forwards the token or quietly severs the chain. Add the parameter, forward it at every call, let `CA2016` guard the calls you forget, and reserve `CancellationToken.None` for the rare operation you truly want to finish no matter what.

## Sources

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>
