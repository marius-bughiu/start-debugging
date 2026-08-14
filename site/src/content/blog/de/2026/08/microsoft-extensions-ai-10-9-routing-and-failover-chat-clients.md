---
title: "Microsoft.Extensions.AI 10.9 liefert Chat-Clients mit Routing und Failover"
description: "Microsoft.Extensions.AI 10.9.0 ergänzt RoutingChatClient, OrderedFailoverChatClient und SemanticRoutingChatClient. Gegen das echte Paket verifiziert: was per Failover wechselt, was nicht, und warum MEAI001 den Build bricht."
pubDate: 2026-08-14
tags:
  - "dotnet"
  - "ai"
  - "microsoft-extensions-ai"
  - "resilience"
  - "csharp"
lang: "de"
translationOf: "2026/08/microsoft-extensions-ai-10-9-routing-and-failover-chat-clients"
translatedBy: "claude"
translationDate: 2026-08-14
---

Am 2026-08-13 hat das .NET-Team [Routing and Failover for Microsoft.Extensions.AI](https://devblogs.microsoft.com/dotnet/routing-and-failover-for-microsoft-extensions-ai/) veröffentlicht. Interessant daran ist, dass die Typen bereits als `Microsoft.Extensions.AI` 10.9.0 auf NuGet liegen und sich heute schon verwenden lassen. Bisher bedeutete es, eine Anfrage an ein günstiges Modell zu schicken und auf ein größeres zurückzufallen, einen handgeschriebenen `try`/`catch`-Wrapper um `IChatClient` zu bauen. Jetzt gibt es vier Typen dafür: `RoutingChatClient` und `RoutingContext` in `Microsoft.Extensions.AI.Abstractions` sowie `FailoverChatClient`, `OrderedFailoverChatClient` und `SemanticRoutingChatClient` in `Microsoft.Extensions.AI`.

## Eine geordnete Client-Liste sind jetzt zwei Zeilen

`OrderedFailoverChatClient` geht eine Liste durch, bis ein Client erfolgreich antwortet. Der Konstruktor lautet `(IReadOnlyList<IChatClient> clients, bool leaveOpen = false)`. Übergeben Sie `leaveOpen: true`, wenn der Container die inneren Clients besitzt:

```csharp
using var failover = new OrderedFailoverChatClient(
    [primaryClient, backupClient, lastResortClient],
    leaveOpen: true);

ChatResponse response = await failover.GetResponseAsync(
    [new ChatMessage(ChatRole.User, "hi")]);
```

Wenn alle Clients eine Ausnahme werfen, erhalten Sie die letzte, keine aggregierte. Das sollten Sie wissen, bevor Sie einen `catch`-Block schreiben, der `AggregateException` erwartet.

## Die Streaming-Regel, die Sie treffen wird

Failover ist bei Streaming-Aufrufen nicht kostenlos. Die Wiederholungsschleife wählt nur so lange einen neuen Client aus, wie noch nichts an den Aufrufer ausgeliefert wurde. Drei Fälle habe ich gegen einen Fake-Client geprüft:

- Primärer Client ohne Streaming wirft eine Ausnahme: `SelectClientAsync` läuft erneut, der Backup-Client antwortet, der Aufrufer sieht den Fehler nie.
- Primärer Client mit Streaming wirft vor dem ersten `ChatResponseUpdate`: dasselbe, ein sauberer Wechsel zum Backup.
- Primärer Client mit Streaming wirft, nachdem bereits zwei Updates ausgeliefert wurden: die Ausnahme erscheint mitten in der Enumeration, und die beiden Teilstücke bleiben konsumiert.

Der dritte Fall ist der, um den herum Sie entwerfen müssen. Sobald `FailoverChatClientAttempt.OutputCommitted` `true` ist, gibt es keine Wiederherstellung mitten im Stream. Eine Oberfläche, die Token beim Eintreffen anhängt, braucht also eine eigene Behandlung für abgeschnittene Antworten.

## Routing nach Kosten oder nach Bedeutung

Für alles außer einer geordneten Liste nimmt `RoutingChatClient.Create` einen Callback entgegen:

```csharp
using var router = RoutingChatClient.Create((context, ct) =>
    new ValueTask<IChatClient>(
        context.Messages.Last().Text.Length > 20 ? powerfulClient : cheapClient));
```

`RoutingContext` stellt nur `Messages` und `ChatOptions` bereit, was für Routing über `AdditionalProperties` bei festen Sitzungen ausreicht. Leiten Sie stattdessen von `FailoverChatClient` ab, wenn Sie zusätzlich die Wiederholungsschleife wollen, und setzen Sie `MaximumAttemptsPerRequest` (ein `int?`), um sie zu begrenzen.

`SemanticRoutingChatClient` wählt über Embedding-Ähnlichkeit aus. Die vollständige Signatur hat mehr Stellschrauben, als der Originalartikel zeigt:

```csharp
SemanticRoutingChatClient(
    IEmbeddingGenerator<string, Embedding<float>> embeddingGenerator,
    IReadOnlyDictionary<IChatClient, IReadOnlyList<string>> clientProfiles,
    IChatClient defaultClient,
    float scoreThreshold = 0.3f,
    int topK = 1,
    ScoreAggregation scoreAggregation = ScoreAggregation.Mean,
    bool leaveOpen = false)
```

`ScoreAggregation` ist `Mean` oder `Sum`, und alles unterhalb von `scoreThreshold` landet beim `defaultClient`.

## MEAI001 ist ein Fehler, keine Warnung

Alle diese Typen tragen `[Experimental("MEAI001")]`, und der Compiler behandelt das standardmäßig als Fehler:

```
error MEAI001: 'Microsoft.Extensions.AI.OrderedFailoverChatClient' is for evaluation
purposes only and is subject to change or removal in future updates.
```

Fügen Sie `<NoWarn>MEAI001</NoWarn>` in Ihre csproj ein, um sich bewusst dafür zu entscheiden. Da sich die Form der API noch bewegt, sollten Sie die Routing-Entscheidung hinter einem eigenen Interface kapseln. Wer noch direkt auf dem SDK des Anbieters sitzt: die [Migration zu Microsoft.Extensions.AI](https://startdebugging.net/2026/07/migrate-from-openai-sdk-to-microsoft-extensions-ai/) ist die Voraussetzung für all das.
