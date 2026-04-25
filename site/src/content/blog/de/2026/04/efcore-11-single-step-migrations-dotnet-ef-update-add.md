---
title: "EF Core 11 lässt Sie eine Migration in einem Befehl erstellen und anwenden"
description: "Der Befehl dotnet ef database update akzeptiert nun --add, um eine Migration in einem einzigen Schritt zu scaffolden und anzuwenden. So funktioniert es, warum es für Container und .NET Aspire wichtig ist, und worauf zu achten ist."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add"
translatedBy: "claude"
translationDate: 2026-04-25
---

Falls Sie jemals während einer Prototyping-Sitzung Dutzende Male zwischen `dotnet ef migrations add` und `dotnet ef database update` hin- und hergewechselt sind, hat EF Core 11 Preview 2 einen kleinen Komfortgewinn: das `--add`-Flag bei `database update`.

## Ein Befehl statt zwei

Der neue Workflow reduziert den Zwei-Schritt-Tanz auf einen einzigen Aufruf:

```bash
dotnet ef database update InitialCreate --add
```

Dieser Befehl scaffoldet eine Migration namens `InitialCreate`, kompiliert sie zur Laufzeit mit Roslyn und wendet sie auf die Datenbank an. Die Migrationsdateien landen weiterhin auf der Festplatte, sodass sie wie jede andere Migration in der Versionskontrolle landen.

Falls Sie das Ausgabeverzeichnis oder den Namespace anpassen müssen, übertragen sich dieselben Optionen von `migrations add`:

```bash
dotnet ef database update AddProducts --add \
  --output-dir Migrations/Products \
  --namespace MyApp.Migrations
```

PowerShell-Anwender erhalten den entsprechenden `-Add`-Schalter bei `Update-Database`:

```powershell
Update-Database -Migration InitialCreate -Add
```

## Warum Laufzeitkompilierung wichtig ist

Der wahre Gewinn ist nicht das Sparen einiger Tastenanschläge in der lokalen Entwicklung. Es geht darum, Migrations-Workflows in Umgebungen zu ermöglichen, in denen Neukompilierung keine Option ist.

Denken Sie an .NET Aspire-Orchestrierung oder containerisierte CI-Pipelines: das kompilierte Projekt ist bereits ins Image eingebrannt. Ohne `--add` bräuchten Sie einen separaten Build-Schritt, nur um eine Migration zu scaffolden, das Projekt neu zu bauen und sie dann anzuwenden. Mit Roslyn-Laufzeitkompilierung handhabt der `database update`-Befehl den gesamten Lebenszyklus an Ort und Stelle.

## Offline-Migrationsentfernung

EF Core 11 fügt zudem ein `--offline`-Flag bei `migrations remove` hinzu. Wenn die Datenbank nicht erreichbar ist oder Sie sicher wissen, dass die Migration nie angewendet wurde, können Sie die Verbindungsprüfung vollständig überspringen:

```bash
dotnet ef migrations remove --offline
```

Beachten Sie, dass `--offline` und `--force` sich gegenseitig ausschließen: `--force` benötigt eine aktive Verbindung, um zu überprüfen, ob die Migration angewendet wurde, bevor sie zurückgenommen wird.

Beide Befehle akzeptieren nun auch einen `--connection`-Parameter, sodass Sie eine bestimmte Datenbank ansprechen können, ohne Ihre `DbContext`-Konfiguration anzufassen:

```bash
dotnet ef migrations remove --connection "Server=staging;Database=App;..."
```

## Wann darauf zurückgreifen

Für Prototyping und Inner-Loop-Entwicklung beseitigt `--add` Reibung. Für containerbasierte Deployment-Pipelines beseitigt es eine gesamte Build-Stufe. Behalten Sie nur im Hinterkopf, dass laufzeitkompilierte Migrationen Ihre normalen Build-Warnungen umgehen, also behandeln Sie die generierten Dateien als Artefakte, die immer noch eine Review verdienen, bevor sie auf `main` landen.

Vollständige Details finden sich in den [EF Core 11 What's-New-Docs](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
