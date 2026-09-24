---
title: "Lösung: Conflicting assets with the same target path nach dem Upgrade auf das .NET 10 SDK"
description: "Mit dem .NET 10 SDK erhält jedes Microsoft.NET.Sdk.Web-Projekt StaticWebAssetBasePath=/, daher kollidiert eine Web-App, die eine andere Web-App referenziert. Setzen Sie den Basispfad im referenzierten Projekt. Das Deaktivieren der Komprimierung hilft nicht."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
lang: "de"
translationOf: "2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10"
translatedBy: "claude"
translationDate: 2026-09-24
---

Fügen Sie `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` dem **referenzierten** Projekt hinzu, also dem, dessen `wwwroot` früher unter `/_content/...` erschien. Seit dem .NET 10 SDK erhält jedes `Microsoft.NET.Sdk.Web`-Projekt den Basispfad `/`. Wenn eine Web-App eine andere referenziert, veröffentlichen beide `css/site.css` unter derselben URL, und die Static-Web-Assets-Pipeline verweigert den Build. Die Komprimierung abzuschalten bewirkt nichts, weil die Prüfung vor der Komprimierung läuft. Alles Folgende wurde mit SDK 10.0.302 und SDK 9.0.318 unter macOS gemessen.

## Der Fehler im Kontext

Die vollständige Meldung ist lang, weil sie beide Asset-Einträge ausgibt. Gekürzt auf die Teile, die Sie lesen müssen:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

Drei Felder zeigen, welcher Fall vorliegt:

- **`SourceId`** nennt die beiden Projekte, die das Asset erzeugen. Zwei verschiedene IDs bedeuten eine projektübergreifende Kollision.
- **`SourceType`** ist `Discovered` für das Projekt, das gerade kompiliert wird, `Project` für eine Projektreferenz und `Package` für ein NuGet-Paket.
- **`BasePath`** ist das URL-Präfix. Zeigt das referenzierte Projekt `BasePath: /` statt `_content/<Name>`, haben Sie es mit der unten beschriebenen Änderung in .NET 10 zu tun.

Der Zielpfad endet manchmal auf `.gz` oder `.br`, weshalb dieser Fehler meist der Build-Zeit-Komprimierung zugeschrieben wird, die mit .NET 9 kam. Mit dem aktuellen SDK ist das selten die eigentliche Ursache.

## Warum das mit dem .NET 10 SDK passiert

Static Web Assets legen zur Build-Zeit fest, welche Datei auf welche URL antwortet, und das Manifest kann einer Route nur eine Datei zuordnen. Vor .NET 10 verhielt sich ein Webprojekt, das von einem anderen Webprojekt *referenziert* wurde, wie eine Klassenbibliothek: Das SDK setzte seinen `StaticWebAssetBasePath` standardmäßig auf `_content/$(PackageId)`, sodass aus `wwwroot/css/site.css` im Host `/_content/Common/css/site.css` wurde und nichts kollidierte.

Das .NET 10 SDK hat `Sdk.Server.props`, die Props-Datei, die jedes `Microsoft.NET.Sdk.Web`-Projekt importiert, so geändert, dass sie Folgendes bedingungslos setzt:

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

Dieselbe Datei in SDK 9.0.318 setzt keine der beiden Eigenschaften. Der Standardwert `_content/$(PackageId)` in `Microsoft.NET.Sdk.StaticWebAssets.targets` greift nur, wenn `StaticWebAssetBasePath` leer ist, und mit SDK 10 ist er das bei einem Webprojekt nie. Beide Web-Apps beanspruchen jetzt `/`, und jede Datei, die in beiden `wwwroot`-Ordnern unter demselben relativen Pfad liegt, ist ein Konflikt.

Die Position des ASP.NET Core-Teams aus [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138) lautet, dass eine Web-App, die eine Web-App referenziert, nie eine unterstützte Konstellation war: "Only class libraries or Blazor apps can be referenced by webapps in a supported capacity." Das Issue wurde ohne Codeänderung geschlossen, und bis heute taucht die Änderung weder auf der [Seite zu den Breaking Changes in .NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10) noch auf der [Seite zu den Breaking Changes in ASP.NET Core 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview) auf. Deshalb trifft sie so viele Upgrades unvorbereitet.

Entscheidend ist das **SDK**, nicht Ihr Target Framework. Ein `net8.0`- oder `net9.0`-Projekt scheitert genauso, sobald es mit SDK 10.x kompiliert wird. Genau das meldete [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) für eine `netcoreapp8.0`-App.

