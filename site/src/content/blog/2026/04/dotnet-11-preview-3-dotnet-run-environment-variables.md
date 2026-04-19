---
title: ".NET 11 Preview 3: dotnet run -e sets environment variables without launch profiles"
description: "dotnet run -e in .NET 11 Preview 3 passes environment variables straight from the CLI and surfaces them as MSBuild RuntimeEnvironmentVariable items."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
  - "msbuild"
---

.NET 11 Preview 3 shipped on April 14, 2026 with a small but widely applicable SDK change: `dotnet run` now accepts `-e KEY=VALUE` to pass environment variables directly from the command line. No shell exports, no `launchSettings.json` edits, no one-off wrapper scripts.

## Why the flag matters

Before Preview 3, setting an env var for a single run meant one of three awkward options. On Windows you had `set ASPNETCORE_ENVIRONMENT=Staging && dotnet run` with `cmd.exe` quoting surprises. On bash you had `ASPNETCORE_ENVIRONMENT=Staging dotnet run`, which works but bleeds the variable into any child process that forks from the shell. Or you added yet another profile to `Properties/launchSettings.json` that nobody else on the team really wanted.

`dotnet run -e` takes over that job and keeps the scope tight to the run itself.

## The syntax, and what it actually sets

Pass one `-e` per variable. You can repeat the flag as many times as you need:

```bash
dotnet run -e ASPNETCORE_ENVIRONMENT=Development -e LOG_LEVEL=Debug
```

The SDK injects those values into the launched process' environment. Your app sees them through `Environment.GetEnvironmentVariable` or the ASP.NET Core configuration pipeline just like any other variable:

```csharp
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
Console.WriteLine($"Running as: {env}");
```

There is a second, less obvious side effect worth knowing about: the same variables are surfaced to MSBuild as `RuntimeEnvironmentVariable` items. That means targets running during the build phase of `dotnet run` can read them too, which unlocks scenarios like gating code generation on a flag or swapping resource files per environment.

## Reading RuntimeEnvironmentVariable items from a target

If you have a custom target that should react to the flag, enumerate the items MSBuild already populated:

```xml
<Target Name="LogRuntimeEnvVars" BeforeTargets="Build">
  <Message Importance="high"
           Text="Runtime env: @(RuntimeEnvironmentVariable->'%(Identity)=%(Value)', ', ')" />
</Target>
```

Run `dotnet run -e FEATURE_X=on -e TENANT=acme` and the target prints `FEATURE_X=on, TENANT=acme` before the app launches. These are regular MSBuild items, so you can filter them with `Condition`, feed them into other properties, or use them to drive `Include`/`Exclude` decisions inside the same build.

## Where it fits in the workflow

`dotnet run -e` is not a replacement for `launchSettings.json`. Launch profiles still make sense for the common configurations you hit every day and for debug scenarios in Visual Studio or Rider. The CLI flag is best for the one-shot cases: reproducing a bug someone reported under a specific `LOG_LEVEL`, testing a feature flag without committing a profile, or wiring up a quick CI step in `dotnet watch` without rewriting a YAML file.

One small caveat: values with spaces or shell-special characters still need quoting for your shell. `dotnet run -e "GREETING=hello world"` is fine in bash and PowerShell, `dotnet run -e GREETING="hello world"` works in `cmd.exe`. The SDK itself accepts the assignment as-is, but the shell gets to parse the command line first.

The smallest .NET 11 Preview 3 feature on paper, and probably one of the most-used in practice. Full release notes live at [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk), and the announcement post is on the [.NET Blog](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).
