---
title: "How to intercept the Android back button on a .NET MAUI Shell root page"
description: "Override OnBackButtonPressed on the root page and run .NET MAUI 10.0.101 or later. Why root pages stopped receiving back presses from 10.0.70 (Android 16) and 10.0.100 (every Android version), why .NET 11 RC 1 is still affected, why Shell.OnNavigating and BackButtonBehavior.Command do not help, and a MainActivity workaround for the broken versions."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
---

**Short answer:** override `OnBackButtonPressed()` on the root `ContentPage` (or on your `AppShell`), return `true` to swallow the press, and make sure you are on **.NET MAUI 10.0.101** (released 2026-09-07) or later. Between 10.0.70 and 10.0.100, and in .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`), that override is never called on a root page: MAUI disables its Android back callback whenever it thinks there is nothing to pop, so Android sends the user to the home screen without asking your code. On Android 16 this started with 10.0.70; on every other Android version it started with 10.0.100. If you cannot upgrade, register your own `OnBackPressedCallback` in `MainActivity` (code below). `Shell.OnNavigating` with `ShellNavigationSource.Pop` and `BackButtonBehavior.Command` do not intercept the hardware or gesture back on a root page, even on 10.0.101.

The fix in 10.0.101 is not in .NET 11 RC 1. It has since reached `main` and the `net11.0` branch (through the SR10 servicing merge, [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301)), so expect it in .NET 11 RC 2.

## Why the root page stopped hearing the back button

Android 16 turns on predictive back by default for apps that target API 36. With predictive back, the system decides *before the gesture starts* whether the app wants the back event. If no callback is enabled, it plays the back-to-home peek animation and backgrounds the task. It never calls the deprecated `Activity.OnBackPressed()`, and it never dispatches `KeyEvent.KEYCODE_BACK` to `OnKeyDown`.

.NET MAUI used to register its back callback unconditionally, which killed that animation for every MAUI app ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594)). The fix, [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), replaced it with an AndroidX `OnBackPressedCallback` whose `Enabled` flag MAUI recomputes on every navigation change. `MauiAppCompatActivity` enables the callback only when `Window.CanConsumeBackNavigation` says the current page can consume back:

- a modal page is on the stack, or
- the Shell section's navigation stack has more than one page, or
- a `NavigationPage` has more than one page, or
- a user-dismissible flyout is open.

A plain root `ContentPage` matches none of those, so the callback is disabled and the press goes straight to the system. Your `OnBackButtonPressed()` override sits at the end of a chain (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`) that never starts.

Why did Android 16 break first? From 10.0.70 to 10.0.90, `MauiAppCompatActivity` still overrode the deprecated `OnBackPressed()` and ran MAUI's back handling unconditionally from there. Devices that do not use predictive back (Android 15 and older, unless you opted in with `android:enableOnBackInvokedCallback="true"`) still delivered the press through that override, so the gate did not matter. 10.0.100 deleted the override and moved everything onto `OnBackPressedDispatcher`, so the gate applies on every Android version. The issue triage matches this exactly: [#37657](https://github.com/dotnet/maui/issues/37657) and [#38030](https://github.com/dotnet/maui/issues/38030) are labelled `regressed-in-10.0.70` for Android 16, and [#37706](https://github.com/dotnet/maui/issues/37706) reports Android 15 and 17 failing from 10.0.100.

