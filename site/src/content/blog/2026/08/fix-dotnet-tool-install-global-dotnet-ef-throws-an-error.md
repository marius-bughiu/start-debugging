---
title: "Fix: dotnet tool install --global dotnet-ef throws an error"
description: "Every way dotnet tool install --global dotnet-ef fails on the .NET 10 SDK, with the exact message and exit code for each: already installed, version not found, downgrade blocked, shim conflict, dead NuGet feed, and the runtime mismatch that only breaks after the install succeeds."
pubDate: 2026-08-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "ef-core"
  - "entity-framework"
---

`dotnet tool install --global dotnet-ef` fails for six distinct reasons, and the SDK gives each one a different one-line message with no stack trace to disambiguate it. Read the line, not the exit code: "Tool 'dotnet-ef' is already installed." exits **0** and is not an error at all, while "is not found in NuGet feeds", "is lower than existing version", "conflicts with an existing command from another tool", and "No NuGet sources are defined or enabled" all exit **1** and each needs a different flag. Everything below was run against SDK 10.0.201 on Windows 11 on 2026-08-12, against the live nuget.org feed.

## The error in context

These are the actual messages, captured verbatim. The SDK prints one line and stops:

```
Tool 'dotnet-ef' is already installed.

Version 99.0.0 of package dotnet-ef is not found in NuGet feeds https://api.nuget.org/v3/index.json.

dotnet-ef-typo-xyz is not found in NuGet feeds https://api.nuget.org/v3/index.json.

The requested version 8.0.11 is lower than existing version 9.0.11.

Tool 'dotnet-ef' failed to update due to the following:
Failed to create shell shim for tool 'dotnet-ef': Command 'dotnet-ef' conflicts with an existing command from another tool.
Tool 'dotnet-ef' failed to install.

No NuGet sources are defined or enabled

Unhandled exception: Unable to load the service index for source https://nuget.invalid.example/v3/index.json.
```

There is a seventh failure that is worse than all of these, because the install reports success:

```
You can invoke the tool using the following command: dotnet-ef
Tool 'dotnet-ef' (version '3.1.32') was successfully installed.
```

and then the tool refuses to run.

## Why this happens

`dotnet tool install` does three separate jobs in one command, and each job has its own failure surface. It resolves a package version from your configured NuGet feeds, it unpacks that package into the tool store, and it writes an executable shim into the tool directory. A NuGet resolution problem, a version-ordering rule, and a filesystem name collision produce completely unrelated messages, which is why searching for "dotnet tool install dotnet-ef error" returns advice that does not match what you are looking at.

The seventh case is different in kind. Installing a tool never checks that you have a runtime capable of running it. The package's target framework is only enforced by the host at launch, so a tool built for a runtime you do not have installs cleanly and then dies on first use.

## Repro: reproducing each failure on SDK 10.0.201

Use `--tool-path` rather than `--global` while you experiment. It isolates every case into a throwaway directory instead of churning your real tool store, and the failure messages are identical:

```bash
# SDK 10.0.201. Each block is one failure mode.
dotnet tool install --tool-path ./tp dotnet-ef --version 99.0.0
dotnet tool install --tool-path ./tp dotnet-ef-typo-xyz
dotnet tool install --tool-path ./tp dotnet-ef --version 9.0.11
dotnet tool install --tool-path ./tp dotnet-ef --version 8.0.11
```

The third command succeeds, the fourth prints `The requested version 8.0.11 is lower than existing version 9.0.11.` and exits 1. To reproduce the shim collision, put any file with the tool's command name in the target directory first:

```bash
# SDK 10.0.201
mkdir -p ./tp6 && echo dummy > ./tp6/dotnet-ef.exe
dotnet tool install --tool-path ./tp6 dotnet-ef
```

## Fix, in detail

Ranked by how often each one is actually what you hit.

### "Tool 'dotnet-ef' is already installed." is not a failure

Exit code 0. Measured, not assumed. The command is idempotent by design, so leaving it unguarded in a provisioning script or a Dockerfile is correct and will not break the build.

What confuses people is that the same command sometimes prints something else entirely:

```
Tool 'dotnet-ef' was successfully updated from version '10.0.10' to version '10.0.11'.
```

On the .NET 10 SDK, `dotnet tool install --global dotnet-ef` with no `--version` upgrades an existing installation to the latest stable version rather than refusing. You only get "already installed" when the version you would land on is the one you already have. If you wanted a pinned version and got an unexpected upgrade, that is why: pin it.

