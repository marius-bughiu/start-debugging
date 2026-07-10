---
title: "Was ist der Unterschied zwischen dotnet build und dotnet publish?"
description: "dotnet build kompiliert Ihr Projekt für die innere Entwicklungsschleife und verwendet standardmäßig Debug. dotnet publish führt das MSBuild-Target Publish aus, verwendet ab net8.0 standardmäßig Release und packt einen bereitstellbaren Ordner mit bereits erledigten Web-Assets, eigenständigen Laufzeiten, Single-File, Trimming und AOT. Hier steht genau, was jeder Befehl erzeugt und wann Sie ihn verwenden."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "dotnet-cli"
  - "msbuild"
  - "deployment"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish"
translatedBy: "claude"
translationDate: 2026-07-10
---

`dotnet build` kompiliert Ihr Projekt und seine Abhängigkeiten in IL-Assemblys für die innere Entwicklungsschleife und verwendet standardmäßig die Konfiguration `Debug`. `dotnet publish` führt ein anderes MSBuild-Target aus, das einen eigenständigen Ordner erzeugt, der bereit ist, auf einen Server kopiert zu werden. Es verwendet standardmäßig die Konfiguration `Release` für jedes Projekt mit einem Target ab `net8.0` und ist der einzige offiziell unterstützte Weg, eine Anwendung für die Bereitstellung vorzubereiten. Die Kurzfassung: `build` führen Sie aus, während Sie Code schreiben, `publish` führen Sie aus, wenn Sie fertig sind und etwas Auslieferbares wollen. Die Unterschiede, die wirklich beißen, sind die geänderte Standardkonfiguration und alles, was das Target `Publish` tut und `Build` nicht: Web-Assets verarbeiten, die Laufzeit für eigenständige Bereitstellungen packen sowie Single-File, Trimming und AOT anwenden.

Alles Folgende verwendet das .NET 11 SDK (`11.0.100`) mit `<TargetFramework>net11.0</TargetFramework>` und C# 14. Das beschriebene Verhalten gilt ab dem .NET 8 SDK, sofern keine bestimmte Version genannt wird, denn der folgenreichste Unterschied, die Standardkonfiguration, änderte sich in .NET 8.

## Zwei verschiedene MSBuild-Targets, nicht zwei Varianten derselben Sache

Beide Befehle sind dünne Hüllen über MSBuild, aber sie rufen verschiedene Targets auf, und diese eine Tatsache erklärt fast jeden Unterschied, den Sie bemerken werden.

`dotnet build` führt das Standard-Target `Build` aus. Laut der [dotnet-build-Referenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) entspricht seine Ausführung `dotnet msbuild -restore` mit einer anderen Standardausführlichkeit. Es kompiliert Ihren Code samt seinen Abhängigkeiten in einen Satz von Binärdateien und hört dort auf.

`dotnet publish` führt das Target `Publish` aus. Die [dotnet-publish-Referenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) sagt ausdrücklich, dass es "die Anwendung kompiliert, ihre im Projektfile angegebenen Abhängigkeiten durchliest und den resultierenden Satz von Dateien in ein Verzeichnis veröffentlicht" und dass seine Ausgabe "für die Bereitstellung auf einem Hostingsystem bereit" ist. Das Target `Publish` hängt von `Build` ab, sodass ein Publish immer zuerst baut und dann darauf mehr Arbeit verrichtet.

Diese "mehr Arbeit darauf" ist die ganze Geschichte. Wenn Sie verstehen, was das Target `Publish` hinzufügt, verstehen Sie, wann die Ausgabe von `build` ausreicht und wann sie in der Produktion stillschweigend versagt.

## Die Standardkonfiguration ist die Falle, in die die meisten zuerst treten

Das ist der Unterschied, der die Leute einen Nachmittag kostet, also kommt er zuerst.

`dotnet build` verwendet standardmäßig `Debug`. `dotnet publish` verwendet standardmäßig `Release`, aber nur für Projekte mit einem Target ab `net8.0`. Beide Standardwerte lassen sich mit `-c|--configuration` überschreiben.

```bash
# .NET 11 SDK 11.0.100, project targeting net11.0.
dotnet build      # builds Debug   -> bin/Debug/net11.0/
dotnet publish    # publishes Release -> bin/Release/net11.0/publish/
```

Vor .NET 8 verwendete `dotnet publish` ebenfalls standardmäßig `Debug`, und viel Muskelgedächtnis und viele CI-Skripte gehen noch immer davon aus. Microsoft änderte dies bewusst, damit der Befehl, dessen Aufgabe die Erzeugung von Bereitstellungsartefakten ist, standardmäßig optimierte erzeugt. Die Änderung ist unter ['dotnet publish' verwendet die Release-Konfiguration](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) dokumentiert.

