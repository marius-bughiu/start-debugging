---
title: ".NET 11 Runtime Async Replaces State Machines with Cleaner Stack Traces"
description: "Runtime Async in .NET 11 moves async/await handling from compiler-generated state machines into the runtime itself, producing readable stack traces, correct breakpoints, and fewer heap allocations."
pubDate: 2026-04-06
tags:
  - ".NET 11"
  - "csharp"
  - "async"
  - "performance"
  - "debugging"
---

If you have ever stared at an async stack trace in .NET and tried to figure out which method actually threw, you know the pain. The compiler-generated state machine infrastructure turns a simple three-method call chain into a wall of `AsyncMethodBuilderCore`, `MoveNext`, and mangled generic names. .NET 11 Preview 2 ships a preview feature called Runtime Async that fixes this at the deepest level possible: the CLR itself now manages async suspension and resumption instead of the C# compiler.

## How it worked before: state machines everywhere

In .NET 10 and earlier, marking a method `async` tells the C# compiler to rewrite it into a struct or class that implements `IAsyncStateMachine`. Every local variable becomes a field on that generated type, and every `await` is a state transition inside `MoveNext()`. The result is correct, but it has costs:

```csharp
async Task<string> FetchDataAsync(HttpClient client, string url)
{
    var response = await client.GetAsync(url);
    response.EnsureSuccessStatusCode();
    return await response.Content.ReadAsStringAsync();
}
```

When an exception occurs inside `FetchDataAsync`, the stack trace includes frames for `AsyncMethodBuilderCore.Start`, the generated `<FetchDataAsync>d__0.MoveNext()`, and the generic `TaskAwaiter` plumbing. For a chain of three async calls, you can easily see 15+ frames where only three carry meaningful information.

## What Runtime Async changes

With Runtime Async enabled, the compiler no longer emits a full state machine. Instead, it marks the method with metadata that tells the CLR to handle suspension natively. The runtime keeps local variables on the stack and only spills them to the heap when execution actually crosses an `await` boundary that cannot complete synchronously. The practical result: fewer allocations and dramatically shorter stack traces.

A three-method async chain like `OuterAsync -> MiddleAsync -> InnerAsync` produces a stack trace that maps directly to your source:

```
at Program.InnerAsync() in Program.cs:line 24
at Program.MiddleAsync() in Program.cs:line 14
at Program.OuterAsync() in Program.cs:line 8
```

No synthetic `MoveNext`, no `AsyncMethodBuilderCore`, no type-mangled generics. Just methods and line numbers.

## Debugging actually works now

Preview 2 added a critical fix: breakpoints now bind correctly inside runtime-async methods. In Preview 1, the debugger sometimes skipped breakpoints or landed on unexpected lines when stepping through `await` boundaries. With Preview 2, you can set a breakpoint on a line after an `await`, hit it, and inspect locals normally. Stepping over an `await` lands on the next statement, not inside runtime infrastructure.

This also benefits profiling tools and diagnostic logging. Anything that calls `new StackTrace()` or reads `Environment.StackTrace` at runtime now sees the real call chain, which makes structured logging and custom exception handlers more useful without extra filtering.

## Enabling Runtime Async

This is still a preview feature. Opt in by adding two properties to your `.csproj`:

```xml
<PropertyGroup>
  <Features>runtime-async=on</Features>
  <EnablePreviewFeatures>true</EnablePreviewFeatures>
</PropertyGroup>
```

The CLR-side support is enabled by default in .NET 11, so you do not need to set the `DOTNET_RuntimeAsync` environment variable anymore. The compiler flag is the only switch.

## What to watch for

Runtime Async is not yet the default for production code. The .NET team is still working through edge cases with tail calls, certain generic constraints, and interaction with existing diagnostic tooling. If you are already on .NET 11 previews and want to try it in a test project, the two lines of MSBuild above are all you need.

The full Runtime Async details are in the [.NET 11 Preview 2 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview2/runtime.md) and the [What's new in .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) page on Microsoft Learn.
