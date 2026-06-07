---
title: "GitHub Copilot SDK erreicht GA: Binden Sie die Agent-Laufzeit von Copilot in Ihre eigenen C#-Apps ein"
description: "Auf der Build 2026 hat GitHub Copilot SDK 1.0 GA mit einem erstklassigen .NET-Paket veröffentlicht. Sie können jetzt aus C#-Code dieselbe Agent-Laufzeit mit Planung, Tool-Aufrufen und Mehrrunden-Sessions steuern, BYOK inklusive."
pubDate: 2026-06-07
tags:
  - "github-copilot"
  - "copilot-sdk"
  - "ai-agents"
  - "dotnet"
  - "csharp"
  - "mcp"
lang: "de"
translationOf: "2026/06/github-copilot-sdk-ga-embed-copilot-agent-runtime-csharp"
translatedBy: "claude"
translationDate: 2026-06-07
---

GitHub hat angekündigt, dass das [GitHub Copilot SDK allgemeine Verfügbarkeit erreicht](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/) am 2. Juni 2026 auf der Build, und der Teil, der als .NET-Entwickler Ihre Aufmerksamkeit verdient, ist das Paket `GitHub.Copilot.SDK`. Es gibt Ihnen direkten, programmatischen Zugriff auf dieselbe Agent-Laufzeit, die hinter Copilot im Editor steht: Planung, Tool-Aufruf, Dateibearbeitung, Streaming und Mehrrunden-Sessions. Das Verkaufsargument ist, dass Sie die Orchestrierungsschicht nicht selbst bauen müssen. Die Laufzeit, die bereits täglich Millionen von Agent-Runden abwickelt, ist jetzt eine NuGet-Abhängigkeit.

## Was Sie tatsächlich bekommen

Das SDK erschien beim GA in sechs Sprachen (`@github/copilot-sdk`, `github-copilot-sdk` für Python, Go, Rust, Java und `GitHub.Copilot.SDK` für .NET). Für Node.js, Python und .NET wird die Copilot-CLI automatisch als transitive Abhängigkeit mitgeliefert, es gibt also keine separate Binärdatei zu installieren oder im PATH zu halten. Sie fügen ein Paket hinzu und haben einen Agent-Host:

```bash
dotnet add package GitHub.Copilot.SDK
```

Eine Session ist die Arbeitseinheit. Sie starten einen Client, öffnen eine Session gegen ein Modell und lauschen auf typisierte Ereignisse, statt zu pollen. Hier ist der vollständige Ablauf für einen einzelnen Prompt:

```csharp
using GitHub.Copilot;

await using var client = new CopilotClient();
await client.StartAsync();

await using var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    OnPermissionRequest = PermissionHandler.ApproveAll,
});

var done = new TaskCompletionSource();

session.On<SessionEvent>(evt =>
{
    if (evt is AssistantMessageEvent msg)
        Console.WriteLine(msg.Data.Content);
    else if (evt is SessionIdleEvent)
        done.SetResult();
});

await session.SendAsync(new MessageOptions { Prompt = "What is 2+2?" });
await done.Task;
```

Streaming ist ein Flag, keine andere API: Setzen Sie `Streaming = true` im `SessionConfig` und Sie erhalten `AssistantMessageDeltaEvent`-Fragmente, die Sie bis zum finalen `AssistantMessageEvent` akkumulieren.

## Tools sind ganz normale Methoden, MCP ist eingebaut

Der Baustein, der das zu mehr als einem Chat-Wrapper macht, sind benutzerdefinierte Tools. `CopilotTool.DefineTool` nimmt einen Delegate entgegen und nutzt die Funktions-Factory von `Microsoft.Extensions.AI` wieder, ein Tool ist also einfach eine typisierte C#-Methode mit einem `[Description]` an jedem Parameter:

```csharp
using Microsoft.Extensions.AI;
using System.ComponentModel;

var session = await client.CreateSessionAsync(new SessionConfig
{
    Model = "gpt-5",
    Tools =
    [
        CopilotTool.DefineTool(
            async ([Description("Issue ID")] string id) => await FetchIssueAsync(id),
            factoryOptions: new AIFunctionFactoryOptions
            {
                Name = "lookup_issue",
                Description = "Fetch issue details",
            }),
    ],
});
```

Wenn Sie bereits [einen benutzerdefinierten MCP-Server in C#](/de/2026/04/how-to-build-a-custom-mcp-server-in-csharp-on-net-11/) gebaut haben, kann sich der Agent direkt damit verbinden, Ihre bestehenden Tools kommen also ohne Neuschreiben mit.

## BYOK, damit es nicht an die GitHub-Abrechnung gebunden ist

Die Authentifizierung ist der andere Grund hinzuschauen. Standardmäßig übernimmt das SDK Ihren `copilot`-CLI-Login oder die Umgebungstokens (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). Aber Bring-your-own-Key funktioniert mit OpenAI, Microsoft Foundry, Anthropic und anderen Anbietern, Sie können die Laufzeit also auf ein Modell richten, für das Sie bereits zahlen:

```csharp
var session = await client.CreateSessionAsync(new SessionConfig
{
    Provider = new ProviderConfig
    {
        Type = "openai",
        BaseUrl = "https://api.openai.com/v1",
        ApiKey = "your-api-key",
    },
});
```

Es liefert außerdem OpenTelemetry-Tracing mit W3C-Trace-Context-Propagierung mit, die Tool-Aufrufe und Runden des Agenten erscheinen also in denselben Traces wie der Rest Ihres Dienstes. Für alle, die bisher eine Tool-Schleife von Hand auf einem rohen Chat-Client gebaut haben, ist das GA-Paket das erste Mal, dass GitHubs eigene Agent-Laufzeit etwas ist, das Sie per `dotnet add` hinzufügen und ausliefern können. Das [.NET-Cookbook und der Einstiegsleitfaden](https://github.com/github/copilot-sdk) sind die nächste Anlaufstelle.
