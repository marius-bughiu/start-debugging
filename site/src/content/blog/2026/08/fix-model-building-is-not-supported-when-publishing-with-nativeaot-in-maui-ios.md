---
title: "Fix: Model building is not supported when publishing with NativeAOT in a .NET MAUI iOS build"
description: "iOS builds set DynamicCodeSupport=false, so EF Core refuses to build the model even though you never enabled NativeAOT. Ship a compiled model plus precompiled queries, or turn the interpreter back on."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "maui"
  - "ios"
  - "native-aot"
  - "dotnet-10"
---

Your MAUI iOS app crashes on the first database call with `Model building is not supported when publishing with NativeAOT. Use a compiled model.`, and setting `<PublishAot>false</PublishAot>` does nothing. That is because EF Core never looks at `PublishAot`. It checks `RuntimeFeature.IsDynamicCodeSupported`, and the .NET for iOS targets set that switch to `false` on every iOS, tvOS and Mac Catalyst build unless the interpreter is enabled. The supported fix is to move your `DbContext` and every LINQ query into a plain class library, run `dotnet ef dbcontext optimize --precompile-queries --nativeaot` against it, and add `<InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>`. The one-line escape hatch is `<UseInterpreter>true</UseInterpreter>`, at a real startup cost.

Everything below was verified on macOS with the .NET SDK 10.0.302, `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21 / 9.0.19 / 10.0.11, and the `dotnet-ef` 10.0.11 CLI. The failure and all three fixes reproduce on a plain console app, with no Xcode and no iPhone involved, because the trigger is a single AppContext switch. Where a claim is about the iOS build itself rather than about something I ran, it is sourced from the `dotnet/macios` and `dotnet/sdk` targets and I say so.

## The error in context

```text
System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder...
   at Microsoft.EntityFrameworkCore.DbContext.get_Model()
```

It shows up on the first operation that touches the model: a query, `Add`, `SaveChanges`, or `EnsureCreated`. Creating the `DbContext` alone does not trigger it, which is why the crash usually lands somewhere far from your database setup code.

The two sibling messages you may hit instead, once you start fixing this, are `Design-time DbContext operations are not supported when publishing with NativeAOT.` and `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Both are covered below.

## Why an iOS build reports a NativeAOT error when you never enabled NativeAOT

