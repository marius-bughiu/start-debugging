---
title: "MSBuild Server Is On by Default in .NET 11 Preview 7"
description: "Preview 7 flips MSBuild server from opt-in to on by default, so back-to-back dotnet build and dotnet test calls reuse a warm worker process. Here is what changed, how to opt out, and how to prove the server actually engaged."
pubDate: 2026-08-18
tags:
  - "dotnet-11"
  - "msbuild"
  - "dotnet-sdk"
  - "build-performance"
---

.NET 11 Preview 7 shipped on August 11, 2026, and buried in the SDK section is a default flip that changes what happens on every single build you run: MSBuild server is now on unless you explicitly opt out ([dotnet/sdk#55231](https://github.com/dotnet/sdk/pull/55231)).

MSBuild server keeps a warm MSBuild worker process alive between CLI invocations. Without it, every `dotnet build`, `dotnet test`, and `dotnet run` pays for MSBuild process startup, JIT warmup, and SDK resolution from cold. With it, the second invocation and every one after it skips that. The feature has existed behind `MSBUILDUSESERVER` for several releases, and Preview 7 finishes the job by making "on" the default.

## Opting out, and which variable actually wins

Two environment variables turn it off, and they are not equivalent:

```bash
# Either of these keeps the classic single-shot MSBuild behavior
export DOTNET_CLI_USE_MSBUILD_SERVER=false
export MSBUILDUSESERVER=0
```

`DOTNET_CLI_USE_MSBUILD_SERVER=false` is now authoritative. It forwards `MSBUILDUSESERVER=0` down the stack so the server cannot be silently re-enabled by a response file, by `MSBUILDFORCEMULTITHREADED=1`, or by passing `/mt` ([dotnet/sdk#55393](https://github.com/dotnet/sdk/pull/55393)). If you have a CI leg that needs a guaranteed cold process per build, that is the variable to set. Setting only `MSBUILDUSESERVER=0` leaves the door open for something further down to flip it back.

## Why the default moved now

The default did not change on its own. Preview 7 hardened the server because the experimental multithreaded build mode (`-mt`) treats it as a prerequisite, and several long-standing rough edges got fixed in the same release:

- Server GC is now available even with `-nr:false`. Since MSBuild server is the only way to get Server GC, `-mt` now uses a short-lived server that tears itself down right after the build, honoring the no-reuse intent ([dotnet/msbuild#14248](https://github.com/dotnet/msbuild/pull/14248)).
- Nested MSBuild processes no longer deadlock. A build spawned by a task that itself invokes MSBuild can proceed without waiting on the outer coordinator ([dotnet/msbuild#14224](https://github.com/dotnet/msbuild/pull/14224)).
- Unexpected exceptions during the initial connection handshake are caught and reported cleanly instead of aborting the client ([dotnet/msbuild#14292](https://github.com/dotnet/msbuild/pull/14292)).

The payoff shows up most clearly in `-mt` builds, which lean on the warm server for JIT and SDK-resolution state. On the MSBuild performance dashboard, a from-scratch `-t:Rebuild` of the OrchardCore solution averaged 26% faster wall clock with `-mt` on Windows (146.2 s down to 107.8 s) and 23% faster on Linux (118.8 s down to 91.5 s).

## Proving the server engaged

A silent cold start looks identical to a warm one, just slower. Preview 7 adds a structured `MSBuildServerLifecycleEventArgs` build event reporting whether the server was spawned, spawned short-lived, reused, or not used at all, along with the server process ID ([dotnet/msbuild#14156](https://github.com/dotnet/msbuild/pull/14156)). It is logged at low importance, so it lands in binary logs and at diagnostic verbosity without touching normal console output:

```bash
dotnet build -v:diag
# or capture it for later
dotnet build -bl
```

When you need a clean slate, for example after installing a new SDK or changing a global MSBuild property that the warm process cached, shut the server down explicitly rather than hunting for the process:

```bash
dotnet build-server shutdown --msbuild
```

The command is not new, but it becomes a lot more relevant now that a warm server is the default. It belongs on your mental list next to "delete obj and bin" when a build starts behaving strangely.

Full details are in the [.NET 11 Preview 7 SDK release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/sdk.md). If you are working through the rest of Preview 7, [password-protected ZIP archive support](/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) is the other change worth a read.
