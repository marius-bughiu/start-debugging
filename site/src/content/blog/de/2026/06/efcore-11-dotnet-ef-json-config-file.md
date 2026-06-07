---
title: "EF Core 11 Preview 4: Schluss mit dem Wiedereintippen von --project und --startup-project dank .config/dotnet-ef.json"
description: "EF Core 11 Preview 4 erlaubt es dem dotnet-ef-Tool, Standardwerte für Optionen aus einer .config/dotnet-ef.json-Datei zu lesen, sodass aufgeteilte Solutions Sie nicht mehr zwingen, --project und --startup-project bei jedem Befehl anzugeben."
pubDate: 2026-06-01
tags:
  - "ef-core"
  - "dotnet-11"
  - "dotnet-cli"
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/06/efcore-11-dotnet-ef-json-config-file"
translatedBy: "claude"
translationDate: 2026-06-01
---

Wer EF-Core-Migrationen in einer geschichteten Solution ausführt, kennt das Ritual: Der `DbContext` liegt in einem Infrastrukturprojekt, die Verbindungszeichenfolge und die DI-Verdrahtung liegen im API-Projekt, und deshalb wird jeder `dotnet ef`-Befehl zu einem Absatz. `dotnet ef migrations add AddOrders --project src/App.Infrastructure --startup-project src/App.Api --context AppDbContext`. Sie merken ihn sich auswendig, legen ein Alias an oder fügen ihn aus einer Notizdatei ein. [EF Core 11 Preview 4](/de/2026/05/ef-core-11-temporal-tables-clr-period-properties/), am 12. Mai 2026 als Teil von [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/) veröffentlicht, erlaubt es Ihnen endlich, diese Standardwerte einmal festzuhalten.

## Eine Konfigurationsdatei, die das Tool durch Hochlaufen im Baum findet

Das Befehlszeilentool `dotnet ef` liest jetzt Standardwerte für Optionen aus einer `.config/dotnet-ef.json`-Datei. Die Suche funktioniert genauso wie bei `.editorconfig` oder `global.json`: Das Tool läuft vom aktuellen Arbeitsverzeichnis aus den Verzeichnisbaum hoch und verwendet die erste gefundene Datei. Legen Sie eine im Solution-Stammverzeichnis ab, und jeder Befehl, der von irgendwo innerhalb des Baums ausgeführt wird, erbt sie.

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "framework": "net11.0",
  "configuration": "Debug",
  "context": "AppDbContext",
  "runtime": "win-x64",
  "verbose": true,
  "noColor": false,
  "prefixOutput": false
}
```

Mit dieser Datei reduziert sich der Absatz wieder auf das, was er immer hätte sein sollen:

```console
dotnet ef migrations add AddOrders
dotnet ef database update
```

Die unterstützten Schlüssel sind direkt den bekannten Flags zugeordnet: `project`, `startupProject`, `framework`, `configuration`, `context`, `runtime`, `verbose`, `noColor` und `prefixOutput`. Eine Sache, die Sie richtig machen sollten: Die Pfadwerte von `project` und `startupProject` werden relativ zum übergeordneten Verzeichnis des `.config`-Verzeichnisses aufgelöst, das die Datei enthält, nicht relativ zu dem Ort, an dem Sie sich beim Ausführen des Befehls gerade befinden. Legen Sie die Datei im Repository-Stammverzeichnis in `.config/` ab, dann lesen sich die Pfade so, als wären sie vom Stammverzeichnis aus geschrieben worden.

## Explizite Flags gewinnen weiterhin

Dies ist eine Datei mit Standardwerten, keine Sperrdatei. Jede Option, die Sie auf der Befehlszeile angeben, überschreibt den JSON-Wert. Sie können also `AppDbContext` als Standard beibehalten und trotzdem einen einmaligen Lauf gegen einen zweiten Kontext ausführen:

```console
dotnet ef migrations add AddAudit --context AuditDbContext
```

Genau diese Vorrangregel ist der Grund, warum dies bedenkenlos eingecheckt werden kann. Nehmen Sie `.config/dotnet-ef.json` in die Versionsverwaltung auf, und jeder Entwickler sowie die CI erhalten dieselben Standardwerte, ohne dass jemand ein gemeinsam genutztes Skript bearbeitet. Das Muster spiegelt wider, wie `dotnet tool` bereits `.config/dotnet-tools.json` verwendet, sodass der Speicherort allen vertraut sein wird, die lokale Tool-Manifeste nutzen.

In derselben Vorschauversion gibt es eine kleinere ergänzende Änderung, die gut zum Skripting passt: Das EF-Tool schreibt jetzt alle Log- und Statusmeldungen in die Standardfehlerausgabe und reserviert die Standardausgabe für das eigentliche Ergebnis des Befehls. So liefert `dotnet ef migrations script > schema.sql` sauberes SQL ohne untergemischtes Banner-Rauschen.

Dies kommt zusammen mit der Ergonomie-Arbeit an temporalen Tabellen, die in [EF Core 11 Preview 4: Periodenspalten temporaler Tabellen können endlich echte Eigenschaften sein](/2026/05/ef-core-11-temporal-tables-clr-period-properties/) behandelt wird. Den vollständigen Überblick finden Sie im [Abschnitt Konfigurationsdatei in der dotnet-ef-Dokumentation](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#configuration-file) und auf der [Seite zu den Neuerungen in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
