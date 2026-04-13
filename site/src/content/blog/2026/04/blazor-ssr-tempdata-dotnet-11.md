---
title: "Blazor SSR Finally Gets TempData in .NET 11"
description: "ASP.NET Core in .NET 11 Preview 2 brings TempData to Blazor static server-side rendering, enabling flash messages and Post-Redirect-Get flows without workarounds."
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
---

If you have built Blazor static SSR apps, you have almost certainly hit the same wall: after a form POST that redirects, there is no built-in way to pass a one-time message to the next page. MVC and Razor Pages had `TempData` for over a decade. Blazor SSR did not, until [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/).

## How TempData works in Blazor SSR

When you call `AddRazorComponents()` in your `Program.cs`, TempData is registered automatically. No extra service wiring. Inside any static SSR component, grab it as a cascading parameter:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private void HandleSubmit()
    {
        // Store a flash message before redirecting
        TempData?.Set("StatusMessage", "Record saved.");
        Navigation.NavigateTo("/dashboard", forceLoad: true);
    }
}
```

On the target page, read the value. Once you call `Get`, the entry is removed from the store:

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private string? StatusMessage;

    protected override void OnInitialized()
    {
        StatusMessage = TempData?.Get<string>("StatusMessage");
    }
}
```

That is the classic Post-Redirect-Get pattern, and it now works in Blazor SSR with no custom state management.

## Peek and Keep

`ITempData` provides four methods that mirror the MVC TempData lifecycle:

- `Get<T>(key)` reads the value and marks it for deletion.
- `Peek<T>(key)` reads without marking, so the value survives to the next request.
- `Keep()` retains all values.
- `Keep(key)` retains a specific value.

These give you control over whether a flash message disappears after one read or sticks around for a second redirect.

## Storage providers

By default, TempData is cookie-based via `CookieTempDataProvider`. Values are encrypted with ASP.NET Core Data Protection, so you get tamper protection out of the box. If you prefer server-side storage, swap in `SessionStorageTempDataProvider`:

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## The catch: static SSR only

TempData does not work with interactive Blazor Server or Blazor WebAssembly render modes. It is scoped to static SSR, where each navigation is a full HTTP request. For interactive scenarios, `PersistentComponentState` or your own cascading state remain the right tools.

This is a small addition, but it removes one of the common "why can't Blazor do what Razor Pages can?" complaints. Grab [.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) and try it in your next SSR form flow.
