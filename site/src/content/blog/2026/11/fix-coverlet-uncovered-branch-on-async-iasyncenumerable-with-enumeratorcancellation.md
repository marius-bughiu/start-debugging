---
title: "Fix: coverlet reports an uncovered branch on the closing brace of an async IAsyncEnumerable<T> method"
description: "The branch is the compiler's null check on the [EnumeratorCancellation] linked token source. coverlet before 10.0.0 misses it in generic iterators: upgrade."
pubDate: 2026-11-13
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "testing"
  - "code-coverage"
  - "iasyncenumerable"
---

The half-covered branch on the closing brace of an `async IAsyncEnumerable<T>` method is not in your code. It is the compiler's `if (<>x__combinedTokens != null) <>x__combinedTokens.Dispose();` check, which exists because the method has an `[EnumeratorCancellation]` parameter. coverlet has a filter that hides that check, but before coverlet 10.0.0 the filter only matched when the iterator's state machine was non-generic, so a generic method like `ExecuteTable<T>` shows `50% (1/2)` while an identical `IAsyncEnumerable<object>` method shows 100%. Upgrade `coverlet.collector` / `coverlet.msbuild` to 10.0.0 or later (current is 10.1.0) and the branch disappears. Microsoft's own code coverage (Microsoft.CodeCoverage 18.12.0) reports the same branch on every such iterator, generic or not; there the fix is a test that finishes an enumeration with two different tokens. Everything below was run on .NET SDK 10.0.302 (runtime 10.0.10), C# 14, xUnit 2.9.3, macOS arm64.

## The error in context

The report this page answers comes from the Stack Overflow question [Code coverage reports uncovered branch on method returning IAsyncEnumerable&lt;T&gt;](https://stackoverflow.com/questions/79901450), where the asker used xUnit, coverlet and Fine Code Coverage. The Cobertura output for the generic method looks like this:

```xml
<class name="Lib.Rows/&lt;ExecuteTable&gt;d__2`1" branch-rate="0.8333" complexity="6">
  <line number="15" hits="18" branch="True" condition-coverage="100% (4/4)">
    <conditions>
      <condition number="370" type="jump" coverage="100%" />
      <condition number="470" type="jump" coverage="100%" />
    </conditions>
  </line>
  <line number="20" hits="2" branch="True" condition-coverage="50% (1/2)">
    <conditions>
      <condition number="578" type="jump" coverage="50%" />
    </conditions>
  </line>
</class>
```

Line 15 is the `foreach`, line 20 is the method's closing `}`. The same body returning `IAsyncEnumerable<object>` gets `branch-rate="1"` with a plain `100% (2/2)` on the `foreach` and no branch at all on the closing brace. Both the asker's report and the one above have the same shape: two conditions on the `foreach` line instead of one, and a single half-covered condition on the brace.

## Why this happens: the `[EnumeratorCancellation]` linked token source

An async iterator can receive a `CancellationToken` from two places: the method argument, and `GetAsyncEnumerator(token)` (which is what `WithCancellation(token)` feeds). When the parameter carries `[EnumeratorCancellation]`, the C# compiler merges them in the generated `GetAsyncEnumerator`:

- If one of the two tokens is `default`, the other one is used directly.
- If both are real tokens and they differ, it calls `CancellationTokenSource.CreateLinkedTokenSource(a, b)` and stores the result in a compiler-generated field named `<>x__combinedTokens`.

That linked source has to be disposed when the iterator finishes, so `MoveNext` gets two extra null checks: one on the path where the body completes normally and one in the generated `catch` that turns an exception into a faulted `MoveNextAsync`. Dumping the IL of the generic state machine with `ilspycmd -il` shows both:

```text
// ilspycmd 11.2.0, Lib.dll built Debug with SDK 10.0.302
// in the generated catch block
IL_01d0: ldarg.0
IL_01d1: ldfld class [System.Runtime]System.Threading.CancellationTokenSource class Lib.Rows/'<ExecuteTable>d__2`1'<!T>::'<>x__combinedTokens'
IL_01d6: brfalse.s IL_01eb
// after the body completes
IL_023c: ldarg.0
IL_023d: ldfld class [System.Runtime]System.Threading.CancellationTokenSource class Lib.Rows/'<ExecuteTable>d__2`1'<!T>::'<>x__combinedTokens'
IL_0242: brfalse.s IL_0257
```

Cobertura's `condition number` is the IL offset of the branch instruction. `470` is `0x1d6`, the catch-path check, and coverlet attributes it to the `foreach` line because that is the nearest sequence point. `578` is `0x242`, the completion-path check, which sits under the closing brace. Those are exactly the two extra conditions in the report.

### Why only the generic method

coverlet removes compiler-generated branches by pattern-matching IL. Its `SkipGeneratedBranchesForEnumeratorCancellationAttribute` filter looks for `ldarg.0; ldfld <>x__combinedTokens; brfalse`. In coverlet 6.0.4 and 8.0.1 the check is:

```csharp
// coverlet 6.0.4 / 8.0.1, src/coverlet.core/Symbols/CecilSymbolHelper.cs
instructions[branchIndex - 1].Operand is FieldDefinition field &&
field.FieldType.FullName.Equals("System.Threading.CancellationTokenSource") &&
field.FullName.EndsWith("x__combinedTokens")
```

In a non-generic state machine (`<ExecuteObject>d__3`), the `ldfld` operand is a Cecil `FieldDefinition`, the pattern matches, and the branch is dropped. In a generic one (`<ExecuteTable>d__2`1`), the field is accessed through the instantiated type `<ExecuteTable>d__2`1<!T>`, so Cecil hands back a `FieldReference`, the `is FieldDefinition` test fails, and the branch is reported. Nothing about `dynamic` matters here; any non-generic element type behaves the same, which is why the asker's non-generic, non-dynamic test version was also fully covered.

This was tracked as [coverlet#1836, "wrong branch rate on IAsyncEnumerable"](https://github.com/coverlet-coverage/coverlet/issues/1836) and fixed in the 10.0.0 release (2026-04-17). The current filter accepts both shapes:

```csharp
// coverlet master (10.x), CecilSymbolHelper.IsCombinedCancellationTokensField
FieldDefinition { FieldType.FullName: "System.Threading.CancellationTokenSource" } field
  when field.FullName.EndsWith("x__combinedTokens") => true,
