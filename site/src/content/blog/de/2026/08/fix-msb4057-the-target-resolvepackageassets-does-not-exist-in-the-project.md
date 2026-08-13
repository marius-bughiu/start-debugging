---
title: "Lösung: MSB4057 The target \"ResolvePackageAssets\" does not exist in the project in .NET MAUI"
description: "MSB4057 bedeutet, dass ein Target gegen den äußeren Cross-Targeting-Build eines Multi-Target-MAUI-Projekts lief. Geben Sie ein TFM an oder bedingen Sie das Target mit TargetFramework."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
lang: "de"
translationOf: "2026/08/fix-msb4057-the-target-resolvepackageassets-does-not-exist-in-the-project"
translatedBy: "claude"
translationDate: 2026-08-13
---

`ResolvePackageAssets` fehlt nicht, und Ihre Pakete sind nicht kaputt. Das Target lief gegen den **äußeren (Cross-Targeting-)Build** eines Multi-Target-Projekts, und das .NET SDK importiert `ResolvePackageAssets` dort nicht. Entweder legen Sie ein einzelnes Framework fest (`dotnet build -f net10.0-android -t:ResolvePackageAssets`), oder, falls die `.targets`-Datei eines NuGet-Pakets es aufruft, versehen Sie dieses Target mit `Condition="'$(TargetFramework)' != ''"`, damit es nur in den inneren Builds läuft. `bin` und `obj` zu löschen hilft nicht.

