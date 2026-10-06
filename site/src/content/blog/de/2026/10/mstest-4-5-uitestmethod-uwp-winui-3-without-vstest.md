---
title: "MSTest 4.5 führt UWP- und WinUI-3-UI-Tests ohne VSTest aus"
description: "MSTest.Sdk 4.5 und Microsoft.Testing.Platform 2.5 machen die UWP- oder WinUI-3-App selbst zum Testhost. [UITestMethod] führt jeden Test auf dem echten Dispatcher aus, gepackte und AppContainer-Apps werden über einen Sidecar-Controller per AUMID aktiviert, und ungepackte WinUI-Apps funktionieren endlich."
pubDate: 2026-10-06
tags:
  - "mstest"
  - "winui"
  - "uwp"
  - "testing"
  - "dotnet"
lang: "de"
translationOf: "2026/10/mstest-4-5-uitestmethod-uwp-winui-3-without-vstest"
translatedBy: "claude"
translationDate: 2026-10-06
---

Am 5. Oktober 2026 veröffentlichte Amaury Levé ["UWP and WinUI 3 apps: UI testing with MSTest"](https://devblogs.microsoft.com/dotnet/testing-uwp-and-winui-3-apps-with-mstest/). Die Kurzfassung: Mit `MSTest.Sdk` 4.5 (das Microsoft.Testing.Platform 2.5 mitbringt) brauchen Windows-XAML-Apps VSTest nicht mehr, um Tests auszuführen. Kein `Microsoft.NET.Test.Sdk`, kein `vstest.console`, kein `UwpTestHostRuntimeProvider` aus der Visual-Studio-Installation.

Der letzte Punkt wiegt schwerer, als es klingt. VSTest leitete jedes `UseWinUI`-Projekt über diesen Provider, der `AppxManifest.xml` aus der Build-Ausgabe liest. Eine ungepackte WinUI-App hat kein Manifest und scheiterte daher mit `FileNotFoundException` ([testfx#2784](https://github.com/microsoft/testfx/issues/2784)). Unter MTP ist die App selbst der Testhost, das Problem entfällt also.

## Die App hostet die Plattform aus OnLaunched

Eine WinUI-App generiert ihr eigenes `Main` bereits aus `ApplicationDefinition`. `MSTest.Sdk` erkennt das, unterdrückt den eigenen Einstiegspunkt und generiert einen `MicrosoftTestingPlatformApplication.RunAsync`-Helper, den Sie aufrufen, sobald das Fenster existiert:

```csharp
using Microsoft.VisualStudio.TestTools.UnitTesting.AppContainer;

protected override async void OnLaunched(LaunchActivatedEventArgs args)
{
    _window = new Window();
    _window.Activate();
    UITestMethodAttribute.DispatcherQueue = _window.DispatcherQueue;

    try
    {
        Environment.ExitCode = await MicrosoftTestingPlatformApplication.RunAsync(
            Environment.GetCommandLineArgs()[1..]);
    }
    finally
    {
        _window.Close();
        Exit();
    }
}
```

Das generierte WinUI-`Main` liefert `void` zurück, weshalb der Exit-Code von Hand gesetzt wird. Wird das ausgelassen, meldet die CI einen grünen Lauf, egal was fehlgeschlagen ist.

## UITestMethod statt STATestMethod

`[STATestMethod]` liefert einen STA-Thread, aber keinen WinUI-Dispatcher, sodass das Erzeugen eines `Grid` darauf weiterhin eine Ausnahme wirft. `[UITestMethod]` sendet den gesamten MSTest-Aufruf an die veröffentlichte `DispatcherQueue`, einschließlich `[TestInitialize]` und `[TestCleanup]`:

```csharp
[UITestMethod]
public async Task GridCanBeCreatedOnTheUIThread()
{
    await Task.Yield();
    var grid = new Grid();
    Assert.IsTrue(grid.DispatcherQueue.HasThreadAccess);
}
```

Die interessante Zeile ist `await Task.Yield()`: Die Fortsetzung kehrt zum UI-Thread zurück, asynchrone Tests behalten also den Thread-Zugriff.

## Fünf App-Modelle, ein SDK

Der [testfx-Leitfaden](https://github.com/microsoft/testfx/blob/main/docs/winui-testing.md) behandelt klassisches UWP (`uap10.0`), modernes UWP auf .NET 10 mit `UseUwp`, gepacktes WinUI 3, ungepacktes WinUI 3 (`WindowsPackageType=None`) und WinUI 3 mit `TrustLevel="appContainer"`. Gepackte und sandboxed Apps lassen sich nicht mit `Process.Start` starten, daher führt MSBuild einen Sidecar-Controller mit Full Trust aus. Dieser registriert das Paket, aktiviert es per AUMID und sammelt nach dem Beenden TRX, Hang-Dumps und Retry-Ausgabe aus dem Speicher des Pakets ein. Für AppContainer gewährt die Controller-Pipe nur der exakten Paket-SID der App Zugriff und weist `ALL APPLICATION PACKAGES` ab.

Ein modernes UWP-Testprojekt sieht jetzt so aus:

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <UseUwp>true</UseUwp>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

Ungepackte und gepackte Full-Trust-Apps laufen mit `dotnet test --project MyWinUiTests.csproj -c Release -a x64`. UWP und AppContainer benötigen weiterhin das MSBuild von Visual Studio: `msbuild MyUwpTests.csproj /t:InvokeTestingPlatform /p:Platform=x64`.

## Bevor Sie 4.5.0 festschreiben

Der Beitrag legt `"MSTest.Sdk": "4.5.0"` in `global.json` fest, aber zum Zeitpunkt des Schreibens listet NuGet.org noch 4.4.1 als neuestes `MSTest.Sdk`. Prüfen Sie den Feed, bevor Sie die CI anheben. Planen Sie außerdem den CI-Agenten ein: Gepackte und AppContainer-Läufe benötigen den Entwicklermodus oder eine Sideloading-Richtlinie, AppContainer-Tests müssen ohne erhöhte Rechte laufen, und die Windows-App-SDK-Runtime muss auf dem Agenten installiert sein.

Wenn Sie bereits MTP für den [Native-AOT-Source-Generator in MSTest 4.4](/de/2026/09/mstest-4-4-native-aot-source-generation/) einsetzen, ist dies derselbe Runner, erweitert auf die letzten App-Modelle, die noch VSTest brauchten.
