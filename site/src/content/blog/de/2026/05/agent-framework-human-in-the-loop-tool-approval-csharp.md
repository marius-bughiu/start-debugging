---
title: "Microsoft Agent Framework sichert riskante Tool-Aufrufe mit FunctionApprovalRequestContent ab"
description: "Verpacken Sie ein AIFunction in ApprovalRequiredAIFunction, und der Agent hält mitten im Lauf an, um Erlaubnis zu erbitten. So funktioniert der Anfrage- und Antwort-Fluss in C#."
pubDate: 2026-05-06
tags:
  - "dotnet"
  - "ai-agents"
  - "agent-framework"
  - "csharp"
  - "human-in-the-loop"
lang: "de"
translationOf: "2026/05/agent-framework-human-in-the-loop-tool-approval-csharp"
translatedBy: "claude"
translationDate: 2026-05-06
---

Jeremy Likness hat [Building Blocks for AI Part 3](https://devblogs.microsoft.com/dotnet/microsoft-agent-framework-building-blocks-for-ai-part-3/) am 4. Mai 2026 im .NET Blog veröffentlicht, und der Teil, den jeder beachten sollte, der Agenten in Produktion bringt, ist der Human-in-the-Loop-Genehmigungsfluss für Tool-Aufrufe. Microsoft Agent Framework 1.0 (`Microsoft.Agents.AI` auf NuGet) behandelt dies als erstklassigen Laufzustand: Wenn ein sensibles Tool aufgerufen wird, ruft der Agent es nicht auf. Er pausiert, legt den Aufruf offen und wartet darauf, dass Ihre Anwendung ihn genehmigt oder ablehnt, bevor der nächste Lauf fortgesetzt wird.

## Eine Funktion als genehmigungspflichtig markieren

Der Wrapper ist `ApprovalRequiredAIFunction`. Sie erstellen ein normales `AIFunction` aus einem Delegate, verpacken es einmal und übergeben dann die verpackte Instanz an `AsAIAgent`. Das Modell sieht weiterhin dasselbe Schema; nur die Aufrufstelle des Frameworks ändert sich.

```csharp
using System.ComponentModel;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

[Description("Get the weather for a given location.")]
static string GetWeather([Description("The location to get the weather for.")] string location)
    => $"The weather in {location} is cloudy with a high of 15C.";

AIFunction weatherFunction = AIFunctionFactory.Create(GetWeather);
AIFunction approvalRequired = new ApprovalRequiredAIFunction(weatherFunction);

AIAgent agent = new AIProjectClient(
    new Uri("<your-foundry-project-endpoint>"),
    new DefaultAzureCredential())
    .AsAIAgent(
        model: "gpt-4o-mini",
        instructions: "You are a helpful assistant",
        tools: [approvalRequired]);
```

Sie ändern nicht den Funktionsrumpf. Alles, was einen Bestätigungsschritt erfordern sollte (Datenbankschreibvorgänge, Zahlungsaufrufe, ausgehende E-Mails, alles, was kein halluziniertes Argument auslösen soll), bekommt den Wrapper, und nur das.

## Die Anfrage erkennen

Wenn das Modell beschließt, ein genehmigungspflichtiges Tool aufzurufen, liefert das Framework eine Antwort, die ein oder mehrere `FunctionApprovalRequestContent`-Elemente anstelle des Rückgabewerts des Tools enthält. Nach jedem `RunAsync` durchsuchen Sie den Nachrichteninhalt nach ihnen.

```csharp
AgentSession session = await agent.CreateSessionAsync();
AgentResponse response = await agent.RunAsync(
    "What is the weather like in Amsterdam?", session);

var requests = response.Messages
    .SelectMany(m => m.Contents)
    .OfType<FunctionApprovalRequestContent>()
    .ToList();

foreach (var req in requests)
{
    Console.WriteLine($"Approval needed for {req.FunctionCall.Name}");
    Console.WriteLine($"Arguments: {req.FunctionCall.Arguments}");
}
```

`FunctionCall.Name` und `FunctionCall.Arguments` sind das, was Sie dem Benutzer anzeigen. Zeigen Sie die tatsächlichen Argumente, nicht nur den Funktionsnamen. Der Sinn der Sperre liegt darin, dass das Modell die Argumente gewählt hat, und `delete_account(id: 42)` ist der Teil, auf den ein menschliches Auge schauen soll.

## Die Antwort zurücksenden

Die Antwort wird aus der Anfrage selbst gebaut. `requestContent.CreateResponse(true)` erzeugt ein `FunctionApprovalResponseContent`; übergeben Sie `false`, um abzulehnen. Verpacken Sie es in ein Benutzer-`ChatMessage`, führen Sie auf derselben Session erneut aus, und der Agent führt entweder das Tool aus oder fährt ohne dessen Ergebnis fort.

```csharp
var approvalMessage = new ChatMessage(
    ChatRole.User,
    [requests[0].CreateResponse(approve: true)]);

AgentResponse final = await agent.RunAsync(approvalMessage, session);
Console.WriteLine(final);
```

## Iterieren, nicht annehmen

Ein einzelner Benutzer-Turn kann mehrere Genehmigungsanfragen erzeugen, vor allem mit einem Planer, der Aufrufe bündelt. Die Dokumentation ist explizit: Suchen Sie nach jedem Lauf weiter nach `FunctionApprovalRequestContent`, bis die Antwort keine mehr enthält. Wenn Sie nur die erste Anfrage behandeln und Schluss machen, verlieren Sie spätere Tool-Aufrufe stillschweigend und enden mit einer Antwort, der Daten fehlen.

Für Workflow-Szenarien versteht `AgentWorkflowBuilder.BuildSequential()` den Genehmigungsvertrag bereits: Es pausiert den Workflow und emittiert ein `RequestInfoEvent`, ohne zusätzliche Verkabelung. Vollständiges lauffähiges Beispiel im [microsoft/agent-framework Repository](https://github.com/microsoft/agent-framework/tree/main/dotnet/samples/02-agents/Agents/Agent_Step01_UsingFunctionToolsWithApprovals), und die API ist auf [learn.microsoft.com](https://learn.microsoft.com/en-us/agent-framework/agents/tools/tool-approval) dokumentiert.