## What 10.0.101 changed, measured

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709), backported as [#37729](https://github.com/dotnet/maui/pull/37729), adds one check at the top of `CanConsumeBackNavigation`: if the page's effective `OnBackButtonPressed` is declared in any assembly other than `Microsoft.Maui.Controls`, the callback is enabled. MAUI detects the override from a delegate's `MethodInfo.DeclaringType`, without invoking your code. The result is cached per page instance.

I wanted to see the decision itself rather than trust the PR description, so I called the internal `Window.CanConsumeBackNavigation(Page)` by reflection from a .NET 10 file-based app. It uses the plain `net10.0` build of `Microsoft.Maui.Controls`, so no emulator is needed:

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` means MAUI enables its callback on that root page, so your code runs. `False` means Android backgrounds the app without asking:

| Root page setup | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| Plain `ContentPage`, no overrides | False | False | False |
| `ContentPage` overriding `OnBackButtonPressed` | False | **True** | False |
| `AppShell` overriding `OnBackButtonPressed`, plain root | False | **True** | False |
| Plain `Shell`, root page overriding `OnBackButtonPressed` | False | **True** | False |
| `AppShell` overriding only `OnNavigating` (cancel `Pop`) | False | False | False |
| Root page with `Shell.BackButtonBehavior` `Command` | False | False | False |

This probe measures the gate, not a device run. For the on-device result, #37709 includes an Android 16 emulator verification. The MAUI team also confirmed the fix against the Shell-tab repro in #37657, and a reporter in #37706 confirmed that the PR build fixed their NavigationPage app.

## Step by step: intercept the back press on a root page

1. **Check your MAUI version.** Look for the `Microsoft.Maui.Controls` package in your `.csproj`, or run `dotnet list package`. If it resolves to anything from 10.0.70 to 10.0.100, bump it to 10.0.101 or later. On .NET 11 RC 1, use the workaround in step 4 until RC 2.

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **Override `OnBackButtonPressed` on the page that needs it.** The method is synchronous, so return `true` right away and show any confirmation dialog on the next dispatcher tick. Do not make the override `async`: an `async` override returns `false` at its first `await`, before the user answers.

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` is deliberate. `Application.Current.Quit()` on Android calls `FinishAndRemoveTask()` and then `Environment.Exit(0)`, which kills the process and throws away the warm start Android would otherwise give you on the next launch.

3. **For tab-level rules, override on `AppShell` instead.** A common requirement is "back on the root of any tab returns to the first tab, and only the first tab leaves the app". That belongs in the Shell, which sees every root page:

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   Returning `base.OnBackButtonPressed()` keeps Shell's normal behaviour. It calls the visible page's `OnBackButtonPressed`, pops the section stack if there is anything to pop, and otherwise raises `Navigating` with `ShellNavigationSource.Pop` and returns `args.Cancelled`. This also means the documented `OnNavigating` cancel pattern *does* work on a root page once some override has enabled the callback. On its own, it never runs.

4. **On 10.0.70 to 10.0.100 or .NET 11 RC 1, add your own callback in `MainActivity`.** The AndroidX dispatcher calls the most recently added enabled callback first. A callback added after `base.OnCreate` therefore runs before MAUI's, including in the cases where MAUI's own callback is disabled:

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   This is a compatibility shim, not a pattern to keep. The callback is always enabled, so the back-to-home animation never plays. Also, when MAUI's own callback is enabled too (an open flyout, say) and no page handles the press, your override runs twice. Delete the shim when you move to 10.0.101. Leaving it in place on 10.0.101 makes every unhandled press on an overriding page go through `OnBackButtonPressed` twice. [#37657](https://github.com/dotnet/maui/issues/37657) has a shorter variant that re-enters the deprecated `Activity.OnBackPressed()`. The version above avoids calling a deprecated API from new code.

5. **Verify on a real Android 16 device or an API 36 emulator.** Use both gesture navigation and 3-button navigation. Swipe from the edge and hold on a root page that overrides the method: you should get no back-to-home peek, and releasing should run your handler. On a root page without an override you should still see the peek animation. That is how you know you have not disabled predictive back app-wide.

## Things that look like they should work but do not

**`BackButtonBehavior.Command` is not a hardware back handler on Android.** `Shell.OnBackButtonPressed` only executes the command under `#if WINDOWS || !PLATFORM`. On Android, the command runs from `ShellToolbarTracker.OnClick`, meaning the arrow in the navigation bar. A root page has no back arrow (in a flyout Shell that slot is the hamburger), so for the root page the command is irrelevant. The probe confirms it does not enable the callback either.

**Lifecycle events do not open the gate.** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` registers another `AndroidLifecycle.OnBackPressed` delegate. The gate only checks that *some* delegate exists, and MAUI always registers its own `HandleWindowBackButtonPressed`, so yours adds nothing. When the page cannot consume back, the callback stays disabled and your delegate never runs.

**`OnKeyDown(Keycode.Back, ...)` and `OnBackPressed()` overrides in `MainActivity` are dead code on Android 16.** Google's predictive back guide states that intercepting back events from `KEYCODE_BACK` "is no longer supported". The migration checklist in [targeting Android API level 36 from .NET MAUI](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) covers the other overrides that go silent at target 36.

**Every override costs you the back-to-home animation on that page.** MAUI decides by type, not by what your override returns. Once a page declares `OnBackButtonPressed`, the callback is enabled on that page even if the method just returns `base.OnBackButtonPressed()`. The same applies to overrides inherited from a base class outside `Microsoft.Maui.Controls`, so a shared `BasePage` with an override opts every derived page in, and an override on `AppShell` opts in every page. Android's guidance is to enable back callbacks only for UI logic (confirming unsaved changes, closing an in-page popup) and never for logging or analytics. Put the override on the narrowest page that needs it.

**`android:enableOnBackInvokedCallback="false"` is not a fix.** It disables the predictive back animations and stops `OnBackInvokedCallback` from working. `OnBackPressedCallback` calls, which MAUI uses, continue to work. On 10.0.70 to 10.0.90 it happens to route Android 16 back through the legacy path again. On 10.0.100 there is no legacy override left, so it changes nothing about the root-page gate.

**Modal pages were never affected.** A non-empty modal stack always enables the callback, which is why `protected override bool OnBackButtonPressed() => true;` on a modal page kept working through all of this. See [showing a modal window in .NET MAUI 11](/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).

**Do not fire and forget from the override.** Returning `true` and then awaiting a dialog is safe because `Dispatcher.Dispatch` runs the lambda on the UI thread. An `async void` helper that throws would still take the process down. [Finding the `async void` handlers causing ANRs in a MAUI Android app](/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) shows how to track those down.

## Related reading

- Back navigation that carries data (`..?saved=true`) and the `BackButtonBehavior` properties, including the .NET MAUI 11 `AccessibilityLabel`, are covered in [Shell route parameters and query properties in .NET MAUI 11](/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/).
- The predictive back step of the API 36 migration, and the 10.0.90 fix that restored the back-to-home animation, are in [migrating a MAUI Android app to target API level 36](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Swallowing back on a modal page, and why a modal is not a modal window, is in [how to show a modal window in .NET MAUI 11](/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).
- The dispatcher pattern in step 2 is the safe form of the fire-and-forget code dissected in [finding `async void` handlers that cause ANRs](/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Sources

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`, `Navigating`, `ShellNavigationSource.Pop`, navigation deferral)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: when callbacks disable the animation, `KEYCODE_BACK`, `enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): gated `OnBackPressedCallback` for the back-to-home animation
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) and the 10.0.101 backport [#37729](https://github.com/dotnet/maui/pull/37729): `OnBackButtonPressed` on root pages
- Regression reports: [#37657](https://github.com/dotnet/maui/issues/37657) (Shell tabs), [#37706](https://github.com/dotnet/maui/issues/37706) (root `ContentPage`), [#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- Source at the release tags: [`Window.cs` at 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs), [`MauiAppCompatActivity.cs` at 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs), [`Shell.cs` at 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs), and [`Window.cs` at 11.0.100-rc.1.26458.5](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)