```bash
# SDK 10.0.201. Both forms work; the @ syntax needs SDK 10.0.100 or later.
dotnet tool install --global dotnet-ef --version 10.0.11
dotnet tool install --global dotnet-ef@10.0.11
```

### "is not found in NuGet feeds" means the version, not the package

Two different messages share this wording and they mean different things. `dotnet-ef-typo-xyz is not found in NuGet feeds ...` names the package, so the package ID is wrong or your feed does not carry it. `Version 99.0.0 of package dotnet-ef is not found in NuGet feeds ...` names a version, so the package resolved fine and the version did not exist.

The second is the common one, because `--version 11.0.0` does not do what people expect. Since .NET 8, `--version Major.Minor.Patch` matches that exact version including unlisted ones, and does not float. For the newest 11.x, use a wildcard, and for a preview you must opt in explicitly:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 11.0.*
dotnet tool install --global dotnet-ef --prerelease
```

The `--prerelease` run resolved `11.0.0-preview.7.26381.103` on the day this was written. Without the flag, preview versions are invisible and you get a "not found" for a version you can plainly see on nuget.org.

### "The requested version X is lower than existing version Y"

Installing over a newer tool is refused, and so is `dotnet tool update` to an older version. The flag exists precisely for this:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 8.0.11 --allow-downgrade
```

which reports `Tool 'dotnet-ef' was successfully updated from version '9.0.11' to version '8.0.11'.` and exits 0. Reach for this when you are pinning the tool to match an older EF Core runtime in a legacy branch. `dotnet tool uninstall --global dotnet-ef` followed by a fresh install works too, but it is two commands and it leaves you with nothing installed if the second one fails.

### "Failed to create shell shim ... conflicts with an existing command from another tool"

The tool directory already contains an executable named `dotnet-ef` that this install did not create. The install is aborted rather than clobbering it, and note the misleading first line: it says "failed to update" before saying "failed to install".

In practice this is almost always a half-removed previous install, or a `--tool-path` install shadowing a `--global` one. Find the stale shim and delete it. Global tools live in `%USERPROFILE%\.dotnet\tools` on Windows and `$HOME/.dotnet/tools` on Linux and macOS, with the real binaries in a sibling `.store` directory:

```bash
# SDK 10.0.201
dotnet tool list --global
ls ~/.dotnet/tools
```

If `dotnet tool list --global` does not show `dotnet-ef` but the file is there, the shim is orphaned and safe to remove by hand.

### "No NuGet sources are defined or enabled"

Nothing to restore from. A `NuGet.config` somewhere above your current directory has `<clear />` in `<packageSources>` with nothing added back, or every source is disabled. This is easy to hit inside a repo that scopes itself to a private feed, and easy to miss because the config that breaks you may be several directories up.

```bash
# SDK 10.0.201
dotnet nuget list source
dotnet tool install --global dotnet-ef --source https://api.nuget.org/v3/index.json
```

`--source` replaces every configured source for this one command, which is the fastest way to confirm the config is the problem rather than the network.

### "Unable to load the service index for source"

One feed in your config is unreachable, and on SDK 10.0.201 this surfaces as a raw `Unhandled exception:` line. It aborts the whole install even when a working feed later in the list has the package. Tell the SDK to treat a dead feed as a warning:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --ignore-failed-sources
```

With a config listing an unreachable private feed followed by nuget.org, the bare command threw and `--ignore-failed-sources` installed 10.0.11 cleanly. If the private feed is the one that has the package, this flag will not save you and you need `--interactive` to complete authentication instead.

### The install succeeds and the tool will not start

This is the one that costs an afternoon. Installing an old `dotnet-ef` on a machine without the runtime it targets works fine, and then:

```
You must install or update .NET to run this application.

App: ...\dotnet-ef.exe
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '3.1.0' (x64)
.NET location: C:\Program Files\dotnet\

The following frameworks were found:
  6.0.36 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  8.0.23 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
  10.0.5 at [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]
