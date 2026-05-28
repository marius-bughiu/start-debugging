---
title: "Migration von Xamarin.Forms 5.0 zu .NET MAUI 11: die vollständige Checkliste"
description: "End-to-End-Migration von Xamarin.Forms 5.0 zu .NET MAUI 11 GA auf net11.0, einschließlich csproj-Umschreibung, Umwandlung von Custom Renderern in Handler, AppShell-Verkabelung, Entfernung von DependencyService, Rückzug von MessagingCenter, Resizetizer-Assets und den Fallstricken, die einen echten Produktionscode treffen."
pubDate: 2026-05-28
updatedDate: 2026-05-28
tags:
  - "migration"
  - "xamarin"
  - "xamarin-forms"
  - "maui"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/migrate-from-xamarin-forms-to-maui-11"
translatedBy: "claude"
translationDate: 2026-05-28
---

Xamarin.Forms ist seit 2024-05-01 ohne Support, und Microsoft hat seither keinen einzigen Fix mehr veröffentlicht. .NET MAUI 11 ist das LTS-Landeziel für jede Xamarin.Forms-5.0-App, die auf geliehener Zeit lebt. Mit MAUI 11.0 GA im November 2025 verfügt die Plattform endlich über die Renderer-Infrastruktur, die `RecyclerView`-Performance und die iOS 18 / Android 15 Target-Unterstützung, die den frühen MAUI-Releases fehlten. Eine fokussierte Einzelentwickler-Migration einer mittelgroßen App, zehn bis zwanzig Bildschirme mit einer Handvoll Custom Renderern, dauert zwischen einer und drei Wochen. Die schwierigen Teile sind nicht XAML und nicht das Build-System; es sind Custom Renderer, `DependencyService` und jeder Code, der die Plattformprojekte direkt angefasst hat. Dieser Beitrag fixiert `Xamarin.Forms 5.0.0.2622` als Quelle und `.NET MAUI 11.0.0` auf `net11.0` als Ziel, mit `net11.0-android35.0`, `net11.0-ios18.0` und `net11.0-maccatalyst18.0` als aktive TFMs.

Ein Rollback ist nicht trivial: Sobald die `.csproj` auf den SDK-Stil mit `Microsoft.NET.Sdk` und `UseMaui=true` umgestellt ist, gelangt man ohne Wiederherstellung der ursprünglichen csproj und `packages.config` aus der Versionskontrolle nicht zu einem Xamarin.Forms Shared Project zurück. Behandeln Sie die Migration als Einbahnstraße und planen Sie Ihre Branches entsprechend.

## Warum jetzt migrieren

- Xamarin.Forms hat keinen Support. Es gibt keine Patches für die Android-15-Target-SDK-Anhebung, die Google Play seit 2025-08-31 erzwingt, und Apple lehnt nun Builds ab, die im App Store Connect gegen das alte iOS-17-SDK gelinkt sind.
- MAUI 11 läuft auf Android und iOS standardmäßig auf CoreCLR, nicht auf Mono. Der Kaltstart auf einem Pixel 8 sinkt von rund 1.6 s auf 0.9 s bei einer Shell-Standard-App, und die Allokationen im stationären Zustand sinken, weil der GC generational statt `SGen` ist. Der Wechsel ist in [unserem Beitrag zu CoreCLR als MAUI-Standard](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) beschrieben.
- Die Handler-Architektur ersetzt Custom Renderer durch eine kleinere Oberfläche und vermeidet die `Effect` plus `PlatformEffect` Anbauten, die Xamarin.Forms über die Jahre angesammelt hat.
- Resizetizer ist integriert. Die `Resources/Images/*.svg`-Pipeline erzeugt die plattformspezifischen PNGs zum Build-Zeitpunkt, sodass Sie endlich den Zoo aus `drawable-xhdpi`, `drawable-xxhdpi`, `Assets.xcassets` und `LaunchScreen.storyboard` löschen.

## Was bricht

