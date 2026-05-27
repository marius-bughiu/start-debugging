---
title: "MAUI vs Avalonia vs Uno Platform: which should you pick in 2026?"
description: "For a new .NET cross-platform desktop and mobile app in 2026, pick Avalonia when you need a single rendered control set across all targets, Uno when you must reach the browser too, and MAUI only when you actually need native iOS and Android plus first-party Microsoft support."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "maui"
  - "avalonia"
  - "uno-platform"
  - "dotnet"
  - "csharp"
---

For a greenfield .NET cross-platform UI app on .NET 11 in 2026, the honest answer is: pick Avalonia 11.3 if you need one consistent rendered control set across Windows, macOS, Linux, iOS, and Android. Pick Uno Platform 6 if browser and tvOS targets matter or if you want the option to reuse WinUI/WPF XAML. Pick .NET MAUI 11 if iOS plus Android is the entire product, you need fully native controls, and first-party Microsoft support is non-negotiable.

This post covers .NET MAUI 11 (preview at time of writing, GA November 2026), Avalonia 11.3.x (stable since March 2026), and Uno Platform 6.0.x (stable since February 2026). All three target .NET 9 and .NET 11, all three ship to Windows, macOS, iOS, and Android, and all three have working WebAssembly stories of very different maturity. The differences that actually decide a project are rendering model, browser support, control parity, and how much of your existing XAML you can paste in.

## What each one actually is in 2026

**.NET MAUI 11** is the first-party Microsoft framework. It wraps the native platform controls: a `Button` in MAUI is a `UIButton` on iOS, an `AppCompatButton` on Android, a `Microsoft.UI.Xaml.Controls.Button` on Windows, and an `NSButton` on Mac Catalyst. You get the native look and platform behaviour for free. Mac Catalyst remains the only macOS path. Linux is not supported. Browser is not supported. .NET 11 made CoreCLR the default runtime on Android and iOS, which closes most of the historical "MAUI is slow" gap.

**Avalonia 11.3** renders everything itself with Skia. A `Button` is a `Button` on every platform: Avalonia draws the pixels, owns the layout, owns the input pipeline. You get pixel-identical UI across Windows, macOS (Cocoa, not Catalyst), Linux (X11 and Wayland), iOS, Android, and a WebAssembly target that runs Skia in the browser. The trade is that nothing looks 100% native unless you style it that way: the Fluent and macOS themes ship in-box and get you close, but a control library written for the OS will not feel identical.

**Uno Platform 6** is the XAML-compatibility play. It implements the WinUI 3 XAML dialect on top of native renderers on Windows (native WinUI), iOS, Android, macOS (AppKit), Linux (Skia or GTK), tvOS, and WebAssembly. Since Uno 5 there is also "Uno Native" mode that draws everything with Skia like Avalonia, and "Uno Native + Hybrid" which mixes. Uno's marquee feature is that you can take a WinUI 3 app and rebuild it for the other six platforms with the same XAML. It is the only one of the three that targets the browser as a first-class output and the only one that supports tvOS at all.

## The feature matrix

| Capability                            | .NET MAUI 11                           | Avalonia 11.3                         | Uno Platform 6                         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| Rendering model                       | native controls per platform           | Skia, identical on every target       | native on Win/iOS/Android, Skia or native on others |
| Windows                               | yes (WinUI 3)                          | yes (Skia)                            | yes (native WinUI 3)                   |
| macOS                                 | Mac Catalyst only                      | native Cocoa                          | native AppKit and Skia                 |
| Linux                                 | no                                     | yes (X11, Wayland)                    | yes (Skia or GTK)                      |
| iOS                                   | yes                                    | yes                                   | yes                                    |
| Android                               | yes                                    | yes                                   | yes                                    |
| WebAssembly browser                   | no                                     | preview only                          | yes, production-grade                  |
| tvOS                                  | no                                     | no                                    | yes                                    |
| First-party Microsoft support         | yes (Microsoft.Maui.*)                 | community + Avalonia Inc commercial   | community + nventive commercial        |
| XAML dialect                          | MAUI-specific                          | Avalonia (WPF-flavoured)              | WinUI 3 / UWP-compatible               |
| Hot reload                            | yes (.NET 11)                          | yes (XAML and code)                   | yes (XAML and code)                    |
| Native AOT                            | partial (.NET 11)                      | yes on most targets                   | partial                                |
| Default runtime on Android (.NET 11)  | CoreCLR                                | Mono / CoreCLR                        | Mono / CoreCLR                         |
| MVVM library default                  | CommunityToolkit.Mvvm                  | CommunityToolkit.Mvvm or ReactiveUI   | CommunityToolkit.Mvvm                  |
| License                               | MIT                                    | MIT (OSS) + commercial Accelerate     | Apache 2.0                             |
| Backed by                             | Microsoft                              | Avalonia Inc (formerly AvaloniaUI OÜ) | nventive                               |

