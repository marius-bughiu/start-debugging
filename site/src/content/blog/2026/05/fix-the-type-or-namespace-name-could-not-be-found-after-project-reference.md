---
title: "Fix: The type or namespace name 'X' could not be found (after adding a project reference)"
description: "CS0246 right after a fresh ProjectReference is almost always a TargetFramework mismatch, a stale obj folder, or a missing using directive. Five fixes in order of likelihood."
pubDate: 2026-05-11
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "csproj"
---

The fix: nine times out of ten, your consumer project targets a lower `TargetFramework` than the referenced project (so the SDK pack does not even attempt to resolve the assembly), the `obj/` and `bin/` directories from the previous build still point at the wrong reference assembly, or the type compiled cleanly but is missing a `using` directive at the call site. Open both `.csproj` files, line up their `TargetFramework` values, run `dotnet build --no-incremental` (or delete `obj/` and `bin/` by hand on Windows), and only then start looking at the `using` directives. The exception text and the cause have not changed between .NET 6 and .NET 11 preview 4, so the same checklist applies to every modern SDK-style project.

```text
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?)
error CS0234: The type or namespace name 'Models' does not exist in the namespace 'MyApp.Domain' (are you missing an assembly reference?)
```

The two codes split the same root cause along a small line: `CS0246` means the compiler cannot find a top-level type by its short name; `CS0234` means the compiler found the namespace but could not see the nested member. Both fire as soon as the C# compiler asks Roslyn for a symbol that the metadata reader cannot resolve, which in an SDK-style build happens after MSBuild has finished assembling the reference list. If the reference list is wrong, the compiler is the wrong layer to debug at.

This guide is written against .NET SDK 11.0.100-preview.4, MSBuild 17.13, and Roslyn 4.13. The behavior is identical on .NET 8 LTS and .NET 10. The compiler error codes have been stable since Roslyn shipped, so the fixes apply to every C# version from 7.0 onward.

## Why the compiler cannot see the type after you added a `ProjectReference`

There are five recurring causes, and they should be checked in this order. The first three account for the vast majority of search traffic that lands on the exact message above.

1. **TargetFramework mismatch.** Your consumer is `net8.0` and the referenced project is `net11.0`, or your consumer is `netstandard2.0` and the referenced project is `net8.0`. MSBuild does the right thing here and refuses to wire the reference, but the warning it emits (`NU1201` from NuGet or `NETSDK1005` from the SDK) is easy to scroll past in the build output. The C# error that fires next is CS0246, which is the symptom you noticed.
2. **Stale `obj/` and `bin/`.** Incremental builds in MSBuild are aggressive. After you edit a `.csproj`, the assets file (`obj/project.assets.json`) and the response files (`obj/*.csproj.AssemblyReference.cache`) can disagree with the new graph. Roslyn happily compiles against the old reference set and you get CS0246 for a type that exists on disk.
3. **Missing `using` directive.** You added the reference correctly, the type exists, and the build is clean, but the call site does not import the namespace. With `ImplicitUsings` enabled this is rare for the BCL, but it is the rule for your own namespaces. The compiler hint at the end of CS0246, `(are you missing a using directive or an assembly reference?)`, lists this option first for a reason.
4. **The project is not in the solution.** Visual Studio and `dotnet build <solution>` only build projects that the `.sln` file knows about. You can add a `ProjectReference` to a `.csproj` that is not in the solution, and the consumer will fail to find the type because the producer never built. `dotnet build <consumer.csproj>` succeeds because it walks the project graph directly; the IDE fails because it walks the solution.
5. **`ReferenceOutputAssembly="false"` or `PrivateAssets="all"` on the reference.** Both are legitimate metadata items, used to suppress transitive flow or to pass build-time-only references like analyzers, but each one tells MSBuild not to add the produced assembly to the compiler's reference list. The IDE often shows the project as referenced in Solution Explorer, which makes this one the slowest to spot.

There are smaller-population causes worth naming so you can rule them out by inspection: a case-sensitive filesystem (Linux, macOS) where the using directive does not match the namespace casing exactly; a `Conditional` ItemGroup that excludes the reference for the current `Configuration` or `TargetFramework`; a multi-target consumer (`<TargetFrameworks>net8.0;net11.0</TargetFrameworks>`) where only one of the inner builds picks up the reference; and a global.json that pins an SDK version older than the consumer's `TargetFramework` minimum.

## The error in context

