---
title: "Fix: Unable to find a valid iOS Simulator runtime beim MAUI-Build"
description: "Xcode 15+ liefert keine iOS Simulator Runtimes mehr mit. MAUI bricht den Build ab, wenn für SupportedOSPlatformVersion keine passende Runtime installiert ist. Installieren Sie eine mit xcodebuild -downloadPlatform iOS oder über Xcode Settings, und prüfen Sie mit xcrun simctl list runtimes."
pubDate: 2026-05-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "ios"
  - "xcode"
  - "simulator"
lang: "de"
translationOf: "2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build"
translatedBy: "claude"
translationDate: 2026-05-16
---

Die Lösung: Ab Xcode 15 wird die iOS Simulator Runtime nicht mehr mit Xcode selbst ausgeliefert, und ab Xcode 26 wird auch die Runtime des vorherigen Xcode nicht mehr automatisch migriert. Die MAUI iOS Toolchain liest `SupportedOSPlatformVersion` aus Ihrem csproj, fragt Xcode nach einem Simulator dieser Version oder höher und bricht mit `Unable to find a valid iOS Simulator runtime` ab, wenn nichts passt. Führen Sie `xcrun simctl list runtimes` aus, um zu bestätigen, was tatsächlich installiert ist, und laden Sie dann entweder eine Runtime in Xcode unter Settings, Platforms, dem Plus-Button herunter oder erledigen Sie das headless mit `xcodebuild -downloadPlatform iOS`. Wenn `SupportedOSPlatformVersion` in Ihrer csproj höher ist als jede installierte Runtime, senken Sie den Wert auf eine vorhandene Version oder installieren Sie die passende Runtime.

```text
/usr/local/share/dotnet/packs/Microsoft.iOS.Sdk/18.2.9270/targets/Xamarin.Shared.Sdk.targets(1245,3):
error : Unable to find a valid iOS Simulator runtime. Please install one from Xcode > Settings > Platforms.

xcodebuild: error: Unable to find a destination matching the provided destination specifier:
        { platform:iOS Simulator, OS:18.2, name:iPhone 16 Pro }

Could not find the simulator runtime 'com.apple.CoreSimulator.SimRuntime.iOS-18-2'.
```

Diese Anleitung bezieht sich auf .NET 11 preview 4, MAUI 11 preview 4, Xcode 26.0 und `Microsoft.iOS.Sdk` 18.2.9270. Das Verhalten tritt seit dem Moment auf, in dem Apple die Simulator Runtimes mit Xcode 15 aus dem Xcode-Installer entkoppelt hat, und es wurde mit Xcode 26 deutlich sichtbarer, weil Apple den stillen Import des Runtime-Caches der vorherigen Xcode-Version beim ersten Start eingestellt hat. Wenn Sie kürzlich aktualisiert haben und Ihre Build-Pipeline anscheinend grundlos zu scheitern begann, ist das fast sicher die Ursache.

## Warum Xcode 15 MAUI iOS Builds gebrochen hat

Über die meiste Zeit der Xcode-Geschichte enthielt der Installer die iOS Simulator Runtime im selben `.xip`, das Sie aus dem Developer Portal heruntergeladen haben, was mit ein Grund dafür war, dass Xcode früher 7+ GB wog. Mit Xcode 15 hat Apple die Runtimes in ein separates Download-Modell ausgelagert: Die Xcode-App enthält die Toolchain (Compiler, SDKs, Header) und die iOS Simulator App selbst, aber jedes konkrete Runtime-Image (`iOS 17.4`, `iOS 18.2` und so weiter) ist ein separater Download, für den Sie sich entscheiden. Der Installer schrumpft auf etwa 3 GB, und Sie holen nur die Plattformen, die Sie brauchen.

