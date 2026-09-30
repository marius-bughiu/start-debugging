---
title: "Fix: launchSettings.json environment variables are ignored for a commandName: Executable profile"
description: "If your Executable profile runs dotnet run or dotnet watch, the inner command applies the default profile and overwrites your variables. Add --no-launch-profile, and use SDK 10.0.200+."
pubDate: 2026-09-30
template: error-page
tags:
  - "errors"
  - "dotnet-cli"
  - "launchsettings"
  - "dotnet-watch"
  - "dotnet-10"
  - "dotnet-11"
---

If your `commandName: "Executable"` profile launches `dotnet run` or `dotnet watch run`, add `--no-launch-profile` (or `--launch-profile <name>`) to its `commandLineArgs`. The inner command otherwise picks the project's default profile, and that profile's `environmentVariables` overwrite the ones your Executable profile just set. If the CLI prints "The launch profile type 'Executable' is not supported", you are on an SDK older than 10.0.200. Upgrade, because those SDKs skip the whole profile. I measured everything below on macOS with SDKs 10.0.112, 10.0.302, 10.0.401 and 11.0.100-rc.1.

## The error in context

There are two versions of this problem, and which one you hit depends on your SDK.

On a 10.0.1xx SDK (and earlier SDKs, which only understood Project profiles), `dotnet run --launch-profile` tells you directly, and then runs the project anyway:

```
Using launch settings from /src/app/Properties/launchSettings.json...
The launch profile "Exe" could not be applied.
The launch profile type 'Executable' is not supported.
MY_MODE=<null> DOTNET_ENVIRONMENT=<null> DOTNET_LAUNCH_PROFILE=<null> args=[] cwd=/src/app
```

That message is easy to miss because the app starts. It just starts with no profile at all: no environment variables, no `commandLineArgs`, not even `DOTNET_LAUNCH_PROFILE`.

