---
title: "How to support dark mode correctly in a .NET MAUI app"
description: "End-to-end dark mode in .NET MAUI 11: AppThemeBinding, SetAppThemeColor, RequestedTheme, UserAppTheme override with persistence, the RequestedThemeChanged event, and the per-platform Info.plist and MainActivity bits that the docs gloss over."
pubDate: 2026-05-03
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
---

Short answer: in .NET MAUI 11.0.0, bind every theme-sensitive value with the `AppThemeBinding` markup extension, organize light and dark colors as `StaticResource` keys in `App.xaml`, set `Application.Current.UserAppTheme = AppTheme.Unspecified` on startup so the app follows the OS, and persist any user override through `Preferences`. On Android you also need `ConfigChanges.UiMode` on `MainActivity` so the activity is not destroyed on a system theme switch, on iOS you need either no `UIUserInterfaceStyle` key in `Info.plist` or `Automatic` so the system can hand you both light and dark. Reach for `Application.Current.RequestedThemeChanged` only when you have to mutate something imperatively, because the markup extension already re-evaluates bindings.

This post walks the full surface of system theme support in .NET MAUI 11.0.0 on .NET 11, including the parts that bite in production: persistence across app restarts, the platform `Info.plist` and `MainActivity` configuration, dynamic resource refresh on `Application.Current.UserAppTheme` switches, status-bar and splash-screen colors, and the `RequestedThemeChanged` event that famously stops firing if you forget the manifest flag. Every snippet was verified against `dotnet new maui` from the .NET 11 SDK with `Microsoft.Maui.Controls` 11.0.0.

## What the operating systems actually give you

Dark mode is not a single feature, it is the union of three different behaviors that ship at the OS level and you have to opt into individually:

1. The operating system reports a current theme. iOS 13+ exposes `UITraitCollection.UserInterfaceStyle`, Android 10 (API 29)+ exposes `Configuration.UI_MODE_NIGHT_MASK`, macOS 10.14+ exposes `NSAppearance`, Windows 10+ exposes `UISettings.GetColorValue(UIColorType.Background)` plus the `app-mode` registry key. MAUI normalizes all four into the `Microsoft.Maui.ApplicationModel.AppTheme` enum: `Unspecified`, `Light`, `Dark`.

2. The OS notifies the app when the user flips a switch. On iOS that arrives through `traitCollectionDidChange:`, on Android through `Activity.OnConfigurationChanged` (only if you opt in, more on that below), on Windows through `UISettings.ColorValuesChanged`. MAUI surfaces the union as the static `Application.RequestedThemeChanged` event.

3. The OS lets the app override the rendered theme. iOS uses `UIWindow.OverrideUserInterfaceStyle`, Android uses `AppCompatDelegate.SetDefaultNightMode`, Windows uses `FrameworkElement.RequestedTheme`. MAUI exposes the override as the read/write `Application.Current.UserAppTheme` property.

Dropping any of these layers gets you the "looks fine in the simulator and broken on the user's phone" version of dark mode. The rest of this article is how to wire all three correctly so a MAUI app responds the way the platform conventions expect.

## Define light and dark resources once in App.xaml

The cleanest pattern is to hold every theme-sensitive value as a `StaticResource` in `App.xaml`, then bind through `AppThemeBinding`. Putting the resources at the application scope means every page sees the same palette and you can rename a single key when the design system changes.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` is the markup extension form of the `AppThemeBindingExtension` class in `Microsoft.Maui.Controls.Xaml`. It exposes three values: `Default`, `Light`, `Dark`. The XAML parser treats `Default=` as the content property, so `{AppThemeBinding Red, Light=Green, Dark=Blue}` is legal shorthand for "use red unless the system is light or dark". When the system theme changes, MAUI walks every binding that targets an `AppThemeBindingExtension`, re-evaluates it, and pushes the new value through the bindable property pipeline. You do not write any code to refresh.

For one-off values that do not deserve a resource key, inline the colors:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

For images, the same extension takes file references:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## Apply themes from code-behind

When you build views in C# or modify them after construction, swap the markup extension for the `SetAppThemeColor` and `SetAppTheme<T>` extensions on `VisualElement`. They live in `Microsoft.Maui.Controls` and behave exactly like the markup extension: they store the two values, evaluate the current theme, and re-evaluate on every theme change.

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` is the right call for any non-`Color` value. It works with `FileImageSource`, `Brush`, `Thickness`, and any other type the target property accepts. There is no separate `SetAppThemeBrush` or `SetAppThemeThickness` because the generic version covers them all.