Die praktische Folge: Wenn Sie `dotnet build` ausführen und dann `bin/Debug/...` auf einen Server kopieren, liefern Sie eine nicht optimierte Binärdatei aus, mit deaktivierten JIT-Optimierungen und aktivierten Debugging-Hilfen. Wenn Ihre CI-Pipeline noch immer `-c Release` an `dotnet publish` übergibt, "um sicherzugehen", ist das jetzt redundant, aber harmlos. Wenn sie aus Gewohnheit `-c Debug` übergibt, überschreiben Sie den sinnvollen Standardwert und liefern Debug aus. Lesen Sie Ihre Pipeline einmal und entfernen Sie den Cargo-Kult.

## Was jeder Befehl tatsächlich auf die Festplatte schreibt

Die Ausgabemengen überschneiden sich, weshalb die Befehle auf den ersten Blick austauschbar wirken, aber es ist nicht derselbe Ordner.

`dotnet build` schreibt nach `bin/<configuration>/<framework>/`, zum Beispiel `bin/Debug/net11.0/`. Es gibt Ihre IL-`.dll` aus, eine ausführbare Datei zum Starten bei `Exe`-Projekten, `.pdb`-Symboldateien, eine `.deps.json`, die die Abhängigkeiten auflistet, eine `.runtimeconfig.json`, die die gemeinsame Laufzeit benennt, sowie Kopien der DLLs Ihrer Abhängigkeiten. Für ausführbare Projekte mit einem Target ab .NET Core 3.0 hält die Dokumentation fest, dass "wenn es keine andere veröffentlichungsspezifische Logik gibt (wie sie Web-Projekte haben), die Build-Ausgabe bereitstellbar sein sollte".

`dotnet publish` schreibt in einen Unterordner `publish`: `bin/<configuration>/<framework>/publish/` für einen frameworkabhängigen Build oder `bin/<configuration>/<framework>/<runtime>/publish/`, wenn Sie eigenständig für eine bestimmte Laufzeit bauen. Es gibt dieselben Kerndateien aus (IL-`.dll`, `.deps.json`, `.runtimeconfig.json`, Abhängigkeiten) plus alles, was die Bereitstellungsform erfordert.

Beachten Sie, dass die `publish`-Ausgabe genau deshalb in ein verschachteltes `publish`-Verzeichnis geht, damit sie nicht mit der schlichten Build-Ausgabe kollidiert. Wenn Sie `-o` in einem Web-Projekt auf einen Ordner direkt unterhalb Ihres Projekts richten, können aufeinanderfolgende Veröffentlichungen in `publish/publish` verschachteln, eine bekannte scharfe Kante, die in der Dokumentation genannt wird.

## Warum "die Build-Ausgabe ist bereitstellbar" eine halbe Wahrheit ist

Die Dokumentation sagt, die Build-Ausgabe "sollte bereitstellbar sein" für eine schlichte ausführbare Datei, und für eine einfache Konsolenanwendung ist das tatsächlich wahr. Sie können `dotnet build -c Release` ausführen, `bin/Release/net11.0/` zippen, es auf eine Maschine mit der passenden installierten .NET 11 Laufzeit legen und ausführen.

Das Problem ist, dass die Einschränkung "wenn es keine andere veröffentlichungsspezifische Logik gibt" viele reale Anwendungen abdeckt. Das Target `Publish` verrichtet Arbeit, die `Build` nie ausführt:

- **Web-Assets.** ASP.NET Core- und Blazor-Projekte sammeln statische Dateien, kompilieren die Razor-Komponenten, erzeugen das `wwwroot`-Layout und generieren die static-web-assets-Manifeste während des Publish. Ein reines `build` stellt den bereitstellbaren Web-Inhaltsbaum nicht so zusammen, wie der Host ihn erwartet.
- **Eigenständiges Laufzeit-Packaging.** Wenn Sie `--self-contained` übergeben, kopiert das Publish eine vollständige .NET Laufzeit in die Ausgabe, sodass die Zielmaschine nichts vorinstalliert braucht. `build` packt nie eine Laufzeit.
- **Ready-to-run, Single-File, Trimming und AOT.** Das sind alles Transformationen zur Veröffentlichungszeit, unten beschrieben.

