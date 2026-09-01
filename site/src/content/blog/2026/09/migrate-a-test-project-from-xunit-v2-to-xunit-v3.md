---
title: "Migrate a test project from xUnit v2 to xUnit v3 (2.9.3 to 4.0.0)"
description: "A step-by-step migration from xunit 2.9.3 to xunit.v3 4.0.0: package swaps, the OutputType Exe change, IAsyncLifetime returning ValueTask, the Xunit.Abstractions removal, and the CI filter syntax that silently stops matching."
pubDate: 2026-09-01
template: migration
tags:
  - "migration"
  - "xunit"
  - "xunit-v3"
  - "testing"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
---

Migrating a normal test project from `xunit` 2.9.3 to `xunit.v3` 4.0.0 takes about an hour of mechanical work: swap four package references, flip `OutputType` to `Exe`, delete every `using Xunit.Abstractions;`, and change `IAsyncLifetime` from `Task` to `ValueTask`. What actually eats the day is everything around the test project: a third-party package with no v3 build will break the compile with a duplicate `FactAttribute` error, and your CI `dotnet test --filter` expression will stop matching anything without failing the build. The migration is worth doing (v3 has been the only line receiving features since 2.9.3 shipped in January 2025), and it is reversible right up until you delete the old branch. Everything below is against `xunit.v3` 4.0.0, released August 15 2026, on the .NET 10 and .NET 11 SDKs.

## Why this is not just a version bump

- **v2 is feature-frozen.** 2.9.3 (January 8 2025) is the last v2 release. `TestContext`, cancellation-aware timeouts, assembly fixtures, dynamic skipping and the query filter language exist only in v3.
- **Test projects become executables.** A v3 project has a generated entry point and runs itself. That removes the runner-version-vs-framework-version mismatch class of bug entirely, and it is what makes Native AOT test builds possible in 4.0.0.
- **`TestContext.Current.CancellationToken` makes timeouts real.** In v2 a `[Fact(Timeout = ...)]` on a non-async test could not interrupt anything. In v3 the token flows into your code, so a hung HTTP call actually cancels.
- **Microsoft.Testing.Platform is opt-in but native.** The `xunit.v3` 4.0.0 metapackage resolves to `xunit.v3.mtp-v2`, which pulls MTP v2 in for you. You get `--report-trx`, CTRF output and much faster startup without a VSTest host process.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| `xunit.abstractions` | Package and namespace are gone. `ITestOutputHelper` moved to `Xunit` | high |
| Project shape | `OutputType` must be `Exe`; SDK-style projects only | high |
| Target framework | Minimum is `net472` or `net8.0`. `netcoreapp3.1` through `net7.0` are out | high |
| `IAsyncLifetime` | Inherits `IAsyncDisposable`; both methods return `ValueTask`, not `Task` | high |
| `async void` tests | Fast-fail at runtime instead of running | high |
| Third-party packages | Any package referencing `xunit.core` 2.x collides with `xunit.v3.core` | high |
| CI filters | VSTest `--filter` expressions are not supported under MTP | high |
| `MemberDataAttribute` | `Parameters` renamed to `Arguments`; `ConvertDataItem` is now `ConvertDataRow` | medium |
| Orderer / framework attributes | `CollectionBehavior`, `TestCaseOrderer`, `TestFramework` take `Type`, not strings | medium |
| `AssemblyTraitAttribute` | Removed. Apply `[assembly: Trait(...)]` instead | low |
| `PropertyDataAttribute` | Removed (deprecated since v1) | low |
| Disposal | When a fixture implements both `IDisposable` and `IAsyncDisposable`, only `DisposeAsync` is called | medium |

The two rows to plan around are the third-party one and the CI one. Everything else the compiler tells you about.

## Pre-flight checklist

- **.NET 8 SDK or later installed.** `xunit.v3` 4.0.0 targets `net472` and `net8.0`; there is no `netstandard2.0` surface for the core package.
- **Every test project is SDK-style.** Pre-SDK `.csproj` files are not supported at all. Convert first, in a separate commit.
- **Inventory your xUnit-adjacent packages.** Run `dotnet list package --include-transitive | grep -i xunit` in each test project and write the list down. This is the list that decides whether the migration is one hour or one week.
- **Know which runner your CI uses.** Grep your pipeline for `dotnet test`, `--filter`, `--logger`, and `vstest.console.exe`.
- **Branch.** Migrate one test project first, all the way through CI, before touching the rest.

