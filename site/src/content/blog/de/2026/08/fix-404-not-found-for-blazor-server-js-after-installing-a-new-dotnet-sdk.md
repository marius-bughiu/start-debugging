---
title: "Lösung: 404 Not Found für blazor.server.js nach Installation eines neuen .NET SDK"
description: "blazor.server.js liefert unter .NET 10 einen 404, weil das Skript keine eingebettete Ressource mehr ist. Fügen Sie RequiresAspNetWebAssets im Host-Projekt hinzu, oder sorgen Sie für eine .razor-Datei."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
lang: "de"
translationOf: "2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk"
translatedBy: "claude"
translationDate: 2026-08-13
---

Fügen Sie `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` im Host-Projekt hinzu und führen Sie einen Restore aus. In .NET 10 ist das Blazor-Skript keine eingebettete Ressource in `Microsoft.AspNetCore.Components.Server` mehr, sondern eine Datei aus dem NuGet-Paket `Microsoft.AspNetCore.App.Internal.Assets`, das das SDK nur einbindet, wenn das Projekt mindestens eine `.razor`-Datei enthält. Keine `.razor`-Datei im Host, kein Skript, 404. Alles Folgende wurde mit SDK 10.0.201 und ASP.NET Core 10.0.5 unter Windows 11 gemessen.

## Der Fehler im Kontext

Die Browser-Konsole, ausgehend von einer `_Host.cshtml`, die seit .NET 6 unverändert funktioniert hat:

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

Die Seite rendert ihr vorgerendertes HTML und tut dann nichts mehr. Es öffnet sich kein Circuit, kein Button funktioniert, und das Server-Log bleibt still, weil ein 404 aus der Static-File-Middleware keine Ausnahme ist. Dasselbe passiert mit `_framework/blazor.web.js` in einer Blazor Web App.

Verwirrend ist der Auslöser. Die Projektdatei hat sich nicht geändert. Sehr oft hat sich auch das Target Framework nicht geändert. Jemand hat das .NET 10 SDK installiert, und eine Anwendung, die gestern noch kompilierte und lief, liefert jetzt für eine einzige Datei einen 404.

## Warum das Skript verschwunden ist

Bis .NET 9 war `blazor.server.js` eine eingebettete Ressource innerhalb der Assembly des Shared Framework, und `MapBlazorHub()` registrierte einen eigenen Endpunkt, der sie aus dieser Assembly las. Dieser Endpunkt konnte die Datei nicht verfehlen, weil die Datei in der DLL lag, die den Endpunkt registrierte.

.NET 10 hat ihn entfernt. Javier Calvarro Nelson aus dem ASP.NET Core Team [hat es klar benannt](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403), als das zum ersten Mal gemeldet wurde:

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

Das ist ein echter Gewinn. Das Skript bekommt jetzt Gzip zur Build-Zeit, Brotli beim Publish, einen Content-Hash in der URL und ein einjähriges immutable `Cache-Control`. Es ändert aber, woher die Datei kommt. Sie ist jetzt ein Static Web Asset, geliefert von einem NuGet-Paket, das das SDK hinter Ihrem Rücken in den Restore-Graph aufnimmt. Auf meinem Rechner:

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

Die Version legt das SDK fest, nicht Ihr Projekt. `Microsoft.NETCoreSdk.BundledVersions.props` in der SDK-Installation entscheidet darüber:

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

Und hier ist der Teil, der den 404 tatsächlich verursacht. Das SDK fügt dieses Paket nicht jedem Webprojekt hinzu, denn die meisten Webprojekte sind keine Blazor-Anwendungen, und niemand möchte ein Blazor-Skript in einer Minimal API herunterladen. Es rät, mit einer einzigen Heuristik:

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

Hat das Host-Projekt eine `.razor`-Datei in seinen `Content`-Items, kommt das Paket herein. Andernfalls fällt `RequiresAspNetWebAssets` auf seinen Standardwert `false` zurück, das Paket wird nie wiederhergestellt, und `_framework/blazor.server.js` steht schlicht nicht im Static-Web-Asset-Manifest der Anwendung. Es gibt keine Warnung zur Build-Zeit. Der Build ist erfolgreich.

