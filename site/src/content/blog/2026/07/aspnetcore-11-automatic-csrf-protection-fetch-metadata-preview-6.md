---
title: "ASP.NET Core 11 Preview 6 turns on automatic CSRF protection"
description: "Preview 6 rejects unsafe cross-origin browser requests by default, reading the Sec-Fetch-Site header instead of an antiforgery token. Here is what it blocks and how to opt out."
pubDate: 2026-07-17
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "security"
  - "csrf"
  - "csharp"
---

[.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/) shipped on 2026-07-15, and the ASP.NET Core change most likely to touch your app is one you do not have to write any code for: cross-site request forgery (CSRF) protection is now on by default, with no configuration, across Minimal APIs, MVC, Razor Pages, and Blazor. It does not rely on the classic antiforgery token. It reads the browser's `Sec-Fetch-Site` header instead.

## Why the token dance was worth replacing

The old model put the burden on you. You emitted an antiforgery token into every form, validated it on POST, and shared Data Protection keys across instances so the token would still decrypt after a load-balancer hop. Miss any of those and you either got a security hole or a runtime error (see [when the antiforgery token could not be decrypted](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)). For APIs that had no server-rendered form to hang a token off, the guidance was murkier still.

Fetch Metadata sidesteps all of that. Modern browsers attach `Sec-Fetch-Site` to every request, and the value cannot be forged by script. Preview 6 inspects it (falling back to the `Origin` header) and records a trust verdict before your endpoint runs.

## What gets allowed and what gets rejected

The rule is narrow on purpose. Same-origin requests, user-initiated navigations (typing a URL, clicking a link), and non-browser clients (a mobile app, `HttpClient`, curl) are all allowed. What gets rejected is the actual CSRF shape: a cross-origin browser request that tries to consume one of your endpoints. Because it is automatic, the Blazor Web App templates no longer call `app.UseAntiforgery()`.

You still keep the opt-outs where you need them. A public webhook posted to by an external service is a non-browser client, so it passes, but if you want to be explicit:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Protected automatically: a cross-origin page cannot POST here from a browser.
app.MapPost("/transfer", (TransferRequest req) => Results.Ok());

// Opt a single endpoint out.
app.MapPost("/webhook", (Payload p) => Results.Ok())
   .DisableAntiforgery();

app.Run();
```

In MVC, the per-action escape hatch is unchanged:

```csharp
[HttpPost]
[IgnoreAntiforgeryToken]
public IActionResult Receive(Payload p) => Ok();
```

To turn the feature off for the whole app, set the `DisableCsrfProtection` configuration key:

```json
{
  "DisableCsrfProtection": true
}
```

If the built-in verdict logic does not fit your topology, register a custom `ICsrfProtection` implementation to replace the trust decision entirely.

## Before you flip the runtime

This API first appeared in Preview 4 and was reshaped in Preview 6 to follow the standard options conventions, so if you tried it earlier, re-check your wiring. And treat it as defense in depth, not a replacement for auth: it stops the cross-origin browser vector, not a stolen bearer token. Full specifics are in the [ASP.NET Core Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md). Install the .NET 11 Preview 6 SDK, target `net11.0`, and audit any endpoint that legitimately expects cross-origin browser POSTs before you ship.