## Migration steps

1. **Retarget the test project and make it an executable.**

   Bump `TargetFramework` to `net8.0` or later and set `OutputType`. The generated entry point comes from the package; you do not write a `Main`.

   ```xml
   <!-- MyApp.Tests.csproj, .NET 10 SDK, xunit.v3 4.0.0 -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <OutputType>Exe</OutputType>
     <Nullable>enable</Nullable>
     <ImplicitUsings>enable</ImplicitUsings>
   </PropertyGroup>
   ```

   Verify: `dotnet build` fails with missing xUnit types, not with project-shape errors. If you already have top-level statements in the test project, set `<XunitAutoGeneratedEntryPoint>false</XunitAutoGeneratedEntryPoint>` and own the entry point yourself.

2. **Swap the package references.**

   The v2 to v3 mapping is one-for-one except that `xunit.abstractions` disappears and `xunit.console` has no successor.

   ```xml
   <!-- before: xunit 2.9.3 -->
   <ItemGroup>
     <PackageReference Include="xunit" Version="2.9.3" />
     <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>

   <!-- after: xunit.v3 4.0.0 -->
   <ItemGroup>
     <PackageReference Include="xunit.v3" Version="4.0.0" />
     <PackageReference Include="xunit.runner.visualstudio" Version="4.0.0" />
     <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
   </ItemGroup>
   ```

   `xunit.v3` 4.0.0 resolves to `xunit.v3.mtp-v2`, which brings in `xunit.v3.core.mtp-v2`, `xunit.v3.assert` and `xunit.analyzers` 2.0.0. Keep `xunit.runner.visualstudio` 4.0.0 and `Microsoft.NET.Test.Sdk` for now: the runner package handles v1, v2 and v3, so Test Explorer and VSTest keep working while you migrate the rest of the solution. If you are on Central Package Management, do this in `Directory.Packages.props` instead, which is the whole point of [moving a solution to Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).

   Verify: `dotnet restore` succeeds with no NU1605 downgrade warnings and no duplicate-type errors.

3. **Delete every `using Xunit.Abstractions;`.**

   `ITestOutputHelper` lives in `Xunit` now, alongside `Fact` and `Assert`, so in most files the fix is deleting a line.

   ```csharp
   // xunit.v3 4.0.0 - no Xunit.Abstractions anywhere
   using Xunit;

   public class OrderServiceTests(ITestOutputHelper output)
   {
       [Fact]
       public void Prices_include_tax()
       {
           output.WriteLine("running");   // v3 also adds Write(), not just WriteLine()
           Assert.Equal(120m, new OrderService().Total(100m));
       }
   }
   ```

   Verify: `grep -rn "Xunit.Abstractions" .` returns nothing under your test projects.

4. **Convert `IAsyncLifetime` implementations to `ValueTask`.**

   This is the change people get wrong, because the compiler error points at the return type and hides the disposal semantics behind it. `IAsyncLifetime` now inherits `IAsyncDisposable`, and both members return `ValueTask`.

   ```csharp
   // v2: xunit 2.9.3
   public class DbFixture : IAsyncLifetime
   {
       public Task InitializeAsync() => _container.StartAsync();
       public Task DisposeAsync()    => _container.DisposeAsync().AsTask();
   }

   // v3: xunit.v3 4.0.0
   public class DbFixture : IAsyncLifetime
   {
       public ValueTask InitializeAsync() => new(_container.StartAsync());
       public ValueTask DisposeAsync()    => _container.DisposeAsync();
   }
   ```

   The trap: if your fixture implements `IDisposable` **and** `IAsyncLifetime`, v2 called `Dispose()` and v3 does not. It calls `DisposeAsync()` only, following the .NET guidance that you invoke one or the other. Any cleanup that lived exclusively in `Dispose()` silently stops running, which usually shows up as a leaked Testcontainers container or an undeleted temp directory rather than a failing test. Move that cleanup into `DisposeAsync()`. This matters most for the container-per-fixture pattern in [integration tests against real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).

   Verify: run the suite and confirm no orphaned containers with `docker ps -a`.