On 10.0.200 and later there is no warning. The profile runs, but the app sees the wrong values. This is the case reported in [dotnet/sdk#56023](https://github.com/dotnet/sdk/issues/56023): a "Watch" profile sets `ASPNETCORE_ENVIRONMENT=Development`, and the app still reports `Production`. The only clue is that the "Using launch settings" line is printed twice:

```
Using launch settings from /src/app/Properties/launchSettings.json...
Using launch settings from /src/app/Properties/launchSettings.json...
MY_MODE=from-Default DOTNET_ENVIRONMENT=Production DOTNET_LAUNCH_PROFILE=Default args=[] cwd=/src/app
```

## Why the variables get dropped

Here are the causes, most common first:

1. **A nested SDK command re-applies a profile.** `dotnet run` applies an Executable profile correctly. It starts `executablePath` with the profile's `environmentVariables` set. But when that executable is `dotnet` itself (`run`, `watch run`), the child is a brand new `dotnet run` with no `--launch-profile`. It reads the same `launchSettings.json`, selects the *first* profile with a supported `commandName`, and sets that profile's variables on the app process. Profile variables win over inherited ones (see `SetEnvironmentVariables` in [`RunCommand.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Cli/dotnet/Commands/Run/RunCommand.cs)), so your outer values are silently replaced.
2. **The SDK is older than 10.0.200.** Executable support in `dotnet run` and `dotnet watch` landed in [dotnet/sdk#51727](https://github.com/dotnet/sdk/pull/51727), merged into `release/10.0.2xx` on December 12, 2025. Before that, the CLI only knew `commandName: "Project"`. Visual Studio always supported Executable profiles, which is why the same file "works in VS".
3. **The IDE never reads Executable profiles.** The VS Code C# extension documents that "Only profiles with `"commandName": "Project"` are supported" in its [debugger settings](https://code.visualstudio.com/docs/csharp/debugger-settings). Choosing an Executable profile there does nothing with its variables.

## How dotnet run picks a profile and layers variables

It helps to know the exact order the CLI follows, because every workaround below is just a way to control one of these steps. On SDK 10.0.200 and later, `dotnet run` does this:

1. If you pass `--no-launch-profile`, it uses no profile at all. Stop here.
2. Otherwise it looks for `Properties/launchSettings.json` (`My Project/launchSettings.json` for VB, or `<app>.run.json` next to a file-based app).
3. With `--launch-profile <name>` it picks that profile. The lookup is case-sensitive first, then falls back to a case-insensitive match. Without the flag it picks the first profile whose `commandName` is `Project` or `Executable`. Any other command name (`IISExpress`, `Docker`, `DotNetCore`) is skipped.
4. It builds the child process environment in three layers. First the inherited environment of the `dotnet` process. Then `DOTNET_LAUNCH_PROFILE`, plus `ASPNETCORE_URLS` from `applicationUrl` for Project profiles, and every entry in `environmentVariables`. Finally any `-e KEY=VALUE` from the command line. Later layers win.

Step 4 is why the nested case fails. The outer `dotnet run` puts your values into layer one of the inner `dotnet run`, and the inner command's layer two replaces them. Nothing in the inner process knows it was started from a launch profile. Every fix comes down to making the inner step 1 or step 3 behave.

## Minimal repro

A console app that prints what it actually received:

```csharp
// .NET 10, C# 14 - Program.cs (ImplicitUsings enabled)
Console.WriteLine($"MY_MODE={Environment.GetEnvironmentVariable("MY_MODE") ?? "<null>"} " +
                  $"DOTNET_ENVIRONMENT={Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "<null>"} " +
                  $"DOTNET_LAUNCH_PROFILE={Environment.GetEnvironmentVariable("DOTNET_LAUNCH_PROFILE") ?? "<null>"} " +
                  $"args=[{string.Join(",", args)}] cwd={Environment.CurrentDirectory}");
```

And a `Properties/launchSettings.json` with a normal Project profile first, then three Executable profiles:

```json
{
  "profiles": {
    "Default": {
      "commandName": "Project",
      "environmentVariables": { "MY_MODE": "from-Default", "DOTNET_ENVIRONMENT": "Production" }
    },
    "Exe": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "bin/Debug/net10.0/app.dll hello",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Exe", "DOTNET_ENVIRONMENT": "Development" }
    },
    "ExeDotnetRun": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "run --no-build",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-ExeDotnetRun", "DOTNET_ENVIRONMENT": "Development" }
    },
    "Watch": {
      "commandName": "Executable",
      "executablePath": "dotnet",
      "commandLineArgs": "watch run --non-interactive",
      "workingDirectory": "..",
      "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
    }
  }
}
```

Running `dotnet run --no-build --launch-profile <name>` on each SDK printed this:

| Profile | 10.0.112 | 10.0.302 / 10.0.401 / 11.0.100-rc.1 |
| --- | --- | --- |
| `Default` (Project) | `from-Default` | `from-Default` |
| `Exe` (runs `app.dll`) | "not supported" warning, `<null>` | `from-Exe`, `Development`, args `[hello]` |
| `ExeDotnetRun` | "not supported" warning, `<null>` | `from-Default`, `Production` |
| `Watch` | "not supported" warning, `<null>` | `from-Default`, `Production` (10.0.302) |

The `Exe` row shows that the Executable profile support itself works on modern SDKs. The `ExeDotnetRun` and `Watch` rows show the overwrite: the inner command reports `DOTNET_LAUNCH_PROFILE=Default`, meaning it picked up the first profile on its own.

## The fix, step by step

1. **Check the SDK.** Run `dotnet --version` in the project directory, because `global.json` can pin an older band. You need 10.0.200 or later for `dotnet run` and `dotnet watch` to honor Executable profiles at all. On 10.0.1xx, keep the variables in a `Project` profile instead.
2. **Stop the nested command from picking a profile.** If `executablePath` is `dotnet` and the arguments start `run` or `watch`, add `--no-launch-profile`:

   ```json
   // .NET SDK 10.0.200+ - Properties/launchSettings.json
   "Watch": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "watch run --non-interactive --no-launch-profile",
     "workingDirectory": "..",
     "environmentVariables": { "MY_MODE": "from-Watch", "DOTNET_ENVIRONMENT": "Development" }
   }
   ```

   With that change the app printed `MY_MODE=from-WatchNoProfile DOTNET_ENVIRONMENT=Development` under `dotnet watch` on 10.0.302. `DOTNET_LAUNCH_PROFILE` still shows the outer profile name, because the outer `dotnet run` set it and nothing overwrote it.

3. **Or point the nested command at a specific profile.** If the variables already live in a Project profile, reference it instead of duplicating them:

   ```json
   // .NET SDK 10.0.200+
   "ExeDotnetRunPinned": {
     "commandName": "Executable",
     "executablePath": "dotnet",
     "commandLineArgs": "run --no-build --launch-profile Dev",
     "workingDirectory": ".."
   }
   ```

   This printed `MY_MODE=from-Dev DOTNET_ENVIRONMENT=Development DOTNET_LAUNCH_PROFILE=Dev`. In this setup the inner profile owns the variables. Anything you put in the outer profile's `environmentVariables` loses whenever both profiles set the same key.

4. **In VS Code, move the variables to `launch.json`.** The C# extension only reads Project profiles and only their `environmentVariables`, `applicationUrl` and `commandLineArgs`. Put an `env` block on a `coreclr` launch configuration instead. Values in `launch.json` take precedence over `launchSettings.json` anyway.

## Gotchas and lookalikes

**An Executable profile listed first becomes the default, and can fork forever.** On 10.0.200+, the default profile is the first one whose `commandName` is `Project` *or* `Executable` (`IsDefaultProfileType` in [`LaunchSettings.cs`](https://github.com/dotnet/sdk/blob/release/10.0.4xx/src/Microsoft.DotNet.ProjectTools/LaunchSettings/LaunchSettings.cs), and the same rule in `dotnet watch`). Put `"commandLineArgs": "run --no-build"` in the first profile, run a plain `dotnet run`, and every child selects the same profile again. On 10.0.302 I counted 53 `dotnet run` processes after 12 seconds before killing them. The `--no-launch-profile` fix above breaks the loop too. Keeping a Project profile at the top of the file is cheap insurance.

**`dotnet run -e` does not survive the nested hop either.** I checked `dotnet run -e KEY=VALUE` on SDK 10.0.112 and later (see [`dotnet run -e`](/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)). It overrides the profile for the process the outer `dotnet run` starts. When that process is another `dotnet run`, the inner default profile overwrites it too: `-lp ExeDotnetRun -e MY_MODE=from-cli` still printed `from-Default`. The same applies to a plain shell export. `MY_MODE=from-shell dotnet run -lp Default` prints `from-Default`, because launch profile values always beat inherited ones.

**`%VAR%` is expanded, `$(Property)` is not (yet).** The CLI runs every value through `Environment.ExpandEnvironmentVariables`, so `%HOME%` works on macOS and Linux as well. `$(HOME)` and `${HOME}` pass through literally. MSBuild properties such as `$(TargetPath)` or `$(ProjectDir)` are not expanded on any shipped SDK I tested (10.0.302, 10.0.401, 11.0.100-rc.1). You get `An error occurred trying to start process '$(TargetPath)' ... No such file or directory` instead of a silently ignored variable. Visual Studio's `ProjectLaunchTargetsProvider` does expand them (per the [project-system launch profile docs](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)), which is why a profile copied from a VS setup breaks in the CLI. [dotnet/sdk#56074](https://github.com/dotnet/sdk/pull/56074) adds the expansion. It merged into `main` on September 4, 2026, but it is not in `release/11.0.1xx-rc2` or any 10.0 band as of today. Until it ships, use relative paths.

**`workingDirectory` is relative to the `Properties` folder, not the project.** The CLI resolves it with `Path.Combine(Path.GetDirectoryName(launchSettingsPath), value)`, so `".."` means the project directory. Visual Studio and Rider resolve it differently, which [dotnet/sdk#56129](https://github.com/dotnet/sdk/pull/56129) is currently discussing. For Project profiles the CLI ignores `workingDirectory` completely on today's SDKs.

**A fix for the nested case is in review.** [dotnet/sdk#56087](https://github.com/dotnet/sdk/pull/56087) makes `dotnet run` set a `DOTNET_LAUNCH_PROFILE_APPLIED=1` marker on processes it starts from an Executable profile. A nested `dotnet run` without an explicit profile then skips the default profile. It was still open on September 30, 2026. Even once it ships, it only covers profiles started through the CLI. The PR notes that IDEs starting the Executable profile directly still need `--no-launch-profile`.

**`hotReloadEnabled` on a Project profile does nothing in `dotnet run`.** The reporter of #56023 also noticed this. Hot reload comes from `dotnet watch`, not from a profile property. That is exactly why people wrap `dotnet watch` in an Executable profile in the first place. See [how `dotnet watch` differs from `dotnet run`](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) for what the watcher adds.

## Related

- [.NET 11 Preview 3: dotnet run -e sets environment variables without launch profiles](/2026/04/dotnet-11-preview-3-dotnet-run-environment-variables/)
- [What is the difference between dotnet watch and dotnet run?](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)
- [Fix: dotnet watch Blazor hot reload WebSocket fails on a custom local domain](/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/), another case where launch profile variables do not reach the process you expect
- [How to run a file-based C# app with `dotnet run app.cs`](/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/), which reads `<app>.run.json` launch profiles through the same code
- [How to add Aspire to an existing ASP.NET Core solution](/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/), where the AppHost's own launch profile decides which environment every service gets

## Sources

- [dotnet/sdk#56023: `launchSettings.json` environment variables are not propagated for `commandName: Executable`](https://github.com/dotnet/sdk/issues/56023)
- [dotnet/sdk#51727: Add Executable launch profile support to dotnet run and dotnet watch](https://github.com/dotnet/sdk/pull/51727)
- [dotnet/sdk#56087: Preserve Executable launch profile environment in nested dotnet run](https://github.com/dotnet/sdk/pull/56087)
- [dotnet/sdk#56074: Expand MSBuild properties across launch profiles](https://github.com/dotnet/sdk/pull/56074)
- [dotnet/sdk#49131: Allow `dotnet run` to use launch profiles with `commandName: Executable`](https://github.com/dotnet/sdk/issues/49131)
- [dotnet/project-system: launch profiles documentation](https://github.com/dotnet/project-system/blob/main/docs/launch-profiles.md)
- [VS Code C# debugger settings: launchSettings.json support](https://code.visualstudio.com/docs/csharp/debugger-settings)
- [`dotnet run` command reference on Microsoft Learn](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)
