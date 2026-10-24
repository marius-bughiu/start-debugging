---
title: "Agent Framework 1.26: AG-UI-Endpunkte machen Scoped Agents nicht mehr zu Singletons"
description: "Microsoft Agent Framework 1.26.0 lässt MapAGUIServer den Keyed-AIAgent, seinen AgentSessionStore und den Isolation-Key-Provider pro Anfrage auflösen und ergänzt eine Selector-Überladung, die den Agenten aus dem HttpContext wählt."
pubDate: 2026-10-24
tags:
  - "agent-framework"
  - "ag-ui"
  - "dotnet"
  - "aspnetcore"
  - "ai-agents"
lang: "de"
translationOf: "2026/10/agent-framework-1-26-ag-ui-endpoints-resolve-scoped-agents-per-request"
translatedBy: "claude"
translationDate: 2026-10-24
---

[Microsoft Agent Framework dotnet-1.26.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.26.0) ist am 23. Oktober 2026 erschienen, mit `Microsoft.Agents.AI.Hosting.AGUI.AspNetCore` in Version `1.26.0-preview.261023.1`. Die wichtigste Änderung für alle, die Agenten hinter AG-UI hosten, ist [PR #9382](https://github.com/microsoft/agent-framework/pull/9382): Der AG-UI-Endpunkt respektiert jetzt die DI-Lebensdauer, mit der Sie Ihren Agenten registriert haben, und Sie können den Agenten pro Anfrage wählen.

## Die Captive Dependency in 1.25 und früher

Vor diesem Release lösten `MapAGUIServer(agentName)` und `MapAGUIServer(IHostedAgentBuilder)` den Keyed-`AIAgent`, den zugehörigen Keyed-`AgentSessionStore` und den `AgentIsolationKeyProvider` einmalig beim Mapping des Endpunkts aus dem Root-Service-Provider auf. Die registrierte Lebensdauer wurde ignoriert. Ein Scoped Agent wurde in der Praxis zum Singleton, und alles, was er erfasste, ebenso.

Das wird zum Problem, wenn der Agent von Zustand pro Anfrage abhängt:

```csharp
builder.Services.AddScoped<TenantContext>();

builder.Services.AddKeyedScoped<AIAgent>("support", (sp, _) =>
{
    var tenant = sp.GetRequiredService<TenantContext>();
    return chatClient.AsAIAgent(
        name: "support",
        instructions: $"You answer support questions for {tenant.Name}.");
});
```

Unter 1.25 gewann der erste aufgelöste `TenantContext`. Jede spätere Anfrage, von jedem Mandanten, erhielt denselben Agenten mit denselben Anweisungen. Es ist die klassische Captive Dependency, nur versteckt hinter einem Endpunkt-Mapping statt in einem Konstruktor.

Ab 1.26 stammen diese drei Dienste bei jeder Anfrage aus `HttpContext.RequestServices`. Scoped und Transient Agents erhalten pro Anfrage eine frische Instanz. Über `IHostedAgentBuilder` registrierte Singletons werden weiterhin einmalig beim Mapping aufgelöst, der Normalfall verursacht also keine Mehrkosten. Fehlende Registrierungen werden weiterhin beim Start gemeldet: Die Prüfung nutzt `IServiceProviderIsKeyedService` und löst daher nie eine Scoped-Instanz aus dem Root-Provider auf.

## Den Agenten aus der Anfrage wählen

Derselbe PR ergänzt eine neue Überladung:

```csharp
public static IEndpointConventionBuilder MapAGUIServer(
    this IEndpointRouteBuilder endpoints,
    [StringSyntax("route")] string pattern,
    Func<HttpContext, AIAgent?> agentSelector)
```

Der Selector läuft einmal pro Anfrage, der Agent kann also aus einem Routenwert, einem Header oder einem Claim stammen:

```csharp
app.MapAGUIServer("/agents/{agent}", ctx =>
{
    var name = ctx.GetRouteValue("agent") as string;
    return name is null
        ? null
        : ctx.RequestServices.GetKeyedService<AIAgent>(name);
});
```

Die Rückgabe von `null` erzeugt ein `404 Not Found`, bevor ein Sitzungszustand geladen wird. Der `Name` des gewählten Agenten dient als Identität für die Sitzungsspeicherung, sodass eine Unterhaltung erhalten bleibt, obwohl für jede Anfrage eine neue Agenteninstanz erstellt wird. Die XML-Dokumentation stellt klar, dass die Auswahl keine Autorisierungsgrenze ist: Setzen Sie eine Autorisierungsrichtlinie auf den Endpunkt (`.RequireAuthorization(...)`), statt `null` für Benutzer zurückzugeben, die einen Agenten nicht erreichen sollen.

## Eine Verhaltensänderung zum Prüfen

Ein Folgecommit im PR ändert, wie benannte Agenten identifiziert werden, die per Instanz gemappt sind. `MapAGUIServer(pattern, AIAgent)` verwendet jetzt den Namen des Agenten als Identität, passend zu den benannten, gehosteten und Selector-Mappings. Zuvor teilten sich derselbe Agent, der über ein benanntes Mapping und ein Instanz-Mapping bereitgestellt wurde, keine Unterhaltungen. Jetzt tun sie es. Unbenannte Agenten verwenden weiterhin die Instanzidentität. Auch die Instanz-Überladung löst ihren Session Store jetzt pro Anfrage auf.

Dasselbe Release ergänzt `AgentSessionStore.DeleteSessionAsync` als abstrakte Methode, ein eigener Store, der von `AgentSessionStore` erbt, lässt sich also erst kompilieren, wenn Sie sie implementieren. Wenn Sie nach [den Umbenennungen im AG-UI .NET SDK 1.0](/de/2026/09/ag-ui-dotnet-sdk-1-0-moves-agui-out-of-agent-framework/) auf `MapAGUIServer` umgestiegen sind und etwas anderes als Singleton-Agenten registrieren, sorgt dieses Upgrade dafür, dass diese Registrierungen das bedeuten, was sie sagen.
