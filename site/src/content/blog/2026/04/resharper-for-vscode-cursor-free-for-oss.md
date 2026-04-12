---
title: "ReSharper Lands in VS Code and Cursor, Free for Non-Commercial Use"
description: "JetBrains shipped ReSharper as a VS Code extension with full C# analysis, refactoring, and unit testing. It works in Cursor and Google Antigravity too, and costs nothing for OSS and learning."
pubDate: 2026-04-12
tags:
  - "ReSharper"
  - "VS Code"
  - "C#"
  - "Tooling"
---

For years, ReSharper meant one thing: a Visual Studio extension. If you wanted JetBrains-grade C# analysis outside of Visual Studio, Rider was the answer. That changed on March 5, 2026, when JetBrains [released ReSharper for Visual Studio Code](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/), Cursor, and Google Antigravity. The [2026.1 release](https://blog.jetbrains.com/dotnet/2026/03/30/resharper-2026-1-released/) on March 30 followed up with performance monitoring and tighter integration.

## What you get

The extension brings the core ReSharper experience into any editor that speaks the VS Code extension API:

- **Code analysis** for C#, XAML, Razor, and Blazor with the same inspection database ReSharper uses in Visual Studio
- **Solution-wide refactoring**: rename, extract method, move type, inline variable, and the rest of the catalog
- **Navigation** including go-to-definition into decompiled source code
- **A Solution Explorer** that handles projects, NuGet packages, and source generators
- **Unit testing** for NUnit, xUnit.net, and MSTest with inline run/debug controls

After you install the extension and open a folder, ReSharper detects `.sln`, `.slnx`, `.slnf`, or standalone `.csproj` files automatically. No manual configuration needed.

## The licensing angle

JetBrains made this free for non-commercial use. That covers open-source contributions, learning, content creation, and hobby projects. Commercial teams need a ReSharper or dotUltimate license, the same one that covers the Visual Studio extension.

## A quick test drive

Install from the VS Code Marketplace, then open any C# solution:

```bash
code my-project/
```

ReSharper indexes the solution and starts surfacing inspections immediately. Try the Command Palette (`Ctrl+Shift+P`) and type "ReSharper" to see available actions, or right-click any symbol for the refactoring menu.

A quick way to verify it is working:

```csharp
// ReSharper will flag this with "Use collection expression" in C# 12+
var items = new List<string> { "a", "b", "c" };
```

If you see the suggestion to convert to `["a", "b", "c"]`, the analysis engine is running.

## Who this is for

Cursor users writing C# now get first-class analysis without leaving their AI-native editor. VS Code users who avoided Rider because of cost or preference get the same inspection depth ReSharper has offered Visual Studio users for two decades. And OSS maintainers get it all for free.

The [full announcement post](https://blog.jetbrains.com/dotnet/2026/03/05/resharper-for-visual-studio-code-cursor-and-compatible-editors-is-out/) covers installation details and known limitations.