```

The fix is a flag at install time, available since the .NET 9 SDK, that lets the tool run on a newer runtime than it targets:

```bash
# SDK 10.0.201
dotnet tool install --global dotnet-ef --version 3.1.32 --allow-roll-forward
```

Same package, same machine. Without the flag the shim refuses to start; with it, `dotnet-ef --version` prints `3.1.32` on the 10.0.5 runtime. It is an install-time decision baked into the shim, so an already-installed tool has to be reinstalled to pick it up.

## What changed in the .NET 10 SDK

Three behaviours changed and all three generate support questions.

Install now acts as install-or-update for unpinned global tools, which is why a command that used to be a no-op on a provisioned machine now silently moves you forward a patch version. Pin the version if that matters.

Local installs no longer fail when there is no manifest. Previously `dotnet tool install dotnet-ef` without `-g` in a folder with no `.config/dotnet-tools.json` produced "Cannot find a manifest file." Starting in .NET 10, `--create-manifest-if-needed` defaults to on and a manifest is created for you, placed in the nearest ancestor directory containing a `.git` subfolder. That is usually right and occasionally very wrong: run it from a Downloads folder or from inside an unrelated repo and you will silently amend somebody else's manifest. Opt out with `--create-manifest-if-needed=false`. The `-d` flag that used to print the searched manifest locations is dead, because the error it annotated no longer exists.

The `@version` syntax landed in SDK 10.0.100, so `dotnet-ef@10.0.11` is now equivalent to `dotnet-ef --version 10.0.11`. Mixing the two forms is an error: passing both `dotnet-ef@10.0.11` and `--version` returns "Cannot specify --version when the package argument already contains a version."

## Can you run dotnet-ef without installing it

If the install is failing on a CI runner you do not control, the fastest fix in .NET 10 is to stop installing. `dotnet tool exec` and its shorthand `dnx` download and run a tool in one shot:

```bash
# SDK 10.0.201
dnx dotnet-ef -y -- --version
dotnet tool exec dotnet-ef --yes -- database update
```

The `-y` accepts the download prompt, which you need in any non-interactive context. The `--` separator is not optional here and the failure is confusing without it: `dnx` parses `--version`, `--prerelease` and `--source` as its own options, so `dnx dotnet-ef --version` never reaches the tool. Put everything meant for `dotnet-ef` after `--`.

One-shot execution also respects a local manifest. If there is a `.config/dotnet-tools.json` nearby, `dnx` runs the version pinned there rather than the latest on the feed, which makes it a reasonable default for repo scripts.

## Gotchas and lookalike errors

**"Could not execute because the specified command or file was not found"** is a different problem. The install worked and the shim directory is not on your `PATH`. That has its own walkthrough in [fixing dotnet ef not found](/2023/06/how-to-fix-command-dotnet-ef-not-found/); on Linux the tool is only runnable from `$HOME/.dotnet/tools` until you export it yourself, and on a CI runner you usually need [dotnet itself on PATH first](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

**The tools-older-than-runtime warning** sends people back to reinstall when nothing is broken:

```
The Entity Framework tools version '8.0.11' is older than that of the runtime '10.0.5'. Update the tools for the latest features and bug fixes. See https://aka.ms/AAc1fbw for more information.
```

That is a warning, not the cause of whatever failed next. In the run above it was followed by an unrelated "No DbContext was found in assembly" error. Update the tool if you like, but do not assume it fixed anything.

**A successful install does not mean `dotnet ef` will work in your solution.** The two most common next failures are the design-time host not resolving, covered in [Unable to create an object of type DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), and the design package sitting in the wrong project, covered in [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

**Do not install the tool on production machines to run migrations.** Build a migration bundle in CI instead, which needs no SDK and no global tool on the target. That workflow is in [applying EF Core 11 migrations with dotnet ef migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Related

Once the tool installs, the friction moves to invoking it correctly in a split solution, and EF Core 11 finally has an answer for that in [the .config/dotnet-ef.json defaults file](/2026/06/efcore-11-dotnet-ef-json-config-file/). If you arrived here mid-upgrade, the tool version is one line item among many in the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) and the [EF Core 6 to EF Core 11 breaking changes](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Sources

- [dotnet tool install command](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), for the option reference, the install locations table, and the `--version Major.Minor.Patch` matching rule introduced in .NET 8.
- [Breaking change: dotnet tool install --local creates manifest by default](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/10.0/dotnet-tool-install-local-manifest), for the retired "Cannot find a manifest file." error and the `--create-manifest-if-needed=false` opt-out.
- [What's new in the SDK and tooling for .NET 10](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/sdk), for one-shot execution with `dotnet tool exec` and the `dnx` script.
- [Troubleshoot .NET tool usage issues](https://learn.microsoft.com/en-us/dotnet/core/tools/troubleshoot-usage-issues), for the PATH and shim diagnostics.
