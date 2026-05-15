---
title: "Fix: Der Gradle-Build hat keine .apk-Datei in MAUI Android erzeugt"
description: "Neun von zehn Mal liegt der eigentliche Gradle-Fehler weiter oben im MSBuild-Log. Falscher JDK-17-Pfad, fehlendes maui-android Workload und lange Pfade unter Windows sind die üblichen Ursachen."
pubDate: 2026-05-15
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "maui"
  - "maui-11"
  - "android"
  - "gradle"
lang: "de"
translationOf: "2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android"
translatedBy: "claude"
translationDate: 2026-05-15
---

Die Lösung: Dieser MSBuild-Fehler ist fast nie der eigentliche Fehler. Scrollen Sie das Build-Log darüber hinaus nach oben, bis Sie auf die erste `error`-Zeile von `gradlew.bat` oder `aapt2` stoßen. Neun von zehn Mal liegt die wirkliche Ursache an einem von drei Dingen: `JAVA_HOME` zeigt auf JDK 11 (das Android Gradle Plugin 8.x in MAUI 11 benötigt JDK 17), das Workload `android` oder `maui-android` wurde nach einem .NET-SDK-Update nicht wiederhergestellt, oder eine Verletzung der Pfadlängenbegrenzung unter Windows hat die obfuskierte R8-Ausgabe abgeschnitten. Beheben Sie den zugrundeliegenden Fehler, und die `.apk` wird beim nächsten Build erzeugt.

```text
C:\Program Files\dotnet\sdk\11.0.100\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.RuntimeIdentifierInference.targets(311,5):
error XA1029: The Gradle build failed to produce an .apk file. Please check the diagnostic log.
```

Diese Anleitung wurde gegen .NET 11 GA, das Target Framework `net11.0-android`, .NET MAUI 11.0.0 und das Android Gradle Plugin (AGP) geschrieben, das mit `Xamarin.Android.Sdk` 35.x ausgeliefert wird (die Version, die Microsoft für `dotnet workload install android` in .NET 11 fixiert). Der Code `XA1029` wird von `Xamarin.Android.Build.Tasks` ausgelöst, nachdem `gradlew assembleDebug` oder `assembleRelease` mit einem Exit-Code ungleich null beendet wurde. Der Text "failed to produce an .apk file" ist ein Wrapper, nicht die Ursache.

## Warum MAUI Android den eigentlichen Gradle-Fehler einwickelt

MAUI ruft Gradle während eines normalen `dotnet build` nicht direkt auf. Das Android-spezifische MSBuild-Target (`_CompileToDalvikWithD8`, `_GenerateAndroidPackage`) schreibt eine generierte `build.gradle.kts` nach `obj/Debug/net11.0-android/<rid>/android/` und ruft dann das mitgelieferte `gradlew.bat` (Windows) bzw. `gradlew` (macOS, Linux) auf. Wenn `gradlew` mit einem Exit-Code ungleich null beendet wird, schluckt der MSBuild-Task das mehrere tausend Zeilen lange Gradle-Log in eine einzelne Diagnose-Datei unter `obj/Debug/net11.0-android/<rid>/android/build.log` und gibt `XA1029` aus. Visual Studio zeigt nur den Wrapper. Der eigentliche Stack Trace, die fehlende Abhängigkeit, die JDK-Ablehnung oder der Signaturfehler stehen in `build.log` plus den Zeilen direkt über `XA1029` im MSBuild-Ausgabefenster.

Behandeln Sie `XA1029` wie einen HTTP 500: Es sagt Ihnen, dass der Build kaputt ging, nicht was kaputt ging. Der erste Schritt ist immer, die tatsächliche `> Task :`-Zeile zu finden, die fehlgeschlagen ist.

## Das Diagnose-Log lesen, um die echte Ursache zu finden

Führen Sie aus einem Terminal im Projektverzeichnis den Build mit der Ausführlichkeit erneut aus, die jede Gradle-Zeile sichtbar macht:

