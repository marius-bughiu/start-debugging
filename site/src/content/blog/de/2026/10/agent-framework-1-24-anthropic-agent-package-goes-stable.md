---
title: "Agent Framework 1.24: Das Anthropic-Agent-Paket ist stabil, außer den Beta-Diensten"
description: "Microsoft.Agents.AI.Anthropic 1.24.0 verliert den Preview-Suffix und hängt von Anthropic 12.53.0 ab. Aus IAnthropicClient erzeugte Agents sind jetzt stabile API, während die client.Beta-Erweiterungen unter MAAIANTHROPIC001 als experimentell markiert sind, was Aufrufe per Erweiterungsmethode nicht auslöst."
pubDate: 2026-10-08
tags:
  - "agent-framework"
  - "dotnet"
  - "anthropic"
  - "ai-agents"
lang: "de"
translationOf: "2026/10/agent-framework-1-24-anthropic-agent-package-goes-stable"
translatedBy: "claude"
translationDate: 2026-10-08
---

Microsoft Agent Framework [dotnet-1.24.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.24.0) ist am 7. Oktober 2026 erschienen, und eine Zeile im Changelog ist wichtiger als der Rest, wenn Sie Claude-basierte Agents in .NET betreiben: [PR #9111](https://github.com/microsoft/agent-framework/pull/9111), "Stabilize Anthropic agent package". Bis letzte Woche gab es `Microsoft.Agents.AI.Anthropic` nur als Preview-Builds (der letzte war `1.23.0-preview.260928.1`). Auf NuGet heißt es jetzt schlicht `1.24.0` und wurde zusammen mit dem Rest des Frameworks veröffentlicht.

## Was "stabil" tatsächlich abdeckt

Das Paket enthält zwei Erweiterungsklassen, und sie wurden nicht gleich behandelt.

`AnthropicClientExtensions`, die `AsAIAgent` an `IAnthropicClient` anhängt, ist jetzt ausgelieferte öffentliche API. Der PR fügt `PublicAPI.Shipped.txt`-Baselines für jedes Zielframework hinzu, für das das Paket gebaut wird (`net10.0`, `net9.0`, `net8.0`, `netstandard2.0`, `net472`), sodass die Paketvalidierung ab jetzt Breaking Changes meldet. Die Abhängigkeit wurde außerdem von `Anthropic` 12.45.0 auf 12.53.0 angehoben, das offizielle Anthropic-C#-SDK, das selbst GA ist.

`AnthropicBetaServiceExtensions`, die `AsAIAgent`-Überladungen auf `IBetaService` (das, was Sie über `client.Beta` erhalten), bildet die Ausnahme. Die gesamte Klasse ist jetzt mit `[Experimental("MAAIANTHROPIC001")]` markiert, mit dem Hinweis in der Doku, dass sie sich "may change in non-major releases as the underlying beta services evolve". Die Begründung in [Issue #9110](https://github.com/microsoft/agent-framework/issues/9110) ist einfach: Das Anthropic-SDK ist GA, seine Beta-Oberfläche aber nicht, und Agent Framework will keinen Kompatibilitätsvertrag zusichern, den der Upstream nicht gibt.

## Was sich in Ihrem Code ändert

Wenn Sie Agents aus dem regulären Client erzeugen, ändert sich nur die Paketversion:

```xml
<PackageReference Include="Microsoft.Agents.AI.Anthropic" Version="1.24.0" />
```

```csharp
using Anthropic;
using Microsoft.Agents.AI;

AnthropicClient client = new() { ApiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") };

ChatClientAgent agent = client.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You review C# pull requests and answer in short bullet points.",
    name: "reviewer");

Console.WriteLine(await agent.RunAsync("Is `async void` ever fine in an ASP.NET Core handler?"));
```

Beim Beta-Pfad wird es subtil. Ich habe ihn mit SDK 10.0.302 gegen das Paket 1.24.0 kompiliert. Erstens liegen die Überladungen im Namespace `Anthropic.Services`, daher wird `client.Beta.AsAIAgent(...)` erst aufgelöst, wenn Sie dieses `using` hinzufügen. Zweitens sitzt das Attribut an der Klasse, nicht an den Methoden, und C# meldet ein `[Experimental]` auf Klassenebene nur, wenn der Typname in Ihrem Code vorkommt. Die Syntax der Erweiterungsmethode nennt den Typ nie, daher kompiliert das hier sauber und ohne Diagnose:

```csharp
using Anthropic.Services;

ChatClientAgent agent = client.Beta.AsAIAgent(
    model: "claude-sonnet-5-5",
    instructions: "You create PowerPoint presentations.",
    tools: [pptxSkill.AsAITool()]);
```

Nennen Sie die Klasse direkt, etwa bei einem statischen Aufruf oder wenn Sie das gemeinsame Standard-Token-Budget anpassen, erhalten Sie einen Fehler, denn `[Experimental]`-Diagnosen sind standardmäßig Fehler:

```csharp
AnthropicBetaServiceExtensions.DefaultMaxTokens = 8000;
```

```text
error MAAIANTHROPIC001: 'Anthropic.Services.AnthropicBetaServiceExtensions' is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
```

Das Skills-Beispiel des Frameworks unterdrückt sie am Dateianfang mit `#pragma warning disable MAAIANTHROPIC001`. Wenn Beta-Funktionen fester Teil Ihres Entwurfs und kein Experiment sind, unterdrücken Sie sie einmal für das ganze Projekt:

```xml
<PropertyGroup>
  <NoWarn>$(NoWarn);MAAIANTHROPIC001</NoWarn>
</PropertyGroup>
```

## Warum die Aufteilung die richtige Entscheidung ist

Ein Preview-Paket in Produktion festzuschreiben ist ein häufiger Grund, Claude-Agents nicht mit Agent Framework zu betreiben und stattdessen `IChatClient` von Hand zu verdrahten (die Abwägungen stehen in meinem [Vergleich von Anthropic SDK und Microsoft.Extensions.AI](/2026/06/anthropic-sdk-vs-microsoft-extensions-ai-for-calling-claude-from-dotnet/)). Diese Ausrede entfällt für den stabilen Pfad. Behandeln Sie die Diagnose aber nicht als Audit. Da die Form des Erweiterungsaufrufs an ihr vorbeirutscht, bedeutet ein sauberer Build nicht, dass Sie die Beta-Oberfläche verlassen haben: Suchen Sie per grep nach `client.Beta` und `IBetaService`, um die Aufrufstellen zu finden, die bei einem Minor-Update von Agent Framework oder des Anthropic-SDK brechen können.

Der Rest von 1.24.0 ist Härtung: Validierung der `LocalCodeAct`-Fähigkeiten, Ablehnung sensibler Bezeichner in deklarativen Agents und Bindung von MCP-Genehmigungs-Headern an den genehmigten Aufruf. Wenn Sie 1.23 übersprungen haben, lesen Sie vor dem Upgrade zuerst die [Änderung an der Function Middleware](/de/2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool/).