5. **Fix `async void` tests and the mechanical attribute renames.**

   v3 fast-fails `async void` tests at runtime rather than running them fire-and-forget, so change the signature to `async Task`. This is the same reasoning laid out in [async void vs async Task in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/), except now the framework enforces it. Then apply the string-to-`Type` attribute conversions:

   ```csharp
   // v2
   [assembly: CollectionBehavior("MyTests.MyCollectionFactory", "MyTests")]
   [assembly: AssemblyTrait("Category", "Integration")]

   // v3, xunit.v3 4.0.0
   [assembly: CollectionBehavior(typeof(MyCollectionFactory))]
   [assembly: Trait("Category", "Integration")]
   ```

   `TestCaseOrdererAttribute`, `TestCollectionOrdererAttribute` and `TestFrameworkAttribute` take the same treatment. `MemberDataAttribute.Parameters` is now `Arguments`, and if you subclassed `MemberDataAttributeBase`, `ConvertDataItem` became `ConvertDataRow` and returns `ITheoryDataRow` instead of `object[]`.

   Verify: `dotnet build` is clean except for `xUnit1051` warnings, which are the subject of the next step.

6. **Thread `TestContext.Current.CancellationToken` through your awaits.**

   `xunit.analyzers` 2.0.0 raises `xUnit1051` on every call that accepts a `CancellationToken` and does not get one. It is a warning, not an error, and you can migrate without touching it, but the token is most of the reason to be on v3.

   ```csharp
   // xunit.v3 4.0.0 - the token cancels when the test times out or the run is aborted
   [Fact(Timeout = 5000)]
   public async Task Fetches_the_order()
   {
       var ct = TestContext.Current.CancellationToken;
       var response = await _client.GetAsync("/orders/1", ct);
       Assert.Equal(HttpStatusCode.OK, response.StatusCode);
   }
   ```

   Verify: `dotnet build -warnaserror:xUnit1051` passes once you are done, or leave it as a warning and come back.

7. **Point CI at the new filter syntax.**

   Then decide whether to enable Microsoft.Testing.Platform. Under MTP, xUnit does not accept VSTest's `--filter` expression language; it exposes `--filter-class`, `--filter-method`, `--filter-namespace`, `--filter-trait`, their `--filter-not-*` counterparts, and `--filter-query`. On the .NET 8 and 9 SDKs you opt in per project:

   ```xml
   <!-- .NET 8/9 SDK -->
   <PropertyGroup>
     <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
   </PropertyGroup>
   ```

   On the .NET 10 SDK and later you opt in once for the repository:

   ```json
   // global.json
   {
     "test": { "runner": "Microsoft.Testing.Platform" }
   }
   ```

   And the filter itself changes shape:

   ```bash
   # before, VSTest
   dotnet test --filter "Category!=Integration"

   # after, MTP with xunit.v3 4.0.0
   dotnet test -- --filter-not-trait "Category=Integration"
   ```

   Verify: run the filtered command and confirm the reported test count is lower than the unfiltered count. Do not trust a green build here, because a filter that matches nothing exits zero.

## Verify the migration

Run these in order, and treat any surprise in test counts as a failure even when the exit code is zero.

- `dotnet build -c Release` with zero warnings other than ones you triaged.
- `dotnet run --project MyApp.Tests -- --list` to confirm discovery finds the number of tests you expect.
- `dotnet test` and compare the total against the last v2 run. A drop almost always means a filter or a skipped `async void` test.
- Open Test Explorer once. If tests run from the command line but Visual Studio hangs, that is the [Test Explorer hang on xUnit v3 projects](/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/), not a bad migration.
- Check your coverage numbers. Coverlet attaches differently under MTP, and a coverage report that suddenly reads 0% is a wiring problem, not a regression.

## Rollback

This migration is fully reversible: it is package references plus source edits, with no on-disk state and no database schema. `git revert` the commit and the v2 suite runs again, provided you did not also retarget below `net8.0` in the same commit. Keep the retarget separate for exactly this reason. The one-way part is any third-party fork you had to publish (see below), which stays useful either way.