Viele reale Blazor-Server-Anwendungen haben keine `.razor`-Datei im Host-Projekt. Wenn Ihre Komponenten in einer Razor Class Library liegen und der Host nur aus `Program.cs`, `_Host.cshtml` und einer Projektreferenz besteht, sagt die Heuristik "keine Blazor-Anwendung", und Sie bekommen einen 404.

## Minimale Reproduktion

Ein ASP.NET Core Host, der Blazor-Server-Komponenten aus einer RCL bedient. Nichts Exotisches:

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

Kompilieren Sie das und sehen Sie nach, was der Restore entschieden hat:

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

Das Paket fehlt im Restore-Graph und das Skript fehlt im Manifest. Ein Request darauf liefert HTTP 404 mit einem Body von null Bytes. Verschieben Sie eine einzige `.razor`-Datei in das Host-Projekt oder setzen Sie die unten genannte Eigenschaft, und beide Zählungen werden von null verschieden.

## Die Lösung

**Setzen Sie die Eigenschaft im Host-Projekt.** Das ist der unterstützte Ausweg und der, auf den das ASP.NET Core Team verweist. Sie gehört in das Projekt, das `Microsoft.NET.Sdk.Web` verwendet, also in das, das die Anfragen tatsächlich bedient, nicht in die RCL:

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

Führen Sie danach einen Restore aus, denn das Paket gelangt während des Restore in den Graph, nicht während des Builds:

```bash
dotnet restore
```

`dotnet build` führt einen impliziten Restore aus, ein normaler Rebuild greift also meist. Ein CI-Schritt mit `dotnet build --no-restore` gegen einen Restore, der vor dem Hinzufügen der Eigenschaft lief, greift nicht. Nach der Änderung sind beide Prüfungen positiv, und die Datei wird mit 164.838 Bytes ausgeliefert.

**Oder fügen Sie dem Host eine `.razor`-Datei hinzu.** `App.razor` (oder eine beliebige Komponente) zurück ins Host-Projekt zu verschieben, erfüllt die Heuristik ohne MSBuild-Eigenschaft. In Ordnung, wenn Sie ohnehin eine hätten, aber es ist ein seltsamer Grund, Code zu verschieben, und die Eigenschaft drückt die Absicht besser aus.

**Greifen Sie nicht zu `MapStaticAssets()`.** Das ist der häufigste schlechte Ratschlag zu diesem Fehler, und es lohnt sich, hier deutlich zu werden, weil er Stunden kostet. Eine funktionierende Pipeline auf `MapStaticAssets()` umzustellen behebt kein fehlendes Paket, und `UseStaticFiles()` war nie das Problem. Das Team [hat einen Community-PR geschlossen](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296), der auf dieser Diagnose beruhte:

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

Das deckt sich mit meiner Messung. Ist das Paket vorhanden, liefern `UseStaticFiles()` und `MapBlazorHub()` das Skript in Development und aus dem Publish-Output aus, ohne `MapStaticAssets()` an irgendeiner Stelle.

## Was jede Konfiguration tatsächlich zurückgibt

Neun Läufe gegen dieselbe Reproduktion, jeder ein HTTP-Request auf `/_framework/blazor.server.js` gegen einen echten Kestrel-Prozess:

| Host-Projekt | Pipeline | Umgebung | Ausgeführt aus | Ergebnis |
| --- | --- | --- | --- | --- |
| mit `.razor` | `UseStaticFiles()` | Development | `dotnet run` | 200, 164838 Bytes |
| mit `.razor` | `UseStaticFiles()` | Development | Build-Output | 200 |
| mit `.razor` | `UseStaticFiles()` | Production | Build-Output | **404** |
| mit `.razor` | `UseStaticFiles()` | Production | Publish-Output | 200 |
| mit `.razor` | `MapStaticAssets()` | Development | Build-Output | 200 |
| mit `.razor` | `MapStaticAssets()` | Production | Build-Output | **500** |
| ohne `.razor` | `UseStaticFiles()` | Development | Build-Output | **404** |
| ohne `.razor`, Eigenschaft gesetzt | `UseStaticFiles()` | Development | Build-Output | 200 |
| `EnableDefaultContentItems=false` | beliebig | beliebig | beliebig | Paket wird nie wiederhergestellt |

