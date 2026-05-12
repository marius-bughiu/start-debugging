---
title: "Fix: System.IO.FileNotFoundException: Could not load file or assembly in a published app"
description: "Runs fine with dotnet run, throws after dotnet publish. The DLL is usually missing from the publish folder, not the runtime. Check deps.json, ProjectReference Private, and trimming."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "msbuild"
  - "publish"
  - "trimming"
---

The fix: a `FileNotFoundException: Could not load file or assembly` after `dotnet publish` almost always means the DLL is not in the publish folder, not that the runtime cannot find it. List the publish output, locate the missing assembly by name, and treat it as a packaging bug. The four causes that cover ninety percent of real reports are a `ProjectReference` marked `Private=false`, a `PackageReference` with `PrivateAssets="all"`, trimming dropping a reflection-loaded assembly, and a self-contained vs framework-dependent publish picking the wrong RID. Set `COREHOST_TRACE=1`, run the published binary once, and the host log tells you which probing path it tried.

```text
Unhandled exception. System.IO.FileNotFoundException: Could not load file or assembly 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'. The system cannot find the file specified.
File name: 'Contoso.Shared, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
   at MyApp.Program.Main(String[] args)

--- End of stack trace from previous location ---
   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()
   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)
```

This guide is written against .NET 11 preview 4 (runtime `Microsoft.NETCore.App` 11.0.0-preview.4) and the .NET SDK 11.0.100-preview.4 on Windows, Linux, and macOS. The exception type, the four-part assembly identity in the message, and the host probing rules are unchanged since .NET Core 3.0; what changed in .NET 8 and .NET 11 was the trimmer's analyser, which now emits `IL2026` / `IL3050` warnings up front so you stop discovering this at runtime. If the message says `Could not load file or assembly` followed by `or one of its dependencies`, the dependency is the file that is missing, not the one named first. Read the second clause before you touch anything.

## Why the runtime cannot find the assembly

The .NET host (`dotnet.exe` or the apphost stub built next to your `.exe` on `dotnet publish`) loads assemblies from a fixed set of probing paths derived from your `<app>.deps.json`. It does not search `PATH`, it does not search the GAC, and it does not fall back to the bin folder of the project that built it. The paths it probes are, in order:

1. The directory of the apphost (`AppContext.BaseDirectory`).
2. The shared framework directory for framework-dependent apps (`{DOTNET_ROOT}/shared/Microsoft.NETCore.App/{version}`).
3. The NuGet fallback folders if `useNuGet` resolution is on (development only).
4. Anything declared in `additionalProbingPaths` inside `<app>.runtimeconfig.dev.json`, which is **not** present in a published app.

When the dev machine has the assembly in the NuGet cache and the runtimeconfig points at it, `dotnet run` finds it. The published app has neither the cache nor the dev runtimeconfig, so the same call throws. The exception is the host telling you that the assembly identity in `<app>.deps.json` resolved to no file on disk.

The official Microsoft Learn page [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) is the authoritative reference for the probing order; the [host tracing instructions](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) describe how to dump the probing log to a file.

## A minimal repro

```xml
<!-- .NET 11, SDK 11.0.100-preview.4 -->
<!-- src/MyApp/MyApp.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <RootNamespace>MyApp</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
      <Private>false</Private>
    </ProjectReference>
  </ItemGroup>
</Project>
```

```csharp
// .NET 11, C# 14
using Contoso.Shared;

var greeter = new Greeter();
Console.WriteLine(greeter.Hello("world"));
```

`dotnet run` succeeds. `dotnet publish -c Release -r win-x64 -o ./out` finishes without errors. `./out/MyApp.exe` throws `Could not load file or assembly 'Contoso.Shared'`. The `<Private>false</Private>` flag tells MSBuild not to copy `Contoso.Shared.dll` into the consumer's output, on the assumption that the GAC or some other deployment vehicle will provide it. For .NET (Core) apps there is no GAC, so the file is simply absent.

This is the canonical shape of the bug: a single property somewhere in the project graph tells MSBuild not to include the DLL, and the publish step honours it. The fix is to find the property and remove it.

## Fix 1: stop suppressing the copy

Open the project file of the missing assembly's parent and look for any of these properties on the reference:

```xml
<!-- These three lines all suppress the copy. Remove them. -->
<ProjectReference Include="..\Contoso.Shared\Contoso.Shared.csproj">
  <Private>false</Private>
</ProjectReference>

<Reference Include="Contoso.Shared">
  <CopyLocal>false</CopyLocal>
</Reference>

<PackageReference Include="Some.Library" Version="1.0.0">
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

`Private=false` and `CopyLocal=false` are equivalent for project and assembly references. `PrivateAssets="all"` on a `PackageReference` means the asset is consumed at build time but does not flow to the consuming project, so the DLL is omitted from `deps.json`. The legitimate use of `PrivateAssets="all"` is for analyzer, source generator, and build-task packages (where the runtime never needs the DLL). If the package is `Microsoft.Extensions.Logging.Abstractions` or anything you call at runtime, the flag is wrong. Remove it, run `dotnet publish`, and confirm the DLL now sits next to your app.

The MS Learn page [Controlling dependency assets](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) lists every value that `PrivateAssets` accepts and what each one disables.

## Fix 2: turn on host tracing and read the probe log

If you do not know which DLL is missing, ask the host. Set `COREHOST_TRACE=1` and `COREHOST_TRACEFILE=corehost.log` before launching the published binary:

```powershell
# Windows, PowerShell, .NET 11
$env:COREHOST_TRACE = "1"
$env:COREHOST_TRACE_VERBOSITY = "4"
$env:COREHOST_TRACEFILE = "corehost.log"
./out/MyApp.exe
```

```bash
# Linux / macOS, bash, .NET 11
COREHOST_TRACE=1 COREHOST_TRACE_VERBOSITY=4 COREHOST_TRACEFILE=corehost.log ./out/MyApp
```

The log is long but the section to grep for is `Attempting to load`. Each probe is recorded with the full path the host tried. The last failing probe before the exception is the answer:

```text
Attempting to load: C:\out\Contoso.Shared.dll - false
Attempting to load: C:\out\runtimes\win-x64\lib\net11.0\Contoso.Shared.dll - false
File [C:\out\Contoso.Shared.dll] does not exist
```

Now you know the host expected `Contoso.Shared.dll` directly under the app folder and did not find it. The fix is to make the publish output include the file at that path, not to add probing paths or load contexts.

## Fix 3: when trimming silently drops the assembly

Trimming a self-contained .NET 11 app removes any assembly that the trimmer cannot prove is reachable through static analysis. `Assembly.Load("Plugins.Foo")`, `Type.GetType("Some.Type, Some.Assembly")`, and most reflection-based DI containers are invisible to the trimmer. The assembly is excluded from publish output and shows up at runtime as `FileNotFoundException`.

To confirm trimming is the cause, publish once with the trimmer's warnings made fatal:

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <PublishTrimmed>true</PublishTrimmed>
  <TrimmerSingleWarn>false</TrimmerSingleWarn>
  <SuppressTrimAnalysisWarnings>false</SuppressTrimAnalysisWarnings>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

If the publish now fails with `IL2026` or `IL3050` pointing at your reflection call site, trimming is the cause. The fix is to root the assembly so the trimmer keeps it:

```xml
<!-- .NET 11 -->
<ItemGroup>
  <TrimmerRootAssembly Include="Plugins.Foo" />
</ItemGroup>
```

For an individual type, mark the method that triggers the load with `DynamicDependencyAttribute`:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;

public static class PluginLoader
{
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicConstructors, "Plugins.Foo.Entry", "Plugins.Foo")]
    public static object Load() => Activator.CreateInstance(Type.GetType("Plugins.Foo.Entry, Plugins.Foo")!)!;
}
```

The full list of trimmer roots and dependency attributes is in [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming). For a deeper look at the runtime side, the post on [Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) walks through the same trimmer warnings in a more aggressive form.

## Fix 4: wrong RID, or framework-dependent published as self-contained

If the assembly listed in the error is `Microsoft.NETCore.App` or one of its components (`System.Private.CoreLib.dll`, `System.Runtime.dll`), the problem is not your code, it is that the published app is framework-dependent but the target machine has no matching shared framework installed:

```text
Could not load file or assembly 'System.Runtime, Version=11.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
```

This message means the host found `MyApp.dll` and read `MyApp.runtimeconfig.json`, then asked for `Microsoft.NETCore.App 11.0.0` and got nothing. Either install the shared framework on the target machine (`dotnet --list-runtimes`) or republish as self-contained:

```bash
# .NET 11
dotnet publish -c Release -r win-x64 --self-contained true -o ./out
```

The runtime ships every framework DLL into `./out`, the app no longer depends on the machine's installed runtime, and the FileNotFoundException disappears. The corresponding [reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) post discusses the publish tradeoffs (size vs portability vs cold start) in more depth.

The other RID-shaped failure is a NuGet package with native binaries that ships only some RIDs. If you publish for `osx-arm64` but a package only carries `win-x64` and `linux-x64` natives, the package's `runtimes/win-x64/native/foo.dll` is excluded from your publish and the managed wrapper throws `FileNotFoundException`. The fix is to file the gap with the package owner or pin to a version that ships the RID you need. The package's `runtimes/` folder is the source of truth.