This is what the build output looks like when the TargetFramework cause fires. Pay attention to lines before the CS0246, not the CS0246 itself:

```text
warning NU1201: Project Domain is not compatible with net8.0 (.NETCoreApp,Version=v8.0). Project Domain supports: net11.0 (.NETCoreApp,Version=v11.0)
warning MSB3277: Found conflicts between different versions of "System.Runtime" that could not be resolved.
error CS0246: The type or namespace name 'OrderService' could not be found (are you missing a using directive or an assembly reference?) [C:\src\Api\Api.csproj]
```

`NU1201` is the smoking gun. The NuGet restore step found the project but rejected it because its target framework set does not contain anything the consumer can consume. The compiler then ran with an empty reference for that project. The CS0246 is a downstream effect, not the bug.

## Minimal repro

The smallest two-project setup that reproduces the TargetFramework mismatch. Save these as `Domain/Domain.csproj` and `Api/Api.csproj`:

```xml
<!-- Domain/Domain.csproj - .NET 11 preview 4 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```xml
<!-- Api/Api.csproj - .NET 8 LTS consumer of a net11.0 library -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Domain\Domain.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Domain/OrderService.cs - .NET 11 preview 4
namespace MyApp.Domain;

public sealed class OrderService
{
    public string Greet(int id) => $"order-{id}";
}
```

```csharp
// Api/Program.cs - .NET 8 LTS
using MyApp.Domain;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<OrderService>();

var app = builder.Build();
app.MapGet("/", (OrderService svc) => svc.Greet(1));
app.Run();
```

Run `dotnet build Api/Api.csproj` and you get the exact error pair from the previous section. The CS0246 is dramatic; the `NU1201` warning above it is the real fault.

## Fix one: line up the TargetFramework values

The safest move is to upgrade the consumer rather than to downgrade the library, because downgrading typically loses APIs:

```xml
<!-- Api/Api.csproj - now .NET 11 to match the library -->
<TargetFramework>net11.0</TargetFramework>
```

If you cannot move the consumer, multi-target the library so it ships an assembly for both:

```xml
<!-- Domain/Domain.csproj -->
<TargetFrameworks>net8.0;net11.0</TargetFrameworks>
```

For libraries that are genuinely framework-neutral, `netstandard2.0` is still the broadest target and is consumable from .NET Framework 4.7.2+, Mono, Unity, and every modern .NET. Pick `netstandard2.0` only when the API surface fits inside it; otherwise multi-targeting `net8.0` + `net11.0` is the cleaner option in 2026.

A note on `<TargetFrameworks>` with a single value: write `<TargetFramework>` (singular). MSBuild treats them as different properties, and a project with `<TargetFrameworks>net8.0</TargetFrameworks>` builds into `bin/<config>/net8.0/` rather than `bin/<config>/`, which silently breaks downstream tools that assume the flat layout.

## Fix two: blow away `obj/` and `bin/` after editing the `.csproj`

If the frameworks line up but the error persists, the build cache is stale. Roslyn reads `obj/<project>.csproj.AssemblyReference.cache` and the per-project `*.GeneratedMSBuildEditorConfig.editorconfig` to short-circuit reference resolution. If you edited the `.csproj` to add the `ProjectReference` while a previous build is still resident, the cache disagrees with the new graph and the compiler runs against the old reference list.

The right reset on .NET 11 is `dotnet build --no-incremental` for a one-shot clean rebuild, or, for the rare case where that is not enough, manually remove the build folders:

```powershell
# .NET SDK 11.0.100-preview.4, PowerShell on Windows
Get-ChildItem -Path . -Include obj,bin -Recurse -Directory | Remove-Item -Recurse -Force
dotnet build
```

```bash
# .NET SDK 11.0.100-preview.4, bash on Linux/macOS
find . -type d \( -name obj -o -name bin \) -prune -exec rm -rf {} +
dotnet build
```

`dotnet clean` is intentionally conservative: it removes outputs but keeps the assets file, which means it does not always cure this class of bug. Treat it as a partial reset, not a full one. If you are running an IDE alongside, close it before deleting `obj/` because the language service holds open file handles on Windows and the delete will fail half the directories.

## Fix three: add or fix the `using` directive

Once the reference is healthy, the compiler can find the type but you still need to import its namespace at the call site. The fix is mechanical:

```csharp
// Api/Program.cs - .NET 11 preview 4
using MyApp.Domain;        // the namespace declared inside Domain/OrderService.cs
// using MyApp.Domain.Models; // for the CS0234 variant where you also need the nested namespace
```

Two subtleties bite teams every release. First, `<ImplicitUsings>enable</ImplicitUsings>` adds a fixed set of namespaces (`System`, `System.Collections.Generic`, `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks`, and the SDK-specific extras) but it does not import your own namespaces. Second, since C# 10 you can declare global usings to fill that gap:

```xml
<!-- Api/Api.csproj - .NET 11 preview 4 -->
<ItemGroup>
  <Using Include="MyApp.Domain" />
