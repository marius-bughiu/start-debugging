---
title: "NUnit 5: Assert.ThrowsAsync Now Returns a Task, and an Unawaited One Passes Silently"
description: "NUnit 5.0.0 makes Assert.ThrowsAsync, CatchAsync and DoesNotThrowAsync truly asynchronous. Forget the await and the assertion never runs. Here is what breaks, what the NUnit.Analyzers NUnit2059 rule catches, and the other NUnit 5 changes to check before upgrading."
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
---

[NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) shipped on September 27, 2026. The maintainers call it a small major release, and most of the [breaking changes](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html) turn runtime failures into compiler errors. One change goes the other way: if you upgrade carelessly, a failing test can start passing.

## ThrowsAsync used to block, now it returns a Task

In NUnit 4, `Assert.ThrowsAsync<T>`, `Assert.CatchAsync` and `Assert.DoesNotThrowAsync` had async names but ran the delegate synchronously, blocking the calling thread, and returned the exception directly. [Issue #4384](https://github.com/nunit/nunit/issues/4384) fixed that in 5.0.0: all three now return a `Task` and must be awaited.

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

The new shape is the right one. The problem is the code you already have.

## The silent pass

Old tests call `ThrowsAsync` from a plain `void` test method. In NUnit 5 that still compiles: the returned `Task` is discarded, and because the method is not `async`, the compiler does not even emit CS4014. I ran this on .NET SDK 10.0.302 with NUnit3TestAdapter 6.3.0, where `DoesNotThrowAsync` never throws:

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

The results:

| Setup | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | fails (correct) | CS1061, `ArgumentException` has no `GetAwaiter` |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **passes** | fails (correct) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 or 4.15.0 | build error NUnit2059 | fails (correct) |

The middle row is the one to worry about. The test that should catch a missing `ArgumentException` goes green, and nothing in the test output hints that the assertion never ran.

## Let the analyzer do the migration

[NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 added NUnit2059, "Method 'ThrowsAsync' returns a Task and is not being observed", reported as an error by default. Its code fix adds the `await` and changes the enclosing method to `async Task`. So the upgrade order matters:

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

Bump the analyzer in the same commit as the framework. If your projects pin NUnit.Analyzers centrally in `Directory.Packages.props` at an older version, or removed it, the build stays green and you get the silent-pass row.

## The other NUnit 5 changes worth a grep

- `TestDelegate`, `AsyncTestDelegate` and `ActualValueDelegate<T>` are gone. Lambdas are unaffected; explicit uses become `Action`, `Func<Task>` and `Func<T>`.
- `[Platform("NET")]` and `"DotNET"` now mean modern .NET, not .NET Framework. Use the new `"NETFramework"` identifier if that is what you meant, or tests will quietly start running (or stop running) on the wrong runtime.
- `Is.SameAs` only accepts reference types, and `Has.Attribute<T>()` requires `T : Attribute`. Both were runtime failures before.
- `StringAssert`, `CollectionAssert`, `FileAssert` and `DirectoryAssert` move back to `NUnit.Framework`.
- The framework targets `net462`, `net8.0` and `net10.0`. The `net6.0` target is gone.
- `[Order]` is now `[Obsolete]`. The replacements are the new `[DependsOnTest]` and `[DependsOnFixture]` attributes, which skip a test when its dependency fails.

If you are deciding whether NUnit is still the right framework for a new project, my [xUnit v3 vs NUnit vs MSTest comparison](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) was measured on NUnit 4.6.1. The numbers there predate 5.0.0, but the recommendation does not hinge on anything this release changed.