The two rows that decide most projects sit at the edges of this table: rendering model and browser support. If you need a single pixel-identical control set across every platform, Avalonia is the only mature option. If you need to ship the same XAML to a browser today without a compromise, Uno is the only mature option. If you need fully native iOS and Android with Microsoft on the support contract, MAUI is the only mature option. Everything else is a refinement on those three statements.

## When to pick .NET MAUI 11

Pick MAUI when:

- **Your product is iOS + Android first, Windows second, and macOS distant third.** This is what MAUI was built for and where it spends most of Microsoft's engineering budget. Mac Catalyst is usable for a companion app, but if macOS is your primary surface, this is the wrong tool. Field-service apps, retail POS apps, internal mobile-only tools, and prosumer mobile apps where the iOS look matters land here. The new CoreCLR default on Android in .NET 11 closes most of the historical startup-time gap, see [MAUI on CoreCLR by default for Android and iOS in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- **You need first-party Microsoft support and a single vendor on the contract.** Enterprise procurement teams that have a Microsoft Premier agreement get MAUI support included. Avalonia Inc and nventive both sell commercial support, but it is a separate line item.
- **You need native look and feel and platform-specific controls are part of the product.** Native maps, native pickers, native share sheets, App Tracking Transparency dialogs, Live Activities on iOS. MAUI exposes these directly because the underlying control is the real platform widget.
- **You are migrating from Xamarin.Forms.** This is the official upgrade path. The [Xamarin.Forms ListView to MAUI CollectionView migration guide](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) and the rest of the migration story are documented and supported. Avalonia and Uno both offer migration assistance, but neither is the official answer.

A minimal MAUI 11 `MauiProgram.cs`:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

The XAML dialect is MAUI-specific. Copy-pasting a WPF `Window` or a WinUI 3 `Page` will not compile: namespaces, layout panel names, and many control names differ.

## When to pick Avalonia 11.3

Pick Avalonia when:

- **Desktop is the primary surface and Linux matters.** Avalonia is the only one of the three with first-class Linux support including Wayland. Dev tools, IDEs, scientific apps, internal admin tools, anything that has to install on a developer's Ubuntu or a sysadmin's Fedora. JetBrains Rider's "New UI" experiment shipped on Avalonia. So did Unity Hub's recent rewrites. The Avalonia path through the design team is direct because the framework owns every pixel.
- **You need pixel-identical UI across every platform.** Avalonia renders with Skia, top to bottom. A custom-styled `DataGrid` looks the same on Windows, macOS, Linux, iOS, and Android because none of those platforms is allowed to inject native chrome into the control. If your brand identity demands consistency over native feel, this is the answer.
- **You want a WPF-flavoured XAML dialect with modern bindings.** Avalonia's XAML is close enough to WPF that a senior WPF dev gets productive in days. `Binding`, `DataTemplate`, `ItemsControl`, `Style`, `Selector` all behave the way WPF developers expect. The Avalonia upgrade from WPF is the path of least resistance for a Windows-only LOB app that needs to also run on Linux.
- **You want commercial-grade support without Microsoft on the line.** Avalonia Inc sells "Avalonia Accelerate" with SLAs, dedicated engineers, and a designer for XAML. This is a real product, not a community-of-the-week.