The message names NativeAOT, but nothing in the check mentions it. Here is the actual code, from [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, DbContextServices.CreateModel
if (modelFromOptions == null
    || (designTime && modelFromOptions is not Metadata.Internal.Model))
{
    return RuntimeFeature.IsDynamicCodeSupported
        ? dependencies.ModelSource.GetModel(_currentContext!.Context, dependencies, designTime)
        : designTime
            ? throw new InvalidOperationException(CoreStrings.NativeAotDesignTimeModel)
            : throw new InvalidOperationException(CoreStrings.NativeAotNoCompiledModel);
}
```

`RuntimeFeature.IsDynamicCodeSupported` reads the AppContext switch `System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported`, which the SDK writes into `runtimeconfig.json` from the `DynamicCodeSupport` MSBuild property. From [`Microsoft.NET.Sdk.targets`](https://github.com/dotnet/sdk/blob/main/src/Tasks/Microsoft.NET.Build.Tasks/targets/Microsoft.NET.Sdk.targets):

```xml
<!-- .NET SDK 10.0.302 -->
<RuntimeHostConfigurationOption Include="System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"
                                Condition="'$(DynamicCodeSupport)' != ''"
                                Value="$(DynamicCodeSupport)"
                                Trim="true" />
```

And here is the line that sets it, from [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) in `dotnet/macios`:

```xml
<!-- dotnet/macios, Xamarin.Shared.Sdk.targets -->
<DynamicCodeSupport Condition="'$(DynamicCodeSupport)' == '' And ( '$(MtouchInterpreter)' == '' And '$(UseInterpreter)' != 'true' ) And ('$(_PlatformName)' == 'iOS' Or '$(_PlatformName)' == 'tvOS' Or '$(_PlatformName)' == 'MacCatalyst')">false</DynamicCodeSupport>
```

Three things follow from that condition, and all three contradict the folklore around this error.

It is not about `PublishAot`. That property appears nowhere in the chain, which is why setting it to `false` changes nothing.

It is not about the Release configuration. The condition has no `Configuration` check. What actually decides it is whether the interpreter is on, so a Debug build with no interpreter gets `IsDynamicCodeSupported = false` too, and a Release build with `UseInterpreter=true` does not.

It does not apply to Android. The platform list is iOS, tvOS and Mac Catalyst only, which is why the same solution keeps working on Android and Windows while iOS crashes.

The property was introduced by [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555), "Set `DynamicCodeSupport=false` to enable trimming in full AOT mode", and it flowed into the MAUI workload in the 8.0.6x band. That timing matches [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), where the reporter pinned the regression between workload 8.0.40 (working) and 8.0.61 (broken) without changing a line of EF Core code.

## Reproducing it without an iPhone

Because the trigger is one switch, you can reproduce and fix this on a desktop console app. Create a project and set the same property the iOS targets set:

```xml
<!-- .NET SDK 10.0.302, net10.0 -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <!-- exactly what Xamarin.Shared.Sdk.targets sets for iOS/tvOS/MacCatalyst -->
  <DynamicCodeSupport>false</DynamicCodeSupport>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
</ItemGroup>
```

```csharp
// .NET 10, EF Core 10.0.11
using System.Runtime.CompilerServices;
using Microsoft.EntityFrameworkCore;

Console.WriteLine($"IsDynamicCodeSupported = {RuntimeFeature.IsDynamicCodeSupported}");

using var db = new NotesContext();
db.Database.EnsureCreated();

public class Note
{
    public int Id { get; set; }
    public string Text { get; set; } = "";
}

public class NotesContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=notes.db");
}
```

`dotnet run` prints `IsDynamicCodeSupported = False` and then throws the exact error. The generated `bin/Debug/net10.0/<app>.runtimeconfig.json` shows where it came from:

```json
"configProperties": {
  "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
}
```

This repro loop matters, because the alternative is a 10 minute device build per attempt.

## Fix 1: a compiled model plus precompiled queries in a shared library

This is the supported route and the only one that keeps the trimming benefit the switch exists for. It has three parts, and skipping any one of them just moves you to the next exception.

**Step 1: move the `DbContext`, the entities, and every LINQ query into a plain `net10.0` class library.** Not `net10.0-ios`. The `dotnet ef` tooling loads your assembly in a design-time process on the host, and it needs a project it can actually build and load. A plain library also gives you a project where `IsDynamicCodeSupported` is still `true`, which the next step requires.

The "every LINQ query" part is not a style preference. I verified it: a query written in the app project that references the optimized library still throws `Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` Precompilation works by generating C# interceptors for the call sites it can see, so a call site in another project is invisible to it. In practice this pushes you to a repository or data-service class in the library, which is where MAUI apps should keep this code anyway.

```csharp
// .NET 10, EF Core 10.0.11 - Notes.Data class library
public static class NoteRepository
{
    public static async Task<List<Note>> GetAllAsync()
    {
        using var db = new NotesContext();
        return await db.Notes.OrderBy(n => n.Id).ToListAsync();
    }

    public static async Task<Note?> FindByTextAsync(string text)
    {
        using var db = new NotesContext();
        var needle = text;
        return await db.Notes.FirstOrDefaultAsync(n => n.Text == needle);
    }
}
```

That `var needle = text;` line is not cosmetic. Writing `n.Text == text` directly against the method parameter fails precompilation on EF Core 10.0.11 with `System.Diagnostics.UnreachableException: IdentifierName of type ParameterSymbol: text`. Copying the parameter into a local first makes the same query precompile cleanly. Keep the local until that is fixed upstream.

**Step 2: opt into interceptors and generate the model.** Add the property to the library:

```xml
<!-- Notes.Data.csproj, EF Core 10.0.11 -->
<PropertyGroup>
  <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