Zwei Zeilen verdienen eine eigene Erklärung.

**Production gegen den Build-Output liefert einen 404, selbst wenn das Projekt korrekt konfiguriert ist.** `WebApplication.CreateBuilder` ruft `UseStaticWebAssets()` nur in der Umgebung Development auf. In Development bildet das Static-Web-Asset-Manifest `_framework/` direkt auf den oben gezeigten NuGet-Cache-Ordner ab. In jeder anderen Umgebung wird dieses Mapping nicht angewendet, und der Build-Output hat kein eigenes `wwwroot/_framework/`, es gibt also nichts auszuliefern. Der Publish-Output funktioniert, weil `dotnet publish` die echten Dateien (samt `.gz`- und `.br`-Varianten) nach `wwwroot/_framework/` kopiert. Das trifft CI-Smoke-Tests und Container-Images, die den Output von `dotnet build` mit `ASPNETCORE_ENVIRONMENT=Staging` ausführen. Neu ist das in .NET 10 nicht, aber vor .NET 10 hat der Endpunkt mit der eingebetteten Ressource es für genau diese Datei verdeckt.

**Dieselbe Konfiguration unter `MapStaticAssets()` liefert 500, nicht 404**, was diagnostisch nützlich ist. Der Endpunkt wird aus `BzSrv.staticwebassets.endpoints.json` registriert, die in das Ausgabeverzeichnis kopiert und unabhängig von der Umgebung gelesen wird, das Routing trifft also. Der File Provider kann die Bytes dann nicht liefern:

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

Ein 500 mit diesem Stack Trace bedeutet, dass das Manifest das Skript kennt und der File Provider es nicht erreicht, das Paket ist also in Ordnung und Ihre Umgebung oder Ihr Ausgabeverzeichnis ist falsch. Ein glatter 404 bedeutet, dass es nie im Manifest stand, das Paket fehlt also und `RequiresAspNetWebAssets` ist Ihre Lösung.

## Fallstricke und Verwechslungen

**`EnableDefaultContentItems=false` schaltet die Heuristik still ab.** Die MSBuild-Bedingung prüft `Content`-Items, nicht Dateien auf der Platte. Ein Host-Projekt mit `App.razor` direkt neben `Program.cs` stellt das Paket trotzdem nicht wieder her, wenn die Standard-Content-Globs abgeschaltet sind. Verifiziert: gleiches Projekt, gleiche Datei, Paket fehlt. Setzen Sie die Eigenschaft explizit in jedem Projekt, das Content-Items anpasst.

**Ein `Microsoft.NET.Sdk.Razor`-Projekt erkennt das nie automatisch.** Das Target `ResolveRequiredWebAssets` wird ausschließlich in `Microsoft.NET.Sdk.Web.ProjectSystem.targets` ausgeliefert. Verwendet Ihr Host das Razor SDK oder setzt `<OutputType>Library</OutputType>`, setzt nichts `RequiresAspNetWebAssets` für Sie, egal wie viele Komponenten er enthält. Genau diese Form ist in [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545) gemeldet. Setzen Sie die Eigenschaft von Hand.

**`packages.lock.json` macht aus der Lösung einen Build-Fehler.** Das Hinzufügen der Eigenschaft ändert den Restore-Graph, ein gesperrter Restore weist ihn deshalb mit einer wiedererkennbaren Meldung ab:

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

Erzeugen Sie die Lock-Datei einmal neu und committen Sie sie:

```bash
dotnet restore --force-evaluate
```

**Der Restore muss das Paket erreichen können.** Es ist ein echtes Paket von nuget.org, nichts, was in der SDK-Installation mitgeliefert wird. Builds ohne Netzzugang und private Feeds ohne Upstream-Spiegel finden es nicht, und die SDK-Version, nicht Ihr Target Framework, entscheidet, welche Version angefordert wird. Installieren Sie einen neuen SDK-Patch, braucht Ihr Offline-Feed eine passende neue Version von `Microsoft.AspNetCore.App.Internal.Assets`.