Das ist großartig für den Speicherbedarf und schrecklich für den ersten Build. Ein MAUI-Projekt, das auf `net11.0-ios` zielt, löst das Target-SDK über `Microsoft.iOS.Sdk` auf, übergibt `xcodebuild` einen Destination-String mit Runtime-Version, und dann versucht `xcrun simctl create` oder `xcrun simctl boot`, eine passende Runtime in `~/Library/Developer/CoreSimulator/Profiles/Runtimes` und `/Library/Developer/CoreSimulator/Profiles/Runtimes` zu finden. Ohne installierte Runtime gelingt keiner dieser Aufrufe und Sie sehen die obige Fehlermeldung.

Xcode 26 hat eine weitere Eigenheit dazugebracht. Apple behandelt Runtimes nun komplett unabhängig vom Xcode-Bundle, und das neue `CoreSimulator` Framework führt pro Xcode eine Kompatibilitätsmatrix. Wenn Sie Xcode 16 mit installierter iOS 18.2 Simulator-Runtime hatten, dann auf Xcode 26 aktualisiert haben und Ihre csproj auf `iOS 19.0` zielt, liegt die 18.2-Runtime weiterhin auf der Platte, aber sie ist nicht das, was MAUI anfragt. Der Fehlertext bleibt gleich, deshalb verwirrt das beim Upgrade.

## Was MAUI tatsächlich anfragt

Wenn Sie `dotnet build -t:Run -f net11.0-ios -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-19-0,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"` ausführen, machen die MAUI iOS Targets in `Microsoft.iOS.Sdk` mehrere Dinge:

1. Sie lösen `SupportedOSPlatformVersion` und `_MtouchTargetiOSVersion` aus Ihrem Projekt auf.
2. Sie rufen `xcrun simctl list runtimes -j` auf, um zu ermitteln, was lokal installiert ist.
3. Sie wählen die erste Runtime, deren Version größer oder gleich Ihrem Target ist und zur Plattform passt (`iOS-Simulator`).
4. Passt nichts, wirft die MSBuild-Task den Fehler `Unable to find a valid iOS Simulator runtime`, noch bevor `xcrun simctl boot` aufgerufen wird.

Das ist in der `_DetectSimulator` Task in `Xamarin.Shared.Sdk.targets` implementiert. Fazit: Der Fehler bedeutet, dass Ihre Liste installierter Runtimes für die Plattform leer ist, oder dass jede installierte Runtime eine niedrigere Version hat als Ihr csproj-Target.

## Prüfen Sie, was wirklich installiert ist

Bevor Sie etwas in Ihrer csproj ändern, listen Sie die Runtimes auf:

```bash
# macOS, any shell
xcrun simctl list runtimes --json | jq '.runtimes[] | {name, version, identifier, isAvailable}'
```

Eine gesunde Maschine gibt etwas wie das hier aus:

```json
{
  "name": "iOS 19.0",
  "version": "19.0",
  "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  "isAvailable": true
}
```

Eine kaputte Maschine nach einem Xcode-Upgrade gibt entweder ein leeres `runtimes` Array aus oder Runtimes, die mit `"isAvailable": false` markiert sind und einen `availabilityError` String enthalten, der erklärt, dass die Runtime "incompatible with this version of Xcode" sei. Eine als nicht verfügbar markierte Runtime liegt zwar auf der Platte, aber Xcode verweigert ihre Nutzung, sodass MAUI sie als fehlend behandelt.

Sie sehen die gleichen Informationen auch in Xcode unter **Settings, Platforms**. Die Liste zeigt installierte Runtimes mit einem Haken und erlaubt das Installieren oder Entfernen jeder einzelnen.

## Installieren Sie die Runtime über die Kommandozeile

Wenn Sie headless arbeiten oder in CI sind, klicken Sie nicht durch die Xcode-UI. Xcode 15 hat ein `-downloadPlatform` Flag für `xcodebuild` eingeführt:

```bash
# Xcode 15+, downloads the latest iOS simulator runtime
# compatible with this Xcode version
xcodebuild -downloadPlatform iOS

# Xcode 16+, pin to a specific build of the runtime
xcodebuild -downloadPlatform iOS -buildVersion 18.2
```

Der Befehl läuft im Vordergrund, gibt einen Fortschritts-Prozentwert aus und schreibt die Runtime nach `~/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS <version>.simruntime`. Das sind ungefähr 8 GB pro Runtime, planen Sie das in CI entsprechend ein. Apple dokumentiert es in [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

Für ältere Xcode-Versionen (nur Xcode 15) lautet die alte Form `xcodebuild -downloadAllPlatforms`, die jede kompatible Plattform-Runtime herunterlädt. Sie ist deutlich schwerer als `-downloadPlatform iOS` und wird in CI fast nie gewünscht.

Brauchen Sie eine Runtime, die nicht zum Kompatibilitätssatz des aktuellen Xcode gehört, zum Beispiel iOS 17.4 zum Nachstellen eines Kundenbugs unter Xcode 26, installieren Sie sie aus einem heruntergeladenen `.dmg` oder `.simruntime`:

```bash
# Manually install a simruntime image from disk
xcrun simctl runtime add "/path/to/iOS 17.4.simruntime"
```

Das Subkommando `xcrun simctl runtime` existiert ab Xcode 16+ und ist der unterstützte Weg, eine separat heruntergeladene Runtime zu registrieren. Registrierte Runtime-Images listen Sie mit `xcrun simctl runtime list`.

## SupportedOSPlatformVersion auf das abstimmen, was Sie haben

Wenn Sie `iOS 18.2` installiert haben, Ihre csproj aber auf `iOS 19.0` zielt, wiederholt sich der Fehler. Öffnen Sie die iOS-spezifische Sektion Ihrer csproj und senken Sie entweder das Target oder akzeptieren Sie, dass Sie eine neuere Runtime brauchen:

```xml
<!-- .NET 11, MAUI 11, Microsoft.iOS.Sdk 18.2.9270 -->
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <SupportedOSPlatformVersion>15.0</SupportedOSPlatformVersion>
</PropertyGroup>
```

`SupportedOSPlatformVersion` ist die **minimale** iOS-Version, die Ihre App zur Laufzeit unterstützt. Die Simulator-Runtime, die Sie booten, muss größer oder gleich dieser Zahl sein. Der eigentliche Simulator, den MAUI standardmäßig startet, ist die installierte Runtime mit der höchsten Version, nicht das Minimum, das heißt mit installiertem iOS 19.0 startet Ihre App auf iOS 19.0, auch wenn der Projekt-Floor 15.0 ist.

Erhöhen Sie `SupportedOSPlatformVersion` nicht, um den Fehler stummzuschalten, das ist der falsche Hebel. Richtig ist, die Runtime zu installieren und das Projekt-Minimum dort zu lassen, wo es für Ihr Publikum tatsächlich stehen muss.

## Einen bestimmten Simulator aus dotnet build pinnen

Wenn Sie mehrere Runtimes installiert haben und eine bestimmte wollen, übergeben Sie `_DeviceName` an das iOS Run Target von MAUI. Das ist derselbe String, den `xcrun simctl` intern verwendet:

```bash
# .NET 11 preview 4, MAUI 11 preview 4
dotnet build -t:Run -f net11.0-ios \
  -p:_DeviceName=":v2:runtime=com.apple.CoreSimulator.SimRuntime.iOS-18-2,devicetype=com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
```

Das Präfix `:v2:` ist erforderlich, MAUI parst es als Device-Selector im neuen Format. Der Runtime-Identifier entspricht dem, was `xcrun simctl list runtimes` unter `identifier` ausgibt. Der Device-Type-Identifier entspricht dem, was `xcrun simctl list devicetypes` ausgibt.

Lassen Sie `_DeviceName` weg, wählt MAUI den neuesten installierten iPhone-Simulator mit der höchsten installierten Runtime. Für lokale Entwicklung ist das in Ordnung und in CI überraschend instabil, sobald eine neue Xcode-Punktversion ausgerollt wird.

## CI-spezifische Korrektur

Auf einem frischen `macos-15` oder `macos-26` Runner bei GitHub Actions ist Xcode vorinstalliert, aber die iOS Simulator Runtime, die zu Ihrer `SupportedOSPlatformVersion` passt, möglicherweise nicht. Die gehosteten Images von Apple enthalten eine oder zwei Runtimes; Build-Agents anderer Anbieter variieren. Das sichere Muster ist die explizite Installation vor `dotnet build`:

```yaml
# .github/workflows/maui-ios.yml
- name: Select Xcode
  run: sudo xcode-select -s /Applications/Xcode_26.0.app

- name: Install iOS 18.2 simulator runtime
  run: xcodebuild -downloadPlatform iOS -buildVersion 18.2

- name: Verify runtime is registered
  run: xcrun simctl list runtimes

- name: Build MAUI iOS
  run: dotnet build src/App/App.csproj -c Release -f net11.0-ios
```

Zwei Punkte sind hier tückisch. Erstens cacht der Runner nur zwischen Jobs, wenn Sie es explizit aktivieren, sonst lädt jeder Job 8 GB neu, falls Sie [`actions/cache`](https://github.com/actions/cache) nicht mit einem Schlüssel auf die Runtime-Version verdrahten. Zweitens schlägt `xcodebuild -downloadPlatform` nicht fehl, wenn die Runtime bereits installiert ist, holt aber die Metadaten erneut. Mit warmem Cache läuft der Befehl in Sekunden durch.

Wenn Ihr CI auf einem älteren Xcode läuft (Xcode 14 oder älter), gibt es `-downloadPlatform` nicht. Entweder aktualisieren Sie Xcode, oder Sie greifen auf ein Drittanbieter-Tool wie `xcodes` (`brew install xcodes`) und `sudo xcodes runtimes install "iOS 18.2"` zurück. Das von der Community gepflegte `xcodes` war vor Xcode 15 die einzige gute Antwort und ist immer noch nützlich, wenn Sie ältere Runtimes brauchen, die Apple nicht mehr im Developer Portal hostet.

## CoreSimulator Service hängt nach Upgrade

Manchmal ist die Runtime installiert, `xcrun simctl list runtimes` zeigt sie als verfügbar, und MAUI scheitert trotzdem. Die Ursache ist meist ein veralteter `CoreSimulatorService`, der die Runtime-Liste des Xcode vor dem Upgrade gecacht hat. Beenden Sie ihn:

```bash
sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

Der Dienst startet beim nächsten `xcrun simctl` Aufruf neu und liest das Runtime-Verzeichnis frisch ein. Das ist in mehreren `dotnet/macios` Issues dokumentiert, darunter [dotnet/macios#22243](https://github.com/dotnet/macios/issues/22243), und tritt vor allem nach `softwareupdate -ai` auf, das CoreSimulator ohne Neustart aktualisiert.

Falls das Beenden des Dienstes nicht hilft, leeren Sie zusätzlich `~/Library/Developer/CoreSimulator/Caches` und starten Sie neu. `CoreSimulator` führt einen Derived-Data-Cache, der gelegentlich auf einen gelöschten Runtime-Pfad zeigt.

## Wenn der falsche Xcode aktiv ist

Der andere häufige Fehlalarm: `xcode-select -p` zeigt auf ein anderes Xcode als das, in das Sie die Runtime installiert haben. Runtimes sind technisch über `CoreSimulator` an das aktive Xcode gebunden, und der Wechsel zwischen Xcodes kann das neue aktive Xcode ohne sichtbare Runtimes zurücklassen, auch wenn die Dateien existieren:

```bash
# Show the active Xcode
xcode-select -p
# /Applications/Xcode_26.0.app/Contents/Developer

# Switch to a specific Xcode
sudo xcode-select -s /Applications/Xcode_26.0.app
```

MAUI respektiert auch `DEVELOPER_DIR`. Exportiert ein CI-Schritt diese Variable, überschreibt sie `xcode-select`. Die Abweichung zwischen `xcode-select` und `DEVELOPER_DIR` ist einer dieser Bugs, der erst beim zweiten Pipeline-Lauf auftaucht, wenn eine gecachte Umgebungsvariable mit dem frischen Default eines Runners kollidiert. Der [MAUI Troubleshooting Guide](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0) dokumentiert die Auswahl-Reihenfolge für Xcode: `DEVELOPER_DIR`, dann veraltete plist-Dateien, dann `xcode-select -p`, dann `/Applications/Xcode.app`.

## Stolperfallen nach der Korrektur

Auch nach installierter Runtime gibt es noch Stolpersteine:

1. **Apple Silicon vs Intel Simulator Slices**. Die Simulator-Runtimes für iOS 17.0+ liefern nur die arm64-Slice. Auf einem Intel-Mac unter Rosetta können Sie sie nicht booten. Verwenden Sie eine ältere Runtime oder rüsten Sie den Build-Agent auf.
2. **Mac Catalyst Verwechslung**. `net11.0-maccatalyst` braucht keine Simulator-Runtime, das läuft nativ auf macOS. Scheitert ein Mac Catalyst Build mit diesem Fehler, haben Sie fast sicher ein verirrtes `net11.0-ios` Target im selben Projekt und Ihre IDE hat es ausgewählt.
3. **`-buildVersion` Mismatches**. `xcodebuild -downloadPlatform iOS -buildVersion 18.2` akzeptiert Marketingversionen wie `18.2`, keine internen Buildnummern wie `22C150`. Eine Buildnummer führt stillschweigend zum Download der neuesten Version.
4. **App Store Connect Uploads funktionieren weiterhin ohne Simulator**. Geräte-Builds (`-p:RuntimeIdentifier=ios-arm64`) brauchen die Simulator-Runtime gar nicht. Wenn Ihre CI nur an TestFlight ausliefert, können Sie die Installation komplett auslassen und nur die Signierung einrichten.

Wenn Sie im selben Projekt auch mit Build-Fehlern auf der Android-Seite kämpfen, taucht das gleiche Muster (Toolchain erwartet eine Komponente, die der Installer nicht mehr enthält) auch dort auf: siehe den Beitrag zum [Gradle-Fehler beim APK-Build unter MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/). Für ähnlich aussehende iOS-Fehler, die nicht mit Simulatoren zusammenhängen, deckt die [Korrektur der Geräte-Diskrepanz im Provisioning Profile](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) diesen Weg ab. Wenn Sie cross-platform Mobile in diesem Projekt komplett verlassen wollen, geht der Beitrag über [MAUI nur unter Windows und macOS](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) die Desktop-only Target-Frameworks durch. Für den Kontext der MAUI 11 Release-Welle erklärt der Beitrag zum [CoreCLR-Default für MAUI in .NET 11 preview 4](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), was sich unter der Haube geändert hat.

Die kürzeste Lösung ist fast immer `xcodebuild -downloadPlatform iOS` gefolgt von einem `dotnet build`. Die längere Lösung ist, diese eine Zeile in das CI-Skript zu schreiben, damit der nächste Agent im Team keinen Nachmittag damit verliert.

## Quellen

- [Downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Troubleshoot known issues - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [dotnet/macios#22243 - Can't find simulator when a particular iOS SDK version doesn't contain a simulator](https://github.com/dotnet/macios/issues/22243)
- [dotnet/maui#23352 - iOS build failed with iossimulator-x64 RuntimeIdentifier](https://github.com/dotnet/maui/issues/23352)
- [Build with a specific version of Xcode](https://learn.microsoft.com/en-us/dotnet/ios/cli)