## Detect and override the current theme

`Application.Current.RequestedTheme` returns the resolved `AppTheme` value at any moment, factoring in both the OS and any `UserAppTheme` override. Reach for it sparingly: a single bool stored on a viewmodel that says "are we dark right now" is almost always a sign that you should be using `AppThemeBinding` instead.

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

Overriding the theme is the in-app counterpart. `Application.Current.UserAppTheme` is read/write and accepts the same enum:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

The setter triggers `RequestedThemeChanged`, which means every active `AppThemeBinding` re-evaluates immediately. You do not need to rebuild pages, swap resource dictionaries, or trigger a navigation flush.

The override does not survive an app restart. If you want the user's choice to stick across launches, persist it through `Microsoft.Maui.Storage.Preferences`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

Call `ThemeService.Apply()` from `App.OnStart` (or the `App` constructor right after `InitializeComponent`) so the override is in place before the first window renders. Store the enum as an `int` because `Preferences` does not have a typed overload for arbitrary enums on every platform, and casting through `int` is portable.

## Notify your viewmodels when the theme flips

When you have to react to a theme change in code, for example to swap a custom-drawn `GraphicsView` or to push a different `StatusBar` color, subscribe to `Application.Current.RequestedThemeChanged`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

The event handler runs on the main thread. `AppThemeChangedEventArgs.RequestedTheme` is the new resolved theme, so you do not need to read `Application.Current.RequestedTheme` again inside the handler.

If the event never fires on Android, your `MainActivity` is missing the `UiMode` flag. The default Visual Studio template includes it, but I have seen handcrafted projects miss it during a Xamarin.Forms migration. Add it:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

Without `ConfigChanges.UiMode`, Android destroys and recreates the activity on every system theme change, which means MAUI sees a fresh activity rather than a configuration update, and the `RequestedThemeChanged` event does not fire from the same `Application` instance. The visible symptom is that the first switch works, but subsequent switches do nothing until the app is killed.

## Per-platform setup nobody tells you about

The MAUI surface area is mostly cross-platform, but dark mode has small platform-specific knobs that are easy to miss.

