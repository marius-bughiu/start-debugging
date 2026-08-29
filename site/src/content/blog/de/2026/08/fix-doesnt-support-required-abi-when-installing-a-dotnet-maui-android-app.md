---
title: "Fix: Doesn't support required ABI beim Installieren einer .NET MAUI Android-App"
description: "Das APK enthält keine native Bibliothek für die CPU des Geräts. Seit .NET 9 sind die Standard-RuntimeIdentifiers für Android nur noch 64-Bit, die Lösung ist also, RuntimeIdentifiers explizit zu setzen. Behandelt ADB0020, XA0036, NETSDK1083, die Zuordnung von ABI zu RID, den Wortlaut in der Play Console und warum das überall kopierte Snippet mit vier RIDs unter .NET 11 nicht mehr funktioniert."
pubDate: 2026-08-29
template: error-page
tags:
  - "errors"
  - "maui"
  - "dotnet"
  - "android"
  - "dotnet-11"
  - "coreclr"
lang: "de"
translationOf: "2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-08-29
---

Das App-Paket enthält keine native Bibliothek für die CPU des Geräts, auf dem du installierst. Android verweigert die Installation, statt das falsche Binary auszuführen. Seit .NET 9 baut ein Projekt mit `net9.0-android` oder neuer nur noch `arm64-v8a` und `x86_64`, während dasselbe Projekt unter .NET 8 vier ABIs gebaut hat. Auslöser ist deshalb meist ein Upgrade und nicht eine Änderung von dir. Behoben wird das, indem du `$(RuntimeIdentifiers)` für das Android-Zielframework setzt. Welche RIDs richtig sind, hängt von deiner .NET-Version ab, denn .NET 11 hat Android x86 vollständig entfernt, wodurch das Snippet mit vier RIDs aus den meisten Suchergebnissen jetzt den Build zum Scheitern bringt.

## Der Fehler im Kontext

Dieselbe Ursache zeigt sich in drei verschiedenen Formulierungen, je nachdem, wer installiert.

Beim Deployment aus Visual Studio oder über `dotnet build -t:Run` bekommst du einen Buildfehler von .NET for Android:

```
error ADB0020: The package does not support the CPU architecture of this device.
```

Installierst du das APK selbst mit `adb` aus dem Android SDK, meldet es den darunterliegenden Fehler:

```
adb: failed to install com.company.app-Signed.apk:
Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]
```

ADB0020 ist genau die Übersetzung davon durch .NET for Android, zuzüglich des älteren `INSTALL_FAILED_CPU_ABI_INCOMPATIBLE`. Die Google Play Console formuliert es in Begriffen des Gerätekatalogs, und daher stammt die Rede von der "required ABI":

```
Doesn't support required ABI: arm64-v8a, x86_64
```

Auf dem Telefon einer Nutzerin oder eines Nutzers erscheint derselbe Zustand als "Dein Gerät ist mit dieser Version nicht kompatibel" im Play Store oder als schlichtes "App nicht installiert" bei einem per Sideload eingespielten APK.

## Welches ABI will das Gerät überhaupt?

Frag es. Jedes Android-Gerät und jeder Emulator veröffentlicht die unterstützten ABIs in Prioritätsreihenfolge:

```bash
adb shell getprop ro.product.cpu.abilist
```

Ein modernes Telefon antwortet mit `arm64-v8a,armeabi-v7a`. Ein reines 64-Bit-Gerät antwortet mit `arm64-v8a`. Ein Emulator-Image auf einem Apple-Silicon-Mac antwortet mit `arm64-v8a`, und ein x86_64-Image von Google antwortet nur dann zusätzlich mit `arm64-v8a`, wenn es ARM-Übersetzung mitbringt, worauf man sich nicht verlassen sollte.

Frag anschließend das Paket, was es mitbringt. Die nativen Bibliotheken liegen im APK unter `lib/<abi>/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.apk | grep 'lib/'
```

