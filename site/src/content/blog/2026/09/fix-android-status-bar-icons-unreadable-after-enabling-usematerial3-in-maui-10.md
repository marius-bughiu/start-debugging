---
title: "Fix: Android status bar icons become unreadable after enabling UseMaterial3 in .NET MAUI 10"
description: "MAUI 10.0.100 picks status bar icon colors from colorPrimary, which is the opposite brightness of the Material 3 surface, so you get white on white or black on black. Update Microsoft.Maui.Controls to 10.0.101 or later, or reset AppearanceLightStatusBars in MainActivity."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
---

If your .NET MAUI 10 app shows white clock and battery icons on a white status bar in light mode, and black icons on a black status bar in dark mode, right after you set `<UseMaterial3>true</UseMaterial3>`, you are on `Microsoft.Maui.Controls` 10.0.100. That release started choosing the status bar icon color from the luminance of the theme's `colorPrimary`. Material 3 draws `colorSurface` behind the transparent edge-to-edge status bar, and the Material 3 primary and surface colors always have opposite brightness, so the icons come out inverted. The fix is to update to 10.0.101 or later (10.0.110 is current, shipped 2026-09-22). If you cannot upgrade yet, set `AppearanceLightStatusBars` yourself in `MainActivity` after `base.OnCreate`. On .NET 11 RC 1 the main window is fine but modal pages still show the bug; RC 2 has the fix.

## The error in context

There is no exception and nothing in the log. The symptom is visual, and it looks like this on Android 15, 16 and 17 with edge-to-edge (which .NET MAUI 10 enables for API 30+):

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

The report is [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705), labeled `i/regression` and `regressed-in-10.0.100`. Downgrading to 10.0.90 makes the icons readable again, which is the first clue that this is a MAUI change and not something in your theme.

Here is what each version does, read from `WindowExtensions.cs` and the window handler at each release tag:

| Microsoft.Maui.Controls | How the status bar icon color is chosen | Material 3 result |
| --- | --- | --- |
| 10.0.90 and earlier | Day/night: light theme gets dark icons | Readable |
| 10.0.100 (2026-08-20) | Luminance of `android:colorPrimary` | Inverted, unreadable |
| 10.0.101 (2026-09-07), 10.0.110 | Luminance of `colorSurface` for Material 3, `colorPrimary` for Material 2 | Readable |
| 11.0 RC 1 | `colorPrimary`, then overwritten by `Window.StatusBarTheme` (default: day/night) for the main window only | Main window readable, modal pages inverted |
| 11.0 RC 2 branch | Same as 10.0.101 | Readable |

## Why the icons flip: colorPrimary vs colorSurface

Android does not let an app pick an exact color for the status bar icons. It offers a boolean: `WindowInsetsControllerCompat.AppearanceLightStatusBars`. When it is `true`, the system assumes the status bar background is light and draws dark icons. When it is `false`, it draws light icons.

Up to 10.0.90, MAUI set that flag from the day/night mode alone:

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

That works when the thing behind the status bar follows the day/night mode, and breaks when it does not. [dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) was the second case: a light-theme Material 2 app with a black `colorPrimary` app bar under the status bar got dark icons on a dark bar. The fix for that, [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214), merged on 2026-07-01 and shipped in 10.0.100. It resolves `android:colorPrimary` from the current theme and uses its luminance instead:

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

For a Material 2 app bar painted in `colorPrimary`, that is correct. For Material 3 it is exactly backwards. With `UseMaterial3` on, MAUI switches the activity theme to `Maui.Material3.Theme.NoActionBar`, whose parent is `Theme.Material3.DayNight`. MAUI's own Material 3 styles do not override the primary color, so you get the baseline Material 3 palette. Material 3 puts the surface color behind the status bar, not the primary color, and the palette is designed so primary contrasts with surface:

| Theme | `colorPrimary` | Relative luminance | 10.0.100 decides | Actual background |
| --- | --- | --- | --- | --- |
| Light | `#6750A4` | 0.11 (dark) | Light icons | Near-white surface |
| Dark | `#D0BCFF` | 0.57 (light) | Dark icons | Near-black surface |

The template's purple `#512BD4` in `Platforms/Android/Resources/values/colors.xml` does not rescue you: that color resource feeds the Material 2 `Maui.MainTheme`, not the Material 3 theme, and it is dark (luminance 0.08) anyway. Any light-theme Material 3 palette with a saturated primary lands in the same place.

The 10.0.101 fix, [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710) backported to the SR10 branch as [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730), keeps the luminance idea but reads the attribute that actually sits behind the bar:

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## Minimal repro

Start from the default template and pin the affected package:

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Run it on an Android 11 (API 30) or newer emulator. The status bar icons are white on the home page in light mode. Switch the emulator to dark mode, restart the app, and they are black. Change `10.0.100` to `10.0.90` and both modes are readable. Change it to `10.0.110` and both modes are readable again.

If you want to confirm what MAUI decided rather than squinting at the emulator, log the flag after startup:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

In light mode on 10.0.100 you will see `False`, meaning "the background is dark, draw light icons", on top of a near-white surface.

## Fix 1: update Microsoft.Maui.Controls to 10.0.101 or later

This is the real fix, and it is a patch release on the same .NET 10 line, so there is no target framework change. Set the version explicitly instead of relying on `$(MauiVersion)` from whatever workload is installed on the build machine:

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

