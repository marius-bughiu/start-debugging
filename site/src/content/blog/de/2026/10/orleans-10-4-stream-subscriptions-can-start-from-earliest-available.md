---
title: "Orleans 10.4: Stream-Abonnements können jetzt bei der ältesten gecachten Nachricht beginnen"
description: "Orleans 10.4.0 führt StreamSubscriptionStartPosition.EarliestAvailable ein, damit ein neuer Stream-Abonnent wiedergeben kann, was noch im Queue-Cache des Pulling Agents liegt. Das Release ändert außerdem die Wire-IDs von RPC-Argumenten, die Metriken für die Anfragelatenz und die SQLite-Persistenzskripte."
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
lang: "de"
translationOf: "2026/10/orleans-10-4-stream-subscriptions-can-start-from-earliest-available"
translatedBy: "claude"
translationDate: 2026-10-05
---

Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) wurde am 2026-10-03 veröffentlicht. Die Release Notes decken viel ab (konsistente Mitgliedschaft über alle Clustering-Provider hinweg, Cancellation Tokens in Framework-APIs, NativeAOT-freundlichere Codecs, optionales Hot Reload für Serializer), aber die Änderung, die der meiste Anwendungscode berühren wird, liegt im Streaming: Einem Abonnement ohne Token lässt sich endlich mitteilen, wo es beginnen soll.

## Was ein neuer Abonnent bisher verpasste

Persistente Stream-Abonnenten in Orleans kannten schon immer zwei Modi. Übergibt man einen `StreamSequenceToken`, gibt ein rücklauffähiger Provider ab diesem Punkt wieder. Übergibt man nichts, erhält man Live-Zustellung: alles, was nach dem Abonnement-Handshake eintrifft. Alles, was der Pulling Agent für diesen Stream bereits in seinem Queue-Cache hielt, blieb unsichtbar.

Diese Lücke zeigt sich in einem häufigen Szenario: Ein Grain wird aufgrund des ersten Ereignisses in einem Stream aktiviert, abonniert den Stream und verliert genau dieses Ereignis sowie alles, was während der Aktivierung eintraf. Der Workaround bestand darin, Sequence Tokens selbst zu verfolgen, was nur funktioniert, wenn man überhaupt je ein Token gesehen hat.

## Abonnieren mit EarliestAvailable

[PR #10936](https://github.com/dotnet/orleans/pull/10936) fügt die Enum `StreamSubscriptionStartPosition` mit zwei Werten hinzu, `Latest` (der Standard, wie bisher) und `EarliestAvailable`, dazu `SubscribeAsync`-Überladungen für Item- und Batch-Observer:

```csharp
using Orleans.Streams;

public sealed class OrderProjectionGrain : Grain, IOrderProjectionGrain, IAsyncObserver<OrderEvent>
{
    public override async Task OnActivateAsync(CancellationToken cancellationToken)
    {
        var stream = this.GetStreamProvider("orders")
            .GetStream<OrderEvent>(StreamId.Create("orders", this.GetPrimaryKeyString()));

        await stream.SubscribeAsync(this, StreamSubscriptionStartPosition.EarliestAvailable);
    }

    public Task OnNextAsync(OrderEvent item, StreamSequenceToken? token = null) => Task.CompletedTask;
    public Task OnCompletedAsync() => Task.CompletedTask;
    public Task OnErrorAsync(Exception ex) => Task.CompletedTask;
}
```

`EarliestAvailable` beginnt einschließlich bei der ältesten Nachricht, die der lokale Queue-Cache für diese `StreamId` noch vorhält. Ist nichts mehr vorhanden, wartet das Abonnement auf die nächste Nachricht. Es greift nicht auf Event Hubs, SQS oder Azure Queues zurück: Die Wiedergabe ist auf den Cache beschränkt, und Empfänger-Checkpoints bleiben unberührt.

Die Rangfolge ist eindeutig: Ein konkretes Sequence Token hat Vorrang, dann die übergebene Position, dann der Provider-Standard, dann `Latest`. Der Provider-Standard liegt in `StreamPullingAgentOptions`, was für Legacy-Code relevant ist, der ganz ohne Argumente abonniert:

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

Die integrierten Caches (Pooled, Simple und Event Hubs) unterstützen die Funktion. Ein benutzerdefinierter `IQueueCache` ohne Unterstützung lässt das Abonnement deterministisch fehlschlagen, statt stillschweigend auf Live-Zustellung zurückzufallen. Bei einem Rolling Upgrade sollte die Funktion erst aktiviert werden, wenn jede Silo, die Pulling Agents hostet, 10.4.0 ausführt.

## Drei Hinweise zum Upgrade, die Sie nicht überspringen sollten

Das Release kennzeichnet diese Änderungen als Kompatibilitätsänderungen:

- **RPC-Argument-IDs**: Attribute vom Typ `[Id]` auf Parameterebene steuern jetzt die serialisierten Argument-IDs, und automatische IDs zählen nur serialisierte Parameter. Verwendet ein Grain-Interface `[Id]` an Parametern oder steht `CancellationToken` irgendwo außer an letzter Stelle, weicht das Wire-Format von 10.3.1 ab. Clients und Silos müssen gemeinsam aktualisiert oder der Vertrag versioniert werden.
- **Metriken**: Die Anfragelatenz ist jetzt ein einzelnes `Histogram<double>` mit dem Namen `orleans-app-requests-latency` in gebrochenen Millisekunden und ersetzt die Instrumente `-bucket`, `-count` und `-sum`. `orleans-grains` verwendet die Dimension `grain_type` statt `type`. Dashboards und Alarme müssen angepasst werden.
- **SQLite-Persistenz**: Führen Sie die Skripte `Sqlite-Main.sql` und `Sqlite-Persistence.sql` aus 10.4.0 auf bestehenden Datenbanken erneut aus. Sie sind idempotent und beheben die Atomarität bei konkurrierenden Schreibzugriffen.

Die [Dokumentation zu den Startpositionen von Abonnements](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md) enthält die vollständige Semantik, und die Release Notes listen die Änderungen an Journaling und Durable Jobs auf, die als Vorschau in `10.4.0-alpha.1` ausgeliefert werden.
