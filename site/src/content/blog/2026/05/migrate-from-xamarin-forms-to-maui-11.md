---
title: "Migrate from Xamarin.Forms 5.0 to .NET MAUI 11: the full checklist"
description: "End-to-end migration from Xamarin.Forms 5.0 to .NET MAUI 11 GA on net11.0, covering csproj rewrite, custom renderer to handler conversion, AppShell wiring, DependencyService removal, MessagingCenter retirement, Resizetizer assets, and the gotchas that bite a real production codebase."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
---

Xamarin.Forms went out of support on 2024-05-01 and Microsoft has not shipped a single fix since. .NET MAUI 11 is the LTS landing point for every Xamarin.Forms 5.0 app that has been sitting on borrowed time, and as of MAUI 11.0 GA in November 2025 the platform finally has the renderer plumbing, the `RecyclerView` performance, and the iOS 18 / Android 15 target support that the early MAUI releases were missing. A focused single-developer migration of a medium app, ten to twenty screens with a handful of custom renderers, takes between one and three weeks. The hard parts are not XAML and not the build system; they are custom renderers, `DependencyService`, and any code that touched the platform projects directly. This post pins `Xamarin.Forms 5.0.0.2622` as the source and `.NET MAUI 11.0.0` on `net11.0` as the target, with `net11.0-android35.0`, `net11.0-ios18.0`, and `net11.0-maccatalyst18.0` as the active TFMs.

Rollback is non-trivial: once the `.csproj` flips to the SDK-style `Microsoft.NET.Sdk` with `UseMaui=true`, you do not get back to a Xamarin.Forms shared project without restoring the original csproj and packages.config from version control. Treat the migration as a one-way trip and branch accordingly.

## Why migrate now

