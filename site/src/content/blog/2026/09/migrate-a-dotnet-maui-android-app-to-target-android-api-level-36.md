---
title: "Migrate a .NET MAUI Android app to target Android API level 36"
description: "Google Play required target API 36 from 2026-08-31, with extensions running to 2026-11-01. Here is the full .NET MAUI path from net9.0-android to API 36: the target framework bump, the hardcoded uses-sdk that silently pins you to the old level, edge-to-edge with no opt-out, predictive back, and the large-screen orientation rules."
pubDate: 2026-09-04
updatedDate: 2026-09-04
template: migration
tags:
  - "migration"
  - "maui"
  - "android"
  - "google-play"
  - "dotnet-10"
  - "dotnet-11"
---

The build change is one line. The behaviour changes are the migration. Google Play started requiring target API level 36 for new apps and app updates on 2026-08-31, with a per-app extension available through Play Console until 2026-11-01, so if your update was rejected this week this is why. On a .NET MAUI app the target API level is not a manifest setting you edit, it is derived from the Android platform version in your `TargetFramework`, and .NET 9 tops out at API 35. That means this is a .NET SDK upgrade to .NET 10 (or .NET 11), not a manifest tweak. Budget a day for a small app and a sprint for anything with a locked orientation, a custom back button, or hand-tuned insets. This guide targets .NET 10 with .NET MAUI 10.0.100 (released 2026-08-20) as the landing spot, and notes where .NET 11 differs.

## Why the target level, specifically, is what Play checks

