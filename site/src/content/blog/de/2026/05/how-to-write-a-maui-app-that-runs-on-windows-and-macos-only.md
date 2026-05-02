---
title: "Wie Sie eine MAUI-App schreiben, die nur auf Windows und macOS läuft (ohne Mobile)"
description: "Entfernen Sie Android und iOS aus einem .NET MAUI 11-Projekt, sodass nur Windows und Mac Catalyst veröffentlicht werden: die csproj-Änderungen, die Workload-Befehle und das Multi-Targeting, das Ihren Code sauber hält."
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only"
translatedBy: "claude"
translationDate: 2026-05-02
---

Kurze Antwort: Öffnen Sie Ihre `.csproj`, löschen Sie die Android- und iOS-Einträge aus `<TargetFrameworks>` und lassen Sie nur `net11.0-windows10.0.19041.0` und `net11.0-maccatalyst` stehen. Löschen Sie anschließend `Platforms/Android`, `Platforms/iOS` und `Platforms/Tizen`, falls vorhanden. Entfernen Sie die passenden `<ItemGroup>`-Einträge für MAUI-Bildressourcen, die auf reine Mobile-Icons verweisen, deinstallieren Sie die Workloads `maui-android` und `maui-ios`, wenn Sie eine saubere Maschine wollen, und Ihr Single-Project-Layout, `MauiProgram`, das XAML Hot Reload und die Resource-Pipeline funktionieren weiterhin. `dotnet build -f net11.0-windows10.0.19041.0` erzeugt ein MSIX, `dotnet build -f net11.0-maccatalyst` (auf macOS ausgeführt) erzeugt ein `.app`, und nichts versucht jemals wieder, einen Android-Emulator hochzufahren.

Dieser Artikel führt durch die exakten Anpassungen für .NET MAUI 11.0.0 auf .NET 11, was sich gefahrlos löschen lässt und was nicht, die subtilen Multi-Targeting-Fallstricke beim Entfernen von Plattform-Heads und die Workload- und CI-Änderungen, die tatsächlich Zeit sparen. Alles unten wurde gegen `dotnet new maui` aus dem .NET 11 SDK verifiziert und gilt unverändert für ein Xamarin.Forms-Projekt, das bereits zu MAUI migriert wurde.

## Warum überhaupt einen reinen Desktop-MAUI-Head ausliefern

Es gibt eine konstante Gruppe von Line-of-Business-Teams, die MAUI wegen seines XAML- und Binding-Modells wählen, nicht wegen der mobilen Reichweite. Interne Admin-Tools, Kiosk-Apps, Point-of-Sale-Clients, Fertigungs-Dashboards und Field-Service-Apps, bei denen das Feld "ein Surface und ein MacBook" ist, passen alle hier hinein. Diese Teams zahlen reale Kosten für die Mobile-Heads, die sie nie ausliefern: Jeder `dotnet build` wertet vier Targets aus, jedes NuGet-Restore zieht die Reference Packs für Android und iOS, jeder CI-Runner braucht eine Android-Workload, und jedes Entwickler-Onboarding stößt auf eine Xcode- und Android-Studio-Abhängigkeit, bevor sich die App überhaupt starten lässt.

Die Mobile-Heads zu entfernen ist nicht das Standard-Visual-Studio-Template, wird aber vom SDK vollständig unterstützt. Das Build-System liest `<TargetFrameworks>` und emittiert nur die deklarierten Heads. Es gibt keinen Schalter, den Sie in MAUI selbst umlegen müssen. Die Reibung steckt vollständig in der Projektdatei, im `Platforms/`-Ordner und in den bedingten MSBuild-Items, die das Template für Mobile-Assets hinzufügt.

## Die TargetFrameworks-Anpassung

Ein frisches `dotnet new maui -n DesktopApp` mit dem .NET 11 SDK erzeugt ein Projekt, das mit dieser einleitenden `PropertyGroup` öffnet:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Ersetzen Sie die beiden `<TargetFrameworks>`-Zeilen durch eine einzelne, explizite Liste:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