Die genaue Regel lautet also: Für eine Bibliothek oder eine triviale Konsolenanwendung sind die Ausgabe von `build` und die von `publish` nahezu derselbe Satz von Dateien. Für eine Web-Anwendung, eine eigenständige Bereitstellung oder alles, was die Transformationen zur Veröffentlichungszeit nutzt, erzeugt nur `publish` etwas Korrektes. Wenn Leute einen [Fehler, dass die Datei oder Assembly in einer veröffentlichten Anwendung nicht geladen werden konnte](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/), melden, ist die Grundursache oft, dass sie einen `build`-Ordner oder eine Teilkopie davon bereitgestellt haben statt einer echten `publish`-Ausgabe.

## Frameworkabhängig vs. eigenständig: eine reine Publish-Entscheidung

`dotnet build` baut gegen das gemeinsame Framework und geht davon aus, dass die Laufzeit zur Laufzeit vorhanden ist. Es hat kein Konzept davon, eine Laufzeit zu packen.

`dotnet publish` lässt Sie das Bereitstellungsmodell wählen. Frameworkabhängig ist der Standard und hält die Ausgabe klein, erfordert aber eine passende .NET Laufzeit auf dem Ziel:

```bash
# .NET 11 SDK 11.0.100. Framework-dependent, cross-platform. Target needs .NET 11 installed.
dotnet publish -c Release
```

Eigenständig packt die Laufzeit, sodass das Ziel nichts vorinstalliert braucht, auf Kosten einer viel größeren Ausgabe und eines Builds pro Laufzeit:

```bash
# .NET 11 SDK 11.0.100. Self-contained: the runtime ships inside the output folder.
dotnet publish -c Release -r linux-x64 --self-contained
```

Das `-r` (Runtime Identifier) macht die Ausgabe plattformspezifisch: Ein `linux-x64`-Publish läuft nicht auf `win-x64`. Deshalb enthält der eigenständige Ausgabepfad das Laufzeit-Segment (`bin/Release/net11.0/linux-x64/publish/`). Wenn Sie an mehrere Plattformen ausliefern, führen Sie ein Publish pro RID aus. Diesen Portabilitäts-Kompromiss wägen Sie ebenso ab, wenn Sie entscheiden, ob Sie zu [Native AOT greifen, und was es Sie kostet](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/).

## Die Transformationen zur Veröffentlichungszeit, die kein Build-Äquivalent haben

Vier MSBuild-Eigenschaften ändern, was `publish` erzeugt, und keine tut während eines reinen `build` etwas Nennenswertes. Sie sind der Grund, warum `publish` als eigener Befehl existiert.

**`PublishReadyToRun`** kompiliert Ihre Assemblys in das ReadyToRun-Format (R2R), eine Form der Ahead-of-Time-Kompilierung, die Ihren Code vor-JIT-kompiliert, um die Startzeit zu kürzen, während der JIT für später verfügbar bleibt. Es ist ein Schritt zur Veröffentlichungszeit; sehen Sie in [Native AOT vs ReadyToRun vs JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), wie es sich gegen die Alternativen schlägt.

**`PublishSingleFile`** packt die Anwendung in eine einzige plattformspezifische ausführbare Datei. Das Setzen aktiviert implizit `PublishSelfContained`.

**`PublishTrimmed`** entfernt Bibliothekscode, von dem der Trimmer nicht beweisen kann, dass er erreichbar ist, und verkleinert so eine eigenständige Bereitstellung. Es gilt nur für eigenständige Veröffentlichungen.

**`PublishAot`** führt den ILC-Compiler aus, um eine einzige native Binärdatei ganz ohne JIT zu erzeugen.

```xml
<!-- .NET 11, C# 14. These belong in the .csproj, not on the build command line. -->
<PropertyGroup>
  <PublishSingleFile>true</PublishSingleFile>
  <PublishTrimmed>true</PublishTrimmed>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. Only 'publish' honors these; 'build' ignores them.
dotnet publish -c Release -r win-x64
```

Führen Sie `dotnet build` in einem Projekt mit diesen gesetzten Eigenschaften aus, und nichts geschieht: Der Trimmer läuft nicht, keine Single-File wird erzeugt, ILC wird nie aufgerufen. Die Transformationen sind in den Abhängigkeitsgraphen des Targets `Publish` verdrahtet, nicht in den von `Build`. Das ist der konkrete, mechanische Grund, warum die Dokumentation `publish` "den einzigen offiziell unterstützten Weg, die Anwendung für die Bereitstellung vorzubereiten" nennt.

## Den Neu-Build mit --no-build überspringen

