---
title: "Lösung: framework_version=6.0.0 was not found beim Start einer .NET-6-Binärdatei"
description: "Die .NET-6-Laufzeit fehlt oder passt nicht. Installieren Sie net6.0 erneut, machen Sie Roll Forward zu net8.0 via runtimeconfig, ändern Sie das Target des csproj, oder publizieren Sie self-contained."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
lang: "de"
translationOf: "2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary"
translatedBy: "claude"
translationDate: 2026-05-18
---

Die Lösung: Eine .NET-6-Binärdatei, die `framework_version=6.0.0` ausgibt und nicht startet, sagt Ihnen, dass die .NET-6-Laufzeit auf dieser Maschine fehlt, nicht dass Ihre Anwendung kaputt ist. Auf einem Server, der noch `net6.0` behalten darf, installieren Sie die Laufzeit Microsoft.NETCore.App 6.0, und der Startfehler verschwindet. Auf einem Server, der zu net8.0 oder net10.0 gewechselt hat, setzen Sie entweder `rollForward` auf `Major` in der `runtimeconfig.json`, ändern Sie das Target des Projekts auf ein unterstütztes Framework, oder publizieren Sie self-contained, damit die Binärdatei ihre eigene Laufzeit mitbringt. Eine `MissingMethodException` direkt nach dieser Lösung ist dasselbe Problem mit Zeitzünder: Roll Forward hat die Anwendung auf einer neueren Laufzeit starten lassen, aber ein transitives Assembly bindet hart an eine Methode, die .NET 6 hatte und die die neuere Laufzeit umbenannt hat.

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

Diese Anleitung beschreibt die Lage im Mai 2026: .NET 6 hat am 2024-11-12 das Support-Ende erreicht, also haben Produktions-Images, Paketmanager und Basis-Layer, die sich selbst aktualisieren, begonnen, es zu deinstallieren. Dieselbe Binärdatei, die zwei Jahre lang in Produktion lief, startet jetzt nicht mehr und liefert die obige Meldung. Das Verhalten ist identisch, egal ob der Host `dotnet.exe MyApp.dll` unter Windows ist, der apphost-Stub unter Linux oder `dotnet exec` unter macOS. Die hier beschriebenen Probing-Regeln der Laufzeit sind die der Hosts von .NET 6, .NET 8 und .NET 10; daran hat sich zwischen den Versionen nichts geändert.

## Zwei Fehler, eine Wurzelursache

Der Fehler erscheint in zwei Gestalten, die unverbunden wirken, und die zweite ist diejenige, über die die meisten Teams stolpern.

Form eins ist der host-fxr-Fehler oben. Der Host öffnet `MyApp.runtimeconfig.json`, liest `tfm` und den `framework`-Block, und entscheidet, dass er `Microsoft.NETCore.App` Version 6.0.0 braucht. Anschließend läuft er durch die Installationspfade und findet entweder gar nichts oder nur neuere SxS-Ordner. Die Install-URL bettet den Framework-Namen und die Version als Query-Parameter ein, deshalb landet jede Suche nach `framework_version=6.0.0` auf demselben Problem.

Form zwei ist `MissingMethodException` zur Laufzeit. Der Host hat ein kompatibles Framework gefunden, der Prozess ist gestartet, und dann ist ein `JIT_GetMethodCall`-Lookup fehlgeschlagen:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

Das passiert, wenn die Anwendung auf einer neueren Laufzeit gestartet ist, aber eines der geladenen Assemblies gegen ein .NET-6-Reference-Assembly kompiliert wurde und eine Methode referenziert, deren Signatur in .NET 8 oder .NET 10 geändert wurde. Roll Forward hat Sie an der Startprüfung vorbeigeführt, der Preis war ein verzögerter Bindungsfehler im Benutzercode. Beide Meldungen bedeuten, dass die .NET-6-Laufzeit auf dieser Maschine nicht vorhanden ist.

## Warum Ihre Binärdatei genau 6.0.0 verlangt

Der Versions-String `6.0.0` ist nicht die Laufzeit-Version, die installiert war, als Sie das Projekt gebaut haben. Er ist die Untergrenze, die durch das `<TargetFramework>` deklariert wird, gegen das Sie kompiliert haben. Wenn Sie `dotnet publish` auf einem `net6.0`-Projekt ausführen, schreibt MSBuild eine `MyApp.runtimeconfig.json`, die so aussieht:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