Zwei Dinge sind hier wichtig. Erstens bleibt der bedingte `IsOSPlatform('windows')`-Block erhalten, weil sich der Windows-Head nur unter Windows kompilieren lässt, genauso wie sich Mac Catalyst nur unter macOS kompilieren lässt. Ohne die Bedingung würde ein Entwickler unter macOS bei `dotnet build` mit "The Windows SDK is not available." scheitern. Zweitens ist das Versions-Suffix in `net11.0-windows10.0.19041.0` die Windows-10-SDK-Version, die MAUI für WinUI verlangt; entfernen Sie das Suffix nicht und ändern Sie es auch nicht zu `net11.0-windows10.0` allein, weil die WinAppSDK-Targets genau auf diesen Moniker pinnen.

Wenn Sie nur macOS wollen, lassen Sie die Windows-Zeile komplett weg. Wenn Sie nur Windows wollen, lassen Sie die Mac-Catalyst-Zeile und die Bedingung weg. Die `<TargetFramework>`-Form (Singular) funktioniert ebenfalls, falls Sie wirklich nur einen Head haben, und liefert einen einzelnen unbedingten Wert, mit dem manche Werkzeuge eleganter umgehen. Für eine echte Cross-Desktop-App behalten Sie die Multi-Target-Form bei.

## Was in `Platforms/` zu löschen ist

Das MAUI-Template legt Ihnen `Platforms/Android`, `Platforms/iOS`, `Platforms/MacCatalyst`, `Platforms/Tizen` und `Platforms/Windows` an. Jeder Ordner enthält eine kleine Menge plattformspezifischen Bootstrap-Codes: ein `AppDelegate` für Apple-Plattformen, ein `MainActivity` und `MainApplication` für Android, ein `App.xaml` plus `Package.appxmanifest` für Windows und ein `Application.cs` für Mac Catalyst.

Für reines Desktop löschen Sie `Platforms/Android`, `Platforms/iOS` und `Platforms/Tizen` direkt. Sie werden nicht verwendet. Behalten Sie `Platforms/MacCatalyst` und `Platforms/Windows`. Fassen Sie den `Resources/`-Ordner überhaupt nicht an; das ist die Single-Project-Asset-Pipeline, und sie bedient alle Heads.

Nach dem Löschen sieht das Layout so aus:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

Das ist der vollständige Quellbaum einer reinen Desktop-MAUI-11-App.

## Mobile-only-Bildressourcen-Items entfernen

Wenn Sie das Standard-Template verwendet haben, enthält Ihre `.csproj` gegen Ende einen Block wie diesen:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

Diese sind plattformunabhängig und bleiben unverändert. Die Single-Project-Resource-Pipeline rendert das SVG zur Build-Zeit nur für die deklarierten Heads in plattformspezifische PNGs. Wenn Sie Android entfernen, werden keine Android-Dichten mehr emittiert; dieselbe `Resources/AppIcon/appicon.svg`-Datei speist das `AppIcon.icns` von Mac Catalyst und das `Square150x150Logo.scale-200.png` von Windows, und mehr brauchen Sie nicht.

Wenn Ihr Projekt vor .NET 9 entstanden ist, haben Sie eventuell auch explizite `<AndroidResource>`- oder `<BundleResource>`-Items aus einer Xamarin.Forms-Migration. Löschen Sie sie. Sie werfen keinen Fehler, wenn Sie sie stehenlassen, aber sie verrauschen die Build-Ausgabe, und Sie bekommen "file not found"-Warnungen, falls die referenzierten Dateien nicht mehr existieren.

## Multi-Targeting für Ihren eigenen Code ohne `#if ANDROID`

Das MAUI-Template bringt einige Muster für plattformspezifischen Code mit: `partial`-Klassen, die über `Platforms/<head>/`-Dateien aufgeteilt sind, und `#if`-Direktiven. Ohne Android und iOS müssen Sie nur Windows und Mac Catalyst behandeln. Die Präprozessor-Symbole, die Sie tatsächlich verwenden, sind:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