- **`targetSdkVersion` is the gate, not `compileSdk` and not `minSdk`.** Play reads `android:targetSdkVersion` out of the merged manifest inside your AAB. Building against the API 36 platform is not enough on its own.
- **Existing installs are not removed, new users are cut off.** Per the [Play Console target API level policy](https://support.google.com/googleplay/android-developer/answer/11926878), apps below the floor stay on devices that already have them, but stop being available to new users on Android versions newer than the app's target. Your install funnel degrades quietly instead of breaking loudly.
- **Every year's floor is last year's release.** API 36 is Android 16. The 2027 requirement will be API 37 (Android 17), which .NET for Android already ships as stable, so the work you do here is work you do once a year forever.

## What breaks

| Area | Change at target API 36 | Severity |
| --- | --- | --- |
| Edge-to-edge | `windowOptOutEdgeToEdgeEnforcement` is deprecated and ignored on Android 16 devices | high |
| .NET MAUI safe areas | `ContentPage.SafeAreaEdges` defaults to `None` from .NET 10, so pages go edge-to-edge | high |
| Predictive back | Back-to-home and cross-activity animations are on by default; `OnBackPressed` is not called | high |
| Large screens | `android:screenOrientation`, `resizableActivity`, `minAspectRatio`, `maxAspectRatio` ignored at `sw600dp` and above | high (tablets, foldables) |
| .NET SDK | API 36 needs `net10.0-android` or later; the .NET 9 workload stops at API 35 | high |
| Minimum API | .NET 11 raises the floor from API 21 to API 24 | medium (.NET 11 only) |
| Text rendering | `android:elegantTextHeight` is deprecated and ignored | low |
| Scheduling | `ScheduledExecutorService.scheduleAtFixedRate` replays at most one missed execution | low |
| Health sensors | `BODY_SENSORS` replaced by granular `android.permissions.health` permissions | low (unless you read heart rate) |

The first two rows compound. Upgrading to .NET 10 to get API 36 also changes .NET MAUI's own safe area default in the same commit, so an app that looked fine on .NET 9 at target 35 can come out the other side with a title bar under the status bar for two independent reasons.

## Pre-flight checklist

- .NET 10 SDK installed, with the `maui-android` workload restored: `dotnet workload install maui-android`.
- The Android SDK Platform for API 36 actually present on the build machine and on CI. Missing it produces [XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207), not a warning.
- A physical device or emulator image running Android 16. Behaviour changes here are gated on the OS version as well as your target, so an Android 14 emulator will happily hide every one of them.
- Screenshots of your current UI on a phone and a tablet, before you change anything. You will need them to judge the inset regressions.
- Your 16 KB page size status already sorted, since that is a separate Play requirement with its own failure mode. See [why Google Play rejects a Flutter or MAUI app for 16 KB page size](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Migration steps

1. **Find out what you actually target today.** Do not read the csproj, read the merged manifest that the build produces:

   ```bash
   dotnet build -f net9.0-android -c Release
   grep -o 'targetSdkVersion="[0-9.]*"' obj/Release/net9.0-android/AndroidManifest.xml
   ```

   **Verify:** you get a single number. If it is lower than the Android platform version in your `TargetFramework`, something is pinning it, and step 3 is the one that matters most for you.

2. **Move the target framework to .NET 10.** The Android platform version in the TFM is what becomes `targetSdkVersion`, so this single edit is the actual migration:

   ```xml
   <!-- .csproj, .NET 10, .NET MAUI 10.0.100 -->
   <PropertyGroup>
     <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Bare `net10.0-android` resolves to API 36, which is [the documented .NET 10 default](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10). Pin it explicitly as `net10.0-android36.0` if you want the build to fail rather than drift when you later move to .NET 11, because .NET for Android graduated API 37 to stable in .NET 11 Preview 5 and now defaults .NET 11 projects to `net11.0-android37`. `$(SupportedOSPlatformVersion)` is a separate axis: it becomes `minSdkVersion` and has nothing to do with the Play requirement.

   **Verify:** rebuild and re-run the `grep` from step 1 against `obj/Release/net10.0-android/AndroidManifest.xml`. It must print `targetSdkVersion="36"`.

3. **Delete any hardcoded `uses-sdk` from your manifest.** This is the single most common reason step 2 appears to do nothing. .NET for Android only writes `targetSdkVersion` when the template manifest does not already have one, and an explicit value wins outright ([`ManifestDocument.cs`](https://github.com/dotnet/android/blob/main/src/Xamarin.Android.Build.Tasks/Utilities/ManifestDocument.cs)):

   ```xml
   <!-- Platforms/Android/AndroidManifest.xml: delete the uses-sdk line entirely -->
   <manifest xmlns:android="http://schemas.android.com/apk/res/android">
     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
     <application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true" />
   </manifest>
   ```

   Microsoft's own [XA5207 guidance](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) told people to add exactly this element to hold a target level across an SDK upgrade, so plenty of Xamarin.Forms era projects still carry it. The current .NET MAUI template ships no `uses-sdk` element at all, which is the state you want.

   **Verify:** `grep -c uses-sdk Platforms/Android/AndroidManifest.xml` returns `0`, and the merged manifest still shows `targetSdkVersion="36"`.

4. **Decide your edge-to-edge story, because you no longer get a vote.** At target 36 the `windowOptOutEdgeToEdgeEnforcement` attribute is [deprecated and disabled](https://developer.android.com/about/versions/16/behavior-changes-16) on Android 16 devices. If you had it in `Platforms/Android/Resources/values/styles.xml`, delete it. Then pick a `SafeAreaEdges` value per page rather than accepting the .NET 10 default of `None`:

   ```xml
   <!-- .NET MAUI 10.0.100: ContentPage defaults to SafeAreaEdges="None" -->
   <ContentPage SafeAreaEdges="Container">
       <Grid SafeAreaEdges="Container" RowDefinitions="Auto,*">
           <Label Text="Not under the status bar" />
       </Grid>
   </ContentPage>
   ```

   `Container` reproduces the .NET 9 behaviour of staying clear of system bars and cutouts. `All` also avoids the keyboard, which is what you want if you relied on the Android `WindowSoftInputModeAdjust.Resize` platform-specific. `None` is the immersive option, and it is a deliberate choice, not a default you should inherit by accident.

   **Verify:** on an Android 16 device, the status bar and gesture navigation bar do not overlap any tappable control on your top three screens, in both light and dark themes.

5. **Fix custom back handling before predictive back eats it.** At target 36 the predictive back animations are enabled by default, `onBackPressed()` is not called, and `KeyEvent.KEYCODE_BACK` is not dispatched. Any activity override like this stops running:

   ```csharp
   // Broken at targetSdkVersion 36 on Android 16
   public override void OnBackPressed()
   {
       if (_hasUnsavedChanges) { ShowConfirmDialog(); return; }
       base.OnBackPressed();
   }
   ```

   Handle it in .NET MAUI's own navigation surface instead, which keeps working across platforms:

   ```csharp
   // .NET MAUI 10.0.100, cross-platform
   protected override bool OnBackButtonPressed()
   {
       if (!_hasUnsavedChanges)
           return base.OnBackButtonPressed();

       Dispatcher.Dispatch(async () => await DisplayAlertAsync("Discard changes?", "...", "OK"));
       return true; // handled
   }
   ```

   The Android escape hatch is `android:enableOnBackInvokedCallback="false"` on `<application>` or a single `<activity>`, and it is a stopgap, not a fix.

   **Verify:** swipe from the screen edge and hold. You should see the predictive peek animation, and releasing should do what your handler intends.

6. **Audit locked orientation and fixed aspect ratios.** On displays at `sw600dp` and above, target 36 makes Android ignore `android:screenOrientation`, `android:resizableActivity`, `android:minAspectRatio` and `android:maxAspectRatio`, along with `SetRequestedOrientation` at runtime. In .NET MAUI that usually means an attribute on `MainActivity`:

   ```csharp
   // Ignored on sw600dp+ displays at targetSdkVersion 36
   [Activity(ScreenOrientation = ScreenOrientation.Portrait, /* ... */)]
   public class MainActivity : MauiAppCompatActivity { }
   ```

   The temporary opt-out is a manifest property, and Google has stated it stops applying at API level 37:

   ```xml
   <application>
     <property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
               android:value="true" />
   </application>
   ```

   **Verify:** run on a tablet or foldable emulator and rotate. If the layout is unusable in landscape, fix the layout, because the opt-out buys you one year.

7. **Update CI so it does not build against a platform it does not have.** Missing API 36 on an agent surfaces as XA5207, and the fix is a target, not a portal download:

   ```bash
   dotnet build -t:InstallAndroidDependencies -f net10.0-android \
     -p:AndroidSdkDirectory="$ANDROID_HOME" \
     -p:AcceptAndroidSDKLicenses=true
   ```

   The `-f` argument is mandatory, otherwise MSBuild reports `MSB4057: The target "InstallAndroidDependencies" does not exist in the project`.

   **Verify:** a clean CI run from an empty SDK cache produces a signed AAB with no XA5207.

## Verification checklist

- `obj/Release/net10.0-android/AndroidManifest.xml` contains `targetSdkVersion="36"` and the `minSdkVersion` you intended.
- Play Console's pre-launch report on an internal track shows no target API level warning.
- Every screen checked on an Android 16 phone for inset overlap, top and bottom, plus with the keyboard open.
- Back gesture, back button, and any confirm-on-exit dialog behave the same as before.
- Tablet or foldable run in both orientations, if you ship to large screens at all.
- Crash-free rate and ANR rate flat after a week on an internal track, before you promote.

## Rollback plan

Reverting the `TargetFramework` back to `net9.0-android` restores the old target level and the old .NET MAUI safe area behaviour, and it is a clean revert as long as you did not also adopt .NET 10 APIs. What you cannot roll back is the Play side: once you have shipped an AAB at target 36 you cannot publish a lower target level to the same track afterwards, because Play enforces the floor on every new upload. Treat the internal track as your rollback window and the production promotion as one-way.

## Gotchas that cost real time

- **The manifest writes the major version only.** `net11.0-android36.1` produces `android:targetSdkVersion="36"`, because the manifest generator takes the major component of the API level. If you were expecting to see `36.1` in the merged manifest and went looking for a bug, there isn't one.
- **.NET 9 cannot get you there.** The .NET 9 Android workload shipped API 35 bindings and stopped there, so `net9.0-android36.0` is not a valid TFM. There is no way to satisfy the Play requirement without moving the SDK.
- **Predictive back had a real .NET MAUI bug.** `MauiAppCompatActivity` registered a back callback unconditionally, which suppressed Android's back-to-home animation even on a root page where .NET MAUI had nothing to consume. It was fixed by switching to an AndroidX `OnBackPressedCallback` whose `Enabled` state tracks whether navigation can actually go back ([dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223)), and shipped in .NET MAUI 10.0.90. `BlazorWebView` had the same bug and its own fix in the same release. If your back animation stutters on Android 16, check your .NET MAUI version before you debug your own code.
- **`ScrollView` ignores `SafeAreaEdges` for keyboard avoidance.** `SoftInput` has no effect there, because `ScrollView` manages its own content insets. Wrap it in a `Grid` and set `SafeAreaEdges` on the wrapper.
- **Status bar icons disappear against your new edge-to-edge background.** .NET 11 Preview 7 added `Window.StatusBarTheme` to control icon contrast independently of the app theme, on Android 6.0 and later. On .NET 10 you are setting `WindowInsetsControllerCompat.AppearanceLightStatusBars` yourself.
- **Play's extension is per app and time-boxed.** The 2026-11-01 extension is requested from the Play Console notification on the affected app, not granted automatically, and it does not move next year's API 37 deadline.

## Related

- [Migrate a .NET MAUI Android app from Mono to CoreCLR in .NET 11](/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/) covers the other half of a .NET 11 move, including the API 24 floor.
- [Why Google Play rejects a Flutter or MAUI app for 16 KB page size](/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) is the other Play requirement that blocks uploads.
- [Fix "Doesn't support required ABI" when installing a .NET MAUI Android app](/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) is the install-time failure you hit right after changing runtime identifiers.
- [Fix Flutter UI overlapping the Android navigation bar after targeting SDK 35](/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) is the same edge-to-edge enforcement seen from the Flutter side.
- [Migrate from Xamarin.Forms to .NET MAUI 11](/2026/05/migrate-from-xamarin-forms-to-maui-11/) if the hardcoded `uses-sdk` in step 3 turned out to be the least of your problems.

## Sources

- [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878), Play Console Help.
- [Behavior changes: apps targeting Android 16 or higher](https://developer.android.com/about/versions/16/behavior-changes-16), Android Developers.
- [What's new in .NET MAUI for .NET 10](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-10) and [for .NET 11](https://learn.microsoft.com/en-us/dotnet/maui/whats-new/dotnet-11), Microsoft Learn.
- [Safe area layout](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/safe-area), Microsoft Learn, including the .NET 10 `ContentPage` breaking change.
- [.NET for Android error XA5207](https://learn.microsoft.com/en-us/dotnet/android/messages/xa5207) and [build targets](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-targets), Microsoft Learn.
- [.NET for Android 11 Preview 5 release notes](https://github.com/dotnet/android/releases/tag/36.99.0-preview.5.308), which stabilise API 37 and default .NET 11 to `net11.0-android37`.
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), the predictive back registration fix.
