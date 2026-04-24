---
title: "GitHub Copilot Modernization: Der Assessment-Report ist das eigentliche Produkt"
description: "GitHub Copilot Modernization wird als Assess, Plan, Execute-Loop für die Migration von Legacy-.NET-Apps verkauft. Die Assessment-Phase ist, wo der Wert liegt: ein Inventar-Report, kategorisierte Blocker und dateiebenen-genaue Remediation-Guidance, die Sie wie Code diffen können."
pubDate: 2026-04-14
tags:
  - "dotnet"
  - "copilot"
  - "github-copilot"
  - "ai-agents"
  - "modernization"
  - "dotnet-10"
lang: "de"
translationOf: "2026/04/github-copilot-modernization-assessment-dotnet"
translatedBy: "claude"
translationDate: 2026-04-24
---

Microsofts Post vom 7. April ["Your Migration's Source of Truth: The Modernization Assessment"](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) beschreibt [GitHub Copilot Modernization](https://devblogs.microsoft.com/dotnet/your-migrations-source-of-truth-the-modernization-assessment/) als "Assess, Plan, Execute"-Loop, um Legacy-.NET-Framework- und Java-Workloads nach vorne zu ziehen. Wenn Sie nur eines vom Post behalten, sollte es das sein: Das Assessment ist kein glänzendes Dashboard, es ist ein Report, der nach `.github/modernize/assessment/` geschrieben wird und den Sie neben Ihrem Code committen.

## Warum den Report ins Repo legen

Migrationen sterben, wenn der Plan in einem Word-Dokument lebt, das niemand aktualisiert. Indem das Assessment ins Repo geschrieben wird, wird jede Änderung über einen Pull Request reviewbar, und die Branch-History zeigt, wie die "Liste der Blocker" über die Zeit schrumpft. Es heißt außerdem, dass das Assessment in CI neu generiert und gediff't werden kann, sodass Sie bemerken, wenn jemand eine deprecierte API wieder einführt.

Der Report selbst bricht Findings in drei Eimer:

1. Mandatory: Blocker, die aufgelöst werden müssen, bevor die Migration kompiliert oder läuft.
2. Potential: Verhaltensänderungen, die üblicherweise ein Code-Update erfordern, zum Beispiel APIs, die zwischen .NET Framework und .NET 10 entfernt wurden.
3. Optional: Ergonomie-Verbesserungen, wie ein Wechsel zu `System.Text.Json` oder `HttpClientFactory`.

Jedes Finding ist an eine Datei und einen Zeilenbereich gebunden, sodass ein Reviewer den Report öffnen, zum Code durchklicken und die Remediation verstehen kann, ohne das Tool neu laufen lassen zu müssen.

## Ein Assessment laufen lassen

Sie können ein Assessment aus der VS-Code-Extension heraus anstoßen, aber die interessante Oberfläche ist die CLI, weil sie in CI passt:

```bash
# Run a recommended assessment against a single repo
modernize assess --path ./src/LegacyApi --target dotnet10

# Multi-repo batch mode for a portfolio
modernize assess --multi-repo ./repos --target dotnet10 --coverage deep
```

Das `--target`-Flag ist, wo die Szenario-Presets leben: `dotnet10` triggert den Upgrade-Pfad von .NET Framework zu .NET 10, während `java-openjdk21` das Java-Äquivalent abdeckt. Das `--coverage`-Flag handelt Laufzeit gegen Tiefe, und Deep Coverage ist das, was tatsächlich transitive NuGet-Referenzen inspiziert.

## Das Assessment wie Code behandeln

Weil der Report eine Sammlung von Markdown- und JSON-Dateien ist, können Sie ihn linten. Hier ein kleines Skript, das CI zum Fehlschlag bringt, wenn das Assessment neue Mandatory-Issues gewinnt:

```csharp
using System.Text.Json;

var report = JsonSerializer.Deserialize<AssessmentReport>(
    File.ReadAllText(".github/modernize/assessment/summary.json"));

var mandatory = report.Issues.Count(i => i.Severity == "Mandatory");
Console.WriteLine($"Mandatory issues: {mandatory}");

if (mandatory > report.Baseline.Mandatory)
{
    Console.Error.WriteLine("New Mandatory blockers introduced since baseline.");
    Environment.Exit(1);
}

record AssessmentReport(Baseline Baseline, Issue[] Issues);
record Baseline(int Mandatory);
record Issue(string Severity, string File, int Line, string Rule);
```

Das verwandelt ein einmaliges Assessment in eine Ratsche: Sobald ein Blocker aufgelöst ist, kann er nicht still zurückkommen.

## Wo es neben ASP.NET Core 2.3 passt

Derselbe April-7-Batch von Posts enthielt den [ASP.NET Core 2.3 End-of-Support-Hinweis](https://devblogs.microsoft.com/dotnet/aspnet-core-2-3-end-of-support/), der den 13. April 2027 als hartes Datum setzt. Copilot Modernization ist Microsofts Antwort für Shops, die noch ASP.NET-Core-2.3-Pakete auf .NET Framework fahren: Assessment laufen lassen, committen und die Mandatory-Liste abarbeiten, bevor die Uhr abläuft.

Das Tool ist keine Magie. Es schreibt keine `HttpContext`-Extension für Sie um und entscheidet nicht, ob per App Service oder AKS zu containerisieren ist. Was es tut, ist Ihnen ein repo-natives, diffbares Inventar der Arbeit zu geben, was das erste ehrliche Gespräch ist, das die meisten langlebigen .NET-Codebases seit Jahren hatten.