FieldReference { FieldType.FullName: "System.Threading.CancellationTokenSource" } fieldRef
  when fieldRef.FullName.EndsWith("x__combinedTokens") => true,
```

### Why the completion-path check is only half covered

Coverage is honest about what your tests did. The catch-path check is `100%` because one test (`CancelInLoop_DifferentTokens` below) passes a real token to the method, a different one to `GetAsyncEnumerator`, and then cancels, so the linked source exists when the exception path runs, while other failing tests go through it with no linked source. The completion-path check is only reached by tests that enumerate to the end, and all of those pass `CancellationToken.None` (or the same token twice), so `<>x__combinedTokens` is always `null` there. One outcome of the branch never happens.

## Minimal repro

Three iterators with identical bodies: generic, `object`, and `int`.

```csharp
// .NET 10, C# 14 -- Lib/Rows.cs
using System.Runtime.CompilerServices;

namespace Lib;

public sealed record Result(string[] Columns, List<object?[]> Rows);

public sealed class Rows(Func<string, CancellationToken, Task<Result>> execute)
{
    public async IAsyncEnumerable<T> ExecuteTable<T>(
        string sql,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var res = await execute(sql, cancellationToken).ConfigureAwait(false);
        foreach (var row in res.Rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return (T)row[0]!;
        }
    }

    public async IAsyncEnumerable<object> ExecuteObject(
        string sql,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var res = await execute(sql, cancellationToken).ConfigureAwait(false);
        foreach (var row in res.Rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return row[0]!;
        }
    }

    public async IAsyncEnumerable<int> ExecuteInt(
        string sql,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var res = await execute(sql, cancellationToken).ConfigureAwait(false);
        foreach (var row in res.Rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return (int)row[0]!;
        }
    }
}
```

The tests mirror the asker's set: rows, no rows, a failing query, cancellation before start, and cancellation mid-loop with separate method and enumerator tokens. Each runs against all three iterators. `Select` and `FirstAsync` come from `System.Linq.AsyncEnumerable`, which ships in the .NET 10 shared framework.

```csharp
// .NET 10, C# 14, xUnit 2.9.3 -- Lib.Tests/RowsTests.cs
using Lib;

public class RowsTests
{
    public static TheoryData<string> Variants => new() { "generic", "object", "int" };

    static Rows Make(int count, Exception? fail = null) => new(async (sql, ct) =>
    {
        await Task.Yield();
        ct.ThrowIfCancellationRequested();
        if (fail is not null) throw fail;
        var rows = Enumerable.Range(1, count).Select(i => new object?[] { i }).ToList();
        return new Result(["ID"], rows);
    });

    static IAsyncEnumerable<object> Run(Rows r, string v, CancellationToken ct) => v switch
    {
        "generic" => r.ExecuteTable<int>("q", ct).Select(x => (object)x),
        "object" => r.ExecuteObject("q", ct),
        _ => r.ExecuteInt("q", ct).Select(x => (object)x),
    };

