---
title: "WebApplication.CreateBuilder vs CreateSlimBuilder vs CreateEmptyBuilder in ASP.NET Core 11"
description: "Use CreateBuilder for a normal app, CreateSlimBuilder when you publish trimmed or Native AOT behind a TLS proxy, and CreateEmptyBuilder only when you want to register every service yourself. Here is the feature matrix and the gotchas that force the call."
pubDate: 2026-07-23
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "native-aot"
  - "csharp"
---

For a normal ASP.NET Core 11 web app, use `WebApplication.CreateBuilder(args)`. It is the default for a reason: it wires up every hosting feature you expect. Switch to `WebApplication.CreateSlimBuilder(args)` only when you publish with trimming or Native AOT and you run behind a TLS-terminating proxy, because it drops HTTPS, HTTP/3, IIS integration, static web assets, and two logging providers to shrink the binary. Reach for `WebApplication.CreateEmptyBuilder(...)` only in the rare case where you want a near-zero baseline and will register the server, routing, and configuration yourself. This post targets .NET 11 (Preview 6 at the time of writing, GA in November 2026) with `Microsoft.NET.Sdk.Web` and C# 14, but all three factory methods have existed since .NET 8, so the guidance holds on .NET 8 through 11 unchanged.

## What "defaults" actually means here

The three methods differ in exactly one thing: how much they register into the `WebApplicationBuilder` before your code runs. Everything else, the `builder.Services` collection, `builder.Build()`, `app.MapGet(...)`, is identical. So the whole decision comes down to which defaults you want handed to you versus which you are willing to add back by hand.

`CreateBuilder` gives you the full default host. `CreateSlimBuilder` gives you a curated subset chosen to be trim-safe and small. `CreateEmptyBuilder` gives you almost nothing and expects you to opt in to each piece. Internally they even share machinery: `CreateSlimBuilder` is built on the same empty host application builder that `CreateEmptyBuilder` exposes, then re-adds the slim set of services on top. That is why the ordering below is a strict superset chain, `CreateBuilder` includes everything `CreateSlimBuilder` does, which includes everything `CreateEmptyBuilder` does.

## Feature matrix

Every row is verified against the ASP.NET Core 11 docs and the `WebApplication.cs` source. "Manual" means the feature is not registered for you but you can add it with the call shown.

| Feature                                    | CreateBuilder | CreateSlimBuilder             | CreateEmptyBuilder            |
| ------------------------------------------ | ------------- | ----------------------------- | ----------------------------- |
| appsettings.json + appsettings.{env}.json  | yes           | yes                           | manual                        |
| User secrets (Development)                 | yes           | yes                           | manual                        |
| Environment variable + command-line config | yes           | yes                           | manual                        |
| Console logging                            | yes           | yes                           | manual (`AddConsole`)         |
| Debug / EventSource / EventLog logging     | yes           | no                            | no                            |
| Kestrel server                             | full          | core (`UseKestrelCore`)       | manual (`UseKestrelCore`)     |
| HTTPS endpoints in Kestrel                 | yes           | no (`UseKestrelHttpsConfiguration`) | manual                  |
| HTTP/3 (QUIC)                              | yes           | no (`UseQuic`)                | manual                        |
| IIS integration                            | yes           | no                            | no                            |
| Static web assets                          | yes           | no                            | no                            |
| Hosting startup assemblies / `UseStartup`  | yes           | no                            | no                            |
| Regex and alpha routing constraints        | yes           | no                            | no                            |
| Routing / `MapGet` etc.                    | yes           | yes                           | manual                        |

The single most important takeaway from that table: `CreateSlimBuilder` still keeps your configuration sources and console logging. It is not stripping away the things you use every day. It removes protocol and platform features that a cloud-native, proxy-fronted deployment usually does not need, plus three logging providers you rarely read in production.

## When to pick CreateBuilder

This is the default, and for most apps it should stay the default.