</PropertyGroup>
```

Without it the build fails with `CS9137: The 'interceptors' feature is not enabled in this namespace`. If that code looks familiar it is the same opt-in that trips people up with [the OpenAPI source generator's interceptors](/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

Then, from the library directory:

```bash
dotnet ef dbcontext optimize --output-dir CompiledModels --namespace Notes.Data.CompiledModels --precompile-queries --nativeaot
```

On success it prints:

```text
Successfully generated a compiled model, it will be discovered automatically, but you can also
call 'options.UseModel(Notes.Data.CompiledModels.NotesContextModel.Instance)'.
Run this command again when the model is modified.
```

"Discovered automatically" is an EF Core 9 and later behaviour: the generator emits `[assembly: DbContextModel(typeof(NotesContext), typeof(NotesContextModel))]` into `NotesContextAssemblyAttributes.cs`, and EF finds it as long as the attribute is in the same assembly as the `DbContext`. On EF Core 8 there is no attribute and you must call `UseModel` yourself.

**Step 3: regenerate on every source change.** C# interceptors are pinned to source locations, so any edit in the library invalidates them. The EF docs are blunt about this: interceptor generation "isn't expected to happen in the inner loop". For a real app, add the [`Microsoft.EntityFrameworkCore.Tasks`](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks) package (10.0.11) to the library so MSBuild does it at publish time, rather than relying on a developer remembering the CLI command. I verified the CLI route end to end; the MSBuild integration is what the docs recommend for CI.

With all three in place, my console app with `DynamicCodeSupport=false` inserts a row, lists rows, and runs a parameterized lookup with no exceptions.

## Fix 2: turn the interpreter back on

Look again at the macios condition: setting `MtouchInterpreter` or `UseInterpreter` suppresses `DynamicCodeSupport=false` entirely, so EF Core builds its model at runtime exactly as it does on Android.

```xml
<!-- MAUI app csproj -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <UseInterpreter>true</UseInterpreter>
</PropertyGroup>
```

This is a legitimate configuration, not a hack: the Mono IL interpreter is not JIT, and Apple allows it. What you pay is throughput and startup, since interpreted code is slower than AOT-compiled code and the model still gets built reflectively on first use. Use it to unblock a release, then do Fix 1.

Two caveats. The interpreter also disables IL stripping (`EnableAssemblyILStripping` is forced to `false` when `MtouchInterpreter` is set), so your app bundle grows. And it is a Mono feature: the macios targets emit the warning "The property 'UseInterpreter' has no effect when not using the Mono runtime (for instance when using CoreCLR)". That matters going forward, because [MAUI mobile is CoreCLR-only from .NET 11 Preview 6](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/). Treat this fix as a .NET 10 bridge, not a long-term plan.

## Fix 3: force DynamicCodeSupport back to true

```xml
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">
  <DynamicCodeSupport>true</DynamicCodeSupport>
</PropertyGroup>
```

The condition on the macios line starts with `'$(DynamicCodeSupport)' == ''`, so an explicit value wins and the switch lands in `runtimeconfig.json` as `true`. EF Core then stops throwing.

I am listing this last for a reason. The switch is not decorative: it is what tells the trimmer it may remove the dynamic code paths, which is the whole point of [PR #18555](https://github.com/dotnet/macios/pull/18555). Setting it to `true` while the app is still fully AOT-compiled tells the runtime a lie, and you are relying on every library in your dependency graph tolerating an environment that claims dynamic code support it does not have. If you have already worked through [what trim-safe code actually requires](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) you will recognise the shape of the risk. Use it to diagnose, not to ship.

## EnsureCreated and Migrate still throw after you fix the model

This is the step that catches most MAUI apps, because the standard SQLite bootstrap is a call to `EnsureCreated()` in the app constructor. With a compiled model in place and `IsDynamicCodeSupported = false`, both of these throw:

```text
EnsureCreated: InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
Migrate:       InvalidOperationException: Design-time DbContext operations are not supported when publishing with NativeAOT.
```

Look back at the `CreateModel` snippet: a compiled model is a `RuntimeModel`, not a `Metadata.Internal.Model`, so any code path asking for the design-time model takes the `NativeAotDesignTimeModel` branch. Schema creation needs the design-time model to emit DDL, so it cannot work from a compiled model. This is another EF Core 9 regression: I ran the same `EnsureCreated()` call with the switch off against EF Core 8.0.21 and it created the database without complaint.

The workaround is to stop asking the app to compute DDL. Generate the SQL once on the host and execute it as text:

```bash
dotnet ef migrations script -o Migrations.sql
```

```csharp
// .NET 10, EF Core 10.0.11 - runs fine with IsDynamicCodeSupported = false
using var db = new NotesContext();
db.Database.ExecuteSqlRaw(await File.ReadAllTextAsync(scriptPath));
```

Ship `Migrations.sql` as a MAUI raw asset and run it on first launch. Note that SQLite does not support `--idempotent`; `dotnet ef migrations script --idempotent` fails with "Generating idempotent scripts for migrations is not currently supported for SQLite", so track the applied migration yourself or guard the script with `CREATE TABLE IF NOT EXISTS`. The same "hand over a script instead of running `Migrate()`" reasoning applies when [a migration login cannot create the database](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), for different reasons.

## What changed between EF Core 8, 9 and 10

If your app used to work on iOS with just a compiled model and broke again after an EF Core upgrade, this is why. I ran the same code with `DynamicCodeSupport=false` and a compiled model but no precompiled queries, against three EF Core versions:

| EF Core | Compiled model discovery | `EnsureCreated()` | Simple LINQ query |
| --- | --- | --- | --- |
| 8.0.21 | `UseModel(...)` required | works | works |
| 9.0.19 | automatic | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |
| 10.0.11 | automatic | `NativeAotDesignTimeModel` | `QueryNotPrecompiled` |

On EF Core 8 the query pipeline still compiled LINQ at runtime, and the expression interpreter carried it. From EF Core 9 onwards the compiler gates on the same switch, in [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs):

```csharp
// Microsoft.EntityFrameworkCore 10.0.11, QueryCompiler.ExecuteAsync
var compiledQuery
    = _compiledQueryCache
        .GetOrAddQuery(
            _compiledQueryCacheKeyGenerator.GenerateCacheKey(queryAfterExtraction, async),
            () => RuntimeFeature.IsDynamicCodeSupported
                ? CompileQueryCore<TResult>(_database, queryAfterExtraction, _model, async)
                : throw new InvalidOperationException(CoreStrings.QueryNotPrecompiled));