## Minimale Reproduktion

Zwei leere Web-Apps, jede mit eigener `wwwroot/css/site.css`, die eine referenziert die andere:

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

Gemessene Ergebnisse für genau dieses Projektpaar:

| SDK | TargetFramework | Ergebnis |
| --- | --- | --- |
| 9.0.318 | net9.0 | Build erfolgreich. Routen: `css/site.css`, `_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | Gleicher Fehler |
| 10.0.302 | net10.0, `-p:DisableBuildCompression=true` | Gleicher Fehler |
| 10.0.302 | net10.0, `-p:CompressionEnabled=false` | Gleicher Fehler |
| 10.0.302 | net10.0, nach `rm -rf */bin */obj` | Gleicher Fehler |

Die letzten drei Zeilen sind die, die man sich merken sollte. Der Rat, der in Suchergebnissen zu diesem Fehler zuerst auftaucht, lautet, die Komprimierung zu deaktivieren oder `bin` und `obj` zu löschen. Beides ändert an dieser Ursache nichts. Der Konflikt wird von `GenerateStaticWebAssetsManifest` in Zeile 640 der Targets-Datei ausgelöst, und das läuft unabhängig davon, ob die Komprimierung aktiv ist.

## Lösung: dem referenzierten Projekt seinen alten Basispfad zurückgeben

Setzen Sie die Eigenschaft in der csproj des referenzierten Projekts (hier `Common`), nicht im Host:

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

Das Setzen in der Projektdatei funktioniert, weil das SDK `/` in einer Props-Datei setzt, die vor dem Inhalt Ihres Projekts ausgewertet wird, sodass Ihr Wert gewinnt. Nach der Änderung ist `dotnet build Main` erfolgreich, und `Main.staticwebassets.endpoints.json` enthält beide Routensätze:

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

Ich habe den Host mit `app.MapStaticAssets()` gestartet und beide URLs abgerufen. `/css/site.css` lieferte die Datei aus `Main` und `/_content/Common/css/site.css` die Datei aus `Common`, jeweils mit `Content-Encoding: gzip`, wenn die Anfrage es zuließ. Die komprimierten Varianten werden also wie bisher pro Projekt erzeugt.

Der Basispfad gilt nur für Konsumenten. Ich habe `Common` nach der Änderung eigenständig gestartet: `/css/site.css` lieferte weiterhin 200, `/_content/Common/css/site.css` dagegen 404. Ein Projekt, das zugleich eigenständige App und Referenz ist, funktioniert in beiden Rollen weiter.

### Verwenden Sie hier nicht `$(PackageId)`

Der naheliegende Weg, den alten Standardwert nachzubilden, ist `_content/$(PackageId)`, denn genau das hat das SDK früher berechnet. In der csproj funktioniert das nicht. `PackageId` wird erst später in den NuGet-Targets gesetzt, und zu dem Zeitpunkt, an dem Ihre `PropertyGroup` ausgewertet wird, ist der Wert noch leer. Ich habe es ausprobiert: Der Build war erfolgreich, aber die Routen wurden zu `_content/css/site.css`. Das bricht stillschweigend jedes `<link href="_content/Common/...">` in Ihren Views und sieht dabei wie eine Lösung aus. Verwenden Sie `$(MSBuildProjectName)` oder schreiben Sie den Namen direkt aus, falls Ihr `AssemblyName` vom Namen der Projektdatei abweicht und Ihr Markup den Assemblynamen verwendet.

### Besser: keine Web-App mehr referenzieren

Wenn `Common` nur dazu existiert, Razor-Views, Komponenten und `wwwroot`-Dateien zu teilen, machen Sie daraus eine Razor-Klassenbibliothek (`Microsoft.NET.Sdk.Razor`). Das ist die unterstützte Konstellation, sie erhält standardmäßig `_content/{PackageId}`, und so beschreibt auch die [Dokumentation zu statischen Dateien in Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) das Teilen von Assets. Behalten Sie die Basispfad-Eigenschaft für die Fälle, in denen das referenzierte Projekt tatsächlich auch als App laufen muss, etwa ein Integrationstest-Host auf Basis von `Microsoft.NET.Sdk.Web`, der die echte App referenziert.

## Dieselbe Datei in zwei Projekten einer Blazor Web App

Der zweite häufige Auslöser hat nichts mit Referenzen zwischen Web-Apps zu tun. In einer Blazor Web App mit interaktivem WebAssembly tragen das Serverprojekt und das `.Client`-Projekt beide zu `/` bei. Das ist so gewollt: Die Assets des Clients werden vom Stamm des Hosts ausgeliefert.

Eine Datei, die in beiden `wwwroot`-Ordnern existiert, kollidiert also. Ich habe das mit der Vorlage `dotnet new blazor -int WebAssembly` auf SDK 10.0.302 reproduziert, indem ich `favicon.png` nach `W.Client/wwwroot` kopiert habe:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

Hier ist die Lösung kein Basispfad. Sie wollen die Dateien des Clients nicht unter `_content/` verschieben. Halten Sie jede Datei in genau einem der beiden Projekte. Eine brauchbare Regel: Assets, die nur serverseitig gerendertes Markup benötigt, gehören ins Serverprojekt; Assets, die der WebAssembly-Code zur Laufzeit lädt, gehören nach `.Client`. Wenn Sie von der alten gehosteten Blazor-WebAssembly-Vorlage migriert haben, in der das Client-Projekt `index.html`, `favicon` und das CSS besaß, ist das der übliche Überrest. Der [Vergleich der Blazor-Hosting-Modelle](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) erklärt, warum sich die beiden Projekte einen Stamm teilen.

## Wenn wirklich die Komprimierung die Ursache ist

Die Build-Zeit-Komprimierung kam mit .NET 9, und während der .NET 9 Previews hat sie diesen Fehler tatsächlich verursacht. Pakete wie `Z.Blazor.Diagrams` 3.0.2 und manche Bundler-Setups lieferten eigene `.gz`-Dateien in `wwwroot` mit. Das SDK versuchte dann, für dasselbe Asset `app.js.gz` zu erzeugen, und kollidierte mit der bereits vorhandenen Datei ([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512), [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413)).

Das wurde mit [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518) behoben, geschlossen im November 2024. Das aktuelle SDK führt eine `DiscoverPrecompressedAssets`-Task aus, die ein vorhandenes `.gz`- oder `.br`-Gegenstück erkennt und als komprimierte Variante behandelt, statt eine eigene zu erzeugen. Ich habe beide Fälle auf SDK 10.0.302 geprüft:

- Eine Web-App mit eingecheckten `wwwroot/js/app.js`, `app.js.gz` und `app.js.br`: Build und Publish gelingen ohne eine einzige Warnung. Das Endpunkt-Manifest ordnet `js/app.js` mit einem `gzip`-Selektor `js/app.js.gz` zu, und die veröffentlichte `app.js.gz` ist byte-identisch mit der von mir erstellten Datei. Ausgeliefert wird Ihre Datei, keine neu erzeugte.
- Eine Web-App, die `Z.Blazor.Diagrams` 3.0.2 referenziert, das Paket aus #57512: kompiliert fehlerfrei.

Wenn Sie also auf einer SDK 9.0.1xx Preview sind, aktualisieren Sie das SDK. Wenn Sie bestimmte Dateien trotzdem von der Komprimierung ausnehmen müssen, etwa weil ein Bundler bereits eine eigene `.br` mit besseren Einstellungen schreibt, verwenden Sie die Ausschlussliste, statt die Funktion abzuschalten. Das habe ich auf SDK 10.0.302 überprüft: Nach dem Publish hatte `app.bundle.js` kein `.gz`- oder `.br`-Gegenstück, während `other.js` im selben Ordner beide hatte.

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` überspringt die Komprimierung nur für `dotnet build` (Publish komprimiert weiterhin), und `CompressionEnabled=false` entfernt die Komprimierungs-Targets vollständig. Beides ist für die Build-Geschwindigkeit sinnvoll. Keines von beiden behebt eine Basispfad-Kollision, wie die Tabelle oben zeigt. Die Komprimierung von Antworten zur Laufzeit ist wiederum eine separate Funktion; für diese Seite siehe [Antwortkomprimierung in einer ASP.NET Core API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/).

