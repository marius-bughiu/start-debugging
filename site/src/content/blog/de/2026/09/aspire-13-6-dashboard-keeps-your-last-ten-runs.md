---
title: "Aspire 13.6: Das Dashboard speichert Ihre letzten zehn Läufe in SQLite"
description: "Aspire 13.6.0 macht das Dashboard persistent: Ressourcen-Snapshots und Telemetrie landen in einer SQLite-Datenbank, der AppHost hält bis zu zehn Läufe pro Anwendung vor, und abgeschlossene Läufe bleiben schreibgeschützt abrufbar. So funktionieren die Modi Run, Resume und None und so konfigurieren Sie das eigenständige Dashboard."
pubDate: 2026-09-30
tags:
  - "aspire"
  - "dotnet"
  - "opentelemetry"
  - "observability"
lang: "de"
translationOf: "2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs"
translatedBy: "claude"
translationDate: 2026-09-30
---

[Aspire 13.6.0](https://github.com/microsoft/aspire/releases/tag/v13.6.0) ist am 29. September 2026 erschienen, und die erste spürbare Änderung ist, dass das Dashboard nicht mehr alles vergisst, sobald Sie den AppHost beenden. Bis 13.5 hielt das Dashboard die Telemetrie im Arbeitsspeicher: Wer nach dem Reproduzieren eines Fehlers Ctrl+C drückte, hatte den gesuchten Trace verloren. In 13.6 speichert das Dashboard Ressourcen-Snapshots und Telemetrie in einer versionierten SQLite-Datenbank, und über eine Auswahl in der Kopfzeile wechseln Sie zwischen dem laufenden und früheren Läufen.

## Was der AppHost standardmäßig tut

Wird das Dashboard von einem AppHost gestartet, verwendet es die Persistenz **Run**, ohne dass Sie etwas aktivieren müssen. Jeder `aspire run` wird zu einem eigenen Eintrag, und pro Anwendung bleiben bis zu zehn Läufe erhalten. Abgeschlossene Läufe sind schreibgeschützt. So können Sie den Lauf vor Ihrer Korrektur öffnen und Ressourcen, strukturierte Logs, Traces und Metriken direkt neben dem laufenden Lauf vergleichen.

Am Code Ihres AppHost ändert sich nichts. Es ist dieselbe Datei wie gestern:

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var cache = builder.AddRedis("cache");

builder.AddProject<Projects.Api>("api")
       .WithReference(cache);

builder.Build().Run();
```

Die Daten liegen standardmäßig unter `<ASPIRE_HOME>/dashboard`, aufgeteilt nach Anwendungsname.

## Größere Puffer, weiterhin begrenzt

Dieselbe Version hebt die Standardgrenzen für Konsolen-Lognachrichten, strukturierte Logs und Traces auf jeweils 100.000 an. Das sind weiterhin Ringpuffer und kein Archiv: Wird eine Grenze überschritten, fallen die ältesten Einträge weg. Wenn Sie mehr oder weniger brauchen, gelten die bestehenden Einstellungen, zum Beispiel `Dashboard:TelemetryLimits:MaxLogCount`, `Dashboard:TelemetryLimits:MaxTraceCount` und `Dashboard:Frontend:MaxConsoleLogCount`, oder Umgebungsvariablen im Stil von `DASHBOARD__TELEMETRYLIMITS__MAXLOGCOUNT`.

## Eigenständiges Dashboard: None, Run, Resume

Das eigenständige Dashboard behält standardmäßig sein bisheriges Verhalten: Persistenz **None**, eine temporäre Datenbank, die beim Beenden des Dashboards gelöscht wird. Um Daten über Neustarts hinweg zu behalten, verwenden Sie **Resume** mit einem stabilen Anwendungsnamen:

```bash
aspire dashboard run --application-name my-app --persistence Resume
```

In einem Container binden Sie das Datenverzeichnis als Volume ein und übergeben jedes Mal dieselben drei Werte:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 \
  -v aspire-dashboard-data:/data \
  -e ASPIRE_DASHBOARD_DATA_DIRECTORY=/data \
  -e ASPIRE_DASHBOARD_APPLICATION_NAME=my-app \
  -e ASPIRE_DASHBOARD_PERSISTENCE_MODE=Resume \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

Ändern sich Anwendungsname, Verzeichnis oder Modus zwischen zwei Neustarts, erhalten Sie eine neue Datenbank statt Ihres Verlaufs. Der Anwendungsname bestimmt außerdem die Namen der Authentifizierungs- und Antiforgery-Cookies des Dashboards. Wählen Sie daher pro Anwendung einen Namen und behalten Sie ihn bei.

## Die Datenbank wie ein Geheimnis behandeln

Die Release Notes sind hier deutlich: Die SQLite-Datei kann sensible Ressourcen- und Telemetriewerte enthalten und bringt weder Verschlüsselung noch eine eigene Autorisierung mit. Unter Unix sind die Dateiberechtigungen auf den Besitzer beschränkt, unter Windows werden keine ACLs für Sie gesetzt. Umgebungsvariablen, die Sie in Ressourcen einspeisen, Verbindungszeichenfolgen in Ressourcen-Snapshots und alles, was Ihre Anwendung protokolliert, liegen nach dem Ende des Laufs nun auf der Festplatte. Binden Sie dieses Volume nirgends ein, wo andere Zugriff haben, und übernehmen Sie `ASPIRE_HOME` nicht in ein Dev-Container-Image.

Auch das Dashboard selbst hat sich unter der Haube geändert: Es wird jetzt als Native AOT ausgeliefert und nutzt Fluent UI v5 mit einer einklappbaren Navigationsleiste. Vom AppHost verwaltete Terminals öffnen sich nun in einem Dock des Dashboards und erweitern damit die [`WithTerminal`-Arbeit aus 13.5](/de/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/). Zusätzlich bringt 13.6 optionale `WithRepl()`-Datenbankclients mit. Die vollständige Liste samt Breaking Changes finden Sie unter [Neuigkeiten in Aspire 13.6](https://aspire.dev/whats-new/aspire-13-6/).