- **You deploy to IIS or IIS Express, or you run on Windows and read the Windows EventLog.** Both are only wired up by `CreateBuilder`. `CreateSlimBuilder` has no IIS integration, so an in-process IIS deployment simply will not host correctly.
- **You serve static web assets from Razor Class Libraries or use `UseStaticWebAssets`.** Blazor and MVC UI apps depend on this. The slim builder does not register it, and the failure mode is missing CSS/JS with no obvious error.
- **You use `{id:regex(...)}` or `{name:alpha}` route constraints.** These are omitted from the slim builder to save roughly a megabyte of binary. `{id:int}` and other primitive constraints are fine; regex and alpha are the two that disappear.
- **You are not publishing trimmed or AOT at all.** If you ship a normal framework-dependent or self-contained JIT build, the slim builder buys you almost nothing at runtime. The binary-size and startup wins come from trimming and AOT, not from the builder choice on its own. Picking slim here just means re-adding HTTPS and friends for no payoff.

## When to pick CreateSlimBuilder

`CreateSlimBuilder` was introduced in .NET 8 specifically to be the default for the Native AOT Web API template (`dotnet new webapiaot`). Pick it when the following describe your deployment.

- **You publish with `<PublishAot>true</PublishAot>` or aggressive trimming (`<PublishTrimmed>true</PublishTrimmed>`).** The slim builder avoids pulling trim-unfriendly code paths into the graph, which keeps warnings down and the output small. See [how to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) for the full AOT setup this builder is designed for.
- **You run behind a TLS-terminating proxy or ingress (Nginx, Caddy, YARP, Azure Application Gateway).** The proxy handles HTTPS, so your process listening on plain HTTP is exactly right. This is the assumption the slim builder bakes in by dropping Kestrel's HTTPS configuration.
- **You want the smallest reasonable container image for a minimal API microservice.** Combined with trimming and AOT, the slim builder produces a single small native executable with a tiny attack surface.

If you pick slim and later discover you do need HTTPS or HTTP/3, you do not have to switch builders. Add them back explicitly:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateSlimBuilder(args);

// Re-enable HTTPS endpoints that CreateSlimBuilder omits by default.
builder.WebHost.UseKestrelHttpsConfiguration();

// Re-enable HTTP/3 (QUIC) if a client actually needs it.
builder.WebHost.UseQuic();

var app = builder.Build();
app.MapGet("/", () => "Hello from a slim host");
app.Run();
```

## When to pick CreateEmptyBuilder

`CreateEmptyBuilder(WebApplicationOptions)` creates a builder with no built-in behavior at all. The app it builds contains only the services and middleware you explicitly configure. This is a specialist tool, not a general default. Reach for it when you are building the smallest possible service and you want to control every registration, or when you are experimenting with exactly how little ASP.NET Core needs to serve a request.

Here is the canonical minimal example from the .NET 8 release notes, which still compiles unchanged on .NET 11:

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateEmptyBuilder(new WebApplicationOptions());

// Nothing is registered by default, so add the server yourself.
builder.WebHost.UseKestrelCore();

var app = builder.Build();

app.Use(async (context, next) =>
{
    await context.Response.WriteAsync("Hello, World!");
    await next(context);
});

Console.WriteLine("Running...");
app.Run();
```

Note what is missing and would have to be added by hand if you needed it: there is no `appsettings.json` loading, no console logging, no routing (so no `MapGet`; you write raw middleware instead), and no configuration binding. You add each with an explicit call: `builder.Configuration.AddJsonFile("appsettings.json")`, `builder.Logging.AddConsole()`, `builder.Services.AddRouting()`, and so on. That is the entire point of the empty builder: you pay for exactly what you use.

## The size story, and why it is a trimming story

The reason all three exist is binary size and startup for Native AOT, not raw request throughput. For a JIT-compiled app, the three builders register different service graphs, but once the app is warm the difference in requests-per-second is not where the value is. The value shows up when you trim and AOT-compile.