**Verschwindet der Paketordner, liefert die Anwendung keinen 404, sondern startet nicht.** Den NuGet-Cache zu leeren, während veralteter Build-Output liegen bleibt, ergibt beim Start Folgendes, bevor Kestrel bindet:

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

Das Manifest in `bin` hält einen absoluten Pfad in den Paket-Cache. Löschen Sie `bin` und `obj` und kompilieren Sie neu.

**Eine .NET 9 Anwendung kann darauf laufen, ohne aktualisiert worden zu sein.** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) ist eine `net9.0`-Blazor-Anwendung, die genau in dem Moment 404 lieferte, als das .NET 10 SDK installiert wurde. Ursache war `DOTNET_ROLL_FORWARD=LatestMajor` in der Umgebung: die Anwendung rollte auf die 10.0-Laufzeit vor, in der das Skript nicht mehr eingebettet ist, während sie weiterhin als .NET 9 Projekt kompilierte, das das Paket nie wiederherstellt. Prüfen Sie `dotnet --info` auf diese Variable, bevor Sie die Projektdatei anfassen. Läuft sie auf der 9.0-Laufzeit, ist die eingebettete Ressource weiterhin da und alles funktioniert, .NET 10 SDK hin oder her.

**Die Dokumentation untertreibt die Reichweite.** Der [Artikel zur Blazor-Projektstruktur](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) schreibt, die `.razor`-Datei sei nötig "in order to automatically include the Blazor script when the app is published". Es betrifft auch `dotnet build`: die obige Reproduktion liefert unter `dotnet run` in Development einen 404, lange bevor jemand irgendetwas publiziert.

**In .NET 11 ist das unverändert.** Das Auslieferungsmodell für Static Assets und die Eigenschaft `RequiresAspNetWebAssets` bleiben bestehen, und die oben genannte Dokumentationsseite gilt für die Moniker `aspnetcore-10.0` und `aspnetcore-11.0` gleichermaßen. Ein Upgrade über 10 hinaus hebt die Anforderung nicht auf.

## Verwandt

Wenn Sie mitten in einem Upgrade stecken und das nur eines von mehreren gleichzeitig aufgetretenen Problemen ist: die Blazor-Punkte sind in der [Checkliste von .NET 8 auf .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) gesammelt, und die Render-Mode-Seite derselben Umstellung steht in [Migration einer Blazor Server Anwendung zu Blazor United](/de/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/). Sobald das Skript lädt und tatsächlich ein Circuit aufgeht, sind die beiden nächsten Stolpersteine [das Reconnect-Banner nach einem getrennten Circuit](/de/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/) und [JavaScript-Interop-Aufrufe, die während des Prerendering nicht abgesetzt werden können](/de/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). Falls Sie noch entscheiden, ob der Host überhaupt weiter Komponenten hosten soll, behandelt [Blazor Server vs WebAssembly vs United](/de/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) die Abwägung.

## Quellen

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0), für die Eigenschaft `RequiresAspNetWebAssets` und die Regel mit mindestens einer `.razor`-Datei.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0), für `MapStaticAssets` gegenüber `UseStaticFiles` und was beide jeweils ausliefern können.
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381), die ursprüngliche Meldung, mit der Erklärung des Teams, warum die Skripte keine eingebetteten Ressourcen mehr sind.
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175), derselbe 404 unter SDK 10.0.201 nach dem Upgrade einer Blazor Server Anwendung, geschlossen durch Hinzufügen der Eigenschaft.
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) und [der daraus vorgeschlagene PR](https://github.com/dotnet/aspnetcore/pull/66060), warum das Wiedereinführen der alten Endpunkte mit eingebetteten Ressourcen abgelehnt wurde, samt Bestätigung, dass `UseStaticFiles()` diese Dateien heute ausliefert.
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353), für die Roll-Forward-Variante, die `net9.0`-Anwendungen nach einer SDK-Installation bricht.
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545), für die Variante mit `OutputType` / Nicht-Web-SDK.