</ItemGroup>
```

This emits a `GlobalUsings.g.cs` file into `obj/` and saves the per-file `using` line everywhere `OrderService` is consumed. The trade-off is that global usings make refactoring noisier: a typo in a global namespace fails the whole project, and a removed library now hides as a single MSBuild edit instead of a wave of red squigglies. Use them deliberately, not reflexively.

## Fix four: confirm the project is in the solution

`dotnet sln list` is the fastest way to verify. If your consumer is `Api/Api.csproj` and your library is `Domain/Domain.csproj`, both must appear in the `.sln`:

```bash
# .NET SDK 11.0.100-preview.4
dotnet sln list
# Project(s)
# ----------
# Api\Api.csproj
# Domain\Domain.csproj   <-- must be here
```

If `Domain` is missing, the IDE will appear to know about it (because the `ProjectReference` resolves it on disk), but solution-scoped builds skip it and a single-project rebuild then fails because the consumer's `obj/project.assets.json` references an assembly that nothing produced. Add the missing project:

```bash
dotnet sln add Domain/Domain.csproj
```

This pitfall is more common in 2026 than it was when `slnx` and the new lightweight solution format landed in the .NET 11 SDK. The CLI tolerates building a solution that lists projects with disjoint reference graphs, and the language servers in Visual Studio 2026 and Rider 2026.1 have both gotten better at warning when a referenced project is outside the active solution. If you are on an older SDK, the warning is silent. For solution-file ergonomics in general, the new CLI is worth a look: see [the dotnet sln cli improvements in .NET 11](/2026/04/dotnet-11-sln-cli-solution-filters/).

## Fix five: check `ReferenceOutputAssembly` and `PrivateAssets`

Some references are deliberately not propagated to the compiler. The two metadata items to check on the `ProjectReference` are:

```xml
<!-- Will NOT add Domain.dll to the compiler's reference list -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  ReferenceOutputAssembly="false" />

<!-- Will not flow transitively to projects that consume the consumer -->
<ProjectReference Include="..\Domain\Domain.csproj"
                  PrivateAssets="all" />