Mehr ist es nicht. `ANDROID` und `IOS` sind weiterhin definierte Symbole, wenn diese Heads in `<TargetFrameworks>` enthalten sind, aber da sie es nicht sind, kompilieren diese Zweige schlicht nie. Sie können jeden `#if ANDROID`- und `#if IOS`-Block in Ihrem Code in einem separaten Bereinigungslauf gefahrlos löschen.

Wenn Sie Implementierungen über Dateinamen aufteilen (das [offizielle Multi-Targeting-Muster, das für MAUI dokumentiert ist](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)), sollten die bedingten `<ItemGroup>`-Blöcke die Android- und iOS-Zweige verlieren:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

Zwei Regeln statt fünf. Dieselbe Logik gilt für ordnerbasiertes Multi-Targeting; behalten Sie nur die Ordner-Regeln für `MacCatalyst` und `Windows`.

## Workloads: installieren, was Sie bauen, deinstallieren, was Sie nicht bauen

Das ist die Änderung, die sich auf einem CI-Runner am schnellsten auszahlt. Das MAUI-Workload-Manifest ist in mehrere Sub-Workloads aufgeteilt:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

Für ein reines Desktop-Projekt brauchen Sie genau diese beiden auf dem jeweiligen Runner. Die Schirm-Workload `maui` ist nicht nötig, sie zieht Android und iOS als transitive Workload-Abhängigkeiten mit. Auf einem CI-Image, auf dem `maui` bereits installiert war, führen Sie aus:

```bash
dotnet workload uninstall maui-android maui-ios
```

Der Mac-Catalyst-Head auf macOS verlangt weiterhin Xcode, da `mlaunch` und die Apple-Toolchain die eigentliche `.app`-Konstruktion übernehmen. Sie brauchen kein Android SDK, kein Java-JDK und keinerlei iOS-Geräte-Deployment-Abhängigkeiten. Unter Windows verlangt der Windows-Head das Windows App SDK und das Windows-10-SDK in der in `<TargetFrameworks>` gepinnten Version. Der Befehl `dotnet workload install maui-windows` zieht beides.

Die CI-Ersparnis ist real. Ein Linux-Runner, der bisher Android-Workloads und Emulator-Images für einen gehosteten Linux-Build einer MAUI-App bereitgestellt hat, nur um sie am CI-Gate zu überspringen, kann diese Schritte vollständig streichen; der Build ignoriert Linux nun, und Sie führen zwei separate Jobs aus, einen pro Betriebssystem.

## Jeden Head bauen und veröffentlichen

`dotnet build` und `dotnet publish` nehmen ein explizites `-f`-Framework-Argument entgegen, damit Sie nicht versehentlich versuchen, einen Head auf dem falschen Host zu bauen:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

Der Windows-Head emittiert ein `.msix`-Paket oder, mit `WindowsPackageType=None`, ein unverpacktes Win32-Verzeichnis. Der Mac-Catalyst-Head emittiert ein `.app` und, mit `CreatePackage=true`, einen `.pkg`-Installer. Das Code Signing ist bei beiden ein eigenes Thema: ein Authenticode-Zertifikat für das MSIX und eine Apple Developer ID für das `.pkg`. Keiner der Wege braucht ein Provisioning Profile, also den iOS-spezifischen Tanz, dem Sie gerade entkommen sind.

Wenn Sie zusätzlich Native AOT für die Desktop-Heads wollen, unterstützt der WinUI-Head von MAUI das auf .NET 11 mit Einschränkungen, ähnlich dem [Native-AOT-Pfad für ASP.NET Core Minimal APIs](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/). Mac Catalyst unterstützt vollständiges Native AOT in MAUI 11 noch nicht; es wird mit Mono-AOT für Apple-Plattformen ausgeliefert.

## Fallstricke, die man im Kopf behalten sollte