    [Theory, MemberData(nameof(Variants))]
    public async Task ReturnsRows(string v)
    {
        var list = new List<object>();
        await foreach (var x in Run(Make(3), v, CancellationToken.None)) list.Add(x);
        Assert.Equal(3, list.Count);
    }

    [Theory, MemberData(nameof(Variants))]
    public async Task NoRows(string v)
    {
        var list = new List<object>();
        await foreach (var x in Run(Make(0), v, CancellationToken.None)) list.Add(x);
        Assert.Empty(list);
    }

    [Theory, MemberData(nameof(Variants))]
    public async Task ExecuteThrows(string v)
    {
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (var _ in Run(Make(3, new InvalidOperationException()), v, CancellationToken.None)) { }
        });
    }

    [Theory, MemberData(nameof(Variants))]
    public async Task CancelBeforeStart(string v)
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await Run(Make(3), v, cts.Token).FirstAsync(cts.Token));
    }

    [Theory, MemberData(nameof(Variants))]
    public async Task CancelInLoop_DifferentTokens(string v)
    {
        using var methodCts = new CancellationTokenSource(); // plays TestContext.Current.CancellationToken
        using var cts = new CancellationTokenSource();
        await using var e = Run(Make(3), v, methodCts.Token).GetAsyncEnumerator(cts.Token);
        Assert.True(await e.MoveNextAsync());
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await e.MoveNextAsync());
    }
}
```

Run it with the VSTest collector:

```bash
dotnet test --collect:"XPlat Code Coverage" --results-directory ./tr
```

The test project is the stock `dotnet new xunit` template (`Microsoft.NET.Test.Sdk`, `xunit` 2.9.3, `xunit.runner.visualstudio` 3.1.4) with only the `coverlet.collector` version changed between runs. All 15 tests pass in every run.

## Results by coverage tool and version

Branch entries per state machine from `coverage.cobertura.xml`, same code, same tests:

| Tool | `ExecuteTable<T>` | `ExecuteObject` | `ExecuteInt` |
|---|---|---|---|
| coverlet.collector 6.0.4 | 0.8333: `foreach` 4/4, `}` 1/2 | 1.0: `foreach` 2/2 | 1.0: `foreach` 2/2 |
| coverlet.collector 8.0.1 | 0.8333: `foreach` 4/4, `}` 1/2 | 1.0 | 1.0 |
| coverlet.collector 10.0.0 | 1.0: `foreach` 2/2 | 1.0 | 1.0 |
| coverlet.collector 10.1.0 | 1.0: `foreach` 2/2 | 1.0 | 1.0 |
| Microsoft.CodeCoverage 18.12.0 | 0.75: `foreach` 2/2, `}` 1/2 | 0.75: `}` 1/2 | 0.75: `}` 1/2 |

The coverlet 6.0.4 row reproduces the asker's report exactly, down to the shape of the conditions. The Microsoft row is a different story: `dotnet test --collect:"Code Coverage;Format=cobertura"` with `Microsoft.NET.Test.Sdk` 18.12.0 (which brings `Microsoft.CodeCoverage` 18.12.0) drops the catch-path check but keeps the completion-path check on all three iterators. It does not discriminate between generic and non-generic; it just reports the branch everywhere. If you use Fine Code Coverage, check its `RunMsCodeCoverage` option: depending on that setting, it runs Microsoft's coverage or its own bundled coverlet, so the version in your `.csproj` may not be the one producing the numbers you see.

## Fix, in order of preference

### 1. Upgrade coverlet to 10.0.0 or later

If coverlet produces the report, this is the whole fix. With the collector:

```xml
<!-- .NET 10 test project -->
<PackageReference Include="coverlet.collector" Version="10.1.0" />
```

If you use `coverlet.msbuild` (`dotnet test /p:CollectCoverage=true`) or the global `coverlet.console` tool, bump those to the same version; all three share `coverlet.core` and the fix landed in all of them in 10.0.0. With Central Package Management, change the version in `Directory.Packages.props`, then confirm what actually restored:

```bash
dotnet list package --include-transitive | grep -i coverlet
```

Re-run coverage and the generic iterator's closing brace no longer has a branch. No test changes needed.

### 2. Cover the branch with a test that completes with two tokens

On Microsoft's coverage, or if you are stuck on an older coverlet, give the completion path a linked token source to dispose. One extra test does it: pass a real token to the method, a different one via `WithCancellation`, and enumerate to the end.

```csharp
// .NET 10, C# 14, xUnit 2.9.3
[Fact]
public async Task CompletesWithMethodAndEnumeratorTokens()
{
    using var methodCts = new CancellationTokenSource();
    using var enumeratorCts = new CancellationTokenSource();
    var rows = new Rows((_, _) => Task.FromResult(new Result(["ID"], [[1], [2]])));

    var list = new List<int>();
    await foreach (var x in rows.ExecuteTable<int>("q", methodCts.Token)
                                .WithCancellation(enumeratorCts.Token))
        list.Add(x);

    Assert.Equal([1, 2], list);
}
```

With this test added, coverlet 6.0.4 reports `ExecuteTable<T>` at `branch-rate 1` (`foreach` 4/4, `}` 2/2), and Microsoft.CodeCoverage 18.12.0 reports it at 1 with `}` 2/2. Note that under Microsoft's tool you need one such test per iterator method: `ExecuteObject` and `ExecuteInt` stayed at 0.75 because the test only touched `ExecuteTable<T>`.

This test is not pure coverage-chasing. It is the only test that proves the iterator still completes normally when a caller combines a method token with `WithCancellation`, which is the exact situation `[EnumeratorCancellation]` exists for. In xUnit v3, `TestContext.Current.CancellationToken` passed to the method plus a separate `CancellationTokenSource` for the enumerator gives you that combination naturally.

### 3. Exclude the method, if you have to

`[ExcludeFromCodeCoverage]` on the iterator method removes its state machine from the line and branch data. With Microsoft.CodeCoverage 18.12.0 the `<ExecuteTable>d__2<T>` class disappears from the report entirely. With coverlet 6.0.4 its lines disappear but an empty `<class>` element for the state machine is still emitted. This also hides real gaps in that method, so prefer options 1 or 2.

## Gotchas and variants

- **The `foreach` line shows 4/4 instead of 2/2.** Same root cause. The catch-path `<>x__combinedTokens` check (IL offset `0x1d6` here) has no sequence point of its own, so coverlet folds it into the `foreach` line. It is covered when at least one failing test uses two distinct tokens, which is why it shows 100% and is easy to miss.
- **Removing `[EnumeratorCancellation]` "fixes" coverage.** Without the attribute the compiler has no tokens to merge, so it never generates `<>x__combinedTokens` or its null checks. It also means a token passed through `WithCancellation` is silently ignored, and the compiler warns with CS8425. Do not trade correctness for a coverage number. The [CancellationToken propagation guide](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) covers why the attribute matters.
- **Same token twice does not create the linked source.** Passing `ct` to the method and `ct` again to `WithCancellation` takes the "tokens are equal" path, so it will not cover the branch. The tokens have to be different and neither can be `default`.
- **A `default` token on either side does not either.** `CancellationToken.None` on one side means the compiler just uses the other token. That is why tests written with `CancellationToken.None` everywhere can never reach the "not null" outcome.
- **Other phantom async branches.** coverlet 10.0.1 also fixed a reported branch in the `finally` of async methods ([coverlet#1337](https://github.com/coverlet-coverage/coverlet/issues/1337)). If you see an uncovered branch on a closing brace in a regular `async Task` method with `try/finally` or `await using`, upgrading is again the first thing to try.
- **Reading the report.** The `condition number` in Cobertura is the IL offset of the branch instruction. If you hit a different phantom branch, dump the state machine with `ilspycmd -il Your.dll` and look at the instruction at that offset; the field name it loads usually tells you which language feature generated it.

## Related

- [What is IAsyncEnumerable<T> and when should I use it?](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) covers how async iterators and `WithCancellation` work.
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) explains how `[EnumeratorCancellation]` routes the enumerator's token into the iterator.
- [Migrating a test project from xUnit v2 to xUnit v3](/2026/09/migrate-a-test-project-from-xunit-v2-to-xunit-v3/) is where `TestContext.Current.CancellationToken` comes from.
- [xUnit v3 vs NUnit vs MSTest in 2026](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) compares the runners these coverage tools plug into.

## Sources

- [Stack Overflow 79901450: Code coverage reports uncovered branch on method returning IAsyncEnumerable&lt;T&gt;](https://stackoverflow.com/questions/79901450)
- [coverlet#1836: wrong branch rate on IAsyncEnumerable](https://github.com/coverlet-coverage/coverlet/issues/1836)
- [coverlet changelog](https://github.com/coverlet-coverage/coverlet/blob/master/Documentation/Changelog.md) (10.0.0 release, 2026-04-17)
- [coverlet `CecilSymbolHelper.cs`](https://github.com/coverlet-coverage/coverlet/blob/master/src/coverlet.core/Symbols/CecilSymbolHelper.cs), compared against the [v6.0.4](https://github.com/coverlet-coverage/coverlet/blob/v6.0.4/src/coverlet.core/Symbols/CecilSymbolHelper.cs) tag
- [EnumeratorCancellationAttribute (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Fine Code Coverage README](https://github.com/FortuneN/FineCodeCoverage), `RunMsCodeCoverage` option
