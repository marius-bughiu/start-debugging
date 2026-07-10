---
title: "What is the difference between dotnet build and dotnet publish?"
description: "dotnet build compiles your project for the inner development loop and defaults to Debug. dotnet publish runs the MSBuild Publish target, defaults to Release on net8.0 and later, and packages a deployable folder with web assets, self-contained runtimes, single-file, trimming, and AOT handled. Here is exactly what each one produces and when to reach for it."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "msbuild"
  - "deployment"
  - "dotnet-11"
---

`dotnet build` compiles your project and its dependencies into IL assemblies for the inner development loop, and it defaults to the `Debug` configuration. `dotnet publish` runs a different MSBuild target that produces a self-contained folder ready to copy to a server, defaults to the `Release` configuration for any project targeting `net8.0` or later, and is the only officially supported way to prepare an app for deployment. The short version: `build` is what you run while you are writing code, `publish` is what you run when you are done and want something you can ship. The differences that actually bite are the default configuration flip and everything the `Publish` target does that `Build` does not, such as processing web assets, bundling the runtime for self-contained deployments, and applying single-file, trimming, and AOT.

Everything below uses the .NET 11 SDK (`11.0.100`) with `<TargetFramework>net11.0</TargetFramework>` and C# 14. The behavior described applies from the .NET 8 SDK onward unless a specific version is called out, because the most consequential difference, the default configuration, changed in .NET 8.

## Two different MSBuild targets, not two flavors of the same thing

Both commands are thin wrappers over MSBuild, but they invoke different targets, and that single fact explains almost every difference you will notice.

`dotnet build` runs the default `Build` target. Per the [dotnet build reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build), running it is equivalent to `dotnet msbuild -restore` with a different default verbosity. It compiles your code plus its dependencies into a set of binaries and stops there.

`dotnet publish` runs the `Publish` target. The [dotnet publish reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) is explicit that it "compiles the application, reads through its dependencies specified in the project file, and publishes the resulting set of files to a directory," and that its output "is ready for deployment to a hosting system." The `Publish` target depends on `Build`, so a publish always builds first, then does more work on top.

That "more work on top" is the whole story. When you understand what the `Publish` target adds, you understand when `build` output is good enough and when it will quietly fail in production.

## The default configuration is the trap most people hit first

This is the difference that costs people an afternoon, so it goes first.

`dotnet build` defaults to `Debug`. `dotnet publish` defaults to `Release`, but only for projects whose target framework is `net8.0` or later. Both defaults are overridable with `-c|--configuration`.

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet build      # builds Debug   -> bin/Debug/net11.0/
dotnet publish    # publishes Release -> bin/Release/net11.0/publish/
```

Before .NET 8, `dotnet publish` also defaulted to `Debug`, and a lot of muscle memory and CI scripts still assume that. Microsoft changed it deliberately so that the command whose job is to produce deployment artifacts produces optimized ones by default. The change is documented under ['dotnet publish' uses Release configuration](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config).

The practical consequence: if you `dotnet build` and then copy `bin/Debug/...` to a server, you are shipping an unoptimized binary with JIT optimizations disabled and debugging aids enabled. If your CI pipeline still passes `-c Release` to `dotnet publish` "to be safe," that is now redundant but harmless. If it passes `-c Debug` out of habit, you are overriding the sensible default and shipping Debug. Read your pipeline once and delete the cargo cult.

## What each command actually writes to disk

The output sets overlap, which is why the commands look interchangeable at a glance, but they are not the same folder.

`dotnet build` writes to `bin/<configuration>/<framework>/`, for example `bin/Debug/net11.0/`. It emits your IL `.dll`, an executable to launch it for `Exe` projects, `.pdb` symbol files, a `.deps.json` listing dependencies, a `.runtimeconfig.json` naming the shared runtime, and copies of your dependency DLLs. For executable projects targeting .NET Core 3.0 and later, the docs note that "if there isn't any other publish-specific logic (such as Web projects have), the build output should be deployable."

`dotnet publish` writes to a `publish` subfolder: `bin/<configuration>/<framework>/publish/` for a framework-dependent build, or `bin/<configuration>/<framework>/<runtime>/publish/` when you build self-contained for a specific runtime. It emits the same core files (IL `.dll`, `.deps.json`, `.runtimeconfig.json`, dependencies) plus whatever the deployment shape requires.

Note that `publish` output goes into a nested `publish` directory precisely so it does not collide with the plain build output. If you point `-o` at a folder directly under your project on a web project, successive publishes can nest into `publish/publish`, which is a known sharp edge called out in the docs.

## Why "build output is deployable" is a half-truth

The docs say build output "should be deployable" for a plain executable, and for a simple console app that is genuinely true. You can `dotnet build -c Release`, zip `bin/Release/net11.0/`, drop it on a box with the matching .NET 11 runtime installed, and run it.

The trouble is that the qualifier "if there isn't any other publish-specific logic" covers a lot of real applications. The `Publish` target does work that `Build` never runs:

- **Web assets.** ASP.NET Core and Blazor projects gather static files, compile Razor components, produce the `wwwroot` layout, and generate the static-web-assets manifests during publish. A raw `build` does not assemble the deployable web-content tree the way the host expects it.
- **Self-contained runtime bundling.** When you pass `--self-contained`, publish copies an entire .NET runtime into the output so the target machine needs nothing preinstalled. `build` never bundles a runtime.
- **Ready-to-run, single-file, trimming, and AOT.** These are all publish-time transformations, described below.

So the accurate rule is: for a library or a trivial console app, `build` output and `publish` output are nearly the same set of files. For a web app, a self-contained deployment, or anything using the publish-time transformations, only `publish` produces something correct. When people report a [could not load file or assembly error in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), the root cause is often that they deployed a `build` folder, or a partial copy of one, instead of a real `publish` output.

## Framework-dependent vs self-contained: a publish-only decision

`dotnet build` builds against the shared framework and assumes the runtime is present at run time. It has no concept of packaging a runtime.

`dotnet publish` lets you choose the deployment model. Framework-dependent is the default and keeps the output small, requiring a matching .NET runtime on the target:

```bash
# .NET 11 SDK 11.0.100. Framework-dependent, cross-platform. Target needs .NET 11 installed.
dotnet publish -c Release
```

Self-contained bundles the runtime so the target needs nothing preinstalled, at the cost of a much larger output and a per-runtime build:

```bash
# .NET 11 SDK 11.0.100. Self-contained: the runtime ships inside the output folder.
dotnet publish -c Release -r linux-x64 --self-contained
```

The `-r` (runtime identifier) makes the output platform-specific: a `linux-x64` publish does not run on `win-x64`. That is why the self-contained output path includes the runtime segment (`bin/Release/net11.0/linux-x64/publish/`). If you ship to several platforms you run one publish per RID. This portability trade is the same one you weigh when deciding whether to reach for [Native AOT, and what it costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/).

## The publish-time transformations that have no build equivalent

Four MSBuild properties change what `publish` produces, and none of them do anything meaningful during a plain `build`. They are the reason `publish` exists as a separate command.

**`PublishReadyToRun`** compiles your assemblies to ReadyToRun (R2R) format, a form of ahead-of-time compilation that pre-JITs your code to cut startup time while keeping the JIT available for later. It is a publish-time step; see how it stacks up against the alternatives in [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

**`PublishSingleFile`** packs the app into one platform-specific executable. Setting it implicitly turns on `PublishSelfContained`.

**`PublishTrimmed`** removes library code the trimmer cannot prove is reachable, shrinking a self-contained deployment. It only applies to self-contained publishes.

**`PublishAot`** runs the ILC compiler to produce a single native binary with no JIT at all.

```xml
<!-- .NET 11, C# 14. These belong in the .csproj, not on the build command line. -->
<PropertyGroup>
  <PublishSingleFile>true</PublishSingleFile>
  <PublishTrimmed>true</PublishTrimmed>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. Only 'publish' honors these; 'build' ignores them.
