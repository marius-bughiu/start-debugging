---
title: "Wie man eine dateibasierte C#-App mit `dotnet run app.cs` in .NET 11 ausführt"
description: "Ein vollständiger Leitfaden zu dateibasierten C#-Apps: eine einzelne .cs-Datei mit dotnet run ausführen, die Direktiven #:package, #:sdk, #:property, #:project und #:include, Multi-Datei-Skripte mit #:ref, Argumente und stdin, der Build-Cache, Native-AOT-Veröffentlichung, das Packen als dotnet-Tool und dotnet project convert, wenn das Skript herauswächst."
pubDate: 2026-08-09
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-10"
  - "dotnet-cli"
  - "file-based-apps"
lang: "de"
translationOf: "2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-08-09
---

Um eine C#-Datei ohne Projekt auszuführen, speichern Sie sie als `app.cs` und führen `dotnet run app.cs` aus. Das ist alles. Das SDK synthetisiert ein Projekt im Speicher, stellt Pakete wieder her, kompiliert in ein Cache-Verzeichnis unterhalb Ihres Temp-Ordners und führt das Ergebnis aus. Sie brauchen keine `.csproj`, keine `Program`-Klasse und keine `Main`-Methode. Konfiguration, die normalerweise in der Projektdatei stünde, wandert in `#:`-Direktiven am Anfang der Quelldatei: `#:package Humanizer@2.14.1` fügt eine NuGet-Referenz hinzu, `#:sdk Microsoft.NET.Sdk.Web` macht aus dem Skript eine Web-App, und `#:property PublishAot=false` setzt eine beliebige MSBuild-Eigenschaft. Dateibasierte Apps kamen mit dem .NET 10 SDK und erhielten in .NET 11 Unterstützung für mehrere Dateien. Dieser Artikel behandelt die gesamte Oberfläche, einschließlich der überraschenden Teile: wohin der Build tatsächlich schreibt, warum eine `.csproj` im Arbeitsverzeichnis den Befehl still umleitet und welche Direktiven welche SDK-Version voraussetzen.

Alles unten als "verifiziert" Gekennzeichnete wurde auf SDK 10.0.201 (Laufzeit .NET 10.0.5) unter Windows ausgeführt. .NET 11 befindet sich zum Zeitpunkt des Schreibens in Preview 6, GA wird für November 2026 erwartet, und die .NET-11-Funktionen sind nach Version gekennzeichnet, wo sie abweichen.

## Schritte zum Ausführen einer dateibasierten C#-App

1. Speichern Sie Ihren Code in einer Datei mit der Endung `.cs` und verwenden Sie Top-Level-Anweisungen. Kein `class`, kein `Main`.
2. Setzen Sie alle `#:`-Direktiven an den Anfang der Datei: `#:package` für NuGet-Referenzen, `#:sdk` zum Wechseln des SDK, `#:property` für MSBuild-Eigenschaften.
3. Führen Sie `dotnet run app.cs` aus einem Verzeichnis aus, das keine Projektdatei enthält.
4. Übergeben Sie Argumente an Ihre App nach einem `--`-Trenner: `dotnet run app.cs -- arg1 arg2`.
5. Wenn das Skript über eine einzelne Datei hinauswächst, erzeugt `dotnet project convert app.cs` eine äquivalente `.csproj`.

Der Rest dieses Artikels vertieft jeden Schritt und behandelt das Verhalten, das man erst im Anwendungsfall entdeckt.

## Das Kleinste, was läuft

Top-Level-Anweisungen sind der Einstiegspunkt. `args` ist ohne Umstände im Gültigkeitsbereich:

```csharp
// app.cs -- verified on SDK 10.0.201
Console.WriteLine($"args: {string.Join(",", args)}");
Console.WriteLine($"tfm: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"asm: {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name}");
```

```bash
dotnet run app.cs -- one two
```

```
args: one,two
tfm: .NET 10.0.5
asm: app
```

Beachten Sie den Assembly-Namen: `app`, abgeleitet vom Dateinamen. Das ist später relevant, denn das Verzeichnis des Build-Cache, die User-Secrets-ID und der Name des gepackten Tools leiten sich alle davon ab.

Es gibt drei gleichwertige Aufrufformen. `dotnet run app.cs` ist die übliche. `dotnet run --file app.cs` ist die explizite Form, die man in Skripten verwenden sollte, weil sie eindeutig ist. Und `dotnet app.cs` ist die Kurzform. Alle drei erzeugten im Test identische Ausgaben.