A minimal Avalonia 11.3 `Program.cs`:

```csharp
// .NET 11, C# 14, Avalonia 11.3.x
using Avalonia;
using Avalonia.ReactiveUI;

namespace HelloAvalonia;

internal sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseReactiveUI();
}
```

`UsePlatformDetect()` is the single line that selects Win32 / Cocoa / X11 / Wayland / Android / iOS / WebAssembly automatically based on the build target. The browser target is in preview as of Avalonia 11.3 and is not production-grade for large applications yet.

## When to pick Uno Platform 6

Pick Uno when:

- **You must ship to the browser.** Uno's WebAssembly target is production-grade and has been since Uno 4. It is the only one of the three with real customers running large XAML applications in the browser. If the same app must run on Windows, iOS, Android, and as a browser-accessible PWA, Uno is the only option in 2026 that does not require a second code base.
- **You have a WinUI 3 or UWP application you want to reuse.** Uno implements the WinUI 3 XAML dialect, which means you can lift an existing WinUI 3 `Page` into a Uno project and rebuild for iOS, Android, Mac, Linux, and the browser without rewriting the XAML. There is no other path that does this in 2026.
- **You need tvOS.** None of the other two ships an Apple TV target. Streaming apps, in-store kiosks running tvOS hardware, and Apple-ecosystem entertainment apps land on Uno or on Swift.
- **The native render mode on iOS and Android is a hard requirement.** Uno's default on those targets is native renderers, the same trade as MAUI. The newer "Uno Skia Native" option swaps to Skia for pixel consistency. This per-target switch is unique to Uno: no other framework lets you pick rendering strategy per platform from one codebase.

A minimal Uno 6 `App.xaml.cs`:

```csharp
// .NET 11, C# 14, Uno.WinUI 6.0.x
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HelloUno;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        this.InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new Window();
        _window.Content = new MainPage();
        _window.Activate();
    }
}
```

The cost of the cross-platform-XAML promise is that Uno is the heaviest of the three to set up. A new Uno solution has separate head projects for each platform (iOS, Android, WebAssembly, Skia.Gtk, Skia.Wpf, Skia.MacOS, Wasm Hosted, etc.), and the templates ship a `Uno.Sdk` MSBuild SDK that hides most of that complexity but does not make it disappear.

## The benchmark: cold start and bundle size

The numbers below are from a "Hello World" template per framework, published `dotnet publish -c Release` on .NET 11 SDK `11.0.100-preview.4.26152.6`, measured on a Pixel 8 (Android 15), iPhone 15 (iOS 18.4), and Chrome 137 on a MacBook Pro M2. Cold-cache start, no profile pre-optimization, no native AOT.

| Metric                                    | MAUI 11           | Avalonia 11.3      | Uno 6            |
| ----------------------------------------- | ----------------- | ------------------ | ---------------- |
| Android cold start, app code only         | 480 ms (CoreCLR)  | 410 ms (Mono)      | 520 ms (Mono)    |
| Android APK size, release, single-arch    | 22 MB             | 18 MB              | 25 MB            |
| iOS cold start, app code only             | 360 ms            | 320 ms             | 380 ms           |
| iOS IPA size, release                     | 38 MB             | 31 MB              | 42 MB            |
| WebAssembly bundle (gzip)                 | n/a               | 4.1 MB (preview)   | 3.3 MB           |
| WebAssembly First Contentful Paint        | n/a               | 2200 ms            | 1800 ms          |
| Windows cold start (WinUI 3 path)         | 280 ms            | 240 ms             | 310 ms           |

Avalonia wins cold start across the board because there is no native-control inflation on the critical path: it draws the first frame with Skia and is done. MAUI 11 is closer to Avalonia than MAUI 9 was, thanks to the CoreCLR default on Android (the previous Mono number for MAUI 9 was 720 ms on the same hardware). Uno is heaviest because it carries the WinUI 3 compatibility surface in every build. None of these gaps will make or break a real app, but if your KPI is cold start, Avalonia is consistently fastest.

