---
title: "Eine .NET MAUI Android-App in .NET 11 von Mono zu CoreCLR migrieren"
description: "Eine schrittweise Migration von Mono zu CoreCLR für .NET MAUI unter Android: die API-24-Untergrenze, die Mono-spezifischen MSBuild-Eigenschaften, die jetzt den Build brechen, warum das APK gewachsen ist, wie sich die Startregression mit dotnet-dsrouter und dotnet-trace analysieren lässt, und wie ein Rollback tatsächlich aussieht, nachdem der Mono-Pfad verschwunden ist."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "dotnet-11"
  - "maui"
  - "android"
  - "coreclr"
  - "mono"
lang: "de"
translationOf: "2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-03
---

Bei einer kleinen App ist diese Migration eine Änderung an `TargetFramework`, eine Änderung an `android:minSdkVersion` und ein Nachmittag mit Messungen. Bei einer großen App planen Sie eine Woche ein, und die gesamte Woche geht erfahrungsgemäß in zwei Dinge: das Entfernen von MSBuild-Eigenschaften aus der Mono-Ära, die jetzt entweder wirkungslos sind oder den Build aktiv brechen, und die Jagd auf eine Startregression, die nichts mit Ihrem Code zu tun hat. Der Gewinn ist real (einheitliche Diagnose, Tiered JIT, dynamisches PGO, ein plausibler Weg zu Native AOT unter Android), aber ehrlich betrachtet ist das hier nicht optional. Seit [.NET 11 Preview 6](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/) bietet Microsoft keinen separaten Mono-Pfad mehr für Android, iOS oder Mac Catalyst an. Dieser Leitfaden zielt auf .NET 11 Preview 7 (`11.0.100-preview.7`, veröffentlicht am 2026-08-11) mit .NET MAUI `11.0.0-preview.7` und migriert von .NET 10 mit Mono. Das finale .NET 11 ist für den 2026-11-10 geplant.

## Warum sich das lohnt, unabhängig von "Sie haben keine Wahl"

- **Ihr Profiler funktioniert endlich.** `dotnet-trace` und `dotnet-counters` verbinden sich jetzt genauso mit einer laufenden Android-App wie mit einem ASP.NET Core-Prozess, über `dotnet-dsrouter`. Der Mono-spezifische Tracing-Dialekt entfällt.
- **Tiered Compilation und dynamisches PGO kommen aufs Telefon.** Mono AOT kompilierte einmal zur Build-Zeit, und damit endete die Optimierungsgeschichte. CoreCLR instrumentiert in Tier 0 und kompiliert heiße Methoden in Tier 1 mit echten Profildaten neu, sodass sich der Durchsatz einer langlebigen App im eingeschwungenen Zustand ohne Ihr Zutun verbessert.
- **ReadyToRun ersetzt Mono AOT als Startmechanismus.** Unter Android verwendet MAUI für CoreCLR-Release-Builds standardmäßig *composite partial* R2R, gesteuert von `.mibc`-Profilen, die im Workload enthalten sind. Nur die Methoden, die das Profil als relevant ausweist, werden vorkompiliert, und genau das verhindert einen katastrophalen Größenaufschlag.
- **Eine Laufzeit, ein Bugtracker.** Ein Fehler in `System.Text.Json` oder `HttpClient` unter Android ist jetzt derselbe Fehler wie auf dem Server und wird an derselben Stelle behoben.

## Was bricht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Minimale Android-API | Angehoben von 21 (Android 5.0) auf 24 (Android 7.0) | hoch |
| Android-ABIs | Android x86 (32 Bit) wird unter CoreCLR nicht unterstützt | hoch |
| Mono-AOT-Eigenschaften | `RunAOTCompilation`, `AndroidAotMode`, `UseInterpreter` sind Mono-spezifisch; `RunAOTCompilation=true` kann weiterhin `MonoAOTCompiler` aufrufen und den Build brechen | hoch |
| Startzeit | Große Apps melden Regressionen von mehreren Sekunden und ANRs | hoch (situativ) |
| APK-Größe | R2R-Images liegen in Ihren `.dll`-Dateien, die Assemblys wachsen entsprechend | mittel |
| NuGet-Pakete | `NU1703`, wenn ein Paket `MonoAndroid`-Assets statt `net6.0-android` oder neuer auflöst | mittel |
| Alte Ressourcen | `XA0149` für alte Xamarin.Android-Ressourcen in einer Abhängigkeit | niedrig |
| `Microsoft.Maui.Controls.Compatibility` | Paket in Preview 6 entfernt | mittel (nur bei expliziter Referenz) |
| HTTP-Fehler | Transportfehler von `AndroidMessageHandler` werfen `HttpRequestException` statt `WebException` | niedrig |
| Runtime-Embedding | Die Android-Embedding-APIs werden nicht nach CoreCLR übernommen | hoch (falls verwendet) |