Alles Folgende ist auf .NET SDK 10.0.201 (MSBuild 18.3.0) mit den Workloads `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20 verifiziert. Der Cross-Targeting-Mechanismus ist in .NET 11 unverändert.

## Der Fehler im Kontext

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

Wenn ein NuGet-Paket der Auslöser ist, nennt der Fehler eine Datei und eine Spalte statt des Projektpfads. Das ist der Hinweis darauf, dass eine `.targets`-Datei danach gefragt hat und nicht Sie:

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## Warum MSB4057 bei einem Multi-Target-Projekt auftritt

Eine MAUI-App hat `TargetFrameworks` (im Plural):

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

MSBuild kompiliert dieses Projekt **doppelt**: ein äußerer Durchlauf, der nichts weiter tut als zu verteilen, und ein innerer Durchlauf pro Framework. Das SDK entscheidet über eine einzige Eigenschaft, in welchem Durchlauf Sie sich befinden, definiert in `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets`:

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

Dieses letzte Paar erklärt die ganze Sache. `ResolvePackageAssets` ist in `Microsoft.PackageDependencyResolution.targets` definiert, was von `Microsoft.NET.Sdk.targets` importiert wird, was **nur importiert wird, wenn `IsCrossTargetingBuild` nicht true ist**. Im äußeren Build erhalten Sie stattdessen `Microsoft.NET.Sdk.CrossTargeting.targets`, und die vollständige Menge der verfügbaren Targets schrumpft auf Folgendes:

- Aus `Microsoft.Common.CrossTargeting.targets`: `Build`, `Clean`, `Rebuild`, `DispatchToInnerBuilds`, `GetTargetFrameworks`, `GetTargetFrameworksWithPlatformFromInnerBuilds`, `InitializeSourceControlInformation`
- Aus `Microsoft.NET.Sdk.CrossTargeting.targets`: `Publish`, `GetAllRuntimeIdentifiers`, `GetPackagingOutputs`
- Aus `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets`: `_GetRequiredWorkloads`

Fordern Sie im äußeren Build etwas außerhalb dieser Liste an, meldet MSBuild MSB4057. `ResolvePackageAssets`, `GetTargetPath`, `GetCopyToOutputDirectoryItems` und `ComputeFilesToPublish` liegen alle außerhalb. Deshalb erscheint derselbe Fehlertext auch als `The target "GetTargetPath" does not exist in the project`, wenn der .NET Aspire AppHost versucht, ein MAUI-Projekt zu orchestrieren: gleicher Mechanismus, anderer Target-Name.

## Minimale Reproduktion

Sie brauchen kein MAUI, um das zu sehen. Jedes Projekt mit `TargetFrameworks` im Plural verhält sich identisch, was die Reproduktion auf zwei Dateien reduziert:

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

Dieselben zwei Befehle gegen eine frische `dotnet new maui`-App schlagen fehl und gelingen auf dieselbe Weise, mit `-f net10.0-android`.

## Wie bestätige ich, dass ich im äußeren Build bin?

Bevor Sie Projektdateien bearbeiten, weisen Sie nach, in welchem Build Sie sich befinden. Der Schalter `-getProperty` wertet das Projekt aus, ohne es zu kompilieren, und ist deshalb selbst bei einer MAUI-App sofort fertig:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

Bei einer MAUI-App ohne ausgewähltes Framework:

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

`IsCrossTargetingBuild: true` bestätigt, dass MSB4057 das Cross-Targeting-Problem ist und kein Tippfehler. Mit zusätzlichem `-p:TargetFramework=net10.0-android` liefert derselbe Befehl ein leeres `IsCrossTargetingBuild`, was bedeutet, dass der innere Build die vollständige SDK-Target-Menge hat. Um zu sehen, welche Frameworks zur Auswahl stehen, fragen Sie direkt danach:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

Kommt `IsCrossTargetingBuild` leer zurück und MSB4057 tritt trotzdem auf, springen Sie zum Abschnitt über Projekte, die nicht im SDK-Stil vorliegen: das ist eine andere Ursache mit demselben Fehlercode.

## Wie verhindere ich, dass die .targets-Datei eines NuGet-Pakets den äußeren Build bricht?

Das ist die Lösung für die überwiegende Mehrheit der MAUI-Meldungen, denn es ist der Fall, den Sie treffen, ohne irgendein Target namentlich angefordert zu haben. Ein NuGet-Paket (oder Ihr eigenes `Directory.Build.targets`) hängt sich an `AfterTargets="Build"` und deklariert eine Abhängigkeit von `ResolvePackageAssets`. In den inneren Builds ist das in Ordnung. Dann läuft das äußere `Build`-Target, `AfterTargets="Build"` feuert erneut, und die Abhängigkeit lässt sich nicht auflösen:

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Ein einfaches `dotnet build` gegen das obige `MultiLib` erzeugt genau das, und die Reihenfolge ist der entscheidende Hinweis:

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

Beide inneren Builds waren erfolgreich, *danach* schlug der äußere Durchlauf fehl. Zeigt Ihr Build-Log die Arbeit pro Framework als abgeschlossen und *dann* MSB4057, ist das Ihr Fall. Ergänzen Sie die Bedingung:

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Derselbe Build meldet nun `ran for TF=[net9.0]`, `ran for TF=[net10.0]`, `Build succeeded.` Die Bedingung ist die kanonische SDK-Formulierung für "nur im inneren Build", und genau das hätte das Paket ausliefern sollen. Liegt das störende Target in einem Paket unter `~/.nuget/packages/<id>/<ver>/build*/`, bearbeiten Sie es nicht direkt: der nächste Restore überschreibt Ihre Änderung. Melden Sie den Fehler dem Projekt und deaktivieren Sie den Import in der Zwischenzeit lokal.

## Wie rufe ich ein einzelnes Target über die CLI auf?

Wenn Sie `-t:` selbst tippen, nennen Sie ein Framework:

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

Das ist wichtig für Skripte und CI-Schritte, die einzelne Targets aufrufen, um einen Build zu inspizieren. `dotnet build` und `dotnet publish` ohne `-t:` sind für sich genommen unbedenklich, denn `Build` und `Publish` existieren beide in der Cross-Targeting-Menge und wissen, wie sie verteilen.

## Wie rufe ich mit dem MSBuild-Task ein Target in einem anderen Projekt auf?

Wenn ein Projekt ein Target in einem anderen ausführt (eigene Werkzeuge, die Orchestrierungs-Targets eines SDK, ein Packaging-Schritt), erbt der `MSBuild`-Task dieselbe Regel. Das hier schlägt fehl:

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

Setzen Sie die Eigenschaft am Aufruf, und es löst sich auf:

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

Wollen Sie kein Framework fest verdrahten, rufen Sie zuerst `GetTargetFrameworks` auf (es existiert im äußeren Build, genau dafür ist es da) und iterieren dann über das Ergebnis.

## Muss ich eine ProjectReference auf ein Multi-Target-Projekt ändern?

Eine gewöhnliche `ProjectReference` auf ein Multi-Target-Projekt erzeugt **kein** MSB4057. MSBuild handelt automatisch ein kompatibles Framework aus, und eine `net10.0`-Konsolen-App, die die obige `net10.0;net9.0`-Bibliothek referenziert, kompiliert sauber. Eingreifen müssen Sie nur, wenn die Aushandlung keinen Sieger bestimmen kann, was häufig vorkommt, wenn ein Test- oder Werkzeugprojekt den Head einer MAUI-App referenziert. Verwenden Sie `SetTargetFramework`:

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

Das zwingt die Referenz auf einen einzelnen inneren Build, und `MultiLib.dll` landet wie erwartet im Ausgabeverzeichnis des Konsumenten. Sehen Sie statt MSB4057 ein `NETSDK1005: Assets file doesn't have a target for ...`, scheitert die Aushandlung und nicht ein fehlendes Target, und `SetTargetFramework` bleibt die Lösung.