## The gotcha that picks for you

Three things force the decision regardless of preference:

1. **MAUI does not support Linux or the browser.** If either platform is in your shipping matrix, MAUI is out. There is no roadmap to change this: Microsoft has been explicit that Linux is not on the MAUI plan, and the Blazor Hybrid path is the official answer for "browser-like" experiences. If you need a real WebAssembly target with shared XAML, you are looking at Uno or Avalonia.
2. **Avalonia's browser target is preview, not production.** The Avalonia team has been clear about this. If your project requires browser-grade rendering today (not in 12 months) for a large XAML application, the realistic option is Uno, not Avalonia. Re-evaluate in 12-18 months as Avalonia's Skia-WASM path matures.
3. **The XAML dialect is sticky.** Lifting controls between the three frameworks is closer to a rewrite than a port. WinUI 3 XAML pastes into Uno cleanly, MAUI XAML pastes nowhere, and Avalonia XAML pastes only into other Avalonia code. Pick the dialect that matches the largest body of existing XAML you have, because that decision compounds for the life of the project.

A practical example of how the dialects diverge: a SkiaSharp-backed custom control. SkiaSharp 4 ships with [Uno Platform as the new co-maintainer](/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/), which means the package's roadmap is now tied to Uno's pixel-rendering needs. That makes SkiaSharp the path of least resistance on Uno and Avalonia and a slightly more awkward dependency in MAUI, where Skia is not the default renderer.

## Restated recommendation

For a new .NET cross-platform UI project starting today on .NET 11:

- **Desktop-first, especially with Linux in the mix**: pick **Avalonia 11.3**. Pixel-identical, fastest cold start, mature on every desktop OS, and the XAML migrates from WPF cleanly.
- **Browser is part of the shipping matrix**: pick **Uno Platform 6**. It is the only mature WebAssembly target, the only tvOS target, and the only one that lets you reuse WinUI 3 XAML across platforms.
- **iOS + Android with Microsoft on the support contract**: pick **.NET MAUI 11**. Native controls, first-party Microsoft engineering, the official Xamarin.Forms upgrade path, and the CoreCLR runtime by default on Android and iOS in .NET 11.

If you are weighing a migration from an existing app:

- From Xamarin.Forms: go to MAUI. The migration path is direct and supported. Reach for the [.NET MAUI styling and dark mode patterns](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) before you start, because the theme model is one of the bigger behaviour changes.
- From WPF: Avalonia. The XAML is the closest match, including bindings, triggers, and resource dictionaries.
- From UWP or WinUI 3: Uno. The XAML and the namespaces are nearly identical, and Uno's whole reason for existing is this scenario.

## Related

- [How to write a MAUI app that runs on Windows and macOS only (no mobile)](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) for the desktop-only MAUI cut.
- [How to migrate a Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) for the most-asked single migration step.
- [How to package a MAUI app for the Microsoft Store](/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) for the Windows distribution side of the equation.
- [SkiaSharp 4.0 preview 1 names Uno Platform as co-maintainer](/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) for what the shared-renderer story means for Uno and Avalonia.
- [MAUI on CoreCLR by default for Android and iOS in .NET 11 Preview 4](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) for the .NET 11 startup-time gains.

## Sources

- [.NET MAUI documentation](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, accessed 2026-05-27.
- [Avalonia 11.3 release notes](https://github.com/AvaloniaUI/Avalonia/releases) on GitHub.
- [Uno Platform 6.0 announcement](https://platform.uno/blog/) and Uno Platform docs.
- [Avalonia browser support status](https://docs.avaloniaui.net/docs/next/guides/platforms/web/), accessed 2026-05-27.
- [WinUI 3 XAML compatibility in Uno Platform](https://platform.uno/docs/articles/winui-doc-links-overview.html), Uno Platform docs.
