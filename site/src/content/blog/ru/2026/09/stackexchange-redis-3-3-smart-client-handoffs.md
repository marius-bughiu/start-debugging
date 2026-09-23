---
title: "StackExchange.Redis 3.3 уходит с узла Redis до того, как сервер разорвёт соединение"
description: "StackExchange.Redis 3.3.0 добавляет включаемые по желанию уведомления об обслуживании (smart client handoffs) для Redis Enterprise, Redis Cloud и Azure Managed Redis: смягчённые таймауты во время миграций, повторное чтение топологии и заблаговременный переход до исчезновения конечной точки. Разбираем, как это включить и с какой ошибкой SER010 вы столкнётесь первой."
pubDate: 2026-09-23
tags:
  - "redis"
  - "stackexchange-redis"
  - "dotnet"
  - "resilience"
lang: "ru"
translationOf: "2026/09/stackexchange-redis-3-3-smart-client-handoffs"
translatedBy: "claude"
translationDate: 2026-09-23
---

[StackExchange.Redis 3.3.0](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.0) вышел 2026-09-18, а 2026-09-22 за ним последовал [3.3.1](https://github.com/StackExchange/StackExchange.Redis/releases/tag/3.3.1). Главная возможность релиза: нативные серверные уведомления об обслуживании, которые в других клиентах Redis называют "smart client handoffs" или "hitless upgrades". Redis Enterprise и Redis Cloud теперь могут предупредить клиент .NET о том, что шард мигрирует, узел переключается на реплику или конечная точка, к которой он подключён, скоро будет заменена, и клиент реагирует на это, а не ждёт, пока сокет умрёт.

Если вы когда-нибудь видели всплеск `RedisTimeoutException` во время окна обслуживания управляемого Redis, это исправление как раз для такого класса проблем.

## Что клиент делает с каждым уведомлением

Уведомления приходят как push-кадры RESP3 по тому же соединению, по которому идут ваши команды. Согласно [проектным заметкам в PR #3191](https://github.com/StackExchange/StackExchange.Redis/pull/3191), клиент реагирует без какого-либо кода с вашей стороны:

- `MIGRATING`, `FAILING_OVER`, `SMIGRATING`: таймауты команд на этом сервере смягчаются (по умолчанию 10 секунд, `maintRelaxedTimeout`).
- `MIGRATED`, `FAILED_OVER`: окно закрывается, но смягчённые таймауты ещё недолго действуют, пока всё стабилизируется.
- `SMIGRATED`: топология кластера перечитывается, а шардированные подписки, чьи слоты переехали, оформляются заново.
- `MOVING`: клиент запрашивает адрес замены, дожидается завершения выполняющихся операций и подменяет соединение до того, как сервер его закроет.

Последнее важнее всего. Автор измерил, что DNS отстаёт от уведомления `MOVING` на 4-19 секунд, тогда как сервер закрывает старый сокет примерно через 16-19 секунд. Если попросить сервер назвать конечную точку замены (`maintMovingEndpointType=Auto`, значение по умолчанию), переход становится прямым и завершается менее чем за секунду.

## Как включить это в 3.3

Пока возможность включается только явно, даже при подключении к распознаваемому имени хоста Redis Cloud или Azure Managed Redis. В [документации](https://seredis.dev/ServerMaintenanceEvent) сказано, что автоматическое включение для этих провайдеров запланировано в одном из следующих релизов. Проще всего воспользоваться строкой подключения:

```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync(
    "my-redis.example.com:6379,maintNotifications=Auto,maintRelaxedTimeout=15");
```

Строго типизированный API помечен как экспериментальный, и в 3.3.1 это ошибка компиляции, а не предупреждение:

```text
error SER010: 'StackExchange.Redis.ConfigurationOptions.MaintenanceNotifications' is for
evaluation purposes only and is subject to change or removal in future updates.
```

Если вам нужны свойство и типы событий, подавите её явно:

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

У `MaintenanceNotificationMode` три значения. `Disabled` сейчас используется по умолчанию. `Auto` запрашивает уведомления во время рукопожатия и продолжает работу, если сервер отказывает. `Enabled` отклоняет соединение, если уведомления не могут быть доставлены, в том числе когда соединение работает по RESP2, поэтому этот режим удобен, чтобы убедиться, что возможность действительно работает на staging.

## Две вещи, которые стоит проверить перед выкаткой

Требуется RESP3. `protocol=resp2`, `defaultVersion` ниже 6.0 или отключённая `HELLO` в карте команд молча выключают возможность в режиме `Auto`.

Намеренный переход также проявляется как событие `ConnectionFailed` с `FailureType == ConnectionFailureType.MaintenanceHandoff`. Если у вас настроены оповещения на `ConnectionFailed`, отфильтруйте это значение, иначе пейджер будет срабатывать при каждом плановом обслуживании.

Одно изменение включено без вашего участия: 3.3.0 добавляет `topologyRefreshSeconds`, который по умолчанию перечитывает топологию каждые 30 минут (со случайным разбросом, `0` отключает). Оно нужно для конечных точек, которые ещё отвечают на рукопожатие, но уже не принадлежат развёртыванию.

Если Redis у вас уже стоит за `HybridCache`, посмотрите, [как использовать HybridCache в ASP.NET Core 11 с Redis в качестве L2-кеша](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/). Добавление `maintNotifications=Auto` в эту строку подключения станет самым дешёвым повышением отказоустойчивости, которое вы сделаете в этом месяце.
