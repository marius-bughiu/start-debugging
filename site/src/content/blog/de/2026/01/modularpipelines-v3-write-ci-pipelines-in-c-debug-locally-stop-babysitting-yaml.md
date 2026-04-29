---
title: "ModularPipelines V3: CI-Pipelines in C# schreiben, lokal debuggen, kein YAML-Babysitting mehr"
description: "ModularPipelines V3 erlaubt Ihnen, CI-Pipelines in C# statt in YAML zu schreiben. Führen Sie sie lokal mit dotnet run aus, profitieren Sie von Sicherheit zur Kompilierzeit und debuggen Sie mit Haltepunkten."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/01/modularpipelines-v3-write-ci-pipelines-in-c-debug-locally-stop-babysitting-yaml"
translatedBy: "claude"
translationDate: 2026-04-29
---
Diese Woche gab es eine weitere Erinnerung daran, dass CI keine blinde Push-and-Pray-Schleife sein muss: **ModularPipelines V3** wird aktiv ausgeliefert (das jüngste Tag `v3.0.86` wurde am 2026-01-18 veröffentlicht) und stützt sich stark auf eine einfache Idee: Ihre Pipeline ist einfach eine .NET-Anwendung.

Quelle: [ModularPipelines repo](https://github.com/thomhurst/ModularPipelines) und das [v3.0.86 Release](https://github.com/thomhurst/ModularPipelines/releases/tag/v3.0.86).

## Der Teil, der Ihre Feedback-Schleife verändert

Wenn Sie .NET 10-Dienste ausliefern, haben Ihre Pipeline-Schritte bereits "Code-Form": kompilieren, testen, veröffentlichen, packen, scannen, bereitstellen. Das Problem ist meist die Hülle: YAML, stringly-typed-Variablen und eine 5-10-minütige Feedback-Schleife für Tippfehler.

ModularPipelines dreht das um:

-   Sie können die Pipeline lokal mit `dotnet run` ausführen.
-   Abhängigkeiten werden in C# deklariert, sodass die Engine parallelisieren kann.
-   Die Pipeline ist stark typisiert, sodass Refactorings und Fehler wie normale Compile-Fehler auftauchen.

Hier die Kernform direkt aus der README des Projekts, als minimal einfügbares Beispiel aufbereitet:

```cs
// Program.cs
await PipelineHostBuilder.Create()
    .AddModule<BuildModule>()
    .AddModule<TestModule>()
    .AddModule<PublishModule>()
    .ExecutePipelineAsync();

public class BuildModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Build(new DotNetBuildOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}

[DependsOn<BuildModule>]
public class TestModule : Module<CommandResult>
{
    protected override Task<CommandResult?> ExecuteAsync(IPipelineContext context, CancellationToken ct) =>
        context.DotNet().Test(new DotNetTestOptions
        {
            Project = "MySolution.sln",
            Configuration = Configuration.Release
        }, ct);
}
```

Das ist im besten Sinne langweilig: es ist normales C#. Haltepunkte funktionieren. Ihre IDE hilft. "Modul umbenennen" ist keine angsteinflößende globale Suche.

## Tool-Wrapper, die mit dem Ökosystem mitziehen

Das `v3.0.86`-Release ist absichtlich "klein": es aktualisiert CLI-Optionen für Tools wie `pnpm`, `grype` und `vault`. Das ist genau die Art von Wartung, die ein Pipeline-Framework für Sie übernehmen soll. Wenn eine CLI ein Flag hinzufügt oder ändert, soll sich ein typisierter Wrapper bewegen, nicht ein Dutzend YAML-Snippets verrotten.

## Warum mir das Modulmodell für reale Repos gefällt

In größeren Codebasen liegen die versteckten Kosten von YAML nicht in der Syntax. Sie liegen im Change-Management:

-   Teilen Sie die Pipeline-Logik nach Verantwortlichkeit (Build, Test, Publish, Scan) auf, statt eine einzige Megadatei zu pflegen.
-   Halten Sie den Datenfluss explizit. Module können stark typisierte Ergebnisse zurückgeben, die nachgelagerte Module konsumieren.
-   Lassen Sie Analyzer Abhängigkeitsfehler früh fangen. Wenn Sie ein anderes Modul aufrufen, sollte das Vergessen von `[DependsOn]` keine Laufzeitüberraschung sein.

Wenn Sie bereits in .NET 9 oder .NET 10 leben, ist das Behandeln Ihrer Pipeline als kleine C#-Anwendung kein "Overengineering". Es ist eine kürzere Feedback-Schleife und weniger Überraschungen in der Produktion.

Wenn Sie tiefer einsteigen wollen, beginnen Sie mit dem "Quick Start" und der Dokumentation des Projekts: [Full Documentation](https://thomhurst.github.io/ModularPipelines).