Die API-Untergrenze ist die Änderung, die bei Ihren Nutzern ankommt. Laut [Breaking-Change-Hinweis](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level) lassen sich mit .NET 11 gebaute Apps auf API 21, 22 oder 23 weder installieren noch ausführen. Prüfen Sie Ihre Verteilungszahlen in der Play Console, bevor Sie anfangen, denn das ist eine Entscheidung über Nutzer, keine Build-Einstellung.

## Checkliste vor dem Start

- .NET 11 SDK `11.0.100-preview.7` oder neuer, mit installiertem `maui-android`-Workload.
- `$ANDROID_HOME` auf einen gültigen Android-SDK-Pfad gesetzt. `dotnet-dsrouter` nutzt das dortige `adb` für die Portweiterleitung und findet es sonst nicht zuverlässig.
- Die Diagnosewerkzeuge global installiert: `dotnet tool install --global dotnet-dsrouter`, `dotnet-trace`, `dotnet-counters`.
- Eine **numerische Basismessung auf .NET 10 mit Mono, bevor Sie irgendetwas ändern.** Diesen Schritt überspringt jeder und bereut es später, denn "fühlt sich langsamer an" lässt sich nicht bisecten.
- Ein echtes Gerät, nicht nur der Emulator. Die gemeldeten Regressionen sind Startregressionen, und Emulator-Startzeiten sind nicht repräsentativ.

## Migrationsschritte