Der Host verwendet das `version`-Feld als Minimum, nicht als exakte Übereinstimmung. Mit der Standard-`rollForward`-Richtlinie `Minor` akzeptiert er jedes 6.x, aber niemals 7.x oder höher. Mit `Major` akzeptiert er 7.x, 8.x, 10.x. Mit `LatestPatch` akzeptiert er nur 6.0.x. Der Grund, warum Ihre Suchanfrage `framework_version=6.0.0` lautet, ist, dass der Host die angeforderte Untergrenze wiedergibt, selbst wenn überhaupt kein 6.x installiert ist.

Führen Sie `dotnet --list-runtimes` auf dem fehlerhaften Host aus. Wenn Sie `Microsoft.NETCore.App 8.0.15` und `10.0.0` sehen, aber keine 6.x-Zeile, ist das die Diagnose. Die Zeile, die dort stehen müsste, lautet `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]`.

## Minimaler Reproduzierer

Bauen Sie eine `net6.0`-Konsolenanwendung, publizieren Sie framework-dependent und führen Sie sie auf einem Host aus, der nur neuere Laufzeiten installiert hat.

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

Der Bug zeigt sich genauso in einem Docker-Image, das seine Basis von `mcr.microsoft.com/dotnet/aspnet:6.0` auf `mcr.microsoft.com/dotnet/aspnet:8.0` umgestellt hat, ohne das Projekt-Target zu ändern. Das `net6.0`-Tag in der `runtimeconfig.json` überlebt den Wechsel des Basis-Images.

## Lösung eins, empfohlen: Projekt-Target ändern

Die unterstützte Antwort im Jahr 2026 lautet: Hören Sie auf, `net6.0` auszuliefern. .NET 6 erhält seit November 2024 keine Sicherheits-Patches mehr, .NET 7 seit Mai 2024 und .NET 9 seit Mai 2026. Die einzigen derzeit unterstützten Branches sind `net8.0` (LTS, unterstützt bis November 2026), `net10.0` (LTS, unterstützt bis November 2028) und die in Entwicklung befindlichen `net11.0`-Previews.

Ändern Sie die Projektdatei, machen Sie Restore und publizieren Sie neu:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

Die `runtimeconfig.json` deklariert jetzt `version: 10.0.0`, und ein Host mit installiertem `Microsoft.NETCore.App 10.0.0` startet sie ohne Beschwerde. Das ist die einzige Lösung, die auch die `MissingMethodException`-Variante beseitigt, weil die Anwendung jetzt gegen dieselben Reference-Assemblies kompiliert wird wie die Laufzeit, auf der sie läuft.

Wenn das Projekt von einem Paket abhängt, das keinen `net10.0`-Build ausgeliefert hat, haben Sie meist zwei Auswege: die Paketversion erhöhen, oder `<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` setzen und die Multi-Target-Ausgabe ausliefern. Der Host auf dem neuen Server wählt `net10.0`, der Legacy-Host auf dem alten Server wählt `net6.0`, und beide funktionieren weiter, bis Sie die 6.x-Maschinen vollständig ausmustern.

## Lösung zwei, geringer Aufwand: Roll Forward auf eine neuere Laufzeit

Wenn ein Retargeting blockiert ist (Vendor-Binary, die Sie nicht neu kompilieren können, langsamer Release-Zyklus, juristische Prüfung jedes Assemblies), zwingen Sie die .NET-6-Binärdatei, auf einer neueren Laufzeit zu starten, indem Sie ihre `rollForward`-Richtlinie ändern. Dafür gibt es zwei Stellen.

Im Projekt vor dem Publizieren:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

Oder am bereits publizierten Artefakt, indem Sie die `MyApp.runtimeconfig.json` neben der Binärdatei bearbeiten:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

