---
title: "Microsoft Agent Framework 1.0: KI-Agenten in reinem C# bauen"
description: "Microsoft Agent Framework erreicht 1.0 mit stabilen APIs, Multi-Provider-Konnektoren, Multi-Agent-Orchestrierung und A2A/MCP-Interop. So sieht es in der Praxis auf .NET 10 aus."
pubDate: 2026-04-07
tags:
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "ai"
  - "microsoft-agent-framework"
lang: "de"
translationOf: "2026/04/microsoft-agent-framework-1-0-ai-agents-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Microsoft hat am 3. April 2026 [Agent Framework 1.0](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/) sowohl für .NET als auch für Python ausgeliefert. Das ist die produktionsreife Version: stabile APIs, Langzeit-Support-Zusage und ein klarer Upgrade-Pfad vom Preview, der Anfang dieses Jahres landete.

Agent Framework vereint die Enterprise-Klempnerei von Semantic Kernel mit den Multi-Agent-Orchestrierungsmustern aus AutoGen in einem einzigen Framework. Wenn Sie diese beiden Projekte getrennt verfolgt haben, ist diese Trennung vorbei.

## Was in der Box steckt

Die 1.0-Veröffentlichung deckt fünf Bereiche ab, die zuvor das Zusammensticken mehrerer Bibliotheken erforderten:

Erstanbieter-**Service-Konnektoren** für Azure OpenAI, OpenAI, Anthropic Claude, Amazon Bedrock, Google Gemini und Ollama. Den Provider zu wechseln ist eine einzeilige Änderung, weil jeder Konnektor `IChatClient` aus `Microsoft.Extensions.AI` implementiert.

**Multi-Agent-Orchestrierungsmuster** aus Microsoft Research und AutoGen übernommen: sequenziell, nebenläufig, Handoff, Group Chat und Magentic-One. Das sind keine Spielzeug-Demos, sondern dieselben Muster, die das AutoGen-Team in Forschungsumgebungen validiert hat.

**MCP-Unterstützung** lässt Agenten Werkzeuge entdecken und aufrufen, die von einem beliebigen Model Context Protocol-Server bereitgestellt werden. Die **A2A (Agent-to-Agent)**-Protokollunterstützung geht weiter und ermöglicht es Agenten, die in verschiedenen Frameworks oder Laufzeiten laufen, sich über strukturiertes Messaging zu koordinieren.

Eine **Middleware-Pipeline** zum Abfangen und Transformieren des Agentenverhaltens in jedem Ausführungsschritt sowie steckbare **Memory-Provider** für Konversationshistorie, Schlüssel-Wert-Zustand und Vektorabruf.

## Ein minimaler Agent in fünf Zeilen

Der schnellste Weg von Null zu einem laufenden Agenten:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;

AIAgent agent = new OpenAIClient("your-api-key")
    .GetChatClient("gpt-4o-mini")
    .AsIChatClient()
    .CreateAIAgent(
        instructions: "You are a senior .NET architect. Be concise and production-focused.");

var response = await agent.RunAsync("Design a retry policy for transient SQL failures.");
Console.WriteLine(response);
```

`AsIChatClient()` überbrückt den OpenAI-Client zur `IChatClient`-Abstraktion. `CreateAIAgent()` umhüllt ihn mit Anweisungskontext, Werkzeugregistrierung und Konversations-Threading. Ersetzen Sie `OpenAIClient` durch einen anderen unterstützten Konnektor, und der Rest des Codes bleibt identisch.

## Werkzeuge hinzufügen

Agenten werden nützlich, wenn sie Ihren Code aufrufen können. Registrieren Sie Werkzeuge mit `AIFunctionFactory`:

```csharp
using Microsoft.Agents.AI;

var tools = new[]
{
    AIFunctionFactory.Create((string query) =>
    {
        // search your internal docs, database, etc.
        return $"Results for: {query}";
    }, "search_docs", "Search internal documentation")
};

AIAgent agent = chatClient.CreateAIAgent(
    instructions: "Use search_docs to answer questions from internal docs.",
    tools: tools);
```

Das Framework handhabt Werkzeugentdeckung, Schema-Erzeugung und Aufruf automatisch. MCP-bereitgestellte Werkzeuge funktionieren genauso, der Agent löst sie zur Laufzeit von einem beliebigen MCP-konformen Server auf.

## Warum das jetzt wichtig ist

Vor 1.0 bedeutete der Bau eines .NET-Agenten, zwischen Semantic Kernel (gute Enterprise-Integration, begrenzte Orchestrierung) oder AutoGen (mächtige Multi-Agent-Muster, holprigere .NET-Story) zu wählen. Agent Framework beseitigt diese Wahl. Ein Paket, ein Programmiermodell, produktionsreif.

Die NuGet-Pakete sind `Microsoft.Agents.AI` für den Kern und `Microsoft.Agents.AI.OpenAI` (oder die provider-spezifische Variante) für Konnektoren. Installieren Sie mit:

```bash
dotnet add package Microsoft.Agents.AI.OpenAI
```

Vollständige Dokumentation und Beispiele auf [GitHub](https://github.com/microsoft/agent-framework) und [Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/overview/).