Das Visual-Studio-Template "Add new MAUI Page" fügt in manchen Szenarien stillschweigend wieder einen `<ItemGroup Condition="...android..."/>`-Block hinzu. Beobachten Sie Ihre csproj-Diffs. Wenn Sie eine saubere Desktop-only-csproj einchecken und ein Teamkollege über die IDE eine neue View hinzufügt, kann der Diff die bedingten Android- und iOS-Items wiederbeleben, obwohl `<TargetFrameworks>` diese Targets nicht mehr enthält. Diese verwaisten Items sind harmlos, sammeln aber Rauschen an.

NuGet-Pakete, die für reine Mobile-APIs auf `Xamarin.AndroidX.*` oder `Microsoft.Maui.Essentials` setzen, werden trotzdem restored. Der Paketmanager löst gegen die deklarierten Targets auf, und ein reines Mobile-Paket ohne kompatibles Asset für `net11.0-windows10.0` oder `net11.0-maccatalyst` schlägt mit `NU1202` fehl. Die Lösung ist, das Paket zu entfernen; ist es eine transitive Abhängigkeit von etwas, das Sie tatsächlich verwenden, öffnen Sie ein Issue beim Upstream-Paket und pinnen Sie auf eine Version, die Desktop-Targets explizit unterstützt.

XAML Hot Reload funktioniert auf beiden Desktop-Heads in .NET 11. Der startende Debugger muss das Host-OS des Heads sein: Aus Visual Studio unter Windows lässt sich keine Mac-Catalyst-Sitzung debuggen. Rider auf macOS bedient beide Heads aus einem einzigen Workspace, und genau das ist der Workflow, auf den sich die meisten Cross-Desktop-Teams einpendeln.

Die MAUI-Essentials-APIs, die explizit nur für Mobile gedacht sind (Geocoding, Kontakte, Sensoren, Telefonie), werfen unter Windows und Mac Catalyst zur Laufzeit `FeatureNotSupportedException`. Sie scheitern nicht zur Compile-Zeit. Verpacken Sie die Nutzung dieser APIs hinter einer Capability-Prüfung oder einer desktop-sicheren Abstraktion. Dasselbe gilt für MAUI Maps vor den [Pin-Clustering-Änderungen, die in .NET MAUI 11](/de/2026/04/dotnet-maui-11-map-pin-clustering/) angekommen sind; die Desktop-Heads verwenden unter der Haube ein anderes Map-Control als die Mobile-Heads, und die Feature-Parität ist nicht perfekt.

Falls Sie die Mobile-Heads jemals wieder hinzufügen müssen (ein Kunde fragt nach einer iPad-Version), lassen sich die Änderungen sauber rückgängig machen: Tragen Sie die Einträge in `<TargetFrameworks>` wieder ein, restaurieren Sie die Ordner `Platforms/Android` und `Platforms/iOS` aus einem frischen `dotnet new maui`-Template und installieren Sie die Workloads neu. Das Single-Project-Layout, Ihr XAML, Ihre View Models und Ihre Resource-Pipeline werden ohne Änderungen übernommen. Die Desktop-only-Konfiguration ist eine strikte Untermenge des Vier-Heads-Templates, kein Fork.

## Verwandt

- [.NET MAUI 11 liefert einen eingebauten LongPressGestureRecognizer](/de/2026/04/maui-11-long-press-gesture-recognizer/)
- [Pin Clustering kommt in den Maps von .NET MAUI 11 an](/de/2026/04/dotnet-maui-11-map-pin-clustering/)
- [Wie Sie Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [Wie Sie die Cold-Start-Zeit eines AWS Lambda unter .NET 11 reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Quell-Links

- [.NET MAUI Multi-Targeting konfigurieren (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [Target Frameworks in SDK-style-Projekten (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Bekannte Probleme bei .NET MAUI beheben (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [`dotnet/maui`-Issue 11584 zum Entfernen des Mac-Catalyst-Targets](https://github.com/dotnet/maui/issues/11584)