```bash
# .NET 11 SDK, MAUI 11.0.0
dotnet build -t:Run -f net11.0-android \
  -p:AndroidPackageFormat=apk \
  -bl:msbuild.binlog \
  -v:diag
```

Öffnen Sie dann `msbuild.binlog` im [MSBuild Structured Log Viewer](https://msbuildlog.com/) und suchen Sie nach `FAILURE: Build failed`. Die Zeile darüber benennt den fehlgeschlagenen Gradle-Task: `:app:processDebugResources`, `:app:mergeDebugResources`, `:app:lintVitalReportRelease` oder `:app:compileDebugJavaWithJavac` sind die üblichen Verdächtigen. Jeder zeigt auf eine bestimmte Lösungskategorie weiter unten.

Wenn das Binlog für die Gradle-Phase leer ist, bedeutet das, dass Gradle nie gestartet wurde, was wiederum bedeutet, dass die Auflösung von `JAVA_HOME` oder die Wiederherstellung des Workloads fehlschlug, bevor irgendein Task lief. Springen Sie zu den JDK- und Workload-Abschnitten.

## Ursache 1: JAVA_HOME zeigt auf das falsche JDK

Dies ist die mit Abstand häufigste Ursache nach einem .NET-SDK-Update. AGP 8.x, das mit Xamarin.Android 35 (dem .NET-11-Standard) ausgeliefert wird, weigert sich, unter JDK 11 zu starten, mit diesem Fehler innerhalb von `build.log`:

```text
> Task :app:checkKotlinGradlePluginConfigurationErrors
A problem occurred starting Gradle worker
> Could not resolve the Java toolchain '11'.
> Android Gradle plugin requires Java 17 to run. You are currently using Java 11.
```

Die entsprechende MSBuild-Oberfläche ist `XA1029`. Microsoft hat die JDK-Untergrenze für MAUI als Java 11 für die .NET-6- bis .NET-8-Ära dokumentiert, dann ab MAUI 9 als Java 17, in Anlehnung an die AGP-Anforderung upstream. Siehe das langlaufende MAUI-Issue [dotnet/maui#18906](https://github.com/dotnet/maui/issues/18906) für den ursprünglichen Bruch.

Die Lösung besteht darin, `JAVA_HOME` auf eine JDK-17-Installation zu zeigen. Auf einer Windows-Maschine mit Visual Studio 2026 liegt das mitgelieferte OpenJDK 17 unter `C:\Program Files\Microsoft\jdk-17.0.x-hotspot`. Setzen Sie es dauerhaft:

```powershell
# PowerShell, as the same user that runs dotnet build
[Environment]::SetEnvironmentVariable(
  "JAVA_HOME",
  "C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot",
  "User")
```

Starten Sie dann die Shell neu oder übergeben Sie in CI zusätzlich `-p:JavaSdkDirectory=...` auf der `dotnet build`-Kommandozeile, damit MSBuild es aufnimmt, ohne sich auf die geerbte Umgebung zu verlassen:

```bash
dotnet build -f net11.0-android \
  -p:JavaSdkDirectory="/usr/lib/jvm/temurin-17-jdk-amd64"
```

Sie können prüfen, welches JDK MSBuild tatsächlich ausgewählt hat, indem Sie das Binlog nach `JdkDirectory` durchsuchen oder `dotnet build -t:_ResolveAndroidTooling -v:diag | findstr Jdk` ausführen.

## Ursache 2: maui-android oder android Workload fehlt

Die zweithäufigste Ursache: Sie haben das .NET SDK auf der Maschine aktualisiert (oder es in CI frisch installiert) und nie die Workloads wiederhergestellt. Der MSBuild-Task scheitert bei `_GenerateAndroidPackage`, weil das `Xamarin.Android.Sdk`-Pack, das die Gradle-Integration besitzt, nicht auf der Festplatte ist. Der Wrapper ist immer noch `XA1029`; der eigentliche Fehler in `build.log` lautet:

```text
> Task :app:processDebugResources FAILED
The 'aapt2' executable was not found at ...\Xamarin.Android.Sdk.x.x.x\tools\aapt2.exe
```

Stellen Sie das an die SDK-Band fixierte Workload wieder her:

```bash
# .NET 11 GA -- installs both the android pack and maui-android
dotnet workload install maui-android
dotnet workload restore
```

`dotnet workload restore` läuft jede `*.csproj` im aktuellen Verzeichnis durch, liest deren `TargetFrameworks` und installiert alle Packs, die jedes Target Framework benötigt. In CI ist das der einzige Befehl, der sich zu starten lohnt, weil er idempotent und versionsfixiert ist. Das eigenständige `dotnet workload install maui-android` ist der richtige Aufruf auf einer frischen Entwicklermaschine. Microsoft dokumentiert die Workload-Aufteilung in [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install).

Wenn Sie MAUI über den Visual Studio 2026 Installer installiert und dann zusätzlich `dotnet workload install maui` aus der CLI ausgeführt haben, können Sie in einen Zustand geraten, in dem Visual Studio keine der beiden Kopien lokalisieren kann. Die MAUI-Troubleshooting-Doku beschreibt die [vollständige Deinstallations- und Neuinstallationssequenz](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), die mehr Arbeit ist als sie klingt, aber die einzige zuverlässige Wiederherstellung aus einem geteilten Workload-Zustand.

## Ursache 3: Verletzung der Pfadlängenbegrenzung unter Windows in der obj-Ausgabe

Die dritte wiederkehrende Ursache ist ein reines Windows-Artefakt. R8 und `aapt2` schreiben beide tief verschachtelte obfuskierte Pfade nach `obj\Debug\net11.0-android\android\app\build\intermediates\`. Für ein Projekt unter `C:\src\MyCompany\MyProduct\Mobile\MyProduct.Mobile.csproj` überschreitet der vollständige Pfad einer zwischengelagerten `.dex`-Datei routinemäßig das Legacy-Limit `MAX_PATH` von 260 Zeichen. Der Gradle-Worker meldet das als:

```text
> Task :app:mergeExtDexDebug FAILED
java.io.IOException: Cannot delete '...\transforms\...\classes.dex' (path too long)
```

Zwei Lösungen, in der Reihenfolge der Präferenz:

1. Verschieben Sie das Repository in einen kürzeren Root: `C:\src\Mobile\` statt `C:\Users\you\source\repos\MyCompany\Mobile\`.
2. Aktivieren Sie die Unterstützung langer Pfade über das Betriebssystem, das .NET SDK und Git hinweg. Als Administrator-PowerShell:

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   git config --system core.longpaths true
   ```

   Das Hinzufügen von `<UseAppHost>false</UseAppHost>` ist hier nicht die Lösung; was Sie tatsächlich brauchen, ist der Manifest-Eintrag. Bearbeiten Sie Ihre `.csproj` und setzen Sie `<EnableLongPaths>true</EnableLongPaths>` (Xamarin.Android 35+) und stellen Sie sicher, dass das `app.manifest` Ihres Projekts `longPathAware` deklariert. Die Android-Seite des Builds übernimmt das OS-Flag, sobald Sie sich abmelden und wieder anmelden.

Die erste Option ist schneller und funktioniert auf jeder Maschine ohne Admin-Rechte. Nehmen Sie sie, es sei denn, Ihr Repo-Pfad ist durch Richtlinien festgelegt.

## Ursache 4: lintVitalRelease scheitert nur in einem Release-Build

Wenn `dotnet build -c Debug` erfolgreich ist und `dotnet publish -c Release -f net11.0-android` mit `XA1029` scheitert, ist der Gradle-Task, der gestorben ist, `:app:lintVitalReportRelease`. AGP 8 hat Lint-Fehler von Warnungen zu Build-Fehlern für Release-Konfigurationen hochgestuft. Sie sehen das in `build.log`:

```text
> Task :app:lintVitalReportRelease FAILED
Lint found errors in the project; aborting build.
```

Die richtige Lösung ist, den Lint-Bericht unter `obj/Release/net11.0-android/android/app/build/reports/lint-results-release.html` zu lesen und die tatsächlichen Probleme anzugehen (fehlende Übersetzungen, hartkodierte Strings in `<application>`-Labels, veraltete Android-APIs, die auf `compileSdkVersion 35` zielen).

Die falsche, aber verlockende Lösung ist, Lint zu unterdrücken:

```xml
<!-- .csproj, .NET 11, MAUI 11 -- escape hatch only -->
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <AndroidLintAbortOnError>false</AndroidLintAbortOnError>
</PropertyGroup>
```

Verwenden Sie das nur als taktischen Notausstieg für ein Release, das heute ausgeliefert werden muss. Lint-Befunde über fehlende `android:exported`-Deklarationen sind echte Bugs auf Android 31+ und werden irgendwann beim Start abstürzen.

## Ursache 5: fehlender oder falscher Keystore für signierte Release-Builds

Ein signierter Release-Build fügt `:app:signReleaseBundle` zur Tasklist hinzu. Wenn der Keystore-Pfad ins Leere zeigt, scheitert AGP mit:

```text
> Task :app:signReleaseBundle FAILED
Keystore file '/Users/runner/work/_temp/myapp.keystore' not found for signing config 'release'.
```

Auf einer Entwicklermaschine bedeutet das, dass Ihre `<AndroidSigningKeyStore>` MSBuild-Eigenschaft auf eine Datei zeigt, die für den aktuellen Benutzer nicht existiert. In CI bedeutet das normalerweise, dass das Secret, das den base64-kodierten Keystore enthält, nicht in den Pfad dekodiert wurde, auf den das `csproj` verweist. Der minimale korrekte CI-Aufruf:

```bash
# .NET 11, MAUI 11 -- GitHub Actions
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > $RUNNER_TEMP/release.keystore
dotnet publish src/MyApp/MyApp.csproj \
  -f net11.0-android \
  -c Release \
  -p:AndroidPackageFormat=apk \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=$RUNNER_TEMP/release.keystore \
  -p:AndroidSigningStorePass=$ANDROID_KEYSTORE_PASS \
  -p:AndroidSigningKeyAlias=$ANDROID_KEY_ALIAS \
  -p:AndroidSigningKeyPass=$ANDROID_KEY_PASS
```

Die vier `AndroidSigning*`-Eigenschaften sind zusammen verpflichtend. Nur drei davon zu setzen scheitert mit demselben `XA1029` und einer anderen Gradle-Task-Zeile. Microsoft dokumentiert die Eigenschaftsnamen in [Publish a .NET MAUI app for Android](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli).

## Ursache 6: defekter Gradle-Daemon oder veralteter .gradle-Cache

Nach einer langen Reihe fehlgeschlagener Builds kann der benutzerbezogene Gradle-Cache unter `~/.gradle/caches/` in einen Zustand geraten, in dem jeder folgende Build mit einem generischen `XA1029` und einem `build.log` scheitert, das sich über Lock-Dateien beklagt. Löschen Sie den Cache und die Workload-bezogene Gradle-Distribution:

```bash
# kills the daemon, deletes the cache, deletes the user gradle wrapper distribution
gradle --stop 2>/dev/null
rm -rf ~/.gradle/caches/ ~/.gradle/daemon/
rm -rf ~/.gradle/wrapper/dists/
```

Unter Windows lautet das Äquivalent `Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches"`. Der nächste Build lädt die AGP-Distribution erneut herunter (etwa 200 MB) und rehydriert den Abhängigkeitsgraphen; das dauert beim ersten Mal 5 bis 10 Minuten und ist danach schnell.

Das ist die richtige Lösung für "es funktionierte gestern und nichts hat sich geändert". Es ist die falsche Lösung, wenn Sie benennen können, was sich geändert hat (ein Workload-Update, ein JDK-Wechsel, ein neues NuGet-Paket); jagen Sie zuerst die Ursache.

## Stolperfallen und ähnlich aussehende Fehler

- `XA0119: Could not find android.jar for API level 35` ist ein verwandter Fehler aus derselben Phase. Es ist immer eine fehlende `android-sdk;platforms;android-35`-Installation, kein Gradle-Problem. Führen Sie `androidsdkmanager --install platforms;android-35` aus.
- `error : Java.Interop.Tools.Diagnostics.XamarinAndroidException: Output directory does not exist` stammt ebenfalls von `Xamarin.Android.Build.Tasks`, aber früher in der Pipeline. Es bedeutet meist, dass `obj/` schreibgeschützt ist, weil Defender eine Datei in Quarantäne gestellt hat. Prüfen Sie `Get-Acl obj` und das Defender-Quarantäne-Log.
- `MSB6006: "java.exe" exited with code 1` aus der Linker-Phase ist irreführend benannt: Es ist die `R8` Minification, die an einer Klasse scheitert, die sie nicht nachverfolgen kann. Fügen Sie eine ProGuard-Regel hinzu und versuchen Sie es erneut. Sehen Sie sich die Aufschlüsselung in [einem aktuellen Beitrag zur Cold-Start-Optimierung](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) für die zugrundeliegenden Mechanismen an; dieselben Trim/AOT-Verträge gelten unter Android.
- "Build SUCCESS" ohne `.apk` in `bin/` passiert, wenn `<AndroidPackageFormat>aab</AndroidPackageFormat>` in einer übergeordneten `Directory.Build.props` gesetzt ist. Der Build erzeugt stattdessen ein `.aab` (App Bundle), das ist, was der Play Store tatsächlich will. Der `XA1029`-Text sagt nur ".apk", weil das der historische Standard ist; die zugrundeliegende Prüfung lautet "hat der Verpackungsschritt seine erwartete Ausgabedatei geschrieben?".

## Verwandt

- [Wie man eine MAUI-App für den Microsoft Store paketiert](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) führt durch die Windows-Seite derselben Veröffentlichungs-Pipeline.
- [.NET 11 preview 4: dotnet watch landet endlich für MAUI Android und iOS](/de/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/) deckt die Inner-Loop-Werkzeuge ab, die auf demselben Gradle-Geschirr laufen.
- [MAUI auf .NET 11 preview 4 macht CoreCLR zum Standard für Android und iOS](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) erklärt, warum der Laufzeit-Wechsel einige Lint-Regeln in Release-Builds von Warnungen zu Fehlern verschoben hat.
- [Wie man eine performante Xamarin.Forms ListView zu MAUI CollectionView migriert](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) ist der häufigste Grund, warum ein Projekt, das unter Xamarin sauber gebaut hat, nach der MAUI-Portierung beginnt, in `XA1029` zu rennen.

## Quellen

- [Troubleshoot known issues in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting), Microsoft Learn, .NET MAUI 11.
- [dotnet/maui#18906: GitHub Actions no longer builds MAUI Android: Java SDK 11.0 or above is required](https://github.com/dotnet/maui/issues/18906), das kanonische Issue, das die Anhebung der JDK-Anforderung verfolgt.
- [dotnet/maui Discussion #24164: Cannot build apk in Release](https://github.com/dotnet/maui/discussions/24164), Community-Thread, der die Release-spezifischen `XA1029`-Ursachen aufzählt.
- [Publish a .NET MAUI app for Android with the CLI](https://learn.microsoft.com/en-us/dotnet/maui/android/deployment/publish-cli), die Quelle der Wahrheit für die `AndroidSigning*`-MSBuild-Eigenschaften.
- [Java versions in Android builds](https://developer.android.com/build/jdks), Dokumentation des Android-Teams zur JDK-Untergrenze pro AGP-Version.
- [Install workloads with dotnet workload install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-workload-install), die oben referenzierte Semantik der Workload-Installation und -Wiederherstellung.
