---
title: "Try pattern vs throwing exceptions for expected failures in C#"
description: "Return bool from a TryX method when failure is an ordinary outcome the caller will branch on, and throw when it is a bug or a broken precondition. Measured on .NET 10.0.10: a failed int.TryParse costs 4.9 ns, a caught FormatException costs 2,487 ns."
pubDate: 2026-10-29
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "exceptions"
  - "performance"
---

If a failure is something the caller expects and will handle on the spot (user input that does not parse, a cache miss, a key that is not in a dictionary), return `bool` from a `TryX` method with an `out` parameter. If the failure means a bug, a broken precondition, or something the immediate caller cannot do anything useful about, throw. On .NET 10.0.10 (Apple M4, BenchmarkDotNet 0.15.8) a failed `int.TryParse` takes 4.9 ns, while `int.Parse` inside a `try`/`catch (FormatException)` takes 2,487 ns and allocates 480 B per failure, roughly about 500 times slower. The success path costs the same either way, so this is purely about the cost of the failure path.

## The short comparison

| Aspect (C# 14, .NET 10) | `bool TryX(..., out T)` | Throwing `XException` |
| --- | --- | --- |
| Cost when it succeeds | Same as the throwing version | Same as the Try version (a `try` block is free) |
| Cost when it fails | A branch, nanoseconds, no allocation | Microseconds plus a heap-allocated exception and stack trace |
| Cost grows with call depth | No | Yes, the unwinder walks every frame |
| Caller can ignore the failure | Yes, if they ignore the return value | No, it propagates until someone catches it |
| Carries a reason | No, just `false` (unless you add an error out-param) | Yes, type, message, inner exception, stack trace |
| Works in `async` methods | Not directly (`out` is not allowed) | Yes |
| Nullability annotations | `[NotNullWhen(true)]` / `[MaybeNullWhen(false)]` | Not needed |
| BCL examples | `int.TryParse`, `Dictionary.TryGetValue`, `ConcurrentQueue.TryDequeue` | `int.Parse`, the dictionary indexer, `Enumerable.First` |

## Why exceptions are expensive in the first place

A `throw` is not a fancy `return`. When you throw, the runtime allocates the exception object, captures a stack trace, then runs a two-pass unwind: the first pass walks up the stack looking for a matching `catch` (running exception filters along the way), the second pass walks it again to run `finally` blocks and actually transfer control. Every managed frame between the `throw` and the `catch` is visited, and debuggers, profilers, and EventPipe listeners get first-chance notifications on top.

None of this happens when no exception is thrown. Entering a `try` block costs nothing on the happy path in .NET: the JIT records the protected region in a side table, and nothing executes at runtime until something throws. That is why "wrap it in a try/catch" is free right up until the moment it is not.

.NET 9 made the failure path considerably cheaper. CoreCLR replaced its exception handling with the managed implementation from NativeAOT, which the [.NET 9 runtime release notes](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-9/runtime) describe as "2-4 times faster" in some micro-benchmarks. It is still in place in .NET 10, and my numbers below confirm a large improvement over .NET 8. But faster exceptions are still orders of magnitude slower than a branch, and the ratio is what matters when the failure is common.

## The benchmark

Environment: Apple M4, macOS, BenchmarkDotNet 0.15.8, .NET SDK 10.0.302, runtimes .NET 10.0.10 and .NET 8.0.33, Release build, default job, `[MemoryDiagnoser]`. Each case parses either `"12345"` or `"12a45"`, or looks up a missing key in a one-item `Dictionary<int, string>`. The `Throw_DepthN` cases throw an `InvalidOperationException` from N recursive frames below the `catch`.

```csharp
// .NET 10.0 / .NET 8.0, C# 12+, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net80)]
[SimpleJob(RuntimeMoniker.Net10_0)]
public class TryVsThrow
{
    private readonly string _good = "12345";
    private readonly string _bad = "12a45";
    private readonly Dictionary<int, string> _map = new() { [1] = "one" };

    [Benchmark(Baseline = true)]
    public int TryParse_Valid() => int.TryParse(_good, out var v) ? v : -1;

    [Benchmark]
    public int Parse_Valid_InTry()
    {
        try { return int.Parse(_good); }
        catch (FormatException) { return -1; }
    }

    [Benchmark]
    public int TryParse_Invalid() => int.TryParse(_bad, out var v) ? v : -1;

    [Benchmark]
    public int Parse_Invalid_Catch()
    {
        try { return int.Parse(_bad); }
        catch (FormatException) { return -1; }
    }

    [Benchmark]
    public int TryGetValue_Miss() => _map.TryGetValue(2, out var s) ? s.Length : -1;

    [Benchmark]
    public int Indexer_Miss_Catch()
    {
        try { return _map[2].Length; }
        catch (KeyNotFoundException) { return -1; }
    }

    [Benchmark]
    public int Throw_Depth1() { try { return Depth(1); } catch (InvalidOperationException) { return -1; } }

    [Benchmark]
    public int Throw_Depth20() { try { return Depth(20); } catch (InvalidOperationException) { return -1; } }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Depth(int n) => n == 1 ? throw new InvalidOperationException("nope") : Depth(n - 1) + 1;
}
```

| Case | .NET 10.0.10 mean | .NET 10 allocated | .NET 8.0.33 mean | .NET 8 allocated |
| --- | ---: | ---: | ---: | ---: |
| `TryParse_Valid` (baseline) | 4.38 ns | 0 B | 4.04 ns | 0 B |
| `Parse_Valid_InTry` | 4.43 ns | 0 B | 4.58 ns | 0 B |
| `TryParse_Invalid` | 4.90 ns | 0 B | 4.50 ns | 0 B |
| `Parse_Invalid_Catch` | 2,487 ns | 480 B | 20,601 ns | 504 B |
| `TryGetValue_Miss` | 0.50 ns | 0 B | 0.79 ns | 0 B |
| `Indexer_Miss_Catch` | 2,341 ns | 472 B | 18,658 ns | 496 B |
| `Throw_Depth1` | 2,422 ns | 320 B | 18,544 ns | 344 B |
| `Throw_Depth20` | 5,341 ns | 2,400 B | 25,997 ns | 1,761 B |

Three things stand out.

1. **The success path is a wash.** `int.Parse` inside a `try` block costs 4.43 ns against 4.38 ns for `int.TryParse`, which is inside the noise. A `try` region that never throws is free. If someone tells you to avoid `try` blocks for performance, this row is the answer.
2. **The failure path is not.** A failed `int.TryParse` is 4.9 ns with nothing allocated. The same failure as a caught `FormatException` is 2,487 ns and 480 B of garbage, about 500 times slower. A dictionary miss shows the same shape: `TryGetValue` answers in half a nanosecond, while catching the indexer's `KeyNotFoundException` costs 2,341 ns. On .NET 8 every exception row is roughly 7 to 8 times worse again (18 to 21 microseconds), which is the .NET 9 exception handling rewrite showing up on macOS arm64. If you are still on .NET 8, the gap between the two patterns is around 4,600x.
3. **Depth makes it worse.** Throwing from one frame below the `catch` costs 2,422 ns on .NET 10; throwing from 20 frames below costs 5,341 ns and allocates 2,400 B instead of 320 B, because the stack trace grows with every frame the exception passes through. In a real application the `catch` is often a dozen frames up (a middleware, a controller filter, a message handler), so the microbenchmark number is the floor, not the typical cost.

A few microseconds sounds harmless, and for a single failed request it is. It stops being harmless when the failure is the common case: validating a CSV import where 30% of the rows are bad, probing a cache that misses most of the time, or parsing query strings sent by bots. At one million failures, the Try pattern spends about 5 ms of CPU time and allocates nothing, while the exception version spends about 2.5 seconds and produces about 480 MB of short-lived garbage for the GC to collect (and about 20 seconds on .NET 8).

## When to return bool with a TryX method

Pick the Try pattern when all three of these are true: the failure is a normal, expected outcome; the immediate caller is the one who will handle it; and "it failed" is enough information (or you can add one more `out` parameter for the reason).

- **Parsing untrusted input.** User input, file contents, headers, and query strings fail all the time. `int.TryParse`, `Guid.TryParse`, `DateTimeOffset.TryParseExact`, and `IPAddress.TryParse` exist for exactly this reason.
- **Lookups that are allowed to miss.** `Dictionary<TKey, TValue>.TryGetValue`, `IMemoryCache.TryGetValue`, and your own repository's `TryFind` are cheaper and clearer than `ContainsKey` followed by the indexer, which also does the hash lookup twice.
- **Non-blocking concurrency primitives.** `ConcurrentQueue<T>.TryDequeue`, `Channel<T>.Reader.TryRead`, and `SemaphoreSlim.Wait(0)` report "nothing right now" as a value, because "nothing right now" is the whole point.
- **Hot loops.** Any code path that runs per element, per message, or per request and can fail on a meaningful fraction of its inputs.

Here is a repository that follows the BCL shape: the Try method is the primitive, and the throwing method is a thin wrapper over it.

```csharp
// .NET 10, C# 14
using System.Diagnostics.CodeAnalysis;

public sealed record Customer(int Id, string Name);

public sealed class CustomerRepository
{
    private readonly Dictionary<int, Customer> _byId = new() { [1] = new(1, "Ada") };

    public bool TryFind(int id, [NotNullWhen(true)] out Customer? customer)
        => _byId.TryGetValue(id, out customer);

    public Customer Find(int id)
        => TryFind(id, out var customer)
            ? customer
            : throw new KeyNotFoundException($"Customer {id} does not exist.");
}
```

The `[NotNullWhen(true)]` attribute matters. Without it, nullable analysis has no idea that `customer` is non-null after `TryFind` returned `true`, and every caller ends up writing `customer!`. Use `[MaybeNullWhen(false)]` instead when the out parameter is a generic `T` that may be a non-nullable value type, which is what `Dictionary<TKey, TValue>.TryGetValue` does.

## When to throw

Throwing is the right call when the failure should not be silently ignored, when the code that detects it cannot decide what to do, or when it is rare enough that the cost is irrelevant.

- **Bugs and broken preconditions.** A `null` argument that the contract forbids, an index out of range, an object used after `Dispose`. These are programming errors. A `false` return would let the bug travel further before it surfaces. `ArgumentNullException.ThrowIfNull` and `ObjectDisposedException.ThrowIf` exist for this.
- **Failures several layers away from the handler.** A database timeout inside a repository inside a service inside a controller is best handled by the global error handler, not by threading a `bool` through four signatures.
- **Failures that need a reason.** An exception carries a type, a message, an inner exception, and a stack trace. A Try method carries one bit.
- **Constructors and properties.** Neither can return `false`.
- **Rare failures.** If a config file is missing at startup, nobody cares that the exception took 10 microseconds.

The Framework Design Guidelines put the boundary well: when using the Try pattern, "define the try functionality in strict terms", and any failure outside that well-defined case must still throw. `int.TryParse` returns `false` for `"12a45"`, but the overload that takes a `NumberStyles` still throws `ArgumentException` when you pass an invalid style combination, because that is a bug in the caller, not bad input.

## The gotchas that pick for you

**`async` methods cannot have `out` parameters.** `Task<bool> TryFindAsync(int id, out Customer c)` does not compile (CS1988). The idiomatic async equivalent returns a tuple or a small result type:

```csharp
// .NET 10, C# 14
public async Task<(bool Found, Customer? Customer)> FindAsync(int id, CancellationToken ct = default)
{
    var customer = await _db.Customers.FindAsync([id], ct);
    return customer is null ? (false, null) : (true, customer);
}
```

For a lookup, returning `Customer?` and letting `null` mean "not found" is usually simpler still. If you want the compiler to force callers to handle every outcome, C# 15 [union types in .NET 11](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) give you a closed `Found | NotFound | Error` shape with exhaustive `switch` checking.

**Tester-Doer has a race.** The other pattern from the guidelines checks first and acts second: `if (!collection.IsReadOnly) collection.Add(x);`. That is fine for a property that never changes, but `if (File.Exists(path)) File.ReadAllText(path)` can still throw `FileNotFoundException` when another process deletes the file in between. For anything shared, the atomic Try method wins, and for the file system you have to catch anyway.

**Do not swallow everything to fake a Try method.** This is the anti-pattern:

```csharp
// .NET 10, C# 14 -- do not do this
public static bool TryLoad(string path, out Config? config)
{
    try { config = JsonSerializer.Deserialize<Config>(File.ReadAllText(path)); return true; }
    catch { config = null; return false; }
}
```

It keeps the full exception cost on every failure (so it is not a performance win), and it hides `OutOfMemoryException`, `UnauthorizedAccessException`, and genuine bugs behind the same `false` as "the file does not exist". If you wrap a throwing API, catch only the specific exceptions that represent the expected failure.

**Ship both if you write a library.** The guidelines say to "provide an exception-throwing member for each member using the Try-Parse Pattern". Callers who know the input is valid should not have to write `if (!TryX(...)) throw ...` themselves, and the throwing member gets to produce a precise message. Implement the throwing member on top of the Try member, as in the repository above, so the logic lives in one place:

```csharp
// .NET 10, C# 14
public static class Port
{
    public static bool TryParse(ReadOnlySpan<char> s, out ushort port)
        => ushort.TryParse(s, out port) && port != 0;

    public static ushort Parse(ReadOnlySpan<char> s)
        => TryParse(s, out var port)
            ? port
            : throw new FormatException($"'{s}' is not a valid TCP port (1-65535).");
}
```

**Debuggers and APM tools amplify the cost.** With "break on thrown exceptions" enabled, or with an APM agent recording first-chance exceptions, every expected failure becomes noise in your traces. Teams that throw for validation failures usually discover this when their dashboards show 50,000 `FormatException`s a minute, all of them "handled".

## The recommendation

Use a `TryX` method returning `bool` for any failure that is an expected outcome and is handled by the caller that triggered it: parsing input, optional lookups, and non-blocking operations. Throw for everything else: bugs, broken invariants, and failures that must travel up the stack to a central handler. On .NET 10 the happy path costs the same either way, so the only reason to prefer one for performance is how often the failure path runs, and for frequent failures the Try pattern is about 500 times cheaper and allocation-free.

If you are writing a library, ship both: `TryX` as the primitive, `X` as a wrapper that throws a descriptive exception.

## Related

- [How to return multiple values from a method in C# 14](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) covers `out` parameters, tuples, and records, the building blocks of any Try method.
- [The best way to throw an exception if null in C#](/2023/03/c-best-way-to-throw-exception-if-null/) shows the `ThrowIfNull` helpers for the precondition case.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) is where the exceptions you do throw should end up.
- [Fix InvalidOperationException: Sequence contains no elements](/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/) is the classic case of a throwing LINQ method where `FirstOrDefault` is the Try-style alternative.

## Sources

- [Exceptions and Performance (Framework Design Guidelines)](https://learn.microsoft.com/dotnet/standard/design-guidelines/exceptions-and-performance)
- [What's new in the .NET 9 runtime: exception handling](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-9/runtime)
- [Attributes for null-state static analysis (`NotNullWhen`, `MaybeNullWhen`)](https://learn.microsoft.com/dotnet/csharp/language-reference/attributes/nullable-analysis)
- [Best practices for exceptions](https://learn.microsoft.com/dotnet/standard/exceptions/best-practices-for-exceptions)
- [BenchmarkDotNet](https://benchmarkdotnet.org/)
