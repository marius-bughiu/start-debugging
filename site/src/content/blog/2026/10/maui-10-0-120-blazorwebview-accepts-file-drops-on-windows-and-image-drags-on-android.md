---
title: "MAUI 10.0.120: BlazorWebView finally accepts file drops on Windows and image drags on Android"
description: ".NET MAUI 10.0.120 turns on AllowDrop for the Windows BlazorWebView and registers AndroidX DropDataContentProvider on Android, so Blazor Hybrid drop zones work without platform code. Here is what changed, the new MauiEnableAndroidWebViewDragDrop switch, and the MAUI1002 warning."
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
---

[.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) shipped on October 21, 2026 with 213 commits. Most of it is fixes, but two BlazorWebView changes remove a workaround that every Blazor Hybrid app with a "drop your files here" box has carried since .NET 6: dragging a file from Explorer onto a `BlazorWebView` on Windows now reaches your HTML drop target, and dragging images inside a `BlazorWebView` on Android now produces real drag data.

## Windows: AllowDrop is now on by default

Until now, the Windows handler created its WinUI `WebView2` with `AllowDrop` left at `false`. The DOM never saw a `drop` event for files coming from outside the app, so a Blazor drop zone that worked in the browser silently did nothing in the desktop build. The usual fix was a custom handler mapping. [PR #37904](https://github.com/dotnet/maui/pull/37904) changes `BlazorWebViewHandler.CreatePlatformView` to this:

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

That means a plain `InputFile` stretched over a drop area now works on Windows with zero platform code:

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

If you wrote a mapper that set `AllowDrop = true` yourself, you can delete it after upgrading. One limit remains: native in-page element and image dragging on Windows still does not work with MAUI's current Windows App SDK 1.8 dependency. The PR author tested Windows App SDK 2.0.1 and found that those scenarios start working there once `AllowDrop` is on, so this setting is also groundwork for that move.

## Android: DropDataContentProvider is registered for you

On Android, dragging an `<img>` in a `BlazorWebView` fired DOM drag events but carried no usable image data. Android WebView needs AndroidX WebKit's `DropDataContentProvider` declared in the manifest for that. [PR #37975](https://github.com/dotnet/maui/pull/37975) makes `Microsoft.AspNetCore.Components.WebView.Maui` depend on `Xamarin.AndroidX.WebKit` 1.16.0.1 for Android targets and merges this provider into your manifest through an `AndroidManifestOverlay`:

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

If your app already declares the same provider, the two entries merge into one. If you declare it with a different configuration, turn the automatic registration off:

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

That property only controls the manifest entry. The `Xamarin.AndroidX.WebKit` package reference stays either way.

## Watch for MAUI1002

Projects that still set `<AndroidManifestMerger>legacy</AndroidManifestMerger>` will now see warning `MAUI1002`, because the legacy merger ignores `AndroidManifestOverlay` items and the provider never lands in the manifest. Either switch to `manifestmerger.jar` (the default) or set `MauiEnableAndroidWebViewDragDrop` to `false` and declare the provider in `Platforms/Android/AndroidManifest.xml` yourself. If you build with warnings as errors, this is the one line in 10.0.120 that can break your CI.

## Upgrading

Bump `Microsoft.Maui.Controls` and `Microsoft.AspNetCore.Components.WebView.Maui` to `10.0.120`, both already on NuGet. The same release also continues the leak cleanup I covered in [the 10.0.110 post](/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/), including a `BlazorWebView` leak on iOS where `DisconnectHandlers()` never reached pages inside a `Shell`.