**iOS / Mac Catalyst.** If `Info.plist` contains `UIUserInterfaceStyle` set to `Light` or `Dark`, the OS hard-locks the app to that mode and `Application.RequestedTheme` returns the locked value forever. The default MAUI template omits the key, which means the app follows the system. If you need to opt out explicitly, use `Automatic`:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` is also the right value if a previous developer set the key to `Light` to "fix" something and then forgot. Removing the key entirely has the same effect.

**Android.** Beyond the `ConfigChanges.UiMode` flag, the only thing you must check is that the app theme inherits from a DayNight base in `Platforms/Android/Resources/values/styles.xml`. The default MAUI template uses `Maui.SplashTheme` and `Maui.MainTheme`, both of which extend `Theme.AppCompat.DayNight.NoActionBar`. If you have customized the splash theme, keep the parent on a `DayNight` ancestor or your splash will stay light forever even when the rest of the app goes dark.

For drawables that need a dark variant, drop them in `Resources/values-night/colors.xml` or use the `-night` resource qualifier folders. Anything that flows through `AppThemeBinding` does not need this, but native splash artwork and notification icons do.

**Windows.** No `Package.appxmanifest` change is required. The Windows app host reads the system theme through the `Application.RequestedTheme` property of the WinUI app, and MAUI's `AppThemeBinding` plumbing routes through it automatically. If you find a Windows-only surface that does not refresh, you can force it by setting `MauiWinUIApplication.Current.MainWindow.Content` to a fresh root, but I have not needed to in 11.0.0.

## Status bar, splash, and other native surfaces

Two things are not covered by `AppThemeBinding` and trip up almost every project the first time:

- **Status bar text/icon color on Android and iOS** is owned by the platform, not by the page background. On iOS, set `UIViewController.PreferredStatusBarStyle` per page; on Android, set `Window.SetStatusBarColor` from `MainActivity`. The simplest cross-platform pattern is to put the per-platform code behind a `ConditionalCompilation` block in the `RequestedThemeChanged` handler shown above.

- **Splash screens** are rendered by the OS before MAUI has loaded, so they cannot consume `AppThemeBinding`. The Android template ships separate light and night colors via `values/colors.xml` and `values-night/colors.xml`. iOS uses a single launch storyboard, so you either pick a neutral color that works in both modes or supply two storyboards through the `LaunchStoryboard` configuration.

If you need a custom map style, chart palette, or `WebView` content to follow the theme, do the swap in `RequestedThemeChanged`. For maps in particular, the [MAUI 11 map pin clustering walkthrough](/2026/04/dotnet-maui-11-map-pin-clustering/) shows how to keep map control state in sync with theme transitions without rebuilding the renderer.

## Five gotchas that will eat an afternoon

**1. `Page.BackgroundColor` does not always refresh on `UserAppTheme` change.** The known issue at [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) means that some properties miss the re-evaluation pass when you set `UserAppTheme` programmatically. The reliable workaround is to set the page background through a `Style` `Setter` (as in the `App.xaml` example above) rather than directly on the page element. Style-driven setters reliably re-evaluate.

**2. `RequestedThemeChanged` fires once and then goes silent.** This is the symptom of [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350), and on Android it is almost always the missing `ConfigChanges.UiMode` flag. On iOS, the equivalent symptom appears when a modal page is on the stack at the moment of the system theme switch; closing and reopening the modal restores the events. Subscribing once in `App.xaml.cs` and keeping the subscription alive is the safe pattern.

**3. `AppTheme.Unspecified` does not always reset to the OS on iOS.** As tracked in [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411), setting `UserAppTheme = AppTheme.Unspecified` after a hard override sometimes leaves the iOS window stuck on the previous override. The workaround in 11.0.0 is to set the `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` from a custom `MauiUIApplicationDelegate` after MAUI sets `UserAppTheme`. A handful of lines, and only needed if your app exposes a "follow system" toggle in settings.

**4. Custom controls that snapshot colors at construction stay light forever.** If you cache a `Color` value in your control's constructor (or in a static field), it will never update. Read theme values lazily in `OnHandlerChanged` or bind them through the bindable property pipeline so MAUI's `AppThemeBinding` plumbing can re-evaluate them.

**5. Hot reload does not always reflect theme changes.** When you switch the simulator or emulator from light to dark while the app is suspended, hot reload sometimes serves the cached resource. Force a full rebuild after toggling the system theme during development. This is a tooling artifact, not an `AppThemeBinding` bug, and it makes diagnosing real issues much easier when you remove it as a variable.

## Where dark mode meets the rest of the framework

Dark mode is the easiest theming feature MAUI ships and the one the docs cover most thoroughly, but it interacts with two other parts of the framework you will probably touch in the same week. The handler-customization pattern from [how to change the SearchBar icon color in .NET MAUI](/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) is the right shape when you have a control whose native part ignores `TextColor` in dark mode (the iOS `UISearchBar` is the canonical offender). For the platform setup tour, the [what's new in .NET MAUI 10](/2025/04/whats-new-in-net-maui-10/) post covers the `Window` and `MauiWinUIApplication` additions that landed in MAUI 10 and are still the right hooks in 11.0.0. If you are bundling theme-sensitive controls inside a class library, [how to register handlers in a MAUI library](/2023/11/maui-library-register-handlers/) walks the `MauiAppBuilder` plumbing, including the order-of-operations rules that determine when a handler sees the resolved theme. And if your dark-mode work is happening inside a desktop-only build, the [Windows-and-macOS-only MAUI 11 setup](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) shows how to drop the Android and iOS targets so you only have to debug two platforms instead of four.

## Source links

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)
