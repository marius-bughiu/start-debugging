---
title: "Agent Framework 1.22: AsIChatClient lässt einen AIAgent als IChatClient auftreten"
description: "Microsoft Agent Framework .NET 1.22.0 ergänzt AIAgent.AsIChatClient() und schließt damit den Rückweg zu IChatClient.AsAIAgent(). Ihr Agent behält Anweisungen und Tools und passt jetzt in jede API, die einen IChatClient entgegennimmt."
pubDate: 2026-09-20
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "de"
translationOf: "2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient"
translatedBy: "claude"
translationDate: 2026-09-20
---

Microsoft Agent Framework [dotnet-1.22.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.22.0) erschien am 2026-09-18, und der Eintrag, der Ihre Aufmerksamkeit verdient, ist [PR #7687](https://github.com/microsoft/agent-framework/pull/7687): `AsIChatClient`. `Microsoft.Extensions.AI` besitzt schon länger `ChatClientExtensions.AsAIAgent()`, das einen Chat-Client in einen Agenten verwandelt. Die Gegenrichtung fehlte. Jetzt gibt es sie, und der Kreis schließt sich.

## Warum die fehlende Richtung wehtat

Die Liste der .NET-APIs, die einen `IChatClient` akzeptieren, wächst stetig: die Evaluatoren in `Microsoft.Extensions.AI.Evaluation`, Caching- und Telemetrie-Middleware, alles, was auf der `ChatClientBuilder`-Pipeline aufsetzt. Ein `AIAgent` ist das reichere Objekt. Er trägt Anweisungen, ein Tool-Set, eine Session und jede Middleware, die Sie darum gelegt haben. Einer dieser APIs einen nackten `IChatClient` zu übergeben, bedeutete, all das von Hand nachzubauen, oder dem bewertenden Evaluator ein Modell zu geben, dem der System-Prompt fehlt, der es überhaupt erst zum Bewerter macht.

`AsIChatClient` liegt in `Microsoft.Agents.AI` und hat diese Form:

```csharp
public static IChatClient AsIChatClient(
    this AIAgent agent,
    AgentSession? session = null,
    string? conversationId = null,
    bool allowNonChatClientAgents = false)
```

Ein bewertender Agent wird damit in einem einzigen Aufruf zum bewertenden Chat-Client:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIAgent judge = chatClient.CreateAIAgent(
    instructions: "You score answers for factual accuracy. Reply with JSON only.",
    name: "Judge");

IChatClient judgeClient = judge.AsIChatClient();
```

Der Adapter ist ein interner `AIAgentChatClient`, der `GetResponseAsync` und `GetStreamingResponseAsync` auf `RunAsync` und `RunStreamingAsync` abbildet und Ihre `ChatOptions` als `ChatClientAgentRunOptions` weiterreicht. Cancellation läuft durch, und ein `GetService<IChatClient>()` ohne Key liefert den Adapter zurück, während jede andere Service-Anfrage an den Agenten weitergereicht wird.

## Die Schutzprüfung, und wann Sie sie abschalten

Standardmäßig wirft der Aufruf `InvalidOperationException`, sofern der Agent kein `ChatClientAgent` ist oder keinen aus einem `GetService<ChatClientAgent>()` ohne Key zurückgibt. Dekoratoren auf Basis von `DelegatingAIAgent` reichen diese Anfrage weiter, ein umhüllter Agent besteht die Prüfung also weiterhin.

Mit `allowNonChatClientAgents: true` wird jeder Agententyp umhüllt, aber das Kleingedruckte zählt: nur `ChatOptions.ResponseFormat` überlebt den Übergang. Temperatur, Tools und der Rest werden stillschweigend ignoriert, denn ein Workflow-Agent oder ein entfernter A2A-Agent hat keine Chat-Optionen, auf die sie anwendbar wären.

Sessions sind die zweite scharfe Kante. Im standardmäßigen zustandslosen Modus wirft eine nicht leere `ChatOptions.ConversationId` eine Exception, und rohe Response-IDs werden in den zurückgegebenen Kopien geleert. Übergeben Sie eine `session`, meldet der Client für jede Antwort genau eine stabile Conversation-ID: die von Ihnen gelieferte oder eine pro Instanz erzeugte. Die dienstseitige ID gibt er nie preis, wodurch der Conversation-State des Anbieters innerhalb der Session bleibt, wo er hingehört. Jede andere nicht leere ID wird als unbekannt abgelehnt.

Die API ist mit `[Experimental]` markiert, rechnen Sie also mit einem Buildfehler, bis Sie die zugehörige Diagnose unterdrücken.

Eine weitere Zeile desselben Release verdient ein Grep durch Ihren Code: [PR #8531](https://github.com/microsoft/agent-framework/pull/8531) übergibt die Tools eines `ChatClientAgent` jetzt pro Lauf, statt sie am darunterliegenden funktionsaufrufenden Chat-Client zu setzen. Damit können sich Tools nicht mehr verdoppeln oder zwischen Agenten durchsickern, die sich einen Client teilen. Das ist als BREAKING gekennzeichnet, ebenso wie die Verschiebung von `AgentSessionStore` nach `Microsoft.Agents.AI.Abstractions`.

Aktualisieren Sie auf `Microsoft.Agents.AI` 1.22.0, und falls Sie das Release der vergangenen Woche übersprungen haben, prüfen Sie vorher, [was 1.21 an LocalCodeAct und Ihrer Host-Umgebung geändert hat](/de/2026/09/agent-framework-1-21-localcodeact-stops-inheriting-host-environment/).
