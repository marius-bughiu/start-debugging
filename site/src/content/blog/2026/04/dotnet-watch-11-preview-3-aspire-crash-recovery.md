---
title: "dotnet watch in .NET 11 Preview 3: Aspire hosts, crash recovery, and saner Ctrl+C"
description: "dotnet watch gains Aspire app host integration, automatic relaunch after crashes, and fixed Ctrl+C handling for Windows desktop apps in .NET 11 Preview 3."
pubDate: 2026-04-18
tags:
  - "dotnet"
  - "dotnet-11"
  - "aspire"
  - "dotnet-watch"
---

`dotnet watch` has always been the quiet workhorse of the .NET inner loop. It reloads your app when files change, applies hot reload where it can, and stays out of the way when it cannot. .NET 11 Preview 3 (shipped April 14, 2026) pushes the tool forward on three specific pain points: running distributed apps, surviving crashes, and dealing with Ctrl+C on Windows desktop targets.

## Aspire app hosts now watch cleanly

Until Preview 3, running an Aspire app host under `dotnet watch` was awkward. Aspire orchestrates multiple child projects, and the watcher did not understand that model, so file changes either rebuilt only the host or forced the whole topology to restart from scratch.

Preview 3 wires `dotnet watch` into the Aspire app model directly:

```bash
cd src/MyApp.AppHost
dotnet watch
```

Edit a file in `MyApp.ApiService` and the watcher now applies the change to just that service, keeping the rest of the Aspire topology alive. The dashboard stays up, dependent containers stay running, and you lose seconds of boot time on every change instead of seconds per project.

For microservice-heavy solutions this is the difference between `dotnet watch` being a nice-to-have and being the default way to work.

## Automatic relaunch after a crash

The second headline is crash recovery. Previously, when your watched app threw an unhandled exception and died, `dotnet watch` would park on the crash message and wait for manual restart. If your next keystroke saved a fix, nothing happened until you hit Ctrl+R.

In Preview 3 that behavior flips. Take an endpoint that blows up:

```csharp
app.MapGet("/", () =>
{
    throw new InvalidOperationException("boom");
});
```

Let the app crash once, save a fix, and `dotnet watch` relaunches automatically on the next relevant file change. You do not lose the feedback loop just because the app decided to exit non-zero. The same behavior covers crashes on startup, which used to leave the watcher stuck before hot reload could even attach.

This composes well with the watch-wide "rude edit" handling that already exists: hot reload still tries first, falls back to a restart on unsupported edits, and now falls back to a restart after a crash as well. Three paths, one consistent outcome: the app comes back.

## Ctrl+C on Windows desktop apps

The third fix is small but was chronic: Ctrl+C in `dotnet watch` for WPF and Windows Forms apps. Previously it could leave the desktop process orphaned, detached from the watcher, or hung inside a modal window. Preview 3 re-plumbs the signal handling so Ctrl+C tears down both the watcher and the desktop process in order, with no zombie `dotnet.exe` entries piling up in Task Manager.

If you run a WPF shell under `dotnet watch`:

```bash
dotnet watch run --project src/DesktopShell
```

Hit Ctrl+C once and both the shell and the watcher exit cleanly. It sounds basic, and it is, but the previous behavior was the main reason many teams avoided `dotnet watch` on desktop projects entirely.

## Why these three together matter

Each change on its own is modest. Combined, they shift `dotnet watch` from a per-project helper into a session-wide harness that can host an Aspire topology all day, absorb the occasional crash, and clean up after itself when you are done. The inner loop just got noticeably less fragile.

Release notes are on the [.NET Blog](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) and the SDK section lives at [What's new in the SDK and tooling for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/sdk).
