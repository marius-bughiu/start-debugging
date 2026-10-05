---
title: "Orleans 10.4: подписки на потоки теперь могут начинаться с самого старого сообщения в кеше"
description: "Orleans 10.4.0 добавляет StreamSubscriptionStartPosition.EarliestAvailable, так что новый подписчик потока может получить повторно всё, что ещё находится в кеше очереди pulling agent. Также в выпуске изменены идентификаторы аргументов RPC в сетевом формате, метрики задержки запросов и скрипты персистентности для SQLite."
pubDate: 2026-10-05
tags:
  - "orleans"
  - "dotnet"
  - "streaming"
  - "distributed-systems"
lang: "ru"
translationOf: "2026/10/orleans-10-4-stream-subscriptions-can-start-from-earliest-available"
translatedBy: "claude"
translationDate: 2026-10-05
---

Orleans [v10.4.0](https://github.com/dotnet/orleans/releases/tag/v10.4.0) вышел 3 октября 2026 года. Примечания к выпуску охватывают много тем (согласованность членства во всех провайдерах кластеризации, токены отмены в API фреймворка, кодеки, лучше подходящие для NativeAOT, включаемый по желанию Hot Reload для сериализатора), но изменение, которое заденет больше всего прикладного кода, относится к потоковой передаче: наконец-то можно указать подписке без токена, откуда начинать.

## Что раньше пропускал новый подписчик

У подписчиков постоянных потоков в Orleans всегда было два режима. Передаёте `StreamSequenceToken`, и провайдер с возможностью перемотки воспроизводит сообщения с этого места. Не передаёте ничего, и получаете доставку вживую: только то, что пришло после рукопожатия подписки. Всё, что pulling agent уже держал в кеше очереди для этого потока, оставалось для вас невидимым.

Этот пробел проявляется в типичной ситуации: грейн активируется в ответ на первое событие потока, подписывается и теряет именно это событие, а также всё, что пришло во время активации. Обходной путь состоял в самостоятельном отслеживании токенов последовательности, что работает, только если вы вообще видели какой-то токен.

## Подписка с EarliestAvailable

[PR #10936](https://github.com/dotnet/orleans/pull/10936) добавляет перечисление `StreamSubscriptionStartPosition` с двумя значениями: `Latest` (по умолчанию, как и раньше) и `EarliestAvailable`, а также перегрузки `SubscribeAsync` для наблюдателей отдельных элементов и пакетов:

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

`EarliestAvailable` начинает включительно с самого старого сообщения, которое локальный кеш очереди ещё хранит для данного `StreamId`. Если ничего не сохранено, подписка ждёт следующего сообщения. Она не обращается к Event Hubs, SQS или Azure Queues: повторное воспроизведение ограничено кешем, а контрольные точки получателей не затрагиваются.

Приоритет определён явно: сначала конкретный токен последовательности, затем переданная вами позиция, затем значение по умолчанию провайдера, затем `Latest`. Значение по умолчанию провайдера задаётся в `StreamPullingAgentOptions`, что важно для унаследованного кода, который подписывается без аргументов:

```csharp
siloBuilder.AddMemoryStreams("orders", streams =>
    streams.ConfigurePullingAgent(ob => ob.Configure(options =>
        options.InitialSubscriptionStartPosition =
            StreamSubscriptionStartPosition.EarliestAvailable)));
```

Встроенные кеши pooled, simple и Event Hubs это поддерживают. Пользовательский `IQueueCache` без поддержки приводит к детерминированному сбою подписки, а не к тихому откату на доставку вживую. При поэтапном обновлении включайте это только после того, как на всех silo, где размещены pulling agent, будет работать 10.4.0.

## Три замечания об обновлении, которые нельзя пропускать

В выпуске отмечены следующие изменения, нарушающие совместимость:

- **Идентификаторы аргументов RPC**: атрибуты `[Id]` на уровне параметров теперь управляют сериализуемыми идентификаторами аргументов, а автоматические идентификаторы учитывают только сериализуемые параметры. Если интерфейс грейна использует `[Id]` на параметрах или ставит `CancellationToken` не последним, сетевой формат отличается от 10.3.1. Обновляйте клиенты и silo одновременно или версионируйте контракт.
- **Метрики**: задержка запросов теперь представлена одной `Histogram<double>` с именем `orleans-app-requests-latency` в дробных миллисекундах и заменяет инструменты `-bucket`, `-count` и `-sum`. В `orleans-grains` вместо `type` используется измерение `grain_type`. Панели мониторинга и оповещения нужно обновить.
- **Персистентность SQLite**: повторно выполните скрипты 10.4.0 `Sqlite-Main.sql` и `Sqlite-Persistence.sql` на существующих базах данных. Они идемпотентны и исправляют атомарность при конкуренции записывающих.

В [документации по начальным позициям подписки](https://github.com/dotnet/orleans/blob/main/docs/site/src/content/docs/streaming/subscription-start-positions.md) описана полная семантика, а в примечаниях к выпуску перечислены изменения журналирования и предварительной версии Durable Jobs, которые поставляются как `10.4.0-alpha.1`.
