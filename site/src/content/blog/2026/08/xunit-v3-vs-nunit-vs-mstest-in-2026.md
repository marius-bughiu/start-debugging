---
title: "xUnit v3 vs NUnit vs MSTest in 2026: which should you pick?"
description: "Pick xUnit v3 for greenfield .NET projects, NUnit 4.6 if you live in its constraint model, MSTest 4 if you already ship it. A measured comparison on .NET SDK 10.0.201 covering parallelism defaults, test class lifecycle, assertion failure output, and the Microsoft.Testing.Platform version conflict that breaks the NUnit runner."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "testing"
  - "xunit"
  - "nunit"
  - "mstest"
  - "dotnet"
---

Pick **xUnit v3** for a new .NET project in 2026. It parallelizes by default, its failure messages are the most precise of the three, and it is what the .NET team uses. Pick **NUnit 4.6** if your suite leans on its constraint model or `[Retry]`. Pick **MSTest 4** if you already have MSTest and are not suffering, because v4 closed most of the gap.

All numbers below were measured on .NET SDK 10.0.201 (runtime 10.0.5) against xunit.v3 3.2.2, NUnit 4.6.1 with NUnit3TestAdapter 5.1.0, and MSTest 4.3.3. Every behavioural claim in this post was verified by running code, not by reading a changelog, because a lot of the received wisdom about these three frameworks is now out of date.

## The feature matrix

| Behaviour (versions as tested) | xUnit v3 3.2.2 | NUnit 4.6.1 | MSTest 4.3.3 |
| --- | --- | --- | --- |
| Parallel by default | Yes, across collections | No, opt in | No, opt in |
| New class instance per test | Yes | No, one per fixture | Yes |
| Test attribute | `[Fact]` / `[Theory]` | `[Test]` / `[TestCase]` | `[TestMethod]` / `[DataRow]` |
| Class marker attribute needed | No | No | Yes, `[TestClass]` |
| Assertion style | `Assert.Equal` | Constraints, `Assert.That(x, Is...)` | `Assert.AreEqual`, `Assert.That` |
| Echoes the failing expression | No | Yes | Yes |
| `Assert.Multiple` | Yes | Yes | No |
| Built-in retry attribute | No | Yes, `[Retry(n)]` | Yes, `[Retry(n)]` |
| Project type | Exe, always | Exe when using the NUnit runner | Exe when using the MSTest runner |
| Microsoft.Testing.Platform | Native, built in | Via adapter 5.0+ | Native since 3.2 |
| Minimum target | .NET 8 / .NET Framework 4.7.2 | .NET 6 / .NET Framework 4.6.2 | .NET 8 / .NET Framework 4.6.2 |

Two rows in that table contradict what most comparison posts say. Both are worth their own section.

## The instance lifecycle claim that is wrong everywhere

The most repeated line in this comparison is that xUnit creates a fresh test class instance per test while NUnit and MSTest reuse one instance. Half of that is wrong. MSTest has always constructed a new instance per test method.

Here is the probe, identical in all three projects apart from the attributes:

```csharp
// MSTest 4.3.3, .NET 10.0.201
[TestClass]
public class LifecycleTests
{
    private static int _instances;
    private readonly int _id;
    public LifecycleTests() { _id = Interlocked.Increment(ref _instances); }

    private void Record(string n) =>
        File.AppendAllText(Log, $"{n} ctorId={_id} totalInstances={_instances}");

    [TestMethod] public void A() => Record("A");
    [TestMethod] public void B() => Record("B");
    [TestMethod] public void C() => Record("C");
}
```

Running each of the three:

```text
# xunit.v3 3.2.2
A ctorId=3 totalInstances=3
B ctorId=1 totalInstances=1
C ctorId=2 totalInstances=2

# MSTest 4.3.3
A ctorId=1 totalInstances=1
B ctorId=2 totalInstances=2
C ctorId=3 totalInstances=3

# NUnit 4.6.1
A ctorId=1 totalInstances=1
B ctorId=1 totalInstances=1
C ctorId=1 totalInstances=1
```