dotnet publish -c Release -r win-x64
```

Run `dotnet build` on a project with these properties set and nothing happens: the trimmer does not run, no single file is produced, ILC is never invoked. The transformations are wired into the `Publish` target's dependency graph, not `Build`'s. This is the concrete, mechanical reason the docs call `publish` "the only officially supported way to prepare the application for deployment."

## Skipping the rebuild with --no-build

Because `publish` depends on `Build`, a publish recompiles by default. In a CI pipeline where you already ran `dotnet build` (to run analyzers or tests against the exact binaries), recompiling during publish wastes time and, worse, can produce subtly different outputs. Pass `--no-build` to reuse the existing build output:

```bash
# .NET 11 SDK 11.0.100. Build once with the config you want, then publish that.
dotnet build -c Release
dotnet publish -c Release --no-build
```

Two things to watch. First, `--no-build` implicitly sets `--no-restore`, so restore must have already happened. Second, the configurations must match: if you `dotnet build -c Release` and then `dotnet publish --no-build` without `-c Release`, publish looks for `Debug` output (its default), does not find a matching build, and fails. Keep the `-c` value identical across both commands. If you use the artifacts output layout (`--artifacts-path`), the docs note you must cascade that same path to both commands too.

## dotnet run and dotnet test sit alongside these

It helps to place the two commands in the wider CLI. `dotnet run` builds (Debug by default) and immediately launches the app; it is the inner-loop convenience wrapper, not a deployment tool. `dotnet test` builds and runs your test project. `dotnet pack` produces a NuGet package rather than a deployable app, and like publish it defaults to `Release` on `net8.0` and later. All of them run an implicit `dotnet restore` first unless you pass `--no-restore`. If your CI cannot even find the SDK to run any of these, that is a separate environment problem covered in [the command dotnet could not be found on CI](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

## Which one to run, decided in one line each

Use `dotnet build` while you are developing: to compile, surface warnings and analyzer diagnostics, and produce binaries for your tests. It is fast, it defaults to Debug, and its output is meant for your machine.

Use `dotnet publish` when you want an artifact to ship: it defaults to Release, runs the deployment-specific steps, and is the supported path to a folder you can hand to a server, a container image, or a Native AOT binary. When you are cutting a release build in CI, publish (optionally after a single shared `build` with `--no-build`) is the command that produces the thing you deploy. If you are also moving across major runtime versions at the same time, pair this with the [.NET 8 to .NET 11 migration checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) so the publish output targets the runtime you actually intend to run on.

The one-sentence test: if the output is for you, `build`; if the output is for a machine that is not yours, `publish`.

## Related

- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Fix: Could not load file or assembly in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Fix: The command 'dotnet' could not be found on CI](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Sources

- [dotnet publish command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) (Microsoft Learn)
- [dotnet build command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- ['dotnet publish' uses the Release configuration by default](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) (Microsoft Learn)
- [.NET application publishing overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/) (Microsoft Learn)
