---
title: "So profilen Sie eine .NET-App mit dotnet-trace und lesen die Ausgabe"
description: "Vollständiger Leitfaden zum Profilen von .NET 11-Apps mit dotnet-trace: Installation, Wahl des richtigen Profils, Aufzeichnung ab dem Start und Lesen des .nettrace in PerfView, Visual Studio, Speedscope oder Perfetto."
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
lang: "de"
translationOf: "2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output"
translatedBy: "claude"
translationDate: 2026-04-25
---

Um eine .NET-App mit `dotnet-trace` zu profilen, installieren Sie das globale Tool mit `dotnet tool install --global dotnet-trace`, ermitteln Sie die PID des Zielprozesses mit `dotnet-trace ps` und führen Sie dann `dotnet-trace collect --process-id <PID>` aus. Ohne Flags verwenden die .NET 10/11-Versionen des Tools standardmäßig die Profile `dotnet-common` und `dotnet-sampled-thread-time`, die zusammen den gleichen Bereich abdecken wie das frühere Profil `cpu-sampling`. Drücken Sie Enter, um die Aufzeichnung zu stoppen, und `dotnet-trace` schreibt eine `.nettrace`-Datei. Zum Lesen öffnen Sie sie unter Windows in Visual Studio oder PerfView, oder konvertieren Sie sie mit `dotnet-trace convert` in eine Speedscope- oder Chromium-Datei und betrachten sie in [speedscope.app](https://www.speedscope.app/) oder `chrome://tracing` / Perfetto. Dieser Artikel verwendet dotnet-trace 9.0.661903 mit .NET 11 (Preview 3), aber der Workflow ist seit .NET 5 stabil.

## Was dotnet-trace tatsächlich erfasst

`dotnet-trace` ist ein rein managed Profiler, der mit einem .NET-Prozess über den [Diagnostic Port](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port) kommuniziert und die Laufzeit auffordert, Ereignisse über [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe) zu streamen. Es wird kein nativer Profiler angehängt, kein Prozess neu gestartet und es sind keine Administrator-Rechte erforderlich (Ausnahme ist das Verb `collect-linux`, dazu später mehr). Die Ausgabe ist eine `.nettrace`-Datei: ein binärer Stream von Ereignissen plus Rundown-Informationen (Typnamen, JIT-IL-zu-Native-Maps), die am Ende der Sitzung ausgegeben werden.

Dieser rein managed Vertrag ist der ganze Grund, warum Teams `dotnet-trace` gegenüber PerfView, ETW oder `perf record` wählen. Sie erhalten JIT-aufgelöste managed Aufrufstapel, GC-Ereignisse, Allokationsstichproben, ADO.NET-Befehle und `EventSource`-basierte benutzerdefinierte Ereignisse aus einem einzigen Tool, das identisch unter Windows, Linux und macOS läuft. Was Sie aus dem plattformübergreifenden Verb `collect` nicht erhalten, sind native Frames, Kernel-Stacks oder Ereignisse von Nicht-.NET-Prozessen.

## Installieren und ersten Trace aufzeichnen

Einmal pro Maschine installieren:

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

Das Tool nimmt die höchste auf der Maschine installierte .NET-Laufzeit. Wenn nur .NET 6 installiert ist, funktioniert es trotzdem, aber die in 2025 eingeführten Profilnamen für .NET 10/11 sind nicht verfügbar. Führen Sie `dotnet-trace --version` aus, um zu prüfen, welche Version Sie haben.

Ermitteln Sie nun eine PID. Das tool-eigene Verb `ps` ist die sicherste Option, da es nur managed Prozesse ausgibt, die einen Diagnostic-Endpunkt bereitstellen:

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

Erfassen Sie 30 Sekunden gegen die erste PID:

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

Die Konsole gibt aus, welche Provider aktiviert wurden, den Namen der Ausgabedatei (Standard: `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`) und einen Live-KB-Zähler. Drücken Sie Enter früher, wenn Sie vor Ablauf der Dauer stoppen möchten. Das Stoppen ist nicht sofort: Die Laufzeit muss Rundown-Informationen für jede JIT-kompilierte Methode flushen, die im Trace auftauchte, was bei einer großen App zehn Sekunden dauern kann. Widerstehen Sie dem Drang, Ctrl+C zweimal zu drücken.

## Das richtige Profil wählen

Der Grund, warum `dotnet-trace` beim ersten Mal verwirrend wirkt, ist, dass "welche Ereignisse soll ich erfassen?" viele richtige Antworten hat. Das Tool bringt benannte Profile mit, damit Sie keine Keyword-Bitmasken auswendig lernen müssen. Ab dotnet-trace 9.0.661903 unterstützt das Verb `collect`:

- `dotnet-common`: leichtgewichtige Laufzeitdiagnose. Ereignisse für GC, AssemblyLoader, Loader, JIT, Exceptions, Threading, JittedMethodILToNativeMap und Compilation auf der Stufe `Informational`. Entspricht `Microsoft-Windows-DotNETRuntime:0x100003801D:4`.
- `dotnet-sampled-thread-time`: tastet managed Thread-Stacks mit etwa 100 Hz ab, um Hotspots im Zeitverlauf zu identifizieren. Verwendet den Sample-Profiler der Laufzeit mit managed Stacks.
- `gc-verbose`: GC-Sammlungen plus Stichproben von Objektallokationen. Schwerer als `dotnet-common`, aber die einzige Möglichkeit, Allokations-Hotspots ohne Memory-Profiler zu finden.
- `gc-collect`: nur GC-Sammlungen, sehr geringer Overhead. Gut für "pausiert mich der GC?" ohne Auswirkung auf den Steady-State-Durchsatz.
- `database`: ADO.NET- und Entity Framework-Befehlsereignisse. Nützlich, um N+1-Abfragen zu erkennen.

Wenn Sie `dotnet-trace collect` ohne Flags ausführen, wählt das Tool jetzt standardmäßig `dotnet-common` plus `dotnet-sampled-thread-time`. Diese Kombination ersetzt das alte Profil `cpu-sampling`, das alle Threads unabhängig von ihrer CPU-Nutzung abtastete und dazu führte, dass Leute ruhende Threads als heiß fehlinterpretierten. Wenn Sie das exakte alte Verhalten für Rückwärtskompatibilität mit älteren Traces benötigen, verwenden Sie `--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"`.

Sie können Profile mit Kommas stapeln:

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

Für alles Maßgeschneidertere verwenden Sie `--providers`. Das Format ist `Provider[,Provider]`, wobei jeder Provider `Name[:Flags[:Level[:KeyValueArgs]]]` ist. Um zum Beispiel nur Contention-Ereignisse auf Verbose-Stufe zu erfassen:

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

Wenn Sie eine freundlichere Syntax für Laufzeit-Keywords wünschen, ist `--clrevents gc+contention --clreventlevel informational` äquivalent zu `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` und in Skripten viel besser lesbar.

## Vom Start an aufzeichnen

Die Hälfte der interessanten Performance-Probleme passiert in den ersten 200 ms, bevor Sie überhaupt eine PID kopieren können. .NET 5 fügte zwei Möglichkeiten hinzu, `dotnet-trace` anzuhängen, bevor die Laufzeit Anfragen bedient.

Am einfachsten ist es, `dotnet-trace` den Kindprozess starten zu lassen:

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

Standardmäßig werden stdin/stdout des Kindes umgeleitet. Übergeben Sie `--show-child-io`, wenn Sie auf der Konsole mit der App interagieren müssen. Verwenden Sie `dotnet exec <app.dll>` oder ein veröffentlichtes Self-Contained-Binary anstelle von `dotnet run`: Letzteres erzeugt Build-/Launcher-Prozesse, die sich zuerst mit dem Tool verbinden können und Ihre echte App in der Laufzeit suspendiert lassen.

Die flexiblere Option ist der Diagnostic Port. In einer Shell:

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

In einer anderen Shell setzen Sie die Umgebungsvariable und starten normal:

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

Die Laufzeit bleibt suspendiert, bis das Tool bereit ist, dann startet sie wie üblich. Dieses Muster lässt sich mit Containern kombinieren (Socket in den Container mounten), mit Diensten, die sich nicht leicht umschließen lassen, und mit Multi-Prozess-Szenarien, in denen Sie nur ein bestimmtes Kind tracen möchten.

## Bei einem bestimmten Ereignis stoppen

Lange Traces sind verrauscht. Wenn Sie nur den Bereich zwischen "JIT begann mit der Kompilierung von X" und "Anfrage abgeschlossen" interessieren, kann `dotnet-trace` in dem Moment stoppen, in dem ein bestimmtes Ereignis ausgelöst wird:

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

Der Ereignisstrom wird asynchron geparst, sodass nach dem Treffer einige zusätzliche Ereignisse durchsickern, bevor die Sitzung tatsächlich schließt. Das ist normalerweise kein Problem, wenn Sie nach Hotspots suchen.

## Die .nettrace-Ausgabe lesen

Eine `.nettrace`-Datei ist das kanonische Format. Drei Viewer verarbeiten sie direkt, zwei weitere stehen nach einer einzeiligen Konvertierung zur Verfügung.

### PerfView (Windows, kostenlos)

[PerfView](https://github.com/microsoft/perfview) ist das Originalwerkzeug, das das .NET-Laufzeitteam verwendet. Öffnen Sie die `.nettrace`-Datei, doppelklicken Sie auf "CPU Stacks", wenn Sie `dotnet-sampled-thread-time` aufgezeichnet haben, oder auf "GC Heap Net Mem" / "GC Stats", wenn Sie `gc-verbose` oder `gc-collect` erfasst haben. Die Spalte "Exclusive %" zeigt, wo managed Threads ihre Zeit verbracht haben; "Inclusive %" zeigt, welcher Aufrufstapel den heißen Frame erreicht hat.

PerfView ist dicht. Die zwei Klicks, die es sich zu merken lohnt, sind: Rechtsklick auf einen Frame und "Set As Root" wählen, um hineinzuzoomen, und das Textfeld "Fold %" verwenden, um kleine Frames zu reduzieren, damit der heiße Pfad lesbar wird. Wenn der Trace durch eine unbehandelte Exception abgeschnitten wurde, starten Sie PerfView mit dem Flag `/ContinueOnError`, dann können Sie immer noch untersuchen, was bis zum Crash passierte.

### Visual Studio Performance Profiler

Visual Studio 2022/2026 öffnet `.nettrace`-Dateien direkt über File > Open. Die Ansicht CPU Usage ist die freundlichste Oberfläche für jemanden, der noch nie PerfView verwendet hat, mit einem Flame Graph, einem "Hot Path"-Bereich und Quellzeilen-Zuordnung, wenn Ihre PDBs in der Nähe sind. Der Nachteil ist, dass Visual Studio weniger Ansichtstypen als PerfView hat, sodass Allokations-Profiling und GC-Analyse normalerweise in PerfView klarer sind.

### Speedscope (plattformübergreifend, Browser)

Der schnellste Weg, einen Trace unter Linux oder macOS zu betrachten, ist die Konvertierung nach Speedscope und das Öffnen des Ergebnisses im Browser. Sie können `dotnet-trace` bitten, Speedscope direkt zu schreiben:

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

Oder eine vorhandene `.nettrace` konvertieren:

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

Ziehen Sie die resultierende `.speedscope.json` auf [speedscope.app](https://www.speedscope.app/). Die Ansicht "Sandwich" ist das Killer-Feature: Sie sortiert Methoden nach Gesamtzeit und lässt Sie auf eine beliebige klicken, um Aufrufer und Aufgerufene inline zu sehen. Es ist das, was Sie auf einem Mac PerfView am nächsten kommt. Beachten Sie, dass die Konvertierung verlustbehaftet ist: Rundown-Metadaten, GC-Ereignisse und Exception-Ereignisse werden verworfen. Behalten Sie die Original-`.nettrace` daneben, falls Sie später Allokationen ansehen möchten.

### Perfetto / chrome://tracing

`--format Chromium` erzeugt eine JSON-Datei, die Sie in `chrome://tracing` oder [ui.perfetto.dev](https://ui.perfetto.dev/) ablegen können. Diese Ansicht glänzt bei Concurrency-Fragen: Thread-Pool-Spitzen, async Wasserfälle und Symptome von Lock-Contention lesen sich auf einer Timeline natürlicher als in einem Flame Graph. Der Community-Beitrag [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) zeigt einen vollständigen Loop, und wir haben [einen praktischen Perfetto + dotnet-trace-Workflow](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) Anfang dieses Jahres ausführlicher behandelt.

### dotnet-trace report (CLI)

Wenn Sie auf einem Headless-Server sind oder nur einen schnellen Sanity-Check möchten, kann das Tool selbst einen Trace zusammenfassen:

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

Das gibt die Top 20 Methoden nach exklusiver CPU-Zeit aus. Fügen Sie `--inclusive` hinzu, um auf inklusive Zeit zu wechseln, und `-v`, um vollständige Parameter-Signaturen auszugeben. Es ist kein Ersatz für einen Viewer, reicht aber aus, um "hat das Deployment etwas Offensichtliches verschlechtert?" zu beantworten, ohne SSH zu verlassen.

## Stolpersteine, die Erstanwender treffen

Eine Handvoll Sonderfälle erklärt die meisten "Warum ist mein Trace leer?"-Meldungen.

- Der Buffer ist standardmäßig 256 MB groß. Szenarien mit hoher Ereignisrate (jede Methode in einer engen Schleife, Allokations-Sampling auf einer Streaming-Last) lassen diesen Buffer überlaufen und verwerfen Ereignisse stillschweigend. Erhöhen Sie ihn mit `--buffersize 1024` oder schränken Sie die Provider ein.
- Unter Linux und macOS verlangen `--name` und `--process-id`, dass die Ziel-App und `dotnet-trace` dieselbe Umgebungsvariable `TMPDIR` teilen. Stimmen sie nicht überein, läuft die Verbindung ohne nützliche Fehlermeldung in einen Timeout. Container und `sudo`-Aufrufe sind die üblichen Verdächtigen.
- Der Trace ist unvollständig, wenn die Ziel-App während der Aufzeichnung abstürzt. Die Laufzeit kürzt die Datei, um Korruption zu vermeiden. Öffnen Sie sie in PerfView mit `/ContinueOnError` und lesen Sie, was vorhanden ist: Es reicht meist, um die Ursache zu finden.
- `dotnet run` erzeugt Hilfsprozesse, die sich vor Ihrer echten App mit einem `--diagnostic-port`-Listener verbinden. Verwenden Sie `dotnet exec MyApp.dll` oder ein veröffentlichtes Self-Contained-Binary, wenn Sie ab dem Start tracen.
- Der Standard `--resume-runtime true` lässt die App starten, sobald die Sitzung bereit ist. Wenn Sie wollen, dass die App suspendiert bleibt (selten, hauptsächlich für Debugger), übergeben Sie `--resume-runtime:false`.
- Für .NET 10 unter Linux mit Kernel 6.4+ erfasst das neue Verb `collect-linux` Kernel-Ereignisse, native Frames und maschinenweite Stichproben, erfordert aber Root-Rechte und schreibt eine `.nettrace` im Preview-Format, das noch nicht jeder Viewer unterstützt. Verwenden Sie es, wenn Sie wirklich native Frames brauchen; standardmäßig `collect` für alles andere.

## Wohin als Nächstes

`dotnet-trace` ist das richtige Werkzeug für "was tut meine App gerade?". Für kontinuierliche Metriken (RPS, Größe des GC-Heaps, Thread-Pool-Warteschlangenlänge), ohne überhaupt eine Datei zu erzeugen, greifen Sie zu `dotnet-counters`. Für die Jagd nach Memory Leaks, die einen tatsächlichen Heap-Dump brauchen, greifen Sie zu `dotnet-gcdump`. Die drei Tools teilen sich die Diagnostic-Port-Plumbing, sodass das Muskelgedächtnis von install / `ps` / `collect` übertragbar ist.

Wenn Sie Code schreiben, der in der Produktion läuft, möchten Sie auch ein tracing-freundliches mentales Modell der Sprache. Unsere Notizen zu [lang laufenden Tasks ohne Deadlocks abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), [Dateien aus ASP.NET Core-Endpunkten ohne Buffering streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) und [große CSV-Dateien in .NET 11 lesen, ohne Speicher auszuschöpfen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) zeigen Muster, die in einem `dotnet-trace` Flame Graph sehr anders aussehen als die naiven Versionen, und das ist gut so.

Das `.nettrace`-Format ist offen: Wenn Sie die Analyse skripten möchten, liest [Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) dieselben Dateien programmatisch. So funktioniert PerfView selbst unter der Haube, und so bauen Sie einen einmaligen Bericht, wenn keiner der bestehenden Viewer die Frage stellt, die Sie tatsächlich haben.

## Quellen

- [Referenz zum Diagnose-Tool dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn, zuletzt aktualisiert am 2026-03-19)
- [EventPipe-Dokumentation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Diagnostic-Port-Dokumentation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [Bekannte Event-Provider in .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView auf GitHub](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