The changed code lives in `Microsoft.Maui.Core`, which `Microsoft.Maui.Controls` pulls in at the same version. If your project also references `Microsoft.Maui.Core` or `Microsoft.Maui.Controls.Compatibility` directly, bump those to the same version, or NuGet may resolve a mixed set. `dotnet list package --include-transitive` shows what you actually got.

Then clean and rebuild. Android resource and theme changes are easy to miss on an incremental deploy, so uninstall the app from the device once (`adb uninstall com.companyname.myapp`) before judging the result.

10.0.110 also carries the fix for the [UIKitThreadAccessException from MediaPicker.PickPhotosAsync](/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), another 10.0.100 regression, so there is little reason to stay on 10.0.100. One caveat going the other way: 10.0.101 and 10.0.110 have a Resizetizer problem with [SVG app icons that use filter or text elements](/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/). Check your icon before you upgrade a release branch.

## Fix 2: reset AppearanceLightStatusBars in MainActivity

If you are pinned to 10.0.100 for now, override the flag yourself. `MauiAppCompatActivity.OnCreate` calls `CreatePlatformWindow`, which connects the `WindowHandler`, which runs `ConfigureTranslucentSystemBars` and writes the wrong value. All of that happens inside `base.OnCreate`, so anything you set after that call wins for the main window:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

This restores the 10.0.90 behavior. The `OnConfigurationChanged` override matters because the template's `ConfigurationChanges` includes `ConfigChanges.UiMode`: when the user flips the system theme, Android does not recreate the activity, and MAUI 10 only sets the flag when the window handler connects. Without the override, the icons keep the previous mode's color until the next cold start.

Delete this override when you move to 10.0.101 or later. The built-in fix derives the flag from your actual `colorSurface`, which is more accurate than day/night if you customize the surface color.

## Fix 3: on .NET 11, use Window.StatusBarTheme

.NET 11 added `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)), an enum with `Default`, `Light` and `Dark`. In RC 1, `WindowHandler.ConnectHandler` calls `ConfigureTranslucentSystemBars` (which still has the `colorPrimary` logic) and then immediately applies `StatusBarTheme`. `Default` falls back to day/night, so the main window of a .NET 11 RC 1 app is readable without you doing anything.

Modal pages are different. `ModalNavigationManager` shows each modal in its own dialog window and calls `ConfigureTranslucentSystemBars` on it, but does not apply `StatusBarTheme` afterwards. So on RC 1, a page you open with `Navigation.PushModalAsync` gets the inverted icons back. The fix is on the `release/11.0.1xx-rc2` branch, so RC 2 resolves both.

`StatusBarTheme` is also the right tool when your page puts something other than the surface behind the status bar, like a dark hero image in a light theme:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

Or per page, when a single screen needs light icons over a dark header, set it on the page's window and put it back when the page goes away:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

Note the naming: `StatusBarTheme` describes the bar, not the icons. `Dark` means "the bar is dark", which produces light icons, the same convention as `AppearanceLightStatusBars`.

## Gotchas and lookalikes

**Material 2 apps can hit the mirror image.** 10.0.101 and 10.0.110 still derive the Material 2 status bar from `colorPrimary`, on purpose, because the Material 2 app bar is painted in it. If your Material 2 app hides the navigation bar (`Shell.NavBarIsVisible="False"`) and shows a white page under a status bar while `colorPrimary` is dark, the code will pick light icons over white. That follows from the same source and is not tracked as a bug, since the default Material 2 layout keeps the app bar under the status bar. The `MainActivity` override from Fix 2 handles it.

**Navigation bar icons are not affected.** Every version above still sets `AppearanceLightNavigationBars` from day/night. If your gesture pill or 3-button bar is unreadable, that is a different problem, usually content drawn under the bar after the [API 36 edge-to-edge changes](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

**Android 10 and older look fine.** MAUI only runs this code on API 30 and up. Below that, the window handler never calls `ConfigureTranslucentSystemBars`, so testing on an old emulator will not reproduce the bug.

**Setting the status bar color does nothing on Android 15+.** A common first reaction is `Window.SetStatusBarColor(...)` from `MainActivity`. On apps targeting API 35 or higher running on Android 15 and later, edge-to-edge is enforced and that call is ignored. The bar stays transparent, which is why the icon appearance flag is the only lever that matters here.

**It is not your dark mode setup.** If the icons are wrong only after a runtime `Application.Current.UserAppTheme` change, and correct after a cold start, that is the missing re-apply described in Fix 2, not this regression. [Supporting dark mode correctly in a MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) covers the rest of the native surfaces that do not follow `AppThemeBinding`.

## Related

- [.NET MAUI 10 SR6 finishes Material 3 on Android behind a single UseMaterial3 flag](/2026/05/maui-10-material-3-android-usematerial3-flag/) explains what the flag changes and which controls it styles.
- [Migrate a .NET MAUI Android app to target Android API level 36](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) for the edge-to-edge and safe area changes that make the status bar transparent in the first place.
- [How to support dark mode correctly in a MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) for theme-aware colors and reacting to `RequestedThemeChanged`.
- [Fix: .NET MAUI Resizetizer MissingMethodException (MAUIR0001) on an SVG app icon](/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/) before you upgrade to 10.0.101 or 10.0.110.

## Sources

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (the change that introduced the regression)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) and the 10.0.101 backport [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [`WindowExtensions.cs` at tag 10.0.100](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) and [at tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [`styles-material3.xml` at tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls on NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) for release dates
