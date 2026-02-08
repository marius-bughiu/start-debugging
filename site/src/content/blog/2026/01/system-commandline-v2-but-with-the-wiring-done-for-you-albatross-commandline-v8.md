---
title: "System.CommandLine v2, but with the wiring done for you: `Albatross.CommandLine` v8"
description: "System.CommandLine v2 shipped with a much cleaner focus: parsing first, a simplified execution pipeline, fewer “magic” behaviors. That’s great, but most real CLIs still end up with repetitive plumbing: DI setup, handler binding, shared options, cancellation, and hosting. Albatross.CommandLine v8 is a fresh take on that exact gap. It builds on System.CommandLine v2 and adds…"
pubDate: 2026-01-10
tags:
  - "net"
  - "net-10"
  - "net-9"
---
System.CommandLine v2 shipped with a much cleaner focus: parsing first, a simplified execution pipeline, fewer “magic” behaviors. That’s great, but most real CLIs still end up with repetitive plumbing: DI setup, handler binding, shared options, cancellation, and hosting.

`Albatross.CommandLine` v8 is a fresh take on that exact gap. It builds on System.CommandLine v2 and adds a source generator and a hosting layer, so you can define commands declaratively and keep the glue code out of your way.

## The value proposition: fewer moving parts, more structure

The author’s pitch is specific:

-   Minimal boilerplate: define commands with attributes, generate the wiring
-   DI-first composition: services per command, inject anything
-   Async + shutdown handling: CancellationToken and Ctrl+C out of the box
-   Still customizable: you can reach down to System.CommandLine objects when you need to

That combination is the sweet spot for .NET 9 and .NET 10 CLI apps that want “boring” infrastructure without taking a full framework dependency.

## A minimal host that stays readable

Here’s the shape (simplified from the announcement):

```cs
// Program.cs (.NET 9 or .NET 10)
using Albatross.CommandLine;
using Microsoft.Extensions.DependencyInjection;
using System.CommandLine.Parsing;

await using var host = new CommandHost("Sample CLI")
    .RegisterServices(RegisterServices)
    .AddCommands() // generated
    .Parse(args)
    .Build();

return await host.InvokeAsync();

static void RegisterServices(ParseResult result, IServiceCollection services)
{
    services.RegisterCommands(); // generated registrations

    // Your app services
    services.AddSingleton<ITimeProvider, SystemTimeProvider>();
}

public interface ITimeProvider { DateTimeOffset Now { get; } }
public sealed class SystemTimeProvider : ITimeProvider { public DateTimeOffset Now => DateTimeOffset.UtcNow; }
```

The important part is not “look, a host”. It’s that the host becomes a predictable entry point where you can test the handler layer and keep command definitions separate from service wiring.

## Where it fits, and where it doesn’t

This is a good match if:

-   You have more than 3 to 5 commands and shared options are starting to spread
-   You want DI in your CLI, but you don’t want to hand-wire handlers for every command
-   You care about graceful shutdown because your CLI does real work (network, filesystem, long I/O)

It’s probably not worth it if:

-   You’re shipping a single-command utility
-   You need exotic parsing behavior and expect to live in System.CommandLine internals

If you want to evaluate it quickly, these are the best starting points:

-   Docs: [https://rushuiguan.github.io/commandline/](https://rushuiguan.github.io/commandline/)
-   Source: [https://github.com/rushuiguan/commandline](https://github.com/rushuiguan/commandline)
-   Reddit announcement: [https://www.reddit.com/r/dotnet/comments/1q800bs/updated\_albatrosscommandline\_library\_for/](https://www.reddit.com/r/dotnet/comments/1q800bs/updated_albatrosscommandline_library_for/)
