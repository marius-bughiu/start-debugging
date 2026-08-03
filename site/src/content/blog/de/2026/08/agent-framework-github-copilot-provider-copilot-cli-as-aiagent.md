---
title: "Der Copilot-Provider von Agent Framework macht die Copilot CLI zu einem gewöhnlichen AIAgent"
description: "Microsoft.Agents.AI.GitHub.Copilot 1.16.0 erschien am 2026-07-30. Die Laufzeit der Copilot CLI liegt jetzt hinter der AIAgent-Abstraktion, Berechtigungen sind standardmäßig verweigert, und Squad hängt ein ganzes Agenten-Team als einen einzigen AIAgent ein."
pubDate: 2026-08-03
tags:
  - "agent-framework"
  - "github-copilot"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "de"
translationOf: "2026/08/agent-framework-github-copilot-provider-copilot-cli-as-aiagent"
translatedBy: "claude"
translationDate: 2026-08-03
---

Microsoft hat `Microsoft.Agents.AI.GitHub.Copilot` 1.16.0 am 2026-07-30 auf NuGet veröffentlicht, und der [am selben Tag erschienene Beitrag im Agent-Framework-Blog](https://devblogs.microsoft.com/agent-framework/building-agent-teams-with-agent-framework-github-copilot-cli-and-squad/) bezeichnet die GitHub-Copilot-Integration als vollständig unterstützt, sowohl in C# als auch in Python. Der praktische Effekt: Die Laufzeit der Copilot CLI, also jene, die Shell-Befehle ausführt, Dateien bearbeitet, URLs abruft und MCP spricht, ist jetzt über die gewöhnliche `AIAgent`-Abstraktion erreichbar.

## Zwei Zeilen bis zum Coding-Agenten

```bash
dotnet add package Microsoft.Agents.AI.GitHub.Copilot
```

```csharp
using GitHub.Copilot;
using Microsoft.Agents.AI;

await using CopilotClient copilotClient = new();
await copilotClient.StartAsync();

AIAgent agent = copilotClient.AsAIAgent();

Console.WriteLine(await agent.RunAsync("What is Microsoft Agent Framework?"));
```

`AsAIAgent` nimmt optional `tools:` und `instructions:` entgegen, sodass eine bereits anderswo registrierte `AIFunction` direkt hineinpasst. Zurück kommt ein Standard-`AIAgent`, das heißt `RunStreamingAsync`, `CreateSessionAsync` für Kontext über mehrere Runden sowie jeder Workflow und jede Orchestrierung, die Sie bereits auf Agent Framework aufgebaut haben, arbeiten unverändert dagegen. Genau das ist der Unterschied dazu, [das Copilot SDK direkt](/de/2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp/) anzusteuern: Die Ereignisschleife der Session schreiben Sie nicht mehr selbst, und Copilot wird zu einem Provider unter vielen.

## Berechtigungen sind standardmäßig verweigert

Das Detail, das zuerst zubeißt: Der Agent kann keine Shell-Befehle ausführen, das Dateisystem nicht anfassen und keine URLs abrufen, solange Sie ihm keinen Berechtigungs-Handler übergeben:

```csharp
SessionConfig sessionConfig = new()
{
    OnPermissionRequest = PromptPermission,
};

AIAgent agent = copilotClient.AsAIAgent(sessionConfig);
```

Ihr Handler liefert `PermissionDecision.ApproveOnce()` oder `PermissionDecision.Reject()` zurück. Es gibt die Abkürzung `PermissionHandler.ApproveAll`, und die [Provider-Seite auf MS Learn](https://learn.microsoft.com/en-us/agent-framework/agents/providers/github-copilot) ist deutlich: Das gehört in einen Container oder Dev Container, nicht auf die Arbeitsmaschine. MCP-Server kommen ebenfalls mit, lokal über stdio und remote über HTTP, konfiguriert über `SessionConfig.McpServers`. Code Interpreter, Dateisuche und gehostete Websuche dagegen nicht: Die Dokumentation markiert alle drei als für diesen Provider nicht unterstützt.

## Squad nutzt dieselbe Abstraktion

Die zweite Hälfte der Ankündigung ist Squad, ein quelloffenes Multi-Agenten-Setup, bei dem ein Koordinator und eine Handvoll Spezialisten als Markdown-Dateien unter `.squad/` im Repository liegen. Das Paket `Squad.Agents.AI` verpackt das gesamte Team als `DelegatingAIAgent`, sodass sich die komplette Mannschaft Ihrer Anwendung gegenüber als ein einziger `AIAgent` präsentiert:

```csharp
builder.Services.AddSquadAgent(o =>
{
    o.SquadFolderPath = @"C:\path\to\your\team-root";
});

var squad = host.Services.GetRequiredService<AIAgent>();
var session = await squad.CreateSessionAsync();
var response = await squad.RunAsync("What can this Squad team do?", session);
```

Jede Weitergabe an einen Spezialisten erzeugt einen OpenTelemetry-Span namens `squad.subagent {Name}`, damit die Verzweigung ohne zusätzliche Verkabelung in Aspire oder Jaeger sichtbar wird. Squad selbst ist noch Alpha (`Squad.Agents.AI` steht bei 0.5.5, mit Previews von 0.5.6) und benötigt `dotnet add package Squad.Agents.AI --prerelease` sowie das npm-Paket `@bradygaster/squad-cli`, um den Ordner anzulegen.

Der Provider ist der Teil, der sich diese Woche zu übernehmen lohnt. Squad ist der interessante Beleg dafür: Sobald ein Coding-Agent nur noch ein `AIAgent` ist, kann ein ganzes Team davon es ebenfalls sein.
