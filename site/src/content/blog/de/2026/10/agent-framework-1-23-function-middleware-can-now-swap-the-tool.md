---
title: "Agent Framework 1.23: Function-Middleware kann das aufgerufene Tool endlich austauschen"
description: "Microsoft Agent Framework .NET 1.23.0 berücksichtigt Zuweisungen an FunctionInvocationContext.Function, sodass Middleware einen Tool-Aufruf auf eine andere AIFunction umleiten kann. Der neue Helper WrapWithPendingMiddleware hält den Rest der Kette eingebunden."
pubDate: 2026-10-02
tags:
  - "agent-framework"
  - "dotnet"
  - "ai-agents"
  - "microsoft-extensions-ai"
lang: "de"
translationOf: "2026/10/agent-framework-1-23-function-middleware-can-now-swap-the-tool"
translatedBy: "claude"
translationDate: 2026-10-02
---

Microsoft Agent Framework [dotnet-1.23.0](https://github.com/microsoft/agent-framework/releases/tag/dotnet-1.23.0) ist am 1. Oktober 2026 erschienen, mit einer langen Liste von Fixes und fünf als BREAKING markierten Änderungen. Die Änderung, um die es hier geht, ist gar nicht markiert, weil die Maintainer sie als Bugfix behandeln: [PR #8615](https://github.com/microsoft/agent-framework/pull/8615) sorgt dafür, dass Function-Middleware die Funktion, die sie gleich aufruft, tatsächlich ersetzen kann.

## Der Setter, der nichts bewirkte

Function-Calling-Middleware, die mit `AIAgentBuilder.Use(...)` registriert wird, erhält einen `FunctionInvocationContext`. Dessen Property `Function` hat einen öffentlichen Setter, und nichts hinderte Sie daran, vor dem Aufruf von `next` eine andere `AIFunction` zuzuweisen. Bis 1.22 wurde diese Zuweisung stillschweigend ignoriert. Änderungen an `context.Arguments` wurden übernommen, die Continuation rief aber immer die Funktion auf, die der Wrapper beim Aufbau der Tool-Liste erfasst hatte.

Damit war eine ganze Klasse von Mustern blockiert: einen riskanten Aufruf an eine abgesicherte Implementierung weiterleiten, zur Laufzeit eine Implementierung pro Tenant einsetzen oder in einem Integrationstest einen Stub unterschieben, ohne den Agenten neu zu bauen. Der übliche Workaround bestand darin, `next` auszulassen und die andere Funktion selbst aufzurufen. Damit wurde jede später registrierte Middleware übergangen.

## Einen Aufruf in 1.23 umleiten

`FunctionInvocationDelegatingAgent` erfasst das Ziel jetzt, bevor Ihr Callback läuft, und dispatcht danach auf das, was `context.Function` enthält. Bleibt der Wert unverändert, verhält sich alles wie in 1.22. Wurde er ersetzt, läuft der Ersatz:

```csharp
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

AIFunction sandboxedDelete = AIFunctionFactory.Create(
    (string customerId) => $"Queued deletion of {customerId} for human review.",
    "delete_customer",
    "Deletes a customer record.");

async ValueTask<object?> RouteDestructiveCalls(
    AIAgent agent,
    FunctionInvocationContext context,
    Func<FunctionInvocationContext, CancellationToken, ValueTask<object?>> next,
    CancellationToken cancellationToken)
{
    if (context.Function.Name == "delete_customer")
    {
#pragma warning disable MAAI001
        context.Function = context.WrapWithPendingMiddleware(sandboxedDelete);
#pragma warning restore MAAI001
    }

    return await next(context, cancellationToken);
}

AIAgent agent = baseAgent
    .AsBuilder()
        .Use(RouteDestructiveCalls)
        .Use(AuditMiddleware)
    .Build();
```

Das Modell hat `delete_customer` angefordert, die Argumente laufen unverändert durch, und die Sandbox-Version liefert das Tool-Ergebnis.

## Wozu WrapWithPendingMiddleware da ist

Ein Ersatz wird direkt aufgerufen. Ohne den Helper würde `AuditMiddleware` im obigen Beispiel den umgeleiteten Aufruf nie sehen. Das neue `FunctionInvocationContextExtensions.WrapWithPendingMiddleware(context, function)` umhüllt den Ersatz mit den Callbacks, die für diesen Aufruf noch nicht gelaufen sind, sodass der Rest der Kette ihn weiterhin beobachtet.

Drei Regeln aus dem Quellcode:

- Der Aufruf muss aus einem laufenden Callback heraus erfolgen, bevor `next` aufgerufen wird. Ist die Continuation bereits gelaufen, ist nichts mehr ausstehend, und der Helper wirft `InvalidOperationException`.
- Stehen keine Callbacks aus, gibt er Ihre Funktion unverändert zurück.
- Er ist mit `[Experimental]` und der Diagnose `MAAI001` markiert, daher das Pragma.

Eines ändert der Austausch nicht: Tool-Approval und Telemetrie spiegeln weiterhin die Funktion wider, die das Modell ursprünglich angefordert hat, weil der Aufruf aufgelöst wird, bevor irgendein Callback läuft. Erfordert `delete_customer` eine Freigabe, gibt der Benutzer weiterhin `delete_customer` frei, auch wenn Ihre Middleware danach etwas anderes ausführt. Für Auditing ist das der richtige Standard, aber ein Austausch ist kein Weg, eine Freigabe zu umgehen.

## Der Rest von 1.23 in Kürze

Vor dem Upgrade lohnt auch die Suche nach diesen BREAKING-Einträgen: Validierung von Tool-Namen und Behandlung ausstehender Aufrufe, wenn sich die Tool-Liste zwischen Runs ändert ([#8754](https://github.com/microsoft/agent-framework/pull/8754)), strengere Bindung von Approval-Antworten ([#8641](https://github.com/microsoft/agent-framework/pull/8641)) und eine Allowlist für Konfigurations- und Umgebungsschlüssel in deklarativen Workflows, wobei der Fallback auf Prozess-Umgebungsvariablen deaktiviert ist, solange Sie nicht `AllowProcessEnvironmentVariableFallback = true` setzen ([#8200](https://github.com/microsoft/agent-framework/pull/8200)). Das Release hebt außerdem `Microsoft.Extensions.AI` auf 10.10.1 und OpenAI auf 2.14.0.

Sie kommen von 1.21 oder älter? Beginnen Sie mit [den Änderungen in 1.22 rund um AsIChatClient und Tools pro Run](/de/2026/09/agent-framework-1-22-asichatclient-exposes-an-agent-as-an-ichatclient/) und wechseln Sie dann auf `Microsoft.Agents.AI` 1.23.0.