- Xamarin.Forms is unsupported. There are no patches for the Android 15 target SDK bump that Google Play started enforcing on 2025-08-31, and Apple now rejects builds linked against the legacy iOS 17 SDK from App Store Connect.
- MAUI 11 runs on CoreCLR for Android and iOS by default, not Mono. Cold start on a Pixel 8 drops from roughly 1.6 s to 0.9 s on a stock Shell app, and steady-state allocations drop because the GC is generational rather than `SGen`. The switch is covered in [our MAUI CoreCLR default writeup](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- The handler architecture replaces custom renderers with a smaller surface and avoids the `Effect` plus `PlatformEffect` bolt-ons that Xamarin.Forms grew over its lifetime.
- Resizetizer ships in-box. The `Resources/Images/*.svg` pipeline generates platform-specific PNGs at build time, so you finally delete the `drawable-xhdpi`, `drawable-xxhdpi`, `Assets.xcassets`, and `LaunchScreen.storyboard` zoo.

## What breaks

| Area                     | Change                                                                       | Severity |
| ------------------------ | ---------------------------------------------------------------------------- | -------- |
| Project layout           | Shared project plus three head projects collapse into one SDK-style csproj   | high     |
| `Xamarin.Forms` namespace| Replaced by `Microsoft.Maui.Controls`, `Microsoft.Maui.Graphics`, etc.       | high     |
| Custom renderers         | `ExportRenderer` and `IVisualElementRenderer` removed. Use handlers          | high     |
| `DependencyService`      | Removed. Use `Microsoft.Extensions.DependencyInjection`                      | high     |
| `MessagingCenter`        | Deprecated and slated for removal. Use [CommunityToolkit.Mvvm `IMessenger`](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) | high |
| `Application.Properties` | Removed. Use `Microsoft.Maui.Storage.Preferences`                            | medium   |
| `ListView`               | Wrapper over `CollectionView`. Best to migrate, see [the ListView to CollectionView guide](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) | medium |
| `MasterDetailPage`       | Renamed `FlyoutPage`. XAML must be updated                                   | low      |
| `Frame`                  | Soft-deprecated. Use `Border` plus `StrokeShape`                             | low      |
| `OpenGLView`             | Removed entirely                                                             | low      |
| Android `MainActivity`   | Splits into `MainActivity.cs` plus `MainApplication.cs`, both partial        | medium   |
| iOS `AppDelegate`        | Replaces `FormsApplicationDelegate` with `MauiUIApplicationDelegate`         | medium   |
| `App.xaml.cs`            | `Application.MainPage` is fine in MAUI 11 but Shell-first is the new default | low      |
| Targeting                | `MonoAndroid12.0`, `Xamarin.iOS10` are gone. `net11.0-android35.0` only      | high     |

The upstream upgrade assistant ships as a `dotnet tool` and covers a meaningful fraction of the namespace rewrites and project file conversion. It does not handle custom renderers or `DependencyService` registrations, which is where the real time goes.

## Pre-flight checklist

1. Install the .NET 11 SDK and the MAUI workloads. Verify with `dotnet workload list`. You want `maui`, `maui-android`, `maui-ios`, and `maui-maccatalyst` all on version `11.0.x`.

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. Pin the SDK in `global.json` so the migration branch does not roll forward mid-PR:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. Tag the current Xamarin.Forms build in source control. `git tag pre-maui-migration` is enough. If the migration goes sideways at week two, you want a clean restore point.
4. Snapshot platform assets. Walk the `Drawable*` folders, `Assets.xcassets`, splash storyboards, and the Info.plist / AndroidManifest.xml entries. Resizetizer reorganises this whole tree and you want a before-state inventory in case an asset gets missed.
5. Inventory `DependencyService` registrations. `grep -rn "DependencyService\\|Dependency(typeof" .` returns the exhaustive list. Every one of these becomes a `services.AddSingleton` or `services.AddTransient` call.
6. Inventory custom renderers. Grep for `ExportRenderer` and read each one. Some can be deleted outright (MAUI's defaults are better than Xamarin.Forms's defaults), some become handlers, some become `Behaviors`.
7. Run `dotnet test` on the Xamarin.Forms tree and store the green baseline. A migration that introduces three test regressions is much easier to diagnose than one that lands on a codebase that already had five flaky tests.

## Migration steps

1. **Run the upgrade assistant on the shared project first.** It rewrites the csproj to SDK-style, updates the most obvious namespaces (`Xamarin.Forms` → `Microsoft.Maui.Controls`), and flags the renderer and `DependencyService` sites it cannot handle.

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   Verification: `dotnet restore` succeeds on the new csproj and `git status` shows the expected file rewrites. Do not run on the head projects yet; you are about to delete them.

2. **Collapse the head projects into one SDK-style csproj.** Xamarin.Forms ships as one shared project plus `MyApp.Android`, `MyApp.iOS`, and optionally `MyApp.UWP` head projects. MAUI ships as one csproj with multi-targeting. Move the Android-specific code under `Platforms/Android/`, iOS-specific code under `Platforms/iOS/`, and delete the head csproj files. The new csproj header looks like:

   ```xml
   <!-- src/MyApp/MyApp.csproj, .NET MAUI 11, net11.0 -->
   <Project Sdk="Microsoft.NET.Sdk">
     <PropertyGroup>
       <TargetFrameworks>net11.0-android35.0;net11.0-ios18.0;net11.0-maccatalyst18.0</TargetFrameworks>
       <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
       <OutputType>Exe</OutputType>
       <UseMaui>true</UseMaui>
       <SingleProject>true</SingleProject>
       <ImplicitUsings>enable</ImplicitUsings>
       <Nullable>enable</Nullable>
       <RootNamespace>MyApp</RootNamespace>
       <ApplicationId>net.mycompany.myapp</ApplicationId>
       <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
       <ApplicationVersion>1</ApplicationVersion>
     </PropertyGroup>
   </Project>
   ```

   Verification: `dotnet build -t:Restore` succeeds and the project loads in Visual Studio 2026 17.14 or Rider 2026.1 without "unsupported project type" warnings.

3. **Rewrite `App.xaml.cs` to use `MauiProgram.CreateMauiApp`.** Xamarin.Forms boots in `MainActivity.OnCreate` via `LoadApplication(new App())`. MAUI hands that off to `MauiAppBuilder`. The entry point becomes:

   ```csharp
   // MauiProgram.cs, .NET MAUI 11, C# 14
   using Microsoft.Extensions.Logging;
   using Microsoft.Maui.Hosting;

   namespace MyApp;

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
                   fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
               });

           builder.Services.AddSingleton<IAuthService, AuthService>();
           builder.Services.AddTransient<MainPageViewModel>();

           return builder.Build();
       }
   }
   ```

   Verification: `dotnet build -f net11.0-android35.0` exits 0 and the IDE resolves `MauiProgram` from any page constructor.

4. **Convert every `DependencyService` registration to `IServiceCollection`.** This is mechanical but mandatory; `DependencyService.Get<T>()` is gone in MAUI 11. The replacement:

   ```csharp
   // Before, Xamarin.Forms 5.0
   DependencyService.Register<IAuthService, AuthService>();
   var auth = DependencyService.Get<IAuthService>();

   // After, .NET MAUI 11
   // Registration moves to MauiProgram.CreateMauiApp (step 3).
   // Resolution moves to the constructor or to IPlatformApplication.Current.Services.
   public partial class MainPage : ContentPage
   {
       public MainPage(IAuthService auth) // injected
       {
           InitializeComponent();
       }
   }
   ```

   For places where constructor injection is impractical (a static helper, an `AppShell` handler), `IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` is the escape hatch.

   Verification: `grep -rn "DependencyService" src/` returns zero hits. CI fails if it does not.

5. **Replace custom renderers with handlers.** This is the most time-consuming step. A custom Xamarin.Forms renderer that overrode `OnElementPropertyChanged` becomes a [MAUI handler with a `Mapper` dictionary](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize). Example, a renderer that strips the underline from an Android `Entry`:

   ```csharp
   // .NET MAUI 11, C# 14
   // Platforms/Android/EntryHandlerCustomization.cs
   using Microsoft.Maui.Handlers;

   public static class EntryHandlerCustomization
   {
       public static void Apply()
       {
           EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, entry) =>
           {
               handler.PlatformView.BackgroundTintList =
                   Android.Content.Res.ColorStateList.ValueOf(
                       Android.Graphics.Color.Transparent);
           });
       }
   }
   ```

   Register the customization in `MauiProgram.CreateMauiApp` via `builder.ConfigureMauiHandlers(...)` or call `Apply()` from a `partial void` in `MauiProgram` so it runs only on Android. Keep the same pattern for iOS under `Platforms/iOS/`.

   Verification: every page that depended on the old renderer renders correctly in `dotnet build -t:Run -f net11.0-android35.0`. Visual smoke test, not just a build pass.

6. **Retire `MessagingCenter` for the CommunityToolkit messenger.** `MessagingCenter` is marked obsolete in MAUI 11 and is scheduled for removal in MAUI 12. Adopt `CommunityToolkit.Mvvm` 8.4.0 or later:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   The pattern swap:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   The `WeakReferenceMessenger` avoids the lifetime bugs that made `MessagingCenter` leaky in long-running shell apps.

7. **Move assets to Resizetizer.** Delete `Resources/drawable-*`, `Assets.xcassets`, and the duplicated launch screens. Put one `appicon.svg` and one `splash.svg` under `Resources/AppIcon/` and `Resources/Splash/`. The csproj already knows about them through the `MauiIcon` and `MauiSplashScreen` items the upgrade assistant emitted. Resize-at-build replaces the entire density ladder.

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   Verification: `dotnet build -f net11.0-android35.0` produces `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png` without you handcrafting it.

8. **Update Android `MainActivity` and `MainApplication`.** Xamarin.Forms had one `MainActivity` that derived from `FormsAppCompatActivity`. MAUI splits this into `MainActivity` plus `MainApplication`:

   ```csharp
   // Platforms/Android/MainActivity.cs, .NET MAUI 11
   using Android.App;
   using Android.Content.PM;
   using Android.OS;

   namespace MyApp;

   [Activity(Theme = "@style/Maui.SplashTheme",
             MainLauncher = true,
             ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation |
                                    ConfigChanges.UiMode | ConfigChanges.ScreenLayout |
                                    ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity { }

   // Platforms/Android/MainApplication.cs, .NET MAUI 11
   [Application]
   public class MainApplication : MauiApplication
   {
       public MainApplication(IntPtr handle, Android.Runtime.JniHandleOwnership ownership)
           : base(handle, ownership) { }

       protected override MauiApp CreateMauiApp() => MyApp.MauiProgram.CreateMauiApp();
   }
   ```

   On iOS the equivalent is one `AppDelegate` deriving from `MauiUIApplicationDelegate`. The pattern is identical: override `CreateMauiApp` and call the shared `MauiProgram`.

9. **Convert XAML namespaces.** Every `xmlns="http://xamarin.com/schemas/2014/forms"` becomes `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"`. The upgrade assistant handles most of this, but mixed-namespace files (custom control libraries that pulled in `xamarin.toolkit`) need a manual sweep. `Frame` keeps working for one release but produces a build warning. Plan to replace it with `Border` plus `StrokeShape="RoundRectangle 12"` and a `BackgroundColor`. `MasterDetailPage` must be renamed to `FlyoutPage` in both XAML and code-behind, including any `x:TypeArguments`.

10. **Audit `Application.Properties` to `Preferences`.** Any code that wrote to `Application.Current.Properties["key"] = value` needs to move to `Preferences.Set("key", value)` from `Microsoft.Maui.Storage`. The shape is similar but the storage backend differs, so on first run you may need a one-shot copy. Make the copy idempotent with a `"migrated_to_preferences"` flag so it does not re-run.

11. **Pin every NuGet dependency to a MAUI-compatible version.** Run `dotnet list package --vulnerable` and `dotnet list package --outdated` after the upgrade. Common offenders: `Xamarin.Essentials` (gone, folded into MAUI), `Xamarin.Forms.Maps` (replaced by `Microsoft.Maui.Controls.Maps`), `Xamarin.Forms.Visual.Material` (replaced by MAUI's Material 3 styles, see [the MAUI 10 Material 3 writeup](/2026/05/maui-10-material-3-android-usematerial3-flag/)).

## Verification

After the steps above:

- `dotnet restore` exits 0 on a clean clone of the migration branch.
- `dotnet build -f net11.0-android35.0` and `-f net11.0-ios18.0` both exit 0.
- The unit test project, retargeted to `net11.0`, runs `dotnet test` to a clean green.
- `dotnet build -t:Run -f net11.0-android35.0` launches the app on an emulator and reaches the first page without an unhandled exception.
- Manual smoke test on a real device of every page that contained a custom renderer in the Xamarin.Forms tree.
- Compare cold-start time before and after using a stopwatch from the launcher tap to the first frame. CoreCLR plus AOT should move a medium app under one second on a midrange 2024 Android phone. If you regressed, recheck step 5; a handler that does layout work synchronously on the UI thread is the usual culprit.

## Rollback plan

There is no automated rollback once the csproj is rewritten. The realistic plan is:

1. Keep the `pre-maui-migration` git tag from the pre-flight checklist.
2. Keep the migration on its own branch until the verification step is green on both Android and iOS.
3. If you must revert after merging to main, the safe path is `git revert` of the merge commit followed by a fresh restore on the Xamarin.Forms tree, then redeploy. There is no in-place "downgrade" of an SDK-style csproj back to the legacy shared-project layout.

If your release window does not tolerate a one-way migration, ship the MAUI build as a parallel application ID (`net.mycompany.myapp.maui`) on the stores for one cycle, get crash-free percentage above 99.5 % on production traffic, then flip the bundle ID with a forced update.

## Gotchas we hit

- **Android resource shrinking strips your fonts.** `Resources/Fonts/OpenSans-Regular.ttf` ends up under `Resources/font/opensans_regular.ttf` after the resizetizer rename. R8's resource shrinker happily removes fonts that look unreferenced from XAML. Fix by adding `<MauiAsset Include="Resources/Fonts/**/*.ttf" />` explicitly and disabling shrinking until the next release: `<AndroidLinkResources>false</AndroidLinkResources>` on Debug only.
- **iOS `Info.plist` `UIRequiredDeviceCapabilities` needs `arm64`.** The Mono-to-CoreCLR switch only ships ARM64 binaries. If `Info.plist` still lists `armv7`, App Store Connect rejects the upload.
- **`OnPlatform` markup extension behaves differently for `Default`**. In Xamarin.Forms an unspecified `Default` fell through to the platform value. In MAUI 11 `Default` is required to be set explicitly when used as the markup-extension form. Add a `Default` value, or switch to the `<OnPlatform>` element form.
- **`Frame` inside a `Grid` collapses to zero height.** The `Border` replacement does not inherit the `Frame` default of `HorizontalOptions="Fill"`. Be explicit: `HorizontalOptions="Fill" VerticalOptions="Fill"`.
- **`Microsoft.Maui.Controls.Compatibility` is not free.** It exists, and it lets you keep one or two stubborn renderers alive while you finish the migration, but every reference to `Compatibility` keeps the legacy renderer chain in your build and undoes part of the CoreCLR cold-start win. Use it as a bridge, not a destination.

## Related

- [Migrate a high-performance Xamarin.Forms ListView to MAUI CollectionView](/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Migrate from .NET Framework 4.8 to .NET 11 in 2026](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [MAUI vs Avalonia vs Uno in 2026](/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [Flutter vs React Native vs MAUI for a new mobile project in 2026](/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## Sources

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) on MS Learn.
- [.NET MAUI handlers documentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) covering the renderer replacement.
- [.NET MAUI 11.0 release notes](https://github.com/dotnet/maui/releases) on GitHub.
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) replacing `Application.Properties`.
- [CommunityToolkit.Mvvm messenger guide](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) replacing `MessagingCenter`.