## Stolperfallen und ähnliche Fehler

**"Two assets found targeting the same path with incompatible asset kinds" ist ein anderer Fehler.** Sie erhalten ihn innerhalb eines *einzelnen* Projekts, zum Beispiel wenn ein `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />`-Element auf dieselbe Route zeigt wie eine echte `wwwroot/js/app.js`. Ich habe ihn auf SDK 10.0.302 aus Zeile 706 derselben Targets-Datei reproduziert. Entfernen Sie eines der beiden Elemente.

**`The "DiscoverPrecompressedAssets" task failed unexpectedly` mit `An item with the same key has already been added`** ist ein verwandter Bug in .NET 10, der ebenfalls ausgelöst wird, wenn ein Webprojekt ein anderes referenziert, oft mit einem Schlüssel, der auf `blazor.web.js` in `microsoft.aspnetcore.app.internal.assets` zeigt. Er ist als [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) noch offen. Die Basispfad-Lösung oben ist das Erste, was Sie versuchen sollten, weil sie die doppelte Registrierung an der Quelle entfernt. Wenn Sie nach dem Upgrade außerdem einem fehlenden Blazor-Skript hinterherjagen, erklärt [der Beitrag zum 404 für blazor.server.js](/de/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/) dieses Paket.

**Wenn der Fehler zwischen Builds kommt und geht**, verdächtigen Sie einen Build-Schritt, der in `wwwroot` schreibt (TypeScript, LibMan, ein JS-Bundler), während die Static-Web-Assets-Targets den Ordner lesen. [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) dokumentiert eine Race Condition, die sich als dieser Fehler, als `No file exists for the asset` oder als `The asset ... can not be found` zeigt. Sie tritt auch mit einem einzigen Target Framework auf. Die zuverlässige Lösung ist, den Generator als eigenen Schritt vor MSBuild auszuführen (`npm run build && dotnet build` in CI und in Ihrem Startprofil) statt aus einem `BeforeTargets="Build"`-Target, damit die Dateien bereits auf der Festplatte liegen, wenn das SDK den `wwwroot`-Glob auswertet. Ein Binlog (`dotnet build -bl`) zeigt die Reihenfolge; der [Binlog-MCP-Server](/de/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) ist ein schneller Weg, ihn abzufragen.