| Bereich                  | Änderung                                                                       | Schweregrad |
| ------------------------ | ------------------------------------------------------------------------------ | ----------- |
| Projektlayout            | Shared Project plus drei Head-Projekte fallen in eine SDK-style csproj zusammen | hoch       |
| `Xamarin.Forms`-Namespace| Ersetzt durch `Microsoft.Maui.Controls`, `Microsoft.Maui.Graphics`, etc.       | hoch        |
| Custom Renderer          | `ExportRenderer` und `IVisualElementRenderer` entfernt. Verwenden Sie Handler  | hoch        |
| `DependencyService`      | Entfernt. Verwenden Sie `Microsoft.Extensions.DependencyInjection`             | hoch        |
| `MessagingCenter`        | Veraltet und zur Entfernung vorgesehen. Verwenden Sie [CommunityToolkit.Mvvm `IMessenger`](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) | hoch |
| `Application.Properties` | Entfernt. Verwenden Sie `Microsoft.Maui.Storage.Preferences`                   | mittel      |
| `ListView`               | Wrapper über `CollectionView`. Migration empfohlen, siehe [die ListView-zu-CollectionView-Anleitung](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) | mittel |
| `MasterDetailPage`       | Umbenannt in `FlyoutPage`. XAML muss aktualisiert werden                        | niedrig     |
| `Frame`                  | Sanft veraltet. Verwenden Sie `Border` plus `StrokeShape`                       | niedrig     |
| `OpenGLView`             | Vollständig entfernt                                                            | niedrig     |
| Android `MainActivity`   | Teilt sich in `MainActivity.cs` plus `MainApplication.cs`, beide partial        | mittel      |
| iOS `AppDelegate`        | Ersetzt `FormsApplicationDelegate` durch `MauiUIApplicationDelegate`            | mittel      |
| `App.xaml.cs`            | `Application.MainPage` funktioniert in MAUI 11, aber Shell-first ist neu        | niedrig     |
| Targeting                | `MonoAndroid12.0`, `Xamarin.iOS10` sind weg. Nur `net11.0-android35.0`          | hoch        |

Der Upgrade Assistant von Microsoft wird als `dotnet tool` ausgeliefert und deckt einen erheblichen Teil der Namespace-Umschreibungen und der Projektdatei-Konvertierung ab. Er behandelt keine Custom Renderer und keine `DependencyService`-Registrierungen, und genau dort geht die eigentliche Zeit hin.

## Pre-Flight-Checkliste

1. Installieren Sie das .NET 11 SDK und die MAUI-Workloads. Prüfen Sie mit `dotnet workload list`. Sie wollen `maui`, `maui-android`, `maui-ios` und `maui-maccatalyst`, alle in Version `11.0.x`.

   ```bash
   # .NET 11.0
   dotnet workload install maui
   dotnet workload list
   ```