```text
lib/arm64-v8a/libmonodroid.so
lib/arm64-v8a/libSystem.Native.so
lib/x86_64/libmonodroid.so
lib/x86_64/libSystem.Native.so
```

Bei einem App Bundle lautet das Präfix stattdessen `base/lib/`:

```bash
unzip -l bin/Release/net11.0-android/com.company.app-Signed.aab | grep 'base/lib/'
```

Die Schnittmenge dieser beiden Listen ist leer. Genau das ist der Fehler. Die Auflistung oben installiert sich auf einem Apple-Silicon-Emulator und auf einem modernen Telefon und scheitert auf jedem Gerät, dessen `abilist` nur `armeabi-v7a` enthält.

## Was sich in .NET 9 geändert hat

.NET 8 und früher haben standardmäßig alle vier Android-ABIs gebaut. .NET 9 hat die Standardwerte von `$(RuntimeIdentifiers)` für Android auf das 64-Bit-Paar eingeengt:

```text
net8.0-android    armeabi-v7a  arm64-v8a  x86  x86_64
net9.0-android                 arm64-v8a       x86_64
net10.0-android                arm64-v8a       x86_64
net11.0-android                arm64-v8a       x86_64
```

Die Begründung: .NET folgt den Plattformherstellern, und Google verlangt für Play-Einreichungen seit 2019 einen 64-Bit-Build. Zur Buildzeit warnt dich nichts, denn aus Sicht des Builds ist nichts falsch. Du erfährst es, wenn jemand aus dem Testteam auf einem älteren Gerät nicht installieren kann oder wenn der Gerätekatalog der Play Console stillschweigend mehrere Tausend Gerätemodelle von deiner Liste streicht.

Wenn deine App ein Hobbyprojekt ist oder auf aktuelle Hardware zielt, ist der neue Standard der richtige und du solltest ihn so lassen. Zwei 64-Bit-ABIs statt vier halbieren ein MAUI-APK ungefähr.

## Die Lösung

Setze `$(RuntimeIdentifiers)` explizit, bedingt auf das Android-Zielframework, damit es nicht in deine iOS- oder Windows-Builds durchsickert:

```xml
<!-- .NET 9 and .NET 10 -->
<PropertyGroup Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x86;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Ein Projekt mit nur einem Ziel kann die einfachere Bedingung auf den TFM-String verwenden:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net10.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Dieser zweite Satz ist der, zu dem du standardmäßig greifen solltest. Er stellt 32-Bit-ARM wieder her, das einzige 32-Bit-ABI mit echter Hardware dahinter, und lässt 32-Bit-x86 weg, was in der Praxis alte Emulator-Images und eine Handvoll Intel-Atom-Tablets bedeutet.

Baue nach der Änderung neu. Die nativen Bibliotheken pro ABI werden in `obj/` zwischengelagert, und ein inkrementeller Build verwendet bereitwillig ein Layout weiter, das älter ist als die Eigenschaft.

## ABI-Namen sind keine Runtime Identifier

Das ist der häufigste gescheiterte erste Versuch. `$(AndroidSupportedAbis)` nahm ABI-Namen entgegen, also fügen Leute ABI-Namen in die Eigenschaft ein, die es ersetzt hat:

```xml
<!-- wrong -->
<RuntimeIdentifiers>armeabi-v7a;arm64-v8a;x86;x86_64</RuntimeIdentifiers>
```

```text
error NETSDK1083: The specified RuntimeIdentifier 'armeabi-v7a' is not recognized.
```

Die beiden Vokabulare entsprechen einander eins zu eins:

| Android-ABI | .NET Runtime Identifier |
| --- | --- |
| `armeabi-v7a` | `android-arm` |
| `arm64-v8a` | `android-arm64` |
| `x86` | `android-x86` |
| `x86_64` | `android-x64` |

Beachte, dass `x86_64` auf `android-x64` abgebildet wird und nicht auf `android-x86_64`, und dass `android-x86` das 32-Bit-ABI ist. Wer diese beiden vertauscht, erzeugt einen erfolgreichen Build und ein APK, das sich auf keinem deiner Geräte installieren lässt.

## Die ADB0020-Seite empfiehlt eine Eigenschaft, die nicht mehr funktioniert

Wer der offiziellen ADB0020-Seite folgt, landet im nächsten Fehler. Sie schlägt vor:

```xml
<AndroidSupportedAbis>armeabi-v7a;x86;x86_64;arm64-v8a</AndroidSupportedAbis>
```

Dieser Rat stammt aus der Zeit vor .NET 6. Füge das einem modernen Projekt hinzu, und der Build sagt es dir:

```text
warning XA0036: The 'AndroidSupportedAbis' MSBuild property is no longer supported. Edit the project
file in a text editor, remove any uses of 'AndroidSupportedAbis', and use the 'RuntimeIdentifiers'
MSBuild property instead.
```

Weil XA0036 eine Warnung und kein Fehler ist, läuft der Build durch, die Eigenschaft wird ignoriert, und das APK enthält weiterhin zwei ABIs. Wenn du ein aus Xamarin.Forms migriertes Projekt geerbt hast, prüfe auf ein übrig gebliebenes `AndroidSupportedAbis` in einer `Directory.Build.props` oder in einem Build-Server-Argument, bevor du schlussfolgerst, dass `RuntimeIdentifiers` keine Wirkung zeigt.

## .NET 11 ändert die Antwort erneut

Füge das Snippet mit vier RIDs nicht in ein `net11.0-android`-Projekt ein. [MAUI ist in .NET 11 Preview 4 auf Android, iOS und Mac Catalyst auf CoreCLR umgestiegen](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), und CoreCLR hat nicht jede Architektur übernommen, die Mono unterstützt hat. Android x86 ist weg, und danach zu fragen lässt den Build scheitern, statt still verworfen zu werden:

```text
error NETSDK1082: There was no runtime pack for Microsoft.Android.Runtime available for the specified
RuntimeIdentifier 'android-x86'.
```

Bei 32-Bit-ARM dauerte es länger. Als CoreCLR zum Standard wurde, galt die Unterstützung noch als in Prüfung, und sie kam mit Preview 7. Da [Preview 6 den Mono-Pfad für Mobile vollständig entfernt hat](/de/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/), gibt es keinen Notausgang über `$(UseMonoRuntime)` mehr. Für ein .NET-11-Projekt ist dies der funktionierende Satz:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <RuntimeIdentifiers>android-arm;android-arm64;android-x64</RuntimeIdentifiers>
</PropertyGroup>
```

Wenn du auf einem SDK von Preview 6 oder älter bist, lass auch `android-arm` weg und nimm 64-Bit-only hin, bis du aktualisieren kannst. .NET 11 erreicht GA im November 2026.

Die praktische Folge für Emulatoren: Ein 32-Bit-x86-Systemimage kann eine .NET-11-MAUI-App niemals ausführen. Wenn deine CI noch eines startet, wechsle auf `x86_64` oder auf `arm64-v8a` auf Apple-Silicon-Runnern.

## Halte die innere Schleife schnell

Vier ABIs zu bauen, um auf einem Gerät zu debuggen, ist verschwendete Zeit. `$(RuntimeIdentifier)` im Singular überschreibt die Pluralform und baut genau eines:

```bash
dotnet build -f net11.0-android -t:Run -p:RuntimeIdentifier=android-arm64
```

Verdrahte es mit der Debug-Konfiguration und lass den vollen Satz für Release:

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Debug' and $(TargetFramework.Contains('-android'))">
  <RuntimeIdentifier>android-arm64</RuntimeIdentifier>