Sie können die Datei auch ganz weglassen und den Quellcode über die Standardeingabe hineinleiten, indem Sie `-` als Argument verwenden:

```bash
echo 'Console.WriteLine("hello from stdin!");' | dotnet run -
```

Das gibt `hello from stdin!` aus. Mit `-` durchsucht das SDK das Arbeitsverzeichnis nicht nach Startprofilen oder anderen Dateien, wobei das aktuelle Verzeichnis weiterhin das Arbeitsverzeichnis für den Build bleibt. Es ist ein wirklich nützlicher Notausgang für Shell-Skripte, die C# erzeugen.

## Was das SDK tatsächlich generiert

Am klarsten versteht man eine dateibasierte App, wenn man sich das Projekt ansieht, das das SDK für Sie kompiliert. `dotnet project convert` schreibt es auf die Festplatte. Für eine Datei, die nichts weiter als `Console.WriteLine("plain");` enthält, sieht das generierte Projekt so aus:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <PublishAot>true</PublishAot>
    <PackAsTool>true</PackAsTool>
    <UserSecretsId>plain-c7cf82264bd176cef60e04b947ef58d1b133625432bf800179babd82aa79722e</UserSecretsId>
  </PropertyGroup>

</Project>
```

Vier dieser Standardwerte sollte man verinnerlichen. `ImplicitUsings` und `Nullable` sind beide aktiviert, deshalb wird `Console` ohne ein `using System;` aufgelöst, und deshalb mahnt der Compiler auch in einem Wegwerf-Skript die Nullbarkeit an. `PublishAot` ist standardmäßig **true**, sodass `dotnet publish app.cs` eine native ausführbare Datei erzeugt, sofern Sie nicht ausdrücklich abwählen. Und `PackAsTool` ist standardmäßig true, sodass `dotnet pack app.cs` ohne weitere Konfiguration ein Paket liefert, das sich per `dotnet tool install` installieren lässt. Die `UserSecretsId` ist ein stabiler Hash des vollständigen Dateipfads, was bedeutet, dass User Secrets sofort funktionieren, aber nicht mehr aufgelöst werden, sobald Sie die Datei verschieben.

`TargetFramework` folgt dem installierten SDK. Auf dem SDK 10.0.201 ist es `net10.0`, auf einem .NET 11 SDK `net11.0`. Setzen Sie es mit `#:property TargetFramework=net10.0` explizit, wenn es darauf ankommt.

## Die fünf Direktiven

Direktiven stehen am Anfang der Datei, mit dem Präfix `#:`. Der dokumentierte Satz umfasst `#:include`, `#:package`, `#:project`, `#:property` und `#:sdk`.

`#:package` fügt eine NuGet-Referenz hinzu. Die Version folgt nach einem `@`:

```csharp
// pkg.cs -- verified on SDK 10.0.201
#:package Humanizer@2.14.1

using Humanizer;
Console.WriteLine(TimeSpan.FromMinutes(90).Humanize(2));
```

Das gibt `1 hour, 30 minutes` aus. Mit `@*` bleiben Sie auf der jeweils neuesten Version. Die Version ganz wegzulassen funktioniert nur, wenn eine `Directory.Packages.props`-Datei Sie unter zentrale Paketverwaltung stellt, andernfalls fixieren Sie sie oder verwenden `@*`.

`#:sdk` tauscht das MSBuild-SDK aus, und so wird aus einer einzigen Datei eine Web-App:

```csharp
// web.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

var app = WebApplication.Create();
app.MapGet("/", () => "ok");
app.Run();
```

`#:sdk` akzeptiert auch eine Version, etwa `#:sdk Aspire.AppHost.Sdk@13.0.2`. Der Wechsel zu `Microsoft.NET.Sdk.Web` ändert außerdem die Standard-Item-Globs: `*.json`-Konfigurationsdateien im Verzeichnis werden automatisch übernommen.

`#:property` setzt eine beliebige MSBuild-Eigenschaft und ist nicht auf Literale beschränkt. MSBuild-Eigenschaftsfunktionen funktionieren, sodass Sie Umgebungsvariablen mit einem Rückfallwert lesen können:

```csharp
#:property LogLevel=$([MSBuild]::ValueOrDefault('$(LOG_LEVEL)', 'Information'))
```

`#:project` referenziert eine echte Projektdatei oder ein Verzeichnis, das eine enthält, und ist die Brücke zurück zu einer normalen Solution:

```csharp
#:project ../SharedLibrary/SharedLibrary.csproj
```

