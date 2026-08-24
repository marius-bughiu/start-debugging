---
title: ".NET MAUI 10.0.100 adds UsePlatformHandler for custom BlazorWebView backends"
description: "MAUI 10.0.100 ships MauiBlazorWebViewBuilderExtensions.UsePlatformHandler, a supported seam for replacing BlazorWebViewHandler without reimplementing everything AddMauiBlazorWebView() registers. Two overloads, one ordering trap."
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
---

.NET MAUI 10.0.100 [shipped on August 20, 2026](https://github.com/dotnet/maui/releases/tag/10.0.100) with 209 commits, and most of it is the usual service-release fare: `CollectionView` scroll regressions, safe-area insets on the Android Shell flyout, an iOS `ActivityIndicator` that refused to disappear. Buried in the list is one genuinely new public API, and it unblocks a category of project that has been stuck since Blazor Hybrid shipped: `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler`.

## Why AddMauiBlazorWebView() was a dead end for custom platforms

`AddMauiBlazorWebView()` does two jobs. It registers the shared plumbing every BlazorWebView needs (JSInterop, navigation, static asset resolution), and it hardcodes `BlazorWebViewHandler` as the handler for `IBlazorWebView`.

The second job was the problem. If you were building a backend for a platform MAUI does not ship handlers for, a GTK renderer for Linux being the motivating case, the built-in handler was simply wrong for you and there was no seam to swap it out. [Issue #34103](https://github.com/dotnet/maui/issues/34103) spells out the workaround people settled on: skip `AddMauiBlazorWebView()` entirely, re-register every internal service by hand, then chase those registrations every time they change upstream.

## The new seam

[PR #34225](https://github.com/dotnet/maui/pull/34225) adds two extension methods on `IMauiBlazorWebViewBuilder`:

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

In `MauiProgram.cs` that collapses the whole workaround to one chained call:

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

Everything `AddMauiBlazorWebView()` registers stays put. Only the handler changes. Internally the method forwards to `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())`, which is the same handler collection the built-in registration writes into.

Note the generic constraint: `where THandler : IViewHandler, new()`. The type parameter is also annotated `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]`, so the trimmer preserves the parameterless constructor in a trimmed or NativeAOT build instead of quietly removing it. Handlers that need constructor arguments go through the factory overload instead.

## Ordering is the sharp edge

Replacement is last-registration-wins, which cuts both ways. Call `UsePlatformHandler` after `AddMauiBlazorWebView()` or it does nothing. More painfully, if a downstream library calls `AddMauiBlazorWebView()` again later in your startup pipeline, that second call re-registers the default handler and your backend vanishes with no error and no warning. When you are composing MAUI Blazor configuration from several sources, call `UsePlatformHandler` last.

The factory overload has a second trap worth knowing. The `IServiceProvider` it hands you is the MAUI handler factory's provider, not the application's root provider. It resolves services registered through `ConfigureMauiHandlers` and nothing else, so reaching for an app-level singleton there will fail.

Both overloads are absent from `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 and present in 10.0.100, so this is a straight 10.0.100 pickup rather than something backported quietly. If you are tracking the .NET MAUI 10 service-release train, the [Material 3 rollout on Android wrapped up back in SR6](/2026/05/maui-10-material-3-android-usematerial3-flag/).
