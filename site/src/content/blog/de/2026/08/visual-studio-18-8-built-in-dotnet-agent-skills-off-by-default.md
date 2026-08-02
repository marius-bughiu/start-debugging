---
title: "Visual Studio 18.8 liefert .NET Agent Skills mit, und schaltet sie alle ab"
description: "Visual Studio 2026 18.8 stellt von Experten verfasste Agent Skills für .NET und Azure in die Werkzeugauswahl, unter der Kategorie Built-in und standardmäßig deaktiviert. Genau diese Voreinstellung ist der interessante Teil."
pubDate: 2026-08-02
tags:
  - "visual-studio"
  - "dotnet"
  - "ai-agents"
  - "agent-skills"
  - "github-copilot"
lang: "de"
translationOf: "2026/08/visual-studio-18-8-built-in-dotnet-agent-skills-off-by-default"
translatedBy: "claude"
translationDate: 2026-08-02
---

Visual Studio 2026 Version 18.8 hat unauffällig verändert, wo die Expertise des Agenten liegt. Skills, die von den .NET- und Azure-Teams verfasst wurden, kommen jetzt mit der IDE, statt etwas zu sein, das Sie selbst suchen, installieren und verdrahten. Am 2026-07-28 hat Mark Downie die Änderung in [Visual Studio July Update, Meet the New Agent](https://devblogs.microsoft.com/visualstudio/visual-studio-july-update-meet-the-new-agent-powered-by-copilot-sdk/) zusammengefasst, und GitHub hat sie am 2026-07-30 im [Copilot Changelog](https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-july-update/) aufgegriffen.

Die Skills erscheinen in einer Kategorie **Built-in** in der Werkzeugauswahl, und nur dann, wenn die passende Workload installiert ist. Wer die Azure-Workload nie installiert hat, sieht die Azure-Skills nie. Und jede einzelne ist aus, bis Sie sie einschalten.

## Zwei .NET-Skills, die zuerst eingeschaltet gehören

`dotnet-webapi` begleitet das Erstellen und Ändern von HTTP-API-Endpunkten in ASP.NET Core: korrekte Statuscodes, OpenAPI-Metadaten am Endpunkt statt nachträglich angeschraubt, und Fehlerbehandlung, die nicht alles zu einem 500 zusammenfallen lässt.

`analyzing-dotnet-performance` ist der Skill für eine bestehende Codebasis. Er prüft rund 50 Performance-Antipattern in den Bereichen asynchron, Speicher, Zeichenketten, Auflistungen, LINQ, Regex, Serialisierung und E/A und stuft die Funde nach Schweregrad ein, statt eine flache Liste auszuwerfen. Er jagt genau das, was durch das Code-Review kommt, weil es sich gut liest:

```csharp
// Materializes every matching row just to ask a yes/no question
if (db.Orders.Where(o => o.CustomerId == id).ToList().Count > 0)
{
    // ...
}

// One EXISTS query, no allocation, no blocking
if (await db.Orders.AnyAsync(o => o.CustomerId == id, ct))
{
    // ...
}
```

Auf der Azure-Seite kommt eine dreistufige Bereitstellungskette (`azure-prepare` erzeugt Bicep oder Terraform sowie `azure.yaml` und die Verdrahtung der verwalteten Identität, `azure-validate` führt Preflight-Prüfungen aus, `azure-deploy` führt die Bereitstellung durch), dazu `azure-kusto` für KQL gegen Azure Data Explorer und `microsoft-foundry` für Modellbereitstellung und Evaluierung.

## Standardmäßig aus ist eine Kontextentscheidung, keine Zaghaftigkeit

Es wäre einfach gewesen, alles zu aktivieren und den Agenten sortieren zu lassen. Sie dunkel auszuliefern ist die bessere Entscheidung, und der Grund ist das Kontextbudget. Jeder aktivierte Skill sind Anweisungen, die um dasselbe Fenster konkurrieren wie Ihr eigentlicher Code. Wer .NET-Web-APIs entwickelt und die Azure-Workload wegen einer einzigen Bereitstellungsaufgabe installiert hat, will nicht sechs Azure-Skills, die den Rest des Jahres jede Antwort verengen.

Das ist dieselbe Disziplin, die das Plugin `dotnet-test` braucht, [jenes hinter dem Unit-Test-Agenten der vergangenen Woche](/de/2026/08/dotnet-skills-polyglot-unit-test-agent-assertion-gate/): laden Sie den Skill für die Aufgabe, nicht den Katalog.

## Für all das brauchen Sie kein Visual Studio

Die .NET-Skills sind öffentlich unter [dotnet/skills](https://github.com/dotnet/skills), die Azure-Skills unter [microsoft/azure-skills](https://github.com/microsoft/azure-skills). Dieselben Plugins lassen sich in Copilot CLI, Claude Code, VS Code und Cursor installieren:

```bash
/plugin marketplace add dotnet/skills
```

Was 18.8 tatsächlich bringt, ist Auffindbarkeit. Niemand hätte `analyzing-dotnet-performance` beim Durchstöbern eines Repositories gefunden. In einer Auswahl neben der bereits installierten Workload zu stehen ist etwas anderes, womit der standardmäßig deaktivierte Schalter die einzige verbleibende Hürde ist, und die lohnt sich.