## Multi-Datei-Skripte und die SDK-Version, die sie voraussetzen

`#:include` zieht weitere Dateien in dieselbe Kompilierung. Die Zuordnung erfolgt nach Endung: `*.cs` wird zu `Compile`, `*.resx` zu `EmbeddedResource`, `*.json` zu `None` und `*.razor` zu `Content`. Literale Pfade, Glob-Muster und MSBuild-Eigenschaften funktionieren alle:

```csharp
#:include helpers.cs
#:include models/customer.cs
#:include shared/**/*.cs
```

Die entscheidende Einschränkung: eingebundene `.cs`-Dateien dürfen Typen, Methoden und Namespaces beisteuern, aber **keine** Top-Level-Anweisungen enthalten. Nur die Einstiegsdatei hat diese.

`#:include` setzt das .NET SDK 10.0.300 oder .NET 11 Preview 3 und neuer voraus. Auf einem älteren SDK erhalten Sie eine schlichte Ablehnung statt einer hilfreichen Versionsmeldung. Auf 10.0.201 lautet der genaue Fehler:

```
inc.cs(1): error: Unrecognized directive 'include'.
```

Wenn Sie das sehen, prüfen Sie `dotnet --version`, bevor Sie nach einem Tippfehler suchen. Es ist dieselbe Lücke, die [`#:include` in .NET 10 zu einem bemerkenswerten Meilenstein machte](/de/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/), als es erschien.