2. Fixieren Sie das SDK in `global.json`, damit der Migrationsbranch mitten im PR nicht still nach vorn rollt:

   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```

3. Taggen Sie den aktuellen Xamarin.Forms-Build in der Versionskontrolle. `git tag pre-maui-migration` reicht. Geht die Migration in Woche zwei schief, wollen Sie einen sauberen Restore-Punkt.
4. Snapshotten Sie die Plattform-Assets. Gehen Sie die `Drawable*`-Ordner, `Assets.xcassets`, Splash-Storyboards und die Info.plist / AndroidManifest.xml-Einträge durch. Resizetizer reorganisiert diesen ganzen Baum, und Sie wollen ein Vorher-Inventar haben, falls ein Asset verloren geht.
5. Inventarisieren Sie die `DependencyService`-Registrierungen. `grep -rn "DependencyService\\|Dependency(typeof" .` liefert die vollständige Liste. Jeder Eintrag wird zu einem `services.AddSingleton`- oder `services.AddTransient`-Aufruf.
6. Inventarisieren Sie die Custom Renderer. Grep nach `ExportRenderer` und lesen Sie jeden einzeln. Einige können ersatzlos entfernt werden (die MAUI-Defaults sind besser als die Xamarin.Forms-Defaults), andere werden zu Handlern, andere zu `Behaviors`.
7. Führen Sie `dotnet test` auf dem Xamarin.Forms-Baum aus und speichern Sie das grüne Baseline-Ergebnis. Eine Migration, die drei Test-Regressionen einführt, ist viel leichter zu diagnostizieren als eine, die auf einer Codebasis landet, die bereits fünf flaky Tests hatte.

## Migrationsschritte

1. **Lassen Sie den Upgrade Assistant zuerst auf dem Shared Project laufen.** Er schreibt die csproj auf SDK-Stil um, aktualisiert die offensichtlichsten Namespaces (`Xamarin.Forms` → `Microsoft.Maui.Controls`) und markiert die Renderer- und `DependencyService`-Stellen, die er nicht behandeln kann.

   ```bash
   # .NET 11
   dotnet tool install -g upgrade-assistant
   upgrade-assistant upgrade ./src/MyApp/MyApp.csproj --target-tfm net11.0
   ```

   Verifikation: `dotnet restore` ist auf der neuen csproj erfolgreich, und `git status` zeigt die erwarteten Umschreibungen. Lassen Sie ihn noch nicht auf den Head-Projekten laufen; die löschen Sie als Nächstes.

2. **Fassen Sie die Head-Projekte in einer einzigen SDK-style csproj zusammen.** Xamarin.Forms wird als ein Shared Project plus `MyApp.Android`, `MyApp.iOS` und optional `MyApp.UWP` Head-Projekt ausgeliefert. MAUI wird als eine csproj mit Multi-Targeting ausgeliefert. Verschieben Sie Android-spezifischen Code unter `Platforms/Android/`, iOS-spezifischen Code unter `Platforms/iOS/`, und löschen Sie die Head-csproj-Dateien. Der neue csproj-Header sieht so aus:

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

   Verifikation: `dotnet build -t:Restore` ist erfolgreich, und das Projekt lädt in Visual Studio 2026 17.14 oder Rider 2026.1 ohne "unsupported project type"-Warnungen.

3. **Schreiben Sie `App.xaml.cs` so um, dass es `MauiProgram.CreateMauiApp` verwendet.** Xamarin.Forms startete in `MainActivity.OnCreate` über `LoadApplication(new App())`. MAUI gibt das an den `MauiAppBuilder` weiter. Der Einstiegspunkt wird zu:

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

   Verifikation: `dotnet build -f net11.0-android35.0` endet mit 0, und die IDE löst `MauiProgram` aus jedem Page-Konstruktor auf.

4. **Konvertieren Sie jede `DependencyService`-Registrierung zu `IServiceCollection`.** Mechanisch, aber zwingend; `DependencyService.Get<T>()` ist in MAUI 11 weg. Der Ersatz:

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

   Wo Constructor Injection unpraktisch ist (ein statischer Helper, ein `AppShell`-Handler), ist `IPlatformApplication.Current!.Services.GetRequiredService<IAuthService>()` die Notausstiegsluke.

   Verifikation: `grep -rn "DependencyService" src/` liefert null Treffer. CI schlägt fehl, wenn das nicht so ist.

5. **Ersetzen Sie Custom Renderer durch Handler.** Dies ist der zeitintensivste Schritt. Ein Xamarin.Forms Custom Renderer, der `OnElementPropertyChanged` überschrieb, wird zu [einem MAUI-Handler mit einem `Mapper`-Dictionary](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/customize). Beispiel: ein Renderer, der die Unterstreichung eines Android-`Entry` entfernt:

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

   Registrieren Sie die Anpassung in `MauiProgram.CreateMauiApp` über `builder.ConfigureMauiHandlers(...)` oder rufen Sie `Apply()` aus einem `partial void` in `MauiProgram` heraus auf, damit sie nur unter Android läuft. Behalten Sie dasselbe Muster für iOS unter `Platforms/iOS/`.

   Verifikation: Jede Seite, die vom alten Renderer abhing, wird in `dotnet build -t:Run -f net11.0-android35.0` korrekt gerendert. Visueller Smoke-Test, nicht nur ein Build-Pass.

6. **Ziehen Sie `MessagingCenter` zugunsten des CommunityToolkit-Messengers zurück.** `MessagingCenter` ist in MAUI 11 als obsolet markiert und ist für die Entfernung in MAUI 12 vorgesehen. Übernehmen Sie `CommunityToolkit.Mvvm` 8.4.0 oder neuer:

   ```bash
   # .NET MAUI 11
   dotnet add package CommunityToolkit.Mvvm --version 8.4.0
   ```

   Der Musterwechsel:

   ```csharp
   // Before, Xamarin.Forms 5.0
   MessagingCenter.Subscribe<LoginViewModel>(this, "LoggedIn", _ => RefreshUi());
   MessagingCenter.Send(this, "LoggedIn");

   // After, .NET MAUI 11 with CommunityToolkit.Mvvm 8.4.0
   public sealed record LoggedInMessage;
   WeakReferenceMessenger.Default.Register<LoggedInMessage>(this, (r, m) => RefreshUi());
   WeakReferenceMessenger.Default.Send(new LoggedInMessage());
   ```

   Der `WeakReferenceMessenger` vermeidet die Lebenszyklus-Bugs, die `MessagingCenter` in langlebigen Shell-Apps lecken ließen.

7. **Verschieben Sie Assets zu Resizetizer.** Löschen Sie `Resources/drawable-*`, `Assets.xcassets` und die duplizierten Launch-Screens. Legen Sie eine `appicon.svg` und eine `splash.svg` unter `Resources/AppIcon/` und `Resources/Splash/` ab. Die csproj kennt sie bereits über die `MauiIcon`- und `MauiSplashScreen`-Items, die der Upgrade Assistant emittiert hat. Der Build-Zeit-Resize ersetzt die gesamte Dichteleiter.

   ```xml
   <!-- src/MyApp/MyApp.csproj fragment -->
   <ItemGroup>
     <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
     <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
     <MauiImage Include="Resources\Images\*" />
     <MauiFont Include="Resources\Fonts\*" />
   </ItemGroup>
   ```

   Verifikation: `dotnet build -f net11.0-android35.0` erzeugt `bin/Debug/net11.0-android35.0/Resources/drawable-xxhdpi/appicon.png`, ohne dass Sie ihn handgemacht haben.

8. **Aktualisieren Sie Android `MainActivity` und `MainApplication`.** Xamarin.Forms hatte eine `MainActivity`, die von `FormsAppCompatActivity` abgeleitet war. MAUI teilt das in `MainActivity` plus `MainApplication`:

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

   Unter iOS ist das Äquivalent ein `AppDelegate`, das von `MauiUIApplicationDelegate` ableitet. Das Muster ist identisch: `CreateMauiApp` überschreiben und das gemeinsame `MauiProgram` aufrufen.

9. **Konvertieren Sie XAML-Namespaces.** Jedes `xmlns="http://xamarin.com/schemas/2014/forms"` wird zu `xmlns="http://schemas.microsoft.com/dotnet/2021/maui"`. Der Upgrade Assistant erledigt den Großteil, aber Dateien mit gemischten Namespaces (Custom-Control-Bibliotheken, die `xamarin.toolkit` einbezogen) brauchen einen manuellen Durchgang. `Frame` funktioniert noch eine Release weiter, erzeugt aber eine Build-Warnung. Planen Sie den Ersatz durch `Border` plus `StrokeShape="RoundRectangle 12"` und ein `BackgroundColor`. `MasterDetailPage` muss sowohl in XAML als auch im Code-Behind in `FlyoutPage` umbenannt werden, inklusive aller `x:TypeArguments`.

10. **Auditieren Sie `Application.Properties` zu `Preferences`.** Jeder Code, der `Application.Current.Properties["key"] = value` schrieb, muss zu `Preferences.Set("key", value)` aus `Microsoft.Maui.Storage` wechseln. Die Form ist ähnlich, aber das Storage-Backend unterscheidet sich, weshalb Sie beim ersten Start eine einmalige Kopie brauchen können. Machen Sie die Kopie mit einem `"migrated_to_preferences"`-Flag idempotent, damit sie nicht erneut läuft.

11. **Fixieren Sie jede NuGet-Abhängigkeit auf eine MAUI-kompatible Version.** Führen Sie `dotnet list package --vulnerable` und `dotnet list package --outdated` nach dem Upgrade aus. Übliche Verdächtige: `Xamarin.Essentials` (weg, in MAUI integriert), `Xamarin.Forms.Maps` (ersetzt durch `Microsoft.Maui.Controls.Maps`), `Xamarin.Forms.Visual.Material` (ersetzt durch die Material-3-Styles von MAUI, siehe [den Beitrag zu Material 3 in MAUI 10](/de/2026/05/maui-10-material-3-android-usematerial3-flag/)).

## Verifikation

Nach den obigen Schritten:

- `dotnet restore` endet mit 0 in einem sauberen Clone des Migrationsbranches.
- `dotnet build -f net11.0-android35.0` und `-f net11.0-ios18.0` enden beide mit 0.
- Das Unit-Test-Projekt, auf `net11.0` umgestellt, läuft `dotnet test` auf sauberem Grün.
- `dotnet build -t:Run -f net11.0-android35.0` startet die App in einem Emulator und erreicht die erste Seite ohne unbehandelte Ausnahme.
- Manueller Smoke-Test auf einem echten Gerät für jede Seite, die im Xamarin.Forms-Baum einen Custom Renderer enthielt.
- Vergleichen Sie die Kaltstartzeit vor und nach der Umstellung mit einer Stoppuhr vom Launcher-Tap bis zum ersten Frame. CoreCLR plus AOT sollten eine mittelgroße App auf einem Android-Mittelklassegerät von 2024 unter eine Sekunde bringen. Bei Regression prüfen Sie Schritt 5 erneut; ein Handler, der Layout-Arbeit synchron auf dem UI-Thread erledigt, ist meist der Schuldige.

## Rollback-Plan

Sobald die csproj umgeschrieben ist, gibt es kein automatisiertes Rollback. Der realistische Plan ist:

1. Behalten Sie den `pre-maui-migration`-Git-Tag aus der Pre-Flight-Checkliste.
2. Halten Sie die Migration auf ihrem eigenen Branch, bis die Verifikation auf Android und iOS grün ist.
3. Müssen Sie nach dem Merge in main zurückgehen, ist der sichere Weg `git revert` des Merge-Commits, gefolgt von einer sauberen Wiederherstellung des Xamarin.Forms-Baums und einem Redeploy. Es gibt keinen In-Place-"Downgrade" einer SDK-style csproj zurück zum Legacy-Shared-Project-Layout.

Toleriert Ihr Release-Fenster keine Einbahn-Migration, veröffentlichen Sie den MAUI-Build als App mit paralleler ID (`net.mycompany.myapp.maui`) in den Stores für einen Zyklus, erreichen eine Crash-Free-Rate über 99.5 % auf Produktionsverkehr und wechseln dann die Bundle-ID mit einem erzwungenen Update.

## Stolperfallen aus der Praxis

- **Das Android-Resource-Shrinking entfernt Ihre Schriftarten.** `Resources/Fonts/OpenSans-Regular.ttf` landet nach dem Resizetizer-Rename unter `Resources/font/opensans_regular.ttf`. Der R8-Resource-Shrinker entfernt fröhlich Schriftarten, die aus XAML unreferenziert aussehen. Beheben Sie das, indem Sie `<MauiAsset Include="Resources/Fonts/**/*.ttf" />` explizit ergänzen und das Shrinking bis zum nächsten Release deaktivieren: `<AndroidLinkResources>false</AndroidLinkResources>` nur im Debug.
- **`UIRequiredDeviceCapabilities` in iOS `Info.plist` braucht `arm64`.** Der Mono-zu-CoreCLR-Wechsel liefert nur ARM64-Binaries. Listet `Info.plist` weiterhin `armv7`, lehnt App Store Connect den Upload ab.
- **Die Markup-Extension `OnPlatform` verhält sich für `Default` anders**. In Xamarin.Forms fiel ein nicht angegebenes `Default` auf den Plattformwert zurück. In MAUI 11 muss `Default` bei Verwendung als Markup-Extension-Form explizit gesetzt sein. Ergänzen Sie einen `Default`-Wert oder wechseln Sie zur Elementform `<OnPlatform>`.
- **Ein `Frame` innerhalb eines `Grid` kollabiert auf Höhe null.** Der `Border`-Ersatz erbt nicht den Default `HorizontalOptions="Fill"` von `Frame`. Seien Sie explizit: `HorizontalOptions="Fill" VerticalOptions="Fill"`.
- **`Microsoft.Maui.Controls.Compatibility` ist nicht umsonst.** Es existiert und lässt Sie ein, zwei sture Renderer am Leben halten, während Sie die Migration abschließen, aber jede Referenz auf `Compatibility` hält die Legacy-Renderer-Kette in Ihrem Build und macht einen Teil des CoreCLR-Kaltstart-Gewinns zunichte. Verwenden Sie es als Brücke, nicht als Ziel.

## Verwandt

- [Migration einer hochperformanten Xamarin.Forms ListView zu MAUI CollectionView](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/)
- [Migration von .NET 8 zu .NET 11: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Migration von .NET Framework 4.8 zu .NET 11 im Jahr 2026](/de/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/)
- [MAUI vs Avalonia vs Uno im Jahr 2026](/de/2026/05/maui-vs-avalonia-vs-uno-in-2026/)
- [Flutter vs React Native vs MAUI für ein neues Mobile-Projekt im Jahr 2026](/de/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/)

## Quellen

- [.NET MAUI upgrade from Xamarin.Forms](https://learn.microsoft.com/en-us/dotnet/maui/migration/) auf MS Learn.
- [.NET MAUI Handler-Dokumentation](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/handlers/) zum Renderer-Ersatz.
- [.NET MAUI 11.0 Release Notes](https://github.com/dotnet/maui/releases) auf GitHub.
- [`Microsoft.Maui.Storage.Preferences`](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences) als Ersatz für `Application.Properties`.
- [CommunityToolkit.Mvvm Messenger Guide](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/mvvm/messenger) als Ersatz für `MessagingCenter`.
