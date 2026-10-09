---
title: "Semantic Kernel 1.81 Stops FileIOPlugin From Leaking Files Outside AllowedFolders"
description: "Semantic Kernel .NET 1.81.0 fixes a FileIOPlugin oracle: WriteAsync told the model a file outside AllowedFolders existed, was read-only, and where it lived. Measured before and after."
pubDate: 2026-10-09
tags:
  - "dotnet"
  - "semantic-kernel"
  - "ai-agents"
  - "security"
  - "csharp"
---

Semantic Kernel .NET [1.81.0](https://github.com/microsoft/semantic-kernel/releases/tag/dotnet-1.81.0) went out on October 6, 2026, with `Microsoft.SemanticKernel.Plugins.Core` 1.81.0-preview on NuGet the same day. The release notes call [PR #14525](https://github.com/microsoft/semantic-kernel/pull/14525) "Update file handling for FileIOPlugin", which undersells it. Up to 1.80.1, `FileIOPlugin.WriteAsync` checked whether a file was read-only *before* it checked `AllowedFolders`, and the exception it threw included the full canonical path. If you expose this plugin to a model, that is a file existence oracle for the whole disk.

This is the second file and network hardening pass in a row, after [1.80.0 stopped OpenAPI plugins from following redirects](/2026/08/semantic-kernel-1-80-openapi-plugins-stop-following-redirects/).

## What the model could learn on 1.80.1

I ran the same file-based probe against both versions on SDK 10.0.302. It creates a read-only `secrets.txt` outside the allowed folder, a missing `nope.txt` next to it, and a read-only `locked.txt` inside the allowed folder, then calls `WriteAsync` on each:

```csharp
#:package Microsoft.SemanticKernel.Plugins.Core@1.80.1-preview
#:property PublishAot=false
#:property NoWarn=SKEXP0050
using Microsoft.SemanticKernel.Plugins.Core;

// allowed, readOnlyOutside, missingOutside, readOnlyInside: temp paths set up earlier
var plugin = new FileIOPlugin { AllowedFolders = [allowed], DisableFileOverwrite = false };

foreach (var f in new[] { readOnlyOutside, missingOutside, readOnlyInside })
{
    try { await plugin.WriteAsync(f, "y"); }
    catch (Exception e) { Console.WriteLine($"{Path.GetFileName(f)}: {e.GetType().Name}: {e.Message}"); }
}
```

Output on 1.80.1-preview (temp path shortened):

```text
secrets.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/outside/secrets.txt
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only: /private/var/folders/.../skprobe/allowed/locked.txt
```

The first two lines are the problem. A file outside the sandbox gets a different exception than a missing one, so existence is observable. The same happens with a default `new FileIOPlugin()` whose `AllowedFolders` is empty, the configuration documented as "no folders allowed".

That message does reach the model. With auto function calling, `FunctionCallsProcessor` catches the exception and returns `Error: Exception while invoking function. {e.Message}` as the tool result. A prompt-injected agent can probe `~/.ssh/id_rsa` or `/etc/shadow` style paths and read the answer back.

## What 1.81.0 changes

`TryGetAllowedFilePath` now returns `false` immediately when no folders are configured, wraps path canonicalization in a catch for `IOException`, `UnauthorizedAccessException`, `InvalidOperationException`, and `SecurityException` (so symlink loops and permission errors become a plain denial), and only runs the read-only check after the path has matched an allowed folder. The read-only exception also lost the path. Same probe on 1.81.0-preview:

```text
secrets.txt: InvalidOperationException: Writing to the provided location is not allowed.
nope.txt: InvalidOperationException: Writing to the provided location is not allowed.
locked.txt: UnauthorizedAccessException: File is read-only.
```

Outside the sandbox, every case is now indistinguishable. Inside it, you still get a useful error, without the path. [PR #14476](https://github.com/microsoft/semantic-kernel/pull/14476), also in 1.81.0, applies the same validation alignment to `DocumentPlugin` and `CloudDrivePlugin`.

## What to do

Bump `Microsoft.SemanticKernel.Plugins.Core` to `1.81.0-preview` if any agent can call `FileIOPlugin`. The public API is unchanged, so it is a version bump only. If you wrap file tools of your own, steal the pattern: check the sandbox first, make every denial return the same message, and never put a resolved path in an exception that a tool result might carry back to the model.
