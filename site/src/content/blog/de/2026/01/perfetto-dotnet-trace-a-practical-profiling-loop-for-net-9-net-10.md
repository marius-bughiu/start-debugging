---
title: "Perfetto + dotnet-trace: ein praktischer Profiling-Loop für .NET 9/.NET 10"
description: "Ein praktischer Profiling-Loop für .NET 9 und .NET 10: Erfassen Sie Traces mit dotnet-trace, visualisieren Sie sie in Perfetto und iterieren Sie über CPU-, GC- und Thread-Pool-Probleme."
pubDate: 2026-01-21
updatedDate: 2026-01-23
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
  - "performance"
lang: "de"
translationOf: "2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10"
translatedBy: "claude"
translationDate: 2026-04-29
---
Der schnellste Weg, bei einem "es ist langsam" in .NET weiterzukommen, ist, mit dem Raten aufzuhören und stattdessen auf eine Zeitleiste zu schauen. Ein Artikel, der diese Woche die Runde macht, zeigt einen sauberen Workflow: Traces mit `dotnet-trace` erfassen und sie dann in Perfetto inspizieren (dasselbe Trace-Viewer-Ökosystem, das viele aus der Android- und Chromium-Welt kennen): [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).

## Warum sich Perfetto als Ergänzung lohnt

Wenn Sie bereits `dotnet-counters` oder einen Profiler verwenden, ist Perfetto kein Ersatz. Es ist eine Ergänzung:

-   Sie erhalten eine visuelle Zeitleiste, die das Nachvollziehen von Concurrency-Problemen (Thread-Pool-Spitzen, Symptome von Lock-Contention, asynchrone Wasserfälle) deutlich vereinfacht.
-   Sie können eine Trace-Datei mit anderen Entwicklern teilen, ohne dass diese Ihre IDE oder Ihren kommerziellen Profiler installieren müssen.

Für .NET 9- und .NET 10-Anwendungen ist das besonders nützlich, wenn Sie validieren möchten, dass eine "kleine" Änderung nicht versehentlich zusätzliche Allokationen, zusätzliche Threads oder einen neuen Synchronisations-Engpass eingeführt hat.

## Der Aufzeichnungsloop (zuerst reproduzieren, dann tracen)

Der Trick besteht darin, Tracing als Loop zu behandeln, nicht als einmaligen Vorgang:

-   Machen Sie die Verlangsamung reproduzierbar (gleicher Endpunkt, gleicher Payload, gleicher Datensatz).
-   Erfassen Sie 10-30 Sekunden um das interessante Zeitfenster.
-   Inspizieren, Hypothese bilden, eine Sache ändern, wiederholen.

Hier die minimale Aufzeichnungssequenz mit dem globalen Tool:

```bash
dotnet tool install --global dotnet-trace

# Find the PID of the target process (pick one)
dotnet-trace ps

# Capture an EventPipe trace (default providers are usually a good starting point)
dotnet-trace collect --process-id 12345 --duration 00:00:15 --output app.nettrace
```

Sie erhalten `app.nettrace`. Folgen Sie von dort den Konvertierungs-/Öffnungsschritten aus dem Originalartikel (der genaue Pfad zum "in Perfetto öffnen" hängt davon ab, welche Perfetto UI Sie verwenden und welchen Konvertierungsschritt Sie wählen).

## Worauf Sie beim Öffnen des Trace achten sollten

Beginnen Sie mit Fragen, die Sie in wenigen Minuten beantworten können:

-   **CPU-Auslastung**: Sind Sie CPU-bound (heiße Methoden) oder warten Sie (Blockieren, Sleep, I/O)?
-   **Thread-Pool-Verhalten**: Sehen Sie Bursts von Worker-Threads, die mit Latenzspitzen korrelieren?
-   **GC-Korrelation**: Decken sich Pausenfenster mit der langsamen Anfrage oder nur mit Hintergrundaktivität?

Sobald Sie ein verdächtiges Fenster gefunden haben, springen Sie zurück in den Code und führen eine gezielte Änderung durch (zum Beispiel: Allokationen reduzieren, sync-over-async vermeiden, einen Lock aus dem Hot Path der Anfrage entfernen oder teure Aufrufe bündeln).

## Ein pragmatisches Muster: in Release tracen, ohne Symbole zu verlieren

Wenn möglich, führen Sie den langsamen Pfad in Release aus (näher an der Produktion), behalten aber genug Informationen, um über Frames nachdenken zu können. In SDK-style-Projekten werden PDBs standardmäßig erzeugt; für eine Profiling-Sitzung möchten Sie üblicherweise vorhersehbare Ausgabepfade:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Configuration>Release</Configuration>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
```

Halten Sie es langweilig: stabile Eingabe, stabile Konfiguration, kurze Traces, wiederholen.

Wenn Sie die detaillierten Perfetto-Schritte und Screenshots brauchen, ist der Originalartikel die beste Referenz, die Sie während des Loops geöffnet halten sollten: [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/).