</PropertyGroup>
```

Ein Hinweis zum Übergeben der Plural-Eigenschaft auf der Kommandozeile: MSBuild trennt `-p:`-Werte an Semikolons, sodass `-p:RuntimeIdentifiers=android-arm64;android-x64` dir einen Shell- oder MSBuild-Parsefehler beschert statt zwei RIDs. Maskiere das Trennzeichen als `%3B`:

```bash
dotnet publish -f net11.0-android -c Release -p:RuntimeIdentifiers=android-arm64%3Bandroid-x64
```

## Was Google Play tatsächlich verlangt

Play verlangt seit August 2019 ein 64-Bit-Binary neben jedem 32-Bit-Binary. Das 32-Bit-Binary selbst war nie Pflicht. Der Standard aus .NET 9 ist also regelkonform, und `android-arm` wieder hinzuzufügen ist eine Reichweitenentscheidung, keine Compliance-Korrektur.

Prüfe die reale Zahl, bevor du dafür APK-Größe ausgibst. In der Play Console zeigt der Gerätekatalog eines Release, wie viele unterstützte Geräte ein Bundle erreicht, und der Unterschied zwischen einem Build mit zwei und einem mit drei ABIs ist die Population der Geräte, die nur `armeabi-v7a` können und noch im Einsatz sind. Für viele Apps ist diese Zahl 2026 klein genug, um sie zu ignorieren, für Apps in Regionen mit langen Austauschzyklen ist sie es nicht.

Wenn du ein App Bundle ausspielst, teilt Play es ohnehin pro ABI auf, sodass jede Nutzerin und jeder Nutzer genau eine Architektur herunterlädt. Das zusätzliche ABI kostet dich Buildzeit und Upload-Größe, nicht Installationsgröße.

## Verwandte Beiträge

- Native Bibliotheken sind auch der Grund, warum [Google Play eine Flutter- oder .NET-MAUI-App wegen fehlender Unterstützung für 16-KB-Speicherseiten ablehnt](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/), eine Prüfung, die gegen dieselben `lib/<abi>/`-Einträge läuft, die du oben aufgelistet hast.
- Der Runtime-Wechsel hinter den Architekturänderungen in .NET 11 wird in [MAUI stellt auf Android, iOS und Mac Catalyst standardmäßig auf CoreCLR um](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) behandelt.
- Ein übrig gebliebenes `AndroidSupportedAbis` kommt meist mit den übrigen Legacy-Build-Eigenschaften, die in [Migration von Xamarin.Forms zu MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/) behandelt werden.
- Wenn der Build scheitert, bevor überhaupt ein installierbares Paket entsteht, beginne mit [Gradle build failed to produce an APK file in MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).

## Quellen

- [.NET for Android Fehler ADB0020](https://learn.microsoft.com/de-de/dotnet/android/messages/adb0020), für die Zuordnung von `INSTALL_FAILED_NO_MATCHING_ABIS` zum Buildfehler.
- [.NET for Android Warnung XA0036](https://learn.microsoft.com/de-de/dotnet/android/messages/xa0036), für den Deprecation-Text zu `AndroidSupportedAbis`.
- [Migration von Xamarin.Android-Projekten](https://learn.microsoft.com/de-de/dotnet/maui/migration/android-projects), das die Ablösung von ABI durch `RuntimeIdentifiers` dokumentiert.
- [.NET RID-Katalog](https://learn.microsoft.com/de-de/dotnet/core/rid-catalog) für die Namen der Android-Runtime-Identifier.
- [CoreCLR progress and the Mono timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), für die Entfernung des Mono-Pfads in Preview 6 und den arm32-Status.
- [dotnet/maui#27697](https://github.com/dotnet/maui/issues/27697), der Bericht, der die Standardänderung in .NET 9 als Play-Store-Kompatibilitätsregression sichtbar gemacht hat.
- [64-Bit-Architekturen unterstützen](https://developer.android.com/google-play/64-bit) in der Google-Play-Entwicklerdokumentation.