xUnit and MSTest both constructed three instances. NUnit constructed one and shared it. NUnit is the outlier, and it is the only one of the three where a mutable instance field leaks state from one test into the next.

This matters more than it sounds. A single instance per fixture is exactly the setup where an `[Order]`-dependent test suite quietly grows, and it interacts badly with parallelism: instance fields become shared mutable state the moment two tests in the same fixture run concurrently. NUnit's own documentation says as much, and gives you the opt out, added back in NUnit 3.13:

```csharp
// NUnit 4.6.1
[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]
public class LifecycleTests { /* ... */ }
```

With that attribute applied, the same probe prints `ctorId=1`, `2`, `3`. If you are on NUnit and you intend to turn on parallelism, apply it at the assembly level before you do. Note that `OneTimeSetUp` and `OneTimeTearDown` must become `static` when you do, since they now run once for a fixture that has no single instance.

## The parallelism benchmark

This is the one real performance difference, and it is entirely about defaults.

**Setup**: four test classes, five tests each, every test `Thread.Sleep(200)`. Twenty tests, so a strictly sequential run has a floor of 4.0 seconds and a perfectly class-parallel run has a floor of 1.0 second. Release build, run as the test executable directly through Microsoft.Testing.Platform, wall clock over three runs after a warm-up, Intel Core Ultra 7 265KF (20 cores, 20 logical), Windows 11, .NET SDK 10.0.201.

| Framework | Default config | With class-level parallelism enabled |
| --- | --- | --- |
| xunit.v3 3.2.2 | 1.29 - 1.32 s | 1.29 - 1.32 s (already the default) |
| NUnit 4.6.1 | 4.71 - 4.73 s | 1.53 - 1.64 s |
| MSTest 4.3.3 | 4.80 - 4.89 s | 1.66 - 1.69 s |

Out of the box xUnit is 3.6x faster than NUnit and 3.7x faster than MSTest on this suite. That is the number that gets quoted. It is also misleading, because it measures a default, not a capability. One assembly-level attribute erases most of it:

```csharp
// NUnit 4.6.1
[assembly: Parallelizable(ParallelScope.Fixtures)]
```

```csharp
// MSTest 4.3.3
[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.ClassLevel)]
```

With those in place all three land between 1.29 and 1.69 seconds. The residual 240 to 380 ms spread is runner startup overhead, not test execution: xUnit v3 hosts Microsoft.Testing.Platform natively, while NUnit 4.6.1 reaches it through the VSTest bridge in NUnit3TestAdapter, which costs a little more at startup.

So the honest framing is this. xUnit's advantage is that the safe default is also the fast default, and it is safe because of the per-test instance model. NUnit and MSTest make you opt in, and on NUnit you should fix the fixture lifecycle first. If your CI has been running a 12-minute MSTest suite serially for three years, the fix is one line, not a migration.

## Assertion failure output, side by side

This used to be a rout. It no longer is. Same three failures, real output from each runner:

```text
# xunit.v3 3.2.2
Assert.Equal() Failure: Strings differ
                  ↓ (pos 7)
Expected: "hello world"
Actual:   "hello wurld"
                  ↑ (pos 7)

Assert.Equal() Failure: Collections differ
                 ↓ (pos 2)
Expected: [1, 2, 3, 8]
Actual:   [1, 2, 4, 8]
                 ↑ (pos 2)
```

```text
# NUnit 4.6.1
Assert.That("hello wurld", Is.EqualTo("hello world"))
String lengths are both 11. Strings differ at index 7.
Expected: "hello world"
But was:  "hello wurld"
------------------^

Assert.That(actual, Is.EqualTo(expected))
Expected and actual are both <System.Int32[4]>
Values differ at index [2]
Expected: 3
But was:  4
```

