---
title: ".NET 11 Runtime Async Drops the EnablePreviewFeatures Flag"
description: "As the .NET 11 previews progress toward the November release, Runtime Async has graduated: net11.0 projects opt in with a single MSBuild property, and the runtime libraries themselves now ship compiled on it."
pubDate: 2026-07-11
tags:
  - "dotnet-11"
  - "csharp"
  - "async"
  - "performance"
---

When Runtime Async first landed in .NET 11 Preview 2, turning it on meant two MSBuild properties and an explicit acknowledgement that you were living on the edge. As the previews have marched toward the November 2026 release (Preview 6 shipped July 10), that gate has quietly come down. Runtime Async is still a preview feature, but a `net11.0` project no longer needs `<EnablePreviewFeatures>true</EnablePreviewFeatures>` to use it, and the .NET runtime libraries themselves now ship compiled on it.

## One property instead of two

If you followed the [original Runtime Async writeup](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), your `.csproj` looked like this:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

The current opt-in is just the compiler flag:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
</PropertyGroup>
```

`EnablePreviewFeatures` pulled in the whole `System.Runtime.Experimental` analyzer surface and flagged your project as opting into every preview API in the SDK. Dropping it means you can try runtime-native async without accidentally green-lighting unrelated experimental features across the assembly.

## The BCL now dogfoods it

The bigger signal is that the .NET runtime libraries are compiled with `runtime-async=on`. They no longer contain compiler-generated state machines and rely entirely on runtime-provided async. Every `await` you make into `System.Net.Http`, `System.IO`, or `System.Text.Json` is already running on the new model. That gives the feature broad functional and performance validation before it becomes the default, and it means an app whose only async dependencies are framework libraries is effectively already migrated.

## Switches that changed underneath you

If you had scripts or launch profiles poking at the old environment variables, they are gone. The `DOTNET_RuntimeAsync` and `UNSUPPORTED_RuntimeAsync` variables that used to toggle the behavior have been removed. To opt a specific project out now, set a project property instead:

```xml
<PropertyGroup>
  <UseRuntimeAsync>false</UseRuntimeAsync>
</PropertyGroup>
```

## Wider compilation coverage

Two fixes broaden where Runtime Async actually applies. Covariant `Task` to `Task<T>` overrides now work: when a derived class returns `Task<T>` for a base method typed as `Task`, the runtime generates a void-returning thunk to bridge the calling convention, so virtual dispatch behaves for both flavors, including under NativeAOT. And the restriction that blocked runtime-async methods from being inlined during ReadyToRun (crossgen2) compilation has been lifted, so the synchronous fast path of an await-less async method can be inlined end to end.

None of this makes Runtime Async the production default yet. But the friction to try it on a real .NET 11 codebase is now a single line of MSBuild, and the standard library is already proof that it holds up. The full opt-in details live on the [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) page.
