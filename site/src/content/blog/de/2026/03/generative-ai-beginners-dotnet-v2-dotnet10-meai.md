---
title: "Generative AI for Beginners .NET v2: für .NET 10 mit Microsoft.Extensions.AI neu gebaut"
description: "Microsofts kostenloser Generative-AI-Kurs für .NET-Entwickler liefert Version 2, neu gebaut für .NET 10 und von Semantic Kernel auf das IChatClient-Muster von Microsoft.Extensions.AI migriert."
pubDate: 2026-03-29
tags:
  - "dotnet"
  - "dotnet-10"
  - "ai"
  - "ai-agents"
  - "llm"
  - "microsoft-extensions-ai"
  - "generative-ai"
lang: "de"
translationOf: "2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft hat [Generative AI for Beginners .NET](https://aka.ms/genainet) auf Version 2 aktualisiert. Der Kurs ist kostenlos, quelloffen und nun vollständig für .NET 10 neu gebaut, mit einer signifikanten architektonischen Änderung: Semantic Kernel ist als primäre Abstraktion draußen, ersetzt durch [Microsoft.Extensions.AI](https://learn.microsoft.com/en-us/dotnet/ai/microsoft-extensions-ai) (MEAI).

## Der Wechsel zu Microsoft.Extensions.AI

Version 1 stützte sich auf Semantic Kernel für Orchestrierung und Modellzugriff. Version 2 standardisiert auf MEAIs `IChatClient`-Schnittstelle, die als Teil von .NET 10 ausgeliefert wird und denselben Dependency-Injection-Konventionen wie `ILogger` folgt.

Das Registrierungsmuster wird jedem .NET-Entwickler vertraut sein:

```csharp
var builder = Host.CreateApplicationBuilder();

// Register any IChatClient-compatible provider
builder.Services.AddChatClient(new OllamaChatClient("phi4"));

var app = builder.Build();
var client = app.Services.GetRequiredService<IChatClient>();

var response = await client.GetStreamingResponseAsync("What is AOT compilation?");
await foreach (var update in response)
    Console.Write(update.Text);
```

Die Schnittstelle ist provider-agnostisch. Den `OllamaChatClient` gegen eine Azure-OpenAI-Implementierung auszutauschen erfordert das Ändern einer einzigen Zeile. Der Kurs nutzt das absichtlich -- die Fähigkeiten übertragen sich zwischen Providern, statt Sie an das SDK eines einzelnen Anbieters zu binden.

## Was die fünf Lektionen abdecken

Das umstrukturierte Curriculum läuft in fünf eigenständigen Lektionen:

1. **Grundlagen** -- LLM-Mechanik, Tokens, Kontextfenster, und wie sich .NET 10 mit Modell-APIs integriert
2. **Kerntechniken** -- Chat-Completions, Prompt-Engineering, Function Calling, strukturierte Ausgaben, und RAG-Grundlagen
3. **AI-Muster** -- semantische Suche, Retrieval-Augmented Generation, Dokumentverarbeitungspipelines
4. **Agenten** -- Werkzeugnutzung, Multi-Agent-Orchestrierung, und Model Context Protocol (MCP)-Integration mit der eingebauten MCP-Client-Unterstützung von .NET 10
5. **Verantwortungsvolle KI** -- Bias-Erkennung, Content-Safety-APIs, und Transparenz-Richtlinien

Die Agent-Lektion ist besonders relevant, falls Sie die MCP-Unterstützung von .NET 10 verfolgt haben. Der Kurs verbindet Multi-Agent-Orchestrierung direkt mit diesem Feature über den MCP-Client aus `Microsoft.Extensions.AI.Abstractions`, sodass Sie Beispiele gegen lokale oder Remote-MCP-Server laufen lassen können, ohne Framework-Akrobatik.

## Migration von Version 1

Die elf Semantic-Kernel-Beispiele aus Version 1 sind in einen veralteten Ordner im Repo verschoben -- sie laufen noch, werden aber nicht mehr als empfohlenes Muster präsentiert. Wenn Sie Version 1 durchgearbeitet haben, bleiben die Kernkonzepte dieselben. Die Migration ist hauptsächlich ein Tausch auf der API-Schicht: ersetzen Sie `Kernel` und `IKernelBuilder` von Semantic Kernel durch `IChatClient` und die Standard-`IServiceCollection`-Erweiterungen.

Das Kurs-Repository ist auf [github.com/microsoft/generative-ai-for-beginners-dotnet](https://github.com/microsoft/generative-ai-for-beginners-dotnet). Der Kurs selbst startet auf [aka.ms/genainet](https://aka.ms/genainet).
