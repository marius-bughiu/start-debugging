---
title: "Blazor static SSR gets [SupplyParameterFromSession] in .NET 11 Preview 5"
description: "Reading session state in static server-rendered Blazor meant reaching into HttpContext.Session and serializing by hand. .NET 11 Preview 5 adds [SupplyParameterFromSession] so a component property binds to a session key directly."
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), which shipped on 2026-06-09, rounds out the family of "supply parameter from X" attributes that Blazor static server-side rendering (static SSR) already had for query strings and form data. The new one is `[SupplyParameterFromSession]`, and it binds a component property to a key in ASP.NET Core's server session. If you have ever carried a multi-step wizard's state across static SSR page loads, you know why this matters.

## Why session was the awkward one

Static SSR renders plain HTML with no SignalR circuit and no WebAssembly payload, so there is no in-memory component state that survives a navigation. Blazor already gave you typed, declarative access to the two obvious per-request inputs: `[SupplyParameterFromQuery]` for the URL and `[SupplyParameterFromForm]` for a POST body. Session was the gap. To read it you cascaded the `HttpContext` into the component and went through `HttpContext.Session` yourself, with manual key strings and manual serialization on both sides:

```csharp
@inject IHttpContextAccessor Http

@code {
    private int CurrentStep;

    protected override void OnInitialized()
    {
        var raw = Http.HttpContext?.Session.GetString("checkout-step");
        CurrentStep = raw is null ? 0 : JsonSerializer.Deserialize<int>(raw);
    }
}
```

Every component that touched session repeated that ceremony, and the key string was a stringly-typed contract waiting to drift.

## What the attribute replaces

Preview 5 collapses the read into a property declaration. The attribute takes a `Name` for the session key and uses `System.Text.Json` to serialize and deserialize the value, so it works for any JSON-round-trippable type, not just strings:

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

The framework reads `checkout-step` out of the session, deserializes it into `int`, and assigns it before the component renders. Assigning back to the property writes the new value into the session, so a wizard can advance its step in one line instead of a get, mutate, serialize, set dance.

The plumbing is the standard ASP.NET Core session middleware, so you still wire it up in `Program.cs`:

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## Where it fits

This is one of several static SSR sharpening passes in Preview 5. It pairs naturally with [client-side validation for static SSR forms](/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/), which landed in the same release: bind the form's working state to a session key, validate in the browser, and keep the cheap render mode the whole way through a checkout flow. QuickGrid sorting and pagination now run in static SSR too, so the pattern of "interactive feel, zero circuit" keeps widening.

To try it, install the .NET 11 Preview 5 SDK, target `net11.0`, and check the [ASP.NET Core Preview 5 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md) for the full list.
