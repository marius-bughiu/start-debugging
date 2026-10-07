---
title: "C# Dev Kit 11.0 Collapses Six Processes Into One Native AOT Binary"
description: "C# Dev Kit 11.0 pre-release replaces six managed processes with a single Native AOT CSDevKit process and a persistent project cache. A 407-project Aspire solution is ready in 3.0s instead of 84.1s, using 316 MB instead of 2,072 MB."
pubDate: 2026-10-07
tags:
  - "vscode"
  - "csharp"
  - "dotnet-11"
  - "native-aot"
  - "tooling"
---

On October 6, 2026, Drew Noakes published [A faster, lighter C# Dev Kit](https://devblogs.microsoft.com/dotnet/faster-lighter-csharp-dev-kit/) on the .NET Blog. C# Dev Kit jumps from version 3.3 to 11.0, so its numbering now follows .NET 11. The new number comes with a rebuild of how the extension loads solutions in VS Code. If you gave up on VS Code for large C# solutions because the "Loading projects..." spinner never seemed to end, give it another try.

## Six managed processes became one Native AOT binary

C# Dev Kit 3.x ran six separate managed processes. Each one started the runtime and JIT-compiled its own startup code before it could do any work. Version 11.0 merges them into a single `CSDevKit` process compiled with Native AOT, so that startup path no longer loads a runtime or runs the JIT.

The C# language service (Roslyn) still runs in its own process, so the memory figures below are for the Dev Kit side only. Even so, the drop is large:

| Solution | Projects | C# files | 3.3 | 11.0 |
|----------|----------|----------|-----|------|
| Orleans | 155 | 4,010 | 1,307 MB | 208 MB |
| Roslyn | 398 | 18,153 | 2,000 MB | 379 MB |
| Aspire | 407 | 4,686 | 2,072 MB | 316 MB |

That's roughly 81-85% less memory on all three repos.

## A project cache you can commit

The other half of the speedup is a persistent project cache. The first load evaluates your projects and stores the results. Later opens read from the cache and skip the full design-time evaluation. On the Aspire repo, the active file is usable in 0.47s instead of 84.1s, and the whole solution is ready in 3.0s. Orleans takes 0.53s for the active file and 2.3s for the full solution, down from 50.3s.

The blog post also says that if you commit the cache files to version control, fresh clones and new git worktrees get fast tooling immediately. This matters if you run several git worktrees side by side, for example for parallel coding agents. Today, each new worktree costs you another cold project load. The announcement doesn't list the cache file names or what invalidates the cache, so look at what the extension writes into your repo before you change `.gitignore`.

Incremental builds got faster too. A no-op build of the Aspire solution takes 0.88s instead of 34.4s, and a build after changing one file takes 2.1s instead of 36.1s.

## MSBuild files get real IntelliSense

Version 11.0 also adds language support for `.csproj`, `.props`, and `.targets` files: completions, diagnostics, go-to-definition, quick fixes, and semantic highlighting. Package names and versions complete as you type, and CodeLens shows a warning above packages with known vulnerabilities:

```xml
<ItemGroup>
  <!-- package id and version now complete; vulnerable versions get a CodeLens warning -->
  <PackageReference Include="MessagePack" Version="3.1.11" />
</ItemGroup>
```

A new "C# Doctor" view brings SDK, runtime, target framework, restore, and vulnerability checks together in one place. You no longer have to dig through the output channels to find out why a project didn't load.

## Trying the pre-release

Version 11.0 is still a pre-release. In the Extensions view, open C# Dev Kit and choose **Switch to Pre-Release Version**. You can also do it from a terminal:

```bash
code --install-extension ms-dotnettools.csdevkit --pre-release
```

To check the memory numbers on your own solution, look up the consolidated process after the solution loads:

```bash
# macOS / Linux: resident memory in KB
ps -A -o rss,comm | grep -i csdevkit
```

File regressions at [microsoft/vscode-dotnettools](https://github.com/microsoft/vscode-dotnettools). A rewrite of this size will have rough edges in some project layouts, and the team is collecting those reports before the stable release.