```

`ReferenceOutputAssembly="false"` is correct when the referenced project is a build-time tool (a code generator, an analyzer host) whose output you want sequenced into the build graph but whose assembly you do not consume. If it is set on your real library reference, the consumer fails CS0246 even though the build graph is otherwise healthy.

`PrivateAssets="all"` is the symmetric case for transitive references. If `Api` references `Bff`, and `Bff` references `Domain` with `PrivateAssets="all"`, then `Api` cannot see types from `Domain` even though `Bff` can. The hint is in the project that does the consuming, not in the one that does the producing.

## Variants that look like the same error

A handful of nearby errors get conflated with CS0246 in search results:

- **`CS1069`: The type name 'X' could not be found in the namespace 'Y'. This type has been forwarded to assembly 'Z'.** A type-forwarder is missing. Add the assembly named in the message. This is most common with `System.Configuration.ConfigurationManager` and `System.Drawing.Common` on modern .NET.
- **`CS8073` / `CS0518`: Predefined type 'System.Object' is not defined or imported.** The implicit `System.Runtime` reference is broken. Almost always a corrupt `obj/` or a hand-written `<Reference>` that excludes the framework. `dotnet build --no-incremental` is the first thing to try.
- **`CS0433`: The type 'X' exists in both 'A' and 'B'.** Two assemblies expose the same type. Solve with an alias on the `ProjectReference` (`<ProjectReference Include="..." Aliases="domain" />`) and an `extern alias` directive at the call site.
- **`NETSDK1005`: Assets file '...' doesn't have a target for 'net8.0'.** The reference is on a NuGet package compiled for a higher framework than the consumer. Same root cause as Fix one above, different message because the producer is a package, not a project.
- **`MSB4181`: The "ResolvePackageAssets" task returned false but did not log an error.** A genuine restore failure; the package graph is unresolvable. Delete the global `~/.nuget/packages/<name>/<version>/` cache for the offending package and restore again. Treat this as orthogonal to CS0246 even though the two often co-occur.

## How to read the build output to confirm the fix

Bias your debugging toward the build log rather than the C# error list. The compiler is the wrong place to start when reference resolution is broken. Three commands earn their keep:

```bash
# .NET SDK 11.0.100-preview.4
dotnet build -v:n Api/Api.csproj
```

`-v:n` (`-verbosity normal`) prints the resolved reference list under `CoreCompile -> ResolveReferences`. If your library is not in that list, the compiler never saw it and you have a MSBuild problem, not a Roslyn problem.

```bash
dotnet build -bl Api/Api.csproj
```

`-bl` writes a `msbuild.binlog` next to the project. Open it in the [MSBuild Structured Log Viewer](https://msbuildlog.com/) and search for `ResolveAssemblyReferences`. The viewer shows exactly which file paths MSBuild handed to Roslyn, and why each one was included or skipped.

```bash
dotnet msbuild Api/Api.csproj -t:ResolveReferences -p:DesignTimeBuild=false
```

This runs the reference resolution target in isolation, without invoking the compiler. The output is concise and tells you whether the failure is in restore, in resolution, or in compilation. CS0246 disappears from the noise.

## Edge cases that catch experienced developers

A few patterns reproduce CS0246 in code that looks correct on inspection:

- **`Directory.Packages.props` with `ManagePackageVersionsCentrally=true`**. If you forgot to add a `<PackageVersion>` entry for a transitive package that your library exposes via its API, the consumer cannot resolve the type from the transitive dependency. The error message is CS0246, not the missing-version error you would expect.
- **Multi-targeting with `Condition`**. `<ProjectReference Include="..." Condition="'$(TargetFramework)' == 'net11.0'" />` will skip the reference for the `net8.0` inner build of a multi-target consumer. The IDE shows the reference; the `net8.0` build does not see the type.
- **`global.json` pinning an SDK that lacks your `TargetFramework`**. If `global.json` selects SDK 8.0.x and the project targets `net11.0`, restore reports a benign warning, build fails CS0246 for every type in the referenced library because the SDK packs are not installed for `net11.0`.
- **Linux case sensitivity**. `using MyApp.domain;` instead of `using MyApp.Domain;` compiles on Windows and fails CS0246 in CI on Linux. Add `<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` and lock the casing with an `.editorconfig` rule.
- **Native AOT consumers**. If `<PublishAot>true</PublishAot>` is set on the consumer but not on the library, the AOT analyzer flags the transitive trim warnings as errors and the build can stop at a downstream CS0246 once a type is trimmed away. The fix is to mark the library trim-safe, not to silence the analyzer. The same trim discipline that the [PlatformNotSupportedException in Native AOT post](/2026/05/fix-platformnotsupportedexception-in-native-aot/) covers applies here.

## Related

- The next reference-resolution exception teams run into after this one is the runtime variant covered in [Unable to resolve service for type 'X' while attempting to activate 'Y'](/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Solution-file ergonomics that make this class of bug easier to spot: [the dotnet sln CLI changes in .NET 11](/2026/04/dotnet-11-sln-cli-solution-filters/).
- The Native AOT corner cases that surface CS0246 indirectly through trimming: [PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/).
- A build-warning policy that prevents quiet `NU1201` warnings from hiding under green CI: [TreatWarningsAsErrors without sabotaging dev builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).
- When the missing type is a configuration value and the message is similar in spirit: [no connection string named 'DefaultConnection' could be found](/2026/05/fix-no-connection-string-named-defaultconnection/).

## Sources

- Microsoft Learn, [Compiler Error CS0246](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0246).
- Microsoft Learn, [Compiler Error CS0234](https://learn.microsoft.com/en-us/dotnet/csharp/misc/cs0234).
- Microsoft Learn, [MSBuild ProjectReference protocol](https://learn.microsoft.com/en-us/visualstudio/msbuild/common-msbuild-project-items#projectreference).
- Microsoft Learn, [Implicit using directives in .NET 6+](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview#implicit-using-directives).
- Microsoft Learn, [global.json overview](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json).
- MSBuild source, [`Microsoft.Common.CurrentVersion.targets`](https://github.com/dotnet/msbuild/blob/main/src/Tasks/Microsoft.Common.CurrentVersion.targets), where `ResolveProjectReferences` lives.