Da `publish` von `Build` abhängt, kompiliert ein Publish standardmäßig neu. In einer CI-Pipeline, in der Sie bereits `dotnet build` ausgeführt haben (um Analyzer oder Tests gegen genau diese Binärdateien laufen zu lassen), verschwendet ein erneutes Kompilieren beim Publish Zeit und kann, schlimmer noch, subtil andere Ausgaben erzeugen. Übergeben Sie `--no-build`, um die vorhandene Build-Ausgabe wiederzuverwenden:

```bash
# .NET 11 SDK 11.0.100. Build once with the config you want, then publish that.
dotnet build -c Release
dotnet publish -c Release --no-build
```

Zwei Dinge sind zu beachten. Erstens setzt `--no-build` implizit `--no-restore`, also muss der Restore bereits erfolgt sein. Zweitens müssen die Konfigurationen übereinstimmen: Wenn Sie `dotnet build -c Release` ausführen und dann `dotnet publish --no-build` ohne `-c Release`, sucht publish nach der `Debug`-Ausgabe (seinem Standard), findet keinen passenden Build und schlägt fehl. Halten Sie den `-c`-Wert in beiden Befehlen identisch. Wenn Sie das Artifacts-Ausgabelayout (`--artifacts-path`) verwenden, hält die Dokumentation fest, dass Sie denselben Pfad auch an beide Befehle weitergeben müssen.

## dotnet run und dotnet test stehen neben diesen

Es hilft, die beiden Befehle in die breitere CLI einzuordnen. `dotnet run` baut (standardmäßig Debug) und startet die Anwendung sofort; es ist die Komfort-Hülle der inneren Schleife, kein Bereitstellungswerkzeug. `dotnet test` baut und führt Ihr Testprojekt aus. `dotnet pack` erzeugt ein NuGet-Paket statt einer bereitstellbaren Anwendung und verwendet wie publish ab `net8.0` standardmäßig `Release`. Sie alle führen zuerst einen impliziten `dotnet restore` aus, sofern Sie nicht `--no-restore` übergeben. Wenn Ihre CI nicht einmal das SDK findet, um irgendeinen davon auszuführen, ist das ein separates Umgebungsproblem, behandelt in [der Befehl dotnet konnte in der CI nicht gefunden werden](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

## Welchen ausführen, je in einer Zeile entschieden

Verwenden Sie `dotnet build` während der Entwicklung: zum Kompilieren, um Warnungen und Analyzer-Diagnosen ans Licht zu bringen und Binärdateien für Ihre Tests zu erzeugen. Es ist schnell, verwendet standardmäßig Debug, und seine Ausgabe ist für Ihre Maschine gedacht.

Verwenden Sie `dotnet publish`, wenn Sie ein auslieferbares Artefakt wollen: Es verwendet standardmäßig Release, führt die bereitstellungsspezifischen Schritte aus und ist der unterstützte Weg zu einem Ordner, den Sie an einen Server, ein Container-Image oder eine Native-AOT-Binärdatei übergeben können. Wenn Sie in der CI einen Release-Build schneiden, ist publish (optional nach einem einzigen gemeinsamen `build` mit `--no-build`) der Befehl, der das erzeugt, was Sie bereitstellen. Wenn Sie sich gleichzeitig zwischen Haupt-Laufzeitversionen bewegen, kombinieren Sie dies mit der [Migrationscheckliste von .NET 8 zu .NET 11](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), damit die Publish-Ausgabe auf die Laufzeit zielt, auf der Sie tatsächlich laufen wollen.

Der Ein-Satz-Test: Ist die Ausgabe für Sie, `build`; ist die Ausgabe für eine Maschine, die nicht Ihre ist, `publish`.

## Verwandt

- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Fix: Datei oder Assembly konnte in einer veröffentlichten Anwendung nicht geladen werden](/de/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [Fix: Der Befehl 'dotnet' konnte in der CI nicht gefunden werden](/de/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/)
- [Von .NET 8 zu .NET 11 migrieren: die vollständige Checkliste](/de/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Quellen

- [dotnet-publish-Befehlsreferenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish) (Microsoft Learn)
- [dotnet-build-Befehlsreferenz](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build) (Microsoft Learn)
- ['dotnet publish' verwendet standardmäßig die Release-Konfiguration](https://learn.microsoft.com/en-us/dotnet/core/compatibility/sdk/8.0/dotnet-publish-config) (Microsoft Learn)
- [Überblick über die Veröffentlichung von .NET Anwendungen](https://learn.microsoft.com/en-us/dotnet/core/deploying/) (Microsoft Learn)