**SDK 9 per `global.json` festzupinnen funktioniert, aber nur als Notlösung.** Die Reproduktion kompiliert mit 9.0.318 fehlerfrei, selbst wenn das .NET 10 SDK parallel installiert ist. Es bedeutet aber auch, dass Sie keine `net10.0`-Projekte kompilieren können, und die eigentliche Kollision wird nur aufgeschoben. [dotnetup](/de/2026/06/dotnetup-official-dotnet-sdk-version-manager/) macht das Wechseln von SDKs günstig, falls Sie eingrenzen müssen, welches SDK einen Fehler in Ihrem Repo eingeführt hat.

**Das alte Target "remove every `.gz` StaticWebAsset" ist überholt.** Der Workaround aus #57512, der `StaticWebAsset`-Elemente mit der Endung `.gz` vor `ResolveStaticWebAssetsConfiguration` löscht, war für die .NET 9 Previews gedacht. Mit SDK 10 wirft er vorkomprimierte Dateien weg, die das SDK inzwischen korrekt behandelt, und für den Basispfad-Fall bewirkt er nichts.

## Verwandte Beiträge

- [Lösung: 404 Not Found für blazor.server.js nach der Installation eines neuen .NET SDK](/de/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/), eine weitere Static-Web-Assets-Änderung, die mit dem SDK statt mit dem Target Framework kommt.
- [Blazor Server vs. Blazor WebAssembly vs. Blazor United in .NET 11](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/), dazu, warum sich das Serverprojekt und das `.Client`-Projekt `/` teilen.
- [Antwortkomprimierung in einer ASP.NET Core 11 API hinzufügen](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), das Laufzeit-Gegenstück zur Build-Zeit-Komprimierung von Assets.
- [Ein MCP-Server für .NET-Binlogs](/de/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/), um nachzuverfolgen, welches Target ein kollidierendes Asset erzeugt hat.
- [dotnetup, der offizielle .NET SDK-Versionsmanager](/de/2026/06/dotnetup-official-dotnet-sdk-version-manager/), um ein Repo gegen mehrere SDKs zu testen.

## Quellen

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): Regression in SDK 10 Preview 5, der `StaticWebAssetBasePath`-Workaround und die Einstufung als "nicht unterstützt".
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): derselbe Fehler bei einer `netcoreapp8.0`-App nach der Installation des neuen SDK.
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) und [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): vorkomprimierte Paket-Assets in .NET 9 und die Behebung.
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): Komprimierungseinstellungen (`DisableBuildCompression`, `BuildCompressionFormats`, `CompressionExcludePatterns`).
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) und [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): offene Static-Web-Assets-Bugs in .NET 10 mit überlappenden Symptomen.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) auf Microsoft Learn.
- Lokal untersuchte SDK-Quellen: `Sdk.Server.props`, `Microsoft.NET.Sdk.StaticWebAssets.targets` und `Microsoft.NET.Sdk.StaticWebAssets.Compression.targets` aus SDK 10.0.302 und 9.0.318.