```

There is no AppContext switch to restore the old behaviour. A compiled model was sufficient on EF Core 8; from EF Core 9 you need precompiled queries as well.

## Lookalike errors

`Query wasn't precompiled and dynamic code isn't supported with NativeAOT.` means the compiled model was found and the query was not. Check that the query lives in the project you ran `optimize --precompile-queries` against, and that the generated `*.EFInterceptors.*.cs` file is being compiled.

`Dynamic LINQ queries are not supported when precompiling queries.` comes from the optimize command, not the app. It means the query is composed across statements (`query = query.Where(...)` inside an `if`). Rewrite it as two complete queries behind a conditional expression, which the documentation shows explicitly.

`Design-time DbContext operations are not supported when publishing with NativeAOT.` is `EnsureCreated`, `Migrate`, `GenerateCreateScript`, or a design-time tool running against a config where the switch is off. Note that this also blocks `dotnet ef` itself: running `dotnet ef dbcontext optimize` in a project that has `DynamicCodeSupport=false` fails with the same NativeAOT family of errors, which is the chicken-and-egg problem that makes the separate class library necessary.

`PlatformNotSupportedException` at startup on a trimmed or AOT app is a different failure with a different cause; see the notes on [PlatformNotSupportedException under Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/).

## Related

- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) covers the trade-off this switch exists to enable.
- [MAUI mobile is CoreCLR only in .NET 11 Preview 6](/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/) explains why the interpreter escape hatch has a shelf life.
- [What is trim-safe code and how do I write it?](/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) is the background for why overriding the switch is risky.
- [Fix: the 'interceptors' feature is not enabled in this namespace](/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/) covers the CS9137 you will hit in step 2.
- [Fix: CREATE DATABASE permission denied in database 'master'](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) is the other case where shipping a SQL script beats calling `Migrate()`.

## Sources

- [NativeAOT support and precompiled queries](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries), EF Core documentation, including the `InterceptorsNamespaces` opt-in, the `Microsoft.EntityFrameworkCore.Tasks` package, and the dynamic-query limitation.
- [Compiled models](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models), EF Core documentation, for `dotnet ef dbcontext optimize` and the compiled-model limitations.
- [`DbContextServices.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/DbContextServices.cs) and [`QueryCompiler.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Query/Internal/QueryCompiler.cs) in `dotnet/efcore`, for both `RuntimeFeature.IsDynamicCodeSupported` checks.
- [`Xamarin.Shared.Sdk.targets`](https://github.com/dotnet/macios/blob/main/dotnet/targets/Xamarin.Shared.Sdk.targets) in `dotnet/macios`, for the `DynamicCodeSupport` default and the interpreter conditions.
- [dotnet/macios PR #18555](https://github.com/dotnet/macios/pull/18555), which introduced the property.
- [dotnet/maui#23653](https://github.com/dotnet/maui/issues/23653) and [dotnet/maui#23595](https://github.com/dotnet/maui/issues/23595), the original reports pinning the regression to the workload update.