## Was ist, wenn das Projekt gar nicht im SDK-Stil vorliegt?

Es gibt einen zweiten, unabhängigen Weg zu demselben Fehlercode. Eine alte `.csproj`, die `Microsoft.CSharp.targets` direkt importiert, importiert nie die .NET SDK-Targets, also existiert `ResolvePackageAssets` in **keinem** Durchlauf:

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

Das trifft alle, die ein SDK-bewusstes NuGet-Paket (IKVM.Maven.SDK ist das wiederkehrende Beispiel) zu einer alten Klassenbibliothek hinzufügen, oder die ein Binding-Projekt aus der Xamarin-Zeit in einer MAUI-Lösung behalten. Hier ist `IsCrossTargetingBuild` leer, sodass die obige Diagnose beide Fälle mit einem Befehl unterscheidet. Die Lösung besteht darin, das Projekt in den SDK-Stil zu überführen oder auf Pakete zu verzichten, die SDK-Targets voraussetzen. Diese Altlasten zu migrieren ist ohnehin meist die richtige Entscheidung, wenn Sie bereits von Xamarin.Forms 5.0 zu .NET MAUI 11 wechseln.

## Feinheiten und ähnliche Fehler, die irrtümlich auf dieser Seite landen

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** Anderer Fehler, andere Ursache. Das Target existiert und *lief*; der Task hat eine Ausnahme geworfen. Meist ist eine beschädigte `project.assets.json` oder ein unlesbares Paket im globalen Cache schuld, und das ist der eine Fall, in dem `obj/` löschen und `dotnet restore` erneut ausführen tatsächlich hilft.

**"The ResolvePackageAssets task was not given a value for the required parameter TargetFramework."** Ebenfalls eine Verwechslung von innerem und äußerem Build, aber hier wurde das Target mit leerem `TargetFramework` erreicht statt gar nicht gefunden. Dieselbe Lösung: ein Framework auswählen.

**MSB4057 aus `dotnet ef` unter .NET 10.** Erfasst als Regression des `dotnet-ef`-10-Werkzeugs in [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), behoben für den Meilenstein 10.0.2. Falls Sie darauf stoßen, fixieren Sie die Werkzeugversion, statt Ihr Projekt umzubauen:

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**MSB4057 mit einem Target, das Sie selbst geschrieben haben.** Dann fehlt das Target tatsächlich oder ist falsch geschrieben, also der Fall, den [MSB4057 in der MSBuild-Dokumentation](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057) beschreibt. Prüfen Sie die Schreibweise von `BeforeTargets`, `AfterTargets`, `DependsOnTargets` und `CallTarget`, und stellen Sie sicher, dass keine `Condition` an der Target-Definition es ausgeschlossen hat.

**Aspire-Orchestrierung eines MAUI-Heads.** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) ist dasselbe Problem des äußeren Builds, das als `The target "GetTargetPath" does not exist` an die Oberfläche kommt. Von Ihrer Seite gibt es keine saubere Lösung: eine MAUI-App ist keine bedienbare Aspire-Ressource, entfernen Sie sie also aus dem AppHost und referenzieren Sie stattdessen eine gemeinsam genutzte Klassenbibliothek mit einem einzelnen Target.

## Welche Targets gehören in den inneren Build?

Alles, was in ein Projekt hineingreift, um Compiler-Eingaben, Paket-Assets oder Ausgabepfade zu holen, gehört in den inneren Build. Wenn eines Ihrer Targets `ResolvePackageAssets`, `@(ReferencePath)` oder `$(TargetPath)` berührt, braucht es `Condition="'$(TargetFramework)' != ''"`. Diese eine Zeile verhindert die meisten MSB4057-Meldungen in MAUI-Repositories und kostet in Single-Target-Projekten nichts, wo `TargetFramework` immer gesetzt ist.

Zu verwandten Build-Fehlern im selben Stack siehe die Beiträge dazu, [warum MSB3027 meldet, eine Datei nach zehn Versuchen nicht kopiert zu haben](/de/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/), [was zu prüfen ist, wenn ein Gradle-Build in MAUI Android keine .apk erzeugt](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/), [wie ein Typ- oder Namespace-Fehler nach dem Hinzufügen einer Projektreferenz behoben wird](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) und [die vollständige Migrations-Checkliste von Xamarin.Forms zu .NET MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Quellen

- [Diagnosecode MSB4057](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057), MSBuild-Dokumentation
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` und `Microsoft.Common.CrossTargeting.targets`, .NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76), MSB4057 aus der `.targets`-Datei eines Pakets in einem Projekt ohne SDK-Stil
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043), die `GetTargetPath`-Variante bei einem MAUI-Head
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), die `dotnet-ef`-10-Regression