```text
# MSTest 4.3.3
Assertion failed. Expected strings to be equal.
Strings have same length (11) and differ at 1 location(s). First difference at index 7.

expected: "hello world"
actual:   "hello wurld"

Assert.AreEqual("hello world", "hello wurld")
```

All three point at the exact index. NUnit and MSTest 4 both echo the source expression that failed, which xUnit does not, because MSTest 4 added `CallerArgumentExpression` to every `Assert` API and NUnit has had it since 4.0. xUnit compensates with the visual position markers, which are better for long strings and collections.

Where MSTest still trails is the collection case: `CollectionAssert.AreEqual` prints "Element at index 2 do not match" without showing either sequence, so you get the index but not the shape of the diff. If you compare collections often, that is a real papercut.

Two API details worth knowing before you write MSTest 4 assertions. `Assert.That` takes an `Expression<Func<bool>>`, not a `bool`, so `Assert.That(1 + 1 == 2)` does not compile and `Assert.That(() => 1 + 1 == 2)` does. And MSTest has no `Assert.Multiple`; both xUnit v3 and NUnit 4.6 do.

## The gotcha that picks for you

If you are standing up an NUnit project on the .NET 10.0.201 SDK today with the native NUnit runner, this is what you get:

```text
error CS1705: Assembly 'NUnit3.TestAdapter' with identity 'NUnit3.TestAdapter, Version=5.1.0.0'
uses 'Microsoft.Testing.Platform, Version=1.8.1.0' which has a higher version than referenced
assembly 'Microsoft.Testing.Platform' with identity 'Microsoft.Testing.Platform, Version=1.7.3.0'
```

NUnit3TestAdapter 5.1.0 is compiled against Microsoft.Testing.Platform 1.8.1, but nothing in the package graph declares that dependency, so the version the SDK injects wins: 1.7.3. The project does not build. The fix is to pin both platform assemblies yourself:

```xml
<!-- NUnit 4.6.1 + NUnit3TestAdapter 5.1.0 on .NET SDK 10.0.201 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <EnableNUnitRunner>true</EnableNUnitRunner>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="NUnit" Version="4.6.1" />
  <PackageReference Include="NUnit3TestAdapter" Version="5.1.0" />
  <PackageReference Include="Microsoft.Testing.Platform" Version="1.8.1" />
  <PackageReference Include="Microsoft.Testing.Extensions.VSTestBridge" Version="1.8.1" />
</ItemGroup>
```

Both pins are needed. Adding only `Microsoft.Testing.Platform` clears the error but leaves an MSB3277 conflict warning on `Microsoft.Testing.Extensions.VSTestBridge`. With both, the build is clean.

The equivalent xUnit v3 and MSTest 4 projects need no pinning at all, because both frameworks own their platform dependency end to end:

```xml
<!-- xunit.v3 3.2.2 on .NET SDK 10.0.201: this is the whole file -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OutputType>Exe</OutputType>
  <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
</PropertyGroup>
<ItemGroup>
  <PackageReference Include="xunit.v3" Version="3.2.2" />
</ItemGroup>
```

That single `PackageReference` is the cleanest story of the three. NUnit's runner is a bridge over VSTest wearing an MTP coat, and you can feel the seam. It also shows up in the CLI: xUnit v3 uses its own query language with a single dash (`-filter "/*/*/FailingTests/*"`), while the NUnit runner takes VSTest syntax (`--filter "FullyQualifiedName~FailingTests"`) and MSTest takes MTP graph queries. Three frameworks on one platform, three filter dialects.

## Where each one still wins

**Pick xUnit v3 3.2.2 when** you are starting fresh on .NET 8 or later. The per-test instance model removes a category of order-dependent bugs before you can write them, parallelism is on without you asking, and v3 shipped genuinely useful additions: `Assert.Skip`/`Assert.SkipWhen` for runtime skipping, `MatrixTheoryData`, assembly fixtures via `[assembly: AssemblyFixture(...)]`, and `[CaptureConsole]` for redirecting stray `Console.WriteLine` into the test output.

