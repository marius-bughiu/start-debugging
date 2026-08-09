---
title: "How to run a file-based C# app with `dotnet run app.cs` in .NET 11"
description: "A complete guide to file-based C# apps: running a single .cs file with dotnet run, the #:package, #:sdk, #:property, #:project and #:include directives, multi-file scripts with #:ref, argument and stdin handling, the build cache, native AOT publishing, packaging as a dotnet tool, and dotnet project convert when the script outgrows itself."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-10"
  - "dotnet-cli"
  - "file-based-apps"
---

To run a C# file without a project, save it as `app.cs` and run `dotnet run app.cs`. That is the whole thing. The SDK synthesizes a project in memory, restores, builds to a cache directory under your temp folder, and executes the result. You do not need a `.csproj`, a `Program` class, or a `Main` method. Configuration that would normally live in the project file goes into `#:` directives at the top of the source file: `#:package Humanizer@2.14.1` adds a NuGet reference, `#:sdk Microsoft.NET.Sdk.Web` turns the script into a web app, and `#:property PublishAot=false` sets any MSBuild property. File-based apps shipped in the .NET 10 SDK and got multi-file support in .NET 11. This post covers the full surface, including the parts that surprise people: where the build output actually goes, why a `.csproj` in your working directory silently hijacks the command, and which directives need which SDK version.

Everything labelled "verified" below was run on SDK 10.0.201 (runtime .NET 10.0.5) on Windows. .NET 11 is in Preview 6 at the time of writing with GA expected in November 2026, and the .NET 11 features are called out by version where they differ.

## Steps to run a file-based C# app

1. Save your code in a file with a `.cs` extension, using top-level statements. No `class`, no `Main`.
2. Add any `#:` directives at the top of the file: `#:package` for NuGet references, `#:sdk` to switch SDKs, `#:property` for MSBuild properties.
3. Run `dotnet run app.cs` from a directory that does not contain a project file.
4. Pass arguments to your app after a `--` separator: `dotnet run app.cs -- arg1 arg2`.
5. When the script outgrows a single file, run `dotnet project convert app.cs` to generate an equivalent `.csproj`.

The rest of this article expands each step and covers the behaviour you only discover by running into it.

## The smallest thing that runs

Top-level statements are the entry point. `args` is in scope with no ceremony:

```csharp
// app.cs -- verified on SDK 10.0.201
Console.WriteLine($"args: {string.Join(",", args)}");
Console.WriteLine($"tfm: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"asm: {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name}");
```

```bash
dotnet run app.cs -- one two
```

```
args: one,two
tfm: .NET 10.0.5
asm: app
```

Note the assembly name: `app`, taken from the file name. That matters later, because the build cache directory, the user secrets ID, and the packed tool name are all derived from it.

There are three equivalent ways to invoke this. `dotnet run app.cs` is the common form. `dotnet run --file app.cs` is the explicit form, which you want in scripts because it is unambiguous. And `dotnet app.cs` is the shorthand. All three produced identical output in testing.

You can also skip the file entirely and pipe source in on standard input using `-` as the argument:

```bash
echo 'Console.WriteLine("hello from stdin!");' | dotnet run -
```

That prints `hello from stdin!`. With `-`, the SDK does not scan the working directory for launch profiles or other files, though the current directory is still the working directory for the build. It is a genuinely useful escape hatch for shell scripts that generate C#.

## What the SDK actually generates

The clearest way to understand a file-based app is to look at the project the SDK builds on your behalf. `dotnet project convert` writes it to disk. For a file containing nothing but `Console.WriteLine("plain");`, the generated project is:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <PublishAot>true</PublishAot>
    <PackAsTool>true</PackAsTool>
    <UserSecretsId>plain-c7cf82264bd176cef60e04b947ef58d1b133625432bf800179babd82aa79722e</UserSecretsId>
  </PropertyGroup>

</Project>
```

Four of those defaults are worth internalising. `ImplicitUsings` and `Nullable` are both enabled, which is why `Console` resolves without a `using System;` and why the compiler will nag you about nullability in a throwaway script. `PublishAot` defaults to **true**, so `dotnet publish app.cs` produces a native executable unless you opt out. And `PackAsTool` defaults to true, so `dotnet pack app.cs` gives you a `dotnet tool install`-able package with no extra configuration. The `UserSecretsId` is a stable hash of the full file path, which means user secrets work out of the box but stop resolving if you move the file.

`TargetFramework` follows the SDK you have installed. On the 10.0.201 SDK it is `net10.0`; on a .NET 11 SDK it is `net11.0`. Pin it explicitly with `#:property TargetFramework=net10.0` if you care.

## The five directives

Directives go at the top of the file, prefixed with `#:`. The documented set is `#:include`, `#:package`, `#:project`, `#:property`, and `#:sdk`.

`#:package` adds a NuGet reference. The version goes after an `@`:

```csharp
// pkg.cs -- verified on SDK 10.0.201
#:package Humanizer@2.14.1

using Humanizer;
Console.WriteLine(TimeSpan.FromMinutes(90).Humanize(2));
```