.NET 11 Preview 5 ergänzte einen zweiten, andersartigen Weg über mehrere Dateien: [die `#:ref`-Direktive](/de/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/), die eine andere dateibasierte App als *Bibliothek* referenziert, statt sie in eine einzige Kompilierung zu verschmelzen, mit Unterstützung für transitive Referenzen ([dotnet/sdk#53480](https://github.com/dotnet/sdk/pull/53480)). Dieselbe Preview entfernte die Feature Flags von `#:include` und `#:exclude` ([dotnet/sdk#53775](https://github.com/dotnet/sdk/pull/53775)) und sorgte dafür, dass Direktiven in eingebundenen Dateien transitiv verarbeitet werden ([dotnet/sdk#54012](https://github.com/dotnet/sdk/pull/54012)). Preview 6 erweiterte `#:include` auf kompilierte Assemblys, sodass `#:include ./libs/MyLibrary.dll` nun ohne Flag funktioniert.

Zwei Verhaltensdetails aus diesen Preview-Notizen übersieht man leicht. Doppelte `#:project`- und `#:ref`-Einträge sind zulässig, passend zur Item-Semantik von MSBuild. Doppelte Direktiven anderer Art über eingebundene Dateien hinweg erzeugen eine Diagnose, statt still akzeptiert zu werden, wobei Preview 6 dies für `#:sdk`, `#:property` und `#:package` gelockert hat, wenn die doppelten Werte übereinstimmen. Beachten Sie, dass `#:ref` und `#:exclude` in den SDK-Release-Notizen dokumentiert sind, aber noch nicht im [MS-Learn-Artikel zu dateibasierten Apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps) auftauchen. Für diese beiden gelten daher die Release-Notizen als maßgeblich.

## Argumente, Umgebungsvariablen und wohin die Ausgabe geht

Argumente nach `--` werden an Ihre App weitergereicht, statt von der CLI verbraucht zu werden. Umgebungsvariablen lassen sich inline mit `-e` setzen:

```bash
dotnet run -e FOO=bar env.cs
```

Das gibt `FOO=bar` aus `Environment.GetEnvironmentVariable("FOO")` aus. Die .NET-11-Release-Notizen führen `dotnet run -e` als neue SDK-Option, sie funktionierte aber bereits auf dem hier getesteten SDK 10.0.201.

Die Build-Ausgabe landet nicht neben Ihrer Datei. Sie geht in ein inhaltsadressiertes Verzeichnis unterhalb des System-Temp-Ordners, in der Form `<temp>/dotnet/runfile/<appname>-<sha>/bin/<configuration>/`. Der verifizierte Pfad unter Windows:

```
C:\Users\...\AppData\Local\Temp\dotnet\runfile\app-82b0b938fb24db69...\bin\debug\app.dll
```

Leiten Sie ihn mit `--output` bei `dotnet build` um, oder setzen Sie einen Standard in der Datei selbst mit `#:property OutputPath=./output`.

## Der Build-Cache ist die ganze Performance-Geschichte

Das SDK cacht die Build-Ausgabe anhand von Quelldateiinhalt, Direktivenkonfiguration, SDK-Version sowie Existenz und Inhalt der impliziten Build-Dateien. Der Unterschied ist groß genug, um das Gefühl beim Arbeiten mit dem Werkzeug zu verändern. Gemessen auf SDK 10.0.201, gleiche Maschine, gleiches triviales Skript:

| Aufruf | Laufzeit |
| --- | --- |
| Erster Lauf nach `dotnet clean app.cs` | 1,174 s |
| Gecachter Lauf | 0,252 s |

Eine Viertelsekunde liegt in dem Bereich, in dem eine `.cs`-Datei ein brauchbarer Ersatz für ein Shell-Skript ist. Ein kalter Build liegt das nicht.

Drei Cache-Verhalten stiften Verwirrung. Änderungen an impliziten Build-Dateien wie `Directory.Build.props` lösen nicht immer einen Rebuild aus. Das Verschieben einer Datei in ein anderes Verzeichnis invalidiert den Cache nicht. Und ein Glob-Muster in `#:include` deaktiviert derzeit das Build-Caching vollständig, sodass eine Zeile `shared/**/*.cs` Sie still den schnellen Pfad kostet.

Zum Leeren:

```bash
dotnet clean file-based-apps
```

Das durchsucht `<temp>/dotnet/runfile` und entfernt Artefaktordner, die mindestens 30 Tage ungenutzt waren; mit `--days` ändern Sie die Schwelle. Für eine einzelne App erzwingt `dotnet clean app.cs` gefolgt von `dotnet build app.cs` einen sauberen Rebuild.

Ein Hinweis zur Nebenläufigkeit: Mehrere Instanzen derselben dateibasierten App parallel auszuführen kann durch Konkurrenz um die Build-Ausgabedateien fehlschlagen. Kompilieren Sie zuerst einmal und führen Sie dann mit `--no-build` aus:

```bash
dotnet build app.cs
dotnet run app.cs --no-build
```

## Veröffentlichen, Packen und Ausführung über die Shell

`dotnet publish app.cs` erzeugt eine eigenständige ausführbare Datei in einem `artifacts`-Verzeichnis neben der `.cs`-Datei. Da `PublishAot` standardmäßig true ist, handelt es sich um ein Native-AOT-Binary mit schnellem Start und ohne Laufzeitabhängigkeit, also genau das, was man für ein verteiltes CLI-Tool will, und genau das, was man nicht will, wenn das Skript reflexionslastige Bibliotheken verwendet. Mit `#:property PublishAot=false` wählen Sie ab. Falls unklar ist, auf welcher Seite dieser Linie Ihr Code liegt: die Abwägungen sind dieselben wie in [was Native AOT wirklich kostet](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/), und auch der Unterschied zwischen Kompilieren und Veröffentlichen verdient Präzision, wie in [`dotnet build` gegenüber `dotnet publish`](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) beschrieben.

`dotnet pack app.cs` erzeugt ein NuGet-Paket, und da `PackAsTool` standardmäßig true ist, lässt sich dieses Paket als globales Tool installieren. Von einer einzelnen `.cs`-Datei zu einem auslieferbaren `dotnet tool` ohne Projektdatei ist ein wirklich kurzer Weg.

Auf unixartigen Systemen können Sie die Datei mit einem Shebang direkt ausführbar machen:

```csharp
#!/usr/bin/env -S dotnet --
#:package Spectre.Console@*

using Spectre.Console;

AnsiConsole.MarkupLine("[green]Hello, World![/]");
```

```bash
chmod +x file.cs
./file.cs
```

Das Flag `-S` lässt `env` den Rest der Zeile in einzelne Argumente aufteilen, und das abschließende `--` hindert `dotnet` daran, Argumente zu schlucken, die wie seine eigenen aussehen (etwa `--help`). Verwenden Sie LF-Zeilenenden und keine BOM, sonst wird der Shebang nicht erkannt. Unterstützt Ihr `env` kein `-S`, weichen Sie auf `#!/usr/bin/env dotnet` aus und nehmen das Risiko der Argumentkollision in Kauf.

## Der Fallstrick, der die meiste Zeit kostet

Existiert eine Projektdatei im aktuellen Arbeitsverzeichnis, führt `dotnet run app.cs` *dieses Projekt* aus und übergibt `app.cs` als Kommandozeilenargument an es. Das ist bewusste Abwärtskompatibilität, und sie ist still.

Verifiziert: Aus einem Verzeichnis mit `pkg.csproj` heraus führte `dotnet run ../env.cs` das `pkg.csproj` aus und gab dessen Ausgabe aus, nicht die von `env.cs`. Nichts warnt Sie. Verwenden Sie `dotnet run --file ../env.cs`, wenn Sie Gewissheit brauchen, und halten Sie dateibasierte Apps außerhalb des Verzeichniskegels eines jeden Projekts:

```
MyProject/
  MyProject.csproj
  Program.cs
scripts/
  utility.cs
```

Die verwandte Falle sind implizite Build-Dateien. Dateibasierte Apps berücksichtigen `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config` und `global.json` aus dem aktuellen und den übergeordneten Verzeichnissen. Eine `Directory.Build.props` im Repository-Wurzelverzeichnis, die `TreatWarningsAsErrors` setzt, gilt auch für Ihr Wegwerf-Skript. Geben Sie Skripten ein eigenes Verzeichnis mit eigener `Directory.Build.props`, wenn Sie Isolation brauchen.

Zwei kleinere Punkte. Startprofile liegen in einer flachen Datei `app.run.json` neben `app.cs` statt in `Properties/launchSettings.json`; existieren beide, gewinnt der traditionelle Ort und die CLI protokolliert eine Warnung. Und `dotnet user-secrets` benötigt die Option `--file`, um ein Skript anzusprechen: `dotnet user-secrets set "ApiKey" "value" --file app.cs`.

## Wenn das Skript aufhört, ein Skript zu sein

`dotnet project convert app.cs` ist der Weg zum Abschluss. Der Befehl kopiert die `.cs`-Datei und schreibt eine `.csproj` mit äquivalentem SDK, Eigenschaften und Paketreferenzen, abgeleitet aus Ihren `#:`-Direktiven, beides in einem neuen Verzeichnis mit dem Namen der App. Die Originaldatei bleibt unangetastet, die Konvertierung ist also nicht destruktiv und Sie können das Ergebnis per Diff prüfen, bevor Sie sich darauf festlegen.

Angewendet auf das Humanizer-Beispiel von oben ergab sich genau die erwartete Übersetzung: `#:package Humanizer@2.14.1` wurde zu einer `PackageReference` und `#:property PublishAot=false` zu einer Eigenschaft:

```xml
  <ItemGroup>
    <PackageReference Include="Humanizer" Version="2.14.1" />
  </ItemGroup>
```

Dieser Übergang ist das eigentliche Design der Funktion. Beginnen Sie mit einer Datei. Lagern Sie Helfer mit `#:include` aus. Befördern Sie einen Helfer mit `#:ref` zur Bibliothek. Zeigen Sie mit `#:project` auf ein echtes Projekt. Konvertieren Sie, wenn sich die MSBuild-Zeremonie endlich lohnt. Jeder Schritt ist eine Zeile, und keiner zwingt Sie, `dotnet run` aufzugeben. Für die Inner-Loop-Geschichte, sobald Sie ein Projekt haben, ist die Unterscheidung zwischen [`dotnet watch` und `dotnet run`](/de/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) das Nächste, was sich zu wissen lohnt.

## Verwandte Beiträge

- [.NET 11 Preview 5 erlaubt dateibasierten Apps, sich mit `#:ref` gegenseitig zu referenzieren](/de/2026/06/dotnet-11-preview-5-file-based-apps-ref-directive/)
- [Dateibasierte Apps in .NET 10 bekommen Multi-Datei-Skripte: `#:include` kommt](/de/2026/01/net-10-file-based-apps-just-got-multi-file-scripts-include-is-landing/)
- [Was ist der Unterschied zwischen `dotnet build` und `dotnet publish`?](/de/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Was ist der Unterschied zwischen `dotnet watch` und `dotnet run`?](/de/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/)

## Quellen

- [File-based apps](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps) auf MS Learn, die konzeptionelle Referenz für Direktiven, CLI-Befehle, Caching und Ordnerstruktur.
- [What's new in .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), wo die DLL-Unterstützung von `#:include` und `dotnet run -e` aufgeführt sind.
- [.NET 11 Preview 5 SDK-Release-Notizen](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/sdk.md) zu `#:ref`, dem Entfernen der Feature Flags und den Diagnosen für doppelte Direktiven.
- [.NET 11 Preview 6 SDK-Release-Notizen](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/sdk.md) zu `#:include` für kompilierte Assemblys.
- [Announcing dotnet run app.cs](https://devblogs.microsoft.com/dotnet/announcing-dotnet-run-app/) im .NET-Blog, die ursprüngliche Design-Begründung.