Oder ohne die Datei anzufassen, indem Sie für einen einzelnen Start eine Umgebungsvariable setzen:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` akzeptiert jede neuere Major-Version. `LatestMajor` tut dasselbe, wählt aber immer den höchsten installierten Major, was Produktionsflotten, die mehrere Laufzeit-Majors umspannen, üblicherweise wollen. Starten Sie den Prozess neu, und der Startfehler ist weg.

Roll Forward ist die Lösung, die später eine `MissingMethodException` produziert. Wenn ein Paket in Ihrem Abhängigkeitsgraphen gegen die .NET-6-Reference-Assemblies kompiliert wurde und eine Methode aufruft, die in .NET 8 oder .NET 10 entfernt oder umbenannt wurde, entdeckt der JIT das beim ersten Durchlaufen dieses Codepfads. Außer das problematische Paket zu aktualisieren oder zu Lösung eins zurückzukehren, gibt es dafür keinen Workaround.

## Lösung drei, letzter Ausweg: die .NET-6-Laufzeit installieren

Wenn die Maschine eine nicht unterstützte Laufzeit behalten muss, installieren Sie sie explizit. Microsoft hostet die .NET-6-Laufzeit-Downloads, als End-of-Life markiert, weiterhin unter derselben URL, auf die der Startfehler verwiesen hat.

Unter Debian und Ubuntu heißt das Paket `dotnet-runtime-6.0`:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

Unter Windows installieren Sie über `winget install Microsoft.DotNet.Runtime.6` oder das eigenständige MSI. In einem Docker-Image ändern Sie `FROM mcr.microsoft.com/dotnet/aspnet:8.0` zurück auf `FROM mcr.microsoft.com/dotnet/aspnet:6.0` oder verwenden das Multi-Version-Image unter `mcr.microsoft.com/dotnet/runtime-deps:6.0` mit einem expliziten `dotnet-runtime-6.0`-Installationslayer.

Setzen Sie `dotnet-runtime-6.0` auf Hold, damit das nächste unbeaufsichtigte Upgrade es nicht erneut entfernt:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

Das ist eine Vollstreckungspause, keine Lösung. Die Laufzeit erhält keine Sicherheits-Patches mehr, also bleibt jedes CVE in `System.Net.Http` oder `System.Text.Json` 6.x auf dieser Maschine ungepatcht. Behandeln Sie es als Fristverlängerung, während Sie Lösung eins fertigstellen.

## Lösung vier, Isolation: self-contained publizieren

Wenn Sie den Build, aber nicht das Deploy-Ziel kontrollieren, packen Sie die Laufzeit in das Artefakt. Ein self-contained-Publish legt die `Microsoft.NETCore.App`-Dateien neben Ihre DLLs, und der Host fragt das System nie nach einer Laufzeit.

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

Die Ausgabe wächst um etwa 70 MB, und auf der Deploy-Maschine muss nichts installiert werden. Das funktioniert auch für `net6.0`, aber das SDK, das den Build macht, muss das `net6.0`-Ref-Pack noch auflösen können; .NET SDK 10.0.x kann zum Zeitpunkt des Schreibens noch gegen `net6.0` targeten, also läuft der Build auf einem aktuellen SDK problemlos.

Self-contained ist die richtige Antwort für einmalige Werkzeuge, CI-Skripte, Sidecars und überall dort, wo Sie die Host-Umgebung nicht diktieren können. Es ist die falsche Antwort für Flotten, in denen das gemeinsame Patchen der Laufzeit Teil der Sicherheitslage ist, weil jede Anwendung jetzt eine eigene Kopie von `System.Net.Http` besitzt und bei jedem CVE neu gebaut werden muss.

## Diagnose vor der Reparatur

Der Host hat einen Verbose-Modus, der genau ausgibt, wonach er sucht und wo. Setzen Sie `COREHOST_TRACE=1` (und optional `COREHOST_TRACEFILE=/tmp/host.log`) und starten Sie die fehlerhafte Binärdatei erneut:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

Das Log listet jede Framework-Version auf, die der Host berücksichtigt hat, welche `rollForward`-Richtlinie angewendet wurde und welche Pfade durchsucht wurden. Wenn das Log meldet, dass 8.0.15 gefunden, aber abgelehnt wurde, weil `rollForward=LatestPatch` gesetzt war, wissen Sie, dass Sie die Richtlinie umstellen müssen. Wenn das Log meldet, dass unter `/usr/share/dotnet/shared/Microsoft.NETCore.App` nichts gefunden wurde, wissen Sie, dass Sie installieren oder umziehen müssen.

Für die `MissingMethodException`-Form nennt der Stack Trace das Assembly, das gegen die falsche Methode gebunden hat. Öffnen Sie den publizierten Ordner, führen Sie `dotnet --info` gegen den Host aus, um die Laufzeit-Version zu bestätigen, und untersuchen Sie die betroffene DLL mit `ildasm` oder `dotnet-ildasm`, um zu bestätigen, dass sie ein 6.0-Reference-Assembly referenziert. Ersetzen Sie das Paket durch eines, das einen `net8.0`- oder `net10.0`-Build hat, oder verwenden Sie Binding-Redirects via `<AssemblyLoadContext>`, wenn Sie beide behalten müssen.

## Fallstricke und Verwechslungen

Der `framework_version`-Parameter in der URL ist **nicht** die installierte Laufzeit-Version, sondern die Untergrenze, die die Anwendung angefordert hat. Speziell nach "install .NET 6.0.0" zu suchen, ist eine Sackgasse, weil der ausgelieferte Patch etwa 6.0.36 lautet. Installieren Sie das neueste 6.0.x, nicht 6.0.0.

Eine `MissingMethodException` auf `Microsoft.AspNetCore.App` statt `Microsoft.NETCore.App` folgt derselben Logik, zeigt aber auf das gemeinsame Framework von ASP.NET Core. Dieselben Lösungspfade, derselbe `rollForward`-Schalter, anderer Name des Shared Frameworks in der .deps.json.

`dotnet --info` listet SDKs und Laufzeiten. Die Laufzeit, die Ihre Anwendung verwendet, ist die unter "Microsoft.NETCore.App" gelistete. Wenn nur "Microsoft.AspNetCore.App 6.0.x" installiert ist, starten ASP.NET-Core-Anwendungen zwar, Konsolenanwendungen melden aber weiterhin den ursprünglichen Fehler, weil das gemeinsame ASP.NET-Framework von der .NET-Laufzeit abhängt, aber nicht dieselbe Installation ist.

Unter Windows ist der apphost `MyApp.exe`, nicht `dotnet.exe`. Die Fehlermeldung ist identisch, das Troubleshooting ist identisch, und `where dotnet` beantwortet die falsche Frage. Verwenden Sie `MyApp.exe --info`, um zu bestätigen, welcher Host läuft.

Wenn die Binärdatei aus einem Azure App Service oder einem Functions-Host gestartet wird, setzt die Plattform den Laufzeitpfad für Sie. Die Lösung liegt in der "Stack"-Version der App-Service-Konfiguration, nicht in der lokalen Datei. Die zugehörige Variante für App Service wird in [Die angegebene Version von Microsoft.NetCore.App oder Microsoft.AspNetCore.App wurde nicht gefunden](/de/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) behandelt, was dieselbe Wurzelursache vor dem Azure-Portal durchgeht.

## Verwandt

- [Lösung: Could not load file or assembly in einer publizierten App](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), wenn der Host die Laufzeit gefunden hat, aber eine Projekt-DLL im Publish-Ordner fehlt.
- [Azure App Service: Microsoft.NetCore.App nicht gefunden](/de/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) für dieselbe Wurzelursache, wenn die Plattform den Host besitzt.
- [Lösung: Der Befehl 'dotnet' wurde auf CI nicht gefunden](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), wenn die Laufzeit nicht einmal im PATH liegt.
- [Lösung: The type or namespace name could not be found nach einer ProjectReference](/de/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/), wenn Retargeting eine `NU1201`-TargetFramework-Inkonsistenz einführt.
- [Lösung: PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) für die verwandte Klasse von Runtime-Host-Fehlern, die erst nach dem Publish auftauchen.

## Quellen

- [.NET-6-End-of-Support-Ankündigung](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) und der .NET-Release-Zeitplan dafür, was noch gepatcht wird.
- [Roll forward für framework-dependent-Anwendungen](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) für die vollständige `rollForward`-Richtlinientabelle.
- [Self-contained deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/) für den Publish-Ablauf mit `--self-contained`.
- [.NET-Laufzeit-Konfigurationseinstellungen](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) für das vollständige `runtimeconfig.json`-Schema.
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) für den kanonischen Thread zur Framework-Auflösungslogik des Hosts und zum Trace-Flag.
