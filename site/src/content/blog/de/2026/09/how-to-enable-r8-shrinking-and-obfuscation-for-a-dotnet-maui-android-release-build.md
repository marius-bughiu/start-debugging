---
title: "R8-Shrinking und Obfuskierung für einen .NET MAUI Android Release-Build aktivieren"
description: "AndroidLinkTool auf r8 setzen, Trimming eingeschaltet lassen und eine ProguardConfiguration-Datei hinzufügen. Warum .NET 10 und .NET 11 RC 1 weiterhin nicht obfuskierten Java-Code ausliefern, wie die neue Eigenschaft AndroidR8ObfuscationMode das ändert und wie Sie prüfen, ob R8 tatsächlich gelaufen ist."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "r8"
  - "dotnet-11"
  - "dotnet-10"
  - "google-play"
lang: "de"
translationOf: "2026/09/how-to-enable-r8-shrinking-and-obfuscation-for-a-dotnet-maui-android-release-build"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Kurze Antwort:** Fügen Sie `<AndroidLinkTool>r8</AndroidLinkTool>` in eine nur für Release geltende `PropertyGroup` in Ihrer MAUI-`.csproj` ein, lassen Sie das Trimming eingeschaltet (in Release ist es standardmäßig aktiv) und legen Sie eventuelle Keep-Regeln in einer `proguard.cfg`-Datei mit der Build-Aktion `ProguardConfiguration` ab. Damit werden R8-Shrinking und -Optimierung für die Java-Seite Ihrer App aktiviert. Obfuskiert wird mit den aktuell ausgelieferten SDKs dagegen **nichts**: .NET for Android 36.1.69 (.NET 10) und 37.0.0-rc.1.2257 (.NET 11 RC 1) fügen beide `-dontobfuscate` in die R8-Konfiguration ein. Echte Obfuskierung kommt mit der neuen Eigenschaft `AndroidR8ObfuscationMode`, die in .NET 11 nach RC 1 standardmäßig auf `private-members` steht und für das nächste .NET 10 Servicing-Release als optionaler Backport verfügbar ist.

Dieses letzte Detail ist wichtiger als früher. Google hat am 26. August 2026 angekündigt, dass App Bundles auf Google Play ab Februar 2027 eine Abdeckung von mindestens 25 % bei Optimierung, Shrinking und Obfuskierung ihres DEX-Codes benötigen (Android vitals warnt erst, wenn ein Bundle 10 MB DEX bei Apps bzw. 50 MB bei Spielen enthält). Eine MAUI-App zieht viel Java-Code aus AndroidX und den Google Play services mit, die DEX-Seite ist also nicht klein.

Alles Folgende wurde im `dotnet/android`-Quellcode an den oben genannten Release-Tags nachverfolgt, sodass Sie jede Aussage selbst anhand der MSBuild-Targets überprüfen können.

## Was R8 in einer MAUI-App anfasst und was nicht

Ein MAUI-Android-Paket enthält zwei Arten von Code, die von unterschiedlichen Werkzeugen verkleinert werden:

- **Verwalteter Code** (Ihr C#, MAUI, die BCL) wird von ILLink getrimmt, wenn `PublishTrimmed` auf `true` steht. R8 bekommt ihn nie zu sehen. C# zu obfuskieren ist ein separates Problem, das R8 nicht lösen kann.
- **Java-Bytecode** (AndroidX, Material, Google Play services, Firebase, jede `.aar`, die Sie binden, sowie die Java Callable Wrappers, die der Build für jeden verwalteten Typ erzeugt, der von einem Java-Typ erbt) wird zu `classes.dex` umgewandelt. Standardmäßig erledigt das der D8-Compiler ohne Shrinking. Mit `AndroidLinkTool=r8` dext und verkleinert R8 in einem einzigen Durchgang.

Die Prozentwerte von Google Play werden auf dem DEX gemessen, also genau auf der R8-Hälfte. Wenn also von "R8 in MAUI aktivieren" die Rede ist, geht es darum, diese Java-Hälfte kleiner und irgendwann auch umbenannt zu machen.

Schon das Shrinking allein lohnt sich. In [dotnet/android #12535](https://github.com/dotnet/android/issues/12535) hat ein Entwickler eine .NET 10-App auf 36.1.69 gemessen: 20,18 MB unkomprimiertes DEX mit D8 und 11,43 MB mit R8 und den Standardregeln des SDK. Das ist fast die Hälfte des Java-Codes weg, ohne eine einzige von Hand geschriebene Keep-Regel.

## Die minimale Projektänderung

Das ist die gesamte Konfiguration für eine MAUI-App, die auf .NET 10 und .NET 11 abzielt:

```xml
<!-- MyApp.csproj, .NET 10 (Microsoft.Android.Sdk 36.1.x) and .NET 11 RC 1 (37.0.0-rc.1) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net11.0-android;net11.0-ios</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <UseMaui>true</UseMaui>
  </PropertyGroup>

  <PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
    <AndroidLinkTool>r8</AndroidLinkTool>
    <!-- Default in Release already. Written out because R8 without trimming strips Java types your C# still uses. -->
    <PublishTrimmed>true</PublishTrimmed>
  </PropertyGroup>

  <ItemGroup Condition="$(TargetFramework.Contains('-android'))">
    <ProguardConfiguration Include="Platforms/Android/proguard.cfg" />
  </ItemGroup>
</Project>
```

Anschließend wie gewohnt veröffentlichen:

```bash
dotnet publish -f net11.0-android -c Release
```

Die `proguard.cfg` kann leer beginnen. Regeln fügen Sie nur hinzu, wenn R8 etwas entfernt, das per Reflection erreicht wird. Das wird weiter unten behandelt.

## Was das SDK tut, wenn Sie AndroidLinkTool setzen

`AndroidLinkTool` ist der einzige Schalter, den Sie brauchen, weil `Xamarin.Android.Common.targets` den Rest daraus ableitet. Zusammengefasst aus den .NET 10- und .NET 11-Targets:

```xml
<!-- Xamarin.Android.Common.targets (dotnet/android 36.1.69 and 37.0.0-rc.1.2257), condensed -->
<AndroidDexTool   Condition=" '$(AndroidLinkTool)' == 'r8' ">d8</AndroidDexTool>
<AndroidLinkTool  Condition=" '$(AndroidLinkTool)' == 'proguard' And '$(AndroidEnableDesugar)' == 'True' ">r8</AndroidLinkTool>
<AndroidEnableProguard Condition=" '$(AndroidLinkTool)' != '' ">True</AndroidEnableProguard>
<AndroidCreateProguardMappingFile Condition="'$(AndroidCreateProguardMappingFile)' == '' And '$(AndroidLinkTool)' == 'r8'">True</AndroidCreateProguardMappingFile>
<AndroidProguardMappingFile Condition=" '$(AndroidLinkTool)' == 'r8' And '$(AndroidCreateProguardMappingFile)' == 'True' ">$(OutputPath)mapping.txt</AndroidProguardMappingFile>
```

Daraus ergeben sich einige Konsequenzen:

- `AndroidLinkTool=proguard` wird stillschweigend auf `r8` umgestellt, weil Desugaring mit D8 standardmäßig aktiv ist. Das eigenständige ProGuard-Werkzeug wird vom modernen .NET for Android nicht verwendet.
- Das alte `AndroidEnableProguard=true` / `EnableProguard=true` aus der Xamarin-Zeit funktioniert weiterhin, erzeugt aber die Warnung XA1028 (oder XA1027) und setzt das Link-Werkzeug standardmäßig auf `proguard`, das dann zu `r8` wird. Setzen Sie `AndroidLinkTool` direkt und ersparen Sie sich die Warnung.
- Standardmäßig wird eine `mapping.txt` in `$(OutputPath)` erzeugt (zum Beispiel `bin/Release/net11.0-android/mapping.txt`), und `dotnet publish` kopiert sie in den Publish-Ordner. Wenn Sie ein `.aab` erstellen, wird die Mapping-Datei zusätzlich als `com.android.tools.build.obfuscation/proguard.map` in die Bundle-Metadaten eingebettet, sodass die Play Console sie ohne manuellen Upload übernimmt. Bei einer per Sideloading installierten `.apk` laden Sie sie selbst hoch.

## Warum R8 eingeschaltetes Trimming braucht

R8 kann nicht selbst herausfinden, welche Java-Typen Ihr C# noch verwendet. Diese Liste kommt vom .NET-Trimmer: Nachdem ILLink gelaufen ist, schreibt ein eigener Schritt `proguard_project_references.cfg` mit einer Keep-Regel für jeden Java-Typ, an den ein verbliebener verwalteter Typ gebunden ist. Das Target, das diese Datei erzeugt, ist an das Trimming geknüpft:

```xml
<!-- Microsoft.Android.Sdk.TypeMap.LlvmIr.targets, 37.0.0-rc.1.2257 -->
<Target Name="_GenerateProguardConfiguration"
    AfterTargets="_PrepareLinkedAssembliesForProguard"
    Condition=" '$(PublishTrimmed)' == 'true' and '$(_ProguardProjectConfiguration)' != '' "
```

Die Entscheidung, R8 auszuführen, prüft das Trimming allerdings nicht. `Xamarin.Android.D8.targets` braucht nur die gesetzte Pfad-Eigenschaft, und `_ResolveAssemblies` setzt sie bei jedem Build, in dem `AndroidLinkTool` nicht leer ist:

```xml
<!-- Xamarin.Android.D8.targets, same in 36.1.69 and 37.0.0-rc.1.2257 -->
<_UseR8 Condition=" ('$(AndroidLinkTool)' == 'r8' And '$(_ProguardProjectConfiguration)' != '') Or '$(AndroidEnableMultiDex)' == 'True' ">True</_UseR8>
```

Mit `PublishTrimmed=false` (oder `AndroidLinkMode=None` in Release, einem verbreiteten Workaround für Reflection-Probleme) läuft R8 also trotzdem, aber ohne die Datei, die Ihre Bindings schützt. Der Build protokolliert nur XA4304 ("ProGuard configuration file '...proguard_project_references.cfg' was not found"), und die App stürzt dann mit `java.lang.ClassNotFoundException` ab, sobald sie zum ersten Mal einen Java-Typ anfasst, den R8 entfernt hat. Genau dieser Ablauf ist [dotnet/android #6612](https://github.com/dotnet/android/issues/6612), wo die Maintainer bestätigt haben, dass R8 auf einen aktivierten .NET-Linker angewiesen ist.

Deshalb ist auch die Release-Bedingung in der Projektdatei nicht kosmetisch. Debug-Builds trimmen nicht, sodass ein bedingungsloses `AndroidLinkTool=r8` auch im Debug-Build R8 ohne die Referenzdatei ausführt, und mit aktiviertem Fast Deployment erhalten Sie zusätzlich XA0119: "Using fast deployment and a code shrinker at the same time is not recommended".

## Welche Konfigurationsdateien R8 tatsächlich erhält

Wenn R8 läuft, stellt das SDK die `--pg-conf`-Eingaben in dieser Reihenfolge zusammen (`_ProguardConfiguration`-Items in `Xamarin.Android.Common.targets`):

1. `$(ProguardConfigFiles)`, falls Sie diese Eigenschaft setzen.
2. Die `proguard-android.txt` des Android SDK (nicht optimierende Basis). Auf neueren SDKs mit `AndroidR8ObfuscationMode=private-members` wird daraus `proguard-android-optimize.txt`.
3. `obj/.../proguard/proguard_xamarin.cfg`: Keep-Regeln der Laufzeit für `mono.android.**`, `net.dot.jni.**` und Verwandte. Auf den ausgelieferten SDKs beginnt diese Datei mit `-dontobfuscate`.
4. `proguard_project_references.cfg`: Keep-Regeln für jeden Java-Typ, an den ein verbliebener verwalteter Typ gebunden ist, erzeugt nach ILLink.
5. `proguard_project_primary.cfg`: eine `-keep class X { *; }`-Regel pro Java Callable Wrapper aus der ACW-Map, sodass jede `Activity`, jeder `Service` und jede benutzerdefinierte `View`, die Ihr C# definiert, erhalten bleibt.
6. Ihre `@(ProguardConfiguration)`-Items.
7. Consumer-Regeln (`proguard.txt`), die aus referenzierten `.aar`-Dateien extrahiert werden.

Die Punkte 4 und 5 sind der Grund, warum eine MAUI-App für ihre eigenen Typen selten handgeschriebene Keep-Regeln braucht: Der Build weiß bereits, welche Java-Klassen die verwaltete Seite erreichen kann. Was er nicht wissen kann, ist, was Java-Code per Reflection erreicht.

## Warum Sie heute Shrinking, aber keine Obfuskierung bekommen

ProGuard-Optionen sind global. Wenn irgendeine Konfigurationsdatei `-dontobfuscate` enthält, ist die Obfuskierung für den gesamten R8-Lauf ausgeschaltet, und es gibt kein Gegenstück, das Sie in Ihrer eigenen `proguard.cfg` hinzufügen könnten, um sie wieder einzuschalten. Da `proguard_xamarin.cfg` in 36.1.69 und 37.0.0-rc.1.2257 diese Zeile enthält, verkleinert und optimiert ein MAUI-Build mit aktiviertem R8 auf beiden SDKs, lässt aber jeden Java-Namen unverändert. Die geschriebene `mapping.txt` verzeichnet zwar entfernte Member und geänderte Zeilennummern, zeigt aber keine Umbenennungen.

Die Messungen in #12535 passen dazu: 34 von 15.235 Klassen in der `mapping.txt` einer App umbenannt (0,2 %), und für eine andere meldete die Play Console 1 % Obfuskierung. Das Setzen von `AndroidCreateProguardMappingFile=true`, das manche Antworten vorschlagen, ändert daran nichts; es steuert nur, ob die Mapping-Datei geschrieben wird.

Das pauschale `-dontobfuscate` war die sichere Wahl. JNI bindet verwaltete Peers über den Namen an Java-Klassen, daher würde das Umbenennen eines Java Callable Wrappers oder einer gebundenen AndroidX-Methode `JNIEnv`-Lookups zur Laufzeit brechen. Im selben Thread zeigte sich, dass es auch nicht reicht, die Zeile von Hand zu entfernen: Die erzeugten Keep-Regeln schützten keine Felder, die Bindings per Namen über JNI lesen, sodass Apps beim Start abstürzten. Warten Sie auf den unterstützten Schalter unten, statt die Konfiguration des SDK zu patchen.

## Echte Obfuskierung mit AndroidR8ObfuscationMode einschalten

[dotnet/android #12668](https://github.com/dotnet/android/pull/12668), am 10. September 2026 gemergt, ersetzt die pauschale Regel durch eine selektive und fügt eine öffentliche Eigenschaft hinzu:

| `AndroidR8ObfuscationMode` | Obfuskierung | Optimierungsbasis | Standard |
|---|---|---|---|
| `disabled` | keine, alle Java-Namen bleiben erhalten | `proguard-android.txt` | .NET 10 Servicing |
| `private-members` | private und paketprivate Member werden umbenannt | `proguard-android-optimize.txt` | .NET 11 nach RC 1 |

Am selben Tag wurde sie mit [#12752](https://github.com/dotnet/android/pull/12752) nach `release/10.0.1xx` zurückportiert, mit `disabled` als Standard, damit ein Servicing-Update bestehende Apps nicht verändert. Noch kein veröffentlichter Tag enthält sie (36.1.69 ist älter, und `release/11.0.1xx-rc1` wurde vor dem Merge abgezweigt), rechnen Sie also mit ihr in .NET 11 RC 2 und im nächsten .NET 10 Servicing-Update.

Im Modus `private-members` schreibt der R8-Task anstelle von `-dontobfuscate` diese Regeln:

```proguard
# Generated by the R8 task in dotnet/android main (post .NET 11 RC 1)
-keep,allowshrinking,allowoptimization class **
-keepclassmembers,allowshrinking,allowoptimization class ** {
   public protected *;
}
-keep,allowoptimization interface ** {
   public protected *;
}
-keep,allowshrinking class * implements **
```

Das bedeutet: Jede Klasse behält ihren Namen, jeder public und protected Member behält seinen Namen, und alles, was private oder paketprivat ist, darf umbenannt werden. Ungenutzter Code kann weiterhin entfernt werden. Die Interface-Regeln gibt es, weil die Auswahl verwalteter Proxys `Class.getInterfaces()` aufruft, was R8 nicht sehen kann; ohne sie könnte das Zusammenführen von Klassen eine Interface-Beziehung verwerfen und dem verwalteten Code den falschen Proxy liefern.

Um sich unter .NET 10 nach Erscheinen des Servicing-Release dafür zu entscheiden oder sich unter .NET 11 dagegen zu entscheiden:

```xml
<!-- .NET 10 servicing (opt in) or .NET 11 (opt out with "disabled") -->
<PropertyGroup Condition="'$(Configuration)' == 'Release' And $(TargetFramework.Contains('-android'))">
  <AndroidLinkTool>r8</AndroidLinkTool>
  <AndroidR8ObfuscationMode>private-members</AndroidR8ObfuscationMode>
</PropertyGroup>
```

Jeder andere Wert lässt den Build mit XA1050 fehlschlagen: "The 'AndroidR8ObfuscationMode' MSBuild property has an invalid value". Der PR entfernt außerdem die undokumentierten Schalter `_AndroidR8DontObfuscate` und `_AndroidR8DontOptimize`, streichen Sie sie also aus Ihrem Projekt, falls Sie sie aus einem Issue-Thread übernommen haben.

Halten Sie Ihre Erwartungen realistisch. Der PR berichtet, dass Google Play eine `dotnet new maui -sc`-Vorlage mit 62 % Optimierung, 65 % Shrinking und 28 % Obfuskierung gemessen hat. Das überspringt die 25-%-Hürde, aber Obfuskierung ist der knappe Wert, weil für JNI sichtbare Namen nicht umbenannt werden können. Betrachten Sie `private-members` als "ausreichend für die Play-Anforderung", nicht als Schutz Ihrer C#-Logik.

## Keep-Regeln schreiben, die wirklich zählen

R8 entfernt nur Java-Code, bei dem es beweisen kann, dass er unerreichbar ist. Regeln brauchen Sie für Code, der auf Wegen erreicht wird, die R8 nicht sehen kann:

```proguard
# Platforms/Android/proguard.cfg  (.NET 10 / .NET 11, R8 via AndroidLinkTool=r8)

# A Java SDK that loads its own classes with Class.forName and ships no consumer rules
-keep class com.example.vendorsdk.** { *; }

# Classes you look up by string from C#, e.g. Java.Lang.Class.ForName("com.example.Probe")
-keep class com.example.Probe { *; }

# JSON models serialized by a Java library (Gson, Moshi) that uses reflection
-keepattributes Signature,*Annotation*
-keep class com.example.api.models.** { <fields>; }

# Silence a known-harmless missing optional class instead of ignoring all warnings
-dontwarn androidx.window.extensions.**
```

Zwei Diagnoseregeln lohnen sich vorübergehend, während Sie das abstimmen, denn Ihre eigene `ProguardConfiguration`-Datei gilt als Anwendungskonfiguration und darf globale Optionen verwenden:

```proguard
# Temporary: dump what R8 removed and the fully merged configuration
-printusage r8-usage.txt
-printconfiguration r8-merged.txt
```

R8 löst diese relativen Pfade gegen den Ordner der Konfigurationsdatei auf, sodass beide neben `proguard.cfg` landen. Durchsuchen Sie `r8-merged.txt` nach `-dontobfuscate`, um zu bestätigen, welches Obfuskierungsverhalten Ihr SDK angewendet hat, und durchsuchen Sie `r8-usage.txt` nach einem Klassennamen, um nachzuweisen, dass R8 ihn entfernt hat, bevor Sie eine Regel dafür schreiben. Entfernen Sie beide Zeilen vor dem Commit, weil sie jeden Release-Build verlängern.

## Stolperfallen aus der Praxis

- **Warnungen zu fehlenden Klassen sind standardmäßig ausgeblendet.** `AndroidR8IgnoreWarnings` steht standardmäßig auf `True`, was `-ignorewarnings` hinzufügt und (seit .NET 8) `--map-diagnostics warning info` übergibt, sodass die "Missing class"-Meldungen von R8 als Info-Zeilen in einem detaillierten Build-Log erscheinen. Deshalb lassen Issues wie [dotnet/maui #10901](https://github.com/dotnet/maui/issues/10901) (`androidx.window.extensions.WindowExtensions`) den Build meist nicht fehlschlagen. Der Wert `False` ist strenger und kann eine fehlende Klasse in einen Build-Fehler verwandeln. Beheben Sie das mit einem gezielten `-dontwarn`, nicht indem Sie den globalen Schalter zurückstellen.
- **Ein falsch geschriebener Pfad ist nur eine Warnung.** Wenn der `ProguardConfiguration`-Pfad nicht existiert, erhalten Sie XA4304 ("ProGuard configuration file '...' was not found"), und R8 läuft ohne Ihre Regeln. Behandeln Sie XA4304 in der CI mit `<WarningsAsErrors>XA4304</WarningsAsErrors>` als Fehler.
- **`EnableR8` und `AndroidLinkMode=r8` bewirken nichts.** Keines von beiden existiert als R8-Schalter. MSBuild akzeptiert unbekannte Eigenschaften stillschweigend, und `AndroidLinkMode` steuert nur den verwalteten Trimmer (`None`, `SdkOnly`, `Full`). Nur `AndroidLinkTool=r8` schaltet R8 ein.
- **Bibliotheksregeln mit globalen Optionen werden übersprungen.** Ab .NET 11 Preview 7 wird eine `proguard.txt` innerhalb einer `.aar`, die `-dontobfuscate`, `-dontoptimize`, `-printmapping` oder Ähnliches enthält, mit XA4322 verworfen. Das ist dieselbe Einschränkung, die AGP 9 eingeführt hat. Wenn eine Bibliothek eines Anbieters nach dem Upgrade plötzlich abstürzt, suchen Sie im Build-Log nach XA4322 und kopieren Sie deren Keep-Regeln (ohne die globale Option) in Ihre eigene `proguard.cfg`.
- **Die MS-Learn-Seite zu den Build-Items ist veraltet.** Dort steht, dass `ProguardConfiguration`-Dateien ignoriert werden, sofern `EnableProguard` nicht `True` ist. Mit `AndroidLinkTool=r8` wird `AndroidEnableProguard` für Sie auf `True` gezwungen, die Items werden also verwendet.
- **Obfuskierte Stack Traces brauchen die Mapping-Datei.** Sobald `private-members` aktiv ist, lesen sich private Java-Frames in einem Absturzbericht wie `a.b.c`. Bewahren Sie die `mapping.txt` jedes ausgelieferten Release-Builds auf (das `.aab` bringt sie zu Play, Absturzreporter wie Firebase Crashlytics brauchen einen separaten Upload).
- **R8 kostet Build-Zeit.** Rechnen Sie mit spürbar längeren Release-Builds, da R8 eine Gesamtprogrammanalyse über den gesamten Bytecode von AndroidX und Play services durchführt. Beschränken Sie es auf Release.

## Prüfen, ob R8 wirklich gelaufen ist

Verlassen Sie sich nicht allein auf die Eigenschaft, sondern bestätigen Sie es anhand der Build-Ausgabe:

1. Kompilieren Sie mit einem Binary Log: `dotnet publish -f net11.0-android -c Release -bl`. Öffnen Sie `msbuild.binlog` im MSBuild Structured Log Viewer und suchen Sie unter `_CompileToDalvik` nach dem Task `R8`. Finden Sie nur `D8`, hat die Eigenschaft den Android-Build nie erreicht, meist weil ihre Bedingung nicht zu Ihrem `TargetFramework` passt. Wenn R8 gelaufen ist, das Log aber XA4304 für `proguard_project_references.cfg` enthält, ist das Trimming aus, und die App wird zur Laufzeit abstürzen.
2. Prüfen Sie, ob `bin/Release/net11.0-android/mapping.txt` existiert und einen aktuellen Zeitstempel hat.
3. Öffnen Sie `obj/Release/net11.0-android/android-arm64/proguard/proguard_xamarin.cfg` (der genaue RID-Ordner hängt von Ihren `RuntimeIdentifiers` ab). Auf 36.1.69 oder 37.0.0-rc.1.2257 beginnt sie mit `-dontobfuscate`. Auf einem SDK mit `AndroidR8ObfuscationMode=private-members` beginnt sie stattdessen mit dem Block `-keep,allowshrinking,allowoptimization class **`.
4. Laden Sie das `.aab` in einen internen Test-Track hoch und lesen Sie die Prozentwerte für Optimierung, Shrinking und Obfuskierung im App-Bundle-Explorer der Play Console ab. Das ist der Wert, den Google durchsetzt, also der, auf den Sie achten sollten. Play liest die Prozentwerte aus einer `r8.json`-Build-Metadatendatei, wenn das Bundle eine enthält, und schätzt sie andernfalls anhand der `mapping.txt`. Das SDK beginnt mit [dotnet/android #12646](https://github.com/dotnet/android/pull/12646), `r8.json` zu paketieren. Diese Änderung ist in `release/10.0.1xx` und `main`, aber nicht in 37.0.0-rc.1.2257 enthalten.

## Weiterführende Artikel

- Wenn Play Ihr Bundle zusätzlich wegen der Ausrichtung nativer Bibliotheken abgelehnt hat, finden Sie die Lösung unter [Google Play lehnt eine MAUI-App wegen der 16-KB-Seitengröße ab](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).
- Ein Wechsel der Laufzeit ändert den APK-Inhalt, mit dem R8 arbeitet, siehe [eine MAUI-Android-App in .NET 11 von Mono auf CoreCLR migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/).
- Die andere Play-Anforderung in diesem Zyklus wird in [von .NET MAUI aus Android API-Level 36 anvisieren](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) behandelt.
- Wenn ein Release-Build nicht stillschweigend, sondern innerhalb der Java-Toolchain fehlschlägt, beginnen Sie mit [Gradle build failed to produce an .apk file in MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/).
- Die oben gezeigte `-printusage`-Technik ist dieselbe, mit der R8 in [Firebase-Auth-Anmeldung bleibt in einem Flutter Android Release-Build nicht bestehen](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) als Ursache ausgeschlossen wurde.

## Quellen

- [Build-Eigenschaften von .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-properties) (`AndroidLinkTool`, `AndroidCreateProguardMappingFile`, `AndroidProguardMappingFile`, `AndroidR8IgnoreWarnings`)
- [Build-Items von .NET for Android](https://learn.microsoft.com/en-us/dotnet/android/building-apps/build-items) (`ProguardConfiguration`, `AndroidAppBundleMetaDataFile`)
- [Spezifikation der D8- und R8-Integration](https://github.com/dotnet/android/blob/main/Documentation/guides/D8andR8.md) in dotnet/android
- [`Xamarin.Android.D8.targets`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Xamarin.Android.D8.targets) und [`proguard_xamarin.cfg`](https://github.com/dotnet/android/blob/37.0.0-rc.1.2257/src/Xamarin.Android.Build.Tasks/Resources/proguard_xamarin.cfg) in 37.0.0-rc.1.2257
- [dotnet/android #6612: R8 ohne den .NET-Linker](https://github.com/dotnet/android/issues/6612) und [#12535: bedingungsloses -dontobfuscate vs. die Play-Anforderung](https://github.com/dotnet/android/issues/12535)
- [dotnet/android #12668: konfigurierbare Obfuskierung und Optimierung privater Member](https://github.com/dotnet/android/pull/12668) und der [.NET 10-Backport #12752](https://github.com/dotnet/android/pull/12752)
- [Android Developers Blog: Speicherverbrauch senken und Gerätemigration verbessern](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html) (DEX-Optimierungsanforderung ab Februar 2027)
- [DEX-Codeoptimierung in Android vitals](https://developer.android.com/topic/performance/vitals/code-optimization) (DEX-Schwellenwerte von 10 MB / 50 MB)
