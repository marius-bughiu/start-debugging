---
title: ".NET 10 file-based apps just got multi-file scripts: `#:include` is landing"
description: ".NET 10 adds #:include support for file-based apps, letting dotnet run scripts span multiple .cs files without creating a full project."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
---
The .NET 10 “file-based apps” story keeps getting more practical. A new SDK pull request adds support for `#:include`, which means `dotnet run foo.cs` no longer has to be “one file or nothing”.

This is tracked in the SDK as “File-based apps: add support for `#:include`” and it’s meant to solve the obvious scripting use case: split code into a main script plus helpers without creating a full project.

## Why multi-file matters for `dotnet run file.cs`

The pain is simple. If your script grows beyond a single file, you either:

-   Copy/paste helpers into the same file (unreadable fast), or
-   Give up and create a full project (kills the “quick script” workflow).

The desired behavior is spelled out in the SDK issue: `dotnet run file.cs` should be able to use code from an adjacent `util.cs` without extra ceremony.

## What `#:include` changes

With `#:include`, the main file can pull in other `.cs` files so the compiler sees a single compilation unit for the run. It’s the missing bridge between “script feel” and “real code organization”.

This is not a C# language feature; it's a .NET SDK capability for file-based apps. That matters because it can evolve quickly in .NET 10 previews without waiting for a language version.

## A tiny multi-file script you can actually run

Directory:

```bash
app\
  file.cs
  util.cs
```

`file.cs`:

```cs
#:include "util.cs"

Console.WriteLine(Util.GetMessage());
```

`util.cs`:

```cs
static class Util
{
    public static string GetMessage() => ".NET 10 file-based apps can include files now.";
}
```

Run it with a .NET 10 preview SDK:

```bash
dotnet run app/file.cs
```

## Two real-world details to watch

### Caching can hide changes

File-based apps rely on caching to keep inner-loop runs fast. If you suspect you’re seeing stale output, rerun with `--no-cache` to force a rebuild.

### Non-`.cs` items can complicate the “fast path”

If you’re doing file-based apps with Web SDK bits (for example `.razor` or `.cshtml`), there’s an open issue around cache invalidation when non-`.cs` default items change. Keep that in mind before you treat file-based apps as a replacement for a real app project.

If you want to track the exact rollout, start here:

-   PR: [https://github.com/dotnet/sdk/pull/52347](https://github.com/dotnet/sdk/pull/52347)
-   Multi-file scenario issue: [https://github.com/dotnet/sdk/issues/48174](https://github.com/dotnet/sdk/issues/48174)
