---
title: "StackExchange.Redis 3.3 wechselt den Redis-Knoten, bevor der Server Sie trennt"
description: "StackExchange.Redis 3.3.0 bringt optionale Wartungsbenachrichtigungen (Smart Client Handoffs) für Redis Enterprise, Redis Cloud und Azure Managed Redis: gelockerte Timeouts während Migrationen, erneutes Einlesen der Topologie und ein proaktiver Wechsel, bevor ein Endpunkt verschwindet. So aktivieren Sie die Funktion, und das ist der SER010-Fehler, auf den Sie zuerst stoßen."
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
lang: "de"
translationOf: "2026/09/stackexchange-redis-3-3-smart-client-handoffs"
translatedBy: "claude"
translationDate: 2026-09-23
---

[StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) ist am 18. September 2026 erschienen, gefolgt von [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1) am 22. September. Die wichtigste Neuerung sind serverseitige Wartungsbenachrichtigungen, die andere Redis-Clients "Smart Client Handoffs" oder "Hitless Upgrades" nennen. Redis Enterprise und Redis Cloud können den .NET-Client jetzt warnen, dass ein Shard migriert, ein Knoten ein Failover durchläuft oder der verbundene Endpunkt gleich ersetzt wird. Der Client reagiert darauf, statt zu warten, bis ein Socket stirbt.

Wenn Sie während eines Wartungsfensters eines verwalteten Redis-Dienstes schon einmal eine Häufung von `RedisTimeoutException` gesehen haben, ist das die Lösung für genau diese Klasse von Problemen.

## Was der Client mit jeder Benachrichtigung macht

Die Benachrichtigungen kommen als RESP3-Push-Frames über dieselbe Verbindung, die auch Ihre Befehle transportiert. Laut den [Designnotizen in PR #3191](https://github.com/StackExchange/StackExchange.Redis/pull/3191) reagiert der Client ohne eigenen Code:

- `MIGRATING`, `FAILING_OVER`, `SMIGRATING`: Die Befehls-Timeouts für diesen Server werden gelockert (standardmäßig 10 Sekunden, `maintRelaxedTimeout`).
- `MIGRATED`, `FAILED_OVER`: Das Fenster schließt sich, mit einer kurzen gelockerten Nachlaufzeit, bis sich alles beruhigt hat.
- `SMIGRATED`: Die Cluster-Topologie wird neu eingelesen, und Sharded Subscriptions, deren Slots verschoben wurden, werden neu abonniert.
- `MOVING`: Der Client fragt nach der Ersatzadresse, lässt laufende Arbeit abarbeiten und tauscht die Verbindung aus, bevor der Server sie schließt.

Der letzte Punkt ist der wichtigste. Der Autor hat gemessen, dass DNS einer `MOVING`-Benachrichtigung um 4 bis 19 Sekunden hinterherhinkt, während der Server den alten Socket nach etwa 16 bis 19 Sekunden schließt. Weil der Client den Server nach dem Ersatzendpunkt fragt (`maintMovingEndpointType=Auto`, der Standard), wird der Handoff zu einem direkten Wechsel, der in unter einer Sekunde abgeschlossen ist.

## Aktivierung in 3.3

Die Funktion ist vorerst optional, selbst wenn Sie sich mit einem erkannten Hostnamen von Redis Cloud oder Azure Managed Redis verbinden. Laut [Dokumentation](https://seredis.dev/ServerMaintenanceEvent) ist die automatische Aktivierung für diese Anbieter für ein späteres Release geplant. Der Weg über den Connection String ist der einfachste:

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

Die stark typisierte API ist als experimentell markiert, und in 3.3.1 ist das ein Compilerfehler, keine Warnung:

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

Unterdrücken Sie ihn explizit, wenn Sie die Eigenschaft und die Ereignistypen nutzen wollen:

```csharp
#pragma warning disable SER010
using StackExchange.Redis;
using StackExchange.Redis.Maintenance;

var options = ConfigurationOptions.Parse("my-redis.example.com:6379");
options.MaintenanceNotifications = MaintenanceNotificationMode.Auto;

var muxer = await ConnectionMultiplexer.ConnectAsync(options);
muxer.ServerMaintenanceEvent += (_, e) =>
{
    if (e is PushMaintenanceEvent m)
        Console.WriteLine($"{m.NotificationType} seq {m.SequenceId} from {m.EndPoint}");
};
```

`MaintenanceNotificationMode` hat drei Werte. `Disabled` ist der aktuelle Standard. `Auto` fragt beim Handshake an und macht weiter, falls der Server ablehnt. `Enabled` lehnt die Verbindung ab, wenn keine Benachrichtigungen zugestellt werden können, auch dann, wenn die Verbindung bei RESP2 landet. Damit lässt sich in Staging gut nachweisen, dass die Funktion tatsächlich aktiv ist.

## Zwei Dinge, die Sie vor dem Rollout prüfen sollten

RESP3 ist Pflicht. `protocol=resp2`, eine `defaultVersion` unter 6.0 oder ein deaktiviertes `HELLO` in der Command Map schalten die Funktion unter `Auto` stillschweigend ab.

Ein geplanter Handoff taucht außerdem als `ConnectionFailed`-Ereignis mit `FailureType == ConnectionFailureType.MaintenanceHandoff` auf. Wenn Sie auf `ConnectionFailed` alarmieren, filtern Sie diesen Wert heraus, sonst schlägt Ihr Pager bei jeder geplanten Wartung an.

Eine Änderung ist nicht optional: 3.3.0 führt `topologyRefreshSeconds` ein, das die Topologie standardmäßig alle 30 Minuten neu einliest (mit Jitter, `0` deaktiviert es). Das ist für Endpunkte gedacht, die zwar noch auf einen Handshake antworten, aber nicht mehr zum Deployment gehören.

Wenn Redis bereits hinter Ihrem `HybridCache` steht, lesen Sie [wie Sie HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/). `maintNotifications=Auto` in diesen Connection String aufzunehmen, ist das günstigste Resilienz-Upgrade, das Sie diesen Monat machen werden.