**Pick NUnit 4.6.1 when** your team already thinks in constraints. `Assert.That(items, Has.Exactly(1).EqualTo(2).And.Length.EqualTo(3))` composes in a way neither of the others matches, and `[TestCase]`, `[Values]`, and `[Combinatorial]` cover parameterised testing more thoroughly than `[Theory]` or `[DataRow]`. It is also the only one of the three still supporting .NET 6, which matters if you have a straggler project. Budget for the MTP pinning above and set the fixture lifecycle explicitly.

**Pick MSTest 4.3.3 when** you already have MSTest. v4 is a real release, not maintenance: `CallerArgumentExpression` on every assert, `Assert.ThrowsExactly`, `AssemblyFixtureProvider` for sharing assembly setup across projects (new in 4.3.0), and AppDomain isolation now off by default under MTP, which Microsoft measured at up to 30% faster. The migration from v3 is not free, since v4 is not binary compatible and drops .NET Core 3.1 through .NET 7, but the analyzers and code fixes handle most of the mechanical work.

## What I would actually do

Greenfield in 2026: xUnit v3. The default configuration is the correct configuration, which is the property you want from a test framework, and the single-package project file is hard to argue with.

Existing NUnit or MSTest suite: stay. The measured gap between these three, once parallelism is enabled, is under 400 ms of startup overhead on a twenty-test suite. That is not a migration budget. Spend the afternoon adding `[assembly: Parallelizable(ParallelScope.Fixtures)]` (plus `[FixtureLifeCycle(LifeCycle.InstancePerTestCase)]`) or `[assembly: Parallelize(...)]` instead, and you will capture nearly all of the available win.

The framework choice matters much less in 2026 than it did in 2022, because Microsoft.Testing.Platform now sits underneath all three. The runner, the reporting, the CI integration, and the CLI are converging. What is left to choose between is the lifecycle model and the assertion dialect, and those are preferences with one real correctness consequence: NUnit's shared fixture instance.

## Related

- If you are wiring up ASP.NET Core tests, start with [integration tests with `WebApplicationFactory<T>`](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/), which works identically across all three frameworks.
- For tests that need a real database rather than a fake, see [running integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Time-dependent tests are the other common source of flakiness: [testing with `TimeProvider` and `FakeTimeProvider`](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- On the reporting side, [Microsoft.Testing.Platform 2.3 puts failures on the PR diff](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) regardless of which framework produced them.
- Two more testing patterns that are framework-agnostic: [unit-testing code that uses `HttpClient`](/2026/04/how-to-unit-test-code-that-uses-httpclient/) and [mocking `DbContext` without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/).

## Sources

- [What's New in xUnit.net v3](https://xunit.net/docs/getting-started/v3/whats-new) and [Microsoft Testing Platform support in xUnit.net v3](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform)
- [xUnit.net shared context documentation](https://xunit.net/docs/shared-context) on the per-test instance model
- [NUnit `FixtureLifeCycle` documentation](https://docs.nunit.org/articles/nunit/writing-tests/attributes/fixturelifecycle.html)
- [NUnit and Microsoft.Testing.Platform](https://docs.nunit.org/articles/vs-test-adapter/NUnit-And-Microsoft-Test-Platform.html)
- [MSTest migration from v3 to v4](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-migration-v3-v4) and [MSTest test lifecycle](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-writing-tests-lifecycle)
- [Microsoft.Testing.Platform: now supported by all major .NET test frameworks](https://devblogs.microsoft.com/dotnet/mtp-adoption-frameworks/)
- Package versions from NuGet: [xunit.v3 3.2.2](https://www.nuget.org/packages/xunit.v3), [NUnit 4.6.1](https://www.nuget.org/packages/NUnit), [MSTest 4.3.3](https://www.nuget.org/packages/MSTest)
