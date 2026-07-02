---
title: "Den Binlog MCP Server in CI ausführen, um Build-Fehler automatisch zu diagnostizieren"
description: "Am 2026-06-30 zeigte Microsoft den Binlog MCP Server, der unbeaufsichtigt in einem GitHub Agentic Workflow läuft, sodass ein Agent die .binlog liest und die Ursache kommentiert, sobald ein CI-Build fehlschlägt."
pubDate: 2026-07-02
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
  - "ci"
lang: "de"
translationOf: "2026/07/run-the-binlog-mcp-server-in-ci-to-auto-triage-build-failures"
translatedBy: "claude"
translationDate: 2026-07-02
---

Am 2026-06-30 veröffentlichte das .NET-Team [MCP Beyond the Chat Window: Build Diagnostics in CI](https://devblogs.microsoft.com/dotnet/mcp-build-diagnostics-workflows/), und damit wird der Binlog MCP Server aus Ihrem Editor herausgenommen und in Ihre Pipeline gesetzt. Vor zwei Wochen war dieser Server noch etwas, worauf Sie Claude oder Copilot von Hand aus einer lokalen `.binlog` ausgerichtet haben (diese Einrichtung habe ich in [Der Binlog MCP Server lässt eine KI Ihre MSBuild-Logs lesen](/de/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) behandelt). Die neue Demo führt ihn unbeaufsichtigt in GitHub Actions aus: Der Build schlägt fehl, ein Agent liest das Log, und ein Kommentar mit der Ursache landet im Pull Request, bevor jemand etwas herunterlädt.

## Warum CI der bessere Ort für ein Binlog ist

Die interaktive Variante ist schön, aber der echte Schmerz liegt in CI. Ein Build wird rot, Sie ziehen ein mehrere Megabyte großes Binärlog vom Runner, öffnen den MSBuild Structured Log Viewer und scrollen durch verschachtelte Targets auf der Suche nach dem einen Fehler, der zählt. Den Parser in die Pipeline zu verlagern, beseitigt diesen ganzen Ablauf. Die `.binlog` verlässt nie den Runner, und das Modell übernimmt das Lesen.

Sie erzeugen das Log weiterhin auf dieselbe Weise. Fügen Sie `/bl` zu einem beliebigen MSBuild-gesteuerten Befehl hinzu:

```bash
dotnet build /bl
dotnet test /bl
dotnet pack /bl
```

## Die Anbindung an einen GitHub Agentic Workflow

Der entscheidende Unterschied ist, dass der Server als Container-Image ausgeliefert wird, sodass der Workflow das Log schreibgeschützt einbindet und den Agenten es abfragen lässt. Das Repository `microsoft/testfx` verwendet ungefähr diese Form:

```yaml
mcp-servers:
  binlog-mcp:
    container: "mcr.microsoft.com/dotnet-buildtools/prereqs:azurelinux-3.0-binlog-mcp-amd64"
    mounts:
      - "/tmp/build.binlog:/data/build.binlog:ro"
    allowed: ["*"]
```

Der Job führt den Build mit einem Binärlog aus, und nur wenn der Build fehlschlägt, weckt er den Agenten. Bei Grün läuft nichts, sodass Sie für bestandene Builds keine Token-Kosten zahlen.

## binlog_diagnose übernimmt den ersten Durchgang

Das Werkzeug, das dies praktikabel macht, ist `binlog_diagnose`. Anstatt dass der Agent `binlog_errors`, `binlog_search` und `binlog_target_reasons` selbst aneinanderreiht, liest `binlog_diagnose` das Log, gruppiert die Fehler, identifiziert die wahrscheinliche Ursache und schlägt in einem einzigen Aufruf eine Lösung vor. Der Rest der Sammlung (`binlog_overview`, `binlog_compare`, `binlog_task_details` und eine wachsende Liste weiterer Werkzeuge für Leistung, Abhängigkeitsgraphen und die Introspektion inkrementeller Builds) ist weiterhin verfügbar, wenn der Agent tiefer graben muss.

In Microsofts eigener Auswertung hob die Bereitstellung dieser Werkzeuge die Qualitätsbewertung der Diagnose von 3,25 auf 3,68 gegenüber einer Baseline ohne Werkzeuge, und sie war rund 44% schneller (196s vs 350s Gesamtzeit). Schneller und besser ist eine seltene Kombination, und sie ergibt sich daraus, dass der Agent strukturierte Daten abfragt, statt rohen Log-Text zu durchsuchen.

Wenn Sie einen instabilen CI-Build haben, der immer wieder ein Log erzeugt, das niemand öffnen will, dann ist dies die Variante der Einrichtung, die Ihrem Team wirklich Zeit spart: Die Triage geschieht automatisch, im PR, solange der Fehler noch frisch ist.