That prints `1 hour, 30 minutes`. Use `@*` to float to the latest version. Omitting the version entirely only works when a `Directory.Packages.props` file puts you under central package management; otherwise pin it or use `@*`.

`#:sdk` swaps the MSBuild SDK, which is how you get a web app out of one file:

```csharp
// web.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

var app = WebApplication.Create();
app.MapGet("/", () => "ok");
app.Run();
```

`#:sdk` also accepts a version, as in `#:sdk Aspire.AppHost.Sdk@13.0.2`. Switching to `Microsoft.NET.Sdk.Web` changes the default item globs too: `*.json` configuration files in the directory are picked up automatically.

`#:property` sets any MSBuild property, and it is not limited to literals. MSBuild property functions work, so you can read environment variables with a fallback:

```csharp
#:property LogLevel=$([MSBuild]::ValueOrDefault('$(LOG_LEVEL)', 'Information'))
```

`#:project` references a real project file or a directory containing one, which is the bridge back to a normal solution:

```csharp
#:project ../SharedLibrary/SharedLibrary.csproj
```

## Multi-file scripts, and the SDK version that gates them

`#:include` pulls other files into the same compilation. It maps by extension: `*.cs` becomes `Compile`, `*.resx` becomes `EmbeddedResource`, `*.json` becomes `None`, `*.razor` becomes `Content`. Literal paths, glob patterns, and MSBuild properties all work:

```csharp
#:include helpers.cs
#:include models/customer.cs
#:include shared/**/*.cs
```

The critical restriction: included `.cs` files can add types, methods and namespaces, but they **cannot** contain top-level statements. Only the entry file gets those.

`#:include` requires .NET SDK 10.0.300 or .NET 11 Preview 3 and later. On an older SDK you get a flat rejection rather than a helpful version message. On 10.0.201 the exact error is:

```
inc.cs(1): error: Unrecognized directive 'include'.
```

If you see that, check `dotnet --version` before you go looking for a typo. This is the same gap that made [`#:include` in .NET 10 a notable milestone](/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/) when it landed.

