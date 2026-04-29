---
title: "CV Shortlist: ein KI-gestütztes .NET 10-SaaS ging open-source, und der Stack lohnt das Studium"
description: "CV Shortlist ist ein open-source .NET 10-SaaS, das Azure Document Intelligence mit einem OpenAI-Modell kombiniert. Stack, Konfigurationsdisziplin und KI-Integrationsgrenze lohnen das Studium."
pubDate: 2026-01-18
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---
Ein C#-Beitrag, den ich heute markiert habe, ist nicht "noch eine Demo-App". Es ist ein vollständiges, opinionated SaaS, das als kommerzielles Produkt gebaut und dann als Lernreferenz open-source gestellt wurde: **CV Shortlist**.

Quelle: [CV Shortlist repo](https://github.com/mihnea-radulescu/cvshortlist) und der ursprüngliche [r/csharp-Beitrag](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/).

## Der nützliche Teil ist die Integrationsgrenze, nicht die UI

Die meisten KI-Beispiel-Apps hören bei "ein LLM aufrufen" auf. Diese hier dokumentiert die reale Grenze, an der Produktionsfeatures stehen oder fallen:

-   **Azure Document Intelligence** extrahiert strukturierte Daten aus PDF-Lebensläufen (einschließlich Tabellen und mehrspaltigen Layouts).
-   **OpenAI GPT-5** analysiert die extrahierten Daten, gleicht sie mit einer Stellenausschreibung ab und produziert die Shortlist.

Diese Kombination empfehle ich immer wieder, wenn Teams fragen "wie machen wir RAG für Dokumente?", ohne eine fragile OCR-Pipeline von Grund auf zu bauen: Verwenden Sie einen spezialisierten Extraktionsdienst und rechnen Sie dann auf sauberem Text und sauberen Feldern.

## Ein moderner .NET 10-Stack, explizit aufgelistet

Das README ist erfrischend konkret in Bezug auf Versionen und Infrastruktur:

-   .NET 10, ASP.NET Core 10, Blazor 10, EF Core 10
-   Azure Web App, SQL Database, Blob Storage, Application Insights
-   Azure Document Intelligence und ein Azure AI Foundry-Modell (das README nennt ein `gpt-5-mini`-Foundry-Modell)
-   Eine self-hosted-Variante, die weiterhin auf die zwei KI-Ressourcen angewiesen ist

Selbst wenn Sie sich nie für die Recruiting-Domäne interessieren, ist dies eine reale Referenz dafür, "wie viele bewegliche Teile auftauchen, sobald KI kein Spielzeug-Feature mehr ist".

## Konfigurationsdisziplin: user secrets lokal, Umgebungsvariablen in der Produktion

Das Repo hebt die zwei Praktiken hervor, die jedes .NET 10-Team standardisieren sollte:

-   Lokales Debugging: Geheimnisse in **user secrets** speichern
-   Produktions-Deployments: **Umgebungsvariablen** verwenden

Hier ist das Muster, das ich in `Program.cs` bei Projekten wie diesem erwarte:

```cs
var builder = WebApplication.CreateBuilder(args);

// Local debugging: dotnet user-secrets
if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>(optional: true);
}

builder.Services
    .AddOptions<AiSettings>()
    .Bind(builder.Configuration.GetSection("Ai"))
    .ValidateDataAnnotations()
    .ValidateOnStart();

var app = builder.Build();
app.Run();

public sealed class AiSettings
{
    public required string DocumentIntelligenceEndpoint { get; init; }
    public required string DocumentIntelligenceKey { get; init; }
    public required string FoundryModel { get; init; } // example: gpt-5-mini
}
```

Die Pointe sind nicht diese exakten Eigenschaftsnamen. Die Pointe ist: Behandeln Sie die KI-Grenze wie jede andere externe Abhängigkeit in ASP.NET Core 10, und machen Sie Konfiguration und Validierung langweilig.

## Warum das wichtig ist (selbst wenn Sie nie HR-Software bauen)

Wenn Sie versuchen, KI-Features in .NET 10 auszuliefern, brauchen Sie funktionierende Beispiele, die folgendes enthalten:

-   PDF-Ingestion, die bei realen Layouts nicht zusammenbricht
-   mehrstufige Verarbeitung (extrahieren, normalisieren, schließen, persistieren)
-   Cloud-Ressourcen mit Schlüsseln, Rotation, Telemetrie und Kostenkontrolle

CV Shortlist ist eine kompakte "so sieht es aus, wenn Sie es tatsächlich bauen"-Referenz. Lesen Sie das README, überfliegen Sie `Program.cs` und stehlen Sie das Grenzdesign für Ihre eigene Domäne.
