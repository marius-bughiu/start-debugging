---
title: "Fix: PublishAot plus EFOptimizeContext exhausts memory during an EF Core build"
description: "EF Core's build-time model generation re-entered MSBuild until RAM ran out. Upgrade Tasks and Design to 10.0.10+, and on EF Core 11 delete EFOptimizeContext."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "native-aot"
  - "msbuild"
  - "dotnet-10"
---

Upgrade both `Microsoft.EntityFrameworkCore.Tasks` and `Microsoft.EntityFrameworkCore.Design` to 10.0.10 or later (10.0.12 is current as of 2026-09-10), then kill the leftover build processes and restart Visual Studio. Through 10.0.9, EF Core's build-time compiled model and query precompilation re-triggered itself from inside its own nested builds, spawning MSBuild processes until the machine ran out of memory. On EF Core 11 the fix is already in, and `EFOptimizeContext` itself is gone: delete it, or the build fails.

## The error in context

There is no exception to search for, which is what makes this one miserable. The report against EF Core 10.0.5, [dotnet/efcore#38087](https://github.com/dotnet/efcore/issues/38087), describes the whole symptom: RAM climbs until the machine stops responding, the build output never gets past its first line, and merely opening the solution in Visual Studio is enough to trigger it, because IntelliSense starts design-time builds as soon as the project loads. The verbose build log in that report contains exactly this and nothing more:

```
Build started at 5:55 PM...
```

Task Manager or `top` meanwhile shows a growing pile of `dotnet` and `MSBuild` processes. The project settings that trigger it are always the same four lines:

```xml
<!-- EF Core 10.0.5 through 10.0.9: do not build this without the fix -->
<PublishAot>true</PublishAot>
<EFOptimizeContext>true</EFOptimizeContext>
<EFScaffoldModelStage>build</EFScaffoldModelStage>
<EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
```

If you landed here after upgrading to EF Core 11, you see something different: a hard build error raised by the `_EFValidateProperties` target in `Microsoft.EntityFrameworkCore.Tasks` 11.0.0-rc.1.26425.128, with this message:

```
$(EFOptimizeContext) is no longer supported. Use $(EFScaffoldModelStage) and $(EFPrecompileQueriesStage) instead.
```

## Why this happens

Two facts that look unrelated combine here.

First, `PublishAot` is not only a publish setting. With `<PublishAot>true</PublishAot>` in the project file, even a plain `dotnet build` writes the AOT feature switches into `bin/Debug/net10.0/YourApp.runtimeconfig.json`, including this one:

```json
"System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false
```

EF Core honours that switch and refuses to build its model at runtime, so an F5 debug session dies on the first query:

```
Unhandled exception. System.InvalidOperationException: Model building is not supported when publishing with NativeAOT. Use a compiled model.
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.CreateModel(Boolean designTime)
   at Microsoft.EntityFrameworkCore.Internal.DbContextServices.get_Model()
```

The natural reaction is to have the compiled model and the precompiled queries generated on every build. That is exactly what `EFScaffoldModelStage=build` and `EFPrecompileQueriesStage=build` do, and on EF Core 9 and 10 they only take effect together with `EFOptimizeContext=true`. Hence the four lines.

Second, there is the way `Microsoft.EntityFrameworkCore.Tasks` wires generation into the build. Its `_EFGenerateFilesAfterBuild` target is appended to `$(TargetsTriggeredByCompilation)`, so it runs after every `CoreCompile`. It launches a nested MSBuild of the same project with `_EFGenerationStage=build`, which builds the project again with AOT switched off and then runs the `OptimizeDbContext` task. For precompiled queries, EF's design-time code then opens the project through Roslyn's `MSBuildWorkspace`, and loading a project that way runs yet another design-time build of it.

The only thing preventing that chain from recursing was a `'$(_EFGenerationStage)'==''` condition on the generation targets. It had two holes:

1. **Visual Studio design-time builds.** `CoreCompile` also runs during the lightweight design-time builds that VS fires continuously while a project is open. Each one started a full out-of-process generation, and they piled up faster than they finished. [dotnet/efcore#38386](https://github.com/dotnet/efcore/pull/38386) fixed it by adding `'$(DesignTimeBuild)' != 'True'` to the generation targets. That change lives in the `.targets` file of the **Tasks** package.
2. **Command-line builds.** The `MSBuildWorkspace` opened for query precompilation did not carry `_EFGenerationStage`, so its build satisfied the condition and triggered generation again, which opened another workspace, and so on. [dotnet/efcore#38403](https://github.com/dotnet/efcore/pull/38403) fixed it by creating the workspace with `_EFGenerationStage=build` as a global property. That change lives in `DbContextOperations` inside the **Design** package.

Both were merged into `release/10.0` in June 2026 and first shipped in 10.0.10 on 2026-07-14. I verified that against the packages themselves rather than trusting the milestone: the 10.0.9 `Microsoft.EntityFrameworkCore.Tasks.targets` contains no `DesignTimeBuild` check while 10.0.10 contains three, and the `_EFGenerationStage` string first appears in `Microsoft.EntityFrameworkCore.Design.dll` in 10.0.10.

## Minimal repro

This is the project from the original report, trimmed to one entity and one context over SQLite. Every version up to and including 10.0.9 reproduces it. Do not build it on a machine where you are not ready to kill the process tree.

```xml
<!-- .NET 10 SDK, EF Core 10.0.9 (broken). Reproduces the memory exhaustion. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <EFOptimizeContext>true</EFOptimizeContext>
    <EFScaffoldModelStage>build</EFScaffoldModelStage>
    <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
    <InterceptorsNamespaces>$(InterceptorsNamespaces);Microsoft.EntityFrameworkCore.GeneratedInterceptors</InterceptorsNamespaces>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.9" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.x
using Microsoft.EntityFrameworkCore;

await using var db = new AppDbContext();
await db.Database.OpenConnectionAsync();
await db.Database.ExecuteSqlRawAsync(
    "CREATE TABLE IF NOT EXISTS Entities (Id INTEGER PRIMARY KEY)");
var count = await db.Entities.Where(e => e.Id > 0).CountAsync();
Console.WriteLine($"Entities: {count}");

public class Entity { public int Id { get; set; } }

public class AppDbContext : DbContext
{
    public DbSet<Entity> Entities => Set<Entity>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=db.sqlite");
}
```

The table is created with raw SQL on purpose instead of `EnsureCreatedAsync()`. The gotchas section below explains why.

## Fix, in detail

### 1. Upgrade Tasks and Design together to 10.0.10 or later

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 (fixed) -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.12" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tasks" Version="10.0.12" PrivateAssets="all" />
</ItemGroup>
```

Pin Design explicitly. The design-time guard is in Tasks, the command-line guard is in Design, and Design otherwise reaches your graph transitively at whatever version NuGet resolves. That is not always the version you think: Tools 10.0.6 through 10.0.8 let Design resolve as low as 8.0.0, a mess covered in [the MissingMethodException ArgumentIsEmpty fix](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/). Bumping only Tasks fixes Visual Studio and leaves `dotnet build` broken. Run `dotnet nuget why . Microsoft.EntityFrameworkCore.Design` to see what you actually got.

Then clean up what the broken version left behind. Close Visual Studio, end any orphaned `dotnet` or `MSBuild` processes, shut down the build servers, and delete `obj` so half-written generated files and their `*.EFGeneratedSources.Build.txt` lists do not get fed back into the next compile:

```bash
dotnet build-server shutdown
```

With the repro above moved to 10.0.12, on SDK 10.0.302, `dotnet build` finishes in 5.4 seconds with 0 errors, the app prints `Entities: 0`, and `obj/Debug/net10.0/EfBombRepro.EFGeneratedSources.Build.txt` lists six generated files:

```
AppDbContextAssemblyAttributes.g.cs
EntityUnsafeAccessors.g.cs
AppDbContextModel.g.cs
AppDbContextModelBuilder.g.cs
EntityEntityType.g.cs
Program.EFInterceptors.AppDbContext.g.cs
```

The interceptor file contains the finished SQL for the `CountAsync` call, `SELECT COUNT(*) FROM "Entities" AS "e" WHERE "e"."Id" > 0`, as a string literal. That is the whole point of query precompilation: no LINQ translation happens at runtime.

### 2. On EF Core 11, delete EFOptimizeContext

EF Core 11 removed the property ([dotnet/efcore#35079](https://github.com/dotnet/efcore/issues/35079)) because the stage properties already said everything it did. They now enable generation on their own:

```xml
<!-- .NET 11, EF Core 11.0.0-rc.1.26425.128 -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
  <EFScaffoldModelStage>build</EFScaffoldModelStage>
  <EFPrecompileQueriesStage>build</EFPrecompileQueriesStage>
</PropertyGroup>
```

The rc.1 targets file carries the `DesignTimeBuild` guard, and the rc.1 Design assembly carries the `_EFGenerationStage` workspace fix, so this configuration is safe. If you only need generation at publish time, delete the two stage lines as well: both default to `publish`, and with `PublishAot=true` EF Core 11 generates the compiled model and precompiled queries during `dotnet publish` without any extra property. One combination is rejected outright, `EFScaffoldModelStage=publish` with `EFPrecompileQueriesStage=build`, which fails with "If $(EFScaffoldModelStage) is set to 'publish' then $(EFPrecompileQueriesStage) must also be set to 'publish'."

Mind the order. On 10.x, `EFOptimizeContext` is still the gate for build-stage generation. I removed it from the fixed 10.0.12 repro and left both stages at `build`: the build succeeded, generated nothing, and the app threw the "Model building is not supported" exception on the first query. Remove the property as part of the EF Core 11 upgrade, not before it. Also note that in EF Core 11 the Tasks package no longer depends on Design at all, which is one more reason to keep the explicit Design reference from step 1.

Because the only SDK on my machine is 10.0.302 and the EF Core 11 packages target `net11.0` only, the EF Core 11 statements above come from reading the shipped rc.1 targets file and assembly, not from running a build.

### 3. Keep PublishAot out of the inner loop

The EF maintainer's advice in the issue thread is direct: "I'd recommend not setting `<PublishAot>true</PublishAot>` for the inner dev loop". The reporter's objection is the real one: remove `PublishAot` and the trimming and AOT warnings disappear from the IDE. They don't have to, because the analyzers have their own switches:

```xml
<!-- .NET 10 SDK 10.0.302, EF Core 10.0.12 -->
<PropertyGroup>
  <EnableAotAnalyzer>true</EnableAotAnalyzer>
  <EnableTrimAnalyzer>true</EnableTrimAnalyzer>
</PropertyGroup>
```

With `PublishAot` replaced by those two lines, the repro still reports the same `IL2026` and `IL3050` warnings on `new AppDbContext()`. The runtimeconfig no longer contains the `IsDynamicCodeSupported` switch, EF Core builds its model at runtime as usual, and nothing is generated during the build. AOT becomes a publish decision:

```bash
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
```

The EF docs also recommend setting `<RuntimeIdentifier>` in the startup project when generation runs at the publish stage.

The inner-loop cost is not hypothetical. On the one-entity repro, an incremental build after editing `Program.cs` took 4.7 seconds with build-stage generation and 1.2 seconds without it. A no-op build took 0.6 seconds either way, because generation is skipped whenever `CoreCompile` is. The docs warn that the generated model and interceptors "may currently be quite large" and slow to produce, so that gap grows with your model.

## Gotchas and lookalike errors

**"Design-time DbContext operations are not supported when publishing with NativeAOT."** Under `PublishAot=true`, `EnsureCreatedAsync()`, `Migrate()` and anything else that needs the design-time model throw this, even on F5 and even with a compiled model in place. That is why the repro creates its table with raw SQL. Apply schema changes from your deployment pipeline with a migrations bundle or a SQL script instead.

**`warning CS9270: 'InterceptsLocationAttribute(string, int, int)' is not supported`.** The interceptors generated by 10.0.12 still use the file-path form of the attribute, so the compiler warns about the generated file. It is a warning in generated code, not something you fix in yours. The same detail explains why those files contain machine-specific absolute paths and belong in `obj`, never in source control.

**CS9137, "The 'interceptors' feature is not enabled in this namespace".** Either the `InterceptorsNamespaces` line is missing, or, per the EF docs, outdated transitive `Microsoft.CodeAnalysis.CSharp.Workspaces` and `Microsoft.CodeAnalysis.Workspaces.MSBuild` references are in the graph. The same error code from a different generator is covered in [the CS9137 interceptors fix](/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/).

**Generation silently skipped in a multi-project solution.** Every project that contains a `DbContext` or an EF query needs its own `Microsoft.EntityFrameworkCore.Tasks` reference, since it is not transitive. The integration also cannot use a separate startup project, so a context configured from a host in another project needs an `IDesignTimeDbContextFactory<TContext>`.

**The same model-building exception on iOS without PublishAot.** iOS builds set `DynamicCodeSupport=false` on their own, so .NET MAUI apps hit this path without ever opting into AOT. See [the MAUI iOS NativeAOT model-building fix](/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/).

## Related

- [How to warm up EF Core's model before the first query](/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/), including shipping a compiled model with `dotnet ef dbcontext optimize` when you do not need AOT at all.
- [Fix: Model building is not supported when publishing with NativeAOT in a .NET MAUI iOS build](/2026/08/fix-model-building-is-not-supported-when-publishing-with-nativeaot-in-maui-ios/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11: which should you ship?](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), worth reading before you commit an EF Core app to AOT.
- [Fix: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' after upgrading EF Core Tools](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/)
- [Fix: The 'interceptors' feature is not enabled in this namespace](/2026/08/fix-the-interceptors-feature-is-not-enabled-in-this-namespace-microsoft-aspnetcore-openapi/)

## Sources

- [dotnet/efcore#38087, `PublishAot` + `EFOptimizeContext` fork bombs the system](https://github.com/dotnet/efcore/issues/38087)
- [dotnet/efcore#38386, guard EF file generation against design-time builds](https://github.com/dotnet/efcore/pull/38386)
- [dotnet/efcore#38403, guard EF file generation during command-line builds](https://github.com/dotnet/efcore/pull/38403)
- [dotnet/efcore#35079, remove the EFOptimizeContext property from the EF targets](https://github.com/dotnet/efcore/issues/35079)
- [EF Core MSBuild tasks](https://learn.microsoft.com/en-us/ef/core/cli/msbuild)
- [Breaking changes in EF Core 11: EFOptimizeContext MSBuild property has been removed](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [NativeAOT support and precompiled queries in EF Core](https://learn.microsoft.com/en-us/ef/core/performance/nativeaot-and-precompiled-queries)
- [Microsoft.EntityFrameworkCore.Tasks on NuGet](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tasks)
