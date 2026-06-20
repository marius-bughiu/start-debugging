---
title: "Der Binlog-MCP-Server lässt eine KI Ihre MSBuild-Logs lesen"
description: "Microsoft hat am 2026-06-17 Microsoft.AITools.BinlogMcp veröffentlicht, einen MCP-Server, der 15 Tools bereitstellt, damit Claude oder Copilot Build-Fehler und langsame Targets direkt aus einer .binlog-Datei diagnostizieren."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "msbuild"
  - "mcp"
  - "ai-agents"
lang: "de"
translationOf: "2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds"
translatedBy: "claude"
translationDate: 2026-06-20
---

Am 2026-06-17 hat Microsoft den [Binlog-MCP-Server](https://devblogs.microsoft.com/dotnet/msbuild-binlog-mcp-server/) veröffentlicht, einen MCP-Server, der die binären Logs von MSBuild analysiert und einem KI-Assistenten 15 spezialisierte Tools zur Untersuchung an die Hand gibt. Die Idee ist einfach: Statt eine mehrere Megabyte große `.binlog` im MSBuild Structured Log Viewer zu öffnen und verschachtelte Targets von Hand zu durchsuchen, fragen Sie "Warum ist mein Build fehlgeschlagen?" und das Modell liest das Log für Sie.

## Warum ein Binlog die richtige Oberfläche ist

Ein binäres Log ist die genaueste Aufzeichnung, die MSBuild erzeugt. Es erfasst jedes Target, jede Task, jede Eigenschaftsauswertung und jedes Item sowie die Quelldateien, die zur Build-Zeit eingebettet wurden. Genau dieser Detailgrad macht es mühsam, es manuell zu lesen, und genau das kann ein Modell gut abfragen. Indem der Parser hinter das Model Context Protocol gestellt wird, funktioniert dasselbe Log in jedem MCP-Client: Claude Code, Copilot in VS Code oder Visual Studio.

Erzeugen Sie eines auf die übliche Weise:

```bash
dotnet build /bl:build-a.binlog
```

## Einbinden in einen MCP-Client

Der Server wird als dotnet-Tool `Microsoft.AITools.BinlogMcp` veröffentlicht. In VS Code richten Sie `mcp.json` über stdio darauf aus:

```json
{
  "servers": {
    "binlog-mcp": {
      "type": "stdio",
      "command": "dotnet",
      "args": ["tool", "run", "Microsoft.AITools.BinlogMcp"]
    }
  }
}
```

Wenn das Modell beim Start ein bestimmtes Log öffnen soll, übergeben Sie es nach dem Trennzeichen `--`:

```json
{
  "args": ["tool", "run", "Microsoft.AITools.BinlogMcp", "--", "--binlog", "msbuild.binlog"]
}
```

Visual Studio und VS Code können ihn auch über das Plugin `dotnet-msbuild` aus dem Marketplace `dotnet/skills` einbinden, das den Server automatisch erkennt, sodass Sie das JSON vollständig überspringen.

## Die 15 Tools, gruppiert nach dem, was Sie tatsächlich fragen

Die Tools teilen sich auf vier Aufgaben auf. Zum Diagnostizieren eines roten Builds gibt es `binlog_overview` (Status, Dauer, Anzahl der Fehler und Projekte), `binlog_errors`, `binlog_warnings`, filterbar nach Code, und `binlog_search`, das Volltextabfragen im StructuredLog-DSL ausführt. Das Highlight ist `binlog_explain_property`: Es verfolgt, woher der Wert einer Eigenschaft tatsächlich stammt, sodass eine Frage wie "Warum ist `TargetFramework` hier auf net8.0 gesetzt?" eine Auswertungskette statt einer Vermutung liefert.

Für langsame Builds ordnen `binlog_expensive_projects`, `binlog_expensive_targets` und `binlog_expensive_tasks` nach Laufzeit. Und `binlog_compare` vergleicht zwei Logs, was sich meiner Erwartung nach bezahlt machen wird:

> Vergleiche `build-a.binlog` und `build-b.binlog`. Welche MSBuild-Eigenschaften und Paketversionen haben sich geändert?

Dieser eine Prompt ersetzt den mühsamen Seite-an-Seite-Abgleich, den Sie machen, wenn ein Build auf Ihrer Maschine funktioniert und in der CI fehlschlägt.

Das ist Teil eines breiteren Musters, bei dem Microsoft die Diagnose von .NET in MCP verpackt, damit Agenten sie bedienen können. Der Server liegt in [`dotnet/skills`](https://github.com/dotnet/skills); melden Sie Probleme dort. Wenn Sie einen instabilen CI-Build haben, der in einem Log steckt, das niemand öffnen will, ist dies der einfachste Weg, ein Modell darauf anzusetzen.