.NET 11 Preview 5 added a second, different way to span files: [the `#:ref` directive](/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/), which references another file-based app as a *library* rather than merging it into one compilation, with transitive references supported ([dotnet/sdk#53480](https://github.com/dotnet/sdk/pull/53480)). The same preview removed the feature flags from `#:include` and `#:exclude` ([dotnet/sdk#53775](https://github.com/dotnet/sdk/pull/53775)) and made directives inside included files process transitively ([dotnet/sdk#54012](https://github.com/dotnet/sdk/pull/54012)). Preview 6 extended `#:include` to compiled assemblies, so `#:include ./libs/MyLibrary.dll` now works without a flag.

Two behavioural details from those preview notes are easy to trip over. Duplicate `#:project` and `#:ref` entries are allowed, matching MSBuild item semantics. Duplicate directives of other kinds across included files produce a diagnostic instead of being silently accepted, though Preview 6 relaxed that for `#:sdk`, `#:property` and `#:package` when the duplicated values match. Note that `#:ref` and `#:exclude` are documented in the SDK release notes but are not yet listed in the [MS Learn file-based apps article](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps), so treat the release notes as authoritative for those two.

## Arguments, environment variables, and where the output goes

Arguments after `--` are forwarded to your app rather than consumed by the CLI. Environment variables can be set inline with `-e`:

```bash
dotnet run -e FOO=bar env.cs
```

That prints `FOO=bar` from `Environment.GetEnvironmentVariable("FOO")`. The .NET 11 release notes list `dotnet run -e` as a new SDK option, but it already worked on the 10.0.201 SDK tested here.

Build output does not land next to your file. It goes to a content-addressed directory under the system temp folder, in the form `<temp>/dotnet/runfile/<appname>-<sha>/bin/<configuration>/`. The verified path on Windows:

```
C:\Users\...\AppData\Local\Temp\dotnet\runfile\app-82b0b938fb24db69...\bin\debug\app.dll
```

Redirect it with `--output` on `dotnet build`, or set a default in the file itself with `#:property OutputPath=./output`.

## The build cache is the whole performance story

The SDK caches build output keyed on source file content, directive configuration, SDK version, and the existence and content of implicit build files. The difference is large enough to change how the tool feels. Measured on SDK 10.0.201, same machine, same trivial script:

| Invocation | Wall clock |
| --- | --- |
| First run after `dotnet clean app.cs` | 1.174 s |
| Cached run | 0.252 s |

A quarter of a second is inside the range where a `.cs` file is a viable replacement for a shell script. A cold build is not.

Three cache behaviours cause confusion. Changes to implicit build files such as `Directory.Build.props` do not always trigger a rebuild. Moving a file to a different directory does not invalidate the cache. And using a glob pattern in `#:include` currently disables build caching entirely, so a `shared/**/*.cs` line silently costs you the fast path.

To clear it:

```bash
dotnet clean file-based-apps
```

That scans `<temp>/dotnet/runfile` and removes artifact folders unused for at least 30 days; pass `--days` to change the threshold. For a single app, `dotnet clean app.cs` followed by `dotnet build app.cs` forces a clean rebuild.

One concurrency caveat: running multiple instances of the same file-based app in parallel can fail on contention over the build output. Build once first, then run with `--no-build`:

```bash
dotnet build app.cs
dotnet run app.cs --no-build
```

## Publishing, packing, and shell execution

`dotnet publish app.cs` produces a self-contained executable in an `artifacts` directory next to the `.cs` file. Because `PublishAot` defaults to true, that is a native AOT binary with fast startup and no runtime dependency, which is exactly what you want for a distributed CLI tool and exactly what you do not want if your script uses reflection-heavy libraries. Opt out with `#:property PublishAot=false`. If you are unsure which side of that line your code falls on, the tradeoffs are the same ones covered in [what Native AOT actually costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), and the difference between building and publishing is worth being precise about as well, as covered in [`dotnet build` versus `dotnet publish`](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/).

`dotnet pack app.cs` produces a NuGet package, and since `PackAsTool` is true by default, that package is installable as a global tool. A single `.cs` file to a shippable `dotnet tool` with no project file is a genuinely short path.

On Unix-like systems you can make the file directly executable with a shebang:

```csharp
#!/usr/bin/env -S dotnet --
#:package Spectre.Console@*

using Spectre.Console;

AnsiConsole.MarkupLine("[green]Hello, World![/]");
```

```bash
chmod +x file.cs
./file.cs
```

The `-S` flag lets `env` split the rest of the line into separate arguments, and the trailing `--` stops `dotnet` from swallowing arguments that look like its own (`--help`, for instance). Use LF line endings and no BOM, or the shebang will not be recognised. If your `env` does not support `-S`, fall back to `#!/usr/bin/env dotnet` and accept the argument-collision risk.

## The gotcha that wastes the most time

If a project file exists in the current working directory, `dotnet run app.cs` runs *that project* and passes `app.cs` to it as a command-line argument. This is deliberate backwards compatibility, and it is silent.

Verified: from a directory containing `pkg.csproj`, running `dotnet run ../env.cs` executed `pkg.csproj` and printed its output, not the output of `env.cs`. Nothing warns you. Use `dotnet run --file ../env.cs` when you need certainty, and keep file-based apps outside any project's directory cone:

```
MyProject/
  MyProject.csproj
  Program.cs
scripts/
  utility.cs
```

The related trap is implicit build files. File-based apps respect `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config`, and `global.json` from the current and parent directories. A repo-root `Directory.Build.props` that sets `TreatWarningsAsErrors` will apply to your throwaway script. Give scripts their own directory with their own `Directory.Build.props` when you need isolation.

Two smaller ones. Launch profiles live in a flat `app.run.json` next to `app.cs` rather than in `Properties/launchSettings.json`; if both exist, the traditional location wins and the CLI logs a warning. And `dotnet user-secrets` needs the `--file` option to target a script: `dotnet user-secrets set "ApiKey" "value" --file app.cs`.

## When the script stops being a script

`dotnet project convert app.cs` is the graduation path. It copies the `.cs` file and writes a `.csproj` with equivalent SDK, properties and package references derived from your `#:` directives, both placed in a new directory named after the app. The original file is left untouched, so the conversion is non-destructive and you can diff the result before committing to it.

Running it against the Humanizer example above produced exactly the expected translation, with `#:package Humanizer@2.14.1` becoming a `PackageReference` and `#:property PublishAot=false` becoming a property:

```xml
  <ItemGroup>
    <PackageReference Include="Humanizer" Version="2.14.1" />
  </ItemGroup>
```

That gradient is the real design of the feature. Start with one file. Split helpers out with `#:include`. Promote a helper to a library with `#:ref`. Point at a real project with `#:project`. Convert when MSBuild ceremony finally earns its keep. Each step is one line, and none of them forces you to abandon `dotnet run`. For the inner-loop story once you do have a project, the distinction between [`dotnet watch` and `dotnet run`](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) is the next thing worth knowing.

## Related

- [.NET 11 Preview 5 lets file-based apps reference each other with `#:ref`](/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)
- [.NET 10 file-based apps just got multi-file scripts: `#:include` is landing](/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)
- [What is the difference between `dotnet build` and `dotnet publish`?](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [What is the difference between `dotnet watch` and `dotnet run`?](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)

## Sources

- [File-based apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps) on MS Learn, the conceptual reference for directives, CLI commands, caching, and folder layout.
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), which lists the `#:include` DLL support and `dotnet run -e`.
- [.NET 11 Preview 5 SDK release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) for `#:ref`, feature-flag removal, and duplicate-directive diagnostics.
- [.NET 11 Preview 6 SDK release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) for `#:include` of compiled assemblies.
- [Announcing dotnet run app.cs](https://devblogs.microsoft.com/dotnet/announcing-dotnet-run-app/) on the .NET Blog, the original design rationale.
