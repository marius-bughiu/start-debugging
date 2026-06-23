---
title: ".NET 11 Preview 5 lets file-based apps reference each other with `#:ref`"
description: ".NET 11 Preview 5 adds the #:ref directive so a dotnet run script can reference another file-based app as a library, with transitive references and no project file."
pubDate: 2026-06-23
tags:
  - "dotnet"
  - "dotnet-11"
---
File-based apps started as a way to run a single `.cs` file with `dotnet run` and no project. In [.NET 10 they learned `#:include`](/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/), which pulls extra files into one compilation. [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) goes a step further: the new `#:ref` directive lets one file-based app reference another file-based app as a *library*, and transitive references are supported. No `.csproj` required.

## How `#:ref` differs from `#:include`

The distinction is real, not cosmetic. `#:include` merges another file into the same compilation unit, so everything ends up in one assembly. `#:ref` treats the target as a separate library and references it, the same way a `ProjectReference` would, except there is no project on either side.

That means `#:ref` gives you an actual boundary. The referenced file compiles on its own, exposes its public types, and the consumer links against it. You get reuse across scripts without copy-pasting helpers or scaffolding a class library.

## A two-file example you can run

Put a small library in `lib.cs`:

```csharp
// lib.cs
namespace MyLib;

public static class Greeter
{
    public static string Greet(string name) => $"Hello, {name}!";
}
```

Reference it from `app.cs`:

```csharp
// app.cs
#:ref lib.cs

Console.WriteLine(MyLib.Greeter.Greet("World"));
```

Run it with a .NET 11 Preview 5 SDK:

```bash
dotnet run app.cs
```

If `lib.cs` itself carries a `#:ref` to a third file, that reference flows through. Transitive references are resolved, so you can compose a small graph of scripts the way you would compose a small graph of projects.

## The directives are no longer gated

The other piece of news in Preview 5 is that the file-based app directives `#:include`, `#:exclude`, and `#:project` no longer require a feature flag, and directives inside included files are now processed transitively. So `#:include` can reach through nested files, and `#:project` can point a script at a real `.csproj` when you outgrow the script-only setup.

That gives you a gradient instead of a cliff. Start with one file. Split helpers out with `#:include`. Promote a helper to a reusable library with `#:ref`. Pull in a full project with `#:project` once the thing stops being a script. Each step is one directive line, and none of them forces you to stop using `dotnet run`.

## Where this fits

`#:ref` is aimed at the same audience as the rest of the file-based app work: tooling scripts, samples, reproductions, and the kind of glue code that never deserved a solution file. The new boundary makes those scripts shareable without dragging in MSBuild ceremony. It is a preview feature, so try it on a .NET 11 Preview 5 SDK and read the [SDK release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) for the exact behavior before you lean on it.