1. **Erfassen Sie die Mono-Basislinie.** Installieren Sie das APK Ihres aktuellen .NET 10-Release-Builds und messen Sie den Kaltstart mit dem Android Activity Manager, der `TotalTime` in Millisekunden ausgibt:

   ```console
   # .NET 10, Mono, Release
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Führen Sie das fünfmal aus, verwerfen Sie den ersten Lauf und notieren Sie den Median. Notieren Sie auch die Größe des Release-APK oder -AAB. **Verifizierung:** Sie haben zwei Zahlen an einem Ort notiert, der nicht Ihr Terminal-Scrollback ist.

2. **Ändern Sie Target Framework und API-Untergrenze gemeinsam.** Beide Änderungen in einem Commit, denn CoreCLR unter Android setzt API 24 voraus:

   ```xml
   <!-- .NET 11 Preview 7, MAUI 11.0.0-preview.7 -->
   <PropertyGroup>
     <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
     <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">24.0</SupportedOSPlatformVersion>
   </PropertyGroup>
   ```

   Wenn Sie `android:minSdkVersion` von Hand in `Platforms/Android/AndroidManifest.xml` setzen, heben Sie den Wert ebenfalls auf `24`, damit Manifest und Projekt übereinstimmen. **Verifizierung:** `dotnet build -f net11.0-android -c Release` läuft durch und das generierte Manifest zeigt `minSdkVersion="24"`.

3. **Entfernen oder konditionieren Sie jede Mono-spezifische MSBuild-Eigenschaft.** Durchsuchen Sie `.csproj`, `Directory.Build.props` und alle vom CI eingeschleusten Eigenschaften nach `RunAOTCompilation`, `AndroidAotMode`, `AndroidEnableProfiledAot`, `UseInterpreter` und `UseMonoRuntime`. Ein in `Directory.Build.props` verbliebenes `RunAOTCompilation=true` ist ein bekannter Build-Bruch: Das Target `MonoAOTCompiler` läuft weiterhin, obwohl die App auf CoreCLR steht ([dotnet/android#11068](https://github.com/dotnet/android/issues/11068)). Löschen Sie die Eigenschaften, oder konditionieren Sie sie, falls Sie noch ein älteres TFM parallel bauen:

   ```xml
   <PropertyGroup Condition="'$(UseMonoRuntime)' == 'true'">
     <RunAOTCompilation>true</RunAOTCompilation>
     <AndroidEnableProfiledAot>true</AndroidEnableProfiledAot>
   </PropertyGroup>
   ```

   **Verifizierung:** `dotnet build -f net11.0-android -c Release -bl` ausführen und im Binärlog nach `MonoAOTCompiler` suchen. Null Treffer ist die Bestehensbedingung.

4. **Bereinigen Sie die ABI-Liste und die Paketwarnungen.** Entfernen Sie `x86` aus `RuntimeIdentifiers`, falls es noch dort steht, denn CoreCLR liefert diese Architektur nicht aus:

   ```xml
   <RuntimeIdentifiers>android-arm64;android-x64</RuntimeIdentifiers>
   ```

   Kümmern Sie sich dann um `NU1703`. Die in Preview 5 eingeführte Warnung erscheint, wenn ein Paket Assets aus dem veralteten `MonoAndroid`-Ordner auflöst: "Package 'PackageName' 1.0.0 uses the deprecated MonoAndroid framework instead of 'net6.0-android' or later." Aktualisieren Sie das Paket, falls eine moderne Version existiert. Falls nicht, haben Sie eine Abhängigkeit aus der Xamarin-Ära gefunden, deren Zeit abläuft, und das Unterdrücken der Warnung ist die Entscheidung, dieses Risiko zu tragen, keine Lösung. **Verifizierung:** `dotnet restore` ist sauber, oder jede verbleibende `NU1703` gehört zu einem Paket, das Sie bewusst bewertet haben.

5. **Bauen Sie in Release neu und messen Sie erneut gegen Schritt 1.** Gleiches Gerät, gleiches Vorgehen, gleiche Anzahl an Läufen:

   ```console
   # .NET 11 Preview 7, CoreCLR, Release
   dotnet publish -f net11.0-android -c Release
   adb install -r bin/Release/net11.0-android/publish/com.example.myapp-Signed.apk
   adb shell am force-stop com.example.myapp
   adb shell am start -W -n com.example.myapp/crc64...MainActivity
   ```

   Microsofts eigene Position lautet, dass Android bei einer Basis-Template-App "innerhalb von 10 Prozent von Mono bei Start und App-Größe" liegt. **Verifizierung:** Liegen Sie in diesem Band, ist die Performance-Arbeit erledigt. Liegen Sie bei 2x oder schlechter, gehen Sie zu Schritt 6, statt planlos MSBuild-Eigenschaften umzuschalten.

6. **Analysieren Sie die Regression, statt zu raten.** Legen Sie neben der `.csproj` eine Datei `app.env` mit dem Inhalt `DOTNET_DiagnosticPorts=127.0.0.1:9000,suspend` an und referenzieren Sie sie bedingt:

   ```xml
   <ItemGroup Condition="'$(AndroidEnableProfiler)'=='true'">
     <AndroidEnvironment Include="app.env" />
   </ItemGroup>
   ```

   Starten Sie den Router, bauen Sie mit aktiviertem Profiler, starten Sie die App und verbinden Sie sich dann:

   ```console
   dotnet-dsrouter server-server -ipcs ~/mylocalport -tcps 127.0.0.1:9000 --forward-port Android &
   dotnet build -f net11.0-android -c Release -t:Run /p:AndroidEnableProfiler=true
   dotnet-trace collect --diagnostic-port ~/mylocalport,connect
   ```

   Da der Port mit `suspend` konfiguriert wurde, blockiert die Laufzeit beim Start, bis `dotnet-trace` sich verbindet, und genau das brauchen Sie, um den Startpfad zu sehen statt alles danach. Unter Windows verwenden Sie `mylocalport` statt `~/mylocalport`, da der IPC-Kanal dort eine Named Pipe ist. **Verifizierung:** Sie haben eine `.nettrace`-Datei mit einem gefüllten Startfenster und können die drei teuersten Methoden nach inklusiver Zeit benennen.

7. **Drehen Sie nur an dem, was der Trace rechtfertigt.** Ist die Assembly-Größe das Problem, ist R2R der erste Regler, denn R2R-Images stecken in den `.dll`-Dateien und genau deshalb sind Ihre Assemblys gewachsen:

   ```xml
   <PropertyGroup Condition="'$(Configuration)' == 'Release'">
     <PublishReadyToRun>false</PublishReadyToRun>  <!-- smaller APK, slower startup -->
     <TrimMode>full</TrimMode>                     <!-- default is partial -->
   </PropertyGroup>
   ```

   Beide ziehen in entgegengesetzte Richtungen: R2R abzuschalten tauscht Startzeit gegen Größe, und `TrimMode=full` holt Größe zurück, trimmt jetzt aber auch Ihren eigenen Code und Ihre NuGet-Referenzen, braucht also einen vollständigen Regressionsdurchlauf. Ändern Sie eines nach dem anderen und wiederholen Sie dazwischen Schritt 5. **Verifizierung:** Jeder Regler ist durch ein gemessenes Delta gerechtfertigt, das Sie benennen können, nicht durch einen Blogbeitrag.

8. **Rollen Sie stufenweise aus.** Veröffentlichen Sie zuerst in einem internen Track und beobachten Sie gezielt die ANR-Rate, nicht nur die Absturzrate. Der gemeldete CoreCLR-Fehlermodus bei großen Apps ist ein Start, der lange genug dauert, dass Android den Prozess beendet, was sich als ANR und nicht als Ausnahme zeigt. **Verifizierung:** Die ANR-Rate in der Play Console ist nach einer Woche internem Test gegenüber Ihrem Mono-Build unverändert.

## Verifizierungscheckliste

- `dotnet build -f net11.0-android -c Release` erzeugt im Binärlog keinen Aufruf von `MonoAOTCompiler`.
- Der Median des Kaltstarts auf einem echten Gerät liegt innerhalb Ihres akzeptierten Bandes gegenüber der .NET 10-Basislinie.
- Das APK/AAB-Größendelta ist erfasst und akzeptiert.
- Die vollständige Testsuite läuft durch, einschließlich Tests, die Reflexion, `HttpClient`-Fehlerpfade oder Serialisierung berühren.
- Hot Reload funktioniert. Auf CoreCLR läuft das über Edit and Continue statt über den Mono-Interpreter, ist also ein tatsächlich anderer Codepfad als der, den Sie zuletzt getestet haben.
- Keine Geräte mit API 21-23 in Ihrer aktiven Installationsbasis, oder Sie haben den Wegfall kommuniziert.

## Rollback-Plan

Sagen Sie es deutlich: **Ein Rollback auf Laufzeitebene gibt es nicht mehr.** `<UseMonoRuntime>true</UseMonoRuntime>` war als Notausstieg dokumentiert, als CoreCLR in Preview 4 zum Standard wurde, und wurde damals ausdrücklich als vorübergehende Entsperrung während einer Regressionsmeldung eingeordnet. Preview 6 hat den separaten Mono-Pfad für Android, iOS und Mac Catalyst entfernt. Behandeln Sie die Eigenschaft als nicht mehr vorhanden und bauen Sie keinen Release-Plan darauf auf.

Ihr tatsächliches Rollback ist das Target Framework: Halten Sie den `net10.0-android`-Build in einem Branch grün, bis der .NET 11-Build ein echtes Produktions-Rollout überstanden hat. Das ist ein deutlich schwereres Rollback als das Umlegen einer Eigenschaft, und genau deshalb gibt es die Schritte 1 und 5.

## Fallstricke, die echte Zeit kosten

**Die Startregression ist real und ungleich verteilt.** Zwei Issues dokumentieren den Fehlermodus: [dotnet/android#10588](https://github.com/dotnet/android/issues/10588) berichtet "an app that takes 1s to launch on mono can take 6s on coreclr", mit ANRs in Avalonias `ControlCatalog.Android`, und [dotnet/android#10914](https://github.com/dotnet/android/issues/10914) meldet rund 1,0 s auf 6,0 s Kaltstart und ein APK-Wachstum von 21 MB auf 38 MB unter `11.0.100-preview.2`. Beide betreffen Avalonia, nicht MAUI, und beide liegen vor der Arbeit an composite partial R2R und den MIBC-Profilen, die später im Preview-Zyklus landete. Lesen Sie sie also nicht als Ihr zu erwartendes Ergebnis, sondern als Begründung dafür, dass Schritt 1 verpflichtend ist.

**XAML-lastige Startpfade sind die schmerzhaften.** Der gemeinsame Nenner der Berichte sind Reflexion und XAML-Parsing während der Initialisierung, also genau die Arbeit, die partielles R2R nicht vorkompilieren kann, wenn das ausgelieferte `.mibc`-Profil die Form Ihrer App nicht abdeckt. Baut Ihre App vor dem ersten Frame einen großen visuellen Baum auf, schauen Sie dort zuerst hin.

**`UseInterpreter` verliert stillschweigend seine Bedeutung.** Unter Mono war die Eigenschaft im Debug standardmäßig `true` und ließ das Hot Reload der Mono-Ära funktionieren. Auf CoreCLR ist sie wirkungslos. Falls Sie sie aus einem Grund gesetzt hatten (ein dynamischer Codepfad, den Mono AOT nicht abbilden konnte), ist dieser Grund nicht verschwunden, sondern nur verschoben: CoreCLR unter Android führt im Debug einen echten JIT aus, der Code läuft also, aber testen Sie ihn bewusst erneut, statt es anzunehmen.

**Der Inhalt Ihres APK ändert seine Form.** Unter Mono lieferten Sie `libmonosgen-2.0.so` plus `libaot-*.dll.so`-Images aus. Unter CoreCLR liefern Sie `libcoreclr.so`, `libclrjit.so`, `libmonodroid.so` (der Android-Klebecode behält seinen Namen aus der Mono-Ära) und eine einzelne `libassemblies.arm64-v8a.so` mit komprimiertem MSIL samt R2R-Images. Wenn Sie Build-Skripte, Größenbudgets oder ProGuard/R8-Konfiguration haben, die diese Dateien benennen, müssen sie angepasst werden.

**Die Größe steckt tatsächlich im Trimming.** MAUI verwendet weiterhin `TrimMode=partial` als Standard, das Framework-Assemblys trimmt, Ihren Code und Ihre NuGet-Referenzen aber unangetastet lässt. Die meisten Größenbeschwerden werden zu Trimming-Beschwerden, sobald man die Aufschlüsselung pro Assembly betrachtet.

## Verwandte Beiträge

- Der Laufzeitwechsel wurde angekündigt, als [MAUI CoreCLR in Preview 4 zum Standard auf Android, iOS und Mac Catalyst machte](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/), woher die Opt-out-Eigenschaft stammt.
- Der Notausstieg schloss zwei Monate später, als [MAUI Mobile in Preview 6 CoreCLR-only wurde](/de/2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6/).
- Wenn Sie noch auf dem alten Stack sind, ist die vorgelagerte Migration [Xamarin.Forms zu MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/), nicht diese hier.
- Der Kompromiss zwischen R2R und Mono AOT aus Schritt 7 wird ausführlich in [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) behandelt, und das Endziel, das CoreCLR unter Android eröffnet, beschreibt [was Native AOT tatsächlich kostet](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/).
- Falls `TrimMode=full` aus Schritt 7 Ihre Serialisierung bricht, sieht der Fehler aus wie [reflection-based serialization has been disabled for this application](/de/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/).
- Das Ändern der ausgelieferten ABI-Liste in Schritt 4 kann [den Installationsfehler "doesn't support required ABI"](/de/2026/08/fix-doesnt-support-required-abi-when-installing-a-dotnet-maui-android-app/) auf Geräten erzeugen, die Sie zuvor bedient haben.

## Quellen

- [.NET MAUI Moves to CoreCLR in .NET 11](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/), der .NET-Blog
- [CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/), der .NET-Blog
- [Runtimes and compilation in .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/deployment/runtimes-compilation), Microsoft Learn
- [Breaking change: Minimum Android API level raised to 24](https://learn.microsoft.com/en-us/dotnet/core/compatibility/maui/11/android-minimum-api-level), Microsoft Learn
- [Breaking change: NU1703 warning for packages that use deprecated MonoAndroid framework assets](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/11/nu1703-deprecated-monoandroid-framework), Microsoft Learn
- [dotnet-dsrouter](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter), Microsoft Learn
- [dotnet/maui#33386, das Tracking-Epic für CoreCLR unter Android](https://github.com/dotnet/maui/issues/33386)
- [dotnet/android#10588, ANR while running large app](https://github.com/dotnet/android/issues/10588)
- [dotnet/android#11068, RunAOTCompilation runs MonoAOTCompiler under CoreCLR](https://github.com/dotnet/android/issues/11068)