## Gotchas worth knowing before you start

**The duplicate `FactAttribute` error.** If any package in the graph still references `xunit.core` 2.x, you get:

```
error CS0433: The type 'FactAttribute' exists in both
'xunit.core, Version=2.4.2.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c' and
'xunit.v3.core, Version=4.0.0.0, Culture=neutral, PublicKeyToken=8d05b1bb7a6fdb6c'
```

There is no alias trick worth attempting. Either the package has a v3 build or it does not. As of September 2026: `Verify.XunitV3` 32.0.0, `AutoFixture.Xunit3` 4.19.0, `Xunit.DependencyInjection` 12.0.1 and `MartinCostello.Logging.XUnit.v3` 0.7.1 all reference `xunit.v3.*` 4.x. `Serilog.Sinks.XUnit` 3.0.19 still pulls `xunit.abstractions` 2.0.3 and `xunit.extensibility.core` 2.9.2, so it is a hard blocker; the usual workaround is a small in-repo sink that writes to `ITestOutputHelper` directly, which is about thirty lines.

**`Xunit.SkippableFact` is dead weight now.** Delete it. v3 has `Assert.Skip(reason)`, `Assert.SkipWhen(condition, reason)` and `Assert.SkipUnless(condition, reason)`, plus `SkipWhen` and `SkipUnless` properties on `[Fact]` and `[Theory]` that point at a public static `bool` property on the test class. Setting both `SkipWhen` and `SkipUnless` on one attribute is a runtime failure, not a compile error.

**Attribute instances are cached in v3.** v2 created a fresh attribute instance per query; v3 caches, matching normal .NET reflection behaviour. Custom attributes that mutated their own state between discovery and execution will behave differently.

**Version-pinning across a solution.** `xunit.v3` 4.0.0 pins `xunit.v3.mtp-v2` to an exact `[4.0.0, 4.0.0]` range, so mixed versions across projects surface as restore conflicts rather than runtime weirdness. That is a feature, but it means you upgrade all test projects in one commit or none.

**Custom `ITestCaseOrderer` implementations changed in 4.0.0**, not just between v2 and v3. Ordering now runs collection, then class, then method, then case, and there are separate class and method orderer extension points. If you carried a v2 orderer through v3.2.2 unchanged, 4.0.0 is where it stops compiling.

**`WebApplicationFactory<T>` needs no changes.** ASP.NET Core integration tests migrate cleanly; the fixture pattern in [integration tests with WebApplicationFactory](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) works as written once `IAsyncLifetime` returns `ValueTask`.

## Related

- [xUnit v3 vs NUnit vs MSTest in 2026: which should you pick?](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/)
- [Fix: Visual Studio Test Explorer hangs on an xUnit v3 project while dotnet test passes](/2026/08/fix-visual-studio-test-explorer-hangs-on-xunit-v3-while-dotnet-test-passes/)
- [Microsoft.Testing.Platform 2.3 puts test failures on the PR diff](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/)
- [How to write integration tests with WebApplicationFactory in ASP.NET Core 11](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Migrate a .NET solution to Central Package Management with Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)

## Sources

- [Migrating Unit Tests from v2 to v3](https://xunit.net/docs/getting-started/v3/migration) -- xUnit.net
- [What's New in v3?](https://xunit.net/docs/getting-started/v3/whats-new) -- xUnit.net
- [Microsoft Testing Platform (xUnit.net v3)](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform) -- xUnit.net
- [xUnit.net v3 4.0.0 release notes](https://xunit.net/releases/v3/4.0.0) -- xUnit.net
- [Migration guide from VSTest to Microsoft.Testing.Platform](https://learn.microsoft.com/en-us/dotnet/core/testing/migrating-vstest-microsoft-testing-platform) -- Microsoft Learn
- [xunit.v3 on NuGet](https://www.nuget.org/packages/xunit.v3/4.0.0) -- package metadata and dependency ranges
- [Migrating from XUnit v2 to v3: troubleshooting](https://bartwullems.blogspot.com/2025/09/migrating-from-xunit-v2-to.html) -- Bart Wullems