Microsoft's own benchmark for the Native AOT Web API template compares a Native AOT publish against a trimmed runtime build and an untrimmed runtime build, and reports that the AOT app has the lowest app size, memory use, and startup time of the three. The .NET 8 release notes give a concrete anchor for the empty end of the spectrum: the `CreateEmptyBuilder` "Hello, World" sample above, published with Native AOT on a linux-x64 machine, produced a self-contained native executable of about 8.5 MB. That figure is what a near-zero baseline looks like once AOT and trimming do their work.

The practical ordering, largest to smallest published footprint, is `CreateBuilder` then `CreateSlimBuilder` then `CreateEmptyBuilder`. But the gap between them only opens up under `PublishAot` or `PublishTrimmed`. Ship a plain build and you have paid the ceremony of the slim or empty builder without collecting the reward. That is the single most common mistake: choosing the slim builder for a normal deployment because "slim sounds faster." It is not faster at runtime; it is smaller when trimmed. If you are not trimming, [what Native AOT actually costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) is worth reading before you commit to the slim path, and [Native AOT vs ReadyToRun vs JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) covers where each publish mode wins.

## The gotcha that picks for you

Preference rarely decides this. One of these usually does.

- **IIS in-process hosting forces `CreateBuilder`.** No IIS integration means no in-process module. If your host is IIS, the decision is made.
- **Static web assets force `CreateBuilder`.** A Blazor or Razor UI app that loses `UseStaticWebAssets` ships broken styling with no exception at startup. This one bites quietly, so treat any UI app as a `CreateBuilder` app unless you have a specific reason not to.
- **Regex or alpha route constraints force `CreateBuilder`.** If your routing table has `{code:regex(^[A-Z]{3}$)}` or `{slug:alpha}`, the slim builder will not resolve those constraints. Primitive constraints like `:int`, `:guid`, and `:datetime` are unaffected.
- **AOT plus a TLS proxy forces `CreateSlimBuilder`.** If you are publishing AOT for a proxy-fronted microservice, slim is the intended default, and fighting it by starting from `CreateBuilder` pulls trim-unfriendly code back into the graph.
- **MVC controllers rule out AOT entirely, which changes the whole question.** MVC is not Native-AOT-compatible, so if you need controllers you are not going full AOT anyway, and the slim builder's main advantage evaporates. See [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) if you are still weighing that choice.

## The call, restated

Default to `CreateBuilder`. It is the right choice for the overwhelming majority of ASP.NET Core 11 apps, including every app that uses IIS, static web assets, MVC, Blazor, or regex route constraints. Move to `CreateSlimBuilder` when, and only when, you publish trimmed or Native AOT and you sit behind a TLS-terminating proxy, which is the exact scenario the `webapiaot` template targets; re-add HTTPS or HTTP/3 with a single `UseKestrelHttpsConfiguration()` or `UseQuic()` call if you need them. Keep `CreateEmptyBuilder` in your back pocket for the genuinely minimal service where you want to register every last piece yourself and measure the floor. The one thing not to do is pick the slim or empty builder for a normal JIT deployment on the theory that it is faster. It is smaller when trimmed, not faster when running, and on a normal build you get the friction without the payoff. If you are migrating an older host onto this model in the first place, the [migration from IWebHostBuilder to WebApplication.CreateBuilder](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/) is the gate to cross before you optimize which factory method you call.

## Related

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Migrate from IWebHostBuilder to WebApplication.CreateBuilder in .NET 11](/2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [WebApplication.CreateSlimBuilder Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.builder.webapplication.createslimbuilder)
- [ASP.NET Core support for Native AOT: Compare CreateSlimBuilder and CreateBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot)
- [What's new in ASP.NET Core in .NET 8: New CreateEmptyBuilder method (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-8.0#new-createemptybuilder-method)
- [Andrew Lock: Comparing WebApplication.CreateBuilder to the new CreateSlimBuilder method](https://andrewlock.net/exploring-the-dotnet-8-preview-comparing-createbuilder-to-the-new-createslimbuilder-method/)