## Gotchas and lookalikes

**`Could not load file or assembly 'X' or one of its dependencies`.** The named assembly is on disk. A dependency of it is not. Run `dotnet-dump analyze` or `dnSpy` against `X.dll` to read its referenced-assemblies list, or use the host trace from Fix 2 to find the second-level failure. Treating the first name as the missing file sends you in circles.

**`FileLoadException`, not `FileNotFoundException`.** A `FileLoadException: Could not load file or assembly 'X, Version=2.0.0.0'` means the file is present but the version, culture, or public key token does not match what was requested. This is an assembly binding redirect problem (common when a transitive dependency was upgraded only at the top level). The fix is to add a matching version to your top-level `PackageReference` so the resolved graph collapses to one version. The runtime no longer reads `app.config` binding redirects in .NET (Core); only the .NET Framework runtime did. If you ported from `app.config`, the redirects are now ignored and the resolved version from `deps.json` is what gets loaded.

**`TypeLoadException` and `MissingMethodException`.** These are not assembly-not-found errors. They mean the assembly loaded but the type or method inside it has a different signature than the caller expected, almost always a version mismatch. The fix shape is the same as `FileLoadException`: align the version graph.

**`BadImageFormatException`.** The file is on disk and is the right name, but it is the wrong architecture (an `x86` DLL loaded into an `x64` process, or a managed DLL loaded as a native one). Check the RID and the `Platform` of both sides. This is a sibling category, not a `FileNotFoundException` in disguise.

**Single-file publish.** With `PublishSingleFile=true`, the apphost extracts bundled assemblies to a temp folder on first launch (`%TEMP%/.net/<appname>/<hash>`). If you see `FileNotFoundException` for an assembly that you can see inside the single-file bundle (`dotnet-bundle list`), the most common cause is a custom `AssemblyLoadContext.LoadFromAssemblyPath(Assembly.GetExecutingAssembly().Location)` call. `Assembly.Location` is empty for single-file bundles in .NET 6+, so the path argument is wrong. Switch to `AppContext.BaseDirectory`, or use `Assembly.LoadFromAssemblyName` and let the host resolve the bundled file.

**ASP.NET Core deployment to IIS.** If publish ships the file but IIS still throws, check that the app pool's `Identity` has read access to the publish folder and that `aspnetcorev2.dll` is the current version (`%programfiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll`). A stale ANCM picks up an old `deps.json`. This is a deployment problem, not a build one.

**Plugin / dynamic load contexts.** If you load plugins via `AssemblyLoadContext`, the plugin context does not inherit the default context's assemblies. A plugin that calls `Newtonsoft.Json` needs its own `Newtonsoft.Json.dll` next to the plugin, or an `AssemblyDependencyResolver` constructed from the plugin's path. The same shape as Fix 1, but the surface is the plugin folder, not the app folder. The MS Learn walkthrough at [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) shows the resolver pattern end to end.

**The build copied it, the publish did not.** Publish runs a different set of MSBuild targets than build (`ComputeFilesToPublish` instead of `BuiltProjectOutputGroup`). A `<Content Include="Foo.dll" CopyToOutputDirectory="PreserveNewest" />` puts the file in `bin/`, but only `<None Include="Foo.dll"><Pack>true</Pack><CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory></None>` (or `<Content>` with the publish flag) puts it in the publish folder. If the DLL appears in `bin/Release/net11.0/` but not in `bin/Release/net11.0/publish/`, this is the cause.

## Related

- [Fix: The type or namespace name could not be found after a project reference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) is the compile-time cousin of this exception: the same `Private` and `TargetFramework` mismatches show up as `CS0246` at build, or as `FileNotFoundException` at run.
- [Fix: MSBuild MSB3027 could not copy exceeded retry count](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/) covers the matching publish-time copy failure that leaves you with half a publish folder.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) is the trim-and-publish lookalike where the assembly is present but a code path is not.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) discusses self-contained vs framework-dependent tradeoffs for the same publish step.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the deeper take on the trimmer warnings that catch this class of bug at build time.

## Sources

- [Understand dependency loading in .NET](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/overview) (MS Learn)
- [Host tracing in the .NET runtime host](https://github.com/dotnet/runtime/blob/main/docs/design/features/host-tracing.md) (`dotnet/runtime`)
- [Controlling dependency assets with PackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#controlling-dependency-assets) (MS Learn)
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming) (MS Learn)
- [`DynamicDependencyAttribute` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicdependencyattribute) (MS Learn)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) (MS Learn)
- [`AppContext.BaseDirectory` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.appcontext.basedirectory) (MS Learn)
